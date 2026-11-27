import type { LibraryStore } from "./library-store";
import { inspectReplayFile, freshContentIdentityMetadata, withoutFreshContentIdentity, ReplayFileLimitError } from "./sources/replay-file";

export const CONTENT_IDENTITY_CATCHUP_ATTEMPTS = 8;
export const CONTENT_IDENTITY_CATCHUP_FILE_BYTES = 8 * 1024 * 1024;
export interface LibraryContentCatchupResult { attempted: number; committed: number; failed: number; limited: number; stale: number }

/** One metadata-source turn. A cursor is never drained by restarting or extending the source scan. */
export async function catchUpContentIdentity(store: Pick<LibraryStore, "contentIdentityCandidates" | "commitIdentityRefresh">,
  replayId: string, signal: AbortSignal, checkpoint: () => Promise<void>): Promise<LibraryContentCatchupResult> {
  signal.throwIfAborted();
  const page = store.contentIdentityCandidates(replayId, undefined, CONTENT_IDENTITY_CATCHUP_ATTEMPTS);
  const result: LibraryContentCatchupResult = { attempted: 0, committed: 0, failed: 0, limited: 0, stale: 0 };
  const attempted = new Set<string>();
  for (const ticket of page.items.slice(0, CONTENT_IDENTITY_CATCHUP_ATTEMPTS)) {
    await checkpoint(); signal.throwIfAborted();
    const key = JSON.stringify([ticket.sourceId, ticket.sourceKey, ticket.locationRevision, ticket.sourceConfigRevision, ticket.sha256]);
    if (attempted.has(key) || !ticket.sha256) continue;
    attempted.add(key); result.attempted++;
    let inspected: Awaited<ReturnType<typeof inspectReplayFile>>;
    try { inspected = await inspectReplayFile(ticket.locator, signal, checkpoint, CONTENT_IDENTITY_CATCHUP_FILE_BYTES); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof ReplayFileLimitError) result.limited++; else result.failed++;
      continue;
    }
    await checkpoint(); signal.throwIfAborted();
    if (inspected.sha256 !== ticket.sha256) { result.stale++; continue; }
    const metadata = { ...withoutFreshContentIdentity(ticket.metadata), header: inspected.header, stamp: inspected.stamp,
      ...freshContentIdentityMetadata(inspected), fileState: "readable", validation: "header-only" };
    if (Buffer.byteLength(JSON.stringify(metadata)) > 64 * 1024) { result.limited++; continue; }
    const committed = store.commitIdentityRefresh(ticket, { sha256: inspected.sha256, available: true, metadata });
    if (committed.state === "applied") result.committed++; else result.stale++;
  }
  return result;
}
