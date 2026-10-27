import { resolveLibraryPerformanceProfile,qualifyLibraryAggregateScore,LibraryPerformanceScoreEvidence } from "./library-performance-score";
import type { LibraryMapCalculation } from "./library-map-performance";
const map:LibraryMapCalculation={version:1,objectCount:3,stars:1,maxCombo:9,largeTicks:2,smallTicks:1,sliderTails:1,clockRate:1,drainTimeMs:1000,endTimeMs:2000};
const header={mode:0,version:20250101,modsBitmask:64,counts:{great:2,ok:1,meh:0,miss:0},maxCombo:8,score:1234};
const native={ruleset:0,isLegacyScore:false,mods:[],maxCombo:8,statistics:{Great:2,Ok:1,Meh:0,Miss:0,LargeTickHit:1,LargeTickMiss:1,SmallTickHit:1,SmallTickMiss:0,SliderTailHit:1},maximumStatistics:{SliderTailHit:1}};
const evidence=(changes:Partial<LibraryPerformanceScoreEvidence>={}):LibraryPerformanceScoreEvidence=>({header,origin:null,nativeRequired:false,...changes});
it("qualifies Stable saved aggregates without replay data and ignores irrelevant header identity fields",()=>{
  const input=evidence(),profile=resolveLibraryPerformanceProfile(input);expect(profile).toMatchObject({state:"known",mode:"stable",mods:[{acronym:"DT"}]});
  const score=qualifyLibraryAggregateScore(input,map);expect(score).toMatchObject({state:"known",score:{mode:"stable",basic:[2,1,0,0],maxCombo:8,legacyScoreV1:1234}});
  expect(qualifyLibraryAggregateScore(evidence({header:{...header,score:-1}}),map)).toMatchObject({state:"unknown"});
  expect(qualifyLibraryAggregateScore(evidence({header:{...header,modsBitmask:1<<29}}),map)).toMatchObject({state:"known",score:{mode:"stable"}});
  const v2=qualifyLibraryAggregateScore(evidence({header:{...header,modsBitmask:1<<29}}),map);if(v2.state!=="known")throw new Error(v2.reason);
  expect(v2.score).not.toHaveProperty("legacyScoreV1");
});
it("never downgrades native or unknown origin to Stable or silently drops unsupported legacy bits",()=>{
  for(const input of [evidence({nativeRequired:true}),evidence({origin:"lazer"}),evidence({origin:"unknown"}),
    evidence({header:{...header,version:30000001}}),evidence({header:{...header,modsBitmask:1<<23}})])
    expect(resolveLibraryPerformanceProfile(input).state).toBe("unknown");
  expect(resolveLibraryPerformanceProfile(evidence({native}))).toMatchObject({state:"known",mode:"lazer",mods:[]});
  expect(resolveLibraryPerformanceProfile(evidence({native:{...native,mods:[{acronym:"CL"},{acronym:"DT",settings:{speed_change:1.2}}]}})))
    .toMatchObject({state:"known",mode:"lazer-classic",mods:expect.arrayContaining([{acronym:"DT",settings:{speed_change:1.2}}])});
  expect(resolveLibraryPerformanceProfile(evidence({native:{...native,isLegacyScore:true}}))).toMatchObject({state:"known",mode:"stable"});
});
it("keeps embedded empty mods authoritative and contradictory fallback evidence unavailable",()=>{
  expect(resolveLibraryPerformanceProfile(evidence({native:{...native,mods:[{acronym:"DT"}]},trailer:{mods:[]}})))
    .toMatchObject({state:"known",mode:"lazer",mods:[]});
  expect(resolveLibraryPerformanceProfile(evidence({native,nativeConflict:true})).state).toBe("unknown");
  expect(resolveLibraryPerformanceProfile(evidence({native,nativeConflict:true,trailer:{mods:[]}})).state).toBe("known");
});
it("qualifies every native component and derives only the explicitly bounded tail miss",()=>{
  expect(qualifyLibraryAggregateScore(evidence({native}),map)).toMatchObject({state:"known",score:{mode:"lazer",componentsQualified:true,
    statistics:{great:2,ok:1,meh:0,miss:0,large_tick_hit:1,large_tick_miss:1,small_tick_hit:1,small_tick_miss:0,slider_tail_hit:1,slider_tail_miss:0}}});
  const changed={...native,statistics:{...native.statistics,SliderTailHit:0,IgnoreMiss:99}};
  expect(qualifyLibraryAggregateScore(evidence({native:changed}),map)).toMatchObject({state:"known",score:{statistics:{slider_tail_miss:1}}});
  const noHits={...native,statistics:{Great:3,Ok:0,Meh:0,Miss:0},maximumStatistics:null};
  expect(qualifyLibraryAggregateScore(evidence({native:noHits}),map).state).toBe("unknown");
  expect(qualifyLibraryAggregateScore(evidence({native:noHits}),{...map,maxCombo:3,largeTicks:0,smallTicks:0,sliderTails:0}))
    .toMatchObject({state:"unknown"}); // Explicit combo 8 cannot fit this map.
  expect(qualifyLibraryAggregateScore(evidence({native:{...noHits,maxCombo:3}}),{...map,maxCombo:3,largeTicks:0,smallTicks:0,sliderTails:0}))
    .toMatchObject({state:"known",score:{statistics:{large_tick_hit:0,large_tick_miss:0,small_tick_hit:0,small_tick_miss:0,slider_tail_hit:0,slider_tail_miss:0}}});
});
it.each([
  {Great:2,great:1}, {Miss:undefined}, {LargeTickMiss:undefined}, {SmallTickHit:1.5}, {SliderTailHit:2}, {slider_tail_miss:1},
])("rejects missing, contradictory and out-of-capacity native statistics: %j",changes=>{
  expect(qualifyLibraryAggregateScore(evidence({native:{...native,statistics:{...native.statistics,...changes}}}),map).state).toBe("unknown");
});
it("requires explicit native max combo and full aggregate coverage but never establishes completion",()=>{
  const trailer={mods:[],statistics:native.statistics,maximum_statistics:native.maximumStatistics};
  expect(qualifyLibraryAggregateScore(evidence({trailer}),map).state).toBe("unknown");
  const value=qualifyLibraryAggregateScore(evidence({trailer:{...trailer,max_combo:8}}),map);
  expect(value.state).toBe("known");expect(value).not.toHaveProperty("completion");expect(value).not.toHaveProperty("fc");
  expect(qualifyLibraryAggregateScore(evidence(),{...map,objectCount:4}).state).toBe("unknown");
  expect(qualifyLibraryAggregateScore(evidence({native:{...native,maximumStatistics:{SliderTailHit:2}}}),map).state).toBe("unknown");
});
it("does not fill malformed embedded statistics or conflicting fallback data from a DB record",()=>{
  expect(qualifyLibraryAggregateScore(evidence({native,trailer:{mods:[],statistics:null,max_combo:8}}),map).state).toBe("unknown");
  expect(qualifyLibraryAggregateScore(evidence({native,nativeConflict:true,trailer:{mods:[]}}),map).state).toBe("unknown");
});
it("never replaces required embedded settings with DB fallback when the trailer becomes unavailable",()=>{
  expect(resolveLibraryPerformanceProfile(evidence({native,embeddedRequired:true,trailerStatus:"unavailable"})).state).toBe("unknown");
  expect(resolveLibraryPerformanceProfile(evidence({native,trailerStatus:"invalid"})).state).toBe("unknown");
  expect(resolveLibraryPerformanceProfile(evidence({native,embeddedRequired:true,trailerStatus:"read",trailer:{mods:[]}})))
    .toMatchObject({state:"known",mode:"lazer",mods:[]});
});

