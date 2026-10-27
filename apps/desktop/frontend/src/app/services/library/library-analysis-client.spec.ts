import type { LibraryMetricTicket } from "../../../../../shared/replay-library-metrics";
import { startLibraryNumerical,LibraryAnalysisShutdownError } from "./library-analysis-client";
import type { LibraryNumericalWireInput } from "./library-analysis-worker";
import type { LibraryNumericalResourceInput } from "./library-analysis-input";

const ticket:LibraryMetricTicket={replayId:"fixture",slot:"numerical",stage:"S",inputKey:"a".repeat(64),producerVersion:"v1",generation:1,attempt:"attempt"};
const metrics={provenance:{ruleset:"stable"},fields:{fc:{state:"known",value:true}}};
const input={} as LibraryNumericalWireInput;
class FakeWorker {
  onmessage:((event:MessageEvent)=>void)|null=null;
  onerror:((event:ErrorEvent)=>void)|null=null;
  onmessageerror:((event:MessageEvent)=>void)|null=null;
  postMessage=jest.fn();terminate=jest.fn();
  emit(data:unknown){this.onmessage?.({data} as MessageEvent);}
}
it("transports a separately bounded strip while retaining scalar validation",async()=>{
  const worker=new FakeWorker(),errorStrip={state:"known",value:{version:1,timeBasis:"map-ms",ruleset:"stable",
    mapStartMs:0,mapEndMs:10000,evaluatedThrough:10000,endpointBasis:"recorded-end",synthesizedEndpoint:false,
    ok:Array.from({length:2048},(_,i)=>i+0.123456789),meh:[],miss:[],sliderBreak:[],sliderEndMiss:[]}};
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker);
  worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics:{...metrics,errorStrip}});
  expect((await task.result).errorStrip).toEqual(errorStrip);
});
it("rejects causes in a strip sidecar",async()=>{
  const worker=new FakeWorker();const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker);
  const rejected=expect(task.result).rejects.toThrow("Invalid library scalar result");
  worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics:{...metrics,errorStrip:{state:"unknown",reason:"missing",cause:"aim"}}});
  await rejected;
});

it("waits for asynchronous worker exit as well as reader drainage before publishing",async()=>{
  const worker=new FakeWorker();let exit!:()=>void;
  worker.terminate.mockImplementation(()=>new Promise<void>(resolve=>{exit=resolve;}));
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker as unknown as Worker);
  let published=false;const result=task.result.then(value=>{published=true;return value;});
  worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics});await Promise.resolve();expect(published).toBe(false);
  exit();expect(await result).toEqual(metrics);
});

it("rejects unconfirmed worker cleanup instead of publishing a successful result",async()=>{
  const worker=new FakeWorker();worker.terminate.mockImplementation(()=>Promise.reject(new Error("worker exit failed")));
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker as unknown as Worker);
  const result=expect(task.result).rejects.toThrow("worker exit failed");
  worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics});await result;
});
it("waits for the numerical publication receipt before continuing the retained worker",async()=>{
  const worker=new FakeWorker();let receipt!:(value:boolean)=>void;
  const publish=jest.fn(()=>new Promise<boolean>(resolve=>{receipt=resolve;}));
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker,undefined,publish);
  worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await Promise.resolve();
  expect(publish).toHaveBeenCalledTimes(1);expect(worker.postMessage.mock.calls.some(([m])=>m.type==="continue")).toBe(false);
  receipt(true);await new Promise(resolve=>setTimeout(resolve,0));
  expect(worker.postMessage).toHaveBeenCalledWith({version:1,type:"continue",requestId:1,timeline:true});
  worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics});await task.result;
});
it("drains an in-flight publication after cancellation and never sends a late continuation",async()=>{
  const worker=new FakeWorker(),abort=new AbortController();let receipt!:(value:boolean)=>void;
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},abort.signal,()=>worker,undefined,
    ()=>new Promise<boolean>(resolve=>{receipt=resolve;}));
  let settled=false;const failure=task.result.catch(error=>{settled=true;return error;});
  worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await Promise.resolve();abort.abort(Error("stop"));
  await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);receipt(true);
  expect(await failure).toEqual(Error("stop"));expect(worker.postMessage.mock.calls.some(([m])=>m.type==="continue")).toBe(false);
});
it("preserves uncertain publication failure when cancellation arrived first",async()=>{
  const worker=new FakeWorker(),abort=new AbortController();let reject!:(reason:unknown)=>void;
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},abort.signal,()=>worker,undefined,
    ()=>new Promise<boolean>((_resolve,fail)=>{reject=fail;}));
  const publicationFailure=Error("handoff receipt lost"),result=expect(task.result).rejects.toBe(publicationFailure);
  worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await Promise.resolve();abort.abort(Error("stop"));
  reject(publicationFailure);await result;
});

