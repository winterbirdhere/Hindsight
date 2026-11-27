import { lstat, realpath, mkdir, open, unlink, rmdir } from "fs/promises";
import { isAbsolute, resolve, parse, join, sep, relative } from "path";
import { randomUUID, createHash } from "crypto";
import { setImmediate } from "timers/promises";
import { prepareLibraryScoreDeletionAsync } from "@rewind/osu-local/db-reader";
import { parseLibraryScoreEvents } from "@rewind/osu-local/db-reader/library-scores";
import type { LibrarySavedScore } from "@rewind/osu-local/db-reader/library-scores";
import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";
import type { ReplayFileStamp } from "./sources/replay-file";
import { matchesSavedScore } from "./sources/stable-scores-source";
import { readSourceDatabase, assertSourceUnchanged, sameSourceStamp, sourceStamp } from "./sources/source-file";
import { LibraryStableStageRegistry,LIBRARY_STABLE_STAGE_MAX_FILE_BYTES } from "./library-stable-deletion-stage";
import type { LibraryStableStageReference,LibraryStableStageOwnerProcess } from "./library-stable-deletion-stage";

interface Source { sourceId: string; sourceDirectory: string }
export interface LibraryStableDeletionInspectionRequest extends Source { knownSourceKeys: string[]; replayHeader?: LibrarySavedScore["header"];replayHeaders?:LibrarySavedScore["header"][] }
export interface LibraryStableDeletionPreparationRequest extends Source { expected: { sha256: string; stamp: ReplayFileStamp }; selections: { sourceKey: string; occurrences: number }[] }
type Candidate = { sourceKey: string; occurrences: number; score: LibrarySavedScore; cacheRelativePath: string };
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const pathText=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=32768&&!value.includes("\0")&&isAbsolute(value);
const keys=(value:Record<string,unknown>,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
const integer=(value:unknown,min:number,max:number)=>Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=max;
const canonical=(value:string)=>process.platform==="win32"?resolve(value).toLowerCase():resolve(value);
const contains=(parent:string,child:string)=>{const remainder=relative(canonical(parent),canonical(child));return remainder===""||!isAbsolute(remainder)&&remainder!==".."&&!remainder.startsWith(".."+sep);};
const identity=(value:{dev:bigint;ino:bigint})=>({device:value.dev.toString(),inode:value.ino.toString()});
const sameIdentity=(a:{device:string;inode:string},b:{dev:bigint;ino:bigint})=>a.device===b.dev.toString()&&a.inode===b.ino.toString();
const cachePath=(score:LibrarySavedScore)=>`Data/r/${score.header.beatmapMD5}-${BigInt(score.header.playedAtTicks)-BigInt("504911232000000000")}.osr`;
const localStageOwnerId=randomUUID();
function bounded<T>(value:T):T {if(Buffer.byteLength(JSON.stringify(value))>1024*1024)throw Error("Stable deletion response exceeds limit; inspection is incomplete");return value;}
function source(value:unknown):asserts value is Source {
  if(!record(value)||typeof value.sourceId!=="string"||!value.sourceId||value.sourceId.length>128||!pathText(value.sourceDirectory))throw Error("Invalid trusted Stable source");
}
function validHeader(value:unknown):value is LibrarySavedScore["header"] {
  if(!record(value)||!keys(value,["mode","version","beatmapMD5","player","replayMD5","counts","score","maxCombo","perfectComboFlag","modsBitmask","playedAtTicks"])||
    !integer(value.mode,0,3)||!integer(value.version,0,2147483647)||typeof value.beatmapMD5!=="string"||!/^[a-f0-9]{32}$/.test(value.beatmapMD5)||
    typeof value.player!=="string"||Buffer.byteLength(value.player)>128*1024||typeof value.replayMD5!=="string"||Buffer.byteLength(value.replayMD5)>128*1024||
    !integer(value.score,-2147483648,2147483647)||!integer(value.maxCombo,0,65535)||typeof value.perfectComboFlag!=="boolean"||!integer(value.modsBitmask,-2147483648,2147483647)||
    typeof value.playedAtTicks!=="string"||!/^\d{1,19}$/.test(value.playedAtTicks)||BigInt(value.playedAtTicks)>BigInt("3155378975999999999")||!record(value.counts))return false;
  return keys(value.counts,["great","ok","meh","geki","katu","miss"])&&["great","ok","meh","geki","katu","miss"].every(key=>integer((value.counts as Record<string,unknown>)[key],0,65535));
}
function validStamp(value:unknown):value is ReplayFileStamp {
  return record(value)&&keys(value,["bytes","device","inode","modifiedNs","changedNs"])&&integer(value.bytes,0,LIBRARY_STABLE_STAGE_MAX_FILE_BYTES)&&
    ["device","inode","modifiedNs","changedNs"].every(key=>typeof value[key]==="string"&&/^-?\d{1,30}$/.test(value[key] as string));
}
/** Node path observations reject links/junctions. This is not the later Windows commit lease. */
async function realAncestry(path:string,directory:boolean,signal?:AbortSignal){
  const absolute=resolve(path),root=parse(absolute).root,parts=absolute.slice(root.length).split(sep).filter(Boolean);
  let current=root;signal?.throwIfAborted();
  for(let index=0;index<parts.length;index++){
    current=join(current,parts[index]);const info=await lstat(current,{bigint:true});signal?.throwIfAborted();
    if(info.isSymbolicLink()||(!(index===parts.length-1&&!directory)&&!info.isDirectory()))throw Error("Stable deletion paths must have real unlinked ancestry");
  }
  const actual=await realpath(absolute);if(canonical(actual)!==canonical(absolute))throw Error("Stable deletion path resolves through a link");
  const info=await lstat(absolute,{bigint:true});
  if(directory?!info.isDirectory():!info.isFile()||info.nlink!==BigInt(1))throw Error("Stable deletion requires a real unlinked regular source");
  signal?.throwIfAborted();return info;
}
async function readSource(request:Source,signal:AbortSignal|undefined,checkpoint:()=>Promise<void>){
  const root=await realAncestry(request.sourceDirectory,true,signal),rootIdentity=identity(root),path=join(request.sourceDirectory,"scores.db");
  const initial=await realAncestry(path,false,signal);if(initial.size>BigInt(LIBRARY_STABLE_STAGE_MAX_FILE_BYTES))throw Error("Stable source exceeds64MiB mutation limit");
  const database=await readSourceDatabase(path,signal,checkpoint);
  if(!sameSourceStamp(database.stamp,sourceStamp(initial)))throw Error("Stable source changed before reading");
  const verify=async()=>{
    signal?.throwIfAborted();await assertSourceUnchanged(path,database.stamp);
    if(!sameIdentity(rootIdentity,await realAncestry(request.sourceDirectory,true,signal)))throw Error("Stable source root changed");
    if(!sameSourceStamp(database.stamp,sourceStamp(await realAncestry(path,false,signal))))throw Error("Stable source changed during preparation");
  };
  return{...database,verify,rootIdentity};
}
export async function inspectLibraryStableDeletion(request:LibraryStableDeletionInspectionRequest,signal?:AbortSignal,checkpoint:()=>Promise<void>=()=>setImmediate()){
  source(request);
  if(!keys(request as unknown as Record<string,unknown>,["sourceId","sourceDirectory","knownSourceKeys","replayHeader","replayHeaders"])||!Array.isArray(request.knownSourceKeys)||request.knownSourceKeys.length>128||
    request.knownSourceKeys.some(key=>!hash(key))||new Set(request.knownSourceKeys).size!==request.knownSourceKeys.length||
    request.replayHeader!==undefined&&!validHeader(request.replayHeader)||request.replayHeaders!==undefined&&
      (!Array.isArray(request.replayHeaders)||!request.replayHeaders.length||request.replayHeaders.length>128||request.replayHeaders.some(header=>!validHeader(header))||request.replayHeader!==undefined)||
    !request.knownSourceKeys.length&&!request.replayHeader&&!request.replayHeaders)throw Error("Invalid Stable deletion inspection");
  const headers=request.replayHeaders??(request.replayHeader?[request.replayHeader]:[]);
  const database=await readSource(request,signal,checkpoint),known=new Set(request.knownSourceKeys),candidates=new Map<string,Candidate>();
  let count=0,position=0,lastPosition=0;
  for(const score of parseLibraryScoreEvents(database.bytes,{onScore:(_score,span)=>{position=span.end;}})){
    if(score===null||++count%64===0||position-lastPosition>=1024*1024){lastPosition=position;await checkpoint();signal?.throwIfAborted();}
    if(!score||!known.has(score.sourceKey)&&!headers.some(header=>matchesSavedScore(score.header,header as ReplayHeader)))continue;
    const existing=candidates.get(score.sourceKey);
    if(existing)existing.occurrences++;
    else{if(candidates.size>=128)throw Error("Stable association candidates exceed limit; inspection is incomplete");candidates.set(score.sourceKey,{sourceKey:score.sourceKey,occurrences:1,score,cacheRelativePath:cachePath(score)});}
  }
  for(const key of known)if(!candidates.has(key))throw Error("Known saved score key is missing; source check is required");
  await database.verify();signal?.throwIfAborted();
  return bounded({sourceId:request.sourceId,sourceDirectory:request.sourceDirectory,databaseSha256:database.sha256,stamp:database.stamp,rootIdentity:database.rootIdentity,complete:true as const,candidates:[...candidates.values()]});
}

export class LibraryStableDeletionCleanupError extends Error {}
/** Existing resource worker only. The trusted initialization supplies appDirectory, never renderer input. */
export async function prepareLibraryStableDeletion(appDirectory:string,request:LibraryStableDeletionPreparationRequest,signal?:AbortSignal,checkpoint:()=>Promise<void>=()=>setImmediate(),lifecycle?:{ownerId:string;retiredOwnerIds?:string[];ownerProcess?:LibraryStableStageOwnerProcess;registry?:LibraryStableStageRegistry}){
  source(request);
  if(!pathText(appDirectory)||!keys(request as unknown as Record<string,unknown>,["sourceId","sourceDirectory","expected","selections"])||!record(request.expected)||!keys(request.expected,["sha256","stamp"])||!hash(request.expected.sha256)||!validStamp(request.expected.stamp)||
    !Array.isArray(request.selections)||!request.selections.length||request.selections.length>128||request.selections.some(item=>!record(item)||!keys(item,["sourceKey","occurrences"])||!hash(item.sourceKey)||!integer(item.occurrences,1,1000000))||new Set(request.selections.map(item=>item.sourceKey)).size!==request.selections.length)throw Error("Invalid Stable deletion preparation");
  const stageRoot=join(appDirectory,"library-deletion-stage");
  if(contains(request.sourceDirectory,stageRoot)||contains(appDirectory,request.sourceDirectory))throw Error("Stable staging and source paths must not overlap");
  const appIdentity=identity(await realAncestry(appDirectory,true,signal));
  const verifyApp=async(checkSignal?:AbortSignal)=>{if(!sameIdentity(appIdentity,await realAncestry(appDirectory,true,checkSignal)))throw Error("Stable staging app root changed");};
  const database=await readSource(request,signal,checkpoint);
  if(database.sha256!==request.expected.sha256||!sameSourceStamp(request.expected.stamp,database.stamp))throw Error("Stable source fingerprint changed");
  const prepared=await prepareLibraryScoreDeletionAsync(database.bytes,{databaseSha256:request.expected.sha256,selections:request.selections},{signal,checkpoint,maxRetainedReferences:4096});
  await database.verify();await checkpoint();signal?.throwIfAborted();
  const {bytes,...summary}=prepared;
  const ownerId=lifecycle?.ownerId??localStageOwnerId,registry=lifecycle?.registry??new LibraryStableStageRegistry(appDirectory,ownerId,lifecycle?.retiredOwnerIds,lifecycle?.ownerProcess);
  registry.assertAuthority(appDirectory,ownerId);
  await verifyApp(signal);await registry.admit(bytes.length);
  const stageName=randomUUID(),relativePath=`library-deletion-stage/${stageName}/scores.db`,stageDirectory=join(stageRoot,stageName),stagePath=join(stageDirectory,"scores.db");
  const result=bounded({sourceId:request.sourceId,sourceDirectory:request.sourceDirectory,databaseSha256:database.sha256,stamp:database.stamp,rootIdentity:database.rootIdentity,
    ...summary,staged:{relativePath,bytes:bytes.length,sha256:prepared.afterSha256}});
  let createdDirectory=false,createdFile=false,stageRootIdentity:{device:string;inode:string}|undefined,directoryIdentity:{device:string;inode:string}|undefined,fileIdentity:{device:string;inode:string}|undefined,custody:LibraryStableStageReference|undefined,writtenBytes=0;
  const verifyParent=async(checkSignal?:AbortSignal)=>{await verifyApp(checkSignal);const parent=await realAncestry(stageRoot,true,checkSignal);if(!stageRootIdentity||!sameIdentity(stageRootIdentity,parent))throw Error("Stable staging parent changed");};
  const verifyDirectory=async(checkSignal?:AbortSignal)=>{await verifyParent(checkSignal);const current=await realAncestry(stageDirectory,true,checkSignal);if(!directoryIdentity||!sameIdentity(directoryIdentity,current))throw Error("Owned stage directory changed");};
  try{
    // Re-observe after cooperative work, before the first staging mutation.
    await verifyApp(signal);
    try{await mkdir(stageRoot);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    stageRootIdentity=identity(await realAncestry(stageRoot,true,signal));await verifyParent(signal);
    await mkdir(stageDirectory);createdDirectory=true;
    directoryIdentity=identity(await lstat(stageDirectory,{bigint:true}));await verifyDirectory(signal);
    custody=await registry.register(stageName,{source:{sourceId:request.sourceId,sourceDirectory:request.sourceDirectory,databaseSha256:database.sha256,stamp:database.stamp,selectionFingerprint:createHash("sha256").update(JSON.stringify(request.selections)).digest("hex")},bytes:bytes.length,sha256:prepared.afterSha256});
    signal?.throwIfAborted();await verifyDirectory(signal);
    const file=await open(stagePath,"wx+",0o600);createdFile=true;
    try{
      fileIdentity=identity(await file.stat({bigint:true}));custody=await registry.fileCreated(stageName,fileIdentity);let offset=0;
      while(offset<bytes.length){signal?.throwIfAborted();await verifyDirectory(signal);const size=Math.min(1024*1024,bytes.length-offset),written=await file.write(bytes,offset,size,offset);if(!written.bytesWritten)throw Error("Staged Stable write made no progress");offset+=written.bytesWritten;writtenBytes=offset;await checkpoint();}
      await file.sync();signal?.throwIfAborted();
      const sha=createHash("sha256"),chunk=Buffer.alloc(Math.min(1024*1024,bytes.length));offset=0;
      while(offset<bytes.length){const read=await file.read(chunk,0,Math.min(chunk.length,bytes.length-offset),offset);if(!read.bytesRead)throw Error("Staged Stable output is truncated");sha.update(chunk.subarray(0,read.bytesRead));offset+=read.bytesRead;await checkpoint();signal?.throwIfAborted();}
      if(sha.digest("hex")!==prepared.afterSha256)throw Error("Staged Stable output digest changed");
      const actual=await realAncestry(stagePath,false,signal);if(!sameIdentity(fileIdentity,actual)||Number(actual.size)!==bytes.length)throw Error("Staged Stable output identity changed");
      await database.verify();signal?.throwIfAborted();
    }finally{await file.close();}
    signal?.throwIfAborted();await verifyDirectory(signal);await database.verify();signal?.throwIfAborted();
    custody=await registry.prepared(stageName,signal);await verifyDirectory(signal);signal?.throwIfAborted();
    return bounded({...result,stageId:stageName,stageFingerprint:custody.fingerprint});
  }catch(error){
    try{
      if(createdDirectory){
        await verifyDirectory();
        if(custody)await registry.discardOwned(stageName,{bytes:writtenBytes,sha256:createHash("sha256").update(bytes.subarray(0,writtenBytes)).digest("hex")});
        else{if(createdFile){const current=await realAncestry(stagePath,false);if(!fileIdentity||!sameIdentity(fileIdentity,current))throw Error("Owned stage output changed");await unlink(stagePath);}await rmdir(stageDirectory);}
      }
    }catch{throw new LibraryStableDeletionCleanupError("Stable stage cleanup could not be verified; preserve owned staging evidence");}
    throw error;
  }
}
export type LibraryStableDeletionInspection = Awaited<ReturnType<typeof inspectLibraryStableDeletion>>;
export type LibraryStableDeletionPreparation = Awaited<ReturnType<typeof prepareLibraryStableDeletion>>;
