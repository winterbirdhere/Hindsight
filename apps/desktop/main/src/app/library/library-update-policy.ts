import type { LibraryUpdateMode } from "../../../../shared/replay-library";

export type LibraryResourceScanIntent = "check" | "refresh";
type ScanRequest = "launch" | "manual";
interface SourceRun { done: Promise<void>; epoch: number; request?: ScanRequest; yielded: boolean }
interface SourceState {
  observed: number; covered: number; blocked: number; stopped: boolean; request?: ScanRequest;
  refreshObserved: number;
  epoch: number; running?: SourceRun; timer?: ReturnType<typeof setTimeout>; scheduled?: Promise<void>; timerDone?: () => void;
  unwatch?: () => void; watchError?: string;
}
export interface LibraryUpdateDependencies {
  enabled(id: string): boolean;
  held(): boolean;
  scan(id: string, resourceIntent: LibraryResourceScanIntent): Promise<boolean>;
  stop(id: string): void;
  watch(id: string, changed: () => void, failed: (error: Error) => void): () => void;
  saveMode(mode: LibraryUpdateMode): void;
  claimLaunch(id: string): boolean;
}

/** One follow-up owner, bounded to four source records. Watch callbacks only advance a revision;
 * failure/Stop cannot trigger self-retry loops. Viewer yielding belongs to the scan coordinator. */
