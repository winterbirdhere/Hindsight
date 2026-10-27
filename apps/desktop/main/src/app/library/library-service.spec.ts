import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { LibraryService } from "./library-service";
import { LibraryStore } from "./library-store";
import { setImmediate } from "timers/promises";
import { LazerSource } from "./sources/lazer-source";
import { ReplayImporter } from "./import-replays";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "crypto";
import { parseReplayHeader } from "@rewind/osu-local/osr-reader/header";
import { LibraryNativeWatch } from "./library-native-watch";
import { EventEmitter } from "events";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import { libraryTimelineTarget } from "./library-timeline-target";
import { LIBRARY_P_PRODUCER_VERSION } from "./library-performance-versions";

let root: string; let replays: string; let service: LibraryService;
const version = Buffer.alloc(5); version.writeInt32LE(20260904, 1);
const replay = Buffer.concat([version, Buffer.from([11, 32]), Buffer.from("a".repeat(32)), Buffer.from([0, 0]),
  Buffer.alloc(23), Buffer.from([0]), Buffer.alloc(12), Buffer.alloc(8)]);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hindsight-service-")); replays = join(root, "Replays"); await mkdir(replays);
  await writeFile(join(replays, "original.osr"), replay);
});
afterEach(async () => {
  await service?.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture root");
  await rm(root, { recursive: true, force: true });
});
const config = () => ({ directory: join(root, "owned"), sessionId: "s1", nativeExecutable: join(root, "not-present.exe"),
  sources: [{ id: "replays", kind: "replays" as const, directory: replays }] });

async function seedPreviousCapabilityResult() {
  await mkdir(config().directory, { recursive: true });
  const previous = new LibraryStore(join(config().directory, "library.sqlite"), "previous-producer");
  try {
    previous.registerSource(config().sources[0]);
    const id = previous.upsertObservation({ sourceId: "replays", sourceKey: "old-unknown", locator: join(replays, "old.osr"),
      sha256: "d".repeat(64), available: true, generation: previous.beginScan("replays"), addedAt: 1,
      metadata: { header: { mode: 0, modsBitmask: 0, sourceFormat: "stable", nativeScoreInfo: false } } });
    const input = { replayId: id, slot: "numerical" as const, stage: "S" as const,
      inputKey: "same-v6-input", producerVersion: LIBRARY_NUMERIC_PROJECTION_VERSION };
    const target = previous.metrics.setTarget(input);
    previous.preparations.request(id, "S", "selection");
    const ticket = previous.preparations.claim(id, "S"); if (!ticket) throw Error("Missing seed preparation");
    previous.preparations.complete(ticket, [input]);
    previous.metrics.publishObserved(target, { fields: { completion: { state: "unknown", reason: "completion-not-established" },
      ur: { state: "unknown", reason: "no-valid-timing-samples" } }, provenance: { ruleset: "stable",
      projectionVersion: LIBRARY_NUMERIC_PROJECTION_VERSION, coverageQualified: false, completionEvidence: "source-domain-coverage-v1",
      scoreOrigin: "reconstructed", completeAccuracyEvidence: false, completeBreakEvidence: false, replaySha256: "d".repeat(64) } });
    // This metadata-only service has no P executor. Seed the already completed P
    // work as well, rather than depending on which maintenance lane runs first.
    const mapInput={replayId:id,slot:"calculated-map" as const,stage:"P" as const,
      inputKey:"same-p-input",producerVersion:LIBRARY_P_PRODUCER_VERSION};
    previous.preparations.request(id,"P","selection");
    const mapTicket=previous.preparations.claim(id,"P");if(!mapTicket)throw Error("Missing seed P preparation");
    previous.preparations.complete(mapTicket,[mapInput]);
    const mapTarget=previous.metrics.readTarget(id,"calculated-map");if(!mapTarget)throw Error("Missing seed P target");
    previous.metrics.publishObserved(mapTarget,{fields:{bpm:{state:"known",value:180}},provenance:{}});
    return { id, target, map:previous.metrics.read(id).find(entry=>entry.target.slot==="calculated-map") };
  } finally { previous.close(); }
}

