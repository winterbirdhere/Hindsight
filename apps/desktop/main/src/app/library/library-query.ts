import { libraryQueryLegacyCte, LIBRARY_QUERY_PROJECTION_COLUMNS, libraryQueryAnalysisSql,
  libraryQueryAnalysisCurrentSql, libraryQueryAnalysisFallbackMissingSql, libraryQueryAnalysisPendingSql } from "./library-query-projection";
import { registerLibraryPlayerFold, LIBRARY_FILTER_EVIDENCE_REVISION, libraryCompleteBreakEvidenceSql, libraryRecordedFullComboSql, libraryRecordedPerfectComboSql, libraryRecordedPlayerSql } from "./library-query-projection";
import { libraryKnownNonstandardSql, libraryRecordingClientSql, libraryRecordedCompletionSql } from "./library-recorded-evidence";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { libraryQueryReadiness, LibraryQueryReadiness, libraryLiveSourceExistsSql } from "./library-query-readiness";
import {
  LIBRARY_SORTS, validateLibraryFilter, validateLibraryQuery,
  LibraryQuery, LibraryFilter, LibraryFacetField, LibraryQueryItem, LibrarySort,
  LibraryQueryPage, LibraryQueryPreview, LibraryFacetPage, LibraryCollectionCount,
  LibraryQueryBandPage, LibraryQueryReveal, LibraryQueryDetail, LibraryCollectionPage, LibraryMembershipPage,
  LIBRARY_QUERY_MAX_RESPONSE_BYTES,
} from "../../../../shared/library-query";

