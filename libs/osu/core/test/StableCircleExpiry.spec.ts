import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { GameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const stableOptions = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;
const position = { x: 100, y: 100 };

function circle(id: string, time: number, x = position.x): HitCircle {
  const result = new HitCircle();
  result.id = id;
  result.hitTime = time;
  result.approachDuration = 600;
  result.scale = 0.5;
  result.position = { x, y: position.y };
  result.unstackedPosition = result.position;
  return result;
}

function beatmap(objects: HitCircle[]): Beatmap {
  return new Beatmap(objects, { ...DEFAULT_BEATMAP_DIFFICULTY, overallDifficulty: 9 }, [], new ControlPointInfo());
}

function frame(time: number, mask = 0, x = position.x): ReplayFrame {
  return {
    time,
    position: { x, y: position.y },
    rawButtonMask: mask,
    actions: [...(mask & 5 ? [OsuAction.leftButton] : []), ...(mask & 10 ? [OsuAction.rightButton] : [])],
  };
}

describe("Stable input before circle expiry", () => {
  it("keeps an ineligible earlier circle blocking input until the expiry update", () => {
    const first = circle("first", 1_000);
    const second = circle("second", 1_055);
    const map = beatmap([first, second]);
    const machine = new BucketedGameStateTimeMachine(
      [frame(1_109), frame(1_115, 5), frame(1_200)],
      map,
      stableOptions,
      1,
    );

    const pressed = machine.gameStateAt(1_115);
    expect(pressed.hitCircleVerdict[first.id]).toEqual({
      type: "MISS",
      judgementTime: 1_115,
      missReason: "TIME_EXPIRED",
    });
    expect(pressed.hitCircleVerdict[second.id]).toBeUndefined();
    expect(pressed.stableNotelockEvidence[second.id]).toMatchObject({ blockerHitObjectId: first.id });
    const final = machine.gameStateAt(1_200);
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(final).verdictCounts).toEqual([0, 0, 0, 2]);
    const fork = machine.fork();
    machine.gameStateAt(1_109);
    expect(machine.gameStateAt(1_115).hitCircleVerdict[second.id]).toBeUndefined();
    expect(fork.gameStateAt(1_200).hitCircleVerdict).toEqual(final.hitCircleVerdict);
  });

  it("keeps an off-target expired circle blocking input until that frame's update", () => {
    const first = circle("first", 1_000, 300);
    const second = circle("second", 1_055);
    const machine = new BucketedGameStateTimeMachine(
      [frame(1_109), frame(1_115, 5), frame(1_116), frame(1_120, 5)],
      beatmap([first, second]),
      stableOptions,
    );
    const blocked = machine.gameStateAt(1_115);
    expect(blocked.hitCircleVerdict[second.id]).toBeUndefined();
    expect(blocked.stableNotelockEvidence[second.id]).toMatchObject({
      blockerHitObjectId: first.id,
      pressTime: 1_115,
      wouldHaveHit: "OK",
    });
    expect(machine.gameStateAt(1_120).hitCircleVerdict[second.id]).toMatchObject({
      type: "OK",
      judgementTime: 1_120,
    });
  });

  it("expires only after the nominal 50 window while retaining its blocker through input", () => {
    const first = circle("first", 1_000);
    const second = circle("second", 1_055);
    const machine = new BucketedGameStateTimeMachine(
      [frame(1_110), frame(1_111, 5)],
      beatmap([first, second]),
      stableOptions,
    );
    expect(machine.gameStateAt(1_110).hitCircleVerdict[first.id]).toBeUndefined();
    const state = machine.gameStateAt(1_111);
    expect(state.hitCircleVerdict[first.id]).toMatchObject({ type: "MISS", judgementTime: 1_111 });
    expect(state.hitCircleVerdict[second.id]).toBeUndefined();
  });

  it("expires during an input-free update so a later press can reach the next circle", () => {
    const first = circle("first", 1_000);
    const second = circle("second", 1_055);
    const state = new BucketedGameStateTimeMachine(
      [frame(1_109), frame(1_115), frame(1_120, 5)],
      beatmap([first, second]),
      stableOptions,
    ).gameStateAt(1_120);
    expect(state.hitCircleVerdict[first.id]).toMatchObject({ type: "MISS", judgementTime: 1_115 });
    expect(state.hitCircleVerdict[second.id]).toMatchObject({ type: "OK", judgementTime: 1_120 });
  });

  it("keeps both simultaneous presses blocked until the expired circle is judged by the update", () => {
    const first = circle("first", 1_000);
    const second = circle("second", 1_055);
    const third = circle("third", 1_065);
    const state = new BucketedGameStateTimeMachine(
      [frame(1_109), frame(1_115, 15)],
      beatmap([first, second, third]),
      stableOptions,
    ).gameStateAt(1_115);
    expect(state.hitCircleVerdict[first.id]).toMatchObject({ type: "MISS", judgementTime: 1_115 });
    expect(state.hitCircleVerdict[second.id]).toBeUndefined();
    expect(state.stableNotelockEvidence[second.id]).toMatchObject({ blockerHitObjectId: first.id, pressTime: 1_115 });
    expect(state.hitCircleVerdict[third.id]).toBeUndefined();
  });

  it("does not pass a sparse-frame press through an expired circle beyond the miss input window", () => {
    const first = circle("first", 1_000);
    const second = circle("second", 1_420);
    const state = new BucketedGameStateTimeMachine(
      [frame(1_109), frame(1_430, 5)],
      beatmap([first, second]),
      stableOptions,
    ).gameStateAt(1_430);
    expect(state.hitCircleVerdict[first.id]).toMatchObject({ type: "MISS", judgementTime: 1_430 });
    expect(state.hitCircleVerdict[second.id]).toBeUndefined();
  });

  it("retains native Lazer's independent expiry before later input", () => {
    const first = circle("first", 1_000);
    const second = circle("second", 1_055);
    const state = new LazerGameStateTimeMachine([frame(1_109), frame(1_115, 5)], beatmap([first, second])).gameStateAt(
      1_115,
    );
    expect(state.hitCircleVerdict[first.id]).toMatchObject({ type: "MISS" });
    expect(state.hitCircleVerdict[second.id]).toMatchObject({ type: "OK", judgementTime: 1_115 });
  });
});
