import { mkdtempSync,rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { LibraryStore } from "./library-store";
import type { LibraryPreparedResult } from "./library-preparation-store";
import { metricInputKey } from "./library-source-metrics";
let directory:string,store:LibraryStore,id:string;
const md5="a".repeat(32),sha256="b".repeat(64),sourceKey="c".repeat(64);
const saved={sourceKey,databaseVersion:20250101,header:{mode:0,version:20250101,beatmapMD5:md5,modsBitmask:0,
  counts:{great:3,ok:0,meh:0,miss:0,geki:0,katu:0},maxCombo:3,score:123}};
const result:LibraryPreparedResult={slot:"calculated-map",stage:"P",inputKey:"d".repeat(64),producerVersion:"library-map-performance-v1",
  fields:{mapStars:{state:"known",value:2}},provenance:{mapSha256:sha256,mapMd5:md5,sourceOnly:true}};
beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),"hindsight-p-publication-"));store=new LibraryStore(join(directory,"library.sqlite"),"one");
  store.registerSource({id:"stable",kind:"stable",directory:"C:/fixture"});
  id=store.upsertObservation({sourceId:"stable",sourceKey,locator:"C:/fixture/absent.osr",sha256:null,available:false,
    generation:store.beginScan("stable"),addedAt:1,metadata:{savedScore:saved}});
  const generation=store.beginMapScan("stable");store.upsertMap({sourceId:"stable",sourceKey:"map",generation,md5,locator:"C:/fixture/map.osu",state:"unverified",metadata:{}});
  store.finishMapScan("stable",generation);
});
afterEach(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
function begin(){store.preparations.request(id,"P","selection");const ticket=store.preparations.claim(id,"P");if(!ticket)throw Error("Expected P claim");
  return{ticket,location:store.openLocationCandidates(id).items[0],map:{md5,sha256,ticket:store.openMapCandidates(md5).items[0]}};}
function metric(){return store.metrics.read(id).find(entry=>entry.target.slot==="calculated-map");}
function removePostSchema15Objects(db:DatabaseSync){
  // Drop dependent triggers before their referenced C/query tables and columns.
  for(const type of ["trigger","index","table"]){
    const objects=db.prepare("SELECT name FROM sqlite_master WHERE type=? AND (name GLOB 'query_*' OR name GLOB 'map_cleanup_*')").all(type);
    for(const object of objects)db.exec(`DROP ${type.toUpperCase()} "${String(object.name).replace(/"/g,'""')}"`);
  }
  db.exec("DROP TABLE IF EXISTS resource_changes; DROP TABLE incident_source_epochs; DROP TABLE incident_location_epochs; DROP TABLE incident_recipes; ALTER TABLE metric_results DROP COLUMN strip_payload;");
}
it("atomically publishes P while Off without inventing replay availability, rewriting source observations or queuing S/C",()=>{
  store.metrics.setAnalysisSettings({mode:"off",userPaused:false,workers:1,pauseOnBattery:true});store.setFavourite(id,true);
  const before=store.getReplay(id),receipt=begin();
  expect(store.commitPreparedPerformance(receipt.ticket,receipt.location,receipt.map,[result],null)).toEqual({state:"applied",replayId:id});
  expect(metric()).toMatchObject({result:{fields:result.fields},job:undefined});expect(store.openLocationCandidates(id).items[0]).toEqual(receipt.location);
  expect(store.getReplay(id)).toEqual(before);expect(store.metrics.nextQueued()).toEqual([]);expect(store.preparations.read(id)).toEqual([expect.objectContaining({state:"bound",stage:"P"})]);
  store.close();store=new LibraryStore(join(directory,"library.sqlite"),"two");expect(metric()?.result?.fields).toEqual(result.fields);
});
it.each(["location","source","map","alias"])("rejects stale %s ownership before any P publication",change=>{
  const receipt=begin();
  if(change==="location")store.upsertObservation({sourceId:"stable",sourceKey,locator:receipt.location.locator,sha256:null,available:false,
    generation:store.beginScan("stable"),addedAt:1,metadata:{savedScore:{...saved,header:{...saved.header,score:124}}}});
  if(change==="source"){store.setSourceEnabled("stable",false);store.setSourceEnabled("stable",true);}
  if(change==="map")store.finishMapScan("stable",store.beginMapScan("stable"));
  if(change==="alias")store.commitLocationRefresh(receipt.location,{sha256:"f".repeat(64),available:true,metadata:{savedScore:saved}});
  expect(store.commitPreparedPerformance(receipt.ticket,receipt.location,receipt.map,[result],null).state).toBe("stale");expect(metric()).toBeUndefined();
});
it("rolls back the entire publication when a result is invalid or names different map bytes",()=>{
  const receipt=begin();
  expect(()=>store.commitPreparedPerformance(receipt.ticket,receipt.location,receipt.map,[{...result,fields:{mapStars:{state:"known",value:NaN}}}],null)).toThrow();
  expect(metric()).toBeUndefined();expect(store.preparations.read(id)[0].state).toBe("running");
  expect(()=>store.commitPreparedPerformance(receipt.ticket,receipt.location,receipt.map,[{...result,provenance:{mapSha256:"e".repeat(64),mapMd5:md5}}],null)).toThrow();
  expect(metric()).toBeUndefined();expect(store.preparations.read(id)[0].state).toBe("running");
});
it("requires an exact native managed map binding when no Stable map ticket was used",()=>{
  store.registerSource({id:"native",kind:"lazer",directory:"C:/native"});
  id=store.upsertObservation({sourceId:"native",sourceKey:"native-id",locator:"native:missing",sha256:null,available:false,
    generation:store.beginScan("native"),addedAt:1,metadata:{schemaFingerprint:"e".repeat(64),nativeScore:{id:"native-id",ruleset:0,
      isLegacyScore:false,replay:{status:"missing"},beatmap:{md5,sha256,path:"C:/native/map",status:"unverified"}}}});
  const receipt=begin();
  expect(store.commitPreparedPerformance(receipt.ticket,receipt.location,{md5,sha256:"e".repeat(64)},[result],null).state).toBe("stale");
  expect(metric()).toBeUndefined();
  expect(store.commitPreparedPerformance(receipt.ticket,receipt.location,{md5,sha256},[result],null)).toEqual({state:"applied",replayId:id});
});
it("keeps independent aggregate PP through unknown numerical completion while Off and still invalidates consumed score changes",()=>{
  store.metrics.setAnalysisSettings({mode:"off",userPaused:false,workers:1,pauseOnBattery:true});
  const receipt=begin(),pp:LibraryPreparedResult={slot:"aggregate-pp",stage:"P",producerVersion:"p-v1",inputKey:"e".repeat(64),
    fields:{pp:{state:"known",value:0}},provenance:{mapSha256:sha256,mapMd5:md5,ruleset:"stable"}};
  expect(store.commitPreparedPerformance(receipt.ticket,receipt.location,receipt.map,[result,pp],null).state).toBe("applied");
  const read=()=>store.metrics.read(id).find(entry=>entry.target.slot==="aggregate-pp")?.result?.fields.pp;
  expect(read()).toEqual({state:"known",value:0});
  const target=store.metrics.setTarget({replayId:id,slot:"numerical",stage:"S",inputKey:"finished",producerVersion:"s-v1"});
  store.metrics.publishObserved(target,{fields:{completion:{state:"known",value:"passed"}},
    provenance:{mapSha256:sha256,ruleset:"stable",coverageQualified:true,completionEvidence:"source-domain-coverage-v1"}});
  expect(read()).toEqual({state:"known",value:0});
  store.metrics.setTarget({...target,inputKey:"different-recording"});expect(read()).toEqual({state:"known",value:0});
  store.metrics.publishObserved(store.metrics.read(id).find(entry=>entry.target.slot==="numerical")!.target,
    {fields:{completion:{state:"known",value:"passed"}},provenance:{mapSha256:sha256,ruleset:"stable",coverageQualified:true,completionEvidence:"source-domain-coverage-v1"}});
  expect(read()).toEqual({state:"known",value:0});
  store.upsertObservation({sourceId:"stable",sourceKey,locator:receipt.location.locator,sha256:null,available:false,
    generation:store.beginScan("stable"),addedAt:1,metadata:{savedScore:{...saved,header:{...saved.header,score:124}}}});
  expect(read()?.state).toBe("unknown");expect(metric()?.result?.fields).toEqual(result.fields);expect(store.metrics.nextQueued()).toEqual([]);
  store.close();store=new LibraryStore(join(directory,"library.sqlite"),"two");expect(read()?.state).toBe("unknown");
});
it("publishes a later qualified P aggregate directly after metadata recovery has completed",()=>{
  store.metrics.setAnalysisSettings({mode:"off",userPaused:false,workers:1,pauseOnBattery:true});
  while(store.incidentIdentityPending())store.maintainIncidentIdentity();
  const receipt=begin(),pp:LibraryPreparedResult={slot:"aggregate-pp",stage:"P",producerVersion:"p-v1",inputKey:"e".repeat(64),
    fields:{pp:{state:"known",value:141.00979770521923}},provenance:{mapSha256:sha256,mapMd5:md5,ruleset:"stable",sourceOnly:true}};
  expect(store.commitPreparedPerformance(receipt.ticket,receipt.location,receipt.map,[result,pp],null).state).toBe("applied");
  expect(store.metrics.read(id).find(entry=>entry.target.slot==="aggregate-pp")?.result).toEqual({fields:pp.fields,provenance:pp.provenance});
  expect(store.metrics.read(id).find(entry=>entry.target.slot==="numerical")).toBeUndefined();
  expect(store.incidentIdentityPending()).toBe(false);expect(store.metrics.nextQueued()).toEqual([]);
});
it.each([["off",false],["demand",false],["bg",true]] as const)("restores retained If FC metadata with mode=%s paused=%s without calculation or user-policy changes",(mode,userPaused)=>{
  store.setFavourite(id,true);store.createCollection("Keep this collection",null,id);
  const receipt=begin(),fc:LibraryPreparedResult={slot:"fc-pp",stage:"P",producerVersion:"library-p-v1",inputKey:"9".repeat(64),
    fields:{ppIfFc:{state:"known",value:454.52234070017204}},provenance:{mapSha256:sha256,mapMd5:md5,ruleset:"stable",sourceOnly:true}};
  expect(store.commitPreparedPerformance(receipt.ticket,receipt.location,receipt.map,[result,fc],null).state).toBe("applied");
  store.metrics.setAnalysisSettings({mode,userPaused,workers:1,pauseOnBattery:true});
  const read=()=>store.metrics.read(id).find(entry=>entry.target.slot==="fc-pp");
  expect(read()?.result).toEqual({fields:fc.fields,provenance:fc.provenance});
  store.performanceCache.putScalar(fc.inputKey,"stable",454.52234070017204);
  const db=(store as unknown as {db:DatabaseSync}).db;
  const recipe=db.prepare("SELECT * FROM performance_recipes WHERE replay_id=?").get(id),policy=store.metrics.analysisSettings();
  const protectedRows=()=>({replays:db.prepare("SELECT id,metadata,favourite FROM replays ORDER BY id").all(),
    collections:db.prepare("SELECT * FROM collections ORDER BY id").all(),memberships:db.prepare("SELECT * FROM memberships ORDER BY replay_id,collection_id").all(),
    caches:db.prepare("SELECT * FROM performance_scalar_cache ORDER BY input_key").all(),jobs:db.prepare("SELECT * FROM metric_jobs ORDER BY replay_id,slot").all(),
    preparations:db.prepare("SELECT * FROM analysis_requests ORDER BY replay_id,stage").all()});
  const before=protectedRows(),prior=JSON.stringify({after_id:"zzzz",complete:1,verified:7604});
  db.prepare("INSERT INTO settings(key,value) VALUES('independent-aggregate-pp-visibility-v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(prior);
  const published=read();if(!published)throw Error("Expected published If FC target");
  const knownHistory=db.prepare("SELECT * FROM metric_results WHERE replay_id=? AND slot='fc-pp' AND input_key=?").get(id,published.target.inputKey);
  const maskedKey=metricInputKey({version:"library-p-visibility-v1",raw:fc.inputKey,visibility:"unknown"});
  db.prepare("UPDATE metric_targets SET input_key=? WHERE replay_id=? AND slot='fc-pp'").run(maskedKey,id);
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,'fc-pp','P',?,'library-p-v1',?)")
    .run(id,maskedKey,JSON.stringify({fields:{ppIfFc:{state:"unknown",reason:"completion-unavailable"}},provenance:fc.provenance}));
  const maskedHistory=db.prepare("SELECT * FROM metric_results WHERE replay_id=? AND slot='fc-pp' AND input_key=?").get(id,maskedKey);
  let turns=0;while(store.queryProjectionPending()||store.incidentIdentityPending()){
    expect(++turns).toBeLessThanOrEqual(12);
    expect((store.queryProjectionPending()?store.maintainQueryProjection():store.maintainIncidentIdentity()).updated).toBeLessThanOrEqual(8);
  }
  const restored=read();if(!restored)throw Error("Expected restored If FC target");
  expect(restored.result).toEqual({fields:fc.fields,provenance:fc.provenance});
  expect(store.metrics.analysisSettings()).toEqual(policy);expect(protectedRows()).toEqual(before);
  expect(db.prepare("SELECT * FROM performance_recipes WHERE replay_id=?").get(id)).toEqual(recipe);
  expect(db.prepare("SELECT * FROM metric_results WHERE replay_id=? AND slot='fc-pp' AND input_key=?").get(id,restored.target.inputKey)).toEqual(knownHistory);
  expect(db.prepare("SELECT * FROM metric_results WHERE replay_id=? AND slot='fc-pp' AND input_key=?").get(id,maskedKey)).toEqual(maskedHistory);
  expect(db.prepare("SELECT value FROM settings WHERE key='independent-aggregate-pp-visibility-v1'").get()?.value).toBe(prior);
  expect(store.metrics.read(id).find(entry=>entry.target.slot==="numerical")).toBeUndefined();
  if(mode==="off"){
    store.close();store=new LibraryStore(join(directory,"library.sqlite"),"restarted");
    expect(store.incidentIdentityPending()).toBe(false);expect(read()?.result).toEqual({fields:fc.fields,provenance:fc.provenance});
    expect(store.metrics.analysisSettings()).toEqual(policy);
  }
});
it("migrates schema13 without dropping already indexed source and map data",()=>{
  store.close();const prior=new DatabaseSync(join(directory,"library.sqlite"));
  let currentVersion:number;
  try{
    currentVersion=Number(prior.prepare("PRAGMA user_version").get()?.user_version);
    removePostSchema15Objects(prior);
    prior.exec("DROP TABLE performance_scalar_cache; DROP TABLE performance_recipes; PRAGMA user_version=13");
  }finally{prior.close();}
  store=new LibraryStore(join(directory,"library.sqlite"),"two");expect(store.getReplay(id)?.id).toBe(id);
  const receipt=begin();expect(store.commitPreparedPerformance(receipt.ticket,receipt.location,receipt.map,[result],null).state).toBe("applied");
  store.close();const checked=new DatabaseSync(join(directory,"library.sqlite"));
  try{expect(checked.prepare("PRAGMA user_version").get()?.user_version).toBe(currentVersion);}finally{checked.close();}
});
it("returns canonical P evidence only for a live unchanged preparation",()=>{
  const receipt=begin(),context=store.preparePerformanceContext(receipt.ticket);
  expect(context).toMatchObject({mapMd5:md5,replaySha256:null,evidence:{nativeRequired:false,header:{score:123}}});
  store.upsertObservation({sourceId:"stable",sourceKey,locator:receipt.location.locator,sha256:null,available:false,
    generation:store.beginScan("stable"),addedAt:1,metadata:{savedScore:{...saved,header:{...saved.header,score:124}}}});
  expect(()=>store.preparePerformanceContext(receipt.ticket)).toThrow(/stale/i);
});
it("retains a P continuation when unconsumed source display metadata changes",()=>{
  const receipt=begin(),before=store.preparePerformanceContext(receipt.ticket);
  store.upsertObservation({sourceId:"stable",sourceKey,locator:receipt.location.locator,sha256:null,available:false,
    generation:store.beginScan("stable"),addedAt:1,metadata:{savedScore:{...saved,header:{...saved.header,playerName:"renamed display"}}}});
  expect(store.preparePerformanceContext(receipt.ticket)).toEqual(before);
});
it("fences a separately consumed score location even when another source remains enabled",()=>{
  const recording="f".repeat(64);id=store.upsertObservation({sourceId:"stable",sourceKey,locator:"C:/fixture/replay.osr",sha256:recording,available:true,
    generation:store.beginScan("stable"),addedAt:1,metadata:{savedScore:saved,header:saved.header}});
  store.registerSource({id:"imports",kind:"imported",directory:"C:/imports"});
  store.upsertObservation({sourceId:"imports",sourceKey:recording,locator:"C:/imports/replay.osr",sha256:recording,available:true,
    generation:store.beginScan("imports"),addedAt:1,metadata:{header:saved.header}});
  const receipt=begin(),locations=store.openLocationCandidates(id).items,mapLocation=locations.find(value=>value.sourceId==="stable")!,
    scoreLocation=locations.find(value=>value.sourceId==="imports")!;
  store.setSourceEnabled("imports",false);
  expect(store.commitPreparedPerformance(receipt.ticket,mapLocation,receipt.map,[result],null,false,scoreLocation).state).toBe("stale");
  expect(metric()).toBeUndefined();
});
it("can publish independent no-mod math while recording-origin evidence is unavailable",()=>{
  id=store.upsertObservation({sourceId:"stable",sourceKey,locator:"C:/fixture/replay.osr",sha256:"f".repeat(64),available:true,
    generation:store.beginScan("stable"),addedAt:1,metadata:{savedScore:saved,header:saved.header}});
  store.close();store=new LibraryStore(join(directory,"library.sqlite"),"two",()=>({client:"unknown",provenance:"unavailable"}));
  const receipt=begin();expect(store.preparePerformanceContext(receipt.ticket).evidence.origin).toBe("unknown");
  expect(store.commitPreparedPerformance(receipt.ticket,receipt.location,receipt.map,[result],{client:"unknown",provenance:"unavailable"}).state).toBe("applied");
});
