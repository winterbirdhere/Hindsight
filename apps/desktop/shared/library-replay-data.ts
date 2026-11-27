import type { OsrReplay } from "@rewind/osu-local/osr-reader";
import type { SavedScoreSourceResult } from "@osujs/core";

/** Plain selected-resource wire data. Frame parsing happens in the foreground parser worker. */
export type LibraryReplayData = Pick<OsrReplay,
  "gameMode" | "gameVersion" | "beatmapMD5" | "playerName" | "replayMD5" | "number_300s" | "number_100s" |
  "number_50s" | "misses" | "score" | "max_combo" | "perfect_combo" | "mods" | "life_bar" | "replay_data" |
  "lazerMods" | "lazerScoreInfo"> & {
  timestamp?: number;
  replayContentSha256: string;
  sourceClient?: "stable" | "lazer";
  sourceProvenance?: "user-confirmed";
  savedScoreSource?: SavedScoreSourceResult;
  nativeSource?: { scoreId: string; schemaFingerprint: string; isLegacyScore: boolean; mods: unknown[] | null };
};