it("reconsiders an old rejected Stable cache once through startup maintenance after the viewer releases", async () => {
  const { id, target, map } = await seedPreviousCapabilityResult();
  service = await LibraryService.open(config(), undefined, created => { void created.setViewerDemand(true); });
  expect(service["store"].metrics.read(id).find(entry => entry.target.slot === "numerical")?.result).toBeDefined();
  expect(service.status().indexMaintenance.capabilityRecovery).toMatchObject({state:"held",complete:false,numerical:0});
  const steps=jest.spyOn(service["store"],"maintainCapabilityRecovery");
  service.status();service.queryRequest("query-detail",{replayId:id});expect(steps).not.toHaveBeenCalled();steps.mockRestore();
  await service.setViewerDemand(false); await service.settleSourceMetrics(); await service.settleIndexMaintenance();
  const current = service["store"].metrics.read(id).find(entry => entry.target.slot === "numerical");
  expect(current?.result).toBeUndefined();
  expect(current?.target.generation).toBeGreaterThan(target.generation);
  expect(service["store"].preparations.read(id).find(row => row.stage === "S")?.state).toBe("queued");
  expect(service["store"].preparations.read(id).find(row => row.stage === "P")?.state).toBe("bound");
  expect(service["store"].metrics.read(id).find(entry=>entry.target.slot==="calculated-map")).toEqual(map);
  expect(service.status().indexMaintenance.capabilityRecovery).toMatchObject({state:"complete",complete:true,numerical:1});
});

it("public analysis retry refreshes selected cached rejected coverage through normal preparation and metric publication",async()=>{
  service=await LibraryService.open(config());const store=service["store"];
  const id=store.upsertObservation({sourceId:"replays",sourceKey:"selected",locator:join(replays,"selected.osr"),sha256:"d".repeat(64),available:true,
    generation:store.beginScan("replays"),addedAt:1,metadata:{header:{mode:0}}});
  const input={replayId:id,slot:"numerical" as const,stage:"S" as const,inputKey:"exact-selected-input",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION};
  const old=store.metrics.setTarget(input);
  store.preparations.request(id,"S","selection");
  const initial=store.preparations.claim(id,"S");if(!initial)throw Error("Expected initial preparation");
  store.preparations.complete(initial,[input]);
  store.metrics.publishObserved(old,{fields:{completion:{state:"unknown",reason:"completion-not-established"},ur:{state:"unknown",reason:"no-valid-timing-samples"}},
    provenance:{projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,coverageQualified:false,completionEvidence:"source-domain-coverage-v1",scoreOrigin:"reconstructed",completeAccuracyEvidence:false,completeBreakEvidence:false}});
  const timeline=store.metrics.setTarget(libraryTimelineTarget(old));
  store.metrics.publishObserved(timeline,{fields:{pp:{state:"unknown",reason:"completion-not-established"}},provenance:{coverageQualified:false}});
  const policy=store.metrics.analysisSettings(),metadata=store["db"].prepare("SELECT * FROM replays WHERE id=?").get(id);
  expect(service.analysisRequest("analysis-retry",{replayId:id})).toBeNull();
  expect(store.metrics.read(id).find(e=>e.target.slot==="numerical")?.result).toBeUndefined();
  const preparation=store.preparations.claim(id,"S");if(!preparation)throw Error("Expected explicit S preparation");
  const completed=store.preparations.complete(preparation,[input],undefined,true);
  if(completed.state!=="applied"||completed.handoff?.state!=="claimed")throw Error("Expected fresh uncached handoff");
  const ticket=completed.handoff.ticket;
  expect(ticket.generation).toBeGreaterThan(old.generation);
  expect(store.metrics.commitAndClaimTimeline({ticket,producerVersion:ticket.producerVersion,fields:{completion:{state:"known",value:"passed"},ur:{state:"known",value:100}},provenance:{coverageQualified:true}}).state).toBe("claimed");
  expect(store.metrics.read(id).find(e=>e.target.slot==="numerical")?.result?.fields.ur).toEqual({state:"known",value:100});
  expect(store.metrics.analysisSettings()).toEqual(policy);expect(store["db"].prepare("SELECT * FROM replays WHERE id=?").get(id)).toEqual(metadata);
});

it("manual feedback switches from failed map metadata to replay checking without calling it complete", async () => {
  service = await LibraryService.open({ ...config(), sources: [{ id: "stable", kind: "stable", directory: replays, songsRoot: replays }] });
  const changes = jest.fn(); service.onLibraryChanged(changes);
  service.scan("stable"); await service.idle();
  expect(service.status().sources.find(source => source.sourceId === "stable")).toMatchObject({ state: "error",
    mapError: expect.any(String), progress: { phase: "checking-replays", completed: 0, unit: "replay-observations" } });
  expect(changes.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({ statusOnly: true, ready: expect.any(Boolean) }));
});

