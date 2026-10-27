import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";
import type { LibrarySavedScore } from "@rewind/osu-local/db-reader/library-scores";
import type { LazerSourceScore } from "./sources/lazer-source";
import { LibraryStore } from "./library-store";
import { LibraryConfirmedOrigin, projectSourceEvidence } from "./library-source-binding";

const sha = "a".repeat(64), schema = "b".repeat(64), recordHash = "c".repeat(64);
const header: ReplayHeader = { mode: 0, version: 20260101, beatmapMD5: "d".repeat(32), player: "P", replayMD5: "id",
  counts: { great: 9, ok: 1, meh: 0, miss: 0, geki: 0, katu: 0 }, maxCombo: 10, score: 100,
  perfectComboFlag: true, modsBitmask: 0, playedAtTicks: "1", sourceFormat: "stable", nativeScoreInfo: false,
  compressedFrames: { offset: 0, length: 1 } };
const savedScore: LibrarySavedScore = { sourceKey: recordHash, databaseVersion: 20260101, header, onlineId: "0", targetPractice: null };
const nativeScore: LazerSourceScore = { id: "native", ruleset: 0, playedAtTicks: "1", player: "P", clientVersion: "2026.730.0",
  isLegacyScore: false, accuracy: 0.95, maxCombo: 12, rank: 3, pp: 100, mods: [], statistics: { miss: 0 }, maximumStatistics: null,
  replay: { status: "unverified", sha256: sha }, beatmap: { status: "missing" }, assets: [] };
let folder: string, database: string, store: LibraryStore;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hindsight-h-binding-")); database = join(folder, "library.sqlite");
  store = new LibraryStore(database, "one");
  for (const kind of ["stable", "replays", "lazer", "imported"] as const) store.registerSource({ id: kind, kind, directory: "C:\\fixture\\" + kind });
});
afterEach(() => {
  store.close(); for (const suffix of ["", "-wal", "-shm"]) if (existsSync(database + suffix)) unlinkSync(database + suffix);
  rmdirSync(folder);
});
function observation(sourceId: string, sourceKey: string, metadata: Record<string, unknown>, sha256: string | null = sha) {
  return { sourceId, sourceKey, locator: "C:\\fixture\\" + sourceKey, sha256, available: sha256 !== null, metadata, addedAt: 1 };
}
function add(sourceId: string, sourceKey: string, metadata: Record<string, unknown>, sha256: string | null = sha) {
  const generation = store.beginScan(sourceId);
  const id = store.upsertObservation({ ...observation(sourceId, sourceKey, metadata, sha256), generation });
  store.finishScan(sourceId, generation); return id;
}
function metric(id: string) { return store.metrics.read(id).find(entry => entry.target.slot === "source-score"); }
function fault() {
  const db = new DatabaseSync(database);
  db.exec("CREATE TRIGGER fail_h BEFORE INSERT ON metric_results BEGIN SELECT RAISE(ABORT,'fixture metric failure'); END;");
  db.close();
}
function clearFault() { const db = new DatabaseSync(database); db.exec("DROP TRIGGER fail_h"); db.close(); }

it.each(["replays", "imported"])("binds %s headers without scheduling analysis and preserves generation on rescan", source => {
  const id = add(source, "file", { header }); const initial = metric(id);
  expect(initial).toMatchObject({ job: undefined, result: { fields: { accuracy: { state: "known" }, misses: { state: "known", value: 0 },
    completion: { state: "unknown" } }, provenance: { replaySha256: sha, sourceOnly: false } } });
  add(source, "file", { header, fileState: "readable", stamp: { changed: 1 } }); expect(metric(id)?.target).toEqual(initial?.target);
});

