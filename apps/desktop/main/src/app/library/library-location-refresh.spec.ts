import { LibraryStore } from "./library-store";

let store: LibraryStore;
const source = { id: "replays", kind: "replays" as const, directory: "D:\\Replays" };
const sha = "a".repeat(64), replacementSha = "b".repeat(64);
beforeEach(() => { store = new LibraryStore(":memory:", "session"); store.registerSource(source); });
afterEach(() => store.close());
function seed(hash: string | null = sha) {
  const generation = store.beginScan(source.id);
  const id = store.upsertObservation({ sourceId: source.id, sourceKey: "one.osr", locator: "D:\\Replays\\one.osr", sha256: hash,
    available: hash !== null, generation, addedAt: 10, metadata: { fileState: "readable", player: "Original" } });
  store.finishScan(source.id, generation); return id;
}
const fresh = { sha256: sha, available: true, metadata: { fileState: "readable", player: "Fresh" } };

it("publishes a verified replacement locator for a provisional score and rejects stale or unverified moves", () => {
  const id = seed(null); const ticket = store.acquireLocationTicket(id, source.id, "one.osr")!;
  expect(() => store.commitLocationRefresh(ticket, { ...fresh, sha256: null, available: false, locator: "D:\\new" })).toThrow(/verified/i);
  expect(store.acquireLocationTicket(id, source.id, "one.osr")).toEqual(ticket);
  expect(store.commitLocationRefresh(ticket, { ...fresh, locator: "D:\\native\\blob" })).toEqual({ state: "applied", replayId: id });
  expect(store.acquireLocationTicket(id, source.id, "one.osr")).toMatchObject({ locator: "D:\\native\\blob", sha256: sha });
  expect(store.commitLocationRefresh(ticket, { ...fresh, locator: "D:\\late" })).toEqual({ state: "stale" });
});

it("refreshes one exact location without inventing a scan or changing user metadata/NEW", () => {
  const id = seed(); const collection = store.createCollection("Saved");
  store.setMembership(id, collection, true); store.setReview(id, "reviewed"); store.setFavourite(id, true);
  const ticket = store.acquireLocationTicket(id, source.id, "one.osr")!;
  expect(store.commitLocationRefresh(ticket, fresh)).toEqual({ state: "applied", replayId: id });
  expect(store.getReplay(id)).toMatchObject({ id, firstAddedAt: 10, isNew: false, review: "reviewed", favourite: true, collectionIds: [collection], metadata: { player: "Fresh" } });
  expect(store.commitLocationRefresh(ticket, fresh)).toEqual({ state: "stale" });
});

it("rejects late refresh after scan removal and after disable/re-enable or retire/reconnect", () => {
  const id = seed(), beforeRemoval = store.acquireLocationTicket(id, source.id, "one.osr")!;
  store.finishScan(source.id, store.beginScan(source.id));
  expect(store.commitLocationRefresh(beforeRemoval, fresh)).toEqual({ state: "stale" });
  const beforeToggle = store.acquireLocationTicket(id, source.id, "one.osr")!;
  store.setSourceEnabled(source.id, false); store.setSourceEnabled(source.id, true);
  expect(store.commitLocationRefresh(beforeToggle, fresh)).toEqual({ state: "stale" });
  const beforeReconfigure = store.acquireLocationTicket(id, source.id, "one.osr")!;
  store.reconcileSources([]); expect(store.acquireLocationTicket(id, source.id, "one.osr")).toBeUndefined();
  store.reconcileSources([source]);
  expect(store.commitLocationRefresh(beforeReconfigure, fresh)).toEqual({ state: "stale" });
});

