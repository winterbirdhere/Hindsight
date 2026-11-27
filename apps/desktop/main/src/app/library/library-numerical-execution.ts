import type { LibraryNumericalResourceInput, LibraryNumericalResourceDescriptor,LibraryAnalysisContinuation,LibraryTimelineOutcome } from "../../../../shared/library-analysis";
import type { LibraryMetricTicket,LibraryMetricResult } from "../../../../shared/replay-library-metrics";
import type { LibraryResourceChunk } from "../../../../shared/library-resources";
import type { LibraryAnalysisControl, LibraryYieldAcknowledgement } from "../../../../shared/library-analysis-gate";
import type { LibraryNumericalResources } from "./library-numerical-resources";
import type { LibraryScheduledWork } from "./library-scheduler";
import type { LibraryOperation } from "./library-process-client";
import { libraryTimelineTarget } from "./library-timeline-target";
import { libraryFcTarget } from "./library-fc-target";
import { validateLibraryIncidentEvidence } from "../../../../shared/library-incidents";
import { LibraryHandoffFinalizationError } from "./library-numerical-preparation";

export interface LibraryNumericalExecutionDependencies {
  prepared?:LibraryNumericalResourceDescriptor&{replayId:string};
  resources:Pick<LibraryNumericalResources,"openTarget"|"control"|"read"|"close">&Partial<Pick<LibraryNumericalResources,"eligible"|"publishNumerical"|"publishTimeline"|"publishFc"|"metricTicket">>;
  metadata?:(method:LibraryOperation,args:Record<string,unknown>)=>Promise<unknown>;
  /** The remote worker owns only computation. Its result must include worker/read drainage. */
  startWorker(ticket:LibraryMetricTicket,input:LibraryNumericalResourceInput,initial:LibraryAnalysisControl,signal:AbortSignal,
    read:(kind:"replay"|"map",offset:number,signal:AbortSignal)=>Promise<LibraryResourceChunk>,publishNumerical?:(metrics:LibraryMetricResult)=>Promise<LibraryAnalysisContinuation>,
    publishTimeline?:(outcome:LibraryTimelineOutcome)=>Promise<boolean|"incidents">,
    publishFc?:(outcome:LibraryTimelineOutcome)=>Promise<boolean>):LibraryScheduledWork;
}

/** Scheduler execution boundary. No viewer managers or native foreground queues are shared.
 * A computation parked on a chunk is insufficient: the separate resource owner must also yield. */
