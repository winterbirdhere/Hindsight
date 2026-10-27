import { mkdir, lstat } from "fs/promises";
import { join, isAbsolute, resolve } from "path";
import type { LibrarySourceRegistration, LibraryUpdateMode, LibraryImportSummary } from "../../../../shared/replay-library";
import { LibraryStore, LibraryLocationCursor, LibraryLocationTicket, LibraryLocationRefresh, LibraryMapTicket, LibraryAnalysisLease } from "./library-store";
import { LibraryScanCoordinator, SourceScanAdapter, SourceScanOptions } from "./library-scan-coordinator";
import { ReplayImporter, ImportResult } from "./import-replays";
import { scanReplayFolder, ReplayFolderScanOptions } from "./sources/replays-folder-source";
import { scanStableScores } from "./sources/stable-scores-source";
import { indexStableMaps, scanStableMaps } from "./sources/stable-maps-source";
import { LibraryRebuildCoordinator } from "./library-rebuild-coordinator";
import { LibraryUpdatePolicy } from "./library-update-policy";
import { watchLibrarySource } from "./library-source-watch";
import { LazerSource } from "./sources/lazer-source";
import { scanLazerSource } from "./sources/lazer-scan";
import { scanImportedReplays } from "./sources/imported-source";
import { LibraryOriginIndex, LibraryOriginSnapshot, libraryOriginRevision, readLibraryOrigins } from "./library-origin-index";
import { LibraryMetricApi, LibraryMetricOperation } from "./library-metric-api";
import { LibraryPreparationApi, LibraryPreparationOperation } from "./library-preparation-api";
import type { LibraryPreparedTarget, LibraryPreparationTicket } from "./library-preparation-store";
import type { LibraryConsumedOrigin, LibraryNumericalInputRecipe } from "../../../../shared/library-analysis";
import type { LibraryMetricTicket,LibraryAnalysisSettings } from "../../../../shared/replay-library-metrics";
import type { LibraryNativeAdmission } from "./library-native-admission";
import type { LibraryIncidentEvidenceReceipt } from "../../../../shared/library-incidents";
import { LibraryQueryApi,LibraryQueryOperation } from "./library-query-api";
import { LibraryUserMetadataApi,LibraryUserMetadataOperation } from "./library-user-metadata-api";
import { LibraryIndexMaintenance } from "./library-index-maintenance";
import { LibraryNativeWatch } from "./library-native-watch";
import type { LibraryResourceChanges } from "../../../../shared/library-resource-changes";

type LibraryServiceChange = {ready:boolean;resourceRevision?:string;resourceChanges?:LibraryResourceChanges;statusOnly?:true};

export interface LibraryConfiguredSource extends LibrarySourceRegistration { songsRoot?: string; configuration?: "automatic" | "configured" }
export interface LibraryServiceConfiguration {
  directory: string; sessionId: string; nativeExecutable: string; sources: LibraryConfiguredSource[]; originFile?: string;nativeAdmission?:boolean;
}

/** Utility-owned composition, independent of viewer managers. Main supplies an immutable validated
 * installation snapshot. Update-mode/watch registration and renderer policy are separate owners. */
export class LibraryService {
  private readonly store: LibraryStore;
  private readonly metricApi: LibraryMetricApi;
  private readonly preparationApi: LibraryPreparationApi;
  private readonly queryApi:LibraryQueryApi;
  private readonly userMetadataApi:LibraryUserMetadataApi;
  private readonly importer: ReplayImporter;
  private readonly scans: LibraryScanCoordinator;
  private readonly rebuilds: LibraryRebuildCoordinator;
  private readonly updates: LibraryUpdatePolicy;
  private readonly sources: LibraryConfiguredSource[];
  private readonly native: LazerSource;
  private readonly sourceWatch: LibraryNativeWatch;
  private readonly origins: LibraryOriginIndex;
  private readonly indexMaintenance:LibraryIndexMaintenance;
  private readonly libraryObservers=new Set<(change:LibraryServiceChange)=>void>();
  private publishedResourceRevision?:string;
  private identityTurn=true;
  private viewerDemand=false;
  private originSnapshot: LibraryOriginSnapshot;
  private readonly mapErrors = new Map<string, string>();
  private readonly importAbort = new AbortController();
  private readonly imports = new Set<Promise<unknown>>();
  private readonly importRecovery = { state: "pending" as "pending" | "complete" | "failed" | "stopped", completed: 0, failed: 0, failures: [] as string[], error: undefined as string | undefined };
  private recovery: Promise<void> = Promise.resolve();
  private updatesRequested = false;
  private closing?: Promise<void>;

