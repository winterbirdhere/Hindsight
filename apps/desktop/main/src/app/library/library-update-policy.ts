import type { LibraryUpdateMode } from "../../../../shared/replay-library";

export type LibraryResourceScanIntent = "check" | "refresh";
interface SourceState {
  observed: number; covered: number; blocked: number; stopped: boolean; explicit: boolean;
  refreshObserved: number;
  epoch: number; running?: Promise<void>; timer?: ReturnType<typeof setTimeout>; scheduled?: Promise<void>; timerDone?: () => void;
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
    for (const id of ids) this.states.set(id, { observed: 0, covered: 0, blocked: 0, stopped: false, explicit: false, refreshObserved: 0, epoch: 0 });
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
      this.detach(state); this.deps.stop(id); state.stopped = false; state.explicit = false;
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
      state.observed++; state.explicit = true; this.schedule(id);
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
    if (this.closed || (!this.started && !state.explicit) || state.stopped || state.running || state.timer || !this.deps.enabled(id) || this.deps.held()) return;
    if (!state.explicit && (this.selectedMode !== "auto" || state.observed <= Math.max(state.covered, state.blocked))) return;
    state.scheduled = new Promise(resolve => { state.timerDone = resolve; });
    state.timer = setTimeout(() => { this.clearTimer(state); this.run(id); }, 300);
  }
  private run(id: string): void {
    const state = this.source(id);
    if (this.closed || state.stopped || state.running || !this.deps.enabled(id) || this.deps.held()) return;
    const observed = state.observed, epoch = state.epoch, explicit = state.explicit; state.explicit = false;
    state.running = Promise.resolve().then(() => {
      if (this.closed || state.stopped || state.epoch !== epoch || !this.deps.enabled(id)) return;
      if (this.deps.held()) { state.explicit ||= explicit; return; }
      // Resource intent is separate from scheduling's explicit bit (also used by On launch).
      // A later uncertain event survives completion of this run's captured observation.
      return this.deps.scan(id, state.refreshObserved > state.covered ? "refresh" : "check");
    }).then(success => {
      if (state.epoch !== epoch || success === undefined) return;
      if (success) state.covered = Math.max(state.covered, observed);
      else state.blocked = state.observed;
    }, () => { if (state.epoch === epoch) state.blocked = state.observed; }).finally(() => {
      state.running = undefined; this.schedule(id);
    });
  }
  scanNow(id: string): void {
    if (this.closed) throw new Error("Source update policy is closed");
    const state = this.source(id); state.stopped = false; state.explicit = true; state.refreshObserved = ++state.observed;
    this.clearTimer(state); this.run(id);
  }
  stop(id: string): void {
    const state = this.source(id); state.stopped = true; state.explicit = false;
    this.clearTimer(state); this.deps.stop(id);
  }
  sourceChanged(id: string): void {
    if (this.closed) return;
    const state = this.source(id); this.detach(state); this.deps.stop(id); state.stopped = false; state.explicit = false;
    if (this.started) this.activate(id);
  }
  resumePending(): void { for (const id of this.states.keys()) this.schedule(id); }
  async idle(): Promise<void> {
    for (;;) {
      const work = [...this.states.values()].flatMap(state => [state.scheduled, state.running].filter((value): value is Promise<void> => !!value));
      if (!work.length) return; await Promise.all(work);
    }
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const [id, state] of this.states) { this.detach(state); this.deps.stop(id); }
  }
}
