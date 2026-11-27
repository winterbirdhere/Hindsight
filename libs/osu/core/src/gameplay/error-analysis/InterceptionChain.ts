import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import {
  CircleEvidence,
  InputRecord,
  deriveCircleEvidence,
  derivePreResolutionRejections,
} from "../miss-explanation/CircleEvidence";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import { PrimaryInputEvidence } from "./PrimaryInputEvidence";
import { comparePrimaryApproaches } from "./PrimaryApproachComparison";
import { PrimaryCandidate, rankPrimaryCandidates } from "./PrimaryDiagnosisPolicy";
import { compareInitiatingArrival } from "./InitiatingArrivalComparison";
import { stableGameplayRadius } from "../StableHitGeometry";
import { rankInitiatingAndRecovery } from "./PrimaryAttribution";

export interface InitiatingChain {
  pairedCapacity?: import("./PairedCapacityChain").PairedCapacityProof;
  rootComponentId: string;
  rootInputId: string;
  rootComparison: ReturnType<typeof comparePrimaryApproaches>;
  rootArrivalComparison?: ReturnType<typeof compareInitiatingArrival>;
  causes: PrimaryCandidate[];
  recoveryComparison?: ReturnType<typeof comparePrimaryApproaches>;
  combinedRanking?: ReturnType<typeof rankPrimaryCandidates>;
  recoveryPriority?: {basis:"usable-root-correction-and-no-new-target-pass";correctionInputId:string;lostInputId:string;eventIds:string[]};
  componentIds: string[];
  eventIds: string[];
  links: Array<{
    targetId: string;
    receiverId: string;
    inputId: string;
    precedingInputId: string;
    rejectedBy?: string;
  }>;
  additionalInputIds: string[];
  additionalInputEvidence: Array<{inputId:string; receiverId?:string; kind:"next-slot-success"|"next-slot-rejection"|"failed-recovery"|"earlier-chain-slot"; eventIds:string[]}>;
  rejectedDispatch?: {
    policyVersion: "rejected-placement-v2";
    phaseMs: number;
    slots: Array<{targetId:string;receiverId:string;inputId:string;policyId:string;targetOffsetMs:number;eventIds:string[]}>;
    sourceSpan: {startInputId:string;endInputId:string;frameCount:number};
  };
  basis: "bounded-cadence-and-model-dispatch";
}

interface InitiatingTraceIndex {
  byId: ReadonlyMap<string, ReplayTraceRecord>;
  inputs: InputRecord[];
  activations: Map<string,ReplayTraceRecord>;
}
const recordsByTrace = new WeakMap<ReplayTrace, InitiatingTraceIndex>();
/** Shared immutable-trace lookup; exclusions and derived chains are never cached. */
export function initiatingTraceIndex(trace: ReplayTrace) {
  let records = recordsByTrace.get(trace);
  if (!records) {
    records = {
      byId: new Map(trace.records.map((r) => [r.id, r])),
      inputs: trace.records.filter((r): r is InputRecord => r.kind === "input"),
      activations: new Map(),
    };
    for (const r of trace.records) {
      if (r.kind === "lifecycle") records.activations.set(r.componentId, r);
    }
    recordsByTrace.set(trace, records);
  }
  return records;
}
// Construct the extra lookup maps only for an otherwise eligible rejected chain.
// The ordinary consuming branch continues to use its existing smaller index.
const rejectedIndexes = new WeakMap<ReplayTrace, ReturnType<typeof buildRejectedIndex>>();
function buildRejectedIndex(trace:ReplayTrace) {
  const base=initiatingTraceIndex(trace),inputPositions=new Map<string,number>(),
    terminals=new Map<string,ReplayTraceRecord>(),resolutionsByAttempt=new Map<string,ReplayTraceRecord>();
  base.inputs.forEach((input,k)=>inputPositions.set(input.id,k));
  for(const r of trace.records) {
    if(r.kind==="resolution" || r.kind==="slider-parent" || r.kind==="spinner-resolution")terminals.set(r.componentId,r);
    if(r.kind==="resolution" && r.triggerAttemptId)resolutionsByAttempt.set(r.triggerAttemptId,r);
  }
  return {...base,inputPositions,terminals,resolutionsByAttempt};
}
export function rejectedInitiatingTraceIndex(trace:ReplayTrace) {
  let index=rejectedIndexes.get(trace);
  if(!index){index=buildRejectedIndex(trace);rejectedIndexes.set(trace,index);}
  return index;
}
function supportingConflict(trace: ReplayTrace, ids: ReadonlySet<string>, excluded?: ReadonlySet<string>) {
  if (!excluded?.size) return false;
  const records = initiatingTraceIndex(trace).byId;
  for (const id of ids) {
    const record = records.get(id);
    if (
      record &&
      (("componentId" in record && record.componentId !== null && excluded.has(record.componentId)) ||
        ("parentId" in record && excluded.has(record.parentId)))
    )
      return true;
  }
  return false;
}

