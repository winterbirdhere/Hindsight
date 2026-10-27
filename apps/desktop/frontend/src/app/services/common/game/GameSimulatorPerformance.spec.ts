import { buildBeatmap, OsuAction, parseBlueprint } from "@osujs/core";
import { OsuReplay } from "../../../model/OsuReplay";
import { GameSimulator } from "./GameSimulator";

const rawMap = `osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
100,100,1000,1,0,0:0:0:0:
`;

function sourceReplay(): OsuReplay {
  return {
    gameVersion: 30_000_019,
    gameMode: 0,
    md5hash: "replay",
    beatmapMd5: "map",
    player: "Player",
    mods: [],
    lazerMods: [{ acronym: "CL" }],
    frames: [
      { time: 0, position: { x: 100, y: 100 }, actions: [] },
      { time: 1000, position: { x: 100, y: 100 }, actions: [OsuAction.leftButton] },
      { time: 1500, position: { x: 100, y: 100 }, actions: [] },
    ],
  };
}

describe("GameSimulator performance input cache", () => {
  it.each([false, true])("preserves TouchDevice through %s-native simulation and PP preparation", (native) => {
    const replay = sourceReplay();
    replay.gameVersion = native ? 30_000_019 : 20_260_904;
    replay.mods = ["TOUCH_DEVICE"];
    replay.lazerMods = native ? [{ acronym: "TD" }] : undefined;
    const beatmap = buildBeatmap(parseBlueprint(rawMap), { mods: replay.mods, lazerMods: replay.lazerMods });
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay);
    const inputs = simulator.getPerformanceInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.mods.length === 1 && input.mods[0].acronym === "TD")).toBe(true);
    expect(inputs[0].states[0].legacyScoreByDifficultyMultiplier).toEqual(Array(11).fill(300));
    expect(inputs[0].limitations).not.toContain(
      "This configuration uses osu!'s combo-based estimate for Stable PP.",
    );
  });

  it.each(["MR", "RD", "WU", "FUTURE"])(
    "rejects unsupported native %s before publishing either ruleset's events",
    (acronym) => {
      const replay = sourceReplay();
      const simulator = new GameSimulator();
      simulator.simulateReplay(buildBeatmap(parseBlueprint(rawMap), { lazerMods: replay.lazerMods }), replay);
      expect(simulator.replayEvents$.getValue().length).toBeGreaterThan(0);
      replay.lazerMods = [{ acronym }];
      // A correct horizontal Mirror hit would be at x=412, not map x=100.
      replay.frames = replay.frames.map((frame) => ({ ...frame, position: { x: 412, y: 100 } }));
      const beatmap = buildBeatmap(parseBlueprint(rawMap), { lazerMods: replay.lazerMods });
      expect(() => simulator.simulateReplay(beatmap, replay)).toThrow(`native mods: ${acronym}`);
      expect(simulator.replayEvents$.getValue()).toEqual([]);
      expect(simulator.getPerformanceInputs()).toEqual([]);
      expect(simulator.getPrimaryReplay()).toBeUndefined();
      expect(simulator.lazerAvailable$.getValue()).toBe(false);
    },
  );

  it.each(["stable", "lazer"] as const)("rejects Mirror as a %s comparison too", (ruleset) => {
    const primary = sourceReplay();
    const simulator = new GameSimulator();
    simulator.simulateReplay(buildBeatmap(parseBlueprint(rawMap), { lazerMods: primary.lazerMods }), primary);
    const comparison = { ...sourceReplay(), lazerMods: [{ acronym: "MR" }] };
    const result = simulator.compareReplay(
      buildBeatmap(parseBlueprint(rawMap), { lazerMods: comparison.lazerMods }),
      comparison,
      ruleset,
    );
    expect(result).toMatchObject({ status: "ERROR", message: expect.stringContaining("native mods: MR") });
    expect(simulator.getPrimaryReplay()).toBe(primary);
  });

  it("builds separate Stable/Classic inputs once, retains them through playback and seeking, and clears on unload", () => {
    const source = sourceReplay();
    const beatmap = buildBeatmap(parseBlueprint(rawMap), { lazerMods: source.lazerMods });
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, source);
    const inputs = simulator.getPerformanceInputs();
    const contents = JSON.stringify(inputs);
    expect(inputs.map((input) => input.mode)).toEqual(["stable", "lazer-classic"]);
    expect(inputs[0].mods).toEqual([]);
    expect(inputs[1].mods).toEqual([{ acronym: "CL" }]);
    expect(inputs[0].states[0]).toMatchObject({ passedObjects: 1, statistics: { great: 1 } });
    expect(inputs[0].states[0].legacyScoreByDifficultyMultiplier).toEqual(Array(11).fill(300));
    for (const time of [0, 500, 1000, 1500, 0, 1500]) {
      simulator.simulate(time);
      simulator.setRulesetFocus(time === 0 ? "stable" : "lazer");
      expect(simulator.getPerformanceInputs()).toBe(inputs);
      expect(JSON.stringify(inputs)).toBe(contents);
    }
    simulator.clear();
    expect(simulator.getPerformanceInputs()).toEqual([]);
    simulator.simulateReplay(beatmap, source);
    expect(simulator.getPerformanceInputs()).not.toBe(inputs);
  });
});
