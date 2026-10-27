import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { CircleEvidence, deriveCircleEvidence, InputRecord } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { completeCircle, observedCircleReceipt } from "./BoundedCircleRetiming";
import { receptorPacket } from "./BoundedReceptorRetiming";
import { rejectedInitiatingTraceIndex } from "./InterceptionChain";


/** Observed preceding receipts establish drift independently of a later control. */
export function derivePrecedingLateCadence(target:CircleEvidence,map:Beatmap,trace:ReplayTrace,excluded:ReadonlySet<string>=new Set()){
 if(trace.identity.analysisProfileId!=="stable"||!completeCircle(target)||target.directRejections.length||
  target.terminal?.mechanism!=="automatic-expiry"||target.terminal.result!=="MISS"||JSON.stringify(target.identity)!==JSON.stringify(trace.identity))return;
 const at=map.hitObjects.findIndex(o=>o.id===target.targetId),object=map.hitObjects[at],ix=rejectedInitiatingTraceIndex(trace);
 if(at<5||!(object instanceof HitCircle)||object.sliderId)return;
 let anchors:Array<{e:CircleEvidence;receipt:NonNullable<ReturnType<typeof observedCircleReceipt>>}>=[];
 for(let k=at-1;k>=Math.max(0,at-8);k--){const o=map.hitObjects[k];if(!(o instanceof HitCircle)||o.sliderId)break;
  const e=deriveCircleEvidence(trace,map,o.id),receipt=observedCircleReceipt(e,map,trace);if(!receipt)break;anchors.unshift({e,receipt});}
 let reset=-1;anchors.forEach((a,k)=>{if(a.receipt.input.timeMs-a.e.target!.hitTimeMs<=0)reset=k;});
 anchors=anchors.slice(reset+1);if(anchors.length<5)return;
 const last=anchors[anchors.length-1],lastAt=ix.inputPositions.get(last.receipt.input.id)!,following=ix.inputs.slice(lastAt+1).find(q=>q.freshActions.length);
 if(!following||following.sequence<target.terminal.sequence||following.freshActions.length!==1)return;
 const notes=[...anchors.map(a=>a.e),target],scheduled=notes.map(e=>e.target!.hitTimeMs),
  times=[...anchors.map(a=>a.receipt.input.timeMs),following.timeMs],offsets=times.map((t,k)=>t-scheduled[k]),
  intervals=scheduled.slice(1).map((t,k)=>t-scheduled[k]),spacing=Math.max(...intervals),best=target.geometry!.hitWindows[0],
  anchorScheduled=scheduled.slice(0,-1),anchorOffsets=offsets.slice(0,-1),
  meanX=anchorScheduled.reduce((a,b)=>a+b,0)/anchorScheduled.length,meanY=anchorOffsets.reduce((a,b)=>a+b,0)/anchorOffsets.length,
  slope=anchorScheduled.reduce((s,x,k)=>s+(x-meanX)*(anchorOffsets[k]-meanY),0)/anchorScheduled.reduce((s,x)=>s+(x-meanX)**2,0),
  residual=Math.max(...anchorScheduled.map((x,k)=>Math.abs(anchorOffsets[k]-(meanY+slope*(x-meanX))))),
  predictedTargetOffsetMs=meanY+slope*(target.target!.hitTimeMs-meanX);
 // Actual one-to-one successful receipts, a growing fitted lag and a low
 // residual establish the phase; a single noisy interval is not a phase reset.
 // The following packet may be an independent successful head recovery. It
 // cannot establish the preceding drift merely because shifting it repairs us.
 if(Math.min(...intervals)<=3||spacing>200||spacing/Math.min(...intervals)>1.1||scheduled[scheduled.length-1]-scheduled[0]>1600||
  offsets.some(v=>v<0)||offsets[offsets.length-1]<=target.geometry!.hitWindows[2]||predictedTargetOffsetMs-anchorOffsets[0]<best||
  !Number.isFinite(predictedTargetOffsetMs)||predictedTargetOffsetMs<=target.geometry!.hitWindows[2]||
  predictedTargetOffsetMs>=target.geometry!.hitWindows[2]+spacing||
  offsets[offsets.length-1]>=target.geometry!.hitWindows[2]+spacing||times.slice(1).some((t,k)=>t<=times[k])||
  slope<.04||residual>Math.min(best,spacing*.2))return;
 const firstAt=ix.inputPositions.get(anchors[0].receipt.input.id)!,followingAt=ix.inputPositions.get(following.id)!,
  context=ix.inputs.slice(firstAt-1,followingAt+1),contextIds=new Set([...anchors.map(a=>a.receipt.input.id),following.id]);
 if(firstAt<1||context.length>4096||context.slice(1).filter(q=>q.freshActions.length).some(q=>!contextIds.has(q.id))||
  [...anchors.map(a=>a.receipt.input),following].some(q=>q.freshActions.length!==1))return;
 for(const e of notes)if(!e.inputs.some(i=>i.inside&&i.inLiveSuccess&&!i.postTerminal&&
  Math.abs(i.record.timeMs-e.target!.hitTimeMs)<=e.geometry!.hitWindows[0]&&
  Math.hypot(i.record.position.x-e.geometry!.position.x,i.record.position.y-e.geometry!.position.y)<=e.geometry!.radius*.95))return;
 const first=ix.inputPositions.get(context[0].id)!,end=ix.inputPositions.get(context[context.length-1].id)!,
  actualSame=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(v=>b.includes(v));
 for(let k=first;k<=end;k++){
  const q=ix.inputs[k],p=ix.inputs[k-1];
  if(q.source.origin!=="parsed"||q.source.discontinuityBefore?.length||!Number.isSafeInteger(q.source.parsedFrameIndex)||q.source.parsedFrameIndex<0||
   ![q.timeMs,q.position.x,q.position.y].every(Number.isFinite)||q.timeMs>trace.domain.endTimeMs||
   [q.actions,q.previousActions,q.freshActions].some(a=>new Set(a).size!==a.length||a.some(v=>v!==0&&v!==1))||
   !actualSame(q.freshActions,q.actions.filter(a=>!q.previousActions.includes(a)))||
   q.source.rawTokenIndex!==undefined&&(!Number.isSafeInteger(q.source.rawTokenIndex)||q.source.rawTokenIndex<0)||
   q.rawButtonMask!==undefined&&(!Number.isSafeInteger(q.rawButtonMask)||q.rawButtonMask<0||q.rawButtonMask>31||
    !actualSame(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])]))||
   p&&(p.source.origin!=="parsed"||q.timeMs<=p.timeMs||q.timeMs-p.timeMs>spacing*.5||q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||
    !actualSame(q.previousActions,p.actions)||(q.source.rawTokenIndex!==undefined||p.source.rawTokenIndex!==undefined)&&
     (q.source.rawTokenIndex===undefined||p.source.rawTokenIndex===undefined||q.source.rawTokenIndex!==p.source.rawTokenIndex+1)))return;
 }
 if(notes.some(e=>excluded.has(e.targetId)||[...trace.failures,...trace.domain.sourceCoverageLimits]
  .some(s=>s.startsWith("dependency-conflict:")&&s.endsWith(":"+e.targetId))))return;
 return {at,ix,anchors,last,following,notes,offsets,intervals,spacing,slope,residual,predictedTargetOffsetMs,context};
}
