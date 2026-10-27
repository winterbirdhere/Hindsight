import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { createHash } from "crypto";
import { decompress } from "lzma";
import { OsrReplay, ReplayBlockDecoder, parseReplayHeader } from "@rewind/osu-local/osr-reader";
import type { LibraryOpenLocation, LibraryOpenMap } from "./library-store";
import type { LazerSource, LazerSourceInspection } from "./sources/lazer-source";
import { prepareLibraryReplay, prepareLibraryMap } from "./library-selected-resources";
import { LibraryAssetUnavailableError } from "./library-resource-errors";
import * as savedScoreSource from "../saved-score-source";

let root: string, replayBytes: Buffer, ticket: LibraryOpenLocation, map: LibraryOpenMap;
const mapBytes = Buffer.from("osu file format v14\n[General]\nAudioFilename: audio.mp3\n[Metadata]\nTitle:Fixture\n");
const hash = (bytes: Buffer, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const decode: ReplayBlockDecoder = async bytes => Buffer.from(decompress(bytes));
const unusedNative: Pick<LazerSource, "resolveScore" | "resolveProvisionalScore"> = {
  resolveScore: async () => { throw Error("Unexpected native lookup"); }, resolveProvisionalScore: async () => { throw Error("Unexpected provisional lookup"); },
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hindsight-selected-")); await mkdir(join(root, "Songs"));
  const replay = new OsrReplay(); Object.assign(replay, { gameVersion: 20260101, gameMode: 0, beatmapMD5: hash(mapBytes, "md5"),
    playerName: "Fixture", replayMD5: "a".repeat(32), replay_data: "0|256|-500|0,1000|10|20|1,0|11|21|0,", timestamp: new Date(1700000000000) });
  replayBytes = replay.serializeSync(); await writeFile(join(root, "replay.osr"), replayBytes);
  await writeFile(join(root, "Songs", "map.osu"), mapBytes); await writeFile(join(root, "Songs", "audio.mp3"), "fixture-media");
  await writeFile(join(root, "Songs", "story.osb"), "[Events]\n");
  ticket = { replayId: "id", sourceId: "replays", sourceKey: "file", locator: join(root, "replay.osr"), sha256: hash(replayBytes),
    locationRevision: 1, sourceConfigRevision: 2, kind: "replays", directory: root, metadata: {} };
  map = { sourceId: "stable", sourceConfigRevision: 3, generation: "generation", sourceKey: "map", md5: hash(mapBytes, "md5"),
    locator: join(root, "Songs", "map.osu"), kind: "stable", directory: root, metadata: { songsRoot: join(root, "Songs") } };
});
afterEach(async () => { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture root"); await rm(root, { recursive: true, force: true }); });

it("skips saved cause I/O for background numerical resources and preserves foreground evidence",async()=>{
  const read=jest.spyOn(savedScoreSource,"readOptionalSavedScore").mockResolvedValue({status:"absent",attempts:[]});
  try{
    const background=await prepareLibraryReplay(ticket,unusedNative,decode,undefined,undefined,undefined,{savedCauseEvidence:false});
    expect(read).not.toHaveBeenCalled();expect(background.data).not.toHaveProperty("savedScoreSource");
    const foreground=await prepareLibraryReplay(ticket,unusedNative,decode);
    expect(read).toHaveBeenCalledTimes(1);expect(foreground.data.savedScoreSource).toEqual({status:"absent",attempts:[]});
    const {savedScoreSource:_saved,...data}=foreground.data;expect(background.data).toEqual(data);expect(background.receipt).toEqual(foreground.receipt);
  }finally{read.mockRestore();}
});

it("prepares verified file replay/map/media without copying originals and preserves JSON timestamp", async () => {
  const replay = await prepareLibraryReplay(ticket, unusedNative, decode);
  expect(replay.data.timestamp).toBe(1700000000000);
  expect(JSON.parse(JSON.stringify(replay.data)).timestamp).toBe(1700000000000);
  expect(replay.data.replayContentSha256).toBe(ticket.sha256);
  const resources = await prepareLibraryMap(replay, map);
  expect(resources.map.bytes).toEqual(mapBytes);
  expect(resources.storyboards).toEqual(["story.osb"]);
  expect((await resources.readAsset("audio.mp3")).bytes.toString()).toBe("fixture-media");
  await expect(resources.readAsset("../replay.osr")).rejects.toThrow(/asset/i);
  expect(await readFile(ticket.locator)).toEqual(replayBytes);
});

it("rejects changed replay or wrong-map bytes before publishing selected resources", async () => {
  await expect(prepareLibraryReplay({ ...ticket, sha256: "f".repeat(64) }, unusedNative, decode)).rejects.toThrow(/digest/i);
  const replay = await prepareLibraryReplay(ticket, unusedNative, decode);
  await writeFile(map.locator, "changed map");
  await expect(prepareLibraryMap(replay, map)).rejects.toThrow(/digest/i);
});

it("normalizes a valid uppercase replay map hash at the selected resource boundary", async () => {
  const source = new OsrReplay(); Object.assign(source, { gameVersion: 20260101, gameMode: 0, beatmapMD5: hash(mapBytes, "md5").toUpperCase(),
    replay_data: "0|1|2|0,", timestamp: new Date(1700000000000) });
  const bytes = source.serializeSync(); await writeFile(ticket.locator, bytes);
  const replay = await prepareLibraryReplay({ ...ticket, sha256: hash(bytes) }, unusedNative, decode);
  expect(replay.data.beatmapMD5).toBe(map.md5);
  expect((await prepareLibraryMap(replay, map)).map.md5).toBe(map.md5);
});

it("distinguishes a Stable missing leaf from a vanished map folder", async () => {
  const replay = await prepareLibraryReplay(ticket, unusedNative, decode), resources = await prepareLibraryMap(replay, map);
  await expect(resources.readAsset("absent.wav")).rejects.toBeInstanceOf(LibraryAssetUnavailableError);
  await rename(join(root, "Songs"), join(root, "MovedSongs"));
  await expect(resources.readAsset("absent.wav")).rejects.not.toBeInstanceOf(LibraryAssetUnavailableError);
});

it("does not classify a folder lost between root and leaf resolution as optional absence", async () => {
  const replay = await prepareLibraryReplay(ticket, unusedNative, decode), resources = await prepareLibraryMap(replay, map);
  const fs = jest.requireActual<typeof import("fs/promises")>("fs/promises"), original = fs.realpath;
  let moved = false;
  const replacement = async (path: string) => {
    const result = await original(path);
    if (!moved && path === join(root, "Songs")) { moved = true; await rename(path, join(root, "MovedSongs")); }
    return result;
  };
  const spy = jest.spyOn(fs, "realpath").mockImplementation(replacement as typeof fs.realpath);
  try { await expect(resources.readAsset("absent.wav")).rejects.not.toBeInstanceOf(LibraryAssetUnavailableError); }
  finally { spy.mockRestore(); }
});

it("uses an explicitly verified Stable map after a declared native resource becomes unavailable", async () => {
  const replay = await prepareLibraryReplay(ticket, unusedNative, decode);
  replay.nativeScore = { id: "guid", playedAtTicks: "1", player: "Fixture", ruleset: 0, clientVersion: "test", isLegacyScore: false,
    maxCombo: 1, accuracy: 1, rank: 0, pp: null, mods: [], statistics: null, maximumStatistics: null, replay: { status: "missing" },
    beatmap: { status: "unverified", path: join(root, "vanished-map"), sha256: hash(mapBytes), md5: map.md5, bytes: mapBytes.length },
    assets: [], assetManifestComplete: true };
  await expect(prepareLibraryMap(replay)).rejects.toThrow(/ENOENT/);
  const fallback = await prepareLibraryMap(replay, map);
  expect(fallback.map.bytes).toEqual(mapBytes); expect(fallback.ticket).toEqual(map);
  expect((await fallback.readAsset("audio.mp3")).bytes.toString()).toBe("fixture-media");
});

it("refuses a Stable cache conflict or missing saved binding before admitting frame decoding", async () => {
  const header = parseReplayHeader(replayBytes);
  const forbidden: ReplayBlockDecoder = async () => { throw Error("Decoder should not run"); };
  for (const metadata of [{}, { savedScore: { sourceKey: ticket.sourceKey, header: { ...header, player: "Another score" } } }]) {
    await expect(prepareLibraryReplay({ ...ticket, kind: "stable", sha256: null, metadata }, unusedNative, forbidden))
      .rejects.toThrow(/saved score/i);
  }
  const prepared = await prepareLibraryReplay({ ...ticket, kind: "stable", sha256: null,
    metadata: { savedScore: { sourceKey: ticket.sourceKey, header } } }, unusedNative, decode);
  expect(prepared.receipt.sha256).toBe(ticket.sha256);
});

it("carries exact-byte confirmed origins before optional saved-score admission", async () => {
  const prepared = await prepareLibraryReplay(ticket, unusedNative, decode, undefined, async digest => {
    expect(digest).toBe(ticket.sha256); return { client: "lazer", provenance: "user-confirmed" };
  });
  expect(prepared.data).toMatchObject({ sourceClient: "lazer", sourceProvenance: "user-confirmed",
    savedScoreSource: { status: "unavailable", reason: "unsupported-profile" } });
});

it("resolves provisional native GUIDs and verifies declared bytes for every consumed resource", async () => {
  const id = "a0000000-0000-4000-8000-000000000001"; let known = 0, provisional = 0;
  const result: LazerSourceInspection = { version: 1, ok: true, status: "ready", schemaFingerprint: "e".repeat(64), scores: [{
    id, playedAtTicks: "1", player: "Fixture", ruleset: 0, clientVersion: "test", isLegacyScore: true, maxCombo: 2, accuracy: 1, rank: 0,
    pp: null, mods: [], statistics: null, maximumStatistics: null, assetManifestComplete: true,
    replay: { status: "unverified", path: ticket.locator, sha256: ticket.sha256!, bytes: replayBytes.length },
    beatmap: { status: "unverified", path: map.locator, sha256: hash(mapBytes), md5: map.md5, bytes: mapBytes.length },
    assets: [{ name: "audio.mp3", resource: { status: "unverified", path: join(root, "Songs", "audio.mp3"), sha256: hash(Buffer.from("fixture-media")), bytes: 13 } }],
  }] };
  const native = { resolveScore: async () => { known++; return result; }, resolveProvisionalScore: async () => { provisional++; return result; } };
  const nativeTicket = { ...ticket, kind: "lazer" as const, sourceKey: id, sha256: null, locator: "lazer-score:" + id };
  const replay = await prepareLibraryReplay(nativeTicket, native, decode);
  expect(replay.receipt).toMatchObject({ sha256: ticket.sha256, locator: ticket.locator, available: true });
  expect(replay.receipt.metadata).toMatchObject({ nativeScore: { ...result.scores![0], assets: [], assetManifestComplete: false }, schemaFingerprint: result.schemaFingerprint });
  expect(replay.data.nativeSource).toMatchObject({ isLegacyScore: true, scoreId: id });
  const resources = await prepareLibraryMap(replay);
  await expect(resources.readAsset("absent.wav")).rejects.toBeInstanceOf(LibraryAssetUnavailableError);
  const nativeScore = replay.nativeScore!;
  nativeScore.assetManifestComplete = false;
  await expect(resources.readAsset("absent.wav")).rejects.not.toBeInstanceOf(LibraryAssetUnavailableError);
  for (const status of ["missing", "corrupt", "busy", "inaccessible", "invalid", "resource-limit"] as const) {
    nativeScore.assets = [{ name: "test.wav", resource: { status } }];
    const variant = await prepareLibraryMap(replay);
    if (status === "missing") await expect(variant.readAsset("test.wav")).rejects.toBeInstanceOf(LibraryAssetUnavailableError);
    else await expect(variant.readAsset("test.wav")).rejects.not.toBeInstanceOf(LibraryAssetUnavailableError);
  }
  expect((await resources.readAsset("audio.mp3")).bytes.toString()).toBe("fixture-media");
  await writeFile(join(root, "Songs", "audio.mp3"), "replaced");
  await expect(resources.readAsset("audio.mp3")).rejects.toThrow(/digest/i);
  const refreshed = await prepareLibraryReplay({ ...nativeTicket, sha256: ticket.sha256,
    metadata: { nativeScore: { ...result.scores![0], accuracy: 0.2 }, schemaFingerprint: "f".repeat(64) } }, native, decode);
  expect(refreshed.receipt.metadata).toMatchObject({ nativeScore: { ...result.scores![0], assets: [], assetManifestComplete: false }, schemaFingerprint: result.schemaFingerprint });
  expect({ known, provisional }).toEqual({ known: 1, provisional: 1 });
  result.scores![0].assets = Array.from({ length: 1000 }, (_, index) => ({ name: "resource-" + index + ".png",
    resource: { status: "unverified", sha256: "a".repeat(64), path: join(root, "resource-" + index), bytes: 1 } }));
  const large = await prepareLibraryReplay({ ...nativeTicket, sha256: ticket.sha256 }, native, decode);
  expect(Buffer.byteLength(JSON.stringify(large.receipt.metadata))).toBeLessThan(65536);
  expect(large.receipt.metadata).toMatchObject({ header: { beatmapMD5: map.md5 }, nativeScore: { accuracy: 1, assets: [] }, assetManifestState: "not-enumerated" });
  expect(large.nativeScore?.assets).toHaveLength(1000);
  result.scores![0].mods = [{ acronym: "DT", settings: { speed_change: Infinity } }];
  await expect(prepareLibraryReplay({ ...nativeTicket, sha256: ticket.sha256 }, native, decode)).rejects.toThrow(/metadata/i);
});

it.each([false, true])("prepares metadata-only native calculations with byte identity checks, provisional=%s", async provisional => {
  const id = "a0000000-0000-4000-8000-000000000001";
  const result: LazerSourceInspection = { version: 1, ok: true, status: "ready", schemaFingerprint: "e".repeat(64), scores: [{
    id, playedAtTicks: "1", player: "Fixture", ruleset: 0, clientVersion: "test", isLegacyScore: true, maxCombo: 2, accuracy: 1, rank: 0,
    pp: null, mods: [], statistics: null, maximumStatistics: null, assetManifestComplete: false, assets: [],
    replay: { status: "unverified", path: ticket.locator, sha256: ticket.sha256!, bytes: replayBytes.length },
    beatmap: { status: "unverified", path: map.locator, sha256: hash(mapBytes), md5: map.md5, bytes: mapBytes.length },
  }] };
  const native = { resolveScore: jest.fn(async () => result), resolveProvisionalScore: jest.fn(async () => result) };
  const nativeTicket = { ...ticket, kind: "lazer" as const, sourceKey: id, sha256: provisional ? null : ticket.sha256, locator: "lazer-score:" + id };
  const prepare = () => prepareLibraryReplay(nativeTicket, native, decode, undefined, undefined, undefined,
    { savedCauseEvidence: false, includeAssets: false });
  const replay = await prepare();
  const args = provisional ? [ticket.directory, id, undefined, { includeAssets: false }]
    : [ticket.directory, id, ticket.sha256, undefined, { includeAssets: false }];
  expect(provisional ? native.resolveProvisionalScore : native.resolveScore).toHaveBeenCalledWith(...args);
  expect(provisional ? native.resolveScore : native.resolveProvisionalScore).not.toHaveBeenCalled();
  expect(replay.receipt).toMatchObject({ sha256: ticket.sha256, locator: ticket.locator, available: true });
  expect(replay.data.savedScoreSource).toBeUndefined();
  expect((await prepareLibraryMap(replay)).map.sha256).toBe(hash(mapBytes));
  result.scores![0].beatmap.md5 = "f".repeat(32);
  await expect(prepare()).rejects.toThrow(/map disagrees/i);
  result.scores![0].beatmap.md5 = map.md5;
  await writeFile(ticket.locator, Buffer.from("changed replay"));
  await expect(prepare()).rejects.toThrow(/digest/i);
});

it("honours cancellation after decoding without publishing a prepared replay", async () => {
  const controller = new AbortController();
  await expect(prepareLibraryReplay(ticket, unusedNative, async (bytes, request) => {
    const result = await decode(bytes, request); controller.abort(); return result;
  }, controller.signal)).rejects.toThrow(/abort/i);
});
