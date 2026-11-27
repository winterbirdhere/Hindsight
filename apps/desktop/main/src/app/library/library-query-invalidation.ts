import type { DatabaseSync } from "node:sqlite";
import { projectStableMapEvidence } from "./library-source-binding";

export interface LibraryQueryInvalidationScope {
  readonly kind:string;
  readonly scopeId:string;
  readonly version:number;
  readonly metadata?:unknown;
}
export interface LibraryQueryInvalidationPage {
  readonly ids:readonly string[];
  readonly next?:string;
}
type Row=Record<string,unknown>;
type QueueTable="query_projection_scopes"|"map_cleanup_scopes"|"source_admission_scopes";
function queueTable(value:QueueTable):QueueTable {if(!["query_projection_scopes","map_cleanup_scopes","source_admission_scopes"].includes(value))throw Error("Invalid invalidation table");return value;}
const maxBytes=65536;
const maxKeyBytes=128*1024; // Store source keys allow 32,768 UTF-16 units, including multibyte names.
function text(value:unknown,label:string,empty=false,bytes=maxBytes):asserts value is string {
  if(typeof value!=="string"||!empty&&!value.length||Buffer.byteLength(value)>bytes)throw Error(`Invalid invalidation ${label}`);
}
function kind(value:string):void {if(!/^[a-z][a-z0-9-]{0,63}$/.test(value))throw Error("Invalid invalidation kind");}
function bound(limit:number):void {if(!Number.isInteger(limit)||limit<1||limit>256)throw Error("Invalid invalidation page limit");}
function synchronous(value:unknown):void {
  if(value!==null&&(typeof value==="object"||typeof value==="function")&&typeof (value as {then?:unknown}).then==="function")
    throw Error("Invalidation callbacks must be synchronous");
}

/** Durable scopes describe metadata work only. Enqueuing never visits replay rows.
 * An active pass keeps its cursor and metadata; later writes request a subsequent pass.
 * Callers own the committed query revision and readiness must include these scopes. */
