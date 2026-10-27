import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { LibraryUtilityServer } from "./library-utility-server";
import { setImmediate } from "timers/promises";
import { LibraryStore } from "./library-store";
import { LibraryService } from "./library-service";
import { LIBRARY_NUMERIC_PROJECTION_VERSION,LIBRARY_REPLAY_PARSER_VERSION,LIBRARY_RESOURCE_PREPARATION_VERSION } from "../../../../shared/library-analysis";
import { numericalProfileKey,nativeModEvidence } from "./library-numerical-profile";

let root: string; let server: LibraryUtilityServer;
const messages: { id: string; ok: boolean; data?: unknown; error?: string;errorCode?:string }[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hindsight-utility-server-")); messages.length = 0; server = new LibraryUtilityServer(message => messages.push(message)); });
afterEach(async () => {
  await server.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
  await rm(root, { recursive: true, force: true });
});
const request = (id: string, method: string, args: unknown = {}) => ({ version: 1, id, method, args });
const initialize = () => server.receive(request("init", "initialize", { directory: root, sessionId: "test", nativeExecutable: join(root, "engine.exe"), sources: [] }));

it("scoped resources coalesce a complete union and keep global invalidation dominant", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] }); const notifications: unknown[] = [];
  let changed!: (value: Record<string, unknown>) => void;
  const subscription = jest.spyOn(LibraryService.prototype, "onLibraryChanged").mockImplementation(observer => {
    changed = value => observer(value as Parameters<typeof observer>[0]); observer({ ready: true, resourceRevision: "7" }); return () => undefined;
  });
  server = new LibraryUtilityServer(message => messages.push(message), event => notifications.push(event));
  try {
    await initialize(); jest.advanceTimersByTime(25); notifications.length = 0;
    const push = (from: string, to: string, id: string) => changed({ ready: true, resourceRevision: to,
      resourceChanges: { from, to, scope: "replays", replayIds: [id] } });
    push("7", "8", "one"); push("8", "9", "two");
    changed({ ready: true, resourceRevision: "9", statusOnly: true }); jest.advanceTimersByTime(25);
    expect(notifications).toEqual([expect.objectContaining({ resourceChanges: { from: "7", to: "9", scope: "replays", replayIds: ["one", "two"] } })]);
    notifications.length = 0;
    changed({ ready: true, resourceRevision: "10" }); push("10", "11", "three"); jest.advanceTimersByTime(25);
    expect(notifications).toEqual([expect.objectContaining({ resourceChanges: { from: "9", to: "11", scope: "all" } })]);
  } finally { subscription.mockRestore(); await server.close(); jest.useRealTimers(); }
});

it("persists the optional faster policy through public analysis-settings, including restart and explicit false", async () => {
  await initialize();
  const legacy = { mode: "bg", userPaused: true, workers: 4, pauseOnBattery: true };
  const call = async (settings?: unknown) => {
    await server.receive(request("public-settings", "analysis-settings", settings === undefined ? {} : { settings }));
    const reply = messages.at(-1); expect(reply?.ok).toBe(true); return reply?.data;
  };
  expect(await call(legacy)).toEqual(legacy);
  expect(await call({ ...legacy, fasterProcessing: true })).toEqual({ ...legacy, fasterProcessing: true });
  // An older caller must not erase a policy it does not know about.
  expect(await call({ ...legacy, workers: 2 })).toEqual({ ...legacy, workers: 2, fasterProcessing: true });
  await server.close(); server = new LibraryUtilityServer(message => messages.push(message)); await initialize();
  expect(await call()).toEqual({ ...legacy, workers: 2, fasterProcessing: true });
  expect(await call({ ...legacy, fasterProcessing: false })).toEqual(legacy);
  await server.close(); server = new LibraryUtilityServer(message => messages.push(message)); await initialize();
  expect(await call()).toEqual(legacy);
});

it("rejects invalid faster policy values and unknown fields at the public settings boundary without mutation", async () => {
  await initialize();
  const legacy = { mode: "bg", userPaused: true, workers: 2, pauseOnBattery: true };
  await server.receive(request("baseline", "analysis-settings", { settings: legacy }));
  expect(messages.at(-1)?.ok).toBe(true);
  for (const extra of [{ fasterProcessing: "true" }, { fasterProcessing: 1 }, { fasterProcessing: null },
    { fasterProcessing: true, unexpected: true }, { fasterProcessing: false, workers: 8 }]) {
    await server.receive(request("invalid", "analysis-settings", { settings: { ...legacy, ...extra } }));
    expect(messages.at(-1)).toMatchObject({ ok: false, error: "Invalid library analysis settings" });
    await server.receive(request("read", "analysis-settings"));
    expect(messages.at(-1)).toMatchObject({ ok: true, data: legacy });
  }
});

