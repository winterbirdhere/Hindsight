import { LibraryViewState } from "./library-view-state";
import type { LibraryQueryClient } from "./library-query-client";
import type { LibraryQuery, LibraryQueryDetail, LibraryQueryPage } from "../../../../../shared/library-query";

const page = (ids = ["a", "b"]): LibraryQueryPage => ({
  items: ids.map((id) => ({ id })) as LibraryQueryPage["items"],
  total: ids.length,
  analysisExcluded: 0,
});
const detail = (id: string): LibraryQueryDetail => ({
  item: { id } as LibraryQueryDetail["item"],
  mapIdentity: null,
  metrics: [],
});
function fixture() {
  const client = {
    page: jest.fn(async (_query?: unknown) => page()),
    detail: jest.fn(async (id: string) => detail(id)),
    reveal: jest.fn(async (_q: unknown, id: string) => ({
      state: "found",
      position: id === "b" ? 1 : 0,
      page: page([id]),
    })),
    createSnapshot: jest.fn(async () => ({
      snapshotId: "snapshot",
      total: 2,
      position: 0,
      scopeLabel: "Practice",
      sortLabel: "PP",
    })),
    neighbors: jest.fn(async (_id: string, options: { position: number }) => ({
      snapshotId: "snapshot",
      total: 2,
      position: options.position,
      scopeLabel: "Practice",
      sortLabel: "PP",
      items: [{ id: options.position === 0 ? "a" : "b", position: options.position }],
    })),
    releaseSnapshot: jest.fn(async () => undefined),
    invalidate: jest.fn(),
  };
  const openReplay = jest.fn(async () => undefined),
    persistSidebar = jest.fn(),
    viewerVisibility = jest.fn();
  const state = new LibraryViewState(client as unknown as LibraryQueryClient, {
    openReplay,
    persistSidebar,
    viewerVisibility,
    sidebarShown: true,
    width: 1680,
  });
  return { state, client, openReplay, persistSidebar, viewerVisibility };
}
it.each<{ name: string; query: LibraryQuery; left: number }>([
  { name: "direction", query: { sort: "pp", direction: "asc" }, left: 500 },
  { name: "sort", query: { sort: "ur", direction: "asc" }, left: 500 },
  { name: "search", query: { search: "new" }, left: 0 },
  { name: "filter", query: { filters: [{ field: "source", values: ["stable"] }] }, left: 0 },
  { name: "scope", query: { scope: { kind: "favourites" } }, left: 0 },
])("throughput list focus: retains horizontal position only for ordering changes ($name)", async ({ query, left }) => {
  const f = fixture();
  await f.state.returnToLibrary();
  f.state.saveScroll(700, 500);
  let finish!: (result: LibraryQueryPage) => void;
  f.client.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.state.commitQuery(query);
  expect(f.state.snapshot()).toMatchObject({ scrollTop: 0, scrollLeft: left, pageStart: 0, page: null, loading: true });
  finish(page(["b", "a"]));
  await pending;
  expect(f.state.snapshot()).toMatchObject({ scrollTop: 0, scrollLeft: left, pageStart: 0, loading: false });
  expect(f.state.snapshot().page?.items.map(row => row.id)).toEqual(["b", "a"]);
  f.state.dispose();
});
describe("manual feedback pagination", () => {
  const windowPage = (start: number, size: number): LibraryQueryPage => ({
    ...page(Array.from({ length: size }, (_, index) => `replay-${start + index}`)),
    total: 256,
    next: `after-${start + size}`,
    revision: "current",
  });
  it("keeps one append pending after an updating reply without retrying on repeated clicks", async () => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64));
    await f.state.returnToLibrary();
    f.client.page.mockRejectedValue(Object.assign(new Error("index updating"), { code: "library-query-updating" }));
    await f.state.loadMore();
    expect(f.state.snapshot()).toMatchObject({ loading: false, loadingMore: true, updating: true, error: null });
    await f.state.loadMore();
    await f.state.loadMore();
    expect(f.client.page).toHaveBeenCalledTimes(2);
    expect(f.state.snapshot().page?.items).toEqual(windowPage(0, 64).items);
    f.state.dispose();
  });
  const updating = () => Object.assign(new Error("index updating"), { code: "library-query-updating" });
  const ready = async (f: ReturnType<typeof fixture>) => {
    await f.state.refreshPreservingWindow();
    await f.state.resumePendingAppend();
  };
  it("parks an append queued behind a busy passive read and retries at most once per ready refresh", async () => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64));
    await f.state.returnToLibrary();
    f.state.saveScroll(350);
    let failRefresh!: (error: Error) => void;
    f.client.reveal.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRefresh = reject; }));
    const refresh = f.state.refreshPreservingWindow(), append = f.state.loadMore();
    failRefresh(updating());
    await Promise.all([refresh, append]);
    expect(f.state.snapshot()).toMatchObject({ loadingMore: true, updating: true, scrollTop: 350 });
    expect(f.client.page).toHaveBeenCalledTimes(1);
    f.client.reveal.mockResolvedValue({ state: "found", position: 0, page: windowPage(0, 64) });
    f.client.page.mockRejectedValueOnce(updating()).mockRejectedValueOnce(updating()).mockResolvedValueOnce(windowPage(64, 64));
    for (let attempt = 1; attempt <= 2; attempt++) {
      await ready(f);
      await f.state.loadMore();
      expect(f.client.page).toHaveBeenCalledTimes(1 + attempt);
      expect(f.state.snapshot()).toMatchObject({ loadingMore: true, updating: true });
    }
    await ready(f);
    expect(f.client.page).toHaveBeenCalledTimes(4);
    expect(f.state.snapshot()).toMatchObject({ loadingMore: false, updating: false, scrollTop: 350, pageStart: 0 });
    expect(f.state.snapshot().page?.items).toEqual(windowPage(0, 128).items);
    f.state.dispose();
  });
  it("keeps the one invalidated-cursor retry budget across a busy recovery window", async () => {
    const f = fixture(), invalidated = Object.assign(new Error("index changed again"), { code: "library-query-invalidated" });
    f.client.page.mockResolvedValueOnce(windowPage(0, 64));
    await f.state.returnToLibrary();
    f.state.saveScroll(350);
    f.client.page.mockRejectedValue(invalidated);
    f.client.reveal.mockRejectedValueOnce(updating());
    await f.state.loadMore();
    expect(f.state.snapshot()).toMatchObject({ loadingMore: true, updating: true });
    f.client.reveal.mockResolvedValue({ state: "found", position: 0, page: windowPage(0, 64) });
    await ready(f);
    expect(f.client.page).toHaveBeenCalledTimes(3);
    expect(f.client.reveal).toHaveBeenCalledTimes(2);
    expect(f.state.snapshot()).toMatchObject({ loadingMore: false, loading: false, error: "index changed again" });
    f.client.page.mockResolvedValueOnce(windowPage(64, 64));
    await f.state.loadMore();
    expect(f.state.snapshot().page?.items).toHaveLength(128);
    f.state.dispose();
  });
  it.each(["query", "sort", "direction", "reveal", "viewer", "open", "external", "dispose"] as const)(
    "cancels a parked append on %s rather than reviving it at readiness", async action => {
      const f = fixture();
      f.client.page.mockResolvedValueOnce(windowPage(0, 64));
      await f.state.returnToLibrary();
      f.client.page.mockRejectedValueOnce(updating());
      await f.state.loadMore();
      f.client.page.mockResolvedValue(windowPage(0, 64));
      if (action === "query") await f.state.commitQuery({ search: "new" });
      else if (action === "sort") await f.state.setSort("title");
      else if (action === "direction") await f.state.toggleDirection();
      else if (action === "reveal") await f.state.reveal("replay-128");
      else if (action === "viewer") f.state.showViewer();
      else if (action === "open") await f.state.openInViewer("replay-0");
      else if (action === "external") f.state.setNowPlaying("outside");
      else f.state.dispose();
      expect(f.state.snapshot().loadingMore).toBe(false);
      if (action !== "dispose") {
        if (f.state.snapshot().route === "viewer") await f.state.returnToLibrary();
        await ready(f);
      }
      expect(f.client.page.mock.calls.filter(([query]) => (query as LibraryQuery).cursor)).toHaveLength(1);
      f.state.dispose();
    },
  );
  it.each(["error", "end"] as const)("ends a parked append when its refreshed window reports %s", async result => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64));
    await f.state.returnToLibrary();
    f.client.page.mockRejectedValueOnce(updating());
    await f.state.loadMore();
    if (result === "error") f.client.page.mockRejectedValueOnce(new Error("read failed"));
    else f.client.page.mockResolvedValueOnce({ ...windowPage(0, 64), next: undefined });
    await ready(f);
    expect(f.state.snapshot()).toMatchObject({ loadingMore: false, loading: false, error: result === "error" ? "read failed" : null });
    expect(f.client.page).toHaveBeenCalledTimes(3);
    f.state.dispose();
  });
  it("fences a resumed append that finishes after a new query starts its own append", async () => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64));
    await f.state.returnToLibrary();
    f.client.page.mockRejectedValueOnce(updating());
    await f.state.loadMore();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64));
    await f.state.refreshPreservingWindow();
    let oldDone!: (value: LibraryQueryPage) => void, newDone!: (value: LibraryQueryPage) => void;
    f.client.page.mockImplementationOnce(() => new Promise(resolve => { oldDone = resolve; }));
    const old = f.state.resumePendingAppend();
    f.client.page.mockResolvedValueOnce(windowPage(128, 64));
    await f.state.commitQuery({ search: "new" });
    f.client.page.mockImplementationOnce(() => new Promise(resolve => { newDone = resolve; }));
    const current = f.state.loadMore();
    oldDone(windowPage(64, 64));
    await old;
    expect(f.state.snapshot()).toMatchObject({ loadingMore: true, loading: true });
    expect(f.state.snapshot().page?.items).toEqual(windowPage(128, 64).items);
    newDone(windowPage(192, 64));
    await current;
    expect(f.state.snapshot()).toMatchObject({ loadingMore: false, loading: false });
    expect(f.state.snapshot().page?.items).toEqual(windowPage(128, 128).items);
    f.state.dispose();
  });
  it.each([0, 64])("retains the appended window starting at %s when returning from an external viewer", async start => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64)).mockResolvedValueOnce(windowPage(64, 64));
    await f.state.returnToLibrary();
    await f.state.loadMore();
    if (start) {
      f.client.page.mockResolvedValueOnce(windowPage(128, 64));
      await f.state.loadMore();
    }
    await f.state.select(`replay-${start + 90}`);
    const selected = f.state.snapshot().selected;
    f.state.saveScroll(90 * 54);
    f.state.showViewer();
    expect(f.state.snapshot().nowPlayingId).toBeNull();
    f.client.page.mockImplementation(async query => windowPage(0, (query as { limit: number }).limit));
    f.client.reveal.mockImplementation(async (query, id) => ({
      state: "found", position: Number(id.slice("replay-".length)),
      page: windowPage(Number(id.slice("replay-".length)), (query as { limit: number }).limit),
    }));
    await f.state.returnToLibrary();
    expect(f.state.snapshot().page?.items).toEqual(windowPage(start, 128).items);
    expect(f.state.snapshot()).toMatchObject({
      route: "library", pageStart: start, scrollTop: 90 * 54, selectedId: `replay-${start + 90}`,
      selected, loading: false, focusRequest: null, revealRequest: null,
    });
    expect(f.state.snapshot().query.limit).toBe(64);
    expect(f.openReplay).not.toHaveBeenCalled();
    f.state.dispose();
  });
  it("finishes an explicit append before a passive refresh and preserves its expanded window", async () => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64));
    await f.state.returnToLibrary();
    f.state.saveScroll(350);
    let finishAppend!: (result: LibraryQueryPage) => void;
    f.client.page.mockImplementationOnce(() => new Promise(resolve => { finishAppend = resolve; }));
    f.client.reveal.mockResolvedValue({ state: "found", position: 0, page: windowPage(0, 128) });
    const append = f.state.loadMore();
    const refresh = f.state.refreshPreservingWindow();
    expect(f.client.reveal).not.toHaveBeenCalled();
    finishAppend(windowPage(64, 64));
    await Promise.all([append, refresh]);
    expect(f.client.reveal).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 128 }), "replay-0");
    expect(f.state.snapshot().page?.items.map(row => row.id)).toEqual(windowPage(0, 128).items.map(row => row.id));
    expect(f.state.snapshot()).toMatchObject({ pageStart: 0, scrollTop: 350, loading: false });
    expect(f.state.snapshot().query.limit).toBe(64);
    f.state.dispose();
  });
  it.each([0, 350])("keeps 128 loaded rows through passive refresh at scroll %s", async scroll => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64)).mockResolvedValueOnce(windowPage(64, 64));
    await f.state.returnToLibrary();
    await f.state.loadMore();
    f.state.saveScroll(scroll);
    f.client.page.mockImplementation(async query => windowPage(0, (query as { limit: number }).limit));
    f.client.reveal.mockImplementation(async (query, _id) => ({
      state: "found", position: 0, page: windowPage(0, (query as { limit: number }).limit),
    }));
    await f.state.refreshPreservingWindow();
    expect(f.state.snapshot().page?.items).toHaveLength(128);
    expect(f.state.snapshot()).toMatchObject({ pageStart: 0, scrollTop: scroll, loading: false });
    expect(f.state.snapshot().query.limit).toBe(64);
    f.state.dispose();
  });
  it("refreshes an invalidated cursor around its loaded window then fulfils one append without a head reset", async () => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64)).mockResolvedValueOnce(windowPage(64, 64));
    await f.state.returnToLibrary();
    await f.state.loadMore();
    f.state.saveScroll(800);
    f.client.page.mockRejectedValueOnce(Object.assign(new Error("index changed"), { code: "library-query-invalidated" }))
      .mockResolvedValueOnce(windowPage(128, 64));
    f.client.reveal.mockResolvedValue({ state: "found", position: 0, page: windowPage(0, 128) });
    await f.state.loadMore();
    expect(f.client.reveal).toHaveBeenCalledWith(expect.objectContaining({ limit: 128 }), "replay-0");
    expect(f.state.snapshot()).toMatchObject({ pageStart: 64, scrollTop: 800, loading: false, loadingMore: false });
    expect(f.state.snapshot().page?.items.map(row => row.id)).toEqual(windowPage(64, 128).items.map(row => row.id));
    f.state.dispose();
  });
  it("queues one append behind a passive read and fences it when the query changes", async () => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64));
    await f.state.returnToLibrary();
    f.state.saveScroll(350);
    let finishRefresh!: (value: { state: string; position: number; page: LibraryQueryPage }) => void;
    f.client.reveal.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    const refresh = f.state.refreshPreservingWindow();
    const append = f.state.loadMore();
    expect(f.state.snapshot().loadingMore).toBe(true);
    f.client.page.mockResolvedValueOnce(page(["different"]));
    await f.state.commitQuery({ search: "different" });
    finishRefresh({ state: "found", position: 0, page: windowPage(0, 64) });
    await Promise.all([refresh, append]);
    expect(f.state.snapshot().page?.items.map(row => row.id)).toEqual(["different"]);
    expect(f.client.page.mock.calls.some(([query]) => (query as { cursor?: string }).cursor)).toBe(false);
    expect(f.state.snapshot().loadingMore).toBe(false);
    f.state.dispose();
  });
  it("ends a second cursor invalidation without an automatic retry loop or discarding retained rows", async () => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64));
    await f.state.returnToLibrary();
    f.state.saveScroll(350);
    const invalidated = Object.assign(new Error("index changed again"), { code: "library-query-invalidated" });
    f.client.page.mockRejectedValue(invalidated);
    f.client.reveal.mockResolvedValue({ state: "found", position: 0, page: windowPage(0, 64) });
    await f.state.loadMore();
    expect(f.client.page).toHaveBeenCalledTimes(3);
    expect(f.client.reveal).toHaveBeenCalledTimes(1);
    expect(f.state.snapshot()).toMatchObject({ loading: false, loadingMore: false, scrollTop: 350, error: "index changed again" });
    expect(f.state.snapshot().page?.items).toEqual(windowPage(0, 64).items);
    f.state.dispose();
  });
  it("finishes one queued append after a held passive refresh and ignores repeated clicks", async () => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64));
    await f.state.returnToLibrary();
    f.state.saveScroll(350);
    let finish!: (value: { state: string; position: number; page: LibraryQueryPage }) => void;
    f.client.reveal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.client.page.mockResolvedValueOnce(windowPage(64, 64));
    const refresh = f.state.refreshPreservingWindow(), append = f.state.loadMore(), repeated = f.state.loadMore();
    expect(f.state.snapshot().loadingMore).toBe(true);
    finish({ state: "found", position: 0, page: windowPage(0, 64) });
    await Promise.all([refresh, append, repeated]);
    expect(f.client.page).toHaveBeenCalledTimes(2);
    expect(f.state.snapshot().page?.items).toEqual(windowPage(0, 128).items);
    expect(f.state.snapshot()).toMatchObject({ loading: false, loadingMore: false, scrollTop: 350 });
    f.state.dispose();
  });
  it("fences a queued append when a deliberate reveal moves to a different result window", async () => {
    const f = fixture();
    f.client.page.mockResolvedValueOnce(windowPage(0, 64));
    await f.state.returnToLibrary();
    f.state.saveScroll(350);
    let finish!: (value: { state: string; position: number; page: LibraryQueryPage }) => void;
    f.client.reveal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const refresh = f.state.refreshPreservingWindow(), append = f.state.loadMore();
    f.client.reveal.mockResolvedValueOnce({ state: "found", position: 128, page: windowPage(128, 64) });
    await f.state.reveal("replay-128");
    finish({ state: "found", position: 0, page: windowPage(0, 64) });
    await Promise.all([refresh, append]);
    expect(f.client.page).toHaveBeenCalledTimes(1);
    expect(f.state.snapshot()).toMatchObject({ pageStart: 128, loading: false, loadingMore: false });
    expect(f.state.snapshot().page?.items).toEqual(windowPage(128, 64).items);
    f.state.dispose();
  });
});
it("keeps existing viewer startup and first library visit unselected; selection never opens", async () => {
  const f = fixture();
  expect(f.state.snapshot().route).toBe("viewer");
  expect(f.client.page).not.toHaveBeenCalled();
  await f.state.returnToLibrary();
  expect(f.state.snapshot().selectedId).toBeNull();
  await f.state.select("a");
  await f.state.select("a");
  expect(f.state.snapshot().selected?.item.id).toBe("a");
  expect(f.openReplay).not.toHaveBeenCalled();
});
it.each(["query", "viewer", "open"] as const)(
  "retires a panel-close focus command when superseded by %s, preserving later explicit focus",
  async (action) => {
    const f = fixture();
    await f.state.returnToLibrary();
    await f.state.select("a");
    f.state.closePanel(["a", "b"]);
    const firstCommand = f.state.snapshot().focusRequest;
    expect(firstCommand).toMatchObject({ kind: "item", id: "a" });
    f.state.saveScroll(590);
    if (action === "query") await f.state.commitQuery({ search: "Filler" });
    else if (action === "viewer") f.state.showViewer();
    else await f.state.openInViewer("b");
    expect(f.state.snapshot().focusRequest).toBeNull();
    expect(f.state.snapshot().scrollTop).toBe(action === "query" ? 0 : 590);
    if (action !== "query") await f.state.returnToLibrary();
    await f.state.select("b");
    f.state.closePanel(["a", "b"]);
    expect(f.state.snapshot().focusRequest).toMatchObject({ kind: "item", id: "b" });
    expect(f.state.snapshot().focusRequest?.sequence).toBeGreaterThan(firstCommand?.sequence ?? 0);
    f.state.dispose();
  },
);
it("does not retire focus or reset stored scroll for a failed explicit viewer open", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  await f.state.select("a");
  f.state.closePanel(["a", "b"]);
  f.state.saveScroll(590);
  const focusRequest = f.state.snapshot().focusRequest;
  f.openReplay.mockRejectedValueOnce(new Error("missing map"));
  await expect(f.state.openInViewer("b")).rejects.toThrow("missing map");
  expect(f.state.snapshot()).toMatchObject({ route: "library", scrollTop: 590, focusRequest });
  f.state.dispose();
});
it("clears prior-query rows immediately on an explicit changed query, including a failed replacement", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  await f.state.select("a");
  let reject!: (error: Error) => void;
  f.client.page.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const changing = f.state.commitQuery({ search: "different" });
  expect(f.state.snapshot()).toMatchObject({ page: null, pageStart: 0, loading: true, selectedId: "a" });
  reject(new Error("replacement failed"));
  await changing;
  expect(f.state.snapshot()).toMatchObject({
    page: null,
    loading: false,
    error: "replacement failed",
    selectedId: "a",
  });
  f.state.dispose();
});
it("deselects only after committed hiding changes, preserves edited detail, and never selects another row", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  await f.state.select("a");
  f.client.reveal.mockResolvedValue({ state: "not-found" } as never);
  await f.state.refreshAfterSelectedEdit();
  expect(f.state.snapshot().selectedId).toBe("a");
  await f.state.commitQuery({ search: "hidden" });
  expect(f.state.snapshot()).toMatchObject({ selectedId: null, selected: null });
  expect(f.state.snapshot().announcement).toMatch(/no longer/);
  expect(f.openReplay).not.toHaveBeenCalled();
});
it("preserves controls and scroll through snapshot stepping and reveals the stepped replay on return", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  await f.state.commitQuery({
    scope: { kind: "favourites" },
    search: "song",
    filters: [{ field: "grade", values: ["S"] }],
    sort: "title",
    direction: "asc",
  });
  f.state.setView("list");
  f.state.saveScroll(950);
  await f.state.select("a");
  await f.state.openInViewer("a");
  expect(f.state.snapshot().route).toBe("viewer");
  expect(f.client.createSnapshot).toHaveBeenCalledTimes(1);
  await f.state.step(1);
  expect(f.openReplay).toHaveBeenLastCalledWith("b", {});
  expect(await f.state.step(1)).toBe(false);
  await f.state.returnToLibrary();
  expect(f.state.snapshot()).toMatchObject({
    route: "library",
    view: "list",
    scrollTop: 950,
    selectedId: "b",
    query: { search: "song", sort: "title", direction: "asc", scope: { kind: "favourites" } },
    revealRequest: { id: "b", position: 1 },
  });
  expect(f.client.createSnapshot).toHaveBeenCalledTimes(1);
});
it("opens a retained selected replay outside results without inventing a navigation position", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  await f.state.select("a");
  f.client.reveal.mockResolvedValue({ state: "not-found" } as never);
  await f.state.openInViewer("a");
  expect(f.openReplay).toHaveBeenCalledWith("a", {});
  expect(f.state.snapshot().navigation).toBeNull();
  expect(f.client.createSnapshot).not.toHaveBeenCalled();
  await f.state.returnToLibrary();
  expect(f.state.snapshot().selectedId).toBeNull();
});
it("does not turn snapshot/storage errors into an untracked open", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  await f.state.select("a");
  f.client.createSnapshot.mockRejectedValue(new Error("database unavailable"));
  await expect(f.state.openInViewer("a")).rejects.toThrow("database unavailable");
  expect(f.openReplay).not.toHaveBeenCalled();
  expect(f.state.snapshot().route).toBe("library");
});
it("keeps successful query data separate from a rejected replay opening", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  await f.state.select("a");
  const before = f.state.snapshot();
  f.openReplay.mockRejectedValueOnce(new Error("map unavailable"));
  await expect(f.state.openInViewer("a")).rejects.toThrow("map unavailable");
  expect(f.state.snapshot()).toMatchObject({ route: "library", error: null, page: before.page, selected: before.selected });
  expect(f.client.releaseSnapshot).toHaveBeenCalledWith("snapshot");
  expect(f.viewerVisibility).not.toHaveBeenCalledWith(true);
});
it("keeps docked sidebar preference separate from narrow overlays and preserves search when clearing filters", async () => {
  const f = fixture();
  f.state.setWidth(800);
  f.state.setSidebarShown(false);
  expect(f.persistSidebar).not.toHaveBeenCalled();
  expect(f.state.snapshot().sidebarShown).toBe(true);
  f.state.setWidth(1680);
  f.state.setSidebarShown(false);
  expect(f.persistSidebar).toHaveBeenCalledWith(false);
  await f.state.commitQuery({ search: "literal", filters: [{ field: "grade", values: [] }], sort: "pp" });
  expect(f.state.activeFilterCount).toBe(1);
  await f.state.clearFilters();
  expect(f.state.snapshot().query.search).toBe("literal");
  expect(f.state.activeFilterCount).toBe(0);
  await f.state.setSort("ur");
  expect(f.state.snapshot().query.direction).toBe("asc");
  await f.state.setSort("pp");
  expect(f.state.snapshot().query.direction).toBe("desc");
});
it("keeps last known results while projection updates and never polls itself", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  const before = f.state.snapshot().page;
  f.client.page.mockRejectedValue(Object.assign(new Error("Updating"), { code: "library-query-updating" }));
  await f.state.refresh();
  expect(f.state.snapshot()).toMatchObject({ page: before, updating: true, loading: false });
  expect(f.client.page).toHaveBeenCalledTimes(2);
});
it("clears deleted collection scopes/only-deleted filters and computes close focus without opening viewer", async () => {
  const f = fixture();
  await f.state.commitQuery({
    scope: { kind: "collection", id: "p" },
    filters: [{ field: "collection", values: ["p", "child"] }],
  });
  await f.state.collectionsDeleted(["p", "child"]);
  expect(f.state.snapshot().query).toMatchObject({ scope: { kind: "all" }, filters: [] });
  await f.state.select("a");
  f.state.closePanel(["b"]);
  expect(f.state.snapshot().focusRequest).toMatchObject({ kind: "first-result" });
  await f.state.select("a");
  f.state.closePanel([]);
  expect(f.state.snapshot().focusRequest).toMatchObject({ kind: "search" });
});
it("does not let an obsolete return reveal deselect a newer committed selection", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  await f.state.select("a");
  f.state.setNowPlaying("a");
  let finish!: (result: unknown) => void;
  f.client.reveal.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
  );
  const returning = f.state.returnToLibrary();
  await f.state.commitQuery({ search: "new query" });
  await f.state.select("b");
  finish({ state: "not-found" });
  await returning;
  expect(f.state.snapshot()).toMatchObject({ selectedId: "b", query: { search: "new query" } });
});
it("returns to the current viewer without reopening or replacing its snapshot", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  await f.state.openInViewer("a");
  await f.state.returnToLibrary();
  const navigation = f.state.snapshot().navigation;
  f.state.showViewer();
  expect(f.state.snapshot()).toMatchObject({ route: "viewer", navigation });
  expect(f.openReplay).toHaveBeenCalledTimes(1);
});
it("refreshes an existing result window around its first ID without changing controls, scroll or selected detail", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  await f.state.select("a");
  f.state.saveScroll(350);
  f.client.reveal.mockResolvedValue({ state: "found", position: 64, page: page(["a", "b"]) });
  await f.state.refreshPreservingWindow();
  expect(f.state.snapshot()).toMatchObject({ pageStart: 64, scrollTop: 350, selectedId: "a", revealRequest: null });
});
it("refreshes the head window from zero so newly preceding replays are visible without losing selection", async () => {
  const f = fixture();
  await f.state.returnToLibrary();
  await f.state.select("a");
  const selected = f.state.snapshot().selected;
  f.client.page.mockResolvedValue(page(["new-higher-pp", "a", "b"]));
  f.client.reveal.mockResolvedValue({ state: "found", position: 1, page: page(["a", "b"]) });
  f.client.reveal.mockClear();
  await f.state.refreshPreservingWindow();
  expect(f.state.snapshot()).toMatchObject({
    pageStart: 0,
    scrollTop: 0,
    selectedId: "a",
    selected,
    page: { items: [{ id: "new-higher-pp" }, { id: "a" }, { id: "b" }] },
  });
  expect(f.client.reveal).not.toHaveBeenCalled();
});
