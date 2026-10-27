import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
import type { LibraryAnalysisReason, LibraryMetricJob, LibraryMetricTarget, LibraryMetricTicket } from "../../../../shared/replay-library-metrics";

let folder: string, database: string, store: LibraryStore, counter: number;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hindsight-metric-queue-")); database = join(folder, "library.sqlite");
  store = new LibraryStore(database, "one"); counter = 0;
  store.registerSource({ id: "source", kind: "replays", directory: "C:\\fixture" });
});
afterEach(() => {
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(database + suffix)) unlinkSync(database + suffix);
  rmdirSync(folder);
});
function target(stage: "P" | "S" | "C" = "S", addedAt = 1): LibraryMetricTarget {
  const key = String(++counter), replayId = store.upsertObservation({ sourceId: "source", sourceKey: key, locator: key,
    sha256: counter.toString(16).padStart(64, "0"), available: true, generation: store.beginScan("source"), addedAt, metadata: {} });
  return store.metrics.setTarget({ replayId, stage, slot: stage === "S" ? "numerical" : stage === "C" ? "incidents" : "aggregate-pp",
    inputKey: "A", producerVersion: "test" });
}
function queue(head = target(), reason: LibraryAnalysisReason = "background"): LibraryMetricJob & {reason:LibraryAnalysisReason} {
  const value = store.metrics.request(head, reason); if (!("id" in value)) throw new Error("Expected queued job"); return {...value,reason};
}
function claim(job: LibraryMetricJob): LibraryMetricTicket {
  const ticket = store.metrics.claim(job.id); if (!ticket) throw new Error("Expected ticket"); return ticket;
}
function settings(patch: Partial<ReturnType<typeof store.metrics.analysisSettings>>) {
  store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), ...patch });
}

it("persists prototype defaults and user Pause independently from recovered attempts", () => {
  expect(store.metrics.analysisSettings()).toEqual({ mode: "bg", userPaused: false, workers: 2, pauseOnBattery: true });
  const job = queue(), old = claim(job);
  settings({ userPaused: true, workers: 4, pauseOnBattery: false });
  expect(store.metrics.read(job.target.replayId)[0].job?.state).toBe("running");
  store.close(); store = new LibraryStore(database, "two");
  expect(store.metrics.analysisSettings()).toEqual({ mode: "bg", userPaused: true, workers: 4, pauseOnBattery: false });
  expect(store.metrics.read(job.target.replayId)[0].job?.state).toBe("queued");
  expect(store.metrics.nextQueued()).toEqual([]); expect(store.metrics.claim(job.id)).toBeUndefined();
  expect(store.metrics.release(old)).toBe("stale");
  settings({ userPaused: false }); expect(store.metrics.nextQueued()).toEqual([job]);
  expect(claim(job).attempt).not.toBe(old.attempt);
});

it("Off atomically removes unfinished S and historical C but retains failures, results and P", () => {
  const running = queue(), old = claim(running), queued = queue();
  // Old indexes may contain C jobs even though production admission is now disabled.
  const historical = (["queued", "running", "failed"] as const).map(state => {
    const head = target("C"), id = `historical-c-${state}`;
    store["db"].prepare("INSERT INTO metric_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, head.replayId, head.slot, head.stage, head.inputKey, head.producerVersion, head.generation, "background", state,
        state === "running" ? "historical-attempt" : null, state === "failed" ? "historical C failure" : null);
    expect(store.metrics.request(head, "selection")).toEqual({ state: "disabled" });
    return { id, target: head, state };
  });
  const failed = queue(), failureTicket = claim(failed); store.metrics.fail(failureTicket, "missing-map");
  const complete = queue(), completed = claim(complete);
  store.metrics.commit({ ticket: completed, producerVersion: "test", fields: { misses: { state: "known", value: 0 } }, provenance: {} });
  const p = queue(target("P"));
  settings({ mode: "off" });
  for (const item of [running, queued]) expect(store.metrics.read(item.target.replayId)[0].job).toBeUndefined();
  for (const item of historical) {
    const entry = store.metrics.read(item.target.replayId)[0];
    if (item.state === "failed") expect(entry.job).toMatchObject({ state: "failed", error: "historical C failure" });
    else expect(entry.job).toBeUndefined();
    expect(store.metrics.claim(item.id)).toBeUndefined(); expect(store.metrics.request(item.target, "retry")).toEqual({ state: "disabled" });
  }
  expect(store.metrics.release(old)).toBe("stale");
  expect(store.metrics.fail(old, "late")).toBe("stale");
  expect(store.metrics.request(running.target, "open")).toEqual({ state: "disabled" });
  expect(store.metrics.request(failed.target, "retry")).toEqual({ state: "disabled" });
  expect(store.metrics.read(failed.target.replayId)[0].job).toMatchObject({ state: "failed", error: "missing-map" });
  expect(store.metrics.request(complete.target, "open")).toEqual({ state: "cached" });
  expect(store.metrics.nextQueued()).toEqual([p]); expect(claim(p).stage).toBe("P");
  store.close(); store = new LibraryStore(database, "two");
  expect(store.metrics.analysisSettings().mode).toBe("off");
  expect(store.metrics.read(running.target.replayId)[0].job).toBeUndefined();
  expect(store.metrics.read(complete.target.replayId)[0].result?.fields.misses).toEqual({ state: "known", value: 0 });
  for (const item of historical) expect(store.metrics.read(item.target.replayId)[0].job).toBeUndefined();
});

