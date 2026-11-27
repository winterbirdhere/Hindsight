import { opendir, realpath } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { parseReplayHeader, readWithDecompressor } from "@rewind/osu-local/osr-reader";
import type { ReplayBlockDecoder } from "@rewind/osu-local/osr-reader";
import type { LibraryReplayData } from "../../../../shared/library-replay-data";
import { isLosslessLibraryJson } from "../../../../shared/library-json";
import type { LibraryLocationRefresh, LibraryOpenLocation, LibraryOpenMap } from "./library-store";
import type { LazerResource, LazerSource, LazerSourceScore } from "./sources/lazer-source";
import { readVerifiedLibraryResource } from "./library-resource-reader";
import { readOptionalSavedScore } from "../saved-score-source";
import { matchesSavedScore } from "./sources/stable-scores-source";
import { LibraryAssetUnavailableError } from "./library-resource-errors";
import { setImmediate } from "timers/promises";

const FRAME_BYTES = 32 * 1024 * 1024;
type NativeLookup = Pick<LazerSource, "resolveScore" | "resolveProvisionalScore">;
type Resource = Awaited<ReturnType<typeof readVerifiedLibraryResource>>;
export type LibraryOriginLookup = (sha256: string, signal?: AbortSignal, checkpoint?: () => Promise<void>) => Promise<{ client: "stable" | "lazer"; provenance: "user-confirmed" } | undefined>;
export interface PreparedLibraryReplay {
  ticket: LibraryOpenLocation;
  data: LibraryReplayData;
  receipt: LibraryLocationRefresh;
  nativeScore?: LazerSourceScore;
}
export interface PreparedLibraryMap {
  map: Resource;
  ticket?: LibraryOpenMap;
  storyboards: string[];
  assetManifestComplete: boolean;
  readAsset(name: string, signal?: AbortSignal): Promise<Resource>;
}

function usable(resource?: LazerResource): resource is LazerResource & { path: string; sha256: string } {
  return !!resource?.path && !!resource.sha256 && ["available", "unverified"].includes(resource.status);
}

