import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import { randomUUID } from "crypto";
import { libraryKnownNonstandardSql } from "./library-recorded-evidence";
import { libraryTimelineTarget } from "./library-timeline-target";
import { libraryFcTarget } from "./library-fc-target";
import { validateLibraryErrorStrip } from "../../../../shared/library-error-strip";
import type { LibraryErrorStripEntry } from "../../../../shared/replay-library-metrics";
import type { LibraryAnalysisReason, LibraryAnalysisSettings, LibraryMetricEntry, LibraryMetricJob, LibraryMetricJobReason, LibraryMetricPatch, LibraryMetricResult,
  LibraryMetricSlot, LibraryMetricStage, LibraryMetricTarget, LibraryMetricTargetInput, LibraryMetricTicket } from "../../../../shared/replay-library-metrics";

type Row = Record<string, SQLOutputValue>;
export type LibraryMetricHandoff={state:"claimed";ticket:LibraryMetricTicket}|{state:"cached"|"blocked"|"stale"};
import type { LibraryTimelineOutcome } from "../../../../shared/library-analysis";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import { LIBRARY_P_PRODUCER_VERSION } from "./library-performance-versions";
export type { LibraryTimelineOutcome } from "../../../../shared/library-analysis";
const slots: Record<LibraryMetricSlot, { stages: LibraryMetricStage[]; fields: string[] }> = {
  "source-score": { stages: ["H"], fields: ["accuracy", "maxCombo", "misses", "grade", "completion", "sourcePp"] },
  "source-map": { stages: ["H"], fields: ["sourceMapStars", "cachedBpm", "drainLengthMs", "mapStatus"] },
  "calculated-map": { stages: ["P"], fields: ["mapStars", "replayStars", "bpm", "lengthMs", "exactMapMaxCombo"] },
  "aggregate-pp": { stages: ["P"], fields: ["pp"] },
  numerical: { stages: ["S"], fields: ["completion", "accuracy", "maxCombo", "misses", "sliderBreaks", "sliderEndMisses",
    "sliderTickMisses", "comboLosses", "fc", "perfectCombo", "ur", "biasMs", "sampleCount"] },
  "timeline-pp": { stages: ["S"], fields: ["pp", "peakPp"] },
  "fc-pp": { stages: ["P", "S"], fields: ["ppIfFc"] },
  incidents: { stages: ["C"], fields: ["incidentCount"] },
};
const counts = new Set(["maxCombo", "misses", "sliderBreaks", "sliderEndMisses", "sliderTickMisses", "comboLosses", "sampleCount", "incidentCount", "exactMapMaxCombo"]);
const enums: Record<string, string[]> = { completion: ["passed", "failed"], grade: ["SS", "S", "A", "B", "C", "D", "F"],
  mapStatus: ["ranked", "approved", "qualified", "loved", "pending", "wip", "graveyard"] };
const provenanceHashes = new Set(["replaySha256", "mapSha256", "mapMd5", "evidenceSha256", "modsHash", "profileHash", "sourceEvidenceHash", "schemaHash","modelRevision"]);
const provenanceTokens = new Set(["sourceId", "sourceKind", "profileId", "ruleset", "parserVersion", "preparationVersion", "engineVersion",
  "projectionVersion", "validationVersion", "evidenceState", "completionEvidence", "scoreOrigin",
  "policyVersion","groupingVersion","countBasis","analysisStatus"]);
const provenanceBooleans = new Set(["completeBreakEvidence", "completeAccuracyEvidence", "coverageQualified", "verifiedPassed", "sourceOnly"]);
const priorities: Record<LibraryAnalysisReason, number> = { open: 0, selection: 1, retry: 2, background: 3 };
const token = (v: unknown, max = 128): v is string => typeof v === "string" && v.length > 0 && v.length <= max && /^[a-zA-Z0-9_.:/+-]+$/.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function invalid(): never { throw new Error("Invalid library metric payload"); }
/** A successful current producer attempt, not an evidence/qualification claim.
 * Call only at actual calculation publication; cache restoration never adds it. */
