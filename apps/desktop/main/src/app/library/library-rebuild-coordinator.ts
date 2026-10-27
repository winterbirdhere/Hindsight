import type { LibraryMapObservation } from "../../../../shared/replay-library";
import { LibraryStore } from "./library-store";
import { LibraryActivityGate } from "./library-activity-gate";
import { indexedSourceMetadata, SourceScanAdapter } from "./library-scan-coordinator";
import type { ReplayFolderScanOptions } from "./sources/replays-folder-source";

type MapAdapter = (options: ReplayFolderScanOptions) => AsyncIterable<Omit<LibraryMapObservation, "sourceId" | "generation">>;
export interface LibraryRebuildStatus {
  state: "idle" | "queued" | "scanning" | "waiting-for-viewer" | "complete" | "stopped" | "error";
  observations: number; sourceId?: string; error?: string; mapErrors: Record<string, string>;
  publicationMs?: number;
}

/** Ordinary scans must be held by the service while busy. Scan iterators survive viewer yielding;
 * cancellation discards only staging. Final atomic publication is separately timed, not preemptible. */
export class LibraryRebuildCoordinator {
  private readonly gate = new LibraryActivityGate();
  private work?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  private demand = false;
  private current: LibraryRebuildStatus = { state: "idle", observations: 0, mapErrors: {} };
  constructor(private readonly store: LibraryStore, private readonly adapters: Readonly<Record<string, SourceScanAdapter>>,
    private readonly maps: Readonly<Record<string, MapAdapter>>, private readonly drainScans: () => Promise<void>) {}

  get busy(): boolean { return this.work !== undefined; }
  status(): LibraryRebuildStatus {
    return { ...this.current, mapErrors: { ...this.current.mapErrors },
      state: this.busy && this.demand ? "waiting-for-viewer" : this.current.state };
  }
  setViewerDemand(active: boolean): Promise<void> { this.demand = active; return this.gate.setDemand(active); }
  start(sourceIds: readonly string[]): void {
    if (this.closed) throw new Error("Library rebuild is closed");
    if (this.work) return;
    if (!sourceIds.length || sourceIds.length > 4 || new Set(sourceIds).size !== sourceIds.length ||
        sourceIds.some(id => !Object.prototype.hasOwnProperty.call(this.adapters, id))) throw new Error("Invalid rebuild sources");
    const controller = new AbortController(); this.controller = controller;
    this.current = { state: "queued", observations: 0, mapErrors: {} };
    // Defer the drain callback until work owns admission, including reentrant status observers.
    this.work = Promise.resolve().then(() => this.run([...sourceIds], controller.signal)).finally(() => { this.work = undefined; this.controller = undefined; });
  }
  private async run(sources: string[], signal: AbortSignal): Promise<void> {
    let run: string | undefined;
    try {
      await this.drainScans(); signal.throwIfAborted();
      await this.gate.run(async () => {
        run = this.store.beginRebuild(sources); this.current.state = "scanning";
        for (const sourceId of sources) {
          this.current.sourceId = sourceId;
          const options: ReplayFolderScanOptions = { signal, checkpoint: () => this.gate.checkpoint(signal),
            waitForNative:work=>this.gate.waitForExternal(work,signal),
            cached: async key => this.store.sourceObservation(sourceId, key) };
          let mapState: "complete" | "retain" = "retain";
          if (Object.prototype.hasOwnProperty.call(this.maps, sourceId)) {
            try {
              for await (const observation of this.maps[sourceId](options)) {
                await this.gate.checkpoint(signal); this.store.stageRebuildMap(run, { ...observation, sourceId });
              }
              mapState = "complete";
            } catch (error) {
              signal.throwIfAborted();
              this.current.mapErrors[sourceId] = (error instanceof Error ? error.message : "Map index failed").slice(0, 2048);
            }
          }
          for await (const observation of this.adapters[sourceId](options)) {
            await this.gate.checkpoint(signal);
            this.store.stageRebuildObservation(run, { ...observation, sourceId, addedAt: Date.now(), metadata: indexedSourceMetadata(observation.metadata) });
            this.current.observations++;
          }
          await this.gate.checkpoint(signal); this.store.finishRebuildSource(run, sourceId, mapState);
        }
        await this.gate.checkpoint(signal);
        const started = performance.now(); this.store.commitRebuild(run); this.current.publicationMs = performance.now() - started;
        run = undefined; this.current.state = "complete";
      }, signal);
    } catch (error) {
      this.current.state = signal.aborted ? "stopped" : "error";
      this.current.error = signal.aborted ? undefined : (error instanceof Error ? error.message : "Rebuild failed").slice(0, 2048);
    } finally {
      if (run) {
        try { this.store.abortRebuild(run); }
        catch (error) { this.current.state = "error"; this.current.error = "Rebuild cleanup failed: " + (error instanceof Error ? error.message : "unknown error"); }
      }
    }
  }
  stop(): void { this.controller?.abort(); }
  async idle(): Promise<void> { await this.work; }
  async close(): Promise<void> { this.closed = true; this.stop(); await this.idle(); }
}
