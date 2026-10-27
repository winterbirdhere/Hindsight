import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
import { LibraryScheduler, LibraryScheduledWork, LibrarySchedulerControl } from "./library-scheduler";
import type { LibraryMetricResult, LibraryMetricTicket, LibraryAnalysisSettings } from "../../../../shared/replay-library-metrics";

let root: string, database: string, store: LibraryStore, scheduler: LibraryScheduler, count: number;
type Running = { ticket: LibraryMetricTicket; signal: AbortSignal; resolve(value: LibraryMetricResult): void;
  reject(error: Error): void; control: jest.Mock; aborts: number };
let running: Running[], drainOnAbort: boolean, claimReply: Promise<void> | undefined, beforeClaim: Promise<void> | undefined, commitReply: Promise<void> | undefined, nextReply: Promise<void> | undefined;
beforeEach(() => {
  jest.useFakeTimers(); root = mkdtempSync(join(tmpdir(), "hindsight-scheduler-")); database = join(root, "library.sqlite");
  store = new LibraryStore(database, "one"); count = 0; running = []; drainOnAbort = true; claimReply = undefined; beforeClaim = undefined;
  commitReply = undefined; nextReply = undefined;
  store.registerSource({ id: "source", kind: "replays", directory: "C:\\fixture" });
  scheduler = new LibraryScheduler({
    settings: () => store.metrics.analysisSettings(), nextQueued: async (limit, native) => { const candidates=store.metrics.nextQueued(limit,native);await nextReply;return candidates; },
    claim: async id => { await beforeClaim; const ticket = store.metrics.claim(id); await claimReply; return ticket; },
    commit: async patch => { await commitReply; return store.metrics.commit(patch); },
    fail: (ticket, error) => store.metrics.fail(ticket, error), release: ticket => store.metrics.release(ticket),
  }, (ticket, initial, signal): LibraryScheduledWork => {
    let resolve!: Running["resolve"], reject!: Running["reject"];
    const result = new Promise<LibraryMetricResult>((res, rej) => { resolve = res; reject = rej; });
    const control = jest.fn(async (value: LibrarySchedulerControl) => value.viewerDemand || value.userPaused ? "parked" as const : "released" as const);
    const item: Running = { ticket, signal, resolve, reject, control, aborts: 0 }; running.push(item);
    signal.addEventListener("abort", () => { item.aborts++; if (drainOnAbort) reject(new Error("Cancelled after draining")); }, { once: true });
    void control(initial); return { result, control };
  });
});
afterEach(async () => {
  drainOnAbort = true;
  running.filter(task => task.signal.aborted).forEach(task => task.reject(new Error("Fixture cleanup")));
  await scheduler.close(); store.close();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(database + suffix)) unlinkSync(database + suffix);
  rmdirSync(root); jest.useRealTimers();
});
function queue(stage: "S" | "P" | "C" = "S") {
  const id = String(++count), replayId = store.upsertObservation({ sourceId: "source", sourceKey: id, locator: id,
    sha256: count.toString(16).padStart(64, "0"), available: true, generation: store.beginScan("source"), addedAt: count, metadata: {} });
  const target = store.metrics.setTarget({ replayId, stage, slot: stage === "S" ? "numerical" : stage === "C" ? "incidents" : "aggregate-pp",
    inputKey: "A", producerVersion: "test" });
  store.metrics.request(target, "background"); return target;
}
async function start() { await scheduler.refresh(); await scheduler.setViewerDemand(false); await jest.advanceTimersByTimeAsync(200); await scheduler.settleAdmissions(); }
function result(ticket: LibraryMetricTicket): LibraryMetricResult {
  return { fields: { [ticket.stage === "P" ? "pp" : ticket.stage === "C" ? "incidentCount" : "misses"]: { state: "known", value: 1 } }, provenance: {} };
}

it("applies only accepted latest policy before queue admission and ignores refreshes completed after close",async()=>{
  const settings:LibraryAnalysisSettings={mode:"bg",workers:4,userPaused:false,pauseOnBattery:true,fasterProcessing:true};
  let stale!:(value:LibraryAnalysisSettings)=>void,late!:(value:LibraryAnalysisSettings)=>void;
  const policy=jest.fn(),next=jest.fn(()=>{expect(policy).toHaveBeenCalled();return [];});
  const read=jest.fn().mockImplementationOnce(()=>new Promise(resolve=>{stale=resolve;})).mockResolvedValueOnce({...settings,fasterProcessing:false})
    .mockImplementationOnce(()=>new Promise(resolve=>{late=resolve;}));
  const isolated=new LibraryScheduler({settings:read,nextQueued:next,claim:jest.fn(),commit:jest.fn(),fail:jest.fn(),release:jest.fn()},jest.fn(),0,undefined,undefined,policy);
  const old=isolated.refresh();await isolated.refresh();stale(settings);await old;
  expect(policy).toHaveBeenCalledTimes(1);expect(policy).toHaveBeenLastCalledWith({...settings,fasterProcessing:false});
  await isolated.setViewerDemand(false);await jest.advanceTimersByTimeAsync(0);await isolated.settleAdmissions();expect(next).toHaveBeenCalled();
  const pending=isolated.refresh();await isolated.close();late(settings);await pending;expect(policy).toHaveBeenCalledTimes(1);
});

