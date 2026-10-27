import type { LibraryPassiveResources } from "./library-passive-resources";
import { LIBRARY_PASSIVE_ART_MAX_BYTES, LIBRARY_PASSIVE_CHUNK_BYTES } from "../../../../shared/library-passive-resources";
import type { LibraryPassiveResourceRequest } from "../../../../shared/library-passive-resources";
import { LibraryNativeDrainError } from "./library-native-admission";
import { createHash } from "crypto";
type Entry = { controller: AbortController; work: Promise<unknown>; bytes?: Buffer; offset: number };
class PassiveDocumentExpiredError extends Error {}
const diagnosticId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
function request(value: unknown): LibraryPassiveResourceRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error("Invalid passive resource request");
  const row = value as Record<string, unknown>, fields: Record<string, string[]> = { artwork: ["replayId"], strip: ["replayId"], reveal: ["replayId"], chunk: ["offset"], release: [] };
  for (const key of Reflect.ownKeys(value)) if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), "value")) throw Error("Invalid passive resource request");
  const text = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_.:/+-]{1,128}$/.test(v);
  if (!text(row.requestId) || typeof row.method !== "string" || !Object.prototype.hasOwnProperty.call(fields, row.method) || Object.keys(row).some(key => !["method", "requestId", ...fields[row.method as string]].includes(key))) throw Error("Invalid passive resource request");
  if (["artwork", "strip", "reveal"].includes(row.method) && !text(row.replayId)) throw Error("Invalid passive replay identity");
  if (row.method === "chunk" && (!Number.isSafeInteger(row.offset) || Number(row.offset) < 0 || Number(row.offset) > LIBRARY_PASSIVE_ART_MAX_BYTES)) throw Error("Invalid passive resource offset");
  return row as unknown as LibraryPassiveResourceRequest;
}
export class LibraryPassiveResourceApi {
  private readonly entries = new Map<string, Entry>();
  private generation = 0;
  private active = 0;
  private revealing = false;
  private drainFailure?: Error;
  private closed = false;
  constructor(private readonly reader: Pick<LibraryPassiveResources, "artwork" | "strip" | "revealPath">,
    private readonly showItemInFolder: (path: string) => void | Promise<void>) {}
  async receive(value: unknown, assertCurrent: () => void): Promise<unknown> {
    const generation = this.generation, check = () => { assertCurrent(); if (this.closed || generation !== this.generation) throw new PassiveDocumentExpiredError("Passive resource document expired"); };
    assertCurrent(); const input = request(value);
    // Cleanup is valid during/after close, but still validates the sender and request.
    if (input.method === "release") { await this.release(input.requestId); return; }
    check();
    if (this.drainFailure) throw this.drainFailure;
    if (input.method === "chunk") {
      const entry = this.entries.get(input.requestId);
      if (!entry?.bytes || input.offset !== entry.offset || input.offset >= entry.bytes.length) throw Error("Invalid passive resource transfer");
      const bytes = Buffer.from(entry.bytes.subarray(input.offset, input.offset + LIBRARY_PASSIVE_CHUNK_BYTES)); entry.offset += bytes.length;
      return { bytes, done: entry.offset === entry.bytes.length };
    }
    if (this.entries.has(input.requestId) || this.entries.size >= 8 || (input.method === "reveal" ? this.revealing : this.active >= 2)) throw Error("Passive resource queue is busy");
    const entry: Entry = { controller: new AbortController(), work: Promise.resolve(), offset: 0 }; this.entries.set(input.requestId, entry);
    if (input.method === "reveal") this.revealing = true; else this.active++;
    const current = () => { check(); entry.controller.signal.throwIfAborted(); };
    entry.work = Promise.resolve().then(async () => {
      current();
      if (input.method === "artwork") {
        const bytes = await this.reader.artwork(input.replayId, entry.controller.signal); current();
        if (!bytes) return { state: "unavailable" };
        if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > LIBRARY_PASSIVE_ART_MAX_BYTES) throw Error("Invalid passive artwork output");
        entry.bytes = bytes; return { state: "ready", bytes: bytes.length, mime: "image/png" };
      }
      if (input.method === "strip") { const strip = await this.reader.strip(input.replayId, entry.controller.signal); current(); return strip ?? null; }
      const path = await this.reader.revealPath(input.replayId, entry.controller.signal); current(); await this.showItemInFolder(path); current(); return { revealed: true };
    });
    try { return await entry.work; }
    catch (error) {
      const uncertain = this.recordDrainFailure(error), signal = entry.controller.signal;
      // Abort requested is only correlation. Only this owned signal's exact reason
      // proves acknowledgement; an AbortError name or a late abort does not.
      const outcome = uncertain ? "ownership-uncertain" : error instanceof PassiveDocumentExpiredError ? "document-expired"
        : signal.aborted && error === signal.reason ? "acknowledged-cancellation" : "unclassified-failure";
      const message = outcome === "acknowledged-cancellation" ? `Library ${input.method} request was cancelled` : `Library ${input.method} could not be verified`;
      // Keep raw identities, paths, underlying messages and bytes out of IPC logs.
      throw Error(`${message} [method=${input.method} request=${diagnosticId(input.requestId)} replay=${diagnosticId(input.replayId)} outcome=${outcome} abortRequested=${signal.aborted}]`);
    }
    finally { if (input.method === "reveal") this.revealing = false; else this.active--; if (input.method !== "artwork" || !entry.bytes) this.entries.delete(input.requestId); }
  }
  private recordDrainFailure(error: unknown): boolean {
    const uncertain = error instanceof LibraryNativeDrainError || !!(error && typeof error === "object" && "libraryNativeOwnershipUncertain" in error && error.libraryNativeOwnershipUncertain === true);
    if (uncertain)
      this.drainFailure ??= Error("Native passive resource ownership is unconfirmed");
    return uncertain;
  }
  private async release(id: string): Promise<void> {
    const entry = this.entries.get(id); if (!entry) { if (this.drainFailure) throw this.drainFailure; return; }
    entry.controller.abort();
    // select/reader callbacks must settle only after their actual I/O/native ownership drains.
    await entry.work.catch(error => this.recordDrainFailure(error)); entry.bytes = undefined;
    if (this.entries.get(id) === entry) this.entries.delete(id);
    if (this.drainFailure) throw this.drainFailure;
  }
  async releaseDocument(): Promise<void> {
    this.generation++; const results = await Promise.allSettled([...this.entries.keys()].map(id => this.release(id)));
    if (this.drainFailure) throw this.drainFailure;
    const failure = results.find(result => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
  }
  async close(): Promise<void> { this.closed = true; await this.releaseDocument(); }
}
