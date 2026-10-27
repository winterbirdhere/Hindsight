import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStore } from "./library-store";
import { LibraryQueryInvalidatedError, LibraryQueryReader, LibraryQueryUpdatingError } from "./library-query";
import { LibraryQuerySnapshots } from "./library-query-snapshots";

let directory:string,path:string,store:LibraryStore,read:DatabaseSync,query:LibraryQueryReader;
const mapMd5="f".repeat(32);
beforeEach(()=>{
  directory=mkdtempSync(join(tmpdir(),"hindsight-query-integration-"));path=join(directory,"library.sqlite");store=new LibraryStore(path,"session");
  for(const kind of ["stable","replays","lazer","imported"] as const)store.registerSource({id:kind,kind,directory:join(directory,kind)});
  store.metrics.setAnalysisSettings({mode:"off",workers:2,userPaused:false,pauseOnBattery:true});
  read=new DatabaseSync(path,{readOnly:true});query=new LibraryQueryReader(read,"session");
});
afterEach(()=>{read.close();store.close();for(const suffix of ["","-wal","-shm"])if(existsSync(path+suffix))unlinkSync(path+suffix);rmdirSync(directory);});
function observe(sourceId:string,index:number,sha256=String(index).padStart(64,"0")) {
  const generation=store.beginScan(sourceId);
  const header={mode:0,version:20260901,sourceFormat:"stable",nativeScoreInfo:false,beatmapMD5:mapMd5,player:`Player ${index}`,modsBitmask:0,
    counts:{great:100,ok:0,meh:0,geki:0,katu:0,miss:0},score:10000,maxCombo:100,perfectComboFlag:true,playedAtTicks:"639277056000000000"};
  const id=store.upsertObservation({sourceId,sourceKey:String(index),generation,locator:join(directory,`${index}.osr`),sha256,available:true,addedAt:index,metadata:{header}});
  store.finishScan(sourceId,generation);return id;
}
function drain(){let pages=0;while(store.queryProjectionPending()){expect(pages++).toBeLessThan(1000);store.maintainQueryProjection();}}
it("settles map visibility/search before reads and retries availability admission afterwards",()=>{
  const id=observe("replays",1);store.enablePerformanceAdmission();
  const generation=store.beginMapScan("stable");store.upsertMap({sourceId:"stable",generation,sourceKey:"map",md5:mapMd5,locator:"map.osu",state:"unverified",metadata:{map:{title:"Visible map"}}});store.finishMapScan("stable",generation);drain();
  store.setSourceEnabled("stable",false);drain();
  while(store.sourceAdmissionPending())store.maintainSourceAdmission();
  const ticket=store.preparations.claim(id,"P");if(!ticket)throw Error("Missing unavailable-map preparation");
  expect(store.preparations.fail(ticket,"map unavailable")).toBe("applied");
  expect(query.page({search:"Visible map"}).total).toBe(0);
  store.setSourceEnabled("stable",true);expect(()=>query.page({})).toThrow(LibraryQueryUpdatingError);drain();
  expect(store.sourceAdmissionPending()).toBeGreaterThan(0);expect(query.page({search:"Visible map"}).total).toBe(1);
  expect(store.preparations.read(id).find(row=>row.stage==="P")?.state).toBe("failed");
  while(store.sourceAdmissionPending())store.maintainSourceAdmission();
  expect(store.preparations.read(id).find(row=>row.stage==="P")?.state).toBe("queued");
  expect(store.queryProjectionPending()).toBe(0);expect(query.page({search:"Visible map"}).total).toBe(1);
});

