import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import type { MissExplanationSessionState } from "../../services/analysis/miss-explanation/MissExplanationSession";
import type { ReplayError } from "../../services/analysis/replay-events";
import { selectedErrorCauses } from "./error-cause";
import { createErrorAnalysisLookups } from "../../services/analysis/error-analysis-lookups";
import { presentCause } from "./error-cause-presentation";

export type ErrorCauseFamily = "aim" | "tapping" | "notelock";

/** Errors of one row, split by what kind of error they are (for the bar's colours). */
export interface ErrorCauseCount {
  total: number;
  miss: number;
  slider: number;
}

/** One cause of a family and the errors that have it, named by the text the inspector shows for those errors. */
export interface ErrorCauseBreakdownRow {
  label: string;
  count: ErrorCauseCount;
}

export type FullMapErrorCauses =
  | {
      status: "ready";
      total: number;
      families: Record<ErrorCauseFamily, ErrorCauseCount>;
      /** Each family's errors by cause: most errors first, then by label. The rows add up to the family's count. */
      breakdown: Record<ErrorCauseFamily, readonly ErrorCauseBreakdownRow[]>;
      /** Errors the replay view shows no cause for. */
      none: ErrorCauseCount;
    }
  | { status: "analyzing" }
  | { status: "unavailable"; reason: "other-ruleset" | "unavailable" };

/** The cause codes the error analysis assigns, by the family the page counts them under. */
export const ERROR_CAUSE_FAMILY_CODES: Readonly<Record<ErrorCauseFamily, readonly string[]>> = {
  aim: [
    "overshoot",
    "undershoot",
    "wide-aim",
    "misaim",
    "edge-miss",
    "off-target",
    "aim-late",
    "left-early",
    "between-passes",
    "off-track",
    "ran-ahead",
    "fell-behind",
    "turned-early",
    "late-pickup",
    "no-spin",
    "slow-spin",
    "stopped-early",
    "reversed-spin",
  ],
  tapping: [
    "early-tap",
    "late-tap",
    "off-beat",
    "slow-tapping",
    "no-tap",
    "no-hold",
    "wrong-hold",
    "released-early",
    "hold-interrupted",
    "started-late",
  ],
  notelock: ["notelock", "out-of-order"],
};

/**
 * The family an error is counted under. An error with causes from two families counts once, Aim first, then
 * Notelock: the order the app already uses to decide which misses get an aim trail.
 */
export function errorCauseFamily(codes: readonly string[]): ErrorCauseFamily | undefined {
  for (const family of ["aim", "notelock", "tapping"] as const)
    if (codes.some((code) => ERROR_CAUSE_FAMILY_CODES[family].includes(code))) return family;
  return undefined;
}

/** What the simulator gives as the reason when the page shows the ruleset the replay was not played in. */
const CROSS_RULESET_REASON = "cross-rules-profile-not-captured";

/** How the session reads on the page's ruleset, in the replay view's terms; `ready` means its causes can be read. */
function sessionStatus(
  session: MissExplanationSessionState | undefined,
  ruleset: ReplayAnalysisRuleset,
): "ready" | "analyzing" | "other-ruleset" | "unavailable" {
  if (!session) return "analyzing";
  switch (session.status) {
    case "ready":
    case "partial":
      return session.identity.analysisProfileId === ruleset ? "ready" : "other-ruleset";
    case "unsupported":
      return session.reasons.includes(CROSS_RULESET_REASON) ? "other-ruleset" : "unavailable";
    case "error":
      return "unavailable";
    default:
      // Building, empty or not yet captured. The simulator gives the cross-rules reason to any ruleset with no
      // session yet, the replay's own included, so on its own it does not mean the other ruleset.
      return "analyzing";
  }
}

const emptyCount = (): ErrorCauseCount => ({ total: 0, miss: 0, slider: 0 });

/**
 * How many of the replay's errors the replay view gives an Aim, a Tapping or a Notelock cause. Each error's cause is
 * the one the inspector shows, so the page and the inspector cannot disagree; an error the inspector shows no cause
 * for counts as `none`.
 */
export function summarizeErrorCauses(input: {
  errors: readonly ReplayError[];
  events: readonly ReplayAnalysisEvent[];
  ruleset: ReplayAnalysisRuleset;
  session: MissExplanationSessionState | undefined;
}): FullMapErrorCauses {
  const { errors, events, ruleset, session } = input;
  const status = sessionStatus(session, ruleset);
  if (!session || status === "analyzing") return { status: "analyzing" };
  if (status !== "ready") return { status: "unavailable", reason: status };

  const families: Record<ErrorCauseFamily, ErrorCauseCount> = {
    aim: emptyCount(),
    tapping: emptyCount(),
    notelock: emptyCount(),
  };
  const none = emptyCount();
  const lookups = createErrorAnalysisLookups(events, ruleset, session);
  const causeRows: Record<ErrorCauseFamily, Map<string, ErrorCauseCount>> = {
    aim: new Map(),
    tapping: new Map(),
    notelock: new Map(),
  };
  let total = 0;
  for (const error of errors) {
    // A player error is a miss or a slider break; anything else is not one of the errors counted here.
    const kind = error.type === "MISS" ? "miss" : error.type === "ANALYSIS_ERROR" ? undefined : "slider";
    if (!kind) continue;
    const mechanisms = selectedErrorCauses(error, events, ruleset, session, lookups);
    const presentation = presentCause(mechanisms);
    const family = presentation ? errorCauseFamily(mechanisms.flatMap((mechanism) => mechanism.codes)) : undefined;
    const count = family ? families[family] : none;
    count.total++;
    count[kind]++;
    total++;
    if (presentation && family) {
      // The row is the headline the inspector writes for this error, joined the way it joins two labels.
      const label = presentation.labels.join(" · ");
      const row = causeRows[family].get(label) ?? emptyCount();
      row.total++;
      row[kind]++;
      causeRows[family].set(label, row);
    }
  }
  const rowsOf = (family: ErrorCauseFamily): ErrorCauseBreakdownRow[] =>
    [...causeRows[family]]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count.total - a.count.total || (a.label < b.label ? -1 : 1));
  const breakdown = { aim: rowsOf("aim"), tapping: rowsOf("tapping"), notelock: rowsOf("notelock") };
  return { status: "ready", total, families, breakdown, none };
}
