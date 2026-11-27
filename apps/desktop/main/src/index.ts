import "./app/application-bootstrap";
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from "electron";
import { installNavigationGuards } from "./app/external-navigation";
import { setupEventListeners } from "./app/events";
import { windows } from "./app/windows";
import { join } from "path";
import { pathToFileURL } from "url";
import { environment } from "./environments/environment";
import log from "electron-log";
import { trackLibraryWindowLayout } from "./app/library/library-window-layout";
import {
  readWindowState,
  restoreWindowState,
  trackWindowState,
  WINDOW_STATE_FILE,
  writeWindowState,
} from "./app/window-state";

const { ELECTRON_IS_DEV } = process.env;

// TODO: Refactor ???
function isDevelopmentMode() {
  if (ELECTRON_IS_DEV) return true;
  return !environment.production;
}

let currentOsuFolder: string | null = null;

const rendererAppDevPort = 4200;

/**
 * The folder tree inside the Electron application will approximately look like as follows:
 *
 * ./index.js [THIS FILE]
 * ./frontend/(index.html|main.js|...)
 */
const desktopFrontendFile = (fileName: string) => join(__dirname, "frontend", fileName);

function registerAppShortcuts(frontend: BrowserWindow) {
  frontend.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat || input.alt) return;

    const key = input.key.toLowerCase();
    if (key === "f2" && !input.control && !input.meta && !input.shift) {
      event.preventDefault();
      void openReplay();
      return;
    }

    const commandModifier = process.platform === "darwin" ? input.meta : input.control;
    if (!commandModifier) return;

    let action: (() => void) | undefined;
    if (!input.shift && key === "w") action = () => frontend.close();
    if (!input.shift && key === "r") action = () => frontend.webContents.reload();
    if (input.shift && key === "r") action = () => frontend.webContents.reloadIgnoringCache();
    if (input.shift && key === "i") action = () => frontend.webContents.toggleDevTools();
    if (!action) return;

    event.preventDefault();
    action();
  });
}

function createFrontendWindow() {
  const stateFile = join(app.getPath("userData"), WINDOW_STATE_FILE);
  const savedState = readWindowState(stateFile);
  const restored = restoreWindowState(
    savedState,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
  );

  const isDev = isDevelopmentMode();
  const frontendURL = isDev
    ? `http://localhost:${rendererAppDevPort}`
    : pathToFileURL(desktopFrontendFile("index.html")).href;
  const frontend = new BrowserWindow({
    ...restored.state.bounds,
    minWidth: restored.minWidth,
    minHeight: restored.minHeight,
    // Chromium otherwise exposes its default white surface before the first
    // renderer frame. Keep the native window black throughout startup.
    backgroundColor: "#000000",
    show: false,
    webPreferences: {
      // `webSecurity` disabled while developing, otherwise we can't do hot reloading conveniently
      // https://stackoverflow.com/questions/50272451/electron-js-images-from-local-file-system
      webSecurity: !isDev,
      // This MUST be true in order for PageVisibility API to work.
      backgroundThrottling: true,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  frontend.setMenu(null);
  trackWindowState(frontend, restored.state, (state) => writeWindowState(stateFile, state), savedState);
  const stopLibraryWindowLayout = trackLibraryWindowLayout(
    frontend,
    (bounds) => screen.getDisplayMatching(bounds).workArea,
    frontendURL,
  );
  frontend.on("ready-to-show", () => {
    if (restored.state.maximized) frontend.maximize();
    windows.frontend?.show();
  });
  frontend.on("closed", () => {
    stopLibraryWindowLayout();
    windows.frontend = null;
    app.quit();
  });
  installNavigationGuards(frontend.webContents, frontendURL, (url) => shell.openExternal(url));
  registerAppShortcuts(frontend);

  ipcMain.on("osuFolderChanged", (_event, folder: string) => {
    currentOsuFolder = folder || null;
  });

  // In DEV mode we want to utilize hot reloading, therefore we are going to connect to the development server.
  // Therefore, `nx run frontend:serve` must be run first before this is executed.
  void frontend.loadURL(frontendURL);

  windows.frontend = frontend;
}

function handleAllWindowClosed() {
  // On macOS it's common that the application stays open and can be reactivated.
  if (process.platform !== "darwin") {
    app.quit();
  }
}

function handleReady() {
  const isDev = isDevelopmentMode();

  // Electron creates a default native menu when no application menu is set.
  // Explicitly remove it so Alt cannot reveal an obsolete File/View/Help bar.
  Menu.setApplicationMenu(null);

  console.log(
    "Booting Electron application with settings: ",
    JSON.stringify({
      isDev,
      appDataPath: app.getPath("appData"),
    }),
  );

  createFrontendWindow();
}

function handleActivate() {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (windows.frontend === null) {
    handleReady();
  }
}

(function main() {
  // Recommended way to use electron-log whenever we write console.log
  Object.assign(console, log.functions);

  // Make sure that it's only started once
  const isLocked = app.requestSingleInstanceLock();
  if (!isLocked) app.quit();

  // Required for `electron.Notification` to work
  app.setAppUserModelId("dev.hindsight.app");

  // https://peter.sh/experiments/chromium-command-line-switches/
  // So that the audio can't be stopped with media keys
  app.commandLine.appendSwitch("disable-features", "HardwareMediaKeyHandling");

  // Even though some GPUs might be "crashy" (see
  // https://chromium.googlesource.com/chromium/src/gpu/+/master/config/software_rendering_list.json), we still want to
  // use it instead of rendering a power-point presentation.
  app.commandLine.appendSwitch("ignore-gpu-blocklist");

  setupEventListeners();
  ipcMain.handle("runAppMenuAction", (_event, action: unknown) => {
    if (action !== "openReplay") throw new Error("Unknown application action");
    return openReplay();
  });

  app.on("window-all-closed", handleAllWindowClosed);
  app.on("ready", handleReady);
  app.on("activate", handleActivate);
})();

async function openReplay() {
  const frontend = windows.frontend;
  if (!currentOsuFolder) return;
  const { canceled, filePaths } = await dialog.showOpenDialog({
    defaultPath: join(currentOsuFolder, "Replays"),
    properties: ["openFile"],
    filters: [
      { name: "osu! Replay", extensions: ["osr"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (!canceled && filePaths.length > 0) frontend?.webContents.send("onManualReplayOpen", filePaths[0]);
}
