import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { InputRecord } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { trackingPreservationIndex } from "./TrackingPreservationIndex";
import { certifyStableHoldPreservation, correctionRoutingHorizon, stableHoldHeadRouting } from "./StableHoldPreservation";

export interface TimingHoldPreservation {componentId:string;basis:"unchanged-spinner-hold"|"independent-stable-latch"|"stable-hold-recomputation"|"stable-body-start-after-history";eventIds:string[]}
export interface TimingHoldCertificate {
  affected:TimingHoldPreservation[];
  history?:{throughInputId:string;converged:boolean};
  eventIds:string[];
}

/** Pure input copy shared by the local hold proof and full replay controls. */
export function timingPulseEdits(inputs: readonly InputRecord[], originalAt: number, sampleAt: number) {
  if (originalAt < 0 || sampleAt < 0 || originalAt >= inputs.length || sampleAt >= inputs.length) return;
  const press = inputs[originalAt], action = press.freshActions[0];
  if (press.freshActions.length !== 1) return;
  const releaseAt = inputs.findIndex((r, k) => k > originalAt && !r.actions.includes(action)),
    oldEnd = releaseAt < 0 ? inputs.length : releaseAt, newEnd = sampleAt >= oldEnd ? sampleAt + 1 : oldEnd,
    first = Math.min(originalAt, sampleAt), last = Math.max(oldEnd, newEnd);
  if (last - first > 4096) return;
  const changed = inputs.slice(first, Math.min(last, inputs.length)).flatMap((r, j) => {
    const k = first + j, held = k >= sampleAt && k < newEnd;
    return r.actions.includes(action) === held ? [] : [{ r, actions: held ? [...r.actions, action] : r.actions.filter(a => a !== action) }];
  });
  return { action, oldEnd, newEnd, first, last, changed };
}

/** A pulse can support a body without receiving any head judgement. Check the
 * exact edited hold intervals, keeping every unrelated action unchanged. */
