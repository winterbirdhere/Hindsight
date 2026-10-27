import { startLibraryNumericalExecution, LibraryNumericalExecutionDependencies } from "./library-numerical-execution";
import type { LibraryMetricResult, LibraryMetricTicket } from "../../../../shared/replay-library-metrics";
import { libraryTimelineTarget } from "./library-timeline-target";
import { libraryFcTarget } from "./library-fc-target";
import { libraryIncidentTarget } from "./library-incidents-target";
import type { LibraryIncidentEvidenceReceipt } from "../../../../shared/library-incidents";
import { LibraryHandoffFinalizationError } from "./library-numerical-preparation";
const ticket:LibraryMetricTicket={replayId:"replay",slot:"numerical",stage:"S",inputKey:"e".repeat(64),producerVersion:"library-numeric-v1",generation:1,attempt:"attempt"};
const input={format:"resources" as const,replayBytes:3,mapBytes:3,binding:{replaySha256:"a".repeat(64),mapSha256:"b".repeat(64),mapMd5:"c".repeat(32),exactMapAndProfile:true}};
const prepared={replayId:"replay",input,target:{...ticket,slot:"numerical" as const,stage:"S" as const},origin:null,
  recipe:{version:1 as const,replaySha256:"a".repeat(64),fixedKey:"b".repeat(64),intrinsicNative:false,embeddedModsHash:null,
    legacyModsHash:"c".repeat(64),modeQualified:true,consumedModsSource:"legacy-mask" as const}};
