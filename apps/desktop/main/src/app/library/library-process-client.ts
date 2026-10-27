import type { LibraryServiceConfiguration } from "./library-service";
import type { LibraryMetricOperation } from "./library-metric-api";
import type { LibraryPassiveRequest,LibraryUserMetadataRequest,LibraryAnalysisRequest } from "../../../../shared/replay-library";
import { LIBRARY_QUERY_ERROR_CODES } from "../../../../shared/replay-library";
import type { LibraryChangedEvent } from "./library-utility-server";
import { readLibraryResourceChanges } from "../../../../shared/library-resource-changes";
import type { LibraryPreparationOperation } from "./library-preparation-api";
import { isAnalysisDirty } from "./library-analysis-dirty";
import { LibraryNativeBroker,LibraryNativeEndpoint } from "./library-native-admission";

export type LibraryOperation = LibraryPassiveRequest["method"] | LibraryUserMetadataRequest["method"] | LibraryAnalysisRequest["method"] | LibraryMetricOperation | LibraryPreparationOperation | "current-replay-bind" | "current-replay-store-publish" | "current-replay-store-release" | "incidents-probe-context" | "incidents-commit" | "incident-preparation-context" | "incident-preparation-commit" | "performance-context" | "performance-scalar-get" | "performance-scalar-put" | "performance-cache-get" | "performance-cache-put" | "performance-commit" | "analysis-eligible" | "analysis-resources-confirm" | "preparation-commit" | "status" | "scan" | "stop" | "source-enabled" | "import" | "rebuild" | "rebuild-stop" | "start-updates" | "update-mode" | "prepare-open" | "prepare-map" | "commit-open" | "resource-current";
interface ChildProcess {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; control: boolean }

/** App-session owner for one utility. It never restarts/replays uncertain mutations. Replacement
 * must construct a new owner only after close() observes the old process's actual exit. */
export class LibraryProcessClient<Operation extends string = LibraryOperation, Configuration = LibraryServiceConfiguration> {
  private child?: ChildProcess;
  private initialization?: Promise<unknown>;
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private admittedOrdinary = 0;
  private admittedControl = 0;
  private failed?: Error;
  private closing?: Promise<void>;
  private exited = false;
  private terminationRequested = false;
  private exitPromise?: Promise<void>;
  private onExit?: () => void;
  private viewerDemand = false;
  private demandWork?: Promise<void>;
  private demandGeneration = 0;
  private acknowledgedDemand?: boolean;
  private statusWork?: Promise<unknown>;
  private readonly stopWork = new Map<string, Promise<unknown>>();
  private dirtyRevision=0;
  private dirtyObserver?:(flags:number)=>void;
  private libraryRevision=0;
  private libraryObserver?:(event:LibraryChangedEvent)=>void;
  private native?:LibraryNativeEndpoint;
  private nativeHeld=false;
  onAnalysisDirty(observer:(flags:number)=>void):()=>void{this.dirtyObserver=observer;return()=>{if(this.dirtyObserver===observer)this.dirtyObserver=undefined;};}
  onLibraryChanged(observer:(event:LibraryChangedEvent)=>void):()=>void {
    this.libraryObserver=observer;return()=>{if(this.libraryObserver===observer)this.libraryObserver=undefined;};
  }

  constructor(private readonly spawn: () => ChildProcess, private readonly config: Configuration,
    private readonly options: { foreground?: boolean;nativeBroker?:LibraryNativeBroker;nativePriority?:"artwork" } = {}) {}

