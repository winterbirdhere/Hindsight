import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { OsuAction, ReplayButtonState, ReplayFrame } from "../src/replays/Replay";

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

function beatmap(hitObjects: Beatmap["hitObjects"], mods: Beatmap["appliedMods"] = []): Beatmap {
  return new Beatmap([...hitObjects], DEFAULT_BEATMAP_DIFFICULTY, mods, new ControlPointInfo());
}

function rawFrame(time: number, position: { x: number; y: number }, rawButtonMask: number): ReplayFrame {
  return {
    time,
    position,
    rawButtonMask,
    actions: [
      ...(rawButtonMask & (ReplayButtonState.Left1 | ReplayButtonState.Left2) ? [OsuAction.leftButton] : []),
      ...(rawButtonMask & (ReplayButtonState.Right1 | ReplayButtonState.Right2) ? [OsuAction.rightButton] : []),
    ],
  };
}

describe("Stable logical presses from physical replay masks", () => {
  it.each<[string, number]>([
    ["both keyboard keys", 15],
    ["both mouse buttons", 3],
    ["left mouse and right keyboard", 11],
    ["left keyboard and right mouse", 7],
  ])("judges two ordered circles for simultaneous %s", (_, mask) => {
    const position = { x: 100, y: 100 };
    const first = circle("first", 1_000, position);
    const second = circle("second", 1_080, position);
    const third = circle("third", 1_090, position);
    const machine = new BucketedGameStateTimeMachine(
      [rawFrame(900, position, 0), rawFrame(1_055, position, mask), rawFrame(1_060, position, mask)],
      beatmap([first, second, third]),
      stableOptions,
      1,
    );
    const state = machine.gameStateAt(1_060);

    expect(state.hitCircleVerdict[first.id]).toMatchObject({ type: "OK", judgementTime: 1_055 });
    expect(state.hitCircleVerdict[second.id]).toMatchObject({ type: "GREAT", judgementTime: 1_055 });
    expect(state.hitCircleVerdict[third.id]).toBeUndefined();
    machine.gameStateAt(900);
    expect(machine.gameStateAt(1_060).hitCircleVerdict).toEqual(state.hitCircleVerdict);
  });

  it("supports simultaneous logical actions when physical masks are unavailable", () => {
    const position = { x: 100, y: 100 };
    const first = circle("first", 1_000, position);
    const second = circle("second", 1_010, position);
    const state = new BucketedGameStateTimeMachine(
      [
        { time: 900, position, actions: [] },
        { time: 1_000, position, actions: [OsuAction.leftButton, OsuAction.rightButton] },
      ],
      beatmap([first, second]),
      stableOptions,
    ).gameStateAt(1_000);

    expect(state.hitCircleVerdict[first.id]).toMatchObject({ type: "GREAT", judgementTime: 1_000 });
    expect(state.hitCircleVerdict[second.id]).toMatchObject({ type: "GREAT", judgementTime: 1_000 });
  });

  it("does not count a keyboard discriminator or its logical action as an extra press", () => {
    const position = { x: 100, y: 100 };
    const first = circle("first", 1_000, position);
    const second = circle("second", 1_010, position);
    const state = new BucketedGameStateTimeMachine(
      [rawFrame(900, position, 0), rawFrame(1_000, position, 5), rawFrame(1_010, position, 5)],
      beatmap([first, second]),
      stableOptions,
    ).gameStateAt(1_010);

    expect(state.hitCircleVerdict[first.id]).toMatchObject({ type: "GREAT" });
    expect(state.hitCircleVerdict[second.id]).toBeUndefined();
  });

  it.each([true, false])(
    "does not reuse a held press on a second frame at the same timestamp (raw mask: %s)",
    (raw) => {
      const position = { x: 100, y: 100 };
      const first = circle("first", 1_000, position);
      const second = circle("second", 1_010, position);
      const frames = [rawFrame(900, position, 0), rawFrame(1_000, position, 5), rawFrame(1_000, position, 5)];
      if (!raw) frames.forEach((frame) => delete frame.rawButtonMask);
      const state = new BucketedGameStateTimeMachine(frames, beatmap([first, second]), stableOptions).gameStateAt(
        1_000,
      );

      expect(state.hitCircleVerdict[first.id]).toMatchObject({ type: "GREAT", judgementTime: 1_000 });
      expect(state.hitCircleVerdict[second.id]).toBeUndefined();
    },
  );

  it("accepts a released and re-pressed key at the same timestamp as a separate attempt", () => {
    const position = { x: 100, y: 100 };
    const first = circle("first", 1_000, position);
    const second = circle("second", 1_010, position);
    const third = circle("third", 1_020, position);
    const state = new BucketedGameStateTimeMachine(
      [
        rawFrame(900, position, 0),
        rawFrame(1_000, position, 5),
        rawFrame(1_000, position, 0),
        rawFrame(1_000, position, 5),
        rawFrame(1_000, position, 5),
      ],
      beatmap([first, second, third]),
      stableOptions,
    ).gameStateAt(1_000);

    expect(state.hitCircleVerdict[first.id]).toMatchObject({ type: "GREAT", judgementTime: 1_000 });
    expect(state.hitCircleVerdict[second.id]).toMatchObject({ type: "GREAT", judgementTime: 1_000 });
    expect(state.hitCircleVerdict[third.id]).toBeUndefined();
  });

  it("consumes each premature miss attempt without judging a third circle", () => {
    const position = { x: 100, y: 100 };
    const first = circle("first", 1_200, position);
    const second = circle("second", 1_210, position);
    const third = circle("third", 1_220, position);
    const state = new BucketedGameStateTimeMachine(
      [rawFrame(900, position, 0), rawFrame(1_000, position, 15)],
      beatmap([first, second, third]),
      stableOptions,
    ).gameStateAt(1_000);

    expect(state.hitCircleVerdict[first.id]).toMatchObject({ type: "MISS", missReason: "HIT_TOO_EARLY" });
    expect(state.hitCircleVerdict[second.id]).toMatchObject({ type: "MISS", missReason: "HIT_TOO_EARLY" });
    expect(state.hitCircleVerdict[third.id]).toBeUndefined();
  });

  it("does not bypass notelock or carry rejected presses into a later frame", () => {
    const blocker = circle("blocker", 1_000, { x: 100, y: 100 });
    const target = circle("target", 1_020, { x: 300, y: 100 });
    const state = new BucketedGameStateTimeMachine(
      [rawFrame(900, target.position, 0), rawFrame(1_000, target.position, 15), rawFrame(1_010, blocker.position, 15)],
      beatmap([blocker, target]),
      stableOptions,
    ).gameStateAt(1_010);

    expect(state.hitCircleVerdict).toEqual({});
    expect(state.stableNotelockEvidence[target.id]).toMatchObject({
      blockerHitObjectId: blocker.id,
      pressTime: 1_000,
    });
  });

  it.each([0, 15])("preserves Relax's per-parent automatic attempts regardless of physical mask %i", (mask) => {
    const position = { x: 100, y: 100 };
    const first = circle("first", 1_000, position);
    const second = circle("second", 1_010, position);
    const machine = new BucketedGameStateTimeMachine(
      [rawFrame(900, position, 0), rawFrame(1_000, position, mask), rawFrame(1_010, position, mask)],
      beatmap([first, second], ["RELAX"]),
      stableOptions,
    );

    const expected = {
      [first.id]: { type: "GREAT", judgementTime: 1_000 },
      [second.id]: { type: "GREAT", judgementTime: 1_000 },
    };
    expect(machine.gameStateAt(1_000).hitCircleVerdict).toEqual(expected);
    expect(machine.gameStateAt(1_010).hitCircleVerdict).toEqual(expected);
  });

  it("does not hit again when a physical key changes but its logical action remains held", () => {
    const target = circle("target", 1_000, { x: 300, y: 100 });
    const state = new BucketedGameStateTimeMachine(
      [
        rawFrame(900, { x: 0, y: 0 }, ReplayButtonState.Left1),
        rawFrame(1_000, target.position, ReplayButtonState.Left1 | ReplayButtonState.Left2),
      ],
      beatmap([target]),
      stableOptions,
    ).gameStateAt(1_000);

    expect(state.hitCircleVerdict[target.id]).toBeUndefined();
    // Physical input must not restart the logical hold used by slider tracking.
    expect(state.pressingSince[OsuAction.leftButton]).toBe(900);
  });

  it("does not record notelock evidence for a physical change on an already-held logical side", () => {
    const blocker = circle("blocker", 1_000, { x: 100, y: 100 });
    const target = circle("target", 1_100, { x: 300, y: 100 });
    const state = new BucketedGameStateTimeMachine(
      [
        rawFrame(1_050, { x: 500, y: 300 }, ReplayButtonState.Left1),
        rawFrame(1_100, target.position, ReplayButtonState.Left1 | ReplayButtonState.Left2),
        rawFrame(1_101, target.position, ReplayButtonState.None),
        rawFrame(1_300, target.position, ReplayButtonState.None),
      ],
      beatmap([blocker, target]),
      stableOptions,
    ).gameStateAt(1e9);

    expect(state.hitCircleVerdict[target.id]).toMatchObject({ type: "MISS", missReason: "TIME_EXPIRED" });
    expect(state.stableNotelockEvidence[target.id]).toBeUndefined();
  });

  it("does not treat Stable physical mask changes as native Lazer presses", () => {
    const target = circle("target", 1_000, { x: 300, y: 100 });
    const state = new LazerGameStateTimeMachine(
      [
        rawFrame(900, { x: 0, y: 0 }, ReplayButtonState.Left1),
        rawFrame(1_000, target.position, ReplayButtonState.Left1 | ReplayButtonState.Left2),
        rawFrame(1_200, target.position, ReplayButtonState.None),
      ],
      beatmap([target]),
    ).gameStateAt(1e9);

    expect(state.hitCircleVerdict[target.id]).toMatchObject({ type: "MISS", missReason: "TIME_EXPIRED" });
  });
});
