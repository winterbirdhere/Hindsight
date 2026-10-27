import { LibraryStore } from "./library-store";
import { LibraryScanCoordinator } from "./library-scan-coordinator";
import { LibrarySourceScanError } from "./library-source-state";
import type { FileSourceObservation } from "./sources/replays-folder-source";

const observation = (key: string): FileSourceObservation => ({ sourceKey: key, locator: key + ".osr", sha256: key.repeat(64), available: true, metadata: {} });
function deferred() { let resolve: () => void = () => undefined; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
let store: LibraryStore;
beforeEach(() => { store = new LibraryStore(":memory:", "session"); store.registerSource({ id: "replays", kind: "replays", directory: "C:\\replays" }); });
afterEach(() => store.close());

it("forwards only an explicit certified check and defaults direct scans to refresh", async () => {
  const intents: string[] = [];
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* (options) {
    intents.push(options.resourceIntent ?? "missing"); yield* [];
  } });
  await coordinator.scan("replays", "check"); await coordinator.scan("replays");
  expect(intents).toEqual(["check", "refresh"]); await coordinator.close();
});
it("makes an uncertain dirty follow-up a refresh without changing the admitted check", async () => {
  const entered = deferred(), gate = deferred(), intents: string[] = [];
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* (options) {
    intents.push(options.resourceIntent ?? "missing");
    if (intents.length === 1) { entered.resolve(); await gate.promise; }
    yield* [];
  } });
  const first = coordinator.scan("replays", "check"); await entered.promise; coordinator.markDirty("replays");
  gate.resolve(); await first; await coordinator.idle();
  expect(intents).toEqual(["check", "refresh"]); await coordinator.close();
});
it("does not consume a direct default refresh in an already admitted check", async () => {
  const entered = deferred(), gate = deferred(), intents: string[] = [];
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* (options) {
    intents.push(options.resourceIntent ?? "missing");
    if (intents.length === 1) { entered.resolve(); await gate.promise; }
    yield* [];
  } });
  const first = coordinator.scan("replays", "check"); await entered.promise;
  void coordinator.scan("replays"); gate.resolve(); await first; await coordinator.idle();
  expect(intents).toEqual(["check", "refresh"]); await coordinator.close();
});

it("manual feedback counts admitted replay observations without calling them unique plays", async () => {
  const statuses = jest.fn();
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* () {
    yield { ...observation("a"), available: false, sha256: null };
    yield observation("a");
  } }, statuses);
  await coordinator.scan("replays");
  expect(coordinator.status("replays")).toMatchObject({ state: "complete", observations: 2,
    progress: { phase: "committing", completed: 2, unit: "replay-observations" } });
  expect(store.listReplayIds()).toHaveLength(1);
  expect(statuses.mock.calls.map(([value]) => value)).toEqual(expect.arrayContaining([
    expect.objectContaining({ state: "scanning", progress: { phase: "committing", completed: 2, unit: "replay-observations" } }),
  ]));
});

it("manual feedback fences progress from stopped tasks and bounds same-phase publication", async () => {
  const entered = deferred(), gate = deferred(), statuses = jest.fn();
  let report: ((value: { phase: string; completed: number; unit: string }) => void) | undefined;
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* (options) {
    report = (options as typeof options & { onProgress?: typeof report }).onProgress;
    for (let completed = 0; completed <= 1000; completed++) report?.({ phase: "reading-map-metadata", completed, unit: "map-records" });
    entered.resolve(); await gate.promise; yield* [];
  } }, statuses);
  const running = coordinator.scan("replays"); await entered.promise;
  try {
    expect(coordinator.status("replays")).toMatchObject({ observations: 0, progress: { phase: "reading-map-metadata", completed: 1000, unit: "map-records" } });
    expect(statuses.mock.calls.length).toBeLessThan(10);
  } finally { coordinator.stop("replays"); gate.resolve(); await running; }
  const stopped = coordinator.status("replays");
  report?.({ phase: "reading-map-metadata", completed: 2000, unit: "map-records" });
  expect(coordinator.status("replays")).toEqual(stopped); expect(stopped.state).toBe("stopped");
  await coordinator.close();
});

