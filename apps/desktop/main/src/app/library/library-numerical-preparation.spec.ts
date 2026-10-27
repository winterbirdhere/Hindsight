import { startLibraryNumericalPreparation } from "./library-numerical-preparation";
import type { LibraryMetricResult, LibraryMetricTicket } from "../../../../shared/replay-library-metrics";
import type { LibraryPreparationTicket } from "./library-preparation-store";
import type { LibraryMetricHandoff } from "./library-metric-store";
import type { LibraryNumericalExecutionDependencies } from "./library-numerical-execution";
import { libraryIncidentTarget } from "./library-incidents-target";
import type { LibraryIncidentEvidenceReceipt } from "../../../../shared/library-incidents";
const preparation:LibraryPreparationTicket={replayId:"replay",stage:"S",dependencyKey:"d".repeat(64),generation:1,reason:"background",attempt:"prep"};
const ticket:LibraryMetricTicket={replayId:"replay",slot:"numerical",stage:"S",inputKey:"e".repeat(64),producerVersion:"library-numeric-v1",generation:2,attempt:"metric"};
const descriptor={replayId:"replay",target:{...ticket,slot:"numerical" as const,stage:"S" as const},origin:null,input:{format:"resources" as const,replayBytes:3,mapBytes:3,
  binding:{replaySha256:"a".repeat(64),mapSha256:"b".repeat(64),mapMd5:"c".repeat(32),exactMapAndProfile:true}},
  recipe:{version:1 as const,replaySha256:"a".repeat(64),fixedKey:"b".repeat(64),intrinsicNative:false,embeddedModsHash:null,
    legacyModsHash:"c".repeat(64),modeQualified:true,consumedModsSource:"legacy-mask" as const}};
const free={viewerDemand:false,userPaused:false},held={viewerDemand:true,userPaused:false};
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
const result:LibraryMetricResult={fields:{fc:{state:"known",value:true}},provenance:{}};
function fixture(){
  const work=deferred<LibraryMetricResult>(),abort=new AbortController();
  const resources={handoff:{state:"claimed",ticket} as LibraryMetricHandoff|undefined,
    open:jest.fn(async()=>descriptor),openTarget:jest.fn(async()=>descriptor),read:jest.fn(async()=>({bytes:new Uint8Array([1]),done:true})),
    control:jest.fn(async()=>"parked" as const),close:jest.fn(async():Promise<void>=>undefined)};
  const metadata=jest.fn(async()=>"applied"),worker={result:work.promise,control:jest.fn(async()=>"parked" as const)};
  const startWorker=jest.fn<ReturnType<LibraryNumericalExecutionDependencies["startWorker"]>,Parameters<LibraryNumericalExecutionDependencies["startWorker"]>>(()=>worker);
  return{resources,metadata,worker,startWorker,work,abort,start:()=>startLibraryNumericalPreparation(preparation,free,abort.signal,{resources,metadata,startWorker})};
}
it("rejects a retired C handoff before starting computation",async()=>{
  const f=fixture(),evidence:LibraryIncidentEvidenceReceipt={version:1,state:"absent",replaySha256:"a".repeat(64),mapMd5:"c".repeat(32),validationVersion:"library-saved-evidence-v1"};
  const incident={...libraryIncidentTarget(ticket,evidence),generation:4,attempt:"incidents"};
  const resources={...f.resources,handoff:{state:"claimed" as const,ticket:incident},metricTicket:incident,open:jest.fn(async()=>({...descriptor,incidentEvidence:evidence})),publishNumerical:async()=>"incidents" as const};
  const task=startLibraryNumericalPreparation(preparation,free,f.abort.signal,{resources,metadata:f.metadata,startWorker:f.startWorker,timeline:true});
  await expect(task.result).rejects.toThrow(/Invalid numerical execution target/);expect(f.startWorker).not.toHaveBeenCalled();expect(f.resources.openTarget).not.toHaveBeenCalled();
  expect(f.metadata).not.toHaveBeenCalledWith("metric-commit",expect.anything());
});
it("keeps one decoded owner through handoff and persists only after worker/resource drainage",async()=>{
  const f=fixture(),task=f.start();await turn();expect(f.resources.open).toHaveBeenCalledWith(preparation,free,expect.anything(),true);
  expect(f.resources.openTarget).not.toHaveBeenCalled();expect(f.startWorker).toHaveBeenCalledTimes(1);
  const drain=deferred<void>();f.resources.close.mockImplementation(()=>drain.promise);f.work.resolve(result);await turn();expect(f.metadata).not.toHaveBeenCalled();
  drain.resolve();await task.result;expect(f.metadata).toHaveBeenCalledWith("metric-commit",{patch:{ticket,producerVersion:ticket.producerVersion,...result}});
});
it.each(["cached","blocked"] as const)("closes a %s handoff without simulation",async state=>{
  const f=fixture();f.resources.handoff={state};await f.start().result;expect(f.startWorker).not.toHaveBeenCalled();expect(f.resources.close).toHaveBeenCalled();expect(f.metadata).not.toHaveBeenCalled();
});
it("releases a claimed metric if cancellation wins before open returns",async()=>{
  const f=fixture();f.resources.open.mockImplementation(async()=>{f.abort.abort();throw new Error("cancelled after publication");});
  await expect(f.start().result).rejects.toThrow();expect(f.startWorker).not.toHaveBeenCalled();
  expect(f.metadata).toHaveBeenCalledWith("metric-release",{ticket});expect(f.resources.close).toHaveBeenCalled();
});
it("uses the newest hold across worker creation and waits for both owners",async()=>{
  const f=fixture(),open=deferred<typeof descriptor>();f.resources.open.mockImplementation(()=>open.promise);const task=f.start();
  await task.control(held);open.resolve(descriptor);await turn();expect(f.startWorker.mock.calls[0]?.[2]).toEqual(held);
  const pause=deferred<"parked">();f.worker.control.mockImplementation(()=>pause.promise);let done=false;
  const hold=task.control(held).then(()=>{done=true;});await turn();expect(done).toBe(false);pause.resolve("parked");await hold;
  f.work.resolve(result);await task.result;
});
it("records a computation failure on the metric, then releases resources before settlement",async()=>{
  const f=fixture(),task=f.start();await turn();f.work.reject(new Error("worker failed"));await expect(task.result).rejects.toThrow("worker failed");
  expect(f.metadata).toHaveBeenCalledWith("metric-fail",{ticket,error:"worker failed"});expect(f.resources.close).toHaveBeenCalled();
});
it("surfaces failed handoff persistence as an ownership fault",async()=>{
  const f=fixture(),task=f.start();await turn();f.metadata.mockRejectedValue(new Error("SQLite gone"));f.work.resolve(result);
  await expect(task.result).rejects.toMatchObject({name:"LibraryHandoffFinalizationError",message:expect.stringContaining("SQLite gone")});
});
it("records a concrete control failure instead of releasing it for an automatic retry",async()=>{
  const f=fixture(),task=f.start();await turn();f.worker.control.mockRejectedValue(new Error("hold failed"));
  await expect(task.control(held)).rejects.toThrow("hold failed");f.work.reject(new Error("cancelled after control failure"));
  await expect(task.result).rejects.toThrow();expect(f.metadata).toHaveBeenCalledWith("metric-fail",{ticket,error:"hold failed"});
  expect(f.metadata.mock.calls.some(call=>(call as unknown[])[0]==="metric-release")).toBe(false);
});

