import type { LibraryAnalysisSettings, LibraryMetricJob, LibraryMetricPatch, LibraryMetricResult,
  LibraryMetricTicket } from "../../../../shared/replay-library-metrics";
import type { LibraryPreparationRequest, LibraryPreparationTicket } from "./library-preparation-store";
import { LibraryPreparedWork, LibraryHandoffFinalizationError } from "./library-numerical-preparation";

type Awaitable<T> = T | Promise<T>;
export interface LibrarySchedulerQueue {
  settings(): Awaitable<LibraryAnalysisSettings>;
  nextQueued(limit: number, includeNative: boolean): Awaitable<LibraryMetricJob[]>;
  claim(id: string): Awaitable<LibraryMetricTicket | undefined>;
  commit(patch: LibraryMetricPatch): Awaitable<"applied" | "stale">;
  fail(ticket: LibraryMetricTicket, error: string): Awaitable<"applied" | "stale">;
  release(ticket: LibraryMetricTicket): Awaitable<"applied" | "stale">;
}
export interface LibrarySchedulerControl { viewerDemand: boolean; userPaused: boolean; fasterProcessing?: boolean }
export interface LibraryScheduledWork {
  /** Settles only after owned workers, resource sessions and native processes have drained. */
  result: Promise<LibraryMetricResult>;
  /** A serial multi-phase owner commits/releases its transferred tickets before settling. */
  managesPersistence?:boolean;
  eligible?():Promise<boolean>;
  control(value: LibrarySchedulerControl): Promise<"idle" | "parked" | "superseded" | "released">;
}
export interface LibrarySchedulerPreparations {
  /** Return only a preparation that precedes beforeMetric in the same priority/newest ordering. */
  nextQueued(limit:number,beforeMetric?:string,includeNative?:boolean):Awaitable<LibraryPreparationRequest[]>;
  claim(request:LibraryPreparationRequest):Awaitable<LibraryPreparationTicket|undefined>;
  release(ticket:LibraryPreparationTicket):Awaitable<"applied"|"stale">;
  fail(ticket:LibraryPreparationTicket,error:string):Awaitable<"applied"|"stale">;
  start(ticket:LibraryPreparationTicket,initial:LibrarySchedulerControl,signal:AbortSignal):LibraryPreparedWork;
}
type Owned = { ticket: LibraryMetricTicket|LibraryPreparationTicket; kind:"metric"|"preparation";
  abort: AbortController; task: LibraryScheduledWork|LibraryPreparedWork; done: Promise<void>;
  retirement?: "off" | "shutdown" | "invalid"; controlError?: string; executionSettled?: boolean;
  control?: { value: LibrarySchedulerControl; reply: ReturnType<LibraryScheduledWork["control"]> } };
const nativeSlot = (slot: LibraryMetricTicket["slot"]) => !["numerical", "incidents"].includes(slot);
const message = (error: unknown) => (error instanceof Error ? error.message : "Library scheduler failed").slice(0, 2048);

/** Main-owned admission only. It never invokes viewer managers or creates a job from a query.
 * SQLite stays behind the asynchronous queue port; the execution port owns actual work/cleanup. */
export class LibraryScheduler {
  private settings?: LibraryAnalysisSettings;
  private settingsGeneration = 0;
  private appliedSettingsGeneration = 0;
  private viewerDemand = true;
  private onBattery = false;
  private resumeTimer?: ReturnType<typeof setTimeout>;
  private readonly active = new Map<string, Owned>();
  private requested = false;
  private pumping?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private fault?: string;
  private eligibilityChecks=0;
  private readonly eligibilityWork=new Set<Promise<void>>();
  constructor(private readonly queue: LibrarySchedulerQueue,
    private readonly start: (ticket: LibraryMetricTicket, initial: LibrarySchedulerControl, signal: AbortSignal) => LibraryScheduledWork,
    private readonly resumeDelayMs = 150,private readonly preparations?:LibrarySchedulerPreparations,
    private readonly statusChanged:()=>void=()=>undefined,
    private readonly settingsApplied:(settings:LibraryAnalysisSettings)=>void=()=>undefined) {}

