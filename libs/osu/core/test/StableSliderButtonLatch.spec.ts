import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { cloneGameState } from "../src/gameplay/GameState";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { SliderCheckPoint } from "../src/hitobjects/SliderCheckPoint";
import { PathType } from "../src/hitobjects/slider/PathType";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const options = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;
const left = OsuAction.leftButton;
const right = OsuAction.rightButton;

function map(includePrecedingCircle = false): Beatmap {
  const head = new HitCircle();
  Object.assign(head, {
    id: "s/HEAD",
    sliderId: "s",
    hitTime: 1_000,
    approachDuration: 600,
    position: { x: 100, y: 192 },
    unstackedPosition: { x: 100, y: 192 },
  });
  const slider = new Slider(head);
  slider.id = "s";
  slider.velocity = 0.1;
  slider.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 50, y: 0 } }], 50);
  const tail = new SliderCheckPoint(slider);
  Object.assign(tail, { id: "s/0", type: "LAST_LEGACY_TICK", hitTime: 1_464, offset: { x: 46.4, y: 0 } });
  slider.checkPoints = [tail];
  const preceding = new HitCircle();
  Object.assign(preceding, {
    id: "preceding",
    hitTime: 900,
    approachDuration: 600,
    position: { x: 100, y: 192 },
    unstackedPosition: { x: 100, y: 192 },
  });
  return new Beatmap(
    includePrecedingCircle ? [preceding, slider] : [slider],
    DEFAULT_BEATMAP_DIFFICULTY,
    [],
    new ControlPointInfo(),
  );
}

function frame(time: number, actions: OsuAction[], aimed = true): ReplayFrame {
  return {
    time,
    actions,
    position: aimed ? { x: 100 + Math.max(0, Math.min(500, time - 1_000)) * 0.1, y: 192 } : { x: 450, y: 350 },
  };
}

