import type { GameplayInfo, ReplayAnalysisEvent } from "@osujs/core";
import { liveReplayStatsAt, sliderMissResolutionTimes, stableSliderBreakResolutionTimes } from "./live-replay-stats";

const position = { x: 0, y: 0 };

function stableTailMiss(sliderId: string, sliderEndTime: number): ReplayAnalysisEvent {
  return {
    type: "CheckpointJudgement",
    eventId: `stable:tail:${sliderId}`,
    ruleset: "stable",
    time: sliderEndTime - 36,
    objectTime: sliderEndTime - 36,
    judgementTime: sliderEndTime - 36,
    sliderEndTime,
    checkpointId: `${sliderId}/last`,
    sliderId,
    checkpointType: "LAST_LEGACY_TICK",
    hit: false,
    isLastTick: true,
    position,
  };
}

function sliderBreak(
  eventId: string,
  sliderId: string,
  objectTime: number,
  judgementTime: number,
): Extract<ReplayAnalysisEvent, { type: "SliderBreak" }> {
  return {
    type: "SliderBreak",
    eventId,
    ruleset: "stable",
    time: objectTime,
    objectTime,
    judgementTime,
    position,
    sliderId,
    componentId: `${sliderId}:head`,
    componentType: "HEAD",
  };
}

const gameplayInfo: GameplayInfo = {
  accuracy: 0.94,
  verdictCounts: [120, 7, 3, 2],
  score: 0,
  currentCombo: 18,
  maxComboSoFar: 246,
};

