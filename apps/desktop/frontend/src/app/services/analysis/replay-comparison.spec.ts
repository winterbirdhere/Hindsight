import { HitObjectJudgement, OsuAction, ReplayAnalysisEvent, ReplayButtonState, ReplayFrame } from "@osujs/core";
import type { OsuReplay } from "../../model/OsuReplay";
import {
  calculateSynchronizedCursorSeparation,
  compareReplayParticipants,
  createReplayComparisonParticipant,
  summarizePhysicalReplayInputs,
  validateReplayComparisonCompatibility,
} from "./replay-comparison";

function statistics(maxCombo = 0, score = 0): NonNullable<OsuReplay["statistics"]> {
  return {
    count300: 0,
    count100: 0,
    count50: 0,
    countMiss: 0,
    maxCombo,
    score,
    perfectCombo: false,
  };
}

function replay(overrides: Partial<OsuReplay> = {}): OsuReplay {
  return {
    md5hash: "replay",
    beatmapMd5: "beatmap-hash",
    gameMode: 0,
    gameVersion: 20240101,
    mods: [],
    player: "Player",
    frames: [],
    statistics: statistics(),
    ...overrides,
  };
}

function frame(time: number, x: number, y: number, rawButtonMask: ReplayButtonState): ReplayFrame {
  const actions: OsuAction[] = [];
  if ((rawButtonMask & (ReplayButtonState.Left1 | ReplayButtonState.Left2)) !== 0) {
    actions.push(OsuAction.leftButton);
  }
  if ((rawButtonMask & (ReplayButtonState.Right1 | ReplayButtonState.Right2)) !== 0) {
    actions.push(OsuAction.rightButton);
  }
  return { time, position: { x, y }, actions, rawButtonMask };
}

function judgement(
  hitObjectId: string,
  objectTime: number,
  judgementTime: number,
  verdict: HitObjectJudgement["verdict"],
  isSliderHead = false,
  ruleset: "stable" | "lazer" = "stable",
): HitObjectJudgement {
  return {
    type: "HitObjectJudgement",
    eventId: `${ruleset}:hit-object-judgement:${hitObjectId}`,
    ruleset,
    time: judgementTime,
    objectTime,
    judgementTime,
    hitObjectId,
    verdict,
    isSliderHead,
    position: { x: objectTime, y: 0 },
  };
}

function sliderBreak(componentId: string, time: number): ReplayAnalysisEvent {
  return {
    type: "SliderBreak",
    eventId: `stable:slider-break:${componentId}`,
    ruleset: "stable",
    time,
    objectTime: time,
    judgementTime: time,
    sliderId: "slider",
    componentId,
    componentType: "TICK",
    position: { x: 0, y: 0 },
  };
}

