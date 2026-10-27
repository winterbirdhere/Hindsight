import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { metricInputKey } from "./library-source-metrics";
import { mkdtempSync, unlinkSync, rmdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DatabaseSync } from "node:sqlite";
import { LibraryStore } from "./library-store";
import { numericalProfileKey, numericalModsHash } from "./library-numerical-profile";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION,
  LibraryNumericalInputRecipe, LibraryNumericalResourceDescriptor } from "../../../../shared/library-analysis";
import type { LibraryCurrentReplayResult } from "../../../../shared/library-current-replay";
import type { LibraryMetricResult } from "../../../../shared/replay-library-metrics";
import { LIBRARY_P_PRODUCER_VERSION } from "./library-performance-versions";
import { libraryTimelineTarget } from "./library-timeline-target";
import type { LibraryPreparedResult } from "./library-preparation-store";

let folder: string;
let database: string;
let store: LibraryStore;
const shaA = "a".repeat(64);
const shaB = "b".repeat(64);

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hindsight-library-store-"));
  database = join(folder, "library.sqlite");
  store = new LibraryStore(database, "session-1");
  store.registerSource({ id: "stable", kind: "stable", directory: "C:\\osu" });
  store.registerSource({ id: "imports", kind: "imported", directory: "C:\\app-owned" });
});
afterEach(() => {
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(database + suffix)) unlinkSync(database + suffix);
  rmdirSync(folder);
});

function observe(sourceId: string, key: string, sha256: string | null, generation: string, addedAt = 10) {
  return store.upsertObservation({ sourceId, sourceKey: key, locator: key, sha256, available: sha256 !== null, generation, addedAt, metadata: { player: "P", playedAtTicks: "638961337234567891" } });
}

function requiredCapability<T>(value:T|null|undefined):T {if(value===null||value===undefined)throw Error("Missing capability fixture receipt");return value;}
function capabilityFixture(mask=0) {
  const observation={sourceId:"imports",sourceKey:"old-capability",locator:"old.osr",sha256:shaA,available:true,
    generation:store.beginScan("imports"),addedAt:1,metadata:{header:{mode:0,sourceFormat:"stable",nativeScoreInfo:false,modsBitmask:mask}}};
  const id=store.upsertObservation(observation);
  const numerical={replayId:id,slot:"numerical" as const,stage:"S" as const,inputKey:"old-v6",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION};
  const map={replayId:id,slot:"calculated-map" as const,stage:"P" as const,inputKey:"unchanged-p",producerVersion:LIBRARY_P_PRODUCER_VERSION};
  const value:LibraryMetricResult={fields:{completion:{state:"unknown",reason:"completion-not-established"},ur:{state:"unknown",reason:"no-valid-timing-samples"}},
    provenance:{replaySha256:shaA,ruleset:"stable",projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,coverageQualified:false,
      completeAccuracyEvidence:false,completeBreakEvidence:false,scoreOrigin:"reconstructed",completionEvidence:"source-domain-coverage-v1"},
    errorStrip:{state:"unknown",reason:"strip-evidence-incomplete"}};
  for(const target of [numerical,map]){
    store.preparations.request(id,target.stage,"selection");const ticket=requiredCapability(store.preparations.claim(id,target.stage));
    store.preparations.complete(ticket,[target]);
    store.metrics.publishObserved(requiredCapability(store.metrics.readTarget(id,target.slot)),target.stage==="S"?value:{fields:{bpm:{state:"known",value:180}},provenance:{}});
  }
  return {id,numerical,map,value,observation};
}
function capabilityPages(){let turns=0;while(store.maintainCapabilityRecovery()){if(++turns>12)throw Error("Capability maintenance spun");}return turns;}

function nativeCapabilityFixture(){
  const fixture=capabilityFixture();
  const observation={...fixture.observation,metadata:{header:{mode:0,sourceFormat:"lazer",nativeScoreInfo:true,version:30000019,modsBitmask:0}}};
  store.upsertObservation(observation);
  const recipe:LibraryNumericalInputRecipe={version:1,replaySha256:shaA,fixedKey:shaB,intrinsicNative:true,
    embeddedModsHash:requiredCapability(numericalModsHash([])),legacyModsHash:shaB,modeQualified:true,consumedModsSource:"embedded"};
  const profile=numericalProfileKey(recipe,{origin:null,native:{state:"absent"}});if(profile.state!=="known")throw Error("Invalid native fixture");
  const numerical={...fixture.numerical,inputKey:profile.inputKey};store.metrics.setTarget(numerical);
  store["transaction"](()=>expect(store["numericalRecipes"].bindInTransaction(fixture.id,numerical,recipe)).toBe(true));
  const value={...fixture.value,provenance:{...fixture.value.provenance,ruleset:"lazer",rate:1}};
  store.metrics.publishObserved(requiredCapability(store.metrics.readTarget(fixture.id,"numerical")),value);
  return {...fixture,observation,numerical,value,recipe};
}
function completeNativeTimelineFixture(id:string){
  const timeline=store.metrics.readTarget(id,"timeline-pp");if(!timeline)return;
  store.metrics.publishObserved(timeline,{fields:{pp:{state:"unknown",reason:"completion-not-established"},
    peakPp:{state:"unknown",reason:"performance-data-unavailable"}},provenance:{coverageQualified:false}});
}

it("upgrades a completed old capability pass once for native rejected inputs, preserving prior counts",()=>{
  const fixture=nativeCapabilityFixture();
  const legacy={cursor:"zzzz",deferred:null,complete:true,processed:8000,numerical:840,performance:3};
  store["db"].prepare("INSERT INTO settings VALUES(?,?)").run("library-capability-recovery-stable-prefix-dominant-tempo-v1",JSON.stringify(legacy));
  store.close();store=new LibraryStore(database,"native-upgrade");store.enableNumericalAdmission();store.enablePerformanceAdmission();
  capabilityPages();expect(store.capabilityRecoveryStatus()).toMatchObject({complete:true,numerical:841,performance:3,processed:8001});
  expect(store.preparations.read(fixture.id).find(r=>r.stage==="S")?.state).toBe("queued");
  const ticket=requiredCapability(store.preparations.claim(fixture.id,"S"));
  const handoff=store.preparations.complete(ticket,[fixture.numerical],undefined,true);
  if(handoff.state!=="applied"||handoff.handoff?.state!=="claimed")throw Error("Expected native handoff");
  store.metrics.commit({ticket:handoff.handoff.ticket,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,...fixture.value});
  expect(store.metrics.read(fixture.id).find(e=>e.target.slot==="numerical")?.result?.provenance.capabilityAttempt).toBe("native-held-release-v2");
  const timeline=requiredCapability(store.metrics.readTarget(fixture.id,"timeline-pp"));
  store.metrics.publishObserved(timeline,{fields:{pp:{state:"unknown",reason:"completion-not-established"},
    peakPp:{state:"unknown",reason:"performance-data-unavailable"}},provenance:{coverageQualified:false}});
  const progress=store.capabilityRecoveryStatus(),metrics=store.metrics.read(fixture.id);
  store.close();store=new LibraryStore(database,"native-restart");store.enableNumericalAdmission();store.enablePerformanceAdmission();
  store.upsertObservation({...fixture.observation,generation:store.beginScan("imports")});capabilityPages();
  expect(store.capabilityRecoveryStatus()).toEqual(progress);expect(store.metrics.read(fixture.id)).toEqual(metrics);
  expect(JSON.parse(String(store["db"].prepare("SELECT value FROM settings WHERE key=?").get("library-capability-recovery-stable-prefix-dominant-tempo-v1")?.value))).toEqual(legacy);
});

it("preserves exact independent P aggregate during native automatic S recovery",()=>{
  const fixture=nativeCapabilityFixture();
  const raw:LibraryPreparedResult={slot:"aggregate-pp",stage:"P",inputKey:"native-recorded-aggregate",producerVersion:LIBRARY_P_PRODUCER_VERSION,
    fields:{pp:{state:"known",value:37}},provenance:{replaySha256:shaA,mapSha256:shaB,ruleset:"lazer"}};
  store["transaction"](()=>store["performanceRecipes"].bindInTransaction(fixture.id,store["performanceDependencies"](fixture.id),[raw],true));
  const prior=store.metrics.read(fixture.id).find(e=>e.target.slot==="aggregate-pp");
  expect(prior?.result?.fields.pp).toEqual({state:"known",value:37});
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(1);
  expect(store.metrics.read(fixture.id).find(e=>e.target.slot==="aggregate-pp")).toEqual(prior);
});

it.each([0,4096])("reconsiders an old Stable v1 attempt once for the new prefix capability (mods=%s)",mask=>{
  const fixture=capabilityFixture(mask),legacy={...fixture.value,provenance:{...fixture.value.provenance,capabilityAttempt:"stable-prefix-v1"}};
  store.metrics.publishObserved(requiredCapability(store.metrics.readTarget(fixture.id,"numerical")),legacy);
  const legacyStored=store.metrics.read(fixture.id).find(e=>e.target.slot==="numerical")?.result;
  store.close();store=new LibraryStore(database,"old-stable-attempt-upgrade");
  expect(store.metrics.read(fixture.id).find(e=>e.target.slot==="numerical")?.result).toEqual(legacyStored);
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(1);
  const prep=requiredCapability(store.preparations.claim(fixture.id,"S")),receipt=store.preparations.complete(prep,[fixture.numerical],undefined,true);
  if(receipt.state!=="applied"||receipt.handoff?.state!=="claimed")throw Error("Missing upgraded Stable attempt");
  store.metrics.commit({ticket:receipt.handoff.ticket,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,...fixture.value});
  expect(store.metrics.read(fixture.id).find(e=>e.target.slot==="numerical")?.result?.provenance.capabilityAttempt).toBe("stable-prefix-v3");
  const before=store.metrics.read(fixture.id),progress=store.capabilityRecoveryStatus();
  store.close();store=new LibraryStore(database,"new-stable-attempt-restart");store.enableNumericalAdmission();store.enablePerformanceAdmission();
  store.upsertObservation({...fixture.observation,generation:store.beginScan("imports")});capabilityPages();
  expect(store.capabilityRecoveryStatus()).toEqual(progress);expect(store.metrics.read(fixture.id)).toEqual(before);
  const changed=store.metrics.setTarget({...fixture.numerical,inputKey:"changed-stable-input"});
  store.metrics.publishObserved(changed,legacy);
  store.upsertObservation({...fixture.observation,generation:store.beginScan("imports")});finishCachedPreparation(fixture.id);capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(2);
});

it("preserves both independently known P aggregate and IfFC while retiring rejected S",()=>{
  const fixture=nativeCapabilityFixture(),provenance={replaySha256:shaA,mapSha256:shaB,ruleset:"lazer"};
  const raw:LibraryPreparedResult[]=[
    {slot:"aggregate-pp",stage:"P",inputKey:"raw-independent-pp",producerVersion:LIBRARY_P_PRODUCER_VERSION,fields:{pp:{state:"known",value:37}},provenance},
    {slot:"fc-pp",stage:"P",inputKey:"raw-independent-if-fc",producerVersion:LIBRARY_P_PRODUCER_VERSION,fields:{ppIfFc:{state:"known",value:40}},provenance}];
  store["transaction"](()=>store["performanceRecipes"].bindInTransaction(fixture.id,store["performanceDependencies"](fixture.id),raw,true));
  const before=store.metrics.read(fixture.id).filter(e=>e.target.stage==="P");
  expect(before.find(e=>e.target.slot==="aggregate-pp")?.result?.fields.pp.state).toBe("known");
  expect(before.find(e=>e.target.slot==="fc-pp")?.result?.fields.ppIfFc.state).toBe("known");
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(1);
  expect(store.metrics.read(fixture.id).filter(e=>e.target.stage==="P")).toEqual(before);
  expect(store.metrics.read(fixture.id).find(e=>e.target.slot==="numerical")?.result).toBeUndefined();
});

