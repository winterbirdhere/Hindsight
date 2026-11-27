import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { readReplayWithSource, REPLAY_SOURCE_FILE } from "./replay-source";
import { lookupBeatmap } from "./beatmap-lookup";
import { join } from "path";
import { PerformanceWorker } from "./performance-worker";
import { PERFORMANCE_CALCULATE_CHANNEL, PERFORMANCE_CANCEL_CHANNEL } from "@rewind/osu-performance/protocol";
import { stat } from "fs/promises";
import { ClipExportManager } from "./clip-export";
import { FFmpegClipFinalizer } from "./clip-finalizer";
import { FFmpegClipFrameEncoder } from "./clip-frame-encoder";
import { registerLibraryRuntime } from "./library/library-runtime";
import { createQuitBarrier } from "./quit-barrier";
import { ReplayReadOwner } from "./replay-read-owner";

async function userSelectDirectory(defaultPath: string) {
  const { canceled, filePaths } = await dialog.showOpenDialog({ defaultPath, properties: ["openDirectory"] });
  if (canceled || filePaths.length === 0) {
    return null;
  } else {
    return filePaths[0];
  }
}

async function userSelectFile(defaultPath: string) {
  const { canceled, filePaths } = await dialog.showOpenDialog({ defaultPath, properties: ["openFile"] });
  if (canceled || filePaths.length === 0) {
    return null;
  } else {
    return filePaths[0];
  }
}

