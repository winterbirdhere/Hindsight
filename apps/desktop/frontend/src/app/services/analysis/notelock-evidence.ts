import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import type { CircleMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/CircleMechanisms";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import { matchErrorAtom } from "./error-atom-match";
import type { MissExplanationSessionState } from "./miss-explanation/MissExplanationSession";
import type { ReplayError } from "./replay-events";
import { matchingErrorAnalysisLookups, type ErrorAnalysisLookups } from "./error-analysis-lookups";

/** Only circle and slider-head mechanisms carry diagnostics; the classification list is typed by the base. */
const hasDiagnostics = (mechanism: ComponentMechanism): mechanism is CircleMechanism => "diagnostics" in mechanism;

/**
 * The single blocker the analysis proves for this error, or undefined.
 * Read only from the validated direct rejections of the error's own supported, notelock-only mechanism;
 * never from a headline, a time or a neighbouring error.
 */
export function analysisNotelockBlocker(
  error: ReplayError,
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
  session: MissExplanationSessionState | undefined,
  context?: ErrorAnalysisLookups,
): string | undefined {
  if (!session) return undefined;
  const lookups = matchingErrorAnalysisLookups(context, events, ruleset, session);
  const match = matchErrorAtom(error, events, ruleset, session, lookups);
  if (!match || match.atom.role !== "primary") return undefined;
  const classified = lookups
    ? lookups.classificationsByAtom.get(match.atom.id) ?? []
    : match.analysis.classifications.filter((entry) => entry.atomId === match.atom.id);
  if (classified.length !== 1) return undefined;
  const mechanism = classified[0].mechanism;
  // The lock must be the whole cause: a mechanism that also names another code (aim, timing) proves no link.
  const onlyNotelock = mechanism.codes.length === 1 && mechanism.codes[0] === "notelock";
  if (mechanism.status !== "supported" || !onlyNotelock || !hasDiagnostics(mechanism)) return undefined;
  const rejections = mechanism.diagnostics?.primary?.directRejections;
  if (!Array.isArray(rejections) || rejections.length === 0) return undefined;
  const blockerId = rejections[0]?.blockerId;
  if (typeof blockerId !== "string" || blockerId.length === 0) return undefined;
  return rejections.every((rejection) => rejection?.blockerId === blockerId) ? blockerId : undefined;
}
