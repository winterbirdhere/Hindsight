import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import type { ErrorAnalysis } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorAnalysis";
import type { ErrorAtom } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorInventory";
import type { MissExplanationSessionState } from "./miss-explanation/MissExplanationSession";
import type { ReplayError } from "./replay-events";
import { matchingErrorAnalysisLookups, type ErrorAnalysisLookups } from "./error-analysis-lookups";

export interface ErrorAtomMatch {
  atom: ErrorAtom;
  event: ReplayAnalysisEvent;
  analysis: ErrorAnalysis;
}

/**
 * The one analysis atom that belongs to a navigation error, by exact event, component, profile and time.
 * Undefined when the session is not captured for this profile or the match is missing, ambiguous or excluded.
 */
export function matchErrorAtom(
  error: ReplayError | undefined,
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
  session: MissExplanationSessionState,
  context?: ErrorAnalysisLookups,
): ErrorAtomMatch | undefined {
  if (
    !error ||
    (session.status !== "ready" && session.status !== "partial") ||
    session.identity.analysisProfileId !== ruleset ||
    !session.analysis
  )
    return undefined;
  const analysis = session.analysis;
  const lookups = matchingErrorAnalysisLookups(context, events, ruleset, session);
  const eventCandidates = lookups
    ? (error.type === "MISS"
        ? lookups.judgementsByObject.get(error.hitObjectId ?? "")
        : lookups.eventsById.get(error.id)) ?? []
    : events;
  // Navigation owns event identity/order/time. A grouped incident can span later
  // components, so it must never supply the selected component's cause by proximity.
  const candidates = eventCandidates.filter((event) => {
    if (event.ruleset !== undefined && event.ruleset !== ruleset) return false;
    if (error.type === "MISS")
      return (
        event.type === "HitObjectJudgement" &&
        event.hitObjectId === error.hitObjectId &&
        event.verdict === "MISS" &&
        event.affectsAccuracy !== false &&
        (!event.isSliderHead || event.ruleset === "lazer")
      );
    return (
      event.eventId === error.id &&
      ((error.type === "SLIDER_BREAK" && event.type === "SliderBreak") ||
        (error.type === "SLIDER_COMPONENT_MISS" &&
          event.type === "SliderComponentMiss" &&
          event.componentType !== "TAIL"))
    );
  });
  if (candidates.length !== 1) return undefined;
  const event = candidates[0];
  if ((event.objectTime ?? event.time) !== error.time) return undefined;
  const componentId =
    event.type === "HitObjectJudgement"
      ? event.hitObjectId
      : event.type === "SliderBreak" || event.type === "SliderComponentMiss"
      ? event.componentId
      : undefined;
  const expectedComponent =
    event.type === "SliderBreak" || event.type === "SliderComponentMiss"
      ? { HEAD: "slider-head", TICK: "slider-tick", REPEAT: "slider-repeat", TAIL: "slider-end" }[event.componentType]
      : undefined;
  const atomCandidates = lookups ? lookups.atomsByComponent.get(componentId ?? "") ?? [] : analysis.inventory.atoms;
  const atoms = atomCandidates.filter(
    (atom) =>
      atom.componentId === componentId &&
      atom.result === "MISS" &&
      atom.identity.analysisProfileId === ruleset &&
      atom.resolutionTimeMs === (event.judgementTime ?? event.time) &&
      (expectedComponent
        ? atom.component === expectedComponent && atom.parentId === error.sliderId
        : ["circle", "slider-head", "slider-parent", "spinner"].includes(atom.component)) &&
      // Stable parent-MISS navigation seeks the slider start; its scoring atom
      // records the end. Preserve both meanings rather than replacing the seek time.
      (atom.component === "slider-parent" || atom.objectTimeMs === error.time),
  );
  if (atoms.length !== 1) return undefined;
  const atom = atoms[0];
  if (lookups ? lookups.excluded.has(atom.id) : analysis.excludedModelAtomIds.includes(atom.id)) return undefined;
  return { atom, event, analysis };
}
