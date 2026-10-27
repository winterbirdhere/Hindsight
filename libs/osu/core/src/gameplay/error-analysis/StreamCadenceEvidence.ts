import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { nativeWithinHitRadius, stableWithinHitRadius } from "../StableHitGeometry";
import { CircleEvidence, deriveCircleEvidence, InputRecord } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { errorCapabilities } from "./ErrorCapabilities";

/** Collective recorded pace, not intended input ownership or a unique omitted note. */
export const STREAM_CADENCE_POLICY=Object.freeze({version:"stream-cadence-v2",maximumNotes:12,maximumInputs:4096,
  maximumFreshActions:16,maximumSpanMs:1600,maximumSpacingR:6,maximumIntervalMs:200,plateauRatio:1.1,
  slowRatio:1.35,minimumConsecutiveGaps:3,maximumCachedPatterns:32});
export interface SlowCadencePattern {
  policyVersion:string;
  componentIds:string[];
  scheduledIntervalsMs:number[];
  scheduledMaximumMs:number;
  demandCount:number;
  rawFreshActionCount:number;
  rawActionIds:string[];
  gaps:Array<{id:string;ordinal:number;startInputId:string;endInputId:string;durationMs:number;excessMs:number;eventIds:string[]}>;
  slowRuns:Array<{gapIds:string[];minimumExcessMs:number}>;
  sourceSpan:{startInputId:string;endInputId:string;frameCount:number};
  flow:{complete:boolean;basis:"nominal-cursor-flow-context";samples:Array<{componentId:string;timeMs:number;maximumRadialR:number;inside:boolean;eventIds:string[]}>};
  tempoBoundary?:{componentIds:string[];scheduledIntervalsMs:number[];observedIntervalsMs:number[];eventIds:string[]};
  eventIds:string[];
}
export interface TargetCadenceEvidence {
  pattern:SlowCadencePattern;
  binding:{targetId:string;terminalId:string;gapId:string;opportunity:[number,number];maximumRadialR:number;
    eventIds:string[];rawLiveInputIds:string[];onBeatInputIds:string[];noAssignedTargetInputBranch:true;
    flow?:{complete:boolean;basis:"target-centered-three-gap-flow";gapIds:string[];startTimeMs:number;endTimeMs:number;
      samples:SlowCadencePattern["flow"]["samples"];reason:"complete-boundary-flow"|"missing-boundary-beat"|"conflicting-flow"}};
  candidate:{comparisonUnit:"target-cadence";code:"slow-tapping";headline:"Slow taps";family:"timing";
    strength:number;independent:false;relationId:string;inputIds:[];eventIds:string[];targetId:string};
}

/** Wider context remains diagnostic; a target witness must include both sides. */
export function cadenceFlowApplicable(cadence:TargetCadenceEvidence):boolean {
  return cadence.pattern.flow.complete||cadence.binding.flow?.complete===true;
}

