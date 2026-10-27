import { isAbsolute } from "path";
import { LibraryService, LibraryServiceConfiguration } from "./library-service";
import type { LibraryUpdateMode,LibraryQueryErrorCode } from "../../../../shared/replay-library";
import { LIBRARY_QUERY_ERROR_CODES } from "../../../../shared/replay-library";
import type { LibraryLocationTicket, LibraryLocationRefresh, LibraryMapTicket, LibraryAnalysisLease, LibraryPerformanceMapReceipt } from "./library-store";
import { LIBRARY_METRIC_OPERATIONS, LibraryMetricOperation } from "./library-metric-api";
import { LIBRARY_PREPARATION_OPERATIONS, LibraryPreparationOperation } from "./library-preparation-api";
import type { LibraryPreparationTicket, LibraryPreparedTarget, LibraryPreparedResult } from "./library-preparation-store";
import type { LibraryConsumedOrigin, LibraryNumericalInputRecipe } from "../../../../shared/library-analysis";
import type { LibraryMetricTicket } from "../../../../shared/replay-library-metrics";
import { LibraryAnalysisDirtyEvent, LibraryAnalysisDirtyPublisher } from "./library-analysis-dirty";
import type { LibraryNativeAdmission } from "./library-native-admission";
import { LIBRARY_QUERY_OPERATIONS,LibraryQueryOperation } from "./library-query-api";
import { LIBRARY_USER_METADATA_OPERATIONS,LibraryUserMetadataOperation,validateLibraryUserMetadata } from "./library-user-metadata-api";
import { validateLibraryPassiveRequest } from "./library-ipc";
import { currentReplayDescriptor,LibraryCurrentReplayAuthority } from "./library-current-replay-authority";
import type { LibraryNumericalResourceDescriptor } from "../../../../shared/library-analysis";
import type { LibraryCurrentReplayResult } from "../../../../shared/library-current-replay";
import { validateLibraryIncidentEvidence } from "../../../../shared/library-incidents";
import { validateLibraryErrorStrip } from "../../../../shared/library-error-strip";
import { appendLibraryResourceChanges } from "../../../../shared/library-resource-changes";
import type { LibraryResourceChanges } from "../../../../shared/library-resource-changes";

export interface LibraryUtilityResponse { version: 1; id: string; ok: boolean; data?: unknown; error?: string; errorCode?:LibraryQueryErrorCode }
export interface LibraryChangedEvent {version:1;event:"library-changed";revision:number;ready:boolean;resourceRevision?:string;resourceChanges?:LibraryResourceChanges;statusOnly?:true}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 128): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const absolute = (value: unknown): value is string => text(value, 32768) && isAbsolute(value);
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: unknown, length: number): value is string => typeof value === "string" && new RegExp(`^[a-f\\d]{${length}}$`).test(value);
const keys=(value:Record<string,unknown>,allowed:readonly string[])=>Object.keys(value).every(key=>allowed.includes(key));
const token=(value:unknown,max=128):value is string=>text(value,max)&&/^[a-zA-Z0-9_.:/+-]+$/.test(value);
const locationTicket = (value: unknown): value is LibraryLocationTicket => record(value) && text(value.replayId) && text(value.sourceId) &&
  text(value.sourceKey, 32768) && text(value.locator, 32768) && (value.sha256 === null || hash(value.sha256, 64)) &&
  revision(value.locationRevision) && revision(value.sourceConfigRevision);
const mapTicket = (value: unknown): value is LibraryMapTicket => record(value) && text(value.sourceId) && text(value.generation) &&
  text(value.sourceKey, 32768) && text(value.locator, 32768) && hash(value.md5, 32) && revision(value.sourceConfigRevision);
const refresh = (value: unknown): value is LibraryLocationRefresh => record(value) && (value.sha256 === null || hash(value.sha256, 64)) &&
  typeof value.available === "boolean" && (!value.available || value.sha256 !== null) && record(value.metadata) &&
  Buffer.byteLength(JSON.stringify(value.metadata)) <= 64 * 1024 && (value.locator === undefined || text(value.locator, 32768));