it.each(["key","dependencies","value","provenance","version","error","not-applicable"])(
  "rejects a noncanonical independent P IfFC certificate (%s)",fault=>{
    const fixture=nativeCapabilityFixture(),raw:LibraryPreparedResult={slot:"fc-pp",stage:"P",inputKey:"raw-if-fc",producerVersion:LIBRARY_P_PRODUCER_VERSION,
      fields:{ppIfFc:{state:"known",value:40}},provenance:{replaySha256:shaA,mapSha256:shaB,ruleset:"lazer"}};
    store["transaction"](()=>store["performanceRecipes"].bindInTransaction(fixture.id,store["performanceDependencies"](fixture.id),[raw],true));
    if(fault==="dependencies"){
      const row=requiredCapability(store["db"].prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(fixture.id));
      const recipe=JSON.parse(String(row.payload));recipe.dependencies.profileKey=shaA;
      store["db"].prepare("UPDATE performance_recipes SET payload=? WHERE replay_id=?").run(JSON.stringify(recipe),fixture.id);
    }else{
      const current=requiredCapability(store.metrics.readTarget(fixture.id,"fc-pp"));
      const target=store.metrics.setTarget({...current,...(fault==="key"?{inputKey:"not-independent-fc"}:{}),...(fault==="version"?{producerVersion:"old-p"}:{})});
      store.metrics.publishObserved(target,{fields:{ppIfFc:fault==="error"?{state:"error",reason:"invalid-score"}:fault==="not-applicable"?
        {state:"not-applicable",reason:"failed-play"}:{state:"known",value:fault==="value"?41:40}},
        provenance:fault==="provenance"?{...raw.provenance,mapSha256:shaA}:raw.provenance});
    }
    const before=store.metrics.read(fixture.id),changes=store["db"].prepare("SELECT total_changes() AS n").get();
    expect(store.metrics.canRetryRejectedCoverageInTransaction(fixture.id)).toBe(false);
    expect(store["db"].prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(store.metrics.read(fixture.id)).toEqual(before);
  });

it.each(["off","demand","pause"])("keeps native capability recovery held under %s",policy=>{
  const fixture=nativeCapabilityFixture(),before=store.metrics.read(fixture.id);
  store.enableNumericalAdmission();store.enablePerformanceAdmission();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:policy==="pause"?"bg":policy as "off"|"demand",userPaused:policy==="pause"});
  expect(store.maintainCapabilityRecovery()).toBe(false);expect(store.capabilityRecoveryStatus().state).toBe("held");
  expect(store.metrics.read(fixture.id)).toEqual(before);
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"bg",userPaused:false});capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(1);
});

it.each(["disabled","unavailable"])("defers a late eligible native %s input, preserves busy ownership, then admits its changed input",condition=>{
  const fixture=nativeCapabilityFixture();
  if(condition==="disabled")store.setSourceEnabled("imports",false);else store.upsertObservation({...fixture.observation,available:false});
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus()).toMatchObject({complete:true,numerical:0});
  if(condition==="disabled")store.setSourceEnabled("imports",true);else store.upsertObservation(fixture.observation);
  while(store.sourceAdmissionPending())store.maintainSourceAdmission();finishCachedPreparation(fixture.id);
  completeNativeTimelineFixture(fixture.id);
  store.preparations.request(fixture.id,"P","retry");const active=requiredCapability(store.preparations.claim(fixture.id,"P"));
  const requests=store.preparations.read(fixture.id),before=store.metrics.read(fixture.id),progress=store.capabilityRecoveryStatus();
  expect(progress.deferred).toBe(fixture.id);expect(store.maintainCapabilityRecovery()).toBe(false);
  expect(store.preparations.read(fixture.id)).toEqual(requests);expect(store.metrics.read(fixture.id)).toEqual(before);
  store.preparations.complete(active,[fixture.map]);capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(1);
  const prep=requiredCapability(store.preparations.claim(fixture.id,"S")),handoff=store.preparations.complete(prep,[fixture.numerical],undefined,true);
  if(handoff.state!=="applied"||handoff.handoff?.state!=="claimed")throw Error("Missing native attempt");
  const stale=handoff.handoff.ticket;store.metrics.commit({ticket:stale,producerVersion:stale.producerVersion,...fixture.value});
  const recipe={...fixture.recipe,fixedKey:"c".repeat(64)},profile=numericalProfileKey(recipe,{origin:null,native:{state:"absent"}});
  if(profile.state!=="known")throw Error("Invalid changed native input");
  const target=store.metrics.setTarget({...fixture.numerical,inputKey:profile.inputKey});
  store["transaction"](()=>expect(store["numericalRecipes"].bindInTransaction(fixture.id,target,recipe)).toBe(true));
  store.metrics.publishObserved(target,fixture.value);
  const timeline=requiredCapability(store.metrics.readTarget(fixture.id,"timeline-pp"));
  store.metrics.publishObserved(timeline,{fields:{peakPp:{state:"unknown",reason:"performance-data-unavailable"},
    pp:{state:"unknown",reason:"completion-not-established"}},provenance:{coverageQualified:false}});
  store.upsertObservation({...fixture.observation,generation:store.beginScan("imports")});finishCachedPreparation(fixture.id);
  completeNativeTimelineFixture(fixture.id);capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(2);
  expect(store.metrics.commit({ticket:stale,producerVersion:stale.producerVersion,...fixture.value})).toBe("stale");
});

it("reconsiders manual-timing SpunOut unknown through the same capability pass",()=>{
  const fixture=capabilityFixture(4096);store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(1);
  expect(store.preparations.read(fixture.id).find(r=>r.stage==="S")?.state).toBe("queued");
});

it.each([128|4096,8192|4096])("does not admit SpunOut combined with automated tap or aim (%s)",mask=>{
  const fixture=capabilityFixture(mask),before=store.metrics.read(fixture.id);
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(0);expect(store.metrics.read(fixture.id)).toEqual(before);
});

it.each(["missing-recipe","corrupt-recipe","mods","recipe-sha","key","mode","header","rate","disabled","unavailable","failed"])(
  "does not reconsider protected native %s input or reopen it on observation",fault=>{
    const fixture=nativeCapabilityFixture(),db=store["db"];
    if(fault==="missing-recipe")db.prepare("DELETE FROM numerical_recipes WHERE replay_id=?").run(fixture.id);
    else if(fault==="corrupt-recipe")db.prepare("UPDATE numerical_recipes SET recipe='{}' WHERE replay_id=?").run(fixture.id);
    else if(["mods","recipe-sha","key","mode"].includes(fault)){
      const recipe={...fixture.recipe};if(fault==="mods")recipe.embeddedModsHash=requiredCapability(numericalModsHash([{acronym:"RX"}]));
      if(fault==="recipe-sha")recipe.replaySha256=shaB;if(fault==="key")recipe.fixedKey=shaA;if(fault==="mode")recipe.modeQualified=false;
      db.prepare("UPDATE numerical_recipes SET recipe=? WHERE replay_id=?").run(JSON.stringify(recipe),fixture.id);
    }else if(fault==="header")db.prepare("UPDATE replays SET metadata=? WHERE id=?").run(JSON.stringify({header:{...fixture.observation.metadata.header,nativeScoreInfo:false}}),fixture.id);
    else if(fault==="rate")store.metrics.publishObserved(requiredCapability(store.metrics.readTarget(fixture.id,"numerical")),
      {...fixture.value,provenance:{...fixture.value.provenance,rate:1.5}});
    else if(fault==="disabled")store.setSourceEnabled("imports",false);
    else if(fault==="unavailable")store.upsertObservation({...fixture.observation,available:false});
    else {store.preparations.request(fixture.id,"P","retry");store.preparations.fail(requiredCapability(store.preparations.claim(fixture.id,"P")),"native drain unconfirmed");}
    const before=store.metrics.read(fixture.id);store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
    expect(store.capabilityRecoveryStatus()).toMatchObject({complete:true,numerical:0});
    expect(store.metrics.read(fixture.id)).toEqual(before);
    const progress=store.capabilityRecoveryStatus();store["transaction"](()=>store["deferCapabilityInTransaction"](fixture.id));
    expect(store.capabilityRecoveryStatus()).toEqual(progress);
  });

it.each(["key","map","profile","score","payload","provenance","error","not-applicable","fc"])(
  "protects noncertified P %s during native recovery",fault=>{
    const fixture=nativeCapabilityFixture(),raw:LibraryPreparedResult={slot:"aggregate-pp",stage:"P",inputKey:"raw-recorded",producerVersion:LIBRARY_P_PRODUCER_VERSION,
      fields:{pp:{state:"known",value:37}},provenance:{mapSha256:shaB,ruleset:"lazer"}};
    store["transaction"](()=>store["performanceRecipes"].bindInTransaction(fixture.id,store["performanceDependencies"](fixture.id),[raw],true));
    const entry=requiredCapability(store.metrics.read(fixture.id).find(e=>e.target.slot==="aggregate-pp"));
    if(["map","profile","score"].includes(fault)){
      const row=requiredCapability(store["db"].prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(fixture.id));
      const recipe=JSON.parse(String(row.payload));recipe.dependencies[fault+"Key"]=shaA;
      store["db"].prepare("UPDATE performance_recipes SET payload=? WHERE replay_id=?").run(JSON.stringify(recipe),fixture.id);
    }else{
      const target=store.metrics.setTarget({...entry.target,...(fault==="key"?{inputKey:"wrong"}:{}),...(fault==="fc"?{slot:"fc-pp" as const}:{})});
      const fields:LibraryMetricResult["fields"]=fault==="fc"?{ppIfFc:{state:"known",value:37}}:
        {pp:fault==="error"?{state:"error",reason:"invalid-score"}:fault==="not-applicable"?{state:"not-applicable",reason:"failed-play"}:{state:"known",value:fault==="payload"?38:37}};
      store.metrics.publishObserved(target,{fields,provenance:fault==="provenance"?{mapSha256:shaA,ruleset:"lazer"}:raw.provenance});
    }
    const before=store.metrics.read(fixture.id),changes=store["db"].prepare("SELECT total_changes() AS n").get();
    expect(store.metrics.canRetryRejectedCoverageInTransaction(fixture.id)).toBe(false);
    expect(store["db"].prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(store.metrics.read(fixture.id)).toEqual(before);
  });

it.each(["off","demand"] as const)("restores an old masked aggregate from its exact recipe through metadata maintenance while %s",mode=>{
  const id=observe("imports","visibility",shaA,store.beginScan("imports"));
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode});
  const raw:LibraryPreparedResult[]=[
    {slot:"calculated-map" as const,stage:"P" as const,inputKey:"raw-map",producerVersion:LIBRARY_P_PRODUCER_VERSION,
      fields:{mapStars:{state:"known" as const,value:2}},provenance:{mapSha256:shaB,ruleset:"stable"}},
    {slot:"aggregate-pp" as const,stage:"P" as const,inputKey:"raw-aggregate",producerVersion:LIBRARY_P_PRODUCER_VERSION,
      fields:{pp:{state:"known" as const,value:37}},provenance:{mapSha256:shaB,ruleset:"stable"}},
    {slot:"fc-pp" as const,stage:"P" as const,inputKey:"raw-fc",producerVersion:LIBRARY_P_PRODUCER_VERSION,
      fields:{ppIfFc:{state:"known" as const,value:40}},provenance:{mapSha256:shaB,ruleset:"stable"}}
  ];
  store["transaction"](()=>store["performanceRecipes"].bindInTransaction(id,store["performanceDependencies"](id),raw,false));
  // Reproduce an upgrade snapshot: retained raw mathematics, but the current old
  // visibility tuple still masks aggregate PP for absent completion evidence.
  const masked=store.metrics.setTarget({...raw[1],replayId:id,inputKey:"legacy-completion-mask"});
  store.metrics.publishObserved(masked,{fields:{pp:{state:"unknown",reason:"completion-unavailable"}},provenance:raw[1].provenance});
  store["db"].prepare("DELETE FROM settings WHERE key='independent-performance-visibility-v2'").run();
  const protectedEntries=store.metrics.read(id).filter(e=>e.target.slot!=="aggregate-pp"),policy=store.metrics.analysisSettings();
  const recipe=store["db"].prepare("SELECT * FROM performance_recipes WHERE replay_id=?").get(id);
  const old=store["db"].prepare("SELECT * FROM metric_results WHERE replay_id=? AND input_key=?").get(id,masked.inputKey);
  store.close();store=new LibraryStore(database,"visibility-upgrade");
  expect(store.metrics.read(id).find(e=>e.target.slot==="aggregate-pp")?.result?.fields.pp.state).toBe("unknown");
  const restore=jest.spyOn(store["performanceRecipes"],"reconcileInTransaction");
  const drain=()=>{for(let i=0;i<64;i++){
    if(store.queryProjectionPending())store.maintainQueryProjection();
    else if(store.incidentIdentityPending())store.maintainIncidentIdentity();else return;
  }throw Error("Metadata maintenance did not settle");};
  drain();
  expect(store.metrics.read(id).find(e=>e.target.slot==="aggregate-pp")?.result?.fields.pp).toEqual({state:"known",value:37});
  expect(restore).toHaveBeenCalledWith(id);restore.mockRestore();
  expect(store.metrics.read(id).filter(e=>e.target.slot!=="aggregate-pp")).toEqual(protectedEntries);
  expect(store["db"].prepare("SELECT * FROM performance_recipes WHERE replay_id=?").get(id)).toEqual(recipe);
  expect(store["db"].prepare("SELECT * FROM metric_results WHERE replay_id=? AND input_key=?").get(id,masked.inputKey)).toEqual(old);
  expect(store.metrics.analysisSettings()).toEqual(policy);expect(store.preparations.read(id)).toEqual([]);
  expect(store.metrics.read(id).every(e=>!e.job)).toBe(true);
  const recovered=store.metrics.read(id),progress=store["db"].prepare("SELECT value FROM settings WHERE key='independent-performance-visibility-v2'").get();
  store.close();store=new LibraryStore(database,"visibility-restart");
  const again=jest.spyOn(store["performanceRecipes"],"reconcileInTransaction");drain();
  expect(again).not.toHaveBeenCalled();again.mockRestore();
  expect(store.metrics.read(id)).toEqual(recovered);expect(store.metrics.analysisSettings()).toEqual(policy);
  expect(store.preparations.read(id)).toEqual([]);
  expect(store["db"].prepare("SELECT value FROM settings WHERE key='independent-performance-visibility-v2'").get()).toEqual(progress);
});

