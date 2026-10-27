import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
import { DatabaseSync } from "node:sqlite";
import type { LibraryPreparationRequest, LibraryPreparationTicket } from "./library-preparation-store";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import { libraryTimelineTarget } from "./library-timeline-target";

let directory:string,database:string,store:LibraryStore,replay:string;
const sha="a".repeat(64);
beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),"hindsight-preparation-"));database=join(directory,"library.sqlite");store=new LibraryStore(database,"one");
  store.registerSource({id:"source",kind:"replays",directory:"C:\\fixture"});replay=observe("file",sha);
});
afterEach(()=>{store.close();for(const suffix of ["","-wal","-shm"])if(existsSync(database+suffix))unlinkSync(database+suffix);rmdirSync(directory);});
function observe(key:string,hash:string|null,metadata:Record<string,unknown>={}){
  return store.upsertObservation({sourceId:"source",sourceKey:key,locator:key,sha256:hash,available:hash!==null,
    generation:store.beginScan("source"),addedAt:1,metadata});
}
function request(stage:"P"|"S"|"C"="S",reason:"background"|"selection"|"retry"="selection",id=replay):LibraryPreparationRequest{
  const value=store.preparations.request(id,stage,reason);if(value.state==="disabled")throw new Error("Expected preparation");return value;
}
function claim(value=request()):LibraryPreparationTicket{
  const ticket=store.preparations.claim(value.replayId,value.stage);if(!ticket)throw new Error("Expected preparation claim");return ticket;
}
const targets=[{slot:"numerical" as const,stage:"S" as const,inputKey:"exact-resource-key",producerVersion:"test-v1"}];
it("keeps interactive preparation ahead of an internal background strip repair",()=>{
  const target=store.metrics.setTarget({replayId:replay,slot:"numerical",stage:"S",inputKey:"dense",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
  store.metrics.publishObserved(target,{fields:{ur:{state:"known",value:20}},provenance:{replaySha256:sha,projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,
    ruleset:"stable",scoreOrigin:"reconstructed",coverageQualified:true,completionEvidence:"source-domain-coverage-v1"},errorStrip:{state:"unknown",reason:"strip-size-limit"}});
  expect(store.metrics.admitStripRepairInTransaction(replay)).toBe(true);
  const repair=store.metrics.nextQueued()[0];expect(repair.reason).toBe("strip-repair");
  const selected=observe("selected","b".repeat(64));const intent=request("P","selection",selected);
  expect(store.preparations.nextQueued(1,undefined,repair.id)).toEqual([intent]);
  expect(()=>store.preparations.request(selected,"S","strip-repair" as "retry")).toThrow();
});
function rejectedNumerical(){
  const target=store.metrics.setTarget({replayId:replay,slot:"numerical",stage:"S",inputKey:"rejected-input",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
  store.metrics.publishObserved(target,{fields:{completion:{state:"unknown",reason:"completion-not-established"}},provenance:{projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,
    coverageQualified:false,completionEvidence:"source-domain-coverage-v1",scoreOrigin:"reconstructed",completeAccuracyEvidence:false,completeBreakEvidence:false}});
  return target;
}

it.each(["paused","off","demand","disabled"])("explicit cached coverage retry respects %s admission and retains durable intent",policy=>{
  const old=rejectedNumerical();
  if(policy==="disabled")store.setSourceEnabled("source",false);
  else store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:policy==="paused",mode:policy==="off"?"off":policy==="demand"?"demand":"bg"});
  const settings=store.metrics.analysisSettings(),before=store.metrics.read(replay);
  const queued=store.preparations.request(replay,"S","retry");
  if(policy==="off"||policy==="disabled"){
    expect(queued).toEqual({state:"disabled"});expect(store.metrics.read(replay)).toEqual(before);
  }else{
    expect(queued.state).toBe("queued");expect(store.metrics.readTarget(replay,"numerical")?.generation).toBeGreaterThan(old.generation);
    expect(store.metrics.read(replay)[0].result).toBeUndefined();
    store.close();store=new LibraryStore(database,"reopened-retry");
    expect(store.preparations.read(replay)[0]).toMatchObject({state:"queued",reason:"retry"});
    expect(store.preparations.claim(replay,"S")===undefined).toBe(policy==="paused");
  }
  expect(store.metrics.analysisSettings()).toEqual(settings);
});

it.each(["queued","running"])("does not retire a cached rejected result underneath an already %s preparation",state=>{
  request();if(state==="running")claim();const old=rejectedNumerical(),before=store.metrics.read(replay),pending=store.preparations.read(replay);
  request("S","retry");expect(store.metrics.read(replay)).toEqual(before);expect(store.metrics.readTarget(replay,"numerical")).toEqual(old);
  expect(store.preparations.read(replay)).toEqual(pending);
});

it("rolls rejected cache retirement and target generations back when durable retry insertion fails",()=>{
  const numerical=rejectedNumerical(),timeline=store.metrics.setTarget(libraryTimelineTarget(numerical));
  store.metrics.publishObserved(timeline,{fields:{pp:{state:"unknown",reason:"completion-not-established"}},provenance:{coverageQualified:false}});
  const db=store["db"],snapshot=()=>JSON.stringify([db.prepare("SELECT * FROM metric_targets").all(),db.prepare("SELECT * FROM metric_results").all(),db.prepare("SELECT * FROM metric_jobs").all(),db.prepare("SELECT * FROM analysis_requests").all(),db.prepare("SELECT * FROM counters").all()]);
  const before=snapshot();db.exec("CREATE TEMP TRIGGER reject_retry BEFORE INSERT ON analysis_requests BEGIN SELECT RAISE(ABORT,'retry-write-failed'); END");
  expect(()=>request("S","retry")).toThrow("retry-write-failed");expect(snapshot()).toBe(before);
});
function removePostSchema15Objects(db:DatabaseSync){
  // Drop dependent triggers before their referenced C/query tables and columns.
  for(const type of ["trigger","index","table"]){
    const objects=db.prepare("SELECT name FROM sqlite_master WHERE type=? AND (name GLOB 'query_*' OR name GLOB 'map_cleanup_*')").all(type);
    for(const object of objects)db.exec(`DROP ${type.toUpperCase()} "${String(object.name).replace(/"/g,'""')}"`);
  }
  db.exec("DROP TABLE IF EXISTS resource_changes; DROP TABLE incident_source_epochs; DROP TABLE incident_location_epochs; DROP TABLE incident_recipes; ALTER TABLE metric_results DROP COLUMN strip_payload;");
}

it("keeps preparation separate from metrics, coalesces priority, and retries failures only explicitly",()=>{
  const first=request("S","background");expect(store.metrics.read(replay)).toEqual([]);
  expect(request()).toMatchObject({...first,reason:"selection"});const ticket=claim();
  expect(store.preparations.fail(ticket,"Matching beatmap is unavailable")).toBe("applied");
  expect(request("S","background")).toMatchObject({state:"failed",error:"Matching beatmap is unavailable"});
  expect(store.preparations.nextQueued()).toEqual([]);expect(request("S","retry").generation).toBeGreaterThan(first.generation);
  expect(store.preparations.fail(ticket,"late")).toBe("stale");
});

it("does not reprepare on ordinary scan revisions but fences changed consuming evidence",()=>{
  const ticket=claim();observe("file",sha,{stamp:{mtimeMs:123},fileState:"readable",reason:"old read warning"});
  expect(store.preparations.complete(ticket,targets)).toMatchObject({state:"applied",replayId:replay});
  expect(store.metrics.nextQueued()).toHaveLength(1);expect(request()).toMatchObject({state:"bound"});
  observe("file",sha,{header:{mods:8}});
  const updated=request();expect(updated.state).toBe("queued");expect(updated.dependencyKey).not.toBe(ticket.dependencyKey);
  expect(store.preparations.complete(ticket,targets)).toEqual({state:"stale"});
});

it("atomically validates exact targets and retains reusable completed caches",()=>{
  const ticket=claim();expect(()=>store.preparations.complete(ticket,[...targets,{...targets[0],slot:"incidents"}])).toThrow();
  expect(store.metrics.read(replay)).toEqual([]);expect(store.preparations.read(replay)[0].state).toBe("running");
  expect(store.preparations.complete(ticket,targets).state).toBe("applied");
  const job=store.metrics.nextQueued()[0],metric=store.metrics.claim(job.id);if(!metric)throw new Error("Missing metric claim");
  store.metrics.commit({ticket:metric,producerVersion:metric.producerVersion,fields:{fc:{state:"known",value:true}},provenance:{}});
  const retry=claim(request("S","retry"));expect(store.preparations.complete(retry,targets).state).toBe("applied");
  expect(store.metrics.nextQueued()).toEqual([]);expect(store.metrics.read(replay)[0].result?.fields.fc).toEqual({state:"known",value:true});
});

it("recovers interrupted preparation with new attempts while preserving failures and user Pause",()=>{
  const old=claim(),p=claim(request("P"));store.preparations.fail(p,"Unsupported saved aggregate");
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:true});store.close();store=new LibraryStore(database,"two");
  expect(store.preparations.read(replay).find(item=>item.stage==="P")).toMatchObject({state:"failed",error:"Unsupported saved aggregate"});
  expect(store.preparations.nextQueued()).toEqual([]);expect(store.preparations.release(old)).toBe("stale");
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:false});expect(claim().attempt).not.toBe(old.attempt);
});

