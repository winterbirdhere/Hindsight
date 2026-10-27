import type { DatabaseSync } from "node:sqlite";
import type { LibraryAnalysisActivity, LibraryAnalysisSettings } from "../../../../shared/replay-library-metrics";
import { libraryKnownNonstandardSql } from "./library-recorded-evidence";

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
          AND (j.reason='strip-repair' OR NOT EXISTS(SELECT 1 FROM main.metric_results c WHERE c.replay_id=j.replay_id AND c.slot=j.slot
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
  }
  read(settings: LibraryAnalysisSettings): LibraryAnalysisActivity {
    const value: LibraryAnalysisActivity = { unit: "work-items", queued: 0, awaitingInputs: 0, deferred: 0,
      failed: 0, running: 0, held: 0, retiring: 0, mode: settings.mode, userPaused: settings.userPaused,
      viewerHold: false, batteryHold: false, resumePending: false };
    for (const row of this.db.prepare("SELECT kind,stage,state,reason,eligibility,n FROM analysis_activity_counts WHERE n>0").all()) {
      if (row.eligibility === 0) continue;
      const n = Number(row.n);
      if (row.state === "failed") { value.failed += n; continue; }
      if (row.eligibility === 1 || row.stage === "S" && (settings.mode === "off" || settings.mode === "demand" && ["background","strip-repair"].includes(String(row.reason))))
        value.deferred += n;
      else if (row.state === "running") value.running += n;
      else if (row.kind === "preparation") value.awaitingInputs += n;
      else value.queued += n;
    }
    return value;
  }
}
