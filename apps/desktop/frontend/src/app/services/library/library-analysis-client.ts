import type { LibraryMetricResult, LibraryMetricTicket } from "../../../../../shared/replay-library-metrics";
import type { LibraryAnalysisControl, LibraryYieldAcknowledgement } from "./library-analysis-gate";
import type { LibraryNumericalWireInput, LibraryAnalysisResponse } from "./library-analysis-worker";
import type { LibraryAnalysisChunkReader, LibraryNumericalResourceInput } from "./library-analysis-input";
import { validateLibraryErrorStrip } from "../../../../../shared/library-error-strip";
import type { LibraryAnalysisContinuation,LibraryTimelineOutcome } from "../../../../../shared/library-analysis";

export interface LibraryAnalysisWorkerPort {
  postMessage(value:unknown):void;terminate():void|Promise<void>;
  onmessage:OmitThisParameter<NonNullable<Worker["onmessage"]>>|null;
  onerror:OmitThisParameter<NonNullable<Worker["onerror"]>>|null;
  onmessageerror:OmitThisParameter<NonNullable<Worker["onmessageerror"]>>|null;
}
type ShutdownTerminal="not-required"|"pending"|"complete"|"error"|"cancelled"|"exit-only";
interface ShutdownObservation {
  terminal:ShutdownTerminal;nativeDrain:"pending"|"confirmed"|"rejected";utilityExit:number|"unknown";cancel:"not-required"|"sent"|"failed";
}
type TriggerCategory="protocol"|"worker-error"|"message-error"|"read"|"publication"|"abort"|"cancel"|"control"|"send"|"worker-result";
/** Only fixed lifecycle observations and allowlisted codes enter the durable error message.
 * Keep the owned Error itself: retirement classification/identity affects cancellation handling. */
export class LibraryAnalysisShutdownError extends Error {
  private readonly deadline:ShutdownObservation;
  private final:ShutdownObservation;
  private trigger?:{category:TriggerCategory;code:string};
  constructor(observation:ShutdownObservation) {
    super("Library analysis native shutdown was not confirmed");this.deadline={...observation};this.final={...observation};this.render();
  }
  observeFinal(observation:ShutdownObservation):void {this.final={...observation};this.render();}
  observeTrigger(category:TriggerCategory,error:unknown):void {
    if(this.trigger)return;
    let code="redacted";
    try {const value=(error as {code?:unknown}|null)?.code;
      if(typeof value==="string"&&["ABORT_ERR","ENOENT","EACCES","EPERM","EIO","EPIPE","ERR_STREAM_DESTROYED","ERR_WORKER_NOT_RUNNING"].includes(value))code=value;
    }catch{/* Error objects may have accessors. Diagnostics must not change failure settlement. */}
    this.trigger={category,code};this.render();
  }
  private render():void {
    this.message="Library analysis native shutdown was not confirmed [v1 "+
      `terminalAtDeadline=${this.deadline.terminal} nativeDrainAtDeadline=${this.deadline.nativeDrain} `+
      `terminalFinal=${this.final.terminal} nativeDrainFinal=${this.final.nativeDrain} utilityExit=${this.final.utilityExit} cancel=${this.final.cancel} `+
      `trigger=${this.trigger?.category??"none"} code=${this.trigger?.code??"none"} detail=redacted]`;
  }
}
let workerFactory:(()=>LibraryAnalysisWorkerPort)|undefined;
export function configureLibraryAnalysisWorker(factory:(()=>LibraryAnalysisWorkerPort)|undefined):void {workerFactory=factory;}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const sameTicket=(a:LibraryMetricTicket|undefined,b:LibraryMetricTicket)=>!!a&&
  (["replayId","slot","stage","inputKey","producerVersion","generation","attempt"] as const).every(key=>a[key]===b[key]);
