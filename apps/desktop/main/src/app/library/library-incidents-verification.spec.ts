import { startLibraryIncidentVerification } from "./library-incidents-verification";
import type { LibraryMetricTicket,LibraryMetricResult } from "../../../../shared/replay-library-metrics";
import type { LibraryIncidentEvidenceReceipt } from "../../../../shared/library-incidents";
import type { LibraryOpenLocation } from "./library-store";

const ticket:LibraryMetricTicket={replayId:"replay",slot:"incidents",stage:"C",inputKey:"e".repeat(64),producerVersion:"library-incidents-v1",generation:2,attempt:"c-attempt"};
const metrics:LibraryMetricResult={fields:{incidentCount:{state:"known",value:2}},provenance:{producer:"fixture"}};
const expected:LibraryIncidentEvidenceReceipt={version:1,state:"absent",replaySha256:"a".repeat(64),mapMd5:"c".repeat(32),validationVersion:"library-saved-evidence-v1"};
const location:LibraryOpenLocation&{incidentEpochs:{sourceEpoch:number;locationEpoch:number}}={replayId:"replay",sourceId:"source",sourceKey:"file",kind:"replays",directory:"D:\\source",locator:"D:\\source\\file.osr",
  sha256:expected.replaySha256,locationRevision:1,sourceConfigRevision:1,metadata:{},incidentEpochs:{sourceEpoch:3,locationEpoch:4}};
