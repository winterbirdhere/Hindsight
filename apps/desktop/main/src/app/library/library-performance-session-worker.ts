import type { PerformanceRequest, PerformanceResponse } from "@rewind/osu-performance/protocol";
import { PerformanceWorker } from "../performance-worker";
import { LibraryNativeAdmission, LibraryNativeDrainError } from "./library-native-admission";
import { assertCompactMapRequest } from "./library-performance-native";

type Worker = Pick<PerformanceWorker, "calculate" | "cancel" | "disposeAndDrain" | "hasReusableProcess">;
// The first compact result can require a few metadata cache reads/writes before the next call.
// Return idle capacity if that step stalls. Viewer hold and session close always retire sooner.
const IDLE_REUSE_MS = 100;

function notification() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

interface Lease {
  admission: AbortController;
  granted: ReturnType<typeof notification>;
  release: ReturnType<typeof notification>;
  done: Promise<void>;
  worker?: Worker;
  calls: number;
  active: boolean;
  retiring: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** Owns the compact P calls for one verified map. A retained idle process still owns its
 * broker permit. Control and final disposal operate independently of the resource's work queue. */
export class LibraryPerformanceSessionWorker {
  private lease?: Lease;
  private paused?: ReturnType<typeof notification>;
  private busy = false;
  private closed = false;
  private closing?: Promise<void>;
  private drainFailure?: LibraryNativeDrainError;
  private readonly onAbort = () => { void this.close().catch(() => undefined); };

  constructor(private readonly executable: () => string, private readonly admission: LibraryNativeAdmission,
    private readonly beatmap: string, private readonly signal: AbortSignal,
    private readonly create: (executable: () => string) => Worker = path => new PerformanceWorker(path, {background:true})) {
    if (signal.aborted) this.closed = true;
    else signal.addEventListener("abort", this.onAbort, {once:true});
  }

  private checkOpen() {
    if (this.drainFailure) throw this.drainFailure;
    this.signal.throwIfAborted();
    if (this.closed) throw new Error("Library performance session is closed");
  }

  private acquire(): Lease {
    const lease: Lease = {admission:new AbortController(), granted:notification(), release:notification(),
      done:Promise.resolve(), calls:0, active:false, retiring:false};
    this.lease = lease;
    const signal = lease.admission.signal;
    lease.done = this.admission.run("map-performance", async () => {
      if (lease.retiring) return;
      const worker = this.create(this.executable);
      lease.worker = worker;
      lease.granted.resolve();
      await lease.release.promise;
      try { await worker.disposeAndDrain(); }
      catch (error) { throw new LibraryNativeDrainError(error instanceof Error ? error.message : "Performance helper exit not confirmed"); }
    }, signal).catch(error => {
      if (error instanceof LibraryNativeDrainError) {
        this.drainFailure = error;
        this.paused?.resolve();
      }
      if (!signal.aborted || error !== signal.reason) throw error;
    }).finally(() => {
      if (this.lease === lease) this.lease = undefined;
    });
    return lease;
  }

  private retire(lease: Lease, cancelActive = false): Promise<void> {
    clearTimeout(lease.idleTimer);
    lease.retiring = true;
    // Cancel only an ungranted acquisition. Once a worker exists the callback owns its exit.
    if (!lease.worker && !lease.admission.signal.aborted) lease.admission.abort(new Error("Performance grant withdrawn"));
    if (cancelActive && lease.active) {
      try { lease.worker?.cancel(1); } catch { /* Disposal still owns confirmation of actual exit. */ }
    }
    if (!lease.active || cancelActive) lease.release.resolve();
    return lease.done;
  }

  setHeld(held: boolean): Promise<void> {
    if (this.closing) return this.closing;
    if (this.drainFailure) return Promise.reject(this.drainFailure);
    if (held) {
      this.paused ??= notification();
      return this.lease ? this.retire(this.lease) : Promise.resolve();
    }
    this.paused?.resolve();
    this.paused = undefined;
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.signal.removeEventListener("abort", this.onAbort);
    this.paused?.resolve();
    this.closing = this.drainFailure ? Promise.reject(this.drainFailure) :
      this.lease ? this.retire(this.lease, true) : Promise.resolve();
    return this.closing;
  }

  async calculate(request: PerformanceRequest): Promise<PerformanceResponse> {
    assertCompactMapRequest(request);
    if (request.beatmap !== this.beatmap) throw new Error("Performance session map changed");
    const input = {beatmap:this.beatmap, calculations:request.calculations};
    this.checkOpen();
    if (this.busy) throw new Error("Performance session calculation is already pending");
    this.busy = true;
    try {
      for (;;) {
        this.checkOpen();
        if (this.paused) { await this.paused.promise; continue; }
        const lease = this.lease ?? this.acquire();
        if (lease.retiring) { await lease.done; continue; }
        await Promise.race([lease.granted.promise, lease.done]);
        this.checkOpen();
        if (this.paused || lease.retiring || !lease.worker) continue;
        // No yield between checking the idle process and issuing the request. A retired idle
        // process must close before any replacement acquires its own permit.
        if (lease.calls && !lease.worker.hasReusableProcess) { await this.retire(lease); continue; }
        clearTimeout(lease.idleTimer);
        lease.calls++;
        lease.active = true;
        let result: PerformanceResponse;
        try {
          assertCompactMapRequest(input);
          result = await lease.worker.calculate(1, input);
        }
        catch (error) {
          lease.active = false;
          await this.retire(lease);
          throw error;
        } finally {
          lease.active = false;
          if (lease.retiring) lease.release.resolve();
        }
        if (lease.retiring || lease.calls >= 2 || !result.ok) await this.retire(lease);
        else {
          lease.idleTimer = setTimeout(() => { void this.retire(lease).catch(() => undefined); }, IDLE_REUSE_MS);
          lease.idleTimer.unref();
        }
        this.checkOpen();
        return result;
      }
    } catch (error) {
      if (this.closing) await this.closing;
      throw error;
    } finally { this.busy = false; }
  }
}