export function libraryCapabilityAttempt(target:Pick<LibraryMetricTarget,"slot"|"stage"|"producerVersion">,result:LibraryMetricResult):LibraryMetricResult {
  const attempt=capabilityAttemptFor(target,result);
  return attempt?{...result,provenance:{...result.provenance,capabilityAttempt:attempt}}:result;
}
function capabilityAttemptFor(target:Pick<LibraryMetricTarget,"slot"|"stage"|"producerVersion">,result:LibraryMetricResult):string|undefined {
  const p=result.provenance,completion=result.fields.completion,bpm=result.fields.bpm;
  const reasons:Record<string,string>={completion:"completion-not-established",fc:"completion-not-established",perfectCombo:"exact-map-combo-unavailable",
    ur:"no-valid-timing-samples",biasMs:"no-valid-timing-samples"};
  if(target.slot==="numerical"&&target.stage==="S"&&target.producerVersion===LIBRARY_NUMERIC_PROJECTION_VERSION&&
    p.projectionVersion===LIBRARY_NUMERIC_PROJECTION_VERSION&&(p.ruleset==="stable"||p.ruleset==="lazer")&&p.scoreOrigin==="reconstructed"&&
    p.coverageQualified===false&&p.completeAccuracyEvidence===false&&p.completeBreakEvidence===false&&
    p.completionEvidence==="source-domain-coverage-v1"&&completion?.state==="unknown"&&completion.reason==="completion-not-established"&&
    Object.entries(result.fields).every(([name,field])=>field.state==="not-applicable"
      ?name==="sliderBreaks"&&field.reason==="stable-slider-breaks-only"||name==="sliderTickMisses"&&field.reason==="native-slider-ticks-only"
      :field.state==="unknown"&&field.reason===(reasons[name]??"numerical-evidence-incomplete"))&&
    (result.errorStrip===undefined||result.errorStrip.state==="unknown"&&result.errorStrip.reason==="strip-evidence-incomplete"))
    return p.ruleset==="stable"?"stable-prefix-v3":"native-held-release-v2";
  if(target.slot==="calculated-map"&&target.stage==="P"&&target.producerVersion===LIBRARY_P_PRODUCER_VERSION&&
    bpm?.state==="unknown"&&["constant-tempo-unavailable","tempo-geometry-budget"].includes(bpm.reason)&&
    Object.entries(result.fields).every(([name,field])=>name==="bpm"||field.state==="known"))return"dominant-tempo-v2";
  const nativeField=target.slot==="aggregate-pp"?"pp":target.slot==="fc-pp"?"ppIfFc":undefined;
  const nativeValue=nativeField?result.fields[nativeField]:undefined;
  if(target.stage==="P"&&target.producerVersion===LIBRARY_P_PRODUCER_VERSION&&nativeField&&
    Object.keys(result.fields).length===1&&nativeValue?.state==="unknown"&&
    ["aggregate-object-coverage-incomplete","native-component-evidence-unavailable"].includes(nativeValue.reason)&&
    ["lazer","lazer-classic"].includes(String(p.ruleset))&&p.engineVersion===PERFORMANCE_ENGINE_VERSION&&p.sourceOnly!==true&&
    typeof p.mapMd5==="string"&&/^[a-f0-9]{32}$/.test(p.mapMd5)&&
    [p.mapSha256,p.replaySha256].every(value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value)))return"native-sparse-score-v1";
  return undefined;
}
function validCapabilityAttempt(target:Pick<LibraryMetricTarget,"slot"|"stage"|"producerVersion">,result:LibraryMetricResult,value:unknown):boolean {
  const current=capabilityAttemptFor(target,result);
  // Old current-input receipts remain readable/restorable. Only a fresh producer
  // commit upgrades their attempt; observing a cache must never do so.
  return typeof value==="string"&&(value===current||
    ["stable-prefix-v1","stable-prefix-v2"].includes(value)&&current==="stable-prefix-v3"||
    value==="native-initial-negative-v1"&&current==="native-held-release-v2");
}
function validateSettings(value: unknown): asserts value is LibraryAnalysisSettings {
  if (!record(value) || typeof value.mode !== "string" || !["bg", "demand", "off"].includes(value.mode) ||
    typeof value.userPaused !== "boolean" || typeof value.pauseOnBattery !== "boolean" || ![1, 2, 4].includes(value.workers as number) ||
    value.fasterProcessing!==undefined&&typeof value.fasterProcessing!=="boolean"||
    Object.keys(value).some(key => !["mode", "userPaused", "workers", "pauseOnBattery", "fasterProcessing"].includes(key))) {
    throw new Error("Invalid library analysis settings");
  }
}
function validateTarget(input: LibraryMetricTargetInput): void {
  if (!input || !token(input.replayId) || !Object.prototype.hasOwnProperty.call(slots, input.slot) ||
    !slots[input.slot].stages.includes(input.stage) || !token(input.inputKey, 512) || !token(input.producerVersion)) invalid();
}
function validateGeneration(input: LibraryMetricTarget): void {
  validateTarget(input); if (!Number.isSafeInteger(input.generation) || input.generation <= 0) invalid();
}
/** Only bounded scalar projections cross this persistence boundary; event/cause graphs have no field here. */
function encodeResult(target: LibraryMetricTarget, result: LibraryMetricResult): string {
  if (!record(result) || !record(result.fields) || !record(result.provenance) ||
    Object.keys(result).some(k => k !== "fields" && k !== "provenance" && k !== "errorStrip")) invalid();
  encodeStrip(target,result);
  const fields = Object.entries(result.fields);
  if (fields.length === 0 || fields.length > 32 || Object.keys(result.provenance).length > 24) invalid();
  for (const [name, metric] of fields) {
    if (!slots[target.slot].fields.includes(name) || !record(metric)) invalid();
    if (metric.state !== "known") {
      if (!["unknown", "not-applicable", "error"].includes(String(metric.state)) || !token(metric.reason) ||
        Object.keys(metric).some(k => k !== "state" && k !== "reason")) invalid();
      continue;
    }
    if (Object.keys(metric).some(k => k !== "state" && k !== "value")) invalid();
    const value = metric.value;
    if (name === "fc" || name === "perfectCombo") { if (typeof value !== "boolean") invalid(); }
    else if (enums[name]) { if (typeof value !== "string" || !enums[name].includes(value)) invalid(); }
    else {
      if (typeof value !== "number" || !Number.isFinite(value) || (name !== "biasMs" && value < 0) ||
        (counts.has(name) && !Number.isSafeInteger(value)) || (name === "accuracy" && value > 1)) invalid();
    }
  }
  for (const [key, value] of Object.entries(result.provenance)) {
    if (provenanceHashes.has(key)) {
      if (typeof value !== "string" || !(key === "mapMd5" ? /^[0-9a-f]{32}$/ : /^[0-9a-f]{64}$/).test(value)) invalid();
    } else if (provenanceTokens.has(key)) { if (!token(value)) invalid(); }
    else if (provenanceBooleans.has(key)) { if (typeof value !== "boolean") invalid(); }
    else if (key === "sourceCoverageEvidence") {
      const expectedRuleset=value==="native-initial-held-release-v1"?"lazer":
        ["stable-released-prefix-v1","stable-neutral-multi-reset-v1","stable-neutral-later-reset-v1","stable-initial-negative-v1"].includes(String(value))?"stable":undefined;
      if (!expectedRuleset || typeof value!=="string" || target.slot !== "numerical" || target.stage !== "S" ||
        target.producerVersion !== LIBRARY_NUMERIC_PROJECTION_VERSION || result.provenance.projectionVersion !== LIBRARY_NUMERIC_PROJECTION_VERSION ||
        result.provenance.ruleset !== expectedRuleset || result.provenance.scoreOrigin !== "reconstructed" ||
        result.provenance.coverageQualified !== true || result.provenance.completionEvidence !== "source-domain-coverage-v1") invalid();
    }
    else if (key === "capabilityAttempt") { if(!validCapabilityAttempt(target,result,value))invalid(); }
    else if (key === "rate") { if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalid(); }
    else invalid();
  }
  const json = JSON.stringify({ fields: Object.fromEntries(fields.sort(([a], [b]) => a.localeCompare(b))),
    provenance: Object.fromEntries(Object.entries(result.provenance).sort(([a], [b]) => a.localeCompare(b))) });
  if (Buffer.byteLength(json) > 16 * 1024) invalid();
  return json;
}
function encodeStrip(target:LibraryMetricTarget,result:LibraryMetricResult):string|null {
  if(result.errorStrip===undefined)return null;
  if(target.slot!=="numerical"||target.stage!=="S")throw new Error("Invalid library error strip owner");
  validateLibraryErrorStrip(result.errorStrip);return JSON.stringify(result.errorStrip);
}
function head(row: Row): LibraryMetricTarget {
  return { replayId: String(row.replay_id), slot: row.slot as LibraryMetricSlot, stage: row.stage as LibraryMetricStage,
    inputKey: String(row.input_key), producerVersion: String(row.producer_version), generation: Number(row.generation) };
}
function job(row: Row): LibraryMetricJob {
  return { id: String(row.id), target: head(row), reason: row.reason as LibraryMetricJobReason, state: row.state as LibraryMetricJob["state"],
    ...(row.error === null ? {} : { error: String(row.error) }) };
}

/** Internal utility-process API. Reads/target changes never admit analysis work. */
export class LibraryMetricStore {
  // Statements belong to this connection; prepare lazily after schema migration.
  private clearTargetStatement?: StatementSync;
  private clearJobStatement?: StatementSync;
  constructor(private readonly db: DatabaseSync, private readonly resolveId: (id: string) => string,
    private readonly transaction: <T>(work: () => T) => T, private readonly clearPreparations: () => void = () => undefined,
    private readonly reconcileBeforeCommit:(id:string)=>void=()=>undefined,private readonly dirty:(flags:number)=>void=()=>undefined,
    private readonly numericalChanged:(id:string)=>void=()=>undefined,
    private readonly incidentTarget:(id:string)=>LibraryMetricTargetInput|undefined=()=>undefined,
    private readonly incidentFresh:(id:string)=>boolean=()=>true,
    private readonly preserveIndependentPerformance:(target:LibraryMetricTarget,result:LibraryMetricResult)=>boolean=()=>false) {}