  start(): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closing) return Promise.reject(new Error("Library process is closed"));
    if (this.initialization) return this.initialization;
    try {
      this.child = this.spawn();
      this.native=this.options.nativeBroker?.attach(value=>{if(!this.child||this.exited)throw new Error("Native admission utility disconnected");this.child.postMessage(value);},this.options.nativePriority);
      void this.native?.setHeld(this.nativeHeld).catch(error=>this.fail(error));
      this.exitPromise = new Promise(resolve => { this.onExit = resolve; });
      this.child.on("message", value => this.receive(value));
      this.child.on("exit", code => {
        this.exited = true;
        this.native?.disconnected();
        this.fail(new Error(this.closing ? "Library process is closed" : `Library process stopped (${code}); retry explicitly`));
        this.onExit?.();
      });
      // Ordered before initialize, so even recovery begins under the current viewer lease.
      if (!this.options.foreground) void this.sendDemand(this.viewerDemand).catch(error => { if (!this.closing) this.fail(error); });
      this.initialization = this.send("initialize", this.config, true);
      // start can be owned by a demand/control caller before an ordinary request awaits it.
      void this.initialization.catch(() => undefined);
      return this.initialization;
    } catch (error) { this.fail(error instanceof Error ? error : new Error("Could not start library process")); return Promise.reject(this.failed); }
  }

  request(method: Operation, args: Record<string, unknown> = {}, assertCurrent?:()=>void): Promise<unknown> {
    if (["incidents-probe-context","incidents-commit","incident-preparation-context","incident-preparation-commit","probe-incident-evidence"].includes(method)) return Promise.reject(new Error("Incident analysis is retired"));
    if (this.failed) return Promise.reject(this.failed);
    if (this.closing) return Promise.reject(new Error("Library process is closed"));
    if(this.options.nativeBroker&&method==="control"){
      if(typeof args.viewerDemand!=="boolean"||typeof args.userPaused!=="boolean")return Promise.reject(new Error("Invalid native controls"));
      this.nativeHeld=args.viewerDemand||args.userPaused;
    }
    if (method === "status" && this.statusWork) return this.statusWork;
    const coalescedControl = method === "stop" || method === "rebuild-stop" || (this.options.foreground === true && method === "release");
    const control = coalescedControl || (this.options.foreground === true && method === "control") ||
      ["current-replay-bind","current-replay-store-publish","current-replay-store-release","analysis-settings","query-snapshot-release","metric-settings", "metric-release", "metric-commit", "metric-numerical-handoff", "metric-timeline-handoff", "metric-fc-handoff", "metric-fail", "preparation-release", "preparation-commit", "performance-commit", "preparation-fail", "analysis-resources-confirm"].includes(method);
    const stopKey = method === "release" ? "session:" + String(args.sessionId) : method === "rebuild-stop" ? "rebuild-stop" : "source:" + String(args.sourceId);
    const existingStop = coalescedControl ? this.stopWork.get(stopKey) : undefined;
    if (existingStop) return existingStop;
    if (control && this.admittedControl >= 16) return Promise.reject(new Error("Library control queue is busy"));
    if (!control && this.admittedOrdinary >= 32) return Promise.reject(new Error("Library request queue is busy"));
    if (control) this.admittedControl++; else this.admittedOrdinary++;
    const nativeHold=method==="control"?this.native?.setHeld(this.nativeHeld):undefined;
    const work = this.start().then(async() => {
      const outcomes=await Promise.all([this.send(method,args,control,assertCurrent),nativeHold,method==="control"?this.native?.setHeld(this.nativeHeld):undefined]);return outcomes[0];
    }).finally(() => { if (control) this.admittedControl--; else this.admittedOrdinary--; });
    if (method === "status") {
      this.statusWork = work;
      void work.finally(() => { if (this.statusWork === work) this.statusWork = undefined; }).catch(() => undefined);
    }
    if (coalescedControl) {
      this.stopWork.set(stopKey, work);
      void work.finally(() => { if (this.stopWork.get(stopKey) === work) this.stopWork.delete(stopKey); }).catch(() => undefined);
    }
    return work;
  }

  setViewerDemand(active: boolean): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closing) return Promise.reject(new Error("Library process is closed"));
    if (this.options.foreground) return Promise.resolve();
    this.nativeHeld=active;const nativeHold=this.native?.setHeld(active);
    this.viewerDemand = active;
    if (!this.child) return Promise.resolve();
    return Promise.all([this.sendDemand(active),nativeHold]).then(()=>undefined);
  }
  private sendDemand(active: boolean): Promise<void> {
    this.viewerDemand = active;
    if (this.demandWork) return this.demandWork;
    const generation = ++this.demandGeneration;
    const work = (async () => {
      try {
        do {
          if (this.closing) throw new Error("Library process is closed");
          const requested = this.viewerDemand;
          await this.send("viewer-demand", { active: requested }, true);
          this.acknowledgedDemand = requested;
        } while (this.acknowledgedDemand !== this.viewerDemand);
      } finally {
        // Clear before this promise settles; a queued change must not inherit an already-finished pump.
        if (this.demandGeneration === generation) this.demandWork = undefined;
      }
    })();
    this.demandWork = work;
    return work;
  }
  private send(method: string, args: unknown, control: boolean, assertCurrent?:()=>void): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const child = this.child;
    if (!child || this.exited || (this.closing && method !== "close")) return Promise.reject(new Error("Library process is closed"));
    const ordinary = [...this.pending.values()].filter(item => !item.control).length;
    if (this.pending.size >= (method === "close" ? 64 : 63) || (!control && ordinary >= 32)) return Promise.reject(new Error("Library request queue is busy"));
    const id = String(++this.sequence), request = { version: 1, id, method, args };
    if (Buffer.byteLength(JSON.stringify(request)) > 2 * 1024 * 1024) return Promise.reject(new Error("Library request exceeds message limit"));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, control });
      // No await separates document/capability validation from the actual irreversible post.
      try { assertCurrent?.();child.postMessage(request); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  private receive(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if("event" in value){
      if(value.event==="library-changed"){
        const event=value as Partial<LibraryChangedEvent>;
        if(this.closing||this.options.foreground||Object.keys(value).some(key=>!["version","event","revision","ready","resourceRevision","resourceChanges","statusOnly"].includes(key))||event.version!==1||
          !Number.isSafeInteger(event.revision)||Number(event.revision)<=this.libraryRevision||typeof event.ready!=="boolean"||
          event.resourceRevision!==undefined&&(typeof event.resourceRevision!=="string"||!/^[a-zA-Z0-9_.:/+-]{1,128}$/.test(event.resourceRevision))||event.statusOnly!==undefined&&event.statusOnly!==true)return;
        this.libraryRevision=Number(event.revision);
        const resourceChanges=event.resourceRevision===undefined?undefined:readLibraryResourceChanges(event.resourceChanges,event.resourceRevision);
        try{this.libraryObserver?.({version:1,event:"library-changed",revision:this.libraryRevision,ready:event.ready,...(event.resourceRevision!==undefined?{resourceRevision:event.resourceRevision}:{}),
          ...(resourceChanges?{resourceChanges}:{}),...(event.statusOnly?{statusOnly:true}:{})});}
        catch(error){this.fail(error instanceof Error?error:new Error("Library change notification failed"));this.terminate();}return;
      }
      if(typeof value.event==="string"&&value.event.startsWith("native-")){
        if(this.native){
          try{this.native.receive(value);const error=this.options.nativeBroker?.status().error;if(error)throw new Error(error);}
          catch(error){this.fail(error instanceof Error?error:new Error("Native admission transport failed"));this.terminate();}return;
        }
        this.fail(new Error("Unexpected native admission notification"));this.terminate();return;
      }
      if(this.closing)return;
      if(this.options.foreground||!isAnalysisDirty(value)||value.revision>this.dirtyRevision+1){this.fail(new Error("Invalid library notification protocol"));this.terminate();return;}
      if(value.revision<=this.dirtyRevision)return;
      this.dirtyRevision=value.revision;
      try{this.dirtyObserver?.(value.flags);}catch(error){this.fail(error instanceof Error?error:new Error("Library notification failed"));this.terminate();return;}
      void this.send("analysis-dirty-ack",{revision:value.revision},true).catch(error=>{if(!this.closing){this.fail(error);this.terminate();}});return;
    }
    const response = value as { version?: unknown; id?: unknown; ok?: unknown; data?: unknown; error?: unknown;errorCode?:unknown };
    if (typeof response.id !== "string" || !this.pending.has(response.id)) return;
    let valid = false;
    try {
      const data = response.data as { bytes?: unknown; done?: unknown } | undefined;
      const binary = this.options.foreground && data?.bytes instanceof Uint8Array;
      valid = response.version === 1 && typeof response.ok === "boolean" && (binary
        ? response.ok && typeof data?.done === "boolean" && (data.bytes as Uint8Array).byteLength <= 256 * 1024 &&
          (data.bytes as Uint8Array).buffer.byteLength <= 256 * 1024 && Object.keys(data).every(key => key === "bytes" || key === "done") &&
          Object.keys(response).every(key => ["version", "id", "ok", "data"].includes(key))
        : Buffer.byteLength(JSON.stringify(value)) <= 2 * 1024 * 1024);
    } catch { /* Invalid protocol data. */ }
    if (!valid) { this.fail(new Error("Invalid library response protocol")); this.terminate(); return; }
    const pending = this.pending.get(response.id); if (!pending) return; this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.data);
    else {
      const error=new Error(typeof response.error === "string" ? response.error.slice(0, 2048) : "Library operation failed");
      if(typeof response.errorCode==="string"&&(LIBRARY_QUERY_ERROR_CODES as readonly string[]).includes(response.errorCode))
        Object.assign(error,{code:response.errorCode});
      pending.reject(error);
    }
  }
  private fail(error: Error): void {
    this.failed ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failed);
    this.pending.clear();
  }
  private terminate(): void {
    if (!this.child || this.exited || this.terminationRequested) return;
    this.terminationRequested = true; this.child.kill();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.child || this.exited) return this.closing = Promise.resolve();
    // Reserve the final slot for shutdown even when ordinary controls are saturated.
    const acknowledgement = this.failed ? Promise.resolve() : this.send("close", {}, true);
    this.closing = (async () => {
      let shutdownError: Error | undefined;
      const deadline = setTimeout(() => {
        shutdownError = new Error("Library shutdown timed out"); this.fail(shutdownError); this.terminate();
      }, 5000);
      try {
        try { await acknowledgement; } catch (error) { shutdownError ??= error instanceof Error ? error : new Error("Library shutdown failed"); }
        this.terminate();
        await this.exitPromise;
        if (shutdownError) throw shutdownError;
      } finally { clearTimeout(deadline); }
    })();
    return this.closing;
  }
}