it("updates faster processing on the same active continuations and retains viewer and Pause holds",async()=>{
  queue();queue();await start();const attempts=running.map(task=>task.ticket.attempt);
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),fasterProcessing:true});await scheduler.refresh();
  expect(running.every(task=>task.control.mock.lastCall[0].fasterProcessing===true)).toBe(true);
  await scheduler.setViewerDemand(true);
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),fasterProcessing:false,userPaused:true});await scheduler.refresh();
  expect(running.every(task=>task.control.mock.lastCall[0].viewerDemand&&task.control.mock.lastCall[0].userPaused&&!task.control.mock.lastCall[0].fasterProcessing)).toBe(true);
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),fasterProcessing:true});await scheduler.refresh();
  expect(running.every(task=>task.control.mock.lastCall[0].viewerDemand&&task.control.mock.lastCall[0].userPaused&&task.control.mock.lastCall[0].fasterProcessing)).toBe(true);
  expect(running.map(task=>task.ticket.attempt)).toEqual(attempts);expect(running.every(task=>task.aborts===0)).toBe(true);
});

it("starts fail-closed, obeys 1/2/4 ceilings and parks overflow without restarting it", async () => {
  for (let i = 0; i < 7; i++) queue();
  await scheduler.refresh(); await scheduler.settleAdmissions(); expect(running).toHaveLength(0);
  await start(); expect(running).toHaveLength(2);
  store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), workers: 4 });
  await scheduler.refresh(); await scheduler.settleAdmissions(); expect(running).toHaveLength(4);
  store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), workers: 1 });
  await scheduler.refresh();
  expect(running.slice(1).every(task => task.control.mock.lastCall[0].viewerDemand === true)).toBe(true);
  expect(running.map(task => task.aborts)).toEqual([0, 0, 0, 0]);
  running[0].resolve(result(running[0].ticket)); await jest.advanceTimersByTimeAsync(0); await scheduler.settleAdmissions();
  expect(running).toHaveLength(4); expect(running[1].control.mock.lastCall[0].viewerDemand).toBe(false);
});

it("reuses the same continuations through viewer changes, debounces resume and keeps user Pause distinct", async () => {
  queue(); queue(); queue(); await start(); const attempts = running.map(task => task.ticket.attempt);
  await scheduler.setViewerDemand(true);
  expect(running.every(task => task.control.mock.lastCall[0].viewerDemand && !task.control.mock.lastCall[0].userPaused)).toBe(true);
  await scheduler.setViewerDemand(false); await jest.advanceTimersByTimeAsync(50); await scheduler.setViewerDemand(true);
  await jest.advanceTimersByTimeAsync(500); expect(running.every(task => task.control.mock.lastCall[0].viewerDemand)).toBe(true);
  store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), userPaused: true }); await scheduler.refresh();
  await scheduler.setViewerDemand(false); await jest.advanceTimersByTimeAsync(200);
  expect(running.every(task => task.control.mock.lastCall[0].userPaused && !task.control.mock.lastCall[0].viewerDemand)).toBe(true);
  store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), userPaused: false }); await scheduler.refresh();
  expect(running.map(task => task.ticket.attempt)).toEqual(attempts); expect(running.every(task => task.aborts === 0)).toBe(true);
});

it("keeps one native background owner while numerical jobs use other slots", async () => {
  queue(); for (let i = 0; i < 40; i++) queue("P"); await start();
  expect(running.map(task => task.ticket.stage).sort()).toEqual(["P", "S"]);
  const native = running.find(task => task.ticket.stage === "P") as Running;
  native.resolve(result(native.ticket)); await jest.advanceTimersByTimeAsync(0); await scheduler.settleAdmissions();
  expect(running).toHaveLength(3); expect(running[2].ticket.stage).toBe("P");
});

