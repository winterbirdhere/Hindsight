import { stat } from "fs/promises";
import { join } from "path";
import { setImmediate } from "timers/promises";
import { parseLibraryScoreEvents } from "@rewind/osu-local/db-reader/library-scores";
import type { LibrarySavedScore } from "@rewind/osu-local/db-reader/library-scores";
import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";
import { inspectReplayFile } from "./replay-file";
import { assertSourceUnchanged, readSourceDatabase, sameSourceStamp, sourceStamp } from "./source-file";
import type { FileSourceObservation, ReplayFolderScanOptions } from "./replays-folder-source";

export function matchesSavedScore(value: unknown, replay: ReplayHeader): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const saved = value as LibrarySavedScore["header"];
  if (!saved.counts || typeof saved.counts !== "object" || Array.isArray(saved.counts)) return false;
  return saved.mode === replay.mode && saved.version === replay.version && saved.beatmapMD5 === replay.beatmapMD5 &&
    saved.player === replay.player && saved.replayMD5 === replay.replayMD5 && saved.score === replay.score &&
    saved.maxCombo === replay.maxCombo && saved.perfectComboFlag === replay.perfectComboFlag &&
    saved.modsBitmask === replay.modsBitmask && saved.playedAtTicks === replay.playedAtTicks &&
    (Object.keys(replay.counts) as (keyof ReplayHeader["counts"])[]).every(key => saved.counts[key] === replay.counts[key]);
}

/** Independent from viewer caches. Scores without accessible matching replay bytes remain metadata-only. */
export async function* scanStableScores(root: string, options: ReplayFolderScanOptions = {}): AsyncGenerator<FileSourceObservation> {
  const { signal } = options;
  const checkpoint = async () => { signal?.throwIfAborted(); await (options.checkpoint?.() ?? setImmediate()); signal?.throwIfAborted(); };
  const path = join(root, "scores.db");
  const database = await readSourceDatabase(path, signal, checkpoint);
  for (const savedScore of parseLibraryScoreEvents(database.bytes)) {
    await checkpoint();
    if (!savedScore) continue;
    const fileTime = BigInt(savedScore.header.playedAtTicks) - BigInt("504911232000000000");
    const locator = join(root, "Data", "r", savedScore.header.beatmapMD5 + "-" + fileTime.toString() + ".osr");
    const base = { sourceKey: savedScore.sourceKey, locator };
    const metadata = { savedScore, databaseVersion: savedScore.databaseVersion, databaseSha256: database.sha256 };
    try {
      const cached = await options.cached?.(base.sourceKey);
      if (cached?.available && cached.sha256 && cached.locator === locator) {
        const info = await stat(locator, { bigint: true });
        if (info.isFile() && sameSourceStamp(cached.metadata.stamp, sourceStamp(info))) {
          yield { ...cached, metadata: { ...cached.metadata, ...metadata } };
          continue;
        }
      }
      yield { ...base, sha256: null, available: false, metadata: { ...metadata, fileState: "indexing" } };
      await checkpoint();
      if (fileTime < BigInt(0)) throw new Error("Saved score timestamp cannot identify a Windows replay cache file");
      const replay = await inspectReplayFile(locator, signal, checkpoint);
      if (!matchesSavedScore(savedScore.header, replay.header)) {
        yield { ...base, sha256: null, available: false,
          metadata: { ...metadata, fileState: "conflict", reason: "Replay cache header disagrees with the saved score" } };
        continue;
      }
      yield { ...base, sha256: replay.sha256, available: true,
        metadata: { ...metadata, header: replay.header, stamp: replay.stamp, fileState: "readable", validation: "header-only" } };
    } catch (error) {
      if (signal?.aborted) throw error;
      yield { ...base, sha256: null, available: false, metadata: { ...metadata,
        fileState: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error",
        reason: typeof (error as Error).message === "string" ? (error as Error).message : "Replay cache read failed" } };
    }
  }
  await checkpoint();
  await assertSourceUnchanged(path, database.stamp);
  signal?.throwIfAborted();
}
