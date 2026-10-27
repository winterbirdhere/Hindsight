import { createLibraryAnalysisUtilityPort } from "./library-analysis-utility-client";
import { startLibraryNumerical } from "../../../../frontend/src/app/services/library/library-analysis-client";
import type { LibraryNumericalResourceInput } from "../../../../shared/library-analysis";
import type { LibraryMetricTicket } from "../../../../shared/replay-library-metrics";
import { EventEmitter } from "events";
import { LibraryNativeBroker, LibraryNativeBridge } from "./library-native-admission";
import { validateLibraryErrorStrip } from "../../../../shared/library-error-strip";
class Child extends EventEmitter {postMessage=jest.fn();kill=jest.fn(()=>true);}
const ticket:LibraryMetricTicket={replayId:"replay",slot:"numerical",stage:"S",inputKey:"a".repeat(64),producerVersion:"test",generation:1,attempt:"attempt"};
const input:LibraryNumericalResourceInput={format:"resources",replayBytes:1,mapBytes:1,binding:{replaySha256:"a".repeat(64),mapSha256:"b".repeat(64),mapMd5:"c".repeat(32),exactMapAndProfile:true}};
const metrics={fields:{fc:{state:"known",value:true}},provenance:{}};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function readOwnedInput(child:Child):Promise<void> {
  child.emit("message",{version:1,type:"read",requestId:1,ticket,readId:1,kind:"replay",offset:0});await turn();
  child.emit("message",{version:1,type:"read",requestId:1,ticket,readId:2,kind:"map",offset:0});await turn();
}
it("adapts the existing worker protocol and waits for actual process exit",async()=>{
  const child=new Child(),spawn=jest.fn(()=>child);
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,
    ()=>createLibraryAnalysisUtilityPort(spawn),async()=>({bytes:new Uint8Array([1]),done:true}));
  expect(child.postMessage.mock.calls.map(([value])=>value.type)).toEqual(["control","run"]);
  child.emit("message",{version:1,type:"result",requestId:1,ticket,status:"complete",metrics});
  let settled=false;const result=task.result.then(value=>{settled=true;return value;});await Promise.resolve();
  expect(settled).toBe(false);expect(child.kill).toHaveBeenCalledTimes(1);child.emit("exit",0);
  expect(await result).toEqual(metrics);expect(spawn).toHaveBeenCalledTimes(1);
});
it("fails unexpected exit and never restarts or reuses the viewer's owner",async()=>{
  const child=new Child(),spawn=jest.fn(()=>child);
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,
    ()=>createLibraryAnalysisUtilityPort(spawn),async()=>({bytes:new Uint8Array([1]),done:true}));
  const failed=expect(task.result).rejects.toThrow(/stopped.*7/);child.emit("exit",7);await failed;
  expect(spawn).toHaveBeenCalledTimes(1);expect(child.kill).not.toHaveBeenCalled();
});
it("native cancellation retains the utility until helper drainage and terminal acknowledgement",async()=>{
  const child=new Child(),broker=new LibraryNativeBroker();
  const port=createLibraryAnalysisUtilityPort(()=>child,{nativeBroker:broker,nativeExecutable:"D:/qa/engine.exe"});
  const bridge=new LibraryNativeBridge(value=>child.emit("message",value));
  child.postMessage.mockImplementation(value=>{bridge.receive(value);});
  port.postMessage({version:1,type:"run",requestId:1});
  let release!:()=>void;const native=bridge.run("timeline-performance",()=>new Promise<void>(resolve=>{release=resolve;}));
  await Promise.resolve();await Promise.resolve();
  let ended=false;const closed=Promise.resolve(port.terminate()).then(()=>{ended=true;});await Promise.resolve();
  expect(child.postMessage).toHaveBeenCalledWith({version:1,type:"cancel",requestId:1});expect(child.kill).not.toHaveBeenCalled();
  release();await native;expect(child.kill).not.toHaveBeenCalled();
  child.emit("message",{version:1,type:"result",requestId:1,status:"cancelled",error:"stop"});
  await new Promise(resolve=>setImmediate(resolve));expect(child.kill).toHaveBeenCalledTimes(1);expect(ended).toBe(false);
  child.emit("exit",0);await closed;expect(broker.status().error).toBeUndefined();await broker.close();
});
it("does not forward a parked control while its native helper remains active",async()=>{
  const child=new Child(),broker=new LibraryNativeBroker();
  const port=createLibraryAnalysisUtilityPort(()=>child,{nativeBroker:broker,nativeExecutable:"D:/qa/engine.exe"});
  const bridge=new LibraryNativeBridge(value=>child.emit("message",value));child.postMessage.mockImplementation(value=>{bridge.receive(value);});
  const receive=jest.fn();port.onmessage=receive;let release!:()=>void;
  const native=bridge.run("timeline-performance",()=>new Promise<void>(resolve=>{release=resolve;}));await Promise.resolve();await Promise.resolve();
  port.postMessage({version:1,type:"control",sequence:1,viewerDemand:true,userPaused:false});
  child.emit("message",{version:1,type:"control",sequence:1,requestId:1,state:"parked"});await Promise.resolve();expect(receive).not.toHaveBeenCalled();
  release();await native;await new Promise(resolve=>setImmediate(resolve));expect(receive).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({state:"parked"})}));
  const closed=port.terminate();await new Promise(resolve=>setImmediate(resolve));child.emit("exit",0);await closed;await broker.close();
});
it("fails closed if the utility exits while a native helper is unconfirmed",async()=>{
  const child=new Child(),broker=new LibraryNativeBroker();
  const port=createLibraryAnalysisUtilityPort(()=>child,{nativeBroker:broker,nativeExecutable:"D:/qa/engine.exe"});port.onerror=jest.fn();
  child.emit("message",{version:1,event:"native-request",id:1,phase:"timeline-performance"});
  child.emit("exit",7);expect(broker.status().error).toMatch(/unconfirmed/);
  await expect(broker.close()).rejects.toThrow(/unconfirmed/);
});
it.each(["configure-native","run"])("retains failed %s sends until actual utility exit",async type=>{
  const child=new Child(),broker=new LibraryNativeBroker();child.postMessage.mockImplementation(message=>{if(message.type===type)throw Error("send failed");});
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,
    ()=>createLibraryAnalysisUtilityPort(()=>child,{nativeBroker:broker,nativeExecutable:"D:/qa/engine.exe"}),async()=>({bytes:new Uint8Array([1]),done:true}));
  const failed=expect(task.result).rejects.toThrow("send failed");await new Promise(resolve=>setImmediate(resolve));
  expect(child.kill).toHaveBeenCalledTimes(1);child.emit("exit",0);await failed;await broker.close();
});