it("keeps oversized per-record metadata explicit without losing byte identity or later source rows", async () => {
  const stamp = { bytes: 80, device: "1", inode: "2", modifiedNs: "3", changedNs: "4" };
  let reads = 0;
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* (options) {
    const cached = await options.cached?.("a");
    if (JSON.stringify(cached?.metadata.stamp) === JSON.stringify(stamp) && (cached?.metadata.header as { beatmapMD5?: string })?.beatmapMD5 === "c".repeat(32)) yield cached!;
    else { reads++; yield { ...observation("a"), metadata: { stamp, header: { beatmapMD5: "c".repeat(32) }, validation: "header-only", nativeScore: { mods: [{ settings: "x".repeat(70000) }] }, fileState: "readable" } }; }
    yield observation("b");
  } });
  await coordinator.scan("replays");
  expect(coordinator.status("replays").state).toBe("complete");
  expect(store.listReplayIds()).toHaveLength(2);
  const large = store.listReplayIds().map(id => store.getReplay(id)).find(row => row?.locations[0].sha256 === "a".repeat(64));
  expect(large).toMatchObject({ metadata: { fileState: "readable", metadataState: "resource-limit" }, locations: [expect.objectContaining({ available: true })] });
  expect(large?.metadata.nativeScore).toBeUndefined();
  await coordinator.scan("replays");
  expect(reads).toBe(1);
  expect(large?.metadata).toMatchObject({ stamp, header: { beatmapMD5: "c".repeat(32) }, validation: "header-only" });
});

it("suspends and resumes the same iterator/generation once without cancel/restart on repeated viewer demand", async () => {
  const firstCommitted = deferred(); const release = deferred(); let starts = 0;
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* () {
    starts++; yield observation("a"); firstCommitted.resolve(); await release.promise; yield observation("b");
  } });
  const running = coordinator.scan("replays"); await firstCommitted.promise;
  const paused = coordinator.setViewerDemand(true); coordinator.setViewerDemand(true); release.resolve(); await paused;
  expect(coordinator.status("replays").state).toBe("waiting-for-viewer");
  expect(store.listReplayIds()).toHaveLength(1);
  coordinator.setViewerDemand(false); await running;
  expect(starts).toBe(1); expect(store.listReplayIds()).toHaveLength(2);
  expect(coordinator.status("replays").state).toBe("complete");
});

it("does not mark unseen locations missing or finish the initial baseline after Stop", async () => {
  const gate = deferred(); const entered = deferred();
  const initial = store.beginScan("replays");
  const existing = store.upsertObservation({ ...observation("b"), sourceId: "replays", generation: initial, addedAt: 1 });
  store.stopScan("replays", initial);
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* () {
    yield observation("a"); entered.resolve(); await gate.promise;
  } });
  const running = coordinator.scan("replays"); await entered.promise; coordinator.stop("replays"); gate.resolve(); await running;
  expect(coordinator.status("replays").state).toBe("stopped");
  expect(store.getReplay(existing)?.locations[0].available).toBe(true);
  expect(store.getReplay(existing)?.isNew).toBe(false);
});

it("coalesces source-change requests into one follow-up and never retries a failed scan in a loop", async () => {
  const gate = deferred(); const entered = deferred(); let starts = 0;
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* () {
    starts++; if (starts === 1) { entered.resolve(); await gate.promise; } yield observation("a");
  } });
  const running = coordinator.scan("replays"); await entered.promise;
  coordinator.markDirty("replays"); coordinator.markDirty("replays"); gate.resolve(); await running; await coordinator.idle();
  expect(starts).toBe(2);
  const broken = new LibraryScanCoordinator(store, { replays: async function* () { yield observation("a"); throw new Error("source-changed"); } });
  const failed = broken.scan("replays"); broken.markDirty("replays"); await failed; await broken.idle();
  expect(broken.status("replays")).toMatchObject({ state: "error", error: "source-changed" });
});

