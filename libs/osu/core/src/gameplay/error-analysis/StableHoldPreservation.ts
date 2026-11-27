import { float32_mul } from "@osujs/math";
import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { InputRecord } from "../miss-explanation/CircleEvidence";
import { nativeWithinHitRadius, stableGameplayRadius, stableWithinHitRadius, stableWithinTrackingRadius } from "../StableHitGeometry";
import { StableSliderBallPath } from "../StableSliderBallPath";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import { trackingPreservationIndex } from "./TrackingPreservationIndex";

/** Conservative reachability bound, not hypothetical successful receipts.
 * A fresh contact with another unresolved circle can prolong a routing chain
 * beyond the corrected target's old expiry. Heads are checked separately:
 * newly enabled callbacks are refused, so their bodies cannot relay a chain. */
export function correctionRoutingHorizon(
  map:Beatmap,trace:ReplayTrace,inputs:readonly InputRecord[],sampleAt:number,parentId:string,
  removedEdge?:{inputId:string;action:number},
):{terminal:ReplayTraceRecord;eventIds:string[];componentIds:string[]}|undefined {
  const index=trackingPreservationIndex(trace),parent=map.getHitObject(parentId),
    terminals=[index.terminals.get(parentId),index.circleTerminals.get(parentId),
      ...(parent instanceof Slider?[index.circleTerminals.get(parent.head.id)]:[])].filter((r):r is ReplayTraceRecord=>!!r);
  if(!terminals.length)return;
  let terminal=terminals.reduce((a,b)=>a.sequence>b.sequence?a:b);
  const ids=new Set(terminals.map(r=>r.id)),components=new Set([parentId]),
    circles=map.hitObjects.filter((o):o is HitCircle=>o instanceof HitCircle&&o.id!==parentId),
    stable=trace.identity.analysisProfileId==="stable";
  for(let k=sampleAt+1;k<inputs.length&&inputs[k].sequence<terminal.sequence;k++){
    if(k-sampleAt>4096)return;
    const r=inputs[k];ids.add(r.id);if(!r.freshActions.length)continue;
    // An advanced pulse no longer dispatches at its old sample. Retain that
    // sample as provenance but do not relay a hypothetical circle chain via
    // its removed action. Every other fresh contact remains in the closure.
    if(r.id===removedEdge?.inputId&&r.freshActions.length===1&&r.freshActions[0]===removedEdge.action)continue;
    for(const circle of circles){
      const end=index.circleTerminals.get(circle.id);
      if(circle.spawnTime>r.timeMs||end&&end.sequence<r.sequence||!(stable
        ?stableWithinHitRadius(circle.position,r.position,stableGameplayRadius(circle.radius))
        :nativeWithinHitRadius(circle.position,r.position,Math.fround(circle.radius))))continue;
      if(!end)return;
      components.add(circle.id);ids.add(end.id);if(end.sequence>terminal.sequence)terminal=end;
    }
  }
  if([...components].some(id=>[...trace.failures,...trace.domain.sourceCoverageLimits]
    .some(s=>s.startsWith("dependency-conflict:")&&s.endsWith(":"+id))))return;
  return {terminal,eventIds:[...ids],componentIds:[...components]};
}

/** A repaired predecessor may enable an unchanged later head press. Preserve
 * actual allowed callbacks only; otherwise a live head contact needs its own
 * changed-routing proof. Check until the original target parent is terminal,
 * including contacts before a future body starts or after hold convergence. */
