import type { DatabaseSync } from "node:sqlite";
import { LIBRARY_SORTS } from "../../../../shared/library-query";
import { LibraryQueryInvalidation, LibraryQueryInvalidationPage, LibraryQueryInvalidationScope, readLibraryMapSemanticPage } from "./library-query-invalidation";
import { LIBRARY_INCIDENT_QUERY_REVISION } from "./library-incidents-target";
import type { LibraryMetricTargetInput } from "../../../../shared/replay-library-metrics";
import { LIBRARY_QUERY_ALGORITHM_SOURCE_REVISION } from "../../../../shared/library-incident-semantic-revision";
import { libraryKnownNonstandardSql, libraryRecordedCompletionSql, libraryRecordingClientSql } from "./library-recorded-evidence";

const slots = { h: "source-score", m: "source-map", p: "calculated-map", a: "aggregate-pp", n: "numerical", t: "timeline-pp", f: "fc-pp" };
const scalar = (slot: string, key: string) => `CASE WHEN json_extract(${slot},'$.fields.${key}.state')='known' THEN json_extract(${slot},'$.fields.${key}.value') END`;
const number = (slot: string, key: string) => `CASE WHEN json_type(${slot},'$.fields.${key}.value') IN ('integer','real') THEN ${scalar(slot, key)} END`;
export const libraryCompleteBreakEvidenceSql = (slot:string):string => `(json_extract(${slot},'$.provenance.completeBreakEvidence')=1 AND ${number(slot,"comboLosses")}>=0 AND
  (json_extract(${slot},'$.provenance.ruleset') IN ('lazer','lazer-classic') OR ${number(slot,"sliderBreaks")}>=0))`;
export const libraryRecordedFullComboSql = (h:string,n:string):string => `CASE WHEN ${libraryRecordedCompletionSql(h,n)}='passed'
  AND ${coalesce(number(h,"misses"),number(n,"misses"))}>=0 AND ${libraryCompleteBreakEvidenceSql(n)}
  THEN ${coalesce(number(h,"misses"),number(n,"misses"))}=0 AND ${number(n,"comboLosses")}=0
    AND (json_extract(${n},'$.provenance.ruleset') IN ('lazer','lazer-classic') OR ${number(n,"sliderBreaks")}=0) END`;
export const libraryRecordedPerfectComboSql = (h:string,p:string):string => `CASE WHEN ${number(h,"maxCombo")}>=0 AND ${number(p,"exactMapMaxCombo")}>0 THEN ${number(h,"maxCombo")}=${number(p,"exactMapMaxCombo")} END`;
const registeredPlayerFolds=new WeakSet<object>();
/** Connection-local pure function; registration neither writes SQLite nor admits work. */
export function registerLibraryPlayerFold(db:Pick<DatabaseSync,"prepare">):void {
  const full=db as DatabaseSync;
  if(typeof full.function!=="function"||registeredPlayerFolds.has(db))return;
  full.function("library_player_fold",{deterministic:true},value=>typeof value==="string"?value.toLowerCase():null);
  registeredPlayerFolds.add(db);
}
export const LIBRARY_FILTER_EVIDENCE_REVISION="recorded-filter-evidence-v2";
/** Names remain exactly as recorded. Native account metadata is a fallback, not
 * a replacement for a retained replay/saved-score header's nonempty text name. */
