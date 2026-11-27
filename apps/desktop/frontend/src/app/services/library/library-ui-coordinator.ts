import { BehaviorSubject, Observable, Subscription } from "rxjs";
import { formatGameTime } from "@osujs/math";
import type {
  LibraryCollectionPage,
  LibraryFacetField,
  LibraryFacetPage,
  LibraryFilterField,
  LibraryMembershipPage,
  LibraryQuery,
  LibraryQueryDetail,
  LibraryQueryItem,
  LibraryQueryBandPage,
  LibraryQueryPage,
} from "../../../../../shared/library-query";
import type {
  LibraryImportSummary,
  LibraryChangedEvent,
  LibraryPlayerNames,
  LibraryRequest,
  LibraryStatus,
} from "../../../../../shared/replay-library";
import type { LibraryAnalysisSettings } from "../../../../../shared/replay-library-metrics";
import { readLibraryResourceChanges } from "../../../../../shared/library-resource-changes";
import type { LibraryReplayOpenError, LibraryViewResources, LibraryDeletionOperation, LibraryDeletionPendingView, LibraryDeletionAttention, LibraryDeletionUiAction } from "../../components/replay-library/library-view-types";
import type { LibraryDeletionRequest, LibraryDeletionResult, LibraryDeletionPendingPage } from "../../../../../shared/library-deletion";
import { LibraryExactMapUnavailableError } from "./library-replay-resources";
import { LibraryQueryClient, libraryQueryErrorCode } from "./library-query-client";
import { LibraryViewState } from "./library-view-state";
import type { LibraryPreferences } from "./library-preferences";
import { retainLibraryPassiveResourceSnapshot, selectLibraryPassiveResourceSnapshot } from "./library-passive-resource-client";

interface UiTransport {
  request(input: LibraryRequest): Promise<unknown>;
  setViewerVisible(visible: boolean): void;
  changes$?: Observable<LibraryChangedEvent>;
}
export interface LibraryUiOptions {
  navigate(path: "/app/analyzer" | "/app/library"): void;
  openReplay(id: string, options: { fullMap?: boolean }): Promise<void>;
  locateStable?(): Promise<void>;
  revealFile?(id: string): Promise<void>;
  readResources?(
    ids: string[],
    selectedId?: string,
    signal?: AbortSignal,
    onUpdate?: (resources: Readonly<Record<string, LibraryViewResources | undefined>>) => void,
  ): Promise<Readonly<Record<string, LibraryViewResources | undefined>>>;
  disposeResources?(): void | Promise<void>;
  invalidateResources?(options?: { artwork?: boolean; strip?: boolean; preserveArtwork?: boolean; artworkIds?: readonly string[] }): void;
  canNavigate?(): boolean;
  viewerVisibility?(visible: boolean): void;
  readPlaybackPosition?(): number;
  sidebarShown?: boolean;
  persistSidebar?: (shown: boolean) => void;
  preferences?: Partial<LibraryPreferences>;
  persistPreferences?: (preferences: LibraryPreferences) => void;
  width?: number;
}
export interface LibraryUiSnapshot {
  deletion?: LibraryDeletionOperation;
  deletionPending: LibraryDeletionPendingView;
  myNames: LibraryPlayerNames & { loading: boolean; error?: string };
  sources: {
    status: LibraryStatus | null;
    analysis: LibraryAnalysisSettings;
    analysisLoading: boolean;
    error?: string;
  };
  collections: LibraryCollectionPage;
  bands: LibraryQueryBandPage;
  sameMap?: LibraryQueryPage;
  memberships?: {
    replayId: string;
    ids: string[];
    items?: LibraryMembershipPage["items"];
    complete: boolean;
    loading?: boolean;
    next?: string;
  };
  resources: Readonly<Record<string, LibraryViewResources | undefined>>;
  scopeCounts: Partial<Record<"all" | "recent" | "favourites", number>>;
  sourceCounts?: Partial<Record<"stable" | "replays" | "lazer" | "imported", number>>;
  countsRevision?: string;
  updating: boolean;
  error?: string;
  openError?: LibraryReplayOpenError;
  nowPlaying?: { id: string; title: string; artUrl?: string; position?: string };
}
const facets = new Set<LibraryFilterField>([
  "status",
  "mapper",
  "grade",
  "result",
  "player",
  "playedon",
  "source",
  "collection",
  "review",
  "astate",
]);
// Controls are suppressed until persisted settings arrive; these values are never presented as a loaded preference.
const unreadSettings: LibraryAnalysisSettings = { mode: "off", workers: 1, userPaused: false, pauseOnBattery: true };
const message = (error: unknown) => (error instanceof Error ? error.message : "Library operation failed");
function deletionIdentity(item?: LibraryQueryItem): Pick<LibraryDeletionOperation, "title" | "description"> | undefined {
  if (!item?.title?.trim()) return undefined;
  return {
    title: [item.artist, item.title].filter(Boolean).join(" - ") + (item.difficulty ? ` [${item.difficulty}]` : ""),
    description: [item.player ?? "Unknown player", item.mods == null ? "Mods unavailable" : item.mods.length ? item.mods.join(" ") : "No Mod",
      item.values?.date == null ? "Date unavailable" : new Date(item.values.date).toLocaleString()].join(" · "),
  };
}
// LibraryChangeRelay prefixes the utility's decimal resource counter with its
// decimal owner generation. Unknown tokens cannot establish owner continuity.
const resourceOwner = (revision?: string) => revision?.match(/^(\d+):\d+$/)?.[1];

/** Root-lifetime UI owner. Indexed reads and explicit mutations have separate paths; notifications
 * only refresh a visible library, with one refresh in flight and one coalesced pending refresh. */
