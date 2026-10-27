import { createHash } from "crypto";
import { open, stat } from "fs/promises";
import type { BigIntStats } from "fs";
import { setImmediate } from "timers/promises";
import { parseReplayHeader } from "@rewind/osu-local/osr-reader/header";
import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";

const MAX_REPLAY_BYTES = 512 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
const CHUNK_BYTES = 1024 * 1024;

export interface ReplayFileStamp {
  bytes: number;
  device: string;
  inode: string;
  modifiedNs: string;
  changedNs: string;
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

/** Binds metadata and identity to one byte stream. This does not prove replay-frame decodability. */
export async function inspectReplayFile(path: string, signal?: AbortSignal,
  checkpoint: () => Promise<void> = () => setImmediate()): Promise<{ sha256: string; header: ReplayHeader; stamp: ReplayFileStamp }> {
  signal?.throwIfAborted();
  const file = await open(path, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_REPLAY_BYTES)) throw new Error("Invalid replay size");
    const size = Number(before.size);
    const prefix = Buffer.alloc(Math.min(size, MAX_HEADER_BYTES));
    const buffer = Buffer.alloc(Math.min(size, CHUNK_BYTES));
    const digest = createHash("sha256");
    let position = 0;
    while (position < size) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead === 0) throw new Error("Replay truncated while hashing");
      digest.update(buffer.subarray(0, bytesRead));
      if (position < prefix.length) buffer.copy(prefix, position, 0, Math.min(bytesRead, prefix.length - position));
      position += bytesRead;
      await checkpoint();
    }
    signal?.throwIfAborted();
    const after = await file.stat({ bigint: true });
    const current = await stat(path, { bigint: true });
    if (!unchanged(before, after) || !unchanged(before, current)) throw new Error("Replay changed while hashing");
    const header = parseReplayHeader(prefix, size);
    signal?.throwIfAborted();
    return { sha256: digest.digest("hex"), header, stamp: {
      bytes: size, device: before.dev.toString(), inode: before.ino.toString(),
      modifiedNs: before.mtimeNs.toString(), changedNs: before.ctimeNs.toString(),
    } };
  } finally { await file.close(); }
}