export function startLibraryNumericalExecution(ticket:LibraryMetricTicket,initial:LibraryAnalysisControl,signal:AbortSignal,
  deps:LibraryNumericalExecutionDependencies):LibraryScheduledWork {
  signal.throwIfAborted();
  if(!(ticket.stage==="S"&&["numerical","timeline-pp","fc-pp"].includes(ticket.slot))||ticket.slot!=="numerical"&&!deps.metadata)throw new Error("Invalid numerical execution target");
  if(deps.metadata&&!deps.resources.publishNumerical)throw new Error("Numerical continuation resources are unavailable");
  const owned=new AbortController();let current={...initial},revision=0,worker:LibraryScheduledWork|undefined,settled=false;
  let activeTicket:LibraryMetricTicket|undefined=ticket,controlFailure:unknown,retirementFailure:unknown;
  let closing:Promise<void>|undefined;
  const closeResources=()=>closing??=Promise.resolve().then(()=>deps.resources.close());
  const abort=()=>{owned.abort(signal.reason);void closeResources().catch(()=>undefined);};
  signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
  const result=(async()=>{
    let metrics:LibraryMetricResult|undefined,failure:unknown;
    try {
      const prepared=deps.prepared??await deps.resources.openTarget(ticket,current,owned.signal);owned.signal.throwIfAborted();
      if(prepared.incidentEvidence!==undefined)validateLibraryIncidentEvidence(prepared.incidentEvidence,prepared.input.binding);
      const expected=ticket.slot==="timeline-pp"?libraryTimelineTarget({...prepared.target,replayId:prepared.replayId}):
        ticket.slot==="fc-pp"?libraryFcTarget({...prepared.target,replayId:prepared.replayId}):prepared.target;
      if(prepared.replayId!==ticket.replayId||(["slot","stage","inputKey","producerVersion"] as const).some(key=>expected[key]!==ticket[key]))
        throw new Error("Numerical handoff target mismatch");
      worker=deps.startWorker(ticket,prepared.input,current,owned.signal,(kind,offset,cancellation)=>deps.resources.read(kind,offset,cancellation),deps.metadata?async numerical=>{
        try{
          const publish=deps.resources.publishNumerical;if(!publish)throw new Error("Numerical publication unavailable");
          const next=await publish.call(deps.resources,numerical);activeTicket=deps.resources.metricTicket;return next;
        }catch(error){throw new LibraryHandoffFinalizationError(error);}
      }:undefined,deps.metadata&&deps.resources.publishTimeline?async outcome=>{
        try{
          const publish=deps.resources.publishTimeline;if(!publish)throw new Error("Timeline publication unavailable");
          const next=await publish.call(deps.resources,outcome);activeTicket=deps.resources.metricTicket;return next;
        }catch(error){throw new LibraryHandoffFinalizationError(error);}
      }:undefined,deps.metadata&&deps.resources.publishFc?async outcome=>{
        try{
          const publish=deps.resources.publishFc;if(!publish)throw new Error("FC publication unavailable");
          const next=await publish.call(deps.resources,outcome);activeTicket=deps.resources.metricTicket;return next;
        }catch(error){throw new LibraryHandoffFinalizationError(error);}
      }:undefined);
      try{metrics=await worker.result;}catch(error){
        // The client returns the owned abort reason only after clean drainage. A different
        // worker/termination/publication error must survive a concurrent or later shutdown.
        if(!owned.signal.aborted||error!==owned.signal.reason)retirementFailure=error;
        throw error;
      }owned.signal.throwIfAborted();
      await closeResources();owned.signal.throwIfAborted();
    }catch(error){failure=error;
    }finally {
      signal.removeEventListener("abort",abort);
      try{await closeResources();}catch(error){retirementFailure??=error;failure??=error;}finally{settled=true;}
      if(signal.aborted)failure??=signal.reason;
    }
    if(deps.metadata&&activeTicket&&!(failure instanceof LibraryHandoffFinalizationError)&&!(retirementFailure instanceof LibraryHandoffFinalizationError))try{
      if(signal.aborted&&!controlFailure&&!retirementFailure)await deps.metadata("metric-release",{ticket:activeTicket});
      else if(metrics&&!failure&&!controlFailure&&activeTicket.stage!=="C")await deps.metadata("metric-commit",{patch:{ticket:activeTicket,producerVersion:activeTicket.producerVersion,...metrics}});
      else{const error=controlFailure??retirementFailure??failure;await deps.metadata("metric-fail",{ticket:activeTicket,error:(error instanceof Error?error.message:"Numerical pipeline failed").slice(0,2048)});}
    }catch(error){throw new LibraryHandoffFinalizationError(error);}
    if(retirementFailure)throw retirementFailure;if(failure)throw failure;if(!metrics)throw new Error("Numerical pipeline produced no result");return metrics;
  })();
  return {result,managesPersistence:!!deps.metadata,eligible:()=>deps.resources.eligible?.()??Promise.resolve(true),control:async value=>{
    current={...value};const generation=++revision;
    if(settled)return"idle";
    try {
      let observed=worker;
      const resourceReply=closing?closing.then(()=>"idle" as const):deps.resources.control(value);
      const replies:LibraryYieldAcknowledgement[]=await Promise.all([resourceReply,observed?.control(value)??Promise.resolve("idle" as const)]);
      // Preparation may create the worker while a control awaits resources.
      let latest=worker;
      while(latest&&latest!==observed){observed=latest;replies[1]=await observed.control(current);latest=worker;}
      if(settled)return"idle";
      if(generation!==revision||replies.includes("superseded"))return"superseded";
      if(value.viewerDemand||value.userPaused){
        if(replies.some(reply=>reply!=="idle"&&reply!=="parked"))throw new Error("Numerical owners did not confirm yielding");
        return replies.every(reply=>reply==="idle")?"idle":"parked";
      }
      return replies.some(reply=>reply==="released")?"released":"idle";
    }catch(error){
      if(settled)return"idle";if(generation!==revision)return"superseded";
      // A main-owned abort rejects pending client controls with this exact object, before
      // actual drainage finishes. It is cancellation, not a new durable control failure.
      if(signal.aborted&&error===signal.reason)throw error;
      controlFailure=error;owned.abort(error);void closeResources().catch(()=>undefined);throw error;
    }
  }};
}
