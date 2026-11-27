import type { LazerSourceStatus } from "./sources/lazer-source";

// Nested readers share the source task's signal. Record at the release boundary because
// row-level fallback or async iterator unwinding may replace the thrown exception.
interface ScanCleanup { failure?: Error }
const scanCleanup = new WeakMap<AbortSignal, ScanCleanup>();
export function trackSourceCleanup(signal: AbortSignal): ScanCleanup {
  const cleanup: ScanCleanup = {};
  scanCleanup.set(signal, cleanup);
  return cleanup;
}
export function recordSourceCleanupFailure(signal: AbortSignal | undefined, operation: string, cause: unknown): void {
  const cleanup = signal && scanCleanup.get(signal);
  if (cleanup) cleanup.failure ??= new Error(operation + ": " + (cause instanceof Error ? cause.message : "unknown cleanup error"), { cause });
}
export async function closeSourceHandle(handle: { close(): Promise<void> }, signal?: AbortSignal): Promise<void> {
  try { await handle.close(); }
  catch (error) { recordSourceCleanupFailure(signal, "Source handle close failed", error); throw error; }
}

/** Native missing means a source/database file is absent; busy means a sharing lock.
 * Neither proves a folder was removed or that osu! is running. */
export type SourceScanFailureReason = "source-missing" | "source-busy";

/** Only validated native response statuses create this structured scan evidence.
 * Preserve other statuses as raw Details without interpreting their message text. */
export class LibrarySourceScanError extends Error {
  readonly failureReason?: SourceScanFailureReason;
  constructor(status: LazerSourceStatus) {
    super("Native source scan: " + status);
    if (status === "source-missing" || status === "source-busy") this.failureReason = status;
  }
}
