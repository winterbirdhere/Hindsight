import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { CircleEvidence } from "../miss-explanation/CircleEvidence";
import { nativeWithinHitRadius, stableWithinHitRadius } from "../StableHitGeometry";
import { comparePrimaryApproaches } from "./PrimaryApproachComparison";
import { rankPrimaryCandidates } from "./PrimaryDiagnosisPolicy";

/** Scoped to an already-proven consuming chain, not a new ownership inference.
 * A within-best-window pulse is not independently mistimed when even moving it
 * to the nominal beat leaves it outside the same late-entering approach.
 * The ordinary comparison remains intact, including its conditional timing. */
export function compareInitiatingArrival(e:CircleEvidence,map:Beatmap,comparison:ReturnType<typeof comparePrimaryApproaches>) {
  const object=map.getHitObject(e.targetId),episode=comparison.approaches.episodes[0],pass=episode?.properPass;
  if(!(object instanceof HitCircle)||object.sliderId!==undefined||!e.target||!e.geometry||!e.terminal||
    e.status!=="supported"||e.limits.truncated||Object.values(e.dependencies).some(d=>d.status!=="complete")||
    !comparison.complete||comparison.approaches.episodes.length!==1||episode.status!=="supported"||
    episode.placement!=="proper-pass"||episode.relation!=="before-pass"||episode.spatialCandidates.length||episode.deadlineArrival||
    !pass||pass.placementSupport!=="sampled"||!pass.deepSampled||pass.leftCensored||pass.relation!=="same-approach"||
    episode.contacts.length!==1||pass.entryTimeMs<=e.target.hitTimeMs||pass.entryTimeMs>=e.terminal.timeMs||
    Math.abs(episode.pressOffsetMs)>e.geometry.hitWindows[0])return;
  const press=e.inputs.find(i=>i.record.id===episode.inputId);
  if(!press||press.inside||!press.inLiveSuccess||press.postTerminal||!press.freshActionsKnown||press.record.freshActions.length!==1)return;
  const points=e.inputs.filter(i=>episode.eventIds.includes(i.record.id));
  const left=points.reduce((last,i,k)=>i.record.timeMs<=e.target!.hitTimeMs?k:last,-1),a=points[left],b=points[left+1];
  const entryLeft=points.reduce((last,i,k)=>i.record.timeMs<pass.entryTimeMs?k:last,-1),c=points[entryLeft],d=points[entryLeft+1];
  if(!a||!b||!c||!d||a.record.timeMs>b.record.timeMs||b.record.timeMs-a.record.timeMs>e.geometry.hitWindows[0]||
    d.record.timeMs-c.record.timeMs>e.geometry.hitWindows[0]||d.postTerminal||!d.inside||
    !pass.sampledEventIds.some(id=>e.inputs.some(i=>i.record.id===id&&i.inside&&!i.postTerminal&&i.record.sequence<e.terminal!.sequence)))return;
  const same=(x:readonly number[],y:readonly number[])=>x.length===y.length&&x.every(v=>y.includes(v));
  for(let k=0;k<points.length;k++){
    const q=points[k].record,p=points[k-1]?.record;
    if(q.source.origin!=="parsed"||q.source.discontinuityBefore?.length||!Number.isSafeInteger(q.source.parsedFrameIndex)||q.source.parsedFrameIndex<0||
      ![q.timeMs,q.position.x,q.position.y].every(Number.isFinite)||
      [q.actions,q.previousActions,q.freshActions].some(actions=>new Set(actions).size!==actions.length||actions.some(v=>v!==0&&v!==1))||
      !same(q.freshActions,q.actions.filter(v=>!q.previousActions.includes(v)))||
      (q.rawButtonMask!==undefined&&(!Number.isSafeInteger(q.rawButtonMask)||q.rawButtonMask<0||!same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])]))))return;
    if(p&&(p.source.origin!=="parsed"||q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||q.timeMs<=p.timeMs||!same(q.previousActions,p.actions)||
      ((p.source.rawTokenIndex!==undefined||q.source.rawTokenIndex!==undefined)&&(p.source.rawTokenIndex===undefined||q.source.rawTokenIndex!==p.source.rawTokenIndex+1))))return;
    if(q.freshActions.length&&q.id!==press.record.id)return;
  }
  const fraction=(e.target.hitTimeMs-a.record.timeMs)/(b.record.timeMs-a.record.timeMs);
  const rounded=e.geometry.profile==="stable"?Math.fround:(value:number)=>value;
  const position={x:rounded(a.record.position.x)+(rounded(b.record.position.x)-rounded(a.record.position.x))*fraction,
    y:rounded(a.record.position.y)+(rounded(b.record.position.y)-rounded(a.record.position.y))*fraction};
  if(!Number.isFinite(fraction)||fraction<0||fraction>1||(e.geometry.profile==="stable"?
    stableWithinHitRadius(e.geometry.position,position,e.geometry.radius):nativeWithinHitRadius(e.geometry.position,position,e.geometry.radius)))return;
  const arrival=comparison.candidates.filter(candidate=>candidate.code==="aim-late"&&candidate.inputIds.length===1&&candidate.inputIds[0]===press.record.id);
  const conditional=comparison.candidates.filter(candidate=>candidate.family==="timing"&&candidate.relationId==="tap-phase:"+press.record.id);
  if(arrival.length!==1||!conditional.length)return;
  const candidates=comparison.candidates.filter(candidate=>!conditional.includes(candidate)),ranking=rankPrimaryCandidates(candidates,[press.record.id]);
  if(!ranking.selected.length)return;
  return {policyVersion:"initiating-arrival-v1",basis:"within-best-pulse-and-outside-at-nominal" as const,inputId:press.record.id,
    nominalTimeMs:e.target.hitTimeMs,nominalPosition:position,entryTimeMs:pass.entryTimeMs,
    conditionalTimingCandidates:conditional,candidates,ranking,eventIds:[...new Set([...episode.eventIds,a.record.id,b.record.id,c.record.id,d.record.id])]};
}