export function stableHoldHeadRouting(
  object:Slider,trace:ReplayTrace,inputs:readonly InputRecord[],first:number,originalAt:number,sampleAt:number,parentId:string,
  horizon?:ReturnType<typeof correctionRoutingHorizon>,
):string[]|undefined {
  const index=trackingPreservationIndex(trace),terminal=index.terminals.get(object.id),headTerminal=index.circleTerminals.get(object.head.id),
    targetTerminal=horizon?.terminal??index.terminals.get(parentId)??index.circleTerminals.get(parentId);
  if(!targetTerminal||(index.receipts.get(inputs[originalAt].id)??[]).some(r=>r.kind==="resolution"&&
    r.componentId!==parentId&&r.componentId!==parentId+"/HEAD"))return;
  const ids:string[]=[targetTerminal.id,...(horizon?.eventIds??[])];
  // A delayed correction cannot unblock a receipt that already happened
  // before its new edge. Earlier hold edits are checked separately below.
  for(let k=Math.max(first,sampleAt);k<inputs.length&&inputs[k].sequence<Math.min(terminal?.sequence??Infinity,targetTerminal.sequence);k++){
    if(k-first>4096)return;
    const r=inputs[k];ids.push(r.id);
    const stable=trace.identity.analysisProfileId==="stable";
    if(k===originalAt||k===sampleAt||!r.freshActions.length||r.timeMs<object.head.spawnTime||
      stable&&headTerminal&&headTerminal.sequence<r.sequence||!(stable
        ?stableWithinHitRadius(object.head.position,r.position,stableGameplayRadius(object.head.radius))
        :nativeWithinHitRadius(object.head.position,r.position,Math.fround(object.head.radius))))continue;
    // Native/Classic callbacks require their own latch proof. Geometry with
    // no head contact is sufficient; a possible callback remains unsupported.
    if(!stable)return;
    if(!index.allowedHeads.get(r.id)?.has(object.head.id))return;
    ids.push(...(index.headPolicies.get(object.head.id)??[]).filter(p=>p.timeMs===r.timeMs).map(p=>p.id));
  }
  return ids;
}

/** A cursor-only repair can also enable future heads. Dispatch preservation
 * therefore cannot be bounded merely by body/interpolation overlap. */
export function certifyAimHeadRouting(
  map:Beatmap,trace:ReplayTrace,inputs:readonly InputRecord[],at:number,parentId:string,excluded:ReadonlySet<string>,
):{componentId:string;eventIds:string[]}[]|undefined {
  const index=trackingPreservationIndex(trace),q=inputs[at],horizon=correctionRoutingHorizon(map,trace,inputs,at,parentId),targetTerminal=horizon?.terminal,
    proofs:{componentId:string;eventIds:string[]}[]=[];
  if(horizon?.componentIds.some(id=>excluded.has(id)))return;
  for(const object of map.hitObjects){
    if(!(object instanceof Slider)||object.id===parentId||object.head.spawnTime>(targetTerminal?.timeMs??Infinity))continue;
    const terminal=index.terminals.get(object.id);if(terminal&&terminal.sequence<q.sequence)continue;
    const components=[object.id,object.head.id,...(object.stableCheckPoints??object.checkPoints).map(c=>c.id)];
    // A future body beyond the entire routing closure needs no invented
    // terminal: the source-checked head callback proof below closes its only
    // possible dependency. Active bodies retain their existing state proof.
    if((!terminal&&(!targetTerminal||object.startTime<=targetTerminal.timeMs))||trace.droppedRecordBoundary!==undefined||index.allowedHeads.get(q.id)?.has(object.head.id)||
      components.some(id=>excluded.has(id)||[...trace.failures,...trace.domain.sourceCoverageLimits]
        .some(s=>s.startsWith("dependency-conflict:")&&s.endsWith(":"+id))))return;
    if(!horizon)return;
    const routing=stableHoldHeadRouting(object,trace,inputs,at,at,at,parentId,horizon);if(!routing)return;
    proofs.push({componentId:object.id,eventIds:[...(terminal?[terminal.id]:[]),...routing]});
  }
  return proofs;
}

/** Compare body-input acceptance, not a new score or an invented receipt.
 * Equal canTrack with unchanged geometry preserves tracking and trackingSince.
 * Unequal canTrack is neutral only outside the current acquisition/follow radius. */