const locationKeys=["replayId","sourceId","sourceKey","locator","sha256","locationRevision","sourceConfigRevision","incidentEpochs"];
const mapKeys=["sourceId","generation","sourceKey","locator","md5","sourceConfigRevision"];
function currentLocation(value:unknown,open=false):LibraryLocationTicket {
  if(!locationTicket(value)||!keys(value as unknown as Record<string,unknown>,[...locationKeys,...(open?["kind","directory","metadata","analysisRequiresNative"]:[])]))
    throw new Error("Invalid current replay location");
  const item=value as LibraryLocationTicket&Record<string,unknown>;
  if(item.incidentEpochs!==undefined&&(!record(item.incidentEpochs)||!keys(item.incidentEpochs,["sourceEpoch","locationEpoch"])||
    !revision(item.incidentEpochs.sourceEpoch)||!revision(item.incidentEpochs.locationEpoch)))throw new Error("Invalid current replay location epochs");
  if(["kind","directory","metadata","analysisRequiresNative"].some(key=>key in item)&&(!open||!text(item.kind)||
    !["stable","replays","lazer","imported"].includes(item.kind)||!absolute(item.directory)||!record(item.metadata)||
    Buffer.byteLength(JSON.stringify(item.metadata))>64*1024||item.analysisRequiresNative!==undefined&&item.analysisRequiresNative!==true))
    throw new Error("Invalid current replay open location");
  return{replayId:item.replayId,sourceId:item.sourceId,sourceKey:item.sourceKey,locator:item.locator,sha256:item.sha256,
    locationRevision:item.locationRevision,sourceConfigRevision:item.sourceConfigRevision,...(item.incidentEpochs?{incidentEpochs:{...item.incidentEpochs}}:{})};
}
function currentMap(value:unknown,open=false):LibraryMapTicket {
  if(!mapTicket(value)||!keys(value as unknown as Record<string,unknown>,[...mapKeys,...(open?["kind","directory","metadata"]:[])]))throw new Error("Invalid current replay map");
  const item=value as LibraryMapTicket&Record<string,unknown>;
  if(["kind","directory","metadata"].some(key=>key in item)&&(!open||!text(item.kind)||!["stable","replays","lazer","imported"].includes(item.kind)||
    !absolute(item.directory)||!record(item.metadata)||Buffer.byteLength(JSON.stringify(item.metadata))>64*1024))throw new Error("Invalid current replay open map");
  return{sourceId:item.sourceId,generation:item.generation,sourceKey:item.sourceKey,locator:item.locator,md5:item.md5,sourceConfigRevision:item.sourceConfigRevision};
}
function currentBinding(value:unknown,completion=false):void {
  if(!record(value)||!keys(value,["replaySha256","mapSha256","mapMd5","exactMapAndProfile",...(completion?["sourceCompletion"]:[])])||
    !hash(value.replaySha256,64)||!hash(value.mapSha256,64)||!hash(value.mapMd5,32)||typeof value.exactMapAndProfile!=="boolean")throw new Error("Invalid current replay resource binding");
  if(value.sourceCompletion!==undefined&&(!record(value.sourceCompletion)||!keys(value.sourceCompletion,["sourcePassed","sourceVerified","conflicting"])||
    Object.values(value.sourceCompletion).some(item=>typeof item!=="boolean")))throw new Error("Invalid current replay completion binding");
}
function currentDescriptor(value:unknown):LibraryNumericalResourceDescriptor {
  if(!record(value)||!keys(value,["input","target","origin","recipe","incidentEvidence"])||Buffer.byteLength(JSON.stringify(value))>128*1024||
    !record(value.input)||!keys(value.input,["format","replayBytes","mapBytes","binding"])||!record(value.target)||
    !keys(value.target,["slot","stage","inputKey","producerVersion"])||value.origin!==null&&(!record(value.origin)||!keys(value.origin,["client","provenance"])))
    throw new Error("Invalid current replay descriptor envelope");
  currentBinding(value.input.binding,true);
  if(value.incidentEvidence!==undefined){const binding=value.input.binding as {replaySha256:string;mapMd5:string};validateLibraryIncidentEvidence(value.incidentEvidence,binding);}
  return currentReplayDescriptor(value as unknown as LibraryNumericalResourceDescriptor);
}
function currentAuthority(value:unknown):asserts value is LibraryCurrentReplayAuthority {
  if(!record(value)||!keys(value,["version","leaseId","replayId","numericalTarget","binding","sourceLease"])||
    Buffer.byteLength(JSON.stringify(value))>256*1024||value.version!==1||!token(value.leaseId)||!token(value.replayId)||!record(value.numericalTarget)||
    !record(value.sourceLease)||!keys(value.sourceLease,["location","map"]))throw new Error("Invalid current replay authority");
  const target=value.numericalTarget;
  if(!keys(target,["replayId","slot","stage","inputKey","producerVersion","generation"])||target.replayId!==value.replayId||target.slot!=="numerical"||target.stage!=="S"||
    !hash(target.inputKey,64)||!token(target.producerVersion)||!Number.isSafeInteger(target.generation)||Number(target.generation)<1)throw new Error("Invalid current replay authority target");
  currentBinding(value.binding);const location=currentLocation(value.sourceLease.location);
  if(location.replayId!==value.replayId||location.sha256!==(value.binding as {replaySha256:string}).replaySha256)throw new Error("Invalid current replay authority source");
  if(value.sourceLease.map!==undefined)currentMap(value.sourceLease.map);
}
const currentFields={numerical:["completion","accuracy","maxCombo","misses","sliderBreaks","sliderEndMisses","sliderTickMisses","comboLosses","fc","perfectCombo","ur","biasMs","sampleCount"],
  "timeline-pp":["pp","peakPp"],"fc-pp":["ppIfFc"]};