/** A narrow causal certificate for one corrected standalone predecessor. A
 * later null tap beyond the same passage is retained as failed recovery; a
 * separate passage or an uncleared prefix keeps the ordinary comparison. */
function certifyDependentRecovery(target:CircleEvidence,root:CircleEvidence,link:InitiatingChain["links"][number],
  rootComparison:ReturnType<typeof comparePrimaryApproaches>,recovery:ReturnType<typeof comparePrimaryApproaches>,
  map:Beatmap,trace:ReplayTrace,excluded:ReadonlySet<string>=new Set()):InitiatingChain["recoveryPriority"] {
  const ro=map.getHitObject(root.targetId),to=map.getHitObject(target.targetId),index=rejectedInitiatingTraceIndex(trace);
  const ri=map.hitObjects.findIndex(o=>o.id===ro.id),ti=map.hitObjects.findIndex(o=>o.id===to.id),episode=rootComparison.approaches.episodes[0];
  if(!(ro instanceof HitCircle)||ro.sliderId||!(to instanceof HitCircle)||to.sliderId||ri<0||ti!==ri+1||ti>4096||link.rejectedBy||
    rootComparison.ranking.selected.length!==1||
    !episode?.properPass||episode.spatialCandidates.length||episode.properPass.leftCensored||!episode.properPass.deepSampled||
    !root.geometry||!target.geometry||!target.terminal||!root.terminal||!root.terminal.previousUnresolved||
    root.terminal.mechanism!=="successful-input"||trace.droppedRecordBoundary!==undefined||
    JSON.stringify(target.identity)!==JSON.stringify(trace.identity))return;
  const lost=target.inputs.find(i=>i.record.id===link.inputId),press=root.inputs.find(i=>i.record.id===link.precedingInputId);
  if(!lost?.inside||!lost.inLiveSuccess||lost.postTerminal||!press||press.inside||!press.freshActionsKnown||
    press.record.freshActions.length!==1||lost.record.freshActions.length!==1||
    lost.record.freshActions[0]===press.record.freshActions[0]||root.terminal.timeMs!==lost.record.timeMs)return;
  const classic=trace.identity.analysisProfileId==="lazer"&&!!map.lazerModSettings.classic?.classicNoteLock;
  const ids=new Set<string>(),add=(...values:string[])=>values.forEach(id=>ids.add(id));
  const conflicts=[...trace.failures,...trace.domain.sourceCoverageLimits];
  const conflicted=(id:string)=>excluded.has(id)||conflicts.some(s=>s.startsWith("dependency-conflict:")&&s.endsWith(":"+id));
  if(conflicted(ro.id)||conflicted(to.id))return;
  const clearPrefix=(at:number,sequence:number,corrected?:string)=>map.hitObjects.slice(0,at).every(o=>{
    const terminal=index.terminals.get(o.id);if(!terminal||conflicted(o.id)||(o instanceof Slider&&conflicted(o.head.id)))return false;
    add(terminal.id);return o.id===corrected||terminal.sequence<sequence;
  });
  // With a fully resolved prefix, neither Stable blockers nor Classic stack
  // veto can survive. Classic's reverse equal-time selector still needs a veto.
  if(classic&&map.hitObjects.slice(ri+1).some(o=>(o instanceof HitCircle?o.hitTime:o.startTime)===ro.hitTime)||
    classic&&map.hitObjects.slice(ti+1).some(o=>(o instanceof HitCircle?o.hitTime:o.startTime)===to.hitTime))return;
  const correction=root.inputs.find(i=>i.inside&&i.inLiveSuccess&&!i.postTerminal&&i.record.sequence>press.record.sequence&&
    i.record.sequence<lost.record.sequence&&!i.record.freshActions.length&&i.record.actions.includes(press.record.freshActions[0])&&
    Math.abs(i.record.timeMs-ro.hitTime)<=root.geometry!.hitWindows[0]&&episode.properPass!.sampledEventIds.includes(i.record.id)&&
    clearPrefix(ri,i.record.sequence));
  if(!correction||!clearPrefix(ti,lost.record.sequence,ro.id))return;
  const activation=index.activations.get(to.id);
  if(!activation||activation.sequence>=lost.record.sequence||activation.kind!=="lifecycle"||activation.transition!=="activated")return;
  const end=index.inputs.findIndex(q=>q.sequence>target.terminal!.sequence),begin=index.inputPositions.get(press.record.id)??-1;
  if(begin<1||end<0||end-begin>4096)return;
  const span=index.inputs.slice(begin-1,end+1),same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(v=>b.includes(v));
  for(const e of recovery.approaches.episodes){
    const input=target.inputs.find(i=>i.record.id===e.inputId)?.record,attempts=target.attempts.filter(a=>a.inputId===e.inputId),a=attempts[0];
    const routes=target.routing.filter(r=>r.attemptId===a?.id),s=routes[0];
    if(!input||attempts.length!==1||!a||a.automated||a.attemptOrdinal!==0||!same(a.actionCandidates,input.freshActions)||
      (a.knownAction!==undefined&&a.knownAction!==input.freshActions[0])||routes.length!==1||s?.kind!=="selection"||s.componentId!==null||
      s.component!==undefined||s.inside!==null||s.eligible||s.selectionStopped||index.resolutionsByAttempt.has(a.id))return;
  }
  const point=(q:InputRecord)=>({x:classic?q.position.x:Math.fround(q.position.x),y:classic?q.position.y:Math.fround(q.position.y)});
  const center={x:classic?to.position.x:Math.fround(to.position.x),y:classic?to.position.y:Math.fround(to.position.y)};
  const radius=Math.fround(classic?to.radius:stableGameplayRadius(to.radius));
  if(target.geometry.radius!==radius||target.geometry.position.x!==to.position.x||target.geometry.position.y!==to.position.y)return;
  let left=false,exitTime:number|undefined;
  for(let k=0;k<span.length;k++){
    const q=span[k],p=span[k-1];
    if(q.source.origin!=="parsed"||q.source.discontinuityBefore?.length||!Number.isSafeInteger(q.source.parsedFrameIndex)||q.source.parsedFrameIndex<0||
      (q.source.rawTokenIndex!==undefined&&(!Number.isSafeInteger(q.source.rawTokenIndex)||q.source.rawTokenIndex<0))||
      ![q.timeMs,q.position.x,q.position.y].every(Number.isFinite)||
      [q.actions,q.previousActions,q.freshActions].some(a=>new Set(a).size!==a.length||a.some(v=>v!==0&&v!==1))||
      !same(q.freshActions,q.actions.filter(v=>!q.previousActions.includes(v)))||
      (q.rawButtonMask!==undefined&&(!Number.isSafeInteger(q.rawButtonMask)||q.rawButtonMask<0||!same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])])))||
      (p&&(p.source.origin!=="parsed"||q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||q.timeMs<=p.timeMs||
        q.timeMs-p.timeMs>target.geometry.hitWindows[0]||!same(q.previousActions,p.actions)||
        ((q.source.rawTokenIndex!==undefined||p.source.rawTokenIndex!==undefined)&&(p.source.rawTokenIndex===undefined||q.source.rawTokenIndex!==p.source.rawTokenIndex+1)))))return;
    if(q.sequence>press.record.sequence&&q.sequence<=correction.record.sequence&&!q.actions.includes(press.record.freshActions[0]))return;
    if(q.sequence>lost.record.sequence&&p){
      const a=point(p),b=point(q),dx=b.x-a.x,dy=b.y-a.y;
      const u=Math.max(0,Math.min(1,((center.x-a.x)*dx+(center.y-a.y)*dy)/(dx*dx+dy*dy||1)));
      if(left&&Math.hypot(a.x+u*dx-center.x,a.y+u*dy-center.y)<=radius)return;
      if(Math.hypot(b.x-center.x,b.y-center.y)>radius){left=true;exitTime??=q.timeMs;}
    }
    add(q.id);
  }
  if(!left||exitTime===undefined||!recovery.approaches.episodes.length||recovery.approaches.episodes.some(e=>
    e.relation!=="after-pass"||e.spatialCandidates.length||e.contacts.length!==1||e.pressTimeMs<exitTime!||
    !e.properPass||e.properPass.rightCensored||e.properPass.exitTimeMs>exitTime!||e.properPass.exitTimeMs<lost.record.timeMs))return;
  add(activation.id,root.terminal.id,target.terminal.id,correction.record.id,lost.record.id);
  if(ids.size>32768||supportingConflict(trace,ids,excluded))return;
  return {basis:"usable-root-correction-and-no-new-target-pass",correctionInputId:correction.record.id,lostInputId:lost.record.id,eventIds:[...ids]};
}