it("keeps original publication precedence and identity when worker retirement also fails",async()=>{
  const worker=new FakeWorker(),abort=new AbortController();let reject!:(reason:unknown)=>void;
  const retirement=Error("retirement failed"),publication=Error("publication receipt lost");worker.terminate.mockImplementation(()=>Promise.reject(retirement));
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},abort.signal,()=>worker,undefined,
    ()=>new Promise<boolean>((_resolve,fail)=>{reject=fail;}));
  const result=expect(task.result).rejects.toBe(publication);worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});
  await Promise.resolve();abort.abort(Error("first abort"));reject(publication);await result;expect(retirement.message).toBe("retirement failed");
});

it("does not replace or annotate arbitrary retirement errors with a triggering path",async()=>{
  const worker=new FakeWorker(),retirement=Error("worker retirement failed");worker.terminate.mockImplementation(()=>Promise.reject(retirement));
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker);
  const result=expect(task.result).rejects.toBe(retirement);worker.onerror?.({message:"D:/private/replay.osr",preventDefault:()=>undefined} as ErrorEvent);
  await result;expect(retirement.message).toBe("worker retirement failed");
});

it("enriches the owned shutdown Error without replacing its identity or copying raw trigger details",async()=>{
  const worker=new FakeWorker(),abort=new AbortController(),retirement=new LibraryAnalysisShutdownError({terminal:"pending",nativeDrain:"confirmed",utilityExit:"unknown",cancel:"sent"});
  worker.terminate.mockImplementation(()=>Promise.reject(retirement));
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},abort.signal,()=>worker);
  const result=expect(task.result).rejects.toBe(retirement);abort.abort(Object.assign(Error("D:/private/play.osr"),{code:"EIO"}));await result;
  expect(retirement.message).toContain("trigger=abort code=EIO detail=redacted");expect(JSON.stringify(retirement)).not.toContain("private");
  retirement.observeTrigger("send",Error("later error"));expect(retirement.message).toContain("trigger=abort code=EIO");
});

it("does not annotate an owned shutdown Error when a lost publication receipt wins",async()=>{
  const worker=new FakeWorker(),abort=new AbortController(),retirement=new LibraryAnalysisShutdownError({terminal:"pending",nativeDrain:"pending",utilityExit:7,cancel:"sent"});
  const publication=Error("publication receipt lost");let reject!:(reason:unknown)=>void;worker.terminate.mockImplementation(()=>Promise.reject(retirement));
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},abort.signal,()=>worker,undefined,()=>new Promise<boolean>((_resolve,fail)=>{reject=fail;}));
  const result=expect(task.result).rejects.toBe(publication);worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});
  await Promise.resolve();abort.abort(Error("first abort"));reject(publication);await result;expect(retirement.message).toContain("trigger=none");
});

it.each(['D:\\private folder\\play.osr','\\\\server\\private share\\play.osr','file:///private/play.osr','/home/private/play.osr',"x".repeat(4000)])(
  "retains only fixed diagnostics for a path-bearing/long trigger %#",detail=>{
    const retirement=new LibraryAnalysisShutdownError({terminal:"pending",nativeDrain:"pending",utilityExit:7,cancel:"sent"});
    retirement.observeTrigger("read",Object.assign(Error(detail),{code:detail}));
    expect(retirement.message).toContain("trigger=read code=redacted detail=redacted");expect(retirement.message.length).toBeLessThan(1536);
    expect(JSON.stringify(retirement)).not.toContain(detail);
  });