it("manual feedback preserves status-only progress without downgrading a simultaneous semantic change", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  const notifications: unknown[] = [];
  let changed: ((value: { ready: boolean; resourceRevision?: string; statusOnly?: true }) => void) | undefined;
  const subscription = jest.spyOn(LibraryService.prototype, "onLibraryChanged").mockImplementation(observer => {
    changed = observer; observer({ ready: true, resourceRevision: "7" }); return () => undefined;
  });
  server = new LibraryUtilityServer(message => messages.push(message), event => notifications.push(event));
  try {
    await initialize(); jest.advanceTimersByTime(25); notifications.length = 0;
    changed?.({ ready: true, resourceRevision: "7", statusOnly: true }); jest.advanceTimersByTime(25);
    expect(notifications).toEqual([expect.objectContaining({ ready: true, resourceRevision: "7", statusOnly: true })]);
    notifications.length = 0;
    changed?.({ ready: false, resourceRevision: "8" });
    changed?.({ ready: false, resourceRevision: "8", statusOnly: true }); jest.advanceTimersByTime(25);
    expect(notifications).toEqual([expect.objectContaining({ ready: false, resourceRevision: "8" })]);
    expect(notifications[0]).not.toHaveProperty("statusOnly");
  } finally { subscription.mockRestore(); await server.close(); jest.useRealTimers(); }
});

it("publishes an already-computed zero-valued observation while Off and revokes its exact authority",async()=>{
  const sha="a".repeat(64),mapSha="b".repeat(64),md5="c".repeat(32),store=new LibraryStore(join(root,"library.sqlite"),"previous");
  store.registerSource({id:"imports",kind:"imported",directory:join(root,"imports")});
  const replayId=store.upsertObservation({sourceId:"imports",sourceKey:sha,locator:join(root,"imports","existing.osr"),sha256:sha,available:true,
    generation:store.beginScan("imports"),addedAt:1,metadata:{}});
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});store.close();await initialize();
  const call=async(method:string,args:Record<string,unknown>={})=>{await server.receive(request("current-"+messages.length,method,args));const result=messages.at(-1);expect(result?.ok).toBe(true);return result?.data;};
  const location=(await call("prepare-open",{replayId}) as {items:unknown[]}).items[0];
  const recipe={version:1 as const,replaySha256:sha,fixedKey:"d".repeat(64),intrinsicNative:false,embeddedModsHash:null,legacyModsHash:"e".repeat(64),modeQualified:true,consumedModsSource:"legacy-mask" as const};
  const profile=numericalProfileKey(recipe,{origin:null,native:nativeModEvidence([])});if(profile.state!=="known")throw Error("Fixture profile unavailable");
  const descriptor={input:{format:"resources",replayBytes:100,mapBytes:100,binding:{replaySha256:sha,mapSha256:mapSha,mapMd5:md5,exactMapAndProfile:true}},
    target:{slot:"numerical",stage:"S",inputKey:profile.inputKey,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION},recipe,origin:null};
  const bound=await call("current-replay-bind",{location,observation:{sha256:sha,available:true,metadata:{}},descriptor}) as {state:string;authority:unknown};expect(bound.state).toBe("applied");
  const metrics={fields:{misses:{state:"known",value:0}},provenance:{replaySha256:sha,mapSha256:mapSha,mapMd5:md5,
    parserVersion:LIBRARY_REPLAY_PARSER_VERSION,preparationVersion:LIBRARY_RESOURCE_PREPARATION_VERSION,projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,
    scoreOrigin:"reconstructed",ruleset:"stable",rate:1,coverageQualified:true}};
  const results=[{slot:"numerical",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,metrics}];
  expect(await call("current-replay-store-publish",{authority:bound.authority,results})).toEqual({state:"applied",accepted:["numerical"]});
  expect(await call("metric-read",{replayId})).toEqual(expect.arrayContaining([expect.objectContaining({target:expect.objectContaining({slot:"numerical"}),result:expect.objectContaining({fields:metrics.fields})})]));
  expect(await call("metric-next")).toEqual([]);expect(await call("metric-settings")).toMatchObject({mode:"off"});
  expect(await call("current-replay-store-release",{authority:bound.authority})).toBeNull();
  expect(await call("current-replay-store-publish",{authority:bound.authority,results})).toEqual({state:"stale",accepted:[]});
});