  /** Utility callers acknowledge metadata readiness without waiting for viewer-parked recovery.
   * Direct callers may await recovery; both forms retain the same owned close/drain barrier. */
  static async open(config: LibraryServiceConfiguration, signal?: AbortSignal, onCreated: (service: LibraryService) => void = () => undefined,
    waitForRecovery = true,nativeAdmission?:LibraryNativeAdmission): Promise<LibraryService> {
    if (!isAbsolute(config.directory) || !isAbsolute(config.nativeExecutable) || !config.sessionId || config.sessionId.length > 128 ||
        (config.originFile !== undefined && (typeof config.originFile !== "string" || config.originFile.length > 32768 || !isAbsolute(config.originFile))) ||
        config.sources.length > 3 || new Set(config.sources.map(source => source.kind)).size !== config.sources.length ||
        config.sources.some(source => source.id === "imports" || source.kind === "imported" || !isAbsolute(source.directory) ||
          (source.kind === "stable" && (!source.songsRoot || !isAbsolute(source.songsRoot))))) throw new Error("Invalid library service configuration");
    await mkdir(config.directory, { recursive: true });
    if ((await lstat(config.directory)).isSymbolicLink()) throw new Error("Library directory cannot be a link");
    const ownedDirectory = join(config.directory, "imports");
    await mkdir(ownedDirectory, { recursive: true });
    if ((await lstat(ownedDirectory)).isSymbolicLink()) throw new Error("Owned import directory cannot be a link");
    // Required origin snapshot is bounded/cancellable, but never waits for viewer demand. Long
    // cached-row reconciliation is separate from metadata readiness and owns its own gate.
    const snapshot = await readLibraryOrigins(config.originFile, signal);
    const service = new LibraryService(config, snapshot,nativeAdmission);
    try {
      onCreated(service);
      signal?.throwIfAborted();
      service.indexMaintenance.wake();
      if (!service.store.hasPendingImports()) { service.importRecovery.state = "complete"; service.origins.start(); return service; }
      const abort = () => service.importAbort.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      service.recovery = service.importer.recover(service.importAbort.signal, result => {
        if (result.status === "failed") {
          service.importRecovery.failed++;
          if (service.importRecovery.failures.length < 50) service.importRecovery.failures.push((result.error ?? "Import recovery failed").slice(0, 2048));
        } else service.importRecovery.completed++;
      }).then(() => {
        service.importRecovery.state = "complete";
        if (!service.closing) service.origins.start();
        if (service.updatesRequested && !service.closing) service.updates.start();
      }, error => {
        service.importRecovery.state = service.importAbort.signal.aborted ? "stopped" : "failed";
        service.importRecovery.error = (error instanceof Error ? error.message : "Import recovery failed").slice(0, 2048);
        throw error;
      }).finally(() => signal?.removeEventListener("abort", abort));
      // The utility may return while recovery is pending. Status retains any failure,
      // and close still awaits the original rejecting promise before closing SQLite.
      void service.recovery.catch(() => undefined);
      if (waitForRecovery) await service.recovery;
      return service;
    }
    catch (error) { await service.close(); throw error; }
  }