it("forwards ordered numerical, timeline and FC publications before the final result and actual exit",async()=>{
  const child=new Child(),spawn=jest.fn(()=>child),publish=jest.fn(async()=>true),timeline=jest.fn(async()=>true),fc=jest.fn(async()=>false);
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,
    ()=>createLibraryAnalysisUtilityPort(spawn),async()=>({bytes:new Uint8Array([1]),done:true}),publish,timeline,fc);
  let settled=false;const observed=task.result.then(value=>{settled=true;return value;},error=>error);
  try {
    expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:"run",publishFc:true}));
    await readOwnedInput(child);
    child.emit("message",{version:1,type:"numerical",requestId:1,ticket,metrics});await turn();
    child.emit("message",{version:1,type:"timeline",requestId:1,ticket,outcome:{error:"timeline unavailable"}});await turn();
    child.emit("message",{version:1,type:"fc",requestId:1,ticket,outcome:{error:"FC unavailable"}});await turn();
    expect(publish).toHaveBeenCalledTimes(1);expect(timeline).toHaveBeenCalledWith({error:"timeline unavailable"});expect(fc).toHaveBeenCalledWith({error:"FC unavailable"});
    expect(child.postMessage.mock.calls.filter(([m])=>m.type==="continue").map(([m])=>m.timeline)).toEqual([true,"fc",false]);
    expect(child.kill).not.toHaveBeenCalled();expect(settled).toBe(false);
    child.emit("message",{version:1,type:"result",requestId:1,ticket,status:"complete",metrics});await turn();
    expect(child.kill).toHaveBeenCalledTimes(1);expect(settled).toBe(false);child.emit("exit",0);
    expect(await observed).toEqual(metrics);expect(spawn).toHaveBeenCalledTimes(1);
  } finally {task.cancel();child.emit("exit",0);await observed;}
});

