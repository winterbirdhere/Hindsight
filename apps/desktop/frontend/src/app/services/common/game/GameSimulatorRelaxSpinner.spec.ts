import {
  buildBeatmap,
  isSpinner,
  LazerMod,
  OsuAction,
  parseBlueprint,
  ReplayAnalysisRuleset,
  ReplayFrame,
  spinnerBonusProgress,
} from "@osujs/core";
import { legacyModsFromLazerMods, OsuReplay } from "../../../model/OsuReplay";
import { summarizeReplayEvents } from "../../analysis/replay-events";
import { buildHitSoundCues } from "../audio/hit-sound-cues";
import { GameSimulator } from "./GameSimulator";

const spinnerMap = `osu file format v14
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
256,192,1000,8,0,3000
`;

function fixture({ native = false, rotating = true, held = false } = {}) {
  const lazerMods: LazerMod[] = [{ acronym: "RX" }];
  const mods = legacyModsFromLazerMods(lazerMods);
  const beatmap = buildBeatmap(parseBlueprint(spinnerMap), { mods, ...(native ? { lazerMods } : {}) });
  const spinner = beatmap.hitObjects.find(isSpinner);
  if (!spinner) throw new Error("Fixture must contain a spinner");
  const frames: ReplayFrame[] = [
    { time: 0, position: { x: 356, y: 192 }, actions: [], rawButtonMask: 0 },
    // Stable replay movement is sampled near 60 Hz. Preserve twelve physical
    // turns while exercising its velocity model with that recorded cadence.
    ...Array.from({ length: 121 }, (_, index) => {
      const angle = rotating ? (index / 120) * 12 * 2 * Math.PI : 0;
      return {
        time: 1000 + Math.round((index * 2000) / 120),
        position: { x: 256 + 100 * Math.cos(angle), y: 192 + 100 * Math.sin(angle) },
        actions: held ? [OsuAction.leftButton] : [],
        rawButtonMask: held ? 1 : 0,
      };
    }),
    { time: 3500, position: { x: 356, y: 192 }, actions: [], rawButtonMask: 0 },
  ];
  const replay: OsuReplay = {
    gameMode: 0,
    gameVersion: native ? 30_000_019 : 20_260_912,
    player: "Relax spinner fixture",
    md5hash: "relax-spinner-fixture",
    beatmapMd5: "relax-spinner-map",
    mods,
    ...(native ? { lazerMods } : {}),
    frames,
  };
  const simulator = new GameSimulator();
  simulator.simulateReplay(beatmap, replay);
  return { simulator, beatmap, spinner, replay };
}

describe.each<ReplayAnalysisRuleset>(["stable", "lazer"])("legacy Relax spinner in %s simulation", (ruleset) => {
  it("scores cursor-only spinning and exposes the successful result to summary, performance, and end sound", () => {
    const { simulator, beatmap, spinner } = fixture();
    expect(simulator.setRulesetFocus(ruleset)).toBe(true);
    expect(simulator.getFinalInfoForRuleset(ruleset)?.verdictCounts).toEqual([1, 0, 0, 0]);
    simulator.simulate(3000);
    if (ruleset === "stable") expect(simulator.getCurrentState()?.spinnerVerdict[spinner.id]).toBeUndefined();
    simulator.simulate(3500);
    expect(simulator.getCurrentScoreStats().countMiss).toBe(0);
    expect(simulator.getCurrentState()?.spinnerVerdict[spinner.id]).toMatchObject({ type: "GREAT" });
    const summary = summarizeReplayEvents(simulator.getEventsForRuleset(ruleset), ruleset);
    expect(summary.timings.miss).toHaveLength(0);
    expect(summary.errors).toHaveLength(0);
    expect(
      simulator
        .getPerformanceInputs()
        .find((input) => input.mode === ruleset)
        ?.states.at(-1)?.statistics,
    ).toMatchObject({ great: 1, miss: 0 });
    expect(buildHitSoundCues(beatmap, simulator.getEventsForRuleset(ruleset))).toContainEqual(
      // Stable expires strictly after the end, at this fixture's next recorded
      // update. Native Lazer retains its exact nominal-end judgement.
      expect.objectContaining({ id: expect.stringMatching(/^spinner:/), time: ruleset === "stable" ? 3500 : 3000 }),
    );
  });

  it("retains rotation and bonus progress across reverse seeks and audio lookahead", () => {
    const { simulator, spinner } = fixture();
    simulator.setRulesetFocus(ruleset);
    simulator.simulate(2800);
    const visibleState = simulator.getCurrentState();
    const progress = { ...visibleState?.spinnerState.get(spinner.id) };
    const bonus = spinnerBonusProgress(spinner, visibleState?.spinnerState.get(spinner.id), ruleset);
    expect(progress.tracking).toBe(true);
    expect(bonus.score).toBeGreaterThan(0);
    const ahead = simulator.getStateAt(3500);
    expect(ahead?.spinnerVerdict[spinner.id]).toMatchObject({ type: "GREAT" });
    expect(simulator.getCurrentState()).toBe(visibleState);
    expect(visibleState?.spinnerState.get(spinner.id)).toEqual(progress);
    simulator.simulate(900);
    expect(simulator.getCurrentState()?.spinnerVerdict[spinner.id]).toBeUndefined();
    simulator.simulate(2800);
    expect(simulator.getCurrentState()?.spinnerState.get(spinner.id)).toEqual(progress);
    expect(spinnerBonusProgress(spinner, simulator.getCurrentState()?.spinnerState.get(spinner.id), ruleset)).toEqual(
      bonus,
    );
  });

  it("still misses when the Relax cursor does not spin", () => {
    const { simulator, beatmap, spinner } = fixture({ rotating: false });
    simulator.setRulesetFocus(ruleset);
    expect(simulator.getFinalInfoForRuleset(ruleset)?.verdictCounts).toEqual([0, 0, 0, 1]);
    simulator.simulate(3500);
    expect(simulator.getCurrentScoreStats().countMiss).toBe(1);
    const summary = summarizeReplayEvents(simulator.getEventsForRuleset(ruleset), ruleset);
    expect(summary.timings.miss).toHaveLength(1);
    expect(summary.errors).toContainEqual(expect.objectContaining({ type: "MISS", hitObjectId: spinner.id }));
    expect(
      spinnerBonusProgress(spinner, simulator.getCurrentState()?.spinnerState.get(spinner.id), ruleset).score,
    ).toBe(0);
    expect(buildHitSoundCues(beatmap, simulator.getEventsForRuleset(ruleset))).toHaveLength(0);
  });
});

describe("native Relax spinner input provenance", () => {
  it.each([true, false])("uses recorded native holds (held=%s) instead of reconstructing them", (held) => {
    const { simulator, beatmap, spinner } = fixture({ native: true, held });
    expect(simulator.getRulesetFocus()).toBe("lazer");
    expect(simulator.getFinalInfoForRuleset("lazer")?.verdictCounts).toEqual(held ? [1, 0, 0, 0] : [0, 0, 0, 1]);
    simulator.simulate(3500);
    expect(simulator.getCurrentState()?.spinnerVerdict[spinner.id]).toMatchObject({ type: held ? "GREAT" : "MISS" });
    expect(buildHitSoundCues(beatmap, simulator.getEventsForRuleset("lazer"))).toHaveLength(held ? 1 : 0);
  });
});