describe("validateReplayComparisonCompatibility", () => {
  it("verifies two osu!standard replays on the same map, mods and rate", () => {
    const result = validateReplayComparisonCompatibility(replay(), replay({ md5hash: "secondary" }));

    expect(result).toMatchObject({
      canCompare: true,
      verified: true,
      sameBeatmap: true,
      standardRuleset: true,
      sameMods: true,
      sameRate: true,
      sameCoordinateTransform: true,
      issues: [],
    });
  });

  it("blocks unknown/non-standard rulesets and different beatmaps", () => {
    const primary = replay({ gameMode: undefined });
    const secondary = replay({ gameMode: 1, beatmapMd5: "different-hash" });
    const result = validateReplayComparisonCompatibility(primary, secondary);

    expect(result.canCompare).toBe(false);
    expect(result.standardRuleset).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["RULESET_UNKNOWN", "UNSUPPORTED_RULESET", "BEATMAP_MISMATCH"]),
    );
  });

  it("keeps same-map comparison available while surfacing mod, rate and coordinate caveats", () => {
    const primary = replay();
    const secondary = replay({ mods: ["HARD_ROCK", "DOUBLE_TIME"] });
    const result = validateReplayComparisonCompatibility(primary, secondary);

    expect(result.canCompare).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.sameRate).toBe(false);
    expect(result.sameCoordinateTransform).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "MOD_SET_MISMATCH",
      "RATE_MISMATCH",
      "COORDINATE_TRANSFORM_MISMATCH",
    ]);
  });

  it("compares native settings independent of JSON field order", () => {
    const primary = replay({
      mods: ["DOUBLE_TIME"],
      lazerMods: [
        { acronym: "DA", settings: { circle_size: 4, approach_rate: 9 } },
        { acronym: "DT", settings: { adjust_pitch: false, speed_change: 1.2 } },
      ],
    });
    const secondary = replay({
      mods: ["DOUBLE_TIME"],
      lazerMods: [
        { acronym: "DT", settings: { speed_change: 1.2, adjust_pitch: false } },
        { acronym: "DA", settings: { approach_rate: 9, circle_size: 4 } },
      ],
    });
    expect(validateReplayComparisonCompatibility(primary, secondary)).toMatchObject({
      verified: true,
      primaryRate: 1.2,
      secondaryRate: 1.2,
      issues: [],
    });
  });

  it("reports different custom rates and DA geometry without blocking same-map comparisons", () => {
    const primary = replay({
      mods: ["DOUBLE_TIME"],
      lazerMods: [
        { acronym: "DT", settings: { speed_change: 1.2 } },
        { acronym: "DA", settings: { circle_size: 4 } },
      ],
    });
    const secondary = replay({
      mods: ["DOUBLE_TIME"],
      lazerMods: [
        { acronym: "DT", settings: { speed_change: 1.7 } },
        { acronym: "DA", settings: { circle_size: 6 } },
      ],
    });
    const result = validateReplayComparisonCompatibility(primary, secondary);
    expect(result).toMatchObject({
      canCompare: true,
      verified: false,
      sameMods: true,
      sameRate: false,
      sameCoordinateTransform: false,
      primaryRate: 1.2,
      secondaryRate: 1.7,
    });
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "MOD_SETTINGS_MISMATCH",
      "RATE_MISMATCH",
      "COORDINATE_TRANSFORM_MISMATCH",
    ]);
  });

  it("includes native-only mods and Classic options in compatibility", () => {
    const classic = replay({ lazerMods: [{ acronym: "CL" }] });
    expect(validateReplayComparisonCompatibility(replay(), classic).sameMods).toBe(false);
    expect(
      validateReplayComparisonCompatibility(
        classic,
        replay({ lazerMods: [{ acronym: "CL", settings: { classic_note_lock: false } }] }),
      ).issues.map((issue) => issue.code),
    ).toEqual(["MOD_SETTINGS_MISMATCH"]);
  });

  it("does not resurrect stale legacy bits when native metadata is authoritative", () => {
    const nativeNoMod = replay({ mods: ["HARD_ROCK", "DOUBLE_TIME"], lazerMods: [] });
    expect(validateReplayComparisonCompatibility(nativeNoMod, replay())).toMatchObject({
      verified: true,
      primaryRate: 1,
      sameCoordinateTransform: true,
      sameMods: true,
    });
    const difficultyAdjust = replay({ lazerMods: [{ acronym: "DA" }] });
    const incompatibleNative = replay({ lazerMods: [{ acronym: "DA" }, { acronym: "HR" }] });
    expect(validateReplayComparisonCompatibility(difficultyAdjust, incompatibleNative)).toMatchObject({
      verified: true,
      sameCoordinateTransform: true,
      sameMods: true,
    });
  });
});

describe("native comparison participant metadata", () => {
  it("retains custom rate and owns a copy of native settings", () => {
    const source = replay({
      mods: ["HALF_TIME"],
      lazerMods: [{ acronym: "HT", settings: { speed_change: 0.6 } }],
    });
    const participant = createReplayComparisonParticipant({ id: "native", replay: source, events: [] });
    expect(participant.baseRate).toBe(0.6);
    expect(participant.lazerMods).toEqual(source.lazerMods);
    expect(participant.lazerMods?.[0].settings).not.toBe(source.lazerMods?.[0].settings);
  });

  it("excludes Classic component heads from main accuracy judgements and timing comparisons", () => {
    const source = replay({ lazerMods: [{ acronym: "CL" }] });
    const events = [
      { ...judgement("slider/HEAD", 100, 110, "GREAT", true, "lazer"), affectsAccuracy: false },
      judgement("slider", 200, 200, "GREAT", false, "lazer"),
    ];
    const participant = createReplayComparisonParticipant({ id: "native", replay: source, events });
    const result = compareReplayParticipants(participant, participant, { ruleset: "lazer" });
    expect(result.joinedJudgements.map((event) => event.hitObjectId)).toEqual(["slider"]);
    expect(result.primarySummary.counts.total).toBe(1);
  });
});

