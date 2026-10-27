import type { GameplayInfo } from "@osujs/core";
import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import type { PerformancePoint, PerformanceTimeline } from "@rewind/osu-performance/protocol";
import type { PerformanceMode, ReplayPerformanceInput } from "@rewind/osu-performance/types";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_PERFORMANCE_INPUT_VERSION, LIBRARY_RECONSTRUCTED_FC_VERSION,
  LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION, LIBRARY_TIMELINE_PROJECTION_VERSION } from "../../../../../shared/library-analysis";
import type { LibraryCompletion, LibraryMetricResult, LibraryMetricValue } from "../../../../../shared/replay-library-metrics";
import { validateLibraryErrorStrip } from "../../../../../shared/library-error-strip";
import type { LibraryErrorStrip } from "../../../../../shared/library-error-strip";
import type { FullMapTimingSummary } from "../analysis/full-map-analysis";
import type { LiveReplayStats } from "../analysis/live-replay-stats";
import type { FullMapPerformance } from "../analysis/performance/PerformanceTimelineService";
import { comboMetrics, completionMetric, performanceMetrics } from "./library-metrics";
import type { LibraryCompletionEvidence } from "./library-metrics";

export const LIBRARY_CURRENT_REPLAY_REUSE_VERSION = "library-current-replay-v1";

/** Captured with the completed viewer generation, never reconstructed from the selected row.
 * numericalInputKey is the resource descriptor's consumed-input key, including recording profile
 * and all effective mod settings. A selected comparison ruleset is not recording provenance. */
export interface CurrentReplayReuseBinding {
  replaySha256: string;
  mapSha256: string;
  mapMd5: string;
  numericalInputKey: string;
  mode: PerformanceMode;
  clockRate: number;
  objectCount: number;
  parserVersion: string;
  preparationVersion: string;
}

/** In-process admission token. Keep its identity; never serialize the borrowed performance graph. */
export interface CurrentReplayCaptureContext {
  readonly generation: number;
  readonly binding: Readonly<CurrentReplayReuseBinding>;
  readonly performanceInput: ReplayPerformanceInput;
}

/** Proof from the completed scoring-domain/component-coverage validation. Viewer presentation
 * counts alone cannot supply these flags or raw zero-combo losses. No cause evidence is needed. */
export interface CurrentReplayNumericalEvidence {
  coverageQualified: boolean;
  completeAccuracyEvidence: boolean;
  completeBreakEvidence: boolean;
  completion: LibraryCompletionEvidence;
  comboLosses: number | null;
  exactMapMaxCombo: number | null;
  conflicting?: boolean;
}

export interface CurrentReplayNumericalSnapshot {
  status: "complete" | "pending" | "unavailable";
  projectionVersion: string;
  evidence?: CurrentReplayNumericalEvidence;
  /** getFinalInfoForRuleset(recordingRuleset), not the playback cursor's current info. */
  info?: Pick<GameplayInfo, "accuracy" | "maxComboSoFar"> & { verdictCounts: readonly number[] };
  /** getFinalScoreStatsForRuleset(recordingRuleset), paired with completeAccuracyEvidence. */
  stats?: Pick<LiveReplayStats, "sliderBreakCount" | "sliderEndMissCount" | "sliderTickMissCount">;
  /** Already canonical full-map timing. Do not apply the clock rate a second time. */
  timing?: Pick<FullMapTimingSummary, "available" | "sampleCount" | "meanOffsetMs" | "unstableRate">;
  /** Optional already-projected bounded strip; never raw viewer events or a cause graph. */
  errorStrip?: LibraryMetricValue<LibraryErrorStrip>;
  /** Preferred viewer capture path: the existing numerical projector qualified retained state. */
  projected?: LibraryMetricResult;
}

export interface CurrentReplayProjectedNumericalSnapshot extends CurrentReplayNumericalSnapshot {
  status: "complete";
  projected: LibraryMetricResult;
}

