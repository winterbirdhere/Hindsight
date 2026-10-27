import { lstat, opendir } from "fs/promises";
import { extname, join, resolve } from "path";
import { setImmediate } from "timers/promises";
import { createHash } from "crypto";
import { readReplayHeader } from "@rewind/osu-local/osr-reader/header";
import { inspectReplayFile, ReplayFileStamp } from "./replay-file";
import type { LibraryLocationObservation, LibrarySourceScanProgress } from "../../../../../shared/replay-library";

export type FileSourceObservation = LibraryLocationObservation;
export interface ReplayFolderScanOptions {
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
  /** Only used with a main-owned native broker that independently confirms helper drainage. */
  waitForNative?:<T>(work:Promise<T>)=>Promise<T>;
  cached?: (sourceKey: string) => Promise<FileSourceObservation | undefined>;
  /** Status only; does not own enumeration, publication or cancellation. */
  onProgress?: (progress: LibrarySourceScanProgress) => void;
}

/** Read-only enumeration. Exhaustion means complete; thrown errors must never establish removals. */
export async function* scanReplayFolder(directory: string, options: ReplayFolderScanOptions = {}): AsyncGenerator<FileSourceObservation> {
  const { signal, cached } = options;
  const checkpoint = async () => { signal?.throwIfAborted(); await (options.checkpoint?.() ?? setImmediate()); signal?.throwIfAborted(); };
  // Directory timestamps can be coalesced on Windows. Compare bounded streaming name/type
  // fingerprints too; never retain a whole directory listing in memory or hash replay bytes here.
  const fingerprint = async (path: string) => {
    const digest = Buffer.alloc(32); let count = 0;
    const entries = await opendir(path, { bufferSize: 32 });
    for await (const entry of entries) {
      if (++count > 1_000_000) throw new Error("Replay directory exceeds entry limit");
      const hash = createHash("sha256").update(JSON.stringify([entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink()])).digest();
      for (let i = 0; i < digest.length; i++) digest[i] ^= hash[i];
      if (count % 32 === 0) await checkpoint();
    }
    await checkpoint(); return count + ":" + digest.toString("hex");
  };
  let visited = 0;
  async function* walk(path: string, relative: string, depth: number): AsyncGenerator<FileSourceObservation> {
    await checkpoint();
    if (depth > 32) throw new Error("Replay directory exceeds depth limit");
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Replay directory must be a real directory");
    const namesBefore = await fingerprint(path);
    const entries = await opendir(path, { bufferSize: 32 });
    for await (const entry of entries) {
      await checkpoint();
      if (++visited > 1_000_000) throw new Error("Replay directory exceeds entry limit");
      const locator = join(path, entry.name);
      const key = relative + entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) { yield* walk(locator, key + "/", depth + 1); continue; }
      if (extname(entry.name).toLowerCase() !== ".osr") continue;
      // Windows source keys are case-insensitive; the actual path spelling is retained for opening.
      const sourceKey = key.toLowerCase();
      try {
        const info = await lstat(locator, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Replay must be a regular file");
        const stamp: ReplayFileStamp = { bytes: Number(info.size), device: info.dev.toString(), inode: info.ino.toString(),
          modifiedNs: info.mtimeNs.toString(), changedNs: info.ctimeNs.toString() };
        const previous = await cached?.(sourceKey);
        if (previous?.available && previous.sha256 && previous.locator === locator &&
            JSON.stringify(previous.metadata.stamp) === JSON.stringify(stamp)) {
          yield previous;
          continue;
        }
        const header = await readReplayHeader(locator, signal);
        yield { sourceKey, locator, sha256: null, available: false, metadata: { header, fileState: "indexing" } };
        await checkpoint();
        const verified = await inspectReplayFile(locator, signal, checkpoint);
        yield { sourceKey, locator, sha256: verified.sha256, available: true,
          metadata: { header: verified.header, stamp: verified.stamp, fileState: "readable", validation: "header-only" } };
      } catch (error) {
        if (signal?.aborted) throw error;
        yield { sourceKey, locator, sha256: null, available: false, metadata: { fileState: "error",
          reason: typeof (error as Error).message === "string" ? (error as Error).message : "Replay read failed" } };
      }
    }
    await checkpoint();
    const namesAfter = await fingerprint(path);
    const after = await lstat(path, { bigint: true });
    signal?.throwIfAborted();
    if (namesBefore !== namesAfter || before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw new Error("Replay directory changed during enumeration");
  }
  yield* walk(resolve(directory), "", 0);
}
