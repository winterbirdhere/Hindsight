import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { CircleEvidence } from "../miss-explanation/CircleEvidence";
import { stableGameplayRadius, stableWithinHitRadius } from "../StableHitGeometry";
import { stableHitWindowsForOD } from "../StableDifficulty";
import { ReplayTrace } from "../trace/ReplayTrace";
import { circleDispatch, completeCircle } from "./BoundedCircleRetiming";
import { CanonicalControl, certifyCanonicalControl } from "./CanonicalReplayVerifier";
import { PRIMARY_APPROACH_POLICY, isPrimaryCursorPass } from "./PrimaryApproach";
import { comparePrimaryApproaches } from "./PrimaryApproachComparison";
import { PRIMARY_DIAGNOSIS_POLICY } from "./PrimaryDiagnosisPolicy";
import { rejectedInitiatingTraceIndex } from "./InterceptionChain";

/** A common timing error around one reconstructed passage. This descriptor
 * deliberately leaves shallow contacts unproven as sampled placement evidence.
 * Two controls corroborate the original movement/role predicate; neither a
 * successful repair nor an opposing pair of labels establishes that predicate. */
export function deriveReconstructedSharedPass(e:CircleEvidence,map:Beatmap,trace:ReplayTrace,comparison:ReturnType<typeof comparePrimaryApproaches>,excluded:ReadonlySet<string>=new Set()){
 const object=map.getHitObject(e.targetId),g=e.geometry,windows=stableHitWindowsForOD(map.stableOverallDifficulty),index=rejectedInitiatingTraceIndex(trace);
 if(!completeCircle(e)||trace.identity.analysisProfileId!=="stable"||e.directRejections.length||e.terminal?.mechanism!=="automatic-expiry"||
  e.terminal.result!=="MISS"||!(object instanceof HitCircle)||object.sliderId||!g||g.radius!==Math.fround(stableGameplayRadius(object.radius))||
  g.position.x!==object.position.x||g.position.y!==object.position.y||g.profile!=="stable"||
  g.hitWindows.length!==windows.length||windows.some((w,k)=>w!==g.hitWindows[k])||object.hitTime!==e.target!.hitTimeMs||object.spawnTime!==e.target!.spawnTimeMs||
  JSON.stringify(e.identity)!==JSON.stringify(trace.identity)||JSON.stringify(e.terminal)!==JSON.stringify(index.terminals.get(e.targetId))||comparison.approaches.limitations.length)return;
 const raw=e.inputs.filter(i=>i.inLiveSuccess&&!i.postTerminal&&i.record.freshActions.length),eps=comparison.approaches.episodes,best=g.hitWindows[0],beat=object.hitTime;
 if(raw.length!==2||eps.length!==2||raw.some(i=>!i.freshActionsKnown||i.inside||i.record.freshActions.length!==1||JSON.stringify(i.record)!==JSON.stringify(index.byId.get(i.record.id)))||
  eps.some(ep=>ep.status!=="supported"||ep.inputScope||ep.limitations.some(s=>s!=="no-positive-local-placement"))||
  comparison.candidates.some(c=>c.independent||c.family==="placement"||c.support?.context||c.support?.aimOpportunity||c.support?.bestWindowAim))return;
 const lo=beat-g.hitWindows[2],hi=beat+g.hitWindows[2],contacts=eps.map(ep=>ep.contacts.filter(c=>isPrimaryCursorPass(c)&&c.exitTimeMs>lo&&c.entryTimeMs<hi)),pass=contacts[0][0];
 if(contacts.some(a=>a.length!==1)||!pass||pass.leftCensored||pass.rightCensored||pass.placementSupport!=="unproven"||
  pass.entryTimeMs<beat-best||pass.exitTimeMs>beat+best||contacts.some(a=>a[0].entryTimeMs!==pass.entryTimeMs||a[0].exitTimeMs!==pass.exitTimeMs||a[0].leftCensored||a[0].rightCensored)||
  raw[0].record.timeMs>=beat-best||raw[1].record.timeMs<=beat+best)return;
 const offsets=raw.map(i=>Math.abs(i.record.timeMs-beat)),ratio=Math.min(...offsets)/Math.max(...offsets);
 if(ratio<PRIMARY_DIAGNOSIS_POLICY.nearTieRatio||Math.abs(offsets[0]-offsets[1])/best>PRIMARY_DIAGNOSIS_POLICY.nearTieDifference)return;
 const routes=raw.map(i=>circleDispatch(trace,i.record));if(routes.some(r=>!r||r.selection.componentId!==null||r.attempt.knownAction===undefined))return;
 const all=index.inputs,firstTime=Math.floor(pass.entryTimeMs)+1,lastTime=Math.ceil(pass.exitTimeMs)-1;
 if(lastTime-firstTime<1)return;
 const timeMs=Math.max(firstTime,Math.min(lastTime,Math.round(pass.closestTimeMs))),right=all.findIndex(q=>q.timeMs>timeMs),left=right-1;
 if(left<1||right+1>=all.length||all[left].timeMs>=timeMs)return;
 const a=all[left],b=all[right],fraction=(timeMs-a.timeMs)/(b.timeMs-a.timeMs),position={x:a.position.x+fraction*(b.position.x-a.position.x),y:a.position.y+fraction*(b.position.y-a.position.y)};
 if(!stableWithinHitRadius(g.position,position,g.radius))return;
 // Numerical robustness is separate from morphology's larger noise floor.
 const error=8*Math.pow(2,-23)*Math.max(1,g.radius,Math.abs(g.position.x),Math.abs(g.position.y),Math.abs(position.x),Math.abs(position.y));
 if(g.radius-Math.hypot(Math.fround(position.x)-Math.fround(g.position.x),Math.fround(position.y)-Math.fround(g.position.y))<=error)return;
 let usableIntegerTimes=0;
 for(let t=firstTime;t<=lastTime;t++){
  if(t<=a.timeMs||t>=b.timeMs)continue;
  const u=(t-a.timeMs)/(b.timeMs-a.timeMs),x=a.position.x+u*(b.position.x-a.position.x),y=a.position.y+u*(b.position.y-a.position.y);
  if(g.radius-Math.hypot(Math.fround(x)-Math.fround(g.position.x),Math.fround(y)-Math.fround(g.position.y))>error)usableIntegerTimes++;
 }
 if(usableIntegerTimes<2)return;
 const norm=(p:typeof a,q:typeof a)=>Math.hypot(q.position.x-p.position.x,q.position.y-p.position.y)/g.radius;
 let incoming=left-1,outgoing=right+1;
 while(incoming>0&&norm(all[incoming],a)<=PRIMARY_APPROACH_POLICY.noiseR)incoming--;
 while(outgoing+1<all.length&&norm(b,all[outgoing])<=PRIMARY_APPROACH_POLICY.noiseR)outgoing++;
 const from=Math.min(incoming,...raw.map(i=>index.inputPositions.get(i.record.id)??-1)),to=Math.max(outgoing,...raw.map(i=>index.inputPositions.get(i.record.id)??-1));
 if(from<1||to>=all.length||to-from>128)return;
 for(let k=from;k<=to;k++){
  const q=all[k],p=all[k-1];if(q.source.origin!=="parsed"||p.source.origin!=="parsed"||q.source.discontinuityBefore?.length||
   q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||q.timeMs<=p.timeMs||
   (q.source.rawTokenIndex!==undefined||p.source.rawTokenIndex!==undefined)&&q.source.rawTokenIndex!==p.source.rawTokenIndex!+1||
   q.freshActions.length&&!raw.some(i=>i.record.id===q.id))return;
  if(k>incoming&&k<=outgoing&&q.timeMs-p.timeMs>best)return;
 }
 const dx=b.position.x-a.position.x,dy=b.position.y-a.position.y,len=Math.hypot(dx,dy),cos=Math.cos(PRIMARY_APPROACH_POLICY.minimumTurnRadians),
  aligned=(x:number,y:number)=>(x*dx+y*dy)/(Math.hypot(x,y)*len)>=cos;
 if(norm(all[incoming],a)<=PRIMARY_APPROACH_POLICY.noiseR||norm(b,all[outgoing])<=PRIMARY_APPROACH_POLICY.noiseR||
  !aligned(a.position.x-all[incoming].position.x,a.position.y-all[incoming].position.y)||!aligned(all[outgoing].position.x-b.position.x,all[outgoing].position.y-b.position.y))return;
 const corrections:CanonicalControl[]=[];
 for(const pulse of raw){
  const old=index.inputPositions.get(pulse.record.id)!,action=pulse.record.freshActions[0],changes:Array<{inputId:string;actions:number[]}>=[];
  if(old<right){
   let release=old+1;while(release<all.length&&all[release].actions.includes(action))release++;
   // Shorten the old hold, retaining its original release or the first source
   // sample after the declared point when that release already occurred.
   for(let k=old;k<Math.min(release,right);k++)changes.push({inputId:all[k].id,actions:all[k].actions.filter(v=>v!==action)});
  }else{
   if(all.slice(left,old).some(q=>q.actions.includes(action)))return;
   for(let k=right;k<old;k++)changes.push({inputId:all[k].id,actions:[...all[k].actions,action].sort()});
  }
  const actions=[...new Set([...a.actions,action])].sort(),correction=certifyCanonicalControl(map,trace,{targetId:e.targetId,relatedComponentIds:[e.targetId],changes,
   insertions:[{beforeInputId:b.id,timeMs,actions}]},excluded);
  if(!correction||correction.addedFreshActions!==0||correction.outcomes.length!==1||correction.outcomes[0].after.judgementTime!==timeMs||correction.outcomes[0].after.type!=="GREAT")return;
  corrections.push(correction);
 }
 return {basis:"reconstructed-shared-timing-passage" as const,entryTimeMs:pass.entryTimeMs,exitTimeMs:pass.exitTimeMs,timeMs,comparison,corrections,
  eventIds:[...new Set([...eps.flatMap(ep=>ep.eventIds),...routes.flatMap(r=>r!.eventIds),...all.slice(from,to+1).map(q=>q.id),...corrections.flatMap(c=>c.eventIds)])]};
}
