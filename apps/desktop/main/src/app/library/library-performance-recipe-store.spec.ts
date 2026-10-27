import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { LIBRARY_P_PRODUCER_VERSION } from "./library-performance-versions";
import { libraryCapabilityAttempt } from "./library-metric-store";
import { DatabaseSync } from "node:sqlite";
import { LibraryPerformanceRecipeStore } from "./library-performance-recipe-store";
import { LibraryMetricStore } from "./library-metric-store";
import type { LibraryPerformanceDependencies } from "./library-performance-dependencies";
import type { LibraryPreparedResult } from "./library-preparation-store";
import { metricInputKey } from "./library-source-metrics";
const hash=(n:number)=>n.toString(16).padStart(64,"0"),mapSha256=hash(4);
const original:LibraryPerformanceDependencies={version:1,mapKey:hash(1),profileKey:hash(2),scoreKey:hash(3),nativeRequired:false};
const raw:LibraryPreparedResult[]=[{slot:"calculated-map",stage:"P",producerVersion:"p-v1",inputKey:hash(10),
  fields:{mapStars:{state:"known",value:2},replayStars:{state:"known",value:3}},provenance:{mapSha256}},
  {slot:"aggregate-pp",stage:"P",producerVersion:"p-v1",inputKey:hash(11),fields:{pp:{state:"known",value:0}},provenance:{mapSha256,ruleset:"stable"}},
  {slot:"fc-pp",stage:"P",producerVersion:"p-v1",inputKey:hash(12),fields:{ppIfFc:{state:"known",value:100}},provenance:{mapSha256,ruleset:"stable"}}];
