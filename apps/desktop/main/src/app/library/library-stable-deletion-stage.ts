import { lstat,realpath,open,opendir,unlink,rmdir } from "fs/promises";
import { join,resolve,parse,sep,isAbsolute } from "path";
import { createHash } from "crypto";
import { setImmediate } from "timers/promises";
import type { ReplayFileStamp } from "./sources/replay-file";

export const LIBRARY_STABLE_STAGE_MAX_FILE_BYTES=64*1024*1024;
export const LIBRARY_STABLE_STAGE_MAX_TOTAL_BYTES=128*1024*1024;
export const LIBRARY_STABLE_STAGE_MAX_COUNT=16;
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const digest=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex");
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
interface Identity {device:string;inode:string}
const identity=(value:{dev:bigint;ino:bigint}):Identity=>({device:value.dev.toString(),inode:value.ino.toString()});
const same=(a:Identity,b:Identity)=>a.device===b.device&&a.inode===b.inode;
const validIdentity=(value:unknown):value is Identity=>object(value)&&typeof value.device==="string"&&/^\d{1,30}$/.test(value.device)&&typeof value.inode==="string"&&/^\d{1,30}$/.test(value.inode);
const canonical=(path:string)=>process.platform==="win32"?resolve(path).toLowerCase():resolve(path);
async function real(path:string,directory:boolean){
  const absolute=resolve(path),root=parse(absolute).root;let current=root;
  const parts=absolute.slice(root.length).split(sep).filter(Boolean);
  for(let index=0;index<parts.length;index++){current=join(current,parts[index]);const info=await lstat(current,{bigint:true});if(info.isSymbolicLink()||(!(index===parts.length-1&&!directory)&&!info.isDirectory()))throw Error("Stage ancestry is linked or changed");}
  if(canonical(await realpath(absolute))!==canonical(absolute))throw Error("Stage ancestry resolves through a link");
  const info=await lstat(absolute,{bigint:true});if(directory?!info.isDirectory():!info.isFile()||info.nlink!==BigInt(1))throw Error("Stage path is not an unlinked regular resource");return info;
}
export interface LibraryStableStageSource {sourceId:string;sourceDirectory:string;databaseSha256:string;stamp:ReplayFileStamp;selectionFingerprint:string}
export interface LibraryStableStageOwnerProcess {pid:number;creationTime100ns:string}
export const isLibraryStableStageOwnerProcess=(value:unknown):value is LibraryStableStageOwnerProcess=>object(value)&&Number.isSafeInteger(value.pid)&&Number(value.pid)>0&&Number(value.pid)<=4294967295&&
  Object.keys(value).every(key=>key==="pid"||key==="creationTime100ns")&&typeof value.creationTime100ns==="string"&&/^[1-9]\d{0,19}$/.test(value.creationTime100ns)&&BigInt(value.creationTime100ns)<=BigInt("18446744073709551615");
const sameProcess=(a:LibraryStableStageOwnerProcess|null|undefined,b:LibraryStableStageOwnerProcess|null|undefined)=>a==null||b==null?a==null&&b==null:a.pid===b.pid&&a.creationTime100ns===b.creationTime100ns;
interface Manifest {
  version:1;stageId:string;ownerId:string;ownerPid:number;createdAt:number;revision:number;previous:string|null;
  ownerProcess?:LibraryStableStageOwnerProcess|null;
  state:"preparing"|"prepared"|"handed-off";app:Identity;root:Identity;directory:Identity;
  source:LibraryStableStageSource;reservedBytes:number;sha256:string;file:Identity|null;
  intent?:{intentId:string;intentFingerprint:string};
}
export interface LibraryStableStageReference {stageId:string;ownerId:string;ownerPid:number;ownerProcess:LibraryStableStageOwnerProcess|null;state:Manifest["state"];reservedBytes:number;relativePath:string;fingerprint:string;intent?:Manifest["intent"]}
interface Entry {manifest:Manifest;reference:LibraryStableStageReference;frames:{name:string;bytes:Buffer;identity:Identity}[]}
export interface LibraryStableStageRecovery {complete:true;retiredOwnerIds:string[];protectedStages:{stageId:string;intentId:string;intentFingerprint:string}[]}

/** Filesystem custody only. Main must provide one serialized writer and confirmed predecessor exit.
 * No PID-liveness inference, source reads, SQL ownership or cleanup of handed-off payloads. */
