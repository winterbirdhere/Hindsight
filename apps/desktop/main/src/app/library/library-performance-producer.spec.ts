import { produceLibraryPerformance,LibraryPerformanceProducerPorts } from "./library-performance-producer";
import { PERFORMANCE_ENGINE_VERSION,PerformanceRequest } from "@rewind/osu-performance/protocol";
import type { LibraryMapCalculation } from "./library-map-performance";
import type { LibraryPerformanceScoreEvidence } from "./library-performance-score";
const map={sha256:"a".repeat(64),md5:"b".repeat(32),ruleset:0,baseBpm:120};
const score:LibraryPerformanceScoreEvidence={origin:null,nativeRequired:false,header:{mode:0,version:20250101,modsBitmask:0,
  counts:{great:1,ok:1,meh:0,miss:1},maxCombo:1,score:123}};
function fixture(){
  const maps=new Map<string,LibraryMapCalculation>(),scalars=new Map<string,number>(),requests:PerformanceRequest["calculations"][]=[];
  const ports:LibraryPerformanceProducerPorts={mapCache:{get:async key=>maps.get(key),put:async(key,_mode,value)=>{maps.set(key,value);}},
    scalarCache:{get:async key=>scalars.get(key),put:async(key,_mode,value)=>{scalars.set(key,value);}},calculate:async calculations=>{
      requests.push(calculations);return{ok:true,engineVersion:PERFORMANCE_ENGINE_VERSION,timelines:calculations.map(calculation=>{
        const dt=calculation.mods.some(mod=>mod.acronym==="DT"),state=calculation.states[0],pp=state?.statistics.miss?0:4;
        return{mode:calculation.mode,objectCount:3,endpointVerified:!!state,points:state?[{time:state.time,pp,sr:2}]:[],difficultyPoints:[],
          final:state?{pp,sr:2}:null,fullDifficulty:{total:dt?3:2,aim:1,speed:1,reading:0,flashlight:0,sliderFactor:1},
          fullMap:{version:1,maxCombo:3,largeTicks:0,smallTicks:0,sliderTails:0,clockRate:dt?1.5:1,drainTimeMs:dt?2000:3000,endTimeMs:4000}};
      })};}};
  return{ports,requests,maps,scalars};
}
it("deduplicates NM/profile math, batches aggregate/FC, and reuses both scalar caches with no simulation",async()=>{
  const f=fixture(),first=await produceLibraryPerformance(map,score,f.ports,new AbortController().signal);
  expect(f.requests.map(request=>request.length)).toEqual([1,2]);
  expect(f.requests.flat().every(calculation=>calculation.scope==="full-map"&&calculation.states.length<=1)).toBe(true);
  expect(first.find(result=>result.slot==="aggregate-pp")?.fields.pp).toEqual({state:"known",value:0});
  expect(first.find(result=>result.slot==="fc-pp")?.fields.ppIfFc).toEqual({state:"known",value:4});
  const [actual,fc]=f.requests[1];expect(actual.states[0].legacyTotalScore).toBe(123);expect(fc.states[0]).not.toHaveProperty("legacyTotalScore");
  expect(fc.states[0].statistics).toMatchObject({great:2,ok:1,meh:0,miss:0});expect(fc.states[0].maxCombo).toBe(3);
  expect(await produceLibraryPerformance(map,score,f.ports,new AbortController().signal)).toEqual(first);expect(f.requests).toHaveLength(2);
  expect(first.every(result=>!("completion" in result.fields)&&!("fc" in result.fields)&&!("peakPp" in result.fields))).toBe(true);
});
it("keeps no-mod stars separate and applies the official constant rate only once",async()=>{
  const f=fixture(),results=await produceLibraryPerformance(map,{...score,header:{...score.header!,modsBitmask:64}},f.ports,new AbortController().signal);
  expect(f.requests[0]).toHaveLength(2);expect(results[0].fields).toMatchObject({mapStars:{state:"known",value:2},replayStars:{state:"known",value:3},
    bpm:{state:"known",value:180},lengthMs:{state:"known",value:2000}});
});
it("publishes NM math with truthful unavailable profile and aggregate fields",async()=>{
  const f=fixture(),results=await produceLibraryPerformance(map,{...score,nativeRequired:true},f.ports,new AbortController().signal);
  expect(f.requests.map(request=>request.length)).toEqual([1]);expect(results[0].fields.mapStars).toEqual({state:"known",value:2});
  expect(results[0].fields.replayStars.state).toBe("unknown");expect(results[1].fields.pp.state).toBe("unknown");expect(f.scalars.size).toBe(0);
});
it("does not turn malformed helper output or unsupported map mode into zero or cache it",async()=>{
  const f=fixture();f.ports.calculate=async()=>({ok:false});
  const result=await produceLibraryPerformance(map,score,f.ports,new AbortController().signal);expect(result[0].fields.mapStars.state).toBe("unknown");
  expect(f.maps.size).toBe(0);expect(f.scalars.size).toBe(0);
  const noCall=jest.fn(f.ports.calculate);f.ports.calculate=noCall;
  await produceLibraryPerformance({...map,ruleset:3},score,f.ports,new AbortController().signal);expect(noCall).not.toHaveBeenCalled();
});
it("cancels before calculation and after drained map output without beginning aggregate work",async()=>{
  const f=fixture(),abort=new AbortController(),calculate=f.ports.calculate;
  f.ports.calculate=async values=>{const value=await calculate(values);abort.abort();return value;};
  await expect(produceLibraryPerformance(map,score,f.ports,abort.signal)).rejects.toThrow();expect(f.requests).toHaveLength(1);expect(f.maps.size).toBe(0);
  await expect(produceLibraryPerformance(map,score,f.ports,abort.signal)).rejects.toThrow();expect(f.requests).toHaveLength(1);
});
it("preserves native Classic component FC math when only the aggregate scalar is cached",async()=>{
  const f=fixture(),calculate=f.ports.calculate;
  f.ports.calculate=async values=>{
    const response=await calculate(values) as {timelines:{fullMap:Record<string,number>}[]};
    for(const timeline of response.timelines)Object.assign(timeline.fullMap,{maxCombo:8,largeTicks:2,smallTicks:1,sliderTails:1});return response;
  };
  const evidence:LibraryPerformanceScoreEvidence={origin:null,nativeRequired:true,native:{isLegacyScore:false,ruleset:0,mods:[{acronym:"CL"}],maxCombo:3,
    statistics:{Great:1,Ok:1,Meh:0,Miss:1,LargeTickHit:1,LargeTickMiss:1,SmallTickHit:1,SmallTickMiss:0,SliderTailHit:0},maximumStatistics:{SliderTailHit:1}}};
  const initial=await produceLibraryPerformance(map,evidence,f.ports,new AbortController().signal);
  const fc=initial.find(value=>value.slot==="fc-pp")!;f.scalars.delete(fc.inputKey);f.requests.length=0;
  const repeated=await produceLibraryPerformance(map,evidence,f.ports,new AbortController().signal);expect(repeated).toEqual(initial);
  expect(f.requests.map(values=>values.length)).toEqual([1]);expect(f.requests[0][0]).toMatchObject({mode:"lazer-classic",mods:[{acronym:"CL"}],
    states:[{maxCombo:8,statistics:{great:2,ok:1,meh:0,miss:0,large_tick_hit:2,large_tick_miss:0,small_tick_hit:1,small_tick_miss:0,slider_tail_hit:1,slider_tail_miss:0}}]});
});

