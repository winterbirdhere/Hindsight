import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
import { LibraryService } from "./library-service";
import { libraryIncidentTarget } from "./library-incidents-target";
import { numericalProfileKey } from "./library-numerical-profile";
import { projectLibraryIncidentEvidence } from "./library-incidents-evidence";
import { LIBRARY_INCIDENT_DEPENDENCIES } from "../../../../shared/library-incidents";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import * as projection from "./library-query-projection";
import { libraryOriginRevision } from "./library-origin-index";
import type { LibraryQueryDetail } from "../../../../shared/library-query";

let root:string,store:LibraryStore,service:LibraryService|undefined;
const md5="b".repeat(32),mapSha="c".repeat(64);
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),"c-query-freshness-"));mkdirSync(join(root,"source"));
  store=new LibraryStore(join(root,"library.sqlite"),"seed");
  store.reconcileSources([{id:"replays",kind:"replays",directory:join(root,"source")},{id:"imports",kind:"imported",directory:join(root,"imports")}]);
  store.metrics.setAnalysisSettings({mode:"off",workers:2,userPaused:false,pauseOnBattery:true});
});
afterEach(async()=>{await service?.close();service=undefined;store.close();rmSync(root,{recursive:true,force:true});});
function drain(){let calls=0;while(store.queryProjectionPending()){expect(++calls).toBeLessThan(100);store.maintainQueryProjection();}}
function seed(index:number,model=LIBRARY_INCIDENT_DEPENDENCIES.model,publishNumerical=true){
  const sha=index.toString(16).padStart(64,"0"),generation=store.beginScan("replays");
  const id=store.upsertObservation({sourceId:"replays",sourceKey:String(index),locator:join(root,"source",index+".osr"),sha256:sha,available:true,addedAt:index,generation,
    metadata:{header:{mode:0,version:20260901,beatmapMD5:md5,modsBitmask:0,counts:{great:100,ok:0,meh:0,geki:0,katu:0,miss:0},score:1000,maxCombo:100,player:"Synthetic "+index}}});
  const recipe={version:1 as const,replaySha256:sha,fixedKey:"d".repeat(64),intrinsicNative:false,embeddedModsHash:null,legacyModsHash:"e".repeat(64),modeQualified:true,consumedModsSource:"legacy-mask" as const};
  const profile=numericalProfileKey(recipe,{origin:null,native:{state:"absent"}});if(profile.state!=="known")throw Error("Profile unavailable");
  const numerical=store.metrics.setTarget({replayId:id,slot:"numerical",stage:"S",inputKey:profile.inputKey,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
  expect(store["numericalRecipes"].bindInTransaction(id,numerical,recipe)).toBe(true);
  if(publishNumerical)store.metrics.publishObserved(numerical,{fields:{ur:{state:"known",value:80},completion:{state:"known",value:"passed"}},provenance:{replaySha256:sha,mapSha256:mapSha,ruleset:"stable",coverageQualified:true,completionEvidence:"source-domain-coverage-v1"}});
  const evidence=projectLibraryIncidentEvidence(undefined,{replaySha256:sha,mapMd5:md5});
  const location=store.openLocationCandidates(id).items[0];
  const target=store.metrics.setTarget(libraryIncidentTarget(numerical,evidence,{...LIBRARY_INCIDENT_DEPENDENCIES,model}));
  store.metrics.publishObserved(target,{fields:{incidentCount:{state:"known",value:index}},provenance:{replaySha256:sha,modelRevision:model}});
  store.metrics.publishObserved(store.metrics.setTarget({replayId:id,slot:"source-score",stage:"H",inputKey:"fixture-h",producerVersion:"fixture-h-v1"}),
    {fields:{accuracy:{state:"known",value:1},maxCombo:{state:"known",value:100},misses:{state:"known",value:0}},provenance:{replaySha256:sha}});
  store.metrics.publishObserved(store.metrics.setTarget({replayId:id,slot:"aggregate-pp",stage:"P",inputKey:"fixture-p",producerVersion:"fixture-p-v1"}),
    {fields:{pp:{state:"known",value:123}},provenance:{replaySha256:sha,mapSha256:mapSha}});
  drain();return{id,numerical,evidence,location};
}
function persisted(){return JSON.stringify([store["db"].prepare("SELECT * FROM metric_targets ORDER BY replay_id,slot").all(),
  store["db"].prepare("SELECT * FROM metric_jobs ORDER BY id").all(),store["db"].prepare("SELECT * FROM analysis_requests ORDER BY replay_id,stage").all(),
  store["db"].prepare("SELECT * FROM metric_results ORDER BY replay_id,slot,input_key").all()]);}

function dropFilterEvidence(){const db=store["db"];db.exec("DROP INDEX IF EXISTS query_projection_favourite_filter_cover;DROP INDEX IF EXISTS query_projection_analysis_filter_cover;DROP INDEX query_filter_evidence_pending;DROP INDEX query_projection_player_folded;DROP INDEX query_projection_result;DROP INDEX query_projection_recording_client;DROP TABLE query_filter_evidence_state");for(const column of ["recorded_completion","recording_client","standard_excluded","player_folded","break_evidence","filter_evidence_revision"])db.exec("ALTER TABLE query_projection DROP COLUMN "+column);}

it("has independent generated status-algorithm qualification without changing C identity",()=>{
  expect((projection as unknown as Record<string,unknown>).LIBRARY_QUERY_ALGORITHM_REVISION).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
  expect(store["db"].prepare("PRAGMA user_version").get()?.user_version).toBe(27);
});

it.each(["off","demand","bg"] as const)("repairs status only in bounded restart-safe batches with %s",mode=>{
  const rows=Array.from({length:9},(_,index)=>seed(index+1,undefined,index%2===0));
  const generation=store.beginScan("replays");
  const nonC=store.upsertObservation({sourceId:"replays",sourceKey:"non-c",locator:join(root,"source","non-c.osr"),
    sha256:"f".repeat(64),available:true,addedAt:20,generation,metadata:{header:{beatmapMD5:md5,player:"No C"}}});
  drain();while(store.incidentIdentityPending())store.maintainIncidentIdentity();
  store.metrics.setAnalysisSettings({mode,workers:2,userPaused:true,pauseOnBattery:true});drain();
  const db=store["db"],before=persisted();
  db.exec("UPDATE query_projection SET analysis_algorithm='old-algorithm',analysis='failed',analysis_error='obsolete status',analysis_without_c='failed',analysis_error_without_c='obsolete fallback'");
  db.exec("UPDATE query_analysis_algorithm_state SET revision='old-algorithm',complete=1,after_id='obsolete',verified=999");
  store.close();store=new LibraryStore(join(root,"library.sqlite"),"query-upgrade");
  expect(store.incidentIdentityPending()).toBe(true);expect(store.queryProjectionPending()).toBe(0);
  expect(store.createQueryReader().detail(rows[0].id)?.item).toMatchObject({analysis:"analysed",analysisError:null,values:{incidents:null,ur:80,pp:123}});
  expect(store.createQueryReader().detail(rows[1].id)?.item).toMatchObject({analysis:"none",analysisError:null,values:{incidents:null,ur:null}});
  expect(store.createQueryReader().detail(nonC)?.item).toMatchObject({analysis:"none",analysisError:null,values:{incidents:null}});
  expect(persisted()).toBe(before);
  const read=store.createQueryReader(),page=read.page({limit:1});
  expect(store.maintainIncidentIdentity()).toEqual({updated:8,pending:true});
  expect(()=>read.page({limit:1,cursor:page.next})).toThrow(/changed/);
  const state=store["db"].prepare("SELECT * FROM query_analysis_algorithm_state").get();expect(state?.verified).toBe(8);
  store.close();store=new LibraryStore(join(root,"library.sqlite"),"query-repair-restart");
  expect(store["db"].prepare("SELECT * FROM query_analysis_algorithm_state").get()).toEqual(state);
  expect(store.maintainIncidentIdentity()).toEqual({updated:2,pending:false});
  expect(store["db"].prepare("SELECT count(*) AS n FROM query_projection WHERE analysis='failed' OR analysis_error IS NOT NULL OR analysis_without_c='failed' OR analysis_error_without_c IS NOT NULL").get()?.n).toBe(0);
  expect(store.createQueryReader().detail(rows[8].id)?.item.values.incidents).toBeNull();
  expect(persisted()).toBe(before);
});

it("upgrades schema23 status witnesses without replacing compatible C, H, P or S rows",()=>{
  const row=seed(1);while(store.incidentIdentityPending())store.maintainIncidentIdentity();const before=persisted();
  dropFilterEvidence();
  // Restore pre-journal resource triggers before simulating the historical schema.
  for (const row of store["db"].prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'query_resource_%'").all()) {
    const old = String(row.sql).replace(/BEGIN[\s\S]*END$/, "BEGIN UPDATE query_projection_state SET resource_revision=resource_revision+1 WHERE id=1; END");
    store["db"].exec(`DROP TRIGGER ${row.name};${old}`);
  }
  store["db"].exec("DROP TABLE resource_changes");
  store["db"].exec("DROP INDEX IF EXISTS query_projection_analysis_cover; DROP TABLE query_analysis_algorithm_state; ALTER TABLE query_projection DROP COLUMN analysis_algorithm; PRAGMA user_version=23;");
  expect(store["db"].prepare("PRAGMA user_version").get()?.user_version).toBe(23);
  expect(store["db"].prepare("PRAGMA table_info(query_projection)").all().filter(row=>row.name==="analysis_algorithm")).toEqual([]);
  expect(store["db"].prepare(`SELECT name FROM sqlite_master WHERE name IN
    ('query_analysis_algorithm_state','query_projection_analysis_cover')`).all()).toEqual([]);
  store.close();store=new LibraryStore(join(root,"library.sqlite"),"schema24");
  expect(store["db"].prepare("PRAGMA user_version").get()?.user_version).toBe(27);
  expect(store["db"].prepare("PRAGMA index_info(query_projection_analysis_cover)").all().map(row=>row.name))
    .toEqual(["visible","id","c_identity","analysis_algorithm","analysis","analysis_without_c"]);
  expect(store.createQueryReader().detail(row.id)?.item.values.incidents).toBeNull();
  expect(store.maintainIncidentIdentity()).toEqual({updated:1,pending:true});
  expect(store.maintainIncidentIdentity()).toEqual({updated:1,pending:false});expect(persisted()).toBe(before);
});

it("keeps S status readable with Off and user pause while a viewer holds algorithm repair",async()=>{
  const row=seed(1,undefined,false);while(store.incidentIdentityPending())store.maintainIncidentIdentity();
  store.metrics.setAnalysisSettings({mode:"off",workers:2,userPaused:true,pauseOnBattery:true});drain();
  store.completeSourceMetricRevision(libraryOriginRevision({state:"missing",fingerprint:"missing",entries:new Map()}));
  const before=persisted();
  store["db"].exec("UPDATE query_projection SET analysis_algorithm='old-algorithm',analysis='failed',analysis_error='obsolete status',analysis_without_c='failed',analysis_error_without_c='obsolete fallback'; UPDATE query_analysis_algorithm_state SET revision='old-algorithm',complete=1;");
  store.close();
  service=await LibraryService.open({directory:root,sessionId:"algorithm-viewer-held",nativeExecutable:join(root,"not-present.exe"),
    sources:[{id:"replays",kind:"replays",directory:join(root,"source")}]},undefined,owner=>{void owner.setViewerDemand(true);},false);
  await service.setViewerDemand(true);await new Promise(resolve=>setImmediate(resolve));
  expect(service.status().indexMaintenance.incidentIdentity.pending).toBe(true);
  expect((service.queryRequest("query-detail",{replayId:row.id}) as LibraryQueryDetail).item).toMatchObject({analysis:"none",analysisError:null,values:{incidents:null}});
  expect(service["store"]["db"].prepare("SELECT verified FROM query_analysis_algorithm_state").get()?.verified).toBe(0);
  await service.setViewerDemand(false);await service.settleIndexMaintenance();
  expect(service.status().indexMaintenance.incidentIdentity.pending).toBe(false);
  await service.close();service=undefined;store=new LibraryStore(join(root,"library.sqlite"),"after-service");expect(persisted()).toBe(before);
});

