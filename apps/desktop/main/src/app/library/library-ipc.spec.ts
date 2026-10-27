import { LibraryMainApi, assertLibrarySender,validateLibraryPassiveRequest as validate } from "./library-ipc";

it("accepts optional faster processing only as a boolean without changing worker limits",async()=>{
  const f=fixture(),settings={mode:"bg",workers:4,userPaused:false,pauseOnBattery:true};
  for(const fasterProcessing of [true,false]){
    await f.api.receive({method:"analysis-settings",settings:{...settings,fasterProcessing}},()=>undefined);
    expect(f.owner.request).toHaveBeenLastCalledWith("analysis-settings",{settings:{...settings,fasterProcessing}});
  }
  for(const fasterProcessing of [1,"true",null])await expect(f.api.receive({method:"analysis-settings",settings:{...settings,fasterProcessing}},()=>undefined)).rejects.toThrow(/settings/);
  await expect(f.api.receive({method:"analysis-settings",settings:{...settings,workers:8,fasterProcessing:true}},()=>undefined)).rejects.toThrow(/settings/);
  await f.api.close();
});

it("exports the same strict passive-only validation for utility transport",()=>{
  expect(validate).toEqual(expect.any(Function));
  expect(()=>validate("query-page",{query:{sort:"peak",limit:10}})).not.toThrow();
  for(const [method,args] of [["analysis-request",{replayId:"one",reason:"selection"}],["query-page",{reason:"selection"}],
    ["query-page",{query:{filters:[{field:"miss",min:0,analysis:true}]}}],["query-facets",{field:"player",options:{limit:10,analyze:true}}],
    ["query-page",{method:"analysis-request"}],["query-page",{query:{search:"x".repeat(256*1024)}}]])expect(()=>validate(method as string,args)).toThrow();
});
it("accepts passive removal previews and My names reads without admitting work",async()=>{
  const f=fixture();
  for(const input of [{method:"query-preview",query:{search:"map"}},{method:"query-player-names"}]){
    expect(await f.api.receive(input,()=>undefined)).toBe("result");
    const {method,...args}=input;expect(f.owner.request).toHaveBeenLastCalledWith(method,args);
  }
  expect(f.owner.configure).not.toHaveBeenCalled();expect(f.deps.pickImports).not.toHaveBeenCalled();
  await expect(f.api.receive({method:"query-player-names",names:["injected"]},()=>undefined)).rejects.toThrow();
  await f.api.close();
});
it("accepts only bounded explicit My names changes",async()=>{
  const f=fixture();await f.api.receive({method:"player-names-set",names:["Lark","lark_old"]},()=>undefined);
  expect(f.owner.request).toHaveBeenLastCalledWith("player-names-set",{names:["Lark","lark_old"]});
  for(const names of ["Lark",[""],["  "],["x".repeat(257)],["a\0b"],Array(101).fill("Lark")])
    await expect(f.api.receive({method:"player-names-set",names},()=>undefined)).rejects.toThrow();
  expect(f.owner.request).toHaveBeenCalledTimes(1);await f.api.close();
});
it("validates closeout Result, Played on and Me filters at the passive transport boundary",()=>{
  for(const field of ["result","playedon"])expect(()=>validate("query-facets",{field})).not.toThrow();
  expect(()=>validate("query-page",{query:{filters:[{field:"player",values:[],me:true},{field:"result",values:["fc"]},{field:"playedon",values:["stable","unknown"]}]}})).not.toThrow();
  for(const filter of [{field:"player",values:[],me:"yes"},{field:"result",values:["passed","fc"]},{field:"playedon",values:["classic"]},{field:"incidents",op:"atLeast",a:3,b:null}])
    expect(()=>validate("query-preview",{draft:filter})).toThrow();
});
it("accepts Excludes across passive query transport and rejects invalid exclusions before admission",async()=>{
  const f=fixture(),draft={field:"mods",mode:"excludes",match:null,mods:["RX","HD"]},query={filters:[draft]};
  for(const input of [{method:"query-page",query},{method:"query-preview",query:{},draft},{method:"query-bands",query},
    {method:"query-facets",query,field:"source"},{method:"query-reveal",query,replayId:"one"},{method:"query-snapshot-create",query,replayId:"one"}]){
    expect(await f.api.receive(input,()=>undefined)).toBe("result");
    const {method,...args}=input;expect(f.owner.request).toHaveBeenLastCalledWith(method,args);
  }
  expect(f.owner.request).toHaveBeenCalledTimes(6);f.owner.request.mockClear();
  for(const invalid of [{...draft,mods:[]},{...draft,match:"any"},{...draft,match:"all"},{...draft,mods:["RX","RX"]},
    {...draft,mode:["excludes"]},{...draft,match:["all"]},{...draft,mods:["RX') OR 1=1 --"]},{...draft,analysis:true}]){
    await expect(f.api.receive({method:"query-page",query:{filters:[invalid]}},()=>undefined)).rejects.toThrow();
    await expect(f.api.receive({method:"query-preview",draft:invalid},()=>undefined)).rejects.toThrow();
  }
  expect(f.owner.request).not.toHaveBeenCalled();expect(f.owner.configure).not.toHaveBeenCalled();expect(f.owner.retry).not.toHaveBeenCalled();
  expect(f.deps.pickImports).not.toHaveBeenCalled();expect(f.deps.pickNative).not.toHaveBeenCalled();await f.api.close();
});
it("forwards only bounded collection references when deleting a collection",async()=>{
  const f=fixture();expect(await f.api.receive({method:"collection-delete",collectionId:"parent",referencedIds:["parent","child"]},()=>undefined)).toBe("result");
  expect(f.owner.request).toHaveBeenLastCalledWith("collection-delete",{collectionId:"parent",referencedIds:["parent","child"]});
  for(const referencedIds of [Array.from({length:102},(_,n)=>"c"+n),["child","child"],["bad id"]])
    await expect(f.api.receive({method:"collection-delete",collectionId:"parent",referencedIds},()=>undefined)).rejects.toThrow();
  expect(f.owner.request).toHaveBeenCalledTimes(1);await f.api.close();
});

