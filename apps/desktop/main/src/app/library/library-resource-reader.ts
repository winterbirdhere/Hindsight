import { open } from "fs/promises";
import { createHash } from "crypto";
import { setImmediate } from "timers/promises";
import { assertSourceUnchanged, sameSourceStamp, sourceStamp } from "./sources/source-file";

export interface LibraryResourceExpectation { maxBytes: number; sha256?: string; md5?: string }

/** Explicit resource consumption only, never invoked by queries/previews/sorts. The returned buffer
 * is the same bounded byte stream that was hashed; callers must consume it, never reopen the path. */
export async function readVerifiedLibraryResource(path: string, expected: LibraryResourceExpectation, signal?: AbortSignal,
  checkpoint: () => Promise<void> = () => setImmediate()) {
  if (!Number.isSafeInteger(expected.maxBytes) || expected.maxBytes < 1 || expected.maxBytes > 512 * 1024 * 1024)
    throw new Error("Invalid library resource size limit");
  if ((expected.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(expected.sha256)) ||
      (expected.md5 !== undefined && !/^[a-f0-9]{32}$/.test(expected.md5))) throw new Error("Invalid resource digest");
  signal?.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(expected.maxBytes)) throw new Error("Library resource exceeds size limit");
    const stamp = sourceStamp(before), bytes = Buffer.alloc(stamp.bytes);
    const sha = createHash("sha256"), mapHash = createHash("md5");
    let position = 0;
    while (position < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, position, Math.min(1024 * 1024, bytes.length - position), position);
      if (!bytesRead) throw new Error("Library resource truncated during reading");
      const chunk = bytes.subarray(position, position + bytesRead); sha.update(chunk); mapHash.update(chunk);
      position += bytesRead; await checkpoint();
    }
    signal?.throwIfAborted();
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || !sameSourceStamp(stamp, sourceStamp(after))) throw new Error("Library resource changed during reading");
    await assertSourceUnchanged(path, stamp);
    const sha256 = sha.digest("hex"), md5 = mapHash.digest("hex");
    if ((expected.sha256 !== undefined && expected.sha256 !== sha256) || (expected.md5 !== undefined && expected.md5 !== md5))
      throw new Error("Library resource digest disagrees with selected source evidence");
    signal?.throwIfAborted();
    return { bytes, sha256, md5, stamp };
  } finally { await handle.close(); }
}