it.each([false,true])("pages past ineligible identities with a fixed work bound (last eligible=%s)",lastEligible=>{
  const generation=store.beginScan("imports"),rows=Array.from({length:20},(_,i)=>{
    const sha256=(i+1).toString(16).padStart(64,"0");
    const id=store.upsertObservation({sourceId:"imports",sourceKey:"page-"+i,locator:"page-"+i,sha256,available:true,generation,addedAt:i,
      metadata:{header:{mode:0,sourceFormat:"stable",nativeScoreInfo:false,modsBitmask:0}}});return{id,sha256};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  for(const [index,row] of rows.entries()){
    const target=store.metrics.setTarget({replayId:row.id,slot:"numerical",stage:"S",inputKey:"page-input",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
    store.metrics.publishObserved(target,lastEligible&&index===rows.length-1?{
      fields:{completion:{state:"unknown",reason:"completion-not-established"},ur:{state:"unknown",reason:"no-valid-timing-samples"}},
      provenance:{replaySha256:row.sha256,ruleset:"stable",projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,coverageQualified:false,
        completeAccuracyEvidence:false,completeBreakEvidence:false,scoreOrigin:"reconstructed",completionEvidence:"source-domain-coverage-v1"}
    }:{fields:{ur:{state:"known",value:100}},provenance:{coverageQualified:true}});
  }
  store.enableNumericalAdmission();store.enablePerformanceAdmission();
  for(const [index,row] of rows.entries()){
    expect(store.maintainCapabilityRecovery()).toBe(true);
    expect(store.capabilityRecoveryStatus()).toMatchObject({cursor:row.id,processed:index+1,complete:false,
      numerical:lastEligible&&index===rows.length-1?1:0});
  }
  expect(store.maintainCapabilityRecovery()).toBe(false);
  expect(store.capabilityRecoveryStatus()).toMatchObject({complete:true,processed:rows.length,numerical:lastEligible?1:0});
});
function finishCachedPreparation(id:string){
  for(const request of store.preparations.read(id).filter(r=>r.state==="queued")){
    const ticket=requiredCapability(store.preparations.claim(id,request.stage));
    store.preparations.complete(ticket,store.metrics.read(id).filter(e=>e.target.stage===request.stage).map(e=>e.target));
  }
}

it("commits capability admission and cursor atomically and keeps status/query passive",()=>{
  const {id}=capabilityFixture();store.enableNumericalAdmission();store.enablePerformanceAdmission();
  const before=store.metrics.read(id),progress=store.capabilityRecoveryStatus(),requests=store.preparations.read(id);
  const fault=jest.spyOn(store.preparations,"requestInTransaction").mockImplementationOnce(()=>{throw Error("Admission transaction fault");});
  expect(()=>store.maintainCapabilityRecovery()).toThrow("Admission transaction fault");fault.mockRestore();
  expect(store.metrics.read(id)).toEqual(before);expect(store.capabilityRecoveryStatus()).toEqual(progress);expect(store.preparations.read(id)).toEqual(requests);
  store.capabilityRecoveryStatus();store.createQueryReader().detail(id);store.metrics.read(id);
  expect(store.capabilityRecoveryStatus()).toEqual(progress);expect(store.metrics.read(id)).toEqual(before);
  capabilityPages();expect(store.capabilityRecoveryStatus().numerical).toBe(1);
});

it.each(["constant-tempo-unavailable","tempo-geometry-budget"])("requeues old %s once and marks only fresh P publication, not recipe restoration",reason=>{
  const md5="c".repeat(32),mapSha="d".repeat(64),sourceKey="e".repeat(64);
  const metadata={savedScore:{sourceKey,databaseVersion:20250101,header:{mode:0,version:20250101,beatmapMD5:md5,modsBitmask:0,
    counts:{great:3,ok:0,meh:0,miss:0,geki:0,katu:0},maxCombo:3,score:123}}};
  const id=store.upsertObservation({sourceId:"stable",sourceKey,locator:"missing.osr",sha256:null,available:false,
    generation:store.beginScan("stable"),addedAt:1,metadata});
  const generation=store.beginMapScan("stable");store.upsertMap({sourceId:"stable",sourceKey:"map",generation,md5,locator:"map.osu",state:"unverified",metadata:{}});store.finishMapScan("stable",generation);
  const result={slot:"calculated-map" as const,stage:"P" as const,inputKey:"old-map-input",producerVersion:LIBRARY_P_PRODUCER_VERSION,
    fields:{mapStars:{state:"known" as const,value:2},bpm:{state:"unknown" as const,reason}},provenance:{mapSha256:mapSha,mapMd5:md5,sourceOnly:true}};
  // Old recipe restoration is the actual cache path, and must not claim a new calculation.
  store["transaction"](()=>store["performanceRecipes"].bindInTransaction(id,store["performanceDependencies"](id),[result],false));
  store.preparations.request(id,"P","selection");const seed=requiredCapability(store.preparations.claim(id,"P"));
  store.preparations.completeResults(seed,[result],()=>({state:"applied",replayId:id}),()=>store["performanceRecipes"].reconcileInTransaction(id));
  const prior=requiredCapability(store.metrics.read(id).find(e=>e.target.slot==="calculated-map"));
  expect(prior.result?.provenance.capabilityAttempt).toBeUndefined();
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus().performance).toBe(1);
  expect(store.metrics.read(id).find(e=>e.target.slot==="calculated-map")).toEqual(prior);
  const ticket=requiredCapability(store.preparations.claim(id,"P")),location=store.openLocationCandidates(id).items[0],map={md5,sha256:mapSha,ticket:store.openMapCandidates(md5).items[0]};
  expect(store.commitPreparedPerformance({...ticket,generation:ticket.generation+1},location,map,[result],null).state).toBe("stale");
  expect(store.metrics.read(id).find(e=>e.target.slot==="calculated-map")).toEqual(prior);
  expect(()=>store.commitPreparedPerformance(ticket,location,map,[{...result,provenance:{...result.provenance,capabilityAttempt:"invalid"}}],null)).toThrow("Invalid library metric payload");
  expect(store.commitPreparedPerformance(ticket,location,map,[result],null).state).toBe("applied");
  const fresh=requiredCapability(store.metrics.read(id).find(e=>e.target.slot==="calculated-map"));
  expect(fresh.result?.provenance.capabilityAttempt).toBe("dominant-tempo-v2");expect(fresh.result?.fields).toEqual(result.fields);
  store["performanceRecipes"].reconcileInTransaction(id);expect(store.metrics.read(id).find(e=>e.target.slot==="calculated-map")).toEqual(fresh);
  // Derived profile withholding cannot inherit a claim about the unavailable fields.
  store.metrics.bindPreparedResultInTransaction({...fresh.target,inputKey:"hidden-profile"},{fields:{mapStars:{state:"known",value:2},bpm:{state:"unknown",reason:"profile-unavailable"}},provenance:requiredCapability(fresh.result).provenance});
  expect(store.metrics.read(id).find(e=>e.target.slot==="calculated-map")?.result?.provenance.capabilityAttempt).toBeUndefined();
  store["performanceRecipes"].reconcileInTransaction(id);
  expect(store.metrics.read(id).find(e=>e.target.slot==="calculated-map")?.result).toEqual(fresh.result);
  store.close();store=new LibraryStore(database,"p-reopen");store.enableNumericalAdmission();store.enablePerformanceAdmission();
  capabilityPages();expect(store.capabilityRecoveryStatus().performance).toBe(1);
  expect(store.preparations.read(id).find(r=>r.stage==="P")?.state).toBe("bound");
});

it.each(["disabled","unavailable"])("revisits late %s old input after completed pass, pause and restart without repeating attempted unknowns",condition=>{
  const fixture=capabilityFixture();
  if(condition==="disabled")store.setSourceEnabled("imports",false);
  else store.upsertObservation({...fixture.observation,available:false});
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus().state).toBe("complete");
  expect(store.metrics.read(fixture.id).find(e=>e.target.slot==="numerical")?.result).toBeDefined();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:true});
  if(condition==="disabled")store.setSourceEnabled("imports",true);
  else store.upsertObservation({...fixture.observation,available:true});
  while(store.sourceAdmissionPending())store.maintainSourceAdmission();
  expect(store.capabilityRecoveryStatus().state).toBe("held");
  store.close();store=new LibraryStore(database,"resume-capability");store.enableNumericalAdmission();store.enablePerformanceAdmission();
  expect(store.maintainCapabilityRecovery()).toBe(false);
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:false});
  finishCachedPreparation(fixture.id);capabilityPages();
  expect(store.metrics.read(fixture.id).find(e=>e.target.slot==="numerical")?.result).toBeUndefined();
  const prep=requiredCapability(store.preparations.claim(fixture.id,"S"));
  const completed=store.preparations.complete(prep,[fixture.numerical],undefined,true);
  if(completed.state!=="applied"||completed.handoff?.state!=="claimed")throw Error("Expected production handoff");
  const ticket=completed.handoff.ticket;
  store.metrics.commit({ticket,producerVersion:ticket.producerVersion,...fixture.value});
  const before=store.metrics.read(fixture.id),requests=store.preparations.read(fixture.id);
  store.upsertObservation({...fixture.observation,generation:store.beginScan("imports")});capabilityPages();
  expect(store.metrics.read(fixture.id)).toEqual(before);expect(store.preparations.read(fixture.id)).toEqual(requests);
  expect(store.capabilityRecoveryStatus().numerical).toBe(1);
  const newTarget=store.metrics.setTarget({...fixture.numerical,inputKey:"different-input"});
  store.metrics.publishObserved(newTarget,fixture.value);
  store.upsertObservation({...fixture.observation,generation:store.beginScan("imports")});capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(2);
  expect(store.metrics.read(fixture.id).find(e=>e.target.slot==="numerical")?.result).toBeUndefined();
  expect(JSON.parse(String(store["db"].prepare("SELECT payload FROM metric_results WHERE replay_id=? AND slot='numerical' AND input_key='old-v6'").get(fixture.id)?.payload)).provenance.capabilityAttempt).toBe("stable-prefix-v3");
});

it.each(["off","demand","pause"])("keeps capability maintenance pending under %s and resumes without touching known P",policy=>{
  const {id}=capabilityFixture(),map=store.metrics.read(id).find(e=>e.target.slot==="calculated-map");
  store.enableNumericalAdmission();store.enablePerformanceAdmission();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:policy==="pause"?"bg":policy as "off"|"demand",userPaused:policy==="pause"});
  expect(store.capabilityRecoveryStatus().state).toBe("held");expect(store.maintainCapabilityRecovery()).toBe(false);
  expect(store.metrics.read(id).find(e=>e.target.slot==="numerical")?.result).toBeDefined();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"bg",userPaused:false});capabilityPages();
  expect(store.metrics.read(id).find(e=>e.target.slot==="numerical")?.result).toBeUndefined();
  expect(store.metrics.read(id).find(e=>e.target.slot==="calculated-map")).toEqual(map);
});

it.each(["queued","running"])("does not advance over %s ownership, and resumes on ordinary completion",state=>{
  const {id}=capabilityFixture();store.preparations.request(id,"P","retry");
  const ticket=state==="running"?store.preparations.claim(id,"P"):undefined;
  store.enableNumericalAdmission();store.enablePerformanceAdmission();
  const before=store.preparations.read(id);expect(store.maintainCapabilityRecovery()).toBe(false);
  expect(store.capabilityRecoveryStatus()).toMatchObject({cursor:"",processed:0,state:"pending"});expect(store.preparations.read(id)).toEqual(before);
  if(ticket)store.preparations.complete(ticket,[requiredCapability(store.metrics.readTarget(id,"calculated-map"))]);else finishCachedPreparation(id);
  capabilityPages();expect(store.capabilityRecoveryStatus().numerical).toBe(1);
});

it("does not supersede an active dependent metric ticket or clear its later failure",()=>{
  const {id}=capabilityFixture(),numerical=requiredCapability(store.metrics.readTarget(id,"numerical"));
  const timeline=store.metrics.setTarget(libraryTimelineTarget(numerical)),request=store.metrics.request(timeline,"background");
  if(!("id" in request))throw Error("Missing timeline job");const ticket=requiredCapability(store.metrics.claim(request.id));
  store.enableNumericalAdmission();store.enablePerformanceAdmission();const before=store.metrics.read(id);
  expect(store.maintainCapabilityRecovery()).toBe(false);expect(store.metrics.read(id)).toEqual(before);
  expect(store.capabilityRecoveryStatus().processed).toBe(0);expect(store.metrics.isEligible(ticket)).toBe(true);
  store.metrics.fail(ticket,"Native ownership was not confirmed");capabilityPages();
  expect(store.metrics.readTarget(id,"numerical")).toEqual(numerical);
  expect(store.metrics.read(id).find(e=>e.target.slot==="timeline-pp")?.job).toMatchObject({state:"failed",error:"Native ownership was not confirmed"});
  expect(store.capabilityRecoveryStatus().numerical).toBe(0);
});

