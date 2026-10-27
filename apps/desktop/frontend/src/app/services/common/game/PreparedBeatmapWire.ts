import { Beatmap, HitCircle, Slider, Spinner, SliderCheckPoint } from "@osujs/core";
import { SliderPath } from "../../../../../../../../libs/osu/core/src/hitobjects/slider/SliderPath";
import { ControlPointInfo } from "../../../../../../../../libs/osu/core/src/beatmap/ControlPoints/ControlPointInfo";
import { ControlPointGroup } from "../../../../../../../../libs/osu/core/src/beatmap/ControlPoints/ControlPointGroup";
import { DifficultyControlPoint } from "../../../../../../../../libs/osu/core/src/beatmap/ControlPoints/DifficultyControlPoint";
import { TimingControlPoint } from "../../../../../../../../libs/osu/core/src/beatmap/ControlPoints/TimingControlPoint";
import { SampleControlPoint } from "../../../../../../../../libs/osu/core/src/beatmap/ControlPoints/SampleControlPoint";
import { EffectControlPoint } from "../../../../../../../../libs/osu/core/src/beatmap/ControlPoints/EffectControlPoint";
import { SortedList } from "../../../../../../../../libs/osu/core/src/utils/SortedList";

/** Restore only prototypes on the cloned prepared graph; never regenerate curves or aliases. */
function* hydrateSteps(map:Beatmap,kinds:readonly string[]):Generator<void,Beatmap> {
  if(!Array.isArray(kinds)||kinds.length!==map.hitObjects.length)throw new Error("Invalid miss-analysis map transport");
  Object.setPrototypeOf(map,Beatmap.prototype);let work=0;
  const restoredControls=new Set<ControlPointInfo>();
  function* controls(info:ControlPointInfo):Generator<void> {
    if(restoredControls.has(info))return;restoredControls.add(info);Object.setPrototypeOf(info,ControlPointInfo.prototype);
    const lists=[[info.difficultyPoints,DifficultyControlPoint.prototype],[info.timingPoints,TimingControlPoint.prototype],
      [info.samplePoints,SampleControlPoint.prototype],[info.effectPoints,EffectControlPoint.prototype]] as const;
    for(const [list,prototype] of lists) {
      Object.setPrototypeOf(list,SortedList.prototype);
      for(const point of list.list){if(++work%256===0)yield;Object.setPrototypeOf(point,prototype);}
    }
    for(const group of info.groups){if(++work%256===0)yield;Object.setPrototypeOf(group,ControlPointGroup.prototype);}
  }
  yield* controls(map.controlPointInfo);
  for(let index=0;index<map.hitObjects.length;index++) {
    if(++work%256===0)yield;const object=map.hitObjects[index];
    switch(kinds[index]) {
      case "HIT_CIRCLE":Object.setPrototypeOf(object,HitCircle.prototype);break;
      case "SPINNER":Object.setPrototypeOf(object,Spinner.prototype);break;
      case "SLIDER": {
        Object.setPrototypeOf(object,Slider.prototype);const slider=object as Slider;
        Object.setPrototypeOf(slider.head,HitCircle.prototype);Object.setPrototypeOf(slider.path,SliderPath.prototype);
        for(const points of [slider.checkPoints,slider.stableCheckPoints??[]])for(const point of points) {
          if(++work%256===0)yield;Object.setPrototypeOf(point,SliderCheckPoint.prototype);
        }
        if(slider.sampleControlPointInfo)yield* controls(slider.sampleControlPointInfo);break;
      }
      default:throw new Error("Invalid miss-analysis object type");
    }
  }
  return map;
}
export function hydratePreparedBeatmap(map:Beatmap,kinds:readonly string[]):Beatmap {
  const steps=hydrateSteps(map,kinds);let result=steps.next();while(!result.done)result=steps.next();return result.value;
}
export async function hydratePreparedBeatmapAsync(map:Beatmap,kinds:readonly string[],checkpoint:()=>Promise<void>):Promise<Beatmap> {
  await checkpoint();const steps=hydrateSteps(map,kinds);let result=steps.next();
  while(!result.done){await checkpoint();result=steps.next();}await checkpoint();return result.value;
}