it("discards a fast native selection when conservative settings finish during its asynchronous lookup",async()=>{
  queue("P");await start();queue("P");let release!:()=>void;nextReply=new Promise<void>(resolve=>{release=resolve;});
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),fasterProcessing:true});await scheduler.refresh();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),fasterProcessing:false});await scheduler.refresh();
  release();await scheduler.settleAdmissions();expect(running).toHaveLength(1);expect(running[0].aborts).toBe(0);
  running[0].resolve(result(running[0].ticket));await jest.advanceTimersByTimeAsync(0);await scheduler.settleAdmissions();expect(running).toHaveLength(2);
});

it.each([1,2,4] as const)("Maximum speed admits native work only within the selected %s-worker ceiling",async workers=>{
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),workers,fasterProcessing:true});for(let i=0;i<6;i++)queue("P");await start();
  expect(running).toHaveLength(workers);expect(running.every(task=>task.ticket.stage==="P")).toBe(true);
  await scheduler.setViewerDemand(true);store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),fasterProcessing:false,userPaused:true});await scheduler.refresh();
  expect(running).toHaveLength(workers);expect(running.every(task=>task.control.mock.lastCall[0].viewerDemand&&task.control.mock.lastCall[0].userPaused&&task.aborts===0)).toBe(true);
});

it.each([false,true])("Off cancels only unfinished S/C once and never recreates their jobs, faster=%s", async fasterProcessing => {
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),fasterProcessing});
  const s = queue(), p = queue("P"); await start();
  const numerical = running.find(task => task.ticket.stage === "S") as Running;
  numerical.control.mockImplementation(async () => { if (numerical.signal.aborted) throw new Error("Worker already closed"); return "released"; });
  store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), mode: "off" }); await scheduler.refresh(); await scheduler.refresh();
  await jest.advanceTimersByTimeAsync(0); await scheduler.settleAdmissions();
  expect(running.find(task => task.ticket.stage === "S")?.aborts).toBe(1);
  expect(running.find(task => task.ticket.stage === "P")?.aborts).toBe(0);
  expect(store.metrics.read(s.replayId)[0].job).toBeUndefined();
  expect(store.metrics.read(p.replayId)[0].job?.state).toBe("running");
});

it("faster processing does not admit background S in On demand or replace an explicitly opened job",async()=>{
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"demand",fasterProcessing:true});
  const selected=queue();queue();await start();expect(running).toHaveLength(0);
  store.metrics.request(selected,"open");await scheduler.refresh();await scheduler.settleAdmissions();
  expect(running).toHaveLength(1);expect(running[0].ticket.replayId).toBe(selected.replayId);
  const attempt=running[0].ticket.attempt;
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),fasterProcessing:false});await scheduler.refresh();
  expect(running).toHaveLength(1);expect(running[0].ticket.attempt).toBe(attempt);expect(running[0].aborts).toBe(0);
});

it("battery policy parks current jobs without changing persisted user Pause", async () => {
  queue(); await start(); await scheduler.setOnBattery(true);
  expect(running[0].control.mock.lastCall[0]).toEqual({ viewerDemand: true, userPaused: false });
  expect(store.metrics.analysisSettings().userPaused).toBe(false);
  store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), pauseOnBattery: false }); await scheduler.refresh();
  expect(running[0].control.mock.lastCall[0]).toEqual({ viewerDemand: false, userPaused: false });
});

it("does not start an S/C claim whose reply arrives after Off was persisted and refreshed", async () => {
  const target = queue(); let deliver!: () => void; claimReply = new Promise(resolve => { deliver = resolve; });
  await scheduler.refresh(); await scheduler.setViewerDemand(false); await jest.advanceTimersByTimeAsync(200);
  expect(store.metrics.read(target.replayId)[0].job?.state).toBe("running");
  store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), mode: "off" }); await scheduler.refresh();
  deliver(); await scheduler.settleAdmissions();
  expect(running).toHaveLength(0); expect(store.metrics.read(target.replayId)[0].job).toBeUndefined();
});

it("continues to the next job when an asynchronous claim loses its queued target", async () => {
  const older = queue(), newer = queue(); let deliver!: () => void; beforeClaim = new Promise(resolve => { deliver = resolve; });
  await scheduler.refresh(); await scheduler.setViewerDemand(false); await jest.advanceTimersByTimeAsync(200);
  store.metrics.publishObserved(newer, { fields: { misses: { state: "known", value: 0 } }, provenance: {} });
  deliver(); await scheduler.settleAdmissions();
  expect(running).toHaveLength(1); expect(running[0].ticket.replayId).toBe(older.replayId);
});