let db:DatabaseSync,metrics:LibraryMetricStore,recipes:LibraryPerformanceRecipeStore,current:LibraryPerformanceDependencies;
beforeEach(()=>{
  db=new DatabaseSync(":memory:");db.exec("CREATE TABLE replays(id TEXT PRIMARY KEY,merged_into TEXT); INSERT INTO replays VALUES('r',NULL); CREATE TABLE counters(key TEXT PRIMARY KEY,value INTEGER); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE contents(replay_id TEXT,sha256 TEXT)");
  // Observed-result publication checks recorded mode across summary and duplicate locations.
  db.exec("ALTER TABLE replays ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'; CREATE TABLE locations(replay_id TEXT,metadata TEXT NOT NULL)");
  LibraryMetricStore.migrate(db);db.exec("ALTER TABLE metric_results ADD COLUMN strip_payload TEXT");
  LibraryPerformanceRecipeStore.migrate(db);current={...original};
  metrics=new LibraryMetricStore(db,id=>id,work=>work());recipes=new LibraryPerformanceRecipeStore(db,metrics,()=>current);
});
afterEach(()=>db.close());
const read=(slot:string)=>metrics.read("r").find(entry=>entry.target.slot===slot)?.result?.fields;
function completion(value:"passed"|"failed",qualified=true){
  const target=metrics.setTarget({replayId:"r",slot:"numerical",stage:"S",inputKey:hash(value==="passed"?20:21),producerVersion:"s-v1"});
  metrics.publishObserved(target,{fields:{completion:{state:"known",value}},provenance:{mapSha256,ruleset:"stable",coverageQualified:qualified,completionEvidence:"source-domain-coverage-v1"}});
  recipes.reconcileInTransaction("r");
}
it("publishes independently qualified aggregate and If FC PP without asserting completion",()=>{
  recipes.bindInTransaction("r",original,raw,false);
  expect(read("aggregate-pp")?.pp).toEqual({state:"known",value:0});expect(read("fc-pp")?.ppIfFc).toEqual({state:"known",value:100});
  completion("passed",false);expect(read("aggregate-pp")?.pp).toEqual({state:"known",value:0});
  completion("passed");expect(read("aggregate-pp")?.pp).toEqual({state:"known",value:0});expect(read("fc-pp")?.ppIfFc).toEqual({state:"known",value:100});
  completion("failed");expect(read("aggregate-pp")?.pp.state).toBe("not-applicable");expect(read("fc-pp")?.ppIfFc).toEqual({state:"not-applicable",reason:"failed-play"});
  completion("passed");expect(read("aggregate-pp")?.pp).toEqual({state:"known",value:0});
});
it("preserves positive source-aggregate PP and its provenance without inferring completion or FC",()=>{
  const aggregate={...raw[1],fields:{pp:{state:"known" as const,value:183.13770131800254}},provenance:{...raw[1].provenance,sourceOnly:true}};
  recipes.bindInTransaction("r",original,[raw[0],aggregate,raw[2]],false);
  const published=metrics.read("r").find(entry=>entry.target.slot==="aggregate-pp")?.result;
  expect(published).toEqual({fields:aggregate.fields,provenance:aggregate.provenance});
  expect(metrics.read("r").find(entry=>entry.target.slot==="numerical")).toBeUndefined();
  expect(read("fc-pp")?.ppIfFc).toEqual(raw[2].fields.ppIfFc);
  expect(db.prepare("SELECT count(*) n FROM metric_jobs").get()?.n).toBe(0);
});
it.each([0,454.52234070017204])("retains If FC=%s and exact independent-fc identity across repeated reconciliation",value=>{
  const fc={...raw[2],fields:{ppIfFc:{state:"known" as const,value}},provenance:{...raw[2].provenance,sourceOnly:true}};
  recipes.bindInTransaction("r",original,[raw[0],fc],false);
  const entry=metrics.read("r").find(item=>item.target.slot==="fc-pp");
  expect(entry?.result).toEqual({fields:fc.fields,provenance:fc.provenance});
  expect(entry?.target.inputKey).toBe(metricInputKey({version:"library-p-visibility-v1",raw:fc.inputKey,visibility:"independent-fc"}));
  expect(metrics.read("r").find(item=>item.target.slot==="numerical")).toBeUndefined();
  recipes.reconcileInTransaction("r");expect(metrics.read("r").find(item=>item.target.slot==="fc-pp")).toEqual(entry);
  expect(JSON.parse(String(db.prepare("SELECT payload FROM performance_recipes WHERE replay_id='r'").get()?.payload)).results[1]).toEqual(fc);
  expect(db.prepare("SELECT count(*) n FROM metric_jobs").get()?.n).toBe(0);
});
it("keeps unqualified raw If FC unknown and rejects invalid stored mathematics",()=>{
  recipes.bindInTransaction("r",original,[{...raw[2],fields:{ppIfFc:{state:"unknown",reason:"aggregate-object-coverage-incomplete"}}}],false);
  expect(read("fc-pp")?.ppIfFc).toEqual({state:"unknown",reason:"aggregate-object-coverage-incomplete"});
  expect(()=>recipes.bindInTransaction("r",original,[{...raw[2],fields:{ppIfFc:{state:"known",value:Infinity}}}],false)).toThrow();
});
it("does not turn partial-header or otherwise unqualified raw arithmetic into known PP",()=>{
  recipes.bindInTransaction("r",original,[{...raw[1],fields:{pp:{state:"unknown",reason:"score-coverage-unavailable"}}}],false);
  expect(read("aggregate-pp")?.pp).toEqual({state:"unknown",reason:"score-coverage-unavailable"});
});
it("invalidates only consuming projections and restores matching cached math without scheduling",()=>{
  recipes.bindInTransaction("r",original,raw,false);
  current={...original,scoreKey:hash(30)};recipes.reconcileInTransaction("r");
  expect(read("calculated-map")).toEqual(raw[0].fields);expect(read("aggregate-pp")?.pp.state).toBe("unknown");
  expect(read("fc-pp")?.ppIfFc).toEqual({state:"unknown",reason:"score-unavailable"});
  current={...original,profileKey:hash(31)};recipes.reconcileInTransaction("r");
  expect(read("calculated-map")?.mapStars).toEqual({state:"known",value:2});expect(read("calculated-map")?.replayStars.state).toBe("unknown");
  expect(read("fc-pp")?.ppIfFc).toEqual({state:"unknown",reason:"profile-unavailable"});
  current={...original,mapKey:hash(32)};recipes.reconcileInTransaction("r");expect(read("calculated-map")).toBeUndefined();
  current={...original};recipes.reconcileInTransaction("r");expect(read("calculated-map")).toEqual(raw[0].fields);expect(read("aggregate-pp")?.pp).toEqual({state:"known",value:0});
  expect(read("fc-pp")?.ppIfFc).toEqual(raw[2].fields.ppIfFc);
  expect(db.prepare("SELECT COUNT(*) AS count FROM metric_jobs").get()?.count).toBe(0);
});
it("preserves S-owned timeline PP and Peak through P reconciliation",()=>{
  recipes.bindInTransaction("r",original,raw,false);
  const target=metrics.setTarget({replayId:"r",slot:"timeline-pp",stage:"S",producerVersion:"s-v1",inputKey:hash(93)});
  recipes.reconcileInTransaction("r");expect(metrics.read("r").find(entry=>entry.target.slot==="timeline-pp")?.target).toEqual(target);
  metrics.publishObserved(target,{fields:{pp:{state:"known",value:91},peakPp:{state:"known",value:92}},provenance:{mapSha256}});
  current={...original,mapKey:hash(94)};recipes.reconcileInTransaction("r");
  expect(read("timeline-pp")).toEqual({pp:{state:"known",value:91},peakPp:{state:"known",value:92}});
});
it("keeps native and embedded requirements durable through lost evidence and provisional merge",()=>{
  recipes.bindInTransaction("r",{...original,nativeRequired:true},raw,true);
  expect(recipes.requirements("r")).toEqual({nativeRequired:true,embeddedRequired:true});
  current={...original};recipes.reconcileInTransaction("r");expect(recipes.requirements("r").nativeRequired).toBe(true);
  db.exec("INSERT INTO replays(id,merged_into) VALUES('into',NULL)");recipes.mergeProvisionalInTransaction("r","into");
  expect(recipes.requirements("into")).toEqual({nativeRequired:true,embeddedRequired:true});
});
it("validates hidden raw PP before completion masking can conceal an invalid value",()=>{
  expect(()=>recipes.bindInTransaction("r",original,[{...raw[1],fields:{pp:{state:"known",value:NaN}}}],false)).toThrow();
  expect(db.prepare("SELECT COUNT(*) AS count FROM performance_recipes").get()?.count).toBe(0);
});
it("retains provisional raw mathematics for reconciliation after identity merge",()=>{
  recipes.bindInTransaction("r",original,raw,false);db.exec("INSERT INTO replays(id,merged_into) VALUES('into',NULL)");
  recipes.mergeProvisionalInTransaction("r","into");recipes.reconcileInTransaction("into");
  expect(metrics.read("into").find(entry=>entry.target.slot==="calculated-map")?.result?.fields).toEqual(raw[0].fields);
  current={...original,mapKey:hash(99)};recipes.reconcileInTransaction("into");expect(metrics.read("into")).toEqual([]);
});
it.each([false,true])("preserves an S-owned FC estimate or job when the P recipe has FC=%s",hasFc=>{
  recipes.bindInTransaction("r",original,hasFc?raw:raw.slice(0,2),false);
  const target=metrics.setTarget({replayId:"r",slot:"fc-pp",stage:"S",producerVersion:"s-fc-v1",inputKey:hash(90)});
  recipes.reconcileInTransaction("r");expect(metrics.read("r").find(entry=>entry.target.slot==="fc-pp")?.target).toEqual(target);
  metrics.publishObserved(target,{fields:{ppIfFc:{state:"known",value:90}},provenance:{mapSha256}});
  completion("passed");expect(read("fc-pp")?.ppIfFc).toEqual({state:"known",value:90});
  current={...original,mapKey:hash(91)};recipes.reconcileInTransaction("r");expect(read("fc-pp")?.ppIfFc).toEqual({state:"known",value:90});
});
function sparseRawNative(){
  current={...original,nativeRequired:true};
  const provenance={mapSha256,mapMd5:"a".repeat(32),replaySha256:hash(6),engineVersion:PERFORMANCE_ENGINE_VERSION};
  const values:LibraryPreparedResult[]=[{...raw[0],producerVersion:LIBRARY_P_PRODUCER_VERSION,provenance},
    ...([['aggregate-pp','pp'],['fc-pp','ppIfFc']] as const).map(([slot,field])=>({slot,stage:"P" as const,producerVersion:LIBRARY_P_PRODUCER_VERSION,
      inputKey:metricInputKey({version:LIBRARY_P_PRODUCER_VERSION,map:mapSha256,slot,reason:"aggregate-object-coverage-incomplete"}),
      fields:{[field]:{state:"unknown" as const,reason:"aggregate-object-coverage-incomplete"}},provenance:{...provenance,ruleset:"lazer"}}))];
  recipes.bindInTransaction("r",current,values,true);return values;
}
it("certifies exact native sparse raw and visibility tuples without changing any data",()=>{
  sparseRawNative();const before=db.prepare("SELECT total_changes() n").get();
  expect(recipes.canRetryNativeSparseScoreInTransaction("r")).toBe(true);
  expect(db.prepare("SELECT total_changes() n").get()).toEqual(before);
});
it.each(["native","map-dependency","profile-dependency","score-dependency","raw-key","raw-version","raw-domain","marker","raw-map","known","error","not-applicable","visibility-key","S-owner","failed-completion","corrupt"])(
  "rejects native sparse recovery certificate mismatch %s without writes",fault=>{
    sparseRawNative();
    if(fault==="native")current={...current,nativeRequired:false};
    else if(fault.endsWith("-dependency"))current={...current,[fault.replace("-dependency","")+"Key"]:hash(99)};
    else if(fault==="visibility-key"){
      const prior=metrics.read("r").find(e=>e.target.slot==="aggregate-pp");if(!prior)throw Error("Missing native aggregate fixture");
      metrics.setTarget({...prior.target,inputKey:"other"});
    }
    else if(fault==="S-owner")metrics.setTarget({replayId:"r",slot:"fc-pp",stage:"S",producerVersion:"s-fc",inputKey:"other"});
    else if(fault==="failed-completion"){
      const t=metrics.setTarget({replayId:"r",slot:"numerical",stage:"S",producerVersion:"s",inputKey:"failed"});
      metrics.publishObserved(t,{fields:{completion:{state:"known",value:"failed"}},provenance:{mapSha256,replaySha256:hash(6),ruleset:"lazer",coverageQualified:true,completionEvidence:"source-domain-coverage-v1"}});
      recipes.reconcileInTransaction("r");
    }else if(fault==="corrupt")db.prepare("UPDATE performance_recipes SET payload='invalid' WHERE replay_id='r'").run();
    else{
      const saved=JSON.parse(String(db.prepare("SELECT payload FROM performance_recipes WHERE replay_id='r'").get()?.payload)),item=saved.results[1];
      if(fault==="raw-key")item.inputKey=hash(98);
      if(fault==="raw-version")item.producerVersion="old";
      if(fault==="raw-domain")item.provenance.ruleset="stable";
      if(fault==="raw-map")item.provenance.mapSha256=hash(99);
      if(fault==="marker")item.provenance.capabilityAttempt="native-sparse-score-v1";
      if(["known","error","not-applicable"].includes(fault))item.fields.pp=fault==="known"?{state:"known",value:10}:{state:fault,reason:"protected"};
      db.prepare("UPDATE performance_recipes SET payload=? WHERE replay_id='r'").run(JSON.stringify(saved));
    }
    const before=db.prepare("SELECT total_changes() n").get();expect(recipes.canRetryNativeSparseScoreInTransaction("r")).toBe(false);
    expect(db.prepare("SELECT total_changes() n").get()).toEqual(before);
  });
