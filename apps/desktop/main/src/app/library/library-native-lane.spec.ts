import { LibraryNativeLane } from "./library-native-lane";
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
it("serializes background native phases until actual work drains and removes queued cancellation",async()=>{
  const lane=new LibraryNativeLane(),first=deferred(),events:string[]=[],abort=new AbortController();
  const a=lane.run(async()=>{events.push("a");await first.promise;events.push("a-exit");},new AbortController().signal);
  const b=lane.run(async()=>{events.push("b");},abort.signal);const failure=expect(b).rejects.toMatchObject({name:"AbortError"});abort.abort();await failure;
  const c=lane.run(async()=>{events.push("c");},new AbortController().signal);
  await Promise.resolve();expect(events).toEqual(["a"]);expect(lane.status()).toMatchObject({active:1,queued:1});
  first.resolve();await Promise.all([a,c]);expect(events).toEqual(["a","a-exit","c"]);expect(lane.status()).toMatchObject({active:0,queued:0});
});
it("bounds admission and closes only after active native ownership drains",async()=>{
  const lane=new LibraryNativeLane(1),active=deferred();
  const a=lane.run(()=>active.promise,new AbortController().signal),b=lane.run(async()=>undefined,new AbortController().signal);
  await expect(lane.run(async()=>undefined,new AbortController().signal)).rejects.toThrow(/busy/i);
  const rejected=expect(b).rejects.toThrow(/closed/i);let closed=false;const closing=lane.close().then(()=>{closed=true;});
  await rejected;expect(closed).toBe(false);active.resolve();await a;await closing;expect(closed).toBe(true);
});
