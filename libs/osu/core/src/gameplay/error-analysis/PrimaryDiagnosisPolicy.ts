import { rankAttributionCandidates } from "./PrimaryAttribution";
import type { PressAttribution } from "./PrimaryAttribution";
import type { IndependentAimPair, PrimaryOpportunity } from "./PrimaryOpportunity";

/** Coaching policy, not a claim of unique human fault or numerical blame shares. */
export const PRIMARY_DIAGNOSIS_POLICY = Object.freeze({
  version: "primary-cause-v20",
  normalization: {
    placement: "observed distance/radius; never compared with timing",
    timing: "abs(offset)/best-window",
    arrival: "uncovered side of the best window/best-window",
  },
  aggregation:
    "recorded context then nearest press; geometric availability and common-window tolerance; certificate last",
  uncertainAttribution:
    "complete observations are marked; incomplete comparisons require a selected certificate",
  nearTieRatio: 0.8,
  nearTieDifference: 0.35,
  comparisonTolerance: 1e-12,
  maximumLabels: 2,
  maximumCandidates: 256,
  maximumInputs: 128,
});

export interface PrimaryCandidate {
  /** Recorded contextual roles and allocation coexistence, independent of a repair. */
  roleEvidence?: Pick<
    NonNullable<PrimaryCandidate["support"]>,
    "context" | "aimOpportunity" | "bestWindowAim"
  >;
  hypothesisIds?: Array<number | "raw-context">;
  /** A broad description formerly established only by its own repair. */
  requiresCertificate?: boolean;
  recordedFailure?: string;
  attribution?: PressAttribution;
  observationOnly?: boolean;
  code: string;
  headline: string;
  family: "placement" | "timing" | "arrival";
  /** Dimensionless departure using the declared family scale. */
  strength: number;
  /** Positive evidence independent of the competing cause, not merely an alternative repair. */
  independent: boolean;
  relationId: string;
  inputIds: string[];
  eventIds: string[];
  /** Bounded recorded geometry, excluding a separately reported source closure. */
  geometryWitnessEventIds?: string[];
  /** A broader source-run witness may be refined by measured morphology for
   * the exact same certified correction, despite different distance metrics. */
  placementBasis?: "moving-outside" | "beat-spanning-outside";
  sourceClosure?: {
    basis: "before-future-ordered-position-group";
    geometryEndInputId: string;
    timeMs: number;
    eventIds: string[];
  };
  /** Complete passage supporting this timing observation, when established. */
  timingPass?: { entryTimeMs: number; exitTimeMs: number };
  /** One uncensored receptor boundary can relate to several presses without
   * becoming several independent arrival mistakes. Source fences are part of
   * its identity; different passages retain their full comparison weight. */
  arrivalObservation?: {
    targetId: string;
    boundary: "entry" | "exit";
    boundaryTimeMs: number;
    entryTimeMs: number;
    exitTimeMs: number;
    eventIds: string[];
    sampledEventIds: string[];
    /** Exact canonical adjacent source pair for this uncensored boundary. */
    boundaryEventIds?: [string, string];
  };
  briefDetail?: { phrase: string; metric?: { value: number; unit: string } };
  metric?: { value: number; unit: string };
  support?: (
    | { correction: PrimaryOpportunity; sharedPass?: never; compound?: never }
    | {
        correction?: never;
        compound?: never;
        /** Every measured action has its own usable correction to this passage. */
        sharedPass: { entryTimeMs: number; exitTimeMs: number; corrections: PrimaryOpportunity[] };
      }
    | { correction?: never; sharedPass?: never; compound: IndependentAimPair }
  ) & {
    /** Raw context is a measured sequence comparison, not an ownership assignment. */
    hypothesisIds?: Array<number | "raw-context">;
    context?: {
      role: "cadence-continuation" | "failed-recovery" | "earlier-alternative";
      phaseMs: number;
      residualMs: number;
      eventIds: string[];
    };
    aimOpportunity?: {
      role: "initial-best-window" | "later-same-approach";
      initialInputId: string;
      laterInputId: string;
      eventIds: string[];
    };
    bestWindowAim?: {
      role: "best-window-aim" | "same-passage-alternative";
      inputId: string;
      entryTimeMs: number;
      exitTimeMs: number;
      eventIds: string[];
    };
  };
}

/** Compatibility entry points share one decision. Raw legacy magnitudes are
 * observations, not enough information to choose aim versus tapping. */
export function rankPrimaryCandidates(candidates: readonly PrimaryCandidate[], inputs?: readonly string[]) {
  return rankAttributionCandidates(candidates, inputs);
}
export function rankSupportedPrimaryCandidates(
  candidates: readonly PrimaryCandidate[],
  inputs?: readonly string[],
) {
  return rankAttributionCandidates(candidates, inputs);
}
/** @deprecated No production caller. Retained as a compatibility adapter for
 * allocation diagnostics; no duplicate min-score policy remains. */
export function rankPrimaryHypotheses(
  candidates: readonly PrimaryCandidate[],
  mandatory: readonly string[],
  alternatives: readonly string[],
) {
  const fixed = [...new Set(mandatory)],
    optional = [...new Set(alternatives)].filter((id) => !fixed.includes(id));
  const all = [...new Set([...fixed, ...optional])];
  const inputSets = optional.length
    ? [...(fixed.length ? [fixed] : []), ...optional.map((id) => [...fixed, id])]
    : [fixed];
  const hypotheses = inputSets.map((inputIds) => {
    const ranked = rankAttributionCandidates(
      candidates.filter((c) => c.inputIds.some((id) => inputIds.includes(id))),
      inputIds,
    );
    return { inputIds, primaryCodes: ranked.selected.map((c) => c.code), scores: ranked.scores };
  });
  return { ...rankAttributionCandidates(candidates, all), hypotheses };
}
