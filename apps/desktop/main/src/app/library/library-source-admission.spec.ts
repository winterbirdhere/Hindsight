import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
import { LibraryQueryInvalidation } from "./library-query-invalidation";
import { LibrarySourceAdmission } from "./library-source-admission";
import { numericalProfileKey } from "./library-numerical-profile";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LibraryNumericalInputRecipe } from "../../../../shared/library-analysis";
import { projectLibraryIncidentEvidence } from "./library-incidents-evidence";

let folder:string,file:string,store:LibraryStore;
const sha="a".repeat(64),md5="b".repeat(32),mapSha="c".repeat(64);
beforeEach(()=>{
  folder=mkdtempSync(join(tmpdir(),"source-admission-"));file=join(folder,"index.sqlite");store=new LibraryStore(file,"one");
  store.registerSource({id:"source",kind:"replays",directory:"fixture"});
  store.registerSource({id:"other",kind:"imported",directory:"owned"});
});
afterEach(()=>{store.close();for(const suffix of ["","-wal","-shm"])if(existsSync(file+suffix))unlinkSync(file+suffix);rmdirSync(folder);});
function observe(source="source",key="one",hash=sha){
  return store.upsertObservation({sourceId:source,sourceKey:key,locator:key,sha256:hash,available:true,addedAt:1,
    generation:store.beginScan(source),metadata:{header:{mode:0,version:20260901,beatmapMD5:md5,mods:0,
      counts:{great:100,ok:0,meh:0,geki:0,katu:0,miss:0},score:1000,maxCombo:100,player:"Player"}}});
}
function drainQuery(){let n=0;while(store.queryProjectionPending()){expect(++n).toBeLessThan(1000);store.maintainQueryProjection();}}
function drainAdmission(){let n=0;while(store.sourceAdmissionPending()){expect(++n).toBeLessThan(1000);drainQuery();store.maintainSourceAdmission();}}
function bindRecipes(id:string){
  const recipe:LibraryNumericalInputRecipe={version:1,replaySha256:sha,fixedKey:"d".repeat(64),intrinsicNative:false,
    embeddedModsHash:null,legacyModsHash:"e".repeat(64),modeQualified:true,consumedModsSource:"legacy-mask"};
  const profile=numericalProfileKey(recipe,{origin:null,native:{state:"absent"}});if(profile.state!=="known")throw Error("Missing profile");
  const numerical=store.metrics.setTarget({replayId:id,slot:"numerical",stage:"S",inputKey:profile.inputKey,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
  expect(store["numericalRecipes"].bindInTransaction(id,numerical,recipe)).toBe(true);
  store.metrics.publishObserved(numerical,{fields:{ur:{state:"known",value:80},completion:{state:"known",value:"passed"}},
    provenance:{replaySha256:sha,mapSha256:mapSha,ruleset:"stable",coverageQualified:true,completionEvidence:"source-domain-coverage-v1"}});
  store["performanceRecipes"].bindInTransaction(id,store["performanceDependencies"](id),[
    {slot:"calculated-map",stage:"P",producerVersion:"p-fixture-v1",inputKey:"1".repeat(64),fields:{mapStars:{state:"known",value:4}},provenance:{mapSha256:mapSha,ruleset:"stable"}},
    {slot:"aggregate-pp",stage:"P",producerVersion:"p-fixture-v1",inputKey:"2".repeat(64),fields:{pp:{state:"known",value:100}},provenance:{mapSha256:mapSha,ruleset:"stable",replaySha256:sha}},
  ],false);
  // Historical C rows are compatibility input, never a reason to call retired production binding.
  const evidence=projectLibraryIncidentEvidence(undefined,{replaySha256:sha,mapMd5:md5}),db=store["db"];
  db.prepare("INSERT INTO incident_recipes(replay_id,numerical_key,numerical_version,evidence) VALUES(?,?,?,?)")
    .run(id,numerical.inputKey,numerical.producerVersion,JSON.stringify(evidence));
  db.prepare("INSERT INTO metric_targets VALUES(?,'incidents','C',?,?,999)").run(id,"old-model-key","historical-c-v1");
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,'incidents','C',?,?,?)")
    .run(id,"old-model-key","historical-c-v1",JSON.stringify({fields:{incidentCount:{state:"known",value:2}},provenance:{replaySha256:sha}}));
  drainQuery();return numerical;
}

it("preserves compatible H/P/S recipes across source toggles without restoring historical C",()=>{
  const id=observe();observe("other");bindRecipes(id);
  const reader=store.createQueryReader();expect(reader.detail(id)?.item.values).toMatchObject({pp:100,ur:80});
  expect((reader.detail(id)?.item.values as unknown as Record<string,unknown>).incidents??null).toBeNull();
  const before=store.metrics.read(id).filter(row=>row.target.stage!=="C");
  const numerical=jest.spyOn(store["numericalRecipes"],"reconcileInTransaction"),performance=jest.spyOn(store["performanceRecipes"],"reconcileInTransaction");
  const dirty=jest.fn();store.onAnalysisDirty(dirty);store.setSourceEnabled("source",false);
  expect(dirty).toHaveBeenCalledWith(4);
  // The bounded source-visibility patch is complete; there is no extra C-only dirtiness.
  expect(store.queryProjectionPending()).toBe(0);
  expect(store.sourceAdmissionPending()).toBeGreaterThan(0);
  expect(reader.detail(id)?.item).toMatchObject({sourceKinds:["imported"],available:true,analysis:"analysed",analysisError:null,
    values:{pp:100,ur:80}});drainQuery();
  expect(store.sourceAdmissionPending()).toBeGreaterThan(0);
  expect(reader.detail(id)?.item.values).toMatchObject({pp:100,ur:80});
  expect(store.metrics.read(id).filter(row=>row.target.stage!=="C")).toEqual(before);
  expect(numerical).not.toHaveBeenCalled();expect(performance).not.toHaveBeenCalled();
  store.setSourceEnabled("source",true);drainQuery();
  expect(store.preparations.request(id,"C","selection")).toEqual({state:"disabled"});
  expect(store.preparations.request(id,"C","retry")).toEqual({state:"disabled"});
  expect(store.preparations.claim(id,"C")).toBeUndefined();drainAdmission();drainQuery();
  expect(reader.detail(id)?.item).toMatchObject({analysis:"analysed",analysisError:null,values:{pp:100,ur:80}});
  expect((reader.detail(id)?.item.values as unknown as Record<string,unknown>).incidents??null).toBeNull();
  expect(store.metrics.read(id).filter(row=>row.target.stage!=="C")).toEqual(before);
  expect(store.preparations.read(id).some(row=>row.stage==="C")).toBe(false);
});

it("keeps old C identity and payload inert through source admission and query maintenance",()=>{
  const id=observe();observe("other");bindRecipes(id);
  const db=store["db"],historical=db.prepare("SELECT * FROM metric_results WHERE replay_id=? AND slot='incidents'").all(id);drainQuery();
  store.setSourceEnabled("source",false);drainQuery();
  expect(db.prepare("SELECT input_key FROM metric_targets WHERE replay_id=? AND slot='incidents'").get(id)?.input_key).toBe("old-model-key");
  expect(store.sourceAdmissionPending()).toBeGreaterThan(0);drainAdmission();drainQuery();
  expect(db.prepare("SELECT * FROM metric_results WHERE replay_id=? AND slot='incidents'").all(id)).toEqual(historical);
  expect(store.createQueryReader().detail(id)?.item).toMatchObject({analysis:"analysed",analysisError:null,values:{pp:100,ur:80}});
  expect((store.createQueryReader().detail(id)?.item.values as unknown as Record<string,unknown>).incidents??null).toBeNull();
  expect(store.metrics.nextQueued().some(row=>row.target.stage==="C")).toBe(false);
  expect(store.preparations.nextQueued().some(row=>row.stage==="C")).toBe(false);
});

describe.each(["bg","demand","off"] as const)("retired C-only index under %s settings",mode=>{
  it.each(["queued","running","failed","cached"] as const)("never exposes %s C as analysis or revives it after source re-enable/restart",state=>{
    const id=observe(),db=store["db"],key="f".repeat(64);
    store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode});
    db.prepare("INSERT INTO metric_targets VALUES(?,'incidents','C',?,'historical-c-v1',999)").run(id,key);
    db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,'incidents','C',?,'historical-c-v1',?)")
      .run(id,key,JSON.stringify({fields:{incidentCount:{state:"known",value:2}},provenance:{replaySha256:sha}}));
    if(state!=="cached"){
      db.prepare("INSERT INTO metric_jobs VALUES('historical-c-job',?,'incidents','C',?,'historical-c-v1',999,'background',?,?,?)")
        .run(id,key,state,state==="running"?"historical-attempt":null,state==="failed"?"historical C failure":null);
      db.prepare("INSERT INTO analysis_requests VALUES(?,'C',?,999,'background',?,?,?)")
        .run(id,key,state,state==="running"?"historical-preparation":null,state==="failed"?"historical C preparation failure":null);
    }
    const assertRetired=()=>{
      expect(store.createQueryReader().detail(id)?.item).toMatchObject({analysis:"none",analysisError:null});
      expect(store.preparations.request(id,"C","retry")).toEqual({state:"disabled"});
      expect(store.preparations.claim(id,"C")).toBeUndefined();expect(store.metrics.claim("historical-c-job")).toBeUndefined();
      expect(store.metrics.nextQueued().some(row=>row.target.stage==="C")).toBe(false);
      expect(store.preparations.nextQueued().some(row=>row.stage==="C")).toBe(false);
    };
    store.setSourceEnabled("source",false);store.setSourceEnabled("source",true);drainQuery();drainAdmission();drainQuery();assertRetired();
    const payload=db.prepare("SELECT payload FROM metric_results WHERE replay_id=? AND slot='incidents'").get(id);
    store.close();store=new LibraryStore(file,"restart");drainQuery();drainAdmission();drainQuery();assertRetired();
    expect(store.preparations.read(id).some(row=>row.stage==="C")).toBe(false);
    expect(store["db"].prepare("SELECT * FROM metric_jobs WHERE stage='C'").all()).toEqual([]);
    expect(store["db"].prepare("SELECT payload FROM metric_results WHERE replay_id=? AND slot='incidents'").get(id)).toEqual(payload);
  });
});

