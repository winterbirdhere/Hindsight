import { lstat } from "fs/promises";
import { setImmediate } from "timers/promises";
import { inspectReplayFile } from "./replay-file";
import { sameSourceStamp, sourceStamp } from "./source-file";
import type { FileSourceObservation, ReplayFolderScanOptions } from "./replays-folder-source";

/** Only persisted explicit imports are scanned. Unknown files in the owned directory are not imported. */
export async function* scanImportedReplays(locations: AsyncIterable<FileSourceObservation>,
  options: ReplayFolderScanOptions = {}): AsyncGenerator<FileSourceObservation> {
  const { signal } = options;
  const checkpoint = async () => { signal?.throwIfAborted(); await (options.checkpoint?.() ?? setImmediate()); signal?.throwIfAborted(); };
  for await (const location of locations) {
    await checkpoint();
    try {
      if (!location.sha256 || location.sha256 !== location.sourceKey) throw new Error("Invalid owned replay identity");
      const info = await lstat(location.locator, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Owned replay must be a regular file");
      if (location.available && sameSourceStamp(location.metadata.stamp, sourceStamp(info))) { yield location; continue; }
      const replay = await inspectReplayFile(location.locator, signal, checkpoint);
      if (replay.sha256 !== location.sha256) throw new Error("Owned replay changed. Move the conflicting owned file aside, then explicitly re-import the original");
      yield { ...location, available: true, metadata: { ...location.metadata, header: replay.header, stamp: replay.stamp, fileState: "readable", validation: "header-only" } };
    } catch (error) {
      if (signal?.aborted) throw error;
      yield { ...location, sha256: null, available: false, metadata: { ...location.metadata,
        fileState: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error",
        reason: typeof (error as Error).message === "string" ? (error as Error).message : "Owned replay read failed" } };
    }
  }
  await checkpoint();
}
