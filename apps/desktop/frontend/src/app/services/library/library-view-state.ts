import { BehaviorSubject } from "rxjs";
import type {
  LibraryQuery,
  LibraryQueryDetail,
  LibraryQueryPage,
  LibrarySnapshotReference,
  LibrarySort,
} from "../../../../../shared/library-query";
import { LIBRARY_SORTS, validateLibraryQuery } from "../../../../../shared/library-query";
import { LibraryQueryClient, libraryQueryErrorCode } from "./library-query-client";
import { normalizeLibraryPreferences, type LibraryPreferences } from "./library-preferences";

export type LibraryFocusRequest = ({ kind: "item"; id: string } | { kind: "first-result" | "search" }) & {
  sequence: number;
};
export interface LibraryViewSnapshot {
  route: "viewer" | "library";
  query: LibraryQuery;
  page: LibraryQueryPage | null;
  pageStart: number;
  selectedId: string | null;
  selected: LibraryQueryDetail | null;
  detailLoading: boolean;
  view: "grid" | "list";
  sidebarShown: boolean;
  width: number;
  scrollTop: number;
  scrollLeft: number;
  loading: boolean;
  loadingMore: boolean;
  loadingDirection: "before" | "after" | null;
  paginationError: { direction: "before" | "after"; message: string } | null;
  updating: boolean;
  error: string | null;
  announcement: string | null;
  focusRequest: LibraryFocusRequest | null;
  revealRequest: { id: string; position: number; sequence: number } | null;
  navigation: LibrarySnapshotReference | null;
  nowPlayingId: string | null;
  /** Renderer presentation only; never replaces ScenarioManager's installed replay or raw load state. */
  openingId: string | null;
}
export interface LibraryViewStateOptions {
  width?: number;
  sidebarShown?: boolean;
  persistSidebar?: (shown: boolean) => void;
  preferences?: Partial<LibraryPreferences>;
  persistPreferences?: (preferences: LibraryPreferences) => void;
  /** Existing app opener owns cancellation, file/resource resolution and viewer readiness. */
  openReplay: (id: string, options: { fullMap?: boolean }) => Promise<void>;
  viewerVisibility?: (visible: boolean) => void;
}
type PendingAppend = { intent: string; direction: "before" | "after"; waiting: boolean; retryInvalidated: boolean };
function selectedReturnWindow(state: LibraryViewSnapshot, id: string | null) {
  if (!id || state.route !== "library" || id !== state.selectedId) return undefined;
  const index = state.page?.items.findIndex(item => item.id === id) ?? -1;
  if (index < 0) return undefined;
  return { id, query: state.query, pageStart: state.pageStart, index };
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function normalized(input: LibraryQuery): LibraryQuery {
  validateLibraryQuery(input);
  const sort = input.sort ?? "pp";
  return copy({
    search: input.search ?? "",
    filters: input.filters ?? [],
    scope: input.scope ?? { kind: "all" },
    sort,
    direction: input.direction ?? LIBRARY_SORTS[sort].direction,
    limit: input.limit ?? 64,
  });
}
function matchingKey(query: LibraryQuery): string {
  const filters = (query.filters ?? [])
    .map((filter) =>
      "values" in filter
        ? { ...filter, values: [...filter.values].sort() }
        : filter.field === "mods"
        ? { ...filter, mods: [...filter.mods].sort(), ...(filter.excludedMods ? { excludedMods: [...filter.excludedMods].sort() } : {}) }
        : filter,
    )
    .sort((a, b) => a.field.localeCompare(b.field));
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
  return JSON.stringify(canonical({ search: query.search ?? "", filters, scope: query.scope ?? { kind: "all" } }));
}

/** One renderer-session owner outside library React mounts. Only deliberate layout,
 * sort and Me/Everyone choices survive a new session through the settings adapter. */
export class LibraryViewState {
  readonly state$: BehaviorSubject<LibraryViewSnapshot>;
  private closed = false;
  private visited = false;
  private querySequence = 0;
  private selectionSequence = 0;
  private navigationSequence = 0;
  private focusSequence = 0;
  private revealSequence = 0;
  private openingItem: string | null = null;
  private pageCommandSequence = 0;
  private appendWork?: { intent: string; promise: Promise<void> };
  private pendingAppend?: PendingAppend;
  private windowRefresh?: { intent: string; promise: Promise<void> };
  private returnWindow: ReturnType<typeof selectedReturnWindow>;
  private preferences: LibraryPreferences;
  constructor(private readonly client: LibraryQueryClient, private readonly options: LibraryViewStateOptions) {
    this.preferences = normalizeLibraryPreferences({ ...options.preferences,
      sidebarShown: options.preferences?.sidebarShown ?? options.sidebarShown });
    this.state$ = new BehaviorSubject<LibraryViewSnapshot>({
      route: "viewer",
      query: normalized({ sort: this.preferences.sort, direction: this.preferences.direction,
        filters: this.preferences.me ? [{ field: "player", values: [], me: true }] : [] }),
      page: null,
      pageStart: 0,
      selectedId: null,
      selected: null,
      detailLoading: false,
      view: this.preferences.view,
      sidebarShown: this.preferences.sidebarShown,
      width: options.width ?? 1280,
      scrollTop: 0,
      scrollLeft: 0,
      loading: false,
      loadingMore: false,
      loadingDirection: null,
      paginationError: null,
      updating: false,
      error: null,
      announcement: null,
      focusRequest: null,
      revealRequest: null,
      navigation: null,
      nowPlayingId: null,
      openingId: null,
    });
  }
  snapshot(): LibraryViewSnapshot {
    return this.state$.value;
  }
  get activeFilterCount(): number {
    return this.snapshot().query.filters?.length ?? 0;
  }
  private patch(patch: Partial<LibraryViewSnapshot>): void {
    if (!this.closed) this.state$.next({ ...this.snapshot(), ...patch });
  }
  private persistPreferences(): void {
    if (this.closed) return;
    const { query, view, sidebarShown } = this.snapshot();
    const next = normalizeLibraryPreferences({ view, sidebarShown, sort: query.sort, direction: query.direction,
      me: query.filters?.some(filter => filter.field === "player" && filter.me === true) });
    if (JSON.stringify(next) === JSON.stringify(this.preferences)) return;
    this.preferences = next;
    try { this.options.persistPreferences?.(next); }
    catch { /* A storage failure must not interrupt a committed user choice. */ }
  }
  private live(sequence: number): boolean {
    return !this.closed && sequence === this.querySequence;
  }
  private failed(error: unknown): void {
    if (libraryQueryErrorCode(error) === "library-query-updating")
      this.patch({ loading: false, detailLoading: false, updating: true, error: null });
    else
      this.patch({
        loading: false,
        detailLoading: false,
        updating: false,
        error: error instanceof Error ? error.message : "Library query failed",
      });
  }
  async commitQuery(input: LibraryQuery): Promise<void> {
    this.cancelAppend();
    this.pageCommandSequence++;
    const query = normalized(input),
      changed = matchingKey(query) !== matchingKey(this.snapshot().query);
    this.patch({
      query,
      scrollTop: 0,
      // Sorting should keep the activated right-side column in view while the
      // page refreshes. A different matching set still starts at its left edge.
      scrollLeft: changed ? 0 : this.snapshot().scrollLeft,
      // A panel-close command belongs to the prior result interaction, not a
      // future React mount or a newly committed query.
      focusRequest: null,
      revealRequest: null,
      announcement: null,
      error: null,
      loadingMore: false,
      // A retained page belongs only to its original query. Same-query refreshes
      // keep it; changed filters/order must never display that page as new results.
      ...(JSON.stringify(query) !== JSON.stringify(this.snapshot().query) ? { page: null, pageStart: 0 } : {}),
    });
    this.persistPreferences();
    await this.refresh(changed);
  }
  async setSort(sort: LibrarySort): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(LIBRARY_SORTS, sort)) throw new Error("Invalid library sort");
    await this.commitQuery({ ...this.snapshot().query, sort, direction: LIBRARY_SORTS[sort].direction });
  }
  async toggleDirection(): Promise<void> {
    await this.commitQuery({
      ...this.snapshot().query,
      direction: this.snapshot().query.direction === "asc" ? "desc" : "asc",
    });
  }
  async clearFilters(): Promise<void> {
    await this.commitQuery({ ...this.snapshot().query, filters: [] });
  }
  setView(view: "grid" | "list"): void {
    if (view !== "grid" && view !== "list") throw new Error("Invalid library view");
    this.patch({ view });
    this.persistPreferences();
  }
  setWidth(width: number): void {
    if (!Number.isFinite(width) || width < 1) throw new Error("Invalid library width");
    this.patch({ width });
  }
  setSidebarShown(shown: boolean): void {
    if (typeof shown !== "boolean") throw new Error("Invalid sidebar preference");
    if (this.snapshot().width < 900) return;
    if (shown !== this.snapshot().sidebarShown) {
      this.options.persistSidebar?.(shown);
      this.patch({ sidebarShown: shown });
      this.persistPreferences();
    }
  }
  saveScroll(scrollTop: number, scrollLeft = this.snapshot().scrollLeft): void {
    if (!Number.isFinite(scrollTop) || scrollTop < 0 || !Number.isFinite(scrollLeft) || scrollLeft < 0)
      throw new Error("Invalid library scroll position");
    this.patch({ scrollTop, scrollLeft });
  }
  async refresh(reconcileSelection = false, retainedLimit?: number): Promise<void> {
    if (this.closed) return;
    const sequence = ++this.querySequence,
      query = { ...copy(this.snapshot().query), ...(retainedLimit ? { limit: retainedLimit } : {}) },
      selectedId = this.snapshot().selectedId;
    this.patch({ loading: true, error: null });
    try {
      const page = await this.client.page(query);
      if (!this.live(sequence) || page === undefined) return;
      this.patch({ page, pageStart: 0, loading: false, updating: false, error: null });
      if (reconcileSelection && selectedId && this.snapshot().selectedId === selectedId) {
        const match = await this.client.reveal(query, selectedId);
        if (!this.live(sequence) || this.snapshot().selectedId !== selectedId || !match) return;
        if (match.state === "not-found") this.deselect("The selected replay is no longer in the results.");
      }
    } catch (error) {
      if (this.live(sequence)) this.failed(error);
    }
  }
  async refreshPreservingWindow(): Promise<void> {
    const intent = this.pageIntent();
    if (this.windowRefresh?.intent === intent) return this.windowRefresh.promise;
    const append = this.appendWork?.intent === intent ? this.appendWork.promise : undefined;
    const promise = (async () => {
      if (append) await append;
      if (this.closed || this.pageIntent() !== intent) return;
      await this.refreshWindow();
    })();
    const work = { intent, promise };
    this.windowRefresh = work;
    try { await promise; }
    finally { if (this.windowRefresh === work) this.windowRefresh = undefined; }
  }
  private pageIntent(): string {
    return `${this.pageCommandSequence}:${this.navigationSequence}`;
  }
  private async refreshWindow(): Promise<void> {
    const previous = this.snapshot(),
      anchor = previous.page?.items[0]?.id,
      limit = Math.min(128, Math.max(previous.query.limit ?? 64, previous.page?.items.length ?? 0));
    // At the head, new higher-ranked records belong before the old first ID.
    // Away from the head retain the existing bounded-window/scroll anchor.
    if (!anchor || (previous.pageStart === 0 && previous.scrollTop === 0)) {
      await this.refresh(false, limit);
      return;
    }
    const sequence = ++this.querySequence,
      query = { ...copy(this.snapshot().query), limit };
    this.patch({ loading: true, error: null });
    try {
      const result = await this.client.reveal(query, anchor);
      if (!this.live(sequence) || !result) return;
      if (result.state === "not-found") {
        this.patch({ scrollTop: 0, scrollLeft: 0 });
        await this.refresh();
        return;
      }
      this.patch({ page: result.page, pageStart: result.position, loading: false, updating: false, error: null });
    } catch (error) {
      if (this.live(sequence)) this.failed(error);
    }
  }
  async loadMore(): Promise<void> {
    await this.loadPage("after");
  }
  async loadPrevious(): Promise<void> {
    await this.loadPage("before");
  }
  private async loadPage(direction: "before" | "after"): Promise<void> {
    const intent = this.pageIntent();
    if (this.appendWork?.intent === intent) return this.appendWork.promise;
    if (this.pendingAppend?.intent === intent) return;
    const refresh = this.windowRefresh?.intent === intent ? this.windowRefresh.promise : undefined;
    const current = this.snapshot();
    if (this.closed || (direction === "after" ? !current.page?.next : current.pageStart <= 0 || !current.page?.items.length) ||
      (current.loading && !refresh)) return;
    const command = { intent, direction, waiting: false, retryInvalidated: true };
    this.pendingAppend = command;
    this.patch({ loadingMore: true, loadingDirection: direction, paginationError: null, error: null });
    await this.runAppend(command, refresh);
  }
  /** Called only after the coordinator's ready-driven retained-window refresh.
   * Busy replies leave one intent parked; edge notifications and elapsed time never retry it. */
  async resumePendingAppend(): Promise<void> {
    const command = this.pendingAppend;
    if (!command?.waiting || !this.appendCurrent(command) || this.snapshot().route !== "library") return;
    if (this.snapshot().updating) return;
    if (this.snapshot().error) { this.cancelAppend(); return; }
    await this.runAppend(command);
  }
  private appendCurrent(command: PendingAppend): boolean {
    return !this.closed && this.pendingAppend === command && this.pageIntent() === command.intent;
  }
  private cancelAppend(): void {
    if (!this.pendingAppend && !this.snapshot().paginationError) return;
    this.pendingAppend = undefined;
    // Retire an admitted page read as well as an intent parked between reads.
    if (this.appendWork) this.querySequence++;
    this.patch({ loadingMore: false, loadingDirection: null, paginationError: null, ...(this.appendWork ? { loading: false } : {}) });
  }
  private async runAppend(command: PendingAppend, refresh?: Promise<void>): Promise<void> {
    command.waiting = false;
    const promise = (async () => {
      if (refresh) await refresh;
      if (!this.appendCurrent(command)) return;
      if (refresh && this.snapshot().error) return;
      command.waiting = await this.appendPage(command);
    })();
    const work = { intent: command.intent, promise };
    this.appendWork = work;
    try { await promise; }
    finally {
      if (this.appendWork === work) this.appendWork = undefined;
      if (this.pendingAppend === command && !command.waiting) {
        this.pendingAppend = undefined;
        this.patch({ loadingMore: false, loadingDirection: null });
      }
    }
  }
  private async appendPage(command: PendingAppend): Promise<boolean> {
    const previous = this.snapshot(),
      cursor = previous.page?.next;
    if (!this.appendCurrent(command)) return false;
    if (previous.updating) return true;
    if ((command.direction === "after" ? !cursor : previous.pageStart <= 0 || !previous.page?.items.length) || previous.loading) return false;
    const sequence = ++this.querySequence;
    this.patch({ loading: true, error: null });
    try {
      if (command.direction === "before") {
        const anchor = previous.page?.items[0]?.id;
        if (!anchor) return false;
        const result = await this.client.window({ ...previous.query, limit: 128 }, anchor, { before: 64 });
        if (!this.live(sequence) || !this.appendCurrent(command) || !result) return false;
        if (result.state === "not-found") throw new Error("The earlier replay window changed. Try loading it again.");
        const overlap = result.page.items.findIndex(item => item.id === anchor);
        if (overlap < 0 || result.pageStart > 0 && overlap === 0)
          throw new Error("Earlier replays could not be loaded. Try again.");
        this.patch({ page: result.page, pageStart: result.pageStart, loading: false, updating: false, paginationError: null });
        return false;
      }
      const page = await this.client.page({ ...previous.query, cursor });
      if (!this.live(sequence) || !this.appendCurrent(command) || !page) return false;
      const retained = new Set(previous.page?.items.map(item => item.id)),
        additional = page.items.filter(item => !retained.has(item.id));
      if (page.next && (page.next === cursor || !additional.length))
        throw new Error("More replays could not be loaded. Try again.");
      const joined = [...(previous.page?.items ?? []), ...additional],
        drop = Math.max(0, joined.length - 128);
      this.patch({
        page: { ...page, items: joined.slice(drop) },
        pageStart: previous.pageStart + drop,
        loading: false,
        updating: false,
        paginationError: null,
      });
      return false;
    } catch (error) {
      if (!this.live(sequence) || !this.appendCurrent(command)) return false;
      if (libraryQueryErrorCode(error) === "library-query-invalidated" && command.retryInvalidated) {
        // Refresh the bounded window, then honour this one pending edge request.
        // A second invalidation remains visible rather than spinning on a busy index.
        command.retryInvalidated = false;
        await this.refreshWindow();
        const current = this.snapshot();
        if (!this.appendCurrent(command)) return false;
        if (current.updating) return true;
        if (current.page !== previous.page && !current.error) return this.appendPage(command);
      }
      const updating = libraryQueryErrorCode(error) === "library-query-updating";
      this.failed(error);
      if (!updating) this.patch({ paginationError: { direction: command.direction, message: this.snapshot().error ?? "Replays could not be loaded. Try again." } });
      return updating;
    }
  }
  async select(id: string | null): Promise<void> {
    if (id === null) {
      this.closePanel();
      return;
    }
    if (typeof id !== "string" || !id.length || id.length > 512) throw new Error("Invalid selected replay");
    if (id === this.snapshot().selectedId && this.snapshot().selected) return;
    this.openingItem = id;
    this.patch({ selectedId: id, selected: null, detailLoading: true, announcement: null, focusRequest: null });
    await this.loadDetail(id);
  }
  private async loadDetail(id: string): Promise<void> {
    const sequence = ++this.selectionSequence;
    try {
      const selected = await this.client.detail(id);
      if (
        this.closed ||
        sequence !== this.selectionSequence ||
        this.snapshot().selectedId !== id ||
        selected === undefined
      )
        return;
      if (selected === null) this.deselect("The selected replay is no longer available in the library.");
      else this.patch({ selected, detailLoading: false, error: null });
    } catch (error) {
      if (!this.closed && sequence === this.selectionSequence) this.failed(error);
    }
  }
  private deselect(announcement: string | null = null): void {
    this.selectionSequence++;
    this.patch({ selectedId: null, selected: null, detailLoading: false, announcement });
  }
  closePanel(visibleIds?: string[]): void {
    const ids = visibleIds ?? this.snapshot().page?.items.map((item) => item.id) ?? [],
      id = this.openingItem;
    this.deselect();
    const focus: LibraryFocusRequest =
      id && ids.includes(id)
        ? { kind: "item", id, sequence: ++this.focusSequence }
        : ids.length
        ? { kind: "first-result", sequence: ++this.focusSequence }
        : { kind: "search", sequence: ++this.focusSequence };
    this.patch({ focusRequest: focus });
  }
  async refreshAfterSelectedEdit(): Promise<void> {
    const id = this.snapshot().selectedId;
    await this.refreshPreservingWindow();
    if (id && this.snapshot().selectedId === id) await this.loadDetail(id);
  }
  async refreshSelectedDetail(): Promise<void> {
    const id = this.snapshot().selectedId;
    if (id) await this.loadDetail(id);
  }
  async collectionsDeleted(ids: string[]): Promise<void> {
    const deleted = new Set(ids),
      current = this.snapshot().query;
    const filters = (current.filters ?? []).flatMap((filter) => {
      if (filter.field !== "collection") return [filter];
      const values = filter.values.filter((value) => !deleted.has(value));
      return values.length ? [{ ...filter, values }] : [];
    });
    const scope =
      current.scope?.kind === "collection" && deleted.has(current.scope.id) ? { kind: "all" as const } : current.scope;
    await this.commitQuery({ ...current, scope, filters });
  }
  async reveal(id: string): Promise<boolean | undefined> {
    // A deliberate jump supersedes an append queued for the previous window.
    // Passive anchor reads use refreshWindow and do not retire that intent.
    this.cancelAppend();
    this.pageCommandSequence++;
    const sequence = ++this.querySequence,
      query = copy(this.snapshot().query);
    this.patch({ loading: true, loadingMore: false, error: null });
    try {
      const result = await this.client.reveal(query, id);
      if (!this.live(sequence) || !result) return undefined;
      if (result.state === "not-found") {
        this.patch({ loading: false });
        return false;
      }
      this.patch({
        page: result.page,
        pageStart: result.position,
        loading: false,
        updating: false,
        revealRequest: { id, position: result.position, sequence: ++this.revealSequence },
      });
      return true;
    } catch (error) {
      if (this.live(sequence)) this.failed(error);
      return undefined;
    }
  }
  /** Selecting/bookmarking never calls this. Only an explicit open action enters the viewer. */
  async openInViewer(id: string, options: { fullMap?: boolean } = {}): Promise<boolean> {
    if (this.closed) return false;
    this.cancelAppend();
    const sequence = ++this.navigationSequence,
      before = this.snapshot(),
      query = copy(before.query);
    // Route and presentation enter together before even the passive membership read.
    // Candidate preflight still belongs to the existing opener and retains the old viewer.
    this.querySequence++;
    // Fence page publications without invalidating a selected inspector read
    // that still belongs to the retained Library if preflight fails.
    this.patch({ route: "viewer", openingId: id, loading: false, loadingMore: false, error: null, focusRequest: null, revealRequest: null });
    this.options.viewerVisibility?.(true);
    let created: LibrarySnapshotReference | undefined;
    let opening = false;
    let installed = false;
    try {
      const match = await this.client.reveal(query, id);
      if (this.closed || sequence !== this.navigationSequence || !match) return false;
      if (match.state === "found") {
        created = await this.client.createSnapshot(query, id);
        if (!created) return false;
      } else if (this.snapshot().selectedId !== id)
        throw new Error("Replay is no longer in these results; refresh before opening it.");
      if (this.closed || sequence !== this.navigationSequence) return false;
      opening = true;
      await this.options.openReplay(id, options);
      if (this.closed || sequence !== this.navigationSequence) return false;
      const prior = this.snapshot().navigation;
      this.querySequence++;
      this.client.invalidate();
      this.visited = true;
      installed = true;
      this.returnWindow = created ? selectedReturnWindow(before, id) : undefined;
      this.patch({ route: "viewer", openingId: null, navigation: created ?? null, nowPlayingId: id, loading: false, loadingMore: false, error: null, focusRequest: null });
      if (prior && prior.snapshotId !== created?.snapshotId)
        void this.client.releaseSnapshot(prior.snapshotId).catch(() => undefined);
      return true;
    } catch (error) {
      if (this.closed || sequence !== this.navigationSequence) return false;
      if (!opening) this.failed(error);
      throw error;
    } finally {
      if (!installed && created) void this.client.releaseSnapshot(created.snapshotId).catch(() => undefined);
      if (!installed && !this.closed && sequence === this.navigationSequence) {
        this.patch({ route: before.route, openingId: null, focusRequest: before.focusRequest });
        this.options.viewerVisibility?.(before.route === "viewer");
      }
    }
  }
  async step(direction: -1 | 1): Promise<boolean> {
    if (direction !== -1 && direction !== 1) throw new Error("Invalid library navigation step");
    const navigation = this.snapshot().navigation;
    if (this.closed || !navigation) return false;
    const position = navigation.position + direction;
    if (position < 0 || position >= navigation.total) return false;
    this.cancelAppend();
    const sequence = ++this.navigationSequence;
    this.patch({ openingId: null });
    const response = await this.client.neighbors(navigation.snapshotId, { position, before: 0, after: 0 });
    if (this.closed || sequence !== this.navigationSequence || !response) return false;
    const target = response.items.find((item) => item.position === position);
    if (!target) throw new Error("Navigation snapshot no longer contains that position");
    await this.options.openReplay(target.id, {});
    if (this.closed || sequence !== this.navigationSequence) return false;
    this.returnWindow = undefined;
    this.patch({ navigation: { ...navigation, position }, nowPlayingId: target.id, error: null });
    return true;
  }
  async returnToLibrary(): Promise<void> {
    if (this.closed) return;
    this.cancelAppend();
    this.navigationSequence++;
    const wasOpening = this.snapshot().openingId !== null;
    const firstVisit = !this.visited;
    this.visited = true;
    const id = this.snapshot().nowPlayingId;
    const savedWindow = this.returnWindow;
    this.returnWindow = undefined;
    this.patch({ route: "library", openingId: null, error: null });
    this.options.viewerVisibility?.(false);
    if (firstVisit) {
      await this.refresh();
      return;
    }
    if (!id || wasOpening) {
      // An externally loaded viewer does not select a Library replay. Keep the
      // bounded result window that owns the saved scroll instead of shrinking it.
      await this.refreshPreservingWindow();
      return;
    }
    if (savedWindow?.id === id && savedWindow.query === this.snapshot().query && this.snapshot().selectedId === id) {
      const intent = this.pageIntent();
      await this.refreshPreservingWindow();
      const current = this.snapshot();
      if (this.closed || this.pageIntent() !== intent || current.selectedId !== id || current.error || current.updating) return;
      // Reopening the same inspector should keep the cards above it in view.
      // A moved or missing score still uses the indexed reveal below.
      if (current.pageStart === savedWindow.pageStart && current.page?.items[savedWindow.index]?.id === id) return;
    }
    const found = await this.reveal(id);
    if (this.closed || found === undefined) return;
    if (found) await this.select(id);
    else if (!this.snapshot().updating && !this.snapshot().error) {
      this.deselect("The replay is no longer in the results.");
      await this.refresh();
    }
  }
  showViewer(): void {
    if (this.closed) return;
    this.cancelAppend();
    this.navigationSequence++;
    this.querySequence++;
    this.client.invalidate();
    const state = this.snapshot();
    if (state.route === "library") this.returnWindow = selectedReturnWindow(state, state.nowPlayingId);
    this.patch({ route: "viewer", openingId: null, loading: false, loadingMore: false, error: null, focusRequest: null, revealRequest: null });
    this.options.viewerVisibility?.(true);
  }
  /** Called when F2/drop/current-viewer loading changes the replay outside this snapshot. */
  setNowPlaying(id: string | null): void {
    this.cancelAppend();
    this.returnWindow = undefined;
    const prior = this.snapshot().navigation;
    this.navigationSequence++;
    this.patch({ nowPlayingId: id, navigation: null, openingId: null });
    if (prior) void this.client.releaseSnapshot(prior.snapshotId).catch(() => undefined);
  }
  dispose(): void {
    if (this.closed) return;
    this.cancelAppend();
    const navigation = this.snapshot().navigation;
    this.closed = true;
    this.querySequence++;
    this.selectionSequence++;
    this.navigationSequence++;
    if (navigation) void this.client.releaseSnapshot(navigation.snapshotId).catch(() => undefined);
    this.state$.complete();
  }
}