it.each(["off","demand","paused"] as const)("honours %s during deferred admission and keeps explicit selection independent",mode=>{
  const id=observe();store.enablePerformanceAdmission();store.enableNumericalAdmission();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:mode==="paused"?"bg":mode,userPaused:mode==="paused"});
  store.setSourceEnabled("source",false);drainQuery();store.setSourceEnabled("source",true);drainQuery();
  expect(store.sourceAdmissionPending()).toBeGreaterThan(0);expect(store.createQueryReader().page({}).total).toBe(1);
  if(mode!=="off")store.preparations.request(id,"S","selection");
  drainAdmission();expect(store.queryProjectionPending()).toBe(0);
  const requests=store.preparations.read(id);expect(requests.find(row=>row.stage==="P")?.state).toBe("queued");
  expect(requests.find(row=>row.stage==="S")?.reason).toBe(mode==="off"?undefined:"selection");
  if(mode==="paused")expect(store.preparations.nextQueued()).toEqual([]);
});

it("persists an active admission cursor and revisits identities after rapid disable/enable",()=>{
  const ids=Array.from({length:20},(_,i)=>observe("source",String(i),i.toString(16).padStart(64,"0")));
  store.enablePerformanceAdmission();store.setSourceEnabled("source",false);drainQuery();store.setSourceEnabled("source",true);drainQuery();
  store.maintainSourceAdmission();expect(store.sourceAdmissionPending()).toBeGreaterThan(0);expect(store.queryProjectionPending()).toBe(0);
  store.setSourceEnabled("source",false);store.setSourceEnabled("source",true);drainQuery();
  store.close();store=new LibraryStore(file,"restart");store.enablePerformanceAdmission();drainQuery();
  expect(store.sourceAdmissionPending()).toBeGreaterThan(0);expect(store.createQueryReader().page({}).total).toBe(20);drainAdmission();
  for(const id of ids)expect(store.preparations.read(id).find(row=>row.stage==="P")?.state).toBe("queued");
  expect(store.queryProjectionPending()).toBe(0);
});

it("rolls admission work and its durable cursor back together on a failed page",()=>{
  for(let i=0;i<3;i++)observe("source",String(i),i.toString(16).padStart(64,"0"));drainQuery();
  const db=store["db"],queue=new LibraryQueryInvalidation(db,"source_admission_scopes");queue.enqueue("source","source");
  const before=db.prepare("SELECT * FROM source_admission_scopes").all(),requests=store.preparations.read(store.listReplayIds()[0]);
  let calls=0;const work=new LibrarySourceAdmission(db,id=>{store.preparations.requestInTransaction(id,"P","background");if(++calls===2)throw Error("page fault");});
  db.exec("BEGIN IMMEDIATE");expect(()=>work.maintainInTransaction(2)).toThrow("page fault");db.exec("ROLLBACK");
  expect(db.prepare("SELECT * FROM source_admission_scopes").all()).toEqual(before);
  expect(store.preparations.read(store.listReplayIds()[0])).toEqual(requests);
});