function currentResults(value:unknown):asserts value is LibraryCurrentReplayResult[] {
  if(!Array.isArray(value)||!value.length||value.length>3||Buffer.byteLength(JSON.stringify(value))>96*1024)throw new Error("Invalid current replay results");
  const slots=new Set<string>();
  for(const result of value){
    if(!record(result)||!keys(result,["slot","producerVersion","metrics"])||typeof result.slot!=="string"||!Object.prototype.hasOwnProperty.call(currentFields,result.slot)||
      slots.has(result.slot)||!token(result.producerVersion)||!record(result.metrics))throw new Error("Invalid current replay result");
    slots.add(result.slot);const metrics=result.metrics;
    if(!keys(metrics,["fields","provenance","errorStrip"])||!record(metrics.fields)||!Object.keys(metrics.fields).length||
      !keys(metrics.fields,currentFields[result.slot as keyof typeof currentFields])||!record(metrics.provenance)||Object.keys(metrics.provenance).length>24||
      Object.entries(metrics.provenance).some(([key,item])=>!token(key)||item!==null&&typeof item!=="boolean"&&!(typeof item==="number"&&Number.isFinite(item))&&
        !(typeof item==="string"&&item.length<=512)))throw new Error("Invalid current replay scalar result");
    for(const [name,metric] of Object.entries(metrics.fields)){
      if(!record(metric))throw new Error("Invalid current replay metric");
      if(metric.state!=="known"){
        if(typeof metric.state!=="string"||!["unknown","not-applicable","error"].includes(metric.state)||!token(metric.reason)||!keys(metric,["state","reason"]))throw new Error("Invalid current replay unavailable metric");
      }else{
        const item=metric.value;
        const valid=name==="completion"?item==="passed"||item==="failed":name==="fc"||name==="perfectCombo"?typeof item==="boolean":
          typeof item==="number"&&Number.isFinite(item)&&(name==="biasMs"||item>=0)&&(name!=="accuracy"||item<=1)&&
          (["accuracy","ur","biasMs","pp","peakPp","ppIfFc"].includes(name)||Number.isSafeInteger(item));
        if(!keys(metric,["state","value"])||!valid)throw new Error("Invalid current replay known metric");
      }
    }
    if(metrics.errorStrip!==undefined){if(result.slot!=="numerical")throw new Error("Invalid current replay strip slot");validateLibraryErrorStrip(metrics.errorStrip);}
  }
}

