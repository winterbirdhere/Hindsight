import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";

const source = { id: "stable", kind: "stable" as const, directory: "D:\\osu" };
const imported = { id: "imports", kind: "imported" as const, directory: "D:\\owned" };
const hash = "a".repeat(64), otherHash = "b".repeat(64), md5 = "c".repeat(32);
let store: LibraryStore;
beforeEach(() => { store = new LibraryStore(":memory:", "session"); store.reconcileSources([source, imported]); });
afterEach(() => store.close());
const row = (sourceKey = "one", sha256: string | null = hash) => ({ sourceId: source.id, sourceKey,
  locator: `D:\\osu\\${sourceKey}.osr`, sha256, available: sha256 !== null, addedAt: 10, metadata: { player: "Old" } });
const map = (sourceKey: string) => ({ sourceId: source.id, sourceKey, md5, locator: `D:\\osu\\${sourceKey}.osu`,
  state: "unverified" as const, metadata: { title: sourceKey } });
function seed() {
  const generation = store.beginScan(source.id), id = store.upsertObservation({ ...row(), generation });
  store.finishScan(source.id, generation);
  const maps = store.beginMapScan(source.id); store.upsertMap({ ...map("old"), generation: maps }); store.finishMapScan(source.id, maps);
  return id;
}

it("publishes complete replay/map generations together and preserves identity and user edits", () => {
  const id = seed(), collection = store.createCollection("Keep");
  const run = store.beginRebuild([source.id]);
  store.stageRebuildObservation(run, { ...row(), metadata: { player: "New" } });
  store.stageRebuildMap(run, map("new"));
  store.setReview(id, "reviewed"); store.setFavourite(id, true); store.setMembership(id, collection, true);
  expect(store.getReplay(id)?.metadata).toEqual({ player: "Old" });
  expect(store.mapCandidates(md5).items[0].sourceKey).toBe("old");
  expect(() => store.commitRebuild(run)).toThrow(/incomplete/i);
  store.finishRebuildSource(run, source.id, "complete");
  expect(store.commitRebuild(run)).toEqual({ observations: 1, preserved: 0, removed: 0 });
  expect(store.getReplay(id)).toMatchObject({ metadata: { player: "New" }, firstAddedAt: 10, isNew: false,
    favourite: true, review: "reviewed", collectionIds: [collection] });
  expect(store.mapCandidates(md5).items.map(item => item.sourceKey)).toEqual(["new"]);
  expect(store.integrityCheck()).toBe("ok");
});

it("cancellation publishes nothing, does not consume NEW and retains old maps", () => {
  const id = seed(), run = store.beginRebuild([source.id]);
  store.stageRebuildObservation(run, row("two", otherHash)); store.stageRebuildMap(run, map("new"));
  store.abortRebuild(run);
  expect(store.replayCount()).toBe(1); expect(store.getReplay(id)?.locations[0].available).toBe(true);
  expect(store.mapCandidates(md5).items[0].sourceKey).toBe("old");
  expect(() => store.commitRebuild(run)).toThrow(/rebuild/i);
  const generation = store.beginScan(source.id);
  const added = store.upsertObservation({ ...row("two", otherHash), generation }); store.finishScan(source.id, generation);
  expect(store.getReplay(added)?.isNew).toBe(true);
});

it("requires drained scans, prevents competing scans and rejects source epoch changes atomically", () => {
  seed(); const active = store.beginScan(source.id);
  expect(() => store.beginRebuild([source.id])).toThrow(/active scan/i); store.stopScan(source.id, active);
  const run = store.beginRebuild([source.id]);
  expect(() => store.beginScan(source.id)).toThrow(/rebuild/i);
  expect(() => store.beginMapScan(source.id)).toThrow(/rebuild/i);
  store.stageRebuildObservation(run, row("two", otherHash)); store.finishRebuildSource(run, source.id);
  store.setSourceEnabled(source.id, false); store.setSourceEnabled(source.id, true);
  expect(() => store.commitRebuild(run)).toThrow(/configuration/i);
  expect(store.replayCount()).toBe(1); store.abortRebuild(run);
});

