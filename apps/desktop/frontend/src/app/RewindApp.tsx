import { Outlet, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { SplashScreen } from "./screens/splash/SplashScreen";
import { HomeScreen } from "./screens/home/HomeScreen";
import { Box } from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
import { useTheaterContext } from "./providers/TheaterProvider";
import { Analyzer } from "./screens/analyzer/Analyzer";
import { SetupScreen } from "./screens/setup/SetupScreen";
import { ScreenshotProvider, useScreenshot } from "./hooks/screenshot";
import { releaseActiveActivationFocus } from "./utils/focus";
import type { StartupProgress } from "./services/startup/startup-steps";
import { LibraryDemandBridge } from "./services/library/LibraryDemandBridge";
import { LibraryHostProvider, LibraryScreenSwitch, useLibraryUi } from "./components/replay-library-host";
import { LibraryUiCoordinator } from "./services/library/library-ui-coordinator";
import { LibraryPassiveResourceClient } from "./services/library/library-passive-resource-client";
import { frontendAPI } from "./api";

function NormalView() {
  return (
    <Box sx={{ width: "100vw", height: "100vh", overflow: "hidden" }}>
      <Outlet />
    </Box>
  );
}
function ViewerLibraryShell() {
  const location = useLocation(),
    library = useLibraryUi(),
    active = location.pathname === "/app/library";
  useEffect(() => {
    if (active && library?.view.snapshot().route !== "library") void library?.enterLibrary();
  }, [active, library]);
  return (
    <LibraryScreenSwitch libraryActive={active}>
      <Analyzer />
    </LibraryScreenSwitch>
  );
}
function LibraryCaptureGuard({ library }: { library: LibraryUiCoordinator }) {
  const { capturing } = useScreenshot();
  useEffect(() => library.setNavigationLocked(capturing), [capturing, library]);
  return null;
}

export function RewindApp() {
  const navigate = useNavigate();
  const location = useLocation();
  const theater = useTheaterContext();
  const navigateRef = useRef(navigate);
  const [startup, setStartup] = useState<StartupProgress>({ stepIndex: 0 });
  const libraryUi = useMemo(() => {
    let sidebarShown = true;
    try {
      const saved = JSON.parse(window.localStorage.getItem("library-layout") ?? "null");
      if (typeof saved?.sidebarShown === "boolean") sidebarShown = saved.sidebarShown;
    } catch {
      /* Invalid preference uses the documented default. */
    }
    const resources = new LibraryPassiveResourceClient({
      resource: (request) => frontendAPI.libraryPassiveResource(request),
    });
    return new LibraryUiCoordinator(theater.library, {
      navigate: (path) => navigateRef.current(path),
      sidebarShown,
      persistSidebar: (shown) => window.localStorage.setItem("library-layout", JSON.stringify({ sidebarShown: shown })),
      canNavigate: () => !theater.analyzer.clipRecorder.isBusy,
      viewerVisibility: (visible) => {
        theater.analyzer.setViewerVisible?.(visible);
      },
      readPlaybackPosition: () => theater.analyzer.gameClock.timeElapsedInMs,
      readResources: (artworkIds, stripReplayId, signal, onUpdate) => resources.update({ artworkIds, stripReplayId, onUpdate }, signal),
      revealFile: (id) => resources.revealFile(id),
      invalidateResources: (options) => resources.invalidate(options),
      disposeResources: () => resources.dispose(),
      openReplay: async (id) => {
        const opened = await theater.analyzer.scenarioManager.loadLibraryReplay(id);
        if (!opened)
          throw new Error("The replay could not be opened. Check its source and beatmap availability.");
      },
    });
  }, [theater]);
  useEffect(() => {
    const scenario = theater.analyzer.scenarioManager;
    if (!scenario?.loadState$) return;
    // ScenarioManager publishes the verified viewer URL while loading, then a
    // compact ready state. Keep the reference; ownership remains with the viewer.
    let artUrl = scenario.loadState$.value.backgroundUrl;
    const subscription = scenario.loadState$.subscribe((state) => {
      if (
        state.phase === "idle" ||
        state.phase === "failed" ||
        (state.phase === "loading" && state.step === "read-replay")
      )
        artUrl = undefined;
      else if (state.backgroundUrl !== undefined) artUrl = state.backgroundUrl;
      if (state.phase === "ready") {
        const map = scenario.getBeatmapMetadata();
        libraryUi.setNowPlayingMetadata({
          id: libraryUi.view.snapshot().nowPlayingId ?? "current-replay",
          title: map?.title ?? "Current replay",
          artUrl,
        });
      } else if (state.phase === "idle") libraryUi.setExternalReplay();
      else if (state.phase === "failed") libraryUi.setNowPlayingMetadata();
    });
    return () => subscription.unsubscribe();
  }, [theater, libraryUi]);

  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    let active = true;
    let replayRequest = 0;
    const openReplay = async (file: string) => {
      const request = ++replayRequest;
      // Covers both replay buttons and the main-process F2 shortcut. Without
      // this, Space can activate the replay-open command again after the native
      // picker returns instead of reaching the playback shortcut.
      releaseActiveActivationFocus();
      try {
        await theater.common.initialize();
        if (!active || request !== replayRequest) return;
        const ready = await theater.analyzer.osuFolderService.hasValidOsuFolderSet();
        if (!active || request !== replayRequest) return;
        if (!ready) {
          navigateRef.current("/setup");
          return;
        }
        navigateRef.current("/app/analyzer");
        libraryUi.setExternalReplay();
        libraryUi.view.showViewer();
        await theater.analyzer.loadReplay(file);
      } catch (error) {
        if (active) console.error("Could not open replay", error);
      }
    };
    const onManualReplayOpen = (_event: IpcRendererEvent, file: string) => void openReplay(file);
    ipcRenderer.on("onManualReplayOpen", onManualReplayOpen);

    const isFileDrag = (event: DragEvent) =>
      event.dataTransfer &&
      (Array.from(event.dataTransfer.types).includes("Files") || event.dataTransfer.files.length > 0);
    const onDragOver = (event: DragEvent) => {
      // Filenames are hidden while dragging. The Files type still lets the
      // window accept native drops without interfering with text selection.
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      // Also cancel unsupported file drops: Chromium must not navigate away
      // from Rewind to display the dropped file.
      event.preventDefault();
      for (const file of Array.from(event.dataTransfer?.files ?? [])) {
        if (!/\.osr$/i.test(file.name)) continue;
        try {
          // File.path was removed in modern Electron. Resolve the native path
          // synchronously while the drop's File objects are accessible.
          const path = webUtils.getPathForFile(file);
          if (!path || !/\.osr$/i.test(path)) continue;
          void openReplay(path);
          return;
        } catch (error) {
          console.error("Could not read dropped replay path", error);
        }
      }
    };
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);

    async function initialize() {
      // React StrictMode mounts, cleans up and mounts again in one tick. Yielding
      // once lets the discarded first run stop here instead of reading the osu!
      // folder a second time.
      await Promise.resolve();
      if (!active || replayRequest > 0) return;

      // Step 0: the osu! folder. Step 1: the skin, which replay rendering depends
      // on. Finish both before mounting the analyzer so auto-opened and manually
      // opened replays cannot begin with an empty SkinHolder.
      const hasValidOsuFolder = await theater.analyzer.osuFolderService.hasValidOsuFolderSet();
      if (!active) return;
      setStartup({ stepIndex: 1 });
      if (replayRequest > 0) return;

      await theater.common.initialize();
      if (!active || replayRequest > 0) return;
      setStartup({ stepIndex: 2 });

      if (!hasValidOsuFolder) {
        console.log("osu! folder was not set, redirecting to the setup screen.");
        navigateRef.current("/setup");
      } else {
        console.log(`osu! folder = ${theater.analyzer.osuFolderService.getOsuFolder()}`);
        console.log(`osu!/Songs folder = ${theater.analyzer.osuFolderService.songsFolder$.getValue()}`);
        console.log(`osu!/Replays folder = ${theater.analyzer.osuFolderService.replaysFolder$.getValue()}`);
        navigateRef.current("/app/analyzer");
      }
    }
    void initialize().catch((error) => {
      if (active) console.error("Could not initialize Hindsight", error);
    });

    return () => {
      active = false;
      ipcRenderer.removeListener("onManualReplayOpen", onManualReplayOpen);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, [theater, libraryUi]);

  return (
    // F12 takes a screenshot on every screen, so its listener lives above all of them.
    <ScreenshotProvider
      takeScreenshot={() => theater.library.foreground(() => theater.analyzer.screenshotTaker.takeScreenshot())}
      isBusy={() => theater.analyzer.clipRecorder.isBusy}
    >
      <LibraryDemandBridge />
      <LibraryCaptureGuard library={libraryUi} />
      <LibraryHostProvider coordinator={libraryUi} viewerActive={location.pathname === "/app/analyzer"}>
        <Routes>
          <Route index element={<SplashScreen progress={startup} />} />
          <Route path={"setup"} element={<SetupScreen />} />
          <Route path={"app"} element={<NormalView />}>
            <Route path={"home"} element={<HomeScreen />} />
            <Route path={"*"} element={<ViewerLibraryShell />} />
          </Route>
        </Routes>
      </LibraryHostProvider>
    </ScreenshotProvider>
  );
}
