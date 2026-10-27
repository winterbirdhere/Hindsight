import type { LibrarySourceKind } from "./replay-library";
import type { LibraryCurrentReplayReceipt } from "./library-current-replay";

export const LIBRARY_RESOURCE_CHANNEL = "library:resource";
/** A verified replay has no usable exact-map candidate in the current enabled index.
 * This is an attempt result, not a permanent claim about files outside that index. */
export interface LibraryExactMapUnavailable {
  state: "unavailable"; reason: "exact-map-unavailable";
  requestId: string; replayId: string; beatmapMd5: string;
}
export function isLibraryExactMapUnavailable(value: unknown): value is LibraryExactMapUnavailable {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return Object.keys(result).length === 5 && Object.keys(result).every(key =>
    ["state", "reason", "requestId", "replayId", "beatmapMd5"].includes(key)) &&
    result.state === "unavailable" && result.reason === "exact-map-unavailable" &&
    [result.requestId, result.replayId].every(id => typeof id === "string" && id.length > 0 && id.length <= 128) &&
    typeof result.beatmapMd5 === "string" && /^[a-f\d]{32}$/.test(result.beatmapMd5);
}
export type LibraryResourceRequest =
  | { method: "open"; requestId: string; replayId: string }
  | { method: "transfer"; requestId: string; kind: "replay" | "map" | "asset"; name?: string }
  | { method: "chunk"; requestId: string; transferId: string; offset: number }
  | { method: "release"; requestId: string };
/** No source path, storage ticket or native process configuration crosses to the renderer. */
export interface LibraryReplayHandle {
  requestId: string; replayId: string; sourceKind: LibrarySourceKind;
  replaySha256: string; beatmapMd5: string; mapSha256: string;
  storyboards: string[]; assetManifestComplete: boolean;
  currentReplay?: LibraryCurrentReplayReceipt;
}
/** unavailable is asset-only; id is empty, bytes is zero, and no transfer was allocated. */
export interface LibraryResourceTransfer { id: string; bytes: number; unavailable?: true }
export interface LibraryResourceChunk { bytes: Uint8Array; done: boolean }