function fixture() {
  const owner = { configure: jest.fn(async () => undefined), request: jest.fn(async () => "result"),
    retry: jest.fn(async () => undefined), setViewerDemand: jest.fn(async () => undefined), close: jest.fn(async () => undefined) };
  const deps = { owner, readNativeDirectory: jest.fn(async (): Promise<string | undefined> => "D:\\native"),
    saveNativeDirectory: jest.fn(async () => undefined), pickImports: jest.fn(async (): Promise<string[] | null> => ["D:\\one.osr"]),
    pickNative: jest.fn(async (): Promise<string | null> => "D:\\new-native"), inspectNative: jest.fn(async () => ({ ok: true, status: "ready" })),
    closeNative: jest.fn(async () => undefined),
    receiveCurrentReplay: jest.fn(async (_value: unknown, assertCurrent: () => void) => { assertCurrent(); return { state: "released" }; }),
  };
  return { api: new LibraryMainApi(deps), deps, owner };
}

it("propagates retained native inspector cleanup failures during app shutdown", async () => {
  const f = fixture(); f.deps.closeNative.mockRejectedValue(new Error("Native cleanup failed"));
  await expect(f.api.close()).rejects.toThrow(/cleanup/i); expect(f.deps.closeNative).toHaveBeenCalledTimes(1);
});

it("forwards all twelve passive query operations without analysis, configuration or picker admission", async () => {
  const f=fixture();const requests=[
    {method:"query-page",query:{sort:"peak",direction:"asc",limit:128}},
    {method:"query-preview",query:{},draft:{field:"review",values:["reviewed"]}},
    {method:"query-facets",query:{},field:"collection",options:{search:"practice",limit:25}},
    {method:"query-bands",query:{},options:{limit:20}},
    {method:"query-reveal",query:{},replayId:"one"},{method:"query-detail",replayId:"one"},
    {method:"query-same-map",replayId:"one"},{method:"query-collections",options:{parentId:null}},
    {method:"query-memberships",replayId:"one"},{method:"query-snapshot-create",query:{},replayId:"one"},
    {method:"query-snapshot-neighbors",snapshotId:"snapshot",options:{position:0,before:0,after:63}},
    {method:"query-snapshot-release",snapshotId:"snapshot"},
  ];
  for(const input of requests){expect(await f.api.receive(input,()=>undefined)).toBe("result");const{method,...args}=input;expect(f.owner.request).toHaveBeenLastCalledWith(method,args);}
  expect(f.owner.request).toHaveBeenCalledTimes(12);expect(f.owner.configure).not.toHaveBeenCalled();expect(f.owner.retry).not.toHaveBeenCalled();
  expect(f.deps.pickImports).not.toHaveBeenCalled();expect(f.deps.pickNative).not.toHaveBeenCalled();await f.api.close();
});