it.each([false,true])("does not reopen completed capability recovery for unchanged Relax observations (restart=%s)",restart=>{
  const fixture=capabilityFixture(128);store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  const before=store.capabilityRecoveryStatus(),metrics=store.metrics.read(fixture.id),requests=store.preparations.read(fixture.id);
  expect(before).toMatchObject({complete:true,deferred:null,numerical:0});
  if(restart){store.close();store=new LibraryStore(database,"repeat-source-check");store.enableNumericalAdmission();store.enablePerformanceAdmission();}
  for(let repeat=0;repeat<2;repeat++){
    store.upsertObservation({...fixture.observation,generation:store.beginScan("imports")});
    expect(store.capabilityRecoveryStatus()).toEqual(before);
    expect(store.maintainCapabilityRecovery()).toBe(false);
    expect(store.metrics.read(fixture.id)).toEqual(metrics);expect(store.preparations.read(fixture.id)).toEqual(requests);
  }
});

it.each(["failed","reason","known-dependent","error-dependent","unavailable-dependent","mismatched-dependent","known-P"])(
  "does not defer protected %s evidence after an unchanged source check",fault=>{
    const fixture=capabilityFixture(),numerical=requiredCapability(store.metrics.readTarget(fixture.id,"numerical"));
    if(fault==="failed"){
      store.preparations.request(fixture.id,"P","retry");store.preparations.fail(requiredCapability(store.preparations.claim(fixture.id,"P")),"retained failure");
    }else if(fault==="reason"){
      store.metrics.publishObserved(numerical,{...fixture.value,fields:{...fixture.value.fields,ur:{state:"unknown",reason:"unsupported-recording"}}});
    }else if(fault==="known-P"){
      store.metrics.bindPreparedResultInTransaction({replayId:fixture.id,slot:"aggregate-pp",stage:"P",inputKey:"saved-score",producerVersion:LIBRARY_P_PRODUCER_VERSION},
        {fields:{pp:{state:"known",value:20}},provenance:{}});
    }else{
      const input=libraryTimelineTarget(numerical),target=store.metrics.setTarget({...input,...(fault==="mismatched-dependent"?{inputKey:"different-source"}:{})});
      store.metrics.publishObserved(target,{fields:{peakPp:fault==="known-dependent"?{state:"known",value:20}:fault==="error-dependent"?{state:"error",reason:"bad-input"}:
        fault==="unavailable-dependent"?{state:"not-applicable",reason:"unsupported-recording"}:{state:"unknown",reason:"performance-data-unavailable"}},provenance:{coverageQualified:false}});
    }
    store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
    const progress=store.capabilityRecoveryStatus(),metrics=store.metrics.read(fixture.id),requests=store.preparations.read(fixture.id);
    expect(progress).toMatchObject({complete:true,deferred:null,numerical:0});
    store.upsertObservation({...fixture.observation,generation:store.beginScan("imports")});
    expect(store.capabilityRecoveryStatus()).toEqual(progress);expect(store.maintainCapabilityRecovery()).toBe(false);
    expect(store.metrics.read(fixture.id)).toEqual(metrics);expect(store.preparations.read(fixture.id)).toEqual(requests);
  });

it.each(["queued","running"])("retains a newly available candidate behind %s ownership until the ordinary wake",state=>{
  const fixture=capabilityFixture();store.upsertObservation({...fixture.observation,available:false});
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus()).toMatchObject({complete:true,numerical:0});
  store.preparations.request(fixture.id,"P","retry");
  const ticket=state==="running"?store.preparations.claim(fixture.id,"P"):undefined;
  store.upsertObservation({...fixture.observation,available:true,generation:store.beginScan("imports")});
  const progress=store.capabilityRecoveryStatus(),before=store.metrics.read(fixture.id),requests=store.preparations.read(fixture.id);
  expect(progress).toMatchObject({state:"pending",deferred:fixture.id,numerical:0});
  expect(store.maintainCapabilityRecovery()).toBe(false);expect(store.capabilityRecoveryStatus()).toEqual(progress);
  expect(store.metrics.read(fixture.id)).toEqual(before);expect(store.preparations.read(fixture.id)).toEqual(requests);
  if(ticket)store.preparations.complete(ticket,[fixture.map]);
  finishCachedPreparation(fixture.id);
  capabilityPages();expect(store.capabilityRecoveryStatus().numerical).toBe(1);
});

it("does not defer an unknown P map without its restorable recipe",()=>{
  const fixture=capabilityFixture(128),map=requiredCapability(store.metrics.readTarget(fixture.id,"calculated-map"));
  store.metrics.publishObserved(map,{fields:{bpm:{state:"unknown",reason:"tempo-geometry-budget"},mapStars:{state:"known",value:2}},provenance:{}});
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  const progress=store.capabilityRecoveryStatus(),metrics=store.metrics.read(fixture.id);
  expect(progress).toMatchObject({complete:true,numerical:0,performance:0});
  store.upsertObservation({...fixture.observation,generation:store.beginScan("imports")});
  expect(store.capabilityRecoveryStatus()).toEqual(progress);expect(store.maintainCapabilityRecovery()).toBe(false);
  expect(store.metrics.read(fixture.id)).toEqual(metrics);
});

it.each(["known","failed","relax"])("preserves protected %s evidence during automatic capability recovery",kind=>{
  const {id,numerical}=capabilityFixture(kind==="relax"?128:0);
  if(kind==="known")store.metrics.publishObserved(requiredCapability(store.metrics.readTarget(id,"numerical")),{fields:{ur:{state:"known",value:100}},provenance:{coverageQualified:true}});
  if(kind==="failed"){store.preparations.request(id,"P","retry");store.preparations.fail(requiredCapability(store.preparations.claim(id,"P")),"original failure");}
  const before=store.metrics.read(id),requests=store.preparations.read(id);
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.metrics.read(id)).toEqual(before);expect(store.preparations.read(id)).toEqual(requests);
  expect(store.metrics.readTarget(id,"numerical")?.inputKey).toBe(numerical.inputKey);
  expect(store.capabilityRecoveryStatus().numerical).toBe(0);
});

it.each([true,false])("keeps preparation eligibility silent and leaves projection work to its owner (eligible=%s)",eligible=>{
  const id=observe("imports","eligibility",shaA,store.beginScan("imports"));
  store.preparations.request(id,"P","selection");const ticket=store.preparations.claim(id,"P");if(!ticket)throw Error("Missing P ticket");
  while(store.queryProjectionPending())store.maintainQueryProjection();
  const location=store.openLocationCandidates(id).items[0],db=store["db"],changed=jest.fn(),dirty=jest.fn(),wake=jest.fn();
  db.prepare("UPDATE replays SET favourite=1 WHERE id=?").run(id);
  const snapshot=()=>["query_projection","query_projection_state","query_projection_dirty","analysis_requests"].map(table=>db.prepare("SELECT * FROM "+table+" ORDER BY rowid").all()),before=snapshot(),changes=db.prepare("SELECT total_changes() n").get()?.n;
  store.onLibraryChanged(changed);store.onAnalysisDirty(dirty);store.onMaintenanceNeeded(wake);
  expect(store.analysisEligible({kind:"preparation",ticket,location:{...location,sourceConfigRevision:location.sourceConfigRevision+(eligible?0:1)}})).toBe(eligible);
  expect(changed).not.toHaveBeenCalled();expect(dirty).not.toHaveBeenCalled();expect(wake).toHaveBeenCalledTimes(1);
  expect(snapshot()).toEqual(before);expect(db.prepare("SELECT total_changes() n").get()?.n).toBe(changes);
  expect(store.queryProjectionPending()).toBe(1);
});

it("retains ordinary metric eligibility reconciliation and real P publication notifications",()=>{
  const id=observe("imports","publication",shaA,store.beginScan("imports")),changed=jest.fn(),dirty=jest.fn();
  store.onLibraryChanged(changed);store.onAnalysisDirty(dirty);
  const target=store.metrics.setTarget({replayId:id,stage:"P",slot:"aggregate-pp",inputKey:"fixture-p",producerVersion:"fixture-p-v1"});
  const request=store.metrics.request(target,"selection");if(!("id" in request))throw Error("Missing metric request");
  const ticket=store.metrics.claim(request.id);if(!ticket)throw Error("Missing metric ticket");
  expect(dirty).toHaveBeenCalled();while(store.queryProjectionPending())store.maintainQueryProjection();
  store["db"].prepare("UPDATE replays SET favourite=1 WHERE id=?").run(id);changed.mockClear();
  const reconcile=jest.spyOn(store["numericalRecipes"],"reconcileInTransaction");
  expect(store.analysisEligible({kind:"metric",ticket})).toBe(true);
  expect(reconcile).toHaveBeenCalledWith(id);reconcile.mockRestore();
  expect(store.queryProjectionPending()).toBe(0);expect(changed).toHaveBeenCalledTimes(1);
  changed.mockClear();expect(store.metrics.commit({ticket,producerVersion:ticket.producerVersion,fields:{pp:{state:"known",value:42}},provenance:{replaySha256:shaA}})).toBe("applied");
  expect(changed).toHaveBeenCalledTimes(1);expect(store.createQueryReader().detail(id)?.item.values.pp).toBe(42);
  store.preparations.request(id,"P","selection");const preparation=store.preparations.claim(id,"P");if(!preparation)throw Error("Missing preparation ticket");
  changed.mockClear();
  expect(store.preparations.completeResults(preparation,[{stage:"P",slot:"aggregate-pp",inputKey:"prepared-p",producerVersion:"fixture-p-v1",fields:{pp:{state:"known",value:43}},provenance:{replaySha256:shaA}}],()=>({state:"applied",replayId:id}))).toEqual({state:"applied",replayId:id});
  expect(changed).toHaveBeenCalledTimes(1);expect(store.createQueryReader().detail(id)?.item.values.pp).toBe(43);
});

it("persists only explicitly listed player names and invalidates reads without admitting analysis",()=>{
  const dirty=jest.fn(),changed=jest.fn();store.onAnalysisDirty(dirty);store.onLibraryChanged(changed);
  const before=store["db"].prepare("SELECT revision FROM query_projection_state").get()?.revision;
  expect(store.playerNames()).toEqual([]);
  store.setPlayerNames(["  Lark_OLD ","lark_old","KIRIN_","ÉCHO"]);
  expect(store.playerNames()).toEqual(["Lark_OLD","KIRIN_","ÉCHO"]);
  expect(Number(store["db"].prepare("SELECT revision FROM query_projection_state").get()?.revision)).toBeGreaterThan(Number(before));
  const after=store["db"].prepare("SELECT revision FROM query_projection_state").get()?.revision;
  store.setPlayerNames(["Lark_OLD","KIRIN_","ÉCHO"]);
  expect(store["db"].prepare("SELECT revision FROM query_projection_state").get()?.revision).toBe(after);
  expect(dirty).not.toHaveBeenCalled();expect(changed).toHaveBeenCalledTimes(1);
  store.close();store=new LibraryStore(database,"names-reopen");
  expect(store.playerNames()).toEqual(["Lark_OLD","KIRIN_","ÉCHO"]);
  expect(()=>store.setPlayerNames([""])).toThrow();expect(()=>store.setPlayerNames(["x".repeat(257)])).toThrow();
  expect(()=>store.setPlayerNames(["valid\0invalid"])).toThrow();
  expect(()=>store.setPlayerNames(Array(101).fill("name"))).toThrow();
  store.setPlayerNames([]);expect(store.playerNames()).toEqual([]);
});

it("distinguishes a never-found source from partial retained index history",()=>{
  expect(store.sourceHasIndexHistory("stable")).toBe(false);
  expect(store.sourceHasIndexHistory("missing")).toBe(false);
  observe("stable","partial",null,store.beginScan("stable"));
  expect(store.sourceHasIndexHistory("stable")).toBe(true);
  expect(store["db"].prepare("SELECT baseline_complete FROM sources WHERE id='stable'").get()?.baseline_complete).toBe(0);
  store.setSourceEnabled("stable",false);expect(store.sourceHasIndexHistory("stable")).toBe(true);
});

it.each(["界","\u0001"])("round-trips maximum explicit names through the real Store and Reader (%j)",character=>{
  const names=Array.from({length:100},(_,i)=>`é${String(i).padStart(2,"0")}:`+character.repeat(252));
  store.setPlayerNames(names);const reader=store.createQueryReader();
  expect(Buffer.byteLength(JSON.stringify(names))).toBeGreaterThan(65536);
  expect(store.playerNames()).toEqual(names);expect(reader.playerNames()).toEqual(names);
  const id=store.upsertObservation({sourceId:"imports",sourceKey:"name",locator:"name",sha256:shaA,available:true,
    generation:store.beginScan("imports"),addedAt:1,metadata:{header:{mode:0,player:names[0].toUpperCase()}}});
  expect(reader.page({filters:[{field:"player",values:[],me:true}]}).items.map(item=>item.id)).toEqual([id]);
});

