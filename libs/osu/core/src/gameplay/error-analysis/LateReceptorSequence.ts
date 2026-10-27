import { derivePrecedingLateCadence } from "./PrecedingLateCadence";
import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { CircleEvidence, deriveCircleEvidence, InputRecord } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { completeCircle, observedCircleReceipt } from "./BoundedCircleRetiming";
import { receptorPacket, certifyReceptorRetiming, ReceptorMove } from "./BoundedReceptorRetiming";
import { rejectedInitiatingTraceIndex } from "./InterceptionChain";

/** Fit the observed successful phase before searching a control. A head may
 * mark a later recovery; it is not silently forced into the preceding cadence. */
export function deriveLateReceptorSequence(target:CircleEvidence,map:Beatmap,trace:ReplayTrace,excluded:ReadonlySet<string>=new Set()){
 const phase=derivePrecedingLateCadence(target,map,trace,excluded);if(!phase)return;
 const {at,ix,anchors,last,following,notes,offsets,intervals,spacing,slope,residual,predictedTargetOffsetMs,context}=phase;
 const related=[target],pulses:InputRecord[]=[following],recovery:Array<{componentId:string;inputId:string;offsetMs:number;result:string}>=[];
 let closed=false,afterHead=false;
 for(let k=0;k<12;k++){
  const q=pulses[k],packet=receptorPacket(trace,q);if(packet?.length!==1)return;
  const d=packet[0];if(!d.receipt){closed=k>0;break;}
  const parent=map.hitObjects[at+k+1],next=parent instanceof HitCircle?parent:parent instanceof Slider?parent.head:undefined;
  if(!next||d.receipt.componentId!==next.id||d.receipt.mechanism!=="successful-input"||d.receipt.result==="MISS")return;
  const e=deriveCircleEvidence(trace,map,next.id);if(!completeCircle(e))return;
  const interval=next.hitTime-related[related.length-1].target!.hitTimeMs;
  if(interval<=3||interval>500||!afterHead&&(interval<spacing/1.1||interval>spacing*1.1)||next.hitTime-target.target!.hitTimeMs>1600)return;
  recovery.push({componentId:next.id,inputId:q.id,offsetMs:q.timeMs-next.hitTime,result:d.receipt.result});afterHead=afterHead||!!next.sliderId;
  related.push(e);
  const qAt=ix.inputPositions.get(q.id)!,fresh=ix.inputs.slice(qAt+1).find(r=>r.freshActions.length);
  if(!fresh||fresh.freshActions.length!==1||fresh.timeMs<=q.timeMs||fresh.timeMs-q.timeMs>500||
   !afterHead&&(fresh.timeMs-q.timeMs<spacing*.6||fresh.timeMs-q.timeMs>spacing*1.4))return;pulses.push(fresh);
 }
 if(!closed||related.length!==pulses.length||related.length>12||!related.some(e=>e.targetId.endsWith("/HEAD")))return;
 const options=related.map((e,k)=>{
  const original=e.terminal!.result,limit=original==="GREAT"?e.geometry!.hitWindows[0]:original==="OK"?e.geometry!.hitWindows[1]:e.geometry!.hitWindows[2],
   originalAt=ix.inputPositions.get(pulses[k].id)!,action=pulses[k].freshActions[0],
   candidates=e.inputs.filter(i=>i.inside&&i.inLiveSuccess&&!i.postTerminal&&i.record.sequence>=last.receipt.input.sequence&&
    ix.inputPositions.get(i.record.id)!<originalAt&&Math.abs(i.record.timeMs-e.target!.hitTimeMs)<limit&&!i.record.freshActions.includes(action)&&
    (!i.record.freshActions.length||receptorPacket(trace,i.record)?.every(p=>p.receipt?.mechanism==="successful-input"&&p.selection.component==="circle")))
    .sort((a,b)=>Math.abs(a.record.timeMs-e.target!.hitTimeMs)-Math.abs(b.record.timeMs-e.target!.hitTimeMs)||a.record.sequence-b.record.sequence).slice(0,6);
  return candidates.flatMap(i=>(e.targetId.endsWith("/HEAD")?[true]:[false,true]).map(preserveHold=>({
   move:{componentId:e.targetId,inputId:pulses[k].id,sampleId:i.record.id,preserveHold},
   cost:Math.abs(i.record.timeMs-e.target!.hitTimeMs)/spacing+(preserveHold&&!e.targetId.endsWith("/HEAD")?.05:0),
  }))).sort((a,b)=>a.cost-b.cost);
 });
 if(options.some(a=>!a.length))return;
 const frontier=[Array(options.length).fill(0) as number[]],seen=new Set<string>([frontier[0].join(",")]),
  cost=(state:number[])=>state.reduce((sum,n,k)=>sum+options[k][n].cost,0);
 let correction:ReturnType<typeof certifyReceptorRetiming>,chosen:ReceptorMove[]|undefined,tried=0,popped=0;
 while(frontier.length&&tried<32&&popped++<256){
  frontier.sort((a,b)=>cost(a)-cost(b)||a.join(",").localeCompare(b.join(",")));const state=frontier.shift()!,plan=state.map((n,k)=>options[k][n].move);
  if(plan.every((p,k)=>k===0||ix.inputPositions.get(p.sampleId)!>ix.inputPositions.get(plan[k-1].sampleId)!)){
   tried++;const proof=certifyReceptorRetiming(map,trace,plan,excluded);if(proof){correction=proof;chosen=plan;break;}
  }
  for(let k=0;k<state.length;k++)if(state[k]+1<options[k].length){const next=state.slice();next[k]++;const key=next.join(",");
   if(!seen.has(key)){seen.add(key);frontier.push(next);}}
 }
 if(!correction||!chosen)return;
 return {basis:"observed-late-receipts-and-bounded-head-continuation" as const,
  anchors:anchors.map((a,k)=>({componentId:a.e.targetId,inputId:a.receipt.input.id,offsetMs:offsets[k],receiptId:a.receipt.receipt!.id})),
  alignedInputId:following.id,actualReceiverId:receptorPacket(trace,following)![0].selection.componentId,targetOffsetMs:offsets[offsets.length-1],
  scheduledIntervalsMs:intervals,slope,maxResidualMs:residual,
  phaseFit:{basis:"preceding-successful-circle-receipts" as const,anchorCount:anchors.length,predictedTargetOffsetMs,slope,maxResidualMs:residual},
  correction,recovery,search:{tried,limit:32,popped,stateLimit:256,chosen},
  eventIds:[...new Set([...anchors.flatMap(a=>a.receipt.eventIds),...context.map(q=>q.id),...correction.eventIds])]};
}
