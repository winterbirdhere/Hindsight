import { isAbsolute } from "path";
import { setImmediate } from "timers/promises";
import { parseReplayHeader,readScoreInfoWithDecompressor } from "@rewind/osu-local/osr-reader";
import type { ReplayBlockDecoder } from "@rewind/osu-local/osr-reader";
import type { LibraryOpenLocation } from "./library-store";
import type { LibraryOriginLookup } from "./library-selected-resources";
import type { LibraryPerformanceScoreEvidence } from "./library-performance-score";
import { performanceMapMd5 } from "./library-performance-map-resource";
import { readVerifiedLibraryResource } from "./library-resource-reader";
import { isLosslessLibraryJson } from "../../../../shared/library-json";
import { LibraryNativeDrainError } from "./library-native-admission";
import { projectPerformanceObservation } from "./library-performance-observation";

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);

/** P consumes source/header scalar evidence. Only native trailers require replay-file reads;
 * even then the compressed frame block is skipped, and no optional saved causes are read. */
export async function prepareLibraryPerformanceScore(location:LibraryOpenLocation,decode:ReplayBlockDecoder,signal?:AbortSignal,
  readOrigin?:LibraryOriginLookup,checkpoint:()=>Promise<void>=()=>setImmediate()):Promise<LibraryPerformanceScoreEvidence> {
  signal?.throwIfAborted();await checkpoint();signal?.throwIfAborted();
  const md5=performanceMapMd5(location),rawNative=location.metadata.nativeScore,result=projectPerformanceObservation(location);
  const header=result.header,native=result.native&&record(rawNative)?rawNative:undefined;
  if(!header&&!native)throw new Error("Source score identity unavailable");
  result.nativeRequired||=location.analysisRequiresNative===true;
  if(location.sha256&&(!header||Number(header.version)>=30000001)){
    try {
    const replay=native&&record(native.replay)?native.replay:undefined;
    const path=typeof replay?.path==="string"?replay.path:location.locator;
    if(!isAbsolute(path))throw new Error("Native trailer resource path unavailable");
    const bytes=await readVerifiedLibraryResource(path,{sha256:location.sha256,maxBytes:128*1024*1024},signal,checkpoint);
    const actual=parseReplayHeader(bytes.bytes);if(actual.beatmapMD5!==md5)throw new Error("Native trailer map identity changed");
    await checkpoint();signal?.throwIfAborted();
    const trailer=await readScoreInfoWithDecompressor(bytes.bytes,decode,{signal,maxScoreInfoBytes:1024*1024});
    result.trailerStatus=trailer?"read":"absent";
    if(trailer){
      const scalar=Object.fromEntries(["mods","statistics","maximum_statistics","max_combo","ruleset_id"]
        .filter(key=>Object.prototype.hasOwnProperty.call(trailer,key)).map(key=>[key,trailer[key]]));
      if(!isLosslessLibraryJson(scalar)||Buffer.byteLength(JSON.stringify(scalar))>64*1024)throw new Error("Native score scalar metadata exceeds budget");
      result.trailer=scalar as NonNullable<LibraryPerformanceScoreEvidence["trailer"]>;
    }
    }catch(error){
      signal?.throwIfAborted();if(error instanceof LibraryNativeDrainError)throw error;
      // Keep database observations and distinguish an unreadable file from malformed bound bytes.
      result.trailerStatus=["ENOENT","EACCES","EPERM","EBUSY"].includes(String((error as NodeJS.ErrnoException)?.code))?"unavailable":"invalid";
      delete result.trailer;
    }
  }
  if(location.sha256){const origin=await readOrigin?.(location.sha256,signal,checkpoint);if(origin)result.origin=origin.client;}
  await checkpoint();signal?.throwIfAborted();return result;
}
