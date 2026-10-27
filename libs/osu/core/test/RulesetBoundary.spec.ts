import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { SliderCheckPoint } from "../src/hitobjects/SliderCheckPoint";
import { PathType } from "../src/hitobjects/slider/PathType";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const stableOptions = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;

function stableSliderTrackingAt(distanceInRadii: number, trackingBeforeCheckpoint = true): boolean {
  const head = new HitCircle();
  head.id = "slider/HEAD";
  head.hitTime = 1_000;
  head.approachDuration = 600;
  head.position = { x: 100, y: 192 };
  head.unstackedPosition = head.position;
  head.sliderId = "slider";

  const slider = new Slider(head);
  slider.id = "slider";
  slider.velocity = 0.1;
  slider.path = new SliderPath(
    [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }],
    100,
  );

  const checkpoint = new SliderCheckPoint(slider);
  checkpoint.id = "slider/TICK";
  checkpoint.type = "TICK";
  checkpoint.hitTime = 1_500;
  checkpoint.spanProgress = 0.5;
  checkpoint.offset = { x: 50, y: 0 };
  slider.checkPoints = [checkpoint];

  const checkpointPosition = slider.ballPositionAt(0.5);
  const precedingPosition = trackingBeforeCheckpoint
    ? slider.ballPositionAt(0.001)
    : { x: slider.ballPositionAt(0.001).x, y: slider.ballPositionAt(0.001).y + slider.radius * 3 };
  const map = new Beatmap([slider], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
  const frames: ReplayFrame[] = [
    { time: 1_000, position: slider.startPosition, actions: [OsuAction.leftButton] },
    { time: 1_001, position: precedingPosition, actions: [OsuAction.leftButton] },
    {
      time: checkpoint.hitTime,
      position: { x: checkpointPosition.x, y: checkpointPosition.y + slider.radius * distanceInRadii },
      actions: [OsuAction.leftButton],
    },
  ];

  return new BucketedGameStateTimeMachine(frames, map, stableOptions).gameStateAt(checkpoint.hitTime)
    .checkPointVerdict[checkpoint.id].hit;
}

describe("Stable/lazer evaluator boundary", () => {
  it("keeps the two simulations isolated at the one-millisecond GREAT boundary", () => {
    const circle = new HitCircle();
    circle.id = "0";
    circle.hitTime = 1_000;
    circle.approachDuration = 600;
    circle.position = { x: 256, y: 192 };
    const beatmap = new Beatmap([circle], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
    const frames: ReplayFrame[] = [
      { time: 0, position: circle.position, actions: [] },
      { time: 1_049.25, position: circle.position, actions: [OsuAction.leftButton] },
      { time: 1_050, position: circle.position, actions: [] },
    ];

    const stable = new BucketedGameStateTimeMachine(frames, beatmap, {
      hitWindowStyle: "OSU_STABLE",
      noteLockStyle: "STABLE",
    }).gameStateAt(1e9);
    const lazer = new BucketedGameStateTimeMachine(frames, beatmap, {
      hitWindowStyle: "OSU_LAZER",
      noteLockStyle: "LAZER",
    }).gameStateAt(1e9);

    expect(stable.hitCircleVerdict[circle.id]).toMatchObject({ type: "OK", judgementTime: 1_049.25 });
    expect(lazer.hitCircleVerdict[circle.id]).toMatchObject({ type: "GREAT", judgementTime: 1_049.25 });
  });

  it("uses the Stable 2.4x expanded follow radius after tracking has begun", () => {
    expect(stableSliderTrackingAt(2.399)).toBe(true);
    expect(stableSliderTrackingAt(2.401)).toBe(false);
  });

  it("keeps the Stable reacquisition radius at 1x after tracking is lost", () => {
    expect(stableSliderTrackingAt(0.999, false)).toBe(true);
    expect(stableSliderTrackingAt(1.001, false)).toBe(false);
  });

  it("stops Stable simulation at the final replay frame after resolving only overdue objects", () => {
    const overdue = new HitCircle();
    overdue.id = "overdue";
    overdue.hitTime = 1_000;
    overdue.approachDuration = 600;
    overdue.position = { x: 256, y: 192 };
    overdue.unstackedPosition = overdue.position;

    const afterFailure = new HitCircle();
    afterFailure.id = "after-failure";
    afterFailure.hitTime = 1_500;
    afterFailure.approachDuration = 600;
    afterFailure.position = { x: 256, y: 192 };
    afterFailure.unstackedPosition = afterFailure.position;

    const map = new Beatmap([overdue, afterFailure], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
    const state = new BucketedGameStateTimeMachine(
      [{ time: 1_300, position: overdue.position, actions: [] }],
      map,
      stableOptions,
    ).gameStateAt(1e9);

    expect(state.currentTime).toBe(1_300);
    expect(state.hitCircleVerdict[overdue.id]).toMatchObject({
      type: "MISS",
      missReason: "TIME_EXPIRED",
    });
    expect(state.hitCircleVerdict[afterFailure.id]).toBeUndefined();
    expect(state.judgedObjects).toEqual([overdue.id]);
  });
});