it("rejects extra privilege fields and out-of-bound queries before the utility",async()=>{
  const f=fixture();
  for(const input of [
    {method:"query-page",query:{sort:"cause"}},{method:"query-page",query:{reason:"selection"}},
    {method:"query-page",query:{scope:{kind:"all",id:"hidden"}}},{method:"query-preview",draft:{field:"review",values:["reviewed"],cause:"aim"}},
    {method:"query-facets",field:"cause"},{method:"query-facets",field:"player",options:{limit:101}},
    {method:"query-bands",options:{sql:"SELECT 1"}},{method:"query-collections",options:{parentId:42}},
    {method:"query-memberships",replayId:""},{method:"query-snapshot-neighbors",snapshotId:"s",options:{position:0,after:64}},
    {method:"query-page",query:{cursor:"x".repeat(131073)}},{method:"query-detail",replayId:"one",path:"D:\\one.osr"},
    {method:"query-page",query:{filters:[{field:"player",values:["x".repeat(65537)]}]}},
  ])await expect(f.api.receive(input,()=>undefined)).rejects.toThrow();
  expect(f.owner.request).not.toHaveBeenCalled();await f.api.close();
});

it.each([
  {sort:["pp"]},{direction:["asc"]},{scope:{kind:["all"]}},
  {filters:[{field:"stars",basis:["map"],min:1,max:null}]},
  {filters:[{field:"mods",mode:["includes"],match:"all",mods:["HD"]}]},
  {filters:[{field:"mods",mode:"includes",match:["all"],mods:["HD"]}]},
  {filters:[{field:"played",preset:["today"]}]},{filters:[{field:"miss",op:["atLeast"],a:1,b:null}]},
])("rejects coercible query enums before utility admission (%#)",async query=>{
  const f=fixture();await expect(f.api.receive({method:"query-page",query},()=>undefined)).rejects.toThrow();
  expect(f.owner.request).not.toHaveBeenCalled();await f.api.close();
});

it("allows existing bounded cursor sizes but rejects an oversized combined query",async()=>{
  const f=fixture();await f.api.receive({method:"query-page",query:{cursor:"x".repeat(131072)}},()=>undefined);
  expect(f.owner.request).toHaveBeenCalledTimes(1);f.owner.request.mockClear();
  await expect(f.api.receive({method:"query-page",query:{cursor:"x".repeat(131072),filters:[{field:"player",values:["a".repeat(65536),"b".repeat(65536),"c"]}]}},()=>undefined)).rejects.toThrow("Invalid library request");
  expect(f.owner.request).not.toHaveBeenCalled();await f.api.close();
});

it("does not route a current-replay capability to the utility if the main API is unavailable",async()=>{
  const f=fixture(),api=new LibraryMainApi({...f.deps,receiveCurrentReplay:undefined});
  await expect(api.receive({method:"current-replay-release",token:"receipt"},()=>undefined)).rejects.toThrow("unavailable");
  expect(f.owner.request).not.toHaveBeenCalled();await api.close();
});

it("allows only explicit analysis choices and validated metadata mutations",async()=>{
  const f=fixture(),settings={mode:"off",workers:2,userPaused:false,pauseOnBattery:true};
  for(const input of [{method:"analysis-settings"},{method:"analysis-settings",settings},{method:"analysis-request",replayId:"one",reason:"selection"},
    {method:"analysis-request",replayId:"one",reason:"open"},{method:"analysis-retry",replayId:"one"},
    {method:"collection-create",name:"Practice",parentId:null,replayId:"one"},{method:"collection-rename",collectionId:"c",name:"Renamed"},
    {method:"collection-delete",collectionId:"c"},{method:"replay-review",replayId:"one",review:"reviewed"},
    {method:"replay-favourite",replayId:"one",favourite:true},{method:"collection-membership",replayId:"one",collectionId:"c",included:false}]) {
    await f.api.receive(input,()=>undefined);const{method,...args}=input;expect(f.owner.request).toHaveBeenLastCalledWith(method,args);
  }
  f.owner.request.mockClear();
  for(const input of [{method:"analysis-request",replayId:"one",reason:"background"},{method:"analysis-request",replayId:"one",reason:"retry"},
    {method:"analysis-request",replayId:"one",reason:"selection",target:{}},{method:"analysis-retry",replayId:"one",stage:"C"},
    {method:"analysis-settings",settings:{...settings,workers:8}},{method:"analysis-settings",settings:{...settings,mode:["off"]}},
    {method:"collection-create",name:" "},{method:"collection-rename",collectionId:"c",name:"x".repeat(257)},
    {method:"replay-review",replayId:"one",review:"done"},{method:"replay-favourite",replayId:"one",favourite:1},
    {method:"collection-membership",replayId:"one",collectionId:"c",included:"yes"}])await expect(f.api.receive(input,()=>undefined)).rejects.toThrow();
  expect(f.owner.request).not.toHaveBeenCalled();await f.api.close();
});

