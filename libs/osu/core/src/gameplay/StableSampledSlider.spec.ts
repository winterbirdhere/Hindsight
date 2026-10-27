import { buildBeatmap } from "../beatmap/BeatmapBuilder";
import { parseBlueprint } from "../blueprint/BlueprintParser";
import { Slider } from "../hitobjects/Slider";
import { OsuAction, ReplayFrame } from "../replays/Replay";
import { BucketedGameStateTimeMachine } from "./GameStateTimeMachine";

function fixture(hitObject = "64,192,1000,2,0,L|164:192,1,100", timing = "0,360,4,1,0,100,1,0", multiplier = 3.6) {
  return buildBeatmap(
    parseBlueprint(`osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:9
ApproachRate:9
SliderMultiplier:${multiplier}
SliderTickRate:1
[TimingPoints]
${timing}
[HitObjects]
${hitObject}
`),
    { addStacking: false },
  );
}

const frame = (time: number, x: number, y = 192, held = true): ReplayFrame => ({
  time,
  position: { x, y },
  actions: held ? [OsuAction.leftButton] : [],
});

function linearMachine(samples: ReplayFrame[]) {
  const beatmap = fixture();
  const slider = beatmap.hitObjects[0] as Slider;
  const machine = new BucketedGameStateTimeMachine(
    [frame(900, 64, 192, false), frame(1000, 64), ...samples],
    beatmap,
    { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
    2,
  );
  return { machine, slider };
}

describe("Stable slider scoring from recorded updates", () => {
  it("does not acquire tracking from an interpolated start before the first recorded update", () => {
    const beatmap = fixture();
    const slider = beatmap.hitObjects[0] as Slider;
    const machine = new BucketedGameStateTimeMachine(
      [
        frame(900, -100, -100),
        frame(990, 64, 217),
        frame(1010, 74, 237),
        frame(1070, 134, 237),
        frame(1110, 164, 237),
        frame(1111, 164, 237),
      ],
      beatmap,
      { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
    );
    const state = machine.gameStateAt(Infinity);
    expect(state.hitCircleVerdict[slider.head.id]?.type).toBe("MISS");
    expect(state.checkPointVerdict[slider.checkPoints[0].id]?.hit).toBe(false);
    expect(state.sliderVerdict[slider.id]).toBe("MISS");
  });

  it("uses the recorded cursor at the scoring update instead of crediting an interpolated tail", () => {
    const { machine, slider } = linearMachine([frame(1050, 114), frame(1080, 144, 292), frame(1110, 164, 292)]);
    expect(machine.gameStateAt(1079).checkPointVerdict[slider.checkPoints[0].id]).toBeUndefined();
    expect(machine.gameStateAt(1080).checkPointVerdict[slider.checkPoints[0].id]).toEqual({
      hit: false,
      judgementTime: 1080,
    });
    expect(machine.gameStateAt(Infinity).sliderVerdict[slider.id]).toBe("OK");
  });

  it("observes a release in the recorded scoring update", () => {
    const { machine, slider } = linearMachine([
      frame(1050, 114),
      frame(1080, 144, 192, false),
      frame(1110, 164, 192, false),
    ]);
    expect(machine.gameStateAt(Infinity).checkPointVerdict[slider.checkPoints[0].id]?.hit).toBe(false);
  });

  it("does not award an overdue checkpoint when tracking is reacquired after its deadline", () => {
    const { machine, slider } = linearMachine([frame(1040, 104, 292), frame(1065, 129), frame(1110, 164)]);
    const state = machine.gameStateAt(Infinity);
    expect(state.checkPointVerdict[slider.checkPoints[0].id]).toEqual({ hit: false, judgementTime: 1065 });
    expect(state.sliderVerdict[slider.id]).toBe("OK");
  });

  it("accepts reacquisition exactly at the checkpoint deadline", () => {
    const { machine, slider } = linearMachine([frame(1040, 104, 292), frame(1064, 128), frame(1110, 164)]);
    expect(machine.gameStateAt(Infinity).checkPointVerdict[slider.checkPoints[0].id]).toEqual({
      hit: true,
      judgementTime: 1064,
    });
  });

  it("can resolve an already tracked tail at the first update after the slider end", () => {
    const { machine, slider } = linearMachine([frame(1050, 114), frame(1110, 164)]);
    expect(machine.gameStateAt(Infinity).checkPointVerdict[slider.checkPoints[0].id]).toEqual({
      hit: true,
      judgementTime: 1110,
    });
    expect(machine.gameStateAt(Infinity).sliderVerdict[slider.id]).toBe("GREAT");
  });

  it("retains the sampled outcome across backward seeks and forked traversal", () => {
    const { machine, slider } = linearMachine([frame(1040, 104, 292), frame(1065, 129), frame(1110, 164)]);
    const expected = machine.gameStateAt(Infinity).checkPointVerdict[slider.checkPoints[0].id];
    const fork = machine.fork();
    expect(machine.gameStateAt(1040).checkPointVerdict[slider.checkPoints[0].id]).toBeUndefined();
    expect(machine.gameStateAt(Infinity).checkPointVerdict[slider.checkPoints[0].id]).toEqual(expected);
    fork.gameStateAt(1000);
    expect(fork.gameStateAt(Infinity).checkPointVerdict[slider.checkPoints[0].id]).toEqual(expected);
  });

  it("finishes the parent at its integer Stable end before a later early press", () => {
    const beatmap = fixture("64,192,1000,2,0,L|164.5:192,1,100.5\n300,192,1150,1,0");
    const slider = beatmap.hitObjects[0] as Slider;
    const machine = new BucketedGameStateTimeMachine(
      [
        frame(900, 64, 192, false),
        frame(1000, 64),
        frame(1064, 128),
        frame(1100, 300, 192, false),
        frame(1120, 300),
        frame(1160, 300),
      ],
      beatmap,
      { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
    );
    expect(slider.endTime).toBe(1100.5);
    expect(machine.gameStateAt(1100).sliderVerdict[slider.id]).toBe("GREAT");
    expect(machine.gameStateAt(Infinity).hitCircleVerdict["1"]).toMatchObject({ type: "OK", judgementTime: 1120 });
  });

  it("uses integer path-segment timing for a late head near the initial tracking radius", () => {
    const beatmap = fixture(
      "43,312,66153,2,0,P|95:292|151:287,1,104.999996795654",
      "242,352.941176470588,4,2,1,50,1,0\n62359,-71.4285714285714,4,2,1,70,0,1",
      3,
    );
    const slider = beatmap.hitObjects[0] as Slider;
    const machine = new BucketedGameStateTimeMachine(
      [
        frame(66159, 32.66667, 330.3333, false),
        frame(66167, 32.66667, 330.3333),
        frame(66176, 35.33333, 329),
        frame(66192, 45.66667, 317.6667),
        frame(66209, 64.66666, 301.6667),
        frame(66221, 83.66666, 288),
        frame(66250, 124.6667, 258.3333),
      ],
      beatmap,
      { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
    );
    const state = machine.gameStateAt(Infinity);
    expect(state.hitCircleVerdict[slider.head.id]?.type).toBe("GREAT");
    expect(state.checkPointVerdict[slider.checkPoints[0].id]?.hit).toBe(false);
    expect(state.sliderVerdict[slider.id]).toBe("OK");
  });
});
