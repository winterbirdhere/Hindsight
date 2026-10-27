import { spawn } from "child_process";
import type { ReplayBlockDecoder } from "@rewind/osu-local/osr-reader";
import { LibraryNativeAdmission,LibraryNativeDrainError } from "./library-native-admission";

export class LibraryLzmaClient {
  private closed = false;
  private cleanupFailure?: Error;
  private active?: { cancel: (error: Error) => void; drained: Promise<void>; outcome: Promise<void> };
  constructor(private readonly executable: () => string, private readonly launch: typeof spawn = spawn,private readonly admission?:LibraryNativeAdmission) {}

  readonly decode:ReplayBlockDecoder=(bytes,request)=>this.admission
    ?this.admission.run("replay-decode",()=>this.decodeDirect(bytes,request),request.signal):this.decodeDirect(bytes,request);
  private readonly decodeDirect: ReplayBlockDecoder = async (bytes, request) => {
    if (this.closed) throw new Error("Replay decoder closed");
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.active) throw new Error("Replay decoder busy");
    request.signal?.throwIfAborted();
    const limits = request.role === "frames" ? [64 * 1024 * 1024, 256 * 1024 * 1024] :
      request.role === "score-info" ? [1024 * 1024, 8 * 1024 * 1024] : undefined;
    if (!limits || bytes.length < 13 || bytes.length > limits[0] || !Number.isSafeInteger(request.maxOutputBytes) ||
        request.maxOutputBytes < 1 || request.maxOutputBytes > limits[1]) throw new Error("Replay decoder size limit");
    const child = this.launch(this.executable(), ["--library-lzma", request.role, String(bytes.length), String(request.maxOutputBytes)],
      { windowsHide: true, shell: false, stdio: "pipe" });
    return new Promise<Buffer>((resolve, reject) => {
      let finished = false;
      let failure: Error | undefined;
      let teardown: ReturnType<typeof setTimeout> | undefined;
      let inputComplete = false;
      let size = 0;
      let offset = 0;
      const chunks: Buffer[] = [];
      let release: () => void = () => undefined;
      const drained = new Promise<void>(done => { release = done; });
      let reportOutcome: () => void = () => undefined;
      const outcome = new Promise<void>(done => { reportOutcome = done; });
      const releaseOwnership = () => {
        if (this.active === owner) this.active = undefined;
        release();
      };
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout); clearTimeout(teardown);
        request.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(Buffer.concat(chunks, size));
        chunks.length = 0;
        reportOutcome();
      };
      const terminate = (error: Error) => {
        if (finished || failure) return;
        failure = error;
        chunks.length = 0;
        clearTimeout(timeout);
        child.stdin?.destroy();
        teardown = setTimeout(() => {
          this.cleanupFailure = new LibraryNativeDrainError("Replay decoder cleanup failed: exit not confirmed");
          finish(this.cleanupFailure);
        }, 2000);
        try { if (!child.kill()) failure = new Error("Replay decoder termination failed"); }
        catch { failure = new Error("Replay decoder termination failed"); }
      };
      const abort = () => terminate(request.signal?.reason instanceof Error ? request.signal.reason : new Error("Replay decoder cancelled"));
      const timeout = setTimeout(() => terminate(new Error("Replay decoder timed out")), 30000);
      const owner = { cancel: terminate, drained, outcome };
      this.active = owner;
      request.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", () => {
        if (child.pid === undefined) { finish(new Error("Replay decoder launch failed")); releaseOwnership(); }
        else terminate(new Error("Replay decoder process failed"));
      });
      child.stdin?.on("error", () => terminate(new Error("Replay decoder input failed")));
      child.stdin?.on("finish", () => { inputComplete = true; });
      child.stdout?.on("error", () => terminate(new Error("Replay decoder output pipe failed")));
      child.stderr?.on("error", () => terminate(new Error("Replay decoder diagnostic pipe failed")));
      child.stdout?.on("data", (chunk: Buffer) => {
        if (finished || failure) return;
        if (chunk.length > request.maxOutputBytes - size) { terminate(new Error("Replay decoder expanded size limit")); return; }
        size += chunk.length; chunks.push(Buffer.from(chunk));
      });
      child.stderr?.resume();
      child.on("close", code => {
        finish(failure ?? (code !== 0 || !inputComplete ? new Error("Replay decoder failed") : undefined));
        releaseOwnership();
      });
      const writeNext = () => {
        if (finished || failure || !child.stdin) return;
        while (offset < bytes.length) {
          const next = Math.min(offset + 64 * 1024, bytes.length);
          const chunk = bytes.subarray(offset, next); offset = next;
          if (!child.stdin.write(chunk)) { child.stdin.once("drain", writeNext); return; }
        }
        child.stdin.end();
      };
      if (request.signal?.aborted) abort();
      else writeNext();
    });
  };

  async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    active?.cancel(new Error("Replay decoder closed"));
    await active?.outcome;
    if (this.cleanupFailure) throw this.cleanupFailure;
    await active?.drained;
  }
}
