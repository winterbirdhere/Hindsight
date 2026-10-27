import { DatabaseSync } from "node:sqlite";
import { LibraryStore } from "./library-store";
import { LibraryService } from "./library-service";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

let store: LibraryStore, db: DatabaseSync;
const roots: string[] = [];
beforeEach(() => { store = new LibraryStore(":memory:", "resource-change-test"); db = (store as unknown as { db: DatabaseSync }).db; });
afterEach(() => { store.close(); for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture root");
  rmSync(root, { recursive: true, force: true });
} });
function changes(since: string) {
  return store.currentChangesSince(since);
}
function add(key = "one", hash = "a") {
  store.registerSource({ id: "source", kind: "imported", directory: "fixture" });
  return store.upsertObservation({ sourceId: "source", sourceKey: key, generation: store.beginScan("source"),
    locator: key + ".osr", sha256: hash.repeat(64), available: true, addedAt: 1, metadata: {} });
}
it("scopes resource metadata changes to the affected replay and deduplicates its summary", () => {
  const id = add(), other = add("two", "b"), from = store.resourceRevision();
  const ticket = store.openLocationCandidates(id).items[0];
  store.commitLocationRefresh(ticket, { sha256: ticket.sha256, available: true, metadata: { observed: true } });
  expect(Number(store.resourceRevision()) - Number(from)).toBe(2);
  expect(changes(from)).toEqual({ from, to: store.resourceRevision(), scope: "replays", replayIds: [id] });
  expect(store.resourceLeaseCurrent(store.openLocationCandidates(other).items[0])).toBe(true);
});
it("journals both location identities and merge destinations in one complete interval", () => {
  const a = add(), b = add("two", "b"), from = store.resourceRevision();
  db.prepare("UPDATE locations SET replay_id=? WHERE replay_id=?").run(b, a);
  db.prepare("UPDATE replays SET merged_into=? WHERE id=?").run(b, a);
  expect(changes(from)).toEqual({ from, to: store.resourceRevision(), scope: "replays", replayIds: [a, b].sort() });
});
it("falls back globally for source changes and unobserved counter gaps", () => {
  add(); const from = store.resourceRevision(); store.setSourceEnabled("source", false);
  expect(changes(from)).toEqual({ from, to: store.resourceRevision(), scope: "all" });
  const gap = store.resourceRevision(); db.exec("UPDATE query_projection_state SET resource_revision=resource_revision+1 WHERE id=1");
  expect(changes(gap)).toEqual({ from: gap, to: store.resourceRevision(), scope: "all" });
});
it("keeps journal changes atomic with rollback and supports an empty current interval", () => {
  const id = add(), from = store.resourceRevision();
  db.exec("BEGIN"); db.prepare("UPDATE replays SET metadata=? WHERE id=?").run('{"changed":true}', id); db.exec("ROLLBACK");
  expect(changes(from)).toEqual({ from, to: from, scope: "replays", replayIds: [] });
});
it("does not invalidate artwork for identical observation, generation bookkeeping or strip publication", () => {
  const id = add(), from = store.resourceRevision(), ticket = store.openLocationCandidates(id).items[0];
  store.commitLocationRefresh(ticket, { sha256: ticket.sha256, available: true, metadata: {} });
  db.prepare("UPDATE locations SET generation='bookkeeping' WHERE replay_id=?").run(id);
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload,strip_payload) VALUES(?,'numerical','S','fixture','fixture','{}','{}')").run(id);
  expect(changes(from)).toEqual({ from, to: from, scope: "replays", replayIds: [] });
});
it("keeps pending map writes private and globally invalidates current map publication and changes", () => {
  store.registerSource({ id: "maps", kind: "stable", directory: "fixture" });
  const from = store.resourceRevision(), generation = store.beginMapScan("maps");
  store.upsertMap({ sourceId: "maps", generation, sourceKey: "map", md5: "c".repeat(32), locator: "map.osu", state: "unverified", metadata: {} });
  expect(changes(from)).toEqual({ from, to: from, scope: "replays", replayIds: [] });
  store.finishMapScan("maps", generation);
  expect(changes(from)).toEqual({ from, to: store.resourceRevision(), scope: "all" });
  const published = store.resourceRevision(); db.prepare("UPDATE maps SET locator='moved.osu' WHERE generation=?").run(generation);
  expect(changes(published)).toEqual({ from: published, to: store.resourceRevision(), scope: "all" });
});
it("retains at most 1024 revisions and never returns partial evidence after rollover or a missing row", () => {
  const id = add(), from = store.resourceRevision(), update = db.prepare("UPDATE replays SET metadata=? WHERE id=?");
  db.exec("BEGIN"); for (let i = 0; i < 1025; i++) update.run(JSON.stringify({ i }), id); db.exec("COMMIT");
  const to = store.resourceRevision(), retainedFrom = String(BigInt(from) + BigInt(1));
  expect(db.prepare("SELECT count(*) AS n FROM resource_changes").get()?.n).toBe(1024);
  expect(changes(from)).toEqual({ from, to, scope: "all" });
  expect(changes(retainedFrom)).toEqual({ from: retainedFrom, to, scope: "replays", replayIds: [id] });
  db.prepare("DELETE FROM resource_changes WHERE revision=?").run(String(BigInt(to) - BigInt(10)));
  expect(changes(retainedFrom)).toEqual({ from: retainedFrom, to, scope: "all" });
  expect(changes(String(BigInt(to) + BigInt(1))).scope).toBe("all");
  expect(changes("not-a-revision").scope).toBe("all");
});
it("falls back globally on ID union overflow or invalid journal identity", () => {
  const from = store.resourceRevision();
  const insert = db.prepare("INSERT INTO replays(id,added_at,added_session,added_sequence,baseline,metadata) VALUES(?,1,'test',1,0,'{}')");
  const update = db.prepare(`UPDATE replays SET metadata='{"changed":true}' WHERE id=?`);
  db.exec("BEGIN"); for (let i = 0; i < 257; i++) { insert.run("id-" + i); update.run("id-" + i); } db.exec("COMMIT");
  expect(changes(from)).toEqual({ from, to: store.resourceRevision(), scope: "all" });
  const current = store.resourceRevision();
  insert.run("invalid/path"); update.run("invalid/path");
  expect(changes(current).scope).toBe("all");
});
it("migrates schema 26 without inventing old history and preserves the bounded journal across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "rewind-resource-migration-")); roots.push(root);
  const path = join(root, "library.sqlite"); store.close(); store = new LibraryStore(path, "old"); db = store["db"];
  const id = add(), from = store.resourceRevision();
  // Restore schema-26 resource trigger bodies; preserve their exact table/event/WHEN definitions.
  for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'query_resource_%'").all()) {
    const old = String(row.sql).replace(/BEGIN[\s\S]*END$/, "BEGIN UPDATE query_projection_state SET resource_revision=resource_revision+1 WHERE id=1; END");
    db.exec(`DROP TRIGGER ${row.name};${old}`);
  }
  db.exec("DROP TABLE resource_changes;PRAGMA user_version=26");
  const replay = db.prepare("SELECT * FROM replays WHERE id=?").get(id); store.close();
  store = new LibraryStore(path, "migrated"); db = store["db"];
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(27);
  expect(db.prepare("SELECT * FROM replays WHERE id=?").get(id)).toEqual(replay);
  expect(store.resourceRevision()).toBe(from);
  expect(changes("0").scope).toBe("all");
  db.prepare("UPDATE replays SET metadata='{} ' WHERE id=?").run(id); const after = store.resourceRevision(); store.close();
  store = new LibraryStore(path, "reopened"); db = store["db"];
  expect(changes(from)).toEqual({ from, to: after, scope: "replays", replayIds: [id] });
});
it("service publications carry a complete interval while a new subscriber gets a conservative snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "rewind-resource-service-")); roots.push(root);
  const service = await LibraryService.open({ directory: root, sessionId: "scopes", nativeExecutable: join(root, "not-present.exe"), sources: [] });
  try {
    const observed: unknown[] = [], owned = service["store"]; service.onLibraryChanged(event => observed.push(event));
    const from = owned.resourceRevision(); owned.registerSource({ id: "fixture-imports", kind: "imported", directory: root });
    const id = owned.upsertObservation({ sourceId: "fixture-imports", sourceKey: "one", generation: owned.beginScan("fixture-imports"), locator: join(root, "one.osr"),
      sha256: "a".repeat(64), available: true, addedAt: 1, metadata: {} });
    expect(observed).toContainEqual(expect.objectContaining({ resourceChanges: { from, to: owned.resourceRevision(), scope: "replays", replayIds: [id] } }));
    const snapshot = jest.fn(); service.onLibraryChanged(snapshot); expect(snapshot.mock.calls[0][0]).not.toHaveProperty("resourceChanges");
  } finally { await service.close(); }
});
