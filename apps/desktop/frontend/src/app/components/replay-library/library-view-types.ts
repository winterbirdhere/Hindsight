import type {
  LibraryCollectionCount,
  LibraryFacetPage,
  LibraryFilter,
  LibraryFilterField,
  LibraryMembershipPage,
  LibraryQuery,
  LibraryQueryBandPage,
  LibraryQueryDetail,
  LibraryQueryItem,
  LibraryQueryPage,
  LibraryQueryPreview,
} from "../../../../../shared/library-query";
import type {
  LibraryImportSummary,
  LibraryRequest,
  LibraryStatus,
  ReplayReview,
} from "../../../../../shared/replay-library";
import type { LibraryAnalysisSettings } from "../../../../../shared/replay-library-metrics";
import type { LibraryErrorStrip } from "../../../../../shared/library-error-strip";

/** All persisted data and commands belong to the service. This view never admits analysis or copies a file. */
export interface LibraryViewResources {
  artUrl?: string;
  /** A partial strip update arrived before the requested artwork completed. */
  artworkPending?: boolean;
  strip?: LibraryErrorStrip;
  artworkError?: string;
  stripError?: string;
}
export interface LibraryViewSources {
  status: LibraryStatus | null;
  analysis: LibraryAnalysisSettings;
  analysisLoading?: boolean;
  analysed?: number;
  storedBytes?: number;
  lastFullCheck?: number;
  error?: string;
}
export interface LibraryReplayOpenError {
  replayId: string;
  message: string;
  reason?: "exact-map-unavailable";
}
export interface ReplayLibraryViewProps {
  query: LibraryQuery;
  page: LibraryQueryPage;
  selected: LibraryQueryDetail | null;
  collections: LibraryCollectionCount[];
  bands?: LibraryQueryBandPage["items"];
  view: "grid" | "list";
  sidebarShown: boolean;
  scrollTop?: number;
  scrollLeft?: number;
  focusRequest?: ({ kind: "item"; id: string } | { kind: "first-result" | "search" }) & { sequence: number };
  pageStart?: number;
  revealRequest?: { id: string; position: number; sequence: number };
  loading?: boolean;
  /** The first query page is still pending; retained-page refreshes are separate. */
  initialLoading?: boolean;
  loadingMore?: boolean;
  updating?: boolean;
  error?: string;
  openError?: LibraryReplayOpenError;
  announcement?: string;
  scopeCounts?: Partial<Record<"all" | "recent" | "favourites", number>>;
  sourceCounts?: Partial<Record<"stable" | "replays" | "lazer" | "imported", number>>;
  resources?: Readonly<Record<string, LibraryViewResources | undefined>>;
  sameMap?: { items: LibraryQueryItem[]; total: number; next?: string };
  memberships?: {
    replayId: string;
    ids: string[];
    items?: LibraryMembershipPage["items"];
    complete: boolean;
    loading?: boolean;
    next?: string;
  };
  collectionsNext?: string;
  bandsNext?: string;
  nowPlaying?: { id: string; title: string; position?: string; artUrl?: string };
  sources: LibraryViewSources;
  myNames?: { names: string[]; loading?: boolean; error?: string };
  onSaveMyNames?(names: string[]): Promise<string[]>;
  onQueryChange(query: LibraryQuery): void;
  onSelect(id: string | null): void;
  onOpen(id: string, options?: { fullMap?: boolean }): void;
  onOpenReplayFile?(): void | Promise<void>;
  onReturnToViewer(): void;
  onRevealFile(id: string): void;
  onViewChange(view: "grid" | "list"): void;
  onSidebarChange(shown: boolean): void;
  onScrollTopChange?(top: number): void;
  onScrollLeftChange?(left: number): void;
  onLoadMore?(): void;
  onVisibleReplays?(ids: string[]): void;
  onLoadMoreCollections?(): void;
  onLoadMoreMemberships?(): void;
  onMembershipTarget?(id: string | null): void;
  onLoadMoreBands?(): void;
  onJumpBand?(key: string): void;
  onPreview(query: LibraryQuery, draft?: LibraryFilter): Promise<LibraryQueryPreview | undefined>;
  onFacets(field: LibraryFilterField, search?: string, cursor?: string): Promise<LibraryFacetPage | undefined>;
  onReview(id: string, review: ReplayReview): void;
  onRetryAnalysis?(id: string): void;
  onFavourite(id: string, favourite: boolean): void;
  onMembership(id: string, collectionId: string, member: boolean): void;
  onCollectionCreate(name: string, parentId: string | null, replayId?: string): void;
  onCollectionRename(id: string, name: string): void;
  onCollectionDelete(id: string): void;
  onSourceAction(action: LibraryRequest): void | Promise<LibraryImportSummary | undefined>;
  onLocateStable(): void;
  onAnalysisSettings(settings: LibraryAnalysisSettings): void;
  onShowAllPlays?(id: string): void;
  onLoadMorePlays?(id: string): void;
}

export const SOURCE_LABELS = {
  stable: "osu! stable · local scores",
  replays: "osu! stable · Replays folder",
  lazer: "osu!lazer",
  imported: "Imported in Hindsight",
} as const;
export const REVIEW_LABELS = {
  "not-reviewed": "Not reviewed",
  reviewed: "Reviewed",
  "needs-another-look": "Needs another look",
} as const;
export const ANALYSIS_LABELS = {
  none: "Not analysed",
  queued: "Queued",
  analysing: "Analysing",
  paused: "Paused",
  analysed: "Analysed",
  failed: "Analysis failed",
} as const;
