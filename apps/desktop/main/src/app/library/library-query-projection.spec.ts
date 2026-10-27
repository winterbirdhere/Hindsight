import { DatabaseSync } from "node:sqlite";
import { LibraryStore } from "./library-store";
import { LibraryQueryProjection } from "./library-query-projection";
import { LibraryQueryReader, LibraryQueryUpdatingError } from "./library-query";

let store:LibraryStore,db:DatabaseSync,projection:LibraryQueryProjection,query:LibraryQueryReader;
const md5="b".repeat(32);
const estimateVisibilityKey="independent-performance-visibility-v2";
beforeEach(()=>{
  store=new LibraryStore(":memory:","test");db=(store as unknown as {db:DatabaseSync}).db;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='query_projection'").get())LibraryQueryProjection.migrate(db);
  projection=new LibraryQueryProjection(db);query=new LibraryQueryReader(db,"test");
  store.registerSource({id:"source",kind:"stable",directory:"fixture"});
});
afterEach(()=>store.close());
function add(id:string){
  db.prepare("INSERT INTO replays VALUES(?,1,'test',1,0,0,?,NULL)").run(id,JSON.stringify({header:{beatmapMD5:md5,player:id,modsBitmask:0}}));
  db.prepare("INSERT INTO locations(source_id,source_key,replay_id,locator,generation,available,metadata) VALUES('source',?,?,?,'g',1,'{}')").run(id,id,id);
}
function flush(){while(projection.pendingCount())projection.flushInTransaction(128);}
it.each(["off","demand","bg"])("repairs installed native-first names in eight-row turns without calculation work (%s)",mode=>{
  for(let index=0;index<12;index++){
    const id=`name-${String(index).padStart(2,"0")}`;add(id);
    const metadata={header:{beatmapMD5:md5,player:`Recorded${index}`,mode:0,version:20260901},nativeScore:{player:`Account${index}`,isLegacyScore:true}};
    db.prepare("UPDATE replays SET metadata=? WHERE id=?").run(JSON.stringify(metadata),id);
  }
  const collection=store.createCollection("Preserved history");store.setMembership("name-00",collection,true);
  store.setReview("name-00","reviewed");store.setFavourite("name-00",true);
  for(const [slot,stage,fields] of [["aggregate-pp","P",{pp:{state:"known",value:183}}],["numerical","S",{ur:{state:"known",value:246.4}}]] as const){
    db.prepare("INSERT INTO metric_targets VALUES('name-00',?,?,?,'fixture',1)").run(slot,stage,slot);
    db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES('name-00',?,?,?,'fixture',?)")
      .run(slot,stage,slot,JSON.stringify({fields,provenance:{fixture:"preserved"}}));
  }
  db.prepare("INSERT INTO settings(key,value) VALUES('player-names',?)").run(JSON.stringify(["recorded0"]));
  db.prepare("UPDATE settings SET value=? WHERE key='analysis'").run(JSON.stringify({mode,userPaused:true,workers:4}));
  flush();db.exec(`UPDATE query_projection SET player='Account'||CAST(substr(id,6) AS INTEGER),player_folded=lower('Account'||CAST(substr(id,6) AS INTEGER)),
    search_text=lower('Account'||CAST(substr(id,6) AS INTEGER)),filter_evidence_revision='recorded-filter-evidence-v1';
    UPDATE query_filter_evidence_state SET complete=1,after_id='zz',verified=12;`);
  const protectedTables=["replays","locations","metric_targets","metric_results","metric_jobs","analysis_requests","settings","collections","memberships","review_edits"];
  const snapshot=()=>protectedTables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before=snapshot();
  const check=()=>{
    const reader=new LibraryQueryReader(db,"names"),changes=db.prepare("SELECT total_changes() n").get()?.n;
    expect(reader.detail("name-00")?.item.player).toBe("Recorded0");
    expect(reader.page({filters:[{field:"player",values:["recorded0"]}]}).items.map(item=>item.id)).toEqual(["name-00"]);
    expect(reader.page({filters:[{field:"player",values:[],me:true}]}).items.map(item=>item.id)).toEqual(["name-00"]);
    expect(reader.page({filters:[{field:"player",values:["Account0"]}]}).total).toBe(0);
    expect(reader.page({search:"Recorded0"}).items.map(item=>item.id)).toEqual(["name-00"]);
    expect(reader.page({search:"Account0"}).total).toBe(0);
    expect(reader.facets({},"player").items.map(item=>item.value)).not.toContain("Account0");
    expect(db.prepare("SELECT total_changes() n").get()?.n).toBe(changes);
  };
  // A passive cold reader must be correct before the writer has enrolled the old epoch.
  check();projection=new LibraryQueryProjection(db);expect(projection.identityPending()).toBe(true);
  check();const cursorReader=new LibraryQueryReader(db,"cursor",Date.now,{revision:()=>projection.revision()}),page=cursorReader.page({limit:1});
  const retained=db.prepare("SELECT pp,ur,analysis_without_c,analysis_algorithm FROM query_projection WHERE id='name-00'").get();
  expect(projection.maintainIdentityInTransaction()).toEqual({updated:8,pending:true});
  expect(db.prepare("SELECT pp,ur,analysis_without_c,analysis_algorithm FROM query_projection WHERE id='name-00'").get()).toEqual(retained);
  expect(()=>cursorReader.page({limit:1,cursor:page.next})).toThrow();check();
  projection=new LibraryQueryProjection(db);
  expect(projection.maintainIdentityInTransaction().updated).toBe(4);check();
  let turns=0;while(projection.identityPending()){expect(++turns).toBeLessThanOrEqual(2);projection.maintainIdentityInTransaction();}
  const settled=db.prepare("SELECT * FROM query_filter_evidence_state").get();expect(settled).toMatchObject({complete:1,verified:12});
  projection=new LibraryQueryProjection(db);expect(projection.maintainIdentityInTransaction()).toEqual({updated:0,pending:false});
  expect(db.prepare("SELECT * FROM query_filter_evidence_state").get()).toEqual(settled);
  expect(snapshot()).toEqual(before);
});
it("keeps 20k player-upgrade query plans lazy and records transition versus settled costs",()=>{
  db.exec(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<19999)
    INSERT INTO replays SELECT 'population-'||printf('%05d',x),1,'test',x,0,0,
      json_object('header',json_object('beatmapMD5','${md5}','player','Recorded'||(x%4),'mode',0,'version',20260901),
      'nativeScore',json_object('player','Account'||(x%4),'isLegacyScore',json('true'))),NULL FROM n;
    INSERT INTO locations(source_id,source_key,replay_id,locator,generation,available,metadata)
      SELECT 'source',id,id,id,'g',1,'{}' FROM replays;
    INSERT INTO settings(key,value) VALUES('player-names','["recorded0"]');`);
  flush();
  while(projection.identityPending())projection.maintainIdentityInTransaction();
  const measurements:unknown[]=[];
  const measure=(phase:string)=>{
    const plans:string[][]=[],statements:string[]=[],observed:{sql:string;args:Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>}[]=[],timings:Record<string,number>={};
    const reader=new LibraryQueryReader({prepare(sql:string){const statement=db.prepare(sql);
      if(!sql.startsWith("WITH "))return statement;statements.push(sql);
      return new Proxy(statement,{get(target,key){const value=target[key as keyof typeof target];if(typeof value!=="function")return value;
        return(...args:Parameters<typeof statement.all>)=>{if(key==="all"||key==="get")observed.push({sql,args});
          return value.apply(target,args);};}});
    }},"population");
    const timed=(name:string,read:()=>number,want:number)=>{const start=performance.now();expect(read()).toBe(want);timings[name]=performance.now()-start;};
    timed("count",()=>reader.page({limit:1}).total,20000);
    timed("player",()=>reader.preview({},{field:"player",values:["recorded0"]}).count,5000);
    timed("me",()=>reader.page({limit:1,filters:[{field:"player",values:[],me:true}]}).total,5000);
    timed("literalSearch",()=>reader.page({limit:1,search:"Recorded0"}).total,5000);
    timed("playerFacet",()=>reader.facets({},"player").items.find(row=>row.value==="Recorded0")?.count??0,5000);
    for(const {sql,args} of observed)plans.push(db.prepare("EXPLAIN QUERY PLAN "+sql).all(...args).map(row=>String(row.detail)));
    expect(plans.flat()).not.toContain("MATERIALIZE projected");
    expect(plans.flat().filter(row=>/^SCAN r\b/.test(row))).toEqual([]);
    if(phase==="settled")expect(statements.every(sql=>!sql.includes("$.header.player"))).toBe(true);
    measurements.push({phase,timings,plans});
  };
  measure("before");
  db.exec(`UPDATE query_projection SET player='Account'||(CAST(substr(id,12) AS INTEGER)%4),player_folded='account'||(CAST(substr(id,12) AS INTEGER)%4),
    search_text='account'||(CAST(substr(id,12) AS INTEGER)%4),filter_evidence_revision='recorded-filter-evidence-v1';
    UPDATE query_filter_evidence_state SET complete=1,verified=20000;
    DROP INDEX query_filter_evidence_pending;CREATE INDEX query_filter_evidence_pending ON query_projection(id) WHERE filter_evidence_revision IS NULL`);
  const enrol=performance.now();projection=new LibraryQueryProjection(db);const indexMs=performance.now()-enrol;measure("stale");
  expect(projection.maintainIdentityInTransaction().updated).toBe(8);measure("during");
  const repair=performance.now();let turns=1;
  while(projection.identityPending()){expect(projection.maintainIdentityInTransaction().updated).toBeLessThanOrEqual(8);expect(++turns).toBeLessThanOrEqual(2501);}
  const repairMs=performance.now()-repair;measure("settled");
  expect(db.prepare("SELECT count(*) n FROM metric_jobs").get()?.n).toBe(0);
  console.info("recorded-player-20k "+JSON.stringify({population:20000,indexMs,repairMs,turns,measurements}));
},60000);
it("starts the new name epoch once when the old evidence repair was incomplete",()=>{
  for(const id of ["a","b","c","d"])add(id);flush();
  db.exec(`UPDATE query_projection SET player='Obsolete',player_folded='obsolete',search_text='obsolete',
    filter_evidence_revision=CASE WHEN id IN ('a','b') THEN 'recorded-filter-evidence-v1' ELSE NULL END;
    UPDATE query_filter_evidence_state SET complete=0,after_id='b',verified=2;
    DROP INDEX query_filter_evidence_pending;CREATE INDEX query_filter_evidence_pending ON query_projection(id) WHERE filter_evidence_revision IS NULL`);
  projection=new LibraryQueryProjection(db);
  expect(db.prepare("SELECT verified FROM query_filter_evidence_state WHERE id=1").get()?.verified).toBe(0);
  projection.maintainIdentityInTransaction();
  expect(db.prepare("SELECT verified FROM query_filter_evidence_state WHERE id=1").get()?.verified).toBe(4);
  expect(query.facets({},"player").items.map(row=>row.value)).toEqual(["a","b","c","d"]);
  projection=new LibraryQueryProjection(db);
  expect(db.prepare("SELECT verified FROM query_filter_evidence_state WHERE id=1").get()?.verified).toBe(4);
});
it("completes an empty PP recovery page and repairs pending identity rows in the same bounded turn",()=>{
  for(let index=0;index<9;index++)add(`legacy-${index}`);flush();
  db.exec("UPDATE query_projection SET filter_evidence_revision=NULL;UPDATE query_filter_evidence_state SET complete=0,verified=0");
  const callback=jest.fn();projection=new LibraryQueryProjection(db,{onPerformanceReplay:callback});
  expect(db.prepare("SELECT count(*) n FROM performance_recipes").get()?.n).toBe(0);
  expect(projection.maintainIdentityInTransaction()).toEqual({updated:8,pending:true});
  expect(callback).not.toHaveBeenCalled();
  const cursor=db.prepare("SELECT value FROM settings WHERE key=?").get(estimateVisibilityKey);expect(cursor).toBeDefined();
  expect(JSON.parse(String(cursor?.value))).toEqual({after_id:"",complete:1,verified:0});
  expect(projection.maintainIdentityInTransaction()).toEqual({updated:1,pending:true});
  expect(db.prepare("SELECT count(*) n FROM query_projection WHERE filter_evidence_revision IS NULL").get()?.n).toBe(0);
  // Filter rebuilding retains the pre-existing separate NULL-status fallback pass.
  let turns=0;while(projection.identityPending()){expect(++turns).toBeLessThanOrEqual(2);expect(projection.maintainIdentityInTransaction().updated).toBeLessThanOrEqual(8);}
});
it("rolls empty PP cursor completion back with a failing same-turn scalar repair",()=>{
  add("legacy");flush();db.exec("UPDATE query_projection SET filter_evidence_revision=NULL;UPDATE query_filter_evidence_state SET complete=0,verified=0");
  projection=new LibraryQueryProjection(db,{onPerformanceReplay:jest.fn()});
  db.exec("CREATE TRIGGER reject_pp_empty_repair BEFORE INSERT ON query_projection BEGIN SELECT RAISE(ABORT,'scalar repair fault');END");
  db.exec("BEGIN");expect(()=>projection.maintainIdentityInTransaction()).toThrow("scalar repair fault");db.exec("ROLLBACK");
  expect(db.prepare("SELECT value FROM settings WHERE key=?").get(estimateVisibilityKey)).toBeUndefined();
  expect(db.prepare("SELECT verified FROM query_filter_evidence_state WHERE id=1").get()?.verified).toBe(0);
});
it("recovers only old completion-masked P aggregates in bounded durable metadata pages",()=>{
  for(let index=0;index<19;index++){
    const id=`pp-${String(index).padStart(2,"0")}`;add(id);
    const state=index===15?"known":"unknown",reason=index===16?"score-unavailable":"completion-unavailable",stage=index===17?"S":"P";
    db.prepare("INSERT INTO metric_targets VALUES(?,'aggregate-pp',?,'old','fixture',1)").run(id,stage);
    db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,'aggregate-pp',?,'old','fixture',?)")
      .run(id,stage,JSON.stringify({fields:{pp:state==="known"?{state,value:0}:{state,reason}},provenance:{}}));
    const rawPp=index===18?{state:"unknown",reason:"score-coverage-unavailable"}:{state:"known",value:index};
    db.prepare("INSERT INTO performance_recipes VALUES(?,0,0,?)").run(id,JSON.stringify({version:1,results:[{slot:"aggregate-pp",stage:"P",fields:{pp:rawPp}}]}));
  }
  flush();const callback=jest.fn(),options={onPerformanceReplay:callback};projection=new LibraryQueryProjection(db,options);
  expect(projection.identityPending()).toBe(true);
  expect(projection.maintainIdentityInTransaction()).toEqual({updated:8,pending:true});expect(callback).toHaveBeenCalledTimes(8);
  projection=new LibraryQueryProjection(db,options);
  expect(projection.maintainIdentityInTransaction()).toEqual({updated:8,pending:true});expect(callback).toHaveBeenCalledTimes(15);
  expect(projection.maintainIdentityInTransaction()).toEqual({updated:3,pending:false});expect(callback).toHaveBeenCalledTimes(15);
  expect(new LibraryQueryProjection(db,options).maintainIdentityInTransaction()).toEqual({updated:0,pending:false});
  expect(db.prepare("SELECT count(*) n FROM metric_jobs").get()?.n).toBe(0);
  expect(db.prepare("SELECT count(*) n FROM analysis_requests").get()?.n).toBe(0);
});
it("does not advance the aggregate visibility cursor past a failed atomic callback",()=>{
  add("old");flush();
  db.exec("INSERT INTO metric_targets VALUES('old','aggregate-pp','P','old','fixture',1)");
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES('old','aggregate-pp','P','old','fixture',?)")
    .run(JSON.stringify({fields:{pp:{state:"unknown",reason:"completion-unavailable"}},provenance:{}}));
  db.prepare("INSERT INTO performance_recipes VALUES('old',0,0,?)")
    .run(JSON.stringify({version:1,results:[{slot:"aggregate-pp",stage:"P",fields:{pp:{state:"known",value:1}}}]}));
  const callback=jest.fn(()=>{throw Error("atomic failure");});projection=new LibraryQueryProjection(db,{onPerformanceReplay:callback});
  db.exec("BEGIN");expect(()=>projection.maintainIdentityInTransaction()).toThrow("atomic failure");db.exec("ROLLBACK");
  expect(projection.identityPending()).toBe(true);expect(db.prepare("SELECT value FROM settings WHERE key=?").get(estimateVisibilityKey)).toBeUndefined();
});
it("upgrades a completed R9 visibility epoch and resumes only matching masked P estimates once per replay",()=>{
  const prior={after_id:"zzzz",complete:1,verified:7604};
  db.prepare("INSERT INTO settings VALUES('independent-aggregate-pp-visibility-v1',?)").run(JSON.stringify(prior));
  for(let index=0;index<14;index++){
    const id=`fc-${String(index).padStart(2,"0")}`;add(id);
    const state=index===10?{state:"known",value:10}:{state:"unknown",reason:index===11?"profile-unavailable":"completion-unavailable"},stage=index===12?"S":"P";
    db.prepare("INSERT INTO metric_targets VALUES(?,'fc-pp',?,'old','fixture',1)").run(id,stage);
    db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,'fc-pp',?,'old','fixture',?)")
      .run(id,stage,JSON.stringify({fields:{ppIfFc:state},provenance:{}}));
    const rawFc=[9,13].includes(index)?{state:"unknown",reason:"aggregate-object-coverage-incomplete"}:{state:"known",value:index};
    const results=[{slot:"fc-pp",stage:"P",fields:{ppIfFc:rawFc}},{slot:"aggregate-pp",stage:"P",fields:{pp:{state:"known",value:index}}}];
    if(index===0){
      db.prepare("INSERT INTO metric_targets VALUES(?,'aggregate-pp','P','old','fixture',1)").run(id);
      db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,'aggregate-pp','P','old','fixture',?)")
        .run(id,JSON.stringify({fields:{pp:{state:"unknown",reason:"completion-unavailable"}},provenance:{}}));
    }
    db.prepare("INSERT INTO performance_recipes VALUES(?,0,0,?)").run(id,JSON.stringify({version:1,results}));
  }
  flush();const callback=jest.fn(),options={onPerformanceReplay:callback};projection=new LibraryQueryProjection(db,options);
  expect(projection.maintainIdentityInTransaction()).toEqual({updated:8,pending:true});expect(callback).toHaveBeenCalledTimes(8);
  projection=new LibraryQueryProjection(db,options);
  expect(projection.maintainIdentityInTransaction()).toEqual({updated:6,pending:false});
  expect(callback.mock.calls.map(call=>call[0])).toEqual(Array.from({length:9},(_,i)=>`fc-${String(i).padStart(2,"0")}`));
  expect(JSON.parse(String(db.prepare("SELECT value FROM settings WHERE key=?").get(estimateVisibilityKey)?.value))).toEqual({after_id:"fc-13",complete:1,verified:14});
  expect(JSON.parse(String(db.prepare("SELECT value FROM settings WHERE key='independent-aggregate-pp-visibility-v1'").get()?.value))).toEqual(prior);
  expect(projection.maintainIdentityInTransaction()).toEqual({updated:0,pending:false});expect(callback).toHaveBeenCalledTimes(9);
  expect(db.prepare("SELECT count(*) n FROM metric_jobs").get()?.n).toBe(0);expect(db.prepare("SELECT count(*) n FROM analysis_requests").get()?.n).toBe(0);
});
it("rolls an If FC restoration failure back without replacing the completed R9 cursor",()=>{
  add("fc-atomic");flush();const prior=JSON.stringify({after_id:"zzzz",complete:1,verified:1});
  db.prepare("INSERT INTO settings VALUES('independent-aggregate-pp-visibility-v1',?)").run(prior);
  db.exec("INSERT INTO metric_targets VALUES('fc-atomic','fc-pp','P','old','fixture',1)");
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES('fc-atomic','fc-pp','P','old','fixture',?)")
    .run(JSON.stringify({fields:{ppIfFc:{state:"unknown",reason:"completion-unavailable"}},provenance:{}}));
  db.prepare("INSERT INTO performance_recipes VALUES('fc-atomic',0,0,?)")
    .run(JSON.stringify({version:1,results:[{slot:"fc-pp",stage:"P",fields:{ppIfFc:{state:"known",value:0}}}]}));
  projection=new LibraryQueryProjection(db,{onPerformanceReplay:()=>{throw Error("FC atomic failure");}});
  db.exec("BEGIN");expect(()=>projection.maintainIdentityInTransaction()).toThrow("FC atomic failure");db.exec("ROLLBACK");
  expect(db.prepare("SELECT value FROM settings WHERE key=?").get(estimateVisibilityKey)).toBeUndefined();
  expect(db.prepare("SELECT value FROM settings WHERE key='independent-aggregate-pp-visibility-v1'").get()?.value).toBe(prior);
});
it.each([0,454.52234070017204])("displays calculated If FC=%s without an actual FC or Passed claim",value=>{
  add("fc-visible");db.exec("INSERT INTO metric_targets VALUES('fc-visible','fc-pp','P','current','fixture',1)");
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES('fc-visible','fc-pp','P','current','fixture',?)")
    .run(JSON.stringify({fields:{ppIfFc:{state:"known",value}},provenance:{}}));
  flush();expect(query.detail("fc-visible")?.item).toMatchObject({completion:null,fullCombo:null,values:{fc:value}});
});
it("keeps unknown completion and FC while displaying calculated aggregate zero or positive PP; failed styling remains",()=>{
  for(const [id,value,failed] of [["zero",0,false],["positive",183.13770131800254,false],["failed",200,true]] as const){
    add(id);db.prepare("INSERT INTO metric_targets VALUES(?,'aggregate-pp','P','current','fixture',1)").run(id);
    db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,'aggregate-pp','P','current','fixture',?)")
      .run(id,JSON.stringify({fields:{pp:{state:"known",value}},provenance:{sourceOnly:true}}));
    if(failed){db.prepare("INSERT INTO metric_targets VALUES(?,'numerical','S','current','fixture',1)").run(id);
      db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES(?,'numerical','S','current','fixture',?)")
        .run(id,JSON.stringify({fields:{completion:{state:"known",value:"failed"}},provenance:{completionEvidence:"recorded-outcome-v1"}}));}
  }
  flush();
  expect(query.detail("zero")?.item).toMatchObject({completion:null,fullCombo:null,values:{pp:0,fc:null}});
  expect(query.detail("positive")?.item).toMatchObject({completion:null,fullCombo:null,values:{pp:183.13770131800254,fc:null}});
  expect(query.detail("failed")?.item).toMatchObject({completion:"failed",values:{pp:null,fc:null}});
});
it("provisions the optional analysis cover only in the writer without changing schema version or logical rows",()=>{
  add("a");add("b");flush();db.exec("DROP INDEX IF EXISTS query_projection_analysis_cover");
  const before=db.prepare("SELECT * FROM query_projection ORDER BY id").all(),revision=projection.revision(),version=db.prepare("PRAGMA user_version").get()?.user_version;
  db.exec("PRAGMA query_only=ON");
  expect(new LibraryQueryReader(db,"without-index").facets({},"astate").items).toEqual([{value:"none",count:2}]);
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='query_projection_analysis_cover'").get()).toBeUndefined();
  db.exec("PRAGMA query_only=OFF");
  const changes=db.prepare("SELECT total_changes() n").get()?.n;
  new LibraryQueryProjection(db);
  expect(db.prepare("PRAGMA index_info(query_projection_analysis_cover)").all().map(row=>row.name)).toEqual(["visible","id","c_identity","analysis_algorithm","analysis","analysis_without_c"]);
  expect(db.prepare("SELECT * FROM query_projection ORDER BY id").all()).toEqual(before);
  expect(db.prepare("SELECT total_changes() n").get()?.n).toBe(changes);expect(projection.revision()).toBe(revision);
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
  const page=db.prepare("SELECT rootpage FROM sqlite_master WHERE name='query_projection_analysis_cover'").get();
  new LibraryQueryProjection(db);expect(db.prepare("SELECT rootpage FROM sqlite_master WHERE name='query_projection_analysis_cover'").get()).toEqual(page);
});
it("does not provision the optional cover on legacy projections missing algorithm capabilities",()=>{
  const legacy=new DatabaseSync(":memory:");
  try{
    legacy.exec("CREATE TABLE query_projection(id TEXT PRIMARY KEY,visible REAL,analysis TEXT); PRAGMA user_version=21");
    expect(()=>new LibraryQueryProjection(legacy)).not.toThrow();
    expect(legacy.prepare("SELECT 1 FROM sqlite_master WHERE name='query_projection_analysis_cover'").get()).toBeUndefined();
    expect(legacy.prepare("PRAGMA user_version").get()?.user_version).toBe(21);
  }finally{legacy.close();}
});
it("reads cold filter evidence passively before bounded repair and preserves matching FC/client/name/mode truth",()=>{
  add("a");add("b");
  db.prepare("UPDATE replays SET metadata=? WHERE id='a'").run(JSON.stringify({header:{mode:0,version:20260901,player:"Éclair",modsBitmask:0}}));
  db.prepare("UPDATE replays SET metadata=? WHERE id='b'").run(JSON.stringify({header:{mode:1,version:20260901,player:"Other",modsBitmask:0}}));
  const known=(value:string|number)=>({state:"known",value});
  for(const [slot,stage,fields,provenance] of [
    ["source-score","H",{completion:known("passed"),misses:known(0),maxCombo:known(100)},{completionEvidence:"recorded-outcome-v1"}],
    ["numerical","S",{comboLosses:known(0),sliderBreaks:known(0)},{completeBreakEvidence:true,ruleset:"stable"}],
    ["calculated-map","P",{exactMapMaxCombo:known(100)},{}],
  ] as const){
    db.prepare("INSERT INTO metric_targets VALUES('a',?,?,?,'fixture',1)").run(slot,stage,slot);
    db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES('a',?,?,?,'fixture',?)").run(slot,stage,slot,JSON.stringify({fields,provenance}));
  }
  flush();db.exec("UPDATE query_projection SET filter_evidence_revision=NULL,recorded_completion='failed',recording_client='lazer',standard_excluded=0,player_folded='wrong',full_combo=0,perfect_combo=0;UPDATE query_filter_evidence_state SET complete=0,verified=0");
  const reader=new LibraryQueryReader(db,"cold"),before=db.prepare("SELECT total_changes() n").get()?.n;
  db.exec("PRAGMA query_only=ON");
  expect(reader.page({filters:[{field:"result",values:["fc"]},{field:"playedon",values:["stable"]},{field:"player",values:["éclair"]}]})).toMatchObject({total:1,items:[{id:"a",completion:"passed",fullCombo:true,perfectCombo:true,recordingClient:"stable"}]});
  expect(reader.page().total).toBe(1);expect(db.prepare("SELECT total_changes() n").get()?.n).toBe(before);
  db.exec("PRAGMA query_only=OFF");expect(projection.maintainIdentityInTransaction().updated).toBe(2);
  expect(reader.page({filters:[{field:"result",values:["fc"]}]})).toMatchObject({total:1,items:[{id:"a",fullCombo:true,perfectCombo:true}]});
});
it("keeps a safe visibility toggle readable without historical metric callbacks",()=>{
  add("a");add("b");flush();
  const source=jest.fn(),map=jest.fn(),owned=new LibraryQueryProjection(db,{onSourceReplay:source,onMapReplay:map});
  db.exec("UPDATE sources SET enabled=0,config_revision=config_revision+1 WHERE id='source'");
  expect(owned.pendingCount()).toBeGreaterThan(0);
  const before=()=>db.prepare("SELECT total_changes() n").get()?.n;
  let changes=before();expect(query.page({}).total).toBe(0);expect(before()).toBe(changes);
  owned.flushInTransaction(1);expect(owned.pendingCount()).toBeGreaterThan(0);
  changes=before();expect(query.page({}).total).toBe(0);expect(before()).toBe(changes);
  while(owned.pendingCount())owned.flushInTransaction(1);
  expect(source).not.toHaveBeenCalled();expect(map).not.toHaveBeenCalled();
  expect(query.page({}).total).toBe(0);
  expect(db.prepare("SELECT count(*) AS n FROM query_projection").get()?.n).toBe(2);
});

it.each([2,4,8,14])("patches only affected scalar families for partial work flags %i without reconstructing rows",flags=>{
  add("a");flush();
  db.exec("UPDATE query_projection SET pp=79,incidents=17,title='Retained',visible=0,source_kinds='[]' WHERE id='a'");
  db.prepare("INSERT INTO query_projection_dirty(id,flags) VALUES('a',?)").run(flags);
  const exec=jest.spyOn(db,"exec");
  try{
    expect(projection.flushInTransaction(8)).toEqual({updated:1,pending:0});
    const statements=exec.mock.calls.map(([sql])=>sql);
    expect(statements.filter(sql=>sql.includes("INSERT INTO query_projection("))).toHaveLength(0);
    expect(statements.filter(sql=>sql.includes("WITH affiliation"))).toHaveLength(flags&8?1:0);
    expect(statements.filter(sql=>sql.includes("SET incidents="))).toHaveLength(flags&2?1:0);
    expect(statements.filter(sql=>sql.includes("WITH chosen"))).toHaveLength(flags&4?1:0);
    expect(db.prepare("SELECT pp,incidents,title,visible,source_kinds FROM query_projection WHERE id='a'").get()).toEqual({
      pp:79,incidents:flags&2?null:17,title:flags&4?null:"Retained",visible:flags&8?1:0,source_kinds:flags&8?'["stable"]':"[]"});
  }finally{exec.mockRestore();}
});
it("honours full work introduced by a source callback and partial work on another row in the same batch",()=>{
  add("a");add("b");flush();
  db.exec("UPDATE query_projection SET pp=79,incidents=17 WHERE id='b';INSERT INTO query_projection_dirty(id,flags) VALUES('b',2)");
  const callback=jest.fn((id:string)=>db.prepare("UPDATE replays SET favourite=1 WHERE id=?").run(id));
  const owned=new LibraryQueryProjection(db,{onSourceReplay:callback});
  db.exec("INSERT INTO query_projection_scopes(kind,scope_id) VALUES('source-locations','source')");
  const exec=jest.spyOn(db,"exec");
  try{
    expect(owned.flushInTransaction(1)).toEqual({updated:1,pending:2});expect(callback).toHaveBeenCalledWith("a");
    expect(()=>query.page({})).toThrow(LibraryQueryUpdatingError);
    expect(db.prepare("SELECT favourite FROM query_projection WHERE id='a'").get()?.favourite).toBe(1);
    // Finish the existing source pass; callback dirtiness dominates partial flags.
    owned.flushInTransaction(8);expect(owned.pendingCount()).toBe(0);
    expect(query.page({scope:{kind:"favourites"}}).total).toBe(2);
    expect(db.prepare("SELECT pp,incidents FROM query_projection WHERE id='b'").get()).toEqual({pp:null,incidents:null});
    expect(exec.mock.calls.filter(([sql])=>sql.includes("INSERT INTO query_projection("))).toHaveLength(2);
  }finally{exec.mockRestore();}
});
it("combines different rows' patch families while full flags dominate only their own row",()=>{
  for(const id of ["a","b","c"])add(id);flush();
  db.exec(`UPDATE query_projection SET pp=79,incidents=17,title='Retained',visible=0,source_kinds='[]';
    INSERT INTO query_projection_dirty(id,flags) VALUES('a',15),('b',2),('c',8)`);
  const exec=jest.spyOn(db,"exec");
  try{
    expect(projection.flushInTransaction(8)).toEqual({updated:3,pending:0});
    const statements=exec.mock.calls.map(([sql])=>sql);
    expect(statements.filter(sql=>sql.includes("INSERT INTO query_projection("))).toHaveLength(1);
    expect(statements.filter(sql=>sql.includes("WITH chosen"))).toHaveLength(0);
    expect(statements.filter(sql=>sql.includes("WITH affiliation"))).toHaveLength(1);
    expect(statements.filter(sql=>sql.includes("SET incidents="))).toHaveLength(1);
    expect(db.prepare("SELECT id,pp,incidents,title,visible FROM query_projection ORDER BY id").all()).toEqual([
      {id:"a",pp:null,incidents:null,title:null,visible:1},
      {id:"b",pp:79,incidents:null,title:"Retained",visible:0},
      {id:"c",pp:79,incidents:17,title:"Retained",visible:1},
    ]);
  }finally{exec.mockRestore();}
});
it("coalesces mutation IDs, refuses stale reads, and refreshes bounded pages without read-side writes",()=>{
  add("a");add("b");db.exec("UPDATE replays SET favourite=1 WHERE id='a'");
  expect(projection.pendingCount()).toBe(2);expect(()=>query.page({})).toThrow(LibraryQueryUpdatingError);
  expect(projection.flushInTransaction(1)).toEqual({updated:1,pending:1});expect(()=>query.page({})).toThrow(LibraryQueryUpdatingError);
  flush();db.exec("PRAGMA query_only=ON");expect(query.page({}).items).toHaveLength(2);
  expect(query.page({scope:{kind:"favourites"}}).items.map(row=>row.id)).toEqual(["a"]);
});
it("retargets scalar fields while Off without retaining old metric values",()=>{
  add("a");db.exec("INSERT INTO metric_targets VALUES('a','numerical','S','old','v1',1)");
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES('a','numerical','S','old','v1',?)")
    .run(JSON.stringify({fields:{ur:{state:"known",value:0},completion:{state:"known",value:"passed"}},provenance:{}}));flush();
  expect(query.detail("a")?.item.values.ur).toBe(0);
  db.exec("UPDATE metric_targets SET input_key='new',generation=2 WHERE replay_id='a'");flush();
  expect(query.detail("a")?.item.values.ur).toBeNull();
  db.exec("UPDATE metric_targets SET input_key='old',generation=3 WHERE replay_id='a'");flush();expect(query.detail("a")?.item.values.ur).toBe(0);
});
it("tracks source visibility, current-map metadata, review edits, memberships and alias removal",()=>{
  add("a");add("b");flush();
  const generation=store.beginMapScan("source");store.upsertMap({sourceId:"source",generation,sourceKey:"map",md5,locator:"map.osu",state:"unverified",metadata:{map:{title:"Projected title"}}});
  store.finishMapScan("source",generation);flush();expect(query.detail("a")?.item.title).toBe("Projected title");
  store.setReview("a","reviewed");const collection=store.createCollection("Practice");store.setMembership("a",collection,true);flush();
  expect(query.detail("a")?.item).toMatchObject({review:"reviewed",collectionIds:[collection],collectionCount:1});
  db.exec("UPDATE replays SET merged_into='a' WHERE id='b';UPDATE locations SET replay_id='a' WHERE replay_id='b'");flush();expect(query.page({}).total).toBe(1);
  store.setSourceEnabled("source",false);flush();expect(query.page({}).total).toBe(0);
  store.setSourceEnabled("source",true);flush();expect(query.page({}).total).toBe(1);
});
it("uses the indexed sort projection without expanding metric JSON in passive queries",()=>{
  add("a");flush();const plans:string[]=[];
  const reader=new LibraryQueryReader({prepare:(sql:string)=>{plans.push(sql);return db.prepare(sql);}},"test");reader.page({sort:"pp"});
  expect(plans.some(sql=>sql.includes("MATERIALIZE current_metrics")||sql.includes("max(CASE WHEN t.slot"))).toBe(false);
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT id FROM query_projection ORDER BY CASE WHEN pp IS NOT NULL THEN 0 WHEN completion='failed' THEN 1 ELSE 2 END,pp DESC,id").all();
  expect(plan.some(row=>String(row.detail).includes("query_sort_pp_desc"))).toBe(true);
});
it("coalesces dirty IDs even when an outer upsert updates an already dirty replay",()=>{
  add("a");
  expect(()=>db.prepare("INSERT INTO replays VALUES('a',1,'test',1,0,0,'{}',NULL) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata").run()).not.toThrow();
  expect(projection.pendingCount()).toBe(1);
});
it("rejects a commit that lands between the readiness check and revision capture",()=>{
  add("a");flush();let mutate=true;
  const reader=new LibraryQueryReader({prepare:(sql:string)=>{
    const statement=db.prepare(sql);
    if(sql==="SELECT 1 FROM query_projection_dirty LIMIT 1")return new Proxy(statement,{get:(target,key)=>{
      if(key==="get")return()=>{const result=target.get();if(mutate){mutate=false;db.exec("UPDATE replays SET favourite=1 WHERE id='a'");}return result;};
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});
    return statement;
  }},"test");
  expect(()=>reader.page({})).toThrow(/changed|updating/);
});
it("keeps selected map lookup and its result page under the same revision",()=>{
  add("a");flush();let mutate=true;
  const reader=new LibraryQueryReader({prepare:(sql:string)=>{
    const statement=db.prepare(sql);
    if(sql.includes("SELECT map_identity FROM projected"))return new Proxy(statement,{get:(target,key)=>{
      if(key==="get")return(...args:Parameters<typeof target.get>)=>{const result=target.get(...args);if(mutate){mutate=false;db.exec("UPDATE replays SET favourite=1 WHERE id='a'");projection.flushInTransaction();}return result;};
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});
    return statement;
  }},"test");
  expect(()=>reader.sameMap("a")).toThrow(/changed/);
});
it("keeps historical C scalar/detail data inert across every receipt epoch while Off",()=>{
  const currentIncidentTarget=jest.fn(id=>({replayId:id,slot:"incidents" as const,stage:"C" as const,inputKey:"c",producerVersion:"v1"}));
  projection=new LibraryQueryProjection(db,{currentIncidentTarget});
  add("a");const sha="a".repeat(64);db.prepare("UPDATE locations SET sha256=? WHERE replay_id='a'").run(sha);
  db.exec("INSERT INTO metric_targets VALUES('a','incidents','C','c','v1',1)");
  db.prepare("INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload) VALUES('a','incidents','C','c','v1',?)")
    .run(JSON.stringify({fields:{incidentCount:{state:"known",value:0}},provenance:{}}));flush();
  expect(query.detail("a")?.item.values.incidents).toBeNull();expect(query.detail("a")?.metrics).toHaveLength(0);
  db.prepare(`INSERT INTO incident_recipes(replay_id,numerical_key,numerical_version,evidence,source_id,source_key,source_config_revision,source_epoch,location_epoch,scope)
    VALUES('a','n','v1',?,'source','a',0,0,0,'stable-sidecar')`).run(JSON.stringify({replaySha256:sha}));flush();
  expect(query.detail("a")?.item.values.incidents).toBeNull();expect(query.detail("a")?.metrics).toHaveLength(0);
  db.exec("INSERT INTO incident_location_epochs VALUES('source','a',1)");flush();
  expect(query.detail("a")?.item.values.incidents).toBeNull();expect(query.detail("a")?.metrics).toHaveLength(0);
  db.exec("UPDATE incident_recipes SET location_epoch=1 WHERE replay_id='a'");flush();expect(query.detail("a")?.item.values.incidents).toBeNull();
  db.exec("INSERT INTO incident_source_epochs VALUES('source',1)");flush();expect(query.detail("a")?.item.values.incidents).toBeNull();
  db.exec("UPDATE incident_recipes SET scope='unsupported-profile' WHERE replay_id='a'");flush();expect(query.detail("a")?.item.values.incidents).toBeNull();
  db.exec("UPDATE sources SET config_revision=config_revision+1 WHERE id='source'");flush();expect(query.detail("a")?.item.values.incidents).toBeNull();
  expect(currentIncidentTarget).not.toHaveBeenCalled();
});
it("preserves literal token boundaries and NC/PF aliases in accelerated mod filtering",()=>{
  add("a");add("b");add("c");
  db.prepare("UPDATE replays SET metadata=? WHERE id='a'").run(JSON.stringify({nativeScore:{ruleset:0,mods:["A|HD|B"]}}));
  db.prepare("UPDATE replays SET metadata=? WHERE id='b'").run(JSON.stringify({nativeScore:{ruleset:0,mods:["NC","PF"]}}));
  db.prepare("UPDATE replays SET metadata=? WHERE id='c'").run(JSON.stringify({nativeScore:{ruleset:0,mods:["HD"]}}));flush();
  expect(query.page({filters:[{field:"mods",mode:"includes",match:"all",mods:["HD"]}]}).items.map(row=>row.id)).toEqual(["c"]);
  expect(query.page({filters:[{field:"mods",mode:"includes",match:"all",mods:["DT","SD"]}]}).items.map(row=>row.id)).toEqual(["b"]);
  expect(query.page({filters:[{field:"mods",mode:"exactly",match:null,mods:["DT","SD"]}]}).total).toBe(0);
});
it("changes source visibility without deleting scalar rows or confusing sources of one kind",()=>{
  store.registerSource({id:"replays-one",kind:"replays",directory:"one"});
  store.registerSource({id:"replays-two",kind:"replays",directory:"two"});
  add("a");add("b");
  db.exec("UPDATE locations SET source_id='replays-one' WHERE replay_id='a';UPDATE locations SET source_id='replays-two' WHERE replay_id='b'");flush();
  store.setSourceEnabled("replays-one",false);
  expect(projection.pendingCount()).toBe(0);
  expect(db.prepare("SELECT count(*) AS count FROM query_projection").get()?.count).toBe(2);
  expect(query.page({filters:[{field:"source",values:["replays"]}]}).items.map(row=>row.id)).toEqual(["b"]);
  expect(query.facets({},"source").items).toEqual([{value:"replays",count:1}]);
  store.setSourceEnabled("replays-one",true);
  expect(projection.pendingCount()).toBe(0);expect(query.page({}).total).toBe(2);
});
it("applies Pause to available job badges without dirtying or rewriting scalar metrics",()=>{
  add("a");add("b");
  db.exec("INSERT INTO analysis_requests VALUES('a','S','key',1,'explicit','queued',NULL,NULL),('b','S','key',1,'explicit','running',NULL,NULL)");flush();
  db.exec("INSERT INTO settings(key,value) VALUES('analysis','{\"userPaused\":true}') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  expect(projection.pendingCount()).toBe(0);
  expect(query.page({}).items.map(row=>row.analysis)).toEqual(["paused","paused"]);
  db.exec("UPDATE settings SET value='{\"userPaused\":false}' WHERE key='analysis'");
  expect(projection.pendingCount()).toBe(0);
  expect(query.page({}).items.map(row=>row.analysis)).toEqual(["queued","analysing"]);
});
it("invalidates passive resources only when an indexed resource dependency changes",()=>{
  add("a");flush();const before=projection.resourceRevision();
  db.exec("INSERT INTO metric_targets VALUES('a','numerical','S','key','v1',1)");
  store.setReview("a","reviewed");store.setFavourite("a",true);flush();
  expect(projection.resourceRevision()).toBe(before);
  db.exec("UPDATE locations SET revision=revision+1 WHERE replay_id='a'");flush();
  expect(projection.resourceRevision()).toBe(before);
  db.exec("UPDATE locations SET locator='changed.osr' WHERE replay_id='a'");flush();
  expect(projection.resourceRevision()).not.toBe(before);
  const changed=projection.resourceRevision();store.setSourceEnabled("source",false);flush();
  expect(projection.resourceRevision()).not.toBe(changed);
});