it("counts indexed standard and unknown modes exactly during repair while retaining disabled identities",()=>{
  const standard=observe("imports","standard",shaA,store.beginScan("imports"));
  observe("imports","unknown",shaB,store.beginScan("imports"));
  const excluded=store.upsertObservation({sourceId:"stable",sourceKey:"other-mode",locator:"other-mode",sha256:"c".repeat(64),available:true,
    generation:store.beginScan("stable"),addedAt:1,metadata:{savedScore:{header:{mode:2}}}});
  expect(store.replayCount()).toBe(2);
  store.setSourceEnabled("imports",false);expect(store.replayCount()).toBe(2);
  store["db"].prepare("UPDATE query_projection SET filter_evidence_revision=NULL,standard_excluded=0 WHERE id=?").run(excluded);
  expect(store.replayCount()).toBe(2);
  store["db"].prepare("UPDATE locations SET metadata=? WHERE replay_id=?").run(JSON.stringify({header:{mode:3}}),standard);
  expect(store.replayCount()).toBe(1);
  expect(store["db"].prepare("SELECT count(*) AS n FROM replays WHERE merged_into IS NULL").get()?.n).toBe(3);
});

it("fences library reuse after another location establishes nonstandard mode without mutating viewer inputs",()=>{
  const id=store.upsertObservation({sourceId:"imports",sourceKey:"viewer",locator:"viewer",sha256:shaA,available:true,
    generation:store.beginScan("imports"),addedAt:1,metadata:{header:{mode:0}}});
  const recipe:LibraryNumericalInputRecipe={version:1,replaySha256:shaA,fixedKey:"d".repeat(64),intrinsicNative:false,
    embeddedModsHash:null,legacyModsHash:"e".repeat(64),modeQualified:true,consumedModsSource:"legacy-mask"};
  const profile=numericalProfileKey(recipe,{origin:null,native:{state:"absent"}});if(profile.state!=="known")throw Error("Fixture profile unavailable");
  const descriptor:LibraryNumericalResourceDescriptor={input:{format:"resources",replayBytes:100,mapBytes:100,
    binding:{replaySha256:shaA,mapSha256:shaB,mapMd5:"c".repeat(32),exactMapAndProfile:true}},origin:null,recipe,
    target:{slot:"numerical",stage:"S",inputKey:profile.inputKey,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION}};
  const location=store.openLocationCandidates(id).items[0];
  const binding=store.bindCurrentReplay(location,{sha256:shaA,available:true,metadata:location.metadata},undefined,descriptor);
  if(binding.state!=="applied")throw Error("Fixture authority unavailable");
  const results:LibraryCurrentReplayResult[]=[{slot:"numerical",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,metrics:{
    fields:{misses:{state:"known",value:0}},provenance:{replaySha256:shaA,mapSha256:shaB,mapMd5:"c".repeat(32),parserVersion:LIBRARY_REPLAY_PARSER_VERSION,
      preparationVersion:LIBRARY_RESOURCE_PREPARATION_VERSION,scoreOrigin:"reconstructed",ruleset:"stable",rate:1,
      coverageQualified:true,projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION}}}];
  const viewerBefore=JSON.stringify({descriptor,results});
  store.upsertObservation({sourceId:"stable",sourceKey:"duplicate",locator:"duplicate",sha256:shaA,available:true,
    generation:store.beginScan("stable"),addedAt:2,metadata:{savedScore:{header:{mode:2}}}});
  expect(store.publishCurrentReplay(binding.authority,results)).toEqual({state:"stale",accepted:[]});
  const current=store.openLocationCandidates(id).items.find(item=>item.sourceId==="imports");if(!current)throw Error("Missing source");
  expect(store.bindCurrentReplay(current,{sha256:shaA,available:true,metadata:current.metadata},undefined,descriptor)).toEqual({state:"stale"});
  expect(store.metrics.read(id).find(entry=>entry.target.slot==="numerical")?.result).toBeUndefined();
  expect(JSON.stringify({descriptor,results})).toBe(viewerBefore);
});

it("does not exclude an unknown mode as though it were known nonstandard",()=>{
  store.enableNumericalAdmission();store.enablePerformanceAdmission();
  const id=observe("stable","unknown-mode",shaA,store.beginScan("stable"));
  expect(store.preparations.read(id).map(item=>item.stage)).toEqual(["P","S"]);
});

it.each(["stable","replays","lazer","imported"] as const)("never admits known nonstandard %s rows, retaining their source records",kind=>{
  const sourceId=`mode-${kind}`;store.registerSource({id:sourceId,kind,directory:`C:\\${sourceId}`});
  store.enableNumericalAdmission();store.enablePerformanceAdmission();
  const metadata=kind==="lazer"?{nativeScore:{ruleset:3}}:kind==="stable"?{savedScore:{header:{mode:2}}}:{header:{mode:1}};
  const id=store.upsertObservation({sourceId,sourceKey:"nonstandard",locator:"nonstandard",sha256:shaA,available:true,
    generation:store.beginScan(sourceId),addedAt:1,metadata});
  expect(store.preparations.read(id)).toEqual([]);expect(store.metrics.nextQueued()).toEqual([]);
  expect(store["db"].prepare("SELECT count(*) AS n FROM locations WHERE replay_id=?").get(id)?.n).toBe(1);
});

it("upgrades schema21 without downgrading an active historical source reconciliation scope",()=>{
  for(let i=0;i<4;i++)observe("stable",String(i),i.toString(16).padStart(64,"0"),store.beginScan("stable"));
  while(store.queryProjectionPending())store.maintainQueryProjection();
  // Reconstruct the pre-visibility source trigger as well as the pre-C/query schema.
  // A current admission queue would otherwise make the migration assertion vacuous.
  // Restore pre-journal resource triggers before simulating the historical schema.
  for (const row of store["db"].prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'query_resource_%'").all()) {
    const old = String(row.sql).replace(/BEGIN[\s\S]*END$/, "BEGIN UPDATE query_projection_state SET resource_revision=resource_revision+1 WHERE id=1; END");
    store["db"].exec(`DROP TRIGGER ${row.name};${old}`);
  }
  store["db"].exec("DROP TABLE resource_changes");
  store["db"].exec(`INSERT INTO query_projection_scopes(kind,scope_id) VALUES('source-locations','stable');
    DROP TRIGGER query_dirty_sources_update;
    CREATE TRIGGER query_dirty_sources_update AFTER UPDATE OF enabled,configured,config_revision ON sources
    WHEN OLD.enabled IS NOT NEW.enabled OR OLD.configured IS NOT NEW.configured OR OLD.config_revision IS NOT NEW.config_revision BEGIN
    INSERT INTO query_projection_scopes(kind,scope_id) SELECT 'source-locations',NEW.id
      WHERE (OLD.enabled IS NOT NEW.enabled OR OLD.configured IS NOT NEW.configured) AND EXISTS(SELECT 1 FROM locations WHERE source_id=NEW.id)
      ON CONFLICT(kind,scope_id) DO UPDATE SET desired_version=desired_version+1;
    INSERT INTO query_projection_scopes(kind,scope_id) SELECT 'map-source',NEW.id
      WHERE (OLD.enabled IS NOT NEW.enabled OR OLD.configured IS NOT NEW.configured) AND EXISTS(SELECT 1 FROM maps WHERE source_id=NEW.id)
      ON CONFLICT(kind,scope_id) DO UPDATE SET desired_version=desired_version+1;
    INSERT INTO query_projection_scopes(kind,scope_id) SELECT 'c-source',NEW.id WHERE EXISTS(SELECT 1 FROM incident_recipes WHERE source_id=NEW.id)
      ON CONFLICT(kind,scope_id) DO UPDATE SET desired_version=desired_version+1;
    UPDATE query_projection_state SET revision=revision+1 WHERE id=1; END;
    DROP TABLE source_admission_scopes;
    DROP INDEX IF EXISTS query_projection_analysis_filter_cover;
    DROP INDEX IF EXISTS query_projection_favourite_filter_cover;
    DROP INDEX query_filter_evidence_pending;DROP INDEX query_projection_player_folded;
    DROP INDEX query_projection_result;DROP INDEX query_projection_recording_client;DROP TABLE query_filter_evidence_state;
    ALTER TABLE query_projection DROP COLUMN recorded_completion;ALTER TABLE query_projection DROP COLUMN recording_client;
    ALTER TABLE query_projection DROP COLUMN standard_excluded;ALTER TABLE query_projection DROP COLUMN player_folded;
    ALTER TABLE query_projection DROP COLUMN break_evidence;ALTER TABLE query_projection DROP COLUMN filter_evidence_revision;
    DROP INDEX IF EXISTS query_projection_analysis_cover;
    DROP TABLE query_analysis_algorithm_state;ALTER TABLE query_projection DROP COLUMN analysis_algorithm;
    DROP INDEX query_c_fallback_pending;DROP TABLE query_c_identity_state;
    ALTER TABLE query_projection DROP COLUMN c_identity;ALTER TABLE query_projection DROP COLUMN analysis_without_c;
    ALTER TABLE query_projection DROP COLUMN analysis_error_without_c;PRAGMA user_version=21;`);
  expect(store["db"].prepare("PRAGMA user_version").get()?.user_version).toBe(21);
  expect(store["db"].prepare("PRAGMA table_info(query_projection)").all().filter(row=>
    ["c_identity","analysis_without_c","analysis_error_without_c","analysis_algorithm"].includes(String(row.name)))).toEqual([]);
  expect(store["db"].prepare(`SELECT name FROM sqlite_master WHERE name IN
    ('source_admission_scopes','query_c_identity_state','query_analysis_algorithm_state','query_c_fallback_pending','query_projection_analysis_cover')`).all()).toEqual([]);
  const bind=jest.spyOn(LibraryStore.prototype as unknown as {bindSourceScore:(id:string)=>void},"bindSourceScore");
  store.close();store=new LibraryStore(database,"upgraded");
  expect(store["db"].prepare("PRAGMA user_version").get()?.user_version).toBe(27);
  expect(store["db"].prepare("PRAGMA index_info(query_projection_analysis_cover)").all().map(row=>row.name))
    .toEqual(["visible","id","c_identity","analysis_algorithm","analysis","analysis_without_c"]);
  expect(store["db"].prepare("SELECT kind,scope_id FROM source_admission_scopes").all()).toEqual([
    expect.objectContaining({kind:"source",scope_id:"stable"})]);
  expect(store.sourceAdmissionPending()).toBeGreaterThan(0);
  store.setSourceEnabled("stable",false);
  while(store.queryProjectionPending())store.maintainQueryProjection();
  expect(bind).toHaveBeenCalledTimes(4);expect(store.createQueryReader().page({}).total).toBe(0);
  expect(store.sourceAdmissionPending()).toBeGreaterThan(0);bind.mockRestore();
});

it("treats configured-source removal and restoration as visibility with durable admission",()=>{
  observe("stable","one",shaA,store.beginScan("stable"));
  store.reconcileSources([{id:"imports",kind:"imported",directory:"C:\\app-owned"}]);
  while(store.queryProjectionPending())store.maintainQueryProjection();
  expect(store.createQueryReader().page({}).total).toBe(0);expect(store.sourceAdmissionPending()).toBeGreaterThan(0);
  store.reconcileSources([{id:"stable",kind:"stable",directory:"C:\\osu"},{id:"imports",kind:"imported",directory:"C:\\app-owned"}]);
  while(store.queryProjectionPending())store.maintainQueryProjection();
  expect(store.createQueryReader().page({}).total).toBe(1);expect(store.sourceAdmissionPending()).toBeGreaterThan(0);
});

it("applies the 64 MiB pager cache target to every Store connection without persisting a database default", () => {
  const runtimeDefaults = new DatabaseSync(":memory:");
  const independent = new DatabaseSync(database);
  let second: LibraryStore | undefined;
  try {
    expect(store["db"].prepare("PRAGMA cache_size").get()?.cache_size).toBe(-65536);
    second = new LibraryStore(database, "parallel-session");
    expect(second["db"].prepare("PRAGMA cache_size").get()?.cache_size).toBe(-65536);
    expect(independent.prepare("PRAGMA cache_size").get()).toEqual(runtimeDefaults.prepare("PRAGMA cache_size").get());
    second.close();
    store.close();
    store = new LibraryStore(database, "reopened-session");
    expect(store["db"].prepare("PRAGMA cache_size").get()?.cache_size).toBe(-65536);
    expect(store["db"].prepare("PRAGMA default_cache_size").get()).toEqual(runtimeDefaults.prepare("PRAGMA default_cache_size").get());
  } finally {
    second?.close();
    independent.close();
    runtimeDefaults.close();
  }
});