it("publishes dominant BPM independently of unavailable map math",async()=>{
  const f=fixture();f.ports.calculate=async()=>({ok:false});
  const results=await produceLibraryPerformance({...map,baseBpm:240},{...score,header:{...score.header!,modsBitmask:64}},f.ports,new AbortController().signal);
  expect(results[0].fields.bpm).toEqual({state:"known",value:360});
  expect(results[0].fields.replayStars.state).toBe("unknown");expect(results[1].fields.pp.state).toBe("unknown");
});
it.each([[[],120],[[{acronym:"NC"}],180],[[{acronym:"HT"}],90],[[{acronym:"DC",settings:{speed_change:0.8}}],96],
  [[{acronym:"DT",settings:{speed_change:1.2}}],144],[[{acronym:"RX"}],120],[[{acronym:"CL"},{acronym:"AP"}],120],
  [[{acronym:"NC"},{acronym:"DT"}],180],[[{acronym:"NC",settings:{speed_change:1.2}},{acronym:"DT",settings:{speed_change:1.2}}],144],
  [[{acronym:"DT",settings:{speed_change:1.237}}],148.8]])
  ("qualifies uniform exact native recording rates independently of math: %j",async(mods,bpm)=>{
    const f=fixture();f.ports.calculate=async()=>({ok:false});
    const evidence={...score,nativeRequired:true,native:{ruleset:0,isLegacyScore:false,mods,maxCombo:0,statistics:{}}};
    expect((await produceLibraryPerformance(map,evidence,f.ports,new AbortController().signal))[0].fields.bpm).toEqual({state:"known",value:bpm});
  });
