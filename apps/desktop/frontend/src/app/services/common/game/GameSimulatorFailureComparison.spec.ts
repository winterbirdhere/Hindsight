import { Beatmap, DEFAULT_BEATMAP_DIFFICULTY, HitCircle, OsuAction, ReplayAnalysisRuleset } from "@osujs/core";
import type { OsuReplay } from "../../../model/OsuReplay";
import { GameSimulator } from "./GameSimulator";

function fixture(ruleset: ReplayAnalysisRuleset = "stable") {
  const circles = [1000, 1300, 1600, 1900].map((hitTime, index) => {
    const circle = new HitCircle();
    circle.id = `failure-comparison-${index}`;
    circle.hitTime = hitTime;
    circle.approachDuration = 600;
    circle.position = { x: 256, y: 192 };
    return circle;
  });
  const beatmap = new Beatmap(circles, DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
  const replay: OsuReplay = {
    md5hash: "failure-comparison",
    beatmapMd5: "failure-comparison-map",
    gameMode: 0,
    gameVersion: ruleset === "lazer" ? 30000016 : 20260711,
    mods: [],
    player: "Failed player",
    frames: [
      { time: 0, position: circles[0].position, actions: [] },
      { time: 1000, position: circles[0].position, actions: [OsuAction.leftButton] },
      { time: 1001, position: circles[0].position, actions: [] },
      { time: 1460, position: circles[1].position, actions: [] },
    ],
    lifeBar: [
      { time: 1000, health: 1 },
      { time: 1470, health: 0 },
      { time: 2100, health: 0 },
    ],
    statistics: { count300: 1, count100: 0, count50: 0, countMiss: 3, maxCombo: 1, score: 300, perfectCombo: false },
    ...(ruleset === "lazer" ? { lazerScoreMetadata: { statistics: { great: 1, miss: 3 }, rank: "F" } } : {}),
  };
  return { beatmap, replay };
}

describe("failed replay comparison scope", () => {
  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "attributes only the %s misses reproduced after scoring stops, without changing playback or PP inputs",
    (ruleset) => {
      const { beatmap, replay } = fixture(ruleset);
      const simulator = new GameSimulator();
      simulator.simulateReplay(beatmap, replay);
      const validation = simulator.validation$.value;
      expect(validation.postFailureMisses).toEqual({ count: 2, scoringEndTime: 1460, recordedEndTime: 2100 });
      expect(validation).toMatchObject({
        verified: false,
        expectedCounts: [1, 0, 0, 3],
        simulatedCounts: [1, 0, 0, 1],
      });
      simulator.simulate(10000);
      expect(simulator.getCurrentInfo().verdictCounts).toEqual([1, 0, 0, 1]);
      expect(
        simulator
          .getPerformanceInputs()
          .find((input) => input.mode === ruleset)
          ?.states.at(-1),
      ).toMatchObject({
        passedObjects: 2,
        statistics: { great: 1, miss: 1 },
      });
      const comparison = simulator.compareReplay(beatmap, { ...replay, md5hash: "other-failed-replay" }, ruleset);
      expect(comparison.status).toBe("READY");
      if (comparison.status !== "READY") throw Error("Expected comparison");
      expect(comparison.validations.secondary?.postFailureMisses).toEqual(validation.postFailureMisses);
    },
  );

  it.each([
    "missing health",
    "health recovery",
    "No Fail",
    "unexplained misses",
    "different grades",
    "omitted fatal miss",
  ])("keeps a miss discrepancy visible with %s", (scenario) => {
    const { beatmap, replay } = fixture();
    if (!replay.statistics) throw Error("Expected fixture statistics");
    if (scenario === "missing health") replay.lifeBar = undefined;
    if (scenario === "health recovery") replay.lifeBar?.push({ time: 2200, health: 0.5 });
    if (scenario === "No Fail") replay.mods = ["NO_FAIL"];
    if (scenario === "unexplained misses") replay.statistics.countMiss = 2;
    if (scenario === "different grades") {
      replay.statistics.count300 = 0;
      replay.statistics.count100 = 1;
    }
    if (scenario === "omitted fatal miss") {
      replay.statistics.countMiss = 0;
      replay.lifeBar = [
        { time: 1000, health: 1 },
        { time: 1460, health: 0 },
      ];
    }
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay);
    expect(simulator.validation$.value.postFailureMisses).toBeUndefined();
    expect(simulator.validation$.value.verified).toBe(false);
  });

  it("retains a real combo discrepancy when the extra saved misses are explained", () => {
    const { beatmap, replay } = fixture();
    if (!replay.statistics) throw Error("Expected fixture statistics");
    replay.statistics.maxCombo = 2;
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay);
    expect(simulator.validation$.value.postFailureMisses?.count).toBe(2);
    expect(simulator.validation$.value.maxComboMatch).toBe(false);
  });

  it("uses the failure cutoff when replay frames continue after terminal health zero", () => {
    const { beatmap, replay } = fixture();
    replay.lifeBar = [
      { time: 1000, health: 1 },
      { time: 1460, health: 0 },
      { time: 2100, health: 0 },
    ];
    replay.frames.push({ time: 2100, position: { x: 256, y: 192 }, actions: [] });
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay);
    expect(simulator.validation$.value.postFailureMisses).toEqual({
      count: 2,
      scoringEndTime: 1460,
      recordedEndTime: 2100,
    });
    simulator.simulate(10000);
    expect(simulator.getCurrentInfo().verdictCounts).toEqual([1, 0, 0, 1]);
  });

  it("does not apply the source failure explanation to another ruleset", () => {
    const { beatmap, replay } = fixture();
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay);
    simulator.setRulesetFocus("lazer");
    expect(simulator.validation$.value.postFailureMisses).toBeUndefined();
  });
});
