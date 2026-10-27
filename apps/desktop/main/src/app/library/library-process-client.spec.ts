import { EventEmitter } from "events";
import { LibraryProcessClient } from "./library-process-client";
import type { LibraryServiceConfiguration } from "./library-service";
import { LibraryNativeBroker } from "./library-native-admission";

class Child extends EventEmitter {
  sent: { version: number; id: string; method: string; args: unknown }[] = [];
  postMessage(value: Child["sent"][number]) { this.sent.push(value); }
  kill = jest.fn(() => { queueMicrotask(() => this.emit("exit", 1)); return true; });
  answer(method: string, data: unknown = null) {
    const request = this.sent.filter(item => item.method === method).at(-1)!;
    if (!request) throw Error("No request for " + method);
    this.emit("message", { version: 1, id: request.id, ok: true, data });
  }
}
const config: LibraryServiceConfiguration = { directory: "D:\\qa\\library", nativeExecutable: "D:\\engine.exe", sessionId: "session", sources: [] };
const turn = () => new Promise(resolve => setImmediate(resolve));
it("scoped resources cross the utility boundary and invalid extensions degrade to a base change", async () => {
  const child = new Child(), client = new LibraryProcessClient(() => child, config), notify = jest.fn(); client.onLibraryChanged(notify);
  const ready = client.start(); child.answer("viewer-demand"); child.answer("initialize"); await ready;
  try {
    const base = { version: 1, event: "library-changed", ready: true, resourceRevision: "9" };
    const resourceChanges = { from: "7", to: "9", scope: "replays", replayIds: ["one"] };
    child.emit("message", { ...base, revision: 1, resourceChanges });
    child.emit("message", { ...base, revision: 2, resourceChanges: { ...resourceChanges, from: "10" } });
    expect(notify.mock.calls).toEqual([[{ ...base, revision: 1, resourceChanges }], [{ ...base, revision: 2 }]]);
  } finally { const close = client.close(); child.answer("close"); await close; }
});
it("binds artwork queue preference from trusted main options only",async()=>{
  const broker=new LibraryNativeBroker(),active=broker.attach(()=>undefined),backgroundReplies:unknown[]=[],background=broker.attach(reply=>backgroundReplies.push(reply));
  active.receive({version:1,event:"native-request",id:1,phase:"map-performance"});
  background.receive({version:1,event:"native-request",id:1,phase:"replay-decode"});
  const child=new Child(),options={nativeBroker:broker,foreground:true,nativePriority:"artwork" as const},client=new LibraryProcessClient(()=>child,config,options);
  const ready=client.start();child.answer("initialize");await ready;
  child.emit("message",{version:1,event:"native-request",id:1,phase:"source-resolve"});
  active.receive({version:1,event:"native-release",id:1,drained:true});
  expect(child.sent.at(-1)).toMatchObject({nativeReply:1,state:"granted"});expect(backgroundReplies).toEqual([]);
  child.emit("message",{version:1,event:"native-release",id:1,drained:true});
  expect(backgroundReplies).toEqual([expect.objectContaining({state:"granted"})]);background.receive({version:1,event:"native-release",id:1,drained:true});
  const close=client.close();child.answer("close");await close;await broker.close();
});
it("manual feedback forwards only a true status-only flag without posting work", async () => {
  const child = new Child(), client = new LibraryProcessClient(() => child, config), notify = jest.fn(); client.onLibraryChanged(notify);
  const ready = client.start(); child.answer("viewer-demand"); child.answer("initialize"); await ready;
  const before = child.sent.length, event = { version: 1, event: "library-changed", revision: 1, ready: true, resourceRevision: "7", statusOnly: true };
  try {
    child.emit("message", event); child.emit("message", { ...event, revision: 2, statusOnly: false });
    expect(notify.mock.calls).toEqual([[event]]); expect(child.sent).toHaveLength(before);
  } finally { const close = client.close(); child.answer("close"); await close; }
});
it("checks current document authority after initialization immediately before posting",async()=>{
  const child=new Child(),client=new LibraryProcessClient(()=>child,config),order:string[]=[];
  const api=client;
  const original=child.postMessage.bind(child);child.postMessage=value=>{order.push(value.method);original(value);};
  const guard=jest.fn(()=>{order.push("guard");});
  const pending=api.request("current-replay-store-publish",{authority:{},results:[]},guard);expect(guard).not.toHaveBeenCalled();
  child.answer("viewer-demand");child.answer("initialize");await turn();
  expect(order.slice(-2)).toEqual(["guard","current-replay-store-publish"]);expect(guard).toHaveBeenCalledTimes(1);
  child.answer("current-replay-store-publish",{state:"stale",accepted:[]});await pending;
  const close=client.close();child.answer("close");await close;
});
it("rejects an obsolete unsent publication and frees its pending slot after guard failure",async()=>{
  const child=new Child(),client=new LibraryProcessClient(()=>child,config),fault=Error("Document changed");
  const api=client;
  const result=api.request("current-replay-store-publish",{authority:{},results:[]},()=>{throw fault;}).catch(error=>error);
  child.answer("viewer-demand");child.answer("initialize");expect(await result).toBe(fault);
  expect(child.sent.some(message=>message.method==="current-replay-store-publish")).toBe(false);
  // Rejected unsent attempts do not accumulate pending entries or poison the healthy owner.
  for(let n=0;n<70;n++)expect(await api.request("current-replay-store-publish",{},()=>{throw fault;}).catch(error=>error)).toBe(fault);
  const release=api.request("current-replay-store-release",{authority:{}},()=>undefined);await turn();child.answer("current-replay-store-release");await release;
  const close=client.close();child.answer("close");await close;
});
it.each(["library-query-invalidated","library-query-limit","library-query-updating"])("preserves the known passive-query error code %s",async code=>{
  const child=new Child(),client=new LibraryProcessClient(()=>child,config);const ready=client.start();child.answer("viewer-demand");child.answer("initialize");await ready;
  const result=client.request("query-page",{}).catch(error=>error);await turn();
  const sent=child.sent.at(-1);child.emit("message",{version:1,id:sent?.id,ok:false,error:"Query needs refresh",errorCode:code});
  expect(await result).toMatchObject({message:"Query needs refresh",code});const close=client.close();child.answer("close");await close;
});
it("does not reconstruct arbitrary error codes",async()=>{
  const child=new Child(),client=new LibraryProcessClient(()=>child,config);const ready=client.start();child.answer("viewer-demand");child.answer("initialize");await ready;
  const result=client.request("query-page",{}).catch(error=>error);await turn();const sent=child.sent.at(-1);
  child.emit("message",{version:1,id:sent?.id,ok:false,error:"failure",errorCode:"arbitrary-code"});expect(await result).not.toHaveProperty("code");
  const close=client.close();child.answer("close");await close;
});
it("delivers monotonic library readiness changes without polling or rejecting malformed notifications",async()=>{
  const child=new Child(),client=new LibraryProcessClient(()=>child,config),notify=jest.fn();
  const unsubscribe=client.onLibraryChanged(notify);
  const ready=client.start();child.answer("viewer-demand");child.answer("initialize");await ready;const count=child.sent.length;
  const first={version:1,event:"library-changed",revision:1,ready:false};child.emit("message",first);
  child.emit("message",{...first,revision:3,ready:true});child.emit("message",{...first,revision:2});child.emit("message",{...first,revision:3,ready:false});
  for(const bad of [{...first,revision:4,ready:"yes"},{...first,revision:4,extra:"path"},{...first,revision:Number.MAX_SAFE_INTEGER+1},{...first,version:2}])child.emit("message",bad);
  expect(notify.mock.calls).toEqual([[first],[{...first,revision:3,ready:true}]]);expect(child.sent).toHaveLength(count);expect(child.kill).not.toHaveBeenCalled();
  unsubscribe();child.emit("message",{...first,revision:5,ready:false});expect(notify).toHaveBeenCalledTimes(2);
  const close=client.close();child.answer("close");await close;
});
it("routes native leases separately and waits actual phase release before acknowledging viewer hold",async()=>{
  const broker=new LibraryNativeBroker(),child=new Child(),client=new LibraryProcessClient(()=>child,config,{nativeBroker:broker});
  const ready=client.start();child.answer("viewer-demand");child.answer("initialize");await ready;
  child.emit("message",{version:1,event:"native-request",id:1,phase:"source-page"});expect(child.sent.at(-1)).toMatchObject({nativeReply:1,state:"granted"});
  let held=false;const holding=client.setViewerDemand(true).then(()=>{held=true;});await turn();child.answer("viewer-demand");await turn();expect(held).toBe(false);
  child.emit("message",{version:1,event:"native-release",id:1,drained:true});await holding;expect(held).toBe(true);
  const closing=client.close();child.answer("close");child.emit("exit",0);await closing;await broker.close();
});
it("coalesces viewer hold bursts with an active native phase and keeps the final hold pending",async()=>{
  const broker=new LibraryNativeBroker(),child=new Child(),client=new LibraryProcessClient(()=>child,config,{nativeBroker:broker});
  const ready=client.start();child.answer("viewer-demand");child.answer("initialize");await ready;
  child.emit("message",{version:1,event:"native-request",id:1,phase:"source-page"});
  const holds=Array.from({length:100},(_,index)=>client.setViewerDemand(index%2===0||index===99));let settled=false;
  const all=Promise.all(holds).then(()=>{settled=true;});child.answer("viewer-demand");await turn();expect(settled).toBe(false);expect(child.kill).not.toHaveBeenCalled();
  child.emit("message",{version:1,event:"native-release",id:1,drained:true});await all;
  const closing=client.close();child.answer("close");child.emit("exit",0);await closing;await broker.close();
});
it("fails the owning transport after a native grant cannot be delivered, retaining uncertainty",async()=>{
  const broker=new LibraryNativeBroker(),child=new Child(),client=new LibraryProcessClient(()=>child,config,{nativeBroker:broker});
  const ready=client.start();child.answer("viewer-demand");child.answer("initialize");await ready;
  const send=child.postMessage.bind(child);child.postMessage=value=>{if("nativeReply"in value)throw new Error("grant pipe failed");send(value);};
  const scan=client.request("scan",{sourceId:"native"}).catch(error=>error.message);await turn();
  child.emit("message",{version:1,event:"native-request",id:1,phase:"source-page"});await turn();
  try{expect(child.kill).toHaveBeenCalledTimes(1);}finally{child.emit("exit",1);await client.close();}
  expect(await scan).toMatch(/transport/);await expect(broker.close()).rejects.toThrow(/transport/);
});
it("delivers bounded dirty events once and acknowledges without ordinary admission",async()=>{
  const child=new Child(),client=new LibraryProcessClient(()=>child,config),notify=jest.fn();client.onAnalysisDirty(notify);
  const ready=client.start();child.answer("viewer-demand");child.answer("initialize");await ready;
  child.emit("message",{version:1,event:"analysis-dirty",revision:1,flags:1});await turn();
  expect(notify).toHaveBeenCalledWith(1);expect(child.sent.at(-1)).toMatchObject({method:"analysis-dirty-ack",args:{revision:1}});child.answer("analysis-dirty-ack");
  child.emit("message",{version:1,event:"analysis-dirty",revision:1,flags:1});expect(notify).toHaveBeenCalledTimes(1);
  const closing=client.close();child.answer("close");child.emit("exit",0);await closing;
});

