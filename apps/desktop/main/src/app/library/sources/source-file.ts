import { open, stat } from "fs/promises";
import { createHash } from "crypto";
import { setImmediate } from "timers/promises";
import type { BigIntStats } from "fs";
import type { ReplayFileStamp } from "./replay-file";

export function sourceStamp(info: BigIntStats): ReplayFileStamp {
  return { bytes: Number(info.size), device: info.dev.toString(), inode: info.ino.toString(),
    modifiedNs: info.mtimeNs.toString(), changedNs: info.ctimeNs.toString() };
}
export function sameSourceStamp(a: unknown, b: ReplayFileStamp): boolean {
  if (!a || typeof a !== "object") return false;
  const stamp = a as ReplayFileStamp;
  return stamp.bytes === b.bytes && stamp.device === b.device && stamp.inode === b.inode &&
    stamp.modifiedNs === b.modifiedNs && stamp.changedNs === b.changedNs;
}
export async function assertSourceUnchanged(path: string, before: ReplayFileStamp): Promise<void> {
  const now = await stat(path, { bigint: true });
  if (!now.isFile() || !sameSourceStamp(before, sourceStamp(now))) throw new Error("Source database changed during indexing");
}

/** A bounded immutable in-memory observation, read without source copies or writes. */
export async function readSourceDatabase(path: string, signal?: AbortSignal, checkpoint: () => Promise<void> = () => setImmediate()) {
  signal?.throwIfAborted();
  const file = await open(path, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(256 * 1024 * 1024)) throw new Error("Source database exceeds size limit");
    const stamp = sourceStamp(before);
    const bytes = Buffer.alloc(stamp.bytes);
    const hash = createHash("sha256");
    let position = 0;
    while (position < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, position, Math.min(1024 * 1024, bytes.length - position), position);
      if (!bytesRead) throw new Error("Source database truncated during reading");
      hash.update(bytes.subarray(position, position + bytesRead)); position += bytesRead;
      await checkpoint();
    }
    signal?.throwIfAborted();
    if (!sameSourceStamp(stamp, sourceStamp(await file.stat({ bigint: true })))) throw new Error("Source database changed during reading");
    await assertSourceUnchanged(path, stamp);
    return { bytes, sha256: hash.digest("hex"), stamp };
  } finally { await file.close(); }
}
