import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { Slider } from "../src/hitobjects/Slider";
import { StableSliderTiming } from "../src/gameplay/StableSliderTiming";
import { StableSliderBallPath } from "../src/gameplay/StableSliderBallPath";

function fixture(
  object: string,
  inherited = "-66.6666666666667",
  sliderMultiplier = 2.6,
  beatLength = 500,
  tickRate = 1,
) {
  return buildBeatmap(
    parseBlueprint(`osu file format v14
[General]
Mode:0
[Difficulty]
CircleSize:4
OverallDifficulty:8.5
SliderMultiplier:${sliderMultiplier}
SliderTickRate:${tickRate}
[TimingPoints]
0,${beatLength},4,2,0,100,1,0
0,${inherited},4,2,0,100,0,0
[HitObjects]
${object}
`),
    { addStacking: false, mods: [] },
  );
}

describe("Stable slider timing precision", () => {
  it("retains the x86 segment product precision for both the parent and ball clock", () => {
    const map = fixture("0,0,1000,2,0,L|0.1:0,1,0.10000000149011612", "-100", 1, 500);
    const slider = map.hitObjects[0] as Slider;
    // The source-shaped x86 oracle multiplies this float length by 1000
    // without writing that product back to float, giving exactly 1000 ms.
    slider.stableTiming = { speed: Math.fround(0.1), tickDistance: 100 };
    const timing = new StableSliderTiming(slider);
    const ball = new StableSliderBallPath(slider);
    expect(timing.endTime).toBe(2000);
    expect(ball.positionAt(1999.5).x).toBeLessThan(Math.fround(0.1));
    expect(ball.positionAt(2000).x).toBe(Math.fround(0.1));
  });

  it.each([
    ["-66.6666666666667", 2.6, 500, 780.00002975463985],
    ["-80", 2, 300, 833.33333333333337],
  ])(
    "matches the x86 Stable method-boundary speed for inherited beat length %s",
    (inherited, multiplier, beat, speed) => {
      const map = fixture("256,192,1000,2,0,L|256:94,1,97.5", String(inherited), Number(multiplier), Number(beat));
      expect((map.hitObjects[0] as Slider).stableTiming?.speed).toBeCloseTo(Number(speed), 10);
    },
  );

  it("uses the same source parent end for the slider notelock overlap allowance", () => {
    const map = fixture("256,192,1000,2,0,L|256:94,1,97.5\n400,192,1128,1,0");
    const frames = [
      { time: 1000, position: { x: 256, y: 192 }, actions: [0] },
      { time: 1001, position: { x: 256, y: 192 }, actions: [] },
      { time: 1080, position: { x: 400, y: 192 }, actions: [0] },
    ];
    const state = new BucketedGameStateTimeMachine(frames, map, {
      hitWindowStyle: "OSU_STABLE",
      noteLockStyle: "STABLE",
    }).gameStateAt(Infinity);
    expect(state.hitCircleVerdict["1"]).toBeUndefined();
    expect(state.stableNotelockEvidence["1"]).toMatchObject({ blockerHitObjectId: "0", pressTime: 1080 });
  });

  it("retains the accumulated tick distance through reversals before rounding the checkpoint time", () => {
    const map = fixture("340,44,2193,2,0,B|256:20|172:44,3,170", "-100", 1.7, 333.333333333333, 2);
    const slider = map.hitObjects[0] as Slider;
    const timing = new StableSliderTiming(slider);
    expect(slider.checkPoints.map((point) => timing.checkpointTime(point))).toEqual([
      2359, 2526, 2692, 2859, 3026, 3157,
    ]);
  });

  it("preserves checkpoint identities and reverse-span tick positions when deriving source deadlines", () => {
    const map = fixture("100,192,1000,2,0,L|350:192,3,250", "-100", 1, 500);
    const slider = map.hitObjects[0] as Slider;
    const original = slider.checkPoints.map((point) => ({ id: point.id, time: point.hitTime, type: point.type }));
    const timing = new StableSliderTiming(slider);
    expect(slider.checkPoints.map((point) => timing.checkpointTime(point))).toEqual([
      1500, 2000, 2250, 2500, 3000, 3500, 4000, 4500, 4714,
    ]);
    expect(timing.endTime).toBe(4750);
    expect(slider.checkPoints.map((point) => ({ id: point.id, time: point.hitTime, type: point.type }))).toEqual(
      original,
    );
  });

  it("uses the float inherited beat-length multiplier for an observed tail one millisecond earlier", () => {
    const map = fixture("256,192,1000,2,0,L|256:94,1,97.5");
    const slider = map.hitObjects[0] as Slider;
    const frames = [
      { time: 1000, position: { x: 256, y: 192 }, actions: [0] },
      { time: 1087, position: { x: 256, y: 123 }, actions: [0] },
      { time: 1088, position: { x: 256, y: 123 }, actions: [0] },
      { time: 1089, position: { x: 256, y: 123 }, actions: [] },
      { time: 1125, position: { x: 256, y: 94.5 }, actions: [] },
    ];
    const machine = new BucketedGameStateTimeMachine(frames, map, {
      hitWindowStyle: "OSU_STABLE",
      noteLockStyle: "STABLE",
    });
    const tail = slider.checkPoints[0];
    expect(machine.gameStateAt(1087).checkPointVerdict[tail.id]).toBeUndefined();
    expect(machine.gameStateAt(1088).checkPointVerdict[tail.id]).toEqual({ hit: true, judgementTime: 1088 });
    expect(machine.gameStateAt(Infinity).sliderVerdict[slider.id]).toBe("GREAT");
    // Source precision must not alter the shared/native Lazer beatmap timing.
    expect(slider.velocity).toBe(0.7799999999999997);
    expect(tail.hitTime).toBeCloseTo(1089, 8);
  });

  it("truncates the actual float segment length before scheduling the legacy tail", () => {
    const map = fixture("392,91,1000,2,0,B|452:71|452:71|521:93,1,125", "-80", 2, 300);
    const slider = map.hitObjects[0] as Slider;
    const frames = [
      { time: 1000, position: { x: 392, y: 91 }, actions: [0] },
      { time: 1113, position: { x: 480, y: 80 }, actions: [0] },
      { time: 1114, position: { x: 480, y: 80 }, actions: [] },
      { time: 1150, position: { x: 510, y: 90 }, actions: [] },
    ];
    const state = new BucketedGameStateTimeMachine(frames, map, {
      hitWindowStyle: "OSU_STABLE",
      noteLockStyle: "STABLE",
    }).gameStateAt(Infinity);
    expect(state.checkPointVerdict[slider.checkPoints[0].id]).toEqual({ hit: true, judgementTime: 1113 });
  });
});
