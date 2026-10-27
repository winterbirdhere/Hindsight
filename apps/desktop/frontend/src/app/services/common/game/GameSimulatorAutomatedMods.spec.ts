import { buildBeatmap, isSlider, isSpinner, LazerMod, OsuAction, parseBlueprint, ReplayFrame } from "@osujs/core";
import { legacyModsFromLazerMods, OsuReplay } from "../../../model/OsuReplay";
import { buildHitSoundCues } from "../audio/hit-sound-cues";
import { GameSimulator } from "./GameSimulator";

const header = `osu file format v14
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
`;

type AutomatedMod = "RX" | "AP" | "AT" | "SO";

function fixture(acronym: AutomatedMod, native: boolean) {
  const lazerMods: LazerMod[] = [{ acronym }];
  const mods = legacyModsFromLazerMods(lazerMods);
  const rawMap =
    header + (acronym === "SO" ? "256,192,1000,8,0,3000\n" : "100,100,1000,1,0,0:0:0:0:\n300,200,1500,1,0,0:0:0:0:\n");
  const beatmap = buildBeatmap(parseBlueprint(rawMap), { mods, ...(native ? { lazerMods } : {}) });
  const offset = acronym === "AP" ? 20 : 0;
  const actions = acronym === "RX" && !native ? [] : [OsuAction.leftButton];
  const frames: ReplayFrame[] =
    acronym === "SO"
      ? [0, 1000, 1500, 2000, 2500, 3000, 3500].map((time) => ({
          time,
          position: { x: 256, y: 192 },
          actions: [],
        }))
      : [
          { time: 0, position: { x: 100, y: 100 }, actions: [] },
          { time: 1000 + offset, position: { x: 100, y: 100 }, actions },
          { time: 1001 + offset, position: { x: 100, y: 100 }, actions: [] },
          { time: 1500 + offset, position: { x: 300, y: 200 }, actions },
          { time: 1501 + offset, position: { x: 300, y: 200 }, actions: [] },
          { time: 2000, position: { x: 300, y: 200 }, actions: [] },
        ];
  const replay: OsuReplay = {
    gameMode: 0,
    gameVersion: native ? 30_000_019 : 20_260_912,
    player: "Automation fixture",
    md5hash: "automation-fixture",
    beatmapMd5: `automation-map-${acronym}`,
    mods,
    ...(native ? { lazerMods } : {}),
    frames,
  };
  const simulator = new GameSimulator();
  simulator.simulateReplay(beatmap, replay);
  return { simulator, beatmap, replay };
}

describe.each([false, true])("automated input mods from native=%s replays", (native) => {
  it.each<AutomatedMod>(["RX", "AP", "AT", "SO"])(
    "makes %s Lazer results available to playback, comparison, and performance",
    (acronym) => {
      const { simulator, beatmap, replay } = fixture(acronym, native);
      const objectCount = beatmap.hitObjects.length;
      const stableEvents = simulator.getStableEvents();
      expect(simulator.lazerAvailable$.getValue()).toBe(true);
      expect(simulator.getRulesetFocus()).toBe(native ? "lazer" : "stable");
      expect(simulator.setRulesetFocus("lazer")).toBe(true);
      expect(simulator.getFinalInfoForRuleset("lazer")?.verdictCounts).toEqual([objectCount, 0, 0, 0]);
      expect(simulator.getPerformanceInputs().map((input) => input.mode)).toEqual(["stable", "lazer"]);
      const performance = simulator.getPerformanceInputs().find((input) => input.mode === "lazer");
      expect(performance?.mods).toEqual([{ acronym }]);
      expect(performance?.states.at(-1)).toMatchObject({
        passedObjects: objectCount,
        statistics: { great: objectCount, miss: 0 },
      });
      if (acronym === "AP") expect(simulator.getHitsForRuleset("lazer").map((hit) => hit[1])).toEqual([20, 20]);

      const comparison = simulator.compareReplay(beatmap, { ...replay, md5hash: "automation-secondary" }, "lazer");
      expect(comparison.status).toBe("READY");
      if (comparison.status === "READY") {
        expect(comparison.ruleset).toBe("lazer");
        expect(comparison.secondary.verdictCountsInput).toEqual([objectCount, 0, 0, 0]);
      }
      expect(simulator.setRulesetFocus("stable")).toBe(true);
      expect(simulator.getStableEvents()).toBe(stableEvents);
      expect(simulator.setRulesetFocus("lazer")).toBe(true);
    },
  );

  it.each<AutomatedMod>(["RX", "AP", "AT", "SO"])(
    "keeps %s audio lookahead and repeated seeks separate from visible judgement state",
    (acronym) => {
      const { simulator, beatmap, replay } = fixture(acronym, native);
      expect(simulator.setRulesetFocus("lazer")).toBe(true);
      simulator.simulate(900);
      const visibleState = simulator.getCurrentState();
      const visibleInfo = simulator.getCurrentInfo();
      const endpoint = replay.frames[replay.frames.length - 1].time;
      const audioState = simulator.getStateAt(endpoint);
      expect(audioState?.lazerJudgements.filter((judgement) => judgement.result === "GREAT")).toHaveLength(
        beatmap.hitObjects.length,
      );
      expect(simulator.getCurrentState()).toBe(visibleState);
      expect(simulator.getCurrentInfo()).toBe(visibleInfo);
      expect(visibleState?.lazerJudgements).toHaveLength(0);

      simulator.simulate(endpoint);
      const finalJudgements = [...(simulator.getCurrentState()?.lazerJudgements ?? [])];
      const finalStats = { ...simulator.getCurrentScoreStats() };
      for (let pass = 0; pass < 2; pass++) {
        simulator.simulate(900);
        expect(simulator.getCurrentState()?.lazerJudgements).toHaveLength(0);
        simulator.simulate(endpoint);
        expect(simulator.getCurrentState()?.lazerJudgements).toEqual(finalJudgements);
        expect(simulator.getCurrentScoreStats()).toEqual(finalStats);
      }
    },
  );
});

