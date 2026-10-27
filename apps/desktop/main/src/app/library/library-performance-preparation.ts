import { randomUUID } from "crypto";
import type { LibraryOperation } from "./library-process-client";
import type { LibraryResourceOperation } from "./library-resource-server";
import type { LibraryPreparationTicket,LibraryPreparedResult } from "./library-preparation-store";
import type { LibraryPreparedWork } from "./library-numerical-preparation";
import type { LibrarySchedulerControl } from "./library-scheduler";
import type { LibraryAnalysisLease,LibraryLocationCursor,LibraryOpenLocation,LibraryOpenMap,LibraryLocationRefreshResult } from "./library-store";
import type { LibraryPerformanceContext,LibraryPerformanceConsumedOrigin } from "./library-performance-context";
import type { LibraryPerformanceScoreEvidence } from "./library-performance-score";
import { produceLibraryPerformance,LibraryPerformanceMapDescriptor,LibraryPerformanceProducerPorts } from "./library-performance-producer";
import { performanceMapMd5,validLibraryTempoUnavailableReason } from "./library-performance-map-resource";

export interface LibraryPerformancePreparationDependencies {
  metadata(method:LibraryOperation,args?:Record<string,unknown>):Promise<unknown>;
  resources:{request(method:LibraryResourceOperation,args?:Record<string,unknown>):Promise<unknown>;close():Promise<void>};
  produce?:typeof produceLibraryPerformance;
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
/** One reservation owns all P phases and its independent resource utility. Cache results survive
 * yielding; publication follows actual utility/native drainage, with no second metric claim. */
export function startLibraryPerformancePreparation(ticket:LibraryPreparationTicket,initial:LibrarySchedulerControl,signal:AbortSignal,
  deps:LibraryPerformancePreparationDependencies):LibraryPreparedWork {
  signal.throwIfAborted();if(ticket.stage!=="P")throw new Error("Invalid performance preparation stage");
  let closing:Promise<void>|undefined,settled=false,revision=0,controlFailure:unknown;
  let location:LibraryOpenLocation|undefined,mapTicket:LibraryOpenMap|undefined,scoreLocation:LibraryOpenLocation|undefined;
  let pendingLocation:LibraryOpenLocation|undefined,pendingMap:LibraryOpenMap|undefined,pendingScore:LibraryOpenLocation|undefined,lastMapFailure:string|undefined;
  let sessionId:string|undefined,descriptor:LibraryPerformanceMapDescriptor|undefined;
  const close=()=>closing??=(async()=>{await deps.resources.close();})();
  const check=()=>{signal.throwIfAborted();if(controlFailure)throw controlFailure;if(closing)throw new Error("Performance resources closed");};
  const cancel=()=>{void close().catch(()=>undefined);};signal.addEventListener("abort",cancel,{once:true});if(signal.aborted)cancel();
  const control:LibraryPreparedWork["control"]=async value=>{
    const generation=++revision;if(closing){await closing;return"idle";}if(settled)return"idle";
    try{
      const result=await deps.resources.request("control",{...value});if(settled)return"idle";if(generation!==revision)return"superseded";
      if(!["idle","parked","released"].includes(String(result))||(value.viewerDemand||value.userPaused)&&result!=="idle"&&result!=="parked")
        throw new Error("Performance resources did not confirm current control");
      return result as "idle"|"parked"|"released";
    }catch(error){if(settled)return"idle";if(generation!==revision)return"superseded";controlFailure=error;void close().catch(()=>undefined);throw error;}
  };
  async function* pages<T>(method:"prepare-open"|"prepare-map",args:Record<string,unknown>):AsyncGenerator<T> {
    let after:LibraryLocationCursor|undefined,total=0;
    do{
      check();const page=await deps.metadata(method,{...args,limit:8,...(after?{after}:{})}) as {items:T[];next?:LibraryLocationCursor};check();
      if(!page||!Array.isArray(page.items)||page.items.length>8||total+page.items.length>256||page.next&&!page.items.length)
        throw new Error("Performance candidate budget or page invalid");
      total+=page.items.length;for(const item of page.items){check();yield item;}after=page.next;
      if(after&&total>=256)throw new Error("Performance candidate budget exceeded");
    }while(after);
  }
  async function tryMap(candidate:LibraryOpenLocation,map?:LibraryOpenMap):Promise<boolean> {
    check();const id=randomUUID();pendingLocation=candidate;pendingMap=map;
    try{
      const value=await deps.resources.request("begin-performance",{sessionId:id,ticket:candidate,...(map?{candidate:map}:{})});check();
      if(!record(value)||value.sessionId!==id||typeof value.md5!=="string"||value.md5!==performanceMapMd5(candidate)||
        typeof value.sha256!=="string"||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.bytes)||Number(value.bytes)<1||Number(value.bytes)>16*1024*1024||
        !Number.isInteger(value.ruleset)||Number(value.ruleset)<0||Number(value.ruleset)>3||
        value.baseBpm!==null&&(typeof value.baseBpm!=="number"||!Number.isFinite(value.baseBpm)||value.baseBpm<=0)||
        value.tempoUnavailableReason!==undefined&&(value.baseBpm!==null||!validLibraryTempoUnavailableReason(value.tempoUnavailableReason)))throw new Error("Invalid performance map descriptor");
      location=candidate;mapTicket=map;sessionId=id;
      descriptor={md5:value.md5,sha256:value.sha256,ruleset:Number(value.ruleset),baseBpm:value.baseBpm as number|null,
        ...(validLibraryTempoUnavailableReason(value.tempoUnavailableReason)?{tempoUnavailableReason:value.tempoUnavailableReason}:{})};return true;
    }catch(error){check();lastMapFailure=(error instanceof Error?error.message:"Unknown map read failure").slice(0,1024);
      await deps.resources.request("release",{sessionId:id});check();return false;
    }finally{pendingLocation=undefined;pendingMap=undefined;}
  }
  async function prepareMap(context:LibraryPerformanceContext):Promise<void> {
    let first:LibraryOpenLocation|undefined;
    for await(const candidate of pages<LibraryOpenLocation>("prepare-open",{replayId:ticket.replayId})){
      let md5:string;try{md5=performanceMapMd5(candidate);}catch{continue;}if(md5!==context.mapMd5)continue;
      first??=candidate;
      if(candidate.kind==="lazer"&&await tryMap(candidate))return;
    }
    if(first)for await(const candidate of pages<LibraryOpenMap>("prepare-map",{md5:context.mapMd5}))if(await tryMap(first,candidate))return;
    throw new Error("Exact library map is unavailable for performance calculation"+(lastMapFailure?": "+lastMapFailure:""));
  }
  async function prepareScore(context:LibraryPerformanceContext):Promise<LibraryPerformanceScoreEvidence> {
    const evidence={...context.evidence};
    if(!context.replaySha256||!(evidence.nativeRequired||evidence.embeddedRequired||evidence.origin==="lazer"||(evidence.header?.version??0)>=30000000))return evidence;
    let invalid=false;
    for await(const candidate of pages<LibraryOpenLocation>("prepare-open",{replayId:ticket.replayId})){
      if(candidate.sha256!==context.replaySha256)continue;
      let value:LibraryPerformanceScoreEvidence;pendingScore=candidate;
      try{value=await deps.resources.request("performance-score",{sessionId,candidate:{...candidate,...(evidence.nativeRequired?{analysisRequiresNative:true}:{})}}) as LibraryPerformanceScoreEvidence;check();}
      finally{pendingScore=undefined;}
      if(!value||!value.trailerStatus)throw new Error("Invalid performance score descriptor");
      if(value.trailerStatus==="invalid"){invalid=true;continue;}if(value.trailerStatus==="unavailable")continue;
      if(value.origin!==evidence.origin)throw new Error("Performance recording origin changed");
      scoreLocation=candidate;return{...evidence,trailerStatus:value.trailerStatus,...(value.trailer?{trailer:value.trailer}:{})};
    }
    return{...evidence,trailerStatus:invalid?"invalid":"unavailable"};
  }
  const result=(async()=>{
    let context:LibraryPerformanceContext|undefined,evidence:LibraryPerformanceScoreEvidence|undefined,results:LibraryPreparedResult[]|undefined;
    try{
      await control(initial);check();context=await deps.metadata("performance-context",{ticket}) as LibraryPerformanceContext;check();
      if(!context||!context.mapMd5)throw new Error("Library performance map identity is unavailable or conflicting");
      await prepareMap(context);evidence=await prepareScore(context);check();
      const ports:LibraryPerformanceProducerPorts={
        mapCache:{get:(inputKey,mode)=>deps.metadata("performance-cache-get",{inputKey,mode}) as ReturnType<LibraryPerformanceProducerPorts["mapCache"]["get"]>,
          put:async(inputKey,mode,value)=>{check();await deps.metadata("performance-cache-put",{inputKey,mode,value});}},
        scalarCache:{get:(inputKey,mode)=>deps.metadata("performance-scalar-get",{inputKey,mode}) as Promise<number|undefined>,
          put:async(inputKey,mode,value)=>{check();await deps.metadata("performance-scalar-put",{inputKey,mode,value});}},
        calculate:calculations=>{check();return deps.resources.request("calculate-performance",{sessionId,calculations});}};
      if(!descriptor)throw new Error("Performance map descriptor missing");
      results=await (deps.produce??produceLibraryPerformance)(descriptor,evidence,ports,signal);check();
    }finally{try{await close();}finally{settled=true;signal.removeEventListener("abort",cancel);}}
    signal.throwIfAborted();if(controlFailure)throw controlFailure;
    if(!context||!evidence||!results||!descriptor||!location)throw new Error("Performance preparation incomplete");
    const origin:LibraryPerformanceConsumedOrigin=evidence.origin==="unknown"?{client:"unknown",provenance:"unavailable"}
      :evidence.origin?{client:evidence.origin,provenance:"user-confirmed"}:null;
    const publication=await deps.metadata("performance-commit",{ticket,location,map:{md5:descriptor.md5,sha256:descriptor.sha256,...(mapTicket?{ticket:mapTicket}:{})},
      results:results.map(value=>({...value,provenance:{...value.provenance,...(context.replaySha256?{replaySha256:context.replaySha256}:{sourceOnly:true})}})),
      origin,embeddedRequired:!!evidence.trailer,...(scoreLocation?{scoreLocation}:{})}) as LibraryLocationRefreshResult;
    if(publication?.state==="stale"||publication?.state==="source-disabled")await deps.metadata("preparation-release",{ticket});
    else if(publication?.state!=="applied")throw new Error("Invalid performance publication result");
  })();
  return{result,control,eligible:async()=>{
    const activeLocation=pendingLocation??location,activeMap=pendingMap??mapTicket,activeScore=pendingScore??scoreLocation;
    const lease:LibraryAnalysisLease={kind:"preparation",ticket,...(activeLocation?{location:activeLocation}:{}),...(activeMap?{map:activeMap}:{}),...(activeScore?{score:activeScore}:{})};
    const eligible=await deps.metadata("analysis-eligible",{lease});if(typeof eligible!=="boolean")throw new Error("Invalid P eligibility response");return eligible;
  }};
}
