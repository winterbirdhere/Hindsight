import { Beatmap, DEFAULT_BEATMAP_DIFFICULTY, HitCircle, OsuAction, ReplayAnalysisRuleset } from "@osujs/core";
import type { OsuReplay } from "../../../model/OsuReplay";
import { GameSimulator } from "./GameSimulator";

const FAILURE_TIME = 1_460;

function failedReplayFixture(ruleset: ReplayAnalysisRuleset, trailingFrames: boolean) {
  const circles = [1_000, 1_300, 1_600].map((hitTime, index) => {
    const circle = new HitCircle();
    circle.id = `failure-${index}`;
    circle.hitTime = hitTime;
    circle.approachDuration = 600;
    circle.position = { x: 256, y: 192 };
    return circle;
  });
  const beatmap = new Beatmap(circles, DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
  const source: OsuReplay = {
    md5hash: `failed-${ruleset}`,
    beatmapMd5: "failure-map",
    gameMode: 0,
    gameVersion: ruleset === "lazer" ? 30_000_016 : 20200101,
    mods: [],
    player: "Failed player",
    frames: [
      { time: 0, position: circles[0].position, actions: [] },
      { time: 1_000, position: circles[0].position, actions: [OsuAction.leftButton] },
      { time: 1_001, position: circles[0].position, actions: [] },
      { time: FAILURE_TIME, position: circles[1].position, actions: [] },
      ...(trailingFrames ? [{ time: 2_000, position: circles[2].position, actions: [] }] : []),
    ],
    // An exported source score may also count objects after the fatal miss.
    // Those totals must not replace the two actually judged objects at failure.
    statistics: {
      count300: 1,
      count100: 0,
      count50: 0,
      countMiss: 2,
      maxCombo: 1,
      score: 123_456,
      perfectCombo: false,
    },
    ...(ruleset === "lazer" ? { lazerScoreMetadata: { statistics: { great: 1, miss: 2 }, rank: "F" } } : {}),
    ...(trailingFrames
      ? {
          lifeBar: [
            { time: 1_001, health: 0.5 },
            { time: FAILURE_TIME, health: 0 },
          ],
        }
      : {}),
  };
  return { beatmap, source, circles };
}

describe("GameSimulator failed replay source totals", () => {
  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "keeps a confirmed %s health-zero endpoint when it is also the final recorded frame",
    (ruleset) => {
      const { beatmap, source } = failedReplayFixture(ruleset, true);
      if (!source.statistics) throw new Error("Failed replay fixture must include source statistics");
      source.frames = source.frames.filter((frame) => frame.time <= FAILURE_TIME);
      source.statistics = { ...source.statistics, countMiss: 0 };
      if (ruleset === "lazer") source.lazerScoreMetadata = { statistics: { great: 1 }, rank: "F" };
      const simulator = new GameSimulator();
      simulator.simulateReplay(beatmap, source);

      expect(simulator.getFinalInfoForRuleset(ruleset)?.verdictCounts).toEqual([1, 0, 0, 1]);
      simulator.simulate(FAILURE_TIME);
      expect(simulator.getCurrentState()?.currentTime).toBe(FAILURE_TIME);
    },
  );

  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "keeps the fatal %s miss in performance inputs when the source header omits it",
    (ruleset) => {
      const { beatmap, source } = failedReplayFixture(ruleset, true);
      if (!source.statistics) throw new Error("Failed replay fixture must include source statistics");
      source.statistics = { ...source.statistics, countMiss: 0 };
      if (ruleset === "lazer") source.lazerScoreMetadata = { statistics: { great: 1 }, rank: "F" };
      const simulator = new GameSimulator();
      simulator.simulateReplay(beatmap, source);

      expect(simulator.getFinalInfoForRuleset(ruleset)?.verdictCounts).toEqual([1, 0, 0, 1]);
      const input = simulator.getPerformanceInputs().find((candidate) => candidate.mode === ruleset);
      expect(input?.states[input.states.length - 1]).toMatchObject({
        passedObjects: 2,
        statistics: { great: 1, miss: 1 },
      });
    },
  );

  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "applies the same %s scoring endpoint to primary and comparison replays",
    (ruleset) => {
      for (const hasHealthTimestamp of [true, false]) {
        const { beatmap, source } = failedReplayFixture(ruleset, true);
        if (!hasHealthTimestamp) {
          if (!source.statistics) throw new Error("Failed replay fixture must include source statistics");
          source.lifeBar = undefined;
          source.statistics = { ...source.statistics, countMiss: 1 };
          if (ruleset === "lazer") source.lazerScoreMetadata = { statistics: { great: 1, miss: 1 }, rank: "F" };
        }
        const simulator = new GameSimulator();
        simulator.simulateReplay(beatmap, source);
        const comparison = simulator.compareReplay(beatmap, { ...source, md5hash: "same-failed-score" }, ruleset);

        expect(comparison.status).toBe("READY");
        if (comparison.status !== "READY") throw new Error("Failed replay comparison must be compatible");
        expect(comparison.secondary.events).toEqual(comparison.primary.events);
        expect(comparison.secondary.verdictCountsInput).toEqual([1, 0, 0, 1]);
        expect(comparison.secondary.verdictCountsInput).toEqual(comparison.primary.verdictCountsInput);
        expect(comparison.secondary.maxComboInput).toEqual(comparison.primary.maxComboInput);
      }
    },
  );

  it("keeps failed Stable final analysis and comparison limited to the judged prefix", () => {
    const { beatmap, source } = failedReplayFixture("stable", true);
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, source);

    expect(simulator.getFinalInfoForRuleset("stable")?.verdictCounts).toEqual([1, 0, 0, 1]);
    const comparison = simulator.compareAutoplayReference();
    expect(comparison).toMatchObject({
      status: "READY",
      primary: { verdictCountsInput: [1, 0, 0, 1] },
    });
  });

  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "keeps the fatal %s miss without importing later source misses at terminal health zero",
    (ruleset) => {
      const { beatmap, source, circles } = failedReplayFixture(ruleset, true);
      const simulator = new GameSimulator();
      simulator.simulateReplay(beatmap, source);

      simulator.simulate(1_200);
      expect(simulator.getCurrentInfo().verdictCounts).toEqual([1, 0, 0, 0]);
      expect(simulator.getCurrentScoreStats().countMiss).toBe(0);

      simulator.simulate(FAILURE_TIME);
      expect(simulator.getCurrentInfo().verdictCounts).toEqual([1, 0, 0, 1]);
      const failedStats = simulator.getCurrentScoreStats();
      expect(failedStats).toMatchObject({ count100: 0, count50: 0, countMiss: 1 });
      expect(simulator.getFinalInfoForRuleset(ruleset)?.verdictCounts).toEqual([1, 0, 0, 1]);
      expect(simulator.getFinalScoreStatsForRuleset(ruleset)).toEqual(failedStats);

      simulator.simulate(10_000);
      expect(simulator.getCurrentState()?.currentTime).toBe(FAILURE_TIME);
      expect(simulator.getCurrentScoreStats()).toEqual(failedStats);
      expect(simulator.hits).toHaveLength(2);
      expect(simulator.getEventsForRuleset(ruleset)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ hitObjectId: circles[2].id })]),
      );

      const otherRuleset = ruleset === "stable" ? "lazer" : "stable";
      expect(simulator.setRulesetFocus(otherRuleset)).toBe(true);
      simulator.simulate(10_000);
      expect(simulator.getCurrentInfo().verdictCounts).toEqual([1, 0, 0, 1]);
      expect(simulator.getCurrentScoreStats().countMiss).toBe(1);

      expect(simulator.setRulesetFocus(ruleset)).toBe(true);
      simulator.simulate(1_200);
      expect(simulator.getCurrentScoreStats().countMiss).toBe(0);
      simulator.simulate(10_000);
      expect(simulator.getCurrentScoreStats()).toEqual(failedStats);
    },
  );

  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "retains the judged %s prefix when replay frames end early without a health timestamp",
    (ruleset) => {
      const { beatmap, source } = failedReplayFixture(ruleset, false);
      const simulator = new GameSimulator();
      simulator.simulateReplay(beatmap, source);

      simulator.simulate(1_200);
      expect(simulator.getCurrentScoreStats().countMiss).toBe(0);
      simulator.simulate(FAILURE_TIME);
      expect(simulator.getCurrentInfo().verdictCounts).toEqual([1, 0, 0, 1]);
      expect(simulator.getCurrentScoreStats().countMiss).toBe(1);
      expect(simulator.getFinalInfoForRuleset(ruleset)?.verdictCounts).toEqual([1, 0, 0, 1]);
      expect(simulator.getFinalScoreStatsForRuleset(ruleset)?.countMiss).toBe(1);

      simulator.simulate(10_000);
      expect(simulator.getCurrentScoreStats().countMiss).toBe(1);
      expect(simulator.getCurrentState()?.currentTime).toBe(FAILURE_TIME);
    },
  );

  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "preserves the fatal %s miss when the source header omits its judgement",
    (ruleset) => {
      const { beatmap, source } = failedReplayFixture(ruleset, true);
      if (!source.statistics) throw new Error("Failed replay fixture must include source statistics");
      source.statistics = { ...source.statistics, countMiss: 0 };
      if (ruleset === "lazer") source.lazerScoreMetadata = { statistics: { great: 1 }, rank: "F" };
      const simulator = new GameSimulator();
      simulator.simulateReplay(beatmap, source);

      simulator.simulate(FAILURE_TIME);
      expect(simulator.getCurrentInfo().verdictCounts).toEqual([1, 0, 0, 1]);
      expect(simulator.getCurrentScoreStats().countMiss).toBe(1);
      expect(simulator.getFinalInfoForRuleset(ruleset)?.verdictCounts).toEqual([1, 0, 0, 1]);
    },
  );

  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "retains reconstructed %s grades when source totals describe the same judged prefix with different grades",
    (ruleset) => {
      const { beatmap, source } = failedReplayFixture(ruleset, true);
      if (!source.statistics) throw new Error("Failed replay fixture must include source statistics");
      source.statistics = { ...source.statistics, count300: 0, count100: 1, countMiss: 1 };
      if (ruleset === "lazer") source.lazerScoreMetadata = { statistics: { ok: 1, miss: 1 }, rank: "F" };
      const simulator = new GameSimulator();
      simulator.simulateReplay(beatmap, source);

      simulator.simulate(FAILURE_TIME);
      expect(simulator.getCurrentInfo().verdictCounts).toEqual([1, 0, 0, 1]);
      expect(simulator.getCurrentScoreStats()).toMatchObject({ count100: 0, countMiss: 1 });
      expect(simulator.getFinalInfoForRuleset(ruleset)?.verdictCounts).toEqual([1, 0, 0, 1]);
      expect(simulator.getFinalScoreStatsForRuleset(ruleset)).toMatchObject({ count100: 0, countMiss: 1 });
    },
  );
});
