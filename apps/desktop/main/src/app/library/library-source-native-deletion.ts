import { win32 } from "path";
import { LibrarySourceDeletionHelper,LibraryDeletionHelperReply,deletionHelperOnce } from "./library-source-deletion-helper";
import type { LibraryDeletionReceipt } from "./library-deletion-coordinator";

export interface LibraryNativeDeletionSelection {scoreId:string;expectedReplaySha256?:string}
export interface LibraryNativeDeletionAssociations extends Record<string,unknown> {
  complete:true;basis:"native-content-addressed-metadata";sourceDirectory:string;rootIdentity:string;databaseIdentity:string;databaseSha256:string;schemaFingerprint:string;schemaVersion:number;
  liveRecordsScanned:number;requestedReplaySha256s:string[];records:{scoreId:string;replaySha256:string}[];
  knownRecords:{scoreId:string;state:"live"|"pending"|"missing";replaySha256:string|null}[];
}
export interface LibraryNativeDeletionPlan extends Record<string,unknown> {
  version:1;sourceDirectory:string;rootIdentity:string;databaseIdentity:string;databaseSha256:string;schemaFingerprint:string;schemaVersion:number;token:string;
  records:{scoreId:string;beforeFingerprint:string;afterFingerprint:string;wasDeletePending:boolean;replaySha256:string;retainedFiles:{name:string;sha256:string;path:string}[]}[];
}
export type LibraryDeletionHelperClient=Pick<LibrarySourceDeletionHelper,"request"|"close">;
/** A protected helper can still refuse a particular source that needs conversion. */
const NATIVE_CONVERSION_REFUSAL="This local osu!lazer source requires an unsupported database conversion before deletion. [source-conversion-unqualified]";
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f\d]{64}$/.test(value);
const guid=(value:unknown):value is string=>typeof value==="string"&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(value);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const diagnosticOperations=["associations","prepare","reconcile","acquire","verify","commit","abort","close","guard-acquire","guard-verify"];
const diagnosticPhases=["client-before-open","client-after-write-lock","held-client-check","root-open","immutable-lease-open","immutable-realm-open","identity-guard-open","mutable-realm-open","realm-write-lock","native-operation"];
export interface LibraryNativeDeletionDiagnostic { operation:string;reason:string;subphase:string;nativeErrorCode?:32|33 }
function busyDiagnostic(reply:LibraryDeletionHelperReply):LibraryNativeDeletionDiagnostic|undefined {
  const value=reply.diagnostic;
  if(reply.ok||reply.status!=="source-busy"||!object(value)||Object.keys(value).some(key=>!["operation","reason","subphase","nativeErrorCode"].includes(key))||
    typeof value.operation!=="string"||!diagnosticOperations.includes(value.operation)||typeof value.subphase!=="string"||!diagnosticPhases.includes(value.subphase))return;
  const windows=value.reason==="windows-sharing-or-lock"&&(value.nativeErrorCode===32||value.nativeErrorCode===33);
  const policy=value.reason==="supplemental-client-check"&&["client-before-open","client-after-write-lock","held-client-check"].includes(value.subphase)&&value.nativeErrorCode===undefined;
  const timeout=value.reason==="realm-write-admission-timeout"&&value.subphase==="realm-write-lock"&&value.nativeErrorCode===undefined;
  const unknown=value.reason==="source-busy"&&value.nativeErrorCode===undefined;
  if(!windows&&!policy&&!timeout&&!unknown)return;
  return{operation:value.operation,reason:String(value.reason),subphase:value.subphase,...(windows?{nativeErrorCode:value.nativeErrorCode as 32|33}:{})};
}
function nativeDeletionError(reply:LibraryDeletionHelperReply,prefix:string):Error {
  if(!reply.ok&&reply.status==="source-conversion-unqualified")return Object.assign(new Error(NATIVE_CONVERSION_REFUSAL),{nativeStatus:reply.status});
  const diagnostic=busyDiagnostic(reply),suffix=diagnostic?` [${diagnostic.operation}/${diagnostic.subphase}; ${diagnostic.reason}${diagnostic.nativeErrorCode?`; win32=${diagnostic.nativeErrorCode}`:""}]`:"";
  const error=new Error(prefix+reply.status+suffix);if(diagnostic)Object.assign(error,{nativeDiagnostic:diagnostic});return error;
}
export function nativeDeletionReply(reply:LibraryDeletionHelperReply,status:string,fingerprint?:string):void {
  if(!reply.ok||reply.status!==status||fingerprint!==undefined&&reply.fingerprint!==fingerprint)
    throw nativeDeletionError(reply,"Local native score deletion: ");
}
export function validateNativeAssociations(value:unknown,directory:string,replaySha256s:string[],knownScoreIds:string[]):LibraryNativeDeletionAssociations{
  if(!object(value)||value.complete!==true||value.basis!=="native-content-addressed-metadata"||typeof value.sourceDirectory!=="string"||
    win32.resolve(value.sourceDirectory).toLowerCase()!==win32.resolve(directory).toLowerCase()||(value.schemaVersion!==51&&value.schemaVersion!==73)||
    ![value.rootIdentity,value.databaseIdentity,value.databaseSha256,value.schemaFingerprint].every(hash)||!Number.isSafeInteger(value.liveRecordsScanned)||Number(value.liveRecordsScanned)<0||Number(value.liveRecordsScanned)>500000||
    !Array.isArray(value.requestedReplaySha256s)||value.requestedReplaySha256s.length!==replaySha256s.length||new Set(value.requestedReplaySha256s).size!==replaySha256s.length||
    value.requestedReplaySha256s.some(item=>!replaySha256s.includes(String(item)))||!Array.isArray(value.records)||value.records.length>128||
    new Set(value.records.map(item=>object(item)?item.scoreId:undefined)).size!==value.records.length||value.records.some(item=>!object(item)||!guid(item.scoreId)||!replaySha256s.includes(String(item.replaySha256)))||
    !Array.isArray(value.knownRecords)||value.knownRecords.length!==knownScoreIds.length||new Set(value.knownRecords.map(item=>object(item)?item.scoreId:undefined)).size!==knownScoreIds.length||
    value.knownRecords.some(item=>!object(item)||!knownScoreIds.includes(String(item.scoreId))||!["live","pending","missing"].includes(String(item.state))||item.replaySha256!==null&&!hash(item.replaySha256))||
    Buffer.byteLength(JSON.stringify(value))>120*1024)throw new Error("Native source association evidence is incomplete or changed");
  return value as LibraryNativeDeletionAssociations;
}
export async function inspectNativeDeletion(executable:string,directory:string,replaySha256s:string[],knownScoreIds:string[]):Promise<LibraryNativeDeletionAssociations>{
  if(!replaySha256s.length||replaySha256s.length>128||knownScoreIds.length>128||replaySha256s.some(item=>!hash(item))||knownScoreIds.some(item=>!guid(item))||
    new Set(replaySha256s).size!==replaySha256s.length||new Set(knownScoreIds).size!==knownScoreIds.length)throw new Error("Invalid native association selection");
  const response=await deletionHelperOnce(executable,"--library-source-deletion",{operation:"associations",sourceDirectory:directory,replaySha256s,knownScoreIds});
  nativeDeletionReply(response,"associated");return validateNativeAssociations(response.associations,directory,replaySha256s,knownScoreIds);
}
export function validateNativeDeletionPlan(value:unknown,directory:string,selections:LibraryNativeDeletionSelection[]):LibraryNativeDeletionPlan {
  if(!object(value)||value.version!==1||typeof value.sourceDirectory!=="string"||win32.resolve(value.sourceDirectory).toLowerCase()!==win32.resolve(directory).toLowerCase()||
    ![value.rootIdentity,value.databaseIdentity,value.databaseSha256,value.schemaFingerprint,value.token].every(hash)||(value.schemaVersion!==51&&value.schemaVersion!==73)||
    !Array.isArray(value.records)||value.records.length!==selections.length||value.records.length<1||value.records.length>128||Buffer.byteLength(JSON.stringify(value))>120*1024)
    throw new Error("Invalid native deletion plan");
  const seen=new Set<string>();
  for(const item of value.records){
    if(!object(item)||!guid(item.scoreId)||seen.has(item.scoreId)||!hash(item.beforeFingerprint)||!hash(item.afterFingerprint)||!hash(item.replaySha256)||
      typeof item.wasDeletePending!=="boolean"||!Array.isArray(item.retainedFiles)||item.retainedFiles.length>128)throw new Error("Invalid native deletion score plan");
    const selected=selections.find(selection=>selection.scoreId===item.scoreId);
    if(!selected||selected.expectedReplaySha256!==undefined&&selected.expectedReplaySha256!==item.replaySha256)throw new Error("Native deletion selected different replay bytes");
    seen.add(item.scoreId);
    for(const file of item.retainedFiles)if(!object(file)||typeof file.name!=="string"||!file.name||file.name.length>1024||!hash(file.sha256)||typeof file.path!=="string"||!win32.isAbsolute(file.path)||file.path.length>32768)
      throw new Error("Invalid retained native file evidence");
  }
  return value as LibraryNativeDeletionPlan;
}
export async function prepareNativeDeletion(executable:string,directory:string,records:LibraryNativeDeletionSelection[]):Promise<LibraryNativeDeletionPlan>{
  if(records.length<1||records.length>128||new Set(records.map(item=>item.scoreId)).size!==records.length||records.some(item=>!guid(item.scoreId)||item.expectedReplaySha256!==undefined&&!hash(item.expectedReplaySha256)))
    throw new Error("Invalid native deletion selection");
  const reply=await deletionHelperOnce(executable,"--library-source-deletion",{operation:"prepare",sourceDirectory:directory,records});nativeDeletionReply(reply,"prepared");
  const plan=validateNativeDeletionPlan(reply.plan,directory,records);if(reply.fingerprint!==plan.token)throw new Error("Native deletion preview fingerprint changed");return plan;
}
/** Exactly one transaction/session per physical Realm database. Composition rejects duplicate
 * database identities before opening any session. No managed blobs are removed here. */
