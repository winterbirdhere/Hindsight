import { createHash } from "crypto";
import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";
import { LibraryBinaryReader, libraryDatabaseVersion } from "./library-binary";

export interface LibrarySavedScore {
  sourceKey: string;
  databaseVersion: number;
  header: Omit<ReplayHeader, "compressedFrames" | "nativeScoreInfo" | "sourceFormat">;
  onlineId: string;
  targetPractice: number | null;
}

/** Current documented scores.db layout has an Int64 online ID independent of each replay version.
 * https://github.com/ppy/osu/wiki/Legacy-database-file-structure/7720d37451313993c6b6a125b219918d5035630b#scoresdb
 * Exhaust the iterator to validate framing/EOF. Partial iteration never proves a completed source scan.
 */
export function* parseLibraryScoreEvents(bytes: Buffer): Generator<LibrarySavedScore | null> {
  const reader = new LibraryBinaryReader(bytes);
  const databaseVersion = libraryDatabaseVersion(reader);
  const groups = reader.count(1_000_000);
  let total = 0;
  for (let group = 0; group < groups; group++) {
    // Even a database containing only empty groups must offer event-loop/cancellation boundaries.
    if (group % 256 === 0) yield null;
    const groupMD5 = reader.md5();
    const count = reader.count(1_000_000 - total); total += count;
    for (let n = 0; n < count; n++) {
      const start = reader.position;
      const mode = reader.byte(); const version = reader.int();
      if (mode > 3 || version < 0) throw new Error("Invalid saved score mode/version");
      const beatmapMD5 = reader.md5();
      if (beatmapMD5 !== groupMD5) throw new Error("Saved score map disagrees with its database group");
      const player = reader.string(); const replayMD5 = reader.string();
      const counts = { great: reader.short(), ok: reader.short(), meh: reader.short(), geki: reader.short(), katu: reader.short(), miss: reader.short() };
      const score = reader.int(); const maxCombo = reader.short(); const perfectComboFlag = reader.bool(); const modsBitmask = reader.int();
      if (reader.string() !== "") throw new Error("Unexpected saved score payload string");
      const playedAtTicks = reader.long();
      if (BigInt(playedAtTicks) < BigInt(0) || BigInt(playedAtTicks) > BigInt("3155378975999999999")) throw new Error("Invalid saved score timestamp");
      if (reader.int() !== -1) throw new Error("Invalid saved score replay sentinel");
      const onlineId = reader.long();
      const targetPractice = (modsBitmask & (1 << 23)) !== 0 ? reader.double() : null;
      if (reader.position - start > 256 * 1024) throw new Error("Saved score exceeds record limit");
      yield { databaseVersion, sourceKey: createHash("sha256").update(bytes.subarray(start, reader.position)).digest("hex"),
        header: { mode, version, beatmapMD5, player, replayMD5, counts, score, maxCombo, perfectComboFlag, modsBitmask, playedAtTicks }, onlineId, targetPractice };
    }
  }
  reader.finish();
}

/** Synchronous convenience for bounded fixtures; production scans consume the progress events. */
export function* parseLibraryScores(bytes: Buffer): Generator<LibrarySavedScore> {
  for (const row of parseLibraryScoreEvents(bytes)) if (row !== null) yield row;
}
