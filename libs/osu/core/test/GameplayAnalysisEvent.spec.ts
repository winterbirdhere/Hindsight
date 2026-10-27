import { defaultGameState } from "../src/gameplay/GameState";
import {
  CheckpointJudgement,
  isNotelockMiss,
  isSliderBreak,
  isSliderComponentMiss,
  isSliderEndJudgement,
  retrieveEvents,
  SliderBreak,
} from "../src/gameplay/GameplayAnalysisEvent";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { SliderCheckPoint } from "../src/hitobjects/SliderCheckPoint";
import { SliderCheckPointType } from "../src/hitobjects/Types";
import { PathType } from "../src/hitobjects/slider/PathType";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";

function createCheckpoint(
  slider: Slider,
  id: string,
  type: SliderCheckPointType,
  hitTime: number,
  x: number,
): SliderCheckPoint {
  const checkpoint = new SliderCheckPoint(slider);
  checkpoint.id = id;
  checkpoint.type = type;
  checkpoint.hitTime = hitTime;
  checkpoint.offset = { x, y: 0 };
  return checkpoint;
}

function createSliderFixture() {
  const head = new HitCircle();
  head.id = "0/HEAD";
  head.hitTime = 1000;
  head.position = { x: 64, y: 96 };
  head.sliderId = "0";

  const slider = new Slider(head);
  slider.id = "0";
  slider.repeatCount = 1;
  slider.velocity = 1;
  slider.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 300, y: 0 } }], 300);

  const tick = createCheckpoint(slider, "0/0", "TICK", 1050, 50);
  const repeat = createCheckpoint(slider, "0/1", "REPEAT", 1300, 300);
  const unprocessed = createCheckpoint(slider, "0/2", "TICK", 1400, 200);
  const tail = createCheckpoint(slider, "0/3", "LAST_LEGACY_TICK", 1550, 50);
  slider.checkPoints = [tick, repeat, unprocessed, tail];

  return { slider, head, tick, repeat, unprocessed, tail };
}

