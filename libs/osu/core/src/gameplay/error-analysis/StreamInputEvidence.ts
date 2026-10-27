import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import {
  CircleEvidence,
  EvidenceBoundary,
  InputRecord,
  AttemptRecord,
  ResolutionRecord,
  deriveCircleEvidence,
} from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { errorCapabilities } from "./ErrorCapabilities";
import { reconcileStreamTables } from "./StreamTableReconciliation";

export const STREAM_INPUT_POLICY = Object.freeze({
  version: "stream-input-v6",
  maximumNotes: 64,
  ownershipCoreNotes: 48,
  contextHaloNotes: 8,
  maximumActions: 512,
  maximumCachedRuns: 32,
  maximumSpacingR: 6,
  maximumIntervalRatio: 1.4,
  maximumIntervalMs: 200,
  anchorConsistencyFraction: 0.35,
  maximumResidualFraction: 0.45,
  minimumAlternativeMarginFraction: 0.15,
  maximumUnanchoredNotes: 3,
  maximumLocalSampleGapFraction: 0.5,
  maximumSampledDistanceR: 2,
  recentPhaseAnchorCount: 3,
  localPhaseFraction: 0.5,
  localRadialAdvantage: 0.15,
});

export interface StreamAssignment {
  componentId?: string;
  inputId?: string;
  relation: "matched" | "missing" | "extra" | "ambiguous";
  confidence: "anchored" | "corroborated" | "ambiguous";
  offsetMs?: number;
  phaseResidualMs?: number;
  anchorOffsetsMs?: number[];
  phaseMs?: number;
  basis?: "cadence" | "scheduled-geometric" | "closed-source-gap";
  /** Endpoint phase envelope for a local omission, never a forward rhythm seed. */
  phaseEnvelopeMs?: [number,number];
  geometry?: { minimumSampledR: number; pressR: number; closestTimeMs: number; eventIds: string[] };
  eventIds: string[];
  contextEventIds?: string[];
  recoveryContext?: { inputId: string; resolutionId: string; timeMs: number; afterTargetLiveEnd: boolean };
  competingClaims?: Array<{
    componentId: string;
    confidence: StreamAssignment["confidence"];
    basis?: StreamAssignment["basis"];
    eventIds: string[];
  }>;
  /** Unmerged local hypotheses/negative witnesses retained for diagnostics. */
  competingEvidence?: Array<Omit<StreamAssignment,"competingEvidence">>;
}
export interface StreamInputEvidence {
  policyVersion: string;
  status: "supported" | "ambiguous" | "unavailable" | "not-stream";
  segmentId?: string;
  boundedContext?: {
    physicalSegmentId: string;
    ownedStartId: string;
    ownedEndId: string;
    alignmentNoteCount: number;
    artificialLeft: boolean;
    artificialRight: boolean;
    recentPhaseResetEventIds: string[];
  };
  assignmentScope?: { policy:"target-dependency-closure"; retainedCount:number; alignedCount:number };
  relevantInputIds: string[];
  contextInputIds: string[];
  rawFreshInputIds: string[];
  rawFreshActionCount: number;
  assignments: StreamAssignment[];
  missingTargetTap: boolean;
  phaseAlternatives?: Array<{
    phaseMs: number;
    targetInputIds: string[];
    eventIds: string[];
    reason: "one-slot-reception-shift";
    active: boolean;
    recentAnchorCount: number;
  }>;
  cadence?: {
    scheduledIntervalsMs: number[];
    observedIntervalsMs: number[];
    anchorOffsetsMs: number[];
    phaseMs: number;
  };
  inputScopes?: Record<
    string,
    {
      start?: EvidenceBoundary;
      end?: EvidenceBoundary;
      placementEnd?: EvidenceBoundary;
      eventIds?: readonly string[];
      contextEventIds?: readonly string[];
    }
  >;
  limitations: string[];
}
export function deriveStreamInputEvidence(
  evidence: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace,
): StreamInputEvidence {
  const raw = evidence.inputs.filter((i) => i.inLiveSuccess && !i.postTerminal && i.record.freshActions.length);
  const result: StreamInputEvidence = {
    policyVersion: STREAM_INPUT_POLICY.version,
    status: "not-stream",
    relevantInputIds: [],
    contextInputIds: [],
    rawFreshInputIds: raw.map((i) => i.record.id),
    rawFreshActionCount: raw.reduce((n, i) => n + i.record.freshActions.length, 0),
    assignments: [],
    missingTargetTap: false,
    limitations: [],
  };
  const refuse = (reason: string) => {
    result.status = "unavailable";
    result.limitations.push(reason);
    return result;
  };
  if (
    Object.keys(trace.identity).length !== Object.keys(evidence.identity).length ||
    Object.entries(evidence.identity).some(
      ([key, value]) => trace.identity[key as keyof typeof trace.identity] !== value,
    )
  )
    return refuse("trace-identity-mismatch");
  if (
    !evidence.target ||
    !evidence.geometry ||
    !evidence.terminal ||
    evidence.limits.truncated ||
    Object.values(evidence.dependencies).some((d) => d.status !== "complete")
  )
    return refuse("incomplete-stream-target-evidence");
  const capability = errorCapabilities(map, evidence.identity.analysisProfileId);
  if (capability.aim !== "manual" || capability.tapping !== "manual") return result;
  const run = mapRuns(map).get(evidence.targetId);
  if (!run) return result;
  result.segmentId = run.id;
  const index = traceIndex(trace);
  if (index.invalid) return refuse("invalid-stream-source-index");
  const short = run.notes.length < 3;
  const base: Alignment = short
    ? { assignments: [], scopes: {}, freshTimes: [], alternatives: new Map(), limitations: [] }
    : alignRun(run, map, trace, index);
  const shortInputs = short
    ? run.notes.flatMap((n) =>
        deriveCircleEvidence(trace, map, n.id)
          .inputs.filter((i) => i.inLiveSuccess && !i.postTerminal && i.record.freshActions.length)
          .map((i) => i.record.id),
      )
    : [];
  const aligned = reconcileRuns(run, base, map, trace, index, evidence.geometry.hitWindows[2], shortInputs,evidence.targetId);
  result.assignments = aligned.assignments;
  result.inputScopes=aligned.scopes;
  const alternatives=aligned.alternatives.get(evidence.targetId);
  if(alternatives?.length)result.phaseAlternatives=alternatives;
  if(aligned.boundedTables) {
    // Alignment remains immutable and complete in the bounded cache. Per-target
    // diagnostics retain every local edge and the target's supporting/conflicting
    // assignments; unrelated peer rows need not be copied into every error.
    const targetRows=aligned.assignments.filter(row=>row.componentId===evidence.targetId ||
      row.competingClaims?.some(claim=>claim.componentId===evidence.targetId) ||
      row.competingEvidence?.some(claim=>claim.componentId===evidence.targetId));
    const references=new Set([...evidence.inputs.map(input=>input.record.id),...targetRows.flatMap(row=>row.eventIds),
      ...(alternatives ?? []).flatMap(row=>row.targetInputIds)]);
    result.assignments=aligned.assignments.filter(row=>row.inputId ? references.has(row.inputId) : targetRows.includes(row));
    result.inputScopes=Object.fromEntries(Object.entries(aligned.scopes).filter(([id])=>references.has(id)));
    result.assignmentScope={policy:"target-dependency-closure",retainedCount:result.assignments.length,alignedCount:aligned.assignments.length};
  }
  if(run.familyId)result.boundedContext={physicalSegmentId:run.familyId,
    ownedStartId:run.notes[run.ownedStart ?? 0].id,ownedEndId:run.notes[(run.ownedEnd ?? run.notes.length)-1].id,
    alignmentNoteCount:run.notes.length,artificialLeft:!!run.artificialLeft,artificialRight:!!run.artificialRight,
    recentPhaseResetEventIds:aligned.historyResetEventIds ?? []};
  result.limitations.push(...aligned.limitations);
  if (aligned.unavailable) {
    result.status = "unavailable";
    return result;
  }
  if(aligned.unknownHistoryComponentIds?.has(evidence.targetId))return refuse("stream-left-history-unresolved");
  const owned = new Map(
    aligned.assignments.filter((a) => a.inputId && a.relation === "matched").map((a) => [a.inputId, a]),
  );
  for (const input of raw) {
    const assignment = owned.get(input.record.id);
    if (assignment?.componentId === evidence.targetId) result.relevantInputIds.push(input.record.id);
    else if (assignment?.componentId) result.contextInputIds.push(input.record.id);
  }
  const targetAssignment = aligned.assignments.find(
    (a) => a.componentId === evidence.targetId && a.relation === "matched",
  );
  const missing = aligned.assignments.find((a) => a.componentId === evidence.targetId && a.relation === "missing");
  result.missingTargetTap = !!missing;
  const phase = targetAssignment?.phaseMs ?? missing?.phaseMs;
  const anchorOffsetsMs = targetAssignment?.anchorOffsetsMs ?? missing?.anchorOffsetsMs;
  if (phase !== undefined && anchorOffsetsMs)
    result.cadence = {
      scheduledIntervalsMs: run.notes.slice(1).map((n, i) => n.hitTime - run.notes[i].hitTime),
      observedIntervalsMs: aligned.freshTimes.slice(1).map((t, i) => t - aligned.freshTimes[i]),
      phaseMs: phase,
      anchorOffsetsMs,
    };
  // A short neighbourhood does not become a stream. Positive ownership from
  // an overlapping stream is still visible to prevent independent re-use.
  if (short) return result;
  // Unassigned actions in this actual target domain remain visible. Their
  // absence from ownership is not positive evidence of an omitted tap.
  const unresolved = raw.some((i) => !owned.has(i.record.id));
  result.status = (targetAssignment || missing) && !unresolved ? "supported" : "ambiguous";
  if (unresolved) result.limitations.push("unresolved-stream-input");
  if (alternatives?.some((a) => a.active)) {
    result.status = "ambiguous";
    result.missingTargetTap = false;
    result.limitations.push("stream-phase-slip-alternative");
  }
  return result;
}

