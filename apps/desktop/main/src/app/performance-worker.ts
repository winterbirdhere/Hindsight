import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { createHash } from "crypto";
import { setPriority,constants } from "os";
import { PERFORMANCE_ENGINE_VERSION, PerformanceRequest, PerformanceResponse } from "@rewind/osu-performance/protocol";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// Budget the original UTF-8 JSON, not the larger parsed JavaScript heap objects.
// The three-entry limit also bounds the number of retained response graphs.
const MAX_CACHE_SERIALIZED_BYTES = 16 * 1024 * 1024;
// Retain only one idle process, long enough to reuse after a typical replay.
// Periodic retirement bounds how long native map/difficulty caches are retained.
const IDLE_TIMEOUT_MS = 120_000;
const MAX_PROCESS_REQUESTS = 8;

interface NativeSession {
  child: ChildProcessWithoutNullStreams;
  alive: boolean;
  completed: number;
  errorOutput: string;
  idleTimeout?: ReturnType<typeof setTimeout>;
  pending?: {
    data: (data: string) => void;
    drain: () => void;
    fail: (error: string) => void;
  };
}
export class PerformanceWorkerDrainError extends Error {}

/** One cancellable batch per window, with one bounded idle native process. */
export class PerformanceWorker {
  private active = new Map<number, { session: NativeSession; cancel: () => void }>();
  private idle?: NativeSession;
  private sequence = 0;
  private cache = new Map<string, { result: PerformanceResponse; bytes: number }>();
  private cacheBytes = 0;
  private readonly owned=new Map<NativeSession,Promise<void>>();
  private closing?:Promise<void>;

  constructor(private readonly executable: () => string,private readonly options:{background?:boolean}={}) {}

  cancel(owner: number): void {
    this.active.get(owner)?.cancel();
  }