export function certifyStableHoldPreservation(
  object:Slider,trace:ReplayTrace,inputs:readonly InputRecord[],first:number,last:number,sampleAt:number,newEnd:number,
  action:number,past:readonly number[],convergence:number,
):{componentId:string;basis:"stable-hold-recomputation";eventIds:string[]}|undefined {
  const index=trackingPreservationIndex(trace),terminal=index.terminals.get(object.id),states=index.states.get(object.id)??[],
    prior=states.filter(r=>r.sequence<inputs[first].sequence).slice(-1)[0],state=prior?.tracking,
    queries=index.headPolicies.get(object.head.id)??[];
  if(!terminal||state&&(state.sampleBasis!=="recorded-update"||!Number.isInteger(state.latch)||state.latch!<0||state.latch!>3))return;
  if(!prior&&((inputs[first-1]?.timeMs??-Infinity)>=object.startTime||!states.length||states[0].tracking?.beforeTracking!==false||
    queries.some(r=>r.sequence<states[0].sequence)))return;
  const oldHistory=[...past],newHistory=[...past],mask=(r:InputRecord)=>r.actions.reduce((n,a)=>n|(1<<a),0),
    step=(history:number[],value:number)=>{const fresh=value&~history[0];if(history[0]!==value){history[2]=history[1];history[1]=history[0];history[0]=value;}return fresh;},
    update=(latch:number,h:number[],fresh:number)=>{
      const [current,previous,previousPrevious]=h,maySwitch=current!==0&&(previous!==3||previousPrevious!==current);let held=false;
      if(current){if(!latch||current!==3&&maySwitch){latch=(fresh&1?1:fresh&2?2:0)||current;held=true;}else held=!!(current&latch);}else latch=0;
      return {latch,canTrack:held||maySwitch};
    },
    path=new StableSliderBallPath(object),ids=new Set<string>(prior?[prior.id]:[]);
  let oldLatch=state?.latch??0,newLatch=oldLatch,tracking=state?.tracking??false,since=state?.trackingSince;
  for(let k=first;k<inputs.length&&k-first<=4096;k++){
    const r=inputs[k],next=inputs[k+1],oldMask=mask(r),newMask=k>=last?oldMask:k>=sampleAt&&k<newEnd?oldMask|(1<<action):oldMask&~(1<<action),
      oldFresh=step(oldHistory,oldMask),newFresh=step(newHistory,newMask);
    ids.add(r.id);
    if(index.allowedHeads.get(r.id)?.has(object.head.id)){
      // The preflight established the same actual allowed callback and no
      // removed receiver receipt; this unchanged edge forces the same latch.
      if(!oldFresh||oldFresh!==newFresh||r.timeMs<object.startTime)return;
      oldLatch=newLatch=oldFresh&1?1:2;
      for(const p of queries.filter(p=>p.timeMs===r.timeMs))ids.add(p.id);
    }
    if(r.timeMs<object.startTime)continue;
    if(r.sequence>terminal.sequence)break;
    const old=update(oldLatch,oldHistory,oldFresh),changed=update(newLatch,newHistory,newFresh);oldLatch=old.latch;newLatch=changed.latch;
    const geometry=stableWithinTrackingRadius(path.positionAt(r.timeMs),r.position,float32_mul(stableGameplayRadius(object.radius),tracking?2.4:1));
    if(old.canTrack!==changed.canTrack&&geometry)return;
    const nowTracking=old.canTrack&&geometry;
    since=nowTracking?(tracking?since??r.timeMs:r.timeMs):undefined;tracking=nowTracking;
    for(const observed of states.filter(s=>s.sequence>r.sequence&&s.sequence<(next?.sequence??Infinity))){
      const snapshot=observed.tracking;
      if(!snapshot||snapshot.sampleBasis!=="recorded-update"||snapshot.timeMs!==r.timeMs||snapshot.latch!==oldLatch||snapshot.holdAccepted!==old.canTrack||
        snapshot.tracking!==tracking||snapshot.trackingSince!==since)return;
      ids.add(observed.id);
    }
    if((k>=convergence&&oldLatch===newLatch&&oldHistory.every((v,j)=>v===newHistory[j]))||!next||terminal.sequence<next.sequence){
      ids.add(terminal.id);return {componentId:object.id,basis:"stable-hold-recomputation",eventIds:[...ids]};
    }
  }
  return;
}