describe("Stable slider button latch", () => {
  it.each([
    [left, false],
    [right, false],
    [left, true],
    [right, true],
  ] as const)(
    "distinguishes an observed start update from a frame gap for side %s (preceding circle: %s)",
    (heldSide, includePrecedingCircle) => {
      const nextSide = heldSide === left ? right : left;
      const observed = [
        frame(900, [heldSide], includePrecedingCircle),
        frame(1_002, [heldSide, nextSide], false),
        frame(1_010, [heldSide, nextSide]),
        frame(1_020, [heldSide]),
        frame(1_200, [heldSide]),
        frame(1_464, [heldSide]),
        frame(1_500, [heldSide]),
      ];
      // A latch-only update need not be recorded (scorer602–604, Player4553–4565).
      // Both actual histories are possible: the recorded frame gap does not prove
      // the omitted start update occurred. Do not invent its key ownership.
      const full = new BucketedGameStateTimeMachine(
        [observed[0], frame(1_000, [heldSide], false), ...observed.slice(1)],
        map(includePrecedingCircle),
        options,
        1,
      );
      const thinned = new BucketedGameStateTimeMachine(observed, map(includePrecedingCircle), options, 1);
      if (includePrecedingCircle) {
        expect(thinned.gameStateAt(900).hitCircleVerdict.preceding.type).toBe("GREAT");
        expect(thinned.gameStateAt(900).hitCircleVerdict["s/HEAD"]).toBeUndefined();
      }
      expect(thinned.gameStateAt(1_002).sliderBodyState.get("s")).toMatchObject({ isTracking: false });
      expect(thinned.gameStateAt(1_002).sliderBodyState.get("s")?.trackingSince).toBeUndefined();
      const fork = thinned.fork();
      expect(full.gameStateAt(Infinity).checkPointVerdict["s/0"].hit).toBe(true);
      const expected = cloneGameState(thinned.gameStateAt(Infinity));
      expect(expected.checkPointVerdict["s/0"].hit).toBe(false);
      thinned.gameStateAt(900);
      expect(thinned.gameStateAt(Infinity)).toEqual(expected);
      expect(fork.gameStateAt(Infinity)).toEqual(expected);
    },
  );

  // Slider 1781–1785 latches the fresh side before the head result is known.
  // At 2020–2038, L -> LR -> L cannot reuse L while the slider is latched to R.
  it.each([
    [left, 1_000],
    [right, 1_000],
    [left, 1_001],
    [right, 1_001],
  ] as const)(
    "does not reuse old side %s after the failed head's new side is released (start sample: %s)",
    (oldSide, startSample) => {
      const headSide = oldSide === left ? right : left;
      const machine = new BucketedGameStateTimeMachine(
        [
          frame(700, [oldSide], false),
          frame(800, [oldSide, headSide]),
          frame(900, [oldSide]),
          frame(startSample, [oldSide]),
          frame(1_200, [oldSide]),
          frame(1_464, [oldSide]),
          frame(1_500, [oldSide]),
        ],
        map(),
        options,
        1,
      );
      const beforeStart = cloneGameState(machine.gameStateAt(900));
      expect(beforeStart.hitCircleVerdict["s/HEAD"]).toMatchObject({ type: "MISS", missReason: "HIT_TOO_EARLY" });
      const fork = machine.fork();
      const final = cloneGameState(machine.gameStateAt(Infinity));
      expect(final.checkPointVerdict["s/0"].hit).toBe(false);
      expect(final.sliderVerdict.s).toBe("MISS");
      machine.gameStateAt(700);
      expect(machine.gameStateAt(900)).toEqual(beforeStart);
      expect(machine.gameStateAt(Infinity)).toEqual(final);
      expect(fork.gameStateAt(Infinity)).toEqual(final);
    },
  );

  it.each([500, 600, 601])("latches only a scorer-permitted head callback at time %s", (pressTime) => {
    const timeline = new BucketedGameStateTimeMachine(
      [
        frame(450, [left], false),
        frame(pressTime, [left, right]),
        frame(800, [left]),
        frame(1_000, [left]),
        frame(1_200, [left]),
        frame(1_464, [left]),
        frame(1_500, [left]),
      ],
      map(),
      options,
      1,
    );
    // The scorer rejects abs(delta)>=400 before invoking the slider method.
    // Once permitted, that method latches the fresh side even if the head misses.
    const allowed = pressTime === 601;
    const pressed = cloneGameState(timeline.gameStateAt(pressTime));
    expect(pressed.sliderBodyState.get("s")?.stableButtonLatch).toBe(allowed ? 2 : undefined);
    expect(pressed.hitCircleVerdict["s/HEAD"]?.type).toBe(allowed ? "MISS" : undefined);
    const fork = timeline.fork();
    const final = cloneGameState(timeline.gameStateAt(Infinity));
    expect(final.hitCircleVerdict["s/HEAD"]).toMatchObject({
      type: "MISS",
      missReason: allowed ? "HIT_TOO_EARLY" : "TIME_EXPIRED",
    });
    expect(final.checkPointVerdict["s/0"].hit).toBe(!allowed);
    expect(final.sliderVerdict.s).toBe(allowed ? "MISS" : "OK");
    timeline.gameStateAt(450);
    expect(timeline.gameStateAt(Infinity)).toEqual(final);
    expect(fork.gameStateAt(Infinity)).toEqual(final);
  });

  it("does not pass a scorer-rejected earlier circle press to the next slider head", () => {
    const state = new BucketedGameStateTimeMachine(
      [frame(400, [left], false), frame(500, [left, right])],
      map(true),
      options,
    ).gameStateAt(500);
    expect(state.hitCircleVerdict).toEqual({});
    expect(state.sliderBodyState.has("s")).toBe(false);
  });

  it.each([1_399, 1_400])(
    "does not replace an existing body latch with a late ineligible head press at %s",
    (pressTime) => {
      const timeline = new BucketedGameStateTimeMachine(
        [
          frame(900, [left], false),
          frame(1_000, [left], false),
          frame(pressTime, [left, right]),
          frame(1_410, [left]),
          frame(1_464, [left]),
          frame(1_500, [left]),
        ],
        map(),
        options,
      );
      expect(timeline.gameStateAt(1_000).sliderBodyState.get("s")?.stableButtonLatch).toBe(1);
      const late = timeline.gameStateAt(pressTime);
      // Both samples are beyond the head's nominal 50 window. The source target
      // selector excludes it before the separate +/-400 scorer gate is reached.
      expect(late.sliderBodyState.get("s")?.stableButtonLatch).toBe(1);
      expect(late.hitCircleVerdict["s/HEAD"]).toMatchObject({ type: "MISS", missReason: "TIME_EXPIRED" });
      expect(timeline.gameStateAt(Infinity).checkPointVerdict["s/0"].hit).toBe(true);
    },
  );

  it("recovers when the old side is released and pressed again", () => {
    const state = new BucketedGameStateTimeMachine(
      [
        frame(700, [left], false),
        frame(800, [left, right]),
        frame(900, [left]),
        frame(1_000, [left]),
        frame(1_100, []),
        frame(1_200, [left]),
        frame(1_464, [left]),
        frame(1_500, [left]),
      ],
      map(),
      options,
    ).gameStateAt(Infinity);
    expect(state.checkPointVerdict["s/0"].hit).toBe(true);
    expect(state.sliderVerdict.s).toBe("OK");
  });

  it.each([left, right])("retains successful-head behavior when old side %s outlasts the head side", (oldSide) => {
    const headSide = oldSide === left ? right : left;
    const state = new BucketedGameStateTimeMachine(
      [
        frame(900, [oldSide], false),
        frame(1_000, [oldSide, headSide]),
        frame(1_010, [oldSide]),
        frame(1_200, [oldSide]),
        frame(1_464, [oldSide]),
        frame(1_500, [oldSide]),
      ],
      map(),
      options,
    ).gameStateAt(Infinity);
    expect(state.hitCircleVerdict["s/HEAD"].type).toBe("GREAT");
    expect(state.checkPointVerdict["s/0"].hit).toBe(false);
  });

  it.each([left, right])("accepts remaining side %s after both sides were newly pressed together", (remaining) => {
    const state = new BucketedGameStateTimeMachine(
      [
        frame(700, [], false),
        frame(800, [left, right]),
        frame(900, [remaining]),
        frame(1_000, [remaining]),
        frame(1_200, [remaining]),
        frame(1_464, [remaining]),
        frame(1_500, [remaining]),
      ],
      map(),
      options,
    ).gameStateAt(Infinity);
    expect(state.checkPointVerdict["s/0"].hit).toBe(true);
  });

  it("does not latch a failed press outside the head's radius", () => {
    const state = new BucketedGameStateTimeMachine(
      [
        frame(700, [left], false),
        frame(800, [left, right], false),
        frame(900, [left], false),
        frame(1_000, [left]),
        frame(1_200, [left]),
        frame(1_464, [left]),
        frame(1_500, [left]),
      ],
      map(),
      options,
    ).gameStateAt(Infinity);
    expect(state.checkPointVerdict["s/0"].hit).toBe(true);
  });
});
