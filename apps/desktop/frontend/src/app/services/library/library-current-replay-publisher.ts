import type { Observable, Subscription } from "rxjs";
import type { PerformanceMode } from "@rewind/osu-performance/types";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../../shared/library-analysis";
import { isLibraryCurrentReplayReceipt } from "../../../../../shared/library-current-replay";
import type { LibraryCurrentReplayReceipt, LibraryCurrentReplayRequest, LibraryCurrentReplayResult,
  LibraryCurrentReplaySlot } from "../../../../../shared/library-current-replay";
import { isCurrentReplayReuseBinding, projectCurrentReplayResults } from "./library-current-replay";
import type { CurrentReplayCaptureContext, CurrentReplayPerformanceSnapshot, CurrentReplayProjectedNumericalSnapshot,
  CurrentReplayReuseBinding } from "./library-current-replay";

interface Dependencies {
  simulator: {
    isLibraryReplayCurrent(context: CurrentReplayCaptureContext): boolean;
    captureLibraryNumerical(context: CurrentReplayCaptureContext, checkpoint: () => Promise<void>): Promise<CurrentReplayProjectedNumericalSnapshot>;
  };
  performance: { changed$: Observable<number>; captureLibraryPerformance(context: CurrentReplayCaptureContext): CurrentReplayPerformanceSnapshot | undefined };
  request(request: LibraryCurrentReplayRequest): Promise<unknown>;
  checkpoint?: () => Promise<void>;
  onError?: (error: unknown) => void;
}
interface Active {
  receipt: LibraryCurrentReplayReceipt;
  context: CurrentReplayCaptureContext;
  numerical?: CurrentReplayProjectedNumericalSnapshot;
  sent: Map<LibraryCurrentReplaySlot, string>;
  dirty: boolean;
  working: boolean;
  stopped: boolean;
}

/** Only main-issued byte/profile identity is combined with the actually prepared recording map. */
export function currentReplayBinding(receipt: LibraryCurrentReplayReceipt, mode: PerformanceMode,
  clockRate: number, objectCount: number): CurrentReplayReuseBinding | undefined {
  if (!isLibraryCurrentReplayReceipt(receipt) || receipt.numericalVersion !== LIBRARY_NUMERIC_PROJECTION_VERSION) return undefined;
  const binding = { replaySha256: receipt.replaySha256, mapSha256: receipt.mapSha256, mapMd5: receipt.mapMd5,
    numericalInputKey: receipt.numericalInputKey, parserVersion: receipt.parserVersion, preparationVersion: receipt.preparationVersion,
    mode, clockRate, objectCount };
  return isCurrentReplayReuseBinding(binding) ? binding : undefined;
}

/** Detached observation of an already completed viewer generation. It never loads resources,
 * claims jobs, runs a simulation, waits for performance, or cancels viewer work. */
export class LibraryCurrentReplayPublisher {
  private active?: Active;
  private readonly subscription: Subscription;
  private disposed = false;
  constructor(private readonly dependencies: Dependencies) {
    this.subscription = dependencies.performance.changed$.subscribe(() => {
      const active = this.active;
      if (active && !active.stopped) { active.dirty = true; this.pump(active); }
    });
  }
  attach(receipt: LibraryCurrentReplayReceipt, context: CurrentReplayCaptureContext): void {
    if (this.disposed) return;
    if (this.active?.context === context && this.active.receipt.token === receipt.token) return;
    this.clear();
    const expected = currentReplayBinding(receipt, context.binding.mode, context.binding.clockRate, context.binding.objectCount);
    if (!expected || Object.keys(expected).some(key => expected[key as keyof CurrentReplayReuseBinding] !== context.binding[key as keyof CurrentReplayReuseBinding]) ||
      !this.dependencies.simulator.isLibraryReplayCurrent(context)) return;
    const active: Active = { receipt: { ...receipt }, context, sent: new Map(), dirty: true, working: false, stopped: false };
    this.active = active; this.pump(active);
  }
  clear(): void {
    const active = this.active; this.active = undefined;
    if (!active) return;
    active.stopped = true;
    this.release(active.receipt.token);
  }
  /** A verified resource may fail or be superseded before there is a completed viewer context. */
  discard(receipt: LibraryCurrentReplayReceipt): void {
    if (!isLibraryCurrentReplayReceipt(receipt)) return;
    if (this.active?.receipt.token === receipt.token) this.clear();
    else this.release(receipt.token);
  }
  private release(token: string): void {
    // Revocation is independent of resource transfer lifetime, capture and viewer cancellation.
    void Promise.resolve().then(() => this.dependencies.request({ method: "current-replay-release", token }))
      .catch(error => this.report(error));
  }
  dispose(): void { this.disposed = true; this.clear(); this.subscription.unsubscribe(); }
  private current(active: Active): boolean {
    return this.active === active && !active.stopped && !this.disposed && this.dependencies.simulator.isLibraryReplayCurrent(active.context);
  }
  private report(error: unknown): void {
    try { if (this.dependencies.onError) this.dependencies.onError(error); else console.warn("Current replay library reuse unavailable", error); }
    catch { /* Optional observation must not interrupt viewer playback. */ }
  }
  private pump(active: Active): void {
    if (active.working || !this.current(active)) return;
    active.working = true;
    // Even a cached capture starts after the foreground caller returns.
    void Promise.resolve().then(async () => {
      try {
        while (this.current(active) && active.dirty) {
          active.dirty = false;
          if (!active.numerical) {
            const checkpoint = async () => {
              if (!this.current(active)) throw new Error("Current replay capture cancelled");
              if (this.dependencies.checkpoint) await this.dependencies.checkpoint();
              else await new Promise<void>(resolve => setTimeout(resolve, 0));
              if (!this.current(active)) throw new Error("Current replay capture cancelled");
            };
            active.numerical = await this.dependencies.simulator.captureLibraryNumerical(active.context, checkpoint);
          }
          if (!this.current(active)) return;
          const projected = projectCurrentReplayResults(active.context.binding, { binding: active.context.binding,
            numerical: active.numerical, performance: this.dependencies.performance.captureLibraryPerformance(active.context) });
          if (projected.state !== "compatible") { active.stopped = true; return; }
          const results: LibraryCurrentReplayResult[] = projected.projections.map(({ slot, producerVersion, metrics }) => ({ slot, producerVersion, metrics }))
            .filter(result => active.sent.get(result.slot) !== JSON.stringify(result));
          if (!results.length || !this.current(active)) continue;
          const response = await this.dependencies.request({ method: "current-replay-publish", token: active.receipt.token, results });
          if (!this.current(active)) return;
          if (!response || typeof response !== "object" || !("state" in response) || !("accepted" in response) ||
            !["applied", "cached", "stale", "unavailable"].includes(String(response.state)) || !Array.isArray(response.accepted) ||
            response.accepted.length > results.length || new Set(response.accepted).size !== response.accepted.length ||
            response.accepted.some(slot => !results.some(result => result.slot === slot))) throw new Error("Invalid current replay publication receipt");
          if (response.state === "stale" || response.state === "unavailable") { active.stopped = true; return; }
          // A declined same-value slot is not retried on unrelated notifications. Main owns target CAS.
          for (const result of results) active.sent.set(result.slot, JSON.stringify(result));
        }
      } catch (error) {
        if (this.current(active)) { active.stopped = true; this.report(error); }
      } finally {
        active.working = false;
        if (active.dirty && this.current(active)) this.pump(active);
      }
    });
  }
}
