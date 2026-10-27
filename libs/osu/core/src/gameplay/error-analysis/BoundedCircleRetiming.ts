import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { CircleEvidence, deriveCircleEvidence, InputRecord } from "../miss-explanation/CircleEvidence";
import { stableGameplayRadius, stableWithinHitRadius } from "../StableHitGeometry";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import { errorCapabilities } from "./ErrorCapabilities";
import { rejectedInitiatingTraceIndex } from "./InterceptionChain";

const same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(v=>b.includes(v));
const mask=(q:InputRecord)=>q.actions.reduce((v,a)=>v|(1<<a),0);
const grade=(offset:number,windows:readonly number[])=>Math.abs(offset)<=windows[0]?3:Math.abs(offset)<=windows[1]?2:Math.abs(offset)<=windows[2]?1:0;
export const completeCircle=(e:CircleEvidence)=>!!e.target&&!!e.geometry&&!!e.terminal&&e.terminal.previousUnresolved&&
  (e.status==="supported"||e.status==="not-missed")&&!e.limits.truncated&&Object.values(e.dependencies).every(d=>d.status==="complete");

/** Canonical single fresh dispatch, including an explicit null or rejection.
 * No inferred alignment is ever returned as an observed receipt. */
export function circleDispatch(trace:ReplayTrace,q:InputRecord){
  const index=rejectedInitiatingTraceIndex(trace),next=index.inputs[index.inputPositions.get(q.id)!+1],
    records=trace.records.slice(q.sequence+1,next?.sequence??trace.records.length),
    attempts=records.filter((r):r is Extract<ReplayTraceRecord,{kind:"attempt"}>=>r.kind==="attempt"&&r.inputId===q.id);
  if(q.freshActions.length!==1||attempts.length!==1)return;
  const a=attempts[0],routes=records.filter(r=>(r.kind==="selection"||r.kind==="policy")&&r.attemptId===a.id),s=routes[0],p=routes[1],receipt=index.resolutionsByAttempt.get(a.id);
  if(a.automated||a.attemptOrdinal!==0||!same(a.actionCandidates,q.freshActions)||a.knownAction!==undefined&&a.knownAction!==q.freshActions[0]||
    a.timeMs!==q.timeMs||a.sequence<=q.sequence||s?.kind!=="selection"||s.timeMs!==q.timeMs||s.sequence<=a.sequence)return;
  if(s.componentId===null){if(routes.length!==1||s.component!==undefined||s.inside!==null||s.eligible||s.selectionStopped||receipt)return;}
  else if(routes.length!==2||s.component!=="circle"||!s.inside||!s.eligible||!s.selectionStopped||p?.kind!=="policy"||
    p.componentId!==s.componentId||p.branch!=="stable:STABLE"||p.timeMs!==q.timeMs||p.sequence<=s.sequence||
    p.state==="rejected"&&(receipt||!p.blockerId)||p.state==="allowed"&&p.blockerId!==undefined)return;
  const resolutions=records.filter(r=>r.kind==="resolution"&&r.triggerAttemptId===a.id);
  if(resolutions.length!==(receipt?1:0)||receipt&&(p?.kind!=="policy"||receipt.sequence<=p.sequence||receipt.timeMs!==q.timeMs||receipt.id!==resolutions[0].id))return;
  return {attempt:a,selection:s,policy:p?.kind==="policy"?p:undefined,receipt,eventIds:[a.id,...routes.map(r=>r.id),...(receipt?[receipt.id]:[])]};
}

export function observedCircleReceipt(e:CircleEvidence,map:Beatmap,trace:ReplayTrace){
  if(!completeCircle(e)||e.terminal?.mechanism!=="successful-input"||e.terminal.result==="MISS")return;
  const index=rejectedInitiatingTraceIndex(trace),a=index.byId.get(e.terminal.triggerAttemptId??""),q=a?.kind==="attempt"?index.byId.get(a.inputId):undefined,
    object=map.getHitObject(e.targetId),g=e.geometry!;
  if(q?.kind!=="input"||!(object instanceof HitCircle)||object.sliderId||g.position.x!==object.position.x||g.position.y!==object.position.y||
    g.radius!==Math.fround(stableGameplayRadius(object.radius))||!stableWithinHitRadius(object.position,q.position,stableGameplayRadius(object.radius)))return;
  const d=circleDispatch(trace,q),expected=["MISS","MEH","OK","GREAT"][grade(q.timeMs-object.hitTime,g.hitWindows)];
  if(!d||d.receipt?.id!==e.terminal.id||d.selection.componentId!==object.id||d.policy?.state!=="allowed"||d.policy.timingResult!==expected||
    d.policy.offsetMs!==q.timeMs-object.hitTime||e.terminal.result!==expected||d.receipt.sequence<=d.policy.sequence||d.receipt.timeMs!==q.timeMs)return;
  return {input:q,...d};
}