it("keeps foreground resource ownership independent and accepts only bounded binary chunks", async () => {
  const child = new Child(), client = new LibraryProcessClient<"chunk" | "release", { nativeExecutable: string }>(() => child,
    { nativeExecutable: "D:\\engine.exe" }, { foreground: true });
  const start = client.start(); expect(child.sent.map(value => value.method)).toEqual(["initialize"]);
  child.answer("initialize"); await start;
  const pending = client.request("chunk", { sessionId: "one" }); await turn();
  const bytes = new Uint8Array(256 * 1024); child.answer("chunk", { bytes, done: true });
  await expect(pending).resolves.toEqual({ bytes, done: true });
  const invalid = client.request("chunk").catch(error => error.message); await turn();
  child.answer("chunk", { bytes: new Uint8Array(256 * 1024 + 1), done: true });
  expect(await invalid).toMatch(/protocol/); await client.close();
});

it("bounds ordinary requests even while initialization is parked", async () => {
  const child = new Child(), client = new LibraryProcessClient(() => child, config);
  const requests = Array.from({ length: 32 }, () => client.request("scan", { sourceId: "a" }).catch(error => error.message));
  await expect(client.request("import", { paths: [] })).rejects.toThrow(/busy/);
  child.emit("exit", 1); await Promise.all(requests); await client.close();
});