it("releases a claimed preparation ticket after its worker's owned-abort control rejection and complete drain",async()=>{
  const f=fixture(),control=deferred<"parked">(),drain=deferred<void>(),reason=new Error("planned scheduler retirement");
  f.worker.control.mockImplementation(()=>control.promise);f.resources.close.mockImplementation(()=>drain.promise);
  const task=f.start();let settled=false;const outcome=task.result.catch(error=>{settled=true;return error;});await turn();
  const pending=task.control(held).catch(error=>error);f.abort.abort(reason);expect(f.startWorker.mock.calls[0][3].reason).toBe(reason);
  control.reject(reason);expect(await pending).toBe(reason);f.work.reject(reason);await turn();
  expect(settled).toBe(false);expect(f.metadata).not.toHaveBeenCalled();drain.resolve();expect(await outcome).toBe(reason);
  expect(f.metadata.mock.calls).toEqual([["metric-release",{ticket}]]);
});

it("does not treat a serialized resource-control rejection as the owned abort before handoff completes",async()=>{
  const f=fixture(),open=deferred<typeof descriptor>(),control=deferred<"parked">(),drain=deferred<void>();
  const reason=new Error("planned scheduler retirement"),rpcError=new Error(reason.message);
  f.resources.open.mockImplementation(()=>open.promise);f.resources.control.mockImplementation(()=>control.promise);f.resources.close.mockImplementation(()=>drain.promise);
  const task=f.start(),outcome=task.result.catch(error=>error),pending=task.control(held).catch(error=>error);
  f.abort.abort(reason);control.reject(rpcError);expect(await pending).toBe(rpcError);open.resolve(descriptor);await turn();
  expect(f.startWorker).not.toHaveBeenCalled();expect(f.metadata).not.toHaveBeenCalled();drain.resolve();await outcome;
  expect(f.metadata.mock.calls).toEqual([["metric-fail",{ticket,error:rpcError.message}]]);
});

it.each(["worker","resource-close"])("retains unconfirmed %s retirement after owned-abort pending control",async kind=>{
  const f=fixture(),control=deferred<"parked">(),drain=deferred<void>(),reason=new Error("planned scheduler retirement"),failure=new Error("unconfirmed "+kind);
  f.worker.control.mockImplementation(()=>control.promise);f.resources.close.mockImplementation(()=>drain.promise);
  const task=f.start(),outcome=task.result.catch(error=>error);await turn();const pending=task.control(held).catch(error=>error);
  f.abort.abort(reason);control.reject(reason);await pending;f.work.reject(kind==="worker"?failure:reason);await turn();expect(f.metadata).not.toHaveBeenCalled();
  if(kind==="resource-close")drain.reject(failure);else drain.resolve();expect(await outcome).toBe(failure);
  expect(f.metadata.mock.calls).toEqual([["metric-fail",{ticket,error:failure.message}]]);
});