it("does not treat FC publication as a terminal drain and retains a lost FC receipt after cancellation",async()=>{
  const child=new Child(),broker=new LibraryNativeBroker(),abort=new AbortController();let reject!:(error:unknown)=>void;
  const fc=jest.fn(()=>new Promise<boolean>((_resolve,fail)=>{reject=fail;}));
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},abort.signal,
    ()=>createLibraryAnalysisUtilityPort(()=>child,{nativeBroker:broker,nativeExecutable:"D:/qa/engine.exe"}),
    async()=>({bytes:new Uint8Array([1]),done:true}),async()=>"fc",async()=>false,fc);
  let settled=false;const observed=task.result.catch(error=>{settled=true;return error;});
  try {
    await readOwnedInput(child);child.emit("message",{version:1,type:"numerical",requestId:1,ticket,metrics});await turn();
    child.emit("message",{version:1,type:"fc",requestId:1,ticket,outcome:{metrics}});await turn();expect(fc).toHaveBeenCalledTimes(1);
    abort.abort(Error("mode Off"));await turn();
    expect(child.postMessage).toHaveBeenCalledWith({version:1,type:"cancel",requestId:1});expect(child.kill).not.toHaveBeenCalled();expect(settled).toBe(false);
    child.emit("message",{version:1,type:"result",requestId:1,ticket,status:"cancelled",error:"stop"});await turn();
    expect(child.kill).toHaveBeenCalledTimes(1);child.emit("exit",0);await turn();expect(settled).toBe(false);
    reject(Error("FC publication receipt lost"));expect(await observed).toEqual(Error("FC publication receipt lost"));
    expect(child.postMessage.mock.calls.some(([m])=>m.type==="continue"&&m.timeline==="incidents")).toBe(false);
    expect(broker.status().error).toBeUndefined();
  } finally {task.cancel();reject?.(Error("cleanup"));child.emit("exit",0);await observed;await broker.close();}
});

function stripMetrics() {
  const value={...metrics,errorStrip:{state:"known",value:{version:1,timeBasis:"map-ms",ruleset:"lazer",mapStartMs:0,mapEndMs:1000000,
    evaluatedThrough:1000000,endpointBasis:"recorded-end",synthesizedEndpoint:false,ok:[],meh:[],miss:[],sliderEndMiss:[],
    componentMiss:Array.from({length:2048},(_,i)=>100000+i+.123456789)}}};
  validateLibraryErrorStrip(value.errorStrip);return value;
}
const complete=(value:unknown)=>({version:1,type:"result",requestId:1,ticket,status:"complete",metrics:value});

it("accepts a long-timestamp strip plus Unicode scalars above80KiB without losing terminal acknowledgement",async()=>{
  const child=new Child(),broker=new LibraryNativeBroker(),value={...stripMetrics(),provenance:{description:"漢".repeat(16000)}};
  expect(JSON.stringify({fields:value.fields,provenance:value.provenance}).length).toBeLessThanOrEqual(16384);
  expect(Buffer.byteLength(JSON.stringify(complete(value)))).toBeGreaterThan(80*1024);
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,
    ()=>createLibraryAnalysisUtilityPort(()=>child,{nativeBroker:broker,nativeExecutable:"D:/qa/engine.exe"}),async()=>({bytes:new Uint8Array([1]),done:true}));
  child.emit("message",complete(value));await turn();expect(child.kill).toHaveBeenCalledTimes(1);
  child.emit("exit",0);expect(await task.result).toEqual(value);await broker.close();
});

it("preserves bounded strips through numerical, timeline and FC publication before terminal exit",async()=>{
  const child=new Child(),value=stripMetrics(),publish=jest.fn(async()=>true),timeline=jest.fn(async()=>true),fc=jest.fn(async()=>false);
  const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,
    ()=>createLibraryAnalysisUtilityPort(()=>child),async()=>({bytes:new Uint8Array([1]),done:true}),publish,timeline,fc);
  await readOwnedInput(child);
  child.emit("message",{version:1,type:"numerical",requestId:1,ticket,metrics:value});await turn();
  child.emit("message",{version:1,type:"timeline",requestId:1,ticket,outcome:{metrics:value}});await turn();
  child.emit("message",{version:1,type:"fc",requestId:1,ticket,outcome:{metrics:value}});await turn();
  expect(publish).toHaveBeenCalledWith(value);expect(timeline).toHaveBeenCalledWith({metrics:value});expect(fc).toHaveBeenCalledWith({metrics:value});
  expect(child.kill).not.toHaveBeenCalled();child.emit("message",complete(value));child.emit("exit",0);
  expect(await task.result).toEqual(value);
});