  status() {
    return { viewerDemand: this.viewerDemand, onBattery: this.onBattery, userPaused: this.settings?.userPaused ?? false,
      mode:this.settings?.mode,batteryHold:!!(this.settings?.pauseOnBattery&&this.onBattery),resumePending:this.resumeTimer!==undefined,
      error: this.fault, active: [...this.active.values()].map((item, index) => ({ ticket: item.ticket,
        ...this.controlFor(index), retiring: item.retirement !== undefined })) };
  }
  reportFault(error:unknown):void {this.fault=message(error);this.statusChanged();}
  reconcileEligibility():Promise<void> {
    if(this.closed)return Promise.resolve();this.eligibilityChecks++;
    const work=(async()=>{try{await Promise.all([...this.active.values()].map(async item=>{
      if(item.executionSettled||item.retirement||!item.task.eligible)return;
      const eligible=await item.task.eligible();
      if(!eligible&&!item.executionSettled&&!item.retirement&&this.active.get(item.ticket.attempt)===item){
        item.retirement="invalid";item.abort.abort(new Error("Library analysis inputs or source lease changed"));
        this.statusChanged();
      }
    }));}catch(error){this.reportFault(error);throw error;}finally{this.eligibilityChecks--;this.wake();}})();
    const tracked=work.finally(()=>this.eligibilityWork.delete(tracked));
    this.eligibilityWork.add(tracked);return tracked;
  }
  private automaticallyHeld(): boolean {
    return this.viewerDemand || this.resumeTimer !== undefined || !!(this.settings?.pauseOnBattery && this.onBattery);
  }
  private controlFor(index: number): LibrarySchedulerControl {
    return { viewerDemand: this.automaticallyHeld() || index >= (this.settings?.workers ?? 0), userPaused: this.settings?.userPaused ?? false,
      ...(this.settings?.fasterProcessing?{fasterProcessing:true}:{}) };
  }
  private mayAdmit(): boolean {
    return !this.closed && !this.fault && !this.eligibilityChecks && !!this.settings && this.appliedSettingsGeneration === this.settingsGeneration &&
      !this.automaticallyHeld() && !this.settings.userPaused &&
      this.active.size < this.settings.workers;
  }
  private controls(): Promise<void> {
    const changes = [...this.active.values()].map((item, index) => this.control(item, this.controlFor(index)));
    return Promise.all(changes).then(() => undefined);
  }
  private async control(item: Owned, value: LibrarySchedulerControl): Promise<void> {
    const drained = () => item.executionSettled || item.retirement || this.active.get(item.ticket.attempt) !== item;
    if (drained()) return;
    if (!item.control || item.control.value.viewerDemand !== value.viewerDemand || item.control.value.userPaused !== value.userPaused||
      item.control.value.fasterProcessing!==value.fasterProcessing) {
      item.control = { value, reply: Promise.resolve().then(() => item.task.control(value)) };
    }
    for (;;) {
      const current: NonNullable<Owned["control"]> = item.control;
      try {
        const state = await current.reply;
        if (drained()) return;
        if (current !== item.control) continue;
        if (state === "superseded" || ((current.value.viewerDemand || current.value.userPaused) && state !== "idle" && state !== "parked"))
          throw new Error("Library worker did not confirm its current control");
        return;
      } catch (error) {
        if (drained()) return;
        if (current !== item.control) continue;
        item.controlError = message(error); item.abort.abort(error); throw error;
      }
    }
  }
  async refresh(): Promise<void> {
    if (this.closed) throw new Error("Library scheduler is closed");
    const generation = ++this.settingsGeneration;
    let settings: LibraryAnalysisSettings;
    try { settings = await this.queue.settings(); }
    catch (error) { if (generation === this.settingsGeneration) this.reportFault(error); throw error; }
    if (this.closed || generation !== this.settingsGeneration) return;
    // Apply main-owned native policy only for the accepted generation, before any new admission.
    try { this.settingsApplied(settings); }
    catch(error) { this.reportFault(error); throw error; }
    this.settings = { ...settings }; this.appliedSettingsGeneration = generation;
    // Off was persisted and unfinished S/C jobs were removed atomically before this refresh.
    if (settings.mode === "off") for (const item of this.active.values()) {
      if (["S", "C"].includes(item.ticket.stage) && !item.retirement) {
        item.retirement = "off"; item.abort.abort(new Error("Library analysis switched Off"));
      }
    }
    this.statusChanged();this.wake(); await this.controls();
  }
  setViewerDemand(active: boolean): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Library scheduler is closed"));
    if (typeof active !== "boolean") return Promise.reject(new Error("Invalid viewer demand"));
    const changed = this.viewerDemand !== active; this.viewerDemand = active;
    if (active && this.resumeTimer !== undefined) { clearTimeout(this.resumeTimer); this.resumeTimer = undefined; }
    if (!active && changed && this.resumeTimer === undefined) {
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = undefined;
        this.statusChanged();void this.controls().catch(error => { this.reportFault(error); }); this.wake();
      }, this.resumeDelayMs);
    }
    // Admission closes synchronously. Callers may observe this acknowledgement without delaying
    // independent foreground work; a rejected hold is never reported as successful yielding.
    this.statusChanged();return this.controls();
  }
  setOnBattery(active: boolean): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Library scheduler is closed"));
    if (typeof active !== "boolean") return Promise.reject(new Error("Invalid battery state"));
    this.onBattery = active; this.statusChanged();this.wake(); return this.controls();
  }
  wake(): void {
    if (this.closed || this.fault) return;
    this.requested = true;
    if (this.pumping) return;
    this.pumping = this.pump().catch(error => { this.reportFault(error); }).finally(() => {
      this.pumping = undefined;
      if (this.requested && !this.closed && !this.fault) this.wake();
    });
  }
  private async pump(): Promise<void> {
    while (this.requested) {
      this.requested = false;
      let staleClaims = 0;
      while (this.mayAdmit()) {
        const generation = this.settingsGeneration;
        const includeNative = !!this.settings?.fasterProcessing || ![...this.active.values()].some(item => "slot" in item.ticket?nativeSlot(item.ticket.slot):item.ticket.stage==="P");
        const candidates = await this.queue.nextQueued(1, includeNative);
        if(!this.mayAdmit()||generation!==this.settingsGeneration)break;
        const preparations=await this.preparations?.nextQueued(1,candidates[0]?.id,includeNative)??[];
        if (!this.mayAdmit() || generation!==this.settingsGeneration || candidates.length === 0&&preparations.length===0) break;
        if(preparations.length&&this.preparations){
          const request=preparations[0],ticket=await this.preparations.claim(request);
          if(!ticket){if(++staleClaims>=8)throw new Error("Library queue returned eight stale claims; retry the library service");continue;}
          staleClaims=0;
          if(!this.mayAdmit()||generation!==this.settingsGeneration||ticket.stage!=="P"&&(this.settings?.mode==="off"||this.settings?.mode==="demand"&&request.reason==="background")){
            await this.preparations.release(ticket);break;
          }
          this.executePreparation(ticket);continue;
        }
        const ticket = await this.queue.claim(candidates[0].id);
        if (!ticket) {
          if (++staleClaims >= 8) throw new Error("Library queue returned eight stale claims; retry the library service");
          continue;
        }
        staleClaims = 0;
        if (!this.mayAdmit() || generation !== this.settingsGeneration ||
          (["S", "C"].includes(ticket.stage) && (this.settings?.mode === "off" ||
            (this.settings?.mode === "demand" && ["background","strip-repair"].includes(candidates[0].reason))))) {
          // No execution began during this asynchronous claim; there is no continuation to discard.
          await this.queue.release(ticket); break;
        }
        this.execute(ticket);
      }
    }
  }
  private execute(ticket: LibraryMetricTicket): void {
    const abort = new AbortController();
    let task: LibraryScheduledWork;
    try { task = this.start(ticket, this.controlFor(this.active.size), abort.signal); }
    catch (error) { task = { result: Promise.reject(error), control: async () => "idle" }; }
    const item: Owned = { ticket, kind:"metric",abort, task, done: Promise.resolve() }; this.active.set(ticket.attempt, item);
    this.statusChanged();
    item.done = (async () => {
      let metrics: LibraryMetricResult | undefined, failure: unknown;
      try { metrics = await task.result; } catch (error) { failure = error; }
      finally { item.executionSettled = true; }
      if(task.managesPersistence){if(failure instanceof LibraryHandoffFinalizationError)throw failure;return;}
      // The execution port promises that result settlement includes actual cleanup.
      if (item.retirement === "shutdown"||item.retirement==="invalid") await this.queue.release(ticket);
      else if (item.retirement !== "off") {
        if (metrics && !item.controlError) await this.queue.commit({ ticket, producerVersion: ticket.producerVersion, ...metrics });
        else await this.queue.fail(ticket, item.controlError ?? message(failure));
      }
    })().catch(error => { this.reportFault(error); }).finally(() => {
      this.active.delete(ticket.attempt);
      this.statusChanged();
      if (!this.closed) { void this.controls().catch(error => { this.reportFault(error); }); this.wake(); }
    });
  }
  private executePreparation(ticket:LibraryPreparationTicket):void {
    const preparations=this.preparations;if(!preparations)throw new Error("Preparation producer is unavailable");
    const abort=new AbortController();let task:LibraryPreparedWork;
    try{task=preparations.start(ticket,this.controlFor(this.active.size),abort.signal);}
    catch(error){task={result:Promise.reject(error),control:async()=>"idle"};}
    const item:Owned={ticket,kind:"preparation",abort,task,done:Promise.resolve()};this.active.set(ticket.attempt,item);
    this.statusChanged();
    item.done=(async()=>{
      let failed=false,failure:unknown;
      try{await task.result;}catch(error){failed=true;failure=error;}finally{item.executionSettled=true;}
      if(failure instanceof LibraryHandoffFinalizationError)throw failure;
      // Prepared execution finalizes any metric handoff before its result settles.
      if(item.retirement==="shutdown"||item.retirement==="invalid")await preparations.release(ticket);
      else if(item.retirement!=="off"&&(failed||item.controlError))await preparations.fail(ticket,item.controlError??message(failure));
    })().catch(error=>{this.reportFault(error);}).finally(()=>{
      this.active.delete(ticket.attempt);
      this.statusChanged();
      if(!this.closed){void this.controls().catch(error=>{this.reportFault(error);});this.wake();}
    });
  }
  /** Wait only for admission decisions, never for parked workers to finish. */
  async settleAdmissions(): Promise<void> { while (this.pumping) await this.pumping; }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.settingsGeneration++;
    if (this.resumeTimer !== undefined) { clearTimeout(this.resumeTimer); this.resumeTimer = undefined; }
    for (const item of this.active.values()) {
      item.retirement ??= "shutdown"; item.abort.abort(new Error("Library scheduler closed"));
    }
    this.closing = (async () => {
      await this.settleAdmissions(); await Promise.all([...this.active.values()].map(item => item.done));
      await Promise.allSettled([...this.eligibilityWork]);
      if (this.fault) throw new Error(this.fault);
    })(); return this.closing;
  }
}
