import { setImmediate } from "timers/promises";
import { LibraryStore } from "./library-store";
import { LibrarySourceScanError, SourceScanFailureReason } from "./library-source-state";
import type { FileSourceObservation, ReplayFolderScanOptions } from "./sources/replays-folder-source";
import type { LibrarySourceScanProgress } from "../../../../shared/replay-library";
import type { LibraryResourceScanIntent } from "./library-update-policy";

export type SourceScanState = "idle" | "queued" | "scanning" | "waiting-for-viewer" | "stopped" | "complete" | "error";
export interface SourceScanStatus { sourceId: string; state: SourceScanState; observations: number; progress?: LibrarySourceScanProgress; error?: string; failureReason?: SourceScanFailureReason }
export interface SourceScanOptions extends ReplayFolderScanOptions { resourceIntent?: LibraryResourceScanIntent }
export type SourceScanAdapter = (options: SourceScanOptions) => AsyncIterable<FileSourceObservation>;
interface ScanTask { controller: AbortController; dirty: boolean; done: Promise<void>; resourceIntent: LibraryResourceScanIntent; generation?: string; cleanupError?: string; lastProgressAt?: number }

function boundedValidationEnvelope(metadata: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const envelope: Record<string, unknown> = {};
  const stamp = metadata.stamp as Record<string, unknown> | undefined;
  if (stamp && Number.isSafeInteger(stamp.bytes) && (stamp.bytes as number) >= 0 && (stamp.bytes as number) <= 512 * 1024 * 1024 &&
      ["device", "inode", "modifiedNs", "changedNs"].every(key => typeof stamp[key] === "string" && /^-?\d{1,32}$/.test(stamp[key] as string))) {
    envelope.stamp = { bytes: stamp.bytes, device: stamp.device, inode: stamp.inode, modifiedNs: stamp.modifiedNs, changedNs: stamp.changedNs };
  }
  const md5 = (metadata.header as { beatmapMD5?: unknown } | undefined)?.beatmapMD5;
  if (typeof md5 === "string" && /^[a-f0-9]{32}$/.test(md5)) envelope.header = { beatmapMD5: md5 };
  if (metadata.validation === "header-only") envelope.validation = "header-only";
  return envelope;
}

export function indexedSourceMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Buffer.byteLength(JSON.stringify(metadata)) <= 64 * 1024 ? metadata : {
    ...boundedValidationEnvelope(metadata),
    fileState: typeof metadata.fileState === "string" ? metadata.fileState.slice(0, 128) : "unknown",
    metadataState: "resource-limit", reason: "Source metadata exceeds the index record limit; fresh resource resolution is required",
  };
}

/** Serial metadata admission. Viewer yielding retains the iterator; Stop invalidates its generation. */
export class LibraryScanCoordinator {
  private readonly tasks = new Map<string, ScanTask>();
  private readonly states = new Map<string, SourceScanStatus>();
  private tail: Promise<void> = Promise.resolve();
  private active?: string;
  private viewerDemand = false;
  private waitingExternal=false;
  private closed = false;
  private readonly cleanupErrors = new Set<string>();
  private wake?: () => void;
  private acknowledgements: (() => void)[] = [];

  constructor(private readonly store: LibraryStore, private readonly adapters: Readonly<Record<string, SourceScanAdapter>>,
    private readonly onStatus: (status: SourceScanStatus, statusOnly?: true) => void = () => undefined) {}

