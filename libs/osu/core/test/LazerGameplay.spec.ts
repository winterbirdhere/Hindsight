import { hitWindowsForOD } from "@osujs/math";
import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { LazerGameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { isNotelockMiss, retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { cloneGameState, NOT_PRESSING } from "../src/gameplay/GameState";
import { nativeLazerSpinnerVerdict } from "../src/gameplay/LazerGameStateEvaluator";
import { expandLazerReplayFrames, LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { SliderCheckPoint } from "../src/hitobjects/SliderCheckPoint";
import { Spinner } from "../src/hitobjects/Spinner";
import { generateSliderCheckpoints } from "../src/hitobjects/slider/SliderCheckPointGenerator";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";
import { PathType } from "../src/hitobjects/slider/PathType";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const difficulty = { ...DEFAULT_BEATMAP_DIFFICULTY, overallDifficulty: 5 };

function circle(id: string, time: number, position = { x: 256, y: 192 }): HitCircle {
  const result = new HitCircle();
  result.id = id;
  result.hitTime = time;
  result.approachDuration = 600;
  result.position = position;
  result.unstackedPosition = position;
  return result;
}

function beatmap(objects: Beatmap["hitObjects"]): Beatmap {
  return new Beatmap([...objects], difficulty, [], new ControlPointInfo());
}

function frame(time: number, position: { x: number; y: number }, pressed = false): ReplayFrame {
  return { time, position, actions: pressed ? [OsuAction.leftButton] : [] };
}

function sliderFixture(withTick = false): { slider: Slider; tick?: SliderCheckPoint } {
  const head = circle("slider/HEAD", 1_000, { x: 100, y: 192 });
  head.sliderId = "slider";
  const slider = new Slider(head);
  slider.id = "slider";
  slider.velocity = 0.1;
  slider.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }], 100);
  if (!withTick) return { slider };

  const tick = new SliderCheckPoint(slider);
  tick.id = "slider/TICK";
  tick.type = "TICK";
  tick.hitTime = 1_500;
  tick.spanProgress = 0.5;
  tick.offset = { x: 50, y: 0 };
  slider.checkPoints = [tick];
  return { slider, tick };
}

function shortSliderWithEarlyTick(): { slider: Slider; tick: SliderCheckPoint } {
  const { slider, tick } = sliderFixture(true);
  if (!tick) throw new Error("Expected slider tick fixture");
  slider.velocity = 1.25;
  tick.hitTime = 1_050;
  tick.spanProgress = 0.625;
  tick.offset = { x: 62.5, y: 0 };
  return { slider, tick };
}

describe("native lazer replay boundary", () => {
  it("resolves overdue objects but leaves objects after an early replay end unjudged", () => {
    const overdue = circle("overdue", 1_000);
    const afterFailure = circle("after-failure", 1_500);
    const state = new LazerGameStateTimeMachine(
      [frame(1_300, overdue.position)],
      beatmap([overdue, afterFailure]),
    ).gameStateAt(1e9);

    expect(state.currentTime).toBe(1_300);
    expect(state.hitCircleVerdict[overdue.id]).toMatchObject({
      type: "MISS",
      missReason: "TIME_EXPIRED",
    });
    expect(state.hitCircleVerdict[afterFailure.id]).toBeUndefined();
    expect(state.lazerJudgements.map((judgement) => judgement.hitObjectId)).toEqual([overdue.id]);
    expect(new LazerGameplayInfoEvaluator().evaluateReplayState(state).verdictCounts).toEqual([0, 0, 0, 1]);
  });
});