it("reads the real migrated Store through a read-only connection for all four indexed source memberships",()=>{
  const ids=["stable","replays","lazer","imported"].map((source,index)=>observe(source,index+1));
  const generation=store.beginMapScan("stable");store.upsertMap({sourceId:"stable",generation,sourceKey:"map",md5:mapMd5,locator:join(directory,"map.osu"),state:"unverified",metadata:{map:{title:"Indexed title",artist:"Artist",creator:"Mapper",difficulty:"Hard",md5:mapMd5}}});store.finishMapScan("stable",generation);
  const target=store.metrics.setTarget({replayId:ids[0],slot:"numerical",stage:"S",inputKey:"numerical-test",producerVersion:"test-v1"});
  store.metrics.publishObserved(target,{fields:{ur:{state:"known",value:80},biasMs:{state:"unknown",reason:"no-timing-samples"},completion:{state:"known",value:"passed"}},provenance:{replaySha256:"1".padStart(64,"0")}});
  expect(store.queryProjectionPending()).toBeGreaterThan(0);expect(()=>query.page({})).toThrow(LibraryQueryUpdatingError);drain();
  const before=read.prepare("SELECT count(*) AS n FROM metric_jobs").get()?.n;
  expect(query.page({}).items.every(item=>item.title==="Indexed title")).toBe(true);
  expect(query.facets({},"source").items.map(item=>item.value)).toEqual(["imported","lazer","replays","stable"]);
  expect(query.detail(ids[0])?.metrics.find(metric=>metric.slot==="numerical")?.fields.biasMs).toEqual({state:"unknown",reason:"no-timing-samples"});
  expect(query.sameMap(ids[0],{limit:2}).total).toBe(4);expect(query.sameMap(ids[0],{limit:2}).items).toHaveLength(2);
  expect(query.page({filters:[{field:"ur",op:"atMost",a:80,b:null}]}).items.map(item=>item.id)).toEqual([ids[0]]);
  expect(read.prepare("SELECT count(*) AS n FROM metric_jobs").get()?.n).toBe(before);
});
it("fences external Store commits, resolves merged aliases, and preserves review/collections across restart",()=>{
  const a=observe("replays",1),b=observe("imported",2),collection=store.createCollection("Practice");store.setMembership(a,collection,true);store.setReview(a,"reviewed");
  const page=query.page({limit:1});store.setReview(b,"needs-another-look");
  expect(()=>query.page({limit:1,cursor:page.next})).toThrow(LibraryQueryInvalidatedError);
  const scan=store.beginScan("stable"),alias=store.upsertObservation({sourceId:"stable",sourceKey:"alias",generation:scan,locator:"alias",sha256:null,available:false,addedAt:1,metadata:{}});
  store.upsertObservation({sourceId:"stable",sourceKey:"alias",generation:scan,locator:"alias",sha256:"1".padStart(64,"0"),available:true,addedAt:1,metadata:{}});
  expect(store.queryProjectionPending()).toBeGreaterThan(0);expect(()=>query.detail(alias)).toThrow(LibraryQueryUpdatingError);drain();
  expect(query.detail(alias)?.item.id).toBe(a);
  expect(query.membershipsPage(alias).items[0].name).toBe("Practice");
  read.close();store.close();store=new LibraryStore(path,"restarted");read=new DatabaseSync(path,{readOnly:true});query=new LibraryQueryReader(read,"restarted");
  drain();
  expect(query.detail(a)?.item).toMatchObject({review:"reviewed",isNew:false,collectionCount:1});
  store.setSourceEnabled("stable",false);store.setSourceEnabled("replays",false);expect(query.detail(a)).toBeNull();expect(query.page({}).items.map(item=>item.id)).toEqual([b]);
});
it("holds the planned 100k navigation IDs internally, pages neighbors, and rejects capacity without truncation",()=>{
  const ids=Array.from({length:100000},(_,i)=>String(i).padStart(36,"0"));
  const snapshots=new LibraryQuerySnapshots({captureOrder:()=>({ids,scopeLabel:"All replays",sortLabel:"PP"})});
  const ref=snapshots.create({},ids[50000]);expect(ref.total).toBe(100000);expect(ref).not.toHaveProperty("ids");expect(snapshots.usage().estimatedBytes).toBeLessThan(32*1024*1024);
  expect(snapshots.neighbors(ref.snapshotId,{position:50000,before:63,after:63}).items).toHaveLength(127);
  expect(()=>snapshots.create({},ids[50000])).toThrow(/memory budget/);expect(snapshots.usage().snapshots).toBe(1);
  snapshots.clear();expect(snapshots.usage()).toEqual({snapshots:0,estimatedBytes:0});
  const limited=new LibraryQuerySnapshots({captureOrder:()=>({ids,scopeLabel:"All replays",sortLabel:"PP"})},{maxIds:99999});
  expect(()=>limited.create({},ids[0])).toThrow(/snapshot limit/);expect(limited.usage().snapshots).toBe(0);
});
it("reports authoritative subcollection counts independently of metadata pagination",()=>{
  const parent=store.createCollection("Parent");for(let i=0;i<105;i++)store.createCollection(`Child ${i}`,parent);
  const page=query.collectionsPage({limit:1});expect(page.items[0]).toMatchObject({id:parent,childCount:105});expect(page.next).toBeDefined();
});
it("starts collection scope from indexed memberships and counts favourites through its narrow index",()=>{
  const a=observe("stable",1),b=observe("lazer",2),c=observe("imported",3);
  const parent=store.createCollection("Parent"),left=store.createCollection("Left",parent),right=store.createCollection("Right",parent);
  for(const collection of [parent,left,right])store.setMembership(a,collection,true);
  store.setMembership(b,left,true);store.setMembership(b,right,true);store.setMembership(c,right,true);store.setFavourite(a,true);drain();
  const statements:string[]=[];
  const captured=new LibraryQueryReader({prepare(sql:string){statements.push(sql);return read.prepare(sql);}},"session");
  const before=read.prepare("SELECT count(*) AS n FROM metric_jobs").get()?.n;
  expect(captured.page({scope:{kind:"collection",id:parent}}).total).toBe(3);
  const pageSql=statements.find(sql=>sql.includes("matched AS MATERIALIZED"));
  if(!pageSql)throw new Error("Missing combined collection page/count statement");
  const scopePlan=read.prepare("EXPLAIN QUERY PLAN "+pageSql).all(parent,parent,65).map(row=>String(row.detail));
  const picked=scopePlan.indexOf("MATERIALIZE picked");expect(picked).toBeGreaterThan(0);
  const matchedPlan=scopePlan.slice(0,picked);
  expect(matchedPlan.some(detail=>detail.includes("CORRELATED"))).toBe(false);
  expect(matchedPlan.some(detail=>detail.includes("query_membership_collection"))).toBe(true);
  expect(scopePlan.slice(picked).some(detail=>/SEARCH p .*id=\?/.test(detail)&&detail.includes("LEFT-JOIN"))).toBe(true);
  expect(scopePlan).not.toContain("MATERIALIZE projected");
  statements.length=0;
  const facet=captured.facets({},"collection");
  expect(facet.items.find(item=>item.value===parent)?.count).toBe(3);
  expect(facet.items.find(item=>item.value===left)?.count).toBe(2);
  expect(facet.items.find(item=>item.value===right)?.count).toBe(3);
  expect(facet.items.find(item=>item.value==="fav")?.count).toBe(1);
  const facetSql=statements.find(sql=>sql.includes("choices AS"));
  if(!facetSql)throw new Error("Missing collection facet statement");
  const facetPlan=read.prepare("EXPLAIN QUERY PLAN "+facetSql).all("","","","","",101).map(row=>String(row.detail));
  expect(facetPlan.some(detail=>detail.includes("COVERING INDEX query_projection_favourite"))).toBe(true);
  const membershipScan=facetPlan.findIndex(detail=>detail==="SCAN selected");
  const projectionLookup=facetPlan.findIndex((detail,index)=>index>membershipScan&&
    (detail.includes("query_projection_visible (visible=? AND id=?)")||detail.includes("query_projection_analysis_filter_cover (visible=? AND standard_excluded=? AND id=?)")));
  expect(membershipScan).toBeGreaterThan(-1);expect(projectionLookup).toBeGreaterThan(membershipScan);
  expect(read.prepare("SELECT count(*) AS n FROM metric_jobs").get()?.n).toBe(before);
});
it("keeps collection unions exact across sibling overlaps, filters, hidden sources and empty choices while Off",()=>{
  const a=observe("stable",1),b=observe("lazer",2),c=observe("imported",3),d=observe("replays",4);
  const parent=store.createCollection("Parent"),left=store.createCollection("Left",parent),right=store.createCollection("Right",parent),empty=store.createCollection("Empty",parent);
  for(const collection of [parent,left,right])store.setMembership(a,collection,true);
  store.setMembership(b,left,true);store.setMembership(b,right,true);store.setMembership(c,right,true);store.setFavourite(a,true);store.setFavourite(d,true);
  store.setReview(a,"reviewed");store.setReview(b,"reviewed");drain();
  const values=[parent,left,"fav"];
  expect(new Set(query.page({filters:[{field:"collection",values}]}).items.map(item=>item.id))).toEqual(new Set([a,b,c,d]));
  expect(query.page({scope:{kind:"collection",id:parent},filters:[{field:"collection",values:[right]}]}).total).toBe(3);
  const filtered=query.facets({filters:[{field:"review",values:["reviewed"]}]},"collection").items;
  expect(filtered.find(item=>item.value===parent)?.count).toBe(2);
  expect(filtered.find(item=>item.value===right)?.count).toBe(2);
  expect(filtered.find(item=>item.value===empty)?.count).toBe(0);
  store.setSourceEnabled("stable",false);drain();
  const visible=query.facets({},"collection").items;
  expect(visible.find(item=>item.value===parent)?.count).toBe(2);
  expect(visible.find(item=>item.value===left)?.count).toBe(1);
  expect(visible.find(item=>item.value==="fav")?.count).toBe(1);
  expect(query.page({scope:{kind:"collection",id:parent}}).total).toBe(2);
  expect(query.page({scope:{kind:"collection",id:empty}}).total).toBe(0);
  expect(()=>query.page({filters:[{field:"collection",values:[]}]})).toThrow("Invalid library filter");
  expect(read.prepare("SELECT count(*) AS n FROM metric_jobs").get()?.n).toBe(0);
});
