import type { LibraryErrorStrip } from "./library-error-strip";
import { validateLibraryErrorStrip } from "./library-error-strip";
import { LIBRARY_NUMERIC_PROJECTION_VERSION,LIBRARY_TIMELINE_PROJECTION_VERSION } from "./library-analysis";
import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
/** A result's availability is independent of its job's current state and background mode. */
export type LibraryMetricValue<T> = { state: "known"; value: T }
  | { state: "unknown" | "not-applicable" | "error"; reason: string };
export type LibraryMetricStage = "H" | "P" | "S" | "C";
export type LibraryMetricSlot = "source-score" | "source-map" | "calculated-map" | "aggregate-pp"
  | "numerical" | "timeline-pp" | "fc-pp" | "incidents";
export type LibraryAnalysisReason = "selection" | "open" | "background" | "retry";
/** Internal durable improvement of an existing numerical strip; never public preparation intent. */
export type LibraryMetricJobReason = LibraryAnalysisReason | "strip-repair" | "clock-enrichment";
export interface LibraryAnalysisSettings {
  mode: "bg" | "demand" | "off";
  userPaused: boolean;
  workers: 1 | 2 | 4;
  pauseOnBattery: boolean;
  /** Library yielding policy; loaded unset preferences default on. Stored separately for legacy readers. */
  fasterProcessing?: boolean;
}
/** Live work reservations and recorded intent, not unique replays or a fixed batch.
 * P/S preparation and metric slots are separate work items. Preparation can create
 * further work, so these counts have no completion denominator. Missing values do
 * not imply queued work; bound preparation is not numerical completion. */
export interface LibraryAnalysisActivity {
  unit: "work-items";
  queued: number;
  /** Queued preparation requests, not evidence that an input file is missing. */
  awaitingInputs: number;
  /** Recorded work waiting on enabled sources or an admitting analysis mode. */
  deferred: number;
  failed: number;
  /** Disjoint current execution reservations; held/retiring are not running. */
  running: number; held: number; retiring: number;
  mode: LibraryAnalysisSettings["mode"];
  userPaused: boolean; viewerHold: boolean; batteryHold: boolean; resumePending: boolean;
  error?: string;
  /** Current-result coverage of indexed canonical standard/unknown-mode replays,
   * including disabled sources. Five logical calculation slots must have exact
   * current producer/target/result receipts; unknown results count as processed,
   * never as known values. Missing targets, failed jobs and bound preparation do
   * not count. Discovery/recovery can change this population and coverage. */
  progress?: { unit: "replays"; completed: number; total: number; ready: boolean };
}
export type LibraryCompletion = LibraryMetricValue<"passed" | "failed">;
export interface LibraryMetricTargetInput {
  replayId: string; slot: LibraryMetricSlot; stage: LibraryMetricStage; inputKey: string; producerVersion: string;
}
export interface LibraryMetricTarget extends LibraryMetricTargetInput { generation: number }
export interface LibraryMetricTicket extends LibraryMetricTarget { attempt: string }
export interface LibraryMetricResult {
  /** Numerical publication only; scalar reads deliberately omit this separately stored payload. */
  errorStrip?:LibraryMetricValue<LibraryErrorStrip>;
  /** Small versioned evidence identifiers; no persistent error causes or raw replay frames. */
  provenance: Record<string, string | number | boolean | null>;
  fields: Record<string, LibraryMetricValue<string | number | boolean>>;
}
/** A completed RX capability validation, including a prerequisite refusal. Success
 * tags attest independent modeled timing/events, never whole-source completion. */
