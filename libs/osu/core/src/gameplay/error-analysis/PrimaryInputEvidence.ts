import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import {
  AttemptRecord,
  CircleEvidence,
  CircleInputEvidence,
  deriveCircleEvidence,
  derivePreResolutionRejections,
  InputRecord,
  ResolutionRecord,
  RoutingRecord,
} from "../miss-explanation/CircleEvidence";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import { errorCapabilities } from "./ErrorCapabilities";
import { analyzePrimaryApproaches } from "./PrimaryApproach";
import { deriveStreamInputEvidence, StreamInputEvidence } from "./StreamInputEvidence";
import { deriveSliderHeadOmission } from "./ShortSliderHeadOmission";
import { derivePreterminalReceiverRejection } from "./PreterminalReceiverRejection";

/** Declared conservative cluster policy, measured in local judgement/rhythm units. */
export const PRIMARY_INPUT_POLICY = Object.freeze({
  version: "primary-input-v12",
  bestWindowFraction: 0.5,
  rhythmFraction: 0.125,
  neighbourMinRadialAdvantage: 0.025,
  neighbourComparisonTolerance: 1e-6,
  neighbourCacheEntries: 128,
  neighbourCacheWitnessReferences: 8192,
  completedNeighbourPathR: 1,
  completedNeighbourBestWindows: 1,
});

export interface NeighbourInputAssociation {
  componentId: string;
  direction: "earlier" | "later";
  radialR: number;
  targetRadialR: number;
  phaseWindows: number;
  targetPhaseWindows: number;
  support: "sampled-pass" | "misplaced-landing" | "completed-footprint" | "completed-departure";
  provenance: "sampled" | "reconstructed";
  eventIds: string[];
  completedContext?: { successInputId: string; resolutionId: string; pathR: number; elapsedBestWindows: number };
}

export interface PrimaryInputEvidence {
  policyVersion: string;
  relevantInputIds: string[];
  contextInputIds: string[];
  associations: Array<{
    inputId: string;
    role: "relevant" | "context" | "ambiguous";
    reasons: string[];
    eventIds: string[];
    neighbour?: NeighbourInputAssociation;
    /** Stable exposes attempt capacity, not which physical action was consumed. */
    residualAttempts?: {
      attemptIds: string[];
      consumedAttemptIds: string[];
      selectionIds: string[];
      knownActions: number[];
      actionIdentity: "known-action" | "ordinal-capacity";
    };
  }>;
  harmfulSurplus?: {
    inputId: string;
    precedingSuccessInputId: string;
    precedingSuccessResolutionId: string;
    replacementInputId: string;
    replacementScope: "post-terminal-counterfactual";
    eventIds: string[];
  };
  stream?: StreamInputEvidence;
  missingAction?: {
    previousComponentId: string;
    followingComponentId?: string;
    previousAnchorComponentId?: string;
    eventIds: string[];
    contextEventIds: string[];
    scope: "complete-bracketed-source-gap" | "complete-recorded-tail-gap" | "complete-recorded-head-gap";
    headOpportunity?: { inputId: string; earlierResolutionIds: string[]; liveEnd: NonNullable<CircleEvidence["domains"]["liveSuccess"]["end"]>; eventIds: string[] };
  };
  /** The target was never queried: an earlier receptor stopped this exact
   * otherwise-usable local tap with a validated order rejection. */
  stoppedDispatchRejections?: Array<{
    inputId: string;
    receiverId: string;
    blockerId: string;
    policyId: string;
    targetOffsetMs: number;
    eventIds: string[];
    scope: "unqueried-target-beyond-rejected-receiver";
  }>;
  limitations: string[];
  /** Comparison alternatives, not observed target ownership or consumption. */
  targetDependentRejections?: Array<{inputId:string;receiverId:string;policyId:string;eventIds:string[]}>;
}

