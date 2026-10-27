import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { LibraryService } from "./library-service";
import { LibraryStore } from "./library-store";

let root:string,service:LibraryService;
beforeEach(async()=>{
  root=mkdtempSync(join(tmpdir(),"source-readiness-"));const directory=join(root,"owned"),replays=join(root,"replays");
  mkdirSync(directory);mkdirSync(replays);
  const source={id:"replays",kind:"replays" as const,directory:replays},seed=new LibraryStore(join(directory,"library.sqlite"),"seed");
  seed.registerSource(source);seed.metrics.setAnalysisSettings({mode:"off",workers:1,userPaused:false,pauseOnBattery:true});
  const generation=seed.beginScan("replays");
  for(let i=0;i<48;i++)seed.upsertObservation({sourceId:"replays",sourceKey:String(i),generation,locator:join(replays,i+".osr"),sha256:i.toString(16).padStart(64,"0"),available:true,addedAt:i,
    metadata:{header:{mode:0,version:20260901,beatmapMD5:"b".repeat(32),player:String(i),modsBitmask:0}}});
  seed.finishScan("replays",generation);while(seed.queryProjectionPending())seed.maintainQueryProjection();seed.close();
  service=await LibraryService.open({directory,sessionId:"test",nativeExecutable:join(root,"absent.exe"),sources:[source]},undefined,undefined,false);
  await service.settleIndexMaintenance();await service.setViewerDemand(true);
});
afterEach(async()=>{await service?.close();expect(dirname(resolve(root))).toBe(resolve(tmpdir()));expect(basename(root).startsWith("source-readiness-")).toBe(true);rmSync(root,{recursive:true,force:true});});

it("publishes ready live source reads with real pending work while the viewer parks maintenance",()=>{
  const events=jest.fn();service.onLibraryChanged(events);service.setSourceEnabled("replays",false);
  const pending=service.status().indexMaintenance.pending;expect(pending).toBeGreaterThan(0);
  expect(service.status().indexMaintenance.ready).toBe(true);
  expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ready:true}));
  expect(service.queryRequest("query-page",{})).toMatchObject({total:0,items:[]});
  expect(service.status().indexMaintenance.pending).toBe(pending);
  const initial=jest.fn();service.onLibraryChanged(initial);expect(initial).toHaveBeenCalledWith(expect.objectContaining({ready:true}));
});

it("does not emit semantic notifications for equivalent source-only shadow batches",()=>{
  const events=jest.fn();service.onLibraryChanged(events);service.setSourceEnabled("replays",false);
  const committed=events.mock.calls.length,store=service["store"],projection=store["queryProjection"];
  if(!projection)throw Error("Missing fixture projection");const revision=projection.revision();let batches=0;
  while(store.queryProjectionPending()){expect(store.maintainQueryProjection().updated).toBeLessThanOrEqual(8);expect(++batches).toBeLessThan(30);}
  expect(batches).toBeGreaterThan(1);expect(events).toHaveBeenCalledTimes(committed);
  expect(projection.revision()).toBe(revision);
  service.setSourceEnabled("replays",true);expect(events.mock.calls.length).toBeGreaterThan(committed);
  expect(service.queryRequest("query-page",{})).toMatchObject({total:48});
});

it("keeps unsafe work fenced and announces the unsafe-to-ready transition",()=>{
  const store=service["store"],events=jest.fn();service.onLibraryChanged(events);
  store["db"].exec("INSERT OR REPLACE INTO query_projection_dirty(id,flags) SELECT id,1 FROM query_projection");
  expect(service.status().indexMaintenance.ready).toBe(false);expect(()=>service.queryRequest("query-page",{})).toThrow(/updating/i);
  while(store.queryProjectionPending())store.maintainQueryProjection();
  expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ready:true}));
});

it("keeps every passive query API family available without draining or admitting work",()=>{
  service.setSourceEnabled("replays",false);service.setSourceEnabled("replays",true);
  const store=service["store"],db=store["db"],id=String(db.prepare("SELECT id FROM query_projection LIMIT 1").get()?.id);
  const passive=()=>({changes:db.prepare("SELECT total_changes() n").get()?.n,pending:store.queryProjectionPending(),admission:store.sourceAdmissionPending(),
    tables:Object.fromEntries(["metric_targets","metric_results","metric_jobs","analysis_requests"].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))});
  const before=passive();expect(before.pending).toBeGreaterThan(0);expect(before.admission).toBeGreaterThan(0);
  expect(service.queryRequest("query-page",{})).toMatchObject({total:48});
  service.queryRequest("query-preview",{draft:{field:"source",values:["replays"]}});
  service.queryRequest("query-facets",{field:"astate"});service.queryRequest("query-bands",{});
  service.queryRequest("query-detail",{replayId:id});service.queryRequest("query-reveal",{replayId:id});service.queryRequest("query-same-map",{replayId:id});
  service.queryRequest("query-collections",{});service.queryRequest("query-memberships",{replayId:id});
  const snap=service.queryRequest("query-snapshot-create",{replayId:id}) as {snapshotId:string;position:number};
  service.queryRequest("query-snapshot-neighbors",{snapshotId:snap.snapshotId,options:{position:snap.position}});
  service.queryRequest("query-snapshot-release",{snapshotId:snap.snapshotId});expect(passive()).toEqual(before);
});

it("keeps an actual map-bearing source toggle unready until display work settles",()=>{
  const store=service["store"],generation=store.beginMapScan("replays");
  for(let i=0;i<12;i++)store.upsertMap({sourceId:"replays",generation,sourceKey:String(i),md5:"b".repeat(32),locator:join(root,i+".osu"),state:"unverified",metadata:{title:"Map"}});
  store.finishMapScan("replays",generation);while(store.queryProjectionPending())store.maintainQueryProjection();
  const events=jest.fn();service.onLibraryChanged(events);service.setSourceEnabled("replays",false);
  expect(service.status().indexMaintenance).toMatchObject({ready:false});expect(service.status().indexMaintenance.pending).toBeGreaterThan(0);
  expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ready:false}));expect(()=>service.queryRequest("query-page",{})).toThrow(/updating/i);
  while(store.queryProjectionPending())store.maintainQueryProjection();expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ready:true}));
});
