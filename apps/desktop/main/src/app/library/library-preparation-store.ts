import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { createHash, randomUUID } from "crypto";
import type { LibraryAnalysisReason, LibraryMetricTargetInput, LibraryMetricResult } from "../../../../shared/replay-library-metrics";
import { LibraryMetricStore, LibraryMetricHandoff } from "./library-metric-store";
import { libraryKnownNonstandardSql } from "./library-recorded-evidence";

export type LibraryPreparationStage="P"|"S"|"C";
export type LibraryPreparedTarget=Omit<LibraryMetricTargetInput,"replayId">;
export type LibraryPreparedResult=LibraryPreparedTarget&LibraryMetricResult;
export interface LibraryPreparationRequest {
  replayId:string;stage:LibraryPreparationStage;dependencyKey:string;generation:number;reason:LibraryAnalysisReason;
  state:"queued"|"running"|"failed"|"bound";error?:string;
}
export interface LibraryPreparationTicket extends Omit<LibraryPreparationRequest,"state"|"error"> {attempt:string}
type Row=Record<string,SQLOutputValue>;
interface PreparationDependencies {key:string;availableMap?:string}
type Publication={state:"applied"|"content-changed";replayId:string;handoff?:LibraryMetricHandoff}|{state:"stale"|"source-disabled"};
const priorities:Record<LibraryAnalysisReason,number>={open:0,selection:1,retry:2,background:3};
const stage=(value:unknown):value is LibraryPreparationStage=>typeof value==="string"&&["P","S","C"].includes(value);
const token=(value:unknown):value is string=>typeof value==="string"&&/^[a-zA-Z0-9_.:/+-]{1,128}$/.test(value);
function legacyMapFailure(scope:LibraryPreparationStage,error:unknown):boolean {
  if(typeof error!=="string")return false;
  if(scope==="P"){
    const unavailable="Exact library map is unavailable for performance calculation";
    return error===unavailable||error.startsWith(unavailable+": ");
  }
  return scope==="S"&&(error==="Exact beatmap is unavailable in enabled sources"||error==="Matching beatmap is unavailable"||
    /^(?:ENOENT|ENOTDIR): [^\r\n]+, (?:open|lstat|realpath|stat) '[^\r\n]+\.osu'$/i.test(error));
}
function request(row:Row):LibraryPreparationRequest {
  return {replayId:String(row.replay_id),stage:row.stage as LibraryPreparationStage,dependencyKey:String(row.dependency_key),
    generation:Number(row.generation),reason:row.reason as LibraryAnalysisReason,state:row.state as LibraryPreparationRequest["state"],
    ...(row.error===null?{}:{error:String(row.error)})};
}
function validate(ticket:LibraryPreparationTicket):void {
  if(!ticket||!token(ticket.replayId)||!stage(ticket.stage)||!token(ticket.attempt)||!Number.isSafeInteger(ticket.generation)||ticket.generation<1||
    !/^[a-f0-9]{64}$/.test(ticket.dependencyKey)||!Object.prototype.hasOwnProperty.call(priorities,ticket.reason))throw new Error("Invalid library preparation ticket");
}

/** Durable intent before exact replay/map/profile inputs exist. Never stores frames, handles or causes.
 * Only explicit admission and ingestion/backfill callers request work; passive reads never do. */