describe("native lazer circles and input ordering", () => {
  it("uses current native OD5 windows", () => {
    expect(hitWindowsForOD(5, true)).toEqual([49.5, 99.5, 149.5, 400]);
  });

  it("records a shake when ordered processing blocks a hovered later receptor", () => {
    const blocker = circle("blocker", 1_000, { x: 100, y: 100 });
    const later = circle("later", 1_100, { x: 300, y: 200 });
    const state = new LazerGameStateTimeMachine(
      [frame(900, later.position, true)],
      beatmap([blocker, later]),
    ).gameStateAt(900);

    expect(state.hitCircleVerdict[blocker.id]).toBeUndefined();
    expect(state.hitCircleVerdict[later.id]).toBeUndefined();
    expect(state.lastNotelockShakeTime[later.id]).toBe(900);
    expect(state.lazerNotelockEvidence[later.id]).toBeUndefined();
  });

  it("records notelock evidence on the blocked later target only when the press could have hit", () => {
    const blocker = circle("blocker", 1_000, { x: 100, y: 100 });
    const later = circle("later", 1_100, { x: 300, y: 200 });
    const machine = new LazerGameStateTimeMachine(
      [
        frame(900, later.position, true),
        frame(901, later.position),
        frame(980, later.position, true),
        frame(981, later.position),
        frame(1_300, later.position),
      ],
      beatmap([blocker, later]),
    );

    const tooEarly = machine.gameStateAt(900);
    expect(tooEarly.lastNotelockShakeTime[later.id]).toBe(900);
    expect(tooEarly.lazerNotelockEvidence[later.id]).toBeUndefined();

    const blocked = machine.gameStateAt(980);
    expect(blocked.lazerNotelockEvidence[later.id]).toMatchObject({
      targetHitObjectId: later.id,
      blockerHitObjectId: blocker.id,
      pressTime: 980,
      wouldHaveHit: "MEH",
    });
    const cloned = cloneGameState(blocked);
    cloned.lazerNotelockEvidence[later.id].pressTime = -1;
    expect(blocked.lazerNotelockEvidence[later.id].pressTime).toBe(980);

    const completed = machine.gameStateAt(1_300);
    expect(completed.hitCircleVerdict[later.id]).toMatchObject({
      type: "MISS",
      missReason: "TIME_EXPIRED",
    });
    expect(retrieveEvents(completed, [blocker, later], "lazer").filter(isNotelockMiss)).toEqual([
      expect.objectContaining({
        hitObjectId: later.id,
        notelockCause: expect.objectContaining({
          kind: "LAZER_BLOCKED_VALID_PRESS",
          blockerHitObjectId: blocker.id,
          pressTime: 980,
        }),
      }),
    ]);
  });

  it("accepts the later receptor at the blocker start and clears earlier blocked-press evidence", () => {
    const blocker = circle("blocker", 1_000, { x: 100, y: 100 });
    const later = circle("later", 1_100, { x: 300, y: 200 });
    const state = new LazerGameStateTimeMachine(
      [frame(980, later.position, true), frame(981, later.position), frame(1_000, later.position, true)],
      beatmap([blocker, later]),
    ).gameStateAt(1_000);

    expect(state.hitCircleVerdict[blocker.id]).toMatchObject({
      type: "MISS",
      missReason: "ORDERED_POLICY_FORCE_MISS",
    });
    expect(state.hitCircleVerdict[later.id].type).toBe("MEH");
    expect(state.lazerNotelockEvidence[later.id]).toBeUndefined();
    expect(retrieveEvents(state, [blocker, later], "lazer").filter(isNotelockMiss)).toEqual([]);
  });

  it("keeps the exact Meh boundary hittable and expires immediately beyond it", () => {
    const target = circle("target", 1_000);
    const exact = new LazerGameStateTimeMachine([frame(1_149.5, target.position, true)], beatmap([target])).gameStateAt(
      1e9,
    );
    expect(exact.hitCircleVerdict[target.id].type).toBe("MEH");

    const expiredTarget = circle("expired", 1_000);
    const expired = new LazerGameStateTimeMachine(
      [frame(1_149.75, expiredTarget.position), frame(1_149.8, expiredTarget.position, true)],
      beatmap([expiredTarget]),
    ).gameStateAt(1e9);
    expect(expired.hitCircleVerdict[expiredTarget.id]).toMatchObject({
      type: "MISS",
      missReason: "TIME_EXPIRED",
    });
  });

  it("resolves a later circle and force-misses all strictly earlier blockers", () => {
    const earlier = circle("earlier", 1_000, { x: 100, y: 100 });
    const later = circle("later", 1_100, { x: 300, y: 200 });
    const state = new LazerGameStateTimeMachine(
      [frame(1_100, later.position, true)],
      beatmap([earlier, later]),
    ).gameStateAt(1e9);

    expect(state.hitCircleVerdict[later.id].type).toBe("GREAT");
    expect(state.hitCircleVerdict[earlier.id]).toMatchObject({
      type: "MISS",
      missReason: "ORDERED_POLICY_FORCE_MISS",
      judgementTime: 1_100,
    });
    expect(state.lazerJudgements.map((judgement) => judgement.hitObjectId)).toEqual([earlier.id, later.id]);
    expect(retrieveEvents(state, [earlier, later], "lazer").filter(isNotelockMiss)).toEqual([]);
  });

  it("applies an ordered-policy miss before the later same-frame hit updates max combo", () => {
    const first = circle("first", 100, { x: 50, y: 50 });
    const second = circle("second", 200, { x: 100, y: 50 });
    const blocker = circle("blocker", 1_000, { x: 150, y: 50 });
    const later = circle("later", 1_084, { x: 300, y: 200 });
    const state = new LazerGameStateTimeMachine(
      [
        frame(100, first.position, true),
        frame(101, first.position),
        frame(200, second.position, true),
        frame(201, second.position),
        frame(1_004, later.position, true),
      ],
      beatmap([first, second, blocker, later]),
    ).gameStateAt(1_004);

    expect(state.lazerJudgements.slice(-2).map((judgement) => judgement.result)).toEqual(["MISS", "OK"]);
    expect(new LazerGameplayInfoEvaluator().evaluateReplayState(state)).toMatchObject({
      currentCombo: 1,
      maxComboSoFar: 2,
    });
  });

  it("uses reverse creation order for equal-start overlapping receptors", () => {
    const first = circle("9", 1_000);
    const second = circle("10", 1_000);
    const state = new LazerGameStateTimeMachine(
      [frame(1_000, first.position, true)],
      beatmap([first, second]),
    ).gameStateAt(1_000);
    expect(state.hitCircleVerdict[second.id]?.type).toBe("GREAT");
    expect(state.hitCircleVerdict[first.id]).toBeUndefined();
  });

  it("walks simultaneous policy blockers in forward insertion order after reverse receptor dispatch", () => {
    const first = circle("first", 1_000, { x: 100, y: 100 });
    const second = circle("second", 1_000, first.position);
    const future = circle("future", 1_040, { x: 300, y: 200 });
    const state = new LazerGameStateTimeMachine(
      [frame(851, second.position, true), frame(875, second.position), frame(900, future.position, true)],
      beatmap([first, second, future]),
    ).gameStateAt(900);

    expect(state.hitCircleVerdict[second.id]).toMatchObject({ type: "MEH", judgementTime: 851 });
    expect(state.hitCircleVerdict[future.id]).toMatchObject({ type: "MEH", judgementTime: 900 });
    expect(state.hitCircleVerdict[first.id]).toMatchObject({
      type: "MISS",
      missReason: "ORDERED_POLICY_FORCE_MISS",
      judgementTime: 900,
    });
  });

  it("checks the latest policy blocker even when another same-start blocker remains unjudged", () => {
    const sameStartUnjudged = circle("first-created", 1_000, { x: 100, y: 100 });
    const policyLatest = circle("second-created", 1_000, { x: 200, y: 100 });
    const later = circle("later", 1_100, { x: 300, y: 100 });
    const state = new LazerGameStateTimeMachine(
      [
        frame(900, policyLatest.position, true),
        frame(901, policyLatest.position, false),
        frame(950, later.position, true),
      ],
      beatmap([sameStartUnjudged, policyLatest, later]),
    ).gameStateAt(950);

    expect(state.hitCircleVerdict[policyLatest.id]?.type).toBe("MEH");
    expect(state.hitCircleVerdict[later.id]).toMatchObject({
      type: "MISS",
      missReason: "INPUT_WINDOW_MISS",
      judgementTime: 950,
    });
    expect(state.hitCircleVerdict[sameStartUnjudged.id]).toMatchObject({
      type: "MISS",
      missReason: "ORDERED_POLICY_FORCE_MISS",
      judgementTime: 950,
    });
  });

  it.each(["grouped", "raw"])("retains ordered zero-delta presses and final release (%s)", (form) => {
    const target = circle("target", 1_000);
    const sources = [frame(1_000, target.position, true), frame(1_000, target.position, false)];
    const merged: ReplayFrame = {
      ...sources[0],
      sourceFramesAtSameTime: sources,
    };
    expect(expandLazerReplayFrames([merged])).toEqual(sources);

    const state = new LazerGameStateTimeMachine(form === "raw" ? sources : [merged], beatmap([target])).gameStateAt(
      1_000,
    );
    expect(state.hitCircleVerdict[target.id]?.type).toBe("GREAT");
    expect(state.pressingSince).toEqual([NOT_PRESSING, NOT_PRESSING]);
  });
});

