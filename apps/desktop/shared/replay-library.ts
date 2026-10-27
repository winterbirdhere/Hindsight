import type { LibraryFacetField, LibraryFilter, LibraryQuery } from "./library-query";
import type { LibraryAnalysisActivity, LibraryAnalysisSettings } from "./replay-library-metrics";
import type { LibraryCurrentReplayRequest } from "./library-current-replay";
import type { LibraryResourceChanges } from "./library-resource-changes";
/** Versioned library data only. Query DTOs never carry an analysis admission reason. */
export type LibrarySourceKind = "stable" | "replays" | "lazer" | "imported";
export type ReplayReview = "not-reviewed" | "reviewed" | "needs-another-look";
export type LibraryUpdateMode = "auto" | "launch" | "manual";

export const LIBRARY_REQUEST_CHANNEL = "library:request";
export const LIBRARY_DEMAND_CHANNEL = "library:viewer-demand";
export const LIBRARY_CHANGED_CHANNEL = "library:changed";
export interface LibraryChangedEvent { revision:number; ready:boolean;resourceRevision?:string;resourceChanges?:LibraryResourceChanges;statusOnly?:true }
export interface LibraryStableInstallation { directory: string; songsRoot: string }
export type LibraryPassiveRequest =
  | { method: "query-page"; query?: LibraryQuery }
  | { method: "query-preview"; query?: LibraryQuery; draft?: LibraryFilter }
  | { method: "query-player-names" }
  | { method: "query-facets"; query?: LibraryQuery; field: LibraryFacetField; options?: { search?: string; limit?: number; after?: string } }
  | { method: "query-bands"; query?: LibraryQuery; options?: { limit?: number; cursor?: string } }
  | { method: "query-reveal" | "query-same-map"; query?: LibraryQuery; replayId: string }
  | { method: "query-detail"; replayId: string }
  | { method: "query-collections"; options?: { limit?: number; after?: string; parentId?: string | null } }
  | { method: "query-memberships"; replayId: string; options?: { limit?: number; after?: string } }
  | { method: "query-snapshot-create"; query?: LibraryQuery; replayId: string }
  | { method: "query-snapshot-neighbors"; snapshotId: string; options: { position: number; before?: number; after?: number } }
  | { method: "query-snapshot-release"; snapshotId: string };
export type LibraryUserMetadataRequest =
  | { method: "player-names-set"; names: string[] }
  | { method: "collection-create"; name: string; parentId?: string | null; replayId?: string }
  | { method: "collection-rename"; collectionId: string; name: string }
  | { method: "collection-delete"; collectionId: string; referencedIds?: string[] }
  | { method: "replay-review"; replayId: string; review: ReplayReview }
  | { method: "replay-favourite"; replayId: string; favourite: boolean }
  | { method: "collection-membership"; replayId: string; collectionId: string; included: boolean };
/** Only the active scope/filter references affected by a cascade, never its full descendant inventory. */
export interface LibraryCollectionDeleteResult { deletedReferences:string[] }
export type LibraryAnalysisRequest =
  | { method: "analysis-settings"; settings?: LibraryAnalysisSettings }
  | { method: "analysis-request"; replayId: string; reason: "selection" | "open" }
  | { method: "analysis-retry"; replayId: string };
export const LIBRARY_QUERY_ERROR_CODES = ["library-query-invalidated", "library-query-limit", "library-query-updating"] as const;
export type LibraryQueryErrorCode = typeof LIBRARY_QUERY_ERROR_CODES[number];
/** Electron rejects preserve only Error.message; known passive-query states cross as data. */
export interface LibraryQueryErrorResponse { libraryQueryError: { code: LibraryQueryErrorCode; message: string } }
export type LibraryRequest =
  | LibraryPassiveRequest | LibraryUserMetadataRequest | LibraryAnalysisRequest | LibraryCurrentReplayRequest
  | { method: "configure"; stable: LibraryStableInstallation | null }
  | { method: "status" | "retry" | "import-replays" | "locate-lazer" | "rebuild" | "rebuild-stop" }
  | { method: "scan" | "stop"; sourceId: string }
  | { method: "source-enabled"; sourceId: string; enabled: boolean }
  | { method: "update-mode"; mode: LibraryUpdateMode };
export type LibraryWorkState = "idle" | "queued" | "scanning" | "waiting-for-viewer" | "stopped" | "complete" | "error";
/** Counts name their actual producer unit, never unique/new/playable replay totals. */
export interface LibrarySourceScanProgress {
  phase: "reading-map-metadata" | "checking-replays" | "committing";
  completed: number; total?: number;
  unit: "map-records" | "replay-observations" | "source-records";
}
export interface LibraryStatus {
  analysis?: LibraryAnalysisActivity;
  replayCount: number; updateMode: LibraryUpdateMode;
  rebuild: { state: LibraryWorkState; observations: number; sourceId?: string; error?: string; mapErrors: Record<string, string>; publicationMs?: number };
  importRecovery: { state: "pending" | "complete" | "failed" | "stopped"; completed: number; failed: number; failures: string[]; error?: string };
  indexMaintenance?: { state: "idle" | "running" | "waiting-for-viewer" | "error" | "closing" | "closed";
    error?: string; pending: number; ready: boolean };
  sources: { sourceId: string; state: LibraryWorkState; observations: number; error?: string; kind: LibrarySourceKind;
    progress?: LibrarySourceScanProgress;
    directory: string; enabled: boolean; mapError?: string;
    configuration?: "automatic" | "configured"; hasIndexHistory?: boolean; failureReason?: "source-missing" | "source-busy";
    update: { pending: boolean; active: boolean; stopped: boolean; watchError?: string } }[];
}
export interface LibraryImportResult { path: string; status: "added" | "already-imported" | "failed"; replayId?: string; error?: string }
/** Bounded import feedback; original per-file paths remain confined to explicit imports. */
export interface LibraryImportSummary {
  added: number; alreadyImported: number; failed: number;
  failures: {path: string; error?: string}[]; truncatedFailures: boolean;
}
export interface LibraryPlayerNames { names: string[] }

export interface LibrarySourceRegistration {
  id: string;
  kind: LibrarySourceKind;
  directory: string;
}

export interface LibraryObservation {
  sourceId: string;
  sourceKey: string;
  locator: string;
  /** Exact complete replay bytes, never a legacy replay hash or a score/date tuple. */
  sha256: string | null;
  available: boolean;
  generation: string;
  addedAt: number;
  metadata: Record<string, unknown>;
  /** Cached observation revision. A newer explicit publication wins over a suspended scan. */
  expectedRevision?: number;
}

export type LibraryLocationObservation = Omit<LibraryObservation, "sourceId" | "generation" | "addedAt">;

/** A source's map lookup hint. Its digest, file existence and current difficulty are not proven. */
export interface LibraryMapObservation {
  sourceId: string; generation: string; sourceKey: string; md5: string;
  locator: string | null; state: "unverified" | "invalid-path"; metadata: Record<string, unknown>;
}
export type LibraryMapCandidate = LibraryMapObservation;

export interface LibraryReplayIdentity {
  id: string;
  firstAddedAt: number;
  isNew: boolean;
  favourite: boolean;
  review: ReplayReview;
  collectionIds: string[];
  metadata: Record<string, unknown>;
  locations: {
    sourceId: string; sourceKey: string; locator: string; available: boolean; enabled: boolean;
    sha256: string | null; metadata: Record<string, unknown>;
  }[];
}

export interface LibraryCollection {
  id: string;
  name: string;
  parentId: string | null;
  paletteIndex: number;
}
