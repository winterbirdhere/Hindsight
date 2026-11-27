import type { DatabaseSync } from "node:sqlite";
import type { LibraryAnalysisActivity, LibraryAnalysisSettings } from "../../../../shared/replay-library-metrics";
import { libraryKnownNonstandardSql } from "./library-recorded-evidence";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_TIMELINE_PROJECTION_VERSION, LIBRARY_RECONSTRUCTED_FC_VERSION } from "../../../../shared/library-analysis";
import { LIBRARY_P_PRODUCER_VERSION } from "./library-performance-versions";

/** Connection-local, transactionally maintained summaries. No persistent schema or
 * work admission changes. Initialization reads existing intents once; status reads
 * only the fixed-cardinality group table. Mutation refreshes use replay PK indexes. */
export class LibraryAnalysisActivityStore {
  constructor(private readonly db: DatabaseSync) {
    const eligibility = (id: string) => `CASE WHEN NOT EXISTS(SELECT 1 FROM replays r WHERE r.id=${id}
      AND r.merged_into IS NULL AND NOT ${libraryKnownNonstandardSql("r.id", "r.metadata")}) THEN 0
      WHEN EXISTS(SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id
        WHERE l.replay_id=${id} AND s.enabled=1 AND s.configured=1) THEN 2 ELSE 1 END`;
    db.exec(`CREATE TEMP TABLE analysis_activity_work(kind TEXT, replay_id TEXT, slot TEXT,
      stage TEXT, state TEXT, reason TEXT, eligibility INTEGER, PRIMARY KEY(kind,replay_id,slot));
      CREATE INDEX temp.analysis_activity_replay ON analysis_activity_work(replay_id);
      CREATE TEMP TABLE analysis_activity_counts(kind TEXT,stage TEXT,state TEXT,reason TEXT,eligibility INTEGER,n INTEGER NOT NULL,
        PRIMARY KEY(kind,stage,state,reason,eligibility));
      CREATE TEMP TRIGGER activity_count_insert AFTER INSERT ON analysis_activity_work BEGIN
        INSERT INTO analysis_activity_counts VALUES(NEW.kind,NEW.stage,NEW.state,NEW.reason,NEW.eligibility,1)
          ON CONFLICT(kind,stage,state,reason,eligibility) DO UPDATE SET n=n+1;
      END;
      CREATE TEMP TRIGGER activity_count_delete AFTER DELETE ON analysis_activity_work BEGIN
        UPDATE analysis_activity_counts SET n=n-1 WHERE kind=OLD.kind AND stage=OLD.stage AND state=OLD.state
          AND reason=OLD.reason AND eligibility=OLD.eligibility;
      END;
      CREATE TEMP VIEW analysis_activity_intents AS
        SELECT 'preparation' AS kind,a.replay_id,a.stage AS slot,a.stage,a.state,a.reason,${eligibility("a.replay_id")} AS eligibility
        FROM main.analysis_requests a INDEXED BY sqlite_autoindex_analysis_requests_1
        WHERE a.stage IN ('P','S') AND a.state IN ('queued','running','failed')
        UNION ALL
        SELECT 'metric',j.replay_id,j.slot,j.stage,j.state,j.reason,${eligibility("j.replay_id")}
        FROM main.metric_jobs j JOIN main.metric_targets t ON t.replay_id=j.replay_id AND t.slot=j.slot
          AND t.stage=j.stage AND t.input_key=j.input_key AND t.producer_version=j.producer_version AND t.generation=j.generation
        WHERE j.stage IN ('P','S') AND j.slot<>'incidents' AND j.state IN ('queued','running','failed')
          AND (j.reason IN ('strip-repair','clock-enrichment') OR NOT EXISTS(SELECT 1 FROM main.metric_results c WHERE c.replay_id=j.replay_id AND c.slot=j.slot
            AND c.stage=j.stage AND c.input_key=j.input_key AND c.producer_version=j.producer_version));
      INSERT INTO analysis_activity_work SELECT * FROM analysis_activity_intents;`);
    const refresh = (id: string, condition = "1") => `DELETE FROM analysis_activity_work WHERE replay_id=${id} AND ${condition};
      INSERT INTO analysis_activity_work SELECT * FROM analysis_activity_intents WHERE replay_id=${id} AND ${condition};`;
    for (const table of ["analysis_requests", "metric_jobs", "metric_targets", "metric_results", "locations"]) {
      for (const event of ["INSERT", "DELETE", "UPDATE"]) {
        const refs = event === "DELETE" ? ["OLD"] : ["NEW"];
        db.exec(`CREATE TEMP TRIGGER activity_${table}_${event} AFTER ${event} ON main.${table} BEGIN
          ${event === "UPDATE" ? refresh("OLD.replay_id", "OLD.replay_id<>NEW.replay_id") : ""}
          ${refs.map(ref => refresh(`${ref}.replay_id`)).join("\n")} END;`);
      }
    }
    db.exec(`CREATE TEMP TRIGGER activity_replay_update AFTER UPDATE OF merged_into,metadata ON main.replays BEGIN
      ${refresh("NEW.id")} END;
      CREATE TEMP TRIGGER activity_source_update AFTER UPDATE OF enabled,configured ON main.sources
        WHEN OLD.enabled<>NEW.enabled OR OLD.configured<>NEW.configured BEGIN
        DELETE FROM analysis_activity_work WHERE replay_id IN (SELECT replay_id FROM main.locations WHERE source_id=NEW.id);
        INSERT INTO analysis_activity_work SELECT * FROM analysis_activity_intents
          WHERE replay_id IN (SELECT replay_id FROM main.locations WHERE source_id=NEW.id);
      END;`);
    // Coverage is a separate per-replay population, never the changing number of
    // preparation/metric jobs. Cache reverse owner lookups locally: the durable
    // presentation-owner table deliberately has no owner_id index.
    db.exec(`CREATE TEMP TABLE analysis_progress_replays(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,completed INTEGER NOT NULL);
      CREATE INDEX temp.analysis_progress_owner ON analysis_progress_replays(owner_id);
      CREATE TEMP TABLE analysis_progress_counts(completed INTEGER PRIMARY KEY,n INTEGER NOT NULL);
      INSERT INTO analysis_progress_counts VALUES(0,0),(1,0);
      CREATE TEMP TRIGGER progress_count_insert AFTER INSERT ON analysis_progress_replays BEGIN
        UPDATE analysis_progress_counts SET n=n+1 WHERE completed=NEW.completed;
      END;
      CREATE TEMP TRIGGER progress_count_delete AFTER DELETE ON analysis_progress_replays BEGIN
        UPDATE analysis_progress_counts SET n=n-1 WHERE completed=OLD.completed;
      END;
      CREATE TEMP TRIGGER progress_count_update AFTER UPDATE OF completed ON analysis_progress_replays
        WHEN OLD.completed<>NEW.completed BEGIN
        UPDATE analysis_progress_counts SET n=n-1 WHERE completed=OLD.completed;
        UPDATE analysis_progress_counts SET n=n+1 WHERE completed=NEW.completed;
      END;
      CREATE TEMP VIEW analysis_progress_population AS SELECT r.id,coalesce(o.owner_id,r.id) AS owner_id,
        (SELECT count(*) FROM main.metric_targets t JOIN main.metric_results c ON c.replay_id=t.replay_id AND c.slot=t.slot
          AND c.stage=t.stage AND c.input_key=t.input_key AND c.producer_version=t.producer_version
          WHERE t.replay_id=coalesce(o.owner_id,r.id) AND (
            t.stage='P' AND t.producer_version='${LIBRARY_P_PRODUCER_VERSION}' AND t.slot IN ('calculated-map','aggregate-pp','fc-pp')
            OR t.stage='S' AND (t.slot='numerical' AND t.producer_version='${LIBRARY_NUMERIC_PROJECTION_VERSION}'
              OR t.slot='timeline-pp' AND t.producer_version='${LIBRARY_TIMELINE_PROJECTION_VERSION}'
              OR t.slot='fc-pp' AND t.producer_version='${LIBRARY_RECONSTRUCTED_FC_VERSION}')))=5 AS completed
        FROM main.replays r LEFT JOIN main.content_identity_metric_owners o ON o.replay_id=r.id
        WHERE r.merged_into IS NULL AND NOT EXISTS(SELECT 1 FROM main.deleted_replays x WHERE x.replay_id=r.id)
          AND NOT ${libraryKnownNonstandardSql("r.id", "r.metadata")};
      INSERT INTO analysis_progress_replays SELECT * FROM analysis_progress_population;`);
    const refreshProgress = (id:string,condition="1") => `DELETE FROM analysis_progress_replays WHERE id=${id} AND ${condition};
      INSERT INTO analysis_progress_replays SELECT * FROM analysis_progress_population WHERE id=${id} AND ${condition};`;
    for(const [table,key] of [["replays","id"],["locations","replay_id"],["deleted_replays","replay_id"],["content_identity_metric_owners","replay_id"]]){
      for(const event of ["INSERT","DELETE","UPDATE"]){
        const ref=event==="DELETE"?"OLD":"NEW";
        db.exec(`CREATE TEMP TRIGGER progress_${table}_${event} AFTER ${event} ON main.${table} BEGIN
          ${event==="UPDATE"?refreshProgress(`OLD.${key}`,`OLD.${key}<>NEW.${key}`):""}
          ${refreshProgress(`${ref}.${key}`)} END;`);
      }
    }
    for(const table of ["metric_targets","metric_results"]){
      for(const event of ["INSERT","DELETE","UPDATE"]){
        const refs=event==="UPDATE"?["OLD","NEW"]:[event==="DELETE"?"OLD":"NEW"];
        db.exec(`CREATE TEMP TRIGGER progress_${table}_${event} AFTER ${event} ON main.${table} BEGIN
          ${refs.map(ref=>`UPDATE analysis_progress_replays SET completed=(SELECT completed FROM analysis_progress_population p
            WHERE p.id=analysis_progress_replays.id) WHERE owner_id=${ref}.replay_id${event==="UPDATE"&&ref==="OLD"?" AND OLD.replay_id<>NEW.replay_id":""};`).join("\n")} END;`);
      }
    }
  }
  read(settings: LibraryAnalysisSettings): LibraryAnalysisActivity {
    const value: LibraryAnalysisActivity = { unit: "work-items", queued: 0, awaitingInputs: 0, deferred: 0,
      failed: 0, running: 0, held: 0, retiring: 0, mode: settings.mode, userPaused: settings.userPaused,
      viewerHold: false, batteryHold: false, resumePending: false };
    const progress=this.db.prepare("SELECT sum(n) AS total,sum(CASE WHEN completed=1 THEN n ELSE 0 END) AS completed FROM analysis_progress_counts").get();
    value.progress={unit:"replays",total:Number(progress?.total),completed:Number(progress?.completed),ready:false};
    for (const row of this.db.prepare("SELECT kind,stage,state,reason,eligibility,n FROM analysis_activity_counts WHERE n>0").all()) {
      if (row.eligibility === 0) continue;
      const n = Number(row.n);
      if (row.state === "failed") { value.failed += n; continue; }
      if (row.eligibility === 1 || row.stage === "S" && (settings.mode === "off" || settings.mode === "demand" && ["background","strip-repair","clock-enrichment"].includes(String(row.reason))))
        value.deferred += n;
      else if (row.state === "running") value.running += n;
      else if (row.kind === "preparation") value.awaitingInputs += n;
      else value.queued += n;
    }
    return value;
  }
}
