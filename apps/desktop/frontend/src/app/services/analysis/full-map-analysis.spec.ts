import { defaultGameState, HitCircle, retrieveEvents } from "@osujs/core";
import type {
  HitCircleMissReason,
  CheckpointJudgement,
  HitObjectJudgement,
  MainHitObjectVerdict,
  SliderBreak,
  SliderComponentMiss,
} from "@osujs/core";
import { analyzeFullMap, ROLLING_UR_HIT_WINDOW } from "./full-map-analysis";

const position = { x: 256, y: 192 };

function judgement(
  hitObjectId: string,
  verdict: MainHitObjectVerdict,
  time: number,
  options: {
    sliderHead?: boolean;
    ruleset?: "stable" | "lazer";
    notelock?: boolean;
    missReason?: HitCircleMissReason;
  } = {},
): HitObjectJudgement {
  const ruleset = options.ruleset ?? "stable";
  return {
    type: "HitObjectJudgement",
    eventId: `${ruleset}:hit-object-judgement:${hitObjectId}`,
    ruleset,
    time,
    objectTime: time,
    judgementTime: time,
    hitObjectId,
    verdict,
    missReason: options.missReason,
    isSliderHead: options.sliderHead,
    notelockCause: options.notelock
      ? ruleset === "lazer"
        ? {
            kind: "LAZER_BLOCKED_VALID_PRESS",
            targetHitObjectId: hitObjectId,
            blockerHitObjectId: "blocking-object",
            pressTime: time - 10,
            cursorDistance: 0,
            objectRadius: 64,
            wouldHaveHit: "GREAT",
          }
        : {
            kind: "STABLE_BLOCKED_VALID_PRESS",
            targetHitObjectId: hitObjectId,
            blockerHitObjectId: "blocking-object",
            pressTime: time - 10,
            cursorDistance: 0,
            objectRadius: 64,
            wouldHaveHit: "GREAT",
          }
      : undefined,
    position,
  };
}

function sliderBreak(componentId: string, time: number): SliderBreak {
  return {
    type: "SliderBreak",
    eventId: `stable:slider-break:${componentId}`,
    ruleset: "stable",
    time,
    objectTime: time,
    judgementTime: time,
    sliderId: componentId.split("/")[0],
    componentId,
    componentType: componentId.endsWith("HEAD") ? "HEAD" : "TICK",
    position,
  };
}

function sliderComponentMiss(componentId: string, time: number): SliderComponentMiss {
  return {
    type: "SliderComponentMiss",
    eventId: `lazer:slider-component-miss:${componentId}`,
    ruleset: "lazer",
    time,
    objectTime: time,
    judgementTime: time,
    sliderId: componentId.split("/")[0],
    componentId,
    componentType: componentId.endsWith("TAIL") ? "TAIL" : "TICK",
    position,
  };
}

function stableTailMiss(sliderId: string, time: number): CheckpointJudgement {
  return {
    type: "CheckpointJudgement",
    eventId: `stable:checkpoint-judgement:${sliderId}/last`,
    ruleset: "stable",
    time: time - 36,
    objectTime: time - 36,
    judgementTime: time - 36,
    sliderEndTime: time,
    checkpointId: `${sliderId}/last`,
    sliderId,
    checkpointType: "LAST_LEGACY_TICK",
    hit: false,
    isLastTick: true,
    position,
  };
}