export function libraryRecordedPlayerSql(metadata:string):string {
  return `coalesce(${["header.player","savedScore.header.player","nativeScore.player"].map(path=>
    `CASE WHEN json_type(${metadata},'$.${path}')='text' THEN nullif(json_extract(${metadata},'$.${path}'),'') END`).join(",")})`;
}
const coalesce = (...values: string[]) => `coalesce(${values.join(",")})`;
const legacyMods: [string, number][] = [["NF",1],["EZ",2],["TD",4],["HD",8],["HR",16],["SD",32],["DT",64],["RX",128],["HT",256],["NC",512],["FL",1024],["AT",2048],["SO",4096],["AP",8192],["PF",16384],["4K",32768],["5K",65536],["6K",131072],["7K",262144],["8K",524288],["FI",1048576],["RD",2097152],["CN",4194304],["TP",8388608],["9K",16777216],["CO",33554432],["1K",67108864],["3K",134217728],["2K",268435456],["V2",536870912],["MR",1073741824]];
const modTable = legacyMods.map(([mod,bit]) => `SELECT '${mod}' AS mod,${bit} AS bit`).join(" UNION ALL ");
// Only current scalar target/results participate. No replay frames, strip payload, cause data,
// admission API, filesystem or worker is available to this read-only adapter.
export const libraryQueryLegacyCte = `WITH current_metrics AS (
  SELECT t.replay_id,${Object.entries(slots).map(([alias,slot]) => `max(CASE WHEN t.slot='${slot}' THEN r.payload END) AS ${alias}`).join(",")}
  FROM metric_targets t JOIN metric_results r ON r.replay_id=t.replay_id AND r.slot=t.slot AND r.stage=t.stage
    AND r.input_key=t.input_key AND r.producer_version=t.producer_version AND t.slot<>'incidents' GROUP BY t.replay_id
), indexed AS (
  SELECT r.*,cm.h,cm.m,cm.p,cm.a,cm.n,cm.t,cm.f,
    coalesce(json_extract(r.metadata,'$.header'),json_extract(r.metadata,'$.savedScore.header'),'{}') AS header,
    (SELECT m.metadata FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation
      JOIN sources s ON s.id=m.source_id AND s.enabled=1 AND s.configured=1
      WHERE m.md5=coalesce(json_extract(r.metadata,'$.nativeScore.beatmap.md5'),json_extract(r.metadata,'$.header.beatmapMD5'),json_extract(r.metadata,'$.savedScore.header.beatmapMD5'))
      ORDER BY m.source_id,m.source_key LIMIT 1) AS map_metadata,
    coalesce((SELECT state FROM review_edits e WHERE e.replay_id=r.id ORDER BY sequence DESC LIMIT 1),'not-reviewed') AS review,
    (SELECT json_group_array(kind) FROM (SELECT DISTINCT s.kind FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=r.id AND s.enabled=1 AND s.configured=1 ORDER BY s.kind)) AS source_kinds,
    (SELECT json_group_array(collection_id) FROM (SELECT DISTINCT collection_id FROM memberships x JOIN collections k ON k.id=x.collection_id WHERE x.replay_id=r.id ORDER BY collection_id LIMIT 16)) AS collection_ids,
    (SELECT count(DISTINCT collection_id) FROM memberships x JOIN collections k ON k.id=x.collection_id WHERE x.replay_id=r.id) AS collection_count,
    coalesce(json_extract(r.metadata,'$.nativeScore.beatmap.md5'),json_extract(r.metadata,'$.header.beatmapMD5'),json_extract(r.metadata,'$.savedScore.header.beatmapMD5')) AS map_identity,
    EXISTS(SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=r.id AND s.enabled=1 AND s.configured=1 AND l.available=1) AS available
  FROM replays r LEFT JOIN current_metrics cm ON cm.replay_id=r.id WHERE r.merged_into IS NULL
    AND EXISTS(SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=r.id AND s.enabled=1 AND s.configured=1)
), extracted AS (
  SELECT indexed.*,
    nullif(coalesce(json_extract(map_metadata,'$.map.title'),json_extract(map_metadata,'$.title'),json_extract(metadata,'$.nativeScore.mapMetadata.title')),'') AS title,
    nullif(coalesce(json_extract(map_metadata,'$.map.artist'),json_extract(map_metadata,'$.artist'),json_extract(metadata,'$.nativeScore.mapMetadata.artist')),'') AS artist,
    nullif(coalesce(json_extract(map_metadata,'$.map.difficulty'),json_extract(map_metadata,'$.difficultyName'),json_extract(metadata,'$.nativeScore.mapMetadata.difficultyName')),'') AS difficulty,
    nullif(coalesce(json_extract(map_metadata,'$.map.creator'),json_extract(map_metadata,'$.mapper'),json_extract(metadata,'$.nativeScore.mapMetadata.mapper')),'') AS mapper,
    ${libraryRecordedPlayerSql("metadata")} AS player,
    ${libraryRecordingClientSql("indexed.id","indexed.metadata")} AS recording_client,
    ${libraryKnownNonstandardSql("indexed.id","indexed.metadata")} AS standard_excluded,
    ${libraryRecordedCompletionSql("h","n")} AS recorded_completion,
    library_player_fold(${libraryRecordedPlayerSql("metadata")}) AS player_folded,
    CASE WHEN ${libraryCompleteBreakEvidenceSql("n")} THEN 1 ELSE 0 END AS break_evidence,
    '${LIBRARY_FILTER_EVIDENCE_REVISION}' AS filter_evidence_revision,
    ${coalesce(scalar("n","completion"),scalar("h","completion"))} AS completion,
    ${coalesce(number("h","accuracy"),number("n","accuracy"))}*100 AS acc,
    ${coalesce(number("h","maxCombo"),number("n","maxCombo"))} AS combo,
    ${coalesce(number("h","misses"),number("n","misses"))} AS miss,
    ${number("n","ur")} AS ur,${number("n","biasMs")} AS bias,${number("n","sliderBreaks")} AS slider_breaks,
    ${libraryRecordedFullComboSql("h","n")} AS full_combo,
    ${libraryRecordedPerfectComboSql("h","p")} AS perfect_combo,
    NULL AS incidents,${scalar("m","mapStatus")} AS status,
    ${coalesce(number("p","mapStars"),number("m","sourceMapStars"))} AS map_stars,
    ${number("t","peakPp")} AS peak,
    CASE WHEN CAST(coalesce(json_extract(metadata,'$.nativeScore.playedAtTicks'),json_extract(header,'$.playedAtTicks')) AS INTEGER)>0
      THEN (CAST(coalesce(json_extract(metadata,'$.nativeScore.playedAtTicks'),json_extract(header,'$.playedAtTicks')) AS INTEGER)-621355968000000000)/10000 END AS date,
    CASE WHEN json_type(metadata,'$.nativeScore.mods')='array' THEN
      CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(metadata,'$.nativeScore.mods') WHERE type NOT IN ('text','object') OR (type='object' AND json_type(value,'$.acronym') IS NOT 'text'))
        THEN (SELECT json_group_array(mod) FROM (SELECT DISTINCT CASE WHEN type='text' THEN value ELSE json_extract(value,'$.acronym') END AS mod FROM json_each(metadata,'$.nativeScore.mods') ORDER BY mod)) END
      WHEN json_type(metadata,'$.nativeScore')='object' OR coalesce(json_extract(header,'$.nativeScoreInfo'),0)=1 OR coalesce(json_extract(header,'$.version'),0)>=30000000 THEN NULL
      WHEN json_type(header,'$.modsBitmask')='integer' AND json_extract(header,'$.modsBitmask') BETWEEN 0 AND 2147483647 THEN
        (SELECT json_group_array(mod) FROM (${modTable}) WHERE (json_extract(header,'$.modsBitmask') & bit)<>0
          AND NOT (mod='DT' AND (json_extract(header,'$.modsBitmask') & 512)<>0) AND NOT (mod='SD' AND (json_extract(header,'$.modsBitmask') & 16384)<>0)) END AS mods
  FROM indexed
), jobs AS (
  SELECT j.replay_id,j.state,j.error FROM metric_jobs j JOIN metric_targets t ON t.replay_id=j.replay_id AND t.slot=j.slot
    AND t.stage=j.stage AND t.input_key=j.input_key AND t.producer_version=j.producer_version AND t.generation=j.generation WHERE j.stage='S'
  UNION ALL SELECT replay_id,state,error FROM analysis_requests WHERE stage='S' AND state IN ('queued','running','failed')
), projected AS (
  SELECT extracted.*,
    CASE WHEN completion='failed' THEN NULL ELSE ${coalesce(number("a","pp"),number("t","pp"),`CASE WHEN completion='passed' THEN ${number("h","sourcePp")} END`)} END AS pp,
    CASE WHEN completion='failed' THEN NULL ELSE ${number("f","ppIfFc")} END AS fc,
    CASE WHEN completion='failed' THEN 'F' ELSE ${scalar("h","grade")} END AS grade,
    ${coalesce(number("p","replayStars"),`CASE WHEN mods='[]' THEN ${number("m","sourceMapStars")} END`)} AS sr,
    ${coalesce(number("p","bpm"),`CASE WHEN mods='[]' THEN ${number("m","cachedBpm")} END`)} AS bpm,
    ${coalesce(number("p","lengthMs"),`CASE WHEN mods='[]' THEN ${number("m","drainLengthMs")} END`)} / 1000.0 AS len,
    CASE WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.replay_id=extracted.id AND j.state IN ('queued','running')) THEN
      CASE WHEN coalesce((SELECT json_extract(value,'$.userPaused') FROM settings WHERE key='analysis'),0)=1 THEN 'paused'
        WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.replay_id=extracted.id AND j.state='running') THEN 'analysing' ELSE 'queued' END
      WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.replay_id=extracted.id AND j.state='failed') THEN 'failed'
      WHEN n IS NOT NULL THEN 'analysed' ELSE 'none' END AS analysis,
    (SELECT error FROM jobs j WHERE j.replay_id=extracted.id AND j.state='failed' AND j.error IS NOT NULL ORDER BY error LIMIT 1) AS analysis_error
  FROM extracted WHERE standard_excluded=0
)`;

export const LIBRARY_QUERY_PROJECTION_COLUMNS=`id,title,artist,difficulty,mapper,player,mods,grade,status,completion,recorded_completion,recording_client,standard_excluded,player_folded,break_evidence,filter_evidence_revision,full_combo,perfect_combo,
  favourite,review,baseline,added_session,source_kinds,collection_ids,collection_count,analysis,analysis_error,available,
  pp,peak,fc,acc,combo,miss,ur,sr,map_stars,bpm,len,date,bias,incidents,slider_breaks,map_identity`;

const projectionColumns=LIBRARY_QUERY_PROJECTION_COLUMNS.split(",").map(value=>value.trim());
const texts=new Set(["id","title","artist","difficulty","mapper","player","mods","grade","status","completion","recorded_completion","recording_client","player_folded","filter_evidence_revision","review","added_session","source_kinds","collection_ids","analysis","analysis_error","map_identity"]);
const aggregateVisibilityKey="independent-performance-visibility-v2";
interface AggregateVisibilityState {after_id:string;complete:0|1;verified:number}

/** Keep this scalar-read qualification aligned with LibraryIncidentRecipeStore.fresh().
 * The compact receipt and source/location epochs are metadata, never a cause graph. */
export function libraryIncidentQueryFreshnessSql(replayId:string):string {
  return `EXISTS(SELECT 1 FROM incident_recipes i JOIN sources s ON s.id=i.source_id
    JOIN locations l ON l.source_id=i.source_id AND l.source_key=i.source_key
    WHERE i.replay_id=${replayId} AND l.replay_id=i.replay_id AND l.sha256=json_extract(i.evidence,'$.replaySha256')
    AND s.config_revision=i.source_config_revision AND (i.scope='unsupported-profile' OR i.scope='stable-sidecar'
    AND i.source_epoch=coalesce((SELECT epoch FROM incident_source_epochs WHERE source_id=i.source_id),0)
    AND i.location_epoch=coalesce((SELECT epoch FROM incident_location_epochs WHERE source_id=i.source_id AND source_key=i.source_key),0)))`;
}