export function derivePrimaryInputEvidence(
  evidence: CircleEvidence,
  map: Beatmap,
  trace?: ReplayTrace,
  excludedComponentIds?: ReadonlySet<string>,
): PrimaryInputEvidence {
  const result: PrimaryInputEvidence = {
    policyVersion: PRIMARY_INPUT_POLICY.version,
    relevantInputIds: [],
    contextInputIds: [],
    associations: [],
    limitations: [...evidence.limitations],
  };
  const { target, geometry, terminal } = evidence;
  if (!target || !geometry || !terminal || evidence.limits.truncated) {
    result.limitations.push("incomplete-target-association");
    return result;
  }
  let index: InputIndex | undefined;
  if (trace) {
    if (
      Object.keys(trace.identity).length !== Object.keys(evidence.identity).length ||
      Object.entries(evidence.identity).some(
        ([key, value]) => trace.identity[key as keyof typeof trace.identity] !== value,
      )
    )
      result.limitations.push("trace-identity-mismatch");
    else {
      index = traceIndex(trace);
      if (index.invalid) {
        result.limitations.push("invalid-trace-index");
        index = undefined;
      }
    }
  } else result.limitations.push("successful-neighbour-results-unavailable");
  if (index && trace) {
    const streamIndex = index;
    result.stream = deriveStreamInputEvidence(evidence, map, trace);
    if (result.stream.missingTargetTap && excludedComponentIds?.size) {
      const excluded = (id: string) => {
        const object = map.getHitObject(id);
        return excludedComponentIds.has(id) ||
          (object instanceof HitCircle && !!object.sliderId && excludedComponentIds.has(object.sliderId));
      };
      // The raw cadence gap remains observable. A saved-outcome conflict in
      // any supporting receipt prevents using that model anchor to prove an
      // omission; query-local exclusions must not mutate cached alignment.
      const missing = result.stream.assignments.filter(row =>
        row.componentId === evidence.targetId && row.relation === "missing");
      const conflicting = excluded(evidence.targetId) || missing.some(row => row.eventIds.some(id =>
        streamIndex.successByInput.get(id)?.some(receipt => excluded(receipt.componentId))));
      if (conflicting) {
        result.stream.missingTargetTap = false;
        result.stream.limitations.push("stream-omission-conflicting-outcome-anchor");
      }
    }
  }
  const attempts = new Map<string, AttemptRecord>();
  const routes = new Map<string, RoutingRecord[]>();
  for (const attempt of evidence.attempts) attempts.set(attempt.id, attempt);
  for (const route of evidence.routing) {
    const attempt = attempts.get(route.attemptId);
    if (attempt) append(routes, attempt.inputId, route);
  }
  const targetInput = attempts.get(terminal.triggerAttemptId ?? "")?.inputId;
  for (const item of evidence.inputs) {
    const input = item.record;
    if (!input.freshActions.length) continue;
    const localRoutes = (routes.get(input.id) ?? []).filter((r) => r.sequence < terminal.sequence);
    const successes = (index?.successByInput.get(input.id) ?? []).filter(
      (r) => r.sequence < terminal.sequence && r.componentId !== evidence.targetId,
    );
    const witnesses = [input.id, ...localRoutes.map((r) => r.id), ...successes.map((r) => r.id)];
    const add = (
      role: PrimaryInputEvidence["associations"][number]["role"],
      reasons: string[],
      neighbour?: NeighbourInputAssociation,
    ) => {
      result.associations.push({
        inputId: input.id,
        role,
        reasons,
        eventIds: [...new Set([...witnesses, ...(neighbour?.eventIds ?? [])])],
        ...(neighbour ? { neighbour } : {}),
      });
      if (role === "relevant") result.relevantInputIds.push(input.id);
      if (role === "context") result.contextInputIds.push(input.id);
    };
    if (item.postTerminal) {
      add("context", ["post-terminal-input"]);
      continue;
    }
    if (!item.inLiveSuccess && targetInput !== input.id) {
      add("context", ["outside-target-live-window"]);
      continue;
    }
    if (!item.freshActionsKnown) {
      add("ambiguous", ["unknown-fresh-action-source"]);
      continue;
    }
    if (targetInput === input.id) {
      add("relevant", ["direct-terminal-input"]);
      continue;
    }
    const residual = index && trace && residualNeighbourAttempts(evidence, item, index, successes, map, trace, excludedComponentIds);
    if (residual) {
      // One successful ordinal does not consume a second physical edge. The
      // geometry is still compared once per source frame, with all alternatives.
      add("relevant", ["unconsumed-neighbour-frame-attempt"]);
      const association = result.associations[result.associations.length - 1];
      association.residualAttempts = residual.proof;
      association.eventIds = [...new Set([...association.eventIds, ...residual.eventIds])];
      continue;
    }
    let unresolvedStream = false;
    if (result.stream && result.stream.status !== "unavailable") {
      const matched = result.stream.assignments.filter((a) => a.inputId === input.id);
      if (result.stream.relevantInputIds.includes(input.id)) {
        add("relevant", ["shared-stream-cadence-assignment"]);
        continue;
      }
      if (matched.some((a) => a.relation === "matched" && a.componentId !== evidence.targetId)) {
        add("context", ["shared-stream-neighbour-assignment"]);
        continue;
      }
      if (
        matched.some((a) => a.relation === "ambiguous" || a.relation === "extra") ||
        ((result.stream.status === "supported" || result.stream.status === "ambiguous") && !matched.length)
      ) {
        unresolvedStream = true;
      }
    }
    // A successful neighbour owns its observed press even when hit regions overlap.
    // That overlap alone does not establish a second intended target.
    if (successes.length) {
      add("context", ["successful-neighbour-input"]);
      continue;
    }
    const usablePolicy = (route: RoutingRecord) =>
      route.kind === "policy" &&
      route.state !== "not-queried" &&
      route.timingResult !== null &&
      route.timingResult !== "MISS";
    if (item.inside && localRoutes.some((r) => r.componentId === evidence.targetId && usablePolicy(r))) {
      add("relevant", ["otherwise-valid-target-policy"]);
      continue;
    }
    if (
      trace &&
      index &&
      !item.inside &&
      !localRoutes.some((r) => r.kind === "policy" && r.componentId === evidence.targetId)
    ) {
      const neighbour = geometricNeighbour(evidence, item, map, trace, index);
      if (neighbour) {
        const reason =
          neighbour.support === "completed-footprint"
            ? "completed-neighbour-footprint"
            : neighbour.support === "completed-departure"
            ? "completed-neighbour-departure"
            : "neighbour-local-approach";
        add("context", [reason], neighbour);
        continue;
      }
    }
    if (unresolvedStream) add("ambiguous", ["unresolved-stream-surplus"]);
    else add("relevant", ["target-window-geometric-episode"]);
  }
  if (index && trace) {
    if (!result.relevantInputIds.length)
      exposeTargetBlockedReceiverInputs(result,evidence,map,trace,index,excludedComponentIds);
    result.harmfulSurplus = harmfulSurplus(evidence, map, trace, index);
    if (!result.relevantInputIds.length && result.associations.length && result.associations.every(a => a.role === "context"))
      result.missingAction = missingAction(evidence, map, trace, index, excludedComponentIds) ??
        deriveSliderHeadOmission(evidence,map,trace,index,excludedComponentIds);
    result.stoppedDispatchRejections=stoppedDispatchRejections(evidence,map,trace,index,excludedComponentIds);
  }
  return result;
}

/** A validated failed dispatch to a later receiver is target-dependent comparison
 * evidence. It neither proves intended ownership nor fabricates a target receipt. */
function exposeTargetBlockedReceiverInputs(
  result:PrimaryInputEvidence,evidence:CircleEvidence,map:Beatmap,trace:ReplayTrace,index:InputIndex,excluded?:ReadonlySet<string>,
):void {
  const current=map.getHitObject(evidence.targetId),terminal=evidence.terminal;
  if(!(current instanceof HitCircle)||evidence.status!=="supported"||terminal?.mechanism!=="automatic-expiry"||terminal.result!=="MISS"||!terminal.previousUnresolved||
    evidence.limits.truncated||Object.values(evidence.dependencies).some(d=>d.status!=="complete")||
    excluded?.has(current.id)||excluded?.has(current.sliderId??current.id))return;
  const witnesses=new Map<string,ReturnType<typeof derivePreResolutionRejections>>();
  for(const association of result.associations){
    if(association.role!=="context")continue;
    const item=evidence.inputs.find(i=>i.record.id===association.inputId),input=item?.record;
    if(!item||!input||!item.freshActionsKnown||(!item.inLiveSuccess&&!derivePreterminalReceiverRejection(evidence,map,trace,input.id,excluded))||item.postTerminal||input.freshActions.length!==1||
      input.source.origin!=="parsed"||input.source.discontinuityBefore?.length||index.successByInput.get(input.id)?.length)continue;
    const at=index.inputPositions.get(input.id),previous=at===undefined?undefined:index.inputs[at-1],next=at===undefined?undefined:index.inputs[at+1];
    const rawOffsets=evidence.inputs.filter(i=>i.pathGroup===item.pathGroup).flatMap(i=>i.record.source.origin==="parsed"&&i.record.source.rawTokenIndex!==undefined
      ?[i.record.source.rawTokenIndex-i.record.source.parsedFrameIndex]:[]);
    const same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(v=>b.includes(v));
    const maskValid=(q:InputRecord)=>q.actions.every(a=>a===0||a===1)&&new Set(q.actions).size===q.actions.length&&
      (q.rawButtonMask===undefined||(Number.isSafeInteger(q.rawButtonMask)&&q.rawButtonMask>=0&&q.rawButtonMask<=31&&
        same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])])));
    if(!previous||previous.source.origin!=="parsed"||previous.timeMs>input.timeMs||previous.sequence>=input.sequence||
      !Number.isSafeInteger(input.source.parsedFrameIndex)||input.source.parsedFrameIndex!==previous.source.parsedFrameIndex+1||
      !same(previous.actions,input.previousActions)||!same(input.freshActions,input.actions.filter(a=>!input.previousActions.includes(a)))||
      !maskValid(input)||!maskValid(previous)||new Set(rawOffsets).size>1||
      (input.source.rawTokenIndex!==undefined&&(!Number.isSafeInteger(input.source.rawTokenIndex)||input.source.rawTokenIndex<0||
        (previous.source.rawTokenIndex!==undefined&&input.source.rawTokenIndex!==previous.source.rawTokenIndex+1)||
        (next?.source.origin==="parsed"&&!next.source.discontinuityBefore?.length&&next.source.rawTokenIndex!==undefined&&next.source.rawTokenIndex!==input.source.rawTokenIndex+1))))continue;
    const routes=index.routesByInput.get(input.id)??[];
    for(const route of routes){
      if(route.kind!=="policy"||route.state!=="rejected"||route.blockerId!==current.id||route.sequence>=terminal.sequence)continue;
      const receiver=map.getHitObject(route.componentId);
      if(!(receiver instanceof HitCircle)||receiver.hitTime<=current.hitTime||excluded?.has(receiver.id)||excluded?.has(receiver.sliderId??receiver.id))continue;
      if(!witnesses.has(receiver.id)){
        const receiverEvidence=deriveCircleEvidence(trace,map,receiver.id);
        witnesses.set(receiver.id,!receiverEvidence.limits.truncated&&Object.values(receiverEvidence.dependencies).every(d=>d.status==="complete")
          ?derivePreResolutionRejections(receiverEvidence,map,trace):[]);
      }
      const witness=witnesses.get(receiver.id)!.find(w=>w.inputId===input.id&&w.policyId===route.id&&w.blockerId===current.id);
      if(!witness)continue;
      (result.targetDependentRejections??=[]).push({inputId:input.id,receiverId:receiver.id,policyId:route.id,
        eventIds:[...new Set([...association.eventIds,...witness.eventIds])]});
      break;
    }
  }
}

