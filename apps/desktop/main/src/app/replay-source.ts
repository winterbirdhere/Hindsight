import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { read, OsrReplay } from "@rewind/osu-local/osr-reader";
import { SavedScoreSourceResult } from "@osujs/core";
import { readOptionalSavedScore } from "./saved-score-source";

export const REPLAY_SOURCE_FILE = "replay-origins.json";

export type ReplayWithSource = OsrReplay & {
  /** SHA-256 of the exact buffer passed to the replay decoder. */
  replayContentSha256: string;
  sourceClient?: "stable" | "lazer";
  sourceProvenance?: "user-confirmed";
  savedScoreSource?: SavedScoreSourceResult;
};

export async function readReplayWithSource(
  filePath: string,
  sourceFile: string,
  configuredOsuFolder?: string,
  options: { read?: (bytes: Buffer) => Promise<OsrReplay>; signal?: AbortSignal } = {},
): Promise<ReplayWithSource> {
  options.signal?.throwIfAborted();
  const bytes = await readFile(filePath);
  options.signal?.throwIfAborted();
  const digest = createHash("sha256").update(bytes).digest("hex");
  const replay: ReplayWithSource = Object.assign(await (options.read ?? read)(bytes), { replayContentSha256: digest });
  options.signal?.throwIfAborted();
  // The file's container version can lose client provenance during export.
  // Accept separately confirmed origins only for the identical file contents;
  // filenames, legacy IDs and agreement with saved totals are not identifiers.
  try {
    const store = JSON.parse(await readFile(sourceFile, "utf8"));
    const entry =
      store?.version === 1 && store.entries && typeof store.entries === "object" ? store.entries[digest] : undefined;
    if (entry?.provenance === "user-confirmed" && ["stable", "lazer"].includes(entry.client)) {
      Object.assign(replay, { sourceClient: entry.client, sourceProvenance: "user-confirmed" as const });
    }
  } catch {
    // A missing or malformed optional origin store must not prevent playback.
  }
  options.signal?.throwIfAborted();
  try {
    const savedScoreSource = await readOptionalSavedScore(filePath, bytes, replay, configuredOsuFolder);
    if (savedScoreSource) replay.savedScoreSource = savedScoreSource;
  } catch {
    replay.savedScoreSource = { status: "unavailable", reason: "saved-score-read-failed", attempts: [] };
  }
  options.signal?.throwIfAborted();
  return replay;
}
