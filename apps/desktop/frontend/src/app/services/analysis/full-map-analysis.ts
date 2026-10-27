import type {
  HitObjectJudgement,
  ReplayAnalysisEvent,
  ReplayAnalysisRuleset,
  SliderBreak,
  SliderComponentMiss,
} from "@osujs/core";
import { isNotelockMiss } from "@osujs/core";
import type { ReplayAimEvidence } from "./aim-consistency";
import { standaloneStableSliderEndMisses } from "./stable-slider-end-misses";

export type GameSimulatorHit = readonly [judgementTime: number, offset: number, hit: boolean];

export interface FullMapAnalysisInput {
  /** Defaults to Stable for backwards-compatible callers. */
  ruleset?: ReplayAnalysisRuleset;
  events: readonly ReplayAnalysisEvent[];
  hits: readonly GameSimulatorHit[];
  /** First non-spinner object's start on the beatmap timeline; defaults to zero. */
  startTime?: number;
  /** Absolute end of the chart's playable-object timeline, not its elapsed span. */
  duration: number;
  baseRate: number;
  /** Ruleset-owned final accuracy; Lazer includes nested slider score weights. */
  aggregateAccuracyInput?: number | null;
  /** Ruleset-owned final main-result counts in 300/100/50/miss order. */
  aggregateJudgementCountsInput?: readonly number[];
  /** Optional beatmap coverage supplied by a caller that has object metadata. */
  objectCoverage?: FullMapObjectCoverageInput;
  /** Successful, evaluator-assigned circle/head cursor evidence. */
  aimEvidence?: ReplayAimEvidence;
  maxComboObtained?: number | null;
  mapMaxCombo?: number | null;
}

export interface FullMapObjectCoverageInput {
  totalObjectCount?: number;
  excludedSpinnerCount?: number;
  /** Unsupported main objects other than the separately reported spinners. */
  unsupportedObjectCount?: number;
  /** Lazer slider score components excluded from this main-result analysis. */
  unsupportedNestedCount?: number;
}

export interface StableJudgementCounts {
  count300: number;
  count100: number;
  count50: number;
  countMiss: number;
  total: number;
}

export type TimingBias = "early" | "late" | "neutral" | "unavailable";
export type TimingTrend = "improving" | "deteriorating" | "stable" | "mixed" | "insufficient-data";
export type MapThird = "opening" | "middle" | "ending";

export interface MapThirdTimingSummary {
  third: MapThird;
  startTime: number;
  endTime: number;
  sampleCount: number;
  meanOffsetMs: number | null;
  unstableRate: number | null;
  judgementCount: number;
  accuracy: number | null;
  errorCount: number;
  /** Fraction of main-object judgements below GREAT in this third. */
  errorRate: number | null;
  missCount: number;
  sliderBreakCount?: number;
  sliderComponentMissCount?: number;
}

export interface HitErrorDistribution {
  p10Ms: number | null;
  medianMs: number | null;
  p90Ms: number | null;
  centerThresholdMs: number;
  earlyCount: number;
  centerCount: number;
  lateCount: number;
  totalCount: number;
}

/** A successful, finite timing sample in the active ruleset's native timing basis. */
export interface FullMapTimingSample {
  /** Judgement time on the beatmap timeline. */
  time: number;
  /** Stable uses beatmap-time milliseconds; lazer uses real-world milliseconds. */
  offsetMs: number;
}

export interface UrOverTimePoint {
  /** Time of the newest sample represented by this point. */
  time: number;
  unstableRate: number;
  sampleCount: number;
}

/** Retained for callers that name the cumulative series explicitly. */
export type AverageUrPoint = UrOverTimePoint;

export interface HitErrorHistogramBin {
  centerMs: number;
  startMs: number;
  endMs: number;
  count: number;
}

export interface HitErrorHistogram {
  binWidthMs: number;
  extentMs: number;
  bins: HitErrorHistogramBin[];
}

export interface FullMapTimingSummary {
  available: boolean;
  unavailableReason: "invalid-base-rate" | "no-successful-hits" | null;
  sampleCount: number;
  meanOffsetMs: number | null;
  standardDeviationMs: number | null;
  bias: TimingBias;
  unstableRate: number | null;
  /** Exact canonical sample set shared by every timing visualization. */
  samples: FullMapTimingSample[];
  /** Population UR over the latest rolling hit window at each successful hit. */
  urOverTime: UrOverTimePoint[];
  peakUr: UrOverTimePoint | null;
  /** Cumulative population UR across every successful hit up to each point in time. */
  averageUr: AverageUrPoint[];
  peakAverageUr: AverageUrPoint | null;
  /** Fractions of directional samples with a strictly negative/positive offset. */
  earlyPercentage: number | null;
  latePercentage: number | null;
  histogram: HitErrorHistogram;
  trend: TimingTrend;
  openingToEndingUrChange: number | null;
  thirds: MapThirdTimingSummary[];
  distribution: HitErrorDistribution;
}

