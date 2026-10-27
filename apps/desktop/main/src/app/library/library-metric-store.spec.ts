import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { LIBRARY_P_PRODUCER_VERSION } from "./library-performance-versions";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
import type { LibraryMetricTarget, LibraryMetricTicket, LibraryMetricPatch, LibraryMetricResult } from "../../../../shared/replay-library-metrics";
import { libraryTimelineTarget } from "./library-timeline-target";
import { LibraryMetricApi } from "./library-metric-api";
import { libraryFcTarget } from "./library-fc-target";
import { LibraryMetricStore,libraryCapabilityAttempt } from "./library-metric-store";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";

let folder: string, database: string, store: LibraryStore, replay: string;
const hash = "a".repeat(64);

function rejectedCoverage():LibraryMetricResult {
  return {fields:{completion:{state:"unknown",reason:"completion-not-established"},ur:{state:"unknown",reason:"no-valid-timing-samples"}},
    provenance:{projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,coverageQualified:false,completionEvidence:"source-domain-coverage-v1",
      scoreOrigin:"reconstructed",completeAccuracyEvidence:false,completeBreakEvidence:false},errorStrip:{state:"unknown",reason:"strip-evidence-incomplete"}};
}
function cachedCoverage(value=rejectedCoverage(),version=LIBRARY_NUMERIC_PROJECTION_VERSION){
  const numerical=store.metrics.setTarget({replayId:replay,slot:"numerical",stage:"S",inputKey:"selected-input",producerVersion:version});
  store.metrics.publishObserved(numerical,value);return numerical;
}
function retryCoverage(){return store.preparations.request(replay,"S","retry");}
function metricRows(){return JSON.stringify(store["db"].prepare("SELECT * FROM metric_results ORDER BY replay_id,slot,input_key").all());}