it("reads an error code accessor once and cannot turn a later accessor value into leaked detail",()=>{
  let reads=0;const trigger={get code(){return ++reads===1?"EPIPE":"D:/private/play.osr";}};
  const retirement=new LibraryAnalysisShutdownError({terminal:"pending",nativeDrain:"pending",utilityExit:7,cancel:"sent"});retirement.observeTrigger("read",trigger);
  expect(reads).toBe(1);expect(retirement.message).toContain("code=EPIPE");expect(JSON.stringify(retirement)).not.toContain("private");
});
it("publishes timeline separately before allowing the FC continuation",async()=>{
  const worker=new FakeWorker(),publish=jest.fn(async()=>true),timeline=jest.fn(async()=>true);
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker,undefined,publish,timeline);
  worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await new Promise(resolve=>setTimeout(resolve,0));
  worker.emit({version:1,type:"timeline",requestId:1,ticket,outcome:{error:"timeline size"}});await new Promise(resolve=>setTimeout(resolve,0));
  expect(timeline).toHaveBeenCalledWith({error:"timeline size"});expect(worker.postMessage).toHaveBeenCalledWith({version:1,type:"continue",requestId:1,timeline:"fc"});
  worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics});await task.result;
});
it.each([false,true])("drains the second publication before cancellation settles, receiptFailed=%s",async failed=>{
  const worker=new FakeWorker(),abort=new AbortController();let resolve!:(value:boolean)=>void,reject!:(reason:unknown)=>void;
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},abort.signal,()=>worker,undefined,async()=>true,
    ()=>new Promise<boolean>((done,fail)=>{resolve=done;reject=fail;}));
  let settled=false;const result=task.result.catch(error=>{settled=true;return error;});
  worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await new Promise(done=>setTimeout(done,0));
  worker.emit({version:1,type:"timeline",requestId:1,ticket,outcome:{error:"timeline size"}});await Promise.resolve();
  abort.abort(Error("stop"));await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);
  if(failed)reject(Error("FFC publication receipt lost"));else resolve(true);
  expect(await result).toEqual(Error(failed?"FFC publication receipt lost":"stop"));
  expect(worker.postMessage.mock.calls.some(([m])=>m.type==="continue"&&m.timeline==="fc")).toBe(false);
});
it("keeps one worker across demand changes and rejects stale result ownership",async()=>{
  const worker=new FakeWorker(),factory=jest.fn(()=>worker as unknown as Worker);
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,factory);
  const hold=task.control({viewerDemand:true,userPaused:false});
  const commands=worker.postMessage.mock.calls.map(x=>x[0]);expect(commands.map(x=>x.type)).toEqual(["control","run","control"]);
  worker.emit({version:1,type:"control",sequence:2,requestId:1,state:"parked"});expect(await hold).toBe("parked");
  let settled=false;void task.result.then(()=>{settled=true;});
  worker.emit({version:1,type:"result",requestId:1,ticket:{...ticket,generation:2},status:"complete",metrics});
  await Promise.resolve();expect(settled).toBe(false);
  worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics});expect(await task.result).toEqual(metrics);
  expect(factory).toHaveBeenCalledTimes(1);expect(worker.terminate).toHaveBeenCalledTimes(1);expect(worker.onmessage).toBeNull();
});

it("cancels parked work once, settles pending acknowledgement and ignores late messages",async()=>{
  const worker=new FakeWorker(),abort=new AbortController(),task=startLibraryNumerical(ticket,input,{viewerDemand:true,userPaused:false},abort.signal,()=>worker as unknown as Worker);
  const acknowledgement=task.control({viewerDemand:true,userPaused:true});
  const failure=new Error("mode Off"),resultRejected=expect(task.result).rejects.toBe(failure),ackRejected=expect(acknowledgement).rejects.toBe(failure);
  abort.abort(failure);await resultRejected;await ackRejected;
  task.cancel();expect(worker.terminate).toHaveBeenCalledTimes(1);expect(worker.onmessage).toBeNull();
});

