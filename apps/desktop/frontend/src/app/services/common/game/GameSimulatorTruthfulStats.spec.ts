import { Beatmap, DEFAULT_BEATMAP_DIFFICULTY, HitCircle, OsuAction, ReplayAnalysisRuleset } from "@osujs/core";
import type { OsuReplay } from "../../../model/OsuReplay";
import { GameSimulator } from "./GameSimulator";

function fixture(ruleset: ReplayAnalysisRuleset) {
  const circles = [1000, 1200, 1600].map((hitTime, index) => {
    const circle = new HitCircle();
    circle.id = `truthful-${index}`;
    circle.hitTime = hitTime;
    circle.approachDuration = 600;
    circle.position = { x: 256, y: 192 };
    return circle;
  });
  const beatmap = new Beatmap(circles, DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
  const replay: OsuReplay = {
    md5hash: "truthful-source",
    beatmapMd5: "truthful-map",
    gameMode: 0,
    gameVersion: ruleset === "lazer" ? 30000016 : 20200101,
    player: "Source player",
    mods: [],
    frames: [
      { time: 0, position: circles[0].position, actions: [] },
      { time: 1000, position: circles[0].position, actions: [OsuAction.leftButton] },
      { time: 1010, position: circles[0].position, actions: [] },
      { time: 1200, position: circles[1].position, actions: [OsuAction.leftButton] },
      { time: 1210, position: circles[1].position, actions: [] },
      { time: 2000, position: circles[2].position, actions: [] },
    ],
    statistics: {
      count300: 2,
      count100: 0,
      count50: 0,
      countMiss: 1,
      maxCombo: 2,
      score: 600,
      perfectCombo: false,
    },
    ...(ruleset === "lazer" ? { lazerScoreMetadata: { statistics: { great: 2, miss: 1 } } } : {}),
  };
  if (!replay.statistics) throw new Error("Fixture source statistics are required");
  const differentHeader: OsuReplay = {
    ...replay,
    statistics: { ...replay.statistics, count300: 1, count100: 1, maxCombo: 1, score: 123456 },
    ...(ruleset === "lazer" ? { lazerScoreMetadata: { statistics: { great: 1, ok: 1, miss: 1 } } } : {}),
  };
  const original = new GameSimulator();
  original.simulateReplay(beatmap, replay);
  const changed = new GameSimulator();
  changed.simulateReplay(beatmap, differentHeader);
  return { beatmap, original, changed, differentHeader };
}

describe("reconstructed statistics remain independent of source totals", () => {
  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "keeps %s live and final simulation unchanged when only source grades, combo and score change",
    (ruleset) => {
      const { original, changed } = fixture(ruleset);
      for (const time of [1200, 2000, 10000, 1200]) {
        original.simulate(time);
        changed.simulate(time);
        expect(changed.getCurrentInfo()).toEqual(original.getCurrentInfo());
        expect(changed.getCurrentScoreStats()).toEqual(original.getCurrentScoreStats());
        expect(changed.getCurrentState()).toEqual(original.getCurrentState());
      }
      expect(changed.getFinalInfoForRuleset(ruleset)).toEqual(original.getFinalInfoForRuleset(ruleset));
      expect(changed.getFinalScoreStatsForRuleset(ruleset)).toEqual(original.getFinalScoreStatsForRuleset(ruleset));
      expect(changed.getEventsForRuleset(ruleset)).toEqual(original.getEventsForRuleset(ruleset));
      expect(changed.validation$.getValue()).toMatchObject({
        verified: false,
        judgementTotalsMatch: false,
        maxComboMatch: false,
        expectedCounts: [1, 1, 0, 1],
        simulatedCounts: [2, 0, 0, 1],
      });
    },
  );

  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "keeps %s terminal performance inputs unchanged when source statistics disagree",
    (ruleset) => {
      const { original, changed } = fixture(ruleset);
      expect(changed.getPerformanceInputs()).toEqual(original.getPerformanceInputs());
    },
  );

  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "uses reconstructed %s comparison grades and combo while retaining validation warnings",
    (ruleset) => {
      const { beatmap, original, differentHeader } = fixture(ruleset);
      const comparison = original.compareReplay(beatmap, { ...differentHeader, md5hash: "other-header" }, ruleset);
      expect(comparison.status).toBe("READY");
      if (comparison.status !== "READY") throw new Error("Comparison fixture must be compatible");
      expect(comparison.secondary.verdictCountsInput).toEqual(comparison.primary.verdictCountsInput);
      expect(comparison.secondary.accuracyInput).toEqual(comparison.primary.accuracyInput);
      expect(comparison.secondary.maxComboInput).toEqual(comparison.primary.maxComboInput);
      expect(comparison.validations.secondary?.verified).toBe(false);
      expect(comparison.secondary.scoreInput).toBe(123456);
    },
  );
});