it("qualifies source-only Stable and native records separately from later exact bytes", () => {
  const stable = add("stable", recordHash, { savedScore }, null), native = add("lazer", "native", { nativeScore, schemaFingerprint: schema }, null);
  for (const id of [stable, native]) {
    expect(metric(id)?.result?.provenance.sourceOnly).toBe(true);
    expect(metric(id)?.result?.provenance).not.toHaveProperty("replaySha256");
  }
  const prior = metric(stable)?.target;
  add("stable", recordHash, { savedScore, header });
  expect(metric(stable)?.result?.provenance).toMatchObject({ sourceOnly: false, replaySha256: sha, sourceEvidenceHash: recordHash });
  expect(metric(stable)?.target.inputKey).not.toBe(prior?.inputKey);
});

it("merges native provenance and user metadata, without duplicate import downgrading H", () => {
  const provisional = add("lazer", "native", { nativeScore, schemaFingerprint: schema }, null);
  const canonical = add("imported", "file", { header }); store.setReview(provisional, "reviewed");
  add("lazer", "native", { nativeScore, schemaFingerprint: schema, header });
  expect(store.resolveId(provisional)).toBe(canonical); expect(store.getReplay(canonical)?.review).toBe("reviewed");
  const prior = metric(canonical); add("imported", "another", { header });
  expect(metric(canonical)).toEqual(prior);
  expect(prior?.result).toMatchObject({ fields: { accuracy: { state: "known", value: 0.95 } }, provenance: { sourceOnly: false, replaySha256: sha } });
});

it("retains verified metrics after failure, source disable and restart", () => {
  const id = add("replays", "file", { header }); const prior = metric(id);
  add("replays", "file", { fileState: "error", reason: "changed", header: { ...header, maxCombo: 999 } }, null);
  store.setSourceEnabled("replays", false); store.close(); store = new LibraryStore(database, "two");
  expect(metric(id)).toEqual(prior); expect(store.getReplay(id)?.locations[0].available).toBe(false);
});

it("skips malformed preferred metadata and refuses declared-only native digest promotion", () => {
  const id = add("replays", "file", { header });
  add("lazer", "broken", { header: { beatmapMD5: header.beatmapMD5 }, nativeScore: {}, schemaFingerprint: schema });
  expect(metric(id)?.result?.fields.maxCombo).toEqual({ state: "known", value: 10 });
  const unknown = add("lazer", "wrong", { nativeScore, schemaFingerprint: schema }, "e".repeat(64));
  expect(metric(unknown)).toBeUndefined();
});

it("retains qualified native origin when oversized consumed metadata cannot supply a score projection", () => {
  const oversized = { ...nativeScore, mods: [{ acronym: "custom", settings: { values: Array(9000).fill(1) } }] };
  const projection = projectSourceEvidence({ kind: "lazer", sourceKey: "native", sha256: sha,
    metadata: { nativeScore: oversized, schemaFingerprint: schema, header } });
  expect(projection?.fields.accuracy.state).toBe("unknown");
  expect(projection?.fields.maxCombo).toEqual({ state: "known", value: 10 });
  expect(projection?.provenance.scoreOrigin).toBe("lazer");
  const id = add("lazer", "native", { nativeScore: oversized, schemaFingerprint: schema });
  add("imported", "file", { header });
  expect(metric(id)?.result?.fields.accuracy.state).toBe("unknown");
});