/** A delayed earlier receptor may pass a failure downstream. Consumption alone
 * is never a diagnosis: every link needs source cadence, exact geometry and
 * ordered dispatch, ending at an independently demonstrated initiating approach.
 * Does not change input ownership, scoring, or the target's own Notelock evidence. */
export function deriveInitiatingChain(
  target: CircleEvidence,
  association: PrimaryInputEvidence,
  map: Beatmap,
  trace: ReplayTrace,
  excludedComponentIds?: ReadonlySet<string>,
): InitiatingChain | undefined {
  const stream = association.stream;
  if (
    !target.target ||
    target.terminal?.mechanism !== "automatic-expiry" ||
    target.terminal.result !== "MISS" ||
    (target.identity.analysisProfileId !== "stable" && !map.lazerModSettings.classic?.classicNoteLock)
  )
    return;
  const alternatives = stream?.phaseAlternatives?.filter((a) => a.active) ?? [];
  const preferred = alternatives.length === 1 && alternatives[0].targetInputIds.length === 1 ? alternatives[0].targetInputIds[0] : undefined;
  const assignments = stream?.assignments ?? [];
  let phase: number | undefined;
  const visited = new Set<string>();
  const links: InitiatingChain["links"] = [];
  const eventIds = new Set(alternatives.length === 1 ? alternatives[0].eventIds : []);
  let rootComparison: ReturnType<typeof comparePrimaryApproaches> | undefined;
  // Drifting recovery is provisional until it reaches a directly verified
  // successful slider release. It cannot widen ordinary cadence inheritance.
  let requiresReleaseBoundaryRoot = false;
  const earlierInputObligations = new Set<string>();
  const records = initiatingTraceIndex(trace);
  const sameActions = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((x) => b.includes(x));
  const freshSource = (input: InputRecord, until: number) => {
    let lo = 0,
      hi = records.inputs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (records.inputs[mid].sequence <= input.sequence) lo = mid + 1;
      else hi = mid;
    }
    const previous = records.inputs[lo - 2],
      next = records.inputs[lo];
    if (
      !previous ||
      input.source.origin !== "parsed" ||
      previous.source.origin !== "parsed" ||
      input.source.parsedFrameIndex !== previous.source.parsedFrameIndex + 1 ||
      input.source.discontinuityBefore?.length ||
      input.actions.some((a) => a !== 0 && a !== 1) ||
      new Set(input.actions).size !== input.actions.length ||
      !sameActions(input.previousActions, previous.actions) ||
      input.freshActions.length !== 1 ||
      !sameActions(
        input.actions.filter((a) => !input.previousActions.includes(a)),
        input.freshActions,
      ) ||
      (next && next.sequence < until)
    )
      return false;
    eventIds.add(previous.id);
    return true;
  };
  const complete = (e: CircleEvidence) =>
    !excludedComponentIds?.has(e.targetId) &&
    e.status === "supported" &&
    e.target &&
    e.geometry &&
    e.terminal &&
    !e.limits.truncated &&
    Object.values(e.dependencies).every((d) => d.status === "complete") &&
    map.getHitObject(e.targetId) instanceof HitCircle &&
    !excludedComponentIds?.has((map.getHitObject(e.targetId) as HitCircle).sliderId ?? e.targetId);
  const visit = (e: CircleEvidence, inputId?: string, beforeSequence = Infinity): { id: string; inputId: string } | undefined => {
    if (
      !complete(e) ||
      visited.has(e.targetId) ||
      visited.size >= 8 ||
      target.target!.hitTimeMs - e.target!.hitTimeMs > 1600
    )
      return;
    visited.add(e.targetId);
    let candidates = e.inputs.filter(
      (i) =>
        i.inLiveSuccess && !i.postTerminal && i.inside && i.freshActionsKnown && i.record.freshActions.length === 1 && i.record.sequence < beforeSequence,
    );
    // Do not turn the previous note's already-successful press into a second
    // candidate merely because overlapping receptor geometry contains it.
    const previousTime = map.hitObjects.map(o=>o instanceof Slider ? o.head : o)
      .filter((o):o is HitCircle=>o instanceof HitCircle && o.hitTime < e.target!.hitTimeMs)
      .reduce((t,o)=>Math.max(t,o.hitTime),-Infinity);
    candidates=candidates.filter(i=>{
      if(i.record.id === inputId || i.record.timeMs >= (previousTime+e.target!.hitTimeMs)/2) return true;
      const attempt=e.attempts.find(a=>a.inputId === i.record.id && !a.automated);
      const resolution=attempt && trace.records.find(r=>r.kind === "resolution" && r.triggerAttemptId === attempt.id);
      if(resolution?.kind !== "resolution" || resolution.mechanism !== "successful-input" || resolution.componentId === e.targetId) return true;
      if(excludedComponentIds?.has(resolution.componentId)) return true;
      eventIds.add(resolution.id);eventIds.add(i.record.id);
      return false;
    });
    // A link has already validated this exact recorded action. Earlier actions
    // remain obligations in the receiver's bridge below; they are not competing
    // replacements for the linked action simply because circles overlap.
    if (inputId) candidates = candidates.filter(i => i.record.id === inputId);
    if (candidates.length !== 1) return;
    const input = candidates[0].record;
    if (phase === undefined) phase = input.timeMs - e.target!.hitTimeMs;
    const attempts = e.attempts.filter(a=>a.inputId === input.id && !a.automated);
    if (attempts.length !== 1) return;
    const selected = e.routing.filter(r=>r.kind === "selection" && r.attemptId === attempts[0].id);
    if (selected.length !== 1 || selected[0].kind !== "selection" || !selected[0].componentId || selected[0].componentId === e.targetId) return;
    const receiver = deriveCircleEvidence(trace,map,selected[0].componentId);
    if (!complete(receiver) || !["successful-input","input-miss"].includes(receiver.terminal!.mechanism) || visited.has(receiver.targetId)) return;
    const interval = e.target!.hitTimeMs - receiver.target!.hitTimeMs;
    if (!(interval > 0 && interval <= 200)) return;
    if (Math.abs(input.timeMs - e.target!.hitTimeMs - phase) > interval * 0.35)
      requiresReleaseBoundaryRoot = true;
    const terminal = receiver.terminal!;
    const receiverInput = receiver.inputs.find((i) => i.record.id === input.id);
    const offset = input.timeMs - receiver.target!.hitTimeMs;
    const windows = receiver.geometry!.hitWindows;
    const grade =
      Math.abs(offset) <= windows[0]
        ? "GREAT"
        : Math.abs(offset) <= windows[1]
        ? "OK"
        : Math.abs(offset) <= windows[2]
        ? "MEH"
        : Math.abs(offset) <= windows[3] ? "MISS" : undefined;
    const attempt = receiver.attempts.find((a) => a.id === terminal.triggerAttemptId);
    const routes = receiver.routing.filter((r) => r.attemptId === attempt?.id);
    const selection = routes.find((r) => r.kind === "selection"),
      policy = routes.find((r) => r.kind === "policy");
    if (
      !receiverInput?.inside ||
      !receiverInput.inInteraction ||
      (terminal.mechanism === "successful-input" && !receiverInput.inLiveSuccess) ||
      receiverInput.postTerminal ||
      !receiverInput.freshActionsKnown ||
      !attempt ||
      attempt.inputId !== input.id ||
      attempt.automated ||
      attempt.attemptOrdinal !== 0 ||
      routes.length !== 2 ||
      attempt.actionCandidates.length !== 1 ||
      attempt.actionCandidates[0] !== input.freshActions[0] ||
      (attempt.knownAction !== undefined && attempt.knownAction !== input.freshActions[0]) ||
      selection?.kind !== "selection" ||
      !selection.inside ||
      !selection.eligible ||
      !selection.selectionStopped ||
      selection.componentId !== receiver.targetId ||
      policy?.kind !== "policy" ||
      policy.state !== "allowed" ||
      policy.componentId !== receiver.targetId ||
      policy.timingResult !== terminal.result ||
      policy.timingResult !== grade ||
      policy.offsetMs !== offset ||
      policy.branch !==
        (target.identity.analysisProfileId === "stable" ? "stable:STABLE" : "native:classic-note-lock") ||
      !(
        input.sequence < attempt.sequence &&
        attempt.sequence < selection.sequence &&
        selection.sequence < policy.sequence &&
        policy.sequence < terminal.sequence &&
        terminal.sequence < e.terminal!.sequence
      ) ||
      [attempt, selection, policy, terminal].some((r) => r.timeMs !== input.timeMs)
    )
      return;
    if (!freshSource(input, terminal.sequence)) return;
    for (const component of [e, receiver]) {
      const activation = records.activations.get(component.targetId);
      if (!activation || activation.sequence >= input.sequence || activation.timeMs > input.timeMs) return;
      eventIds.add(activation.id);
    }
    const before = receiver.inputs.filter(
      (i) => i.inLiveSuccess && !i.postTerminal && i.record.sequence < input.sequence && i.record.freshActions.length,
    );
    // Only exact already-successful earlier receptors outside this slot can
    // establish context. Merely being routed elsewhere is insufficient.
    const contextInputs = before.filter(i => {
      if(i.inside || i.record.timeMs >= receiver.target!.hitTimeMs - interval/2) return false;
      const a=receiver.attempts.find(a=>a.inputId === i.record.id && !a.automated);
      const resolution=a && trace.records.find(r=>r.kind === "resolution" && r.triggerAttemptId === a.id);
      if(!resolution || resolution.kind !== "resolution" || resolution.mechanism !== "successful-input" || resolution.sequence >= input.sequence) return false;
      const prior=map.getHitObject(resolution.componentId);
      if(!(prior instanceof HitCircle) || prior.hitTime >= receiver.target!.hitTimeMs || excludedComponentIds?.has(prior.id) || excludedComponentIds?.has(prior.sliderId ?? prior.id)) return false;
      eventIds.add(resolution.id); eventIds.add(i.record.id); return true;
    });
    const remainingInputs=before.filter(i=>!contextInputs.includes(i));
    let precedingInputs=remainingInputs.filter(i=>Math.abs(i.record.timeMs-receiver.target!.hitTimeMs-phase!) <= interval*.35);
    if (!precedingInputs.length) {
      // A unique earlier usable action may establish a drifting recovery link,
      // but never by timing drift alone. The root below must verify the release.
      const latest = remainingInputs[remainingInputs.length - 1];
      precedingInputs = latest?.inside ? [latest] : [];
      requiresReleaseBoundaryRoot = true;
    }
    // An extra/recovery action is a competing explanation, not silently skipped.
    if (precedingInputs.length !== 1) return;
    const preceding = precedingInputs[0];
    for(const extra of remainingInputs.filter(i=>i !== preceding)) {
      if((extra.inside && !requiresReleaseBoundaryRoot) || extra.record.sequence >= preceding.record.sequence) return;
      // This earlier failed action can belong to a predecessor subsequently
      // traversed by the chain. It must be accounted for by an actual later link.
      earlierInputObligations.add(extra.record.id);
    }
    if (
      !preceding.freshActionsKnown ||
      preceding.record.freshActions.length !== 1
    )
      return;
    if (!freshSource(preceding.record, preceding.record.sequence)) return;
    const bridge = receiver.inputs.filter(
      (i) => i.record.sequence >= preceding.record.sequence && i.record.sequence <= input.sequence,
    );
    if (
      bridge.length < 3 ||
      bridge.some(
        (i, k) =>
          i.record.source.origin !== "parsed" ||
          (k > 0 &&
            (bridge[k - 1].record.source.origin !== "parsed" ||
              i.record.source.parsedFrameIndex !==
                (bridge[k - 1].record.source as { parsedFrameIndex: number }).parsedFrameIndex + 1 ||
              i.record.source.discontinuityBefore?.length ||
              i.record.timeMs < bridge[k - 1].record.timeMs ||
              i.record.timeMs - bridge[k - 1].record.timeMs > interval * 0.5)),
      )
    )
      return;

    [e.terminal!.id, terminal.id, attempt.id, selection.id, policy.id, ...bridge.map((i) => i.record.id)].forEach(
      (id) => eventIds.add(id),
    );
    const link = {
      targetId: e.targetId,
      receiverId: receiver.targetId,
      inputId: input.id,
      precedingInputId: preceding.record.id,
    };
    if (preceding.inside) {
      const rejected = derivePreResolutionRejections(receiver, map, trace).filter(
        (w) => w.inputId === preceding.record.id,
      );
      if (!rejected.length) {
        links.push(link);
        return visit(receiver,preceding.record.id,input.sequence);
      }
      if (rejected.length !== 1) return;
      visited.add(receiver.targetId);
      rejected[0].eventIds.forEach((id) => eventIds.add(id));
      links.push({ ...link, rejectedBy: rejected[0].blockerId });
      const blocker = map.getHitObject(rejected[0].blockerId);
      const completion = records.byId.get(rejected[0].blockerResolutionId ?? "");
      if (blocker instanceof Slider && completion?.kind === "slider-parent" &&
        completion.componentId === blocker.id && completion.result === "GREAT" &&
        completion.hitParts === completion.totalParts && !completion.pendingIds.length &&
        completion.timeMs === preceding.record.timeMs &&
        completion.sequence > records.byId.get(rejected[0].policyId)!.sequence &&
        completion.sequence < terminal.sequence) {
        const comparison = comparePrimaryApproaches(receiver, map, {
          pressIds: [preceding.record.id],
          contextBoundaryInputIds: contextInputs.map(i => i.record.id),
          end: {timeMs: input.timeMs, sequence: input.sequence, inclusive: false},
        });
        if (!comparison.complete || !comparison.ranking.selected.length) return;
        rootComparison = comparison;
        comparison.approaches.episodes.flatMap(e => e.eventIds).forEach(id => eventIds.add(id));
        eventIds.add(completion.id);
        return {id: receiver.targetId, inputId: preceding.record.id};
      }
      if (requiresReleaseBoundaryRoot) return;
      return visit(deriveCircleEvidence(trace, map, rejected[0].blockerId),undefined,preceding.record.sequence);
    }
    if (requiresReleaseBoundaryRoot) return;
    // Being outside this receiver does not end the initiating analysis when
    // the same pulse resolved another object. Correcting its aim/timing can
    // merely move the loss to that earlier object. Without a proved earlier
    // cause, neither the ordinary timing comparison nor arrival is a root.
    const precedingAttempt=receiver.attempts.find(a=>a.inputId===preceding.record.id&&!a.automated);
    if(precedingAttempt&&trace.records.some(r=>r.kind==="resolution"&&r.triggerAttemptId===precedingAttempt.id&&r.componentId!==receiver.targetId))return;
    const comparison = comparePrimaryApproaches(receiver,map,{
      pressIds: [preceding.record.id],
      contextBoundaryInputIds: contextInputs.map(i=>i.record.id),
      end: {timeMs:input.timeMs,sequence:input.sequence,inclusive:false},
    });
    if (!comparison.complete || !comparison.ranking.selected.length) return;
    rootComparison = comparison;
    visited.add(receiver.targetId);
    comparison.approaches.episodes.flatMap(e=>e.eventIds).forEach(id=>eventIds.add(id));
    assignments.filter(a=>a.inputId === preceding.record.id && a.componentId === receiver.targetId).flatMap(a=>a.eventIds).forEach(id=>eventIds.add(id));
    links.push(link);
    return { id: receiver.targetId, inputId: preceding.record.id };
  };
  const root = visit(target, preferred);
  if (!root || !rootComparison || supportingConflict(trace, eventIds, excludedComponentIds)) return;
  const rootArrivalComparison=!requiresReleaseBoundaryRoot?
    compareInitiatingArrival(deriveCircleEvidence(trace,map,root.id),map,rootComparison):undefined;
  rootArrivalComparison?.eventIds.forEach(id=>eventIds.add(id));
  if([...earlierInputObligations].some(id=>id !== root.inputId && !links.some(l=>l.inputId === id || l.precedingInputId === id))) return;
  const additionalInputIds = target.inputs
    .filter(
      (i) =>
        i.inLiveSuccess &&
        !i.postTerminal &&
        i.record.freshActions.length &&
        !links.some((l) => l.inputId === i.record.id),
    )
    .map((i) => i.record.id);
  const additionalInputEvidence: InitiatingChain["additionalInputEvidence"]=[];
  const recoveryIds:string[]=[];
  for(const id of additionalInputIds) {
    // Overlapping live windows can include the already-proved initiating
    // pulse. Its role is established by the chain above, not a second attempt
    // at this downstream target. Preserve it as evidence without comparing it
    // again as failed recovery; genuinely additional pulses still pass below.
    const earlierLink=links.find(link=>link.precedingInputId===id);
    if(earlierLink){
      additionalInputEvidence.push({inputId:id,receiverId:earlierLink.receiverId,kind:"earlier-chain-slot",eventIds:[id]});
      eventIds.add(id);
      continue;
    }
    const item=target.inputs.find(i=>i.record.id === id)!;
    const attempt=target.attempts.find(a=>a.inputId === id && !a.automated);
    const resolution=attempt && trace.records.find(r=>r.kind === "resolution" && r.triggerAttemptId === attempt.id);
    const selection=attempt && target.routing.find(r=>r.kind === "selection" && r.attemptId === attempt.id);
    const receiverId=resolution?.kind === "resolution" ? resolution.componentId : selection?.kind === "selection" ? selection.componentId : undefined;
    const receiver=receiverId ? map.getHitObject(receiverId) : undefined;
    // A later successful outside-target press is explicit next-slot context.
    // Unknown extra actions/recovery attempts must be compared, not discarded.
    if(item.inside || !item.freshActionsKnown || item.record.freshActions.length !== 1 || !attempt ||
       attempt.attemptOrdinal !== 0 || !sameActions(attempt.actionCandidates,item.record.freshActions) ||
       !freshSource(item.record,attempt.sequence)) return;
    if(selection?.kind === "selection" && selection.componentId === null && !selection.selectionStopped &&
      !resolution && item.record.sequence<attempt.sequence && attempt.sequence<selection.sequence &&
      attempt.timeMs === item.record.timeMs && selection.timeMs === item.record.timeMs) {
      recoveryIds.push(id);
      additionalInputEvidence.push({inputId:id,kind:"failed-recovery",eventIds:[id,attempt.id,selection.id]});
      [id,attempt.id,selection.id].forEach(x=>eventIds.add(x));
      continue;
    }
    if(
       !(receiver instanceof HitCircle) || receiver.hitTime <= target.target.hitTimeMs ||
       excludedComponentIds?.has(receiver.id) || excludedComponentIds?.has(receiver.sliderId ?? receiver.id)) return;
    const rejections=derivePreResolutionRejections(deriveCircleEvidence(trace,map,receiver.id),map,trace)
      .filter(w=>w.inputId === id && w.blockerId === target.targetId);
    if(resolution?.kind === "resolution" && resolution.mechanism === "successful-input") {
      additionalInputEvidence.push({inputId:id,receiverId:receiver.id,kind:"next-slot-success",eventIds:[id,resolution.id]});
    } else if(rejections.length === 1 && phase !== undefined &&
      receiver.hitTime-target.target.hitTimeMs <= 200 &&
      Math.abs(item.record.timeMs-receiver.hitTime-phase) <= (receiver.hitTime-target.target.hitTimeMs)*.35) {
      additionalInputEvidence.push({inputId:id,receiverId:receiver.id,kind:"next-slot-rejection",eventIds:rejections[0].eventIds});
    } else return;
    additionalInputEvidence[additionalInputEvidence.length-1].eventIds.forEach(x=>eventIds.add(x));
  }
  const recoveryComparison=recoveryIds.length ? comparePrimaryApproaches(target,map,{
    pressIds:recoveryIds,contextBoundaryInputIds:target.inputs.filter(i=>i.record.freshActions.length && !recoveryIds.includes(i.record.id)).map(i=>i.record.id),
  }) : undefined;
  if(recoveryComparison && !recoveryComparison.complete) return;
  const targetLostIds=links.filter(l=>l.targetId === target.targetId).map(l=>l.inputId);
  const combinedRanking=recoveryComparison ? rankInitiatingAndRecovery(
    (rootArrivalComparison?.ranking.selected??rootComparison.ranking.selected).map(c=>({...c,relationId:"initiating:"+c.relationId,eventIds:[...eventIds]})),
    recoveryComparison.ranking,[...targetLostIds,...recoveryIds]) : undefined;
  const recoveryPriority=recoveryComparison&&links.length===1&&!rootArrivalComparison?
    certifyDependentRecovery(target,deriveCircleEvidence(trace,map,root.id),links[0],rootComparison,recoveryComparison,map,trace,excludedComponentIds):undefined;
  if(combinedRanking && !combinedRanking.selected.length&&!recoveryPriority) return;
  recoveryPriority?.eventIds.forEach(id=>eventIds.add(id));
  recoveryComparison?.approaches.episodes.flatMap(e=>e.eventIds).forEach(id=>eventIds.add(id));
  if(supportingConflict(trace,eventIds,excludedComponentIds)) return;
  return {
    rootComponentId: root.id,
    rootInputId: root.inputId,
    rootComparison,
    ...(rootArrivalComparison?{rootArrivalComparison}:{}),
    causes: recoveryPriority?rootComparison.ranking.selected:combinedRanking?.selected ?? rootArrivalComparison?.ranking.selected ?? rootComparison.ranking.selected,
    ...(recoveryPriority?{recoveryPriority}:{}),
    ...(recoveryComparison ? {recoveryComparison,combinedRanking} : {}),
    componentIds: [...visited],
    eventIds: [...eventIds],
    links,
    additionalInputIds,
    additionalInputEvidence,
    basis: "bounded-cadence-and-model-dispatch",
  };
}

