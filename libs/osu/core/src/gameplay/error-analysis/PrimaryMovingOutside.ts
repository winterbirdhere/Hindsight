import { CircleEvidence, CircleInputEvidence } from "../miss-explanation/CircleEvidence";
import { analyzePrimaryApproaches, PrimaryApproachContext, PrimaryApproachEpisode, PRIMARY_APPROACH_POLICY } from "./PrimaryApproach";
import { ReplayTrace } from "../trace/ReplayTrace";

/** Positive moving geometry around an otherwise unclassified outside press.
 * This neither assigns intent nor establishes a directional subtype. Admission
 * must certify the same-time correction with this entire source run. */
export function boundedMovingOutside(e:CircleEvidence,ep:PrimaryApproachEpisode,trace?:ReplayTrace):string[]|undefined {
  return boundedOutside(e,ep,trace,"press");
}
/** A separate broad description of motion through the note's best window.
 * It makes no claim about a landing or movement after the correcting pulse. */
export function boundedBeatOutside(e:CircleEvidence,ep:PrimaryApproachEpisode,trace?:ReplayTrace):string[]|undefined {
  return boundedOutside(e,ep,trace,"beat");
}
/** Regenerate before a later ordered source group. The closure is diagnostic
 * context, not a continuous chord or a sample in the new geometry witness. */
