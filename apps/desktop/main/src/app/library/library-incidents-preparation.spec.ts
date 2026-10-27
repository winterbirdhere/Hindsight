import { startLibraryIncidentPreparation as start } from "./library-incidents-preparation";
import type { LibraryPreparationTicket } from "./library-preparation-store";
import type { LibraryIncidentEvidenceReceipt } from "../../../../shared/library-incidents";
import type { LibraryOpenLocation } from "./library-store";
const ticket:LibraryPreparationTicket={replayId:"replay",stage:"C",dependencyKey:"e".repeat(64),generation:2,reason:"background",attempt:"c-preparation"};
const expected:LibraryIncidentEvidenceReceipt={version:1,state:"absent",replaySha256:"a".repeat(64),mapMd5:"c".repeat(32),validationVersion:"library-saved-evidence-v1"};
const location:LibraryOpenLocation&{incidentEpochs:{sourceEpoch:number;locationEpoch:number}}={replayId:"replay",sourceId:"source",sourceKey:"file",kind:"replays",directory:"D:\\source",locator:"D:\\source\\file.osr",
  sha256:expected.replaySha256,locationRevision:1,sourceConfigRevision:1,metadata:{},incidentEpochs:{sourceEpoch:3,locationEpoch:4}};
const probe={evidence:expected,observation:{sha256:expected.replaySha256,available:true,locator:location.locator,metadata:{}},origin:null,scope:"stable-sidecar" as const};
const free={viewerDemand:false,userPaused:false},held={viewerDemand:true,userPaused:false};
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){
  const metadata=jest.fn<Promise<unknown>,[string,Record<string,unknown>?]>(async method=>{
    if(method==="incident-preparation-context")return{location,expected};if(method==="incident-preparation-commit")return"applied";if(method==="analysis-eligible")return true;throw Error(method);
  });
  const request=jest.fn<Promise<unknown>,[string,Record<string,unknown>?]>(async(method,args)=>{
    if(method==="control")return args?.viewerDemand||args?.userPaused?"parked":"released";if(method==="probe-incident-evidence")return probe;throw Error(method);
  });
  const close=jest.fn(async():Promise<void>=>undefined),createResources=jest.fn(()=>({request,close})),abort=new AbortController();
  return{metadata,request,close,createResources,abort,start:()=>start(ticket,free,abort.signal,{metadata,createResources})};
}
it("exports a separate C-only preparation owner",()=>{expect(start).toEqual(expect.any(Function));});
it.each(["applied","stale"])("publishes a fresh receipt after actual drainage without numerical work: %s",async receipt=>{
  const f=fixture(),drain=deferred<void>();f.close.mockImplementation(()=>drain.promise);
  f.metadata.mockImplementation(async method=>method==="incident-preparation-context"?{location,expected}:receipt);
  const task=f.start();await turn();expect(f.createResources).toHaveBeenCalledTimes(1);expect(f.request.mock.calls[0]).toEqual(["control",free]);
  expect(f.request).toHaveBeenCalledWith("probe-incident-evidence",{sessionId:expect.any(String),ticket:location});
  expect(f.metadata.mock.calls.some(([method])=>method==="incident-preparation-commit")).toBe(false);
  drain.resolve();await expect(task.result).resolves.toBeUndefined();expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.request.mock.calls.map(([method])=>method)).toEqual(["control","probe-incident-evidence"]);
  expect(f.metadata).toHaveBeenLastCalledWith("incident-preparation-commit",{ticket,location,probe});
});
it("forwards changed evidence for C-only rebind instead of reusing the old receipt",async()=>{
  const f=fixture(),changed={...probe,evidence:{...expected,state:"rejected" as const}};
  f.request.mockImplementation(async method=>method==="probe-incident-evidence"?changed:"released");await f.start().result;
  expect(f.metadata).toHaveBeenLastCalledWith("incident-preparation-commit",expect.objectContaining({probe:changed}));
});
it.each(["epochs","identity","receipt"])("rejects malformed preparation context %s before probing",async fault=>{
  const f=fixture(),context=JSON.parse(JSON.stringify({location,expected}));
  if(fault==="epochs")delete context.location.incidentEpochs;if(fault==="identity")context.location.replayId="other";
  if(fault==="receipt")context.expected.replaySha256="f".repeat(64);
  f.metadata.mockResolvedValue(context);await expect(f.start().result).rejects.toThrow(/context|evidence/i);
  expect(f.request.mock.calls.some(([method])=>method==="probe-incident-evidence")).toBe(false);expect(f.close).toHaveBeenCalledTimes(1);
});
it.each(["sha","map","extra"])("rejects malformed probe %s without publishing",async fault=>{
  const f=fixture(),bad=JSON.parse(JSON.stringify(probe));
  if(fault==="sha")bad.observation.sha256="f".repeat(64);if(fault==="map")bad.evidence.mapMd5="f".repeat(32);if(fault==="extra")bad.rows=[];
  f.request.mockImplementation(async method=>method==="probe-incident-evidence"?bad:"released");await expect(f.start().result).rejects.toThrow(/probe|evidence/i);
  expect(f.metadata.mock.calls.some(([method])=>method==="incident-preparation-commit")).toBe(false);expect(f.close).toHaveBeenCalledTimes(1);
});
it("snapshots epochs before awaiting the resource operation",async()=>{
  const f=fixture(),context=JSON.parse(JSON.stringify({location,expected}));f.metadata.mockImplementation(async method=>method==="incident-preparation-context"?context:"applied");
  f.request.mockImplementation(async method=>{if(method!=="probe-incident-evidence")return"released";context.location.incidentEpochs.sourceEpoch=99;return probe;});
  await f.start().result;expect(f.metadata).toHaveBeenLastCalledWith("incident-preparation-commit",expect.objectContaining({location:expect.objectContaining({incidentEpochs:{sourceEpoch:3,locationEpoch:4}})}));
});
it("does not allocate a resource owner for an invalid stage or an already cancelled preparation",()=>{
  const f=fixture();expect(()=>start({...ticket,stage:"S"},free,f.abort.signal,f)).toThrow(/stage|target/i);
  f.abort.abort(Error("Off"));expect(()=>f.start()).toThrow("Off");expect(f.createResources).not.toHaveBeenCalled();
});
it("cancels while context is pending, then drains without starting a probe",async()=>{
  const f=fixture(),pending=deferred<unknown>(),drain=deferred<void>();f.metadata.mockImplementation(()=>pending.promise);f.close.mockImplementation(()=>drain.promise);
  const task=f.start(),result=task.result.catch(error=>error);await turn();f.abort.abort(Error("Off"));pending.resolve({location,expected});await turn();
  let done=false;void result.then(()=>{done=true;});expect(done).toBe(false);expect(f.request.mock.calls.some(([method])=>method==="probe-incident-evidence")).toBe(false);
  drain.resolve();expect(await result).toMatchObject({message:"Off"});expect(f.close).toHaveBeenCalledTimes(1);
});
it("cancels a pending probe and awaits actual resource drain before settling",async()=>{
  const f=fixture(),pending=deferred<unknown>(),drain=deferred<void>();f.request.mockImplementation(method=>method==="probe-incident-evidence"?pending.promise:Promise.resolve("released"));
  f.close.mockImplementation(async()=>{pending.reject(Error("closed"));await drain.promise;});const task=f.start();let done=false;
  const result=task.result.catch(error=>{done=true;return error;});await turn();f.abort.abort(Error("Off"));await turn();expect(done).toBe(false);expect(f.close).toHaveBeenCalledTimes(1);
  drain.resolve();expect(await result).toMatchObject({message:"Off"});expect(f.metadata.mock.calls.some(([method])=>method==="incident-preparation-commit")).toBe(false);
});
it("does not publish when cancellation wins during resource drainage",async()=>{
  const f=fixture(),drain=deferred<void>();f.close.mockImplementation(()=>drain.promise);const task=f.start(),result=task.result.catch(error=>error);await turn();
  f.abort.abort(Error("Off"));drain.resolve();expect(await result).toMatchObject({message:"Off"});expect(f.metadata.mock.calls.some(([method])=>method==="incident-preparation-commit")).toBe(false);
});
it("rejects failed resource drainage without publishing",async()=>{
  const f=fixture();f.close.mockRejectedValue(Error("exit unproven"));await expect(f.start().result).rejects.toThrow("exit unproven");
  expect(f.metadata.mock.calls.some(([method])=>method==="incident-preparation-commit")).toBe(false);
});
it.each(["reject","invalid"])("poisons ownership rather than retrying an uncertain commit: %s",async fault=>{
  const f=fixture();f.metadata.mockImplementation(async method=>{if(method==="incident-preparation-context")return{location,expected};if(fault==="reject")throw Error("lost receipt");return{state:"maybe"};});
  await expect(f.start().result).rejects.toMatchObject({name:"LibraryHandoffFinalizationError"});expect(f.close).toHaveBeenCalledTimes(1);
});
it("waits for the commit receipt after cancellation once the mutation has been sent",async()=>{
  const f=fixture(),commit=deferred<unknown>();f.metadata.mockImplementation(method=>method==="incident-preparation-context"?Promise.resolve({location,expected}):commit.promise);
  const task=f.start();let done=false;const result=task.result.then(()=>{done=true;});await turn();f.abort.abort(Error("Off"));await turn();expect(done).toBe(false);
  commit.resolve("applied");await result;expect(f.close).toHaveBeenCalledTimes(1);
});
it("waits for control acknowledgement, ignores superseded failure, and rejects a false hold",async()=>{
  const f=fixture(),pending=deferred<unknown>(),old=deferred<unknown>();f.request.mockImplementation(method=>method==="probe-incident-evidence"?pending.promise:Promise.resolve("released"));
  const task=f.start(),result=task.result.catch(error=>error);await turn();f.request.mockImplementationOnce(()=>old.promise);
  const hold=task.control(held);expect(await task.control(free)).toBe("released");old.reject(Error("superseded"));expect(await hold).toBe("superseded");
  f.request.mockResolvedValueOnce("released");await expect(task.control(held)).rejects.toThrow(/confirm|control/i);pending.resolve(probe);
  expect(await result).toBeInstanceOf(Error);expect(f.metadata.mock.calls.some(([method])=>method==="incident-preparation-commit")).toBe(false);
});
it("returns idle only after a closing owner drains and validates durable eligibility",async()=>{
  const f=fixture(),drain=deferred<void>();f.close.mockImplementation(()=>drain.promise);const task=f.start();await turn();
  await expect(task.eligible?.()).resolves.toBe(true);expect(f.metadata).toHaveBeenLastCalledWith("analysis-eligible",{lease:{kind:"preparation",ticket,location:{sourceId:location.sourceId,sourceConfigRevision:location.sourceConfigRevision}}});
  f.metadata.mockResolvedValueOnce("maybe");await expect(task.eligible?.()).rejects.toThrow(/eligibility/i);
  let heldDone=false;const hold=task.control(held).then(value=>{heldDone=true;return value;});await turn();expect(heldDone).toBe(false);
  drain.resolve();expect(await hold).toBe("idle");await task.result;
});
