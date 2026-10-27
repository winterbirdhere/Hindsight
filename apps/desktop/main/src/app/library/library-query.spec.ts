import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { LibraryQueryReader, LibraryQueryInvalidatedError } from "./library-query";
import { LibraryQuerySnapshots } from "./library-query-snapshots";
import { LibraryQueryApi } from "./library-query-api";
import { LibraryQueryProjection } from "./library-query-projection";
import { LIBRARY_FILTER_FIELDS, LIBRARY_SORTS, parseLibraryQueryText, formatLibraryQueryText, validateLibraryFilter } from "../../../../shared/library-query";
import type { LibraryQuery, LibraryFilter } from "../../../../shared/library-query";

let db:DatabaseSync,query:LibraryQueryReader;
const now=Date.UTC(2026,9,16,12),sha="a".repeat(64),md5="b".repeat(32);
beforeEach(()=>{
  db=new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE replays(id TEXT PRIMARY KEY,merged_into TEXT,added_at INTEGER,added_session TEXT,added_sequence INTEGER,baseline INTEGER,favourite INTEGER,metadata TEXT);
    CREATE TABLE sources(id TEXT PRIMARY KEY,kind TEXT,enabled INTEGER,configured INTEGER);
    CREATE TABLE locations(source_id TEXT,source_key TEXT,replay_id TEXT,sha256 TEXT,available INTEGER,metadata TEXT);
    CREATE TABLE maps(source_id TEXT,generation TEXT,source_key TEXT,md5 TEXT,metadata TEXT);
    CREATE TABLE map_scans(source_id TEXT,current_generation TEXT);
    CREATE TABLE collections(id TEXT PRIMARY KEY,name TEXT,parent_id TEXT,palette_index INTEGER,sequence INTEGER);
    CREATE TABLE memberships(replay_id TEXT,collection_id TEXT);
    CREATE TABLE review_edits(sequence INTEGER PRIMARY KEY,replay_id TEXT,state TEXT);
    CREATE TABLE metric_targets(replay_id TEXT,slot TEXT,stage TEXT,input_key TEXT,producer_version TEXT,generation INTEGER);
    CREATE TABLE metric_results(replay_id TEXT,slot TEXT,stage TEXT,input_key TEXT,producer_version TEXT,payload TEXT);
    CREATE TABLE metric_jobs(id TEXT,replay_id TEXT,slot TEXT,stage TEXT,input_key TEXT,producer_version TEXT,generation INTEGER,state TEXT,error TEXT);
    CREATE TABLE analysis_requests(replay_id TEXT,stage TEXT,state TEXT,error TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO sources VALUES('s','stable',1,1),('l','lazer',1,1),('i','imported',1,1);
    INSERT INTO settings VALUES('analysis','{"mode":"off","userPaused":false,"workers":2,"pauseOnBattery":true}');`);
  query=new LibraryQueryReader(db,"current",()=>now);
});
afterEach(()=>db.close());
function add(id:string,title=id,options:{source?:string;mods?:number;player?:string;days?:number;baseline?:number;session?:string}={}){
  const mapMd5=createHash("md5").update(id).digest("hex");
  const metadata={header:{beatmapMD5:md5,player:options.player??"player",mode:0,version:20260901,sourceFormat:"stable",nativeScoreInfo:false,
    modsBitmask:options.mods??0,playedAtTicks:String(BigInt(now-(options.days??0)*86400000)*BigInt(10000)+BigInt("621355968000000000"))},
    nativeScore:undefined};
  db.prepare("INSERT INTO replays VALUES(?,NULL,? ,?,1,?,0,?)").run(id,now,options.session??"current",options.baseline??0,JSON.stringify(metadata));
  db.prepare("INSERT INTO locations VALUES(?,?,?,?,1,?)").run(options.source??"s",id,id,sha,JSON.stringify(metadata));
  db.prepare("INSERT INTO maps VALUES('s','g',?,?,?)").run(id,mapMd5,JSON.stringify({map:{title,artist:"artist",creator:"mapper",difficulty:"Hard",md5:mapMd5}}));
  // One exact per-replay map identity; file presence is independent from this indexed metadata.
  const next={...metadata,header:{...metadata.header,beatmapMD5:mapMd5}};
  db.prepare("UPDATE replays SET metadata=? WHERE id=?").run(JSON.stringify(next),id);
  db.prepare("UPDATE locations SET metadata=? WHERE replay_id=?").run(JSON.stringify(next),id);
  db.prepare("INSERT INTO map_scans SELECT 's','g' WHERE NOT EXISTS(SELECT 1 FROM map_scans)").run();
}
function metric(id:string,slot:string,fields:Record<string,unknown>,stage="S",key="current",provenance:Record<string,unknown>={}){
  db.prepare("INSERT INTO metric_targets VALUES(?,?,?,?, 'test',1)").run(id,slot,stage,key);
  db.prepare("INSERT INTO metric_results VALUES(?,?,?,?, 'test',?)").run(id,slot,stage,key,JSON.stringify({fields,provenance}));
}
const known=(value:number|string|boolean)=>({state:"known",value});
const ids=(input:LibraryQuery={})=>query.page(input).items.map(item=>item.id);

it.each(["legacy","projected","stale"])("uses the recorded Angel name consistently instead of the native account (%s)",mode=>{
  add("angel","Angel",{player:"WinterBird01"});add("account","Other",{player:"WinterBird"});
  const metadata=JSON.parse(String(db.prepare("SELECT metadata FROM replays WHERE id='angel'").get()?.metadata));
  metadata.nativeScore={player:"WinterBird",isLegacyScore:true};
  db.prepare("UPDATE replays SET metadata=? WHERE id='angel'").run(JSON.stringify(metadata));
  db.prepare("UPDATE locations SET metadata=? WHERE replay_id='angel'").run(JSON.stringify(metadata));
  db.prepare("INSERT INTO settings VALUES('player-names',?)").run(JSON.stringify(["winterbird01"]));
  if(mode!=="legacy"){
    LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();
    if(mode==="stale")db.exec("UPDATE query_projection SET player='WinterBird',player_folded='winterbird',search_text='winterbird',filter_evidence_revision='recorded-filter-evidence-v1' WHERE id='angel'");
  }
  query=new LibraryQueryReader(db,"recorded",()=>now);const before=db.prepare("SELECT total_changes() n").get()?.n;
  db.exec("PRAGMA query_only=ON");
  expect(query.detail("angel")?.item.player).toBe("WinterBird01");
  expect(ids(parseLibraryQueryText('player:WinterBird01'))).toEqual(["angel"]);
  expect(ids(parseLibraryQueryText('player:me'))).toEqual(["angel"]);
  expect(ids(parseLibraryQueryText('player:WinterBird'))).toEqual(["account"]);
  expect(ids({search:"WinterBird01"})).toEqual(["angel"]);
  expect(query.facets({},"player").items).toEqual([{value:"WinterBird",count:1},{value:"WinterBird01",count:1}]);
  expect(db.prepare("SELECT metadata FROM replays WHERE id='angel'").get()?.metadata).toBe(JSON.stringify(metadata));
  expect(db.prepare("SELECT total_changes() n").get()?.n).toBe(before);
});
it.each([
  {header:"",saved:"Saved Name",native:"Native",want:"Saved Name"},
  {header:42,saved:"Saved Name",native:"Native",want:"Saved Name"},
  {header:["Array name"],saved:null,native:"Native",want:"Native"},
  {header:{name:"Object name"},saved:false,native:"Native",want:"Native"},
  {header:" Recorded ",saved:"Saved",native:"Native",want:" Recorded "},
  {header:"Historical",saved:null,native:"",want:"Historical"},
  {header:null,saved:null,native:"Native Only",want:"Native Only"},
  {header:"",saved:"",native:["Array native"],want:null},
])("keeps exact recorded spelling and uses only nonempty text names: $want",({header,saved,native,want})=>{
  add("typed");const metadata=JSON.parse(String(db.prepare("SELECT metadata FROM replays WHERE id='typed'").get()?.metadata));
  metadata.header.player=header;metadata.savedScore={header:{player:saved}};metadata.nativeScore={player:native};
  db.prepare("UPDATE replays SET metadata=? WHERE id='typed'").run(JSON.stringify(metadata));
  expect(query.detail("typed")?.item.player).toBe(want);
});

it("accepts the 20-filter addendum and preserves quoted player me as a literal",()=>{
  expect(LIBRARY_FILTER_FIELDS).toHaveLength(20);
  expect(LIBRARY_FILTER_FIELDS).not.toContain("incidents");
  expect(parseLibraryQueryText("incidents>=3")).toEqual({search:"incidents>=3",filters:[]});
  for(const text of ['player:me,kirin_', 'player:"me"', 'player:me,"me"', 'result:fc playedon:stable,unknown']){
    const parsed=parseLibraryQueryText(text);
    expect(parseLibraryQueryText(formatLibraryQueryText(parsed))).toEqual(parsed);
  }
  expect(parseLibraryQueryText('player:me,kirin_').filters).toEqual([{field:"player",values:["kirin_"],me:true}]);
  expect(parseLibraryQueryText('player:"me"').filters).toEqual([{field:"player",values:["me"]}]);
  expect(()=>parseLibraryQueryText("result:passed,failed")).toThrow(/filter/i);
});
it("matches Me by saved exact case-insensitive names with an independent literal me",()=>{
  add("a","a",{player:"Lark_Old"});add("b","b",{player:"kirin_"});add("c","c",{player:"me"});
  db.prepare("INSERT INTO settings VALUES('player-names',?)").run(JSON.stringify(["lark_old"]));
  expect(ids(parseLibraryQueryText("player:me"))).toEqual(["a"]);
  expect(ids(parseLibraryQueryText("player:me,kirin_"))).toEqual(["a","b"]);
  expect(ids(parseLibraryQueryText('player:"me"'))).toEqual(["c"]);
  db.exec("UPDATE settings SET value='[]' WHERE key='player-names'");
  expect(ids(parseLibraryQueryText("player:me"))).toEqual([]);
});
it("matches Unicode Me names, fences meaningful name changes, and leaves recorded names intact",()=>{
  add("a","a",{player:"Éclair"});add("b","b",{player:"Other"});add("c","c",{player:"éCLAIR"});
  db.prepare("INSERT INTO settings VALUES('player-names',?)").run(JSON.stringify(["éclair"]));
  query=new LibraryQueryReader(db,"current",()=>now,{revision:()=>"committed"});
  const filter=parseLibraryQueryText("player:me");
  const page=query.page({...filter,limit:1});expect(page.items[0].player).toBe("Éclair");
  db.prepare("UPDATE settings SET value=? WHERE key='player-names'").run(JSON.stringify(["ÉCLAIR"]));
  expect(query.page({...filter,limit:1,cursor:page.next}).items[0].id).toBe("c");
  db.prepare("UPDATE settings SET value=? WHERE key='player-names'").run(JSON.stringify(["Other"]));
  expect(()=>query.page({...filter,limit:1,cursor:page.next})).toThrow(LibraryQueryInvalidatedError);
  expect(ids(filter)).toEqual(["b"]);
});
it("keeps a maximum valid CJK name list readable and stamps independently fenced response revisions",()=>{
  const names=Array.from({length:100},(_,index)=>String(index).padStart(3,"0")+"名".repeat(253));
  expect(Buffer.byteLength(JSON.stringify(names))).toBeGreaterThan(65536);
  db.prepare("INSERT INTO settings VALUES('player-names',?)").run(JSON.stringify(names));add("a","a",{player:names[99]});
  expect(query.playerNames()).toEqual(names);expect(ids(parseLibraryQueryText("player:me"))).toEqual(["a"]);
  const page=query.page(),bands=query.bands({}),collections=query.collectionsPage(),facets=query.facets({},"source");
  expect(typeof page.revision).toBe("string");expect(bands.revision).toBe(page.revision);expect(collections.revision).toBe(page.revision);expect(facets.revision).toBe(page.revision);
  add("b");expect(query.page().revision).not.toBe(page.revision);expect(query.bands({}).revision).toBe(query.page().revision);
});
it("excludes known nonstandard modes from every row/count surface and keeps recording provenance separate",()=>{
  for(const id of ["stable-in-lazer","classic","conflict","unknown","taiko"])add(id);
  const update=(id:string,metadata:unknown)=>db.prepare("UPDATE replays SET metadata=? WHERE id=?").run(JSON.stringify(metadata),id);
  update("stable-in-lazer",{nativeScore:{ruleset:0,isLegacyScore:true,mods:[]}});
  update("classic",{nativeScore:{ruleset:0,isLegacyScore:false,mods:[{acronym:"CL"}]}});
  update("conflict",{nativeScore:{ruleset:0,isLegacyScore:false},header:{mode:0,version:20260901}});
  update("unknown",{});
  update("taiko",{header:{mode:1,version:20260901}});
  // Each observation agrees with its canonical evidence except the explicit conflict.
  db.exec("UPDATE locations SET metadata=(SELECT metadata FROM replays WHERE replays.id=locations.replay_id)");
  db.exec("INSERT INTO collections VALUES('c','Collection',NULL,0,1);INSERT INTO memberships SELECT id,'c' FROM replays;UPDATE replays SET favourite=1;");
  expect(ids()).toEqual(["classic","conflict","stable-in-lazer","unknown"]);
  expect(ids(parseLibraryQueryText("playedon:stable"))).toEqual(["stable-in-lazer"]);
  expect(ids(parseLibraryQueryText("playedon:lazer"))).toEqual(["classic"]);
  expect(ids(parseLibraryQueryText("playedon:unknown"))).toEqual(["conflict","unknown"]);
  expect(query.facets({},"result").items[0].count).toBe(4);
  expect(query.facets({},"collection").items.map(item=>item.count)).toEqual([4,4]);
  expect(query.collectionsPage().items[0].count).toBe(4);
  LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);
  const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();
  query=new LibraryQueryReader(db,"current",()=>now);db.exec("PRAGMA query_only=ON");
  expect(ids()).toEqual(["classic","conflict","stable-in-lazer","unknown"]);
  expect(query.facets({},"collection").items.map(item=>item.count)).toEqual([4,4]);
  expect(query.collectionsPage().items[0].count).toBe(4);
});
it("counts recorded Result partitions and FC break evidence without admitting work",()=>{
  for(const id of ["fc","pass","failed","unknown","missing-break"])add(id);
  metric("fc","source-score",{completion:known("passed"),misses:known(0)},"H","current",{completionEvidence:"recorded-outcome-v1"});
  metric("fc","numerical",{sliderBreaks:known(0),comboLosses:known(0)},"S","current",{completeBreakEvidence:true,ruleset:"stable"});
  metric("pass","source-score",{completion:known("passed"),misses:known(1)},"H","current",{completionEvidence:"recorded-outcome-v1"});
  metric("pass","numerical",{sliderBreaks:known(0),comboLosses:known(1)},"S","current",{completeBreakEvidence:true,ruleset:"stable"});
  metric("failed","source-score",{completion:known("failed"),misses:known(0)},"H","current",{completionEvidence:"recorded-outcome-v1"});
  metric("unknown","source-score",{grade:known("F"),misses:known(0)},"H");
  metric("unknown","numerical",{sliderBreaks:known(0),fc:known(true)});
  metric("missing-break","source-score",{completion:known("passed"),misses:known(0)},"H","current",{completionEvidence:"recorded-outcome-v1"});
  const before=Number(db.prepare("SELECT total_changes() AS n").get()?.n);
  db.exec("PRAGMA query_only=ON");
  expect(ids(parseLibraryQueryText("result:passed"))).toEqual(["fc","missing-break","pass"]);
  expect(ids(parseLibraryQueryText("result:failed"))).toEqual(["failed"]);
  expect(ids(parseLibraryQueryText("result:unknown"))).toEqual(["unknown"]);
  expect(ids(parseLibraryQueryText("result:fc"))).toEqual(["fc"]);
  expect(query.page(parseLibraryQueryText("result:fc"))).toMatchObject({resultExcluded:{unknownOutcome:1,missingBreakEvidence:1}});
  expect(query.facets(parseLibraryQueryText("result:fc"),"result" as never).items).toEqual([
    {value:"all",count:5},{value:"passed",count:3},{value:"fc",count:1},{value:"failed",count:1},{value:"unknown",count:1}]);
  expect(Number(db.prepare("SELECT total_changes() AS n").get()?.n)).toBe(before);
  expect(db.prepare("SELECT count(*) AS n FROM metric_jobs").get()?.n).toBe(0);
});
it("qualifies FC break evidence independently of map max and keeps perfect combo independent of outcome",()=>{
  for(const id of ["stable","lazer","tick-break","missing","conflict","perfect-unknown"])add(id);
  for(const id of ["stable","lazer","tick-break","missing","conflict"])metric(id,"source-score",{completion:known("passed"),misses:known(0)},"H","current",{completionEvidence:"recorded-outcome-v1"});
  metric("stable","numerical",{comboLosses:known(0),sliderBreaks:known(0)},"S","current",{ruleset:"stable",completeBreakEvidence:true});
  metric("lazer","numerical",{comboLosses:known(0),sliderBreaks:{state:"not-applicable",reason:"native"}},"S","current",{ruleset:"lazer",completeBreakEvidence:true});
  metric("tick-break","numerical",{comboLosses:known(1),sliderBreaks:known(0)},"S","current",{ruleset:"stable",completeBreakEvidence:true});
  metric("missing","numerical",{comboLosses:known(0),sliderBreaks:known(0)},"S","current",{ruleset:"stable",completeBreakEvidence:false});
  metric("conflict","numerical",{completion:known("failed"),comboLosses:known(0),sliderBreaks:known(0)},"S","current",{completionEvidence:"recorded-outcome-v1",ruleset:"stable",completeBreakEvidence:true});
  metric("perfect-unknown","source-score",{maxCombo:known(100),misses:known(0)},"H");
  metric("perfect-unknown","calculated-map",{exactMapMaxCombo:known(100)},"P");
  expect(ids(parseLibraryQueryText("result:fc"))).toEqual(["lazer","stable"]);
  expect(query.detail("stable")?.item).toMatchObject({fullCombo:true,perfectCombo:null});
  expect(query.detail("perfect-unknown")?.item).toMatchObject({completion:null,fullCombo:null,perfectCombo:true});
  expect(query.detail("tick-break")?.item.fullCombo).toBe(false);
  expect(query.page(parseLibraryQueryText("result:fc"))).toMatchObject({resultExcluded:{unknownOutcome:2,missingBreakEvidence:1}});
  LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();
  query=new LibraryQueryReader(db,"current",()=>now);
  expect(ids(parseLibraryQueryText("result:fc"))).toEqual(["lazer","stable"]);
  expect(query.detail("perfect-unknown")?.item).toMatchObject({completion:null,fullCombo:null,perfectCombo:true});
});

it("preserves all sort/filter/facet semantics through the materialized projection",()=>{
  for(let i=0;i<9;i++){
    const id=String(i);add(id,`Song ${i}`,{mods:i%3===0?576:i%3===1?16:0,source:i%2?"l":"s",player:`Player ${i%2}`,days:i});
    metric(id,"source-score",{accuracy:known(.91+i*.01),maxCombo:known(i*100),misses:known(i),grade:known(i%2?"A":"S")},"H");
    metric(id,"source-map",{mapStatus:known("ranked"),sourceMapStars:known(i),cachedBpm:known(100+i*10),drainLengthMs:known(60000+i*10000)},"H");
    if(i%3)metric(id,"numerical",{completion:known(i%4?"passed":"failed"),ur:known(70+i*10),biasMs:known(i-4),fc:known(i===2),perfectCombo:known(false)});
    if(i%2)metric(id,"aggregate-pp",{pp:known(i*100)},"P");
    if(i%3)metric(id,"incidents",{incidentCount:known(i)},"C");
  }
  db.exec("INSERT INTO collections VALUES('parent','Parent',NULL,0,1),('child','Child','parent',0,2); INSERT INTO memberships VALUES('1','child'),('2','parent'); UPDATE replays SET favourite=1 WHERE id='1'; INSERT INTO review_edits VALUES(1,'1','reviewed');");
  const filters:LibraryFilter[]=[
    {field:"stars",basis:"map",min:2,max:7},{field:"mods",mode:"includes",match:"any",mods:["DT"]},{field:"acc",op:"atLeast",a:94,b:null},
    {field:"miss",op:"atMost",a:3,b:null},{field:"pp",min:100,max:null},{field:"played",preset:"7d"},{field:"bpm",min:100,max:170},
    {field:"len",min:60,max:100},{field:"status",values:["ranked"]},{field:"mapper",values:["mapper"]},{field:"grade",values:["S"]},
    {field:"player",values:["Player 1"]},{field:"ur",op:"atMost",a:110,b:null},{field:"bias",min:-3,max:3},
    {field:"result",values:["passed"]},{field:"playedon",values:["stable"]},{field:"source",values:["stable"]},{field:"collection",values:["parent"]},
    {field:"review",values:["reviewed"]},{field:"astate",values:["analysed"]},
  ];
  const inputs:LibraryQuery[]=[...Object.keys(LIBRARY_SORTS).flatMap(sort=>["asc","desc"].map(direction=>({sort,direction} as LibraryQuery))),
    ...filters.map(filter=>({filters:[filter]})),{search:"Song 1"},{filters:[filters[0],filters[12]]}];
  const withoutRevision=<T extends {revision?:string}>(value:T)=>{const {revision,...rest}=value;void revision;return rest;};
  const before=inputs.map(input=>withoutRevision(query.page(input)));
  const facets=(["source","player","mapper","collection","grade","status","astate","review"] as const).map(field=>withoutRevision(query.facets({},field)));
  LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();
  query=new LibraryQueryReader(db,"current",()=>now);db.exec("PRAGMA query_only=ON");
  expect(inputs.map(input=>withoutRevision(query.page(input)))).toEqual(before);
  expect((["source","player","mapper","collection","grade","status","astate","review"] as const).map(field=>withoutRevision(query.facets({},field)))).toEqual(facets);
});
it("keeps pre-addendum accelerated indexes readable through passive legacy scalar fields",()=>{
  add("a","Needle",{player:"Éclair",mods:8});add("b","Other");
  db.exec("INSERT INTO collections VALUES('c','Collection',NULL,0,1);INSERT INTO memberships VALUES('a','c')");
  LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();
  for(const column of ["recorded_completion","recording_client","standard_excluded","player_folded","break_evidence","filter_evidence_revision"])db.exec("ALTER TABLE query_projection DROP COLUMN "+column);
  query=new LibraryQueryReader(db,"old-index",()=>now);db.exec("PRAGMA query_only=ON");
  expect(ids({search:"Needle",filters:[{field:"source",values:["stable"]},{field:"mods",mode:"includes",match:"all",mods:["HD"]}]})).toEqual(["a"]);
  expect(query.facets({},"collection").items.find(row=>row.value==="c")?.count).toBe(1);
  expect(ids({filters:[{field:"player",values:["éclair"]}]})).toEqual(["a"]);
});
it("reads saved judgement counts without inventing missing native values or exact map combo",()=>{
  add("stable");add("native");add("export");
  const header={mode:0,version:20260901,sourceFormat:"stable",counts:{great:100,ok:0,meh:3,miss:1},maxCombo:200};
  db.prepare("UPDATE replays SET metadata=? WHERE id='stable'").run(JSON.stringify({header}));
  db.prepare("UPDATE replays SET metadata=? WHERE id='native'").run(JSON.stringify({nativeScore:{ruleset:0,statistics:{Great:80,great:81,Ok:0,Meh:2}},header}));
  db.prepare("UPDATE replays SET metadata=? WHERE id='export'").run(JSON.stringify({header:{...header,version:30000001,nativeScoreInfo:true,sourceFormat:"lazer"}}));
  metric("stable","calculated-map",{exactMapMaxCombo:known(234)},"P");
  expect(query.detail("stable")).toMatchObject({savedJudgements:{great:100,ok:0,meh:3,miss:1,origin:"stable-header"},exactMapMaxCombo:234});
  expect(query.detail("native")).toMatchObject({savedJudgements:{great:null,ok:0,meh:2,miss:null,origin:"native-score"},exactMapMaxCombo:null});
  expect(query.detail("export")).toMatchObject({savedJudgements:{great:null,ok:null,meh:null,miss:null,origin:null},exactMapMaxCombo:null});
});

it("exposes exactly the finalized 12 sorts and 20 filter fields",()=>{
  expect(Object.keys(LIBRARY_SORTS)).toEqual(["pp","peak","fc","acc","combo","miss","ur","sr","bpm","len","title","date"]);
  expect(LIBRARY_FILTER_FIELDS).toEqual(["stars","mods","acc","miss","pp","played","bpm","len","status","mapper","grade","result","player","playedon","ur","bias","source","collection","review","astate"]);
  expect(Object.entries(LIBRARY_SORTS).filter(([,value])=>value.direction==="asc").map(([key])=>key)).toEqual(["miss","ur","title"]);
});
it("reads only current metrics and keeps unknown values last both ways, including Off",()=>{
  add("a");add("b");add("c");metric("a","numerical",{ur:known(0)});metric("b","numerical",{ur:known(90)});
  db.prepare("INSERT INTO metric_results VALUES('c','numerical','S','stale','test',?)").run(JSON.stringify({fields:{ur:known(30)},provenance:{}}));
  db.exec("PRAGMA query_only=ON");
  expect(ids({sort:"ur",direction:"asc"})).toEqual(["a","b","c"]);
  expect(ids({sort:"ur",direction:"desc"})).toEqual(["b","a","c"]);
  expect(query.page({sort:"ur"}).items[2].values.ur).toBeNull();
  expect(query.page({sort:"ur"}).items[2].band.label).toBe("No UR data");
  expect(ids({filters:[{field:"ur",op:"atMost",a:0,b:null}]})).toEqual(["a"]);
});
it.each(["pp","peak","fc","acc","combo","miss","ur","sr","bpm","len","date"] as const)(
  "paginates the whole scoped and filtered %s order with zero, ties and unknowns last in both directions",sort=>{
    const values:[string,number|null,string][]=[["a",0,"s"],["b",25,"s"],["c",25,"s"],["d",100,"s"],
      ["n1",null,"s"],["n2",null,"s"],["outside-scope",1,"s"],["outside-filter",99,"l"]];
    for(const[id,value,source]of values){
      add(id,`Keep ${id}`,{source});
      const metadata=JSON.parse(String(db.prepare("SELECT metadata FROM replays WHERE id=?").get(id)?.metadata));
      metadata.header.playedAtTicks=value===null?"0":String(BigInt("621355968000000000")+BigInt(value)*BigInt(10000));
      db.prepare("UPDATE replays SET metadata=? WHERE id=?").run(JSON.stringify(metadata),id);
      db.prepare("UPDATE locations SET metadata=? WHERE replay_id=?").run(JSON.stringify(metadata),id);
      if(value===null)continue;
      metric(id,"source-score",{accuracy:known(value/100),maxCombo:known(value),misses:known(value)},"H");
      metric(id,"numerical",{ur:known(value)});
      metric(id,"calculated-map",{replayStars:known(value),bpm:known(value),lengthMs:known(value*1000)},"P");
      metric(id,"aggregate-pp",{pp:known(value)},"P");
      metric(id,"timeline-pp",{peakPp:known(value)});
      metric(id,"fc-pp",{ppIfFc:known(value)},"P");
    }
    db.exec("INSERT INTO collections VALUES('parent','Parent',NULL,0,1),('child','Child','parent',0,2),('other','Other',NULL,0,3); INSERT INTO memberships SELECT id,CASE WHEN id='outside-scope' THEN 'other' ELSE 'child' END FROM replays; INSERT INTO memberships VALUES('a','parent');");
    const check=()=>{
      for(const[direction,expected]of [["asc",["a","b","c","d","n1","n2"]],["desc",["d","b","c","a","n1","n2"]]] as const){
        const input:LibraryQuery={sort,direction,limit:2,search:"Keep",scope:{kind:"collection",id:"parent"},filters:[{field:"source",values:["stable"]}]};
        const found:string[]=[],observed:(number|null)[]=[];let cursor:string|undefined,pages=0;
        do{
          expect(++pages).toBeLessThanOrEqual(3);
          const page=query.page({...input,cursor});expect(page.total).toBe(6);expect(page.items).toHaveLength(2);
          found.push(...page.items.map(item=>item.id));observed.push(...page.items.map(item=>item.values[sort]));cursor=page.next;
        }while(cursor);
        expect(found).toEqual(expected);expect(pages).toBe(3);
        expect(observed).toEqual(direction==="asc"?[0,25,25,100,null,null]:[100,25,25,0,null,null]);
      }
    };
    check();LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);
    const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();
    query=new LibraryQueryReader(db,"current",()=>now);db.exec("PRAGMA query_only=ON");check();
  },
);
it("keeps failed PP and If FC ranks after known zero and before missing through reversed pages",()=>{
  for(const id of ["zero","high","failed-a","failed-b","missing"])add(id);
  for(const[id,value]of [["zero",0],["high",200]] as const){
    metric(id,"aggregate-pp",{pp:known(value)},"P");metric(id,"fc-pp",{ppIfFc:known(value)},"P");
  }
  for(const id of ["failed-a","failed-b"]){
    metric(id,"numerical",{completion:known("failed")});
    metric(id,"aggregate-pp",{pp:known(900)},"P");metric(id,"fc-pp",{ppIfFc:known(900)},"P");
  }
  metric("missing","source-score",{grade:known("F")},"H");
  const check=()=>{
    for(const sort of ["pp","fc"] as const)for(const[direction,expected]of [["asc",["zero","high","failed-a","failed-b","missing"]],["desc",["high","zero","failed-a","failed-b","missing"]]] as const){
      const found:string[]=[],bands:string[]=[];let cursor:string|undefined;
      do{
        expect(found.length).toBeLessThan(5);
        const page=query.page({sort,direction,limit:1,cursor});expect(page.total).toBe(5);expect(page.items).toHaveLength(1);
        found.push(page.items[0].id);bands.push(page.items[0].band.key);cursor=page.next;
      }while(cursor);
      expect(found).toEqual(expected);expect(bands.slice(2)).toEqual(["failed","failed","missing"]);
    }
  };
  check();LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);
  const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();
  query=new LibraryQueryReader(db,"current",()=>now);db.exec("PRAGMA query_only=ON");check();
});
it("keeps PP failure separate from unavailable data and never treats grade alone as failure",()=>{
  add("a");add("b");add("c");metric("a","aggregate-pp",{pp:known(400)},"P");
  metric("b","numerical",{completion:known("failed")});metric("b","timeline-pp",{pp:known(240),peakPp:known(240)});
  metric("c","source-score",{grade:known("F")},"H");
  const rows=query.page({sort:"pp"}).items;
  expect(rows.map(row=>row.id)).toEqual(["a","b","c"]);
  expect(rows[1]).toMatchObject({values:{pp:null,peak:240},band:{label:"Failed · no pp awarded"}});
  expect(rows[2].band.label).toBe("No PP data");
});
it("matches literal text without interpreting filter syntax, with deterministic cursor ties",()=>{
  add("a","stars>=6");add("b","Beta");add("c","Beta");
  expect(ids({search:"stars>=6"})).toEqual(["a"]);
  const first=query.page({sort:"title",limit:1});expect(first.items[0].id).toBe("b");expect(first.next).toBeDefined();
  expect(query.page({sort:"title",limit:1,cursor:first.next}).items[0].id).toBe("c");
  expect(()=>query.page({sort:"date",cursor:first.next})).toThrow(/cursor/i);
});
it("matches any enabled duplicate source and excludes disabled-only identities",()=>{
  add("a");add("b","b",{source:"l"});add("c","c",{source:"i"});
  db.prepare("INSERT INTO locations VALUES('i','duplicate','a',?,1,'{}')").run(sha);
  expect(ids({filters:[{field:"source",values:["imported"]}]})).toEqual(["a","c"]);
  db.exec("UPDATE sources SET enabled=0 WHERE id='l'");expect(ids()).toEqual(["a","c"]);
});
it("uses deduplicated parent unions for scope, filter and counts while exposing direct membership",()=>{
  add("a");add("b");add("c");db.exec("INSERT INTO collections VALUES('parent','Parent',NULL,0,1),('child','Child','parent',0,2); INSERT INTO memberships VALUES('a','parent'),('a','child'),('b','child');");
  expect(ids({scope:{kind:"collection",id:"parent"}})).toEqual(["a","b"]);
  expect(ids({filters:[{field:"collection",values:["parent"]}]})).toEqual(["a","b"]);
  expect(query.collections()[0].count).toBe(2);expect(query.page({}).items[0].collectionIds).toEqual(["child","parent"]);
  db.exec("DELETE FROM memberships WHERE collection_id='child'; DELETE FROM collections WHERE id='child'");
  expect(ids({scope:{kind:"collection",id:"parent"}})).toEqual(["a"]);
});
it("shares mods Includes/Exactly semantics with NC→DT and PF→SD only for Includes",()=>{
  add("a","NC",{mods:512|64});add("b","DT",{mods:64});add("c","NM");add("d","PF",{mods:16384|32});
  expect(ids({filters:[{field:"mods",mode:"includes",match:"all",mods:["DT"]}]})).toEqual(["a","b"]);
  expect(ids({filters:[{field:"mods",mode:"exactly",match:null,mods:["DT"]}]})).toEqual(["b"]);
  expect(ids({filters:[{field:"mods",mode:"exactly",match:null,mods:[]}]})).toEqual(["c"]);
  expect(ids({filters:[{field:"mods",mode:"includes",match:"any",mods:["HD","SD"]}]})).toEqual(["d"]);
});
it("round-trips explicit Excludes text and rejects empty or malformed exclusion contracts",()=>{
  const filter={field:"mods",mode:"excludes",match:null,mods:["RX","HD"]};
  const parsed=parseLibraryQueryText('"mods:excludes(RX)" mods:excludes(RX,HD)');
  expect(parsed).toEqual({search:"mods:excludes(RX)",filters:[filter]});
  expect(formatLibraryQueryText(parsed)).toBe('"mods:excludes(RX)" mods:excludes(RX,HD)');
  for(const text of ["mods:excludes(none)","mods:excludes()","mods:excludes(RX,)","mods:excludes(RX,RX)","mods:excludes(rx)"])
    expect(()=>parseLibraryQueryText(text)).toThrow(/filter/i);
  for(const invalid of [{...filter,mods:[]},{...filter,match:"any"},{...filter,match:"all"},{...filter,mode:["excludes"]},
    {...filter,mods:null},{...filter,mods:["RX') OR 1=1 --"]}])
    expect(()=>validateLibraryFilter(invalid)).toThrow(/filter/i);
  expect(parseLibraryQueryText("mods:exactly(none)").filters).toEqual([{field:"mods",mode:"exactly",match:null,mods:[]}]);
  add("literal","mods:excludes(RX)");add("other");
  expect(ids({search:"mods:excludes(RX)"})).toEqual(["literal"]);
});
it.each([false,true])("excludes any selected membership with truthful unknowns and passive consistent surfaces (accelerated=%s)",accelerated=>{
  const fixtures:[string,unknown][]=[
    ["nm",[]],["rx",["RX"]],["hdrx",["HD","RX"]],["hd",["HD"]],["dt",["DT"]],["nc",["NC"]],
    ["sd",["SD"]],["pf",["PF"]],["unknown",null],["corrupt",["HD",null]],["boundary",["A|RX|B"]],
    ["mixed",["RX","A|HD|B"]],
  ];
  for(const [id,mods] of fixtures){
    add(id);db.prepare("UPDATE replays SET metadata=? WHERE id=?").run(JSON.stringify({nativeScore:{ruleset:0,mods}}),id);
  }
  db.exec("INSERT INTO collections VALUES('c','Collection',NULL,0,1);INSERT INTO memberships SELECT id,'c' FROM replays");
  if(accelerated){LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();}
  query=new LibraryQueryReader(db,"current",()=>now);
  const before=Number(db.prepare("SELECT total_changes() n").get()?.n);
  const state=()=>["replays","metric_targets","metric_results","metric_jobs","analysis_requests",...(accelerated?["query_projection","query_projection_dirty"]:[])].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const unchanged=state();db.exec("PRAGMA query_only=ON");
  const excludes=(mods:string[]):LibraryFilter=>({field:"mods",mode:"excludes",match:null,mods});
  const filter=excludes(["RX"]),input:LibraryQuery={filters:[filter],sort:"title",limit:3};
  expect(ids({...input,limit:128})).toEqual(["boundary","dt","hd","nc","nm","pf","sd"]);
  expect(ids({filters:[excludes(["RX","HD"])]})).toEqual(["boundary","dt","nc","nm","pf","sd"]);
  expect(ids({filters:[excludes(["DT"])]})).toEqual(["boundary","hd","hdrx","mixed","nm","pf","rx","sd"]);
  expect(ids({filters:[excludes(["NC"])]})).toEqual(["boundary","dt","hd","hdrx","mixed","nm","pf","rx","sd"]);
  expect(ids({filters:[excludes(["SD"])]})).toEqual(["boundary","dt","hd","hdrx","mixed","nc","nm","rx"]);
  expect(ids({filters:[excludes(["PF"])]})).toEqual(["boundary","dt","hd","hdrx","mixed","nc","nm","rx","sd"]);
  expect(ids({filters:[{field:"mods",mode:"includes",match:"any",mods:["HD","RX"]}]})).toEqual(["hd","hdrx","mixed","rx"]);
  expect(ids({filters:[{field:"mods",mode:"includes",match:"all",mods:["DT","SD"]}]})).toEqual([]);
  expect(ids({filters:[{field:"mods",mode:"exactly",match:null,mods:["DT"]}]})).toEqual(["dt"]);
  expect(ids({filters:[{field:"mods",mode:"exactly",match:null,mods:[]}]})).toEqual(["nm"]);
  expect(query.page(input).total).toBe(7);expect(query.preview({},filter).count).toBe(7);
  expect(query.preview({filters:[{field:"mods",mode:"includes",match:"all",mods:["RX"]}]},filter).count).toBe(7);
  const pages:string[]=[];let cursor:string|undefined;
  do{const page=query.page({...input,cursor});pages.push(...page.items.map(row=>row.id));cursor=page.next;}while(cursor);
  expect(pages).toEqual(["boundary","dt","hd","nc","nm","pf","sd"]);
  expect(query.bands(input).items.reduce((total,band)=>total+band.count,0)).toBe(7);
  expect(query.facets(input,"source").items).toEqual([{value:"stable",count:7}]);
  expect(query.facets(input,"collection").items.find(row=>row.value==="c")?.count).toBe(7);
  expect(query.reveal(input,"rx")).toEqual({state:"not-found"});
  expect(query.reveal(input,"nm")).toMatchObject({state:"found",position:4});
  expect(query.captureOrder(input,128).ids).toEqual(pages);
  expect(Number(db.prepare("SELECT total_changes() n").get()?.n)).toBe(before);expect(state()).toEqual(unchanged);
});
it.each([false,true])("binds exclusion tokens and mixed alias parameters safely (accelerated=%s)",accelerated=>{
  add("kept");add("custom");add("nightcore");
  db.prepare("UPDATE replays SET metadata=? WHERE id='custom'").run(JSON.stringify({nativeScore:{ruleset:0,mods:["RX11"]}}));
  db.prepare("UPDATE replays SET metadata=? WHERE id='nightcore'").run(JSON.stringify({nativeScore:{ruleset:0,mods:["NC"]}}));
  if(accelerated){LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();}
  const statements:string[]=[],reader=new LibraryQueryReader({prepare(sql:string){statements.push(sql);return db.prepare(sql);}},"current",()=>now);
  expect(reader.page({sort:"title",filters:[{field:"mods",mode:"excludes",match:null,mods:["RX11","DT","HD","SD"]}]}).items.map(row=>row.id)).toEqual(["kept"]);
  const sql=statements.find(statement=>statement.includes("matched AS MATERIALIZED"));expect(sql).toBeDefined();
  if(!sql)throw Error("Missing mod exclusion query");
  expect(sql).not.toContain("RX11");expect(sql).not.toContain("52583131");
  const params=accelerated?["|52583131|","|4454|","|4E43|","|4844|","|5344|","|5046|",65]:["RX11","HD",65];
  expect(db.prepare("EXPLAIN QUERY PLAN "+sql).all(...params).length).toBeGreaterThan(0);
  if(accelerated){expect(sql).toContain("instr(mod_tokens,?)");expect(sql).not.toContain("json_each(q.mods)");}
});
it("derives analysis state only from current S/C results or real jobs, with user Pause independent from Off",()=>{
  add("a");add("b");add("c");add("d");metric("a","numerical",{ur:known(80)});
  db.exec("INSERT INTO analysis_requests VALUES('b','S','queued',NULL),('c','S','failed','Map missing'),('d','P','running',NULL)");
  expect(query.page({}).items.map(row=>row.analysis)).toEqual(["analysed","queued","failed","none"]);
  db.prepare("UPDATE settings SET value=? WHERE key='analysis'").run(JSON.stringify({mode:"bg",userPaused:true,workers:2,pauseOnBattery:true}));
  expect(query.page({}).items[1].analysis).toBe("paused");
  expect(ids({filters:[{field:"astate",values:["active"]}]})).toEqual(["b"]);
});
it("previews replace just the edited field and counts unavailable analysis exclusions once",()=>{
  add("a");add("b");add("c");metric("a","numerical",{ur:known(70),biasMs:known(1)});metric("b","numerical",{ur:known(100)});
  const filters:LibraryFilter[]=[{field:"ur",op:"atMost",a:80,b:null},{field:"bias",min:-3,max:3}];
  expect(query.preview({filters},{field:"ur",op:"atMost",a:110,b:null})).toMatchObject({count:1,analysisExcluded:2});
  expect(query.page({filters}).total).toBe(1);expect(query.page({}).total).toBe(3);
  db.exec("PRAGMA query_only=ON");expect(query.facets({filters},"player").items).toEqual([{value:"player",count:1}]);
});
it("rejects duplicate fields, unknown controls and unbounded requests",()=>{
  expect(()=>query.page({filters:[{field:"source",values:["stable"]},{field:"source",values:["lazer"]}]})).toThrow(/filter/i);
  expect(()=>query.page({sort:"cause"} as unknown as LibraryQuery)).toThrow();
  expect(()=>query.page({limit:10001})).toThrow();expect(()=>query.page({search:"x".repeat(4097)})).toThrow();
});
it("round-trips every GUI filter with quoted values only on explicit syntax acceptance",()=>{
  const filters:LibraryFilter[]=[{field:"stars",basis:"map",min:5,max:7},{field:"mods",mode:"includes",match:"any",mods:["HD","DT"]},
    {field:"acc",op:"atLeast",a:98,b:null},{field:"miss",op:"between",a:0,b:3},{field:"pp",min:300,max:null},
    {field:"played",preset:"custom",from:"2026-09-01",to:"2026-10-16"},{field:"bpm",min:160,max:200},{field:"len",min:120,max:240},
    {field:"status",values:["ranked"]},{field:"mapper",values:['A "quoted" mapper']},{field:"grade",values:["SS","S"]},{field:"player",values:["Player name"]},
    {field:"ur",op:"atMost",a:80,b:null},{field:"bias",min:-3,max:3},{field:"result",values:["fc"]},{field:"playedon",values:["stable","unknown"]},
    {field:"source",values:["stable","lazer"]},{field:"collection",values:["parent"]},{field:"review",values:["reviewed"]},{field:"astate",values:["none"]}];
  expect(parseLibraryQueryText(formatLibraryQueryText({search:"Blue Zenith",filters}))).toEqual({search:"Blue Zenith",filters});
});
it("preserves unknown native mods, current explicit zero values and FC versus perfect combo",()=>{
  add("a");add("b");add("c");
  db.prepare("UPDATE replays SET metadata=? WHERE id='a'").run(JSON.stringify({header:{modsBitmask:0,version:30000001},nativeScore:{mods:null,mapMetadata:{title:"Native"}}}));
  db.prepare("UPDATE replays SET metadata=? WHERE id='b'").run(JSON.stringify({nativeScore:{mods:[{acronym:"NC",settings:{speed_change:1.2}}]}}));
  metric("c","source-score",{misses:known(0),maxCombo:known(90)},"H");
  expect(query.page({}).items.find(row=>row.id==="a")?.mods).toBeNull();
  expect(ids({filters:[{field:"mods",mode:"exactly",match:null,mods:[]}]})).toEqual(["c"]);
  expect(ids({filters:[{field:"mods",mode:"includes",match:"all",mods:["DT"]}]})).toEqual(["b"]);
  expect(query.page({}).items.find(row=>row.id==="c")?.fullCombo).toBeNull();
  metric("c","numerical",{completion:known("passed"),sliderBreaks:known(0),comboLosses:known(0),fc:known(true),perfectCombo:known(false)},"S","current",{completionEvidence:"recorded-outcome-v1",completeBreakEvidence:true,ruleset:"stable"});
  metric("c","calculated-map",{exactMapMaxCombo:known(100)},"P");
  expect(query.page({}).items.find(row=>row.id==="c")).toMatchObject({fullCombo:true,perfectCombo:false,values:{miss:0,sliderBreaks:0}});
});
it("pages null tails without duplicates and keeps NEW independent of date and review",()=>{
  add("a","a",{days:100});add("b","b",{baseline:1});add("c","c",{session:"old"});metric("a","numerical",{ur:known(0)});
  const first=query.page({sort:"ur",limit:1}),second=query.page({sort:"ur",limit:1,cursor:first.next}),third=query.page({sort:"ur",limit:1,cursor:second.next});
  expect([first.items[0].id,second.items[0].id,third.items[0].id]).toEqual(["a","b","c"]);expect(third.next).toBeUndefined();
  expect(query.page({}).items.map(row=>row.isNew)).toEqual([true,false,false]);
  expect(()=>query.preview({filters:[]},{field:"played",preset:"custom",from:"2026-02-31",to:"2026-03-01"})).toThrow();
});
it("fences mutable metric and membership changes between keyset pages",()=>{
  add("a");add("b");metric("a","aggregate-pp",{pp:known(10)},"P");
  const page=query.page({limit:1});metric("b","aggregate-pp",{pp:known(20)},"P");
  expect(()=>query.page({limit:1,cursor:page.next})).toThrow(LibraryQueryInvalidatedError);
  const next=query.page({limit:1});db.exec("INSERT INTO collections VALUES('c','Collection',NULL,0,1); INSERT INTO memberships VALUES('a','c')");
  expect(()=>query.page({limit:1,cursor:next.next})).toThrow(LibraryQueryInvalidatedError);
});
it("preserves the explicit Grade none filter as zero results through preview and query text",()=>{
  add("a");metric("a","source-score",{grade:known("S")},"H");
  const none:LibraryFilter={field:"grade",values:[]};
  expect(ids({filters:[none]})).toEqual([]);expect(query.preview({},none).count).toBe(0);
  expect(parseLibraryQueryText(formatLibraryQueryText({filters:[none]}))).toEqual({search:"",filters:[none]});
});
it("uses source PP only with proven completion and retains calculated precedence",()=>{
  for(const id of ["a","b","c","d","e"])add(id);
  for(const [id,completion,pp] of [["a","passed",0],["b","passed",200],["c","failed",100],["d","unknown",300],["e","passed",500]] as const)metric(id,"source-score",{completion:completion==="unknown"?{state:"unknown",reason:"not-established"}:known(completion),sourcePp:known(pp)},"H");
  metric("e","aggregate-pp",{pp:known(450)},"P");
  expect(query.page({sort:"title"}).items.map(row=>row.values.pp)).toEqual([0,200,null,null,450]);
});
it("offers named empty collection options, favourites and parent-name matching",()=>{
  add("a");db.exec("UPDATE replays SET favourite=1; INSERT INTO collections VALUES('p','Practice',NULL,0,1),('c','Tournament','p',0,2),('empty','Empty',NULL,1,3)");
  const all=query.facets({},"collection").items;
  expect(all.find(option=>option.value==="fav")).toMatchObject({label:"Favourites",count:1});
  expect(all.find(option=>option.value==="empty")).toMatchObject({label:"Empty",count:0});
  expect(query.facets({},"collection",{search:"Practice"}).items.map(option=>option.value)).toEqual(["c","p"]);
  expect(all.find(option=>option.value==="c")).toMatchObject({label:"Tournament",parentId:"p",parentLabel:"Practice"});
});
it("provides bounded bands, inclusive reveal and current scalar detail without strip payload",()=>{
  for(const id of ["a","b","c"])add(id,"Song");metric("a","aggregate-pp",{pp:known(500)},"P");metric("b","aggregate-pp",{pp:known(400)},"P");
  const bands=query.bands({}, {limit:2});expect(bands.items.map(item=>item.count)).toEqual([1,1]);expect(bands.next).toBeDefined();
  expect(query.bands({}, {limit:2,cursor:bands.next}).items[0].key).toBe("missing");
  const revealed=query.reveal({limit:1},"b");expect(revealed).toMatchObject({state:"found",position:1,page:{items:[{id:"b"}]}});
  const detail=query.detail("a");expect(detail?.metrics[0]).toMatchObject({slot:"aggregate-pp",fields:{pp:known(500)}});
  expect(detail).not.toHaveProperty("strip_payload");expect(query.reveal({},"absent")).toEqual({state:"not-found"});
});
it("pages direct memberships and collection metadata without unbounded row arrays",()=>{
  add("a");for(let i=0;i<40;i++){const id=String(i).padStart(3,"0");db.prepare("INSERT INTO collections VALUES(?,?,NULL,0,?)").run(id,"Collection "+id,i);db.prepare("INSERT INTO memberships VALUES('a',?)").run(id);}
  const row=query.page({}).items[0];expect(row.collectionIds.length).toBeLessThanOrEqual(16);expect(row.collectionCount).toBe(40);
  const first=query.membershipsPage("a",{limit:10});expect(first.items).toHaveLength(10);expect(first.total).toBe(40);
  expect(query.membershipsPage("a",{limit:10,after:first.next}).items[0].id).toBe("010");
  expect(query.collectionsPage({limit:10}).items).toHaveLength(10);
});
it("freezes ordered snapshot membership and labels with bounded neighbour reads",()=>{
  add("a");add("b");db.exec("INSERT INTO collections VALUES('p','Practice',NULL,0,1); INSERT INTO memberships VALUES('a','p'),('b','p')");
  const snapshots=new LibraryQuerySnapshots(query,{maxIds:100000,maxBytes:32*1024*1024,maxSnapshots:4});
  const snapshot=snapshots.create({scope:{kind:"collection",id:"p"},sort:"title"},"b");expect(snapshot).toMatchObject({total:2,position:1,scopeLabel:"Practice",sortLabel:"Title"});
  db.exec("UPDATE collections SET name='Renamed'; DELETE FROM memberships WHERE replay_id='a'");
  expect(snapshots.neighbors(snapshot.snapshotId,{position:1,before:1,after:0})).toMatchObject({items:[{id:"a",position:0},{id:"b",position:1}],scopeLabel:"Practice"});
  expect(()=>snapshots.neighbors(snapshot.snapshotId,{position:1,before:1000})).toThrow();
  snapshots.release(snapshot.snapshotId);expect(()=>snapshots.neighbors(snapshot.snapshotId,{position:0})).toThrow(/snapshot/i);
});
it("keeps wide scalar rows and opaque cursors within response bytes without losing rows",()=>{
  for(let i=0;i<90;i++)add(String(i).padStart(3,"0"),"長".repeat(4096),{player:String(i).padStart(3,"0")+"名".repeat(4096)});
  const found:string[]=[];let cursor:string|undefined;
  do{const page=query.page({sort:"title",limit:128,cursor});expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024*1024);found.push(...page.items.map(row=>row.id));cursor=page.next;}while(cursor);
  expect(found).toHaveLength(90);expect(new Set(found).size).toBe(90);
  const facet=query.facets({},"player");expect(facet.next).toBeDefined();expect(Buffer.byteLength(JSON.stringify(facet))).toBeLessThanOrEqual(1024*1024);
  expect(query.facets({},"player",{after:facet.next}).items.length+facet.items.length).toBe(90);
  expect(()=>query.facets({},"player",{search:"different",after:facet.next})).toThrow(/cursor/);
});
it("accepts a bounded many-word literal search without a SQL expression-depth failure",()=>{
  add("a","x");expect(ids({search:Array(1500).fill("x").join(" ")})).toEqual(["a"]);
});
it("routes only passive operations and releases owned snapshots on close",()=>{
  add("a");add("b");const api=new LibraryQueryApi(query);db.exec("PRAGMA query_only=ON");
  expect(api.receive("query-page",{query:{limit:1}})).toMatchObject({total:2});
  expect(api.receive("query-preview",{draft:{field:"grade",values:[]}})).toMatchObject({count:0});
  expect(api.receive("query-detail",{replayId:"a"})).toMatchObject({item:{id:"a"}});
  const snapshot=api.receive("query-snapshot-create",{replayId:"a",query:{sort:"title"}}) as {snapshotId:string};
  expect(api.receive("query-snapshot-neighbors",{snapshotId:snapshot.snapshotId,options:{position:0}})).toMatchObject({total:2});
  expect(()=>api.receive("metric-request" as never,{})).toThrow(/operation/);
  expect(()=>api.receive("query-page",{query:{sort:"cause"}})).toThrow();api.close();
  expect(()=>api.receive("query-page",{})).toThrow(/closed/);
});
it("keeps band totals and order aligned with all twelve scalar sorts",()=>{
  add("a");add("b");metric("a","source-score",{accuracy:known(0.99),maxCombo:known(1000),misses:known(0)},"H");
  metric("a","calculated-map",{replayStars:known(6.5),bpm:known(200),lengthMs:known(180000)},"P");
  for(const sort of Object.keys(LIBRARY_SORTS) as (keyof typeof LIBRARY_SORTS)[]){const bands=query.bands({sort});expect(bands.items.reduce((sum,item)=>sum+item.count,0)).toBe(2);expect(bands.items[0].anchorId).toBe(query.page({sort}).items[0].id);}
});

it("preserves scoped Result/analysis exclusions, nulls, FC notes and selected-map counts",()=>{
  for(const id of ["a","b","c","d","e","f","g","taiko"])add(id,"Same");
  for(const id of ["a","b","c","e","f","g","taiko"]){
    metric(id,"source-score",{completion:known(id==="c"?"failed":"passed"),misses:known(0)},"H","current",{completionEvidence:"recorded-outcome-v1"});
  }
  for(const id of ["a","b","c","d","e","f","g","taiko"]){
    metric(id,"numerical",{ur:id==="b"?{state:"unknown"}:known(id==="e"?150:90),biasMs:id==="f"?{state:"unknown"}:known(0),comboLosses:known(0),sliderBreaks:known(0)},"S","current",{completeBreakEvidence:id!=="e",ruleset:"stable"});
  }
  db.exec(`UPDATE replays SET metadata=json_set(metadata,'$.header.mode',1) WHERE id='taiko';
    UPDATE locations SET metadata=(SELECT metadata FROM replays WHERE id=replay_id) WHERE replay_id='taiko';
    INSERT INTO collections VALUES('parent','Parent',NULL,0,1),('child','Child','parent',0,2);
    INSERT INTO memberships SELECT id,'child' FROM replays WHERE id<>'c';INSERT INTO memberships VALUES('a','parent');`);
  const scope={kind:"collection" as const,id:"parent"},analysis:LibraryFilter[]=[{field:"ur",op:"atMost",a:100,b:null},{field:"bias",min:-5,max:5}];
  const check=()=>{
    const input:LibraryQuery={scope,filters:[{field:"result",values:["fc"]},...analysis],sort:"title",limit:1};
    const page=query.page(input);expect(page).toMatchObject({total:2,analysisExcluded:2,resultExcluded:{unknownOutcome:1,missingBreakEvidence:0}});expect(page.items.map(v=>v.id)).toEqual(["a"]);
    const next=query.page({...input,cursor:page.next});expect(next.items.map(v=>v.id)).toEqual(["g"]);expect(next).toMatchObject({total:2,analysisExcluded:2,resultExcluded:{unknownOutcome:1,missingBreakEvidence:0}});
    const empty=query.page({...input,filters:[{field:"result",values:["fc"]},{field:"ur",op:"atMost",a:0,b:null},{field:"bias",min:-5,max:5}]});
    expect(empty).toMatchObject({items:[],total:0,analysisExcluded:2,resultExcluded:{unknownOutcome:0,missingBreakEvidence:0}});
    const fc=query.page({scope,filters:[{field:"result",values:["fc"]}]});expect(fc).toMatchObject({total:4,analysisExcluded:0,resultExcluded:{unknownOutcome:1,missingBreakEvidence:1}});
    expect(query.page({scope,filters:[{field:"result",values:["passed"]}]})).toMatchObject({total:5,resultExcluded:{unknownOutcome:1,missingBreakEvidence:0}});
    expect(query.page({scope,filters:[{field:"result",values:["failed"]}]})).toMatchObject({items:[],total:0,resultExcluded:{unknownOutcome:1,missingBreakEvidence:0}});
    expect(query.page({scope,filters:[{field:"result",values:["unknown"]}]})).toMatchObject({total:1});
    expect(query.sameMap("e",{filters:[{field:"result",values:["fc"]}]})).toMatchObject({items:[],total:0,resultExcluded:{unknownOutcome:0,missingBreakEvidence:1}});
    expect(query.reveal(input,"g")).toMatchObject({state:"found",position:1,page:{total:2,items:[{id:"g"}]}});
  };
  check();LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();query=new LibraryQueryReader(db,"current",()=>now);check();
});

it("picks projected title pages in existing index order without sorting all matched text",()=>{
  for(let n=0;n<80;n++)add(String(n).padStart(3,"0"),`Title ${79-n}`);
  LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);
  const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();
  query=new LibraryQueryReader(db,"current",()=>now);
  for(const direction of ["asc","desc"] as const){
    const statements:string[]=[],prepare=db.prepare.bind(db),spy=jest.spyOn(db,"prepare").mockImplementation(sql=>{
      if(sql.includes("matched AS MATERIALIZED"))statements.push(sql);return prepare(sql);
    });
    try{expect(query.page({sort:"title",direction,limit:4}).items).toHaveLength(4);}finally{spy.mockRestore();}
    expect(statements).toHaveLength(1);
    const plan=db.prepare("EXPLAIN QUERY PLAN "+statements[0]).all(5);
    const picked=plan.find(row=>row.detail==="MATERIALIZE picked");expect(picked).toBeDefined();
    const picker=plan.filter(row=>row.parent===picked?.id).map(row=>String(row.detail));
    expect(picker.some(detail=>detail.includes(`query_sort_title_${direction}`))).toBe(true);
    expect(picker.some(detail=>detail.includes("TEMP B-TREE FOR ORDER BY"))).toBe(false);
    expect(plan.some(row=>String(row.detail).includes("id=?")&&String(row.detail).includes("LEFT-JOIN"))).toBe(true);
  }
});

it("preserves projected title nulls, ID ties, cursors, reveal and constrained membership",()=>{
  add("a","alpha");add("b","ALPHA",{source:"l"});add("c","Zulu");add("n1","");add("n2","");
  db.exec("INSERT INTO collections VALUES('p','Parent',NULL,0,1),('c','Child','p',0,2);INSERT INTO memberships VALUES('a','p'),('a','c'),('b','c'),('n1','c');UPDATE replays SET favourite=1 WHERE id IN ('b','n2')");
  LibraryQueryProjection.migrate(db);LibraryQueryProjection.migrateAcceleration(db);
  const projection=new LibraryQueryProjection(db);while(projection.pendingCount())projection.flushInTransaction();
  query=new LibraryQueryReader(db,"current",()=>now);db.exec("PRAGMA query_only=ON");
  for(const [direction,expected]of [["asc",["a","b","c","n1","n2"]],["desc",["c","a","b","n1","n2"]]] as const){
    const input:LibraryQuery={sort:"title",direction,limit:1};let cursor:string|undefined;const found:string[]=[];
    do{const page=query.page({...input,cursor});expect(page.total).toBe(5);found.push(...page.items.map(row=>row.id));cursor=page.next;}while(cursor);
    expect(found).toEqual(expected);
    for(const id of ["b","n1","n2"]){expect(query.reveal(input,id)).toMatchObject({state:"found",position:(expected as readonly string[]).indexOf(id),page:{total:5,items:[{id}]}});}
    expect(ids({...input,limit:64,scope:{kind:"collection",id:"p"}})).toEqual(expected.filter(id=>["a","b","n1"].includes(id)));
    expect(ids({...input,limit:64,filters:[{field:"source",values:["lazer"]}]})).toEqual(["b"]);
    expect(ids({...input,limit:64,scope:{kind:"favourites"}})).toEqual(expected.filter(id=>["b","n2"].includes(id)));
    expect(query.sameMap("b",input)).toMatchObject({total:1,items:[{id:"b"}]});
    expect(query.page({...input,search:"absent"})).toMatchObject({items:[],total:0,analysisExcluded:0});
  }
});
