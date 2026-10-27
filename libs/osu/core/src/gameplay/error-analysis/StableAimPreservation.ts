import { float32_mul, Position } from "@osujs/math";
import { Slider } from "../../hitobjects/Slider";
import { InputRecord } from "../miss-explanation/CircleEvidence";
import { stableGameplayRadius, stableWithinTrackingRadius } from "../StableHitGeometry";
import { StableSliderBallPath } from "../StableSliderBallPath";
import { StableSliderTiming } from "../StableSliderTiming";
import { ReplayTrace } from "../trace/ReplayTrace";
import { trackingPreservationIndex } from "./TrackingPreservationIndex";

export interface StableAimPreservation {
  componentId:string;
  basis:"already-terminal"|"equal-tracking"|"reacquired-before-deadline";
  eventIds:string[];
}

/** Sufficient preservation proof for one recorded-position edit. Stable uses
 * recorded body updates; native interpolation and spinners need other proofs. */
export function certifyStableAimPreservation(
  slider:Slider,trace:ReplayTrace,q:InputRecord,next:InputRecord,position:Position,excluded:ReadonlySet<string>,before?:InputRecord,
):StableAimPreservation|undefined {
  const timing=new StableSliderTiming(slider),components=[slider.id,slider.head.id,...timing.checkPoints.map(c=>c.id)];
  if(trace.droppedRecordBoundary!==undefined||components.some(id=>excluded.has(id)||
    [...trace.failures,...trace.domain.sourceCoverageLimits].some(s=>s.startsWith("dependency-conflict:")&&s.endsWith(":"+id))))return;
  const index=trackingPreservationIndex(trace),terminal=index.terminals.get(slider.id);
  if(terminal&&terminal.sequence<q.sequence)return {componentId:slider.id,basis:"already-terminal",eventIds:[terminal.id]};
  // Even a failed head can change the Stable button latch.
  if(index.allowedHeads.get(q.id)?.has(slider.head.id))return;
  const states=index.states.get(slider.id)??[],previous=states.filter(r=>r.sequence<q.sequence)
    .slice(-1)[0];
  if(q.freshActions.length!==1||!q.actions.includes(q.freshActions[0])||q.previousActions.includes(q.freshActions[0]))return;
  if(!previous){
    // Body birth can fall between adjacent recorded inputs. The first actual
    // update explicitly supplies the false initial tracking state; absence of
    // an earlier snapshot alone does not. Preserve only equal geometry here.
    const first=states[0],state=first?.tracking,path=new StableSliderBallPath(slider),
      ball=path.positionAt(q.timeMs),radius=float32_mul(stableGameplayRadius(slider.radius),1),
      oldGeometry=stableWithinTrackingRadius(ball,q.position,radius),newGeometry=stableWithinTrackingRadius(ball,position,radius);
    if(!before||before.timeMs>=slider.startTime||q.timeMs<slider.startTime||
      !first||first.kind!=="slider-tracking"||first.sequence<=q.sequence||first.sequence>=next.sequence||
      first.timeMs!==q.timeMs||!state||state.timeMs!==q.timeMs||state.sampleBasis!=="recorded-update"||
      state.beforeTracking!==false||!state.started||state.positionOverride||
      state.position.x!==q.position.x||state.position.y!==q.position.y||state.ball.x!==ball.x||state.ball.y!==ball.y||
      state.radius!==radius||state.geometryAccepted!==oldGeometry||state.tracking!==(oldGeometry&&state.holdAccepted)||
      state.actions.length!==q.actions.length||!state.actions.every(a=>q.actions.includes(a))||oldGeometry!==newGeometry)return;
    return {componentId:slider.id,basis:"equal-tracking",eventIds:[before.id,q.id,first.id,next.id]};
  }
  const state=previous&&(previous.kind==="slider-tracking"||previous.kind==="slider-checkpoint")?previous.tracking:undefined;
  if(!previous||!state||state.sampleBasis!=="recorded-update"||state.timeMs>=q.timeMs||q.freshActions.length!==1||
    !q.actions.includes(q.freshActions[0])||q.previousActions.includes(q.freshActions[0]))return;
  const path=new StableSliderBallPath(slider),radius=float32_mul(stableGameplayRadius(slider.radius),state.tracking?2.4:1),
    ball=path.positionAt(q.timeMs),oldTracking=q.timeMs>=slider.startTime&&stableWithinTrackingRadius(ball,q.position,radius),
    newTracking=q.timeMs>=slider.startTime&&stableWithinTrackingRadius(ball,position,radius),ids=[previous.id,q.id];
  // A single fresh key ensures maySwitch=true at this update; the unchanged
  // input mask gives both cursor alternatives the same latch and hold state.
  if(oldTracking===newTracking)return {componentId:slider.id,basis:"equal-tracking",eventIds:ids};
  if(next.timeMs<=q.timeMs||next.freshActions.length||next.actions.length!==q.actions.length||
    !next.actions.every(a=>q.actions.includes(a))||next.timeMs<slider.startTime||
    !stableWithinTrackingRadius(path.positionAt(next.timeMs),next.position,stableGameplayRadius(slider.radius))||
    terminal&&terminal.sequence<next.sequence)return;
  const resolved=(index.states.get(slider.id)??[]).filter(r=>r.kind==="slider-checkpoint"&&r.sequence<q.sequence);
  if(timing.checkPoints.some(c=>!resolved.some(r=>r.kind==="slider-checkpoint"&&r.componentId===c.id)&&timing.checkpointTime(c)<next.timeMs))return;
  return {componentId:slider.id,basis:"reacquired-before-deadline",eventIds:[...ids,next.id,...resolved.map(r=>r.id)]};
}
