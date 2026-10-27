import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { CircleEvidence, deriveCircleEvidence } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { certifyCircleRetiming, circleDispatch, completeCircle, observedCircleReceipt } from "./BoundedCircleRetiming";
import { rejectedInitiatingTraceIndex } from "./InterceptionChain";

/** Late receipts can drift across an expiry into the next receiver. Keep that
 * observed receiver distinct from rhythmic alignment, and require a complete
 * multi-pulse control that preserves every successful related note. */
export function deriveLateSequenceContinuation(target:CircleEvidence,map:Beatmap,trace:ReplayTrace,excluded:ReadonlySet<string>=new Set()){
  if(trace.identity.analysisProfileId!=="stable"||!completeCircle(target)||target.directRejections.length||
    target.terminal?.mechanism!=="automatic-expiry"||target.terminal.result!=="MISS"||JSON.stringify(target.identity)!==JSON.stringify(trace.identity))return;
  const at=map.hitObjects.findIndex(o=>o.id===target.targetId),index=rejectedInitiatingTraceIndex(trace),object=map.hitObjects[at];
  if(at<5||!(object instanceof HitCircle)||object.sliderId)return;
  const anchors:Array<{e:CircleEvidence;receipt:NonNullable<ReturnType<typeof observedCircleReceipt>>}>=[];
  for(let k=at-1;k>=Math.max(0,at-8);k--){
    const o=map.hitObjects[k];if(!(o instanceof HitCircle)||o.sliderId)break;
    const e=deriveCircleEvidence(trace,map,o.id),receipt=observedCircleReceipt(e,map,trace);if(!receipt)break;
    anchors.unshift({e,receipt});
  }
  if(anchors.length<5)return;
  const last=anchors[anchors.length-1],lastAt=index.inputPositions.get(last.receipt.input.id)!,
    firstAt=index.inputPositions.get(anchors[0].receipt.input.id)!,following=index.inputs.slice(lastAt+1).find(q=>q.freshActions.length);
  if(!following||following.sequence<target.terminal.sequence||following.freshActions.length!==1)return;
  const notes=[...anchors.map(a=>a.e),target],scheduled=notes.map(e=>e.target!.hitTimeMs),times=[...anchors.map(a=>a.receipt.input.timeMs),following.timeMs],
    offsets=times.map((t,k)=>t-scheduled[k]),intervals=scheduled.slice(1).map((t,k)=>t-scheduled[k]),spacing=Math.max(...intervals),best=target.geometry!.hitWindows[0];
  if(Math.min(...intervals)<=3||spacing>200||spacing/Math.min(...intervals)>1.1||scheduled[scheduled.length-1]-scheduled[0]>1600||
    offsets.some(v=>v<0)||offsets[offsets.length-1]-offsets[0]<best||offsets[offsets.length-1]<=target.geometry!.hitWindows[2]||
    offsets.slice(1).some((v,k)=>v-offsets[k]<-spacing*.2||v-offsets[k]>spacing*.4))return;
  const meanX=scheduled.reduce((a,b)=>a+b,0)/scheduled.length,meanY=offsets.reduce((a,b)=>a+b,0)/offsets.length,
    slope=scheduled.reduce((s,x,k)=>s+(x-meanX)*(offsets[k]-meanY),0)/scheduled.reduce((s,x)=>s+(x-meanX)**2,0),
    residual=Math.max(...scheduled.map((x,k)=>Math.abs(offsets[k]-(meanY+slope*(x-meanX)))));
  if(slope<.04||slope>.3||residual>spacing*.2||times.slice(1).some((t,k)=>t-times[k]<spacing*.6||t-times[k]>spacing*1.4))return;
  const followingAt=index.inputPositions.get(following.id)!,source=index.inputs.slice(firstAt-1,followingAt+1),
    anchorIds=new Set([...anchors.map(a=>a.receipt.input.id),following.id]);
  if(source.slice(1).filter(q=>q.freshActions.length).some(q=>!anchorIds.has(q.id))||source.length>4096||
    source.some((q,k)=>{const p=source[k-1],same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(v=>b.includes(v));
      return q.source.origin!=="parsed"||q.source.discontinuityBefore?.length||!Number.isSafeInteger(q.source.parsedFrameIndex)||q.source.parsedFrameIndex<0||
        ![q.timeMs,q.position.x,q.position.y].every(Number.isFinite)||q.timeMs>trace.domain.endTimeMs||
        [q.actions,q.previousActions,q.freshActions].some(a=>new Set(a).size!==a.length||a.some(v=>v!==0&&v!==1))||
        !same(q.freshActions,q.actions.filter(a=>!q.previousActions.includes(a)))||
        q.source.rawTokenIndex!==undefined&&(!Number.isSafeInteger(q.source.rawTokenIndex)||q.source.rawTokenIndex<0)||
        q.rawButtonMask!==undefined&&(!Number.isSafeInteger(q.rawButtonMask)||q.rawButtonMask<0||q.rawButtonMask>31||!same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])]))||
        p&&(p.source.origin!=="parsed"||q.timeMs<=p.timeMs||q.timeMs-p.timeMs>spacing*.5||q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||!same(q.previousActions,p.actions)||
          (q.source.rawTokenIndex!==undefined||p.source.rawTokenIndex!==undefined)&&(q.source.rawTokenIndex===undefined||p.source.rawTokenIndex===undefined||q.source.rawTokenIndex!==p.source.rawTokenIndex+1));})||
    [...anchors.map(a=>a.receipt.input),following].some((q,k,a)=>q.freshActions.length!==1||k>0&&q.freshActions[0]===a[k-1].freshActions[0]))return;
  // A measurable inside best-window sample on every note supports timing;
  // a new late arrival, missing geometry, or a separate phase remains outside
  // this sufficient family. Exact nominal interpolation is not required.
  for(const e of notes)if(!e.inputs.some(i=>i.inside&&i.inLiveSuccess&&!i.postTerminal&&
    Math.abs(i.record.timeMs-e.target!.hitTimeMs)<=e.geometry!.hitWindows[0]&&
    Math.hypot(i.record.position.x-e.geometry!.position.x,i.record.position.y-e.geometry!.position.y)<=e.geometry!.radius*.95))return;
  const related=[target],pulses=[following];let closed=false;
  for(let j=0;j<12;j++){
    const q=pulses[j],d=circleDispatch(trace,q);if(!d)return;
    if(!d.receipt){closed=j>0;break;}
    const next=map.hitObjects[at+j+1];if(!(next instanceof HitCircle)||next.sliderId||d.receipt.kind!=="resolution"||d.receipt.componentId!==next.id)return;
    const e=deriveCircleEvidence(trace,map,next.id),receipt=observedCircleReceipt(e,map,trace);if(!receipt||receipt.input.id!==q.id)return;
    if(next.hitTime-related[related.length-1].target!.hitTimeMs>spacing*1.1||next.hitTime-related[related.length-1].target!.hitTimeMs<spacing/1.1)return;
    related.push(e);
    const k=index.inputPositions.get(q.id)!,fresh=index.inputs.slice(k+1).find(i=>i.freshActions.length);
    if(!fresh||fresh.freshActions.length!==1||fresh.freshActions[0]===q.freshActions[0]||fresh.timeMs-q.timeMs>spacing*1.4||fresh.timeMs-q.timeMs<spacing*.6)return;
    pulses.push(fresh);
  }
  if(!closed||related.length!==pulses.length||related.length>12)return;
  let previous=lastAt;
  const plan:Parameters<typeof certifyCircleRetiming>[2][number][]=[];
  for(let k=0;k<related.length;k++){
    const e=related[k],q=pulses[k],originalGrade=e.terminal!.result,limit=originalGrade==="GREAT"?e.geometry!.hitWindows[0]:originalGrade==="OK"?e.geometry!.hitWindows[1]:e.geometry!.hitWindows[2],
      candidates=e.inputs.filter(i=>i.inside&&i.inLiveSuccess&&!i.postTerminal&&i.record.sequence>last.receipt.receipt!.sequence&&
        index.inputPositions.get(i.record.id)!>previous+1&&i.record.timeMs<q.timeMs&&Math.abs(i.record.timeMs-e.target!.hitTimeMs)<limit)
        .sort((a,b)=>Math.abs(a.record.timeMs-e.target!.hitTimeMs)-Math.abs(b.record.timeMs-e.target!.hitTimeMs)||a.record.sequence-b.record.sequence),sample=candidates[0];
    if(!sample)return;
    plan.push({componentId:e.targetId,inputId:q.id,sampleId:sample.record.id});previous=index.inputPositions.get(sample.record.id)!;
  }
  const correction=certifyCircleRetiming(map,trace,plan,excluded);if(!correction)return;
  const components=new Set(notes.map(e=>e.targetId));
  if([...components].some(id=>excluded.has(id)||[...trace.failures,...trace.domain.sourceCoverageLimits].some(s=>s.startsWith("dependency-conflict:")&&s.endsWith(":"+id))))return;
  return {basis:"observed-late-receipts-and-bounded-continuation",anchors:anchors.map((a,k)=>({componentId:a.e.targetId,inputId:a.receipt.input.id,offsetMs:offsets[k],receiptId:a.receipt.receipt!.id})),
    alignedInputId:following.id,actualReceiverId:circleDispatch(trace,following)!.selection.componentId,targetOffsetMs:offsets[offsets.length-1],
    scheduledIntervalsMs:intervals,slope,maxResidualMs:residual,correction,
    eventIds:[...new Set([...anchors.flatMap(a=>a.receipt.eventIds),...source.map(q=>q.id),...correction.eventIds])]};
}
