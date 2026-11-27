import { createHash } from "crypto";
import { open, stat } from "fs/promises";
import type { BigIntStats } from "fs";
import { setImmediate } from "timers/promises";
import { parseReplayHeader } from "@rewind/osu-local/osr-reader/header";
import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";
import { validatedContentIdentity } from "../library-content-identity";
import type { LibraryContentIdentityCertificate } from "../library-content-identity";
import { closeSourceHandle } from "../library-source-state";

const MAX_REPLAY_BYTES = 512 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
const CHUNK_BYTES = 1024 * 1024;

export class ReplayFileLimitError extends Error {
  constructor(readonly maximumBytes: number) { super("Replay exceeds inspection byte limit"); }
}

export interface ReplayFileStamp {
  bytes: number;
  device: string;
  inode: string;
  modifiedNs: string;
  changedNs: string;
}

export interface ReplayFileInspection {
  sha256: string; header: ReplayHeader; stamp: ReplayFileStamp;
  contentIdentity?: LibraryContentIdentityCertificate;
  /** A hash-bound examination disposition, including inputs that cannot be certified. */
  contentIdentityInspection: { version: "stable-play-v1"; replaySha256: string };
}

/** Cached metadata may retain its examination disposition, but is never fresh byte proof. */
export function withoutFreshContentIdentity(metadata: Record<string, unknown>): Record<string, unknown> {
  const retained = { ...metadata }; delete retained.contentIdentity; return retained;
}

/** Publish only directly from this completed inspection, never from a cached metadata envelope. */
export function freshContentIdentityMetadata(inspection: ReplayFileInspection) {
  return { contentIdentityInspection: inspection.contentIdentityInspection,
    ...(inspection.contentIdentity ? { contentIdentity: inspection.contentIdentity } : {}) };
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

/** Binds metadata and identity to one byte stream. This does not prove replay-frame decodability. */
export async function inspectReplayFile(path: string, signal?: AbortSignal,
  checkpoint: () => Promise<void> = () => setImmediate(), maximumBytes = MAX_REPLAY_BYTES): Promise<ReplayFileInspection> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_REPLAY_BYTES) throw new Error("Invalid replay inspection byte limit");
  signal?.throwIfAborted();
  const file = await open(path, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_REPLAY_BYTES)) throw new Error("Invalid replay size");
    if (before.size > BigInt(maximumBytes)) throw new ReplayFileLimitError(maximumBytes);
    const size = Number(before.size);
    const prefix = Buffer.alloc(Math.min(size, MAX_HEADER_BYTES));
    const buffer = Buffer.alloc(Math.min(size, CHUNK_BYTES));
    const digest = createHash("sha256");
    let header: ReplayHeader | undefined;
    let frameDigest: ReturnType<typeof createHash> | undefined;
    let payloadBytes = 0, trailerBytes = 0;
    const trailer = Buffer.alloc(8);
    let position = 0;
    while (position < size) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position, maximumBytes - position), position);
      if (bytesRead === 0) throw new Error("Replay truncated while hashing");
      if (position + bytesRead > maximumBytes) throw new ReplayFileLimitError(maximumBytes);
      digest.update(buffer.subarray(0, bytesRead));
      if (position < prefix.length) buffer.copy(prefix, position, 0, Math.min(bytesRead, prefix.length - position));
      if (!header) {
        const filled = Math.min(position + bytesRead, prefix.length);
        try {
          header = parseReplayHeader(prefix.subarray(0, filled), size);
          const frames = header.compressedFrames;
          if (header.mode === 0 && header.sourceFormat === "stable" && !header.nativeScoreInfo &&
              frames.length !== null && frames.length >= 13 && frames.offset + frames.length + 8 === size)
            frameDigest = createHash("sha256");
        } catch (error) {
          if (!(error as { needsMoreHeader?: boolean }).needsMoreHeader || filled === prefix.length) throw error;
        }
      }
      if (frameDigest && header) {
        const frames = header.compressedFrames, end = frames.offset + Number(frames.length);
        const payloadStart = Math.max(position, frames.offset), payloadEnd = Math.min(position + bytesRead, end);
        if (payloadEnd > payloadStart) {
          frameDigest.update(buffer.subarray(payloadStart - position, payloadEnd - position)); payloadBytes += payloadEnd - payloadStart;
        }
        const trailerStart = Math.max(position, end), trailerEnd = Math.min(position + bytesRead, end + 8);
        if (trailerEnd > trailerStart) {
          buffer.copy(trailer, trailerStart - end, trailerStart - position, trailerEnd - position); trailerBytes += trailerEnd - trailerStart;
        }
      }
      position += bytesRead;
      await checkpoint();
    }
    signal?.throwIfAborted();
    const after = await file.stat({ bigint: true });
    const current = await stat(path, { bigint: true });
    if (!unchanged(before, after) || !unchanged(before, current)) throw new Error("Replay changed while hashing");
    header ??= parseReplayHeader(prefix, size);
    signal?.throwIfAborted();
    const sha256 = digest.digest("hex");
    let contentIdentity: LibraryContentIdentityCertificate | undefined;
    if (frameDigest && payloadBytes === header.compressedFrames.length && trailerBytes === 8) {
      const { great, ok, meh, miss } = header.counts;
      contentIdentity = validatedContentIdentity({ header, contentIdentity: {
        version: "stable-play-v1", replaySha256: sha256, compressedSha256: frameDigest.digest("hex"), compressedBytes: payloadBytes,
        onlineScoreId: trailer.readBigInt64LE().toString(), mode: 0, replayVersion: header.version, beatmapMD5: header.beatmapMD5,
        player: header.player, modsBitmask: header.modsBitmask, score: header.score, maxCombo: header.maxCombo,
        perfectComboFlag: header.perfectComboFlag, counts: { great, ok, meh, miss },
      } }, sha256);
    }
    return { sha256, header, ...(contentIdentity ? { contentIdentity } : {}),
      contentIdentityInspection: { version: "stable-play-v1", replaySha256: sha256 }, stamp: {
      bytes: size, device: before.dev.toString(), inode: before.ino.toString(),
      modifiedNs: before.mtimeNs.toString(), changedNs: before.ctimeNs.toString(),
    } };
  } finally { await closeSourceHandle(file, signal); }
}