const metrics:LibraryMetricResult={fields:{ur:{state:"known",value:10}},provenance:{producer:"fixture"}};
const evidence:LibraryIncidentEvidenceReceipt={version:1,state:"absent",replaySha256:"a".repeat(64),mapMd5:"c".repeat(32),validationVersion:"library-saved-evidence-v1"};
const free={viewerDemand:false,userPaused:false},held={viewerDemand:true,userPaused:false};
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){
  const work=deferred<LibraryMetricResult>();
  const resources={openTarget:jest.fn(async()=>prepared),
    read:jest.fn(async()=>({bytes:new Uint8Array([1,2,3]),done:true})),control:jest.fn(async()=>"parked" as const),close:jest.fn(async():Promise<void>=>undefined)};
  const worker={result:work.promise,control:jest.fn(async()=>"parked" as const)};
  const startWorker=jest.fn<ReturnType<LibraryNumericalExecutionDependencies["startWorker"]>,Parameters<LibraryNumericalExecutionDependencies["startWorker"]>>(()=>worker),abort=new AbortController();
  return{resources,worker,work,startWorker,abort,start:()=>startLibraryNumericalExecution(ticket,free,abort.signal,{resources,startWorker})};
}
it("rejects retired C execution before opening resources or starting a worker",()=>{
  const f=fixture(),incident={...libraryIncidentTarget(ticket,evidence),generation:4,attempt:"incidents"};
  expect(()=>startLibraryNumericalExecution(incident,free,f.abort.signal,{resources:f.resources,startWorker:f.startWorker})).toThrow(/Invalid numerical execution target/);
  expect(f.resources.openTarget).not.toHaveBeenCalled();expect(f.startWorker).not.toHaveBeenCalled();
});
it.each(["complete","cancelled","uncertain"])("drains terminal FC publication without starting another phase: %s",async outcome=>{
  const f=fixture(),fc={...libraryFcTarget(ticket),generation:3,attempt:"fc"};
  const receipt=deferred<boolean>(),drain=deferred<void>();let current:LibraryMetricTicket|undefined=fc;
  f.resources.close.mockImplementation(()=>drain.promise);
  const resources={...f.resources,metricTicket:current,publishNumerical:async()=>"fc" as const,publishTimeline:async()=>true,
    publishFc:async()=>{const next=await receipt.promise;current=undefined;return next;}};
  Object.defineProperty(resources,"metricTicket",{get:()=>current});const metadata=jest.fn(async()=>"applied");
  const task=startLibraryNumericalExecution(fc,free,f.abort.signal,{prepared,resources,startWorker:f.startWorker,metadata});
  const result=task.result.catch(error=>error);await turn();const publish=f.startWorker.mock.calls[0][7];if(!publish)throw Error("missing FC publisher");
  const pending=publish({metrics}),published=pending.catch(error=>error);if(outcome==="cancelled")f.abort.abort(Error("Off"));
  if(outcome==="uncertain"){receipt.reject(Error("lost FC receipt"));f.work.reject(await published);}else{receipt.resolve(false);expect(await pending).toBe(false);f.work.resolve(metrics);}
  await turn();expect(metadata).not.toHaveBeenCalled();drain.resolve();const final=await result;
  if(outcome==="uncertain")expect(final).toBeInstanceOf(LibraryHandoffFinalizationError);
  else if(outcome==="cancelled")expect(final).toEqual(Error("Off"));else expect(final).toEqual(metrics);
  expect(metadata).not.toHaveBeenCalled();
});
it.each(["complete","failed","cancelled"])("finalizes only the transferred timeline after numerical publication: %s",async outcome=>{
  const f=fixture(),next={...libraryTimelineTarget(ticket),generation:2,attempt:"timeline"};
  let current:LibraryMetricTicket|undefined=ticket;
  const resources={...f.resources,metricTicket:current,publishNumerical:jest.fn(async()=>{current=next;return true;})};
  Object.defineProperty(resources,"metricTicket",{get:()=>current});
  const metadata=jest.fn<Promise<string>,[string,Record<string,unknown>]>(async()=>"applied"),task=startLibraryNumericalExecution(ticket,free,f.abort.signal,{resources,startWorker:f.startWorker,metadata});
  const result=task.result.catch(error=>error);await turn();const publish=f.startWorker.mock.calls[0][5];if(!publish)throw Error("missing publication");
  expect(await publish(metrics)).toBe(true);expect(task.managesPersistence).toBe(true);
  if(outcome==="cancelled")f.abort.abort(Error("shutdown"));
  if(outcome==="failed")f.work.reject(Error("native failed"));else f.work.resolve({fields:{peakPp:{state:"known",value:100}},provenance:{}});
  await result;
  expect(metadata).toHaveBeenCalledTimes(1);
  expect(metadata.mock.calls[0][0]).toBe(outcome==="complete"?"metric-commit":outcome==="failed"?"metric-fail":"metric-release");
  expect(metadata.mock.calls[0][1]).toMatchObject(outcome==="complete"?{patch:{ticket:next}}:{ticket:next});
});
it("does not republish numerical when the dependent claim was cached or blocked",async()=>{
  const f=fixture(),resources={...f.resources,metricTicket:undefined,publishNumerical:async()=>false},metadata=jest.fn(async()=>"applied");
  const task=startLibraryNumericalExecution(ticket,free,f.abort.signal,{resources,startWorker:f.startWorker,metadata});await turn();
  const publish=f.startWorker.mock.calls[0][5];if(!publish)throw Error("missing publication");expect(await publish(metrics)).toBe(false);
  f.work.resolve(metrics);await task.result;expect(metadata).not.toHaveBeenCalled();
});
it("finalizes only FC after both intermediate publications transfer ownership",async()=>{
  const f=fixture(),timeline={...libraryTimelineTarget(ticket),generation:2,attempt:"timeline"},fc={...libraryFcTarget(ticket),generation:3,attempt:"fc"};
  let current:LibraryMetricTicket=ticket;
  const resources={...f.resources,metricTicket:current,publishNumerical:async()=>{current=timeline;return true;},publishTimeline:async()=>{current=fc;return true;}};
  Object.defineProperty(resources,"metricTicket",{get:()=>current});const metadata=jest.fn<Promise<string>,[string,Record<string,unknown>]>(async()=>"applied");
  const task=startLibraryNumericalExecution(ticket,free,f.abort.signal,{resources,startWorker:f.startWorker,metadata});await turn();
  const [,,,,,publishNumerical,publishTimeline]=f.startWorker.mock.calls[0];if(!publishNumerical||!publishTimeline)throw Error("missing continuation");
  await publishNumerical(metrics);await publishTimeline({error:"timeline size"});
  f.work.resolve({fields:{ppIfFc:{state:"known",value:2}},provenance:{}});await task.result;
  expect(metadata).toHaveBeenCalledTimes(1);expect(metadata.mock.calls[0][1]).toMatchObject({patch:{ticket:fc}});
});
it("waits for both owners' hold acknowledgements and drains resources before publishing results",async()=>{
  const f=fixture(),task=f.start();await turn();const resourceHold=deferred<"parked">(),workerHold=deferred<"parked">();
  f.resources.control.mockImplementation(()=>resourceHold.promise);f.worker.control.mockImplementation(()=>workerHold.promise);
  let acknowledged=false;const hold=task.control(held).then(value=>{acknowledged=true;return value;});
  workerHold.resolve("parked");await turn();expect(acknowledged).toBe(false);
  resourceHold.resolve("parked");expect(await hold).toBe("parked");
  const drain=deferred<void>();f.resources.close.mockImplementation(()=>drain.promise);let published=false;
  const result=task.result.then(value=>{published=true;return value;});f.work.resolve(metrics);await turn();expect(published).toBe(false);
  drain.resolve();expect(await result).toEqual(metrics);expect(f.startWorker).toHaveBeenCalledTimes(1);
});
it("consumes an existing prepared owner without reopening and rejects a mismatched handoff",async()=>{
  const f=fixture(),task=startLibraryNumericalExecution(ticket,free,f.abort.signal,{resources:f.resources,startWorker:f.startWorker,prepared});
  await turn();expect(f.resources.openTarget).not.toHaveBeenCalled();f.work.resolve(metrics);expect(await task.result).toEqual(metrics);
  const wrong=fixture();await expect(startLibraryNumericalExecution(ticket,free,wrong.abort.signal,{resources:wrong.resources,startWorker:wrong.startWorker,
    prepared:{...prepared,target:{...prepared.target,inputKey:"f".repeat(64)}}}).result).rejects.toThrow(/handoff/i);
  expect(wrong.startWorker).not.toHaveBeenCalled();expect(wrong.resources.close).toHaveBeenCalledTimes(1);
});
it("cancels preparation without creating a worker and waits for the resource owner",async()=>{
  const f=fixture(),opened=deferred<Awaited<ReturnType<typeof f.resources.openTarget>>>(),drain=deferred<void>();
  f.resources.openTarget.mockImplementation(()=>opened.promise);f.resources.close.mockImplementation(async()=>{opened.reject(new Error("cancelled"));await drain.promise;});
  const task=f.start();let settled=false;const result=task.result.catch(error=>{settled=true;return error;});await turn();f.abort.abort();await turn();
  expect(settled).toBe(false);expect(f.startWorker).not.toHaveBeenCalled();drain.resolve();await result;expect(settled).toBe(true);
});
it("starts a delayed worker with the newest hold and fences cancellation before publication",async()=>{
  const f=fixture(),opened=deferred<Awaited<ReturnType<typeof f.resources.openTarget>>>();f.resources.openTarget.mockImplementation(()=>opened.promise);
  const task=f.start();await task.control(held);opened.resolve(prepared);await turn();
  expect(f.startWorker.mock.calls[0]?.[2]).toEqual(held);
  f.abort.abort();f.work.resolve(metrics);await expect(task.result).rejects.toMatchObject({name:"AbortError"});
});