export interface WeakTimeSection {
  startTime: number;
  endTime: number;
  missCount: number;
  sliderBreakCount?: number;
  sliderComponentMissCount?: number;
  count100: number;
  count50: number;
  unstableRate: number | null;
  timingLessConsistent: boolean;
  headline: string;
}

export interface FullMapAnalysisSummary {
  ruleset: ReplayAnalysisRuleset;
  /** First non-spinner object's start on the beatmap timeline. */
  startTime: number;
  /** Absolute chart end on the beatmap timeline. */
  duration: number;
  baseRate: number;
  accuracy: number | null;
  judgements: StableJudgementCounts;
  errors: {
    missCount: number;
    /** Proven main-object misses where evaluator-owned evidence identifies notelock. */
    notelockMissCount: number;
    sliderBreakCount?: number;
    sliderComponentMissCount?: number;
    total: number;
  };
  maxComboObtained: number | null;
  mapMaxCombo: number | null;
  sliderMisses: {
    sliderTickMissCount?: number;
    sliderEndMissCount: number;
  };
  timing: FullMapTimingSummary;
  coverage: FullMapObjectCoverageSummary;
  weakSections: WeakTimeSection[];
  aimConsistency: AimConsistencySummary;
}

export interface AimConsistencySummary {
  available: boolean;
  sampleCount: number;
  eligibleEventCount: number;
  coverage: number | null;
  meanDistancePx: number | null;
  p90DistancePx: number | null;
  meanRadiusFraction: number | null;
  reason: string;
}

export interface FullMapObjectCoverageSummary {
  analyzedObjectCount: number;
  totalObjectCount: number | null;
  excludedSpinnerCount: number | null;
  unsupportedObjectCount: number | null;
  unsupportedNestedCount?: number | null;
  complete: boolean | null;
  reason: string;
}

interface TimingMetrics {
  sampleCount: number;
  meanOffsetMs: number | null;
  unstableRate: number | null;
}

interface MutableWeakSection {
  startTime: number;
  endTime: number;
  missCount: number;
  sliderBreakCount: number;
  sliderComponentMissCount: number;
  count100: number;
  count50: number;
  offsets: number[];
}

const MIN_SAMPLES_FOR_TREND = 3;
const NEUTRAL_BIAS_THRESHOLD_MS = 1;
const MIN_WEAK_SECTION_DURATION_MS = 10_000;
const MAX_WEAK_SECTION_DURATION_MS = 30_000;
const TARGET_WEAK_SECTION_COUNT = 12;
const HIT_ERROR_CENTER_THRESHOLD_MS = 10;
export const HIT_ERROR_HISTOGRAM_BIN_WIDTH_MS = 1;
const HIT_ERROR_HISTOGRAM_MAX_HALF_BIN_COUNT = 200;
export const ROLLING_UR_HIT_WINDOW = 50;

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function eventObjectTime(event: ReplayAnalysisEvent): number {
  return event.objectTime ?? event.time;
}

function uniqueJudgements(
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
): HitObjectJudgement[] {
  const judgements = new Map<string, HitObjectJudgement>();

  for (const event of events) {
    if (event.type !== "HitObjectJudgement") continue;
    if (event.affectsAccuracy === false) continue;
    if (ruleset === "stable" && (event.isSliderHead || event.ruleset === "lazer")) continue;
    if (ruleset === "lazer" && event.ruleset !== "lazer") continue;
    const key = event.eventId ?? `${event.hitObjectId}:${event.time}`;
    if (!judgements.has(key)) judgements.set(key, event);
  }

  return Array.from(judgements.values());
}

function uniqueStableSliderBreaks(
  events: readonly ReplayAnalysisEvent[],
  missedSliderIds: ReadonlySet<string>,
): SliderBreak[] {
  const sliderBreaks = new Map<string, SliderBreak>();

  for (const event of events) {
    if (event.type !== "SliderBreak" || event.ruleset !== "stable" || missedSliderIds.has(event.sliderId)) continue;
    if (!sliderBreaks.has(event.eventId)) sliderBreaks.set(event.eventId, event);
  }

  return Array.from(sliderBreaks.values());
}

function uniqueLazerSliderComponentMisses(events: readonly ReplayAnalysisEvent[]): SliderComponentMiss[] {
  const componentMisses = new Map<string, SliderComponentMiss>();

  for (const event of events) {
    if (event.type !== "SliderComponentMiss" || event.ruleset !== "lazer") continue;
    if (!componentMisses.has(event.eventId)) componentMisses.set(event.eventId, event);
  }

  return Array.from(componentMisses.values());
}

