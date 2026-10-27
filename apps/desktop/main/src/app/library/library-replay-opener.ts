import { randomUUID } from "crypto";
import type { LibraryReplayHandle, LibraryResourceChunk, LibraryResourceTransfer } from "../../../../shared/library-resources";
import type { LibraryOperation } from "./library-process-client";
import type { LibraryResourceOperation } from "./library-resource-server";
import type { LibraryOpenLocation, LibraryOpenMap, LibraryLocationCursor, LibraryLocationRefresh, LibraryLocationRefreshResult } from "./library-store";
import { LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION } from "../../../../shared/library-analysis";
import type { LibraryNumericalResourceDescriptor } from "../../../../shared/library-analysis";
import { isLibraryCurrentReplayReceipt } from "../../../../shared/library-current-replay";
import type { LibraryCurrentReplayReceipt } from "../../../../shared/library-current-replay";
import { currentReplayDescriptor } from "./library-current-replay-authority";

export interface LibraryCurrentReplayOpenInput {
  location: LibraryOpenLocation; observation: LibraryLocationRefresh; map?: LibraryOpenMap;
  descriptor: LibraryNumericalResourceDescriptor;
}

interface Dependencies {
  analysis?: boolean;
  observeLocation?(ticket:LibraryOpenLocation):void;
  observeMap?(ticket:LibraryOpenMap):void;
  metadata(method: LibraryOperation, args?: Record<string, unknown>): Promise<unknown>;
  resources: { request(method: LibraryResourceOperation, args?: Record<string, unknown>): Promise<unknown>; close(): Promise<void> };
  /** Internal alternate transaction for background preparation; the foreground default is unchanged. */
  publish?(input:{ticket:LibraryOpenLocation;observation:LibraryLocationRefresh;map?:LibraryOpenMap;mapSha256:string;sessionId:string}):Promise<LibraryLocationRefreshResult>;
  /** Foreground observation only: final guard must run immediately before sending the atomic bind. */
  currentReplay?: {
    bind(input: LibraryCurrentReplayOpenInput, assertCurrent: () => void): Promise<LibraryLocationRefreshResult & { currentReplay?: LibraryCurrentReplayReceipt }>;
    release(receipt: LibraryCurrentReplayReceipt): void | Promise<void>;
  };
}
interface Entry { controller: AbortController; sessionId?: string; release?: Promise<void>; ready: boolean }
interface PreparedReplay { beatmapMd5: string; receipt: LibraryLocationRefresh; nativeMap: boolean }
interface PreparedMap { md5: string; sha256: string; ticket?: LibraryOpenMap; storyboards: string[]; assetManifestComplete: boolean }
const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128;
const cursor = (value: unknown): value is LibraryLocationCursor => !!value && typeof value === "object" && !Array.isArray(value) &&
  "sourceId" in value && text(value.sourceId) && "sourceKey" in value && typeof value.sourceKey === "string" &&
  value.sourceKey.length > 0 && value.sourceKey.length <= 32768;
export class LibraryExactMapUnavailableError extends Error {
  constructor(readonly replayId: string, readonly beatmapMd5: string) {
    super("Exact beatmap is unavailable in enabled sources"); this.name = "LibraryExactMapUnavailableError";
  }
}