export function regenerateBeatOutsideBeforeFutureGroup(e:CircleEvidence,ep:PrimaryApproachEpisode,context:PrimaryApproachContext,trace:ReplayTrace|undefined){
 if(!trace||!e.target||!e.geometry||ep.inputScope?.placementEnd||ep.contacts.length||ep.properPass||ep.spatialCandidates.length)return;
 const all=e.inputs,ids=new Set(ep.eventIds),press=all.find(i=>i.record.id===ep.inputId);if(!press)return;
 for(let k=1;k<all.length;k++){
  const a=all[k-1].record,b=all[k].record;
  if(a.timeMs!==b.timeMs||a.position.x===b.position.x&&a.position.y===b.position.y)continue;
  let first=k-1,last=k;while(first>0&&all[first-1].record.timeMs===a.timeMs)first--;
  while(last+1<all.length&&all[last+1].record.timeMs===a.timeMs)last++;
  const start=all[first].record,prior=all[first-1]?.record,scope=context.inputScopes?.[ep.inputId];
  if(!ids.has(start.id)||!prior||start.timeMs<=Math.max(press.record.timeMs,e.target.hitTimeMs+e.geometry.hitWindows[0])||
   prior.timeMs<Math.max(press.record.timeMs,e.target.hitTimeMs+e.geometry.hitWindows[0])||
   [context.end,scope?.end].some(end=>end&&end.timeMs<=start.timeMs))continue;
  const group=all.slice(first,last+1).map(i=>i.record);let valid=true;
  for(let j=first;j<=last;j++){
   const q=all[j].record,p=all[j-1].record;
   if(trace.records[q.sequence]!==q||trace.records[p.sequence]!==p||q.source.origin!=="parsed"||p.source.origin!=="parsed"||
    q.source.discontinuityBefore?.length||p.source.discontinuityBefore?.length||q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||
    (p.source.rawTokenIndex!==undefined||q.source.rawTokenIndex!==undefined)&&q.source.rawTokenIndex!==p.source.rawTokenIndex!+1)valid=false;
  }
  if(!valid)return;
  const fresh=analyzePrimaryApproaches(e,{...context,inputScopes:{...context.inputScopes,[ep.inputId]:{...scope,
   end:{timeMs:start.timeMs,sequence:start.sequence,inclusive:false}}}}).episodes.find(candidate=>candidate.inputId===ep.inputId);
  const geometryEventIds=fresh&&boundedBeatOutside(e,fresh,trace);if(!fresh||!geometryEventIds)return;
  return {episode:fresh,geometryEventIds,closure:{basis:"before-future-ordered-position-group" as const,geometryEndInputId:prior.id,
   timeMs:start.timeMs,eventIds:group.map(q=>q.id)}};
 }
 return;
}
function boundedOutside(e:CircleEvidence,ep:PrimaryApproachEpisode,trace:ReplayTrace|undefined,centeredOn:"press"|"beat"):string[]|undefined {
  if(!e.geometry||!e.target||ep.status!=="supported"||ep.placement!=="unproven"||ep.spatialCandidates.length||ep.properPass||
    ep.contacts.length||ep.inputScope?.placementEnd||ep.eventIds.length>PRIMARY_APPROACH_POLICY.maximumInputs||
    ep.limitations.some(s=>s!=="no-positive-local-placement"&&s!=="short-local-trajectory"))return;
  const ids=new Set(ep.eventIds),run=e.inputs.filter(i=>ids.has(i.record.id)),at=run.findIndex(i=>i.record.id===ep.inputId);
  if(at<0)return;
  const geometry=e.geometry,round=geometry.profile==="stable"?Math.fround:(x:number)=>x,R=Math.fround(geometry.radius),
    pos=(i:CircleInputEvidence)=>({x:(round(i.record.position.x)-round(geometry.position.x))/R,y:(round(i.record.position.y)-round(geometry.position.y))/R}),
    same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(x=>b.includes(x));
  if(!(R>0)||!Number.isFinite(R))return;
  const extraRouting=new Map<string,string[]>();
  const nullAction=(i:CircleInputEvidence)=>{
    const q=i.record;if(!trace||trace.records[q.sequence]!==q||q.freshActions.length!==1)return false;
    const attempts=e.attempts.filter(a=>a.inputId===q.id),a=attempts[0],routes=e.routing.filter(r=>r.attemptId===a?.id),s=routes[0];
    if(attempts.length!==1||!a||a.automated||a.attemptOrdinal!==0||a.knownAction!==q.freshActions[0]||
      !same(a.actionCandidates,q.freshActions)||trace.records[a.sequence]!==a||a.timeMs!==q.timeMs||a.sequence<=q.sequence||
      routes.length!==1||s.kind!=="selection"||trace.records[s.sequence]!==s||s.sequence<=a.sequence||s.timeMs!==q.timeMs||
      s.componentId!==null||s.inside!==null||s.eligible||s.selectionStopped||
      trace.records.some(r=>r.kind==="resolution"&&r.triggerAttemptId===a.id))return false;
    extraRouting.set(q.id,[a.id,s.id]);return true;
  };
  const valid=(i:CircleInputEvidence)=>{
    const q=i.record,z=q.source;
    return i.inLiveSuccess&&!i.inside&&!i.postTerminal&&i.pathGroup===run[at].pathGroup&&i.freshActionsKnown&&z.origin==="parsed"&&
      !z.discontinuityBefore?.length&&Number.isSafeInteger(z.parsedFrameIndex)&&z.parsedFrameIndex>=0&&
      (z.rawTokenIndex===undefined||Number.isSafeInteger(z.rawTokenIndex)&&z.rawTokenIndex>=0)&&
      [q.timeMs,q.position.x,q.position.y].every(Number.isFinite)&&q.actions.every(a=>a===0||a===1)&&new Set(q.actions).size===q.actions.length&&
      same(q.freshActions,q.actions.filter(a=>!q.previousActions.includes(a)))&&(!q.freshActions.length||q.id===ep.inputId||nullAction(i))&&
      (q.rawButtonMask===undefined||Number.isSafeInteger(q.rawButtonMask)&&q.rawButtonMask>=0&&
        same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])]));
  };
  const adjacent=(a:CircleInputEvidence,b:CircleInputEvidence)=>{
    const x=pos(a),y=pos(b),dx=y.x-x.x,dy=y.y-x.y,length=dx*dx+dy*dy,
      u=length?Math.max(0,Math.min(1,-(x.x*dx+x.y*dy)/length)):0,sa=a.record.source,sb=b.record.source;
    return sa.origin==="parsed"&&sb.origin==="parsed"&&b.record.timeMs>a.record.timeMs&&
      sb.parsedFrameIndex===sa.parsedFrameIndex+1&&same(b.record.previousActions,a.record.actions)&&
      ((sa.rawTokenIndex===undefined&&sb.rawTokenIndex===undefined)||sa.rawTokenIndex!==undefined&&sb.rawTokenIndex===sa.rawTokenIndex+1)&&
      Math.hypot(x.x+u*dx,x.y+u*dy)>1;
  };
  let first=at,last=at;if(!valid(run[at])||centeredOn==="beat"&&!nullAction(run[at]))return;
  while(first>0&&valid(run[first-1])&&adjacent(run[first-1],run[first]))first--;
  while(last+1<run.length&&valid(run[last+1])&&adjacent(run[last],run[last+1]))last++;
  let p=pos(run[at]);
  if(centeredOn==="beat"){
    const k=run.findIndex((i,k)=>k>=first&&k<=last&&i.record.timeMs>=e.target!.hitTimeMs),a=run[k-1],b=run[k];
    if(!a||!b||k-1<first||run[first].record.timeMs>e.target.hitTimeMs-geometry.hitWindows[0]||
      run[last].record.timeMs<e.target.hitTimeMs+geometry.hitWindows[0])return;
    const x=pos(a),y=pos(b),u=(e.target.hitTimeMs-a.record.timeMs)/(b.record.timeMs-a.record.timeMs);
    p={x:x.x+(y.x-x.x)*u,y:x.y+(y.y-x.y)*u};
  }
  const excursion=(i:CircleInputEvidence)=>{const q=pos(i);return Math.hypot(q.x-p.x,q.y-p.y);},
    centerTime=centeredOn==="beat"?e.target.hitTimeMs:run[at].record.timeMs,
    before=run.slice(first,last+1).filter(i=>i.record.timeMs<centerTime),after=run.slice(first,last+1).filter(i=>i.record.timeMs>centerTime);
  // A short pre-arrival or recovery fragment does not establish the target's
  // placement. Require the uninterrupted outside run to cover its beat too.
  if(!(before.length&&after.length&&(centeredOn==="beat"||first<at&&last>at)&&run[first].record.timeMs<=e.target.hitTimeMs&&run[last].record.timeMs>=e.target.hitTimeMs&&
    run[last].record.timeMs-run[first].record.timeMs>=geometry.hitWindows[0]&&
    Math.max(...before.map(excursion))>PRIMARY_APPROACH_POLICY.noiseR&&
    Math.max(...after.map(excursion))>PRIMARY_APPROACH_POLICY.noiseR))return;
  const boundary=run[first-1],closure=trace&&boundary?.record.freshActions.length?trace.records.filter(r=>r.sequence>boundary.record.sequence&&
    r.sequence<run[first].record.sequence&&["attempt","selection","policy","resolution"].includes(r.kind)).map(r=>r.id):[];
  return [...run.slice(first,last+1).flatMap(i=>[i.record.id,...(extraRouting.get(i.record.id)??[])]),...closure];
}