/** Runs in an owned resource utility. Numerical background work needs no saved cause sidecar. */
export async function prepareLibraryReplay(ticket: LibraryOpenLocation, native: NativeLookup,
  decode: ReplayBlockDecoder, signal?: AbortSignal, readOrigin?: LibraryOriginLookup,
  checkpoint: () => Promise<void> = () => setImmediate(), options: {savedCauseEvidence?:boolean;includeAssets?:boolean} = {}): Promise<PreparedLibraryReplay> {
  signal?.throwIfAborted();
  await checkpoint(); signal?.throwIfAborted();
  let nativeScore: LazerSourceScore | undefined, schemaFingerprint: string | undefined;
  let locator = ticket.locator, expected = ticket.sha256 ?? undefined;
  if (ticket.kind === "lazer") {
    const selection = { includeAssets: options.includeAssets !== false };
    const result = ticket.sha256 === null ? await native.resolveProvisionalScore(ticket.directory, ticket.sourceKey, signal, selection)
      : await native.resolveScore(ticket.directory, ticket.sourceKey, ticket.sha256, signal, selection);
    await checkpoint(); signal?.throwIfAborted();
    if (!result.ok || result.scores?.length !== 1 || result.scores[0].id !== ticket.sourceKey || !result.schemaFingerprint)
      throw new Error("Native selected replay: " + result.status);
    nativeScore = result.scores[0]; schemaFingerprint = result.schemaFingerprint;
    if (!usable(nativeScore.replay)) throw new Error("Native replay resource: " + nativeScore.replay.status);
    if (expected && expected !== nativeScore.replay.sha256) throw new Error("Native selected replay identity changed");
    locator = nativeScore.replay.path; expected = nativeScore.replay.sha256;
  }
  if (!isAbsolute(locator)) throw new Error("Invalid selected replay locator");
  const resource = await readVerifiedLibraryResource(locator, { sha256: expected, maxBytes: 128 * 1024 * 1024 }, signal, checkpoint);
  const header = parseReplayHeader(resource.bytes);
  if (ticket.kind === "stable") {
    const saved = ticket.metadata.savedScore as { sourceKey?: string; header?: unknown } | undefined;
    if (!saved || saved.sourceKey !== ticket.sourceKey || !matchesSavedScore(saved.header, header))
      throw new Error("Stable saved score does not establish the selected replay cache binding");
  }
  if (nativeScore?.beatmap.md5 && nativeScore.beatmap.md5 !== header.beatmapMD5) throw new Error("Native source map disagrees with replay header");
  await checkpoint(); signal?.throwIfAborted();
  const decoded = await readWithDecompressor(resource.bytes, decode, { signal, maxFrameBytes: FRAME_BYTES, maxScoreInfoBytes: 1024 * 1024 });
  await checkpoint(); signal?.throwIfAborted();
  if (![decoded.lazerMods, decoded.lazerScoreInfo, nativeScore?.mods].every(isLosslessLibraryJson))
    throw new Error("Native replay metadata cannot be represented without loss");
  if (decoded.gameMode !== 0) throw new Error("Only osu!standard replays are supported");
  const data: LibraryReplayData = {
    gameMode: decoded.gameMode, gameVersion: decoded.gameVersion, beatmapMD5: header.beatmapMD5, playerName: decoded.playerName,
    replayMD5: decoded.replayMD5, number_300s: decoded.number_300s, number_100s: decoded.number_100s, number_50s: decoded.number_50s,
    misses: decoded.misses, score: decoded.score, max_combo: decoded.max_combo, perfect_combo: decoded.perfect_combo, mods: decoded.mods,
    life_bar: decoded.life_bar, replay_data: decoded.replay_data, lazerMods: decoded.lazerMods, lazerScoreInfo: decoded.lazerScoreInfo,
    replayContentSha256: resource.sha256,
    // node-osr actually emits Date despite its historical number declaration. Preserve epoch time over JSON.
    ...(Number.isFinite(Number(decoded.timestamp)) ? { timestamp: Number(decoded.timestamp) } : {}),
    ...(nativeScore ? { nativeSource: { scoreId: nativeScore.id, isLegacyScore: nativeScore.isLegacyScore,
      schemaFingerprint: schemaFingerprint!, mods: nativeScore.mods } } : {}),
  };
  const origin = await readOrigin?.(resource.sha256,signal,checkpoint);
  await checkpoint(); signal?.throwIfAborted();
  if (origin?.provenance === "user-confirmed" && ["stable", "lazer"].includes(origin.client)) {
    data.sourceClient = origin.client; data.sourceProvenance = origin.provenance;
  }
  if(options.savedCauseEvidence!==false)try {
    data.savedScoreSource = nativeScore && !nativeScore.isLegacyScore ? { status: "unavailable", reason: "unsupported-profile", attempts: [] }
      : await readOptionalSavedScore(locator, resource.bytes, { ...decoded, replayContentSha256: resource.sha256,
        sourceClient: data.sourceClient, sourceProvenance: data.sourceProvenance }, ticket.kind === "stable" ? ticket.directory : undefined, { signal });
  } catch {
    signal?.throwIfAborted();
    data.savedScoreSource = { status: "unavailable", reason: "saved-score-read-failed", attempts: [] };
  }
  await checkpoint(); signal?.throwIfAborted();
  let metadata: Record<string, unknown> = { ...ticket.metadata,
    // Full assets remain in this foreground session. Persist only scan-sized score evidence;
    // a large valid manifest must not evict observed score/header metrics from the index.
    ...(nativeScore ? { nativeScore: { ...nativeScore, assets: [], assetManifestComplete: false },
      schemaFingerprint, assetManifestState: "not-enumerated" } : {}),
    header, stamp: resource.stamp, fileState: "readable", validation: "header-only" };
  if (Buffer.byteLength(JSON.stringify(metadata)) > 64 * 1024)
    metadata = { stamp: resource.stamp, fileState: "readable", validation: "header-only", metadataState: "resource-limit" };
  return { ticket, data, nativeScore, receipt: { sha256: resource.sha256, locator, available: true, metadata } };
}

