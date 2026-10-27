import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import { drainSteps, drainStepsAsync, stableSortSteps } from "@osujs/core";
import type { MissExplanationSessionState } from "./miss-explanation/MissExplanationSession";
import { analysisNotelockBlocker } from "./notelock-evidence";
import type { ReplayError } from "./replay-events";
import {
  createErrorAnalysisLookupSteps,
  matchingErrorAnalysisLookups,
  type ErrorAnalysisLookups,
} from "./error-analysis-lookups";

export type IncidentLinkKind = "notelock";
/** Who proved the link: the simulator's own notelock event, or the ready analysis of the same profile. */
export type IncidentLinkSource = "simulator" | "analysis";
/** A proven causal link between two navigation errors; `from` is the earlier error index. */
export interface IncidentLink {
  from: number;
  to: number;
  kind: IncidentLinkKind;
  source: IncidentLinkSource;
}
/** A display grouping of causally linked errors. Never built from time windows or adjacency. */
export interface Incident {
  id: string;
  errorIndices: number[];
  leadIndex: number;
  links: IncidentLink[];
}

type Judgement = Extract<ReplayAnalysisEvent, { type: "HitObjectJudgement" }>;
const inRuleset = (event: ReplayAnalysisEvent, ruleset: ReplayAnalysisRuleset) =>
  event.ruleset === undefined || event.ruleset === ruleset;

/** The one missed judgement that belongs to this error, when the simulator recorded exactly one. */
function missJudgement(
  error: ReplayError,
  ruleset: ReplayAnalysisRuleset,
  lookups: ErrorAnalysisLookups,
): Judgement | undefined {
  let hitObjectId: string | undefined;
  let scoringOnly = false;
  if (error.type === "MISS") {
    hitObjectId = error.hitObjectId;
    scoringOnly = true;
  } else if (error.type === "SLIDER_COMPONENT_MISS") {
    const components = (lookups.eventsById.get(error.id) ?? []).filter(
      (event) => event.type === "SliderComponentMiss" && event.eventId === error.id && inRuleset(event, ruleset),
    );
    if (components.length === 1 && components[0].type === "SliderComponentMiss")
      hitObjectId = components[0].componentId;
  }
  if (!hitObjectId) return undefined;
  const judgements = (lookups.judgementsByObject.get(hitObjectId) ?? []).filter(
    (event): event is Judgement =>
      event.type === "HitObjectJudgement" &&
      event.hitObjectId === hitObjectId &&
      event.verdict === "MISS" &&
      inRuleset(event, ruleset) &&
      (!scoringOnly || event.affectsAccuracy !== false),
  );
  return judgements.length === 1 ? judgements[0] : undefined;
}

/**
 * An error owns a blocker only when it is that object (or, for a slider head, the head or the slider itself).
 * A tick or repeat error of the same slider never owns a head blocker.
 */
function ownsBlocker(error: ReplayError, blockerId: string): boolean {
  if (error.hitObjectId === blockerId) return true;
  const sliderId = blockerId.endsWith("/HEAD") ? blockerId.slice(0, -"/HEAD".length) : blockerId;
  if (error.hitObjectId === sliderId || error.hitObjectId === `${sliderId}/HEAD`) return true;
  return error.type === "SLIDER_COMPONENT_MISS" && error.sliderComponentType === "HEAD" && error.sliderId === sliderId;
}

/** The latest earlier error that owns the blocker, or -1. */
function* blockerOwner(errors: readonly ReplayError[], to: number, blockerId: string): Generator<void, number, void> {
  let work = 0;
  for (let from = to - 1; from >= 0; from--) {
    if (++work % 256 === 0) yield;
    if (ownsBlocker(errors[from], blockerId)) return from;
  }
  return -1;
}

/**
 * Simulator evidence first. The analysis is asked only for an error the simulator recorded no notelock for
 * (a Stable slider-head break never has one), so it can add a link but never replace or contradict one.
 */
function* notelockLinks(
  errors: readonly ReplayError[],
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
  session: MissExplanationSessionState | undefined,
  lookups: ErrorAnalysisLookups,
): Generator<void, IncidentLink[], void> {
  const links: IncidentLink[] = [];
  for (let to = 0; to < errors.length; to++) {
    if (to % 256 === 0) yield;
    const error = errors[to];
    const simulatorBlocker = missJudgement(error, ruleset, lookups)?.notelockCause?.blockerHitObjectId;
    const source: IncidentLinkSource = simulatorBlocker ? "simulator" : "analysis";
    const blockerId = simulatorBlocker ?? analysisNotelockBlocker(error, events, ruleset, session, lookups);
    if (!blockerId) continue;
    const from = yield* blockerOwner(errors, to, blockerId);
    if (from >= 0) links.push({ from, to, kind: "notelock", source });
  }
  return links;
}

export function groupIncidents(
  errors: readonly ReplayError[],
  events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset,
  /** Absent, pending, failed or of another profile: the grouping is the simulator's alone. */
  session?: MissExplanationSessionState,
  context?: ErrorAnalysisLookups,
): Incident[] {
  return drainSteps(groupIncidentSteps(errors, events, ruleset, session, context));
}

