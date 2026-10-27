import { deserialize, serialize } from "v8";
import { Slider, buildBeatmap, parseBlueprint } from "@osujs/core";
import { traceMapText } from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { hydratePreparedBeatmapAsync } from "./PreparedBeatmapWire";

it("cooperatively hydrates exact prepared geometry and shared checkpoint/dictionary aliases",async()=>{
  const map=buildBeatmap(parseBlueprint(traceMapText("100,192,1000,2,0,B|240:140|300:192,2,150")),{mods:[],addStacking:false});
  const source=map.hitObjects[0] as Slider, clone=deserialize(serialize(map));let checkpoints=0;
  const result=await hydratePreparedBeatmapAsync(clone,map.hitObjects.map(o=>o.type),async()=>{checkpoints++;});
  const slider=result.hitObjects[0] as Slider;expect(result).toBe(clone);expect(slider).toBeInstanceOf(Slider);
  expect(result.getHitObject(slider.id)).toBe(slider);expect(slider.head).toBe(result.getHitObject(slider.head.id));
  expect(slider.checkPoints[0].slider).toBe(slider);
  expect([0,.2,.5,1].map(t=>slider.ballPositionAt(t))).toEqual([0,.2,.5,1].map(t=>source.ballPositionAt(t)));
  expect(checkpoints).toBeGreaterThan(1);
});

it("cancels hydration before publishing a partly restored map",async()=>{
  const map=buildBeatmap(parseBlueprint(traceMapText(Array.from({length:600},(_,i)=>`300,192,${1000+i*10},1,0`).join("\n"))),{mods:[],addStacking:false});
  const error=new Error("hydrate cancelled");let calls=0;
  await expect(hydratePreparedBeatmapAsync(deserialize(serialize(map)),map.hitObjects.map(o=>o.type),async()=>{if(++calls===2)throw error;})).rejects.toBe(error);
  expect(calls).toBe(2);
});