it("preserves atomic user edits, recovery and integrity with the configured pager cache", () => {
  const replay = observe("imports", "owned", shaA, store.beginScan("imports"));
  const paletteBefore = store["db"].prepare("SELECT value FROM counters WHERE key='palette'").get();
  store["db"].exec(`CREATE TEMP TRIGGER reject_test_membership BEFORE INSERT ON memberships
    BEGIN SELECT RAISE(ABORT, 'test membership failure'); END;`);
  expect(() => store.createCollection("Rejected", null, replay)).toThrow("test membership failure");
  expect(store.listCollections()).toEqual([]);
  expect(store["db"].prepare("SELECT value FROM counters WHERE key='palette'").get()).toEqual(paletteBefore);
  expect(store.getReplay(replay)?.collectionIds).toEqual([]);
  store["db"].exec("DROP TRIGGER reject_test_membership");
  const collection = store.createCollection("Saved", null, replay);
  store.setReview(replay, "reviewed");
  store.close();
  store = new LibraryStore(database, "recovered-session");
  expect(store.getReplay(replay)).toMatchObject({ review: "reviewed", collectionIds: [collection] });
  expect(store.integrityCheck()).toBe("ok");
  expect(store["db"].prepare("PRAGMA cache_size").get()?.cache_size).toBe(-65536);
});

it("keeps analysis on exact native provenance across duplicate pages and disabled native locations", () => {
  const generation=store.beginScan("imports");let id="";
  for(let i=0;i<12;i++)id=observe("imports","copy-"+i,shaA,generation);
  store.registerSource({id:"z-native",kind:"lazer",directory:"C:\\native"});
  const nativeGeneration=store.beginScan("z-native");
  store.upsertObservation({sourceId:"z-native",sourceKey:"score",locator:"C:\\native\\blob",sha256:shaA,available:true,
    generation:nativeGeneration,addedAt:1,metadata:{nativeScore:{isLegacyScore:false,replay:{sha256:shaA},mods:[{acronym:"DT",settings:{speed_change:1.2}}]}}});
  expect(store.openLocationCandidates(id).items[0].kind).toBe("imported");
  const native=store.openLocationCandidates(id,undefined,8,true);
  expect(native.items.map(item=>item.sourceId)).toEqual(["z-native"]);expect(native.next).toBeUndefined();
  store.setSourceEnabled("z-native",false);
  expect(store.openLocationCandidates(id,undefined,8,true).items).toEqual([]);
  expect(store.openLocationCandidates(id).items[0].kind).toBe("imported");
});

it("does not infer native recording from legacy DB records or unbound metadata",()=>{
  const id=observe("imports","copy",shaA,store.beginScan("imports"));
  store.registerSource({id:"native",kind:"lazer",directory:"C:\\native"});const generation=store.beginScan("native");
  for(const [key,isLegacyScore,sha256] of [["legacy",true,shaA],["unbound",false,shaB]] as const)
    store.upsertObservation({sourceId:"native",sourceKey:key,locator:key,sha256:shaA,available:true,generation,addedAt:1,
      metadata:{nativeScore:{isLegacyScore,replay:{sha256}}}});
  expect(store.openLocationCandidates(id,undefined,8,true).items[0].kind).toBe("imported");
});

it("pages selected replay locations without losing aliases or including disabled sources", () => {
  const generation = store.beginScan("stable");
  const provisional = observe("stable", "a", null, generation);
  const imports = store.beginScan("imports");
  const canonical = observe("imports", "owned", shaA, imports);
  observe("stable", "a", shaA, generation); observe("stable", "b", shaA, generation);
  store.setReview(provisional, "needs-another-look");
  const first = store.openLocationCandidates(provisional, undefined, 1);
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({ replayId: canonical, sourceId: "imports", kind: "imported", sha256: shaA });
  expect(first.next).toEqual({ sourceId: "imports", sourceKey: "owned" });
  const second = store.openLocationCandidates(provisional, first.next, 1);
  expect(second.items[0]).toMatchObject({ sourceId: "stable", sourceKey: "a", directory: "C:\\osu" });
  store.setSourceEnabled("stable", false);
  expect(store.openLocationCandidates(provisional, first.next).items).toEqual([]);
  expect(store.getReplay(canonical)?.review).toBe("needs-another-look");
  expect(() => store.openLocationCandidates(canonical, undefined, 1000)).toThrow("limit");
});

it("keeps selected-location pages within IPC bytes without dropping wide valid rows", () => {
  store.registerSource({ id: "wide", kind: "replays", directory: "根".repeat(32768) });
  const generation = store.beginScan("wide");
  let id = "";
  for (let index = 0; index < 8; index++) id = store.upsertObservation({ sourceId: "wide", sourceKey: String(index) + "你".repeat(32767),
    locator: "路".repeat(32768), sha256: shaA, available: true, generation, addedAt: 1, metadata: { text: "x".repeat(65000) } });
  let cursor: { sourceId: string; sourceKey: string } | undefined;
  const keys: string[] = [];
  do {
    const page = store.openLocationCandidates(id, cursor);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1536 * 1024);
    expect(page.items.length).toBeGreaterThan(0);
    keys.push(...page.items.map(item => item.sourceKey[0]));
    cursor = page.next;
  } while (cursor);
  expect(keys).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
});

it("serves bounded stable-key location pages and individual cached observations", () => {
  const generation = store.beginScan("stable");
  observe("stable", "c", shaA, generation); observe("stable", "a", shaA, generation); observe("stable", "b", shaA, generation);
  expect(store.sourceLocations("stable", "", 2).map(row => row.sourceKey)).toEqual(["a", "b"]);
  expect(store.sourceLocations("stable", "b", 2).map(row => row.sourceKey)).toEqual(["c"]);
  expect(store.sourceObservation("stable", "a")).toMatchObject({ sourceKey: "a", sha256: shaA, available: true });
  expect(store.sourceObservation("stable", "missing")).toBeUndefined();
  expect(() => store.sourceLocations("stable", "", 10000)).toThrow(/limit/i);
});

it("keeps an import committed during an exhaustive imported-source scan available", () => {
  const generation = store.beginScan("imports");
  const intent = store.prepareImport("imports", shaA, {}, 10);
  const id = store.completeImport(intent.id, "C:\\app-owned\\copy.osr");
  store.finishScan("imports", generation);
  expect(store.getReplay(id)?.locations[0].available).toBe(true);
});

it("rejects a stale imported scan observation after explicit import publication repaired the location", () => {
  const first = store.prepareImport("imports", shaA, {}, 1); const id = store.completeImport(first.id, "owned.osr");
  const generation = store.beginScan("imports"); const stale = store.sourceObservation("imports", shaA);
  expect(stale).toBeDefined();
  if (!stale) throw new Error("Expected an imported location");
  const repair = store.prepareImport("imports", shaA, { fileState: "readable" }, 2); store.completeImport(repair.id, "owned.osr");
  store.upsertObservation({ ...stale, sourceId: "imports", generation, addedAt: 3, sha256: null, available: false, metadata: { fileState: "missing" } });
  store.finishScan("imports", generation);
  expect(store.getReplay(id)?.locations[0]).toMatchObject({ available: true, metadata: { fileState: "readable" } });
});

it("deduplicates exact bytes across sources and retains every location", () => {
  const stable = store.beginScan("stable");
  const imports = store.beginScan("imports");
  const first = observe("stable", "cache.osr", shaA, stable);
  const imported = observe("imports", "owned.osr", shaA, imports);
  expect(imported).toBe(first);
  expect(store.getReplay(first)).toMatchObject({ id: first, isNew: false, locations: [expect.anything(), expect.anything()] });
  expect(store.listReplayIds()).toEqual([first]);
  expect(store.getReplay(first)?.metadata.playedAtTicks).toBe("638961337234567891");
});

it("retains known identity when replay bytes temporarily disappear and restores it without NEW", () => {
  const first = store.beginScan("stable");
  const replay = observe("stable", "cache.osr", shaA, first);
  store.setReview(replay, "reviewed");
  store.finishScan("stable", first);
  const next = store.beginScan("stable");
  expect(observe("stable", "cache.osr", null, next)).toBe(replay);
  expect(store.getReplay(replay)).toMatchObject({ review: "reviewed", isNew: false, locations: [expect.objectContaining({ available: false })] });
  expect(observe("stable", "cache.osr", shaA, next)).toBe(replay);
  expect(store.getReplay(replay)?.locations[0].available).toBe(true);
  expect(store.listReplayIds()).toEqual([replay]);
});

it("preserves last verified fields while exposing a new location read error", () => {
  const generation = store.beginScan("stable");
  const id = store.upsertObservation({ sourceId: "stable", sourceKey: "cache", locator: "cache.osr", sha256: shaA, available: true,
    generation, addedAt: 1, metadata: { player: "Verified", fileState: "readable" } });
  store.upsertObservation({ sourceId: "stable", sourceKey: "cache", locator: "cache.osr", sha256: null, available: false,
    generation, addedAt: 1, metadata: { player: "Unverified change", fileState: "error", reason: "Replay changed during hashing" } });
  expect(store.getReplay(id)?.locations[0]).toMatchObject({ available: false, sha256: shaA,
    metadata: { player: "Verified", fileState: "error", reason: "Replay changed during hashing" } });
});

it("never deduplicates distinct content using matching names, dates or totals", () => {
  const scan = store.beginScan("stable");
  expect(observe("stable", "first.osr", shaA, scan)).not.toBe(observe("stable", "second.osr", shaB, scan));
});

it("merges provisional identity only on byte proof while retaining reviews and collections", () => {
  const scan = store.beginScan("stable");
  const importedScan = store.beginScan("imports");
  const provisional = observe("stable", "native-row", null, scan);
  const known = observe("imports", "copy.osr", shaA, importedScan, 20);
  const collection = store.createCollection("Practice");
  store.setMembership(provisional, collection, true);
  store.setFavourite(provisional, true);
  store.setReview(known, "reviewed");
  store.setReview(provisional, "needs-another-look");
  expect(observe("stable", "native-row", shaA, scan, 30)).toBe(known);
  expect(store.resolveId(provisional)).toBe(known);
  expect(store.getReplay(provisional)).toMatchObject({ id: known, firstAddedAt: 10, isNew: false, favourite: true, review: "needs-another-look", collectionIds: [collection] });
  expect(store.reviewHistory(known).map(edit => edit.state)).toEqual(["reviewed", "needs-another-look"]);
  expect(store.listReplayIds()).toEqual([known]);
});

it("a changed file creates another replay and keeps the old replay's user metadata", () => {
  const scan = store.beginScan("stable");
  const original = observe("stable", "same-path.osr", shaA, scan);
  store.setReview(original, "reviewed");
  const replacement = observe("stable", "same-path.osr", shaB, scan);
  expect(replacement).not.toBe(original);
  expect(store.getReplay(original)).toMatchObject({ review: "reviewed", locations: [] });
  expect(store.getReplay(replacement)).toMatchObject({ review: "not-reviewed", locations: [expect.anything()] });
});

it("keeps interrupted initial scans as baseline across restart; only new later identities are NEW", () => {
  const interrupted = store.beginScan("stable");
  const old = observe("stable", "old.osr", shaA, interrupted);
  store.close();
  store = new LibraryStore(database, "session-2");
  const resumed = store.beginScan("stable");
  observe("stable", "old.osr", shaA, resumed);
  const historical = observe("stable", "historic.osr", shaB, resumed);
  store.finishScan("stable", resumed);
  expect(store.getReplay(old)?.isNew).toBe(false);
  expect(store.getReplay(historical)?.isNew).toBe(false);
  const later = store.beginScan("stable");
  const fresh = observe("stable", "new.osr", "c".repeat(64), later, 100);
  expect(store.getReplay(fresh)?.isNew).toBe(true);
  expect(observe("stable", "renamed-copy.osr", shaA, later, 200)).toBe(old);
  expect(store.getReplay(old)?.isNew).toBe(false);
  store.close();
  store = new LibraryStore(database, "session-3");
  expect(store.getReplay(fresh)?.isNew).toBe(false);
});

it("explicit imports are NEW immediately, including an otherwise empty initial library", () => {
  const scan = store.beginScan("imports");
  const replay = observe("imports", "owned.osr", shaA, scan);
  expect(store.getReplay(replay)?.isNew).toBe(true);
  expect(observe("imports", "owned.osr", shaA, scan, 99)).toBe(replay);
  expect(store.getReplay(replay)?.firstAddedAt).toBe(10);
});

it("only a completed generation marks missing locations, and disabling preserves identity and metadata", () => {
  const first = store.beginScan("stable");
  const replay = observe("stable", "present.osr", shaA, first);
  store.finishScan("stable", first);
  const cancelled = store.beginScan("stable");
  store.stopScan("stable", cancelled);
  expect(store.getReplay(replay)?.locations[0].available).toBe(true);
  expect(() => observe("stable", "stale.osr", shaB, cancelled)).toThrow(/generation/i);
  store.setReview(replay, "reviewed");
  store.setSourceEnabled("stable", false);
  expect(store.getReplay(replay)).toMatchObject({ review: "reviewed", locations: [expect.objectContaining({ enabled: false })] });
  store.setSourceEnabled("stable", true);
  const empty = store.beginScan("stable");
  store.finishScan("stable", empty);
  expect(store.getReplay(replay)?.locations[0].available).toBe(false);
});