export interface CircleRetiming {
  basis:"bounded-circle-sequence-control";
  moves:{componentId:string;inputId:string;sampleId:string;timeMs:number;action:number;beforeResult:string;afterResult:string}[];
  changes:{inputId:string;actions:number[]}[];
  shortenedHolds:{inputId:string;releaseId:string;actualReceiptId:string}[];
  removedRejections:{inputId:string;componentId:string;blockerId:string;timeMs:number;policyId:string}[];
  sourceSpan:{startInputId:string;endInputId:string;frameCount:number};
  history:{throughInputId:string;converged:true};
  prefix:{parentCount:number;latestTerminalId?:string};
  eventIds:string[];
}

/** Sufficient multi-note control for consecutive standalone Stable circles.
 * Every replacement has a clear prefix, a sampled in-circle success, and a
 * nondegrading grade. There are no retained fresh attempts while earlier
 * resolutions differ. Bodies/heads are excluded until histories reconverge.
 * This proves a particular control, not a player's intended allocation. */
export function certifyCircleRetiming(map:Beatmap,trace:ReplayTrace,plan:readonly {componentId:string;inputId:string;sampleId:string}[],excluded:ReadonlySet<string>=new Set()):CircleRetiming|undefined{
  const caps=errorCapabilities(map,trace.identity.analysisProfileId),index=rejectedInitiatingTraceIndex(trace);
  if(trace.identity.analysisProfileId!=="stable"||caps.aim!=="manual"||caps.tapping!=="manual"||caps.geometry!=="supported"||caps.scoring!=="supported"||
    trace.identity.schemaVersion!==2||trace.droppedRecordBoundary!==undefined||trace.records.length>trace.limits.maxRecords||
    trace.failures.some(s=>s!=="global-totals-mismatch"&&!s.startsWith("dependency-conflict:"))||plan.length<2||plan.length>12)return;
  if(trace.records.some((r,k)=>r.sequence!==k||index.byId.get(r.id)!==r))return;
  const firstObject=map.hitObjects.findIndex(o=>o.id===plan[0].componentId),objects=map.hitObjects.slice(firstObject,firstObject+plan.length);
  if(firstObject<0||firstObject>4096||objects.length!==plan.length||objects.some((o,k)=>!(o instanceof HitCircle)||o.sliderId||o.id!==plan[k].componentId)||
    objects.some((o,k)=>k>0&&((o as HitCircle).hitTime<=(objects[k-1] as HitCircle).hitTime+3||o.spawnTime<=objects[k-1].spawnTime)))return;
  const es=objects.map(o=>deriveCircleEvidence(trace,map,o.id));if(es.some(e=>!completeCircle(e)))return;
  const all=index.inputs,rows=plan.map(p=>({p,old:index.inputPositions.get(p.inputId)??-1,dest:index.inputPositions.get(p.sampleId)??-1}));
  if(rows.some((r,k)=>r.old<1||r.dest<1||r.dest>=r.old||k>0&&(r.old<=rows[k-1].old||r.dest<=rows[k-1].dest+1))||
    new Set(plan.map(p=>p.inputId)).size!==plan.length)return;
  const first=rows[0].dest,lastOld=rows[rows.length-1].old,ids=new Set<string>(),components=new Set(objects.map(o=>o.id)),prefix=map.hitObjects.slice(0,firstObject),ends=prefix.map(o=>index.terminals.get(o.id));
  if(ends.some(r=>!r||r.sequence>=all[first].sequence))return;
  prefix.forEach(o=>{components.add(o.id);if(o instanceof Slider)components.add(o.head.id);});
  const moved=new Set(plan.map(p=>p.inputId)),masks=new Map<number,number>(),value=(k:number)=>masks.get(k)??mask(all[k]);
  if(es.some(e=>e.terminal!.sequence>=all[lastOld].sequence||(e.terminal!.result==="MISS"?e!==es[0]||e.terminal!.mechanism!=="automatic-expiry":
    !observedCircleReceipt(e,map,trace)||!moved.has(observedCircleReceipt(e,map,trace)!.input.id))))return;
  const moves:CircleRetiming["moves"]=[],shortenedHolds:CircleRetiming["shortenedHolds"]=[],removedRejections:CircleRetiming["removedRejections"]=[];
  let earliestHold=first;
  for(let j=0;j<rows.length;j++){
    const {old,dest}=rows[j],q=all[old],sample=all[dest],e=es[j],object=objects[j] as HitCircle,d=circleDispatch(trace,q),end=e.terminal!,g=e.geometry!;
    if(!d||sample.timeMs<=object.spawnTime||sample.sequence>=end.sequence||Math.abs(sample.timeMs-object.hitTime)>=g.hitWindows[2]||
      !stableWithinHitRadius(object.position,sample.position,stableGameplayRadius(object.radius))||
      g.position.x!==object.position.x||g.position.y!==object.position.y||g.radius!==Math.fround(stableGameplayRadius(object.radius)))return;
    const activation=index.activations.get(object.id);if(!activation||activation.sequence>=sample.sequence)return;
    for(const other of map.hitObjects){
      const circle=other instanceof HitCircle?other:other instanceof Slider?other.head:undefined;
      if(!circle||circle.id===object.id||objects.slice(0,j).some(o=>o.id===circle.id))continue;
      if(circle.spawnTime>=sample.timeMs||sample.timeMs>circle.hitTime+g.hitWindows[2]+1||
        !stableWithinHitRadius(circle.position,sample.position,stableGameplayRadius(circle.radius)))continue;
      const active=index.activations.get(circle.id),resolved=index.terminals.get(circle.id);
      components.add(circle.id);if(circle.sliderId)components.add(circle.sliderId);
      if(active?.kind!=="lifecycle"||active.transition!=="activated")return;
      ids.add(active.id);if(resolved)ids.add(resolved.id);
      if(active.sequence<activation.sequence&&(!resolved||resolved.sequence>=sample.sequence))return;
    }
    const received=d.receipt;
    if(received&&(received.kind!=="resolution"||received.mechanism!=="successful-input"||!objects.some(o=>o.id===received.componentId)))return;
    if(d.policy?.state==="rejected")removedRejections.push({inputId:q.id,componentId:d.policy.componentId,blockerId:d.policy.blockerId!,timeMs:q.timeMs,policyId:d.policy.id});
    const before=end.result,after=grade(sample.timeMs-object.hitTime,g.hitWindows),original=before==="GREAT"?3:before==="OK"?2:before==="MEH"?1:0;
    if(!after||after<original)return;
    const action=q.freshActions[0],release=all.findIndex((r,k)=>k>old&&!r.actions.includes(action));if(release<0||release-first>4096)return;
    for(let k=old;k<release;k++)masks.set(k,value(k)&~(1<<action));
    moves.push({componentId:object.id,inputId:q.id,sampleId:sample.id,timeMs:sample.timeMs,action,beforeResult:before,afterResult:["MISS","MEH","OK","GREAT"][after]});
    [activation.id,end.id,...d.eventIds].forEach(id=>ids.add(id));
  }
  // Every changed successful receipt belongs to the explicit related set; its
  // old action is removed. An unconsumed null/rejected closing pulse is allowed.
  for(let k=first;k<=lastOld;k++)if(all[k].freshActions.length&&!moved.has(all[k].id))return;
  for(let j=0;j<rows.length;j++){
    const {dest}=rows[j],action=moves[j].action,bit=1<<action;
    if(value(dest-1)&bit||value(dest)&bit){
      let start=dest-1;while(start>=0&&dest-start<=4096&&!all[start].freshActions.includes(action))start--;
      const q=all[start],d=q&&circleDispatch(trace,q),receipt=d?.receipt;
      if(!q||!d||receipt?.kind!=="resolution"||receipt.mechanism!=="successful-input"||receipt.sequence>=all[dest-1].sequence||
        dest-start>4096||!prefix.some(o=>o.id===receipt.componentId)||moved.has(q.id)||
        !observedCircleReceipt(deriveCircleEvidence(trace,map,receipt.componentId),map,trace))return;
      const release=all.findIndex((r,k)=>k>start&&!r.actions.includes(action));if(release<dest)return;
      for(let k=dest-1;k<release;k++)masks.set(k,value(k)&~bit);
      shortenedHolds.push({inputId:q.id,releaseId:all[dest-1].id,actualReceiptId:receipt.id});ids.add(receipt.id);
      earliestHold=Math.min(earliestHold,start-1);
    }
    if(value(dest+1)&bit)return;
    masks.set(dest,value(dest)|bit);
  }
  const changed=[...masks].filter(([k,v])=>v!==mask(all[k])).sort((a,b)=>a[0]-b[0]);if(!changed.length||changed[0][0]<1)return;
  const begin=changed[0][0],last=changed[changed.length-1][0],expected=new Map(rows.map((r,k)=>[r.dest,1<<moves[k].action]));
  for(let k=begin;k<=Math.max(last+1,lastOld);k++){
    const actualFresh=value(k)&~value(k-1),originalFresh=mask(all[k])&~mask(all[k-1]),wanted=expected.get(k)??(moved.has(all[k].id)?0:originalFresh);
    if(actualFresh!==wanted||actualFresh===3)return;
  }
  const past:number[]=[];let seed=begin-1;
  for(;seed>=0&&begin-seed<=4096;seed--){const v=mask(all[seed]);if(!past.length||past[past.length-1]!==v)past.push(v);if(past.length===3)break;}
  if(begin-seed>4096||past.length<3&&!trace.domain.initialActionsKnown)return;seed=Math.max(seed,0);while(past.length<3)past.push(0);
  const oldHistory=past.slice(),newHistory=past.slice(),step=(h:number[],v:number)=>{if(h[0]!==v){h[2]=h[1];h[1]=h[0];h[0]=v;}};
  let convergence=-1;
  for(let k=begin;k<all.length&&k-seed<=4096;k++){step(oldHistory,mask(all[k]));step(newHistory,value(k));if(k>last&&same(oldHistory,newHistory)&&oldHistory.every((v,j)=>v===newHistory[j])){convergence=k;break;}}
  if(convergence<0||all[convergence].timeMs-all[first].timeMs>1600)return;
  seed=Math.min(seed,earliestHold);const through=Math.max(convergence,lastOld);if(seed<0||through-seed+1>4096)return;
  const span=all.slice(seed,through+1);
  for(let k=0;k<span.length;k++){
    const q=span[k],p=span[k-1];
    if(q.source.origin!=="parsed"||!Number.isSafeInteger(q.source.parsedFrameIndex)||q.source.parsedFrameIndex<0||q.source.discontinuityBefore?.length||
      ![q.timeMs,q.position.x,q.position.y].every(Number.isFinite)||q.timeMs>trace.domain.endTimeMs||
      [q.actions,q.previousActions,q.freshActions].some(a=>new Set(a).size!==a.length||a.some(v=>v!==0&&v!==1))||
      !same(q.freshActions,q.actions.filter(a=>!q.previousActions.includes(a)))||
      q.source.rawTokenIndex!==undefined&&(!Number.isSafeInteger(q.source.rawTokenIndex)||q.source.rawTokenIndex<0)||
      q.rawButtonMask!==undefined&&(!Number.isSafeInteger(q.rawButtonMask)||q.rawButtonMask<0||q.rawButtonMask>31||!same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])]))||
      p&&(p.source.origin!=="parsed"||q.timeMs<=p.timeMs||q.timeMs-p.timeMs>100||q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||!same(q.previousActions,p.actions)||
        (q.source.rawTokenIndex!==undefined||p.source.rawTokenIndex!==undefined)&&(q.source.rawTokenIndex===undefined||p.source.rawTokenIndex===undefined||q.source.rawTokenIndex!==p.source.rawTokenIndex+1)))return;
    ids.add(q.id);
  }
  // The corrected and original circle resolution sets have converged at the
  // last removed attempt. With no retained attempt before then, no external
  // receiver can gain/lose a judgement. Removed rejected callbacks and their
  // downstream Notelock metadata remain explicit related consequences.
  // A long object's state requires a separate proof.
  for(const rejected of removedRejections){
    const policy=index.byId.get(rejected.policyId);
    components.add(rejected.componentId);components.add(rejected.blockerId);
    // Removing the first saved rejection can expose a later one. That needs
    // a replacement-metadata proof, beyond this sufficient removal control.
    if(policy?.kind==="policy"&&["GREAT","OK","MEH"].includes(policy.timingResult??"")&&trace.records.some(r=>
      r.kind==="policy"&&r.componentId===rejected.componentId&&r.sequence>policy.sequence&&r.state==="rejected"&&
      ["GREAT","OK","MEH"].includes(r.timingResult??"")))return;
  }
  for(const o of map.hitObjects)if(!(o instanceof HitCircle)){
    const end=index.terminals.get(o.id);if(end&&end.sequence<all[begin].sequence)continue;
    if(o.startTime<=all[through].timeMs||o instanceof Slider&&o.head.spawnTime<=all[through].timeMs)return;
  }
  if([...components].some(id=>excluded.has(id)||[...trace.failures,...trace.domain.sourceCoverageLimits].some(s=>s.startsWith("dependency-conflict:")&&s.endsWith(":"+id))))return;
  const latest=ends.reduce<ReplayTraceRecord|undefined>((a,b)=>!a||b!.sequence>a.sequence?b:a,undefined);if(latest)ids.add(latest.id);
  return {basis:"bounded-circle-sequence-control",moves,changes:changed.map(([k,v])=>({inputId:all[k].id,actions:[...(v&1?[0]:[]),...(v&2?[1]:[])]})),shortenedHolds,removedRejections,
    sourceSpan:{startInputId:span[0].id,endInputId:span[span.length-1].id,frameCount:span.length},history:{throughInputId:all[convergence].id,converged:true},
    prefix:{parentCount:prefix.length,latestTerminalId:latest?.id},eventIds:[...ids]};
}