it("qualifies the native replay trailer that omits its zero meh and small tick statistics",()=>{
  // Captured 894a9f18 trailer: LegacyReplaySoloScoreInfo.FromScore omits all zero entries.
  const statistics={miss:5,ok:53,great:298,large_tick_miss:9,large_tick_hit:90,ignore_miss:21,ignore_hit:246,slider_tail_hit:229};
  const maximum_statistics={great:356,large_tick_hit:99,ignore_hit:248,slider_tail_hit:248};
  const input=evidence({header:{...header,version:30000019,modsBitmask:0,counts:{great:298,ok:53,meh:0,miss:5},maxCombo:282,score:470688},
    native:{...native,maxCombo:282},nativeRequired:true,trailerStatus:"read",trailer:{mods:[],statistics,maximum_statistics}});
  const result=qualifyLibraryAggregateScore(input,{...map,objectCount:356,maxCombo:703,largeTicks:99,smallTicks:0,sliderTails:248});
  expect(result).toMatchObject({state:"known",profile:{mode:"lazer",mods:[]},score:{mode:"lazer",maxCombo:282,componentsQualified:true,
    statistics:{great:298,ok:53,meh:0,miss:5,large_tick_hit:90,large_tick_miss:9,small_tick_hit:0,small_tick_miss:0,slider_tail_hit:229,slider_tail_miss:19}}});
  expect(result).not.toHaveProperty("completion");expect(result).not.toHaveProperty("fc");
});

