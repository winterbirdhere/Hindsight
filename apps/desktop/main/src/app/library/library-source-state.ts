import type { LazerSourceStatus } from "./sources/lazer-source";

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
