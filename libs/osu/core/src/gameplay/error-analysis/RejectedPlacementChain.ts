import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { StableSliderTiming } from "../StableSliderTiming";
import { CircleEvidence, CircleInputEvidence, deriveCircleEvidence, derivePreResolutionRejections } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { errorCapabilities } from "./ErrorCapabilities";
import { InitiatingChain, rejectedInitiatingTraceIndex } from "./InterceptionChain";
import { comparePrimaryApproaches } from "./PrimaryApproachComparison";
import { derivePrimaryInputEvidence, PrimaryInputEvidence } from "./PrimaryInputEvidence";

/** Rejected dispatch is not itself a cause. This separate proof requires an
 * otherwise usable own-slot pulse on EVERY intermediate circle, all rejected
 * by the same independently misplaced root. It does not relax consumption,
 * recoveries, sliders or the target's direct Notelock priority. */
export function deriveRejectedPlacementChain(
  target:CircleEvidence,association:PrimaryInputEvidence,map:Beatmap,trace:ReplayTrace,
  excluded:ReadonlySet<string>=new Set(),
):InitiatingChain|undefined {
  const caps=errorCapabilities(map,trace.identity.analysisProfileId);
  const branch=trace.identity.analysisProfileId==="stable" ? "stable:STABLE" :
    trace.identity.analysisProfileId==="lazer" && map.lazerModSettings.classic?.classicNoteLock ? "native:classic-note-lock" : undefined;
  if(!branch || trace.identity.schemaVersion!==2 || caps.scoring!=="supported" || caps.geometry!=="supported" ||
    caps.tapping!=="manual" || caps.aim!=="manual" || trace.droppedRecordBoundary!==undefined ||
    trace.records.length>trace.limits.maxRecords || JSON.stringify(target.identity)!==JSON.stringify(trace.identity) ||
    association.harmfulSurplus || association.limitations.some(s=>s==="trace-identity-mismatch" || s==="invalid-trace-index") ||
    trace.failures.some(s=>s!=="global-totals-mismatch" && !s.startsWith("dependency-conflict:")))return;
  const complete=(e:CircleEvidence)=>e.status==="supported" && e.target && e.geometry && e.terminal?.result==="MISS" &&
    e.terminal.mechanism==="automatic-expiry" && e.terminal.previousUnresolved && !e.limits.truncated &&
    Object.values(e.dependencies).every(d=>d.status==="complete") && !excluded.has(e.targetId);
  if(!complete(target) || target.directRejections.length)return;
  const own=target.inputs.filter(i=>i.record.timeMs<=trace.domain.endTimeMs && i.inLiveSuccess && !i.postTerminal &&
    i.inside && i.freshActionsKnown && i.record.freshActions.length===1 &&
    Math.abs(i.record.timeMs-target.target!.hitTimeMs)<=target.geometry!.hitWindows[0]);
  const stops=(association.stoppedDispatchRejections??[]).filter(w=>own.some(i=>i.record.id===w.inputId) && association.relevantInputIds.includes(w.inputId));
  if(stops.length!==1)return;
  const stop=stops[0],current=own.find(i=>i.record.id===stop.inputId)!.record;
  if(association.stream?.phaseAlternatives?.filter(a=>a.active).some(a=>a.targetInputIds.length!==1 || a.targetInputIds[0]!==current.id))return;
  const first=map.hitObjects.findIndex(o=>o.id===stop.blockerId),last=map.hitObjects.findIndex(o=>o.id===target.targetId);
  if(first<0 || last-first<2 || last-first+1>8)return;
  const objects=map.hitObjects.slice(first,last+1);
  if(objects.some(o=>!(o instanceof HitCircle) || o.sliderId!==undefined) || objects[objects.length-1].id!==target.targetId)return;
  const notes=objects.filter((o):o is HitCircle=>o instanceof HitCircle);
  const spacings=notes.slice(1).map((o,k)=>o.hitTime-notes[k].hitTime),minimumSpacing=Math.min(...spacings);
  if(spacings.some(d=>!(d>3 && d<=200)) || notes[notes.length-1].hitTime-notes[0].hitTime>1600)return;
  const es=notes.map(o=>o.id===target.targetId?target:deriveCircleEvidence(trace,map,o.id));
  if(es.some(e=>!complete(e)))return;
  const phase=current.timeMs-target.target!.hitTimeMs,picks:CircleInputEvidence[]=[];
  for(let k=0;k<es.length;k++) {
    const e=es[k],tolerance=.35*Math.min(spacings[Math.max(0,k-1)],spacings[Math.min(k,spacings.length-1)]);
    const candidates=e.inputs.filter(i=>i.inLiveSuccess && !i.postTerminal && i.freshActionsKnown &&
      i.record.freshActions.length===1 && Math.abs(i.record.timeMs-e.target!.hitTimeMs-phase)<=tolerance);
    if(candidates.length!==1 || (k===0?candidates[0].inside:!candidates[0].inside))return;
    picks.push(candidates[0]);
  }
  if(picks[picks.length-1].record.id!==current.id || new Set(picks.map(p=>p.record.id)).size!==picks.length)return;
  const planned=new Set(picks.map(p=>p.record.id));
  if(es.some(e=>e.inputs.some(i=>i.inLiveSuccess && !i.postTerminal && i.record.freshActions.length && !planned.has(i.record.id))))return;
  const rootInput=picks[0].record,prior=picks[1].record;
  if(Math.abs(rootInput.timeMs-es[0].target!.hitTimeMs)>es[0].geometry!.hitWindows[0])return;
  const index=rejectedInitiatingTraceIndex(trace),ids=new Set<string>(),components=new Set<string>();
  const add=(...values:string[])=>{
    for(const id of values){if(!index.byId.has(id))return false;ids.add(id);}return ids.size<=32768;
  };
  const same=(a:readonly number[],b:readonly number[])=>a.length===b.length && a.every(v=>b.includes(v));
  const validActions=(q:typeof current)=>[q.actions,q.previousActions,q.freshActions].every(a=>new Set(a).size===a.length && a.every(v=>v===0 || v===1)) &&
    same(q.freshActions,q.actions.filter(v=>!q.previousActions.includes(v))) &&
    (q.rawButtonMask===undefined || (Number.isSafeInteger(q.rawButtonMask) && q.rawButtonMask>=0 && q.rawButtonMask<=31 &&
      same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])])));
  const begin=index.inputPositions.get(rootInput.id)??-1,end=index.inputPositions.get(current.id)??-1;
  if(begin<1 || end<=begin || end-begin+2>4096)return;
  const span=index.inputs.slice(begin-1,end+1);
  for(let k=0;k<span.length;k++) {
    const q=span[k],p=span[k-1];
    if(q.source.origin!=="parsed" || !Number.isSafeInteger(q.source.parsedFrameIndex) || q.source.parsedFrameIndex<0 ||
      q.source.discontinuityBefore?.length || ![q.timeMs,q.position.x,q.position.y].every(Number.isFinite) || !validActions(q))return;
    if(q.source.rawTokenIndex!==undefined && (!Number.isSafeInteger(q.source.rawTokenIndex) || q.source.rawTokenIndex<0))return;
    if(p && (p.source.origin!=="parsed" || q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1 ||
      q.timeMs<=p.timeMs || q.timeMs-p.timeMs>minimumSpacing*.5 || !same(q.previousActions,p.actions) ||
      ((q.source.rawTokenIndex!==undefined || p.source.rawTokenIndex!==undefined) &&
        (p.source.rawTokenIndex===undefined || q.source.rawTokenIndex!==p.source.rawTokenIndex+1))))return;
    if(k>0 && q.freshActions.length && (!planned.has(q.id) || q.freshActions.length!==1))return;
    if(!add(q.id))return;
  }
  if(picks.some((p,k)=>k && p.record.sequence<=picks[k-1].record.sequence))return;
  for(let k=0;k<es.length;k++) {
    const e=es[k],activation=index.activations.get(e.targetId),pulse=picks[k].record;
    components.add(e.targetId);
    if(!activation || activation.sequence>=pulse.sequence || activation.timeMs>pulse.timeMs || e.terminal!.sequence<=pulse.sequence ||
      !add(activation.id,e.terminal!.id))return;
    for(const b of [e.domains.liveSuccess.start,e.domains.liveSuccess.end])if(b?.eventId && !add(b.eventId))return;
  }
  // A completed head cannot intercept the repaired root press. Its still-live
  // parent may overlap the chain, but must be unable to block EVERY own slot
  // under the actual ruleset end-time policy. Head completion alone is not enough.
  for(let k=0;k<first;k++) {
    const object=map.hitObjects[k],terminal=index.terminals.get(object.id);
    if(!terminal || excluded.has(object.id) || !add(terminal.id))return;
    components.add(object.id);
    if(object instanceof Slider){
      const head=index.terminals.get(object.head.id),activation=index.activations.get(object.head.id);
      if(terminal.kind!=="slider-parent" || terminal.pendingIds.length || !head || head.kind!=="resolution" ||
        head.sequence>=rootInput.sequence || !activation || activation.sequence>=head.sequence ||
        excluded.has(object.head.id) || !add(head.id,activation.id))return;
      components.add(object.head.id);
      const end=branch==="stable:STABLE"?new StableSliderTiming(object).endTime:object.endTime;
      if(!Number.isFinite(end) || picks.some((p,i)=>terminal.sequence>=p.record.sequence &&
        !(branch==="native:classic-note-lock" && object.spawnTime>p.record.timeMs) && end+3<notes[i].hitTime))return;
    } else if(terminal.sequence>=rootInput.sequence)return;
  }
  const rootAttempts=es[0].attempts.filter(a=>a.inputId===rootInput.id);
  if(rootAttempts.length!==1)return;
  const rootAttempt=rootAttempts[0],rootRoutes=es[0].routing.filter(r=>r.attemptId===rootAttempt.id),rootSelection=rootRoutes[0];
  if(rootAttempt.automated || index.resolutionsByAttempt.has(rootAttempt.id) || rootAttempt.attemptOrdinal!==0 ||
    !same(rootAttempt.actionCandidates,rootInput.freshActions) || rootAttempt.knownAction!==rootInput.freshActions[0] ||
    rootRoutes.length!==1 || rootSelection?.kind!=="selection" || rootSelection.componentId!==null || rootSelection.inside!==null ||
    rootSelection.selectionStopped || rootSelection.eligible || !(rootInput.sequence<rootAttempt.sequence && rootAttempt.sequence<rootSelection.sequence) ||
    rootAttempt.timeMs!==rootInput.timeMs || rootSelection.timeMs!==rootInput.timeMs ||
    (index.inputs[begin+1] && index.inputs[begin+1].sequence<rootSelection.sequence) || !add(rootAttempt.id,rootSelection.id))return;
  const links:InitiatingChain["links"]=[],slots:NonNullable<InitiatingChain["rejectedDispatch"]>["slots"]=[];
  for(let k=1;k<es.length;k++) {
    const input=picks[k].record,attempts=es[k].attempts.filter(a=>a.inputId===input.id);
    if(attempts.length!==1)return;
    const attempt=attempts[0],routes=es[k].routing.filter(r=>r.attemptId===attempt.id),selection=routes.find(r=>r.kind==="selection");
    const receiverIndex=notes.findIndex(o=>o.id===selection?.componentId);
    if(receiverIndex<1 || receiverIndex>k || (k===es.length-1 && receiverIndex===k))return;
    const receiver=es[receiverIndex],witnesses=derivePreResolutionRejections(receiver,map,trace).filter(w=>w.inputId===input.id && w.blockerId===notes[0].id);
    if(witnesses.length!==1)return;
    const witness=witnesses[0],policy=index.byId.get(witness.policyId),next=index.inputs[(index.inputPositions.get(input.id)??-1)+1];
    if(attempt.automated || index.resolutionsByAttempt.has(attempt.id) || attempt.attemptOrdinal!==0 ||
      attempt.knownAction!==input.freshActions[0] || !same(attempt.actionCandidates,input.freshActions) || routes.length!==2 ||
      policy?.kind!=="policy" || policy.branch!==branch || (next && next.sequence<policy.sequence) ||
      es[k].terminal!.sequence<=policy.sequence || !add(...witness.eventIds))return;
    links.push({targetId:es[k].targetId,receiverId:receiver.targetId,inputId:input.id,precedingInputId:picks[k-1].record.id,rejectedBy:notes[0].id});
    slots.push({targetId:es[k].targetId,receiverId:receiver.targetId,inputId:input.id,policyId:policy.id,
      targetOffsetMs:input.timeMs-es[k].target!.hitTimeMs,eventIds:[...witness.eventIds]});
  }
  const rootAssociation=derivePrimaryInputEvidence(es[0],map,trace,excluded);
  const comparison=comparePrimaryApproaches(es[0],map,{pressIds:[rootInput.id],contextBoundaryInputIds:picks.slice(1).map(p=>p.record.id),
    inputScopes:rootAssociation.stream?.inputScopes,end:{timeMs:prior.timeMs,sequence:prior.sequence,eventId:prior.id,inclusive:false}});
  const episode=comparison.approaches.episodes[0],selected=comparison.ranking.selected;
  if(!comparison.complete || comparison.approaches.episodes.length!==1 || !selected.length || episode?.status!=="supported" ||
    episode.inputId!==rootInput.id || episode.deadlineArrival || selected.some(c=>c.family==="timing" || !(c.family==="placement" || c.code==="aim-late")))return;
  if(selected.some(c=>c.code==="aim-late") && (!episode.properPass || episode.relation!=="before-pass" ||
    episode.properPass.placementSupport!=="sampled" || !episode.properPass.deepSampled || episode.properPass.leftCensored ||
    episode.properPass.rightCensored || episode.properPass.exitTimeMs>=prior.timeMs))return;
  if(!add(...comparison.approaches.episodes.flatMap(e=>e.eventIds),...selected.flatMap(c=>c.eventIds)))return;
  for(const id of ids) {
    const record=index.byId.get(id)!;
    if(record.kind==="input" && (record.source.origin!=="parsed" || !Number.isSafeInteger(record.source.parsedFrameIndex) ||
      record.source.parsedFrameIndex<0 || record.source.discontinuityBefore?.length || !validActions(record)))return;
    if("componentId" in record && record.componentId!==null)components.add(record.componentId);
    if("parentId" in record)components.add(record.parentId);
  }
  if([...components].some(id=>excluded.has(id)) || trace.failures.some(s=>s.startsWith("dependency-conflict:") &&
    components.has(s.split(":").slice(2).join(":"))))return;
  const earlier=target.inputs.filter(i=>i.inLiveSuccess && !i.postTerminal && planned.has(i.record.id) && i.record.id!==current.id).map(i=>i.record.id);
  return {rootComponentId:notes[0].id,rootInputId:rootInput.id,rootComparison:comparison,causes:selected,
    componentIds:notes.map(n=>n.id),eventIds:[...ids],links,additionalInputIds:earlier,
    additionalInputEvidence:earlier.map(inputId=>{
      const slot=slots.find(s=>s.inputId===inputId);
      return {inputId,kind:"earlier-chain-slot",...(slot?{receiverId:slot.receiverId}:{}),
        eventIds:slot?[...slot.eventIds]:[...new Set([rootInput.id,rootAttempt.id,rootSelection.id,...episode.eventIds,...selected.flatMap(c=>c.eventIds)])]};
    }),basis:"bounded-cadence-and-model-dispatch",rejectedDispatch:{policyVersion:"rejected-placement-v2",phaseMs:phase,slots,
      sourceSpan:{startInputId:span[0].id,endInputId:current.id,frameCount:span.length}}};
}