it("routes trusted current replay binding, publication and revocation in received order",async()=>{
  await initialize();const sha="a".repeat(64),mapSha="b".repeat(64),md5="c".repeat(32);
  const location={replayId:"replay",sourceId:"source",sourceKey:"file",locator:join(root,"file.osr"),sha256:sha,locationRevision:1,sourceConfigRevision:1};
  const binding={replaySha256:sha,mapSha256:mapSha,mapMd5:md5,exactMapAndProfile:true};
  const descriptor={input:{format:"resources" as const,replayBytes:100,mapBytes:100,binding},target:{slot:"numerical" as const,stage:"S" as const,inputKey:"d".repeat(64),producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION},
    origin:null,recipe:{version:1 as const,replaySha256:sha,fixedKey:"e".repeat(64),intrinsicNative:false,embeddedModsHash:null,legacyModsHash:"f".repeat(64),modeQualified:true,consumedModsSource:"legacy-mask" as const}};
  const authority={version:1 as const,leaseId:"lease",replayId:"replay",binding,numericalTarget:{replayId:"replay",...descriptor.target,generation:1},sourceLease:{location}};
  const observation={sha256:sha,available:true,locator:location.locator,metadata:{}};
  const results=[{slot:"numerical" as const,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,metrics:{fields:{misses:{state:"known" as const,value:0}},provenance:{}}}];
  const events:string[]=[],bind=jest.spyOn(LibraryService.prototype,"bindCurrentReplay").mockImplementation(()=>{events.push("bind");return{state:"applied",replayId:"replay",authority};});
  const publish=jest.spyOn(LibraryService.prototype,"publishCurrentReplay").mockImplementation(()=>{events.push("publish");return{state:"applied",accepted:["numerical"]};});
  const release=jest.spyOn(LibraryService.prototype,"releaseCurrentReplay").mockImplementation(()=>{events.push("release");});
  try{
    await server.receive(request("bind","current-replay-bind",{location,observation,descriptor}));expect(messages.at(-1)).toMatchObject({ok:true,data:{authority}});
    await Promise.all([server.receive(request("publish","current-replay-store-publish",{authority,results})),server.receive(request("release","current-replay-store-release",{authority}))]);
    expect(events).toEqual(["bind","publish","release"]);expect(publish).toHaveBeenCalledWith(authority,results);expect(release).toHaveBeenCalledWith(authority);
    expect(messages.find(message=>message.id==="release")).toMatchObject({ok:true,data:null});
    const count=events.length;
    for(const [method,args] of [["current-replay-bind",{location,observation,descriptor,token:"renderer"}],
      ["current-replay-bind",{location:{...location,execute:"sql"},observation,descriptor}],
      ["current-replay-bind",{location,observation,descriptor:{...descriptor,frames:[]}}],
      ["current-replay-store-publish",{authority:{...authority,extra:true},results}],
      ["current-replay-store-publish",{authority:{...authority,numericalTarget:{...authority.numericalTarget,slot:"incidents"}},results}],
      ["current-replay-store-publish",{authority,results:[...results,...results]}],
      ["current-replay-store-publish",{authority,results:[{...results[0],metrics:{fields:{causes:{state:"known",value:[]}},provenance:{}}}]}],
      ["current-replay-store-publish",{authority,results:[{...results[0],metrics:{fields:{misses:{state:"known",value:0}},provenance:{raw:{frames:[]}}}}]}],
      ["current-replay-store-release",{authority,results}]] as const){
      await server.receive(request("invalid-current",method,args));expect(messages.at(-1)?.ok).toBe(false);
    }
    expect(events).toHaveLength(count);
    const longAuthority={...authority,sourceLease:{location:{...location,sourceKey:"x".repeat(16000),locator:join(root,"x".repeat(16000))}}};
    await server.receive(request("long-current","current-replay-store-release",{authority:longAuthority}));expect(messages.at(-1)?.ok).toBe(true);
  }finally{bind.mockRestore();publish.mockRestore();release.mockRestore();}
});

