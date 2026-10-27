import { performanceDependencyKeys,nativePerformanceScoreKey,PERFORMANCE_DEPENDENCY_VERSIONS } from "./library-performance-dependencies";
const sha="a".repeat(64),md5="b".repeat(32);
const header={mode:0,version:20250101,beatmapMD5:md5,modsBitmask:0,counts:{great:3,ok:0,meh:0,miss:0},maxCombo:3,score:200};
const location={kind:"replays" as const,sha256:sha,sourceKey:"one",metadata:{header}};
it("invalidates the consuming dependency families on engine or projection changes without source changes",()=>{
  const key=(version:Partial<typeof PERFORMANCE_DEPENDENCY_VERSIONS>)=>performanceDependencyKeys([location],()=>undefined,false,{...PERFORMANCE_DEPENDENCY_VERSIONS,...version});
  const original=key({});
  for(const name of ["engine","map","producer"] as const)expect(key({[name]:"future"}).mapKey).not.toBe(original.mapKey);
  for(const name of ["aggregate","fc"] as const){const changed=key({[name]:"future"});expect(changed.scoreKey).not.toBe(original.scoreKey);expect(changed.mapKey).toBe(original.mapKey);}
});
it("canonicalizes recognized aliases while preserving missing, invalid and conflicting evidence",()=>{
  const key=(statistics:unknown,maximumStatistics:unknown=null)=>nativePerformanceScoreKey({maxCombo:3,statistics,maximumStatistics});
  expect(key({Great:3,Miss:0},{SliderTailHit:2})).toBe(key({great:3,miss:0},{slider_tail_hit:2}));
  expect(key({Great:3,great:3})).toBe(key({great:3}));
  expect(key({Great:3,great:2})).not.toBe(key({great:3}));
  expect(key({Miss:0})).not.toBe(key({}));expect(key({Great:-1})).not.toBe(key({}));
});
it("ignores duplicate paths, scan details and unconsumed source fields while separating stats from mods",()=>{
  const initial=performanceDependencyKeys([location],()=>undefined,false);
  expect(performanceDependencyKeys([location,{...location,sourceKey:"other",metadata:{header:{...header,player:"Other",rank:"S"},savedScore:{causes:"not consumed"}}}],()=>undefined,false)).toEqual(initial);
  const stats=performanceDependencyKeys([{...location,metadata:{header:{...header,score:201}}}],()=>undefined,false);
  expect(stats.mapKey).toBe(initial.mapKey);expect(stats.profileKey).toBe(initial.profileKey);expect(stats.scoreKey).not.toBe(initial.scoreKey);
  const mods=performanceDependencyKeys([{...location,metadata:{header:{...header,modsBitmask:64}}}],()=>undefined,false);
  expect(mods.profileKey).not.toBe(initial.profileKey);expect(mods.mapKey).toBe(initial.mapKey);
});
it("binds source-only Stable fields without depending on source record ID or replay availability",()=>{
  const source=(key:string)=>({kind:"stable" as const,sha256:null,sourceKey:key,metadata:{savedScore:{sourceKey:key,databaseVersion:20250101,header}}});
  expect(performanceDependencyKeys([source("c".repeat(64))],()=>undefined,false)).toEqual(performanceDependencyKeys([source("d".repeat(64))],()=>undefined,false));
});
it("retains native provenance and rejects silent downgrade when fallback evidence disappears",()=>{
  const native={kind:"lazer" as const,sourceKey:"native",sha256:sha,metadata:{schemaFingerprint:"c".repeat(64),nativeScore:{id:"native",ruleset:0,
    isLegacyScore:false,mods:[],maxCombo:3,statistics:{Great:3,Ok:0,Meh:0,Miss:0},maximumStatistics:null,replay:{sha256:sha},beatmap:{md5,sha256:"d".repeat(64)}}}};
  const first=performanceDependencyKeys([location,native],()=>undefined,false);expect(first.nativeRequired).toBe(true);
  const missing=performanceDependencyKeys([location],()=>undefined,true);expect(missing.nativeRequired).toBe(true);expect(missing.profileKey).not.toBe(first.profileKey);
  expect(missing.profileKey).not.toBe(performanceDependencyKeys([location],()=>undefined,false).profileKey);
  const unrelated={...native,sha256:"f".repeat(64)};
  expect(performanceDependencyKeys([unrelated],()=>undefined,false).nativeRequired).toBe(false);
});
it("tracks confirmed origins and preserves missing versus explicit zero native statistics",()=>{
  expect(performanceDependencyKeys([location],()=>({client:"lazer",provenance:"user-confirmed"}),false).profileKey)
    .not.toBe(performanceDependencyKeys([location],()=>undefined,false).profileKey);
  const source=(statistics:unknown)=>({kind:"lazer" as const,sourceKey:"n",sha256:sha,metadata:{schemaFingerprint:"c".repeat(64),nativeScore:{id:"n",ruleset:0,
    isLegacyScore:false,mods:[],maxCombo:3,statistics,maximumStatistics:null,replay:{sha256:sha},beatmap:{md5}}}});
  expect(performanceDependencyKeys([source({Miss:0})],()=>undefined,false).scoreKey).not.toBe(performanceDependencyKeys([source({})],()=>undefined,false).scoreKey);
  expect(performanceDependencyKeys([source({Miss:0,IgnoreMiss:5})],()=>undefined,false).scoreKey).toBe(performanceDependencyKeys([source({Miss:0})],()=>undefined,false).scoreKey);
});
it("excludes unused ScoreV1 totals for V2 and normalizes native mod ordering",()=>{
  const v2=(score:number)=>({...location,metadata:{header:{...header,modsBitmask:1<<29,score}}});
  expect(performanceDependencyKeys([v2(1)],()=>undefined,false).scoreKey).toBe(performanceDependencyKeys([v2(2)],()=>undefined,false).scoreKey);
  const source=(mods:unknown[])=>({kind:"lazer" as const,sourceKey:"n",sha256:sha,metadata:{schemaFingerprint:"c".repeat(64),nativeScore:{id:"n",ruleset:0,
    isLegacyScore:false,mods,replay:{sha256:sha},beatmap:{md5}}}});
  expect(performanceDependencyKeys([source([{acronym:"DT"},{acronym:"HD"}])],()=>undefined,false).profileKey)
    .toBe(performanceDependencyKeys([source([{acronym:"HD"},{acronym:"DT"}])],()=>undefined,false).profileKey);
});
it.each(["statistics","maximumStatistics"])("tracks %s validity without consuming ordinary unused values",field=>{
  const source=(value:unknown)=>({kind:"lazer" as const,sourceKey:"n",sha256:sha,metadata:{schemaFingerprint:"c".repeat(64),nativeScore:{id:"n",ruleset:0,
    isLegacyScore:false,mods:[],[field]:value,replay:{sha256:sha},beatmap:{md5}}}});
  const key=(value:unknown)=>performanceDependencyKeys([source(value)],()=>undefined,false).scoreKey;
  expect(key({IgnoreMiss:2147483648})).not.toBe(key({IgnoreMiss:0}));
  expect(key(Object.fromEntries(Array.from({length:65},(_,i)=>["unused"+i,0])))).not.toBe(key({}));
  expect(key({IgnoreMiss:1})).toBe(key({IgnoreMiss:2}));
});