describe("compareReplayParticipants", () => {
  it("joins main-object judgements, summarizes score inputs and computes frame-derived metrics", () => {
    const primaryFrames = [
      frame(0, 0, 0, ReplayButtonState.None),
      frame(10, 10, 0, ReplayButtonState.Left1 | ReplayButtonState.Left2),
      frame(30, 30, 0, ReplayButtonState.None),
    ];
    const secondaryFrames = [
      frame(0, 0, 3, ReplayButtonState.None),
      frame(10, 10, 3, ReplayButtonState.Right1 | ReplayButtonState.Right2),
      frame(20, 20, 3, ReplayButtonState.None),
      frame(30, 30, 3, ReplayButtonState.None),
    ];
    const primaryEvents: ReplayAnalysisEvent[] = [
      judgement("slider/HEAD", 50, 50, "GREAT", true),
      judgement("A", 100, 105, "GREAT"),
      judgement("B", 200, 210, "OK"),
      judgement("C", 300, 450, "MISS"),
      sliderBreak("slider/0", 250),
    ];
    const secondaryEvents: ReplayAnalysisEvent[] = [
      judgement("A", 100, 107, "GREAT"),
      judgement("B", 200, 207, "MEH"),
      judgement("D", 400, 400, "GREAT"),
      sliderBreak("slider/0", 250),
      sliderBreak("slider/1", 350),
    ];
    const primary = createReplayComparisonParticipant({
      id: "primary",
      replay: replay({
        player: "Primary",
        frames: primaryFrames,
        statistics: statistics(123, 1_000_000),
      }),
      events: primaryEvents,
    });
    const secondary = createReplayComparisonParticipant({
      id: "secondary",
      replay: replay({
        player: "Secondary",
        frames: secondaryFrames,
        statistics: statistics(222, 1_500_000),
      }),
      events: secondaryEvents,
    });

    const result = compareReplayParticipants(primary, secondary, {
      timingToleranceMs: 0.5,
      cursorSampleIntervalMs: 10,
    });

    expect(result.compatibility.verified).toBe(true);
    expect(result.primarySummary).toEqual({
      counts: { count300: 1, count100: 1, count50: 0, countMiss: 1, total: 3 },
      accuracy: 4 / 9,
      maxComboInput: 123,
      scoreInput: 1_000_000,
      sliderBreakCount: 1,
    });
    expect(result.secondarySummary).toEqual({
      counts: { count300: 2, count100: 0, count50: 1, countMiss: 0, total: 3 },
      accuracy: 650 / 900,
      maxComboInput: 222,
      scoreInput: 1_500_000,
      sliderBreakCount: 2,
    });
    expect(result.summaryDelta.maxComboInput).toBe(99);
    expect(result.summaryDelta.scoreInput).toBe(500_000);
    expect(result.summaryDelta.sliderBreakCount).toBe(1);

    expect(result.differences.map((difference) => difference.hitObjectId)).toEqual(["A", "B", "C", "D"]);
    expect(result.differences[0]).toMatchObject({
      differenceKinds: ["timing"],
      primaryTimingOffsetMs: 5,
      secondaryTimingOffsetMs: 7,
      timingDeltaMs: 2,
    });
    expect(result.differences[1].differenceKinds).toEqual(["verdict", "timing"]);
    expect(result.differences[2].differenceKinds).toEqual(["presence"]);
    expect(result.differences[3].differenceKinds).toEqual(["presence"]);
    expect(result.differenceCounts).toEqual({ presence: 2, verdict: 1, timing: 2 });
    expect(result.sliderBreakDifferences).toEqual([
      expect.objectContaining({ componentId: "slider/1", differenceKinds: ["presence"] }),
    ]);

    expect(result.physicalInputs.primary.perButton.K1).toMatchObject({
      intervalCount: 1,
      mapTimeHoldDurationMs: 20,
      realTimeHoldDurationMs: 20,
    });
    expect(result.physicalInputs.primary.perButton.M1.intervalCount).toBe(0);
    expect(result.physicalInputs.secondary.perButton.K2.mapTimeHoldDurationMs).toBe(10);
    expect(result.physicalInputs.deltas.K2.intervalCount).toBe(1);

    expect(result.cursorSeparation).toMatchObject({
      available: true,
      sampleCount: 4,
      meanDistance: 3,
      rootMeanSquareDistance: 3,
      percentile95Distance: 3,
      maxDistance: 3,
      coordinateComparable: true,
      realTimeComparable: true,
    });
  });

  it("uses native Lazer aggregates and compares slider heads and spinners without SB", () => {
    const primary = createReplayComparisonParticipant({
      id: "lazer-primary",
      replay: replay({ player: "Primary", statistics: statistics(999, 1_000_000) }),
      events: [
        judgement("slider/HEAD", 100, 100, "GREAT", true, "lazer"),
        judgement("spinner", 300, 300, "GREAT", false, "lazer"),
        sliderBreak("stable-only", 200),
      ],
      verdictCountsInput: [7, 2, 1, 3],
      accuracyInput: 0.8125,
      maxComboInput: 42,
    });
    const secondary = createReplayComparisonParticipant({
      id: "lazer-secondary",
      replay: replay({ md5hash: "secondary", player: "Secondary", statistics: statistics(888, 900_000) }),
      events: [
        judgement("slider/HEAD", 100, 110, "OK", true, "lazer"),
        judgement("spinner", 300, 300, "MISS", false, "lazer"),
        sliderBreak("another-stable-only", 250),
      ],
      verdictCountsInput: [5, 4, 2, 2],
      accuracyInput: 0.725,
      maxComboInput: 31,
    });

    const result = compareReplayParticipants(primary, secondary, { ruleset: "lazer" });

    expect(result.ruleset).toBe("lazer");
    expect(result.primarySummary).toMatchObject({
      counts: { count300: 7, count100: 2, count50: 1, countMiss: 3, total: 13 },
      accuracy: 0.8125,
      maxComboInput: 42,
      sliderBreakCount: 0,
    });
    expect(result.secondarySummary).toMatchObject({
      counts: { count300: 5, count100: 4, count50: 2, countMiss: 2, total: 13 },
      accuracy: 0.725,
      maxComboInput: 31,
      sliderBreakCount: 0,
    });
    expect(result.differences.map((difference) => difference.hitObjectId)).toEqual(["slider/HEAD", "spinner"]);
    expect(result.joinedSliderBreaks).toEqual([]);
    expect(result.sliderBreakDifferences).toEqual([]);
    expect(result.summaryDelta.sliderBreakCount).toBe(0);
  });
});

