import type { DatabaseSync } from "node:sqlite";

export type LibraryQueryReadiness="settled"|"live-source"|"updating";
type ReadDatabase=Pick<DatabaseSync,"prepare">;

/** Inspect committed queues each time: direct queue writes need not advance a revision.
 * Identity/algorithm repair is independently qualified by the scalar reader. */
export function libraryQueryReadiness(db:ReadDatabase):LibraryQueryReadiness {
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('query_projection_dirty','query_projection_scopes')").all().map(row=>String(row.name)));
  const dirty=tables.has("query_projection_dirty")&&!!db.prepare("SELECT 1 FROM query_projection_dirty LIMIT 1").get();
  const scopes=tables.has("query_projection_scopes")&&!!db.prepare("SELECT 1 FROM query_projection_scopes LIMIT 1").get();
  if(!dirty&&!scopes)return "settled";
  if(![24,25,26,27].includes(Number(db.prepare("PRAGMA user_version").get()?.user_version))||tables.size!==2)return "updating";
  const required:Record<string,string[]>={query_projection:["visible","source_mask","c_identity","analysis_algorithm","analysis_without_c"],
    query_projection_dirty:["flags"],query_projection_scopes:["kind"],sources:["id","kind","enabled","configured","config_revision"],locations:["replay_id","source_id","source_key","sha256","available"],
    incident_recipes:["replay_id","source_id","source_key","source_config_revision","source_epoch","location_epoch","scope","evidence"],
    incident_source_epochs:["source_id","epoch"],incident_location_epochs:["source_id","source_key","epoch"],query_analysis_algorithm_state:["id","complete"]};
  for(const [table,columns] of Object.entries(required)){
    const actual=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>String(row.name)));
    if(columns.some(column=>!actual.has(column)))return "updating";
  }
  if(db.prepare("SELECT 1 FROM query_projection_scopes WHERE kind NOT IN ('source-visibility','c-source') OR kind IS NULL LIMIT 1").get()||
    db.prepare("SELECT 1 FROM query_projection_dirty WHERE typeof(flags)<>'integer' OR flags=0 OR (flags & ~10)<>0 LIMIT 1").get())return "updating";
  return "live-source";
}

/** These expressions use canonical locations, not cached projection affiliation. */
export function libraryLiveSourceExistsSql(replayId:string,condition="1"):string {
  return `EXISTS(SELECT 1 FROM locations live_location JOIN sources live_source ON live_source.id=live_location.source_id
    WHERE live_location.replay_id=${replayId} AND live_source.enabled=1 AND live_source.configured=1 AND (${condition}))`;
}
export function libraryLiveIncidentSourceSql(replayId:string):string {
  return `EXISTS(SELECT 1 FROM incident_recipes live_receipt JOIN sources live_source ON live_source.id=live_receipt.source_id
    WHERE live_receipt.replay_id=${replayId} AND live_source.enabled=1 AND live_source.configured=1)`;
}
