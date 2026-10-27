import { composePerformanceContext } from "./library-performance-context";
import { qualifyLibraryAggregateScore,resolveLibraryPerformanceProfile } from "./library-performance-score";
import type { LibraryPerformanceObservation } from "./library-performance-dependencies";
const sha="a".repeat(64),md5="b".repeat(32),requirements={nativeRequired:false,embeddedRequired:false};
const header={mode:0,version:20250101,beatmapMD5:md5,modsBitmask:0,counts:{great:3,ok:0,meh:0,miss:0},maxCombo:3,score:123};
const imported:LibraryPerformanceObservation={kind:"imported",sourceKey:sha,sha256:sha,metadata:{header}};
const native=(id:string,mods:unknown[]=[],great=3):LibraryPerformanceObservation=>({kind:"lazer",sourceKey:id,sha256:sha,metadata:{schemaFingerprint:"c".repeat(64),
  nativeScore:{id,isLegacyScore:false,ruleset:0,mods,maxCombo:3,statistics:{Great:great,Ok:0,Meh:0,Miss:3-great},
    replay:{sha256:sha},beatmap:{md5}}}});
const map={version:1 as const,objectCount:3,stars:1,maxCombo:3,largeTicks:0,smallTicks:0,sliderTails:0,clockRate:1,drainTimeMs:1000,endTimeMs:2000};
it("folds duplicates and source permutations into one canonical context without choosing an ordering winner",()=>{
  const a=native("a"),b=native("b"),first=composePerformanceContext([imported,a,b],()=>undefined,requirements);
  expect(composePerformanceContext([b,a,imported],()=>undefined,requirements)).toEqual(first);
  expect(first.mapMd5).toBe(md5);expect(first.evidence.nativeRequired).toBe(true);
  expect(resolveLibraryPerformanceProfile(first.evidence)).toMatchObject({state:"known",mode:"lazer",mods:[]});
});
it("keeps equal native profiles usable when aggregate statistics conflict",()=>{
  const context=composePerformanceContext([native("a"),native("b",[],2)],()=>undefined,requirements);
  expect(resolveLibraryPerformanceProfile(context.evidence).state).toBe("known");expect(qualifyLibraryAggregateScore(context.evidence,map).state).toBe("unknown");
  const embedded={...context.evidence,trailer:{mods:[],statistics:{Great:3,Ok:0,Meh:0,Miss:0},max_combo:3,ruleset_id:0}};
  expect(qualifyLibraryAggregateScore(embedded,map).state).toBe("known");
});
it("normalizes equivalent native statistic aliases and retains conflicting dual aliases",()=>{
  const a=native("a"),b=native("b"),score=b.metadata.nativeScore as Record<string,unknown>;
  score.statistics={great:3,ok:0,meh:0,miss:0};score.maximumStatistics={slider_tail_hit:0};
  (a.metadata.nativeScore as Record<string,unknown>).maximumStatistics={SliderTailHit:0};
  const context=composePerformanceContext([a,b],()=>undefined,requirements);
  expect(context.evidence.scoreConflict).toBe(false);expect(qualifyLibraryAggregateScore(context.evidence,map).state).toBe("known");
  score.statistics={great:3,Great:2,ok:0,meh:0,miss:0};
  expect(qualifyLibraryAggregateScore(composePerformanceContext([a,b],()=>undefined,requirements).evidence,map).state).toBe("unknown");
});
it("embedded empty mods resolve profile conflicts while incomplete embedded score never selects conflicting DB statistics",()=>{
  const context=composePerformanceContext([native("a"),native("b",[{acronym:"DT"}],2)],()=>undefined,requirements);
  expect(resolveLibraryPerformanceProfile(context.evidence).state).toBe("unknown");
  const embedded={...context.evidence,trailer:{mods:[]}};
  expect(resolveLibraryPerformanceProfile(embedded)).toMatchObject({state:"known",mode:"lazer",mods:[]});
  expect(qualifyLibraryAggregateScore(embedded,map).state).toBe("unknown");
});
it("retains intrinsic native and embedded requirements with an imported copy but leaves editable origin reversible",()=>{
  const context=composePerformanceContext([imported],()=>undefined,{nativeRequired:true,embeddedRequired:true});
  expect(context.evidence).toMatchObject({nativeRequired:true,embeddedRequired:true});expect(resolveLibraryPerformanceProfile(context.evidence).state).toBe("unknown");
  const confirmed=composePerformanceContext([imported],()=>({client:"lazer",provenance:"user-confirmed"}),requirements);
  expect(confirmed.evidence.nativeRequired).toBe(false);expect(confirmed.evidence.origin).toBe("lazer");
  expect(resolveLibraryPerformanceProfile(composePerformanceContext([imported],()=>undefined,requirements).evidence).state).toBe("known");
});
it("keeps source-only Stable scalar evidence and rejects conflicting map identity or oversized evidence sets",()=>{
  const key="e".repeat(64),stable:LibraryPerformanceObservation={kind:"stable",sourceKey:key,sha256:null,metadata:{savedScore:{sourceKey:key,databaseVersion:20250101,header}}};
  const context=composePerformanceContext([stable],()=>undefined,requirements);expect(context.mapMd5).toBe(md5);
  expect(qualifyLibraryAggregateScore(context.evidence,map).state).toBe("known");
  expect(composePerformanceContext([stable,{...imported,metadata:{header:{...header,beatmapMD5:"f".repeat(32)}}}],()=>undefined,requirements).mapMd5).toBeNull();
  expect(()=>composePerformanceContext(Array(257).fill(stable),()=>undefined,requirements)).toThrow(/budget/i);
});
