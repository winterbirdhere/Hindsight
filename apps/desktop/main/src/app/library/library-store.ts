import { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { randomUUID } from "crypto";
import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { LibraryMetricStore, LibraryMetricHandoff, libraryCapabilityAttempt } from "./library-metric-store";
import { LibraryAnalysisActivityStore } from "./library-analysis-activity";
import { LibraryNumericalRecipeStore } from "./library-numerical-recipe-store";
import { numericalModsHash, numericalProfileKey, validateNumericalRecipe } from "./library-numerical-profile";
import { LibraryIncidentRecipeStore } from "./library-incidents-store";
import { LibraryQueryProjection, registerLibraryPlayerFold, LIBRARY_FILTER_EVIDENCE_REVISION } from "./library-query-projection";
import { LibraryQueryInvalidation, LibraryQueryInvalidationScope } from "./library-query-invalidation";
import { LibraryResourceChangesJournal } from "./library-resource-changes";
import { LibrarySourceAdmission } from "./library-source-admission";
import { LibraryQueryReader } from "./library-query";
import { libraryKnownNonstandardSql } from "./library-recorded-evidence";
import { libraryQueryReadiness } from "./library-query-readiness";
import { LibraryIncidentEvidenceReceipt } from "../../../../shared/library-incidents";
import { LibraryPerformanceCache } from "./library-performance-cache";
import { LibraryPerformanceRecipeStore } from "./library-performance-recipe-store";
import { performanceDependencyKeys } from "./library-performance-dependencies";
import { LIBRARY_P_PRODUCER_VERSION } from "./library-performance-versions";
import { composePerformanceContext,LibraryPerformanceContext,LibraryPerformanceConsumedOrigin } from "./library-performance-context";
import { LibraryPreparationStore, LibraryPreparationTicket, LibraryPreparedTarget, LibraryPreparedResult } from "./library-preparation-store";
import { projectSourceEvidence, projectStableMapEvidence, sourceMapEvidence, LibrarySourceOriginLookup } from "./library-source-binding";
import { LIBRARY_SOURCE_PROJECTION_VERSION, metricInputKey } from "./library-source-metrics";
import type { LibraryCollection, LibraryObservation, LibraryReplayIdentity, LibrarySourceRegistration, ReplayReview, LibraryLocationObservation, LibraryMapObservation, LibraryMapCandidate, LibraryUpdateMode } from "../../../../shared/replay-library";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION,
  LibraryConsumedOrigin, LibraryNumericalInputRecipe, LibraryNumericalResourceDescriptor } from "../../../../shared/library-analysis";
import type { LibraryMetricTicket,LibraryMetricResult,LibraryMetricTarget } from "../../../../shared/replay-library-metrics";
import type { LibraryIncidentEvidenceProbe } from "./library-incidents-probe";
import { libraryTimelineTarget } from "./library-timeline-target";
import { libraryFcTarget } from "./library-fc-target";
import { LibraryCurrentReplayAuthorities, currentReplayDescriptor } from "./library-current-replay-authority";
import type { LibraryCurrentReplayAuthority, LibraryCurrentReplayBindingResult } from "./library-current-replay-authority";
import type { LibraryCurrentReplayPublication, LibraryCurrentReplayResult } from "../../../../shared/library-current-replay";

type Row = Record<string, SQLOutputValue>;
const reviews = new Set<ReplayReview>(["not-reviewed", "reviewed", "needs-another-look"]);
const sourceKinds = new Set(["stable", "replays", "lazer", "imported"]);

function retainFailedObservation(prior: string, failure: Record<string, unknown>): string {
  const retained = JSON.parse(prior) as Record<string, unknown>;
  delete retained.fileState; delete retained.reason;
  retained.fileState = typeof failure.fileState === "string" ? failure.fileState.slice(0, 64) : "unavailable";
  // The available column always carries the current failure; optional detail must not
  // displace verified score/header evidence or escape the persisted metadata budget.
  if (Buffer.byteLength(JSON.stringify(retained)) > 64 * 1024) delete retained.fileState;
  let reason = typeof failure.reason === "string" ? failure.reason.slice(0, 2048) : "";
  while (reason) {
    retained.reason = reason;
    const encoded = JSON.stringify(retained);
    if (Buffer.byteLength(encoded) <= 64 * 1024) return encoded;
    reason = reason.slice(0, Math.floor(reason.length / 2));
  }
  delete retained.reason;
  return JSON.stringify(retained);
}

export interface ImportIntent {
  id: string; sourceId: string; sha256: string; addedAt: number; sessionId: string; metadata: Record<string, unknown>;
}
export interface LibraryLocationTicket {
  replayId: string; sourceId: string; sourceKey: string; locator: string; sha256: string | null;
  locationRevision: number; sourceConfigRevision: number;
  incidentEpochs?:{sourceEpoch:number;locationEpoch:number};
}
export type LibraryLocationRefreshResult = { state: "applied" | "content-changed"; replayId: string;handoff?:LibraryMetricHandoff } | { state: "stale" | "source-disabled" };
export interface LibraryLocationCursor { sourceId: string; sourceKey: string }
export interface LibraryOpenLocation extends LibraryLocationTicket {
  /** Internal analysis policy, never inferred from a file path or used by manual viewer loading. */
  analysisRequiresNative?: true;
  kind: LibrarySourceRegistration["kind"]; directory: string; metadata: Record<string, unknown>;
}
export interface LibraryMapTicket {
  sourceId: string; sourceConfigRevision: number; generation: string; sourceKey: string; md5: string; locator: string;
}
export interface LibraryOpenMap extends LibraryMapTicket {
  kind: LibrarySourceRegistration["kind"]; directory: string; metadata: Record<string, unknown>;
}
export interface LibraryPerformanceMapReceipt {md5:string;sha256:string;ticket?:LibraryMapTicket}
export type LibraryLocationRefresh = Pick<LibraryLocationObservation, "sha256" | "available" | "metadata"> & { locator?: string };
export type LibraryAnalysisLease=({kind:"metric";ticket:LibraryMetricTicket}|{kind:"preparation";ticket:LibraryPreparationTicket})&
  {location?:Pick<LibraryLocationTicket,"sourceId"|"sourceConfigRevision">;map?:Pick<LibraryMapTicket,"sourceId"|"sourceConfigRevision">;
    score?:Pick<LibraryLocationTicket,"sourceId"|"sourceConfigRevision">};

/** Own only app-created SQLite files. Construct in the library utility process, never Electron main/UI. */
export class LibraryStore {
  private static readonly previousCapabilityKey = "library-capability-recovery-stable-prefix-dominant-tempo-v1";
  private static readonly capabilityKey = "library-capability-recovery-initial-input-strip-v3";
  private readonly activity: LibraryAnalysisActivityStore;
  private readonly db: DatabaseSync;
  readonly metrics: LibraryMetricStore;
  readonly preparations: LibraryPreparationStore;
  readonly performanceCache: LibraryPerformanceCache;
  readonly incidents:LibraryIncidentRecipeStore;
  private readonly numericalRecipes: LibraryNumericalRecipeStore;
  private readonly performanceRecipes: LibraryPerformanceRecipeStore;
  private numericalAdmission=false;
  private performanceAdmission=false;
  private dirty=0;
  private dirtyObserver?: (flags:number)=>void;
  private closed = false;
  private queryProjection?:LibraryQueryProjection;
  private mapGarbage?:LibraryQueryInvalidation;
  private sourceAdmission?:LibrarySourceAdmission;
  private maintenanceNeeded?:()=>void;
  private libraryChanged?:()=>void;
  private readonly currentReplayAuthorities=new LibraryCurrentReplayAuthorities();
  createQueryReader():LibraryQueryReader {return new LibraryQueryReader(this.db,this.sessionId,Date.now,{revision:()=>this.queryProjection!.revision()});}
  resourceRevision():string {return this.queryProjection!.resourceRevision();}
  currentChangesSince(since?:string) {return new LibraryResourceChangesJournal(this.db).currentChangesSince(since);}
  onMaintenanceNeeded(callback:()=>void):()=>void {this.maintenanceNeeded=callback;return()=>{if(this.maintenanceNeeded===callback)this.maintenanceNeeded=undefined;};}
  onLibraryChanged(callback:()=>void):()=>void {this.libraryChanged=callback;return()=>{if(this.libraryChanged===callback)this.libraryChanged=undefined;};}

