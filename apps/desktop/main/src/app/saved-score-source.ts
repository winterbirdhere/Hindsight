import { createHash } from "crypto";
import { open } from "fs/promises";
import { extname, isAbsolute, join, resolve } from "path";
import type { OsrReplay } from "@rewind/osu-local/osr-reader";
import { SavedScoreSourceResult, validateSavedScoreTimeline } from "@osujs/core";

type LoadedReplay = Pick<
  OsrReplay,
  | "gameMode"
  | "gameVersion"
  | "beatmapMD5"
  | "lazerMods"
  | "lazerScoreInfo"
  | "number_300s"
  | "number_100s"
  | "number_50s"
  | "gekis"
  | "katus"
  | "misses"
  | "score"
  | "max_combo"
> & {
  replayContentSha256: string;
  sourceClient?: "stable" | "lazer";
  sourceProvenance?: "user-confirmed";
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MAX_OSG_BYTES = 8 + 250_000 * 29;
const MAX_OSR_BYTES = 64 * 1024 * 1024;

/** Extract only the exact saved cache identity; never round the 100 ns timestamp. */
export function savedScoreFileIdentity(bytes: Uint8Array): { mapMd5: string; fileTime: string } | undefined {
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 5;
    const skip = (count: number) => {
      if (!Number.isSafeInteger(count) || count < 0 || offset + count > buffer.length)
        throw new Error("Truncated header");
      offset += count;
    };
    const byte = () => {
      skip(1);
      return buffer[offset - 1];
    };
    const string = () => {
      const marker = byte();
      if (marker === 0) return "";
      if (marker !== 11) throw new Error("Invalid header string");
      let length = 0;
      for (let shift = 0; shift <= 28; shift += 7) {
        const next = byte();
        length += (next & 127) * 2 ** shift;
        if (!(next & 128)) {
          const start = offset;
          skip(length);
          return buffer.toString("utf8", start, offset);
        }
      }
      throw new Error("Invalid header length");
    };
    const mapMd5 = string().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(mapMd5)) return undefined;
    string();
    string();
    skip(23);
    string();
    skip(8);
    const fileTime = buffer.readBigUInt64LE(offset - 8) - BigInt("504911232000000000");
    if (fileTime < BigInt(0)) return undefined;
    return { mapMd5, fileTime: fileTime.toString() };
  } catch {
    return undefined;
  }
}

/** One bounded file read from one handle; refuse growth/change during that read. */
async function readBounded(path: string, maximum: number, checkpoint: () => Promise<void>, signal?: AbortSignal): Promise<Buffer | undefined> {
  signal?.throwIfAborted();
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maximum) throw new Error("resource-limit");
    const bytes = Buffer.alloc(Math.min(before.size + 1, maximum + 1));
    let used = 0;
    while (used < bytes.length) {
      signal?.throwIfAborted();
      const read = await file.read(bytes, used, Math.min(bytes.length - used, 1024 * 1024), used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
      await checkpoint();
    }
    const after = await file.stat();
    if (used > maximum) throw new Error("resource-limit");
    if (
      used !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("source-changed-during-read");
    signal?.throwIfAborted(); return bytes.subarray(0, used);
  } finally {
    await file.close();
  }
}

/**
 * Optional read-only discovery: adjacent sidecar, then one exact name under an
 * explicitly configured installation. No directory scan, filename-only pairing
 * or cache write. Map-byte identity must be checked again by analysis admission.
 */
