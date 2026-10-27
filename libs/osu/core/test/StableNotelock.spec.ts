import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { cloneGameState } from "../src/gameplay/GameState";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { PathType } from "../src/hitobjects/slider/PathType";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const stableOptions = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;

function circle(id: string, time: number, position: { x: number; y: number }): HitCircle {
  const result = new HitCircle();
  result.id = id;
  result.hitTime = time;
  result.approachDuration = 600;
  result.position = position;
  result.unstackedPosition = position;
  return result;
}

function beatmap(hitObjects: Beatmap["hitObjects"]): Beatmap {
  return new Beatmap([...hitObjects], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
}

function frame(time: number, position: { x: number; y: number }, pressed = false): ReplayFrame {
  return { time, position, actions: pressed ? [OsuAction.leftButton] : [] };
}

describe("Stable evaluator-owned notelock evidence", () => {
  it("keeps a completed slider head locking a later non-overlapping circle until the slider parent ends", () => {
    const head = circle("slider/HEAD", 1_000, { x: 100, y: 100 });
    head.sliderId = "slider";
    const slider = new Slider(head);
    slider.id = "slider";
    slider.velocity = 1;
    slider.path = new SliderPath(
      [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 500, y: 0 } }],
      500,
    );
    const target = circle("target", slider.endTime + 80, { x: 300, y: 100 });
    const map = beatmap([slider, target]);
    const blockedPressTime = target.hitTime - 374;
    const state = new BucketedGameStateTimeMachine(
      [
        frame(head.hitTime, head.position, true),
        frame(head.hitTime + 1, head.position),
        frame(blockedPressTime, target.position, true),
        frame(blockedPressTime + 1, target.position),
        frame(slider.endTime, target.position),
        frame(target.hitTime + 25, target.position, true),
      ],
      map,
      stableOptions,
    ).gameStateAt(1e9);

    expect(state.hitCircleVerdict[head.id]).toMatchObject({ type: "GREAT" });
    expect(state.hitCircleVerdict[target.id]).toMatchObject({ type: "GREAT", judgementTime: target.hitTime + 25 });
    expect(state.stableNotelockEvidence[target.id]).toBeUndefined();
  });

  it("does not let an active slider block an overlapping 2B circle", () => {
    const head = circle("slider/HEAD", 1_000, { x: 100, y: 100 });
    head.sliderId = "slider";
    const slider = new Slider(head);
    slider.id = "slider";
    slider.velocity = 1;
    slider.path = new SliderPath(
      [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 500, y: 0 } }],
      500,
    );
    const target = circle("target", 1_250, { x: 300, y: 100 });
    const map = beatmap([slider, target]);
    const state = new BucketedGameStateTimeMachine(
      [
        frame(head.hitTime, head.position, true),
        frame(head.hitTime + 1, head.position),
        frame(target.hitTime, target.position, true),
      ],
      map,
      stableOptions,
    ).gameStateAt(1e9);

    expect(target.hitTime).toBeLessThan(slider.endTime);
    expect(state.hitCircleVerdict[target.id]).toMatchObject({ type: "GREAT", judgementTime: target.hitTime });
    expect(state.lastNotelockShakeTime[target.id]).toBeUndefined();
  });

  it("records repeated blocked presses and preserves their latest shake through clone/seek", () => {
    const blocker = circle("blocker", 1_000, { x: 100, y: 100 });
    const target = circle("target", 1_100, { x: 300, y: 100 });
    const map = beatmap([blocker, target]);
    const machine = new BucketedGameStateTimeMachine(
      [
        frame(1_100, target.position, true),
        frame(1_101, target.position),
        frame(1_120, target.position, true),
        frame(1_121, target.position),
        frame(1_300, target.position),
      ],
      map,
      stableOptions,
      1,
    );

    const blocked = machine.gameStateAt(1_100);
    expect(blocked.stableNotelockEvidence[target.id]).toMatchObject({
      targetHitObjectId: target.id,
      blockerHitObjectId: blocker.id,
      pressTime: 1_100,
      cursorDistance: 0,
      objectRadius: 64.02623748779297,
      wouldHaveHit: "GREAT",
    });
    expect(blocked.lastNotelockShakeTime[target.id]).toBe(1_100);

    const blockedAgain = machine.gameStateAt(1_120);
    expect(blockedAgain.stableNotelockEvidence[target.id].pressTime).toBe(1_100);
    expect(blockedAgain.lastNotelockShakeTime[target.id]).toBe(1_120);

    const cloned = cloneGameState(blockedAgain);
    cloned.stableNotelockEvidence[target.id].pressTime = -1;
    cloned.lastNotelockShakeTime[target.id] = -1;
    expect(blocked.stableNotelockEvidence[target.id].pressTime).toBe(1_100);
    expect(blockedAgain.lastNotelockShakeTime[target.id]).toBe(1_120);

    const finalState = machine.gameStateAt(1e9);
    expect(finalState.hitCircleVerdict[target.id]).toMatchObject({ type: "MISS", missReason: "TIME_EXPIRED" });

    const rewound = machine.gameStateAt(1_100);
    expect(rewound.hitCircleVerdict[target.id]).toBeUndefined();
    expect(rewound.stableNotelockEvidence[target.id].pressTime).toBe(1_100);
    expect(rewound.lastNotelockShakeTime[target.id]).toBe(1_100);
  });

  it("clears blocked-press provenance when the target is later hit successfully", () => {
    const blocker = circle("blocker", 1_000, { x: 100, y: 100 });
    const target = circle("target", 1_200, { x: 300, y: 100 });
    const map = beatmap([blocker, target]);
    const state = new BucketedGameStateTimeMachine(
      [
        frame(1_100, target.position, true),
        frame(1_101, target.position),
        frame(1_155, target.position),
        frame(1_160, target.position, true),
      ],
      map,
      stableOptions,
    ).gameStateAt(1e9);

    expect(state.hitCircleVerdict[target.id]).toMatchObject({ type: "GREAT", judgementTime: 1_160 });
    expect(state.stableNotelockEvidence[target.id]).toBeUndefined();
  });

  it("does not add provenance to an ordinary timeout miss", () => {
    const target = circle("target", 1_000, { x: 300, y: 100 });
    const map = beatmap([target]);
    const state = new BucketedGameStateTimeMachine([frame(1_200, target.position)], map, stableOptions).gameStateAt(
      1e9,
    );

    expect(state.hitCircleVerdict[target.id]).toMatchObject({ type: "MISS", missReason: "TIME_EXPIRED" });
    expect(state.stableNotelockEvidence[target.id]).toBeUndefined();
  });

  it("does not record a blocked press outside the target's successful hit window", () => {
    const blocker = circle("blocker", 1_000, { x: 100, y: 100 });
    const target = circle("target", 1_100, { x: 300, y: 100 });
    const map = beatmap([blocker, target]);
    const state = new BucketedGameStateTimeMachine(
      [frame(800, target.position, true), frame(801, target.position), frame(1_300, target.position)],
      map,
      stableOptions,
    ).gameStateAt(1e9);

    expect(state.hitCircleVerdict[target.id]).toMatchObject({ type: "MISS", missReason: "TIME_EXPIRED" });
    expect(state.stableNotelockEvidence[target.id]).toBeUndefined();
    expect(state.lastNotelockShakeTime[target.id]).toBe(800);
  });

  it("records blocked slider-head evidence when the slider is an actual MISS", () => {
    const blocker = circle("blocker", 1_000, { x: 100, y: 100 });
    const head = circle("slider/HEAD", 1_100, { x: 300, y: 100 });
    head.sliderId = "slider";
    const slider = new Slider(head);
    slider.id = "slider";
    slider.velocity = 1;
    slider.path = new SliderPath(
      [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }],
      100,
    );
    const map = beatmap([blocker, slider]);
    const state = new BucketedGameStateTimeMachine(
      [frame(1_100, head.position, true), frame(1_101, head.position), frame(slider.endTime, slider.endPosition)],
      map,
      stableOptions,
    ).gameStateAt(1e9);

    expect(state.sliderVerdict[slider.id]).toBe("MISS");
    expect(state.stableNotelockEvidence[head.id]).toEqual({
      targetHitObjectId: head.id,
      blockerHitObjectId: blocker.id,
      pressTime: 1_100,
      cursorDistance: 0,
      objectRadius: 64.02623748779297,
      wouldHaveHit: "GREAT",
    });
  });
});
