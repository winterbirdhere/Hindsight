import { BehaviorSubject } from "rxjs";
import { LibraryClient } from "./library-client";
import type { LibraryChangedEvent, LibraryRequest } from "../../../../../shared/replay-library";

it("scoped resources forward bounded evidence and preserve a valid change when its extension is malformed", () => {
  let notify!: (event: LibraryChangedEvent) => void;
  const client = new LibraryClient({ request: async () => null, demand: async () => undefined,
    onChanged: listener => { notify = listener; return () => undefined; } });
  const events: LibraryChangedEvent[] = []; client.changes$.subscribe(event => events.push(event));
  const scope = { from: "1:7", to: "1:9", scope: "replays", replayIds: ["one"] };
  notify({ revision: 1, ready: false, resourceRevision: "1:9", resourceChanges: scope } as LibraryChangedEvent);
  notify({ revision: 2, ready: true, resourceRevision: "1:10", resourceChanges: { ...scope, replayIds: [["one"]] } } as unknown as LibraryChangedEvent);
  expect(events).toEqual([{ revision: 1, ready: false, resourceRevision: "1:9", resourceChanges: scope },
    { revision: 2, ready: true, resourceRevision: "1:10" }]); client.dispose();
});

function fixture() {
  const api = { request: jest.fn(async (_request: LibraryRequest):Promise<unknown> => null), demand: jest.fn(async (_active: boolean) => undefined) };
  const folder = { settings$: new BehaviorSubject({ osuStablePath: "D:\\osu" }), getOsuFolder: () => folder.settings$.value.osuStablePath,
    whenReady: jest.fn(async () => "D:\\maps") };
  const load = new BehaviorSubject({ phase: "idle" }), clip = new BehaviorSubject({ status: "idle" });
  const analyzer = { osuFolderService: folder, scenarioManager: { loadState$: load }, clipRecorder: { state$: clip, get isBusy() { return clip.value.status === "recording"; } } };
  const client = new LibraryClient(api); client.connect(analyzer);
  return { client, api, folder, load, clip };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
it("manual feedback status: passes only the literal status-only marker with monotonic revisions", () => {
  let notify!: (event: LibraryChangedEvent) => void;
  const api = {
    request: jest.fn(async () => null), demand: jest.fn(async () => undefined),
    onChanged: (listener: typeof notify) => { notify = listener; return () => undefined; },
  };
  const client = new LibraryClient(api), events: LibraryChangedEvent[] = [];
  client.changes$.subscribe(event => events.push(event));
  notify({ revision: 1, ready: true, resourceRevision: "1:7" });
  const progress = { revision: 2, ready: false, resourceRevision: "1:7", statusOnly: true as const };
  notify({ ...progress, statusOnly: "true" } as unknown as LibraryChangedEvent);
  notify(progress);
  notify(progress);
  notify({ revision: 3, ready: true, resourceRevision: "1:8" });
  expect(events).toEqual([{ revision: 1, ready: true, resourceRevision: "1:7" }, progress,
    { revision: 3, ready: true, resourceRevision: "1:8" }]);
  expect(api.request).not.toHaveBeenCalled();
  expect(api.demand).not.toHaveBeenCalled();
  client.dispose();
});

it.each(["library-query-invalidated","library-query-limit","library-query-updating"])("restores known query code %s without marking the connection failed",async code=>{
  const f=fixture();await f.client.whenReady();f.api.request.mockResolvedValueOnce({libraryQueryError:{code,message:"Query changed"}});
  await expect(f.client.request({method:"query-page",query:{}})).rejects.toMatchObject({code,message:"Query changed"});
  expect(f.client.connection$.value.state).toBe("ready");expect(f.api.request.mock.calls.map(([input])=>input.method)).toEqual(["configure","query-page"]);f.client.dispose();
});
it("rejects malformed query error envelopes and preserves ordinary transport failures",async()=>{
  const f=fixture();await f.client.whenReady();f.api.request.mockResolvedValueOnce({libraryQueryError:{code:"EIO",message:"not a known query state"}});
  await expect(f.client.request({method:"query-page"})).rejects.toThrow("Invalid library query error response");
  const failure=Error("utility exited");f.api.request.mockRejectedValueOnce(failure);
  await expect(f.client.request({method:"query-page"})).rejects.toBe(failure);expect(f.client.connection$.value.error).toBe("utility exited");f.client.dispose();
});
it("keeps successful query calls passive and explicit mutations separate",async()=>{
  const f=fixture();await f.client.whenReady();const page={items:[],total:0,analysisExcluded:0};f.api.request.mockResolvedValueOnce(page);
  expect(await f.client.request({method:"query-page",query:{sort:"ur",filters:[{field:"result",values:["unknown"]}]}})).toBe(page);
  await f.client.request({method:"collection-create",name:"Practice",replayId:"one"});
  await f.client.request({method:"analysis-request",replayId:"one",reason:"selection"});
  expect(f.api.request.mock.calls.map(([input])=>input.method)).toEqual(["configure","query-page","collection-create","analysis-request"]);f.client.dispose();
});

it("observes only valid monotonic change notifications and unsubscribes without queries on dispose",()=>{
  let notify!:(event:LibraryChangedEvent)=>void;const unsubscribe=jest.fn();
  const api={request:jest.fn(async()=>null),demand:jest.fn(async()=>undefined),onChanged:jest.fn((listener:(event:LibraryChangedEvent)=>void)=>{notify=listener;return unsubscribe;})};
  const client=new LibraryClient(api),events:LibraryChangedEvent[]=[];let completed=false;
  client.changes$.subscribe({next:value=>events.push(value),complete:()=>{completed=true;}});expect(events).toEqual([]);
  for(const event of [null,{revision:0,ready:true},{revision:1,ready:"yes"},{revision:1,ready:true,path:"D:/private"}])notify(event as LibraryChangedEvent);
  notify({revision:1,ready:false});notify({revision:1,ready:false});notify({revision:2,ready:true});notify({revision:1,ready:true});
  expect(events).toEqual([{revision:1,ready:false},{revision:2,ready:true}]);expect(api.request).not.toHaveBeenCalled();expect(api.demand).not.toHaveBeenCalled();
  client.dispose();notify({revision:3,ready:true});expect(events).toHaveLength(2);expect(completed).toBe(true);expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it("treats the unchanged startup screen as the viewer until Library navigation changes visibility",async()=>{
  const f=fixture();await flush();f.load.next({phase:"ready"});expect(f.api.demand).toHaveBeenLastCalledWith(true);
  f.client.setViewerVisible(false);expect(f.api.demand).toHaveBeenLastCalledWith(false);f.client.dispose();
});

it("exposes readiness without issuing a query or awaiting background yield", async () => {
  const f = fixture(); await f.client.whenReady();
  expect(f.api.request.mock.calls.map(call => call[0].method)).toEqual(["configure"]);
  f.client.dispose(); await expect(f.client.whenReady()).rejects.toThrow(/closed/);
});

it("cancels selected replay readiness without cancelling shared configuration or waiting for it", async () => {
  const f = fixture(); await f.client.whenReady();
  let finish!: (path: string) => void;
  f.folder.whenReady.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  f.folder.settings$.next({ osuStablePath: "D:\\pending" });
  const controller = new AbortController(), pending = f.client.whenReady(controller.signal); controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
  finish("D:\\pending\\Songs"); await f.client.whenReady(); expect(f.client.connection$.value.state).toBe("ready"); f.client.dispose();
});

it("configures resolved Songs once and rejects stale resolution without blocking viewer work", async () => {
  const f = fixture(); await flush();
  expect(f.api.request).toHaveBeenCalledWith({ method: "configure", stable: { directory: "D:\\osu", songsRoot: "D:\\maps" } });
  let release!: (value: string) => void;
  f.folder.whenReady.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  f.folder.settings$.next({ osuStablePath: "D:\\old" });
  f.folder.whenReady.mockResolvedValueOnce("D:\\new-maps"); f.folder.settings$.next({ osuStablePath: "D:\\new" });
  await flush(); release("D:\\old-maps"); await flush();
  expect(f.api.request).toHaveBeenCalledTimes(2);
  expect(f.api.request).toHaveBeenLastCalledWith({ method: "configure", stable: { directory: "D:\\new", songsRoot: "D:\\new-maps" } });
  f.client.dispose();
});

it("retains demand for paused viewing, loads, exports and overlapping operation leases", async () => {
  const f = fixture(); await flush(); f.api.demand.mockClear();
  f.client.setViewerVisible(true); f.load.next({ phase: "ready" });
  expect(f.api.demand).toHaveBeenLastCalledWith(true);
  const first = f.client.acquireForeground(), second = f.client.acquireForeground();
  f.client.setViewerVisible(false); f.load.next({ phase: "idle" }); first();
  expect(f.api.demand).toHaveBeenCalledTimes(1);
  f.clip.next({ status: "recording" }); second(); expect(f.api.demand).toHaveBeenCalledTimes(1);
  f.clip.next({ status: "idle" }); expect(f.api.demand).toHaveBeenLastCalledWith(false);
  f.load.next({ phase: "loading" }); expect(f.api.demand).toHaveBeenLastCalledWith(true);
  f.load.next({ phase: "failed" }); expect(f.api.demand).toHaveBeenLastCalledWith(false); f.client.dispose();
});

it("does not await background recovery/yield before current-replay work and reports demand failure", async () => {
  const f = fixture(); await flush();
  let reject!: (error: Error) => void;
  f.api.demand.mockImplementationOnce(() => new Promise<undefined>((_resolve, fail) => { reject = fail; }));
  const foreground = jest.fn(async () => 42);
  expect(await f.client.foreground(foreground)).toBe(42); expect(foreground).toHaveBeenCalledTimes(1);
  reject(new Error("utility stopped")); await flush();
  expect(f.client.connection$.value.error).toContain("utility stopped");
  expect(f.api.request.mock.calls.every(call => call[0]?.method === "configure")).toBe(true); f.client.dispose();
});

it("keeps failed configuration visible without an automatic retry loop", async () => {
  const f = fixture(); f.api.request.mockRejectedValueOnce(new Error("storage failed")); await flush();
  expect(f.client.connection$.value.state).toBe("error");
  await flush(); expect(f.api.request).toHaveBeenCalledTimes(1); f.client.dispose();
});

it("does not report cancelled native location as recovery", async () => {
  const f = fixture(); f.api.request.mockRejectedValueOnce(new Error("storage failed")); await flush();
  await f.client.request({ method: "locate-lazer" });
  expect(f.client.connection$.value.state).toBe("error");
  await expect(f.client.status()).rejects.toThrow("storage failed");
  f.client.dispose();
});

it("does not overwrite a newer configuration with stale recovery", async () => {
  const f = fixture(); await flush();
  let finish!: () => void;
  f.api.request.mockImplementationOnce(() => new Promise<null>(resolve => { finish = () => resolve(null); }));
  const retry = f.client.request({ method: "retry" });
  f.api.request.mockRejectedValueOnce(new Error("new configuration failed"));
  f.folder.settings$.next({ osuStablePath: "D:\\changed" }); await flush();
  finish(); await retry; expect(f.client.connection$.value).toMatchObject({ state: "error", error: "new configuration failed" });
  f.client.dispose();
});

it("waits for the latest configuration when an older one resolves during a folder change", async () => {
  const f = fixture(); let first!: () => void;
  f.api.request.mockImplementationOnce(() => new Promise<null>(resolve => { first = () => resolve(null); }));
  await flush(); const status = f.client.status();
  let second!: (value: string) => void;
  f.folder.whenReady.mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
  f.folder.settings$.next({ osuStablePath: "D:\\next" }); first(); await flush();
  expect(f.api.request.mock.calls.some(call => call[0].method === "status")).toBe(false);
  second("D:\\next-maps"); await status;
  expect(f.api.request.mock.calls.map(call => call[0].method)).toEqual(["configure", "configure", "status"]); f.client.dispose();
});
