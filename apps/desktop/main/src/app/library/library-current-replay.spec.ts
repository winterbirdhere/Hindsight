import { LibraryCurrentReplayApi } from "./library-current-replay-api";
import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import type { ReplayPerformanceInput } from "@rewind/osu-performance/types";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_PERFORMANCE_INPUT_VERSION, LIBRARY_RECONSTRUCTED_FC_VERSION,
  LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION, LIBRARY_TIMELINE_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import { CurrentReplayReuseBinding, CurrentReplayCompletedResults, projectCurrentReplayResults } from "../../../../frontend/src/app/services/library/library-current-replay";
import { LIBRARY_STRIP_MAX_MARKS } from "../../../../shared/library-error-strip";

function binding(): CurrentReplayReuseBinding {
  return { replaySha256:"a".repeat(64), mapSha256:"b".repeat(64), mapMd5:"c".repeat(32), numericalInputKey:"d".repeat(64),
    mode:"stable", clockRate:1, objectCount:2, parserVersion:LIBRARY_REPLAY_PARSER_VERSION,
    preparationVersion:LIBRARY_RESOURCE_PREPARATION_VERSION };
}
function performanceInput(): ReplayPerformanceInput {
  const state={time:300,passedObjects:2,maxCombo:2,isFinal:true,statistics:{great:2,ok:0,meh:0,miss:0,
    large_tick_hit:0,large_tick_miss:0,small_tick_hit:0,small_tick_miss:0,slider_tail_hit:0,slider_tail_miss:0}};
  return {mode:"stable",states:[state],mods:[],limitations:[],finalReplayTime:300,fullComboState:{...state}};
}
function completed(): CurrentReplayCompletedResults {
  return {binding:binding(),numerical:{status:"complete",projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,
    evidence:{coverageQualified:true,completeAccuracyEvidence:true,completeBreakEvidence:true,comboLosses:0,exactMapMaxCombo:2,
      completion:{coverage:{exactMapAndProfile:true,expectedJudgements:2,observedJudgements:2,
        terminalJudgementObserved:true,replayCoverage:"complete"}}},
    info:{accuracy:1,maxComboSoFar:2,verdictCounts:[2,0,0,0]},
    stats:{sliderBreakCount:0,sliderEndMissCount:0},timing:{available:true,sampleCount:2,meanOffsetMs:0,unstableRate:0}},
    performance:{engineVersion:PERFORMANCE_ENGINE_VERSION,inputVersion:LIBRARY_PERFORMANCE_INPUT_VERSION,
      timelineVersion:LIBRARY_TIMELINE_PROJECTION_VERSION,fcVersion:LIBRARY_RECONSTRUCTED_FC_VERSION,
      timeline:{mode:"stable",objectCount:2,endpointVerified:true,pointCount:1,lastPoint:{time:300,pp:0,sr:1}},
      fcTimeline:{mode:"stable",objectCount:2,endpointVerified:true,pointCount:1,lastPoint:{time:300,pp:0,sr:1}},
      input:performanceInput(),fullMap:{status:"ready",pp:0,peakPp:0,fullComboPp:0,sr:1,description:"current replay"}}};
}
function projected(value=completed(),expected=binding()) { return projectCurrentReplayResults(expected,value); }
function fields(slot:"numerical"|"timeline-pp"|"fc-pp",value=completed()) {
  const result=projected(value);
  return result.state==="compatible"?result.projections.find(projection=>projection.slot===slot)?.metrics.fields:undefined;
}

it("reuses completed zero timing and performance values with qualified completion and combo",()=>{
  expect(projected().state).toBe("compatible");
  expect(fields("numerical")).toMatchObject({completion:{state:"known",value:"passed"},fc:{state:"known",value:true},
    perfectCombo:{state:"known",value:true},ur:{state:"known",value:0},biasMs:{state:"known",value:0},
    sliderBreaks:{state:"known",value:0},misses:{state:"known",value:0}});
  expect(fields("timeline-pp")).toEqual({pp:{state:"known",value:0},peakPp:{state:"known",value:0}});
  expect(fields("fc-pp")).toEqual({ppIfFc:{state:"known",value:0}});
});

it("requires raw combo-loss evidence for ordinary FC while exact combo equality stays independent",()=>{
  const result=completed();result.numerical!.evidence!.comboLosses=1;
  expect(fields("numerical",result)).toMatchObject({fc:{state:"known",value:false},perfectCombo:{state:"known",value:true},comboLosses:{state:"known",value:1}});
  result.numerical!.evidence!.comboLosses=null;
  expect(fields("numerical",result)).toMatchObject({fc:{state:"unknown"},perfectCombo:{state:"known",value:true}});
  result.numerical!.evidence!.comboLosses=0;result.numerical!.info!.maxComboSoFar=1;
  expect(fields("numerical",result)).toMatchObject({fc:{state:"known",value:true},perfectCombo:{state:"known",value:false}});
  result.numerical!.evidence!.exactMapMaxCombo=null;
  expect(fields("numerical",result)).toMatchObject({fc:{state:"known",value:true},perfectCombo:{state:"unknown"}});
});

