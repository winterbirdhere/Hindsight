import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
import { describeLibraryNumericalResources } from "./library-analysis-binding";
import { projectLibraryIncidentEvidence } from "./library-incidents-evidence";
import type { PreparedLibraryMap, PreparedLibraryReplay } from "./library-selected-resources";
import type { LibraryMetricResult, LibraryMetricTicket } from "../../../../shared/replay-library-metrics";
import type { LibraryPreparationTicket } from "./library-preparation-store";
const sha="a".repeat(64),md5="b".repeat(32);
let store:LibraryStore,directory:string,file:string,id:string;
beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),"hindsight-c-binding-"));file=join(directory,"library.sqlite");store=new LibraryStore(file,"one");
  store.registerSource({id:"files",kind:"replays",directory:"C:\\fixture"});
  id=store.upsertObservation({sourceId:"files",sourceKey:"r",locator:"C:\\fixture\\r.osr",sha256:sha,available:true,
    generation:store.beginScan("files"),addedAt:1,metadata:{header:{mode:0,beatmapMD5:md5}}});
});
afterEach(()=>{store.close();for(const suffix of ["","-wal","-shm"])if(existsSync(file+suffix))unlinkSync(file+suffix);rmdirSync(directory);});
function resources(){return describeLibraryNumericalResources({data:{gameMode:0,gameVersion:20200101,replayContentSha256:sha,beatmapMD5:md5,mods:0,
  savedScoreSource:{status:"absent",attempts:[]}},receipt:{sha256:sha,available:true}} as unknown as PreparedLibraryReplay,
  {map:{sha256:"c".repeat(64),md5,bytes:Buffer.from("map")}} as PreparedLibraryMap,100);}
function prepare(evidence=projectLibraryIncidentEvidence(undefined,{replaySha256:sha,mapMd5:md5})){
  const descriptor=resources();store.preparations.request(id,"S","selection");const preparation=store.preparations.claim(id,"S");if(!preparation)throw Error("missing preparation");
  return store.commitPreparedAnalysis(preparation,store.openLocationCandidates(id).items[0],{sha256:sha,available:true,metadata:{header:{mode:0,beatmapMD5:md5}}},
    [descriptor.target],null,undefined,descriptor.recipe,true,evidence);
}
const numericalResult:LibraryMetricResult={fields:{completion:{state:"known",value:"passed"},ur:{state:"known",value:80}},
  provenance:{replaySha256:sha,coverageQualified:true},errorStrip:{state:"known",value:{version:1,timeBasis:"map-ms",ruleset:"stable",
    mapStartMs:0,mapEndMs:1000,evaluatedThrough:1000,endpointBasis:"recorded-end",synthesizedEndpoint:false,
    ok:[],meh:[],miss:[500],sliderEndMiss:[],sliderBreak:[]}}};
