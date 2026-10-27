import { randomUUID } from "crypto";
import { isAbsolute } from "path";
import type { LibraryAnalysisControl,LibraryYieldAcknowledgement } from "../../../../shared/library-analysis-gate";
import type { LibraryMetricResult,LibraryMetricTicket } from "../../../../shared/replay-library-metrics";
import { LibraryIncidentEvidenceReceipt,validateLibraryIncidentEvidence } from "../../../../shared/library-incidents";
import type { LibraryScheduledWork } from "./library-scheduler";
import type { LibraryOpenLocation } from "./library-store";
import type { LibraryIncidentEvidenceProbe } from "./library-incidents-probe";
import type { LibraryOperation } from "./library-process-client";
import type { LibraryResourceOperation } from "./library-resource-server";
import { LibraryHandoffFinalizationError } from "./library-numerical-preparation";

export interface LibraryIncidentVerificationDependencies {
  metadata(method:LibraryOperation,args?:Record<string,unknown>):Promise<unknown>;
  /** A new background-gated resource process, never the retired analysis or foreground owner. */
  createResources():{request(method:LibraryResourceOperation,args?:Record<string,unknown>):Promise<unknown>;close():Promise<void>};
}
type ProbeLocation=LibraryOpenLocation&{incidentEpochs:{sourceEpoch:number;locationEpoch:number}};
export interface LibraryIncidentProbeContext {location:ProbeLocation;expected:LibraryIncidentEvidenceReceipt}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const text=(value:unknown,max=128):value is string=>typeof value==="string"&&value.length>0&&value.length<=max;
const revision=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
const bounded=(value:unknown,max:number)=>Buffer.byteLength(JSON.stringify(value))<=max;
export function validateLibraryIncidentProbeContext(value:unknown,ticket:Pick<LibraryMetricTicket,"replayId">):LibraryIncidentProbeContext {
  if(!record(value)||!record(value.location)||!bounded(value,128*1024))throw new Error("Invalid incident probe context");
  const location=value.location,epochs=location.incidentEpochs;
  if(location.replayId!==ticket.replayId||!text(location.sourceId)||!text(location.sourceKey,32768)||!text(location.locator,32768)||
    !text(location.directory,32768)||!isAbsolute(location.directory)||!["stable","replays","lazer","imported"].includes(String(location.kind))||
    !revision(location.locationRevision)||!revision(location.sourceConfigRevision)||!record(location.metadata)||!bounded(location.metadata,65536)||
    typeof location.sha256!=="string"||!/^[a-f0-9]{64}$/.test(location.sha256)||!record(epochs)||!revision(epochs.sourceEpoch)||!revision(epochs.locationEpoch))
    throw new Error("Invalid incident probe context");
  validateLibraryIncidentEvidence(value.expected);
  validateLibraryIncidentEvidence(value.expected,{replaySha256:location.sha256,mapMd5:value.expected.mapMd5});
  // Capture epochs and the exact selected source before asynchronous work starts.
  return JSON.parse(JSON.stringify(value)) as LibraryIncidentProbeContext;
}
export function validateLibraryIncidentProbeResponse(value:unknown,expected:LibraryIncidentProbeContext):LibraryIncidentEvidenceProbe {
  if(!record(value)||!record(value.observation)||!bounded(value,128*1024))throw new Error("Invalid incident probe response");
  const observation=value.observation,origin=value.origin;
  if(Object.keys(value).some(key=>!["evidence","observation","origin","scope"].includes(key))||
    !["stable-sidecar","unsupported-profile"].includes(String(value.scope))||observation.sha256!==expected.location.sha256||
    observation.available!==true||observation.locator!==expected.location.locator||!record(observation.metadata)||!bounded(observation.metadata,65536)||
    origin!==null&&(!record(origin)||Object.keys(origin).length!==2||!["stable","lazer"].includes(String(origin.client))||origin.provenance!=="user-confirmed"))
    throw new Error("Invalid incident probe response");
  validateLibraryIncidentEvidence(value.evidence,{replaySha256:expected.expected.replaySha256,mapMd5:expected.expected.mapMd5});
  return JSON.parse(JSON.stringify(value)) as LibraryIncidentEvidenceProbe;
}

/** Owns only fresh evidence verification. The caller retains the exact C ticket for ordinary
 * failure/cancellation. Once commit starts, an uncertain receipt poisons ownership instead. */
export function startLibraryIncidentVerification(ticket:LibraryMetricTicket,metrics:LibraryMetricResult,initial:LibraryAnalysisControl,
  signal:AbortSignal,deps:LibraryIncidentVerificationDependencies):LibraryScheduledWork {
  signal.throwIfAborted();if(ticket.stage!=="C"||ticket.slot!=="incidents")throw new Error("Invalid incident verification target");
  const resources=deps.createResources(),sessionId=randomUUID();let closing:Promise<void>|undefined,settled=false,revision=0,controlFailure:unknown,selected:LibraryIncidentProbeContext|undefined;
  const close=()=>closing??=Promise.resolve().then(()=>resources.close());
  const cancel=()=>{void close().catch(()=>undefined);};signal.addEventListener("abort",cancel,{once:true});if(signal.aborted)cancel();
  const check=()=>{signal.throwIfAborted();if(controlFailure)throw controlFailure;};
  const control:LibraryScheduledWork["control"]=async value=>{
    const generation=++revision;if(closing){await closing;return"idle";}if(settled)return"idle";
    try{
      const reply=await resources.request("control",{...value});if(settled)return"idle";if(generation!==revision)return"superseded";
      if(!["idle","parked","released","superseded"].includes(String(reply))||(value.viewerDemand||value.userPaused)&&!["idle","parked","superseded"].includes(String(reply)))
        throw new Error("Incident verification resources did not confirm current control");
      return reply as LibraryYieldAcknowledgement;
    }catch(error){if(settled)return"idle";if(generation!==revision)return"superseded";controlFailure=error;void close().catch(()=>undefined);throw error;}
  };
  const result=(async()=>{
    let value:LibraryIncidentEvidenceProbe|undefined,failure:unknown;
    try{
      await control(initial);check();selected=validateLibraryIncidentProbeContext(await deps.metadata("incidents-probe-context",{ticket}),ticket);check();
      value=validateLibraryIncidentProbeResponse(await resources.request("probe-incident-evidence",{sessionId,ticket:selected.location}),selected);check();
    }catch(error){failure=signal.aborted?signal.reason:controlFailure??error;}
    finally{try{await close();}catch(error){failure??=error;}}
    try{
      if(failure)throw failure;check();if(!selected||!value)throw new Error("Incident verification produced no probe");
      try{
        const receipt=await deps.metadata("incidents-commit",{ticket,location:selected.location,probe:value,metrics});
        if(receipt!=="applied"&&receipt!=="stale")throw new Error("Invalid incident commit receipt");
      }catch(error){throw new LibraryHandoffFinalizationError(error);}
      // A confirmed receipt owns persistence even if cancellation arrived while it was pending.
      return metrics;
    }finally{signal.removeEventListener("abort",cancel);settled=true;}
  })();
  return{result,managesPersistence:true,control,eligible:async()=>{
    const lease={kind:"metric",ticket,...(selected?{location:{sourceId:selected.location.sourceId,sourceConfigRevision:selected.location.sourceConfigRevision}}:{})};
    const value=await deps.metadata("analysis-eligible",{lease});if(typeof value!=="boolean")throw new Error("Invalid incident verification eligibility response");return value;
  }};
}
