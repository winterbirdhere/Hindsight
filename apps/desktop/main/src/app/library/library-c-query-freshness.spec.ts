import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
import { LibraryService } from "./library-service";
import { LibraryQueryProjection } from "./library-query-projection";
import { numericalProfileKey } from "./library-numerical-profile";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import { parseLibraryQueryText } from "../../../../shared/library-query";
import type { LibraryQueryDetail } from "../../../../shared/library-query";

let root:string,store:LibraryStore,service:LibraryService|undefined;
const md5="b".repeat(32),mapSha="c".repeat(64);
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),"retired-c-query-"));store=new LibraryStore(join(root,"library.sqlite"),"seed");
  store.reconcileSources([{id:"replays",kind:"replays",directory:join(root,"source")}]);
  store.metrics.setAnalysisSettings({mode:"off",workers:2,userPaused:false,pauseOnBattery:true});
});
afterEach(async()=>{await service?.close();service=undefined;store.close();rmSync(root,{recursive:true,force:true});});
function drain(){let calls=0;while(store.queryProjectionPending()){expect(++calls).toBeLessThan(100);expect(store.maintainQueryProjection().updated).toBeLessThanOrEqual(8);}}
function seed(index:number,withS=true){
  const sha=index.toString(16).padStart(64,"0"),generation=store.beginScan("replays");
  const id=store.upsertObservation({sourceId:"replays",sourceKey:String(index),locator:join(root,"source",index+".osr"),sha256:sha,available:true,addedAt:index,generation,
    metadata:{header:{mode:0,version:20260901,beatmapMD5:md5,modsBitmask:0,counts:{great:100,ok:0,meh:0,miss:0},score:1000,maxCombo:100,player:"Synthetic "+index}}});
  const recipe={version:1 as const,replaySha256:sha,fixedKey:"d".repeat(64),intrinsicNative:false,embeddedModsHash:null,legacyModsHash:"e".repeat(64),modeQualified:true,consumedModsSource:"legacy-mask" as const};
  const profile=numericalProfileKey(recipe,{origin:null,native:{state:"absent"}});if(profile.state!=="known")throw Error("Profile unavailable");
  const numerical=store.metrics.setTarget({replayId:id,slot:"numerical",stage:"S",inputKey:profile.inputKey,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
  expect(store["numericalRecipes"].bindInTransaction(id,numerical,recipe)).toBe(true);
  if(withS)store.metrics.publishObserved(numerical,{fields:{ur:{state:"known",value:80},completion:{state:"known",value:"passed"}},provenance:{replaySha256:sha,mapSha256:mapSha,ruleset:"stable",coverageQualified:true,completionEvidence:"source-domain-coverage-v1"}});
  const incident=store.metrics.setTarget({replayId:id,slot:"incidents",stage:"C",inputKey:"historical-c",producerVersion:"historical-c-v1"});
  store.metrics.publishObserved(incident,{fields:{incidentCount:{state:"known",value:index}},provenance:{replaySha256:sha}});
  store.metrics.publishObserved(store.metrics.setTarget({replayId:id,slot:"source-score",stage:"H",inputKey:"fixture-h",producerVersion:"fixture-h-v1"}),
    {fields:{accuracy:{state:"known",value:1},maxCombo:{state:"known",value:100},misses:{state:"known",value:0}},provenance:{replaySha256:sha}});
  store.metrics.publishObserved(store.metrics.setTarget({replayId:id,slot:"aggregate-pp",stage:"P",inputKey:"fixture-p",producerVersion:"fixture-p-v1"}),
    {fields:{pp:{state:"known",value:123}},provenance:{replaySha256:sha,mapSha256:mapSha}});
  drain();return{id,numerical};
}
function persisted(){return JSON.stringify([store["db"].prepare("SELECT * FROM metric_targets ORDER BY replay_id,slot").all(),
  store["db"].prepare("SELECT * FROM metric_jobs ORDER BY id").all(),store["db"].prepare("SELECT * FROM analysis_requests ORDER BY replay_id,stage").all(),
  store["db"].prepare("SELECT * FROM metric_results ORDER BY replay_id,slot,input_key").all()]);}
function legacySchema(){const db=store["db"];
  // Restore pre-journal resource triggers before simulating the historical schema.
  for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'query_resource_%'").all()) {
    const old = String(row.sql).replace(/BEGIN[\s\S]*END$/, "BEGIN UPDATE query_projection_state SET resource_revision=resource_revision+1 WHERE id=1; END");
    db.exec(`DROP TRIGGER ${row.name};${old}`);
  }
  db.exec("DROP TABLE resource_changes");
  db.exec(`DROP INDEX IF EXISTS query_projection_favourite_filter_cover;DROP INDEX IF EXISTS query_projection_analysis_filter_cover;DROP INDEX IF EXISTS query_projection_analysis_cover;
  DROP INDEX query_filter_evidence_pending;DROP INDEX query_projection_player_folded;DROP INDEX query_projection_result;DROP INDEX query_projection_recording_client;DROP TABLE query_filter_evidence_state;`);
  for(const column of ["recorded_completion","recording_client","standard_excluded","player_folded","break_evidence","filter_evidence_revision"])db.exec("ALTER TABLE query_projection DROP COLUMN "+column);
  db.exec(`DROP TABLE query_analysis_algorithm_state;ALTER TABLE query_projection DROP COLUMN analysis_algorithm;
    DROP INDEX query_c_fallback_pending;DROP TABLE query_c_identity_state;ALTER TABLE query_projection DROP COLUMN c_identity;
    ALTER TABLE query_projection DROP COLUMN analysis_without_c;ALTER TABLE query_projection DROP COLUMN analysis_error_without_c;PRAGMA user_version=22;`);
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(22);
}

it.each([0,1])("does no C-only maintenance for a stale witness with legacy complete=%s",complete=>{
  seed(1);seed(2,false);while(store.incidentIdentityPending())store.maintainIncidentIdentity();
  const db=store["db"];
  db.exec("UPDATE query_projection SET c_identity='retired-c-witness'");
  db.prepare("UPDATE query_c_identity_state SET revision='retired-c-witness',complete=?,after_id='retained-cursor',verified=77").run(complete);
  expect(db.prepare("SELECT complete FROM query_analysis_algorithm_state").get()?.complete).toBe(1);
  expect(db.prepare("SELECT complete FROM query_filter_evidence_state").get()?.complete).toBe(1);
  expect(db.prepare("SELECT count(*) n FROM query_projection WHERE analysis_without_c IS NULL").get()?.n).toBe(0);
  const tables=["query_projection","query_projection_state","query_c_identity_state","query_analysis_algorithm_state","query_filter_evidence_state","numerical_recipes","performance_recipes","contents","counters"],
    snapshot=()=>tables.map(table=>db.prepare("SELECT * FROM "+table+" ORDER BY rowid").all()),before=snapshot(),metrics=persisted(),changes=db.prepare("SELECT total_changes() n").get()?.n;
  const notifications=jest.fn();store.onLibraryChanged(notifications);
  const reopened=new LibraryQueryProjection(db);
  expect(reopened.identityPending()).toBe(false);expect(reopened.identityStatus()).toMatchObject({phase:"idle",pending:false});
  expect(store.maintainIncidentIdentity()).toEqual({updated:0,pending:false});
  expect(snapshot()).toEqual(before);expect(persisted()).toBe(metrics);
  expect(db.prepare("SELECT total_changes() n").get()?.n).toBe(changes);expect(notifications).not.toHaveBeenCalled();
});

it("uses independent S fallback rather than primary C-qualified status in page, detail and facets",()=>{
  const cOnly=seed(1,false),withS=seed(2),db=store["db"];
  db.prepare(`INSERT INTO metric_jobs(id,replay_id,slot,stage,input_key,producer_version,generation,reason,state,error)
    SELECT 'retained-s-failure',replay_id,slot,stage,input_key,producer_version,generation,'selection','failed','S failure' FROM metric_targets WHERE replay_id=? AND slot='numerical'`).run(withS.id);
  drain();while(store.incidentIdentityPending())store.maintainIncidentIdentity();
  db.exec("UPDATE query_projection SET analysis='failed',analysis_error='retired C failure'");
  const before=persisted(),changes=db.prepare("SELECT total_changes() n").get()?.n,read=store.createQueryReader();db.exec("PRAGMA query_only=ON");
  expect(read.detail(cOnly.id)?.item).toMatchObject({analysis:"none",analysisError:null});
  expect(read.detail(withS.id)?.item).toMatchObject({analysis:"failed",analysisError:"S failure"});
  expect(read.page({filters:[{field:"astate",values:["failed"]}]}).items.map(item=>item.id)).toEqual([withS.id]);
  expect(read.facets({},"astate").items).toEqual([{value:"failed",count:1},{value:"none",count:1}]);
  expect(persisted()).toBe(before);expect(db.prepare("SELECT total_changes() n").get()?.n).toBe(changes);
});

it("keeps historical C results inert across page, detail, preview, facets and navigation without admission",()=>{
  const numerical=seed(1),cOnly=seed(2,false),read=store.createQueryReader(),before=persisted(),changes=store["db"].prepare("SELECT total_changes() n").get()?.n;
  store["db"].exec("PRAGMA query_only=ON");
  expect(read.detail(numerical.id)?.item).toMatchObject({analysis:"analysed",values:{incidents:null,ur:80,pp:123,acc:100}});
  expect(read.detail(cOnly.id)?.item).toMatchObject({analysis:"none",values:{incidents:null,ur:null,pp:123}});
  expect(read.detail(cOnly.id)?.metrics.some(metric=>metric.slot==="incidents")).toBe(false);
  const query={filters:[{field:"astate" as const,values:["analysed"]}]};
  expect(read.page(query).items.map(item=>item.id)).toEqual([numerical.id]);expect(read.preview(query).count).toBe(1);
  expect(read.facets({},"astate").items).toEqual([{value:"analysed",count:1},{value:"none",count:1}]);
  expect(read.reveal(query,cOnly.id)).toEqual({state:"not-found"});expect(read.captureOrder(query,10).ids).toEqual([numerical.id]);
  expect(read.sameMap(cOnly.id,query).items.map(row=>row.id)).toEqual([numerical.id]);expect(read.bands(query).items.reduce((n,row)=>n+row.count,0)).toBe(1);
  expect(parseLibraryQueryText("incidents>=1")).toEqual({search:"incidents>=1",filters:[]});
  expect(persisted()).toBe(before);expect(store["db"].prepare("SELECT total_changes() n").get()?.n).toBe(changes);
});
it.each(["queued","running","failed"])("ignores historical C %s jobs and preparations while preserving S state",state=>{
  const cOnly=seed(1,false),withS=seed(2),db=store["db"];
  for(const row of [cOnly,withS]){
    db.prepare(`INSERT INTO metric_jobs(id,replay_id,slot,stage,input_key,producer_version,generation,reason,state,error)
      SELECT ?,replay_id,slot,stage,input_key,producer_version,generation,'background',?,'C failure' FROM metric_targets WHERE replay_id=? AND slot='incidents'`).run(row.id,state,row.id);
    db.prepare("INSERT INTO analysis_requests(replay_id,stage,dependency_key,generation,reason,state,error) VALUES(?,'C','historical',1,'selection',?,'C preparation failure')").run(row.id,state);
  }
  drain();const before=persisted(),read=store.createQueryReader();
  expect(read.detail(cOnly.id)?.item).toMatchObject({analysis:"none",analysisError:null});
  expect(read.detail(withS.id)?.item).toMatchObject({analysis:"analysed",analysisError:null});expect(persisted()).toBe(before);
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:true});drain();
  expect(read.detail(cOnly.id)?.item.analysis).toBe("none");expect(read.detail(withS.id)?.item.analysis).toBe("analysed");
});
it("preserves a valid S failure even beside stale C jobs",()=>{
  const row=seed(1),db=store["db"];
  db.prepare(`INSERT INTO metric_jobs(id,replay_id,slot,stage,input_key,producer_version,generation,reason,state,error)
    SELECT 's-job',replay_id,slot,stage,input_key,producer_version,generation,'selection','failed','S failure' FROM metric_targets WHERE replay_id=? AND slot='numerical'`).run(row.id);
  drain();expect(store.createQueryReader().detail(row.id)?.item).toMatchObject({analysis:"failed",analysisError:"S failure",values:{ur:80,incidents:null}});
});
it("does not re-admit retired C preparation and removes its app-owned queues on restart",()=>{
  const row=seed(1,false),db=store["db"],cached=db.prepare("SELECT * FROM metric_results WHERE slot='incidents'").all();
  expect(store.preparations.request(row.id,"C","selection")).toEqual({state:"disabled"});
  db.prepare("INSERT INTO analysis_requests(replay_id,stage,dependency_key,generation,reason,state) VALUES(?,'C','historical',1,'selection','queued')").run(row.id);
  db.prepare(`INSERT INTO metric_jobs(id,replay_id,slot,stage,input_key,producer_version,generation,reason,state)
    SELECT 'old-c',replay_id,slot,stage,input_key,producer_version,generation,'selection','running' FROM metric_targets WHERE slot='incidents'`).run();
  store.close();store=new LibraryStore(join(root,"library.sqlite"),"restart");drain();
  expect(store["db"].prepare("SELECT * FROM analysis_requests WHERE stage='C'").all()).toEqual([]);
  expect(store["db"].prepare("SELECT * FROM metric_jobs WHERE stage='C'").all()).toEqual([]);
  expect(store["db"].prepare("SELECT * FROM metric_results WHERE slot='incidents'").all()).toEqual(cached);
  expect(store.createQueryReader().detail(row.id)?.item.analysis).toBe("none");
});
it("upgrades legacy metadata passively and repairs filter/status evidence in bounded restart-safe turns",()=>{
  const rows=Array.from({length:9},(_,index)=>seed(index+1)),before=persisted();legacySchema();store.close();store=new LibraryStore(join(root,"library.sqlite"),"upgrade");
  expect(store["db"].prepare("PRAGMA user_version").get()?.user_version).toBe(27);expect(store.queryProjectionPending()).toBe(0);
  const read=store.createQueryReader(),page=read.page({limit:1});expect(read.page().total).toBe(9);expect(read.detail(rows[0].id)?.item.values).toMatchObject({incidents:null,ur:80,pp:123});
  expect(store.maintainIncidentIdentity()).toEqual({updated:8,pending:true});expect(()=>read.page({limit:1,cursor:page.next})).toThrow(/changed/);
  store.close();store=new LibraryStore(join(root,"library.sqlite"),"resume");let turns=0;
  while(store.incidentIdentityPending()){expect(++turns).toBeLessThan(10);expect(store.maintainIncidentIdentity().updated).toBeLessThanOrEqual(8);}
  expect(store["db"].prepare("SELECT count(*) n FROM query_projection WHERE filter_evidence_revision IS NULL OR analysis_without_c IS NULL").get()?.n).toBe(0);
  expect(store.createQueryReader().page().total).toBe(9);expect(persisted()).toBe(before);
});
it("rolls bounded scalar maintenance and its cursor/revision back on a failed write",()=>{
  seed(1);seed(2);const db=store["db"];db.exec("UPDATE query_projection SET filter_evidence_revision=NULL;UPDATE query_filter_evidence_state SET complete=0,after_id='',verified=0");
  const before=db.prepare("SELECT * FROM query_projection ORDER BY id").all(),state=db.prepare("SELECT * FROM query_filter_evidence_state").get(),revision=db.prepare("SELECT revision FROM query_projection_state").get();
  db.exec("CREATE TRIGGER reject_filter_repair BEFORE INSERT ON query_projection BEGIN SELECT RAISE(ABORT,'scalar repair fault');END");
  expect(()=>store.maintainIncidentIdentity()).toThrow("scalar repair fault");
  expect(db.prepare("SELECT * FROM query_projection ORDER BY id").all()).toEqual(before);expect(db.prepare("SELECT * FROM query_filter_evidence_state").get()).toEqual(state);expect(db.prepare("SELECT revision FROM query_projection_state").get()).toEqual(revision);
  db.exec("DROP TRIGGER reject_filter_repair");expect(store.maintainIncidentIdentity().updated).toBe(2);
});
it("holds bounded evidence repair behind the service viewer checkpoint while passive metadata stays readable",async()=>{
  const row=seed(1);legacySchema();store.close();
  service=await LibraryService.open({directory:root,sessionId:"viewer-held",nativeExecutable:join(root,"not-present.exe"),sources:[{id:"replays",kind:"replays",directory:join(root,"source")}]},undefined,owner=>{void owner.setViewerDemand(true);},false);
  await service.setViewerDemand(true);await new Promise(resolve=>setImmediate(resolve));
  expect(service.status().indexMaintenance.ready).toBe(true);expect(service.status().indexMaintenance.incidentIdentity.pending).toBe(true);
  expect((service.queryRequest("query-detail",{replayId:row.id}) as LibraryQueryDetail).item.values.incidents).toBeNull();
  await service.setViewerDemand(false);await service.settleSourceMetrics();await service.settleIndexMaintenance();
  expect(service.status().indexMaintenance.incidentIdentity.pending).toBe(false);
});
