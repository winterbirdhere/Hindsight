import { DatabaseSync } from "node:sqlite";
import { mkdtempSync,rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
import { LibraryPerformanceCache } from "./library-performance-cache";
import type { LibraryMapCalculation } from "./library-map-performance";
const result:LibraryMapCalculation={version:1,objectCount:3,stars:1,maxCombo:3,largeTicks:0,smallTicks:0,sliderTails:0,clockRate:1,drainTimeMs:2000,endTimeMs:3000};
const key=(n:number)=>n.toString(16).padStart(64,"0");
it.each(["map miss","map hit","map put","scalar miss","scalar hit","scalar put"])("keeps %s bookkeeping silent without consuming queued projection work",operation=>{
  const folder=mkdtempSync(join(tmpdir(),"library-p-cache-notify-")),store=new LibraryStore(join(folder,"library.sqlite"),"cache");
  try{
    store.registerSource({id:"imports",kind:"imported",directory:"C:\\fixture"});
    const id=store.upsertObservation({sourceId:"imports",sourceKey:"score",locator:"score",sha256:key(9),available:true,
      generation:store.beginScan("imports"),addedAt:1,metadata:{header:{mode:0}}});
    store.performanceCache.put(key(1),"stable",result);store.performanceCache.putScalar(key(1),"stable",0);
    while(store.queryProjectionPending())store.maintainQueryProjection();
    const db=store["db"],changed=jest.fn(),dirty=jest.fn(),wake=jest.fn();
    db.prepare("UPDATE replays SET favourite=1 WHERE id=?").run(id);
    const snapshot=()=>["query_projection","query_projection_state","query_projection_dirty"].map(table=>db.prepare("SELECT * FROM "+table+" ORDER BY rowid").all()),before=snapshot();
    expect(store.queryProjectionPending()).toBe(1);
    store.onLibraryChanged(changed);store.onAnalysisDirty(dirty);store.onMaintenanceNeeded(wake);
    if(operation==="map miss")expect(store.performanceCache.get(key(2),"stable")).toBeUndefined();
    if(operation==="map hit")expect(store.performanceCache.get(key(1),"stable")).toEqual(result);
    if(operation==="map put")store.performanceCache.put(key(2),"stable",result);
    if(operation==="scalar miss")expect(store.performanceCache.getScalar(key(2),"stable")).toBeUndefined();
    if(operation==="scalar hit")expect(store.performanceCache.getScalar(key(1),"stable")).toBe(0);
    if(operation==="scalar put")store.performanceCache.putScalar(key(2),"stable",2);
    expect(changed).not.toHaveBeenCalled();expect(dirty).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);expect(store.queryProjectionPending()).toBe(1);expect(wake).toHaveBeenCalledTimes(1);
    store.maintainQueryProjection();expect(store.queryProjectionPending()).toBe(0);expect(changed).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT favourite FROM query_projection WHERE id=?").get(id)?.favourite).toBe(1);
  }finally{store.close();rmSync(folder,{recursive:true,force:true});}
});
it.each(["map","scalar"])("rolls back %s cache bookkeeping atomically on a storage fault",kind=>{
  const folder=mkdtempSync(join(tmpdir(),"library-p-cache-rollback-")),store=new LibraryStore(join(folder,"library.sqlite"),"cache");
  try{
    const db=store["db"],table=kind==="map"?"performance_map_cache":"performance_scalar_cache",changed=jest.fn();
    const snapshot=()=>[db.prepare("SELECT * FROM "+table).all(),db.prepare("SELECT value FROM counters WHERE key='performance-map-use'").get()];
    const before=snapshot();store.onLibraryChanged(changed);
    db.exec(`CREATE TRIGGER reject_cache_write AFTER INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'cache write fault');END`);
    expect(()=>kind==="map"?store.performanceCache.put(key(1),"stable",result):store.performanceCache.putScalar(key(1),"stable",0)).toThrow("cache write fault");
    expect(snapshot()).toEqual(before);expect(changed).not.toHaveBeenCalled();
    db.exec("DROP TRIGGER reject_cache_write");
    if(kind==="map"){store.performanceCache.put(key(1),"stable",result);expect(store.performanceCache.get(key(1),"stable")).toEqual(result);}
    else{store.performanceCache.putScalar(key(1),"stable",0);expect(store.performanceCache.getScalar(key(1),"stable")).toBe(0);}
  }finally{store.close();rmSync(folder,{recursive:true,force:true});}
});
function removePostSchema15Objects(db:DatabaseSync){
  // Drop dependent triggers before their referenced C/query tables and columns.
  for(const type of ["trigger","index","table"]){
    const objects=db.prepare("SELECT name FROM sqlite_master WHERE type=? AND (name GLOB 'query_*' OR name GLOB 'map_cleanup_*')").all(type);
    for(const object of objects)db.exec(`DROP ${type.toUpperCase()} "${String(object.name).replace(/"/g,'""')}"`);
  }
  db.exec("DROP TABLE IF EXISTS resource_changes; DROP TABLE incident_source_epochs; DROP TABLE incident_location_epochs; DROP TABLE incident_recipes; ALTER TABLE metric_results DROP COLUMN strip_payload;");
}
it("shares compact map math across identities and restart while Off and metadata remain independent",()=>{
  const folder=mkdtempSync(join(tmpdir(),"library-p-cache-")),path=join(folder,"library.sqlite");let store=new LibraryStore(path,"one");
  try{
    store.performanceCache.put(key(1),"stable",result);store.metrics.setAnalysisSettings({mode:"off",userPaused:false,workers:1,pauseOnBattery:true});
    store.close();store=new LibraryStore(path,"two");expect(store.performanceCache.get(key(1),"stable")).toEqual(result);
    expect(store.performanceCache.get(key(1),"lazer")).toBeUndefined();expect(store.metrics.nextQueued()).toEqual([]);
    expect(store.performanceCache.get(key(2),"stable")).toBeUndefined();
  }finally{store.close();rmSync(folder,{recursive:true,force:true});}
});
it("caps persistent LRU storage and never overwrites conflicting mathematics under one semantic key",()=>{
  const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE counters(key TEXT PRIMARY KEY,value INTEGER NOT NULL)");LibraryPerformanceCache.migrate(db);
  const transaction=<T>(work:()=>T):T=>{db.exec("BEGIN");try{const value=work();db.exec("COMMIT");return value;}catch(error){db.exec("ROLLBACK");throw error;}};
  const cache=new LibraryPerformanceCache(db,transaction,2);
  try{
    cache.put(key(1),"stable",result);cache.put(key(2),"lazer",result);cache.get(key(1),"stable");cache.put(key(3),"stable",result);
    expect(cache.get(key(2),"lazer")).toBeUndefined();expect(cache.get(key(1),"stable")).toEqual(result);
    expect(()=>cache.put(key(1),"stable",{...result,stars:2})).toThrow(/conflict/i);
    expect(cache.get(key(1),"stable")).toEqual(result);
    expect(()=>cache.put(key(4),"stable",{...result,stars:NaN})).toThrow();
    expect(()=>cache.put(key(4),"stable",{...result,rawFrames:"forbidden"} as LibraryMapCalculation)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM performance_map_cache").get()?.count).toBe(2);
  }finally{db.close();}
});
it("migrates schema12 preserving identities and user metadata without creating analysis jobs",()=>{
  const folder=mkdtempSync(join(tmpdir(),"library-p-migration-")),path=join(folder,"library.sqlite");let store=new LibraryStore(path,"one");
  try{
    store.registerSource({id:"s",kind:"stable",directory:"C:\\fixture"});const replay=store.upsertObservation({sourceId:"s",sourceKey:"k",locator:"missing",
      sha256:null,available:false,generation:store.beginScan("s"),addedAt:1,metadata:{}});store.setFavourite(replay,true);store.close();
    const prior=new DatabaseSync(path);try{
      removePostSchema15Objects(prior);
      prior.exec("DROP TABLE performance_scalar_cache; DROP TABLE performance_recipes; DROP TABLE performance_map_cache; DELETE FROM counters WHERE key='performance-map-use'; PRAGMA user_version=12");
    }finally{prior.close();}
    store=new LibraryStore(path,"two");expect(store.getReplay(replay)?.favourite).toBe(true);expect(store.metrics.nextQueued()).toEqual([]);
    store.performanceCache.put(key(1),"stable",result);expect(store.performanceCache.get(key(1),"stable")).toEqual(result);
  }finally{store.close();rmSync(folder,{recursive:true,force:true});}
});
it("keeps bounded shared scalar PP including zero across restart and Off, rejecting conflicting or invalid math",()=>{
  const folder=mkdtempSync(join(tmpdir(),"library-p-scalar-")),path=join(folder,"library.sqlite");let store=new LibraryStore(path,"one");
  try{
    store.performanceCache.putScalar(key(1),"stable",0);store.metrics.setAnalysisSettings({mode:"off",userPaused:false,workers:1,pauseOnBattery:true});
    store.close();store=new LibraryStore(path,"two");expect(store.performanceCache.getScalar(key(1),"stable")).toBe(0);
    expect(store.performanceCache.getScalar(key(1),"lazer")).toBeUndefined();expect(()=>store.performanceCache.putScalar(key(1),"stable",2)).toThrow(/conflict/i);
    for(const value of [NaN,Infinity,-1])expect(()=>store.performanceCache.putScalar(key(2),"stable",value)).toThrow();
    store.close();const db=new DatabaseSync(path);try{
      const cache=new LibraryPerformanceCache(db,work=>work(),2);
      cache.putScalar(key(2),"stable",2);cache.getScalar(key(1),"stable");cache.putScalar(key(3),"stable",3);
      expect(cache.getScalar(key(2),"stable")).toBeUndefined();expect(db.prepare("SELECT COUNT(*) AS n FROM performance_scalar_cache").get()?.n).toBe(2);
    }finally{db.close();}store=new LibraryStore(path,"three");expect(store.metrics.nextQueued()).toEqual([]);
  }finally{store.close();rmSync(folder,{recursive:true,force:true});}
});