export class LibraryStableStageRegistry {
  private appIdentity?:Identity;private rootIdentity?:Identity;
  private readonly retired:Set<string>;private readonly owned=new Set<string>();
  private readonly ownerProcess?:LibraryStableStageOwnerProcess;
  constructor(private readonly appDirectory:string,private readonly ownerId:string,retiredOwnerIds:string[]=[],ownerProcess?:LibraryStableStageOwnerProcess){
    if(!isAbsolute(appDirectory)||!uuid(ownerId)||retiredOwnerIds.length>16||retiredOwnerIds.some(id=>!uuid(id))||ownerProcess!==undefined&&(!isLibraryStableStageOwnerProcess(ownerProcess)||ownerProcess.pid!==process.pid))throw Error("Invalid stage custody authority");this.retired=new Set(retiredOwnerIds);this.ownerProcess=ownerProcess?{...ownerProcess}:undefined;
  }
  assertAuthority(appDirectory:string,ownerId:string){if(canonical(appDirectory)!==canonical(this.appDirectory)||ownerId!==this.ownerId)throw Error("Stage registry authority disagrees with resource configuration");}
  private root(){return join(this.appDirectory,"library-deletion-stage");}
  private directory(stageId:string){if(!uuid(stageId))throw Error("Invalid stage identity");return join(this.root(),stageId);}
  private async pin(rootRequired=true){
    const app=identity(await real(this.appDirectory,true));if(this.appIdentity&&!same(app,this.appIdentity))throw Error("Stage app identity changed");this.appIdentity??=app;
    try{const root=identity(await real(this.root(),true));if(this.rootIdentity&&!same(root,this.rootIdentity))throw Error("Stage root identity changed");this.rootIdentity??=root;return true;}
    catch(error){if(!rootRequired&&(error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}
  }
  private async names(path:string,maximum:number){const names:string[]=[];const directory=await opendir(path);try{for await(const item of directory){names.push(item.name);if(names.length>maximum)throw Error("Stage inventory exceeds its finite limit");}}finally{await directory.close().catch(error=>{if((error as NodeJS.ErrnoException).code!=="ERR_DIR_CLOSED")throw error;});}return names.sort();}
  private async read(stageId:string):Promise<Entry>{
    await this.pin();const directory=this.directory(stageId),directoryIdentity=identity(await real(directory,true)),names=await this.names(directory,5);
    const frameNames=names.filter(name=>/^state-00[0-3]\.json$/.test(name));
    if(!frameNames.length||names.some(name=>name!=="scores.db"&&!frameNames.includes(name)))throw Error("Stage has unknown or incomplete custody records");
    let manifest:Manifest|undefined,previous:string|null=null;const frames:Entry["frames"]=[];
    for(let revision=0;revision<frameNames.length;revision++){
      const name=`state-${String(revision).padStart(3,"0")}.json`;if(frameNames[revision]!==name)throw Error("Stage custody chain is incomplete");
      const path=join(directory,name),info=await real(path,false);if(info.size>BigInt(64*1024))throw Error("Stage manifest exceeds limit");
      const file=await open(path,"r");let bytes:Buffer;try{const stat=await file.stat({bigint:true});if(!same(identity(stat),identity(info)))throw Error("Stage manifest identity changed");bytes=await file.readFile();if(bytes.length>64*1024)throw Error("Stage manifest exceeds limit");}finally{await file.close();}
      const value=JSON.parse(bytes.toString("utf8")) as Manifest;
      if(!object(value)||value.version!==1||value.stageId!==stageId||!uuid(value.ownerId)||!Number.isSafeInteger(value.ownerPid)||value.ownerPid<1||value.ownerPid>4294967295||value.ownerProcess!=null&&(!isLibraryStableStageOwnerProcess(value.ownerProcess)||value.ownerProcess.pid!==value.ownerPid)||!Number.isSafeInteger(value.createdAt)||value.revision!==revision||value.previous!==previous||
        !["preparing","prepared","handed-off"].includes(value.state)||!validIdentity(value.app)||!validIdentity(value.root)||!validIdentity(value.directory)||!same(value.app,this.appIdentity as Identity)||!same(value.root,this.rootIdentity as Identity)||!same(value.directory,directoryIdentity)||
        !Number.isSafeInteger(value.reservedBytes)||value.reservedBytes<0||value.reservedBytes>LIBRARY_STABLE_STAGE_MAX_FILE_BYTES||!hash(value.sha256)||value.file!==null&&!validIdentity(value.file)||
        !object(value.source)||typeof value.source.sourceId!=="string"||!value.source.sourceId||value.source.sourceId.length>128||typeof value.source.sourceDirectory!=="string"||!isAbsolute(value.source.sourceDirectory)||value.source.sourceDirectory.length>32768||!hash(value.source.databaseSha256)||!hash(value.source.selectionFingerprint)||!object(value.source.stamp)||
        revision===0&&(value.state!=="preparing"||value.file!==null)||revision===1&&(value.state!=="preparing"||value.file===null)||revision===2&&(value.state!=="prepared"||value.file===null)||revision===3&&(value.state!=="handed-off"||value.file===null||!value.intent||!uuid(value.intent.intentId)||!hash(value.intent.intentFingerprint)))throw Error("Invalid stage custody manifest");
      if(manifest&&(value.ownerId!==manifest.ownerId||value.ownerPid!==manifest.ownerPid||!sameProcess(value.ownerProcess,manifest.ownerProcess)||value.createdAt!==manifest.createdAt||JSON.stringify(value.source)!==JSON.stringify(manifest.source)||value.reservedBytes!==manifest.reservedBytes||value.sha256!==manifest.sha256||manifest.file&&!same(manifest.file,value.file as Identity)))throw Error("Stage custody authority changed");
      manifest=value;previous=digest(bytes);frames.push({name,bytes,identity:identity(info)});
    }
    if(!manifest||!previous)throw Error("Missing stage manifest");
    return{manifest,frames,reference:{stageId,ownerId:manifest.ownerId,ownerPid:manifest.ownerPid,ownerProcess:manifest.ownerProcess??null,state:manifest.state,reservedBytes:manifest.reservedBytes,relativePath:`library-deletion-stage/${stageId}/scores.db`,fingerprint:previous,...(manifest.intent?{intent:manifest.intent}:{})}};
  }
  async inventory(){
    const stages:({stageId:string;state:"unknown";reservedBytes:number}|LibraryStableStageReference)[]=[],blocked:string[]=[];let totalBytes=0;
    if(!await this.pin(false))return{stages,count:0,totalBytes,blocked};
    const names=await this.names(this.root(),LIBRARY_STABLE_STAGE_MAX_COUNT);
    for(const stageId of names){
      try{if(!uuid(stageId))throw Error("Unknown stage entry");const entry=await this.read(stageId);stages.push(entry.reference);totalBytes+=entry.manifest.reservedBytes;
        try{const payload=await real(join(this.directory(stageId),"scores.db"),false);if(payload.size>BigInt(entry.manifest.reservedBytes))throw Error("Stage payload exceeds its reserved quota");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      }catch{if(!stages.some(stage=>stage.stageId===stageId)){stages.push({stageId,state:"unknown",reservedBytes:LIBRARY_STABLE_STAGE_MAX_FILE_BYTES});totalBytes+=LIBRARY_STABLE_STAGE_MAX_FILE_BYTES;}blocked.push(stageId);}
    }
    return{stages,count:names.length,totalBytes,blocked};
  }
  async admit(bytes:number,excluding?:string){
    if(!Number.isSafeInteger(bytes)||bytes<0||bytes>LIBRARY_STABLE_STAGE_MAX_FILE_BYTES)throw Error("Stable staged file exceeds64MiB limit");
    const inventory=await this.inventory(),stages=inventory.stages.filter(stage=>stage.stageId!==excluding);
    if(inventory.blocked.some(id=>id!==excluding))throw Error("Unknown stage custody blocks allocation");
    if(stages.some(stage=>stage.state!=="unknown"&&(stage.ownerId!==this.ownerId||!stage.ownerProcess||!sameProcess(stage.ownerProcess,this.ownerProcess))&&!this.retired.has(stage.ownerId)))throw Error("Previous stage owner retirement is unconfirmed");
    if(stages.length>=LIBRARY_STABLE_STAGE_MAX_COUNT)throw Error("Stable stage count limit reached");
    if(stages.reduce((sum,stage)=>sum+stage.reservedBytes,0)+bytes>LIBRARY_STABLE_STAGE_MAX_TOTAL_BYTES)throw Error("Stable TOTAL stage quota exceeded");
  }
  private async append(manifest:Manifest){
    await this.pin();const directory=this.directory(manifest.stageId);if(!same(identity(await real(directory,true)),manifest.directory))throw Error("Stage directory changed");
    const bytes=Buffer.from(JSON.stringify(manifest));if(bytes.length>64*1024)throw Error("Stage manifest exceeds limit");
    const path=join(directory,`state-${String(manifest.revision).padStart(3,"0")}.json`),file=await open(path,"wx",0o600);
    try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    return(await this.read(manifest.stageId)).reference;
  }
  async register(stageId:string,descriptor:{source:LibraryStableStageSource;bytes:number;sha256:string}){
    if(!this.ownerProcess)throw Error("Actual OS process identity is required before stage registration");
    if(!hash(descriptor.sha256))throw Error("Invalid staged digest");await this.admit(descriptor.bytes,stageId);await this.pin();
    const directory=this.directory(stageId);if((await this.names(directory,1)).length)throw Error("Fresh stage directory is not empty");
    const reference=await this.append({version:1,stageId,ownerId:this.ownerId,ownerPid:this.ownerProcess.pid,ownerProcess:this.ownerProcess,createdAt:Date.now(),revision:0,previous:null,state:"preparing",app:this.appIdentity as Identity,root:this.rootIdentity as Identity,directory:identity(await real(directory,true)),source:descriptor.source,reservedBytes:descriptor.bytes,sha256:descriptor.sha256,file:null});this.owned.add(stageId);return reference;
  }
  async fileCreated(stageId:string,file:Identity){const entry=await this.read(stageId);if(!this.owned.has(stageId)||entry.manifest.revision!==0||!validIdentity(file))throw Error("Stage file custody is unavailable");return this.append({...entry.manifest,revision:1,previous:entry.reference.fingerprint,file});}
  private async payload(entry:Entry,exact?:{bytes:number;sha256:string},signal?:AbortSignal){
    const path=join(this.directory(entry.manifest.stageId),"scores.db");let info;
    try{info=await real(path,false);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"&&!entry.manifest.file)return;throw error;}
    if(!entry.manifest.file||!same(identity(info),entry.manifest.file)||info.size>BigInt(LIBRARY_STABLE_STAGE_MAX_FILE_BYTES))throw Error("Stage payload custody changed");
    const file=await open(path,"r"),sha=createHash("sha256");let position=0;
    try{const buffer=Buffer.alloc(1024*1024);while(position<Number(info.size)){signal?.throwIfAborted();const read=await file.read(buffer,0,Math.min(buffer.length,Number(info.size)-position),position);if(!read.bytesRead)throw Error("Stage payload changed");sha.update(buffer.subarray(0,read.bytesRead));position+=read.bytesRead;await setImmediate();signal?.throwIfAborted();}
      const after=await file.stat({bigint:true});if(!same(identity(after),entry.manifest.file)||after.size!==info.size||after.mtimeNs!==info.mtimeNs||after.ctimeNs!==info.ctimeNs)throw Error("Stage payload changed");
    }finally{await file.close();}
    const actual=sha.digest("hex");
    if(exact?position!==exact.bytes||actual!==exact.sha256:position!==entry.manifest.reservedBytes||actual!==entry.manifest.sha256){if(entry.manifest.state!=="preparing"||position!==0||actual!==digest(Buffer.alloc(0)))throw Error("Partial or foreign stage payload must be preserved");}
  }
  async prepared(stageId:string,signal?:AbortSignal){const entry=await this.read(stageId);if(!this.owned.has(stageId)||entry.manifest.revision!==1)throw Error("Stage cannot be published");await this.payload(entry,undefined,signal);signal?.throwIfAborted();return this.append({...entry.manifest,revision:2,previous:entry.reference.fingerprint,state:"prepared"});}
  private eligible(entry:Entry){if((entry.manifest.ownerId!==this.ownerId||!entry.manifest.ownerProcess||!sameProcess(entry.manifest.ownerProcess,this.ownerProcess))&&!this.retired.has(entry.manifest.ownerId))throw Error("Stage owner retirement is unconfirmed");}
  async handoff(stageId:string,fingerprint:string,intent:{intentId:string;intentFingerprint:string}){
    if(!uuid(intent.intentId)||!hash(intent.intentFingerprint))throw Error("Invalid durable intent handoff");const entry=await this.read(stageId);
    if(entry.manifest.state==="handed-off"){
      if(JSON.stringify(entry.manifest.intent)!==JSON.stringify(intent)||fingerprint!==entry.reference.fingerprint&&fingerprint!==entry.manifest.previous)throw Error("Stage belongs to another durable intent or fingerprint");return entry.reference;
    }
    if(entry.reference.fingerprint!==fingerprint)throw Error("Stage fingerprint changed");
    this.eligible(entry);if(entry.manifest.state!=="prepared")throw Error("Only a prepared stage can be handed off");await this.payload(entry);
    return this.append({...entry.manifest,revision:3,previous:fingerprint,state:"handed-off",intent});
  }
  private async remove(entry:Entry,payload:boolean){
    const current=await this.read(entry.manifest.stageId);if(current.reference.fingerprint!==entry.reference.fingerprint)throw Error("Stage custody changed before cleanup");
    if(payload&&entry.manifest.file){const info=await real(join(this.directory(entry.manifest.stageId),"scores.db"),false);if(!same(identity(info),entry.manifest.file))throw Error("Stage file identity changed");await unlink(join(this.directory(entry.manifest.stageId),"scores.db"));}
    for(const frame of [...entry.frames].reverse()){const path=join(this.directory(entry.manifest.stageId),frame.name),info=await real(path,false);if(!same(identity(info),frame.identity))throw Error("Stage manifest identity changed");await unlink(path);}
    await rmdir(this.directory(entry.manifest.stageId));this.owned.delete(entry.manifest.stageId);
  }
  async discard(stageId:string,fingerprint:string){const entry=await this.read(stageId);if(entry.reference.fingerprint!==fingerprint)throw Error("Stage fingerprint changed");this.eligible(entry);if(entry.manifest.state==="handed-off")throw Error("Handed-off stage payload cannot be discarded");await this.payload(entry);await this.remove(entry,true);return{stageId,state:"discarded" as const};}
  async discardOwned(stageId:string,exact:{bytes:number;sha256:string}){const entry=await this.read(stageId);if(!this.owned.has(stageId)||entry.manifest.state==="handed-off")throw Error("Stage is not owned preparing work");await this.payload(entry,exact);await this.remove(entry,true);}
  async recover(request:LibraryStableStageRecovery){
    if(request.complete!==true||!Array.isArray(request.retiredOwnerIds)||request.retiredOwnerIds.length>16||request.retiredOwnerIds.some(id=>!uuid(id))||!Array.isArray(request.protectedStages)||request.protectedStages.length>16||request.protectedStages.some(stage=>!uuid(stage.stageId)||!uuid(stage.intentId)||!hash(stage.intentFingerprint))||new Set(request.protectedStages.map(stage=>stage.stageId)).size!==request.protectedStages.length)throw Error("Complete bounded journal ownership is required");
    for(const id of request.retiredOwnerIds)this.retired.add(id);
    const before=await this.inventory(),discarded:string[]=[],promoted:string[]=[],preserved:string[]=[];
    for(const stage of before.stages){try{if(stage.state==="unknown"||before.blocked.includes(stage.stageId))throw Error("Unknown stage custody");const entry=await this.read(stage.stageId),protect=request.protectedStages.find(item=>item.stageId===stage.stageId);
      if(protect){if(entry.manifest.state!=="handed-off"){await this.handoff(stage.stageId,stage.fingerprint,{intentId:protect.intentId,intentFingerprint:protect.intentFingerprint});promoted.push(stage.stageId);}else if(JSON.stringify(entry.manifest.intent)!==JSON.stringify({intentId:protect.intentId,intentFingerprint:protect.intentFingerprint}))throw Error("Durable ownership conflicts");else preserved.push(stage.stageId);}
      else if(entry.manifest.state==="handed-off"||entry.manifest.ownerId===this.ownerId||!this.retired.has(entry.manifest.ownerId))preserved.push(stage.stageId);
      else{await this.discard(stage.stageId,stage.fingerprint);discarded.push(stage.stageId);}
    }catch{preserved.push(stage.stageId);}}
    return{...await this.inventory(),discarded,promoted,preserved};
  }
  async retire(stageId:string,fingerprint:string,receipt:{intentId:string;intentFingerprint:string;cleanupFingerprint:string}){
    const entry=await this.read(stageId);if(entry.reference.fingerprint!==fingerprint||entry.manifest.state!=="handed-off"||!hash(receipt.cleanupFingerprint)||JSON.stringify(entry.manifest.intent)!==JSON.stringify({intentId:receipt.intentId,intentFingerprint:receipt.intentFingerprint}))throw Error("Exact durable cleanup receipt is required");
    this.eligible(entry);
    try{await lstat(join(this.directory(stageId),"scores.db"));throw Error("Handed-off payload must be absent before custody retirement");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    await this.remove(entry,false);return{stageId,state:"retired" as const,cleanupFingerprint:receipt.cleanupFingerprint};
  }
}