it("rolls back settings and cancellation together on storage failure", () => {
  const job = queue(), ticket = claim(job), fault = new DatabaseSync(database);
  try {
    fault.exec("CREATE TRIGGER fail_off BEFORE DELETE ON metric_jobs BEGIN SELECT RAISE(ABORT, 'injected Off fault'); END;");
    expect(() => settings({ mode: "off" })).toThrow("injected Off fault");
    expect(store.metrics.analysisSettings().mode).toBe("bg");
    expect(store.metrics.read(job.target.replayId)[0].job?.state).toBe("running");
    fault.exec("DROP TRIGGER fail_off");
    expect(store.metrics.release(ticket)).toBe("applied");
  } finally { fault.close(); }
});

it("On demand suspends background admission, promotes explicit requests and preserves active work", () => {
  const active = queue(), ticket = claim(active), pending = queue(), p = queue(target("P"));
  settings({ mode: "demand" });
  expect(store.metrics.nextQueued()).toEqual([p]); expect(store.metrics.claim(pending.id)).toBeUndefined();
  expect(store.metrics.request(target(), "background")).toEqual({ state: "disabled" });
  expect(store.metrics.read(active.target.replayId)[0].job?.state).toBe("running");
  expect(store.metrics.request(pending.target, "selection")).toMatchObject({ id: pending.id, reason: "selection" });
  expect(store.metrics.nextQueued()[0].id).toBe(pending.id); expect(claim(pending)).toBeDefined();
  expect(store.metrics.commit({ ticket, producerVersion: "test", fields: { misses: { state: "known", value: 1 } }, provenance: {} })).toBe("applied");
});

it("selects a bounded priority/newest queue without admitting work or disturbing running/failed jobs", () => {
  const old = queue(target("S", 2)), newer = queue(target("S", 3)), retry = queue(target("S", 1), "retry");
  const selected = queue(target("S", 1), "selection"), open = queue(target("S", 1), "open");
  const running = queue(); claim(running);
  const failed = queue(); store.metrics.fail(claim(failed), "failure");
  expect(store.metrics.nextQueued(3).map(j => j.id)).toEqual([open.id, selected.id, retry.id]);
  expect(store.metrics.nextQueued().map(j => j.id)).toEqual([open.id, selected.id, retry.id, newer.id, old.id]);
  for (const n of [0, -1, 1.5, 257]) expect(() => store.metrics.nextQueued(n)).toThrow(/limit/i);
  settings({ userPaused: true }); expect(store.metrics.nextQueued()).toEqual([]);
  const p = queue(target("P")); expect(store.metrics.claim(p.id)).toBeUndefined();
  settings({ userPaused: false }); expect(store.metrics.nextQueued().length).toBe(6);
});

it("releases only the exact live attempt and rejects late completion after re-claim", () => {
  const job = queue(), old = claim(job);
  expect(store.metrics.release({ ...old, attempt: "wrong" })).toBe("stale");
  expect(store.metrics.release(old)).toBe("applied"); expect(store.metrics.release(old)).toBe("stale");
  const newer = claim(job); expect(newer.attempt).not.toBe(old.attempt);
  expect(store.metrics.fail(old, "late")).toBe("stale");
  expect(store.metrics.read(job.target.replayId)[0].job?.state).toBe("running");
});

it("persists concrete bounded worker errors instead of stranding a running job", () => {
  const job = queue(), ticket = claim(job);
  const message = "Library analysis worker failed: invalid native score\n" + "detail ".repeat(400);
  expect(store.metrics.fail(ticket, message)).toBe("applied");
  expect(store.metrics.read(job.target.replayId)[0].job).toMatchObject({ state: "failed", error: message.slice(0, 2048) });
  expect(store.metrics.request(job.target, "selection")).toMatchObject({ state: "failed" });
});

it("holds disabled-source jobs without losing them, while retaining explicit missing-location retry", () => {
  const job = queue(); store.setSourceEnabled("source", false);
  expect(store.metrics.nextQueued()).toEqual([]); expect(store.metrics.claim(job.id)).toBeUndefined();
  expect(store.metrics.read(job.target.replayId)[0].job?.id).toBe(job.id);
  store.setSourceEnabled("source", true);
  expect(store.metrics.nextQueued()).toEqual([job]);
  store.metrics.fail(claim(job), "Replay file is missing");
  const retry = queue(job.target, "retry"); expect(claim(retry)).toBeDefined();
});

it("can skip a busy native lane without starving numerical jobs behind a large native queue", () => {
  for (let i = 0; i < 40; i++) queue(target("P"), "open");
  const numerical = queue();
  expect(store.metrics.nextQueued(1, false)).toEqual([numerical]);
  expect(store.metrics.nextQueued(1, true)[0].target.stage).toBe("P");
});

it("rejects invalid settings without silently enabling work", () => {
  for (const patch of [{ workers: 3 }, { mode: "sort" }, { mode: ["off"] }, { mode: ["demand"] }, { userPaused: 1 }, { pauseOnBattery: null }, { extra: true }]) {
    expect(() => store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), ...patch } as never)).toThrow(/settings/i);
  }
  expect(store.metrics.analysisSettings().mode).toBe("bg");
  const raw = new DatabaseSync(database);
  try { raw.prepare("INSERT INTO settings VALUES('analysis',?)").run('{"mode":"bad"}'); } finally { raw.close(); }
  expect(() => store.metrics.analysisSettings()).toThrow(/settings/i);
});
