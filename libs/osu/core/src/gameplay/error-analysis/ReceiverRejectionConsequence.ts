import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { StableSliderTiming } from "../StableSliderTiming";
import { nativeWithinHitRadius, stableGameplayRadius, stableWithinHitRadius } from "../StableHitGeometry";
import { CircleEvidence, deriveCircleEvidence, derivePreResolutionRejections } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { errorCapabilities } from "./ErrorCapabilities";
import { rejectedInitiatingTraceIndex } from "./InterceptionChain";
import { PrimaryInputEvidence } from "./PrimaryInputEvidence";
import { circleDispatch } from "./BoundedCircleRetiming";
import { derivePreterminalReceiverRejection } from "./PreterminalReceiverRejection";

/** A reconstructed consequence, never a fabricated target policy receipt. */
export interface ReceiverRejectionConsequence {
  policyVersion: "receiver-consequence-v3";
  receiverOutcome: "rejected" | "successful-consumption";
  basis: "distinct-prior-receipt-and-recomputed-target-policy";
  blockerId: string;
  receiverId: string;
  targetId: string;
  priorInputId: string;
  inputId: string;
  priorPolicyId: string;
  receiverPolicyId: string;
  targetPolicy: { actualBlockers: string[]; afterBlockerCorrection: string[]; afterPriorReceiverSuccess: string[] };
  otherInputs: Array<{inputId:string;kind:"later-outside-attempt";eventIds:string[]}>;
  downstreamRejections:Array<{
    inputId:string;receiverId:string;policyId:string;terminalId:string;
    actual:{selectedId:string;state:"rejected";blockerId:string;timingResult:string};
    afterTargetSuccess:{selectedId:string;state:"allowed";blockers:string[];timingResult:string};
  }>;
  sourceSpan: {startInputId:string;endInputId:string;frameCount:number};
  eventIds: string[];
}

/** The earlier receiver must have had its OWN usable rejected action. Then
 * recompute both its repaired policy and the target's complete prefix policy.
 * A successful receipt alone, a missing prior action, or a receiver-only
 * blocker proves nothing about the target. No gameplay is changed. */