it.each(["Great","Ok","Meh","Miss"] as const)("reads omitted native basic %s as zero while retaining full map coverage",key=>{
  const statistics={...native.statistics,Great:3,Ok:0,Meh:0,Miss:0};
  if(key==="Great"){statistics.Great=0;statistics.Miss=3;}
  delete (statistics as Partial<typeof statistics>)[key];
  expect(qualifyLibraryAggregateScore(evidence({native:{...native,statistics}}),map)).toMatchObject({state:"known",
    score:{statistics:{great:key==="Great"?0:3,ok:0,meh:0,miss:key==="Great"?3:0}}});
});

it.each([
  {statistics:{Great:3,Ok:0,Meh:0,Miss:0,LargeTickHit:2,SmallTickHit:1,SliderTailHit:1},want:{large_tick_hit:2,large_tick_miss:0,small_tick_hit:1,small_tick_miss:0,slider_tail_hit:1,slider_tail_miss:0}},
  {statistics:{Great:3,Ok:0,Meh:0,Miss:0,LargeTickMiss:2,SmallTickMiss:1},want:{large_tick_hit:0,large_tick_miss:2,small_tick_hit:0,small_tick_miss:1,slider_tail_hit:0,slider_tail_miss:1}},
])("uses native sparse component zeros without losing the exact map denominators: %j",({statistics,want})=>{
  expect(qualifyLibraryAggregateScore(evidence({native:{...native,statistics}}),map)).toMatchObject({state:"known",score:{statistics:want}});
});

it.each([undefined,null,[],"",{},{great:2,miss:0,IgnoreHit:1},{great:3,large_tick_hit:1,SmallTickHit:1,SliderTailHit:1},
  {great:3,large_tick_hit:2,SmallTickHit:1,SliderTailHit:1,Meh:0,meh:1},
  {great:3,large_tick_hit:2,SmallTickHit:1,SliderTailHit:1,IgnoreHit:-1},
  {great:3,large_tick_hit:2,SmallTickHit:1,SliderTailHit:1,IgnoreHit:1.5},
  {great:3,large_tick_hit:2,SmallTickHit:1,SliderTailHit:1,IgnoreHit:2147483648},
  {great:3,large_tick_hit:2,SmallTickHit:1,SliderTailHit:1,meh:undefined},
])("never treats absent, malformed, conflicting or incomplete native dictionaries as full evidence: %j",statistics=>{
  expect(qualifyLibraryAggregateScore(evidence({native:{...native,statistics}}),map).state).toBe("unknown");
  expect(qualifyLibraryAggregateScore(evidence({native,trailer:{mods:[],statistics,max_combo:8}}),map).state).toBe("unknown");
});

it("keeps maximum statistics validation independent from sparse score statistics",()=>{
  const statistics={great:3,large_tick_hit:2,small_tick_hit:1,slider_tail_hit:1};
  for(const maximumStatistics of [{slider_tail_hit:2},{SliderTailHit:1,slider_tail_hit:0},{SliderTailHit:undefined},{ignore_hit:-1}])
    expect(qualifyLibraryAggregateScore(evidence({native:{...native,statistics,maximumStatistics}}),map).state).toBe("unknown");
});