async function userSelectReplayFile(defaultPath: string) {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    defaultPath,
    properties: ["openFile"],
    filters: [
      { name: "osu! Replay", extensions: ["osr"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return canceled || filePaths.length === 0 ? null : filePaths[0];
}

/** How long the saved folder gets to answer before the dialog opens in Videos instead. */
const CLIP_FOLDER_CHECK_TIMEOUT_MS = 1500;

/**
 * Where the clip's save dialog opens: the requested folder when it is a directory, otherwise the Videos folder.
 * The check is asynchronous and bounded: a saved folder on an unreachable share must not freeze the main thread
 * or hold the dialog back. Never throws; a check that fails after the timeout has won is handled by the race.
 */
async function clipDialogFolder(
  directory: string | undefined,
  videosFolder: string,
  statFolder: (path: string) => Promise<{ isDirectory(): boolean }> = stat,
): Promise<string> {
  if (!directory) return videosFolder;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), CLIP_FOLDER_CHECK_TIMEOUT_MS);
    });
    const stats = await Promise.race([statFolder(directory), timeout]);
    return stats?.isDirectory() ? directory : videosFolder;
  } catch {
    return videosFolder;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getPath(type: string) {
  switch (type) {
    case "appData":
      return app.getPath("appData");
    case "userData":
      return app.getPath("userData");
    case "logs":
      return app.getPath("logs");
    case "appResources":
      return app.isPackaged ? process.resourcesPath : join(process.cwd(), "resources");
  }
  return "";
}

export function setupEventListeners() {
  const nativeExecutable = () =>
    join(
      app.isPackaged ? process.resourcesPath : process.cwd(),
      app.isPackaged ? "performance-engine" : "resources/performance-engine",
      process.platform === "win32" ? "RewindPerformance.exe" : "RewindPerformance",
    );
  const performanceWorker = new PerformanceWorker(nativeExecutable);
  const replayReads = new ReplayReadOwner();
  const replayWindows = new Set<number>();
  const library = registerLibraryRuntime(nativeExecutable);
  const observedWindows = new Set<number>();
  ipcMain.handle(PERFORMANCE_CALCULATE_CHANNEL, (event, request) => {
    const owner = event.sender.id;
    if (!observedWindows.has(owner)) {
      observedWindows.add(owner);
      const sender = event.sender;
      const cancel = () => performanceWorker.cancel(owner);
      const cancelOnNavigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !isInPlace) cancel();
      };
      sender.on("did-start-navigation", cancelOnNavigation);
      sender.on("render-process-gone", cancel);
      sender.once("destroyed", () => {
        performanceWorker.cancel(owner);
        sender.removeListener("did-start-navigation", cancelOnNavigation);
        sender.removeListener("render-process-gone", cancel);
        observedWindows.delete(owner);
      });
    }
    return performanceWorker.calculate(owner, request);
  });
  ipcMain.on(PERFORMANCE_CANCEL_CHANNEL, (event) => performanceWorker.cancel(event.sender.id));
  const clipEncoderExecutable = () =>
    join(
      app.isPackaged ? process.resourcesPath : join(process.cwd(), "resources"),
      "clip-media",
      "win-x64",
      "ffmpeg.exe",
    );
  const clipExports = new ClipExportManager(
    {
      selectDestination: async (owner, request) => {
        const parent = BrowserWindow.fromWebContents(owner as Electron.WebContents);
        const options: Electron.SaveDialogOptions = {
          title: "Export replay clip",
          defaultPath: join(await clipDialogFolder(request.directory, app.getPath("videos")), request.fileName),
          filters: [
            { name: request.extension === "mp4" ? "MP4 video" : "WebM video", extensions: [request.extension] },
          ],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        };
        const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
        return result.canceled || !result.filePath ? null : result.filePath;
      },
      openPath: (path) => shell.openPath(path),
      showItemInFolder: (path) => shell.showItemInFolder(path),
    },
    undefined,
    new FFmpegClipFinalizer(clipEncoderExecutable),
    (video, output, signal) => new FFmpegClipFrameEncoder(video, output, signal, clipEncoderExecutable),
  );
  ipcMain.handle("beginClipExport", (event, request) => clipExports.begin(event.sender, request));
  ipcMain.handle("appendClipExport", (event, id, sequence, data) =>
    clipExports.append(event.sender.id, id, sequence, data),
  );
  ipcMain.handle("appendClipExportFrame", (event, id, frameIndex, offset, data) =>
    clipExports.appendFrame(event.sender.id, id, frameIndex, offset, data),
  );
  ipcMain.handle("finishClipExport", (event, id) => clipExports.finish(event.sender.id, id));
  ipcMain.handle("abortClipExport", (event, id) => clipExports.abort(event.sender.id, id));
  ipcMain.handle("openExportedClip", (event, path) => clipExports.openExported(event.sender.id, path));
  ipcMain.handle("showExportedClip", (event, path) => clipExports.showExported(event.sender.id, path));
  app.on("before-quit", createQuitBarrier(() => performanceWorker.dispose(),
    () => [clipExports.dispose(), library.close(), replayReads.close()], () => app.quit(),
    error => console.error("Could not finish application cleanup", error)));
  ipcMain.handle("captureScreenshot", async (event) => {
    const sender = event.sender;
    if (sender.isDestroyed()) throw new Error("The replay window is closed.");
    // Capture the compositor, including both the WebGL playfield and the DOM HUD.
    const image = await sender.capturePage();
    if (sender.isDestroyed() || image.isEmpty()) throw new Error("Could not capture the replay window.");
    return image.toPNG();
  });
  ipcMain.handle("getPath", (event, type) => getPath(type));
  ipcMain.handle("selectDirectory", (event, defaultPath) => userSelectDirectory(defaultPath));
  ipcMain.handle("selectFile", (event, defaultPath) => userSelectFile(defaultPath));
  ipcMain.handle("selectReplayFile", (event, defaultPath) => userSelectReplayFile(defaultPath));
  ipcMain.handle("getPlatform", () => process.platform);
  ipcMain.handle("getAppVersion", () => app.getVersion());
  ipcMain.handle("lookupBeatmap", (_event, checksum) => lookupBeatmap(checksum, app.getVersion()));
  ipcMain.handle("reboot", () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle("readOsr", async (event, filePath, configuredOsuFolder) => {
    const sender = event.sender;
    const frame = event.senderFrame;
    const assertCurrentFrame = () => {
      if (sender.isDestroyed()) throw new Error("The replay window is closed.");
      if (!frame || frame !== sender.mainFrame) throw new Error("Replay read requires the current main frame.");
    };
    // Reject old-document/subframe IPC before it can replace the current owner's work.
    assertCurrentFrame();
    if (!replayWindows.has(sender.id)) {
      replayWindows.add(sender.id);
      const cancel = () => replayReads.cancel(sender.id);
      const navigate = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !isInPlace) cancel();
      };
      sender.on("did-start-navigation", navigate); sender.on("render-process-gone", cancel);
      sender.once("destroyed", () => {
        cancel(); sender.removeListener("did-start-navigation", navigate); sender.removeListener("render-process-gone", cancel);
        replayWindows.delete(sender.id);
      });
    }
    const origins = join(app.getPath("userData"), REPLAY_SOURCE_FILE);
    return replayReads.read(sender.id, async (read, signal) => {
      assertCurrentFrame();
      const result = await readReplayWithSource(filePath, origins,
        typeof configuredOsuFolder === "string" && configuredOsuFolder ? configuredOsuFolder : undefined, { read, signal });
      signal.throwIfAborted();
      assertCurrentFrame();
      return result;
    });
  });
}