interface InputIndex {
  inputs: InputRecord[];
  inputPositions: Map<string, number>;
  attempts: Map<string, AttemptRecord>;
  attemptsByInput: Map<string, AttemptRecord[]>;
  resolutionsByAttempt: Map<string, ResolutionRecord[]>;
  successByInput: Map<string, ResolutionRecord[]>;
  routesByInput: Map<string, RoutingRecord[]>;
  activations: Map<string,Extract<ReplayTraceRecord,{kind:"lifecycle"}>>;
  invalid: boolean;
}
const indexes = new WeakMap<ReplayTrace, InputIndex>();
function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
/** The sealed trace bounds this one-time index; never rescan the trace per target. */
function traceIndex(trace: ReplayTrace): InputIndex {
  const cached = indexes.get(trace);
  if (cached) return cached;
  const result: InputIndex = {
    inputs: [],
    inputPositions: new Map(),
    attempts: new Map(),
    attemptsByInput: new Map(),
    resolutionsByAttempt: new Map(),
    successByInput: new Map(),
    routesByInput: new Map(),
    activations: new Map(),
    invalid: false,
  };
  if (trace.records.length > trace.limits.maxRecords) {
    result.invalid = true;
    indexes.set(trace, result);
    return result;
  }
  let priorSequence = -1;
  const ids = new Set<string>();
  for (const record of trace.records) {
    if (record.sequence <= priorSequence || ids.has(record.id)) result.invalid = true;
    priorSequence = record.sequence;
    ids.add(record.id);
    if (record.kind === "input") {
      result.inputPositions.set(record.id, result.inputs.length);
      result.inputs.push(record);
    } else if (record.kind === "attempt") {
      result.attempts.set(record.id, record);
      append(result.attemptsByInput, record.inputId, record);
    }
    else if(record.kind === "lifecycle" && !result.activations.has(record.componentId))result.activations.set(record.componentId,record);
  }
  for (const record of trace.records) {
    if (record.kind === "resolution" && record.triggerAttemptId)
      append(result.resolutionsByAttempt, record.triggerAttemptId, record);
    if (record.kind === "resolution" && record.mechanism === "successful-input" && record.result !== "MISS") {
      const attempt = result.attempts.get(record.triggerAttemptId ?? "");
      if (attempt && !attempt.automated) append(result.successByInput, attempt.inputId, record);
    } else if (record.kind === "selection" || record.kind === "policy") {
      const attempt = result.attempts.get(record.attemptId);
      if (attempt) append(result.routesByInput, attempt.inputId, record);
    }
  }
  indexes.set(trace, result);
  return result;
}