it("collection parent scope is a union; deletion preserves replays and review history", () => {
  const scan = store.beginScan("imports");
  const replay = observe("imports", "owned.osr", shaA, scan);
  const parent = store.createCollection("Work");
  const child = store.createCollection("Child", parent);
  expect(() => store.createCollection("Grandchild", child)).toThrow(/level/i);
  store.setMembership(replay, parent, true); store.setMembership(replay, child, true);
  expect(store.collectionReplayIds(parent)).toEqual([replay]);
  store.setMembership(replay, parent, false);
  expect(store.getReplay(replay)?.collectionIds).toEqual([child]);
  expect(store.collectionReplayIds(parent)).toEqual([replay]);
  store.setReview(replay, "reviewed");
  store.deleteCollection(parent);
  expect(store.getReplay(replay)).toMatchObject({ collectionIds: [], review: "reviewed" });
  expect(store.getReplay(replay)?.locations).toHaveLength(1);
});

it("reopens with aliases, direct memberships and latest explicit review intact", () => {
  const first = observe("stable", "score", null, store.beginScan("stable"));
  const collection = store.createCollection("Saved");
  store.setMembership(first, collection, true); store.setReview(first, "reviewed");
  const known = observe("imports", "bytes", shaA, store.beginScan("imports"));
  observe("stable", "score", shaA, store.beginScan("stable"));
  store.close(); store = new LibraryStore(database, "session-2");
  expect(store.resolveId(first)).toBe(known);
  expect(store.getReplay(first)).toMatchObject({ review: "reviewed", collectionIds: [collection], isNew: false });
  expect(store.integrityCheck()).toBe("ok");
});

it("rejects malformed observations before creating an identity or replacing a location", () => {
  const scan = store.beginScan("stable");
  expect(() => observe("stable", "bad", "not-a-hash", scan)).toThrow();
  expect(store.listReplayIds()).toEqual([]);
});

it("a later historical alias cannot erase an earlier import's NEW status", () => {
  const known = observe("imports", "first", shaA, store.beginScan("imports"), 10);
  const scan = store.beginScan("stable");
  const provisional = observe("stable", "later", null, scan, 20);
  expect(observe("stable", "later", shaA, scan, 30)).toBe(known);
  expect(store.getReplay(provisional)).toMatchObject({ firstAddedAt: 10, isNew: true });
});

it("rejects silently rebinding an installation while its scan is active", () => {
  const scan = store.beginScan("stable");
  expect(() => store.registerSource({ id: "stable", kind: "stable", directory: "C:\\different-install" })).toThrow(/directory/i);
  expect(() => observe("stable", "still-original", shaA, scan)).not.toThrow();
});

it("refreshes provisional metadata and keeps source-qualified projections when duplicates arrive", () => {
  const scan = store.beginScan("stable");
  const record = { sourceId: "stable", sourceKey: "score", locator: "cache", sha256: null, available: false, generation: scan, addedAt: 10, metadata: { title: "First" } };
  const id = store.upsertObservation(record);
  store.upsertObservation({ ...record, metadata: { title: "Updated" } });
  expect(store.getReplay(id)?.metadata.title).toBe("Updated");
  store.upsertObservation({ ...record, sha256: shaA, available: true, metadata: { title: "Rich source", status: "ranked" } });
  const imported = observe("imports", "header-only", shaA, store.beginScan("imports"), 20);
  expect(imported).toBe(id);
  expect(store.getReplay(id)?.metadata).toEqual({ title: "Rich source", status: "ranked" });
  expect(store.getReplay(id)?.locations).toContainEqual(expect.objectContaining({ sha256: shaA, metadata: { title: "Rich source", status: "ranked" } }));
});

it("assigns the next palette slot after deletion and restart, and children inherit it", () => {
  const first = store.createCollection("First");
  store.createCollection("Second"); store.deleteCollection(first);
  store.close(); store = new LibraryStore(database, "session-2");
  const third = store.createCollection("Third");
  const child = store.createCollection("Child", third);
  expect(store.listCollections().map(item => item.paletteIndex)).toEqual([1, 2, 2]);
  expect(store.listCollections().find(item => item.id === child)?.parentId).toBe(third);
});

function denseStripFixture(){
  const fixture=capabilityFixture(),target=requiredCapability(store.metrics.readTarget(fixture.id,"numerical"));
  const value:LibraryMetricResult={fields:{ur:{state:"known",value:120},completion:{state:"unknown",reason:"completion-not-established"}},
    provenance:{replaySha256:shaA,projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,ruleset:"stable",scoreOrigin:"reconstructed",
      coverageQualified:true,completionEvidence:"source-domain-coverage-v1"},errorStrip:{state:"unknown",reason:"strip-size-limit"}};
  store.metrics.publishObserved(target,value);
  // Finished dependent work is deliberately retained, not invalidated for a strip.
  const timeline=store.metrics.setTarget(libraryTimelineTarget(target));
  store.metrics.publishObserved(timeline,{fields:{peakPp:{state:"known",value:10}},provenance:{}});
  store.enableNumericalAdmission();store.enablePerformanceAdmission();
  return {...fixture,target,value};
}
it("automatically repairs only the old count-limited strip while current scalar and dependents remain usable",()=>{
  const {id,target,value}=denseStripFixture(),before=store.metrics.read(id).map(e=>({target:e.target,result:e.result}));
  capabilityPages();
  const pending=store.metrics.readErrorStrip(id)?.job;
  expect(pending).toMatchObject({reason:"strip-repair",state:"queued",target});
  expect(store.metrics.read(id).map(e=>({target:e.target,result:e.result}))).toEqual(before);
  expect(store.analysisActivity()).toMatchObject({queued:1,failed:0});
  const ticket=requiredCapability(store.metrics.claim(requiredCapability(pending).id));
  const errorStrip={state:"known" as const,value:{version:1 as const,timeBasis:"map-ms" as const,ruleset:"stable" as const,
    mapStartMs:0,mapEndMs:4000,evaluatedThrough:4000,endpointBasis:"recorded-end" as const,synthesizedEndpoint:false,
    ok:Array(3125).fill(1),meh:[],miss:[],sliderEndMiss:[],sliderBreak:[]}};
  expect(store.metrics.commitAndClaimTimeline({...value,ticket,producerVersion:target.producerVersion,errorStrip})).toEqual({state:"cached"});
  expect(store.metrics.readErrorStrip(id)?.result).toEqual(errorStrip);
  expect(store.metrics.read(id).map(e=>({target:e.target,result:e.result}))).toEqual(before);
  store.close();store=new LibraryStore(database,"strip-restart");store.enableNumericalAdmission();store.enablePerformanceAdmission();
  capabilityPages();expect(store.metrics.nextQueued()).toEqual([]);expect(store.analysisActivity().queued).toBe(0);
});

it.each(["off","demand","paused"])("holds automatic strip repair while %s and later admits once",policy=>{
  const {id}=denseStripFixture();store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),
    mode:policy==="paused"?"bg":policy as "off"|"demand",userPaused:policy==="paused"});
  capabilityPages();expect(store.metrics.readErrorStrip(id)?.job).toBeUndefined();expect(store.capabilityRecoveryStatus().state).toBe("held");
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"bg",userPaused:false});capabilityPages();
  const pending=requiredCapability(store.metrics.readErrorStrip(id)?.job);expect(pending.reason).toBe("strip-repair");
  const progress=store.capabilityRecoveryStatus();capabilityPages();expect(store.capabilityRecoveryStatus()).toEqual(progress);
});
it.each(["enabled","available"])("revisits late %s dense inputs but never loops a fresh byte-budget rejection",condition=>{
  const {id,observation,value,target}=denseStripFixture();if(condition==="enabled")store.setSourceEnabled("imports",false);else store.upsertObservation({...observation,available:false});capabilityPages();
  expect(store.capabilityRecoveryStatus().complete).toBe(true);expect(store.metrics.readErrorStrip(id)?.job).toBeUndefined();
  if(condition==="enabled")store.setSourceEnabled("imports",true);else store.upsertObservation(observation);while(store.maintainSourceAdmission().pending)store.maintainQueryProjection();capabilityPages();
  if(condition==="available"){
    // Availability changes legitimately queue ordinary preparation first; repair cannot supersede it.
    expect(store.preparations.read(id).map(r=>r.state)).toEqual(["queued","queued"]);
    expect(store.capabilityRecoveryStatus()).toMatchObject({complete:false,deferred:id,numerical:0});
    expect(store.metrics.readErrorStrip(id)?.job).toBeUndefined();
    expect(store.metrics.read(id).find(e=>e.target.slot==="numerical")?.result?.fields).toEqual(value.fields);
    finishCachedPreparation(id);capabilityPages();
  }
  const pending=requiredCapability(store.metrics.readErrorStrip(id)?.job),ticket=requiredCapability(store.metrics.claim(pending.id));
  expect(store.metrics.commitAndClaimTimeline({...value,ticket,producerVersion:target.producerVersion,errorStrip:{state:"unknown",reason:"strip-byte-size-limit-v2"}})).toEqual({state:"cached"});
  const progress=store.capabilityRecoveryStatus();store.close();store=new LibraryStore(database,"no-gain-restart");
  store.enableNumericalAdmission();store.enablePerformanceAdmission();store.upsertObservation({...observation,generation:store.beginScan("imports")});
  capabilityPages();expect(store.capabilityRecoveryStatus()).toEqual(progress);expect(store.metrics.readErrorStrip(id)?.job).toBeUndefined();
});
it("waits for other live work and never advances the selected repair identity across it",()=>{
  const {id}=denseStripFixture();const p=store.metrics.setTarget({replayId:id,slot:"aggregate-pp",stage:"P",producerVersion:"fixture",inputKey:"new"});
  store.metrics.request(p,"selection");expect(store.maintainCapabilityRecovery()).toBe(false);
  expect(store.capabilityRecoveryStatus().cursor).toBe("");expect(store.metrics.readErrorStrip(id)?.job).toBeUndefined();
  store.metrics.publishObserved(p,{fields:{pp:{state:"known",value:2}},provenance:{}});capabilityPages();
  expect(store.metrics.readErrorStrip(id)?.job?.reason).toBe("strip-repair");
});

it.each([0,4096,2048,2120,2048|4096])("reconsiders an old supported Stable v2 attempt once for the new source capabilities (mods=%s)",mask=>{
  const f=capabilityFixture(mask),old={...f.value,provenance:{...f.value.provenance,capabilityAttempt:"stable-prefix-v2"}};
  store.metrics.publishObserved(requiredCapability(store.metrics.readTarget(f.id,"numerical")),old);
  const knownP=store.metrics.read(f.id).filter(e=>e.target.stage==="P");
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();expect(store.capabilityRecoveryStatus().numerical).toBe(1);
  expect(store.metrics.read(f.id).filter(e=>e.target.stage==="P")).toEqual(knownP);
  const prep=requiredCapability(store.preparations.claim(f.id,"S")),receipt=store.preparations.complete(prep,[f.numerical],undefined,true);
  if(receipt.state!=="applied"||receipt.handoff?.state!=="claimed")throw Error("Missing new AT attempt");
  store.metrics.commit({ticket:receipt.handoff.ticket,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,...f.value});
  expect(store.metrics.read(f.id).find(e=>e.target.slot==="numerical")?.result?.provenance.capabilityAttempt).toBe("stable-prefix-v3");
  completeNativeTimelineFixture(f.id);const before=store.capabilityRecoveryStatus();
  store.close();store=new LibraryStore(database,"AT-attempt-restart");store.enableNumericalAdmission();store.enablePerformanceAdmission();
  store.upsertObservation({...f.observation,generation:store.beginScan("imports")});capabilityPages();
  expect(store.capabilityRecoveryStatus()).toEqual(before);expect(store.preparations.read(f.id).find(r=>r.stage==="S")?.state).toBe("bound");
});
it("does not rescan the current manual v3 attempt after the new later-reset capability pass",()=>{
  const f=capabilityFixture(),old={...f.value,provenance:{...f.value.provenance,capabilityAttempt:"stable-prefix-v3"}};
  store.metrics.publishObserved(requiredCapability(store.metrics.readTarget(f.id,"numerical")),old);
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();const before=store.capabilityRecoveryStatus();
  expect(before.numerical).toBe(0);store.upsertObservation({...f.observation,generation:store.beginScan("imports")});
  capabilityPages();expect(store.capabilityRecoveryStatus()).toEqual(before);expect(store.metrics.read(f.id).find(e=>e.target.slot==="numerical")?.result?.provenance.capabilityAttempt).toBe("stable-prefix-v3");
});
it.each([2048|128,2048|8192,2048|(1<<20)])("does not admit unsupported AT mixed mechanics/header bits (%s)",mask=>{
  const f=capabilityFixture(mask);store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(0);expect(store.metrics.read(f.id).find(e=>e.target.slot==="numerical")?.result).toBeDefined();
});
it("retries old native initial-negative attempts for held-release once while retaining known P",()=>{
  const f=nativeCapabilityFixture(),old={...f.value,provenance:{...f.value.provenance,capabilityAttempt:"native-initial-negative-v1"}};
  store.metrics.publishObserved(requiredCapability(store.metrics.readTarget(f.id,"numerical")),old);
  const known=store.metrics.read(f.id).filter(e=>e.target.stage==="P");store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(1);expect(store.metrics.read(f.id).filter(e=>e.target.stage==="P")).toEqual(known);
  const prep=requiredCapability(store.preparations.claim(f.id,"S")),receipt=store.preparations.complete(prep,[f.numerical],undefined,true);
  if(receipt.state!=="applied"||receipt.handoff?.state!=="claimed")throw Error("Missing new native attempt");
  store.metrics.commit({ticket:receipt.handoff.ticket,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,...f.value});completeNativeTimelineFixture(f.id);
  expect(store.metrics.read(f.id).find(e=>e.target.slot==="numerical")?.result?.provenance.capabilityAttempt).toBe("native-held-release-v2");
  const before=store.capabilityRecoveryStatus();store.close();store=new LibraryStore(database,"native-held-restart");store.enableNumericalAdmission();store.enablePerformanceAdmission();
  store.upsertObservation({...f.observation,generation:store.beginScan("imports")});capabilityPages();expect(store.capabilityRecoveryStatus()).toEqual(before);
});

