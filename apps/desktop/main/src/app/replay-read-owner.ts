import { Worker } from "worker_threads";
import { join } from "path";
import type { OsrReplay } from "@rewind/osu-local/osr-reader";

type Reader = (bytes: Buffer) => Promise<OsrReplay>;
type Work<T> = (read: Reader, signal: AbortSignal) => Promise<T>;
type Thread = Pick<Worker, "on" | "postMessage" | "terminate">;
interface Entry { controller: AbortController; work: Work<unknown>; decoderStarted?: boolean; resolve(value: unknown): void; reject(error: unknown): void }
interface Slot { active?: Entry; pending?: Entry }

/** One active read and only the latest not-yet-started read per actual sender. */
export class ReplayReadOwner {
  private readonly slots = new Map<number, Slot>();
  private readonly running = new Set<Promise<void>>();
  private sequence = 0;
  private closed = false;
  private cleanupFailure?: Error;
  private closing?: Promise<void>;
  constructor(private readonly spawn: () => Thread = () => new Worker(join(__dirname, "replay-read-worker.js"))) {}

  read<T>(owner: number, work: Work<T>): Promise<T> {
    if (this.cleanupFailure) return Promise.reject(this.cleanupFailure);
    if (this.closed) return Promise.reject(new Error("Replay reader closed"));
    const slot = this.slots.get(owner) ?? {};
    this.slots.set(owner, slot);
    const replaced = new Error("Replay read replaced");
    slot.pending?.reject(replaced);
    slot.active?.controller.abort(replaced);
    return new Promise<T>((resolve, reject) => {
      slot.pending = { controller: new AbortController(), work, resolve: value => resolve(value as T), reject };
      this.pump(owner, slot);
    });
  }

  cancel(owner: number, error = new Error("Replay read cancelled")): void {
    const slot = this.slots.get(owner);
    if (!slot) return;
    slot.pending?.reject(error); slot.pending = undefined;
    slot.active?.controller.abort(error);
    if (!slot.active) this.slots.delete(owner);
  }

  private pump(owner: number, slot: Slot): void {
    if (slot.active || !slot.pending) return;
    if (this.closed || this.cleanupFailure) { this.cancel(owner, this.cleanupFailure ?? new Error("Replay reader closed")); return; }
    const entry = slot.pending; slot.pending = undefined; slot.active = entry;
    const work = Promise.resolve().then(async () => {
      try {
        entry.controller.signal.throwIfAborted();
        const value = await entry.work(bytes => this.decode(entry, bytes), entry.controller.signal);
        entry.controller.signal.throwIfAborted();
        entry.resolve(value);
      } catch (error) { entry.reject(error); }
      finally {
        slot.active = undefined;
        if (slot.pending) this.pump(owner, slot); else this.slots.delete(owner);
      }
    });
    this.running.add(work); void work.finally(() => this.running.delete(work));
  }

  private decode(entry: Entry, bytes: Buffer): Promise<OsrReplay> {
    entry.controller.signal.throwIfAborted();
    if (entry.decoderStarted) return Promise.reject(new Error("Replay read already owns a decoder"));
    entry.decoderStarted = true;
    const thread = this.spawn(), id = ++this.sequence, signal = entry.controller.signal;
    return new Promise((resolve, reject) => {
      let reply: { ok: boolean; replay?: OsrReplay; error?: unknown } | undefined;
      let failure: unknown, stopped = false, exited = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const uncertain = () => {
        if (exited) return;
        clearTimeout(timer); signal.removeEventListener("abort", stop);
        this.cleanupFailure = new Error("Replay worker cleanup failed: exit not confirmed");
        reject(this.cleanupFailure);
      };
      const stop = () => {
        if (stopped || exited) return; stopped = true;
        timer = setTimeout(uncertain, 2000);
        try { void thread.terminate().catch(uncertain); } catch { uncertain(); }
      };
      thread.on("message", (value: unknown) => {
        const candidate = value as { id?: number; ok?: boolean; replay?: OsrReplay; error?: unknown } | null;
        if (reply || !candidate || candidate.id !== id || typeof candidate.ok !== "boolean" ||
          (candidate.ok && (!candidate.replay || typeof candidate.replay !== "object"))) {
          failure = new Error("Invalid replay worker reply"); stop(); return;
        }
        reply = { ...candidate, ok: candidate.ok };
      });
      thread.on("error", error => { failure = error; stop(); });
      thread.on("messageerror", error => { failure = error; stop(); });
      thread.on("exit", code => {
        exited = true; clearTimeout(timer); signal.removeEventListener("abort", stop);
        if (this.cleanupFailure) reject(this.cleanupFailure);
        else if (signal.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Replay worker stopped (${code})`));
        else if (!reply) reject(new Error("Replay worker exited without a result"));
        else if (reply.ok) resolve(reply.replay!);
        else reject(reply.error);
      });
      signal.addEventListener("abort", stop, { once: true });
      try {
        signal.throwIfAborted();
        // No transfer list: main retains its exact Buffer for digest and source corroboration.
        thread.postMessage({ id, bytes });
      } catch (error) { failure = error; stop(); }
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const owner of this.slots.keys()) this.cancel(owner, new Error("Replay reader closed"));
    this.closing = Promise.all([...this.running]).then(() => { if (this.cleanupFailure) throw this.cleanupFailure; });
    return this.closing;
  }
}