function stableJudgementCounts(judgements: readonly HitObjectJudgement[]): StableJudgementCounts {
  const counts: StableJudgementCounts = {
    count300: 0,
    count100: 0,
    count50: 0,
    countMiss: 0,
    total: 0,
  };

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

function normalizeAggregateJudgementCounts(counts: readonly number[] | undefined): StableJudgementCounts | null {
  if (!counts || counts.length < 4 || !counts.slice(0, 4).every(Number.isFinite)) return null;

  const [count300, count100, count50, countMiss] = counts.slice(0, 4).map((count) => Math.max(0, Math.trunc(count)));
  return {
    count300,
    count100,
    count50,
    countMiss,
    total: count300 + count100 + count50 + countMiss,
  };
}

function stableAccuracy(counts: StableJudgementCounts): number | null {
  if (counts.total === 0) return null;
  return (counts.count300 * 300 + counts.count100 * 100 + counts.count50 * 50) / (counts.total * 300);
}

function normalizeTimingHits(
  hits: readonly GameSimulatorHit[],
  baseRate: number,
  ruleset: ReplayAnalysisRuleset,
): FullMapTimingSample[] {
  if (!isFiniteNumber(baseRate) || baseRate <= 0) return [];

  const normalized: FullMapTimingSample[] = [];
  for (const [time, offset, hit] of hits) {
    // Miss offsets can be force-kill times rather than player input, so they are deliberately excluded.
    if (!hit || !isFiniteNumber(time) || !isFiniteNumber(offset)) continue;
    // Stable's historical UR is measured in beatmap-time milliseconds. Lazer reports
    // real-world timing and therefore removes the replay's clock-rate multiplier.
    normalized.push({ time, offsetMs: ruleset === "lazer" ? offset / baseRate : offset });
  }
  return normalized.sort((left, right) => left.time - right.time);
}

function timingMetrics(hits: readonly FullMapTimingSample[]): TimingMetrics {
  if (hits.length === 0) return { sampleCount: 0, meanOffsetMs: null, unstableRate: null };

  const meanOffsetMs = hits.reduce((sum, hit) => sum + hit.offsetMs, 0) / hits.length;
  // Native UR uses population variance, which is zero for one successful hit.
  const variance = hits.reduce((sum, hit) => sum + (hit.offsetMs - meanOffsetMs) ** 2, 0) / hits.length;
  return {
    sampleCount: hits.length,
    meanOffsetMs,
    unstableRate: Math.sqrt(variance) * 10,
  };
}

/** Shared numeric projection without building charts, weak sections or cause classifications. */
export function canonicalReplayTiming(hits: readonly GameSimulatorHit[], baseRate: number, ruleset: ReplayAnalysisRuleset): TimingMetrics {
  return timingMetrics(normalizeTimingHits(hits, baseRate, ruleset));
}

function timingBias(meanOffsetMs: number | null): TimingBias {
  if (meanOffsetMs === null) return "unavailable";
  if (meanOffsetMs > NEUTRAL_BIAS_THRESHOLD_MS) return "late";
  if (meanOffsetMs < -NEUTRAL_BIAS_THRESHOLD_MS) return "early";
  return "neutral";
}

function percentile(sortedValues: readonly number[], percentileValue: number): number | null {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];

  const index = (sortedValues.length - 1) * percentileValue;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const interpolation = index - lowerIndex;
  return sortedValues[lowerIndex] + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * interpolation;
}

function hitErrorDistribution(hits: readonly FullMapTimingSample[]): HitErrorDistribution {
  const offsets = hits.map((hit) => hit.offsetMs).sort((a, b) => a - b);
  let earlyCount = 0;
  let centerCount = 0;
  let lateCount = 0;

  for (const offset of offsets) {
    if (offset < -HIT_ERROR_CENTER_THRESHOLD_MS) earlyCount++;
    else if (offset > HIT_ERROR_CENTER_THRESHOLD_MS) lateCount++;
    else centerCount++;
  }

  return {
    p10Ms: percentile(offsets, 0.1),
    medianMs: percentile(offsets, 0.5),
    p90Ms: percentile(offsets, 0.9),
    centerThresholdMs: HIT_ERROR_CENTER_THRESHOLD_MS,
    earlyCount,
    centerCount,
    lateCount,
    totalCount: offsets.length,
  };
}