  status(sourceId: string): SourceScanStatus {
    const value: SourceScanStatus = this.states.get(sourceId) ?? { sourceId, state: "idle", observations: 0 };
    return { ...value, ...(value.progress ? { progress: { ...value.progress } } : {}) };
  }
  private progress(sourceId: string, task: ScanTask, value: LibrarySourceScanProgress): void {
    if (this.closed || this.tasks.get(sourceId) !== task || task.controller.signal.aborted) return;
    if (!["reading-map-metadata", "checking-replays", "committing"].includes(value.phase) ||
        !["map-records", "replay-observations", "source-records"].includes(value.unit) ||
        !Number.isSafeInteger(value.completed) || value.completed < 0 ||
        value.total !== undefined && (!Number.isSafeInteger(value.total) || value.total < value.completed))
      throw new Error("Invalid source scan progress");
    const status = this.status(sourceId), previous = status.progress;
    const transition = previous?.phase !== value.phase || previous?.unit !== value.unit;
    if (!transition && previous && value.completed < previous.completed) throw new Error("Source scan progress moved backwards");
    if (previous && !transition && previous.completed === value.completed && previous.total === value.total) return;
    const progress = { phase: value.phase, completed: value.completed, unit: value.unit,
      ...(value.total !== undefined ? { total: value.total } : {}) };
    this.states.set(sourceId, { ...status, progress });
    const now = Date.now();
    // No timer or polling owner: the existing producer/checkpoint cadence publishes
    // at most four same-phase updates/second; status() always has the actual count.
    if (transition || task.lastProgressAt === undefined || now - task.lastProgressAt >= 250) {
      task.lastProgressAt = now;
      try { this.onStatus(this.status(sourceId), true); } catch { /* Observer does not own the scan. */ }
    }
  }
  private update(sourceId: string, state: SourceScanState, error?: string, failureReason?: SourceScanFailureReason): void {
    const status = { ...this.status(sourceId), state, error, failureReason };
    this.states.set(sourceId, status);
    // A disconnected observer must not own or poison the source queue.
    try { this.onStatus({ ...status }); } catch { /* State remains available through status(). */ }
  }
  private acknowledge(): void { for (const done of this.acknowledgements.splice(0)) done(); }

  setViewerDemand(demand: boolean): Promise<void> {
    this.viewerDemand = demand;
    // Native admission can remain pending while viewer demand changes.
    // Keep its label current without restarting work or reviving a stopping scan.
    if (this.active && this.waitingExternal && !this.closed && !this.tasks.get(this.active)?.controller.signal.aborted)
      this.update(this.active, demand ? "waiting-for-viewer" : "scanning");
    if (!demand) { this.wake?.(); this.acknowledge(); return Promise.resolve(); }
    if (!this.active || this.waitingExternal || this.status(this.active).state === "waiting-for-viewer") return Promise.resolve();
    return new Promise(resolve => this.acknowledgements.push(resolve));
  }

  private async checkpoint(sourceId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await setImmediate();
    while (this.viewerDemand) {
      signal.throwIfAborted();
      this.update(sourceId, "waiting-for-viewer");
      this.acknowledge();
      await new Promise<void>(resolve => {
        const resume = () => { signal.removeEventListener("abort", resume); if (this.wake === resume) this.wake = undefined; resolve(); };
        this.wake = resume;
        signal.addEventListener("abort", resume, { once: true });
        if (signal.aborted || !this.viewerDemand) resume();
      });
    }
    signal.throwIfAborted();
    if (this.status(sourceId).state !== "scanning") this.update(sourceId, "scanning");
  }
  private async waitForNative<T>(sourceId:string,signal:AbortSignal,work:Promise<T>):Promise<T>{
    if(this.waitingExternal)throw new Error("Overlapping native admission wait");this.waitingExternal=true;
    if(this.viewerDemand){this.update(sourceId,"waiting-for-viewer");this.acknowledge();}
    let result:T;try{result=await work;}finally{this.waitingExternal=false;}await this.checkpoint(sourceId,signal);return result;
  }