export class LibraryUpdatePolicy {
  private readonly states = new Map<string, SourceState>();
  private started = false;
  private closed = false;
  private selectedMode: LibraryUpdateMode;
  constructor(ids: readonly string[], mode: LibraryUpdateMode, private readonly deps: LibraryUpdateDependencies) {
    if (ids.length > 4 || new Set(ids).size !== ids.length || !["auto", "launch", "manual"].includes(mode)) throw new Error("Invalid source update policy");
    this.selectedMode = mode;
    for (const id of ids) this.states.set(id, { observed: 0, covered: 0, blocked: 0, stopped: false, refreshObserved: 0, epoch: 0 });
  }
  get mode(): LibraryUpdateMode { return this.selectedMode; }
  private source(id: string): SourceState { const state = this.states.get(id); if (!state) throw new Error("Unknown update source"); return state; }
  status(id: string) { const state = this.source(id); return { pending: state.observed > state.covered, active: !!(state.timer || state.running), stopped: state.stopped, watchError: state.watchError }; }
  start(): void {
    if (this.closed || this.started) return;
    this.started = true; for (const id of this.states.keys()) this.activate(id, true);
  }
  setMode(mode: LibraryUpdateMode): void {
    if (this.closed || !["auto", "launch", "manual"].includes(mode)) throw new Error("Invalid source update mode");
    if (mode === this.selectedMode) return;
    this.deps.saveMode(mode); this.selectedMode = mode;
    for (const [id, state] of this.states) {
      this.detach(state); this.deps.stop(id); state.stopped = false; state.request = undefined;
      if (this.started) this.activate(id);
    }
  }
  private detach(state: SourceState): void {
    state.epoch++; this.clearTimer(state);
    const unwatch = state.unwatch; state.unwatch = undefined;
    try { unwatch?.(); } catch (error) { state.watchError = error instanceof Error ? error.message : "Could not close source watcher"; }
  }
  private clearTimer(state: SourceState): void {
    if (state.timer) clearTimeout(state.timer); state.timer = undefined;
    state.timerDone?.(); state.timerDone = undefined; state.scheduled = undefined;
  }
  private activate(id: string, launch = false): void {
    const state = this.source(id); if (!this.deps.enabled(id)) return;
    if (this.selectedMode === "auto") {
      this.watch(id); this.deps.claimLaunch(id); state.observed++; state.blocked = -1;
      if (!launch || state.watchError) state.refreshObserved = state.observed;
      this.schedule(id);
    } else if (this.selectedMode === "launch" && launch && this.deps.claimLaunch(id)) {
      state.observed++; state.request ??= "launch"; this.schedule(id);
    }
  }
  private watch(id: string): void {
    const state = this.source(id), epoch = state.epoch;
    const valid = () => !this.closed && state.epoch === epoch && this.selectedMode === "auto" && this.deps.enabled(id);
    try {
      state.watchError = undefined;
      state.unwatch = this.deps.watch(id, () => { if (valid()) { state.refreshObserved = ++state.observed; this.schedule(id); } }, error => {
        if (valid()) { state.watchError = error.message.slice(0, 2048); state.refreshObserved = ++state.observed; }
      });
    } catch (error) { state.watchError = (error instanceof Error ? error.message : "Source watcher unavailable").slice(0, 2048); }
  }
  private schedule(id: string): void {
    const state = this.source(id);
    if (this.closed || (!this.started && !state.request) || state.stopped || state.running || state.timer || !this.deps.enabled(id) || this.deps.held()) return;
    if (!state.request && (this.selectedMode !== "auto" || state.observed <= Math.max(state.covered, state.blocked))) return;
    state.scheduled = new Promise(resolve => { state.timerDone = resolve; });
    state.timer = setTimeout(() => { this.clearTimer(state); this.run(id); }, 300);
  }
  private run(id: string): void {
    const state = this.source(id);
    if (this.closed || state.stopped || state.running || !this.deps.enabled(id) || this.deps.held()) return;
    const observed = state.observed;
    const run: SourceRun = { done: Promise.resolve(), epoch: state.epoch, request: state.request, yielded: false };
    state.running = run; state.request = undefined;
    run.done = Promise.resolve().then(() => {
      if (this.closed || state.stopped || run.yielded || state.epoch !== run.epoch || !this.deps.enabled(id)) return;
      if (this.deps.held()) { state.request ??= run.request; return; }
      return this.deps.scan(id, state.refreshObserved > state.covered ? "refresh" : "check");
    }).then(success => {
      if (state.epoch !== run.epoch || run.yielded || success === undefined) return;
      if (success) state.covered = Math.max(state.covered, observed);
      else state.blocked = state.observed;
    }, () => { if (state.epoch === run.epoch && !run.yielded) state.blocked = state.observed; }).finally(() => {
      state.running = undefined; this.schedule(id);
    });
  }
  scanNow(id: string): void {
    if (this.closed) throw new Error("Source update policy is closed");
    const state = this.source(id); state.stopped = false; state.request = "manual"; state.refreshObserved = ++state.observed;
    this.clearTimer(state); this.run(id);
  }
  stop(id: string): void {
    const state = this.source(id); state.stopped = true; state.request = undefined;
    this.clearTimer(state); this.deps.stop(id);
  }
  sourceChanged(id: string): void {
    if (this.closed) return;
    const state = this.source(id); this.detach(state); this.deps.stop(id); state.stopped = false; state.request = undefined;
    if (this.started) this.activate(id);
  }
  resumePending(): void { for (const id of this.states.keys()) this.schedule(id); }
  get hasManualScan(): boolean {
    return [...this.states.values()].some(state => state.request === "manual" || state.running?.request === "manual");
  }
  /** Called under the service's deletion hold. Watchers keep recording revisions while
   * cancellation drains. User Stop, mode changes and close can still discard a launch request. */
  async yieldBackgroundScans(): Promise<void> {
    for (const [id, state] of this.states) {
      this.clearTimer(state);
      const run = state.running;
      if (!run) continue;
      run.yielded = true;
      if (run.request === "launch" && state.epoch === run.epoch && !state.stopped) state.request ??= "launch";
      this.deps.stop(id);
    }
    await this.idle();
  }
  async idle(): Promise<void> {
    for (;;) {
      const work = [...this.states.values()].flatMap(state => [state.scheduled, state.running?.done].filter((value): value is Promise<void> => !!value));
      if (!work.length) return; await Promise.all(work);
    }
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const [id, state] of this.states) { this.detach(state); this.deps.stop(id); }
  }
}