it("waits for the latest required hold when an older control is superseded", async () => {
  queue(); await start();
  let old!: (state: string) => void, latest!: (state: string) => void;
  running[0].control.mockImplementationOnce(() => new Promise(resolve => { old = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
  let acknowledged = false;
  const hold = scheduler.setViewerDemand(true).then(() => { acknowledged = true; });
  await jest.advanceTimersByTimeAsync(0);
  store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), userPaused: true });
  const paused = scheduler.refresh(); await jest.advanceTimersByTimeAsync(0);
  old("superseded"); await jest.advanceTimersByTimeAsync(0); expect(acknowledged).toBe(false);
  latest("parked"); await Promise.all([hold, paused]); expect(acknowledged).toBe(true); expect(running[0].aborts).toBe(0);
});

it("does not control a drained worker while its atomic publication is still pending", async () => {
  queue(); await start(); let publish!: () => void; commitReply = new Promise(resolve => { publish = resolve; });
  running[0].resolve(result(running[0].ticket)); await jest.advanceTimersByTimeAsync(0);
  running[0].control.mockRejectedValue(new Error("Worker already closed"));
  const calls = running[0].control.mock.calls.length;
  try {
    await expect(scheduler.setViewerDemand(true)).resolves.toBeUndefined();
    expect(running[0].control.mock.calls).toHaveLength(calls); expect(scheduler.status().error).toBeUndefined();
  } finally { publish(); await jest.advanceTimersByTimeAsync(0); }
});

it("waits for actual worker drainage before releasing an attempt on close", async () => {
  const target = queue(); await start(); drainOnAbort = false;
  let closed = false; const closing = scheduler.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); expect(running[0].signal.aborted).toBe(true);
  expect(store.metrics.read(target.replayId)[0].job?.state).toBe("running");
  running[0].reject(new Error("Owned worker now exited")); await closing;
  expect(store.metrics.read(target.replayId)[0].job?.state).toBe("queued");
});

it("stores a failed job once and requires explicit retry instead of an automatic loop", async () => {
  const target = queue(); await start(); running[0].reject(new Error("Replay map could not be read"));
  await jest.advanceTimersByTimeAsync(0); await scheduler.settleAdmissions();
  expect(store.metrics.read(target.replayId)[0].job).toMatchObject({ state: "failed", error: "Replay map could not be read" });
  scheduler.wake(); await scheduler.settleAdmissions(); await jest.advanceTimersByTimeAsync(60000); expect(running).toHaveLength(1);
  store.metrics.request(target, "retry"); scheduler.wake(); await scheduler.settleAdmissions(); expect(running).toHaveLength(2);
});

function queueStripRepair(){
  const prior=queue(),target=store.metrics.setTarget({...prior,producerVersion:"library-numeric-v6"});
  store.metrics.publishObserved(target,{fields:{ur:{state:"known",value:20}},provenance:{replaySha256:count.toString(16).padStart(64,"0"),projectionVersion:"library-numeric-v6",
    ruleset:"stable",scoreOrigin:"reconstructed",coverageQualified:true,completionEvidence:"source-domain-coverage-v1"},errorStrip:{state:"unknown",reason:"strip-size-limit"}});
  expect(store.metrics.admitStripRepairInTransaction(target.replayId)).toBe(true);return target;
}
it("releases a strip-only claim when OnDemand wins its asynchronous reply",async()=>{
  const target=queueStripRepair();let deliver!:()=>void;claimReply=new Promise(resolve=>{deliver=resolve;});
  await scheduler.refresh();await scheduler.setViewerDemand(false);await jest.advanceTimersByTimeAsync(200);
  expect(store.metrics.readErrorStrip(target.replayId)?.job?.state).toBe("running");
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"demand"});await scheduler.refresh();
  deliver();await scheduler.settleAdmissions();expect(running).toHaveLength(0);
  expect(store.metrics.readErrorStrip(target.replayId)?.job).toMatchObject({reason:"strip-repair",state:"queued"});
  expect(store.metrics.read(target.replayId).find(e=>e.target.slot==="numerical")?.result?.fields.ur.state).toBe("known");
});
it("parks a strip repair under viewer, battery and user Pause without replacing its scalar or attempt",async()=>{
  const target=queueStripRepair();await start();expect(running).toHaveLength(1);const attempt=running[0].ticket.attempt;
  await scheduler.setViewerDemand(true);expect(running[0].control.mock.lastCall[0].viewerDemand).toBe(true);
  await scheduler.setOnBattery(true);await scheduler.setViewerDemand(false);await jest.advanceTimersByTimeAsync(200);
  expect(running[0].control.mock.lastCall[0].viewerDemand).toBe(true);
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:true});await scheduler.refresh();
  await scheduler.setOnBattery(false);expect(running[0].control.mock.lastCall[0].userPaused).toBe(true);
  expect(running[0].ticket.attempt).toBe(attempt);expect(running[0].aborts).toBe(0);
  expect(store.metrics.read(target.replayId).find(e=>e.target.slot==="numerical")?.result?.fields.ur.state).toBe("known");
});