it("closes admission before initialization and controls a parked recovery without waiting for it", async () => {
  const child = new Child(), spawn = jest.fn(() => child);
  const client = new LibraryProcessClient(spawn, config);
  await client.setViewerDemand(true); expect(spawn).not.toHaveBeenCalled();
  const start = client.start();
  expect(child.sent.map(item => item.method)).toEqual(["viewer-demand", "initialize"]);
  expect(child.sent[0].args).toEqual({ active: true });
  child.answer("viewer-demand");
  const resumed = client.setViewerDemand(false);
  await turn();
  expect(child.sent.at(-1)?.method).toBe("viewer-demand");
  child.answer("viewer-demand"); await resumed;
  child.answer("initialize", { replayCount: 0 }); await start;
  const close = client.close(); child.answer("close"); child.emit("exit", 0); await close;
});

it("coalesces demand changes and bounds stops before initialization", async () => {
  const child = new Child(), client = new LibraryProcessClient(() => child, config);
  const start = client.start();
  const sameStop = client.request("stop", { sourceId: "a" }).catch(error => error.message);
  const duplicateStop = client.request("stop", { sourceId: "a" }).catch(error => error.message);
  const stops = Array.from({ length: 15 }, (_, i) => client.request("stop", { sourceId: String(i) }).catch(error => error.message));
  await expect(client.request("stop", { sourceId: "excess" })).rejects.toThrow(/busy/);
  const demands = Array.from({ length: 100 }, (_, i) => client.setViewerDemand(i % 2 === 0));
  expect(child.sent.filter(item => item.method === "viewer-demand")).toHaveLength(1);
  child.answer("viewer-demand"); await Promise.all(demands);
  child.answer("initialize"); await start; await turn();
  expect(child.sent.filter(item => item.method === "stop")).toHaveLength(16);
  child.emit("exit", 1); await Promise.all([sameStop, duplicateStop, ...stops]); await client.close();
});

