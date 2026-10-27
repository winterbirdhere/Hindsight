import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { StableSliderTiming } from "../StableSliderTiming";
import { CircleEvidence, deriveCircleEvidence, InputRecord } from "../miss-explanation/CircleEvidence";
import { nativeWithinHitRadius, stableWithinHitRadius } from "../StableHitGeometry";
import { ReplayTrace } from "../trace/ReplayTrace";
import { errorCapabilities } from "./ErrorCapabilities";
import { rejectedInitiatingTraceIndex } from "./InterceptionChain";
import { comparePrimaryApproaches } from "./PrimaryApproachComparison";

const same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(x=>b.includes(x));
/** A bounded continuation from actual receipts. This is diagnostic alignment,
 * not engine ownership, intent, or a replacement for spatial stream evidence. */
export function deriveAnchoredTimingDrift(target:CircleEvidence,map:Beatmap,trace:ReplayTrace,excluded:ReadonlySet<string>=new Set()) {
  const caps=errorCapabilities(map,trace.identity.analysisProfileId),classic=trace.identity.analysisProfileId==="lazer"&&!!map.lazerModSettings.classic?.classicNoteLock;
  if(!target.target||!target.geometry||target.terminal?.result!=="MISS"||target.terminal.mechanism!=="automatic-expiry"||
    !target.terminal.previousUnresolved||target.directRejections.length||caps.aim!=="manual"||caps.tapping!=="manual"||caps.geometry!=="supported"||caps.scoring!=="supported"||
    (trace.identity.analysisProfileId!=="stable"&&!classic)||trace.identity.schemaVersion!==2||
    JSON.stringify(target.identity)!==JSON.stringify(trace.identity)||trace.droppedRecordBoundary!==undefined||trace.records.length>trace.limits.maxRecords||
    trace.failures.some(s=>s!=="global-totals-mismatch"&&!s.startsWith("dependency-conflict:")))return;
  const at=map.hitObjects.findIndex(o=>o.id===target.targetId),index=rejectedInitiatingTraceIndex(trace);
  if(at<4)return;
  const complete=(e:CircleEvidence)=>(e.status==="supported"||e.status==="not-missed")&&e.geometry&&e.target&&e.terminal?.previousUnresolved&&!e.limits.truncated&&
    Object.values(e.dependencies).every(d=>d.status==="complete");
  // Find the most recent three consecutive near-beat successful receipts.
  // Timing chooses the context before any geometry is inspected; never search
  // past a failed proof for a more convenient geometric window.
  const first=Math.max(0,at-11),objects=map.hitObjects.slice(first,at+1);
  if(!(objects[objects.length-1] instanceof HitCircle))return;
  const all=objects.map(o=>o instanceof HitCircle&&!o.sliderId?deriveCircleEvidence(trace,map,o.id):undefined);
  const anchor=(e:CircleEvidence|undefined)=>e&&complete(e)&&e.terminal!.mechanism==="successful-input"&&e.terminal!.result==="GREAT";
  let last=-1;
  for(let k=all.length-3;k>=2;k--)if(all.slice(k-2,k+1).every(anchor)){last=k;break;}
  if(last<2)return;
  const notes=objects.slice(last-2) as HitCircle[],evidence=all.slice(last-2);
  if(notes.length<5||notes.some(o=>!(o instanceof HitCircle)||o.sliderId)||evidence.some(e=>!e||!complete(e)))return;
  const es=evidence as CircleEvidence[],components=new Set(notes.map(o=>o.id));
  if([...components].some(id=>excluded.has(id))||[...trace.failures,...trace.domain.sourceCoverageLimits].some(s=>
    s.startsWith("dependency-conflict:")&&components.has(s.split(":").slice(2).join(":"))))return;
  const intervals=notes.slice(1).map((o,k)=>o.hitTime-notes[k].hitTime),spacing=Math.max(...intervals);
  if(Math.min(...intervals)<=3||spacing>200||spacing/Math.min(...intervals)>1.1||notes[notes.length-1].hitTime-notes[0].hitTime>1600)return;
  const anchorAttempt=es[0].attempts.find(a=>a.id===es[0].terminal!.triggerAttemptId),begin=index.inputPositions.get(anchorAttempt?.inputId??"");
  const end=index.inputs.findIndex(q=>q.sequence>target.terminal!.sequence);
  if(begin===undefined||begin<1||end<begin||end-begin>4096)return;
  const start=Math.min(begin-1,index.inputs.findIndex(q=>q.timeMs>=notes[0].hitTime)-1);
  if(start<0||end-start>4096)return;
  const inputs=index.inputs.slice(start,end+1),fresh=inputs.filter(q=>q.sequence>=index.inputs[begin].sequence&&q.sequence<target.terminal!.sequence&&q.freshActions.length);
  if(fresh.length!==notes.length||fresh.some(q=>q.freshActions.length!==1))return;
  const refs=new Set<string>();
  for(let k=0;k<inputs.length;k++){
    const q=inputs[k],p=inputs[k-1];
    if(q.source.origin!=="parsed"||!Number.isSafeInteger(q.source.parsedFrameIndex)||q.source.parsedFrameIndex<0||q.source.discontinuityBefore?.length||
      ![q.timeMs,q.position.x,q.position.y].every(Number.isFinite)||q.timeMs>trace.domain.endTimeMs||
      (q.source.rawTokenIndex!==undefined&&(!Number.isSafeInteger(q.source.rawTokenIndex)||q.source.rawTokenIndex<0))||
      [q.actions,q.previousActions,q.freshActions].some(a=>new Set(a).size!==a.length||a.some(v=>v!==0&&v!==1))||
      !same(q.freshActions,q.actions.filter(a=>!q.previousActions.includes(a)))||
      (q.rawButtonMask!==undefined&&(!Number.isSafeInteger(q.rawButtonMask)||q.rawButtonMask<0||!same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])]))))return;
    if(p&&(p.source.origin!=="parsed"||q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||q.timeMs<p.timeMs||q.timeMs-p.timeMs>spacing*.5||
      !same(q.previousActions,p.actions)||((q.source.rawTokenIndex!==undefined||p.source.rawTokenIndex!==undefined)&&
      (p.source.rawTokenIndex===undefined||q.source.rawTokenIndex!==p.source.rawTokenIndex+1))))return;
    refs.add(q.id);
  }
  const offsets=fresh.map((q,k)=>q.timeMs-notes[k].hitTime),increments=offsets.slice(1).map((v,k)=>v-offsets[k]),best=target.geometry.hitWindows[0];
  if(offsets.slice(0,3).some((v,k)=>Math.abs(v)>es[k].geometry!.hitWindows[0])||offsets.some(v=>Math.abs(v)>=spacing*.75)||
    offsets[offsets.length-1]<=best||offsets[offsets.length-1]-offsets[0]<=best||
    increments.some(v=>v< -2||v>spacing*.25)||increments.filter(v=>v>2).length<3)return;
  const rows:Array<{componentId:string;inputId:string;nominalTimeMs:number;pressTimeMs:number;offsetMs:number;basis:string;actualReceiverId:string|null;nominalInside:boolean}>=[];
  for(let k=0;k<notes.length;k++){
    const e=es[k],q=fresh[k],g=e.geometry!,terminal=e.terminal!,attempts=e.attempts.filter(a=>a.inputId===q.id),attempt=attempts[0];
    const routes=e.routing.filter(r=>r.attemptId===attempt?.id),selection=routes.find(r=>r.kind==="selection"),policy=routes.find(r=>r.kind==="policy");
    if(attempts.length!==1||!attempt||attempt.automated||attempt.attemptOrdinal!==0||!same(attempt.actionCandidates,q.freshActions)||
      (attempt.knownAction!==undefined&&attempt.knownAction!==q.freshActions[0])||selection?.kind!=="selection"||
      !(q.sequence<attempt.sequence&&attempt.sequence<selection.sequence)||attempt.timeMs!==q.timeMs||selection.timeMs!==q.timeMs)return;
    const receipt=index.resolutionsByAttempt.get(attempt.id);
    if(k<3||receipt){
      const offset=offsets[k],grade=Math.abs(offset)<=g.hitWindows[0]?"GREAT":Math.abs(offset)<=g.hitWindows[1]?"OK":Math.abs(offset)<=g.hitWindows[2]?"MEH":undefined;
      const actual=e.inputs.find(i=>i.record.id===q.id);
      if(!actual?.inside||!actual.inLiveSuccess||actual.postTerminal||!actual.freshActionsKnown||
        receipt?.kind!=="resolution"||receipt.component!=="circle"||receipt.componentId!==notes[k].id||receipt.id!==terminal.id||receipt.mechanism!=="successful-input"||
        receipt.result!==grade||routes.length!==2||!selection.inside||!selection.eligible||!selection.selectionStopped||selection.componentId!==notes[k].id||
        selection.component!=="circle"||policy?.kind!=="policy"||policy.state!=="allowed"||policy.blockerId!==undefined||policy.componentId!==notes[k].id||policy.timingResult!==grade||policy.offsetMs!==offset||
        policy.branch!==(classic?"native:classic-note-lock":"stable:STABLE")||
        !(selection.sequence<policy.sequence&&policy.sequence<receipt.sequence)||policy.timeMs!==q.timeMs||receipt.timeMs!==q.timeMs)return;
      refs.add(receipt.id);
    }else if(selection.componentId!==null){
      // Retain failed/rejected dispatch, including a later geometric receiver.
      // It must be complete, but is never represented as the aligned receipt.
      if(routes.length!==2||policy?.kind!=="policy"||policy.componentId!==selection.componentId||!selection.inside||!selection.eligible||!selection.selectionStopped||
        policy.state!=="rejected"||policy.sequence<=selection.sequence||policy.timeMs!==q.timeMs)return;
      const receiver=map.getHitObject(selection.componentId);
      if(!(receiver instanceof HitCircle)||receiver.sliderId||selection.component!=="circle"||
        policy.branch!==(classic?"native:classic-note-lock":"stable:STABLE"))return;
      const re=deriveCircleEvidence(trace,map,receiver.id),rg=re.geometry;
      if(!rg||!complete(re)||!(classic?nativeWithinHitRadius:stableWithinHitRadius)(rg.position,q.position,rg.radius))return;
      const off=q.timeMs-receiver.hitTime,abs=Math.abs(off),grade=abs<=rg.hitWindows[0]?"GREAT":abs<=rg.hitWindows[1]?"OK":abs<=rg.hitWindows[2]?"MEH":abs<=rg.hitWindows[3]?"MISS":undefined;
      if(policy.offsetMs!==off||policy.timingResult!==grade)return;
      const receiverAt=map.hitObjects.findIndex(o=>o.id===receiver.id);
      if(receiverAt<0||receiverAt>4096)return;
      const alive:typeof map.hitObjects=[];
      for(const parent of map.hitObjects.slice(0,receiverAt)){
        const end=index.terminals.get(parent.id);
        if(!end)return;
        components.add(parent.id);refs.add(end.id);
        if(parent instanceof Slider)components.add(parent.head.id);
        if(end.sequence>=policy.sequence&&(!classic||parent.spawnTime<=q.timeMs))alive.push(parent);
      }
      const lastAlive=alive[alive.length-1],lastCircle=lastAlive instanceof HitCircle?lastAlive:lastAlive instanceof Slider?lastAlive.head:undefined;
      const blockers=alive.filter(o=>(o instanceof HitCircle?o.hitTime:o instanceof Slider&&!classic?new StableSliderTiming(o).endTime:o.endTime)+3<receiver.hitTime);
      if(classic&&lastCircle&&lastCircle.stackHeight>0||!blockers.length||blockers[0].id!==policy.blockerId)return;
      components.add(receiver.id);components.add(policy.blockerId!);
    }else if(routes.length!==1||selection.component!==undefined||selection.selectionStopped||selection.inside!==null||selection.eligible)return;
    const activation=index.activations.get(notes[k].id);
    if(activation?.kind!=="lifecycle"||activation.component!=="circle"||activation.transition!=="activated"||activation.sequence>=q.sequence||q.sequence>=terminal.sequence)return;
    refs.add(activation.id);refs.add(terminal.id);refs.add(attempt.id);routes.forEach(r=>refs.add(r.id));
    const nominal=notes[k].hitTime,right=inputs.findIndex(i=>i.timeMs>=nominal),b=inputs[right],a=inputs[right-1];
    const point=(i:InputRecord)=>({x:Math.fround(i.position.x),y:Math.fround(i.position.y)});
    const exact=inputs.filter(i=>i.timeMs===nominal),positions=exact.map(point);
    if(!exact.length&&a&&b&&b.timeMs>a.timeMs){const p=point(a),r=point(b),f=(nominal-a.timeMs)/(b.timeMs-a.timeMs);positions.push({x:p.x+(r.x-p.x)*f,y:p.y+(r.y-p.y)*f});}
    if(!positions.length||!positions.every(p=>(classic?nativeWithinHitRadius:stableWithinHitRadius)(g.position,p,g.radius)))return;
    rows.push({componentId:notes[k].id,inputId:q.id,nominalTimeMs:nominal,pressTimeMs:q.timeMs,offsetMs:offsets[k],
      basis:k<3?"observed-successful-anchor":"rhythmic-continuation",actualReceiverId:selection.componentId,nominalInside:true});
  }
  if([...components].some(id=>excluded.has(id))||[...trace.failures,...trace.domain.sourceCoverageLimits].some(s=>s.startsWith("dependency-conflict:")&&components.has(s.split(":").slice(2).join(":"))))return;
  const press=fresh[fresh.length-1],comparison=comparePrimaryApproaches(target,map,{pressIds:[press.id],contextBoundaryInputIds:fresh.slice(0,-1).map(q=>q.id)});
  const episode=comparison.approaches.episodes[0];
  if(!comparison.complete||comparison.ranking.selected.length!==1||comparison.ranking.selected[0].code!=="late-tap"||
    episode?.placement!=="proper-pass"||!episode.properPass||episode.properPass.leftCensored||episode.properPass.rightCensored||
    episode.spatialCandidates.length||episode.properPass.entryTimeMs>target.target.hitTimeMs||episode.properPass.exitTimeMs<target.target.hitTimeMs||
    press.timeMs<=episode.properPass.exitTimeMs)return;
  comparison.ranking.comparisonEventIds.forEach(id=>refs.add(id));
  return {policyVersion:"anchored-timing-drift-v1",basis:"successful-anchors-and-complete-rhythmic-continuation",rows,
    accumulatedLagMs:offsets[offsets.length-1]-offsets[0],scheduledIntervalsMs:intervals,
    sourceSpan:{startInputId:inputs[0].id,endInputId:inputs[inputs.length-1].id,frameCount:inputs.length},comparison,eventIds:[...refs]};
}
