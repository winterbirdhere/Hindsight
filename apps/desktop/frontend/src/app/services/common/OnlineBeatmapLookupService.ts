import { injectable } from "inversify";
import { frontendAPI } from "../../api";
import type { BeatmapLookupResult, OnlineBeatmap } from "../../../../../shared/beatmap-lookup";
export type { OnlineBeatmap } from "../../../../../shared/beatmap-lookup";

interface CachedLookup {
  result: Promise<BeatmapLookupResult>;
  /** Derived once, so repeated lookup() calls for one checksum return the same promise. */
  beatmap: Promise<OnlineBeatmap | undefined>;
  expiresAt: number;
}

const FOUND_CACHE_MS = 30 * 60_000;
const NOT_FOUND_CACHE_MS = 5 * 60_000;
const UNAVAILABLE_CACHE_MS = 30_000;
const MAX_CACHE_ENTRIES = 100;

@injectable()
export class OnlineBeatmapLookupService {
  private readonly cache = new Map<string, CachedLookup>();

  /** The FOUND beatmap, or undefined for NOT_FOUND, UNAVAILABLE and an invalid checksum. */
  lookup(md5: string): Promise<OnlineBeatmap | undefined> {
    const checksum = md5.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(checksum)) return Promise.resolve(undefined);
    return this.entryFor(checksum).beatmap;
  }

  /** Keeps FOUND / NOT_FOUND / UNAVAILABLE apart; an invalid checksum is UNAVAILABLE without a request. */
  lookupResult(md5: string): Promise<BeatmapLookupResult> {
    const checksum = md5.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(checksum)) return Promise.resolve({ status: "UNAVAILABLE" });
    return this.entryFor(checksum).result;
  }

  private entryFor(checksum: string): CachedLookup {
    const cached = this.cache.get(checksum);
    if (cached && cached.expiresAt > Date.now()) return cached;
    this.cache.delete(checksum);

    // Cache the promise too, so opening multiple replays of one map shares a request.
    const result = this.requestBeatmap(checksum).then((value) => {
      const cacheMs =
        value.status === "FOUND"
          ? FOUND_CACHE_MS
          : value.status === "NOT_FOUND"
          ? NOT_FOUND_CACHE_MS
          : UNAVAILABLE_CACHE_MS;
      entry.expiresAt = Date.now() + cacheMs;
      return value;
    });
    const entry: CachedLookup = {
      expiresAt: Infinity,
      result,
      beatmap: result.then((value) => (value.status === "FOUND" ? value.beatmap : undefined)),
    };
    this.cache.set(checksum, entry);
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return entry;
  }

  private async requestBeatmap(checksum: string): Promise<BeatmapLookupResult> {
    try {
      // Native HTTPS supplies Rewind's app identity and does not depend on browser CORS support.
      return await frontendAPI.lookupBeatmap(checksum);
    } catch {
      console.warn("[beatmap-lookup] Could not contact the main process");
      return { status: "UNAVAILABLE" };
    }
  }
}
