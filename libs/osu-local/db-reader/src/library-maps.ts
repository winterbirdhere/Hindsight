import { LibraryBinaryReader, libraryDatabaseVersion } from "./library-binary";

export interface LibraryMapMetadata {
  databaseVersion: number;
  artist: string; artistUnicode: string; title: string; titleUnicode: string; creator: string; difficulty: string;
  md5: string; folderName: string; fileName: string; audioFileName: string;
  /** Source cache enum; 2 combines pending/WIP/graveyard and cannot identify those separately. */
  rankedStatus: number;
  mode: number; beatmapId: number; beatmapSetId: number;
  circles: number; sliders: number; spinners: number;
  approachRate: number; circleSize: number; hpDrain: number; overallDifficulty: number;
  drainTimeSeconds: number; totalTimeMs: number;
  /** Usable saved ratings only; missing/negative cached values remain unavailable, never zero. */
  stdStarRatings: { modsBitmask: number; stars: number }[] | null;
  timingPoints: { beatLengthMs: number; offsetMs: number; uninherited: boolean }[];
}

/** Saved map metadata, not current-engine stars or replay grade/completion. Supported range starts
 * after 20140609; entry-size removal is 20191106, star Float32 transition is 20250107.
 * https://github.com/ppy/osu/wiki/Legacy-database-file-structure#beatmap-information
 */
export function* parseLibraryMaps(bytes: Buffer): Generator<LibraryMapMetadata> {
  const r = new LibraryBinaryReader(bytes);
  const databaseVersion = libraryDatabaseVersion(r);
  r.count(1_000_000); r.bool(); r.long(); r.string();
  const count = r.count(1_000_000);
  const stars = () => {
    const n = r.int();
    if (n <= 0) return null;
    if (n > 4096) throw new Error("Map star cache exceeds limit");
    const values: { modsBitmask: number; stars: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (r.byte() !== 8) throw new Error("Invalid star mod type");
      const modsBitmask = r.int();
      if (r.byte() !== (databaseVersion >= 20250107 ? 12 : 13)) throw new Error("Invalid star number type");
      const rating = databaseVersion >= 20250107 ? r.float() : r.double();
      // A finite negative cache value is not a usable rating. Consume it without
      // invalidating unrelated map metadata; the reader still rejects nonfinite data.
      if (rating >= 0) values.push({ modsBitmask, stars: rating });
    }
    return values.length ? values : null;
  };
  for (let index = 0; index < count; index++) {
    const entrySize = databaseVersion < 20191106 ? r.count(1024 * 1024) : null;
    const start = r.position;
    const artist = r.string(); const artistUnicode = r.string(); const title = r.string(); const titleUnicode = r.string();
    const creator = r.string(); const difficulty = r.string(); const audioFileName = r.string(); const md5 = r.md5(); const fileName = r.string();
    const rankedStatus = r.byte(); const circles = r.short(); const sliders = r.short(); const spinners = r.short(); r.long();
    const approachRate = r.float(); const circleSize = r.float(); const hpDrain = r.float(); const overallDifficulty = r.float(); r.double();
    const stdStarRatings = stars(); stars(); stars(); stars();
    const drainTimeSeconds = r.int(); const totalTimeMs = r.int(); r.int();
    const timingCount = r.count(10_000);
    const timingPoints: LibraryMapMetadata["timingPoints"] = [];
    for (let n = 0; n < timingCount; n++) timingPoints.push({ beatLengthMs: r.double(), offsetMs: r.double(), uninherited: r.bool() });
    const beatmapId = r.int(); const beatmapSetId = r.int(); r.int();
    r.take(4); r.short(); r.float(); const mode = r.byte();
    if (mode > 3) throw new Error("Invalid map ruleset");
    r.string(); r.string(); r.short(); r.string(); r.bool(); r.long(); r.bool();
    const folderName = r.string(); r.long();
    for (let n = 0; n < 5; n++) r.bool();
    r.int(); r.byte();
    if (r.position - start > 1024 * 1024 || (entrySize !== null && r.position - start !== entrySize)) throw new Error("Invalid map entry length");
    yield { databaseVersion, artist, artistUnicode, title, titleUnicode, creator, difficulty, audioFileName, md5, fileName,
      rankedStatus, circles, sliders, spinners, approachRate, circleSize, hpDrain, overallDifficulty, stdStarRatings,
      drainTimeSeconds, totalTimeMs, timingPoints, beatmapId, beatmapSetId, mode, folderName };
  }
  r.int(); // Local user permissions are not library metadata.
  r.finish();
}