  dispose(): void {
    for (const owner of this.active.keys()) this.cancel(owner);
    if (this.idle) this.retire(this.idle);
    this.cache.clear();
    this.cacheBytes = 0;
  }
  /** Library-only lifecycle barrier. Existing viewer disposal/cancellation remains immediate;
   * a background native permit must await this barrier, including previously retired sessions. */
  disposeAndDrain():Promise<void>{
    if(this.closing)return this.closing;
    this.closing=Promise.resolve().then(async()=>{
      try{this.dispose();}catch{/* A failed kill request cannot establish exit; continue draining every owner. */}
      for(const session of this.owned.keys())try{this.retire(session);}catch{/* Actual close below is authoritative. */}
      this.cache.clear();this.cacheBytes=0;
      let timeout:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([Promise.all([...this.owned.values()]),new Promise<never>((_,reject)=>{
        timeout=setTimeout(()=>reject(new PerformanceWorkerDrainError("Performance helper cleanup failed: exit not confirmed")),2000);
      })]);}finally{clearTimeout(timeout);}
    });return this.closing;
  }

  async calculate(owner: number, request: PerformanceRequest): Promise<PerformanceResponse> {
    if(this.closing)return{ok:false,error:"Performance worker is closed"};
    this.cancel(owner);
    if (!request || typeof request.beatmap !== "string" || !Array.isArray(request.calculations)) {
      return { ok: false, error: "Invalid performance request" };
    }
    let body: string;
    try {
      body = JSON.stringify(request);
    } catch {
      return { ok: false, error: "Invalid performance request" };
    }
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
      return { ok: false, error: "Replay performance input is too large" };
    const key = createHash("sha256").update(PERFORMANCE_ENGINE_VERSION).update(body).digest("hex");
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.result;
    }

    // The native protocol echoes this ID. It never enters the public response cache.
    const id = ++this.sequence;
    const input = JSON.stringify({ ...request, id }) + "\n";
    if (Buffer.byteLength(input) > MAX_REQUEST_BYTES)
      return { ok: false, error: "Replay performance input is too large" };

    return new Promise((resolve) => {
      let session: NativeSession;
      try {
        session = this.acquire();
      } catch (error) {
        resolve({ ok: false, error: `Performance engine could not start: ${String(error)}` });
        return;
      }
      let settled = false;
      const outputChunks: string[] = [];
      let outputBytes = 0;
      let response: PerformanceResponse | undefined;
      let responseBytes = 0;
      let written = false;
      let drained = false;
      let writeReturned = false;
      const finish = (result: PerformanceResponse, serializedBytes?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        outputChunks.length = 0;
        session.pending = undefined;
        if (this.active.get(owner)?.session === session) this.active.delete(owner);
        if (result.ok && serializedBytes !== undefined) {
          this.remember(key, result, serializedBytes);
          session.completed++;
          this.release(session);
        } else this.retire(session);
        resolve(result);
      };
      const fail = (error: string) => finish({ ok: false, error });
      const completeWhenWritten = () => {
        if (response && written && drained && writeReturned) finish(response, responseBytes);
      };
      const timeout = setTimeout(() => fail("Performance calculation timed out"), 120_000);
      this.active.set(owner, { session, cancel: () => fail("Performance calculation cancelled") });
      session.errorOutput = "";
      session.pending = {
        fail,
        drain: () => {
          drained = true;
          completeWhenWritten();
        },
        data: (data) => {
          if (settled) return;
          outputBytes += Buffer.byteLength(data);
          if (outputBytes > MAX_RESPONSE_BYTES) {
            fail("Performance engine response is too large");
            return;
          }
          // A session has exactly one request in flight. Additional output is a
          // protocol violation, including trailing partial lines in this chunk.
          const lineEnd = data.indexOf("\n");
          if (response || (lineEnd >= 0 && lineEnd !== data.length - 1)) {
            fail("Performance engine returned invalid data");
            return;
          }
          outputChunks.push(lineEnd < 0 ? data : data.slice(0, lineEnd));
          if (lineEnd < 0) return;
          try {
            const result = JSON.parse(outputChunks.join("")) as PerformanceResponse & { id?: number };
            outputChunks.length = 0;
            if (!result || result.id !== id || typeof result.ok !== "boolean") {
              fail("Performance engine returned incompatible data");
            } else if (!result.ok) {
              fail(typeof result.error === "string" ? result.error : "Performance calculation failed");
            } else if (
              result.engineVersion !== PERFORMANCE_ENGINE_VERSION ||
              !validTimelines(result) ||
              result.timelines!.length !== request.calculations.length ||
              request.calculations.some((input) => !result.timelines!.some((timeline) => timeline.mode === input.mode))
            ) {
              fail("Performance engine returned incompatible data");
            } else {
              delete result.id;
              response = result;
              responseBytes = outputBytes - 1;
              completeWhenWritten();
            }
          } catch {
            fail("Performance engine returned invalid data");
          }
        },
      };
      try {
        // write(false) accepts the bytes; wait for drain instead of resending or
        // closing stdin. Do not recycle a process until its write callback ends.
        drained = session.child.stdin.write(input, (error) => {
          if (settled) return;
          if (error) fail(`Performance engine input failed: ${error.message}`);
          else {
            written = true;
            completeWhenWritten();
          }
        });
        writeReturned = true;
        completeWhenWritten();
      } catch (error) {
        fail(`Performance engine input failed: ${String(error)}`);
      }
    });
  }

  private acquire(): NativeSession {
    if (this.idle) {
      const session = this.idle;
      this.idle = undefined;
      clearTimeout(session.idleTimeout);
      session.idleTimeout = undefined;
      return session;
    }
    const child = spawn(this.executable(), [], { windowsHide: true, stdio: "pipe" });
    const session: NativeSession = { child, alive: true, completed: 0, errorOutput: "" };
    let release!:()=>void;const drained=new Promise<void>(resolve=>{release=resolve;});this.owned.set(session,drained);
    const released=()=>{this.owned.delete(session);release();};child.once("close",released);
    const fail = (error: string) => {
      if (!session.alive) return;
      if (session.pending) session.pending.fail(error);
      else this.retire(session);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      if (session.alive) session.errorOutput = (session.errorOutput + data).slice(-2000);
    });
    child.stdout.on("data", (data: string) => {
      if (!session.alive) return;
      if (session.pending) session.pending.data(data);
      else this.retire(session);
    });
    child.stdin.on("drain", () => {
      if (session.alive) session.pending?.drain();
    });
    child.on("error", (error) => {if(child.pid===undefined)released();fail(`Performance engine could not start: ${error.message}`);});
    // 'exit' may precede final stdout; 'close' waits for stdio to drain.
    child.on("close", (code) => fail(`Performance engine exited (${code}): ${session.errorOutput}`));
    child.stdin.on("error", (error) => fail(`Performance engine input failed: ${error.message}`));
    if(this.options.background){
      try{
        if(!child.pid)throw new Error("Native process did not start");
        setPriority(child.pid,constants.priority.PRIORITY_LOW);
      }catch(error){this.retire(session);throw new Error(`Library native priority could not be applied: ${String(error)}`);}
    }
    return session;
  }

  private release(session: NativeSession): void {
    if (session.completed >= MAX_PROCESS_REQUESTS) {
      this.retire(session);
      return;
    }
    if (this.idle) this.retire(this.idle);
    this.idle = session;
    session.idleTimeout = setTimeout(() => this.retire(session), IDLE_TIMEOUT_MS);
    session.idleTimeout.unref();
  }

  private retire(session: NativeSession): void {
    if (!session.alive) return;
    session.alive = false;
    clearTimeout(session.idleTimeout);
    session.idleTimeout = undefined;
    if (this.idle === session) this.idle = undefined;
    // Request settlement must not depend on cleanup requests succeeding. Keep
    // ownership until actual close; disposeAndDrain reports any unconfirmed exit.
    try { session.child.stdin.destroy(); } catch { /* Still attempt termination. */ }
    try { session.child.kill(); } catch { /* A kill request is never exit evidence. */ }
  }

  private remember(key: string, result: PerformanceResponse, bytes: number): void {
    if (bytes > MAX_CACHE_SERIALIZED_BYTES) return;
    const existing = this.cache.get(key);
    if (existing) {
      this.cacheBytes -= existing.bytes;
      this.cache.delete(key);
    }
    while (this.cache.size >= 3 || this.cacheBytes + bytes > MAX_CACHE_SERIALIZED_BYTES) {
      const oldest = this.cache.keys().next().value as string;
      this.cacheBytes -= this.cache.get(oldest)!.bytes;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { result, bytes });
    this.cacheBytes += bytes;
  }
}

