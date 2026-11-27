import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { InputRecord, deriveCircleEvidence } from "../miss-explanation/CircleEvidence";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import { stableGameplayRadius, stableWithinHitRadius } from "../StableHitGeometry";
import { stableHitWindowsForOD } from "../StableDifficulty";
import { StableSliderTiming } from "../StableSliderTiming";
import { completeCircle, observedCircleReceipt } from "./BoundedCircleRetiming";
import { errorCapabilities } from "./ErrorCapabilities";
import { rejectedInitiatingTraceIndex } from "./InterceptionChain";
import { trackingPreservationIndex } from "./TrackingPreservationIndex";
import { certifyStableMaskPreservation } from "./StableHoldPreservation";
type Attempt=Extract<ReplayTraceRecord,{kind:"attempt"}>;
type Selection=Extract<ReplayTraceRecord,{kind:"selection"}>;
type Policy=Extract<ReplayTraceRecord,{kind:"policy"}>;
type Resolution=Extract<ReplayTraceRecord,{kind:"resolution"}>;
const same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(v=>b.includes(v));
const mask=(q:InputRecord)=>q.actions.reduce((v,a)=>v|(1<<a),0);
const rank=(s:string)=>["MISS","MEH","OK","GREAT"].indexOf(s);
/** Canonical observed callback packets, separate from virtual controls. */
export function receptorPacket(trace:ReplayTrace,q:InputRecord){
 if(trace.identity.analysisProfileId!=="stable")return;
 const ix=rejectedInitiatingTraceIndex(trace),at=ix.inputPositions.get(q.id);
 if(at===undefined||ix.byId.get(q.id)!==q)return;
 const next=ix.inputs[at+1],records=trace.records.slice(q.sequence+1,next?.sequence??trace.records.length),
  attempts=records.filter((r):r is Attempt=>r.kind==="attempt"&&r.inputId===q.id);
 if(!q.freshActions.length||q.freshActions.length>2||attempts.length!==q.freshActions.length||
  records.some(r=>r.kind==="attempt"&&r.inputId!==q.id||(r.kind==="selection"||r.kind==="policy")&&!attempts.some(a=>a.id===r.attemptId)||
   r.kind==="resolution"&&(r.mechanism==="successful-input"||r.mechanism==="input-miss")&&!attempts.some(a=>a.id===r.triggerAttemptId)))return;
 const rows:Array<{attempt:Attempt;selection:Selection;policy?:Policy;receipt?:Resolution;eventIds:string[]}>=[];let after=q.sequence;
 for(let k=0;k<attempts.length;k++){
  const a=attempts[k],routes=records.filter(r=>(r.kind==="selection"||r.kind==="policy")&&r.attemptId===a.id),s=routes[0],p=routes[1],
   receipts=records.filter((r):r is Resolution=>r.kind==="resolution"&&r.triggerAttemptId===a.id),r=receipts[0];
  if(a.automated||a.attemptOrdinal!==k||a.timeMs!==q.timeMs||a.sequence<=after||!same(a.actionCandidates,q.freshActions)||
   (q.freshActions.length===1?a.knownAction!==undefined&&a.knownAction!==q.freshActions[0]:a.knownAction!==undefined)||
   s?.kind!=="selection"||s.timeMs!==q.timeMs||s.sequence<=a.sequence||receipts.length>1)return;
  if(s.componentId===null){if(routes.length!==1||s.component!==undefined||s.inside!==null||s.eligible||s.selectionStopped||r)return;}
  else if(routes.length!==2||!["circle","slider-head"].includes(s.component??"")||!s.inside||!s.eligible||!s.selectionStopped||
   p?.kind!=="policy"||p.componentId!==s.componentId||p.branch!=="stable:STABLE"||p.timeMs!==q.timeMs||p.sequence<=s.sequence||
   p.state==="rejected"&&(!!r||!p.blockerId)||p.state==="allowed"&&p.blockerId!==undefined||p.state!=="allowed"&&p.state!=="rejected")return;
  if(p?.kind==="policy"&&p.state==="allowed"&&p.timingResult!==null&&!r)return;
  if(r&&(p?.kind!=="policy"||p.state!=="allowed"||r.sequence<=p.sequence||r.timeMs!==q.timeMs||r.componentId!==s.componentId||
   r.component!==s.component||r.result!==p.timingResult||!r.previousUnresolved||!["successful-input","input-miss"].includes(r.mechanism)))return;
  after=r?.sequence??p?.sequence??s.sequence;
  rows.push({attempt:a,selection:s,policy:p?.kind==="policy"?p:undefined,receipt:r,eventIds:[a.id,...routes.map(r=>r.id),...receipts.map(r=>r.id)]});
 }
 return rows;
}
export interface ReceptorMove {componentId:string;inputId:string;sampleId:string;preserveHold?:boolean}

