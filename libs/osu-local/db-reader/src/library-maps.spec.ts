import { parseLibraryMaps } from "./library-maps";
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const f32 = (n: number) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
const f64 = (n: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
const str = (s: string) => s ? Buffer.concat([Buffer.from([11, Buffer.byteLength(s)]), Buffer.from(s)]) : Buffer.from([0]);
type Rating = [modsBitmask: number, stars: number];
function fixture(version: number, starCount = 1, status = 4, ratings: Rating[] = [[0, 5.25]], mode = 0, secondaryRatings: Rating[] | null = null) {
  const cache = (values: Rating[] | null) => values === null ? i32(-1) : Buffer.concat([i32(values.length), ...values.map(([mods, stars]) =>
    Buffer.concat([Buffer.from([8]), i32(mods), Buffer.from([version >= 20250107 ? 12 : 13]), version >= 20250107 ? f32(stars) : f64(stars)]))]);
  const stars = starCount !== 1 ? i32(starCount) : cache(ratings);
  const body = Buffer.concat([
    ...["Artist", "", "Title", "", "Mapper", "Difficulty", "audio.mp3", "a".repeat(32), "map.osu"].map(str),
    Buffer.from([status]), Buffer.alloc(6), Buffer.alloc(8), f32(9), f32(4), f32(5), f32(8), f64(1.4),
    stars, cache(secondaryRatings), i32(-1), i32(-1), i32(120), i32(140000), i32(-1), i32(1), f64(500), f64(0), Buffer.from([1]),
    i32(-1), i32(24), i32(0), Buffer.alloc(4), Buffer.alloc(2), f32(0.7), Buffer.from([mode]), str(""), str(""),
    Buffer.alloc(2), str(""), Buffer.from([1]), Buffer.alloc(8), Buffer.from([0]), str("24 Folder"), Buffer.alloc(8),
    Buffer.alloc(5), i32(0), Buffer.from([0]),
  ]);
  const entry = version < 20191106 ? Buffer.concat([i32(body.length), body]) : body;
  return Buffer.concat([i32(version), i32(1), Buffer.from([0]), Buffer.alloc(8), str("P"), i32(2), entry, entry, i32(1)]);
}

it.each([20191105, 20191106, 20191107, 20250106, 20250107, 20260924])("keeps consecutive map entries aligned for database version %i", version => {
  const maps = [...parseLibraryMaps(fixture(version))];
  expect(maps).toHaveLength(2);
  expect(maps[1]).toMatchObject({ databaseVersion: version, artist: "Artist", title: "Title", creator: "Mapper",
    difficulty: "Difficulty", folderName: "24 Folder", fileName: "map.osu", beatmapId: -1, rankedStatus: 4,
    drainTimeSeconds: 120, totalTimeMs: 140000, stdStarRatings: [{ modsBitmask: 0, stars: 5.25 }],
    timingPoints: [{ beatLengthMs: 500, offsetMs: 0, uninherited: true }] });
});

it("retains missing star caches and raw unknown status without inventing zero stars or graveyard", () => {
  expect([...parseLibraryMaps(fixture(20260924, -1, 255))][0]).toMatchObject({ stdStarRatings: null, rankedStatus: 255 });
});

describe.each([20191105, 20250106, 20250107, 20260924])("optional cached ratings in database version %i", version => {
  it("omits unavailable entries while preserving valid mod ratings and consecutive map metadata", () => {
    const maps = [...parseLibraryMaps(fixture(version, 1, 4, [[0, -2.25], [64, 6.5], [256, -1], [16, 0]]))];
    expect(maps).toHaveLength(2);
    expect(maps[1]).toMatchObject({ mode: 0, title: "Title", folderName: "24 Folder", totalTimeMs: 140000,
      stdStarRatings: [{ modsBitmask: 64, stars: 6.5 }, { modsBitmask: 16, stars: 0 }] });
  });

  it.each([0, 1, 2, 3])("keeps all-unavailable ratings unknown for map ruleset %i", mode => {
    const maps = [...parseLibraryMaps(fixture(version, 1, 4, [[0, -2.25], [64, -3.5]], mode, [[0, -1], [16, 4.5]]))];
    expect(maps).toHaveLength(2);
    expect(maps[1]).toMatchObject({ mode, stdStarRatings: null, title: "Title", beatmapSetId: 24,
      timingPoints: [{ beatLengthMs: 500, offsetMs: 0, uninherited: true }] });
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite cached rating %s", rating => {
    expect(() => [...parseLibraryMaps(fixture(version, 1, 4, [[0, -2.25], [64, rating]]))]).toThrow(/Invalid database (float|double)/);
  });

  it.each(["mods", "number"])("still rejects invalid %s type after an unavailable rating", field => {
    const data = fixture(version, 1, 4, [[0, -2.25], [64, 6.5]]);
    const marker = Buffer.concat([Buffer.from([8]), i32(64), Buffer.from([version >= 20250107 ? 12 : 13])]);
    const pair = data.indexOf(marker);
    data[pair + (field === "mods" ? 0 : 5)] = 7;
    expect(() => [...parseLibraryMaps(data)]).toThrow(field === "mods" ? "Invalid star mod type" : "Invalid star number type");
  });

  it("retains the star-cache count limit", () => {
    expect(() => [...parseLibraryMaps(fixture(version, 4097))]).toThrow("Map star cache exceeds limit");
  });

  it("rejects a truncated following entry after unavailable ratings", () => {
    const data = fixture(version, 1, 4, [[0, -2.25]]);
    expect(() => [...parseLibraryMaps(data.subarray(0, -6))]).toThrow("Truncated database");
  });
});

it("retains the declared entry-length guard after unavailable ratings", () => {
  const data = fixture(20191105, 1, 4, [[0, -2.25]]);
  const firstEntry = 4 + 4 + 1 + 8 + 3 + 4;
  data.writeInt32LE(data.readInt32LE(firstEntry) + 1, firstEntry);
  expect(() => [...parseLibraryMaps(data)]).toThrow("Invalid map entry length");
});

it("rejects truncated and excessive records rather than claiming a completed map index", () => {
  const data = fixture(20260924);
  expect(() => [...parseLibraryMaps(data.subarray(0, -1))]).toThrow();
  expect(() => [...parseLibraryMaps(Buffer.concat([data, Buffer.from([0])]))]).toThrow(/trailing/i);
});