it("coalesces bounded library changes while preserving newer readiness revisions and unsubscribe on close",async()=>{
  jest.useFakeTimers({doNotFake:["nextTick","setImmediate"]});
  const notifications:unknown[]=[],unsubscribe=jest.fn();let changed:((value:{ready:boolean})=>void)|undefined;
  const subscription=jest.spyOn(LibraryService.prototype,"onLibraryChanged").mockImplementation(observer=>{changed=observer;observer({ready:false});return unsubscribe;});
  server=new LibraryUtilityServer(message=>messages.push(message),event=>notifications.push(event));
  try{
    await initialize();expect(subscription).toHaveBeenCalledTimes(1);expect(notifications).toEqual([]);
    jest.advanceTimersByTime(24);expect(notifications).toEqual([]);jest.advanceTimersByTime(1);
    expect(notifications).toEqual([{version:1,event:"library-changed",revision:1,ready:false}]);
    for(let n=0;n<100;n++)changed?.({ready:false});changed?.({ready:true});changed?.({ready:false});changed?.({ready:true});
    expect(notifications).toHaveLength(1);jest.advanceTimersByTime(25);
    expect(notifications).toHaveLength(2);expect(notifications[1]).toEqual({version:1,event:"library-changed",revision:104,ready:true});
    changed?.({ready:false});await server.close();jest.advanceTimersByTime(100);expect(notifications).toHaveLength(2);expect(unsubscribe).toHaveBeenCalledTimes(1);
  }finally{subscription.mockRestore();jest.useRealTimers();}
});
it("publishes one initial library readiness notification without a status poll",async()=>{
  jest.useFakeTimers({doNotFake:["nextTick","setImmediate"]});const notifications:unknown[]=[];
  server=new LibraryUtilityServer(message=>messages.push(message),event=>notifications.push(event));
  try{await initialize();jest.advanceTimersByTime(25);expect(notifications).toEqual(expect.arrayContaining([expect.objectContaining({version:1,event:"library-changed",ready:expect.any(Boolean)})]));}
  finally{await server.close();jest.useRealTimers();}
});