export function certifyTimingHoldPreservation(
  map:Beatmap,trace:ReplayTrace,inputs:readonly InputRecord[],originalAt:number,sampleAt:number,
  parentId:string,excluded:ReadonlySet<string>,
):TimingHoldCertificate|undefined {
  if(originalAt===sampleAt)return {affected:[],eventIds:[]};
  const edits = timingPulseEdits(inputs, originalAt, sampleAt);
  if (!edits) return;
  const { action, newEnd, first, last, changed } = edits, press = inputs[originalAt];
  if(!changed.length)return {affected:[],eventIds:[]};
  const start=changed[0].r,end=changed[changed.length-1].r,nextAt=inputs.indexOf(end)+1,next=inputs[nextAt];
  if(!next)return;
  // Compare the actual two preceding DISTINCT mask histories. An advance can
  // restore them at the original edge, before two further transitions occur.
  const mask=(actions:readonly number[])=>actions.reduce((n,a)=>n|(1<<a),0),past:number[]=[];
  let seed=first-1;
  for(;seed>=0&&first-seed<=4096;seed--){
    const value=mask(inputs[seed].actions);
    if(!past.length||past[past.length-1]!==value)past.push(value);
    if(past.length===3)break;
  }
  if(first-seed>4096)return;
  seed=Math.max(0,seed);while(past.length<3)past.push(0);
  const oldHistory=past.slice(),newHistory=past.slice(),step=(history:number[],value:number)=>{
    if(history[0]!==value){history[2]=history[1];history[1]=history[0];history[0]=value;}
  };
  let convergence=inputs.length-1,converged=false;
  for(let k=first;k<inputs.length;k++){
    const oldMask=mask(inputs[k].actions),newMask=k>=last?oldMask:
      k>=sampleAt&&k<newEnd?oldMask|(1<<action):oldMask&~(1<<action);
    step(oldHistory,oldMask);step(newHistory,newMask);
    if(k>=nextAt&&oldHistory.every((v,j)=>v===newHistory[j])){convergence=k;converged=true;break;}
    if(k-seed>4096)return;
  }
  const proofs:TimingHoldPreservation[]=[],index=trackingPreservationIndex(trace),
    horizon=correctionRoutingHorizon(map,trace,inputs,sampleAt,parentId,
      sampleAt<originalAt&&press.freshActions.length===1?{inputId:press.id,action}:undefined),targetTerminal=horizon?.terminal;
  if(horizon?.componentIds.some(id=>excluded.has(id)))return;
  // Moving an edge removes its original dispatch even if that sample's held
  // mask is unchanged (an advance). Failed allowed heads can also set a latch.
  for(const slot of [inputs[originalAt],inputs[sampleAt]]){
    if(map.hitObjects.some(o=>o instanceof Slider&&o.id!==parentId&&index.allowedHeads.get(slot.id)?.has(o.head.id)))return;
  }
  for(const object of map.hitObjects){
    if(object.id===parentId||object instanceof HitCircle)continue;
    const bodyOverlaps=object.startTime<=inputs[convergence].timeMs,
      headOverlaps=object instanceof Slider&&object.head.spawnTime<=(targetTerminal?.timeMs??Infinity);
    if(!bodyOverlaps&&!headOverlaps)continue;
    const terminal=index.terminals.get(object.id);
    if(terminal&&terminal.sequence<start.sequence)continue;
    if((!terminal&&bodyOverlaps)||trace.droppedRecordBoundary!==undefined)return;
    const components=[object.id,...(object instanceof Slider?[object.head.id,...(object.stableCheckPoints??object.checkPoints).map(c=>c.id)]:[])];
    if(components.some(id=>excluded.has(id)||[...trace.failures,...trace.domain.sourceCoverageLimits]
      .some(s=>s.startsWith("dependency-conflict:")&&s.endsWith(":"+id))))return;
    if(!(object instanceof Slider)){
      if(changed.some(c=>c.r.timeMs<object.endTime&&inputs[inputs.indexOf(c.r)+1]?.timeMs>object.startTime&&
        Boolean(c.r.actions.length)!==Boolean(c.actions.length)))return;
      if(!terminal)return;
      proofs.push({componentId:object.id,basis:"unchanged-spinner-hold",eventIds:[terminal.id,...changed.map(c=>c.r.id),next.id]});continue;
    }
    if(trace.identity.analysisProfileId!=="stable")return;
    if(!horizon)return;
    const routing=stableHoldHeadRouting(object,trace,inputs,first,originalAt,sampleAt,parentId,horizon);
    if(!routing)return;
    if(!bodyOverlaps){
      // A future body has no changed tracking state to reconstruct. Require
      // genuine history convergence and unchanged head routing; the last
      // recorded input used as a search bound is not itself convergence.
      if(!converged)return;
      proofs.push({componentId:object.id,basis:"stable-body-start-after-history",eventIds:[...(terminal?[terminal.id]:[]),...routing]});continue;
    }
    if(!terminal)return;
    const prior=(index.states.get(object.id)??[]).filter(r=>r.sequence<start.sequence).slice(-1)[0],
      state=prior&&(prior.kind==="slider-tracking"||prior.kind==="slider-checkpoint")?prior.tracking:undefined,
      other=1-action,held=inputs.filter(r=>r.sequence>=start.sequence&&r.sequence<terminal.sequence);
    // With the other side continuously latched, both {other} and {both} keep
    // canTrack=true and the same latch, independently of button history.
    if(prior&&state&&state.sampleBasis==="recorded-update"&&state.latch===(1<<other)&&state.actions.includes(other)&&
      held.length&&held.length<=4096&&held.every(r=>r.actions.includes(other))){
      // An unchanged allowed head may replace this independent latch, so use
      // explicit recomputation whenever the body lifetime contains a callback.
      const hasCallback=(index.headPolicies.get(object.head.id)??[]).some(p=>p.sequence>=start.sequence&&p.sequence<terminal.sequence);
      if(!hasCallback){proofs.push({componentId:object.id,basis:"independent-stable-latch",eventIds:[prior.id,terminal.id,...held.map(r=>r.id),next.id,...routing]});continue;}
      const proof=certifyStableHoldPreservation(object,trace,inputs,first,last,sampleAt,newEnd,action,past,convergence);
      if(!proof)return;proof.eventIds.push(...routing);proofs.push(proof);
    }else{
      const proof=certifyStableHoldPreservation(object,trace,inputs,first,last,sampleAt,newEnd,action,past,convergence);
      if(!proof)return;proof.eventIds.push(...routing);proofs.push(proof);
    }
  }
  if(convergence-seed>4096)return;
  return {affected:proofs,history:{throughInputId:inputs[convergence].id,converged},
    eventIds:[...new Set([...inputs.slice(seed,convergence+1).map(r=>r.id),...proofs.flatMap(p=>p.eventIds)])]};
}