const probe={evidence:expected,observation:{sha256:expected.replaySha256,available:true,locator:location.locator,metadata:{}},origin:null,scope:"stable-sidecar" as const};
const free={viewerDemand:false,userPaused:false},held={viewerDemand:true,userPaused:false};
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){
  const metadata=jest.fn<Promise<unknown>,[string,Record<string,unknown>?]>(async method=>{
    if(method==="incidents-probe-context")return{location,expected};if(method==="incidents-commit")return"applied";if(method==="analysis-eligible")return true;throw Error(method);
  });
  const request=jest.fn<Promise<unknown>,[string,Record<string,unknown>?]>(async(method,args)=>{
    if(method==="control")return args?.viewerDemand||args?.userPaused?"parked":"released";if(method==="probe-incident-evidence")return probe;throw Error(method);
  });
  const close=jest.fn(async():Promise<void>=>undefined),createResources=jest.fn(()=>({request,close})),abort=new AbortController();
  return{metadata,request,close,createResources,abort,start:()=>startLibraryIncidentVerification(ticket,metrics,free,abort.signal,{metadata,createResources})};
}
it.each(["applied","stale"])("commits only after a fresh controlled probe owner actually drains: %s",async receipt=>{
  const f=fixture(),drain=deferred<void>();f.close.mockImplementation(()=>drain.promise);
  f.metadata.mockImplementation(async method=>method==="incidents-probe-context"?{location,expected}:receipt);
  const task=f.start();await turn();expect(f.createResources).toHaveBeenCalledTimes(1);expect(f.request.mock.calls[0]).toEqual(["control",free]);
  expect(f.request).toHaveBeenCalledWith("probe-incident-evidence",{sessionId:expect.any(String),ticket:location});
  expect(f.metadata.mock.calls.some(([method])=>method==="incidents-commit")).toBe(false);drain.resolve();expect(await task.result).toEqual(metrics);
  expect(task.managesPersistence).toBe(true);expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.metadata).toHaveBeenLastCalledWith("incidents-commit",{ticket,location,probe,metrics});
});
it("forwards changed but identically bound evidence to Store instead of accepting an old C result locally",async()=>{
  const f=fixture(),changed={...probe,evidence:{...expected,state:"rejected" as const}};
  f.request.mockImplementation(async method=>method==="probe-incident-evidence"?changed:"released");await f.start().result;
  expect(f.metadata).toHaveBeenLastCalledWith("incidents-commit",expect.objectContaining({probe:changed}));
});
it.each(["sha","map","metadata","scope","origin"])("rejects malformed fresh probe %s and drains without publishing",async fault=>{
  const f=fixture(),bad=JSON.parse(JSON.stringify(probe));
  if(fault==="sha")bad.observation.sha256="f".repeat(64);if(fault==="map")bad.evidence.mapMd5="f".repeat(32);
  if(fault==="metadata")bad.observation.metadata={oversized:"x".repeat(65537)};if(fault==="scope")bad.scope="invented";
  if(fault==="origin")bad.origin={client:"stable",provenance:"guessed"};
  f.request.mockImplementation(async method=>method==="probe-incident-evidence"?bad:"released");
  await expect(f.start().result).rejects.toThrow(/probe|evidence/i);expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.metadata.mock.calls.some(([method])=>method==="incidents-commit")).toBe(false);
});
it.each(["epochs","identity","receipt"])("rejects malformed context %s before probing",async fault=>{
  const f=fixture(),context=JSON.parse(JSON.stringify({location,expected}));
  if(fault==="epochs")delete context.location.incidentEpochs;if(fault==="identity")context.location.replayId="other";
  if(fault==="receipt")context.expected.replaySha256="f".repeat(64);
  f.metadata.mockResolvedValue(context);await expect(f.start().result).rejects.toThrow(/context|evidence/i);
  expect(f.request.mock.calls.some(([method])=>method==="probe-incident-evidence")).toBe(false);expect(f.close).toHaveBeenCalledTimes(1);
});
it("captures context epochs before asynchronous probe work can mutate the received object",async()=>{
  const f=fixture(),context=JSON.parse(JSON.stringify({location,expected}));f.metadata.mockImplementation(async method=>method==="incidents-probe-context"?context:"applied");
  f.request.mockImplementation(async method=>{if(method!=="probe-incident-evidence")return"released";context.location.incidentEpochs.sourceEpoch=99;return probe;});
  await f.start().result;expect(f.metadata).toHaveBeenLastCalledWith("incidents-commit",expect.objectContaining({location:expect.objectContaining({incidentEpochs:{sourceEpoch:3,locationEpoch:4}})}));
});
it("cancels a pending probe immediately but awaits the fresh owner drain before settling",async()=>{
  const f=fixture(),pending=deferred<unknown>(),drain=deferred<void>();f.request.mockImplementation(method=>method==="probe-incident-evidence"?pending.promise:Promise.resolve("released"));
  f.close.mockImplementation(async()=>{pending.reject(Error("closed"));await drain.promise;});const task=f.start();let done=false;
  const result=task.result.catch(error=>{done=true;return error;});await turn();f.abort.abort(Error("Off"));await turn();expect(done).toBe(false);expect(f.close).toHaveBeenCalledTimes(1);
  drain.resolve();expect(await result).toMatchObject({message:"Off"});expect(f.metadata.mock.calls.some(([method])=>method==="incidents-commit")).toBe(false);
});
it("does not publish if cancellation arrives while the probe owner is draining",async()=>{
  const f=fixture(),drain=deferred<void>();f.close.mockImplementation(()=>drain.promise);const task=f.start(),result=task.result.catch(error=>error);await turn();
  f.abort.abort(Error("Off"));drain.resolve();expect(await result).toMatchObject({message:"Off"});expect(f.metadata.mock.calls.some(([method])=>method==="incidents-commit")).toBe(false);
});
it.each(["reject","invalid"])("poisons ownership on an uncertain commit receipt: %s",async fault=>{
  const f=fixture();f.metadata.mockImplementation(async method=>{if(method==="incidents-probe-context")return{location,expected};if(fault==="reject")throw Error("lost receipt");return{state:"maybe"};});
  await expect(f.start().result).rejects.toMatchObject({name:"LibraryHandoffFinalizationError"});expect(f.close).toHaveBeenCalledTimes(1);
});
it("waits for an in-flight commit receipt during cancellation instead of guessing whether it applied",async()=>{
  const f=fixture(),commit=deferred<unknown>();f.metadata.mockImplementation(method=>method==="incidents-probe-context"?Promise.resolve({location,expected}):commit.promise);
  const task=f.start();let done=false;const result=task.result.then(value=>{done=true;return value;});await turn();f.abort.abort(Error("Off"));await turn();expect(done).toBe(false);
  commit.resolve("applied");expect(await result).toEqual(metrics);expect(f.close).toHaveBeenCalledTimes(1);
});
it("waits for holds, rejects invalid acknowledgements and ignores superseded control failures",async()=>{
  const f=fixture(),pending=deferred<unknown>(),old=deferred<unknown>();f.request.mockImplementation(method=>method==="probe-incident-evidence"?pending.promise:Promise.resolve("released"));
  const task=f.start(),result=task.result.catch(error=>error);await turn();
  f.request.mockImplementationOnce(()=>old.promise);const hold=task.control(held);expect(await task.control(free)).toBe("released");old.reject(Error("superseded hold"));expect(await hold).toBe("superseded");
  f.request.mockResolvedValueOnce("released");await expect(task.control(held)).rejects.toThrow(/confirm|control/i);pending.resolve(probe);await expect(result).resolves.toBeInstanceOf(Error);
  expect(f.metadata.mock.calls.some(([method])=>method==="incidents-commit")).toBe(false);
});
