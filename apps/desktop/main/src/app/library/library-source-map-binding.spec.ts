import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";
import { LibraryStore } from "./library-store";

const sha = "a".repeat(64), md5 = "b".repeat(32), other = "c".repeat(32), schema = "d".repeat(64);
const header: ReplayHeader = { mode: 0, version: 20260101, beatmapMD5: md5, player: "P", replayMD5: "id",
  counts: { great: 10, ok: 0, meh: 0, miss: 0, geki: 0, katu: 0 }, maxCombo: 10, score: 100,
  perfectComboFlag: true, modsBitmask: 0, playedAtTicks: "1", sourceFormat: "stable", nativeScoreInfo: false,
  compressedFrames: { offset: 0, length: 1 } };
const stableMap = { map: { md5, databaseVersion: 20260101, rankedStatus: 4, drainTimeSeconds: 120, mode: 0 },
  cachedNoModStars: 5, cachedTempo: { min: 180, max: 180 } };
const nativeMap = { title: "T", titleUnicode: null, artist: "A", artistUnicode: null, mapper: "M", difficultyName: "D",
  onlineId: 1, status: 1, cachedLengthMs: 130000, cachedBpm: 200, cachedNoModStars: 6 };
const native = { id: "native", ruleset: 0, replay: { status: "missing", sha256: sha }, beatmap: { status: "missing", md5 },
  mapMetadata: nativeMap }; // Map metadata does not depend on a usable score/mod envelope.
let directory: string, file: string, store: LibraryStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hindsight-map-binding-")); file = join(directory, "library.sqlite");
  store = new LibraryStore(file, "one");
  for (const kind of ["stable", "replays", "lazer", "imported"] as const) store.registerSource({ id: kind, kind, directory: "C:\\fixture\\" + kind });
});
afterEach(() => {
  store.close(); for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) unlinkSync(file + suffix);
  rmdirSync(directory);
});
function add(sourceId = "replays", metadata: Record<string, unknown> = { header }, digest: string | null = sha, sourceKey = "file") {
  const generation = store.beginScan(sourceId);
  const id = store.upsertObservation({ sourceId, sourceKey, generation, locator: "C:\\fixture\\" + sourceKey,
    metadata, sha256: digest, available: digest !== null, addedAt: 1 });
  store.finishScan(sourceId, generation); return id;
}
function stage(metadata: Record<string, unknown> = stableMap) {
  const generation = store.beginMapScan("stable");
  store.upsertMap({ sourceId: "stable", sourceKey: "map", generation, md5, locator: null, state: "invalid-path", metadata });
  return generation;
}
function metric(id: string) { return store.metrics.read(id).find(entry => entry.target.slot === "source-map"); }

it("publishes cached maps only after a committed scan and backfills existing replays without jobs", () => {
  const id = add(), generation = stage(); store.reprojectSourceMetrics(); expect(metric(id)).toBeUndefined();
  store.finishMapScan("stable", generation); store.reprojectSourceMetrics();
  expect(metric(id)).toMatchObject({ job: undefined, result: { fields: { sourceMapStars: { state: "known", value: 5 },
    cachedBpm: { state: "known", value: 180 }, drainLengthMs: { state: "known", value: 120000 } }, provenance: { mapMd5: md5, sourceOnly: true } } });
  const old = metric(id); const failed = stage({ ...stableMap, cachedNoModStars: 9 }); store.stopMapScan("stable", failed);
  store.reprojectSourceMetrics(); expect(metric(id)).toEqual(old);
});

it("binds map metadata from a verified bounded header without requiring score counters", () => {
  store.finishMapScan("stable", stage());
  const id = add("replays", { header: { beatmapMD5: md5 }, validation: "header-only", metadataState: "resource-limit" });
  expect(metric(id)?.result?.fields.cachedBpm).toEqual({ state: "known", value: 180 });
});

it("does not discard cached stars and tempo when a signed source drain duration is unavailable", () => {
  store.finishMapScan("stable", stage({ ...stableMap, map: { ...stableMap.map, drainTimeSeconds: -1 } }));
  expect(metric(add())?.result?.fields).toMatchObject({ sourceMapStars: { state: "known", value: 5 },
    cachedBpm: { state: "known", value: 180 }, mapStatus: { state: "known", value: "ranked" }, drainLengthMs: { state: "unknown" } });
});