/** Internal main→utility IPC. Renderer privileges are a separate, narrower allowlist. */
export class LibraryUtilityServer {
  private service?: LibraryService;
  private initializing?: Promise<LibraryService>;
  private readonly initializationAbort = new AbortController();
  private readonly pending = new Set<string>();
  private closed = false;
  private viewerDemand = false;
  private closing?: Promise<void>;
  private readonly dirty:LibraryAnalysisDirtyPublisher;
  private changeRevision=0;
  private pendingReady?:boolean;
  private pendingResources?:string;
  private sentResources?:string;
  private pendingResourceChanges?:LibraryResourceChanges;
  private pendingScopeLost=false;
  private changeTimer?:ReturnType<typeof setTimeout>;
  private pendingStatusOnly=false;
  private changesStarted=false;
  private unsubscribeChanges?:()=>void;
  constructor(private readonly send: (response: LibraryUtilityResponse) => void,
    private readonly notify:(event:LibraryAnalysisDirtyEvent|LibraryChangedEvent)=>void=()=>undefined,
    private readonly nativeAdmission?:LibraryNativeAdmission){
    this.dirty=new LibraryAnalysisDirtyPublisher(notify,()=>{void this.close().catch(()=>undefined);});
  }
  private libraryChanged(change:{ready:boolean;resourceRevision?:string;resourceChanges?:LibraryResourceChanges;statusOnly?:true}):void {
    if(this.closed)return;
    if(typeof change.ready!=="boolean"||this.changeRevision===Number.MAX_SAFE_INTEGER)throw new Error("Invalid library readiness change");
    if(change.resourceRevision!==undefined&&!token(change.resourceRevision))throw new Error("Invalid library resource revision");
    if(change.statusOnly!==undefined&&change.statusOnly!==true)throw new Error("Invalid library status-only flag");
    // Any semantic event in this existing coalescing interval must still invalidate
    // queries. Later progress cannot downgrade it to a status-only notification.
    const from=this.pendingReady===undefined?this.sentResources:this.pendingResources;
    if(change.resourceRevision!==from){
      if(from===undefined||change.resourceRevision===undefined)this.pendingScopeLost=true;
      if(!this.pendingScopeLost&&from!==undefined&&change.resourceRevision!==undefined)
        this.pendingResourceChanges=appendLibraryResourceChanges(this.pendingResourceChanges,from,change.resourceRevision,change.resourceChanges);
    }
    this.pendingStatusOnly=change.statusOnly===true&&change.resourceRevision===from&&(this.pendingReady===undefined||this.pendingStatusOnly);
    this.pendingReady=change.ready;this.pendingResources=change.resourceRevision;this.changeRevision++;this.scheduleLibraryChange();
  }
  private scheduleLibraryChange():void {
    if(this.closed||!this.changesStarted||this.changeTimer||this.pendingReady===undefined)return;
    this.changeTimer=setTimeout(()=>{
      this.changeTimer=undefined;if(this.closed||this.pendingReady===undefined)return;
      const ready=this.pendingReady,resourceRevision=this.pendingResources,statusOnly=this.pendingStatusOnly,
        resourceChanges=this.pendingScopeLost?undefined:this.pendingResourceChanges;
      this.pendingReady=undefined;this.pendingResources=undefined;this.pendingStatusOnly=false;this.pendingResourceChanges=undefined;this.pendingScopeLost=false;
      this.sentResources=resourceRevision;
      try{this.notify({version:1,event:"library-changed",revision:this.changeRevision,ready,...(resourceRevision!==undefined?{resourceRevision}:{}),
        ...(resourceChanges?{resourceChanges}:{}),...(statusOnly?{statusOnly:true as const}:{})});}
      catch{void this.close().catch(()=>undefined);}
    },25);
  }