it("rejects known map overwrite before any recipe/target mutation and preserves S fallback ownership",()=>{
  const values=sparseRawNative(),before=db.prepare("SELECT payload FROM performance_recipes").all(),targets=metrics.read("r");
  expect(()=>recipes.bindInTransaction("r",current,values.map(r=>r.slot==="calculated-map"?{...r,fields:{...r.fields,mapStars:{state:"known",value:99}}}:r),true))
    .toThrow("Native score recovery changed known map mathematics");
  expect(db.prepare("SELECT payload FROM performance_recipes").all()).toEqual(before);expect(metrics.read("r")).toEqual(targets);
  const fallback=metrics.setTarget({replayId:"r",slot:"fc-pp",stage:"S",producerVersion:"s-fc",inputKey:"S-owned"});
  metrics.publishObserved(fallback,{fields:{ppIfFc:{state:"known",value:7}},provenance:{}});
  const held=metrics.read("r").find(e=>e.target.slot==="fc-pp");
  recipes.bindInTransaction("r",current,values.map(r=>r.slot==="aggregate-pp"?{...r,inputKey:hash(60),fields:{pp:{state:"known",value:30}}}:r.slot==="fc-pp"?{...r,inputKey:hash(61),fields:{ppIfFc:{state:"known",value:40}}}:r),true);
  expect(metrics.read("r").find(e=>e.target.slot==="fc-pp")).toEqual(held);
  expect(metrics.read("r").find(e=>e.target.slot==="calculated-map")).toEqual(targets.find(e=>e.target.slot==="calculated-map"));
});
it("does not stamp restored raw unknown and does not repeat an actually marked unknown",()=>{
  const values=sparseRawNative();recipes.reconcileInTransaction("r");
  expect(recipes.canRetryNativeSparseScoreInTransaction("r")).toBe(true);
  recipes.bindInTransaction("r",current,values.map(r=>({...r,...libraryCapabilityAttempt(r,r)})),true);
  recipes.reconcileInTransaction("r");expect(recipes.canRetryNativeSparseScoreInTransaction("r")).toBe(false);
});
it.each(["profile","score","failed"])("retains the raw native attempt without mislabelling derived %s visibility",visibility=>{
  const values=sparseRawNative();recipes.bindInTransaction("r",current,values.map(r=>({...r,...libraryCapabilityAttempt(r,r)})),true);
  const dependencies={...current};
  if(visibility==="failed"){
    const t=metrics.setTarget({replayId:"r",slot:"numerical",stage:"S",producerVersion:"s",inputKey:"failed"});
    metrics.publishObserved(t,{fields:{completion:{state:"known",value:"failed"}},provenance:{mapSha256,replaySha256:hash(6),ruleset:"lazer",coverageQualified:true,completionEvidence:"source-domain-coverage-v1"}});
  }else current={...current,[visibility+"Key"]:hash(95)};
  expect(()=>recipes.reconcileInTransaction("r")).not.toThrow();
  const aggregate=metrics.read("r").find(e=>e.target.slot==="aggregate-pp")?.result;
  expect(aggregate?.fields.pp).toEqual({state:visibility==="failed"?"not-applicable":"unknown",reason:visibility==="failed"?"failed-play":visibility+"-unavailable"});
  expect(aggregate?.provenance.capabilityAttempt).toBeUndefined();
  const saved=JSON.parse(String(db.prepare("SELECT payload FROM performance_recipes WHERE replay_id='r'").get()?.payload));
  expect(saved.results[1].provenance.capabilityAttempt).toBe("native-sparse-score-v1");
  if(visibility!=="failed"){current=dependencies;recipes.reconcileInTransaction("r");expect(recipes.canRetryNativeSparseScoreInTransaction("r")).toBe(false);}
});