  static migrate(db: DatabaseSync): void {
    db.exec(`CREATE TABLE metric_targets(replay_id TEXT NOT NULL REFERENCES replays(id),slot TEXT NOT NULL,
      stage TEXT NOT NULL,input_key TEXT NOT NULL,producer_version TEXT NOT NULL,generation INTEGER NOT NULL,
      PRIMARY KEY(replay_id,slot));
      CREATE TABLE metric_results(replay_id TEXT NOT NULL REFERENCES replays(id),slot TEXT NOT NULL,stage TEXT NOT NULL,
      input_key TEXT NOT NULL,producer_version TEXT NOT NULL,payload TEXT NOT NULL,
      PRIMARY KEY(replay_id,slot,stage,input_key,producer_version));
      CREATE TABLE metric_jobs(id TEXT PRIMARY KEY,replay_id TEXT NOT NULL REFERENCES replays(id),slot TEXT NOT NULL,stage TEXT NOT NULL,
      input_key TEXT NOT NULL,producer_version TEXT NOT NULL,generation INTEGER NOT NULL,reason TEXT NOT NULL,
      state TEXT NOT NULL,attempt TEXT,error TEXT,UNIQUE(replay_id,slot));
      INSERT OR IGNORE INTO counters VALUES('metric-generation',0); PRAGMA user_version=10;`);
  }
  recover(): void {
    this.transaction(() => {
      // C produced only the removed library incident-count feature. Keep historical
      // result payloads inert, but never resurrect its app-owned queue on restart.
      this.db.exec("DELETE FROM metric_jobs WHERE stage='C' OR slot='incidents'");
      if (this.analysisSettings().mode === "off") this.clearUnfinishedAnalysisJobs();
      this.db.exec("UPDATE metric_jobs SET state='queued',attempt=NULL,error=NULL WHERE state='running' OR state='queued' AND (attempt IS NOT NULL OR error IS NOT NULL)");
    });
  }
  analysisSettings(): LibraryAnalysisSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='analysis'").get();
    let value: unknown={ mode: "bg", userPaused: false, workers: 2, pauseOnBattery: true };
    try { if(row)value = JSON.parse(String(row.value)); } catch { throw new Error("Invalid library analysis settings"); }
    validateSettings(value);
    if(Object.prototype.hasOwnProperty.call(value,"fasterProcessing"))throw new Error("Invalid legacy library analysis settings");
    const policy=this.db.prepare("SELECT value FROM settings WHERE key='analysis-faster-processing'").get();
    if(policy&&policy.value!=="true"&&policy.value!=="false")throw new Error("Invalid library analysis settings");
    return policy?.value==="true"?{...value,fasterProcessing:true}:value;
  }
  setAnalysisSettings(value: LibraryAnalysisSettings): void {
    validateSettings(value);
    const prior=this.analysisSettings();
    const legacyChanged=prior.mode!==value.mode||prior.userPaused!==value.userPaused||prior.workers!==value.workers||prior.pauseOnBattery!==value.pauseOnBattery;
    const fasterProcessing=value.fasterProcessing??prior.fasterProcessing??false,policyChanged=fasterProcessing!==(prior.fasterProcessing??false);
    if(!legacyChanged&&!policyChanged)return;
    this.transaction(() => {
      // Keep the legacy four-field document readable by preserved older previews.
      if(legacyChanged)this.db.prepare("INSERT INTO settings VALUES('analysis',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({mode:value.mode,userPaused:value.userPaused,workers:value.workers,pauseOnBattery:value.pauseOnBattery}));
      if(policyChanged)this.db.prepare("INSERT INTO settings VALUES('analysis-faster-processing',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(fasterProcessing));
      if (legacyChanged&&value.mode === "off") this.clearUnfinishedAnalysisJobs();
      this.dirty(legacyChanged?7:2);
    });
  }
  private admitted(stage: LibraryMetricStage, reason: LibraryMetricJobReason, settings: LibraryAnalysisSettings): boolean {
    return stage !== "C" && (stage !== "S" || (settings.mode !== "off" && (settings.mode !== "demand" || !["background","strip-repair"].includes(reason))));
  }
  /** Passive bounded queue view. Transient viewer/battery admission is enforced separately by the scheduler. */
  nextQueued(limit = 32, includeNative = true, availableSlots?: readonly LibraryMetricSlot[]): LibraryMetricJob[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256 || typeof includeNative !== "boolean") throw new Error("Invalid library metric queue limit");
    if(availableSlots!==undefined&&(!Array.isArray(availableSlots)||!availableSlots.length||availableSlots.length>8||
      new Set(availableSlots).size!==availableSlots.length||availableSlots.some(slot=>!Object.prototype.hasOwnProperty.call(slots,slot))))throw new Error("Invalid producer slots");
    const settings = this.analysisSettings(); if (settings.userPaused) return [];
    return this.db.prepare(`SELECT j.* FROM metric_jobs j JOIN metric_targets t ON
      t.replay_id=j.replay_id AND t.slot=j.slot AND t.stage=j.stage AND t.input_key=j.input_key
      AND t.producer_version=j.producer_version AND t.generation=j.generation
      JOIN replays r ON r.id=j.replay_id WHERE j.state='queued' AND r.merged_into IS NULL
      AND j.stage<>'C' AND j.slot<>'incidents' AND NOT ${libraryKnownNonstandardSql("r.id","r.metadata")}
      AND EXISTS(SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=j.replay_id AND s.enabled=1 AND s.configured=1)
      AND (?=1 OR j.slot IN ('numerical','incidents'))
      ${availableSlots?"AND j.slot IN ("+availableSlots.map(()=>"?").join(",")+")":""}
      AND (j.stage NOT IN ('S','C') OR (?<>'off' AND (?<>'demand' OR j.reason NOT IN ('background','strip-repair'))))
      AND (j.slot<>'fc-pp' OR j.stage<>'S' OR NOT EXISTS(SELECT 1 FROM metric_jobs pending
        WHERE pending.replay_id=j.replay_id AND pending.slot='timeline-pp' AND pending.state IN ('queued','running')))
      AND (j.slot<>'incidents' OR NOT EXISTS(SELECT 1 FROM metric_jobs pending WHERE pending.replay_id=j.replay_id
        AND pending.stage='S' AND pending.slot IN ('numerical','timeline-pp','fc-pp') AND pending.state IN ('queued','running')))
      AND ((j.slot<>'timeline-pp' AND (j.slot<>'fc-pp' OR j.stage<>'S')) OR EXISTS(SELECT 1 FROM metric_targets n JOIN metric_results c ON
        c.replay_id=n.replay_id AND c.slot=n.slot AND c.stage=n.stage AND c.input_key=n.input_key AND c.producer_version=n.producer_version
        WHERE n.replay_id=j.replay_id AND n.slot='numerical' AND (j.slot<>'fc-pp' OR
          (json_extract(c.payload,'$.provenance.coverageQualified')=1 AND json_extract(c.payload,'$.fields.completion.state')='known'
            AND json_extract(c.payload,'$.fields.completion.value')='passed'))))
      AND (j.reason='strip-repair' OR NOT EXISTS(SELECT 1 FROM metric_results c WHERE c.replay_id=j.replay_id AND c.slot=j.slot
        AND c.stage=j.stage AND c.input_key=j.input_key AND c.producer_version=j.producer_version))
      ORDER BY CASE j.reason WHEN 'open' THEN 0 WHEN 'selection' THEN 1 WHEN 'retry' THEN 2 ELSE 3 END,
        r.added_at DESC,r.added_sequence DESC,j.id LIMIT ?`).all(includeNative ? 1 : 0,...(availableSlots??[]), settings.mode, settings.mode, limit).map(job)
        .filter(value=>(value.target.slot!=="incidents"||this.dependencyReady(value.target))&&
          (value.reason!=="strip-repair"||this.stripRepairTargetInTransaction(value.target.replayId)?.generation===value.target.generation));
  }
  private hasEnabledSource(id: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM replays r WHERE r.id=? AND NOT ${libraryKnownNonstandardSql("r.id","r.metadata")}
      AND EXISTS(SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=r.id AND s.enabled=1 AND s.configured=1)`).get(id);
  }
  private nextGeneration(): number {
    const value = Number(this.db.prepare("UPDATE counters SET value=value+1 WHERE key='metric-generation' RETURNING value").get()?.value);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Library metric generation exhausted");
    return value;
  }
  private current(target: LibraryMetricTarget): boolean {
    // Never resolve aliases for publication: old identity ownership must stay invalid after merging.
    return !!this.db.prepare(`SELECT 1 FROM metric_targets t JOIN replays r ON r.id=t.replay_id
      WHERE r.merged_into IS NULL AND t.replay_id=? AND t.slot=? AND t.stage=? AND t.input_key=? AND t.producer_version=? AND t.generation=?`)
      .get(target.replayId, target.slot, target.stage, target.inputKey, target.producerVersion, target.generation);
  }
  private cached(target: LibraryMetricTarget): Row | undefined {
    return this.db.prepare("SELECT payload,strip_payload FROM metric_results WHERE replay_id=? AND slot=? AND stage=? AND input_key=? AND producer_version=?")
      .get(target.replayId, target.slot, target.stage, target.inputKey, target.producerVersion);
  }
  private dependencyReady(target:LibraryMetricTarget):boolean {
    if(target.slot==="incidents"){
      const expected=this.incidentTarget(target.replayId);
      if(!expected||!this.incidentFresh(target.replayId)||expected.inputKey!==target.inputKey||expected.producerVersion!==target.producerVersion||
        this.db.prepare("SELECT 1 FROM metric_jobs WHERE replay_id=? AND stage='S' AND slot IN ('numerical','timeline-pp','fc-pp') AND state IN ('queued','running')").get(target.replayId))return false;
      const numerical=this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=? AND slot='numerical'").get(target.replayId);
      return !!numerical&&!!this.cached(head(numerical));
    }
    if(target.slot!=="timeline-pp"&&!(target.slot==="fc-pp"&&target.stage==="S"))return true;
    if(target.slot==="fc-pp"&&this.db.prepare("SELECT 1 FROM metric_jobs WHERE replay_id=? AND slot='timeline-pp' AND state IN ('queued','running')").get(target.replayId))return false;
    const row=this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=? AND slot='numerical'").get(target.replayId);
    if(!row)return false;const numerical=head(row),expected=target.slot==="fc-pp"?libraryFcTarget(numerical):libraryTimelineTarget(numerical),cached=this.cached(numerical);
    if(!cached||expected.inputKey!==target.inputKey||expected.producerVersion!==target.producerVersion)return false;
    const result=JSON.parse(String(cached.payload)) as LibraryMetricResult;
    return target.slot!=="fc-pp"||result.provenance.coverageQualified===true&&result.fields.completion?.state==="known"&&result.fields.completion.value==="passed";
  }
  setTarget(input: LibraryMetricTargetInput): LibraryMetricTarget {
    validateTarget(input);
    return this.transaction(() => this.setTargetInTransaction(input));
  }
  setTargetInTransaction(input: LibraryMetricTargetInput): LibraryMetricTarget {
      validateTarget(input);
      const replayId = this.resolveId(input.replayId);
      const old = this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=? AND slot=?").get(replayId, input.slot);
      if (old && old.stage === input.stage && old.input_key === input.inputKey && old.producer_version === input.producerVersion) return head(old);
      const generation = this.nextGeneration();
      this.db.prepare(`INSERT INTO metric_targets VALUES(?,?,?,?,?,?) ON CONFLICT(replay_id,slot) DO UPDATE SET
        stage=excluded.stage,input_key=excluded.input_key,producer_version=excluded.producer_version,generation=excluded.generation`)
        .run(replayId, input.slot, input.stage, input.inputKey, input.producerVersion, generation);
      this.db.prepare("DELETE FROM metric_jobs WHERE replay_id=? AND slot=?").run(replayId, input.slot);
      if(input.stage!=="H")this.dirty(4);
      if(input.slot==="numerical")this.numericalChanged(replayId);
      return { replayId, slot: input.slot, stage: input.stage, inputKey: input.inputKey, producerVersion: input.producerVersion, generation };
  }
  /** Internal H binding: caller owns the observation/identity transaction. Never admits work. */
  bindObservedInTransaction(input: LibraryMetricTargetInput, result: LibraryMetricResult): void {
    validateTarget(input); if (input.stage !== "H") invalid();
    const target = this.setTargetInTransaction(input), payload = encodeResult(target, result);
    if (!this.compatibleIdentity(target.replayId, result)) throw new Error("Library metric replay identity mismatch");
    this.write(target, payload);
  }
  /** Called only by the live P preparation transaction after source/map evidence CAS. */
  validatePreparedResult(input:LibraryMetricTargetInput,result:LibraryMetricResult):void {
    validateTarget(input);if(input.stage!=="P")invalid();
    encodeResult({...input,generation:1},result);
    if(!this.compatibleIdentity(input.replayId,result))throw new Error("Library metric replay identity mismatch");
  }
  bindPreparedResultInTransaction(input:LibraryMetricTargetInput,result:LibraryMetricResult):void {
    // Recipe visibility can withhold a formerly computed map profile. Its raw
    // recipe retains the attempt, but that marker is not a claim about these fields.
    if(input.slot==="calculated-map"&&input.stage==="P"&&input.producerVersion===LIBRARY_P_PRODUCER_VERSION&&
      result.provenance.capabilityAttempt==="dominant-tempo-v2"&&result.fields.bpm?.state==="unknown"&&result.fields.bpm.reason==="profile-unavailable"&&
      Object.entries(result.fields).every(([name,field])=>name==="mapStars"?field.state==="known":field.state==="unknown"&&field.reason==="profile-unavailable")){
      const provenance={...result.provenance};delete provenance.capabilityAttempt;result={...result,provenance};
    }
    this.validatePreparedResult(input,result);
    const target=this.setTargetInTransaction(input),payload=encodeResult(target,result);
    if(!this.compatibleIdentity(target.replayId,result))throw new Error("Library metric replay identity mismatch");
    this.write(target,payload);
  }
  clearObservedInTransaction(id: string, slot: "source-score" | "source-map"): void {
    this.db.prepare("DELETE FROM metric_targets WHERE replay_id=? AND slot=? AND stage='H'").run(id, slot);
    this.db.prepare("DELETE FROM metric_jobs WHERE replay_id=? AND slot=? AND stage='H'").run(id, slot);
  }
  /** Internal semantic reconciliation only; cached results remain reusable. */
  clearTargetInTransaction(id:string,slot:LibraryMetricSlot):void {
    if(!Object.prototype.hasOwnProperty.call(slots,slot))invalid();
    const removed=(this.clearTargetStatement??=this.db.prepare("DELETE FROM metric_targets WHERE replay_id=? AND slot=?")).run(id,slot);
    (this.clearJobStatement??=this.db.prepare("DELETE FROM metric_jobs WHERE replay_id=? AND slot=?")).run(id,slot);
    if(Number(removed.changes))this.dirty(4);
    if(Number(removed.changes)&&slot==="numerical")this.numericalChanged(id);
  }
  /** Internal dependency identity only; results, jobs and receipt freshness are separate. */
  readTarget(id:string,slot:LibraryMetricSlot):LibraryMetricTarget|undefined {
    if(!Object.prototype.hasOwnProperty.call(slots,slot))invalid();
    const row=this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=? AND slot=?").get(this.resolveId(id),slot);
    return row?head(row):undefined;
  }
  read(id: string): LibraryMetricEntry[] {
    return this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=? ORDER BY slot").all(this.resolveId(id)).map(row => {
      const target = head(row), cached = target.slot==="incidents"&&!this.incidentFresh(target.replayId)?undefined:this.cached(target);
      const pending = this.db.prepare("SELECT * FROM metric_jobs WHERE replay_id=? AND slot=?").get(target.replayId, target.slot);
      return { target, result: cached ? JSON.parse(String(cached.payload)) as LibraryMetricResult : undefined, job: pending ? job(pending) : undefined };
    });
  }
  /** Read-only qualification; transient ownership stays at the mutation boundary so
   * an eligible busy input can retain its deferred recovery wake. */
  canRetryRejectedCoverageInTransaction(id:string):boolean {
    return this.rejectedCoverageTargetsInTransaction(id)!==undefined;
  }
  private rejectedCoverageTargetsInTransaction(id:string):LibraryMetricTarget[]|undefined {
    const numerical=this.readTarget(id,"numerical");
    if(!numerical||numerical.stage!=="S"||numerical.producerVersion!==LIBRARY_NUMERIC_PROJECTION_VERSION||!this.current(numerical))return undefined;
    const cached=this.db.prepare("SELECT payload,strip_payload FROM metric_results WHERE replay_id=? AND slot='numerical' AND stage=? AND input_key=? AND producer_version=?")
      .get(id,numerical.stage,numerical.inputKey,numerical.producerVersion);
    if(!cached)return undefined;
    const result=JSON.parse(String(cached.payload)) as LibraryMetricResult,proof=result.provenance,completion=result.fields.completion;
    if(proof.projectionVersion!==LIBRARY_NUMERIC_PROJECTION_VERSION||proof.coverageQualified!==false||proof.completeAccuracyEvidence!==false||
      proof.completeBreakEvidence!==false||proof.completionEvidence!=="source-domain-coverage-v1"||proof.scoreOrigin!=="reconstructed"||
      completion?.state!=="unknown"||completion.reason!=="completion-not-established")return undefined;
    const reasons:Record<string,string>={completion:"completion-not-established",fc:"completion-not-established",perfectCombo:"exact-map-combo-unavailable",
      ur:"no-valid-timing-samples",biasMs:"no-valid-timing-samples"};
    if(Object.entries(result.fields).some(([name,value])=>value.state==="not-applicable"
      ?!(name==="sliderBreaks"&&value.reason==="stable-slider-breaks-only"||name==="sliderTickMisses"&&value.reason==="native-slider-ticks-only")
      :value.state!=="unknown"||value.reason!==(reasons[name]??"numerical-evidence-incomplete")))return undefined;
    if(cached.strip_payload){const strip=JSON.parse(String(cached.strip_payload)) as {state:string;reason?:string};
      if(strip.state!=="unknown"||strip.reason!=="strip-evidence-incomplete")return undefined;}
    const retire=[numerical];
    for(const slot of ["aggregate-pp","timeline-pp","fc-pp"] as const){
      const target=this.readTarget(id,slot);if(!target)continue;
      const prior=this.cached(target),value=prior?JSON.parse(String(prior.payload)) as LibraryMetricResult:undefined;
      // Never replace a known/defined-unavailable P score because of inconsistent S evidence.
      if(target.stage==="P"){
        if(value&&Object.values(value.fields).some(field=>field.state!=="unknown")&&
          !this.preserveIndependentPerformance(target,value))return undefined;
        continue;
      }
      if(slot==="aggregate-pp"||target.stage!=="S")return undefined;
      const expected=slot==="timeline-pp"?libraryTimelineTarget(numerical):libraryFcTarget(numerical);
      if(target.inputKey!==expected.inputKey||target.producerVersion!==expected.producerVersion)return undefined;
      if(value&&(value.provenance.coverageQualified!==false||Object.entries(value.fields).some(([name,field])=>
        field.state!=="unknown"||field.reason!==(name==="peakPp"?"performance-data-unavailable":"completion-not-established"))))return undefined;
      retire.push(target);
    }
    return retire;
  }
  /** Explicit S preparation retry only; caller owns the source/policy-checked transaction.
   * Reconsider rejected coverage without invalidating qualified v6 mathematics globally. */
  retryRejectedCoverageInTransaction(id:string):boolean {
    if(this.db.prepare("SELECT 1 FROM metric_jobs WHERE replay_id=? AND slot='numerical' AND state IN ('queued','running')").get(id))return false;
    const retire=this.rejectedCoverageTargetsInTransaction(id);if(!retire)return false;
    // Results are keyed without generation. Remove only these exact rejected tuples,
    // and fence every old attempt before ordinary preparation revalidates resources.
    for(const target of retire){
      this.db.prepare("DELETE FROM metric_results WHERE replay_id=? AND slot=? AND stage=? AND input_key=? AND producer_version=?")
        .run(id,target.slot,target.stage,target.inputKey,target.producerVersion);
      this.db.prepare("DELETE FROM metric_jobs WHERE replay_id=? AND slot=?").run(id,target.slot);
      const changed=this.db.prepare("UPDATE metric_targets SET generation=? WHERE replay_id=? AND slot=? AND stage=? AND input_key=? AND producer_version=? AND generation=?")
        .run(this.nextGeneration(),id,target.slot,target.stage,target.inputKey,target.producerVersion,target.generation);
      if(Number(changed.changes)!==1)throw new Error("Rejected coverage target changed during retry");
    }
    this.dirty(4);this.numericalChanged(id);return true;
  }
  readErrorStrip(id:string):LibraryErrorStripEntry|undefined {
    const row=this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=? AND slot='numerical'").get(this.resolveId(id));
    if(!row)return undefined;const target=head(row);
    const cached=this.db.prepare(`SELECT strip_payload FROM metric_results WHERE replay_id=? AND slot=? AND stage=? AND input_key=? AND producer_version=?`)
      .get(target.replayId,target.slot,target.stage,target.inputKey,target.producerVersion);
    const pending=this.db.prepare("SELECT * FROM metric_jobs WHERE replay_id=? AND slot='numerical'").get(target.replayId);
    const result=cached?.strip_payload?JSON.parse(String(cached.strip_payload)):undefined;
    if(result!==undefined)validateLibraryErrorStrip(result);
    return{target,result,job:pending?job(pending):undefined};
  }
  request(target: LibraryMetricTarget, reason: LibraryAnalysisReason): LibraryMetricJob | { state: "cached" | "stale" | "disabled" } {
    validateGeneration(target); if (!Object.prototype.hasOwnProperty.call(priorities, reason)) invalid();
    if(target.stage==="C"||target.slot==="incidents")return{state:"disabled"};
    return this.transaction(() => this.requestInTransaction(target, reason));
  }
  /** Nonmutating, exact-current certificate for the old count-budget rejection.
   * Scalar qualification and bytes remain authoritative throughout the repair. */
  stripRepairTargetInTransaction(id:string):LibraryMetricTarget|undefined {
    const target=this.readTarget(id,"numerical");
    if(!target||target.replayId!==id||target.stage!=="S"||target.producerVersion!==LIBRARY_NUMERIC_PROJECTION_VERSION||!this.current(target))return;
    const cached=this.cached(target);if(!cached?.strip_payload)return;
    try{
      const result=JSON.parse(String(cached.payload)) as LibraryMetricResult,strip=JSON.parse(String(cached.strip_payload));
      encodeResult(target,result);validateLibraryErrorStrip(strip);
      const p=result.provenance;
      if(strip.state!=="unknown"||strip.reason!=="strip-size-limit"||p.coverageQualified!==true||
        p.projectionVersion!==LIBRARY_NUMERIC_PROJECTION_VERSION||p.scoreOrigin!=="reconstructed"||
        !["stable","lazer"].includes(String(p.ruleset))||p.completionEvidence!=="source-domain-coverage-v1"||
        typeof p.replaySha256!=="string"||!this.db.prepare(`SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id
          WHERE l.replay_id=? AND l.sha256=? AND l.available=1 AND s.enabled=1 AND s.configured=1 LIMIT 1`).get(id,p.replaySha256))return;
      return target;
    }catch{return;}
  }
  /** Private Store maintenance only. No public reason can force cached work. */
  admitStripRepairInTransaction(id:string):boolean {
    const settings=this.analysisSettings();if(settings.mode!=="bg"||settings.userPaused)return false;
    const target=this.stripRepairTargetInTransaction(id);
    if(!target||this.db.prepare("SELECT 1 FROM metric_jobs WHERE replay_id=? AND slot='numerical'").get(id))return false;
    this.db.prepare("INSERT INTO metric_jobs VALUES(?,?,?,?,?,?,?,?, 'queued',NULL,NULL)")
      .run(randomUUID(),id,target.slot,target.stage,target.inputKey,target.producerVersion,target.generation,"strip-repair");
    this.dirty(1);return true;
  }
  /** Preparation publication already owns the observation/identity transaction. */
  admitPreparedInTransaction(inputs: LibraryMetricTargetInput[], reason: LibraryAnalysisReason): void {
    if (!Object.prototype.hasOwnProperty.call(priorities, reason)) invalid();
    for (const input of inputs) { validateTarget(input); if (input.stage === "H") invalid(); }
    for (const input of inputs) if(input.stage!=="C"&&input.slot!=="incidents")this.requestInTransaction(this.setTargetInTransaction(input), reason);
  }
  private requestInTransaction(target: LibraryMetricTarget, reason: LibraryAnalysisReason): LibraryMetricJob | { state: "cached" | "stale" | "disabled" } {
      if(target.stage==="C"||target.slot==="incidents")return{state:"disabled"};
      if (!this.current(target)) return { state: "stale" };
      if (this.cached(target)) return { state: "cached" };
      if (!this.hasEnabledSource(target.replayId) || !this.admitted(target.stage, reason, this.analysisSettings())) return { state: "disabled" };
      const old = this.db.prepare("SELECT * FROM metric_jobs WHERE replay_id=? AND slot=?").get(target.replayId, target.slot);
      if (old && !(old.state === "failed" && reason === "retry")) {
        if (["queued", "running"].includes(String(old.state)) && priorities[reason] < priorities[old.reason as LibraryAnalysisReason]) {
          this.db.prepare("UPDATE metric_jobs SET reason=? WHERE id=?").run(reason, old.id); old.reason = reason;
          this.dirty(1);
        }
        return job(old);
      }
      const id = randomUUID();
      if (old) this.db.prepare("DELETE FROM metric_jobs WHERE id=?").run(old.id);
      this.db.prepare("INSERT INTO metric_jobs VALUES(?,?,?,?,?,?,?,?, 'queued',NULL,NULL)")
        .run(id, target.replayId, target.slot, target.stage, target.inputKey, target.producerVersion, target.generation, reason);
      this.dirty(1);
      return { id, target, reason, state: "queued" };
  }
  claim(id: string): LibraryMetricTicket | undefined {
    if (!token(id)) invalid();
    if(this.db.prepare("SELECT 1 FROM metric_jobs WHERE id=? AND (stage='C' OR slot='incidents')").get(id))return undefined;
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM metric_jobs WHERE id=? AND state='queued'").get(id);
      const settings = this.analysisSettings();
      if (!row || settings.userPaused || !this.current(head(row)) || !this.dependencyReady(head(row)) || !this.hasEnabledSource(String(row.replay_id)) ||
        (row.reason==="strip-repair"?!this.stripRepairTargetInTransaction(String(row.replay_id)):!!this.cached(head(row))) ||
        !this.admitted(row.stage as LibraryMetricStage, row.reason as LibraryMetricJobReason, settings)) return undefined;
      const attempt = randomUUID(); this.db.prepare("UPDATE metric_jobs SET state='running',attempt=? WHERE id=?").run(attempt, id);
      return { ...head(row), attempt };
    });
  }
  /** Same transaction as resource publication: no competing queue consumer can claim this job. */
  claimPreparedInTransaction(input:LibraryMetricTargetInput):LibraryMetricHandoff {
    validateTarget(input);
    if(input.stage==="C"||input.slot==="incidents")return{state:"blocked"};
    const row=this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=? AND slot=?").get(input.replayId,input.slot);
    if(!row||row.stage!==input.stage||row.input_key!==input.inputKey||row.producer_version!==input.producerVersion)return{state:"stale"};
    const target=head(row);if(this.cached(target))return{state:"cached"};
    const settings=this.analysisSettings(),pending=this.db.prepare("SELECT * FROM metric_jobs WHERE replay_id=? AND slot=?").get(input.replayId,input.slot);
    if(!pending||pending.state!=="queued"||settings.userPaused||!this.dependencyReady(target)||!this.hasEnabledSource(input.replayId)||
      !this.admitted(input.stage,pending.reason as LibraryAnalysisReason,settings))return{state:"blocked"};
    const attempt=randomUUID();this.db.prepare("UPDATE metric_jobs SET state='running',attempt=? WHERE id=?").run(attempt,pending.id);
    return{state:"claimed",ticket:{...target,attempt}};
  }
  /** Store composition uses this only inside its transaction; never exposed as renderer admission. */
  isLiveTicket(ticket: LibraryMetricTicket): boolean {
    validateGeneration(ticket); if (!token(ticket.attempt)) invalid(); return this.live(ticket);
  }
  isEligible(ticket:LibraryMetricTicket):boolean {return this.isLiveTicket(ticket)&&this.hasEnabledSource(ticket.replayId);}
  private live(ticket: LibraryMetricTicket): boolean {
    return ticket.stage!=="C" && ticket.slot!=="incidents" && this.current(ticket) && !!this.db.prepare(`SELECT 1 FROM metric_jobs WHERE replay_id=? AND slot=? AND state='running'
      AND attempt=? AND generation=? AND input_key=? AND producer_version=? AND stage=?`)
      .get(ticket.replayId, ticket.slot, ticket.attempt, ticket.generation, ticket.inputKey, ticket.producerVersion, ticket.stage);
  }
  /** Retire an owned attempt on shutdown. Automatic yielding keeps the same running attempt instead. */
  release(ticket: LibraryMetricTicket): "applied" | "stale" {
    validateGeneration(ticket); if (!token(ticket.attempt)) invalid();
    if(ticket.stage==="C"||ticket.slot==="incidents")return"stale";
    return this.transaction(() => {
      if (!this.live(ticket)) return "stale";
      this.db.prepare("UPDATE metric_jobs SET state='queued',attempt=NULL,error=NULL WHERE replay_id=? AND slot=?")
        .run(ticket.replayId, ticket.slot);this.dirty(1); return "applied";
    });
  }
  private compatibleIdentity(id: string, result: LibraryMetricResult): boolean {
    const sha = result.provenance.replaySha256;
    // Match through the SHA primary index before the provisional-identity fallback.
    // The replay-only existence lookup otherwise scans contents on every valid bind.
    return sha === undefined || !!this.db.prepare("SELECT 1 FROM contents WHERE replay_id=? AND sha256=?").get(id, String(sha)) ||
      !this.db.prepare("SELECT 1 FROM contents WHERE replay_id=?").get(id);
  }
  private write(target: LibraryMetricTarget, payload: string,strip:string|null=null): void {
    this.db.prepare(`INSERT INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload,strip_payload) VALUES(?,?,?,?,?,?,?) ON CONFLICT(replay_id,slot,stage,input_key,producer_version)
      DO UPDATE SET payload=excluded.payload,strip_payload=excluded.strip_payload
      WHERE metric_results.payload IS NOT excluded.payload OR metric_results.strip_payload IS NOT excluded.strip_payload`).run(target.replayId, target.slot, target.stage, target.inputKey, target.producerVersion, payload,strip);
    this.db.prepare("DELETE FROM metric_jobs WHERE replay_id=? AND slot=?").run(target.replayId, target.slot);
    if(target.slot==="numerical")this.numericalChanged(target.replayId);
  }
  /** The persisted owned job, not mutable cache contents, certifies this path.
   * Never republish scalars or reconcile/claim a dependent for strip improvement. */
  private commitStripRepair(ticket:LibraryMetricTicket,payload:string,strip:string|null):"applied"|undefined {
    const pending=this.db.prepare("SELECT reason FROM metric_jobs WHERE replay_id=? AND slot=? AND attempt=?")
      .get(ticket.replayId,ticket.slot,ticket.attempt);
    if(pending?.reason!=="strip-repair")return;
    const cached=this.cached(ticket);
    if(!cached||cached.payload!==payload)throw Error("Strip repair changed numerical scalars");
    const old=cached.strip_payload?JSON.parse(String(cached.strip_payload)):undefined;
    // A concurrent better publication wins; never downgrade it or retire its dependents.
    if(old?.state==="unknown"&&old.reason==="strip-size-limit"){
      const next=strip?JSON.parse(strip):undefined;
      if(next?.state!=="known"&&!(next?.state==="unknown"&&next.reason==="strip-byte-size-limit-v2"))
        throw Error("Strip repair did not produce current strip evidence");
      this.db.prepare(`UPDATE metric_results SET strip_payload=? WHERE replay_id=? AND slot=? AND stage=?
        AND input_key=? AND producer_version=? AND payload=? AND strip_payload=?`)
        .run(strip,ticket.replayId,ticket.slot,ticket.stage,ticket.inputKey,ticket.producerVersion,payload,cached.strip_payload);
    }
    this.db.prepare("DELETE FROM metric_jobs WHERE replay_id=? AND slot=? AND attempt=?").run(ticket.replayId,ticket.slot,ticket.attempt);
    this.dirty(4);return"applied";
  }
  commit(patch: LibraryMetricPatch): "applied" | "stale" {
    validateGeneration(patch.ticket); if (!token(patch.ticket.attempt) || patch.producerVersion !== patch.ticket.producerVersion) invalid();
    if(patch.ticket.stage==="C"||patch.ticket.slot==="incidents")return"stale";
    return this.transaction(()=>this.commitInTransaction(patch));
  }
  /** Store composition only; caller already owns the transaction and any resource proof. */
  commitInTransaction(patch: LibraryMetricPatch): "applied" | "stale" {
    validateGeneration(patch.ticket); if (!token(patch.ticket.attempt) || patch.producerVersion !== patch.ticket.producerVersion) invalid();
    if(patch.ticket.stage==="C"||patch.ticket.slot==="incidents")return"stale";
    encodeResult(patch.ticket,{fields:patch.fields,provenance:patch.provenance,errorStrip:patch.errorStrip});
    const result=libraryCapabilityAttempt(patch.ticket,{fields:patch.fields,provenance:patch.provenance,errorStrip:patch.errorStrip});
    const payload = encodeResult(patch.ticket,result),strip=encodeStrip(patch.ticket,result);
      this.reconcileBeforeCommit(patch.ticket.replayId);
      if (!this.live(patch.ticket)||!this.hasEnabledSource(patch.ticket.replayId)) return "stale";
      if (!this.compatibleIdentity(patch.ticket.replayId, patch)) throw new Error("Library metric replay identity mismatch");
      if(this.commitStripRepair(patch.ticket,payload,strip))return"applied";
      this.write(patch.ticket, payload,strip); return "applied";
  }
  /** Numerical is durable before native timeline work. Claim the dependent job in the same
   * transaction, retaining priority and rejecting stale/Off/source-disabled publication. */
  commitAndClaimTimeline(patch:LibraryMetricPatch):LibraryMetricHandoff {
    validateGeneration(patch.ticket);
    if(patch.ticket.slot!=="numerical"||patch.ticket.stage!=="S"||!token(patch.ticket.attempt)||patch.producerVersion!==patch.ticket.producerVersion)invalid();
    encodeResult(patch.ticket,{fields:patch.fields,provenance:patch.provenance,errorStrip:patch.errorStrip});
    const result=libraryCapabilityAttempt(patch.ticket,{fields:patch.fields,provenance:patch.provenance,errorStrip:patch.errorStrip});
    const payload=encodeResult(patch.ticket,result),strip=encodeStrip(patch.ticket,result);
    return this.transaction(()=>{
      this.reconcileBeforeCommit(patch.ticket.replayId);
      if(!this.live(patch.ticket)||!this.hasEnabledSource(patch.ticket.replayId))return{state:"stale"};
      if(!this.compatibleIdentity(patch.ticket.replayId,patch))throw new Error("Library metric replay identity mismatch");
      if(this.commitStripRepair(patch.ticket,payload,strip))return{state:"cached"};
      const pending=this.db.prepare("SELECT reason FROM metric_jobs WHERE replay_id=? AND slot='numerical'").get(patch.ticket.replayId);
      if(!pending)throw new Error("Numerical ownership disappeared");
      this.write(patch.ticket,payload,strip);
      const target=libraryTimelineTarget(patch.ticket);this.admitPreparedInTransaction([target],pending.reason as LibraryAnalysisReason);
      const next=this.claimPreparedInTransaction(target);
      return next.state==="cached"?this.claimAfterTimelineInTransaction(patch.ticket,pending.reason as LibraryAnalysisReason):next;
    });
  }
  private claimAfterTimelineInTransaction(numerical:LibraryMetricTarget,reason:LibraryAnalysisReason):LibraryMetricHandoff {
    return this.claimFcInTransaction(numerical,reason);
  }
  private claimFcInTransaction(numerical:LibraryMetricTarget,reason:LibraryAnalysisReason):LibraryMetricHandoff {
    const cached=this.cached(numerical);if(!cached)return{state:"blocked"};
    const result=JSON.parse(String(cached.payload)) as LibraryMetricResult,completion=result.fields.completion;
    const existing=this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=? AND slot='fc-pp'").get(numerical.replayId);
    if(existing?.stage==="P"){
      const prior=this.cached(head(existing)),value=prior?(JSON.parse(String(prior.payload)) as LibraryMetricResult).fields.ppIfFc:undefined;
      if(value?.state==="known"||value?.state==="not-applicable")return{state:"cached"};
    }
    if(result.provenance.coverageQualified!==true||completion?.state!=="known"||completion.value!=="passed")return{state:"blocked"};
    const target=libraryFcTarget(numerical);this.admitPreparedInTransaction([target],reason);return this.claimPreparedInTransaction(target);
  }
  /** Reconcile only S-owned fallback lifetimes; a ready P value remains authoritative. */
  reconcileFcTargetInTransaction(numerical:LibraryMetricTarget):void {
    const prior=this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=? AND slot='fc-pp'").get(numerical.replayId);
    if(prior?.stage==="P"){
      const cached=this.cached(head(prior)),value=cached?(JSON.parse(String(cached.payload)) as LibraryMetricResult).fields.ppIfFc:undefined;
      if(value?.state==="known"||value?.state==="not-applicable")return;
    }
    const cached=this.cached(numerical),result=cached?JSON.parse(String(cached.payload)) as LibraryMetricResult:undefined;
    if(prior?.stage==="S"||result?.provenance.coverageQualified===true&&result.fields.completion?.state==="known"&&result.fields.completion.value==="passed")
      this.setTargetInTransaction(libraryFcTarget(numerical));
  }
  clearReconstructedFcInTransaction(id:string):void {
    if(this.db.prepare("SELECT 1 FROM metric_targets WHERE replay_id=? AND slot='fc-pp' AND stage='S'").get(id))this.clearTargetInTransaction(id,"fc-pp");
  }
  /** Ordinary timeline failure still permits compact FC work. Uncertain native drainage never calls this boundary. */
  finishTimelineAndClaimFc(ticket:LibraryMetricTicket,outcome:LibraryTimelineOutcome):LibraryMetricHandoff {
    validateGeneration(ticket);if(ticket.slot!=="timeline-pp"||ticket.stage!=="S"||!token(ticket.attempt)||!record(outcome))invalid();
    if(Object.keys(outcome).length!==1||!("metrics"in outcome)&&!("error"in outcome))invalid();
    const payload="metrics"in outcome?encodeResult(ticket,outcome.metrics):undefined;
    if("error"in outcome&&(typeof outcome.error!=="string"||!outcome.error.trim()||outcome.error.length>2048))invalid();
    return this.transaction(()=>{
      this.reconcileBeforeCommit(ticket.replayId);
      if(!this.live(ticket)||!this.hasEnabledSource(ticket.replayId)||!this.dependencyReady(ticket))return{state:"stale"};
      if("metrics"in outcome&&!this.compatibleIdentity(ticket.replayId,outcome.metrics))throw new Error("Library metric replay identity mismatch");
      const pending=this.db.prepare("SELECT reason FROM metric_jobs WHERE replay_id=? AND slot='timeline-pp'").get(ticket.replayId);
      const row=this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=? AND slot='numerical'").get(ticket.replayId);
      if(!pending||!row)throw new Error("Timeline dependency disappeared");
      if(payload!==undefined)this.write(ticket,payload);
      else this.db.prepare("UPDATE metric_jobs SET state='failed',attempt=NULL,error=? WHERE replay_id=? AND slot='timeline-pp'")
        .run((outcome as {error:string}).error,ticket.replayId);
      return this.claimAfterTimelineInTransaction(head(row),pending.reason as LibraryAnalysisReason);
    });
  }
  /** Final FC publication terminates this chain. Native drainage/cancellation remains
   * fenced before this call; the historical method name is a compatibility seam. */
  finishFcAndClaimIncidents(ticket:LibraryMetricTicket,outcome:LibraryTimelineOutcome):LibraryMetricHandoff {
    validateGeneration(ticket);if(ticket.slot!=="fc-pp"||ticket.stage!=="S"||!token(ticket.attempt)||!record(outcome))invalid();
    if(Object.keys(outcome).length!==1||!("metrics"in outcome)&&!("error"in outcome))invalid();
    const payload="metrics"in outcome?encodeResult(ticket,outcome.metrics):undefined;
    if("error"in outcome&&(typeof outcome.error!=="string"||!outcome.error.trim()||outcome.error.length>2048))invalid();
    return this.transaction(()=>{
      this.reconcileBeforeCommit(ticket.replayId);
      if(!this.live(ticket)||!this.hasEnabledSource(ticket.replayId)||!this.dependencyReady(ticket))return{state:"stale"};
      if("metrics"in outcome&&!this.compatibleIdentity(ticket.replayId,outcome.metrics))throw new Error("Library metric replay identity mismatch");
      const pending=this.db.prepare("SELECT reason FROM metric_jobs WHERE replay_id=? AND slot='fc-pp'").get(ticket.replayId);
      const row=this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=? AND slot='numerical'").get(ticket.replayId);
      if(!pending||!row)throw new Error("FC dependency disappeared");
      if(payload!==undefined)this.write(ticket,payload);
      else this.db.prepare("UPDATE metric_jobs SET state='failed',attempt=NULL,error=? WHERE replay_id=? AND slot='fc-pp'")
        .run((outcome as {error:string}).error,ticket.replayId);
      return {state:"cached"};
    });
  }
  fail(ticket: LibraryMetricTicket, error: string): "applied" | "stale" {
    validateGeneration(ticket); if (!token(ticket.attempt) || typeof error !== "string" || !error.trim()) invalid();
    if(ticket.stage==="C"||ticket.slot==="incidents")return"stale";
    return this.transaction(() => {
      if (!this.live(ticket)) return "stale";
      this.db.prepare("UPDATE metric_jobs SET state='failed',attempt=NULL,error=? WHERE replay_id=? AND slot=?")
        .run(error.slice(0, 2048), ticket.replayId, ticket.slot); return "applied";
    });
  }
  publishObserved(target: LibraryMetricTarget, result: LibraryMetricResult): "applied" | "stale" {
    validateGeneration(target);if(target.stage==="C"||target.slot==="incidents")return"stale";
    return this.transaction(() => this.publishObservedInTransaction(target,result)==="stale"?"stale":"applied");
  }
  /** Exact-target observation only. Caller owns its source/identity transaction; no job admission. */
  publishObservedInTransaction(target:LibraryMetricTarget,result:LibraryMetricResult,preserveAvailable=false):"applied"|"cached"|"stale" {
    validateGeneration(target); encodeResult(target,result);
    if(target.stage==="C"||target.slot==="incidents")return"stale";
    if(!this.current(target))return"stale";
    if(this.db.prepare(`SELECT 1 FROM replays r WHERE r.id=? AND ${libraryKnownNonstandardSql("r.id","r.metadata")}`).get(target.replayId))return"stale";
    if(!this.compatibleIdentity(target.replayId,result))throw new Error("Library metric replay identity mismatch");
    const previous=this.db.prepare(`SELECT payload,strip_payload FROM metric_results WHERE replay_id=? AND slot=? AND stage=? AND input_key=? AND producer_version=?`)
      .get(target.replayId,target.slot,target.stage,target.inputKey,target.producerVersion);
    if(preserveAvailable&&previous){
      const prior=JSON.parse(String(previous.payload)) as LibraryMetricResult;
      const rank=(value:{state:string}|undefined)=>value?.state==="known"?2:value?.state==="not-applicable"?1:0;
      const fields={...prior.fields,...result.fields},provenance={...prior.provenance,...result.provenance};
      for(const [name,value] of Object.entries(prior.fields))if(rank(value)>rank(result.fields[name]))fields[name]=value;
      for(const name of ["coverageQualified","completeAccuracyEvidence","completeBreakEvidence"])
        if(prior.provenance[name]===true)provenance[name]=true;
      const oldStrip=previous.strip_payload?JSON.parse(String(previous.strip_payload)) as LibraryMetricResult["errorStrip"]:undefined;
      const errorStrip=result.errorStrip===undefined||rank(oldStrip)>rank(result.errorStrip)?oldStrip:result.errorStrip;
      result={fields,provenance,...(errorStrip===undefined?{}:{errorStrip})};
      // An observed known value must not inherit the earlier rejected attempt marker.
      if(provenance.capabilityAttempt!==undefined&&!validCapabilityAttempt(target,result,provenance.capabilityAttempt))delete provenance.capabilityAttempt;
    }
    const payload=encodeResult(target,result),strip=encodeStrip(target,result);
    const pending=preserveAvailable?this.db.prepare("SELECT reason FROM metric_jobs WHERE replay_id=? AND slot=?").get(target.replayId,target.slot):undefined;
    if(preserveAvailable&&previous&&previous.payload===payload&&previous.strip_payload===strip){
      if(pending&&pending.reason!=="strip-repair"){this.db.prepare("DELETE FROM metric_jobs WHERE replay_id=? AND slot=?").run(target.replayId,target.slot);this.dirty(4);}
      return"cached";
    }
    this.write(target,payload,strip);if(pending)this.dirty(4);return"applied";
  }
  clearUnfinishedAnalysisJobs(): void {
    // Retain the same strip-only reservation while Off; cached scalars remain usable
    // and normal Background admission can resume it without another capability pass.
    this.db.exec("DELETE FROM metric_jobs WHERE stage IN ('S','C') AND state IN ('queued','running') AND reason<>'strip-repair'");
    // Persisted Off revokes the running attempt before asynchronous owner drain.
    this.db.exec("UPDATE metric_jobs SET state='queued',attempt=NULL,error=NULL WHERE reason='strip-repair' AND state='running'");
    this.clearPreparations();
  }
  /** Called ONLY inside LibraryStore's identity transaction. Canonical conflicts remain authoritative. */
  mergeProvisional(from: string, into: string): void {
    for (const row of this.db.prepare("SELECT * FROM metric_results WHERE replay_id=?").all(from)) {
      if (!this.compatibleIdentity(into, JSON.parse(String(row.payload)) as LibraryMetricResult)) continue;
      this.db.prepare("INSERT OR IGNORE INTO metric_results(replay_id,slot,stage,input_key,producer_version,payload,strip_payload) VALUES(?,?,?,?,?,?,?)")
        .run(into, row.slot, row.stage, row.input_key, row.producer_version, row.payload,row.strip_payload);
    }
    for (const row of this.db.prepare("SELECT * FROM metric_targets WHERE replay_id=?").all(from)) {
      if (this.db.prepare("SELECT 1 FROM metric_targets WHERE replay_id=? AND slot=?").get(into, row.slot)) continue;
      const prior = this.cached(head(row));
      if (prior && !this.compatibleIdentity(into, JSON.parse(String(prior.payload)) as LibraryMetricResult)) continue;
      this.db.prepare("INSERT INTO metric_targets VALUES(?,?,?,?,?,?)")
        .run(into, row.slot, row.stage, row.input_key, row.producer_version, this.nextGeneration());
    }
    // An adopted cache completes only its exact target. Unrelated work remains owned.
    this.db.prepare(`DELETE FROM metric_jobs WHERE replay_id=? AND reason<>'strip-repair' AND EXISTS(SELECT 1 FROM metric_results r
      WHERE r.replay_id=metric_jobs.replay_id AND r.slot=metric_jobs.slot AND r.stage=metric_jobs.stage
      AND r.input_key=metric_jobs.input_key AND r.producer_version=metric_jobs.producer_version)`).run(into);
    this.db.prepare("DELETE FROM metric_jobs WHERE replay_id=?").run(from);
    this.db.prepare("DELETE FROM metric_results WHERE replay_id=?").run(from);
    this.db.prepare("DELETE FROM metric_targets WHERE replay_id=?").run(from);
  }
}