/** Captured from the accepted engine response, without retaining its points array. */
export interface CurrentReplayPerformanceEndpoint extends Pick<PerformanceTimeline, "mode" | "objectCount" | "endpointVerified"> {
  pointCount: number;
  lastPoint?: PerformancePoint;
}

export interface CurrentReplayPerformanceSnapshot {
  engineVersion: string;
  inputVersion: string;
  timelineVersion: string;
  fcVersion: string;
  /** Borrowed current-generation input. Only its final endpoint is inspected; never copied. */
  input: ReplayPerformanceInput;
  /** fullMap(recordingRuleset). Ready does not imply fullComboPp has completed. */
  fullMap: FullMapPerformance;
  /** Required for timeline reuse: fullMap() alone can contain a synthetic empty-timeline zero. */
  timeline?: CurrentReplayPerformanceEndpoint;
  /** Independently captured from the FC response; absent while that request is pending. */
  fcTimeline?: CurrentReplayPerformanceEndpoint;
}

export interface CurrentReplayCompletedResults {
  binding: CurrentReplayReuseBinding;
  numerical?: CurrentReplayNumericalSnapshot;
  performance?: CurrentReplayPerformanceSnapshot;
}

export interface CurrentReplayMetricProjection {
  slot: "numerical" | "timeline-pp" | "fc-pp";
  stage: "S";
  producerVersion: string;
  metrics: LibraryMetricResult;
}
export type CurrentReplayReuseResult =
  | { state: "compatible"; projections: CurrentReplayMetricProjection[] }
  | { state: "incompatible"; reason: string; projections: [] };

const known = <T>(value: T): LibraryMetricValue<T> => ({ state: "known", value });
const unknown = <T>(reason = "current-replay-evidence-unavailable"): LibraryMetricValue<T> => ({ state: "unknown", reason });
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const countMetric = (value: unknown): LibraryMetricValue<number> => count(value) ? known(value) : unknown();
const bindingKeys = ["replaySha256", "mapSha256", "mapMd5", "numericalInputKey", "mode", "clockRate", "objectCount",
  "parserVersion", "preparationVersion"] as const;

export function isCurrentReplayReuseBinding(value: CurrentReplayReuseBinding): boolean {
  return /^[a-f0-9]{64}$/.test(value.replaySha256) && /^[a-f0-9]{64}$/.test(value.mapSha256) &&
    /^[a-f0-9]{32}$/.test(value.mapMd5) && /^[a-f0-9]{64}$/.test(value.numericalInputKey) &&
    ["stable", "lazer", "lazer-classic"].includes(value.mode) && nonnegative(value.clockRate) && value.clockRate > 0 &&
    count(value.objectCount) && value.objectCount > 0 && value.objectCount <= 100000 &&
    value.parserVersion === LIBRARY_REPLAY_PARSER_VERSION && value.preparationVersion === LIBRARY_RESOURCE_PREPARATION_VERSION;
}

const numericalFields = ["completion", "fc", "perfectCombo", "accuracy", "misses", "maxCombo", "comboLosses",
  "sliderBreaks", "sliderEndMisses", "sliderTickMisses", "sampleCount", "ur", "biasMs"] as const;

