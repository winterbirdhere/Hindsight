import type { PerformanceMode } from "./types";
import { PERFORMANCE_ENGINE_VERSION } from "./protocol";
const int32=(v:unknown):v is number=>typeof v==="number"&&Number.isInteger(v)&&v>=0&&v<=2147483647;
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v)&&v>=0;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
/** An overall successful engine envelope may contain a failed or partial calculation. */
export function readAggregatePerformanceResult(response:unknown,expected:{mode:PerformanceMode;objectCount:number;time:number}):
  {state:"known";value:number}|{state:"unknown";reason:string} {
  const unavailable=()=>({state:"unknown" as const,reason:"aggregate-performance-unavailable"});
  if(!int32(expected.objectCount)||expected.objectCount===0||!Number.isFinite(expected.time)||!record(response)||
    response.ok!==true||response.engineVersion!==PERFORMANCE_ENGINE_VERSION||!Array.isArray(response.timelines)||response.timelines.length!==1)return unavailable();
  const timeline=response.timelines[0];
  if(!record(timeline)||timeline.mode!==expected.mode||timeline.error!=null||timeline.objectCount!==expected.objectCount||
    timeline.endpointVerified!==true||!Array.isArray(timeline.points)||timeline.points.length!==1||!record(timeline.final))return unavailable();
  const point=timeline.points[0];
  if(!record(point)||point.time!==expected.time||!finite(point.pp)||!finite(point.sr)||!finite(timeline.final.pp)||!finite(timeline.final.sr)||
    Math.abs(point.pp-timeline.final.pp)>Math.max(1e-8,Math.abs(timeline.final.pp)*1e-10))return unavailable();
  return{state:"known",value:timeline.final.pp};
}
