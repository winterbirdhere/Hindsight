import { Beatmap } from "../../beatmap/Beatmap";
import { ReplayFrame } from "../../replays/Replay";
import { defaultGameState, GameState, HitCircleVerdict } from "../GameState";
import { GameStateEvaluator } from "../GameStateEvaluator";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import { createReplayTraceCollector } from "../trace/ReplayTraceCollector";
import { beginCanonicalTrace } from "../trace/ReplayTraceObserver";
import { errorCapabilities } from "./ErrorCapabilities";

export interface CanonicalControlPlan {
 targetId:string;
 /** Caller supplies an observed causal graph, never a time-neighbourhood. */
 relatedComponentIds:string[];
 /** A named initiating correction may improve a successful receiver. */
 improvedReceiptIds?:string[];
 changes:Array<{inputId:string;position?:{x:number;y:number};actions?:number[]}>;
 /** Hypothetical linear sample strictly between two unchanged source positions. */
 insertions?:Array<{beforeInputId:string;timeMs:number;actions:number[]}>;
}
export interface CanonicalControl {
 basis:"canonical-model-counterfactual";
 changes:Array<{inputId:string;before:ReplayFrame;after:ReplayFrame}>;
 reconstructedInputs:Array<{leftInputId:string;rightInputId:string;timeMs:number;fraction:number;position:{x:number;y:number};actions:number[];basis:"linear-between-recorded-inputs"}>;
 outcomes:Array<{componentId:string;before:HitCircleVerdict;after:HitCircleVerdict}>;
 parentOutcomes:Array<{componentId:string;before:string;after:string;judgementTime:number}>;
 relatedComponentIds:string[];
 addedFreshActions:number;
 historyConvergedAtInputId:string;
 baseline:"exact-observed-trace";
 preservation:"every-source-update-and-complete-dispatch";
 eventIds:string[];
}
type Input=Extract<ReplayTraceRecord,{kind:"input"}>;
type Baseline={inputs:Input[];frames:ReplayFrame[];state:GameState;updates:string[][];packets:Map<number,ReplayTraceRecord[]>};
const baselines=new WeakMap<ReplayTrace,WeakMap<Beatmap,Baseline|null>>();
const json=(x:unknown)=>JSON.stringify(x);
const same=(a:unknown,b:unknown)=>json(a)===json(b);
const history=(s:GameState)=>json([s.pressingSince,s.stableRawButtonMask,s.stablePreviousButtons,s.stablePreviousPreviousButtons]);
const update=(s:GameState)=>[history(s),json([...s.aliveSliderIds].map(id=>[id,s.sliderBodyState.get(id)])),json([...s.aliveSpinnerIds].map(id=>[id,s.spinnerState.get(id)]))];
function observeTracking(observer:NonNullable<ReturnType<typeof beginCanonicalTrace>>){
 const original=observer.tracking.bind(observer);let rows:unknown[]=[];
 observer.tracking=(id,snapshot)=>{const {position,...facts}=snapshot;rows.push([id,facts]);original(id,snapshot);};
 return ()=>{const value=json(rows);rows=[];return value;};
}
const settings={noteLockStyle:"STABLE",hitWindowStyle:"OSU_STABLE"} as const;
function packets(trace:ReplayTrace){
 const result=new Map<number,ReplayTraceRecord[]>();let ordinal=-1;
 for(const r of trace.records){if(r.kind==="input"){ordinal++;result.set(ordinal,[]);}
  else if(["attempt","selection","policy"].includes(r.kind)||r.kind==="resolution"&&r.triggerAttemptId)result.get(ordinal)?.push(r);}
 return result;
}
function semantic(records:ReplayTraceRecord[]){
 const ids=new Map<string,string>();let attempt=0;
 for(const r of records)if(r.kind==="attempt")ids.set(r.id,"attempt:"+attempt++);
 return json(records.map(r=>JSON.parse(json(r),(key,value)=>
  key==="id"||key==="sequence"||key==="inputId"?undefined:
   key==="attemptId"||key==="triggerAttemptId"?ids.get(value)??value:value)));
}
function* reproduceBaseline(map:Beatmap,trace:ReplayTrace):Generator<void,Baseline|undefined,void> {
 let cache=baselines.get(trace);if(!cache){cache=new WeakMap();baselines.set(trace,cache);}
 if(cache.has(map))return cache.get(map)??undefined;

 const capability=errorCapabilities(map,"stable"),inputs=trace.records.filter((r):r is Input=>r.kind==="input");
 if(trace.identity.schemaVersion!==2||trace.identity.analysisProfileId!=="stable"||trace.failures.some(s=>s!=="global-totals-mismatch")||trace.droppedRecordBoundary!==undefined||
  capability.scoring!=="supported"||capability.aim!=="manual"||capability.tapping!=="manual"||
  trace.domain.sourceCoverageLimits.some(s=>s!=="initial-actions-unknown"&&s!=="parser-negative-delta")||trace.domain.endpointBasis!=="recorded-end"||trace.domain.synthesizedEndpoint||
  !inputs.length||inputs.length>100000||inputs.length!==trace.domain.frameSources?.length||inputs[inputs.length-1].timeMs!==trace.domain.endTimeMs)return;
 const frames:ReplayFrame[]=[];
 for(let k=0;k<inputs.length;k++){
  const q=inputs[k],p=inputs[k-1];
  if(q.groupMemberIndex!==0||!same(q.source,trace.domain.frameSources[k])||q.source.origin!=="parsed"||
   ![q.timeMs,q.position.x,q.position.y].every(Number.isFinite)||p&&(q.timeMs<p.timeMs||p.source.origin!=="parsed"||q.source.parsedFrameIndex!==p.source.parsedFrameIndex+1||
    (p.source.rawTokenIndex!==undefined||q.source.rawTokenIndex!==undefined)&&(p.source.rawTokenIndex===undefined||q.source.rawTokenIndex===undefined||
      q.source.rawTokenIndex!==p.source.rawTokenIndex+1&&!q.source.discontinuityBefore?.length))||
   [q.actions,q.previousActions,q.freshActions].some(a=>new Set(a).size!==a.length||a.some(v=>v!==0&&v!==1))||
   !same(q.previousActions,p?.actions??[])||!same(q.freshActions,q.actions.filter(a=>!q.previousActions.includes(a)))||
   q.rawButtonMask!==undefined&&(!Number.isSafeInteger(q.rawButtonMask)||q.rawButtonMask<0||q.rawButtonMask>31||
    !same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])])))return;
  frames.push({time:q.timeMs,position:{...q.position},actions:[...q.actions],...(q.rawButtonMask!==undefined?{rawButtonMask:q.rawButtonMask}:{})});
 }
 // Default Stable settings are only a reconstruction hypothesis. In particular,
 // historical spinner behaviour must reproduce the entire supplied trace before
 // this context can be used. A mismatch refuses; it never changes admission.
 const capture=createReplayTraceCollector(trace.identity,trace.domain,trace.limits),observer=beginCanonicalTrace(capture,Infinity,trace.domain.endTimeMs,true),
  evaluator=new GameStateEvaluator(map,settings),state=defaultGameState(),updates:string[][]=[];
 try {
 if(!observer)return;const tracking=observeTracking(observer);let bytes=0;
 for(let k=0;k<frames.length;k++){evaluator.evaluate(state,frames[k],observer);const row=[...update(state),tracking()];updates.push(row);
  bytes+=row.reduce((n,x)=>n+x.length*2,0);if(bytes>32*1024*1024)return;if(k%256===255)yield;}
 observer?.finish();const reproduced=capture.seal();
 if(!same(reproduced.records,trace.records)||!same(reproduced.coverage,trace.coverage)||reproduced.failures.length)return;
 const result={inputs,frames,state,updates,packets:packets(trace)};cache.set(map,result);return result;
 } finally {capture.dispose();}
}
function* baseline(map:Beatmap,trace:ReplayTrace):Generator<void,Baseline|undefined,void> {
 const result=yield* reproduceBaseline(map,trace);
 // A cancelled delegate never reaches this line. Cache only a completed
 // refusal, so another proposal cannot repeatedly replay an unusable context.
 if(!result)baselines.get(trace)!.set(map,null);
 return result;
}

