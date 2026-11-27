import { stat } from "fs/promises";
import { extname, isAbsolute, join, resolve } from "path";
import { setImmediate } from "timers/promises";
import { parseReplayHeader } from "@rewind/osu-local/osr-reader";
import type { SavedScoreSourceResult } from "../../../../../../libs/osu/core/src/replays/SavedScoreTimeline";
import type { LibraryConsumedOrigin } from "../../../../shared/library-analysis";
import type { LibraryIncidentEvidenceReceipt } from "../../../../shared/library-incidents";
import type { LibraryOpenLocation, LibraryLocationRefresh } from "./library-store";
import type { LibraryOriginLookup } from "./library-selected-resources";
import { readOptionalSavedScore, savedScoreFileIdentity } from "../saved-score-source";
import { readVerifiedLibraryResource } from "./library-resource-reader";
import { assertSourceUnchanged } from "./sources/source-file";
import { matchesSavedScore } from "./sources/stable-scores-source";
import { projectLibraryIncidentEvidence } from "./library-incidents-evidence";

export interface LibraryIncidentEvidenceProbe {
  evidence: LibraryIncidentEvidenceReceipt;
  observation: LibraryLocationRefresh;
  origin: LibraryConsumedOrigin;
  scope: "stable-sidecar" | "unsupported-profile";
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** At most two exact candidate pairs. Paths and stamps remain inside this short-lived utility. */
function evidencePaths(locator: string, replay: Buffer, configured?: string): string[] {
  const paths = new Map<string, string>();
  const add = (path: string) => paths.set(resolve(path).toLowerCase(), path);
  if (extname(locator).toLowerCase() === ".osr") add(locator.slice(0, -4) + ".osg");
  if (configured) {
    const identity = savedScoreFileIdentity(replay);
    if (identity) {
      const base = join(configured, "Data", "r", `${identity.mapMd5}-${identity.fileTime}`);
      add(base + ".osg"); add(base + ".osr");
    }
  }
  return [...paths.values()];
}
async function pathStamp(path: string): Promise<string> {
  try {
    const value = await stat(path, { bigint: true });
    return [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].map(item => item.toString()).join(":");
  } catch (error) {
    // Optional absence/read failure remains distinct in readOptionalSavedScore. A changed
    // state during discovery is still refused, including inaccessible -> readable.
    const code = (error as NodeJS.ErrnoException).code;
    if (!code) throw error;
    return "error:" + code;
  }
}

/** Fresh receipt only: no frame decoding, map read, simulation, native lookup or persistent graph.
 * The caller must CAS the selected location, current origin and freshness epoch after this drains. */
export async function probeLibraryIncidentEvidence(ticket: LibraryOpenLocation, signal?: AbortSignal,
  readOrigin?: LibraryOriginLookup, checkpoint: () => Promise<void> = () => setImmediate()): Promise<LibraryIncidentEvidenceProbe> {
  const check = async () => { signal?.throwIfAborted(); await checkpoint(); signal?.throwIfAborted(); };
  await check();
  if (!ticket || typeof ticket.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ticket.sha256) ||
    !isAbsolute(ticket.locator) || !isAbsolute(ticket.directory) || !record(ticket.metadata))
    throw new Error("Incident evidence requires an exact replay identity and location");
  const resource = await readVerifiedLibraryResource(ticket.locator, { sha256: ticket.sha256, maxBytes: 128 * 1024 * 1024 }, signal, check);
  const header = parseReplayHeader(resource.bytes);
  if (ticket.kind === "stable") {
    const saved = ticket.metadata.savedScore;
    if (!record(saved) || saved.sourceKey !== ticket.sourceKey || !matchesSavedScore(saved.header, header))
      throw new Error("Stable saved score does not establish incident evidence binding");
  }
  const origin = await readOrigin?.(resource.sha256, signal, check) ?? null;
  await check();
  if (origin !== null && (!record(origin) || !["stable", "lazer"].includes(origin.client) || origin.provenance !== "user-confirmed"))
    throw new Error("Invalid incident evidence recording origin");
  const raw = ticket.metadata.nativeScore;
  let native = false;
  if (ticket.kind === "lazer" && raw !== undefined) {
    if (!record(raw) || raw.id !== ticket.sourceKey || typeof raw.isLegacyScore !== "boolean" || raw.ruleset !== header.mode ||
      !record(raw.replay) || raw.replay.sha256 !== resource.sha256 ||
      record(raw.beatmap) && raw.beatmap.md5 !== undefined && raw.beatmap.md5 !== header.beatmapMD5)
      throw new Error("Native incident evidence binding is unavailable or contradictory");
    native = raw.isLegacyScore === false;
  }
  if (ticket.kind === "lazer" && raw === undefined && header.sourceFormat !== "lazer" && !origin)
    throw new Error("Native source recording profile is unavailable");
  const unsupported = header.mode !== 0 || header.sourceFormat === "lazer" || native || origin?.client === "lazer";
  if (ticket.analysisRequiresNative && !unsupported) throw new Error("Known native incident profile could not be reverified");
  let source: SavedScoreSourceResult;
  if (unsupported) source = { status: "unavailable", reason: "unsupported-profile", attempts: [] };
  else {
    const configured = ticket.kind === "stable" ? ticket.directory : undefined;
    const paths = evidencePaths(ticket.locator, resource.bytes, configured), before: string[] = [];
    for (const path of paths) { before.push(await pathStamp(path)); await check(); }
    source = await readOptionalSavedScore(ticket.locator, resource.bytes, {
      gameMode: header.mode, gameVersion: header.version, beatmapMD5: header.beatmapMD5,
      replayContentSha256: resource.sha256, number_300s: header.counts.great, number_100s: header.counts.ok,
      number_50s: header.counts.meh, gekis: header.counts.geki, katus: header.counts.katu, misses: header.counts.miss,
      score: header.score, max_combo: header.maxCombo,
      ...(origin ? { sourceClient: origin.client, sourceProvenance: origin.provenance } : {}),
    }, configured, { signal, checkpoint: check });
    for (let index = 0; index < paths.length; index++) {
      await check(); if (await pathStamp(paths[index]) !== before[index]) throw new Error("Incident evidence changed during discovery");
    }
  }
  await check(); await assertSourceUnchanged(ticket.locator, resource.stamp); signal?.throwIfAborted();
  const evidence = projectLibraryIncidentEvidence(source, { replaySha256: resource.sha256, mapMd5: header.beatmapMD5 });
  const metadata = { ...ticket.metadata, header, stamp: resource.stamp, fileState: "readable", validation: "header-only" };
  if (Buffer.byteLength(JSON.stringify(metadata)) > 64 * 1024) throw new Error("Incident evidence observation exceeds metadata budget");
  return { evidence, observation: { sha256: resource.sha256, available: true, locator: ticket.locator, metadata }, origin,
    scope: unsupported ? "unsupported-profile" : "stable-sidecar" };
}
