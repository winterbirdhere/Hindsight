import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { LibraryStore } from "./library-store";
import { nativeModEvidence, numericalModsHash, numericalProfileKey, LibraryNumericalInputRecipe } from "./library-numerical-profile";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import type { LibraryMetricTicket } from "../../../../shared/replay-library-metrics";

let directory:string,database:string,store:LibraryStore,replay:string,origin:"stable"|"lazer"|undefined;
const sha="a".repeat(64),dt=(speed:number)=>[{acronym:"DT",settings:{speed_change:speed}}];
const recipe:LibraryNumericalInputRecipe={version:1,replaySha256:sha,fixedKey:"b".repeat(64),intrinsicNative:false,
  embeddedModsHash:null,legacyModsHash:"c".repeat(64),modeQualified:true,consumedModsSource:"native-database"};
const lookup=()=>origin?{client:origin,provenance:"user-confirmed" as const}:undefined;
beforeEach(()=>{
  origin=undefined;directory=mkdtempSync(join(tmpdir(),"hindsight-recipe-"));database=join(directory,"library.sqlite");store=new LibraryStore(database,"one",lookup);
  store.registerSource({id:"native",kind:"lazer",directory:"C:\\fixture"});replay=observe("one",dt(1.2));
});
afterEach(()=>{store.close();for(const suffix of ["","-wal","-shm"])if(existsSync(database+suffix))unlinkSync(database+suffix);rmdirSync(directory);});
function metadata(mods:unknown){return{nativeScore:{isLegacyScore:false,replay:{sha256:sha},mods}};}
function observe(key:string,mods:unknown,available=true){return store.upsertObservation({sourceId:"native",sourceKey:key,locator:key,sha256:sha,
  available,generation:store.beginScan("native"),addedAt:1,metadata:metadata(mods)});}
function numerical(){return store.metrics.read(replay).find(entry=>entry.target.slot==="numerical");}
function removePostSchema15Objects(db:DatabaseSync){
  // Drop dependent triggers before their referenced C/query tables and columns.
  for(const type of ["trigger","index","table"]){
    const objects=db.prepare("SELECT name FROM sqlite_master WHERE type=? AND (name GLOB 'query_*' OR name GLOB 'map_cleanup_*')").all(type);
    for(const object of objects)db.exec(`DROP ${type.toUpperCase()} "${String(object.name).replace(/"/g,'""')}"`);
  }
  db.exec("DROP TABLE IF EXISTS resource_changes; DROP TABLE incident_source_epochs; DROP TABLE incident_location_epochs; DROP TABLE incident_recipes; ALTER TABLE metric_results DROP COLUMN strip_payload;");
}
function bind(value=recipe,mods:unknown=dt(1.2),native=true){
  const profile=numericalProfileKey(value,{origin:origin??null,native:nativeModEvidence(native?[mods]:[])});if(profile.state!=="known")throw new Error(profile.reason);
  store.preparations.request(replay,"S","selection");const ticket=store.preparations.claim(replay,"S");if(!ticket)throw new Error("Missing preparation");
  const location=store.openLocationCandidates(replay).items[0];
  const result=store.commitPreparedAnalysis(ticket,location,{sha256:sha,available:true,metadata:native?metadata(mods):{}},
    [{slot:"numerical",stage:"S",inputKey:profile.inputKey,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION}],
    origin?{client:origin,provenance:"user-confirmed"}:null,undefined,value);
  expect(result.state).toBe("applied");const job=store.metrics.nextQueued()[0];const metric=store.metrics.claim(job.id);if(!metric)throw new Error("Missing metric");return metric;
}
function commit(ticket:LibraryMetricTicket){return store.metrics.commit({ticket,producerVersion:ticket.producerVersion,
  fields:{fc:{state:"known",value:true}},provenance:{replaySha256:sha}});}
