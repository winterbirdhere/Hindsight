import type { DatabaseSync } from "node:sqlite";
import type { LibraryMetricTargetInput } from "../../../../shared/replay-library-metrics";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LibraryNumericalInputRecipe } from "../../../../shared/library-analysis";
import type { LibrarySourceOriginLookup } from "./library-source-binding";
import { LibraryMetricStore } from "./library-metric-store";
import { nativeModEvidence, numericalProfileKey, validateNumericalRecipe } from "./library-numerical-profile";
import { libraryTimelineTarget } from "./library-timeline-target";

/** Scalar dependency recipe owned by SQLite. Every method runs in its caller's transaction.
 * Reconciliation changes current targets only; it never schedules or destroys historical results. */
export class LibraryNumericalRecipeStore {
  constructor(private readonly db:DatabaseSync,private readonly metrics:LibraryMetricStore,private readonly origin:LibrarySourceOriginLookup){}
  static migrate(db:DatabaseSync):void {
    db.exec(`CREATE TABLE numerical_recipes(replay_id TEXT PRIMARY KEY REFERENCES replays(id),producer_version TEXT NOT NULL,recipe TEXT NOT NULL);
      DELETE FROM metric_jobs WHERE slot='numerical' AND producer_version='library-numeric-v1';
      DELETE FROM metric_targets WHERE slot='numerical' AND producer_version='library-numeric-v1';
      DELETE FROM settings WHERE key='source-metric-revision'; PRAGMA user_version=12;`);
  }
  private profile(id:string,recipe:LibraryNumericalInputRecipe){
    const rows=this.db.prepare(`SELECT json_extract(l.metadata,'$.nativeScore.mods') AS mods FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? AND l.sha256=? AND s.kind='lazer'
      AND json_type(l.metadata,'$.nativeScore.isLegacyScore')='false'
      AND json_extract(l.metadata,'$.nativeScore.replay.sha256')=l.sha256 LIMIT 257`).all(id,recipe.replaySha256);
    // More evidence than the bounded reconciliation budget is unavailable, never a partial winner.
    const native=rows.length>256?{state:"unavailable" as const}:nativeModEvidence(rows.map(row=>{
      if(typeof row.mods!=="string")return null;try{return JSON.parse(row.mods);}catch{return null;}
    }));
    const recorded=this.origin(recipe.replaySha256);
    const consumed:LibraryNumericalInputRecipe=recipe.embeddedModsHash===null&&rows.length>0
      ?{...recipe,consumedModsSource:"native-database"}:recipe;
    return{...numericalProfileKey(consumed,{native,origin:recorded?.client??null}),recipe:consumed};
  }
  bindInTransaction(id:string,target:Omit<LibraryMetricTargetInput,"replayId">,recipe:LibraryNumericalInputRecipe):boolean {
    validateNumericalRecipe(recipe);
    if(target.slot!=="numerical"||target.stage!=="S"||target.producerVersion!==LIBRARY_NUMERIC_PROJECTION_VERSION||
      !this.db.prepare("SELECT 1 FROM contents WHERE replay_id=? AND sha256=?").get(id,recipe.replaySha256))throw new Error("Invalid numerical recipe identity");
    const previous=this.db.prepare("SELECT recipe FROM numerical_recipes WHERE replay_id=?").get(id);
    if(previous){
      const retained=JSON.parse(String(previous.recipe)) as LibraryNumericalInputRecipe;validateNumericalRecipe(retained);
      if(retained.replaySha256===recipe.replaySha256&&retained.consumedModsSource==="native-database"&&recipe.embeddedModsHash===null)
        recipe={...recipe,consumedModsSource:"native-database"};
    }
    const profile=this.profile(id,recipe);if(profile.state!=="known"||profile.inputKey!==target.inputKey)return false;
    this.db.prepare(`INSERT INTO numerical_recipes VALUES(?,?,?) ON CONFLICT(replay_id) DO UPDATE SET
      producer_version=excluded.producer_version,recipe=excluded.recipe`).run(id,target.producerVersion,JSON.stringify(profile.recipe));return true;
  }
  reconcileInTransaction(id:string):void {
    const row=this.db.prepare("SELECT * FROM numerical_recipes WHERE replay_id=?").get(id);if(!row)return;
    const recipe=JSON.parse(String(row.recipe)) as LibraryNumericalInputRecipe,profile=this.profile(id,recipe);
    if(profile.recipe!==recipe)this.db.prepare("UPDATE numerical_recipes SET recipe=? WHERE replay_id=?").run(JSON.stringify(profile.recipe),id);
    if(profile.state!=="known"||row.producer_version!==LIBRARY_NUMERIC_PROJECTION_VERSION){
      // An obsolete producer needs fresh preparation; retain the recipe's native provenance.
      // Conflict-only invalidation must not create an automatic retry loop.
      if(row.producer_version!==LIBRARY_NUMERIC_PROJECTION_VERSION)
        this.db.prepare("DELETE FROM analysis_requests WHERE replay_id=? AND stage='S' AND state='bound'").run(id);
      this.metrics.clearTargetInTransaction(id,"numerical");this.metrics.clearTargetInTransaction(id,"timeline-pp");this.metrics.clearReconstructedFcInTransaction(id);return;
    }
    const numerical=this.metrics.setTargetInTransaction({replayId:id,slot:"numerical",stage:"S",inputKey:profile.inputKey,producerVersion:String(row.producer_version)});
    this.metrics.setTargetInTransaction(libraryTimelineTarget(numerical));
    this.metrics.reconcileFcTargetInTransaction(numerical);
  }
  forgetProvisionalInTransaction(id:string):void {this.db.prepare("DELETE FROM numerical_recipes WHERE replay_id=?").run(id);}
}