it("serializes source scans and acknowledges idle viewer demand before admitting any source", async () => {
  store.registerSource({ id: "stable", kind: "stable", directory: "C:\\osu" });
  const order: string[] = [];
  const coordinator = new LibraryScanCoordinator(store, {
    replays: async function* () { order.push("replays"); yield observation("a"); },
    stable: async function* () { order.push("stable"); yield observation("b"); },
  });
  await coordinator.setViewerDemand(true);
  const first = coordinator.scan("replays"); const second = coordinator.scan("stable");
  expect(order).toEqual([]);
  coordinator.setViewerDemand(false); await first; await second;
  expect(order).toEqual(["replays", "stable"]);
});

it("offers the last indexed observation to adapters without reconstructing or rehashing it", async () => {
  let cached: FileSourceObservation | undefined;
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* (options) {
    cached = await options.cached?.("a");
    yield cached ?? observation("a");
  } });
  await coordinator.scan("replays"); await coordinator.scan("replays");
  expect(cached).toEqual({ ...observation("a"), expectedRevision: 0 });
  expect(store.listReplayIds()).toHaveLength(1);
});

it("keeps the queue live after an untyped adapter failure", async () => {
  let attempts = 0;
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* () {
    if (++attempts === 1) throw undefined;
    yield observation("a");
  } });
  await coordinator.scan("replays");
  expect(coordinator.status("replays")).toMatchObject({ state: "error", error: "Source scan failed" });
  await coordinator.scan("replays");
  expect(coordinator.status("replays").state).toBe("complete");
});

it("retains reliable native missing evidence and clears it when a later scan recovers", async () => {
  let attempts = 0;
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* () {
    if (++attempts === 1) throw new LibrarySourceScanError("source-missing");
    yield observation("a");
  } });
  await coordinator.scan("replays");
  expect(coordinator.status("replays")).toMatchObject({ state: "error", failureReason: "source-missing" });
  await coordinator.scan("replays");
  expect(coordinator.status("replays")).toMatchObject({ state: "complete", failureReason: undefined });
});

it("does not turn untyped native-looking text into reliable missing or busy evidence", async () => {
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* () {
    yield* [];
    throw new Error("Native source scan: source-missing");
  } });
  await coordinator.scan("replays");
  expect(coordinator.status("replays")).toMatchObject({ state: "error", error: "Native source scan: source-missing" });
  expect(coordinator.status("replays")).not.toHaveProperty("failureReason", "source-missing");
});

it("retains a native sharing lock without claiming a running process or changing replay availability", async () => {
  const generation = store.beginScan("replays");
  const existing = store.upsertObservation({ ...observation("b"), sourceId: "replays", generation, addedAt: 1 });
  store.finishScan("replays", generation);
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* () {
    yield* [];
    throw new LibrarySourceScanError("source-busy");
  } });
  await coordinator.scan("replays");
  expect(coordinator.status("replays")).toMatchObject({ state: "error", failureReason: "source-busy" });
  expect(store.getReplay(existing)?.locations[0].available).toBe(true);
});

it("reports cleanup failure generically instead of attributing it to an earlier native missing result", async () => {
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* () {
    yield* [];
    throw new LibrarySourceScanError("source-missing");
  } });
  const stop = jest.spyOn(store, "stopScan").mockImplementation(() => { throw new Error("database unavailable"); });
  await coordinator.scan("replays");
  expect(coordinator.status("replays")).toMatchObject({ state: "error", error: "Source cleanup failed: database unavailable" });
  expect(coordinator.status("replays")).not.toHaveProperty("failureReason", "source-missing");
  stop.mockRestore();
});

it("isolates a failed status observer and refuses scans after close", async () => {
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* () { yield observation("a"); } },
    () => { throw new Error("UI listener disconnected"); });
  await coordinator.scan("replays");
  expect(store.listReplayIds()).toHaveLength(1);
  await coordinator.close();
  await expect(coordinator.scan("replays")).rejects.toThrow(/closed/i);
  coordinator.markDirty("replays");
  expect(coordinator.status("replays").state).toBe("complete");
});