describe("analyzeFullMap", () => {
  it("counts Stable broken sliders only as breaks and keeps standalone ends on distinct sliders", () => {
    const summary = analyzeFullMap({
      events: [
        stableTailMiss("broken", 6_000),
        sliderBreak("broken/HEAD", 1_000),
        sliderBreak("broken/0", 2_000),
        stableTailMiss("tail-only", 6_000),
        // Re-emission of the same checkpoint must not inflate the end count.
        stableTailMiss("tail-only", 6_000),
        stableTailMiss("later-tail-only", 16_000),
      ],
      hits: [],
      duration: 30_000,
      baseRate: 1,
    });

    expect(summary.sliderMisses).toEqual({ sliderEndMissCount: 2 });
    expect(summary.errors).toEqual({ missCount: 0, notelockMissCount: 0, sliderBreakCount: 2, total: 2 });
    expect(summary.timing.thirds.reduce((count, third) => count + (third.sliderBreakCount ?? 0), 0)).toBe(2);
    expect(summary.weakSections).toHaveLength(1);
    expect(summary.weakSections[0].headline).toBe("2 sliderbreaks");
  });

  it("reports Stable counts, accuracy, explicit sliderbreaks, and beatmap-time timing", () => {
    const firstBreak = sliderBreak("4/HEAD", 41_000);
    const summary = analyzeFullMap({
      events: [
        judgement("0", "GREAT", 10_000),
        judgement("1", "OK", 20_000),
        judgement("2", "MEH", 30_000),
        judgement("3", "MISS", 40_000),
        // Stable nested heads are sliderbreak evidence, not a second main notelock miss.
        judgement("4/HEAD", "MISS", 41_000, { sliderHead: true, notelock: true }),
        judgement("lazer-0", "GREAT", 12_000, { ruleset: "lazer" }),
        firstBreak,
        firstBreak,
        sliderBreak("5/0", 50_000),
      ],
      hits: [
        [10_000, -15, true],
        [20_000, 0, true],
        [30_000, 15, true],
        // Miss offsets can be force-kill timings and must not affect timing statistics.
        [40_000, 300, false],
      ],
      duration: 60_000,
      baseRate: 1.5,
    });

    expect(summary.judgements).toEqual({
      count300: 1,
      count100: 1,
      count50: 1,
      countMiss: 1,
      total: 4,
    });
    expect(summary.accuracy).toBeCloseTo(0.375);
    expect(summary.errors).toEqual({ missCount: 1, notelockMissCount: 0, sliderBreakCount: 2, total: 3 });
    expect(summary.timing.sampleCount).toBe(3);
    expect(summary.timing.samples.map((sample) => sample.offsetMs)).toEqual([-15, 0, 15]);
    expect(summary.timing.meanOffsetMs).toBeCloseTo(0);
    expect(summary.timing.unstableRate).toBeCloseTo(122.474487, 5);
    expect(summary.timing.bias).toBe("neutral");
    expect(summary.timing.distribution).toEqual({
      p10Ms: -12,
      medianMs: 0,
      p90Ms: 12,
      centerThresholdMs: 10,
      earlyCount: 1,
      centerCount: 1,
      lateCount: 1,
      totalCount: 3,
    });
    expect(summary.aimConsistency.available).toBe(false);
  });

  it("uses Lazer main counts and native weighted accuracy while omitting SB", () => {
    const summary = analyzeFullMap({
      ruleset: "lazer",
      events: [
        judgement("stable-only", "GREAT", 5_000),
        judgement("slider/HEAD", "OK", 10_000, { sliderHead: true, ruleset: "lazer" }),
        judgement("circle", "MISS", 20_000, { ruleset: "lazer" }),
        judgement("spinner", "GREAT", 25_000, { ruleset: "lazer" }),
        sliderBreak("slider/0", 15_000),
        sliderComponentMiss("slider/TICK", 12_000),
        sliderComponentMiss("slider/TAIL", 14_000),
        // Duplicate emissions must not inflate the native component count.
        sliderComponentMiss("slider/TAIL", 14_000),
      ],
      hits: [
        [10_000, 8, true],
        [20_000, 300, false],
      ],
      duration: 30_000,
      baseRate: 1,
      aggregateAccuracyInput: 0.9875,
      objectCoverage: {
        totalObjectCount: 3,
        excludedSpinnerCount: 0,
        unsupportedObjectCount: 0,
      },
    });

    expect(summary.ruleset).toBe("lazer");
    expect(summary.accuracy).toBe(0.9875);
    expect(summary.judgements).toEqual({ count300: 1, count100: 1, count50: 0, countMiss: 1, total: 3 });
    expect(summary.errors).toEqual({
      missCount: 1,
      notelockMissCount: 0,
      sliderComponentMissCount: 2,
      total: 3,
    });
    expect(summary.sliderMisses).toEqual({ sliderTickMissCount: 1, sliderEndMissCount: 1 });
    expect(summary.timing.thirds.every((third) => third.sliderBreakCount === undefined)).toBe(true);
    expect(summary.timing.thirds.reduce((count, third) => count + (third.sliderComponentMissCount ?? 0), 0)).toBe(2);
    expect(summary.weakSections.every((section) => section.sliderBreakCount === undefined)).toBe(true);
    expect(summary.weakSections[0].headline).toContain("2 slider component misses");
    expect(summary.coverage).toEqual({
      analyzedObjectCount: 3,
      totalObjectCount: 3,
      excludedSpinnerCount: 0,
      unsupportedObjectCount: 0,
      complete: true,
      reason: "All supplied beatmap objects are represented by reconstructed judgements.",
    });
  });

  it("uses authoritative aggregate counts for the summary without inventing event locations", () => {
    const summary = analyzeFullMap({
      events: [judgement("reconstructed-ok", "OK", 10_000), judgement("reconstructed-miss", "MISS", 20_000)],
      hits: [],
      duration: 30_000,
      baseRate: 1,
      aggregateAccuracyInput: (732 * 300 + 55 * 100 + 5 * 50) / (804 * 300),
      aggregateJudgementCountsInput: [732, 55, 5, 12],
      objectCoverage: { totalObjectCount: 804 },
    });

    expect(summary.judgements).toEqual({
      count300: 732,
      count100: 55,
      count50: 5,
      countMiss: 12,
      total: 804,
    });
    expect(summary.errors).toEqual({ missCount: 12, notelockMissCount: 0, sliderBreakCount: 0, total: 12 });
    expect(summary.coverage.analyzedObjectCount).toBe(804);
    expect(summary.timing.thirds.reduce((total, third) => total + third.missCount, 0)).toBe(1);
    expect(summary.weakSections.reduce((total, section) => total + section.missCount, 0)).toBe(1);
  });

  it("does not count component sliderbreaks for a slider that resolved as a MISS", () => {
    const summary = analyzeFullMap({
      events: [judgement("8", "MISS", 15_000), sliderBreak("8/HEAD", 14_000), sliderBreak("8/0", 14_500)],
      hits: [],
      duration: 30_000,
      baseRate: 1,
    });

    expect(summary.errors).toEqual({ missCount: 1, notelockMissCount: 0, sliderBreakCount: 0, total: 1 });
    expect(summary.weakSections).toHaveLength(1);
    expect(summary.weakSections[0].headline).toBe("1 miss");
  });

  it("counts proven notelock misses as a subset of main misses", () => {
    const stable = analyzeFullMap({
      events: [judgement("notelocked", "MISS", 10_000, { notelock: true }), judgement("ordinary", "MISS", 20_000)],
      hits: [],
      duration: 30_000,
      baseRate: 1,
    });
    const lazer = analyzeFullMap({
      ruleset: "lazer",
      events: [
        judgement("blocked-valid-press", "MISS", 10_000, {
          notelock: true,
          ruleset: "lazer",
          missReason: "TIME_EXPIRED",
        }),
        judgement("ordered-policy-force-miss", "MISS", 15_000, {
          ruleset: "lazer",
          missReason: "ORDERED_POLICY_FORCE_MISS",
        }),
        judgement("ordinary", "MISS", 20_000, { ruleset: "lazer" }),
      ],
      hits: [],
      duration: 30_000,
      baseRate: 1,
    });

    expect(stable.errors).toMatchObject({ missCount: 2, notelockMissCount: 1, total: 2 });
    expect(lazer.errors).toMatchObject({ missCount: 3, notelockMissCount: 1, total: 3 });
  });

  it("excludes an ordered-policy former-object force miss from the lazer counter end to end", () => {
    const former = new HitCircle();
    former.id = "former";
    former.hitTime = 10_000;
    former.position = { x: 128, y: 192 };
    const genuinelyNotelocked = new HitCircle();
    genuinelyNotelocked.id = "genuinely-notelocked";
    genuinelyNotelocked.hitTime = 11_000;
    genuinelyNotelocked.position = { x: 384, y: 192 };
    const state = defaultGameState();
    state.hitCircleVerdict[former.id] = {
      type: "MISS",
      missReason: "ORDERED_POLICY_FORCE_MISS",
      judgementTime: 10_500,
    };
    state.lazerNotelockEvidence[former.id] = {
      targetHitObjectId: former.id,
      blockerHitObjectId: "stale-blocker",
      pressTime: 9_900,
      cursorDistance: 0,
      objectRadius: 64,
      wouldHaveHit: "GREAT",
    };
    state.hitCircleVerdict[genuinelyNotelocked.id] = {
      type: "MISS",
      missReason: "TIME_EXPIRED",
      judgementTime: 11_150,
    };
    state.lazerNotelockEvidence[genuinelyNotelocked.id] = {
      targetHitObjectId: genuinelyNotelocked.id,
      blockerHitObjectId: former.id,
      pressTime: 10_950,
      cursorDistance: 0,
      objectRadius: 64,
      wouldHaveHit: "GREAT",
    };

    const summary = analyzeFullMap({
      ruleset: "lazer",
      events: retrieveEvents(state, [former, genuinelyNotelocked], "lazer"),
      hits: [],
      duration: 20_000,
      baseRate: 1,
      aggregateJudgementCountsInput: [0, 0, 0, 2],
    });

    expect(summary.errors).toMatchObject({ missCount: 2, notelockMissCount: 1, total: 2 });
  });

  it("never reports more notelock misses than the authoritative main-miss total", () => {
    const summary = analyzeFullMap({
      events: [judgement("reconstruction-only", "MISS", 10_000, { notelock: true })],
      hits: [],
      duration: 30_000,
      baseRate: 1,
      aggregateJudgementCountsInput: [1, 0, 0, 0],
    });

    expect(summary.errors).toMatchObject({ missCount: 0, notelockMissCount: 0, total: 0 });
  });

  it("describes a conservative deterioration trend across map thirds", () => {
    const summary = analyzeFullMap({
      events: [],
      hits: [
        [5_000, -2, true],
        [10_000, 0, true],
        [15_000, 2, true],
        [35_000, -8, true],
        [40_000, 0, true],
        [45_000, 8, true],
        [65_000, -20, true],
        [70_000, 0, true],
        [75_000, 20, true],
      ],
      duration: 90_000,
      baseRate: 1,
    });

    expect(summary.timing.thirds.map((third) => third.sampleCount)).toEqual([3, 3, 3]);
    expect(summary.timing.thirds[0].unstableRate).toBeLessThan(summary.timing.thirds[1].unstableRate as number);
    expect(summary.timing.thirds[1].unstableRate).toBeLessThan(summary.timing.thirds[2].unstableRate as number);
    expect(summary.timing.trend).toBe("deteriorating");
    expect(summary.timing.openingToEndingUrChange).toBeGreaterThan(100);
  });

  it("reports a material middle-third consistency spike as mixed rather than stable", () => {
    const summary = analyzeFullMap({
      events: [],
      hits: [
        [5_000, -1, true],
        [10_000, 0, true],
        [15_000, 1, true],
        [35_000, -30, true],
        [40_000, 0, true],
        [45_000, 30, true],
        [65_000, -1, true],
        [70_000, 0, true],
        [75_000, 1, true],
      ],
      duration: 90_000,
      baseRate: 1,
    });

    expect(summary.timing.thirds[1].unstableRate).toBeGreaterThan(
      (summary.timing.thirds[0].unstableRate as number) * 20,
    );
    expect(summary.timing.openingToEndingUrChange).toBeCloseTo(0);
    expect(summary.timing.trend).toBe("mixed");
  });

  it("reports compact hit-error percentiles and per-third judgement quality", () => {
    const summary = analyzeFullMap({
      events: [
        judgement("0", "GREAT", 5_000),
        judgement("1", "OK", 10_000),
        judgement("2", "MISS", 15_000),
        sliderBreak("3/0", 20_000),
        judgement("3", "GREAT", 35_000),
        judgement("4", "GREAT", 40_000),
        judgement("5", "OK", 45_000),
        judgement("6", "GREAT", 65_000),
        judgement("7", "GREAT", 70_000),
        judgement("8", "GREAT", 75_000),
      ],
      hits: [
        [5_000, -30, true],
        [10_000, -10, true],
        [35_000, 0, true],
        [40_000, 10, true],
        [65_000, 30, true],
      ],
      duration: 90_000,
      baseRate: 1,
    });

    expect(summary.timing.distribution).toEqual({
      p10Ms: -22,
      medianMs: 0,
      p90Ms: 22,
      centerThresholdMs: 10,
      earlyCount: 1,
      centerCount: 3,
      lateCount: 1,
      totalCount: 5,
    });
    expect(summary.timing.thirds[0]).toMatchObject({
      judgementCount: 3,
      accuracy: 4 / 9,
      errorCount: 2,
      errorRate: 2 / 3,
      missCount: 1,
      sliderBreakCount: 1,
    });
    expect(summary.timing.thirds[1]).toMatchObject({
      judgementCount: 3,
      accuracy: 7 / 9,
      errorCount: 1,
      errorRate: 1 / 3,
      missCount: 0,
      sliderBreakCount: 0,
    });
    expect(summary.timing.thirds[2]).toMatchObject({
      judgementCount: 3,
      accuracy: 1,
      errorCount: 0,
      errorRate: 0,
      missCount: 0,
      sliderBreakCount: 0,
    });
  });

  it("reports supplied object coverage without guessing missing metadata", () => {
    const summary = analyzeFullMap({
      events: [judgement("0", "GREAT", 1_000), judgement("1", "OK", 2_000)],
      hits: [],
      duration: 10_000,
      baseRate: 1,
      objectCoverage: {
        totalObjectCount: 5,
        excludedSpinnerCount: 2,
        unsupportedObjectCount: 1,
      },
    });

    expect(summary.coverage).toEqual({
      analyzedObjectCount: 2,
      totalObjectCount: 5,
      excludedSpinnerCount: 2,
      unsupportedObjectCount: 1,
      complete: false,
      reason: "Excluded objects are reported separately and are not included in reconstructed accuracy.",
    });

    const unknownCoverage = analyzeFullMap({ events: [], hits: [], duration: 0, baseRate: 1 }).coverage;
    expect(unknownCoverage).toEqual({
      analyzedObjectCount: 0,
      totalObjectCount: null,
      excludedSpinnerCount: null,
      unsupportedObjectCount: null,
      complete: null,
      reason: "Beatmap object totals were not supplied; only reconstructed judgements are counted.",
    });
  });

  it("returns only the three strongest weak time sections", () => {
    const sectionMisses = [
      judgement("miss-1", "MISS", 21_000),
      judgement("miss-2", "MISS", 22_000),
      judgement("miss-3", "MISS", 23_000),
    ];
    const firstBreak = sliderBreak("break-1/0", 51_000);
    const secondBreak = sliderBreak("break-2/0", 52_000);
    const lowJudgements = [
      judgement("meh-1", "MEH", 81_000),
      judgement("meh-2", "MEH", 82_000),
      judgement("ok-1", "OK", 83_000),
    ];

    const summary = analyzeFullMap({
      events: [
        ...sectionMisses,
        firstBreak,
        firstBreak,
        secondBreak,
        ...lowJudgements,
        judgement("ok-2", "OK", 101_000),
      ],
      hits: [],
      duration: 120_000,
      baseRate: 1,
    });

    expect(summary.weakSections).toHaveLength(3);
    expect(summary.weakSections.map((section) => section.startTime)).toEqual([20_000, 50_000, 80_000]);
    expect(summary.weakSections.map((section) => section.headline)).toEqual([
      "3 misses",
      "2 sliderbreaks",
      "2×50, 1×100",
    ]);
  });

  it("reports unavailable data rather than manufacturing conclusions", () => {
    const summary = analyzeFullMap({
      events: [],
      hits: [[1_000, 5, true]],
      duration: Number.NaN,
      baseRate: 0,
    });

    expect(summary.duration).toBe(0);
    expect(summary.accuracy).toBeNull();
    expect(summary.timing).toMatchObject({
      available: false,
      unavailableReason: "invalid-base-rate",
      sampleCount: 0,
      meanOffsetMs: null,
      unstableRate: null,
      bias: "unavailable",
      trend: "insufficient-data",
    });
    expect(summary.weakSections).toEqual([]);
    expect(summary.aimConsistency).toEqual({
      available: false,
      sampleCount: 0,
      eligibleEventCount: 0,
      coverage: null,
      meanDistancePx: null,
      p90DistancePx: null,
      meanRadiusFraction: null,
      reason: "Replay/beatmap cursor evidence was not supplied.",
    });
  });

  it("summarizes only explicitly assigned successful aim evidence", () => {
    const summary = analyzeFullMap({
      events: [judgement("0", "GREAT", 1_000), judgement("1", "MISS", 2_000)],
      hits: [],
      duration: 3_000,
      baseRate: 1,
      aimEvidence: {
        eligibleEventCount: 2,
        samples: [
          { hitObjectId: "0", time: 1_000, distance: 10, objectRadius: 50 },
          { hitObjectId: "head", time: 1_500, distance: 30, objectRadius: 50 },
        ],
      },
    });

    expect(summary.aimConsistency).toMatchObject({
      available: true,
      sampleCount: 2,
      eligibleEventCount: 2,
      coverage: 1,
      meanDistancePx: 20,
      p90DistancePx: 28,
      meanRadiusFraction: 0.4,
    });
  });

  it("exposes one canonical lazer real-time sample set for UR, bias, cumulative average UR, and the histogram", () => {
    const summary = analyzeFullMap({
      ruleset: "lazer",
      events: [],
      hits: [
        [3_000, 30, true],
        [1_000, -20, true],
        [2_000, 999, false],
        [Number.NaN, 5, true],
        [4_000, Number.NaN, true],
        [0, 0, true],
      ],
      duration: 9_600,
      baseRate: 2,
    });

    expect(summary.timing.samples).toEqual([
      { time: 0, offsetMs: 0 },
      { time: 1_000, offsetMs: -10 },
      { time: 3_000, offsetMs: 15 },
    ]);
    expect(summary.timing.sampleCount).toBe(summary.timing.samples.length);
    expect(summary.timing.meanOffsetMs).toBeCloseTo(5 / 3);
    expect(summary.timing.standardDeviationMs).toBeCloseTo(Math.sqrt(950 / 9));
    expect(summary.timing.unstableRate).toBeCloseTo((summary.timing.standardDeviationMs as number) * 10);
    expect(summary.timing.earlyPercentage).toBeCloseTo(1 / 2);
    expect(summary.timing.latePercentage).toBeCloseTo(1 / 2);
    expect(summary.timing.urOverTime).toHaveLength(2);
    expect(summary.timing.urOverTime[0]).toMatchObject({ time: 1_000, sampleCount: 2, unstableRate: 50 });
    expect(summary.timing.peakUr).toEqual(summary.timing.urOverTime[1]);
    expect(summary.timing.averageUr).toHaveLength(2);
    expect(summary.timing.averageUr[0]).toMatchObject({ time: 1_000, sampleCount: 2, unstableRate: 50 });
    expect(summary.timing.peakAverageUr).toEqual(summary.timing.averageUr[1]);

    expect(summary.timing.histogram).toMatchObject({ binWidthMs: 1, extentMs: 15 });
    expect(summary.timing.histogram.bins).toHaveLength(31);
    expect(
      summary.timing.histogram.bins.filter((bin) => bin.count > 0).map((bin) => [bin.centerMs, bin.count]),
    ).toEqual([
      [-10, 1],
      [0, 1],
      [15, 1],
    ]);
    expect(summary.timing.histogram.bins.reduce((total, bin) => total + bin.count, 0)).toBe(
      summary.timing.samples.length,
    );
  });

  it("keeps 1 ms histogram detail across legal offsets and caps extreme input without losing samples", () => {
    const legalRange = analyzeFullMap({
      events: [],
      hits: [
        [0, -199, true],
        [1, 199, true],
      ],
      duration: 1_000,
      baseRate: 1,
    });
    const extremeRange = analyzeFullMap({
      events: [],
      hits: [
        [0, -1_000, true],
        [1, 1_000, true],
      ],
      duration: 1_000,
      baseRate: 1,
    });

    expect(legalRange.timing.histogram).toMatchObject({ binWidthMs: 1, extentMs: 199 });
    expect(legalRange.timing.histogram.bins).toHaveLength(399);
    expect(extremeRange.timing.histogram).toMatchObject({ binWidthMs: 5, extentMs: 1_000 });
    expect(extremeRange.timing.histogram.bins).toHaveLength(401);
    expect(extremeRange.timing.histogram.bins.reduce((total, bin) => total + bin.count, 0)).toBe(
      extremeRange.timing.samples.length,
    );
  });

  it("normalizes Early and Late percentages across directional hits only", () => {
    const directional = analyzeFullMap({
      events: [],
      hits: [
        [0, -10, true],
        [1, 0, true],
        [2, 20, true],
        [3, 30, true],
      ],
      duration: 4,
      baseRate: 1,
    });
    const centered = analyzeFullMap({
      events: [],
      hits: [[0, 0, true]],
      duration: 1,
      baseRate: 1,
    });

    expect(directional.timing.earlyPercentage).toBeCloseTo(1 / 3);
    expect(directional.timing.latePercentage).toBeCloseTo(2 / 3);
    expect((directional.timing.earlyPercentage as number) + (directional.timing.latePercentage as number)).toBeCloseTo(
      1,
    );
    expect(centered.timing.earlyPercentage).toBeNull();
    expect(centered.timing.latePercentage).toBeNull();
  });

  it("emits cumulative population average UR from the second hit", () => {
    const summary = analyzeFullMap({
      events: [],
      hits: Array.from({ length: 31 }, (_, index) => [index, index, true] as const),
      duration: 31,
      baseRate: 1,
    });

    expect(summary.timing.averageUr).toHaveLength(30);
    expect(summary.timing.averageUr[0]).toEqual({ time: 1, unstableRate: 5, sampleCount: 2 });
    expect(summary.timing.averageUr[29].sampleCount).toBe(31);
    expect(summary.timing.averageUr[29].unstableRate).toBeCloseTo(Math.sqrt(80) * 10);
    expect(summary.timing.peakAverageUr?.time).toBe(30);
    expect(summary.timing.peakAverageUr?.sampleCount).toBe(31);
  });

  it("emits local UR from a trailing 50-hit window instead of the cumulative map average", () => {
    const hits = Array.from({ length: 100 }, (_, index) => {
      const magnitude = index < ROLLING_UR_HIT_WINDOW ? 1 : 10;
      return [index, index % 2 === 0 ? -magnitude : magnitude, true] as const;
    });
    const summary = analyzeFullMap({ events: [], hits, duration: 100, baseRate: 1 });

    expect(summary.timing.urOverTime).toHaveLength(99);
    expect(summary.timing.urOverTime[0]).toEqual({ time: 1, unstableRate: 10, sampleCount: 2 });
    expect(summary.timing.urOverTime[48]).toEqual({ time: 49, unstableRate: 10, sampleCount: 50 });
    expect(summary.timing.urOverTime[98]).toEqual({ time: 99, unstableRate: 100, sampleCount: 50 });
    expect(summary.timing.peakUr).toEqual({ time: 99, unstableRate: 100, sampleCount: 50 });
    expect(summary.timing.averageUr[98]).toMatchObject({ time: 99, sampleCount: 100 });
    expect(summary.timing.averageUr[98].unstableRate).toBeCloseTo(Math.sqrt(50.5) * 10);
  });

  it("reports zero UR for one eligible hit while leaving empty data and trend charts unavailable", () => {
    const empty = analyzeFullMap({ events: [], hits: [], duration: 1_000, baseRate: 1 });
    const oneHit = analyzeFullMap({ events: [], hits: [[500, -4, true]], duration: 1_000, baseRate: 1 });

    expect(empty.timing.urOverTime).toEqual([]);
    expect(empty.timing.peakUr).toBeNull();
    expect(empty.timing.unstableRate).toBeNull();
    expect(oneHit.timing.unstableRate).toBe(0);
    expect(oneHit.timing.standardDeviationMs).toBe(0);
    expect(oneHit.timing.sampleCount).toBe(1);
    expect(oneHit.timing.averageUr).toEqual([]);
    expect(oneHit.timing.urOverTime).toEqual([]);
    expect(oneHit.timing.peakUr).toBeNull();
  });

  it("uses the supplied object start without shifting timing data or other analysis", () => {
    const input = {
      events: [judgement("first", "MISS", 1_000), judgement("later", "GREAT", 10_000)],
      hits: [
        [995, -5, true],
        [1_000, 0, true],
        [1_099.999, -2, true],
        [1_100, 3, true],
        [10_599.999, -1, true],
        [10_600, 0, true],
        [10_610, 10, true],
        [1_200, 200, false],
      ] as [number, number, boolean][],
      duration: 10_600,
      baseRate: 1.5,
    };
    const unshifted = analyzeFullMap(input);
    const shifted = analyzeFullMap({ ...input, startTime: 1_000 });

    expect(shifted.startTime).toBe(1_000);
    expect(shifted.duration).toBe(10_600);
    expect(shifted.timing.samples).toHaveLength(7);
    expect({
      ...shifted,
      startTime: unshifted.startTime,
    }).toEqual(unshifted);
  });

  it("keeps an object-based start when every object missed and no timing samples exist", () => {
    const summary = analyzeFullMap({
      events: [judgement("first", "MISS", 5_000)],
      hits: [[5_200, 200, false]],
      startTime: 5_000,
      duration: 14_600,
      baseRate: 1,
    });

    expect(summary.startTime).toBe(5_000);
    expect(summary.timing.samples).toEqual([]);
    expect(summary.timing.urOverTime).toEqual([]);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "defaults an absent or invalid chart start %s to zero",
    (startTime) => {
      const summary = analyzeFullMap({ events: [], hits: [], startTime, duration: 9_600, baseRate: 1 });
      expect(summary.startTime).toBe(0);
    },
  );

  it.each([1_000, 2_000])("keeps a degenerate chart start %s finite and preserves timing samples", (startTime) => {
    const summary = analyzeFullMap({
      events: [],
      hits: [
        [990, -10, true],
        [1_010, 10, true],
      ],
      startTime,
      duration: 1_000,
      baseRate: 1,
    });
    expect(summary.startTime).toBe(1_000);
    expect(summary.timing.samples).toEqual([
      { time: 990, offsetMs: -10 },
      { time: 1_010, offsetMs: 10 },
    ]);
    expect(summary.timing.unstableRate).toBe(100);
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, -1])("normalizes empty or invalid chart ends %s", (duration) => {
    const summary = analyzeFullMap({ events: [], hits: [], startTime: 1_000, duration, baseRate: 1 });
    expect(summary.startTime).toBe(0);
    expect(summary.duration).toBe(0);
  });
});