/** Copy only the authoritative numerical projector's compact output, never arbitrary extra fields. */
export function copyCurrentReplayNumericalProjection(binding: CurrentReplayReuseBinding, source: LibraryMetricResult): LibraryMetricResult | undefined {
  const profile = binding.mode === "stable" ? "stable" : "lazer", evidence = source.provenance;
  if (evidence.replaySha256 !== binding.replaySha256 || evidence.mapSha256 !== binding.mapSha256 || evidence.mapMd5 !== binding.mapMd5 ||
    evidence.ruleset !== profile || evidence.rate !== binding.clockRate || evidence.projectionVersion !== LIBRARY_NUMERIC_PROJECTION_VERSION ||
    evidence.completionEvidence !== "source-domain-coverage-v1" || typeof evidence.coverageQualified !== "boolean" ||
    typeof evidence.completeAccuracyEvidence !== "boolean" || typeof evidence.completeBreakEvidence !== "boolean") return undefined;
  const fields: LibraryMetricResult["fields"] = {};
  for (const name of numericalFields) {
    const value = source.fields[name];
    if (!value) { fields[name] = unknown(); continue; }
    if (value.state === "known") {
      const valid = name === "completion" ? value.value === "passed" || value.value === "failed"
        : name === "fc" || name === "perfectCombo" ? typeof value.value === "boolean"
        : name === "accuracy" ? nonnegative(value.value) && value.value <= 1
        : name === "biasMs" ? finite(value.value) : name === "ur" ? nonnegative(value.value) : count(value.value);
      if (!valid) return undefined;
      fields[name] = known(value.value);
    } else {
      if (!["unknown", "not-applicable", "error"].includes(value.state) || !/^[a-zA-Z0-9_.:/+-]{1,128}$/.test(value.reason)) return undefined;
      fields[name] = { state: value.state, reason: value.reason };
    }
  }
  const result: LibraryMetricResult = { fields, provenance: { ...provenance(binding, LIBRARY_NUMERIC_PROJECTION_VERSION, evidence.coverageQualified),
    ruleset: profile, completionEvidence: evidence.completionEvidence,
    completeAccuracyEvidence: evidence.completeAccuracyEvidence, completeBreakEvidence: evidence.completeBreakEvidence } };
  if (source.errorStrip !== undefined) {
    try {
      validateLibraryErrorStrip(source.errorStrip);
      if (source.errorStrip.state === "known" && (source.errorStrip.value.ruleset !== profile || !evidence.coverageQualified)) return undefined;
      result.errorStrip = JSON.parse(JSON.stringify(source.errorStrip)) as LibraryMetricValue<LibraryErrorStrip>;
    } catch { return undefined; }
  }
  return result;
}

function provenance(binding: CurrentReplayReuseBinding, projectionVersion: string, qualified: boolean) {
  return { replaySha256: binding.replaySha256, mapSha256: binding.mapSha256, mapMd5: binding.mapMd5,
    parserVersion: binding.parserVersion, preparationVersion: binding.preparationVersion,
    validationVersion: LIBRARY_CURRENT_REPLAY_REUSE_VERSION, projectionVersion, scoreOrigin: "reconstructed",
    coverageQualified: qualified, rate: binding.clockRate };
}

function matchesEndpoint(endpoint: CurrentReplayPerformanceEndpoint | undefined, binding: CurrentReplayReuseBinding,
  pointCount: number, time: number, pp: number | undefined, complete: boolean): boolean {
  return !!endpoint && endpoint.mode === binding.mode && endpoint.objectCount === binding.objectCount &&
    endpoint.endpointVerified === complete && endpoint.pointCount === pointCount && pointCount > 0 &&
    endpoint.lastPoint?.time === time && nonnegative(endpoint.lastPoint.pp) && endpoint.lastPoint.pp === pp &&
    nonnegative(endpoint.lastPoint.sr);
}