it("Off clears unfinished S/C atomically while preserving P, failures and bound records",()=>{
  const s=claim(),p=request("P");
  store["db"].prepare("INSERT INTO analysis_requests VALUES(?,'C',?,1,'background','failed',NULL,'Historical C failure')").run(replay,"c".repeat(64));
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});
  expect(store.preparations.read(replay)).toEqual(expect.arrayContaining([expect.objectContaining({stage:"C",state:"failed"}),p]));
  expect(store.preparations.read(replay).some(item=>item.stage==="S")).toBe(false);
  expect(store.preparations.complete(s,targets)).toEqual({state:"stale"});expect(store.preparations.request(replay,"S","selection")).toEqual({state:"disabled"});
  expect(store.preparations.nextQueued()).toEqual([p]);
});

it("retires persisted C preparations on reopen and refuses all new C intent",()=>{
  const db=store["db"];
  db.prepare("INSERT INTO analysis_requests VALUES(?,'C',?,1,'background','running','old-attempt',NULL)").run(replay,"c".repeat(64));
  const old={replayId:replay,stage:"C" as const,dependencyKey:"c".repeat(64),generation:1,reason:"background" as const,attempt:"old-attempt"};
  expect(store.preparations.nextQueued()).toEqual([]);
  expect(store.preparations.release(old)).toBe("stale");
  expect(store.preparations.isEligible(old)).toBe(false);
  store.close();store=new LibraryStore(database,"after-retirement");
  expect(store.preparations.read(replay)).toEqual([]);
  for(const reason of ["background","selection","retry"] as const){
    expect(store.preparations.request(replay,"C",reason)).toEqual({state:"disabled"});
    expect(store.preparations.claim(replay,"C")).toBeUndefined();
  }
});
it("rejects delayed retired C preparation before transactions and preserves retained source/cache bytes",()=>{
  const ticket={replayId:replay,stage:"C" as const,dependencyKey:"c".repeat(64),generation:1,reason:"background" as const,attempt:"old-attempt"};
  const db=store["db"],before=JSON.stringify([db.prepare("SELECT * FROM locations").all(),db.prepare("SELECT * FROM metric_results").all(),
    db.prepare("SELECT * FROM query_projection").all(),db.prepare("SELECT * FROM analysis_requests").all()]);
  const execute=jest.spyOn(db,"exec");
  try {
    expect(store.preparations.request(replay,"C","retry")).toEqual({state:"disabled"});
    expect(store.preparations.claim(replay,"C")).toBeUndefined();
    expect(store.preparations.release(ticket)).toBe("stale");
    expect(store.preparations.fail(ticket,"late C failure")).toBe("stale");
    expect(store.preparations.complete(ticket,[{slot:"incidents",stage:"C",inputKey:"old-C",producerVersion:"old-C"}])).toEqual({state:"stale"});
    expect(execute).not.toHaveBeenCalled();
  } finally { execute.mockRestore(); }
  expect(JSON.stringify([db.prepare("SELECT * FROM locations").all(),db.prepare("SELECT * FROM metric_results").all(),
    db.prepare("SELECT * FROM query_projection").all(),db.prepare("SELECT * FROM analysis_requests").all()])).toBe(before);
});