describe("frame-derived comparison helpers", () => {
  it("clamps an interval still held at the final frame instead of counting the open-ended sentinel", () => {
    const metrics = summarizePhysicalReplayInputs(
      [
        frame(0, 0, 0, ReplayButtonState.Left1 | ReplayButtonState.Left2),
        frame(100, 0, 0, ReplayButtonState.Left1 | ReplayButtonState.Left2),
      ],
      2,
    );

    expect(metrics.perButton.K1).toEqual({
      intervalCount: 1,
      mapTimeHoldDurationMs: 100,
      realTimeHoldDurationMs: 50,
    });
    expect(metrics.totalMapTimeHoldDurationMs).toBe(100);
  });

  it("summarizes very long frame arrays without spreading them into function arguments", () => {
    const frames = Array.from({ length: 150_000 }, (_, index) => frame(index, index, 0, ReplayButtonState.None));

    const metrics = summarizePhysicalReplayInputs(frames, 1);

    expect(metrics).toMatchObject({
      available: true,
      replayStartTime: 0,
      replayEndTime: 149_999,
      totalIntervalCount: 0,
    });
  });

  it("treats Lazer-exported 1/2 masks as logical K1/K2 input instead of physical M1/M2", () => {
    const metrics = summarizePhysicalReplayInputs(
      [
        frame(0, 0, 0, ReplayButtonState.None),
        frame(10, 0, 0, ReplayButtonState.Left1),
        frame(20, 0, 0, ReplayButtonState.Left1 | ReplayButtonState.Right1),
        frame(30, 0, 0, ReplayButtonState.Right1),
        frame(40, 0, 0, ReplayButtonState.None),
      ],
      1,
      30_000_016,
    );

    expect(metrics.source).toBe("lazer-logical");
    expect(metrics.perButton.K1).toMatchObject({ intervalCount: 1, mapTimeHoldDurationMs: 20 });
    expect(metrics.perButton.K2).toMatchObject({ intervalCount: 1, mapTimeHoldDurationMs: 20 });
    expect(metrics.perButton.M1).toMatchObject({ intervalCount: 0, mapTimeHoldDurationMs: 0 });
    expect(metrics.perButton.M2).toMatchObject({ intervalCount: 0, mapTimeHoldDurationMs: 0 });
  });

  it("preserves logical input provenance for a confirmed Lazer replay in a legacy wrapper", () => {
    const source = Object.assign(
      replay({ frames: [frame(0, 0, 0, ReplayButtonState.Left1), frame(10, 0, 0, ReplayButtonState.None)] }),
      { sourceClient: "lazer", sourceProvenance: "user-confirmed" } as const,
    );
    const participant = createReplayComparisonParticipant({ id: "confirmed", replay: source, events: [] });
    const result = compareReplayParticipants(participant, { ...participant, id: "other" });
    expect(participant.gameVersion).toBe(20240101);
    expect(result.physicalInputs.primary.source).toBe("lazer-logical");
    expect(result.physicalInputs.primary.perButton.K1.intervalCount).toBe(1);
    expect(result.physicalInputs.primary.perButton.M1.intervalCount).toBe(0);
  });

  it("uses exact zero-delta Lazer frames when comparison metrics close a logical press", () => {
    const mergedRelease = frame(10, 0, 0, ReplayButtonState.Left1);
    mergedRelease.sourceFramesAtSameTime = [
      frame(10, 0, 0, ReplayButtonState.Left1),
      frame(10, 0, 0, ReplayButtonState.None),
    ];
    const primary = createReplayComparisonParticipant({
      id: "lazer-primary",
      replay: replay({
        gameVersion: 30_000_016,
        frames: [frame(0, 0, 0, ReplayButtonState.Left1), mergedRelease, frame(20, 0, 0, ReplayButtonState.None)],
      }),
      events: [],
    });
    const secondary = createReplayComparisonParticipant({
      id: "lazer-secondary",
      replay: replay({
        md5hash: "secondary",
        gameVersion: 30_000_016,
        frames: [frame(0, 0, 0, ReplayButtonState.None), frame(20, 0, 0, ReplayButtonState.None)],
      }),
      events: [],
    });

    const result = compareReplayParticipants(primary, secondary);

    expect(primary.gameVersion).toBe(30_000_016);
    expect(result.physicalInputs.primary.source).toBe("lazer-logical");
    expect(result.physicalInputs.primary.perButton.K1).toMatchObject({
      intervalCount: 1,
      mapTimeHoldDurationMs: 10,
    });
    expect(result.physicalInputs.primary.perButton.M1.intervalCount).toBe(0);
  });

  it("reports cursor metrics as unavailable when frame time ranges do not overlap", () => {
    const metrics = calculateSynchronizedCursorSeparation(
      [frame(0, 0, 0, ReplayButtonState.None), frame(10, 0, 0, ReplayButtonState.None)],
      [frame(20, 0, 0, ReplayButtonState.None), frame(30, 0, 0, ReplayButtonState.None)],
    );

    expect(metrics).toMatchObject({
      available: false,
      unavailableReason: "no-overlapping-time",
      sampleCount: 0,
    });
  });

  it("keeps identical cursor trajectories aligned before and after a same-time position jump", () => {
    const primary = [
      frame(0, 0, 0, ReplayButtonState.None),
      frame(100, 0, 0, ReplayButtonState.None),
      frame(100, 100, 0, ReplayButtonState.None),
      frame(200, 100, 0, ReplayButtonState.None),
    ];
    const secondary = [
      primary[0],
      frame(50, 0, 0, ReplayButtonState.None),
      primary[1],
      primary[2],
      frame(150, 100, 0, ReplayButtonState.None),
      primary[3],
    ];

    expect(calculateSynchronizedCursorSeparation(primary, secondary, { sampleIntervalMs: 25 })).toMatchObject({
      available: true,
      sampleCount: 9,
      meanDistance: 0,
      maxDistance: 0,
    });
  });

  it("does not interpolate synchronized cursor metrics across an excluded interval", () => {
    const metrics = calculateSynchronizedCursorSeparation(
      [frame(0, 0, 0, ReplayButtonState.None), frame(400, 0, 0, ReplayButtonState.None)],
      [
        frame(0, 0, 0, ReplayButtonState.None),
        frame(100, 0, 0, ReplayButtonState.None),
        frame(300, 300, 0, ReplayButtonState.None),
        frame(400, 0, 0, ReplayButtonState.None),
      ],
      {
        sampleIntervalMs: 50,
        secondaryExcludedRanges: [{ startTime: 200, endTime: 250, reason: "spinner" }],
      },
    );

    expect(metrics).toMatchObject({
      available: true,
      sampleCount: 6,
      meanDistance: 75,
      maxDistance: 300,
      maxDistanceTime: 300,
    });
  });
});
