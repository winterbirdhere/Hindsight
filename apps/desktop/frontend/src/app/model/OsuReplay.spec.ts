import {
  FIRST_LAZER_REPLAY_VERSION,
  isLazerReplay,
  legacyModsFromLazerMods,
  parseReplayLifeBar,
  parseLazerReplayScoreMetadata,
  replayClockRate,
} from "./OsuReplay";

describe("replay client format", () => {
  it("recognizes confirmed Lazer origin without changing the legacy container version", () => {
    const replay = { gameVersion: 20_260_711, sourceClient: "lazer", sourceProvenance: "user-confirmed" } as const;
    expect(isLazerReplay(replay)).toBe(true);
    expect(replay.gameVersion).toBe(20_260_711);
  });

  it("keeps embedded native metadata authoritative over a conflicting saved Stable hint", () => {
    const replay = {
      gameVersion: 20_260_711,
      lazerMods: [],
      sourceClient: "stable",
      sourceProvenance: "user-confirmed",
    } as const;
    expect(isLazerReplay(replay)).toBe(true);
  });

  it("requires confirmation for an otherwise unmarked source hint", () => {
    const replay = { gameVersion: 20_260_711, sourceClient: "lazer" } as const;
    expect(isLazerReplay(replay)).toBe(false);
  });

  it("recognizes osu!lazer's reserved replay-version range", () => {
    expect(FIRST_LAZER_REPLAY_VERSION).toBe(30_000_000);
    expect(isLazerReplay({ gameVersion: 30_000_000 })).toBe(true);
    // Header version from solo-replay-osu_5648740_7336691327.osr.
    expect(isLazerReplay({ gameVersion: 30_000_016 })).toBe(true);
  });

  it("does not confuse Stable's date-style versions with lazer", () => {
    expect(isLazerReplay({ gameVersion: 29_999_999 })).toBe(false);
    expect(isLazerReplay({ gameVersion: 20_260_825 })).toBe(false);
    expect(isLazerReplay({ gameVersion: 0 })).toBe(false);
    expect(isLazerReplay({ gameVersion: Number.NaN })).toBe(false);
  });
});

describe("native replay score metadata", () => {
  it("retains validated native statistics and rank without assuming a passed flag", () => {
    expect(
      parseLazerReplayScoreMetadata({
        statistics: { great: 3, large_tick_hit: 2 },
        maximum_statistics: { great: 3, slider_tail_hit: 1 },
        rank: "F",
      }),
    ).toEqual({
      statistics: { great: 3, large_tick_hit: 2 },
      maximumStatistics: { great: 3, slider_tail_hit: 1 },
      rank: "F",
    });
    expect(parseLazerReplayScoreMetadata({ mods: [] })).toBeUndefined();
  });

  it.each([-1, 1.2, Number.NaN, Number.POSITIVE_INFINITY, "1"])(
    "rejects a whole invalid statistics dictionary containing %p",
    (count) => {
      expect(parseLazerReplayScoreMetadata({ statistics: { great: 1, ok: count } })).toBeUndefined();
    },
  );
});

describe("native replay mods", () => {
  it("retains native TouchDevice in the legacy-compatible display model", () => {
    expect(legacyModsFromLazerMods([{ acronym: "TD" }])).toEqual(["TOUCH_DEVICE"]);
  });
  it("projects native legacy equivalents while preserving variant base bits", () => {
    expect(legacyModsFromLazerMods([{ acronym: "NC" }, { acronym: "PF" }, { acronym: "CL" }])).toEqual([
      "DOUBLE_TIME",
      "NIGHT_CORE",
      "SUDDEN_DEATH",
      "PERFECT",
    ]);
    expect(legacyModsFromLazerMods([])).toEqual([]);
    expect(legacyModsFromLazerMods([{ acronym: "DA" }, { acronym: "FUTURE" }])).toEqual([]);
  });

  it("uses native custom rates while keeping legacy fallback rates", () => {
    expect(replayClockRate({ mods: ["DOUBLE_TIME"] })).toBe(1.5);
    expect(replayClockRate({ mods: ["HALF_TIME"] })).toBe(0.75);
    expect(replayClockRate({ mods: ["DOUBLE_TIME"], lazerMods: [] })).toBe(1);
    expect(replayClockRate({ mods: ["HALF_TIME"], lazerMods: [{ acronym: "CL" }] })).toBe(1);
    expect(replayClockRate({ mods: [], lazerMods: [{ acronym: "DT", settings: { speed_change: 1.2 } }] })).toBe(1.2);
    expect(replayClockRate({ mods: [], lazerMods: [{ acronym: "HT", settings: { speed_change: 0.6 } }] })).toBe(0.6);
  });
});

describe("replay life bar", () => {
  it("parses, sorts, clamps and ignores malformed legacy life samples", () => {
    expect(parseReplayLifeBar("2000|1.2,bad,1000|0.42,3000|-1")).toEqual([
      { time: 1000, health: 0.42 },
      { time: 2000, health: 1 },
      { time: 3000, health: 0 },
    ]);
  });
});
