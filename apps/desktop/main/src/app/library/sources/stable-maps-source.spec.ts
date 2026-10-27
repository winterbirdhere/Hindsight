import { mkdtemp, mkdir, writeFile, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { LibraryStore } from "../library-store";
import { indexStableMaps } from "./stable-maps-source";

let root: string; let songs: string; let store: LibraryStore;
const md5 = "a".repeat(32);
const i = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const f = (n: number) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
const d = (n: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
const s = (v: string) => v ? Buffer.concat([Buffer.from([11, Buffer.byteLength(v)]), Buffer.from(v)]) : Buffer.from([0]);
function database(folder = "Mapset", file = "map.osu", timingCount = 1) {
  const entry = Buffer.concat([
    ...["Artist", "", "Title", "", "Mapper", "Diff", "song.mp3", md5, file].map(s), Buffer.from([2]), Buffer.alloc(14),
    f(9), f(4), f(5), f(8), d(1.4), i(-1), i(-1), i(-1), i(-1), i(120), i(140000), i(-1), i(timingCount),
    ...Array.from({ length: timingCount }, () => Buffer.concat([d(500), d(0), Buffer.from([1])])),
    i(-1), i(24), i(0), Buffer.alloc(6), f(0.7), Buffer.from([0]), s(""), s(""), Buffer.alloc(2), s(""),
    Buffer.from([1]), Buffer.alloc(8), Buffer.from([0]), s(folder), Buffer.alloc(8), Buffer.alloc(5), i(0), Buffer.from([0]),
  ]);
  return Buffer.concat([i(20260924), i(1), Buffer.from([0]), Buffer.alloc(8), s("P"), i(1), entry, i(1)]);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hindsight-stable-maps-")); songs = join(root, "Custom Songs"); await mkdir(songs);
  store = new LibraryStore(join(root, "index.sqlite"), "session"); store.registerSource({ id: "stable", kind: "stable", directory: root });
});
afterEach(async () => {
  store.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected test directory");
  await rm(root, { recursive: true, force: true });
});
it("indexes saved metadata with custom Songs-root provenance without claiming the map exists", async () => {
  const data = database(); await writeFile(join(root, "osu!.db"), data);
  await indexStableMaps(store, "stable", root, songs);
  expect(store.mapCandidates(md5).items).toEqual([expect.objectContaining({
    locator: join(songs, "Mapset", "map.osu"), state: "unverified", generation: expect.any(String),
    metadata: expect.objectContaining({ songsRoot: songs, databaseSha256: expect.stringMatching(/^[a-f\d]{64}$/),
      map: expect.objectContaining({ title: "Title", rankedStatus: 2 }), cachedNoModStars: null, cachedTempo: { min: 120, max: 120 } }),
  })]);
  expect(await readFile(join(root, "osu!.db"))).toEqual(data);
});
it("keeps the completed equivalent catalog current for a certified automatic check", async () => {
  await writeFile(join(root, "osu!.db"), database());
  await indexStableMaps(store, "stable", root, songs);
  const before = store.openMapCandidates(md5), revision = store.resourceRevision();
  await indexStableMaps(store, "stable", root, songs,
    { reuseEquivalentCatalog: true });
  expect(store.openMapCandidates(md5)).toEqual(before);
  expect(store.resourceRevision()).toBe(revision);
});
it("still republishes an equivalent catalog for absent or explicit refresh intent", async () => {
  await writeFile(join(root, "osu!.db"), database()); await indexStableMaps(store, "stable", root, songs);
  for (const options of [{}, { reuseEquivalentCatalog: false }]) {
    const before = store.openMapCandidates(md5).items[0].generation, revision = store.resourceRevision();
    await indexStableMaps(store, "stable", root, songs, options);
    expect(store.openMapCandidates(md5).items[0].generation).not.toBe(before);
    expect(store.currentChangesSince(revision)).toMatchObject({ from: revision, scope: "all" });
  }
});
it("checks the complete source before reusing a catalog and preserves it on late cancellation", async () => {
  await writeFile(join(root, "osu!.db"), database()); await indexStableMaps(store, "stable", root, songs);
  const before = store.openMapCandidates(md5), revision = store.resourceRevision(), controller = new AbortController();
  let staged = false;
  await expect(indexStableMaps(store, "stable", root, songs, { reuseEquivalentCatalog: true, signal: controller.signal,
    onProgress: progress => { if (progress.completed === 1) staged = true; },
    checkpoint: async () => { if (staged) controller.abort(); },
  })).rejects.toThrow(/abort/i);
  expect(staged).toBe(true); expect(store.openMapCandidates(md5)).toEqual(before); expect(store.resourceRevision()).toBe(revision);
});
it("manual feedback exposes map-record progress before reading and never invents a total", async () => {
  await writeFile(join(root, "osu!.db"), database());
  const events: unknown[] = [];
  await indexStableMaps(store, "stable", root, songs, {
    checkpoint: async () => { events.push("checkpoint"); },
    onProgress: (value: unknown) => { events.push(value); },
  } as Parameters<typeof indexStableMaps>[4] & { onProgress: (value: unknown) => void });
  expect(events[0]).toEqual({ phase: "reading-map-metadata", completed: 0, unit: "map-records" });
  expect(events).toContainEqual({ phase: "reading-map-metadata", completed: 1, unit: "map-records" });
  expect(events.filter(value => typeof value === "object").every(value => !("total" in (value as object)))).toBe(true);
});
it.each([["..", "escape.osu"], ["Mapset", "..\\escape.osu"], ["Mapset", "C:\\escape.osu"], ["Mapset", "map.osu:stream"]])(
  "retains invalid path evidence without an executable locator: %s / %s", async (folder, file) => {
    await writeFile(join(root, "osu!.db"), database(folder, file)); await indexStableMaps(store, "stable", root, songs);
    expect(store.mapCandidates(md5).items[0]).toMatchObject({ state: "invalid-path", locator: null });
  });
it("projects dense timing caches within the metadata storage budget", async () => {
  await writeFile(join(root, "osu!.db"), database("Mapset", "map.osu", 10000)); await indexStableMaps(store, "stable", root, songs);
  expect(store.mapCandidates(md5).items[0].metadata).toMatchObject({ cachedTempo: { min: 120, max: 120 } });
});
it("keeps the previous snapshot after corruption or cancellation", async () => {
  await writeFile(join(root, "osu!.db"), database()); await indexStableMaps(store, "stable", root, songs);
  const previous = store.mapCandidates(md5);
  await writeFile(join(root, "osu!.db"), database("New").subarray(0, -1));
  await expect(indexStableMaps(store, "stable", root, songs)).rejects.toThrow(); expect(store.mapCandidates(md5)).toEqual(previous);
  await writeFile(join(root, "osu!.db"), database("New")); const abort = new AbortController();
  await expect(indexStableMaps(store, "stable", root, songs, { signal: abort.signal, checkpoint: async () => { abort.abort(); } })).rejects.toThrow(/abort/i);
  expect(store.mapCandidates(md5)).toEqual(previous);
});
