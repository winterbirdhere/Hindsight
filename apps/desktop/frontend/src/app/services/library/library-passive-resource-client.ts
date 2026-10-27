import { createHash, randomUUID } from "crypto";
import { LibraryErrorStrip, validateLibraryErrorStrip } from "../../../../../shared/library-error-strip";
import { LIBRARY_PASSIVE_ART_MAX_BYTES, LIBRARY_PASSIVE_CHUNK_BYTES } from "../../../../../shared/library-passive-resources";
import type { LibraryPassiveResourceRequest } from "../../../../../shared/library-passive-resources";
import { LIBRARY_RESOURCE_CHANGE_IDS } from "../../../../../shared/library-resource-changes";
export interface LibraryPassiveResourceTransport { resource(request: LibraryPassiveResourceRequest): Promise<unknown> }
export interface LibraryPassiveDisplayResource { artUrl?: string; artworkPending?: boolean; strip?: LibraryErrorStrip; artworkError?: string; stripError?: string }
export type LibraryPassiveResourceSnapshot = Readonly<Record<string, LibraryPassiveDisplayResource>>;
export interface LibraryPassiveResourceUrls { create(bytes: Uint8Array): string; revoke(url: string): void }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:/+-]{1,128}$/.test(value);
const defaultUrls: LibraryPassiveResourceUrls = {
  create: bytes => URL.createObjectURL(new Blob([bytes], { type: "image/png" })),
  revoke: url => URL.revokeObjectURL(url),
};
type Run = { controller: AbortController; work: Promise<LibraryPassiveResourceSnapshot>; publish?: () => void };
type ArtworkRun = { key: string; controller: AbortController };
type ResourceLease = { retain(): () => void; release(): void };
type ArtworkContent = { url: string; bytes: number; lease: ResourceLease };
type ArtworkEntry = { value: LibraryPassiveDisplayResource; lease: ResourceLease; digest?: string; generation: number; epoch: number; staleVisible?: boolean; content?: ArtworkContent };
const noRelease = () => undefined;
const snapshotLeases = new WeakMap<object, ResourceLease>();
const snapshotEntries = new WeakMap<object, ReadonlyMap<string, ResourceLease>>();

// Snapshot identity is the ownership token. A retired snapshot cannot resurrect a URL.
export function retainLibraryPassiveResourceSnapshot(snapshot: object): () => void {
  return snapshotLeases.get(snapshot)?.retain() ?? noRelease;
}
/** Retain only the overlapping display entries; removing a row must not retire a
 * neighbour's URL while its replacement viewport is still being read. */
