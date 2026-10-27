import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
import { numericalProfileKey, nativeModEvidence, numericalModsHash } from "./library-numerical-profile";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_RECONSTRUCTED_FC_VERSION, LIBRARY_REPLAY_PARSER_VERSION,
  LIBRARY_RESOURCE_PREPARATION_VERSION, LIBRARY_TIMELINE_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import type { LibraryNumericalResourceDescriptor, LibraryNumericalInputRecipe } from "../../../../shared/library-analysis";
import type { LibraryCurrentReplayResult } from "../../../../shared/library-current-replay";
import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { projectLibraryIncidentEvidence } from "./library-incidents-evidence";

let folder: string, database: string, store: LibraryStore, replay: string, origin: "stable" | "lazer" | undefined;
const sha = "a".repeat(64), mapSha = "b".repeat(64), md5 = "c".repeat(32), dt = (speed: number) => [{ acronym: "DT", settings: { speed_change: speed } }];
const lookup = () => origin ? { client: origin, provenance: "user-confirmed" as const } : undefined;
beforeEach(() => {
  origin = undefined; folder = mkdtempSync(join(tmpdir(), "hindsight-current-cas-")); database = join(folder, "library.sqlite");
  store = new LibraryStore(database, "one", lookup); store.registerSource({ id: "source", kind: "replays", directory: "C:\\fixture" });
  replay = observe(); store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), mode: "off" });
});
afterEach(() => { store.close(); for (const suffix of ["", "-wal", "-shm"]) if (existsSync(database + suffix)) unlinkSync(database + suffix); rmdirSync(folder); });
function observe(source = "source", key = "one", metadata: Record<string, unknown> = {}, hash = sha) {
  return store.upsertObservation({ sourceId: source, sourceKey: key, locator: key, sha256: hash, available: true,
    generation: store.beginScan(source), addedAt: 1, metadata });
}
function nativeMetadata(speed = 1.2) { return { nativeScore: { isLegacyScore: false, replay: { sha256: sha }, mods: dt(speed) } }; }
function descriptor(update: Partial<LibraryNumericalInputRecipe> = {}, mods?: unknown): LibraryNumericalResourceDescriptor {
  const recipe: LibraryNumericalInputRecipe = { version: 1, replaySha256: sha, fixedKey: "d".repeat(64), intrinsicNative: false,
    embeddedModsHash: null, legacyModsHash: "e".repeat(64), modeQualified: true, consumedModsSource: "legacy-mask", ...update };
  const profile = numericalProfileKey(recipe, { origin: origin ?? null, native: nativeModEvidence(mods === undefined ? [] : [mods]) });
  if (profile.state !== "known") throw new Error(profile.reason);
  return { input: { format: "resources", replayBytes: 100, mapBytes: 200, binding: { replaySha256: sha, mapSha256: mapSha,
    mapMd5: md5, exactMapAndProfile: profile.qualified } }, target: { slot: "numerical", stage: "S", inputKey: profile.inputKey,
    producerVersion: LIBRARY_NUMERIC_PROJECTION_VERSION }, recipe, origin: lookup() ?? null };
}
function bind(value = descriptor(), source = "source") {
  const location = store.openLocationCandidates(replay).items.find(item => item.sourceId === source)!;
  const result = store.bindCurrentReplay(location, { sha256: sha, available: true, metadata: location.metadata }, undefined, value);
  if (result.state !== "applied") throw new Error("Expected current replay binding: " + result.state);
  return result.authority;
}
function results(native = false): LibraryCurrentReplayResult[] {
  const proof = { replaySha256: sha, mapSha256: mapSha, mapMd5: md5, parserVersion: LIBRARY_REPLAY_PARSER_VERSION,
    preparationVersion: LIBRARY_RESOURCE_PREPARATION_VERSION, scoreOrigin: "reconstructed", ruleset: native ? "lazer" : "stable",
    rate: 1, coverageQualified: true, validationVersion: "library-current-replay-v1" };
  return [{ slot: "numerical", producerVersion: LIBRARY_NUMERIC_PROJECTION_VERSION, metrics: {
    provenance: { ...proof, projectionVersion: LIBRARY_NUMERIC_PROJECTION_VERSION, completionEvidence: "source-domain-coverage-v1",
      completeAccuracyEvidence: true, completeBreakEvidence: true }, fields: { completion: { state: "known", value: "passed" },
      misses: { state: "known", value: 0 }, fc: { state: "known", value: true } }, errorStrip: { state: "known", value: {
      version: 1, timeBasis: "map-ms", ...(native ? { ruleset: "lazer", componentMiss: [] } : { ruleset: "stable", sliderBreak: [] }), mapStartMs: 0, mapEndMs: 1000, evaluatedThrough: 1000,
      endpointBasis: "recorded-end", synthesizedEndpoint: false, ok: [], meh: [], miss: [], sliderEndMiss: [] } } } },
    { slot: "timeline-pp", producerVersion: LIBRARY_TIMELINE_PROJECTION_VERSION, metrics: { provenance: { ...proof,
      projectionVersion: LIBRARY_TIMELINE_PROJECTION_VERSION, engineVersion: PERFORMANCE_ENGINE_VERSION },
      fields: { pp: { state: "known", value: 0 }, peakPp: { state: "known", value: 0 } } } },
    { slot: "fc-pp", producerVersion: LIBRARY_RECONSTRUCTED_FC_VERSION, metrics: { provenance: { ...proof,
      projectionVersion: LIBRARY_RECONSTRUCTED_FC_VERSION, engineVersion: PERFORMANCE_ENGINE_VERSION }, fields: { ppIfFc: { state: "known", value: 0 } } } }];
}
function slot(name: string) { return store.metrics.read(replay).find(entry => entry.target.slot === name); }
function queueCount() { const db = new DatabaseSync(database); try { return Number(db.prepare("SELECT (SELECT count(*) FROM metric_jobs)+(SELECT count(*) FROM analysis_requests WHERE state IN ('queued','running')) AS n").get()?.n); } finally { db.close(); } }

