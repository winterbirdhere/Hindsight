import { PERFORMANCE_ENGINE_VERSION, PerformanceResponse } from "@rewind/osu-performance/protocol";
import type { ReplayPerformanceInput } from "@rewind/osu-performance/types";
import type { LibraryMetricResult } from "../../../../shared/replay-library-metrics";
import { projectLibraryTimeline } from "../../../../frontend/src/app/services/library/library-timeline";
const emptyPerformanceStatistics=()=>({great:0,ok:0,meh:0,miss:0,large_tick_hit:0,large_tick_miss:0,small_tick_hit:0,small_tick_miss:0,slider_tail_hit:0,slider_tail_miss:0});

const input:ReplayPerformanceInput={mode:"stable",mods:[],limitations:[],finalReplayTime:300,states:[
  {time:100,passedObjects:1,maxCombo:1,statistics:emptyPerformanceStatistics()},
  {time:300,passedObjects:2,maxCombo:1,statistics:emptyPerformanceStatistics(),isFinal:true}]};
function numerical(completion:"passed"|"failed"|"unknown"="passed"):LibraryMetricResult{return{
  provenance:{replaySha256:"a".repeat(64),mapSha256:"b".repeat(64),mapMd5:"c".repeat(32),coverageQualified:true},
  fields:{completion:completion==="unknown"?{state:"unknown",reason:"incomplete"}:{state:"known",value:completion}}};}
function response(partial=false):PerformanceResponse{return{ok:true,engineVersion:PERFORMANCE_ENGINE_VERSION,timelines:[{
  mode:"stable",objectCount:partial?3:2,endpointVerified:!partial,points:[{time:100,pp:80,sr:2},{time:300,pp:20,sr:3}],difficultyPoints:[],final:{pp:20,sr:3}}]};}
const checkpoint=async()=>undefined;
it("keeps a failed play's peak while awarded PP is not applicable",async()=>{
  const value=await projectLibraryTimeline(input,response(true),3,numerical("failed"),checkpoint);
  expect(value.fields).toEqual({peakPp:{state:"known",value:80},pp:{state:"not-applicable",reason:"failed-no-pp-awarded"}});
});
it("requires qualified completion for awarded PP without hiding an observed peak",async()=>{
  expect((await projectLibraryTimeline(input,response(),2,numerical("unknown"),checkpoint)).fields).toEqual({
    peakPp:{state:"known",value:80},pp:{state:"unknown",reason:"completion-not-established"}});
  expect((await projectLibraryTimeline(input,response(),2,numerical(),checkpoint)).fields.pp).toEqual({state:"known",value:20});
  const partial=await projectLibraryTimeline(input,response(true),3,numerical(),checkpoint);
  expect(partial.fields.pp.state).toBe("unknown");
});
it("distinguishes calculated zero from an empty or synthetic empty-prefix timeline",async()=>{
  const zero=response();zero.timelines![0].points.forEach(point=>{point.pp=0;});zero.timelines![0].final!.pp=0;
  expect((await projectLibraryTimeline(input,zero,2,numerical(),checkpoint)).fields.peakPp).toEqual({state:"known",value:0});
  const empty=response();empty.timelines![0].points=[];empty.timelines![0].endpointVerified=false;
  expect((await projectLibraryTimeline({...input,states:[]},empty,2,numerical(),checkpoint)).fields.peakPp.state).toBe("unknown");
  empty.timelines![0].points=[{time:100,pp:0,sr:0}];empty.timelines![0].final={pp:0,sr:3};
  expect((await projectLibraryTimeline({...input,states:[{...input.states[0],passedObjects:0}]},empty,2,numerical(),checkpoint)).fields.peakPp.state).toBe("unknown");
});
it("does not publish plausible values when replay coverage is unqualified",async()=>{
  const evidence=numerical();evidence.provenance.coverageQualified=false;
  const value=await projectLibraryTimeline(input,response(),2,evidence,checkpoint);
  expect(value.fields.peakPp.state).toBe("unknown");expect(value.fields.pp.state).toBe("unknown");
});
it.each(["version","count","mode","points","time","nan","negative","compact","final"])("rejects incompatible %s output",async kind=>{
  const output=response(),timeline=output.timelines![0];
  if(kind==="version")output.engineVersion="old";
  if(kind==="count")timeline.objectCount=9;
  if(kind==="mode")timeline.mode="lazer";
  if(kind==="points")timeline.points.pop();
  if(kind==="time")timeline.points[1].time=299;
  if(kind==="nan")timeline.points[0].pp=NaN;
  if(kind==="negative")timeline.points[0].sr=-1;
  if(kind==="compact")timeline.fullMap={} as never;
  if(kind==="final")timeline.final!.pp=123;
  await expect(projectLibraryTimeline(input,output,2,numerical(),checkpoint)).rejects.toThrow();
});
it("yields while reducing a large timeline and preserves cancellation",async()=>{
  const states=Array.from({length:1024},(_,i)=>({...input.states[0],time:i,passedObjects:i+1}));
  const output=response();output.timelines![0]={...output.timelines![0],objectCount:1024,endpointVerified:true,
    points:states.map(state=>({time:state.time,pp:state.time%100,sr:1})),final:{pp:23,sr:1}};
  let checks=0;await expect(projectLibraryTimeline({...input,states},output,1024,numerical(),async()=>{
    if(++checks===3)throw Error("stop");
  })).rejects.toThrow("stop");
});
