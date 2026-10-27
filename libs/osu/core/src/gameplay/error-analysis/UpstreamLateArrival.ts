import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { CircleEvidence, deriveCircleEvidence } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { circleDispatch, completeCircle, observedCircleReceipt } from "./BoundedCircleRetiming";
import { certifyCanonicalControl } from "./CanonicalReplayVerifier";
import { comparePrimaryApproaches } from "./PrimaryApproachComparison";

/** A measured earlier arrival can leave a successfully consumed input missing
 * from the next note. The receipt stays observed; only its consequences are
 * reconstructed. Consumption itself names neither omission nor Notelock. */
export function deriveUpstreamLateArrival(target:CircleEvidence,map:Beatmap,trace:ReplayTrace,excluded:ReadonlySet<string>=new Set()) {
 if(trace.identity.analysisProfileId!=="stable"||!completeCircle(target)||target.directRejections.length||
  target.terminal?.mechanism!=="automatic-expiry"||target.terminal.result!=="MISS")return;
 const at=map.hitObjects.findIndex(o=>o.id===target.targetId),object=map.hitObjects[at],prior=map.hitObjects[at-1];
 if(!(object instanceof HitCircle)||object.sliderId||!(prior instanceof HitCircle)||prior.sliderId||
  object.hitTime-prior.hitTime<=3||object.hitTime-prior.hitTime>200||excluded.has(prior.id))return;
 const root=deriveCircleEvidence(trace,map,prior.id),receipt=observedCircleReceipt(root,map,trace);if(!receipt)return;
 const q=receipt.input,opportunity=target.inputs.find(i=>i.record.id===q.id);
 if(!opportunity?.inside||!opportunity.inLiveSuccess||opportunity.postTerminal||
  target.inputs.some(i=>i.inLiveSuccess&&!i.postTerminal&&i.record.sequence>q.sequence&&i.record.freshActions.length))return;
 const fresh=root.inputs.filter(i=>i.inLiveSuccess&&!i.postTerminal&&i.record.sequence<q.sequence&&i.record.freshActions.length);
 let boundary=-1;
 for(let k=0;k<fresh.length;k++){
  const dispatch=circleDispatch(trace,fresh[k].record);if(!dispatch)return;
  if(dispatch.receipt?.kind==="resolution"&&dispatch.receipt.result!=="MISS")boundary=k;
  else if(dispatch.selection.componentId!==null)return;
 }
 const failed=fresh.slice(boundary+1);
 if(failed.length<2||failed.length>4||failed.some(i=>i.inside||!i.freshActionsKnown||i.record.freshActions.length!==1||
  circleDispatch(trace,i.record)?.selection.componentId!==null))return;
 const inputIds=failed.map(i=>i.record.id),comparison=comparePrimaryApproaches(root,map,{pressIds:inputIds,
  contextBoundaryInputIds:root.inputs.filter(i=>i.record.freshActions.length&&!inputIds.includes(i.record.id)&&i.record.sequence<q.sequence).map(i=>i.record.id),
  end:{timeMs:q.timeMs,sequence:q.sequence,inclusive:false}},trace,excluded),selected=comparison.ranking.selected;
 if(!comparison.complete||selected.length!==1||selected[0].code!=="aim-late"||selected[0].independent)return;
 const entries=comparison.approaches.episodes.map(ep=>ep.contacts.filter(c=>c.exitTimeMs>prior.hitTime-root.geometry!.hitWindows[2]&&c.entryTimeMs<q.timeMs));
 if(entries.some(a=>a.length!==1)||new Set(entries.map(a=>a[0].entryTimeMs)).size!==1||entries.some(a=>a[0].leftCensored))return;
 const entry=entries[0][0].entryTimeMs,best=root.geometry!.hitWindows[0];
 if(entry<=prior.hitTime+best||failed.some(i=>i.record.timeMs>=entry)||
  !failed.some(i=>i.record.timeMs<prior.hitTime)||!failed.some(i=>i.record.timeMs>prior.hitTime))return;
 // Timing-only movement into the best window cannot repair this earlier
 // approach: every canonical source chord across that window remains outside.
 const lo=prior.hitTime-best,hi=prior.hitTime+best,points=root.inputs.filter(i=>i.record.timeMs<=hi),
  end=root.inputs.find(i=>i.record.timeMs>hi);
 if(!end||!points.length)return;points.push(end);
 let covered=lo,minimumR=Infinity;const R=root.geometry!.radius,c=root.geometry!.position;
 for(let k=1;k<points.length;k++){
  const a=points[k-1],b=points[k],p=a.record,r=b.record;if(r.timeMs<=lo||p.timeMs>=hi)continue;
  if(p.timeMs>covered||p.source.origin!=="parsed"||r.source.origin!=="parsed"||p.source.discontinuityBefore?.length||r.source.discontinuityBefore?.length||
   r.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||r.timeMs<=p.timeMs||a.pathGroup!==b.pathGroup||
   (p.source.rawTokenIndex!==undefined||r.source.rawTokenIndex!==undefined)&&r.source.rawTokenIndex!==p.source.rawTokenIndex!+1)return;
  const start=Math.max(lo,p.timeMs),finish=Math.min(hi,r.timeMs),dx=(Math.fround(r.position.x)-Math.fround(p.position.x))/R,
   dy=(Math.fround(r.position.y)-Math.fround(p.position.y))/R,x=(Math.fround(p.position.x)-Math.fround(c.x))/R,y=(Math.fround(p.position.y)-Math.fround(c.y))/R,
   from=(start-p.timeMs)/(r.timeMs-p.timeMs),to=(finish-p.timeMs)/(r.timeMs-p.timeMs),length=dx*dx+dy*dy,
   u=length?Math.max(from,Math.min(to,-(x*dx+y*dy)/length)):from;
  minimumR=Math.min(minimumR,Math.hypot(x+u*dx,y+u*dy));covered=finish;
 }
 if(covered!==hi||!(minimumR>1))return;
 for(const inputId of selected[0].inputIds){if(!inputIds.includes(inputId))continue;
  const correction=certifyCanonicalControl(map,trace,{targetId:target.targetId,relatedComponentIds:[prior.id,target.targetId],improvedReceiptIds:[prior.id],
   changes:[{inputId,position:prior.position}]},excluded);
  if(!correction||correction.addedFreshActions!==0||correction.outcomes.find(o=>o.componentId===target.targetId)?.after.judgementTime!==q.timeMs||
   !correction.outcomes.some(o=>o.componentId===prior.id&&o.after.judgementTime<q.timeMs))continue;
  return {basis:"upstream-late-arrival-before-successful-consumption" as const,rootComponentId:prior.id,receiverInputId:q.id,
   entryTimeMs:entry,entryOffsetMs:entry-prior.hitTime,bestWindowMinimumR:minimumR,comparison,correction,
   eventIds:[...new Set([...receipt.eventIds,...selected[0].eventIds,...correction.eventIds,...points.map(i=>i.record.id)])]};
 }
 return;
}
