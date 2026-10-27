import { stat } from "fs/promises";
import { setImmediate } from "timers/promises";
import type { LazerSource } from "./lazer-source";
import { LibrarySourceScanError } from "../library-source-state";
import { inspectReplayFile } from "./replay-file";
import { sameSourceStamp, sourceStamp } from "./source-file";
import type { FileSourceObservation, ReplayFolderScanOptions } from "./replays-folder-source";

/** An exhaustive metadata/identity scan, independent of native inspection and current-replay work. */
export async function* scanLazerSource(source: Pick<LazerSource, "page">, directory: string,
  options: ReplayFolderScanOptions = {}): AsyncGenerator<FileSourceObservation> {
  const { signal } = options;
  const checkpoint = async () => { signal?.throwIfAborted(); await (options.checkpoint?.() ?? setImmediate()); signal?.throwIfAborted(); };
  let cursor: { token: string; offset: number } | undefined;
  let finalValidation = false;
  let progressStarted = false;
  for (;;) {
    await checkpoint();
    const pending=source.page(directory,cursor,signal);
    const page = await (options.waitForNative?options.waitForNative(pending):pending);
    signal?.throwIfAborted();
    if (!page.ok) throw new LibrarySourceScanError(page.status);
    if (page.sampleOnly !== false || !page.cursorToken || page.nextOffset === undefined || page.total === undefined || !page.scores)
      throw new Error("Native source returned an inspection instead of an exhaustive page");
    if (finalValidation) {
      if (!page.complete || page.scores.length || page.errors?.length || page.nextOffset !== cursor?.offset) throw new Error("Native source changed at EOF");
      return;
    }
    if (!progressStarted) {
      options.onProgress?.({ phase: "checking-replays", completed: cursor?.offset ?? 0, total: page.total, unit: "source-records" });
      progressStarted = true;
    }
    for (const error of page.errors ?? []) {
      await checkpoint();
      yield { sourceKey: error.id, locator: "lazer-score:" + error.id, sha256: null, available: false,
        metadata: { fileState: "error", reason: error.status, schemaFingerprint: page.schemaFingerprint } };
    }
    for (const nativeScore of page.scores) {
      await checkpoint();
      const locator = nativeScore.replay.path ?? ("lazer-score:" + nativeScore.id);
      const base = { sourceKey: nativeScore.id, locator };
      const metadata = { nativeScore, schemaFingerprint: page.schemaFingerprint, assetManifestState: "not-enumerated" };
      try {
        const resource = nativeScore.replay;
        if (!resource.path || !resource.sha256 || !["available", "unverified"].includes(resource.status)) {
          yield { ...base, sha256: null, available: false, metadata: { ...metadata, fileState: resource.status } };
          continue;
        }
        const cached = await options.cached?.(base.sourceKey);
        if (cached?.available && cached.sha256 === resource.sha256 && cached.locator === locator) {
          const info = await stat(locator, { bigint: true });
          const cachedHeader = cached.metadata.header as { beatmapMD5?: string } | undefined;
          if (cachedHeader?.beatmapMD5 && info.isFile() && sameSourceStamp(cached.metadata.stamp, sourceStamp(info))) {
            if (nativeScore.beatmap.md5 && cachedHeader.beatmapMD5 !== nativeScore.beatmap.md5)
              throw new Error("Native replay header disagrees with its source beatmap");
            yield { ...cached, metadata: { ...cached.metadata, ...metadata } };
            continue;
          }
        }
        yield { ...base, sha256: null, available: false, metadata: { ...metadata, fileState: "indexing" } };
        await checkpoint();
        const replay = await inspectReplayFile(locator, signal, checkpoint);
        if (replay.sha256 !== resource.sha256) throw new Error("Native replay blob digest disagrees with its source record");
        if (nativeScore.beatmap.md5 && replay.header.beatmapMD5 !== nativeScore.beatmap.md5)
          throw new Error("Native replay header disagrees with its source beatmap");
        yield { ...base, sha256: replay.sha256, available: true,
          metadata: { ...metadata, header: replay.header, stamp: replay.stamp, fileState: "readable", validation: "header-only" } };
      } catch (error) {
        if (signal?.aborted) throw error;
        yield { ...base, sha256: null, available: false, metadata: { ...metadata,
          fileState: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error",
          reason: typeof (error as Error).message === "string" ? (error as Error).message : "Native replay read failed" } };
      }
    }
    cursor = { token: page.cursorToken, offset: page.nextOffset };
    options.onProgress?.({ phase: "checking-replays", completed: page.nextOffset, total: page.total, unit: "source-records" });
    // Recheck the database after the last replay I/O. A metadata page's earlier EOF cannot prove
    // the source stayed unchanged while those blobs were being verified or the scan was suspended.
    finalValidation = page.complete === true;
  }
}
