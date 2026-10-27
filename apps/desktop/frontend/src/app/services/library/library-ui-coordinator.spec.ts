import { Subject } from "rxjs";
import { LibraryUiCoordinator, LibraryUiOptions } from "./library-ui-coordinator";
import { LibraryPassiveResourceClient } from "./library-passive-resource-client";
import type { LibraryChangedEvent, LibraryRequest } from "../../../../../shared/replay-library";
import { LibraryExactMapUnavailableError } from "./library-replay-resources";

const item = (id: string) => ({ id, title: id, collectionIds: [], collectionCount: 0 });
const page = (id = "a") => ({ items: [item(id)], total: 1, analysisExcluded: 0 });
const detail = (id: string) => ({ item: item(id), metrics: [], mapIdentity: "map" });
const settings = { mode: "off", workers: 1, userPaused: false, pauseOnBattery: true };
function fixture(options: Partial<LibraryUiOptions> = {}) {
  const changes$ = new Subject<LibraryChangedEvent>();
  const request = jest.fn(async (input: LibraryRequest): Promise<unknown> => {
    switch (input.method) {
      case "query-page":
        return page();
      case "query-detail":
        return detail(input.replayId);
      case "query-reveal":
        return { state: "found", position: 0, page: page(input.replayId) };
      case "query-bands":
        return { items: [{ key: "band", label: "Band", count: 1, anchorId: "a" }] };
      case "query-facets":
        return { items: [{ value: "stable", count: 1 }] };
      case "query-collections":
        return { items: [], total: 0 };
      case "query-memberships":
        return { items: [], total: 0 };
      case "query-same-map":
        return page();
      case "status":
        return {
          replayCount: 1,
          sources: [],
          updateMode: "manual",
          rebuild: { state: "idle", observations: 0, mapErrors: {} },
          importRecovery: { state: "complete", completed: 0, failed: 0, failures: [] },
        };
      case "analysis-settings":
        return input.settings ?? settings;
      case "query-player-names":
        return { names: [] };
      case "query-snapshot-create":
        return { snapshotId: "snap", total: 1, position: 0, scopeLabel: "All", sortLabel: "PP" };
      default:
        return null;
    }
  });
  const navigate = jest.fn(),
    openReplay = jest.fn(async () => undefined),
    locateStable = jest.fn(async () => undefined),
    viewerVisibility = jest.fn();
  const coordinator = new LibraryUiCoordinator(
    { request, changes$, setViewerVisible: viewerVisibility },
    { navigate, openReplay, locateStable, ...options },
  );
  coordinator.connect();
  return { coordinator, request, changes$, navigate, openReplay, viewerVisibility };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
it.each(["refresh", "append", "error"] as const)("throughput list feedback: rejects old same-revision bands (%s) during a changed-query reveal", async (kind) => {
  const f = fixture();
  const original = fixtureRequest(f);
  let holdBands = false;
  let finishBands!: (value: unknown) => void;
  let failBands!: (reason: Error) => void;
  let finishReveal!: (value: unknown) => void;
  f.request.mockImplementation(async input => {
    if (input.method === "query-bands") {
      if (holdBands) return new Promise((resolve, reject) => { finishBands = resolve; failBands = reject; });
      return { items: [{ key: "old", label: "Old", count: 1, anchorId: "a" }], next: "more", revision: "same" };
    }
    if (input.method === "query-reveal" && input.query?.search === "new") return new Promise(resolve => { finishReveal = resolve; });
    const result = await original(input);
    if (["query-page", "query-facets", "query-collections"].includes(input.method)) return { ...result as object, revision: "same" };
    return result;
  });
  await f.coordinator.enterLibrary();
  await f.coordinator.select("a");
  holdBands = true;
  const old = kind === "append" ? f.coordinator.loadMoreBands() : f.coordinator.commitQuery({ sort: "pp", direction: "asc" });
  await flush();
  expect(finishBands).toBeDefined();
  const changed = f.coordinator.commitQuery({ search: "new", sort: "pp", direction: "desc" });
  await flush();
  expect(finishReveal).toBeDefined();
  if (kind === "error") failBands(new Error("old query error"));
  else finishBands({ items: [{ key: "stale", label: "Stale", count: 1, anchorId: "a" }], revision: "same" });
  await old;
  expect(f.coordinator.snapshot().bands.items).toEqual([]);
  expect(f.coordinator.snapshot().error).toBeUndefined();
  holdBands = false;
  finishReveal({ state: "found", position: 0, page: { ...page(), revision: "same" } });
  await changed;
  expect(f.request.mock.calls.filter(([input]) => input.method === "analysis-request")).toHaveLength(1);
  f.coordinator.dispose();
});
function fixtureRequest(f: ReturnType<typeof fixture>) {
  const request = f.request.getMockImplementation();
  if (!request) throw new Error("Expected fixture transport");
  return request;
}
function resourceFixture(artworkByte: (id: string) => Promise<number | undefined> = async () => 1, contentKey: (id: string) => string = id => id) {
  const revoked: string[] = [],
    readIds: string[] = [],
    liveUrls = new Set<string>();
  let created = 0,
    peakUrls = 0;
  const bytes = new Map<string, Uint8Array>(), identities = new Map<string, number>();
  const client = new LibraryPassiveResourceClient(
    {
      resource: async (input) => {
        if (input.method === "artwork") {
          readIds.push(input.replayId);
          const byte = await artworkByte(input.replayId);
          if (byte === undefined) return { state: "unavailable" };
          const key = contentKey(input.replayId);
          if (!identities.has(key)) identities.set(key, identities.size + 1);
          const id = identities.get(key) ?? 0;
          bytes.set(input.requestId, new Uint8Array([byte, id & 255, id >> 8]));
          return { state: "ready", bytes: 3, mime: "image/png" };
        }
        if (input.method === "chunk") return { bytes: bytes.get(input.requestId) ?? new Uint8Array([1, 0, 0]), done: true };
        if (input.method === "release") bytes.delete(input.requestId);
        return input.method === "strip" ? null : undefined;
      },
    },
    {
      create: () => {
        const url = `blob:${++created}`;
        liveUrls.add(url);
        peakUrls = Math.max(peakUrls, liveUrls.size);
        return url;
      },
      revoke: (url) => {
        liveUrls.delete(url);
        revoked.push(url);
      },
    },
  );
  const f = fixture({
    readResources: (ids, stripReplayId, signal, onUpdate?: (value: Readonly<Record<string, { artUrl?: string }>>) => void) => client.update({ artworkIds: ids, stripReplayId, onUpdate }, signal),
    invalidateResources: (options) => client.invalidate(options),
    disposeResources: () => client.dispose(),
  });
  const settle = async () => {
    for (let index = 0; index < 5; index++) await flush();
  };
  return { ...f, client, revoked, readIds, liveUrls, peakUrls: () => peakUrls, settle };
}
afterEach(() => jest.useRealTimers());
const scopedChange = (revision: number, from: string, to: string, replayIds: string[], ready = true): LibraryChangedEvent => ({
  revision, ready, resourceRevision: to, resourceChanges: { from, to, scope: "replays", replayIds },
});
it("scoped resource events preserve untouched inactive artwork across a ready refresh", async () => {
  jest.useFakeTimers();
  const f = resourceFixture();
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary();
    f.coordinator.visibleReplays(["a", "b"]); await f.settle();
    const first = f.coordinator.snapshot().resources;
    f.coordinator.visibleReplays(["c"]); await f.settle();
    f.changes$.next(scopedChange(2, "1:1", "1:2", ["a"]));
    jest.advanceTimersByTime(100); await f.settle();
    f.coordinator.visibleReplays(["b"]); await f.settle();
    expect(f.coordinator.snapshot().resources.b?.artUrl).toBe(first.b?.artUrl);
    expect(f.readIds.filter(id => id === "b")).toHaveLength(1);
    expect(f.revoked).not.toContain(first.b?.artUrl);
  } finally { f.coordinator.dispose(); await f.client.dispose(); }
});
it("scoped resource events fence an affected cold read immediately while an unrelated peer completes", async () => {
  jest.useFakeTimers();
  const finish = new Map<string, (byte: number) => void>();
  const f = resourceFixture(id => new Promise(resolve => finish.set(id, resolve)));
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary();
    f.coordinator.visibleReplays(["a", "b"]); await f.settle();
    f.changes$.next(scopedChange(2, "1:1", "1:2", ["a"], false));
    finish.get("a")?.(1); finish.get("b")?.(1); await f.settle();
    expect(f.coordinator.snapshot().resources.a?.artUrl).toBeUndefined();
    expect(f.coordinator.snapshot().resources.b?.artUrl).toBeDefined();
    expect(f.readIds).toEqual(["a", "b"]);
  } finally { finish.forEach(resolve => resolve(1)); f.coordinator.dispose(); await f.client.dispose(); }
});
it("accumulates hidden scoped changes without reads and preserves untouched cached aliases on reentry", async () => {
  jest.useFakeTimers();
  let byte = 1;
  const f = resourceFixture(async () => byte);
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a", "b", "c"]); await f.settle();
    const first = f.coordinator.snapshot().resources;
    f.coordinator.returnToViewer(); await f.settle(); byte = 2;
    f.changes$.next(scopedChange(2, "1:1", "1:2", ["a"], false));
    f.changes$.next(scopedChange(3, "1:2", "1:3", ["b"]));
    jest.advanceTimersByTime(1000); await f.settle();
    expect(f.readIds).toEqual(["a", "b", "c"]);
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["c"]); await f.settle();
    expect(f.coordinator.snapshot().resources.c?.artUrl).toBe(first.c?.artUrl);
    expect(f.readIds).toEqual(["a", "b", "c"]);
    f.coordinator.visibleReplays(["a", "b", "c"]); await f.settle();
    expect(f.coordinator.snapshot().resources.a?.artUrl).not.toBe(first.a?.artUrl);
    expect(f.coordinator.snapshot().resources.b?.artUrl).not.toBe(first.b?.artUrl);
    expect(f.coordinator.snapshot().resources.c?.artUrl).toBe(first.c?.artUrl);
    expect(f.readIds).toEqual(["a", "b", "c", "a", "b"]);
  } finally { f.coordinator.dispose(); await f.client.dispose(); }
});
it("accumulates scoped IDs while a read is held and does not lose a later invalidation of that read", async () => {
  jest.useFakeTimers();
  let held = false, byte = 1, finish: ((value: number) => void) | undefined;
  const f = resourceFixture(async id => held && id === "a" ? new Promise(resolve => { finish = resolve; }) : byte);
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a", "b", "c"]); await f.settle();
    const first = f.coordinator.snapshot().resources;
    held = true;
    f.changes$.next(scopedChange(2, "1:1", "1:2", ["a"]));
    jest.advanceTimersByTime(100); await f.settle();
    f.changes$.next(scopedChange(3, "1:2", "1:3", ["b"]));
    f.changes$.next(scopedChange(4, "1:3", "1:4", ["a"]));
    jest.advanceTimersByTime(100); await f.settle();
    held = false; byte = 2; finish?.(9); await f.settle();
    jest.advanceTimersByTime(100); await f.settle();
    expect(f.readIds).toEqual(["a", "b", "c", "a", "a", "b"]);
    expect(f.coordinator.snapshot().resources.c?.artUrl).toBe(first.c?.artUrl);
    expect(f.coordinator.snapshot().resources.a?.artUrl).not.toBe(first.a?.artUrl);
    expect(f.liveUrls.size).toBe(3);
    expect(f.request.mock.calls.some(([input]) => input.method === "analysis-request")).toBe(false);
  } finally { held = false; finish?.(1); f.coordinator.dispose(); await f.client.dispose(); }
});
it.each(["missing", "gap", "wrong-to", "all", "malformed", "overflow", "owner", "reset", "no-token"])(
  "hard-clears retained artwork immediately for %s freshness evidence and cannot revive it through a later scope", async kind => {
    jest.useFakeTimers();
    const f = resourceFixture();
    try {
      f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
      await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a", "b"]); await f.settle();
      const first = f.coordinator.snapshot().resources;
      const token = kind === "owner" ? "2:1" : kind === "reset" ? "1:0" : kind === "no-token" ? undefined : "1:2";
      let scope: unknown = { from: "1:1", to: token, scope: "replays", replayIds: ["a"] };
      if (kind === "missing") scope = undefined;
      else if (kind === "gap") scope = { from: "1:0", to: token, scope: "replays", replayIds: ["a"] };
      else if (kind === "wrong-to") scope = { from: "1:1", to: "1:99", scope: "replays", replayIds: ["a"] };
      else if (kind === "all") scope = { from: "1:1", to: token, scope: "all" };
      else if (kind === "malformed") scope = { from: "1:1", to: token, scope: "replays", replayIds: [42] };
      else if (kind === "overflow") scope = { from: "1:1", to: token, scope: "replays", replayIds: Array.from({ length: 257 }, (_, i) => String(i)) };
      f.changes$.next({ revision: 2, ready: false, resourceRevision: token, resourceChanges: scope } as LibraryChangedEvent);
      expect(f.coordinator.snapshot().resources).toEqual({});
      await f.settle();
      expect(f.revoked).toContain(first.b?.artUrl);
      f.changes$.next(scopedChange(3, token ?? "1:2", kind === "owner" ? "2:2" : "1:3", ["a"], false));
      await f.settle();
      expect(f.coordinator.snapshot().resources).toEqual({});
      expect(f.readIds).toEqual(["a", "b"]);
    } finally { f.coordinator.dispose(); await f.client.dispose(); }
  },
);
it("processes a changed resource token even on statusOnly and ignores a repeated unchanged token", async () => {
  jest.useFakeTimers();
  let byte = 1;
  const f = resourceFixture(async () => byte);
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a", "b"]); await f.settle();
    const first = f.coordinator.snapshot().resources;
    byte = 2;
    f.changes$.next({ ...scopedChange(2, "1:1", "1:2", ["a"]), statusOnly: true });
    jest.advanceTimersByTime(100); await f.settle();
    expect(f.coordinator.snapshot().resources.a?.artUrl).not.toBe(first.a?.artUrl);
    expect(f.coordinator.snapshot().resources.b?.artUrl).toBe(first.b?.artUrl);
    f.changes$.next({ revision: 3, ready: true, statusOnly: true, resourceRevision: "1:2" });
    jest.advanceTimersByTime(1000); await f.settle();
    expect(f.readIds).toEqual(["a", "b", "a"]);
  } finally { f.coordinator.dispose(); await f.client.dispose(); }
});
it("propagates live calculation activity passively and drops it when its status read fails", async () => {
  const f = fixture();
  try {
    const original = fixtureRequest(f);
    const activity = { unit: "work-items", queued: 7, awaitingInputs: 2, deferred: 1, failed: 0,
      running: 1, held: 0, retiring: 0, mode: "bg", userPaused: false, viewerHold: false,
      batteryHold: false, resumePending: false };
    f.request.mockImplementation(async input => input.method === "status"
      ? { ...await original(input) as object, analysis: activity } : original(input));
    await f.coordinator.enterLibrary();
    const page = f.coordinator.view.snapshot().page;
    expect(f.coordinator.snapshot().sources.status?.analysis).toEqual(activity);
    f.request.mockClear();
    f.request.mockRejectedValueOnce(new Error("Library unavailable"));
    f.changes$.next({ revision: 1, ready: true, statusOnly: true });
    await flush();
    expect(f.coordinator.snapshot().sources.status?.analysis).toBeUndefined();
    expect(f.coordinator.snapshot().sources.status?.replayCount).toBe(1);
    expect(f.coordinator.view.snapshot().page).toBe(page);
    expect(f.request.mock.calls.map(([input]) => input.method)).toEqual(["status"]);
    f.changes$.next({ revision: 2, ready: true, statusOnly: true });
    await flush();
    expect(f.coordinator.snapshot().sources.status?.analysis).toEqual(activity);
  } finally { f.coordinator.dispose(); }
});
it("manual feedback status: coalesces progress reads without querying pages, analysis or resources", async () => {
  jest.useFakeTimers();
  const readResources = jest.fn(async () => ({})), invalidateResources = jest.fn();
  const f = fixture({ readResources, invalidateResources });
  try {
    f.changes$.next({ revision: 0, ready: true, resourceRevision: "1:7" });
    await f.coordinator.enterLibrary();
    const oldPage = f.coordinator.view.snapshot().page;
    const oldUpdating = f.coordinator.snapshot().updating;
    const status = f.coordinator.snapshot().sources.status;
    let finish!: (value: unknown) => void;
    const original = fixtureRequest(f);
    f.request.mockClear();
    f.request.mockImplementation(input => input.method === "status" ? new Promise(resolve => { finish = resolve; }) : original(input));
    readResources.mockClear(); invalidateResources.mockClear();
    const progress = { revision: 1, ready: false, resourceRevision: "1:7", statusOnly: true as const };
    f.changes$.next(progress);
    await flush();
    for (let revision = 2; revision <= 8; revision++) f.changes$.next({ ...progress, revision });
    jest.advanceTimersByTime(100);
    await flush();
    expect(f.request.mock.calls.map(([input]) => input.method)).toEqual(["status"]);
    f.request.mockImplementation(original);
    finish({ ...status, replayCount: 7 });
    await flush();
    expect(f.request.mock.calls.map(([input]) => input.method)).toEqual(["status", "status"]);
    expect(f.coordinator.view.snapshot().page).toBe(oldPage);
    expect(f.coordinator.snapshot().updating).toBe(oldUpdating);
    expect(readResources).not.toHaveBeenCalled();
    expect(invalidateResources).not.toHaveBeenCalled();
  } finally { f.coordinator.dispose(); }
});
it("manual feedback status: a semantic refresh supersedes a held progress result", async () => {
  jest.useFakeTimers();
  const f = fixture();
  try {
    await f.coordinator.enterLibrary();
    const original = fixtureRequest(f);
    let finish!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.changes$.next({ revision: 1, ready: true, statusOnly: true });
    await flush();
    f.request.mockImplementation(input => input.method === "status"
      ? Promise.resolve({ ...f.coordinator.snapshot().sources.status, replayCount: 20 })
      : original(input));
    f.changes$.next({ revision: 2, ready: true, resourceRevision: "2:1" });
    jest.advanceTimersByTime(75);
    await flush();
    expect(f.coordinator.snapshot().sources.status?.replayCount).toBe(20);
    finish({ replayCount: 2 });
    await flush();
    expect(f.coordinator.snapshot().sources.status?.replayCount).toBe(20);
    expect(f.request.mock.calls.some(([input]) => input.method === "query-page")).toBe(true);
  } finally { f.coordinator.dispose(); }
});
it.each(["resolve", "reject"] as const)(
  "manual feedback review: a held progress %s preserves a failed explicit write until retry succeeds",
  async outcome => {
    jest.useFakeTimers();
    const f = fixture();
    try {
      await f.coordinator.enterLibrary();
      const original = fixtureRequest(f), status = f.coordinator.snapshot().sources.status;
      let finish!: (value: unknown) => void, fail!: (error: Error) => void;
      f.request.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
      f.changes$.next({ revision: 1, ready: true, statusOnly: true });
      await flush();
      f.request.mockRejectedValueOnce(new Error("settings write failed"));
      await f.coordinator.analysisSettings({ mode: "off", workers: 1, userPaused: false, pauseOnBattery: true });
      expect(f.coordinator.snapshot().sources.error).toBe("settings write failed");
      if (outcome === "resolve") finish(status);
      else fail(new Error("status read failed"));
      await flush();
      expect(f.coordinator.snapshot().sources.error).toBe("settings write failed");
      f.request.mockImplementation(original);
      f.changes$.next({ revision: 2, ready: true, resourceRevision: "1:1" });
      jest.advanceTimersByTime(75);
      await flush();
      expect(f.coordinator.snapshot().sources.error).toBe("settings write failed");
      await f.coordinator.analysisSettings({ mode: "off", workers: 1, userPaused: false, pauseOnBattery: true });
      expect(f.coordinator.snapshot().sources.error).toBeUndefined();
    } finally { f.coordinator.dispose(); }
  },
);
it("manual feedback review: a recovered status read clears its own error without an explicit action", async () => {
  const f = fixture();
  try {
    await f.coordinator.enterLibrary();
    f.request.mockRejectedValueOnce(new Error("status read failed"));
    f.changes$.next({ revision: 1, ready: true, statusOnly: true });
    await flush();
    expect(f.coordinator.snapshot().sources.error).toBe("status read failed");
    f.changes$.next({ revision: 2, ready: true, statusOnly: true });
    await flush();
    expect(f.coordinator.snapshot().sources.error).toBeUndefined();
  } finally { f.coordinator.dispose(); }
});
it("manual feedback review: status progress cannot claim a failed analysis-settings read recovered", async () => {
  const f = fixture(), original = fixtureRequest(f);
  try {
    f.request.mockImplementation(input => input.method === "analysis-settings"
      ? Promise.reject(new Error("analysis settings unavailable")) : original(input));
    await f.coordinator.enterLibrary();
    expect(f.coordinator.snapshot().sources.error).toBe("analysis settings unavailable");
    f.changes$.next({ revision: 1, ready: true, statusOnly: true });
    await flush();
    expect(f.coordinator.snapshot().sources.error).toBe("analysis settings unavailable");
    f.request.mockImplementation(original);
    await f.coordinator.sourceAction({ method: "retry" });
    expect(f.coordinator.snapshot().sources.error).toBeUndefined();
  } finally { f.coordinator.dispose(); }
});
it.each(["viewer", "dispose"] as const)(
  "manual feedback status: discards a held result after %s and starts no hidden reads",
  async boundary => {
    const f = fixture();
    await f.coordinator.enterLibrary();
    const status = f.coordinator.snapshot().sources.status;
    let finish!: (value: unknown) => void;
    f.request.mockClear();
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.changes$.next({ revision: 1, ready: true, statusOnly: true });
    if (boundary === "viewer") f.coordinator.view.showViewer();
    else f.coordinator.dispose();
    f.changes$.next({ revision: 2, ready: true, statusOnly: true });
    finish({ ...status, replayCount: 99 });
    await flush();
    expect(f.coordinator.snapshot().sources.status).toBe(status);
    expect(f.request.mock.calls.map(([input]) => input.method)).toEqual(["status"]);
    f.coordinator.dispose();
  },
);
it("manual feedback: same-resource busy pulses refresh results without rereading verified artwork", async () => {
  jest.useFakeTimers();
  const f = resourceFixture();
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:7" });
    await f.coordinator.enterLibrary();
    f.coordinator.visibleReplays(["a"]);
    await f.settle();
    jest.advanceTimersByTime(100);
    await f.settle();
    const artUrl = f.coordinator.snapshot().resources.a?.artUrl;
    expect(artUrl).toBeDefined();
    const reads = [...f.readIds];
    f.request.mockClear();
    f.changes$.next({ revision: 2, ready: false, resourceRevision: "1:7" });
    f.changes$.next({ revision: 3, ready: true, resourceRevision: "1:7" });
    jest.advanceTimersByTime(100);
    await f.settle();
    expect(f.request.mock.calls.some(([input]) => input.method === "query-page")).toBe(true);
    expect(f.readIds).toEqual(reads);
    expect(f.coordinator.snapshot().resources.a?.artUrl).toBe(artUrl);
    expect(f.revoked).not.toContain(artUrl);
  } finally {
    f.coordinator.dispose();
  }
});
it.each(["cold", "reentry"])("publishes %s artwork while unrelated scoped changes pulse readiness and page refresh is held", async mode => {
  jest.useFakeTimers();
  let held = false;
  const descriptors: ((byte: number) => void)[] = [], pages: ((value: unknown) => void)[] = [];
  const f = resourceFixture(async () => held ? new Promise(resolve => descriptors.push(resolve)) : 1);
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:7" });
    await f.coordinator.enterLibrary();
    if (mode === "reentry") {
      f.coordinator.visibleReplays(["a"]); await f.settle();
      expect(f.coordinator.snapshot().resources.a?.artUrl).toBeDefined();
      f.coordinator.returnToViewer(); await f.settle();
      expect(f.coordinator.snapshot().resources).toEqual({});
      expect(f.liveUrls.size).toBe(1);
    }
    const original = fixtureRequest(f);
    f.request.mockImplementation(async input => input.method === "query-page" && input.query?.limit === 64
      ? new Promise(resolve => pages.push(resolve)) : original(input));
    held = true;
    f.changes$.next(scopedChange(2, "1:7", "1:8", ["unrelated"], false));
    if (mode === "reentry") void f.coordinator.enterLibrary();
    f.coordinator.visibleReplays(["a"]); await f.settle();
    for (let revision = 3; revision <= 14; revision++) {
      f.changes$.next(scopedChange(revision, `1:${revision + 5}`, `1:${revision + 6}`, ["unrelated"], revision % 2 === 1));
      jest.advanceTimersByTime(25); await f.settle();
    }
    // A valid resource lease is independent of a still-pending query projection.
    // The admitted descriptor must not restart once per false/true pulse.
    expect(descriptors).toHaveLength(mode === "cold" ? 1 : 0);
    expect(pages.length).toBeGreaterThan(0);
    held = false; descriptors[0]?.(2); await f.settle();
    expect(f.coordinator.snapshot().updating).toBe(true);
    expect(f.coordinator.snapshot().resources.a?.artUrl).toBeDefined();
    expect(f.liveUrls.has(f.coordinator.snapshot().resources.a?.artUrl ?? "")).toBe(true);
    expect(f.readIds).toEqual(["a"]);
    expect(f.request.mock.calls.some(([request]) => ["scan-source", "rebuild", "import-replays", "analysis-request"].includes(request.method))).toBe(false);
  } finally {
    held = false; descriptors.forEach(resolve => resolve(2)); pages.forEach(resolve => resolve(page()));
    f.coordinator.dispose(); await f.client.dispose();
  }
  expect(f.liveUrls.size).toBe(0);
});
it("publishes completed artwork before a slow peer and fences progressive delivery after route exit", async () => {
  let finish!: (byte: number) => void;
  const f = resourceFixture(async id => id === "slow" ? new Promise(resolve => { finish = resolve; }) : 1);
  try {
    await f.coordinator.enterLibrary();
    f.coordinator.visibleReplays(["fast", "slow"]); await f.settle();
    const partial = f.coordinator.snapshot().resources;
    expect(partial.fast?.artUrl).toBeDefined();
    expect(partial.slow).toBeUndefined();
    expect(Object.isFrozen(partial)).toBe(true);
    f.coordinator.returnToViewer(); await f.settle();
    finish(2); await f.settle();
    expect(f.coordinator.snapshot().resources).toEqual({});
  } finally { finish?.(2); f.coordinator.dispose(); await f.client.dispose(); }
});
it("keeps overlapping artwork published through viewport reorder and a delayed new card", async () => {
  let finish!: (byte: number) => void;
  const f = resourceFixture(async id => id === "c" ? new Promise(resolve => { finish = resolve; }) : 1);
  try {
    await f.coordinator.enterLibrary();
    f.coordinator.visibleReplays(["a", "b"]); await f.settle();
    const first = f.coordinator.snapshot().resources;
    f.coordinator.visibleReplays(["b", "a"]);
    expect(f.coordinator.snapshot().resources.a?.artUrl).toBe(first.a?.artUrl);
    expect(f.coordinator.snapshot().resources.b?.artUrl).toBe(first.b?.artUrl);
    await f.settle();
    f.coordinator.visibleReplays(["b", "c"]); await f.settle();
    expect(f.coordinator.snapshot().resources).toEqual({ b: first.b });
    expect(f.liveUrls.has(first.b?.artUrl ?? "")).toBe(true);
    expect(f.revoked).toEqual([]);
    finish(2); await f.settle();
    expect(f.coordinator.snapshot().resources.b?.artUrl).toBe(first.b?.artUrl);
    expect(f.coordinator.snapshot().resources.c?.artUrl).toBeDefined();
    expect(f.readIds).toEqual(["a", "b", "c"]);
  } finally { finish?.(2); f.coordinator.dispose(); await f.client.dispose(); }
});
it("revalidates scoped artwork without blanking the displayed image or replacing identical verified bytes", async () => {
  jest.useFakeTimers();
  let finish: ((byte: number) => void) | undefined, held = false, byte = 1;
  const f = resourceFixture(async () => held ? new Promise(resolve => { finish = resolve; }) : byte);
  let releaseRender: () => void = () => undefined;
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a"]); await f.settle();
    const first = f.coordinator.snapshot().resources;
    releaseRender = f.coordinator.retainRenderedResources(first);
    const absent: boolean[] = [];
    const subscription = f.coordinator.state$.subscribe(snapshot => absent.push(!snapshot.resources.a?.artUrl));
    held = true;
    f.changes$.next(scopedChange(2, "1:1", "1:2", ["a"]));
    jest.advanceTimersByTime(100); await f.settle();
    expect(finish).toBeDefined();
    expect(f.coordinator.snapshot().resources.a?.artUrl).toBe(first.a?.artUrl);
    f.changes$.next(scopedChange(3, "1:2", "1:3", ["a"]));
    jest.advanceTimersByTime(100); await f.settle();
    expect(f.readIds).toEqual(["a", "a"]);
    held = false; finish?.(1); await f.settle();
    jest.advanceTimersByTime(100); await f.settle();
    expect(f.coordinator.snapshot().resources.a?.artUrl).toBe(first.a?.artUrl);
    expect(absent).not.toContain(true);
    expect(f.revoked).toEqual([]);
    expect(f.readIds).toEqual(["a", "a", "a"]);
    byte = 2;
    f.changes$.next(scopedChange(4, "1:3", "1:4", ["a"]));
    jest.advanceTimersByTime(100); await f.settle();
    expect(f.coordinator.snapshot().resources.a?.artUrl).not.toBe(first.a?.artUrl);
    expect(f.liveUrls.has(first.a?.artUrl ?? "")).toBe(true);
    subscription.unsubscribe(); releaseRender();
    expect(f.revoked).toEqual([first.a?.artUrl]);
  } finally { held = false; finish?.(1); releaseRender(); f.coordinator.dispose(); await f.client.dispose(); }
});
it.each(["unavailable", "error"])("replaces last-verified artwork with a current %s result", async result => {
  jest.useFakeTimers();
  let fail = false;
  const f = resourceFixture(async () => { if (!fail) return 1; if (result === "error") throw Error("Read rejected"); return undefined; });
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a"]); await f.settle();
    const previous = f.coordinator.snapshot().resources.a?.artUrl;
    fail = true; f.changes$.next({ revision: 2, ready: true, resourceRevision: "1:2" });
    jest.advanceTimersByTime(100); await f.settle();
    expect(f.coordinator.snapshot().resources.a?.artUrl).toBeUndefined();
    expect(f.coordinator.snapshot().resources.a).toEqual(result === "error" ? { artworkError: "Artwork could not be verified" } : {});
    expect(f.revoked).toEqual([previous]);
  } finally { f.coordinator.dispose(); await f.client.dispose(); }
});
it("finishes same-owner artwork revalidation when revisions advance during the preceding page read", async () => {
  jest.useFakeTimers();
  const f = resourceFixture();
  let finishPage: ((value: unknown) => void) | undefined;
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a"]); await f.settle();
    const first = f.coordinator.snapshot().resources.a?.artUrl;
    const original = fixtureRequest(f);
    f.request.mockImplementation(async input => input.method === "query-page" && input.query?.limit === 64
      ? new Promise(resolve => { finishPage = resolve; }) : original(input));
    f.changes$.next(scopedChange(2, "1:1", "1:2", ["a"]));
    jest.advanceTimersByTime(100); await f.settle();
    expect(finishPage).toBeDefined();
    f.changes$.next(scopedChange(3, "1:2", "1:3", ["a"]));
    finishPage?.(page()); await f.settle();
    // The admitted pass must finish before another75ms coalesced refresh.
    expect(f.readIds).toEqual(["a", "a"]);
    expect(f.coordinator.snapshot().resources.a?.artUrl).toBe(first);
  } finally { f.coordinator.dispose(); finishPage?.(page()); await f.client.dispose(); }
});
it("bounds changed-byte revalidation to cache, published replacement and one retained committed window", async () => {
  jest.useFakeTimers();
  let byte = 1;
  const f = resourceFixture(async () => byte), ids = Array.from({ length: 32 }, (_, index) => String(index));
  let release: () => void = () => undefined;
  const settle = async () => { for (let i = 0; i < 8; i++) await f.settle(); };
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(ids); await settle();
    release = f.coordinator.retainRenderedResources(f.coordinator.snapshot().resources);
    for (byte = 2; byte <= 6; byte++) {
      f.changes$.next({ revision: byte, ready: true, resourceRevision: `1:${byte}` });
      jest.advanceTimersByTime(100); await settle();
      expect(f.liveUrls.size).toBe(64);
    }
    expect(f.peakUrls()).toBeLessThanOrEqual(96);
    f.coordinator.dispose(); await f.client.dispose(); expect(f.liveUrls.size).toBe(32);
    release(); expect(f.liveUrls.size).toBe(0);
    expect(new Set(f.revoked).size).toBe(192);
  } finally { release(); f.coordinator.dispose(); await f.client.dispose(); }
});
it.each(["unknown", "not-ready", "owner", "not-ready-owner"])("clears artwork immediately at the %s boundary and fences a late revalidation", async boundary => {
  jest.useFakeTimers();
  let finish: ((byte: number) => void) | undefined, held = false;
  const f = resourceFixture(async () => held ? new Promise(resolve => { finish = resolve; }) : 1);
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a"]); await f.settle();
    held = true; f.changes$.next({ revision: 2, ready: true, resourceRevision: "1:2" });
    jest.advanceTimersByTime(100); await f.settle();
    f.changes$.next({ revision: 3, ready: !boundary.startsWith("not-ready"), resourceRevision: boundary.endsWith("owner") ? "2:1" : undefined });
    expect(f.coordinator.snapshot().resources).toEqual({});
    finish?.(1); await f.settle();
    expect(f.coordinator.snapshot().resources).toEqual({});
  } finally { held = false; finish?.(1); f.coordinator.dispose(); await f.client.dispose(); }
});
it("loads newly visible artwork during same-owner query maintenance while retaining overlapping presentation", async () => {
  jest.useFakeTimers();
  const f = resourceFixture();
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a", "b"]); await f.settle();
    const first = f.coordinator.snapshot().resources;
    f.changes$.next(scopedChange(2, "1:1", "1:2", ["a"], false));
    jest.advanceTimersByTime(100); await f.settle();
    expect(f.coordinator.snapshot().updating).toBe(true);
    expect(f.coordinator.snapshot().resources).toEqual(first);
    expect(f.readIds).toEqual(["a", "b"]);
    f.coordinator.visibleReplays(["b", "c"]); await f.settle();
    expect(f.coordinator.snapshot().resources.b).toEqual(first.b);
    expect(f.coordinator.snapshot().resources.c?.artUrl).toBeDefined();
    expect(f.readIds).toEqual(["a", "b", "c"]);
    f.changes$.next({ revision: 3, ready: true, resourceRevision: "1:2" });
    jest.advanceTimersByTime(100); await f.settle();
    expect(f.coordinator.snapshot().resources.b?.artUrl).toBe(first.b?.artUrl);
    expect(f.coordinator.snapshot().resources.c?.artUrl).toBeDefined();
    f.changes$.next(scopedChange(4, "1:2", "1:3", ["b"], false));
    f.coordinator.returnToViewer(); await f.settle();
    expect(f.coordinator.snapshot().resources).toEqual({});
  } finally { f.coordinator.dispose(); await f.client.dispose(); }
  expect(f.liveUrls.size).toBe(0);
});
it("finishes admitted verified artwork across unrelated scoped maintenance then revalidates affected IDs when ready", async () => {
  jest.useFakeTimers();
  let held = false, byte = 1;
  const finish: ((byte: number) => void)[] = [];
  const f = resourceFixture(async () => held ? new Promise(resolve => finish.push(resolve)) : byte);
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:7" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a", "b", "c"]); await f.settle();
    const first = f.coordinator.snapshot().resources;
    held = true; f.changes$.next(scopedChange(2, "1:7", "1:8", ["a", "b", "c"]));
    jest.advanceTimersByTime(100); await f.settle();
    expect(finish).toHaveLength(2);
    f.changes$.next(scopedChange(3, "1:8", "1:9", ["unrelated"], false));
    expect(f.coordinator.snapshot().resources).toEqual(first);
    held = false; byte = 2; finish.forEach(resolve => resolve(2)); await f.settle();
    const verified = f.coordinator.snapshot().resources;
    expect(verified.a?.artUrl).toBeDefined();
    expect(verified.a?.artUrl).not.toBe(first.a?.artUrl);
    expect(f.readIds).toEqual(["a", "b", "c", "a", "b", "c"]);
    expect(f.revoked).toEqual([first.a?.artUrl, first.b?.artUrl, first.c?.artUrl]);
    f.changes$.next(scopedChange(4, "1:9", "1:10", ["a", "b", "c"]));
    jest.advanceTimersByTime(100); await f.settle();
    expect(f.coordinator.snapshot().resources).toEqual(verified);
    expect(f.readIds).toEqual(["a", "b", "c", "a", "b", "c", "a", "b", "c"]);
  } finally { held = false; finish.forEach(resolve => resolve(1)); f.coordinator.dispose(); await f.client.dispose(); }
  expect(f.liveUrls.size).toBe(0);
});
it.each(["undefined", "new-owner"])("does not read old visible IDs through a %s not-ready boundary", async boundary => {
  jest.useFakeTimers();
  const f = resourceFixture();
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a"]); await f.settle();
    expect(f.coordinator.snapshot().resources.a?.artUrl).toBeDefined();
    f.changes$.next({ revision: 2, ready: false, resourceRevision: boundary === "new-owner" ? "2:1" : undefined });
    f.coordinator.visibleReplays(["a", "b"]);
    for (let revision = 3; revision <= 8; revision++) {
      f.changes$.next({ revision, ready: false, resourceRevision: boundary === "new-owner" ? `2:${revision}` : undefined });
      jest.advanceTimersByTime(100); await f.settle();
    }
    expect(f.coordinator.snapshot().resources).toEqual({});
    expect(f.readIds).toEqual(["a"]);
    expect(f.liveUrls.size).toBe(0);
  } finally { f.coordinator.dispose(); await f.client.dispose(); }
});
it("carries deferred resource invalidation into a replacement viewport and fences its removed row", async () => {
  jest.useFakeTimers();
  let byte = 1, finish: ((value: number) => void) | undefined;
  const f = resourceFixture(async id => id === "b" ? new Promise(resolve => { finish = resolve; }) : byte);
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "1:1" });
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a"]); await f.settle();
    const previous = f.coordinator.snapshot().resources.a?.artUrl;
    f.coordinator.visibleReplays(["a", "b"]); await f.settle();
    expect(finish).toBeDefined();
    byte = 2;
    f.changes$.next(scopedChange(2, "1:1", "1:2", ["a"]));
    jest.advanceTimersByTime(100); await f.settle();
    f.coordinator.visibleReplays(["a"]); await f.settle();
    expect(f.readIds).toEqual(["a", "b", "a"]);
    expect(f.coordinator.snapshot().resources.a?.artUrl).not.toBe(previous);
    finish?.(2); await f.settle();
    expect(Object.keys(f.coordinator.snapshot().resources)).toEqual(["a"]);
    expect(f.liveUrls.size).toBe(1);
  } finally { finish?.(2); f.coordinator.dispose(); await f.client.dispose(); }
});
it("keeps typed map absence on the selected action, expires it on resource recovery, and preserves query/viewer state", async () => {
  jest.useFakeTimers();
  const f = fixture();
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "maps:1" });
    await f.coordinator.enterLibrary(); await f.coordinator.select("a");
    f.coordinator.setNowPlayingMetadata({ id: "old", title: "Retained viewer", position: "0:48" });
    const previous = f.coordinator.view.snapshot().page;
    f.openReplay.mockRejectedValueOnce(new LibraryExactMapUnavailableError("a", "a".repeat(32)));
    await f.coordinator.open("a", { fullMap: true });
    expect(f.coordinator.snapshot()).toMatchObject({
      openError: { replayId: "a", reason: "exact-map-unavailable" },
      nowPlaying: { id: "old", title: "Retained viewer" },
    });
    expect(f.coordinator.snapshot().error).toBeUndefined();
    expect(f.coordinator.view.snapshot()).toMatchObject({ route: "library", page: previous, error: null });
    expect(f.coordinator.fullMapRequest$.value).toBe(0);
    expect(f.navigate).not.toHaveBeenCalledWith("/app/analyzer");
    f.changes$.next({ revision: 2, ready: true, resourceRevision: "maps:1" });
    expect(f.coordinator.snapshot()).toMatchObject({ openError: { reason: "exact-map-unavailable" } });
    f.changes$.next({ revision: 3, ready: true, resourceRevision: "maps:2" });
    expect(f.coordinator.snapshot()).not.toHaveProperty("openError", expect.anything());
    await f.coordinator.open("a", { fullMap: true });
    expect(f.coordinator.fullMapRequest$.value).toBe(1);
    expect(f.navigate).toHaveBeenLastCalledWith("/app/analyzer");
  } finally { f.coordinator.dispose(); }
});
it.each(["changed", "undefined", "not-ready", "selection"])("does not retain negative evidence across %s during an open", async change => {
  jest.useFakeTimers();
  let reject!: (error: Error) => void;
  const f = fixture({ openReplay: () => new Promise((_resolve, fail) => { reject = fail; }) });
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "maps:1" });
    await f.coordinator.enterLibrary(); await f.coordinator.select("a");
    const opening = f.coordinator.open("a"); await flush();
    if (change === "selection") await f.coordinator.select("b");
    else f.changes$.next({ revision: 2, ready: change !== "not-ready", resourceRevision: change === "changed" ? "maps:2" : change === "undefined" ? undefined : "maps:1" });
    reject(new LibraryExactMapUnavailableError("a", "a".repeat(32))); await opening;
    const state = f.coordinator.snapshot() as typeof f.coordinator.state$.value & { openError?: { reason?: string } };
    expect(state.openError?.reason).toBeUndefined();
    expect(state.error).toBeUndefined();
    expect(f.coordinator.view.snapshot().error).toBeNull();
  } finally { f.coordinator.dispose(); }
});
it("does not turn an untyped opening failure into a query failure or a proven missing map", async () => {
  const f = fixture();
  try {
    await f.coordinator.enterLibrary(); await f.coordinator.select("a");
    f.openReplay.mockRejectedValueOnce(new Error("exact map unavailable is only text"));
    await f.coordinator.open("a");
    expect(f.coordinator.snapshot()).toMatchObject({ openError: { replayId: "a", message: "exact map unavailable is only text" } });
    expect(f.coordinator.snapshot().error).toBeUndefined();
    expect(f.coordinator.view.snapshot().error).toBeNull();
  } finally { f.coordinator.dispose(); }
});
it.each([0, 350])(
  "refreshes the actual display transport at scroll %i while keeping selected detail",
  async (scrollTop) => {
    jest.useFakeTimers();
    const f = fixture(),
      original = fixtureRequest(f);
    try {
      await f.coordinator.enterLibrary();
      await f.coordinator.select("a");
      f.coordinator.view.saveScroll(scrollTop);
      const query = f.coordinator.view.snapshot().query;
      f.request.mockImplementation(async (input) => {
        if (input.method === "query-page")
          return {
            items: input.query?.limit === 1 ? [item("new-higher-pp")] : [item("new-higher-pp"), item("a")],
            total: 2,
            analysisExcluded: 0,
          };
        if (input.method === "query-reveal") return { state: "found", position: 1, page: { ...page("a"), total: 2 } };
        return original(input);
      });
      f.request.mockClear();
      f.changes$.next({ revision: 1, ready: true, resourceRevision: "changed" });
      jest.advanceTimersByTime(100);
      await flush();
      const displayRequests = f.request.mock.calls
        .map(([input]) => input)
        .filter(
          (input) => input.method === "query-reveal" || (input.method === "query-page" && input.query?.limit === 64),
        );
      expect(displayRequests).toEqual(
        scrollTop === 0 ? [{ method: "query-page", query }] : [{ method: "query-reveal", query, replayId: "a" }],
      );
      expect(f.coordinator.view.snapshot()).toMatchObject({
        scrollTop,
        pageStart: scrollTop === 0 ? 0 : 1,
        selectedId: "a",
        selected: { item: { id: "a" } },
        page: { total: 2, items: scrollTop === 0 ? [item("new-higher-pp"), item("a")] : [item("a")] },
        loading: false,
        error: null,
      });
    } finally {
      f.coordinator.dispose();
    }
  },
);
it("refreshes aggregate counts when a committed page advances to a newer revision", async () => {
  const f = fixture(),
    original = fixtureRequest(f);
  let revision = "r1";
  f.request.mockImplementation(async (input) => {
    const value = await original(input);
    return value && typeof value === "object" && "items" in value ? { ...value, revision } : value;
  });
  await f.coordinator.enterLibrary();
  expect(f.coordinator.snapshot().countsRevision).toBe("r1");
  revision = "r2";
  await f.coordinator.commitQuery({ search: "new" });
  expect(f.coordinator.snapshot().countsRevision).toBe("r2");
  expect(f.coordinator.snapshot().bands.revision).toBe("r2");
  expect(f.coordinator.snapshot().updating).toBe(false);
  f.coordinator.dispose();
});
it("discards different-revision bands and counts with only one coalesced retry per change", async () => {
  jest.useFakeTimers();
  const f = fixture(),
    original = fixtureRequest(f);
  f.request.mockImplementation(async (input) => {
    const value = await original(input);
    return value && typeof value === "object" && "items" in value
      ? { ...value, revision: input.method === "query-bands" || input.method === "query-facets" ? "r2" : "r1" }
      : value;
  });
  await f.coordinator.enterLibrary();
  expect(f.coordinator.view.snapshot().page?.revision).toBe("r1");
  expect(f.coordinator.snapshot().bands.items).toEqual([]);
  expect(f.coordinator.snapshot().scopeCounts).toEqual({});
  jest.advanceTimersByTime(100);
  await flush();
  const calls = f.request.mock.calls.length;
  for (let i = 0; i < 5; i++) {
    jest.advanceTimersByTime(100);
    await flush();
  }
  expect(f.request.mock.calls.length).toBe(calls);
  expect(f.coordinator.snapshot().bands.items).toEqual([]);
  f.coordinator.dispose();
});
it("reads only explicit My names and refreshes an applied Me after saving without navigation or analysis", async () => {
  const f = fixture();
  const original = fixtureRequest(f);
  let names = ["old"];
  f.request.mockImplementation(async (input) =>
    input.method === "query-player-names"
      ? { names }
      : input.method === "player-names-set"
      ? { names: (names = input.names) }
      : original(input),
  );
  await f.coordinator.enterLibrary();
  expect(f.coordinator.snapshot().myNames).toEqual({ names: ["old"], loading: false });
  await f.coordinator.commitQuery({ filters: [{ field: "player", values: [], me: true }] });
  f.request.mockClear();
  f.navigate.mockClear();
  expect(await f.coordinator.saveMyNames(["new"])).toEqual(["new"]);
  expect(f.coordinator.snapshot().myNames).toEqual({ names: ["new"], loading: false });
  expect(f.request.mock.calls.some(([input]) => input.method === "query-page" || input.method === "query-reveal")).toBe(
    true,
  );
  expect(f.request.mock.calls.some(([input]) => input.method === "analysis-request")).toBe(false);
  expect(f.navigate).not.toHaveBeenCalled();
  f.coordinator.dispose();
});
it("returns the real import summary instead of discarding it", async () => {
  const f = fixture(),
    original = fixtureRequest(f),
    summary = {
      added: 3,
      alreadyImported: 2,
      failed: 1,
      failures: [{ path: "C:/owned/bad.osr", error: "read failed" }],
      truncatedFailures: false,
    };
  f.request.mockImplementation(async (input) => (input.method === "import-replays" ? summary : original(input)));
  expect(await f.coordinator.sourceAction({ method: "import-replays" })).toEqual(summary);
  f.coordinator.dispose();
});
it("propagates import rejection to the dedicated caller instead of storing a generic source error", async () => {
  const f = fixture(),
    original = fixtureRequest(f);
  f.request.mockImplementation(async (input) => {
    if (input.method === "import-replays") throw new Error("Library import recovery is pending");
    return original(input);
  });
  try {
    await expect(f.coordinator.sourceAction({ method: "import-replays" })).rejects.toThrow(
      "Library import recovery is pending",
    );
    expect(f.coordinator.snapshot().sources.error).toBeUndefined();
    expect(f.request.mock.calls.filter(([input]) => input.method === "import-replays")).toHaveLength(1);
  } finally {
    f.coordinator.dispose();
  }
});
it("bounds distinct-content viewport publications beyond the inactive cap plus one committed window without exposing revoked URLs", async () => {
  const f = resourceFixture();
  const publishedRevoked: string[] = [];
  const subscription = f.coordinator.state$.subscribe((snapshot) => {
    for (const resource of Object.values(snapshot.resources))
      if (resource?.artUrl && !f.liveUrls.has(resource.artUrl)) publishedRevoked.push(resource.artUrl);
  });
  const settleWindow = async () => {
    for (let index = 0; index < 10; index++) await f.settle();
  };
  let releaseRender: () => void = () => undefined;
  try {
    await f.coordinator.enterLibrary();
    f.coordinator.visibleReplays(Array.from({ length: 32 }, (_, index) => `first-${index}`));
    await settleWindow();
    const first = f.coordinator.snapshot().resources;
    expect(Object.keys(first)).toHaveLength(32);
    releaseRender = f.coordinator.retainRenderedResources(first);
    for (let generation = 0; generation < 10; generation++) {
      f.coordinator.visibleReplays(Array.from({ length: 32 }, (_, index) => `${generation}-${index}`));
      await settleWindow();
      expect(Object.keys(f.coordinator.snapshot().resources)).toHaveLength(32);
      // 32 active, 256 inactive, plus the held render once its aliases are evicted.
      expect(f.liveUrls.size).toBe(Math.min((generation + 2) * 32, 320));
      for (const resource of Object.values(first)) expect(f.liveUrls.has(resource?.artUrl ?? "")).toBe(true);
    }
    expect(f.peakUrls()).toBe(320);
    expect(publishedRevoked).toEqual([]);
    f.coordinator.dispose();
    await f.client.dispose();
    expect(f.liveUrls.size).toBe(32);
    releaseRender();
    releaseRender();
    expect(f.liveUrls.size).toBe(0);
    expect(f.revoked).toHaveLength(352);
    expect(new Set(f.revoked).size).toBe(352);
  } finally {
    subscription.unsubscribe();
    releaseRender();
    f.coordinator.dispose();
    await f.client.dispose();
  }
});
it("keeps one shared content URL alive through partial publication, alias removal and committed render cleanup", async () => {
  let finish!: (byte: number) => void;
  const f = resourceFixture(async id => id === "b" ? new Promise(resolve => { finish = resolve; }) : 1, () => "same");
  let releaseFirst: () => void = () => undefined, releaseSecond: () => void = () => undefined;
  try {
    await f.coordinator.enterLibrary(); f.coordinator.visibleReplays(["a", "b"]); await f.settle();
    const first = f.coordinator.snapshot().resources;
    expect(first.a?.artUrl).toBeDefined(); expect(first.b).toBeUndefined();
    releaseFirst = f.coordinator.retainRenderedResources(first);
    finish(1); await f.settle();
    const second = f.coordinator.snapshot().resources;
    expect(second.b?.artUrl).toBe(first.a?.artUrl); expect(f.liveUrls.size).toBe(1);
    releaseSecond = f.coordinator.retainRenderedResources(second);
    f.coordinator.visibleReplays(["b"]); await f.settle();
    releaseFirst(); expect(f.revoked).toEqual([]);
    f.coordinator.returnToViewer(); await f.settle();
    expect(f.coordinator.snapshot().resources).toEqual({});
    f.coordinator.dispose(); await f.client.dispose(); expect(f.revoked).toEqual([]);
    releaseSecond(); expect(f.revoked).toEqual([first.a?.artUrl]);
  } finally { finish?.(1); releaseFirst(); releaseSecond(); f.coordinator.dispose(); await f.client.dispose(); }
});
it("holds the committed URL through semantic invalidation and deferred query, then releases exactly that render", async () => {
  jest.useFakeTimers();
  const f = resourceFixture();
  await f.coordinator.enterLibrary();
  // Exercise the retained, genuinely scrolled anchor path (head refresh uses page).
  f.coordinator.view.saveScroll(350);
  f.coordinator.visibleReplays(["a"]);
  await f.settle();
  const first = f.coordinator.snapshot().resources;
  const releaseRender = f.coordinator.retainRenderedResources(first);
  let resolvePage!: (value: unknown) => void;
  const original = f.request.getMockImplementation();
  f.request.mockImplementation(async (input) =>
    input.method === "query-reveal"
      ? new Promise((resolve) => {
          resolvePage = resolve;
        })
      : original?.(input),
  );
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "changed" });
    jest.advanceTimersByTime(100);
    await flush();
    expect(typeof resolvePage).toBe("function");
    expect(f.coordinator.view.snapshot()).toMatchObject({ loading: true, scrollTop: 350 });
    // Freshly reverified artwork may publish before the held query projection.
    // The old semantic generation remains held only by its committed render.
    expect(f.coordinator.snapshot().resources.a?.artUrl).toBe("blob:2");
    expect(f.readIds).toEqual(["a", "a"]);
    expect(f.revoked).toEqual([]);
    const staleRelease = f.coordinator.retainRenderedResources(first);
    resolvePage({ state: "found", position: 0, page: page() });
    await f.settle();
    const second = f.coordinator.snapshot().resources;
    expect(second.a?.artUrl).toBe("blob:2");
    const releaseSecond = f.coordinator.retainRenderedResources(second);
    // Cleanup/setup of the current snapshot (StrictMode) cannot retire its publication.
    releaseSecond();
    const releaseSecondAgain = f.coordinator.retainRenderedResources(second);
    expect(f.revoked).toEqual([]);
    releaseRender();
    releaseRender();
    staleRelease();
    expect(f.revoked).toEqual(["blob:1"]);
    f.coordinator.dispose();
    await f.client.dispose();
    expect(f.revoked).toEqual(["blob:1"]);
    releaseSecondAgain();
    releaseSecondAgain();
    expect(f.revoked).toEqual(["blob:1", "blob:2"]);
  } finally {
    releaseRender();
    f.coordinator.dispose();
    resolvePage?.({ state: "found", position: 0, page: page() });
    await f.client.dispose();
  }
});
it("reuses a retained inactive URL and fences out-of-order render cleanup after cache disposal", async () => {
  const f = resourceFixture();
  await f.coordinator.enterLibrary();
  f.coordinator.visibleReplays(["a"]);
  await f.settle();
  const first = f.coordinator.snapshot().resources,
    releaseFirst = f.coordinator.retainRenderedResources(first);
  f.coordinator.visibleReplays([]);
  await f.settle();
  expect(f.revoked).toEqual([]);
  f.coordinator.visibleReplays(["a"]);
  await f.settle();
  const second = f.coordinator.snapshot().resources,
    releaseSecond = f.coordinator.retainRenderedResources(second);
  expect(second.a?.artUrl).toBe("blob:1");
  expect(f.readIds).toEqual(["a"]);
  f.coordinator.returnToViewer();
  await f.settle();
  expect(f.coordinator.snapshot().resources).toEqual({});
  expect(f.revoked).toEqual([]);
  f.coordinator.dispose();
  await f.client.dispose();
  releaseSecond();
  expect(f.revoked).toEqual([]);
  releaseFirst();
  releaseSecond();
  expect(f.revoked).toEqual(["blob:1"]);
});
it("retires semantically invalid artwork before a deferred query can keep publishing its revoked URL", async () => {
  jest.useFakeTimers();
  const revoked: string[] = [];
  const client = new LibraryPassiveResourceClient(
    {
      resource: async (input) =>
        input.method === "artwork"
          ? { state: "ready", bytes: 1, mime: "image/png" }
          : input.method === "chunk"
          ? { bytes: new Uint8Array([1]), done: true }
          : undefined,
    },
    {
      create: () => "blob:first",
      revoke: (url) => {
        revoked.push(url);
      },
    },
  );
  const f = fixture({
    readResources: (ids, stripReplayId, signal) => client.update({ artworkIds: ids, stripReplayId }, signal),
    invalidateResources: (options) => client.invalidate(options),
    disposeResources: () => client.dispose(),
  });
  await f.coordinator.enterLibrary();
  f.coordinator.visibleReplays(["a"]);
  for (let index = 0; index < 5; index++) await flush();
  expect(f.coordinator.snapshot().resources.a?.artUrl).toBe("blob:first");
  let resolvePage!: (value: unknown) => void;
  const original = f.request.getMockImplementation();
  f.request.mockImplementation(async (input) =>
    // Defer the head result page, not the separate limit1 aggregate count reads.
    input.method === "query-page" && input.query?.limit === 64
      ? new Promise((resolve) => {
          resolvePage = resolve;
        })
      : original?.(input),
  );
  try {
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "changed" });
    jest.advanceTimersByTime(100);
    await flush();
    expect(resolvePage).toBeDefined();
    expect(f.coordinator.view.snapshot()).toMatchObject({ loading: true, pageStart: 0, scrollTop: 0 });
    expect(f.coordinator.snapshot().resources).toEqual({});
    expect(revoked).toEqual(["blob:first"]);
  } finally {
    f.coordinator.dispose();
    resolvePage?.(page());
    await client.dispose();
  }
});
it("does no library read at construction, enters with real persisted settings, and keeps preview/query changes passive", async () => {
  const f = fixture();
  expect(f.request).not.toHaveBeenCalled();
  await f.coordinator.enterLibrary();
  expect(f.navigate).toHaveBeenCalledWith("/app/library");
  expect(f.coordinator.snapshot().sources.analysis).toEqual(settings);
  await f.coordinator.commitQuery({ search: "song" });
  expect(f.request.mock.calls.some(([r]) => r.method === "analysis-request")).toBe(false);
  expect(f.coordinator.view.snapshot().selectedId).toBeNull();
  f.coordinator.dispose();
});
it("admits only explicit selection/open separately and preserves selected detail through a review edit", async () => {
  const f = fixture();
  await f.coordinator.enterLibrary();
  await f.coordinator.select("a");
  expect(f.request).toHaveBeenCalledWith({ method: "analysis-request", replayId: "a", reason: "selection" });
  await f.coordinator.mutate({ method: "replay-review", replayId: "a", review: "reviewed" });
  expect(f.coordinator.view.snapshot().selectedId).toBe("a");
  await f.coordinator.open("a");
  expect(f.openReplay).toHaveBeenCalledWith("a", {});
  expect(f.navigate).toHaveBeenLastCalledWith("/app/analyzer");
  expect(f.request).toHaveBeenCalledWith({ method: "analysis-request", replayId: "a", reason: "open" });
  f.coordinator.dispose();
});
it("coalesces live ready notifications, retains state while hidden and does not poll", async () => {
  jest.useFakeTimers();
  const f = fixture();
  await f.coordinator.enterLibrary();
  f.request.mockClear();
  f.changes$.next({ revision: 1, ready: false });
  expect(f.coordinator.snapshot().updating).toBe(true);
  jest.advanceTimersByTime(500);
  // Query projection may be busy while real source progress changes.
  // Read its status once, without querying results, analysis or resources.
  expect(f.request.mock.calls.map(([input]) => input.method)).toEqual(["status"]);
  f.changes$.next({ revision: 2, ready: true });
  f.changes$.next({ revision: 3, ready: true });
  jest.advanceTimersByTime(100);
  await flush();
  expect(f.request.mock.calls.filter(([r]) => r.method === "query-page" && r.query?.limit === 64)).toHaveLength(1);
  expect(f.request.mock.calls.filter(([r]) => r.method === "query-reveal")).toHaveLength(0);
  f.coordinator.returnToViewer();
  f.request.mockClear();
  f.changes$.next({ revision: 4, ready: true });
  jest.advanceTimersByTime(1000);
  await flush();
  expect(f.request).not.toHaveBeenCalled();
  await f.coordinator.enterLibrary();
  expect(f.request.mock.calls.some(([r]) => r.method === "query-page")).toBe(true);
  f.coordinator.dispose();
});

