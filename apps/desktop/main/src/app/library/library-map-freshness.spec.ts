import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { LibraryService } from "./library-service";
import { indexStableMaps } from "./sources/stable-maps-source";

let root: string, songs: string, service: LibraryService;
const md5 = "a".repeat(32);
const int = (value: number) => { const b = Buffer.alloc(4); b.writeInt32LE(value); return b; };
const float = (value: number) => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b; };
const double = (value: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(value); return b; };
const text = (value: string) => value ? Buffer.concat([Buffer.from([11, Buffer.byteLength(value)]), Buffer.from(value)]) : Buffer.from([0]);
function database(file = "map.osu") {
  const row = Buffer.concat([
    ...["Artist", "", "Title", "", "Mapper", "Diff", "song.mp3", md5, file].map(text), Buffer.from([2]), Buffer.alloc(14),
    float(9), float(4), float(5), float(8), double(1.4), int(-1), int(-1), int(-1), int(-1), int(120), int(140000), int(-1), int(0),
    int(-1), int(24), int(0), Buffer.alloc(6), float(0.7), Buffer.from([0]), text(""), text(""), Buffer.alloc(2), text(""),
    Buffer.from([1]), Buffer.alloc(8), Buffer.from([0]), text("Mapset"), Buffer.alloc(8), Buffer.alloc(5), int(0), Buffer.from([0]),
  ]);
  return Buffer.concat([int(20260924), int(1), Buffer.from([0]), Buffer.alloc(8), text("Player"), int(1), row, int(1)]);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hindsight-map-freshness-")); songs = join(root, "Songs"); await mkdir(songs);
  await writeFile(join(root, "osu!.db"), database()); await writeFile(join(root, "scores.db"), Buffer.concat([int(20200101), int(0)]));
  service = await LibraryService.open({ directory: join(root, "owned"), sessionId: "map-freshness", nativeExecutable: join(root, "unused.exe"),
    sources: [{ id: "stable", kind: "stable", directory: root, songsRoot: songs }] });
});
afterEach(async () => {
  await service?.close(); jest.restoreAllMocks();
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture root");
  await rm(root, { recursive: true, force: true });
});

it("carries automatic check through the real service adapter but keeps explicit and watcher refresh global", async () => {
  const store = service["store"], notify = new Map<string, () => void>();
  jest.spyOn(service["sourceWatch"], "factory").mockImplementation((path, _recursive, changed) => {
    notify.set(path, () => changed("change", "scores.db")); return { close: () => undefined, on: () => undefined };
  });
  await indexStableMaps(store, "stable", root, songs);
  const before = store.openMapCandidates(md5), revision = store.resourceRevision(), changes = jest.fn();
  service.onLibraryChanged(changes); service.startUpdates(); await service.idle();
  expect(service.status().sources.find(s => s.sourceId === "stable")?.state).toBe("complete");
  expect(store.openMapCandidates(md5)).toEqual(before); expect(store.resourceRevision()).toBe(revision);
  expect(changes.mock.calls.every(([event]) => event.resourceRevision === revision)).toBe(true);

  service.scan("stable"); await service.idle();
  const refreshed = store.openMapCandidates(md5).items[0];
  expect(refreshed.generation).not.toBe(before.items[0].generation);
  expect(store.currentChangesSince(revision).scope).toBe("all");
  expect(changes.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({ resourceChanges: expect.objectContaining({ scope: "all" }) }));

  const explicitRevision = store.resourceRevision(); notify.get(root)?.(); await service.idle();
  expect(store.openMapCandidates(md5).items[0].generation).not.toBe(refreshed.generation);
  expect(store.currentChangesSince(explicitRevision).scope).toBe("all");
});

it("keeps an automatic changed catalog globally invalidating", async () => {
  const store = service["store"];
  jest.spyOn(service["sourceWatch"], "factory").mockImplementation(() => ({ close: () => undefined, on: () => undefined }));
  await indexStableMaps(store, "stable", root, songs);
  const revision = store.resourceRevision(); await writeFile(join(root, "osu!.db"), database("new-map.osu"));
  service.startUpdates(); await service.idle();
  expect(store.openMapCandidates(md5).items[0].locator).toBe(join(songs, "Mapset", "new-map.osu"));
  expect(store.currentChangesSince(revision).scope).toBe("all");
});
