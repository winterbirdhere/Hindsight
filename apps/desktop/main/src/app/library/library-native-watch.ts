import { spawn } from "child_process";
import { EventEmitter } from "events";
import { win32 } from "path";
import type { Readable, Writable } from "stream";
import type { SourceWatcher, WatchFactory, WatchFilter } from "./library-source-watch";

export interface LibraryWatchChild {
  pid?: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(): boolean;
}
interface Subscription {
  slot: number; generation: number; path: string; recursive: boolean; filter: WatchFilter;
  notify: (event: string, filename: string | null) => void; handle: EventEmitter;
  revision: number; failed: boolean;
}
interface Ack { version: 1; kind: "ack"; slot: number; generation: number; revision: number }
const MAX_COMMAND = 16 * 1024, MAX_FRAME = 4096, MAX_SLOTS = 8;
const filters = new Set<WatchFilter>(["stable-root", "lazer-root", "replay", "all"]);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** One passive utility-owned helper, separate from foreground/background calculation admission.
 * Eight subscription slots; fixed framing buffer; one configuration and at most eight ACKs pending.
 * close waits actual child close; failed drain is never a successful replacement boundary. */
export class LibraryNativeWatch {
  private readonly slots = new Map<number, Subscription>();
  private readonly generations = new Array<number>(MAX_SLOTS).fill(0);
  private readonly acknowledgements = new Map<number, Ack>();
  private child?: LibraryWatchChild;
  private failed?: Error;
  private closing?: Promise<void>;
  private closed = false;
  private exited = false;
  private blocked = false;
  private configDirty = false;
  private configuration = 0;
  private configInFlight = 0;
  private readonly frame = Buffer.alloc(MAX_FRAME);
  private frameLength = 0;
  private diagnosticBytes = 0;
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;
  private rejectExit?: (error: Error) => void;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private configTimer?: ReturnType<typeof setTimeout>;
  private killRequested = false;

  constructor(private readonly executable: () => string,
    private readonly start: (executable: string) => LibraryWatchChild = executable =>
      spawn(executable, ["--library-watch"], { windowsHide: true, shell: false, stdio: "pipe" })) {}

  readonly factory: WatchFactory = (path, recursive, notify, filter = "all"): SourceWatcher => {
    if (this.closed || this.failed) throw this.failed ?? new Error("Library watcher is closed");
    if (!win32.isAbsolute(path) || path.length > 8192 || Array.from(path).some(character => character.charCodeAt(0) < 32) || !filters.has(filter))
      throw new Error("Invalid library watch subscription");
    const slot = this.generations.findIndex((_value, index) => !this.slots.has(index));
    if (slot < 0) throw new Error("Library watch subscription capacity");
    const generation = this.generations[slot] + 1;
    if (!Number.isSafeInteger(generation)) throw new Error("Library watch generation exhausted");
    const handle = new EventEmitter(), subscription: Subscription = {
      slot, generation, path, recursive, filter, notify, handle, revision: 0, failed: false
    };
    // Check aggregate command size before starting a process or admitting this subscription.
    const prospective = [...this.slots.values(), subscription].map(item => this.descriptor(item));
    if (Buffer.byteLength(JSON.stringify({ version: 1, kind: "configure", sequence: Number.MAX_SAFE_INTEGER, subscriptions: prospective })) > MAX_COMMAND)
      throw new Error("Library watch configuration bound");
    this.generations[slot] = generation; this.slots.set(slot, subscription);
    this.configDirty = true;
    this.launch(); this.pump();
    let detached = false;
    return Object.assign(handle, { close: () => {
      if (detached) return; detached = true;
      if (this.slots.get(slot) !== subscription) return;
      this.slots.delete(slot); this.acknowledgements.delete(slot); this.configDirty = true; this.pump();
    } });
  };

