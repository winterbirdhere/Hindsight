import type { PerformanceRequest,PerformanceResponse } from "@rewind/osu-performance/protocol";
import { PerformanceWorker } from "../performance-worker";
import { LibraryNativeAdmission, LibraryNativeDrainError, LibraryNativePhase } from "./library-native-admission";

type Worker=Pick<PerformanceWorker,"calculate"|"cancel"|"disposeAndDrain">;
/** One independent library helper per compact phase. The viewer's PerformanceWorker is never touched.
 * Native permit release follows actual helper close, including on abort or malformed response. */
export async function calculateLibraryPerformance(executable:()=>string,admission:LibraryNativeAdmission,request:PerformanceRequest,
  signal?:AbortSignal,create:(executable:()=>string)=>Worker=path=>new PerformanceWorker(path,{background:true})):Promise<PerformanceResponse> {
  if(!request||!Array.isArray(request.calculations)||request.calculations.length<1||request.calculations.length>3||
    request.calculations.some(item=>item.scope!=="full-map"||!Array.isArray(item.states)||item.states.length>1))
    throw new Error("Library P requires bounded full-map calculations");
  return calculateOwned(executable,admission,"map-performance",request,signal,create);
}
/** S retains every prefix. Size failure never silently downsamples away a possible peak. */
export async function calculateLibraryTimeline(executable:()=>string,admission:LibraryNativeAdmission,request:PerformanceRequest,
  signal?:AbortSignal,create:(executable:()=>string)=>Worker=path=>new PerformanceWorker(path,{background:true})):Promise<PerformanceResponse> {
  signal?.throwIfAborted();
  if(!request||typeof request.beatmap!=="string"||!Array.isArray(request.calculations)||request.calculations.length!==1||
    request.calculations.some(item=>item.scope!==undefined||!Array.isArray(item.states)||item.states.length>100001))
    throw new Error("Library S requires one bounded timeline calculation");
  if(Buffer.byteLength(JSON.stringify(request))>32*1024*1024)throw new Error("Library timeline input is too large");
  return calculateOwned(executable,admission,"timeline-performance",request,signal,create);
}
function calculateOwned(executable:()=>string,admission:LibraryNativeAdmission,phase:LibraryNativePhase,request:PerformanceRequest,
  signal:AbortSignal|undefined,create:(executable:()=>string)=>Worker):Promise<PerformanceResponse> {
  return admission.run(phase,async()=>{
    signal?.throwIfAborted();const worker=create(executable),abort=()=>worker.cancel(1);
    signal?.addEventListener("abort",abort,{once:true});let outcome:{response:PerformanceResponse}|{error:unknown};
    try {const pending=worker.calculate(1,request);if(signal?.aborted)abort();outcome={response:await pending};}
    catch(error){outcome={error};}finally {signal?.removeEventListener("abort",abort);}
    try{await worker.disposeAndDrain();}
    catch(error){throw new LibraryNativeDrainError(error instanceof Error?error.message:"Performance helper exit not confirmed");}
    if("error"in outcome)throw outcome.error;
    signal?.throwIfAborted();return outcome.response;
  },signal);
}