it("shares status requests, bounds queued mutations and never replays them after a crash", async () => {
  const child = new Child(), spawn = jest.fn(() => child), client = new LibraryProcessClient(spawn, config);
  const start = client.start(); child.answer("viewer-demand"); child.answer("initialize"); await start;
  const statuses = [client.request("status"), client.request("status")]; await turn();
  expect(child.sent.filter(item => item.method === "status")).toHaveLength(1);
  child.answer("status", { replayCount: 1 }); await expect(Promise.all(statuses)).resolves.toEqual([{ replayCount: 1 }, { replayCount: 1 }]);
  const requests = Array.from({ length: 32 }, () => client.request("scan", { sourceId: "a" }).catch(error => error.message));
  await turn(); await expect(client.request("scan", { sourceId: "b" })).rejects.toThrow(/busy/);
  child.emit("exit", 9); expect((await Promise.all(requests)).every(message => typeof message === "string" && /stopped/.test(message))).toBe(true);
  await expect(client.request("status")).rejects.toThrow(/stopped/); expect(spawn).toHaveBeenCalledTimes(1);
  await client.close();
});

it("does not report close complete before actual child exit and cancels outstanding work", async () => {
  const child = new Child(), client = new LibraryProcessClient(() => child, config);
  child.kill.mockImplementation(() => true);
  const start = client.start(); child.answer("viewer-demand"); child.answer("initialize"); await start;
  const work = client.request("import", { paths: ["D:\\a.osr"] }).catch(error => error.message); await turn();
  let closed = false; const close = client.close().then(() => { closed = true; }); child.answer("close"); await turn();
  expect(closed).toBe(false); child.emit("exit", 0); await close;
  expect(await work).toMatch(/closed/); expect(child.kill).toHaveBeenCalledTimes(1);
});