it.each(["wrong-version","wrong-request","wrong-type","native","control","error-status","malformed-fields","invalid-strip","extra-ticket","array-slot","array-state","extra-envelope","over128KiB"])(
  "retains the24KiB boundary for oversized %s messages",async kind=>{
    const child=new Child(),port=createLibraryAnalysisUtilityPort(()=>child),received=jest.fn(),error=jest.fn();port.onmessage=received;port.onerror=error;
    const message:Record<string,unknown>=complete(stripMetrics());
    if(kind==="wrong-version")message.version=2;
    if(kind==="wrong-request")message.requestId=2;
    if(kind==="wrong-type")message.type="unrelated";
    if(kind==="native")message.event="native-request";
    if(kind==="control")message.type="control";
    if(kind==="error-status")message.status="error";
    if(kind==="malformed-fields")message.metrics={fields:{fc:"x".repeat(30*1024)},provenance:{}};
    if(kind==="invalid-strip")(message.metrics as ReturnType<typeof stripMetrics>).errorStrip.value.componentMiss.push(NaN);
    if(kind==="extra-ticket")message.ticket={...ticket,padding:"unexpected"};
    if(kind==="array-slot")message.ticket={...ticket,slot:["numerical"]};
    if(kind==="array-state")message.metrics={...stripMetrics(),fields:{fc:{state:["unknown"],reason:"unavailable"}}};
    if(kind==="extra-envelope")message.padding="unexpected";
    if(kind==="over128KiB")message.metrics={...stripMetrics(),provenance:{description:"x".repeat(128*1024)}};
    expect(Buffer.byteLength(JSON.stringify(message))).toBeGreaterThan(24*1024);child.emit("message",message);
    expect(received).not.toHaveBeenCalled();expect(error).toHaveBeenCalledWith(expect.objectContaining({message:"Invalid library analysis utility response"}));
    const closed=port.terminate();child.emit("exit",0);await closed;
  });

it("does not treat a large valid terminal as native drainage or substitute kill for actual exit",async()=>{
  const child=new Child(),broker=new LibraryNativeBroker(),port=createLibraryAnalysisUtilityPort(()=>child,{nativeBroker:broker,nativeExecutable:"D:/qa/engine.exe"});
  port.postMessage({version:1,type:"run",requestId:1});child.emit("message",{version:1,event:"native-request",id:1,phase:"timeline-performance"});
  child.emit("message",complete(stripMetrics()));let settled=false;const closed=Promise.resolve(port.terminate()).then(()=>{settled=true;});
  await turn();expect(child.kill).not.toHaveBeenCalled();expect(broker.status().active).toBe(1);
  child.emit("message",{version:1,event:"native-release",id:1,drained:true});await turn();
  expect(child.kill).toHaveBeenCalledTimes(1);expect(settled).toBe(false);child.emit("exit",0);await closed;await broker.close();
});

it("still fails closed after five seconds when a large terminal leaves its native lease undrained",async()=>{
  jest.useFakeTimers();const child=new Child(),broker=new LibraryNativeBroker();
  try {
    const port=createLibraryAnalysisUtilityPort(()=>child,{nativeBroker:broker,nativeExecutable:"D:/qa/engine.exe"});
    port.postMessage({version:1,type:"run",requestId:1});child.emit("message",{version:1,event:"native-request",id:1,phase:"timeline-performance"});
    child.emit("message",complete(stripMetrics()));let settled=false;
    const closed=Promise.resolve(port.terminate()).then(()=>{settled=true;return undefined;},error=>{settled=true;return error;});
    await jest.advanceTimersByTimeAsync(4999);expect(child.kill).not.toHaveBeenCalled();expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2);expect(child.kill).toHaveBeenCalledTimes(1);expect(settled).toBe(false);
    child.emit("exit",0);const failure=await closed;expect(failure.message).toMatch(/^Library analysis native shutdown was not confirmed \[v1 /);
    expect(failure.message).toContain("terminalAtDeadline=complete nativeDrainAtDeadline=pending");
    expect(failure.message).toContain("nativeDrainFinal=rejected utilityExit=0");
    await expect(broker.close()).rejects.toThrow(/unconfirmed/);
  } finally {jest.useRealTimers();}
});