function assetName(value: string): string {
  const name = value.replace(/\\/g, "/");
  if (!name || name.length > 512 || /[<>:"|?*]/.test(name) || [...name].some(char => char.charCodeAt(0) < 32) ||
      name.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new Error("Invalid map asset name");
  return name;
}
async function withinRoot(root: string, file: string, optional = false): Promise<string> {
  const actualRoot = await realpath(root);
  let actualFile: string;
  try { actualFile = await realpath(file); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") {
      if (await realpath(root) !== actualRoot) throw new Error("Map asset directory changed");
      throw new LibraryAssetUnavailableError("Map asset is absent");
    }
    throw error;
  }
  const fromRoot = relative(actualRoot, actualFile);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(".." + sep)) throw new Error("Map asset escapes its source directory");
  return actualFile;
}

export async function prepareLibraryMap(replay: PreparedLibraryReplay, candidate?: LibraryOpenMap, signal?: AbortSignal,
  checkpoint: () => Promise<void> = () => setImmediate()): Promise<PreparedLibraryMap> {
  await checkpoint(); signal?.throwIfAborted();
  const native = replay.nativeScore;
  if (!candidate && native && usable(native.beatmap)) {
    const map = await readVerifiedLibraryResource(native.beatmap.path, { sha256: native.beatmap.sha256,
      md5: replay.data.beatmapMD5, maxBytes: 16 * 1024 * 1024 }, signal, checkpoint);
    const assets = new Map(native.assets.map(asset => [asset.name.toLowerCase(), asset]));
    signal?.throwIfAborted();
    return { map, assetManifestComplete: native.assetManifestComplete === true,
      storyboards: native.assets.filter(asset => asset.name.toLowerCase().endsWith(".osb")).map(asset => asset.name).sort(),
      readAsset: async (name, cancellation) => {
        cancellation?.throwIfAborted();
        const asset = assets.get(assetName(name).toLowerCase());
        if ((!asset && native.assetManifestComplete === true) || asset?.resource.status === "missing")
          throw new LibraryAssetUnavailableError("Native map asset is absent");
        if (!asset || !usable(asset.resource)) throw new Error("Native map asset could not be verified");
        return readVerifiedLibraryResource(asset.resource.path, { sha256: asset.resource.sha256, maxBytes: 128 * 1024 * 1024 }, cancellation);
      } };
  }
  if (!candidate || candidate.md5 !== replay.data.beatmapMD5 || typeof candidate.metadata.songsRoot !== "string" || !isAbsolute(candidate.metadata.songsRoot))
    throw new Error("Matching beatmap is unavailable");
  const path = await withinRoot(candidate.metadata.songsRoot, candidate.locator);
  const map = await readVerifiedLibraryResource(path, { md5: replay.data.beatmapMD5, maxBytes: 16 * 1024 * 1024 }, signal, checkpoint);
  const folder = dirname(path);
  const storyboards: string[] = []; let entries = 0;
  for await (const entry of await opendir(folder)) {
    signal?.throwIfAborted();
    if (++entries > 8192) throw new Error("Map asset directory exceeds resource limit");
    if (entries % 128 === 0) await checkpoint();
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".osb")) storyboards.push(assetName(entry.name));
  }
  storyboards.sort();
  signal?.throwIfAborted();
  return { map, ticket: candidate, storyboards, assetManifestComplete: true,
    readAsset: async (name, cancellation) => {
      cancellation?.throwIfAborted();
      const path = await withinRoot(folder, resolve(join(folder, assetName(name))), true);
      return readVerifiedLibraryResource(path, { maxBytes: 128 * 1024 * 1024 }, cancellation);
    } };
}