it("backfills persisted rows in bounded pages and reprojects origin add/change/removal without file scanning", () => {
  const id = add("imported", "file", { header });
  const other = add("replays", "other", { header }, "e".repeat(64));
  store.close(); const db = new DatabaseSync(database); db.exec("DELETE FROM metric_targets; DELETE FROM metric_results"); db.close();
  let origin: LibraryConfirmedOrigin | undefined = { client: "lazer", provenance: "user-confirmed" };
  store = new LibraryStore(database, "two", value => value === sha ? origin : undefined);
  const first = store.reprojectSourceMetrics(undefined, 1);
  expect(first.processed).toBe(1); expect(first.next).toBeDefined();
  const second = store.reprojectSourceMetrics(first.next, 1); expect(second).toEqual({ processed: 1 });
  expect(metric(id)?.result?.fields.accuracy.state).toBe("unknown"); expect(metric(other)?.result?.fields.accuracy.state).toBe("known");
  const nativeKey = metric(id)?.target.inputKey;
  origin = { client: "stable", provenance: "user-confirmed" }; store.reprojectSourceMetrics();
  expect(metric(id)?.result?.fields.accuracy.state).toBe("known"); expect(metric(id)?.target.inputKey).not.toBe(nativeKey);
  origin = undefined; store.reprojectSourceMetrics();
  expect(metric(id)?.result?.provenance.profileId).toBe("legacy-wrapper-v1");
  expect(store.getReplay(id)?.locations).toHaveLength(1); expect(metric(id)?.job).toBeUndefined();
  expect(() => store.reprojectSourceMetrics(undefined, 10000)).toThrow(/limit/i);
});

it("does not borrow native origin from a score rejected for identity mismatch", () => {
  const projection = projectSourceEvidence({ kind: "lazer", sourceKey: "different", sha256: sha,
    metadata: { nativeScore, schemaFingerprint: schema, header } });
  expect(projection?.fields.accuracy.state).toBe("known");
  expect(projection?.provenance.scoreOrigin).toBe("stable");
});

it("publishes selected refresh atomically and rejects stale refreshes without changing H", () => {
  const id = add("lazer", "native", { nativeScore, schemaFingerprint: schema });
  const ticket = store.openLocationCandidates(id).items[0];
  const update = { sha256: sha, available: true, metadata: { nativeScore: { ...nativeScore, accuracy: 0.8 }, schemaFingerprint: schema } };
  expect(store.commitLocationRefresh(ticket, update).state).toBe("applied");
  const current = metric(id); expect(current?.result?.fields.accuracy).toEqual({ state: "known", value: 0.8 });
  expect(store.commitLocationRefresh(ticket, { ...update, metadata: { nativeScore, schemaFingerprint: schema } }).state).toBe("stale");
  expect(metric(id)).toEqual(current);
});

it("rolls observation and import journal completion back on metric persistence failure", () => {
  fault(); const generation = store.beginScan("replays");
  expect(() => store.upsertObservation({ ...observation("replays", "file", { header }), generation })).toThrow("fixture metric failure");
  expect(store.replayCount()).toBe(0); expect(store.sourceObservation("replays", "file")).toBeUndefined();
  const intent = store.prepareImport("imported", sha, { header }, 1);
  expect(() => store.completeImport(intent.id, "C:\\owned.osr")).toThrow("fixture metric failure");
  expect(store.pendingImports()).toHaveLength(1); expect(store.replayCount()).toBe(0);
  clearFault(); expect(metric(store.completeImport(intent.id, "C:\\owned.osr"))?.result).toBeDefined();
});

it("rolls back alias merge and staged rebuild when metric publication fails", () => {
  const provisional = add("lazer", "native", { nativeScore, schemaFingerprint: schema }, null);
  const canonical = add("imported", "file", { header }); store.setReview(provisional, "reviewed");
  fault(); const generation = store.beginScan("lazer");
  expect(() => store.upsertObservation({ ...observation("lazer", "native", { nativeScore, schemaFingerprint: schema }), generation })).toThrow("fixture metric failure");
  expect(store.resolveId(provisional)).toBe(provisional); expect(store.getReplay(canonical)?.review).toBe("not-reviewed");
  store.finishScan("lazer", generation); clearFault();
  const run = store.beginRebuild(["imported"]); store.stageRebuildObservation(run, observation("imported", "fresh", { header }, "f".repeat(64)));
  store.finishRebuildSource(run, "imported"); fault(); expect(() => store.commitRebuild(run)).toThrow("fixture metric failure");
  expect(store.replayCount()).toBe(2); clearFault(); expect(store.commitRebuild(run).observations).toBe(1);
});