function scalarResult(value:unknown):value is LibraryMetricResult {
  if(!record(value)||!record(value.fields)||!record(value.provenance)||Object.keys(value).some(key=>key!=="fields"&&key!=="provenance"&&key!=="errorStrip"))return false;
  if(value.errorStrip!==undefined)try{validateLibraryErrorStrip(value.errorStrip);}catch{return false;}
  return Object.keys(value.fields).length<=32&&Object.keys(value.provenance).length<=24&&JSON.stringify({fields:value.fields,provenance:value.provenance}).length<=16384&&
    Object.values(value.provenance).every(v=>v===null||["string","number","boolean"].includes(typeof v))&&
    Object.values(value.fields).every(v=>record(v)&&(v.state==="known"?["string","number","boolean"].includes(typeof v.value):
      ["unknown","not-applicable","error"].includes(String(v.state))&&typeof v.reason==="string"));
}

/** One task owns one library worker. Viewer demand parks it; only explicit cancellation retires it. */
export function startLibraryNumerical(ticket:LibraryMetricTicket,input:LibraryNumericalWireInput|LibraryNumericalResourceInput,initial:LibraryAnalysisControl,
  signal:AbortSignal,factory=workerFactory,readChunk?:LibraryAnalysisChunkReader,publishNumerical?:(metrics:LibraryMetricResult)=>Promise<LibraryAnalysisContinuation>,
  publishTimeline?:(outcome:LibraryTimelineOutcome)=>Promise<boolean|"incidents">,
  publishFc?:(outcome:LibraryTimelineOutcome)=>Promise<boolean>) {
  signal.throwIfAborted();if(!factory)throw new Error("Library analysis worker is unavailable");
  const resourceInput="format" in input&&input.format==="resources"?input as LibraryNumericalResourceInput:undefined;
  if(resourceInput&&!readChunk)throw new Error("Library numerical resource reader is unavailable");
  const worker=factory(),ownedTicket=Object.freeze({...ticket});let closed=false,sequence=0;
  const readerAbort=new AbortController();let reading:Promise<unknown>|undefined;
  let publishing:Promise<LibraryAnalysisContinuation>|undefined;
  let phase:"numerical"|"timeline"|"fc"|"finished"=publishNumerical?"numerical":"finished";
  let readSequence=0,pendingRead:number|undefined;
  const offsets={replay:0,map:0};
  let resolveResult!:(value:LibraryMetricResult)=>void,rejectResult!:(reason:unknown)=>void;
  const result=new Promise<LibraryMetricResult>((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
  const controls=new Map<number,{resolve:(state:LibraryYieldAcknowledgement)=>void;reject:(error:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
  type PendingControl={value:LibraryAnalysisControl;resolve:(state:LibraryYieldAcknowledgement)=>void;reject:(error:unknown)=>void};
  let queued:PendingControl|undefined;
  const finish=(value?:LibraryMetricResult,error?:unknown,trigger:TriggerCategory="protocol")=>{
    if(closed)return;closed=true;signal.removeEventListener("abort",abort);
    // Keep the raw read promise separate from its response handler: finishing inside that handler
    // must not await itself. An uncooperative reader delays settlement rather than faking drainage.
    const drain=reading,publication=publishing;readerAbort.abort(error??new Error("Library analysis finished"));
    worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;
    let exit:Promise<void>;
    try{exit=Promise.resolve(worker.terminate());}catch(failure){exit=Promise.reject(failure);}
    for(const pending of controls.values()){
      clearTimeout(pending.timer);if(value)pending.resolve("idle");else pending.reject(error??new Error("Library analysis cancelled"));
    }controls.clear();
    if(queued){if(value)queued.resolve("idle");else queued.reject(error??new Error("Library analysis cancelled"));queued=undefined;}
    const settle=()=>{if(value)resolveResult(value);else rejectResult(error??new Error("Library analysis cancelled"));};
    // A utility-hosted worker acknowledges actual process exit; a browser Worker has a synchronous
    // termination API. Reader failure is already owned by the original outcome, cleanup failure is not.
    void Promise.allSettled([drain,exit,publication]).then(outcomes=>{
      // A lost persistence receipt leaves ownership uncertain even if cancellation arrived first.
      const published=outcomes[2],retired=outcomes[1];
      if(published.status==="rejected")rejectResult(published.reason);
      else if(retired.status==="rejected"){
        if(error!==undefined&&retired.reason instanceof LibraryAnalysisShutdownError)retired.reason.observeTrigger(trigger,error);
        rejectResult(retired.reason);
      }else settle();
    });
  };
  const abort=()=>finish(undefined,signal.reason??new Error("Library analysis cancelled"),"abort");
  const continueAfter=(raw:Promise<LibraryAnalysisContinuation>)=>{
    publishing=raw;
    void raw.then(timeline=>{
      if(publishing===raw)publishing=undefined;if(closed)return;
      if(timeline==="incidents")throw new Error("Incident analysis is retired");
      phase=timeline===true?"timeline":timeline===false?"finished":timeline;
      worker.postMessage({version:1,type:"continue",requestId:1,timeline});
    }).catch(error=>{if(publishing===raw)publishing=undefined;if(!closed)finish(undefined,error,"publication");});
  };
  signal.addEventListener("abort",abort,{once:true});
  worker.onerror=event=>{event.preventDefault();finish(undefined,new Error(event.message||"Library analysis worker failed"),"worker-error");};
  worker.onmessageerror=()=>finish(undefined,new Error("Library analysis worker message failed"),"message-error");
  worker.onmessage=event=>{
    try {
    const response=event.data as LibraryAnalysisResponse;
    if(response?.version!==1)return;
    if(response.type==="numerical"){
      if(response.requestId!==1||!sameTicket(response.ticket,ownedTicket))return;
      if(!publishNumerical||phase!=="numerical"||publishing||!scalarResult(response.metrics)||resourceInput&&
        (offsets.replay!==resourceInput.replayBytes||offsets.map!==resourceInput.mapBytes))throw new Error("Invalid numerical publication");
      continueAfter(Promise.resolve().then(async()=>{
        if(closed)return false;const next=await publishNumerical(response.metrics);
        if(typeof next!=="boolean"&&next!=="fc"||next==="fc"&&!publishTimeline)
          throw new Error("Invalid numerical publication receipt");
        return next;
      }));return;
    }
    if(response.type==="timeline"||response.type==="fc"){
      if(response.requestId!==1||!sameTicket(response.ticket,ownedTicket))return;
      const outcome=response.outcome,publish=response.type==="timeline"?publishTimeline:publishFc,label=response.type==="timeline"?"timeline":"FC";
      if(!publish||phase!==response.type||publishing||!record(outcome)||Object.keys(outcome).length!==1||
        !("metrics"in outcome?scalarResult(outcome.metrics):typeof outcome.error==="string"&&!!outcome.error.trim()&&outcome.error.length<=2048))
        throw new Error(`Invalid ${label} publication`);
      continueAfter(Promise.resolve().then(async()=>{
        if(closed)return false;const next=await publish(outcome);
        if(response.type==="fc"){
          if(next!==false)throw new Error("Invalid final FC publication receipt");
          return false;
        }
        if(typeof next!=="boolean")throw new Error("Invalid FC publication receipt");
        return next===true?"fc" as const:next;
      }));return;
    }
    if(response.type==="read") {
      if(response.requestId!==1||!sameTicket(response.ticket,ownedTicket))return;
      if(!resourceInput||!readChunk||pendingRead!==undefined||!Number.isSafeInteger(response.readId)||response.readId!==readSequence+1||
        !["replay","map"].includes(response.kind)||!Number.isSafeInteger(response.offset)||response.offset!==offsets[response.kind]||
        (response.kind==="map"&&offsets.replay!==resourceInput.replayBytes))throw new Error("Invalid or overlapping numerical resource read");
      const {kind,offset,readId}=response,size=kind==="replay"?resourceInput.replayBytes:resourceInput.mapBytes;
      if(offset<0||offset>=size)throw new Error("Invalid numerical resource offset");
      readSequence=readId;pendingRead=readId;
      const raw=Promise.resolve().then(()=>{if(closed)return;return readChunk(kind,offset,readerAbort.signal);});reading=raw;
      void raw.then(chunk=>{
        if(reading===raw)reading=undefined;
        if(closed)return;
        if(!chunk||!(chunk.bytes instanceof Uint8Array)||!chunk.bytes.length||chunk.bytes.length>256*1024||offset+chunk.bytes.length>size||
          chunk.done!==(offset+chunk.bytes.length===size))throw new Error("Invalid numerical resource chunk");
        offsets[kind]+=chunk.bytes.length;pendingRead=undefined;
        // Copy exactly this bounded view; never clone a larger pooled backing buffer.
        worker.postMessage({version:1,type:"chunk",requestId:1,readId,chunk:{bytes:new Uint8Array(chunk.bytes),done:chunk.done}});
      }).catch(error=>{if(reading===raw)reading=undefined;if(!closed)finish(undefined,error,"read");});
      return;
    }
    if(response.type==="control") {
      const pending=controls.get(response.sequence);if(!pending)return;
      if((response.requestId!==null&&response.requestId!==1)||!["idle","parked","superseded","released"].includes(response.state))return;
      clearTimeout(pending.timer);controls.delete(response.sequence);pending.resolve(response.state);flush();return;
    }
    if(response.type!=="result"||response.requestId!==1)return;
    if(response.ticket&&!sameTicket(response.ticket,ownedTicket))return;
    if(response.status==="complete") {
      if(!sameTicket(response.ticket,ownedTicket))return;
      if(!scalarResult(response.metrics)){finish(undefined,new Error("Invalid library scalar result"));return;}
      finish(response.metrics);
    } else if(response.status==="error"||response.status==="cancelled")finish(undefined,new Error(
      typeof response.error==="string"?response.error.slice(0,2048):"Invalid library worker error"),"worker-result");
    else finish(undefined,new Error("Invalid library worker result status"));
    } catch(error) {finish(undefined,error instanceof Error?error:new Error("Invalid library worker response"));}
  };
  const dispatch=({value,resolve,reject}:PendingControl)=>{
      const current=++sequence;
      const timer=setTimeout(()=>{controls.delete(current);reject(new Error("Library worker did not acknowledge control within 5 seconds"));flush();},5000);
      controls.set(current,{resolve,reject,timer});
      try{worker.postMessage({version:1,type:"control",sequence:current,...value});}
      catch(error){clearTimeout(timer);controls.delete(current);reject(error);flush();}
  };
  const flush=()=>{if(!closed&&queued&&controls.size<32){const pending=queued;queued=undefined;dispatch(pending);}};
  const control=(value:LibraryAnalysisControl):Promise<LibraryYieldAcknowledgement>=>{
    if(closed)return Promise.reject(new Error("Library analysis is closed"));
    return new Promise((resolve,reject)=>{
      const pending={value:{...value},resolve,reject};
      if(controls.size<32)dispatch(pending);
      else{queued?.resolve("superseded");queued=pending;}
    });
  };
  // Control precedes admission on this worker's ordered message channel.
  void control(initial).catch(error=>{if(!closed)finish(undefined,error,"control");});
  try {if(signal.aborted)abort();else worker.postMessage({version:1,type:"run",requestId:1,ticket:ownedTicket,input,
    ...(publishNumerical?{timeline:true}:{}),...(publishTimeline?{fc:true}:{}),...(publishFc?{publishFc:true}:{})});}
  catch(error){finish(undefined,error,"send");}
  return {result,control,cancel:()=>finish(undefined,new Error("Library analysis cancelled"),"cancel")};
}
