import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LibraryQueryInvalidation, LibraryQueryInvalidationScope, readLibraryMapSemanticPage } from "./library-query-invalidation";

let db:DatabaseSync,queue:LibraryQueryInvalidation;
const roots:string[]=[];
function open(path=":memory:") {
  db=new DatabaseSync(path);LibraryQueryInvalidation.migrate(db);queue=new LibraryQueryInvalidation(db);
  db.exec("CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY);CREATE TABLE IF NOT EXISTS marked(id TEXT PRIMARY KEY,version INTEGER)");
}
function seed(...ids:string[]){for(const id of ids)db.prepare("INSERT INTO items VALUES(?)").run(id);}
function page(_scope:LibraryQueryInvalidationScope,after:string,limit:number) {
  const rows=db.prepare("SELECT id FROM items WHERE id>? ORDER BY id LIMIT ?").all(after,limit+1);
  const ids=rows.slice(0,limit).map(row=>String(row.id));
  return{ids,...(rows.length>limit?{next:ids[ids.length-1]}:{})};
}
function mark(ids:readonly string[],scope:LibraryQueryInvalidationScope) {
  for(const id of ids)db.prepare("INSERT INTO marked VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version").run(id,scope.version);
}
beforeEach(()=>open());
afterEach(()=>{db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it("keeps admission cursors independent from query readiness scopes",()=>{
  LibraryQueryInvalidation.migrate(db,"source_admission_scopes");
  const admission=new LibraryQueryInvalidation(db,"source_admission_scopes");seed("a","b");admission.enqueue("source","one");
  expect(queue.pendingCount()).toBe(0);expect(admission.expandInTransaction(1,page,mark)).toEqual({processed:1,pending:1});
  admission.enqueue("source","one");
  while(admission.pendingCount())admission.expandInTransaction(1,page,mark);
  expect(queue.pendingCount()).toBe(0);expect(db.prepare("SELECT * FROM marked ORDER BY id").all()).toEqual([{id:"a",version:2},{id:"b",version:2}]);
});

it("records constant-size scopes without expanding source rows and advances only one bounded page",()=>{
  seed("a","b","c","d");queue.enqueue("source","stable");
  expect(queue.pendingCount()).toBe(1);expect(db.prepare("SELECT * FROM marked").all()).toEqual([]);
  expect(queue.expandInTransaction(2,page,mark)).toEqual({processed:2,pending:1});
  expect(db.prepare("SELECT id FROM marked ORDER BY id").all().map(row=>row.id)).toEqual(["a","b"]);
  expect(queue.expandInTransaction(2,page,mark)).toEqual({processed:2,pending:0});
});
it("retains cursor and immutable pass metadata across repeated changes and revisits IDs behind it",()=>{
  seed("a","b","c");queue.enqueue("source","stable",{epoch:1});
  const seen:Array<[string,number,unknown]>=[];
  const record=(ids:readonly string[],scope:LibraryQueryInvalidationScope)=>{mark(ids,scope);seen.push(...ids.map(id=>[id,scope.version,scope.metadata] as [string,number,unknown]));};
  queue.expandInTransaction(1,page,record);
  queue.enqueue("source","stable",{epoch:2});queue.enqueue("source","stable",{epoch:3});
  queue.expandInTransaction(1,page,record);queue.expandInTransaction(1,page,record);
  expect(seen).toEqual([["a",1,{epoch:1}],["b",1,{epoch:1}],["c",1,{epoch:1}]]);
  expect(queue.pendingCount()).toBe(1);
  while(queue.pendingCount())queue.expandInTransaction(1,page,record);
  expect(seen.slice(3)).toEqual([["a",3,{epoch:3}],["b",3,{epoch:3}],["c",3,{epoch:3}]]);
});
it("resumes before expansion and after a committed cursor page on restart",()=>{
  const root=mkdtempSync(join(tmpdir(),"rewind-query-scope-"));roots.push(root);const path=join(root,"index.sqlite");
  db.close();open(path);seed("a","b","c");queue.enqueue("source","stable");db.close();open(path);
  expect(queue.pendingCount()).toBe(1);queue.expandInTransaction(1,page,mark);db.close();open(path);
  const visited:string[]=[];queue.expandInTransaction(1,page,(ids,scope)=>{visited.push(...ids);mark(ids,scope);});
  expect(visited).toEqual(["b"]);expect(queue.pendingCount()).toBe(1);
  queue.expandInTransaction(1,page,mark);expect(queue.pendingCount()).toBe(0);
});
it("atomically rolls back marks and cursor when a page fails, inside an outer transaction too",()=>{
  seed("a","b");queue.enqueue("source","stable");db.exec("BEGIN IMMEDIATE;INSERT INTO items VALUES('c')");
  expect(()=>queue.expandInTransaction(1,page,(ids,scope)=>{mark(ids,scope);throw Error("mark failed");})).toThrow("mark failed");
  expect(db.prepare("SELECT id FROM marked").all()).toEqual([]);
  expect(db.prepare("SELECT id FROM items WHERE id='c'").get()).toBeDefined();
  queue.expandInTransaction(1,page,mark);expect(db.prepare("SELECT id FROM marked").all().map(row=>row.id)).toEqual(["a"]);
  db.exec("ROLLBACK");expect(db.prepare("SELECT id FROM marked").all()).toEqual([]);
  queue.expandInTransaction(1,page,mark);expect(db.prepare("SELECT id FROM marked").all().map(row=>row.id)).toEqual(["a"]);
});
it("rolls back the claimed pass when page selection fails",()=>{
  queue.enqueue("source","stable",{epoch:1});
  expect(()=>queue.expandInTransaction(1,()=>{throw Error("select failed");},mark)).toThrow("select failed");
  queue.enqueue("source","stable",{epoch:2});
  const scopes:LibraryQueryInvalidationScope[]=[];
  queue.expandInTransaction(1,scope=>{scopes.push(scope);return{ids:[]};},mark);
  expect(scopes).toMatchObject([{version:2,metadata:{epoch:2}}]);
});
it("does not lose an enqueue raised during the final marking callback",()=>{
  seed("a");queue.enqueue("source","stable");
  queue.expandInTransaction(1,page,(ids,scope)=>{mark(ids,scope);queue.enqueue("source","stable");});
  expect(queue.pendingCount()).toBe(1);queue.expandInTransaction(1,page,mark);
  expect(db.prepare("SELECT version FROM marked").get()?.version).toBe(2);expect(queue.pendingCount()).toBe(0);
});
it("gives other queued scopes a turn before a follow-up pass",()=>{
  seed("a","b");queue.enqueue("source","first");queue.expandInTransaction(1,page,mark);
  queue.enqueue("source","first");queue.enqueue("source","second");queue.expandInTransaction(1,page,mark);
  const keys:string[]=[];queue.expandInTransaction(1,(scope,after,limit)=>{keys.push(scope.scopeId);return page(scope,after,limit);},mark);
  expect(keys).toEqual(["second"]);
});
it("allows empty semantic-diff pages with a durable advancing cursor",()=>{
  queue.enqueue("map-generation","publication",{from:"g1",to:"g2"});
  const cursors:string[]=[];
  const select=(_scope:LibraryQueryInvalidationScope,after:string)=>{cursors.push(after);return after===""?{ids:[],next:"map-10"}:{ids:["changed-md5"]};};
  expect(queue.expandInTransaction(8,select,mark)).toEqual({processed:0,pending:1});
  expect(queue.expandInTransaction(8,select,mark)).toEqual({processed:1,pending:0});expect(cursors).toEqual(["","map-10"]);
});
it("keeps separate generation publications and their metadata",()=>{
  queue.enqueue("map-generation","s:g1:g2",{sourceId:"s",from:"g1",to:"g2"});
  queue.enqueue("map-generation","s:g2:g3",{sourceId:"s",from:"g2",to:"g3"});
  const pairs:unknown[]=[];while(queue.pendingCount())queue.expandInTransaction(1,scope=>{pairs.push(scope.metadata);return{ids:[]};},mark);
  expect(pairs).toEqual([{sourceId:"s",from:"g1",to:"g2"},{sourceId:"s",from:"g2",to:"g3"}]);
});
it("provides trigger-safe bounded enqueue SQL even under an outer upsert",()=>{
  db.exec(`CREATE TABLE events(id TEXT PRIMARY KEY,value INTEGER);CREATE TRIGGER event_scope AFTER UPDATE ON events BEGIN ${LibraryQueryInvalidation.enqueueSql("source","NEW.id","json_object('value',NEW.value)")}; END;`);
  db.exec("INSERT INTO events VALUES('stable',1);INSERT INTO events VALUES('stable',2) ON CONFLICT(id) DO UPDATE SET value=excluded.value;INSERT INTO events VALUES('stable',3) ON CONFLICT(id) DO UPDATE SET value=excluded.value");
  expect(queue.pendingCount()).toBe(1);const scopes:LibraryQueryInvalidationScope[]=[];
  queue.expandInTransaction(1,scope=>{scopes.push(scope);return{ids:[]};},mark);
  expect(scopes).toMatchObject([{kind:"source",scopeId:"stable",version:2,metadata:{value:3}}]);
});
it.each([0,-1,257,1.5,NaN])("rejects invalid page bound %s without taking a pass",limit=>{
  queue.enqueue("source","stable");expect(()=>queue.expandInTransaction(limit,page,mark)).toThrow(/limit/i);expect(queue.pendingCount()).toBe(1);
});
it("rejects oversized or nonadvancing pages and asynchronous callbacks without leaving marks",()=>{
  queue.enqueue("source","stable");
  expect(()=>queue.expandInTransaction(1,()=>({ids:["a","b","c"]}),mark)).toThrow(/page/i);
  expect(()=>queue.expandInTransaction(1,()=>({ids:[],next:""}),mark)).toThrow(/cursor/i);
  expect(()=>queue.expandInTransaction(1,()=>({ids:["a"]}),(()=>Promise.resolve()) as unknown as typeof mark)).toThrow(/synchronous/i);
  expect(queue.pendingCount()).toBe(1);expect(db.prepare("SELECT * FROM marked").all()).toEqual([]);
});
it("bounds scope identifiers and metadata before persisting",()=>{
  expect(()=>queue.enqueue("not a kind","s")).toThrow();expect(()=>queue.enqueue("source","")).toThrow();
  expect(()=>queue.enqueue("source","s",{text:"x".repeat(65536)})).toThrow();
  expect(()=>LibraryQueryInvalidation.enqueueSql("source'; SELECT 1;--","'s'")).toThrow();
  expect(queue.pendingCount()).toBe(0);
});
it("keeps readiness reads read-only and has no callback work when empty",()=>{
  db.exec("PRAGMA query_only=ON");expect(queue.pendingCount()).toBe(0);db.exec("PRAGMA query_only=OFF");
  const select=jest.fn(page),apply=jest.fn(mark);expect(queue.expandInTransaction(1,select,apply)).toEqual({processed:0,pending:0});
  expect(select).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
});

describe("semantic map generation pages",()=>{
  const md5="a".repeat(32),other="b".repeat(32);
  const metadata=(title="Title")=>({map:{md5,title,artist:"Artist",difficulty:"Difficulty",creator:"Mapper",databaseVersion:20200101,mode:0,rankedStatus:4,drainTimeSeconds:120},cachedNoModStars:4,cachedTempo:{min:120,max:120},databaseSha256:"old-db"});
  const scope:LibraryQueryInvalidationScope={kind:"map-publication",scopeId:"source:g1:g2",version:1,metadata:{sourceId:"source",oldGeneration:"g1",newGeneration:"g2"}};
  function insert(generation:string,key:string,meta:unknown=metadata(),hash=md5,locator="map.osu"){
    db.prepare("INSERT INTO maps VALUES('source',?,?,?,?, 'unverified',?)").run(generation,key,hash,locator,JSON.stringify(meta));
  }
  beforeEach(()=>db.exec("CREATE TABLE maps(source_id TEXT,generation TEXT,source_key TEXT,md5 TEXT,locator TEXT,state TEXT,metadata TEXT,PRIMARY KEY(source_id,generation,source_key))"));
  it("ignores whole-database hashes and consumes only a bounded page of unchanged map keys",()=>{
    for(const key of ["a","b","c"]){insert("g1",key);insert("g2",key,{...metadata(),databaseSha256:"new-db",unconsumed:"changed"});}
    expect(readLibraryMapSemanticPage(db,scope,"",2)).toEqual({ids:[],changes:[],next:"b"});
    expect(readLibraryMapSemanticPage(db,scope,"b",2)).toEqual({ids:[],changes:[]});
  });
  it("distinguishes display, source metric and resource changes and coalesces duplicate MD5s",()=>{
    insert("g1","a");insert("g2","a",metadata("New title"));
    insert("g1","b");insert("g2","b",{...metadata(),cachedNoModStars:5});
    insert("g1","c");insert("g2","c",metadata(),md5,"moved.osu");
    expect(readLibraryMapSemanticPage(db,scope,"",3)).toEqual({ids:[md5],changes:[{md5,display:true,metrics:true,resources:true}]});
  });
  it("includes old and new identities for removed, added and rebound map keys",()=>{
    insert("g1","a");insert("g2","a",{...metadata(),map:{...metadata().map,md5:other}},other);
    const result=readLibraryMapSemanticPage(db,scope,"",1);
    expect(result.ids).toEqual([md5,other]);expect(result.changes).toEqual([
      {md5,display:true,metrics:true,resources:true},{md5:other,display:true,metrics:true,resources:true}]);
    db.exec("DELETE FROM maps WHERE generation='g2'");expect(readLibraryMapSemanticPage(db,scope,"",1).ids).toEqual([md5]);
    expect(readLibraryMapSemanticPage(db,{...scope,metadata:{sourceId:"source",oldGeneration:null,newGeneration:"g1"}},"",1).ids).toEqual([md5]);
  });
  it("preserves absent versus empty display fields because native fallbacks differ",()=>{
    const original=metadata();delete (original.map as Partial<typeof original.map>).title;
    insert("g1","a",original);insert("g2","a",metadata(""));
    expect(readLibraryMapSemanticPage(db,scope,"",1).changes).toEqual([{md5,display:true,metrics:false,resources:false}]);
  });
  it("orders bounded keysets with SQLite binary text order and rejects malformed publication leases",()=>{
    for(const key of ["a","z","\uE000","😀"]){insert("g1",key);insert("g2",key,metadata("changed"));}
    expect(readLibraryMapSemanticPage(db,scope,"",2).next).toBe("z");
    expect(readLibraryMapSemanticPage(db,scope,"z",1).next).toBe("\uE000");
    expect(()=>readLibraryMapSemanticPage(db,{...scope,metadata:{sourceId:"source",oldGeneration:4,newGeneration:"g2"}},"",1)).toThrow(/publication/i);
  });
});