it.each(["library-query-invalidated","library-query-limit","library-query-updating"])("serializes only known passive-query state %s",async code=>{
  const f=fixture(),failure=Object.assign(Error("Query state"),{code});f.owner.request.mockRejectedValueOnce(failure);
  expect(await f.api.receive({method:"query-page"},()=>undefined)).toEqual({libraryQueryError:{code,message:"Query state"}});
  f.owner.request.mockRejectedValueOnce(failure);await expect(f.api.receive({method:"status"},()=>undefined)).rejects.toBe(failure);
  const ordinary=Object.assign(Error("utility crashed"),{code:"EIO"});f.owner.request.mockRejectedValueOnce(ordinary);
  await expect(f.api.receive({method:"query-page"},()=>undefined)).rejects.toBe(ordinary);await f.api.close();
});

it("routes current-replay capabilities to the main-owned API without utility publication privileges",async()=>{
  const f=fixture(),check=jest.fn(),input={method:"current-replay-release",token:"receipt"};
  expect(await f.api.receive(input,check)).toEqual({state:"released"});expect(f.deps.receiveCurrentReplay).toHaveBeenCalledWith(input,check);
  expect(f.owner.request).not.toHaveBeenCalled();
  await expect(f.api.receive({...input,results:[]},check)).rejects.toThrow();
  await expect(f.api.receive({method:"current-replay-publish",token:"receipt",results:[],target:{}},check)).rejects.toThrow();await f.api.close();
});

it("trusts only the live owned main frame at the exact renderer URL, allowing hash routes", () => {
  const frame = {}, sender = { mainFrame: frame, isDestroyed: () => false, getURL: () => "file:///D:/app/index.html#/app/library" };
  const event = { sender, senderFrame: frame };
  expect(() => assertLibrarySender(event, sender, "file:///D:/app/index.html")).not.toThrow();
  for (const bad of [{ ...event, senderFrame: {} }, { ...event, senderFrame: null }, { ...event, sender: { ...sender } }])
    expect(() => assertLibrarySender(bad, sender, "file:///D:/app/index.html")).toThrow(/sender/i);
  for (const url of ["file:///D:/app/other.html", "file:///D:/app/index.html?outside=1", "https://localhost:4200/"])
    expect(() => assertLibrarySender(event, sender, url)).toThrow(/sender/i);
});

it("keeps renderer operations typed and bounded, with imports exclusively from the explicit picker", async () => {
  const f = fixture(), check = jest.fn();
  for (const bad of [{ method: "initialize" }, { method: "import", paths: ["D:\\untrusted.osr"] },
    { method: "scan", sourceId: "" }, { method: "source-enabled", sourceId: "x", enabled: 1 },
    { method: "update-mode", mode: "eager" }, { method: "configure", stable: { directory: "relative", songsRoot: "D:\\songs" } }])
    await expect(f.api.receive(bad, check)).rejects.toThrow();
  expect(f.owner.request).not.toHaveBeenCalled();
  await f.api.receive({ method: "import-replays" }, check);
  expect(f.owner.request).toHaveBeenCalledWith("import", { paths: ["D:\\one.osr"] });
  expect(check).toHaveBeenCalledTimes(8); await f.api.close();
});

it("loads durable native configuration once while subsequent Stable configuration retains the active native choice", async () => {
  const f = fixture();
  await f.api.receive({ method: "configure", stable: null }, () => undefined);
  await f.api.receive({ method: "locate-lazer" }, () => undefined);
  await f.api.receive({ method: "configure", stable: { directory: "D:\\osu", songsRoot: "D:\\Songs" } }, () => undefined);
  expect(f.deps.readNativeDirectory).toHaveBeenCalledTimes(1);
  expect(f.owner.configure.mock.calls).toEqual([
    [{ stable: null, lazerDirectory: "D:\\native" }], [{ lazerDirectory: "D:\\new-native" }],
    [{ stable: { directory: "D:\\osu", songsRoot: "D:\\Songs" } }],
  ]); await f.api.close();
});

it("never exposes internal metric target, queue or publication privileges to renderer requests", async () => {
  const f = fixture();
  for (const method of ["metric-target", "metric-request", "metric-next", "metric-claim", "metric-commit", "metric-fail", "metric-release",
    "preparation-request","preparation-next","preparation-claim","preparation-commit","preparation-fail","preparation-release","analysis-resources-confirm"])
    await expect(f.api.receive({ method }, () => undefined)).rejects.toThrow(/operation/i);
  expect(f.owner.request).not.toHaveBeenCalled(); await f.api.close();
});