  private constructor(config: LibraryServiceConfiguration, snapshot: LibraryOriginSnapshot,nativeAdmission?:LibraryNativeAdmission) {
    this.originSnapshot = snapshot;
    this.store = new LibraryStore(join(config.directory, "library.sqlite"), config.sessionId, sha => this.originSnapshot.state === "error"
      ? { client: "unknown", provenance: "unavailable" } : this.originSnapshot.entries.get(sha));
    this.metricApi = new LibraryMetricApi(this.store.metrics);
    this.preparationApi = new LibraryPreparationApi(this.store.preparations);
    this.queryApi=new LibraryQueryApi(this.store.createQueryReader());
    this.userMetadataApi=new LibraryUserMetadataApi(this.store);
    this.indexMaintenance=new LibraryIndexMaintenance(()=>{
      // Keep each synchronous page separate so viewer/Stop acknowledgement can run between them.
      if(this.store.queryProjectionPending()) {this.store.maintainQueryProjection();return true;}
      // This legacy-named lane also refreshes general query algorithms and filter
      // evidence. Retain its bounded turns after retiring library C analysis.
      if(this.store.incidentIdentityPending()&&(this.identityTurn||!this.store.sourceAdmissionPending()&&!this.store.mapGarbagePending())){
        this.identityTurn=false;this.store.maintainIncidentIdentity();return true;
      }
      this.identityTurn=true;
      if(this.store.sourceAdmissionPending()){this.store.maintainSourceAdmission();return true;}
      if(this.store.mapGarbagePending()){this.store.maintainMapGarbage(16);return this.store.mapGarbagePending()>0||this.store.incidentIdentityPending();}
      if(this.store.capabilityRecoveryPending()){
        const more=this.store.maintainCapabilityRecovery();this.publishLibraryChange(true);return more;
      }
      return false;
    });
    this.store.enableNumericalAdmission();
    this.store.enablePerformanceAdmission();
    // Recovery/explicit opens may consume the bootstrap snapshot before the watcher reread.
    if (this.store.sourceMetricRevision() !== libraryOriginRevision(snapshot)) this.store.invalidateSourceMetricRevision();
    this.origins = new LibraryOriginIndex(config.originFile, {
      publish: current => {
        const changed=current.state!==this.originSnapshot.state||current.fingerprint!==this.originSnapshot.fingerprint;
        this.originSnapshot = current;if(changed)this.store.externalAnalysisEvidenceChanged();
      }, revision: () => this.store.sourceMetricRevision(),
      invalidate: () => this.store.invalidateSourceMetricRevision(),
      // One identity per checkpoint keeps long duplicate-location chains out of a page-sized batch.
      page: after => this.store.reprojectSourceMetrics(after, 1), complete: revision => this.store.completeSourceMetricRevision(revision),
    });
    const owned = join(config.directory, "imports");
    this.importer = new ReplayImporter(this.store, owned);
    this.sources = [...config.sources.map(source => ({ ...source })), { id: "imports", kind: "imported", directory: owned }];
    const native = this.native = new LazerSource(() => config.nativeExecutable,nativeAdmission);
    this.sourceWatch = new LibraryNativeWatch(() => config.nativeExecutable);
    const adapters: Record<string, SourceScanAdapter> = Object.create(null);
    try {
      this.store.reconcileSources(this.sources);
      for (const source of this.sources) {
        if (source.kind === "replays") adapters[source.id] = options => scanReplayFolder(source.directory, options);
        else if (source.kind === "lazer") adapters[source.id] = options => scanLazerSource(native, source.directory,
          {...options,...(!nativeAdmission?{waitForNative:undefined}:{})});
        else if (source.kind === "stable") adapters[source.id] = async function* (this: LibraryService, options: SourceScanOptions) {
          try {
            await indexStableMaps(this.store, source.id, source.directory, resolve(source.songsRoot as string),
              { ...options, reuseEquivalentCatalog: options.resourceIntent === "check" });
            this.origins.refresh();
            this.mapErrors.delete(source.id);
          } catch (error) {
            if (options.signal?.aborted) throw error;
            // Missing/corrupt map metadata must not hide independently readable saved scores.
            this.mapErrors.set(source.id, error instanceof Error ? error.message : "Map metadata index failed");
          }
          options.onProgress?.({ phase: "checking-replays", completed: 0, unit: "replay-observations" });
          yield* scanStableScores(source.directory, options);
        }.bind(this);
        else adapters[source.id] = options => scanImportedReplays(this.importLocations(), options);
      }
      const scanStates = new Map<string, string>();
      this.scans = new LibraryScanCoordinator(this.store, adapters, (status, statusOnly) => {
        if (statusOnly) { this.publishLibraryChange(true); return; }
        const key = JSON.stringify([status.state, status.error, status.failureReason]);
        if (scanStates.get(status.sourceId) === key) return;
        scanStates.set(status.sourceId, key);
        this.publishLibraryChange();
      });
      const rebuildAdapters = { ...adapters };
      const mapAdapters: ConstructorParameters<typeof LibraryRebuildCoordinator>[2] = Object.fromEntries(this.sources
        .filter(source => source.kind === "stable").map(source => [source.id,
          (options: ReplayFolderScanOptions) => scanStableMaps(source.directory, resolve(source.songsRoot as string), options)]));
      for (const source of this.sources) if (source.kind === "stable") rebuildAdapters[source.id] = options => scanStableScores(source.directory, options);
      this.rebuilds = new LibraryRebuildCoordinator(this.store, rebuildAdapters, mapAdapters, async () => {
        for (const source of this.sources) this.scans.stop(source.id);
        await this.scans.idle();
      });
      this.updates = new LibraryUpdatePolicy(this.sources.map(source => source.id), this.store.updateMode(), {
        enabled: id => this.store.sourceEnabled(id), held: () => this.rebuilds.busy,
        scan: async (id, resourceIntent) => { await this.scans.scan(id, resourceIntent); return this.scans.status(id).state === "complete"; },
        stop: id => this.scans.stop(id), saveMode: mode => this.store.setUpdateMode(mode), claimLaunch: id => this.store.claimLaunchScan(id),
        watch: (id, changed, failed) => watchLibrarySource(this.source(id), changed, error => {
          failed(error);
          // The policy records watchError without starting work. Publish that
          // status even when Off/idle leaves no later semantic event to carry it.
          this.publishLibraryChange(true);
        }, this.sourceWatch.factory),
      });
      this.store.onMaintenanceNeeded(()=>this.indexMaintenance.wake());
      this.store.onLibraryChanged(() => this.publishLibraryChange());
    } catch (error) { this.store.close(); throw error; }
  }
  private publishLibraryChange(statusOnly?: true): void {
    if (this.closing) return;
    const changes = this.store.currentChangesSince(this.publishedResourceRevision), changed = changes.to !== this.publishedResourceRevision;
    const change:LibraryServiceChange = { ready: this.store.queryReadiness() !== "updating", resourceRevision: changes.to,
      ...(changed && this.publishedResourceRevision !== undefined ? {resourceChanges:changes} : {}), ...(statusOnly && !changed ? { statusOnly } : {}) };
    this.publishedResourceRevision = changes.to;
    for (const observer of this.libraryObservers) observer(change);
  }
  onLibraryChanged(observer:(change:LibraryServiceChange)=>void):()=>void {
    this.checkOpen();this.libraryObservers.add(observer);const resourceRevision=this.store.resourceRevision();
    this.publishedResourceRevision??=resourceRevision;
    observer({ready:this.store.queryReadiness()!=="updating",resourceRevision});
    return()=>this.libraryObservers.delete(observer);
  }
  private async *importLocations() {
    let after = "";
    for (;;) {
      const page = this.store.sourceLocations("imports", after);
      for (const row of page) yield row;
      if (page.length < 128) return;
      after = page[page.length - 1].sourceKey;
    }
  }
  private checkOpen(): void { if (this.closing) throw new Error("Library service is closed"); }
  private source(id: string): LibraryConfiguredSource {
    this.checkOpen(); const source = this.sources.find(item => item.id === id);
    if (!source) throw new Error("Unknown library source"); return source;
  }
  status() {
    this.checkOpen();
    const pending=this.store.queryProjectionPending();
    return { replayCount: this.store.replayCount(), analysis: this.store.analysisActivity(), updateMode: this.updates.mode, rebuild: this.rebuilds.status(), sourceMetrics: this.origins.status(),
      indexMaintenance:{...this.indexMaintenance.status(),pending,ready:this.store.queryReadiness()!=="updating",mapGarbagePending:this.store.mapGarbagePending(),incidentIdentity:this.store.incidentIdentityStatus(),
        capabilityRecovery:{...this.store.capabilityRecoveryStatus(),...(this.viewerDemand&&this.store.capabilityRecoveryStatus().state!=="complete"?{state:"held" as const}:{})}}, importRecovery: { ...this.importRecovery, failures: [...this.importRecovery.failures] },
      sources: this.sources.map(source => {
        const scan = this.scans.status(source.id), update = this.updates.status(source.id);
        const terminal = ["idle", "complete", "error", "stopped"].includes(scan.state);
        return { ...scan, state: terminal && update.active ? "queued" : terminal && update.stopped ? "stopped" : scan.state, update,
          kind: source.kind, directory: source.directory, enabled: this.store.sourceEnabled(source.id), mapError: this.mapErrors.get(source.id),
          configuration:source.configuration??"configured",hasIndexHistory:this.store.sourceHasIndexHistory(source.id) };
      }) };
  }
  private checkRecovered(): void {
    if (this.importRecovery.state !== "complete") throw new Error(this.importRecovery.error ?? "Library import recovery is pending");
  }
  startUpdates(): void {
    this.checkOpen(); this.updatesRequested = true; this.origins.refresh();
    if (this.importRecovery.state === "complete") this.updates.start();
  }
  prepareOpen(replayId: string, after?: LibraryLocationCursor, limit = 8, analysis = false) {
    this.checkOpen();
    return this.store.openLocationCandidates(replayId, after, limit, analysis);
  }
  onAnalysisDirty(observer:(flags:number)=>void):()=>void{return this.store.onAnalysisDirty(observer);}
  performanceCacheRequest(method:"performance-cache-get"|"performance-cache-put"|"performance-scalar-get"|"performance-scalar-put",args:Record<string,unknown>):unknown {
    this.checkOpen();
    const inputKey=args.inputKey as string,mode=args.mode as Parameters<typeof this.store.performanceCache.get>[1];
    if(method==="performance-cache-get")return this.store.performanceCache.get(inputKey,mode);
    if(method==="performance-scalar-get")return this.store.performanceCache.getScalar(inputKey,mode);
    if(method==="performance-scalar-put"){this.store.performanceCache.putScalar(inputKey,mode,args.value as number);return null;}
    this.store.performanceCache.put(inputKey,mode,args.value as Parameters<typeof this.store.performanceCache.put>[2]);return null;
  }
  analysisEligible(lease:LibraryAnalysisLease):boolean{this.checkOpen();return this.store.analysisEligible(lease);}
  metricRequest(method: LibraryMetricOperation, args: Record<string, unknown>): unknown {
    this.checkOpen();const previousMode=method==="metric-settings"&&args.settings!==undefined?this.store.metrics.analysisSettings().mode:undefined;
    const result=this.metricApi.receive(method, args);
    // Scheduling controls do not change an analysis recipe. Only entering background mode
    // needs a bounded admission pass for identities that previously had no request.
    if(previousMode!==undefined&&previousMode!=="bg"&&(result as LibraryAnalysisSettings).mode==="bg"){
      this.store.invalidateSourceMetricRevision();this.origins.refresh();
    }
    return result;
  }
  preparationRequest(method: LibraryPreparationOperation, args: Record<string, unknown>): unknown {
    this.checkOpen(); return this.preparationApi.receive(method,args);
  }
  queryRequest(method:LibraryQueryOperation,args:Record<string,unknown>):unknown {this.checkOpen();return this.queryApi.receive(method,args);}
  userMetadataRequest(method:LibraryUserMetadataOperation,args:Record<string,unknown>):unknown {this.checkOpen();return this.userMetadataApi.receive(method,args);}
  analysisRequest(method:"analysis-settings"|"analysis-request"|"analysis-retry",args:Record<string,unknown>):unknown {
    this.checkOpen();if(method==="analysis-settings")return this.metricRequest("metric-settings",args);
    if(typeof args.replayId!=="string"||!args.replayId||args.replayId.length>128||method==="analysis-request"&&!["open","selection"].includes(String(args.reason)))throw Error("Invalid explicit analysis request");
    const reason=method==="analysis-retry"?"retry":args.reason as "open"|"selection";
    this.store.preparations.request(args.replayId,"P",reason);
    this.store.preparations.request(args.replayId,"S",reason);
    return null;
  }
  bindCurrentReplay(...args:Parameters<LibraryStore["bindCurrentReplay"]>){this.checkOpen();return this.store.bindCurrentReplay(...args);}
  publishCurrentReplay(...args:Parameters<LibraryStore["publishCurrentReplay"]>){this.checkOpen();return this.store.publishCurrentReplay(...args);}
  releaseCurrentReplay(...args:Parameters<LibraryStore["releaseCurrentReplay"]>){this.checkOpen();return this.store.releaseCurrentReplay(...args);}
  resourceLeaseCurrent(...args:Parameters<LibraryStore["resourceLeaseCurrent"]>){this.checkOpen();return this.store.resourceLeaseCurrent(...args);}
  commitPreparation(ticket: LibraryPreparationTicket, location: LibraryLocationTicket, observation: LibraryLocationRefresh,
    targets: LibraryPreparedTarget[], origin: LibraryConsumedOrigin, map?: LibraryMapTicket,recipe?:LibraryNumericalInputRecipe,handoff=false,incidentEvidence?:LibraryIncidentEvidenceReceipt) {
    this.checkOpen(); return this.store.commitPreparedAnalysis(ticket,location,observation,targets,origin,map,recipe,handoff,incidentEvidence);
  }
  commitPerformance(...args:Parameters<LibraryStore["commitPreparedPerformance"]>){this.checkOpen();return this.store.commitPreparedPerformance(...args);}
  performanceContext(ticket:LibraryPreparationTicket){this.checkOpen();return this.store.preparePerformanceContext(ticket);}
  confirmAnalysisResources(ticket:LibraryMetricTicket,location:LibraryLocationTicket,observation:LibraryLocationRefresh,origin:LibraryConsumedOrigin,map?:LibraryMapTicket,recipe?:LibraryNumericalInputRecipe,incidentEvidence?:LibraryIncidentEvidenceReceipt){
    this.checkOpen();return this.store.confirmAnalysisResources(ticket,location,observation,origin,map,recipe,incidentEvidence);
  }
  prepareMap(md5: string, after?: LibraryLocationCursor, limit = 8) {
    this.checkOpen(); return this.store.openMapCandidates(md5, after, limit);
  }
  commitOpen(ticket: LibraryLocationTicket, observation: LibraryLocationRefresh, map?: LibraryMapTicket) {
    this.checkOpen(); return this.store.commitLocationRefresh(ticket, observation, map);
  }
  setUpdateMode(mode: LibraryUpdateMode): void { this.checkOpen(); this.updates.setMode(mode); }
  scan(id: string): void {
    this.checkRecovered();
    this.source(id); if (!this.store.sourceEnabled(id)) throw new Error("Source is disabled");
    if (this.rebuilds.busy) throw new Error("Library rebuild is active"); this.origins.refresh(); this.updates.scanNow(id);
  }
  stop(id: string): void { this.source(id); this.updates.stop(id); this.rebuilds.stop(); }
  rebuild(): void {
    this.checkOpen(); this.checkRecovered(); this.rebuilds.start(this.sources.filter(source => this.store.sourceEnabled(source.id)).map(source => source.id));
    void this.rebuilds.idle().then(() => { if (!this.closing) { this.origins.refresh(); this.updates.resumePending(); } });
  }
  stopRebuild(): void { this.checkOpen(); this.rebuilds.stop(); }
  setSourceEnabled(id: string, enabled: boolean): void {
    if (this.source(id).kind === "imported") throw new Error("Explicit imports remain enabled");
    if(this.store.sourceEnabled(id)===enabled)return;
    this.updates.stop(id); this.rebuilds.stop(); this.store.setSourceEnabled(id, enabled); this.updates.sourceChanged(id);
    // Query membership/display truth precedes separate durable availability admission.
    // Neither restarts the independent whole-library origin/version reconciliation pass.
  }
  async setViewerDemand(active: boolean): Promise<void> {
    this.checkOpen(); this.viewerDemand=active; await Promise.all([this.scans.setViewerDemand(active), this.importer.setViewerDemand(active), this.rebuilds.setViewerDemand(active), this.origins.setViewerDemand(active),this.indexMaintenance.setViewerDemand(active)]);
    if(!active&&this.store.capabilityRecoveryPending())this.indexMaintenance.wake();
  }
  // Source-operation idle intentionally excludes viewer-parked metric maintenance.
  async idle(): Promise<void> { await this.recovery; await this.rebuilds.idle(); await this.updates.idle(); await this.scans.idle(); }
  async settleSourceMetrics(): Promise<void> { this.checkOpen(); await this.recovery; await this.origins.drain(); }
  async settleIndexMaintenance():Promise<void> {this.checkOpen();await this.indexMaintenance.drain();}
  async importReplays(paths: readonly string[]):Promise<LibraryImportSummary> {
    this.checkOpen();
    const work = this.recovery.then(() => { this.checkOpen(); return this.importer.importReplays(paths, this.importAbort.signal); }); this.imports.add(work);
    let result: ImportResult[];
    try { result = await work; } finally { this.imports.delete(work); }
    return { added: result.filter(item => item.status === "added").length,
      alreadyImported: result.filter(item => item.status === "already-imported").length,
      failed: result.filter(item => item.status === "failed").length,
      failures: result.filter(item => item.status === "failed").slice(0, 50).map(item => ({ path: item.path.slice(0, 4096), error: item.error?.slice(0, 4096) })),
      truncatedFailures: result.filter(item => item.status === "failed").length > 50 };
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.updates.close();
      this.importAbort.abort();
      this.closing = (async () => {
        try {
          const outcomes = await Promise.allSettled([this.recovery, this.rebuilds.close(), this.scans.close(), this.native.close(), this.sourceWatch.close(), this.origins.close(),this.indexMaintenance.close(), this.updates.idle(), ...this.imports]);
          const failure = outcomes.find(outcome => outcome.status === "rejected" && outcome.reason?.name !== "AbortError");
          if (failure?.status === "rejected") throw failure.reason;
        }
        finally { this.libraryObservers.clear();this.queryApi.close();this.store.close(); }
      })();
    }
    return this.closing;
  }
}