it("fences queued and running preparation when recorded mode becomes nonstandard",()=>{
  const ticket=claim();
  observe("file",sha,{header:{mode:2}});
  expect(store.preparations.isEligible(ticket)).toBe(false);
  expect(store.preparations.complete(ticket,targets)).toEqual({state:"stale"});
  for(const stage of ["P","S"] as const){
    expect(store.preparations.request(replay,stage,"background")).toEqual({state:"disabled"});
    expect(store.preparations.claim(replay,stage)).toBeUndefined();
  }
  expect(store.preparations.nextQueued()).toEqual([]);
});

it("holds background requests in On demand and rechecks enabled sources at publication",()=>{
  const background=request("S","background");store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"demand"});
  expect(store.preparations.nextQueued()).toEqual([]);expect(store.preparations.claim(replay,"S")).toBeUndefined();
  expect(request()).toMatchObject({generation:background.generation,reason:"selection"});const ticket=claim();
  store.setSourceEnabled("source",false);expect(store.preparations.complete(ticket,targets)).toEqual({state:"stale"});
  expect(store.preparations.release(ticket)).toBe("applied");store.setSourceEnabled("source",true);expect(claim().attempt).not.toBe(ticket.attempt);
});

it("allows already started background preparation to finish after switching to On demand",()=>{
  const ticket=claim(request("S","background"));store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"demand"});
  expect(store.preparations.complete(ticket,targets)).toMatchObject({state:"applied"});
  // Its numerical work has not started: leave the exact target available for explicit selection.
  expect(store.metrics.nextQueued()).toEqual([]);expect(store.metrics.read(replay)[0].target.inputKey).toBe("exact-resource-key");
  expect(request().state).toBe("bound");expect(store.metrics.nextQueued()).toHaveLength(1);
});