  async receive(value: unknown): Promise<void> {
    if (!record(value) || !text(value.id)) return;
    const id = value.id;
    let response: LibraryUtilityResponse;
    let admitted = false;
    try {
      if (value.version !== 1 || !text(value.method) || !record(value.args) || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
        throw new Error("Invalid library request");
      if (this.pending.has(id) || this.pending.size >= 64 || (this.pending.size >= 32 && !["stop", "rebuild-stop", "close", "viewer-demand",
        "current-replay-bind","current-replay-store-publish","current-replay-store-release","analysis-settings","query-snapshot-release",
        "metric-settings", "metric-release", "metric-commit", "metric-numerical-handoff", "metric-timeline-handoff", "metric-fc-handoff", "metric-fail", "preparation-release", "preparation-commit", "performance-commit", "preparation-fail", "analysis-resources-confirm", "analysis-dirty-ack"].includes(value.method)))
        throw new Error("Library request queue is busy");
      this.pending.add(id); admitted = true;
      const data = await this.dispatch(value.method, value.args);
      response = { version: 1, id, ok: true, data };
      if (Buffer.byteLength(JSON.stringify(response)) > 2 * 1024 * 1024) throw new Error("Library result exceeds message limit");
    } catch (error) {
      const code=record(error)?error.code:undefined;
      response = { version: 1, id, ok: false, error: (error instanceof Error ? error.message : "Library request failed").slice(0, 2048),
        ...(typeof value.method==="string"&&(LIBRARY_QUERY_OPERATIONS as readonly string[]).includes(value.method)&&typeof code==="string"&&
          (LIBRARY_QUERY_ERROR_CODES as readonly string[]).includes(code)?{errorCode:code as LibraryQueryErrorCode}:{}) };
    }
    finally { if (admitted) this.pending.delete(id); }
    this.send(response);
  }
  private async dispatch(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (method === "close") { await this.close(); return null; }
    if (this.closed) throw new Error("Library utility is closed");
    if(method==="analysis-dirty-ack"){this.dirty.acknowledge(args.revision as number);return null;}
    if (method === "viewer-demand") {
      if (typeof args.active !== "boolean") throw new Error("Invalid viewer demand");
      this.viewerDemand = args.active;
      // Admission can close before initialization and while journal recovery is running.
      await this.service?.setViewerDemand(args.active); return null;
    }
    if (method === "initialize") {
      if (this.initializing) throw new Error("Library utility is already initialized");
      if(args.nativeAdmission!==undefined&&typeof args.nativeAdmission!=="boolean"||args.nativeAdmission&&!this.nativeAdmission)throw new Error("Invalid native admission configuration");
      if (!absolute(args.directory) || !absolute(args.nativeExecutable) || !text(args.sessionId) || !Array.isArray(args.sources) || args.sources.length > 3 ||
          args.sources.some(source => !record(source) || !text(source.id) || !["stable", "replays", "lazer"].includes(String(source.kind)) ||
            !absolute(source.directory) || (source.kind === "stable" && !absolute(source.songsRoot)))) throw new Error("Invalid library initialization");
      this.initializing = LibraryService.open(args as unknown as LibraryServiceConfiguration, this.initializationAbort.signal, service => {
        this.service = service;service.onAnalysisDirty(flags=>this.dirty.mark(flags)); void service.setViewerDemand(this.viewerDemand);
        if(!this.closed)this.unsubscribeChanges=service.onLibraryChanged(change=>this.libraryChanged(change));
      }, false,args.nativeAdmission?this.nativeAdmission:undefined);
      this.service = await this.initializing;
      if (this.closed) { await this.service.close(); throw new Error("Library utility is closed"); }
      this.dirty.start();
      this.changesStarted=true;this.scheduleLibraryChange();
      return this.service.status();
    }
    if (!this.service) throw new Error("Library utility is not initialized");
    if(method==="current-replay-bind"){
      if(!keys(args,["location","observation","map","descriptor"])||!refresh(args.observation)||
        !keys(args.observation as unknown as Record<string,unknown>,["sha256","available","locator","metadata"]))throw new Error("Invalid current replay binding request");
      const location=currentLocation(args.location,true),map=args.map===undefined?undefined:currentMap(args.map,true),descriptor=currentDescriptor(args.descriptor);
      return this.service.bindCurrentReplay(location,args.observation,map,descriptor);
    }
    if(method==="current-replay-store-publish"||method==="current-replay-store-release"){
      if(!keys(args,method==="current-replay-store-publish"?["authority","results"]:["authority"]))throw new Error("Invalid current replay authority request");
      currentAuthority(args.authority);
      if(method==="current-replay-store-release"){this.service.releaseCurrentReplay(args.authority);return null;}
      currentResults(args.results);return this.service.publishCurrentReplay(args.authority,args.results);
    }
    if((LIBRARY_QUERY_OPERATIONS as readonly string[]).includes(method)){
      validateLibraryPassiveRequest(method,args);return this.service.queryRequest(method as LibraryQueryOperation,args);
    }
    if((LIBRARY_USER_METADATA_OPERATIONS as readonly string[]).includes(method)){
      validateLibraryUserMetadata(method,args);return this.service.userMetadataRequest(method as LibraryUserMetadataOperation,args);
    }
    if(method==="analysis-settings"||method==="analysis-request"||method==="analysis-retry"){
      if(!keys(args,method==="analysis-settings"?["settings"]:method==="analysis-request"?["replayId","reason"]:["replayId"])||
        method!=="analysis-settings"&&!token(args.replayId)||method==="analysis-request"&&(typeof args.reason!=="string"||!["open","selection"].includes(args.reason)))
        throw new Error("Invalid explicit analysis request");
      if(method==="analysis-settings"&&args.settings!==undefined){
        const setting=args.settings;
        if(!record(setting)||!keys(setting,["mode","userPaused","workers","pauseOnBattery","fasterProcessing"])||typeof setting.mode!=="string"||
          !["bg","demand","off"].includes(setting.mode)||typeof setting.userPaused!=="boolean"||typeof setting.pauseOnBattery!=="boolean"||
          ![1,2,4].includes(Number(setting.workers))||typeof setting.workers!=="number"||
          setting.fasterProcessing!==undefined&&typeof setting.fasterProcessing!=="boolean")throw new Error("Invalid library analysis settings");
      }
      return this.service.analysisRequest(method,args);
    }
    if(method==="analysis-eligible"){
      if(!record(args.lease)||!record(args.lease.ticket))throw new Error("Invalid analysis lease");return this.service.analysisEligible(args.lease as unknown as LibraryAnalysisLease);
    }
    if (method === "status") return this.service.status();
    if(method==="performance-cache-get"||method==="performance-cache-put"||method==="performance-scalar-get"||method==="performance-scalar-put")return this.service.performanceCacheRequest(method,args);
    if ((LIBRARY_METRIC_OPERATIONS as readonly string[]).includes(method)) return this.service.metricRequest(method as LibraryMetricOperation, args);
    if ((LIBRARY_PREPARATION_OPERATIONS as readonly string[]).includes(method)) return this.service.preparationRequest(method as LibraryPreparationOperation,args);
    if(method === "analysis-resources-confirm"){
      if(!record(args.ticket)||!locationTicket(args.location)||!refresh(args.observation)||(args.map!==undefined&&!mapTicket(args.map)))
        throw new Error("Invalid analysis resource confirmation");
      return this.service.confirmAnalysisResources(args.ticket as unknown as LibraryMetricTicket,args.location,args.observation,
        args.origin as LibraryConsumedOrigin,args.map as LibraryMapTicket|undefined,args.recipe as LibraryNumericalInputRecipe|undefined,args.incidentEvidence as import("../../../../shared/library-incidents").LibraryIncidentEvidenceReceipt|undefined);
    }
    if (method === "preparation-commit") {
      if (!record(args.ticket) || !locationTicket(args.location) || !refresh(args.observation) || !Array.isArray(args.targets) ||
        (args.map !== undefined && !mapTicket(args.map))) throw new Error("Invalid prepared analysis receipt");
      return this.service.commitPreparation(args.ticket as unknown as LibraryPreparationTicket,args.location,args.observation,
        args.targets as LibraryPreparedTarget[],args.origin as LibraryConsumedOrigin,args.map as LibraryMapTicket|undefined,args.recipe as LibraryNumericalInputRecipe|undefined,args.handoff as boolean|undefined,args.incidentEvidence as import("../../../../shared/library-incidents").LibraryIncidentEvidenceReceipt|undefined);
    }
    if(method==="performance-commit"){
      if(!record(args.ticket)||!locationTicket(args.location)||!record(args.map)||!hash(args.map.md5,32)||!hash(args.map.sha256,64)||
        args.map.ticket!==undefined&&!mapTicket(args.map.ticket)||!Array.isArray(args.results)||args.results.length>3||
        args.embeddedRequired!==undefined&&typeof args.embeddedRequired!=="boolean"||args.scoreLocation!==undefined&&!locationTicket(args.scoreLocation))
        throw new Error("Invalid prepared P receipt");
      return this.service.commitPerformance(args.ticket as unknown as LibraryPreparationTicket,args.location,args.map as unknown as LibraryPerformanceMapReceipt,
        args.results as LibraryPreparedResult[],args.origin as LibraryConsumedOrigin,args.embeddedRequired as boolean|undefined,args.scoreLocation as LibraryLocationTicket|undefined);
    }
    if(method==="performance-context"){
      if(!record(args.ticket))throw new Error("Invalid performance context ticket");
      return this.service.performanceContext(args.ticket as unknown as LibraryPreparationTicket);
    }
    if (method === "prepare-open" || method === "prepare-map") {
      if(args.analysis !== undefined && typeof args.analysis !== "boolean") throw new Error("Invalid analysis resource policy");
      if (method === "prepare-open" && !text(args.replayId)) throw new Error("Invalid selected replay identity");
      if (method === "prepare-map" && !hash(args.md5, 32)) throw new Error("Invalid selected map identity");
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 8))
        throw new Error("Invalid selected location page limit");
      if (args.after !== undefined && (!record(args.after) || !text(args.after.sourceId) || !text(args.after.sourceKey, 32768)))
        throw new Error("Invalid selected location cursor");
      const after = args.after as { sourceId: string; sourceKey: string } | undefined;
      return method === "prepare-open" ? this.service.prepareOpen(args.replayId as string, after, args.limit as number | undefined, args.analysis as boolean | undefined)
        : this.service.prepareMap(args.md5 as string, after, args.limit as number | undefined);
    }
    if(method==="resource-current"){
      if(!keys(args,["location","map"])||!locationTicket(args.location)||args.map!==undefined&&!mapTicket(args.map))throw new Error("Invalid passive resource lease");
      return this.service.resourceLeaseCurrent(args.location,args.map as LibraryMapTicket|undefined);
    }
    if (method === "commit-open") {
      if (!locationTicket(args.ticket) || !refresh(args.observation) || (args.map !== undefined && !mapTicket(args.map)))
        throw new Error("Invalid selected resource receipt");
      return this.service.commitOpen(args.ticket, args.observation, args.map as LibraryMapTicket | undefined);
    }
    if (method === "start-updates") { this.service.startUpdates(); return null; }
    if (method === "update-mode") {
      if (!["auto", "launch", "manual"].includes(String(args.mode))) throw new Error("Invalid update mode");
      this.service.setUpdateMode(args.mode as LibraryUpdateMode); return null;
    }
    if (method === "rebuild") { this.service.rebuild(); return null; }
    if (method === "rebuild-stop") { this.service.stopRebuild(); return null; }
    if (method === "scan" || method === "stop" || method === "source-enabled") {
      if (!text(args.sourceId)) throw new Error("Invalid source identity");
      if (method === "source-enabled") {
        if (typeof args.enabled !== "boolean") throw new Error("Invalid source state");
        this.service.setSourceEnabled(args.sourceId, args.enabled);
      } else this.service[method](args.sourceId);
      return null;
    }
    if (method === "import") {
      if (!Array.isArray(args.paths) || args.paths.length > 1000 || !args.paths.every(absolute)) throw new Error("Invalid import selection");
      return this.service.importReplays(args.paths);
    }
    throw new Error("Unknown library operation");
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.dirty.close();
      if(this.changeTimer)clearTimeout(this.changeTimer);this.changeTimer=undefined;this.pendingReady=undefined;
      this.unsubscribeChanges?.();this.unsubscribeChanges=undefined;
      this.initializationAbort.abort();
      this.closing = (async () => {
        // Recovery owns file handles until it has observed cancellation. Exposing status/control
        // during initialization must not let shutdown close SQLite underneath that recovery.
        await this.initializing?.catch(() => undefined);
        await this.service?.close();
      })();
    }
    return this.closing;
  }
}