it("honours one busy Load more intent on the next ready event without polling or analysis requests", async () => {
  jest.useFakeTimers();
  const f = fixture(), original = fixtureRequest(f);
  let busy = false, appendAttempts = 0;
  const rows = (start: number) => ({
    items: Array.from({ length: 64 }, (_, index) => item(`replay-${start + index}`)),
    total: 192, analysisExcluded: 0, next: `after-${start + 64}`,
  });
  f.request.mockImplementation(async input => {
    if (input.method === "query-page") {
      if (input.query?.cursor) {
        appendAttempts++;
        if (busy) throw Object.assign(new Error("index updating"), { code: "library-query-updating" });
        return rows(64);
      }
      return rows(0);
    }
    return original(input);
  });
  try {
    await f.coordinator.enterLibrary();
    busy = true;
    await f.coordinator.view.loadMore();
    expect(f.coordinator.view.snapshot()).toMatchObject({ loadingMore: true, updating: true });
    f.changes$.next({ revision: 1, ready: false, resourceRevision: "1:1" });
    jest.advanceTimersByTime(10000);
    await flush();
    expect(appendAttempts).toBe(1);
    busy = false;
    f.changes$.next({ revision: 2, ready: true, resourceRevision: "1:1" });
    f.changes$.next({ revision: 3, ready: true, resourceRevision: "1:1" });
    jest.advanceTimersByTime(100);
    await flush();
    expect(appendAttempts).toBe(2);
    expect(f.coordinator.view.snapshot().page?.items).toHaveLength(128);
    expect(f.coordinator.view.snapshot()).toMatchObject({ loadingMore: false, loading: false, updating: false });
    expect(f.request.mock.calls.some(([input]) => input.method === "analysis-request")).toBe(false);
    const reads = f.request.mock.calls.length;
    jest.advanceTimersByTime(10000);
    await flush();
    expect(f.request).toHaveBeenCalledTimes(reads);
  } finally {
    f.coordinator.dispose();
    jest.useRealTimers();
  }
});