export class LibraryNativeDeletionSession {
  private sessionToken?:string;private closed=false;
  constructor(private readonly helper:LibraryDeletionHelperClient,readonly plan:LibraryNativeDeletionPlan){}
  async acquire():Promise<void>{
    if(this.closed||this.sessionToken)throw new Error("Native deletion session cannot be acquired twice");
    const reply=await this.helper.request({operation:"acquire",plan:this.plan});nativeDeletionReply(reply,"acquired",this.plan.token);
    if(!hash(reply.sessionToken))throw new Error("Invalid native deletion session token");this.sessionToken=reply.sessionToken;
  }
  async verify():Promise<void>{nativeDeletionReply(await this.helper.request({operation:"verify",sessionToken:this.token()}),"verified",this.plan.token);}
  async commit():Promise<LibraryDeletionReceipt>{
    const reply=await this.helper.request({operation:"commit",sessionToken:this.token()});nativeDeletionReply(reply,"committed",this.plan.token);
    if(!Array.isArray(reply.records)||reply.records.length!==this.plan.records.length||new Set(reply.records.map(item=>object(item)?item.scoreId:undefined)).size!==this.plan.records.length||
      reply.records.some(item=>!object(item)||!this.plan.records.some(selected=>selected.scoreId===item.scoreId)||!["deleted","already-pending"].includes(String(item.status))))
      throw new Error("Native deletion commit receipt does not cover every acknowledged GUID");
    return{state:"committed",fingerprint:this.plan.token,detail:"Local scores marked for deletion; shared managed files retained.",evidence:{records:reply.records,databaseIdentity:this.plan.databaseIdentity}};
  }
  private token():string {if(this.closed||!this.sessionToken)throw new Error("Native deletion session is not acquired");return this.sessionToken;}
  async close():Promise<void>{
    if(this.closed)return;this.closed=true;
    try{if(this.sessionToken)nativeDeletionReply(await this.helper.request({operation:"abort",sessionToken:this.sessionToken}),"closed");}
    finally{await this.helper.close();}
  }
}
export async function reconcileNativeDeletion(executable:string,plan:LibraryNativeDeletionPlan):Promise<LibraryDeletionReceipt>{
  const reply=await deletionHelperOnce(executable,"--library-source-deletion",{operation:"reconcile",plan});
  if(!reply.ok||reply.fingerprint!==plan.token||!["applied","unchanged","conflict","missing"].includes(reply.status))throw nativeDeletionError(reply,"Native deletion recovery: ");
  return{state:reply.status==="applied"?"committed":reply.status==="unchanged"?"unchanged":"conflict",fingerprint:plan.token,
    detail:reply.status==="missing"?"The acknowledged native score is missing; deletion cannot be proven.":undefined};
}
