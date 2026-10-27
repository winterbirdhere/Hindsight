import { join, extname } from "path";
import type { LibrarySourceRegistration } from "../../../../shared/replay-library";

export interface SourceWatcher { close(): void; on(event: "error", listener: (error: Error) => void): unknown }
export type WatchFilter = "stable-root" | "lazer-root" | "replay" | "all";
export type WatchFactory = (path: string, recursive: boolean, notify: (event: string, filename: string | null) => void, filter?: WatchFilter) => SourceWatcher;
const nativeWatch: WatchFactory = () => { throw new Error("Owned library native watcher factory required"); };
export type LibraryEvidenceChange = { kind: "adjacent"; replayLocator: string } | { kind: "source" };

/** Windows native recursive notifications: at most two handles/source, no recursive JS directory
 * cache or event-path queue. A notification only dirties metadata; it never reads a replay. */
export function watchLibrarySource(source: LibrarySourceRegistration, changed: () => void, failed: (error: Error) => void,
  factory: WatchFactory = nativeWatch, _evidenceChanged: (change: LibraryEvidenceChange) => void = () => undefined): () => void {
  const replayChange = (event: string, filename: string) => event === "rename" || extname(filename).toLowerCase() === ".osr";
  const requests: { path: string; recursive: boolean; filter: WatchFilter; relevant: (event: string, filename: string) => boolean }[] = [];
  if (source.kind === "stable") {
    requests.push({ path: source.directory, recursive: false, filter: "stable-root", relevant: (_event, name) => ["scores.db", "osu!.db"].includes(name.toLowerCase()) },
      { path: join(source.directory, "Data", "r"), recursive: true, filter: "replay", relevant: replayChange });
  } else if (source.kind === "lazer") {
    requests.push({ path: source.directory, recursive: false, filter: "lazer-root", relevant: (_event, name) => name.toLowerCase() === "client.realm" },
      { path: join(source.directory, "files"), recursive: true, filter: "all", relevant: () => true });
  } else requests.push({ path: source.directory, recursive: source.kind === "replays", filter: "replay", relevant: replayChange });
  const watchers: SourceWatcher[] = []; let closed = false;
  for (const request of requests) {
    try {
      const watcher = factory(request.path, request.recursive, (event, filename) => {
        if (closed) return;
        if (!filename) { changed(); return; }
        if (extname(filename).toLowerCase() === ".osg") return;
        if (request.relevant(event, filename)) changed();
      }, request.filter);
      watcher.on("error", error => { if (!closed) { failed(error); } }); watchers.push(watcher);
    } catch (error) { failed(error instanceof Error ? error : new Error("Source watcher unavailable")); }
  }
  return () => { if (closed) return; closed = true; for (const watcher of watchers) watcher.close(); };
}