it("refreshes page, auxiliary and detail once per spaced semantic event and does no maintenance polling", async () => {
  jest.useFakeTimers();
  const f = fixture();
  try {
    await f.coordinator.enterLibrary();
    await f.coordinator.select("a");
    f.request.mockClear();
    const counts = () =>
      Object.fromEntries(
        ["query-page", "query-reveal", "query-detail", "status", "query-collections"].map((method) => [
          method,
          f.request.mock.calls.filter(
            ([request]) =>
              request.method === method && (request.method !== "query-page" || request.query?.limit === 64),
          ).length,
        ]),
      );
    f.changes$.next({ revision: 1, ready: true, resourceRevision: "source-change" });
    jest.advanceTimersByTime(100);
    await flush();
    const first = counts();
    expect(first).toEqual({ "query-page": 1, "query-reveal": 0, "query-detail": 1, status: 1, "query-collections": 1 });
    // A source-only Store batch emits no semantic event. More than six coalescing
    // windows must not create reads on their own.
    for (let i = 0; i < 6; i++) {
      jest.advanceTimersByTime(100);
      await flush();
    }
    expect(counts()).toEqual(first);
    // C repair can change counts without changing artwork. It remains observable.
    f.changes$.next({ revision: 2, ready: true, resourceRevision: "source-change" });
    jest.advanceTimersByTime(100);
    await flush();
    expect(counts()).toEqual({
      "query-page": 2,
      "query-reveal": 0,
      "query-detail": 2,
      status: 2,
      "query-collections": 2,
    });
  } finally {
    f.coordinator.dispose();
    jest.useRealTimers();
  }
});
it("ignores obsolete selected auxiliary results and keeps source failures visible", async () => {
  const f = fixture();
  await f.coordinator.enterLibrary();
  let done!: (value: unknown) => void;
  const original = f.request.getMockImplementation();
  f.request.mockImplementation(async (input) =>
    input.method === "query-same-map" && input.replayId === "a"
      ? new Promise((resolve) => {
          done = resolve;
        })
      : original?.(input),
  );
  const first = f.coordinator.select("a");
  await flush();
  await f.coordinator.select("b");
  done(page("old"));
  await first;
  expect(f.coordinator.snapshot().sameMap?.items[0].id).not.toBe("old");
  f.request.mockRejectedValueOnce(new Error("source unavailable"));
  await f.coordinator.sourceAction({ method: "scan", sourceId: "source" });
  expect(f.coordinator.snapshot().sources.error).toBe("source unavailable");
  f.coordinator.dispose();
});
it("tracks membership target independently of selected detail and paginates without assuming absent membership is false", async () => {
  const f = fixture();
  await f.coordinator.enterLibrary();
  f.request.mockResolvedValueOnce({
    items: [{ id: "c", name: "C", parentId: null, parentName: null }],
    total: 2,
    next: "next",
  });
  await f.coordinator.membershipTarget("a");
  expect(f.coordinator.snapshot().memberships).toMatchObject({
    replayId: "a",
    ids: ["c"],
    complete: false,
    next: "next",
  });
  f.request.mockResolvedValueOnce({ items: [{ id: "d", name: "D", parentId: null, parentName: null }], total: 2 });
  await f.coordinator.loadMoreMemberships();
  expect(f.coordinator.snapshot().memberships).toMatchObject({ ids: ["c", "d"], complete: true });
  f.coordinator.dispose();
});
it("sends only active references for parent deletion and consumes authoritative deleted descendant IDs", async () => {
  const f = fixture();
  await f.coordinator.enterLibrary();
  await f.coordinator.commitQuery({
    scope: { kind: "collection", id: "unloaded-child" },
    filters: [{ field: "collection", values: ["unloaded-child", "keep"] }],
  });
  const original = f.request.getMockImplementation();
  f.request.mockImplementation(async (input) =>
    input.method === "collection-delete" ? { deletedReferences: ["parent", "unloaded-child"] } : original?.(input),
  );
  await f.coordinator.mutate({ method: "collection-delete", collectionId: "parent" });
  expect(f.request).toHaveBeenCalledWith({
    method: "collection-delete",
    collectionId: "parent",
    referencedIds: ["unloaded-child", "keep"],
  });
  expect(f.coordinator.view.snapshot().query).toMatchObject({
    scope: { kind: "all" },
    filters: [{ field: "collection", values: ["keep"] }],
  });
  f.coordinator.dispose();
});
it("navigation lock preserves capture and avoids duplicate work on a second selection click", async () => {
  const f = fixture();
  f.coordinator.setNavigationLocked(true);
  await f.coordinator.enterLibrary();
  expect(f.navigate).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
  f.coordinator.setNavigationLocked(false);
  await f.coordinator.enterLibrary();
  await f.coordinator.select("a");
  await f.coordinator.select("a");
  expect(f.request.mock.calls.filter(([input]) => input.method === "analysis-request")).toHaveLength(1);
  f.coordinator.dispose();
});
it("loads sidebar and source counts from passive queries and preserves a measured zero", async () => {
  const f = fixture(),
    original = f.request.getMockImplementation();
  f.request.mockImplementation(async (input) =>
    input.method === "query-page" && input.query?.scope?.kind === "favourites"
      ? { ...page(), total: 0 }
      : original?.(input),
  );
  await f.coordinator.enterLibrary();
  expect(f.coordinator.snapshot()).toMatchObject({
    scopeCounts: { all: 1, recent: 1, favourites: 0 },
    sourceCounts: { stable: 1, replays: 0, lazer: 0, imported: 0 },
  });
  expect(f.request.mock.calls.some(([r]) => r.method === "analysis-request")).toBe(false);
  f.coordinator.dispose();
});
it("limits artwork to the rendered window with selection priority and releases deselected offscreen resources", async () => {
  const readResources = jest.fn(async (ids: string[], _selectedId?: string, _signal?: AbortSignal) =>
    Object.fromEntries(ids.map((id) => [id, { artUrl: `blob:${id}` }])),
  );
  const f = fixture({ readResources });
  await f.coordinator.enterLibrary();
  f.coordinator.visibleReplays(Array.from({ length: 60 }, (_, index) => `row-${index}`));
  await flush();
  expect(readResources.mock.calls.at(-1)?.[0]).toHaveLength(32);
  expect(f.request.mock.calls.some(([input]) => input.method === "analysis-request")).toBe(false);
  await f.coordinator.select("offscreen");
  expect(readResources.mock.calls.at(-1)?.[0][0]).toBe("offscreen");
  expect(readResources.mock.calls.at(-1)?.[0]).toHaveLength(32);
  expect(readResources.mock.calls.at(-1)?.[1]).toBe("offscreen");
  await f.coordinator.select(null);
  await flush();
  expect(readResources.mock.calls.at(-1)?.[1]).toBeUndefined();
  expect(f.coordinator.snapshot().resources.offscreen).toBeUndefined();
  f.coordinator.dispose();
});
it("aborts a hidden Library resource read, releases its window and fences a late result", async () => {
  let resolveArt!: (value: Record<string, { artUrl: string }>) => void;
  const readResources = jest.fn(async (ids: string[], _selectedId?: string, _signal?: AbortSignal) =>
    ids.length
      ? new Promise<Record<string, { artUrl: string }>>((resolve) => {
          resolveArt = resolve;
        })
      : {},
  );
  const f = fixture({ readResources });
  await f.coordinator.enterLibrary();
  f.coordinator.visibleReplays(["a"]);
  await flush();
  const pendingSignal = readResources.mock.calls.at(-1)?.[2];
  f.coordinator.returnToViewer();
  await flush();
  expect(pendingSignal?.aborted).toBe(true);
  expect(readResources.mock.calls.at(-1)?.[0]).toEqual([]);
  resolveArt({ a: { artUrl: "blob:stale" } });
  await flush();
  expect(f.coordinator.snapshot().resources).toEqual({});
  f.coordinator.dispose();
});
it("invalidates unknown hidden resources immediately without reading resources while the viewer owns the route", async () => {
  const invalidateResources = jest.fn(),
    readResources = jest.fn(async () => ({}));
  const f = fixture({ invalidateResources, readResources });
  await f.coordinator.enterLibrary();
  f.coordinator.visibleReplays(["a"]);
  await flush();
  f.coordinator.returnToViewer();
  await flush();
  readResources.mockClear();
  f.changes$.next({ revision: 1, ready: true });
  await flush();
  expect(readResources).not.toHaveBeenCalled();
  expect(invalidateResources).toHaveBeenCalledTimes(1);
  expect(invalidateResources).toHaveBeenLastCalledWith({ artwork: true, strip: true });
  await f.coordinator.enterLibrary();
  expect(invalidateResources).toHaveBeenCalledTimes(2);
  expect(invalidateResources).toHaveBeenLastCalledWith({ artwork: false, strip: true });
  f.coordinator.dispose();
});
it("preserves artwork on metric-only refreshes while renewing the selected strip and respects source or unknown revisions", async () => {
  jest.useFakeTimers();
  const invalidateResources = jest.fn(),
    readResources = jest.fn(async () => ({}));
  const f = fixture({ invalidateResources, readResources });
  await f.coordinator.enterLibrary();
  await f.coordinator.select("a");
  const change = async (revision: number, resourceRevision?: string) => {
    invalidateResources.mockClear();
    f.changes$.next({ revision, ready: true, resourceRevision });
    jest.advanceTimersByTime(100);
    await flush();
  };
  await change(1, "generation:1");
  expect(invalidateResources).toHaveBeenCalledWith({ artwork: true, strip: true });
  await change(2, "generation:1");
  expect(invalidateResources).toHaveBeenLastCalledWith({ artwork: false, strip: true });
  await change(3, "generation:2");
  expect(invalidateResources).toHaveBeenCalledWith({ artwork: true, strip: true });
  await change(4);
  expect(invalidateResources).toHaveBeenCalledWith({ artwork: true, strip: true });
  f.coordinator.dispose();
});
it("does not cancel in-flight artwork for a metric-only refresh when no detail strip is selected", async () => {
  jest.useFakeTimers();
  let resolveArt!: (value: Record<string, { artUrl: string }>) => void;
  const invalidateResources = jest.fn();
  const readResources = jest.fn(async (ids: string[], _selectedId?: string, _signal?: AbortSignal) =>
    ids.length
      ? new Promise<Record<string, { artUrl: string }>>((resolve) => {
          resolveArt = resolve;
        })
      : {},
  );
  const f = fixture({ invalidateResources, readResources });
  await f.coordinator.enterLibrary();
  f.changes$.next({ revision: 1, ready: true, resourceRevision: "maps:1" });
  jest.advanceTimersByTime(100);
  await flush();
  f.coordinator.visibleReplays(["a"]);
  await flush();
  const signal = readResources.mock.calls.at(-1)?.[2];
  invalidateResources.mockClear();
  readResources.mockClear();
  f.changes$.next({ revision: 2, ready: true, resourceRevision: "maps:1" });
  jest.advanceTimersByTime(100);
  await flush();
  expect(signal?.aborted).toBe(false);
  expect(invalidateResources).not.toHaveBeenCalled();
  expect(readResources).not.toHaveBeenCalled();
  resolveArt({ a: { artUrl: "blob:verified" } });
  await flush();
  expect(f.coordinator.snapshot().resources.a?.artUrl).toBe("blob:verified");
  f.coordinator.dispose();
});