it("routes passive queries through the strict allowlist without admitting analysis",async()=>{
  await initialize();const query=jest.spyOn(LibraryService.prototype,"queryRequest").mockReturnValue({fixture:true});
  const analysis=jest.spyOn(LibraryService.prototype,"analysisRequest");
  try{
    for(const [method,args] of [["query-page",{query:{sort:"peak"}}],["query-preview",{draft:{field:"review",values:["reviewed"]}}],
      ["query-facets",{field:"player"}],["query-bands",{}],["query-reveal",{replayId:"one"}],["query-detail",{replayId:"one"}],
      ["query-same-map",{replayId:"one"}],["query-collections",{}],["query-memberships",{replayId:"one"}],
      ["query-snapshot-create",{replayId:"one"}],["query-snapshot-neighbors",{snapshotId:"snap",options:{position:0}}],["query-snapshot-release",{snapshotId:"snap"}]] as const){
      await server.receive(request(method,method,args));expect(messages.at(-1)).toMatchObject({ok:true,data:{fixture:true}});expect(query).toHaveBeenLastCalledWith(method,args);
    }
    const calls=query.mock.calls.length;
    for(const args of [{reason:"selection"},{query:{analysis:true}},{query:{filters:[{field:"miss",min:0,cause:"aim"}]}},{paths:[join(root,"one.osr")]}]){
      await server.receive(request("invalid-query","query-page",args));expect(messages.at(-1)?.ok).toBe(false);
    }
    await server.receive(request("invalid-operation","query-arbitrary",{}));expect(messages.at(-1)?.ok).toBe(false);
    expect(query).toHaveBeenCalledTimes(calls);expect(analysis).not.toHaveBeenCalled();
  }finally{query.mockRestore();analysis.mockRestore();}
});
it.each(["library-query-invalidated","library-query-limit","library-query-updating"])("preserves only a known passive query error code: %s",async code=>{
  await initialize();const query=jest.spyOn(LibraryService.prototype,"queryRequest").mockImplementation(()=>{throw Object.assign(Error("Refresh query"),{code});});
  try{await server.receive(request("query","query-page",{}));expect(messages.at(-1)).toEqual({version:1,id:"query",ok:false,error:"Refresh query",errorCode:code});}
  finally{query.mockRestore();}
});
it("routes strict single metadata edits and explicit analysis commands",async()=>{
  await initialize();const edit=jest.spyOn(LibraryService.prototype,"userMetadataRequest").mockReturnValue(null),analysis=jest.spyOn(LibraryService.prototype,"analysisRequest").mockReturnValue(null);
  try{
    await server.receive(request("review","replay-review",{replayId:"one",review:"reviewed"}));expect(messages.at(-1)?.ok).toBe(true);
    await server.receive(request("analysis","analysis-request",{replayId:"one",reason:"selection"}));expect(messages.at(-1)?.ok).toBe(true);
    await server.receive(request("retry","analysis-retry",{replayId:"one"}));expect(messages.at(-1)?.ok).toBe(true);
    await server.receive(request("settings","analysis-settings",{}));expect(messages.at(-1)?.ok).toBe(true);
    for(const [method,args] of [["replay-review",{replayId:"one",review:"reviewed",paths:[]}],["analysis-request",{replayId:"one",reason:"sort"}],
      ["analysis-retry",{replayId:"one",reason:"selection"}],["analysis-settings",{settings:{mode:"off",userPaused:false,workers:1,pauseOnBattery:true,extra:true}}]] as const){
      await server.receive(request("bad",method,args));expect(messages.at(-1)?.ok).toBe(false);
    }
    expect(edit).toHaveBeenCalledTimes(1);expect(analysis).toHaveBeenCalledTimes(3);
  }finally{edit.mockRestore();analysis.mockRestore();}
});
it("rejects retired C context and publication endpoints",async()=>{
  await initialize();
  for(const method of ["incidents-probe-context","incident-preparation-context","incidents-commit","incident-preparation-commit"]){
    await server.receive(request(method,method,{ticket:{replayId:"replay",stage:"C"}}));
    expect(messages.at(-1)).toMatchObject({ok:false,error:expect.stringMatching(/Unknown|Unsupported|Invalid/i)});
  }
});
it("requires initialization and a typed operation, without an arbitrary storage API", async () => {
  await server.receive(request("before", "status"));
  expect(messages.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/initialized/) });
  await initialize(); await server.receive(request("status", "status"));
  expect(messages.at(-1)).toMatchObject({ id: "status", ok: true, data: { replayCount: 0 } });
  await server.receive(request("sql", "executeSql", { sql: "DROP TABLE replays" }));
  expect(messages.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/operation/i) });
});
it("handles stop controls without waiting for a source scan or viewer demand to finish", async () => {
  await initialize(); await server.receive(request("pause", "viewer-demand", { active: true }));
  await server.receive(request("scan", "scan", { sourceId: "imports" }));
  await server.receive(request("stop", "stop", { sourceId: "imports" }));
  await server.receive(request("close", "close"));
  expect(messages.filter(message => ["pause", "scan", "stop", "close"].includes(message.id)).every(message => message.ok)).toBe(true);
  await server.receive(request("late", "status"));
  expect(messages.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/closed/) });
});
it("admits rebuild and Stop controls while the viewer holds work", async () => {
  await initialize(); await server.receive(request("pause", "viewer-demand", { active: true }));
  await server.receive(request("rebuild", "rebuild")); await server.receive(request("rebuild-stop", "rebuild-stop"));
  await server.receive(request("close", "close"));
  expect(messages.every(message => message.ok)).toBe(true);
});
it("rejects malformed payloads and never substitutes truthiness for booleans", async () => {
  await initialize(); await server.receive(request("bad", "viewer-demand", { active: "false" }));
  expect(messages.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/Invalid/) });
  await server.receive(request("huge", "import", { paths: Array(1001).fill(join(root, "file.osr")) }));
  expect(messages.at(-1)).toMatchObject({ ok: false });
  await server.receive(request("again", "initialize", {}));
  expect(messages.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/initialized/) });
});

it("bounds concurrent control requests as well as ordinary requests", async () => {
  await initialize();
  await Promise.all(Array.from({ length: 100 }, (_, i) => server.receive(request("demand-" + i, "viewer-demand", { active: true }))));
  expect(messages.filter(message => message.error?.includes("busy")).length).toBeGreaterThan(0);
  await server.receive(request("resume", "viewer-demand", { active: false }));
  expect(messages.at(-1)).toMatchObject({ ok: true });
});

