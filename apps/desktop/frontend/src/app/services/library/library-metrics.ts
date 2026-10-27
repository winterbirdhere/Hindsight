import type { ReplayAnalysisRuleset } from "@osujs/core";
import { canonicalReplayTiming, GameSimulatorHit } from "../analysis/full-map-analysis";
import type { LibraryCompletion, LibraryMetricValue } from "../../../../../shared/replay-library-metrics";

export { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../../shared/library-analysis";
const known = <T>(value: T): LibraryMetricValue<T> => ({ state: "known", value });
const unknown = <T>(reason: string): LibraryMetricValue<T> => ({ state: "unknown", reason });
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export interface LibraryCompletionEvidence {
  sourcePassed?: boolean;
  sourceVerified?: boolean;
  conflicting?: boolean;
  coverage?: {
    exactMapAndProfile: boolean;
    expectedJudgements: number;
    observedJudgements: number;
    /** Actual scoring-terminal evidence, not a simulator advanced to the end of the map. */
    terminalJudgementObserved: boolean;
    /** A final replay-frame timestamp alone cannot establish this. */
    replayCoverage: "complete" | "partial" | "unknown";
  };
}

export function completionMetric(evidence: LibraryCompletionEvidence): LibraryCompletion {
  if (evidence.conflicting) return unknown("conflicting-completion-evidence");
  const coverage = evidence.coverage;
  const covered = !!coverage && coverage.exactMapAndProfile && count(coverage.expectedJudgements) && coverage.expectedJudgements > 0 &&
    count(coverage.observedJudgements) && coverage.observedJudgements === coverage.expectedJudgements &&
    coverage.terminalJudgementObserved && coverage.replayCoverage === "complete";
  if (evidence.sourceVerified && typeof evidence.sourcePassed === "boolean") {
    if (!evidence.sourcePassed && covered) return unknown("conflicting-completion-evidence");
    return known(evidence.sourcePassed ? "passed" : "failed");
  }
  return covered ? known("passed") : unknown("completion-not-established");
}

interface LibraryComboCommon {
  completion: LibraryCompletion;
  misses: number | null;
  /** All combo-loss outcomes, including suppressed presentation counters at zero combo. Native
   * tails/Classic small ticks do not enter this count; native main/large-tick misses do. */
  comboLosses: number | null;
  completeBreakEvidence: boolean;
  maxCombo: number | null;
  exactMapMaxCombo: number | null;
  conflicting?: boolean;
}
export type LibraryComboEvidence = LibraryComboCommon & (
  | { ruleset: "stable"; sliderBreaks: number | null }
  | { ruleset: "lazer"; sliderBreaks?: never }
);
export function comboMetrics(input: LibraryComboEvidence): { fc: LibraryMetricValue<boolean>; perfectCombo: LibraryMetricValue<boolean> } {
  const comboConflict = input.conflicting || (count(input.maxCombo) && count(input.exactMapMaxCombo) &&
    input.exactMapMaxCombo > 0 && input.maxCombo > input.exactMapMaxCombo);
  // Exact combo equality is independent of pass/break evidence. Callers retain the source
  // provenance of these counts; this comparison does not turn reconstructed counts into recorded ones.
  const perfectCombo = comboConflict ? unknown<boolean>("conflicting-combo-evidence")
    : count(input.maxCombo) && count(input.exactMapMaxCombo) && input.exactMapMaxCombo > 0
      ? known(input.maxCombo === input.exactMapMaxCombo) : unknown<boolean>("exact-map-combo-unavailable");
  const unresolved = (reason: string) => ({ fc: unknown<boolean>(reason), perfectCombo });
  if (input.completion.state !== "known") return unresolved("completion-not-established");
  if (input.completion.value === "failed") return {
    fc: { state: "not-applicable", reason: "failed-replay" }, perfectCombo,
  };
  if (comboConflict) return unresolved("conflicting-combo-evidence");
  if (!count(input.misses) || !count(input.comboLosses) || !input.completeBreakEvidence ||
    (input.ruleset === "stable" && !count(input.sliderBreaks)))
    return unresolved("complete-break-evidence-unavailable");
  const fc = input.misses === 0 && input.comboLosses === 0 && (input.ruleset === "lazer" || input.sliderBreaks === 0);
  return { fc: known(fc), perfectCombo };
}

/** Inputs are independently completed P/S outputs. No function here starts or requires C work. */
export function performanceMetrics(completion: LibraryCompletion, input: { pp?: number | null; ppIfFc?: number | null; peakPp?: number | null }): {
  pp: LibraryMetricValue<number>; ppIfFc: LibraryMetricValue<number>; peakPp: LibraryMetricValue<number>;
} {
  const value = (number: unknown) => finite(number) ? known(number) : unknown<number>("performance-data-unavailable");
  if (completion.state !== "known") return { pp: unknown("completion-not-established"), ppIfFc: unknown("completion-not-established"), peakPp: value(input.peakPp) };
  if (completion.value === "failed") return { pp: { state: "not-applicable", reason: "failed-no-pp-awarded" },
    ppIfFc: { state: "not-applicable", reason: "failed-no-fc-estimate" }, peakPp: value(input.peakPp) };
  return { pp: value(input.pp), ppIfFc: value(input.ppIfFc), peakPp: value(input.peakPp) };
}

export function timingMetrics(hits: readonly GameSimulatorHit[], rate: number, ruleset: ReplayAnalysisRuleset): {
  sampleCount: number; ur: LibraryMetricValue<number>; biasMs: LibraryMetricValue<number>;
} {
  const result = canonicalReplayTiming(hits, rate, ruleset);
  return { sampleCount: result.sampleCount,
    ur: result.unstableRate !== null && Number.isFinite(result.unstableRate) ? known(result.unstableRate) : unknown("no-valid-timing-samples"),
    biasMs: result.meanOffsetMs !== null && Number.isFinite(result.meanOffsetMs) ? known(result.meanOffsetMs) : unknown("no-valid-timing-samples") };
}