it.each(["none","queued","running"])("reads exact rejected-coverage eligibility without mutating %s ownership",state=>{
  const numerical=cachedCoverage(),timeline=store.metrics.setTarget(libraryTimelineTarget(numerical));
  if(state!=="none"){
    const request=store.metrics.request(timeline,"background");if(!("id" in request))throw Error("Missing dependent job");
    if(state==="running")expect(store.metrics.claim(request.id)).toBeDefined();
  }
  const rows=metricRows(),heads=store.metrics.read(replay),requests=store.preparations.read(replay);
  const changes=store["db"].prepare("SELECT total_changes() AS n").get();
  expect(store.metrics.canRetryRejectedCoverageInTransaction(replay)).toBe(true);
  expect(store["db"].prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  expect(metricRows()).toBe(rows);expect(store.metrics.read(replay)).toEqual(heads);expect(store.preparations.read(replay)).toEqual(requests);
});

it.each(["queued","running"])("keeps %s numerical ownership separate from the read-only eligibility result",state=>{
  const target=cachedCoverage(),db=store["db"];
  db.prepare("INSERT INTO metric_jobs VALUES('pending-current',?,?,?,?,?,?, 'background',?,?,NULL)")
    .run(replay,target.slot,target.stage,target.inputKey,target.producerVersion,target.generation,state,state==="running"?"current-attempt":null);
  const heads=store.metrics.read(replay),rows=metricRows(),changes=db.prepare("SELECT total_changes() AS n").get();
  expect(store.metrics.canRetryRejectedCoverageInTransaction(replay)).toBe(true);
  expect(store.metrics.retryRejectedCoverageInTransaction(replay)).toBe(false);
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  expect(store.metrics.read(replay)).toEqual(heads);expect(metricRows()).toBe(rows);
});

it.each([false,true])("records the additive capability attempt only on live numerical production (handoff=%s)",handoff=>{
  const value=rejectedCoverage();value.provenance.ruleset="stable";
  const old=cachedCoverage(value);
  expect(store.metrics.read(replay)[0].result?.provenance.capabilityAttempt).toBeUndefined();
  retryCoverage();const current=store.metrics.readTarget(replay,"numerical");if(!current)throw Error("Missing retry target");
  const ticket=claim(current,"retry"),patch={ticket,producerVersion:ticket.producerVersion,...value};
  if(handoff)store.metrics.commitAndClaimTimeline(patch);else expect(store.metrics.commit(patch)).toBe("applied");
  expect(store.metrics.read(replay).find(e=>e.target.slot==="numerical")?.result?.provenance.capabilityAttempt).toBe("stable-prefix-v3");
  expect(store.metrics.publishObserved(old,value)).toBe("stale");
  expect(value.provenance.capabilityAttempt).toBeUndefined();
});

it.each([false,true])("marks a still rejected native current production once, not observed restoration (handoff=%s)",handoff=>{
  const value=rejectedCoverage();value.provenance.ruleset="lazer";
  const target=cachedCoverage(value);expect(store.metrics.read(replay)[0].result?.provenance.capabilityAttempt).toBeUndefined();
  retryCoverage();const current=store.metrics.readTarget(replay,"numerical");if(!current)throw Error("Missing current numerical");
  const active=claim(current,"retry"),patch={ticket:active,producerVersion:active.producerVersion,...value};
  if(handoff)store.metrics.commitAndClaimTimeline(patch);else store.metrics.commit(patch);
  expect(store.metrics.read(replay).find(e=>e.target.slot==="numerical")?.result?.provenance.capabilityAttempt).toBe("native-held-release-v2");
  expect(store.metrics.publishObserved(target,value)).toBe("stale");expect(value.provenance.capabilityAttempt).toBeUndefined();
});

it.each(["marker","owner","version","ruleset","reason","known","strip"])("rejects an invalid capability marker (%s) without publishing",fault=>{
  const value=rejectedCoverage();value.provenance.ruleset="stable";value.provenance.capabilityAttempt="stable-prefix-v1";
  let input={replayId:replay,slot:"numerical" as const,stage:"S" as const,inputKey:"new-input",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION};
  if(fault==="marker")value.provenance.capabilityAttempt="future-capability";
  if(fault==="owner")value.provenance.capabilityAttempt="dominant-tempo-v2";
  if(fault==="version")input={...input,producerVersion:"old-v5"};
  if(fault==="ruleset")value.provenance.ruleset="lazer";
  if(fault==="reason")value.fields.ur={state:"unknown",reason:"unsupported"};
  if(fault==="known")value.fields.ur={state:"known",value:100};
  if(fault==="strip")value.errorStrip=strip();
  const ticket=claim(store.metrics.setTarget(input));
  expect(()=>store.metrics.commit({ticket,producerVersion:ticket.producerVersion,...value})).toThrow("Invalid library metric payload");
  expect(store.metrics.read(replay)[0].result).toBeUndefined();expect(store.metrics.isEligible(ticket)).toBe(true);
});

it("does not stamp stale work, restoration, or already known numerical mathematics",()=>{
  const value=rejectedCoverage();value.provenance.ruleset="stable";
  const old=store.metrics.setTarget({replayId:replay,slot:"numerical",stage:"S",inputKey:"before",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
  const ticket=claim(old),current=store.metrics.setTarget({...old,inputKey:"after"});
  expect(store.metrics.commitAndClaimTimeline({ticket,producerVersion:ticket.producerVersion,...value})).toEqual({state:"stale"});
  store.metrics.publishObserved(current,value);
  expect(store.metrics.read(replay)[0].result?.provenance.capabilityAttempt).toBeUndefined();
  const known=store.metrics.setTarget({...current,inputKey:"known"}),active=claim(known),payload={fields:{ur:{state:"known" as const,value:100}},provenance:{coverageQualified:true}};
  store.metrics.commit({ticket:active,producerVersion:active.producerVersion,...payload});
  expect(store.metrics.read(replay)[0].result).toEqual(payload);
});

it("observed known evidence supersedes an attempted unknown without inheriting its marker",()=>{
  const value=rejectedCoverage();value.provenance.ruleset="stable";
  const target=store.metrics.setTarget({replayId:replay,slot:"numerical",stage:"S",inputKey:"observed",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION}),ticket=claim(target);
  store.metrics.commit({ticket,producerVersion:ticket.producerVersion,...value});
  const observed={fields:{ur:{state:"known" as const,value:100},completion:{state:"known" as const,value:"passed" as const}},provenance:{coverageQualified:true}};
  store["transaction"](()=>store.metrics.publishObservedInTransaction(target,observed,true));
  const current=store.metrics.read(replay)[0].result;if(!current)throw Error("Missing merged result");
  expect(current.fields.ur).toEqual(observed.fields.ur);expect(current.provenance.capabilityAttempt).toBeUndefined();
});

it("explicit coverage retry retires only the selected unknown tuple and fences cached dependent generations",()=>{
  const historical=store.metrics.setTarget({replayId:replay,slot:"numerical",stage:"S",inputKey:"historical-input",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
  store.metrics.publishObserved(historical,{fields:{ur:{state:"known",value:100}},provenance:{coverageQualified:true}});
  const numerical=cachedCoverage(),timeline=store.metrics.setTarget(libraryTimelineTarget(numerical));
  store.metrics.publishObserved(timeline,{fields:{peakPp:{state:"unknown",reason:"performance-data-unavailable"},pp:{state:"unknown",reason:"completion-not-established"}},provenance:{coverageQualified:false}});
  const fc=store.metrics.setTarget(libraryFcTarget(numerical));
  store.metrics.publishObserved(fc,{fields:{ppIfFc:{state:"unknown",reason:"completion-not-established"}},provenance:{coverageQualified:false}});
  const history=store["db"].prepare("SELECT * FROM metric_results WHERE input_key='historical-input'").get();
  expect(retryCoverage()).toMatchObject({state:"queued"});
  for(const old of [numerical,timeline,fc]){
    const current=store.metrics.read(replay).find(e=>e.target.slot===old.slot);
    expect(current?.target).toMatchObject({inputKey:old.inputKey,producerVersion:old.producerVersion});
    expect(current?.target.generation).toBeGreaterThan(old.generation);expect(current?.result).toBeUndefined();
    expect(store.metrics.publishObserved(old,{fields:old.slot==="numerical"?{ur:{state:"known",value:99}}:old.slot==="timeline-pp"?{peakPp:{state:"known",value:99}}:{ppIfFc:{state:"known",value:99}},provenance:{}})).toBe("stale");
  }
  expect(store["db"].prepare("SELECT * FROM metric_results WHERE input_key='historical-input'").get()).toEqual(history);
  const heads=store.metrics.read(replay),prep=store.preparations.read(replay);retryCoverage();
  expect(store.metrics.read(replay)).toEqual(heads);expect(store.preparations.read(replay)).toEqual(prep);
});

it("coverage retry fences an owned dependent attempt before a fresh numerical result can publish",()=>{
  const numerical=cachedCoverage(),timeline=store.metrics.setTarget(libraryTimelineTarget(numerical)),old=claim(timeline);
  const dirty:number[]=[];const unsubscribe=store.onAnalysisDirty(flags=>dirty.push(flags));
  try{retryCoverage();expect(dirty.some(flags=>(flags&4)!==0)).toBe(true);}finally{unsubscribe();}
  expect(store.metrics.isEligible(old)).toBe(false);
  expect(store.metrics.finishTimelineAndClaimFc(old,{metrics:{fields:{peakPp:{state:"known",value:8}},provenance:{}}})).toEqual({state:"stale"});
  const fresh=store.metrics.readTarget(replay,"numerical");if(!fresh)throw Error("Missing refreshed target");
  const ticket=claim(fresh,"retry");
  expect(store.metrics.commitAndClaimTimeline({ticket,producerVersion:ticket.producerVersion,fields:{completion:{state:"known",value:"passed"},ur:{state:"known",value:100}},provenance:{coverageQualified:true}}).state).toBe("claimed");
  expect(store.metrics.read(replay).find(e=>e.target.slot==="numerical")?.result?.fields.ur).toEqual({state:"known",value:100});
  expect(store.metrics.release(old)).toBe("stale");
});
it("coverage retry rejects a completed numerical attempt after the same input is claimed with a new generation",()=>{
  const target=store.metrics.setTarget({replayId:replay,slot:"numerical",stage:"S",inputKey:"same-input",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
  const old=claim(target);store.metrics.commit({ticket:old,producerVersion:old.producerVersion,...rejectedCoverage()});retryCoverage();
  const current=store.metrics.readTarget(replay,"numerical");if(!current)throw Error("Missing retry target");
  const fresh=claim(current,"retry"),result={fields:{ur:{state:"known" as const,value:100}},provenance:{coverageQualified:true}};
  expect(fresh.generation).toBeGreaterThan(old.generation);
  expect(store.metrics.commit({ticket:old,producerVersion:old.producerVersion,...result})).toBe("stale");
  expect(store.metrics.release(old)).toBe("stale");expect(store.metrics.isEligible(fresh)).toBe(true);
  expect(store.metrics.commit({ticket:fresh,producerVersion:fresh.producerVersion,...result})).toBe("applied");
});

it.each(["known","qualified","error","not-applicable","other-completion","other-reason","other-domain","other-origin","other-version","complete-accuracy","complete-break","known-strip"])(
  "coverage retry preserves ineligible cached numerical evidence: %s",fault=>{
    const value=rejectedCoverage();let version=LIBRARY_NUMERIC_PROJECTION_VERSION;
    if(fault==="known")value.fields.ur={state:"known",value:90};
    if(fault==="qualified")value.provenance.coverageQualified=true;
    if(fault==="error")value.fields.ur={state:"error",reason:"bad-input"};
    if(fault==="not-applicable")value.fields.completion={state:"not-applicable",reason:"unsupported-recording"};
    if(fault==="other-completion")value.fields.completion={state:"unknown",reason:"unsupported-recording"};
    if(fault==="other-reason")value.fields.ur={state:"unknown",reason:"unsupported-recording"};
    if(fault==="other-domain")value.provenance.completionEvidence="other-proof";
    if(fault==="other-origin")value.provenance.scoreOrigin="recorded";
    if(fault==="other-version"){version="library-numeric-v5";value.provenance.projectionVersion=version;}
    if(fault==="complete-accuracy")value.provenance.completeAccuracyEvidence=true;
    if(fault==="complete-break")value.provenance.completeBreakEvidence=true;
    if(fault==="known-strip")value.errorStrip=strip();
    const numerical=cachedCoverage(value,version),before=metricRows();
    expect(store.metrics.canRetryRejectedCoverageInTransaction(replay)).toBe(false);retryCoverage();
    expect(metricRows()).toBe(before);expect(store.metrics.readTarget(replay,"numerical")).toEqual(numerical);
  });

it.each(["known","error","not-applicable","mismatch","qualified"])("coverage retry fails closed on conflicting dependent %s",fault=>{
  const numerical=cachedCoverage(),input=libraryTimelineTarget(numerical);
  const timeline=store.metrics.setTarget({...input,...(fault==="mismatch"?{inputKey:"unrelated-input"}:{})});
  store.metrics.publishObserved(timeline,{fields:{peakPp:fault==="known"?{state:"known",value:5}:fault==="error"?{state:"error",reason:"bad-input"}:fault==="not-applicable"?{state:"not-applicable",reason:"unsupported-recording"}:{state:"unknown",reason:"performance-data-unavailable"}},provenance:{coverageQualified:fault==="qualified"}});
  const before=metricRows(),heads=store.metrics.read(replay);
  expect(store.metrics.canRetryRejectedCoverageInTransaction(replay)).toBe(false);retryCoverage();
  expect(metricRows()).toBe(before);expect(store.metrics.read(replay)).toEqual(heads);
});

it("coverage retry preserves P map/scalar cache and independent calculated-map publication",()=>{
  const numerical=cachedCoverage(),map={version:1 as const,objectCount:1,stars:1,maxCombo:1,largeTicks:0,smallTicks:0,sliderTails:0,clockRate:1,drainTimeMs:1000,endTimeMs:1000};
  store.performanceCache.put("b".repeat(64),"stable",map);store.performanceCache.putScalar("c".repeat(64),"stable",3);
  store.metrics.bindPreparedResultInTransaction({replayId:replay,slot:"calculated-map",stage:"P",inputKey:"map",producerVersion:"p-v1"},{fields:{mapStars:{state:"known",value:1}},provenance:{}});
  const db=store["db"],before=JSON.stringify([db.prepare("SELECT * FROM performance_map_cache").all(),db.prepare("SELECT * FROM performance_scalar_cache").all(),db.prepare("SELECT * FROM metric_results WHERE stage='P'").all()]);
  retryCoverage();expect(store.metrics.readTarget(replay,"numerical")?.generation).toBeGreaterThan(numerical.generation);
  expect(JSON.stringify([db.prepare("SELECT * FROM performance_map_cache").all(),db.prepare("SELECT * FROM performance_scalar_cache").all(),db.prepare("SELECT * FROM metric_results WHERE stage='P'").all()])).toBe(before);
});
it("does not retire known S-owned FC when independent P visibility is supported",()=>{
  const numerical=cachedCoverage(),fc=store.metrics.setTarget(libraryFcTarget(numerical));
  store.metrics.publishObserved(fc,{fields:{ppIfFc:{state:"known",value:40}},provenance:{coverageQualified:true}});
  const before=store.metrics.read(replay),rows=metricRows();
  expect(store.metrics.canRetryRejectedCoverageInTransaction(replay)).toBe(false);retryCoverage();
  expect(store.metrics.read(replay)).toEqual(before);expect(metricRows()).toBe(rows);
});
it.each(["aggregate-pp","fc-pp"] as const)("coverage retry preserves contradictory known or not-applicable P %s",slot=>{
  const old=cachedCoverage();
  for(const state of ["known","not-applicable"] as const){
    store.metrics.bindPreparedResultInTransaction({replayId:replay,slot,stage:"P",inputKey:"saved-score",producerVersion:"p-v1"},
      {fields:{[slot==="aggregate-pp"?"pp":"ppIfFc"]:state==="known"?{state,value:3}:{state,reason:"failed-play"}},provenance:{}});
    const before=metricRows();expect(store.metrics.canRetryRejectedCoverageInTransaction(replay)).toBe(false);
    retryCoverage();expect(metricRows()).toBe(before);expect(store.metrics.readTarget(replay,"numerical")).toEqual(old);
    const pending=store.preparations.claim(replay,"S");if(!pending)throw Error("Expected retry intent");store.preparations.fail(pending,"fixture-ended");
  }
});
it("ordinary selection/background does not repeatedly reconsider rejected coverage",()=>{
  const old=cachedCoverage(),before=metricRows();
  store.preparations.request(replay,"S","background");store.preparations.request(replay,"S","selection");
  expect(metricRows()).toBe(before);expect(store.metrics.readTarget(replay,"numerical")).toEqual(old);
});
it("explicit coverage retry retires a matching failed dependent attempt without admitting its stale publication",()=>{
  const old=cachedCoverage(),timeline=store.metrics.setTarget(libraryTimelineTarget(old)),ticket=claim(timeline);
  store.metrics.fail(ticket,"Native drain unconfirmed");retryCoverage();
  const current=store.metrics.read(replay).find(entry=>entry.target.slot==="timeline-pp");
  expect(current?.target.generation).toBeGreaterThan(timeline.generation);expect(current?.job).toBeUndefined();
  expect(store.metrics.finishTimelineAndClaimFc(ticket,{metrics:{fields:{peakPp:{state:"known",value:9}},provenance:{}}})).toEqual({state:"stale"});
});
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hindsight-metrics-")); database = join(folder, "library.sqlite");
  store = new LibraryStore(database, "one");
  store.registerSource({ id: "source", kind: "replays", directory: "C:\\fixture" });
  replay = observe("replay", hash);
});
afterEach(() => {
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(database + suffix)) unlinkSync(database + suffix);
  rmdirSync(folder);
});
function observe(key: string, sha256: string | null) {
  return store.upsertObservation({ sourceId: "source", sourceKey: key, locator: key, sha256,
    available: sha256 !== null, generation: store.beginScan("source"), addedAt: 1, metadata: {} });
}

it("persists faster processing separately while preserving legacy settings and completed cache identities",()=>{
  const legacy={mode:"bg" as const,workers:4 as const,userPaused:false,pauseOnBattery:true};
  store.metrics.setAnalysisSettings(legacy);const ticket=claim(target());expect(store.metrics.commit(patch(ticket))).toBe("applied");
  const before=store.metrics.read(replay),db=store["db"],raw=db.prepare("SELECT value FROM settings WHERE key='analysis'").get()?.value;
  db.exec("CREATE TEMP TRIGGER protect_legacy_analysis BEFORE UPDATE ON settings WHEN OLD.key='analysis' BEGIN SELECT RAISE(FAIL,'legacy analysis rewrite'); END");
  store.metrics.setAnalysisSettings({...legacy,fasterProcessing:true});
  expect(db.prepare("SELECT value FROM settings WHERE key='analysis'").get()?.value).toBe(raw);
  expect(Object.keys(JSON.parse(String(raw))).sort()).toEqual(["mode","pauseOnBattery","userPaused","workers"]);
  expect(db.prepare("SELECT value FROM settings WHERE key='analysis-faster-processing'").get()?.value).toBe("true");
  expect(store.metrics.read(replay)).toEqual(before);expect(store.metrics.nextQueued()).toEqual([]);
  store.close();store=new LibraryStore(database,"faster-restart");
  expect(store.metrics.analysisSettings()).toEqual({...legacy,fasterProcessing:true});expect(store.metrics.read(replay)).toEqual(before);
  store.metrics.setAnalysisSettings({...legacy,userPaused:true});
  expect(store.metrics.analysisSettings()).toEqual({...legacy,userPaused:true,fasterProcessing:true});
  store.metrics.setAnalysisSettings({...legacy,fasterProcessing:false});expect(store.metrics.analysisSettings()).toEqual(legacy);
});

it("rejects malformed faster-processing values without resetting the legacy policy",()=>{
  const legacy=store.metrics.analysisSettings();
  expect(()=>store.metrics.setAnalysisSettings({...legacy,fasterProcessing:"yes"} as never)).toThrow(/settings/);
  expect(store.metrics.analysisSettings()).toEqual(legacy);
  store["db"].prepare("INSERT INTO settings VALUES('analysis-faster-processing',?)").run('"fast"');
  expect(()=>store.metrics.analysisSettings()).toThrow(/settings/);
});
function removePostSchema15Objects(db: DatabaseSync) {
  // Remove dependent triggers before their referenced C/query tables and columns.
  for (const type of ["trigger", "index", "table"]) {
    const objects = db.prepare("SELECT name FROM sqlite_master WHERE type=? AND (name GLOB 'query_*' OR name GLOB 'map_cleanup_*')").all(type);
    for (const object of objects) db.exec(`DROP ${type.toUpperCase()} "${String(object.name).replace(/"/g, '""')}"`);
  }
  db.exec(`DROP TABLE IF EXISTS resource_changes; DROP TABLE incident_source_epochs; DROP TABLE incident_location_epochs;
    DROP TABLE incident_recipes; ALTER TABLE metric_results DROP COLUMN strip_payload;`);
}

it("filters queue admission by implemented producer slots without changing other job states",()=>{
  const numerical=target(),incidents=target("C",replay,"incidents");store.metrics.request(numerical,"background");store.metrics.request(incidents,"open");
  expect(store.metrics.nextQueued(1,true,["numerical"])[0].target.slot).toBe("numerical");
  expect(store.metrics.read(replay).find(item=>item.target.slot==="incidents")?.job).toBeUndefined();
  expect(store.metrics.request(incidents,"retry")).toEqual({state:"disabled"});
  expect(()=>store.metrics.nextQueued(1,true,[])).toThrow();
});
it("retires old C jobs on restart and rejects delayed C publication without deleting cached payloads",()=>{
  const c=target("old-C",replay,"incidents"),db=store["db"];
  const ticket={...c,attempt:"old-attempt"};
  db.prepare("INSERT INTO metric_jobs VALUES('old-C-job',?,?,?,?,?,?,'background','running','old-attempt',NULL)")
    .run(replay,c.slot,c.stage,c.inputKey,c.producerVersion,c.generation);
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,?,?,?,?,?)")
    .run(replay,c.slot,c.stage,"older-C",c.producerVersion,JSON.stringify({fields:{incidentCount:{state:"known",value:2}},provenance:{}}));
  expect(store.metrics.isEligible(ticket)).toBe(false);
  expect(store.metrics.commit({ticket,producerVersion:ticket.producerVersion,fields:{incidentCount:{state:"known",value:1}},provenance:{}})).toBe("stale");
  expect(store.metrics.release(ticket)).toBe("stale");
  store.close();store=new LibraryStore(database,"retired-C");
  expect(store["db"].prepare("SELECT count(*) AS n FROM metric_jobs WHERE stage='C'").get()?.n).toBe(0);
  expect(store["db"].prepare("SELECT count(*) AS n FROM metric_results WHERE stage='C'").get()?.n).toBe(1);
  expect(store.metrics.request(c,"retry")).toEqual({state:"disabled"});
  expect(store.metrics.nextQueued()).toEqual([]);
});
it("rejects retired C callbacks before opening a writer transaction or reconciling S",()=>{
  const retired=target("old-C",replay,"incidents"),ticket={...retired,attempt:"old-attempt"};
  store["db"].prepare("INSERT INTO metric_jobs VALUES('retired-C-job',?,?,?,?,?,?,'background','queued',NULL,NULL)")
    .run(replay,retired.slot,retired.stage,retired.inputKey,retired.producerVersion,retired.generation);
  const transaction=jest.fn(),reconcile=jest.fn();
  const metrics=new LibraryMetricStore(store["db"],id=>id,work=>{transaction();return work();},undefined,reconcile);
  const result={fields:{incidentCount:{state:"known" as const,value:9}},provenance:{replaySha256:hash}};
  const patch={ticket,producerVersion:ticket.producerVersion,...result};
  expect(metrics.commit(patch)).toBe("stale");expect(metrics.commitInTransaction(patch)).toBe("stale");
  expect(metrics.release(ticket)).toBe("stale");expect(metrics.fail(ticket,"late failure")).toBe("stale");
  expect(metrics.publishObserved(retired,result)).toBe("stale");
  expect(metrics.publishObservedInTransaction(retired,result)).toBe("stale");
  expect(metrics.request(retired,"retry")).toEqual({state:"disabled"});
  expect(metrics.claim("retired-C-job")).toBeUndefined();expect(metrics.claimPreparedInTransaction(retired)).toEqual({state:"blocked"});
  expect(transaction).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled();
});
it("fences existing jobs and fresh requests after recorded mode becomes nonstandard",()=>{
  const numerical=target(),ticket=claim(numerical);
  store["db"].prepare("UPDATE replays SET metadata=? WHERE id=?").run(JSON.stringify({header:{mode:1}}),replay);
  expect(store.metrics.isEligible(ticket)).toBe(false);
  expect(store.metrics.commit(patch(ticket))).toBe("stale");
  store.metrics.release(ticket);
  expect(store.metrics.nextQueued()).toEqual([]);
  expect(store.metrics.request(numerical,"retry")).toEqual({state:"disabled"});
});
it.each([false,true])("rejects observed publication for an excluded identity without replacing its cached result, preserve=%s",preserve=>{
  const numerical=target(),db=store["db"];
  const prior={fields:{misses:{state:"known" as const,value:2}},provenance:{replaySha256:hash}};
  expect(store.metrics.publishObserved(numerical,prior)).toBe("applied");
  db.prepare("UPDATE locations SET metadata=? WHERE replay_id=?").run(JSON.stringify({nativeScore:{ruleset:3}}),replay);
  const incoming={fields:{misses:{state:"known" as const,value:0}},provenance:{replaySha256:hash}};
  expect(store.metrics.publishObservedInTransaction(numerical,incoming,preserve)).toBe("stale");
  expect(store.metrics.publishObserved(numerical,incoming)).toBe("stale");
  expect(store.metrics.read(replay).find(entry=>entry.target.slot==="numerical")?.result).toEqual(prior);
  expect(store.metrics.nextQueued()).toEqual([]);
});
function target(key = "A", id = replay, slot: LibraryMetricTarget["slot"] = "numerical") {
  return store.metrics.setTarget({ replayId: id, slot, stage: slot === "incidents" ? "C" : "S", inputKey: key, producerVersion: "test-v1" });
}
function clearMetrics(db: DatabaseSync, dirty: number[] = [], numerical: string[] = []) {
  return new LibraryMetricStore(db, id => id, work => work(), undefined, undefined,
    flags => dirty.push(flags), id => numerical.push(id));
}
function migrateClearFixture(db: DatabaseSync) {
  db.exec("CREATE TABLE replays(id TEXT PRIMARY KEY); CREATE TABLE counters(key TEXT PRIMARY KEY,value INTEGER); INSERT INTO replays VALUES('one'),('two');");
  LibraryMetricStore.migrate(db);
}
function seedClearFixture(db: DatabaseSync, id: string, slot: "incidents" | "numerical", withTarget = true) {
  const stage = slot === "incidents" ? "C" : "S";
  if (withTarget) db.prepare("INSERT INTO metric_targets VALUES(?,?,?,?,?,1)").run(id, slot, stage, "old", "test-v1");
  db.prepare("INSERT INTO metric_jobs VALUES(?,?,?,?,?, ?,1,'background','queued',NULL,NULL)")
    .run(id + slot, id, slot, stage, "old", "test-v1");
}
it("lazily reuses clear statements but still removes later stale targets and orphan jobs within their exact slot", () => {
  const db = new DatabaseSync(":memory:"), dirty: number[] = [], numerical: string[] = [];
  const prepare = db.prepare.bind(db), prepared = new Set<string>();
  const spy = jest.spyOn(db, "prepare").mockImplementation(sql => {
    if (/^DELETE FROM metric_(targets|jobs) WHERE replay_id=\? AND slot=\?$/.test(sql)) {
      if (prepared.has(sql)) throw Error("Repeated clear statement preparation");
      prepared.add(sql);
    }
    return prepare(sql);
  });
  try {
    // Construction precedes migration: statement ownership must stay lazy.
    const metrics = clearMetrics(db, dirty, numerical);
    migrateClearFixture(db);
    metrics.clearTargetInTransaction("one", "incidents");
    expect(dirty).toEqual([]); expect(numerical).toEqual([]);
    seedClearFixture(db, "one", "incidents"); seedClearFixture(db, "two", "incidents");
    seedClearFixture(db, "one", "numerical");
    db.exec("INSERT INTO metric_results VALUES('one','incidents','C','old','test-v1','retained-cache')");
    metrics.clearTargetInTransaction("one", "incidents");
    expect(db.prepare("SELECT replay_id,slot FROM metric_targets ORDER BY replay_id,slot").all())
      .toEqual([{ replay_id: "one", slot: "numerical" }, { replay_id: "two", slot: "incidents" }]);
    expect(db.prepare("SELECT replay_id,slot FROM metric_jobs ORDER BY replay_id,slot").all())
      .toEqual([{ replay_id: "one", slot: "numerical" }, { replay_id: "two", slot: "incidents" }]);
    seedClearFixture(db, "one", "incidents", false);
    metrics.clearTargetInTransaction("one", "incidents");
    expect(db.prepare("SELECT 1 FROM metric_jobs WHERE replay_id='one' AND slot='incidents'").get()).toBeUndefined();
    expect(db.prepare("SELECT payload FROM metric_results").get()?.payload).toBe("retained-cache");
    expect(dirty).toEqual([4]); expect(numerical).toEqual([]);
    metrics.clearTargetInTransaction("one", "numerical");
    metrics.clearTargetInTransaction("one", "numerical");
    expect(dirty).toEqual([4, 4]); expect(numerical).toEqual(["one"]);
  } finally { spy.mockRestore(); db.close(); }
});
it("retains clear atomicity on job-delete failure and reuses statements for retry and a reopened connection", () => {
  const path = join(folder, "clear.sqlite");
  let db = new DatabaseSync(path);
  try {
    migrateClearFixture(db); const dirty: number[] = [], numerical: string[] = [];
    const metrics = clearMetrics(db, dirty, numerical);
    seedClearFixture(db, "one", "numerical");
    db.exec("CREATE TRIGGER fail_clear BEFORE DELETE ON metric_jobs BEGIN SELECT RAISE(ABORT,'injected clear failure'); END;");
    // The caller owns the transaction; fail after target deletion but before job deletion.
    db.exec("BEGIN IMMEDIATE");
    try { expect(() => metrics.clearTargetInTransaction("one", "numerical")).toThrow("injected clear failure"); }
    finally { db.exec("ROLLBACK"); }
    expect(db.prepare("SELECT count(*) AS n FROM metric_targets WHERE replay_id='one'").get()?.n).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM metric_jobs WHERE replay_id='one'").get()?.n).toBe(1);
    expect(dirty).toEqual([]); expect(numerical).toEqual([]);
    db.exec("DROP TRIGGER fail_clear; BEGIN IMMEDIATE");
    metrics.clearTargetInTransaction("one", "numerical"); db.exec("COMMIT");
    expect(dirty).toEqual([4]); expect(numerical).toEqual(["one"]);
    db.close(); db = new DatabaseSync(path);
    const reopened = clearMetrics(db);
    seedClearFixture(db, "one", "incidents"); reopened.clearTargetInTransaction("one", "incidents");
    expect(db.prepare("SELECT count(*) AS n FROM metric_targets").get()?.n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM metric_jobs").get()?.n).toBe(0);
  } finally {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
});
it("keeps simultaneously live connections' clear statements and rows independent", () => {
  const first = new DatabaseSync(":memory:"), second = new DatabaseSync(":memory:");
  try {
    migrateClearFixture(first); migrateClearFixture(second);
    const a = clearMetrics(first), b = clearMetrics(second);
    seedClearFixture(first, "one", "incidents"); seedClearFixture(second, "one", "incidents");
    a.clearTargetInTransaction("one", "incidents");
    expect(second.prepare("SELECT count(*) AS n FROM metric_targets").get()?.n).toBe(1);
    b.clearTargetInTransaction("one", "incidents");
    seedClearFixture(first, "one", "incidents", false);
    a.clearTargetInTransaction("one", "incidents");
    expect(first.prepare("SELECT count(*) AS n FROM metric_jobs").get()?.n).toBe(0);
    expect(second.prepare("SELECT count(*) AS n FROM metric_jobs").get()?.n).toBe(0);
  } finally { first.close(); second.close(); }
});
it("keeps retired incident caches inert when numerical identity changes", () => {
  const numerical = target("c".repeat(64)); store.metrics.commit(patch(claim(numerical)));
  const incidents = target("historical", replay, "incidents");
  expect(store.metrics.request(incidents, "selection")).toEqual({state:"disabled"});
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec("BEGIN IMMEDIATE");
  try { store.metrics.clearTargetInTransaction(replay, "numerical"); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
  expect(store.metrics.readTarget(replay, "numerical")).toBeUndefined();
  expect(db.prepare("SELECT 1 FROM metric_jobs WHERE replay_id=? AND slot='incidents'").get(replay)).toBeUndefined();
  expect(db.prepare("SELECT count(*) AS n FROM metric_results WHERE replay_id=? AND slot='numerical'").get(replay)?.n).toBe(1);
});
it("reads an exact dependency target through aliases without touching result or job storage",()=>{
  const alias=observe("target-alias",null);observe("target-alias",hash);
  const expected=target();
  const db=(store as unknown as {db:DatabaseSync}).db,prepare=db.prepare.bind(db);
  const spy=jest.spyOn(db,"prepare").mockImplementation(sql=>{
    if(/\bmetric_(results|jobs)\b/.test(sql))throw Error("Target identity must not hydrate cached values or jobs");
    return prepare(sql);
  });
  try{
    expect(store.metrics.readTarget(replay,"numerical")).toEqual(expected);
    expect(store.metrics.readTarget(alias,"numerical")).toEqual(expected);
    expect(store.metrics.readTarget(replay,"incidents")).toBeUndefined();
    expect(()=>store.metrics.readTarget("nonexistent","numerical")).toThrow("Unknown replay identity");
  }finally{spy.mockRestore();}
});
function claim(head: LibraryMetricTarget, reason: "open" | "retry" = "open"): LibraryMetricTicket {
  const job = store.metrics.request(head, reason);
  if (!("id" in job)) throw new Error("Expected queued job");
  const ticket = store.metrics.claim(job.id);
  if (!ticket) throw new Error("Expected claim");
  return ticket;
}
function patch(ticket: LibraryMetricTicket, value = 3): LibraryMetricPatch {
  return { ticket, producerVersion: "test-v1", fields: { misses: { state: "known", value } },
    provenance: { replaySha256: hash, projectionVersion: "test-v1", completeBreakEvidence: false } };
}
const strip=()=>({state:"known" as const,value:{version:1 as const,timeBasis:"map-ms" as const,ruleset:"stable" as const,
  mapStartMs:1000,mapEndMs:3000,evaluatedThrough:1980,endpointBasis:"recorded-end" as const,synthesizedEndpoint:false,
  ok:[2000],meh:[],miss:[],sliderBreak:[],sliderEndMiss:[]}});
function releasedPrefixResult(samples=3):LibraryMetricResult {
  const errorStrip=strip();errorStrip.value.ok=[];
  return {fields:{completion:{state:"unknown",reason:"completion-not-established"},
    ur:samples?{state:"known",value:12}:{state:"unknown",reason:"no-valid-timing-samples"},
    biasMs:samples?{state:"known",value:3}:{state:"unknown",reason:"no-valid-timing-samples"},
    sampleCount:{state:"known",value:samples},fc:{state:"unknown",reason:"completion-unavailable"}},
    provenance:{replaySha256:hash,mapSha256:"b".repeat(64),mapMd5:"c".repeat(32),ruleset:"stable",
      projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,scoreOrigin:"reconstructed",completionEvidence:"source-domain-coverage-v1",
      sourceCoverageEvidence:"stable-released-prefix-v1",coverageQualified:true,completeBreakEvidence:false,completeAccuracyEvidence:false,rate:1},errorStrip};
}
it.each([["stable-released-prefix-v1",3],["stable-released-prefix-v1",0],["stable-neutral-multi-reset-v1",3],["stable-neutral-multi-reset-v1",0],["stable-initial-negative-v1",3],["native-initial-held-release-v1",0],["stable-neutral-later-reset-v1",3],["stable-neutral-later-reset-v1",0]] as const)(
  "persists %s numerical provenance through the real handoff and strip read with %s timing samples",(evidence,samples)=>{
  const head=store.metrics.setTarget({replayId:replay,slot:"numerical",stage:"S",inputKey:"released-prefix",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
  const ticket=claim(head),result=releasedPrefixResult(samples);
  result.provenance.sourceCoverageEvidence=evidence;
  if(evidence==="native-initial-held-release-v1"){result.provenance.ruleset="lazer";delete result.errorStrip;}
  const handoff=store.metrics.commitAndClaimTimeline({ticket,producerVersion:ticket.producerVersion,...result});
  expect(handoff.state).toBe("claimed");
  expect(store.metrics.read(replay).find(entry=>entry.target.slot==="numerical")?.result).toEqual({fields:result.fields,provenance:result.provenance});
  expect(store.metrics.readErrorStrip(replay)?.result).toEqual(result.errorStrip);
  expect(store.metrics.read(replay).find(entry=>entry.target.slot==="numerical")?.job).toBeUndefined();
  store.close();store=new LibraryStore(database,"prefix-restart");
  expect(store.metrics.read(replay).find(entry=>entry.target.slot==="numerical")?.result?.provenance).toEqual(result.provenance);
  expect(store.metrics.readErrorStrip(replay)?.result).toEqual(result.errorStrip);
});
it.each(["stable-released-prefix-v1","stable-neutral-multi-reset-v1","stable-initial-negative-v1","native-initial-held-release-v1","stable-neutral-later-reset-v1"].flatMap(evidence=>[
  "marker","empty","number","null","object","array","slot","P-stage","H-stage","target-version","projection-version",
  "ruleset","origin","domain","unqualified","missing-qualified","unknown-key"].map(fault=>[evidence,fault])))(
  "rejects invalid %s provenance atomically: %s",(evidence,fault)=>{
  const result=releasedPrefixResult();let slot:LibraryMetricTarget["slot"]="numerical",stage:LibraryMetricTarget["stage"]="S",version=LIBRARY_NUMERIC_PROJECTION_VERSION;
  result.provenance.sourceCoverageEvidence=evidence;
  if(evidence==="native-initial-held-release-v1"){result.provenance.ruleset="lazer";delete result.errorStrip;}
  if(fault==="marker")result.provenance.sourceCoverageEvidence="stable-released-prefix-v2";
  if(fault==="empty")result.provenance.sourceCoverageEvidence="";
  if(fault==="number")result.provenance.sourceCoverageEvidence=1;
  if(fault==="null")result.provenance.sourceCoverageEvidence=null;
  if(fault==="object")result.provenance.sourceCoverageEvidence={} as never;
  if(fault==="array")result.provenance.sourceCoverageEvidence=[] as never;
  if(fault==="slot"){slot="timeline-pp";result.fields={peakPp:{state:"known",value:1}};delete result.errorStrip;}
  if(fault==="P-stage"){slot="fc-pp";stage="P";result.fields={ppIfFc:{state:"known",value:1}};delete result.errorStrip;}
  if(fault==="H-stage"){slot="source-score";stage="H";result.fields={misses:{state:"known",value:1}};delete result.errorStrip;}
  if(fault==="target-version")version="library-numeric-v5";
  if(fault==="projection-version")result.provenance.projectionVersion="library-numeric-v5";
  if(fault==="ruleset")result.provenance.ruleset=evidence==="native-initial-held-release-v1"?"stable":"lazer";
  if(fault==="origin")result.provenance.scoreOrigin="recorded";
  if(fault==="domain")result.provenance.completionEvidence="other-domain";
  if(fault==="unqualified")result.provenance.coverageQualified=false;
  if(fault==="missing-qualified")delete result.provenance.coverageQualified;
  if(fault==="unknown-key")result.provenance.arbitraryEvidence="stable-released-prefix-v1";
  const head=store.metrics.setTarget({replayId:replay,slot,stage,inputKey:"invalid-prefix",producerVersion:version}),before=metricRows();
  expect(()=>store.metrics.publishObserved(head,result)).toThrow("Invalid library metric payload");
  expect(metricRows()).toBe(before);expect(store.metrics.readErrorStrip(replay)?.result).toBeUndefined();
});
it("keeps marker-absent legacy numerical handoff payloads unchanged",()=>{
  const head=store.metrics.setTarget({replayId:replay,slot:"numerical",stage:"S",inputKey:"legacy-qualified",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
  const ticket=claim(head),result=releasedPrefixResult();delete result.provenance.sourceCoverageEvidence;
  expect(store.metrics.commitAndClaimTimeline({ticket,producerVersion:ticket.producerVersion,...result}).state).toBe("claimed");
  expect(store.metrics.read(replay).find(entry=>entry.target.slot==="numerical")?.result).toEqual({fields:result.fields,provenance:result.provenance});
  expect(store.metrics.readErrorStrip(replay)?.result).toEqual(result.errorStrip);
});
it("stores bounded strip separately, atomically hands off and preserves it across Off/restart",()=>{
  const ticket=claim(target()),value=strip();
  expect(store.metrics.commitAndClaimTimeline({...patch(ticket),errorStrip:value}).state).toBe("claimed");
  expect(store.metrics.readErrorStrip(replay)?.result).toEqual(value);
  expect(JSON.stringify(store.metrics.read(replay))).not.toContain("errorStrip");
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});store.close();store=new LibraryStore(database,"restart");
  expect(store.metrics.readErrorStrip(replay)?.result).toEqual(value);expect(store.metrics.nextQueued()).toEqual([]);
  target("changed");expect(store.metrics.readErrorStrip(replay)?.result).toBeUndefined();
  expect(store.metrics.commit({...patch(ticket),errorStrip:value})).toBe("stale");
});
it("rejects over-budget and cause-bearing strips without persisting scalars",()=>{
  const ticket=claim(target());
  const invalids=[{...strip(),value:{...strip().value,ok:Array(5000).fill(Number.MAX_SAFE_INTEGER)}},
    {...strip(),value:{...strip().value,cause:"aim"}},
    {...strip(),value:{...strip().value,ok:[NaN]}},
    {...strip(),value:{...strip().value,ok:new Array(3)}}];
  for(const errorStrip of invalids)expect(()=>store.metrics.commit({...patch(ticket),errorStrip})).toThrow(/strip/);
  expect(store.metrics.read(replay).find(e=>e.target.slot==="numerical")?.result).toBeUndefined();
  const value=strip();value.value.ok=Array(2048).fill(1000);
  expect(store.metrics.commit({...patch(ticket),errorStrip:value})).toBe("applied");
});
it("rolls strip and scalar publication back together on failed timeline admission",()=>{
  const ticket=claim(target()),fault=new DatabaseSync(database);
  try{fault.exec("CREATE TRIGGER fail_strip_timeline BEFORE INSERT ON metric_targets WHEN NEW.slot='timeline-pp' BEGIN SELECT RAISE(ABORT,'injected strip'); END;");
    expect(()=>store.metrics.commitAndClaimTimeline({...patch(ticket),errorStrip:strip()})).toThrow("injected strip");
    expect(store.metrics.readErrorStrip(replay)?.result).toBeUndefined();expect(store.metrics.isEligible(ticket)).toBe(true);
  }finally{fault.close();}
});
it("migrates schema15 without inventing known-empty strips",()=>{
  store.metrics.commit(patch(claim(target())));store.close();const prior=new DatabaseSync(database);
  try { removePostSchema15Objects(prior); prior.exec("PRAGMA user_version=15;"); } finally { prior.close(); }
  store=new LibraryStore(database,"migration");expect(store.metrics.readErrorStrip(replay)?.result).toBeUndefined();
  expect(store.metrics.read(replay)[0].result?.fields.misses).toEqual({state:"known",value:3});
});
it("carries strip with an exact alias cache entry and keeps passive reads independent of analysis",()=>{
  const alias=observe("alias",null),ticket=claim(target("alias",alias));
  store.metrics.commit({...patch(ticket),errorStrip:strip()});observe("alias",hash);
  const api=new LibraryMetricApi(store.metrics),before=store.metrics.nextQueued();
  expect(api.receive("metric-strip-read",{replayId:alias})).toMatchObject({target:{replayId:replay},result:strip()});
  expect(api.receive("metric-strip-read",{replayId:replay})).toMatchObject({result:strip()});
  expect(store.metrics.nextQueued()).toEqual(before);
  const newTarget=target("unknown");store.metrics.commit({...patch(claim(newTarget)),errorStrip:{state:"unknown",reason:"strip-size-limit"}});
  expect(store.metrics.readErrorStrip(replay)?.result).toEqual({state:"unknown",reason:"strip-size-limit"});
});
it("atomically saves numerical and transfers the same reservation to a distinct timeline attempt",()=>{
  const ticket=claim(target()),next=store.metrics.commitAndClaimTimeline(patch(ticket));
  expect(next.state).toBe("claimed");if(next.state!=="claimed")throw Error("not claimed");
  expect(store.metrics.read(replay).find(e=>e.target.slot==="numerical")?.result?.fields.misses).toEqual({state:"known",value:3});
  expect(next.ticket).toMatchObject(libraryTimelineTarget(ticket));expect(store.metrics.isEligible(ticket)).toBe(false);
  expect(store.metrics.isEligible(next.ticket)).toBe(true);expect(store.metrics.nextQueued()).toEqual([]);
  store.metrics.fail(next.ticket,"native failure");
  expect(store.metrics.read(replay).find(e=>e.target.slot==="numerical")?.result).toBeDefined();
  expect(store.metrics.commitAndClaimTimeline(patch(ticket))).toEqual({state:"stale"});
});
function completedNumerical(){
  const ticket=claim(target("c".repeat(64)));const result=store.metrics.commitAndClaimTimeline({...patch(ticket),
    fields:{completion:{state:"known",value:"passed"}},provenance:{replaySha256:hash,coverageQualified:true}});
  if(result.state!=="claimed")throw Error("Expected timeline");return{numerical:ticket,timeline:result.ticket};
}
it.each([false,true])("terminates completed or failed FC while retaining numerical and timeline, failed=%s",failed=>{
  const {timeline}=completedNumerical();
  const fc=store.metrics.finishTimelineAndClaimFc(timeline,{metrics:{fields:{peakPp:{state:"known",value:9}},provenance:{}}});
  if(fc.state!=="claimed")throw Error("missing FC");
  const c=store.metrics.finishFcAndClaimIncidents(fc.ticket,failed?{error:"FC unavailable"}:{metrics:{fields:{ppIfFc:{state:"known",value:10}},provenance:{}}});
  expect(c).toEqual({state:"cached"});
  expect(store.metrics.nextQueued().some(job=>job.target.slot==="incidents")).toBe(false);
  expect(store.metrics.read(replay).find(entry=>entry.target.slot==="numerical")?.result).toBeDefined();
  expect(store.metrics.read(replay).find(entry=>entry.target.slot==="timeline-pp")?.result?.fields.peakPp).toEqual({state:"known",value:9});
  const saved=store.metrics.read(replay).find(entry=>entry.target.slot==="fc-pp");
  if(failed)expect(saved?.job).toMatchObject({state:"failed",error:"FC unavailable"});
  else expect(saved?.result?.fields.ppIfFc).toEqual({state:"known",value:10});
});
it("terminates after timeline when valid P FC already exists",()=>{
  const p=store.metrics.setTarget({replayId:replay,slot:"fc-pp",stage:"P",inputKey:"p",producerVersion:"p-v1"});
  store.metrics.publishObserved(p,{fields:{ppIfFc:{state:"known",value:0}},provenance:{}});
  const {timeline}=completedNumerical();
  const next=store.metrics.finishTimelineAndClaimFc(timeline,{error:"native timeline unavailable"});
  expect(next).toEqual({state:"cached"});
  expect(store.metrics.read(replay).find(entry=>entry.target.slot==="fc-pp")?.result?.fields.ppIfFc).toEqual({state:"known",value:0});
});
it.each([false,true])("hands timeline completion/failure to independent reconstructed FC, failed=%s",failed=>{
  const {numerical,timeline}=completedNumerical();
  const result=store.metrics.finishTimelineAndClaimFc(timeline,failed?{error:"timeline oversized"}:{metrics:{fields:{peakPp:{state:"known",value:9}},provenance:{}}});
  expect(result.state).toBe("claimed");if(result.state!=="claimed")throw Error("Missing FC");
  expect(result.ticket).toMatchObject(libraryFcTarget(numerical));expect(store.metrics.isEligible(timeline)).toBe(false);
  expect(store.metrics.read(replay).find(e=>e.target.slot==="timeline-pp")?.job?.state).toBe(failed?"failed":undefined);
  expect(store.metrics.read(replay).find(e=>e.target.slot==="numerical")?.result).toBeDefined();
});
it.each([0,80,"not-applicable"] as const)("preserves P FC %s when timeline finishes",value=>{
  const p=store.metrics.setTarget({replayId:replay,slot:"fc-pp",stage:"P",inputKey:"p",producerVersion:"p-v1"});
  store.metrics.publishObserved(p,{fields:{ppIfFc:typeof value==="number"?{state:"known",value}:{state:"not-applicable",reason:"unsupported"}},provenance:{}});
  const {timeline}=completedNumerical();
  expect(store.metrics.finishTimelineAndClaimFc(timeline,{metrics:{fields:{peakPp:{state:"known",value:9}},provenance:{}}})).toEqual({state:"cached"});
  expect(store.metrics.read(replay).find(e=>e.target.slot==="fc-pp")?.target).toEqual(p);
});
it("retains atomic ownership when FC target creation fails and honors Off",()=>{
  const {timeline}=completedNumerical(),fault=new DatabaseSync(database);
  try{fault.exec("CREATE TRIGGER fail_fc BEFORE INSERT ON metric_targets WHEN NEW.slot='fc-pp' BEGIN SELECT RAISE(ABORT,'injected FC'); END;");
    expect(()=>store.metrics.finishTimelineAndClaimFc(timeline,{error:"size"})).toThrow("injected FC");expect(store.metrics.isEligible(timeline)).toBe(true);
  }finally{fault.close();}
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});
  expect(store.metrics.finishTimelineAndClaimFc(timeline,{error:"size"})).toEqual({state:"stale"});
});
it("does not race a queued FC fallback against its retained timeline owner",()=>{
  const {numerical,timeline}=completedNumerical(),fc=store.metrics.setTarget(libraryFcTarget(numerical));
  const request=store.metrics.request(fc,"background");if(!("id"in request))throw Error("Missing FC job");
  expect(store.metrics.nextQueued().some(job=>job.target.slot==="fc-pp")).toBe(false);
  expect(store.metrics.claim(request.id)).toBeUndefined();
  expect(store.metrics.finishTimelineAndClaimFc(timeline,{error:"size"}).state).toBe("claimed");
});
it("keeps publication atomic on derived target failure",()=>{
  const ticket=claim(target()),fault=new DatabaseSync(database);
  try{fault.exec("CREATE TRIGGER fail_timeline BEFORE INSERT ON metric_targets WHEN NEW.slot='timeline-pp' BEGIN SELECT RAISE(ABORT,'injected'); END;");
    expect(()=>store.metrics.commitAndClaimTimeline(patch(ticket))).toThrow("injected");
    expect(store.metrics.isEligible(ticket)).toBe(true);expect(store.metrics.read(replay).find(e=>e.target.slot==="numerical")?.result).toBeUndefined();
  }finally{fault.close();}
});
it("does not claim timeline when Pause or Off wins publication",()=>{
  const ticket=claim(target());store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:true});
  expect(store.metrics.commitAndClaimTimeline(patch(ticket))).toEqual({state:"blocked"});
  expect(store.metrics.read(replay).find(e=>e.target.slot==="numerical")?.result).toBeDefined();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:false,mode:"off"});
  expect(store.metrics.commitAndClaimTimeline(patch(ticket))).toEqual({state:"stale"});expect(store.metrics.nextQueued()).toEqual([]);
});
it("does not run a dependent timeline alongside its unfinished numerical job",()=>{
  const numerical=target(),dependent=store.metrics.setTarget(libraryTimelineTarget(numerical));
  store.metrics.request(numerical,"open");const request=store.metrics.request(dependent,"open");if(!("id"in request))throw Error("missing timeline job");
  expect(store.metrics.nextQueued().map(job=>job.target.slot)).toEqual(["numerical"]);
  expect(store.metrics.claim(request.id)).toBeUndefined();
});

it("persists results across restart, source loss and Off without reads creating jobs", () => {
  const head = target(); const ticket = claim(head);
  expect(store.metrics.commit(patch(ticket))).toBe("applied");
  store.metrics.clearUnfinishedAnalysisJobs(); store.setSourceEnabled("source", false);
  store.close(); store = new LibraryStore(database, "two");
  for (let i = 0; i < 3; i++) expect(store.metrics.read(replay)[0]).toMatchObject({
    target: head, result: { fields: { misses: { state: "known", value: 3 } } }, job: undefined,
  });
  expect(store.metrics.request(head, "background")).toEqual({ state: "cached" });
});

it("invalidates A→B→A attempts while reusing only completed compatible caches", () => {
  const first = target(); const oldTicket = claim(first);
  const b = target("B"); expect(b.generation).toBeGreaterThan(first.generation);
  const again = target(); expect(again.generation).toBeGreaterThan(b.generation);
  expect(store.metrics.commit(patch(oldTicket))).toBe("stale");
  expect(store.metrics.fail(oldTicket, "old-failure")).toBe("stale");
  expect(store.metrics.read(replay)[0].result).toBeUndefined();
  expect(store.metrics.commit(patch(claim(again)))).toBe("applied");
  target("B"); const reused = target();
  expect(store.metrics.read(replay)[0].result?.fields.misses).toEqual({ state: "known", value: 3 });
  expect(store.metrics.request(reused, "open")).toEqual({ state: "cached" });
  expect(store.metrics.commit(patch(oldTicket, 9))).toBe("stale");
});

it("requires explicit retry after failure and rejects prior attempts", () => {
  const head = target(); const oldTicket = claim(head);
  expect(store.metrics.fail(oldTicket, "map-missing")).toBe("applied");
  expect(store.metrics.request(head, "open")).toMatchObject({ state: "failed", error: "map-missing" });
  const ticket = claim(head, "retry"); expect(ticket.attempt).not.toBe(oldTicket.attempt);
  expect(store.metrics.fail(oldTicket, "late")).toBe("stale");
  expect(store.metrics.commit(patch(oldTicket))).toBe("stale");
  expect(store.metrics.commit(patch(ticket))).toBe("applied");
  expect(store.metrics.commit(patch(ticket, 10))).toBe("stale");
});

it("requeues restart jobs with fresh attempt ownership and never revives a running attempt", () => {
  const head = target(); const old = claim(head);
  store.close(); store = new LibraryStore(database, "two");
  expect(store.metrics.read(replay)[0].job?.state).toBe("queued");
  expect(store.metrics.claim(old.attempt)).toBeUndefined();
  expect(store.metrics.commit(patch(old))).toBe("stale");
  const ticket = claim(head);
  expect(store.metrics.commit(patch(ticket))).toBe("applied");
});

it("Off clears unfinished S/C jobs recovered after restart", () => {
  const old = claim(target());
  store.close(); store = new LibraryStore(database, "two");
  store.metrics.clearUnfinishedAnalysisJobs();
  expect(store.metrics.read(replay)[0].job).toBeUndefined();
  expect(store.metrics.commit(patch(old))).toBe("stale");
});

it.each(["A", "B"])("merge retires queued exact-cache jobs while preserving other input keys (%s)", key => {
  const alias = observe("other", null); store.metrics.commit(patch(claim(target("A", alias))));
  const canonical = target(key); const queued = store.metrics.request(canonical, "background");
  if (!("id" in queued)) throw new Error("Expected queue");
  observe("other", hash);
  const claimed = store.metrics.claim(queued.id);
  if (key === "A") expect(claimed).toBeUndefined();
  else expect(claimed?.inputKey).toBe("B");
});

it("Off drops unfinished S/C jobs only and retains failed state and completed H/P/S/C values", () => {
  const completed=target("c".repeat(64));store.metrics.commit(patch(claim(completed)));
  const cause=target("historical",replay,"incidents");
  const db=(store as unknown as {db:DatabaseSync}).db;
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,?,?,?,?,?)")
    .run(replay,cause.slot,cause.stage,cause.inputKey,cause.producerVersion,JSON.stringify({fields:{incidentCount:{state:"known",value:2}},provenance:{}}));
  const unfinished=observe("unfinished","d".repeat(64)),numeric=target("pending",unfinished),ticket=claim(numeric);
  const p = store.metrics.setTarget({ replayId: replay, slot: "aggregate-pp", stage: "P", inputKey: "p", producerVersion: "test-v1" });
  const pj = store.metrics.request(p, "selection");
  store.metrics.clearUnfinishedAnalysisJobs();
  expect(store.metrics.commit(patch(ticket))).toBe("stale");
  expect(store.metrics.read(replay).find(r => r.target.slot === "aggregate-pp")?.job).toEqual(pj);
  expect(store.metrics.read(replay).find(r => r.target.slot === "incidents")?.result).toBeDefined();
  const failure = claim(numeric); store.metrics.fail(failure, "missing-evidence"); store.metrics.clearUnfinishedAnalysisJobs();
  expect(store.metrics.read(unfinished).find(r => r.target.slot === "numerical")?.job?.state).toBe("failed");
});

it("invalidates only the changed slot and producer; unknown does not become zero", () => {
  const numeric = target(); store.metrics.commit(patch(claim(numeric)));
  const c = target("cause-v1", replay, "incidents");
  store.metrics.publishObserved(c,{fields:{incidentCount:{state:"unknown",reason:"evidence-unavailable"}},provenance:{}});
  target("cause-v2", replay, "incidents");
  expect(store.metrics.read(replay).find(r => r.target.slot === "numerical")?.result).toBeDefined();
  expect(store.metrics.read(replay).find(r => r.target.slot === "incidents")?.result).toBeUndefined();
  store.metrics.setTarget({ ...numeric, producerVersion: "test-v2" });
  expect(store.metrics.read(replay).find(r => r.target.slot === "numerical")?.result).toBeUndefined();
});

it("publishes observed metrics against a target without scheduling a job and supersedes an old worker", () => {
  const head = target(); const old = claim(head);
  const { fields, provenance } = patch(old);
  expect(store.metrics.publishObserved(head, { fields, provenance })).toBe("applied");
  expect(store.metrics.read(replay)[0].job).toBeUndefined();
  expect(store.metrics.commit(patch(old, 7))).toBe("stale");
  target("B"); expect(store.metrics.publishObserved(head, { fields, provenance })).toBe("stale");
});

it("merges caches atomically, preserves canonical conflicts and rejects alias-origin tickets", () => {
  const alias = observe("provisional", null); const ah = target("A", alias);
  store.metrics.commit(patch(claim(ah), 8));
  const ch = target(); store.metrics.commit(patch(claim(ch), 3));
  const extra = store.metrics.setTarget({replayId:alias,slot:"aggregate-pp",stage:"P",inputKey:"source-only",producerVersion:"test-v1"}); const pending = claim(extra);
  observe("provisional", hash);
  expect(store.resolveId(alias)).toBe(replay);
  const rows = store.metrics.read(alias);
  expect(rows.find(r => r.target.slot === "numerical")?.result?.fields.misses).toEqual({ state: "known", value: 3 });
  const adopted = rows.find(r => r.target.slot === "aggregate-pp");
  expect(adopted?.target.replayId).toBe(replay); expect(adopted?.target.generation).toBeGreaterThan(extra.generation);
  expect(adopted?.job).toBeUndefined();
  expect(store.metrics.fail(pending, "late")).toBe("stale");
  expect(store.metrics.commit({ ...patch(pending), fields: { pp: { state: "known", value: 2 } } })).toBe("stale");
  expect(store.metrics.read(alias)).toEqual(store.metrics.read(replay));
});

it("rolls back cache insertion when job completion fails", () => {
  const head = target(); const ticket = claim(head);
  const fault = new DatabaseSync(database);
  fault.exec("CREATE TRIGGER fail_metric_completion BEFORE DELETE ON metric_jobs BEGIN SELECT RAISE(ABORT, 'injected completion fault'); END;");
  expect(() => store.metrics.commit(patch(ticket))).toThrow("injected completion fault");
  expect(store.metrics.read(replay)[0].result).toBeUndefined();
  expect(store.metrics.read(replay)[0].job?.state).toBe("running");
  fault.exec("DROP TRIGGER fail_metric_completion"); fault.close();
  expect(store.metrics.commit(patch(ticket))).toBe("applied");
});

it("accepts exact replay provenance without scanning contents by replay identity", () => {
  const head=target(),db=(store.metrics as unknown as {db:DatabaseSync}).db;
  const prepare=jest.spyOn(db,"prepare");
  try {
    expect(store.metrics.publishObserved(head,{fields:{misses:{state:"known",value:3}},provenance:{replaySha256:hash}})).toBe("applied");
    expect(prepare.mock.calls.some(([sql])=>sql==="SELECT 1 FROM contents WHERE replay_id=?")).toBe(false);
    expect(store.metrics.read(replay)[0].result?.fields.misses).toEqual({state:"known",value:3});
  } finally {prepare.mockRestore();}
});

it.each(["unspecified","provisional","different-content","other-replay","additional-content"] as const)(
  "preserves observed identity qualification for %s", scenario => {
    const otherHash="b".repeat(64);
    let id=replay,sha:string|undefined=otherHash;
    if(scenario==="unspecified")sha=undefined;
    if(scenario==="provisional")id=observe("provisional-identity",null);
    if(scenario==="other-replay")observe("other-identity",otherHash);
    if(scenario==="additional-content"){
      const db=new DatabaseSync(database);try{db.prepare("INSERT INTO contents VALUES(?,?)").run(otherHash,replay);}finally{db.close();}
    }
    const head=target("identity",id),result:LibraryMetricResult={fields:{misses:{state:"known",value:3}},
      provenance:sha===undefined?{}:{replaySha256:sha}};
    if(scenario==="different-content"||scenario==="other-replay"){
      expect(()=>store.metrics.publishObserved(head,result)).toThrow(/identity/i);
      expect(store.metrics.read(id)[0].result).toBeUndefined();
    }else{
      expect(store.metrics.publishObserved(head,result)).toBe("applied");
      expect(store.metrics.read(id)[0].result?.fields.misses).toEqual(result.fields.misses);
    }
  });

it("rejects publication for different known replay bytes and never transfers incompatible provisional caches", () => {
  const head = target(); const ticket = claim(head);
  const wrong = { ...patch(ticket), provenance: { replaySha256: "b".repeat(64) } };
  expect(() => store.metrics.commit(wrong)).toThrow(/identity/i);
  expect(() => store.metrics.publishObserved(head, { fields: wrong.fields, provenance: wrong.provenance })).toThrow(/identity/i);
  const alias = observe("other", null); const provisional = target("wrong-content", alias);
  const aliasedPatch = { ...patch(claim(provisional)), provenance: wrong.provenance };
  store.metrics.commit(aliasedPatch);
  observe("other", hash);
  target("wrong-content");
  expect(store.metrics.read(replay)[0].result).toBeUndefined();
});

it("adopts compatible alias caches and retires redundant canonical jobs atomically", () => {
  const alias = observe("other", null); const provisional = target("A", alias);
  store.metrics.commit(patch(claim(provisional)));
  const canonical = target(); const pending = claim(canonical);
  observe("other", hash);
  expect(store.metrics.read(replay)[0]).toMatchObject({ target: canonical, result: expect.anything(), job: undefined });
  expect(store.metrics.commit(patch(pending, 99))).toBe("stale");
  expect(store.metrics.read(replay)[0].result?.provenance).toMatchObject({ replaySha256: hash, completeBreakEvidence: false });
});

it("migrates an existing schema9 database without losing user metadata", () => {
  store.setReview(replay, "reviewed"); store.close();
  const legacy = new DatabaseSync(database);
  try {
    removePostSchema15Objects(legacy);
    legacy.exec("DROP TABLE performance_scalar_cache; DROP TABLE performance_recipes; DROP TABLE performance_map_cache; DELETE FROM counters WHERE key IN ('performance-map-use','metric-generation','preparation-generation'); DROP TABLE numerical_recipes; DROP TABLE analysis_requests; DROP TABLE metric_jobs; DROP TABLE metric_results; DROP TABLE metric_targets; PRAGMA user_version=9;");
  } finally { legacy.close(); }
  store = new LibraryStore(database, "two");
  expect(store.getReplay(replay)?.review).toBe("reviewed");
  const head = target(); expect(store.metrics.commit(patch(claim(head)))).toBe("applied");
  expect(store.integrityCheck()).toBe("ok");
});

it.each([
  { fields: { misses: { state: "known", value: -1 } } },
  { fields: { accuracy: { state: "known", value: 1.1 } } },
  { fields: { ur: { state: "known", value: Infinity } } },
  { fields: { fc: { state: "known", value: 1 } } },
  { fields: { misses: { state: "unknown", reason: "missing", value: 0 } } },
  { fields: { errorCause: { state: "known", value: "aim" } } },
  { provenance: { events: "[]" } },
  { provenance: { projectionVersion: "x".repeat(20000) } },
])("rejects malformed/unbounded/cause payloads without changing jobs or cache: %j", bad => {
  const head = target(); const ticket = claim(head);
  expect(() => store.metrics.commit({ ...patch(ticket), ...bad } as unknown as LibraryMetricPatch)).toThrow(/metric/i);
  expect(store.metrics.read(replay)[0].result).toBeUndefined();
  expect(store.metrics.read(replay)[0].job?.state).toBe("running");
});

it("validates stages, provenance, request reasons and count boundaries", () => {
  expect(() => store.metrics.setTarget({ ...target(), stage: "C" })).toThrow(/metric/i);
  const head = target();
  expect(() => store.metrics.request(head, "sort" as "open")).toThrow(/metric/i);
  const ticket = claim(head);
  expect(() => store.metrics.commit({ ...patch(ticket), fields: { sampleCount: { state: "known", value: Number.MAX_SAFE_INTEGER + 1 } } })).toThrow(/metric/i);
  expect(store.metrics.commit({ ...patch(ticket), fields: { fc: { state: "unknown", reason: "missing-break-evidence" },
    ur: { state: "known", value: 0 }, biasMs: { state: "known", value: -3 }, sampleCount: { state: "known", value: 1 } } })).toBe("applied");
});

function pendingStripRepair(){
  const current=store.metrics.setTarget({replayId:replay,slot:"numerical",stage:"S",inputKey:"dense-current",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
  const result:LibraryMetricResult={...releasedPrefixResult(),errorStrip:{state:"unknown",reason:"strip-size-limit"}};
  store.metrics.publishObserved(current,result);
  expect(store["transaction"](()=>store.metrics.admitStripRepairInTransaction(replay))).toBe(true);
  const pending=store.metrics.readErrorStrip(replay)?.job;if(!pending)throw Error("Missing strip repair");
  return {current,result,pending};
}
it("forbids public cached repair admission and preserves scalar bytes on mismatch",()=>{
  const {current,result,pending}=pendingStripRepair(),api=new LibraryMetricApi(store.metrics);
  expect(()=>api.receive("metric-request",{target:current,reason:"strip-repair"})).toThrow(/payload/);
  expect(store.metrics.request(current,"retry")).toEqual({state:"cached"});
  const ticket=store.metrics.claim(pending.id);if(!ticket)throw Error("Missing claim");
  const before=store["db"].prepare("SELECT * FROM metric_results WHERE replay_id=? ORDER BY slot").all(replay);
  expect(()=>store.metrics.commitAndClaimTimeline({ticket,producerVersion:ticket.producerVersion,...result,
    fields:{...result.fields,ur:{state:"known",value:99}},errorStrip:strip()})).toThrow("Strip repair changed numerical scalars");
  expect(store["db"].prepare("SELECT * FROM metric_results WHERE replay_id=? ORDER BY slot").all(replay)).toEqual(before);
  expect(store.metrics.isEligible(ticket)).toBe(true);
});
it("fences stale repaired-input publication and preserves a concurrent better observed strip",()=>{
  const {current,result,pending}=pendingStripRepair(),ticket=store.metrics.claim(pending.id);if(!ticket)throw Error("Missing claim");
  const better=strip();better.value.ok=[42,42];store.metrics.publishObserved(current,{...result,errorStrip:better});
  expect(store.metrics.commitAndClaimTimeline({ticket,producerVersion:ticket.producerVersion,...result,errorStrip:strip()})).toEqual({state:"stale"});
  expect(store.metrics.readErrorStrip(replay)?.result).toEqual(better);
  store.metrics.setTarget({...current,inputKey:"new-input"});
  expect(store.metrics.commit({ticket,producerVersion:ticket.producerVersion,...result,errorStrip:strip()})).toBe("stale");
  expect(store.metrics.readErrorStrip(replay)?.result).toBeUndefined();
});
it("does not retire strip ownership when a passive current-viewer observation only repeats the old cache",()=>{
  const {current,result,pending}=pendingStripRepair(),ticket=store.metrics.claim(pending.id);if(!ticket)throw Error("Missing claim");
  expect(store["transaction"](()=>store.metrics.publishObservedInTransaction(current,result,true))).toBe("cached");
  expect(store.metrics.isEligible(ticket)).toBe(true);
  expect(store.metrics.readErrorStrip(replay)?.job?.id).toBe(pending.id);
});
it.each(["strip-byte-size-limit-v2","strip-evidence-incomplete"])("commits only an actual current byte-limit no-gain receipt (%s)",reason=>{
  const {result,pending}=pendingStripRepair(),ticket=store.metrics.claim(pending.id);if(!ticket)throw Error("Missing claim");
  const commit=()=>store.metrics.commitAndClaimTimeline({ticket,producerVersion:ticket.producerVersion,...result,errorStrip:{state:"unknown",reason}});
  if(reason==="strip-evidence-incomplete"){expect(commit).toThrow("current strip evidence");expect(store.metrics.isEligible(ticket)).toBe(true);}
  else {expect(commit()).toEqual({state:"cached"});expect(store.metrics.stripRepairTargetInTransaction(replay)).toBeUndefined();
    expect(store.metrics.admitStripRepairInTransaction(replay)).toBe(false);expect(store.metrics.readErrorStrip(replay)?.result).toEqual({state:"unknown",reason});}
});
it("retains one strip reservation through cancellation, Off, restart and demand without starting it",()=>{
  const {pending}=pendingStripRepair(),ticket=store.metrics.claim(pending.id);if(!ticket)throw Error("Missing claim");
  expect(store.metrics.release(ticket)).toBe("applied");
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});
  expect(store.metrics.nextQueued()).toEqual([]);expect(store.metrics.claim(pending.id)).toBeUndefined();
  expect(store.metrics.readErrorStrip(replay)?.job?.id).toBe(pending.id);
  store.close();store=new LibraryStore(database,"off-restart");
  expect(store.metrics.readErrorStrip(replay)?.job).toMatchObject({id:pending.id,state:"queued"});
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"demand"});
  expect(store.metrics.nextQueued()).toEqual([]);expect(store.metrics.claim(pending.id)).toBeUndefined();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"bg",userPaused:true});
  expect(store.metrics.nextQueued()).toEqual([]);expect(store.metrics.claim(pending.id)).toBeUndefined();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:false});
  const next=store.metrics.claim(pending.id);expect(next?.attempt).not.toBe(ticket.attempt);expect(next?.generation).toBe(ticket.generation);
  expect(store.metrics.commit({ticket,producerVersion:ticket.producerVersion,...releasedPrefixResult(),errorStrip:strip()})).toBe("stale");
});
it.each(["known","error","not-applicable","other-unknown","unqualified","old-version"])("does not certify protected cached strip %s",kind=>{
  const {current,result,pending}=pendingStripRepair();store["db"].prepare("DELETE FROM metric_jobs WHERE id=?").run(pending.id);
  const errorStrip:LibraryMetricResult["errorStrip"]=kind==="known"?strip():kind==="error"||kind==="not-applicable"?{state:kind,reason:"defined"}:
    {state:"unknown",reason:kind==="other-unknown"?"strip-evidence-incomplete":"strip-size-limit"};
  const changed:LibraryMetricResult={...result,errorStrip,provenance:{...result.provenance,...(kind==="unqualified"?{coverageQualified:false}:{})}};
  if(kind==="unqualified")delete changed.provenance.sourceCoverageEvidence;
  store.metrics.publishObserved(current,changed);
  if(kind==="old-version")store.metrics.setTarget({...current,producerVersion:"old"});
  expect(store.metrics.stripRepairTargetInTransaction(replay)).toBeUndefined();
  expect(store.metrics.admitStripRepairInTransaction(replay)).toBe(false);
});

