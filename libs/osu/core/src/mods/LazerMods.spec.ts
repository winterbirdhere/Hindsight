import { approachRateToApproachDuration, circleSizeToScale } from "@osujs/math";
import { buildBeatmap } from "../beatmap/BeatmapBuilder";
import { parseBlueprint } from "../blueprint/BlueprintParser";
import { HitCircle } from "../hitobjects/HitCircle";
import { resolveLazerModSettings } from "./LazerMods";

const mapText = `osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:6
CircleSize:4
OverallDifficulty:7
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
100,100,1000,1,0,0:0:0:0:
100,100,1100,1,0,0:0:0:0:
`;

describe("native lazer mod settings", () => {
  it("does not apply Classic or rate adjustments to ordinary maps", () => {
    expect(resolveLazerModSettings()).toEqual({});
    expect(resolveLazerModSettings([{ acronym: "UNKNOWN", settings: { speed_change: 2 } }])).toEqual({});
  });

  it("defaults all five Classic settings to true and retains explicit false", () => {
    expect(resolveLazerModSettings([{ acronym: "CL" }]).classic).toEqual({
      noSliderHeadAccuracy: true,
      classicNoteLock: true,
      alwaysPlayTailSample: true,
      fadeHitCircleEarly: true,
      classicHealth: true,
    });
    expect(
      resolveLazerModSettings([
        {
          acronym: "CL",
          settings: {
            no_slider_head_accuracy: false,
            classic_note_lock: false,
            always_play_tail_sample: false,
            fade_hit_circle_early: false,
            classic_health: false,
          },
        },
      ]).classic,
    ).toEqual({
      noSliderHeadAccuracy: false,
      classicNoteLock: false,
      alwaysPlayTailSample: false,
      fadeHitCircleEarly: false,
      classicHealth: false,
    });
  });

  it.each([
    ["DT", 1.5],
    ["NC", 1.5],
    ["HT", 0.75],
    ["DC", 0.75],
  ])("uses official %s rate defaults", (acronym, expected) => {
    expect(resolveLazerModSettings([{ acronym: String(acronym) }]).clockRate).toBe(expected);
  });

  it("uses native rate and pitch settings, with official limits", () => {
    expect(
      resolveLazerModSettings([{ acronym: "DT", settings: { speed_change: 1.237, adjust_pitch: true } }]),
    ).toMatchObject({ clockRate: 1.24, adjustPitch: true });
    expect(resolveLazerModSettings([{ acronym: "DT", settings: { speed_change: 9 } }]).clockRate).toBe(2);
    expect(resolveLazerModSettings([{ acronym: "HT", settings: { speed_change: 0.1 } }]).clockRate).toBe(0.5);
    expect(resolveLazerModSettings([{ acronym: "HT", settings: { speed_change: 1 } }]).clockRate).toBe(0.99);
    expect(resolveLazerModSettings([{ acronym: "NC", settings: { adjust_pitch: false } }]).adjustPitch).toBe(true);
    expect(resolveLazerModSettings([{ acronym: "DT", settings: { speed_change: Infinity } }]).clockRate).toBe(1.5);
  });

  it("leaves absent DA values untouched, preserves zero and ignores invalid values", () => {
    expect(resolveLazerModSettings([{ acronym: "DA" }]).difficultyAdjust).toEqual({});
    expect(
      resolveLazerModSettings([
        {
          acronym: "DA",
          settings: {
            circle_size: 0,
            approach_rate: null,
            overall_difficulty: "7",
            drain_rate: NaN,
          },
        },
      ]).difficultyAdjust,
    ).toEqual({ circleSize: 0 });
  });

  it("matches DifficultyBindable extended deserialization bounds without quantizing", () => {
    expect(
      resolveLazerModSettings([
        {
          acronym: "DA",
          settings: {
            circle_size: 12,
            approach_rate: -20,
            overall_difficulty: 10.37,
            drain_rate: -1,
          },
        },
      ]).difficultyAdjust,
    ).toEqual({ circleSize: 11, approachRate: -10, overallDifficulty: 10.37, drainRate: 0 });
  });

  it("applies DA before object geometry and stacking without mutating the blueprint", () => {
    const blueprint = parseBlueprint(mapText);
    const original = { ...blueprint.defaultDifficulty };
    const map = buildBeatmap(blueprint, {
      lazerMods: [
        {
          acronym: "DA",
          settings: {
            circle_size: 8,
            approach_rate: 3,
            overall_difficulty: 9.5,
            drain_rate: 0,
          },
        },
      ],
    });
    expect(map.difficulty).toEqual({
      ...original,
      circleSize: 8,
      approachRate: 3,
      overallDifficulty: 9.5,
      drainRate: 0,
    });
    expect(blueprint.defaultDifficulty).toEqual(original);
    const first = map.hitObjects[0] as HitCircle;
    expect(first.scale).toBe(circleSizeToScale(8));
    expect(first.approachDuration).toBe(approachRateToApproachDuration(3));
    expect(first.stackHeight).toBe(1);
    expect(first.position.x).toBeCloseTo(100 - 6.4 * circleSizeToScale(8));
  });

  it("keeps custom clock rate separate from map/replay timestamps and legacy defaults", () => {
    const blueprint = parseBlueprint(mapText);
    const custom = buildBeatmap(blueprint, {
      mods: ["DOUBLE_TIME"],
      lazerMods: [{ acronym: "DT", settings: { speed_change: 1.2 } }],
    });
    expect(custom.gameClockRate).toBe(1.2);
    expect((custom.hitObjects[0] as HitCircle).hitTime).toBe(1000);
    expect(custom.difficulty.approachRate).toBe(8);
    expect(buildBeatmap(blueprint, { mods: ["DOUBLE_TIME"] }).gameClockRate).toBe(1.5);
  });

  it("gives DA precedence over its incompatible HR/EZ mods", () => {
    const blueprint = parseBlueprint(mapText);
    const map = buildBeatmap(blueprint, {
      addStacking: false,
      mods: ["HARD_ROCK"],
      lazerMods: [{ acronym: "DA", settings: { circle_size: 3 } }],
    });
    expect(map.difficulty).toEqual({ ...blueprint.defaultDifficulty, circleSize: 3 });
    expect((map.hitObjects[0] as HitCircle).position.y).toBe(100);
    expect(map.appliedMods).not.toContain("HARD_ROCK");
    const stable = buildBeatmap(blueprint, { addStacking: false, mods: ["HARD_ROCK"] });
    expect((stable.hitObjects[0] as HitCircle).position.y).toBe(284);
    expect(stable.difficulty.circleSize).toBeCloseTo(5.2);
  });
});