export function selectLibraryPassiveResourceSnapshot<T extends Readonly<Record<string, LibraryPassiveDisplayResource | undefined>>>(snapshot: T, ids: readonly string[]): T {
  const result = Object.freeze(Object.fromEntries(ids.filter(id => snapshot[id] !== undefined).map(id => [id, snapshot[id]]))) as T;
  const entries = new Map(ids.flatMap(id => {
    const lease = snapshotEntries.get(snapshot)?.get(id);
    return lease ? [[id, lease] as const] : [];
  }));
  snapshotEntries.set(result, entries);
  snapshotLeases.set(result, { release: noRelease, retain: () => {
    const releases = [...entries.values()].map(lease => lease.retain());
    return () => releases.forEach(release => release());
  } });
  return result;
}
function resourceLease(retire: () => void): ResourceLease {
  let owners = 1;
  const releaseOwner = () => {
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--owners === 0) retire();
    };
  };
  return { release: releaseOwner(), retain: () => {
    if (!owners) return noRelease;
    owners++;
    return releaseOwner();
  } };
}
export class LibraryPassiveResourceClient {
  // At most 32 active replay aliases (8 MiB encoded) plus 256 inactive aliases
  // owning at most 32 MiB of unique content. Committed renders hold separate
  // leases. Map insertion order is the inactive alias LRU order.
  private readonly artwork = new Map<string, ArtworkEntry>();
  // Lookup only: the registry owns no lease and cannot keep a retired URL alive.
  // New replay IDs join only after their own complete verified payload arrives.
  private readonly content = new Map<string, ArtworkContent>();
  private activeArtworkIds = new Set<string>();
  private artworkGeneration = 0;
  // Epochs exist only for retained, active or admitted IDs, never event history.
  private readonly artworkEpochs = new Map<string, number>();
  private readonly readingArtworkIds = new Set<string>();
  private nextArtworkEpoch = 0;
  private releaseSnapshot?: () => void;
  private strip?: { id: string; value: LibraryPassiveDisplayResource; generation: number };
  private stripGeneration = 0;
  private run?: Run;
  private artworkRun?: ArtworkRun;
  private readonly reveals = new Set<{ controller: AbortController; work: Promise<void> }>();
  private closed = false;
  private cleanupFailed = false;
  constructor(private readonly transport: LibraryPassiveResourceTransport, private readonly urls: LibraryPassiveResourceUrls = defaultUrls) {}
  private call(input: LibraryPassiveResourceRequest, signal?: AbortSignal, timeout = 15000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(value); };
      const abort = () => finish(Error("Passive resource request cancelled"));
      const timer = setTimeout(() => finish(Error("Passive resource request timed out")), timeout);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      Promise.resolve().then(() => this.transport.resource(input)).then(value => finish(undefined, value), error => finish(error));
    });
  }
  private async release(requestId: string): Promise<void> {
    try { await this.call({ method: "release", requestId }, undefined, 5000); }
    catch { this.cleanupFailed = true; throw Error("Passive resource cleanup did not complete"); }
  }
  private async readArtwork(replayId: string, signal: AbortSignal): Promise<Uint8Array | undefined> {
    const requestId = randomUUID();
    try {
      const descriptor = await this.call({ method: "artwork", requestId, replayId }, signal);
      if (object(descriptor) && descriptor.state === "unavailable" && Object.keys(descriptor).length === 1) return;
      if (!object(descriptor) || descriptor.state !== "ready" || descriptor.mime !== "image/png" || !Number.isSafeInteger(descriptor.bytes) || Number(descriptor.bytes) < 1 || Number(descriptor.bytes) > LIBRARY_PASSIVE_ART_MAX_BYTES) throw Error("Invalid passive artwork reply");
      const bytes = new Uint8Array(Number(descriptor.bytes)); let offset = 0;
      while (offset < bytes.length) {
        const chunk = await this.call({ method: "chunk", requestId, offset }, signal);
        if (!object(chunk) || !(chunk.bytes instanceof Uint8Array) || chunk.bytes.length < 1 || chunk.bytes.length > LIBRARY_PASSIVE_CHUNK_BYTES || offset + chunk.bytes.length > bytes.length || chunk.done !== (offset + chunk.bytes.length === bytes.length)) throw Error("Invalid passive artwork chunk");
        bytes.set(chunk.bytes, offset); offset += chunk.bytes.length;
      }
      signal.throwIfAborted(); return bytes;
    } finally { await this.release(requestId); }
  }
  private async readStrip(replayId: string, signal: AbortSignal): Promise<LibraryPassiveDisplayResource> {
    const requestId = randomUUID();
    try {
      const entry = await this.call({ method: "strip", requestId, replayId }, signal);
      if (entry === null) return {};
      if (!object(entry) || !object(entry.target) || entry.target.slot !== "numerical" || entry.target.stage !== "S" || JSON.stringify(entry).length > 72 * 1024) throw Error("Invalid passive strip reply");
      if (entry.result === undefined) return {};
      validateLibraryErrorStrip(entry.result);
      return entry.result.state === "known" ? { strip: entry.result.value } : {};
    } finally { await this.release(requestId); }
  }
  private pruneInactiveArtwork(): void {
    const inactive: [string, ArtworkEntry][] = [], activeContent = new Set<ArtworkContent>();
    for (const id of this.activeArtworkIds) { const content = this.artwork.get(id)?.content; if (content) activeContent.add(content); }
    for (const [id, entry] of this.artwork) {
      if (this.activeArtworkIds.has(id)) continue;
      entry.staleVisible = false;
      if (!entry.content || entry.generation !== this.artworkGeneration) {
        entry.lease.release(); this.artwork.delete(id);
      } else inactive.push([id, entry]);
    }
    const inactiveReferences = new Map<ArtworkContent, number>(); let bytes = 0;
    for (const [, { content }] of inactive) {
      if (!content || activeContent.has(content)) continue;
      if (!inactiveReferences.has(content)) bytes += content.bytes;
      inactiveReferences.set(content, (inactiveReferences.get(content) ?? 0) + 1);
    }
    let count = inactive.length;
    for (const [id, entry] of inactive) {
      if (count <= 256 && bytes <= 32 * 1024 * 1024) break;
      const content = entry.content;
      if (content && !activeContent.has(content)) {
        const references = (inactiveReferences.get(content) ?? 0) - 1;
        if (references > 0) inactiveReferences.set(content, references);
        else { inactiveReferences.delete(content); bytes -= content.bytes; }
      }
      count--; entry.lease.release(); this.artwork.delete(id);
    }
    this.pruneArtworkEpochs();
  }
  private pruneArtworkEpochs(): void {
    for (const id of this.artworkEpochs.keys())
      if (!this.artwork.has(id) && !this.activeArtworkIds.has(id) && !this.readingArtworkIds.has(id)) this.artworkEpochs.delete(id);
  }
  private artworkCurrentEntry(id: string, entry?: ArtworkEntry): boolean {
    return entry?.generation === this.artworkGeneration && entry.epoch === (this.artworkEpochs.get(id) ?? 0);
  }
  private shareArtwork(bytes: Uint8Array, digest: string): Pick<ArtworkEntry, "value" | "content" | "lease"> {
    const existing = this.content.get(digest);
    if (existing) return { value: { artUrl: existing.url }, content: existing, lease: resourceLease(existing.lease.retain()) };
    const url = this.urls.create(bytes);
    const content: ArtworkContent = { url, bytes: bytes.byteLength, lease: resourceLease(() => {
      // A held old-owner render must not remove a newer owner's digest entry.
      if (this.content.get(digest) === content) this.content.delete(digest);
      this.urls.revoke(url);
    }) };
    this.content.set(digest, content);
    return { value: { artUrl: url }, content, lease: resourceLease(content.lease.release) };
  }
  private snapshot(ids: readonly string[], selected?: string): LibraryPassiveResourceSnapshot {
    const result: Record<string, LibraryPassiveDisplayResource> = Object.create(null);
    const releases: (() => void)[] = [], entries = new Map<string, ResourceLease>();
    for (const id of ids) {
      const entry = this.artwork.get(id);
      if (entry && (this.artworkCurrentEntry(id, entry) || entry.staleVisible)) {
        result[id] = { ...entry.value }; releases.push(entry.lease.retain()); entries.set(id, entry.lease);
      }
    }
    // A ready strip must not wait for artwork or imply known artwork absence.
    if (selected && this.strip?.id === selected)
      result[selected] = { ...result[selected], ...this.strip.value, ...(result[selected] === undefined ? { artworkPending: true } : {}) };
    for (const value of Object.values(result)) Object.freeze(value);
    const lease = resourceLease(() => releases.forEach(release => release()));
    snapshotLeases.set(result, lease); snapshotEntries.set(result, entries);
    const previous = this.releaseSnapshot;
    this.releaseSnapshot = lease.release; previous?.();
    return Object.freeze(result);
  }
  async update(desired: { artworkIds: readonly string[]; stripReplayId?: string; onUpdate?: (snapshot: LibraryPassiveResourceSnapshot) => void }, signal?: AbortSignal): Promise<LibraryPassiveResourceSnapshot> {
    if (this.closed || this.cleanupFailed) throw Error("Passive resource client is unavailable");
    if (!Array.isArray(desired.artworkIds) || desired.artworkIds.length > 32 || desired.artworkIds.some(id => !identity(id)) || desired.stripReplayId !== undefined && !identity(desired.stripReplayId)) throw Error("Invalid passive viewport request");
    const ids = [...new Set(desired.artworkIds)], selected = desired.stripReplayId, previous = this.run;
    previous?.controller.abort();
    this.releaseSnapshot?.(); this.releaseSnapshot = undefined;
    this.activeArtworkIds = new Set(ids);
    for (const id of ids) { const entry = this.artwork.get(id); if (entry) { this.artwork.delete(id); this.artwork.set(id, entry); } }
    this.pruneInactiveArtwork();
    if (this.strip?.id !== selected) this.strip = undefined;
    // Reordering priority alone does not revoke an admitted matching read.
    const key = JSON.stringify([...ids].sort());
    if (this.artworkRun?.key !== key || this.artworkRun.controller.signal.aborted) {
      this.artworkRun?.controller.abort();
      this.artworkRun = { key, controller: new AbortController() };
    }
    const artworkRun = this.artworkRun, controller = new AbortController();
    const run: Run = { controller, work: Promise.resolve({}) }; this.run = run;
    const abort = () => {
      controller.abort();
      // A synchronous same-viewport replacement may retain its artwork ownership. A route
      // abort without a replacement still cancels/drains before any subsequent run starts.
      void Promise.resolve().then(() => { if (this.run === run) artworkRun.controller.abort(); });
    };
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const current = () => !this.closed && this.run === run && !controller.signal.aborted;
    const artworkCurrent = () => !this.closed && this.artworkRun === artworkRun && !artworkRun.controller.signal.aborted;
    const publish = () => { if (current() && desired.onUpdate) desired.onUpdate(this.snapshot(ids, selected)); };
    run.publish = publish;
    run.work = (async () => {
      await previous?.work.catch(() => undefined);
      if (!current()) return {};
      if (this.cleanupFailed) throw Error("Passive resource cleanup did not complete");
      const generation = this.artworkGeneration, stripGeneration = this.stripGeneration;
      const missing = ids.filter(id => !this.artworkCurrentEntry(id, this.artwork.get(id))); let next = 0;
      const worker = async () => {
        // A replacement may keep these admitted reads, but owns the next
        // priority order once they drain. Do not finish an obsolete queue first.
        while (!this.cleanupFailed && artworkCurrent() && current() && next < missing.length) {
          const id = missing[next++], epoch = this.artworkEpochs.get(id) ?? 0;
          const fresh = () => artworkCurrent() && generation === this.artworkGeneration && epoch === (this.artworkEpochs.get(id) ?? 0);
          let entry: ArtworkEntry;
          this.readingArtworkIds.add(id);
          try {
            const bytes = await this.readArtwork(id, artworkRun.controller.signal); if (!fresh()) continue;
            const digest = bytes ? createHash("sha256").update(bytes).digest("hex") : undefined;
            const previous = this.artwork.get(id);
            if (digest && previous?.digest === digest) {
              previous.generation = generation; previous.epoch = epoch; previous.staleVisible = false;
              this.run?.publish?.(); continue;
            }
            entry = { ...(bytes && digest ? this.shareArtwork(bytes, digest) : { value: {}, lease: resourceLease(noRelease) }), digest, generation, epoch };
          } catch {
            if (!fresh()) continue;
            entry = { value: { artworkError: "Artwork could not be verified" }, generation, epoch, lease: resourceLease(noRelease) };
          } finally { this.readingArtworkIds.delete(id); }
          if (fresh()) {
            const previous = this.artwork.get(id);
            previous?.lease.release();
            this.artwork.set(id, entry);
            // Losing an active reference can move shared bytes into the inactive
            // budget, including on an unavailable/error result. Reclassify before publication.
            if (previous?.content && previous.content !== entry.content) this.pruneInactiveArtwork();
            this.run?.publish?.();
          }
          else entry.lease.release();
          if (this.cleanupFailed) return;
        }
      };
      // The strip shares one of the two admission lanes; it cannot block the
      // other artwork lane or increase the main API's concurrency ceiling.
      const stripThenArtwork = async () => {
        if (selected && this.strip?.generation !== stripGeneration) {
          let value: LibraryPassiveDisplayResource;
          try { value = await this.readStrip(selected, controller.signal); } catch { value = { stripError: "Cached error strip could not be verified" }; }
          if (current() && stripGeneration === this.stripGeneration) { this.strip = { id: selected, value, generation: stripGeneration }; publish(); }
        }
        await worker();
      };
      await Promise.all([stripThenArtwork(), worker()]); if (!current()) return {};
      return this.snapshot(ids, selected);
    })().finally(() => { signal?.removeEventListener("abort", abort); this.pruneArtworkEpochs(); });
    // Publish only after installing the drain promise: a synchronous subscriber
    // may replace this run. Cached hits still precede any awaited previous drain.
    publish();
    return run.work;
  }
  async revealFile(replayId: string): Promise<void> {
    if (this.closed || this.cleanupFailed || !identity(replayId) || this.reveals.size >= 1) throw Error("Replay reveal is unavailable");
    const requestId = randomUUID(), controller = new AbortController(), pending = { controller, work: Promise.resolve() };
    this.reveals.add(pending);
    pending.work = (async () => {
      try { const result = await this.call({ method: "reveal", requestId, replayId }, controller.signal); if (!object(result) || result.revealed !== true) throw Error("Replay file could not be revealed"); }
      finally { await this.release(requestId); }
    })();
    try { await pending.work; } finally { this.reveals.delete(pending); }
  }
  invalidate(options: { artwork?: boolean; strip?: boolean; preserveArtwork?: boolean; artworkIds?: readonly string[] } = {}): void {
    if (options.artworkIds !== undefined) {
      if (!Array.isArray(options.artworkIds) || options.artworkIds.length > LIBRARY_RESOURCE_CHANGE_IDS || options.artworkIds.some(id => !identity(id)))
        throw Error("Invalid passive artwork scope");
      if (options.artwork !== false) {
        for (const id of new Set(options.artworkIds)) {
          if (!this.artwork.has(id) && !this.activeArtworkIds.has(id) && !this.readingArtworkIds.has(id)) continue;
          const entry = this.artwork.get(id);
          if (entry) entry.staleVisible = this.activeArtworkIds.has(id) && (this.artworkCurrentEntry(id, entry) || entry.staleVisible === true);
          this.artworkEpochs.set(id, ++this.nextArtworkEpoch);
        }
      }
      // Apply targeted fences immediately. Unrelated admitted reads keep their
      // controller and drain normally; a later update reads only stale IDs.
      if (options.strip !== false) this.stripGeneration++;
      return;
    }
    this.run?.controller.abort();
    if (options.strip !== false) {
      this.stripGeneration++;
      // Preserve the selected display during same-owner revalidation only.
      if (options.artwork !== false && !options.preserveArtwork) this.strip = undefined;
    }
    this.releaseSnapshot?.(); this.releaseSnapshot = undefined;
    if (options.artwork !== false) {
      if (options.preserveArtwork)
        for (const [id, entry] of this.artwork) entry.staleVisible = this.activeArtworkIds.has(id) && (this.artworkCurrentEntry(id, entry) || entry.staleVisible === true);
      this.artworkGeneration++;
      this.artworkRun?.controller.abort();
      this.artworkEpochs.clear();
      if (!options.preserveArtwork) {
        this.content.clear();
        for (const entry of this.artwork.values()) entry.lease.release();
        this.artwork.clear();
      }
      else this.pruneInactiveArtwork();
    }
  }
  async dispose(): Promise<void> {
    this.closed = true; this.invalidate(); for (const pending of this.reveals) pending.controller.abort();
    await Promise.all([this.run?.work, ...[...this.reveals].map(pending => pending.work)].map(work => work?.catch(() => undefined)));
    if (this.cleanupFailed) throw Error("Passive resource cleanup did not complete");
  }
}
