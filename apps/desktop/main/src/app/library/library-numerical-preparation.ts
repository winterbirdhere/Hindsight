import type { LibraryPreparationTicket } from "./library-preparation-store";
import type { LibraryNumericalResources } from "./library-numerical-resources";
import type { LibraryOperation } from "./library-process-client";
import type { LibraryScheduledWork, LibrarySchedulerControl } from "./library-scheduler";
import { startLibraryNumericalExecution, LibraryNumericalExecutionDependencies } from "./library-numerical-execution";

export interface LibraryNumericalPreparationDependencies {
  resources:Pick<LibraryNumericalResources,"open"|"openTarget"|"handoff"|"read"|"control"|"close">&Partial<Pick<LibraryNumericalResources,"eligible"|"publishNumerical"|"publishTimeline"|"publishFc"|"metricTicket">>;
  metadata(method:LibraryOperation,args:Record<string,unknown>):Promise<unknown>;
  startWorker:LibraryNumericalExecutionDependencies["startWorker"];
  timeline?:boolean;
}
export interface LibraryPreparedWork {result:Promise<void>;control:LibraryScheduledWork["control"];eligible?:LibraryScheduledWork["eligible"]}
export class LibraryHandoffFinalizationError extends Error {
  constructor(cause:unknown){super("Numerical handoff persistence failed: "+(cause instanceof Error?cause.message:String(cause)));this.name="LibraryHandoffFinalizationError";}
}
/** Holds one scheduler reservation across preparation, exact claim, computation and persistence.
 * The durable metric ticket, once claimed, is released/finalized here before preparation settles. */
export function startLibraryNumericalPreparation(ticket:LibraryPreparationTicket,initial:LibrarySchedulerControl,signal:AbortSignal,
  deps:LibraryNumericalPreparationDependencies):LibraryPreparedWork {
  signal.throwIfAborted();if(ticket.stage!=="S")throw new Error("Invalid numerical preparation stage");
  const abort=new AbortController();let current={...initial},execution:LibraryScheduledWork|undefined,settled=false,revision=0,controlFailure:unknown,retirementFailure:unknown;
  const cancel=()=>{abort.abort(signal.reason);void deps.resources.close().catch(()=>undefined);};
  signal.addEventListener("abort",cancel,{once:true});if(signal.aborted)cancel();
  const result=(async()=>{
    let failure:unknown,failed=false,metrics:Awaited<LibraryScheduledWork["result"]>|undefined;
    try{
      const prepared=await deps.resources.open(ticket,current,abort.signal,true);abort.signal.throwIfAborted();
      const handoff=deps.resources.handoff;
      if(!handoff||handoff.state==="stale")throw new Error("Prepared numerical handoff is stale");
      if(handoff.state==="claimed"){
        execution=startLibraryNumericalExecution(handoff.ticket,current,abort.signal,{resources:deps.resources,startWorker:deps.startWorker,prepared,
          ...(deps.timeline?{metadata:deps.metadata}:{})});
        try{metrics=await execution.result;}catch(error){
          if(!abort.signal.aborted||error!==abort.signal.reason)retirementFailure=error;
          throw error;
        }abort.signal.throwIfAborted();
      }
    }catch(error){failure=error;failed=true;}
    finally{
      try{await deps.resources.close();}catch(error){retirementFailure??=error;failure=error;failed=true;}
      signal.removeEventListener("abort",cancel);settled=true;
    }
    const handoff=deps.resources.handoff;
    if(handoff?.state==="claimed"&&!execution?.managesPersistence){
      try{
        if(signal.aborted&&!controlFailure&&!retirementFailure)await deps.metadata("metric-release",{ticket:handoff.ticket});
        else if(metrics&&!failed&&!controlFailure)await deps.metadata("metric-commit",{patch:{ticket:handoff.ticket,producerVersion:handoff.ticket.producerVersion,...metrics}});
        else{const error=controlFailure??retirementFailure??failure;await deps.metadata("metric-fail",{ticket:handoff.ticket,error:(error instanceof Error?error.message:"Numerical preparation failed").slice(0,2048)});}
      }catch(error){throw new LibraryHandoffFinalizationError(error);}
    }
    if(retirementFailure)throw retirementFailure;if(failed)throw failure;abort.signal.throwIfAborted();
  })();
  return{result,eligible:()=>deps.resources.eligible?.()??Promise.resolve(true),control:async value=>{
    current={...value};const generation=++revision;if(settled)return"idle";
    try{
      const observed=execution;
      let reply=await (observed?observed.control(value):deps.resources.control(value));
      if(execution&&execution!==observed)reply=await execution.control(current);
      if(settled)return"idle";if(generation!==revision)return"superseded";
      if((value.viewerDemand||value.userPaused)&&reply!=="idle"&&reply!=="parked"&&reply!=="superseded")throw new Error("Preparation did not confirm yielding");
      return reply;
    }catch(error){if(settled)return"idle";if(generation!==revision)return"superseded";
      // Only the exact owned abort has main-process causal identity. Serialized RPC errors
      // are distinct objects and remain failures, even when their text happens to match.
      if(signal.aborted&&error===signal.reason)throw error;
      controlFailure=error;abort.abort(error);void deps.resources.close().catch(()=>undefined);throw error;}
  }};
}
