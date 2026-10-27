import { act, StrictMode } from "react";
import { createRoot, Root } from "react-dom/client";
import { ipcRenderer, webUtils } from "electron";
import { useNavigate } from "react-router-dom";
import { useTheaterContext } from "./providers/TheaterProvider";
import { releaseActiveActivationFocus } from "./utils/focus";
import { RewindApp } from "./RewindApp";
import type { LibraryUiCoordinator } from "./services/library/library-ui-coordinator";
import type { LibraryRequest } from "../../../shared/replay-library";
import { LIBRARY_PASSIVE_RESOURCE_CHANNEL } from "../../../shared/library-passive-resources";
import { BehaviorSubject } from "rxjs";
import type { ReplayLoadState } from "./services/manager/replay-load-state";

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let libraryCoordinator: LibraryUiCoordinator | undefined;

jest.mock("electron", () => {
  const { EventEmitter } = jest.requireActual<typeof import("events")>("events");
  const ipcRenderer = new EventEmitter() as import("events").EventEmitter & { invoke: jest.Mock };
  ipcRenderer.invoke = jest.fn();
  return { ipcRenderer, webUtils: { getPathForFile: jest.fn() } };
});
jest.mock("react-router-dom", () => ({
  useNavigate: jest.fn(),
  useLocation: () => ({ pathname: "/" }),
  // Renders only the index route's element, which is the splash.
  Routes: ({ children }: { children?: unknown }) => {
    const { Children } = jest.requireActual<typeof import("react")>("react");
    const index = Children.toArray(children as never).find(
      (child) =>
        typeof child === "object" && child !== null && "props" in child && (child.props as { index?: boolean }).index,
    ) as { props: { element: unknown } } | undefined;
    return (index?.props.element as never) ?? null;
  },
  Route: () => null,
  Outlet: () => null,
}));
jest.mock("@mui/material", () => ({ Box: () => null, Snackbar: () => null, Alert: () => null }));
jest.mock("./providers/TheaterProvider", () => ({ useTheaterContext: jest.fn() }));
jest.mock("./utils/focus", () => ({ releaseActiveActivationFocus: jest.fn() }));
jest.mock("./screens/splash/SplashScreen", () => ({
  SplashScreen: ({ progress }: { progress: { stepIndex: number } }) => {
    const { startupCaption } = jest.requireActual<typeof import("./services/startup/startup-steps")>(
      "./services/startup/startup-steps",
    );
    return <div data-testid="splash">{startupCaption(progress).label}</div>;
  },
}));
jest.mock("./screens/home/HomeScreen", () => ({ HomeScreen: () => null }));
jest.mock("./screens/analyzer/Analyzer", () => ({ Analyzer: () => null }));
jest.mock("./screens/setup/SetupScreen", () => ({ SetupScreen: () => null }));
jest.mock("./services/library/LibraryDemandBridge", () => ({ LibraryDemandBridge: () => null }));
jest.mock("./components/replay-library-host", () => ({
  LibraryHostProvider: ({ children, coordinator }: { children: unknown; coordinator: LibraryUiCoordinator }) => {
    libraryCoordinator = coordinator;
    return children;
  },
  LibraryScreenSwitch: ({ children }: { children: unknown }) => children,
  useLibraryUi: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function dragEvent(type: "dragover" | "drop", files: File[] = [], types = ["Files"]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = { files, types, dropEffect: "none" };
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  window.dispatchEvent(event);
  return { event, dataTransfer };
}

describe("RewindApp startup", () => {
  let root: Root | undefined;
  let navigate: jest.Mock;
  let theater: {
    library: {
      foreground: (work: () => Promise<void>) => Promise<void>;
      setViewerVisible?: jest.Mock;
      request: jest.Mock;
    };
    common: { initialize: jest.Mock };
    analyzer: {
      loadReplay: jest.Mock;
      screenshotTaker: { takeScreenshot: jest.Mock };
      clipRecorder: { isBusy: boolean };
      scenarioManager?: { loadState$: BehaviorSubject<ReplayLoadState>; getBeatmapMetadata(): { title: string }; loadLibraryReplay?: jest.Mock };
      gameClock?: { timeElapsedInMs: number };
      setViewerVisible?: jest.Mock;
      osuFolderService: {
        hasValidOsuFolderSet: jest.Mock;
        getOsuFolder: () => string;
        songsFolder$: { getValue: () => string };
        replaysFolder$: { getValue: () => string };
      };
    };
  };

  async function mount() {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <StrictMode>
          <RewindApp />
        </StrictMode>,
      );
    });
  }

  async function unmount() {
    await act(async () => root?.unmount());
    root = undefined;
  }

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    ipcRenderer.removeAllListeners("onManualReplayOpen");
    navigate = jest.fn();
    theater = {
      library: {
        foreground: (work) => work(),
        setViewerVisible: jest.fn(),
        request: jest.fn(async (request: LibraryRequest) => {
          switch (request.method) {
            case "query-page":
              return { items: [], total: 0, analysisExcluded: 0 };
            case "query-detail":
              return { item: { id: request.replayId }, metrics: [] };
            case "query-same-map":
              return { items: [], total: 0, analysisExcluded: 0 };
            case "query-collections":
              return { items: [], total: 0 };
            case "query-bands":
            case "query-facets":
              return { items: [] };
            case "analysis-settings":
              return { mode: "off", workers: 1, userPaused: false, pauseOnBattery: true };
            default:
              return null;
          }
        }),
      },
      common: { initialize: jest.fn().mockResolvedValue(undefined) },
      analyzer: {
        loadReplay: jest.fn().mockResolvedValue(undefined),
        screenshotTaker: { takeScreenshot: jest.fn().mockResolvedValue(undefined) },
        clipRecorder: { isBusy: false },
        osuFolderService: {
          hasValidOsuFolderSet: jest.fn().mockResolvedValue(true),
          getOsuFolder: () => "osu",
          songsFolder$: { getValue: () => "Songs" },
          replaysFolder$: { getValue: () => "Replays" },
        },
      },
    };
    (useNavigate as jest.Mock).mockReturnValue(navigate);
    (useTheaterContext as jest.Mock).mockReturnValue(theater);
    (releaseActiveActivationFocus as jest.Mock).mockClear();
    (webUtils.getPathForFile as jest.Mock).mockReset().mockImplementation((file: File) => `D:/Replays/${file.name}`);
    (ipcRenderer.invoke as jest.Mock)
      .mockReset()
      .mockImplementation(async (_channel, request) =>
        request?.method === "artwork"
          ? { state: "unavailable" }
          : request?.method === "reveal"
          ? { revealed: true }
          : null,
      );
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    libraryCoordinator?.dispose();
    libraryCoordinator = undefined;
    await unmount();
    document.body.innerHTML = "";
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    jest.restoreAllMocks();
  });

  it("uses the passive resource channel for rendered artwork, selected strip and file reveal without startup resource work", async () => {
    await mount();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith(LIBRARY_PASSIVE_RESOURCE_CHANNEL, expect.anything());
    const coordinator = libraryCoordinator;
    if (!coordinator) throw new Error("The production shell did not provide its Library coordinator");
    coordinator.connect();
    await coordinator.enterLibrary();
    coordinator.visibleReplays(["visible-replay"]);
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      LIBRARY_PASSIVE_RESOURCE_CHANNEL,
      expect.objectContaining({ method: "artwork", replayId: "visible-replay" }),
    );
    expect(theater.library.request.mock.calls.some(([request]) => request.method === "analysis-request")).toBe(false);
    await coordinator.select("selected-replay");
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      LIBRARY_PASSIVE_RESOURCE_CHANNEL,
      expect.objectContaining({ method: "strip", replayId: "selected-replay" }),
    );
    await coordinator.revealFile("selected-replay");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      LIBRARY_PASSIVE_RESOURCE_CHANNEL,
      expect.objectContaining({ method: "reveal", replayId: "selected-replay" }),
    );
    coordinator.returnToViewer();
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(coordinator.snapshot().resources).toEqual({});
  });

  it("reuses loaded viewer artwork and reads the actual paused playhead including zero on Library entry", async () => {
    const loadState$ = new BehaviorSubject<ReplayLoadState>({ phase: "idle" });
    const gameClock = { timeElapsedInMs: 0 };
    theater.analyzer.scenarioManager = { loadState$, getBeatmapMetadata: () => ({ title: "Loaded map" }) };
    theater.analyzer.gameClock = gameClock;
    theater.analyzer.setViewerVisible = jest.fn();
    await mount();
    act(() => {
      loadState$.next({ phase: "loading", step: "simulate", backgroundUrl: "blob:retained-viewer-art" });
      loadState$.next({ phase: "ready" });
    });
    await libraryCoordinator?.enterLibrary();
    expect(libraryCoordinator?.snapshot().nowPlaying).toMatchObject({
      title: "Loaded map",
      artUrl: "blob:retained-viewer-art",
      position: "0:00",
    });
    libraryCoordinator?.returnToViewer();
    gameClock.timeElapsedInMs = 123999;
    await libraryCoordinator?.enterLibrary();
    expect(libraryCoordinator?.snapshot().nowPlaying).toMatchObject({
      position: "2:03",
      artUrl: "blob:retained-viewer-art",
    });
    expect(theater.analyzer.loadReplay).not.toHaveBeenCalled();
    act(() => {
      loadState$.next({ phase: "loading", step: "read-replay" });
      loadState$.next({ phase: "ready" });
    });
    expect(libraryCoordinator?.snapshot().nowPlaying?.artUrl).toBeUndefined();
    act(() => loadState$.next({ phase: "idle" }));
    expect(libraryCoordinator?.snapshot().nowPlaying).toBeUndefined();
  });
  it("does not mistake the retained ready viewer for a successful replacement or full-map request", async () => {
    const loadState$ = new BehaviorSubject<ReplayLoadState>({ phase: "ready" });
    const loadLibraryReplay = jest.fn(async () => false);
    theater.analyzer.gameClock = { timeElapsedInMs: 48161 };
    theater.analyzer.scenarioManager = { loadState$, loadLibraryReplay, getBeatmapMetadata: () => ({ title: "Retained map" }) };
    const original = theater.library.request.getMockImplementation();
    theater.library.request.mockImplementation(async (input: LibraryRequest) => input.method === "query-reveal" ? { state: "not-found" } : original?.(input));
    await mount();
    const coordinator = libraryCoordinator;
    if (!coordinator) throw new Error("Missing shell coordinator");
    await coordinator.enterLibrary(); await coordinator.select("candidate");
    navigate.mockClear();
    await coordinator.open("candidate", { fullMap: true });
    expect(loadLibraryReplay).toHaveBeenCalledWith("candidate");
    expect(loadState$.value.phase).toBe("ready");
    expect(coordinator.snapshot().nowPlaying?.title).toBe("Retained map");
    expect(coordinator.view.snapshot().route).toBe("library");
    expect(coordinator.view.snapshot().error).toBeNull();
    expect(coordinator.snapshot().openError?.replayId).toBe("candidate");
    expect(coordinator.fullMapRequest$.value).toBe(0);
    expect(navigate).not.toHaveBeenCalled();
    loadLibraryReplay.mockResolvedValueOnce(true);
    await coordinator.open("candidate", { fullMap: true });
    expect(coordinator.fullMapRequest$.value).toBe(1);
    expect(navigate).toHaveBeenLastCalledWith("/app/analyzer");
  });

  it("takes a screenshot on F12 from the shell, on whatever screen shows, and not while a clip is exporting", async () => {
    await mount();
    const press = () => {
      const event = new KeyboardEvent("keydown", { key: "F12", code: "F12", bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      return event;
    };
    await act(async () => void expect(press().defaultPrevented).toBe(true));
    expect(theater.analyzer.screenshotTaker.takeScreenshot).toHaveBeenCalledTimes(1);
    theater.analyzer.clipRecorder.isBusy = true;
    await act(async () => void press());
    expect(theater.analyzer.screenshotTaker.takeScreenshot).toHaveBeenCalledTimes(1);
    await unmount();
    press();
    expect(theater.analyzer.screenshotTaker.takeScreenshot).toHaveBeenCalledTimes(1);
  });

  it("loads one replay per IPC event through the StrictMode effect cycle and removes its listener", async () => {
    const register = jest.spyOn(ipcRenderer, "on");
    await mount();

    expect(register).toHaveBeenCalledTimes(2);
    expect(ipcRenderer.listenerCount("onManualReplayOpen")).toBe(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    await act(async () => {
      ipcRenderer.emit("onManualReplayOpen", {}, "example.osr");
    });
    expect(releaseActiveActivationFocus).toHaveBeenCalledTimes(1);
    expect(theater.analyzer.loadReplay).toHaveBeenCalledTimes(1);
    expect(theater.analyzer.loadReplay).toHaveBeenCalledWith("example.osr");

    await unmount();
    expect(ipcRenderer.listenerCount("onManualReplayOpen")).toBe(0);
    ipcRenderer.emit("onManualReplayOpen", {}, "after-unmount.osr");
    expect(theater.analyzer.loadReplay).toHaveBeenCalledTimes(1);
  });

  it("waits for the skin before startup navigation or a manual replay load", async () => {
    const initialization = deferred<void>();
    theater.common.initialize.mockReturnValue(initialization.promise);
    await mount();
    await act(async () => {
      ipcRenderer.emit("onManualReplayOpen", {}, "while-starting.osr");
    });
    expect(releaseActiveActivationFocus).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(theater.analyzer.loadReplay).not.toHaveBeenCalled();

    await act(async () => initialization.resolve());
    expect(navigate).toHaveBeenCalledWith("/app/analyzer");
    expect(theater.analyzer.loadReplay).toHaveBeenCalledTimes(1);
  });

  it("checks the osu! folder before loading the skin", async () => {
    const order: string[] = [];
    theater.analyzer.osuFolderService.hasValidOsuFolderSet.mockImplementation(async () => {
      order.push("folder");
      return true;
    });
    theater.common.initialize.mockImplementation(async () => {
      order.push("skin");
    });
    await mount();

    expect(order).toEqual(["folder", "skin"]);
    expect(navigate).toHaveBeenCalledWith("/app/analyzer");
  });

  it("shows the skin step while the skin loads", async () => {
    const initialization = deferred<void>();
    theater.common.initialize.mockReturnValue(initialization.promise);
    await mount();

    expect(document.querySelector('[data-testid="splash"]')?.textContent).toBe("Loading skin");
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => initialization.resolve());
    expect(navigate).toHaveBeenCalledWith("/app/analyzer");
  });

  it("moves the splash on to the skin step when a replay is opened while the folder check is pending", async () => {
    const folderCheck = deferred<boolean>();
    const initialization = deferred<void>();
    theater.analyzer.osuFolderService.hasValidOsuFolderSet.mockReturnValueOnce(folderCheck.promise);
    theater.common.initialize.mockReturnValue(initialization.promise);
    await mount();
    expect(document.querySelector('[data-testid="splash"]')?.textContent).not.toBe("Loading skin");
    await act(async () => {
      ipcRenderer.emit("onManualReplayOpen", {}, "while-folder-check.osr");
    });
    await act(async () => folderCheck.resolve(true));

    expect(document.querySelector('[data-testid="splash"]')?.textContent).toBe("Loading skin");
    // Startup itself still does not navigate; the replay open is waiting for the skin.
    expect(navigate).not.toHaveBeenCalled();
    expect(theater.analyzer.loadReplay).not.toHaveBeenCalled();
  });

  it("discards startup and manual replay work when unmounted during skin loading", async () => {
    const initialization = deferred<void>();
    theater.common.initialize.mockReturnValue(initialization.promise);
    await mount();
    ipcRenderer.emit("onManualReplayOpen", {}, "while-starting.osr");
    await unmount();
    await act(async () => initialization.resolve());

    expect(theater.analyzer.osuFolderService.hasValidOsuFolderSet).toHaveBeenCalledTimes(1); // startup's own check, which now runs before the skin
    expect(navigate).not.toHaveBeenCalled();
    expect(theater.analyzer.loadReplay).not.toHaveBeenCalled();
  });

  it("discards navigation when unmounted during osu! folder validation", async () => {
    const folderValidation = deferred<boolean>();
    theater.analyzer.osuFolderService.hasValidOsuFolderSet.mockReturnValue(folderValidation.promise);
    await mount();
    await unmount();
    await act(async () => folderValidation.resolve(false));

    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens setup when the osu! folder is invalid", async () => {
    theater.analyzer.osuFolderService.hasValidOsuFolderSet.mockResolvedValue(false);
    await mount();

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/setup");
  });

  it("uses the latest router callback without rerunning startup on a route change", async () => {
    await mount();
    const nextNavigate = jest.fn();
    (useNavigate as jest.Mock).mockReturnValue(nextNavigate);
    await act(async () =>
      root?.render(
        <StrictMode>
          <RewindApp />
        </StrictMode>,
      ),
    );

    expect(nextNavigate).not.toHaveBeenCalled();
    expect(theater.analyzer.osuFolderService.hasValidOsuFolderSet).toHaveBeenCalledTimes(1);
    await act(async () => {
      ipcRenderer.emit("onManualReplayOpen", {}, "next-route.osr");
    });
    expect(nextNavigate).toHaveBeenCalledWith("/app/analyzer");
  });

  it("accepts a protected file drag before filenames become available", async () => {
    await mount();
    const { event, dataTransfer } = dragEvent("dragover");
    expect(event.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(webUtils.getPathForFile).not.toHaveBeenCalled();
  });

  it("opens a dropped uppercase replay with its original native path exactly once", async () => {
    await mount();
    const file = new File(["replay"], "WinterBird - 雪 [Extra].OSR");
    const nativePath = "D:\\osu!\\Replays\\WinterBird - 雪 [Extra].OSR";
    (webUtils.getPathForFile as jest.Mock).mockReturnValue(nativePath);
    let drop: ReturnType<typeof dragEvent> | undefined;
    await act(async () => {
      drop = dragEvent("drop", [file]);
    });
    expect(drop?.event.defaultPrevented).toBe(true);
    expect(webUtils.getPathForFile).toHaveBeenCalledWith(file);
    expect(theater.analyzer.loadReplay).toHaveBeenCalledTimes(1);
    expect(theater.analyzer.loadReplay).toHaveBeenCalledWith(nativePath);
    expect(releaseActiveActivationFocus).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenLastCalledWith("/app/analyzer");

    await unmount();
    expect(dragEvent("drop", [file]).event.defaultPrevented).toBe(false);
    expect(dragEvent("dragover").event.defaultPrevented).toBe(false);
    expect(theater.analyzer.loadReplay).toHaveBeenCalledTimes(1);
  });

  it("opens the first valid replay in a multiple-file drop", async () => {
    await mount();
    await act(async () => {
      dragEvent("drop", [new File([], "image.png"), new File([], "first.osr"), new File([], "second.osr")]);
    });
    expect(theater.analyzer.loadReplay).toHaveBeenCalledTimes(1);
    expect(theater.analyzer.loadReplay).toHaveBeenCalledWith("D:/Replays/first.osr");
  });

  it("prevents unsupported files from replacing the page and leaves ordinary text dragging alone", async () => {
    await mount();
    expect(dragEvent("drop", [new File([], "image.png")]).event.defaultPrevented).toBe(true);
    expect(dragEvent("drop", [], ["text/plain"]).event.defaultPrevented).toBe(false);
    expect(dragEvent("dragover", [], ["text/plain"]).event.defaultPrevented).toBe(false);
    expect(theater.analyzer.loadReplay).not.toHaveBeenCalled();
    expect(webUtils.getPathForFile).not.toHaveBeenCalled();
  });

  it("skips non-disk or invalid File objects and can still open a subsequent valid file", async () => {
    await mount();
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    (webUtils.getPathForFile as jest.Mock)
      .mockReturnValueOnce("")
      .mockImplementationOnce(() => {
        throw Error("Not a native File");
      })
      .mockReturnValueOnce("D:/Replays/valid.osr");
    await act(async () => {
      dragEvent("drop", [new File([], "virtual.osr"), new File([], "invalid.osr"), new File([], "valid.osr")]);
    });
    expect(theater.analyzer.loadReplay).toHaveBeenCalledTimes(1);
    expect(theater.analyzer.loadReplay).toHaveBeenCalledWith("D:/Replays/valid.osr");
    expect(error).toHaveBeenCalled();
  });

  it("waits for initialization and keeps only the most recent replay request", async () => {
    const initialization = deferred<void>();
    theater.common.initialize.mockReturnValue(initialization.promise);
    await mount();
    dragEvent("drop", [new File([], "first.osr")]);
    ipcRenderer.emit("onManualReplayOpen", {}, "last.osr");
    expect(theater.analyzer.loadReplay).not.toHaveBeenCalled();
    await act(async () => initialization.resolve());
    expect(theater.analyzer.loadReplay).toHaveBeenCalledTimes(1);
    expect(theater.analyzer.loadReplay).toHaveBeenCalledWith("last.osr");
  });

  it("keeps setup visible instead of loading a dropped replay with an invalid osu! folder", async () => {
    theater.analyzer.osuFolderService.hasValidOsuFolderSet.mockResolvedValue(false);
    await mount();
    await act(async () => {
      dragEvent("drop", [new File([], "before-setup.osr")]);
    });
    expect(theater.analyzer.loadReplay).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenLastCalledWith("/setup");
  });

  it("does not let stale startup validation overwrite a later successful replay open", async () => {
    const folderValidation = deferred<boolean>();
    theater.analyzer.osuFolderService.hasValidOsuFolderSet.mockReturnValueOnce(folderValidation.promise);
    await mount();
    await act(async () => {
      dragEvent("drop", [new File([], "ready.osr")]);
    });
    expect(theater.analyzer.loadReplay).toHaveBeenCalledWith("D:/Replays/ready.osr");
    await act(async () => folderValidation.resolve(false));
    expect(navigate).not.toHaveBeenCalledWith("/setup");
    expect(navigate).toHaveBeenLastCalledWith("/app/analyzer");
  });

  it("discards a dropped replay when unmounted while initialization is pending", async () => {
    const initialization = deferred<void>();
    theater.common.initialize.mockReturnValue(initialization.promise);
    await mount();
    dragEvent("drop", [new File([], "pending.osr")]);
    await unmount();
    await act(async () => initialization.resolve());
    expect(theater.analyzer.loadReplay).not.toHaveBeenCalled();
  });
});