function targetFlow(pattern:SlowCadencePattern,inputs:InputRecord[],gapId:string):TargetCadenceEvidence["binding"]["flow"] {
  // Select from timing alone, before examining cursor geometry. Never search
  // other triplets after a conflict, or clip a missing boundary to the cache.
  const run=pattern.slowRuns.find(r=>r.gapIds[1]===gapId);
  if(!run)return;
  const first=pattern.gaps.find(g=>g.id===run.gapIds[0])!,last=pattern.gaps.find(g=>g.id===run.gapIds[2])!;
  const startTimeMs=inputs.find(q=>q.id===first.startInputId)!.timeMs,endTimeMs=inputs.find(q=>q.id===last.endInputId)!.timeMs;
  const all=pattern.flow.samples;
  const left=all.findIndex((s,k)=>s.timeMs<=startTimeMs&&(k===all.length-1||all[k+1].timeMs>startTimeMs));
  const right=all.findIndex(s=>s.timeMs>=endTimeMs),bounded=left>=0&&right>=left;
  const samples=bounded?all.slice(left,right+1):[];
  const complete=bounded&&samples.every(s=>s.inside);
  return {complete,basis:"target-centered-three-gap-flow",gapIds:[...run.gapIds],startTimeMs,endTimeMs,samples,
    reason:!bounded?"missing-boundary-beat":complete?"complete-boundary-flow":"conflicting-flow"};
}
type Note={circle:HitCircle;parentIndex:number;head:boolean};
const mapNotes=new WeakMap<Beatmap,{notes:Note[];positions:Map<string,number>}>();
function notesFor(map:Beatmap) {
  let found=mapNotes.get(map);
  if(!found){const notes=map.hitObjects.flatMap((o,parentIndex)=>o instanceof HitCircle?[{circle:o,parentIndex,head:false}]:
    o instanceof Slider?[{circle:o.head,parentIndex,head:true}]:[]);
    found={notes,positions:new Map(notes.map((n,k)=>[n.circle.id,k]))};mapNotes.set(map,found);}
  return found;
}
const patternCache=new WeakMap<ReplayTrace,Map<string,{pattern:SlowCadencePattern;inputs:InputRecord[]} | null>>();
const same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(v=>b.includes(v));
function sourceComplete(inputs:readonly InputRecord[],spacing:number) {
  let rawOffset:number|undefined;
  for(let k=0;k<inputs.length;k++){
    const q=inputs[k],p=inputs[k-1];
    if(q.source.origin!=="parsed"||!Number.isSafeInteger(q.source.parsedFrameIndex)||q.source.parsedFrameIndex<0||
      q.source.discontinuityBefore?.length||![q.timeMs,q.position.x,q.position.y].every(Number.isFinite)||
      [q.actions,q.previousActions,q.freshActions].some(a=>new Set(a).size!==a.length||a.some(v=>v!==0&&v!==1))||
      !same(q.freshActions,q.actions.filter(v=>!q.previousActions.includes(v)))||
      (q.rawButtonMask!==undefined&&(!Number.isSafeInteger(q.rawButtonMask)||q.rawButtonMask<0||
        !same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])]))))return false;
    if(q.source.rawTokenIndex!==undefined){
      const offset=q.source.rawTokenIndex-q.source.parsedFrameIndex;
      if(!Number.isSafeInteger(q.source.rawTokenIndex)||q.source.rawTokenIndex<0||(rawOffset!==undefined&&offset!==rawOffset))return false;
      rawOffset=offset;
    }
    if(p&&(p.source.origin!=="parsed"||q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||q.timeMs<p.timeMs||
      q.timeMs-p.timeMs>spacing*.5||!same(q.previousActions,p.actions)))return false;
  }
  return inputs.length>1;
}
function localPattern(notes:Note[],map:Beatmap,trace:ReplayTrace) {
  const evidence=notes.map(n=>deriveCircleEvidence(trace,map,n.circle.id));
  if(evidence.some(e=>!e.target||!e.geometry||!e.terminal||e.limits.truncated||
    Object.values(e.dependencies).some(d=>d.status!=="complete")))return;
  const schedule=notes.map(n=>n.circle.hitTime),intervals=schedule.slice(1).map((v,k)=>v-schedule[k]),spacing=Math.max(...intervals);
  const lo=schedule[0]-evidence[0].geometry!.hitWindows[2],hi=schedule[schedule.length-1]+evidence[evidence.length-1].geometry!.hitWindows[2];
  if(hi-lo>STREAM_CADENCE_POLICY.maximumSpanMs)return;
  const byId=new Map<string,InputRecord>();
  for(const e of evidence)for(const i of e.inputs){byId.set(i.record.id,i.record);if(byId.size>STREAM_CADENCE_POLICY.maximumInputs)return;}
  const all=[...byId.values()].sort((a,b)=>a.sequence-b.sequence);
  const before=all.findIndex(q=>q.timeMs>=lo),after=all.findIndex(q=>q.timeMs>hi);
  if(before<1||after<before)return;
  const inputs=all.slice(before-1,after+1);
  if(!sourceComplete(inputs,spacing))return;
  const fresh=inputs.filter(q=>q.timeMs>=lo&&q.timeMs<=hi&&q.freshActions.length);
  if(fresh.length<4||fresh.length>STREAM_CADENCE_POLICY.maximumFreshActions||fresh.length>=notes.length||fresh.some(q=>q.freshActions.length!==1))return;
  const gaps=fresh.slice(1).map((q,k)=>({id:fresh[k].id+"->"+q.id,ordinal:k,startInputId:fresh[k].id,endInputId:q.id,
    durationMs:q.timeMs-fresh[k].timeMs,excessMs:q.timeMs-fresh[k].timeMs-spacing,eventIds:[fresh[k].id,q.id]}));
  const slowRuns:SlowCadencePattern["slowRuns"]=[];
  for(let k=0;k+2<gaps.length;k++)if(fresh[k].timeMs>=schedule[0]-evidence[0].geometry!.hitWindows[0]&&
    gaps.slice(k,k+3).every(g=>g.durationMs>spacing*STREAM_CADENCE_POLICY.slowRatio))
    slowRuns.push({gapIds:gaps.slice(k,k+3).map(g=>g.id),minimumExcessMs:Math.min(...gaps.slice(k,k+3).map(g=>g.excessMs))});
  if(!slowRuns.length)return;
  // Neighbouring cursor flow is context, not a post-terminal opportunity or
  // ownership claim. Keep every same-time sample; no stop at each note is needed.
  const flowSamples=notes.map((n,k)=>{
    const g=evidence[k].geometry!,t=n.circle.hitTime,right=inputs.findIndex(q=>q.timeMs>=t),b=inputs[right],a=inputs[right-1];
    const effective=(q:InputRecord)=>({x:Math.fround(q.position.x),y:Math.fround(q.position.y)});
    const exact=inputs.filter(q=>q.timeMs===t);
    const positions=exact.map(effective),refs=exact.map(q=>q.id);
    if(!exact.length&&a&&b&&b.timeMs>a.timeMs){const p=effective(a),q=effective(b),f=(t-a.timeMs)/(b.timeMs-a.timeMs);
      positions.push({x:p.x+(q.x-p.x)*f,y:p.y+(q.y-p.y)*f});refs.push(a.id,b.id);}
    const inside=positions.length>0&&positions.every(p=>(g.profile==="stable"?stableWithinHitRadius:nativeWithinHitRadius)(g.position,p,g.radius));
    return {componentId:n.circle.id,timeMs:t,maximumRadialR:positions.length?Math.max(...positions.map(p=>Math.hypot(p.x-Math.fround(g.position.x),p.y-Math.fround(g.position.y))/g.radius)):Infinity,
      inside,eventIds:refs};
  });
  const eventIds=[...new Set([...inputs.map(q=>q.id),...evidence.flatMap(e=>[e.terminal!.id,
    ...[e.domains.liveSuccess.start,e.domains.liveSuccess.end].flatMap(b=>b?.eventId?[b.eventId]:[])])])];
  const pattern:SlowCadencePattern={policyVersion:STREAM_CADENCE_POLICY.version,componentIds:notes.map(n=>n.circle.id),
    scheduledIntervalsMs:intervals,scheduledMaximumMs:spacing,demandCount:notes.length,rawFreshActionCount:fresh.length,
    rawActionIds:fresh.map(q=>q.id),gaps,slowRuns,sourceSpan:{startInputId:inputs[0].id,endInputId:inputs[inputs.length-1].id,frameCount:inputs.length},
    flow:{complete:flowSamples.every(s=>s.inside),basis:"nominal-cursor-flow-context",samples:flowSamples},eventIds};
  return {pattern,inputs};
}
/** Uses bounded neighbouring evidence and its existing sealed trace index. */
export function deriveTargetCadence(e:CircleEvidence,map:Beatmap,trace:ReplayTrace,excluded:ReadonlySet<string>=new Set()):TargetCadenceEvidence|undefined {
  const {target,geometry,terminal}=e,caps=errorCapabilities(map,e.identity.analysisProfileId);
  if(!target||!geometry||terminal?.result!=="MISS"||terminal.mechanism!=="automatic-expiry"||!terminal.previousUnresolved||
    e.limits.truncated||Object.values(e.dependencies).some(d=>d.status!=="complete")||caps.aim!=="manual"||caps.tapping!=="manual"||
    caps.scoring!=="supported"||caps.geometry!=="supported"||
    trace.droppedRecordBoundary!==undefined||trace.records.length>trace.limits.maxRecords||trace.domain.endTimeMs<target.hitTimeMs+geometry.hitWindows[0]||
    JSON.stringify(e.identity)!==JSON.stringify(trace.identity)||trace.failures.some(s=>s!=="global-totals-mismatch"&&!s.startsWith("dependency-conflict:")))return;
  const registry=notesFor(map),at=registry.positions.get(e.targetId);if(at===undefined)return;
  const notes=registry.notes;
  const adjacent=(a:number,b:number)=>b===a+1&&!notes[a].head&&notes[b].parentIndex===notes[a].parentIndex+1&&
    notes[b].circle.hitTime-notes[a].circle.hitTime>3&&notes[b].circle.hitTime-notes[a].circle.hitTime<=STREAM_CADENCE_POLICY.maximumIntervalMs&&
    Math.hypot(notes[a].circle.position.x-notes[b].circle.position.x,notes[a].circle.position.y-notes[b].circle.position.y)<=geometry.radius*6;
  let first=at,last=at,min=Infinity,max=0;
  const admits=(a:number,b:number)=>{const d=notes[b].circle.hitTime-notes[a].circle.hitTime;
    return adjacent(a,b)&&Math.max(max,d)/Math.min(min,d)<=STREAM_CADENCE_POLICY.plateauRatio;};
  while(first>0&&at-first<8&&admits(first-1,first)){const d=notes[first].circle.hitTime-notes[first-1].circle.hitTime;min=Math.min(min,d);max=Math.max(max,d);first--;}
  while(last+1<notes.length&&last-first+1<12&&admits(last,last+1)){const d=notes[last+1].circle.hitTime-notes[last].circle.hitTime;min=Math.min(min,d);max=Math.max(max,d);last++;}
  const local=notes.slice(first,last+1);if(local.length<5||local.some(n=>excluded.has(n.circle.id)||excluded.has(n.circle.sliderId??n.circle.id)))return;
  let cache=patternCache.get(trace);if(!cache){cache=new Map();patternCache.set(trace,cache);}
  const key=e.identity.analysisProfileFingerprint+":"+local.map(n=>n.circle.id).join("|");
  let data=cache.get(key);
  if(data===undefined){data=localPattern(local,map,trace)??null;cache.set(key,data);if(cache.size>32)cache.delete(cache.keys().next().value!);}
  if(!data)return;
  const {pattern,inputs}=data;
  if(trace.failures.some(s=>s.startsWith("dependency-conflict:")&&pattern.componentIds.includes(s.split(":").slice(2).join(":"))))return;
  const best=geometry.hitWindows[0],beat=target.hitTimeMs,live=e.domains.liveSuccess;
  const onBeat=e.inputs.filter(i=>i.record.timeMs>=beat-best&&i.record.timeMs<=beat+best&&i.record.freshActions.length);
  if(onBeat.length||live.state!=="nonempty"||!live.start||!live.end)return;
  const inside=(p:{x:number;y:number})=>(geometry.profile==="stable"?stableWithinHitRadius:nativeWithinHitRadius)(geometry.position,p,geometry.radius);
  const effective=(q:InputRecord)=>({x:Math.fround(q.position.x),y:Math.fround(q.position.y)});
  const point=(t:number)=>{const k=inputs.findIndex(q=>q.timeMs>=t),b=inputs[k],a=inputs[k-1];
    if(!b)return;if(b.timeMs===t)return effective(b);if(!a||b.timeMs<=a.timeMs)return;
    const p=effective(a),q=effective(b),f=(t-a.timeMs)/(b.timeMs-a.timeMs);return{x:p.x+(q.x-p.x)*f,y:p.y+(q.y-p.y)*f};};
  for(const opportunity of [[beat-best,beat],[beat,beat+best]] as [number,number][]){
    const [a,b]=opportunity;if(a<live.start.timeMs||b>live.end.timeMs||b>=terminal.timeMs)continue;
    const gap=pattern.gaps.find(g=>{const left=inputs.find(q=>q.id===g.startInputId),right=inputs.find(q=>q.id===g.endInputId);
      return left&&right&&left.timeMs<a&&right.timeMs>b;});
    const runs=gap&&pattern.slowRuns.filter(r=>r.gapIds.includes(gap.id));if(!gap||!runs?.length)continue;
    const start=point(a),end=point(b);if(!start||!end)continue;
    const positions=[start,...inputs.filter(q=>q.timeMs>=a&&q.timeMs<=b).map(effective),end];
    if(!positions.every(inside))continue;
    const refs=[...new Set([...pattern.eventIds,terminal.id,...e.inputs.filter(i=>i.inLiveSuccess&&!i.postTerminal).map(i=>i.record.id)])];
    return {pattern,binding:{targetId:e.targetId,terminalId:terminal.id,gapId:gap.id,opportunity,
      flow:targetFlow(pattern,inputs,gap.id),
      maximumRadialR:Math.max(...positions.map(p=>Math.hypot(p.x-Math.fround(geometry.position.x),p.y-Math.fround(geometry.position.y))/geometry.radius)),
      eventIds:refs,rawLiveInputIds:e.inputs.filter(i=>i.inLiveSuccess&&!i.postTerminal&&i.record.freshActions.length).map(i=>i.record.id),
      onBeatInputIds:[],noAssignedTargetInputBranch:true},candidate:{comparisonUnit:"target-cadence",code:"slow-tapping",headline:"Slow taps",family:"timing",
      strength:Math.min(...runs.map(r=>r.minimumExcessMs))/best,independent:false,relationId:"target-cadence:"+e.targetId,
      inputIds:[],eventIds:refs,targetId:e.targetId}};
  }
  return undefined;
}