/** Only S results, jobs and preparation requests describe library analysis state. */
export function libraryQueryAnalysisSql(replayId:string,_includeC:boolean):{state:string;error:string} {
  void _includeC; // Compatibility argument; retired C never contributes to library status.
  const jobs=`SELECT j.state,j.error FROM metric_jobs j JOIN metric_targets t ON t.replay_id=j.replay_id AND t.slot=j.slot
    AND t.stage=j.stage AND t.input_key=j.input_key AND t.producer_version=j.producer_version AND t.generation=j.generation
    WHERE j.replay_id=${replayId} AND j.stage='S'
    UNION ALL SELECT state,error FROM analysis_requests WHERE replay_id=${replayId} AND stage='S' AND state IN ('queued','running','failed')`;
  const has=(states:string)=>`EXISTS(SELECT 1 FROM (${jobs}) WHERE state IN (${states}))`;
  const result=`EXISTS(SELECT 1 FROM metric_targets t JOIN metric_results r ON r.replay_id=t.replay_id AND r.slot=t.slot AND r.stage=t.stage
    AND r.input_key=t.input_key AND r.producer_version=t.producer_version WHERE t.replay_id=${replayId}
    AND t.slot='numerical')`;
  return{state:`CASE WHEN ${has("'queued','running'")} THEN CASE WHEN ${has("'running'")} THEN 'analysing' ELSE 'queued' END
    WHEN ${has("'failed'")} THEN 'failed' WHEN ${result} THEN 'analysed' ELSE 'none' END`,
    error:`(SELECT error FROM (${jobs}) WHERE state='failed' AND error IS NOT NULL ORDER BY error LIMIT 1)`};
}

/** Independent from C target identity: changing derived status logic never admits analysis. */
export const LIBRARY_QUERY_ALGORITHM_REVISION=LIBRARY_QUERY_ALGORITHM_SOURCE_REVISION;
export const libraryQueryAnalysisCurrentSql=(alias:string):string=>`${alias}.analysis_algorithm='${LIBRARY_QUERY_ALGORITHM_REVISION}'`;
export const libraryQueryAnalysisFallbackMissingSql=(alias:string):string=>`(coalesce(${libraryQueryAnalysisCurrentSql(alias)},0)=0 OR ${alias}.analysis_without_c IS NULL)`;
export const libraryQueryAnalysisPendingSql=():string=>`(EXISTS(SELECT 1 FROM query_analysis_algorithm_state WHERE id=1 AND complete=0)
  OR EXISTS(SELECT 1 FROM query_projection INDEXED BY query_c_fallback_pending WHERE analysis_without_c IS NULL LIMIT 1))`;

/** Write-side cache of already indexed scalars. Reads never repair or populate this table.
 * Triggers collect exact affected identities; the Store flushes bounded batches before commit
 * and schedules remaining batches independently of reader demand. No replay/source I/O exists. */
