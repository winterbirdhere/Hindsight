import { hitWindowsForOD, Position } from "@osujs/math";
import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { stableHitWindowsForOD } from "../StableDifficulty";
import { nativeWithinHitRadius, stableGameplayRadius, stableWithinHitRadius } from "../StableHitGeometry";
import { ReplayTrace, ReplayTraceRecord, TraceChannel, TraceRunIdentity } from "../trace/ReplayTrace";
import { errorCapabilities } from "../error-analysis/ErrorCapabilities";
import { deriveDirectTargetRejections, deriveRecordedPolicyRejections, DirectTargetRejection } from "./DirectTargetRejections";
import { verifiedEndpointActionBoundary } from "../trace/EndpointInputBracket";

export type PredicateState = "supported" | "not-supported" | "indeterminate";
export type DomainState = "empty" | "nonempty" | "unknown";
export interface PredicateAssessment {
  applicable: boolean;
  state: PredicateState;
  reasons: string[];
}
export function assessFreshActionAbsence(input: {
  domain: DomainState;
  actionCoverage: "complete" | "partial";
  freshActionCount: number;
}): PredicateAssessment {
  if (!Number.isSafeInteger(input.freshActionCount) || input.freshActionCount < 0)
    throw new Error("invalid-fresh-action-count");
  if (input.domain !== "nonempty")
    return { applicable: false, state: "indeterminate", reasons: [`${input.domain}-domain`] };
  if (input.freshActionCount > 0)
    return { applicable: true, state: "not-supported", reasons: ["observed-fresh-action"] };
  return input.actionCoverage === "complete"
    ? { applicable: true, state: "supported", reasons: [] }
    : { applicable: true, state: "indeterminate", reasons: ["incomplete-action-coverage"] };
}

export type InputRecord = Extract<ReplayTraceRecord, { kind: "input" }>;
export type AttemptRecord = Extract<ReplayTraceRecord, { kind: "attempt" }>;
export type RoutingRecord = Extract<ReplayTraceRecord, { kind: "selection" | "policy" }>;
export type ResolutionRecord = Extract<ReplayTraceRecord, { kind: "resolution" }>;
type ActivationRecord = Extract<ReplayTraceRecord, { kind: "lifecycle" }>;
export interface EvidenceBoundary {
  timeMs: number;
  inclusive: boolean;
  sequence?: number;
  eventId?: string;
}
export interface EvidenceDomain {
  state: DomainState;
  start?: EvidenceBoundary;
  end?: EvidenceBoundary;
}
export interface EvidenceDependency {
  status: "complete" | "partial" | "unsupported";
  reasons: string[];
}
export interface CircleInputEvidence {
  record: InputRecord;
  inside: boolean;
  freshActionsKnown: boolean;
  inLiveSuccess: boolean;
  inInteraction: boolean;
  postTerminal: boolean;
  /** Consecutive real source samples with positive elapsed time; no gap interpolation. */
  pathGroup: number;
}
export interface InsideInterval {
  kind: "interval" | "point";
  startTimeMs: number;
  endTimeMs: number;
  leftCensored: boolean;
  rightCensored: boolean;
  approximate: boolean;
  eventIds: string[];
  pathGroup: number;
  postTerminal: boolean;
}
export interface CircleEvidence {
  status: "supported" | "unsupported" | "not-missed" | "unjudged";
  identity: TraceRunIdentity;
  targetId: string;
  target?: { hitTimeMs: number; spawnTimeMs: number };
  geometry?: { position: Position; radius: number; profile: "stable" | "lazer"; hitWindows: number[] };
  domains: { nominalSuccess: EvidenceDomain; liveSuccess: EvidenceDomain; interaction: EvidenceDomain };
  inputs: CircleInputEvidence[];
  attempts: AttemptRecord[];
  routing: RoutingRecord[];
  /** Valid direct dispatch witnesses; never filtered by inferred press ownership. */
  directRejections: DirectTargetRejection[];
  terminal?: ResolutionRecord;
  terminalReferences: ReplayTraceRecord[];
  insideIntervals: InsideInterval[];
  dependencies: Record<TraceChannel, EvidenceDependency>;
  limitations: string[];
  limits: { maxInputs: number; maxIntervals: number; maxRelatedRecords: number; truncated: boolean };
}