export class LibraryPreparationStore {
  constructor(private readonly db:DatabaseSync,private readonly resolveId:(id:string)=>string,
    private readonly transaction:<T>(work:()=>T)=>T,private readonly metrics:LibraryMetricStore,
    private readonly dependencies:(id:string,stage:LibraryPreparationStage)=>PreparationDependencies,private readonly dirty:(flags:number)=>void=()=>undefined,
    private readonly sourceEligible:(id:string)=>boolean=()=>true){}
  static migrate(db:DatabaseSync):void {
    db.exec(`CREATE TABLE analysis_requests(replay_id TEXT NOT NULL REFERENCES replays(id),stage TEXT NOT NULL,
      dependency_key TEXT NOT NULL,generation INTEGER NOT NULL,reason TEXT NOT NULL,state TEXT NOT NULL,attempt TEXT,error TEXT,
      PRIMARY KEY(replay_id,stage));
      CREATE INDEX analysis_requests_queue ON analysis_requests(state,reason,replay_id);
      INSERT OR IGNORE INTO counters VALUES('preparation-generation',0); PRAGMA user_version=11;`);
  }
  recover():void {this.transaction(()=>{
    this.db.exec("DELETE FROM analysis_requests WHERE stage='C'");
    if(this.metrics.analysisSettings().mode==="off")this.clearUnfinishedInTransaction();
    this.db.exec("UPDATE analysis_requests SET state='queued',attempt=NULL,error=NULL WHERE state='running'");
  });}
  clearUnfinishedInTransaction():void {this.db.exec("DELETE FROM analysis_requests WHERE stage IN ('S','C') AND state IN ('queued','running')");}
  private generation():number {
    const value=Number(this.db.prepare("UPDATE counters SET value=value+1 WHERE key='preparation-generation' RETURNING value").get()?.value);
    if(!Number.isSafeInteger(value)||value<1)throw new Error("Library preparation generation exhausted");return value;
  }
  private enabled(id:string):boolean {return this.sourceEligible(id)&&!!this.db.prepare(`SELECT 1 FROM replays r WHERE r.id=? AND NOT ${libraryKnownNonstandardSql("r.id","r.metadata")}
    AND EXISTS(SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id
    WHERE l.replay_id=r.id AND s.enabled=1 AND s.configured=1)`).get(id);}
  private admitted(scope:LibraryPreparationStage,reason:LibraryAnalysisReason):boolean {
    const settings=this.metrics.analysisSettings();return scope!=="C"&&(scope==="P"||settings.mode!=="off"&&(settings.mode!=="demand"||reason!=="background"));
  }
  read(id:string):LibraryPreparationRequest[] {
    return this.db.prepare("SELECT * FROM analysis_requests WHERE replay_id=? ORDER BY stage").all(this.resolveId(id)).map(request);
  }
  /** A preparation can try these exact resources. Their paths do not identify completed mathematics. */
  private attemptKey(scope:LibraryPreparationStage,dependencies:PreparationDependencies):string {
    const {key,availableMap}=dependencies;
    if(!availableMap)return key;
    const select=this.db.prepare(`SELECT m.locator,CASE WHEN ?='S' THEN json_extract(m.metadata,'$.songsRoot') END AS songs_root
      FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation
      JOIN sources s ON s.id=m.source_id WHERE m.md5=? AND m.locator IS NOT NULL AND m.state='unverified'
      AND s.enabled=1 AND s.configured=1 ORDER BY m.source_id,m.source_key LIMIT ?`);
    const paths=new Set<string>();
    for(const row of select.iterate(scope,availableMap,scope==="P"?256:64)){
      const path=JSON.stringify([row.locator,row.songs_root]);
      paths.add(createHash("sha256").update(path).digest("hex"));
    }
    return createHash("sha256").update("library-preparation-map-locators-v1\n").update(key)
      .update(availableMap).update(JSON.stringify([...paths].sort())).digest("hex");
  }
  hasCurrentDependencies(ticket:LibraryPreparationTicket):boolean {
    return this.attemptKey(ticket.stage,this.dependencies(ticket.replayId,ticket.stage))===ticket.dependencyKey;
  }
  request(id:string,scope:LibraryPreparationStage,reason:LibraryAnalysisReason):LibraryPreparationRequest|{state:"disabled"} {
    if(!token(id)||!stage(scope)||!Object.prototype.hasOwnProperty.call(priorities,reason))throw new Error("Invalid library preparation request");
    if(scope==="C")return{state:"disabled"};
    return this.transaction(()=>this.requestInTransaction(id,scope,reason));
  }
  /** Internal ingestion/maintenance composition already owns the SQLite transaction. */
  requestInTransaction(id:string,scope:LibraryPreparationStage,reason:LibraryAnalysisReason):LibraryPreparationRequest|{state:"disabled"} {
    if(!token(id)||!stage(scope)||!Object.prototype.hasOwnProperty.call(priorities,reason))throw new Error("Invalid library preparation request");
      if(scope==="C")return{state:"disabled"};
      const replayId=this.resolveId(id);
      if(!this.enabled(replayId)||!this.admitted(scope,reason))return{state:"disabled"};
      const old=this.db.prepare("SELECT * FROM analysis_requests WHERE replay_id=? AND stage=?").get(replayId,scope);
      const dependencies=this.dependencies(replayId,scope);
      // Ordinary queued work has yet to inspect a file. A released attempt can still
      // carry its observed paths until reclaimed. Completed work keeps the semantic key.
      const hasAttempt=old?.state==="running"||old?.state==="failed"||old?.state==="queued"&&old.dependency_key!==dependencies.key;
      const key=hasAttempt?this.attemptKey(scope,dependencies):dependencies.key;
      if(old?.state==="failed"&&old.dependency_key===dependencies.key&&old.dependency_key!==key&&reason!=="retry"&&
        !legacyMapFailure(scope,old.error)){
        // R33 saved no paths with its failures. Only a recorded map failure with a
        // current candidate gets one recovery attempt. Other failures adopt the baseline.
        this.db.prepare("UPDATE analysis_requests SET dependency_key=? WHERE replay_id=? AND stage=?").run(key,replayId,scope);
        old.dependency_key=key;
      }
      if(scope==="S"&&reason==="retry"&&(!old||["failed","bound"].includes(String(old.state))))
        this.metrics.retryRejectedCoverageInTransaction(replayId);
      if(old&&old.dependency_key===key&&!(reason==="retry"&&["failed","bound"].includes(String(old.state)))) {
        // Until preparation finishes, retry is admission intent as well as priority.
        // Selection/open must not consume permission to replace a failed metric job.
        const pending=["queued","running"].includes(String(old.state));
        const incomingRetry=pending&&reason==="retry"&&this.metrics.readCurrent(replayId)
          .some(entry=>entry.target.stage===scope&&entry.job?.state==="failed"&&!entry.result);
        const pendingRetry=old.reason==="retry"&&pending;
        if(incomingRetry||!pendingRetry&&priorities[reason]<priorities[old.reason as LibraryAnalysisReason]){
          this.db.prepare("UPDATE analysis_requests SET reason=? WHERE replay_id=? AND stage=?").run(reason,replayId,scope);old.reason=reason;
          this.dirty(1);
        }
        // Preparation may have completed while On demand blocked new background metric admission.
        // An explicit request can use those exact targets without opening resources again.
        if(old.state==="bound"&&scope!=="P")this.metrics.admitPreparedInTransaction(this.metrics.readCurrent(replayId)
          .filter(entry=>entry.target.stage===scope).map(entry=>entry.target),old.reason==="retry"?reason:old.reason as LibraryAnalysisReason);
        return request(old);
      }
      // A new explicit retry after terminal preparation must not inherit an old
      // selection/open reason. Completed retry authority is never reused above.
      if(old&&!(reason==="retry"&&["failed","bound"].includes(String(old.state)))&&
        priorities[old.reason as LibraryAnalysisReason]<priorities[reason])reason=old.reason as LibraryAnalysisReason;
      const generation=this.generation();
      this.db.prepare(`INSERT INTO analysis_requests VALUES(?,?,?,?,?,'queued',NULL,NULL) ON CONFLICT(replay_id,stage) DO UPDATE SET
        dependency_key=excluded.dependency_key,generation=excluded.generation,reason=excluded.reason,state='queued',attempt=NULL,error=NULL`)
        .run(replayId,scope,dependencies.key,generation,reason);
      this.dirty(1|(old?.state==="running"?4:0));
      return{replayId,stage:scope,dependencyKey:dependencies.key,generation,reason,state:"queued"};
  }
  nextQueued(limit=16,availableStages?:readonly LibraryPreparationStage[],beforeMetric?:string):LibraryPreparationRequest[] {
    if(!Number.isInteger(limit)||limit<1||limit>128)throw new Error("Invalid library preparation queue limit");
    if(availableStages!==undefined&&(!Array.isArray(availableStages)||!availableStages.length||availableStages.length>3||
      new Set(availableStages).size!==availableStages.length||availableStages.some(value=>!stage(value))))throw new Error("Invalid preparation producers");
    if(beforeMetric!==undefined&&!token(beforeMetric))throw new Error("Invalid preceding metric identity");
    const settings=this.metrics.analysisSettings();if(settings.userPaused)return[];
    const before=beforeMetric?this.db.prepare("SELECT j.reason,r.added_at,r.added_sequence FROM metric_jobs j JOIN replays r ON r.id=j.replay_id WHERE j.id=?").get(beforeMetric):undefined;
    return this.db.prepare(`SELECT a.*,r.added_at,r.added_sequence FROM analysis_requests a JOIN replays r ON r.id=a.replay_id
      WHERE a.state='queued' AND r.merged_into IS NULL AND a.stage<>'C' AND NOT ${libraryKnownNonstandardSql("r.id","r.metadata")}
      ${availableStages?"AND a.stage IN ("+availableStages.map(()=>"?").join(",")+")":""}
      AND EXISTS(SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=a.replay_id AND s.enabled=1 AND s.configured=1)
      AND (a.stage='P' OR (?<>'off' AND (?<>'demand' OR a.reason<>'background')))
      ORDER BY CASE a.reason WHEN 'open' THEN 0 WHEN 'selection' THEN 1 WHEN 'retry' THEN 2 ELSE 3 END,
        r.added_at DESC,r.added_sequence DESC,a.stage LIMIT ?`).all(...(availableStages??[]),settings.mode,settings.mode,limit).filter(row=>{
          if(!before)return true;
          // Internal strip improvement has background priority but is never an
          // admissible preparation/public reason.
          const beforeRank=["strip-repair","clock-enrichment"].includes(String(before.reason))?priorities.background:priorities[before.reason as LibraryAnalysisReason];
          const rank=priorities[row.reason as LibraryAnalysisReason]-beforeRank;
          return rank<0||rank===0&&(Number(row.added_at)>Number(before.added_at)||row.added_at===before.added_at&&Number(row.added_sequence)>Number(before.added_sequence));
        }).map(request);
  }
  claim(id:string,scope:LibraryPreparationStage):LibraryPreparationTicket|undefined {
    if(!token(id)||!stage(scope))throw new Error("Invalid library preparation claim");
    if(scope==="C")return undefined;
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT * FROM analysis_requests WHERE replay_id=? AND stage=? AND state='queued'").get(id,scope);
      if(!row||this.metrics.analysisSettings().userPaused||!this.enabled(id)||!this.admitted(scope,row.reason as LibraryAnalysisReason))return undefined;
      const dependencies=this.dependencies(id,scope),key=this.attemptKey(scope,dependencies),attempt=randomUUID();
      const generation=key===row.dependency_key||dependencies.key===row.dependency_key?Number(row.generation):this.generation();
      this.db.prepare("UPDATE analysis_requests SET dependency_key=?,generation=?,state='running',attempt=?,error=NULL WHERE replay_id=? AND stage=?")
        .run(key,generation,attempt,id,scope);
      return {replayId:id,stage:scope,dependencyKey:key,generation,reason:row.reason as LibraryAnalysisReason,attempt};
    });
  }
  private live(ticket:LibraryPreparationTicket):Row|undefined {
    if(ticket.stage==="C")return undefined;
    return this.db.prepare(`SELECT a.* FROM analysis_requests a JOIN replays r ON r.id=a.replay_id WHERE r.merged_into IS NULL
      AND a.replay_id=? AND a.stage=? AND a.state='running' AND a.dependency_key=? AND a.generation=? AND a.attempt=?`)
      .get(ticket.replayId,ticket.stage,ticket.dependencyKey,ticket.generation,ticket.attempt);
  }
  isEligible(ticket:LibraryPreparationTicket):boolean {validate(ticket);return !!this.live(ticket)&&this.enabled(ticket.replayId)&&
    (ticket.stage==="P"||this.metrics.analysisSettings().mode!=="off");}
  /** A map catalog can publish ahead of its paged replay reconciliation. Retire
   * this live attempt before recording an outcome against superseded resources. */
  private requeueIfInputsChanged(ticket:LibraryPreparationTicket):boolean {
    const dependencies=this.dependencies(ticket.replayId,ticket.stage);
    if(this.attemptKey(ticket.stage,dependencies)===ticket.dependencyKey)return false;
    this.db.prepare("UPDATE analysis_requests SET state='queued',dependency_key=?,generation=?,attempt=NULL,error=NULL WHERE replay_id=? AND stage=?")
      .run(dependencies.key,this.generation(),ticket.replayId,ticket.stage);
    this.dirty(1|4);
    return true;
  }
  release(ticket:LibraryPreparationTicket):"applied"|"stale" {
    validate(ticket);if(ticket.stage==="C")return"stale";
    return this.transaction(()=>{if(!this.live(ticket))return"stale";
      this.db.prepare("UPDATE analysis_requests SET state='queued',attempt=NULL WHERE replay_id=? AND stage=?").run(ticket.replayId,ticket.stage);this.dirty(1);return"applied";});
  }
  fail(ticket:LibraryPreparationTicket,error:string):"applied"|"stale" {
    validate(ticket);if(typeof error!=="string"||!error.trim())throw new Error("Invalid library preparation failure");
    if(ticket.stage==="C")return"stale";
    return this.transaction(()=>{if(!this.live(ticket)||this.requeueIfInputsChanged(ticket))return"stale";
      this.db.prepare("UPDATE analysis_requests SET state='failed',attempt=NULL,error=? WHERE replay_id=? AND stage=?")
        .run(error.slice(0,2048),ticket.replayId,ticket.stage);return"applied";});
  }
  /** publish is an internal LibraryStore CAS, run in this same SQLite transaction. */
  complete(ticket:LibraryPreparationTicket,targets:LibraryPreparedTarget[],publish?:()=>Publication,handoff=false):Publication {
    return this.finish(ticket,targets,publish,handoff);
  }
  /** P mathematics already finished and drained under this preparation reservation. No second job. */
  completeResults(ticket:LibraryPreparationTicket,results:LibraryPreparedResult[],publish:()=>Publication,bind?:(id:string)=>void):Publication {
    if(ticket.stage!=="P"||!Array.isArray(results))throw new Error("Invalid prepared P results");
    return this.finish(ticket,results.map(({slot,stage,inputKey,producerVersion})=>({slot,stage,inputKey,producerVersion})),publish,false,results,bind);
  }
  private finish(ticket:LibraryPreparationTicket,targets:LibraryPreparedTarget[],publish:(()=>Publication)|undefined,handoff:boolean,results?:LibraryPreparedResult[],bind?:(id:string)=>void):Publication {
    validate(ticket);
    if(ticket.stage==="C")return{state:"stale"};
    if(!Array.isArray(targets)||!targets.length||targets.length>4||new Set(targets.map(target=>target.slot)).size!==targets.length||
      targets.some(target=>!target||target.stage!==ticket.stage))throw new Error("Invalid prepared library targets");
    if(typeof handoff!=="boolean"||handoff&&(targets.length!==1||targets[0].slot!=="numerical"||ticket.stage!=="S"))throw new Error("Invalid prepared handoff");
    return this.transaction(()=>{
      const live=this.live(ticket);
      if(!live||!this.enabled(ticket.replayId)||(ticket.stage!=="P"&&this.metrics.analysisSettings().mode==="off")||
        this.requeueIfInputsChanged(ticket))return{state:"stale"};
      const publication=publish?.()??{state:"applied",replayId:ticket.replayId};if(publication.state!=="applied")return publication;
      const replayId=publication.replayId,existing=this.db.prepare("SELECT * FROM analysis_requests WHERE replay_id=? AND stage=?").get(replayId,ticket.stage);
      const reason=existing&&priorities[existing.reason as LibraryAnalysisReason]<priorities[live.reason as LibraryAnalysisReason]
        ?existing.reason as LibraryAnalysisReason:live.reason as LibraryAnalysisReason;
      if(bind)bind(replayId);
      else if(results)for(const result of results)this.metrics.bindPreparedResultInTransaction({...result,replayId},{fields:result.fields,provenance:result.provenance});
      else this.metrics.admitPreparedInTransaction(targets.map(target=>({...target,replayId})),reason);
      this.db.prepare(`INSERT INTO analysis_requests VALUES(?,?,?,?,?,'bound',NULL,NULL) ON CONFLICT(replay_id,stage) DO UPDATE SET
        dependency_key=excluded.dependency_key,generation=excluded.generation,reason=excluded.reason,state='bound',attempt=NULL,error=NULL`)
        .run(replayId,ticket.stage,this.dependencies(replayId,ticket.stage).key,this.generation(),reason);
      return{state:"applied",replayId,...(handoff?{handoff:this.metrics.claimPreparedInTransaction({...targets[0],replayId})}:{})};
    });
  }
  /** Called inside the identity merge; old attempts are never redirected. */
  mergeProvisionalInTransaction(from:string,into:string):void {
    for(const row of this.db.prepare("SELECT * FROM analysis_requests WHERE replay_id=?").all(from)) {
      const existing=this.db.prepare("SELECT * FROM analysis_requests WHERE replay_id=? AND stage=?").get(into,row.stage);
      const reason=existing&&priorities[existing.reason as LibraryAnalysisReason]<priorities[row.reason as LibraryAnalysisReason]?existing.reason:row.reason;
      // Canonical ownership/failures win; incoming intent can promote priority, never revive failure.
      if(existing)this.db.prepare("UPDATE analysis_requests SET reason=? WHERE replay_id=? AND stage=?").run(reason,into,row.stage);
      else {
        const state=["bound","failed"].includes(String(row.state))?row.state:"queued";
        if(state==="queued"&&row.stage!=="P"&&this.metrics.analysisSettings().mode==="off")continue;
        // Dependency evidence is recomputed at claim, after the identity transaction finishes.
        this.db.prepare("INSERT INTO analysis_requests VALUES(?,?,?,?,?,?,NULL,?)")
          .run(into,row.stage,row.dependency_key,this.generation(),reason,state,state==="failed"?row.error:null);
      }
    }
    this.db.prepare("DELETE FROM analysis_requests WHERE replay_id=?").run(from);
  }
}
