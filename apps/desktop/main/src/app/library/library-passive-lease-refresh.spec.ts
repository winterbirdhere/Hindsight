import { createHash } from "crypto";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, relative, isAbsolute } from "path";
import { LibraryStore, LibraryLocationTicket, LibraryMapTicket } from "./library-store";
import { createLibraryPassiveSelector } from "./library-passive-selector";
import { LibraryPassiveResources } from "./library-passive-resources";
import { LibraryPassiveResourceApi } from "./library-passive-resource-api";
import {
  LibraryPassiveResourceClient,
  retainLibraryPassiveResourceSnapshot,
} from "../../../../frontend/src/app/services/library/library-passive-resource-client";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0RkAAAAASUVORK5CYII=", "base64");
const hash = (bytes: Buffer, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("passive artwork across an indexed observation refresh", () => {
  let root: string;
  let store: LibraryStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rewind-passive-lease-refresh-"));
    store = new LibraryStore(join(root, "library.sqlite"), "passive-lease-refresh");
  });

  afterEach(async () => {
    store?.close();
    const rel = relative(tmpdir(), root);
    if (!rel.startsWith("rewind-passive-lease-refresh-") || isAbsolute(rel) || rel.includes(".."))
      throw Error("Unexpected passive lease fixture path");
    await rm(root, { recursive: true, force: true });
  });

  it.each(["identical", "changed-locator"] as const)(
    "retains only a still-current image after an %s observation during revalidation",
    async mode => {
      const songsRoot = join(root, "Songs"), mapFolder = join(songsRoot, "map");
      await mkdir(mapFolder, { recursive: true });
      const mapPath = join(mapFolder, "map.osu"), replayPath = join(root, "fixture.osr");
      const mapBytes = Buffer.from('osu file format v14\n[Events]\n0,0,"bg.png",0,0\n[HitObjects]\n');
      const replayBytes = Buffer.from("synthetic indexed replay identity; never decoded");
      await writeFile(mapPath, mapBytes);
      await writeFile(join(mapFolder, "bg.png"), png);
      await writeFile(replayPath, replayBytes);
      store.registerSource({ id: "stable", kind: "stable", directory: root });
      const mapGeneration = store.beginMapScan("stable"), md5 = hash(mapBytes, "md5");
      store.upsertMap({ sourceId: "stable", sourceKey: "map", generation: mapGeneration, md5,
        locator: mapPath, state: "unverified", metadata: { songsRoot } });
      store.finishMapScan("stable", mapGeneration);
      const observation = { sourceId: "stable", sourceKey: "replay", generation: store.beginScan("stable"),
        locator: replayPath, sha256: hash(replayBytes), available: true, addedAt: 1,
        metadata: { header: { beatmapMD5: md5 } } };
      const replayId = store.upsertObservation(observation);

      // Use the real selector's lease and all three reader current() checkpoints.
      // No query client, source worker, native helper, Electron decoder or real profile is involved.
      const selector = createLibraryPassiveSelector({
        metadata: async (method, args) => {
          if (method === "prepare-open") return store.openLocationCandidates(String(args.replayId));
          if (method === "prepare-map") return store.openMapCandidates(String(args.md5));
          if (method === "resource-current")
            return store.resourceLeaseCurrent(args.location as LibraryLocationTicket, args.map as LibraryMapTicket | undefined);
          throw Error("Unexpected passive metadata operation: " + method);
        },
        createNative: () => { throw Error("Stable artwork must not start a native owner"); },
      });
      const entered = gate(), resume = gate(), failures: Error[] = [], created: string[] = [], revoked: string[] = [];
      let thumbnailReads = 0,currentChecks=0;
      const reader = new LibraryPassiveResources({
        ...selector,
        isCurrent:async selection=>{
          if(++currentChecks===4){entered.resolve();await resume.promise;}
          return selector.isCurrent(selection);
        },
        thumbnail: async bytes => {
          thumbnailReads++;
          return bytes;
        },
      });
      const api = new LibraryPassiveResourceApi(reader, () => { throw Error("Artwork must not Reveal"); });
      const client = new LibraryPassiveResourceClient({
        resource: async request => {
          try { return await api.receive(request, () => undefined); }
          catch (error) { failures.push(error as Error); throw error; }
        },
      }, {
        create: bytes => {
          expect(Buffer.from(bytes)).toEqual(png);
          const url = `blob:passive-lease-${created.length + 1}`;
          created.push(url); return url;
        },
        revoke: url => { revoked.push(url); },
      });
      let releaseRender: () => void = () => undefined;
      let pending: ReturnType<LibraryPassiveResourceClient["update"]> | undefined;
      try {
        const first = await client.update({ artworkIds: [replayId] });
        expect(first[replayId]).toEqual({ artUrl: "blob:passive-lease-1" });
        releaseRender = retainLibraryPassiveResourceSnapshot(first);
        const location = store.openLocationCandidates(replayId).items[0];
        const resourceRevision = store.resourceRevision();

        client.invalidate({ artwork: true, strip: false, preserveArtwork: true });
        pending = client.update({ artworkIds: [replayId] });
        await Promise.race([entered.promise, pending.then(() => { throw Error("Revalidation did not reach the source-currentness gate"); })]);
        expect(created).toEqual(["blob:passive-lease-1"]);
        expect(revoked).toEqual([]);
        expect(store.upsertObservation({ ...observation,
          ...(mode === "changed-locator" ? { locator: join(root, "replacement.osr") } : {}),
        })).toBe(replayId);
        const after = store.openLocationCandidates(replayId).items[0];
        resume.resolve();
        const displayed = await pending;

        if (mode === "identical") {
          expect({
            displayed,
            locationRevision: after.locationRevision,
            resourceRevision: store.resourceRevision(),
            failures: failures.map(error => error.message),
          }).toEqual({
            displayed: first,
            locationRevision: location.locationRevision,
            resourceRevision,
            failures: [],
          });
          expect(created).toEqual(["blob:passive-lease-1"]);
        } else {
          expect(after.locationRevision).toBeGreaterThan(location.locationRevision);
          expect(store.resourceRevision()).not.toBe(resourceRevision);
          expect(displayed[replayId]).toEqual({ artworkError: "Artwork could not be verified" });
          expect(failures).toHaveLength(1);
          expect(failures[0].message).toMatch(/outcome=unclassified-failure abortRequested=false/);
          expect(created).toEqual(["blob:passive-lease-1"]);
        }
        // A committed old render still owns its URL, including after a genuine stale rejection.
        expect(revoked).toEqual([]);
        releaseRender();
        expect(revoked).toEqual(mode === "identical" ? [] : ["blob:passive-lease-1"]);
        expect(thumbnailReads).toBe(1);
      } finally {
        resume.resolve();
        await pending?.catch(() => undefined);
        releaseRender();
        await client.dispose();
        await api.close();
      }
      expect(revoked).toEqual(["blob:passive-lease-1"]);
    },
  );
});