function residualNeighbourAttempts(
  evidence: CircleEvidence, item: CircleInputEvidence, index: InputIndex,
  successes: ResolutionRecord[], map: Beatmap, trace: ReplayTrace, excluded?: ReadonlySet<string>,
): { proof: NonNullable<PrimaryInputEvidence["associations"][number]["residualAttempts"]>; eventIds: string[] } | undefined {
  const input = item.record, terminal = evidence.terminal;
  if (!terminal || successes.length !== 1 || successes.some(r => excluded?.has(r.componentId)) ||
    Object.values(evidence.dependencies).some(d => d.status !== "complete") ||
    !item.freshActionsKnown || !item.inLiveSuccess || item.postTerminal ||
    input.freshActions.length !== 2 || new Set(input.freshActions).size !== 2 ||
    input.freshActions.some(a => (a !== 0 && a !== 1) || !input.actions.includes(a) || input.previousActions.includes(a)) ||
    input.actions.filter(a => !input.previousActions.includes(a)).length !== 2 ||
    input.source.origin !== "parsed" || input.source.discontinuityBefore?.length) return;
  if (input.rawButtonMask !== undefined && (!Number.isSafeInteger(input.rawButtonMask) || input.rawButtonMask < 0 ||
    !!(input.rawButtonMask & 5) !== input.actions.includes(0) || !!(input.rawButtonMask & 10) !== input.actions.includes(1))) return;
  const at = index.inputPositions.get(input.id), previous = at === undefined ? undefined : index.inputs[at - 1],
    next = at === undefined ? undefined : index.inputs[at + 1];
  if (!previous || previous.source.origin !== "parsed" || input.source.parsedFrameIndex !== previous.source.parsedFrameIndex + 1 ||
    previous.timeMs > input.timeMs || previous.sequence >= input.sequence ||
    previous.actions.length !== input.previousActions.length || previous.actions.some(a => !input.previousActions.includes(a))) return;
  if (previous.source.rawTokenIndex !== undefined && input.source.rawTokenIndex !== undefined &&
    input.source.rawTokenIndex !== previous.source.rawTokenIndex + 1) return;
  const maskValid = (q: InputRecord) => q.rawButtonMask === undefined ||
    (Number.isSafeInteger(q.rawButtonMask) && q.rawButtonMask >= 0 &&
      !!(q.rawButtonMask & 5) === q.actions.includes(0) && !!(q.rawButtonMask & 10) === q.actions.includes(1));
  const sourceAdjacent = (left: CircleInputEvidence, right: CircleInputEvidence) =>
    left.record.source.origin === "parsed" && right.record.source.origin === "parsed" && !right.record.source.discontinuityBefore?.length &&
    right.record.source.parsedFrameIndex === left.record.source.parsedFrameIndex + 1 && right.record.sequence > left.record.sequence && right.record.timeMs >= left.record.timeMs;
  let first = evidence.inputs.findIndex(i => i.record.id === input.id), last = first;
  if (first < 0) return;
  while (first > 0 && sourceAdjacent(evidence.inputs[first - 1], evidence.inputs[first])) first--;
  while (last + 1 < evidence.inputs.length && sourceAdjacent(evidence.inputs[last], evidence.inputs[last + 1])) last++;
  const offsets = evidence.inputs.slice(first,last + 1).flatMap(i => i.record.source.origin === "parsed" && i.record.source.rawTokenIndex !== undefined
    ? [i.record.source.rawTokenIndex - i.record.source.parsedFrameIndex] : []);
  if (!maskValid(previous) || new Set(offsets).size > 1) return;
  const consumedObject = map.getHitObject(successes[0].componentId);
  if (!(consumedObject instanceof HitCircle) || (consumedObject.sliderId && excluded?.has(consumedObject.sliderId))) return;
  const consumedEvidence = deriveCircleEvidence(trace, map, consumedObject.id), consumedInput = consumedEvidence.inputs.find(i => i.record.id === input.id),
    activation = index.activations.get(consumedObject.id), consumedTerminal = consumedEvidence.terminal, consumedGeometry = consumedEvidence.geometry;
  if (!activation || activation.sequence >= input.sequence || activation.timeMs > input.timeMs ||
    !consumedTerminal || consumedTerminal.id !== successes[0].id || !consumedGeometry || !consumedEvidence.target ||
    consumedEvidence.limits.truncated || Object.values(consumedEvidence.dependencies).some(d => d.status !== "complete") ||
    !consumedInput?.inside || !consumedInput.inLiveSuccess || consumedInput.postTerminal || !consumedInput.freshActionsKnown) return;
  const consumedOffset = input.timeMs - consumedEvidence.target.hitTimeMs, grade = Math.abs(consumedOffset) <= consumedGeometry.hitWindows[0] ? "GREAT"
    : Math.abs(consumedOffset) <= consumedGeometry.hitWindows[1] ? "OK" : Math.abs(consumedOffset) <= consumedGeometry.hitWindows[2] ? "MEH" : undefined;
  if (!grade) return;
  if (consumedObject.sliderId && ["input","geometry","routing","lifecycle"].some(channel =>
    [...trace.failures,...trace.domain.sourceCoverageLimits].includes(`dependency-conflict:${channel}:${consumedObject.sliderId}`))) return;
  const attempts = index.attemptsByInput.get(input.id) ?? [], routes = index.routesByInput.get(input.id) ?? [];
  if (attempts.length !== 2 || attempts.some((a, k) => a.automated || a.attemptOrdinal !== k || a.timeMs !== input.timeMs ||
    a.sequence <= input.sequence || a.sequence >= terminal.sequence || (next && a.sequence >= next.sequence) ||
    a.actionCandidates.length !== 2 || new Set(a.actionCandidates).size !== 2 ||
    a.actionCandidates.some(action => !input.freshActions.includes(action)) ||
    (evidence.geometry?.profile === "stable" && a.knownAction !== undefined) ||
    (evidence.geometry?.profile === "lazer" && a.knownAction !== input.freshActions[k]) ||
    (a.knownAction !== undefined && !input.freshActions.includes(a.knownAction)))) return;
  if (attempts[0].knownAction !== undefined && attempts[1].knownAction !== undefined && attempts[0].knownAction === attempts[1].knownAction) return;
  const eventIds = [previous.id,input.id], residual: AttemptRecord[] = [], consumed: AttemptRecord[] = [], selections: string[] = [];
  for (let k = 0; k < attempts.length; k++) {
    const a = attempts[k], end = attempts[k + 1]?.sequence ?? next?.sequence ?? terminal.sequence,
      dispatch = routes.filter(r => r.attemptId === a.id), selected = dispatch.filter(r => r.kind === "selection"),
      policies = dispatch.filter(r => r.kind === "policy"), receipts = index.resolutionsByAttempt.get(a.id) ?? [];
    if (dispatch.some(r => r.sequence <= a.sequence || r.sequence >= end || r.timeMs !== input.timeMs) || selected.length !== 1) return;
    const selection = selected[0];
    if (selection.componentId === null) {
      if (selection.inside !== null || selection.eligible || selection.selectionStopped || policies.length || receipts.length) return;
      residual.push(a); selections.push(selection.id);
    } else {
      const receipt = receipts[0], policy = policies[0];
      if (!selection.inside || !selection.eligible || !selection.selectionStopped || policies.length !== 1 || receipts.length !== 1 ||
        selection.component !== (consumedObject.sliderId ? "slider-head" : "circle") ||
        policy.state !== "allowed" || policy.timingResult === null || policy.timingResult === "MISS" ||
        policy.offsetMs !== consumedOffset || policy.timingResult !== grade ||
        policy.componentId !== selection.componentId || policy.sequence <= selection.sequence ||
        receipt.id !== successes[0].id || receipt.componentId !== selection.componentId || receipt.sequence <= policy.sequence ||
        receipt.component !== (consumedObject.sliderId ? "slider-head" : "circle") ||
        receipt.sequence >= end || receipt.timeMs !== input.timeMs || !receipt.previousUnresolved ||
        receipt.mechanism !== "successful-input" || receipt.result !== policy.timingResult) return;
      consumed.push(a);
    }
    eventIds.push(a.id,...dispatch.map(r => r.id),...receipts.map(r => r.id));
  }
  if (consumed.length !== 1 || residual.length !== 1) return;
  eventIds.push(activation.id);
  return { proof: { attemptIds: residual.map(a => a.id), consumedAttemptIds: consumed.map(a => a.id), selectionIds: selections,
    knownActions: residual.flatMap(a => a.knownAction === undefined ? [] : [a.knownAction]),
    actionIdentity: attempts.every(a => a.knownAction !== undefined) ? "known-action" : "ordinal-capacity" }, eventIds };
}
const neighbourIndexes = new WeakMap<Beatmap, Map<string, { previous?: string; next?: string }>>();
function neighbours(map: Beatmap, targetId: string): { previous?: string; next?: string } {
  let index = neighbourIndexes.get(map);
  if (!index) {
    index = new Map();
    let previous: string | undefined;
    for (const object of map.hitObjects) {
      const circle = object instanceof HitCircle ? object : object instanceof Slider ? object.head : undefined;
      if (circle) {
        index.set(circle.id, { previous });
        const prior = previous ? index.get(previous) : undefined;
        if (prior) prior.next = circle.id;
      }
      previous = circle?.id;
    }
    neighbourIndexes.set(map, index);
  }
  return index.get(targetId) ?? {};
}
function predecessor(map: Beatmap, targetId: string): string | undefined {
  return neighbours(map, targetId).previous;
}

/** Order rejection and successful consumption are different facts. A rejected
 * earlier receptor can stop dispatch before the current one is queried. Admit
 * that consequence only for a fresh on-time, in-circle current opportunity;
 * spatial overlap with the earlier note's own on-time press is insufficient. */
