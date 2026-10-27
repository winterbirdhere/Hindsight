import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { createHash } from "crypto";
import * as fileSystem from "fs/promises";
import { LibraryStore } from "./library-store";
import { ReplayImporter } from "./import-replays";

let folder: string;
let managed: string;
let source: string;
let database: string;
let store: LibraryStore;
let importer: ReplayImporter;
const header = Buffer.alloc(5); header.writeInt32LE(20260904, 1);
const timing = Buffer.alloc(12); timing.writeBigInt64LE(BigInt("638961337234567891")); timing.writeInt32LE(0, 8);
const bytes = Buffer.concat([header, Buffer.from([11, 32]), Buffer.from("a".repeat(32)), Buffer.from([0, 0]),
  Buffer.alloc(23), Buffer.from([0]), timing, Buffer.alloc(8)]);
const hash = createHash("sha256").update(bytes).digest("hex");
function replayId(result: { replayId?: string }): string {
  if (!result.replayId) throw new Error("Expected an imported replay identity");
  return result.replayId;
}
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "hindsight-import-"));
  managed = join(folder, "owned"); source = join(folder, "original.osr"); database = join(folder, "index.sqlite");
  await writeFile(source, bytes);
  store = new LibraryStore(database, "session-1"); importer = new ReplayImporter(store, managed);
});
afterEach(async () => {
  store.close();
  // Only this test's verified temporary directory may be removed recursively.
  if (!resolve(folder).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
  await rm(folder, { recursive: true, force: true });
});

it("makes one owned copy across repeated/concurrent imports and preserves the original", async () => {
  const results = await Promise.all([importer.importReplays([source]), importer.importReplays([source, source])]);
  expect(results.flat().map(r => r.status)).toEqual(["added", "already-imported", "already-imported"]);
  const id = replayId(results[0][0]);
  expect(store.listReplayIds()).toEqual([id]);
  expect(store.getReplay(id)).toMatchObject({ isNew: true, locations: [expect.objectContaining({ sha256: hash })] });
  expect(await readFile(join(managed, hash + ".osr"))).toEqual(bytes);
  expect(await readFile(source)).toEqual(bytes);
  expect((await readdir(managed)).filter(f => f.endsWith(".osr"))).toEqual([hash + ".osr"]);
  expect(store.pendingImports()).toEqual([]);
});

it("attaches an imported location to existing content without losing review or collection edits", async () => {
  store.registerSource({ id: "stable", kind: "stable", directory: folder });
  const generation = store.beginScan("stable");
  const id = store.upsertObservation({ sourceId: "stable", sourceKey: "score", locator: source, sha256: hash, available: true,
    generation, addedAt: 1, metadata: { player: "P" } });
  store.finishScan("stable", generation);
  const collection = store.createCollection("Practice"); store.setMembership(id, collection, true); store.setReview(id, "reviewed");
  expect(await importer.importReplays([source])).toEqual([expect.objectContaining({ status: "added", replayId: id })]);
  expect(store.getReplay(id)).toMatchObject({ isNew: false, review: "reviewed", collectionIds: [collection], locations: [expect.anything(), expect.anything()] });
});

it("recovers a promoted copy after restart without recopying the original or losing metadata", async () => {
  jest.spyOn(store, "completeImport").mockImplementationOnce(() => { throw new Error("interrupted database commit"); });
  expect((await importer.importReplays([source]))[0].status).toBe("failed");
  expect(store.pendingImports()).toHaveLength(1);
  await unlink(source); // Recovery must not need the original.
  store.close(); store = new LibraryStore(database, "session-2"); importer = new ReplayImporter(store, managed);
  const recovered = await importer.recover();
  expect(recovered).toEqual([expect.objectContaining({ status: "added" })]);
  expect(store.pendingImports()).toHaveLength(0);
  expect(store.listReplayIds()).toHaveLength(1);
  expect(await readFile(join(managed, hash + ".osr"))).toEqual(bytes);
});

it("repairs a missing owned copy only on explicit import and reuses its identity", async () => {
  const first = (await importer.importReplays([source]))[0];
  store.setReview(replayId(first), "needs-another-look");
  await unlink(join(managed, hash + ".osr"));
  expect(await importer.recover()).toEqual([]);
  const repaired = (await importer.importReplays([source]))[0];
  expect(repaired).toMatchObject({ status: "added", replayId: first.replayId });
  expect(store.getReplay(replayId(first))?.review).toBe("needs-another-look");
});

it("refuses an occupied corrupt destination and malformed imports without overwriting files", async () => {
  await mkdir(managed); await writeFile(join(managed, hash + ".osr"), "foreign bytes");
  expect((await importer.importReplays([source]))[0]).toMatchObject({ status: "failed" });
  expect(await readFile(join(managed, hash + ".osr"), "utf8")).toBe("foreign bytes");
  await writeFile(source, "bad header");
  expect((await importer.importReplays([source]))[0].status).toBe("failed");
  expect(store.listReplayIds()).toHaveLength(0);
});

it("abandons a journal-owned interrupted partial copy on recovery without touching the original", async () => {
  await mkdir(managed);
  store.registerSource({ id: "imports", kind: "imported", directory: managed });
  const intent = store.prepareImport("imports", hash, { validation: "header-only" }, 1);
  await writeFile(join(managed, intent.id + ".part"), bytes.subarray(0, 12));
  expect(await importer.recover()).toEqual([expect.objectContaining({ status: "failed" })]);
  expect(store.pendingImports()).toEqual([]);
  expect(await readdir(managed)).toEqual([]);
  expect(await readFile(source)).toEqual(bytes);
  expect((await importer.importReplays([source]))[0].status).toBe("added");
});

it("reports first registration as added after a promoted-copy commit failure, and duplicate recovery as already imported", async () => {
  jest.spyOn(store, "completeImport").mockImplementationOnce(() => { throw new Error("interrupted commit"); });
  expect((await importer.importReplays([source]))[0].status).toBe("failed");
  expect((await importer.importReplays([source]))[0].status).toBe("added");
  expect(await importer.recover()).toEqual([expect.objectContaining({ status: "already-imported" })]);
  expect(store.listReplayIds()).toHaveLength(1);
});

it("does not publish or commit a recovered staged copy when its durability flush fails", async () => {
  await mkdir(managed); store.registerSource({ id: "imports", kind: "imported", directory: managed });
  const intent = store.prepareImport("imports", hash, {}, 1);
  await writeFile(join(managed, intent.id + ".part"), bytes);
  const actualOpen = fileSystem.open;
  const spy = jest.spyOn(fileSystem, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await actualOpen(path, flags, mode);
    if (flags === "r+") jest.spyOn(handle, "sync").mockRejectedValue(new Error("flush failed"));
    return handle;
  });
  try {
    expect(await importer.recover()).toEqual([expect.objectContaining({ status: "failed", error: "flush failed" })]);
    expect(store.listReplayIds()).toEqual([]);
    expect(await readdir(managed)).toEqual([intent.id + ".part"]);
  } finally { spy.mockRestore(); }
  expect(await importer.recover()).toEqual([expect.objectContaining({ status: "added" })]);
});

it("can cancel initialization recovery without abandoning valid owned bytes", async () => {
  await mkdir(managed); store.registerSource({ id: "imports", kind: "imported", directory: managed });
  const intent = store.prepareImport("imports", hash, {}, 1); await writeFile(join(managed, intent.id + ".part"), bytes);
  const abort = new AbortController(); abort.abort();
  await expect(importer.recover(abort.signal)).rejects.toThrow(/abort/i);
  expect(store.pendingImports()).toHaveLength(1);
  expect(await readFile(join(managed, intent.id + ".part"))).toEqual(bytes);
});