  constructor(path: string, private readonly sessionId: string, private readonly sourceOrigin: LibrarySourceOriginLookup = () => undefined) {
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    try {
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      if (version > 27) throw new Error("Unsupported library database version");
      registerLibraryPlayerFold(this.db);
      // Give indexed library scans a 64 MiB pager-cache target on this connection only.
      // SQLite allocates on demand; this is not a process memory cap or a persisted database default.
      this.db.exec("PRAGMA cache_size=-65536;");
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      if (version === 0) this.transaction(() => {
        this.db.exec(`
          CREATE TABLE sources(id TEXT PRIMARY KEY, kind TEXT NOT NULL, directory TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1, baseline_complete INTEGER NOT NULL DEFAULT 0, generation TEXT);
          CREATE TABLE replays(id TEXT PRIMARY KEY, added_at INTEGER NOT NULL, added_session TEXT NOT NULL,
            added_sequence INTEGER NOT NULL, baseline INTEGER NOT NULL, favourite INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL,
            merged_into TEXT REFERENCES replays(id));
          CREATE TABLE contents(sha256 TEXT PRIMARY KEY, replay_id TEXT NOT NULL REFERENCES replays(id));
          CREATE TABLE locations(source_id TEXT NOT NULL REFERENCES sources(id), source_key TEXT NOT NULL,
            replay_id TEXT NOT NULL REFERENCES replays(id), locator TEXT NOT NULL, sha256 TEXT,
            generation TEXT NOT NULL, available INTEGER NOT NULL, metadata TEXT NOT NULL,
            PRIMARY KEY(source_id, source_key));
          CREATE INDEX locations_replay ON locations(replay_id);
          CREATE TABLE review_edits(sequence INTEGER PRIMARY KEY AUTOINCREMENT, replay_id TEXT NOT NULL REFERENCES replays(id),
            state TEXT NOT NULL CHECK(state IN ('not-reviewed','reviewed','needs-another-look')));
          CREATE INDEX review_replay ON review_edits(replay_id, sequence);
          CREATE TABLE collections(id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
            palette_index INTEGER NOT NULL, sequence INTEGER NOT NULL UNIQUE);
          CREATE TABLE memberships(replay_id TEXT NOT NULL REFERENCES replays(id), collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            PRIMARY KEY(replay_id, collection_id));
          CREATE TABLE counters(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
          INSERT INTO counters VALUES('palette',0);
          PRAGMA user_version=1;
        `);
      });
      if (version < 2) this.transaction(() => {
        this.db.exec(`CREATE TABLE import_intents(id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
          sha256 TEXT NOT NULL, added_at INTEGER NOT NULL, session_id TEXT NOT NULL, metadata TEXT NOT NULL);
          PRAGMA user_version=2;`);
      });
      if (version < 3) this.transaction(() => {
        this.db.exec(`CREATE TABLE map_scans(source_id TEXT PRIMARY KEY REFERENCES sources(id), current_generation TEXT, pending_generation TEXT);
          CREATE TABLE maps(source_id TEXT NOT NULL REFERENCES sources(id), generation TEXT NOT NULL, source_key TEXT NOT NULL,
            md5 TEXT NOT NULL, locator TEXT, state TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(source_id,generation,source_key));
          CREATE INDEX maps_md5 ON maps(md5,source_id,generation);
          PRAGMA user_version=3;`);
      });
      if (version < 4) this.transaction(() => {
        this.db.exec("ALTER TABLE locations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=4;");
      });
      if (version < 5) this.transaction(() => {
        this.db.exec("ALTER TABLE sources ADD COLUMN configured INTEGER NOT NULL DEFAULT 1; PRAGMA user_version=5;");
      });
      if (version < 6) this.transaction(() => {
        this.db.exec("ALTER TABLE sources ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=6;");
      });
      if (version < 7) this.transaction(() => {
        this.db.exec(`ALTER TABLE sources ADD COLUMN scan_explicit_cutoff INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE locations ADD COLUMN explicit_sequence INTEGER NOT NULL DEFAULT 0;
          INSERT OR IGNORE INTO counters VALUES('explicit-publication',0); PRAGMA user_version=7;`);
      });
      if (version < 8) this.transaction(() => {
        this.db.exec(`CREATE TABLE rebuild_runs(id TEXT PRIMARY KEY, explicit_cutoff INTEGER NOT NULL);
          CREATE TABLE rebuild_sources(run_id TEXT NOT NULL REFERENCES rebuild_runs(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL REFERENCES sources(id), config_revision INTEGER NOT NULL,
            complete INTEGER NOT NULL DEFAULT 0, map_state TEXT NOT NULL DEFAULT 'retain', PRIMARY KEY(run_id,source_id));
          CREATE TABLE rebuild_locations(run_id TEXT NOT NULL REFERENCES rebuild_runs(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL, source_key TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(run_id,source_id,source_key));
          CREATE TABLE rebuild_observations(run_id TEXT NOT NULL REFERENCES rebuild_runs(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL, source_key TEXT NOT NULL, observation TEXT NOT NULL, PRIMARY KEY(run_id,source_id,source_key));
          PRAGMA user_version=8;`);
      });
      if (version < 9) this.transaction(() => {
        this.db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          INSERT INTO settings VALUES('update-mode','auto');
          ALTER TABLE sources ADD COLUMN launch_session TEXT;
          PRAGMA user_version=9;`);
      });
      if (version < 10) this.transaction(() => LibraryMetricStore.migrate(this.db));
      if (version < 11) this.transaction(() => LibraryPreparationStore.migrate(this.db));
      if (version < 12) this.transaction(() => LibraryNumericalRecipeStore.migrate(this.db));
      if (version < 13) this.transaction(() => LibraryPerformanceCache.migrate(this.db));
      if (version < 14) this.transaction(() => LibraryPerformanceRecipeStore.migrate(this.db));
      if (version < 15) this.transaction(() => LibraryPerformanceCache.migrateScalars(this.db));
      if(version<16)this.transaction(()=>this.db.exec("ALTER TABLE metric_results ADD COLUMN strip_payload TEXT; PRAGMA user_version=16;"));
      if(version<17)this.transaction(()=>LibraryIncidentRecipeStore.migrate(this.db));
      if(version<18)this.transaction(()=>LibraryIncidentRecipeStore.migrateFreshness(this.db));
      if(version<19)this.transaction(()=>LibraryQueryProjection.migrate(this.db));
      if(version<20)this.transaction(()=>LibraryQueryProjection.migrateAcceleration(this.db));
      if(version<21)this.transaction(()=>{
        LibraryQueryProjection.migrateInvalidation(this.db);
        LibraryQueryInvalidation.migrate(this.db,"map_cleanup_scopes");
        new LibraryQueryInvalidation(this.db,"map_cleanup_scopes").enqueue("discover","upgrade");
      });
      if(version<22)this.transaction(()=>{
        LibrarySourceAdmission.migrate(this.db);LibraryQueryProjection.migrateVisibility(this.db);
      });
      if(version<23)this.transaction(()=>LibraryQueryProjection.migrateIncidentIdentity(this.db));
      if(version<24)this.transaction(()=>LibraryQueryProjection.migrateAnalysisAlgorithm(this.db,version<23));
      if(version<25)this.transaction(()=>LibraryQueryProjection.migrateFilterEvidence(this.db));
      if(version<26)this.transaction(()=>LibraryQueryProjection.migrateObservationInvalidation(this.db));
      if(version<27)this.transaction(()=>LibraryResourceChangesJournal.migrate(this.db));
      this.mapGarbage=new LibraryQueryInvalidation(this.db,"map_cleanup_scopes");
      this.sourceAdmission=new LibrarySourceAdmission(this.db,id=>this.admitAnalysisInTransaction(id));
      this.queryProjection=new LibraryQueryProjection(this.db,{onMapReplay:id=>this.reconcileMapReplayInTransaction(id),
        onSourceReplay:id=>{this.bindSourceScore(id);this.reconcileMapReplayInTransaction(id);},
        onPerformanceReplay:id=>this.performanceRecipes.reconcileInTransaction(id),
      });
      // Private mathematics/LRU bookkeeping is atomic, but does not publish replay
      // changes or consume the independent projection queue. Pending work still wakes maintenance.
      this.performanceCache=new LibraryPerformanceCache(this.db,work=>this.transaction(work,false,false));
      this.metrics = new LibraryMetricStore(this.db, id => this.resolveId(id), work => this.transaction(work), () => this.preparations.clearUnfinishedInTransaction(),
        id=>this.numericalRecipes.reconcileInTransaction(id),flags=>{this.dirty|=flags;},
        id=>this.performanceRecipes.reconcileInTransaction(id),undefined,undefined,
        (target,result)=>this.preserveIndependentPerformance(target,result));
      this.preparations = new LibraryPreparationStore(this.db, id => this.resolveId(id), work => this.transaction(work), this.metrics,
        (id,stage) => stage==="S"?this.numericalPreparationDependencyKey(id):stage==="P"?this.performancePreparationDependencyKey(id):this.incidentPreparationDependencyKey(id),flags=>{this.dirty|=flags;});
      this.numericalRecipes = new LibraryNumericalRecipeStore(this.db,this.metrics,this.sourceOrigin);
      this.performanceRecipes = new LibraryPerformanceRecipeStore(this.db,this.metrics,id=>this.performanceDependencies(id));
      this.incidents=new LibraryIncidentRecipeStore(this.db,this.metrics);
      this.metrics.recover();
      this.preparations.recover();
      this.db.exec("CREATE INDEX IF NOT EXISTS import_intents_cursor ON import_intents(added_at,id)");
      this.db.exec("CREATE INDEX IF NOT EXISTS locations_replay_cursor ON locations(replay_id,source_id,source_key)");
      // An interrupted scan does not establish removals or finish its historical baseline.
      this.db.exec("UPDATE sources SET generation=NULL");
      for(const row of this.db.prepare("SELECT source_id,pending_generation FROM map_scans WHERE pending_generation IS NOT NULL").all())
        this.queueMapGarbage(String(row.source_id),String(row.pending_generation));
      this.db.exec("UPDATE map_scans SET pending_generation=NULL");
      // Staging never established live identities or NEW. A crashed rebuild can be discarded.
      for(const row of this.db.prepare("SELECT source_id,run_id FROM rebuild_sources").all())this.queueMapGarbage(String(row.source_id),String(row.run_id));
      this.db.exec("DELETE FROM rebuild_runs");
      this.activity = new LibraryAnalysisActivityStore(this.db);
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { if (!this.closed) { this.currentReplayAuthorities.clear(); this.db.close(); this.closed = true; } }
  analysisActivity() { return this.activity.read(this.metrics.analysisSettings()); }
  integrityCheck(): string { return String(this.db.prepare("PRAGMA integrity_check").get()?.integrity_check); }
  replayCount(): number {
    // Status counts every indexed canonical standard/unknown-mode identity, including
    // disabled sources. Settled scalar rows avoid JSON; only pending evidence falls back.
    return Number(this.db.prepare(`SELECT count(*) AS n FROM replays r
      LEFT JOIN query_projection q ON q.id=r.id LEFT JOIN query_projection_dirty d ON d.id=r.id
      WHERE r.merged_into IS NULL AND CASE WHEN q.filter_evidence_revision=? AND (d.id IS NULL OR (d.flags & 1)=0)
      THEN q.standard_excluded=0 ELSE NOT ${libraryKnownNonstandardSql("r.id","r.metadata")} END`).get(LIBRARY_FILTER_EVIDENCE_REVISION)?.n);
  }
  sourceEnabled(sourceId: string): boolean { return this.db.prepare("SELECT enabled*configured AS enabled FROM sources WHERE id=?").get(sourceId)?.enabled === 1; }
  /** Historical indexing proves only that this source was found before, never that
   * its current files are readable or a partial scan was a completed baseline. */
  sourceHasIndexHistory(sourceId:string):boolean {
    return !!this.db.prepare(`SELECT 1 FROM sources s WHERE s.id=? AND (s.baseline_complete=1 OR
      EXISTS(SELECT 1 FROM locations l WHERE l.source_id=s.id LIMIT 1))`).get(sourceId);
  }
  updateMode(): LibraryUpdateMode {
    const mode = this.db.prepare("SELECT value FROM settings WHERE key='update-mode'").get()?.value;
    if (!["auto", "launch", "manual"].includes(String(mode))) throw new Error("Invalid stored library update mode");
    return mode as LibraryUpdateMode;
  }
  setUpdateMode(mode: LibraryUpdateMode): void {
    if (!["auto", "launch", "manual"].includes(mode)) throw new Error("Invalid library update mode");
    this.db.prepare("UPDATE settings SET value=? WHERE key='update-mode'").run(mode);
  }
  playerNames():string[] {
    const row=this.db.prepare("SELECT value FROM settings WHERE key='player-names'").get();
    if(!row)return[];
    const names:unknown=JSON.parse(String(row.value));
    return this.validatePlayerNames(names);
  }
  private validatePlayerNames(value:unknown):string[] {
    if(!Array.isArray(value)||value.length>100||value.some(name=>typeof name!=="string"||!name.trim()||name.includes("\0")||name.trim().length>256))
      throw Error("Invalid library player names");
    const seen=new Set<string>();
    return value.map((name:string)=>name.trim()).filter(name=>{const key=name.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});
  }
  setPlayerNames(value:string[]):void {
    const names=this.validatePlayerNames(value);
    if(JSON.stringify(names)===JSON.stringify(this.playerNames()))return;
    this.transaction(()=>{
      this.db.prepare("INSERT INTO settings VALUES('player-names',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(names));
      this.db.prepare("UPDATE query_projection_state SET revision=revision+1 WHERE id=1").run();
    },false);
  }
  claimLaunchScan(sourceId: string): boolean {
    return Number(this.db.prepare(`UPDATE sources SET launch_session=? WHERE id=? AND enabled=1 AND configured=1
      AND launch_session IS NOT ?`).run(this.sessionId, sourceId, this.sessionId).changes) === 1;
  }

  private transaction<T>(work: () => T,project=true,notify=true,wakeMaintenance=true): T {
    this.dirty=0;
    this.db.exec("BEGIN IMMEDIATE");
    let result:T;
    try { result = work();if(project)this.queryProjection?.flushInTransaction(1);this.db.exec("COMMIT"); }
    catch (error) { this.dirty=0;this.db.exec("ROLLBACK"); throw error; }
    const dirty=this.dirty;this.dirty=0;if(dirty)this.dirtyObserver?.(dirty);
    if(notify)this.libraryChanged?.();if(wakeMaintenance&&(this.queryProjectionPending()||this.sourceAdmissionPending()||this.mapGarbagePending()||this.incidentIdentityPending()||this.capabilityRecoveryPending()))this.maintenanceNeeded?.();
    return result;
  }
  onAnalysisDirty(observer:(flags:number)=>void):()=>void {this.dirtyObserver=observer;return()=>{if(this.dirtyObserver===observer)this.dirtyObserver=undefined;};}
  /** Authoritative external snapshots are already published; bounded active checks precede paged reconciliation. */
  externalAnalysisEvidenceChanged():void {this.dirtyObserver?.(4);}
  maintainQueryProjection():{updated:number;pending:number} {
    const projection=this.queryProjection!,revision=projection.revision(),resource=projection.resourceRevision();
    // Only source affiliation copies are redundant with the live reader.
    // Scalar/status changes and unsafe work must publish readiness.
    const sourceOnly=this.queryReadiness()==="live-source"&&
      !this.db.prepare("SELECT 1 FROM query_projection_scopes WHERE kind<>'source-visibility' LIMIT 1").get()&&
      !this.db.prepare("SELECT 1 FROM query_projection_dirty WHERE flags<>8 LIMIT 1").get();
    let analysisDirty=false;
    const result=this.transaction(()=>{const value=projection.flushInTransaction(8);analysisDirty=this.dirty!==0;return value;},false,false);
    if(!sourceOnly||analysisDirty||revision!==projection.revision()||resource!==projection.resourceRevision()||this.queryReadiness()==="updating")this.libraryChanged?.();
    return result;
  }
  queryProjectionPending():number {return this.queryProjection?.pendingCount()??0;}
  queryReadiness(){return libraryQueryReadiness(this.db);}
  incidentIdentityPending():boolean {return this.queryProjection?.identityPending()??false;}
  incidentIdentityStatus(){const projection=this.queryProjection;if(!projection)throw Error("Query projection is not initialized");return projection.identityStatus();}
  maintainIncidentIdentity():{updated:number;pending:boolean} {
    // Bounded metadata compatibility repair; recipe visibility never admits producer work.
    if(!this.incidentIdentityPending())return{updated:0,pending:false};
    if(this.queryProjectionPending())return{updated:0,pending:this.incidentIdentityPending()};
    const projection=this.queryProjection;if(!projection)throw Error("Query projection is not initialized");
    return this.transaction(()=>projection.maintainIdentityInTransaction(),false);
  }
  sourceAdmissionPending():number {return this.sourceAdmission?.pendingCount()??0;}
  maintainSourceAdmission():{processed:number;pending:number} {
    if(this.queryProjectionPending())return{processed:0,pending:this.sourceAdmissionPending()};
    const admission=this.sourceAdmission,projection=this.queryProjection;
    if(!admission||!projection)throw Error("Source admission is not initialized");
    return this.transaction(()=>{
      const result=admission.maintainInTransaction(8);
      // Publish every admitted row's queue badge before this transaction becomes visible.
      projection.flushInTransaction(8);return result;
    },false);
  }
  mapGarbagePending():number {return this.mapGarbage?.pendingCount()??0;}
  private queueMapGarbage(sourceId:string,generation:string|null):void {
    if(generation!==null)this.mapGarbage!.enqueue("generation",JSON.stringify([sourceId,generation]),{sourceId,generation});
  }
  private clearPendingMap(sourceId:string):void {
    const row=this.db.prepare("SELECT pending_generation FROM map_scans WHERE source_id=?").get(sourceId);
    if(row?.pending_generation)this.queueMapGarbage(sourceId,String(row.pending_generation));
    this.db.prepare("UPDATE map_scans SET pending_generation=NULL WHERE source_id=?").run(sourceId);
  }
  /** Garbage collection is separate from read readiness and never deletes a generation
   * before the publication diff has consumed it. No filesystem/source database is touched. */
  maintainMapGarbage(limit=16):{updated:number;pending:number} {
    if(!Number.isInteger(limit)||limit<1||limit>128)throw Error("Invalid map cleanup limit");
    if(this.queryProjectionPending())return{updated:0,pending:this.mapGarbagePending()};
    return this.transaction(()=>{
      const result=this.mapGarbage!.expandInTransaction(limit,(scope,after,bound)=>{
        if(scope.kind==="discover"){
          const rows=this.db.prepare("SELECT rowid AS cursor,source_id,generation FROM maps WHERE rowid>? ORDER BY rowid LIMIT ?").all(Number(after||0),bound+1);
          const more=rows.length>bound;if(more)rows.pop();
          return{ids:[...new Set(rows.map(row=>JSON.stringify([row.source_id,row.generation])))],
            ...(more?{next:String(rows[rows.length-1].cursor).padStart(20,"0")}:{})};
        }
        const {sourceId,generation}=this.mapGarbageLease(scope);
        if(this.db.prepare(`SELECT 1 FROM map_scans WHERE source_id=? AND (current_generation=? OR pending_generation=?)
          UNION ALL SELECT 1 FROM rebuild_sources WHERE source_id=? AND run_id=? LIMIT 1`).get(sourceId,generation,generation,sourceId,generation))return{ids:[]};
        const rows=this.db.prepare("SELECT source_key FROM maps WHERE source_id=? AND generation=? AND source_key>? ORDER BY source_key LIMIT ?")
          .all(sourceId,generation,after,bound+1);const more=rows.length>bound;if(more)rows.pop();
        return{ids:rows.map(row=>String(row.source_key)),...(more?{next:String(rows[rows.length-1].source_key)}:{})};
      },(ids,scope)=>{
        if(scope.kind==="discover")for(const id of ids){const [sourceId,generation]=JSON.parse(id) as [string,string];this.queueMapGarbage(sourceId,generation);}
        else {const lease=this.mapGarbageLease(scope);for(const key of ids)this.db.prepare("DELETE FROM maps WHERE source_id=? AND generation=? AND source_key=?").run(lease.sourceId,lease.generation,key);}
      });
      return{updated:result.processed,pending:result.pending};
    },false,false);
  }
  private mapGarbageLease(scope:LibraryQueryInvalidationScope):{sourceId:string;generation:string} {
    const value=scope.metadata as {sourceId?:unknown;generation?:unknown}|undefined;
    if(scope.kind!=="generation"||!value||typeof value.sourceId!=="string"||typeof value.generation!=="string")throw Error("Invalid map cleanup lease");
    return value as {sourceId:string;generation:string};
  }

  registerSource(source: LibrarySourceRegistration): void {
    if (!source.id || source.id.length > 128 || !sourceKinds.has(source.kind) || !source.directory || source.directory.length > 32768)
      throw new Error("Invalid source registration");
    const existing = this.db.prepare("SELECT kind,directory FROM sources WHERE id=?").get(source.id);
    if (existing && existing.kind !== source.kind) throw new Error("Source kind cannot change");
    if (existing && existing.directory !== source.directory) throw new Error("Source directory cannot change without a new installation identity");
    if(existing)return;
    this.db.prepare(`INSERT INTO sources(id,kind,directory) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET directory=excluded.directory`).run(source.id, source.kind, source.directory);
  }

  /** Configuration membership is independent of the user's saved enabled preference. */
  reconcileSources(sources: readonly LibrarySourceRegistration[]): void {
    if (sources.length > 4 || new Set(sources.map(source => source.id)).size !== sources.length) throw new Error("Invalid source configuration");
    this.transaction(() => {
      const before=this.db.prepare("SELECT id,configured FROM sources").all();
      for (const source of sources) this.registerSource(source);
      const configured=new Set(sources.map(source=>source.id));
      for(const source of before)if(source.configured!==Number(configured.has(String(source.id)))){
        this.db.prepare("UPDATE sources SET configured=?,generation=NULL,config_revision=config_revision+1 WHERE id=?")
          .run(Number(configured.has(String(source.id))),source.id);
        this.clearPendingMap(String(source.id));
        this.dirty|=4;
      }
      if(sources.some(source=>!before.some(prior=>prior.id===source.id)))this.dirty|=4;
    });
  }

  beginScan(sourceId: string): string {
    this.assertNoRebuild(sourceId);
    const source = this.db.prepare("SELECT enabled*configured AS enabled FROM sources WHERE id=?").get(sourceId);
    if (!source || source.enabled !== 1) throw new Error("Source is unavailable or disabled");
    const generation = randomUUID();
    this.db.prepare("UPDATE sources SET generation=?,scan_explicit_cutoff=(SELECT value FROM counters WHERE key='explicit-publication') WHERE id=?").run(generation, sourceId);
    return generation;
  }

  private scan(sourceId: string, generation: string): Row {
    const source = this.db.prepare("SELECT * FROM sources WHERE id=? AND generation=? AND enabled=1 AND configured=1").get(sourceId, generation);
    if (!source) throw new Error("Stale source generation");
    return source;
  }

  stopScan(sourceId: string, generation: string): void {
    this.db.prepare("UPDATE sources SET generation=NULL WHERE id=? AND generation=?").run(sourceId, generation);
  }

  finishScan(sourceId: string, generation: string): void {
    this.transaction(() => {
      const source = this.scan(sourceId, generation);
      this.db.prepare("UPDATE locations SET available=0,revision=revision+1 WHERE source_id=? AND generation<>? AND available<>0 AND explicit_sequence<=?")
        .run(sourceId, generation, source.scan_explicit_cutoff);
      this.db.prepare("UPDATE sources SET generation=NULL,baseline_complete=1 WHERE id=?").run(sourceId);
    });
  }

  setSourceEnabled(sourceId: string, enabled: boolean): void {
    const source=this.db.prepare("SELECT enabled FROM sources WHERE id=?").get(sourceId);
    if(!source||source.enabled===Number(enabled))return;
    this.transaction(()=>{
      this.db.prepare("UPDATE sources SET enabled=?,generation=NULL,config_revision=config_revision+1 WHERE id=?").run(Number(enabled), sourceId);
      this.clearPendingMap(sourceId);this.dirty|=4;
    });
  }

  beginMapScan(sourceId: string): string {
    this.assertNoRebuild(sourceId);
    const source = this.db.prepare("SELECT enabled*configured AS enabled FROM sources WHERE id=?").get(sourceId);
    if (source?.enabled !== 1) throw new Error("Source is unavailable or disabled");
    const generation = randomUUID();
    this.transaction(() => {
      this.clearPendingMap(sourceId);
      this.db.prepare(`INSERT INTO map_scans(source_id,pending_generation) VALUES(?,?)
        ON CONFLICT(source_id) DO UPDATE SET pending_generation=excluded.pending_generation`).run(sourceId, generation);
    });
    return generation;
  }
  private mapScan(sourceId: string, generation: string): void {
    if (!this.db.prepare(`SELECT 1 FROM map_scans m JOIN sources s ON s.id=m.source_id
      WHERE m.source_id=? AND m.pending_generation=? AND s.enabled=1 AND s.configured=1`).get(sourceId, generation)) throw new Error("Stale map generation");
  }
  upsertMap(observation: LibraryMapObservation): void {
    this.mapScan(observation.sourceId, observation.generation);
    this.writeMap(observation);
  }
  private validateMap({ sourceKey, md5, locator, state, metadata }: LibraryMapObservation): void {
    if (!sourceKey || sourceKey.length > 32768 || !/^[a-f\d]{32}$/.test(md5) ||
        (locator !== null && (!locator || locator.length > 32768)) || !["unverified", "invalid-path"].includes(state) ||
        !metadata || typeof metadata !== "object" || Array.isArray(metadata) || Buffer.byteLength(JSON.stringify(metadata)) > 64 * 1024)
      throw new Error("Invalid map observation");
  }
  private writeMap(observation: LibraryMapObservation): void {
    this.validateMap(observation);
    const { sourceId, generation, sourceKey, md5, locator, state, metadata } = observation;
    this.db.prepare(`INSERT INTO maps VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,generation,source_key)
      DO UPDATE SET md5=excluded.md5,locator=excluded.locator,state=excluded.state,metadata=excluded.metadata`)
      .run(sourceId, generation, sourceKey, md5, locator, state, JSON.stringify(metadata));
  }
  stopMapScan(sourceId: string, generation: string): void {
    this.transaction(()=>{
      if(this.db.prepare("SELECT 1 FROM map_scans WHERE source_id=? AND pending_generation=?").get(sourceId,generation))this.clearPendingMap(sourceId);
    },false);
  }
  finishMapScan(sourceId: string, generation: string, reuseEquivalentCatalog = false): void {
    this.transaction(() => {
      this.mapScan(sourceId, generation);
      const old=this.db.prepare("SELECT current_generation FROM map_scans WHERE source_id=?").get(sourceId)?.current_generation;
      if (reuseEquivalentCatalog === true && typeof old === "string") {
        // Compare indexed rows in both directions without materializing a catalog in JS.
        // Exact metadata equality deliberately preserves display/scalar provenance too.
        const difference = this.db.prepare(`SELECT 1 FROM maps candidate WHERE source_id=? AND generation=? AND NOT EXISTS(
          SELECT 1 FROM maps previous WHERE previous.source_id=candidate.source_id AND previous.generation=?
          AND previous.source_key=candidate.source_key AND previous.md5 IS candidate.md5
          AND previous.locator IS candidate.locator AND previous.state IS candidate.state AND previous.metadata IS candidate.metadata) LIMIT 1`);
        if (!difference.get(sourceId, generation, old) && !difference.get(sourceId, old, generation)) {
          this.clearPendingMap(sourceId); return;
        }
      }
      this.db.prepare("UPDATE map_scans SET current_generation=?,pending_generation=NULL WHERE source_id=?").run(generation, sourceId);
      if(old)this.queueMapGarbage(sourceId,String(old));
      this.touchSourceMapRevisionInTransaction();
    });
  }
  mapCandidates(md5: string, limit = 64): { items: LibraryMapCandidate[]; truncated: boolean } {
    if (!/^[a-f\d]{32}$/.test(md5) || !Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid map query");
    const rows = this.db.prepare(`SELECT m.* FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation
      JOIN sources s ON s.id=m.source_id WHERE s.enabled=1 AND s.configured=1 AND m.md5=? ORDER BY m.source_id,m.source_key LIMIT ?`).all(md5, limit + 1);
    return { items: rows.slice(0, limit).map(row => ({ sourceId: String(row.source_id), generation: String(row.generation), sourceKey: String(row.source_key), md5: String(row.md5),
      locator: row.locator === null ? null : String(row.locator), state: row.state as LibraryMapCandidate["state"], metadata: JSON.parse(String(row.metadata)) })),
      truncated: rows.length > limit };
  }

  private assertNoRebuild(sourceId: string): void {
    if (this.db.prepare("SELECT 1 FROM rebuild_sources WHERE source_id=?").get(sourceId)) throw new Error("Source belongs to an active rebuild");
  }

  /** Caller first drains ordinary scans. Live identities and map generations stay visible until
   * one final transaction; imports, refreshes and user edits can proceed while staging yields. */
  beginRebuild(sourceIds: readonly string[]): string {
    if (!sourceIds.length || sourceIds.length > 4 || new Set(sourceIds).size !== sourceIds.length) throw new Error("Invalid rebuild sources");
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM rebuild_runs").get()) throw new Error("A rebuild is already active");
      const id = randomUUID();
      this.db.prepare("INSERT INTO rebuild_runs SELECT ?,value FROM counters WHERE key='explicit-publication'").run(id);
      for (const sourceId of sourceIds) {
        const source = this.db.prepare("SELECT * FROM sources WHERE id=? AND enabled=1 AND configured=1").get(sourceId);
        if (!source) throw new Error("Rebuild source is unavailable or disabled");
        if (source.generation !== null || this.db.prepare("SELECT 1 FROM map_scans WHERE source_id=? AND pending_generation IS NOT NULL").get(sourceId))
          throw new Error("Rebuild requires active scans to drain");
        this.db.prepare("INSERT INTO rebuild_sources(run_id,source_id,config_revision) VALUES(?,?,?)").run(id, sourceId, source.config_revision);
        this.db.prepare("INSERT INTO rebuild_locations SELECT ?,source_id,source_key,revision FROM locations WHERE source_id=?").run(id, sourceId);
      }
      return id;
    });
  }
  private rebuildSource(run: string, sourceId: string, writable = true): Row {
    const row = this.db.prepare(`SELECT r.*,s.kind FROM rebuild_sources r JOIN sources s ON s.id=r.source_id WHERE r.run_id=? AND r.source_id=?`).get(run, sourceId);
    if (!row) throw new Error("Unknown rebuild source");
    if (writable && row.complete === 1) throw new Error("Rebuild source is already complete");
    return row;
  }
  stageRebuildObservation(run: string, observation: Omit<LibraryObservation, "generation">): void {
    this.rebuildSource(run, observation.sourceId);
    this.validateObservation(observation);
    this.db.prepare(`INSERT INTO rebuild_observations VALUES(?,?,?,?) ON CONFLICT(run_id,source_id,source_key)
      DO UPDATE SET observation=excluded.observation`).run(run, observation.sourceId, observation.sourceKey, JSON.stringify(observation));
  }
  stageRebuildMap(run: string, observation: Omit<LibraryMapObservation, "generation">): void {
    if (this.rebuildSource(run, observation.sourceId).kind !== "stable") throw new Error("Only Stable has a separate map index");
    this.writeMap({ ...observation, generation: run });
  }
  finishRebuildSource(run: string, sourceId: string, maps: "complete" | "retain" = "retain"): void {
    const source = this.rebuildSource(run, sourceId);
    if (!["complete", "retain"].includes(maps) || (maps === "complete" && source.kind !== "stable")) throw new Error("Invalid rebuild map state");
    this.db.prepare("UPDATE rebuild_sources SET complete=1,map_state=? WHERE run_id=? AND source_id=?").run(maps, run, sourceId);
  }
  abortRebuild(run: string): void {
    this.transaction(() => {
      for(const source of this.db.prepare("SELECT source_id FROM rebuild_sources WHERE run_id=?").all(run))this.queueMapGarbage(String(source.source_id),run);
      this.db.prepare("DELETE FROM rebuild_runs WHERE id=?").run(run);
    });
  }
  commitRebuild(run: string): { observations: number; preserved: number; removed: number } {
    return this.transaction(() => {
      const rebuild = this.db.prepare("SELECT * FROM rebuild_runs WHERE id=?").get(run);
      if (!rebuild) throw new Error("Unknown rebuild");
      const sources = this.db.prepare(`SELECT s.*,r.complete,r.map_state,r.config_revision AS captured_revision
        FROM rebuild_sources r JOIN sources s ON s.id=r.source_id WHERE r.run_id=?`).all(run);
      for (const source of sources) {
        if (source.complete !== 1) throw new Error("Rebuild is incomplete");
        if (source.enabled !== 1 || source.configured !== 1 || source.config_revision !== source.captured_revision || source.generation !== null)
          throw new Error("Source configuration changed during rebuild");
      }
      const result = { observations: 0, preserved: 0, removed: 0 };
      for (const source of sources) {
        const sourceId = String(source.id);
        // Iterate staged rows, not the live table being updated. No full-library JS array.
        for (const staged of this.db.prepare("SELECT * FROM rebuild_observations WHERE run_id=? AND source_id=? ORDER BY source_key").iterate(run, sourceId)) {
          const base = this.db.prepare("SELECT revision FROM rebuild_locations WHERE run_id=? AND source_id=? AND source_key=?").get(run, sourceId, staged.source_key);
          const current = this.db.prepare("SELECT revision FROM locations WHERE source_id=? AND source_key=?").get(sourceId, staged.source_key);
          if (base?.revision !== current?.revision) { result.preserved++; continue; }
          const observation = JSON.parse(String(staged.observation)) as LibraryObservation;
          this.writeObservation({ ...observation, generation: run }, { ...source, scan_explicit_cutoff: rebuild.explicit_cutoff });
          result.observations++;
        }
        result.removed += Number(this.db.prepare(`UPDATE locations SET available=0,revision=revision+1 WHERE source_id=? AND available<>0
          AND EXISTS(SELECT 1 FROM rebuild_locations b WHERE b.run_id=? AND b.source_id=locations.source_id AND b.source_key=locations.source_key AND b.revision=locations.revision)
          AND NOT EXISTS(SELECT 1 FROM rebuild_observations o WHERE o.run_id=? AND o.source_id=locations.source_id AND o.source_key=locations.source_key)`)
          .run(sourceId, run, run).changes);
        if (source.map_state === "complete") {
          const old=this.db.prepare("SELECT current_generation FROM map_scans WHERE source_id=?").get(sourceId)?.current_generation;
          this.db.prepare(`INSERT INTO map_scans(source_id,current_generation) VALUES(?,?) ON CONFLICT(source_id)
            DO UPDATE SET current_generation=excluded.current_generation,pending_generation=NULL`).run(sourceId, run);
          if(old)this.queueMapGarbage(sourceId,String(old));
        } else this.queueMapGarbage(sourceId,run);
        this.db.prepare("UPDATE sources SET baseline_complete=1 WHERE id=?").run(sourceId);
      }
      if (sources.some(source => source.map_state === "complete")) this.touchSourceMapRevisionInTransaction();
      this.db.prepare("DELETE FROM rebuild_runs WHERE id=?").run(run);
      return result;
    });
  }

  sourceLocations(sourceId: string, after = "", limit = 128): LibraryLocationObservation[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid location page limit");
    return this.db.prepare("SELECT * FROM locations WHERE source_id=? AND source_key>? ORDER BY source_key LIMIT ?")
      .all(sourceId, after, limit).map(row => this.location(row));
  }
  sourceObservation(sourceId: string, sourceKey: string): LibraryLocationObservation | undefined {
    const row = this.db.prepare("SELECT * FROM locations WHERE source_id=? AND source_key=?").get(sourceId, sourceKey);
    return row ? this.location(row) : undefined;
  }
  private location(row: Row): LibraryLocationObservation {
    return { sourceKey: String(row.source_key), locator: String(row.locator), available: row.available === 1,
      sha256: row.sha256 === null ? null : String(row.sha256), metadata: JSON.parse(String(row.metadata)), expectedRevision: Number(row.revision) };
  }

  /** Explicit open preparation only: bounded metadata pages, no filesystem or analysis work.
   * A location marked missing can be retried here; its last observation is not proof of current bytes. */
  openLocationCandidates(inputId: string, after?: LibraryLocationCursor, limit = 8, analysis = false): { items: LibraryOpenLocation[]; next?: LibraryLocationCursor } {
    if (typeof analysis !== "boolean") throw new Error("Invalid analysis resource policy");
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("Invalid selected location page limit");
    if (after && (typeof after.sourceId !== "string" || after.sourceId.length > 128 ||
        typeof after.sourceKey !== "string" || after.sourceKey.length > 32768)) throw new Error("Invalid selected location cursor");
    const replayId = this.resolveId(inputId);
    // Exact native provenance belongs to the replay identity, not the alphabetically first path.
    // Disabled/missing native locations still establish that a legacy wrapper is not safely Stable.
    // Only analysis applies this policy; foreground/F2 candidate ordering is unchanged.
    const nativeEvidence = `s.kind='lazer' AND l.sha256 IS NOT NULL
      AND json_type(l.metadata,'$.nativeScore.isLegacyScore')='false'
      AND json_extract(l.metadata,'$.nativeScore.replay.sha256')=l.sha256`;
    const requireNative = analysis && !!this.db.prepare(`SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? AND ${nativeEvidence} LIMIT 1`).get(replayId);
    const rows = this.db.prepare(`SELECT l.*,s.kind,s.directory,s.config_revision FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? AND s.configured=1 AND s.enabled=1 AND
      ${requireNative ? nativeEvidence + " AND" : ""}
      (l.source_id,l.source_key)>(?,?) ORDER BY l.source_id,l.source_key LIMIT ?`)
      .all(replayId, after?.sourceId ?? "", after?.sourceKey ?? "", limit + 1);
    const items: LibraryOpenLocation[] = [];
    let pageBytes = 0;
    for (const row of rows.slice(0, limit)) {
      const item: LibraryOpenLocation = { replayId, sourceId: String(row.source_id), sourceKey: String(row.source_key),
        ...(requireNative ? {analysisRequiresNative:true as const} : {}),
        locator: String(row.locator), sha256: row.sha256 === null ? null : String(row.sha256),
        locationRevision: Number(row.revision), sourceConfigRevision: Number(row.config_revision),
        kind: String(row.kind) as LibrarySourceRegistration["kind"], directory: String(row.directory), metadata: JSON.parse(String(row.metadata)),
      };
      const bytes = Buffer.byteLength(JSON.stringify(item));
      // Leave room for a maximally escaped cursor and the utility's 2MiB envelope.
      if (items.length && pageBytes + bytes > 1024 * 1024) break;
      items.push(item); pageBytes += bytes;
    }
    const last = items[items.length - 1];
    return { items, ...(rows.length > items.length && last ? { next: { sourceId: last.sourceId, sourceKey: last.sourceKey } } : {}) };
  }

  /** Resolve/hash outside SQLite, then compare both revisions before publishing. */
  acquireLocationTicket(inputId: string, sourceId: string, sourceKey: string): LibraryLocationTicket | undefined {
    const id = this.resolveId(inputId);
    const row = this.db.prepare(`SELECT l.*,s.config_revision FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.source_id=? AND l.source_key=? AND s.configured=1 AND s.enabled=1`).get(sourceId, sourceKey);
    if (!row || this.resolveId(String(row.replay_id)) !== id) return undefined;
    return { replayId: id, sourceId, sourceKey, locator: String(row.locator), sha256: row.sha256 === null ? null : String(row.sha256),
      locationRevision: Number(row.revision), sourceConfigRevision: Number(row.config_revision) };
  }

  /** Opening a Stable map uses its own source epoch: a replay may come from a different source. */
  openMapCandidates(md5: string, after?: LibraryLocationCursor, limit = 8): { items: LibraryOpenMap[]; next?: LibraryLocationCursor } {
    if (!/^[a-f\d]{32}$/.test(md5) || !Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("Invalid selected map request");
    if (after && (typeof after.sourceId !== "string" || after.sourceId.length > 128 ||
        typeof after.sourceKey !== "string" || after.sourceKey.length > 32768)) throw new Error("Invalid selected map cursor");
    const rows = this.db.prepare(`SELECT m.*,s.config_revision,s.kind,s.directory FROM maps m
      JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation JOIN sources s ON s.id=m.source_id
      WHERE m.md5=? AND m.locator IS NOT NULL AND m.state='unverified' AND s.enabled=1 AND s.configured=1
      AND (m.source_id,m.source_key)>(?,?) ORDER BY m.source_id,m.source_key LIMIT ?`)
      .all(md5, after?.sourceId ?? "", after?.sourceKey ?? "", limit + 1);
    const items: LibraryOpenMap[] = []; let pageBytes = 0;
    for (const row of rows.slice(0, limit)) {
      const item: LibraryOpenMap = { sourceId: String(row.source_id), sourceConfigRevision: Number(row.config_revision),
        generation: String(row.generation), sourceKey: String(row.source_key), md5: String(row.md5), locator: String(row.locator),
        kind: String(row.kind) as LibrarySourceRegistration["kind"], directory: String(row.directory), metadata: JSON.parse(String(row.metadata)) };
      const bytes = Buffer.byteLength(JSON.stringify(item));
      if (items.length && pageBytes + bytes > 1024 * 1024) break;
      items.push(item); pageBytes += bytes;
    }
    const last = items[items.length - 1];
    return { items, ...(rows.length > items.length && last ? { next: { sourceId: last.sourceId, sourceKey: last.sourceKey } } : {}) };
  }

  commitLocationRefresh(ticket: LibraryLocationTicket, observation: LibraryLocationRefresh, map?: LibraryMapTicket): LibraryLocationRefreshResult {
    return this.transaction(() => this.commitLocationRefreshInTransaction(ticket, observation, map));
  }
  private commitLocationRefreshInTransaction(ticket: LibraryLocationTicket, observation: LibraryLocationRefresh, map?: LibraryMapTicket,admit=true): LibraryLocationRefreshResult {
      if (map && !this.db.prepare(`SELECT 1 FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation
        JOIN sources s ON s.id=m.source_id WHERE m.source_id=? AND m.generation=? AND m.source_key=? AND m.md5=? AND m.locator=?
        AND s.config_revision=? AND s.configured=1 AND s.enabled=1`).get(map.sourceId, map.generation, map.sourceKey, map.md5, map.locator, map.sourceConfigRevision))
        return { state: "stale" };
      const source = this.db.prepare("SELECT * FROM sources WHERE id=?").get(ticket.sourceId);
      if (!source || source.enabled !== 1 || source.configured !== 1) return { state: "source-disabled" };
      const current = this.db.prepare("SELECT * FROM locations WHERE source_id=? AND source_key=?").get(ticket.sourceId, ticket.sourceKey);
      if (!current || Number(source.config_revision) !== ticket.sourceConfigRevision || Number(current.revision) !== ticket.locationRevision ||
          current.locator !== ticket.locator || current.sha256 !== ticket.sha256 ||
          this.resolveId(String(current.replay_id)) !== this.resolveId(ticket.replayId)) return { state: "stale" };
      const changed = ticket.sha256 !== null && observation.sha256 !== null && ticket.sha256 !== observation.sha256;
      if (observation.locator !== undefined && observation.locator !== ticket.locator && (!observation.available || !observation.sha256))
        throw new Error("A replacement locator requires verified replay bytes");
      const replayId = this.writeObservation({ ...observation, sourceId: ticket.sourceId, sourceKey: ticket.sourceKey,
        locator: observation.locator ?? ticket.locator, generation: String(source.generation ?? current.generation), addedAt: Date.now(), expectedRevision: ticket.locationRevision }, source, this.sessionId, true,admit);
      return { state: changed ? "content-changed" : "applied", replayId };
  }

  /** Trusted verified resource publication, with no preparation or metric job admission. */
  bindCurrentReplay(location:LibraryLocationTicket,observation:LibraryLocationRefresh,map:LibraryMapTicket|undefined,
    input:LibraryNumericalResourceDescriptor):LibraryCurrentReplayBindingResult {
    const descriptor=currentReplayDescriptor(input),binding=descriptor.input.binding;
    if(!observation.available||observation.sha256!==binding.replaySha256||map&&map.md5!==binding.mapMd5)
      throw new Error("Current replay resource identity mismatch");
    if(!binding.exactMapAndProfile)return{state:"stale"};
    const stale={};
    try {
      const bound=this.transaction(()=>{
        if(!this.db.prepare("SELECT 1 FROM replays WHERE id=? AND merged_into IS NULL").get(location.replayId)||
          location.sha256!==null&&location.sha256!==observation.sha256||!this.consumedOriginMatches(binding.replaySha256,descriptor.origin))throw stale;
        const existing=this.db.prepare("SELECT replay_id FROM contents WHERE sha256=?").get(binding.replaySha256);
        if(existing&&existing.replay_id!==location.replayId)throw stale;
        if(this.knownNonstandard(location.replayId))throw stale;
        const refreshed=this.commitLocationRefreshInTransaction(location,observation,map,false);
        if(refreshed.state==="source-disabled")return refreshed;
        if(refreshed.state!=="applied"||refreshed.replayId!==location.replayId)throw stale;
        if(this.knownNonstandard(refreshed.replayId))throw stale;
        if(!this.numericalRecipes.bindInTransaction(refreshed.replayId,descriptor.target,descriptor.recipe))throw stale;
        this.numericalRecipes.reconcileInTransaction(refreshed.replayId);
        const numerical=this.metrics.read(refreshed.replayId).find(entry=>entry.target.slot==="numerical")?.target;
        if(!numerical||numerical.inputKey!==descriptor.target.inputKey||numerical.producerVersion!==descriptor.target.producerVersion)throw stale;
        const native=descriptor.recipe.intrinsicNative||descriptor.recipe.embeddedModsHash!==null||descriptor.origin?.client==="lazer"||
          !!this.db.prepare(`SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=? AND l.sha256=? AND s.kind='lazer'
            AND json_type(l.metadata,'$.nativeScore.isLegacyScore')='false' AND json_extract(l.metadata,'$.nativeScore.replay.sha256')=l.sha256 LIMIT 1`)
            .get(refreshed.replayId,binding.replaySha256);
        const current=this.acquireLocationTicket(refreshed.replayId,location.sourceId,location.sourceKey);if(!current)throw stale;
        return {state:"applied" as const,replayId:refreshed.replayId,authority:{version:1 as const,replayId:refreshed.replayId,
          numericalTarget:numerical,binding,sourceLease:{location:current,...(map?{map:{...map}}:{})}},ruleset:native?"lazer" as const:"stable" as const};
      });
      if(bound.state!=="applied")return bound;
      const authority=this.currentReplayAuthorities.issue({authority:bound.authority,descriptor,ruleset:bound.ruleset});
      return{state:"applied",replayId:bound.replayId,authority};
    }catch(error){if(error===stale)return{state:"stale"};throw error;}
  }
  releaseCurrentReplay(authority:LibraryCurrentReplayAuthority):void {this.currentReplayAuthorities.release(authority);}
  /** Synchronous exact-source/target CAS. Off permits observations, never new work. */
  publishCurrentReplay(authority:LibraryCurrentReplayAuthority,results:LibraryCurrentReplayResult[]):LibraryCurrentReplayPublication {
    const entry=this.currentReplayAuthorities.get(authority);if(!entry)return{state:"stale",accepted:[]};
    if(!Array.isArray(results)||!results.length||results.length>3||new Set(results.map(result=>result.slot)).size!==results.length||
      results.some(result=>!["numerical","timeline-pp","fc-pp"].includes(result.slot)))throw new Error("Invalid current replay slots");
    return this.transaction(()=>{
      const {descriptor,ruleset}=entry,{binding,sourceLease,numericalTarget}=entry.authority;
      if(!this.currentReplayLeaseMatches(sourceLease)||!this.consumedOriginMatches(binding.replaySha256,descriptor.origin))return{state:"stale",accepted:[]};
      if(this.knownNonstandard(authority.replayId))return{state:"stale",accepted:[]};
      this.numericalRecipes.reconcileInTransaction(authority.replayId);
      const numerical=this.metrics.read(authority.replayId).find(value=>value.target.slot==="numerical")?.target;
      if(!numerical||Object.keys(numericalTarget).some(key=>numerical[key as keyof typeof numerical]!==numericalTarget[key as keyof typeof numericalTarget]))return{state:"stale",accepted:[]};
      const accepted:LibraryCurrentReplayPublication["accepted"]=[];let changed=false;
      for(const result of [...results].sort((a,b)=>["numerical","timeline-pp","fc-pp"].indexOf(a.slot)-["numerical","timeline-pp","fc-pp"].indexOf(b.slot))){
        const expected=result.slot==="numerical"?numerical:result.slot==="timeline-pp"?libraryTimelineTarget(numerical):libraryFcTarget(numerical);
        const proof=result.metrics?.provenance;
        if(!proof||result.producerVersion!==expected.producerVersion||proof.projectionVersion!==expected.producerVersion||
          proof.replaySha256!==binding.replaySha256||proof.mapSha256!==binding.mapSha256||proof.mapMd5!==binding.mapMd5||
          proof.parserVersion!==LIBRARY_REPLAY_PARSER_VERSION||proof.preparationVersion!==LIBRARY_RESOURCE_PREPARATION_VERSION||
          proof.scoreOrigin!=="reconstructed"||typeof proof.coverageQualified!=="boolean"||typeof proof.rate!=="number"||!Number.isFinite(proof.rate)||proof.rate<=0||
          result.slot!=="numerical"&&proof.engineVersion!==PERFORMANCE_ENGINE_VERSION||
          !(ruleset==="stable"?["stable"]:result.slot==="numerical"?["lazer"]:["lazer","lazer-classic"]).includes(String(proof.ruleset)))
          throw new Error("Current replay projection binding mismatch");
        if(result.metrics.errorStrip?.state==="known"&&(proof.coverageQualified!==true||result.metrics.errorStrip.value.ruleset!==ruleset))
          throw new Error("Current replay strip binding mismatch");
        const target=this.metrics.read(authority.replayId).find(value=>value.target.slot===result.slot)?.target;
        // Ready P FC remains authoritative. Incompatible current targets cannot be retargeted by a result.
        if(!target||target.stage!==expected.stage||target.inputKey!==expected.inputKey||target.producerVersion!==expected.producerVersion)continue;
        if(result.slot!=="numerical"){
          const state=this.metrics.read(authority.replayId).find(value=>value.target.slot==="numerical")?.result;
          if(!state)continue;
          const passed=state.provenance.coverageQualified===true&&state.fields.completion?.state==="known"&&state.fields.completion.value==="passed";
          if(result.slot==="fc-pp"&&!passed)continue;
          if(result.slot==="timeline-pp"&&result.metrics.fields.pp?.state==="known"&&!passed)throw new Error("Current replay completion is not established");
        }
        const outcome=this.metrics.publishObservedInTransaction(target,result.metrics,true);
        if(outcome==="stale")throw new Error("Current replay target changed inside transaction");
        accepted.push(result.slot);changed=changed||outcome==="applied";
        if(result.slot==="numerical")this.metrics.reconcileFcTargetInTransaction(numerical);
      }
      return{state:changed?"applied":accepted.length?"cached":"unavailable",accepted};
    });
  }
  resourceLeaseCurrent(location:LibraryLocationTicket,map?:LibraryMapTicket):boolean {return this.currentReplayLeaseMatches({location,map},true);}
  private currentReplayLeaseMatches(lease:LibraryCurrentReplayAuthority["sourceLease"],allowSourceOnly=false):boolean {
    const {location,map}=lease;
    if(!allowSourceOnly&&location.sha256===null)return false;
    if(!this.db.prepare(`SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id JOIN replays r ON r.id=l.replay_id
      WHERE r.merged_into IS NULL AND l.replay_id=? AND l.source_id=? AND l.source_key=? AND l.locator=? AND l.sha256 IS ? AND l.revision=?
      AND s.config_revision=? AND s.enabled=1 AND s.configured=1`).get(location.replayId,location.sourceId,location.sourceKey,location.locator,
        location.sha256,location.locationRevision,location.sourceConfigRevision))return false;
    return !map||!!this.db.prepare(`SELECT 1 FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation
      JOIN sources s ON s.id=m.source_id WHERE m.source_id=? AND m.generation=? AND m.source_key=? AND m.md5=? AND m.locator=?
      AND s.config_revision=? AND s.configured=1 AND s.enabled=1`).get(map.sourceId,map.generation,map.sourceKey,map.md5,map.locator,map.sourceConfigRevision);
  }

  confirmAnalysisResources(ticket: LibraryMetricTicket, location: LibraryLocationTicket, observation: LibraryLocationRefresh,
    origin: LibraryConsumedOrigin, map?: LibraryMapTicket, recipe?:LibraryNumericalInputRecipe,incidentEvidence?:LibraryIncidentEvidenceReceipt): LibraryLocationRefreshResult {
    void incidentEvidence; // Legacy clients may send it; library C no longer consumes it.
    if(ticket.replayId!==location.replayId||!observation.available||!observation.sha256)throw new Error("Analysis confirmation requires its own verified location");
    return this.transaction(()=>{
      if(!this.metrics.isLiveTicket(ticket)||!this.consumedOriginMatches(observation.sha256 as string,origin))return{state:"stale"};
      const result=this.commitLocationRefreshInTransaction(location,observation,map);
      if(result.state!=="applied")return result;
      if(!this.metrics.isLiveTicket(ticket))return{state:"stale"};
      if(recipe){
        const numerical=ticket.slot!=="numerical"?this.metrics.read(result.replayId).find(entry=>entry.target.slot==="numerical")?.target:ticket;
        if(!numerical||!this.numericalRecipes.bindInTransaction(result.replayId,numerical,recipe))return{state:"stale"};
      }
      if(!recipe&&ticket.slot==="numerical"&&ticket.producerVersion===LIBRARY_NUMERIC_PROJECTION_VERSION)throw new Error("Numerical recipe required");
      return this.metrics.isLiveTicket(ticket)?result:{state:"stale"};
    });
  }
  analysisEligible(lease:LibraryAnalysisLease):boolean {
    if(!lease||!["metric","preparation"].includes(lease.kind))throw new Error("Invalid analysis lease");
    // Preparation eligibility only reads its lease. Metric eligibility also
    // reconciles recipes and retains the ordinary projection/notification path.
    const reconciles=lease.kind==="metric";
    return this.transaction(()=>{
      for(const source of [lease.location,lease.map,lease.score])if(source){
        if(typeof source.sourceId!=="string"||!Number.isSafeInteger(source.sourceConfigRevision))throw new Error("Invalid analysis source lease");
        if(!this.db.prepare("SELECT 1 FROM sources WHERE id=? AND config_revision=? AND enabled=1 AND configured=1").get(source.sourceId,source.sourceConfigRevision))return false;
      }
      if(lease.kind==="preparation")return this.preparations.isEligible(lease.ticket);
      this.numericalRecipes.reconcileInTransaction(lease.ticket.replayId);return this.metrics.isEligible(lease.ticket);
    },reconciles,reconciles);
  }
  private consumedOriginMatches(sha256: string, origin: LibraryConsumedOrigin): boolean {
    if (origin !== null && (!origin || typeof origin !== "object" || Array.isArray(origin) ||
      !["stable","lazer"].includes(origin.client) || origin.provenance !== "user-confirmed")) throw new Error("Invalid consumed recording origin");
    const expected=this.sourceOrigin(sha256);
    return (expected?.client ?? null)===(origin?.client ?? null)&&expected?.provenance===origin?.provenance;
  }
  commitPreparedAnalysis(preparation: LibraryPreparationTicket, location: LibraryLocationTicket, observation: LibraryLocationRefresh,
    targets: LibraryPreparedTarget[], origin: LibraryConsumedOrigin, map?: LibraryMapTicket,recipe?:LibraryNumericalInputRecipe,handoff=false,incidentEvidence?:LibraryIncidentEvidenceReceipt): LibraryLocationRefreshResult {
    void incidentEvidence;
    if (preparation.replayId !== location.replayId || !observation.available || !observation.sha256)
      throw new Error("Prepared analysis requires its own verified location");
    return this.preparations.complete(preparation, targets, () => {
      // Resource reads and the metadata watcher have independent lifetimes. Never publish a
      // profile prepared from a different origin snapshot merely because the replay SHA matches.
      if (!this.consumedOriginMatches(observation.sha256 as string,origin)) return {state:"stale"};
      const result=this.commitLocationRefreshInTransaction(location, observation, map);
      if(result.state!=="applied")return result;
      const target=targets.find(target=>target.slot==="numerical");
      if(recipe){
        if(!target)throw new Error("Numerical recipe requires its target");
        if(!this.numericalRecipes.bindInTransaction(result.replayId,target,recipe))return{state:"stale"};
      }else if(target?.producerVersion===LIBRARY_NUMERIC_PROJECTION_VERSION)throw new Error("Numerical recipe required");
      return result;
    },handoff);
  }
  /** Historical API shapes remain for old clients, but library C execution is retired. */
  incidentProbeContext(_ticket:LibraryMetricTicket):{location:LibraryOpenLocation;expected:LibraryIncidentEvidenceReceipt} {
    void _ticket;
    throw Error("Library incident analysis is retired");
  }
  commitIncidentsVerified(_ticket:LibraryMetricTicket,_location:LibraryOpenLocation,_probe:LibraryIncidentEvidenceProbe,_metrics:LibraryMetricResult):"applied"|"stale" {
    void _ticket;void _location;void _probe;void _metrics;
    return "stale";
  }
  private incidentPreparationDependencyKey(_id:string):string {
    void _id;
    return metricInputKey({retired:"library-incidents"});
  }
  incidentPreparationContext(_ticket:LibraryPreparationTicket):{location:LibraryOpenLocation;expected:LibraryIncidentEvidenceReceipt} {
    void _ticket;
    throw Error("Library incident analysis is retired");
  }
  commitIncidentPreparation(_ticket:LibraryPreparationTicket,_location:LibraryOpenLocation,_probe:LibraryIncidentEvidenceProbe):LibraryLocationRefreshResult {
    void _ticket;void _location;void _probe;
    return {state:"stale"};
  }
  dirtyIncidentEvidence(_sourceId:string,_change:{kind:"adjacent";replayLocator:string}|{kind:"source"}):void {void _sourceId;void _change;}
  maintainIncidentPreparation(_after="",_limit=1):{next?:string} {void _after;void _limit;return {};}
  /** P can consume source-only scores. It never refreshes replay availability or invents a replay SHA. */
  commitPreparedPerformance(preparation:LibraryPreparationTicket,location:LibraryLocationTicket,map:LibraryPerformanceMapReceipt,
    results:LibraryPreparedResult[],origin:LibraryPerformanceConsumedOrigin,embeddedRequired=false,scoreLocation?:LibraryLocationTicket):LibraryLocationRefreshResult {
    if(preparation.stage!=="P"||preparation.replayId!==location.replayId||!map||!/^[a-f0-9]{32}$/.test(map.md5)||!/^[a-f0-9]{64}$/.test(map.sha256)||
      !Array.isArray(results)||!results.length||results.length>3||typeof embeddedRequired!=="boolean"||
      results.some(result=>!["calculated-map","aggregate-pp","fc-pp"].includes(result?.slot)))throw new Error("Invalid prepared P receipt");
    for(const result of results)this.metrics.validatePreparedResult({...result,replayId:preparation.replayId},{fields:result.fields,provenance:result.provenance});
    results=results.map(result=>({...result,...libraryCapabilityAttempt(result,result)}));
    return this.preparations.completeResults(preparation,results,()=>{
      const source=this.db.prepare("SELECT * FROM sources WHERE id=?").get(location.sourceId);
      const row=this.db.prepare("SELECT * FROM locations WHERE source_id=? AND source_key=?").get(location.sourceId,location.sourceKey);
      if(!source||!row||source.enabled!==1||source.configured!==1||source.config_revision!==location.sourceConfigRevision||
        row.replay_id!==location.replayId||row.revision!==location.locationRevision||row.locator!==location.locator||row.sha256!==location.sha256)
        return{state:"stale"};
      if(scoreLocation){
        const current=this.acquireLocationTicket(location.replayId,scoreLocation.sourceId,scoreLocation.sourceKey);
        if(!current||(["replayId","sourceId","sourceKey","locator","sha256","locationRevision","sourceConfigRevision"] as const)
          .some(key=>current[key]!==scoreLocation[key]))return{state:"stale"};
      }
      const originSha=scoreLocation?.sha256??location.sha256;
      if(origin?.client==="unknown"){
        if(origin.provenance!=="unavailable")throw new Error("Invalid P origin evidence");
        const expected=originSha?this.sourceOrigin(originSha):undefined;
        if(expected?.client!=="unknown"||expected.provenance!=="unavailable")return{state:"stale"};
      }else if(originSha?!this.consumedOriginMatches(originSha,origin):origin!==null)return{state:"stale"};
      const metadata=JSON.parse(String(row.metadata)) as Record<string,unknown>;
      const evidence=sourceMapEvidence({kind:source.kind as LibrarySourceRegistration["kind"],sourceKey:location.sourceKey,sha256:location.sha256,metadata});
      if(evidence.headerMd5&&evidence.sourceMd5&&evidence.headerMd5!==evidence.sourceMd5||(evidence.headerMd5??evidence.sourceMd5)!==map.md5)return{state:"stale"};
      if(map.ticket){
        const t=map.ticket;
        if(t.md5!==map.md5||!this.db.prepare(`SELECT 1 FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation
          JOIN sources s ON s.id=m.source_id WHERE m.source_id=? AND m.generation=? AND m.source_key=? AND m.md5=? AND m.locator=?
          AND s.config_revision=? AND s.configured=1 AND s.enabled=1`).get(t.sourceId,t.generation,t.sourceKey,t.md5,t.locator,t.sourceConfigRevision))return{state:"stale"};
      }else {
        const native=metadata.nativeScore as {beatmap?:{sha256?:unknown;md5?:unknown;status?:unknown}}|undefined;
        if(source.kind!=="lazer"||!evidence.sourceMd5||native?.beatmap?.sha256!==map.sha256||native.beatmap.md5!==map.md5||
          !["available","unverified"].includes(String(native.beatmap.status)))return{state:"stale"};
      }
      for(const result of results)if(result.provenance.mapSha256!==map.sha256||result.provenance.mapMd5!==map.md5)
        throw new Error("Prepared P result map identity mismatch");
      return{state:"applied",replayId:location.replayId};
    },id=>this.performanceRecipes.bindInTransaction(id,this.performanceDependencies(id),results,embeddedRequired));
  }

  preparePerformanceContext(ticket:LibraryPreparationTicket):LibraryPerformanceContext {
    if(ticket.stage!=="P"||!this.preparations.isEligible(ticket)||this.performancePreparationDependencyKey(ticket.replayId)!==ticket.dependencyKey)
      throw new Error("Performance preparation is stale");
    return composePerformanceContext(this.performanceObservations(ticket.replayId),this.sourceOrigin,this.performanceRecipes.requirements(ticket.replayId));
  }
  private performanceObservations(id:string){
    const rows=this.db.prepare(`SELECT l.source_key,l.sha256,l.metadata,s.kind FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? LIMIT 257`).all(id);
    return rows.map(row=>({kind:row.kind as LibrarySourceRegistration["kind"],sourceKey:String(row.source_key),
      sha256:row.sha256===null?null:String(row.sha256),metadata:JSON.parse(String(row.metadata)) as Record<string,unknown>}));
  }
  private performanceDependencies(id:string){
    return performanceDependencyKeys(this.performanceObservations(id),this.sourceOrigin,
      this.performanceRecipes.requirements(id).nativeRequired);
  }
  /** Only the exact independently visible P recipe tuple may coexist with S retry.
   * This is a read-only certificate; the P target/result is never retired. */
  private preserveIndependentPerformance(target:LibraryMetricTarget,result:LibraryMetricResult):boolean {
    const field=target.slot==="aggregate-pp"?"pp":target.slot==="fc-pp"?"ppIfFc":undefined;
    if(!field||target.stage!=="P"||target.producerVersion!==LIBRARY_P_PRODUCER_VERSION||
      Object.keys(result.fields).join(",")!==field||result.fields[field].state!=="known")return false;
    const row=this.db.prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(target.replayId);
    if(!row?.payload)return false;
    try{
      const recipe=JSON.parse(String(row.payload)),current=this.performanceDependencies(target.replayId);
      if(recipe.version!==1||metricInputKey(recipe.dependencies)!==metricInputKey(current)||!Array.isArray(recipe.results))return false;
      const matches=recipe.results.filter((r:LibraryPreparedResult)=>r.slot===target.slot);if(matches.length!==1)return false;
      const raw=matches[0] as LibraryPreparedResult;
      return raw.stage==="P"&&raw.producerVersion===target.producerVersion&&
        target.inputKey===metricInputKey({version:"library-p-visibility-v1",raw:raw.inputKey,visibility:field==="pp"?"independent-aggregate":"independent-fc"})&&
        metricInputKey(raw.fields)===metricInputKey(result.fields)&&metricInputKey(raw.provenance)===metricInputKey(result.provenance);
    }catch{return false;}
  }
  private performancePreparationDependencyKey(id:string):string {
    const observations=this.performanceObservations(id),requirements=this.performanceRecipes.requirements(id),maps=new Set<string>();
    for(const observation of observations){const binding=sourceMapEvidence(observation);if(binding.headerMd5)maps.add(binding.headerMd5);if(binding.sourceMd5)maps.add(binding.sourceMd5);}
    const mapReady=[...maps].sort().map(md5=>[md5,!!this.db.prepare(`SELECT 1 FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation
      JOIN sources s ON s.id=m.source_id WHERE m.md5=? AND m.locator IS NOT NULL AND m.state='unverified' AND s.enabled=1 AND s.configured=1 LIMIT 1`).get(md5)]);
    const readiness=this.db.prepare(`SELECT l.available,s.enabled,s.configured,
      json_extract(l.metadata,'$.nativeScore.beatmap.status') AS native_map FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? LIMIT 257`).all(id);
    return metricInputKey({version:"performance-admission-v1",dependencies:performanceDependencyKeys(observations,this.sourceOrigin,requirements.nativeRequired),
      embeddedRequired:requirements.embeddedRequired,maps:mapReady,
      replayReady:readiness.some(row=>row.available===1&&row.enabled===1&&row.configured===1),
      nativeMapReady:readiness.some(row=>row.enabled===1&&row.configured===1&&["available","unverified"].includes(String(row.native_map)))});
  }

  /** Admission fingerprint, not a metric input key. Stable across observation counters and scan epochs.
   * Bounded hashing is explicit preparation work; queue/query reads do not call this. */
  private preparationDependencyKey(id: string): string {
    const rows = this.db.prepare(`SELECT l.*,s.kind,s.directory FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? ORDER BY l.source_id,l.source_key LIMIT 257`).all(id);
    if (rows.length > 256) throw new Error("Preparation location budget exceeded");
    const maps = new Set<string>();
    const keys = rows.map(row => {
      const metadata = JSON.parse(String(row.metadata)) as Record<string, unknown>;
      const evidence = sourceMapEvidence({kind: row.kind as LibrarySourceRegistration["kind"],sourceKey:String(row.source_key),
        sha256:row.sha256 === null ? null : String(row.sha256),metadata});
      if (evidence.headerMd5) maps.add(evidence.headerMd5); if (evidence.sourceMd5) maps.add(evidence.sourceMd5);
      const raw = metadata.nativeScore;
      let native: Record<string, unknown> | null = null;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const score = raw as Record<string, unknown>;
        native = Object.fromEntries(["id","ruleset","clientVersion","isLegacyScore","maxCombo","accuracy","rank","pp","mods","statistics","maximumStatistics"]
          .map(key => [key, score[key] ?? null]));
        const map = score.beatmap as Record<string, unknown> | undefined;
        native.beatmap = {sha256:map?.sha256 ?? null,md5:map?.md5 ?? null};
      }
      return metricInputKey({sourceId:row.source_id,sourceKey:row.source_key,kind:row.kind,directory:row.directory,
        locator:row.locator,sha256:row.sha256,available:row.available,header:metadata.header ?? null,saved:metadata.savedScore ?? null,
        native,schema:metadata.schemaFingerprint ?? null,origin:row.sha256 ? this.sourceOrigin(String(row.sha256)) ?? null : null});
    });
    const mapKeys: string[] = [];
    for (const md5 of [...maps].sort()) {
      const candidates = this.db.prepare(`SELECT m.*,s.directory FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation
        JOIN sources s ON s.id=m.source_id WHERE m.md5=? ORDER BY m.source_id,m.source_key LIMIT 257`).all(md5);
      if (candidates.length > 256) throw new Error("Preparation map candidate budget exceeded");
      for (const map of candidates) mapKeys.push(metricInputKey({sourceId:map.source_id,sourceKey:map.source_key,md5:map.md5,
        locator:map.locator,state:map.state,directory:map.directory,metadata:JSON.parse(String(map.metadata))}));
    }
    return metricInputKey({preparation:"library-preparation-v1",locations:keys,maps:mapKeys});
  }
  /** S preparation consumes recording/map/profile evidence, not location names or saved causes.
   * Availability is a prerequisite repair only; it is never part of a completed result's key. */
  private numericalPreparationDependencyKey(id:string):string {
    const rows=this.db.prepare(`SELECT l.sha256,l.available,l.metadata,s.kind,s.enabled,s.configured FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? LIMIT 257`).all(id);
    if(rows.length>256)throw new Error("Preparation location budget exceeded");
    const headers=new Set<string>(),native=new Set<string>(),maps=new Set<string>(),contents=new Set<string>();
    let available=false,nativeAvailable=false;
    const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
    for(const row of rows){
      const metadata=JSON.parse(String(row.metadata)) as Record<string,unknown>;
      if(row.sha256)contents.add(String(row.sha256));
      available||=row.available===1&&row.enabled===1&&row.configured===1;
      if(record(metadata.header)){
        const header=metadata.header;
        headers.add(metricInputKey(Object.fromEntries(["mode","version","beatmapMD5","mods"].map(key=>[key,header[key]??null]))));
        if(typeof header.beatmapMD5==="string"&&/^[a-f0-9]{32}$/.test(header.beatmapMD5))maps.add(header.beatmapMD5);
      }
      const score=metadata.nativeScore;
      if(row.kind==="lazer"&&record(score)&&score.isLegacyScore===false){
        const replay=score.replay;
        if(row.sha256&&record(replay)&&replay.sha256===row.sha256){
          const map=record(score.beatmap)?score.beatmap:{};
          native.add(metricInputKey({mods:score.mods??null,mapSha:map.sha256??null,mapMd5:map.md5??null}));
          nativeAvailable||=row.available===1&&row.enabled===1&&row.configured===1;
        }
      }
    }
    const mapReady=[...maps].sort().map(md5=>[md5,!!this.db.prepare(`SELECT 1 FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation
      JOIN sources s ON s.id=m.source_id WHERE m.md5=? AND m.locator IS NOT NULL AND m.state='unverified' AND s.enabled=1 AND s.configured=1 LIMIT 1`).get(md5)]);
    return metricInputKey({preparation:"numerical-admission-v1",producer:LIBRARY_NUMERIC_PROJECTION_VERSION,
      contents:[...contents].sort().map(sha=>[sha,this.sourceOrigin(sha)??null]),headers:[...headers].sort(),native:[...native].sort(),available,nativeAvailable,maps:mapReady});
  }
  /** Production service enables its connected producer; storage fixtures can exercise queues independently. */
  enableNumericalAdmission():void {this.numericalAdmission=true;}
  enablePerformanceAdmission():void {this.performanceAdmission=true;}
  private knownNonstandard(id:string):boolean {
    return !!this.db.prepare(`SELECT 1 FROM replays r WHERE r.id=? AND ${libraryKnownNonstandardSql("r.id","r.metadata")}`).get(id);
  }
  private admitAnalysisInTransaction(id:string):void {
    if(this.knownNonstandard(id))return;
    this.deferCapabilityInTransaction(id);
    if(this.performanceAdmission)this.preparations.requestInTransaction(id,"P","background");
    if(!this.numericalAdmission||this.metrics.analysisSettings().mode!=="bg")return;
    const recipe=this.db.prepare("SELECT producer_version FROM numerical_recipes WHERE replay_id=?").get(id);
    if(recipe?.producer_version===LIBRARY_NUMERIC_PROJECTION_VERSION){
      const entries=this.metrics.read(id),numerical=entries.find(entry=>entry.target.slot==="numerical");
      if(numerical)this.metrics.admitPreparedInTransaction(entries.filter(entry=>entry.target.slot==="numerical"||
        (entry.target.slot==="timeline-pp"||entry.target.slot==="fc-pp"&&entry.target.stage==="S")&&numerical.result!==undefined).map(entry=>entry.target),"background");
      return; // Missing/conflicting profile evidence cannot be repaired by simulation.
    }
    this.preparations.requestInTransaction(id,"S","background");
  }

  upsertObservation(observation: LibraryObservation): string {
    const projection=this.queryProjection!,revision=projection.revision(),resource=projection.resourceRevision(),readiness=this.queryReadiness();
    const id=this.transaction(() => this.writeObservation(observation, this.scan(observation.sourceId, observation.generation)),true,false);
    // Generation coverage alone is private scan bookkeeping. Still reconcile every observation:
    // changed source evidence or pending projection/analysis work can publish a meaningful change.
    if(revision!==projection.revision()||resource!==projection.resourceRevision()||readiness!==this.queryReadiness())this.libraryChanged?.();
    return id;
  }

  private validateObservation(observation: Omit<LibraryObservation, "generation">): void {
    const { sourceKey, locator, sha256, addedAt } = observation;
    const metadata = JSON.stringify(observation.metadata);
    if (!sourceKey || sourceKey.length > 32768 || !locator || locator.length > 32768 ||
        (sha256 !== null && !/^[a-f\d]{64}$/.test(sha256)) || !Number.isSafeInteger(addedAt) || addedAt < 0 ||
        typeof observation.available !== "boolean" || (observation.available && sha256 === null) ||
        !observation.metadata || typeof observation.metadata !== "object" || Array.isArray(observation.metadata) ||
        Buffer.byteLength(metadata) > 64 * 1024) throw new Error("Invalid source observation");
  }
  private writeObservation(observation: LibraryObservation, source: Row, addedSession = this.sessionId, explicit = false,admit=true): string {
    this.validateObservation(observation);
    const { sourceId, sourceKey, locator, sha256, generation, addedAt } = observation;
    const metadata = JSON.stringify(observation.metadata);
      const previous = this.db.prepare("SELECT replay_id,sha256,locator,revision,explicit_sequence FROM locations WHERE source_id=? AND source_key=?").get(sourceId, sourceKey);
      // Paused iterators may have yielded a fresh/error row without a cache revision. A selected
      // refresh or explicit import published after this scan began always wins, including absence→insert.
      if (!explicit && previous && Number(previous.explicit_sequence) > Number(source.scan_explicit_cutoff))
        return this.resolveId(String(previous.replay_id));
      if (observation.expectedRevision !== undefined && previous && observation.expectedRevision !== Number(previous.revision))
        return this.resolveId(String(previous.replay_id));
      const content = sha256 ? this.db.prepare("SELECT replay_id FROM contents WHERE sha256=?").get(sha256) : undefined;
      let id: string;
      if (content) {
        id = this.resolveId(String(content.replay_id));
        if (previous?.sha256 === null) this.mergeProvisional(this.resolveId(String(previous.replay_id)), id);
      } else if (previous && (sha256 === null || previous.sha256 === sha256 || previous.sha256 === null)) {
        id = this.resolveId(String(previous.replay_id));
      } else {
        id = randomUUID();
        const baseline = source.kind !== "imported" && source.baseline_complete === 0;
        const sequence = Number(this.db.prepare("SELECT coalesce(max(rowid),0)+1 AS n FROM replays").get()?.n);
        this.db.prepare("INSERT INTO replays(id,added_at,added_session,added_sequence,baseline,metadata) VALUES(?,?,?,?,?,?)")
          .run(id, addedAt, addedSession, sequence, Number(baseline), metadata);
      }
      if (sha256) this.db.prepare("INSERT OR IGNORE INTO contents(sha256,replay_id) VALUES(?,?)").run(sha256, id);
      const observedHash = sha256 ?? previous?.sha256 ?? null;
      const priorMetadata = previous && sha256 === null && previous.sha256 !== null
        ? this.db.prepare("SELECT metadata FROM locations WHERE source_id=? AND source_key=?").get(sourceId, sourceKey)?.metadata
        : undefined;
      // Keep last verified score/header evidence, but never freeze its old "readable" state or hide
      // the current failure. Unverified replacement fields cannot be attached to the old digest.
      const retainedMetadata = priorMetadata ? retainFailedObservation(String(priorMetadata), observation.metadata) : metadata;
      this.db.prepare(`INSERT INTO locations(source_id,source_key,replay_id,locator,sha256,generation,available,metadata) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(source_id,source_key) DO UPDATE SET replay_id=excluded.replay_id,locator=excluded.locator,
        sha256=excluded.sha256,generation=excluded.generation,available=excluded.available,metadata=excluded.metadata,
        revision=locations.revision+CASE WHEN locations.replay_id IS NOT excluded.replay_id OR locations.locator IS NOT excluded.locator
          OR locations.sha256 IS NOT excluded.sha256 OR locations.available IS NOT excluded.available OR locations.metadata IS NOT excluded.metadata THEN 1 ELSE 0 END`)
        .run(sourceId, sourceKey, id, locator, observedHash, generation, Number(observation.available), retainedMetadata);
      if (explicit) {
        this.db.prepare("UPDATE counters SET value=value+1 WHERE key='explicit-publication'").run();
        this.db.prepare("UPDATE locations SET explicit_sequence=(SELECT value FROM counters WHERE key='explicit-publication') WHERE source_id=? AND source_key=?")
          .run(sourceId, sourceKey);
      }
      // Keep each source projection. A deterministic summary prefers verified native/source score
      // metadata over header-only duplicates; metrics must still inspect field provenance/availability.
      const summary = this.db.prepare(`SELECT l.metadata FROM locations l JOIN sources s ON s.id=l.source_id
        WHERE l.replay_id=? ORDER BY (l.sha256 IS NOT NULL) DESC,
        CASE s.kind WHEN 'lazer' THEN 0 WHEN 'stable' THEN 1 WHEN 'replays' THEN 2 ELSE 3 END,
        l.source_id,l.source_key LIMIT 1`).get(id);
      if (summary) this.db.prepare("UPDATE replays SET metadata=? WHERE id=? AND metadata IS NOT ?").run(summary.metadata, id, summary.metadata);
      this.bindSourceScore(id);
      this.bindSourceMap(id);
      this.numericalRecipes.reconcileInTransaction(id);
      this.performanceRecipes.reconcileInTransaction(id);
      if(admit)this.admitAnalysisInTransaction(id);
      if(previous){const priorId=this.resolveId(String(previous.replay_id));if(priorId!==id){this.numericalRecipes.reconcileInTransaction(priorId);this.performanceRecipes.reconcileInTransaction(priorId);}}
      return id;
  }

  private bindSourceScore(id: string): void {
    // Historical source evidence survives disable/removal. Each candidate and projection is bounded;
    // a malformed preferred envelope cannot conceal another source's usable observations.
    for (const row of this.db.prepare(`SELECT l.metadata,l.sha256,l.source_key,s.kind FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? ORDER BY (l.sha256 IS NOT NULL) DESC,
      CASE s.kind WHEN 'lazer' THEN 0 WHEN 'stable' THEN 1 WHEN 'replays' THEN 2 ELSE 3 END,
      l.source_id,l.source_key LIMIT 256`).iterate(id)) {
      const sha256 = row.sha256 === null ? null : String(row.sha256);
      const result = projectSourceEvidence({ kind: row.kind as LibrarySourceRegistration["kind"], sourceKey: String(row.source_key),
        sha256, metadata: JSON.parse(String(row.metadata)) }, sha256 ? this.sourceOrigin(sha256) : undefined);
      if (!result) continue;
      this.metrics.bindObservedInTransaction({ replayId: id, slot: result.slot, stage: result.stage,
        inputKey: result.inputKey, producerVersion: result.producerVersion }, { fields: result.fields, provenance: result.provenance });
      return;
    }
    this.metrics.clearObservedInTransaction(id, "source-score");
  }

  private bindSourceMap(id: string): void {
    const evidence = this.db.prepare(`SELECT l.metadata,l.sha256,l.source_key,s.kind FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? ORDER BY (l.sha256 IS NOT NULL) DESC,
      CASE s.kind WHEN 'lazer' THEN 0 WHEN 'stable' THEN 1 WHEN 'replays' THEN 2 ELSE 3 END,
      l.source_id,l.source_key LIMIT 256`).all(id).map(row => sourceMapEvidence({
        kind: row.kind as LibrarySourceRegistration["kind"], sourceKey: String(row.source_key),
        sha256: row.sha256 === null ? null : String(row.sha256), metadata: JSON.parse(String(row.metadata)),
      }));
    const headers = new Set(evidence.flatMap(row => row.headerMd5 ? [row.headerMd5] : []));
    const declared = new Set(evidence.flatMap(row => row.sourceMd5 ? [row.sourceMd5] : []));
    // Verified replay headers outrank source declarations. Conflicting source-only declarations
    // cannot establish one map, and unavailable identity never silently retains an old target.
    const candidates = headers.size ? headers : declared;
    const md5 = candidates.size === 1 ? candidates.values().next().value as string : undefined;
    if (md5) {
      let result = evidence.find(row => row.sourceMd5 === md5 && row.nativeProjection)?.nativeProjection;
      if (!result) {
        for (const row of this.db.prepare(`SELECT m.metadata FROM maps m JOIN map_scans g
          ON g.source_id=m.source_id AND g.current_generation=m.generation JOIN sources s ON s.id=m.source_id
          WHERE m.md5=? AND s.kind='stable' ORDER BY m.source_id,m.source_key LIMIT 256`).iterate(md5)) {
          result = projectStableMapEvidence(md5, JSON.parse(String(row.metadata))); if (result) break;
        }
      }
      if (result) {
        this.metrics.bindObservedInTransaction({ replayId: id, slot: result.slot, stage: result.stage,
          inputKey: result.inputKey, producerVersion: result.producerVersion }, { fields: result.fields, provenance: result.provenance });
        return;
      }
      const previous = this.metrics.read(id).find(entry => entry.target.slot === "source-map");
      if (previous?.target.producerVersion === LIBRARY_SOURCE_PROJECTION_VERSION && previous.result?.provenance.mapMd5 === md5) return;
    }
    this.metrics.clearObservedInTransaction(id, "source-map");
  }

  /** Startup/version/origin reconciliation only. Caller yields between pages; queries never call this. */
  reprojectSourceMetrics(after = "", limit = 32): { processed: number; next?: string } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128 || after.length > 128) throw new Error("Invalid metric backfill page limit");
    const rows = this.db.prepare("SELECT id FROM replays WHERE merged_into IS NULL AND id>? ORDER BY id LIMIT ?").all(after, limit + 1);
    const page = rows.slice(0, limit);
    this.transaction(() => { for (const row of page) { const id=String(row.id);this.bindSourceScore(id);this.bindSourceMap(id);this.numericalRecipes.reconcileInTransaction(id);this.performanceRecipes.reconcileInTransaction(id);this.admitAnalysisInTransaction(id); } });
    return { processed: page.length, ...(rows.length > limit ? { next: String(page[page.length - 1].id) } : {}) };
  }
  sourceMetricRevision(): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='source-metric-revision'").get();
    return row ? String(row.value) : undefined;
  }

  /** Additive producer capabilities reconsider old rejected values, never known mathematics.
   * Cursor and ordinary queue admission commit together. Actual current publication marks
   * the input's attempt; eligible source changes revisit old unmarked values after a pass. */
  private capabilityProgress(): { cursor: string; deferred: string | null; complete: boolean; processed: number; numerical: number; performance: number } {
    const current = this.db.prepare("SELECT value FROM settings WHERE key=?").get(LibraryStore.capabilityKey);
    const row = current??this.db.prepare("SELECT value FROM settings WHERE key='library-capability-recovery-neutral-prefix-native-v2'").get()??
      this.db.prepare("SELECT value FROM settings WHERE key='library-capability-recovery-native-anchor-v1'").get()??
      this.db.prepare("SELECT value FROM settings WHERE key=?").get(LibraryStore.previousCapabilityKey);
    if (!row) return { cursor: "", deferred: null, complete: false, processed: 0, numerical: 0, performance: 0 };
    const value = JSON.parse(String(row.value));
    if (!value || typeof value.cursor !== "string" || value.cursor.length > 128 || typeof value.complete !== "boolean" ||
      value.deferred !== null && (typeof value.deferred !== "string" || value.deferred.length > 128) ||
      [value.processed, value.numerical, value.performance].some(v => !Number.isSafeInteger(v) || v < 0) ||
      Object.keys(value).sort().join(",") !== "complete,cursor,deferred,numerical,performance,processed") throw Error("Invalid capability recovery progress");
    // One additive pass for initial-input and strip capabilities, retaining historical admission
    // counts and all per-input attempt markers. Reads do not persist/advance it.
    return current?value:{...value,cursor:"",deferred:null,complete:false};
  }
  capabilityRecoveryStatus() {
    const progress = this.capabilityProgress(), settings = this.metrics.analysisSettings();
    const complete=progress.complete&&progress.deferred===null;
    return { ...progress, complete, state: complete ? "complete" as const : settings.mode !== "bg" || settings.userPaused ? "held" as const : "pending" as const };
  }
  capabilityRecoveryPending(): boolean {
    if (!this.numericalAdmission || !this.performanceAdmission) return false;
    return this.capabilityRecoveryStatus().state === "pending";
  }
  /** One indexed identity per existing maintenance turn. False also means transiently
   * blocked: caller stops, and the next ordinary queue/settings mutation wakes it. */
  maintainCapabilityRecovery(): boolean {
    if (!this.capabilityRecoveryPending()) return false;
    const progress = this.capabilityProgress();
    const revisit=progress.deferred!==null && (progress.complete || progress.deferred<=progress.cursor);
    const after=revisit&&progress.deferred!==null?progress.deferred:progress.cursor;
    // Limit identities before examining any payload. Filtering JSON before LIMIT
    // would otherwise parse an arbitrarily long known/no-candidate suffix at once.
    // Aliases also consume a turn, so a long run of merged identities stays bounded.
    const row=this.db.prepare(`SELECT id,merged_into FROM replays WHERE id ${revisit?">=":">"} ? ORDER BY id LIMIT 1`).get(after);
    const id=row?String(row.id):undefined;
    const eligibility=()=>id&&row?.merged_into===null?this.capabilityEligibilityInTransaction(id):{numerical:false,performance:false,strip:false};
    const candidate=()=>{const value=eligibility();return value.numerical||value.performance||value.strip;};
    // Do not supersede live/queued ownership, even when an older unknown is still cached.
    if (id && candidate() && (this.db.prepare("SELECT 1 FROM analysis_requests WHERE replay_id=? AND state IN ('queued','running') LIMIT 1").get(id) ||
      this.db.prepare("SELECT 1 FROM metric_jobs WHERE replay_id=? AND state IN ('queued','running') LIMIT 1").get(id))) return false;
    let blocked=false;
    this.transaction(() => {
      const eligible=eligibility(),selected=eligible.numerical||eligible.performance||eligible.strip;
      // Repeat under the write transaction: target retirement and ownership checks
      // must share a boundary even if another connection changed the selected row.
      if(selected&&id&&(this.db.prepare("SELECT 1 FROM analysis_requests WHERE replay_id=? AND state IN ('queued','running') LIMIT 1").get(id)||
        this.db.prepare("SELECT 1 FROM metric_jobs WHERE replay_id=? AND state IN ('queued','running') LIMIT 1").get(id))){blocked=true;return;}
      if(revisit){progress.deferred=null;progress.complete=false;}
      if (id) {
        if (eligible.numerical && this.metrics.retryRejectedCoverageInTransaction(id)) {
          this.preparations.requestInTransaction(id, "S", "retry"); progress.numerical++;
        }
        if (eligible.performance) {
          this.preparations.requestInTransaction(id, "P", "retry"); progress.performance++;
        }
        if(eligible.strip&&this.metrics.admitStripRepairInTransaction(id))progress.numerical++;
        progress.cursor = id; progress.processed++;
      } else progress.complete = true;
      this.db.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(LibraryStore.capabilityKey, JSON.stringify(progress));
    },true,true,false);
    // The owner uses this result to schedule the next page. Its own transaction
    // must not manufacture a wake when the selected identity is temporarily busy.
    return !blocked&&(!progress.complete || progress.deferred!==null || this.queryProjectionPending()>0);
  }
  /** Shared, nonmutating qualification for both a page and a source-change wake.
   * Unknown alone is insufficient: protected inputs must not reopen a completed pass.
   * Ownership is checked by the page, so late eligibility survives a temporary hold. */
  private capabilityEligibilityInTransaction(id:string):{numerical:boolean;performance:boolean;strip:boolean} {
    const none={numerical:false,performance:false,strip:false};
    const replay=this.db.prepare("SELECT metadata FROM replays WHERE id=? AND merged_into IS NULL").get(id);
    if(!replay||this.knownNonstandard(id)||!this.db.prepare(`SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? AND s.enabled=1 AND s.configured=1 LIMIT 1`).get(id)||
      this.db.prepare("SELECT 1 FROM analysis_requests WHERE replay_id=? AND state='failed' UNION ALL SELECT 1 FROM metric_jobs WHERE replay_id=? AND state='failed' LIMIT 1").get(id,id))return none;
    const entries=this.metrics.read(id),numerical=entries.find(e=>e.target.slot==="numerical"),map=entries.find(e=>e.target.slot==="calculated-map");
    const metadata=JSON.parse(String(replay.metadata)),header=metadata.header,mask=header?.modsBitmask;
    const manualStable=header?.mode===0&&header.sourceFormat==="stable"&&header.nativeScoreInfo===false&&
      Number.isSafeInteger(mask)&&mask>=0&&mask<=2147483647&&(mask&(128|2048|8192))===0;
    // The producer still verifies actual prefix shape and map/replay agreement.
    // This finite metadata class admits AT plus recognized legacy modifiers only;
    // The distinct later-neutral-reset proof also justifies one manual v2 attempt;
    // actual current v3 producer receipts remain terminal for this capability.
    const supportedAtBits=1|2|4|8|16|32|64|256|512|1024|2048|4096|16384|(1<<29);
    const stableAt=header?.mode===0&&header.sourceFormat==="stable"&&header.nativeScoreInfo===false&&
      Number.isSafeInteger(mask)&&mask>=0&&mask<=2147483647&&(mask&2048)!==0&&(mask&~supportedAtBits)===0;
    const proof=numerical?.result?.provenance;
    let manualNative=false;
    if(header?.mode===0&&header.sourceFormat==="lazer"&&header.nativeScoreInfo===true&&header.modsBitmask===0&&
      Number.isSafeInteger(header.version)&&header.version>=30000000&&proof?.ruleset==="lazer"&&proof.rate===1){
      const row=this.db.prepare("SELECT producer_version,recipe FROM numerical_recipes WHERE replay_id=?").get(id);
      if(row?.producer_version===LIBRARY_NUMERIC_PROJECTION_VERSION)try{
        const recipe=JSON.parse(String(row.recipe));validateNumericalRecipe(recipe);
        const profile=numericalProfileKey(recipe,{origin:null,native:{state:"absent"}});
        manualNative=recipe.intrinsicNative&&recipe.modeQualified&&recipe.consumedModsSource==="embedded"&&
          recipe.embeddedModsHash===numericalModsHash([])&&recipe.replaySha256===proof.replaySha256&&
          profile.state==="known"&&profile.qualified&&profile.inputKey===numerical?.target.inputKey;
      }catch{/* A corrupt/unbound recipe is not permission to invalidate its cache. */}
    }
    const locationMatches=proof?.replaySha256&&this.db.prepare(`SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? AND l.sha256=? AND l.available=1 AND s.enabled=1 AND s.configured=1 LIMIT 1`).get(id,String(proof.replaySha256));
    const bpm=map?.result?.fields.bpm;
    const nativeScore=header?.mode===0&&header.sourceFormat==="lazer"&&header.nativeScoreInfo===true&&
      Number.isSafeInteger(header.version)&&header.version>=30000000&&this.performanceRecipes.canRetryNativeSparseScoreInTransaction(id)&&
      this.db.prepare(`SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=? AND l.sha256=?
        AND l.available=1 AND s.enabled=1 AND s.configured=1 LIMIT 1`).get(id,String(map?.result?.provenance.replaySha256));
    return {
      strip:!!this.metrics.stripRepairTargetInTransaction(id),
      numerical:!!(((manualStable&&(proof?.capabilityAttempt===undefined||["stable-prefix-v1","stable-prefix-v2"].includes(String(proof.capabilityAttempt)))||
          stableAt&&(proof?.capabilityAttempt===undefined||["stable-prefix-v1","stable-prefix-v2"].includes(String(proof.capabilityAttempt))))&&proof?.ruleset==="stable"||
        manualNative&&(proof?.capabilityAttempt===undefined||proof.capabilityAttempt==="native-initial-negative-v1"))&&locationMatches&&
        this.metrics.canRetryRejectedCoverageInTransaction(id)),
      performance:!!nativeScore||!!(map?.result?.provenance.capabilityAttempt===undefined&&map?.target.stage==="P"&&map.target.producerVersion===LIBRARY_P_PRODUCER_VERSION&&
        bpm?.state==="unknown"&&["constant-tempo-unavailable","tempo-geometry-budget"].includes(bpm.reason)&&
        Object.entries(map.result?.fields??{}).every(([name,field])=>name==="bpm"||field.state==="known")&&
        this.db.prepare("SELECT 1 FROM performance_recipes WHERE replay_id=? AND payload IS NOT NULL").get(id))
    };
  }
  /** Source callbacks retain one lower bound while held. Fresh/known observations
   * do not reset the pass; the actual result carries its input-bound attempt. */
  private deferCapabilityInTransaction(id:string):void {
    if(!this.numericalAdmission||!this.performanceAdmission)return;
    const progress=this.capabilityProgress();
    if(!progress.complete&&id>progress.cursor)return;
    if(progress.deferred!==null&&progress.deferred<=id)return;
    const eligible=this.capabilityEligibilityInTransaction(id);if(!eligible.numerical&&!eligible.performance&&!eligible.strip)return;
    progress.deferred=id;
    this.db.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(LibraryStore.capabilityKey,JSON.stringify(progress));
  }
  invalidateSourceMetricRevision(): void { this.db.prepare("DELETE FROM settings WHERE key='source-metric-revision'").run(); }
  sourceMapRevision(): string {
    return String(this.db.prepare("SELECT value FROM settings WHERE key='source-map-revision'").get()?.value ?? "initial");
  }
  private touchSourceMapRevisionInTransaction(): void {
    this.db.prepare("INSERT INTO settings VALUES('source-map-revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(randomUUID());
  }
  private reconcileMapReplayInTransaction(id:string):void {
    this.bindSourceMap(id);this.numericalRecipes.reconcileInTransaction(id);this.performanceRecipes.reconcileInTransaction(id);
    this.admitAnalysisInTransaction(id);
  }
  completeSourceMetricRevision(revision: string): boolean {
    if (!/^[a-zA-Z0-9:._-]{1,256}$/.test(revision)) throw new Error("Invalid source metric revision");
    return this.transaction(() => {
      this.db.prepare("INSERT INTO settings VALUES('source-metric-revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(revision);
      return true;
    });
  }

  prepareImport(sourceId: string, sha256: string, metadata: Record<string, unknown>, addedAt: number): ImportIntent {
    const source = this.db.prepare("SELECT kind FROM sources WHERE id=?").get(sourceId);
    if (source?.kind !== "imported" || !/^[a-f\d]{64}$/.test(sha256) || !Number.isSafeInteger(addedAt) || addedAt < 0 ||
        !metadata || typeof metadata !== "object" || Array.isArray(metadata) || Buffer.byteLength(JSON.stringify(metadata)) > 64 * 1024)
      throw new Error("Invalid import intent");
    const intent = { id: randomUUID(), sourceId, sha256, addedAt, sessionId: this.sessionId, metadata };
    this.db.prepare("INSERT INTO import_intents VALUES(?,?,?,?,?,?)")
      .run(intent.id, sourceId, sha256, addedAt, this.sessionId, JSON.stringify(metadata));
    return intent;
  }

  hasPendingImports(): boolean { return !!this.db.prepare("SELECT 1 FROM import_intents LIMIT 1").get(); }

  pendingImports(after?: { addedAt: number; id: string }, limit = 128): ImportIntent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid import journal page limit");
    return this.db.prepare("SELECT * FROM import_intents WHERE (added_at,id)>(?,?) ORDER BY added_at,id LIMIT ?")
      .all(after?.addedAt ?? -1, after?.id ?? "", limit).map(row => ({
      id: String(row.id), sourceId: String(row.source_id), sha256: String(row.sha256), addedAt: Number(row.added_at),
      sessionId: String(row.session_id), metadata: JSON.parse(String(row.metadata)),
    }));
  }

  abandonImport(id: string): void { this.db.prepare("DELETE FROM import_intents WHERE id=?").run(id); }

  /** Caller has verified the promoted owned file; location and journal completion commit together. */
  completeImport(id: string, locator: string): string {
    return this.transaction(() => {
      const intent = this.db.prepare("SELECT * FROM import_intents WHERE id=?").get(id);
      if (!intent) throw new Error("Unknown import intent");
      const source = this.db.prepare("SELECT * FROM sources WHERE id=? AND kind='imported'").get(intent.source_id);
      if (!source) throw new Error("Unknown import source");
      const replayId = this.writeObservation({ sourceId: String(intent.source_id), sourceKey: String(intent.sha256), locator,
        sha256: String(intent.sha256), available: true, generation: String(source.generation ?? ("import:" + id)), addedAt: Number(intent.added_at),
        metadata: JSON.parse(String(intent.metadata)) }, source, String(intent.session_id), true);
      this.db.prepare("DELETE FROM import_intents WHERE id=?").run(id);
      return replayId;
    });
  }

  resolveId(id: string): string {
    const visited = new Set<string>();
    for (;;) {
      if (visited.has(id)) throw new Error("Corrupt replay identity cycle");
      visited.add(id);
      const replay = this.db.prepare("SELECT merged_into FROM replays WHERE id=?").get(id);
      if (!replay) throw new Error("Unknown replay identity");
      if (replay.merged_into === null) return id;
      id = String(replay.merged_into);
    }
  }

  private mergeProvisional(from: string, into: string): void {
    if (from === into) return;
    if (this.db.prepare("SELECT 1 FROM contents WHERE replay_id=?").get(from))
      throw new Error("Cannot merge distinct content identities");
    const old = this.db.prepare("SELECT * FROM replays WHERE id=?").get(from);
    const current = this.db.prepare("SELECT * FROM replays WHERE id=?").get(into);
    if (!old || !current) throw new Error("Unknown replay merge identity");
    this.metrics.mergeProvisional(from, into);
    this.preparations.mergeProvisionalInTransaction(from, into);
    this.numericalRecipes.forgetProvisionalInTransaction(from);
    this.incidents.forgetProvisionalInTransaction(from);
    this.performanceRecipes.mergeProvisionalInTransaction(from,into);
    const earliest = Number(old.added_at) < Number(current.added_at) ||
      (old.added_at === current.added_at && Number(old.added_sequence) < Number(current.added_sequence)) ? old : current;
    this.db.prepare("UPDATE replays SET added_at=?,added_session=?,added_sequence=?,baseline=?,favourite=? WHERE id=?")
      .run(earliest.added_at, earliest.added_session, earliest.added_sequence, earliest.baseline,
        Number(old.favourite === 1 || current.favourite === 1), into);
    this.db.prepare("INSERT OR IGNORE INTO memberships SELECT ?,collection_id FROM memberships WHERE replay_id=?").run(into, from);
    this.db.prepare("DELETE FROM memberships WHERE replay_id=?").run(from);
    this.db.prepare("UPDATE review_edits SET replay_id=? WHERE replay_id=?").run(into, from);
    this.db.prepare("UPDATE locations SET replay_id=? WHERE replay_id=?").run(into, from);
    this.db.prepare("UPDATE replays SET merged_into=? WHERE id=?").run(into, from);
    this.dirty|=4;
  }

  listReplayIds(): string[] {
    return this.db.prepare("SELECT id FROM replays WHERE merged_into IS NULL ORDER BY added_at,id").all().map(row => String(row.id));
  }

  getReplay(inputId: string): LibraryReplayIdentity | undefined {
    if (!this.db.prepare("SELECT 1 FROM replays WHERE id=?").get(inputId)) return undefined;
    const id = this.resolveId(inputId);
    const row = this.db.prepare("SELECT * FROM replays WHERE id=?").get(id);
    if (!row) throw new Error("Unknown resolved replay identity");
    const review = this.db.prepare("SELECT state FROM review_edits WHERE replay_id=? ORDER BY sequence DESC LIMIT 1").get(id);
    return {
      id, firstAddedAt: Number(row.added_at), isNew: row.baseline === 0 && row.added_session === this.sessionId,
      favourite: row.favourite === 1, review: (review?.state ?? "not-reviewed") as ReplayReview,
      metadata: JSON.parse(String(row.metadata)),
      collectionIds: this.db.prepare("SELECT collection_id FROM memberships WHERE replay_id=? ORDER BY collection_id").all(id).map(item => String(item.collection_id)),
      locations: this.db.prepare(`SELECT l.*,s.enabled*s.configured AS enabled FROM locations l JOIN sources s ON s.id=l.source_id
        WHERE replay_id=? ORDER BY source_id,source_key`).all(id).map(item => ({
          sourceId: String(item.source_id), sourceKey: String(item.source_key), locator: String(item.locator),
          available: item.available === 1, enabled: item.enabled === 1,
          sha256: item.sha256 === null ? null : String(item.sha256), metadata: JSON.parse(String(item.metadata)),
        })),
    };
  }

  setReview(id: string, review: ReplayReview): void {
    if (!reviews.has(review)) throw new Error("Invalid review state");
    this.transaction(()=>this.db.prepare("INSERT INTO review_edits(replay_id,state) VALUES(?,?)").run(this.resolveId(id), review));
  }
  reviewHistory(id: string): { sequence: number; state: ReplayReview }[] {
    return this.db.prepare("SELECT sequence,state FROM review_edits WHERE replay_id=? ORDER BY sequence").all(this.resolveId(id))
      .map(row => ({ sequence: Number(row.sequence), state: row.state as ReplayReview }));
  }
  setFavourite(id: string, favourite: boolean): void {
    if(typeof favourite!=="boolean")throw Error("Invalid favourite state");
    this.transaction(()=>this.db.prepare("UPDATE replays SET favourite=? WHERE id=?").run(Number(favourite), this.resolveId(id)));
  }

  createCollection(name: string, parentId: string | null = null,replayId?:string): string {
    name = name.trim();
    if (!name || name.length > 256) throw new Error("Invalid collection name");
    return this.transaction(() => {
      const selected=replayId===undefined?undefined:this.resolveId(replayId);
      let palette: number;
      const sequence = Number(this.db.prepare("SELECT coalesce(max(sequence),0)+1 AS n FROM collections").get()?.n);
      if (parentId) {
        const parent = this.db.prepare("SELECT parent_id,palette_index FROM collections WHERE id=?").get(parentId);
        if (!parent || parent.parent_id !== null) throw new Error("Collections support only one child level");
        palette = Number(parent.palette_index);
      } else {
        palette = Number(this.db.prepare("SELECT value FROM counters WHERE key='palette'").get()?.value);
        this.db.prepare("UPDATE counters SET value=value+1 WHERE key='palette'").run();
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO collections VALUES(?,?,?,?,?)").run(id, name, parentId, palette, sequence);
      if(selected)this.db.prepare("INSERT INTO memberships VALUES(?,?)").run(selected,id);
      return id;
    });
  }
  listCollections(): LibraryCollection[] {
    return this.db.prepare("SELECT * FROM collections ORDER BY sequence").all().map(row => ({
      id: String(row.id), name: String(row.name), parentId: row.parent_id === null ? null : String(row.parent_id), paletteIndex: Number(row.palette_index),
    }));
  }
  setMembership(id: string, collectionId: string, included: boolean): void {
    if(typeof included!=="boolean")throw Error("Invalid membership state");
    this.transaction(()=>{const replayId = this.resolveId(id);
    if(!this.db.prepare("SELECT 1 FROM collections WHERE id=?").get(collectionId))throw Error("Unknown collection");
    if (included) this.db.prepare("INSERT OR IGNORE INTO memberships VALUES(?,?)").run(replayId, collectionId);
    else this.db.prepare("DELETE FROM memberships WHERE replay_id=? AND collection_id=?").run(replayId, collectionId);
    });
  }
  collectionReplayIds(collectionId: string): string[] {
    return this.db.prepare(`SELECT DISTINCT replay_id FROM memberships WHERE collection_id=? OR collection_id IN
      (SELECT id FROM collections WHERE parent_id=?) ORDER BY replay_id`).all(collectionId, collectionId).map(row => String(row.replay_id));
  }
  /** UI owns the v34 confirmation. This only deletes collection records, never replay data/files. */
  deleteCollection(id: string,referencedIds:readonly string[]=[]):string[] {
    const valid=(value:unknown):value is string=>typeof value==="string"&&/^[a-zA-Z0-9_.:/+-]{1,128}$/.test(value);
    if(!valid(id)||!Array.isArray(referencedIds)||referencedIds.length>101||new Set(referencedIds).size!==referencedIds.length||referencedIds.some(value=>!valid(value)))
      throw new Error("Invalid collection reference cleanup");
    const ids=[...new Set([id,...referencedIds])],query=`SELECT id FROM collections WHERE id IN (${ids.map(()=>"?").join(",")})`;
    return this.transaction(()=>{
      const before=new Set(this.db.prepare(query).all(...ids).map(row=>String(row.id)));
      this.db.prepare("DELETE FROM collections WHERE id=?").run(id);
      const after=new Set(this.db.prepare(query).all(...ids).map(row=>String(row.id)));
      return ids.filter(value=>before.has(value)&&!after.has(value));
    });
  }
  renameCollection(id:string,name:string):void {
    name=name.trim();if(!name||name.length>256)throw Error("Invalid collection name");
    this.transaction(()=>{if(!this.db.prepare("UPDATE collections SET name=? WHERE id=? RETURNING id").get(name,id))throw Error("Unknown collection");});
  }
}
