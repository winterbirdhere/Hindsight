import { win32 } from "path";
import { deletionHelperOnce,LibraryDeletionHelperReply } from "./library-source-deletion-helper";
import type { LibraryDeletionHelperClient } from "./library-source-native-deletion";
import type { LibraryDeletionReceipt } from "./library-deletion-coordinator";
import type { LibraryDeletionIntent } from "./library-deletion-store";

export interface LibraryFileDeletionStage {relativePath:string;bytes:number;sha256:string}
export interface LibraryFileDeletionSelection {id:string;sourceId:string;relativePath:string;staged?:LibraryFileDeletionStage;expectedSha256:string;expectedBytes?:number}
export interface LibraryFileDeletionAuthority {appDirectory:string;sources:{id:string;directory:string}[]}
interface FileIdentity {identity:string;bytes:number;sha256:string;writeTime:string;attributes:number;securityHash:string}
export interface LibraryFileDeletionPlan extends Record<string,unknown> {
  version:1;nonce:string;app:{directory:string;identity:string};sources:{id:string;directory:string}[];roots:{directory:string;identity:string}[];
  targets:{id:string;sourceId:string;relativePath:string;parentIdentity:string;before:FileIdentity;staged:LibraryFileDeletionStage|null;stageIdentity:FileIdentity|null}[];fingerprint:string;
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f\d]{64}$/.test(value);
const samePath=(left:string,right:string)=>win32.resolve(left).toLowerCase()===win32.resolve(right).toLowerCase();
const relative=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=1024&&!win32.isAbsolute(value)&&
  value.replace(/\\/g,"/").split("/").every(part=>part!==""&&part!=="."&&part!==".."&&![...part].some(char=>char.charCodeAt(0)<32)&&!/[<>:"|?*]|[. ]$/.test(part));
function identity(value:unknown):value is FileIdentity {
  return object(value)&&typeof value.identity==="string"&&/^[a-f\d]{8}:[a-f\d]{16}$/.test(value.identity)&&
    Number.isSafeInteger(value.bytes)&&Number(value.bytes)>=0&&Number(value.bytes)<=64*1024*1024&&hash(value.sha256)&&hash(value.securityHash)&&
    typeof value.writeTime==="string"&&/^\d+$/.test(value.writeTime)&&Number.isSafeInteger(value.attributes);
}
function reply(reply:LibraryDeletionHelperReply,status:string,fingerprint?:string):void {
  if(!reply.ok||reply.status!==status||fingerprint!==undefined&&reply.fingerprint!==fingerprint)throw new Error("Local file deletion: "+reply.status);
}
export function validateFileDeletionPlan(value:unknown,authority:LibraryFileDeletionAuthority,selections:LibraryFileDeletionSelection[]):LibraryFileDeletionPlan {
  if(!object(value)||value.version!==1||typeof value.nonce!=="string"||!/^[a-f\d]{32}$/.test(value.nonce)||!hash(value.fingerprint)||
    !object(value.app)||typeof value.app.directory!=="string"||!samePath(value.app.directory,authority.appDirectory)||typeof value.app.identity!=="string"||
    !Array.isArray(value.sources)||value.sources.length!==authority.sources.length||!Array.isArray(value.roots)||value.roots.length!==authority.sources.length||
    !Array.isArray(value.targets)||value.targets.length!==selections.length||value.targets.length<1||value.targets.length>32||Buffer.byteLength(JSON.stringify(value))>120*1024)
    throw new Error("Invalid file deletion plan");
  const sourceIds=new Set<string>();
  for(let index=0;index<value.sources.length;index++){
    const source=value.sources[index],root=value.roots[index];
    if(!object(source)||typeof source.id!=="string"||sourceIds.has(source.id)||typeof source.directory!=="string"||!authority.sources.some(item=>item.id===source.id&&samePath(item.directory,source.directory as string))||
      !object(root)||typeof root.directory!=="string"||!samePath(root.directory,source.directory)||typeof root.identity!=="string")throw new Error("File deletion source authority changed");
    sourceIds.add(source.id);
  }
  const ids=new Set<string>();
  for(const target of value.targets){
    if(!object(target)||typeof target.id!=="string"||ids.has(target.id)||typeof target.sourceId!=="string"||!relative(target.relativePath)||typeof target.parentIdentity!=="string"||!identity(target.before))
      throw new Error("Invalid file deletion target");
    const selected=selections.find(item=>item.id===target.id);
    if(!selected||selected.sourceId!==target.sourceId||selected.relativePath.replace(/\\/g,"/")!==target.relativePath.replace(/\\/g,"/")||
      target.before.sha256!==selected.expectedSha256||selected.expectedBytes!==undefined&&target.before.bytes!==selected.expectedBytes)
      throw new Error("Selected file changed before deletion preview");
    if(selected.staged){
      if(!object(target.staged)||target.staged.relativePath!==selected.staged.relativePath||target.staged.bytes!==selected.staged.bytes||target.staged.sha256!==selected.staged.sha256||
        !identity(target.stageIdentity)||target.stageIdentity.sha256!==selected.staged.sha256||target.stageIdentity.bytes!==selected.staged.bytes)throw new Error("Prepared Stable bytes changed");
    }else if(target.staged!=null||target.stageIdentity!=null)throw new Error("Unexpected file replacement");
    ids.add(target.id);
  }
  return value as LibraryFileDeletionPlan;
}
export async function prepareFileDeletion(executable:string,authority:LibraryFileDeletionAuthority,selections:LibraryFileDeletionSelection[]):Promise<LibraryFileDeletionPlan>{
  if(selections.some(item=>!relative(item.relativePath)||!hash(item.expectedSha256)))throw new Error("Invalid selected file");
  const targets=selections.map(({expectedSha256:_sha,expectedBytes:_bytes,...target})=>target);
  const response=await deletionHelperOnce(executable,"--library-file-mutation",{operation:"prepare",authority,targets});reply(response,"prepared");
  const plan=validateFileDeletionPlan(response.plan,authority,selections);if(response.fingerprint!==plan.fingerprint)throw new Error("File plan fingerprint changed");return plan;
}
function receipt(response:LibraryDeletionHelperReply,plan:LibraryFileDeletionPlan,targetId:string):LibraryDeletionReceipt {
  const value=response.receipt,target=plan.targets.find(item=>item.id===targetId);
  if(!target||!response.ok||!object(value)||!hash(value.fingerprint)||response.fingerprint!==value.fingerprint||response.status!==value.state||
    !["committed","unchanged","conflict"].includes(String(value.state))||!object(value.evidence))throw new Error("Local file deletion outcome: "+response.status);
  const evidence=value.evidence;
  if(evidence.rootIdentity!==target.parentIdentity||evidence.relativePath!==target.relativePath||JSON.stringify(evidence.before)!==JSON.stringify(target.before)||
    typeof evidence.quarantineName!=="string"||!new RegExp("^\\.hindsight-"+plan.nonce+"-\\d{3}-old$").test(evidence.quarantineName)||
    value.state==="committed"&&target.staged&&(!identity(evidence.installed)||evidence.installed.sha256!==target.staged.sha256||evidence.installed.bytes!==target.staged.bytes)||
    value.state==="committed"&&!target.staged&&evidence.installed!=null)
    throw new Error("File deletion receipt does not match its acknowledged plan");
  return{state:value.state as LibraryDeletionReceipt["state"],fingerprint:value.fingerprint,evidence,detail:typeof value.detail==="string"?value.detail:undefined};
}
/** One retained handle batch for all file targets; commit remains truthful per physical group. */
export class LibraryFileDeletionSession {
  private sessionToken?:string;private intentId?:string;private closed=false;private commitDispatched=false;
  constructor(private readonly helper:LibraryDeletionHelperClient,readonly plan:LibraryFileDeletionPlan){}
  async acquire(intentId:string,continuation?:{committed:{id:string;fingerprint:string}[];remainingTargetIds:string[]}):Promise<void>{
    if(this.closed||this.sessionToken)throw new Error("File deletion session cannot be acquired twice");
    if(!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(intentId))throw new Error("Invalid durable deletion intent");this.intentId=intentId;
    if(continuation){const ids=[...continuation.committed.map(target=>target.id),...continuation.remainingTargetIds];
      if(ids.length!==this.plan.targets.length||new Set(ids).size!==ids.length||ids.some(id=>!this.plan.targets.some(target=>target.id===id))||continuation.committed.some(target=>!hash(target.fingerprint)))throw new Error("Invalid continuation partition");}
    const response=await this.helper.request({operation:continuation?"acquire-continuation":"acquire",plan:this.plan,intentId,...continuation});reply(response,"acquired",this.plan.fingerprint);
    if(!hash(response.sessionToken))throw new Error("Invalid file deletion session token");this.sessionToken=response.sessionToken;this.commitDispatched=!!continuation?.committed.length;
  }
  private token():string {if(this.closed||!this.sessionToken)throw new Error("File deletion session is not acquired");return this.sessionToken;}
  async verify(targetId:string):Promise<void>{reply(await this.helper.request({operation:"verify",sessionToken:this.token(),targetId}),"verified",this.plan.fingerprint);}
  async commit(targetId:string,intentId:string):Promise<LibraryDeletionReceipt>{if(intentId!==this.intentId)throw new Error("File mutation intent changed");const sessionToken=this.token();this.commitDispatched=true;return receipt(await this.helper.request({operation:"commit",sessionToken,targetId,intentId}),this.plan,targetId);}
  async close(preserve=false):Promise<void>{if(this.closed)return;this.closed=true;
    // EOF disposes retained handles without deleting prepared evidence. A different source may
    // already have committed even when this file batch has not; only core can decide cleanup.
    try{if(this.sessionToken&&!preserve)reply(await this.helper.request({operation:this.commitDispatched?"close":"abort",sessionToken:this.sessionToken}),"closed");}finally{await this.helper.close();}}
}
export async function reconcileFileDeletion(executable:string,plan:LibraryFileDeletionPlan,targetId:string,intentId:string):Promise<LibraryDeletionReceipt>{
  return receipt(await deletionHelperOnce(executable,"--library-file-mutation",{operation:"reconcile",plan,targetId,intentId}),plan,targetId);
}
export function fileDeletionCompletion(plan:LibraryFileDeletionPlan,intent:LibraryDeletionIntent){
  if(!intent.metadataCommitted||!intent.metadataCompletion||!hash(intent.metadataCompletion.markerSha256)||intent.metadataCompletion.revision<1)
    throw new Error("File cleanup requires the durable metadata completion marker");
  const targets=plan.targets.map(file=>{const target=intent.targets.find(target=>target.target.id===file.id);
    if(!target||target.state!=="committed"||!target.receipt||!hash(target.receipt.fingerprint))throw new Error("File cleanup lacks an exact committed target receipt");
    return{id:file.id,fingerprint:target.receipt.fingerprint};});
  return{intentId:intent.id,planFingerprint:plan.fingerprint,...intent.metadataCompletion,targets};
}
export async function cleanupFileDeletion(executable:string,plan:LibraryFileDeletionPlan,intent:LibraryDeletionIntent,finish:boolean,
  run:typeof deletionHelperOnce=deletionHelperOnce):Promise<{state:"complete"|"required";detail?:string;fingerprint:string}>{
  const committed=intent.metadataCommitted===true;
  if(!committed&&(intent.confirmedAt===undefined&&!intent.stages?.length||intent.retiredLocations?.length||intent.targets.some(target=>!["pending","unchanged"].includes(target.state))))
    throw new Error("Unresolved source writes cannot be treated as acquisition cleanup");
  const operation=committed?(finish?"finalize":"cleanup-status"):(finish?(intent.confirmedAt===undefined?"discard":"abort-acquire"):"acquire-cleanup-status");
  const response=await run(executable,"--library-file-mutation",{operation,plan,...(operation==="discard"?{}:{intentId:intent.id}),...(committed?{completion:fileDeletionCompletion(plan,intent)}:{})});
  const value=response.receipt,success=finish?(committed?"finalized":operation==="discard"?"discarded":"aborted"):"clean";
  if(!response.ok||!object(value)||!hash(response.fingerprint)||value.fingerprint!==response.fingerprint||value.state!==response.status||
    ![success,"required","conflict"].includes(response.status)||value.detail!=null&&(typeof value.detail!=="string"||value.detail.length>2048))
    throw new Error("File cleanup outcome is unverified: "+response.status);
  return{state:response.status===success?"complete":"required",fingerprint:response.fingerprint,
    ...(value.detail?{detail:value.detail as string}:response.status==="conflict"?{detail:"Owned cleanup objects changed; temporary files were preserved."}:{})};
}
