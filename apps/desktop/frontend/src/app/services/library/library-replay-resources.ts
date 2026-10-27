import { randomUUID } from "crypto";
import type { LibraryReplayHandle, LibraryResourceRequest, LibraryResourceTransfer, LibraryResourceChunk } from "../../../../../shared/library-resources";
import { isLibraryExactMapUnavailable } from "../../../../../shared/library-resources";
import type { OsuReplay } from "../../model/OsuReplay";
import { parseLibraryReplay } from "./library-replay-worker";

interface Transport { resource(request: LibraryResourceRequest): Promise<unknown> }
type Parser = typeof parseLibraryReplay;
const MiB = 1024 * 1024;
class AssetUnavailableError extends Error {}
export class LibraryResourceCleanupError extends Error {}
export class LibraryExactMapUnavailableError extends Error {
  constructor(readonly replayId: string, readonly beatmapMd5: string) {
    super("Exact beatmap is unavailable in enabled sources"); this.name = "LibraryExactMapUnavailableError";
  }
}

export class LibraryReplayResourceClient {
  constructor(private readonly api: Transport, private readonly parser: Parser = parseLibraryReplay) {}
  async open(replayId: string, signal: AbortSignal): Promise<LibraryReplayResources> {
    const resources = new LibraryReplayResources(this.api, randomUUID(), signal, this.parser);
    try { await resources.initialize(replayId); return resources; }
    catch (error) { await resources.close(); signal.throwIfAborted(); throw error; }
  }
}

/** One current/replacement replay's resource lifetime. Complete transfers are serialized, including
 * parser input and output; a failed or cancelled parse always releases its main-process session. */
