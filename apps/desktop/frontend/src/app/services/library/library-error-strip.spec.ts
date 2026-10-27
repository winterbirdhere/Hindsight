import type { ReplayAnalysisEvent } from "@osujs/core";
import { projectLibraryErrorStrip } from "./library-error-strip";
const checkpoint=async()=>undefined;
const domain={mapStartMs:1000,mapEndMs:3000,evaluatedThrough:1980,endpointBasis:"recorded-end" as const,synthesizedEndpoint:false};
const event=(time:number,verdict:"OK"|"MEH"|"MISS"="OK"):ReplayAnalysisEvent=>({type:"HitObjectJudgement",time:1980,judgementTime:1980,
  objectTime:time,hitObjectId:String(time),position:{x:0,y:0},ruleset:"stable",verdict});
it("preserves failed-prefix raw marks and early-resolved object time beyond the evaluated cutoff",async()=>{
  const result=await projectLibraryErrorStrip([event(2000)],"stable",domain,true,checkpoint);
  expect(result).toEqual({state:"known",value:{version:1,timeBasis:"map-ms",ruleset:"stable",...domain,ok:[2000],meh:[],miss:[],sliderBreak:[],sliderEndMiss:[]}});
});
it("distinguishes qualified empty from unavailable, malformed and future resolutions",async()=>{
  expect(await projectLibraryErrorStrip([],"stable",domain,true,checkpoint)).toMatchObject({state:"known",value:{ok:[],miss:[]}});
  expect(await projectLibraryErrorStrip([],"stable",domain,false,checkpoint)).toMatchObject({state:"unknown"});
  expect(await projectLibraryErrorStrip([{...event(2000),judgementTime:2001}],"stable",domain,true,checkpoint)).toMatchObject({state:"unknown"});
  expect(await projectLibraryErrorStrip([event(NaN)],"stable",domain,true,checkpoint)).toMatchObject({state:"unknown"});
});
it("separates native Classic component and tail losses from Stable slider breaks",async()=>{
  const base={time:1500,judgementTime:1500,objectTime:1500,position:{x:0,y:0},ruleset:"lazer" as const,sliderId:"s"};
  const events:ReplayAnalysisEvent[]=[{...base,type:"HitObjectJudgement",isSliderHead:true,affectsAccuracy:false,verdict:"MISS",hitObjectId:"h"},
    {...base,type:"SliderComponentMiss",eventId:"h",componentId:"h",componentType:"HEAD"},
    {...base,type:"SliderComponentMiss",eventId:"t",componentId:"t",componentType:"TAIL"}];
  expect(await projectLibraryErrorStrip(events,"lazer",domain,true,checkpoint)).toMatchObject({state:"known",value:{miss:[],componentMiss:[1500],sliderEndMiss:[1500]}});
});
it("retains all dense byte-fitting marks and reports a distinct byte-budget failure without truncation",async()=>{
  const marks=Array.from({length:3125},(_,i)=>event(1000+i/2));
  const projected=await projectLibraryErrorStrip(marks,"stable",domain,true,checkpoint);
  expect(projected).toMatchObject({state:"known",value:{ok:marks.map(e=>e.objectTime)}});
  const oversized=Array.from({length:5000},()=>event(Number.MAX_SAFE_INTEGER));
  expect(await projectLibraryErrorStrip(oversized,"stable",domain,true,checkpoint)).toEqual({state:"unknown",reason:"strip-byte-size-limit-v2"});
});
it("preserves a Stable tail resolved after the nominal map end",async()=>{
  const tail:ReplayAnalysisEvent={type:"CheckpointJudgement",ruleset:"stable",eventId:"tail",checkpointId:"tail",sliderId:"s",
    checkpointType:"LAST_LEGACY_TICK",hit:false,time:2964,judgementTime:2964,objectTime:2964,sliderEndTime:3100,position:{x:0,y:0}};
  expect(await projectLibraryErrorStrip([tail],"stable",{...domain,evaluatedThrough:3100},true,checkpoint))
    .toMatchObject({state:"known",value:{mapEndMs:3000,sliderEndMiss:[3100]}});
});
