import { randomUUID } from "crypto";
import type { LibraryYieldAcknowledgement } from "../../../../shared/library-analysis-gate";
import type { LibraryPreparationTicket } from "./library-preparation-store";
import type { LibraryPreparedWork } from "./library-numerical-preparation";
import { LibraryHandoffFinalizationError } from "./library-numerical-preparation";
import type { LibrarySchedulerControl } from "./library-scheduler";
import type { LibraryIncidentEvidenceProbe } from "./library-incidents-probe";
import { LibraryIncidentVerificationDependencies,LibraryIncidentProbeContext,
  validateLibraryIncidentProbeContext,validateLibraryIncidentProbeResponse } from "./library-incidents-verification";

export type LibraryIncidentPreparationDependencies=LibraryIncidentVerificationDependencies;

/** Reattests only optional C evidence under one durable preparation reservation. It never
 * opens numerical resources or creates a worker. Store decides whether the C key changed. */
export function startLibraryIncidentPreparation(ticket:LibraryPreparationTicket,initial:LibrarySchedulerControl,signal:AbortSignal,
  deps:LibraryIncidentPreparationDependencies):LibraryPreparedWork {
  signal.throwIfAborted();if(ticket.stage!=="C")throw new Error("Invalid incident preparation stage");
  const resources=deps.createResources(),sessionId=randomUUID();
  let closing:Promise<void>|undefined,settled=false,revision=0,controlFailure:unknown,selected:LibraryIncidentProbeContext|undefined;
  const close=()=>closing??=Promise.resolve().then(()=>resources.close());
  const cancel=()=>{void close().catch(()=>undefined);};signal.addEventListener("abort",cancel,{once:true});if(signal.aborted)cancel();
  const check=()=>{signal.throwIfAborted();if(controlFailure)throw controlFailure;};
  const control:LibraryPreparedWork["control"]=async value=>{
    const generation=++revision;if(closing){await closing;return"idle";}if(settled)return"idle";
    try{
      const reply=await resources.request("control",{...value});if(settled)return"idle";if(generation!==revision)return"superseded";
      if(!["idle","parked","released","superseded"].includes(String(reply))||
        (value.viewerDemand||value.userPaused)&&!["idle","parked","superseded"].includes(String(reply)))
        throw new Error("Incident preparation resources did not confirm current control");
      return reply as LibraryYieldAcknowledgement;
    }catch(error){
      if(settled)return"idle";if(generation!==revision)return"superseded";controlFailure=error;
      void close().catch(()=>undefined);throw error;
    }
  };
  const result=(async()=>{
    let value:LibraryIncidentEvidenceProbe|undefined,failure:unknown,failed=false;
    try{
      await control(initial);check();
      selected=validateLibraryIncidentProbeContext(await deps.metadata("incident-preparation-context",{ticket}),ticket);check();
      value=validateLibraryIncidentProbeResponse(await resources.request("probe-incident-evidence",{sessionId,ticket:selected.location}),selected);check();
    }catch(error){failure=signal.aborted?signal.reason:controlFailure??error;failed=true;}
    finally{try{await close();}catch(error){if(!failed)failure=error;failed=true;}}
    try{
      if(failed)throw failure;check();if(!selected||!value)throw new Error("Incident preparation produced no probe");
      try{
        const receipt=await deps.metadata("incident-preparation-commit",{ticket,location:selected.location,probe:value});
        if(receipt!=="applied"&&receipt!=="stale")throw new Error("Invalid incident preparation commit receipt");
      }catch(error){throw new LibraryHandoffFinalizationError(error);}
      // A confirmed mutation receipt remains authoritative if cancellation arrived in flight.
    }finally{signal.removeEventListener("abort",cancel);settled=true;}
  })();
  return{result,control,eligible:async()=>{
    const lease={kind:"preparation",ticket,...(selected?{location:{sourceId:selected.location.sourceId,sourceConfigRevision:selected.location.sourceConfigRevision}}:{})};
    const eligible=await deps.metadata("analysis-eligible",{lease});
    if(typeof eligible!=="boolean")throw new Error("Invalid incident preparation eligibility response");return eligible;
  }};
}
