import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { GameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { SliderCheckPoint } from "../src/hitobjects/SliderCheckPoint";
import { PathType } from "../src/hitobjects/slider/PathType";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";
import { SliderCheckPointType } from "../src/hitobjects/Types";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const stableOptions = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;

function checkpoint(
  slider: Slider,
  id: string,
  type: SliderCheckPointType,
  hitTime: number,
  offsetX: number,
): SliderCheckPoint {
  const result = new SliderCheckPoint(slider);
  result.id = id;
  result.type = type;
  result.hitTime = hitTime;
  result.offset = { x: offsetX, y: 0 };
  return result;
}

function frame(time: number, position: { x: number; y: number }): ReplayFrame {
  return { time, position, actions: [OsuAction.leftButton] };
}

describe("Stable slider evaluator event chain", () => {
  it.each([false, true])(
    "acquires an early-hit slider only on observed updates (exact start frame: %s)",
    (exactFrame) => {
      const head = new HitCircle();
      head.id = "early/HEAD";
      head.hitTime = 1_000;
      head.approachDuration = 600;
      head.position = { x: 100, y: 100 };
      head.unstackedPosition = head.position;
      head.scale = 0.5;
      head.sliderId = "early";
      const slider = new Slider(head);
      slider.id = "early";
      slider.velocity = 1;
      slider.path = new SliderPath(
        [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 75, y: 0 } }],
        75,
      );
      const tail = checkpoint(slider, "early/0", "LAST_LEGACY_TICK", 1_039, 39);
      slider.checkPoints = [tail];
      const map = new Beatmap([slider], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
      const machine = new BucketedGameStateTimeMachine(
        [
          { time: 900, position: head.position, actions: [] },
          frame(992, { x: 68.1, y: 100 }),
          ...(exactFrame ? [frame(1_000, { x: 68.1, y: 100 })] : []),
          frame(1_005, { x: 72.5, y: 100 }),
          frame(1_039, { x: 89, y: 100 }),
          frame(slider.endTime, slider.endPosition),
        ],
        map,
        stableOptions,
        1,
      );
      // The cursor is just outside the normal acquisition radius at 1005. Only
      // an observed start can have established the expanded follow radius first.
      expect(machine.gameStateAt(1_005).sliderBodyState.get(slider.id)?.isTracking).toBe(exactFrame);
      const finalState = machine.gameStateAt(slider.endTime);

      expect(finalState.hitCircleVerdict[head.id]).toMatchObject({ type: "GREAT", judgementTime: 992 });
      expect(finalState.checkPointVerdict[tail.id].hit).toBe(exactFrame);
      expect(new GameplayInfoEvaluator(map).evaluateReplayState(finalState)).toMatchObject({
        verdictCounts: exactFrame ? [1, 0, 0, 0] : [0, 1, 0, 0],
        maxComboSoFar: exactFrame ? 2 : 1,
      });
      machine.gameStateAt(900);
      expect(machine.gameStateAt(slider.endTime).checkPointVerdict[tail.id].hit).toBe(exactFrame);
    },
  );

  it.each([false, true])(
    "counts another break only after combo recovers (recapture: %s), including seeking",
    (recapture) => {
      const head = new HitCircle();
      head.id = "slider/HEAD";
      head.hitTime = 1_000;
      head.approachDuration = 600;
      head.position = { x: 100, y: 192 };
      head.unstackedPosition = head.position;
      head.sliderId = "slider";
      const slider = new Slider(head);
      slider.id = "slider";
      slider.repeatCount = 1;
      slider.velocity = 0.5;
      slider.path = new SliderPath(
        [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 250, y: 0 } }],
        250,
      );
      const firstMiss = checkpoint(slider, "slider/0", "TICK", 1_100, 50);
      const repeatedMiss = checkpoint(slider, "slider/1", "TICK", 1_200, 100);
      const repeat = checkpoint(slider, "slider/2", "REPEAT", 1_500, 250);
      const nextMiss = checkpoint(slider, "slider/3", "TICK", 1_600, 200);
      const anotherMiss = checkpoint(slider, "slider/4", "TICK", 1_700, 150);
      const tail = checkpoint(slider, "slider/5", "LAST_LEGACY_TICK", 1_964, 18);
      slider.checkPoints = [firstMiss, repeatedMiss, repeat, nextMiss, anotherMiss, tail];
      const released = (time: number): ReplayFrame => ({ time, position: { x: 500, y: 380 }, actions: [] });
      const map = new Beatmap([slider], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
      const machine = new BucketedGameStateTimeMachine(
        [
          frame(head.hitTime, head.position),
          released(1_001),
          released(firstMiss.hitTime),
          released(repeatedMiss.hitTime),
          recapture ? frame(repeat.hitTime, repeat.position) : released(repeat.hitTime),
          released(1_501),
          released(nextMiss.hitTime),
          released(anotherMiss.hitTime),
          released(tail.hitTime),
          released(slider.endTime),
        ],
        map,
        stableOptions,
      );
      const breakIdsAt = (time: number) =>
        retrieveEvents(machine.gameStateAt(time), map.hitObjects, "stable")
          .filter((event) => event.type === "SliderBreak")
          .map((event) => event.componentId);

      const expected = recapture ? [firstMiss.id, nextMiss.id] : [firstMiss.id];
      expect(breakIdsAt(slider.endTime)).toEqual(expected);
      expect(breakIdsAt(firstMiss.hitTime - 1)).toEqual([]);
      expect(breakIdsAt(repeatedMiss.hitTime)).toEqual([firstMiss.id]);
      expect(breakIdsAt(slider.endTime)).toEqual(expected);

      const finalState = machine.gameStateAt(slider.endTime);
      expect(
        retrieveEvents(finalState, map.hitObjects, "stable").filter(
          (event) => event.type === "CheckpointJudgement" && !event.hit && event.checkpointType !== "LAST_LEGACY_TICK",
        ),
      ).toHaveLength(recapture ? 4 : 5);
      expect(new GameplayInfoEvaluator(map).evaluateReplayState(finalState)).toMatchObject({
        currentCombo: 0,
        maxComboSoFar: 1,
        verdictCounts: [0, 0, 1, 0],
      });
    },
  );

  it("counts the head, tick, repeat, and successful legacy tail exactly once", () => {
    const head = new HitCircle();
    head.id = "all-hit/HEAD";
    head.hitTime = 1_000;
    head.approachDuration = 600;
    head.position = { x: 100, y: 192 };
    head.unstackedPosition = head.position;
    head.sliderId = "all-hit";

    const slider = new Slider(head);
    slider.id = "all-hit";
    slider.repeatCount = 1;
    slider.velocity = 0.2;
    slider.path = new SliderPath(
      [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }],
      100,
    );
    const tick = checkpoint(slider, "all-hit/TICK", "TICK", 1_200, 40);
    const repeat = checkpoint(slider, "all-hit/REPEAT", "REPEAT", 1_500, 100);
    const legacyTail = checkpoint(slider, "all-hit/TAIL", "LAST_LEGACY_TICK", 1_950, 10);
    slider.checkPoints = [tick, repeat, legacyTail];

    const map = new Beatmap([slider], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
    const machine = new BucketedGameStateTimeMachine(
      [
        frame(head.hitTime, slider.startPosition),
        frame(tick.hitTime, tick.position),
        frame(repeat.hitTime, repeat.position),
        frame(legacyTail.hitTime, legacyTail.position),
        frame(slider.endTime, slider.endPosition),
      ],
      map,
      stableOptions,
    );

    const finalInfo = new GameplayInfoEvaluator(map).evaluateReplayState(machine.gameStateAt(slider.endTime));
    expect(finalInfo).toMatchObject({
      verdictCounts: [1, 0, 0, 0],
      currentCombo: 4,
      maxComboSoFar: 4,
    });
  });

  it("activates tracking at the exact slider start before using the expanded follow radius", () => {
    const head = new HitCircle();
    head.id = "slider/HEAD";
    head.hitTime = 1_000;
    head.approachDuration = 600;
    head.position = { x: 100, y: 192 };
    head.unstackedPosition = head.position;
    head.sliderId = "slider";

    const slider = new Slider(head);
    slider.id = "slider";
    slider.repeatCount = 1;
    slider.velocity = 1;
    slider.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 54, y: 0 } }], 54);

    const repeat = checkpoint(slider, "slider/REPEAT", "REPEAT", 1_054, 54);
    const legacyTail = checkpoint(slider, "slider/TAIL", "LAST_LEGACY_TICK", 1_072, 36);
    slider.checkPoints = [repeat, legacyTail];

    const radius = slider.radius;
    const heldFrame = (time: number, position: { x: number; y: number }): ReplayFrame => ({
      time,
      position,
      actions: [OsuAction.leftButton],
    });
    const map = new Beatmap([slider], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
    const machine = new BucketedGameStateTimeMachine(
      [
        heldFrame(800, { x: slider.startPosition.x, y: slider.startPosition.y + radius * 5 }),
        heldFrame(1_000, { x: slider.startPosition.x + radius * 0.96, y: slider.startPosition.y }),
        heldFrame(1_004, {
          x: slider.ballPositionAt(4 / slider.duration).x + radius * 1.05,
          y: slider.startPosition.y,
        }),
        heldFrame(repeat.hitTime, { x: repeat.position.x + radius * 1.27, y: repeat.position.y }),
        heldFrame(legacyTail.hitTime, legacyTail.position),
        heldFrame(slider.endTime, slider.endPosition),
      ],
      map,
      stableOptions,
    );

    const finalState = machine.gameStateAt(slider.endTime);
    expect(finalState.hitCircleVerdict[head.id]).toBeUndefined();
    expect(finalState.sliderVerdict[slider.id]).toBe("OK");
    expect(finalState.checkPointVerdict[repeat.id]).toMatchObject({ hit: true });
  });

  it("keeps a missed legacy tail out of sliderbreak and combo-reset semantics", () => {
    const head = new HitCircle();
    head.id = "slider/HEAD";
    head.hitTime = 1_000;
    head.approachDuration = 600;
    head.position = { x: 100, y: 192 };
    head.unstackedPosition = head.position;
    head.sliderId = "slider";

    const slider = new Slider(head);
    slider.id = "slider";
    slider.repeatCount = 1;
    slider.velocity = 0.2;
    slider.path = new SliderPath(
      [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }],
      100,
    );

    const tick = checkpoint(slider, "slider/TICK", "TICK", 1_200, 40);
    const repeat = checkpoint(slider, "slider/REPEAT", "REPEAT", 1_500, 100);
    const legacyTail = checkpoint(slider, "slider/TAIL", "LAST_LEGACY_TICK", 1_950, 10);
    slider.checkPoints = [tick, repeat, legacyTail];

    const map = new Beatmap([slider], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
    const farFrom = (position: { x: number; y: number }) => ({
      x: position.x,
      y: position.y + slider.radius * 3,
    });
    const machine = new BucketedGameStateTimeMachine(
      [
        frame(head.hitTime, slider.startPosition),
        frame(head.hitTime + 1, slider.ballPositionAt(0.001)),
        frame(tick.hitTime, farFrom(tick.position)),
        frame(repeat.hitTime, repeat.position),
        frame(legacyTail.hitTime, farFrom(legacyTail.position)),
        frame(slider.endTime, farFrom(slider.endPosition)),
      ],
      map,
      stableOptions,
    );
    const infoEvaluator = new GameplayInfoEvaluator(map);

    const afterRepeat = infoEvaluator.evaluateReplayState(machine.gameStateAt(repeat.hitTime));
    expect(afterRepeat).toMatchObject({ currentCombo: 1, maxComboSoFar: 1 });

    const afterLegacyTail = infoEvaluator.evaluateReplayState(machine.gameStateAt(legacyTail.hitTime));
    expect(afterLegacyTail).toMatchObject({ currentCombo: 1, maxComboSoFar: 1 });

    const finalState = machine.gameStateAt(slider.endTime);
    const finalInfo = infoEvaluator.evaluateReplayState(finalState);
    expect(finalState.hitCircleVerdict[head.id]).toMatchObject({ type: "GREAT", judgementTime: head.hitTime });
    expect(finalState.checkPointVerdict).toMatchObject({
      [tick.id]: { hit: false },
      [repeat.id]: { hit: true },
      [legacyTail.id]: { hit: false },
    });
    expect(finalState.sliderVerdict[slider.id]).toBe("OK");
    expect(finalInfo).toMatchObject({
      verdictCounts: [0, 1, 0, 0],
      currentCombo: 1,
      maxComboSoFar: 1,
    });

    const events = retrieveEvents(finalState, map.hitObjects, "stable");
    expect(events.filter((event) => event.type === "SliderBreak")).toEqual([
      expect.objectContaining({
        sliderId: slider.id,
        componentId: tick.id,
        componentType: "TICK",
        time: tick.hitTime,
      }),
    ]);
    expect(events.filter((event) => event.type === "CheckpointJudgement")).toEqual([
      expect.objectContaining({ checkpointId: tick.id, checkpointType: "TICK", hit: false }),
      expect.objectContaining({ checkpointId: repeat.id, checkpointType: "REPEAT", hit: true }),
      expect.objectContaining({
        checkpointId: legacyTail.id,
        checkpointType: "LAST_LEGACY_TICK",
        hit: false,
        isLastTick: true,
      }),
    ]);
    expect(events.filter((event) => event.type === "HitObjectJudgement" && event.hitObjectId === slider.id)).toEqual([
      expect.objectContaining({
        verdict: "OK",
        time: slider.endTime,
        objectTime: slider.startTime,
        judgementTime: slider.endTime,
      }),
    ]);
    expect(events.some((event) => event.type === "HitObjectJudgement" && event.verdict === "MISS")).toBe(false);
  });
});