it("rejects stale/invalid protocol replies without applying them as results", async () => {
  const child = new Child(), client = new LibraryProcessClient(() => child, config);
  const start = client.start(); child.answer("viewer-demand"); child.answer("initialize"); await start;
  const result = client.request("status").catch(error => error.message); await turn();
  child.emit("message", { version: 1, id: "old", ok: true, data: "ignored" });
  const id = child.sent.at(-1)!.id;
  child.emit("message", { version: 2, id, ok: true });
  expect(await result).toMatch(/protocol/); await client.close(); expect(child.kill).toHaveBeenCalledTimes(1);
});

it("reports a failed drain after observing the terminated child", async () => {
  const child = new Child(), client = new LibraryProcessClient(() => child, config);
  const start = client.start(); child.answer("viewer-demand"); child.answer("initialize"); await start;
  const close = client.close();
  child.emit("message", { version: 1, id: child.sent.at(-1)!.id, ok: false, error: "SQLite cleanup failed" });
  await expect(close).rejects.toThrow(/SQLite cleanup/); expect(child.kill).toHaveBeenCalledTimes(1);
});

it("reports shutdown timeout even when forced termination succeeds", async () => {
  jest.useFakeTimers({ doNotFake: ["setImmediate", "queueMicrotask"] });
  try {
    const child = new Child(), client = new LibraryProcessClient(() => child, config);
    const start = client.start(); child.answer("viewer-demand"); child.answer("initialize"); await start;
    const close = client.close(); const result = close.catch(error => error.message);
    jest.advanceTimersByTime(5000);
    expect(await result).toMatch(/timed out/); expect(child.kill).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

it("delivers a demand change queued exactly when the earlier pump settles", async () => {
  const child = new Child(), client = new LibraryProcessClient(() => child, config);
  const start = client.start();
  child.answer("viewer-demand");
  let changed!: Promise<void>;
  queueMicrotask(() => { changed = client.setViewerDemand(true); });
  child.answer("initialize"); await start; await turn();
  expect(child.sent.filter(item => item.method === "viewer-demand")).toHaveLength(2);
  expect(child.sent.filter(item => item.method === "viewer-demand").at(-1)?.args).toEqual({ active: true });
  child.answer("viewer-demand"); await changed;
  const close = client.close(); child.answer("close"); await close;
});

it("waits for drain acknowledgement when shutdown supersedes a demand follow-up", async () => {
  const child = new Child(), client = new LibraryProcessClient(() => child, config);
  const start = client.start().catch(error => error.message);
  const demand = client.setViewerDemand(true).catch(error => error.message);
  const close = client.close();
  child.answer("viewer-demand"); await turn();
  expect(child.kill).not.toHaveBeenCalled();
  child.answer("close"); await close; await start; await demand;
});

it.each(["incidents-probe-context","incidents-commit","incident-preparation-context","incident-preparation-commit"] as const)("rejects retired %s before spawning a utility",async method=>{
  const spawn=jest.fn(()=>new Child()),client=new LibraryProcessClient(spawn,config);
  await expect(client.request(method,{})).rejects.toThrow(/retired/);expect(spawn).not.toHaveBeenCalled();await client.close();
});