it.each([[{acronym:"WU"}],[{acronym:"WD"}],[{acronym:"AS"}],[{acronym:"XX",settings:{speed_change:1.2}}],
  [{acronym:"DT"},{acronym:"HT"}],[{acronym:"DT",settings:{speed_change:9}}],[{acronym:"DT",settings:{speed_change:0}}],
  [{acronym:"DT",settings:{speed_change:NaN}}],[{acronym:"DT",settings:{speed_change:-1}}],
  [{acronym:"NC"},{acronym:"DT",settings:{speed_change:1.2}}],[{acronym:"NF",settings:{speed_change:1.2}}]])
  ("does not substitute a t=0 rate or clamp conflicting/malformed clocks: %j",async(...mods)=>{
    const f=fixture(),evidence={...score,nativeRequired:true,native:{ruleset:0,isLegacyScore:false,mods,maxCombo:0,statistics:{}}};
    expect((await produceLibraryPerformance(map,evidence,f.ports,new AbortController().signal))[0].fields.bpm.state).toBe("unknown");
  });
it("retains real calculate rejection and drain/cancellation ownership failures",async()=>{
  const f=fixture();f.ports.calculate=async()=>{throw new Error("native drain acknowledgement failed");};
  await expect(produceLibraryPerformance(map,score,f.ports,new AbortController().signal)).rejects.toThrow("drain acknowledgement");
});
it("binds BPM clock qualification into the result identity before NC normalization drops an alias",async()=>{
  const f=fixture(),native={ruleset:0,isLegacyScore:false,maxCombo:0,statistics:{}};
  const valid=await produceLibraryPerformance(map,{...score,nativeRequired:true,native:{...native,mods:[{acronym:"NC"}]}},f.ports,new AbortController().signal);
  const invalid=await produceLibraryPerformance(map,{...score,nativeRequired:true,native:{...native,
    mods:[{acronym:"NC"},{acronym:"DT",settings:{speed_change:1.2}}]}},f.ports,new AbortController().signal);
  expect(valid[0].fields.bpm.state).toBe("known");expect(invalid[0].fields.bpm.state).toBe("unknown");
  expect(invalid[0].inputKey).not.toBe(valid[0].inputKey);
});
it.each([{...score,profileConflict:true},{...score,header:{...score.header!,mode:3}},
  {...score,nativeRequired:true},{...score,origin:"unknown" as const}])("preserves exact profile and standard-mode qualification",async evidence=>{
  const f=fixture();expect((await produceLibraryPerformance(map,evidence,f.ports,new AbortController().signal))[0].fields.bpm.state).toBe("unknown");
});
it("publishes a diagnosed resource budget cause without recasting it as undefined tempo",async()=>{
  const f=fixture();
  const results=await produceLibraryPerformance({...map,baseBpm:null,tempoUnavailableReason:"tempo-geometry-budget"},score,f.ports,new AbortController().signal);
  expect(results[0].fields.bpm).toEqual({state:"unknown",reason:"tempo-geometry-budget"});
  expect(results[0].fields.replayStars.state).toBe("known");
});
