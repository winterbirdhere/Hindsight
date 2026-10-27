import { buildBeatmap } from "../beatmap/BeatmapBuilder";
import { parseBlueprint } from "../blueprint/BlueprintParser";
import { Slider } from "../hitobjects/Slider";
import { OsuAction, ReplayFrame } from "../replays/Replay";
import { retrieveEvents } from "./GameplayAnalysisEvent";
import { BucketedGameStateTimeMachine } from "./GameStateTimeMachine";

describe("Stable checkpoint timing", () => {
  it("judges a fractional tail at Stable's integer time before the following release", () => {
    const beatmap = buildBeatmap(
      parseBlueprint(`osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
64,192,1000,2,0,L|164:192,1,100
`),
      { addStacking: false },
    );
    const slider = beatmap.hitObjects[0] as Slider;
    const tail = slider.checkPoints[0];
    const fractionalTime = tail.hitTime;
    const stableTime = Math.trunc(fractionalTime);
    expect(fractionalTime).toBeGreaterThan(stableTime);
    const ball = slider.ballPositionAt((stableTime - slider.startTime) / slider.duration);
    const position = { x: ball.x, y: ball.y + slider.radius * 2.39 };
    const frames: ReplayFrame[] = [
      { time: 900, position: slider.startPosition, actions: [] },
      { time: slider.startTime, position: slider.startPosition, actions: [OsuAction.leftButton] },
      { time: stableTime, position, actions: [OsuAction.leftButton] },
      { time: stableTime + 1, position: { x: position.x, y: position.y + slider.radius }, actions: [] },
      { time: slider.endTime + 1, position, actions: [] },
    ];
    const machine = new BucketedGameStateTimeMachine(frames, beatmap, {
      hitWindowStyle: "OSU_STABLE",
      noteLockStyle: "STABLE",
    });

    expect(machine.gameStateAt(stableTime - 1).checkPointVerdict[tail.id]).toBeUndefined();
    expect(machine.gameStateAt(stableTime).checkPointVerdict[tail.id]).toEqual({
      hit: true,
      judgementTime: stableTime,
    });
    const state = machine.gameStateAt(Infinity);
    expect(state.sliderVerdict[slider.id]).toBe("GREAT");
    expect(retrieveEvents(state, beatmap.hitObjects, "stable")).toContainEqual(
      expect.objectContaining({
        type: "CheckpointJudgement",
        checkpointId: tail.id,
        hit: true,
        objectTime: fractionalTime,
        judgementTime: stableTime,
        time: stableTime,
      }),
    );
    // The native Lazer evaluator shares these objects and retains their precision.
    expect(tail.hitTime).toBe(fractionalTime);
    expect(machine.gameStateAt(stableTime - 1).checkPointVerdict[tail.id]).toBeUndefined();
    expect(machine.gameStateAt(stableTime).checkPointVerdict[tail.id]?.hit).toBe(true);
  });
});