  scan(sourceId: string, resourceIntent: LibraryResourceScanIntent = "refresh"): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Library scan coordinator is closed"));
    resourceIntent = resourceIntent === "check" ? "check" : "refresh";
    const existing = this.tasks.get(sourceId);
    if (existing) {
      if (resourceIntent === "refresh" && existing.resourceIntent === "check") existing.dirty = true;
      return existing.done;
    }
    if (!Object.prototype.hasOwnProperty.call(this.adapters, sourceId)) return Promise.reject(new Error("Unknown library source"));
    const task: ScanTask = { controller: new AbortController(), dirty: false, done: Promise.resolve(), resourceIntent };
    this.states.set(sourceId, { sourceId, state: "queued", observations: 0 });
    this.tasks.set(sourceId, task);
    task.done = this.tail.then(async () => {
      this.active = sourceId;
      const signal = task.controller.signal;
      let complete = false;
      try {
        await this.checkpoint(sourceId, signal);
        task.generation = this.store.beginScan(sourceId);
        this.progress(sourceId, task, { phase: "checking-replays", completed: 0, unit: "replay-observations" });
        for await (const row of this.adapters[sourceId]({ signal, resourceIntent, checkpoint: () => this.checkpoint(sourceId, signal),
          waitForNative:work=>this.waitForNative(sourceId,signal,work),
          onProgress: value => this.progress(sourceId, task, value),
          cached: async key => this.store.sourceObservation(sourceId, key) })) {
          await this.checkpoint(sourceId, signal);
          // A valid resource can have unusually large source JSON/header strings. Keep the
          // identity/openability, explicitly omit the whole over-budget projection, and continue
          // later records. Never truncate mod settings into different playable semantics.
          const metadata = indexedSourceMetadata(row.metadata);
          this.store.upsertObservation({ ...row, metadata, sourceId, generation: task.generation, addedAt: Date.now() });
          const previous = this.status(sourceId);
          this.states.set(sourceId, { ...previous, observations: previous.observations + 1 });
          if (previous.progress?.unit !== "source-records") this.progress(sourceId, task,
            { phase: "checking-replays", completed: previous.observations + 1, unit: "replay-observations" });
        }
        await this.checkpoint(sourceId, signal);
        const progress = this.status(sourceId).progress;
        if (progress) this.progress(sourceId, task, { ...progress, phase: "committing" });
        this.store.finishScan(sourceId, task.generation);
        complete = true;
        this.update(sourceId, "complete");
      } catch (error) {
        this.invalidate(sourceId, task);
        this.update(sourceId, signal.aborted && !task.cleanupError ? "stopped" : "error",
          task.cleanupError ?? (signal.aborted ? undefined : error instanceof Error ? error.message : "Source scan failed"),
          !signal.aborted && !task.cleanupError && error instanceof LibrarySourceScanError ? error.failureReason : undefined);
      } finally {
        this.active = undefined; this.tasks.delete(sourceId); this.acknowledge();
        // Changes coalesce once after success. A failed source requires a later event/manual retry,
        // never an immediate page-zero restart loop.
        if (complete && task.dirty && !this.closed) void this.scan(sourceId);
      }
    });
    // Preserve task rejection for its caller while allowing later independent sources to run.
    this.tail = task.done.catch(() => undefined);
    this.update(sourceId, "queued");
    return task.done;
  }

  markDirty(sourceId: string): void {
    if (this.closed || !Object.prototype.hasOwnProperty.call(this.adapters, sourceId)) return;
    const task = this.tasks.get(sourceId);
    if (task) task.dirty = true;
    else void this.scan(sourceId);
  }
  stop(sourceId: string): void {
    const task = this.tasks.get(sourceId);
    if (!task) return;
    task.dirty = false; task.controller.abort();
    this.invalidate(sourceId, task);
  }
  private invalidate(sourceId: string, task: ScanTask): void {
    if (!task.generation) return;
    try { this.store.stopScan(sourceId, task.generation); }
    catch (error) {
      task.cleanupError = "Source cleanup failed: " + (error instanceof Error ? error.message : "unknown database error");
      this.cleanupErrors.add(task.cleanupError);
    }
  }
  async idle(): Promise<void> {
    for (;;) { const current = this.tail; await current; if (current === this.tail) return; }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const sourceId of this.tasks.keys()) this.stop(sourceId);
    await this.idle();
    if (this.cleanupErrors.size) throw new Error([...this.cleanupErrors].join("; "));
  }
}
