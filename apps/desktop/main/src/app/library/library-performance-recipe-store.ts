import { LIBRARY_P_PRODUCER_VERSION } from "./library-performance-versions";
import type { DatabaseSync } from "node:sqlite";
import type { LibraryMetricResult,LibraryMetricSlot } from "../../../../shared/replay-library-metrics";
import type { LibraryPerformanceDependencies } from "./library-performance-dependencies";
import type { LibraryPreparedResult } from "./library-preparation-store";
import { LibraryMetricStore,libraryCapabilityAttempt } from "./library-metric-store";
import { metricInputKey } from "./library-source-metrics";

interface Recipe {version:1;dependencies:LibraryPerformanceDependencies;results:LibraryPreparedResult[]}
const slots:LibraryMetricSlot[]=["calculated-map","aggregate-pp","fc-pp"];
function validateDependencies(value:LibraryPerformanceDependencies):void {
  if(!value||value.version!==1||typeof value.nativeRequired!=="boolean"||
    [value.mapKey,value.profileKey,value.scoreKey].some(key=>typeof key!=="string"||!/^[a-f0-9]{64}$/.test(key))||
    Object.keys(value).some(key=>!["version","mapKey","profileKey","scoreKey","nativeRequired"].includes(key)))throw new Error("Invalid performance dependencies");
}
const profile=(value:unknown)=>value==="lazer-classic"?"lazer":value;

/** Retains bounded P mathematics separately from per-metric visibility policy.
 * All methods are internal to the caller's SQLite transaction; none admit work. */
