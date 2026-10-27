import type { ReplayAnalysisEvent } from "@osujs/core";
import { collectLazerSliderMissFeedback } from "./LazerSliderJudgementFeedback";

const position = { x: 128, y: 96 };

describe("lazer slider miss feedback", () => {
  it("shows a Classic head miss as a tick miss at its actual resolution", () => {
    const event: ReplayAnalysisEvent = {
      type: "SliderComponentMiss",
      ruleset: "lazer",
      eventId: "classic-head-miss",
      sliderId: "slider",
      componentId: "slider/HEAD",
      componentType: "HEAD",
      time: 1150,
      judgementTime: 1150,
      objectTime: 1000,
      position,
    };
    expect(collectLazerSliderMissFeedback([event])).toEqual([
      { id: event.eventId, time: 1150, position, kind: "HEAD" },
    ]);
  });

  it("keeps only native lazer tick, repeat, and SliderEnd misses", () => {
    const events: ReplayAnalysisEvent[] = [
      {
        type: "CheckpointJudgement",
        eventId: "stable-tick",
        ruleset: "stable",
        time: 900,
        objectTime: 900,
        judgementTime: 900,
        checkpointId: "stable-tick",
        sliderId: "slider",
        checkpointType: "TICK",
        hit: false,
        position,
      },
      {
        type: "CheckpointJudgement",
        eventId: "lazer-tick",
        ruleset: "lazer",
        time: 1_000,
        objectTime: 1_000,
        judgementTime: 1_000,
        checkpointId: "lazer-tick",
        sliderId: "slider",
        checkpointType: "TICK",
        hit: true,
        position,
      },
      {
        type: "CheckpointJudgement",
        eventId: "lazer-repeat",
        ruleset: "lazer",
        time: 1_200,
        objectTime: 1_200,
        judgementTime: 1_200,
        checkpointId: "lazer-repeat",
        sliderId: "slider",
        checkpointType: "REPEAT",
        hit: false,
        position,
      },
      {
        type: "SliderEndJudgement",
        eventId: "lazer-end",
        ruleset: "lazer",
        time: 1_400,
        objectTime: 1_436,
        judgementTime: 1_400,
        sliderId: "slider",
        componentId: "slider/TAIL",
        hit: false,
        position,
      },
      {
        type: "SliderEndJudgement",
        eventId: "lazer-end-hit",
        ruleset: "lazer",
        time: 1_600,
        objectTime: 1_636,
        judgementTime: 1_600,
        sliderId: "slider-2",
        componentId: "slider-2/TAIL",
        hit: true,
        position,
      },
    ];

    expect(collectLazerSliderMissFeedback(events)).toEqual([
      expect.objectContaining({ id: "lazer-repeat", kind: "REPEAT" }),
      expect.objectContaining({ id: "lazer-end", kind: "SLIDER_END" }),
    ]);
  });
});