it("acknowledges metadata readiness under viewer demand while recovery remains parked and cancellable", async () => {
  const store = new LibraryStore(join(root, "library.sqlite"), "previous");
  store.registerSource({ id: "imports", kind: "imported", directory: join(root, "imports") });
  store.prepareImport("imports", "a".repeat(64), {}, 1);
  const generation = store.beginScan("imports");
  const replayId = store.upsertObservation({ sourceId: "imports", sourceKey: "b".repeat(64), locator: join(root, "imports", "retained.osr"),
    sha256: "b".repeat(64), available: false, generation, addedAt: 1, metadata: {} });
  store.close();
  await server.receive(request("before-init-demand", "viewer-demand", { active: true }));
  const initializing = initialize();
  let exposed = false;
  for (let n = 0; n < 100 && !exposed; n++) {
    await setImmediate(); await server.receive(request("initializing-status", "status"));
    exposed = messages.at(-1)?.ok === true;
  }
  expect(exposed).toBe(true);
  for (let n = 0; n < 20 && !messages.some(message => message.id === "init"); n++) await setImmediate();
  expect(messages.find(message => message.id === "init")).toMatchObject({ ok: true, data: { importRecovery: { state: "pending" } } });
  await server.receive(request("prepare-during-recovery", "prepare-open", { replayId }));
  expect(messages.at(-1)).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ replayId })] } });
  await server.receive(request("start-during-recovery", "start-updates"));
  expect(messages.at(-1)).toMatchObject({ ok: true });
  await server.receive(request("close-initializing", "close")); await initializing;
  expect(messages.find(message => message.id === "close-initializing")).toMatchObject({ ok: true });
});

it("prepares bounded selected-location tickets while viewer demand holds all background work", async () => {
  const store = new LibraryStore(join(root, "library.sqlite"), "previous");
  store.registerSource({ id: "imports", kind: "imported", directory: join(root, "imports") });
  const generation = store.beginScan("imports");
  const id = store.upsertObservation({ sourceId: "imports", sourceKey: "a".repeat(64), locator: join(root, "imports", "absent.osr"),
    sha256: "a".repeat(64), available: false, generation, addedAt: 1, metadata: { player: "Fixture" } });
  store.close();
  await initialize(); await server.receive(request("hold", "viewer-demand", { active: true }));
  await server.receive(request("prepare", "prepare-open", { replayId: id }));
  expect(messages.at(-1)).toMatchObject({ ok: true, data: { items: [expect.objectContaining({
    replayId: id, sourceId: "imports", kind: "imported", metadata: { player: "Fixture" },
  })] } });
  const ticket = (messages.at(-1)!.data as { items: unknown[] }).items[0];
  await server.receive(request("maps", "prepare-map", { md5: "b".repeat(32) }));
  expect(messages.at(-1)).toMatchObject({ ok: true, data: { items: [] } });
  await server.receive(request("commit", "commit-open", { ticket, observation: { sha256: "a".repeat(64), available: true, metadata: { player: "Verified" } } }));
  expect(messages.at(-1)).toMatchObject({ ok: true, data: { state: "applied", replayId: id } });
  await server.receive(request("stale", "commit-open", { ticket, observation: { sha256: "a".repeat(64), available: true, metadata: {} } }));
  expect(messages.at(-1)).toMatchObject({ ok: true, data: { state: "stale" } });
  await server.receive(request("invalid-ticket", "commit-open", { ticket: { sourceId: "imports" }, observation: {} }));
  expect(messages.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/Invalid/) });
  await server.receive(request("bad-limit", "prepare-open", { replayId: id, limit: 999 }));
  expect(messages.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/limit/) });
  await server.receive(request("bad-cursor", "prepare-open", { replayId: id, after: { sourceId: 1 } }));
  expect(messages.at(-1)).toMatchObject({ ok: false, error: expect.stringMatching(/cursor/) });
  await server.receive(request("still-held", "status"));
  expect(messages.at(-1)).toMatchObject({ ok: true, data: { sources: [expect.objectContaining({ state: "idle" })] } });
});

