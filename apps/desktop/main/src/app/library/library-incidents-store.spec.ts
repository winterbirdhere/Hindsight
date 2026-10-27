import { DatabaseSync } from "node:sqlite";
import { LibraryIncidentRecipeStore } from "./library-incidents-store";
import { LibraryMetricStore } from "./library-metric-store";
import { libraryIncidentTarget } from "./library-incidents-target";
import { projectLibraryIncidentEvidence } from "./library-incidents-evidence";
const sha="a".repeat(64),md5="b".repeat(32),numerical={replayId:"r",slot:"numerical" as const,stage:"S" as const,inputKey:"c".repeat(64),producerVersion:"numeric-test"};
let db:DatabaseSync,metrics:LibraryMetricStore,recipes:LibraryIncidentRecipeStore;
beforeEach(()=>{
  db=new DatabaseSync(":memory:");db.exec("CREATE TABLE replays(id TEXT PRIMARY KEY,merged_into TEXT); INSERT INTO replays VALUES('r',NULL); CREATE TABLE counters(key TEXT PRIMARY KEY,value INTEGER); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE contents(replay_id TEXT,sha256 TEXT)");
  db.prepare("INSERT INTO contents VALUES('r',?)").run(sha);LibraryMetricStore.migrate(db);db.exec("ALTER TABLE metric_results ADD COLUMN strip_payload TEXT");
  db.exec("CREATE TABLE sources(id TEXT PRIMARY KEY,config_revision INTEGER,enabled INTEGER,configured INTEGER); INSERT INTO sources VALUES('files',1,1,1); CREATE TABLE locations(source_id TEXT,source_key TEXT,replay_id TEXT,revision INTEGER,sha256 TEXT)");
  db.prepare("INSERT INTO locations VALUES('files','r','r',2,?)").run(sha);
  db.exec("ALTER TABLE replays ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'; ALTER TABLE locations ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
  LibraryIncidentRecipeStore.migrate(db);LibraryIncidentRecipeStore.migrateFreshness(db);metrics=new LibraryMetricStore(db,id=>id,work=>work());recipes=new LibraryIncidentRecipeStore(db,metrics);
  metrics.setTarget(numerical);
});
afterEach(()=>db.close());
const receipt=()=>projectLibraryIncidentEvidence(undefined,{replaySha256:sha,mapMd5:md5});
it("derives and reconciles C from target identity without hydrating metric results or jobs",()=>{
  const evidence=receipt(),expected=libraryIncidentTarget(numerical,evidence);
  recipes.bindInTransaction("r",numerical,evidence);
  const read=jest.spyOn(metrics,"read").mockImplementation(()=>{throw Error("Full metric hydration is not a target dependency");});
  try{
    expect(recipes.currentTarget("r")).toEqual(expected);
    // An obsolete C model target must still be repaired, not hidden by a visibility fast path.
    metrics.setTarget({...expected,inputKey:"e".repeat(64)});
    recipes.reconcileInTransaction("r");
    expect(db.prepare("SELECT input_key FROM metric_targets WHERE replay_id='r' AND slot='incidents'").get()?.input_key).toBe(expected.inputKey);
    expect(read).not.toHaveBeenCalled();
  }finally{read.mockRestore();}
});
it("retains exact numerical and evidence dependencies independently of source freshness",()=>{
  const evidence=receipt();recipes.bindInTransaction("r",numerical,evidence);
  const lease={sourceId:"files",sourceKey:"r",sourceConfigRevision:1,locationRevision:2,sourceEpoch:0,locationEpoch:0,scope:"stable-sidecar" as const};
  expect(recipes.attestInTransaction("r",evidence,lease)).toBe(true);
  const expected=recipes.currentTarget("r");db.exec("UPDATE sources SET config_revision=2,enabled=0");
  expect(recipes.fresh("r")).toBe(false);expect(recipes.currentTarget("r")).toEqual(expected);
  for(const changed of [{...numerical,inputKey:"d".repeat(64)},{...numerical,producerVersion:"numeric-next"}]){
    metrics.setTarget(changed);expect(recipes.currentTarget("r")).toBeUndefined();recipes.reconcileInTransaction("r");
    expect(db.prepare("SELECT 1 FROM metric_targets WHERE replay_id='r' AND slot='incidents'").get()).toBeUndefined();
    metrics.setTarget(numerical);recipes.reconcileInTransaction("r");expect(recipes.currentTarget("r")).toEqual(expected);
  }
  metrics.clearTargetInTransaction("r","numerical");expect(recipes.currentTarget("r")).toBeUndefined();
  metrics.setTarget(numerical);
  const changedEvidence=projectLibraryIncidentEvidence({status:"absent",attempts:[]},{replaySha256:sha,mapMd5:md5});
  recipes.bindInTransaction("r",numerical,changedEvidence);expect(recipes.currentTarget("r")?.inputKey).not.toBe(expected?.inputKey);
  const beforeVersion=recipes.currentTarget("r");
  recipes.bindInTransaction("r",numerical,{...changedEvidence,validationVersion:"evidence-next"});
  expect(recipes.currentTarget("r")?.inputKey).not.toBe(beforeVersion?.inputKey);
  db.exec("UPDATE incident_recipes SET evidence=json_set(evidence,'$.version',2)");
  expect(()=>recipes.currentTarget("r")).toThrow("Invalid incident evidence receipt");
});
it("clears a stale C target without reading metric payloads when no recipe exists",()=>{
  metrics.setTarget(libraryIncidentTarget(numerical,receipt()));
  const read=jest.spyOn(metrics,"read");
  try{
    expect(recipes.currentTarget("r")).toBeUndefined();recipes.reconcileInTransaction("r");
    expect(read).not.toHaveBeenCalled();
    expect(db.prepare("SELECT slot FROM metric_targets WHERE replay_id='r' ORDER BY slot").all()).toEqual([{slot:"numerical"}]);
  }finally{read.mockRestore();}
});
it("binds C separately and preserves numerical output when optional evidence changes",()=>{
  const original=metrics.read("r")[0].target;
  metrics.publishObserved(original,{fields:{misses:{state:"known",value:0}},provenance:{replaySha256:sha}});
  const evidence=receipt();recipes.bindInTransaction("r",numerical,evidence);
  expect(metrics.read("r").find(row=>row.target.slot==="incidents")?.target).toMatchObject(libraryIncidentTarget(numerical,evidence));
  const absent=projectLibraryIncidentEvidence({status:"absent",attempts:[]},{replaySha256:sha,mapMd5:md5});
  recipes.bindInTransaction("r",numerical,absent);
  expect(metrics.read("r").find(row=>row.target.slot==="incidents")?.target.inputKey).not.toBe(libraryIncidentTarget(numerical,evidence).inputKey);
  expect(metrics.read("r").find(row=>row.target.slot==="numerical")?.result?.fields.misses).toEqual({state:"known",value:0});
});
it("keeps a historical C cache tied to its exact numerical recipe while new C publication stays retired",()=>{
  recipes.bindInTransaction("r",numerical,receipt());const target=metrics.read("r").find(row=>row.target.slot==="incidents");if(!target)throw Error("missing C");
  const payload=JSON.stringify({fields:{incidentCount:{state:"known",value:0}},provenance:{replaySha256:sha}});
  expect(metrics.publishObserved(target.target,JSON.parse(payload))).toBe("stale");
  expect(db.prepare("SELECT * FROM metric_results WHERE slot='incidents'").all()).toEqual([]);
  // Retain cache-identity compatibility coverage using an old index row, not live C execution.
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,?,?,?,?,?)")
    .run("r","incidents","C",target.target.inputKey,target.target.producerVersion,payload);
  metrics.setTarget({...numerical,inputKey:"d".repeat(64)});recipes.reconcileInTransaction("r");
  expect(metrics.read("r").find(row=>row.target.slot==="incidents")).toBeUndefined();
  metrics.setTarget(numerical);recipes.reconcileInTransaction("r");
  expect(metrics.read("r").find(row=>row.target.slot==="incidents")?.result?.fields.incidentCount).toEqual({state:"known",value:0});
  expect(metrics.request(metrics.read("r").find(row=>row.target.slot==="incidents")!.target,"retry")).toEqual({state:"disabled"});
  expect(db.prepare("SELECT COUNT(*) AS count FROM metric_jobs").get()?.count).toBe(0);
});
it("requires verified replay content and exposes only a bounded semantic receipt",()=>{
  expect(()=>recipes.bindInTransaction("r",numerical,{...receipt(),replaySha256:"f".repeat(64)})).toThrow();
  recipes.bindInTransaction("r",numerical,receipt());expect(recipes.read("r")).toEqual({numerical:{inputKey:numerical.inputKey,producerVersion:numerical.producerVersion},evidence:receipt()});
  expect(JSON.stringify(recipes.read("r"))).not.toMatch(/timelinePath|rows|causes|frames/);
});
it("dirty evidence hides C without changing its semantic key or restarting a running attempt",()=>{
  const evidence=receipt(),lease={sourceId:"files",sourceKey:"r",sourceConfigRevision:1,locationRevision:2,sourceEpoch:0,locationEpoch:0,scope:"stable-sidecar" as const};
  recipes.bindInTransaction("r",numerical,evidence);expect(recipes.fresh("r")).toBe(false);
  expect(recipes.attestInTransaction("r",evidence,lease)).toBe(true);expect(recipes.fresh("r")).toBe(true);
  const target=recipes.currentTarget("r");recipes.dirtyInTransaction("files","r");expect(recipes.fresh("r")).toBe(false);
  expect(recipes.currentTarget("r")).toEqual(target);expect(recipes.attestInTransaction("r",evidence,lease)).toBe(false);
  expect(recipes.attestInTransaction("r",evidence,{...lease,locationEpoch:1})).toBe(true);expect(recipes.fresh("r")).toBe(true);
});
it("fences source changes after probe while unaffected named locations remain fresh",()=>{
  const evidence=receipt(),lease={sourceId:"files",sourceKey:"r",sourceConfigRevision:1,locationRevision:2,sourceEpoch:0,locationEpoch:0,scope:"stable-sidecar" as const};
  recipes.bindInTransaction("r",numerical,evidence);recipes.attestInTransaction("r",evidence,lease);
  recipes.dirtyInTransaction("files","another");expect(recipes.fresh("r")).toBe(true);
  recipes.dirtyInTransaction("files");expect(recipes.fresh("r")).toBe(false);expect(recipes.leaseMatches("r",evidence,lease)).toBe(false);
  expect(recipes.attestInTransaction("r",evidence,{...lease,sourceEpoch:1})).toBe(true);
  db.exec("UPDATE sources SET config_revision=2");expect(recipes.fresh("r")).toBe(false);
});
