import type { DatabaseSync } from "node:sqlite";
import type { LibraryMetricTargetInput } from "../../../../shared/replay-library-metrics";
import { LibraryIncidentEvidenceReceipt, validateLibraryIncidentEvidence } from "../../../../shared/library-incidents";
import { LibraryMetricStore } from "./library-metric-store";
import { libraryIncidentTarget } from "./library-incidents-target";

export interface LibraryIncidentLease {
  sourceId:string;sourceKey:string;sourceConfigRevision:number;locationRevision:number;
  sourceEpoch:number;locationEpoch:number;scope:"stable-sidecar"|"unsupported-profile";
}

/** Only input receipts persist here. Transient classification graphs never enter SQLite. */
export class LibraryIncidentRecipeStore {
  constructor(private readonly db:DatabaseSync,private readonly metrics:LibraryMetricStore){}
  static migrate(db:DatabaseSync):void {
    db.exec(`CREATE TABLE incident_recipes(replay_id TEXT PRIMARY KEY REFERENCES replays(id),
      numerical_key TEXT NOT NULL,numerical_version TEXT NOT NULL,evidence TEXT NOT NULL); PRAGMA user_version=17;`);
  }
  static migrateFreshness(db:DatabaseSync):void {
    db.exec(`CREATE TABLE incident_source_epochs(source_id TEXT PRIMARY KEY REFERENCES sources(id),epoch INTEGER NOT NULL);
      CREATE TABLE incident_location_epochs(source_id TEXT NOT NULL,source_key TEXT NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(source_id,source_key));
      ALTER TABLE incident_recipes ADD COLUMN source_id TEXT;
      ALTER TABLE incident_recipes ADD COLUMN source_key TEXT;
      ALTER TABLE incident_recipes ADD COLUMN source_config_revision INTEGER;
      ALTER TABLE incident_recipes ADD COLUMN source_epoch INTEGER;
      ALTER TABLE incident_recipes ADD COLUMN location_epoch INTEGER;
      ALTER TABLE incident_recipes ADD COLUMN scope TEXT;
      DELETE FROM settings WHERE key='source-metric-revision'; PRAGMA user_version=18;`);
  }
  epochs(sourceId:string,sourceKey:string):{sourceEpoch:number;locationEpoch:number} {
    return{sourceEpoch:Number(this.db.prepare("SELECT epoch FROM incident_source_epochs WHERE source_id=?").get(sourceId)?.epoch??0),
      locationEpoch:Number(this.db.prepare("SELECT epoch FROM incident_location_epochs WHERE source_id=? AND source_key=?").get(sourceId,sourceKey)?.epoch??0)};
  }
  dirtyInTransaction(sourceId:string,sourceKey?:string):void {
    if(sourceKey===undefined)this.db.prepare(`INSERT INTO incident_source_epochs VALUES(?,1) ON CONFLICT(source_id) DO UPDATE SET epoch=epoch+1`).run(sourceId);
    else this.db.prepare(`INSERT INTO incident_location_epochs VALUES(?,?,1) ON CONFLICT(source_id,source_key) DO UPDATE SET epoch=epoch+1`).run(sourceId,sourceKey);
  }
  leaseMatches(id:string,evidence:LibraryIncidentEvidenceReceipt,lease:LibraryIncidentLease):boolean {
    if(!lease||!Number.isSafeInteger(lease.sourceConfigRevision)||!Number.isSafeInteger(lease.locationRevision)||
      !Number.isSafeInteger(lease.sourceEpoch)||lease.sourceEpoch<0||!Number.isSafeInteger(lease.locationEpoch)||lease.locationEpoch<0||
      !["stable-sidecar","unsupported-profile"].includes(lease.scope))throw Error("Invalid incident freshness lease");
    const row=this.db.prepare(`SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=? AND l.source_id=? AND l.source_key=?
      AND l.revision=? AND l.sha256=? AND s.config_revision=? AND s.enabled=1 AND s.configured=1`).get(id,lease.sourceId,lease.sourceKey,lease.locationRevision,evidence.replaySha256,lease.sourceConfigRevision);
    const epochs=this.epochs(lease.sourceId,lease.sourceKey);
    return !!row&&(lease.scope==="unsupported-profile"||epochs.sourceEpoch===lease.sourceEpoch&&epochs.locationEpoch===lease.locationEpoch);
  }
  attestInTransaction(id:string,evidence:LibraryIncidentEvidenceReceipt,lease:LibraryIncidentLease):boolean {
    if(!this.leaseMatches(id,evidence,lease))return false;
    const recipe=this.read(id);if(!recipe||JSON.stringify(recipe.evidence)!==JSON.stringify(evidence))return false;
    this.db.prepare(`UPDATE incident_recipes SET source_id=?,source_key=?,source_config_revision=?,source_epoch=?,location_epoch=?,scope=? WHERE replay_id=?`)
      .run(lease.sourceId,lease.sourceKey,lease.sourceConfigRevision,lease.sourceEpoch,lease.locationEpoch,lease.scope,id);return true;
  }
  fresh(id:string):boolean {
    return !!this.db.prepare(`SELECT 1 FROM incident_recipes i JOIN sources s ON s.id=i.source_id JOIN locations l ON l.source_id=i.source_id AND l.source_key=i.source_key
      WHERE i.replay_id=? AND l.replay_id=i.replay_id AND l.sha256=json_extract(i.evidence,'$.replaySha256') AND s.config_revision=i.source_config_revision
      AND (i.scope='unsupported-profile' OR i.scope='stable-sidecar' AND i.source_epoch=coalesce((SELECT epoch FROM incident_source_epochs WHERE source_id=i.source_id),0)
      AND i.location_epoch=coalesce((SELECT epoch FROM incident_location_epochs WHERE source_id=i.source_id AND source_key=i.source_key),0))`).get(id);
  }
  read(id:string):{numerical:{inputKey:string;producerVersion:string};evidence:LibraryIncidentEvidenceReceipt}|undefined {
    const row=this.db.prepare("SELECT * FROM incident_recipes WHERE replay_id=?").get(id);if(!row)return;
    const evidence=JSON.parse(String(row.evidence));validateLibraryIncidentEvidence(evidence);
    return{numerical:{inputKey:String(row.numerical_key),producerVersion:String(row.numerical_version)},evidence};
  }
  bindInTransaction(id:string,numerical:LibraryMetricTargetInput,evidence:LibraryIncidentEvidenceReceipt):void {
    validateLibraryIncidentEvidence(evidence);
    if(numerical.replayId!==id||numerical.slot!=="numerical"||numerical.stage!=="S"||
      !this.db.prepare("SELECT 1 FROM contents WHERE replay_id=? AND sha256=?").get(id,evidence.replaySha256))
      throw new Error("Incident recipe identity mismatch");
    const target=libraryIncidentTarget(numerical,evidence);
    this.db.prepare(`INSERT INTO incident_recipes(replay_id,numerical_key,numerical_version,evidence) VALUES(?,?,?,?) ON CONFLICT(replay_id) DO UPDATE SET
      numerical_key=excluded.numerical_key,numerical_version=excluded.numerical_version,evidence=excluded.evidence,
      source_id=CASE WHEN incident_recipes.evidence=excluded.evidence THEN incident_recipes.source_id ELSE NULL END`)
      .run(id,numerical.inputKey,numerical.producerVersion,JSON.stringify(evidence));
    this.metrics.setTargetInTransaction(target);
  }
  reconcileInTransaction(id:string):void {
    const target=this.currentTarget(id);
    if(target)this.metrics.setTargetInTransaction(target);else this.metrics.clearTargetInTransaction(id,"incidents");
  }
  currentTarget(id:string):LibraryMetricTargetInput|undefined {
    const recipe=this.read(id);if(!recipe)return;
    const numerical=this.metrics.readTarget(id,"numerical");
    if(!numerical||numerical.inputKey!==recipe.numerical.inputKey||numerical.producerVersion!==recipe.numerical.producerVersion){
      return;
    }
    return libraryIncidentTarget(numerical,recipe.evidence);
  }
  forgetProvisionalInTransaction(id:string):void {this.db.prepare("DELETE FROM incident_recipes WHERE replay_id=?").run(id);}
}
