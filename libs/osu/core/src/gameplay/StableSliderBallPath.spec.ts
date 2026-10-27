import { buildBeatmap } from "../beatmap/BeatmapBuilder";
import { parseBlueprint } from "../blueprint/BlueprintParser";
import { Slider } from "../hitobjects/Slider";
import { ReplayFrame } from "../replays/Replay";
import { BucketedGameStateTimeMachine } from "./GameStateTimeMachine";
import { StableSliderBallPath } from "./StableSliderBallPath";
import { stablePerfectCurvePoints, stableSliderPathGeometry } from "./StableSliderPathGeometry";
import { StableSliderTiming } from "./StableSliderTiming";

// Aisubeki Hibi e #301: the cursor is near the follow boundary at the tail.
// Stable's circular path uses 25 ~8 px chords; Lazer uses a curvature tolerance.
function fixture() {
  return buildBeatmap(
    parseBlueprint(`osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:4
CircleSize:4
OverallDifficulty:8
ApproachRate:9.4
SliderMultiplier:3.3
SliderTickRate:1
[TimingPoints]
309,428.571428571429,4,2,1,80,1,0
68880,-80,4,2,1,80,0,1
[HitObjects]
265,179,79166,2,0,P|283:125|171:98,1,206.25
`),
    { addStacking: false },
  );
}