const MAX_INPUTS = 4096;
const MAX_INTERVALS = 2048;
const MAX_RELATED_RECORDS = 32768;
interface TraceIndex {
  byId: Map<string, ReplayTraceRecord>;
  inputs: InputRecord[];
  /** Prefix counts make source continuity queries independent of domain length. */
  discontinuities: number[];
  attempts: Map<string, AttemptRecord[]>;
  routing: Map<string, RoutingRecord[]>;
  activations: Map<string, ActivationRecord>;
  resolutions: Map<string, ResolutionRecord>;
  parentResolutions: Map<string, Extract<ReplayTraceRecord, { kind: "slider-parent" }>>;
  spinnerResolutions: Map<string, Extract<ReplayTraceRecord, { kind: "spinner-resolution" }>>;
  inputSpans: { inputs: InputRecord[]; discontinuities: number[] }[];
  invalid: boolean;
}
// Sealed trace keys and their indexes are collected together when a session is released.
const indexes = new WeakMap<ReplayTrace, TraceIndex>();
function append<T>(map: Map<string, T[]>, key: string, item: T): void {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}
function traceIndex(trace: ReplayTrace): TraceIndex {
  const cached = indexes.get(trace);
  if (cached) return cached;
  const result: TraceIndex = {
    byId: new Map(),
    inputs: [],
    discontinuities: [],
    attempts: new Map(),
    routing: new Map(),
    activations: new Map(),
    resolutions: new Map(),
    parentResolutions: new Map(),
    spinnerResolutions: new Map(),
    inputSpans: [],
    invalid: false,
  };
  let lastSequence = -1;
  let lastInputTime = -Infinity;
  for (const record of trace.records) {
    if (
      !Number.isFinite(record.timeMs) ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence <= lastSequence ||
      result.byId.has(record.id)
    )
      result.invalid = true;
    lastSequence = record.sequence;
    result.byId.set(record.id, record);
    if (record.kind === "input") {
      const reversal = record.timeMs < lastInputTime;
      if (
        !Number.isFinite(record.position.x) ||
        !Number.isFinite(record.position.y) ||
        (reversal &&
          (trace.identity.schemaVersion === 1 ||
            record.source.origin !== "parsed" ||
            !record.source.discontinuityBefore?.length))
      )
        result.invalid = true;
      if (!result.inputSpans.length || reversal) result.inputSpans.push({ inputs: [], discontinuities: [] });
      const span = result.inputSpans[result.inputSpans.length - 1],
        spanIndex = span.inputs.length;
      span.discontinuities.push(
        (span.discontinuities[spanIndex - 1] ?? 0) +
          (spanIndex > 0 && !sourceAdjacent(span.inputs[spanIndex - 1], record) ? 1 : 0),
      );
      span.inputs.push(record);
      lastInputTime = record.timeMs;
      const i = result.inputs.length;
      result.discontinuities.push(
        (result.discontinuities[i - 1] ?? 0) + (i > 0 && !sourceAdjacent(result.inputs[i - 1], record) ? 1 : 0),
      );
      result.inputs.push(record);
    } else if (record.kind === "attempt") append(result.attempts, record.inputId, record);
    else if (record.kind === "selection" || record.kind === "policy") append(result.routing, record.attemptId, record);
    else if (record.kind === "lifecycle" && !result.activations.has(record.componentId))
      result.activations.set(record.componentId, record);
    else if (record.kind === "resolution" && !result.resolutions.has(record.componentId))
      result.resolutions.set(record.componentId, record);
    else if (record.kind === "slider-parent" && !result.parentResolutions.has(record.componentId))
      result.parentResolutions.set(record.componentId, record);
    else if (record.kind === "spinner-resolution" && !result.spinnerResolutions.has(record.componentId))
      result.spinnerResolutions.set(record.componentId, record);
  }
  indexes.set(trace, result);
  return result;
}
function lowerBound(inputs: InputRecord[], time: number, after = false): number {
  let lo = 0,
    hi = inputs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (inputs[mid].timeMs < time || (after && inputs[mid].timeMs === time)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function sourceAdjacent(left: InputRecord | undefined, right: InputRecord): boolean {
  return (
    !!left &&
    left.source.origin === "parsed" &&
    right.source.origin === "parsed" &&
    right.source.parsedFrameIndex === left.source.parsedFrameIndex + 1 &&
    !right.source.discontinuityBefore?.length
  );
}
function inDomain(record: InputRecord, domain: EvidenceDomain): boolean {
  if (domain.state !== "nonempty" || !domain.start || !domain.end) return false;
  const { start, end } = domain;
  return (
    record.timeMs >= start.timeMs &&
    record.timeMs <= end.timeMs &&
    (record.timeMs !== start.timeMs ||
      (start.sequence === undefined ? start.inclusive : record.sequence > start.sequence)) &&
    (record.timeMs !== end.timeMs || (end.sequence === undefined ? end.inclusive : record.sequence < end.sequence))
  );
}
function boundedDomain(start: EvidenceBoundary, end: EvidenceBoundary): EvidenceDomain {
  const empty =
    start.timeMs > end.timeMs ||
    (start.timeMs === end.timeMs &&
      ((!start.inclusive && start.sequence === undefined) ||
        (!end.inclusive && end.sequence === undefined) ||
        (start.sequence !== undefined && end.sequence !== undefined && start.sequence >= end.sequence)));
  return { state: empty ? "empty" : "nonempty", start, end };
}
function later(a: EvidenceBoundary, b: EvidenceBoundary): EvidenceBoundary {
  return a.timeMs > b.timeMs || (a.timeMs === b.timeMs && (a.sequence ?? -Infinity) > (b.sequence ?? -Infinity))
    ? a
    : b;
}
function earlier(a: EvidenceBoundary, b: EvidenceBoundary): EvidenceBoundary {
  return a.timeMs < b.timeMs || (a.timeMs === b.timeMs && (a.sequence ?? Infinity) < (b.sequence ?? Infinity)) ? a : b;
}
function dependency(status: EvidenceDependency["status"], reasons: string[] = []): EvidenceDependency {
  return { status, reasons };
}
function partial(dep: EvidenceDependency, reason: string): void {
  if (dep.status === "complete") dep.status = "partial";
  if (!dep.reasons.includes(reason)) dep.reasons.push(reason);
}

/** Analytic line/circle intersections are an approximation to replay motion, not recorded cursor travel.
 * Exact sampled containment above uses the evaluator predicate, including Stable float32 boundaries. */
function reconstruct(
  inputs: CircleInputEvidence[],
  geometry: NonNullable<CircleEvidence["geometry"]>,
  start: number,
  end: number,
  terminal: ResolutionRecord | undefined,
): InsideInterval[] {
  const result: InsideInterval[] = [];
  const representedSamples = new Set<string>();
  const rounded = (p: Position): Position =>
    geometry.profile === "stable" ? { x: Math.fround(p.x), y: Math.fround(p.y) } : p;
  const center = rounded(geometry.position);
  for (let i = 1; i < inputs.length; i++) {
    const left = inputs[i - 1],
      right = inputs[i];
    if (left.pathGroup !== right.pathGroup || right.record.timeMs <= left.record.timeMs) continue;
    const p = rounded(left.record.position),
      q = rounded(right.record.position);
    const dx = q.x - p.x,
      dy = q.y - p.y,
      px = p.x - center.x,
      py = p.y - center.y;
    const a = dx * dx + dy * dy,
      b = 2 * (px * dx + py * dy),
      c = px * px + py * py - geometry.radius ** 2;
    const duration = right.record.timeMs - left.record.timeMs;
    let low = Math.max(0, (start - left.record.timeMs) / duration),
      high = Math.min(1, (end - left.record.timeMs) / duration);
    let entry = -Infinity,
      exit = Infinity;
    if (a === 0) {
      if (!left.inside) continue;
    } else {
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0) continue;
      entry = (-b - Math.sqrt(discriminant)) / (2 * a);
      exit = (-b + Math.sqrt(discriminant)) / (2 * a);
      low = Math.max(low, entry);
      high = Math.min(high, exit);
    }
    if (low > high) continue;
    const startTimeMs = left.record.timeMs + low * duration,
      endTimeMs = left.record.timeMs + high * duration;
    if (left.record.timeMs >= startTimeMs && left.record.timeMs <= endTimeMs) representedSamples.add(left.record.id);
    if (right.record.timeMs >= startTimeMs && right.record.timeMs <= endTimeMs) representedSamples.add(right.record.id);
    const item: InsideInterval = {
      kind: low === high ? "point" : "interval",
      startTimeMs,
      endTimeMs,
      leftCensored: low > entry,
      rightCensored: high < exit,
      approximate: true,
      eventIds: [left.record.id, right.record.id],
      pathGroup: left.pathGroup,
      postTerminal: !!terminal && startTimeMs >= terminal.timeMs,
    };
    const previous = result[result.length - 1];
    if (previous && previous.pathGroup === item.pathGroup && previous.endTimeMs === item.startTimeMs) {
      previous.endTimeMs = item.endTimeMs;
      previous.kind = previous.endTimeMs > previous.startTimeMs ? "interval" : "point";
      previous.rightCensored = item.rightCensored;
      previous.eventIds.push(right.record.id);
    } else result.push(item);
  }
  // Isolated real samples remain observations; equal-time jumps are never line segments.
  for (const sample of inputs) {
    if (
      !sample.inside ||
      sample.record.source.origin === "synthetic" ||
      sample.record.timeMs < start ||
      sample.record.timeMs > end
    )
      continue;
    if (representedSamples.has(sample.record.id)) continue;
    result.push({
      kind: "point",
      startTimeMs: sample.record.timeMs,
      endTimeMs: sample.record.timeMs,
      leftCensored: true,
      rightCensored: true,
      approximate: false,
      eventIds: [sample.record.id],
      pathGroup: sample.pathGroup,
      postTerminal: sample.postTerminal,
    });
  }
  return result.sort((a, b) => a.startTimeMs - b.startTimeMs || a.pathGroup - b.pathGroup);
}

/** Pure extraction over the prepared map and a sealed canonical trace; never evaluates gameplay.
 * Explicit conflict convention: dependency-conflict:<input|geometry|routing|lifecycle>:<targetId>.
 * global-totals-mismatch is only a run limitation, not a localized disagreement. */
/** Internal antecedent evidence; recovering later never creates a player Miss. */
export function derivePreResolutionRejections(evidence: CircleEvidence, beatmap: Beatmap, trace: ReplayTrace) {
  const index = traceIndex(trace);
  return index.invalid ? [] : deriveDirectTargetRejections(evidence, beatmap, trace, index, true);
}

export function deriveRecordedRejections(evidence: CircleEvidence, beatmap: Beatmap, trace: ReplayTrace) {
  const index = traceIndex(trace);
  return index.invalid ? [] : deriveRecordedPolicyRejections(evidence, beatmap, trace, index);
}

const MAX_REUSED_EVIDENCE = 128;
interface EvidenceScope {
  trace: ReplayTrace;
  beatmap: Beatmap;
  entries: Map<string, CircleEvidence>;
}
let evidenceScope: EvidenceScope | undefined;

/** Reuse completed facts only while resuming this immutable analysis, never across yields. */
export function reuseCircleEvidence<Y, R, N>(
  trace: ReplayTrace,
  beatmap: Beatmap,
  worker: Generator<Y, R, N>,
): Generator<Y, R, N> {
  const scope: EvidenceScope = { trace, beatmap, entries: new Map() };
  let closed = false;
  const close = () => {
    closed = true;
    scope.entries.clear();
  };
  const resume = (step: () => IteratorResult<Y, R>) => {
    const previous = evidenceScope;
    evidenceScope = closed ? undefined : scope;
    try {
      const result = step();
      if (result.done) close();
      return result;
    } catch (error) {
      close();
      throw error;
    } finally {
      evidenceScope = previous;
    }
  };
  return {
    next: (...args: [] | [N]) => resume(() => worker.next(...args)),
    return: (value: R) => {
      try {
        return resume(() => worker.return(value));
      } finally {
        close();
      }
    },
    throw: (error: unknown) => resume(() => worker.throw(error)),
    [Symbol.iterator]() { return this; },
    [Symbol.dispose]() { this.return(undefined as R); },
  };
}

export function deriveCircleEvidence(trace: ReplayTrace, beatmap: Beatmap, targetId: string): CircleEvidence {
  const scope = evidenceScope?.trace === trace && evidenceScope.beatmap === beatmap ? evidenceScope : undefined;
  const cached = scope?.entries.get(targetId);
  if (cached) {
    scope!.entries.delete(targetId);
    scope!.entries.set(targetId, cached);
    return cached;
  }
  const evidence = extractCircleEvidence(trace, beatmap, targetId);
  if (scope) {
    scope.entries.set(targetId, evidence);
    // Eviction changes only repeated work, never evidence limits or admission.
    if (scope.entries.size > MAX_REUSED_EVIDENCE) scope.entries.delete(scope.entries.keys().next().value!);
  }
  return evidence;
}

function extractCircleEvidence(trace: ReplayTrace, beatmap: Beatmap, targetId: string): CircleEvidence {
  const index = traceIndex(trace);
  const evidence: CircleEvidence = {
    status: "unsupported",
    identity: trace.identity,
    targetId,
    domains: {
      nominalSuccess: { state: "unknown" },
      liveSuccess: { state: "unknown" },
      interaction: { state: "unknown" },
    },
    inputs: [],
    attempts: [],
    routing: [],
    directRejections: [],
    terminalReferences: [],
    insideIntervals: [],
    dependencies: {
      input: dependency("partial"),
      geometry: dependency("complete"),
      routing: dependency(trace.coverage.routing),
      lifecycle: dependency(trace.coverage.lifecycle),
    },
    limitations: [...trace.domain.sourceCoverageLimits, ...trace.failures],
    limits: {
      maxInputs: MAX_INPUTS,
      maxIntervals: MAX_INTERVALS,
      maxRelatedRecords: MAX_RELATED_RECORDS,
      truncated: false,
    },
  };
  const target = beatmap.getHitObject(targetId);
  const profile = trace.identity.analysisProfileId;
  const allErrors = trace.identity.schemaVersion === 2;
  const capabilities = allErrors ? errorCapabilities(beatmap, profile) : undefined;
  const unsupported = !target
    ? "missing-target"
    : !(target instanceof HitCircle) || (!allErrors && target.sliderId !== undefined)
    ? "unsupported-component"
    : allErrors
    ? capabilities?.scoring !== "supported" || capabilities.geometry !== "supported"
      ? "unsupported-profile"
      : index.invalid
      ? "invalid-trace"
      : undefined
    : !["stable", "lazer"].includes(profile) ||
      beatmap.appliedMods.length > 0 ||
      beatmap.lazerMods.length > 0 ||
      beatmap.gameClockRate !== 1
    ? "unsupported-profile"
    : index.invalid || trace.identity.schemaVersion !== 1
    ? "invalid-trace"
    : undefined;
  if (unsupported || !(target instanceof HitCircle)) {
    evidence.limitations.push(unsupported ?? "unsupported-component");
    return evidence;
  }
  if (
    ![target.hitTime, target.spawnTime, target.radius, target.position.x, target.position.y].every(Number.isFinite) ||
    target.radius <= 0
  ) {
    evidence.limitations.push("invalid-target-geometry");
    return evidence;
  }
  const stable = profile === "stable";
  const windows = stable
    ? stableHitWindowsForOD(beatmap.stableOverallDifficulty)
    : hitWindowsForOD(beatmap.difficulty.overallDifficulty, true);
  evidence.target = { hitTimeMs: target.hitTime, spawnTimeMs: target.spawnTime };
  const geometry = (evidence.geometry = {
    position: { ...target.position },
    radius: Math.fround(stable ? stableGameplayRadius(target.radius) : target.radius),
    profile: stable ? ("stable" as const) : ("lazer" as const),
    hitWindows: [...windows],
  });
  const terminal = (evidence.terminal = index.resolutions.get(targetId));
  const activation = index.activations.get(targetId);
  evidence.status = !terminal
    ? "unjudged"
    : terminal.result === "MISS" || (allErrors && ["OK", "MEH"].includes(terminal.result))
    ? "supported"
    : "not-missed";
  if (!terminal) evidence.limitations.push("target-unjudged");
  if (
    ((terminal?.mechanism === "input-miss" || (allErrors && terminal?.mechanism === "successful-input")) &&
      !terminal.triggerAttemptId) ||
    (terminal?.mechanism === "ordered-force-miss" && !terminal.triggerResolutionId)
  )
    partial(evidence.dependencies.lifecycle, "missing-terminal-reference");
  for (const [id, kind] of [
    [terminal?.triggerAttemptId, "attempt"],
    [terminal?.triggerResolutionId, "resolution"],
  ] as const) {
    const reference = id ? index.byId.get(id) : undefined;
    if (reference?.kind === kind) {
      evidence.terminalReferences.push(reference);
      if (reference.kind === "attempt") {
        const source = index.byId.get(reference.inputId);
        if (source?.kind === "input") evidence.terminalReferences.push(source);
        else partial(evidence.dependencies.lifecycle, "missing-terminal-reference");
      }
    } else if (id) partial(evidence.dependencies.lifecycle, "missing-terminal-reference");
  }
  for (const channel of ["input", "geometry", "routing", "lifecycle"] as TraceChannel[]) {
    const conflict = `dependency-conflict:${channel}:${targetId}`;
    if (evidence.limitations.includes(conflict)) partial(evidence.dependencies[channel], conflict);
  }
  const nominal = (evidence.domains.nominalSuccess = boundedDomain(
    { timeMs: target.hitTime - windows[2], inclusive: true },
    { timeMs: target.hitTime + windows[2], inclusive: true },
  ));
  if (!activation) partial(evidence.dependencies.lifecycle, "missing-activation");
  // An absent causal link limits attribution, while the directly observed
  // activation and terminal can still establish the target's live range.
  if (
    activation &&
    trace.coverage.lifecycle === "complete" &&
    !evidence.dependencies.lifecycle.reasons.some((reason) => reason.startsWith("dependency-conflict:"))
  ) {
    const activeStart = {
      timeMs: activation.timeMs,
      sequence: activation.sequence,
      eventId: activation.id,
      inclusive: false,
    };
    let activeEnd: EvidenceBoundary = terminal
      ? { timeMs: terminal.timeMs, sequence: terminal.sequence, eventId: terminal.id, inclusive: false }
      : { timeMs: trace.domain.endTimeMs, inclusive: true };
    const parentResolution =
      allErrors && stable && target.sliderId ? index.parentResolutions.get(target.sliderId) : undefined;
    if (parentResolution)
      activeEnd = earlier(activeEnd, {
        timeMs: parentResolution.timeMs,
        sequence: parentResolution.sequence,
        eventId: parentResolution.id,
        inclusive: false,
      });
    evidence.domains.liveSuccess = boundedDomain(later(nominal.start!, activeStart), earlier(nominal.end!, activeEnd));
    evidence.domains.interaction = boundedDomain(
      activeStart,
      earlier(activeEnd, { timeMs: target.hitTime + (stable ? windows[2] + 1 : windows[3]), inclusive: true }),
    );
  }
  const start = Math.min(activation?.timeMs ?? target.spawnTime, nominal.start!.timeMs);
  const end = Math.max(nominal.end!.timeMs, terminal?.timeMs ?? nominal.end!.timeMs);
  // A documented timestamp reset splits source-order spans. Do not sort input
  // records or reject a later independent local opportunity because of that gap.
  const spans = allErrors ? index.inputSpans : [{ inputs: index.inputs, discontinuities: index.discontinuities }];
  const relevantSpans = spans.filter(
    (span) => span.inputs[0]?.timeMs <= end && span.inputs[span.inputs.length - 1]?.timeMs >= start,
  );
  const inputView =
    relevantSpans.length === 1 ? relevantSpans[0] : { inputs: [] as InputRecord[], discontinuities: [] as number[] };
  if (relevantSpans.length > 1) partial(evidence.dependencies.input, "overlapping-source-time-spans");
  const first = Math.max(0, lowerBound(inputView.inputs, start) - 1),
    last = Math.min(inputView.inputs.length, lowerBound(inputView.inputs, end, true) + 1);
  const selected = inputView.inputs.slice(first, Math.min(last, first + MAX_INPUTS));
  if (last - first > MAX_INPUTS) {
    evidence.limits.truncated = true;
    evidence.limitations.push("evidence-input-limit");
  }
  let pathGroup = 0;
  for (let j = 0; j < selected.length; j++) {
    const record = selected[j],
      sourceIndex = first + j;
    const previous = inputView.inputs[sourceIndex - 1];
    const adjacent = sourceAdjacent(previous, record);
    if (!adjacent || !previous || previous.timeMs === record.timeMs) pathGroup++;
    evidence.inputs.push({
      record,
      inside: (stable ? stableWithinHitRadius : nativeWithinHitRadius)(
        geometry.position,
        record.position,
        geometry.radius,
      ),
      freshActionsKnown:
        record.source.origin === "parsed" &&
        (adjacent ||
          (record === index.inputs[0] &&
            trace.domain.initialActionsKnown === true &&
            !record.source.discontinuityBefore?.length)),
      inLiveSuccess: inDomain(record, evidence.domains.liveSuccess),
      inInteraction: inDomain(record, evidence.domains.interaction),
      postTerminal: !!terminal && record.sequence > terminal.sequence,
      pathGroup,
    });
    for (const attempt of index.attempts.get(record.id) ?? []) {
      if (evidence.attempts.length + evidence.routing.length >= MAX_RELATED_RECORDS) {
        evidence.limits.truncated = true;
        if (!evidence.limitations.includes("evidence-related-record-limit"))
          evidence.limitations.push("evidence-related-record-limit");
        partial(evidence.dependencies.routing, "evidence-related-record-limit");
        break;
      }
      evidence.attempts.push(attempt);
      const routing = index.routing.get(attempt.id) ?? [];
      const room = MAX_RELATED_RECORDS - evidence.attempts.length - evidence.routing.length;
      evidence.routing.push(...routing.slice(0, room));
      if (routing.length > room) {
        evidence.limits.truncated = true;
        if (!evidence.limitations.includes("evidence-related-record-limit"))
          evidence.limitations.push("evidence-related-record-limit");
        partial(evidence.dependencies.routing, "evidence-related-record-limit");
      }
    }
  }
  const live = evidence.domains.liveSuccess;
  const inputDependency = (evidence.dependencies.input = dependency("complete", evidence.dependencies.input.reasons));
  if (inputDependency.reasons.length) inputDependency.status = "partial";
  if (live.state !== "nonempty" || !live.start || !live.end) partial(inputDependency, `${live.state}-live-domain`);
  else {
    const from = Math.max(0, lowerBound(inputView.inputs, live.start.timeMs) - 1);
    const through = lowerBound(inputView.inputs, live.end.timeMs);
    const begin = inputView.inputs[from],
      finish = inputView.inputs[through];
    if (
      !begin ||
      begin.timeMs > live.start.timeMs ||
      !finish ||
      finish.timeMs < live.end.timeMs ||
      trace.domain.endTimeMs < live.end.timeMs
    )
      partial(inputDependency, "source-does-not-cover-live-domain");
    const endpointActions = through === inputView.inputs.length-1 &&
      verifiedEndpointActionBoundary(trace.domain,inputView.inputs[through-1],finish);
    if (begin?.source.origin !== "parsed" || (finish?.source.origin !== "parsed" && !endpointActions))
      partial(inputDependency, "non-recorded-domain-boundary");
    const lastCovered = Math.min(through - (endpointActions ? 1 : 0), inputView.inputs.length - 1);
    if ((inputView.discontinuities[lastCovered] ?? 0) > (inputView.discontinuities[from] ?? 0))
      partial(inputDependency, "source-discontinuity");
    if (evidence.inputs.some((i) => i.inLiveSuccess && !i.freshActionsKnown))
      partial(inputDependency, "unknown-previous-actions");
  }
  const localizableLimits = [
    "initial-actions-unknown",
    "parser-malformed-token",
    "parser-negative-delta",
    "global-totals-mismatch",
    "planned-input-retention",
  ];
  if (
    trace.domain.sourceCoverageLimits.some(
      (reason) => !localizableLimits.includes(reason) && !reason.startsWith("dependency-conflict:"),
    )
  )
    partial(inputDependency, "unlocalized-source-limitation");
  if (trace.coverage.input === "unsupported") partial(inputDependency, "unsupported-input-coverage");
  if (
    trace.coverage.input === "partial" &&
    trace.domain.sourceCoverageLimits.length === 0 &&
    !trace.domain.synthesizedEndpoint &&
    trace.domain.endpointBasis === "recorded-end"
  )
    partial(inputDependency, "partial-input-coverage");
  // Overall completeness also includes selected-receptor-only geometry. Local
  // prepared-map geometry resolves that limit without inventing source coverage.
  if (
    trace.failures.some(
      (reason) => reason !== "global-totals-mismatch" && !reason.startsWith("dependency-conflict:"),
    ) ||
    trace.droppedRecordBoundary !== undefined ||
    evidence.limits.truncated
  )
    partial(inputDependency, "incomplete-capture");
  // Endpoint provenance remains visible, but only the bracketing source checks
  // above determine whether this target's local action domain is recorded.
  if (trace.domain.endpointBasis !== "recorded-end" || trace.domain.synthesizedEndpoint)
    evidence.limitations.push("inferred-or-synthetic-endpoint");
  const intervals = reconstruct(evidence.inputs, geometry, start, nominal.end!.timeMs, terminal);
  if (intervals.length > MAX_INTERVALS) {
    evidence.limits.truncated = true;
    evidence.limitations.push("evidence-interval-limit");
    // Retaining fewer geometric contacts does not remove any captured actions.
    // Positive path findings may use retained witnesses; input absence depends
    // on the separate complete action domain, not on this interval collection.
  }
  evidence.insideIntervals = intervals.slice(0, MAX_INTERVALS);
  evidence.directRejections = deriveDirectTargetRejections(evidence, beatmap, trace, index);
  evidence.limitations = Array.from(
    new Set([...evidence.limitations, ...Object.values(evidence.dependencies).flatMap((d) => d.reasons)]),
  );
  return evidence;
}
