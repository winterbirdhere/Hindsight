import { PERFORMANCE_ENGINE_VERSION, PerformanceResponse } from "@rewind/osu-performance/protocol";
import type { ReplayPerformanceInput } from "@rewind/osu-performance/types";
import type { LibraryCompletion, LibraryMetricResult } from "../../../../../shared/replay-library-metrics";
import { performanceMetrics } from "./library-metrics";
import { LIBRARY_TIMELINE_PROJECTION_VERSION } from "../../../../../shared/library-analysis";
const finite=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value)&&value>=0;
const close=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-7,Math.abs(b)*1e-7);

/** Validated scalar projection only. Native endpoints describe mathematical coverage, never a pass. */
export async function projectLibraryTimeline(input:ReplayPerformanceInput,response:PerformanceResponse,objectCount:number,
  numerical:LibraryMetricResult,checkpoint:()=>Promise<void>):Promise<LibraryMetricResult> {
  await checkpoint();
  if(!Number.isSafeInteger(objectCount)||objectCount<0||objectCount>100000||!Array.isArray(input.states)||input.states.length>100001||
    response?.ok!==true||response.engineVersion!==PERFORMANCE_ENGINE_VERSION||response.timelines?.length!==1)
    throw new Error("Incompatible library timeline envelope");
  const timeline=response.timelines[0],last=input.states[input.states.length-1];
  const complete=objectCount>0&&last?.passedObjects===objectCount;
  if(!timeline||timeline.error||timeline.mode!==input.mode||timeline.objectCount!==objectCount||timeline.fullMap!==undefined||
    timeline.endpointVerified!==complete||!Array.isArray(timeline.points)||timeline.points.length!==input.states.length)
    throw new Error("Incompatible library timeline coverage");
  let peak:number|undefined,previousTime=-Infinity,previousCount=0;
  for(let i=0;i<input.states.length;i++){
    if(i%256===0)await checkpoint();const state=input.states[i],point=timeline.points[i];
    if(!state||!Number.isFinite(state.time)||state.time<previousTime||!Number.isSafeInteger(state.passedObjects)||
      state.passedObjects<previousCount||state.passedObjects>objectCount||!point||point.time!==state.time||!finite(point.pp)||!finite(point.sr))
      throw new Error("Invalid library timeline point");
    previousTime=state.time;previousCount=state.passedObjects;
    // Native emits a synthetic zero for an empty prefix, without calculating PP.
    if(state.passedObjects>0)peak=peak===undefined?point.pp:Math.max(peak,point.pp);
  }
  const final=timeline.final;
  if(input.states.length&&(!final||!finite(final.pp)||!finite(final.sr)||!close(final.pp,timeline.points[timeline.points.length-1].pp)))
    throw new Error("Invalid library timeline endpoint");
  const observed=numerical.fields.completion,qualified=numerical.provenance.coverageQualified===true;
  const completion:LibraryCompletion=qualified&&observed?.state==="known"&&(observed.value==="passed"||observed.value==="failed")
    ?{state:"known",value:observed.value}:{state:"unknown",reason:"completion-not-established"};
  const values=performanceMetrics(completion,{pp:qualified&&complete&&peak!==undefined?final?.pp:undefined,peakPp:qualified?peak:undefined});
  return{provenance:{replaySha256:numerical.provenance.replaySha256,mapSha256:numerical.provenance.mapSha256,
    mapMd5:numerical.provenance.mapMd5,ruleset:input.mode,coverageQualified:qualified,
    projectionVersion:LIBRARY_TIMELINE_PROJECTION_VERSION,engineVersion:PERFORMANCE_ENGINE_VERSION,scoreOrigin:"reconstructed"},
    fields:{pp:values.pp,peakPp:values.peakPp}};
}
