import type { LibraryPerformanceObservation } from "./library-performance-dependencies";
import type { LibraryPerformanceScoreEvidence } from "./library-performance-score";
import { sourceMapEvidence } from "./library-source-binding";
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const hash=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const pick=(value:Record<string,unknown>,keys:string[])=>Object.fromEntries(keys.map(key=>[key,value[key]??null]));

/** Pure scalar projection shared by canonical composition and the isolated trailer reader. */
export function projectPerformanceObservation(location:LibraryPerformanceObservation):LibraryPerformanceScoreEvidence {
  const binding=sourceMapEvidence(location),md5=binding.headerMd5??binding.sourceMd5;
  const result:LibraryPerformanceScoreEvidence={origin:null,nativeRequired:false,trailerStatus:"not-needed"};
  if(!md5||binding.headerMd5&&binding.sourceMd5&&binding.headerMd5!==binding.sourceMd5)return result;
  const saved=location.metadata.savedScore,rawNative=location.metadata.nativeScore;
  const header=location.sha256&&record(location.metadata.header)&&location.metadata.header.beatmapMD5===md5?location.metadata.header
    :location.kind==="stable"&&record(saved)&&saved.sourceKey===location.sourceKey&&hash(location.sourceKey)&&Number.isInteger(saved.databaseVersion)&&
      record(saved.header)&&saved.header.beatmapMD5===md5?saved.header:undefined;
  const native=location.kind==="lazer"&&record(rawNative)&&rawNative.id===location.sourceKey&&hash(location.metadata.schemaFingerprint)&&
    record(rawNative.replay)&&(!location.sha256||rawNative.replay.sha256===location.sha256)&&record(rawNative.beatmap)&&rawNative.beatmap.md5===md5
    ?rawNative:undefined;
  result.nativeRequired=native?.isLegacyScore===false||Number(header?.version)>=30000000;
  if(header)result.header={...pick(header,["mode","version","modsBitmask","maxCombo","score"]),
    counts:record(header.counts)?pick(header.counts,["great","ok","meh","miss"]):null} as unknown as NonNullable<LibraryPerformanceScoreEvidence["header"]>;
  if(native)result.native=pick(native,["ruleset","isLegacyScore","mods","maxCombo","statistics","maximumStatistics"]) as unknown as NonNullable<LibraryPerformanceScoreEvidence["native"]>;
  return result;
}