interface Run {
  id: string;
  notes: HitCircle[];
  familyId?: string;
  ownedStart?: number;
  ownedEnd?: number;
  artificialLeft?: boolean;
  artificialRight?: boolean;
  following?: HitCircle;
  previous?: HitCircle;
}
const runsByMap = new WeakMap<Beatmap, Map<string, Run>>();
const orderedRunsByMap = new WeakMap<Beatmap, Run[]>();
function mapRuns(map: Beatmap): Map<string, Run> {
  const cached = runsByMap.get(map);
  if (cached) return cached;
  const runs = new Map<string, Run>();
  let notes: HitCircle[] = [];
  let previousRun: Run | undefined;
  let previousNote: HitCircle | undefined, runPrevious: HitCircle | undefined;
  const flush = (following?: HitCircle) => {
    if (notes.length) {
      const familyId=`stream:${notes[0].id}:${notes[notes.length-1].id}`;
      if(notes.length<=STREAM_INPUT_POLICY.maximumNotes) {
        const run={id:familyId,notes,following,previous:runPrevious};
        for(const n of notes)runs.set(n.id,run);
        previousRun=run;
      } else for(let coreStart=0;coreStart<notes.length;coreStart+=STREAM_INPUT_POLICY.ownershipCoreNotes) {
        const coreEnd=Math.min(notes.length,coreStart+STREAM_INPUT_POLICY.ownershipCoreNotes),
          left=Math.max(0,coreStart-STREAM_INPUT_POLICY.contextHaloNotes),
          right=Math.min(notes.length,coreEnd+STREAM_INPUT_POLICY.contextHaloNotes);
        const run:Run={id:`${familyId}:core:${notes[coreStart].id}:${notes[coreEnd-1].id}`,
          familyId,notes:notes.slice(left,right),ownedStart:coreStart-left,ownedEnd:coreEnd-left,
          artificialLeft:left>0,artificialRight:right<notes.length,
          previous:left>0 ? notes[left-1] : runPrevious,following:right<notes.length ? notes[right] : following};
        for(const n of notes.slice(coreStart,coreEnd))runs.set(n.id,run);
        previousRun=run;
      }
    }
    notes = [];
  };
  for (const object of map.hitObjects) {
    const note = object instanceof HitCircle ? object : object instanceof Slider ? object.head : undefined;
    if (!note) {
      flush();
      previousRun = undefined;
      previousNote = undefined;
      continue;
    }
    if (previousRun && !previousRun.following) previousRun.following = note;
    const prev = notes[notes.length - 1],
      earlier = notes[notes.length - 2];
    if (prev) {
      const delta = note.hitTime - prev.hitTime,
        prior = earlier ? prev.hitTime - earlier.hitTime : delta;
      const distance =
        Math.hypot(note.position.x - prev.position.x, note.position.y - prev.position.y) /
        Math.max(note.radius, prev.radius);
      if (
        delta <= 0 ||
        delta > STREAM_INPUT_POLICY.maximumIntervalMs ||
        distance > STREAM_INPUT_POLICY.maximumSpacingR ||
        Math.max(delta, prior) / Math.min(delta, prior) > STREAM_INPUT_POLICY.maximumIntervalRatio
      )
        flush(note);
    }
    if (!notes.length) runPrevious = previousNote;
    notes.push(note);
    previousNote = note;
    if (object instanceof Slider) flush();
  }
  flush();
  runsByMap.set(map, runs);
  orderedRunsByMap.set(map, [...new Set(runs.values())]);
  return runs;
}
interface SourceIndex {
  inputs: InputRecord[];
  positions: Map<string, number>;
  attempts: Map<string, AttemptRecord>;
  success: Map<string, ResolutionRecord[]>;
  successByComponent: Map<string, { inputId: string; resolution: ResolutionRecord }>;
  invalid: boolean;
}
const sourceIndexes = new WeakMap<ReplayTrace, SourceIndex>();
function traceIndex(trace: ReplayTrace): SourceIndex {
  const prior = sourceIndexes.get(trace);
  if (prior) return prior;
  const index: SourceIndex = {
    inputs: [],
    positions: new Map(),
    attempts: new Map(),
    success: new Map(),
    successByComponent: new Map(),
    invalid: trace.records.length > trace.limits.maxRecords,
  };
  if (index.invalid) {
    sourceIndexes.set(trace, index);
    return index;
  }
  let last = -1;
  const ids = new Set<string>();
  for (const r of trace.records) {
    if (r.sequence <= last || ids.has(r.id)) index.invalid = true;
    last = r.sequence;
    ids.add(r.id);
    if (r.kind === "input") {
      index.positions.set(r.id, index.inputs.length);
      index.inputs.push(r);
    } else if (r.kind === "attempt") index.attempts.set(r.id, r);
  }
  for (const r of trace.records)
    if (r.kind === "resolution" && r.mechanism === "successful-input" && r.result !== "MISS") {
      const a = index.attempts.get(r.triggerAttemptId ?? "");
      if (!a || a.automated || a.knownAction === undefined) continue;
      const list = index.success.get(a.inputId) ?? [];
      list.push(r);
      index.success.set(a.inputId, list);
      index.successByComponent.set(r.componentId, { inputId: a.inputId, resolution: r });
    }
  sourceIndexes.set(trace, index);
  return index;
}
interface Alignment {
  assignments: StreamAssignment[];
  scopes: NonNullable<StreamInputEvidence["inputScopes"]>;
  freshTimes: number[];
  alternatives: Map<string, NonNullable<StreamInputEvidence["phaseAlternatives"]>>;
  limitations: string[];
  unavailable?: boolean;
  unknownHistoryComponentIds?: Set<string>;
  historyResetEventIds?: string[];
  historyResetSequence?: number;
  boundedTables?: boolean;
}
/** Reconcile immutable base tables, never claims accumulated in query order. */
function reconcileRuns(
  run: Run,
  base: Alignment,
  map: Beatmap,
  trace: ReplayTrace,
  index: SourceIndex,
  window: number,
  rawIds: string[],
  targetId:string,
): Alignment {
  if (base.unavailable) return base;
  const ordered = orderedRunsByMap.get(map) ?? [];
  const first = run.notes[0].hitTime - window * 2,
    last = run.notes[run.notes.length - 1].hitTime + window * 2;
  let lo = 0,
    hi = ordered.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ordered[mid].notes[ordered[mid].notes.length - 1].hitTime < first) lo = mid + 1;
    else hi = mid;
  }
  const peers: Run[] = [];
  for (let k = lo; k < ordered.length && ordered[k].notes[0].hitTime <= last; k++) {
    if (k - lo >= STREAM_INPUT_POLICY.maximumCachedRuns)
      return {
        ...base,
        assignments: [],
        scopes: {},
        unavailable: true,
        limitations: [...base.limitations, "stream-overlap-run-limit"],
      };
    if (ordered[k].notes.length >= 3) peers.push(ordered[k]);
    if (peers.length > STREAM_INPUT_POLICY.maximumCachedRuns)
      return {
        ...base,
        assignments: [],
        scopes: {},
        unavailable: true,
        limitations: [...base.limitations, "stream-overlap-run-limit"],
      };
  }
  if (peers.length === 1 && peers[0] === run) return base;
  const tables=new Map(peers.map(peer=>[peer,peer===run ? base : alignRun(peer,map,trace,index)]));
  if(run.familyId || peers.some(peer=>peer.familyId)) {
    const familyPeers=peers.filter(peer=>peer.familyId);
    const localTables=peers.flatMap(peer=>{
      const table=tables.get(peer)!;
      if(table.unavailable)return [];
      return [{familyId:peer.familyId ?? peer.id,assignments:table.assignments.filter(row=>row.confidence==="anchored" ||
          ((!row.componentId || !table.unknownHistoryComponentIds?.has(row.componentId)) &&
            (!peer.artificialLeft || (table.historyResetSequence!==undefined &&
              (!row.inputId || (index.inputs[index.positions.get(row.inputId) ?? -1]?.sequence ?? -1)>=table.historyResetSequence))))),
        scopes:table.scopes,alternatives:table.alternatives.get(targetId) ?? []}];
    });
    const merged=reconcileStreamTables(targetId,localTables,
      [...base.assignments.flatMap(row=>row.inputId ? [row.inputId] : []),...rawIds],
      (a,b)=>(index.positions.get(a) ?? Number.MAX_SAFE_INTEGER)-(index.positions.get(b) ?? Number.MAX_SAFE_INTEGER)||a.localeCompare(b));
    if(merged.unavailable)return {...base,assignments:[],scopes:{},unavailable:true,limitations:[...base.limitations,...merged.limitations]};
    const alternatives=new Map(base.alternatives);
    if(merged.alternatives.length)alternatives.set(targetId,merged.alternatives);
    base={...base,boundedTables:true,assignments:merged.assignments,scopes:merged.scopes,alternatives,
      limitations:[...base.limitations,...merged.limitations]};
    // Local source failures in another core cannot invalidate complete unrelated
    // evidence. A peer with an incomplete live dependency on a current pulse
    // can still compete, however, and must not be silently discarded.
    const relevant=new Set([...base.assignments.flatMap(row=>row.inputId ? [row.inputId] : []),...rawIds]);
    for(const peer of familyPeers.filter(peer=>tables.get(peer)?.unavailable)) {
      for(const note of peer.notes.slice(peer.ownedStart ?? 0,peer.ownedEnd ?? peer.notes.length)) {
        const local=deriveCircleEvidence(trace,map,note.id);
        if(local.inputs.some(input=>relevant.has(input.record.id)&&input.record.freshActions.length&&input.inLiveSuccess&&!input.postTerminal) &&
            (local.limits.truncated||Object.values(local.dependencies).some(dependency=>dependency.status!=="complete")))
          return {...base,assignments:[],scopes:{},unavailable:true,limitations:[...base.limitations,"stream-peer-dependency-unavailable"]};
      }
    }
    // Reconcile the merged view exactly once. Replaying raw family tables in
    // the older natural-run pass would resurrect a rejected ownership claim.
    return base;
  }
  const claims = new Map<string, StreamAssignment[]>();
  for (const peer of peers) {
    const table = peer === run ? base : tables.get(peer)!;
    if (table.unavailable) continue;
    for (const a of table.assignments)
      if (a.inputId && a.componentId && a.relation === "matched") {
        const list = claims.get(a.inputId) ?? [];
        list.push(a);
        claims.set(a.inputId, list);
      }
  }
  const inputIds = new Set([...base.assignments.flatMap((a) => (a.inputId ? [a.inputId] : [])), ...rawIds]);
  if (inputIds.size > STREAM_INPUT_POLICY.maximumActions)
    return {
      ...base,
      assignments: [],
      scopes: {},
      unavailable: true,
      limitations: [...base.limitations, "stream-action-limit"],
    };
  const assignments = base.assignments.filter((a) => !a.inputId);
  const scopes = { ...base.scopes };
  const strength = (a: StreamAssignment) => (a.confidence === "anchored" ? 3 : a.basis === "cadence" ? 2 : 1);
  for (const id of inputIds) {
    const list = claims.get(id) ?? [],
      original = base.assignments.find((a) => a.inputId === id);
    if (!list.length) {
      if (original) assignments.push(original);
      continue;
    }
    const top = Math.max(...list.map(strength));
    const strongest = list.filter((a) => strength(a) === top),
      owners = new Set(strongest.map((a) => a.componentId));
    const distinct = new Set(list.map((a) => a.componentId));
    if (owners.size > 1) {
      assignments.push({
        inputId: id,
        relation: "ambiguous",
        confidence: "ambiguous",
        eventIds: [...new Set(list.flatMap((a) => a.eventIds))],
        competingClaims: list.map((a) => ({
          componentId: a.componentId as string,
          confidence: a.confidence,
          basis: a.basis,
          eventIds: a.eventIds,
        })),
      });
      delete scopes[id];
      continue;
    }
    const winner = strongest[0];
    assignments.push(
      distinct.size > 1
        ? {
            ...winner,
            competingClaims: list.map((a) => ({
              componentId: a.componentId as string,
              confidence: a.confidence,
              basis: a.basis,
              eventIds: a.eventIds,
            })),
          }
        : winner,
    );
    if (original?.componentId !== winner.componentId) delete scopes[id];
  }
  return { ...base, assignments, scopes };
}
const alignments = new WeakMap<ReplayTrace, WeakMap<Beatmap, Map<string, Alignment>>>();
function afterLiveEnd(record: { timeMs: number; sequence: number }, evidence: CircleEvidence): boolean {
  const end = evidence.domains.liveSuccess.end;
  return (
    !!end &&
    (record.timeMs > end.timeMs ||
      (record.timeMs === end.timeMs && (end.sequence === undefined || record.sequence >= end.sequence)))
  );
}
type GeometricEvidence = CircleEvidence & { geometry: NonNullable<CircleEvidence["geometry"]> };
const radius = (input: InputRecord, e: GeometricEvidence) => {
  const round = e.geometry.profile === "stable" ? Math.fround : (value: number) => value;
  return (
    Math.hypot(
      round(input.position.x) - round(e.geometry.position.x),
      round(input.position.y) - round(e.geometry.position.y),
    ) / e.geometry.radius
  );
};
function alignRun(run: Run, map: Beatmap, trace: ReplayTrace, index: SourceIndex): Alignment {
  let maps = alignments.get(trace);
  if (!maps) {
    maps = new WeakMap();
    alignments.set(trace, maps);
  }
  let cache = maps.get(map);
  if (!cache) {
    cache = new Map();
    maps.set(map, cache);
  }
  const old = cache.get(run.id);
  if (old) return old;
  const activeCache = cache;
  const result: Alignment = { assignments: [], scopes: {}, freshTimes: [], alternatives: new Map(), limitations: [] };
  const save = () => {
    while (activeCache.size >= STREAM_INPUT_POLICY.maximumCachedRuns)
      activeCache.delete(activeCache.keys().next().value as string);
    activeCache.set(run.id, result);
    return result;
  };
  const candidates = run.notes.map((n) => deriveCircleEvidence(trace, map, n.id));
  if (
    candidates.some(
      (e) =>
        !e.geometry ||
        !e.terminal ||
        e.limits.truncated ||
        Object.values(e.dependencies).some((d) => d.status !== "complete"),
    )
  ) {
    result.unavailable = true;
    result.limitations.push("incomplete-stream-run-evidence");
    return save();
  }
  const evidence = candidates as GeometricEvidence[];
  // Use the indexed local evidence slice rather than scanning every trace input.
  const start = evidence[0].inputs[0],
    end = evidence[evidence.length - 1].inputs.slice(-1)[0];
  const from = start && index.positions.get(start.record.id),
    through = end && index.positions.get(end.record.id);
  if (from === undefined || through === undefined || through < from || through - from > 32768) {
    result.unavailable = true;
    result.limitations.push("stream-source-bound");
    return save();
  }
  const spacing = run.notes.slice(1).map((n, i) => n.hitTime - run.notes[i].hitTime);
  const interval = spacing.slice().sort((a, b) => a - b)[spacing.length >> 1];
  const first = run.notes[0].hitTime - evidence[0].geometry.hitWindows[2],
    last = run.notes[run.notes.length - 1].hitTime + evidence[evidence.length - 1].geometry.hitWindows[2];
  const inputs = index.inputs.slice(from, through + 1).filter((i) => i.timeMs >= first && i.timeMs <= last);
  if(run.familyId && inputs.length<3) {
    result.unavailable=true;
    result.limitations.push("stream-source-window-uncovered");
    return save();
  }
  if (
    inputs.some(
      (r, i) =>
        r.source.origin !== "parsed" ||
        (i > 0 &&
          (inputs[i - 1].source.origin !== "parsed" ||
            r.source.parsedFrameIndex !== (inputs[i - 1].source as { parsedFrameIndex: number }).parsedFrameIndex + 1 ||
            r.source.discontinuityBefore?.length ||
            r.timeMs < inputs[i - 1].timeMs)),
    )
  ) {
    result.unavailable = true;
    result.limitations.push("discontinuous-stream-source");
    return save();
  }
  const fresh = inputs.filter((i) => i.freshActions.length);
  result.freshTimes = fresh.map((i) => i.timeMs);
  if (fresh.length > STREAM_INPUT_POLICY.maximumActions) {
    result.unavailable = true;
    result.limitations.push("stream-action-limit");
    return save();
  }
  const noteIndex = new Map(run.notes.map((n, i) => [n.id, i]));
  const anchors: Array<{ slot: number; input: InputRecord; resolution: ResolutionRecord; offset: number }> = [];
  let lastOwned = -1;
  const geometry = (
    input: InputRecord,
    slot: number,
    phase = 0,
    allowForward = false,
  ): StreamAssignment["geometry"] => {
    const e = evidence[slot],
      n = run.notes[slot];
    const samples = e.inputs.filter(
      (i) =>
        i.record.timeMs >= n.hitTime + Math.min(0, phase) - interval &&
        (i.record.timeMs < input.timeMs || (i.record.timeMs === input.timeMs && i.record.sequence <= input.sequence)) &&
        !i.postTerminal,
    );
    if (
      samples.length < 3 ||
      samples.some(
        (s, i) =>
          i > 0 &&
          s.record.timeMs - samples[i - 1].record.timeMs > interval * STREAM_INPUT_POLICY.maximumLocalSampleGapFraction,
      )
    )
      return;
    let closest = samples.reduce((a, b) => (radius(a.record, e) <= radius(b.record, e) ? a : b));
    let min = radius(closest.record, e);
    let forwardIds: string[] = [];
    if (min > STREAM_INPUT_POLICY.maximumSampledDistanceR) {
      if (!allowForward) return;
      // Cadence can precede cursor arrival. Corroborate that specific rhythmic
      // candidate with a continuous approach, never by widening its hit radius
      // or borrowing contact after another press or after the target resolves.
      const forward = e.inputs.filter((i) => i.record.sequence >= input.sequence);
      const approach: typeof forward = [];
      for (const item of forward) {
        const previous = approach[approach.length - 1];
        if (
          item.postTerminal ||
          !item.inLiveSuccess ||
          item.record.timeMs > input.timeMs + interval * STREAM_INPUT_POLICY.maximumLocalSampleGapFraction ||
          (previous &&
            (item.record.freshActions.length > 0 ||
              previous.record.source.origin !== "parsed" ||
              item.record.source.origin !== "parsed" ||
              item.record.source.parsedFrameIndex !== previous.record.source.parsedFrameIndex + 1 ||
              item.record.source.discontinuityBefore?.length ||
              item.record.timeMs <= previous.record.timeMs ||
              item.record.timeMs - previous.record.timeMs >
                interval * STREAM_INPUT_POLICY.maximumLocalSampleGapFraction ||
              radius(item.record, e) > radius(previous.record, e) + 1e-6))
        )
          break;
        approach.push(item);
        if (item.inside) break;
      }
      const contact = approach[approach.length - 1];
      if (approach.length < 3 || !contact?.inside) return;
      closest = contact;
      min = radius(contact.record, e);
      forwardIds = approach.map((i) => i.record.id);
    }
    return {
      minimumSampledR: min,
      pressR: radius(input, e),
      closestTimeMs: closest.record.timeMs,
      eventIds: [...new Set([samples[0].record.id, closest.record.id, input.id, ...forwardIds])],
    };
  };
  const priorPhase = (slot: number, input?: InputRecord) => {
    if(!historyKnown(slot,input))return;
    const eligible = anchors.filter((a) => a.slot < slot),
      b = eligible[eligible.length - 1],
      a = eligible[eligible.length - 2];
    if (!b || slot - b.slot > STREAM_INPUT_POLICY.maximumUnanchoredNotes) return;
    // A complete two-sided bridge also establishes the edge immediately before
    // its successful recovery. Keep that measured cadence for the same bounded
    // lookahead used for adjacent successes. Never seed this from a proximity
    // guess, an unanchored continuation, or a bridge missing/adding an action.
    const bridged =
      a && b.slot !== a.slot + 1
        ? result.assignments.find(
            (row) =>
              row.componentId === run.notes[b.slot - 1]?.id &&
              row.relation === "matched" &&
              row.basis === "cadence" &&
              row.recoveryContext?.inputId === b.input.id &&
              bridgeByInput.get(row.inputId ?? "")?.slot === b.slot - 1,
          )
        : undefined;
    const previousOffset = bridged?.offsetMs ?? (a?.slot === b.slot - 1 ? a.offset : undefined);
    if (
      previousOffset === undefined ||
      Math.abs(previousOffset - b.offset) > interval * STREAM_INPUT_POLICY.anchorConsistencyFraction
    )
      return;
    const phase = (previousOffset + b.offset) / 2;
    const continuationEventIds: string[] = [];
    if (bridged) {
      // Recovery continuation must explain every intervening edge, not restart
      // after silently skipping an early/extra/double press or a missing slot.
      // Absence inference has its own stronger bracketing requirements.
      if (!input) return;
      const edges = fresh.filter((r) => r.sequence > b.input.sequence && r.sequence <= input.sequence);
      if (
        edges.length !== slot - b.slot ||
        edges.some((r, k) => {
          const at = b.slot + k + 1;
          const item = evidence[at].inputs.find((i) => i.record.id === r.id);
          if (
            r.freshActions.length !== 1 ||
            !item?.inLiveSuccess ||
            item.postTerminal ||
            !item.freshActionsKnown ||
            Math.abs(r.timeMs - run.notes[at].hitTime - phase) > interval * STREAM_INPUT_POLICY.maximumResidualFraction
          )
            return true;
          const geo = geometry(r, at, phase, true);
          if (!geo) return true;
          continuationEventIds.push(r.id, ...geo.eventIds);
          return false;
        })
      )
        return;
    }
    return {
      phase,
      offsets: [previousOffset, b.offset],
      eventIds: [
        ...new Set([
          ...(bridged ? bridged.eventIds : [a.input.id, a.resolution.id]),
          b.input.id,
          b.resolution.id,
          ...continuationEventIds,
        ]),
      ],
    };
  };
  // Two-sided recovery constrains every intermediate logical edge at once.
  // An exact source/action count and monotone scheduled order are required;
  // a missing/extra/double edge invalidates this bridge, rather than being
  // silently skipped to fit a favourite press or extrapolated past a miss.
  const bridgeByInput = new Map<
    string,
    {
      slot: number;
      phase: { phase: number; offsets: number[]; eventIds: string[] };
      contextEventIds: string[];
      recoveryContext: NonNullable<StreamAssignment["recoveryContext"]>;
    }
  >();
  const scheduled = [
    ...(run.previous ? [{ note: run.previous, slot: -1 }] : []),
    ...run.notes.map((note, slot) => ({ note, slot })),
    ...(run.following ? [{ note: run.following, slot: run.notes.length }] : []),
  ];
  const scored = scheduled.flatMap(({ note, slot }) => {
    const success = index.successByComponent.get(note.id),
      position = success && index.positions.get(success.inputId);
    if (!success || position === undefined) return [];
    const input = index.inputs[position];
    const endpoint = slot >= 0 && slot < evidence.length ? evidence[slot] : deriveCircleEvidence(trace, map, note.id);
    if (
      !endpoint.geometry ||
      Object.values(endpoint.dependencies).some((d) => d.status !== "complete") ||
      input.freshActions.length !== 1 ||
      index.success.get(input.id)?.length !== 1 ||
      !endpoint.inputs.some(
        (i) => i.record.id === input.id && i.inLiveSuccess && !i.postTerminal && i.freshActionsKnown && i.inside,
      )
    )
      return [];
    return [{ slot, note, input, position, resolution: success.resolution, offset: input.timeMs - note.hitTime }];
  });
  // An artificial scope start is not a rhythm reset. Three complete direct
  // anchors with every intervening fresh edge accounted establish only the
  // existing recent-phase policy. Before that, keep reception observations but
  // refuse inferred ownership/absence rather than forgetting older alternatives.
  let historyReset:{slot:number;sequence:number;eventIds:string[]}|undefined;
  if(run.artificialLeft)for(let k=2;k<scored.length;k++) {
    const group=scored.slice(k-2,k+1),[a,b,c]=group;
    if(a.slot<0 || b.slot!==a.slot+1 || c.slot!==b.slot+1 ||
        group.some(item=>Math.abs(item.offset-a.offset)>interval*STREAM_INPUT_POLICY.anchorConsistencyFraction) ||
        c.position-a.position>32768 || c.position<=a.position)continue;
    const source=index.inputs.slice(a.position,c.position+1);
    const edges=source.filter(input=>input.freshActions.length);
    if(edges.length!==3 || edges.some((input,i)=>input.id!==group[i].input.id || input.freshActions.length!==1) ||
        source.some((input,i)=>input.source.origin!=="parsed" || (i>0 &&
          (source[i-1].source.origin!=="parsed" || input.source.parsedFrameIndex!==(source[i-1].source as {parsedFrameIndex:number}).parsedFrameIndex+1 ||
            input.source.discontinuityBefore?.length || input.timeMs<source[i-1].timeMs ||
            input.timeMs-source[i-1].timeMs>interval*STREAM_INPUT_POLICY.maximumLocalSampleGapFraction))))continue;
    historyReset={slot:c.slot,sequence:c.input.sequence,eventIds:[...source.map(input=>input.id),...group.map(item=>item.resolution.id)]};
    break;
  }
  const historyKnown=(slot:number,input?:InputRecord)=>!run.artificialLeft ||
    (!!historyReset && slot>=historyReset.slot && (!input || input.sequence>=historyReset.sequence));
  if(run.artificialLeft) {
    result.historyResetEventIds=historyReset?.eventIds ?? [];
    result.historyResetSequence=historyReset?.sequence;
    result.unknownHistoryComponentIds=new Set(run.notes.filter((_,slot)=>!historyKnown(slot)).map(note=>note.id));
  }
  for (let j = 1; j < scored.length; j++) {
    const left = scored[j - 1],
      right = scored[j],
      span = right.slot - left.slot;
    if (
      span <= 1 ||
      right.position <= left.position ||
      right.position - left.position > 32768
    )
      continue;
    const consistentPhase=Math.abs(left.offset-right.offset)<=interval*STREAM_INPUT_POLICY.anchorConsistencyFraction;
    const bridge = index.inputs.slice(left.position, right.position + 1),
      edges = bridge.slice(1, -1).filter((i) => i.freshActions.length);
    if (
      edges.some((i) => i.freshActions.length !== 1) ||
      bridge.some(
        (r, i) =>
          r.source.origin !== "parsed" ||
          (i > 0 &&
            (bridge[i - 1].source.origin !== "parsed" ||
              r.source.parsedFrameIndex !==
                (bridge[i - 1].source as { parsedFrameIndex: number }).parsedFrameIndex + 1 ||
              r.source.discontinuityBefore?.length ||
              r.timeMs < bridge[i - 1].timeMs ||
              r.timeMs - bridge[i - 1].timeMs > interval * 0.5)),
      )
    )
      continue;
    // A short burst may have no two earlier successes to seed priorPhase.
    // Two independently observed endpoint receipts can still enclose exactly
    // one missing scheduled pulse. Establish only this source gap, never a
    // forward ownership phase or absence obtained by filtering other actions.
    if(span===2 && edges.length===0) {
      const slot=left.slot+1,e=evidence[slot],n=run.notes[slot];
      if(!e || !n || !historyKnown(slot))continue;
      const phase=left.offset+((right.offset-left.offset)*(n.hitTime-left.note.hitTime))/(right.note.hitTime-left.note.hitTime),
        centre=n.hitTime+phase,live=e.domains.liveSuccess;
      const sameActions=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(action=>b.includes(action));
      const validActions=bridge.every((input,i)=>{
        const previous=i>0 ? bridge[i-1] : index.inputs[left.position-1];
        return previous && input.actions.every(action=>action===0||action===1) &&
          new Set(input.actions).size===input.actions.length && sameActions(input.previousActions,previous.actions) &&
          sameActions(input.freshActions,input.actions.filter(action=>!input.previousActions.includes(action)));
      });
      const validEndpoints=[left,right].every(endpoint=>{
        const attempt=index.attempts.get(endpoint.resolution.triggerAttemptId ?? "");
        return attempt && attempt.knownAction===endpoint.input.freshActions[0] &&
          sameActions(attempt.actionCandidates,endpoint.input.freshActions);
      });
      if(!validActions || !validEndpoints)continue;
      const samples=e.inputs.filter(i=>i.record.sequence>left.input.sequence && i.record.sequence<right.input.sequence &&
        i.inLiveSuccess && !i.postTerminal && Math.abs(i.record.timeMs-centre)<=interval*STREAM_INPUT_POLICY.localPhaseFraction);
      const phaseBracket=samples.findIndex(i=>i.record.timeMs>=centre);
      const phaseInside=phaseBracket>=0 && samples[phaseBracket].inside &&
        (samples[phaseBracket].record.timeMs===centre || (phaseBracket>0 && samples[phaseBracket-1].inside));
      const phaseEnvelopeMs:[number,number]=[Math.min(left.offset,right.offset),Math.max(left.offset,right.offset)],
        envelopeStart=n.hitTime+phaseEnvelopeMs[0],envelopeEnd=n.hitTime+phaseEnvelopeMs[1];
      // Across a natural rhythm change, independently close one raw action gap
      // only if every admissible endpoint phase is covered inside this receptor.
      // Both raw brackets and every member must be inside, a stricter proof than
      // selecting one interpolated phase. It does not widen cadence ownership.
      const envelopeSource=bridge.filter((input,i)=>input.timeMs>=envelopeStart&&input.timeMs<=envelopeEnd ||
        (i+1<bridge.length&&input.timeMs<envelopeStart&&bridge[i+1].timeMs>=envelopeStart) ||
        (i>0&&input.timeMs>envelopeEnd&&bridge[i-1].timeMs<=envelopeEnd));
      const completeEnvelope=!consistentPhase && live.start && live.end && envelopeStart>live.start.timeMs &&
        envelopeEnd<live.end.timeMs && left.input.timeMs<envelopeStart && envelopeEnd<right.input.timeMs &&
        envelopeSource.length>=2 && envelopeSource[0].timeMs<=envelopeStart &&
        envelopeSource[envelopeSource.length-1].timeMs>=envelopeEnd &&
        envelopeSource.every((input,i)=>radius(input,e)<=1 && (i===0 ||
          (input.timeMs>envelopeSource[i-1].timeMs && input.timeMs-envelopeSource[i-1].timeMs<=
            Math.min(n.hitTime-left.note.hitTime,right.note.hitTime-n.hitTime)*STREAM_INPUT_POLICY.maximumLocalSampleGapFraction)));
      if(!live.start || !live.end || centre<=live.start.timeMs || centre>=live.end.timeMs ||
        samples.length<3 || (!consistentPhase && !completeEnvelope) || (consistentPhase && !phaseInside) ||
        e.inputs.some(i=>i.inLiveSuccess && !i.postTerminal && i.record.freshActions.length &&
          i.record.id!==left.input.id && i.record.id!==right.input.id))continue;
      result.assignments.push({componentId:n.id,relation:"missing",confidence:"corroborated",phaseMs:phase,
        basis:"closed-source-gap",...(!consistentPhase ? {phaseEnvelopeMs} : {}),
        anchorOffsetsMs:[left.offset,right.offset],
        eventIds:[...new Set([...bridge.map(i=>i.id),left.resolution.id,right.resolution.id])],
        contextEventIds:[left.input.id,left.resolution.id,right.input.id,right.resolution.id],
        recoveryContext:{inputId:right.input.id,resolutionId:right.resolution.id,timeMs:right.input.timeMs,
          afterTargetLiveEnd:afterLiveEnd(right.input,e)}});
      continue;
    }
    if(!consistentPhase || edges.length!==span-1)continue;
    const proposed = edges.map((input, k) => {
      const slot = left.slot + k + 1,
        e = evidence[slot],
        n = run.notes[slot];
      if (!e || !n || !historyKnown(slot,input)) return;
      const source = e.inputs.find((i) => i.record.id === input.id),
        geo = geometry(input, slot, 0, true);
      const phase =
        left.offset +
        ((right.offset - left.offset) * (n.hitTime - left.note.hitTime)) / (right.note.hitTime - left.note.hitTime);
      if (
        !source?.inLiveSuccess ||
        source.postTerminal ||
        !source.freshActionsKnown ||
        !geo ||
        Math.abs(input.timeMs - n.hitTime - phase) > interval * STREAM_INPUT_POLICY.maximumResidualFraction
      )
        return;
      return { input, slot, phase, geometryEventIds: geo.eventIds };
    });
    if (proposed.some((p) => !p)) continue;
    for (const row of proposed)
      if (row)
        bridgeByInput.set(row.input.id, {
          slot: row.slot,
          phase: {
            phase: row.phase,
            offsets: [left.offset, right.offset],
            eventIds: [
              left.input.id,
              left.resolution.id,
              ...edges.map((i) => i.id),
              ...proposed.flatMap((p) => p?.geometryEventIds ?? []),
              right.input.id,
              right.resolution.id,
            ],
          },
          contextEventIds: [
            right.input.id,
            right.resolution.id,
            ...edges.filter((i) => afterLiveEnd(i, evidence[row.slot])).map((i) => i.id),
          ],
          recoveryContext: {
            inputId: right.input.id,
            resolutionId: right.resolution.id,
            timeMs: right.input.timeMs,
            afterTargetLiveEnd: afterLiveEnd(right.input, evidence[row.slot]),
          },
        });
  }
  for (const input of fresh) {
    const successes = index.success.get(input.id) ?? [];
    if (successes.length === 1 && input.freshActions.length === 1) {
      const resolution = successes[0],
        slot = noteIndex.get(resolution.componentId);
      if (slot === undefined) {
        result.assignments.push({
          componentId: resolution.componentId,
          inputId: input.id,
          relation: "matched",
          confidence: "anchored",
          eventIds: [input.id, resolution.id, resolution.triggerAttemptId as string],
        });
        continue;
      }
      const offset = input.timeMs - run.notes[slot].hitTime;
      result.assignments.push({
        componentId: resolution.componentId,
        inputId: input.id,
        relation: "matched",
        confidence: "anchored",
        offsetMs: offset,
        eventIds: [input.id, resolution.id, resolution.triggerAttemptId as string],
      });
      anchors.push({ slot, input, resolution, offset });
      lastOwned = Math.max(lastOwned, slot);
      continue;
    }
    if (input.freshActions.length !== 1 || successes.length) {
      result.assignments.push({
        inputId: input.id,
        relation: "ambiguous",
        confidence: "ambiguous",
        eventIds: [input.id],
      });
      continue;
    }
    const candidates = run.notes
      .flatMap((n, slot) => {
        if(!historyKnown(slot,input))return [];
        if (slot < lastOwned) return [];
        const bridge = bridgeByInput.get(input.id);
        if (bridge && bridge.slot !== slot) return [];
        const phase = bridge?.phase ?? priorPhase(slot, input);
        if (!phase) return [];
        const item = evidence[slot].inputs.find((i) => i.record.id === input.id);
        if (!item?.inLiveSuccess || item.postTerminal || !item.freshActionsKnown) return [];
        const residual = input.timeMs - n.hitTime - phase.phase;
        if (Math.abs(residual) > interval * STREAM_INPUT_POLICY.maximumResidualFraction) return [];
        const geo = geometry(input, slot, 0, true);
        if (!geo) return [];
        return [{ slot, phase, residual, geo }];
      })
      .sort((a, b) => Math.abs(a.residual) - Math.abs(b.residual));
    if (!candidates.length) {
      const live = run.notes.flatMap((n, slot) => {
        if(!historyKnown(slot,input))return [];
        const item = evidence[slot].inputs.find((i) => i.record.id === input.id);
        if (slot < lastOwned || !item?.inLiveSuccess || item.postTerminal || !item.freshActionsKnown) return [];
        return [{ slot, pressR: radius(input, evidence[slot]) }];
      });
      const local = live.filter(
        ({ slot, pressR }) =>
          pressR <= STREAM_INPUT_POLICY.maximumSampledDistanceR &&
          Math.abs(input.timeMs - run.notes[slot].hitTime) <= interval * STREAM_INPUT_POLICY.localPhaseFraction &&
          live.every(
            (other) => other.slot === slot || other.pressR - pressR >= STREAM_INPUT_POLICY.localRadialAdvantage,
          ),
      );
      if (local.length === 1) {
        const slot = local[0].slot,
          geo = geometry(input, slot);
        if (geo)
          candidates.push({
            slot,
            geo,
            residual: input.timeMs - run.notes[slot].hitTime,
            phase: { phase: 0, offsets: [], eventIds: [...geo.eventIds] },
          });
      }
    }
    const best = candidates[0],
      runner = candidates[1];
    if (
      !best ||
      (runner &&
        Math.abs(runner.residual) - Math.abs(best.residual) <
          interval * STREAM_INPUT_POLICY.minimumAlternativeMarginFraction)
    ) {
      result.assignments.push({
        inputId: input.id,
        relation: anchors.length >= 2 ? "extra" : "ambiguous",
        confidence: "ambiguous",
        eventIds: [input.id],
      });
      continue;
    }
    lastOwned = best.slot;
    const n = run.notes[best.slot],
      e = evidence[best.slot];
    result.assignments.push({
      componentId: n.id,
      inputId: input.id,
      relation: "matched",
      confidence: "corroborated",
      offsetMs: input.timeMs - n.hitTime,
      phaseResidualMs: best.residual,
      phaseMs: best.phase.phase,
      basis: best.phase.offsets.length ? "cadence" : "scheduled-geometric",
      anchorOffsetsMs: best.phase.offsets,
      geometry: best.geo,
      eventIds: [...new Set([input.id, ...best.phase.eventIds, ...best.geo.eventIds])],
      ...(bridgeByInput.has(input.id)
        ? {
            contextEventIds: bridgeByInput.get(input.id)?.contextEventIds,
            recoveryContext: bridgeByInput.get(input.id)?.recoveryContext,
          }
        : {}),
    });
    const next = run.notes[best.slot + 1];
    if (next && best.geo.pressR > 1 && best.geo.minimumSampledR <= 1 && best.geo.closestTimeMs < input.timeMs) {
      const nextDistance =
        Math.hypot(input.position.x - next.position.x, input.position.y - next.position.y) /
        evidence[best.slot + 1].geometry.radius;
      const departure = e.inputs.filter(
        (i) =>
          i.record.timeMs >= best.geo.closestTimeMs &&
          (i.record.timeMs < input.timeMs || (i.record.timeMs === input.timeMs && i.record.sequence <= input.sequence)),
      );
      const nextAnchor = scored.find((a) => a.slot === best.slot + 1),
        pressPosition = index.positions.get(input.id);
      const toAnchor =
        nextAnchor &&
        pressPosition !== undefined &&
        nextAnchor.position > pressPosition &&
        nextAnchor.position - pressPosition <= 4096 &&
        best.phase.offsets.length > 0 &&
        Math.abs(nextAnchor.offset - best.phase.phase) <= interval * STREAM_INPUT_POLICY.anchorConsistencyFraction
          ? index.inputs.slice(pressPosition, nextAnchor.position + 1)
          : [];
      const nextR = (r: InputRecord) => radius(r, evidence[best.slot + 1]);
      // Arrival closes the onward approach. Later settling within the next
      // receptor is not required to keep moving monotonically toward its centre.
      const arrival = toAnchor.findIndex((r) => nextR(r) <= 1);
      const forward = arrival > 0 ? toAnchor.slice(0, arrival + 1) : [];
      const forwardRecovery =
        forward.length >= 3 &&
        forward.every(
          (r, i) =>
            r.source.origin === "parsed" &&
            (i === 0 ||
              (forward[i - 1].source.origin === "parsed" &&
                r.source.parsedFrameIndex ===
                  (forward[i - 1].source as { parsedFrameIndex: number }).parsedFrameIndex + 1 &&
                !r.source.discontinuityBefore?.length &&
                r.timeMs >= forward[i - 1].timeMs &&
                r.timeMs - forward[i - 1].timeMs <= interval * 0.5 &&
                radius(r, e) + 1e-6 >= radius(forward[i - 1], e) &&
                nextR(r) <= nextR(forward[i - 1]) + 1e-6)),
        );
      if (
        (nextDistance < best.geo.pressR || forwardRecovery) &&
        departure.every((s, i) => i === 0 || radius(s.record, e) + 1e-6 >= radius(departure[i - 1].record, e))
      )
        result.scopes[input.id] = {
          placementEnd: { timeMs: input.timeMs, sequence: input.sequence, eventId: input.id, inclusive: true },
          eventIds: [
            ...new Set([
              ...best.phase.eventIds,
              ...departure.map((s) => s.record.id),
              ...(forwardRecovery ? forward.map((s) => s.id) : []),
            ]),
          ],
          ...(forwardRecovery
            ? {
                contextEventIds: [
                  ...forward.filter((s) => s.sequence > input.sequence).map((s) => s.id),
                  nextAnchor?.resolution.id as string,
                ],
              }
            : {}),
        };
    }
  }
  for (let slot = 1; slot < run.notes.length - 1; slot++) {
    if(!historyKnown(slot))continue;
    if (result.assignments.some((a) => a.componentId === run.notes[slot].id)) continue;
    const before = anchors.filter((a) => a.slot < slot).slice(-1)[0],
      after = anchors.find((a) => a.slot > slot),
      phase = priorPhase(slot);
    if (
      !before ||
      !after ||
      !phase ||
      after.slot !== slot + 1 ||
      before.slot !== slot - 1 ||
      Math.abs(after.offset - phase.phase) > interval * STREAM_INPUT_POLICY.anchorConsistencyFraction
    )
      continue;
    const centre = run.notes[slot].hitTime + phase.phase;
    const unassigned = result.assignments.some(
      (a) =>
        a.inputId &&
        a.relation !== "matched" &&
        Math.abs((inputs.find((i) => i.id === a.inputId)?.timeMs ?? Infinity) - centre) <= interval * 0.5,
    );
    if (unassigned) continue;
    const samples = evidence[slot].inputs.filter(
      (i) => i.inLiveSuccess && !i.postTerminal && Math.abs(i.record.timeMs - centre) <= interval * 0.5,
    );
    if (
      samples.length < 3 ||
      !samples.some((i) => i.inside) ||
      samples.some((s, i) => i > 0 && s.record.timeMs - samples[i - 1].record.timeMs > interval * 0.5)
    )
      continue;
    result.assignments.push({
      componentId: run.notes[slot].id,
      relation: "missing",
      confidence: "corroborated",
      phaseMs: phase.phase,
      anchorOffsetsMs: phase.offsets,
      eventIds: [...phase.eventIds, after.input.id, after.resolution.id, ...samples.map((s) => s.record.id)],
      contextEventIds: [after.input.id, after.resolution.id],
      recoveryContext: {
        inputId: after.input.id,
        resolutionId: after.resolution.id,
        timeMs: after.input.timeMs,
        afterTargetLiveEnd: afterLiveEnd(after.input, evidence[slot]),
      },
    });
  }
  // A terminal slider head has no later same-run tap (the run deliberately
  // stops before slider tracking). A complete recorded gap can still establish
  // the omitted slot when the immediately following scheduled object recovers.
  // That later press is context, never a post-terminal opportunity for this head.
  const finalSlot = run.notes.length - 1,
    finalNote = run.notes[finalSlot],
    finalEvidence = evidence[finalSlot];
  const following = run.following,
    finalPhase = priorPhase(finalSlot);
  const previousAnchor = anchors.filter((a) => a.slot < finalSlot).slice(-1)[0];
  const recovery = following && index.successByComponent.get(following.id);
  if (
    finalNote.sliderId &&
    following &&
    recovery &&
    finalPhase &&
    previousAnchor?.slot === finalSlot - 1 &&
    !result.assignments.some((a) => a.componentId === finalNote.id)
  ) {
    const recoveryIndex = index.positions.get(recovery.inputId),
      previousIndex = index.positions.get(previousAnchor.input.id);
    const centre = finalNote.hitTime + finalPhase.phase,
      live = finalEvidence.domains.liveSuccess;
    if (
      recoveryIndex !== undefined &&
      previousIndex !== undefined &&
      recoveryIndex > previousIndex &&
      recoveryIndex - previousIndex <= 4096 &&
      live.start &&
      live.end &&
      centre > live.start.timeMs &&
      centre < live.end.timeMs &&
      following.hitTime - finalNote.hitTime <= interval * 8
    ) {
      const recoveryInput = index.inputs[recoveryIndex],
        recoveryEvidence = deriveCircleEvidence(trace, map, following.id);
      const bridge = index.inputs.slice(previousIndex, recoveryIndex + 1);
      const contact = finalEvidence.inputs.filter(
        (i) =>
          i.inLiveSuccess &&
          !i.postTerminal &&
          i.record.timeMs > previousAnchor.input.timeMs &&
          Math.abs(i.record.timeMs - centre) <= interval * 0.5,
      );
      if (
        recoveryEvidence.geometry &&
        Object.values(recoveryEvidence.dependencies).every((d) => d.status === "complete") &&
        recoveryEvidence.inputs.some(
          (i) => i.record.id === recoveryInput.id && i.inLiveSuccess && i.freshActionsKnown && i.inside,
        ) &&
        previousAnchor.input.timeMs < centre - interval * 0.5 &&
        recoveryInput.timeMs > centre + interval * 0.5 &&
        bridge.slice(1, -1).every((i) => i.freshActions.length === 0) &&
        bridge.every(
          (r, i) =>
            r.source.origin === "parsed" &&
            (i === 0 ||
              (bridge[i - 1].source.origin === "parsed" &&
                r.source.parsedFrameIndex ===
                  (bridge[i - 1].source as { parsedFrameIndex: number }).parsedFrameIndex + 1 &&
                !r.source.discontinuityBefore?.length &&
                r.timeMs > bridge[i - 1].timeMs &&
                r.timeMs - bridge[i - 1].timeMs <= interval * 0.5)),
        ) &&
        contact.length >= 3 &&
        contact.some((i) => i.inside)
      ) {
        result.assignments.push({
          componentId: finalNote.id,
          relation: "missing",
          confidence: "corroborated",
          phaseMs: finalPhase.phase,
          anchorOffsetsMs: finalPhase.offsets,
          eventIds: [
            ...new Set([
              ...finalPhase.eventIds,
              ...bridge.map((i) => i.id),
              recovery.resolution.id,
              ...(live.end.eventId ? [live.end.eventId] : []),
            ]),
          ],
          contextEventIds: [
            ...bridge.filter((i) => afterLiveEnd(i, finalEvidence)).map((i) => i.id),
            recovery.resolution.id,
          ],
          recoveryContext: {
            inputId: recoveryInput.id,
            resolutionId: recovery.resolution.id,
            timeMs: recoveryInput.timeMs,
            afterTargetLiveEnd: afterLiveEnd(recoveryInput, finalEvidence),
          },
        });
      }
    }
  }
  // A successful receiver can shift one note while the actual action cadence
  // continues. Keep that earlier sequence as an explicit competing hypothesis.
  // Several later direct anchors permit a bounded *recent-phase policy*; they
  // do not prove the player's intended note, and the alternative is retained.
  for (let j = 2; j < anchors.length; j++) {
    const a = anchors[j - 2],
      b = anchors[j - 1],
      c = anchors[j];
    if (
      b.slot !== a.slot + 1 ||
      c.slot <= b.slot ||
      c.slot - b.slot > STREAM_INPUT_POLICY.maximumUnanchoredNotes ||
      Math.abs(a.offset - b.offset) > interval * STREAM_INPUT_POLICY.anchorConsistencyFraction
    )
      continue;
    const phase = (a.offset + b.offset) / 2;
    if (Math.abs(c.offset - phase - interval) > interval * STREAM_INPUT_POLICY.anchorConsistencyFraction) continue;
    const intervening = fresh.filter((i) => i.sequence > b.input.sequence && i.sequence < c.input.sequence);
    if (
      intervening.length !== c.slot - b.slot ||
      intervening.some(
        (input, k) =>
          input.freshActions.length !== 1 ||
          !geometry(input, b.slot + k + 1, phase) ||
          Math.abs(input.timeMs - run.notes[b.slot + k + 1].hitTime - phase) >
            interval * STREAM_INPUT_POLICY.anchorConsistencyFraction,
      )
    )
      continue;
    for (let slot = c.slot; slot < run.notes.length; slot++) {
      const candidates = evidence[slot].inputs.filter(
        (i) =>
          i.inLiveSuccess &&
          !i.postTerminal &&
          i.freshActionsKnown &&
          i.record.freshActions.length === 1 &&
          Math.abs(i.record.timeMs - run.notes[slot].hitTime - phase) <=
            interval * STREAM_INPUT_POLICY.anchorConsistencyFraction,
      );
      if (candidates.length !== 1) continue;
      const current = candidates[0].record;
      const continued = fresh.filter((i) => i.sequence >= intervening[0].sequence && i.sequence <= current.sequence);
      if (
        continued.some(
          (i, k) =>
            k > 0 &&
            Math.abs(i.timeMs - continued[k - 1].timeMs - interval) >
              interval * STREAM_INPUT_POLICY.anchorConsistencyFraction,
        )
      )
        continue;
      let recentAnchorCount = 0;
      for (let k = j; k < anchors.length && anchors[k].slot < slot; k++) {
        if (
          (k > j && anchors[k].slot !== anchors[k - 1].slot + 1) ||
          Math.abs(anchors[k].offset - c.offset) > interval * STREAM_INPUT_POLICY.anchorConsistencyFraction
        )
          break;
        recentAnchorCount++;
      }
      const list = result.alternatives.get(run.notes[slot].id) ?? [];
      list.push({
        phaseMs: phase,
        targetInputIds: [current.id],
        reason: "one-slot-reception-shift",
        active: recentAnchorCount < STREAM_INPUT_POLICY.recentPhaseAnchorCount,
        recentAnchorCount,
        eventIds: [
          a.input.id,
          a.resolution.id,
          b.input.id,
          b.resolution.id,
          intervening[0].id,
          c.input.id,
          c.resolution.id,
          ...continued.map((i) => i.id),
        ],
      });
      result.alternatives.set(run.notes[slot].id, list);
    }
  }
  if(result.historyResetEventIds?.length) {
    result.assignments=result.assignments.map(row=>row.confidence==="corroborated" ?
      {...row,eventIds:[...new Set([...result.historyResetEventIds!,...row.eventIds])]} : row);
  }
  return save();
}