it("rolls back Off and both queues together when preparation storage fails",()=>{
  const ticket=claim();const fault=new DatabaseSync(database);
  try {
    fault.exec("CREATE TRIGGER reject_prep_clear BEFORE DELETE ON analysis_requests BEGIN SELECT RAISE(ABORT,'injected preparation clear failure'); END;");
    expect(()=>store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"})).toThrow("injected preparation clear failure");
    expect(store.metrics.analysisSettings().mode).toBe("bg");expect(store.preparations.read(replay)[0].state).toBe("running");
    fault.exec("DROP TRIGGER reject_prep_clear");expect(store.preparations.release(ticket)).toBe("applied");
  }finally{fault.close();}
});

it("does not resurrect failed S/C preparation as queued when aliases converge in Off",()=>{
  const provisional=observe("pending",null),old=claim(request("S","selection",provisional));store.preparations.fail(old,"Map is missing");
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});observe("pending",sha);
  expect(store.preparations.read(replay)).toEqual([expect.objectContaining({state:"failed",error:"Map is missing"})]);
});

it("migrates schema10 with existing metrics and metadata intact",()=>{
  store.setReview(replay,"reviewed");const target=store.metrics.setTarget({replayId:replay,...targets[0]});store.close();
  const old=new DatabaseSync(database);try{
    removePostSchema15Objects(old);
    old.exec("DROP TABLE performance_scalar_cache; DROP TABLE performance_recipes; DROP TABLE performance_map_cache; DELETE FROM counters WHERE key='performance-map-use'; DROP TABLE numerical_recipes; DROP TABLE analysis_requests; DELETE FROM counters WHERE key='preparation-generation'; PRAGMA user_version=10;");
  }finally{old.close();}
  store=new LibraryStore(database,"two");expect(store.getReplay(replay)?.review).toBe("reviewed");expect(store.metrics.read(replay)[0].target).toEqual(target);
  expect(request().state).toBe("queued");expect(store.integrityCheck()).toBe("ok");
});
it("preserves explicit priority when an ingestion repair changes preparation inputs",()=>{
  const first=request();observe("file",sha,{header:{mods:8}});
  expect(request("S","background")).toMatchObject({reason:"selection",state:"queued"});
  expect(store.preparations.read(replay)[0].generation).toBeGreaterThan(first.generation);
});
it("claims the exact prepared numerical target atomically before ordinary queue admission",()=>{
  const result=store.preparations.complete(claim(),targets,undefined,true);
  expect(result).toMatchObject({state:"applied",handoff:{state:"claimed",ticket:{replayId:replay,inputKey:targets[0].inputKey}}});
  expect(store.metrics.nextQueued()).toEqual([]);
  if(result.state!=="applied"||result.handoff?.state!=="claimed")throw new Error("Missing handoff");
  expect(store.metrics.isLiveTicket(result.handoff.ticket)).toBe(true);
});
it("returns cached or policy-blocked handoff without creating a second running owner",()=>{
  const first=store.preparations.complete(claim(),targets,undefined,true);
  if(first.state!=="applied"||first.handoff?.state!=="claimed")throw new Error("Missing handoff");
  store.metrics.commit({ticket:first.handoff.ticket,producerVersion:targets[0].producerVersion,fields:{fc:{state:"known",value:true}},provenance:{}});
  expect(store.preparations.complete(claim(request("S","retry")),targets,undefined,true)).toMatchObject({handoff:{state:"cached"}});
  const background=claim(request("S","background",observe("new","c".repeat(64))));
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"demand"});
  expect(store.preparations.complete(background,targets,undefined,true)).toMatchObject({state:"applied",handoff:{state:"blocked"}});
});
it("selects only connected preparation stages and compares metric/preparation priority and recency",()=>{
  request("P");request("S","background");
  expect(store.preparations.request(replay,"C","selection")).toEqual({state:"disabled"});
  const target=store.metrics.setTarget({replayId:replay,...targets[0]}),job=store.metrics.request(target,"selection");if(!("id" in job))throw new Error("Missing metric job");
  expect(store.preparations.nextQueued(1,["S"],job.id)).toEqual([]);
  expect(store.preparations.nextQueued(1,["S"])).toEqual([expect.objectContaining({stage:"S"})]);
  const newer=observe("new","b".repeat(64));request("S","selection",newer);
  expect(store.preparations.nextQueued(1,["S"],job.id)[0].replayId).toBe(newer);
});
it("checks active ownership against its exact source lease and fences final publication when all sources disable",()=>{
  const pending=claim(),location=store.openLocationCandidates(replay).items[0];
  expect(store.analysisEligible({kind:"preparation",ticket:pending,location})).toBe(true);
  const bound=store.preparations.complete(pending,targets,undefined,true);if(bound.state!=="applied"||bound.handoff?.state!=="claimed")throw new Error("Missing handoff");
  const ticket=bound.handoff.ticket;expect(store.analysisEligible({kind:"metric",ticket,location})).toBe(true);
  store.setSourceEnabled("source",false);expect(store.analysisEligible({kind:"metric",ticket,location})).toBe(false);
  expect(store.metrics.commit({ticket,producerVersion:ticket.producerVersion,fields:{fc:{state:"known",value:true}},provenance:{}})).toBe("stale");
});