it("rolls strip-only publication back atomically and retains its ticket on a storage error",()=>{
  const {result,pending}=pendingStripRepair(),ticket=store.metrics.claim(pending.id);if(!ticket)throw Error("Missing claim");
  const before=metricRows();store["db"].exec("CREATE TEMP TRIGGER reject_strip BEFORE UPDATE OF strip_payload ON metric_results BEGIN SELECT RAISE(ABORT,'strip-write-failed'); END");
  expect(()=>store.metrics.commitAndClaimTimeline({ticket,producerVersion:ticket.producerVersion,...result,errorStrip:strip()})).toThrow("strip-write-failed");
  expect(metricRows()).toBe(before);expect(store.metrics.isEligible(ticket)).toBe(true);
});
it("does not drop canonical strip work merely because an alias cache merges",()=>{
  const {pending}=pendingStripRepair(),alias=observe("pending-alias",null);expect(alias).not.toBe(replay);
  observe("pending-alias",hash);expect(store.resolveId(alias)).toBe(replay);
  expect(store.metrics.readErrorStrip(replay)?.job?.id).toBe(pending.id);
  expect(store.metrics.claim(pending.id)).toBeDefined();
});
it("atomically revokes a running strip attempt on Off while retaining its durable reservation",()=>{
  const {result,pending}=pendingStripRepair(),ticket=store.metrics.claim(pending.id);if(!ticket)throw Error("Missing claim");
  const before=metricRows(),targets=store.metrics.read(replay).map(e=>e.target);
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});
  const patch={ticket,producerVersion:ticket.producerVersion,...result,errorStrip:strip()};
  expect(store.metrics.commit(patch)).toBe("stale");
  expect(store.metrics.commitAndClaimTimeline(patch)).toEqual({state:"stale"});
  expect(store.metrics.release(ticket)).toBe("stale");
  expect(store.metrics.fail(ticket,"late failure")).toBe("stale");
  expect(metricRows()).toBe(before);expect(store.metrics.read(replay).map(e=>e.target)).toEqual(targets);
  expect(store["db"].prepare("SELECT id,state,attempt,error FROM metric_jobs WHERE id=?").get(pending.id))
    .toEqual({id:pending.id,state:"queued",attempt:null,error:null});
  expect(store.metrics.claim(pending.id)).toBeUndefined();
  store.close();store=new LibraryStore(database,"off-running-restart");
  expect(store.metrics.claim(pending.id)).toBeUndefined();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"bg"});
  const next=store.metrics.claim(pending.id);if(!next)throw Error("Missing resumed strip claim");
  expect(next.attempt).not.toBe(ticket.attempt);expect(next.generation).toBe(ticket.generation);
  expect(store.metrics.commitAndClaimTimeline({...patch,ticket:next})).toEqual({state:"cached"});
  expect(store.metrics.readErrorStrip(replay)?.result).toEqual(strip());
});
it.each(["aggregate-pp","fc-pp"] as const)("marks only actual native rejected P %s publication while cache observation remains unstamped",slot=>{
  const head=store.metrics.setTarget({replayId:replay,slot,stage:"P",inputKey:"raw",producerVersion:LIBRARY_P_PRODUCER_VERSION});
  const result:LibraryMetricResult={fields:{[slot==="aggregate-pp"?"pp":"ppIfFc"]:{state:"unknown",reason:"aggregate-object-coverage-incomplete"}},
    provenance:{replaySha256:hash,mapSha256:"b".repeat(64),mapMd5:"c".repeat(32),engineVersion:PERFORMANCE_ENGINE_VERSION,ruleset:"lazer"}};
  store.metrics.publishObserved(head,result);expect(store.metrics.read(replay).find(e=>e.target.slot===slot)?.result?.provenance.capabilityAttempt).toBeUndefined();
  const attempted=libraryCapabilityAttempt(head,result);expect(attempted.provenance.capabilityAttempt).toBe("native-sparse-score-v1");
  expect(()=>store.metrics.validatePreparedResult(head,attempted)).not.toThrow();
  expect(result.provenance.capabilityAttempt).toBeUndefined();
});
it.each(["stable","stage","version","field","reason","map","replay","engine","source-only","known","extra"])(
  "rejects a forged native sparse P marker with %s mismatch",fault=>{
    const input={replayId:replay,slot:"aggregate-pp" as const,stage:"P" as const,inputKey:"raw",producerVersion:LIBRARY_P_PRODUCER_VERSION};
    const value:LibraryMetricResult={fields:{pp:{state:"unknown",reason:"aggregate-object-coverage-incomplete"}},
      provenance:{replaySha256:hash,mapSha256:"b".repeat(64),mapMd5:"c".repeat(32),engineVersion:PERFORMANCE_ENGINE_VERSION,ruleset:"lazer",capabilityAttempt:"native-sparse-score-v1"}};
    if(fault==="stable")value.provenance.ruleset="stable";
    if(fault==="stage")(input as {stage:string}).stage="S";
    if(fault==="version")input.producerVersion="old";
    if(fault==="field")value.fields={ppIfFc:{state:"unknown",reason:"aggregate-object-coverage-incomplete"}};
    if(fault==="reason")value.fields.pp={state:"unknown",reason:"missing-score"};
    if(fault==="map")delete value.provenance.mapMd5;
    if(fault==="replay")delete value.provenance.replaySha256;
    if(fault==="engine")value.provenance.engineVersion="old";
    if(fault==="source-only")value.provenance.sourceOnly=true;
    if(fault==="known")value.fields.pp={state:"known",value:5};
    if(fault==="extra")value.fields.extra={state:"unknown",reason:"aggregate-object-coverage-incomplete"};
    expect(()=>store.metrics.validatePreparedResult(input,value)).toThrow("Invalid library metric payload");
  });
