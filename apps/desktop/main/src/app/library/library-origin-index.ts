import { watch } from "fs";
import { basename, dirname } from "path";
import { LibraryActivityGate } from "./library-activity-gate";
import { readVerifiedLibraryResource } from "./library-resource-reader";
import type { LibraryConfirmedOrigin } from "./library-source-binding";
import { LIBRARY_SOURCE_PROJECTION_VERSION } from "./library-source-metrics";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import { PERFORMANCE_DEPENDENCY_VERSIONS } from "./library-performance-dependencies";
import { metricInputKey } from "./library-source-metrics";
import { LIBRARY_TIMELINE_VERSIONS } from "./library-timeline-target";
import { LIBRARY_FC_VERSIONS } from "./library-fc-target";

export interface LibraryOriginSnapshot {
  fingerprint: string; state: "ready" | "missing" | "invalid" | "error";
  entries: ReadonlyMap<string, LibraryConfirmedOrigin>; error?: string;
}
// Map/source membership changes own durable, targeted reconciliation scopes. Only
// active producer versions and the authoritative origin snapshot require a global pass.
// Retired C identities/limits do not affect this H/maps and S/P reconciliation.
export const libraryOriginRevision = (snapshot: LibraryOriginSnapshot): string =>
  "library-origin-v3:"+metricInputKey({source:LIBRARY_SOURCE_PROJECTION_VERSION,admission:"numerical-admission-v1",numerical:LIBRARY_NUMERIC_PROJECTION_VERSION,
    performance:PERFORMANCE_DEPENDENCY_VERSIONS,timeline:LIBRARY_TIMELINE_VERSIONS,fc:LIBRARY_FC_VERSIONS,
    state:snapshot.state,fingerprint:snapshot.fingerprint});
export async function readLibraryOrigins(file?: string, signal?: AbortSignal, checkpoint?: () => Promise<void>): Promise<LibraryOriginSnapshot> {
  signal?.throwIfAborted();
  if (!file) return { fingerprint: "missing", state: "missing", entries: new Map() };
  let bytes: Buffer, fingerprint: string;
  try {
    const resource = await readVerifiedLibraryResource(file, { maxBytes: 8 * 1024 * 1024 }, signal, checkpoint);
    bytes = resource.bytes; fingerprint = resource.sha256;
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { fingerprint: "missing", state: "missing", entries: new Map() };
    return { fingerprint: "unavailable", state: "error", entries: new Map(), error: (error instanceof Error ? error.message : "Origin file unavailable").slice(0, 2048) };
  }
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  try {
    const data = JSON.parse(bytes.toString("utf8"));
    if (!record(data) || data.version !== 1 || !record(data.entries)) throw Error("Invalid origin envelope");
    const keys = Object.keys(data.entries); if (keys.length > 50000) throw Error("Too many origin entries");
    const entries = new Map<string, LibraryConfirmedOrigin>();
    for (let index = 0; index < keys.length; index++) {
      if (index % 256 === 0) { await checkpoint?.(); signal?.throwIfAborted(); }
      const sha = keys[index], entry = data.entries[sha];
      if (/^[a-f0-9]{64}$/.test(sha) && record(entry) && entry.provenance === "user-confirmed" && (entry.client === "stable" || entry.client === "lazer"))
        entries.set(sha, { client: entry.client, provenance: "user-confirmed" });
    }
    return { fingerprint, state: "ready", entries };
  } catch (error) {
    signal?.throwIfAborted();
    return { fingerprint, state: "invalid", entries: new Map(), error: (error instanceof Error ? error.message : "Invalid origin file").slice(0, 2048) };
  }
}
type OriginWatch = (file: string, changed: () => void, failed: (error: Error) => void) => () => void;
const watchOrigins: OriginWatch = (file, changed, failed) => {
  const expected = basename(file).toLowerCase();
  const watcher = watch(dirname(file), { persistent: false }, (_event, name) => {
    if (!name || name.toString().toLowerCase() === expected) changed();
  });
  watcher.on("error", failed); return () => watcher.close();
};
interface ProjectionSink {
  publish(snapshot: LibraryOriginSnapshot): void;
  revision(): string | undefined;
  invalidate(): void;
  page(after?: string): { processed: number; next?: string };
  complete(revision: string): boolean;
}

