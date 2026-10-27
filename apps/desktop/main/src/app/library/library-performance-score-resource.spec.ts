import { mkdtemp,writeFile,rm,readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { OsrReplay,parseReplayHeader,ReplayBlockDecoder } from "@rewind/osu-local/osr-reader";
import { prepareLibraryPerformanceScore } from "./library-performance-score-resource";
import type { LibraryOpenLocation } from "./library-store";
import { LibraryNativeDrainError } from "./library-native-admission";
let root:string,location:LibraryOpenLocation,bytes:Buffer;
const md5="a".repeat(32),sha=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
const decode:ReplayBlockDecoder=jest.fn(async()=>{throw new Error("Unexpected replay decompression");});
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),"hindsight-p-score-"));
  const replay=new OsrReplay();Object.assign(replay,{gameVersion:20250101,gameMode:0,beatmapMD5:md5,mods:0,number_300s:3,max_combo:3,score:500,
    replay_data:"0|256|192|0,1000|256|192|1,",timestamp:new Date(1700000000000)});
  bytes=replay.serializeSync();location={replayId:"r",sourceId:"s",sourceKey:"a".repeat(64),kind:"stable",directory:root,locator:join(root,"absent.osr"),
    sha256:null,locationRevision:1,sourceConfigRevision:0,metadata:{savedScore:{sourceKey:"a".repeat(64),databaseVersion:20250101,header:parseReplayHeader(bytes)}}};
  jest.clearAllMocks();
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it("uses source-bound Stable and native scores without reading missing replays or decoding frames",async()=>{
  expect(await prepareLibraryPerformanceScore(location,decode)).toMatchObject({header:{score:500},nativeRequired:false,origin:null});
  location.kind="lazer";location.sourceKey="native";location.metadata={schemaFingerprint:"b".repeat(64),nativeScore:{id:"native",ruleset:0,
    isLegacyScore:false,mods:[],maxCombo:3,statistics:{Great:3,Ok:0,Meh:0,Miss:0},maximumStatistics:{Great:3},replay:{status:"missing"},beatmap:{md5}}};
  expect(await prepareLibraryPerformanceScore(location,decode)).toMatchObject({native:{mods:[],maxCombo:3},nativeRequired:true});expect(decode).not.toHaveBeenCalled();
});
it("decodes only an exact native trailer, preserving original bytes and authoritative empty mods",async()=>{
  bytes.writeInt32LE(30000001,1);const length=Buffer.alloc(4);length.writeInt32LE(1);bytes=Buffer.concat([bytes,length,Buffer.from([42])]);
  const header=parseReplayHeader(bytes);bytes.fill(255,header.compressedFrames.offset,header.compressedFrames.offset+(header.compressedFrames.length??0));
  await writeFile(location.locator,bytes);location={...location,kind:"imported",sha256:sha(bytes),metadata:{header:parseReplayHeader(bytes)}};
  const metadata={mods:[],statistics:{great:3,ok:0,meh:0,miss:0},max_combo:3,unneeded:{never:"persist"}};
  const roles:string[]=[],decoder:ReplayBlockDecoder=async(_bytes,request)=>{roles.push(request.role);return Buffer.from(JSON.stringify(metadata));};
  const result=await prepareLibraryPerformanceScore(location,decoder,undefined,async()=>({client:"lazer",provenance:"user-confirmed"}));
  expect(result).toMatchObject({nativeRequired:true,origin:"lazer",trailer:{mods:[],statistics:metadata.statistics,max_combo:3}});
  expect(result.trailer).not.toHaveProperty("unneeded");expect(roles).toEqual(["score-info"]);expect(await readFile(location.locator)).toEqual(bytes);
  expect(await prepareLibraryPerformanceScore({...location,sha256:"f".repeat(64)},decoder)).toMatchObject({trailerStatus:"invalid"});
  await expect(prepareLibraryPerformanceScore(location,async()=>{throw new LibraryNativeDrainError("unconfirmed helper");})).rejects.toThrow(/unconfirmed/);
});
it("rejects unbound score metadata and never downgrades a required native recording",async()=>{
  location.metadata.savedScore={sourceKey:"wrong",header:parseReplayHeader(bytes),databaseVersion:20250101};
  await expect(prepareLibraryPerformanceScore(location,decode)).rejects.toThrow(/source.*identity/i);
  location={...location,kind:"imported",sha256:sha(bytes),analysisRequiresNative:true,metadata:{header:parseReplayHeader(bytes)}};
  expect(await prepareLibraryPerformanceScore(location,decode)).toMatchObject({nativeRequired:true,header:{score:500}});
});
it("propagates cancellation during optional origin reading without publishing evidence",async()=>{
  location={...location,kind:"replays",sha256:sha(bytes),metadata:{header:parseReplayHeader(bytes)}};const controller=new AbortController();
  await expect(prepareLibraryPerformanceScore(location,decode,controller.signal,async()=>{controller.abort();return undefined;})).rejects.toThrow(/abort/i);
});
it("retains bound native DB scalars with explicit unavailable trailer state after replay removal",async()=>{
  bytes.writeInt32LE(30000001,1);location={...location,kind:"lazer",sourceKey:"native-id",sha256:sha(bytes),metadata:{header:parseReplayHeader(bytes),
    schemaFingerprint:"b".repeat(64),nativeScore:{id:"native-id",ruleset:0,isLegacyScore:false,mods:[],maxCombo:3,statistics:{Great:3,Ok:0,Meh:0,Miss:0},
      replay:{sha256:sha(bytes),status:"missing",path:location.locator},beatmap:{md5}}}};
  expect(await prepareLibraryPerformanceScore(location,decode)).toMatchObject({native:{mods:[],maxCombo:3},nativeRequired:true,trailerStatus:"unavailable"});
  expect(decode).not.toHaveBeenCalled();
});