export function groupIncidentsAsync(errors: readonly ReplayError[], events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset, session: MissExplanationSessionState | undefined,
  checkpoint: () => Promise<void>, context?: ErrorAnalysisLookups): Promise<Incident[]> {
  return drainStepsAsync(groupIncidentSteps(errors, events, ruleset, session, context), checkpoint);
}

function* groupIncidentSteps(errors: readonly ReplayError[], events: readonly ReplayAnalysisEvent[],
  ruleset: ReplayAnalysisRuleset, session?: MissExplanationSessionState,
  context?: ErrorAnalysisLookups): Generator<void, Incident[], void> {
  const lookups =
    matchingErrorAnalysisLookups(context, events, ruleset, session) ??
    (yield* createErrorAnalysisLookupSteps(events, ruleset, session));
  const links = yield* notelockLinks(errors, events, ruleset, session, lookups);
  const parent: number[] = []; let work = 0;
  for (let index = 0; index < errors.length; index++) { parent.push(index); if (++work % 256 === 0) yield; }
  function* find(index: number): Generator<void, number, void> {
    let root = index;
    while (parent[root] !== root) { root = parent[root]; if (++work % 256 === 0) yield; }
    while (parent[index] !== root) { const previous = parent[index]; parent[index] = root; index = previous; if (++work % 256 === 0) yield; }
    return root;
  }
  for (const link of links) {
    if (++work % 256 === 0) yield;
    const a = yield* find(link.from);
    const b = yield* find(link.to);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const byRoot = new Map<number, Incident>();
  for (let index = 0; index < errors.length; index++) {
    if (++work % 256 === 0) yield;
    const root = yield* find(index);
    const incident = byRoot.get(root) ?? { id: errors[root].id, errorIndices: [], leadIndex: root, links: [] };
    incident.errorIndices.push(index);
    byRoot.set(root, incident);
  }
  for (const link of links) { byRoot.get(yield* find(link.to))?.links.push(link); if (++work % 256 === 0) yield; }
  const result: Incident[] = [];
  for (const incident of byRoot.values()) { result.push(incident); if (++work % 256 === 0) yield; }
  yield* stableSortSteps(result, (a, b) => a.leadIndex - b.leadIndex);
  return result;
}

export function incidentIndexOf(incidents: readonly Incident[], errorIndex: number): number {
  return incidents.findIndex((incident) => incident.errorIndices.includes(errorIndex));
}

export function formatIncidentLabel(
  incidentNumber: number,
  errorIndices: readonly number[],
  totalErrors: number,
): string {
  const numbers = errorIndices.map((index) => index + 1);
  const contiguous = numbers.every((value, position) => position === 0 || value === numbers[position - 1] + 1);
  const range =
    numbers.length === 1
      ? `ERROR ${numbers[0]}`
      : contiguous
      ? `ERRORS ${numbers[0]}–${numbers[numbers.length - 1]}`
      : `ERRORS ${numbers.join(", ")}`;
  return `INCIDENT ${incidentNumber} · ${range} OF ${totalErrors}`;
}

/** The error the playhead has most recently reached; the first error before any is reached. */
export function errorIndexAtOrBefore(errors: readonly ReplayError[], timeMs: number): number {
  if (errors.length === 0) return -1;
  let found = 0;
  for (let index = 0; index < errors.length; index++) if (errors[index].time <= timeMs + 1) found = index;
  return found;
}

export interface DensityBin {
  count: number;
  height: number;
  tone: "empty" | "miss" | "break";
  /** Lead error indices of the incidents in this bin, ascending. */
  leadIndices: number[];
}
export const DENSITY_BIN_COUNT = 60;

/** Incidents per stretch of the map (mock `v3()`): 1 px when empty, else min(16, 5 + 4·n). */
export function buildDensityBins(
  incidents: readonly Incident[],
  errors: readonly ReplayError[],
  durationMs: number,
): DensityBin[] {
  const bins: DensityBin[] = Array.from({ length: DENSITY_BIN_COUNT }, () => ({
    count: 0,
    height: 1,
    tone: "empty" as const,
    leadIndices: [],
  }));
  for (const incident of incidents) {
    const lead = errors[incident.leadIndex];
    if (!lead) continue;
    const scaled = durationMs > 0 ? Math.floor((lead.time / durationMs) * DENSITY_BIN_COUNT) : 0;
    const raw = Number.isFinite(scaled) ? scaled : 0;
    const bin = bins[Math.max(0, Math.min(DENSITY_BIN_COUNT - 1, raw))];
    bin.count += 1;
    bin.height = Math.min(16, 5 + 4 * bin.count);
    bin.tone = lead.type === "MISS" || bin.tone === "miss" ? "miss" : "break";
    bin.leadIndices.push(incident.leadIndex);
  }
  for (const bin of bins) if (bin.leadIndices.length > 1) bin.leadIndices.sort((a, b) => a - b);
  return bins;
}