/** A bounded multi-note control. Successful repair is not itself a diagnosis. */
export function certifyReceptorRetiming(map:Beatmap,trace:ReplayTrace,plan:readonly ReceptorMove[],excluded:ReadonlySet<string>=new Set()){
 const caps=errorCapabilities(map,trace.identity.analysisProfileId),ix=rejectedInitiatingTraceIndex(trace),ti=trackingPreservationIndex(trace),
  all=ix.inputs,windows=stableHitWindowsForOD(map.stableOverallDifficulty);
 if(trace.identity.analysisProfileId!=="stable"||trace.identity.schemaVersion!==2||trace.droppedRecordBoundary!==undefined||
  caps.aim!=="manual"||caps.tapping!=="manual"||caps.geometry!=="supported"||caps.scoring!=="supported"||plan.length<2||plan.length>12||
  trace.records.length>trace.limits.maxRecords||trace.failures.some(s=>s!=="global-totals-mismatch"&&!s.startsWith("dependency-conflict:"))||
  trace.records.some((r,k)=>r.sequence!==k||ix.byId.get(r.id)!==r)||all.length!==trace.records.filter(r=>r.kind==="input").length)return;
 const firstParent=map.hitObjects.findIndex(o=>o.id===plan[0].componentId||o instanceof Slider&&o.head.id===plan[0].componentId),
  parents=map.hitObjects.slice(firstParent,firstParent+plan.length),objects=parents.map(o=>o instanceof HitCircle?o:o instanceof Slider?o.head:undefined);
 if(firstParent<0||firstParent>4096||objects.length!==plan.length||objects.some((o,k)=>!o||o.id!==plan[k].componentId)||
  objects.some((o,k)=>k>0&&o!.hitTime<=objects[k-1]!.hitTime+3))return;
 const es=objects.map(o=>deriveCircleEvidence(trace,map,o!.id));
 if(es.some(e=>!completeCircle(e)||e.geometry!.hitWindows.some((w,k)=>w!==windows[k])))return;
 const rows=plan.map((p,k)=>({p,o:objects[k]!,e:es[k],old:ix.inputPositions.get(p.inputId)??-1,dest:ix.inputPositions.get(p.sampleId)??-1}));
 if(new Set(plan.map(p=>p.inputId)).size!==plan.length||new Set(plan.map(p=>p.sampleId)).size!==plan.length||
  rows.some((r,k)=>r.old<1||r.dest<1||r.dest>=r.old||k>0&&(r.old<=rows[k-1].old||r.dest<=rows[k-1].dest)))return;
 const moved=new Set(plan.map(p=>p.inputId)),components=new Set<string>(),ids=new Set<string>(),prefix=map.hitObjects.slice(0,firstParent),
  masks=new Map<number,number>(),value=(k:number)=>masks.get(k)??mask(all[k]),
  moves:Array<ReceptorMove&{timeMs:number;action:number;oldReleaseId:string;beforeResult:string;afterResult:string}>=[],
  shortened:Array<{inputId:string;releaseId:string;actualReceiptId:string}>=[],
  removedRejections:Array<{inputId:string;componentId:string;blockerId:string;timeMs:number;policyId:string}>=[];
 let earliestHold=rows[0].dest;
 const result=(offset:number)=>["GREAT","OK","MEH"].find((_,k)=>Math.abs(offset)<=windows[k])??(Math.abs(offset)<=windows[3]?"MISS":null);
 for(const r of rows){
  const q=all[r.old],sample=all[r.dest],packet=receptorPacket(trace,q),end=r.e.terminal!,g=r.e.geometry!;
  if(q.freshActions.length!==1||packet?.length!==1||sample.timeMs<=r.o.spawnTime||sample.sequence>=end.sequence||
   Math.abs(sample.timeMs-r.o.hitTime)>=windows[2]||!stableWithinHitRadius(r.o.position,sample.position,stableGameplayRadius(r.o.radius))||
   g.position.x!==r.o.position.x||g.position.y!==r.o.position.y||g.radius!==Math.fround(stableGameplayRadius(r.o.radius))||
   r.o.sliderId&&!r.p.preserveHold||end.result==="MISS"&&(r!==rows[0]||end.mechanism!=="automatic-expiry")||
   end.result!=="MISS"&&end.mechanism!=="successful-input")return;
  if(packet[0].receipt&&!objects.some(o=>o!.id===packet[0].receipt!.componentId))return;
  if(packet[0].selection.componentId!==null){const selected=map.getHitCircle(packet[0].selection.componentId);
   if(!selected||!stableWithinHitRadius(selected.position,q.position,stableGameplayRadius(selected.radius))||
    packet[0].policy!.offsetMs!==q.timeMs-selected.hitTime||packet[0].policy!.timingResult!==result(q.timeMs-selected.hitTime))return;}
  const after=result(sample.timeMs-r.o.hitTime)!;if(rank(after)<Math.max(1,rank(end.result)))return;
  const activation=ix.activations.get(r.o.id);if(!activation||activation.sequence>=sample.sequence)return;
  let release=r.old+1;while(release<all.length&&all[release].actions.includes(q.freshActions[0]))release++;
  if(release>=all.length||release-r.dest>4096)return;
  const action=q.freshActions[0];for(let k=r.old;k<release;k++)masks.set(k,value(k)&~(1<<action));
  const rejected=packet[0].policy;
  if(rejected?.state==="rejected"){
   components.add(rejected.componentId);components.add(rejected.blockerId!);
   if(["GREAT","OK","MEH"].includes(rejected.timingResult??"")&&trace.records.some(p=>p.kind==="policy"&&p.componentId===rejected.componentId&&
    p.sequence>rejected.sequence&&p.state==="rejected"&&["GREAT","OK","MEH"].includes(p.timingResult??"")))return;
   removedRejections.push({inputId:q.id,componentId:rejected.componentId,blockerId:rejected.blockerId!,timeMs:q.timeMs,policyId:rejected.id});
  }
  moves.push({...r.p,timeMs:sample.timeMs,action,oldReleaseId:all[release].id,beforeResult:end.result,afterResult:after});
  components.add(r.o.id);components.add(parents[rows.indexOf(r)].id);ids.add(activation.id);ids.add(end.id);packet[0].eventIds.forEach(id=>ids.add(id));
 }
 for(let j=0;j<rows.length;j++){
  const r=rows[j],action=moves[j].action,bit=1<<action,dest=r.dest,release=ix.inputPositions.get(moves[j].oldReleaseId)!;
  if(value(dest-1)&bit){
   let start=dest-1;while(start>=0&&dest-start<=4096&&!all[start].freshActions.includes(action))start--;
   const q=all[start],packet=q&&receptorPacket(trace,q),received=packet?.[0].receipt;
   if(!q||packet?.length!==1||received?.mechanism!=="successful-input"||received.sequence>=all[dest-1].sequence||moved.has(q.id)||
    !prefix.some(o=>o instanceof HitCircle&&o.id===received.componentId)||
    observedCircleReceipt(deriveCircleEvidence(trace,map,received.componentId),map,trace)?.receipt?.id!==received.id)return;
   let end=start+1;while(end<all.length&&all[end].actions.includes(action))end++;if(end<dest)return;
   for(let k=dest-1;k<end;k++)masks.set(k,value(k)&~bit);
   shortened.push({inputId:q.id,releaseId:all[dest-1].id,actualReceiptId:received.id});ids.add(received.id);earliestHold=Math.min(earliestHold,Math.max(0,start-1));
  }
  if(value(dest)&bit)return;
  const end=r.p.preserveHold?release:dest+1;for(let k=dest;k<end;k++)masks.set(k,value(k)|bit);
 }
 const changed=[...masks].filter(([k,v])=>v!==mask(all[k])).sort((a,b)=>a[0]-b[0]);if(!changed.length||changed[0][0]<1)return;
 const begin=changed[0][0],last=changed[changed.length-1][0],lastOld=rows[rows.length-1].old,
  destination=new Map(rows.map((r,k)=>[r.dest,k] as const)),expected=new Map(rows.map((r,k)=>[r.dest,1<<moves[k].action] as const));
 for(let k=begin;k<=Math.max(last+1,lastOld);k++){
  const original=mask(all[k])&~mask(all[k-1]),wanted=(moved.has(all[k].id)?0:original)|(expected.get(k)??0);
  if((value(k)&~value(k-1))!==wanted)return;
 }
 const past:number[]=[];let seed=begin-1;
 for(;seed>=0&&begin-seed<=4096;seed--){const v=mask(all[seed]);if(!past.length||past[past.length-1]!==v)past.push(v);if(past.length===3)break;}
 if(begin-seed>4096||past.length<3&&!trace.domain.initialActionsKnown)return;seed=Math.max(seed,0);while(past.length<3)past.push(0);
 const oldHistory=past.slice(),newHistory=past.slice(),step=(h:number[],v:number)=>{if(h[0]!==v){h[2]=h[1];h[1]=h[0];h[0]=v;}};
 let convergence=-1;
 for(let k=begin;k<all.length&&k-seed<=4096;k++){
  step(oldHistory,mask(all[k]));step(newHistory,value(k));
  if(k>last&&oldHistory.every((v,j)=>v===newHistory[j])){convergence=k;break;}
 }
 if(convergence<0||all[convergence].timeMs-all[begin].timeMs>1600)return;seed=Math.min(seed,earliestHold);
 const through=Math.max(convergence,lastOld);if(through-seed+1>4096||rows.some(r=>r.e.terminal!.sequence>=all[lastOld].sequence))return;
 const validSources=(start:number,end:number)=>{
  const span=all.slice(start,end+1);
  for(let k=0;k<span.length;k++){
   const q=span[k],p=span[k-1];
   if(q.source.origin!=="parsed"||!Number.isSafeInteger(q.source.parsedFrameIndex)||q.source.parsedFrameIndex<0||q.source.discontinuityBefore?.length||
    ![q.timeMs,q.position.x,q.position.y].every(Number.isFinite)||q.timeMs>trace.domain.endTimeMs||
    [q.actions,q.previousActions,q.freshActions].some(a=>new Set(a).size!==a.length||a.some(v=>v!==0&&v!==1))||
    !same(q.freshActions,q.actions.filter(a=>!q.previousActions.includes(a)))||
    q.source.rawTokenIndex!==undefined&&(!Number.isSafeInteger(q.source.rawTokenIndex)||q.source.rawTokenIndex<0)||
    q.rawButtonMask!==undefined&&(!Number.isSafeInteger(q.rawButtonMask)||q.rawButtonMask<0||q.rawButtonMask>31||
     !same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])]))||
    p&&(p.source.origin!=="parsed"||q.timeMs<=p.timeMs||q.timeMs-p.timeMs>100||q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||
     !same(q.previousActions,p.actions)||(q.source.rawTokenIndex!==undefined||p.source.rawTokenIndex!==undefined)&&
      (q.source.rawTokenIndex===undefined||p.source.rawTokenIndex===undefined||q.source.rawTokenIndex!==p.source.rawTokenIndex+1)))return false;
   ids.add(q.id);
  }return true;
 };
 if(!validSources(seed,through))return;
 const related=new Set(objects.map(o=>o!.id)),virtualResolved=new Set<string>(),
  circles=map.hitObjects.flatMap(o=>o instanceof HitCircle?[o]:o instanceof Slider?[o.head]:[]);
 if(circles.some(o=>!ix.activations.get(o.id)&&o.spawnTime<all[through].timeMs))return;
 for(let n=circles.length-1;n>=0;n--)if(!ix.activations.get(circles[n].id))circles.splice(n,1);
 circles.sort((a,b)=>ix.activations.get(a.id)!.sequence-ix.activations.get(b.id)!.sequence);
 const terminalOf=(id:string)=>{const r=ix.terminals.get(id);if(r)ids.add(r.id);return r;},
  resolved=(id:string,q:InputRecord)=>virtualResolved.has(id)||!related.has(id)&&!!terminalOf(id)&&terminalOf(id)!.sequence<q.sequence,
  callbackMap=new Map<string,{componentId:string;inputId:string;eventIds:string[]}>(),
  attemptInputs=new Map(trace.records.flatMap(r=>r.kind==="attempt"?[[r.id,r.inputId] as const]:[]));
 for(const o of map.hitObjects)if(o instanceof Slider)for(const p of ti.headPolicies.get(o.head.id)??[])
  if(p.kind==="policy"&&["GREAT","OK","MEH","MISS"].includes(p.timingResult??"")){
   const inputId=attemptInputs.get(p.attemptId);if(!inputId)return;callbackMap.set(o.head.id+":"+inputId,{componentId:o.head.id,inputId,eventIds:[p.id]});
  }
 const queried=new Set<string>(),retained:Array<{componentId:string;inputId:string;ordinal:number;result:string}>=[];
 for(let k=begin;k<=through;k++){
  const q=all[k],fresh=value(k)&~value(k-1),oldPacket=q.freshActions.length?receptorPacket(trace,q):[];
  if(q.freshActions.length&&!oldPacket)return;
  for(const o of map.hitObjects)if(o instanceof Slider)callbackMap.delete(o.head.id+":"+q.id);
  const actual=moved.has(q.id)?[]:oldPacket!,j=destination.get(k),
   wanted=[...actual.map(a=>({actual:a,componentId:a.selection.componentId})),...(j===undefined?[]:[{move:j,componentId:rows[j].o.id}])];
  if(wanted.length!==(fresh&1?1:0)+(fresh&2?1:0))return;
  if(j!==undefined&&actual.some(a=>a.receipt?.mechanism!=="successful-input"||a.selection.component!=="circle"||related.has(a.receipt.componentId)))return;
  for(let ordinal=0;ordinal<wanted.length;ordinal++){
   const w=wanted[ordinal],selected=circles.find(o=>{
    const active=ix.activations.get(o.id)!;ids.add(active.id);components.add(o.id);if(o.sliderId)components.add(o.sliderId);
    return active.sequence<q.sequence&&!resolved(o.id,q)&&(!o.sliderId||!((terminalOf(o.sliderId)?.sequence??Infinity)<q.sequence))&&
     q.timeMs<=o.hitTime+windows[2]+1&&stableWithinHitRadius(o.position,q.position,stableGameplayRadius(o.radius));
   });
   if((selected?.id??null)!==w.componentId)return;
   if(!selected){if(!("actual" in w)||w.actual.policy||w.actual.receipt)return;continue;}
   const parent=selected.sliderId??selected.id,parentAt=map.hitObjects.findIndex(o=>o.id===parent),
    blocker=map.hitObjects.slice(0,parentAt).find(o=>{
     components.add(o.id);const terminal=terminalOf(o.id);
     if(o instanceof HitCircle?resolved(o.id,q):terminal&&terminal.sequence<q.sequence)return false;
     const end=o instanceof HitCircle?o.hitTime:o instanceof Slider?new StableSliderTiming(o).endTime:o.endTime;return end+3<selected.hitTime;
    }),timing=result(q.timeMs-selected.hitTime),actualRow="actual" in w?w.actual:undefined,
    witnesses=[q.id,ix.activations.get(selected.id)!.id,...(actualRow?.eventIds??[]),...(j===undefined?[]:[rows[j].e.terminal!.id])];
   witnesses.forEach(id=>ids.add(id));
   if("move" in w){if(blocker||timing!==moves[w.move].afterResult||rank(timing??"MISS")<1)return;queried.add(selected.id);}
   else if(actualRow?.selection.component!==(selected.sliderId?"slider-head":"circle")||!actualRow?.policy||actualRow.policy.state!==(blocker?"rejected":"allowed")||actualRow.policy.blockerId!==blocker?.id||
    actualRow.policy.timingResult!==timing||actualRow.policy.offsetMs!==q.timeMs-selected.hitTime)return;
   if(!blocker&&selected.sliderId&&timing!==null)callbackMap.set(selected.id+":"+q.id,{componentId:selected.id,inputId:q.id,eventIds:witnesses});
   if(!blocker&&timing!==null){
    if(actualRow&&(actualRow.receipt?.result!==timing||actualRow.receipt.mechanism!==(timing==="MISS"?"input-miss":"successful-input")))return;
    virtualResolved.add(selected.id);if(actualRow?.receipt)retained.push({componentId:selected.id,inputId:q.id,ordinal,result:timing});
   }else if(actualRow?.receipt)return;
  }
 }
 if(objects.some(o=>!queried.has(o!.id)))return;
 for(const r of rows)if(r.e.terminal!.result!=="MISS"){
  const a=ix.byId.get(r.e.terminal!.triggerAttemptId??"");if(a?.kind!=="attempt"||!moved.has(a.inputId))return;
 }
 const vector=new Map(changed.map(([k,v])=>[all[k].id,v] as const)),callbacks=[...callbackMap.values()],
  body:NonNullable<ReturnType<typeof certifyStableMaskPreservation>>[]=[];
 for(const o of map.hitObjects)if(!(o instanceof HitCircle)){
  const end=terminalOf(o.id);if(end&&end.sequence<all[begin].sequence)continue;
  if(!(o instanceof Slider)){if(o.startTime<=all[through].timeMs)return;continue;}
  if(o.startTime>all[through].timeMs&&o.head.spawnTime>all[through].timeMs)continue;
  components.add(o.id);components.add(o.head.id);(o.stableCheckPoints??o.checkPoints).forEach(c=>components.add(c.id));if(!end)return;
  const proof=certifyStableMaskPreservation(o,trace,all,vector,callbacks);if(!proof)return;body.push(proof);proof.eventIds.forEach(id=>ids.add(id));
  if(map.appliedMods.includes("SCORE_V2")&&rows.some((r,j)=>r.o.sliderId===o.id&&moves[j].beforeResult!==moves[j].afterResult))return;
 }
 const sourceThrough=Math.max(through,...body.map(p=>ix.inputPositions.get(p.throughInputId)!));
 if(sourceThrough-seed+1>4096||!validSources(seed,sourceThrough))return;
 if([...components].some(id=>excluded.has(id)||[...trace.failures,...trace.domain.sourceCoverageLimits].some(s=>s.startsWith("dependency-conflict:")&&s.endsWith(":"+id))))return;
 return {basis:"bounded-receptor-sequence-control" as const,moves,
  changes:changed.map(([k,v])=>({inputId:all[k].id,actions:[...(v&1?[0]:[]),...(v&2?[1]:[])]})),shortenedHolds:shortened,removedRejections,
  retainedReceipts:retained,headCallbacks:callbacks,bodyPreservation:body,history:{throughInputId:all[convergence].id,converged:true as const},
  sourceSpan:{startInputId:all[seed].id,endInputId:all[sourceThrough].id,frameCount:sourceThrough-seed+1},eventIds:[...ids]};
}
