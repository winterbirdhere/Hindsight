import { Beatmap } from "../../beatmap/Beatmap";
import { CircleEvidence } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { certifyCanonicalControl } from "./CanonicalReplayVerifier";
import { derivePrecedingLateCadence } from "./PrecedingLateCadence";

/** Extra capacity is a declared control, never evidence that a tap was omitted.
 * The original successful phase already predicts expiry. Preserve its last
 * receiver exactly while testing whether a second callback could recover us. */
export function deriveLateCapacityRecovery(target:CircleEvidence,map:Beatmap,trace:ReplayTrace,excluded:ReadonlySet<string>=new Set()) {
 const phase=derivePrecedingLateCadence(target,map,trace,excluded);if(!phase)return;
 const {ix,last,anchors,offsets,intervals,slope,residual,predictedTargetOffsetMs,following}=phase,q=last.receipt.input,
  at=ix.inputPositions.get(q.id)!,before=ix.inputs[at-1],opportunity=target.inputs.find(i=>i.record.id===q.id),
  other=q.freshActions[0]===0?1:0;
 if(!before||!opportunity?.inside||!opportunity.inLiveSuccess||opportunity.postTerminal||q.actions.length>2)return;
 // Prefer a one-sample declared release when the second channel was held.
 // Otherwise add one short edge, ending at the already released next sample.
 const next=ix.inputs[at+1];if(!next||next.timeMs<=q.timeMs)return;
 const changes=q.actions.includes(other)?
  before.actions.includes(other)&&!before.freshActions.includes(other)?[{inputId:before.id,actions:before.actions.filter(a=>a!==other)}]:undefined:
  !next.actions.includes(other)?[{inputId:q.id,actions:[...q.actions,other].sort()}]:undefined;
 if(!changes)return;
 const correction=certifyCanonicalControl(map,trace,{targetId:target.targetId,relatedComponentIds:[last.e.targetId,target.targetId],changes},excluded);
 if(!correction||correction.addedFreshActions!==1||correction.outcomes.length!==1||
  correction.outcomes[0].componentId!==target.targetId||correction.outcomes[0].after.judgementTime!==q.timeMs)return;
 return {basis:"observed-preceding-drift-with-declared-capacity" as const,
  anchors:anchors.map((a,k)=>({componentId:a.e.targetId,inputId:a.receipt.input.id,offsetMs:offsets[k],receiptId:a.receipt.receipt!.id})),
  alignedInputId:following.id,actualReceiverId:last.e.targetId,targetOffsetMs:following.timeMs-target.target!.hitTimeMs,
  scheduledIntervalsMs:intervals,phaseFit:{basis:"preceding-successful-circle-receipts" as const,anchorCount:anchors.length,predictedTargetOffsetMs,slope,maxResidualMs:residual},
  correction,eventIds:[...new Set([...anchors.flatMap(a=>a.receipt.eventIds),...phase.context.map(q=>q.id),...correction.eventIds])]};
}