export const LIBRARY_RX_TIMING_COMPARISON_VERSION="stable-rx-clock-equivalence-v1";
export const LIBRARY_RX_TIMING_EVIDENCE_KEYS=["timingComparisonVersion","timingEvidence","stripEvidence"] as const;
export function libraryRxTimingCertificate(
  target:Pick<LibraryMetricTarget,"slot"|"stage"|"producerVersion">,result:LibraryMetricResult,
):{timing:boolean;strip:boolean}|undefined {
  const p=result?.provenance,fields=result?.fields,version=LIBRARY_RX_TIMING_COMPARISON_VERSION;
  if(!p||!fields||target.slot!=="numerical"||target.stage!=="S"||target.producerVersion!==LIBRARY_NUMERIC_PROJECTION_VERSION||
    p.projectionVersion!==LIBRARY_NUMERIC_PROJECTION_VERSION||p.ruleset!=="stable"||p.scoreOrigin!=="reconstructed"||
    p.coverageQualified!==false||p.completeAccuracyEvidence!==false||p.completeBreakEvidence!==false||
    p.completionEvidence!=="source-domain-coverage-v1"||p.sourceCoverageEvidence!==undefined||
    p.timingComparisonVersion!==version||
    [p.timingEvidence,p.stripEvidence].some(value=>value!==undefined&&value!==version)||
    ![p.replaySha256,p.mapSha256].every(value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value))||
    typeof p.mapMd5!=="string"||!/^[a-f0-9]{32}$/.test(p.mapMd5)||
    typeof p.rate!=="number"||!Number.isFinite(p.rate)||p.rate<=0)return;
  const timing=p.timingEvidence===version,strip=p.stripEvidence===version;
  const reasons:Record<string,string>={completion:"completion-not-established",accuracy:"numerical-evidence-incomplete",
    maxCombo:"numerical-evidence-incomplete",misses:"numerical-evidence-incomplete",sliderBreaks:"numerical-evidence-incomplete",
    sliderEndMisses:"numerical-evidence-incomplete",comboLosses:"numerical-evidence-incomplete",fc:"completion-not-established",
    perfectCombo:"exact-map-combo-unavailable"};
  if(Object.keys(fields).length!==13||Object.keys(fields).some(name=>!Object.prototype.hasOwnProperty.call(reasons,name)&&
    !["sliderTickMisses","sampleCount","ur","biasMs"].includes(name)))return;
  for(const [name,reason] of Object.entries(reasons)){
    const field=fields[name];if(field?.state!=="unknown"||field.reason!==reason)return;
  }
  if(fields.sliderTickMisses?.state!=="not-applicable"||fields.sliderTickMisses.reason!=="native-slider-ticks-only")return;
  const count=fields.sampleCount,ur=fields.ur,bias=fields.biasMs;
  if(timing){
    if(count?.state!=="known"||typeof count.value!=="number"||!Number.isSafeInteger(count.value)||count.value<0)return;
    if(count.value>0){
      if(ur?.state!=="known"||typeof ur.value!=="number"||!Number.isFinite(ur.value)||ur.value<0||
        bias?.state!=="known"||typeof bias.value!=="number"||!Number.isFinite(bias.value))return;
    }else if(ur?.state!=="unknown"||ur.reason!=="no-valid-timing-samples"||
      bias?.state!=="unknown"||bias.reason!=="no-valid-timing-samples")return;
  }else if(count?.state!=="unknown"||count.reason!=="numerical-evidence-incomplete"||
    ur?.state!=="unknown"||ur.reason!=="no-valid-timing-samples"||bias?.state!=="unknown"||bias.reason!=="no-valid-timing-samples")return;
  // Scalar reads omit the separate strip payload; its evidence tag remains readable.
  if(result.errorStrip!==undefined){
    try{validateLibraryErrorStrip(result.errorStrip);}catch{return;}
    if(result.errorStrip.state==="known"){
      if(!strip||result.errorStrip.value.ruleset!=="stable"||result.errorStrip.value.endpointBasis!=="recorded-end"||
        result.errorStrip.value.synthesizedEndpoint!==false)return;
    }else if(strip||result.errorStrip.state!=="unknown")return;
  }
  return {timing,strip};
}

/** Worker-owned current-model proofs. These compact tags describe independently
 * checked field dependencies, not historical playback or whole-source coverage. */
export const LIBRARY_MANUAL_CLOCK_SOURCE_VERSION="stable-manual-clock-convergence-v1";
export const LIBRARY_MANUAL_CLOCK_COMPARISON_VERSION="stable-manual-clock-equivalence-v1";
export const LIBRARY_MANUAL_CLOCK_EVIDENCE_KEYS=["manualClockComparisonVersion","manualClockTimingEvidence","manualClockStripEvidence",
  "manualClockOutcomeEvidence","manualClockPerformanceEvidence"] as const;
export const LIBRARY_CLOCK_ENRICHMENT_VERSION="stable-clock-fields-v1";
export const LIBRARY_RX_CLOCK_SOURCE_VERSION="stable-rx-clock-convergence-v1";
export const LIBRARY_RX_CLOCK_COMPARISON_VERSION="stable-rx-fields-v1";
export const LIBRARY_EARLY_MAP_CLOCK_VERSION="stable-early-map-clock-v1";
export const LIBRARY_MANUAL_IMPORTER_CLOCK_VERSION="stable-manual-importer-clock-v1";
export const LIBRARY_RX_CLOCK_EVIDENCE_KEYS=["rxClockComparisonVersion","rxClockTimingEvidence","rxClockStripEvidence",
  "rxClockOutcomeEvidence","rxClockPerformanceEvidence"] as const;