function stoppedDispatchRejections(
  evidence:CircleEvidence,map:Beatmap,trace:ReplayTrace,index:InputIndex,excluded?:ReadonlySet<string>,
):PrimaryInputEvidence["stoppedDispatchRejections"] {
  const {target,geometry,terminal}=evidence;
  if(evidence.status!=="supported" || !target || !geometry || terminal?.mechanism!=="automatic-expiry" || terminal.result!=="MISS" || !terminal.previousUnresolved ||
    evidence.limits.truncated || Object.values(evidence.dependencies).some(d=>d.status!=="complete") ||
    excluded?.has(evidence.targetId) || (evidence.identity.analysisProfileId!=="stable" && !map.lazerModSettings.classic?.classicNoteLock))return;
  const pair=neighbours(map,evidence.targetId),previous=pair.previous && map.getHitObject(pair.previous),following=pair.next && map.getHitObject(pair.next);
  const current=map.getHitObject(evidence.targetId);
  if(!(current instanceof HitCircle) || excluded?.has(current.sliderId ?? current.id) || trace.failures.some(reason=>
    reason.startsWith("dependency-conflict:") && [current.id,current.sliderId].includes(reason.split(":").slice(2).join(":"))))return;
  const spacing=Math.min(...[previous,following].flatMap(o=>o instanceof HitCircle ? [Math.abs(o.hitTime-target.hitTimeMs)] : []));
  if(!(spacing>0))return;
  const witnesses:NonNullable<PrimaryInputEvidence["stoppedDispatchRejections"]>=[];
  let rejectionByInput:Map<string,ReturnType<typeof derivePreResolutionRejections>>|undefined;
  let receiverEvidence:CircleEvidence|undefined;
  for(const item of evidence.inputs){
    const input=item.record,offset=input.timeMs-target.hitTimeMs;
    if(!item.inside || !item.inLiveSuccess || item.postTerminal || !item.freshActionsKnown || input.freshActions.length!==1 ||
      Math.abs(offset)>geometry.hitWindows[0] || Math.abs(offset)>=spacing/2 || (index.successByInput.get(input.id)?.length ?? 0)>0)continue;
    const routes=index.routesByInput.get(input.id) ?? [],selections=routes.filter(r=>r.kind==="selection");
    if(selections.length!==1 || selections[0].kind!=="selection" || !selections[0].componentId)continue;
    const receiverId=selections[0].componentId,receiver=map.getHitObject(receiverId);
    if(!(receiver instanceof HitCircle) || !(current instanceof HitCircle) || excluded?.has(current.sliderId ?? current.id) ||
      excluded?.has(receiverId) || excluded?.has(receiver.sliderId ?? receiverId) || neighbours(map,receiverId).next!==evidence.targetId ||
      !(target.hitTimeMs-receiver.hitTime>0 && target.hitTimeMs-receiver.hitTime<=200))continue;
    // The immediate previous receptor is the only possible receiver. Extract
    // its bounded evidence once, even when several local fresh inputs qualify.
    if(!rejectionByInput){
      receiverEvidence=deriveCircleEvidence(trace,map,receiverId);
      rejectionByInput=new Map();
      for(const w of derivePreResolutionRejections(receiverEvidence,map,trace))append(rejectionByInput,w.inputId,w);
    }
    const rejections=rejectionByInput.get(input.id) ?? [];
    if(rejections.length!==1)continue;
    const rejection=rejections[0],blocker=map.getHitObject(rejection.blockerId);
    if(!blocker || excluded?.has(blocker.id) || (blocker instanceof HitCircle && excluded?.has(blocker.sliderId ?? blocker.id)) ||
      (blocker instanceof Slider && excluded?.has(blocker.head.id)) ||
      !receiverEvidence?.terminal || receiverEvidence.terminal.sequence>=terminal.sequence)continue;
    const activation=index.activations.get(evidence.targetId);
    if(!activation || activation.sequence>=input.sequence || activation.timeMs>input.timeMs)continue;
    witnesses.push({inputId:input.id,receiverId,blockerId:rejection.blockerId,policyId:rejection.policyId,targetOffsetMs:offset,
      eventIds:[...new Set([...rejection.eventIds,activation.id,terminal.id])],scope:"unqueried-target-beyond-rejected-receiver"});
  }
  return witnesses.length ? witnesses : undefined;
}

/** Source-gap certificates use exact scheduled action anchors. A blocked next
 * action and a completely recorded tail do not require later successful recovery. */
