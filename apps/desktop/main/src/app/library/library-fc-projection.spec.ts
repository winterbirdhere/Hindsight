import { PERFORMANCE_ENGINE_VERSION,PerformanceResponse } from "@rewind/osu-performance/protocol";
import type { ReplayPerformanceInput } from "@rewind/osu-performance/types";
import type { LibraryMetricResult } from "../../../../shared/replay-library-metrics";
import { libraryFcCalculation,projectLibraryFc } from "../../../../frontend/src/app/services/library/library-fc";
const state={time:300,passedObjects:2,maxCombo:2,isFinal:true,statistics:{great:1,ok:1,meh:0,miss:0,
  large_tick_hit:0,large_tick_miss:0,small_tick_hit:0,small_tick_miss:0,slider_tail_hit:0,slider_tail_miss:0}};
const input:ReplayPerformanceInput={mode:"lazer-classic",mods:[{acronym:"CL"},{acronym:"DT",settings:{speed_change:1.2}}],
  states:[state],fullComboState:state,finalReplayTime:300,limitations:[]};
const numerical=():LibraryMetricResult=>({fields:{completion:{state:"known",value:"passed"}},
  provenance:{coverageQualified:true,replaySha256:"a".repeat(64),mapSha256:"b".repeat(64),mapMd5:"c".repeat(32)}});
const response=():PerformanceResponse=>({ok:true,engineVersion:PERFORMANCE_ENGINE_VERSION,timelines:[{mode:input.mode,
  objectCount:2,endpointVerified:true,points:[{time:300,pp:0,sr:1}],difficultyPoints:[],final:{pp:0,sr:1}}]});
it("reuses full-combo input/profile for one compact calculation and preserves zero",()=>{
  const calculation=libraryFcCalculation(input,numerical(),2);
  expect(calculation).toEqual({mode:input.mode,mods:input.mods,scope:"full-map",states:[state]});
  expect(projectLibraryFc(input,response(),2,numerical()).fields.ppIfFc).toEqual({state:"known",value:0});
});
it.each(["failed","unknown","unqualified","partial","absent"])("does not infer FC performance from %s evidence",kind=>{
  const proof=numerical(),candidate={...input};
  if(kind==="failed")proof.fields.completion={state:"known",value:"failed"};
  if(kind==="unknown")proof.fields.completion={state:"unknown",reason:"missing"};
  if(kind==="unqualified")proof.provenance.coverageQualified=false;
  if(kind==="partial")candidate.fullComboState={...state,passedObjects:1};
  if(kind==="absent")candidate.fullComboState=undefined;
  expect(libraryFcCalculation(candidate,proof,2)).toBeUndefined();
  expect(projectLibraryFc(candidate,response(),2,proof).fields.ppIfFc.state).not.toBe("known");
});
it.each(["version","mode","count","time","nonfinite"])("rejects incompatible %s compact output",kind=>{
  const output=response(),timeline=output.timelines![0];
  if(kind==="version")output.engineVersion="old";if(kind==="mode")timeline.mode="stable";
  if(kind==="count")timeline.objectCount=3;if(kind==="time")timeline.points[0].time=299;
  if(kind==="nonfinite")timeline.final!.pp=NaN;
  expect(()=>projectLibraryFc(input,output,2,numerical())).toThrow(/FC/);
});