it("coalesces provisional identity intent without transferring known content work",()=>{
  const provisional=observe("pending",null),old=claim(request("S","selection",provisional));
  expect(observe("pending",sha)).toBe(replay);expect(store.preparations.complete(old,targets)).toEqual({state:"stale"});
  expect(store.preparations.read(provisional)[0]).toMatchObject({replayId:replay,state:"queued"});
  expect(claim(request()).replayId).toBe(replay);
  const distinct=observe("file","b".repeat(64));expect(distinct).not.toBe(replay);expect(store.preparations.read(distinct)).toEqual([]);
});

it("publishes verified locations and exact targets in one transaction with map/location CAS",()=>{
  const ticket=claim(),location=store.openLocationCandidates(replay).items[0];
  observe("file",sha,{stamp:{mtimeMs:123}});
  expect(store.openLocationCandidates(replay).items[0].locationRevision).toBeGreaterThan(location.locationRevision);
  expect(store.commitPreparedAnalysis(ticket,location,{sha256:sha,available:true,metadata:{}},targets,null)).toEqual({state:"stale"});
  expect(store.metrics.read(replay)).toEqual([]);
  const current=store.openLocationCandidates(replay).items[0];
  expect(store.commitPreparedAnalysis(ticket,current,{sha256:sha,available:true,metadata:{}},targets,null)).toMatchObject({state:"applied",replayId:replay});
  expect(store.preparations.read(replay)[0].state).toBe("bound");expect(store.metrics.nextQueued()).toHaveLength(1);
});

