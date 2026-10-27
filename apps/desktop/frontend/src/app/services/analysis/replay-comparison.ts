import {
  calculateReplayButtonIntervals,
  HitObjectJudgement,
  LazerMod,
  MainHitObjectVerdict,
  OsuClassicMod,
  PHYSICAL_REPLAY_BUTTONS,
  PhysicalReplayButton,
  ReplayAnalysisEvent,
  ReplayAnalysisRuleset,
  ReplayButtonEncoding,
  ReplayFrame,
  replayButtonEncodingForGameVersion,
  resolveLazerModSettings,
  SliderBreak,
} from "@osujs/core";
import type { Position } from "@osujs/math";
import { legacyModsFromLazerMods, OsuReplay, replayButtonEncoding, replayClockRate } from "../../model/OsuReplay";

export type ComparisonParticipantKind = "replay" | "autoplay-reference";

export interface ComparisonParticipantLimitation {
  code: string;
  message: string;
  objectIds?: readonly string[];
  time?: number;
}

/**
 * A map-time interval where a cursor source deliberately has no defensible
 * trajectory. The interval is inclusive so renderers and metrics do not
 * accidentally reconnect samples through either boundary.
 */
export interface CursorExcludedTimeRange {
  startTime: number;
  endTime: number;
  reason?: string;
  objectId?: string;
}

/**
 * A ruleset-neutral input for the pure comparison layer. Rendering and loading
 * remain separate concerns: callers can supply independently simulated events
 * without giving this module ownership of a GameSimulator or GameplayClock.
 */
export interface ReplayComparisonParticipant {
  id: string;
  label: string;
  kind: ComparisonParticipantKind;
  beatmapMd5: string;
  gameMode?: number;
  /** Original container version, retained for metadata and fallback decoding. */
  gameVersion?: number;
  buttonEncoding?: ReplayButtonEncoding;
  mods: readonly OsuClassicMod[];
  lazerMods?: readonly LazerMod[];
  baseRate: number;
  cursorFrames: readonly ReplayFrame[];
  /** Intervals which must not be interpolated across or rendered. */
  cursorExcludedRanges?: readonly CursorExcludedTimeRange[];
  /** Undefined means that physical-input comparison is intentionally unavailable. */
  inputFrames?: readonly ReplayFrame[];
  events: readonly ReplayAnalysisEvent[];
  /** Native aggregate main-result counts when event-derived counts are incomplete. */
  verdictCountsInput?: readonly number[];
  /** Native weighted accuracy, including supported nested score components. */
  accuracyInput?: number | null;
  /** Header or simulator input. Main-object judgements cannot reconstruct max combo reliably. */
  maxComboInput?: number | null;
  /** Header score when available; null means the participant does not claim one. */
  scoreInput?: number | null;
  limitations?: readonly ComparisonParticipantLimitation[];
}

export interface CreateReplayComparisonParticipantOptions {
  id: string;
  replay: OsuReplay;
  events: readonly ReplayAnalysisEvent[];
  verdictCountsInput?: readonly number[];
  accuracyInput?: number | null;
  label?: string;
  maxComboInput?: number | null;
  limitations?: readonly ComparisonParticipantLimitation[];
}

export function createReplayComparisonParticipant(
  options: CreateReplayComparisonParticipantOptions,
): ReplayComparisonParticipant {
  const { replay } = options;
  return {
    id: options.id,
    label: options.label ?? replay.player,
    kind: "replay",
    beatmapMd5: replay.beatmapMd5,
    gameMode: replay.gameMode,
    gameVersion: replay.gameVersion,
    buttonEncoding: replayButtonEncoding(replay),
    mods: [...replay.mods],
    lazerMods: replay.lazerMods?.map((mod) => ({
      ...mod,
      settings: mod.settings ? (canonicalValue(mod.settings) as Readonly<Record<string, unknown>>) : undefined,
    })),
    baseRate: replayClockRate(replay),
    cursorFrames: replay.frames,
    inputFrames: replay.frames,
    events: options.events,
    verdictCountsInput: options.verdictCountsInput ? [...options.verdictCountsInput] : undefined,
    accuracyInput: options.accuracyInput,
    maxComboInput: options.maxComboInput !== undefined ? options.maxComboInput : replay.statistics?.maxCombo ?? null,
    scoreInput: replay.statistics?.score ?? null,
    limitations: options.limitations ?? [],
  };
}

export type CompatibilityIssueSeverity = "error" | "warning";
export type CompatibilityParticipantSide = "primary" | "secondary" | "both";

export type ReplayComparisonCompatibilityIssueCode =
  | "RULESET_UNKNOWN"
  | "UNSUPPORTED_RULESET"
  | "BEATMAP_HASH_MISSING"
  | "BEATMAP_MISMATCH"
  | "MOD_SET_MISMATCH"
  | "MOD_SETTINGS_MISMATCH"
  | "INVALID_RATE"
  | "RATE_MISMATCH"
  | "COORDINATE_TRANSFORM_MISMATCH";

export interface ReplayComparisonCompatibilityIssue {
  code: ReplayComparisonCompatibilityIssueCode;
  severity: CompatibilityIssueSeverity;
  participant: CompatibilityParticipantSide;
  message: string;
}

