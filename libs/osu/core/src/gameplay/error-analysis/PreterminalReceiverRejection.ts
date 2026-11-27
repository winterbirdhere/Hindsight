import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { CircleEvidence, deriveCircleEvidence, derivePreResolutionRejections } from "../miss-explanation/CircleEvidence";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";

const indexes=new WeakMap<ReplayTrace,ReturnType<typeof buildIndex>>();
function buildIndex(trace:ReplayTrace){
  const byId=new Map<string,ReplayTraceRecord>(),resolvedAttempts=new Set<string>(),activations=new Map<string,ReplayTraceRecord>();
  let invalid=trace.records.length>trace.limits.maxRecords,sequence=-1;
  for(const r of trace.records){
    if(byId.has(r.id)||!Number.isSafeInteger(r.sequence)||r.sequence<=sequence||!Number.isFinite(r.timeMs))invalid=true;
    sequence=r.sequence;byId.set(r.id,r);
    if(r.kind==="resolution"&&r.triggerAttemptId)resolvedAttempts.add(r.triggerAttemptId);
    if(r.kind==="lifecycle"&&!activations.has(r.componentId))activations.set(r.componentId,r);
  }
  return {byId,resolvedAttempts,activations,invalid,receivers:new Map<string,ReturnType<typeof derivePreResolutionRejections>>()};
}

/** A recorded failed later receiver at the final interaction boundary. This is
 * not a live target hit opportunity. It permits testing an earlier timing
 * correction only; callers must still certify its source/channel and sample. */
export function derivePreterminalReceiverRejection(e:CircleEvidence,map:Beatmap,trace:ReplayTrace|undefined,inputId:string,excluded:ReadonlySet<string>=new Set()){
  const item=e.inputs.find(i=>i.record.id===inputId),terminal=e.terminal,target=map.getHitObject(e.targetId);
  if(!trace||!(target instanceof HitCircle)||e.status!=="supported"||e.limits.truncated||!e.target||!e.geometry||
    terminal?.mechanism!=="automatic-expiry"||terminal.result!=="MISS"||!terminal.previousUnresolved||
    Object.values(e.dependencies).some(d=>d.status!=="complete")||JSON.stringify(trace.identity)!==JSON.stringify(e.identity)||
    !item||item.inLiveSuccess||(!item.inInteraction&&item.record.timeMs!==terminal.timeMs)||item.postTerminal||!item.freshActionsKnown||item.record.freshActions.length!==1||
    item.record.timeMs<=e.target.hitTimeMs+e.geometry.hitWindows[2]||item.record.timeMs>terminal.timeMs||item.record.sequence>=terminal.sequence)return;
  let index=indexes.get(trace);if(!index){index=buildIndex(trace);indexes.set(trace,index);}if(index.invalid)return;
  const canonical=(r:ReplayTraceRecord)=>JSON.stringify(index!.byId.get(r.id))===JSON.stringify(r),
    conflicted=(id:string)=>excluded.has(id)||[...trace.failures,...trace.domain.sourceCoverageLimits].some(s=>s.startsWith("dependency-conflict:")&&s.endsWith(":"+id)),
    activation=index.activations.get(target.id),attempts=e.attempts.filter(a=>a.inputId===inputId),attempt=attempts[0];
  if(!canonical(item.record)||!canonical(terminal)||!activation||activation.sequence>=item.record.sequence||activation.timeMs>item.record.timeMs||
    conflicted(target.id)||conflicted(target.sliderId??target.id)||attempts.length!==1||!attempt||!canonical(attempt)||attempt.automated||
    attempt.attemptOrdinal!==0||attempt.actionCandidates.length!==1||attempt.actionCandidates[0]!==item.record.freshActions[0]||
    (attempt.knownAction!==undefined&&attempt.knownAction!==item.record.freshActions[0])||index.resolvedAttempts.has(attempt.id))return;
  for(const policy of e.routing){
    if(policy.kind!=="policy"||policy.attemptId!==attempt.id||policy.state!=="rejected"||policy.blockerId!==target.id||
      policy.sequence>=terminal.sequence||!canonical(policy))continue;
    const receiver=map.getHitObject(policy.componentId);
    if(!(receiver instanceof HitCircle)||receiver.hitTime<=target.hitTime||conflicted(receiver.id)||conflicted(receiver.sliderId??receiver.id))continue;
    let witnesses=index.receivers.get(receiver.id);
    if(!witnesses){
      const re=deriveCircleEvidence(trace,map,receiver.id);
      witnesses=!re.limits.truncated&&Object.values(re.dependencies).every(d=>d.status==="complete")?derivePreResolutionRejections(re,map,trace):[];
      if(index.receivers.size>=32)index.receivers.delete(index.receivers.keys().next().value!);
      index.receivers.set(receiver.id,witnesses);
    }
    const witness=witnesses.find(w=>w.inputId===inputId&&w.policyId===policy.id&&w.blockerId===target.id);
    if(witness)return {inputId,receiverId:receiver.id,policyId:policy.id,scope:"preterminal-receiver-rejection" as const,
      eventIds:[...new Set([activation.id,terminal.id,...witness.eventIds])]};
  }
  return;
}
