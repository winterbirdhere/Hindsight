import { buildBeatmap, parseBlueprint, ReplayFrame, Slider } from "@osujs/core";
import { createAnalyticAutoplayReference } from "../../analysis/autoplay-reference";
import { GameSimulator } from "./GameSimulator";

describe("Stable checkpoint layout integration", () => {
  it.each([
    { object: "100,192,1000,2,0,L|500:192,1,142.800001", stableCombo: 2, nativeCombo: 3 },
    { object: "100,192,1000,2,0,L|500:196,1,142.8", stableCombo: 3, nativeCombo: 2 },
  ])(
    "uses source combo/events/reference samples while retaining native Lazer ($stableCombo/$nativeCombo)",
    ({ object, stableCombo, nativeCombo }) => {
      const beatmap = buildBeatmap(
        parseBlueprint(`osu file format v14
[General]
Mode:0
[Difficulty]
CircleSize:4
OverallDifficulty:5
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
${object}
`),
        { addStacking: false },
      );
      const slider = beatmap.hitObjects[0] as Slider;
      const frames: ReplayFrame[] = [
        { time: 0, position: { x: 100, y: 192 }, actions: [] },
        ...[1000, 1460, 1473, 1500, 1510].map((time) => ({
          time,
          position: { x: 100 + 0.28 * (time - 1000), y: 192 },
          actions: [0],
        })),
        { time: 1520, position: { x: 243, y: 192 }, actions: [] },
      ];
      const simulator = new GameSimulator();
      simulator.simulateReplay(beatmap, {
        gameMode: 0,
        gameVersion: 20260711,
        mods: [],
        frames,
        md5hash: "checkpoint-layout",
        beatmapMd5: "checkpoint-layout-map",
        player: "fixture",
      });
      simulator.simulate(1520);
      expect(simulator.getCurrentScoreStats()).toMatchObject({ maxComboSoFar: stableCombo, mapMaxCombo: stableCombo });
      expect(simulator.getFinalScoreStatsForRuleset("stable")).toMatchObject({
        maxComboSoFar: stableCombo,
        mapMaxCombo: stableCombo,
      });
      expect(
        simulator.getEventsForRuleset("stable").filter((event) => event.type === "CheckpointJudgement"),
      ).toHaveLength(stableCombo - 1);
      expect(
        simulator
          .getPerformanceInputs()
          .find((input) => input.mode === "stable")
          ?.states.at(-1)?.maxCombo,
      ).toBe(stableCombo);
      const reference = createAnalyticAutoplayReference({ beatmap, beatmapMd5: "checkpoint-layout-map" });
      expect(reference.samples.filter((sample) => sample.kind === "slider-checkpoint")).toHaveLength(stableCombo - 1);

      expect(slider.checkPoints).toHaveLength(nativeCombo - 1);
      expect(simulator.setRulesetFocus("lazer")).toBe(true);
      simulator.simulate(1520);
      expect(simulator.getCurrentScoreStats()).toMatchObject({ maxComboSoFar: nativeCombo, mapMaxCombo: nativeCombo });
      expect(simulator.getFinalScoreStatsForRuleset("lazer")).toMatchObject({
        maxComboSoFar: nativeCombo,
        mapMaxCombo: nativeCombo,
      });
    },
  );
});