type Row = Record<string, unknown>;
type Context = { input: LibraryQuery; sort: LibrarySort; direction: "asc" | "desc"; limit: number; asOf: number; signature: string; revision: string; accelerated:boolean;readiness:LibraryQueryReadiness;myNames?:readonly string[];cursor?: Cursor };
type Cursor = { version: 1; signature: string; asOf: number; revision: string; rank: number; value: string | number | null; id: string; inclusive?: boolean };
type Predicate = { sql: string; params: SQLInputValue[] };

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export class LibraryQueryInvalidatedError extends Error { readonly code="library-query-invalidated"; constructor(){super("Library query changed; refresh results and reveal the selected replay.");} }
export class LibraryQueryUpdatingError extends Error { readonly code="library-query-updating"; constructor(){super("Library index is updating; retained results will refresh when ready.");} }
export class LibraryQueryLimitError extends Error { readonly code="library-query-limit"; }
export function assertLibraryQueryResponse<T>(value:T):T {
  if(Buffer.byteLength(JSON.stringify(value))>LIBRARY_QUERY_MAX_RESPONSE_BYTES)throw new LibraryQueryLimitError("Library response exceeds its byte budget; request a smaller page.");
  return value;
}
function context(input: LibraryQuery, now: number, revision: string,purpose="rows",accelerated=false,readiness:LibraryQueryReadiness="settled"): Context {
  validateLibraryQuery(input);
  const sort=input.sort??"pp",direction=input.direction??LIBRARY_SORTS[sort].direction;
  const signature=hash({purpose,search:input.search??"",filters:input.filters??[],scope:input.scope??{kind:"all"},sort,direction});
  let cursor: Cursor | undefined;
  if(input.cursor) {
    try { cursor=JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8")) as Cursor; } catch { throw new Error("Invalid library cursor"); }
    if(!cursor||cursor.version!==1||cursor.signature!==signature||!Number.isFinite(cursor.asOf)||![0,1,2].includes(cursor.rank)||typeof cursor.id!=="string"||!cursor.id.length||cursor.id.length>512||!(cursor.value===null||typeof cursor.value==="string"&&cursor.value.length<=65536||typeof cursor.value==="number"&&Number.isFinite(cursor.value))) throw new Error("Invalid library cursor");
    if(cursor.revision!==revision)throw new LibraryQueryInvalidatedError();
    if(cursor.inclusive!==undefined&&typeof cursor.inclusive!=="boolean")throw new Error("Invalid library cursor");
  }
  return{input,sort,direction,signature,revision,accelerated,readiness,limit:input.limit??64,asOf:cursor?.asOf??now,cursor};
}
function collectionPredicate(ids: string[],accelerated=false): Predicate {
  const favourite=ids.includes("fav"),rest=ids.filter(id=>id!=="fav");
  // Build the selected membership set once instead of probing memberships for
  // every projected row. IN also deduplicates direct/child and sibling overlaps.
  if(accelerated)return {sql:`(${favourite?"favourite=1 OR ":""}${rest.length?`q.id IN (SELECT membership.replay_id FROM collections collection CROSS JOIN memberships membership INDEXED BY query_membership_collection WHERE membership.collection_id=collection.id AND (collection.id IN (${rest.map(()=>"?").join(",")}) OR collection.parent_id IN (${rest.map(()=>"?").join(",")})))`:"0"})`,params:[...rest,...rest]};
  return { sql:`(${favourite?"favourite=1 OR ":""}${rest.length?`EXISTS(SELECT 1 FROM memberships membership JOIN collections collection ON collection.id=membership.collection_id WHERE membership.replay_id=q.id AND (collection.id IN (${rest.map(()=>"?").join(",")}) OR collection.parent_id IN (${rest.map(()=>"?").join(",")})))`:"0"})`, params:[...rest,...rest] };
}
const sourceBits:Record<string,number>={stable:1,replays:2,lazer:4,imported:8};
function predicate(filter: LibraryFilter, asOf: number,accelerated=false,liveSource=false,myNames:readonly string[]=[]): Predicate {
  if("values" in filter) {
    if(filter.field==="player"){
      const values=[...new Set([...filter.values,...(filter.me?myNames:[])].map(value=>value.toLowerCase()))];
      return{sql:values.length?`player_folded IN (${values.map(()=>"?").join(",")})`:"0",params:values};
    }
    if(!filter.values.length)return{sql:"0",params:[]};
    if(filter.field==="result")return{sql:filter.values[0]==="fc"?"recorded_completion='passed' AND full_combo=1":filter.values[0]==="unknown"?"(recorded_completion IS NULL OR recorded_completion NOT IN ('passed','failed'))":"recorded_completion=?",params:["passed","failed"].includes(filter.values[0])?[filter.values[0]]:[]};
    if(filter.field==="playedon")return{sql:`recording_client IN (${filter.values.map(()=>"?").join(",")})`,params:filter.values};
    if(filter.field==="collection")return collectionPredicate(filter.values,accelerated);
    const values=filter.values;
    if(filter.field==="source"&&liveSource)return{sql:libraryLiveSourceExistsSql("q.id",`live_source.kind IN (${values.map(()=>"?").join(",")})`),params:values};
    if(filter.field==="source")return accelerated?{sql:"(source_mask & ?)<>0",params:[values.reduce((mask,value)=>mask|sourceBits[value],0)]}:
      {sql:`EXISTS(SELECT 1 FROM json_each(q.source_kinds) WHERE value IN (${values.map(()=>"?").join(",")}))`,params:values};
    const field=filter.field==="astate"?"CASE WHEN analysis IN ('queued','analysing','paused') THEN 'active' ELSE analysis END":filter.field;
    return{sql:`${field} IN (${values.map(()=>"?").join(",")})`,params:values};
  }
  if(filter.field==="mods") {
    const membership=filter.mode!=="exactly",excludes=filter.mode==="excludes";
    if(accelerated){
      const params:SQLInputValue[]=[];
      const tests=filter.mods.map(mod=>{
        const aliases=membership&&mod==="DT"?["DT","NC"]:membership&&mod==="SD"?["SD","PF"]:[mod];
        return`(${aliases.map(alias=>{params.push(`|${Buffer.from(alias).toString("hex").toUpperCase()}|`);return"instr(mod_tokens,?)>0";}).join(" OR ")})`;
      });
      return{sql:`mods IS NOT NULL AND ${filter.mode==="exactly"?`json_array_length(mods)=${filter.mods.length} AND `:""}${excludes?"NOT ":""}(${tests.join(excludes||filter.match==="any"?" OR ":" AND ")||"1"})`,params};
    }
    const has=(mod: string) => membership&&mod==="DT" ? "value IN ('DT','NC')" : membership&&mod==="SD" ? "value IN ('SD','PF')" : "value=?";
    const params=filter.mods.filter(mod=>!(membership&&["DT","SD"].includes(mod)));
    const tests=filter.mods.map(mod=>`EXISTS(SELECT 1 FROM json_each(q.mods) WHERE ${has(mod)})`);
    return {sql:`mods IS NOT NULL AND ${filter.mode==="exactly"?`json_array_length(mods)=${filter.mods.length} AND `:""}${excludes?"NOT ":""}(${tests.join(excludes||filter.match==="any"?" OR ":" AND ")||"1"})`,params};
  }
  if(filter.field==="played") {
    let from:number,to:number;
    if(filter.preset==="custom") {from=new Date(filter.from+"T00:00:00").getTime();to=new Date(filter.to+"T00:00:00").getTime();const end=new Date(to);end.setDate(end.getDate()+1);to=end.getTime();}
    else {const start=new Date(asOf);start.setHours(0,0,0,0);if(filter.preset!=="today")start.setDate(start.getDate()-(filter.preset==="7d"?6:29));from=start.getTime();const end=new Date(asOf);end.setHours(24,0,0,0);to=end.getTime();}
    return{sql:"date>=? AND date<?",params:[from,to]};
  }
  const field=filter.field==="stars"?(filter.basis==="map"?"map_stars":"sr"):filter.field;
  const min="op" in filter?(filter.op==="atMost"?null:filter.a):filter.min;
  const max="op" in filter?(filter.op==="atLeast"?null:filter.op==="atMost"?filter.a:filter.b):filter.max;
  const sql:string[]=[],params:SQLInputValue[]=[];
  if(min!==null){sql.push(`${field}>=?`);params.push(min);}if(max!==null){sql.push(`${field}<=?`);params.push(max);}
  return{sql:sql.join(" AND "),params};
}
function where(ctx:Context,filters=ctx.input.filters??[]):Predicate {
  const parts:Predicate[]=[];
  if(ctx.input.search?.trim()){
    const words=Array.from(new Set(ctx.input.search.trim().split(/\s+/)));
    const text=ctx.accelerated?"search_text":"lower(coalesce(title,'')||' '||coalesce(artist,'')||' '||coalesce(difficulty,'')||' '||coalesce(mapper,'')||' '||coalesce(player,''))";
    parts.push(words.length<=64?{sql:words.map(()=>`instr(${text},lower(?))>0`).join(" AND "),params:words}:
      {sql:`NOT EXISTS(SELECT 1 FROM json_each(?) word WHERE instr(${text},lower(word.value))=0)`,params:[JSON.stringify(words)]});
  }
  const scope=ctx.input.scope;
  if(scope?.kind==="favourites")parts.push({sql:"favourite=1",params:[]});
  if(scope?.kind==="recent")parts.push({sql:"date>=? AND date<=?",params:[ctx.asOf-7*86400000,ctx.asOf]});
  if(scope?.kind==="collection")parts.push(collectionPredicate([scope.id],ctx.accelerated));
  parts.push(...filters.map(filter=>predicate(filter,ctx.asOf,ctx.accelerated,ctx.readiness==="live-source",ctx.myNames)));
  return{sql:parts.map(p=>`(${p.sql})`).join(" AND ")||"1",params:parts.flatMap(p=>p.params)};
}
const rankSql=(sort:LibrarySort)=>`CASE WHEN ${sort} IS NOT NULL THEN 0 ${["pp","fc"].includes(sort)?"WHEN completion='failed' THEN 1":""} ELSE 2 END`;
const valueSql=(sort:LibrarySort)=>sort==="title"?"lower(title)":sort;
const numeric=(value:unknown):number|null=>typeof value==="number"&&Number.isFinite(value)?value:null;
const count=(value:unknown):number|null=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:null;
const string=(value:unknown):string|null=>typeof value==="string"?value:null;
const jsonList=(value:unknown):string[]=>JSON.parse(String(value??"[]")) as string[];
function savedJudgements(metadata:Record<string,unknown>):NonNullable<LibraryQueryDetail["savedJudgements"]>{
  const result:NonNullable<LibraryQueryDetail["savedJudgements"]>={great:null,ok:null,meh:null,miss:null,origin:null};
  const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
  const native=object(metadata.nativeScore);
  if(native){
    if(native.ruleset!==0)return result;
    result.origin="native-score";const statistics=object(native.statistics);
    for(const key of ["great","ok","meh","miss"] as const){
      const aliases=[statistics?.[key],statistics?.[key[0].toUpperCase()+key.slice(1)]].filter(value=>value!==undefined);
      if(aliases.length&&aliases.every(value=>count(value)!==null&&value===aliases[0]))result[key]=count(aliases[0]);
    }
    return result;
  }
  const header=object(metadata.header)??object(object(metadata.savedScore)?.header);
  if(!header||header.mode!==0||typeof header.version!=="number"||header.version<0||header.version>=30000000||header.nativeScoreInfo===true||header.sourceFormat==="lazer")return result;
  result.origin="stable-header";const counts=object(header.counts);
  for(const key of ["great","ok","meh","miss"] as const)result[key]=count(counts?.[key]);
  return result;
}
function band(sort:LibrarySort,value:number|string|null,completion:unknown,asOf:number):LibraryQueryItem["band"] {
  if(value===null)return{key:completion==="failed"&&["pp","fc"].includes(sort)?"failed":"missing",label:completion==="failed"&&sort==="pp"?"Failed · no pp awarded":completion==="failed"&&sort==="fc"?"Failed · no FC estimate":`No ${LIBRARY_SORTS[sort].label} data`};
  if(sort==="title") {const initial=String(value).slice(0,1).toUpperCase();return{key:initial,label:initial};}
  const n=Number(value);let label:string;
  if(sort==="date") {const days=(asOf-n)/86400000;label=days<1?"Today":days<7?"This week":days<31?"Last 30 days":"Earlier";}
  else if(sort==="sr")label=`${Math.floor(n)}.00–${Math.floor(n)}.99 ★`;
  else if(sort==="miss")label=n===0?"No misses":n<4?"1–3 misses":n<10?"4–9 misses":"10+ misses";
  else if(sort==="ur")label=n<75?"Under 75 UR":n<90?"75–90 UR":n<110?"90–110 UR":"110+ UR";
  else {
    const thresholds:Partial<Record<LibrarySort,number[]>>={pp:[500,400,300],peak:[500,400,300],fc:[600,500,400],acc:[99,98,95],combo:[1500,1000,500],bpm:[240,200,160],len:[300,240,180,120]};
    const levels=thresholds[sort]??[],i=levels.findIndex(t=>n>=t),fmt=(v:number)=>sort==="len"?`${Math.floor(v/60)}:${String(v%60).padStart(2,"0")}`:String(v),suffix=sort==="acc"?"%":sort==="bpm"?" BPM":["pp","peak","fc"].includes(sort)?" pp":sort==="combo"?" combo":"";
    label=i<0?`Under ${fmt(levels[levels.length-1])}${suffix}`:i===0?`${fmt(levels[i])}+${suffix}`:`${fmt(levels[i])}–${fmt(levels[i-1])}${suffix}`;
  }
  return{key:label,label};
}

const columns=LIBRARY_QUERY_PROJECTION_COLUMNS;
const thresholds:Partial<Record<LibrarySort,number[]>>={pp:[500,400,300],peak:[500,400,300],fc:[600,500,400],acc:[99,98,95],combo:[1500,1000,500],bpm:[240,200,160],len:[300,240,180,120]};
function bandKeySql(ctx:Context):string {
  const {sort,asOf}=ctx;
  let known:string;
  if(sort==="title")known="'title:'||upper(substr(title,1,1))";
  else if(sort==="sr")known="'sr:'||CAST(sr AS INTEGER)";
  else if(sort==="date")known=`CASE WHEN date>${asOf}-86400000 THEN 'today' WHEN date>${asOf}-604800000 THEN 'week' WHEN date>${asOf}-2678400000 THEN 'month' ELSE 'earlier' END`;
  else if(sort==="miss")known="CASE WHEN miss=0 THEN 'miss:0' WHEN miss<4 THEN 'miss:1' WHEN miss<10 THEN 'miss:4' ELSE 'miss:10' END";
  else if(sort==="ur")known="CASE WHEN ur<75 THEN 'ur:0' WHEN ur<90 THEN 'ur:75' WHEN ur<110 THEN 'ur:90' ELSE 'ur:110' END";
  else known=`CASE ${(thresholds[sort]??[]).map((threshold,i)=>`WHEN ${sort}>=${threshold} THEN '${sort}:${i}'`).join(" ")} ELSE '${sort}:under' END`;
  return`CASE ${rankSql(sort)} WHEN 1 THEN 'failed' WHEN 2 THEN 'missing' ELSE ${known} END`;
}
function encodeCursor(ctx:Context,row:Row,inclusive=false):string {
  return Buffer.from(JSON.stringify({version:1,signature:ctx.signature,asOf:ctx.asOf,revision:ctx.revision,rank:Number(row.sort_rank),value:typeof row.sort_value==="string"?row.sort_value:numeric(row.sort_value),id:String(row.id),...(inclusive?{inclusive:true}:{})} satisfies Cursor)).toString("base64url");
}
function keyset(ctx:Context,c:Cursor,inverse=false):Predicate {
  const rank=rankSql(ctx.sort),value=valueSql(ctx.sort),comparison=(ctx.direction==="asc")!==inverse?">":"<",idComparison=inverse?"<":c.inclusive?">=":">";
  return{sql:`(${rank}${inverse?"<":">"}? OR (${rank}=? AND (${c.value===null?`id${idComparison}?`:`${value}${comparison}? OR (${value}=? AND id${idComparison}?)`})))`,params:[c.rank,c.rank,...(c.value===null?[c.id]:[c.value,c.value,c.id])]};
}
type PageOptions={limit?:number;after?:string};
function pageOptions(options:PageOptions,max=100):number {
  if(options===null||typeof options!=="object"||options.limit!==undefined&&(!Number.isInteger(options.limit)||options.limit<1||options.limit>max)||options.after!==undefined&&(typeof options.after!=="string"||options.after.length>131072))throw new Error("Invalid library page options");
  return options.limit??max;
}
function token(id:unknown):asserts id is string {if(typeof id!=="string"||!id.length||id.length>512)throw new Error("Invalid library identity");}
export interface LibraryQueryOrderCapture { ids:string[]; scopeLabel:string; sortLabel:string }

/** Synchronous read-only queries are intended to run inside the library utility process. */
export class LibraryQueryReader {
  private readonly epoch=randomUUID();
  private readonly projected:boolean;
  private readonly accelerated:boolean;
  private readonly scoped:boolean;
  private readonly analysisFallback:boolean;
  private readonly filterEvidence:boolean;
  private readonly filterEvidenceState:boolean;
  private readonly favouriteFilterCover:boolean;
  constructor(private readonly db:Pick<DatabaseSync,"prepare">,private readonly sessionId:string,private readonly now:()=>number=Date.now,
    private readonly options:{revision?:()=>string}={}) {
      registerLibraryPlayerFold(db);
      this.projected=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='query_projection'").get();
      const projectionColumns=new Set(this.projected?db.prepare("PRAGMA table_info(query_projection)").all().map(row=>String(row.name)):[]);
      // Pre-addendum projections use the legacy scalar CTE. Its fields do not
      // include the acceleration tokens or physical rowid of schema20+ caches.
      this.accelerated=projectionColumns.has("search_text")&&projectionColumns.has("filter_evidence_revision");
      this.scoped=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='query_projection_scopes'").get();
      this.analysisFallback=projectionColumns.has("analysis_without_c")&&projectionColumns.has("analysis_algorithm");
      this.filterEvidence=projectionColumns.has("filter_evidence_revision");
      this.filterEvidenceState=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='query_filter_evidence_state'").get();
      this.favouriteFilterCover=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='query_projection_favourite_filter_cover'").get();
    }
  private evidenceCold():boolean {
    return this.filterEvidence&&(!!this.db.prepare(`SELECT 1 FROM query_projection WHERE filter_evidence_revision IS NOT '${LIBRARY_FILTER_EVIDENCE_REVISION}' LIMIT 1`).get()||
      this.filterEvidenceState&&this.db.prepare("SELECT complete FROM query_filter_evidence_state WHERE id=1").get()?.complete===0);
  }
  private cte(ctx?:Context,analysisFacet=false):string{
    if(!this.filterEvidence)return libraryQueryLegacyCte;
    const evidenceCold=this.evidenceCold();
    if(!this.scoped)return evidenceCold?libraryQueryLegacyCte:
      "WITH projected AS (SELECT *,rowid AS query_rowid FROM query_projection WHERE standard_excluded=0)";
    const fresh=`p.filter_evidence_revision='${LIBRARY_FILTER_EVIDENCE_REVISION}'`,recordedFresh=`p.filter_evidence_revision IN ('recorded-filter-evidence-v1','${LIBRARY_FILTER_EVIDENCE_REVISION}')`,metadata="(SELECT metadata FROM replays WHERE id=p.id)",
      cold=(slot:string)=>`(SELECT r.payload FROM metric_targets t JOIN metric_results r ON r.replay_id=t.replay_id AND r.slot=t.slot AND r.stage=t.stage AND r.input_key=t.input_key AND r.producer_version=t.producer_version WHERE t.replay_id=p.id AND t.slot='${slot}')`;
    const player=evidenceCold?`CASE WHEN ${fresh} THEN p.player ELSE ${libraryRecordedPlayerSql(metadata)} END`:"p.player";
    const live=ctx?.readiness==="live-source",visible=`(${live?libraryLiveSourceExistsSql("p.id"):"p.visible=1"}) AND ${evidenceCold?`CASE WHEN ${recordedFresh} THEN p.standard_excluded=0 ELSE NOT ${libraryKnownNonstandardSql("p.id",metadata)} END`:"p.standard_excluded=0"}`;
    const algorithm=libraryQueryAnalysisCurrentSql("p"),status=libraryQueryAnalysisSql("p.id",false);
    // Whole-population analysis predicates must not repeatedly expand correlated
    // fallback expressions. Ordinary pages retain limited, lazy scalar reads.
    // Durable algorithm work and the indexed NULL queue keep the settled probe
    // cheap. Readers never repair the fallback or admit analysis themselves.
    const aggregate=this.analysisFallback&&(analysisFacet||ctx?.input.filters?.some(filter=>filter.field==="astate"))&&
      !!this.db.prepare(`SELECT 1 WHERE ${libraryQueryAnalysisPendingSql()}`).get();
    const fallbackState=aggregate?"coalesce(f.state,'none')":status.state,fallbackError=aggregate?"f.error":status.error;
    const analysis=this.analysisFallback?`coalesce(CASE WHEN ${algorithm} THEN p.analysis_without_c END,${fallbackState})`:"p.analysis";
    const selected=LIBRARY_QUERY_PROJECTION_COLUMNS.split(",").map(value=>value.trim()).map(column=>{
      if(!evidenceCold&&["recording_client","recorded_completion","player_folded","full_combo","perfect_combo","break_evidence"].includes(column))return`p.${column}`;
      if(column==="recording_client")return`CASE WHEN ${recordedFresh} THEN p.recording_client ELSE ${libraryRecordingClientSql("p.id",metadata)} END AS recording_client`;
      if(column==="recorded_completion")return`CASE WHEN ${recordedFresh} THEN p.recorded_completion ELSE ${libraryRecordedCompletionSql(cold("source-score"),cold("numerical"))} END AS recorded_completion`;
      if(column==="player")return`${player} AS player`;
      if(column==="player_folded")return`CASE WHEN ${fresh} THEN p.player_folded ELSE library_player_fold(${player}) END AS player_folded`;
      if(column==="full_combo")return`CASE WHEN ${recordedFresh} THEN p.full_combo ELSE ${libraryRecordedFullComboSql(cold("source-score"),cold("numerical"))} END AS full_combo`;
      if(column==="perfect_combo")return`CASE WHEN ${recordedFresh} THEN p.perfect_combo ELSE ${libraryRecordedPerfectComboSql(cold("source-score"),cold("calculated-map"))} END AS perfect_combo`;
      if(column==="break_evidence")return`CASE WHEN ${recordedFresh} THEN p.break_evidence WHEN ${libraryCompleteBreakEvidenceSql(cold("numerical"))} THEN 1 ELSE 0 END AS break_evidence`;
      if(live&&column==="source_kinds")return`(SELECT json_group_array(kind) FROM (SELECT DISTINCT live_source.kind FROM locations live_location JOIN sources live_source ON live_source.id=live_location.source_id WHERE live_location.replay_id=p.id AND live_source.enabled=1 AND live_source.configured=1 ORDER BY live_source.kind)) AS source_kinds`;
      if(live&&column==="available")return`${libraryLiveSourceExistsSql("p.id","live_location.available=1")} AS available`;
      if(column==="incidents")return"NULL AS incidents";
      if(column==="analysis_error"&&this.analysisFallback)return`CASE WHEN ${algorithm} AND p.analysis_without_c IS NOT NULL THEN p.analysis_error_without_c ELSE ${fallbackError} END AS analysis_error`;
      if(column==="analysis")return analysisFacet?`${analysis} AS analysis`:`CASE WHEN (${analysis}) IN ('queued','analysing') AND coalesce((SELECT json_extract(value,'$.userPaused') FROM settings WHERE key='analysis'),0)=1 THEN 'paused' ELSE ${analysis} END AS analysis`;
      return`p.${column}`;
    });
    // CROSS JOIN preserves sparse job/request drivers and exact candidate→target
    // →result lookup order, avoiding a scan of unrelated cached metric results.
    const fallback=aggregate?`cold_candidates AS MATERIALIZED (
      SELECT p.id FROM query_projection p
      WHERE ${visible} AND ${libraryQueryAnalysisFallbackMissingSql("p")}
    ),cold_facts AS (
      SELECT c.id,j.state,j.error FROM metric_jobs j CROSS JOIN metric_targets t INDEXED BY sqlite_autoindex_metric_targets_1
        ON t.replay_id=j.replay_id AND t.slot=j.slot AND t.stage=j.stage AND t.input_key=j.input_key
          AND t.producer_version=j.producer_version AND t.generation=j.generation
        CROSS JOIN cold_candidates c ON c.id=j.replay_id WHERE j.state IN ('queued','running','failed')
          AND j.stage='S'
      UNION ALL SELECT c.id,a.state,a.error FROM analysis_requests a CROSS JOIN cold_candidates c ON c.id=a.replay_id
        WHERE a.stage='S' AND a.state IN ('queued','running','failed')
      UNION ALL SELECT c.id,'analysed',NULL FROM cold_candidates c
        CROSS JOIN metric_targets t INDEXED BY sqlite_autoindex_metric_targets_1 ON t.replay_id=c.id AND t.slot='numerical'
        CROSS JOIN metric_results r INDEXED BY sqlite_autoindex_metric_results_1 ON r.replay_id=t.replay_id AND r.slot=t.slot
          AND r.stage=t.stage AND r.input_key=t.input_key AND r.producer_version=t.producer_version
    ),cold_status AS MATERIALIZED (
      SELECT id,CASE WHEN max(state='running') THEN 'analysing' WHEN max(state='queued') THEN 'queued'
        WHEN max(state='failed') THEN 'failed' WHEN max(state='analysed') THEN 'analysed' ELSE 'none' END AS state,
        min(CASE WHEN state='failed' THEN error END) AS error FROM cold_facts GROUP BY id
    ),`:"";
    const sourceMask=live?Object.entries(sourceBits).map(([kind,bit])=>`${bit}*${libraryLiveSourceExistsSql("p.id",`live_source.kind='${kind}'`)}`).join("+"):"p.source_mask";
    const search=evidenceCold?`CASE WHEN ${fresh} THEN p.search_text ELSE lower(coalesce(p.title,'')||' '||coalesce(p.artist,'')||' '||coalesce(p.difficulty,'')||' '||coalesce(p.mapper,'')||' '||coalesce(${player},'')) END`:"p.search_text";
    return`WITH ${fallback}projected AS (SELECT ${selected.join(",")},${search} AS search_text,${sourceMask} AS source_mask,p.mod_tokens,p.rowid AS query_rowid
      FROM query_projection p${aggregate?" LEFT JOIN cold_status f ON f.id=p.id":""} WHERE ${visible})`;
  }
  private revision():string {
    // The Store may inject its committed query revision. The fallback is conservative: an
    // unrelated write also invalidates cursors, but never permits stale page membership.
    const names=[...new Set(this.playerNames().map(name=>name.toLowerCase()))].sort();
    return `${this.epoch}:${this.options.revision?.()??`${this.db.prepare("PRAGMA data_version").get()?.data_version}:${this.db.prepare("SELECT total_changes() AS changes").get()?.changes}`}:${hash(names)}`;
  }
  private context(input:LibraryQuery,purpose?:string):Context {
    const revision=this.revision(),readiness=libraryQueryReadiness(this.db);
    if(readiness==="updating")throw new LibraryQueryUpdatingError();
    if(revision!==this.revision())throw new LibraryQueryInvalidatedError();
    return{...context(input,this.now(),revision,purpose,this.accelerated&&(this.scoped||!this.evidenceCold()),readiness),myNames:this.playerNames()};
  }
  /** Small user-kept setting only; never scans replay identities or starts work. */
  playerNames():string[]{
    const value=this.db.prepare("SELECT value FROM settings WHERE key='player-names'").get()?.value;
    if(typeof value!=="string"||Buffer.byteLength(value)>160*1024)return[];
    try{const names:unknown=JSON.parse(value);return Array.isArray(names)&&names.length<=100?names.filter((name):name is string=>typeof name==="string"&&name.length>0&&name.length<=256):[];}catch{return[];}
  }
  private fence(ctx:Context):void {
    if(ctx.revision!==this.revision())throw new LibraryQueryInvalidatedError();
    const readiness=libraryQueryReadiness(this.db);
    if(readiness==="updating")throw new LibraryQueryUpdatingError();
    if(readiness!==ctx.readiness)throw new LibraryQueryInvalidatedError();
  }
  private finish<T>(ctx:Context,result:T):T {
    this.fence(ctx);
    if(result!==null&&typeof result==="object"&&"items" in result)Object.assign(result,{revision:ctx.revision});
    return assertLibraryQueryResponse(result);
  }
  private counts(ctx:Context,extra:Predicate={sql:"1",params:[]}):Omit<LibraryQueryPage,"items"|"next"> {
    const analysis=(ctx.input.filters??[]).filter(f=>["ur","bias"].includes(f.field));
    const base=where(ctx,(ctx.input.filters??[]).filter(f=>!analysis.includes(f)));
    const result=(ctx.input.filters??[]).find(f=>f.field==="result");
    let resultExcluded:LibraryQueryPage["resultExcluded"];
    if(result&&"values" in result&&result.values[0]!=="unknown"){
      const resultBase=where(ctx,(ctx.input.filters??[]).filter(f=>f.field!=="result"));
      const row=this.db.prepare(`${this.cte(ctx)} SELECT coalesce(sum(recorded_completion IS NULL OR recorded_completion NOT IN ('passed','failed')),0) AS unknown_outcome,
        coalesce(sum(recorded_completion='passed' AND break_evidence=0),0) AS missing_break FROM projected q WHERE ${resultBase.sql} AND (${extra.sql})`).get(...resultBase.params,...extra.params);
      resultExcluded={unknownOutcome:Number(row?.unknown_outcome??0),missingBreakEvidence:result.values[0]==="fc"?Number(row?.missing_break??0):0};
    }
    const notes=resultExcluded?{resultExcluded}:{};
    if(!analysis.length)return{total:Number(this.db.prepare(`${this.cte(ctx)} SELECT count(*) AS count FROM projected q WHERE ${base.sql} AND (${extra.sql})`).get(...base.params,...extra.params)?.count??0),analysisExcluded:0,...notes};
    const conditions=analysis.map(filter=>predicate(filter,ctx.asOf,ctx.accelerated));
    const row=this.db.prepare(`${this.cte(ctx)} SELECT coalesce(sum(CASE WHEN ${conditions.map(condition=>`(${condition.sql})`).join(" AND ")} THEN 1 ELSE 0 END),0) AS total,
      coalesce(sum(CASE WHEN ${analysis.map(filter=>`${filter.field} IS NULL`).join(" OR ")} THEN 1 ELSE 0 END),0) AS excluded
      FROM projected q WHERE ${base.sql} AND (${extra.sql})`).get(...conditions.flatMap(condition=>condition.params),...base.params,...extra.params);
    return{total:Number(row?.total??0),analysisExcluded:Number(row?.excluded??0),...notes};
  }
  page(input:LibraryQuery={}):LibraryQueryPage {
    const ctx=this.context(input);return this.pageContext(ctx);
  }
  private pageContext(ctx:Context,extra:Predicate={sql:"1",params:[]}):LibraryQueryPage {
    // Share only IDs, sort keys and predicate flags across counts and page selection.
    // Full row evidence is hydrated only after picking the bounded page IDs.
    const filters=ctx.input.filters??[],analysis=filters.filter(f=>["ur","bias"].includes(f.field)),result=filters.find(f=>f.field==="result");
    const base=where(ctx,filters.filter(f=>!analysis.includes(f)&&f!==result));
    const r=result?predicate(result,ctx.asOf,ctx.accelerated,ctx.readiness==="live-source",ctx.myNames):{sql:"1",params:[]};
    const a=analysis.map(f=>predicate(f,ctx.asOf,ctx.accelerated));
    const analysisSql=a.map(v=>`(${v.sql})`).join(" AND ")||"1",analysisParams=a.flatMap(v=>v.params);
    const noted=!!result&&"values" in result&&result.values[0]!=="unknown",fc=noted&&"values" in result&&result.values[0]==="fc";
    // Missing analysis counts retain Result membership but do not require other
    // analysis comparisons to pass. Result notes omit the Result predicate.
    const flags=[`CASE WHEN (${r.sql}) AND (${analysisSql}) THEN 1 ELSE 0 END AS accepted`,
      analysis.length?`CASE WHEN (${r.sql}) AND (${analysis.map(f=>`${f.field} IS NULL`).join(" OR ")}) THEN 1 ELSE 0 END AS excluded`:"0 AS excluded",
      noted?`CASE WHEN (${analysisSql}) AND (recorded_completion IS NULL OR recorded_completion NOT IN ('passed','failed')) THEN 1 ELSE 0 END AS unknown_outcome`:"0 AS unknown_outcome",
      fc?`CASE WHEN (${analysisSql}) AND recorded_completion='passed' AND break_evidence=0 THEN 1 ELSE 0 END AS missing_break`:"0 AS missing_break"];
    const params:SQLInputValue[]=[...r.params,...analysisParams,...(analysis.length?r.params:[]),...(noted?analysisParams:[]),...(fc?analysisParams:[]),...base.params,...extra.params];
    let seek="";
    if(ctx.cursor){const c=ctx.cursor,comparison=ctx.direction==="asc"?">":"<",idComparison=c.inclusive?">=":">";
      seek=` AND (sort_rank>? OR (sort_rank=? AND (${c.value===null?`id${idComparison}?`:`sort_value${comparison}? OR (sort_value=? AND id${idComparison}?)`})))`;
      params.push(c.rank,c.rank,...(c.value===null?[c.id]:[c.value,c.value,c.id]));
    }
    // Both references must stay inline; materializing projected would copy all wide rows.
    const cte=this.cte(ctx).replace("projected AS (","projected AS NOT MATERIALIZED (");
    const selected=columns.split(",").map(v=>`q.${v.trim()}`).join(",");
    const indexedTitle=ctx.sort==="title"&&ctx.accelerated;
    // Keep the shared title membership/count scan free of text keys. The picker
    // can then follow the existing title expression index and stop at limit+1.
    const sortKeys=`${rankSql(ctx.sort)} AS sort_rank,${valueSql(ctx.sort)} AS sort_value`;
    const picker=indexedTitle?`SELECT id,${sortKeys} FROM query_projection q
      WHERE EXISTS(SELECT 1 FROM matched m WHERE m.id=q.id AND m.accepted=1)${seek}`:
      `SELECT id,sort_rank,sort_value FROM matched WHERE accepted=1${seek}`;
    const raw=this.db.prepare(`${cte}, matched AS MATERIALIZED (
      SELECT id,${indexedTitle?"":sortKeys+","}${flags.join(",")}
      FROM projected q WHERE ${base.sql} AND (${extra.sql})
    ), totals AS (SELECT coalesce(sum(accepted),0) AS query_total,coalesce(sum(excluded),0) AS query_excluded,
      coalesce(sum(unknown_outcome),0) AS query_unknown,coalesce(sum(missing_break),0) AS query_missing FROM matched),
    picked AS MATERIALIZED (${picker}
      ORDER BY sort_rank,sort_value ${ctx.direction},id ASC LIMIT ?)
    SELECT ${selected},${bandKeySql(ctx)} AS band_key,picked.sort_rank,picked.sort_value,
      totals.query_total,totals.query_excluded,totals.query_unknown,totals.query_missing
    FROM totals LEFT JOIN picked ON 1 LEFT JOIN projected q ON q.id=picked.id
    ORDER BY picked.sort_rank,picked.sort_value ${ctx.direction},picked.id ASC`).all(...params,ctx.limit+1) as Row[];
    // The aggregate-left-join retains counts even when no page item matches.
    const counts=raw[0],rows=raw.filter(row=>row.id!==null);let more=rows.length>ctx.limit;if(more)rows.pop();
    const items=rows.map(row=>this.item(row,ctx));
    const response:LibraryQueryPage={items,total:Number(counts?.query_total??0),analysisExcluded:Number(counts?.query_excluded??0),
      ...(noted?{resultExcluded:{unknownOutcome:Number(counts?.query_unknown??0),missingBreakEvidence:Number(counts?.query_missing??0)}}:{})};
    while(items.length>1&&Buffer.byteLength(JSON.stringify(response))>LIBRARY_QUERY_MAX_RESPONSE_BYTES-131072){items.pop();rows.pop();more=true;}
    if(more&&rows.length)response.next=encodeCursor(ctx,rows[rows.length-1]);
    return this.finish(ctx,response);
  }
  private item(row:Row,ctx:Context):LibraryQueryItem {
    const values={} as LibraryQueryItem["values"];
    for(const key of ["pp","peak","fc","acc","combo","miss","ur","sr","bpm","len","date","bias","incidents"] as const)values[key]=numeric(row[key]);
    values.mapStars=numeric(row.map_stars);values.sliderBreaks=numeric(row.slider_breaks);
    return{id:String(row.id),title:string(row.title),artist:string(row.artist),difficulty:string(row.difficulty),mapper:string(row.mapper),player:string(row.player),mods:row.mods===null?null:jsonList(row.mods),grade:string(row.grade),status:string(row.status),completion:string(row.recorded_completion),
      recordingClient:row.recording_client==="stable"||row.recording_client==="lazer"?row.recording_client:"unknown",
      fullCombo:row.full_combo===null?null:row.full_combo===1,perfectCombo:row.perfect_combo===null?null:row.perfect_combo===1,
      favourite:row.favourite===1,review:String(row.review),isNew:row.baseline===0&&row.added_session===this.sessionId,sourceKinds:jsonList(row.source_kinds),collectionIds:jsonList(row.collection_ids),collectionCount:Number(row.collection_count),
      analysis:row.analysis as LibraryQueryItem["analysis"],analysisError:string(row.analysis_error),available:row.available===1,values,
      band:{...band(ctx.sort,ctx.sort==="title"?string(row.title):values[ctx.sort],row.completion,ctx.asOf),key:String(row.band_key)}};
  }
  preview(input:LibraryQuery,draft?:LibraryFilter):LibraryQueryPreview {
    validateLibraryQuery(input);if(draft)validateLibraryFilter(draft);
    const ctx=this.context({...input,cursor:undefined,...(draft?{filters:[...(input.filters??[]).filter(f=>f.field!==draft.field),draft]}:{})}),counts=this.counts(ctx);
    return this.finish(ctx,{count:counts.total,analysisExcluded:counts.analysisExcluded,...(counts.resultExcluded?{resultExcluded:counts.resultExcluded}:{})});
  }
  facets(input:LibraryQuery,field:LibraryFacetField,options:{search?:string;limit?:number;after?:string}={}):LibraryFacetPage {
    if(!["status","mapper","grade","result","player","playedon","source","collection","review","astate"].includes(field)||options.search!==undefined&&(typeof options.search!=="string"||options.search.length>512)||options.after!==undefined&&(typeof options.after!=="string"||options.after.length>131072)||options.limit!==undefined&&(!Number.isInteger(options.limit)||options.limit<1||options.limit>100))throw new Error("Invalid library facets");
    validateLibraryQuery(input);
    const ctx=this.context({...input,cursor:undefined,filters:(input.filters??[]).filter(f=>f.field!==field)}),base=where(ctx),limit=options.limit??100;
    if(field==="collection")return this.collectionFacets(ctx,options);
    const purpose=`facet:${field}:${hash([ctx.signature,options.search??""])}`,after=this.metadataAfter(ctx,options.after,purpose);
    if(field==="result"||field==="playedon"){
      const expressions=field==="result"?{all:"count(*)",passed:"coalesce(sum(recorded_completion='passed'),0)",fc:"coalesce(sum(recorded_completion='passed' AND full_combo=1),0)",failed:"coalesce(sum(recorded_completion='failed'),0)",unknown:"coalesce(sum(recorded_completion IS NULL OR recorded_completion NOT IN ('passed','failed')),0)"}:
        {stable:"coalesce(sum(recording_client='stable'),0)",lazer:"coalesce(sum(recording_client='lazer'),0)",unknown:"coalesce(sum(recording_client='unknown'),0)"};
      const row=this.db.prepare(`${this.cte(ctx)} SELECT ${Object.entries(expressions).map(([key,sql])=>`${sql} AS "${key}"`).join(",")} FROM projected q WHERE ${base.sql}`).get(...base.params);
      const all=Object.keys(expressions),start=after?all.indexOf(after)+1:0,items=all.slice(start).filter(value=>value.toLowerCase().includes((options.search??"").toLowerCase())).map(value=>({value,count:Number(row?.[value]??0)})),more=items.length>limit;
      if(more)items.length=limit;
      return this.finish(ctx,{items,...(more?{next:this.metadataCursor(ctx,items[items.length-1].value,purpose)}:{})});
    }
    if(field==="source"&&ctx.accelerated){
      const rows=this.db.prepare(`${this.cte(ctx)},counts AS (SELECT ${Object.entries(sourceBits).map(([kind,bit])=>`coalesce(sum(${ctx.readiness==="live-source"?libraryLiveSourceExistsSql("q.id",`live_source.kind='${kind}'`):`(source_mask & ${bit})<>0`}),0) AS ${kind}`).join(",")}
        FROM projected q WHERE ${base.sql}),facet AS (${Object.keys(sourceBits).map(kind=>`SELECT '${kind}' AS value,${kind} AS count FROM counts`).join(" UNION ALL ")})
        SELECT value,count FROM facet WHERE count>0 AND instr(lower(value),lower(?))>0 AND value>? ORDER BY value LIMIT ?`).all(...base.params,options.search??"",after,limit+1);
      const more=rows.length>limit;if(more)rows.pop();const items=rows.map(row=>({value:String(row.value),count:Number(row.count)}));
      return this.finish(ctx,{items,...(more?{next:this.metadataCursor(ctx,items[items.length-1].value,purpose)}:{})});
    }
    const expanded=field==="source"?"SELECT q.id,j.value AS value FROM projected q,json_each(q.source_kinds) j":`SELECT q.id,${field} AS value FROM projected q`;
    // Evaluate qualified status once per selected row, then fold counted raw
    // states. Display/search work operates on buckets without widening the
    // materialization or changing ordinary page/status projection.
    const sql=field==="astate"?`${this.cte(ctx,true)},facet AS MATERIALIZED (SELECT analysis AS value FROM projected q WHERE ${base.sql}),
      facet_buckets AS MATERIALIZED (SELECT value,count(*) AS n FROM facet GROUP BY value),
      facet_state AS (SELECT CASE WHEN value IN ('queued','analysing') AND coalesce((SELECT json_extract(value,'$.userPaused') FROM settings WHERE key='analysis'),0)=1 THEN 'paused' ELSE value END AS value,n FROM facet_buckets),
      facet_values AS (SELECT CASE WHEN value IN ('queued','analysing','paused') THEN 'active' ELSE value END AS value,n FROM facet_state)
      SELECT value,sum(n) AS count FROM facet_values WHERE value IS NOT NULL AND instr(lower(value),lower(?))>0 AND value>? GROUP BY value ORDER BY value LIMIT ?`:
      `${this.cte(ctx)},facet AS (${expanded} WHERE ${base.sql}) SELECT value,count(*) AS count FROM facet WHERE value IS NOT NULL AND instr(lower(value),lower(?))>0 AND value>? GROUP BY value ORDER BY value LIMIT ?`;
    const rows=this.db.prepare(sql).all(...base.params,options.search??"",after,limit+1);
    let more=rows.length>limit;if(more)rows.pop();const items=rows.map(row=>({value:String(row.value),count:Number(row.count)}));
    while(items.length>1&&Buffer.byteLength(JSON.stringify(items))>LIBRARY_QUERY_MAX_RESPONSE_BYTES-131072){items.pop();more=true;}
    return this.finish(ctx,{items,...(more?{next:this.metadataCursor(ctx,items[items.length-1].value,purpose)}:{})});
  }
  private collectionFacets(ctx:Context,options:{search?:string;limit?:number;after?:string}):LibraryFacetPage {
    const base=where(ctx),limit=options.limit??100,purpose=`facet:collection:${hash([ctx.signature,options.search??""])}`,after=this.metadataAfter(ctx,options.after,purpose);
    // Deduplicate memberships before projection lookups in the covering case.
    // Active predicates keep their shared materialized identity set below.
    const membershipCount=ctx.accelerated&&base.sql==="1"?
      "SELECT count(*) FROM (SELECT DISTINCT m.replay_id FROM collections child CROSS JOIN memberships m INDEXED BY query_membership_collection WHERE m.collection_id=child.id AND (child.id=c.id OR child.parent_id=c.id)) selected CROSS JOIN filtered f ON f.id=selected.replay_id":ctx.accelerated?
      "SELECT count(DISTINCT f.query_rowid) FROM collections child CROSS JOIN memberships m INDEXED BY query_membership_collection JOIN filtered f ON f.id=m.replay_id WHERE m.collection_id=child.id AND (child.id=c.id OR child.parent_id=c.id)":
      "SELECT count(DISTINCT f.id) FROM filtered f JOIN memberships m ON m.replay_id=f.id JOIN collections child ON child.id=m.collection_id WHERE child.id=c.id OR child.parent_id=c.id";
    // Extra predicates otherwise repeat table/visibility reads for every overlapping
    // child and parent membership. Materialize that filtered identity set once.
    const materialization=ctx.accelerated?(base.sql==="1"?"NOT MATERIALIZED ":"MATERIALIZED "):"";
    // Without active predicates, avoid fetching every wide visible row merely to
    // count favourites. Both indexes already exist; no cached count is maintained.
    const evidenceSettled=!this.evidenceCold();
    const favouriteCount=this.favouriteFilterCover&&base.sql==="1"&&ctx.readiness!=="live-source"&&evidenceSettled?
      "SELECT count(*) FROM query_projection INDEXED BY query_projection_favourite_filter_cover WHERE favourite=1 AND visible=1 AND standard_excluded=0":
      "SELECT count(*) FROM filtered WHERE favourite=1";
    const rows=this.db.prepare(`${this.cte(ctx)},filtered AS ${materialization}(SELECT id,favourite${ctx.accelerated?",query_rowid":""} FROM projected q WHERE ${base.sql}),
      choices AS (SELECT 'fav' AS value,'Favourites' AS label,NULL AS parent_id,NULL AS parent_label,0 AS kind,
        (${favouriteCount}) AS count
        UNION ALL SELECT c.id,c.name,c.parent_id,p.name,1,
          (${membershipCount})
          FROM collections c LEFT JOIN collections p ON p.id=c.parent_id)
      SELECT * FROM choices WHERE instr(lower(label||' '||coalesce(parent_label,'')),lower(?))>0
        AND (?='' OR (?='fav' AND kind=1) OR (?<>'fav' AND kind=1 AND value>?)) ORDER BY kind,value LIMIT ?`)
      .all(...base.params,options.search??"",after,after,after,after,limit+1);
    const more=rows.length>limit;if(more)rows.pop();
    const items=rows.map(row=>({value:String(row.value),label:String(row.label),parentId:string(row.parent_id),parentLabel:string(row.parent_label),count:Number(row.count)}));
    return this.finish(ctx,{items,...(more?{next:this.metadataCursor(ctx,items[items.length-1].value,purpose)}:{})});
  }
  bands(input:LibraryQuery={},options:{limit?:number;cursor?:string}={}):LibraryQueryBandPage {
    validateLibraryQuery(input);const limit=pageOptions({limit:options.limit,after:options.cursor});
    const ctx=this.context({...input,cursor:options.cursor},"bands"),base=where(ctx),params=[...base.params];
    let seek="";if(ctx.cursor){const key=keyset(ctx,ctx.cursor);seek=` AND ${key.sql}`;params.push(...key.params);}
    const rows=this.db.prepare(`${this.cte(ctx)},keyed AS (SELECT id,completion,${ctx.sort},${bandKeySql(ctx)} AS band_key,
      ${rankSql(ctx.sort)} AS sort_rank,${valueSql(ctx.sort)} AS sort_value FROM projected q WHERE ${base.sql}),
      grouped AS (SELECT *,count(*) OVER(PARTITION BY band_key) AS band_count,
        row_number() OVER(PARTITION BY band_key ORDER BY sort_rank,sort_value ${ctx.direction},id) AS band_position FROM keyed)
      SELECT * FROM grouped WHERE band_position=1${seek} ORDER BY sort_rank,sort_value ${ctx.direction},id LIMIT ?`).all(...params,limit+1) as Row[];
    const more=rows.length>limit;if(more)rows.pop();
    const items=rows.map(row=>({key:String(row.band_key),label:band(ctx.sort,ctx.sort==="title"?string(row.title):numeric(row[ctx.sort]),row.completion,ctx.asOf).label,count:Number(row.band_count),anchorId:String(row.id)}));
    return this.finish(ctx,{items,...(more?{next:encodeCursor(ctx,rows[rows.length-1])}:{})});
  }
  private resolve(id:string):string {
    token(id);const seen=new Set<string>();let current=id;
    for(let i=0;i<64;i++){if(seen.has(current))throw new Error("Invalid replay alias cycle");seen.add(current);const row=this.db.prepare("SELECT merged_into FROM replays WHERE id=?").get(current);if(!row?.merged_into)return current;current=String(row.merged_into);}
    throw new Error("Replay alias chain exceeds query bound");
  }
  reveal(input:LibraryQuery,id:string):LibraryQueryReveal {
    validateLibraryQuery(input);const ctx=this.context({...input,cursor:undefined}),base=where(ctx),resolved=this.resolve(id);
    const row=this.db.prepare(`${this.cte(ctx)} SELECT id,${rankSql(ctx.sort)} AS sort_rank,${valueSql(ctx.sort)} AS sort_value FROM projected q WHERE (${base.sql}) AND id=?`).get(...base.params,resolved) as Row|undefined;
    if(!row)return this.finish(ctx,{state:"not-found"});
    const cursor=encodeCursor(ctx,row,true),anchor=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8")) as Cursor,before=keyset(ctx,anchor,true);
    const position=Number(this.db.prepare(`${this.cte(ctx)} SELECT count(*) AS count FROM projected q WHERE (${base.sql}) AND ${before.sql}`).get(...base.params,...before.params)?.count??0);
    return this.finish(ctx,{state:"found",position,page:this.pageContext({...ctx,cursor:anchor})});
  }
  detail(id:string):LibraryQueryDetail|null {
    const ctx=this.context({}),resolved=this.resolve(id);
    const row=this.db.prepare(`${this.cte(ctx)} SELECT ${columns},${bandKeySql(ctx)} AS band_key FROM projected q WHERE id=?`).get(resolved) as Row|undefined;
    if(!row)return this.finish(ctx,null);
    const metrics=this.db.prepare(`SELECT t.slot,t.stage,r.payload FROM metric_targets t JOIN metric_results r ON r.replay_id=t.replay_id AND r.slot=t.slot
      AND r.stage=t.stage AND r.input_key=t.input_key AND r.producer_version=t.producer_version WHERE t.replay_id=?
      AND t.slot<>'incidents'
      ORDER BY t.slot LIMIT 9`).all(resolved)
      .map(result=>{const payload=JSON.parse(String(result.payload)) as Pick<LibraryQueryDetail["metrics"][number],"fields"|"provenance">;return{slot:result.slot as LibraryQueryDetail["metrics"][number]["slot"],stage:result.stage as LibraryQueryDetail["metrics"][number]["stage"],fields:payload.fields,provenance:payload.provenance};});
    if(metrics.length>8)throw new LibraryQueryLimitError("Too many scalar metric slots in selected replay");
    const metadata=JSON.parse(String(this.db.prepare("SELECT metadata FROM replays WHERE id=?").get(resolved)?.metadata??"{}")) as Record<string,unknown>;
    const exactCombo=metrics.find(metric=>metric.slot==="calculated-map")?.fields.exactMapMaxCombo;
    return this.finish(ctx,{item:this.item(row,ctx),mapIdentity:string(row.map_identity),metrics,savedJudgements:savedJudgements(metadata),
      exactMapMaxCombo:exactCombo?.state==="known"?count(exactCombo.value):null});
  }
  sameMap(id:string,input:LibraryQuery={}):LibraryQueryPage {
    validateLibraryQuery(input);const initial=this.context({...input,cursor:undefined}),resolved=this.resolve(id);
    const map=this.db.prepare(`${this.cte(initial)} SELECT map_identity FROM projected q WHERE id=?`).get(resolved)?.map_identity;
    if(typeof map!=="string"||!map)return this.finish(initial,{items:[],total:0,analysisExcluded:0});
    this.fence(initial);
    const ctx={...context(input,this.now(),initial.revision,`same-map:${map}`,this.accelerated,initial.readiness),myNames:initial.myNames};return this.pageContext(ctx,{sql:"map_identity=?",params:[map]});
  }
  private metadataAfter(ctx:Context,after:string|undefined,purpose:string):string {
    if(!after)return "";
    let value:{revision?:unknown;purpose?:unknown;id?:unknown};try{value=JSON.parse(Buffer.from(after,"base64url").toString("utf8")) as typeof value;}catch{throw new Error("Invalid library metadata cursor");}
    if(value.purpose!==purpose||typeof value.id!=="string"||value.id.length>65536)throw new Error("Invalid library metadata cursor");
    if(value.revision!==ctx.revision)throw new LibraryQueryInvalidatedError();return value.id;
  }
  private metadataCursor(ctx:Context,id:string,purpose:string):string{return Buffer.from(JSON.stringify({revision:ctx.revision,id,purpose})).toString("base64url");}
  collectionsPage(options:PageOptions&{parentId?:string|null}={}):LibraryCollectionPage {
    const limit=pageOptions(options),ctx=this.context({});if(options.parentId!==undefined&&options.parentId!==null)token(options.parentId);
    const purpose=`collections:${options.parentId===undefined?"all":options.parentId??"root"}`,after=this.metadataAfter(ctx,options.after,purpose);
    let sequence=-1,afterId="";
    if(after){let key:unknown;try{key=JSON.parse(after);}catch{throw new Error("Invalid collection cursor");}if(!Array.isArray(key)||key.length!==2||!Number.isSafeInteger(key[0])||key[0]<0||typeof key[1]!=="string")throw new Error("Invalid collection cursor");sequence=key[0];afterId=key[1];}
    const predicate=options.parentId===undefined?"1":options.parentId===null?"c.parent_id IS NULL":"c.parent_id=?",params=typeof options.parentId==="string"?[options.parentId]:[];
    const rows=this.db.prepare(`${this.cte(ctx)} SELECT c.id,c.name,c.parent_id,c.palette_index,c.sequence,(SELECT count(*) FROM collections child WHERE child.parent_id=c.id) AS child_count,(SELECT count(DISTINCT x.replay_id) FROM memberships x JOIN collections child ON child.id=x.collection_id
      JOIN projected r ON r.id=x.replay_id WHERE (child.id=c.id OR child.parent_id=c.id)) AS count
      FROM collections c WHERE ${predicate} AND (c.sequence>? OR (c.sequence=? AND c.id>?)) ORDER BY c.sequence,c.id LIMIT ?`).all(...params,sequence,sequence,afterId,limit+1);
    const more=rows.length>limit;if(more)rows.pop();const items=rows.map(row=>({id:String(row.id),name:String(row.name),parentId:string(row.parent_id),paletteIndex:Number(row.palette_index),sequence:Number(row.sequence),count:Number(row.count),childCount:Number(row.child_count)}));
    const total=Number(this.db.prepare(`SELECT count(*) AS count FROM collections c WHERE ${predicate}`).get(...params)?.count??0);
    return this.finish(ctx,{items,total,...(more?{next:this.metadataCursor(ctx,JSON.stringify([items[items.length-1].sequence,items[items.length-1].id]),purpose)}:{})});
  }
  membershipsPage(id:string,options:PageOptions={}):LibraryMembershipPage {
    const limit=pageOptions(options),ctx=this.context({}),resolved=this.resolve(id),purpose=`memberships:${resolved}`,after=this.metadataAfter(ctx,options.after,purpose);
    const rows=this.db.prepare(`SELECT c.id,c.name,c.parent_id,p.name AS parent_name FROM memberships m JOIN collections c ON c.id=m.collection_id
      LEFT JOIN collections p ON p.id=c.parent_id WHERE m.replay_id=? AND c.id>? ORDER BY c.id LIMIT ?`).all(resolved,after,limit+1);
    const more=rows.length>limit;if(more)rows.pop();const items=rows.map(row=>({id:String(row.id),name:String(row.name),parentId:string(row.parent_id),parentName:string(row.parent_name)}));
    const total=Number(this.db.prepare("SELECT count(*) AS count FROM memberships m JOIN collections c ON c.id=m.collection_id WHERE m.replay_id=?").get(resolved)?.count??0);
    return this.finish(ctx,{items,total,...(more?{next:this.metadataCursor(ctx,items[items.length-1].id,purpose)}:{})});
  }
  /** Internal only: callers must retain this vector in the bounded snapshot service, never IPC it. */
  captureOrder(input:LibraryQuery,maxIds:number):LibraryQueryOrderCapture {
    if(!Number.isInteger(maxIds)||maxIds<1||maxIds>200000)throw new Error("Invalid library snapshot ID limit");
    validateLibraryQuery(input);const ctx=this.context({...input,cursor:undefined}),base=where(ctx);
    const rows=this.db.prepare(`${this.cte(ctx)} SELECT id FROM projected q WHERE ${base.sql} ORDER BY ${rankSql(ctx.sort)},${valueSql(ctx.sort)} ${ctx.direction},id LIMIT ?`).all(...base.params,maxIds+1);
    if(rows.length>maxIds)throw new LibraryQueryLimitError(`This result exceeds the ${maxIds.toLocaleString("en-US")}-replay navigation snapshot limit. Narrow the result before opening it.`);
    const scope=input.scope;let scopeLabel=scope?.kind==="favourites"?"Favourites":scope?.kind==="recent"?"Recent":"All replays";
    if(scope?.kind==="collection")scopeLabel=String(this.db.prepare("SELECT name FROM collections WHERE id=?").get(scope.id)?.name??"Collection unavailable");
    this.fence(ctx);return{ids:rows.map(row=>String(row.id)),scopeLabel,sortLabel:LIBRARY_SORTS[ctx.sort].label};
  }
  collections():LibraryCollectionCount[] {
    // Compatibility for small callers; large collections must use the explicit paginated API.
    const page=this.collectionsPage();if(page.next)throw new LibraryQueryLimitError("Use paginated collection metadata for libraries with more than 100 collections.");return page.items;
  }
}