it("retains published cached map evidence across disabled sources, disappeared map records and restart", () => {
  store.finishMapScan("stable", stage()); const id = add(), old = metric(id);
  expect(old).toBeDefined(); store.setSourceEnabled("stable", false); store.reprojectSourceMetrics(); expect(metric(id)).toEqual(old);
  store.setSourceEnabled("stable", true); store.finishMapScan("stable", store.beginMapScan("stable"));
  store.reprojectSourceMetrics(); expect(metric(id)).toEqual(old);
  store.close(); store = new LibraryStore(file, "two"); store.reprojectSourceMetrics(); expect(metric(id)).toEqual(old);
});

it("qualifies missing native blobs independently of score fields and never substitutes native length for drain", () => {
  const id = add("lazer", { nativeScore: native, schemaFingerprint: schema }, null, "native");
  expect(metric(id)).toMatchObject({ result: { fields: { sourceMapStars: { state: "known", value: 6 },
    cachedBpm: { state: "known", value: 200 }, drainLengthMs: { state: "unknown" } }, provenance: { mapMd5: md5, schemaHash: schema } } });
});

it("uses the verified header map over a conflicting native declaration and refuses malformed Stable bindings", () => {
  store.finishMapScan("stable", stage());
  const id = add("lazer", { header, nativeScore: { ...native, beatmap: { status: "missing", md5: other } }, schemaFingerprint: schema }, sha, "native");
  expect(metric(id)?.result?.fields.cachedBpm).toEqual({ state: "known", value: 180 });
  const invalid = stage({ ...stableMap, map: { ...stableMap.map, md5: other }, cachedNoModStars: 99 });
  store.finishMapScan("stable", invalid); store.reprojectSourceMetrics();
  expect(metric(id)?.result?.fields.sourceMapStars).toEqual({ state: "known", value: 5 });
});

it("does not promote native declared SHA or missing map MD5 using an unrelated header", () => {
  const wrongDigest = add("lazer", { nativeScore: native, schemaFingerprint: schema }, "e".repeat(64), "native");
  expect(metric(wrongDigest)).toBeUndefined();
  const noMap = add("lazer", { nativeScore: { ...native, id: "missing-map", beatmap: { status: "missing" } }, header, schemaFingerprint: schema }, sha, "missing-map");
  expect(metric(noMap)).toBeUndefined();
});

it("replaces known values with a new qualified unknown result and invalidates changed map identity", () => {
  const id = add("lazer", { nativeScore: native, schemaFingerprint: schema }, null, "native");
  add("lazer", { nativeScore: { ...native, mapMetadata: { ...nativeMap, cachedBpm: null } }, schemaFingerprint: schema }, null, "native");
  expect(metric(id)?.result?.fields.cachedBpm.state).toBe("unknown");
  add("lazer", { nativeScore: { ...native, beatmap: { status: "missing", md5: other }, mapMetadata: null }, schemaFingerprint: schema }, null, "native");
  expect(metric(id)).toBeUndefined();
});

it("publishes rebuilt map generations before the follow-up projection consumes them", () => {
  store.finishMapScan("stable", stage()); const id = add();
  const run = store.beginRebuild(["stable"]);
  store.stageRebuildMap(run, { sourceId: "stable", sourceKey: "map", md5, locator: null, state: "invalid-path", metadata: { ...stableMap, cachedNoModStars: 7 } });
  store.finishRebuildSource(run, "stable", "complete"); store.commitRebuild(run); store.reprojectSourceMetrics();
  expect(metric(id)?.result?.fields.sourceMapStars).toEqual({ state: "known", value: 7 });
});

it("preserves completed origin reconciliation while targeted map publication survives restart", () => {
  const id=add(),before = store.sourceMapRevision(), generation = stage();
  expect(store.sourceMapRevision()).toBe(before);
  expect(store.completeSourceMetricRevision("origin:old")).toBe(true);
  store.finishMapScan("stable", generation); const after = store.sourceMapRevision();
  expect(after).not.toBe(before); expect(store.sourceMetricRevision()).toBe("origin:old");
  store.close(); store = new LibraryStore(file, "two"); expect(store.sourceMapRevision()).toBe(after);
  while(store.queryProjectionPending())store.maintainQueryProjection();
  expect(metric(id)?.result?.fields.sourceMapStars).toEqual({state:"known",value:5});
  expect(store.sourceMetricRevision()).toBe("origin:old");
  expect(store.completeSourceMetricRevision("origin:new")).toBe(true);
});