it("keeps durable metric transport bounded, passive until explicit admission, and restart-safe", async () => {
  const store = new LibraryStore(join(root, "library.sqlite"), "previous");
  store.registerSource({ id: "imports", kind: "imported", directory: join(root, "imports") });
  const replayId = store.upsertObservation({ sourceId: "imports", sourceKey: "a".repeat(64), locator: join(root, "imports", "absent.osr"),
    sha256: "a".repeat(64), available: false, generation: store.beginScan("imports"), addedAt: 1, metadata: {} });
  store.close(); await initialize();
  const call = async (method: string, args: Record<string, unknown> = {}) => {
    await server.receive(request("metric-" + messages.length, method, args));
    const response = messages.at(-1); expect(response?.ok).toBe(true); return response?.data;
  };
  const input = { replayId, slot: "numerical", stage: "S", inputKey: "A", producerVersion: "fixture" };
  const target = await call("metric-target", { target: input });
  expect(await call("metric-next")).toEqual([]);
  expect(await call("metric-read", { replayId })).toEqual([expect.objectContaining({ target, job: undefined })]);
  const job = await call("metric-request", { target, reason: "selection" }) as { id: string };
  expect(await call("metric-next", { limit: 1, includeNative: false })).toEqual([expect.objectContaining({ id: job.id })]);
  const old = await call("metric-claim", { jobId: job.id });
  expect(await call("metric-release", { ticket: old })).toBe("applied");
  const ticket = await call("metric-claim", { jobId: job.id });
  expect(await call("metric-commit", { patch: { ticket: old, producerVersion: "fixture", fields: { misses: { state: "known", value: 99 } }, provenance: {} } })).toBe("stale");
  expect(await call("metric-fail", { ticket, error: "Replay file is missing" })).toBe("applied");
  const settings = { mode: "off", userPaused: true, workers: 1, pauseOnBattery: false };
  await call("metric-settings", { settings }); expect(await call("metric-settings")).toEqual(settings);
  expect(await call("metric-request", { target, reason: "retry" })).toEqual({ state: "disabled" });
  for (const [method, args] of [["metric-request", { target, reason: "sort" }], ["metric-next", { limit: 257 }],
    ["metric-settings", { settings: { ...settings, mode: ["off"] } }], ["metric-commit", { patch: { ticket } }]]) {
    await server.receive(request("bad-" + messages.length, method as string, args)); expect(messages.at(-1)?.ok).toBe(false);
  }
  await server.close(); server = new LibraryUtilityServer(message => messages.push(message)); await initialize();
  expect(await call("metric-settings")).toEqual(settings);
  expect(await call("metric-read", { replayId })).toEqual([expect.objectContaining({ job: expect.objectContaining({ state: "failed", error: "Replay file is missing" }) })]);
});

it("transports bounded shared P cache values across restart without admitting analysis",async()=>{
  await initialize();
  const call=async(method:string,args:Record<string,unknown>={})=>{
    await server.receive(request("pc-"+messages.length,method,args));const reply=messages.at(-1);expect(reply?.ok).toBe(true);return reply?.data;
  };
  const inputKey="b".repeat(64),value={version:1,objectCount:2,stars:1,maxCombo:2,largeTicks:0,smallTicks:0,sliderTails:0,clockRate:1,drainTimeMs:1000,endTimeMs:2000};
  expect(await call("performance-cache-get",{inputKey,mode:"stable"})).toBeUndefined();
  await call("performance-cache-put",{inputKey,mode:"stable",value});
  expect(await call("performance-cache-get",{inputKey,mode:"stable"})).toEqual(value);
  expect(await call("metric-next")).toEqual([]);expect(await call("preparation-next")).toEqual([]);
  for(const args of [{inputKey:"bad",mode:"stable"},{inputKey,mode:"bad"},{inputKey,mode:"stable",value:{...value,frames:[]}}]){
    await server.receive(request("bad-pc-"+messages.length,args.value?"performance-cache-put":"performance-cache-get",args));expect(messages.at(-1)?.ok).toBe(false);
  }
  await server.close();server=new LibraryUtilityServer(message=>messages.push(message));await initialize();
  expect(await call("performance-cache-get",{inputKey,mode:"stable"})).toEqual(value);
});