it("preserves newer selected refreshes both against staged replacement and unseen removal", () => {
  const id = seed(), run = store.beginRebuild([source.id]);
  store.stageRebuildObservation(run, { ...row(), sha256: null, available: false, metadata: { fileState: "missing" } });
  const ticket = store.acquireLocationTicket(id, source.id, "one")!;
  store.commitLocationRefresh(ticket, { sha256: hash, available: true, metadata: { player: "Refreshed" } });
  store.finishRebuildSource(run, source.id); expect(store.commitRebuild(run).preserved).toBe(1);
  const run2 = store.beginRebuild([source.id]);
  store.commitLocationRefresh(store.acquireLocationTicket(id, source.id, "one")!, { sha256: hash, available: true, metadata: { player: "Again" } });
  store.finishRebuildSource(run2, source.id); expect(store.commitRebuild(run2).removed).toBe(0);
  expect(store.getReplay(id)).toMatchObject({ metadata: { player: "Again" }, locations: [expect.objectContaining({ available: true })] });
});

it("preserves imports published after its snapshot, including an absent-to-insert location", () => {
  seed(); const run = store.beginRebuild([source.id, imported.id]);
  store.stageRebuildObservation(run, { ...row("two", otherHash), sourceId: imported.id, sourceKey: otherHash });
  const intent = store.prepareImport(imported.id, otherHash, { player: "Imported" }, 20);
  const id = store.completeImport(intent.id, "D:\\owned\\b.osr");
  store.finishRebuildSource(run, source.id); store.finishRebuildSource(run, imported.id);
  expect(store.commitRebuild(run)).toEqual({ observations: 0, preserved: 1, removed: 1 });
  expect(store.getReplay(id)).toMatchObject({ metadata: { player: "Imported" }, isNew: true,
    locations: [expect.objectContaining({ locator: "D:\\owned\\b.osr", available: true })] });
});

it("rejects invalid staging and late rows without modifying live state; can retain unavailable map index", () => {
  seed(); const run = store.beginRebuild([source.id]);
  expect(() => store.stageRebuildObservation(run, { ...row(), sha256: "bad" })).toThrow(/observation/i);
  expect(() => store.stageRebuildMap(run, { ...map("bad"), md5: "bad" })).toThrow(/map/i);
  store.finishRebuildSource(run, source.id, "retain");
  expect(() => store.stageRebuildObservation(run, row())).toThrow(/complete/i);
  expect(() => store.stageRebuildMap(run, map("late"))).toThrow(/complete/i);
  store.commitRebuild(run); expect(store.mapCandidates(md5).items[0].sourceKey).toBe("old");
});

it("discards interrupted staging on restart and preserves the unfinished historical baseline", () => {
  const directory = mkdtempSync(join(tmpdir(), "library-rebuild-")); store.close();
  try {
    const path = join(directory, "library.sqlite"); store = new LibraryStore(path, "first"); store.registerSource(source);
    const run = store.beginRebuild([source.id]); store.stageRebuildObservation(run, row()); store.stageRebuildMap(run, map("discard"));
    store.close(); store = new LibraryStore(path, "second"); expect(store.replayCount()).toBe(0);
    expect(store.mapCandidates(md5).items).toEqual([]); expect(() => store.commitRebuild(run)).toThrow(/rebuild/i);
    const next = store.beginRebuild([source.id]); store.stageRebuildObservation(next, row()); store.finishRebuildSource(next, source.id);
    store.commitRebuild(next);
    expect(store.sourceObservation(source.id, "one")).toMatchObject({ available: true });
    const generation = store.beginScan(source.id); const canonical = store.upsertObservation({ ...row(), generation });
    store.finishScan(source.id, generation); expect(store.getReplay(canonical)?.isNew).toBe(false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