export class LibraryQueryInvalidation {
  private expanding=false;
  constructor(private readonly db:DatabaseSync,private readonly table:QueueTable="query_projection_scopes"){queueTable(this.table);}
  static migrate(db:DatabaseSync,name:QueueTable="query_projection_scopes"):void {
    db.exec(`CREATE TABLE IF NOT EXISTS ${queueTable(name)}(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64 AND kind NOT GLOB '*[^a-z0-9-]*'),
      scope_id TEXT NOT NULL CHECK(length(CAST(scope_id AS BLOB)) BETWEEN 1 AND ${maxBytes}),
      desired_version INTEGER NOT NULL DEFAULT 1 CHECK(desired_version BETWEEN 1 AND 9007199254740991),
      pass_version INTEGER NOT NULL DEFAULT 0 CHECK(pass_version BETWEEN 0 AND desired_version),
      after_id TEXT NOT NULL DEFAULT '' CHECK(length(CAST(after_id AS BLOB))<=${maxKeyBytes}),
      desired_metadata TEXT CHECK(desired_metadata IS NULL OR json_valid(desired_metadata) AND length(CAST(desired_metadata AS BLOB))<=${maxBytes}),
      pass_metadata TEXT CHECK(pass_metadata IS NULL OR json_valid(pass_metadata) AND length(CAST(pass_metadata AS BLOB))<=${maxBytes}),
      UNIQUE(kind,scope_id));`);
  }
  /** Expressions are trusted, static SQL from schema triggers, never renderer input. */
  static enqueueSql(scopeKind:string,scopeIdExpression:string,metadataExpression="NULL",name:QueueTable="query_projection_scopes"):string {
    kind(scopeKind);
    return `INSERT INTO ${queueTable(name)}(kind,scope_id,desired_metadata)
      SELECT '${scopeKind}',${scopeIdExpression},${metadataExpression} WHERE true
      ON CONFLICT(kind,scope_id) DO UPDATE SET desired_version=desired_version+1,desired_metadata=excluded.desired_metadata`;
  }
  enqueue(scopeKind:string,scopeId:string,metadata?:unknown):void {
    kind(scopeKind);text(scopeId,"scope identity");
    const encoded=metadata===undefined?null:JSON.stringify(metadata);
    if(encoded===undefined||encoded!==null&&Buffer.byteLength(encoded)>maxBytes)throw Error("Invalid invalidation metadata");
    this.db.prepare(LibraryQueryInvalidation.enqueueSql(scopeKind,"?","?",this.table)).run(scopeId,encoded);
  }
  pendingCount():number {return Number(this.db.prepare(`SELECT count(*) AS count FROM ${this.table}`).get()?.count??0);}
  /** At most one scope page is selected. A map-key change may emit old and new IDs,
   * hence the output bound of twice limit. Empty semantic pages may still advance. */
  expandInTransaction(limit:number,
    selectPage:(scope:LibraryQueryInvalidationScope,after:string,limit:number)=>LibraryQueryInvalidationPage,
    markIds:(ids:readonly string[],scope:LibraryQueryInvalidationScope,page:LibraryQueryInvalidationPage)=>void):{processed:number;pending:number} {
    bound(limit);if(this.expanding)throw Error("Invalidation expansion cannot reenter");
    const first=this.db.prepare(`SELECT * FROM ${this.table} ORDER BY sequence LIMIT 1`).get();
    if(!first)return{processed:0,pending:0};
    this.expanding=true;this.db.exec("SAVEPOINT library_query_invalidation_page");
    try {
      let row=first;
      if(row.pass_version===0){
        this.db.prepare(`UPDATE ${this.table} SET pass_version=desired_version,pass_metadata=desired_metadata WHERE sequence=?`).run(row.sequence as number);
        const claimed=this.db.prepare(`SELECT * FROM ${this.table} WHERE sequence=?`).get(row.sequence as number);
        if(!claimed)throw Error("Invalidation pass disappeared");row=claimed;
      }
      const scope:LibraryQueryInvalidationScope={kind:String(row.kind),scopeId:String(row.scope_id),version:Number(row.pass_version),
        ...(row.pass_metadata===null?{}:{metadata:JSON.parse(String(row.pass_metadata)) as unknown})};
      const after=String(row.after_id),page=selectPage(scope,after,limit);synchronous(page);
      if(!page||!Array.isArray(page.ids)||page.ids.length>2*limit)throw Error("Invalid invalidation page");
      for(const id of page.ids)text(id,"page identity",false,maxKeyBytes);
      if(page.next!==undefined){text(page.next,"cursor",false,maxKeyBytes);if(Buffer.compare(Buffer.from(page.next),Buffer.from(after))<=0)throw Error("Invalid invalidation cursor advancement");}
      synchronous(markIds(page.ids,scope,page));
      const current=this.db.prepare(`SELECT * FROM ${this.table} WHERE sequence=?`).get(row.sequence as number);
      if(!current||current.pass_version!==row.pass_version||current.after_id!==row.after_id)throw Error("Invalidation page ownership changed");
      if(page.next!==undefined)this.db.prepare(`UPDATE ${this.table} SET after_id=? WHERE sequence=?`).run(page.next,row.sequence as number);
      else if(current.desired_version===current.pass_version)this.db.prepare(`DELETE FROM ${this.table} WHERE sequence=?`).run(row.sequence as number);
      else this.db.prepare(`UPDATE ${this.table} SET sequence=(SELECT max(sequence)+1 FROM ${this.table}),
        pass_version=0,pass_metadata=NULL,after_id='' WHERE sequence=?`).run(row.sequence as number);
      const pending=this.pendingCount();this.db.exec("RELEASE library_query_invalidation_page");
      return{processed:page.ids.length,pending};
    } catch(error) {
      this.db.exec("ROLLBACK TO library_query_invalidation_page;RELEASE library_query_invalidation_page");throw error;
    } finally {this.expanding=false;}
  }
}