function missingAction(
  evidence: CircleEvidence, map: Beatmap, trace: ReplayTrace, index: InputIndex,
  excluded?: ReadonlySet<string>,
): PrimaryInputEvidence["missingAction"] {
  if (!evidence.target || !evidence.terminal || evidence.limits.truncated ||
    Object.values(evidence.dependencies).some(d => d.status !== "complete")) return;
  const pair = neighbours(map, evidence.targetId);
  if (!pair.previous) return;
  const sameActions=(a:readonly number[],b:readonly number[])=>a.length === b.length && a.every(x=>b.includes(x));
  const anchor = (id: string, allowRejection=false) => {
    const object = map.getHitObject(id);
    if (excluded?.has(id) || (object instanceof HitCircle && object.sliderId && excluded?.has(object.sliderId))) return;
    const e = deriveCircleEvidence(trace,map,id), terminal=e.terminal;
    if(!e.target || !terminal || e.limits.truncated || Object.values(e.dependencies).some(d=>d.status !== "complete")) return;
    const rejection=allowRejection ? derivePreResolutionRejections(e,map,trace).filter(w=>w.blockerId === evidence.targetId) : [];
    // A neighbour may first be rejected for this target, then recover much
    // later. Its validated earlier slot action is still the closing witness.
    const success=terminal.mechanism === "successful-input" && terminal.result !== "MISS" && !rejection.length;
    if(!success && rejection.length !== 1) return;
    const attempt=index.attempts.get(success ? terminal.triggerAttemptId ?? "" : rejection[0].attemptId);
    if(!attempt || attempt.automated || attempt.knownAction === undefined) return;
    const input=e.inputs.find(i=>i.record.id === attempt.inputId);
    if(!input?.inside || !input.inLiveSuccess || input.postTerminal || !input.freshActionsKnown ||
      input.record.freshActions.length !== 1 || input.record.sequence >= attempt.sequence || attempt.sequence >= terminal.sequence) return;
    const position=index.inputPositions.get(input.record.id), previous=position === undefined ? undefined : index.inputs[position-1];
    const fresh=input.record.actions.filter(a=>!input.record.previousActions.includes(a));
    if(!previous || previous.source.origin !== "parsed" || input.record.source.origin !== "parsed" ||
      input.record.source.parsedFrameIndex !== previous.source.parsedFrameIndex+1 || input.record.source.discontinuityBefore?.length ||
      input.record.actions.some(a=>a!==0 && a!==1) || new Set(input.record.actions).size !== input.record.actions.length ||
      !sameActions(input.record.previousActions,previous.actions) || !sameActions(fresh,input.record.freshActions) ||
      !sameActions(fresh,attempt.actionCandidates) || attempt.knownAction !== fresh[0] || attempt.attemptOrdinal !== 0) return;
    const routes=(index.routesByInput.get(input.record.id) ?? []).filter(r=>r.attemptId === attempt.id);
    const selection=routes.find(r=>r.kind === "selection"), policy=routes.find(r=>r.kind === "policy");
    const offset=input.record.timeMs-e.target.hitTimeMs, windows=e.geometry?.hitWindows;
    const grade=windows && (Math.abs(offset)<=windows[0] ? "GREAT" : Math.abs(offset)<=windows[1] ? "OK" : Math.abs(offset)<=windows[2] ? "MEH" : undefined);
    if(routes.length !== 2 || selection?.kind !== "selection" || policy?.kind !== "policy" ||
      selection.componentId !== id || !selection.inside || !selection.eligible || !selection.selectionStopped ||
      policy.componentId !== id || !grade || policy.timingResult !== grade || policy.offsetMs !== offset ||
      (success && (policy.state !== "allowed" || terminal.result !== grade)) ||
      !(attempt.sequence<selection.sequence && selection.sequence<policy.sequence && policy.sequence<terminal.sequence) ||
      [attempt,selection,policy].some(r=>r.timeMs !== input.record.timeMs) ||
      (position !== undefined && index.inputs[position+1]?.sequence < policy.sequence)) return;
    const near=neighbours(map,id);
    const spacings=[near.previous,near.next].flatMap(otherId=>{
      const other=otherId && map.getHitObject(otherId);
      return other instanceof HitCircle ? [Math.abs(other.hitTime-e.target!.hitTimeMs)] : [];
    });
    const cell=Math.min(...spacings)/2;
    if(!(cell>0) || Math.abs(input.record.timeMs-e.target.hitTimeMs)>=cell) return;
    return {evidence:e,input:input.record,eventIds:[previous.id,...(success ? [input.record.id,attempt.id,selection.id,policy.id,terminal.id] : rejection[0].eventIds)]};
  };
  const before=anchor(pair.previous), after=pair.next && anchor(pair.next,true);
  if(!before || before.input.timeMs >= evidence.target.hitTimeMs) return;
  const continuous=(bridge:InputRecord[])=>bridge.length>=2 && bridge.every((i,k)=>i.source.origin === "parsed" && (!k || (
    bridge[k-1].source.origin === "parsed" && i.source.parsedFrameIndex === (bridge[k-1].source as {parsedFrameIndex:number}).parsedFrameIndex+1 &&
    !i.source.discontinuityBefore?.length && i.timeMs>=bridge[k-1].timeMs)));
  const from=index.inputPositions.get(before.input.id);
  if(from === undefined) return;
  const bracket = (() => {
    if(!after || after.input.timeMs <= evidence.target!.hitTimeMs || after.input.timeMs-before.input.timeMs>1600) return;
    if(evidence.inputs.some(i=>i.inLiveSuccess && !i.postTerminal && i.record.freshActions.length &&
      i.record.id !== before.input.id && i.record.id !== after.input.id)) return;
    const through=index.inputPositions.get(after.input.id);
    if(through === undefined || through<=from || through-from>evidence.limits.maxInputs) return;
    const bridge=index.inputs.slice(from,through+1);
    const contact=evidence.inputs.some(i=>i.inLiveSuccess && !i.postTerminal && i.inside && i.record.sequence>before.input.sequence && i.record.sequence<after.input.sequence);
    if(contact && continuous(bridge) && !bridge.slice(1,-1).some(i=>i.freshActions.length)) return {
      scope:"complete-bracketed-source-gap",previousComponentId:pair.previous,followingComponentId:pair.next,
      eventIds:[...bridge.map(i=>i.id),...before.eventIds,...after.eventIds],contextEventIds:[...before.eventIds,...after.eventIds],
    } as NonNullable<PrimaryInputEvidence["missingAction"]>;
    return undefined;
  })();
  if (bracket) return bracket;
  const priorId=neighbours(map,pair.previous).previous, prior=priorId && anchor(priorId);
  const end=evidence.domains.liveSuccess.end;
  if(!prior || !end || prior.input.timeMs>=before.input.timeMs || evidence.target.hitTimeMs-prior.input.timeMs>1600) return;
  // A failed longer bracket does not invalidate an independent tail, but all
  // fresh actions in that live tail still need exact anchor accounting.
  if(evidence.inputs.some(i=>i.inLiveSuccess && !i.postTerminal && i.record.freshActions.length &&
    i.record.id !== prior.input.id && i.record.id !== before.input.id)) return;
  const spacing=Math.min(before.evidence.target!.hitTimeMs-prior.evidence.target!.hitTimeMs,evidence.target.hitTimeMs-before.evidence.target!.hitTimeMs);
  const phaseA=prior.input.timeMs-prior.evidence.target!.hitTimeMs, phaseB=before.input.timeMs-before.evidence.target!.hitTimeMs;
  if(!(spacing>0) || Math.abs(phaseA-phaseB)>spacing*.35) return;
  const start=index.inputPositions.get(prior.input.id);
  if(start === undefined || from-start>evidence.limits.maxInputs) return;
  const prefix=index.inputs.slice(start,from+1);
  if(!continuous(prefix) || prefix.slice(1,-1).some(i=>i.freshActions.length)) return;
  const endInputs=evidence.inputs.filter(i=>i.inLiveSuccess && !i.postTerminal && i.record.sequence>before.input.sequence);
  if(!endInputs.some(i=>i.inside) || endInputs.some(i=>i.record.freshActions.length)) return;
  const last=endInputs.filter(i=>i.record.source.origin === "parsed").pop();
  const through=last && index.inputPositions.get(last.record.id);
  if(through === undefined || through-from>evidence.limits.maxInputs) return;
  const tail=index.inputs.slice(from,through+1);
  if(!continuous(tail) || tail.slice(1).some(i=>i.freshActions.length)) return;
  const closing=index.inputs[through+1];
  const closingIds=closing && closing.sequence <= evidence.terminal.sequence ? [closing.id] : [];
  return {scope:"complete-recorded-tail-gap",previousComponentId:pair.previous,previousAnchorComponentId:priorId,
    eventIds:[...prefix.map(i=>i.id),...tail.map(i=>i.id),...endInputs.map(i=>i.record.id),...closingIds,...prior.eventIds,...before.eventIds,evidence.terminal.id],
    contextEventIds:[...prior.eventIds,...before.eventIds]};
}

interface NeighbourWitness {
  geometry: NonNullable<CircleEvidence["geometry"]>;
  hitTimeMs: number;
  support: NeighbourInputAssociation["support"];
  provenance: NeighbourInputAssociation["provenance"];
  eventIds: string[];
  completedContext?: NeighbourInputAssociation["completedContext"];
}
interface NeighbourCache {
  entries: Map<string, NeighbourWitness | null>;
  references: number;
}
const neighbourCaches = new WeakMap<ReplayTrace, WeakMap<Beatmap, NeighbourCache>>();
/** Bounded compact witnesses only: full per-neighbour evidence/episodes are transient. */
function neighbourWitness(
  trace: ReplayTrace,
  map: Beatmap,
  componentId: string,
  inputId: string,
  index: InputIndex,
): NeighbourWitness | undefined {
  let maps = neighbourCaches.get(trace);
  if (!maps) {
    maps = new WeakMap();
    neighbourCaches.set(trace, maps);
  }
  let cache = maps.get(map);
  if (!cache) {
    cache = { entries: new Map(), references: 0 };
    maps.set(map, cache);
  }
  const key = JSON.stringify([componentId, inputId]);
  if (cache.entries.has(key)) return cache.entries.get(key) ?? undefined;
  const evidence = deriveCircleEvidence(trace, map, componentId);
  const input = evidence.inputs.find((i) => i.record.id === inputId);
  let witness: NeighbourWitness | undefined;
  if (input) witness = completedNeighbourWitness(evidence, input, index);
  if (
    evidence.status === "supported" &&
    evidence.target &&
    evidence.geometry &&
    evidence.terminal &&
    input?.inLiveSuccess &&
    !input.postTerminal &&
    input.freshActionsKnown &&
    !evidence.limits.truncated &&
    Object.values(evidence.dependencies).every((d) => d.status === "complete")
  ) {
    const episode = analyzePrimaryApproaches(evidence, { pressIds: [inputId] }).episodes[0];
    if (episode?.status === "supported") {
      const pass = episode.properPass;
      if (pass?.sampledEventIds.length && pass.relation === "same-approach")
        witness = {
          geometry: evidence.geometry,
          hitTimeMs: evidence.target.hitTimeMs,
          support: "sampled-pass",
          provenance: "sampled",
          eventIds: [...pass.eventIds],
        };
      // Broad-only geometry needs a usable correction for causal admission.
      // It cannot alone establish ownership and fence out a target alternative.
      else if (episode.landing && episode.spatialCandidates.length && !episode.boundedOutsideLobe)
        witness = {
          geometry: evidence.geometry,
          hitTimeMs: evidence.target.hitTimeMs,
          support: "misplaced-landing",
          provenance: episode.landing.provenance,
          eventIds: [...episode.landing.eventIds],
        };
      if (witness)
        witness.eventIds = [
          ...new Set([
            inputId,
            ...witness.eventIds,
            evidence.terminal.id,
            ...[evidence.domains.liveSuccess.start?.eventId, evidence.domains.liveSuccess.end?.eventId].filter(
              (id): id is string => !!id,
            ),
            ...evidence.terminalReferences.map((r) => r.id),
          ]),
        ];
    }
  }
  const references = witness?.eventIds.length ?? 0;
  if (references <= PRIMARY_INPUT_POLICY.neighbourCacheWitnessReferences) {
    while (
      cache.entries.size >= PRIMARY_INPUT_POLICY.neighbourCacheEntries ||
      cache.references + references > PRIMARY_INPUT_POLICY.neighbourCacheWitnessReferences
    ) {
      const oldest = cache.entries.entries().next().value as [string, NeighbourWitness | null];
      cache.entries.delete(oldest[0]);
      cache.references -= oldest[1]?.eventIds.length ?? 0;
    }
    cache.entries.set(key, witness ?? null);
    cache.references += references;
  }
  return witness;
}
/** A positive completed local episode; these samples are never live opportunities
 * for the resolved neighbour. Every recorded step must remain source-contiguous
 * and outward, within one radius of travelled distance and one best window. */