it.each(["terminal","drain","both"])("retains shutdown diagnostic deadline/final witnesses for missing %s",async missing=>{
  jest.useFakeTimers();const child=new Child(),broker=new LibraryNativeBroker(),abort=new AbortController();
  try {
    const task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},abort.signal,
      ()=>createLibraryAnalysisUtilityPort(()=>child,{nativeBroker:broker,nativeExecutable:"D:/private/source/engine.exe"}),async()=>({bytes:new Uint8Array([1]),done:true}));
    let settled=false;const observed=task.result.catch(error=>{settled=true;return error;});
    if(missing!=="terminal")child.emit("message",{version:1,event:"native-request",id:1,phase:"timeline-performance"});
    if(missing==="drain")child.emit("message",complete(metrics));
    else if(missing==="terminal")child.emit("message","invalid protocol");
    else abort.abort(Object.assign(Error('D:\\private folder\\play.osr \\server\\share file:///private/play /home/private/play '+"x".repeat(3000)),{code:"EACCES"}));
    await jest.advanceTimersByTimeAsync(4999);expect(child.kill).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2);expect(child.kill).toHaveBeenCalledTimes(1);expect(settled).toBe(false);
    if(missing!=="terminal")child.emit("message",{version:1,event:"native-release",id:1,drained:true});
    if(missing==="both")child.emit("message",{version:1,type:"result",requestId:1,status:"cancelled",error:"private late error"});
    child.emit("exit",missing==="terminal"?7:0);const failure=await observed;
    expect(failure.message).toMatch(/^Library analysis native shutdown was not confirmed \[v1 /);
    expect(failure.message).toContain(`terminalAtDeadline=${missing==="drain"?"complete":"pending"}`);
    expect(failure.message).toContain(`nativeDrainAtDeadline=${missing==="terminal"?"confirmed":"pending"}`);
    expect(failure.message).toContain(`terminalFinal=${missing==="terminal"?"exit-only":missing==="both"?"cancelled":"complete"}`);
    expect(failure.message).toContain("nativeDrainFinal=confirmed");expect(failure.message).toContain(`utilityExit=${missing==="terminal"?7:0}`);
    expect(failure.message).toContain(`trigger=${missing==="drain"?"none":missing==="both"?"abort":"worker-error"}`);
    if(missing==="both")expect(failure.message).toContain("code=EACCES");
    expect(failure.message.length).toBeLessThan(1536);expect(JSON.stringify(failure)).not.toMatch(/private|play\.osr|server|home/);
    expect(failure.message).not.toMatch(/private|play\.osr|server|home/);await broker.close();
  } finally {jest.useRealTimers();}
});

it.each([3125,3105,"byte-limit"] as const)("retains every dense %s mark through utility numerical publication and normal exit",async count=>{
  const child=new Child(),value=stripMetrics();value.errorStrip.value.componentMiss=[];
  const marks=count==="byte-limit"?Math.floor((65536-Buffer.byteLength(JSON.stringify(value.errorStrip))+1)/2):count;
  value.errorStrip.value.componentMiss=Array(marks).fill(0);validateLibraryErrorStrip(value.errorStrip);
  expect(Buffer.byteLength(JSON.stringify(complete(value)))).toBeLessThan(128*1024);
  const publish=jest.fn(async()=>false),task=startLibraryNumerical(ticket,input,{viewerDemand:false,userPaused:false},new AbortController().signal,
    ()=>createLibraryAnalysisUtilityPort(()=>child),async()=>({bytes:new Uint8Array([1]),done:true}),publish);
  await readOwnedInput(child);child.emit("message",{version:1,type:"numerical",requestId:1,ticket,metrics:value});await turn();
  expect(publish).toHaveBeenCalledWith(value);child.emit("message",complete(value));child.emit("exit",0);
  expect(await task.result).toEqual(value);expect(value.errorStrip.value.componentMiss).toHaveLength(marks);
});