  private descriptor(item: Subscription) {
    return { slot: item.slot, generation: item.generation, path: item.path, recursive: item.recursive, filter: item.filter };
  }
  private launch(): void {
    if (this.child || this.failed || this.closed) return;
    this.exitPromise = new Promise<void>((resolve, reject) => { this.resolveExit = resolve; this.rejectExit = reject; });
    // The owner may be failed before the service's close caller observes this promise.
    void this.exitPromise.catch(() => undefined);
    try {
      const child = this.child = this.start(this.executable());
      child.stdin.on("drain", () => { this.blocked = false; this.pump(); });
      child.stdin.on("error", () => this.fail(new Error("Library watch input failed")));
      child.stdout.on("error", () => this.fail(new Error("Library watch output failed")));
      child.stderr.on("error", () => this.fail(new Error("Library watch diagnostics failed")));
      child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
      // Drain but do not retain source-sensitive diagnostics.
      child.stderr.on("data", (chunk: Buffer) => {
        this.diagnosticBytes += chunk.length;
        if (this.diagnosticBytes > 64 * 1024) this.fail(new Error("Library watch diagnostic bound"));
      });
      child.on("error", () => {
        this.fail(new Error("Library watcher failed to start"));
        if (child.pid === undefined) this.finishExit(); // No OS child was created.
      });
      child.on("close", (code: number | null) => {
        if (!this.closed && !this.failed) {
          this.failed = new Error(`Library watcher stopped (${code}); reactivate explicitly`);
          for (const item of this.slots.values()) this.report(item, this.failed);
        }
        this.finishExit();
      });
    } catch {
      this.fail(new Error("Could not start library watcher")); this.finishExit();
    }
  }
  private finishExit(): void {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this.closeTimer); clearTimeout(this.killTimer); clearTimeout(this.configTimer);
    this.resolveExit?.();
  }
  private send(value: unknown): void {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_COMMAND) throw new Error("Library watch command bound");
    this.blocked = !this.child!.stdin.write(body + "\n");
  }
  private pump(): void {
    if (!this.child || this.closed || this.failed || this.exited || this.blocked) return;
    try {
      // ACKs are bounded per slot and cannot be starved by configuration replacement.
      for (const [slot, ack] of this.acknowledgements) {
        this.acknowledgements.delete(slot); this.send(ack);
        if (this.blocked) return;
      }
      if (!this.configDirty || this.configInFlight) return;
      if (!Number.isSafeInteger(this.configuration + 1)) throw new Error("Library watch configuration exhausted");
      this.configInFlight = ++this.configuration; this.configDirty = false;
      this.configTimer = setTimeout(() => this.fail(new Error("Library watch configuration timed out")), 5000);
      this.send({ version: 1, kind: "configure", sequence: this.configInFlight,
        subscriptions: [...this.slots.values()].map(item => this.descriptor(item)) });
    } catch (error) { this.fail(error instanceof Error ? error : new Error("Library watch transport failed")); }
  }
  private receive(chunk: Buffer): void {
    if (this.closed || this.failed) return;
    try {
      for (const byte of chunk) {
        if (byte !== 10) {
          if (this.frameLength === MAX_FRAME) throw new Error("Library watch frame bound");
          this.frame[this.frameLength++] = byte; continue;
        }
        const value: unknown = JSON.parse(this.frame.subarray(0, this.frameLength).toString("utf8"));
        this.frameLength = 0; this.message(value);
        if (this.failed || this.closed) return;
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error("Invalid library watch frame")); }
  }
  private message(raw: unknown): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid library watch frame");
    const value = raw as Record<string, unknown>;
    if (value.version !== 1) throw new Error("Invalid library watch version");
    if (value.kind === "configured") {
      if (!exact(value, ["version", "kind", "sequence"]) || !integer(value.sequence) || value.sequence !== this.configInFlight)
        throw new Error("Invalid library watch configuration acknowledgement");
      clearTimeout(this.configTimer); this.configInFlight = 0; this.pump(); return;
    }
    if ((value.kind !== "dirty" && value.kind !== "error") || !Number.isInteger(value.slot) ||
        Number(value.slot) < 0 || Number(value.slot) >= MAX_SLOTS || !integer(value.generation))
      throw new Error("Invalid library watch event");
    if (value.kind === "dirty" ? !exact(value, ["version", "kind", "slot", "generation", "revision"]) || !integer(value.revision) :
      !exact(value, ["version", "kind", "slot", "generation", "error"]) || !["watch-overflow", "watch-unavailable"].includes(String(value.error)))
      throw new Error("Invalid library watch event shape");
    const item = this.slots.get(Number(value.slot));
    if (!item || item.generation !== value.generation) return;
    if (value.kind === "error") {
      if (item.failed) throw new Error("Duplicate library watch error");
      item.failed = true; this.acknowledgements.delete(item.slot);
      this.report(item, new Error(String(value.error))); return;
    }
    if (item.failed || value.revision !== item.revision + 1 || this.acknowledgements.has(item.slot))
      throw new Error("Invalid library watch revision");
    item.revision = Number(value.revision);
    this.acknowledgements.set(item.slot, { version: 1, kind: "ack", slot: item.slot, generation: item.generation, revision: item.revision });
    item.notify("change", null); this.pump();
  }
  private report(item: Subscription, error: Error): void {
    // Factory callers attach listeners immediately after return, including synchronous spawn failure.
    queueMicrotask(() => {
      if (!this.closed && this.slots.get(item.slot) === item && item.handle.listenerCount("error")) item.handle.emit("error", error);
    });
  }
  private fail(error: Error): void {
    if (this.failed || this.exited) return;
    this.failed = error; clearTimeout(this.configTimer);
    for (const item of this.slots.values()) this.report(item, error);
    this.terminate();
  }
  private terminate(): void {
    if (!this.child || this.exited || this.killRequested) return;
    this.killRequested = true;
    try { this.child.kill(); } catch { /* Actual close remains required. */ }
    this.killTimer = setTimeout(() => {
      this.failed ??= new Error("Library watch cleanup failed: exit not confirmed");
      this.rejectExit?.(new Error("Library watch cleanup failed: exit not confirmed"));
    }, 2000);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.slots.clear(); this.acknowledgements.clear(); clearTimeout(this.configTimer);
    if (!this.child) return this.closing = this.failed ? Promise.reject(this.failed) : Promise.resolve();
    if (!this.exited) {
      try { this.child.stdin.end(); } catch { this.terminate(); }
      this.closeTimer = setTimeout(() => this.terminate(), 2000);
    }
    this.closing = this.exitPromise!.then(() => { if (this.failed) throw this.failed; });
    return this.closing;
  }
}
