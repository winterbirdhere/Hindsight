import { randomUUID } from "crypto";
import { win32 } from "path";
import { LibraryNativeDrainError,LibrarySourceResourceOperation,LibrarySourceMutationResources,librarySourceResourceOperations } from "./library-native-admission";
import type { LibraryResourceOperation } from "./library-resource-server";
import type { LibraryConfiguredSource } from "./library-service";
import { LibraryProcessIdentity,processOwnerRetired } from "./library-source-process-identity";
import { isLibraryStableStageOwnerProcess } from "./library-stable-deletion-stage";

interface ResourceClient {request(operation:LibraryResourceOperation,args:Record<string,unknown>):Promise<unknown>;close():Promise<void>}
interface DirectoryOwner {owner?:LibraryDeletionResourceOwner;uncertain?:LibraryNativeDrainError;retired:Set<string>}
// Shared across metadata-owner replacement within this main process. Previous-app owners are
// never inferred retired here: the durable stage registry must preserve unknown ownership.
const directories=new Map<string,DirectoryOwner>();
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const uuid=(value:unknown)=>typeof value==="string"&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const hash=(value:unknown)=>typeof value==="string"&&/^[a-f\d]{64}$/.test(value);
function validate(sources:readonly LibraryConfiguredSource[],operation:LibrarySourceResourceOperation,args:Record<string,unknown>,state:DirectoryOwner):void{
  if(!librarySourceResourceOperations.includes(operation)||Buffer.byteLength(JSON.stringify(args))>256*1024)throw new Error("Invalid bounded deletion resource request");
  if(operation==="inspect-stable-deletion"||operation==="prepare-stable-deletion"){
    const keys=operation==="inspect-stable-deletion"?["sourceId","sourceDirectory","knownSourceKeys","replayHeader","replayHeaders"]:["sourceId","sourceDirectory","expected","selections"];
    if(typeof args.sourceId!=="string"||typeof args.sourceDirectory!=="string"||!win32.isAbsolute(args.sourceDirectory)||args.sourceDirectory.length>32768||
      Object.keys(args).some(key=>!keys.includes(key))||!sources.some(source=>source.kind==="stable"&&source.id===args.sourceId&&win32.resolve(source.directory).toLowerCase()===win32.resolve(String(args.sourceDirectory)).toLowerCase()))
      throw new Error("Stable deletion resource is outside the configured main-owned source");
    return;
  }
  const keys=operation==="inspect-stable-stages"?[]:operation==="recover-stable-stages"?["retiredOwnerIds","protectedStages","complete"]:
    operation==="retire-stable-stage"?["stageId","fingerprint","intentId","intentFingerprint","cleanupFingerprint"]:
      operation==="handoff-stable-stage"?["stageId","fingerprint","intentId","intentFingerprint"]:["stageId","fingerprint"];
  if(Object.keys(args).some(key=>!keys.includes(key)))throw new Error("Invalid trusted stage resource authority");
  if(operation==="inspect-stable-stages")return;
  if(operation==="recover-stable-stages"){
    if(args.complete!==true||!Array.isArray(args.retiredOwnerIds)||args.retiredOwnerIds.length>16||args.retiredOwnerIds.some(id=>typeof id!=="string"||!state.retired.has(id))||
      !Array.isArray(args.protectedStages)||args.protectedStages.length>16||args.protectedStages.some(item=>!object(item)||Object.keys(item).some(key=>!["stageId","intentId","intentFingerprint"].includes(key))||!uuid(item.stageId)||!uuid(item.intentId)||!hash(item.intentFingerprint)))
      throw new Error("Stage recovery requires complete journal evidence and confirmed retired owners");
    return;
  }
  if(!uuid(args.stageId)||!hash(args.fingerprint)||(operation==="handoff-stable-stage"||operation==="retire-stable-stage")&&(!uuid(args.intentId)||!hash(args.intentFingerprint))||
    operation==="retire-stable-stage"&&!hash(args.cleanupFingerprint))throw new Error("Invalid trusted stage identity");
}

/** Exactly one main-owned existing resource utility per app directory, retained for the admitted
 * span. Normal completion closes it only after journal handoff/discard; unknown exit is sticky. */