it("keeps preparation intent internal and atomically publishes a verified receipt with exact metric targets",async()=>{
  const store=new LibraryStore(join(root,"library.sqlite"),"previous");
  store.registerSource({id:"imports",kind:"imported",directory:join(root,"imports")});
  const replayId=store.upsertObservation({sourceId:"imports",sourceKey:"a".repeat(64),locator:join(root,"imports","missing.osr"),
    sha256:"a".repeat(64),available:false,generation:store.beginScan("imports"),addedAt:1,metadata:{}});store.close();await initialize();
  const call=async(method:string,args:Record<string,unknown>={})=>{
    await server.receive(request("prep-"+messages.length,method,args));const reply=messages.at(-1);expect(reply?.ok).toBe(true);return reply?.data;
  };
  expect(await call("preparation-read",{replayId})).toEqual([]);expect(await call("preparation-next")).toEqual([]);
  await call("preparation-request",{replayId,stage:"S",reason:"selection"});const ticket=await call("preparation-claim",{replayId,stage:"S"});
  const locations=await call("prepare-open",{replayId}) as {items:unknown[]};
  expect(await call("preparation-commit",{ticket,location:locations.items[0],origin:null,observation:{sha256:"a".repeat(64),available:true,metadata:{}},
    targets:[{slot:"numerical",stage:"S",inputKey:"verified-input",producerVersion:"fixture"}]})).toEqual({state:"applied",replayId});
  expect(await call("metric-next")).toEqual([expect.objectContaining({reason:"selection",target:expect.objectContaining({replayId,inputKey:"verified-input"})})]);
  expect(await call("preparation-read",{replayId})).toEqual([
    expect.objectContaining({stage:"P",state:"queued"}),expect.objectContaining({stage:"S",state:"bound"})]);
  for(const [method,args] of [["preparation-request",{replayId,stage:"S",reason:"sort"}],
    ["preparation-next",{limit:129}],["preparation-commit",{ticket,location:{},observation:{},targets:[]}]] as const){
    await server.receive(request("bad-prep-"+messages.length,method,args));expect(messages.at(-1)?.ok).toBe(false);
  }
});
it("publishes a source-only P receipt over the internal transport without a replay refresh",async()=>{
  const md5="a".repeat(32),sha256="b".repeat(64),directory=join(root,"native");
  const store=new LibraryStore(join(root,"library.sqlite"),"previous");store.registerSource({id:"native",kind:"lazer",directory});
  const replayId=store.upsertObservation({sourceId:"native",sourceKey:"score",locator:"native:score",sha256:null,available:false,
    generation:store.beginScan("native"),addedAt:1,metadata:{schemaFingerprint:"c".repeat(64),nativeScore:{id:"score",ruleset:0,
      replay:{status:"missing"},beatmap:{sha256,md5,status:"unverified",path:join(directory,"map")}}}});store.close();
  await server.receive(request("init","initialize",{directory:root,sessionId:"test",nativeExecutable:join(root,"engine.exe"),sources:[{id:"native",kind:"lazer",directory}]}));
  const call=async(method:string,args:Record<string,unknown>={})=>{
    await server.receive(request("pp-"+messages.length,method,args));const reply=messages.at(-1);expect(reply?.ok).toBe(true);return reply?.data;
  };
  await call("preparation-request",{replayId,stage:"P",reason:"selection"});const ticket=await call("preparation-claim",{replayId,stage:"P"});
  expect(await call("performance-context",{ticket})).toMatchObject({mapMd5:md5,replaySha256:null});
  const location=(await call("prepare-open",{replayId}) as {items:unknown[]}).items[0];
  const results=[{slot:"calculated-map",stage:"P",inputKey:"d".repeat(64),producerVersion:"fixture",fields:{mapStars:{state:"known",value:0}},provenance:{mapMd5:md5,mapSha256:sha256}}];
  expect(await call("performance-commit",{ticket,location,map:{md5,sha256},results,origin:null})).toEqual({state:"applied",replayId});
  expect(await call("metric-read",{replayId})).toEqual(expect.arrayContaining([expect.objectContaining({result:expect.objectContaining({fields:results[0].fields})})]));
  expect((await call("prepare-open",{replayId}) as {items:unknown[]}).items[0]).toEqual(location);
  await server.receive(request("bad-p-publication","performance-commit",{ticket,location,map:{md5:"wrong",sha256},results,origin:null}));expect(messages.at(-1)?.ok).toBe(false);
});
it("stores shared aggregate scalars through internal transport while Off without creating jobs",async()=>{
  await initialize();const key="a".repeat(64);
  const call=async(method:string,args:Record<string,unknown>={})=>{
    await server.receive(request("scalar-"+messages.length,method,args));const reply=messages.at(-1);expect(reply?.ok).toBe(true);return reply?.data;
  };
  await call("metric-settings",{settings:{mode:"off",userPaused:false,workers:1,pauseOnBattery:true}});
  await call("performance-scalar-put",{inputKey:key,mode:"stable",value:0});
  expect(await call("performance-scalar-get",{inputKey:key,mode:"stable"})).toBe(0);expect(await call("metric-next")).toEqual([]);
  await server.receive(request("bad-scalar","performance-scalar-put",{inputKey:key,mode:"stable",value:-1}));expect(messages.at(-1)?.ok).toBe(false);
});
