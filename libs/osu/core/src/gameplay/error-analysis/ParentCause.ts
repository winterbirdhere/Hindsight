import { Beatmap } from "../../beatmap/Beatmap";
import { CircleEvidence, deriveCircleEvidence, InputRecord } from "../miss-explanation/CircleEvidence";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import type { CircleMechanism } from "./CircleMechanisms";
import type { ComponentMechanism } from "./ComponentMechanisms";
import type { ErrorAtom } from "./ErrorInventory";
import { errorCapabilities } from "./ErrorCapabilities";

export interface ParentCauseEvidence {
  policy: "parent-contributions-v1" | "parent-contributions-v2" | "parent-player-action-v3";
  parentAtomId: string;
  parentEventId: string;
  profileFingerprint: string;
  pendingHeadContribution?: {
    componentId:string; parentEventId:string; eventIds:string[];
    opportunityStart:CircleEvidence["domains"]["liveSuccess"]["start"];
    opportunityEnd:CircleEvidence["domains"]["liveSuccess"]["end"];
    code:"no-tap";
  };
  contributions: Array<{
    atomId: string; componentId: string; resolutionId: string;
    certification: "resolved-contribution" | "head-opportunity-before-parent";
    opportunityEnd?: CircleEvidence["domains"]["liveSuccess"]["end"];
  }>;
  groups: Array<{
    id: string; family: "geometry" | "holding" | "head" | "acquisition";
    code: string; headline: string; atomIds: string[]; contributionIds:string[]; eventIds: string[];
    recoveryEventId?: string; firstSequence: number;
  }>;
  comparison: Array<{ groupId: string; contributionCount: number; selected: boolean;
    /** Counts remain diagnostic only; they do not rank player importance. */
    scope?: "navigation" | "accuracy" | "carried-hold-consequence" | "unacquired-body-consequence";
    dependentOn?: string; eventIds?: string[]; onsetTimeMs?: number;
    onset?: { earliestMs: number; latestMs: number; eventIds: string[] };
  }>;
}
type Tracking = Extract<ReplayTraceRecord, { kind: "slider-tracking" }>;
const spatial = new Set(["off-track", "ran-ahead", "fell-behind", "turned-early"]);
const holding = new Set(["no-hold", "wrong-hold", "released-early"]);
const headSpatial = new Set(["misaim", "overshoot", "undershoot", "wide-aim"]);
const labels: Record<string,string> = {
  "off-track": "Off track", "ran-ahead": "Ran ahead", "fell-behind": "Fell behind", "turned-early": "Turned early",
  "no-hold": "No hold", "wrong-hold": "Wrong hold", "released-early": "Early release", "late-pickup": "Late pickup",
  "started-late": "Started late", "no-tap": "No tap", "aim-late": "Late entry", "left-early": "Early exit",
};
const unique = (xs: string[]) => [...new Set(xs)];
const inputIndexes = new WeakMap<ReplayTrace, InputRecord[]>();
const checkpointIndexes = new WeakMap<ReplayTrace, Map<string, Array<Extract<ReplayTraceRecord,{kind:"slider-checkpoint"}>>>>();
function checkpointIndex(trace: ReplayTrace) {
  let index = checkpointIndexes.get(trace);
  if (!index) {
    index = new Map();
    for(const r of trace.records) if(r.kind === "slider-checkpoint") {
      const values = index.get(r.componentId) ?? []; values.push(r); index.set(r.componentId,values);
    }
    checkpointIndexes.set(trace,index);
  }
  return index;
}
function localInputs(trace: ReplayTrace, fromSequence: number, toSequence: number) {
  let inputs = inputIndexes.get(trace);
  if (!inputs) {
    inputs = trace.records.filter((r): r is InputRecord => r.kind === "input");
    inputIndexes.set(trace, inputs);
  }
  const find = (value: number) => {
    let lo = 0, hi = inputs!.length;
    while(lo < hi) { const mid = (lo + hi) >>> 1; if(inputs![mid].sequence < value) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const from = Math.max(0, find(fromSequence) - 1), through = find(toSequence);
  if (through - from > 4096) return [];
  return inputs.slice(from, through);
}
const contiguous = (inputs: InputRecord[]) => inputs.length >= 2 && inputs.every((r, i) =>
  r.source.origin === "parsed" && (!i || (
    inputs[i - 1].source.origin === "parsed" &&
    r.source.parsedFrameIndex === (inputs[i - 1].source as { parsedFrameIndex: number }).parsedFrameIndex + 1 &&
    !r.source.discontinuityBefore?.length && r.timeMs >= inputs[i - 1].timeMs
  )));
const sameActions = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every(value=>b.includes(value));
/** Only the new action-dependency certificate uses this stronger source bridge.
 * It cannot treat a parser hole or a contradictory action history as absence. */
function continuousActions(inputs: InputRecord[]) {
  return contiguous(inputs) && inputs.every((r,i)=>{
    if(!Number.isFinite(r.timeMs) || r.source.origin !== "parsed" || !Number.isSafeInteger(r.source.parsedFrameIndex) || r.source.parsedFrameIndex < 0 ||
      r.source.discontinuityBefore?.length || r.actions.some(a=>a!==0 && a!==1) ||
      !sameActions(r.freshActions,r.actions.filter(a=>!r.previousActions.includes(a)))) return false;
    if(r.rawButtonMask !== undefined && (!Number.isSafeInteger(r.rawButtonMask) || r.rawButtonMask < 0 ||
      r.rawButtonMask > 31 || !sameActions(r.actions,[...(r.rawButtonMask & 5 ? [0] : []),...(r.rawButtonMask & 10 ? [1] : [])]))) return false;
    const raw = r.source.rawTokenIndex;
    if(raw !== undefined && (!Number.isSafeInteger(raw) || raw < 0)) return false;
    if(!i) return true;
    const prior = inputs[i-1];
    return sameActions(r.previousActions,prior.actions) && prior.source.origin === "parsed" &&
      (raw === undefined && prior.source.rawTokenIndex === undefined || raw !== undefined && raw === (prior.source.rawTokenIndex ?? -2) + 1);
  });
}

/** Certify every scoring contribution, then project independent gameplay actions.
 * Axis-specific recovery prevents unrelated head/body lapses merging. */
export function classifyParentCause(
  atom: ErrorAtom, atoms: ReadonlyMap<string, ErrorAtom>, classifications: ReadonlyMap<string, ComponentMechanism>,
  trace: ReplayTrace, map: Beatmap, byId: ReadonlyMap<string, ReplayTraceRecord>, tracking: readonly Tracking[],
  excluded: ReadonlySet<string>,
): ComponentMechanism {
  const proof: ParentCauseEvidence = { policy: "parent-player-action-v3", parentAtomId: atom.id,
    parentEventId: atom.eventId, profileFingerprint: trace.identity.analysisProfileFingerprint,
    contributions: [], groups: [], comparison: [] };
  const unavailable = (reason: string): ComponentMechanism => ({ status: "unavailable", codes: [], headline: "",
    description: "", eventIds: [atom.eventId], limitations: [reason], parentEvidence: proof });
  const parent = byId.get(atom.eventId), slider = map.getSlider(atom.parentId);
  if (parent?.kind !== "slider-parent" || !slider || parent.componentId !== atom.componentId || !parent.scoring ||
    parent.result !== atom.result || parent.timeMs !== atom.resolutionTimeMs || parent.headId !== slider.head.id ||
    parent.totalParts !== parent.checkpointIds.length + 1 || parent.pendingIds.length ||
    excluded.has(atom.parentId) || atom.identity.analysisProfileFingerprint !== trace.identity.analysisProfileFingerprint)
    return unavailable("invalid-parent-contribution-scope");
  const linked = atom.relatedAtomIds.map(id => atoms.get(id));
  if (!linked.length || linked.some(a => !a || a.parentId !== atom.parentId || a.role !== "primary" || excluded.has(a.parentId)))
    return unavailable("missing-parent-contribution");
  const receipts = parent.checkpointIds.map(id => checkpointIndex(trace).get(id));
  if (receipts.some(rs => rs?.length !== 1 || rs[0].parentId !== parent.componentId || rs[0].sequence >= parent.sequence))
    return unavailable("incomplete-parent-checkpoint-receipts");
  const checkpoints = receipts.map(rs=>rs![0]);
  const head = linked.find(a => a?.componentId === parent.headId);
  const pendingWithoutAtom=parent.headResult === undefined && atom.pendingContributionIds.includes(parent.headId) && !head &&
    ![...atoms.values()].some(a=>a.componentId === parent.headId && a.parentId === parent.componentId);
  const expected = checkpoints.filter(r=>!r.hit).map(r=>r.componentId);
  if (!pendingWithoutAtom && (parent.headResult === undefined || parent.headResult === "MISS" || (parent.headCap && parent.headResult !== "GREAT"))) expected.push(parent.headId);
  if (new Set(atom.relatedAtomIds).size !== atom.relatedAtomIds.length || expected.length !== linked.length ||
    expected.some(id => linked.filter(a=>a?.componentId === id).length !== 1) ||
    checkpoints.filter(r=>r.hit).length + (parent.headResult && parent.headResult !== "MISS" ? 1 : 0) !== parent.hitParts)
    return unavailable("incomplete-parent-contribution-accounting");
  if (atom.pendingContributionIds.some(id => id !== parent.headId)) return unavailable("unprocessed-parent-checkpoint");
  let headEvidence: CircleEvidence | undefined;
  if(pendingWithoutAtom) {
    headEvidence=deriveCircleEvidence(trace,map,parent.headId);
    const domain=headEvidence.domains.liveSuccess, inputs=headEvidence.inputs.filter(i=>i.inLiveSuccess && !i.postTerminal);
    if(trace.identity.analysisProfileId !== "stable" || errorCapabilities(map,"stable").tapping !== "manual" ||
      headEvidence.terminal || headEvidence.limits.truncated || excluded.has(parent.headId) ||
      Object.values(headEvidence.dependencies).some(d=>d.status !== "complete") || domain.state !== "nonempty" ||
      domain.end?.eventId !== parent.id || domain.end.inclusive || !inputs.length ||
      inputs.some(i=>!i.freshActionsKnown || i.record.freshActions.length)) return unavailable("uncertified-pending-head-opportunity");
    proof.pendingHeadContribution={componentId:parent.headId,parentEventId:parent.id,
      opportunityStart:domain.start,opportunityEnd:domain.end,eventIds:inputs.map(i=>i.record.id),code:"no-tap"};
  }
  for (const item of linked as ErrorAtom[]) {
    const mechanism = classifications.get(item.id), record = byId.get(item.eventId);
    if (!mechanism || mechanism.status !== "supported" || !record ||
      (!parent.checkpointIds.includes(item.componentId) && item.componentId !== parent.headId))
      return unavailable("unsupported-parent-contribution:" + item.componentId);
    if (item.componentId === parent.headId) {
      headEvidence = deriveCircleEvidence(trace,map,item.componentId);
      const end = headEvidence.domains.liveSuccess.end;
      if (!headEvidence.target || !end || headEvidence.limits.truncated ||
        headEvidence.terminal?.id !== item.eventId || end.timeMs > parent.timeMs ||
        (end.timeMs === parent.timeMs && (end.sequence ?? Infinity) > parent.sequence))
        return unavailable("uncertified-parent-head-deadline");
      const pending = atom.pendingContributionIds.includes(item.componentId);
      if (pending && (trace.identity.analysisProfileId !== "stable" || parent.headResult !== undefined ||
        end.eventId !== parent.id || end.inclusive || headEvidence.terminal?.mechanism !== "automatic-expiry"))
        return unavailable("uncertified-pending-parent-head");
      proof.contributions.push({ atomId:item.id,componentId:item.componentId,resolutionId:item.eventId,
        certification:pending ? "head-opportunity-before-parent" : "resolved-contribution",opportunityEnd:end });
    } else {
      if (record.kind !== "slider-checkpoint" || record.parentId !== parent.componentId || record.sequence >= parent.sequence || record.hit ||
        record.componentId !== item.componentId || record.component !== item.component || record.timeMs !== item.resolutionTimeMs)
        return unavailable("invalid-parent-checkpoint-link");
      proof.contributions.push({ atomId:item.id,componentId:item.componentId,resolutionId:item.eventId,certification:"resolved-contribution" });
    }
  }
  if (atom.pendingContributionIds.includes(parent.headId) && !head && !proof.pendingHeadContribution) return unavailable("missing-pending-head-evidence");
  const transitions = tracking.filter(t => t.sequence < parent.sequence && t.componentId === parent.componentId);
  const completeTransitions = trace.coverage.lifecycle === "complete" && !trace.droppedRecordBoundary;
  const groups = new Map<string, ParentCauseEvidence["groups"][number]>();
  const add = (id: string, family: ParentCauseEvidence["groups"][number]["family"], code: string,
    label: string, item: ErrorAtom, eventIds: string[], sequence: number, recoveryEventId?: string) => {
    const group = groups.get(id);
    if (group) {
      // One unrecovered tracking lapse can cross from ahead to behind. Its
      // aggregate cannot claim one direction for all lost parts. Component
      // diagnoses and every contributing link remain unchanged.
      if(group.family==="geometry"&&family==="geometry"&&group.code!==code){group.code="off-track";group.headline=labels["off-track"];}
      group.atomIds = unique([...group.atomIds,item.id]); group.contributionIds=unique([...group.contributionIds,item.componentId]); group.eventIds = unique([...group.eventIds,...eventIds]); group.firstSequence=Math.min(group.firstSequence,sequence);
    }
    else groups.set(id,{id,family,code,headline:label,atomIds:[item.id],contributionIds:[item.componentId],eventIds:unique(eventIds),firstSequence:sequence,recoveryEventId});
  };
  const headMechanism = head && classifications.get(head.id) as CircleMechanism | undefined;
  const headGroups = new Map<string,string>();
  if(proof.pendingHeadContribution) {
    headGroups.set("no-tap","head:no-tap");
    groups.set("head:no-tap",{id:"head:no-tap",family:"head",code:"no-tap",headline:"No tap",atomIds:[],
      contributionIds:[parent.headId],eventIds:proof.pendingHeadContribution.eventIds,firstSequence:parent.sequence});
  }
  if (head && headMechanism) for (const [i,code] of headMechanism.codes.entries()) {
    const id = "head:" + code;
    headGroups.set(code,id);
    add(id,"head",code,labels[code] ?? headMechanism.headline.split(/\s*·\s*/)[i] ?? headMechanism.headline,
      head,headMechanism.eventIds,byId.get(head.eventId)?.sequence ?? head.scoringOrder);
  }
  for (const item of (linked as ErrorAtom[]).filter(a => a !== head).sort((a,b) => a.scoringOrder-b.scoringOrder)) {
    const mechanism = classifications.get(item.id)!, checkpoint = byId.get(item.eventId)!;
    if (checkpoint.kind !== "slider-checkpoint") return unavailable("invalid-parent-checkpoint");
    for (const code of mechanism.codes) {
      const family = spatial.has(code) ? "geometry" : holding.has(code) ? "holding" : "acquisition";
      const accepted = family === "geometry" ? "geometryAccepted" : "holdAccepted";
      const before = transitions.filter(t => t.sequence < checkpoint.sequence);
      const lastRecovery = family === "acquisition" ? undefined : before.filter(t => t.tracking[accepted]).pop();
      const failed = before.filter(t => t.sequence > (lastRecovery?.sequence ?? -1) && !t.tracking[accepted]);
      let id = family + ":" + (lastRecovery?.id ?? "initial");
      let inherited: string | undefined;
      if (completeTransitions && headEvidence && (headMechanism || proof.pendingHeadContribution)) {
        if (family === "holding" && headGroups.has("no-tap") && code === "no-hold") {
          const start = headEvidence.inputs.find(i => i.inLiveSuccess)?.record;
          const bridge = start && localInputs(trace,start.sequence,checkpoint.sequence);
          if (bridge && contiguous(bridge) && bridge.every(i => !i.actions.length) &&
            !before.some(t => t.tracking.holdAccepted)) inherited = headGroups.get("no-tap");
        } else if (family === "geometry" && headMechanism) {
          const codes = headMechanism.codes.filter(c => headSpatial.has(c));
          const inputs = headMechanism.diagnostics?.primary?.ranking?.selected
            .filter(c => codes.includes(c.code)).flatMap(c => c.inputIds) ?? [];
          const press = headEvidence.inputs.find(i => inputs.includes(i.record.id));
          const bridge = press && localInputs(trace,press.record.sequence,checkpoint.sequence);
          if (codes.length === 1 && press && bridge && contiguous(bridge) &&
            !before.some(t => t.sequence > press.record.sequence && t.tracking.geometryAccepted) &&
            !headEvidence.inputs.some(i => i.record.sequence > press.record.sequence && i.record.timeMs <= slider.startTime && i.inside))
            inherited = headGroups.get(codes[0]);
        }
      }
      if (inherited) id = inherited;
      if (family === "acquisition") id += ":"+code;
      const previous = groups.get(id);
      if (previous && !inherited && (!completeTransitions || !contiguous(localInputs(trace,previous.firstSequence,checkpoint.sequence))))
        id += ":source-boundary:" + checkpoint.id;
      add(id,family,code,labels[code] ?? mechanism.headline,item,
        [...mechanism.eventIds,...failed.map(t => t.id),...(lastRecovery ? [lastRecovery.id] : [])],checkpoint.sequence,lastRecovery?.id);
    }
  }
  proof.groups = [...groups.values()];
  if (!proof.groups.length) return unavailable("no-parent-lapse-groups");
  const omission = headGroups.get("no-tap");
  const atStart = transitions.filter(t=>t.timeMs <= slider.startTime).pop();
  const startInput = headEvidence?.inputs.find(i=>i.record.timeMs >= slider.startTime)?.record;
  const compared = proof.groups.map(group=>{
    const parts = group.atomIds.map(id=>atoms.get(id)!);
    const navigation = parts.some(a=>a.comboPenalty) || !!proof.pendingHeadContribution && group.id === omission;
    const end = Math.max(...parts.map(a=>byId.get(a.eventId)?.sequence ?? -1));
    const firstEnd = Math.min(...parts.map(a=>byId.get(a.eventId)?.sequence ?? Infinity));
    const bridge = startInput && localInputs(trace,startInput.sequence,end);
    // A rule-owned tracked state can come from the preceding note's hold. It
    // does not by itself establish a fresh slider attempt. Preserve the release
    // diagnosis if a new action or a later tracking pickup/recovery intervenes.
    const carried = group.family === "holding" && !!omission && group.id !== omission &&
      completeTransitions && atStart?.tracking.tracking && atStart.tracking.sampleBasis === "recorded-update" &&
      bridge && continuousActions(bridge) &&
      bridge.some(i=>i.timeMs <= slider.startTime) &&
      bridge.every(i=>i.timeMs < slider.startTime || !i.freshActions.length) &&
      !transitions.some(t=>t.timeMs > slider.startTime && t.sequence < end &&
        !t.tracking.beforeTracking && t.tracking.tracking);
    // A failed head followed by never-acquired tracking is one failed slider
    // initiation, not automatically a second movement/holding mistake. Fresh
    // edges may exist here; this says nothing about their intended target.
    // An actual body acquisition (including from a held key) keeps the later
    // lapse independent. A successful head is never subject to this relation.
    const unacquired = group.family !== "head" && headGroups.size > 0 && completeTransitions &&
      !atStart?.tracking.tracking && bridge && continuousActions(bridge) &&
      bridge.some(i=>i.timeMs <= slider.startTime) &&
      (head?.result === "MISS" || !!proof.pendingHeadContribution) &&
      transitions.some(t=>t.timeMs >= slider.startTime && t.sequence < firstEnd) &&
      !transitions.some(t=>t.timeMs >= slider.startTime && t.sequence < firstEnd && t.tracking.tracking);
    const scope = carried ? "carried-hold-consequence" : unacquired ? "unacquired-body-consequence" : navigation ? "navigation" : "accuracy";
    // Onset follows the input/tracking episode, not the order in which a late
    // head expiry or an end receipt happened to be emitted.
    const recovery = group.recoveryEventId ? byId.get(group.recoveryEventId)?.sequence ?? -1 : -1;
    const axis = group.family === "geometry" ? "geometryAccepted" : "holdAccepted";
    const failed = transitions.find(t=>t.timeMs >= slider.startTime && t.sequence > recovery &&
      t.sequence < end && !t.tracking[axis]);
    const pressIds = group.family === "head" ? headMechanism?.diagnostics?.primary?.ranking?.selected
      .filter(c=>c.code===group.code).flatMap(c=>c.inputIds) ?? [] : [];
    const presses = headEvidence?.inputs.filter(i=>pressIds.includes(i.record.id)) ?? [];
    let onset: NonNullable<ParentCauseEvidence["comparison"][number]["onset"]> | undefined;
    const chainStart = headMechanism?.chain?.disposition === "inherited" && group.family === "head"
      ? byId.get(headMechanism.chain.start.inputId) : undefined;
    if (completeTransitions && chainStart?.kind === "input") {
      onset = { earliestMs: chainStart.timeMs, latestMs: chainStart.timeMs, eventIds: [chainStart.id] };
    } else if (completeTransitions && group.family === "head" && group.code === "no-tap" && headEvidence) {
      const domain = headEvidence.domains.liveSuccess;
      const live = headEvidence.inputs.filter(i=>i.inLiveSuccess && !i.postTerminal);
      if(domain.state === "nonempty" && domain.start && domain.end && live.length &&
        Object.values(headEvidence.dependencies).every(d=>d.status === "complete") &&
        continuousActions(localInputs(trace,live[0].record.sequence,live[live.length-1].record.sequence+1)))
        onset={earliestMs:domain.start.timeMs,latestMs:domain.end.timeMs,eventIds:live.map(i=>i.record.id)};
    } else if (completeTransitions && group.family === "head" && pressIds.length && presses.length === unique(pressIds).length &&
      presses.every(i=>i.freshActionsKnown && !i.postTerminal && i.record.freshActions.length)) {
      const first = presses[0].record, last = presses[presses.length-1].record;
      const source = localInputs(trace,first.sequence,last.sequence+1);
      if(continuousActions(source)) onset={earliestMs:first.timeMs,latestMs:last.timeMs,eventIds:source.map(i=>i.id)};
    } else if (completeTransitions && (group.family === "geometry" || group.family === "holding") && failed && group.recoveryEventId) {
      const recovered = byId.get(group.recoveryEventId);
      if(recovered?.kind === "slider-tracking" && recovered.tracking.sampleBasis === "recorded-update" &&
        failed.tracking.sampleBasis === "recorded-update" && recovered.timeMs <= failed.timeMs) {
        const source = localInputs(trace,recovered.sequence,failed.sequence+1);
        if(continuousActions(source)) onset={earliestMs:recovered.timeMs,latestMs:failed.timeMs,
          eventIds:unique([recovered.id,failed.id,...source.map(i=>i.id)])};
      }
    }
    const onsetTimeMs = onset?.latestMs;
    return {group,scope,onsetTimeMs,dependentOn:carried ? omission : unacquired ? "failed-head-initiation" : undefined,
      eventIds:carried ? unique([atStart!.id,...bridge!.map(i=>i.id)]) : unacquired ?
        unique([...bridge!.map(i=>i.id),...transitions.filter(t=>t.sequence<firstEnd).map(t=>t.id)]) : [],onset} as const;
  });
  const independent = compared.filter(c=>c.scope === "navigation" || c.scope === "accuracy");
  // A parent MISS represents the same navigation error as its head/tick/repeat
  // losses. An accuracy-only tail is retained internally, not made a second
  // navigable mistake. Non-MISS exports may still describe their accuracy loss.
  const navigation = independent.filter(c=>c.scope === "navigation");
  const eligible = (parent.result === "MISS" && navigation.length ? navigation : independent)
    .sort((a,b)=>(a.onsetTimeMs ?? Infinity)-(b.onsetTimeMs ?? Infinity));
  const distinct = eligible.filter((c,i)=>eligible.findIndex(p=>p.group.code===c.group.code)===i);
  // For a longer chain, a source interval entirely before every other interval
  // establishes initiation, not greater importance or a complete repair. Check
  // all episodes before deduplicating labels; unknown/overlapping bounds cannot
  // provide a winner. In particular an omission spans its whole live window.
  const initiating = eligible.filter(c=>c.onset && eligible.every(other=>other===c ||
    other.onset && c.onset!.latestMs < other.onset.earliestMs));
  const selected = distinct.length <= 2 ? distinct : initiating.length === 1 ? initiating : [];
  proof.comparison = compared.map(c=>({groupId:c.group.id,contributionCount:c.group.contributionIds.length,
    scope:c.scope,dependentOn:c.dependentOn,eventIds:c.eventIds,onsetTimeMs:c.onsetTimeMs,onset:c.onset,selected:selected.includes(c)}));
  if (!selected.length)
    return unavailable("independent-parent-actions-unranked");
  return {status:"supported",codes:selected.map(c=>c.group.code),headline:selected.map(c=>c.group.headline).join(" · "),
    description:"The independently supported gameplay action behind the slider error; scoring consequences remain in the component evidence.",
    eventIds:unique([parent.id,...proof.groups.flatMap(g=>g.eventIds),...compared.flatMap(c=>[...c.eventIds,...(c.onset?.eventIds ?? [])])]),limitations:[],parentEvidence:proof,
    ...(head && headMechanism?.chain && selected.some(c => c.group.atomIds.includes(head.id)) ? { chain: headMechanism.chain } : {})};
}
