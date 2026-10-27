import { LibraryNativeBroker, LibraryNativeBridge } from "./library-native-admission";
import { calculateLibraryPerformance,calculateLibraryTimeline } from "./library-performance-native";
import { PerformanceWorkerDrainError } from "../performance-worker";
import type { PerformanceRequest,PerformanceResponse } from "@rewind/osu-performance/protocol";
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const request:PerformanceRequest={beatmap:"map",calculations:[{mode:"stable",scope:"full-map",mods:[],states:[]}]};
function peer(broker:LibraryNativeBroker){const endpoint=broker.attach(value=>queueMicrotask(()=>bridge.receive(value)));
  const bridge=new LibraryNativeBridge(value=>queueMicrotask(()=>endpoint.receive(value)));return{bridge,endpoint};}
it("holds shared admission through actual drainage after calculation completion",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker),b=peer(broker);let drain!:()=>void;
  const worker={calculate:jest.fn(async():Promise<PerformanceResponse>=>({ok:true})),cancel:jest.fn(),disposeAndDrain:()=>new Promise<void>(resolve=>{drain=resolve;})};
  const work=calculateLibraryPerformance(()=>"engine",a.bridge,request,undefined,()=>worker);await tick();
  let held=false;const hold=broker.setViewerDemand(true).then(()=>{held=true;});const other=jest.fn(async()=>42),queued=b.bridge.run("source-page",other);
  await tick();expect(held).toBe(false);expect(other).not.toHaveBeenCalled();drain();expect(await work).toEqual({ok:true});await hold;
  expect(other).not.toHaveBeenCalled();await broker.setViewerDemand(false);expect(await queued).toBe(42);await broker.close();
});
it("never creates a worker when cancellation occurs before admission",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker);await broker.setViewerDemand(true);const abort=new AbortController(),factory=jest.fn();
  const work=calculateLibraryPerformance(()=>"engine",a.bridge,request,abort.signal,factory),failure=expect(work).rejects.toThrow("stop");
  await tick();abort.abort(new Error("stop"));await failure;expect(factory).not.toHaveBeenCalled();await broker.close();
});
it("cancels only its independent worker and waits for close before reporting cancellation",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker),abort=new AbortController();let resolve!:(value:PerformanceResponse)=>void,drain!:()=>void;
  const worker={calculate:()=>new Promise<PerformanceResponse>(done=>{resolve=done;}),cancel:jest.fn(()=>resolve({ok:false,error:"cancelled"})),
    disposeAndDrain:()=>new Promise<void>(done=>{drain=done;})};
  let ended=false;const work=calculateLibraryPerformance(()=>"engine",a.bridge,request,abort.signal,()=>worker).finally(()=>{ended=true;});
  const failure=expect(work).rejects.toThrow("stop");await tick();abort.abort(new Error("stop"));await tick();
  expect(worker.cancel).toHaveBeenCalledTimes(1);expect(ended).toBe(false);expect(broker.status().active).toBe(1);
  drain();await failure;await tick();expect(broker.status().active).toBe(0);await broker.close();
});
it("poisons native admission when a calculation finished but helper exit is uncertain",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker),b=peer(broker);
  const worker={calculate:async():Promise<PerformanceResponse>=>({ok:true}),cancel:jest.fn(),
    disposeAndDrain:async()=>{throw new PerformanceWorkerDrainError("exit not confirmed");}};
  await expect(calculateLibraryPerformance(()=>"engine",a.bridge,request,undefined,()=>worker)).rejects.toThrow(/exit not confirmed/);
  await tick();await expect(b.bridge.run("source-page",async()=>1)).rejects.toThrow(/exit not confirmed/);await expect(broker.close()).rejects.toThrow();
});
it("keeps timeline admission separate from bounded P and drains before release",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker);let drained=false;
  const worker={calculate:jest.fn(async():Promise<PerformanceResponse>=>({ok:true})),cancel:jest.fn(),disposeAndDrain:async()=>{drained=true;}};
  const timeline:PerformanceRequest={beatmap:"map",calculations:[{mode:"stable",mods:[],states:[]}]};
  await expect(calculateLibraryPerformance(()=>"engine",a.bridge,timeline,undefined,()=>worker)).rejects.toThrow(/bounded full-map/);
  await expect(calculateLibraryTimeline(()=>"engine",a.bridge,request,undefined,()=>worker)).rejects.toThrow(/timeline/);
  expect(await calculateLibraryTimeline(()=>"engine",a.bridge,timeline,undefined,()=>worker)).toEqual({ok:true});
  expect(drained).toBe(true);expect(worker.calculate).toHaveBeenCalledTimes(1);await tick();expect(broker.status().active).toBe(0);await broker.close();
});
it("rejects oversized timelines without spawning or dropping states",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker),factory=jest.fn();
  const timeline:PerformanceRequest={beatmap:"x".repeat(32*1024*1024),calculations:[{mode:"stable",mods:[],states:[]}]};
  await expect(calculateLibraryTimeline(()=>"engine",a.bridge,timeline,undefined,factory)).rejects.toThrow(/too large/);
  expect(factory).not.toHaveBeenCalled();expect(broker.status().active).toBe(0);await broker.close();
});