describe("retrieveEvents Stable event extraction", () => {
  it("uses checkpoint hit times, includes checkpoint metadata, skips undefined state, and sorts chronologically", () => {
    const { slider, head, tick, repeat, unprocessed, tail } = createSliderFixture();
    const circle = new HitCircle();
    circle.id = "1";
    circle.hitTime = 900;
    circle.position = { x: 320, y: 128 };

    const state = defaultGameState();
    // Deliberately insert the later slider-head judgement before the earlier circle judgement.
    state.hitCircleVerdict[head.id] = {
      type: "MISS",
      missReason: "TIME_EXPIRED",
      judgementTime: 1110,
    };
    state.hitCircleVerdict[circle.id] = { type: "GREAT", judgementTime: 905 };
    state.sliderVerdict[slider.id] = "OK";
    state.checkPointVerdict[tick.id] = { hit: false };
    state.checkPointVerdict[repeat.id] = { hit: false };
    state.checkPointVerdict[tail.id] = { hit: false };
    // unprocessed intentionally has no state entry.

    const events = retrieveEvents(state, [slider, circle]);
    const checkpoints = events.filter((event): event is CheckpointJudgement => event.type === "CheckpointJudgement");

    expect(checkpoints.map((event) => event.checkpointId)).toEqual([tick.id, repeat.id, tail.id]);
    expect(checkpoints.map((event) => event.checkpointId)).not.toContain(unprocessed.id);
    expect(checkpoints[0]).toMatchObject({
      eventId: "stable:checkpoint-judgement:0/0",
      ruleset: "stable",
      time: tick.hitTime,
      objectTime: tick.hitTime,
      judgementTime: tick.hitTime,
      sliderId: slider.id,
      checkpointId: tick.id,
      checkpointType: "TICK",
      hit: false,
      isLastTick: false,
    });

    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].time).toBeLessThanOrEqual(events[i].time);
    }
  });

  it.each(["HEAD", "TICK", "REPEAT"] as const)(
    "emits a %s sliderbreak when that component resets combo",
    (componentType) => {
      const { slider, head, tick, repeat, tail } = createSliderFixture();
      const precedingCircle = new HitCircle();
      precedingCircle.id = "preceding";
      precedingCircle.hitTime = 900;
      const missedComponent = componentType === "HEAD" ? head : componentType === "TICK" ? tick : repeat;
      const state = defaultGameState();
      state.hitCircleVerdict[precedingCircle.id] = { type: "GREAT", judgementTime: 900 };
      state.hitCircleVerdict[head.id] =
        componentType === "HEAD"
          ? { type: "MISS", missReason: "TIME_EXPIRED", judgementTime: 1110 }
          : { type: "GREAT", judgementTime: head.hitTime };
      state.sliderVerdict[slider.id] = "MEH";
      state.checkPointVerdict[tick.id] = { hit: componentType !== "TICK" };
      state.checkPointVerdict[repeat.id] = { hit: componentType !== "REPEAT" };
      state.checkPointVerdict[tail.id] = { hit: false };
      state.judgedObjects =
        componentType === "HEAD"
          ? [precedingCircle.id, tick.id, head.id, repeat.id, tail.id, slider.id]
          : [precedingCircle.id, head.id, tick.id, repeat.id, tail.id, slider.id];

      const sliderBreaks = retrieveEvents(state, [precedingCircle, slider]).filter(isSliderBreak);

      expect(sliderBreaks.map((event) => event.componentType)).toEqual([componentType]);
      expect(sliderBreaks.map((event) => event.componentId)).not.toContain(tail.id);
      expect(sliderBreaks).toContainEqual<SliderBreak>({
        type: "SliderBreak",
        eventId: `stable:slider-break:${missedComponent.id}`,
        ruleset: "stable",
        time: componentType === "HEAD" ? 1110 : missedComponent.hitTime,
        objectTime: missedComponent.hitTime,
        judgementTime: componentType === "HEAD" ? 1110 : missedComponent.hitTime,
        sliderId: slider.id,
        componentId: missedComponent.id,
        componentType,
        position: missedComponent.position,
      });
    },
  );

  it("uses recorded judgement order when a tick and an expired head resolve together", () => {
    const { slider, head, tick, repeat } = createSliderFixture();
    const state = defaultGameState();
    state.hitCircleVerdict[head.id] = { type: "MISS", missReason: "TIME_EXPIRED", judgementTime: 1110 };
    state.checkPointVerdict[tick.id] = { hit: true, judgementTime: 1110 };
    state.checkPointVerdict[repeat.id] = { hit: false };
    state.sliderVerdict[slider.id] = "MEH";
    state.judgedObjects = [tick.id, head.id, repeat.id, slider.id];

    expect(
      retrieveEvents(state, [slider])
        .filter(isSliderBreak)
        .map((event) => event.componentId),
    ).toEqual([head.id]);

    // At the same timestamp the other evaluator order leaves the tick combo
    // available to be broken by the later repeat instead.
    state.judgedObjects = [head.id, tick.id, repeat.id, slider.id];
    expect(
      retrieveEvents(state, [slider])
        .filter(isSliderBreak)
        .map((event) => event.componentId),
    ).toEqual([repeat.id]);
  });

  it("does not count further slider misses after a circle already reset combo", () => {
    const { slider, head, tick, repeat, tail } = createSliderFixture();
    const circle = new HitCircle();
    circle.id = "circle";
    circle.hitTime = 1025;
    const state = defaultGameState();
    state.hitCircleVerdict[head.id] = { type: "GREAT", judgementTime: head.hitTime };
    state.hitCircleVerdict[circle.id] = { type: "MISS", missReason: "TIME_EXPIRED", judgementTime: 1040 };
    state.checkPointVerdict[tick.id] = { hit: false };
    state.checkPointVerdict[repeat.id] = { hit: false };
    state.checkPointVerdict[tail.id] = { hit: true };
    state.sliderVerdict[slider.id] = "MEH";
    state.judgedObjects = [head.id, circle.id, tick.id, repeat.id, tail.id, slider.id];

    const events = retrieveEvents(state, [slider, circle]);
    expect(events.filter(isSliderBreak)).toEqual([]);
    expect(events.filter((event) => event.type === "CheckpointJudgement" && !event.hit)).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "HitObjectJudgement",
        hitObjectId: circle.id,
        verdict: "MISS",
      }),
    );
  });

  it("does not infer a combo break from slider component verdicts without recorded judgements", () => {
    const { slider, head, tick } = createSliderFixture();
    const state = defaultGameState();
    state.hitCircleVerdict[head.id] = { type: "GREAT", judgementTime: head.hitTime };
    state.checkPointVerdict[tick.id] = { hit: false };
    state.sliderVerdict[slider.id] = "MEH";
    expect(retrieveEvents(state, [slider]).filter(isSliderBreak)).toEqual([]);
  });

  it("keeps a whole-slider MISS as a miss and does not infer a sliderbreak from it", () => {
    const { slider, head, tick, repeat, tail } = createSliderFixture();
    const state = defaultGameState();
    state.hitCircleVerdict[head.id] = { type: "GREAT", judgementTime: head.hitTime };
    state.sliderVerdict[slider.id] = "MISS";
    state.checkPointVerdict[tick.id] = { hit: true };
    state.checkPointVerdict[repeat.id] = { hit: true };
    state.checkPointVerdict[tail.id] = { hit: true };

    const events = retrieveEvents(state, [slider]);

    expect(events.filter(isSliderBreak)).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "HitObjectJudgement",
        eventId: "stable:hit-object-judgement:0",
        hitObjectId: slider.id,
        verdict: "MISS",
      }),
    );
  });

  it("navigates a Stable whole-slider MISS from its head while retaining tail-time resolution", () => {
    const { slider } = createSliderFixture();
    const state = defaultGameState();
    state.sliderVerdict[slider.id] = "MISS";

    const wholeSliderMiss = retrieveEvents(state, [slider]).find(
      (event) => event.type === "HitObjectJudgement" && event.hitObjectId === slider.id,
    );

    expect(wholeSliderMiss).toMatchObject({
      type: "HitObjectJudgement",
      verdict: "MISS",
      objectTime: slider.startTime,
      time: slider.endTime,
      judgementTime: slider.endTime,
    });
  });

  it("preserves explicit evaluator miss evidence on circle judgements", () => {
    const circle = new HitCircle();
    circle.id = "missed-circle";
    circle.hitTime = 1_000;
    circle.position = { x: 120, y: 160 };
    const state = defaultGameState();
    state.hitCircleVerdict[circle.id] = {
      type: "MISS",
      missReason: "HIT_TOO_EARLY",
      judgementTime: 900,
    };

    expect(retrieveEvents(state, [circle])).toContainEqual(
      expect.objectContaining({
        type: "HitObjectJudgement",
        hitObjectId: circle.id,
        verdict: "MISS",
        missReason: "HIT_TOO_EARLY",
      }),
    );
  });

  it("maps Stable circle evidence to a canonical notelock miss", () => {
    const circle = new HitCircle();
    circle.id = "notelocked-circle";
    circle.hitTime = 1_000;
    circle.position = { x: 120, y: 160 };
    const state = defaultGameState();
    state.hitCircleVerdict[circle.id] = {
      type: "MISS",
      missReason: "TIME_EXPIRED",
      judgementTime: 1_150,
    };
    state.stableNotelockEvidence[circle.id] = {
      targetHitObjectId: circle.id,
      blockerHitObjectId: "earlier-circle",
      pressTime: 1_000,
      cursorDistance: 0,
      objectRadius: circle.radius,
      wouldHaveHit: "GREAT",
    };

    expect(retrieveEvents(state, [circle]).filter(isNotelockMiss)).toEqual([
      expect.objectContaining({
        hitObjectId: circle.id,
        notelockCause: {
          kind: "STABLE_BLOCKED_VALID_PRESS",
          ...state.stableNotelockEvidence[circle.id],
        },
      }),
    ]);
  });

  it("promotes Stable slider-head evidence to the whole-slider MISS without double-counting the nested head", () => {
    const { slider, head } = createSliderFixture();
    const state = defaultGameState();
    state.hitCircleVerdict[head.id] = {
      type: "MISS",
      missReason: "TIME_EXPIRED",
      judgementTime: 1_150,
    };
    state.sliderVerdict[slider.id] = "MISS";
    state.stableNotelockEvidence[head.id] = {
      targetHitObjectId: head.id,
      blockerHitObjectId: "earlier-circle",
      pressTime: 1_000,
      cursorDistance: 0,
      objectRadius: head.radius,
      wouldHaveHit: "GREAT",
    };

    const notelockMisses = retrieveEvents(state, [slider]).filter(isNotelockMiss);
    expect(notelockMisses).toEqual([
      expect.objectContaining({
        hitObjectId: slider.id,
        notelockCause: {
          kind: "STABLE_BLOCKED_VALID_PRESS",
          ...state.stableNotelockEvidence[head.id],
        },
      }),
    ]);
  });

  it("detects only native-lazer misses with blocked-valid-press evidence", () => {
    const forceMissed = new HitCircle();
    forceMissed.id = "force-missed";
    forceMissed.hitTime = 1_000;
    forceMissed.position = { x: 120, y: 160 };
    const notelocked = new HitCircle();
    notelocked.id = "notelocked";
    notelocked.hitTime = 1_100;
    notelocked.position = { x: 170, y: 160 };
    const inputMissed = new HitCircle();
    inputMissed.id = "input-missed";
    inputMissed.hitTime = 1_200;
    inputMissed.position = { x: 220, y: 160 };
    const ordinaryMissed = new HitCircle();
    ordinaryMissed.id = "ordinary-missed";
    ordinaryMissed.hitTime = 1_300;
    ordinaryMissed.position = { x: 320, y: 160 };
    const state = defaultGameState();
    state.hitCircleVerdict[forceMissed.id] = {
      type: "MISS",
      missReason: "ORDERED_POLICY_FORCE_MISS",
      judgementTime: 1_050,
    };
    state.lazerNotelockEvidence[forceMissed.id] = {
      targetHitObjectId: forceMissed.id,
      blockerHitObjectId: "stale-blocker",
      pressTime: 900,
      cursorDistance: 0,
      objectRadius: 64,
      wouldHaveHit: "GREAT",
    };
    state.hitCircleVerdict[notelocked.id] = {
      type: "MISS",
      missReason: "TIME_EXPIRED",
      judgementTime: 1_250,
    };
    state.lazerNotelockEvidence[notelocked.id] = {
      targetHitObjectId: notelocked.id,
      blockerHitObjectId: forceMissed.id,
      pressTime: 980,
      cursorDistance: 0,
      objectRadius: 64,
      wouldHaveHit: "MEH",
    };
    state.hitCircleVerdict[inputMissed.id] = {
      type: "MISS",
      missReason: "INPUT_WINDOW_MISS",
      judgementTime: 1_050,
    };
    state.hitCircleVerdict[ordinaryMissed.id] = {
      type: "MISS",
      missReason: "TIME_EXPIRED",
      judgementTime: 1_350,
    };

    const events = retrieveEvents(state, [forceMissed, notelocked, inputMissed, ordinaryMissed], "lazer");
    expect(events.filter(isNotelockMiss)).toEqual([
      expect.objectContaining({
        hitObjectId: notelocked.id,
        notelockCause: {
          kind: "LAZER_BLOCKED_VALID_PRESS",
          ...state.lazerNotelockEvidence[notelocked.id],
        },
      }),
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === "HitObjectJudgement" &&
          (event.hitObjectId === forceMissed.id ||
            event.hitObjectId === inputMissed.id ||
            event.hitObjectId === ordinaryMissed.id),
      ),
    ).toEqual([
      expect.not.objectContaining({ notelockCause: expect.anything() }),
      expect.not.objectContaining({ notelockCause: expect.anything() }),
      expect.not.objectContaining({ notelockCause: expect.anything() }),
    ]);
  });

  it("does not count any component as a sliderbreak when the slider itself is a MISS", () => {
    const { slider, head, tick, repeat, tail } = createSliderFixture();
    const state = defaultGameState();
    state.hitCircleVerdict[head.id] = {
      type: "MISS",
      missReason: "TIME_EXPIRED",
      judgementTime: 1110,
    };
    state.sliderVerdict[slider.id] = "MISS";
    state.checkPointVerdict[tick.id] = { hit: false };
    state.checkPointVerdict[repeat.id] = { hit: true };
    state.checkPointVerdict[tail.id] = { hit: false };

    const events = retrieveEvents(state, [slider]);
    const sliderBreaks = events.filter(isSliderBreak);

    expect(sliderBreaks).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "HitObjectJudgement",
        hitObjectId: slider.id,
        verdict: "MISS",
      }),
    );
  });

  it("emits native lazer head and nested-component judgements without a parent result or Stable SB", () => {
    const { slider, head, tick } = createSliderFixture();
    const state = defaultGameState();
    state.hitCircleVerdict[head.id] = {
      type: "MISS",
      missReason: "TIME_EXPIRED",
      judgementTime: 1111,
    };
    state.sliderVerdict[slider.id] = "OK";
    state.checkPointVerdict[tick.id] = { hit: false };
    state.sliderTailVerdict[slider.id] = { hit: false, judgementTime: 1_564 };

    const events = retrieveEvents(state, [slider], "lazer");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "HitObjectJudgement",
          eventId: "lazer:hit-object-judgement:0/HEAD",
          ruleset: "lazer",
          hitObjectId: head.id,
          verdict: "MISS",
        }),
        expect.objectContaining({
          type: "CheckpointJudgement",
          eventId: "lazer:checkpoint-judgement:0/0",
          ruleset: "lazer",
          checkpointId: tick.id,
          hit: false,
        }),
      ]),
    );
    expect(events.filter(isSliderBreak)).toEqual([]);
    expect(events.filter(isSliderComponentMiss)).toEqual([
      expect.objectContaining({
        eventId: "lazer:slider-component-miss:0/0",
        ruleset: "lazer",
        sliderId: slider.id,
        componentId: tick.id,
        componentType: "TICK",
        objectTime: tick.hitTime,
      }),
      expect.objectContaining({
        eventId: "lazer:slider-component-miss:0/TAIL",
        ruleset: "lazer",
        sliderId: slider.id,
        componentId: "0/TAIL",
        componentType: "TAIL",
        objectTime: slider.endTime,
        judgementTime: 1_564,
      }),
    ]);
    expect(events.filter(isSliderEndJudgement)).toEqual([
      expect.objectContaining({
        eventId: "lazer:slider-end-judgement:0/TAIL",
        ruleset: "lazer",
        sliderId: slider.id,
        componentId: "0/TAIL",
        objectTime: slider.endTime,
        judgementTime: 1_564,
        hit: false,
      }),
    ]);
    expect(events.some((event) => event.type === "HitObjectJudgement" && event.hitObjectId === slider.id)).toBe(false);
  });

  it("emits a successful native lazer SliderEnd judgement without inventing a Stable equivalent", () => {
    const { slider, head } = createSliderFixture();
    const state = defaultGameState();
    state.hitCircleVerdict[head.id] = { type: "GREAT", judgementTime: head.hitTime };
    state.sliderVerdict[slider.id] = "GREAT";
    state.sliderTailVerdict[slider.id] = { hit: true, judgementTime: 1_564 };

    const lazerEvents = retrieveEvents(state, [slider], "lazer");
    const stableEvents = retrieveEvents(state, [slider], "stable");

    expect(lazerEvents.filter(isSliderEndJudgement)).toEqual([
      expect.objectContaining({
        eventId: "lazer:slider-end-judgement:0/TAIL",
        sliderId: slider.id,
        hit: true,
      }),
    ]);
    expect(lazerEvents.filter(isSliderComponentMiss)).toEqual([]);
    expect(stableEvents.filter(isSliderEndJudgement)).toEqual([]);
  });

  it("never exposes native lazer component misses as Stable sliderbreaks", () => {
    const { slider, head, repeat } = createSliderFixture();
    const state = defaultGameState();
    state.hitCircleVerdict[head.id] = { type: "GREAT", judgementTime: head.hitTime };
    state.sliderVerdict[slider.id] = "GREAT";
    state.checkPointVerdict[repeat.id] = { hit: false, judgementTime: repeat.hitTime };
    state.sliderTailVerdict[slider.id] = { hit: false, judgementTime: slider.endTime };

    const events = retrieveEvents(state, [slider], "lazer");

    expect(events.filter(isSliderBreak)).toEqual([]);
    expect(events.filter(isSliderComponentMiss).map((event) => event.componentType)).toEqual(["REPEAT", "TAIL"]);
  });

  it("keeps an entirely missed lazer slider as one actual head MISS with no SB count", () => {
    const { slider, head, tick, repeat } = createSliderFixture();
    const state = defaultGameState();
    state.hitCircleVerdict[head.id] = {
      type: "MISS",
      missReason: "TIME_EXPIRED",
      judgementTime: 1_150,
    };
    state.sliderVerdict[slider.id] = "MISS";
    state.checkPointVerdict[tick.id] = { hit: false };
    state.checkPointVerdict[repeat.id] = { hit: false };

    const events = retrieveEvents(state, [slider], "lazer");
    expect(events.filter(isSliderBreak)).toEqual([]);
    expect(events.filter((event) => event.type === "HitObjectJudgement")).toEqual([
      expect.objectContaining({ hitObjectId: head.id, isSliderHead: true, verdict: "MISS" }),
    ]);
  });
});