it("rejects a failed native gate without saving or replacing the source", async () => {
  const f = fixture(); f.deps.inspectNative.mockResolvedValue({ ok: false, status: "unsupported-schema" });
  await expect(f.api.receive({ method: "locate-lazer" }, () => undefined)).rejects.toThrow("unsupported-schema");
  expect(f.deps.saveNativeDirectory).not.toHaveBeenCalled(); expect(f.owner.configure).not.toHaveBeenCalled(); await f.api.close();
});

it("rechecks ownership after a picker and cancels pending initialization on shutdown", async () => {
  const f = fixture(); let release!: (paths: string[]) => void;
  f.deps.pickImports.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const check = jest.fn().mockImplementationOnce(() => undefined).mockImplementation(() => { throw new Error("sender changed"); });
  const importing = f.api.receive({ method: "import-replays" }, check); release(["D:\\one.osr"]);
  await expect(importing).rejects.toThrow("sender changed"); expect(f.owner.request).not.toHaveBeenCalled();
  let restore!: (directory: string) => void;
  f.deps.readNativeDirectory.mockImplementationOnce(() => new Promise(resolve => { restore = resolve; }));
  const configure = f.api.receive({ method: "configure", stable: null }, () => undefined);
  await f.api.close(); restore("D:\\native"); await expect(configure).rejects.toThrow(/closed/i);
  expect(f.owner.configure).not.toHaveBeenCalled();
});

it("demand bypasses background initialization and requests do not respawn a failed utility", async () => {
  const f = fixture();
  let finish!: () => void; f.owner.configure.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
  const configuring = f.api.receive({ method: "configure", stable: null }, () => undefined); await Promise.resolve(); await Promise.resolve();
  await f.api.demand(true); expect(f.owner.setViewerDemand).toHaveBeenCalledWith(true);
  finish(); await configuring; f.owner.request.mockRejectedValueOnce(new Error("crashed"));
  await expect(f.api.receive({ method: "status" }, () => undefined)).rejects.toThrow("crashed");
  expect(f.owner.retry).not.toHaveBeenCalled(); await f.api.close();
});

it("reconciles an authorized saved locator even when its response document changed", async () => {
  const f = fixture(); await f.api.receive({ method: "configure", stable: null }, () => undefined);
  let save!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.deps.saveNativeDirectory.mockImplementationOnce(() => new Promise<undefined>(resolve => { save = () => resolve(undefined); entered(); }));
  let live = true; const check = () => { if (!live) throw new Error("document replaced"); };
  const locating = f.api.receive({ method: "locate-lazer" }, check); await started; live = false; save();
  await expect(locating).rejects.toThrow("document replaced");
  expect(f.owner.configure).toHaveBeenLastCalledWith({ lazerDirectory: "D:\\new-native" });
  await f.api.close();
});

it("drains a preference write on quit without starting a replacement after shutdown", async () => {
  const f = fixture(); let save!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.deps.saveNativeDirectory.mockImplementationOnce(() => new Promise<undefined>(resolve => { save = () => resolve(undefined); entered(); }));
  const locating = f.api.receive({ method: "locate-lazer" }, () => undefined); await started;
  let closed = false; const closing = f.api.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
  save(); await expect(locating).rejects.toThrow(/closed/i); await closing;
  expect(f.owner.configure).not.toHaveBeenCalled();
});

it("explicit retry rereads a failed preference and configures the latest requested Stable installation", async () => {
  const f = fixture(); f.deps.readNativeDirectory.mockRejectedValueOnce(new Error("temporarily locked"));
  await expect(f.api.receive({ method: "configure", stable: null }, () => undefined)).rejects.toThrow("temporarily locked");
  await expect(f.api.receive({ method: "configure", stable: { directory: "D:\\osu", songsRoot: "D:\\Maps" } }, () => undefined)).rejects.toThrow("temporarily locked");
  await f.api.receive({ method: "retry" }, () => undefined);
  expect(f.deps.readNativeDirectory).toHaveBeenCalledTimes(2);
  expect(f.owner.configure).toHaveBeenCalledWith({ stable: { directory: "D:\\osu", songsRoot: "D:\\Maps" }, lazerDirectory: "D:\\native" });
  expect(f.owner.retry).not.toHaveBeenCalled(); await f.api.close();
});