export class LibraryPerformanceRecipeStore {
  constructor(private readonly db:DatabaseSync,private readonly metrics:LibraryMetricStore,
    private readonly dependencies:(id:string)=>LibraryPerformanceDependencies){}
  static migrate(db:DatabaseSync):void {
    db.exec(`CREATE TABLE performance_recipes(replay_id TEXT PRIMARY KEY REFERENCES replays(id),
      native_required INTEGER NOT NULL,embedded_required INTEGER NOT NULL,payload TEXT); PRAGMA user_version=14;`);
  }
  requirements(id:string):{nativeRequired:boolean;embeddedRequired:boolean} {
    const row=this.db.prepare("SELECT native_required,embedded_required FROM performance_recipes WHERE replay_id=?").get(id);
    return{nativeRequired:row?.native_required===1,embeddedRequired:row?.embedded_required===1};
  }
  bindInTransaction(id:string,dependencies:LibraryPerformanceDependencies,results:LibraryPreparedResult[],embeddedRequired:boolean):void {
    validateDependencies(dependencies);
    if(typeof embeddedRequired!=="boolean"||!Array.isArray(results)||!results.length||results.length>3||
      new Set(results.map(result=>result.slot)).size!==results.length)throw new Error("Invalid performance recipe");
    for(const result of results){
      if(!slots.includes(result.slot)||result.stage!=="P")throw new Error("Invalid performance recipe slot");
      this.metrics.validatePreparedResult({...result,replayId:id},{fields:result.fields,provenance:result.provenance});
    }
    // An additive score retry may improve unknown PP, never replace known raw map math.
    // Check before any write, even if S claimed a competing visibility slot while P ran.
    const recovering=this.nativeSparseScoreRecipe(id,false);
    if(recovering){
      const priorMap=recovering.results.find(result=>result.slot==="calculated-map"),nextMap=results.find(result=>result.slot==="calculated-map");
      if(!priorMap||!nextMap||metricInputKey(priorMap)!==metricInputKey(nextMap))throw Error("Native score recovery changed known map mathematics");
      results=results.map(result=>result.slot==="calculated-map"?priorMap:result);
    }
    const payload=JSON.stringify({version:1,dependencies,results} satisfies Recipe);
    if(Buffer.byteLength(payload)>64*1024)throw new Error("Performance recipe budget exceeded");
    const prior=this.requirements(id);
    this.db.prepare(`INSERT INTO performance_recipes VALUES(?,?,?,?) ON CONFLICT(replay_id) DO UPDATE SET
      native_required=excluded.native_required,embedded_required=excluded.embedded_required,payload=excluded.payload`)
      .run(id,Number(prior.nativeRequired||dependencies.nativeRequired),Number(prior.embeddedRequired||embeddedRequired),payload);
    this.reconcileInTransaction(id);
  }
  /** Pure current raw/visibility certificate. No queue, target, cache or attempt mutation. */
  canRetryNativeSparseScoreInTransaction(id:string):boolean {return this.nativeSparseScoreRecipe(id)!==undefined;}
  private nativeSparseScoreRecipe(id:string,currentTargets=true):Recipe|undefined {
    try{
      const row=this.db.prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(id);if(!row?.payload)return;
      const recipe=JSON.parse(String(row.payload)) as Recipe,current=this.dependencies(id);validateDependencies(current);validateDependencies(recipe.dependencies);
      if(recipe.version!==1||!current.nativeRequired||metricInputKey(current)!==metricInputKey(recipe.dependencies)||
        !Array.isArray(recipe.results)||recipe.results.length!==3||new Set(recipe.results.map(result=>result.slot)).size!==3)return;
      const owned=this.metrics.read(id),map=recipe.results.find(result=>result.slot==="calculated-map");
      if(!map||!Object.keys(map.fields).length||Object.values(map.fields).some(field=>field.state!=="known"))return;
      for(const raw of recipe.results){
        if(raw.stage!=="P"||raw.producerVersion!==LIBRARY_P_PRODUCER_VERSION)return;
        this.metrics.validatePreparedResult({...raw,replayId:id},{fields:raw.fields,provenance:raw.provenance});
        if(raw.provenance.mapSha256!==map.provenance.mapSha256||raw.provenance.mapMd5!==map.provenance.mapMd5||
          raw.provenance.replaySha256!==map.provenance.replaySha256)return;
        let visibility="ready";
        if(raw.slot!=="calculated-map"){
          if(!["aggregate-pp","fc-pp"].includes(raw.slot)||currentTargets&&raw.provenance.capabilityAttempt!==undefined||
            libraryCapabilityAttempt(raw,raw).provenance.capabilityAttempt!=="native-sparse-score-v1")return;
          const value=raw.fields[raw.slot==="aggregate-pp"?"pp":"ppIfFc"];
          if(value?.state!=="unknown"||raw.inputKey!==metricInputKey({version:LIBRARY_P_PRODUCER_VERSION,map:raw.provenance.mapSha256,slot:raw.slot,reason:value.reason}))return;
          const completion=this.completion(id,raw);if(currentTargets&&completion==="failed")return;
          visibility=completion==="unknown"?(raw.slot==="aggregate-pp"?"independent-aggregate":"independent-fc"):completion;
        }
        if(currentTargets){
          const entry=owned.find(entry=>entry.target.slot===raw.slot);
          if(!entry?.result||entry.target.stage!=="P"||entry.target.producerVersion!==raw.producerVersion||
            entry.target.inputKey!==metricInputKey({version:"library-p-visibility-v1",raw:raw.inputKey,visibility})||
            metricInputKey(entry.result)!==metricInputKey({fields:raw.fields,provenance:raw.provenance}))return;
        }
      }
      return recipe;
    }catch{return;}
  }
  private completion(id:string,result:LibraryMetricResult):"passed"|"failed"|"unknown" {
    const numerical=this.metrics.read(id).find(entry=>entry.target.slot==="numerical")?.result;
    if(!numerical)return"unknown";
    const proof=numerical.provenance,expected=result.provenance,completion=numerical.fields.completion;
    if(proof.coverageQualified!==true||proof.completionEvidence!=="source-domain-coverage-v1"||
      !expected.mapSha256||proof.mapSha256!==expected.mapSha256||
      !["stable","lazer"].includes(String(profile(expected.ruleset)))||profile(proof.ruleset)!==profile(expected.ruleset)||
      (expected.replaySha256!==undefined&&proof.replaySha256!==expected.replaySha256)||completion?.state!=="known")return"unknown";
    return completion.value==="passed"||completion.value==="failed"?completion.value:"unknown";
  }
  reconcileInTransaction(id:string):void {
    const row=this.db.prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(id);if(!row?.payload)return;
    const recipe=JSON.parse(String(row.payload)) as Recipe,current=this.dependencies(id);validateDependencies(current);
    if(recipe.version!==1)throw new Error("Unsupported performance recipe");
    const sameMap=current.mapKey===recipe.dependencies.mapKey,sameProfile=current.profileKey===recipe.dependencies.profileKey,
      sameScore=current.scoreKey===recipe.dependencies.scoreKey;
    const owned=this.metrics.read(id);
    for(const slot of slots){
      // S may own the native reconstruction fallback. Its recipe controls its lifetime.
      if(owned.some(entry=>entry.target.slot===slot&&entry.target.stage!=="P"))continue;
      const raw=recipe.results.find(result=>result.slot===slot);
      if(!sameMap||!raw){this.metrics.clearTargetInTransaction(id,slot);continue;}
      const fields={...raw.fields};
      let visibility="ready";
      if(slot==="calculated-map"){
        if(!sameProfile){
          visibility="profile-unavailable";
          for(const name of Object.keys(fields))if(name!=="mapStars")fields[name]={state:"unknown",reason:visibility};
        }
      }else{
        visibility=!sameProfile?"profile-unavailable":!sameScore?"score-unavailable":this.completion(id,raw);
        // Aggregate PP already consumed independently qualified recorded score totals.
        // Unknown S completion cannot invalidate that arithmetic or assert Passed/FC.
        // A distinct visibility key avoids restoring the old completion-masked result.
        if(slot==="aggregate-pp"&&visibility==="unknown")visibility="independent-aggregate";
        // The already-qualified counterfactual estimate does not certify actual FC/Passed.
        if(slot==="fc-pp"&&visibility==="unknown")visibility="independent-fc";
        if(visibility!=="passed"&&visibility!=="independent-aggregate"&&visibility!=="independent-fc")for(const name of Object.keys(fields))fields[name]=visibility==="failed"
          ?{state:"not-applicable",reason:"failed-play"}:{state:"unknown",reason:visibility==="unknown"?"completion-unavailable":visibility};
      }
      const provenance={...raw.provenance};
      // A raw producer attempt is durable, but is not a claim about a withheld projection.
      if(provenance.capabilityAttempt==="native-sparse-score-v1"&&
        ["profile-unavailable","score-unavailable","failed"].includes(visibility))delete provenance.capabilityAttempt;
      this.metrics.bindPreparedResultInTransaction({...raw,replayId:id,inputKey:metricInputKey({version:"library-p-visibility-v1",raw:raw.inputKey,visibility})},
        {fields,provenance});
    }
  }
  mergeProvisionalInTransaction(from:string,into:string):void {
    const prior=this.requirements(from),current=this.requirements(into);
    const row=this.db.prepare("SELECT payload FROM performance_recipes WHERE replay_id=?").get(from);
    if(row)this.db.prepare(`INSERT INTO performance_recipes VALUES(?,?,?,?)
      ON CONFLICT(replay_id) DO UPDATE SET native_required=excluded.native_required,embedded_required=excluded.embedded_required,
      payload=COALESCE(performance_recipes.payload,excluded.payload)`)
      .run(into,Number(prior.nativeRequired||current.nativeRequired),Number(prior.embeddedRequired||current.embeddedRequired),row.payload);
    this.db.prepare("DELETE FROM performance_recipes WHERE replay_id=?").run(from);
  }
}