describe("automation replay provenance", () => {
  it("keeps absent native Relax presses as misses instead of inventing successful taps", () => {
    const { simulator, beatmap, replay } = fixture("RX", true);
    replay.frames = replay.frames.map((frame) => ({ ...frame, actions: [] }));
    simulator.simulateReplay(beatmap, replay);
    expect(simulator.getRulesetFocus()).toBe("lazer");
    expect(simulator.getFinalInfoForRuleset("lazer")?.verdictCounts).toEqual([0, 0, 0, 2]);
    expect(buildHitSoundCues(beatmap, simulator.getEventsForRuleset("lazer"))).toHaveLength(0);
  });

  it("preserves native Relax's recorded late press timing", () => {
    const { simulator, beatmap, replay } = fixture("RX", true);
    replay.frames = replay.frames.map((frame) =>
      frame.time >= 1000 && frame.time <= 1001 ? { ...frame, time: frame.time + 80 } : frame,
    );
    simulator.simulateReplay(beatmap, replay);
    expect(simulator.getFinalInfoForRuleset("lazer")?.verdictCounts).toEqual([1, 1, 0, 0]);
    expect(simulator.getHitsForRuleset("lazer").map((hit) => hit[1])).toEqual([80, 0]);
    expect(buildHitSoundCues(beatmap, simulator.getEventsForRuleset("lazer")).map((cue) => cue.time)).toContain(1080);
  });

  it.each<AutomatedMod>(["AP", "AT"])("does not invent missing %s replay presses", (acronym) => {
    const { simulator, beatmap, replay } = fixture(acronym, false);
    replay.frames = replay.frames.map((frame) => ({ ...frame, actions: [] }));
    simulator.simulateReplay(beatmap, replay);
    expect(simulator.setRulesetFocus("lazer")).toBe(true);
    expect(simulator.getFinalInfoForRuleset("lazer")?.verdictCounts).toEqual([0, 0, 0, 2]);
  });

  it.each<AutomatedMod>(["AP", "AT"])("retains recorded %s cursor misses", (acronym) => {
    const { simulator, beatmap, replay } = fixture(acronym, true);
    replay.frames = replay.frames.map((frame) => ({ ...frame, position: { x: 0, y: 0 } }));
    simulator.simulateReplay(beatmap, replay);
    expect(simulator.getRulesetFocus()).toBe("lazer");
    expect(simulator.getFinalInfoForRuleset("lazer")?.verdictCounts).toEqual([0, 0, 0, 2]);
  });

  it("reconstructs legacy Relax slider tracking and sound without button presses", () => {
    const { simulator, replay } = fixture("RX", false);
    const beatmap = buildBeatmap(parseBlueprint(header + "100,100,1000,2,0,L|300:100,1,200\n"), {
      mods: replay.mods,
    });
    const slider = beatmap.hitObjects.find(isSlider);
    if (!slider) throw new Error("Fixture must contain a slider");
    replay.frames = [
      { time: 0, position: slider.startPosition, actions: [] },
      ...[1000, 1100, 1250, 1400, 1500, slider.endTime].map((time) => ({
        time,
        position: slider.ballPositionAt((time - slider.startTime) / slider.duration),
        actions: [],
      })),
      { time: 2000, position: slider.endPosition, actions: [] },
    ];
    simulator.simulateReplay(beatmap, replay);
    expect(simulator.setRulesetFocus("lazer")).toBe(true);
    expect(simulator.getFinalInfoForRuleset("lazer")?.verdictCounts).toEqual([1, 0, 0, 0]);
    expect(simulator.getStateAt(1250)?.sliderBodyState.get(slider.id)?.isTracking).toBe(true);
    const events = simulator.getEventsForRuleset("lazer");
    const cues = buildHitSoundCues(beatmap, events);
    expect(cues.some((cue) => cue.time === 1000)).toBe(true);
    const tailCue = cues.find((cue) => cue.id.startsWith("lazer-slider-tail:"));
    const tailJudgement = events.find((event) => event.type === "SliderEndJudgement");
    expect(tailJudgement).toMatchObject({ hit: true });
    expect(tailCue?.time).toBe(tailJudgement?.judgementTime);
    expect(
      simulator
        .getPerformanceInputs()
        .find((input) => input.mode === "lazer")
        ?.states.at(-1),
    ).toMatchObject({
      statistics: { great: 1, miss: 0, large_tick_miss: 0, slider_tail_hit: 1 },
    });
  });

  it.each([false, true])("rebuilds Spun Out progress deterministically after seeking (native=%s)", (native) => {
    const { simulator, beatmap } = fixture("SO", native);
    const spinner = beatmap.hitObjects.find(isSpinner);
    if (!spinner) throw new Error("Fixture must contain a spinner");
    expect(simulator.setRulesetFocus("lazer")).toBe(true);
    simulator.simulate(2000);
    const progress = { ...simulator.getCurrentState()?.spinnerState.get(spinner.id) };
    expect(progress.totalSpunAngle).toBeGreaterThan(0);
    expect(progress.tracking).toBe(true);
    simulator.getStateAt(3000);
    expect(simulator.getCurrentState()?.spinnerState.get(spinner.id)).toEqual(progress);
    simulator.simulate(900);
    simulator.simulate(2000);
    expect(simulator.getCurrentState()?.spinnerState.get(spinner.id)).toEqual(progress);
  });
});