function projectNumerical(binding: CurrentReplayReuseBinding, snapshot: CurrentReplayNumericalSnapshot): LibraryMetricResult {
  const evidence = snapshot.evidence;
  const qualified = evidence?.coverageQualified === true;
  const countsAvailable = qualified && evidence?.completeAccuracyEvidence === true;
  const breaksAvailable = qualified && evidence?.completeBreakEvidence === true;
  const proof = evidence?.completion ?? {};
  const contradictoryCoverage = proof.coverage !== undefined && proof.coverage.expectedJudgements !== binding.objectCount;
  const completion = completionMetric({ ...proof,
    coverage: proof.coverage === undefined ? undefined : { ...proof.coverage,
      replayCoverage: qualified ? proof.coverage.replayCoverage : "unknown" },
    conflicting: proof.conflicting || evidence?.conflicting || contradictoryCoverage });
  const misses = countsAvailable ? snapshot.info?.verdictCounts[3] : undefined;
  const maxCombo = countsAvailable ? snapshot.info?.maxComboSoFar : undefined;
  const sliderBreaks = countsAvailable ? snapshot.stats?.sliderBreakCount : undefined;
  const comboLosses = breaksAvailable ? evidence?.comboLosses : undefined;
  const ruleset = binding.mode === "stable" ? "stable" : "lazer";
  const combo = comboMetrics({ completion, misses: count(misses) ? misses : null, maxCombo: count(maxCombo) ? maxCombo : null,
    comboLosses: count(comboLosses) ? comboLosses : null, completeBreakEvidence: breaksAvailable,
    exactMapMaxCombo: evidence?.exactMapMaxCombo ?? null, conflicting: evidence?.conflicting,
    ...(ruleset === "stable" ? { ruleset, sliderBreaks: count(sliderBreaks) ? sliderBreaks : null } : { ruleset }) });
  const accuracy = countsAvailable ? snapshot.info?.accuracy : undefined;
  const timing = qualified ? snapshot.timing : undefined;
  const timed = timing?.available === true && count(timing.sampleCount) && timing.sampleCount > 0;
  const metrics: LibraryMetricResult = {
    provenance: { ...provenance(binding, LIBRARY_NUMERIC_PROJECTION_VERSION, qualified), ruleset,
      completionEvidence: "source-domain-coverage-v1", completeAccuracyEvidence: countsAvailable, completeBreakEvidence: breaksAvailable },
    fields: { completion, ...combo, accuracy: nonnegative(accuracy) && accuracy <= 1 ? known(accuracy) : unknown(),
      misses: countMetric(misses), maxCombo: countMetric(maxCombo), comboLosses: countMetric(comboLosses),
      sliderBreaks: ruleset === "stable" ? countMetric(sliderBreaks) : { state: "not-applicable", reason: "stable-slider-breaks-only" },
      sliderEndMisses: countMetric(countsAvailable ? snapshot.stats?.sliderEndMissCount : undefined),
      sliderTickMisses: ruleset === "lazer" ? countMetric(countsAvailable ? snapshot.stats?.sliderTickMissCount : undefined)
        : { state: "not-applicable", reason: "native-slider-ticks-only" },
      sampleCount: countMetric(timing?.sampleCount),
      ur: timed && nonnegative(timing?.unstableRate) ? known(timing.unstableRate) : unknown("no-valid-timing-samples"),
      biasMs: timed && finite(timing?.meanOffsetMs) ? known(timing.meanOffsetMs) : unknown("no-valid-timing-samples") },
  };
  if (snapshot.errorStrip !== undefined) {
    try {
      validateLibraryErrorStrip(snapshot.errorStrip);
      if (snapshot.errorStrip.state === "known" && (!qualified || snapshot.errorStrip.value.ruleset !== ruleset))
        metrics.errorStrip = unknown("current-replay-strip-binding-unavailable");
      else {
        // The shared validator bounds this to 2048 marks / 64 KiB and rejects extra graph fields.
        metrics.errorStrip = JSON.parse(JSON.stringify(snapshot.errorStrip)) as LibraryMetricValue<LibraryErrorStrip>;
      }
    } catch {
      metrics.errorStrip = unknown("current-replay-strip-invalid");
    }
  }
  return metrics;
}

/** Synchronous reuse only: no traversal, scheduling, subscriptions, hashing or native calls.
 * The caller must capture both snapshots and their binding from the same completed viewer
 * generation, then recheck the current target through the store's normal transaction/CAS.
 * Absence of a projection means pending/incompatible, not a completed unavailable cache value. */
