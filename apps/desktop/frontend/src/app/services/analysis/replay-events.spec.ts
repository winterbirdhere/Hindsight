import {
  findNearestErrorIndex,
  findNextErrorIndex,
  findPreviousErrorIndex,
  ReplayError,
  summarizeReplayEvents,
} from "./replay-events";
import { ReplayAnalysisEvent } from "@osujs/core";

describe("replay event summary", () => {
  it("separates judgement markers and only exposes Stable combo breaks as errors", () => {
    const events: ReplayAnalysisEvent[] = [
      { type: "HitObjectJudgement", time: 100, position: { x: 0, y: 0 }, hitObjectId: "0", verdict: "GREAT" },
      { type: "HitObjectJudgement", time: 200, position: { x: 0, y: 0 }, hitObjectId: "1", verdict: "OK" },
      { type: "HitObjectJudgement", time: 300, position: { x: 0, y: 0 }, hitObjectId: "2", verdict: "MEH" },
      { type: "HitObjectJudgement", time: 400, position: { x: 0, y: 0 }, hitObjectId: "3", verdict: "MISS" },
      {
        type: "SliderBreak",
        time: 500,
        objectTime: 500,
        judgementTime: 500,
        eventId: "stable:slider-break:4/HEAD",
        ruleset: "stable",
        position: { x: 0, y: 0 },
        sliderId: "4",
        componentId: "4/HEAD",
        componentType: "HEAD",
      },
      {
        type: "SliderBreak",
        time: 600,
        objectTime: 600,
        judgementTime: 600,
        eventId: "stable:slider-break:5/0",
        ruleset: "stable",
        sliderId: "5",
        componentId: "5/0",
        componentType: "TICK",
        position: { x: 0, y: 0 },
      },
      {
        type: "CheckpointJudgement",
        time: 700,
        objectTime: 700,
        judgementTime: 700,
        eventId: "stable:checkpoint-judgement:5/1",
        ruleset: "stable",
        checkpointId: "5/1",
        sliderId: "5",
        checkpointType: "LAST_LEGACY_TICK",
        position: { x: 0, y: 0 },
        hit: false,
        isLastTick: true,
        sliderEndTime: 736,
      },
    ];

    const { timings, errors } = summarizeReplayEvents(events);

    expect(timings).toEqual({
      great: [100],
      ok: [200],
      meh: [300],
      miss: [400],
      sliderBreak: [500, 600],
      stableSliderEndMiss: [],
      lazerSliderTickMiss: [],
      lazerSliderEndMiss: [],
    });
    expect(errors.map(({ time, type }) => ({ time, type }))).toEqual([
      { time: 400, type: "MISS" },
      { time: 500, type: "SLIDER_BREAK" },
      { time: 600, type: "SLIDER_BREAK" },
    ]);
    const tailOnlyEvents = events.filter((event) => event.type !== "SliderBreak");
    expect(summarizeReplayEvents(tailOnlyEvents).timings.stableSliderEndMiss).toEqual([736]);
    expect(summarizeReplayEvents(tailOnlyEvents).errors.map((error) => error.type)).toEqual(["MISS"]);
  });

  it("shows a whole-slider MISS once and suppresses component sliderbreaks for that slider", () => {
    const events: ReplayAnalysisEvent[] = [
      {
        type: "SliderBreak",
        time: 1000,
        objectTime: 1000,
        judgementTime: 1000,
        eventId: "stable:slider-break:8/HEAD",
        ruleset: "stable",
        position: { x: 0, y: 0 },
        sliderId: "8",
        componentId: "8/HEAD",
        componentType: "HEAD",
      },
      {
        type: "HitObjectJudgement",
        time: 1500,
        objectTime: 1500,
        judgementTime: 1500,
        eventId: "stable:hit-object-judgement:8",
        ruleset: "stable",
        position: { x: 100, y: 0 },
        hitObjectId: "8",
        verdict: "MISS",
      },
    ];

    const { timings, errors } = summarizeReplayEvents(events);

    expect(timings.miss).toEqual([1500]);
    expect(timings.sliderBreak).toEqual([]);
    expect(errors).toEqual([
      {
        id: "miss:8",
        time: 1500,
        type: "MISS",
        hitObjectId: "8",
      },
    ]);
  });

  it("does not infer sliderbreaks from low-level missed judgements", () => {
    const events: ReplayAnalysisEvent[] = [
      {
        type: "HitObjectJudgement",
        time: 1000,
        position: { x: 0, y: 0 },
        hitObjectId: "8/HEAD",
        verdict: "MISS",
        isSliderHead: true,
      },
      {
        type: "CheckpointJudgement",
        time: 1200,
        objectTime: 1200,
        judgementTime: 1200,
        eventId: "stable:checkpoint-judgement:8/0",
        ruleset: "stable",
        checkpointId: "8/0",
        sliderId: "8",
        checkpointType: "TICK",
        position: { x: 0, y: 0 },
        hit: false,
      },
    ];

    expect(summarizeReplayEvents(events)).toEqual({
      timings: {
        great: [],
        ok: [],
        meh: [],
        miss: [],
        sliderBreak: [],
        stableSliderEndMiss: [],
        lazerSliderTickMiss: [],
        lazerSliderEndMiss: [],
      },
      errors: [],
    });
  });

  it("keeps a native lazer slider-head miss visible as a MISS rather than an SB", () => {
    const event: ReplayAnalysisEvent = {
      type: "HitObjectJudgement",
      time: 1_000,
      objectTime: 1_000,
      judgementTime: 1_150,
      eventId: "lazer:hit-object-judgement:8/HEAD",
      ruleset: "lazer",
      position: { x: 0, y: 0 },
      hitObjectId: "8/HEAD",
      verdict: "MISS",
      isSliderHead: true,
    };

    expect(summarizeReplayEvents([event])).toEqual({
      timings: {
        great: [],
        ok: [],
        meh: [],
        miss: [1_000],
        sliderBreak: [],
        stableSliderEndMiss: [],
        lazerSliderTickMiss: [],
        lazerSliderEndMiss: [],
      },
      errors: [
        {
          id: "miss:8/HEAD",
          time: 1_000,
          type: "MISS",
          hitObjectId: "8/HEAD",
        },
      ],
    });
  });

  it("navigates native lazer tick misses but keeps tail misses in SliderEnd timings only", () => {
    const events: ReplayAnalysisEvent[] = [
      {
        type: "SliderComponentMiss",
        time: 1_220,
        objectTime: 1_200,
        judgementTime: 1_220,
        eventId: "lazer:slider-component-miss:8/0",
        ruleset: "lazer",
        sliderId: "8",
        componentId: "8/0",
        componentType: "TICK",
        position: { x: 100, y: 100 },
      },
      {
        type: "SliderComponentMiss",
        time: 1_480,
        objectTime: 1_500,
        judgementTime: 1_480,
        eventId: "lazer:slider-component-miss:8/TAIL",
        ruleset: "lazer",
        sliderId: "8",
        componentId: "8/TAIL",
        componentType: "TAIL",
        position: { x: 200, y: 100 },
      },
    ];

    const { timings, errors } = summarizeReplayEvents(events);

    expect(timings).toEqual({
      great: [],
      ok: [],
      meh: [],
      miss: [],
      sliderBreak: [],
      stableSliderEndMiss: [],
      lazerSliderTickMiss: [1_200],
      lazerSliderEndMiss: [1_500],
    });
    expect(errors).toEqual([
      {
        id: "lazer:slider-component-miss:8/0",
        time: 1_200,
        type: "SLIDER_COMPONENT_MISS",
        sliderId: "8",
        sliderComponentType: "TICK",
      },
    ]);
    expect(errors.some((error) => error.type === "SLIDER_BREAK")).toBe(false);
  });

  it("never exposes Stable SB markers while Lazer is the active ruleset", () => {
    const events: ReplayAnalysisEvent[] = [
      {
        type: "SliderBreak",
        time: 1_000,
        objectTime: 1_000,
        judgementTime: 1_000,
        eventId: "stable:slider-break:8/0",
        ruleset: "stable",
        sliderId: "8",
        componentId: "8/0",
        componentType: "TICK",
        position: { x: 100, y: 100 },
      },
      {
        type: "SliderComponentMiss",
        time: 1_200,
        objectTime: 1_200,
        judgementTime: 1_200,
        eventId: "lazer:slider-component-miss:8/1",
        ruleset: "lazer",
        sliderId: "8",
        componentId: "8/1",
        componentType: "REPEAT",
        position: { x: 200, y: 100 },
      },
    ];

    expect(summarizeReplayEvents(events, "lazer")).toEqual({
      timings: {
        great: [],
        ok: [],
        meh: [],
        miss: [],
        sliderBreak: [],
        stableSliderEndMiss: [],
        lazerSliderTickMiss: [1_200],
        lazerSliderEndMiss: [],
      },
      errors: [
        {
          id: "lazer:slider-component-miss:8/1",
          time: 1_200,
          type: "SLIDER_COMPONENT_MISS",
          sliderId: "8",
          sliderComponentType: "REPEAT",
        },
      ],
    });
  });
});

describe("replay error navigation", () => {
  const errors: ReplayError[] = [
    { id: "a", time: 1000, type: "MISS" },
    { id: "b", time: 3000, type: "SLIDER_BREAK" },
    { id: "c", time: 5000, type: "MISS" },
  ];

  it("selects relative to playback until an explicit selection exists", () => {
    expect(findPreviousErrorIndex(errors, 4200)).toBe(1);
    expect(findNextErrorIndex(errors, 4200)).toBe(2);
    expect(findPreviousErrorIndex(errors, 4200, 2)).toBe(1);
    expect(findNextErrorIndex(errors, 1200, 0)).toBe(1);
    expect(findPreviousErrorIndex(errors, 4200, 1)).toBe(1);
    expect(findNearestErrorIndex(errors, 4100)).toBe(2);
  });
});