function averageUrOverTime(hits: readonly FullMapTimingSample[]): AverageUrPoint[] {
  const points: AverageUrPoint[] = [];
  let sampleCount = 0;
  let meanOffsetMs = 0;
  let squaredDeviationSum = 0;

  for (const hit of hits) {
    sampleCount++;
    const delta = hit.offsetMs - meanOffsetMs;
    meanOffsetMs += delta / sampleCount;
    squaredDeviationSum += delta * (hit.offsetMs - meanOffsetMs);
    if (sampleCount < 2) continue;

    points.push({
      time: hit.time,
      unstableRate: Math.sqrt(Math.max(0, squaredDeviationSum / sampleCount)) * 10,
      sampleCount,
    });
  }
  return points;
}

function urOverTime(hits: readonly FullMapTimingSample[]): UrOverTimePoint[] {
  const points: UrOverTimePoint[] = [];

  // The scalar UR is zero for one hit; the trend chart starts with the second
  // successful hit, using a growing window until it reaches
  // the fixed rolling size, then retain only the latest successful hits.
  for (let index = 1; index < hits.length; index++) {
    const windowStart = Math.max(0, index - ROLLING_UR_HIT_WINDOW + 1);
    const window = hits.slice(windowStart, index + 1);
    const unstableRate = timingMetrics(window).unstableRate;
    if (unstableRate === null) continue;

    points.push({
      time: hits[index].time,
      unstableRate,
      sampleCount: window.length,
    });
  }

  return points;
}

function peakUrPoint(points: readonly UrOverTimePoint[]): UrOverTimePoint | null {
  let peak: UrOverTimePoint | null = null;
  for (const point of points) {
    if (peak === null || point.unstableRate > peak.unstableRate) peak = point;
  }
  return peak ? { ...peak } : null;
}

function directionalPercentages(hits: readonly FullMapTimingSample[]): {
  earlyPercentage: number | null;
  latePercentage: number | null;
} {
  if (hits.length === 0) return { earlyPercentage: null, latePercentage: null };
  const earlyCount = hits.filter((hit) => hit.offsetMs < 0).length;
  const lateCount = hits.filter((hit) => hit.offsetMs > 0).length;
  const directionalCount = earlyCount + lateCount;
  if (directionalCount === 0) return { earlyPercentage: null, latePercentage: null };
  return {
    earlyPercentage: earlyCount / directionalCount,
    latePercentage: lateCount / directionalCount,
  };
}

function hitErrorHistogram(hits: readonly FullMapTimingSample[]): HitErrorHistogram {
  if (hits.length === 0) {
    return { binWidthMs: HIT_ERROR_HISTOGRAM_BIN_WIDTH_MS, extentMs: 0, bins: [] };
  }

  const maxAbsoluteOffset = Math.max(...hits.map((hit) => Math.abs(hit.offsetMs)));
  // Preserve the finest honest Stable replay resolution throughout normal hit
  // windows, while bounding malformed/extreme input to at most 401 bins.
  const binWidthMs = Math.max(
    HIT_ERROR_HISTOGRAM_BIN_WIDTH_MS,
    Math.ceil(maxAbsoluteOffset / HIT_ERROR_HISTOGRAM_MAX_HALF_BIN_COUNT / HIT_ERROR_HISTOGRAM_BIN_WIDTH_MS) *
      HIT_ERROR_HISTOGRAM_BIN_WIDTH_MS,
  );
  const extentMs = Math.max(binWidthMs, Math.ceil(maxAbsoluteOffset / binWidthMs) * binWidthMs);
  const halfBinCount = Math.round(extentMs / binWidthMs);
  const bins: HitErrorHistogramBin[] = Array.from({ length: halfBinCount * 2 + 1 }, (_, index) => {
    const centerMs = (index - halfBinCount) * binWidthMs;
    return {
      centerMs,
      startMs: centerMs - binWidthMs / 2,
      endMs: centerMs + binWidthMs / 2,
      count: 0,
    };
  });

  for (const hit of hits) {
    const scaled = hit.offsetMs / binWidthMs;
    const centeredIndex = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
    const binIndex = Math.max(0, Math.min(bins.length - 1, centeredIndex + halfBinCount));
    bins[binIndex].count++;
  }

  return { binWidthMs, extentMs, bins };
}

