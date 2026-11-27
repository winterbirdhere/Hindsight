import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import { matchErrorAtom } from "../../services/analysis/error-atom-match";
import type { MissExplanationSessionState } from "../../services/analysis/miss-explanation/MissExplanationSession";
import type { ReplayError } from "../../services/analysis/replay-events";
import {
  matchingErrorAnalysisLookups,
  type ErrorAnalysisLookups,
} from "../../services/analysis/error-analysis-lookups";

export function selectedErrorCauses(
  error: ReplayError | undefined,
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
  session: MissExplanationSessionState,
  context?: ErrorAnalysisLookups,
): readonly ComponentMechanism[] {
  const lookups = matchingErrorAnalysisLookups(context, events, ruleset, session);
  const match = matchErrorAtom(error, events, ruleset, session, lookups);
  if (!match) return [];
  const { atom, analysis } = match,
    excluded = lookups?.excluded ?? new Set(analysis.excludedModelAtomIds);
  const atomsFor = (id: string) =>
    lookups ? lookups.atomsById.get(id) ?? [] : analysis.inventory.atoms.filter((a) => a.id === id);
  const classifiedFor = (id: string) =>
    lookups ? lookups.classificationsByAtom.get(id) ?? [] : analysis.classifications.filter((c) => c.atomId === id);
  if (atom.role === "consequence") {
    const classified = classifiedFor(atom.id);
    const ranked = classified[0]?.mechanism,
      proof = ranked?.parentEvidence;
    if (proof) {
      if (
        classified.length !== 1 ||
        ranked.status !== "supported" ||
        proof.parentAtomId !== atom.id ||
        proof.parentEventId !== atom.eventId ||
        proof.profileFingerprint !== atom.identity.analysisProfileFingerprint ||
        proof.contributions.length !== atom.relatedAtomIds.length ||
        new Set(proof.contributions.map((c) => c.atomId)).size !== proof.contributions.length ||
        atom.pendingContributionIds.some(
          (id) =>
            !proof.contributions.some(
              (c) => c.componentId === id && c.certification === "head-opportunity-before-parent",
            ) && proof.pendingHeadContribution?.componentId !== id,
        ) ||
        (proof.pendingHeadContribution &&
          (!atom.pendingContributionIds.includes(proof.pendingHeadContribution.componentId) ||
            proof.pendingHeadContribution.parentEventId !== atom.eventId ||
            proof.pendingHeadContribution.opportunityEnd?.eventId !== atom.eventId ||
            proof.pendingHeadContribution.opportunityEnd.inclusive ||
            !proof.pendingHeadContribution.eventIds.length ||
            (lookups
              ? lookups.atomsByComponent.get(proof.pendingHeadContribution.componentId) ?? []
              : analysis.inventory.atoms
            ).some(
              (a) => a.componentId === proof.pendingHeadContribution?.componentId && a.parentId === atom.parentId,
            ))) ||
        proof.contributions.some((c) => {
          const linked = atomsFor(c.atomId);
          const entries = classifiedFor(c.atomId);
          return (
            !atom.relatedAtomIds.includes(c.atomId) ||
            excluded.has(c.atomId) ||
            linked.length !== 1 ||
            linked[0].parentId !== atom.parentId ||
            linked[0].componentId !== c.componentId ||
            linked[0].eventId !== c.resolutionId ||
            entries.length !== 1 ||
            entries[0].mechanism.status !== "supported"
          );
        })
      )
        return [];
      return [ranked];
    }
  }
  const ids = atom.role === "consequence" ? atom.relatedAtomIds : [atom.id];
  if (!ids.length || (atom.role === "consequence" && atom.pendingContributionIds.length)) return [];
  const mechanisms: ComponentMechanism[] = [];
  for (const id of ids) {
    const linked = atomsFor(id);
    if (excluded.has(id) || linked.length !== 1 || linked[0].parentId !== atom.parentId || linked[0].role !== "primary")
      return [];
    const entries = classifiedFor(id);
    if (entries.length !== 1 || entries[0].mechanism.status !== "supported") return [];
    mechanisms.push(entries[0].mechanism);
  }
  return mechanisms;
}