/** One resumable metadata maintenance owner. Reads indexed evidence only; admission intent is
 * separate from resource preparation/simulation and each identity passes the viewer gate. */
export class LibraryOriginIndex {
  private readonly gate = new LibraryActivityGate();
  private readonly abort = new AbortController();
  private pending = false;
  private started = false;
  private closed = false;
  private work?: Promise<void>;
  private closing?: Promise<void>;
  private unwatch?: () => void;
  private state: "idle" | "queued" | "running" | "error" = "idle";
  private error?: string;
  private watchError?: string;
  private snapshotState?: LibraryOriginSnapshot["state"];
  constructor(private readonly file: string | undefined, private readonly sink: ProjectionSink,
    private readonly io: { read?: typeof readLibraryOrigins; watch?: OriginWatch } = {}) {}
  start(): void {
    if (this.started || this.closed) return; this.started = true;
    if (this.file) {
      try { this.unwatch = (this.io.watch ?? watchOrigins)(this.file, () => this.refresh(), error => {
        if (!this.closed) this.watchError = error.message.slice(0, 2048);
      }); } catch (error) { this.watchError = (error instanceof Error ? error.message : "Origin watcher unavailable").slice(0, 2048); }
    }
    // Re-read after registering the directory watcher to close the initialization-read race.
    this.refresh();
  }
  refresh(): void {
    if (!this.started || this.closed) return; this.pending = true;
    if (this.work) return;
    this.state = "queued";
    this.work = Promise.resolve().then(() => this.gate.run(async () => {
      while (this.pending) {
        this.pending = false; this.state = "running"; this.error = undefined;
        const snapshot = await (this.io.read ?? readLibraryOrigins)(this.file, this.abort.signal, () => this.gate.checkpoint(this.abort.signal));
        this.abort.signal.throwIfAborted(); this.snapshotState = snapshot.state; this.error = snapshot.error;
        const revision = libraryOriginRevision(snapshot), needsProjection = this.sink.revision() !== revision;
        // Dirty the durable marker before new observations can consume this snapshot. A crash,
        // partial pass or A→B→A change must never reuse a completed revision over mixed rows.
        if (needsProjection) this.sink.invalidate();
        this.sink.publish(snapshot);
        if (needsProjection) {
          let after: string | undefined;
          do { await this.gate.checkpoint(this.abort.signal); after = this.sink.page(after).next; } while (after);
          if (!this.sink.complete(revision)) this.pending = true;
        }
        await this.gate.checkpoint(this.abort.signal);
      }
      this.state = this.error ? "error" : "idle";
    }, this.abort.signal)).catch(error => {
      if (!this.abort.signal.aborted) { this.state = "error"; this.error = (error instanceof Error ? error.message : "Source metric reconciliation failed").slice(0, 2048); }
      if (this.abort.signal.aborted) this.pending = false;
    }).finally(() => { this.work = undefined; if (this.pending && !this.closed) this.refresh(); });
  }
  status() { return { state: this.state, snapshotState: this.snapshotState, error: this.error, watchError: this.watchError }; }
  setViewerDemand(active: boolean): Promise<void> { return this.gate.setDemand(active); }
  async drain(): Promise<void> { do { await this.work; } while (this.work); }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = (async () => {
        let failure: unknown;
        try { this.unwatch?.(); } catch (error) { failure = error; }
        finally { this.abort.abort(); }
        await this.drain();
        if (failure) throw failure;
      })();
    }
    return this.closing;
  }
}