function completedNeighbourWitness(
  evidence: CircleEvidence,
  input: CircleInputEvidence,
  index: InputIndex,
): NeighbourWitness | undefined {
  const { terminal, geometry, target } = evidence;
  if (
    !terminal ||
    !geometry ||
    !target ||
    terminal.mechanism !== "successful-input" ||
    terminal.result === "MISS" ||
    !input.postTerminal ||
    !input.freshActionsKnown ||
    evidence.limits.truncated ||
    Object.values(evidence.dependencies).some((d) => d.status !== "complete")
  )
    return;
  const attempt = index.attempts.get(terminal.triggerAttemptId ?? "");
  if (!attempt || attempt.automated || attempt.knownAction === undefined) return;
  const success = evidence.inputs.find((i) => i.record.id === attempt.inputId);
  const from = index.inputPositions.get(attempt.inputId),
    through = index.inputPositions.get(input.record.id);
  if (
    !success?.inside ||
    !success.inLiveSuccess ||
    !success.freshActionsKnown ||
    from === undefined ||
    through === undefined ||
    through <= from ||
    through - from > evidence.limits.maxInputs
  )
    return;
  const elapsedBestWindows = (input.record.timeMs - success.record.timeMs) / geometry.hitWindows[0];
  if (!(elapsedBestWindows > 0) || elapsedBestWindows > PRIMARY_INPUT_POLICY.completedNeighbourBestWindows) return;
  let pathR = 0,
    radialR = normalizedRadius(success.record, geometry);
  const eventIds = [terminal.id, attempt.id, success.record.id];
  for (let at = from + 1; at <= through; at++) {
    const left = index.inputs[at - 1],
      right = index.inputs[at];
    if (
      left.source.origin !== "parsed" ||
      right.source.origin !== "parsed" ||
      right.source.parsedFrameIndex !== left.source.parsedFrameIndex + 1 ||
      right.source.discontinuityBefore?.length ||
      right.timeMs <= left.timeMs ||
      (at < through && right.freshActions.length)
    )
      return;
    const nextRadialR = normalizedRadius(right, geometry);
    // A radial decrease is a sampled return/correction, so this narrow prior
    // departure rule cannot discard the action as neighbour context.
    if (!Number.isFinite(nextRadialR) || nextRadialR + PRIMARY_INPUT_POLICY.neighbourComparisonTolerance < radialR)
      return;
    pathR += Math.hypot(right.position.x - left.position.x, right.position.y - left.position.y) / geometry.radius;
    if (!Number.isFinite(pathR) || pathR > PRIMARY_INPUT_POLICY.completedNeighbourPathR) return;
    radialR = nextRadialR;
    eventIds.push(right.id);
  }
  return {
    geometry,
    hitTimeMs: target.hitTimeMs,
    support: input.inside ? "completed-footprint" : "completed-departure",
    provenance: "sampled",
    eventIds,
    completedContext: { successInputId: success.record.id, resolutionId: terminal.id, pathR, elapsedBestWindows },
  };
}
function normalizedRadius(input: InputRecord, geometry: NonNullable<CircleEvidence["geometry"]>): number {
  const round = geometry.profile === "stable" ? Math.fround : (value: number) => value;
  return (
    Math.hypot(
      round(input.position.x) - round(geometry.position.x),
      round(input.position.y) - round(geometry.position.y),
    ) / geometry.radius
  );
}
function geometricNeighbour(
  evidence: CircleEvidence,
  input: CircleInputEvidence,
  map: Beatmap,
  trace: ReplayTrace,
  index: InputIndex,
): NeighbourInputAssociation | undefined {
  const { geometry, target } = evidence;
  if (
    !geometry ||
    !target ||
    evidence.limits.truncated ||
    Object.values(evidence.dependencies).some((d) => d.status !== "complete")
  )
    return;
  const candidates = neighbours(map, evidence.targetId),
    matches: NeighbourInputAssociation[] = [];
  const targetRadialR = normalizedRadius(input.record, geometry),
    targetPhaseWindows = Math.abs(input.record.timeMs - target.hitTimeMs) / geometry.hitWindows[0];
  for (const componentId of [candidates.previous, candidates.next]) {
    if (!componentId) continue;
    const witness = neighbourWitness(trace, map, componentId, input.record.id, index);
    if (!witness || witness.geometry.profile !== geometry.profile) continue;
    if (witness.completedContext && (componentId !== candidates.previous || witness.hitTimeMs >= target.hitTimeMs))
      continue;
    // Overlapping target regions cannot establish a distinct local approach by
    // this comparison. Preserve those actions instead of using timing alone.
    const separation = Math.hypot(
      geometry.position.x - witness.geometry.position.x,
      geometry.position.y - witness.geometry.position.y,
    );
    if (separation <= geometry.radius + witness.geometry.radius) continue;
    const radialR = normalizedRadius(input.record, witness.geometry),
      phaseWindows = Math.abs(input.record.timeMs - witness.hitTimeMs) / witness.geometry.hitWindows[0];
    if (
      ![radialR, targetRadialR, phaseWindows, targetPhaseWindows].every(Number.isFinite) ||
      targetRadialR - radialR <= PRIMARY_INPUT_POLICY.neighbourMinRadialAdvantage ||
      targetPhaseWindows - phaseWindows <= PRIMARY_INPUT_POLICY.neighbourComparisonTolerance
    )
      continue;
    matches.push({
      componentId,
      direction: witness.hitTimeMs < target.hitTimeMs ? "earlier" : "later",
      radialR,
      targetRadialR,
      phaseWindows,
      targetPhaseWindows,
      support: witness.support,
      provenance: witness.provenance,
      eventIds: witness.eventIds,
      ...(witness.completedContext ? { completedContext: witness.completedContext } : {}),
    });
  }
  // Competing geometric neighbours are not resolved by an arbitrary nearest or
  // highest-score tie breaker. Such an input remains relevant/ambiguous.
  return matches.length === 1 ? matches[0] : undefined;
}
function harmfulSurplus(
  evidence: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace,
  index: InputIndex,
): PrimaryInputEvidence["harmfulSurplus"] {
  const { terminal, target, geometry } = evidence;
  if (
    !terminal ||
    !target ||
    !geometry ||
    terminal.result !== "MISS" ||
    terminal.mechanism !== "input-miss" ||
    errorCapabilities(map, evidence.identity.analysisProfileId).tapping !== "manual" ||
    ["geometry", "routing", "lifecycle"].some(
      (key) => evidence.dependencies[key as "geometry" | "routing" | "lifecycle"].status !== "complete",
    ) ||
    Object.values(evidence.dependencies).some((d) => d.reasons.some((r) => r.startsWith("dependency-conflict:"))) ||
    trace.droppedRecordBoundary !== undefined ||
    trace.failures.some((r) => r !== "global-totals-mismatch")
  )
    return;
  const attempt = index.attempts.get(terminal.triggerAttemptId ?? "");
  const item = evidence.inputs.find((i) => i.record.id === attempt?.inputId);
  if (
    !attempt ||
    attempt.automated ||
    attempt.knownAction === undefined ||
    !item ||
    !item.freshActionsKnown ||
    !item.inside ||
    item.postTerminal ||
    item.record.freshActions.length !== 1 ||
    item.record.freshActions[0] !== attempt.knownAction ||
    item.record.previousActions.includes(attempt.knownAction) ||
    item.record.timeMs >= target.hitTimeMs - geometry.hitWindows[2]
  )
    return;
  const at = index.inputPositions.get(item.record.id);
  if (at === undefined || at === 0) return;
  // Adjacent fresh actions may have cursor/release samples between them. A
  // generic unmatched early tap or distant success is not a surplus cluster.
  let previousAt = at - 1;
  while (previousAt > 0 && !index.inputs[previousAt].freshActions.length &&
    at - previousAt < evidence.limits.maxInputs &&
    item.record.timeMs - index.inputs[previousAt].timeMs <= geometry.hitWindows[0] * PRIMARY_INPUT_POLICY.bestWindowFraction)
    previousAt--;
  const previous = index.inputs[previousAt];
  const previousSuccesses = index.successByInput.get(previous.id) ?? [];
  if (previousSuccesses.length !== 1 || previous.freshActions.length !== 1) return;
  const previousSuccess = previousSuccesses[0];
  const previousAttempt = index.attempts.get(previousSuccess.triggerAttemptId ?? "");
  const previousObject = map.getHitObject(previousSuccess.componentId);
  if (
    !previousAttempt ||
    previousAttempt.knownAction === undefined ||
    previousAttempt.knownAction === attempt.knownAction ||
    previousSuccess.sequence >= item.record.sequence ||
    !(previousObject instanceof HitCircle) ||
    predecessor(map, evidence.targetId) !== previousObject.id
  )
    return;
  const rhythm = target.hitTimeMs - previousObject.hitTime;
  const separation = item.record.timeMs - previous.timeMs;
  if (
    rhythm <= 0 ||
    separation <= 0 ||
    separation >
      Math.min(
        geometry.hitWindows[0] * PRIMARY_INPUT_POLICY.bestWindowFraction,
        rhythm * PRIMARY_INPUT_POLICY.rhythmFraction,
      )
  )
    return;
  const replacement = evidence.inputs.find((candidate) => {
    if (
      !candidate.postTerminal ||
      !candidate.freshActionsKnown ||
      !candidate.inside ||
      !candidate.record.freshActions.length ||
      Math.abs(candidate.record.timeMs - target.hitTimeMs) > geometry.hitWindows[2]
    )
      return false;
    // Actual source input consumed/rejected for another receptor cannot be
    // advertised as an independently available replacement for this target.
    return !(index.routesByInput.get(candidate.record.id) ?? []).some(
      (r) => r.kind === "selection" && r.componentId !== null,
    );
  });
  const through = replacement && index.inputPositions.get(replacement.record.id);
  if (
    !replacement ||
    through === undefined ||
    through <= at ||
    previousAt === 0 ||
    through - previousAt + 1 > evidence.limits.maxInputs ||
    trace.domain.endTimeMs < replacement.record.timeMs
  )
    return;
  const supporting: ReplayTraceRecord[] = [previous, previousAttempt, previousSuccess, item.record, attempt, terminal];
  const sameActions = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every(action => b.includes(action));
  supporting.push(index.inputs[previousAt - 1]);
  let released = false;
  for (let position = previousAt; position <= through; position++) {
    const left = index.inputs[position - 1],
      right = index.inputs[position];
    if (
      left.source.origin !== "parsed" ||
      right.source.origin !== "parsed" ||
      right.source.parsedFrameIndex !== left.source.parsedFrameIndex + 1 ||
      right.source.discontinuityBefore?.length ||
      right.timeMs < left.timeMs || right.sequence <= left.sequence ||
      ![right.timeMs,right.position.x,right.position.y].every(Number.isFinite) ||
      [right.actions,right.previousActions,right.freshActions].some(a =>
        new Set(a).size !== a.length || a.some(action => action !== 0 && action !== 1)) ||
      !sameActions(right.previousActions,left.actions) ||
      !sameActions(right.freshActions,right.actions.filter(a => !right.previousActions.includes(a))) ||
      (right.rawButtonMask !== undefined && (!Number.isSafeInteger(right.rawButtonMask) ||
        right.rawButtonMask < 0 || right.rawButtonMask > 31 ||
        !sameActions(right.actions,[...(right.rawButtonMask & 5 ? [0] : []),...(right.rawButtonMask & 10 ? [1] : [])]))) ||
      ((right.source.rawTokenIndex !== undefined || left.source.rawTokenIndex !== undefined) &&
        (right.source.rawTokenIndex === undefined || left.source.rawTokenIndex === undefined ||
          right.source.rawTokenIndex !== left.source.rawTokenIndex + 1))
    )
      return;
    supporting.push(right);
    if (position >= at && !released && !right.actions.includes(attempt.knownAction)) {
      released = true;
    }
  }
  // A different fresh action remains usable while the surplus key is held.
  // Reusing the surplus action still requires its intervening release.
  if (!released && replacement.record.freshActions.includes(attempt.knownAction)) return;
  supporting.push(replacement.record, ...(index.routesByInput.get(replacement.record.id) ?? []));
  return {
    inputId: item.record.id,
    precedingSuccessInputId: previous.id,
    precedingSuccessResolutionId: previousSuccess.id,
    replacementInputId: replacement.record.id,
    replacementScope: "post-terminal-counterfactual",
    eventIds: [...new Set(supporting.map((r) => r.id))],
  };
}