export interface LibraryMapPublication { sourceId:string;oldGeneration:string|null;newGeneration:string|null }
export interface LibraryMapSemanticChange { md5:string;display:boolean;metrics:boolean;resources:boolean }
export interface LibraryMapSemanticPage extends LibraryQueryInvalidationPage {changes:LibraryMapSemanticChange[]}
function publication(value:unknown):LibraryMapPublication {
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid map publication");
  const row=value as Record<string,unknown>;
  try {
    text(row.sourceId,"map source");
    for(const key of ["oldGeneration","newGeneration"])if(row[key]!==null)text(row[key],"map generation");
  } catch {throw Error("Invalid map publication");}
  return row as unknown as LibraryMapPublication;
}
function display(row:Row):string {return JSON.stringify([row.title,row.artist,row.difficulty,row.mapper]);}
function metric(row:Row):string|undefined {
  return projectStableMapEvidence(String(row.md5),JSON.parse(String(row.metadata)) as Record<string,unknown>)?.inputKey;
}
/** Walk two generation indexes in bounded pages. Global database hashes, scan stamps,
 * and unused map metadata do not retire already indexed replay scalars. */
export function readLibraryMapSemanticPage(db:Pick<DatabaseSync,"prepare">,scope:LibraryQueryInvalidationScope,
  after:string,limit:number):LibraryMapSemanticPage {
  bound(limit);text(after,"map cursor",true,maxKeyBytes);const lease=publication(scope.metadata);
  const keys=new Set<string>();
  const keyPage=db.prepare("SELECT source_key FROM maps WHERE source_id=? AND generation=? AND source_key>? ORDER BY source_key LIMIT ?");
  for(const generation of [lease.oldGeneration,lease.newGeneration])if(generation!==null)
    for(const row of keyPage.all(lease.sourceId,generation,after,limit+1))keys.add(String(row.source_key));
  const ordered=[...keys].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),selected=ordered.slice(0,limit);
  const read=db.prepare(`SELECT md5,locator,state,metadata,
    coalesce(json_extract(metadata,'$.map.title'),json_extract(metadata,'$.title')) AS title,
    coalesce(json_extract(metadata,'$.map.artist'),json_extract(metadata,'$.artist')) AS artist,
    coalesce(json_extract(metadata,'$.map.difficulty'),json_extract(metadata,'$.difficultyName')) AS difficulty,
    coalesce(json_extract(metadata,'$.map.creator'),json_extract(metadata,'$.mapper')) AS mapper
    FROM maps WHERE source_id=? AND generation=? AND source_key=?`);
  const changed=new Map<string,LibraryMapSemanticChange>();
  for(const key of selected){
    const old=lease.oldGeneration===null?undefined:read.get(lease.sourceId,lease.oldGeneration,key);
    const current=lease.newGeneration===null?undefined:read.get(lease.sourceId,lease.newGeneration,key);
    const flags=old&&current&&old.md5===current.md5
      ?{display:display(old)!==display(current),metrics:metric(old)!==metric(current),resources:old.locator!==current.locator||old.state!==current.state}
      :{display:true,metrics:true,resources:true};
    if(!flags.display&&!flags.metrics&&!flags.resources)continue;
    for(const row of [old,current])if(row){
      const md5=String(row.md5);if(!/^[a-f\d]{32}$/.test(md5))throw Error("Invalid map publication identity");
      const prior=changed.get(md5);changed.set(md5,{md5,display:flags.display||!!prior?.display,metrics:flags.metrics||!!prior?.metrics,resources:flags.resources||!!prior?.resources});
    }
  }
  return{ids:[...changed.keys()],changes:[...changed.values()],...(ordered.length>limit?{next:selected[selected.length-1]}:{})};
}