it("retains preparation and location leases across an identical generation-only observation",()=>{
  const ticket=claim(),location=store.openLocationCandidates(replay).items[0];
  observe("file",sha);
  expect(store.openLocationCandidates(replay).items[0].locationRevision).toBe(location.locationRevision);
  expect(store.commitPreparedAnalysis(ticket,location,{sha256:sha,available:true,metadata:{}},targets,null)).toMatchObject({state:"applied",replayId:replay});
  expect(store.metrics.nextQueued()).toHaveLength(1);
});

it("rejects consumed origin evidence that disagrees with the indexed snapshot",()=>{
  store.close();store=new LibraryStore(database,"one",()=>({client:"stable",provenance:"user-confirmed"}));
  const ticket=claim(),location=store.openLocationCandidates(replay).items[0],receipt={sha256:sha,available:true,metadata:{}};
  expect(store.commitPreparedAnalysis(ticket,location,receipt,targets,{client:"lazer",provenance:"user-confirmed"})).toEqual({state:"stale"});
  expect(store.metrics.read(replay)).toEqual([]);
  expect(store.commitPreparedAnalysis(ticket,location,receipt,targets,{client:"stable",provenance:"user-confirmed"})).toMatchObject({state:"applied"});
});

it("confirms restarted resources only for the live metric attempt and consumed origin",()=>{
  store.close();let client:"stable"|"lazer"="stable";
  store=new LibraryStore(database,"one",()=>({client,provenance:"user-confirmed"}));
  store.preparations.complete(claim(),targets);const job=store.metrics.nextQueued()[0],ticket=store.metrics.claim(job.id)!;
  const location=store.openLocationCandidates(replay).items[0],receipt={sha256:sha,available:true,metadata:{}};
  client="lazer";expect(store.confirmAnalysisResources(ticket,location,receipt,{client:"stable",provenance:"user-confirmed"})).toEqual({state:"stale"});
  expect(store.confirmAnalysisResources({...ticket,attempt:"expired"},location,receipt,{client,provenance:"user-confirmed"})).toEqual({state:"stale"});
  expect(store.confirmAnalysisResources(ticket,location,receipt,{client,provenance:"user-confirmed"})).toMatchObject({state:"applied"});
  expect(store.metrics.nextQueued()).toEqual([]);expect(store.metrics.read(replay).find(entry=>entry.target.slot==="numerical")?.job?.state).toBe("running");
});