describe("native lazer sliders", () => {
  it("keeps blocked-valid-press evidence on the canonical slider-head miss", () => {
    const blocker = circle("blocker", 900, { x: 300, y: 100 });
    const { slider } = sliderFixture();
    const completed = new LazerGameStateTimeMachine(
      [frame(870, slider.head.position, true), frame(871, slider.head.position), frame(1_200, slider.head.position)],
      beatmap([blocker, slider]),
    ).gameStateAt(1_200);

    expect(completed.hitCircleVerdict[slider.head.id]).toMatchObject({
      type: "MISS",
      missReason: "TIME_EXPIRED",
    });
    expect(retrieveEvents(completed, [blocker, slider], "lazer").filter(isNotelockMiss)).toEqual([
      expect.objectContaining({
        hitObjectId: slider.head.id,
        isSliderHead: true,
        notelockCause: expect.objectContaining({
          kind: "LAZER_BLOCKED_VALID_PRESS",
          blockerHitObjectId: blocker.id,
          targetHitObjectId: slider.head.id,
        }),
      }),
    ]);
  });

  it("uses a fresh press state before resolving overdue components from a force-missed head", () => {
    const { slider, tick } = shortSliderWithEarlyTick();
    const laterPosition = slider.ballPositionAt((1_060 - slider.startTime) / slider.duration);
    const later = circle("later", 1_100, laterPosition);
    const state = new LazerGameStateTimeMachine(
      [
        frame(1_040, slider.ballPositionAt((1_040 - slider.startTime) / slider.duration)),
        frame(1_060, later.position, true),
      ],
      beatmap([slider, later]),
    ).gameStateAt(1_060);

    expect(state.hitCircleVerdict[later.id]).toMatchObject({ type: "GREAT", judgementTime: 1_060 });
    expect(state.hitCircleVerdict[slider.head.id]).toMatchObject({
      type: "MISS",
      missReason: "ORDERED_POLICY_FORCE_MISS",
      judgementTime: 1_060,
    });
    expect(state.checkPointVerdict[tick.id]).toMatchObject({ hit: true, judgementTime: 1_060 });
  });

  it("retains successful late-head catch-up while generic slider processing is deferred", () => {
    const { slider, tick } = shortSliderWithEarlyTick();
    const state = new LazerGameStateTimeMachine(
      [frame(1_060, slider.startPosition, true)],
      beatmap([slider]),
    ).gameStateAt(1_060);

    expect(state.hitCircleVerdict[slider.head.id]).toMatchObject({ type: "OK", judgementTime: 1_060 });
    expect(state.checkPointVerdict[tick.id]).toMatchObject({ hit: true, judgementTime: 1_060 });
  });

  it("allows tail reacquisition throughout the 36ms leniency window", () => {
    const { slider } = sliderFixture();
    const frames = [
      frame(1_000, slider.startPosition, true),
      frame(1_963, slider.endPosition, true),
      frame(1_964, slider.endPosition, false),
      frame(1_980, slider.endPosition, true),
    ];
    const state = new LazerGameStateTimeMachine(frames, beatmap([slider])).gameStateAt(1e9);
    expect(state.sliderTailVerdict[slider.id]).toMatchObject({ hit: true, judgementTime: 1_980 });
  });

  it("counts a missed actual tail in accuracy without breaking combo", () => {
    const { slider } = sliderFixture();
    const state = new LazerGameStateTimeMachine(
      [
        frame(1_000, slider.startPosition, true),
        frame(1_100, slider.startPosition, false),
        frame(slider.endTime, slider.endPosition, false),
      ],
      beatmap([slider]),
    ).gameStateAt(1e9);
    const info = new LazerGameplayInfoEvaluator().evaluateReplayState(state);

    expect(state.sliderTailVerdict[slider.id].hit).toBe(false);
    expect(state.lazerJudgements.map((judgement) => judgement.result)).toEqual(["GREAT", "IGNORE_MISS"]);
    expect(info.currentCombo).toBe(1);
    expect(info.maxComboSoFar).toBe(1);
    expect(info.accuracy).toBeCloseTo(300 / 450);
  });

  it("preserves the preceding key state when both actions hit the head", () => {
    const { slider } = sliderFixture();
    const state = new LazerGameStateTimeMachine(
      [
        {
          time: 1_000,
          position: slider.startPosition,
          actions: [OsuAction.leftButton, OsuAction.rightButton],
        },
        {
          time: 1_010,
          position: slider.ballPositionAt(0.01),
          actions: [OsuAction.rightButton],
        },
      ],
      beatmap([slider]),
    ).gameStateAt(1_010);
    expect(state.sliderBodyState.get(slider.id)?.isTracking).toBe(true);
  });

  it("resets combo on a missed tick and then increments for a hit tail", () => {
    const { slider } = sliderFixture(true);
    const state = new LazerGameStateTimeMachine(
      [
        frame(1_000, slider.startPosition, true),
        frame(1_100, slider.startPosition, false),
        frame(1_980, slider.endPosition, true),
      ],
      beatmap([slider]),
    ).gameStateAt(1e9);
    const info = new LazerGameplayInfoEvaluator().evaluateReplayState(state);

    expect(state.lazerJudgements.map((judgement) => judgement.result)).toEqual([
      "GREAT",
      "LARGE_TICK_MISS",
      "SLIDER_TAIL_HIT",
    ]);
    expect(info.currentCombo).toBe(1);
    expect(info.maxComboSoFar).toBe(1);
    expect(info.accuracy).toBeCloseTo(450 / 480);
  });

  it("generates repeats independently from ticks and defaults the legacy last tick to 36ms early", () => {
    const repeated = [...generateSliderCheckpoints(0, 100, 1, 0, 100, 2)];
    expect(repeated.map((checkpoint) => checkpoint.type)).toEqual(["REPEAT", "LAST_LEGACY_TICK"]);
    const single = [...generateSliderCheckpoints(0, 100, 1, 0, 100, 1)];
    expect(single[0]).toMatchObject({ type: "LAST_LEGACY_TICK", time: 64 });
  });

  it.each(["grouped", "raw"])("uses the final zero-delta input state for time-driven ticks (%s)", (form) => {
    const run = (sourcePressedStates: boolean[]) => {
      const { slider, tick } = sliderFixture(true);
      if (!tick) throw new Error("Expected slider tick fixture");
      const sources = sourcePressedStates.map((pressed) => frame(1_500, tick.position, pressed));
      const merged: ReplayFrame = { ...sources[sources.length - 1], sourceFramesAtSameTime: sources };
      const state = new LazerGameStateTimeMachine(
        [
          frame(1_000, slider.startPosition, true),
          frame(1_100, slider.startPosition, false),
          ...(form === "raw" ? sources : [merged]),
        ],
        beatmap([slider]),
      ).gameStateAt(1_500);
      return state.checkPointVerdict[tick.id]?.hit;
    };

    expect(run([true, false])).toBe(false);
    expect(run([false, true])).toBe(true);
  });

  it.each(["grouped", "raw"])(
    "preserves follow-circle hysteresis across a zero-delta release and re-press (%s)",
    (form) => {
      const { slider, tick } = sliderFixture(true);
      if (!tick) throw new Error("Expected slider tick fixture");
      const outsideBaseInsideExpanded = { x: 230, y: 192 };
      const sources: ReplayFrame[] = [
        frame(1_500, outsideBaseInsideExpanded, false),
        frame(1_500, outsideBaseInsideExpanded, true),
      ];
      const merged: ReplayFrame = { ...sources[1], sourceFramesAtSameTime: sources };
      const state = new LazerGameStateTimeMachine(
        [
          frame(1_000, slider.startPosition, true),
          frame(1_490, outsideBaseInsideExpanded, true),
          ...(form === "raw" ? sources : [merged]),
        ],
        beatmap([slider]),
      ).gameStateAt(1_500);

      expect(state.checkPointVerdict[tick.id]?.hit).toBe(true);
    },
  );
});