it.each(["lazer","lazer-classic"] as const)("keeps native %s tail loss separate from ordinary FC",mode=>{
  const result=completed();result.binding.mode=mode;result.performance!.input.mode=mode;
  result.numerical!.info!.maxComboSoFar=1;result.numerical!.stats={sliderEndMissCount:1,sliderTickMissCount:0};
  const projection=projected(result,{...binding(),mode});
  if(projection.state!=="compatible")throw new Error("Expected compatible native binding");
  const output=projection.projections.find(item=>item.slot==="numerical")!.metrics.fields;
  expect(output).toMatchObject({sliderBreaks:{state:"not-applicable",reason:"stable-slider-breaks-only"},
    fc:{state:"known",value:true},perfectCombo:{state:"known",value:false},sliderEndMisses:{state:"known",value:1}});
});

it("does not infer completion from a full count, max combo, or a final performance snapshot",()=>{
  const result=completed();result.numerical!.evidence!.completion={};result.performance!.fullMap.peakPp=42;
  expect(fields("numerical",result)!.completion.state).toBe("unknown");
  expect(fields("numerical",result)!.fc.state).toBe("unknown");
  expect(fields("timeline-pp",result)).toEqual({pp:{state:"unknown",reason:"completion-not-established"},peakPp:{state:"known",value:42}});
  expect(fields("fc-pp",result)!.ppIfFc.state).toBe("unknown");
});

it("retains a failed replay's actual peak without awarding PP or an FC estimate",()=>{
  const result=completed();result.numerical!.evidence!.completion={sourceVerified:true,sourcePassed:false};
  result.performance!.fullMap.peakPp=99;
  expect(fields("numerical",result)!.fc.state).toBe("not-applicable");
  expect(fields("timeline-pp",result)).toEqual({pp:{state:"not-applicable",reason:"failed-no-pp-awarded"},peakPp:{state:"known",value:99}});
  expect(fields("fc-pp",result)!.ppIfFc.state).toBe("not-applicable");
});

it("keeps missing or unqualified evidence unknown without converting it to zero",()=>{
  const result=completed();result.numerical!.info=undefined;result.numerical!.stats=undefined;
  result.numerical!.timing={available:false,sampleCount:0,meanOffsetMs:0,unstableRate:0};
  const output=fields("numerical",result)!;
  for(const name of ["accuracy","misses","maxCombo","sliderBreaks","ur","biasMs","fc"])expect(output[name].state).toBe("unknown");
  expect(output.sampleCount).toEqual({state:"known",value:0});
  result.numerical!.evidence!.coverageQualified=false;
  expect(fields("timeline-pp",result)!.peakPp.state).toBe("unknown");
});

it("publishes independently ready numerical and timeline values without waiting for FC",()=>{
  const result=completed();result.performance!.fullMap.fullComboPp=undefined;
  expect(projected(result).projections.map(item=>item.slot)).toEqual(["numerical","timeline-pp"]);
  result.performance!.fullMap.status="loading";
  expect(projected(result).projections.map(item=>item.slot)).toEqual(["numerical"]);
  result.performance!.fullMap.status="ready";result.performance!.fullMap.fullComboPp=0;
  expect(fields("fc-pp",result)!.ppIfFc).toEqual({state:"known",value:0});
});

it.each(["replaySha256","mapSha256","mapMd5","numericalInputKey","mode","clockRate","objectCount","parserVersion","preparationVersion"] as const)(
  "rejects mismatched %s before returning any result",key=>{
    const result=completed();const values:Record<typeof key,unknown>={ [key]: key==="mode"?"lazer":key==="clockRate"?1.5:key==="objectCount"?3:"e".repeat(key==="mapMd5"?32:64) } as Record<typeof key,unknown>;
    (result.binding as unknown as Record<string,unknown>)[key]=values[key];
    expect(projected(result)).toMatchObject({state:"incompatible",projections:[]});
  });

it("rejects equally stale parser/preparation bindings and invalid identities",()=>{
  for(const update of [{parserVersion:"old"},{preparationVersion:"old"},{numericalInputKey:""},{objectCount:0},{clockRate:NaN}]){
    const result=completed();Object.assign(result.binding,update);
    expect(projected(result,{...binding(),...update}).state).toBe("incompatible");
  }
});

