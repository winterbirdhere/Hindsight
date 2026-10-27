import { buildBeatmap, isSlider, LazerMod, modsToBitmask, OsuAction, parseBlueprint } from "@osujs/core";
import { std_diff, beatmap as OjsamaBeatmap } from "ojsama";
import { legacyModsFromLazerMods, OsuReplay } from "../../../model/OsuReplay";
import { analyzeFullMap } from "../../analysis/full-map-analysis";
import { summarizeReplayEvents } from "../../analysis/replay-events";
import { buildHitSoundCues } from "../audio/hit-sound-cues";
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
100,100,1000,2,0,L|200:100,1,100
300,100,2000,1,0,0:0:0:0:
100,200,2300,1,0,0:0:0:0:
`;

function setup(lazerMods: readonly LazerMod[]) {
  const mods = legacyModsFromLazerMods(lazerMods);
  const beatmap = buildBeatmap(parseBlueprint(rawMap), { mods, lazerMods });
  const slider = beatmap.hitObjects.find(isSlider)!;
  const replay: OsuReplay = {
    gameVersion: 30_000_016,
    gameMode: 0,
    beatmapMd5: "fixture",
    md5hash: "fixture",
    player: "fixture",
    mods,
    lazerMods,
    frames: [
      { time: 0, position: { x: 100, y: 100 }, actions: [] },
      { time: 1080, position: { x: 100, y: 100 }, actions: [OsuAction.leftButton] },
      { time: slider.endTime, position: slider.endPosition, actions: [OsuAction.leftButton] },
      { time: 1500, position: slider.endPosition, actions: [] },
      { time: 2020, position: { x: 300, y: 100 }, actions: [OsuAction.leftButton] },
      { time: 2021, position: { x: 300, y: 100 }, actions: [] },
      { time: 2320, position: { x: 100, y: 200 }, actions: [OsuAction.leftButton] },
      { time: 2321, position: { x: 100, y: 200 }, actions: [] },
      { time: 3000, position: { x: 100, y: 200 }, actions: [] },
    ],
  };
  const simulator = new GameSimulator();
  simulator.simulateReplay(beatmap, replay);
  return { simulator, beatmap, slider, replay };
}

describe("native lazer mods through analysis and playback", () => {
  it("reports zero native UR when the only successful timing sample is a Classic head", () => {
    const { simulator, beatmap, replay } = setup([{ acronym: "CL" }]);
    replay.frames = replay.frames.map((frame) => (frame.time >= 2000 ? { ...frame, actions: [] } : frame));
    simulator.simulateReplay(beatmap, replay);
    const summary = analyzeFullMap({
      ruleset: "lazer",
      events: simulator.getEventsForRuleset("lazer"),
      hits: simulator.getHitsForRuleset("lazer"),
      duration: 3000,
      baseRate: 1,
    });
    expect(summary.timing.sampleCount).toBe(1);
    expect(summary.timing.unstableRate).toBe(0);
    expect(summary.timing.standardDeviationMs).toBe(0);
  });

  it.each([
    ["DT", 1.2],
    ["HT", 0.65],
  ] as const)("includes Classic head hits in UR at custom %s rate %s", (acronym, rate) => {
    const { simulator, beatmap } = setup([{ acronym: "CL" }, { acronym, settings: { speed_change: rate } }]);
    const hits = simulator.getHitsForRuleset("lazer");
    expect(hits.map(([, offset]) => offset)).toEqual([80, 20, 20]);
    const summary = analyzeFullMap({
      ruleset: "lazer",
      events: simulator.getEventsForRuleset("lazer"),
      hits,
      duration: 3000,
      baseRate: beatmap.gameClockRate,
    });
    expect(summary.timing.samples.map((hit) => hit.offsetMs)).toEqual([80 / rate, 20 / rate, 20 / rate]);
    expect(summary.timing.unstableRate).toBeCloseTo((Math.sqrt(800) * 10) / rate);
    expect(summary.timing.averageUr.at(-1)?.unstableRate).toBeCloseTo(summary.timing.unstableRate!);
    expect(summary.judgements).toMatchObject({ count300: 3, total: 3 });
  });

  it("scores Classic slider parents once while retaining successful head timing for UR and sound", () => {
    const { simulator, beatmap, slider } = setup([{ acronym: "CL" }]);
    expect(simulator.getRulesetFocus()).toBe("lazer");
    expect(simulator.getFinalInfoForRuleset("lazer")?.verdictCounts).toEqual([3, 0, 0, 0]);
    const events = simulator.getEventsForRuleset("lazer");
    const hits = simulator.getHitsForRuleset("lazer");
    expect(hits.map(([, offset]) => offset)).toEqual([80, 20, 20]);
    expect(summarizeReplayEvents(events, "lazer").timings.great).toHaveLength(3);
    expect(summarizeReplayEvents(events, "lazer").timings.ok).toEqual([]);
    const summary = analyzeFullMap({ ruleset: "lazer", events, hits, duration: 3000, baseRate: 1 });
    expect(summary.judgements).toEqual({ count300: 3, count100: 0, count50: 0, countMiss: 0, total: 3 });
    expect(summary.timing.sampleCount).toBe(3);
    expect(summary.timing.unstableRate).toBeCloseTo(Math.sqrt(800) * 10);
    expect(simulator.judgements.some((event) => event.hitObjectId === slider.head.id)).toBe(false);
    expect(buildHitSoundCues(beatmap, events).some((cue) => cue.time === 1080)).toBe(true);
    expect(buildHitSoundCues(beatmap, events).filter((cue) => cue.id.startsWith("lazer-slider-tail:"))).toMatchObject([
      { time: slider.endTime },
    ]);
  });

  it("restores native head accuracy when Classic's setting is disabled", () => {
    const { simulator } = setup([{ acronym: "CL", settings: { no_slider_head_accuracy: false } }]);
    expect(simulator.getFinalInfoForRuleset("lazer")?.verdictCounts).toEqual([2, 1, 0, 0]);
    expect(simulator.getHitsForRuleset("lazer").map(([, offset]) => offset)).toEqual([80, 20, 20]);
  });

  it.each([true, false])("honours always_play_tail_sample=%s for a missed Classic tail", (alwaysPlay) => {
    const { simulator, beatmap, replay, slider } = setup([
      { acronym: "CL", settings: { always_play_tail_sample: alwaysPlay } },
    ]);
    replay.frames = replay.frames.map((frame) => ({ ...frame, actions: [] }));
    simulator.simulateReplay(beatmap, replay);
    const events = simulator.getEventsForRuleset("lazer");
    const tails = buildHitSoundCues(beatmap, events).filter((cue) => cue.id.startsWith("lazer-slider-tail:"));
    expect(tails).toHaveLength(alwaysPlay ? 1 : 0);
    if (alwaysPlay) expect(tails[0].time).toBe(slider.endTime);
    expect(summarizeReplayEvents(events, "lazer").timings.miss).toHaveLength(3);
    const summary = analyzeFullMap({
      ruleset: "lazer",
      events,
      hits: simulator.getHitsForRuleset("lazer"),
      duration: 3000,
      baseRate: 1,
    });
    expect(summary.timing.sampleCount).toBe(0);
    expect(summary.timing.unstableRate).toBeNull();
    // Successful CL heads now affect UR; missed heads must not gain red bar markers.
    expect(simulator.getHitsForRuleset("lazer")).toHaveLength(2);
  });
});

describe("native lazer difficulty chart", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ["DT", 1.2],
    ["HT", 0.65],
  ] as const)("uses effective DA CS and %s intervals without moving chart bins", (acronym, rate) => {
    const { beatmap } = setup([
      { acronym, settings: { speed_change: rate } },
      { acronym: "DA", settings: { circle_size: 7 } },
    ]);
    const original = std_diff.prototype.calc;
    let calculatedMap: OjsamaBeatmap | undefined;
    const calculate = jest.spyOn(std_diff.prototype, "calc").mockImplementation(function (this: std_diff, options) {
      expect(options.map!.cs).toBe(7);
      expect(options.mods).toBe(0);
      expect(options.map!.objects[0].time).toBeCloseTo(1000 / rate);
      calculatedMap = options.map;
      return original.call(this, options);
    });
    const simulator = new GameSimulator();
    simulator.calculateDifficulties(rawMap, 3000, modsToBitmask(beatmap.appliedMods), beatmap);
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(calculatedMap?.objects.map((object) => object.time)).toEqual([1000, 2000, 2300]);
    expect(simulator.difficulties$.getValue()).toHaveLength(6);
    expect(simulator.difficulties$.getValue().every(Number.isFinite)).toBe(true);
  });

  it("leaves legacy DT calculation inputs unchanged", () => {
    const beatmap = buildBeatmap(parseBlueprint(rawMap), { mods: ["DOUBLE_TIME"] });
    const original = std_diff.prototype.calc;
    jest.spyOn(std_diff.prototype, "calc").mockImplementation(function (this: std_diff, options) {
      expect(options.map!.cs).toBe(4);
      expect(options.map!.objects[0].time).toBe(1000);
      expect(options.mods).toBe(modsToBitmask(["DOUBLE_TIME"]));
      return original.call(this, options);
    });
    new GameSimulator().calculateDifficulties(rawMap, 3000, modsToBitmask(beatmap.appliedMods), beatmap);
  });
});