describe("native lazer spinners", () => {
  it.each([
    [0, 4, 6],
    [5, 7, 10],
    [10, 11, 8],
  ])("computes 3-second OD%s requirements", (od, required, bonus) => {
    const spinner = new Spinner();
    spinner.duration = 3_000;
    spinner.applyLazerDefaults(od);
    expect(spinner.spinsRequired).toBe(required);
    expect(spinner.maximumBonusSpins).toBe(bonus);
  });

  it("uses strict 90% and 75% result thresholds", () => {
    expect(nativeLazerSpinnerVerdict(1)).toBe("GREAT");
    expect(nativeLazerSpinnerVerdict(0.900001)).toBe("OK");
    expect(nativeLazerSpinnerVerdict(0.9)).toBe("MEH");
    expect(nativeLazerSpinnerVerdict(0.750001)).toBe("MEH");
    expect(nativeLazerSpinnerVerdict(0.75)).toBe("MISS");
  });

  it("implicitly clears a zero-required short spinner", () => {
    const spinner = new Spinner();
    spinner.id = "spinner";
    spinner.startTime = 1_000;
    spinner.duration = 100;
    spinner.applyLazerDefaults(5);
    const state = new LazerGameStateTimeMachine(
      [frame(spinner.endTime, { x: 256, y: 192 })],
      beatmap([spinner]),
    ).gameStateAt(1e9);
    expect(spinner.spinsRequired).toBe(0);
    expect(state.spinnerVerdict[spinner.id].type).toBe("GREAT");
  });

  it("preserves +180 degrees and requires reversals to unwind partial progress", () => {
    const spinner = new Spinner();
    spinner.id = "spinner";
    spinner.startTime = 1_000;
    spinner.duration = 2_000;
    spinner.spinsRequired = 10;
    const top = { x: 256, y: 92 };
    const bottom = { x: 256, y: 292 };
    const left = { x: 156, y: 192 };
    const right = { x: 356, y: 192 };

    const plus180 = new LazerGameStateTimeMachine(
      [frame(1_000, top, true), frame(1_100, bottom, true), frame(1_200, left, true)],
      beatmap([spinner]),
    ).gameStateAt(1_200);
    expect(plus180.spinnerState.get(spinner.id)?.totalSpunAngle).toBe(270);

    const reversingSpinner = new Spinner();
    Object.assign(reversingSpinner, spinner, { id: "reversing" });
    const reversal = new LazerGameStateTimeMachine(
      [
        frame(1_000, bottom, true),
        frame(1_100, left, true),
        frame(1_200, bottom, true),
        frame(1_300, right, true),
        frame(1_400, top, true),
      ],
      beatmap([reversingSpinner]),
    ).gameStateAt(1_400);
    expect(reversal.spinnerState.get(reversingSpinner.id)?.totalSpunAngle).toBe(180);
  });

  it.each(["grouped", "raw"])("retains held rotation before a same-time release (%s)", (form) => {
    const spinner = new Spinner();
    spinner.id = "spinner";
    spinner.startTime = 1_000;
    spinner.duration = 2_000;
    spinner.spinsRequired = 10;
    const top = { x: 256, y: 92 };
    const right = { x: 356, y: 192 };
    const sources = [frame(1_100, right, true), frame(1_100, right, false)];
    const merged: ReplayFrame = {
      ...sources[0],
      sourceFramesAtSameTime: sources,
    };

    const state = new LazerGameStateTimeMachine(
      [frame(1_000, top, true), ...(form === "raw" ? sources : [merged])],
      beatmap([spinner]),
    ).gameStateAt(1_100);

    expect(state.spinnerState.get(spinner.id)?.totalSpunAngle).toBe(90);
    expect(state.spinnerState.get(spinner.id)?.tracking).toBe(false);
  });
});