it("manual feedback routes Automatic subscriptions through the service-owned native watcher factory", async () => {
  service = await LibraryService.open(config());
  const owner = (service as unknown as { sourceWatch?: LibraryNativeWatch }).sourceWatch;
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Service watch owner missing");
  const factory = jest.spyOn(owner, "factory").mockImplementation(() => ({ close: () => undefined, on: () => undefined }));
  try {
    service.startUpdates();
    expect(factory.mock.calls.some(([path, recursive]) => path === replays && recursive === true)).toBe(true);
  } finally { await service.close(); factory.mockRestore(); }
});

it("manual feedback service close awaits native watcher drainage before closing its store", async () => {
  service = await LibraryService.open(config());
  await service.settleSourceMetrics(); await service.settleIndexMaintenance();
  let drain: () => void = () => undefined;
  const pending = new Promise<void>(resolve => { drain = resolve; });
  const closeWatch = jest.spyOn(LibraryNativeWatch.prototype, "close").mockReturnValue(pending);
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  try { await setImmediate(); expect(closed).toBe(false); }
  finally { drain(); await closing; closeWatch.mockRestore(); }
  expect(closed).toBe(true);
});

it("manual feedback publishes a steady-state watcher failure while background analysis is Off", async () => {
  service = await LibraryService.open(config());
  service.analysisRequest("analysis-settings", { settings: { mode: "off", workers: 1, userPaused: false, pauseOnBattery: false } });
  const handles = new Map<string, EventEmitter>();
  const factory = jest.spyOn(service["sourceWatch"], "factory").mockImplementation(path => {
    const handle = Object.assign(new EventEmitter(), { close: () => { handles.delete(path); } });
    handles.set(path, handle); return handle;
  });
  try {
    service.startUpdates(); await service.idle(); await service.settleSourceMetrics(); await service.settleIndexMaintenance();
    const changes = jest.fn(); service.onLibraryChanged(changes); changes.mockClear();
    const previous = service.status().sources.find(source => source.sourceId === "replays");
    const revision = (service.queryRequest("query-page", {}) as { revision: string }).revision;
    const handle = handles.get(replays); expect(handle).toBeDefined();
    handle?.emit("error", new Error("Native watcher disconnected"));
    expect(service.status().sources.find(source => source.sourceId === "replays")?.update.watchError).toBe("Native watcher disconnected");
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ statusOnly: true, ready: true }));
    await setImmediate();
    expect(service.status().sources.find(source => source.sourceId === "replays")?.observations).toBe(previous?.observations);
    expect((service.queryRequest("query-page", {}) as { revision: string }).revision).toBe(revision);
  } finally { await service.close(); factory.mockRestore(); }
});

it("reports indexed readiness immediately and parks startup maintenance behind viewer demand", async () => {
  const directory=config().directory;await mkdir(directory);const seed=new LibraryStore(join(directory,"library.sqlite"),"seed");
  seed.registerSource(config().sources[0]);
  const generation=seed.beginScan("replays");
  for(let index=0;index<256;index++)seed.upsertObservation({sourceId:"replays",sourceKey:String(index),generation,addedAt:index,locator:join(replays,index+".osr"),
    sha256:index.toString(16).padStart(64,"0"),metadata:{header:parseReplayHeader(replay)},available:true});
  seed.finishScan("replays",generation);
  seed.close();const db=new DatabaseSync(join(directory,"library.sqlite"));
  db.exec("INSERT OR IGNORE INTO query_projection_dirty(id) SELECT id FROM replays");db.close();
  service=await LibraryService.open(config(),undefined,owner=>{void owner.setViewerDemand(true);},false);
  const changes=jest.fn(),unsubscribe=service.onLibraryChanged(changes);expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ready:false,resourceRevision:expect.any(String)}));
  await setImmediate();expect(service.status().indexMaintenance.state).toBe("waiting-for-viewer");
  const pending=service.status().indexMaintenance.pending;
  expect(()=>service.queryRequest("query-detail",{replayId:"missing"})).toThrow(/updat/i);
  expect(service.status().indexMaintenance.pending).toBe(pending);
  await service.setViewerDemand(false);await service.settleIndexMaintenance();
  expect(service.status().indexMaintenance).toMatchObject({state:"idle",pending:0,ready:true});
  expect(changes).toHaveBeenLastCalledWith(expect.objectContaining({ready:true,resourceRevision:expect.any(String)}));unsubscribe();const count=changes.mock.calls.length;
  service.setUpdateMode("manual");expect(changes).toHaveBeenCalledTimes(count);
});

