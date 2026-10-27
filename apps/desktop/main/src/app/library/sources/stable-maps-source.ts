import { createHash } from "crypto";
import { join, resolve, isAbsolute, relative, sep } from "path";
import { setImmediate } from "timers/promises";
import { parseLibraryMaps } from "@rewind/osu-local/db-reader/library-maps";
import { LibraryStore } from "../library-store";
import type { LibraryMapObservation } from "../../../../../shared/replay-library";
import { readSourceDatabase, assertSourceUnchanged } from "./source-file";
import type { ReplayFolderScanOptions } from "./replays-folder-source";

/** Source names are untrusted relative paths. A locator is still only a hint: resource use must
 * resolve real paths/links and verify actual MD5/SHA bytes separately. */
function candidatePath(songs: string, folder: string, file: string): string | null {
  const safe = (name: string) => !!name && !isAbsolute(name) && !/[<>:"|?*]/.test(name) && ![...name].some(char => char.charCodeAt(0) < 32) &&
    name.split(/[\\/]/).every(part => part !== "" && part !== "." && part !== ".." && !/[. ]$/.test(part));
  if (!safe(folder) || !safe(file)) return null;
  const path = resolve(songs, folder, file);
  const within = relative(songs, path);
  return path.length <= 32768 && within && !within.startsWith(".." + sep) && within !== ".." && !isAbsolute(within) ? path : null;
}

/** Independent of the foreground DAO. Publish only a complete consistent metadata generation. */
export async function indexStableMaps(store: LibraryStore, sourceId: string, directory: string, resolvedSongsRoot: string,
  options: Pick<ReplayFolderScanOptions, "signal" | "checkpoint" | "onProgress"> & { reuseEquivalentCatalog?: boolean } = {}): Promise<void> {
  const generation = store.beginMapScan(sourceId);
  try {
    for await (const observation of scanStableMaps(directory, resolvedSongsRoot, options)) store.upsertMap({ ...observation, sourceId, generation });
    store.finishMapScan(sourceId, generation, options.reuseEquivalentCatalog === true);
  } catch (error) { store.stopMapScan(sourceId, generation); throw error; }
}

/** Yielding this metadata does not publish it. Rebuilds stage it with their replay generation. */
export async function* scanStableMaps(directory: string, resolvedSongsRoot: string,
  options: Pick<ReplayFolderScanOptions, "signal" | "checkpoint" | "onProgress"> = {}): AsyncGenerator<Omit<LibraryMapObservation, "sourceId" | "generation">> {
  const { signal } = options;
  const checkpoint = async () => { signal?.throwIfAborted(); await (options.checkpoint?.() ?? setImmediate()); signal?.throwIfAborted(); };
  const songsRoot = resolve(resolvedSongsRoot);
  const path = join(directory, "osu!.db");
    signal?.throwIfAborted();
    let completed = 0;
    options.onProgress?.({ phase: "reading-map-metadata", completed, unit: "map-records" });
    const database = await readSourceDatabase(path, signal, checkpoint);
    for (const parsed of parseLibraryMaps(database.bytes)) {
      await checkpoint();
      const { timingPoints, stdStarRatings, ...savedMap } = parsed;
      let metadataTruncated = false;
      const map = Object.fromEntries(Object.entries(savedMap).map(([key, value]) => {
        if (typeof value === "string" && value.length > 2048) { metadataTruncated = true; return [key, value.slice(0, 2048)]; }
        return [key, value];
      }));
      const noMod = [...new Set(stdStarRatings?.filter(row => row.modsBitmask === 0).map(row => row.stars))];
      const tempos = timingPoints.filter(point => point.uninherited && point.beatLengthMs > 0)
        .map(point => 60000 / point.beatLengthMs).filter(Number.isFinite);
      const locator = candidatePath(songsRoot, parsed.folderName, parsed.fileName);
      options.onProgress?.({ phase: "reading-map-metadata", completed: ++completed, unit: "map-records" });
      yield {
        sourceKey: createHash("sha256").update(JSON.stringify([parsed.folderName, parsed.fileName, parsed.md5])).digest("hex"),
        md5: parsed.md5, locator, state: locator ? "unverified" : "invalid-path",
        metadata: { map, databaseSha256: database.sha256, songsRoot, metadataTruncated,
          cachedNoModStars: noMod.length === 1 ? noMod[0] : null,
          cachedTempo: tempos.length ? { min: Math.min(...tempos), max: Math.max(...tempos) } : null } };
    }
    await checkpoint(); await assertSourceUnchanged(path, database.stamp); signal?.throwIfAborted();
}
