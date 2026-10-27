import { PrimaryCandidate } from "../src/gameplay/error-analysis/PrimaryDiagnosisPolicy";
import { PressAttribution } from "../src/gameplay/error-analysis/PrimaryAttribution";

/** Explicit already-certified per-press facts for testing the role adapter.
 * Model controls separately test that these certificates can be produced. */
export function decidedCandidate(code: string, inputId = "press", sequence = 10): PrimaryCandidate {
  const tapping = code === "early-tap" || code === "late-tap";
  const offset = code === "early-tap" ? -50 : tapping ? 50 : 0;
  const correction = {
    kind: tapping ? ("sampled-pass-tap" as const) : ("same-time-aim" as const),
    inputId,
    sampleId: tapping ? "sample:" + inputId : inputId,
    timeMs: tapping ? 1000 : 1000 + offset,
    eventIds: [inputId],
    prefix: { parentCount: 0 },
  };
  const attribution: PressAttribution = {
    inputId,
    channel: tapping ? "tapping" : "cursor",
    rule: tapping ? "only-tap-feasible" : "only-aim-feasible",
    tapOffsetMs: offset,
    bestWindowMs: 25,
    hitWindowMs: 109,
    tapTolerance: Math.abs(offset) / 25,
    cursorTolerance: tapping ? 0 : 2,
    cursorBoundaryIndex: undefined,
    nearTie: false,
    tapFeasible: tapping,
    aimFeasible: !tapping,
    grazeTapAvailable: false,
    grazeOnlyComparison: false,
    ...(tapping ? { tapCorrection: correction } : { aimCorrection: correction }),
    passes: tapping ? [{ entryMs: -25, exitMs: 25 }] : [],
    bestOverlapMs: tapping ? 50 : 0,
    narrowOverlap: false,
    feasibilityStatus: "certified",
    originalInside: false,
    clearOriginalPrefix: true,
    sourceSequence: sequence,
    roleEventIds: [],
    selectedCodes: [code],
  };
  return {
    code,
    headline: code,
    family: tapping ? "timing" : "placement",
    strength: 999,
    independent: true,
    relationId: code + ":" + inputId,
    inputIds: [inputId],
    eventIds: [inputId],
    support: { correction },
    attribution,
  };
}