/** Resolves only an indexed identity. Verification runs outside SQLite; publication is compare-and-swap. */
export class LibraryReplayOpener {
  private readonly entries = new Map<string, Entry>();
  private readonly operations = new Set<Promise<unknown>>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly deps: Dependencies) {}
  open(requestId: string, replayId: string, assertCurrent: () => void): Promise<LibraryReplayHandle> {
    if (this.closed) return Promise.reject(new Error("Library replay opener closed"));
    if (!text(requestId) || !text(replayId) || this.entries.has(requestId)) return Promise.reject(new Error("Invalid library open identity"));
    if (this.entries.size >= 2) return Promise.reject(new Error("Library resource session limit reached"));
    const entry: Entry = { controller: new AbortController(), ready: false }; this.entries.set(requestId, entry);
    const work = this.prepare(requestId, replayId, entry, assertCurrent);
    this.operations.add(work); void work.finally(() => this.operations.delete(work)).catch(() => undefined);
    return work;
  }
  private async prepare(requestId: string, replayId: string, entry: Entry, assertCurrent: () => void): Promise<LibraryReplayHandle> {
    const check = () => { entry.controller.signal.throwIfAborted(); assertCurrent(); if (this.closed) throw new Error("Library replay opener closed"); };
    let after: LibraryLocationCursor | undefined, attempted = 0, lastError: { value: unknown } | undefined;
    let unavailable: LibraryExactMapUnavailableError | undefined;
    try {
      do {
        check();
        const page = await this.deps.metadata("prepare-open", { replayId, ...(this.deps.analysis ? {analysis:true} : {}), ...(after ? { after } : {}) }) as { items: LibraryOpenLocation[]; next?: LibraryLocationCursor };
        check();
        if (!Array.isArray(page.items) || page.items.length > 8 || (page.next !== undefined &&
            (!cursor(page.next) || !page.items.length || JSON.stringify(page.next) === JSON.stringify(after))))
          throw new Error("Invalid selected replay location page");
        for (const ticket of page.items) {
          if (++attempted > 64) throw new Error("Selected replay location attempt limit reached");
          check(); entry.sessionId = randomUUID(); entry.release = undefined;
          this.deps.observeLocation?.(ticket);
          let currentReplay: LibraryCurrentReplayReceipt | undefined;
          try {
            const prepared = await this.deps.resources.request("begin", { sessionId: entry.sessionId, ticket }) as PreparedReplay; check();
            if (typeof prepared.beatmapMd5 !== "string" || !/^[a-f\d]{32}$/.test(prepared.beatmapMd5) || prepared.receipt?.available !== true ||
                typeof prepared.receipt.sha256 !== "string" || !/^[a-f\d]{64}$/.test(prepared.receipt.sha256) ||
                typeof prepared.nativeMap !== "boolean")
              throw new Error("Invalid verified replay receipt");
            const map = await this.prepareMap(entry, prepared, check, replayId); check();
            const publication={ticket,observation:prepared.receipt,...(map.ticket?{map:map.ticket}:{})};
            let descriptor: LibraryNumericalResourceDescriptor | undefined;
            if (this.deps.currentReplay && !this.deps.publish) {
              try {
                const value = await this.deps.resources.request("describe-analysis", { sessionId: entry.sessionId }); check();
                const candidate = currentReplayDescriptor(value as LibraryNumericalResourceDescriptor), binding = candidate.input.binding;
                if (binding.exactMapAndProfile && binding.replaySha256 === prepared.receipt.sha256 &&
                  binding.mapSha256 === map.sha256 && binding.mapMd5 === prepared.beatmapMd5) descriptor = candidate;
              } catch { check(); } // Optional unsupported numerical evidence does not prevent ordinary replay viewing.
            }
            check();
            const committed = this.deps.publish ? await this.deps.publish({...publication,mapSha256:map.sha256,sessionId:entry.sessionId})
              : descriptor && this.deps.currentReplay ? await this.deps.currentReplay.bind({ location: ticket,
                observation: prepared.receipt, ...(map.ticket ? { map: map.ticket } : {}), descriptor }, check)
                : await this.deps.metadata("commit-open", publication) as LibraryLocationRefreshResult;
            currentReplay = "currentReplay" in committed ? committed.currentReplay as LibraryCurrentReplayReceipt | undefined : undefined;
            check();
            if (committed.state !== "applied") throw new Error("Selected replay publication " + committed.state + "; retry explicitly");
            if (currentReplay && (!isLibraryCurrentReplayReceipt(currentReplay) || currentReplay.replayId !== committed.replayId ||
              currentReplay.replaySha256 !== prepared.receipt.sha256 || currentReplay.mapSha256 !== map.sha256 ||
              currentReplay.mapMd5 !== prepared.beatmapMd5 || currentReplay.numericalInputKey !== descriptor?.target.inputKey ||
              currentReplay.numericalVersion !== descriptor?.target.producerVersion || currentReplay.parserVersion !== LIBRARY_REPLAY_PARSER_VERSION ||
              currentReplay.preparationVersion !== LIBRARY_RESOURCE_PREPARATION_VERSION))
              throw new Error("Invalid current replay resource receipt");
            entry.ready = true;
            return { requestId, replayId: committed.replayId, sourceKind: ticket.kind, replaySha256: prepared.receipt.sha256 as string,
              beatmapMd5: prepared.beatmapMd5, mapSha256: map.sha256, storyboards: map.storyboards, assetManifestComplete: map.assetManifestComplete,
              ...(currentReplay ? { currentReplay } : {}) };
          } catch (error) {
            if (error instanceof LibraryExactMapUnavailableError) {
              if (unavailable && unavailable.beatmapMd5 !== error.beatmapMd5)
                lastError = { value: new Error("Selected replay locations disagree on exact map identity") };
              else unavailable = error;
            } else lastError = { value: error };
            try { if (currentReplay) await this.deps.currentReplay?.release(currentReplay); }
            finally { await this.releaseAttempt(entry); }
            check();
          }
        }
        if (page.next && !page.items.length) throw new Error("Selected replay page did not advance");
        after = page.next;
      } while (after);
      if (lastError) throw lastError.value;
      throw unavailable ?? new Error("No enabled source can open this replay");
    } catch (error) {
      if (this.entries.get(requestId) === entry) this.entries.delete(requestId);
      entry.controller.abort(); await this.releaseAttempt(entry); throw error;
    }
  }
  private async prepareMap(entry: Entry, replay: PreparedReplay, check: () => void, replayId: string): Promise<PreparedMap> {
    const verify = (map: PreparedMap) => {
      if (map.md5 !== replay.beatmapMd5 || !/^[a-f\d]{64}$/.test(map.sha256) || !Array.isArray(map.storyboards) ||
          map.storyboards.length > 8192 || !map.storyboards.every(name => typeof name === "string" && name.length <= 512) ||
          typeof map.assetManifestComplete !== "boolean") throw new Error("Invalid verified map receipt");
      return map;
    };
    let lastError: unknown, after: LibraryLocationCursor | undefined, attempted = 0;
    if (replay.nativeMap) {
      try { const map = await this.deps.resources.request("prepare-map", { sessionId: entry.sessionId }) as PreparedMap; check(); return verify(map); }
      catch (error) { lastError = error; check(); }
    }
    do {
      const page = await this.deps.metadata("prepare-map", { md5: replay.beatmapMd5, ...(after ? { after } : {}) }) as { items: LibraryOpenMap[]; next?: LibraryLocationCursor };
      check();
      if (!Array.isArray(page.items) || page.items.length > 8 || (page.next !== undefined &&
          (!cursor(page.next) || !page.items.length || JSON.stringify(page.next) === JSON.stringify(after))))
        throw new Error("Invalid selected map location page");
      for (const candidate of page.items) {
        if (++attempted > 64) throw new Error("Selected map location attempt limit reached");
        try {
          this.deps.observeMap?.(candidate);
          const map = await this.deps.resources.request("prepare-map", { sessionId: entry.sessionId, candidate }) as PreparedMap;
          check(); return verify(map);
        } catch (error) { lastError = error; check(); }
      }
      after = page.next;
    } while (after);
    if (!replay.nativeMap && attempted === 0) throw new LibraryExactMapUnavailableError(replayId, replay.beatmapMd5);
    throw lastError ?? new Error("Exact beatmap could not be verified");
  }
  private current(requestId: string): Entry {
    const entry = this.entries.get(requestId);
    if (this.closed || !entry?.ready || !entry.sessionId || entry.controller.signal.aborted) throw new Error("Library resource session expired");
    return entry;
  }
  async transfer(requestId: string, kind: "replay" | "map" | "asset", name?: string): Promise<LibraryResourceTransfer> {
    const entry = this.current(requestId);
    const result = await this.deps.resources.request("transfer", { sessionId: entry.sessionId, kind, ...(name !== undefined ? { name } : {}) });
    if (this.current(requestId) !== entry) throw new Error("Library resource session expired");
    return result as LibraryResourceTransfer;
  }
  async chunk(requestId: string, transferId: string, offset: number): Promise<LibraryResourceChunk> {
    const entry = this.current(requestId);
    const result = await this.deps.resources.request("chunk", { sessionId: entry.sessionId, transferId, offset });
    if (this.current(requestId) !== entry) throw new Error("Library resource session expired");
    return result as LibraryResourceChunk;
  }
  private releaseAttempt(entry: Entry): Promise<void> {
    const sessionId = entry.sessionId; entry.sessionId = undefined; entry.ready = false;
    if (sessionId) entry.release = this.deps.resources.request("release", { sessionId }).then(() => undefined);
    return entry.release ?? Promise.resolve();
  }
  release(requestId: string): Promise<void> {
    const entry = this.entries.get(requestId); if (!entry) return Promise.resolve();
    this.entries.delete(requestId); entry.controller.abort(); return this.releaseAttempt(entry);
  }
  async releaseDocument(): Promise<void> {
    const results = await Promise.allSettled([...this.entries.keys()].map(id => this.release(id)));
    const failed = results.find(result => result.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      // The utility close aborts all of its sessions. Do not enqueue individual releases and
      // immediately close their channel before those requests have even been posted.
      for (const entry of this.entries.values()) { entry.controller.abort(); entry.sessionId = undefined; entry.ready = false; }
      this.entries.clear();
      this.closing = (async () => {
        const results = await Promise.allSettled([this.deps.resources.close(), Promise.allSettled([...this.operations])]);
        const failed = results.find(result => result.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
      })();
    }
    return this.closing;
  }
}