function numerical(){
  const result=prepare();if(result.state!=="applied"||result.handoff?.state!=="claimed")throw Error("missing numerical");
  const ticket=result.handoff.ticket;expect(store.metrics.commit({ticket,producerVersion:ticket.producerVersion,...numericalResult})).toBe("applied");return ticket;
}
/** Existing-index rows must not use retired production C binding/admission to create their precondition. */
function historicalC(state:"queued"|"running"|"failed"="running"){
  const ticket:LibraryMetricTicket={replayId:id,slot:"incidents",stage:"C",inputKey:"e".repeat(64),producerVersion:"historical-c-v1",generation:999,attempt:"old-c-attempt"};
  const preparation:LibraryPreparationTicket={replayId:id,stage:"C",dependencyKey:"f".repeat(64),generation:999,reason:"background",attempt:"old-c-preparation"};
  const evidence=projectLibraryIncidentEvidence(undefined,{replaySha256:sha,mapMd5:md5}),db=store["db"];
  db.prepare("INSERT INTO metric_targets VALUES(?,?,?,?,?,?)").run(id,ticket.slot,ticket.stage,ticket.inputKey,ticket.producerVersion,ticket.generation);
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,?,?,?,?,?)")
    .run(id,ticket.slot,ticket.stage,ticket.inputKey,ticket.producerVersion,JSON.stringify({fields:{incidentCount:{state:"known",value:2}},provenance:{replaySha256:sha}}));
  db.prepare("INSERT INTO metric_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("old-c-job",id,ticket.slot,ticket.stage,ticket.inputKey,ticket.producerVersion,ticket.generation,"background",state,state==="running"?ticket.attempt:null,state==="failed"?"historical C failure":null);
  db.prepare("INSERT INTO analysis_requests VALUES(?,?,?,?,?,?,?,?)").run(id,"C",preparation.dependencyKey,preparation.generation,"background",state,state==="running"?preparation.attempt:null,state==="failed"?"historical C preparation failure":null);
  db.prepare("INSERT INTO incident_recipes(replay_id,numerical_key,numerical_version,evidence) VALUES(?,?,?,?)")
    .run(id,resources().target.inputKey,resources().target.producerVersion,JSON.stringify(evidence));
  return{ticket,preparation,evidence};
}
function noCQueue(){
  expect(store.metrics.nextQueued().some(job=>job.target.stage==="C")).toBe(false);
  expect(store.preparations.nextQueued().some(request=>request.stage==="C")).toBe(false);
}
it.each(["queued","running","failed"] as const)("retires historical %s C work on reopen while preserving S results and card strips",state=>{
  numerical();const before=store.metrics.read(id).find(row=>row.target.slot==="numerical"),strip=store.metrics.readErrorStrip(id);historicalC(state);
  const payload=store["db"].prepare("SELECT payload FROM metric_results WHERE replay_id=? AND slot='incidents'").get(id);
  store.close();store=new LibraryStore(file,"restart");
  expect(store["db"].prepare("SELECT * FROM metric_jobs WHERE stage='C'").all()).toEqual([]);
  expect(store.preparations.read(id).filter(request=>request.stage==="C")).toEqual([]);noCQueue();
  expect(store["db"].prepare("SELECT payload FROM metric_results WHERE replay_id=? AND slot='incidents'").get(id)).toEqual(payload);
  expect(store.metrics.read(id).find(row=>row.target.slot==="numerical")).toEqual(before);
  expect(store.metrics.readErrorStrip(id)).toEqual(strip);expect(strip?.result).toEqual(numericalResult.errorStrip);
});
it.each(["bg","demand","off"] as const)("refuses C selection/retry, direct claims and historical publication in %s mode",mode=>{
  numerical();const {ticket}=historicalC("queued");store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode});
  for(const reason of ["selection","retry","background"] as const){
    expect(store.preparations.request(id,"C",reason)).toEqual({state:"disabled"});expect(store.metrics.request(ticket,reason)).toEqual({state:"disabled"});
  }
  expect(store.metrics.claim("old-c-job")).toBeUndefined();expect(store.preparations.claim(id,"C")).toBeUndefined();
  expect(store.metrics.isLiveTicket(ticket)).toBe(false);expect(store.metrics.isEligible(ticket)).toBe(false);
  expect(store.metrics.publishObserved(ticket,{fields:{incidentCount:{state:"known",value:9}},provenance:{replaySha256:sha}})).toBe("stale");noCQueue();
});
it("rejects delayed C probes and completions without changing S, historical payloads or queues",()=>{
  numerical();const {ticket,preparation,evidence}=historicalC(),location=store.openLocationCandidates(id).items[0];
  const probe={evidence,observation:{sha256:sha,available:true,metadata:{header:{beatmapMD5:md5}}},origin:null,scope:"stable-sidecar" as const};
  const before=store.metrics.read(id),requests=store.preparations.read(id),payload=store["db"].prepare("SELECT * FROM metric_results WHERE slot='incidents'").all();
  expect(()=>store.incidentProbeContext(ticket)).toThrow(/retired/i);expect(()=>store.incidentPreparationContext(preparation)).toThrow(/retired/i);
  expect(store.commitIncidentsVerified(ticket,location,probe,{fields:{incidentCount:{state:"known",value:9}},provenance:{replaySha256:sha}})).toBe("stale");
  expect(store.commitIncidentPreparation(preparation,location,probe)).toEqual({state:"stale"});
  expect(store.metrics.commit({ticket,producerVersion:ticket.producerVersion,fields:{incidentCount:{state:"known",value:9}},provenance:{replaySha256:sha}})).toBe("stale");
  expect(store.preparations.isEligible(preparation)).toBe(false);expect(store.metrics.read(id)).toEqual(before);expect(store.preparations.read(id)).toEqual(requests);
  expect(store["db"].prepare("SELECT * FROM metric_results WHERE slot='incidents'").all()).toEqual(payload);noCQueue();
});
it.each(["source","adjacent"] as const)("keeps retired %s evidence notifications and maintenance passive",kind=>{
  numerical();historicalC();const before=store.metrics.read(id),requests=store.preparations.read(id),dirty=jest.fn();store.onAnalysisDirty(dirty);
  store.dirtyIncidentEvidence("files",kind==="source"?{kind}:{kind,replayLocator:"C:\\fixture\\r.osr"});
  expect(store.maintainIncidentPreparation()).toEqual({});expect(dirty).not.toHaveBeenCalled();
  expect(store["db"].prepare("SELECT * FROM incident_source_epochs").all()).toEqual([]);expect(store["db"].prepare("SELECT * FROM incident_location_epochs").all()).toEqual([]);
  expect(store.metrics.read(id)).toEqual(before);expect(store.preparations.read(id)).toEqual(requests);noCQueue();
});
it.each(["success","failure"] as const)("publishes final FC %s and ends the real S chain without C",outcome=>{
  const result=prepare();if(result.state!=="applied"||result.handoff?.state!=="claimed")throw Error("missing numerical");
  const numericalTicket=result.handoff.ticket,chain=store.metrics.commitAndClaimTimeline({ticket:numericalTicket,producerVersion:numericalTicket.producerVersion,...numericalResult});
  if(chain.state!=="claimed")throw Error("missing timeline");
  const fc=store.metrics.finishTimelineAndClaimFc(chain.ticket,{error:"ordinary native failure"});if(fc.state!=="claimed")throw Error("missing fc");
  expect(store.metrics.finishFcAndClaimIncidents(fc.ticket,outcome==="success"?{metrics:{fields:{ppIfFc:{state:"known",value:123}},provenance:{replaySha256:sha}}}:{error:"ordinary FC failure"})).toEqual({state:"cached"});
  const entries=store.metrics.read(id),final=entries.find(row=>row.target.slot==="fc-pp");
  if(outcome==="success")expect(final?.result?.fields.ppIfFc).toEqual({state:"known",value:123});else expect(final?.job).toMatchObject({state:"failed",error:"ordinary FC failure"});
  expect(entries.find(row=>row.target.slot==="timeline-pp")?.job).toMatchObject({state:"failed",error:"ordinary native failure"});
  expect(entries.find(row=>row.target.slot==="numerical")?.result).toEqual({fields:numericalResult.fields,provenance:numericalResult.provenance});
  expect(store.metrics.readErrorStrip(id)?.result).toEqual(numericalResult.errorStrip);
  expect(entries.some(row=>row.target.stage==="C")).toBe(false);expect(store.incidents.read(id)).toBeUndefined();noCQueue();
});
it("ignores obsolete C receipt fields during S preparation without allocating an incident recipe",()=>{
  expect(resources().incidentEvidence).toBeUndefined();
  const result=prepare({...projectLibraryIncidentEvidence(undefined,{replaySha256:sha,mapMd5:md5}),mapMd5:"d".repeat(32)});
  expect(result.state).toBe("applied");expect(store.incidents.read(id)).toBeUndefined();expect(store.metrics.read(id).some(row=>row.target.slot==="numerical")).toBe(true);noCQueue();
});