export class LibraryQueryProjection {
  private readonly accelerated:boolean;
  private readonly invalidation?:LibraryQueryInvalidation;
  private readonly identity:boolean;
  private readonly algorithm:boolean;
  private readonly filterEvidence:boolean;
  constructor(private readonly db:DatabaseSync,private readonly options:{onMapReplay?:(id:string)=>void;onSourceReplay?:(id:string)=>void;onVisibilityReplay?:(id:string)=>void;onPerformanceReplay?:(id:string)=>void;currentIncidentTarget?:(id:string)=>LibraryMetricTargetInput|undefined}={}){
    registerLibraryPlayerFold(db);
    this.invalidation=db.prepare("SELECT 1 FROM sqlite_master WHERE name='query_projection_scopes'").get()?new LibraryQueryInvalidation(db):undefined;
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS query_projection_work(id TEXT PRIMARY KEY${this.invalidation?",flags INTEGER NOT NULL":""})`);
    const columns=new Set(db.prepare("PRAGMA table_info(query_projection)").all().map(row=>String(row.name)));
    this.accelerated=columns.has("search_text");
    this.identity=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='query_c_identity_state'").get();
    this.algorithm=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='query_analysis_algorithm_state'").get();
    this.filterEvidence=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='query_filter_evidence_state'").get();
    if(this.filterEvidence){
      // Enrol completed v1 projections without dirtying metrics or synchronously
      // rewriting their population. The same eight-row evidence repair resumes.
      const predicate=`filter_evidence_revision IS NOT '${LIBRARY_FILTER_EVIDENCE_REVISION}'`;
      const upgrade=!String(db.prepare("SELECT sql FROM sqlite_master WHERE name='query_filter_evidence_pending'").get()?.sql).includes(predicate);
      if(upgrade)
        db.exec(`DROP INDEX IF EXISTS query_filter_evidence_pending;CREATE INDEX query_filter_evidence_pending ON query_projection(id) WHERE ${predicate}`);
      if(db.prepare(`SELECT 1 FROM query_projection INDEXED BY query_filter_evidence_pending
        WHERE filter_evidence_revision IS NOT '${LIBRARY_FILTER_EVIDENCE_REVISION}' LIMIT 1`).get()&&
        (upgrade||db.prepare("SELECT complete FROM query_filter_evidence_state WHERE id=1").get()?.complete===1)){
        db.exec("UPDATE query_filter_evidence_state SET after_id='',complete=0,verified=0 WHERE id=1;UPDATE query_projection_state SET revision=revision+1 WHERE id=1");
      }
    }
    // Optional physical access for settled analysis facets. Provision on the
    // writer only; legacy readers and filtered/live queries need no index hint.
    if(this.algorithm&&["visible","id","c_identity","analysis_algorithm","analysis","analysis_without_c"].every(column=>columns.has(column)))
      db.exec("CREATE INDEX IF NOT EXISTS query_projection_analysis_cover ON query_projection(visible,id,c_identity,analysis_algorithm,analysis,analysis_without_c)");
    if(this.algorithm&&columns.has("standard_excluded"))
      db.exec("CREATE INDEX IF NOT EXISTS query_projection_analysis_filter_cover ON query_projection(visible,standard_excluded,id,c_identity,analysis_algorithm,analysis,analysis_without_c)");
    if(columns.has("visible")&&columns.has("standard_excluded"))
      db.exec("CREATE INDEX IF NOT EXISTS query_projection_favourite_filter_cover ON query_projection(favourite,visible,standard_excluded,id)");
    if(this.algorithm&&db.prepare("SELECT revision FROM query_analysis_algorithm_state WHERE id=1").get()?.revision!==LIBRARY_QUERY_ALGORITHM_REVISION){
      db.prepare("UPDATE query_analysis_algorithm_state SET revision=?,after_id='',complete=0,verified=0 WHERE id=1").run(LIBRARY_QUERY_ALGORITHM_REVISION);
      db.exec("UPDATE query_projection_state SET revision=revision+1 WHERE id=1");
    }
  }
  static migrateIncidentIdentity(db:DatabaseSync):void {
    db.exec(`ALTER TABLE query_projection ADD COLUMN c_identity TEXT;
      ALTER TABLE query_projection ADD COLUMN analysis_without_c TEXT;
      ALTER TABLE query_projection ADD COLUMN analysis_error_without_c TEXT;
      CREATE INDEX query_c_fallback_pending ON query_projection(id) WHERE analysis_without_c IS NULL;
      CREATE TABLE query_c_identity_state(id INTEGER PRIMARY KEY CHECK(id=1),revision TEXT NOT NULL,after_id TEXT NOT NULL,complete INTEGER NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,fallback_initialized INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version=23;`);
    db.prepare("INSERT INTO query_c_identity_state(id,revision,after_id,complete) VALUES(1,?,'',0)").run(LIBRARY_INCIDENT_QUERY_REVISION);
  }
  static migrateAnalysisAlgorithm(db:DatabaseSync,legacyIdentity=false):void {
    db.exec(`ALTER TABLE query_projection ADD COLUMN analysis_algorithm TEXT;
      CREATE TABLE query_analysis_algorithm_state(id INTEGER PRIMARY KEY CHECK(id=1),revision TEXT NOT NULL,
        after_id TEXT NOT NULL,complete INTEGER NOT NULL,verified INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version=24;`);
    // Pre-23 upgrades already have an indexed NULL fallback queue for every legacy row.
    // Schema23 rows can contain nonNULL obsolete fallback values, so need the all-row pass.
    db.prepare("INSERT INTO query_analysis_algorithm_state(id,revision,after_id,complete) VALUES(1,?,'',?)").run(LIBRARY_QUERY_ALGORITHM_REVISION,Number(legacyIdentity));
  }
  private algorithmPending():boolean{return this.algorithm&&this.db.prepare("SELECT complete FROM query_analysis_algorithm_state WHERE id=1").get()?.complete===0;}
  private filterEvidencePending():boolean{return this.filterEvidence&&this.db.prepare("SELECT complete FROM query_filter_evidence_state WHERE id=1").get()?.complete===0;}
  private aggregateVisibilityState():AggregateVisibilityState|undefined {
    if(!this.options.onPerformanceReplay)return undefined;
    const row=this.db.prepare("SELECT value FROM settings WHERE key=?").get(aggregateVisibilityKey);
    if(!row)return{after_id:"",complete:0,verified:0};
    const state=JSON.parse(String(row.value)) as AggregateVisibilityState;
    if(!state||typeof state.after_id!=="string"||state.after_id.length>128||![0,1].includes(state.complete)||
      !Number.isSafeInteger(state.verified)||state.verified<0)throw Error("Invalid aggregate visibility cursor");
    return state;
  }
  identityPending():boolean{return this.aggregateVisibilityState()?.complete===0||this.filterEvidencePending()||this.identity&&(this.algorithmPending()||
    !!this.db.prepare("SELECT 1 FROM query_projection WHERE analysis_without_c IS NULL LIMIT 1").get());}
  identityStatus():{phase:"identity"|"fallback"|"idle";pending:boolean;after:string;verified:number;fallbackInitialized:number} {
    const aggregate=this.aggregateVisibilityState();
    const state=aggregate?.complete===0?aggregate:this.filterEvidencePending()?this.db.prepare("SELECT * FROM query_filter_evidence_state WHERE id=1").get():
      this.algorithmPending()?this.db.prepare("SELECT * FROM query_analysis_algorithm_state WHERE id=1").get():undefined;
    const fallback=this.identity?this.db.prepare("SELECT fallback_initialized FROM query_c_identity_state WHERE id=1").get():undefined;
    const pending=this.identityPending();return{phase:pending?"fallback":"idle",pending,
      after:String(state?.after_id??""),verified:Number(state?.verified??0),fallbackInitialized:Number(fallback?.fallback_initialized??0)};
  }
  /** Metadata-only verification is deliberately outside the global dirty/scope readiness fence. */
  maintainIdentityInTransaction():{updated:number;pending:boolean} {
    if(!this.identityPending())return{updated:0,pending:false};
    const aggregate=this.aggregateVisibilityState();
    if(aggregate?.complete===0){
      // Resume a bounded primary-key page across restart, regardless of calculation
      // policy. This only rebinds saved qualified P scalars; it never admits work.
      const rows=this.db.prepare("SELECT replay_id,payload FROM performance_recipes WHERE replay_id>? ORDER BY replay_id LIMIT 9").all(aggregate.after_id),more=rows.length>8;
      if(more)rows.pop();
      const masked=this.db.prepare(`SELECT t.slot FROM metric_targets t JOIN metric_results r ON r.replay_id=t.replay_id AND r.slot=t.slot AND r.stage=t.stage
        AND r.input_key=t.input_key AND r.producer_version=t.producer_version WHERE t.replay_id=? AND t.stage='P' AND
        ((t.slot='aggregate-pp' AND json_extract(r.payload,'$.fields.pp.state')='unknown' AND json_extract(r.payload,'$.fields.pp.reason')='completion-unavailable')
         OR (t.slot='fc-pp' AND json_extract(r.payload,'$.fields.ppIfFc.state')='unknown' AND json_extract(r.payload,'$.fields.ppIfFc.reason')='completion-unavailable'))`);
      const retained=this.db.prepare(`SELECT 1 FROM json_each(?,'$.results') WHERE json_extract(value,'$.slot')=?
        AND json_extract(value,'$.stage')='P' AND json_extract(value,?)='known'
        AND json_type(value,?) IN ('integer','real') AND json_extract(value,?)>=0 LIMIT 1`);
      for(const row of rows)if(row.payload){
        const restore=masked.all(row.replay_id as string).some(item=>{
          const field=item.slot==="aggregate-pp"?"pp":"ppIfFc",value=`$.fields.${field}.value`;
          return!!retained.get(row.payload as string,String(item.slot),`$.fields.${field}.state`,value,value);
        });
        if(restore)this.options.onPerformanceReplay?.(String(row.replay_id));
      }
      const state:AggregateVisibilityState={after_id:rows.length?String(rows[rows.length-1].replay_id):aggregate.after_id,complete:more?0:1,verified:aggregate.verified+rows.length};
      this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(aggregateVisibilityKey,JSON.stringify(state));
      const pending=this.identityPending();
      if(rows.length||!pending)return{updated:rows.length,pending};
      // An empty page consumed none of the eight-row budget. Continue existing
      // scalar repair in this transaction, including its cursor/revision rollback.
    }
    if(this.filterEvidencePending()){
      const rows=this.db.prepare(`SELECT id FROM query_projection INDEXED BY query_filter_evidence_pending
        WHERE filter_evidence_revision IS NOT '${LIBRARY_FILTER_EVIDENCE_REVISION}' ORDER BY id LIMIT 9`).all(),more=rows.length>8;
      if(more)rows.pop();
      // Rebuild only this bounded page using current already indexed scalar results.
      // No producer, admission, target mutation or replay/source I/O is called.
      this.db.exec("DELETE FROM temp.query_projection_work");
      const put=this.db.prepare(`INSERT INTO temp.query_projection_work(id${this.invalidation?",flags":""}) VALUES(?${this.invalidation?",1":""})`);
      for(const row of rows)put.run(row.id as string);
      if(rows.length){
        // v1 already qualified every other field. Preserve those scalar/analysis
        // caches; only its player precedence and dependent search text changed.
        this.db.exec(`WITH names AS MATERIALIZED (SELECT r.id,${libraryRecordedPlayerSql("r.metadata")} AS player
          FROM temp.query_projection_work w JOIN replays r ON r.id=w.id JOIN query_projection q ON q.id=w.id
          WHERE q.filter_evidence_revision='recorded-filter-evidence-v1')
          UPDATE query_projection SET (player,player_folded,search_text,filter_evidence_revision)=
            (SELECT player,library_player_fold(player),lower(coalesce(query_projection.title,'')||' '||coalesce(query_projection.artist,'')||' '||coalesce(query_projection.difficulty,'')||' '||coalesce(query_projection.mapper,'')||' '||coalesce(player,'')),
              '${LIBRARY_FILTER_EVIDENCE_REVISION}' FROM names WHERE names.id=query_projection.id) WHERE id IN (SELECT id FROM names);
          DELETE FROM temp.query_projection_work WHERE EXISTS(SELECT 1 FROM query_projection q WHERE q.id=temp.query_projection_work.id AND q.filter_evidence_revision='${LIBRARY_FILTER_EVIDENCE_REVISION}');`);
        if(this.db.prepare("SELECT 1 FROM temp.query_projection_work LIMIT 1").get())this.rebuildScalars();
        this.db.exec("UPDATE query_projection_state SET revision=revision+1 WHERE id=1");
      }
      this.db.prepare("UPDATE query_filter_evidence_state SET after_id=?,complete=?,verified=verified+? WHERE id=1").run(rows.length?String(rows[rows.length-1].id):"",Number(!more),rows.length);
      return{updated:rows.length,pending:this.identityPending()};
    }
    if(this.algorithmPending()){
      const after=String(this.db.prepare("SELECT after_id FROM query_analysis_algorithm_state WHERE id=1").get()?.after_id??"");
      const rows=this.db.prepare("SELECT id FROM query_projection WHERE id>? ORDER BY id LIMIT 9").all(after),more=rows.length>8;
      if(more)rows.pop();this.repairAnalysis(rows.map(row=>String(row.id)));
      this.db.prepare("UPDATE query_analysis_algorithm_state SET after_id=?,complete=?,verified=verified+? WHERE id=1")
        .run(rows.length?String(rows[rows.length-1].id):after,Number(!more),rows.length);
      if(rows.length)this.db.exec("UPDATE query_projection_state SET revision=revision+1 WHERE id=1");
      return{updated:rows.length,pending:this.identityPending()};
    }
    // Legacy NULL status needs bounded initialization; the retired C witness never queues work.
    const rows=this.db.prepare("SELECT id FROM query_projection WHERE analysis_without_c IS NULL ORDER BY id LIMIT 8").all();
    this.repairAnalysis(rows.map(row=>String(row.id)));
    this.db.prepare("UPDATE query_c_identity_state SET fallback_initialized=fallback_initialized+? WHERE id=1").run(rows.length);
    if(rows.length)this.db.exec("UPDATE query_projection_state SET revision=revision+1 WHERE id=1");
    return{updated:rows.length,pending:this.identityPending()};
  }
  /** Only derived query status is written. Metric target/result/job/preparation
   * rows are untouched, including Off and viewer-held work. */
  private repairAnalysis(ids:readonly string[]):void {
    const status=libraryQueryAnalysisSql("query_projection.id",false);
    const update=this.db.prepare(`UPDATE query_projection SET analysis=${status.state},analysis_error=${status.error},
      analysis_without_c=${status.state},analysis_error_without_c=${status.error}${this.algorithm?",analysis_algorithm=?":""} WHERE id=?`);
    for(const id of ids)update.run(...(this.algorithm?[LIBRARY_QUERY_ALGORITHM_REVISION,id]:[id]));
  }
  static migrate(db:DatabaseSync):void {
    registerLibraryPlayerFold(db);
    db.exec(`CREATE TABLE query_projection(${projectionColumns.map(column=>`${column} ${texts.has(column)?"TEXT":"REAL"}${column==="id"?" PRIMARY KEY":""}`).join(",")});
      CREATE TABLE query_projection_dirty(id TEXT PRIMARY KEY);
      CREATE TABLE query_projection_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT INTO query_projection_state VALUES(1,0);
      CREATE INDEX query_projection_map ON query_projection(map_identity);
      CREATE INDEX query_projection_player ON query_projection(player,id);
      CREATE INDEX query_projection_mapper ON query_projection(mapper,id);
      CREATE INDEX query_projection_review ON query_projection(review,id);
      CREATE INDEX query_projection_analysis ON query_projection(analysis,id);`);
    for(const sort of Object.keys(LIBRARY_SORTS))for(const direction of ["asc","desc"]){
      const rank=`CASE WHEN ${sort} IS NOT NULL THEN 0 ${["pp","fc"].includes(sort)?"WHEN completion='failed' THEN 1":""} ELSE 2 END`;
      db.exec(`CREATE INDEX query_sort_${sort}_${direction} ON query_projection(${rank},${sort==="title"?"lower(title)":sort} ${direction},id)`);
    }
    const trigger=(name:string,event:string,table:string,body:string,when="")=>db.exec(`CREATE TRIGGER query_dirty_${name} AFTER ${event} ON ${table} ${when} BEGIN ${body} UPDATE query_projection_state SET revision=revision+1 WHERE id=1; END;`);
    // An outer UPSERT can override a trigger's legacy OR IGNORE conflict policy. A
    // targeted UPSERT clause keeps repeated IDs coalesced for that write path too.
    const mark=(expression:string)=>`INSERT INTO query_projection_dirty(id) SELECT * FROM (SELECT ${expression}) WHERE true ON CONFLICT(id) DO NOTHING;`;
    for(const table of ["replays","locations","metric_targets","metric_results","metric_jobs","analysis_requests","review_edits","memberships"]){
      const key=table==="replays"?"id":"replay_id";
      trigger(`${table}_insert`,"INSERT",table,mark(`NEW.${key}`));
      trigger(`${table}_delete`,"DELETE",table,mark(`OLD.${key}`));
      trigger(`${table}_update`,"UPDATE",table,mark(`OLD.${key}`)+mark(`NEW.${key}`));
    }
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='incident_location_epochs'").get()){
      db.exec("CREATE INDEX query_incident_source ON incident_recipes(source_id,source_key)");
      for(const event of ["INSERT","DELETE","UPDATE"]){
        const prefix=event==="DELETE"?"OLD":"NEW";
        trigger(`incident_recipes_${event.toLowerCase()}`,event,"incident_recipes",mark(`${prefix}.replay_id`)+(event==="UPDATE"?mark("OLD.replay_id"):""));
        for(const table of ["incident_source_epochs","incident_location_epochs"]){
          const affected=(row:string)=>mark(`replay_id FROM incident_recipes WHERE source_id=${row}.source_id${table==="incident_location_epochs"?` AND source_key=${row}.source_key`:""}`);
          trigger(`${table}_${event.toLowerCase()}`,event,table,affected(prefix)+(event==="UPDATE"?affected("OLD"):""));
        }
      }
    }
    const affectedMap=(md5:string)=>mark(`id FROM query_projection WHERE map_identity=${md5}`);
    for(const event of ["INSERT","DELETE","UPDATE"]){
      const prefix=event==="DELETE"?"OLD":"NEW";
      trigger(`maps_${event.toLowerCase()}`,event,"maps",affectedMap(`${prefix}.md5`)+(event==="UPDATE"?affectedMap("OLD.md5"):""),
        `WHEN EXISTS(SELECT 1 FROM map_scans WHERE source_id=${prefix}.source_id AND current_generation=${prefix}.generation)${event==="UPDATE"?" OR EXISTS(SELECT 1 FROM map_scans WHERE source_id=OLD.source_id AND current_generation=OLD.generation)":""}`);
    }
    const sourceMaps=(prefix:string)=>mark(`id FROM query_projection WHERE map_identity IN (SELECT md5 FROM maps WHERE source_id=${prefix}.source_id)`);
    for(const event of ["INSERT","DELETE","UPDATE"]){
      const prefix=event==="DELETE"?"OLD":"NEW";
      trigger(`map_scans_${event.toLowerCase()}`,event==="UPDATE"?"UPDATE OF current_generation":event,"map_scans",sourceMaps(prefix)+(event==="UPDATE"?sourceMaps("OLD"):""));
    }
    const sourceRows=(prefix:string)=>mark(`replay_id FROM locations WHERE source_id=${prefix}.id`)+mark(`id FROM query_projection WHERE map_identity IN (SELECT md5 FROM maps WHERE source_id=${prefix}.id)`);
    trigger("sources_update","UPDATE OF enabled,configured,config_revision","sources",sourceRows("OLD")+sourceRows("NEW"));
    trigger("sources_delete","DELETE","sources",sourceRows("OLD"));
    // Names/parent relations influence live collection facets/scopes even with no members.
    for(const event of ["INSERT","DELETE","UPDATE"])trigger(`collections_${event.toLowerCase()}`,event,"collections","");
    const analysisRows=mark("replay_id FROM metric_jobs WHERE stage='S'")+mark("replay_id FROM analysis_requests WHERE stage='S'");
    for(const event of ["INSERT","DELETE","UPDATE"]){const prefix=event==="DELETE"?"OLD":"NEW";trigger(`settings_${event.toLowerCase()}`,event,"settings",analysisRows,`WHEN ${prefix}.key='analysis'`);}
    // Seed identities only. Existing libraries are projected in separately yielding batches.
    db.exec("INSERT INTO query_projection_dirty SELECT id FROM replays; PRAGMA user_version=19;");
  }
  static migrateAcceleration(db:DatabaseSync):void {
    db.exec(`ALTER TABLE query_projection ADD COLUMN search_text TEXT;
      ALTER TABLE query_projection ADD COLUMN source_mask INTEGER;
      ALTER TABLE query_projection ADD COLUMN mod_tokens TEXT;
      CREATE INDEX query_membership_collection ON memberships(collection_id,replay_id);
      CREATE INDEX query_collection_parent ON collections(parent_id,id);
      CREATE INDEX query_projection_favourite ON query_projection(favourite,id);
      INSERT INTO query_projection_dirty SELECT id FROM replays WHERE true ON CONFLICT(id) DO NOTHING;
      PRAGMA user_version=20;`);
  }
  /** Schema-only expansion. Existing rows are repaired in eight-row writer turns. */
  static migrateFilterEvidence(db:DatabaseSync):void {
    registerLibraryPlayerFold(db);
    const columns=new Set(db.prepare("PRAGMA table_info(query_projection)").all().map(row=>String(row.name)));
    for(const [column,type] of Object.entries({recorded_completion:"TEXT",recording_client:"TEXT NOT NULL DEFAULT 'unknown'",standard_excluded:"INTEGER NOT NULL DEFAULT 0",player_folded:"TEXT",break_evidence:"INTEGER NOT NULL DEFAULT 0",filter_evidence_revision:"TEXT"}))
      if(!columns.has(column))db.exec(`ALTER TABLE query_projection ADD COLUMN ${column} ${type}`);
    db.exec(`CREATE INDEX query_filter_evidence_pending ON query_projection(id) WHERE filter_evidence_revision IS NULL;
      CREATE INDEX query_projection_player_folded ON query_projection(player_folded,id);
      CREATE INDEX query_projection_result ON query_projection(recorded_completion,full_combo,id);
      CREATE INDEX query_projection_recording_client ON query_projection(recording_client,id);
      CREATE TABLE query_filter_evidence_state(id INTEGER PRIMARY KEY CHECK(id=1),after_id TEXT NOT NULL DEFAULT '',complete INTEGER NOT NULL,verified INTEGER NOT NULL DEFAULT 0);
      INSERT INTO query_filter_evidence_state(id,complete) SELECT 1,NOT EXISTS(SELECT 1 FROM query_projection WHERE filter_evidence_revision IS NULL LIMIT 1);
      UPDATE query_projection_state SET revision=revision+1 WHERE id=1;
      PRAGMA user_version=25;`);
  }
  /** Replace the persisted trigger without rebuilding already correct scalar rows. */
  static migrateObservationInvalidation(db:DatabaseSync):void {
    db.exec(`DROP TRIGGER query_dirty_locations_update;
      CREATE TRIGGER query_dirty_locations_update AFTER UPDATE ON locations
      WHEN OLD.source_id IS NOT NEW.source_id OR OLD.source_key IS NOT NEW.source_key OR OLD.replay_id IS NOT NEW.replay_id
        OR OLD.locator IS NOT NEW.locator OR OLD.sha256 IS NOT NEW.sha256 OR OLD.available IS NOT NEW.available OR OLD.metadata IS NOT NEW.metadata
      BEGIN
        INSERT INTO query_projection_dirty(id,flags) VALUES(OLD.replay_id,1) ON CONFLICT(id) DO UPDATE SET flags=flags|excluded.flags;
        INSERT INTO query_projection_dirty(id,flags) VALUES(NEW.replay_id,1) ON CONFLICT(id) DO UPDATE SET flags=flags|excluded.flags;
        UPDATE query_projection_state SET revision=revision+1 WHERE id=1;
      END;
      PRAGMA user_version=26;`);
  }
  static migrateInvalidation(db:DatabaseSync):void {
    LibraryQueryInvalidation.migrate(db);
    db.exec(`ALTER TABLE query_projection_dirty ADD COLUMN flags INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE query_projection_state ADD COLUMN resource_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE query_projection ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX query_projection_visible ON query_projection(visible,id);
      CREATE INDEX query_projection_map_ids ON query_projection(map_identity,id);
      CREATE INDEX query_locations_visibility ON locations(replay_id,source_id,available);
      CREATE INDEX query_locations_source_replay ON locations(source_id,replay_id);
      CREATE INDEX query_incident_source_replay ON incident_recipes(source_id,replay_id);
      CREATE INDEX query_maps_source_key ON maps(source_id,source_key,md5);`);
    for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'query_dirty_%'").all())
      db.exec(`DROP TRIGGER "${String(row.name).replace(/"/g,'""')}"`);
    const trigger=(name:string,event:string,table:string,body:string,when="")=>db.exec(`CREATE TRIGGER query_dirty_${name} AFTER ${event} ON ${table} ${when} BEGIN ${body} UPDATE query_projection_state SET revision=revision+1 WHERE id=1; END;`);
    const mark=(expression:string,flags=1)=>`INSERT INTO query_projection_dirty(id,flags) SELECT id,${flags} FROM (SELECT ${expression} AS id) WHERE true ON CONFLICT(id) DO UPDATE SET flags=flags|excluded.flags;`;
    const scope=(kind:string,id:string,metadata="NULL")=>LibraryQueryInvalidation.enqueueSql(kind,id,metadata)+";";
    for(const table of ["replays","locations","metric_targets","metric_results","metric_jobs","analysis_requests","review_edits","memberships","incident_recipes"]){
      const key=table==="replays"?"id":"replay_id";
      trigger(`${table}_insert`,"INSERT",table,mark(`NEW.${key}`));
      trigger(`${table}_delete`,"DELETE",table,mark(`OLD.${key}`));
      trigger(`${table}_update`,"UPDATE",table,mark(`OLD.${key}`)+mark(`NEW.${key}`));
    }
    for(const event of ["INSERT","DELETE","UPDATE"]){
      const row=event==="DELETE"?"OLD":"NEW";
      trigger(`incident_source_epochs_${event.toLowerCase()}`,event,"incident_source_epochs",scope("c-source",`${row}.source_id`)+(event==="UPDATE"?scope("c-source","OLD.source_id"):""));
      const cLocation=(value:string)=>`INSERT INTO query_projection_dirty(id,flags) SELECT replay_id,2 FROM incident_recipes WHERE source_id=${value}.source_id AND source_key=${value}.source_key
        ON CONFLICT(id) DO UPDATE SET flags=flags|excluded.flags;`;
      trigger(`incident_location_epochs_${event.toLowerCase()}`,event,"incident_location_epochs",cLocation(row)+(event==="UPDATE"?cLocation("OLD"):""));
      trigger(`maps_${event.toLowerCase()}`,event,"maps",scope("map-md5",`${row}.md5`)+(event==="UPDATE"?scope("map-md5","OLD.md5"):""),
        `WHEN EXISTS(SELECT 1 FROM map_scans WHERE source_id=${row}.source_id AND current_generation=${row}.generation)${event==="UPDATE"?" OR EXISTS(SELECT 1 FROM map_scans WHERE source_id=OLD.source_id AND current_generation=OLD.generation)":""}`);
      const oldGeneration=event==="INSERT"?"NULL":"OLD.current_generation",newGeneration=event==="DELETE"?"NULL":"NEW.current_generation";
      trigger(`map_scans_${event.toLowerCase()}`,event==="UPDATE"?"UPDATE OF current_generation":event,"map_scans",
        scope("map-publication","lower(hex(randomblob(16)))",`json_object('sourceId',${row}.source_id,'oldGeneration',${oldGeneration},'newGeneration',${newGeneration})`),
        `WHEN ${oldGeneration} IS NOT ${newGeneration}`);
      trigger(`collections_${event.toLowerCase()}`,event,"collections","");
      trigger(`settings_${event.toLowerCase()}`,event,"settings","",`WHEN ${row}.key='analysis'`);
    }
    const mapSource=(row:string,condition="1")=>`INSERT INTO query_projection_scopes(kind,scope_id) SELECT 'map-source',${row}.id WHERE (${condition}) AND EXISTS(SELECT 1 FROM maps WHERE source_id=${row}.id)
      ON CONFLICT(kind,scope_id) DO UPDATE SET desired_version=desired_version+1;`;
    const cSource=(row:string)=>`INSERT INTO query_projection_scopes(kind,scope_id) SELECT 'c-source',${row}.id WHERE EXISTS(SELECT 1 FROM incident_recipes WHERE source_id=${row}.id)
      ON CONFLICT(kind,scope_id) DO UPDATE SET desired_version=desired_version+1;`;
    const sourceRows=(row:string,condition="1")=>`INSERT INTO query_projection_scopes(kind,scope_id) SELECT 'source-locations',${row}.id WHERE (${condition}) AND EXISTS(SELECT 1 FROM locations WHERE source_id=${row}.id)
      ON CONFLICT(kind,scope_id) DO UPDATE SET desired_version=desired_version+1;`;
    trigger("sources_update","UPDATE OF enabled,configured,config_revision","sources",sourceRows("NEW","OLD.enabled IS NOT NEW.enabled OR OLD.configured IS NOT NEW.configured")+mapSource("NEW","OLD.enabled IS NOT NEW.enabled OR OLD.configured IS NOT NEW.configured")+cSource("NEW"),
      "WHEN OLD.enabled IS NOT NEW.enabled OR OLD.configured IS NOT NEW.configured OR OLD.config_revision IS NOT NEW.config_revision");
    trigger("sources_delete","DELETE","sources",sourceRows("OLD")+mapSource("OLD")+cSource("OLD"));
    const resource=(name:string,event:string,table:string,when="")=>db.exec(`CREATE TRIGGER query_resource_${name} AFTER ${event} ON ${table} ${when}
      BEGIN UPDATE query_projection_state SET resource_revision=resource_revision+1 WHERE id=1; END;`);
    for(const event of ["INSERT","DELETE","UPDATE"]){
      resource(`locations_${event.toLowerCase()}`,event,"locations",event==="UPDATE"?
        "WHEN OLD.source_id IS NOT NEW.source_id OR OLD.source_key IS NOT NEW.source_key OR OLD.replay_id IS NOT NEW.replay_id OR OLD.locator IS NOT NEW.locator OR OLD.sha256 IS NOT NEW.sha256 OR OLD.metadata IS NOT NEW.metadata OR OLD.available IS NOT NEW.available":"");
      const row=event==="DELETE"?"OLD":"NEW";
      resource(`map_scans_${event.toLowerCase()}`,event==="UPDATE"?"UPDATE OF current_generation":event,"map_scans",event==="UPDATE"?
        "WHEN OLD.current_generation IS NOT NEW.current_generation":`WHEN ${row}.current_generation IS NOT NULL`);
      resource(`maps_${event.toLowerCase()}`,event,"maps",`WHEN EXISTS(SELECT 1 FROM map_scans WHERE source_id=${row}.source_id AND current_generation=${row}.generation)${event==="UPDATE"?
        " AND (OLD.md5 IS NOT NEW.md5 OR OLD.locator IS NOT NEW.locator OR OLD.state IS NOT NEW.state OR OLD.metadata IS NOT NEW.metadata)":""}`);
    }
    resource("sources_update","UPDATE OF enabled,configured,config_revision","sources","WHEN OLD.enabled IS NOT NEW.enabled OR OLD.configured IS NOT NEW.configured OR OLD.config_revision IS NOT NEW.config_revision");
    resource("sources_delete","DELETE","sources");
    resource("replays_update","UPDATE OF metadata,merged_into","replays","WHEN OLD.metadata IS NOT NEW.metadata OR OLD.merged_into IS NOT NEW.merged_into");
    // Schema 20 already has the scalar values. Only previously hidden canonical rows
    // and paused badges need one bounded refresh; migration never rebuilds all rows.
    db.exec(`INSERT INTO query_projection_dirty(id) SELECT id FROM replays r WHERE merged_into IS NULL AND NOT EXISTS(SELECT 1 FROM query_projection q WHERE q.id=r.id)
      ON CONFLICT(id) DO UPDATE SET flags=flags|1;
      INSERT INTO query_projection_dirty(id) SELECT id FROM query_projection WHERE analysis='paused' ON CONFLICT(id) DO UPDATE SET flags=flags|1;
      PRAGMA user_version=21;`);
  }
  static migrateVisibility(db:DatabaseSync):void {
    // New kinds cannot downgrade an old untyped or semantic pass already in progress.
    const enqueue=(kind:string,table:"query_projection_scopes"|"source_admission_scopes",condition:string)=>
      `INSERT INTO ${table}(kind,scope_id) SELECT '${kind}',NEW.id WHERE ${condition}
       ON CONFLICT(kind,scope_id) DO UPDATE SET desired_version=desired_version+1;`;
    const changed="(OLD.enabled IS NOT NEW.enabled OR OLD.configured IS NOT NEW.configured)",
      locations=`${changed} AND EXISTS(SELECT 1 FROM locations WHERE source_id=NEW.id)`,
      maps=`${changed} AND EXISTS(SELECT 1 FROM maps WHERE source_id=NEW.id)`;
    db.exec(`DROP TRIGGER query_dirty_sources_update;
      CREATE TRIGGER query_dirty_sources_update AFTER UPDATE OF enabled,configured,config_revision ON sources
      WHEN ${changed} OR OLD.config_revision IS NOT NEW.config_revision BEGIN
      ${enqueue("source-visibility","query_projection_scopes",locations)}
      ${enqueue("map-source-visibility","query_projection_scopes",maps)}
      ${enqueue("c-source","query_projection_scopes","EXISTS(SELECT 1 FROM incident_recipes WHERE source_id=NEW.id)")}
      ${enqueue("source","source_admission_scopes",locations)}
      ${enqueue("map-source","source_admission_scopes",maps)}
      UPDATE query_projection_state SET revision=revision+1 WHERE id=1; END;
      PRAGMA user_version=22;`);
  }
  pendingCount():number{return Number(this.db.prepare("SELECT count(*) AS count FROM query_projection_dirty").get()?.count??0)+(this.invalidation?.pendingCount()??0);}
  revision():string{return String(this.db.prepare("SELECT revision FROM query_projection_state WHERE id=1").get()?.revision??0);}
  resourceRevision():string{return this.invalidation?String(this.db.prepare("SELECT resource_revision FROM query_projection_state WHERE id=1").get()?.resource_revision??0):"0";}
  private scopePage(scope:LibraryQueryInvalidationScope,after:string,limit:number):LibraryQueryInvalidationPage {
    if(scope.kind==="map-publication")return readLibraryMapSemanticPage(this.db,scope,after,limit);
    const sql=scope.kind==="c-source"?"SELECT replay_id AS id FROM incident_recipes WHERE source_id=? AND replay_id>? ORDER BY replay_id LIMIT ?":
      ["source-locations","source-visibility"].includes(scope.kind)?"SELECT replay_id AS id FROM locations WHERE source_id=? AND replay_id>? GROUP BY replay_id ORDER BY replay_id LIMIT ?":
      ["map-md5","map-visibility"].includes(scope.kind)?"SELECT id FROM query_projection WHERE map_identity=? AND id>? ORDER BY id LIMIT ?":
      ["map-source","map-source-visibility"].includes(scope.kind)?"SELECT m.source_key AS id,m.md5 FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation WHERE m.source_id=? AND m.source_key>? ORDER BY m.source_key LIMIT ?":undefined;
    if(!sql)throw Error(`Unknown library query invalidation scope: ${scope.kind}`);
    const rows=this.db.prepare(sql).all(scope.scopeId,after,limit+1),more=rows.length>limit;if(more)rows.pop();
    return{ids:rows.map(row=>String(["map-source","map-source-visibility"].includes(scope.kind)?row.md5:row.id)),...(more?{next:String(rows[rows.length-1].id)}:{})};
  }
  private expand(limit:number):void {
    const invalidation=this.invalidation;if(!invalidation)return;
    invalidation.expandInTransaction(Math.min(limit,256),(scope,after,bound)=>this.scopePage(scope,after,bound),(ids,scope)=>{
      if(["map-source","map-source-visibility","map-publication"].includes(scope.kind))for(const id of ids)invalidation.enqueue(scope.kind==="map-source-visibility"?"map-visibility":"map-md5",id);
      else {
        const mark=this.db.prepare("INSERT INTO query_projection_dirty(id,flags) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET flags=flags|excluded.flags");
        for(const id of ids){
          if(scope.kind==="map-md5")this.options.onMapReplay?.(id);
          if(scope.kind==="source-locations")this.options.onSourceReplay?.(id);
          if(["source-visibility","map-visibility"].includes(scope.kind))this.options.onVisibilityReplay?.(id);
          mark.run(id,scope.kind==="c-source"?2:["source-locations","source-visibility"].includes(scope.kind)?8:4);
        }
      }
    });
  }
  flushInTransaction(limit=128):{updated:number;pending:number}{
    if(!Number.isInteger(limit)||limit<1||limit>1024)throw new Error("Invalid library projection batch limit");
    this.expand(limit);
    this.db.exec("DELETE FROM temp.query_projection_work");
    this.db.prepare(`INSERT INTO temp.query_projection_work SELECT id${this.invalidation?",flags":""} FROM query_projection_dirty ORDER BY id LIMIT ?`).run(limit);
    // Expansion callbacks can add FULL work. Inspect the final bounded work set,
    // preserving FULL dominance independently for each row and each patch family.
    const work=this.db.prepare(`SELECT count(*) AS count${this.invalidation?`,max(flags & 1) AS full,
      max(CASE WHEN (flags & 1)=0 THEN flags & 2 ELSE 0 END) AS incidents,
      max(CASE WHEN (flags & 1)=0 THEN flags & 4 ELSE 0 END) AS display,
      max(CASE WHEN (flags & 1)=0 THEN flags & 8 ELSE 0 END) AS source`:""} FROM temp.query_projection_work`).get();
    const updated=Number(work?.count??0);
    if(!updated)return{updated:0,pending:this.pendingCount()};
    if(!this.invalidation||Number(work?.full))this.rebuildScalars();
    if(this.invalidation)this.patchScalars(Number(work?.incidents)|Number(work?.display)|Number(work?.source));
    if(this.identity)this.repairAnalysis(this.db.prepare(`SELECT id FROM temp.query_projection_work${this.invalidation?" WHERE (flags & 3)<>0":""}`).all().map(row=>String(row.id)));
    this.db.exec("DELETE FROM query_projection_dirty WHERE id IN (SELECT id FROM temp.query_projection_work)");
    return{updated,pending:this.pendingCount()};
  }
  private rebuildScalars():void {
    const ids=`SELECT id FROM temp.query_projection_work${this.invalidation?" WHERE (flags & 1)<>0":""}`;
    let cte=libraryQueryLegacyCte
      .replace("FROM extracted WHERE standard_excluded=0","FROM extracted")
      .replace("GROUP BY t.replay_id",`WHERE t.replay_id IN (${ids}) GROUP BY t.replay_id`)
      .replace("WHERE r.merged_into IS NULL",`WHERE r.id IN (${ids}) AND r.merged_into IS NULL`)
      .replace("WHERE j.stage='S'",`WHERE j.replay_id IN (${ids}) AND j.stage='S'`)
      .replace("WHERE stage='S'",`WHERE replay_id IN (${ids}) AND stage='S'`);
    if(this.invalidation)cte=cte.replace("AND EXISTS(SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=r.id AND s.enabled=1 AND s.configured=1)","")
      .replace("WHEN coalesce((SELECT json_extract(value,'$.userPaused') FROM settings WHERE key='analysis'),0)=1 THEN 'paused'\n        WHEN EXISTS","WHEN EXISTS");
    const extraColumns=(this.accelerated?",search_text,source_mask,mod_tokens":"")+(this.invalidation?",visible":"");
    const extraValues=(this.accelerated?`,lower(coalesce(title,'')||' '||coalesce(artist,'')||' '||coalesce(difficulty,'')||' '||coalesce(mapper,'')||' '||coalesce(player,'')),
      coalesce((SELECT sum(CASE value WHEN 'stable' THEN 1 WHEN 'replays' THEN 2 WHEN 'lazer' THEN 4 WHEN 'imported' THEN 8 ELSE 0 END) FROM json_each(source_kinds)),0),
      CASE WHEN mods IS NULL THEN NULL ELSE '|'||coalesce((SELECT group_concat(hex(value),'|') FROM json_each(mods)),'')||'|' END`:"")+
      (this.invalidation?",EXISTS(SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=projected.id AND s.enabled=1 AND s.configured=1)":"");
    this.db.exec(`DELETE FROM query_projection WHERE id IN (${ids});
      INSERT INTO query_projection(${LIBRARY_QUERY_PROJECTION_COLUMNS}${extraColumns}) ${cte} SELECT ${LIBRARY_QUERY_PROJECTION_COLUMNS}${extraValues} FROM projected;
      `);
  }
  private patchScalars(flags:number):void {
    const sourceIds="SELECT id FROM temp.query_projection_work WHERE (flags & 1)=0 AND (flags & 8)<>0";
    if(flags&8)this.db.exec(`WITH affiliation AS MATERIALIZED (SELECT id,
      (SELECT json_group_array(kind) FROM (SELECT DISTINCT s.kind FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=q.id AND s.enabled=1 AND s.configured=1 ORDER BY s.kind)) AS kinds,
      EXISTS(SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=q.id AND s.enabled=1 AND s.configured=1 AND l.available=1) AS available
      FROM query_projection q WHERE id IN (${sourceIds}))
      UPDATE query_projection SET (source_kinds,source_mask,visible,available)=(SELECT kinds,
        coalesce((SELECT sum(CASE value WHEN 'stable' THEN 1 WHEN 'replays' THEN 2 WHEN 'lazer' THEN 4 WHEN 'imported' THEN 8 ELSE 0 END) FROM json_each(kinds)),0),json_array_length(kinds)>0,available
        FROM affiliation WHERE affiliation.id=query_projection.id) WHERE id IN (${sourceIds});`);
    const cIds="SELECT id FROM temp.query_projection_work WHERE (flags & 1)=0 AND (flags & 2)<>0";
    if(flags&2)this.db.exec(`UPDATE query_projection SET incidents=NULL WHERE id IN (${cIds});
      UPDATE query_projection SET analysis=CASE WHEN EXISTS(SELECT 1 FROM metric_targets t JOIN metric_results r ON r.replay_id=t.replay_id AND r.slot=t.slot AND r.stage=t.stage
        AND r.input_key=t.input_key AND r.producer_version=t.producer_version WHERE t.replay_id=query_projection.id AND t.slot='numerical')
        THEN 'analysed' ELSE 'none' END WHERE id IN (${cIds}) AND analysis IN ('analysed','none');`);
    const displayIds="SELECT id FROM temp.query_projection_work WHERE (flags & 1)=0 AND (flags & 4)<>0";
    if(flags&4)this.db.exec(`WITH chosen AS MATERIALIZED (SELECT r.id,r.metadata,
      (SELECT m.metadata FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation JOIN sources s ON s.id=m.source_id
        WHERE s.enabled=1 AND s.configured=1 AND m.md5=q.map_identity ORDER BY m.source_id,m.source_key LIMIT 1) AS map_metadata
      FROM replays r JOIN query_projection q ON q.id=r.id WHERE r.id IN (${displayIds})),
      display AS (SELECT id,
        nullif(coalesce(json_extract(map_metadata,'$.map.title'),json_extract(map_metadata,'$.title'),json_extract(metadata,'$.nativeScore.mapMetadata.title')),'') AS title,
        nullif(coalesce(json_extract(map_metadata,'$.map.artist'),json_extract(map_metadata,'$.artist'),json_extract(metadata,'$.nativeScore.mapMetadata.artist')),'') AS artist,
        nullif(coalesce(json_extract(map_metadata,'$.map.difficulty'),json_extract(map_metadata,'$.difficultyName'),json_extract(metadata,'$.nativeScore.mapMetadata.difficultyName')),'') AS difficulty,
        nullif(coalesce(json_extract(map_metadata,'$.map.creator'),json_extract(map_metadata,'$.mapper'),json_extract(metadata,'$.nativeScore.mapMetadata.mapper')),'') AS mapper FROM chosen)
      UPDATE query_projection SET (title,artist,difficulty,mapper)=(SELECT title,artist,difficulty,mapper FROM display WHERE display.id=query_projection.id) WHERE id IN (${displayIds});
      UPDATE query_projection SET search_text=lower(coalesce(title,'')||' '||coalesce(artist,'')||' '||coalesce(difficulty,'')||' '||coalesce(mapper,'')||' '||coalesce(player,'')) WHERE id IN (${displayIds});`);
  }
}