it("rejects obsolete performance versions without suppressing independently completed numerical values",()=>{
  for(const key of ["engineVersion","inputVersion","timelineVersion"] as const){
    const result=completed();result.performance![key]="old";
    expect(projected(result).projections.map(item=>item.slot)).toEqual(["numerical"]);
  }
  const result=completed();result.performance!.fcVersion="old";
  expect(projected(result).projections.map(item=>item.slot)).toEqual(["numerical","timeline-pp"]);
  result.numerical!.projectionVersion="old";
  expect(projected(result).projections).toEqual([]);
});

it("does not reuse the viewer's synthetic empty-prefix zero or an unbound mode",()=>{
  for(const configure of [(input:ReplayPerformanceInput)=>{input.states=[];},
    (input:ReplayPerformanceInput)=>{input.states=[{...input.states[0],passedObjects:0}];},
    (input:ReplayPerformanceInput)=>{input.mode="lazer";},
    (input:ReplayPerformanceInput)=>{input.finalReplayTime=301;}]){
    const result=completed();configure(result.performance!.input);
    expect(projected(result).projections.map(item=>item.slot)).toEqual(["numerical"]);
  }
});

it("rejects completion coverage for a different map count and preserves finite signed timing bias",()=>{
  const result=completed();result.numerical!.evidence!.completion.coverage!.expectedJudgements=3;
  result.numerical!.timing!.meanOffsetMs=-5;
  expect(fields("numerical",result)!.completion.state).toBe("unknown");
  expect(fields("numerical",result)!.biasMs).toEqual({state:"known",value:-5});
});

it("copies only compact metric scalars and does not retain input graphs or caller-owned objects",()=>{
  const result=completed();Object.assign(result.numerical!,{causes:{secret:"do not persist"}});
  const output=projected(result);result.numerical!.info!.accuracy=0;result.performance!.fullMap.pp=17;
  expect(output.projections[0].metrics.fields.accuracy).toEqual({state:"known",value:1});
  expect(output.projections[1].metrics.fields.pp).toEqual({state:"known",value:0});
  expect(JSON.stringify(output)).not.toMatch(/do not persist|statistics|verdictCounts|fullComboState|description/);
  expect(output).not.toHaveProperty("then");
});

it("cannot turn unqualified replay coverage into completion, even when presentation counts look complete",()=>{
  const result=completed();result.numerical!.evidence!.coverageQualified=false;
  expect(fields("numerical",result)!.completion.state).toBe("unknown");
  result.numerical!.evidence!.completion={sourcePassed:true,sourceVerified:true};
  expect(fields("numerical",result)!.completion).toEqual({state:"known",value:"passed"});
  expect(fields("numerical",result)!.fc.state).toBe("unknown");
  expect(fields("timeline-pp",result)!.pp.state).toBe("unknown");
});

it("copies a validated compact strip without retaining mutable channel arrays",()=>{
  const result=completed();result.numerical!.errorStrip={state:"known",value:{version:1,timeBasis:"map-ms",ruleset:"stable",
    mapStartMs:100,mapEndMs:300,evaluatedThrough:320,endpointBasis:"recorded-end",synthesizedEndpoint:false,
    ok:[],meh:[],miss:[],sliderEndMiss:[310],sliderBreak:[]}};
  const projectedStrip=projected(result).projections[0].metrics.errorStrip;
  result.numerical!.errorStrip.value.sliderEndMiss.push(311);
  expect(projectedStrip).toMatchObject({state:"known",value:{sliderEndMiss:[310],evaluatedThrough:320}});
});

it.each(["oversize","extra-graph","wrong-ruleset"])("does not reuse an invalid %s strip as a clean timeline",kind=>{
  const result=completed();result.numerical!.errorStrip={state:"known",value:{version:1,timeBasis:"map-ms",ruleset:"stable",
    mapStartMs:100,mapEndMs:300,evaluatedThrough:300,endpointBasis:"recorded-end",synthesizedEndpoint:false,
    ok:[],meh:[],miss:[],sliderEndMiss:[],sliderBreak:[]}};
  const strip=result.numerical!.errorStrip.value;
  if(kind==="oversize")strip.ok=Array(LIBRARY_STRIP_MAX_MARKS+1).fill(100);
  if(kind==="extra-graph")Object.assign(strip,{causes:[]});
  if(kind==="wrong-ruleset")result.numerical!.errorStrip={state:"known",value:{version:1,timeBasis:"map-ms",ruleset:"lazer",
    mapStartMs:100,mapEndMs:300,evaluatedThrough:300,endpointBasis:"recorded-end",synthesizedEndpoint:false,
    ok:[],meh:[],miss:[],sliderEndMiss:[],componentMiss:[]}};
  expect(projected(result).projections[0].metrics.errorStrip!.state).toBe("unknown");
});

