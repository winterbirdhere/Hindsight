import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { createPortal } from "react-dom";
import { Subject } from "rxjs";
import { InspectorProvider, useInspector } from "../providers/InspectorProvider";
import { LibraryUiCoordinator, LibraryUiOptions } from "../services/library/library-ui-coordinator";
import { LibraryPassiveResourceClient } from "../services/library/library-passive-resource-client";
import type { LibraryRequest } from "../../../../shared/replay-library";
import {
  LibraryHostProvider,
  LibraryViewerNavigation,
  LibraryScreenSwitch,
  ReplayLibraryHost,
} from "./replay-library-host";
import type { ReplayLibraryViewProps } from "./replay-library/library-view-types";
import { LibraryExactMapUnavailableError } from "../services/library/library-replay-resources";
import { frontendAPI } from "../api";
let viewProps: ReplayLibraryViewProps;
jest.mock("./replay-library/ReplayLibraryView", () => ({
  ReplayLibraryView: (props: ReplayLibraryViewProps) => {
    viewProps = props;
    return (
      <div>
        Library view
        {Object.entries(props.resources ?? {}).map(([id, resource]) =>
          resource?.artUrl ? <img key={id} alt={`Artwork ${id}`} src={resource.artUrl} /> : null,
        )}
      </div>
    );
  },
}));
jest.mock("../api", () => ({ frontendAPI: { runAppMenuAction: jest.fn(async () => undefined) } }));
jest.mock("./analyzer/DockIconButtons", () => ({
  DockButtonLabel: ({ children }: { children: unknown }) => <span>{children as never}</span>,
  dockIconButton: {},
  dockTextButton: {},
}));
function fixture(options: Partial<LibraryUiOptions> = {}) {
  const changes$ = new Subject<{ revision: number; ready: boolean; resourceRevision?: string }>();
  const request = jest.fn(async (_input: LibraryRequest): Promise<unknown> => null),
    navigate = jest.fn(),
    openReplay = jest.fn(async () => undefined);
  const coordinator = new LibraryUiCoordinator(
    { request, changes$, setViewerVisible: jest.fn() },
    { navigate, openReplay, locateStable: jest.fn(async () => undefined), ...options },
  );
  return { coordinator, request, navigate, openReplay, changes$ };
}
it("separates first-page pending from retained-page refresh even when source status is ready", () => {
  const f = fixture();
  f.coordinator.state$.next({ ...f.coordinator.snapshot(), sources: { ...f.coordinator.snapshot().sources,
    status: { replayCount: 0, updateMode: "auto", sources: [], rebuild: { state: "idle", observations: 0, mapErrors: {} },
      importRecovery: { state: "complete", completed: 0, failed: 0, failures: [] }, indexMaintenance: { state: "idle", ready: true, pending: 0 } } } });
  let rendered = render(<LibraryHostProvider coordinator={f.coordinator} viewerActive={false}><ReplayLibraryHost /></LibraryHostProvider>);
  try {
    expect(viewProps.initialLoading).toBe(true);
    act(() => f.coordinator.view.state$.next({ ...f.coordinator.view.snapshot(), page: { items: [], total: 0, analysisExcluded: 0 }, loading: true }));
    expect(viewProps.loading).toBe(true);
    expect(viewProps.initialLoading).toBe(false);
    act(() => f.coordinator.view.state$.next({ ...f.coordinator.view.snapshot(), query: { search: "new filter" }, page: null, loading: true }));
    expect(viewProps.loading).toBe(true);
    expect(viewProps.initialLoading).toBe(false);
    rendered.unmount();
    rendered = render(<LibraryHostProvider coordinator={f.coordinator} viewerActive={false}><ReplayLibraryHost /></LibraryHostProvider>);
    expect(viewProps.initialLoading).toBe(false);
    act(() => f.coordinator.view.state$.next({ ...f.coordinator.view.snapshot(), page: null, loading: false, error: "query failed" }));
    expect(viewProps.initialLoading).toBe(false);
  } finally { rendered.unmount(); f.coordinator.dispose(); }
});
it("opens an external replay through F2's native picker without importing or changing the retained library", async () => {
  const f = fixture();
  const rendered = render(<LibraryHostProvider coordinator={f.coordinator} viewerActive={false}><ReplayLibraryHost /></LibraryHostProvider>);
  try {
    const before = f.coordinator.view.snapshot();
    (frontendAPI.runAppMenuAction as jest.Mock).mockClear();
    f.request.mockClear();
    await act(async () => { await viewProps.onOpenReplayFile?.(); });
    expect(frontendAPI.runAppMenuAction).toHaveBeenCalledWith("openReplay");
    expect(frontendAPI.runAppMenuAction).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls.some(([input]) => input.method === "import-replays")).toBe(false);
    expect(f.openReplay).not.toHaveBeenCalled();
    expect(f.coordinator.view.snapshot().query).toEqual(before.query);
    expect(f.navigate).not.toHaveBeenCalled();
  } finally { rendered.unmount(); f.coordinator.dispose(); }
});
it("delivers confirmed map absence separately from query errors and preserves the retained viewer chip", async () => {
  const f = fixture({ openReplay: async () => { throw new LibraryExactMapUnavailableError("candidate", "a".repeat(32)); } });
  f.request.mockImplementation(async input => {
    if (input.method === "query-page") return { items: [], total: 0, analysisExcluded: 0 };
    if (input.method === "query-detail") return { item: { id: input.replayId }, metrics: [] };
    if (input.method === "query-reveal") return { state: "not-found" };
    if (input.method === "query-collections") return { items: [], total: 0 };
    if (input.method === "query-bands" || input.method === "query-facets") return { items: [] };
    return null;
  });
  f.coordinator.connect();
  f.changes$.next({ revision: 1, ready: true, resourceRevision: "maps:1" });
  await f.coordinator.enterLibrary(); await f.coordinator.select("candidate");
  f.coordinator.setNowPlayingMetadata({ id: "old", title: "Retained map", position: "0:48" });
  const rendered = render(<LibraryHostProvider coordinator={f.coordinator} viewerActive={false}><ReplayLibraryHost /></LibraryHostProvider>);
  try {
    await act(async () => { await f.coordinator.open("candidate", { fullMap: true }); });
    expect(viewProps.openError).toMatchObject({ replayId: "candidate", reason: "exact-map-unavailable" });
    expect(viewProps.error).toBeUndefined();
    expect(viewProps.nowPlaying).toMatchObject({ id: "old", title: "Retained map", position: "0:48" });
    expect(viewProps.selected?.item.id).toBe("candidate");
    expect(f.coordinator.fullMapRequest$.value).toBe(0);
    act(() => f.changes$.next({ revision: 2, ready: true, resourceRevision: "maps:2" }));
    expect(viewProps.openError).toBeUndefined();
  } finally { rendered.unmount(); f.coordinator.dispose(); }
});
it("keeps the last coherent page and counts through an idle revision refresh and clears prior-query results on commit", async () => {
  jest.useFakeTimers();
  const f = fixture();
  let revision = "r1",
    total = 3,
    holdBands = false,
    holdPage = false;
  let finishBands!: (value: unknown) => void, finishPage!: (value: unknown) => void;
  const page = () => ({ items: [], total, analysisExcluded: 0, revision });
  f.request.mockImplementation(async (input) => {
    if (input.method === "query-page")
      return holdPage && input.query?.limit !== 1
        ? new Promise((resolve) => {
            finishPage = resolve;
          })
        : page();
    if (input.method === "query-bands")
      return holdBands
        ? new Promise((resolve) => {
            finishBands = resolve;
          })
        : { items: [], revision };
    if (input.method === "query-facets")
      return { items: [{ value: "stable", label: "Stable", count: total }], revision };
    if (input.method === "query-collections") return { items: [], total: 0, revision };
    if (input.method === "query-player-names") return { names: [] };
    if (input.method === "analysis-settings")
      return { mode: "off", workers: 1, userPaused: false, pauseOnBattery: true };
    return null;
  });
  const settle = async (ms = 0) =>
    act(async () => {
      jest.advanceTimersByTime(ms);
      for (let i = 0; i < 40; i++) await Promise.resolve();
    });
  f.coordinator.connect();
  await f.coordinator.enterLibrary();
  const rendered = render(
    <LibraryHostProvider coordinator={f.coordinator} viewerActive={false}>
      <ReplayLibraryHost />
    </LibraryHostProvider>,
  );
  try {
    await settle();
    expect(viewProps.page.total).toBe(3);
    expect(viewProps.sourceCounts?.stable).toBe(3);
    revision = "r2";
    total = 4;
    holdBands = true;
    act(() => f.changes$.next({ revision: 1, ready: true, resourceRevision: "art:1" }));
    await settle(75);
    expect(f.coordinator.view.snapshot().page?.revision).toBe("r2");
    expect(viewProps.page.total).toBe(3);
    expect(viewProps.sourceCounts?.stable).toBe(3);
    expect(viewProps.updating).toBe(true);
    expect(viewProps.loadingMore).toBe(false);
    const pageReads = () =>
      f.request.mock.calls.filter(([input]) => input.method === "query-page" && input.query?.limit !== 1).length;
    const readsBefore = pageReads();
    // P publications can continue while the already-started r2 reads finish.
    // Their coherent response must be usable without waiting for global idleness.
    for (let i = 2; i <= 6; i++) {
      revision = `r${i + 1}`;
      total = 4 + i;
      act(() => f.changes$.next({ revision: i, ready: true, resourceRevision: "art:1" }));
      await settle(25);
    }
    expect(pageReads()).toBe(readsBefore);
    holdBands = false;
    await act(async () => finishBands({ items: [], revision: "r2" }));
    await settle();
    expect(viewProps.page.total).toBe(4);
    expect(viewProps.sourceCounts?.stable).toBe(4);
    await settle(75);
    expect(pageReads()).toBe(readsBefore + 1);
    expect(viewProps.page.total).toBe(10);
    expect(viewProps.sourceCounts?.stable).toBe(10);
    holdPage = true;
    let committing!: Promise<void>;
    act(() => {
      committing = f.coordinator.commitQuery({ search: "different" });
    });
    await settle();
    expect(viewProps.query.search).toBe("different");
    expect(viewProps.page.total).toBe(0);
    expect(viewProps.loading).toBe(true);
    holdPage = false;
    await act(async () => {
      finishPage({ ...page(), total: 1 });
      await committing;
    });
    await settle();
    expect(viewProps.page.total).toBe(1);
  } finally {
    rendered.unmount();
    f.coordinator.dispose();
    jest.useRealTimers();
  }
});
it("manual feedback: exposes append pending separately while retaining the coherent result and counts", async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.request.mockImplementation(async input => {
    if (input.method === "query-page") {
      if (input.query?.cursor) return new Promise(resolve => { finish = resolve; });
      return { items: [], total: 256, next: "next", analysisExcluded: 0, revision: "r1" };
    }
    if (input.method.startsWith("query-")) return { items: [], total: 0, names: [], revision: "r1" };
    return null;
  });
  f.coordinator.connect();
  await f.coordinator.enterLibrary();
  const rendered = render(<LibraryHostProvider coordinator={f.coordinator} viewerActive={false}><ReplayLibraryHost /></LibraryHostProvider>);
  try {
    const retained = viewProps.page;
    let append!: Promise<void>;
    act(() => { append = f.coordinator.view.loadMore(); });
    expect(viewProps.loadingMore).toBe(true);
    expect(viewProps.page).toBe(retained);
    expect(viewProps.scopeCounts?.all).toBe(256);
    await act(async () => {
      finish({ items: [], total: 256, next: "next-two", analysisExcluded: 0, revision: "r1" });
      await append;
    });
    expect(viewProps.loadingMore).toBe(false);
    expect(viewProps.page.next).toBe("next-two");
    expect(viewProps.scopeCounts?.all).toBe(256);
  } finally { rendered.unmount(); f.coordinator.dispose(); }
});
type Resources = NonNullable<ReplayLibraryViewProps["resources"]>;
it("ends terminal query loading and updating after rejection while a genuine retry remains busy", async () => {
  jest.useFakeTimers();
  const f = fixture();
  let fail = false,
    hold = false,
    rejectPage!: (error: Error) => void;
  f.request.mockImplementation(async (input) => {
    if (input.method === "query-page") {
      if (input.query?.limit !== 1 && hold)
        return new Promise((_resolve, reject) => {
          rejectPage = reject;
        });
      if (input.query?.limit !== 1 && fail) throw new Error("query unavailable");
      return { items: [], total: 3, analysisExcluded: 0, revision: "r1" };
    }
    if (input.method.startsWith("query-")) return { items: [], total: 0, names: [], revision: "r1" };
    return null;
  });
  const settle = async (ms = 0) =>
    act(async () => {
      jest.advanceTimersByTime(ms);
      for (let i = 0; i < 40; i++) await Promise.resolve();
    });
  f.coordinator.connect();
  await f.coordinator.enterLibrary();
  const rendered = render(
    <LibraryHostProvider coordinator={f.coordinator} viewerActive={false}>
      <ReplayLibraryHost />
    </LibraryHostProvider>,
  );
  try {
    await settle();
    expect(viewProps.page.total).toBe(3);
    fail = true;
    hold = true;
    let pending!: Promise<void>;
    act(() => {
      pending = f.coordinator.commitQuery({ search: "failed query" });
    });
    await settle();
    expect(viewProps.loading).toBe(true);
    expect(viewProps.page.total).toBe(0);
    hold = false;
    await act(async () => {
      rejectPage(new Error("query unavailable"));
      await pending;
    });
    // Let the existing one coalesced mismatch retry finish; it must not leave a
    // terminal no-page failure advertised as Reading/Updating indefinitely.
    await settle(75);
    await settle(1000);
    expect(viewProps.error).toBe("query unavailable");
    expect(viewProps.page.items).toEqual([]);
    expect(viewProps.page.total).toBe(0);
    expect(viewProps.loading).toBe(false);
    expect(viewProps.updating).toBe(false);
    hold = true;
    act(() => {
      pending = f.coordinator.commitQuery({ search: "failed query" });
    });
    await settle();
    expect(viewProps.loading).toBe(true);
    expect(viewProps.error).toBeUndefined();
    hold = false;
    await act(async () => {
      rejectPage(new Error("query unavailable"));
      await pending;
    });
    await settle(75);
    await settle(1000);
    expect(viewProps.loading).toBe(false);
    expect(viewProps.updating).toBe(false);
  } finally {
    rendered.unmount();
    f.coordinator.dispose();
    jest.useRealTimers();
  }
});
it("shows the first coherent page during ongoing publications and coalesces later refreshes without clearing it", async () => {
  jest.useFakeTimers();
  const f = fixture();
  let revision = "r2",
    holdPage = false,
    mainReads = 0;
  let finishPage!: (value: unknown) => void;
  f.request.mockImplementation(async (input) => {
    if (input.method === "query-page" && input.query?.limit !== 1) {
      mainReads++;
      if (holdPage)
        return new Promise((resolve) => {
          finishPage = resolve;
        });
      return {
        items: [],
        total: mainReads === 1 ? 3 : 4,
        analysisExcluded: 0,
        revision: mainReads === 1 ? "r1" : revision,
      };
    }
    if (input.method === "query-page") return { items: [], total: 4, analysisExcluded: 0, revision };
    if (input.method === "query-bands" || input.method === "query-collections")
      return { items: [], total: 0, revision };
    if (input.method === "query-facets") return { items: [{ value: "stable", count: 4 }], revision };
    if (input.method === "query-player-names") return { names: [] };
    if (input.method === "analysis-settings")
      return { mode: "off", workers: 1, userPaused: false, pauseOnBattery: true };
    return null;
  });
  const settle = async (ms = 0) =>
    act(async () => {
      jest.advanceTimersByTime(ms);
      for (let i = 0; i < 40; i++) await Promise.resolve();
    });
  f.coordinator.connect();
  await f.coordinator.enterLibrary();
  const rendered = render(
    <LibraryHostProvider coordinator={f.coordinator} viewerActive={false}>
      <ReplayLibraryHost />
    </LibraryHostProvider>,
  );
  try {
    await settle();
    expect(viewProps.page.total).toBe(3);
    expect(viewProps.sourceCounts).toBeUndefined();
    revision = "r3";
    holdPage = true;
    await settle(75);
    expect(mainReads).toBe(2);
    expect(viewProps.page.total).toBe(3);
    for (let i = 1; i <= 5; i++) {
      act(() => f.changes$.next({ revision: i, ready: true, resourceRevision: "same" }));
      await settle(25);
    }
    expect(mainReads).toBe(2);
    expect(viewProps.page.total).toBe(3);
    holdPage = false;
    await act(async () => finishPage({ items: [], total: 4, analysisExcluded: 0, revision }));
    await settle();
    expect(viewProps.page.total).toBe(4);
    expect(viewProps.sourceCounts?.stable).toBe(4);
    await settle(75);
    expect(mainReads).toBe(3);
    await settle(1000);
    expect(mainReads).toBe(3);
  } finally {
    rendered.unmount();
    f.coordinator.dispose();
    jest.useRealTimers();
  }
});
function resourceLeaseProbe(coordinator: LibraryUiCoordinator) {
  const leases: { resources: Resources; release: jest.Mock }[] = [];
  const retain = jest.fn((resources: Resources) => {
    const release = jest.fn();
    leases.push({ resources, release });
    return release;
  });
  // The service suite verifies actual URL ownership. This boundary probe verifies
  // React commit/cleanup ordering without substituting a mock React scheduler.
  Object.defineProperty(coordinator, "retainRenderedResources", { configurable: true, value: retain });
  return { retain, leases };
}
function publishResources(coordinator: LibraryUiCoordinator, resources: Resources) {
  coordinator.state$.next({ ...coordinator.snapshot(), resources });
}
it("keeps invalidated real URLs alive until React commits, retains cached URLs on route leave, and releases them on disposal", async () => {
  const revoked: string[] = [];
  const payloads = new Map<string, number>();
  let created = 0,
    resourceRead: Promise<Resources> = Promise.resolve({});
  const client = new LibraryPassiveResourceClient(
    {
      resource: async (input) => {
        if (input.method === "artwork") {
          payloads.set(input.requestId, input.replayId === "a" ? 1 : 2);
          return { state: "ready", bytes: 1, mime: "image/png" };
        }
        if (input.method === "chunk") return { bytes: new Uint8Array([payloads.get(input.requestId) ?? 0]), done: true };
        if (input.method === "release") payloads.delete(input.requestId);
        return input.method === "strip" ? null : undefined;
      },
    },
    { create: () => `blob:owned-${++created}`, revoke: (url) => revoked.push(url) },
  );
  const f = fixture({
    readResources: (artworkIds, stripReplayId, signal) =>
      (resourceRead = client.update({ artworkIds, stripReplayId }, signal)),
    invalidateResources: (options) => client.invalidate(options),
    disposeResources: () => client.dispose(),
  });
  f.request.mockImplementation(async (input) => {
    switch (input.method) {
      case "query-page":
        return { items: [], total: 0, analysisExcluded: 0 };
      case "query-bands":
      case "query-facets":
        return { items: [] };
      case "query-collections":
        return { items: [], total: 0 };
      case "status":
        return {
          replayCount: 0,
          sources: [],
          updateMode: "manual",
          rebuild: { state: "idle", observations: 0, mapErrors: {} },
          importRecovery: { state: "complete", completed: 0, failed: 0, failures: [] },
        };
      case "analysis-settings":
        return { mode: "off", workers: 1, userPaused: false, pauseOnBattery: true };
      default:
        throw new Error(`Unexpected request: ${input.method}`);
    }
  });
  f.coordinator.connect();
  await f.coordinator.enterLibrary();
  f.coordinator.visibleReplays(["a"]);
  await resourceRead;
  const tree = (active: boolean) => (
    <StrictMode>
      <LibraryHostProvider coordinator={f.coordinator} viewerActive={!active}>
        <LibraryScreenSwitch libraryActive={active}>
          <div>Retained resource viewer</div>
        </LibraryScreenSwitch>
      </LibraryHostProvider>
    </StrictMode>
  );
  const rendered = render(tree(true));
  try {
    await act(async () => await Promise.resolve());
    expect(screen.getByAltText("Artwork a").getAttribute("src")).toBe("blob:owned-1");
    expect(revoked).toEqual([]);
    await act(async () => {
      // Explicitly retire cache ownership. Ordinary viewport changes retain
      // inactive entries, so they cannot alone prove the committed React lease.
      client.invalidate();
      f.coordinator.visibleReplays(["b"]);
      // Publication/cache ownership have retired a, but React has not committed its removal.
      expect(screen.getByAltText("Artwork a").getAttribute("src")).toBe("blob:owned-1");
      expect(revoked).toEqual([]);
      await resourceRead;
    });
    expect(screen.queryByAltText("Artwork a")).toBeNull();
    expect(screen.getByAltText("Artwork b").getAttribute("src")).toBe("blob:owned-2");
    expect(revoked).toEqual(["blob:owned-1"]);
    rendered.rerender(tree(true));
    expect(revoked).toEqual(["blob:owned-1"]);
    await act(async () => {
      f.coordinator.returnToViewer();
      expect(screen.getByAltText("Artwork b").getAttribute("src")).toBe("blob:owned-2");
      expect(revoked).toEqual(["blob:owned-1"]);
      rendered.rerender(tree(false));
      await resourceRead;
    });
    expect(screen.queryByAltText("Artwork b")).toBeNull();
    expect(screen.getByText("Retained resource viewer")).toBeTruthy();
    // Route cleanup releases React/publication leases; the bounded cache still
    // owns b and can serve it on return without recreating its URL.
    expect(revoked).toEqual(["blob:owned-1"]);
    await act(async () => {
      await f.coordinator.enterLibrary();
      f.coordinator.visibleReplays(["a"]);
      await resourceRead;
      rendered.rerender(tree(true));
    });
    expect(screen.getByAltText("Artwork a").getAttribute("src")).toBe("blob:owned-3");
    act(() => {
      f.coordinator.dispose();
      expect(screen.getByAltText("Artwork a").getAttribute("src")).toBe("blob:owned-3");
      expect(revoked).toEqual(["blob:owned-1", "blob:owned-2"]);
    });
    expect(screen.queryByAltText("Artwork a")).toBeNull();
    expect(revoked).toEqual(["blob:owned-1", "blob:owned-2", "blob:owned-3"]);
  } finally {
    rendered.unmount();
    await act(async () => await Promise.resolve());
    f.coordinator.dispose();
    await client.dispose();
  }
  expect(revoked).toEqual(["blob:owned-1", "blob:owned-2", "blob:owned-3"]);
});
it("retains committed artwork while a replacement is deferred and releases it on replacement and route leave", async () => {
  const f = fixture(),
    probe = resourceLeaseProbe(f.coordinator),
    first = { first: { artUrl: "blob:first" } },
    skipped = { skipped: { artUrl: "blob:skipped" } },
    replacement = { replacement: { artUrl: "blob:replacement" } };
  publishResources(f.coordinator, first);
  const tree = (active: boolean) => (
    <LibraryHostProvider coordinator={f.coordinator} viewerActive={!active}>
      <LibraryScreenSwitch libraryActive={active}>
        <div>Retained viewer</div>
      </LibraryScreenSwitch>
    </LibraryHostProvider>
  );
  const rendered = render(tree(true));
  expect(probe.leases.map((lease) => lease.resources)).toEqual([first]);
  expect(screen.getByAltText("Artwork first").getAttribute("src")).toBe("blob:first");
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => (finish = resolve)).then(() => {
    publishResources(f.coordinator, skipped);
    publishResources(f.coordinator, replacement);
  });
  expect(probe.leases[0].release).not.toHaveBeenCalled();
  expect(screen.queryByAltText("Artwork replacement")).toBeNull();
  await act(async () => {
    finish();
    await pending;
  });
  expect(screen.queryByAltText("Artwork first")).toBeNull();
  expect(screen.getByAltText("Artwork replacement").getAttribute("src")).toBe("blob:replacement");
  expect(probe.leases.map((lease) => lease.resources)).toEqual([first, replacement]);
  expect(probe.leases[0].release).toHaveBeenCalledTimes(1);
  expect(probe.leases[1].release).not.toHaveBeenCalled();
  rendered.rerender(tree(false));
  expect(probe.leases[1].release).toHaveBeenCalledTimes(1);
  expect(screen.queryByAltText("Artwork replacement")).toBeNull();
  expect(screen.getByText("Retained viewer")).toBeTruthy();
});
it("balances each committed resource lease through StrictMode replay and real unmount", async () => {
  const f = fixture(),
    probe = resourceLeaseProbe(f.coordinator),
    resources = { replay: { artUrl: "blob:strict" } },
    dispose = jest.spyOn(f.coordinator, "dispose");
  publishResources(f.coordinator, resources);
  const rendered = render(
    <StrictMode>
      <LibraryHostProvider coordinator={f.coordinator} viewerActive={false}>
        <ReplayLibraryHost />
      </LibraryHostProvider>
    </StrictMode>,
  );
  expect(probe.leases.map((lease) => lease.resources)).toEqual([resources, resources]);
  expect(probe.leases[0].release).toHaveBeenCalledTimes(1);
  expect(probe.leases[1].release).not.toHaveBeenCalled();
  await act(async () => await Promise.resolve());
  expect(dispose).not.toHaveBeenCalled();
  expect(screen.getByAltText("Artwork replay").getAttribute("src")).toBe("blob:strict");
  rendered.unmount();
  expect(probe.leases.every((lease) => lease.release.mock.calls.length === 1)).toBe(true);
  await act(async () => await Promise.resolve());
  expect(dispose).toHaveBeenCalledTimes(1);
});
it("reads the replacement coordinator immediately and ignores retired-store resource emissions", () => {
  const first = fixture(),
    second = fixture(),
    firstProbe = resourceLeaseProbe(first.coordinator),
    secondProbe = resourceLeaseProbe(second.coordinator),
    oldResources = { old: { artUrl: "blob:old-owner" } },
    newResources = { current: { artUrl: "blob:new-owner" } };
  publishResources(first.coordinator, oldResources);
  publishResources(second.coordinator, newResources);
  const tree = (coordinator: LibraryUiCoordinator) => (
    <LibraryHostProvider coordinator={coordinator} viewerActive={false}>
      <ReplayLibraryHost />
    </LibraryHostProvider>
  );
  const rendered = render(tree(first.coordinator));
  rendered.rerender(tree(second.coordinator));
  expect(screen.queryByAltText("Artwork old")).toBeNull();
  expect(screen.getByAltText("Artwork current").getAttribute("src")).toBe("blob:new-owner");
  expect(firstProbe.leases[0].release).toHaveBeenCalledTimes(1);
  expect(secondProbe.retain).toHaveBeenCalledWith(newResources);
  act(() => publishResources(first.coordinator, { retired: { artUrl: "blob:retired" } }));
  expect(screen.queryByAltText("Artwork retired")).toBeNull();
  expect(secondProbe.leases).toHaveLength(1);
  expect(secondProbe.leases[0].release).not.toHaveBeenCalled();
  rendered.unmount();
  expect(secondProbe.leases[0].release).toHaveBeenCalledTimes(1);
});
it("binds controlled query, scroll, selection and paged auxiliary callbacks without synthetic data", () => {
  const f = fixture();
  render(
    <LibraryHostProvider coordinator={f.coordinator} viewerActive={false}>
      <ReplayLibraryHost />
    </LibraryHostProvider>,
  );
  expect(screen.getByText("Library view")).toBeTruthy();
  expect(viewProps.sources.analysisLoading).toBe(true);
  act(() => viewProps.onScrollTopChange?.(400));
  act(() => viewProps.onScrollLeftChange?.(60));
  expect(f.coordinator.view.snapshot()).toMatchObject({ scrollTop: 400, scrollLeft: 60 });
  expect(viewProps.sameMap).toBeUndefined();
  expect(viewProps.resources).toEqual({});
  expect(f.request).not.toHaveBeenCalled();
});
it("passes name saves and import results through and suppresses aggregate publications from a different page revision", async () => {
  const f = fixture(),
    summary = { added: 1, alreadyImported: 0, failed: 0, failures: [], truncatedFailures: false };
  jest.spyOn(f.coordinator, "sourceAction").mockResolvedValue(summary);
  jest.spyOn(f.coordinator, "saveMyNames").mockResolvedValue(["lark"]);
  f.coordinator.view.state$.next({
    ...f.coordinator.view.snapshot(),
    page: { items: [], total: 0, analysisExcluded: 0, revision: "new" },
  });
  f.coordinator.state$.next({
    ...f.coordinator.snapshot(),
    myNames: { names: ["old"], loading: false },
    bands: { items: [{ key: "old", label: "Old", count: 9, anchorId: "old" }], revision: "old" },
    scopeCounts: { all: 9 },
    countsRevision: "old",
  });
  render(
    <LibraryHostProvider coordinator={f.coordinator} viewerActive={false}>
      <ReplayLibraryHost />
    </LibraryHostProvider>,
  );
  expect(viewProps.bands).toEqual([]);
  expect(viewProps.scopeCounts).toEqual({});
  expect(viewProps.myNames).toEqual({ names: ["old"], loading: false });
  expect(await viewProps.onSaveMyNames?.(["lark"])).toEqual(["lark"]);
  expect(await viewProps.onSourceAction({ method: "import-replays" })).toEqual(summary);
});
it("keeps the chip's playhead separate from library snapshot order", () => {
  const f = fixture();
  f.coordinator.state$.next({
    ...f.coordinator.snapshot(),
    nowPlaying: { id: "current", title: "Loaded", position: "2:03" },
  });
  f.coordinator.view.state$.next({
    ...f.coordinator.view.snapshot(),
    navigation: { snapshotId: "snapshot", total: 89, position: 4, scopeLabel: "All", sortLabel: "PP" },
  });
  render(
    <LibraryHostProvider coordinator={f.coordinator} viewerActive={false}>
      <ReplayLibraryHost />
    </LibraryHostProvider>,
  );
  expect(viewProps.nowPlaying?.position).toBe("2:03");
});
it("opens Library with Ctrl+L only from the viewer and shows no invented snapshot position", () => {
  const f = fixture(),
    enter = jest.spyOn(f.coordinator, "enterLibrary").mockResolvedValue();
  const rendered = render(
    <LibraryHostProvider coordinator={f.coordinator} viewerActive>
      <LibraryViewerNavigation />
    </LibraryHostProvider>,
  );
  fireEvent.keyDown(window, { key: "l", ctrlKey: true });
  expect(enter).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Library" })).toBeTruthy();
  expect(screen.queryByLabelText("Previous replay in library order")).toBeNull();
  rendered.rerender(
    <LibraryHostProvider coordinator={f.coordinator} viewerActive={false}>
      <LibraryViewerNavigation />
    </LibraryHostProvider>,
  );
  fireEvent.keyDown(window, { key: "l", ctrlKey: true });
  expect(enter).toHaveBeenCalledTimes(1);
});
it("keeps the loaded viewer mounted across library visits", () => {
  const f = fixture(),
    mounted = jest.fn(),
    unmounted = jest.fn();
  function Viewer() {
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return <div>Loaded viewer</div>;
  }
  const tree = (libraryActive: boolean) => (
    <LibraryHostProvider coordinator={f.coordinator} viewerActive={!libraryActive}>
      <LibraryScreenSwitch libraryActive={libraryActive}>
        <Viewer />
      </LibraryScreenSwitch>
    </LibraryHostProvider>
  );
  const rendered = render(tree(false));
  rendered.rerender(tree(true));
  expect(screen.getByText("Loaded viewer").closest("[aria-hidden]")?.getAttribute("aria-hidden")).toBe("true");
  rendered.rerender(tree(false));
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});
it("leaves Ctrl+L with an editor or active viewer modal without hiding its retained state", () => {
  const f = fixture(),
    enter = jest.spyOn(f.coordinator, "enterLibrary").mockResolvedValue();
  const tree = (modal: boolean) => (
    <LibraryHostProvider coordinator={f.coordinator} viewerActive>
      <input aria-label="Viewer setting" />
      <div contentEditable aria-label="Editable value" />
      {modal &&
        createPortal(
          <div role="dialog" aria-modal="true">
            Full-map analysis
          </div>,
          document.body,
        )}
    </LibraryHostProvider>
  );
  const rendered = render(tree(false));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Viewer setting" }), { key: "l", ctrlKey: true });
  fireEvent.keyDown(screen.getByLabelText("Editable value"), { key: "l", ctrlKey: true });
  expect(enter).not.toHaveBeenCalled();
  rendered.rerender(tree(true));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "l", ctrlKey: true });
  // A modal also owns focus during its transition before a control receives focus.
  fireEvent.keyDown(window, { key: "l", ctrlKey: true });
  expect(enter).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog").textContent).toBe("Full-map analysis");
  rendered.rerender(tree(false));
  fireEvent.keyDown(window, { key: "l", ctrlKey: true });
  expect(enter).toHaveBeenCalledTimes(1);
});
it("preserves hidden inspector settings on Library Escape and restores viewer Escape on return", () => {
  const f = fixture();
  function InspectorProbe() {
    const inspector = useInspector();
    return <output data-testid="retained-mode">{inspector.mode}</output>;
  }
  const tree = (libraryActive: boolean) => (
    <LibraryHostProvider coordinator={f.coordinator} viewerActive={!libraryActive}>
      <LibraryScreenSwitch libraryActive={libraryActive}>
        <InspectorProvider initialMode="settings">
          <InspectorProbe />
        </InspectorProvider>
      </LibraryScreenSwitch>
    </LibraryHostProvider>
  );
  const rendered = render(tree(false));
  rendered.rerender(tree(true));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByTestId("retained-mode").textContent).toBe("settings");
  rendered.rerender(tree(false));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByTestId("retained-mode").textContent).toBe("incidents");
});
