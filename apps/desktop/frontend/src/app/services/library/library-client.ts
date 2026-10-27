import { BehaviorSubject, Observable, Subject, Subscription } from "rxjs";
import type { LibraryChangedEvent, LibraryRequest, LibraryStatus } from "../../../../../shared/replay-library";
import { readLibraryResourceChanges } from "../../../../../shared/library-resource-changes";
import { LIBRARY_QUERY_ERROR_CODES } from "../../../../../shared/replay-library";

interface Transport { request(input: LibraryRequest): Promise<unknown>; demand(active: boolean): Promise<void>; onChanged?(listener:(event:LibraryChangedEvent)=>void):()=>void }
interface AnalyzerSources {
  osuFolderService: { settings$: Observable<unknown>; getOsuFolder(): string; whenReady(): Promise<string> };
  scenarioManager: { loadState$: Observable<{ phase: string }> };
  clipRecorder: { state$: Observable<unknown>; readonly isBusy: boolean };
}
const knownQueryError=(error:unknown):boolean=>error instanceof Error&&"code"in error&&typeof error.code==="string"&&
  (LIBRARY_QUERY_ERROR_CODES as readonly string[]).includes(error.code);
function normalizeQueryResult(value:unknown):unknown {
  if(!value||typeof value!=="object"||!("libraryQueryError"in value))return value;
  const error=value.libraryQueryError;
  if(Object.keys(value).length!==1||!error||typeof error!=="object"||Object.keys(error).length!==2||!("code"in error)||
    !("message"in error)||typeof error.code!=="string"||!(LIBRARY_QUERY_ERROR_CODES as readonly string[]).includes(error.code)||
    typeof error.message!=="string"||error.message.length>2048)throw new Error("Invalid library query error response");
  throw Object.assign(new Error(error.message),{code:error.code});
}

function waitForConfiguration(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    work.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
  });
}

/** One renderer lifetime, outside React mounts. Background acknowledgements are observed, never
 * awaited by current-replay work; query methods have no analysis admission side effects. */
