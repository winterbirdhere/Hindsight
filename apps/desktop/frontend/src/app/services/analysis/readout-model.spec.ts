import { DEFAULT_REPLAY_DISPLAY_SETTINGS } from "./replay-display-settings";
import { buildReadoutModel } from "./readout-model";
import { REWIND_COLORS } from "../../styles/tokens";

const base = {
  metadata: { artist: "xi", title: "ANiMA", difficultyName: "Oberum Primus", creator: "Kalindraz" },
  player: "WinterBird",
  mods: [] as string[],
  ruleset: "stable" as const,
  info: { verdictCounts: [731, 55, 2, 11] },
  stats: { count100: 55, count50: 2, countMiss: 11, sliderBreakCount: 6, sliderEndMissCount: 9, maxComboSoFar: 441, mapMaxCombo: 1140 },
  performance: { point: { time: 0, pp: 155.44, sr: 6.659 }, description: "Stable" },
  timing: { ur: "174.0", bias: "-2.8 ms" },
  settings: DEFAULT_REPLAY_DISPLAY_SETTINGS,
};

describe("buildReadoutModel", () => {
  it("builds the approved Stable readout without an ACC row", () => {
    const model = buildReadoutModel(base);
    expect(model.identity).toEqual({
      artist: "xi",
      title: "ANiMA",
      difficulty: "Oberum Primus",
      mapper: "Kalindraz",
      player: "WinterBird",
      mods: "NM",
      ruleset: "Stable",
    });
    expect(model.performance).toEqual({ pp: "155.4", stars: "6.65" });
    expect(model.rows).toEqual([
      { key: "ur", label: "UR", value: "174.0" },
      { key: "bias", label: "Bias", value: "−2.8", suffix: " ms" },
      { key: "combo", label: "Max Combo", value: "441", suffix: "/1140" },
    ]);
    expect(model.rows.map((row) => row.label)).not.toContain("ACC");
    expect(model.judgements.map((row) => [row.key, row.count])).toEqual([
      ["100", 55],
      ["50", 2],
      ["miss", 11],
      ["sliderBreak", 6],
      ["sliderEnd", 9],
    ]);
    // The 300 row is gone but the shares still count the 300s.
    expect(model.judgements[0].share).toBeCloseTo(55 / 799);
    expect(model.judgements[2].color).toBe(REWIND_COLORS.judgementMiss);
    expect(model.judgements[3].share).toBeUndefined();
  });

  it("switches the slider row to Tick in Lazer and lists mods in osu! order", () => {
    const model = buildReadoutModel({
      ...base,
      ruleset: "lazer",
      mods: ["DOUBLE_TIME", "HIDDEN"],
      stats: { ...base.stats, sliderBreakCount: undefined, sliderTickMissCount: 4 },
    });
    expect(model.identity.mods).toBe("HDDT");
    expect(model.identity.ruleset).toBe("Lazer");
    expect(model.judgements.map((row) => row.label)).toContain("Tick");
    expect(model.judgements.map((row) => row.label)).not.toContain("Break");
  });

  it("honours the display toggles and missing values", () => {
    const model = buildReadoutModel({
      ...base,
      metadata: undefined,
      performance: { description: "Calculating" },
      timing: undefined,
      settings: { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, starRatingEnabled: false, liveResult100Enabled: false, liveResult50Enabled: false, liveResultMissEnabled: false, maxComboEnabled: false, timingBiasEnabled: false },
    });
    expect(model.identity.title).toBe("Unknown beatmap");
    expect(model.performance).toEqual({ pp: "—" });
    expect(model.rows).toEqual([{ key: "ur", label: "UR", value: "—" }]);
    expect(model.judgements.map((row) => row.key)).toEqual(["sliderBreak", "sliderEnd"]);
  });

  it("does not divide by zero before the first judgement", () => {
    const model = buildReadoutModel({ ...base, info: { verdictCounts: [0, 0, 0, 0] }, stats: { ...base.stats, count100: 0, count50: 0, countMiss: 0 } });
    expect(model.judgements.slice(0, 3).every((row) => row.share === 0)).toBe(true);
  });

  it("drops the 300 row, shortens the slider labels and separates the bias unit", () => {
    const model = buildReadoutModel({
      ruleset: "stable",
      info: { verdictCounts: [100, 25, 2, 2] },
      stats: { count100: 25, count50: 2, countMiss: 2, maxComboSoFar: 441, mapMaxCombo: 1140, sliderBreakCount: 2, sliderEndMissCount: 4 } as never,
      timing: { ur: "178.0", bias: "-1.5 ms" },
      settings: {
        performancePointsEnabled: true,
        starRatingEnabled: true,
        liveResult100Enabled: true,
        liveResult50Enabled: true,
        liveResultMissEnabled: true,
        liveResultSliderBreakEnabled: true,
        liveResultSliderTickEnabled: true,
        liveResultSliderEndEnabled: true,
        maxComboEnabled: true,
        unstableRateEnabled: true,
        timingBiasEnabled: true,
      },
    });
    expect(model.judgements.map((row) => [row.key, row.label, row.count])).toEqual([
      ["100", "100", 25],
      ["50", "50", 2],
      ["miss", "Miss", 2],
      ["sliderBreak", "Break", 2],
      ["sliderEnd", "End", 4],
    ]);
    expect(model.rows).toEqual([
      { key: "ur", label: "UR", value: "178.0" },
      { key: "bias", label: "Bias", value: "−1.5", suffix: " ms" },
      { key: "combo", label: "Max Combo", value: "441", suffix: "/1140" },
    ]);
  });

  describe("per-result live rows", () => {
    const allRows = {
      ...base,
      stats: { ...base.stats, sliderBreakCount: 6, sliderTickMissCount: 4, sliderEndMissCount: 9 },
    };
    const rowKeyFor = {
      liveResult100Enabled: "100",
      liveResult50Enabled: "50",
      liveResultMissEnabled: "miss",
      liveResultSliderBreakEnabled: "sliderBreak",
      liveResultSliderTickEnabled: "sliderTick",
      liveResultSliderEndEnabled: "sliderEnd",
    } as const;
    const keysOf = (model: ReturnType<typeof buildReadoutModel>) => model.judgements.map((row) => row.key);

    it.each(Object.entries(rowKeyFor))("gates every live result on its own key: %s", (settingKey, rowKey) => {
      const everything = keysOf(buildReadoutModel(allRows));
      expect(everything).toEqual(Object.values(rowKeyFor));
      const only = buildReadoutModel({
        ...allRows,
        settings: { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, [settingKey]: false },
      });
      expect(keysOf(only)).toEqual(everything.filter((key) => key !== rowKey));
      const counts = new Map(buildReadoutModel(allRows).judgements.map((row) => [row.key, row.count]));
      for (const row of only.judgements) expect(row.count).toBe(counts.get(row.key));
    });

    it("keeps the shares of the remaining rows when one result is hidden", () => {
      const all = buildReadoutModel(allRows).judgements.find((row) => row.key === "100");
      const hidden = buildReadoutModel({
        ...allRows,
        settings: { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, liveResult50Enabled: false },
      });
      expect(hidden.judgements.map((row) => row.key)).not.toContain("50");
      expect(hidden.judgements.find((row) => row.key === "100")?.share).toBe(all?.share);
      expect(all?.share).toBeCloseTo(55 / 799);
    });
  });

  it("leaves a bias placeholder without a unit", () => {
    const model = buildReadoutModel({
      ruleset: "stable",
      timing: { ur: "—", bias: "—" },
      settings: { timingBiasEnabled: true } as never,
    });
    expect(model.rows).toEqual([{ key: "bias", label: "Bias", value: "—" }]);
  });
});