describe("Stable slider gameplay geometry", () => {
  it.each(["geometry", "replay"] as const)(
    "retains scalar precision in a circular radius before the stored float result (%s)",
    (checkKind) => {
      const map = buildBeatmap(
        parseBlueprint(`osu file format v14
[Difficulty]
CircleSize:4
OverallDifficulty:8
SliderMultiplier:1.9
SliderTickRate:1
[TimingPoints]
0,300,4,1,0,100,1,0
0,-83.3333333333333,4,1,0,100,0,0
[HitObjects]
502,251,14877,2,0,P|513:277|509:307,1,57
`),
        { addStacking: false },
      );
      const slider = map.hitObjects[0] as Slider;
      const geometry = stableSliderPathGeometry(slider);
      // Source x86 oracle radius55.553550720214844; rounding every squared
      // operation instead yields55.55354690551758 and delays acquisition past tail.
      if (checkKind === "geometry") {
        expect(geometry.points[5]).toEqual({ x: 513.2696533203125, y: 290.7017822265625 });
        expect(geometry.lengths.reduce((sum, length) => sum + length, 0)).toBe(56.999999046325684);
        const timing = new StableSliderTiming(slider);
        expect(timing.checkpointTime(timing.checkPoints[timing.checkPoints.length - 1])).toBe(14_916);
        return;
      }
      const machine = new BucketedGameStateTimeMachine(
        [
          { time: 14_882, position: { x: 487.3333, y: 252.3333 }, actions: [] },
          { time: 14_914, position: { x: 494.6667, y: 259.6667 }, actions: [] },
          { time: 14_916, position: { x: 494.3333, y: 259.6667 }, actions: [0] },
          { time: 14_952, position: { x: 485, y: 267.3333 }, actions: [0] },
        ],
        map,
        { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
      );
      const fork = machine.fork();
      const check = () => {
        expect(machine.gameStateAt(Infinity).checkPointVerdict["0/0"]).toEqual({ hit: true, judgementTime: 14_916 });
        expect(machine.gameStateAt(Infinity).sliderVerdict["0"]).toBe("GREAT");
      };
      check();
      machine.gameStateAt(14_914);
      check();
      expect(fork.gameStateAt(Infinity).sliderVerdict["0"]).toBe("GREAT");
    },
  );

  it.each([
    ["17,128,55642,2,0,P|23:102|31:76,3,53.5799993459473", 642.9599921513679, 53.579996109008789, 55855],
    ["121,193,42308,2,0,P|129:175|139:158,3,40.049998777771", 480.59998533325296, 40.049995422363281, 42521],
  ])("preserves x86 circular trimming at a repeated slider tail (%s)", (object, speed, expectedLength, tailTime) => {
    const map = buildBeatmap(
      parseBlueprint(`osu file format v14
[Difficulty]
SliderMultiplier:2
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
${object}
`),
      { addStacking: false },
    );
    const slider = map.hitObjects[0] as Slider;
    slider.stableTiming = { speed: speed as number, tickDistance: 200 };
    const timing = new StableSliderTiming(slider);
    // The source-shaped x86 oracle rounds vector writes, retaining scalar
    // normalization precision. An extra reciprocal round delays these tails.
    expect(stableSliderPathGeometry(slider).lengths.reduce((sum, length) => sum + length, 0)).toBe(expectedLength);
    expect(timing.checkpointTime(slider.checkPoints[slider.checkPoints.length - 1])).toBe(tailTime);
  });

  it("uses the same actual linear segment length for ball motion and scoring deadlines", () => {
    const map = buildBeatmap(
      parseBlueprint(`osu file format v14
[Difficulty]
SliderMultiplier:2
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
203,331,1000,2,0,L|25:25,1,40
`),
      { addStacking: false },
    );
    const slider = map.hitObjects[0] as Slider;
    // The x86 CLR source oracle gives length39.9999924 and end1099.
    expect(new StableSliderTiming(slider).endTime).toBe(1099);
    expect(new StableSliderBallPath(slider).positionAt(1099)).toEqual({
      x: 182.8873291015625,
      y: 296.4242858886719,
    });
  });

  it("retains x86 normalization precision while trimming absolute Bezier segments", () => {
    const map = buildBeatmap(
      parseBlueprint(`osu file format v14
[Difficulty]
SliderMultiplier:2
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
342,382,1000,2,0,B|388:347|388:347|379:257,1,148.499996664047
`),
      { addStacking: false },
    );
    const slider = map.hitObjects[0] as Slider;
    // Rounding the reciprocal before multiplication shifts y by one float ULP.
    expect(new StableSliderBallPath(slider).positionAt(Infinity)).toEqual({
      x: 378.97515869140625,
      y: 256.75152587890625,
    });
  });

  it("keeps the source chords unstacked and applies stacking after geometry", () => {
    const slider = fixture().hitObjects[0] as Slider;
    const points = stablePerfectCurvePoints(slider);
    expect(points).toHaveLength(26);
    expect(points?.[1]).toEqual({ x: 270.4983825683594, y: 172.85848999023438 });
    slider.head.position = { x: 260, y: 174 };
    expect(stablePerfectCurvePoints(slider)).toEqual(points);
    expect(new StableSliderBallPath(slider).positionAt(slider.startTime)).toEqual({ x: 260, y: 174 });
  });

  it("uses Stable's circular chords before quantizing movement times", () => {
    const slider = fixture().hitObjects[0] as Slider;
    const sharedPoints = slider.path.calculatedPath.map((p) => ({ ...p }));
    const path = new StableSliderBallPath(slider);
    // Local Stable source: 25 chords, float32 geometry, integer segment 79343..79351.
    expect(path.positionAt(79344)).toEqual({ x: 197.3312530517578, y: Number("77.147247314453125") });
    expect(slider.path.calculatedPath).toEqual(sharedPoints);
  });

  it("keeps the sampled tail hit near the circular follow boundary, including seeks", () => {
    const map = fixture();
    const frames: ReplayFrame[] = [
      { time: 79135, position: { x: 267.3333, y: 172.3333 }, actions: [] },
      { time: 79139, position: { x: 267.6667, y: 171.3333 }, actions: [0] },
      { time: 79166, position: { x: 270.3333, y: 163 }, actions: [0] },
      { time: 79344, position: { x: 160.3333, y: 156.3333 }, actions: [0] },
      { time: 79385, position: { x: 78.33334, y: 226 }, actions: [] },
    ];
    const machine = new BucketedGameStateTimeMachine(frames, map, {
      hitWindowStyle: "OSU_STABLE",
      noteLockStyle: "STABLE",
    });
    const fork = machine.fork();
    const check = () => {
      expect(machine.gameStateAt(Infinity).checkPointVerdict["0/0"]).toEqual({ hit: true, judgementTime: 79344 });
      expect(machine.gameStateAt(Infinity).sliderVerdict["0"]).toBe("GREAT");
    };
    check();
    machine.gameStateAt(79166);
    check();
    expect(fork.gameStateAt(Infinity).sliderVerdict["0"]).toBe("GREAT");
  });
});