export interface ReplayComparisonCompatibility {
  /** Hard requirements (known osu!standard and the same non-empty beatmap MD5). */
  canCompare: boolean;
  /** True only when no compatibility caveat remains. */
  verified: boolean;
  sameBeatmap: boolean;
  standardRuleset: boolean;
  sameMods: boolean;
  sameRate: boolean;
  sameCoordinateTransform: boolean;
  primaryRate: number | null;
  secondaryRate: number | null;
  issues: ReplayComparisonCompatibilityIssue[];
}

interface CompatibilitySource {
  beatmapMd5: string;
  gameMode?: number;
  mods: readonly OsuClassicMod[];
  lazerMods?: readonly LazerMod[];
  baseRate?: number;
}

function normalizedMods(source: CompatibilitySource): string[] {
  if (source.lazerMods === undefined) return Array.from(new Set(source.mods)).sort();
  const nativeNames = source.lazerMods.flatMap((mod) => {
    const legacy = legacyModsFromLazerMods([mod]);
    return legacy.length ? legacy : [mod.acronym];
  });
  // Match the builder's DA precedence over its incompatible HR/EZ mods.
  const names = source.lazerMods.some((mod) => mod.acronym === "DA")
    ? nativeNames.filter((name) => name !== "HARD_ROCK" && name !== "EASY")
    : nativeNames;
  return Array.from(new Set(names)).sort();
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function nativeSettingsKey(mods: readonly LazerMod[] = []): string {
  return JSON.stringify(
    mods
      .filter((mod) => mod.settings && Object.keys(mod.settings).length > 0)
      .map((mod) => [mod.acronym, canonicalValue(mod.settings)])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

function effectiveRate(source: CompatibilitySource): number | null {
  const rate = source.baseRate ?? replayClockRate({ mods: [...source.mods], lazerMods: source.lazerMods });
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function sameNumber(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) < 1e-9;
}

/**
 * Validates only what the current replay model can prove. Mod, clock-rate and
 * Hard Rock coordinate differences are surfaced as warnings so a caller must
 * choose whether a particular comparison metric remains meaningful.
 */
export function validateReplayComparisonCompatibility(
  primary: CompatibilitySource,
  secondary: CompatibilitySource,
): ReplayComparisonCompatibility {
  const issues: ReplayComparisonCompatibilityIssue[] = [];

  for (const [participant, source] of [
    ["primary", primary],
    ["secondary", secondary],
  ] as const) {
    if (source.gameMode === undefined) {
      issues.push({
        code: "RULESET_UNKNOWN",
        severity: "error",
        participant,
        message: `${participant === "primary" ? "Primary" : "Secondary"} replay ruleset is unknown`,
      });
    } else if (source.gameMode !== 0) {
      issues.push({
        code: "UNSUPPORTED_RULESET",
        severity: "error",
        participant,
        message: `${participant === "primary" ? "Primary" : "Secondary"} replay is not osu!standard`,
      });
    }

    if (!source.beatmapMd5.trim()) {
      issues.push({
        code: "BEATMAP_HASH_MISSING",
        severity: "error",
        participant,
        message: `${participant === "primary" ? "Primary" : "Secondary"} beatmap MD5 is missing`,
      });
    }
  }

  const sameBeatmap =
    primary.beatmapMd5.trim().length > 0 &&
    secondary.beatmapMd5.trim().length > 0 &&
    primary.beatmapMd5.toLowerCase() === secondary.beatmapMd5.toLowerCase();
  if (!sameBeatmap && primary.beatmapMd5.trim() && secondary.beatmapMd5.trim()) {
    issues.push({
      code: "BEATMAP_MISMATCH",
      severity: "error",
      participant: "both",
      message: "Replays belong to different beatmaps",
    });
  }

  const primaryMods = normalizedMods(primary);
  const secondaryMods = normalizedMods(secondary);
  const sameMods = primaryMods.join("|") === secondaryMods.join("|");
  if (!sameMods) {
    issues.push({
      code: "MOD_SET_MISMATCH",
      severity: "warning",
      participant: "both",
      message: `Mod sets differ (${primaryMods.join("+") || "NM"} vs ${secondaryMods.join("+") || "NM"})`,
    });
  }
  if (nativeSettingsKey(primary.lazerMods) !== nativeSettingsKey(secondary.lazerMods)) {
    issues.push({
      code: "MOD_SETTINGS_MISMATCH",
      severity: "warning",
      participant: "both",
      message: "Lazer mod settings differ; the replays may use different difficulty, rate, or Classic behavior",
    });
  }

  const primaryRate = effectiveRate(primary);
  const secondaryRate = effectiveRate(secondary);
  if (primaryRate === null) {
    issues.push({
      code: "INVALID_RATE",
      severity: "warning",
      participant: "primary",
      message: "Primary replay has an invalid effective clock rate",
    });
  }
  if (secondaryRate === null) {
    issues.push({
      code: "INVALID_RATE",
      severity: "warning",
      participant: "secondary",
      message: "Secondary replay has an invalid effective clock rate",
    });
  }

  const sameRate = sameNumber(primaryRate, secondaryRate);
  if (!sameRate && primaryRate !== null && secondaryRate !== null) {
    issues.push({
      code: "RATE_MISMATCH",
      severity: "warning",
      participant: "both",
      message: `Effective replay rates differ (${primaryRate.toFixed(2)}x vs ${secondaryRate.toFixed(2)}x)`,
    });
  }

  // DA CS and AR also influence stacked object positions through size/timing.
  const primaryDifficulty = resolveLazerModSettings(primary.lazerMods).difficultyAdjust;
  const secondaryDifficulty = resolveLazerModSettings(secondary.lazerMods).difficultyAdjust;
  const sameCoordinateTransform =
    primaryMods.includes("HARD_ROCK") === secondaryMods.includes("HARD_ROCK") &&
    primaryDifficulty?.circleSize === secondaryDifficulty?.circleSize &&
    primaryDifficulty?.approachRate === secondaryDifficulty?.approachRate;
  if (!sameCoordinateTransform) {
    issues.push({
      code: "COORDINATE_TRANSFORM_MISMATCH",
      severity: "warning",
      participant: "both",
      message: "Object position or stacking settings differ; raw cursor separation is not directly comparable",
    });
  }

  const standardRuleset = primary.gameMode === 0 && secondary.gameMode === 0;
  const canCompare = !issues.some((issue) => issue.severity === "error");
  return {
    canCompare,
    verified: canCompare && issues.length === 0,
    sameBeatmap,
    standardRuleset,
    sameMods,
    sameRate,
    sameCoordinateTransform,
    primaryRate,
    secondaryRate,
    issues,
  };
}

export interface ReplayJudgementCounts {
  count300: number;
  count100: number;
  count50: number;
  countMiss: number;
  total: number;
}

export interface ReplayComparisonParticipantSummary {
  counts: ReplayJudgementCounts;
  sliderBreakCount: number;
  accuracy: number | null;
  maxComboInput: number | null;
  scoreInput: number | null;
}

function mainJudgements(
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
): Map<string, HitObjectJudgement> {
  const sorted = events
    .filter(
      (event): event is HitObjectJudgement =>
        event.type === "HitObjectJudgement" &&
        event.affectsAccuracy !== false &&
        event.ruleset === ruleset &&
        (ruleset === "lazer" || !event.isSliderHead),
    )
    .slice()
    .sort(
      (a, b) =>
        (a.objectTime ?? a.time) - (b.objectTime ?? b.time) ||
        (a.judgementTime ?? a.time) - (b.judgementTime ?? b.time) ||
        a.hitObjectId.localeCompare(b.hitObjectId),
    );
  const byObject = new Map<string, HitObjectJudgement>();
  for (const judgement of sorted) {
    if (!byObject.has(judgement.hitObjectId)) byObject.set(judgement.hitObjectId, judgement);
  }
  return byObject;
}

function judgementCounts(judgements: Iterable<HitObjectJudgement>): ReplayJudgementCounts {
  const counts: ReplayJudgementCounts = { count300: 0, count100: 0, count50: 0, countMiss: 0, total: 0 };
  for (const judgement of judgements) {
    switch (judgement.verdict) {
      case "GREAT":
        counts.count300++;
        break;
      case "OK":
        counts.count100++;
        break;
      case "MEH":
        counts.count50++;
        break;
      case "MISS":
        counts.countMiss++;
        break;
    }
    counts.total++;
  }
  return counts;
}

function accuracy(counts: ReplayJudgementCounts): number | null {
  if (counts.total === 0) return null;
  return (counts.count300 * 300 + counts.count100 * 100 + counts.count50 * 50) / (counts.total * 300);
}

export function summarizeReplayComparisonParticipant(
  participant: ReplayComparisonParticipant,
  ruleset: ReplayAnalysisRuleset = "stable",
): ReplayComparisonParticipantSummary {
  const eventCounts = judgementCounts(mainJudgements(participant.events, ruleset).values());
  const aggregateCounts = participant.verdictCountsInput;
  const counts =
    aggregateCounts && aggregateCounts.length >= 4 && aggregateCounts.slice(0, 4).every(Number.isFinite)
      ? {
          count300: Math.max(0, Math.trunc(aggregateCounts[0])),
          count100: Math.max(0, Math.trunc(aggregateCounts[1])),
          count50: Math.max(0, Math.trunc(aggregateCounts[2])),
          countMiss: Math.max(0, Math.trunc(aggregateCounts[3])),
          total: aggregateCounts.slice(0, 4).reduce((total, count) => total + Math.max(0, Math.trunc(count)), 0),
        }
      : eventCounts;
  const sliderBreakCount = ruleset === "stable" ? stableSliderBreaks(participant.events).size : 0;
  const maxComboInput = participant.maxComboInput;
  const scoreInput = participant.scoreInput;
  return {
    counts,
    sliderBreakCount,
    accuracy:
      participant.accuracyInput !== undefined
        ? participant.accuracyInput !== null && Number.isFinite(participant.accuracyInput)
          ? participant.accuracyInput
          : null
        : accuracy(counts),
    maxComboInput:
      maxComboInput !== undefined && maxComboInput !== null && Number.isFinite(maxComboInput) ? maxComboInput : null,
    scoreInput: scoreInput !== undefined && scoreInput !== null && Number.isFinite(scoreInput) ? scoreInput : null,
  };
}

function stableSliderBreaks(events: readonly ReplayAnalysisEvent[]): Map<string, SliderBreak> {
  const result = new Map<string, SliderBreak>();
  for (const event of events) {
    if (event.type !== "SliderBreak" || event.ruleset !== "stable") continue;
    const id = `${event.sliderId}:${event.componentId}`;
    if (!result.has(id)) result.set(id, event);
  }
  return result;
}

export interface JoinedReplaySliderBreak {
  id: string;
  sliderId: string;
  componentId: string;
  objectTime: number;
  primary?: SliderBreak;
  secondary?: SliderBreak;
  timingDeltaMs: number | null;
  differenceKinds: Array<"presence" | "timing">;
}

function joinedSliderBreaks(
  primaryEvents: readonly ReplayAnalysisEvent[],
  secondaryEvents: readonly ReplayAnalysisEvent[],
  timingToleranceMs: number,
): JoinedReplaySliderBreak[] {
  const primary = stableSliderBreaks(primaryEvents);
  const secondary = stableSliderBreaks(secondaryEvents);
  const ids = new Set([...primary.keys(), ...secondary.keys()]);
  const joined: JoinedReplaySliderBreak[] = [];

  for (const id of ids) {
    const primaryBreak = primary.get(id);
    const secondaryBreak = secondary.get(id);
    const primaryTime = primaryBreak?.judgementTime ?? primaryBreak?.time;
    const secondaryTime = secondaryBreak?.judgementTime ?? secondaryBreak?.time;
    const timingDeltaMs = primaryTime !== undefined && secondaryTime !== undefined ? secondaryTime - primaryTime : null;
    const differenceKinds: Array<"presence" | "timing"> = [];
    if (!primaryBreak || !secondaryBreak) differenceKinds.push("presence");
    else if (timingDeltaMs !== null && Math.abs(timingDeltaMs) > timingToleranceMs) differenceKinds.push("timing");
    const sample = primaryBreak ?? (secondaryBreak as SliderBreak);
    joined.push({
      id,
      sliderId: sample.sliderId,
      componentId: sample.componentId,
      objectTime: sample.objectTime ?? sample.time,
      primary: primaryBreak,
      secondary: secondaryBreak,
      timingDeltaMs,
      differenceKinds,
    });
  }

  joined.sort((a, b) => a.objectTime - b.objectTime || a.id.localeCompare(b.id));
  return joined;
}

export type ReplayObjectDifferenceKind = "presence" | "verdict" | "timing";

export interface JoinedReplayJudgement {
  hitObjectId: string;
  objectTime: number;
  primary?: HitObjectJudgement;
  secondary?: HitObjectJudgement;
  primaryVerdict?: MainHitObjectVerdict;
  secondaryVerdict?: MainHitObjectVerdict;
  primaryTimingOffsetMs: number | null;
  secondaryTimingOffsetMs: number | null;
  /** Secondary offset minus primary offset. */
  timingDeltaMs: number | null;
  differenceKinds: ReplayObjectDifferenceKind[];
}

function finiteEventTime(event: HitObjectJudgement | undefined): number | null {
  if (!event) return null;
  const time = event.objectTime ?? event.time;
  return Number.isFinite(time) ? time : null;
}

function successfulTimingOffset(event: HitObjectJudgement | undefined): number | null {
  if (!event || event.verdict === "MISS") return null;
  const objectTime = event.objectTime;
  const judgementTime = event.judgementTime;
  if (objectTime === undefined || judgementTime === undefined) return null;
  const offset = judgementTime - objectTime;
  return Number.isFinite(offset) ? offset : null;
}

function joinedJudgements(
  primaryEvents: readonly ReplayAnalysisEvent[],
  secondaryEvents: readonly ReplayAnalysisEvent[],
  timingToleranceMs: number,
  ruleset: ReplayAnalysisRuleset,
): JoinedReplayJudgement[] {
  const primary = mainJudgements(primaryEvents, ruleset);
  const secondary = mainJudgements(secondaryEvents, ruleset);
  const ids = new Set([...primary.keys(), ...secondary.keys()]);
  const joined: JoinedReplayJudgement[] = [];

  for (const hitObjectId of ids) {
    const primaryJudgement = primary.get(hitObjectId);
    const secondaryJudgement = secondary.get(hitObjectId);
    const primaryTimingOffsetMs = successfulTimingOffset(primaryJudgement);
    const secondaryTimingOffsetMs = successfulTimingOffset(secondaryJudgement);
    const timingDeltaMs =
      primaryTimingOffsetMs !== null && secondaryTimingOffsetMs !== null
        ? secondaryTimingOffsetMs - primaryTimingOffsetMs
        : null;
    const differenceKinds: ReplayObjectDifferenceKind[] = [];

    if (!primaryJudgement || !secondaryJudgement) {
      differenceKinds.push("presence");
    } else {
      if (primaryJudgement.verdict !== secondaryJudgement.verdict) differenceKinds.push("verdict");
      if (timingDeltaMs !== null && Math.abs(timingDeltaMs) > timingToleranceMs) differenceKinds.push("timing");
    }

    const primaryObjectTime = finiteEventTime(primaryJudgement);
    const secondaryObjectTime = finiteEventTime(secondaryJudgement);
    const objectTime = primaryObjectTime ?? secondaryObjectTime ?? 0;
    joined.push({
      hitObjectId,
      objectTime,
      primary: primaryJudgement,
      secondary: secondaryJudgement,
      primaryVerdict: primaryJudgement?.verdict,
      secondaryVerdict: secondaryJudgement?.verdict,
      primaryTimingOffsetMs,
      secondaryTimingOffsetMs,
      timingDeltaMs,
      differenceKinds,
    });
  }

  joined.sort((a, b) => a.objectTime - b.objectTime || a.hitObjectId.localeCompare(b.hitObjectId));
  return joined;
}

export type PhysicalInputMetricSource = "raw-mask" | "logical-fallback" | "lazer-logical" | "mixed";

export interface PhysicalInputLaneMetrics {
  intervalCount: number;
  mapTimeHoldDurationMs: number;
  realTimeHoldDurationMs: number | null;
}

export interface PhysicalInputMetrics {
  available: boolean;
  unavailableReason: "not-provided" | "no-frames" | null;
  source: PhysicalInputMetricSource | null;
  replayStartTime: number | null;
  replayEndTime: number | null;
  perButton: Record<PhysicalReplayButton, PhysicalInputLaneMetrics>;
  totalIntervalCount: number;
  totalMapTimeHoldDurationMs: number;
  totalRealTimeHoldDurationMs: number | null;
}

function emptyLaneMetrics(): Record<PhysicalReplayButton, PhysicalInputLaneMetrics> {
  return {
    K1: { intervalCount: 0, mapTimeHoldDurationMs: 0, realTimeHoldDurationMs: null },
    K2: { intervalCount: 0, mapTimeHoldDurationMs: 0, realTimeHoldDurationMs: null },
    M1: { intervalCount: 0, mapTimeHoldDurationMs: 0, realTimeHoldDurationMs: null },
    M2: { intervalCount: 0, mapTimeHoldDurationMs: 0, realTimeHoldDurationMs: null },
  };
}

export function summarizePhysicalReplayInputs(
  frames: readonly ReplayFrame[] | undefined,
  baseRate: number,
  gameVersion?: number,
  encoding: ReplayButtonEncoding = replayButtonEncodingForGameVersion(gameVersion),
): PhysicalInputMetrics {
  const perButton = emptyLaneMetrics();
  if (frames === undefined) {
    return {
      available: false,
      unavailableReason: "not-provided",
      source: null,
      replayStartTime: null,
      replayEndTime: null,
      perButton,
      totalIntervalCount: 0,
      totalMapTimeHoldDurationMs: 0,
      totalRealTimeHoldDurationMs: null,
    };
  }

  const finiteFrames: ReplayFrame[] = [];
  let replayStartTime = Number.POSITIVE_INFINITY;
  let replayEndTime = Number.NEGATIVE_INFINITY;
  let rawFrameCount = 0;
  for (const frame of frames) {
    if (!Number.isFinite(frame.time)) continue;
    finiteFrames.push(frame);
    replayStartTime = Math.min(replayStartTime, frame.time);
    replayEndTime = Math.max(replayEndTime, frame.time);
    if (frame.rawButtonMask !== undefined) rawFrameCount++;
  }
  if (finiteFrames.length === 0) {
    return {
      available: false,
      unavailableReason: "no-frames",
      source: null,
      replayStartTime: null,
      replayEndTime: null,
      perButton,
      totalIntervalCount: 0,
      totalMapTimeHoldDurationMs: 0,
      totalRealTimeHoldDurationMs: null,
    };
  }

  const source: PhysicalInputMetricSource =
    encoding === "lazer-logical"
      ? "lazer-logical"
      : rawFrameCount === 0
      ? "logical-fallback"
      : rawFrameCount === finiteFrames.length
      ? "raw-mask"
      : "mixed";
  const intervals = calculateReplayButtonIntervals([...finiteFrames], encoding);
  const validRate = Number.isFinite(baseRate) && baseRate > 0;

  let totalIntervalCount = 0;
  let totalMapTimeHoldDurationMs = 0;
  for (const button of PHYSICAL_REPLAY_BUTTONS) {
    let holdDuration = 0;
    for (const [start, end] of intervals[button]) {
      const clampedStart = Math.max(replayStartTime, Math.min(replayEndTime, start));
      const clampedEnd = Math.max(replayStartTime, Math.min(replayEndTime, end));
      holdDuration += Math.max(0, clampedEnd - clampedStart);
    }
    perButton[button] = {
      intervalCount: intervals[button].length,
      mapTimeHoldDurationMs: holdDuration,
      realTimeHoldDurationMs: validRate ? holdDuration / baseRate : null,
    };
    totalIntervalCount += intervals[button].length;
    totalMapTimeHoldDurationMs += holdDuration;
  }

  return {
    available: true,
    unavailableReason: null,
    source,
    replayStartTime,
    replayEndTime,
    perButton,
    totalIntervalCount,
    totalMapTimeHoldDurationMs,
    totalRealTimeHoldDurationMs: validRate ? totalMapTimeHoldDurationMs / baseRate : null,
  };
}

export interface PhysicalInputLaneDelta {
  intervalCount: number | null;
  mapTimeHoldDurationMs: number | null;
  realTimeHoldDurationMs: number | null;
}

export interface PhysicalInputComparison {
  primary: PhysicalInputMetrics;
  secondary: PhysicalInputMetrics;
  /** Secondary minus primary. Null means at least one side was unavailable. */
  deltas: Record<PhysicalReplayButton, PhysicalInputLaneDelta>;
}

function inputDeltas(primary: PhysicalInputMetrics, secondary: PhysicalInputMetrics) {
  const deltas = {} as Record<PhysicalReplayButton, PhysicalInputLaneDelta>;
  for (const button of PHYSICAL_REPLAY_BUTTONS) {
    const primaryLane = primary.perButton[button];
    const secondaryLane = secondary.perButton[button];
    const available = primary.available && secondary.available;
    deltas[button] = {
      intervalCount: available ? secondaryLane.intervalCount - primaryLane.intervalCount : null,
      mapTimeHoldDurationMs: available ? secondaryLane.mapTimeHoldDurationMs - primaryLane.mapTimeHoldDurationMs : null,
      realTimeHoldDurationMs:
        available && primaryLane.realTimeHoldDurationMs !== null && secondaryLane.realTimeHoldDurationMs !== null
          ? secondaryLane.realTimeHoldDurationMs - primaryLane.realTimeHoldDurationMs
          : null,
    };
  }
  return deltas;
}

export interface CursorSeparationMetrics {
  available: boolean;
  unavailableReason: "primary-no-frames" | "secondary-no-frames" | "no-overlapping-time" | "no-valid-samples" | null;
  overlapStartTime: number | null;
  overlapEndTime: number | null;
  requestedSampleIntervalMs: number;
  effectiveSampleIntervalMs: number;
  sampleCount: number;
  meanDistance: number | null;
  rootMeanSquareDistance: number | null;
  percentile95Distance: number | null;
  maxDistance: number | null;
  maxDistanceTime: number | null;
  /** False means raw values are still returned but a transform caveat applies. */
  coordinateComparable: boolean;
  /** Map-time samples remain synchronized, but real-time interpretation differs when false. */
  realTimeComparable: boolean;
}

interface TimedPosition {
  time: number;
  position: Position;
}

interface NormalizedCursorExcludedTimeRange {
  startTime: number;
  endTime: number;
}

function normalizedCursorExcludedRanges(
  ranges: readonly CursorExcludedTimeRange[] | undefined,
): NormalizedCursorExcludedTimeRange[] {
  return (ranges ?? [])
    .filter((range) => Number.isFinite(range.startTime) && Number.isFinite(range.endTime))
    .map((range) => ({
      startTime: Math.min(range.startTime, range.endTime),
      endTime: Math.max(range.startTime, range.endTime),
    }))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

export function isCursorTimeExcluded(time: number, ranges: readonly CursorExcludedTimeRange[] | undefined): boolean {
  if (!Number.isFinite(time)) return true;
  return (ranges ?? []).some((range) => {
    if (!Number.isFinite(range.startTime) || !Number.isFinite(range.endTime)) return false;
    const startTime = Math.min(range.startTime, range.endTime);
    const endTime = Math.max(range.startTime, range.endTime);
    return time >= startTime && time <= endTime;
  });
}

/** True when joining two cursor samples would cross a deliberately unknown interval. */
export function cursorIntervalCrossesExcludedTime(
  firstTime: number,
  secondTime: number,
  ranges: readonly CursorExcludedTimeRange[] | undefined,
): boolean {
  const startTime = Math.min(firstTime, secondTime);
  const endTime = Math.max(firstTime, secondTime);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return true;
  return (ranges ?? []).some((range) => {
    if (!Number.isFinite(range.startTime) || !Number.isFinite(range.endTime)) return false;
    const excludedStart = Math.min(range.startTime, range.endTime);
    const excludedEnd = Math.max(range.startTime, range.endTime);
    return excludedStart < endTime && excludedEnd > startTime;
  });
}

function normalizedCursorFrames(frames: readonly ReplayFrame[]): TimedPosition[] {
  // Keep ordered same-time samples: interpolation approaches the first sample
  // at an upcoming timestamp and leaves from the final sample at that time.
  return frames
    .filter(
      (frame) => Number.isFinite(frame.time) && Number.isFinite(frame.position.x) && Number.isFinite(frame.position.y),
    )
    .map((frame) => ({ time: frame.time, position: frame.position }))
    .sort((a, b) => a.time - b.time);
}

function positionAt(
  frames: readonly TimedPosition[],
  time: number,
  excludedRanges: readonly NormalizedCursorExcludedTimeRange[],
): Position | undefined {
  if (frames.length === 0 || time < frames[0].time || time > frames[frames.length - 1].time) return undefined;
  if (isCursorTimeExcluded(time, excludedRanges)) return undefined;
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (frames[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  const left = frames[Math.max(0, low - 1)];
  const right = frames[Math.min(frames.length - 1, low)];
  if (left.time === time) return left.position;
  if (left.time === right.time) return left.position;
  if (
    isCursorTimeExcluded(left.time, excludedRanges) ||
    isCursorTimeExcluded(right.time, excludedRanges) ||
    cursorIntervalCrossesExcludedTime(left.time, right.time, excludedRanges)
  ) {
    return undefined;
  }
  const progress = (time - left.time) / (right.time - left.time);
  return {
    x: left.position.x + (right.position.x - left.position.x) * progress,
    y: left.position.y + (right.position.y - left.position.y) * progress,
  };
}

function unavailableCursorMetrics(
  reason: CursorSeparationMetrics["unavailableReason"],
  requestedSampleIntervalMs: number,
  coordinateComparable: boolean,
  realTimeComparable: boolean,
): CursorSeparationMetrics {
  return {
    available: false,
    unavailableReason: reason,
    overlapStartTime: null,
    overlapEndTime: null,
    requestedSampleIntervalMs,
    effectiveSampleIntervalMs: requestedSampleIntervalMs,
    sampleCount: 0,
    meanDistance: null,
    rootMeanSquareDistance: null,
    percentile95Distance: null,
    maxDistance: null,
    maxDistanceTime: null,
    coordinateComparable,
    realTimeComparable,
  };
}

export interface CursorSeparationOptions {
  sampleIntervalMs?: number;
  maxSamples?: number;
  coordinateComparable?: boolean;
  realTimeComparable?: boolean;
  primaryExcludedRanges?: readonly CursorExcludedTimeRange[];
  secondaryExcludedRanges?: readonly CursorExcludedTimeRange[];
}

export function calculateSynchronizedCursorSeparation(
  primaryFrames: readonly ReplayFrame[],
  secondaryFrames: readonly ReplayFrame[],
  options: CursorSeparationOptions = {},
): CursorSeparationMetrics {
  const requestedSampleIntervalMs = Math.max(1, options.sampleIntervalMs ?? 16);
  const maxSamples = Math.max(2, Math.floor(options.maxSamples ?? 50_000));
  const coordinateComparable = options.coordinateComparable ?? true;
  const realTimeComparable = options.realTimeComparable ?? true;
  const primary = normalizedCursorFrames(primaryFrames);
  const secondary = normalizedCursorFrames(secondaryFrames);
  const primaryExcludedRanges = normalizedCursorExcludedRanges(options.primaryExcludedRanges);
  const secondaryExcludedRanges = normalizedCursorExcludedRanges(options.secondaryExcludedRanges);
  if (primary.length === 0) {
    return unavailableCursorMetrics(
      "primary-no-frames",
      requestedSampleIntervalMs,
      coordinateComparable,
      realTimeComparable,
    );
  }
  if (secondary.length === 0) {
    return unavailableCursorMetrics(
      "secondary-no-frames",
      requestedSampleIntervalMs,
      coordinateComparable,
      realTimeComparable,
    );
  }

  const overlapStartTime = Math.max(primary[0].time, secondary[0].time);
  const overlapEndTime = Math.min(primary[primary.length - 1].time, secondary[secondary.length - 1].time);
  if (overlapStartTime > overlapEndTime) {
    return unavailableCursorMetrics(
      "no-overlapping-time",
      requestedSampleIntervalMs,
      coordinateComparable,
      realTimeComparable,
    );
  }

  const duration = overlapEndTime - overlapStartTime;
  const effectiveSampleIntervalMs = Math.max(
    requestedSampleIntervalMs,
    duration > 0 ? duration / (maxSamples - 1) : requestedSampleIntervalMs,
  );
  const samples: Array<{ time: number; distance: number }> = [];
  for (let time = overlapStartTime; time <= overlapEndTime; time += effectiveSampleIntervalMs) {
    const primaryPosition = positionAt(primary, time, primaryExcludedRanges);
    const secondaryPosition = positionAt(secondary, time, secondaryExcludedRanges);
    if (primaryPosition && secondaryPosition) {
      samples.push({
        time,
        distance: Math.hypot(primaryPosition.x - secondaryPosition.x, primaryPosition.y - secondaryPosition.y),
      });
    }
  }
  if (samples.length === 0 || samples[samples.length - 1].time < overlapEndTime) {
    const primaryPosition = positionAt(primary, overlapEndTime, primaryExcludedRanges);
    const secondaryPosition = positionAt(secondary, overlapEndTime, secondaryExcludedRanges);
    if (primaryPosition && secondaryPosition) {
      samples.push({
        time: overlapEndTime,
        distance: Math.hypot(primaryPosition.x - secondaryPosition.x, primaryPosition.y - secondaryPosition.y),
      });
    }
  }

  if (samples.length === 0) {
    return unavailableCursorMetrics(
      "no-valid-samples",
      requestedSampleIntervalMs,
      coordinateComparable,
      realTimeComparable,
    );
  }

  const total = samples.reduce((sum, sample) => sum + sample.distance, 0);
  const squareTotal = samples.reduce((sum, sample) => sum + sample.distance ** 2, 0);
  const sortedDistances = samples.map((sample) => sample.distance).sort((a, b) => a - b);
  const percentileIndex = Math.max(0, Math.ceil(sortedDistances.length * 0.95) - 1);
  let max = samples[0];
  for (const sample of samples) if (sample.distance > max.distance) max = sample;

  return {
    available: true,
    unavailableReason: null,
    overlapStartTime,
    overlapEndTime,
    requestedSampleIntervalMs,
    effectiveSampleIntervalMs,
    sampleCount: samples.length,
    meanDistance: total / samples.length,
    rootMeanSquareDistance: Math.sqrt(squareTotal / samples.length),
    percentile95Distance: sortedDistances[percentileIndex],
    maxDistance: max.distance,
    maxDistanceTime: max.time,
    coordinateComparable,
    realTimeComparable,
  };
}

export interface ReplayComparisonSummaryDelta {
  count300: number;
  count100: number;
  count50: number;
  countMiss: number;
  sliderBreakCount: number;
  accuracy: number | null;
  maxComboInput: number | null;
  scoreInput: number | null;
}

export interface ReplayComparisonResult {
  ruleset: ReplayAnalysisRuleset;
  primaryId: string;
  secondaryId: string;
  compatibility: ReplayComparisonCompatibility;
  primarySummary: ReplayComparisonParticipantSummary;
  secondarySummary: ReplayComparisonParticipantSummary;
  /** Secondary minus primary. */
  summaryDelta: ReplayComparisonSummaryDelta;
  joinedJudgements: JoinedReplayJudgement[];
  differences: JoinedReplayJudgement[];
  joinedSliderBreaks: JoinedReplaySliderBreak[];
  sliderBreakDifferences: JoinedReplaySliderBreak[];
  differenceCounts: Record<ReplayObjectDifferenceKind, number>;
  physicalInputs: PhysicalInputComparison;
  cursorSeparation: CursorSeparationMetrics;
  participantLimitations: {
    primary: readonly ComparisonParticipantLimitation[];
    secondary: readonly ComparisonParticipantLimitation[];
  };
}

export interface ReplayComparisonOptions {
  timingToleranceMs?: number;
  cursorSampleIntervalMs?: number;
  cursorMaxSamples?: number;
  ruleset?: ReplayAnalysisRuleset;
}

function nullableDelta(secondary: number | null, primary: number | null): number | null {
  return secondary !== null && primary !== null ? secondary - primary : null;
}

export function compareReplayParticipants(
  primary: ReplayComparisonParticipant,
  secondary: ReplayComparisonParticipant,
  options: ReplayComparisonOptions = {},
): ReplayComparisonResult {
  const ruleset = options.ruleset ?? "stable";
  const compatibility = validateReplayComparisonCompatibility(primary, secondary);
  const primarySummary = summarizeReplayComparisonParticipant(primary, ruleset);
  const secondarySummary = summarizeReplayComparisonParticipant(secondary, ruleset);
  const joined = joinedJudgements(
    primary.events,
    secondary.events,
    Math.max(0, options.timingToleranceMs ?? 0.01),
    ruleset,
  );
  const sliderBreaks = joinedSliderBreaks(
    primary.events,
    secondary.events,
    Math.max(0, options.timingToleranceMs ?? 0.01),
  );
  const differences = joined.filter((judgement) => judgement.differenceKinds.length > 0);
  const differenceCounts: Record<ReplayObjectDifferenceKind, number> = { presence: 0, verdict: 0, timing: 0 };
  for (const difference of differences) {
    for (const kind of difference.differenceKinds) differenceCounts[kind]++;
  }

  const primaryInputs = summarizePhysicalReplayInputs(
    primary.inputFrames,
    primary.baseRate,
    primary.gameVersion,
    primary.buttonEncoding,
  );
  const secondaryInputs = summarizePhysicalReplayInputs(
    secondary.inputFrames,
    secondary.baseRate,
    secondary.gameVersion,
    secondary.buttonEncoding,
  );

  return {
    ruleset,
    primaryId: primary.id,
    secondaryId: secondary.id,
    compatibility,
    primarySummary,
    secondarySummary,
    summaryDelta: {
      count300: secondarySummary.counts.count300 - primarySummary.counts.count300,
      count100: secondarySummary.counts.count100 - primarySummary.counts.count100,
      count50: secondarySummary.counts.count50 - primarySummary.counts.count50,
      countMiss: secondarySummary.counts.countMiss - primarySummary.counts.countMiss,
      sliderBreakCount: secondarySummary.sliderBreakCount - primarySummary.sliderBreakCount,
      accuracy: nullableDelta(secondarySummary.accuracy, primarySummary.accuracy),
      maxComboInput: nullableDelta(secondarySummary.maxComboInput, primarySummary.maxComboInput),
      scoreInput: nullableDelta(secondarySummary.scoreInput, primarySummary.scoreInput),
    },
    joinedJudgements: joined,
    differences,
    joinedSliderBreaks: ruleset === "stable" ? sliderBreaks : [],
    sliderBreakDifferences:
      ruleset === "stable" ? sliderBreaks.filter((sliderBreak) => sliderBreak.differenceKinds.length > 0) : [],
    differenceCounts,
    physicalInputs: {
      primary: primaryInputs,
      secondary: secondaryInputs,
      deltas: inputDeltas(primaryInputs, secondaryInputs),
    },
    cursorSeparation: calculateSynchronizedCursorSeparation(primary.cursorFrames, secondary.cursorFrames, {
      sampleIntervalMs: options.cursorSampleIntervalMs,
      maxSamples: options.cursorMaxSamples,
      coordinateComparable: compatibility.sameCoordinateTransform,
      realTimeComparable: compatibility.sameRate,
      primaryExcludedRanges: primary.cursorExcludedRanges,
      secondaryExcludedRanges: secondary.cursorExcludedRanges,
    }),
    participantLimitations: {
      primary: primary.limitations ?? [],
      secondary: secondary.limitations ?? [],
    },
  };
}