describe("live replay statistics", () => {
  it.each(["HEAD", "TICK", "REPEAT"] as const)(
    "does not also count a missed Stable end after a %s sliderbreak",
    (componentType) => {
      const events: ReplayAnalysisEvent[] = [
        stableTailMiss("broken", 300),
        { ...sliderBreak("break:broken", "broken", 100, 140), componentType },
      ];
      const breaks = stableSliderBreakResolutionTimes(events);
      const misses = sliderMissResolutionTimes(events);

      expect(misses.stableSliderEnd).toEqual([]);
      expect(liveReplayStatsAt(gameplayInfo, breaks, 139, "stable", 812, misses)).toMatchObject({
        sliderBreakCount: 0,
        sliderEndMissCount: 0,
      });
      expect(liveReplayStatsAt(gameplayInfo, breaks, 300, "stable", 812, misses)).toMatchObject({
        sliderBreakCount: 1,
        sliderEndMissCount: 0,
      });
    },
  );

  it("keeps separate sliderbreaks but only counts standalone ends on other sliders", () => {
    const events: ReplayAnalysisEvent[] = [
      stableTailMiss("broken", 300),
      sliderBreak("break:broken:head", "broken", 100, 140),
      sliderBreak("break:broken:repeat", "broken", 200, 200),
      stableTailMiss("tail-only", 300),
      stableTailMiss("tail-only", 300),
      stableTailMiss("later-tail-only", 500),
    ];
    const breaks = stableSliderBreakResolutionTimes(events);
    const misses = sliderMissResolutionTimes(events);

    expect(breaks).toEqual([140, 200]);
    expect(misses.stableSliderEnd).toEqual([300, 500]);
    expect(liveReplayStatsAt(gameplayInfo, breaks, 299, "stable", 812, misses).sliderEndMissCount).toBe(0);
    expect(liveReplayStatsAt(gameplayInfo, breaks, 300, "stable", 812, misses)).toMatchObject({
      sliderBreakCount: 2,
      sliderEndMissCount: 1,
    });
    expect(liveReplayStatsAt(gameplayInfo, breaks, Infinity, "stable", 812, misses)).toMatchObject({
      sliderBreakCount: 2,
      sliderEndMissCount: 2,
    });
  });

  it("covers a legacy-tail miss when the same slider breaks after that checkpoint", () => {
    const tail = stableTailMiss("short-ending", 300);
    const events = [tail, sliderBreak("break:late-repeat", "short-ending", 290, 290)];
    expect(sliderMissResolutionTimes(events).stableSliderEnd).toEqual([]);
  });

  it("uses judgement resolution time for cumulative Stable sliderbreaks", () => {
    const times = stableSliderBreakResolutionTimes([
      sliderBreak("sb:a", "slider-a", 100, 140),
      sliderBreak("sb:b", "slider-b", 200, 260),
    ]);

    expect(times).toEqual([140, 260]);
    expect(liveReplayStatsAt(gameplayInfo, times, 139, "stable", 812)).toMatchObject({
      count100: 7,
      count50: 3,
      countMiss: 2,
      sliderBreakCount: 0,
      maxComboSoFar: 246,
      mapMaxCombo: 812,
    });
    expect(liveReplayStatsAt(gameplayInfo, times, 200, "stable", 812).sliderBreakCount).toBe(1);
    expect(liveReplayStatsAt(gameplayInfo, times, 300, "stable", 812).sliderBreakCount).toBe(2);
  });

  it("omits SB entirely in lazer while keeping live hit and combo values", () => {
    expect(liveReplayStatsAt(gameplayInfo, [140], 300, "lazer", 900)).toEqual({
      count100: 7,
      count50: 3,
      countMiss: 2,
      sliderBreakCount: undefined,
      sliderEndMissCount: 0,
      sliderTickMissCount: 0,
      maxComboSoFar: 246,
      mapMaxCombo: 900,
    });
  });

  it("counts Stable legacy tail misses separately from native lazer tick and SliderEnd misses", () => {
    const times = sliderMissResolutionTimes([
      // Identical slider IDs in a Stable stream must not suppress native lazer outcomes.
      sliderBreak("break:lazer", "lazer", 100, 140),
      {
        type: "CheckpointJudgement",
        eventId: "stable:tail",
        ruleset: "stable",
        time: 180,
        objectTime: 180,
        judgementTime: 180,
        sliderEndTime: 200,
        checkpointId: "stable/last",
        sliderId: "stable",
        checkpointType: "LAST_LEGACY_TICK",
        hit: false,
        isLastTick: true,
        position,
      },
      {
        type: "SliderComponentMiss",
        eventId: "lazer:tick",
        ruleset: "lazer",
        time: 240,
        objectTime: 230,
        judgementTime: 240,
        sliderId: "lazer",
        componentId: "lazer/tick",
        componentType: "TICK",
        position,
      },
      {
        type: "SliderComponentMiss",
        eventId: "lazer:end",
        ruleset: "lazer",
        time: 280,
        objectTime: 270,
        judgementTime: 280,
        sliderId: "lazer",
        componentId: "lazer/TAIL",
        componentType: "TAIL",
        position,
      },
    ]);

    expect(liveReplayStatsAt(gameplayInfo, [], 199, "stable", 812, times)).toMatchObject({
      sliderEndMissCount: 0,
      sliderTickMissCount: undefined,
    });
    expect(liveReplayStatsAt(gameplayInfo, [], 200, "stable", 812, times)).toMatchObject({
      sliderEndMissCount: 1,
      sliderTickMissCount: undefined,
    });
    expect(liveReplayStatsAt(gameplayInfo, [], 260, "lazer", 812, times)).toMatchObject({
      sliderTickMissCount: 1,
      sliderEndMissCount: 0,
    });
    expect(liveReplayStatsAt(gameplayInfo, [], 300, "lazer", 812, times)).toMatchObject({
      sliderTickMissCount: 1,
      sliderEndMissCount: 1,
    });
  });

  it("keeps both live and completed maximum combo reconstructed", () => {
    expect(liveReplayStatsAt(gameplayInfo, [], 200, "stable", 812).maxComboSoFar).toBe(246);
    expect(liveReplayStatsAt({ ...gameplayInfo, maxComboSoFar: 200 }, [], 150, "stable", 812).maxComboSoFar).toBe(200);
    expect(liveReplayStatsAt(gameplayInfo, [], Number.POSITIVE_INFINITY, "stable", 812).maxComboSoFar).toBe(246);
  });

  it("counts all resolved slider statistics in a completed snapshot", () => {
    expect(
      liveReplayStatsAt(gameplayInfo, [140, 260], Number.POSITIVE_INFINITY, "stable", 812, {
        stableSliderEnd: [180, 280],
        lazerSliderTick: [],
        lazerSliderEnd: [],
      }),
    ).toMatchObject({ sliderBreakCount: 2, sliderEndMissCount: 2 });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "normalizes an invalid or zero maximum %s",
    (maxComboSoFar) => {
      expect(liveReplayStatsAt({ ...gameplayInfo, maxComboSoFar }, [], 200, "stable", 812).maxComboSoFar).toBe(0);
    },
  );

  it("does not count a component SB when the same slider resolves as a whole-slider Miss", () => {
    const events: ReplayAnalysisEvent[] = [
      sliderBreak("sb:missed", "slider-missed", 100, 140),
      {
        type: "HitObjectJudgement",
        eventId: "miss:slider-missed",
        ruleset: "stable",
        time: 220,
        objectTime: 100,
        judgementTime: 220,
        position,
        verdict: "MISS",
        hitObjectId: "slider-missed",
      },
    ];

    expect(stableSliderBreakResolutionTimes(events)).toEqual([]);
  });
});