export class LibraryDeletionResourceOwner implements LibrarySourceMutationResources {
  private readonly state:DirectoryOwner;
  private client?:ResourceClient;private ownerId?:string;private sessionId?:string;private active=false;private closing?:Promise<void>;
  constructor(directory:string,private readonly sources:readonly LibraryConfiguredSource[],private readonly create:(ownerId:string,retiredOwnerIds:string[])=>ResourceClient,
    private readonly inspectProcess?:(pid:number)=>Promise<LibraryProcessIdentity>){
    const key=win32.resolve(directory).toLowerCase();let state=directories.get(key);
    if(!state){state={retired:new Set()};directories.set(key,state);}this.state=state;
  }
  async run(operation:LibrarySourceResourceOperation,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
    signal.throwIfAborted();if(this.state.uncertain)throw this.state.uncertain;
    validate(this.sources,operation,args,this.state);
    if(this.active||this.closing)throw new Error("Deletion resource owner is busy");
    if(this.state.owner&&this.state.owner!==this)throw new Error("Previous deletion resource owner has not exited");
    if(!this.client){this.state.owner=this;this.ownerId=randomUUID();this.sessionId=randomUUID();
      try{this.client=this.create(this.ownerId,[...this.state.retired].slice(-16));}catch(error){this.state.owner=undefined;this.ownerId=undefined;this.sessionId=undefined;throw error;}}
    const client=this.client,sessionId=this.sessionId;this.active=true;
    let retiring=false;const abort=()=>{retiring=true;void client.request("release",{sessionId}).catch(()=>undefined);void this.close().catch(()=>undefined);};
    const timer=setTimeout(abort,25_000);signal.addEventListener("abort",abort,{once:true});
    try{if(signal.aborted)abort();const result=await client.request(operation as LibraryResourceOperation,{...args,sessionId});
      if(operation==="inspect-stable-stages"&&object(result)&&Array.isArray(result.stages)&&result.stages.length<=16){
        const owners=new Map<string,string>();
        for(const stage of result.stages.filter(object)){
          if(stage.state==="unknown")continue;
          if(!uuid(stage.ownerId)||!Number.isSafeInteger(stage.ownerPid)||Number(stage.ownerPid)<1||Number(stage.ownerPid)>0xffffffff||
            stage.ownerProcess!==null&&!isLibraryStableStageOwnerProcess(stage.ownerProcess))throw new Error("Stage predecessor identity is invalid");
          const owner=stage.ownerId as string,binding=JSON.stringify([stage.ownerPid,stage.ownerProcess]);
          if(owners.has(owner)&&owners.get(owner)!==binding)throw new Error("Stage predecessor identity conflicts");
          if(owners.has(owner))continue;owners.set(owner,binding);
          if(owner===this.ownerId||this.state.retired.has(owner)||!this.inspectProcess)continue;
          if(retiring)throw new Error("Stage predecessor inspection cancelled");signal.throwIfAborted();
          const observed=await this.inspectProcess(Number(stage.ownerPid));
          if(processOwnerRetired(Number(stage.ownerPid),stage.ownerProcess as import("./library-stable-deletion-stage").LibraryStableStageOwnerProcess|null,observed))this.state.retired.add(owner);
        }
        if(retiring)throw new Error("Stage predecessor inspection cancelled");
        const retiredOwnerIds=[...new Set(result.stages.filter(object).map(stage=>stage.ownerId).filter((id):id is string=>typeof id==="string"&&this.state.retired.has(id)))];
        const blocked=Array.isArray(result.blocked)?[...result.blocked]:["Stage inventory is invalid"];
        if([...owners.keys()].some(owner=>owner!==this.ownerId&&!this.state.retired.has(owner)))blocked.push("A staging predecessor's exit is not proven; its files remain preserved.");
        return{...result,blocked,retiredOwnerIds};
      }return result;}
    catch(error){if(error instanceof LibraryNativeDrainError){try{await this.close();}catch{/* Existing sticky close uncertainty remains authoritative. */}this.state.uncertain??=error;}throw error;}
    finally{clearTimeout(timer);signal.removeEventListener("abort",abort);this.active=false;if(this.closing)await this.closing;}
  }
  close():Promise<void>{
    if(this.state.uncertain)return Promise.reject(this.state.uncertain);
    if(this.closing)return this.closing;if(!this.client)return Promise.resolve();
    const client=this.client,ownerId=this.ownerId!;let timer:ReturnType<typeof setTimeout>|undefined;
    this.closing=Promise.race([Promise.resolve().then(()=>client.close()),new Promise<void>((_resolve,reject)=>{
      timer=setTimeout(()=>reject(new LibraryNativeDrainError("Stable deletion resource utility exit is unconfirmed")),7_000);
    })]).then(()=>{this.state.retired.add(ownerId);this.state.owner=undefined;this.client=undefined;this.ownerId=undefined;this.sessionId=undefined;},error=>{
      this.state.uncertain=error instanceof LibraryNativeDrainError?error:new LibraryNativeDrainError("Stable deletion resource utility close failed");throw this.state.uncertain;
    }).finally(()=>{clearTimeout(timer);if(!this.state.uncertain)this.closing=undefined;});
    void this.closing.catch(()=>undefined);return this.closing;
  }
}

/** One-shot adapter retained for isolated read-only callers/tests. Production uses span custody. */
export async function runLibraryDeletionResource(sources:readonly LibraryConfiguredSource[],create:()=>ResourceClient,
  operation:LibrarySourceResourceOperation,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
  const owner=new LibraryDeletionResourceOwner("D:\\isolated-resource-"+randomUUID(),sources,create);
  try{return await owner.run(operation,args,signal);}finally{await owner.close();}
}