it("surfaces worker failure without falling back to the viewer or inline simulation",async()=>{
  const worker=new FakeWorker(),task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker as unknown as Worker);
  const failure=expect(task.result).rejects.toThrow("worker crashed");
  worker.onerror?.({message:"worker crashed",preventDefault:()=>undefined} as ErrorEvent);await failure;
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("acknowledges pending yield as idle when completed work wins the message race",async()=>{
  const worker=new FakeWorker(),task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker as unknown as Worker);
  const acknowledgement=task.control({viewerDemand:true,userPaused:false});
  const acknowledged=expect(acknowledgement).resolves.toBe("idle");
  worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics});
  await acknowledged;await task.result;expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it.each(["error","cyclic"])("settles malformed matching %s responses instead of stranding the owner",async kind=>{
  const worker=new FakeWorker(),task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker as unknown as Worker);
  const observed=task.result.then(()=>null,error=>error);
  const cyclic:Record<string,unknown>={};cyclic.self=cyclic;
  let thrown:unknown;
  try {
    try {worker.emit({version:1,type:"result",requestId:1,ticket,...(kind==="error"?{status:"error",error:42}:{status:"complete",metrics:{...metrics,provenance:cyclic}})});}
    catch(error){thrown=error;}
    expect(thrown).toBeUndefined();expect(worker.terminate).toHaveBeenCalledTimes(1);expect(await observed).toBeInstanceOf(Error);
  } finally {task.cancel();await observed;}
});

it("bounds outstanding controls while retaining the newest demand",async()=>{
  const worker=new FakeWorker(),task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker as unknown as Worker);
  const observed=task.result.catch(error=>error),pending:Promise<unknown>[]=[];
  for(let i=0;i<200;i++)pending.push(task.control({viewerDemand:i%2===0,userPaused:i===199}).catch(error=>error));
  try {
    expect(worker.postMessage.mock.calls.filter(([m])=>m.type==="control").length).toBeLessThanOrEqual(32);
    worker.emit({version:1,type:"control",sequence:1,requestId:null,state:"idle"});
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({type:"control",userPaused:true,viewerDemand:false});
  }finally{task.cancel();await observed;await Promise.all(pending);}
});

const resources:LibraryNumericalResourceInput={format:"resources",replayBytes:3,mapBytes:3,binding:{exactMapAndProfile:true,
  replaySha256:"a".repeat(64),mapSha256:"b".repeat(64),mapMd5:"c".repeat(32)}};
const readRequest={version:1,type:"read",requestId:1,ticket,readId:1,kind:"replay",offset:0};
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));

it("publishes ordinary timeline and FC failures and finishes without C",async()=>{
  const worker=new FakeWorker(),publish=jest.fn(async()=>true),timeline=jest.fn(async()=>true),fc=jest.fn(async()=>false);
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker,undefined,publish,timeline,fc);
  const observed=task.result.catch(error=>error);
  try {
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:"run",timeline:true,fc:true,publishFc:true}));
    worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await turn();
    worker.emit({version:1,type:"timeline",requestId:1,ticket,outcome:{error:"timeline unavailable"}});await turn();
    worker.emit({version:1,type:"fc",requestId:1,ticket,outcome:{error:"FC unavailable"}});await turn();
    expect(publish).toHaveBeenCalledWith(metrics);expect(timeline).toHaveBeenCalledWith({error:"timeline unavailable"});
    expect(fc).toHaveBeenCalledWith({error:"FC unavailable"});
    expect(worker.postMessage.mock.calls.filter(([m])=>m.type==="continue").map(([m])=>m.timeline)).toEqual([true,"fc",false]);
    worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics});expect(await observed).toEqual(metrics);
  } finally {task.cancel();await observed;}
});