it("honours Stop and deduplication from the initial queued notification", async () => {
  let starts = 0;
  let reentrant: Promise<void> | undefined;
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* () { starts++; yield observation("a"); } },
    status => { if (status.state === "queued") { reentrant = coordinator.scan("replays"); coordinator.stop("replays"); } });
  const scan = coordinator.scan("replays");
  expect(reentrant).toBe(scan);
  await scan;
  expect(starts).toBe(0);
  expect(coordinator.status("replays").state).toBe("stopped");
});

it("aborts and drains every task before reporting a database cleanup failure during close", async () => {
  store.registerSource({ id: "stable", kind: "stable", directory: "C:\\osu" });
  const entered = deferred(); const gate = deferred(); let queuedStarts = 0;
  const coordinator = new LibraryScanCoordinator(store, {
    replays: async function* () { yield observation("a"); entered.resolve(); await gate.promise; },
    stable: async function* () { queuedStarts++; yield observation("b"); },
  });
  const first = coordinator.scan("replays"); await entered.promise; const second = coordinator.scan("stable");
  jest.spyOn(store, "stopScan").mockImplementation(() => { throw new Error("database unavailable"); });
  const closing = coordinator.close(); gate.resolve();
  await expect(closing).rejects.toThrow(/database unavailable/);
  await first; await second;
  expect(queuedStarts).toBe(0);
  expect(coordinator.status("replays")).toMatchObject({ state: "error", error: expect.stringContaining("database unavailable") });
});

function pendingNativeScan() {
  const entered = deferred(), native = deferred();
  let starts = 0;
  const coordinator = new LibraryScanCoordinator(store, { replays: async function* (options) {
    starts++;
    const { signal, waitForNative } = options;
    if (!signal || !waitForNative) throw new Error("Expected native scan controls");
    const pending = new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void native.promise.then(() => { signal.removeEventListener("abort", abort); resolve(); });
    });
    const waiting = waitForNative(pending); entered.resolve(); await waiting;
    yield observation("a");
  } });
  const running = coordinator.scan("replays");
  return { coordinator, entered: entered.promise, native, running, starts: () => starts,
    cleanup: async () => { native.resolve(); await coordinator.setViewerDemand(false); await running; await coordinator.close(); } };
}

it("shows late native-wait demand and resumes before reply without restarting its generation", async () => {
  const f = pendingNativeScan();
  try {
    await f.entered;
    let held = false; const hold = f.coordinator.setViewerDemand(true).then(() => { held = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(held).toBe(true); await hold;
    expect(f.coordinator.status("replays").state).toBe("waiting-for-viewer");
    await f.coordinator.setViewerDemand(false);
    expect(f.coordinator.status("replays").state).toBe("scanning");
    expect(f.starts()).toBe(1); expect(store.listReplayIds()).toHaveLength(0);
    f.native.resolve(); await f.running;
    expect(f.starts()).toBe(1); expect(store.listReplayIds()).toHaveLength(1);
    expect(f.coordinator.status("replays").state).toBe("complete");
  } finally { await f.cleanup(); }
});

it.each(["stop", "close"] as const)("does not revive a native wait after %s and demand release", async action => {
  const f = pendingNativeScan();
  try {
    await f.entered; await f.coordinator.setViewerDemand(true);
    expect(f.coordinator.status("replays").state).toBe("waiting-for-viewer");
    const closing = action === "close" ? f.coordinator.close() : (f.coordinator.stop("replays"), Promise.resolve());
    const released = f.coordinator.setViewerDemand(false);
    expect(f.coordinator.status("replays").state).toBe("waiting-for-viewer");
    await released; await closing; await f.running;
    expect(f.coordinator.status("replays").state).toBe("stopped");
    await f.coordinator.setViewerDemand(true); await f.coordinator.setViewerDemand(false);
    expect(f.coordinator.status("replays").state).toBe("stopped");
    expect(f.starts()).toBe(1); expect(store.listReplayIds()).toHaveLength(0);
  } finally { await f.cleanup(); }
});