it("does not maintain retired library cause evidence at startup or after analysis settings change",async()=>{
  const maintained=jest.spyOn(LibraryStore.prototype,"maintainIncidentPreparation");
  try{
    service=await LibraryService.open(config());await service.settleIndexMaintenance();
    service.analysisRequest("analysis-settings",{settings:{mode:"bg",workers:1,userPaused:false,pauseOnBattery:false}});
    await service.settleIndexMaintenance();expect(maintained).not.toHaveBeenCalled();
  }finally{maintained.mockRestore();}
});

it("does not reproject every replay for scheduling-only settings changes",async()=>{
  service=await LibraryService.open(config());service.scan("replays");await service.idle();await service.settleSourceMetrics();await service.settleIndexMaintenance();
  const reproject=jest.spyOn(LibraryStore.prototype,"reprojectSourceMetrics");
  try{
    const settings=service.analysisRequest("analysis-settings",{}) as {mode:"off"|"selection"|"bg";workers:1|2|4;userPaused:boolean;pauseOnBattery:boolean};
    service.analysisRequest("analysis-settings",{settings:{...settings,userPaused:!settings.userPaused,workers:settings.workers===1?2:1}});
    await service.settleSourceMetrics();await service.settleIndexMaintenance();expect(reproject).not.toHaveBeenCalled();
  }finally{reproject.mockRestore();}
});

it("uses targeted source membership maintenance without restarting the global origin pass",async()=>{
  service=await LibraryService.open(config());service.scan("replays");await service.idle();await service.settleSourceMetrics();await service.settleIndexMaintenance();
  const reproject=jest.spyOn(LibraryStore.prototype,"reprojectSourceMetrics");
  try{
    service.setSourceEnabled("replays",false);await service.settleSourceMetrics();await service.settleIndexMaintenance();
    service.setSourceEnabled("replays",true);await service.settleSourceMetrics();await service.settleIndexMaintenance();
    expect(reproject).not.toHaveBeenCalled();expect(service.status().indexMaintenance.ready).toBe(true);
  }finally{reproject.mockRestore();}
});

it("parks bounded obsolete-map cleanup with the viewer without hiding ready indexed data",async()=>{
  let pending=3;
  const count=jest.spyOn(LibraryStore.prototype,"mapGarbagePending").mockImplementation(()=>pending);
  const clean=jest.spyOn(LibraryStore.prototype,"maintainMapGarbage").mockImplementation(limit=>{
    expect(limit).toBe(16);pending--;return{updated:1,pending};
  });
  try{
    service=await LibraryService.open(config(),undefined,owner=>{void owner.setViewerDemand(true);},false);
    await setImmediate();expect(clean).not.toHaveBeenCalled();
    expect(service.status().indexMaintenance).toMatchObject({state:"waiting-for-viewer",pending:0,ready:true,mapGarbagePending:3});
    await service.setViewerDemand(false);await service.settleIndexMaintenance();
    expect(clean).toHaveBeenCalledTimes(3);expect(service.status().indexMaintenance).toMatchObject({state:"idle",ready:true,mapGarbagePending:0});
  }finally{count.mockRestore();clean.mockRestore();}
});

it("parks durable source admission with the viewer while indexed queries remain ready",async()=>{
  let pending=2;
  const count=jest.spyOn(LibraryStore.prototype,"sourceAdmissionPending").mockImplementation(()=>pending);
  const admit=jest.spyOn(LibraryStore.prototype,"maintainSourceAdmission").mockImplementation(()=>({processed:8,pending:--pending}));
  try{
    service=await LibraryService.open(config(),undefined,owner=>{void owner.setViewerDemand(true);},false);
    await setImmediate();expect(admit).not.toHaveBeenCalled();
    expect(service.status().indexMaintenance).toMatchObject({state:"waiting-for-viewer",pending:0,ready:true});
    expect(service.queryRequest("query-page",{query:{}})).toMatchObject({total:0});
    await service.setViewerDemand(false);await service.settleIndexMaintenance();
    expect(admit).toHaveBeenCalledTimes(2);expect(service.status().indexMaintenance).toMatchObject({state:"idle",ready:true});
  }finally{count.mockRestore();admit.mockRestore();}
});

