/** Explicit diagnostic-only scalar receipts. No timer, storage, counter or product RPC. */
export const LIBRARY_SPARSE_EVENT="library-sparse-boundary";
export const sparseEnabled=process.env.HINDSIGHT_LIBRARY_SPARSE_BOUNDARY==="1";
type Value=Record<string,unknown>;
const object=(v:unknown):v is Value=>!!v&&typeof v==="object"&&!Array.isArray(v);
const keys=(v:Value,names:string[])=>Object.keys(v).length===names.length&&Object.keys(v).every(k=>names.includes(k));
const token=(v:unknown):v is string=>typeof v==="string"&&/^[a-zA-Z0-9_.:/+-]{1,128}$/.test(v);
const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
export interface SparsePreparation {replayId:string;stage:"P";dependencyKey:string;generation:number;reason:"open"|"selection"|"retry"|"background";attempt:string}
export function isSparsePreparation(v:unknown):v is SparsePreparation {
  return object(v)&&keys(v,["replayId","stage","dependencyKey","generation","reason","attempt"])&&
    token(v.replayId)&&v.stage==="P"&&token(v.dependencyKey)&&count(v.generation)&&["open","selection","retry","background"].includes(String(v.reason))&&token(v.attempt);
}
export function sparsePreparation(v:unknown):SparsePreparation {
  if(!isSparsePreparation(v))throw new Error("Invalid sparse P preparation identity");
  return{replayId:v.replayId,stage:"P",dependencyKey:v.dependencyKey,generation:v.generation,reason:v.reason,attempt:v.attempt};
}
export interface SparseScan {sourceId:string;generation:string|null;state:string;observations:number;unfinished:boolean;progress?:{phase:string;completed:number;unit:string;total?:number}}
function scan(v:unknown):boolean {
  if(!object(v)||!keys(v,["sourceId","generation","state","observations","unfinished",...(v.progress===undefined?[]:["progress"])])||
    !token(v.sourceId)||v.generation!==null&&!token(v.generation)||!["idle","queued","scanning","waiting-for-viewer","stopped","complete","error"].includes(String(v.state))||
    !count(v.observations)||typeof v.unfinished!=="boolean"||v.unfinished&&(v.generation===null||!["scanning","waiting-for-viewer"].includes(String(v.state))))return false;
  const p=v.progress;
  return p===undefined||object(p)&&keys(p,["phase","completed","unit",...(p.total===undefined?[]:["total"])])&&
    ["reading-map-metadata","checking-replays","committing"].includes(String(p.phase))&&["map-records","replay-observations","source-records"].includes(String(p.unit))&&
    count(p.completed)&&(p.total===undefined||count(p.total)&&Number(p.total)>=Number(p.completed));
}
export function isSparseObservation(v:unknown):v is Value {
  if(!object(v))return false;
  if(v.kind==="scan")return keys(v,["kind","scan"])&&scan(v.scan);
  if(v.kind==="scan-demand")return keys(v,["kind","requestId","active","scans"])&&token(v.requestId)&&typeof v.active==="boolean"&&Array.isArray(v.scans)&&v.scans.length<=4&&v.scans.every(scan)&&new Set(v.scans.map(x=>(x as SparseScan).sourceId)).size===v.scans.length;
  if(v.kind==="p-binding")return keys(v,["kind","ticket"])&&isSparsePreparation(v.ticket);
  if(v.kind==="p-request-retired")return keys(v,["kind","requestId","sessionId","ok"])&&token(v.requestId)&&token(v.sessionId)&&typeof v.ok==="boolean";
  if(v.kind==="p-input-complete")return keys(v,["kind","nativeId","pid","writeId","bytes","unfinished","requestId","sessionId"])&&token(v.nativeId)&&count(v.pid)&&Number(v.pid)>0&&count(v.writeId)&&Number(v.writeId)>0&&Number(v.writeId)<=16&&count(v.bytes)&&Number(v.bytes)>0&&Number(v.bytes)<=32*1024*1024&&typeof v.unfinished==="boolean"&&token(v.requestId)&&token(v.sessionId);
  if(v.kind==="p-result-started")return keys(v,["kind","nativeId","pid","requestId","sessionId"])&&token(v.nativeId)&&count(v.pid)&&Number(v.pid)>0&&token(v.requestId)&&token(v.sessionId);
  if(v.kind==="p-native-retired")return keys(v,["kind","nativeId","pid","code","signal","requestId","sessionId"])&&token(v.nativeId)&&count(v.pid)&&Number(v.pid)>0&&(v.code===null||Number.isSafeInteger(v.code))&&(v.signal===null||token(v.signal))&&token(v.requestId)&&token(v.sessionId);
  return v.kind==="fault"&&keys(v,["kind","reason"])&&["invalid","overflow","transport"].includes(String(v.reason));
}
export function isSparseEvent(v:unknown):v is {version:1;event:string;sequence:number;observation:Value} {
  return object(v)&&keys(v,["version","event","sequence","observation"])&&v.version===1&&v.event===LIBRARY_SPARSE_EVENT&&count(v.sequence)&&Number(v.sequence)>0&&Number(v.sequence)<=4097&&isSparseObservation(v.observation);
}
export type SparseObserver=(value:unknown)=>void;
export function createSparseEmitter(send:(value:unknown)=>void):SparseObserver {
  let sequence=0,failed=false;
  return value=>{
    if(failed)return;
    let observation=value;
    if(!isSparseObservation(value)){observation={kind:"fault",reason:"invalid"};failed=true;}
    else if(sequence>=4096){observation={kind:"fault",reason:"overflow"};failed=true;}
    try{send({version:1,event:LIBRARY_SPARSE_EVENT,sequence:++sequence,observation});}
    catch{failed=true;} // Diagnostic transport loss cannot replace a product result; its receipt chain is incomplete.
  };
}
const port=(process as NodeJS.Process&{parentPort?:{postMessage(value:unknown):void}}).parentPort;
export const sparseObservation:SparseObserver|undefined=sparseEnabled&&port?createSparseEmitter(value=>port.postMessage(value)):undefined;
