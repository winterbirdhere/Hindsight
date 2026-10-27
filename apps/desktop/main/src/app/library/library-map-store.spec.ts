import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { LibraryStore } from "./library-store";

let folder: string; let store: LibraryStore;
const md5 = "a".repeat(32);
const digest = "b".repeat(64);
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hindsight-map-store-"));
  store = new LibraryStore(join(folder, "index.sqlite"), "session");
  store.registerSource({ id: "stable", kind: "stable", directory: "C:\\osu" });
});
afterEach(() => {
  store.close();
  if (!resolve(folder).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
  rmSync(folder, { recursive: true, force: true });
});
function add(generation: string, key: string, title = key) {
  store.upsertMap({ sourceId: "stable", generation, sourceKey: key, md5, locator: "C:\\Songs\\" + key + ".osu",
    state: "unverified", metadata: { title, databaseSha256: digest } });
}

it("retains the exact complete catalog lease and collects only the discarded pending generation", () => {
  const first = store.beginMapScan("stable"); add(first, "a"); add(first, "b"); store.finishMapScan("stable", first);
  store.registerSource({ id: "imports", kind: "imported", directory: "D:\\owned" });
  const intent = store.prepareImport("imports", digest, {}, 1), id = store.completeImport(intent.id, "D:\\owned\\r.osr");
  const location = store.openLocationCandidates(id).items[0], map = store.openMapCandidates(md5).items[0];
  const revision = store.resourceRevision(), sourceMapRevision = store.sourceMapRevision();
  const discarded = store.beginMapScan("stable"); add(discarded, "b"); add(discarded, "a");
  store.finishMapScan("stable", discarded, true);
  expect(store.resourceLeaseCurrent(location, map)).toBe(true);
  expect(store.resourceRevision()).toBe(revision); expect(store.sourceMapRevision()).toBe(sourceMapRevision);
  expect(store.currentChangesSince(revision)).toEqual({ from: revision, to: revision, scope: "replays", replayIds: [] });
  expect(store.mapGarbagePending()).toBeGreaterThan(0);
  const next = store.beginMapScan("stable"); expect(next).not.toBe(discarded); expect(next).not.toBe(first); add(next, "new");
  for (let n = 0; n < 100 && (store.queryProjectionPending() || store.mapGarbagePending()); n++) {
    if (store.queryProjectionPending()) store.maintainQueryProjection(); else store.maintainMapGarbage(1);
  }
  expect(store.mapGarbagePending()).toBe(0); expect(store.openMapCandidates(md5).items[0].generation).toBe(first);
  store.finishMapScan("stable", next, true);
  expect(store.openMapCandidates(md5).items).toEqual([expect.objectContaining({ generation: next, sourceKey: "new" })]);
  expect(store.resourceLeaseCurrent(location, map)).toBe(false);
  expect(store.currentChangesSince(revision).scope).toBe("all");
});

it.each(["add", "remove", "key", "md5", "locator", "state", "metadata"])("keeps %s differences conservative even for a certified check", change => {
  const first = store.beginMapScan("stable"); add(first, "map"); store.finishMapScan("stable", first);
  const revision = store.resourceRevision(), next = store.beginMapScan("stable");
  if (change !== "remove") store.upsertMap({ sourceId: "stable", generation: next, sourceKey: change === "key" ? "other" : "map",
    md5: change === "md5" ? "c".repeat(32) : md5, locator: change === "locator" ? "C:\\Moved\\map.osu" : "C:\\Songs\\map.osu",
    state: change === "state" ? "invalid-path" : "unverified", metadata: { title: "map", databaseSha256: change === "metadata" ? "d".repeat(64) : digest } });
  if (change === "add") add(next, "additional");
  store.finishMapScan("stable", next, true);
  expect(store.currentChangesSince(revision)).toEqual({ from: revision, to: store.resourceRevision(), scope: "all" });
});

it("preserves an empty catalog only after first publication and keeps explicit equivalent refresh global", () => {
  const revision = store.resourceRevision(), first = store.beginMapScan("stable"); store.finishMapScan("stable", first, true);
  expect(store.currentChangesSince(revision).scope).toBe("all");
  const published = store.resourceRevision(), next = store.beginMapScan("stable"); store.finishMapScan("stable", next, true);
  expect(store.resourceRevision()).toBe(published);
  const refresh = store.beginMapScan("stable"); store.finishMapScan("stable", refresh);
  expect(store.currentChangesSince(published).scope).toBe("all");
});

it("does not commit equivalent cleanup if its publication transaction fails", () => {
  const first = store.beginMapScan("stable"); add(first, "a"); store.finishMapScan("stable", first);
  const pending = store.beginMapScan("stable"); add(pending, "a");
  const revision = store.resourceRevision(), garbage = store.mapGarbagePending(), db = store["db"];
  db.exec("CREATE TEMP TRIGGER fail_equivalent BEFORE UPDATE OF pending_generation ON map_scans WHEN NEW.pending_generation IS NULL BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  expect(() => store.finishMapScan("stable", pending, true)).toThrow("fixture rollback");
  expect(store.resourceRevision()).toBe(revision); expect(store.mapGarbagePending()).toBe(garbage);
  expect(db.prepare("SELECT current_generation,pending_generation FROM map_scans WHERE source_id='stable'").get()).toMatchObject({ current_generation: first, pending_generation: pending });
  db.exec("DROP TRIGGER fail_equivalent"); store.finishMapScan("stable", pending, true);
  expect(store.openMapCandidates(md5).items[0].generation).toBe(first);
});

it("cannot reuse interrupted or cancelled staging and retains equivalence across reopen", () => {
  const first = store.beginMapScan("stable"); add(first, "a"); store.finishMapScan("stable", first);
  const stopped = store.beginMapScan("stable"); add(stopped, "a"); store.stopMapScan("stable", stopped);
  expect(() => store.finishMapScan("stable", stopped, true)).toThrow(/stale/i);
  const interrupted = store.beginMapScan("stable"); add(interrupted, "a");
  store.close(); store = new LibraryStore(join(folder, "index.sqlite"), "reopened");
  expect(() => store.finishMapScan("stable", interrupted, true)).toThrow(/stale/i);
  const revision = store.resourceRevision(), next = store.beginMapScan("stable"); add(next, "a"); store.finishMapScan("stable", next, true);
  expect(store.resourceRevision()).toBe(revision); expect(store.openMapCandidates(md5).items[0].generation).toBe(first);
});

it("pages map-open tickets and rejects stale map publication independently of replay identity", () => {
  const generation = store.beginMapScan("stable"); add(generation, "a"); add(generation, "b"); store.finishMapScan("stable", generation);
  const first = store.openMapCandidates(md5, undefined, 1);
  expect(first.items[0]).toMatchObject({ sourceId: "stable", sourceKey: "a", generation, md5, kind: "stable" });
  expect(store.openMapCandidates(md5, first.next, 1).items[0].sourceKey).toBe("b");
  store.registerSource({ id: "imports", kind: "imported", directory: "D:\\owned" });
  const intent = store.prepareImport("imports", digest, {}, 1); const id = store.completeImport(intent.id, "D:\\owned\\replay.osr");
  const ticket = store.acquireLocationTicket(id, "imports", digest)!;
  const observation = { sha256: digest, available: true, metadata: { refreshed: true } };
  const pending = store.beginMapScan("stable"); add(pending, "new");
  expect(store.commitLocationRefresh(ticket, observation, first.items[0]).state).toBe("applied");
  const nextTicket = store.acquireLocationTicket(id, "imports", digest)!;
  store.finishMapScan("stable", pending);
  expect(store.commitLocationRefresh(nextTicket, observation, first.items[0])).toEqual({ state: "stale" });
  const current = store.openMapCandidates(md5).items[0];
  store.setSourceEnabled("stable", false); store.setSourceEnabled("stable", true);
  expect(store.commitLocationRefresh(nextTicket, observation, current)).toEqual({ state: "stale" });
  expect(store.acquireLocationTicket(id, "imports", digest)).toEqual(nextTicket);
});

it("bounds wide map-open pages by bytes and keeps every candidate reachable", () => {
  const generation = store.beginMapScan("stable");
  for (let i = 0; i < 16; i++) store.upsertMap({ sourceId: "stable", generation, sourceKey: String(i).padStart(2, "0") + "路".repeat(32000),
    md5, locator: "路".repeat(32000), state: "unverified", metadata: { text: "x".repeat(65000) } });
  store.finishMapScan("stable", generation);
  let cursor: { sourceId: string; sourceKey: string } | undefined;
  const keys: string[] = [];
  do {
    const page = store.openMapCandidates(md5, cursor);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1536 * 1024);
    expect(page.items.length).toBeGreaterThan(0);
    keys.push(...page.items.map(item => item.sourceKey.slice(0, 2))); cursor = page.next;
  } while (cursor);
  expect(keys).toEqual(Array.from({ length: 16 }, (_, i) => String(i).padStart(2, "0")));
});

it("publishes an exhaustive generation atomically and retains duplicate MD5 candidates", () => {
  const generation = store.beginMapScan("stable"); add(generation, "first"); add(generation, "second");
  expect(store.mapCandidates(md5).items).toEqual([]);
  store.finishMapScan("stable", generation);
  expect(store.mapCandidates(md5).items.map(row => row.sourceKey)).toEqual(["first", "second"]);
  expect(store.mapCandidates(md5, 1)).toMatchObject({ items: [expect.anything()], truncated: true });
  const next = store.beginMapScan("stable"); add(next, "replacement");
  expect(store.mapCandidates(md5).items).toHaveLength(2);
  store.finishMapScan("stable", next);
  expect(store.mapCandidates(md5).items).toEqual([expect.objectContaining({ sourceKey: "replacement", state: "unverified" })]);
});

it("preserves the committed snapshot across stopped scans and restart", () => {
  const first = store.beginMapScan("stable"); add(first, "old"); store.finishMapScan("stable", first);
  const stopped = store.beginMapScan("stable"); add(stopped, "partial"); store.stopMapScan("stable", stopped);
  expect(() => add(stopped, "late")).toThrow(/stale/i);
  const interrupted = store.beginMapScan("stable"); add(interrupted, "interrupted");
  store.close(); store = new LibraryStore(join(folder, "index.sqlite"), "next-session");
  expect(store.mapCandidates(md5).items.map(row => row.sourceKey)).toEqual(["old"]);
  expect(() => store.finishMapScan("stable", interrupted)).toThrow(/stale/i);
  const empty = store.beginMapScan("stable"); store.finishMapScan("stable", empty);
  expect(store.mapCandidates(md5).items).toEqual([]);
});

it("hides disabled source candidates without deleting them or accepting stale publication", () => {
  const first = store.beginMapScan("stable"); add(first, "map"); store.finishMapScan("stable", first);
  const pending = store.beginMapScan("stable"); add(pending, "pending");
  store.setSourceEnabled("stable", false);
  expect(store.mapCandidates(md5).items).toEqual([]);
  expect(() => store.finishMapScan("stable", pending)).toThrow(/stale/i);
  store.setSourceEnabled("stable", true);
  expect(store.mapCandidates(md5).items.map(row => row.sourceKey)).toEqual(["map"]);
  expect(() => store.finishMapScan("stable", pending)).toThrow(/stale/i);
  expect(store.integrityCheck()).toBe("ok");
});

it("retires omitted installations atomically, preserving their maps and prior toggle preferences", () => {
  const generation = store.beginMapScan("stable"); add(generation, "preserved"); store.finishMapScan("stable", generation);
  store.reconcileSources([{ id: "replacement", kind: "stable", directory: "C:\\other-osu" }]);
  expect(store.sourceEnabled("stable")).toBe(false);
  expect(store.mapCandidates(md5).items).toEqual([]);
  expect(() => store.reconcileSources([{ id: "stable", kind: "stable", directory: "C:\\wrong-root" }])).toThrow(/directory/);
  expect(store.sourceEnabled("replacement")).toBe(true);
  store.reconcileSources([{ id: "stable", kind: "stable", directory: "C:\\osu" }]);
  expect(store.sourceEnabled("stable")).toBe(true);
  expect(store.mapCandidates(md5).items.map(row => row.sourceKey)).toEqual(["preserved"]);
  store.setSourceEnabled("stable", false);
  store.reconcileSources([]); store.reconcileSources([{ id: "stable", kind: "stable", directory: "C:\\osu" }]);
  expect(store.sourceEnabled("stable")).toBe(false);
});