/** Exact consequences of a declared hypothetical input copy, not a diagnosis.
 * Uses the existing evaluator directly, with no playback state or classifier
 * recursion. Every unrelated receipt, body update and dispatch remains fixed. */
function* assembleCanonicalControl(map:Beatmap,trace:ReplayTrace,plan:CanonicalControlPlan,excluded:ReadonlySet<string>=new Set()):Generator<void,CanonicalControl|undefined,void> {
 if(!plan.changes.length||plan.changes.length>128||(plan.insertions?.length??0)>2||plan.relatedComponentIds.length>32||!plan.relatedComponentIds.includes(plan.targetId)||
  plan.relatedComponentIds.some(id=>excluded.has(id))||new Set(plan.changes.map(c=>c.inputId)).size!==plan.changes.length)return;
 const base=yield* baseline(map,trace);if(!base||base.state.hitCircleVerdict[plan.targetId]?.type!=="MISS")return;
 const related=new Set(plan.relatedComponentIds),improved=new Set(plan.improvedReceiptIds??[]);
 if([...improved].some(id=>!related.has(id)))return;
 const frames=base.frames.slice(),changes:CanonicalControl["changes"]=[],changedIndices:number[]=[];
 for(const change of plan.changes){
  const at=base.inputs.findIndex(q=>q.id===change.inputId);if(at<1||at+1>=base.inputs.length)return;
  if(base.inputs.slice(at-1,at+2).some(q=>q.source.origin!=="parsed"||q.source.discontinuityBefore?.length))return;
  const before=frames[at],actions=change.actions??before.actions,position=change.position??before.position;
  if(![position.x,position.y].every(Number.isFinite)||new Set(actions).size!==actions.length||actions.some(a=>a!==0&&a!==1))return;
  const after={...before,position:{...position},actions:[...actions]};
  if(change.actions&&before.rawButtonMask!==undefined)after.rawButtonMask=(before.rawButtonMask&16)|
   (actions.includes(0)?before.rawButtonMask&5||4:0)|(actions.includes(1)?before.rawButtonMask&10||8:0);
  if(same(before,after))continue;frames[at]=after;changedIndices.push(at);changes.push({inputId:change.inputId,before,after});
 }
 if(!changes.length)return;
 const reconstructedInputs:CanonicalControl["reconstructedInputs"]=[],inserted=new Map<number,ReplayFrame>();
 for(const proposal of plan.insertions??[]){
  const at=base.inputs.findIndex(q=>q.id===proposal.beforeInputId),left=base.inputs[at-1],right=base.inputs[at];
  if(at<1||!left||!right||inserted.has(at)||!Number.isSafeInteger(proposal.timeMs)||proposal.timeMs<=left.timeMs||proposal.timeMs>=right.timeMs||
   left.source.origin!=="parsed"||right.source.origin!=="parsed"||left.source.discontinuityBefore?.length||right.source.discontinuityBefore?.length||
   right.source.parsedFrameIndex!==left.source.parsedFrameIndex+1||
   (left.source.rawTokenIndex!==undefined||right.source.rawTokenIndex!==undefined)&&right.source.rawTokenIndex!==(left.source.rawTokenIndex??NaN)+1||
   !same(frames[at-1].position,left.position)||!same(frames[at].position,right.position)||
   new Set(proposal.actions).size!==proposal.actions.length||proposal.actions.some(a=>a!==0&&a!==1))return;
  const fraction=(proposal.timeMs-left.timeMs)/(right.timeMs-left.timeMs),position={x:left.position.x+fraction*(right.position.x-left.position.x),y:left.position.y+fraction*(right.position.y-left.position.y)},
   frame:ReplayFrame={time:proposal.timeMs,position,actions:[...proposal.actions]};
  if(left.rawButtonMask!==undefined)frame.rawButtonMask=(left.rawButtonMask&16)|(proposal.actions.includes(0)?left.rawButtonMask&5||4:0)|(proposal.actions.includes(1)?left.rawButtonMask&10||8:0);
  inserted.set(at,frame);reconstructedInputs.push({leftInputId:left.id,rightInputId:right.id,timeMs:proposal.timeMs,fraction,position,actions:[...proposal.actions],basis:"linear-between-recorded-inputs"});
 }
 const slots:Array<{frame:ReplayFrame;originalIndex:number;inserted:boolean}>=[];
 for(let k=0;k<frames.length;k++){const frame=inserted.get(k);if(frame)slots.push({frame,originalIndex:k,inserted:true});slots.push({frame:frames[k],originalIndex:k,inserted:false});}
 const first=Math.min(...changedIndices,...inserted.keys()),last=Math.max(...changedIndices,...inserted.keys()),actionsChanged=!!inserted.size||changes.some(c=>!same(c.before.actions,c.after.actions)),
  domain=inserted.size?{...trace.domain,frameSources:slots.map(s=>s.inserted?{origin:"synthetic" as const,reason:"declared-canonical-linear-control"}:trace.domain.frameSources![s.originalIndex])}:trace.domain,
  capture=createReplayTraceCollector(trace.identity,domain,trace.limits),observer=beginCanonicalTrace(capture,Infinity,trace.domain.endTimeMs,true),
  evaluator=new GameStateEvaluator(map,settings),state=defaultGameState();
 try {
 if(!observer)return;const tracking=observeTracking(observer);let converged=-1;
 for(let slot=0;slot<slots.length;slot++){
  const s=slots[slot],k=s.originalIndex;
  // No claim about an unobserved long-object update: this narrow control is
  // unavailable when an inserted update could introduce body/spinner work.
  if(s.inserted&&(state.aliveSliderIds.size||state.aliveSpinnerIds.size))return;
  evaluator.evaluate(state,s.frame,observer);const current=[...update(state),tracking()],prior=base.updates[k];
  if(s.inserted){if(current[1]!=="[]"||current[2]!=="[]"||current[3]!=="[]")return;continue;}
  if(k>=last&&state.hitCircleVerdict[plan.targetId]?.type==="MISS")return;
  // Body tracking is never waived by proximity or inclusion in the circle graph.
  if(current[1]!==prior[1]||current[2]!==prior[2]||current[3]!==prior[3])return;
  if(!actionsChanged||k<first){if(current[0]!==prior[0])return;}
  if(k>=last){if(current[0]===prior[0]){if(converged<0)converged=k;}else converged=-1;}
  if(slot%256===255)yield;
 }
 observer?.finish();const edited=capture.seal();if(edited.failures.length||edited.droppedRecordBoundary!==undefined||converged<0)return;
 const outcome=state.hitCircleVerdict[plan.targetId];if(!outcome||outcome.type==="MISS")return;
 const grades={MISS:0,MEH:1,OK:2,GREAT:3},outcomes:CanonicalControl["outcomes"]=[],parentOutcomes:CanonicalControl["parentOutcomes"]=[];
 for(const id of new Set([...Object.keys(base.state.hitCircleVerdict),...Object.keys(state.hitCircleVerdict)])){
  const before=base.state.hitCircleVerdict[id],after=state.hitCircleVerdict[id];if(same(before,after))continue;
  if(!related.has(id)||!before||!after||grades[after.type]<grades[before.type]||before.type!=="MISS"&&!improved.has(id))return;
  outcomes.push({componentId:id,before,after});
 }
 for(const key of ["checkPointVerdict","sliderTailVerdict","sliderVerdict","sliderJudgementTime","spinnerVerdict"] as const)
  for(const id of new Set([...Object.keys(base.state[key]),...Object.keys(state[key])])){
   if(same(base.state[key][id],state[key][id]))continue;
   // Only a declared related head's parent result may improve. Body outcomes
   // are exact, including a target head's own checkpoints and tail.
   if(key!=="sliderVerdict"||!related.has(id)||!related.has(id+"/HEAD")||
    grades[state.sliderVerdict[id]]<grades[base.state.sliderVerdict[id]])return;
   parentOutcomes.push({componentId:id,before:base.state.sliderVerdict[id],after:state.sliderVerdict[id],judgementTime:state.sliderJudgementTime[id]});
  }
 if(!same(base.state.judgedObjects.filter(id=>!related.has(id)),state.judgedObjects.filter(id=>!related.has(id))))return;
 for(const key of ["stableNotelockEvidence","lastNotelockShakeTime"] as const)
  for(const id of new Set([...Object.keys(base.state[key]),...Object.keys(state[key])]))
   if(!related.has(id)&&!same(base.state[key][id],state[key][id]))return;
 const changedPackets=packets(edited),editedInputs=edited.records.filter((r):r is Input=>r.kind==="input"),eventIds:string[]=[];
 for(let slot=0;slot<slots.length;slot++){
  const s=slots[slot],k=s.originalIndex,before=s.inserted?[]:base.packets.get(k)??[],after=changedPackets.get(slot)??[];
  if(semantic(before)===semantic(after))continue;
  const selected=[...before,...after].filter(r=>r.kind==="selection");
  if(selected.some(r=>r.kind==="selection"&&r.componentId!==null&&!related.has(r.componentId)))return;
  const alteredInput=s.inserted||changedIndices.includes(k)||!same(base.inputs[k].freshActions,editedInputs[slot].freshActions);
  if(!alteredInput&&!before.some(r=>r.kind==="selection"&&r.componentId!==null&&related.has(r.componentId)))return;
  eventIds.push(base.inputs[k].id,...before.map(r=>r.id));
 }
 const freshCount=(fs:ReplayFrame[])=>fs.reduce((n,q,k)=>n+q.actions.filter(a=>!fs[k-1]?.actions.includes(a)).length,0);
 return JSON.parse(JSON.stringify({basis:"canonical-model-counterfactual",changes,reconstructedInputs,outcomes,parentOutcomes,relatedComponentIds:[...related],addedFreshActions:freshCount(slots.map(s=>s.frame))-freshCount(base.frames),
  historyConvergedAtInputId:base.inputs[converged].id,baseline:"exact-observed-trace",preservation:"every-source-update-and-complete-dispatch",
  eventIds:[...new Set([...changes.map(c=>c.inputId),...reconstructedInputs.flatMap(r=>[r.leftInputId,r.rightInputId]),...eventIds,...trace.records.filter(r=>r.kind==="resolution"&&related.has(r.componentId)).map(r=>r.id)])]})) as CanonicalControl;
 } finally {capture.dispose();}
}