it.each(["off", "bg"] as const)("binds and publishes without admission while %s, retaining zero values and user metadata", mode => {
  store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), mode }); store.enableNumericalAdmission(); store.enablePerformanceAdmission();
  store.setReview(replay, "reviewed"); store.setFavourite(replay, true);
  const authority = bind(); expect(queueCount()).toBe(0);
  expect(store.publishCurrentReplay(authority, results())).toEqual({ state: "applied", accepted: ["numerical", "timeline-pp", "fc-pp"] });
  expect(slot("numerical")?.result?.fields.misses).toEqual({ state: "known", value: 0 });
  expect(slot("timeline-pp")?.result?.fields.peakPp).toEqual({ state: "known", value: 0 });
  expect(slot("fc-pp")?.result?.fields.ppIfFc).toEqual({ state: "known", value: 0 }); expect(queueCount()).toBe(0);
  expect(store.getReplay(replay)).toMatchObject({ review: "reviewed", favourite: true });
});
it("accepts bounded maximum-length source identifiers without applying metric-input limits to the lease", () => {
  store.registerSource({ id: "long", kind: "replays", directory: "C:\\fixture" });
  observe("long", "z".repeat(32768));
  const authority = bind(descriptor(), "long");
  expect(store.publishCurrentReplay(authority, results())).toEqual({ state: "applied", accepted: ["numerical", "timeline-pp", "fc-pp"] });
});
it("retains scalar and strip availability when a compatible partial capture is missing fields", () => {
  const authority = bind(); store.publishCurrentReplay(authority, results());
  const partial = results()[0]; partial.metrics.fields = { misses: { state: "unknown", reason: "partial" }, ur: { state: "known", value: 0 } };
  partial.metrics.errorStrip = undefined; partial.metrics.provenance.coverageQualified = false;
  store.publishCurrentReplay(authority, [partial]);
  expect(slot("numerical")?.result?.fields).toMatchObject({ misses: { state: "known", value: 0 }, fc: { state: "known", value: true }, ur: { state: "known", value: 0 } });
  expect(slot("numerical")?.result?.provenance.coverageQualified).toBe(true); expect(store.metrics.readErrorStrip(replay)?.result?.state).toBe("known");
  expect(store.publishCurrentReplay(authority, [partial]).state).toBe("cached");
});
it("preserves a ready P FC target instead of retargeting it to reconstructed FC", () => {
  const target = store.metrics.setTarget({ replayId: replay, slot: "fc-pp", stage: "P", inputKey: "prepared-fc", producerVersion: "prepared-v1" });
  store.metrics.publishObserved(target, { fields: { ppIfFc: { state: "known", value: 42 } }, provenance: { replaySha256: sha } });
  const authority = bind(); const result = store.publishCurrentReplay(authority, results());
  expect(result.accepted).toEqual(["numerical", "timeline-pp"]); expect(slot("fc-pp")?.target).toEqual(target);
  expect(slot("fc-pp")?.result?.fields.ppIfFc).toEqual({ state: "known", value: 42 });
});
it("fences A-B-A profiles while Off and restores compatible history without admitting jobs", () => {
  store.registerSource({ id: "native", kind: "lazer", directory: "C:\\native" }); observe("native", "one", nativeMetadata());
  const value = descriptor({ consumedModsSource: "native-database" }, dt(1.2)), first = bind(value, "native");
  store.publishCurrentReplay(first, results(true)); observe("native", "one", nativeMetadata(1.5)); observe("native", "one", nativeMetadata());
  expect(slot("numerical")?.target.generation).toBeGreaterThan(first.numericalTarget.generation);
  expect(store.publishCurrentReplay(first, results(true))).toEqual({ state: "stale", accepted: [] });
  expect(slot("numerical")?.result?.fields.fc).toEqual({ state: "known", value: true }); expect(queueCount()).toBe(0);
});
it("declines a Stable imported duplicate with known native fallback evidence and rolls the refresh back", () => {
  store.registerSource({ id: "native", kind: "lazer", directory: "C:\\native" }); observe("native", "one", nativeMetadata());
  const location = store.openLocationCandidates(replay).items.find(item => item.sourceId === "source")!;
  expect(store.bindCurrentReplay(location, { sha256: sha, available: true, metadata: { replacement: true } }, undefined, descriptor())).toEqual({ state: "stale" });
  expect(store.sourceObservation("source", "one")?.metadata).toEqual({}); expect(store.acquireLocationTicket(replay, "source", "one")?.locationRevision).toBe(location.locationRevision);
  expect(slot("numerical")).toBeUndefined();
});
it("keeps authoritative embedded native mods independent of conflicting fallback hints", () => {
  store.registerSource({ id: "native", kind: "lazer", directory: "C:\\native" }); observe("native", "one", nativeMetadata()); observe("native", "two", nativeMetadata(1.5));
  const authority = bind(descriptor({ intrinsicNative: true, embeddedModsHash: numericalModsHash([])!, consumedModsSource: "embedded" }));
  expect(store.publishCurrentReplay(authority, results(true)).state).toBe("applied");
});
it("checks changed origin before binding and at publication, preserving source and user metadata", () => {
  const location = store.openLocationCandidates(replay).items[0], old = descriptor(); origin = "lazer";
  expect(store.bindCurrentReplay(location, { sha256: sha, available: true, metadata: { replacement: true } }, undefined, old)).toEqual({ state: "stale" });
  expect(store.sourceObservation("source", "one")?.metadata).toEqual({}); origin = undefined;
  const authority = bind(); origin = "lazer"; expect(store.publishCurrentReplay(authority, results()).state).toBe("stale");
});
it("allows an additional identical location but rejects changes to the bound source lease", () => {
  const authority = bind(); observe("source", "two"); expect(store.publishCurrentReplay(authority, [results()[0]]).state).toBe("applied");
  observe("source", "one", {}, "f".repeat(64)); expect(store.publishCurrentReplay(authority, results()).state).toBe("stale");
  expect(slot("numerical")?.result?.fields.fc).toEqual({ state: "known", value: true });
});
it("revokes capabilities explicitly and across restart while preserving published cache", () => {
  const authority = bind(); store.publishCurrentReplay(authority, results()); store.releaseCurrentReplay(authority);
  expect(store.publishCurrentReplay(authority, results()).state).toBe("stale"); const next = bind(); store.close(); store = new LibraryStore(database, "two", lookup);
  expect(store.publishCurrentReplay(next, results()).state).toBe("stale"); expect(slot("timeline-pp")?.result?.fields.pp).toEqual({ state: "known", value: 0 });
});
it("rejects altered authority and wrong resource provenance without changing cached rows", () => {
  const authority = bind(); expect(store.publishCurrentReplay({ ...authority, replayId: "other" }, results()).state).toBe("stale");
  const invalid = results(); invalid[1].metrics.provenance.mapSha256 = "f".repeat(64);
  expect(() => store.publishCurrentReplay(authority, invalid)).toThrow(); expect(slot("numerical")?.result).toBeUndefined();
});
it("rolls back all slots and strip together if a later result is invalid", () => {
  const authority = bind(), invalid = results(); invalid[2].metrics.fields.causes = { state: "known", value: 5 };
  expect(() => store.publishCurrentReplay(authority, invalid)).toThrow(); expect(slot("numerical")?.result).toBeUndefined();
  expect(store.metrics.readErrorStrip(replay)?.result).toBeUndefined();
});
it("does not publish dependent awarded PP or FC before qualified numerical completion", () => {
  const authority = bind(); expect(store.publishCurrentReplay(authority, results().slice(1))).toEqual({ state: "unavailable", accepted: [] });
  expect(slot("timeline-pp")?.result).toBeUndefined();
  const unqualified = results(); unqualified[0].metrics.fields.completion = { state: "unknown", reason: "source-domain-unavailable" };
  expect(() => store.publishCurrentReplay(authority, unqualified)).toThrow(/completion/);
  expect(slot("numerical")?.result).toBeUndefined();
});
it("rolls back publication on a database failure after numerical is written", () => {
  const authority = bind(), db = new DatabaseSync(database);
  try { db.exec("CREATE TRIGGER reject_current_timeline BEFORE INSERT ON metric_results WHEN NEW.slot='timeline-pp' BEGIN SELECT RAISE(ABORT,'injected current publication'); END;");
    expect(() => store.publishCurrentReplay(authority, results())).toThrow("injected current publication");
    expect(slot("numerical")?.result).toBeUndefined(); expect(store.metrics.readErrorStrip(replay)?.result).toBeUndefined();
  } finally { db.close(); }
});
it("retires an existing background attempt and notifies eligibility without admitting a replacement", () => {
  store.metrics.setAnalysisSettings({ ...store.metrics.analysisSettings(), mode: "bg" }); const authority = bind();
  const queued = store.metrics.request(authority.numericalTarget, "selection"); if (!("id" in queued)) throw new Error("Expected existing job");
  const running = store.metrics.claim(queued.id)!; const notify = jest.fn(); store.onAnalysisDirty(notify);
  const partial = results()[0]; partial.metrics.fields = { misses: { state: "known", value: 0 } };
  store.publishCurrentReplay(authority, [partial]); expect(store.metrics.isLiveTicket(running)).toBe(false);
  expect(notify.mock.calls.some(([flags]) => (flags & 4) !== 0)).toBe(true); expect(queueCount()).toBe(0);
});
it("checks map generation and source disable leases before publication", () => {
  store.registerSource({ id: "maps", kind: "stable", directory: "C:\\maps" });
  function mapScan() { const generation = store.beginMapScan("maps"); store.upsertMap({ sourceId: "maps", generation, sourceKey: "map",
    md5, locator: "map.osu", state: "unverified", metadata: {} }); store.finishMapScan("maps", generation); }
  mapScan(); const map = store.openMapCandidates(md5).items[0], location = store.openLocationCandidates(replay).items[0];
  const result = store.bindCurrentReplay(location, { sha256: sha, available: true, metadata: {} }, map, descriptor());
  if (result.state !== "applied") throw new Error("Missing binding"); mapScan();
  expect(store.publishCurrentReplay(result.authority, results()).state).toBe("stale");
  const fresh = bind(); store.setSourceEnabled("source", false); expect(store.publishCurrentReplay(fresh, results()).state).toBe("stale");
});
it("rejects a stale location refresh without modifying newer evidence", () => {
  const location = store.openLocationCandidates(replay).items[0]; observe("source", "one", { newer: true });
  expect(store.bindCurrentReplay(location, { sha256: sha, available: true, metadata: { stale: true } }, undefined, descriptor())).toEqual({ state: "stale" });
  expect(store.sourceObservation("source", "one")?.metadata).toEqual({ newer: true }); expect(slot("numerical")).toBeUndefined();
});
it("returns only the bounded requested references removed by collection cascade", () => {
  const parent = store.createCollection("Parent"), child = store.createCollection("Child", parent), ignored = store.createCollection("Other child", parent);
  const retained = store.createCollection("Keep"); store.setMembership(replay, child, true);
  expect(store.deleteCollection(parent, [child, retained, "missing"])).toEqual([parent, child]);
  expect(store.listCollections().map(value => value.id)).toEqual([retained]); expect(store.getReplay(replay)).toBeDefined();
  expect(store.deleteCollection("missing", [ignored])).toEqual([]);
});
it("rejects oversized or duplicate collection-reference cleanup before deleting anything", () => {
  const parent = store.createCollection("Parent");
  expect(() => store.deleteCollection(parent, Array.from({ length: 102 }, (_, index) => `id-${index}`))).toThrow();
  expect(() => store.deleteCollection(parent, ["same", "same"])).toThrow();
  expect(store.listCollections()).toHaveLength(1);
});
it("keeps historical C inert on backfill while preserving current numerical, timeline and FC publication", () => {
  const authority = bind(); expect(store.publishCurrentReplay(authority, results())).toEqual({ state: "applied", accepted: ["numerical", "timeline-pp", "fc-pp"] });
  const evidence = projectLibraryIncidentEvidence(undefined, { replaySha256: sha, mapMd5: md5 });
  const db = new DatabaseSync(database);
  try { db.prepare("INSERT INTO incident_recipes(replay_id,numerical_key,numerical_version,evidence) VALUES(?,?,?,?)")
    .run(replay, authority.numericalTarget.inputKey, authority.numericalTarget.producerVersion, JSON.stringify(evidence));
    // Simulate retained cache history without publishing through the retired C API.
    db.prepare("INSERT INTO metric_targets VALUES(?,'incidents','C','obsolete-c-key','obsolete-c-version',999)").run(replay);
    db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,'incidents','C','obsolete-c-key','obsolete-c-version',?)")
      .run(replay, JSON.stringify({ fields: { incidentCount: { state: "known", value: 0 } }, provenance: { replaySha256: sha } }));
    const numerical = slot("numerical"), timeline = slot("timeline-pp"), fc = slot("fc-pp"), strip = store.metrics.readErrorStrip(replay);
    const historicalTarget = slot("incidents")?.target, historicalPayload = db.prepare("SELECT * FROM metric_results WHERE replay_id=? AND slot='incidents'").all(replay);
    store.reprojectSourceMetrics();
    expect(slot("numerical")).toEqual(numerical); expect(slot("timeline-pp")).toEqual(timeline); expect(slot("fc-pp")).toEqual(fc);
    expect(store.metrics.readErrorStrip(replay)).toEqual(strip); expect(slot("incidents")?.target).toEqual(historicalTarget);
    expect(db.prepare("SELECT * FROM metric_results WHERE replay_id=? AND slot='incidents'").all(replay)).toEqual(historicalPayload);
    expect(store.publishCurrentReplay(authority, results())).toEqual({ state: "cached", accepted: ["numerical", "timeline-pp", "fc-pp"] });
    expect(store.preparations.request(replay, "C", "retry")).toEqual({ state: "disabled" });
    expect(queueCount()).toBe(0);
  } finally { db.close(); }
});
