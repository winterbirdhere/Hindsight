import { setImmediate } from "timers/promises";

/** One serial owner; retain in-progress I/O state while yielding at bounded checkpoints. */
export class LibraryActivityGate {
  private demand = false;
  private active = false;
  private parked = false;
  private waitingExternal=false;
  private wake?: () => void;
  private acknowledgements: (() => void)[] = [];
  private acknowledge(): void { for (const resolve of this.acknowledgements.splice(0)) resolve(); }
  setDemand(demand: boolean): Promise<void> {
    this.demand = demand;
    if (!demand) { this.wake?.(); this.acknowledge(); return Promise.resolve(); }
    if (!this.active || this.parked || this.waitingExternal) return Promise.resolve();
    return new Promise(resolve => this.acknowledgements.push(resolve));
  }
  async checkpoint(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); await setImmediate();
    while (this.demand) {
      signal?.throwIfAborted(); this.parked = true; this.acknowledge();
      try {
        await new Promise<void>(resolve => {
          const resume = () => { signal?.removeEventListener("abort", resume); if (this.wake === resume) this.wake = undefined; resolve(); };
          this.wake = resume; signal?.addEventListener("abort", resume, { once: true });
          if (signal?.aborted || !this.demand) resume();
        });
      } finally { this.parked = false; }
    }
    signal?.throwIfAborted();
  }
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active) throw new Error("Activity gate requires a serial owner");
    this.active = true;
    try { await this.checkpoint(signal); return await work(); }
    finally { this.active = false; this.acknowledge(); }
  }
  /** Computation acknowledgement only; the main native broker separately confirms helper drainage. */
  async waitForExternal<T>(work:Promise<T>,signal?:AbortSignal):Promise<T>{
    if(!this.active||this.waitingExternal)throw new Error("External wait requires one active owner");
    this.waitingExternal=true;if(this.demand)this.acknowledge();
    let result:T;try{result=await work;}finally{this.waitingExternal=false;}await this.checkpoint(signal);return result;
  }
}