it.each(["negative","nonfinite","below-final"])("does not reuse an invalid %s completed performance summary",kind=>{
  const result=completed();result.performance!.fullMap.pp=20;
  result.performance!.fullMap.peakPp=kind==="negative"?-1:kind==="nonfinite"?NaN:10;
  expect(projected(result).projections.map(item=>item.slot)).toEqual(["numerical"]);
});

it("does not accept presentation zero when the completed engine timeline had no points",()=>{
  const result=completed();Object.assign(result.performance!,{timeline:{mode:"stable",objectCount:2,endpointVerified:true,pointCount:0}});
  expect(projected(result).projections.map(item=>item.slot)).toEqual(["numerical"]);
});

it.each(["count","mode","objects","endpoint","time","value"])("requires matching compact %s response evidence",kind=>{
  const result=completed(),endpoint=result.performance!.timeline!;
  if(kind==="count")endpoint.pointCount=2;
  if(kind==="mode")endpoint.mode="lazer";
  if(kind==="objects")endpoint.objectCount=3;
  if(kind==="endpoint")endpoint.endpointVerified=false;
  if(kind==="time")endpoint.lastPoint!.time=299;
  if(kind==="value")endpoint.lastPoint!.pp=1;
  expect(projected(result).projections.map(item=>item.slot)).toEqual(["numerical"]);
});

it("does not treat a ready timeline as completed FC-response evidence",()=>{
  const result=completed();result.performance!.fcTimeline=undefined;
  expect(projected(result).projections.map(item=>item.slot)).toEqual(["numerical","timeline-pp"]);
});

it("reuses authoritative projected numerical evidence without fabricating display-derived proof",()=>{
  const result=completed();result.numerical={status:"complete",projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,
    projected:{provenance:{replaySha256:result.binding.replaySha256,mapSha256:result.binding.mapSha256,mapMd5:result.binding.mapMd5,
      rate:1,ruleset:"stable",projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,completionEvidence:"source-domain-coverage-v1",
      coverageQualified:true,completeAccuracyEvidence:true,completeBreakEvidence:true},fields:{completion:{state:"known",value:"passed"},
      misses:{state:"known",value:0},comboLosses:{state:"known",value:1},fc:{state:"known",value:false},perfectCombo:{state:"known",value:false}}}};
  Object.defineProperty(result.numerical.projected!,"causes",{get:()=>{throw new Error("Cause graph must not be read");}});
  expect(fields("numerical",result)).toMatchObject({fc:{state:"known",value:false},comboLosses:{state:"known",value:1}});
  result.numerical.projected!.provenance.mapSha256="e".repeat(64);
  expect(projected(result).projections).toEqual([]);
});

it.each([3125,3105,"byte-limit"] as const)("publishes dense %s current-viewer marks within the unchanged whole96KiB boundary",async count=>{
  const value=completed(),strip={state:"known" as const,value:{version:1 as const,timeBasis:"map-ms" as const,ruleset:"stable" as const,
    mapStartMs:0,mapEndMs:300,evaluatedThrough:320,endpointBasis:"recorded-end" as const,synthesizedEndpoint:false,
    ok:[] as number[],meh:[],miss:[],sliderEndMiss:[],sliderBreak:[]}};
  strip.value.ok=Array(count==="byte-limit"?Math.floor((65536-Buffer.byteLength(JSON.stringify(strip))+1)/2):count).fill(0);
  value.numerical!.errorStrip=strip;const results=projected(value).projections.map(({slot,producerVersion,metrics})=>({slot,producerVersion,metrics}));
  expect(results[0].metrics.errorStrip).toEqual(strip);
  const publish=jest.fn(async()=>({state:"applied" as const,accepted:results.map(r=>r.slot)})),api=new LibraryCurrentReplayApi({publish});
  const b=binding(),receipt=api.issue({version:1,replayId:"current",replaySha256:b.replaySha256,mapSha256:b.mapSha256,mapMd5:b.mapMd5,
    numericalInputKey:b.numericalInputKey,parserVersion:b.parserVersion,preparationVersion:b.preparationVersion,numericalVersion:LIBRARY_NUMERIC_PROJECTION_VERSION},{});
  const request={method:"current-replay-publish",token:receipt.token,results};expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(96*1024);
  await expect(api.receive(request,()=>undefined)).resolves.toMatchObject({state:"applied"});expect(publish).toHaveBeenCalledTimes(1);
  const oversized={...request,results:[...results,...results,...results]};expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(count==="byte-limit"?96*1024:0);
  await expect(api.receive(oversized,()=>undefined)).rejects.toThrow();expect(publish).toHaveBeenCalledTimes(1);await api.close();
});