export interface StableMaskPreservation {
  componentId:string;
  basis:"stable-mask-recomputation";
  throughInputId:string;
  parentTerminalId:string;
  historyConverged:boolean;
  eventIds:string[];
}

/** Body proof for a complete edited mask vector. The caller must separately
 * certify every virtual head callback and all selectors/policies; this helper
 * never presents the reconstructed callbacks as observed source receipts. */
export function certifyStableMaskPreservation(
  object:Slider,trace:ReplayTrace,inputs:readonly InputRecord[],masks:ReadonlyMap<string,number>,
  callbacks:readonly {componentId:string;inputId:string;eventIds:readonly string[]}[],
):StableMaskPreservation|undefined {
  if(trace.identity.analysisProfileId!=="stable"||trace.identity.schemaVersion!==2||trace.droppedRecordBoundary!==undefined)return;
  const index=trackingPreservationIndex(trace),positions=new Map(inputs.map((q,k)=>[q.id,k] as const)),
    byId=new Map(trace.records.map(r=>[r.id,r] as const)),oldMask=(q:InputRecord)=>q.actions.reduce((v,a)=>v|(1<<a),0),
    value=(k:number)=>masks.get(inputs[k].id)??oldMask(inputs[k]);
  const canonical=trace.records.filter((r):r is InputRecord=>r.kind==="input");
  if(inputs.length!==canonical.length||inputs.some((q,k)=>q!==canonical[k]||byId.get(q.id)!==q)||positions.size!==inputs.length||
    [...masks].some(([id,v])=>!positions.has(id)||!Number.isInteger(v)||v<0||v>3))return;
  const queries=index.headPolicies.get(object.head.id)??[],
    attemptInputs=new Map(trace.records.flatMap(r=>r.kind==="attempt"?[[r.id,r.inputId] as const]:[])),
    oldCallbacks=new Map<string,string[]>(),newCallbacks=new Map<string,string[]>();
  for(const p of queries)if(p.kind==="policy"&&p.state==="allowed"&&["MISS","MEH","OK","GREAT"].includes(p.timingResult??"")){
    const id=attemptInputs.get(p.attemptId);if(!id||!positions.has(id)||oldCallbacks.has(id))return;
    oldCallbacks.set(id,[p.id]);
  }
  for(const c of callbacks)if(c.componentId===object.head.id){
    if(!positions.has(c.inputId)||newCallbacks.has(c.inputId)||!c.eventIds.length||c.eventIds.some(id=>!byId.has(id)))return;
    newCallbacks.set(c.inputId,[...c.eventIds]);
  }
  const changed=inputs.flatMap((q,k)=>oldMask(q)!==value(k)?[k]:[]),
    callbackChanges=[...new Set([...oldCallbacks.keys(),...newCallbacks.keys()])]
      .filter(id=>oldCallbacks.has(id)!==newCallbacks.has(id)).map(id=>positions.get(id)!),
    mutation=[...changed,...callbackChanges],terminal=index.terminals.get(object.id);
  // With mask-only edits, callbacks preceding every changed mask must remain
  // actual. Later callback changes require the caller's complete routing proof.
  if(!terminal||!mutation.length||callbackChanges.length&&(!changed.length||callbackChanges.some(k=>k<Math.min(...changed))))return;
  const first=Math.min(...mutation),last=Math.max(...mutation),states=index.states.get(object.id)??[],
    prior=states.filter(r=>r.sequence<inputs[first].sequence).slice(-1)[0],state=prior?.tracking;
  if(first<1||last-first>4096||state&&(state.sampleBasis!=="recorded-update"||!Number.isInteger(state.latch)||state.latch!<0||state.latch!>3))return;
  if(!prior&&(inputs[first-1].timeMs>=object.startTime||!states.length||states[0].tracking?.beforeTracking!==false||
    [...oldCallbacks.keys()].some(id=>positions.get(id)!<first)))return;
  const past:number[]=[];let seed=first-1;
  for(;seed>=0&&first-seed<=4096;seed--){const v=oldMask(inputs[seed]);if(!past.length||past[past.length-1]!==v)past.push(v);if(past.length===3)break;}
  if(first-seed>4096||past.length<3&&!trace.domain.initialActionsKnown)return;
  seed=Math.max(seed,0);while(past.length<3)past.push(0);
  const oldHistory=past.slice(),newHistory=past.slice(),
    step=(h:number[],v:number)=>{const fresh=v&~h[0];if(h[0]!==v){h[2]=h[1];h[1]=h[0];h[0]=v;}return fresh;},
    update=(latch:number,h:number[],fresh:number)=>{
      const [current,previous,previousPrevious]=h,maySwitch=current!==0&&(previous!==3||previousPrevious!==current);let held=false;
      if(current){if(!latch||current!==3&&maySwitch){latch=(fresh&1?1:fresh&2?2:0)||current;held=true;}else held=!!(current&latch);}else latch=0;
      return {latch,canTrack:held||maySwitch};
    },path=new StableSliderBallPath(object),ids=new Set<string>([...(prior?[prior.id]:[]),...inputs.slice(seed,first).map(q=>q.id)]);
  let oldLatch=state?.latch??0,newLatch=oldLatch,tracking=state?.tracking??false,since=state?.trackingSince;
  const done=(r:InputRecord,converged:boolean):StableMaskPreservation=>({componentId:object.id,basis:"stable-mask-recomputation",
    throughInputId:r.id,parentTerminalId:terminal.id,historyConverged:converged,eventIds:[...new Set([...ids,terminal.id])]});
  for(let k=first;k<inputs.length&&k-seed<=4096;k++){
    const r=inputs[k],next=inputs[k+1],oldFresh=step(oldHistory,oldMask(r)),newFresh=step(newHistory,value(k));ids.add(r.id);
    if(oldCallbacks.has(r.id)){if(!oldFresh)return;oldLatch=oldFresh&1?1:2;oldCallbacks.get(r.id)!.forEach(id=>ids.add(id));}
    if(newCallbacks.has(r.id)){if(!newFresh)return;newLatch=newFresh&1?1:2;newCallbacks.get(r.id)!.forEach(id=>ids.add(id));}
    // Stable head callbacks latch before the body's start, even when too early.
    if(r.timeMs<object.startTime)continue;if(r.sequence>terminal.sequence)break;
    const old=update(oldLatch,oldHistory,oldFresh),edited=update(newLatch,newHistory,newFresh);oldLatch=old.latch;newLatch=edited.latch;
    const geometry=stableWithinTrackingRadius(path.positionAt(r.timeMs),r.position,float32_mul(stableGameplayRadius(object.radius),tracking?2.4:1));
    if(old.canTrack!==edited.canTrack&&geometry)return;
    const now=old.canTrack&&geometry;since=now?(tracking?since??r.timeMs:r.timeMs):undefined;tracking=now;
    for(const observed of states.filter(s=>s.sequence>r.sequence&&s.sequence<(next?.sequence??Infinity))){const s=observed.tracking;
      if(!s||s.sampleBasis!=="recorded-update"||s.timeMs!==r.timeMs||s.latch!==oldLatch||s.holdAccepted!==old.canTrack||s.tracking!==tracking||s.trackingSince!==since)return;
      ids.add(observed.id);
    }
    const converged=k>=last&&oldLatch===newLatch&&oldHistory.every((v,j)=>v===newHistory[j]);
    if(converged)return done(r,true);
    if(!next||terminal.sequence<next.sequence)return done(r,false);
  }
  return;
}