function timingByThirds(
  hits: readonly FullMapTimingSample[],
  judgements: readonly HitObjectJudgement[],
  sliderBreaks: readonly SliderBreak[],
  sliderComponentMisses: readonly SliderComponentMiss[],
  duration: number,
  ruleset: ReplayAnalysisRuleset,
): MapThirdTimingSummary[] {
  const names: MapThird[] = ["opening", "middle", "ending"];

  return names.map((third, index) => {
    const startTime = (duration * index) / 3;
    const endTime = (duration * (index + 1)) / 3;
    const sectionHits =
      duration > 0
        ? hits.filter((hit) => {
            const bucketTime = clamp(hit.time, 0, duration);
            return (
              bucketTime >= startTime && (index === names.length - 1 ? bucketTime <= endTime : bucketTime < endTime)
            );
          })
        : [];
    const includesTime = (time: number) =>
      duration > 0 && time >= startTime && (index === names.length - 1 ? time <= endTime : time < endTime);
    const sectionJudgements = judgements.filter((judgement) => includesTime(eventObjectTime(judgement)));
    const sectionSliderBreaks = sliderBreaks.filter((sliderBreak) => includesTime(eventObjectTime(sliderBreak)));
    const sectionSliderComponentMisses = sliderComponentMisses.filter((componentMiss) =>
      includesTime(eventObjectTime(componentMiss)),
    );
    const counts = stableJudgementCounts(sectionJudgements);
    const errorCount = counts.count100 + counts.count50 + counts.countMiss;

    return {
      third,
      startTime,
      endTime,
      ...timingMetrics(sectionHits),
      judgementCount: counts.total,
      accuracy: stableAccuracy(counts),
      errorCount,
      errorRate: counts.total === 0 ? null : errorCount / counts.total,
      missCount: counts.countMiss,
      ...(ruleset === "stable"
        ? { sliderBreakCount: sectionSliderBreaks.length }
        : { sliderComponentMissCount: sectionSliderComponentMisses.length }),
    };
  });
}

function timingTrend(
  thirds: readonly MapThirdTimingSummary[],
  overallUr: number | null,
): { trend: TimingTrend; openingToEndingUrChange: number | null } {
  const enoughData = thirds.every((third) => third.sampleCount >= MIN_SAMPLES_FOR_TREND && third.unstableRate !== null);
  if (!enoughData || overallUr === null) {
    return { trend: "insufficient-data", openingToEndingUrChange: null };
  }

  const openingUr = thirds[0].unstableRate as number;
  const middleUr = thirds[1].unstableRate as number;
  const endingUr = thirds[2].unstableRate as number;
  const change = endingUr - openingUr;
  const meaningfulChange = Math.max(5, overallUr * 0.1);
  const thirdUrSpread = Math.max(openingUr, middleUr, endingUr) - Math.min(openingUr, middleUr, endingUr);

  if (Math.abs(change) <= meaningfulChange && thirdUrSpread <= meaningfulChange) {
    return { trend: "stable", openingToEndingUrChange: change };
  }

  // Similar opening and ending consistency can hide a material mid-map spike.
  if (Math.abs(change) <= meaningfulChange) {
    return { trend: "mixed", openingToEndingUrChange: change };
  }

  const stepTolerance = meaningfulChange / 2;
  if (change > 0 && middleUr >= openingUr - stepTolerance && endingUr >= middleUr - stepTolerance) {
    return { trend: "deteriorating", openingToEndingUrChange: change };
  }
  if (change < 0 && middleUr <= openingUr + stepTolerance && endingUr <= middleUr + stepTolerance) {
    return { trend: "improving", openingToEndingUrChange: change };
  }

  return { trend: "mixed", openingToEndingUrChange: change };
}