export class LibraryUiCoordinator {
  readonly query: LibraryQueryClient;
  readonly view: LibraryViewState;
  readonly fullMapRequest$ = new BehaviorSubject(0);
  readonly stableSettingsRequest$ = new BehaviorSubject(0);
  readonly state$ = new BehaviorSubject<LibraryUiSnapshot>({
    deletionPending: { items: [], loading: false },
    myNames: { names: [], loading: true },
    sources: { status: null, analysis: unreadSettings, analysisLoading: true },
    collections: { items: [], total: 0 },
    bands: { items: [] },
    resources: {},
    scopeCounts: {},
    updating: false,
  });
  private readonly subscriptions = new Subscription();
  private closed = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private refreshRunning = false;
  private dirty = false;
  private ready = true;
  private revisionRetryUsed = false;
  private auxiliarySequence = 0;
  private statusSequence = 0;
  private statusDirty = false;
  private statusReading = false;
  private sourceError?: { owner: "action" | "auxiliary" | "status"; message: string };
  private selectedSequence = 0;
  private membershipSequence = 0;
  private mutations: Promise<void> = Promise.resolve();
  private deletionSequence = 0;
  private deletionIdentitySequence = 0;
  private deletionPendingSequence = 0;
  private deletionKnown = new Map<string, LibraryDeletionAttention>();
  private connected = false;
  private navigationLocked = false;
  private resourceSequence = 0;
  private resourceController?: AbortController;
  private resourceRun?: { key: string; controller: AbortController; refresh: boolean };
  private visibleIds: string[] = [];
  private resourceKey = "";
  private resourceRevision?: string;
  private resourceReadyOwner?: string;
  private artworkDirty = false;
  private openSequence = 0;
  private openingEvidenceSequence = 0;
  private releaseResourcePublication?: () => void;
  constructor(private readonly transport: UiTransport, private readonly options: LibraryUiOptions) {
    this.query = new LibraryQueryClient(transport);
    this.view = new LibraryViewState(this.query, {
      openReplay: options.openReplay,
      sidebarShown: options.sidebarShown,
      persistSidebar: options.persistSidebar,
      preferences: options.preferences,
      persistPreferences: options.persistPreferences,
      width: options.width,
      viewerVisibility: (visible) => {
        transport.setViewerVisible(visible);
        options.viewerVisibility?.(visible);
        // Hiding pauses the retained viewer first, so this is its final playhead,
        // not a library snapshot index or a second ticking clock.
        if (!visible && this.snapshot().nowPlaying) this.setNowPlayingMetadata(this.snapshot().nowPlaying);
      },
    });
  }
  connect(): void {
    if (this.closed || this.connected) return;
    this.connected = true;
    let selectedId = this.view.snapshot().selectedId;
    this.subscriptions.add(
      this.view.state$.subscribe((state) => {
        if (state.selectedId !== selectedId) { selectedId = state.selectedId; this.clearOpenError(); }
        if (state.route !== "library") this.visibleIds = [];
        void this.refreshResources();
      }),
    );
    if (this.transport.changes$)
      this.subscriptions.add(
        this.transport.changes$.subscribe((event) => {
          if (this.closed) return;
          const resourceChanged = event.resourceRevision === undefined ? !event.statusOnly : event.resourceRevision !== this.resourceRevision;
          if (event.statusOnly && !resourceChanged) {
            this.statusDirty = true;
            void this.refreshStatus();
            return;
          }
          this.statusSequence++;
          const owner = resourceOwner(event.resourceRevision);
          const continuous = owner !== undefined && owner === resourceOwner(this.resourceRevision);
          if (!continuous) this.resourceReadyOwner = undefined;
          if (!event.ready || event.resourceRevision === undefined || event.resourceRevision !== this.resourceRevision) this.clearOpenError();
          this.revisionRetryUsed = false;
          this.dirty = true;
          if (resourceChanged) {
            this.artworkDirty = true;
            const changes = event.resourceRevision === undefined ? undefined : readLibraryResourceChanges(event.resourceChanges, event.resourceRevision);
            if (continuous && changes && changes.from === this.resourceRevision && changes.scope === "replays") {
              // Fence affected admitted reads now, including while hidden. Applying
              // each interval immediately accumulates stale IDs without a deferred
              // scope queue; unaffected entries and admitted peers remain current.
              this.options.invalidateResources?.({ artwork: true, strip: false, preserveArtwork: true, artworkIds: changes.replayIds });
            } else {
              // Missing/gapped/global evidence cannot certify any retained alias.
              // Clear now so a later scoped interval cannot undo this boundary.
              this.resourceReadyOwner = undefined;
              this.invalidateResources(true);
              this.resourceKey = "";
            }
          }
          if (event.ready) this.resourceReadyOwner = owner;
          this.ready = event.ready;
          this.resourceRevision = event.resourceRevision;
          this.patch({ updating: !event.ready });
          if (event.ready) this.scheduleRefresh();
          else {
            this.statusDirty = true;
            void this.refreshStatus();
          }
        }),
      );
  }
  snapshot(): LibraryUiSnapshot {
    return this.state$.value;
  }
  /** Acquire in a React layout effect for the exact useSyncExternalStore snapshot.
   * Cleanup releases only that committed render, including after coordinator disposal. */
  retainRenderedResources(resources: LibraryUiSnapshot["resources"]): () => void {
    if (this.closed || resources !== this.snapshot().resources) return () => undefined;
    return retainLibraryPassiveResourceSnapshot(resources);
  }
  private publishResources(resources: LibraryUiSnapshot["resources"]): void {
    if (resources === this.snapshot().resources) return;
    const previous = this.releaseResourcePublication;
    this.releaseResourcePublication = retainLibraryPassiveResourceSnapshot(resources);
    this.patch({ resources });
    previous?.();
  }
  private invalidateResources(artwork: boolean): void {
    // Strip refreshes can wait for an admitted cold batch. Artwork invalidation
    // is either targeted immediately at event receipt or a hard global boundary.
    const run = this.resourceRun;
    if (run && !run.controller.signal.aborted && !artwork) {
      run.refresh = true;
      return;
    }
    // Fence a cancelled read even while the replacement page/detail is still pending.
    this.resourceSequence++;
    if (artwork) {
      this.resourceController?.abort();
      this.publishResources(Object.freeze({}));
    }
    this.options.invalidateResources?.({ artwork, strip: true });
  }
  setNavigationLocked(locked: boolean): void {
    this.navigationLocked = locked;
  }
  private canNavigate(): boolean {
    return !this.closed && !this.navigationLocked && this.options.canNavigate?.() !== false;
  }
  private patch(patch: Partial<LibraryUiSnapshot>): void {
    if (!this.closed) this.state$.next({ ...this.snapshot(), ...patch });
  }
  private report(error: unknown): void {
    if (libraryQueryErrorCode(error) === "library-query-updating") this.patch({ updating: true, error: undefined });
    else this.patch({ error: message(error) });
  }
  private clearOpenError(): void {
    this.openingEvidenceSequence++;
    if (this.snapshot().openError) this.patch({ openError: undefined });
  }
  private canReadResources(): boolean {
    return this.ready || this.resourceReadyOwner !== undefined &&
      this.resourceReadyOwner === resourceOwner(this.resourceRevision);
  }
  private scheduleRefresh(): void {
    if (
      this.closed ||
      !this.ready ||
      this.view.snapshot().route !== "library" ||
      this.refreshRunning ||
      this.refreshTimer !== undefined
    )
      return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshVisible();
    }, 75);
  }
  private matchesPageRevision(value: { revision?: string }): boolean {
    return value.revision === this.view.snapshot().page?.revision;
  }
  private refreshRevisionMismatch(): void {
    this.patch({ updating: true });
    if (this.revisionRetryUsed) return;
    this.revisionRetryUsed = true;
    this.dirty = true;
    this.scheduleRefresh();
  }
  private async refreshVisible(): Promise<void> {
    if (this.closed || !this.ready || this.view.snapshot().route !== "library") return;
    this.dirty = false;
    this.refreshRunning = true;
    try {
      const resourceRevision = this.resourceRevision;
      const refreshDisplayResources = this.artworkDirty || this.view.snapshot().selectedId !== null;
      if (refreshDisplayResources) this.invalidateResources(false);
      this.artworkDirty = false;
      await this.view.refreshPreservingWindow();
      if (this.ready && this.view.snapshot().loadingMore) await this.view.resumePendingAppend();
      await this.refreshAuxiliary();
      const selected = this.view.snapshot().selectedId;
      if (selected) await this.refreshSelected(selected, true);
      const owner = resourceOwner(resourceRevision);
      // Finish this admitted same-owner pass even if unrelated indexing advanced
      // the global counter; the existing dirty bit schedules one follow-up.
      if (refreshDisplayResources && this.canReadResources() && (resourceRevision === this.resourceRevision ||
        owner !== undefined && owner === resourceOwner(this.resourceRevision))) await this.refreshResources(true);
    } catch (error) {
      this.report(error);
    } finally {
      this.refreshRunning = false;
      if (this.dirty) this.scheduleRefresh();
    }
  }
  async enterLibrary(): Promise<void> {
    if (!this.canNavigate()) return;
    this.openSequence++;
    this.revisionRetryUsed = false;
    if (this.dirty) {
      this.invalidateResources(false);
      this.artworkDirty = false;
      this.resourceKey = "";
    }
    this.options.navigate("/app/library");
    void this.readDeletionPending();
    this.dirty = false;
    await this.view.returnToLibrary();
    await this.refreshAuxiliary();
    const selected = this.view.snapshot().selectedId;
    if (selected) await this.refreshSelected(selected, false);
  }
  returnToViewer(): void {
    if (!this.canNavigate()) return;
    this.openSequence++;
    this.view.showViewer();
    this.options.navigate("/app/analyzer");
  }
  async commitQuery(query: LibraryQuery): Promise<void> {
    if (this.closed) return;
    this.revisionRetryUsed = false;
    this.auxiliarySequence++;
    this.patch({ bands: { items: [] } });
    await this.view.commitQuery(query);
    if (this.snapshot().countsRevision !== this.view.snapshot().page?.revision) await this.refreshAuxiliary();
    else await this.refreshBands();
    if (!this.view.snapshot().selectedId) {
      this.selectedSequence++;
      this.patch({ sameMap: undefined });
    }
  }
  async select(id: string | null): Promise<void> {
    if (id === this.view.snapshot().selectedId && this.view.snapshot().selected) return;
    if (id !== this.view.snapshot().selectedId) this.clearOpenError();
    await this.view.select(id);
    if (!id) {
      this.selectedSequence++;
      this.patch({ sameMap: undefined });
      return;
    }
    if (this.view.snapshot().selectedId !== id) return;
    await Promise.all([this.refreshSelected(id, false), this.requestAnalysis(id, "selection")]);
  }
  private async requestAnalysis(replayId: string, reason: "selection" | "open"): Promise<void> {
    try {
      await this.transport.request({ method: "analysis-request", replayId, reason });
    } catch (error) {
      if (!this.closed) this.report(error);
    }
  }
  async open(id: string, options: { fullMap?: boolean } = {}): Promise<void> {
    if (!this.canNavigate()) return;
    this.clearOpenError();
    const sequence = ++this.openSequence, evidence = this.openingEvidenceSequence;
    const resourceRevision = this.ready ? this.resourceRevision : undefined;
    const selection = this.view.snapshot().selectedId;
    try {
      const opening = this.view.openInViewer(id, options);
      this.options.navigate("/app/analyzer");
      if (await opening) {
        if (this.closed || sequence !== this.openSequence) return;
        if (options.fullMap) this.fullMapRequest$.next(this.fullMapRequest$.value + 1);
        await this.requestAnalysis(id, "open");
      } else if (!this.closed && sequence === this.openSequence && this.view.snapshot().route === "library")
        this.options.navigate("/app/library");
    } catch (error) {
      if (this.closed || sequence !== this.openSequence) return;
      if (this.view.snapshot().route === "library") this.options.navigate("/app/library");
      if (this.view.snapshot().selectedId !== selection) return;
      const confirmed = error instanceof LibraryExactMapUnavailableError && error.replayId === id &&
        this.view.snapshot().selectedId === id && resourceRevision !== undefined && this.ready &&
        resourceRevision === this.resourceRevision && evidence === this.openingEvidenceSequence;
      this.patch({ openError: { replayId: id, message: message(error), ...(confirmed ? { reason: "exact-map-unavailable" as const } : {}) } });
    }
  }
  async step(direction: -1 | 1): Promise<void> {
    if (!this.canNavigate()) return;
    this.clearOpenError();
    const sequence = ++this.openSequence;
    try {
      await this.view.step(direction);
    } catch (error) {
      if (this.closed || sequence !== this.openSequence) return;
      this.patch({ openError: { replayId: error instanceof LibraryExactMapUnavailableError ? error.replayId : this.view.snapshot().nowPlayingId ?? "", message: message(error) } });
    }
  }
  setExternalReplay(nowPlaying?: LibraryUiSnapshot["nowPlaying"]): void {
    this.openSequence++;
    this.clearOpenError();
    this.view.setNowPlaying(null);
    this.setNowPlayingMetadata(nowPlaying);
  }
  setNowPlayingMetadata(nowPlaying?: LibraryUiSnapshot["nowPlaying"]): void {
    const time = nowPlaying ? this.options.readPlaybackPosition?.() : undefined;
    this.patch({
      nowPlaying: nowPlaying && {
        ...nowPlaying,
        ...(time !== undefined && Number.isFinite(time) ? { position: formatGameTime(Math.max(0, time)) } : {}),
      },
    });
  }
  /** Progress is display-only. Coalesce a slow read to one follow-up, without
   * invalidating pages, resource leases, or admitting analysis. */
  private async refreshStatus(): Promise<void> {
    if (this.closed || this.statusReading || this.view.snapshot().route !== "library") return;
    this.statusReading = true;
    try {
      while (this.statusDirty && !this.closed && this.view.snapshot().route === "library") {
        this.statusDirty = false;
        const sequence = ++this.statusSequence;
        try {
          const status = await this.transport.request({ method: "status" }) as LibraryStatus;
          if (!this.closed && sequence === this.statusSequence && this.view.snapshot().route === "library") {
            // A display-only read can recover its own failure, not a failed
            // settings write, source action, or a different auxiliary read.
            if (this.sourceError?.owner === "status") this.sourceError = undefined;
            this.patch({ sources: { ...this.snapshot().sources, status, error: this.sourceError?.message } });
          }
        } catch (error) {
          if (!this.closed && sequence === this.statusSequence && this.view.snapshot().route === "library") {
            if (!this.sourceError || this.sourceError.owner === "status")
              this.sourceError = { owner: "status", message: message(error) };
            const sources = this.snapshot().sources;
            this.patch({ sources: { ...sources, error: this.sourceError.message,
              status: sources.status && { ...sources.status, analysis: undefined } } });
          }
        }
      }
    } finally { this.statusReading = false; }
  }
  private async refreshAuxiliary(): Promise<void> {
    const sequence = ++this.auxiliarySequence, statusSequence = ++this.statusSequence;
    this.statusDirty = false;
    const results = await Promise.allSettled([
      this.transport.request({ method: "status" }),
      this.transport.request({ method: "analysis-settings" }),
      this.query.collections({ limit: 100 }),
      this.query.bands(this.view.snapshot().query, { limit: 100 }),
      this.readCounts(),
      this.transport.request({ method: "query-player-names" }),
    ]);
    if (this.closed || sequence !== this.auxiliarySequence) return;
    const [status, analysis, collections, bands, counts, names] = results,
      sources = { ...this.snapshot().sources };
    if (statusSequence === this.statusSequence) {
      if (this.sourceError?.owner !== "action")
        this.sourceError = status.status === "rejected" ? { owner: "auxiliary", message: message(status.reason) } : undefined;
      if (status.status === "fulfilled") sources.status = status.value as LibraryStatus;
      else if (sources.status) sources.status = { ...sources.status, analysis: undefined };
    }
    if (analysis.status === "fulfilled") {
      sources.analysis = analysis.value as LibraryAnalysisSettings;
      sources.analysisLoading = false;
    } else if (this.sourceError?.owner !== "action")
      this.sourceError = { owner: "auxiliary", message: message(analysis.reason) };
    sources.error = this.sourceError?.message;
    const matchingCollections =
      collections.status === "fulfilled" && collections.value && this.matchesPageRevision(collections.value);
    const matchingBands = bands.status === "fulfilled" && bands.value && this.matchesPageRevision(bands.value);
    const matchingCounts =
      counts.status === "fulfilled" && counts.value.coherent && this.matchesPageRevision(counts.value);
    this.patch({
      sources,
      myNames:
        names.status === "fulfilled"
          ? { ...(names.value as LibraryPlayerNames), loading: false }
          : { ...this.snapshot().myNames, loading: false, error: message(names.reason) },
      collections: matchingCollections && collections.value ? collections.value : { items: [], total: 0 },
      bands: matchingBands && bands.value ? bands.value : { items: [] },
      scopeCounts: matchingCounts ? counts.value.scopeCounts : {},
      sourceCounts: matchingCounts ? counts.value.sourceCounts : undefined,
      countsRevision: matchingCounts ? counts.value.revision : undefined,
      updating: !matchingCollections || !matchingBands || !matchingCounts || !this.ready,
    });
    if (
      (collections.status === "fulfilled" && collections.value && !matchingCollections) ||
      (bands.status === "fulfilled" && bands.value && !matchingBands) ||
      (counts.status === "fulfilled" && !matchingCounts)
    )
      this.refreshRevisionMismatch();
    if (collections.status === "rejected") this.report(collections.reason);
    if (bands.status === "rejected") this.report(bands.reason);
    if (counts.status === "rejected") this.report(counts.reason);
  }
  private async readCounts(): Promise<
    Pick<LibraryUiSnapshot, "scopeCounts" | "sourceCounts"> & { revision?: string; coherent: boolean }
  > {
    const kinds = ["all", "recent", "favourites"] as const;
    const [pages, facet] = await Promise.all([
      Promise.all(
        kinds.map(
          (kind) =>
            this.transport.request({
              method: "query-page",
              query: { scope: { kind }, limit: 1 },
            }) as Promise<LibraryQueryPage>,
        ),
      ),
      this.transport.request({
        method: "query-facets",
        field: "source",
        query: {},
        options: { limit: 100 },
      }) as Promise<LibraryFacetPage>,
    ]);
    const scopeCounts = Object.fromEntries(kinds.map((kind, index) => [kind, pages[index].total])),
      sourceCounts = Object.fromEntries(
        (["stable", "replays", "lazer", "imported"] as const).map((kind) => [
          kind,
          facet.items.find((item) => item.value === kind)?.count ?? 0,
        ]),
      );
    return {
      scopeCounts,
      sourceCounts,
      revision: facet.revision,
      coherent: pages.every((page) => page.revision === facet.revision),
    };
  }
  private async refreshBands(): Promise<void> {
    // A commit installs a fresh normalized query before awaiting its rows/reveal.
    // Equal database revisions alone cannot qualify a response from the old query.
    const query = this.view.snapshot().query;
    try {
      const bands = await this.query.bands(query, { limit: 100 });
      if (this.closed || this.view.snapshot().query !== query) return;
      if (bands && this.matchesPageRevision(bands)) this.patch({ bands });
      else if (bands) {
        this.patch({ bands: { items: [] } });
        this.refreshRevisionMismatch();
      }
    } catch (error) {
      if (!this.closed && this.view.snapshot().query === query) this.report(error);
    }
  }
  async loadMoreBands(): Promise<void> {
    const previous = this.snapshot().bands;
    if (!previous.next) return;
    const query = this.view.snapshot().query;
    try {
      const page = await this.query.bands(query, { limit: 100, cursor: previous.next });
      if (this.closed || this.view.snapshot().query !== query) return;
      if (page && page.revision === previous.revision && this.matchesPageRevision(page))
        this.patch({ bands: { ...page, items: [...previous.items, ...page.items] } });
      else if (page) {
        this.patch({ bands: { items: [] } });
        this.refreshRevisionMismatch();
      }
    } catch (error) {
      if (!this.closed && this.view.snapshot().query === query) this.report(error);
    }
  }
  async jumpBand(key: string): Promise<void> {
    const band = this.snapshot().bands.items.find((item) => item.key === key);
    if (band) await this.view.reveal(band.anchorId);
  }
  async loadMoreCollections(): Promise<void> {
    const previous = this.snapshot().collections;
    if (!previous.next) return;
    try {
      const page = await this.query.collections({ limit: 100, after: previous.next });
      if (page && page.revision === previous.revision && this.matchesPageRevision(page))
        this.patch({ collections: { ...page, items: [...previous.items, ...page.items] } });
      else if (page) {
        this.patch({ collections: { items: [], total: 0 } });
        this.refreshRevisionMismatch();
      }
    } catch (error) {
      this.report(error);
    }
  }
  async membershipTarget(id: string | null): Promise<void> {
    const sequence = ++this.membershipSequence;
    if (!id) {
      this.patch({ memberships: undefined });
      return;
    }
    this.patch({ memberships: { replayId: id, ids: [], complete: false, loading: true } });
    try {
      const result = await this.query.memberships(id, { limit: 100 });
      if (this.closed || sequence !== this.membershipSequence || !result) return;
      this.patch({
        memberships: {
          replayId: id,
          ids: result.items.map((item) => item.id),
          items: result.items,
          complete: !result.next,
          next: result.next,
          loading: false,
        },
      });
    } catch (error) {
      if (sequence === this.membershipSequence) {
        this.patch({ memberships: { replayId: id, ids: [], complete: false, loading: false } });
        this.report(error);
      }
    }
  }
  async loadMoreMemberships(): Promise<void> {
    const previous = this.snapshot().memberships;
    if (!previous?.next || previous.loading) return;
    const sequence = ++this.membershipSequence;
    this.patch({ memberships: { ...previous, loading: true } });
    try {
      const result = await this.query.memberships(previous.replayId, { limit: 100, after: previous.next });
      if (this.closed || sequence !== this.membershipSequence || !result) return;
      this.patch({
        memberships: {
          replayId: previous.replayId,
          ids: [...previous.ids, ...result.items.map((item) => item.id)],
          items: [...(previous.items ?? []), ...result.items],
          complete: !result.next,
          next: result.next,
          loading: false,
        },
      });
    } catch (error) {
      if (sequence === this.membershipSequence) {
        this.patch({ memberships: { ...previous, loading: false } });
        this.report(error);
      }
    }
  }
  private async refreshSelected(id: string, refreshDetail: boolean): Promise<void> {
    const sequence = ++this.selectedSequence;
    if (refreshDetail) await this.view.refreshSelectedDetail();
    try {
      const sameMap = await this.query.sameMap(id, { sort: "pp", direction: "desc", limit: 16 });
      if (this.closed || sequence !== this.selectedSequence || this.view.snapshot().selectedId !== id) return;
      this.patch({ sameMap });
      await this.refreshResources();
    } catch (error) {
      if (sequence === this.selectedSequence) this.report(error);
    }
  }
  visibleReplays(ids: string[]): void {
    if (this.view.snapshot().route !== "library") return;
    this.visibleIds = [...new Set(ids)].slice(0, 32);
    void this.refreshResources();
  }
  private async refreshResources(force = false): Promise<void> {
    if (!this.options.readResources || this.closed) return;
    const state = this.view.snapshot(),
      selectedId = state.route === "library" ? state.selectedId ?? undefined : undefined,
      ids = [...new Set([...(selectedId ? [selectedId] : []), ...this.visibleIds])].slice(0, 32),
      key = JSON.stringify([ids, selectedId]);
    if (!force && key === this.resourceKey) return;
    if (key !== this.resourceKey) this.publishResources(selectLibraryPassiveResourceSnapshot(this.snapshot().resources, ids));
    if (!this.canReadResources()) {
      this.resourceSequence++;
      this.resourceController?.abort();
      this.resourceKey = "";
      if (!ids.length) this.options.invalidateResources?.({ artwork: true, strip: true });
      return;
    }
    if (this.resourceRun?.key === key && !this.resourceRun.controller.signal.aborted) {
      this.resourceRun.refresh ||= force;
      return;
    }
    this.resourceKey = key;
    this.resourceController?.abort();
    // A viewport replacement supersedes the old batch, but not the invalidation
    // queued behind it. Apply that freshness requirement to the retained overlap.
    if (this.resourceRun?.refresh) this.invalidateResources(false);
    const sequence = ++this.resourceSequence;
    const controller = new AbortController();
    this.resourceController = controller;
    const run = { key, controller, refresh: false };
    this.resourceRun = run;
    try {
      const publish = (resources: LibraryUiSnapshot["resources"]) => {
        if (!this.closed && !controller.signal.aborted && this.canReadResources() && sequence === this.resourceSequence)
          this.publishResources(resources);
      };
      const resources = await this.options.readResources(ids, selectedId, controller.signal, publish);
      publish(resources);
    } catch (error) {
      if (!controller.signal.aborted && sequence === this.resourceSequence) {
        this.resourceKey = "";
        this.report(error);
      }
    } finally {
      if (this.resourceRun === run) {
        this.resourceRun = undefined;
        if (run.refresh && sequence === this.resourceSequence && !this.closed &&
          this.view.snapshot().route === "library" && this.canReadResources()) {
          this.invalidateResources(false);
          void this.refreshResources(true);
        }
      }
    }
  }
  async loadMorePlays(): Promise<void> {
    const selectedId = this.view.snapshot().selectedId,
      previous = this.snapshot().sameMap;
    if (!selectedId || !previous?.next) return;
    const sequence = this.selectedSequence;
    try {
      const page = await this.query.sameMap(selectedId, {
        sort: "pp",
        direction: "desc",
        limit: 16,
        cursor: previous.next,
      });
      if (page && sequence === this.selectedSequence && this.view.snapshot().selectedId === selectedId)
        this.patch({ sameMap: { ...page, items: [...previous.items, ...page.items].slice(-128) } });
    } catch (error) {
      this.report(error);
    }
  }
  facets(field: LibraryFilterField, search?: string, cursor?: string) {
    if (!facets.has(field)) return Promise.resolve(undefined);
    return this.query.facets(this.view.snapshot().query, field as LibraryFacetField, {
      search,
      after: cursor,
      limit: 100,
    });
  }
  async mutate(
    input: Extract<
      LibraryRequest,
      {
        method:
          | "collection-create"
          | "collection-rename"
          | "collection-delete"
          | "replay-review"
          | "replay-favourite"
          | "collection-membership";
      }
    >,
  ): Promise<void> {
    const action = async () => {
      if (this.closed) return;
      this.patch({ error: undefined });
      try {
        const query = this.view.snapshot().query,
          filter = query.filters?.find((item) => item.field === "collection");
        const referencedIds = [
          ...new Set([
            ...(query.scope?.kind === "collection" ? [query.scope.id] : []),
            ...(filter && "values" in filter ? filter.values : []),
          ]),
        ];
        const result = await this.transport.request(
          input.method === "collection-delete" ? { ...input, referencedIds } : input,
        );
        if (input.method === "collection-delete")
          await this.view.collectionsDeleted((result as { deletedReferences: string[] }).deletedReferences);
        else await this.view.refreshAfterSelectedEdit();
        await this.refreshAuxiliary();
        const membership = this.snapshot().memberships?.replayId;
        if (membership) await this.membershipTarget(membership);
      } catch (error) {
        this.report(error);
      }
    };
    this.mutations = this.mutations.then(action, action);
    await this.mutations;
  }
  /** Explicit source preview/confirmation; never called by selection, filters or analysis demand. */
  async deletionAction(action: LibraryDeletionUiAction): Promise<void> {
    if (this.closed) return;
    const current = this.snapshot().deletion;
    if (action.type === "reload-pending" || action.type === "load-more") {
      await this.readDeletionPending(action.type === "load-more"); return;
    }
    if (action.type === "close") {
      if (!current) return;
      this.deletionIdentitySequence++;
      this.patch({ deletion: { ...current, open: false, identity: current.identity?.state === "loading" ? undefined : current.identity } });
      if (!current.phase && current.result?.token && (current.result.state === "preview" || current.result.state === "partial" && current.result.continuation))
        await this.runDeletion({ method: "deletion-cancel", replayId: current.result.replayId, token: current.result.token }, "cancel");
      return;
    }
    if (action.type === "reopen") {
      if (current) {
        this.patch({ deletion: { ...current, open: true } });
        if (current.result && !current.phase) await this.readDeletionIdentity(current.result, this.deletionSequence);
      }
      return;
    }
    // A second activation cannot replace an in-flight operation or submit its token twice.
    if (current?.phase) {
      if (action.type === "preview" || action.type === "inspect") this.patch({ deletion: { ...current, open: true } });
      return;
    }
    if (action.type === "preview") {
      const selected = this.view.snapshot().selected;
      const item = selected?.item.id === action.replayId ? selected.item : undefined;
      this.patch({ deletion: { open: true, replayId: action.replayId, ...deletionIdentity(item) } });
      await this.runDeletion({ method: "deletion-preview", replayId: action.replayId }, "preview"); return;
    }
    if (action.type === "inspect") {
      const retained = (current?.result?.intentId ?? current?.intentId) === action.intentId ?
        { title: current?.title, description: current?.description } : {};
      this.patch({ deletion: { open: true, intentId: action.intentId, ...retained } });
      await this.runDeletion({ method: "deletion-status", intentId: action.intentId }, "status"); return;
    }
    if (!current) return;
    const result = current.result;
    if (action.type === "confirm") {
      if (!result?.token || !(result.state === "preview" || result.state === "partial" && result.continuation) || result.blockers.length || current.uncertain || current.error) return;
      if (Date.now() >= result.expiresAt) {
        this.patch({ deletion: { ...current, result: { ...result, state: result.state === "partial" ? "partial" : "expired", token: undefined } } }); return;
      }
      if (!current.title?.trim() || current.identity) return;
      await this.runDeletion({ method: "deletion-commit", replayId: result.replayId, token: result.token }, "commit");
    } else if (action.type === "refresh" && current.replayId && !current.uncertain &&
      (!result || ["preview", "blocked", "expired", "cancelled"].includes(result.state))) {
      await this.runDeletion({ method: "deletion-preview", replayId: current.replayId }, "preview");
    } else if (action.type === "review-remaining" && result?.state === "partial" && !current.uncertain) {
      await this.runDeletion({ method: "deletion-continue-preview", intentId: result.intentId }, "continue-preview");
    } else if (action.type === "check" && (result?.intentId || current.intentId)) {
      const intentId = result?.intentId ?? current.intentId;
      if (intentId) await this.runDeletion({ method: result ? "deletion-recover" : "deletion-status", intentId }, result ? "recover" : "status");
    } else if (action.type === "cleanup" && result?.state === "cleanup-required" && !current.uncertain) {
      await this.runDeletion({ method: "deletion-cleanup", intentId: result.intentId }, "cleanup");
    }
  }
  private async readDeletionIdentity(result: LibraryDeletionResult, operationSequence: number): Promise<void> {
    const operation = this.snapshot().deletion;
    if (this.closed || operationSequence !== this.deletionSequence || !operation?.open || operation.phase || operation.title?.trim() || operation.result?.intentId !== result.intentId) return;
    const sequence = ++this.deletionIdentitySequence;
    this.patch({ deletion: { ...operation, identity: { state: "loading" } } });
    let display: Pick<LibraryDeletionOperation, "title" | "description" | "identity">;
    try {
      // This passive read has its own ownership; it must not supersede an inspector's detail lane.
      const detail = await this.transport.request({ method: "query-detail", replayId: result.replayId }) as LibraryQueryDetail | null;
      const identity = deletionIdentity(detail?.item);
      display = identity ? { ...identity, identity: undefined } : { identity: { state: "unavailable", error:
        detail?.item ? "The replay's map title is unavailable." : "The replay is no longer available in this library." } };
    } catch (error) {
      display = { identity: { state: "unavailable", error: message(error) } };
    }
    const latest = this.snapshot().deletion;
    if (this.closed || sequence !== this.deletionIdentitySequence || operationSequence !== this.deletionSequence ||
      !latest?.open || latest.result?.intentId !== result.intentId || latest.replayId !== result.replayId) return;
    this.patch({ deletion: { ...latest, ...display } });
  }
  private rememberDeletion(result: LibraryDeletionResult, uncertain = false): void {
    if (uncertain || result.state === "committing" || result.state === "partial" || result.state === "recovery-required" || result.state === "cleanup-required")
      this.deletionKnown.set(result.intentId, { intentId: result.intentId, replayId: result.replayId,
        state: result.state === "cleanup-required" ? "cleanup-required" : uncertain ? "unknown" : result.state as "committing" | "partial" | "recovery-required",
        committedTargets: result.targets.filter(target => target.state === "committed").length, totalTargets: result.targets.length });
    else this.deletionKnown.delete(result.intentId);
    const previous = this.snapshot().deletionPending;
    const items = new Map(previous.items.filter(item => item.intentId !== result.intentId).map(item => [item.intentId, item]));
    for (const [id, item] of this.deletionKnown) items.set(id, item);
    this.patch({ deletionPending: { ...previous, items: [...items.values()] } });
  }
  private async runDeletion(input: Exclude<LibraryDeletionRequest, { method: "deletion-pending" }>, phase: NonNullable<LibraryDeletionOperation["phase"]>): Promise<void> {
    const operation = this.snapshot().deletion;
    if (!operation || this.closed) return;
    const sequence = ++this.deletionSequence;
    this.deletionIdentitySequence++;
    this.patch({ deletion: { ...operation, phase, error: undefined, identity: undefined,
      result: operation.result && (phase === "commit" || phase === "cancel" || phase === "preview" || phase === "continue-preview") ?
        { ...operation.result, token: undefined, ...(phase === "continue-preview" ? { continuation: undefined } : {}) } : operation.result } });
    try {
      const execute = () => {
        if (this.closed) throw new Error("The library is closed.");
        return this.transport.request(input) as Promise<LibraryDeletionResult>;
      };
      const response = this.mutations.then(execute, execute);
      this.mutations = response.then(() => undefined, () => undefined);
      const result = await response;
      if (this.closed || sequence !== this.deletionSequence) return;
      this.rememberDeletion(result);
      const open = this.snapshot().deletion?.open ?? false;
      if ((result.state === "complete" || result.sourceDeletionComplete) && [result.replayId, operation.replayId].includes(this.view.snapshot().selectedId ?? "")) {
        this.view.closePanel([]);
        this.selectedSequence++;
        this.clearOpenError();
        this.patch({ sameMap: undefined });
      }
      this.patch({ deletion: { ...operation, open, replayId: result.replayId, intentId: result.intentId, result, phase: undefined, uncertain: false, error: undefined, identity: undefined } });
      if (phase === "commit" || phase === "recover") {
        this.query.invalidate(); this.dirty = true; this.scheduleRefresh();
      }
      void this.readDeletionPending();
      // Dismissal happened while its read was pending; cancel only this returned confirmation.
      if (!open && result.token && (phase === "preview" && result.state === "preview" || phase === "continue-preview" && result.state === "partial" && result.continuation))
        await this.runDeletion({ method: "deletion-cancel", replayId: result.replayId, token: result.token }, "cancel");
      else if (open && phase !== "cancel") await this.readDeletionIdentity(result, sequence);
    } catch (error) {
      if (this.closed || sequence !== this.deletionSequence) return;
      const latest = this.snapshot().deletion;
      if (!latest) return;
      const uncertain = phase === "commit" || phase === "cleanup" || Boolean(latest.uncertain);
      if (latest.result) this.rememberDeletion(latest.result, uncertain);
      this.patch({ deletion: { ...latest, phase: undefined, error: message(error), uncertain } });
      if (phase === "commit") { this.query.invalidate(); this.dirty = true; this.scheduleRefresh(); }
    }
  }
  private async readDeletionPending(more = false): Promise<void> {
    if (this.closed) return;
    const previous = this.snapshot().deletionPending;
    if (more && (!previous.next || previous.loading)) return;
    const sequence = ++this.deletionPendingSequence;
    this.patch({ deletionPending: { ...previous, loading: true, error: undefined } });
    try {
      const result = await this.transport.request({ method: "deletion-pending", ...(more ? { after: previous.next } : {}) }) as LibraryDeletionPendingPage;
      if (this.closed || sequence !== this.deletionPendingSequence) return;
      if (!result || !Array.isArray(result.items)) throw new Error("Pending deletion outcomes are unavailable.");
      const items = new Map((more ? previous.items : []).map(item => [item.intentId, item]));
      for (const item of result.items) items.set(item.intentId, item);
      for (const [id, item] of this.deletionKnown) items.set(id, item);
      this.patch({ deletionPending: { items: [...items.values()], next: result.next, loading: false } });
    } catch (error) {
      if (!this.closed && sequence === this.deletionPendingSequence)
        this.patch({ deletionPending: { ...this.snapshot().deletionPending, loading: false, error: message(error) } });
    }
  }
  async saveMyNames(names: string[]): Promise<string[]> {
    const action = async () => {
      if (this.closed) throw new Error("The library is closed.");
      // Fence a settings read begun before this explicit save.
      this.auxiliarySequence++;
      const result = (await this.transport.request({ method: "player-names-set", names })) as LibraryPlayerNames;
      if (this.closed) return result.names;
      this.patch({ myNames: { ...result, loading: false } });
      this.query.invalidate();
      if (this.view.snapshot().route === "library") {
        await this.view.refreshPreservingWindow();
        await this.refreshAuxiliary();
      } else this.dirty = true;
      return result.names;
    };
    const saved = this.mutations.then(action, action);
    this.mutations = saved.then(
      () => undefined,
      () => undefined,
    );
    return saved;
  }
  async sourceAction(input: LibraryRequest): Promise<LibraryImportSummary | undefined> {
    try {
      const result = await this.transport.request(input);
      this.sourceError = undefined;
      this.patch({ sources: { ...this.snapshot().sources, error: undefined } });
      await this.refreshAuxiliary();
      return input.method === "import-replays" ? (result as LibraryImportSummary) : undefined;
    } catch (error) {
      if (input.method === "import-replays") throw error;
      this.sourceError = { owner: "action", message: message(error) };
      this.patch({ sources: { ...this.snapshot().sources, error: this.sourceError.message } });
      return undefined;
    }
  }
  async analysisSettings(settings: LibraryAnalysisSettings): Promise<void> {
    await this.sourceAction({ method: "analysis-settings", settings });
  }
  async locateStable(): Promise<void> {
    if (!this.canNavigate()) return;
    try {
      if (this.options.locateStable) {
        await this.options.locateStable();
        this.sourceError = undefined;
        this.patch({ sources: { ...this.snapshot().sources, error: undefined } });
      }
      else {
        this.returnToViewer();
        this.stableSettingsRequest$.next(this.stableSettingsRequest$.value + 1);
      }
    } catch (error) {
      this.sourceError = { owner: "action", message: message(error) };
      this.patch({ sources: { ...this.snapshot().sources, error: this.sourceError.message } });
    }
  }
  async retryAnalysis(replayId: string): Promise<void> {
    await this.sourceAction({ method: "analysis-retry", replayId });
  }
  async revealFile(id: string): Promise<void> {
    try {
      if (!this.options.revealFile) throw new Error("The source file location is unavailable.");
      await this.options.revealFile(id);
    } catch (error) {
      this.report(error);
    }
  }
  dispose(): void {
    if (this.closed) return;
    this.publishResources(Object.freeze({}));
    this.releaseResourcePublication?.();
    this.releaseResourcePublication = undefined;
    this.closed = true;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.subscriptions.unsubscribe();
    this.auxiliarySequence++;
    this.statusSequence++;
    this.selectedSequence++;
    this.membershipSequence++;
    this.resourceSequence++;
    this.resourceController?.abort();
    void Promise.resolve(this.options.disposeResources?.()).catch((error) => {
      console.error("Could not release Library display resources", error);
    });
    this.view.dispose();
    this.query.dispose();
    this.state$.complete();
    this.fullMapRequest$.complete();
    this.stableSettingsRequest$.complete();
  }
}