it.each(["numerical","timeline","fc"] as const)("rejects retired continuation after %s",async stage=>{
  const worker=new FakeWorker(),publish=jest.fn(async()=>stage==="numerical"?"incidents" as const:stage==="fc"?"fc" as const:true),
    timeline=jest.fn(async()=>"incidents" as const),fc=jest.fn(async()=>true);
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker,undefined,publish,timeline,fc);
  const observed=task.result.catch(error=>error);
  worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await turn();
  if(stage!=="numerical"){worker.emit({version:1,type:stage,requestId:1,ticket,outcome:{metrics}});await turn();}
  expect(await observed).toEqual(expect.objectContaining({message:expect.stringMatching(/publication receipt/)}));
  expect(worker.postMessage.mock.calls.some(([m])=>m.type==="continue"&&m.timeline==="incidents")).toBe(false);
});

it.each([false,true])("drains the third publication and actual exit after cancellation, receiptFailed=%s",async failed=>{
  const worker=new FakeWorker(),abort=new AbortController();let release!:(value:boolean)=>void,reject!:(reason:unknown)=>void,exit!:()=>void;
  worker.terminate.mockImplementation(()=>new Promise<void>(resolve=>{exit=resolve;}));
  const fc=jest.fn(()=>new Promise<boolean>((done,fail)=>{release=done;reject=fail;}));
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},abort.signal,()=>worker,undefined,async()=>true,async()=>true,fc);
  let settled=false;const observed=task.result.catch(error=>{settled=true;return error;});
  try {
    worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await turn();
    worker.emit({version:1,type:"timeline",requestId:1,ticket,outcome:{metrics}});await turn();
    worker.emit({version:1,type:"fc",requestId:1,ticket,outcome:{error:"FC unavailable"}});await turn();
    expect(fc).toHaveBeenCalledTimes(1);abort.abort(Error("stop"));await turn();expect(settled).toBe(false);
    if(failed)reject(Error("FC publication receipt lost"));else release(false);
    await turn();expect(settled).toBe(false);exit();
    expect(await observed).toEqual(Error(failed?"FC publication receipt lost":"stop"));
    expect(worker.postMessage.mock.calls.some(([m])=>m.type==="continue"&&m.timeline==="incidents")).toBe(false);
  } finally {task.cancel();release?.(false);exit?.();await observed;}
});

it("ignores stale FC attempts and rejects FC publication before the requested phase",async()=>{
  const worker=new FakeWorker(),fc=jest.fn(async()=>true);
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker,undefined,async()=>true,async()=>true,fc);
  let settled=false;const observed=task.result.catch(error=>{settled=true;return error;});
  try {
    worker.emit({version:1,type:"fc",requestId:1,ticket:{...ticket,attempt:"old"},outcome:{metrics}});await turn();
    expect(settled).toBe(false);expect(fc).not.toHaveBeenCalled();
    worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await turn();
    worker.emit({version:1,type:"fc",requestId:1,ticket,outcome:{metrics}});await turn();
    expect(settled).toBe(true);expect(await observed).toEqual(Error("Invalid FC publication"));expect(fc).not.toHaveBeenCalled();
  } finally {task.cancel();await observed;}
});

it.each([[],"x".repeat(17000)])("rejects unbounded or structured final scalar data (%#)",async value=>{
  const worker=new FakeWorker();
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker,undefined,async()=>false,async()=>false,async()=>false);
  const observed=task.result.catch(error=>error);
  try {
    worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await turn();
    worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics:{fields:{incidentCount:{state:"known",value}},provenance:{}}});
    expect(await observed).toEqual(Error("Invalid library scalar result"));
  } finally {task.cancel();await observed;}
});

it("keeps C disabled for the existing timeline-to-FC client contract",async()=>{
  const worker=new FakeWorker();
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker,undefined,async()=>true,async()=>true);
  const observed=task.result.catch(error=>error);
  try {
    const run=worker.postMessage.mock.calls.find(([m])=>m.type==="run")?.[0];expect(run).toMatchObject({timeline:true,fc:true});expect(run).not.toHaveProperty("incidents");
    worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await turn();
    worker.emit({version:1,type:"timeline",requestId:1,ticket,outcome:{metrics}});await turn();
    worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics});expect(await observed).toEqual(metrics);
  } finally {task.cancel();await observed;}
});