it("retains verified evidence for a missing location and can repair it without NEW", () => {
  const id = seed(); const ticket = store.acquireLocationTicket(id, source.id, "one.osr")!;
  expect(store.commitLocationRefresh(ticket, { sha256: null, available: false, metadata: { fileState: "missing", reason: "ENOENT" } })).toEqual({ state: "applied", replayId: id });
  expect(store.getReplay(id)).toMatchObject({ metadata: { player: "Original", fileState: "missing" }, locations: [expect.objectContaining({ sha256: sha, available: false })] });
  const repair = store.acquireLocationTicket(id, source.id, "one.osr")!;
  expect(store.commitLocationRefresh(repair, fresh)).toEqual({ state: "applied", replayId: id });
  expect(store.getReplay(id)).toMatchObject({ isNew: false, locations: [expect.objectContaining({ available: true })] });
});

it("bounds the final failed-refresh projection while preserving verified evidence", () => {
  const id = seed();
  const evidence = "x".repeat(64000);
  store.commitLocationRefresh(store.acquireLocationTicket(id, source.id, "one.osr")!, { ...fresh, metadata: { evidence, fileState: "readable" } });
  store.commitLocationRefresh(store.acquireLocationTicket(id, source.id, "one.osr")!, {
    sha256: null, available: false, metadata: { fileState: "missing", reason: "断".repeat(21000) },
  });
  const replay = store.getReplay(id)!;
  expect(replay.metadata.evidence).toBe(evidence);
  expect(replay.metadata.fileState).toBe("missing");
  expect(Buffer.byteLength(JSON.stringify(replay.metadata))).toBeLessThanOrEqual(65536);
  expect(replay.locations[0]).toMatchObject({ sha256: sha, available: false });
});

it("never opens changed bytes under the previous identity or copies its user metadata", () => {
  const id = seed(); store.setReview(id, "reviewed"); store.setFavourite(id, true);
  const result = store.commitLocationRefresh(store.acquireLocationTicket(id, source.id, "one.osr")!, { ...fresh, sha256: replacementSha });
  expect(result.state).toBe("content-changed");
  if (result.state !== "content-changed") throw Error("Expected changed content identity");
  expect(result.replayId).not.toBe(id);
  expect(store.getReplay(result.replayId)).toMatchObject({ review: "not-reviewed", favourite: false, isNew: true });
  expect(store.getReplay(id)).toMatchObject({ review: "reviewed", favourite: true });
});

it("allows a provisional identity to resolve to known bytes and preserves its edits through the alias", () => {
  const first = seed(null); store.setReview(first, "reviewed");
  store.registerSource({ id: "imports", kind: "imported", directory: "D:\\owned" });
  const intent = store.prepareImport("imports", sha, {}, 20); const known = store.completeImport(intent.id, "D:\\owned\\a.osr");
  const result = store.commitLocationRefresh(store.acquireLocationTicket(first, source.id, "one.osr")!, fresh);
  expect(result).toEqual({ state: "applied", replayId: known });
  expect(store.getReplay(first)).toMatchObject({ id: known, review: "reviewed", firstAddedAt: 10, isNew: false });
});

it("does not let a finished scan mark a successfully refreshed location missing", () => {
  const id = seed(); const generation = store.beginScan(source.id);
  const ticket = store.acquireLocationTicket(id, source.id, "one.osr")!;
  store.commitLocationRefresh(ticket, fresh); store.finishScan(source.id, generation);
  expect(store.getReplay(id)?.locations[0].available).toBe(true);
});

it("rejects scan rows produced before an explicit refresh even without a cached row revision", () => {
  const id = seed(); const generation = store.beginScan(source.id);
  const ticket = store.acquireLocationTicket(id, source.id, "one.osr")!;
  store.commitLocationRefresh(ticket, fresh);
  const delayed = { sourceId: source.id, sourceKey: "one.osr", locator: ticket.locator, generation,
    addedAt: 30, sha256: null, available: false, metadata: { fileState: "missing", reason: "stale read" } };
  store.upsertObservation(delayed); store.finishScan(source.id, generation);
  expect(store.getReplay(id)).toMatchObject({ metadata: { fileState: "readable", player: "Fresh" }, locations: [expect.objectContaining({ available: true })] });
  const next = store.beginScan(source.id); store.upsertObservation({ ...delayed, generation: next }); store.finishScan(source.id, next);
  expect(store.getReplay(id)?.locations[0].available).toBe(false);
});