export interface LibraryManualClockCertificate {timing:boolean;strip:boolean;outcome:boolean;performance:boolean}
export function libraryManualClockCertificate(target:Pick<LibraryMetricTarget,"slot"|"stage"|"producerVersion">,result:LibraryMetricResult):LibraryManualClockCertificate|undefined {
  return libraryClockFieldCertificate(target,result,"manualClock");
}
export function libraryRxClockCertificate(target:Pick<LibraryMetricTarget,"slot"|"stage"|"producerVersion">,result:LibraryMetricResult):LibraryManualClockCertificate|undefined {
  return libraryClockFieldCertificate(target,result,"rxClock");
}
function libraryClockFieldCertificate(
  target:Pick<LibraryMetricTarget,"slot"|"stage"|"producerVersion">,result:LibraryMetricResult,prefix:"manualClock"|"rxClock",
):LibraryManualClockCertificate|undefined {
  const p=result?.provenance,f=result?.fields,v=prefix==="manualClock"?LIBRARY_MANUAL_CLOCK_COMPARISON_VERSION:LIBRARY_RX_CLOCK_COMPARISON_VERSION;
  const keys=prefix==="manualClock"?LIBRARY_MANUAL_CLOCK_EVIDENCE_KEYS:LIBRARY_RX_CLOCK_EVIDENCE_KEYS;
  const other=prefix==="manualClock"?LIBRARY_RX_CLOCK_EVIDENCE_KEYS:LIBRARY_MANUAL_CLOCK_EVIDENCE_KEYS;
  if(!p||!f||target.stage!=="S"||p.ruleset!=="stable"||p.scoreOrigin!=="reconstructed"||p.coverageQualified!==false||
    p.sourceCoverageEvidence!==undefined||p[prefix+"ComparisonVersion"]!==v||
    other.some(key=>Object.prototype.hasOwnProperty.call(p,key))||
    prefix==="manualClock"&&LIBRARY_RX_TIMING_EVIDENCE_KEYS.some(key=>Object.prototype.hasOwnProperty.call(p,key))||
    keys.some(key=>p[key]!==undefined&&p[key]!==v)||
    ![p.replaySha256,p.mapSha256].every(value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value))||
    typeof p.mapMd5!=="string"||!/^[a-f0-9]{32}$/.test(p.mapMd5)||typeof p.rate!=="number"||!Number.isFinite(p.rate)||p.rate<=0)return;
  const timing=p[prefix+"TimingEvidence"]===v,strip=p[prefix+"StripEvidence"]===v,
    outcome=p[prefix+"OutcomeEvidence"]===v,performance=p[prefix+"PerformanceEvidence"]===v;
  if(prefix==="rxClock"&&LIBRARY_RX_TIMING_EVIDENCE_KEYS.some(key=>p[key]!==undefined)&&(
    p.timingComparisonVersion!==LIBRARY_RX_TIMING_COMPARISON_VERSION||
    LIBRARY_RX_TIMING_EVIDENCE_KEYS.some(key=>p[key]!==undefined&&p[key]!==LIBRARY_RX_TIMING_COMPARISON_VERSION)||
    p.timingEvidence!==undefined&&!timing||p.stripEvidence!==undefined&&!strip||target.slot!=="numerical"))return;
  const value=(name:string)=>{const field=f[name];return field?.state==="known"?field.value:undefined;};
  const known=(name:string,predicate:(value:unknown)=>boolean)=>f[name]?.state==="known"&&predicate(value(name));
  const finite=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
  const nonnegative=(value:unknown)=>finite(value)&&value>=0;
  const count=(value:unknown)=>nonnegative(value)&&Number.isSafeInteger(value);
  const unknown=(name:string,...reasons:string[])=>f[name]?.state==="unknown"&&reasons.includes(f[name].reason);
  // Certificates have exact scalar shapes; ordinary payload validation additionally
  // rejects extra properties on each metric before persistence/publication.
  if(target.slot==="timeline-pp"){
    if(target.producerVersion!==LIBRARY_TIMELINE_PROJECTION_VERSION||p.projectionVersion!==LIBRARY_TIMELINE_PROJECTION_VERSION||
      p.engineVersion!==PERFORMANCE_ENGINE_VERSION||!performance||timing||strip||result.errorStrip!==undefined||
      p.completeAccuracyEvidence!==undefined||p.completeBreakEvidence!==undefined||
      Object.keys(f).sort().join(",")!=="peakPp,pp"||!known("peakPp",nonnegative)||
      (outcome?p.verifiedPassed!==true:p.verifiedPassed!==undefined)||
      !(known("pp",nonnegative)?outcome&&Number(value("peakPp"))>=Number(value("pp")):
        unknown("pp",...(outcome?["performance-data-unavailable"]:["completion-not-established","performance-data-unavailable"]))))return;
    return {timing,strip,outcome,performance};
  }
  if(target.slot!=="numerical"||target.producerVersion!==LIBRARY_NUMERIC_PROJECTION_VERSION||
    p.projectionVersion!==LIBRARY_NUMERIC_PROJECTION_VERSION||p.completionEvidence!=="source-domain-coverage-v1"||p.verifiedPassed!==undefined||
    typeof p.completeAccuracyEvidence!=="boolean"||typeof p.completeBreakEvidence!=="boolean"||
    Object.keys(f).sort().join(",")!=="accuracy,biasMs,comboLosses,completion,fc,maxCombo,misses,perfectCombo,sampleCount,sliderBreaks,sliderEndMisses,sliderTickMisses,ur"||
    f.sliderTickMisses?.state!=="not-applicable"||f.sliderTickMisses.reason!=="native-slider-ticks-only")return;
  if(timing){
    if(!known("sampleCount",count))return;
    if(Number(value("sampleCount"))>0){if(!known("ur",nonnegative)||!known("biasMs",finite))return;}
    else if(!unknown("ur","no-valid-timing-samples")||!unknown("biasMs","no-valid-timing-samples"))return;
  }else if(!unknown("sampleCount","numerical-evidence-incomplete")||!unknown("ur","no-valid-timing-samples")||!unknown("biasMs","no-valid-timing-samples"))return;
  if(!outcome){
    if(p.completeAccuracyEvidence||p.completeBreakEvidence||!unknown("completion","completion-not-established")||
      !unknown("fc","completion-not-established")||!unknown("perfectCombo","exact-map-combo-unavailable"))return;
  }else{
    if(!(known("completion",x=>x==="passed"||x==="failed")||unknown("completion","completion-not-established","conflicting-completion-evidence")))return;
    if(known("fc",x=>typeof x==="boolean")){
      if(!known("completion",x=>x==="passed")||!p.completeAccuracyEvidence||!p.completeBreakEvidence||
        value("fc")!==(["misses","sliderBreaks","comboLosses"].every(name=>known(name,x=>x===0))))return;
    }else if(f.fc?.state==="not-applicable"){
      if(!known("completion",x=>x==="failed")||f.fc.reason!=="failed-replay")return;
    }else if(!unknown("fc","completion-not-established","conflicting-combo-evidence","complete-break-evidence-unavailable"))return;
    if(!(known("perfectCombo",x=>typeof x==="boolean")?p.completeAccuracyEvidence:
      unknown("perfectCombo","exact-map-combo-unavailable","conflicting-combo-evidence")))return;
  }
  for(const name of ["accuracy","maxCombo","misses","sliderBreaks","sliderEndMisses"]){
    if(outcome&&p.completeAccuracyEvidence){if(!known(name,name==="accuracy"?x=>nonnegative(x)&&Number(x)<=1:count))return;}
    else if(!unknown(name,"numerical-evidence-incomplete"))return;
  }
  if(outcome&&p.completeBreakEvidence){if(!known("comboLosses",count))return;}
  else if(!unknown("comboLosses","numerical-evidence-incomplete"))return;
  if(result.errorStrip!==undefined){
    try{validateLibraryErrorStrip(result.errorStrip);}catch{return;}
    if(result.errorStrip.state==="known"){
      if(!strip||result.errorStrip.value.ruleset!=="stable"||result.errorStrip.value.endpointBasis!=="recorded-end"||result.errorStrip.value.synthesizedEndpoint!==false)return;
    }else if(strip||result.errorStrip.state!=="unknown")return;
  }
  return {timing,strip,outcome,performance};
}
export interface LibraryMetricPatch {
  errorStrip?:LibraryMetricValue<LibraryErrorStrip>;
  ticket: LibraryMetricTicket; producerVersion: string;
  /** Small versioned evidence identifiers; no persistent error causes or raw replay frames. */
  provenance: Record<string, string | number | boolean | null>;
  fields: Record<string, LibraryMetricValue<string | number | boolean>>;
}
export interface LibraryMetricJob {
  id: string; target: LibraryMetricTarget; reason: LibraryMetricJobReason;
  state: "queued" | "running" | "failed"; error?: string;
}
export interface LibraryMetricEntry {
  target: LibraryMetricTarget; result?: LibraryMetricResult; job?: LibraryMetricJob;
}
export interface LibraryErrorStripEntry {
  target:LibraryMetricTarget;result?:LibraryMetricValue<LibraryErrorStrip>;job?:LibraryMetricJob;
}