it("notifies active eligibility when an authoritative origin snapshot changes before any row backfill",async()=>{
  const originFile=join(root,"origins.json");service=await LibraryService.open({...config(),sources:[],originFile});
  await service.settleSourceMetrics();const dirty=jest.fn();service.onAnalysisDirty(dirty);
  await writeFile(originFile,JSON.stringify({version:1,entries:{}}));
  const deadline=Date.now()+4000;
  while(service.status().sourceMetrics.snapshotState!=="ready"&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  expect(service.status().replayCount).toBe(0);expect(service.status().sourceMetrics.snapshotState).toBe("ready");
  expect(dirty.mock.calls.some(([flags])=>(flags&4)!==0)).toBe(true);
});

it("reconciles cached origin add/change/removal in Manual mode without blocking viewer-held startup", async () => {
  const directory = config().directory; await mkdir(directory); const imports = join(directory, "imports"); await mkdir(imports);
  const sha = createHash("sha256").update(replay).digest("hex"), originFile = join(root, "replay-origins.json");
  const seed = new LibraryStore(join(directory, "library.sqlite"), "old");
  seed.registerSource({ id: "imports", kind: "imported", directory: imports }); seed.setUpdateMode("manual");
  const intent = seed.prepareImport("imports", sha, { header: parseReplayHeader(replay) }, 1);
  const id = seed.completeImport(intent.id, join(imports, sha + ".osr")); seed.close();
  const origin = (client: string) => JSON.stringify({ version: 1, entries: { [sha]: { client, provenance: "user-confirmed" } } });
  await writeFile(originFile, origin("lazer"));
  service = await LibraryService.open({ ...config(), originFile }, undefined, owner => { void owner.setViewerDemand(true); }, false);
  expect(service.status().sourceMetrics.state).toBe("queued"); await service.idle();
  await service.setViewerDemand(false); await service.settleSourceMetrics();
  const profile = () => {
    const db = new DatabaseSync(join(directory, "library.sqlite"), { readOnly: true });
    try { const row = db.prepare(`SELECT r.payload FROM metric_results r JOIN metric_targets t USING(replay_id,slot,stage,input_key,producer_version)
      WHERE t.slot='source-score'`).get(); return row ? JSON.parse(String(row.payload)).provenance.profileId : undefined; }
    finally { db.close(); }
  };
  expect(profile()).toBe("confirmed-lazer-v1");
  await writeFile(originFile, origin("stable"));
  let deadline = Date.now() + 4000; while (profile() !== "confirmed-stable-v1" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
  expect(profile()).toBe("confirmed-stable-v1");
  await rm(originFile); deadline = Date.now() + 4000;
  while (profile() !== "legacy-wrapper-v1" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
  expect(profile()).toBe("legacy-wrapper-v1"); expect(service.status().sources.every(source => source.state === "idle")).toBe(true);
  await service.close(); service = await LibraryService.open({ ...config(), originFile }); await service.settleSourceMetrics();
  expect(profile()).toBe("legacy-wrapper-v1"); expect(service.status().sourceMetrics).toMatchObject({ state: "idle", snapshotState: "missing",error:undefined });
  // Completed B → bootstrap A can bind foreground observations before maintenance runs.
  // Returning to B must still visit those rows, including after the previous app owner exited.
  await service.close(); await writeFile(originFile, origin("lazer"));
  service = await LibraryService.open({ ...config(), originFile }, undefined, owner => { void owner.setViewerDemand(true); }, false);
  const ticket = service.prepareOpen(id).items[0];
  expect(service.commitOpen(ticket, { sha256: sha, available: true, metadata: ticket.metadata }).state).toBe("applied");
  expect(profile()).toBe("confirmed-lazer-v1");
  await rm(originFile); await service.setViewerDemand(false); await service.settleSourceMetrics();
  expect(profile()).toBe("legacy-wrapper-v1");
});

it("closes the native source owner when retiring the indexing service", async () => {
  const close = jest.spyOn(LazerSource.prototype, "close");
  try { service = await LibraryService.open(config()); await service.close(); expect(close).toHaveBeenCalledTimes(1); }
  finally { close.mockRestore(); }
});

it("owns real scan/storage state, keeps admission responsive during viewer yielding, and closes cleanly", async () => {
  service = await LibraryService.open(config());
  await service.setViewerDemand(true);
  service.scan("replays");
  expect(service.status().sources.find(s => s.sourceId === "replays")?.state).toBe("queued");
  service.stop("replays"); await service.idle();
  expect(service.status().sources.find(s => s.sourceId === "replays")?.state).toBe("stopped");
  await service.setViewerDemand(false); service.scan("replays"); await service.idle();
  expect(service.status()).toMatchObject({ replayCount: 1, sources: expect.arrayContaining([expect.objectContaining({ sourceId: "replays", state: "complete" })]) });
  await service.close(); service = await LibraryService.open({ ...config(), sessionId: "s2" });
  expect(service.status().replayCount).toBe(1);
});

it("imports only explicitly selected files and joins existing source identity", async () => {
  service = await LibraryService.open(config()); service.scan("replays"); await service.idle();
  const imported = await service.importReplays([join(replays, "original.osr")]);
  expect(imported.failures).toEqual([]);
  expect(imported).toMatchObject({ added: 1, alreadyImported: 0, failed: 0 });
  expect(await service.importReplays([join(replays, "original.osr")])).toMatchObject({ added: 0, alreadyImported: 1, failed: 0 });
  service.scan("imports"); await service.idle();
  expect(service.status().replayCount).toBe(1);
});

it("reports an unavailable native helper as a source error without claiming native support complete", async () => {
  service = await LibraryService.open({ ...config(), sources: [{ id: "lazer", kind: "lazer", directory: root }] });
  service.scan("lazer"); await service.idle();
  expect(service.status().sources.find(s => s.sourceId === "lazer")).toMatchObject({ state: "error", error: expect.stringMatching(/helper/) });
  expect(service.status().replayCount).toBe(0);
});

it("disables a source without deleting its records and refuses scanning it", async () => {
  service = await LibraryService.open(config()); service.scan("replays"); await service.idle();
  service.setSourceEnabled("replays", false); expect(() => service.scan("replays")).toThrow(/disabled/i); await service.idle();
  expect(service.status()).toMatchObject({ replayCount: 1, sources: expect.arrayContaining([expect.objectContaining({ enabled: false })]) });
  service.setSourceEnabled("replays", true); service.scan("replays"); await service.idle();
  expect(service.status().sources.find(s => s.sourceId === "replays")?.state).toBe("complete");
});

it("retains actionable initialization recovery failures in status", async () => {
  const directory = config().directory; await mkdir(directory); const imports = join(directory, "imports"); await mkdir(imports);
  const database = new LibraryStore(join(directory, "library.sqlite"), "old-session");
  database.registerSource({ id: "imports", kind: "imported", directory: imports });
  database.prepareImport("imports", "a".repeat(64), {}, 1); database.close();
  service = await LibraryService.open(config());
  expect(service.status().importRecovery).toMatchObject({ failed: 1, failures: [expect.stringMatching(/select the original/)] });
});

async function seedRecovery() {
  const directory = config().directory; await mkdir(directory); const imports = join(directory, "imports"); await mkdir(imports);
  const database = new LibraryStore(join(directory, "library.sqlite"), "old-session");
  database.registerSource({ id: "imports", kind: "imported", directory: imports });
  database.prepareImport("imports", "a".repeat(64), {}, 1); database.close();
}

it("defers updates until held recovery completes and uses the latest update mode", async () => {
  await seedRecovery();
  service = await LibraryService.open(config(), undefined, owner => { void owner.setViewerDemand(true); }, false);
  const factory = jest.spyOn(service["sourceWatch"], "factory").mockImplementation(() => ({ close: () => undefined, on: () => undefined }));
  try {
    service.startUpdates(); service.startUpdates(); service.setUpdateMode("manual");
    expect(service.status().importRecovery.state).toBe("pending"); expect(() => service.scan("replays")).toThrow(/recovery/);
    expect(() => service.rebuild()).toThrow(/recovery/);
    await service.setViewerDemand(false); await service.idle();
    expect(service.status()).toMatchObject({ replayCount: 0, importRecovery: { state: "complete", failed: 1 } });
    service.setUpdateMode("auto"); await service.idle(); expect(service.status().replayCount).toBe(1);
  } finally { await service.close(); factory.mockRestore(); }
});

it("cancels an import queued behind held recovery before closing SQLite", async () => {
  await seedRecovery();
  service = await LibraryService.open(config(), undefined, owner => { void owner.setViewerDemand(true); }, false);
  const pending = service.importReplays([join(replays, "original.osr")]);
  const cancelled = expect(pending).rejects.toThrow(/abort/i);
  await service.close(); await cancelled;
  service = await LibraryService.open(config());
  expect(service.status()).toMatchObject({ replayCount: 0, importRecovery: { state: "complete", failed: 1 } });
});

it("retains fatal recovery failure and refuses imports without leaking database ownership", async () => {
  await seedRecovery();
  const recover = jest.spyOn(ReplayImporter.prototype, "recover").mockRejectedValueOnce(new Error("Journal inaccessible"));
  const local = await LibraryService.open(config(), undefined, undefined, false);
  try {
    await expect(local.idle()).rejects.toThrow("Journal inaccessible"); local.startUpdates();
    expect(local.status().importRecovery).toMatchObject({ state: "failed", error: "Journal inaccessible" });
    await expect(local.importReplays([join(replays, "original.osr")])).rejects.toThrow("Journal inaccessible");
    expect(() => local.rebuild()).toThrow("Journal inaccessible");
  } finally { recover.mockRestore(); await expect(local.close()).rejects.toThrow("Journal inaccessible"); }
  service = await LibraryService.open(config()); expect(service.status().replayCount).toBe(0);
});

it("keeps explicit import work behind viewer demand and can close while it is parked", async () => {
  service = await LibraryService.open(config()); await service.setViewerDemand(true);
  let finished = false;
  const pending = service.importReplays([join(replays, "original.osr")]).finally(() => { finished = true; });
  const cancelled = expect(pending).rejects.toThrow(/abort/i);
  await setImmediate(); await setImmediate();
  expect(finished).toBe(false); expect(service.status().replayCount).toBe(0);
  await service.close(); await cancelled;
});

it("rebuilds actual source records atomically and Stop cancels a viewer-parked rebuild", async () => {
  service = await LibraryService.open(config()); service.scan("replays"); await service.idle();
  const second = Buffer.from(replay); second.writeInt32LE(20260905, 1); await writeFile(join(replays, "second.osr"), second);
  await service.setViewerDemand(true); service.rebuild();
  expect(() => service.scan("replays")).toThrow(/rebuild/i);
  await setImmediate(); service.stopRebuild(); await service.idle();
  expect(service.status()).toMatchObject({ replayCount: 1, rebuild: { state: "stopped" } });
  await service.setViewerDemand(false); service.rebuild(); await service.idle();
  // Cached file has one observation; a new file publishes header and verified-byte observations.
  expect(service.status()).toMatchObject({ replayCount: 2, rebuild: { state: "complete", observations: 3 } });
  await service.close(); service = await LibraryService.open({ ...config(), sessionId: "s2" });
  expect(service.status().replayCount).toBe(2);
});

it("applies injected nested replay notifications in Automatic and preserves Manual across restart", async () => {
  service = await LibraryService.open(config()); service.setUpdateMode("manual"); service.startUpdates(); await service.idle();
  const notifications = new Map<string, (event: string, filename: string | null) => void>();
  // External notification delivery is the native owner's fixture boundary. This
  // service test retains actual file scanning and Automatic/Manual scheduling.
  const factory = jest.spyOn(service["sourceWatch"], "factory").mockImplementation((path, _recursive, notify) => {
    notifications.set(path, notify); return { close: () => { notifications.delete(path); }, on: () => undefined };
  });
  try {
    expect(service.status().replayCount).toBe(0); service.setUpdateMode("auto"); await service.idle();
    expect(service.status().replayCount).toBe(1);
    const nested = join(replays, "nested"); await mkdir(nested);
    const second = Buffer.from(replay); second.writeInt32LE(20260906, 1); await writeFile(join(nested, "second.osr"), second);
    const notify = notifications.get(replays); expect(notify).toBeDefined(); notify?.("rename", "nested/second.osr");
    await service.idle();
    expect(service.status().replayCount).toBe(2); expect(service.status().sources.every(source => !source.update.watchError)).toBe(true);
    service.setUpdateMode("manual"); await service.idle(); await service.close(); expect(notifications.size).toBe(0);
  } finally { factory.mockRestore(); }
  service = await LibraryService.open({ ...config(), sessionId: "s2" }); service.startUpdates(); await service.idle();
  expect(service.status().updateMode).toBe("manual"); expect(service.status().sources.every(source => source.state === "idle")).toBe(true);
});

async function pendingNativeStatus() {
  type Page = Awaited<ReturnType<LazerSource["page"]>>;
  let reply: ((value: Page) => void) | undefined;
  const page = jest.spyOn(LazerSource.prototype, "page").mockImplementation((_directory, _cursor, signal) =>
    new Promise<Page>((resolve, reject) => {
      const abort = () => reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      reply = value => { signal?.removeEventListener("abort", abort); resolve(value); };
    }));
  try {
    service = await LibraryService.open({ ...config(), sources: [{ id: "native", kind: "lazer", directory: join(root, "absent-lazer") }] },
      undefined, undefined, true, { run: (_phase, work) => work() });
    await service.settleSourceMetrics(); await service.settleIndexMaintenance();
    service.setUpdateMode("manual");
    const changes = jest.fn(), unsubscribe = service.onLibraryChanged(changes);
    service.scan("native");
    for (let turn = 0; !reply && turn < 50; turn++) await setImmediate();
    if (!reply) throw new Error("Expected pending native page");
    expect(service.status().sources.find(source => source.sourceId === "native")?.state).toBe("scanning");
    changes.mockClear();
    return { page, changes, reply, unsubscribe };
  } catch (error) { page.mockRestore(); throw error; }
}

it.each(["source-missing", "incompatible-helper"] as const)("publishes terminal native %s without an incidental query mutation", async status => {
  const f = await pendingNativeStatus();
  try {
    const revision = (service.queryRequest("query-page", {}) as { revision: string }).revision;
    const resourceRevision = service["store"].resourceRevision();
    f.reply({ version: 1, ok: false, status }); await service.idle();
    expect(service.status().sources.find(source => source.sourceId === "native")).toMatchObject({ state: "error", observations: 0,
      error: "Native source scan: " + status, failureReason: status === "source-missing" ? status : undefined });
    expect(f.changes).toHaveBeenCalledTimes(1);
    expect(f.changes).toHaveBeenLastCalledWith({ ready: true, resourceRevision });
    expect((service.queryRequest("query-page", {}) as { revision: string }).revision).toBe(revision);
    expect(f.page).toHaveBeenCalledTimes(1);
  } finally { f.unsubscribe(); f.page.mockRestore(); }
});

it("publishes terminal Stop while deduplicating identical native waiting states", async () => {
  const f = await pendingNativeStatus();
  try {
    await service.setViewerDemand(true); expect(f.changes).toHaveBeenCalledTimes(1);
    for (let repeat = 0; repeat < 50; repeat++) await service.setViewerDemand(true);
    expect(f.changes).toHaveBeenCalledTimes(1);
    await service.setViewerDemand(false); expect(f.changes).toHaveBeenCalledTimes(2);
    service.stop("native"); await service.idle();
    expect(service.status().sources.find(source => source.sourceId === "native")?.state).toBe("stopped");
    expect(f.changes).toHaveBeenCalledTimes(3); expect(f.page).toHaveBeenCalledTimes(1);
    await setImmediate(); expect(f.page).toHaveBeenCalledTimes(1);
  } finally { f.unsubscribe(); f.page.mockRestore(); }
});

it("keeps the existing store publication on terminal empty native success", async () => {
  const f = await pendingNativeStatus();
  try {
    const page = { version: 1 as const, ok: true, status: "ready" as const, sampleOnly: false,
      schemaFingerprint: "a".repeat(64), cursorToken: "b".repeat(64), nextOffset: 0, total: 0, complete: true, scores: [] };
    f.page.mockResolvedValue(page); f.reply(page); await service.idle();
    expect(service.status().sources.find(source => source.sourceId === "native")).toMatchObject({ state: "complete", observations: 0 });
    // One store transaction plus one meaningful terminal status remain semantic.
    // Source-record admission and committing are separate status-only phase updates.
    expect(f.changes.mock.calls.filter(([event]) => event.statusOnly !== true)).toHaveLength(2);
    expect(f.changes.mock.calls.filter(([event]) => event.statusOnly === true)).toHaveLength(2);
    expect(f.page).toHaveBeenCalledTimes(2);
    expect(service["store"].sourceHasIndexHistory("native")).toBe(true);
    await setImmediate(); expect(f.page).toHaveBeenCalledTimes(2);
  } finally { f.unsubscribe(); f.page.mockRestore(); }
});