export async function readOptionalSavedScore(
  replayPath: string,
  replayBytes: Uint8Array,
  replay: LoadedReplay,
  configuredOsuFolder?: string,
  options: { signal?: AbortSignal; checkpoint?: () => Promise<void> } = {},
): Promise<SavedScoreSourceResult> {
  const { signal } = options;
  const checkpoint = async () => {
    signal?.throwIfAborted();
    await (options.checkpoint?.() ?? new Promise<void>(resolve => setImmediate(resolve)));
    signal?.throwIfAborted();
  };
  signal?.throwIfAborted();
  const attempts: SavedScoreSourceResult["attempts"][number][] = [];
  try {
    if (
      replay.gameMode !== 0 ||
      replay.gameVersion >= 30_000_000 ||
      replay.lazerMods !== undefined ||
      replay.lazerScoreInfo !== undefined ||
      (replay.sourceClient === "lazer" && replay.sourceProvenance === "user-confirmed")
    )
      return { status: "unavailable", reason: "unsupported-profile", attempts };
    if (!/^[a-f0-9]{32}$/i.test(replay.beatmapMD5) || !/^[a-f0-9]{64}$/i.test(replay.replayContentSha256))
      return { status: "unavailable", reason: "invalid-provenance", attempts };
    const loadedSha = replay.replayContentSha256.toLowerCase();
    if (sha256(replayBytes) !== loadedSha) return { status: "rejected", reason: "replay-bytes-changed", attempts };
    const pairs: { timelinePath: string; pairedReplayPath: string; loaded: boolean }[] = [];
    if (extname(replayPath).toLowerCase() === ".osr")
      pairs.push({ timelinePath: replayPath.slice(0, -4) + ".osg", pairedReplayPath: replayPath, loaded: true });
    if (configuredOsuFolder && isAbsolute(configuredOsuFolder)) {
      const identity = savedScoreFileIdentity(replayBytes);
      if (identity?.mapMd5 === replay.beatmapMD5.toLowerCase()) {
        const base = join(configuredOsuFolder, "Data", "r", `${identity.mapMd5}-${identity.fileTime}`);
        if (!pairs.some((pair) => resolve(pair.timelinePath).toLowerCase() === resolve(base + ".osg").toLowerCase()))
          pairs.push({ timelinePath: base + ".osg", pairedReplayPath: base + ".osr", loaded: false });
      }
    }
    for (const pair of pairs) {
      try {
        const bytes = await readBounded(pair.timelinePath, MAX_OSG_BYTES, checkpoint, signal);
        if (!bytes) continue;
        const pairedBytes = pair.loaded ? replayBytes : await readBounded(pair.pairedReplayPath, MAX_OSR_BYTES, checkpoint, signal);
        if (!pairedBytes) {
          attempts.push({ ...pair, status: "rejected", reason: "paired-replay-missing" });
          continue;
        }
        // Pairing requires exact bytes, so loaded parsed metadata also describes the paired file.
        const result = await validateSavedScoreTimeline(
          bytes,
          pairedBytes,
          {
            timelineSha256: sha256(bytes),
            loadedReplaySha256: loadedSha,
            loadedMapMd5: replay.beatmapMD5,
            pairedReplay: {
              sha256: loadedSha,
              source: "stable-osr",
              mode: replay.gameMode,
              version: replay.gameVersion,
              mapMd5: replay.beatmapMD5,
              counts: [
                replay.number_300s,
                replay.number_100s,
                replay.number_50s,
                replay.gekis,
                replay.katus,
                replay.misses,
              ],
              score: replay.score,
              maximumCombo: replay.max_combo,
            },
          },
          sha256,
          { checkpoint },
        );
        signal?.throwIfAborted();
        attempts.push({
          timelinePath: pair.timelinePath,
          pairedReplayPath: pair.pairedReplayPath,
          status: result.status === "validated" ? "validated" : "rejected",
          ...(result.status === "rejected" ? { reason: result.reason } : {}),
        });
        if (result.status === "validated") return { status: "validated", timeline: result.timeline, attempts };
      } catch (error) {
        signal?.throwIfAborted();
        attempts.push({
          timelinePath: pair.timelinePath,
          pairedReplayPath: pair.pairedReplayPath,
          status: "unavailable",
          reason: error instanceof Error ? error.message : "read-failed",
        });
      }
    }
    const last = attempts[attempts.length - 1];
    signal?.throwIfAborted();
    return last
      ? { status: last.status === "rejected" ? "rejected" : "unavailable", reason: last.reason, attempts }
      : { status: "absent", attempts };
  } catch (error) {
    signal?.throwIfAborted();
    return { status: "unavailable", reason: error instanceof Error ? error.message : "read-failed", attempts };
  }
}
