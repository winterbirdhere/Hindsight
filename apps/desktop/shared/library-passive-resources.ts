import type { LibraryErrorStripEntry } from "./replay-library-metrics";

export const LIBRARY_PASSIVE_RESOURCE_CHANNEL = "library:passive-resource";
export const LIBRARY_PASSIVE_ART_MAX_BYTES = 256 * 1024;
export const LIBRARY_PASSIVE_CHUNK_BYTES = 64 * 1024;
/** Paths and source manifests stay inside the main/resource processes. */
export type LibraryPassiveResourceRequest =
  | { method: "artwork" | "strip" | "reveal"; requestId: string; replayId: string }
  | { method: "chunk"; requestId: string; offset: number }
  | { method: "release"; requestId: string };
export type LibraryPassiveArtwork = { state: "unavailable" } | { state: "ready"; bytes: number; mime: "image/png" };
export interface LibraryPassiveChunk { bytes: Uint8Array; done: boolean }
export type LibraryPassiveStrip = LibraryErrorStripEntry | null;