it("invalidates S FC with its recording profile and restores the compatible cache while Off",()=>{
  const first=bind(),timeline=store.metrics.commitAndClaimTimeline({ticket:first,producerVersion:first.producerVersion,
    fields:{completion:{state:"known",value:"passed"}},provenance:{replaySha256:sha,coverageQualified:true}});
  if(timeline.state!=="claimed")throw Error("missing timeline");
  const fc=store.metrics.finishTimelineAndClaimFc(timeline.ticket,{metrics:{fields:{peakPp:{state:"known",value:70}},provenance:{replaySha256:sha}}});
  if(fc.state!=="claimed")throw Error("missing FC");
  store.metrics.commit({ticket:fc.ticket,producerVersion:fc.ticket.producerVersion,fields:{ppIfFc:{state:"known",value:90}},provenance:{replaySha256:sha}});
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});observe("one",dt(1.5));
  const changed=store.metrics.read(replay).find(entry=>entry.target.slot==="fc-pp");
  expect(changed?.target.inputKey).not.toBe(fc.ticket.inputKey);expect(changed?.result).toBeUndefined();
  observe("one",dt(1.2));const restored=store.metrics.read(replay).find(entry=>entry.target.slot==="fc-pp");
  expect(restored?.target.inputKey).toBe(fc.ticket.inputKey);expect(restored?.result?.fields.ppIfFc).toEqual({state:"known",value:90});
  expect(store.metrics.nextQueued()).toEqual([]);
});
it.each(["bg","off"] as const)("reprepares an obsolete numerical producer through normal admission only in %s",mode=>{
  const first=bind();commit(first);store.enableNumericalAdmission();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode});
  const db=new DatabaseSync(database);db.prepare("UPDATE numerical_recipes SET producer_version='obsolete-v0' WHERE replay_id=?").run(replay);db.close();
  observe("one",dt(1.2));expect(numerical()).toBeUndefined();
  expect(store.preparations.nextQueued().filter(job=>job.stage==="S")).toHaveLength(mode==="bg"?1:0);
  const retained=new DatabaseSync(database);try{expect(Number(retained.prepare("SELECT count(*) AS n FROM metric_results WHERE replay_id=?").get(replay)?.n)).toBeGreaterThan(0);}finally{retained.close();}
});
it("invalidates only dependent timeline identity with recording profile changes and retains compatible cache",()=>{
  const first=bind();const next=store.metrics.commitAndClaimTimeline({ticket:first,producerVersion:first.producerVersion,
    fields:{fc:{state:"known",value:true}},provenance:{replaySha256:sha}});
  if(next.state!=="claimed")throw Error("missing timeline");
  expect(store.metrics.commit({ticket:next.ticket,producerVersion:next.ticket.producerVersion,
    fields:{peakPp:{state:"known",value:70}},provenance:{replaySha256:sha}})).toBe("applied");
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});observe("one",dt(1.5));
  const changed=store.metrics.read(replay).find(e=>e.target.slot==="timeline-pp");
  expect(changed?.target.inputKey).not.toBe(next.ticket.inputKey);expect(changed?.result).toBeUndefined();
  observe("one",dt(1.2));expect(store.metrics.read(replay).find(e=>e.target.slot==="timeline-pp")?.result?.fields.peakPp).toEqual({state:"known",value:70});
  observe("two",dt(1.5));expect(store.metrics.read(replay).find(e=>e.target.slot==="timeline-pp")).toBeUndefined();
});
it("fences profile changes while Off, retains historical cache, and reuses A with a new generation",()=>{
  const first=bind();expect(commit(first)).toBe("applied");store.setReview(replay,"reviewed");
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});observe("one",dt(1.5));
  expect(numerical()?.target.inputKey).not.toBe(first.inputKey);expect(numerical()?.result).toBeUndefined();expect(store.metrics.nextQueued()).toEqual([]);
  observe("one",dt(1.2));expect(numerical()?.target.inputKey).toBe(first.inputKey);expect(numerical()?.target.generation).toBeGreaterThan(first.generation);
  expect(numerical()?.result?.fields.fc).toEqual({state:"known",value:true});expect(commit(first)).toBe("stale");
  store.close();store=new LibraryStore(database,"two",lookup);expect(numerical()?.result?.fields.fc).toEqual({state:"known",value:true});expect(store.getReplay(replay)?.review).toBe("reviewed");
});
it("coalesces duplicate paths, availability and saved evidence without retiring work",()=>{
  const first=bind();observe("two",dt(1.2),false);observe("one",dt(1.2));
  const scan=store.beginScan("native");store.upsertObservation({sourceId:"native",sourceKey:"one",locator:"renamed",sha256:sha,available:false,
    generation:scan,addedAt:1,metadata:{...metadata(dt(1.2)),savedScore:{maximumCombo:999},cause:"irrelevant"}});
  expect(numerical()?.target.generation).toBe(first.generation);expect(commit(first)).toBe("applied");
});
it("retires conflicting fallback evidence and restores the cache when repaired",()=>{
  const first=bind();commit(first);observe("two",dt(1.5));expect(numerical()).toBeUndefined();
  observe("two",dt(1.2));expect(numerical()?.result?.fields.fc).toEqual({state:"known",value:true});
  observe("one",null);expect(numerical()).toBeUndefined();observe("one",dt(1.2));expect(numerical()?.target.inputKey).toBe(first.inputKey);
});
it("ignores irrelevant fallback conflicts when embedded NM controls the profile",()=>{
  const first=bind({...recipe,intrinsicNative:true,embeddedModsHash:numericalModsHash([])!,consumedModsSource:"embedded"});
  observe("two",dt(1.5));origin="lazer";store.reprojectSourceMetrics();expect(numerical()?.target.generation).toBe(first.generation);expect(commit(first)).toBe("applied");
});
it("rolls back target and source changes together on reconciliation failure",()=>{
  const first=bind(),fault=new DatabaseSync(database);
  try{fault.exec("CREATE TRIGGER reject_recipe_target BEFORE UPDATE ON metric_targets WHEN NEW.slot='numerical' BEGIN SELECT RAISE(ABORT,'injected target failure'); END;");
    expect(()=>observe("one",dt(1.5))).toThrow("injected target failure");expect(numerical()?.target.generation).toBe(first.generation);
    expect(store.openLocationCandidates(replay).items[0].metadata).toEqual(metadata(dt(1.2)));expect(commit(first)).toBe("applied");
  }finally{fault.close();}
});
it("rechecks running ownership after a fresh receipt changes effective mods",()=>{
  const first=bind(),location=store.openLocationCandidates(replay).items[0];
  expect(store.confirmAnalysisResources(first,location,{sha256:sha,available:true,metadata:metadata(dt(1.5))},null)).toEqual({state:"stale"});
  expect(commit(first)).toBe("stale");
});
it("keeps consumed native fallback provenance after every native location changes content",()=>{
  const first=bind({...recipe,consumedModsSource:"legacy-mask"});commit(first);
  store.upsertObservation({sourceId:"native",sourceKey:"one",locator:"one",sha256:"d".repeat(64),available:true,
    generation:store.beginScan("native"),addedAt:2,metadata:{}});
  expect(numerical()).toBeUndefined();
});
it("remembers known native origin even when its first mod settings were unavailable",()=>{
  const first=bind({...recipe,consumedModsSource:"legacy-mask"},undefined,false);commit(first);
  observe("two",null);expect(numerical()).toBeUndefined();
  store.upsertObservation({sourceId:"native",sourceKey:"two",locator:"two",sha256:"d".repeat(64),available:true,
    generation:store.beginScan("native"),addedAt:2,metadata:{}});
  expect(numerical()).toBeUndefined();
});
it("does not let a freshly prepared imported duplicate erase the persisted native requirement",()=>{
  bind();store.registerSource({id:"imported",kind:"imported",directory:"C:\\imports"});
  store.upsertObservation({sourceId:"imported",sourceKey:"file",locator:"file",sha256:sha,available:true,generation:store.beginScan("imported"),addedAt:2,metadata:{}});
  store.upsertObservation({sourceId:"native",sourceKey:"one",locator:"one",sha256:"d".repeat(64),available:true,generation:store.beginScan("native"),addedAt:3,metadata:{}});
  const legacy={...recipe,consumedModsSource:"legacy-mask" as const},profile=numericalProfileKey(legacy,{origin:null,native:{state:"absent"}});
  if(profile.state!=="known")throw new Error("Fixture profile");
  store.preparations.request(replay,"S","retry");const pending=store.preparations.claim(replay,"S")!,location=store.openLocationCandidates(replay).items[0];
  expect(store.commitPreparedAnalysis(pending,location,{sha256:sha,available:true,metadata:{}},
    [{slot:"numerical",stage:"S",inputKey:profile.inputKey,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION}],null,undefined,legacy)).toEqual({state:"stale"});
  expect(numerical()).toBeUndefined();
});
it("rechecks the latest origin at final commit before yielded reconciliation reaches this replay",()=>{
  const first=bind({...recipe,consumedModsSource:"legacy-mask"},undefined,false);origin="lazer";expect(commit(first)).toBe("stale");
  expect(numerical()?.target.inputKey).not.toBe(first.inputKey);
});
it("migrates schema11 without losing user metadata or historical results",()=>{
  const first=bind();commit(first);store.setReview(replay,"reviewed");store.close();
  const previous=new DatabaseSync(database);try{
    removePostSchema15Objects(previous);
    previous.exec("DROP TABLE performance_scalar_cache; DROP TABLE performance_recipes; DROP TABLE performance_map_cache; DELETE FROM counters WHERE key='performance-map-use'; DROP TABLE numerical_recipes; UPDATE metric_targets SET producer_version='library-numeric-v1' WHERE slot='numerical'; PRAGMA user_version=11;");
  }finally{previous.close();}
  store=new LibraryStore(database,"two",lookup);expect(numerical()).toBeUndefined();expect(store.getReplay(replay)?.review).toBe("reviewed");
  const inspection=new DatabaseSync(database);try{expect(Number(inspection.prepare("SELECT count(*) n FROM metric_results WHERE slot='numerical'").get()?.n)).toBe(1);}finally{inspection.close();}
  expect(store.integrityCheck()).toBe("ok");
});
