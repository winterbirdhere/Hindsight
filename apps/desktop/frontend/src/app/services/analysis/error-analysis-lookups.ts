import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import { drainSteps, drainStepsAsync } from "@osujs/core";
import type { ErrorAnalysis } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorAnalysis";
import type { MissExplanationSessionState } from "./miss-explanation/MissExplanationSession";

function* buckets<T>(items: readonly T[], key: (item: T) => string | undefined): Generator<void, ReadonlyMap<string, readonly T[]>, void> {
  const result = new Map<string, T[]>();
  let work = 0;
  for (const item of items) {
    if (++work % 256 === 0) yield;
    const id = key(item);
    if (id === undefined) continue;
    const entries = result.get(id);
    if (entries) entries.push(item);
    else result.set(id, [item]);
  }
  return result;
}

/** One synchronous projection batch. Arrays retain duplicates for the existing ambiguity checks. */
export function createErrorAnalysisLookups(
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
  session?: MissExplanationSessionState,
) {
  return drainSteps(createErrorAnalysisLookupSteps(events, ruleset, session));
}

export function createErrorAnalysisLookupsAsync(events: readonly ReplayAnalysisEvent[], ruleset: ReplayAnalysisRuleset,
  session: MissExplanationSessionState | undefined, checkpoint: () => Promise<void>) {
  return drainStepsAsync(createErrorAnalysisLookupSteps(events, ruleset, session), checkpoint);
}

export function* createErrorAnalysisLookupSteps(events: readonly ReplayAnalysisEvent[], ruleset: ReplayAnalysisRuleset,
  session?: MissExplanationSessionState) {
  const analysis: ErrorAnalysis | undefined =
    session && (session.status === "ready" || session.status === "partial") ? session.analysis : undefined;
  const excluded = new Set<string>(); let work = 0;
  for (const id of analysis?.excludedModelAtomIds ?? []) { excluded.add(id); if (++work % 256 === 0) yield; }
  return {
    events,
    ruleset,
    session,
    judgementsByObject: yield* buckets(events, (event) =>
      event.type === "HitObjectJudgement" ? event.hitObjectId : undefined,
    ),
    eventsById: yield* buckets(events, (event) => event.eventId),
    atomsById: yield* buckets(analysis?.inventory.atoms ?? [], (atom) => atom.id),
    atomsByComponent: yield* buckets(analysis?.inventory.atoms ?? [], (atom) => atom.componentId),
    classificationsByAtom: yield* buckets(analysis?.classifications ?? [], (entry) => entry.atomId),
    excluded,
  };
}

export type ErrorAnalysisLookups = ReturnType<typeof createErrorAnalysisLookups>;

/** Never reuse an index from another event stream, session or profile. Direct calls stay uncached. */
export function matchingErrorAnalysisLookups(
  lookups: ErrorAnalysisLookups | undefined,
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
  session?: MissExplanationSessionState,
): ErrorAnalysisLookups | undefined {
  return lookups?.events === events && lookups.ruleset === ruleset && lookups.session === session ? lookups : undefined;
}