function createTimingSummary(
  hits: readonly GameSimulatorHit[],
  judgements: readonly HitObjectJudgement[],
  sliderBreaks: readonly SliderBreak[],
  sliderComponentMisses: readonly SliderComponentMiss[],
  duration: number,
  baseRate: number,
  ruleset: ReplayAnalysisRuleset,
): { summary: FullMapTimingSummary; normalizedHits: FullMapTimingSample[] } {
  const validBaseRate = isFiniteNumber(baseRate) && baseRate > 0;
  const normalizedHits = normalizeTimingHits(hits, baseRate, ruleset);
  const overall = timingMetrics(normalizedHits);
  const thirds = timingByThirds(normalizedHits, judgements, sliderBreaks, sliderComponentMisses, duration, ruleset);
  const trend = timingTrend(thirds, overall.unstableRate);
  const urPoints = urOverTime(normalizedHits);
  const averageUrPoints = averageUrOverTime(normalizedHits);
  const percentages = directionalPercentages(normalizedHits);

  return {
    normalizedHits,
    summary: {
      available: overall.sampleCount > 0,
      unavailableReason: !validBaseRate ? "invalid-base-rate" : overall.sampleCount === 0 ? "no-successful-hits" : null,
      sampleCount: overall.sampleCount,
      meanOffsetMs: overall.meanOffsetMs,
      standardDeviationMs: overall.unstableRate === null ? null : overall.unstableRate / 10,
      bias: timingBias(overall.meanOffsetMs),
      unstableRate: overall.unstableRate,
      samples: normalizedHits.map((sample) => ({ ...sample })),
      urOverTime: urPoints,
      peakUr: peakUrPoint(urPoints),
      averageUr: averageUrPoints,
      peakAverageUr: peakUrPoint(averageUrPoints),
      ...percentages,
      histogram: hitErrorHistogram(normalizedHits),
      trend: trend.trend,
      openingToEndingUrChange: trend.openingToEndingUrChange,
      thirds,
      distribution: hitErrorDistribution(normalizedHits),
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function weakSectionIndex(time: number, duration: number, sectionDuration: number, sectionCount: number): number {
  const clampedTime = clamp(time, 0, duration);
  return Math.min(sectionCount - 1, Math.floor(clampedTime / sectionDuration));
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string | null {
  if (count === 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

function weakSectionHeadline(section: Omit<WeakTimeSection, "headline">): string {
  const parts = [
    countLabel(section.missCount, "miss", "misses"),
    countLabel(section.sliderBreakCount ?? 0, "sliderbreak"),
    countLabel(section.sliderComponentMissCount ?? 0, "slider component miss", "slider component misses"),
    section.count50 > 0 ? `${section.count50}×50` : null,
    section.count100 > 0 ? `${section.count100}×100` : null,
    section.timingLessConsistent ? "less consistent timing" : null,
  ].filter((part): part is string => part !== null);

  return parts.join(", ");
}

function weakSections(
  judgements: readonly HitObjectJudgement[],
  sliderBreaks: readonly SliderBreak[],
  sliderComponentMisses: readonly SliderComponentMiss[],
  timingHits: readonly FullMapTimingSample[],
  duration: number,
  overallUr: number | null,
): WeakTimeSection[] {
  if (duration <= 0) return [];

  const sectionDuration = clamp(
    duration / TARGET_WEAK_SECTION_COUNT,
    MIN_WEAK_SECTION_DURATION_MS,
    MAX_WEAK_SECTION_DURATION_MS,
  );
  const sectionCount = Math.max(1, Math.ceil(duration / sectionDuration));
  const sections: MutableWeakSection[] = Array.from({ length: sectionCount }, (_, index) => ({
    startTime: index * sectionDuration,
    endTime: Math.min(duration, (index + 1) * sectionDuration),
    missCount: 0,
    sliderBreakCount: 0,
    sliderComponentMissCount: 0,
    count100: 0,
    count50: 0,
    offsets: [],
  }));

  for (const judgement of judgements) {
    const time = eventObjectTime(judgement);
    if (!isFiniteNumber(time)) continue;
    const section = sections[weakSectionIndex(time, duration, sectionDuration, sectionCount)];
    switch (judgement.verdict) {
      case "MISS":
        section.missCount++;
        break;
      case "MEH":
        section.count50++;
        break;
      case "OK":
        section.count100++;
        break;
    }
  }

  for (const sliderBreak of sliderBreaks) {
    const time = eventObjectTime(sliderBreak);
    if (!isFiniteNumber(time)) continue;
    sections[weakSectionIndex(time, duration, sectionDuration, sectionCount)].sliderBreakCount++;
  }

  for (const componentMiss of sliderComponentMisses) {
    const time = eventObjectTime(componentMiss);
    if (!isFiniteNumber(time)) continue;
    sections[weakSectionIndex(time, duration, sectionDuration, sectionCount)].sliderComponentMissCount++;
  }

  for (const hit of timingHits) {
    sections[weakSectionIndex(hit.time, duration, sectionDuration, sectionCount)].offsets.push(hit.offsetMs);
  }

  const timingDifferenceThreshold = overallUr === null ? null : Math.max(8, overallUr * 0.2);
  return sections
    .map((section) => {
      const localTiming = timingMetrics(section.offsets.map((offsetMs) => ({ time: 0, offsetMs })));
      const timingLessConsistent =
        localTiming.sampleCount >= MIN_SAMPLES_FOR_TREND &&
        localTiming.unstableRate !== null &&
        overallUr !== null &&
        timingDifferenceThreshold !== null &&
        localTiming.unstableRate > overallUr + timingDifferenceThreshold;
      const severity =
        section.missCount * 4 +
        (section.sliderBreakCount ?? 0) * 3 +
        (section.sliderComponentMissCount ?? 0) * 3 +
        section.count50 * 2 +
        section.count100 +
        (timingLessConsistent ? 2 : 0);
      const resultWithoutHeadline: Omit<WeakTimeSection, "headline"> = {
        startTime: section.startTime,
        endTime: section.endTime,
        missCount: section.missCount,
        sliderBreakCount: section.sliderBreakCount,
        sliderComponentMissCount: section.sliderComponentMissCount,
        count100: section.count100,
        count50: section.count50,
        unstableRate: localTiming.unstableRate,
        timingLessConsistent,
      };
      return {
        severity,
        result: { ...resultWithoutHeadline, headline: weakSectionHeadline(resultWithoutHeadline) },
      };
    })
    .filter((section) => section.severity > 0)
    .sort((a, b) => b.severity - a.severity || a.result.startTime - b.result.startTime)
    .slice(0, 3)
    .map((section) => section.result);
}

function optionalObjectCount(value: number | undefined): number | null {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : null;
}

function summarizeObjectCoverage(
  analyzedObjectCount: number,
  input: FullMapObjectCoverageInput | undefined,
): FullMapObjectCoverageSummary {
  const totalObjectCount = optionalObjectCount(input?.totalObjectCount);
  const excludedSpinnerCount = optionalObjectCount(input?.excludedSpinnerCount);
  const unsupportedObjectCount = optionalObjectCount(input?.unsupportedObjectCount);
  const hasNestedBreakdown = input?.unsupportedNestedCount !== undefined;
  const unsupportedNestedCount = optionalObjectCount(input?.unsupportedNestedCount);
  const nestedBreakdown = hasNestedBreakdown ? { unsupportedNestedCount } : {};

  if (totalObjectCount === null) {
    return {
      analyzedObjectCount,
      totalObjectCount,
      excludedSpinnerCount,
      unsupportedObjectCount,
      ...nestedBreakdown,
      complete: null,
      reason: "Beatmap object totals were not supplied; only reconstructed judgements are counted.",
    };
  }

  if (excludedSpinnerCount === null || unsupportedObjectCount === null) {
    return {
      analyzedObjectCount,
      totalObjectCount,
      excludedSpinnerCount,
      unsupportedObjectCount,
      ...nestedBreakdown,
      complete: null,
      reason: "Object coverage is partial because the excluded-object breakdown was not supplied.",
    };
  }

  if (analyzedObjectCount + excludedSpinnerCount + unsupportedObjectCount !== totalObjectCount) {
    return {
      analyzedObjectCount,
      totalObjectCount,
      excludedSpinnerCount,
      unsupportedObjectCount,
      ...nestedBreakdown,
      complete: null,
      reason: "Coverage counts do not reconcile with the supplied beatmap object total.",
    };
  }

  if (hasNestedBreakdown && unsupportedNestedCount === null) {
    return {
      analyzedObjectCount,
      totalObjectCount,
      excludedSpinnerCount,
      unsupportedObjectCount,
      unsupportedNestedCount,
      complete: null,
      reason: "Lazer nested-slider coverage was requested but its component count was not supplied.",
    };
  }

  const complete =
    excludedSpinnerCount === 0 && unsupportedObjectCount === 0 && (!hasNestedBreakdown || unsupportedNestedCount === 0);
  return {
    analyzedObjectCount,
    totalObjectCount,
    excludedSpinnerCount,
    unsupportedObjectCount,
    ...nestedBreakdown,
    complete,
    reason:
      hasNestedBreakdown && (unsupportedNestedCount ?? 0) > 0
        ? `Top-level coverage is reconciled, but ${unsupportedNestedCount} nested Lazer slider score component(s) are not included in main-result accuracy.`
        : complete
        ? "All supplied beatmap objects are represented by reconstructed judgements."
        : "Excluded objects are reported separately and are not included in reconstructed accuracy.",
  };
}

function summarizeAimConsistency(evidence: ReplayAimEvidence | undefined): AimConsistencySummary {
  if (!evidence || evidence.samples.length === 0) {
    return {
      available: false,
      sampleCount: 0,
      eligibleEventCount: evidence?.eligibleEventCount ?? 0,
      coverage: evidence && evidence.eligibleEventCount > 0 ? 0 : null,
      meanDistancePx: null,
      p90DistancePx: null,
      meanRadiusFraction: null,
      reason: evidence?.unavailableReason ?? "Replay/beatmap cursor evidence was not supplied.",
    };
  }

  const distances = evidence.samples.map((sample) => sample.distance).sort((a, b) => a - b);
  const normalized = evidence.samples
    .filter((sample) => sample.objectRadius > 0)
    .map((sample) => sample.distance / sample.objectRadius);
  const sampleCount = evidence.samples.length;
  return {
    available: true,
    sampleCount,
    eligibleEventCount: evidence.eligibleEventCount,
    coverage: evidence.eligibleEventCount > 0 ? sampleCount / evidence.eligibleEventCount : null,
    meanDistancePx: distances.reduce((sum, distance) => sum + distance, 0) / sampleCount,
    p90DistancePx: percentile(distances, 0.9),
    meanRadiusFraction:
      normalized.length > 0 ? normalized.reduce((sum, distance) => sum + distance, 0) / normalized.length : null,
    reason:
      sampleCount === evidence.eligibleEventCount
        ? "Successful circle/head presses with explicit evaluator assignment."
        : `${sampleCount} of ${evidence.eligibleEventCount} eligible assigned presses had usable cursor evidence.`,
  };
}

export function analyzeFullMap({
  ruleset = "stable",
  events,
  hits,
  startTime = 0,
  duration,
  baseRate,
  aggregateAccuracyInput,
  aggregateJudgementCountsInput,
  objectCoverage,
  aimEvidence,
  maxComboObtained,
  mapMaxCombo,
}: FullMapAnalysisInput): FullMapAnalysisSummary {
  const safeDuration = isFiniteNumber(duration) && duration > 0 ? duration : 0;
  const safeStartTime = isFiniteNumber(startTime) ? clamp(startTime, 0, safeDuration) : 0;
  const judgements = uniqueJudgements(events, ruleset);
  const missedSliderIds = new Set(
    judgements.filter((judgement) => judgement.verdict === "MISS").map((judgement) => judgement.hitObjectId),
  );
  const sliderBreaks = ruleset === "stable" ? uniqueStableSliderBreaks(events, missedSliderIds) : [];
  const sliderComponentMisses = ruleset === "lazer" ? uniqueLazerSliderComponentMisses(events) : [];
  const eventCounts = stableJudgementCounts(judgements);
  const provenNotelockMissCount = judgements.filter(isNotelockMiss).length;
  // Aggregate replay totals are authoritative for the headline summary. Event-derived
  // judgements remain in use below for timing thirds, weak sections, and miss locations.
  const counts = normalizeAggregateJudgementCounts(aggregateJudgementCountsInput) ?? eventCounts;
  const timing = createTimingSummary(
    hits,
    judgements,
    sliderBreaks,
    sliderComponentMisses,
    safeDuration,
    baseRate,
    ruleset,
  );
  const sections = weakSections(
    judgements,
    sliderBreaks,
    sliderComponentMisses,
    timing.normalizedHits,
    safeDuration,
    timing.summary.unstableRate,
  );
  const aggregateAccuracy =
    aggregateAccuracyInput !== undefined &&
    aggregateAccuracyInput !== null &&
    Number.isFinite(aggregateAccuracyInput) &&
    aggregateAccuracyInput >= 0 &&
    aggregateAccuracyInput <= 1
      ? aggregateAccuracyInput
      : null;
  const summary: FullMapAnalysisSummary = {
    ruleset,
    startTime: safeStartTime,
    duration: safeDuration,
    baseRate,
    accuracy: aggregateAccuracy ?? stableAccuracy(counts),
    judgements: counts,
    errors: {
      missCount: counts.countMiss,
      // This is a causal subset of the authoritative main-miss headline, even
      // when reconstructed event coverage is noisier than replay aggregates.
      notelockMissCount: Math.min(counts.countMiss, provenNotelockMissCount),
      ...(ruleset === "stable"
        ? { sliderBreakCount: sliderBreaks.length }
        : { sliderComponentMissCount: sliderComponentMisses.length }),
      total: counts.countMiss + sliderBreaks.length + sliderComponentMisses.length,
    },
    maxComboObtained:
      maxComboObtained !== undefined && maxComboObtained !== null && Number.isFinite(maxComboObtained)
        ? Math.max(0, Math.trunc(maxComboObtained))
        : null,
    mapMaxCombo:
      mapMaxCombo !== undefined && mapMaxCombo !== null && Number.isFinite(mapMaxCombo)
        ? Math.max(0, Math.trunc(mapMaxCombo))
        : null,
    sliderMisses: {
      ...(ruleset === "lazer"
        ? {
            sliderTickMissCount: sliderComponentMisses.filter((event) => event.componentType !== "TAIL").length,
          }
        : {}),
      sliderEndMissCount:
        ruleset === "stable"
          ? standaloneStableSliderEndMisses(events).length
          : sliderComponentMisses.filter((event) => event.componentType === "TAIL").length,
    },
    timing: timing.summary,
    coverage: summarizeObjectCoverage(counts.total, objectCoverage),
    weakSections:
      ruleset === "stable"
        ? sections.map(({ sliderComponentMissCount: _componentMissCount, ...section }) => section)
        : sections.map(({ sliderBreakCount: _sliderBreakCount, ...section }) => section),
    aimConsistency: summarizeAimConsistency(aimEvidence),
  };
  return summary;
}
