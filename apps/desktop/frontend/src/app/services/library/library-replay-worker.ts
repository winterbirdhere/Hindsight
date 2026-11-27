import { LibraryReplayParser, LibraryReplayAssembler, LibraryReplayHead, LibraryReplayBatch } from "./library-replay-parser";
import type { OsuReplay } from "../../model/OsuReplay";

interface Response { version: 1; id: number; ok: boolean; data?: unknown; error?: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** One dedicated worker per foreground load. At most one command is admitted at a time. */
export class LibraryReplayWorkerServer {
  private parser?: LibraryReplayParser;
  private readonly controller = new AbortController();
  private lastId = 0;
  private busy = false;
  constructor(private readonly send: (response: Response) => void) {}
  async receive(value: unknown): Promise<void> {
    if (!record(value) || !Number.isSafeInteger(value.id)) return;
    const id = Number(value.id);
    let response: Response;
    let admitted = false;
    try {
      if (value.version !== 1 || id <= this.lastId || this.busy || !record(value.args)) throw new Error("Invalid parser worker request");
      this.busy = true; admitted = true; this.lastId = id;
      const args = value.args; let data: unknown = null;
      if (value.method === "initialize") {
        if (this.parser) throw new Error("Parser is already initialized");
        this.parser = new LibraryReplayParser(Number(args.bytes));
      } else {
        if (!this.parser) throw new Error("Parser is not initialized");
        if (value.method === "append") this.parser.append(Number(args.offset), args.bytes as Uint8Array);
        else if (value.method === "finish") data = await this.parser.finish(this.controller.signal);
        else if (value.method === "batch") data = this.parser.takeBatch();
        else throw new Error("Unknown parser worker operation");
      }
      response = { version: 1, id, ok: true, data };
    } catch (error) {
      if (admitted) this.parser?.release();
      response = { version: 1, id, ok: false, error: (error instanceof Error ? error.message : "Replay parser failed").slice(0, 2048) };
    } finally { if (admitted) this.busy = false; }
    this.send(response);
  }
}

let workerFactory: (() => Worker) | undefined;
export function configureLibraryReplayWorker(factory: (() => Worker) | undefined): void { workerFactory = factory; }
type ReadChunk = (offset: number, signal: AbortSignal) => Promise<{ bytes: Uint8Array; done: boolean }>;

/** Relay bounded chunks; parse and convert in the worker. No inline fallback on worker failure. */
export async function parseLibraryReplay(totalBytes: number, read: ReadChunk, signal: AbortSignal): Promise<OsuReplay> {
  signal.throwIfAborted();
  if (!workerFactory) throw new Error("Library replay parser worker is unavailable");
  const worker = workerFactory();
  let nextId = 0;
  let pending: { id: number; resolve(value: unknown): void; reject(error: Error): void } | undefined;
  let rejectStep: ((error: unknown) => void) | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => { failure ??= error; pending?.reject(failure); rejectStep?.(failure); };
  const abort = () => fail(signal.reason instanceof Error ? signal.reason : new Error("Replay parser cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  worker.onerror = event => { event.preventDefault(); fail(new Error(event.message || "Replay parser worker failed")); };
  worker.onmessageerror = () => fail(new Error("Replay parser worker message failed"));
  worker.onmessage = event => {
    const response = event.data as Response;
    if (!pending || response?.id !== pending.id) return;
    if (response.version !== 1 || typeof response.ok !== "boolean") fail(new Error("Invalid replay parser worker response"));
    else if (response.ok) pending.resolve(response.data);
    else fail(new Error(typeof response.error === "string" ? response.error.slice(0, 2048) : "Replay parser worker failed"));
  };
  const step = async <T>(work: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted(); if (failure) throw failure;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cancellation = new Promise<never>((_resolve, reject) => {
        rejectStep = reject; timer = setTimeout(() => fail(new Error("Replay parser operation timed out")), 60000);
      });
      const result = await Promise.race([work(), cancellation]); signal.throwIfAborted(); if (failure) throw failure;
      return result;
    } finally { clearTimeout(timer); rejectStep = undefined; }
  };
  const request = (method: string, args: Record<string, unknown> = {}, transfer: Transferable[] = []) => step(() =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++nextId; pending = { id, resolve, reject };
      try { worker.postMessage({ version: 1, id, method, args }, transfer); } catch (error) { reject(error); }
    }).finally(() => { pending = undefined; }));
  try {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > 64 * 1024 * 1024) throw new Error("Replay stream size limit");
    await request("initialize", { bytes: totalBytes });
    let offset = 0;
    while (offset < totalBytes) {
      const chunk = await step(() => read(offset, signal));
      if (!(chunk.bytes instanceof Uint8Array) || !chunk.bytes.length || chunk.bytes.length > 256 * 1024 ||
          offset + chunk.bytes.length > totalBytes || chunk.done !== (offset + chunk.bytes.length === totalBytes)) throw new Error("Invalid replay resource stream");
      const length = chunk.bytes.length;
      // Never transfer an oversized backing buffer from an unexpected caller.
      const bytes = chunk.bytes.byteLength === chunk.bytes.buffer.byteLength ? chunk.bytes : Uint8Array.from(chunk.bytes);
      await request("append", { offset, bytes }, [bytes.buffer]); offset += length;
    }
    const assembler = new LibraryReplayAssembler(await request("finish") as LibraryReplayHead);
    for (;;) {
      const batch = await request("batch") as LibraryReplayBatch | null;
      if (batch === null) break;
      assembler.append(batch);
    }
    signal.throwIfAborted(); return assembler.finish();
  } finally {
    signal.removeEventListener("abort", abort); pending = undefined; rejectStep = undefined;
    worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate();
  }
}