function validTimelines(result: PerformanceResponse): boolean {
  return (
    Array.isArray(result.timelines) &&
    result.timelines.length <= 3 &&
    result.timelines.every((timeline) => {
      if (
        !["stable", "lazer", "lazer-classic"].includes(timeline.mode) ||
        !Array.isArray(timeline.points) ||
        !Array.isArray(timeline.difficultyPoints)
      )
        return false;
      const full = timeline.fullDifficulty;
      // The official slider factor is an unclamped aim ratio and can exceed one.
      if (
        full != null &&
        ![full.total, full.aim, full.speed, full.reading, full.flashlight, full.sliderFactor].every(
          (value) => Number.isFinite(value) && value >= 0,
        )
      )
        return false;
      // Optional; the engine may leave it out or send null. A present value must be a finite count from zero up.
      const effectiveMiss: unknown = timeline.effectiveMissCount;
      const validCount = typeof effectiveMiss === "number" && Number.isFinite(effectiveMiss) && effectiveMiss >= 0;
      if (effectiveMiss != null && !validCount) return false;
      let previous = -Infinity;
      const validPerformance = timeline.points.every((point) => {
        if (
          ![point.time, point.pp, point.sr].every(Number.isFinite) ||
          point.time < previous ||
          point.pp < 0 ||
          point.sr < 0
        )
          return false;
        previous = point.time;
        return true;
      });
      previous = -Infinity;
      return (
        validPerformance &&
        timeline.difficultyPoints.every((point) => {
          if (!Number.isFinite(point.time) || !Number.isFinite(point.sr) || point.time < previous || point.sr < 0)
            return false;
          previous = point.time;
          return true;
        })
      );
    })
  );
}