// Classification collects only requested controls. The inventory generator then
// runs their canonical traversals cooperatively and repeats that classification.
// No active request context survives a yield, cancellation or another session.
const results=new WeakMap<ReplayTrace,WeakMap<Beatmap,Map<string,CanonicalControl|null>>>();
type Request={key:string;plan:CanonicalControlPlan;excluded:ReadonlySet<string>};
const pending=new WeakMap<ReplayTrace,Map<Beatmap,Request[]>>();
function resultCache(map:Beatmap,trace:ReplayTrace){let maps=results.get(trace);if(!maps){maps=new WeakMap();results.set(trace,maps);}
 let cache=maps.get(map);if(!cache){cache=new Map();maps.set(map,cache);}return cache;}
export function collectCanonicalControls<T>(map:Beatmap,trace:ReplayTrace,classify:()=>T){
 const queue:Request[]=[],active=pending.get(trace)??new Map<Beatmap,Request[]>();pending.set(trace,active);
 const previous=active.get(map);active.set(map,queue);try{return {value:classify(),queue};}finally{if(previous)active.set(map,previous);else active.delete(map);}
}
export function* completeCanonicalControls(map:Beatmap,trace:ReplayTrace,queue:Request[]):Generator<void,void,void>{
 const cache=resultCache(map,trace);
 for(const request of queue){if(cache.has(request.key))continue;
  const proof=yield* assembleCanonicalControl(map,trace,request.plan,request.excluded);cache.set(request.key,proof??null);yield;}
}
export function certifyCanonicalControl(map:Beatmap,trace:ReplayTrace,plan:CanonicalControlPlan,excluded:ReadonlySet<string>=new Set()):CanonicalControl|undefined {
 const key=json([plan,[...excluded].sort()]),cache=resultCache(map,trace);
 if(cache.has(key)){const proof=cache.get(key);return proof?JSON.parse(json(proof)) as CanonicalControl:undefined;}
 if(cache.size>=256)return;
 const queue=pending.get(trace)?.get(map);
 if(queue){if(!queue.some(r=>r.key===key)&&queue.length<32)queue.push({key,plan:JSON.parse(json(plan)),excluded:new Set(excluded)});return;}
 const work=assembleCanonicalControl(map,trace,plan,excluded);let step=work.next();while(!step.done)step=work.next();
 cache.set(key,step.value??null);return step.value?JSON.parse(json(step.value)) as CanonicalControl:undefined;
}