export function deriveReceiverRejectionConsequence(
  target:CircleEvidence,association:PrimaryInputEvidence,map:Beatmap,trace:ReplayTrace,
  excluded:ReadonlySet<string>=new Set(),
):ReceiverRejectionConsequence|undefined {
  const classic=trace.identity.analysisProfileId==="lazer"&&!!map.lazerModSettings.classic?.classicNoteLock;
  const caps=errorCapabilities(map,trace.identity.analysisProfileId);
  const complete=(e:CircleEvidence)=>e.status==="supported"&&e.target&&e.geometry&&e.terminal&&
    e.terminal.previousUnresolved&&!e.limits.truncated&&
    Object.values(e.dependencies).every(d=>d.status==="complete")&&!excluded.has(e.targetId);
  const expired=(e:CircleEvidence)=>complete(e)&&e.terminal?.result==="MISS"&&e.terminal.mechanism==="automatic-expiry";
  if((trace.identity.analysisProfileId!=="stable"&&!classic)||trace.identity.schemaVersion!==2||
    caps.aim!=="manual"||caps.tapping!=="manual"||caps.scoring!=="supported"||caps.geometry!=="supported"||
    trace.droppedRecordBoundary!==undefined||trace.records.length>trace.limits.maxRecords||
    JSON.stringify(target.identity)!==JSON.stringify(trace.identity)||!expired(target)||target.directRejections.length||
    association.harmfulSurplus||association.limitations.some(s=>s==="invalid-trace-index"||s==="trace-identity-mismatch")||
    trace.failures.some(s=>s!=="global-totals-mismatch"&&!s.startsWith("dependency-conflict:")))return;
  const stops=association.stoppedDispatchRejections??[];
  const at=map.hitObjects.findIndex(o=>o.id===target.targetId),notes=map.hitObjects.slice(at-2,at+1);
  if(at<2||notes.length!==3||notes.some(o=>!(o instanceof HitCircle)||o.sliderId!==undefined))return;
  const [blocker,receiver,current]=notes as HitCircle[];
  if(notes.some(o=>excluded.has(o.id))||[receiver.hitTime-blocker.hitTime,current.hitTime-receiver.hitTime].some(d=>d<=3||d>200))return;
  const be=deriveCircleEvidence(trace,map,blocker.id),re=deriveCircleEvidence(trace,map,receiver.id);
  if(!expired(be)||!complete(re))return;
  const success=re.terminal!.mechanism==="successful-input"&&re.terminal!.result!=="MISS";
  if(!success&&!expired(re))return;
  const acceptedAttempt=success&&re.attempts.find(a=>a.id===re.terminal!.triggerAttemptId);
  if(success?stops.length!==0:stops.length!==1||stops[0].blockerId!==blocker.id||stops[0].receiverId!==receiver.id)return;
  const inputId=success?acceptedAttempt&&acceptedAttempt.inputId:stops[0].inputId;
  const index=rejectedInitiatingTraceIndex(trace),input=target.inputs.find(i=>i.record.id===inputId);
  if(!input?.inside||!input.inLiveSuccess||input.postTerminal||!input.freshActionsKnown||
    Math.abs(input.record.timeMs-current.hitTime)>target.geometry!.hitWindows[success?2:0])return;
  const receipts=derivePreResolutionRejections(re,map,trace);
  const now=receipts.filter(w=>w.inputId===inputId&&w.blockerId===blocker.id);
  const prior=receipts.filter(w=>w.blockerId===blocker.id&&index.byId.get(w.inputId)!.sequence<input.record.sequence);
  if((success?now.length!==0:now.length!==1)||prior.length!==1)return;
  const earlier=target.inputs.find(i=>i.record.id===prior[0].inputId);
  if(!earlier||earlier.record.timeMs>=input.record.timeMs||input.record.timeMs-earlier.record.timeMs>1600)return;
  const ids=new Set<string>(),components=new Set<string>();
  const add=(...values:string[])=>{for(const id of values){if(!index.byId.has(id))return false;ids.add(id);}return ids.size<=32768;};
  const same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(v=>b.includes(v));
  const valid=(q:typeof input.record)=>[q.actions,q.previousActions,q.freshActions].every(a=>
    new Set(a).size===a.length&&a.every(v=>v===0||v===1))&&same(q.freshActions,q.actions.filter(v=>!q.previousActions.includes(v)))&&
    (q.rawButtonMask===undefined||(Number.isSafeInteger(q.rawButtonMask)&&q.rawButtonMask>=0&&
      same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])])));
  let receiptPolicyId=now[0]?.policyId;
  if(success){
    const q=input.record,attempt=acceptedAttempt||undefined,terminal=re.terminal!,ri=re.inputs.find(i=>i.record.id===q.id);
    const routes=re.routing.filter(r=>r.attemptId===attempt?.id),selection=routes.find(r=>r.kind==="selection"),policy=routes.find(r=>r.kind==="policy");
    const offset=q.timeMs-receiver.hitTime,windows=re.geometry!.hitWindows;
    const grade=Math.abs(offset)<=windows[0]?"GREAT":Math.abs(offset)<=windows[1]?"OK":Math.abs(offset)<=windows[2]?"MEH":undefined;
    if(!ri?.inside||!ri.inLiveSuccess||ri.postTerminal||!ri.freshActionsKnown||q.freshActions.length!==1||
      !attempt||attempt.automated||attempt.attemptOrdinal!==0||!same(attempt.actionCandidates,q.freshActions)||
      (attempt.knownAction!==undefined&&attempt.knownAction!==q.freshActions[0])||re.attempts.filter(a=>a.inputId===q.id).length!==1||routes.length!==2||
      selection?.kind!=="selection"||selection.componentId!==receiver.id||!selection.inside||!selection.eligible||!selection.selectionStopped||
      policy?.kind!=="policy"||policy.state!=="allowed"||policy.componentId!==receiver.id||policy.timingResult!==grade||terminal.result!==grade||
      policy.offsetMs!==offset||policy.branch!==(classic?"native:classic-note-lock":"stable:STABLE")||
      !(q.sequence<attempt.sequence&&attempt.sequence<selection.sequence&&selection.sequence<policy.sequence&&policy.sequence<terminal.sequence&&terminal.sequence<target.terminal!.sequence)||
      [attempt,selection,policy,terminal].some(r=>r.timeMs!==q.timeMs)||!add(q.id,attempt.id,selection.id,policy.id,terminal.id))return;
    receiptPolicyId=policy.id;
  }
  for(const witness of success?[prior[0]]:[prior[0],now[0]]){
    const q=index.byId.get(witness.inputId),attempt=index.byId.get(witness.attemptId),policy=index.byId.get(witness.policyId);
    if(q?.kind!=="input"||q.freshActions.length!==1||attempt?.kind!=="attempt"||attempt.automated||attempt.attemptOrdinal!==0||
      !same(attempt.actionCandidates,q.freshActions)||(attempt.knownAction!==undefined&&attempt.knownAction!==q.freshActions[0])||
      re.attempts.filter(a=>a.inputId===q.id).length!==1||index.resolutionsByAttempt.has(attempt.id)||
      policy?.kind!=="policy"||policy.branch!==(classic?"native:classic-note-lock":"stable:STABLE")||!add(...witness.eventIds))return;
  }
  // Rebuild every earlier parent's live state at the receipt sequence. Stable
  // uses all unresolved parents; Classic uses spawned parents plus stack veto.
  const policyAt=(object:HitCircle,sequence:number,time:number,corrected:ReadonlySet<string>)=>{
    const endAt=map.hitObjects.findIndex(o=>o.id===object.id),alive:typeof map.hitObjects=[];
    for(const prefix of map.hitObjects.slice(0,endAt)){
      const terminal=index.terminals.get(prefix.id),activation=index.activations.get(prefix instanceof Slider?prefix.head.id:prefix.id);
      if(!terminal||excluded.has(prefix.id)||!add(terminal.id))return;
      components.add(prefix.id);
      if(prefix instanceof Slider){components.add(prefix.head.id);if(excluded.has(prefix.head.id))return;}
      if(activation&&!add(activation.id))return;
      if(corrected.has(prefix.id)||terminal.sequence<sequence||(classic&&prefix.spawnTime>time))continue;
      alive.push(prefix);
    }
    const previous=alive[alive.length-1],circle=previous instanceof HitCircle?previous:previous instanceof Slider?previous.head:undefined;
    const blockers=alive.filter(o=>(o instanceof HitCircle?o.hitTime:o instanceof Slider&&!classic?new StableSliderTiming(o).endTime:o.endTime)+3<object.hitTime).map(o=>o.id);
    return {blockers,positiveStack:classic&&!!circle&&circle.stackHeight>0};
  };
  // The actual receiver's receipt cannot stand in for a hypothetical target
  // query. In Classic an equal-time later peer has priority, and a resolved
  // slider head may continue consuming input while its parent stays alive.
  const circles=map.hitObjects.flatMap((o,order)=>o instanceof HitCircle?[{circle:o,order}]:o instanceof Slider?[{circle:o.head,order}]:[])
    .sort((a,b)=>a.circle.hitTime-b.circle.hitTime+(a.circle.hitTime===b.circle.hitTime?(classic?b.order-a.order:a.order-b.order):0));
  const selectorAt=(q:typeof input.record,sequence:number,corrected:ReadonlySet<string>)=>{
    for(const {circle} of circles){
      const parent=circle.sliderId??circle.id;
      if(corrected.has(parent)||circle.spawnTime>q.timeMs)continue;
      const activation=index.activations.get(circle.id),terminal=index.terminals.get(circle.id),parentTerminal=index.terminals.get(parent);
      if(!activation||activation.sequence>=q.sequence||!add(activation.id))return;
      components.add(circle.id);components.add(parent);
      if(terminal&&!add(terminal.id))return;
      if(parentTerminal&&!add(parentTerminal.id))return;
      const parentLive=!!circle.sliderId&&(!parentTerminal||parentTerminal.sequence>=sequence);
      if(terminal&&terminal.sequence<sequence&&!(classic&&parentLive))continue;
      if(circle.sliderId&&!parentLive)continue;
      if(!classic&&q.timeMs>circle.hitTime+target.geometry!.hitWindows[2]+1)continue;
      const inside=classic?nativeWithinHitRadius(circle.position,q.position,Math.fround(circle.radius)):
        stableWithinHitRadius(circle.position,q.position,stableGameplayRadius(circle.radius));
      if(inside)return circle.id;
    }
    return undefined;
  };
  const priorActual=policyAt(receiver,index.byId.get(prior[0].policyId)!.sequence,earlier.record.timeMs,new Set());
  const priorFixed=policyAt(receiver,index.byId.get(prior[0].policyId)!.sequence,earlier.record.timeMs,new Set([blocker.id]));
  const sequence=index.byId.get(receiptPolicyId)!.sequence,time=input.record.timeMs;
  const actual=policyAt(current,sequence,time,new Set()),onlyBlocker=policyAt(current,sequence,time,new Set([blocker.id])),
    fixed=policyAt(current,sequence,time,new Set([blocker.id,receiver.id]));
  if(selectorAt(earlier.record,index.byId.get(prior[0].policyId)!.sequence,new Set([blocker.id]))!==receiver.id||
    selectorAt(input.record,sequence,new Set([blocker.id,receiver.id]))!==current.id)return;
  if(!priorActual||priorActual.positiveStack||priorActual.blockers[0]!==blocker.id||!priorFixed||priorFixed.positiveStack||priorFixed.blockers.length||
    !actual||actual.positiveStack||!onlyBlocker||!fixed||fixed.positiveStack||fixed.blockers.length||
    (success?(actual.blockers.length!==1||actual.blockers[0]!==receiver.id):
      (actual.blockers.length!==2||actual.blockers[0]!==blocker.id||actual.blockers[1]!==receiver.id))||
    onlyBlocker.blockers.length!==1||onlyBlocker.blockers[0]!==receiver.id)return;
  const activation=index.activations.get(current.id);
  if(!activation||activation.sequence>=input.record.sequence||activation.timeMs>time||!add(activation.id,target.terminal!.id))return;
  components.add(current.id);
  // Retain later outside failed attempts. They cannot retroactively invalidate
  // the independently usable earlier opportunity; no absence/ownership claim.
  const otherInputs:ReceiverRejectionConsequence["otherInputs"]=[];
  const downstreamRejections:ReceiverRejectionConsequence["downstreamRejections"]=[];
  let closure=target.terminal!;
  const fresh=target.inputs.filter(i=>!i.postTerminal&&i.record.sequence<target.terminal!.sequence&&i.record.freshActions.length&&
    (i.inLiveSuccess||i.record.timeMs===target.terminal!.timeMs));
  for(const item of fresh){
    if([earlier.record.id,input.record.id].includes(item.record.id))continue;
    if(!item.inLiveSuccess){
      const q=item.record,tail=derivePreterminalReceiverRejection(target,map,trace,q.id,excluded),d=circleDispatch(trace,q),
        child=map.hitObjects[at+1],ce=child instanceof HitCircle&&!child.sliderId?deriveCircleEvidence(trace,map,child.id):undefined;
      if(!success||trace.identity.analysisProfileId!=="stable"||!tail||q.sequence<=input.record.sequence||q.sequence>=target.terminal!.sequence||
        q.timeMs!==target.terminal!.timeMs||q.timeMs<=current.hitTime+target.geometry!.hitWindows[2]+1||!item.freshActionsKnown||q.freshActions.length!==1||
        !(child instanceof HitCircle)||child.sliderId||!ce||!expired(ce)||!ce.geometry||
        child.hitTime-current.hitTime<=3||child.hitTime-current.hitTime>200||downstreamRejections.length||
        d?.selection.componentId!==child.id||d.policy?.state!=="rejected"||d.policy.blockerId!==current.id||d.receipt||
        !["GREAT","OK","MEH"].includes(d.policy.timingResult??"")||d.policy.offsetMs!==q.timeMs-child.hitTime||
        ce.target?.hitTimeMs!==child.hitTime||ce.target.spawnTimeMs!==child.spawnTime||
        ce.geometry.position.x!==child.position.x||ce.geometry.position.y!==child.position.y||
        ce.geometry.radius!==Math.fround(stableGameplayRadius(child.radius))||ce.geometry.hitWindows.length!==target.geometry!.hitWindows.length||
        ce.geometry.hitWindows.some((w,k)=>w!==target.geometry!.hitWindows[k])||
        !stableWithinHitRadius(child.position,q.position,stableGameplayRadius(child.radius)))return;
      const off=q.timeMs-child.hitTime,w=ce.geometry.hitWindows,
        grade=Math.abs(off)<=w[0]?"GREAT":Math.abs(off)<=w[1]?"OK":Math.abs(off)<=w[2]?"MEH":undefined,
        corrected=new Set([blocker.id,receiver.id,current.id]),fixedChild=policyAt(child,d.policy.sequence,q.timeMs,corrected);
      if(!grade||grade!==d.policy.timingResult||selectorAt(q,d.policy.sequence,corrected)!==child.id||
        !fixedChild||fixedChild.positiveStack||fixedChild.blockers.length||ce.terminal!.sequence<=q.sequence||
        !add(...tail.eventIds,...d.eventIds,ce.terminal!.id))return;
      components.add(child.id);closure=ce.terminal!;
      downstreamRejections.push({inputId:q.id,receiverId:child.id,policyId:d.policy.id,terminalId:ce.terminal!.id,
        actual:{selectedId:child.id,state:"rejected",blockerId:current.id,timingResult:grade},
        afterTargetSuccess:{selectedId:child.id,state:"allowed",blockers:[],timingResult:grade}});
      continue;
    }
    const attempts=target.attempts.filter(a=>a.inputId===item.record.id),attempt=attempts[0];
    const routes=target.routing.filter(r=>r.attemptId===attempt?.id),selection=routes[0];
    if(item.record.sequence<=input.record.sequence||item.inside||!item.freshActionsKnown||item.record.freshActions.length!==1||
      attempts.length!==1||!attempt||attempt.automated||attempt.attemptOrdinal!==0||!same(attempt.actionCandidates,item.record.freshActions)||
      (attempt.knownAction!==undefined&&attempt.knownAction!==item.record.freshActions[0])||
      index.resolutionsByAttempt.has(attempt.id)||routes.length!==1||selection?.kind!=="selection"||selection.componentId!==null||
      selection.component!==undefined||selection.inside!==null||selection.selectionStopped||selection.eligible||item.record.sequence>=attempt.sequence||attempt.sequence>=selection.sequence||
      attempt.timeMs!==item.record.timeMs||selection.timeMs!==item.record.timeMs||!add(item.record.id,attempt.id,selection.id))return;
    otherInputs.push({inputId:item.record.id,kind:"later-outside-attempt",eventIds:[item.record.id,attempt.id,selection.id]});
  }
  const closureAfter=index.inputs.findIndex(q=>q.sequence>closure.sequence),
    closureLast=closureAfter<0?index.inputs.length-1:closureAfter-1;
  const begin=index.inputPositions.get(earlier.record.id)??-1,last=Math.max(index.inputPositions.get(input.record.id)??-1,
    ...fresh.map(i=>index.inputPositions.get(i.record.id)??-1),
    ...(success?[closureLast]:[]));
  if(begin<1||last-begin+2>4096||closure.timeMs>trace.domain.endTimeMs)return;
  const span=index.inputs.slice(begin-1,last+1);
  // A later inside sample is a usable independent recovery opportunity, not the continuation
  // of the passage whose usable action was consumed. Keep ordinary comparison.
  let leftPass=false;
  for(let k=0;k<span.length;k++){
    const q=span[k],p=span[k-1];
    if(q.source.origin!=="parsed"||!Number.isSafeInteger(q.source.parsedFrameIndex)||q.source.parsedFrameIndex<0||
      q.source.discontinuityBefore?.length||![q.timeMs,q.position.x,q.position.y].every(Number.isFinite)||!valid(q)||q.timeMs>trace.domain.endTimeMs||
      (q.source.rawTokenIndex!==undefined&&(!Number.isSafeInteger(q.source.rawTokenIndex)||q.source.rawTokenIndex<0)))return;
    if(p&&(p.source.origin!=="parsed"||q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||q.timeMs<p.timeMs||
      (q.timeMs===p.timeMs&&(q.freshActions.length!==0||q.position.x!==p.position.x||q.position.y!==p.position.y))||!same(q.previousActions,p.actions)||
      ((q.source.rawTokenIndex!==undefined||p.source.rawTokenIndex!==undefined)&&(p.source.rawTokenIndex===undefined||q.source.rawTokenIndex!==p.source.rawTokenIndex+1))))return;
    if(k&&q.freshActions.length&&![earlier.record.id,input.record.id,...otherInputs.map(i=>i.inputId),...downstreamRejections.map(i=>i.inputId)].includes(q.id))return;
    if(success&&(otherInputs.length||downstreamRejections.length)&&q.sequence>input.record.sequence&&
      (!downstreamRejections.length||q.sequence<=index.byId.get(downstreamRejections[downstreamRejections.length-1].inputId)!.sequence)){
      const inside=(classic?nativeWithinHitRadius:stableWithinHitRadius)(target.geometry!.position,q.position,target.geometry!.radius);
      if(inside&&leftPass)return;
      if(!inside)leftPass=true;
    }
    if(!add(q.id))return;
  }
  for(const id of ids){const record=index.byId.get(id)!;if("componentId"in record&&record.componentId!==null)components.add(record.componentId);if("parentId"in record)components.add(record.parentId);}
  if([...components].some(id=>excluded.has(id))||trace.failures.some(s=>s.startsWith("dependency-conflict:")&&components.has(s.split(":").slice(2).join(":"))))return;
  return {policyVersion:"receiver-consequence-v3",receiverOutcome:success?"successful-consumption":"rejected",basis:"distinct-prior-receipt-and-recomputed-target-policy",blockerId:blocker.id,
    receiverId:receiver.id,targetId:current.id,priorInputId:earlier.record.id,inputId:input.record.id,priorPolicyId:prior[0].policyId,
    receiverPolicyId:receiptPolicyId,targetPolicy:{actualBlockers:actual.blockers,afterBlockerCorrection:onlyBlocker.blockers,afterPriorReceiverSuccess:fixed.blockers},
    otherInputs,downstreamRejections,sourceSpan:{startInputId:span[0].id,endInputId:span[span.length-1].id,frameCount:span.length},eventIds:[...ids]};
}