it("rejects a repeated third publication without duplicating the receipt owner",async()=>{
  const worker=new FakeWorker();let release!:(value:boolean)=>void;
  const fc=jest.fn(()=>new Promise<boolean>(resolve=>{release=resolve;}));
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker,undefined,async()=>"fc",async()=>false,fc);
  let settled=false;const observed=task.result.catch(error=>{settled=true;return error;});
  try {
    worker.emit({version:1,type:"numerical",requestId:1,ticket,metrics});await turn();
    worker.emit({version:1,type:"fc",requestId:1,ticket,outcome:{metrics}});await turn();
    worker.emit({version:1,type:"fc",requestId:1,ticket,outcome:{metrics}});await turn();
    expect(fc).toHaveBeenCalledTimes(1);expect(settled).toBe(false);release(false);
    expect(await observed).toEqual(Error("Invalid FC publication"));
    expect(worker.postMessage.mock.calls.some(([m])=>m.type==="continue"&&m.timeline==="incidents")).toBe(false);
  } finally {task.cancel();release?.(false);await observed;}
});

it("relays one bounded byte chunk only for the current ticket without parsing in the renderer",async()=>{
  const worker=new FakeWorker(),read=jest.fn(async()=>({bytes:new Uint8Array([1,2,3]),done:true}));
  const task=startLibraryNumerical(ticket,resources,{viewerDemand:false,userPaused:false},new AbortController().signal,()=>worker as unknown as Worker,read);
  worker.emit({...readRequest,ticket:{...ticket,attempt:"old"}});expect(read).not.toHaveBeenCalled();
  worker.emit(readRequest);await turn();
  expect(read).toHaveBeenCalledWith("replay",0,expect.any(AbortSignal));
  expect(worker.postMessage.mock.calls.at(-1)?.[0]).toEqual({version:1,type:"chunk",requestId:1,readId:1,chunk:{bytes:new Uint8Array([1,2,3]),done:true}});
  worker.emit({version:1,type:"result",requestId:1,ticket,status:"complete",metrics});await task.result;
});

it("bounds pending reads and ignores a chunk that arrives after cancellation",async()=>{
  const worker=new FakeWorker(),abort=new AbortController();let resolve!:(chunk:{bytes:Uint8Array;done:boolean})=>void;
  const read=jest.fn(()=>new Promise<{bytes:Uint8Array;done:boolean}>(done=>{resolve=done;}));
  const task=startLibraryNumerical(ticket,resources,{viewerDemand:false,userPaused:false},abort.signal,()=>worker as unknown as Worker,read);
  let settled=false;const failed=task.result.catch(error=>{settled=true;return error;});worker.emit(readRequest);await turn();
  try {worker.emit({...readRequest,readId:2});await turn();expect(settled).toBe(false);}
  finally {resolve({bytes:new Uint8Array([1,2,3]),done:true});}
  expect(await failed).toBeInstanceOf(Error);await turn();
  expect(read).toHaveBeenCalledTimes(1);expect(worker.postMessage.mock.calls.some(([value])=>value.type==="chunk")).toBe(false);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("cancels the owned reader and waits for its actual drain before settling",async()=>{
  const worker=new FakeWorker();let readerSignal:AbortSignal|undefined,rejectRead!:(error:unknown)=>void;
  const read=jest.fn((_kind:string,_offset:number,signal?:AbortSignal)=>{readerSignal=signal;return new Promise<{bytes:Uint8Array;done:boolean}>((_resolve,reject)=>{rejectRead=reject;});});
  const external=new AbortController(),task=startLibraryNumerical(ticket,resources,{viewerDemand:false,userPaused:false},external.signal,()=>worker as unknown as Worker,read);
  let settled=false;const failed=task.result.catch(error=>{settled=true;return error;});
  worker.emit(readRequest);await turn();
  try {
    task.cancel();await turn();expect(readerSignal?.aborted).toBe(true);expect(external.signal.aborted).toBe(false);
    expect(settled).toBe(false);expect(worker.terminate).toHaveBeenCalledTimes(1);
  } finally {task.cancel();rejectRead(new Error("read drained"));await failed;}
  expect(await failed).toEqual(new Error("Library analysis cancelled"));
});