it("ignores a superseded hold failure after a newer release succeeds",async()=>{
  const f=fixture(),task=f.start();await turn();const old=deferred<"parked">();
  f.resources.control.mockImplementationOnce(()=>old.promise);
  const prior=task.control(held);await task.control(free);old.reject(new Error("old hold failed"));
  expect(await prior).toBe("superseded");expect(f.startWorker.mock.calls[0][3].aborted).toBe(false);
  f.work.resolve(metrics);expect(await task.result).toEqual(metrics);
});

it.each([false,true])("releases only after actual drains when an owned abort rejects pending control, transferred timeline=%s",async transferred=>{
  const f=fixture(),control=deferred<"parked">(),drain=deferred<void>(),reason=new Error("planned owner retirement");
  f.worker.control.mockImplementation(()=>control.promise);f.resources.close.mockImplementation(()=>drain.promise);
  let active=ticket;const next={...libraryTimelineTarget(ticket),generation:3,attempt:"transferred"};
  const resources={...f.resources,metricTicket:active,publishNumerical:async()=>{active=next;return true;}};
  Object.defineProperty(resources,"metricTicket",{get:()=>active});
  const metadata=jest.fn(async()=>"applied"),task=startLibraryNumericalExecution(ticket,free,f.abort.signal,{resources,startWorker:f.startWorker,metadata});
  let settled=false;const outcome=task.result.catch(error=>{settled=true;return error;});await turn();
  if(transferred){const publish=f.startWorker.mock.calls[0][5];if(!publish)throw Error("missing publisher");await publish(metrics);}
  const pending=task.control(held).catch(error=>error);f.abort.abort(reason);
  expect(f.startWorker.mock.calls[0][3].reason).toBe(reason);control.reject(reason);expect(await pending).toBe(reason);
  expect(metadata).not.toHaveBeenCalled();expect(settled).toBe(false);f.work.reject(reason);await turn();
  expect(metadata).not.toHaveBeenCalled();expect(settled).toBe(false);drain.resolve();expect(await outcome).toBe(reason);
  expect(metadata.mock.calls).toEqual([["metric-release",{ticket:transferred?next:ticket}]]);
});

it.each(["prior-control","different-control","prior-worker","uncertain-worker","failed-resource-close"])("retains a real failure through owner abort: %s",async kind=>{
  const f=fixture(),control=deferred<"parked">(),drain=deferred<void>(),reason=new Error("planned owner retirement");
  const failure=new Error(kind==="different-control"?reason.message:"unconfirmed "+kind);
  f.worker.control.mockImplementation(()=>control.promise);f.resources.close.mockImplementation(()=>drain.promise);
  const resources={...f.resources,publishNumerical:async()=>false},metadata=jest.fn(async()=>"applied");
  const task=startLibraryNumericalExecution(ticket,free,f.abort.signal,{resources,startWorker:f.startWorker,metadata}),outcome=task.result.catch(error=>error);await turn();
  const pending=task.control(held).catch(error=>error);
  if(kind==="prior-worker"){f.work.reject(failure);await turn();}
  if(kind==="prior-control"){control.reject(failure);expect(await pending).toBe(failure);f.abort.abort(failure);}
  else{f.abort.abort(kind==="prior-worker"?failure:reason);control.reject(kind==="different-control"?failure:f.abort.signal.reason);await pending;}
  if(kind!=="prior-worker")f.work.reject(kind==="uncertain-worker"?failure:f.abort.signal.reason);await turn();expect(metadata).not.toHaveBeenCalled();
  if(kind==="failed-resource-close")drain.reject(failure);else drain.resolve();await outcome;
  expect(metadata.mock.calls).toEqual([["metric-fail",{ticket,error:failure.message}]]);
});