export class LibraryClient {
  readonly connection$ = new BehaviorSubject<{ state: "connecting" | "ready" | "error"; error?: string }>({ state: "connecting" });
  readonly yield$ = new BehaviorSubject<{ requested: boolean; acknowledged?: boolean; latencyMs?: number; error?: string }>({ requested: true });
  readonly changes$ = new Subject<LibraryChangedEvent>();
  private readonly subscriptions = new Subscription();
  private connected = false;
  private disposed = false;
  // Startup remains the existing viewer. Library navigation explicitly changes this visibility.
  private viewer = true;
  private phase = "idle";
  private exporting = false;
  private leases = new Set<symbol>();
  private published?: boolean;
  private demandSequence = 0;
  private folderSequence = 0;
  private configuration: Promise<void> = Promise.resolve();
  private changedRevision=0;
  constructor(private readonly api: Transport) {
    const unsubscribe=api.onChanged?.(event=>{
      if(this.disposed||!event||typeof event!=="object"||Object.keys(event).some(key=>!["revision","ready","resourceRevision","resourceChanges","statusOnly"].includes(key))||!Number.isSafeInteger(event.revision)||
        event.revision<=this.changedRevision||typeof event.ready!=="boolean"||event.resourceRevision!==undefined&&
        (typeof event.resourceRevision!=="string"||!/^[a-zA-Z0-9_.:/+-]{1,128}$/.test(event.resourceRevision))||
        event.statusOnly!==undefined&&event.statusOnly!==true)return;
      const resourceChanges=event.resourceRevision===undefined?undefined:readLibraryResourceChanges(event.resourceChanges,event.resourceRevision);
      this.changedRevision=event.revision;this.changes$.next({revision:event.revision,ready:event.ready,...(event.resourceRevision!==undefined?{resourceRevision:event.resourceRevision}:{}),
        ...(resourceChanges?{resourceChanges}:{}),...(event.statusOnly?{statusOnly:true}:{})});
    });
    if(unsubscribe)this.subscriptions.add(unsubscribe);
  }
  connect(analyzer: AnalyzerSources): void {
    if (this.connected || this.disposed) return; this.connected = true;
    this.subscriptions.add(analyzer.scenarioManager.loadState$.subscribe(state => { this.phase = state.phase; this.publishDemand(); }));
    this.subscriptions.add(analyzer.clipRecorder.state$.subscribe(() => { this.exporting = analyzer.clipRecorder.isBusy; this.publishDemand(); }));
    this.subscriptions.add(analyzer.osuFolderService.settings$.subscribe(() => {
      const sequence = ++this.folderSequence, folder = analyzer.osuFolderService, directory = folder.getOsuFolder();
      this.configuration = (async () => {
        const songsRoot = await folder.whenReady();
        if (this.disposed || sequence !== this.folderSequence || directory !== folder.getOsuFolder()) return;
        this.connection$.next({ state: "connecting" });
        await this.api.request({ method: "configure", stable: directory ? { directory, songsRoot } : null });
        if (!this.disposed && sequence === this.folderSequence) this.connection$.next({ state: "ready" });
      })();
      void this.configuration.catch(error => { if (!this.disposed && sequence === this.folderSequence) this.error(error); });
    }));
  }
  private error(error: unknown): void {
    this.connection$.next({ state: "error", error: error instanceof Error ? error.message : "Library operation failed" });
  }
  setViewerVisible(visible: boolean): void { this.viewer = visible; this.publishDemand(); }
  acquireForeground(): () => void {
    const lease = Symbol(); this.leases.add(lease); this.publishDemand();
    return () => { if (this.leases.delete(lease)) this.publishDemand(); };
  }
  async foreground<T>(work: () => Promise<T>): Promise<T> {
    const release = this.acquireForeground();
    try { return await work(); } finally { release(); }
  }
  private publishDemand(): void {
    if (this.disposed) return;
    const active = this.phase === "loading" || this.exporting || this.leases.size > 0 || (this.viewer && this.phase === "ready");
    if (active === this.published) return;
    this.published = active; const sequence = ++this.demandSequence, started = performance.now();
    this.yield$.next({ requested: active });
    // invoke sends before the caller continues to foreground I/O. No library recovery/queue lock
    // is acquired here. Actual acknowledgement latency remains observable for integration QA.
    void this.api.demand(active).then(() => {
      if (!this.disposed && sequence === this.demandSequence) this.yield$.next({ requested: active, acknowledged: active, latencyMs: performance.now() - started });
    }).catch(error => {
      if (this.disposed) return; this.error(error);
      if (sequence === this.demandSequence) this.yield$.next({ requested: active, error: error instanceof Error ? error.message : "Library did not acknowledge viewer demand" });
    });
  }
  async whenReady(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error("Library client is closed");
    for (;;) {
      const current = this.configuration;
      try { await waitForConfiguration(current, signal); }
      catch (error) { signal?.throwIfAborted(); if (current === this.configuration) throw error; }
      if (current === this.configuration) break;
    }
    if (this.disposed) throw new Error("Library client is closed");
    signal?.throwIfAborted();
  }
  async request(input: LibraryRequest): Promise<unknown> {
    if (input.method !== "retry" && input.method !== "locate-lazer") await this.whenReady();
    if (this.disposed) throw new Error("Library client is closed");
    const sequence = this.folderSequence;
    try {
      const received = await this.api.request(input),result=input.method.startsWith("query-")?normalizeQueryResult(received):received;
      if (!this.disposed && sequence === this.folderSequence && (input.method === "retry" || (input.method === "locate-lazer" && typeof result === "string"))) {
        this.configuration = Promise.resolve(); this.published = undefined; this.publishDemand(); this.connection$.next({ state: "ready" });
      }
      return result;
    } catch (error) { if (!this.disposed && sequence === this.folderSequence && !(input.method.startsWith("query-")&&knownQueryError(error))) this.error(error); throw error; }
  }
  status(): Promise<LibraryStatus> { return this.request({ method: "status" }) as Promise<LibraryStatus>; }
  dispose(): void { this.disposed = true; this.folderSequence++; this.subscriptions.unsubscribe(); this.leases.clear(); this.changes$.complete(); }
}