export class LibraryReplayResources {
  private readonly controller = new AbortController();
  private value?: LibraryReplayHandle;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private replayPromise?: Promise<OsuReplay>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly urls = new Set<string>();
  private readonly abort = () => { void this.close().catch(() => undefined); };
  constructor(private readonly api: Transport, private readonly requestId: string,
    private readonly external: AbortSignal, private readonly parser: Parser) {
    external.addEventListener("abort", this.abort, { once: true });
    if (external.aborted) this.abort();
  }
  get handle(): LibraryReplayHandle {
    if (!this.value) throw new Error("Library resource handle is not ready"); return this.value;
  }
  async initialize(replayId: string): Promise<void> {
    const value = await this.call({ method: "open", requestId: this.requestId, replayId }) as LibraryReplayHandle;
    if (value && typeof value === "object" && "state" in value) {
      if (!isLibraryExactMapUnavailable(value) || value.requestId !== this.requestId || value.replayId !== replayId)
        throw new Error("Invalid library resource unavailable reply");
      throw new LibraryExactMapUnavailableError(value.replayId, value.beatmapMd5);
    }
    if (!value || value.requestId !== this.requestId || typeof value.replayId !== "string" ||
        !/^[a-f\d]{64}$/.test(value.replaySha256) || !/^[a-f\d]{64}$/.test(value.mapSha256) || !/^[a-f\d]{32}$/.test(value.beatmapMd5) ||
        !["stable", "replays", "lazer", "imported"].includes(value.sourceKind) || !Array.isArray(value.storyboards) ||
        value.storyboards.length > 8192 || !value.storyboards.every(name => typeof name === "string" && name.length <= 512) ||
        typeof value.assetManifestComplete !== "boolean") throw new Error("Invalid library resource handle");
    this.value = value;
  }
  replay(): Promise<OsuReplay> {
    if (this.closed) return Promise.reject(new Error("Library resources closed"));
    this.replayPromise ??= this.enqueue(async () => {
      const transfer = await this.transfer("replay", undefined, 64 * MiB);
      const replay = await this.parser(transfer.bytes, offset => this.chunk(transfer, offset), this.controller.signal);
      if (replay.replayContentSha256 !== this.handle.replaySha256 || replay.beatmapMd5 !== this.handle.beatmapMd5)
        throw new Error("Parsed replay identity disagrees with verified resource handle");
      return replay;
    }, true);
    return this.replayPromise;
  }
  map(): Promise<string> { return this.enqueue(async () => new TextDecoder().decode(await this.readBytes("map", undefined, 16 * MiB)), true); }
  asset(name: string, maxBytes = 128 * MiB): Promise<Uint8Array> {
    return this.enqueue(() => this.readBytes("asset", name, maxBytes));
  }
  async optionalAsset(name: string, maxBytes = 32 * MiB): Promise<Uint8Array | undefined> {
    try { return await this.asset(name, maxBytes); }
    catch (error) { this.check(); if (error instanceof AssetUnavailableError) return undefined; throw error; }
  }
  async backgroundUrl(name: string): Promise<string | undefined> {
    const bytes = await this.optionalAsset(name, 32 * MiB); this.check();
    if (!bytes) return undefined;
    const url = URL.createObjectURL(new Blob([bytes])); this.urls.add(url); return url;
  }
  private check(): void { this.controller.signal.throwIfAborted(); if (this.closed) throw new Error("Library resources closed"); }
  private enqueue<T>(work: () => Promise<T>, fatal = false): Promise<T> {
    try { this.check(); } catch (error) { return Promise.reject(error); }
    if (this.queued >= 2048) return Promise.reject(new Error("Library asset queue limit reached"));
    this.queued++;
    const result = this.tail.then(async () => {
      this.check();
      try { const result = await work(); this.check(); return result; }
      catch (error) { if (fatal) await this.close(); throw error; }
    }).finally(() => { this.queued--; });
    this.tail = result.then(() => undefined, () => undefined); return result;
  }
  private call(input: LibraryResourceRequest): Promise<unknown> {
    this.check();
    return new Promise((resolve, reject) => {
      const signal = this.controller.signal;
      const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Library resource request aborted"));
      const timeout = setTimeout(() => { this.controller.abort(new Error("Library resource request timed out")); void this.close().catch(() => undefined); }, 60000);
      signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener("abort", abort); };
      const result = Promise.resolve().then(() => { this.check(); return this.api.resource(input); });
      result.then(value => { try { this.check(); resolve(value); } catch (error) { reject(error); } }, reject).finally(cleanup);
      // A never-settling transport still loses listeners/timer on cancellation.
      signal.addEventListener("abort", cleanup, { once: true });
      void result.finally(() => signal.removeEventListener("abort", cleanup)).catch(() => undefined);
    });
  }
  private async transfer(kind: "replay" | "map" | "asset", name: string | undefined, limit: number): Promise<LibraryResourceTransfer> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 * MiB) throw new Error("Invalid resource byte limit");
    const result = await this.call({ method: "transfer", requestId: this.requestId, kind, ...(name !== undefined ? { name } : {}) }) as LibraryResourceTransfer;
    if (kind === "asset" && result?.unavailable === true && result.id === "" && result.bytes === 0)
      throw new AssetUnavailableError("Library asset is unavailable");
    if (!result || typeof result.id !== "string" || !result.id || result.id.length > 128 || !Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.bytes > limit) {
      await this.close(); throw new Error("Library resource transfer exceeds limit");
    }
    return result;
  }
  private async chunk(transfer: LibraryResourceTransfer, offset: number): Promise<LibraryResourceChunk> {
    const result = await this.call({ method: "chunk", requestId: this.requestId, transferId: transfer.id, offset }) as LibraryResourceChunk;
    if (!result || !(result.bytes instanceof Uint8Array) || !result.bytes.length || result.bytes.length > 256 * 1024 ||
        offset + result.bytes.length > transfer.bytes || result.done !== (offset + result.bytes.length === transfer.bytes)) throw new Error("Invalid library resource stream");
    return result;
  }
  private async readBytes(kind: "map" | "asset", name: string | undefined, limit: number): Promise<Uint8Array> {
    // Missing optional assets fail before creating a transfer, allowing the existing skin fallback.
    const transfer = await this.transfer(kind, name, limit);
    try {
      const bytes = new Uint8Array(transfer.bytes); let offset = 0;
      while (offset < bytes.length) { const chunk = await this.chunk(transfer, offset); bytes.set(chunk.bytes, offset); offset += chunk.bytes.length; }
      return bytes;
    } catch (error) { await this.close(); throw error; }
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true; this.external.removeEventListener("abort", this.abort); this.replayPromise = undefined;
      this.closing = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new LibraryResourceCleanupError("Library resource release was not acknowledged")), 5000);
        Promise.resolve().then(() => this.api.resource({ method: "release", requestId: this.requestId }))
          .then(() => resolve(), error => reject(new LibraryResourceCleanupError(error instanceof Error ? error.message : "Library resource release failed")))
          .finally(() => clearTimeout(timeout));
      });
      this.controller.abort();
      for (const url of this.urls) URL.revokeObjectURL(url); this.urls.clear();
    }
    return this.closing;
  }
}
