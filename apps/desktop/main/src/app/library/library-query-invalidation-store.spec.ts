import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LibraryStore } from "./library-store";
import type { LibraryLocationTicket } from "./library-store";

let store:LibraryStore,db:DatabaseSync;
const roots:string[]=[];
const stable={id:"stable",kind:"stable" as const,directory:"fixture"};
function open(path=":memory:"){store=new LibraryStore(path,"test");db=(store as unknown as {db:DatabaseSync}).db;}
function revision(id="stable"){return db.prepare("SELECT config_revision FROM sources WHERE id=?").get(id)?.config_revision;}
function drain(){while(store.queryProjectionPending())store.maintainQueryProjection();}
beforeEach(()=>open());
afterEach(()=>{store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it("does not advance unchanged source configuration or enable freshness epochs",()=>{
  store.reconcileSources([stable]);drain();const initial=revision();
  store.reconcileSources([stable]);store.setSourceEnabled("stable",true);
  expect(revision()).toBe(initial);
  store.setSourceEnabled("stable",false);expect(revision()).toBe(Number(initial)+1);
  store.setSourceEnabled("stable",false);expect(revision()).toBe(Number(initial)+1);
  store.reconcileSources([stable]);expect(revision()).toBe(Number(initial)+1);expect(store.sourceEnabled("stable")).toBe(false);
});
it("changes configuration revision only for sources whose configured membership changes",()=>{
  const next={id:"other",kind:"lazer" as const,directory:"other"};store.reconcileSources([stable,next]);
  const initialStable=revision(),initialOther=revision("other");store.reconcileSources([stable]);
  expect(revision()).toBe(initialStable);expect(revision("other")).toBe(Number(initialOther)+1);
  store.reconcileSources([stable,next]);expect(revision()).toBe(initialStable);expect(revision("other")).toBe(Number(initialOther)+2);
});
it("retains unchanged source configuration revision after a real close and reopen",()=>{
  const root=mkdtempSync(join(tmpdir(),"rewind-query-store-"));roots.push(root);const path=join(root,"index.sqlite");
  store.close();open(path);store.reconcileSources([stable]);const initial=revision();store.close();open(path);store.reconcileSources([stable]);
  expect(revision()).toBe(initial);
});
it("avoids writes for unchanged registered sources and semantic analysis settings",()=>{
  store.registerSource(stable);drain();const before=Number(db.prepare("SELECT total_changes() AS count").get()?.count);
  store.registerSource(stable);store.metrics.setAnalysisSettings({workers:2,pauseOnBattery:true,userPaused:false,mode:"bg"});
  expect(Number(db.prepare("SELECT total_changes() AS count").get()?.count)).toBe(before);
  store.metrics.setAnalysisSettings({workers:1,pauseOnBattery:true,userPaused:true,mode:"bg"});drain();
  const changed=Number(db.prepare("SELECT total_changes() AS count").get()?.count);
  store.metrics.setAnalysisSettings({mode:"bg",userPaused:true,pauseOnBattery:true,workers:1});
  expect(Number(db.prepare("SELECT total_changes() AS count").get()?.count)).toBe(changed);
});

function verifiedObservation(generation:string,locator="one.osr"){
  return {sourceId:"stable",sourceKey:"one",generation,locator,sha256:"b".repeat(64),available:true,addedAt:1,
    metadata:{header:{mode:0,version:20200101,beatmapMD5:"a".repeat(32),mods:0},fileState:"readable"}};
}
it("keeps identical rescan observations query-silent while preserving the location lease and generation coverage",()=>{
  store.registerSource(stable);
  const first=store.beginScan("stable"),id=store.upsertObservation(verifiedObservation(first));
  store.finishScan("stable",first);drain();
  const reader=store.createQueryReader(),ticket=store.openLocationCandidates(id).items[0],queryRevision=reader.page({}).revision;
  const resourceRevision=store.resourceRevision(),metrics=store.metrics.read(id);
  const next=store.beginScan("stable"),notify=jest.fn();store.onLibraryChanged(notify);
  const cached=store.sourceObservation("stable","one")!;
  expect(store.upsertObservation({...cached,sourceId:"stable",generation:next,addedAt:2})).toBe(id);
  expect({
    locationRevision:store.openLocationCandidates(id).items[0].locationRevision,
    leaseCurrent:store.resourceLeaseCurrent(ticket),
    queryRevision:reader.page({}).revision,
    resourceRevision:store.resourceRevision(),notifications:notify.mock.calls.length,
  }).toEqual({locationRevision:ticket.locationRevision,leaseCurrent:true,queryRevision,resourceRevision,notifications:0});
  expect(db.prepare("SELECT generation FROM locations WHERE source_id='stable' AND source_key='one'").get()?.generation).toBe(next);
  expect(store.metrics.read(id)).toEqual(metrics);
  store.finishScan("stable",next);
  expect(store.getReplay(id)?.locations[0].available).toBe(true);
});
it("does not invalidate query scalars for scan-generation-only location bookkeeping",()=>{
  store.registerSource(stable);
  const first=store.beginScan("stable"),id=store.upsertObservation(verifiedObservation(first));store.finishScan("stable",first);drain();
  const reader=store.createQueryReader(),before=reader.page({}).revision,resource=store.resourceRevision();
  db.prepare("UPDATE locations SET generation=? WHERE replay_id=?").run("next-scan",id);
  expect({revision:reader.page({}).revision,pending:store.queryProjectionPending(),resource:store.resourceRevision()})
    .toEqual({revision:before,pending:0,resource});
});
it("still invalidates the old resource lease and query for a changed replay locator",()=>{
  store.registerSource(stable);
  const first=store.beginScan("stable"),id=store.upsertObservation(verifiedObservation(first));store.finishScan("stable",first);drain();
  const reader=store.createQueryReader(),ticket=store.openLocationCandidates(id).items[0],before=reader.page({}).revision,resource=store.resourceRevision();
  const next=store.beginScan("stable");store.upsertObservation(verifiedObservation(next,"moved.osr"));
  expect(store.resourceLeaseCurrent(ticket)).toBe(false);
  expect(reader.page({}).revision).not.toBe(before);expect(store.resourceRevision()).not.toBe(resource);
  store.finishScan("stable",next);expect(store.getReplay(id)?.locations[0].available).toBe(true);
});
it("migrates persisted schema-25 location triggers without rebuilding retained projections",()=>{
  const root=mkdtempSync(join(tmpdir(),"rewind-observation-migration-"));roots.push(root);const path=join(root,"index.sqlite");
  store.close();open(path);store.registerSource(stable);
  const first=store.beginScan("stable"),id=store.upsertObservation(verifiedObservation(first));store.finishScan("stable",first);drain();
  const retained=db.prepare("SELECT * FROM query_projection WHERE id=?").get(id);
  // Restore pre-journal resource triggers before simulating the historical schema.
  for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'query_resource_%'").all()) {
    const old = String(row.sql).replace(/BEGIN[\s\S]*END$/, "BEGIN UPDATE query_projection_state SET resource_revision=resource_revision+1 WHERE id=1; END");
    db.exec(`DROP TRIGGER ${row.name};${old}`);
  }
  db.exec("DROP TABLE resource_changes");
  // Restore the exact predecessor trigger: even bookkeeping updates dirtied both old/new IDs.
  db.exec(`DROP TRIGGER query_dirty_locations_update;
    CREATE TRIGGER query_dirty_locations_update AFTER UPDATE ON locations BEGIN
      INSERT INTO query_projection_dirty(id,flags) SELECT id,1 FROM (SELECT OLD.replay_id AS id) WHERE true
        ON CONFLICT(id) DO UPDATE SET flags=flags|excluded.flags;
      INSERT INTO query_projection_dirty(id,flags) SELECT id,1 FROM (SELECT NEW.replay_id AS id) WHERE true
        ON CONFLICT(id) DO UPDATE SET flags=flags|excluded.flags;
      UPDATE query_projection_state SET revision=revision+1 WHERE id=1;
    END; PRAGMA user_version=25;`);
  store.close();open(path);
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(27);
  expect(store.queryProjectionPending()).toBe(0);
  expect(db.prepare("SELECT * FROM query_projection WHERE id=?").get(id)).toEqual(retained);
  const reader=store.createQueryReader(),before=reader.page({}).revision;
  db.prepare("UPDATE locations SET generation='next',explicit_sequence=explicit_sequence+1 WHERE replay_id=?").run(id);
  expect(reader.page({}).revision).toBe(before);expect(store.queryProjectionPending()).toBe(0);
  db.prepare("UPDATE locations SET available=0 WHERE replay_id=?").run(id);
  expect(store.queryProjectionPending()).toBeGreaterThan(0);
});

const md5="a".repeat(32);
function map(generation:string,key:string,title="Title",stars=4){
  store.upsertMap({sourceId:"stable",generation,sourceKey:key,md5,locator:`${key}.osu`,state:"unverified",metadata:{
    map:{md5,title,artist:"Artist",difficulty:"Difficulty",creator:"Mapper",databaseVersion:20200101,mode:0,rankedStatus:4,drainTimeSeconds:120},
    cachedNoModStars:stars,cachedTempo:{min:120,max:120},databaseSha256:generation}});
}
function replay(id="replay",sha:string|null="b".repeat(64)){
  const metadata=JSON.stringify({header:{beatmapMD5:md5,modsBitmask:0}});
  db.prepare("INSERT INTO replays VALUES(?,1,'test',1,0,0,?,NULL)").run(id,metadata);
  db.prepare("INSERT INTO locations(source_id,source_key,replay_id,locator,sha256,generation,available,metadata) VALUES('stable',?,?,?,?,'g',1,?)")
    .run(id,id,`${id}.osr`,sha,metadata);
}
it("preserves successive publication generations until bounded semantic diffs complete, then collects bounded pages",()=>{
  store.registerSource(stable);replay();const first=store.beginMapScan("stable");
  for(const key of ["a","b","c","d"])map(first,key);store.finishMapScan("stable",first);drain();
  const second=store.beginMapScan("stable");for(const key of ["a","b","c","d"])map(second,key,"Second");store.finishMapScan("stable",second);
  expect(db.prepare("SELECT count(*) AS count FROM maps WHERE generation=?").get(first)?.count).toBe(4);
  expect(store.maintainMapGarbage(1).updated).toBe(0);
  const third=store.beginMapScan("stable");for(const key of ["a","b","c","d"])map(third,key,"Third");store.finishMapScan("stable",third);
  expect(db.prepare("SELECT count(*) AS count FROM maps WHERE generation IN (?,?)").get(first,second)?.count).toBe(8);
  drain();expect(store.createQueryReader().detail("replay")?.item.title).toBe("Third");
  for(let index=0;store.mapGarbagePending()&&index<100;index++){
    const before=Number(db.prepare("SELECT count(*) AS count FROM maps").get()?.count);store.maintainMapGarbage(1);
    const after=Number(db.prepare("SELECT count(*) AS count FROM maps").get()?.count);expect(before-after).toBeLessThanOrEqual(1);
  }
  expect(store.mapGarbagePending()).toBe(0);expect(db.prepare("SELECT DISTINCT generation FROM maps").all().map(row=>row.generation)).toEqual([third]);
});
it("resumes pending publication and old-generation cleanup across restart",()=>{
  const root=mkdtempSync(join(tmpdir(),"rewind-map-restart-"));roots.push(root);const path=join(root,"index.sqlite");store.close();open(path);
  store.registerSource(stable);replay();const first=store.beginMapScan("stable");for(const key of ["a","b","c"])map(first,key);store.finishMapScan("stable",first);drain();
  const second=store.beginMapScan("stable");for(const key of ["a","b","c"])map(second,key,"Reopened");store.finishMapScan("stable",second);
  store.close();open(path);expect(db.prepare("SELECT count(*) AS count FROM maps WHERE generation=?").get(first)?.count).toBe(3);
  drain();while(store.mapGarbagePending())store.maintainMapGarbage(1);
  expect(store.createQueryReader().detail("replay")?.item.title).toBe("Reopened");expect(db.prepare("SELECT 1 FROM maps WHERE generation=?").get(first)).toBeUndefined();
});
it("collects abandoned scans and rebuild staging without changing the visible generation",()=>{
  store.registerSource(stable);const first=store.beginMapScan("stable");map(first,"a");store.finishMapScan("stable",first);drain();
  const abandoned=store.beginMapScan("stable");map(abandoned,"a");store.stopMapScan("stable",abandoned);
  const run=store.beginRebuild(["stable"]);store.stageRebuildMap(run,{sourceId:"stable",sourceKey:"staged",md5,locator:"staged.osu",state:"unverified",metadata:{}});store.abortRebuild(run);
  expect(db.prepare("SELECT count(*) AS count FROM maps").get()?.count).toBe(3);
  drain();while(store.mapGarbagePending())store.maintainMapGarbage(1);
  expect(db.prepare("SELECT DISTINCT generation FROM maps").all().map(row=>row.generation)).toEqual([first]);
});
it("reconciles changed map metrics only for affected replays and avoids identical metric result writes",()=>{
  store.registerSource(stable);replay();const first=store.beginMapScan("stable");map(first,"a");store.finishMapScan("stable",first);drain();
  expect(store.createQueryReader().detail("replay")?.item.values.mapStars).toBe(4);
  db.exec("CREATE TABLE writes(count INTEGER);INSERT INTO writes VALUES(0);CREATE TRIGGER count_metric_writes AFTER UPDATE ON metric_results BEGIN UPDATE writes SET count=count+1;END;");
  const unchanged=store.beginMapScan("stable");map(unchanged,"a");store.finishMapScan("stable",unchanged);drain();
  expect(db.prepare("SELECT count FROM writes").get()?.count).toBe(0);
  const title=store.beginMapScan("stable");map(title,"a","Renamed");store.finishMapScan("stable",title);drain();
  expect(db.prepare("SELECT count FROM writes").get()?.count).toBe(0);
  store.setSourceEnabled("stable",false);drain();expect(store.metrics.read("replay").find(entry=>entry.target.slot==="source-map")?.result?.fields.sourceMapStars).toEqual({state:"known",value:4});
  store.setSourceEnabled("stable",true);drain();expect(db.prepare("SELECT count FROM writes").get()?.count).toBe(0);
  const metric=store.beginMapScan("stable");map(metric,"a","Renamed",5);store.finishMapScan("stable",metric);drain();
  expect(store.createQueryReader().detail("replay")?.item.values.mapStars).toBe(5);
});
it("keeps global origin completion independent of durably queued map publication",()=>{
  store.registerSource(stable);expect(store.completeSourceMetricRevision("origin:verified")).toBe(true);
  const before=store.sourceMapRevision(),generation=store.beginMapScan("stable");map(generation,"a");store.finishMapScan("stable",generation);
  expect(store.sourceMapRevision()).not.toBe(before);expect(store.sourceMetricRevision()).toBe("origin:verified");
  expect(store.completeSourceMetricRevision("origin:new")).toBe(true);expect(store.sourceMetricRevision()).toBe("origin:new");
});
it("checks source-only resource leases read-only without weakening verified current-replay publication",()=>{
  store.registerSource(stable);replay("source-only",null);drain();
  const ticket:LibraryLocationTicket={replayId:"source-only",sourceId:"stable",sourceKey:"source-only",locator:"source-only.osr",sha256:null,locationRevision:0,sourceConfigRevision:0};
  db.exec("PRAGMA query_only=ON");expect(store.resourceLeaseCurrent(ticket)).toBe(true);expect(store.resourceLeaseCurrent({...ticket,sha256:"b".repeat(64)})).toBe(false);
  expect((store as unknown as {currentReplayLeaseMatches(value:{location:LibraryLocationTicket}):boolean}).currentReplayLeaseMatches({location:ticket})).toBe(false);
  db.exec("PRAGMA query_only=OFF");store.setSourceEnabled("stable",false);expect(store.resourceLeaseCurrent(ticket)).toBe(false);
});
