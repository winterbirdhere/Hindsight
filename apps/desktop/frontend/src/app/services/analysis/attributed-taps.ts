import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import type { CircleMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/CircleMechanisms";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import type { ReplayTrace } from "../../../../../../../libs/osu/core/src/gameplay/trace/ReplayTrace";
import { matchErrorAtom } from "./error-atom-match";
import type { MissExplanationSessionState } from "./miss-explanation/MissExplanationSession";
import type { ReplayError } from "./replay-events";

/** A tap the analysis ties to an error's own object, as the replay trace recorded it. */
export interface AttributedTap {
  inputId: string;
  /** Map time of the input. */
  timeMs: number;
  /** Where the cursor was, in osu! pixels. */
  position: { x: number; y: number };
  /** Attributed: the analysis calls the input relevant to this object. Ambiguous: it could be a neighbour's. */
  certainty: "attributed" | "ambiguous";
}

/** Only circle and slider-head mechanisms carry diagnostics; the classification list is typed by the base. */
const hasDiagnostics = (mechanism: ComponentMechanism): mechanism is CircleMechanism => "diagnostics" in mechanism;

type InputRecord = Extract<ReplayTrace["records"][number], { kind: "input" }>;
// A session's trace is sealed, so its inputs are indexed once.
const inputIndexes = new WeakMap<ReplayTrace, Map<string, InputRecord>>();
function inputsById(trace: ReplayTrace): Map<string, InputRecord> {
  let index = inputIndexes.get(trace);
  if (!index) {
    index = new Map();
    for (const record of trace.records) if (record.kind === "input") index.set(record.id, record);
    inputIndexes.set(trace, index);
  }
  return index;
}

/** The one cause the analysis supports for this error's own component, if it has exactly one. */
function ownMechanism(
  error: ReplayError,
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
  session: MissExplanationSessionState | undefined,
): ComponentMechanism | undefined {
  if (!session || (session.status !== "ready" && session.status !== "partial")) return undefined;
  const match = matchErrorAtom(error, events, ruleset, session);
  if (!match || match.atom.role !== "primary") return undefined;
  const classified = match.analysis.classifications.filter((entry) => entry.atomId === match.atom.id);
  if (classified.length !== 1) return undefined;
  const mechanism = classified[0].mechanism;
  return mechanism.status === "supported" ? mechanism : undefined;
}

// The causes that are about where the cursor was: on a circle, and along a slider.
const AIM_CODES: ReadonlySet<string> = new Set([
  "overshoot",
  "undershoot",
  "wide-aim",
  "misaim",
  "aim-late",
  "left-early",
  "between-passes",
  "off-target",
  "edge-miss",
  "off-track",
  "late-pickup",
  "turned-early",
  "ran-ahead",
  "fell-behind",
]);

/**
 * Whether the cause the analysis gives this error is about aim or about something else (timing, a tap that never
 * came, a notelock). Undefined when the analysis supports no single cause for it: then nothing is known.
 */
export function analysisCauseKind(
  error: ReplayError,
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
  session: MissExplanationSessionState | undefined,
): "aim" | "other" | undefined {
  const codes = ownMechanism(error, events, ruleset, session)?.codes;
  if (!Array.isArray(codes) || codes.length === 0) return undefined;
  return codes.some((code) => AIM_CODES.has(code)) ? "aim" : "other";
}

/**
 * The taps the analysis attributes to this error, oldest first. They are read only from the input association of
 * the error's own supported mechanism: never from a time, a distance or a neighbouring error. An input the analysis
 * gave to another note is not returned, however close it is; an error with no such input returns nothing.
 */
export function analysisAttributedTaps(
  error: ReplayError,
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
  session: MissExplanationSessionState | undefined,
): AttributedTap[] {
  if (!session || (session.status !== "ready" && session.status !== "partial")) return [];
  const mechanism = ownMechanism(error, events, ruleset, session);
  if (!mechanism || !hasDiagnostics(mechanism)) return [];
  const association = mechanism.diagnostics?.primary?.association;
  if (!association || !Array.isArray(association.associations)) return [];
  // The analysis itself withdraws the diagnosis when its input association does not fit the trace.
  const limitations = Array.isArray(association.limitations) ? association.limitations : [];
  if (limitations.includes("trace-identity-mismatch") || limitations.includes("invalid-trace-index")) return [];

  const inputs = inputsById(session.trace);
  const taps = new Map<string, AttributedTap>();
  for (const entry of association.associations) {
    if (entry?.role !== "relevant" && entry?.role !== "ambiguous") continue;
    const record = inputs.get(entry.inputId);
    const position = record?.position;
    if (!record || !Number.isFinite(record.timeMs) || !Number.isFinite(position?.x) || !Number.isFinite(position?.y)) {
      continue;
    }
    // Listed under both roles: the weaker claim stands.
    const ambiguous = entry.role === "ambiguous" || taps.get(record.id)?.certainty === "ambiguous";
    taps.set(record.id, {
      inputId: record.id,
      timeMs: record.timeMs,
      position: { x: record.position.x, y: record.position.y },
      certainty: ambiguous ? "ambiguous" : "attributed",
    });
  }
  return [...taps.values()].sort((a, b) => a.timeMs - b.timeMs);
}