it("never queues repair for a fresh normal producer byte-budget rejection",()=>{
  const f=capabilityFixture(),target=requiredCapability(store.metrics.readTarget(f.id,"numerical"));
  store["transaction"](()=>store.metrics.retryRejectedCoverageInTransaction(f.id));
  const current=requiredCapability(store.metrics.readTarget(f.id,"numerical"));store.metrics.request(current,"retry");
  const ticket=requiredCapability(store.metrics.claim(requiredCapability(store.metrics.read(f.id).find(e=>e.target.slot==="numerical")?.job).id));
  store.metrics.commit({ticket,producerVersion:target.producerVersion,fields:{ur:{state:"known",value:10}},
    provenance:{replaySha256:shaA,projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,ruleset:"stable",scoreOrigin:"reconstructed",coverageQualified:true,completionEvidence:"source-domain-coverage-v1"},
    errorStrip:{state:"unknown",reason:"strip-byte-size-limit-v2"}});
  store.enableNumericalAdmission();store.enablePerformanceAdmission();capabilityPages();
  expect(store.capabilityRecoveryStatus().numerical).toBe(0);expect(store.metrics.readErrorStrip(f.id)?.job).toBeUndefined();
});
function sparseNativePFixture(reason="aggregate-object-coverage-incomplete"){
  const md5="c".repeat(32),mapSha="d".repeat(64);
  const observation={sourceId:"imports",sourceKey:"native-sparse-score",locator:"native.osr",sha256:shaA,available:true,
    generation:store.beginScan("imports"),addedAt:1,metadata:{header:{mode:0,sourceFormat:"lazer",nativeScoreInfo:true,
      version:30000019,beatmapMD5:md5,modsBitmask:0}}};
  const id=store.upsertObservation(observation),generation=store.beginMapScan("stable");
  store.upsertMap({sourceId:"stable",sourceKey:"sparse-map",generation,md5,locator:"map.osu",state:"unverified",metadata:{}});
  store.finishMapScan("stable",generation);
  const provenance={mapSha256:mapSha,mapMd5:md5,replaySha256:shaA,engineVersion:PERFORMANCE_ENGINE_VERSION};
  const raw:LibraryPreparedResult[]=[{slot:"calculated-map",stage:"P",producerVersion:LIBRARY_P_PRODUCER_VERSION,inputKey:"retained-map",
    fields:{mapStars:{state:"known",value:2},bpm:{state:"known",value:180}},provenance},
    ...([['aggregate-pp','pp'],['fc-pp','ppIfFc']] as const).map(([slot,field])=>({slot,stage:"P" as const,producerVersion:LIBRARY_P_PRODUCER_VERSION,
      inputKey:metricInputKey({version:LIBRARY_P_PRODUCER_VERSION,map:mapSha,slot,reason}),
      fields:{[field]:{state:"unknown" as const,reason}},provenance:{...provenance,ruleset:"lazer"}}))];
  store["transaction"](()=>store["performanceRecipes"].bindInTransaction(id,store["performanceDependencies"](id),raw,true));
  store.preparations.request(id,"P","selection");const seed=requiredCapability(store.preparations.claim(id,"P"));
  store.preparations.completeResults(seed,raw,()=>({state:"applied",replayId:id}),()=>store["performanceRecipes"].reconcileInTransaction(id));
  const numerical=store.metrics.setTarget({replayId:id,slot:"numerical",stage:"S",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,inputKey:"known-native-s"});
  store.metrics.publishObserved(numerical,{fields:{ur:{state:"known",value:123}},provenance:{replaySha256:shaA,mapSha256:mapSha,ruleset:"lazer",coverageQualified:true}});
  // Model completed ordinary S preparation as well as its retained scalar cache.
  store.preparations.request(id,"S","selection");
  store.preparations.complete(requiredCapability(store.preparations.claim(id,"S")),[numerical]);
  store.enableNumericalAdmission();store.enablePerformanceAdmission();
  const commit=(ticket:Parameters<LibraryStore['commitPreparedPerformance']>[0],results=raw)=>store.commitPreparedPerformance(ticket,
    store.openLocationCandidates(id).items[0],{md5,sha256:mapSha,ticket:store.openMapCandidates(md5).items[0]},results,null,true);
  return{id,observation,raw,commit};
}
it.each(["aggregate-object-coverage-incomplete","native-component-evidence-unavailable"])("reconsiders exact old native P %s once through normal producer publication",reason=>{
  const f=sparseNativePFixture(reason),before=store.metrics.read(f.id),rawBefore=store["db"].prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(f.id);
  capabilityPages();expect(store.capabilityRecoveryStatus().performance).toBe(1);
  expect(store.metrics.read(f.id)).toEqual(before);expect(store["db"].prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(f.id)).toEqual(rawBefore);
  const ticket=requiredCapability(store.preparations.claim(f.id,"P"));
  expect(f.commit({...ticket,generation:ticket.generation+1}).state).toBe("stale");
  expect(store["db"].prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(f.id)).toEqual(rawBefore);
  expect(f.commit(ticket).state).toBe("applied");
  const recipe=JSON.parse(String(store["db"].prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(f.id)?.payload));
  expect(recipe.results.filter((r:LibraryPreparedResult)=>r.slot!=="calculated-map").map((r:LibraryPreparedResult)=>r.provenance.capabilityAttempt)).toEqual(["native-sparse-score-v1","native-sparse-score-v1"]);
  expect(store.metrics.read(f.id).filter(e=>e.target.slot==="calculated-map"||e.target.stage==="S")).toEqual(before.filter(e=>e.target.slot==="calculated-map"||e.target.stage==="S"));
  const done=store.capabilityRecoveryStatus();store.close();store=new LibraryStore(database,"native-p-restart");store.enableNumericalAdmission();store.enablePerformanceAdmission();
  store.upsertObservation({...f.observation,generation:store.beginScan("imports")});capabilityPages();
  expect(store.capabilityRecoveryStatus()).toEqual(done);expect(store.preparations.read(f.id).find(r=>r.stage==="P")?.state).toBe("bound");
});
it("publishes recovered native P normally while preserving known map, S, strip and scalar caches",()=>{
  const f=sparseNativePFixture(),before=store.metrics.read(f.id),cacheKey="f".repeat(64);
  store.performanceCache.putScalar(cacheKey,"lazer",17);const cache=store["db"].prepare("SELECT * FROM performance_scalar_cache").all();
  capabilityPages();const ticket=requiredCapability(store.preparations.claim(f.id,"P"));
  const results=f.raw.map(r=>r.slot==="aggregate-pp"?{...r,inputKey:"recovered-aggregate",fields:{pp:{state:"known" as const,value:30}}}:
    r.slot==="fc-pp"?{...r,inputKey:"recovered-fc",fields:{ppIfFc:{state:"known" as const,value:40}}}:r);
  expect(f.commit(ticket,results).state).toBe("applied");
  expect(store.metrics.read(f.id).find(e=>e.target.slot==="aggregate-pp")?.result?.fields.pp).toEqual({state:"known",value:30});
  expect(store.metrics.read(f.id).find(e=>e.target.slot==="fc-pp")?.result?.fields.ppIfFc).toEqual({state:"known",value:40});
  expect(store.metrics.read(f.id).filter(e=>e.target.stage==="S"||e.target.slot==="calculated-map")).toEqual(before.filter(e=>e.target.stage==="S"||e.target.slot==="calculated-map"));
  expect(store["db"].prepare("SELECT * FROM performance_scalar_cache").all()).toEqual(cache);
  const done=store.capabilityRecoveryStatus();store.upsertObservation({...f.observation,generation:store.beginScan("imports")});capabilityPages();expect(store.capabilityRecoveryStatus()).toEqual(done);
});
it.each(["queued","running","failed"])("does not supersede %s native P ownership or retry a failed attempt",state=>{
  const f=sparseNativePFixture();store.preparations.request(f.id,"P","retry");
  if(state!=="queued"){
    const ticket=requiredCapability(store.preparations.claim(f.id,"P"));if(state==="failed")store.preparations.fail(ticket,"actual failure");
  }
  const before=store.preparations.read(f.id);capabilityPages();expect(store.preparations.read(f.id)).toEqual(before);
  expect(store.capabilityRecoveryStatus().performance).toBe(0);
  if(state!=="failed")expect(store.capabilityRecoveryStatus().complete).toBe(false);
  else{
    store.upsertObservation({...f.observation,generation:store.beginScan("imports")});capabilityPages();
    expect(store.preparations.read(f.id)).toEqual(before);expect(store.capabilityRecoveryStatus().performance).toBe(0);
  }
});
it.each(["off","demand","pause","disabled","unavailable"])("holds native sparse automatic recovery under %s without changing cached values",hold=>{
  const f=sparseNativePFixture(),before=store.metrics.read(f.id);
  if(hold==="disabled")store.setSourceEnabled("imports",false);
  else if(hold==="unavailable")store.upsertObservation({...f.observation,available:false});
  else store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:hold==="pause"?"bg":hold as "off"|"demand",userPaused:hold==="pause"});
  capabilityPages();expect(store.capabilityRecoveryStatus().performance).toBe(0);
  expect(store.metrics.read(f.id)).toEqual(before);
});
it("keeps ordinary P Off semantics after capability reservation and marks only a current successful commit",()=>{
  const f=sparseNativePFixture();capabilityPages();const ticket=requiredCapability(store.preparations.claim(f.id,"P"));
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});
  expect(f.commit(ticket).state).toBe("applied");expect(store.preparations.read(f.id).find(r=>r.stage==="P")?.state).toBe("bound");
  const raw=JSON.parse(String(store["db"].prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(f.id)?.payload));
  expect(raw.results[1].provenance.capabilityAttempt).toBe("native-sparse-score-v1");
});
it("fences changed native P inputs and can reconsider an exact restored unattempted new input",()=>{
  const f=sparseNativePFixture();capabilityPages();const ticket=requiredCapability(store.preparations.claim(f.id,"P"));
  const changed={...f.observation,metadata:{header:{...f.observation.metadata.header,modsBitmask:8}}};store.upsertObservation(changed);
  expect(f.commit(ticket).state).toBe("stale");
  const staleRecipe=JSON.parse(String(store["db"].prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(f.id)?.payload));
  expect(staleRecipe.results[1].provenance.capabilityAttempt).toBeUndefined();
  store["transaction"](()=>store["performanceRecipes"].bindInTransaction(f.id,store["performanceDependencies"](f.id),f.raw,true));
  finishCachedPreparation(f.id);
  store.upsertObservation({...changed,generation:store.beginScan("imports")});capabilityPages();
  expect(store.capabilityRecoveryStatus().performance).toBe(2);
});
it("rolls native P recovery publication back if known map bytes disagree",()=>{
  const f=sparseNativePFixture();capabilityPages();const ticket=requiredCapability(store.preparations.claim(f.id,"P")),before=store.metrics.read(f.id),requests=store.preparations.read(f.id),recipe=store["db"].prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(f.id);
  expect(()=>f.commit(ticket,f.raw.map(r=>r.slot==="calculated-map"?{...r,fields:{...r.fields,bpm:{state:"known",value:200}}}:r))).toThrow("Native score recovery changed known map mathematics");
  expect(store.metrics.read(f.id)).toEqual(before);expect(store.preparations.read(f.id)).toEqual(requests);
  expect(store["db"].prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(f.id)).toEqual(recipe);
});