export function projectCurrentReplayResults(expected: CurrentReplayReuseBinding, completed: CurrentReplayCompletedResults): CurrentReplayReuseResult {
  if (!isCurrentReplayReuseBinding(expected) || !isCurrentReplayReuseBinding(completed.binding) || bindingKeys.some(key => expected[key] !== completed.binding[key]))
    return { state: "incompatible", reason: "current-replay-binding-mismatch", projections: [] };
  const binding = completed.binding;
  const projections: CurrentReplayMetricProjection[] = [];
  const snapshot = completed.numerical;
  if (snapshot?.status !== "complete" || snapshot.projectionVersion !== LIBRARY_NUMERIC_PROJECTION_VERSION)
    return { state: "compatible", projections };
  const numerical = snapshot.projected === undefined ? projectNumerical(binding, snapshot) : copyCurrentReplayNumericalProjection(binding, snapshot.projected);
  if (!numerical) return { state: "compatible", projections };
  projections.push({ slot: "numerical", stage: "S", producerVersion: LIBRARY_NUMERIC_PROJECTION_VERSION, metrics: numerical });
  const performance = completed.performance;
  if (!performance || performance.fullMap.status !== "ready" || performance.engineVersion !== PERFORMANCE_ENGINE_VERSION ||
    performance.inputVersion !== LIBRARY_PERFORMANCE_INPUT_VERSION || performance.timelineVersion !== LIBRARY_TIMELINE_PROJECTION_VERSION)
    return { state: "compatible", projections };
  if (!nonnegative(performance.fullMap.pp) || !nonnegative(performance.fullMap.peakPp) ||
    performance.fullMap.peakPp < performance.fullMap.pp)
    return { state: "compatible", projections };
  const input = performance.input, final = input.states[input.states.length - 1];
  // fullMap() has a presentation zero for an empty timeline. It is not a calculated zero.
  if (input.mode !== binding.mode || !final || final.isFinal !== true || !finite(input.finalReplayTime) ||
    final.time !== input.finalReplayTime || !count(final.passedObjects) || final.passedObjects < 1 || final.passedObjects > binding.objectCount)
    return { state: "compatible", projections };
  const complete = final.passedObjects === binding.objectCount;
  if (!matchesEndpoint(performance.timeline, binding, input.states.length, final.time, performance.fullMap.pp, complete))
    return { state: "compatible", projections };
  const qualified = numerical.provenance.coverageQualified === true;
  const observed = numerical.fields.completion;
  const completion: LibraryCompletion = qualified && observed.state === "known" && (observed.value === "passed" || observed.value === "failed")
    ? known(observed.value) : unknown("completion-not-established");
  const fc = input.fullComboState;
  const fcCovered = complete && fc?.isFinal === true && fc.time === input.finalReplayTime && fc.passedObjects === binding.objectCount;
  const values = performanceMetrics(completion, {
    pp: qualified && complete ? performance.fullMap.pp : undefined,
    peakPp: qualified ? performance.fullMap.peakPp : undefined,
    ppIfFc: qualified && fcCovered ? performance.fullMap.fullComboPp : undefined,
  });
  const performanceProvenance = (version: string) => ({ ...provenance(binding, version, qualified), ruleset: binding.mode,
    engineVersion: PERFORMANCE_ENGINE_VERSION });
  projections.push({ slot: "timeline-pp", stage: "S", producerVersion: LIBRARY_TIMELINE_PROJECTION_VERSION,
    metrics: { provenance: performanceProvenance(LIBRARY_TIMELINE_PROJECTION_VERSION), fields: { pp: values.pp, peakPp: values.peakPp } } });
  if (performance.fcVersion === LIBRARY_RECONSTRUCTED_FC_VERSION && performance.fullMap.fullComboPp !== undefined &&
    matchesEndpoint(performance.fcTimeline, binding, 1, input.finalReplayTime, performance.fullMap.fullComboPp, true))
    projections.push({ slot: "fc-pp", stage: "S", producerVersion: LIBRARY_RECONSTRUCTED_FC_VERSION,
      metrics: { provenance: performanceProvenance(LIBRARY_RECONSTRUCTED_FC_VERSION), fields: { ppIfFc: values.ppIfFc } } });
  return { state: "compatible", projections };
}
