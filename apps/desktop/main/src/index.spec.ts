type MockListener = (...args: unknown[]) => void;

const mockAppListeners = new Map<string, MockListener>();
const mockIpcListeners = new Map<string, MockListener>();
const mockIpcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockWindowListeners = new Map<string, MockListener>();
const mockWebContentsListeners = new Map<string, MockListener>();

const mockSetApplicationMenu = jest.fn();
const mockBuildFromTemplate = jest.fn();
const mockSetMenu = jest.fn();
const mockSetMenuBarVisibility = jest.fn();
const mockShow = jest.fn();
const mockMaximize = jest.fn();
const mockReadWindowState = jest.fn();
const mockWriteWindowState = jest.fn();
const mockTrackWindowState = jest.fn();
const mockRestoreWindowState = jest.fn();
const mockStopLibraryWindowLayout = jest.fn();
const mockTrackLibraryWindowLayout: jest.Mock = jest.fn(() => mockStopLibraryWindowLayout);
const mockReload = jest.fn();
const mockReloadIgnoringCache = jest.fn();
const mockToggleDevTools = jest.fn();
const mockClose = jest.fn();
const mockShowOpenDialog = jest.fn().mockResolvedValue({ canceled: true, filePaths: [] });
const mockEnvironment = { production: false };
const mockJoin = jest.fn((...parts: string[]) => jest.requireActual("path").join(...parts));

const mockWebContents = {
  on: jest.fn((event: string, listener: MockListener) => mockWebContentsListeners.set(event, listener)),
  reload: mockReload,
  reloadIgnoringCache: mockReloadIgnoringCache,
  send: jest.fn(),
  setWindowOpenHandler: jest.fn(),
  toggleDevTools: mockToggleDevTools,
};

const mockFrontendWindow = {
  center: jest.fn(),
  close: mockClose,
  loadFile: jest.fn(),
  loadURL: jest.fn(),
  maximize: mockMaximize,
  on: jest.fn((event: string, listener: MockListener) => mockWindowListeners.set(event, listener)),
  setMenu: mockSetMenu,
  setMenuBarVisibility: mockSetMenuBarVisibility,
  show: mockShow,
  webContents: mockWebContents,
};

const mockBrowserWindow: jest.Mock = jest.fn(() => mockFrontendWindow);
const mockAppOn = jest.fn((event: string, listener: MockListener) => mockAppListeners.set(event, listener));
const mockIpcOn = jest.fn((event: string, listener: MockListener) => mockIpcListeners.set(event, listener));

jest.mock("electron", () => ({
  app: {
    commandLine: { appendSwitch: jest.fn() },
    getPath: jest.fn(() => "D:\\Rewind-test"),
    name: "Rewind",
    on: mockAppOn,
    quit: jest.fn(),
    requestSingleInstanceLock: jest.fn(() => true),
    setAppUserModelId: jest.fn(),
  },
  BrowserWindow: mockBrowserWindow,
  dialog: {
    showOpenDialog: mockShowOpenDialog,
  },
  ipcMain: {
    handle: jest.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      mockIpcHandlers.set(channel, handler),
    ),
    on: mockIpcOn,
  },
  Menu: {
    buildFromTemplate: mockBuildFromTemplate,
    setApplicationMenu: mockSetApplicationMenu,
  },
  screen: {
    getPrimaryDisplay: jest.fn(() => ({ workArea: { x: 0, y: 0, height: 900, width: 1600 } })),
    getAllDisplays: jest.fn(() => [{ workArea: { x: 0, y: 0, height: 900, width: 1600 } }]),
    getDisplayMatching: jest.fn(() => ({ workArea: { x: 0, y: 0, height: 900, width: 1600 } })),
  },
  shell: {
    openExternal: jest.fn(),
  },
}));

jest.mock("electron-log", () => ({ __esModule: true, default: { functions: {} } }));
jest.mock("./app/events", () => ({ setupEventListeners: jest.fn() }));
jest.mock("./app/library/library-window-layout", () => ({ trackLibraryWindowLayout: mockTrackLibraryWindowLayout }));
jest.mock("./app/window-state", () => ({
  WINDOW_STATE_FILE: "window-state.json",
  readWindowState: mockReadWindowState,
  restoreWindowState: mockRestoreWindowState,
  trackWindowState: mockTrackWindowState,
  writeWindowState: mockWriteWindowState,
}));
jest.mock("./environments/environment", () => ({ environment: mockEnvironment }));
jest.mock("path", () => ({ ...jest.requireActual("path"), join: mockJoin }));

interface ShortcutInput {
  alt: boolean;
  code: string;
  control: boolean;
  isAutoRepeat: boolean;
  isComposing: boolean;
  key: string;
  location: number;
  meta: boolean;
  modifiers: string[];
  shift: boolean;
  type: string;
}

function input(overrides: Partial<ShortcutInput>): ShortcutInput {
  return {
    alt: false,
    code: "",
    control: false,
    isAutoRepeat: false,
    isComposing: false,
    key: "",
    location: 0,
    meta: false,
    modifiers: [],
    shift: false,
    type: "keyDown",
    ...overrides,
  };
}

describe("Electron frontend window", () => {
  let originalElectronIsDev: string | undefined;

  beforeEach(() => {
    originalElectronIsDev = process.env.ELECTRON_IS_DEV;
    delete process.env.ELECTRON_IS_DEV;
    jest.resetModules();
    jest.clearAllMocks();
    mockAppListeners.clear();
    mockIpcListeners.clear();
    mockIpcHandlers.clear();
    mockWindowListeners.clear();
    mockWebContentsListeners.clear();
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    mockEnvironment.production = false;
    mockReadWindowState.mockReturnValue(undefined);
    mockRestoreWindowState.mockReturnValue({
      state: { bounds: { x: 0, y: 0, width: 1600, height: 900 }, maximized: true },
      minWidth: 1024,
      minHeight: 600,
    });
    mockJoin.mockImplementation((...parts: string[]) => jest.requireActual("path").join(...parts));
  });

  afterEach(() => {
    if (originalElectronIsDev === undefined) delete process.env.ELECTRON_IS_DEV;
    else process.env.ELECTRON_IS_DEV = originalElectronIsDev;
  });

  it.each([
    "Rewind # installation",
    "Rewind %2F installation",
    "Rewind %23 installation",
    "Rewind space 音楽",
    "Rewind # %2F %23 space 音楽",
  ])("loads the exact production renderer file under %s", (installationFolder) => {
    const actualPath = jest.requireActual("path");
    const { fileURLToPath, pathToFileURL } = jest.requireActual("url");
    const rendererFilePath = actualPath.resolve(__dirname, installationFolder, "frontend", "index.html");
    mockEnvironment.production = true;
    mockJoin.mockImplementation((...parts: string[]) =>
      parts[1] === "frontend" && parts[2] === "index.html" ? rendererFilePath : actualPath.join(...parts),
    );

    require("./index");
    mockAppListeners.get("ready")?.();

    expect(mockFrontendWindow.loadURL).toHaveBeenCalledTimes(1);
    const rendererURL = mockFrontendWindow.loadURL.mock.calls[0][0];
    expect(rendererURL).toBe(pathToFileURL(rendererFilePath).href);
    expect(fileURLToPath(rendererURL)).toBe(rendererFilePath);
    expect(new URL(rendererURL).hash).toBe("");
    expect(new URL(rendererURL).search).toBe("");
    expect(mockTrackLibraryWindowLayout).toHaveBeenCalledWith(mockFrontendWindow, expect.any(Function), rendererURL);
  });

  it("tracks route constraints against the current display and stops when the window closes", () => {
    require("./index");
    mockAppListeners.get("ready")?.();
    const bounds = { x: 100, y: 80, width: 800, height: 700 };
    expect(mockTrackLibraryWindowLayout).toHaveBeenCalledWith(mockFrontendWindow, expect.any(Function), "http://localhost:4200");
    const currentWorkArea = mockTrackLibraryWindowLayout.mock.calls[0][1] as (value: typeof bounds) => unknown;
    expect(currentWorkArea(bounds)).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
    expect(jest.requireMock("electron").screen.getDisplayMatching).toHaveBeenCalledWith(bounds);
    mockWindowListeners.get("closed")?.();
    expect(mockStopLibraryWindowLayout).toHaveBeenCalledTimes(1);
  });

  it("keeps the development server URL", () => {
    require("./index");
    mockAppListeners.get("ready")?.();

    expect(mockFrontendWindow.loadURL).toHaveBeenCalledWith("http://localhost:4200");
  });

  it("starts the first window maximized only when ready, without OS fullscreen", () => {
    require("./index");
    mockAppListeners.get("ready")?.();

    expect(mockReadWindowState).toHaveBeenCalledWith(
      jest.requireActual("path").join("D:\\Rewind-test", "window-state.json"),
    );
    expect(mockBrowserWindow.mock.calls[0][0]).toMatchObject({ width: 1600, height: 900, show: false });
    expect(mockBrowserWindow.mock.calls[0][0]).not.toHaveProperty("fullscreen");
    expect(mockMaximize).not.toHaveBeenCalled();
    mockWindowListeners.get("ready-to-show")?.();
    expect(mockMaximize).toHaveBeenCalledTimes(1);
    expect(mockMaximize.mock.invocationCallOrder[0]).toBeLessThan(mockShow.mock.invocationCallOrder[0]);
  });

  it.each([true, false])("restores normal bounds with remembered maximized=%s", (maximized) => {
    const saved = { bounds: { x: -1500, y: 120, width: 1200, height: 720 }, maximized };
    mockReadWindowState.mockReturnValue(saved);
    mockRestoreWindowState.mockReturnValue({ state: saved, minWidth: 1024, minHeight: 600 });
    require("./index");
    mockAppListeners.get("ready")?.();

    expect(mockBrowserWindow.mock.calls[0][0]).toMatchObject(saved.bounds);
    expect(mockFrontendWindow.center).not.toHaveBeenCalled();
    mockWindowListeners.get("ready-to-show")?.();
    expect(mockMaximize).toHaveBeenCalledTimes(maximized ? 1 : 0);
    expect(mockTrackWindowState).toHaveBeenCalledWith(mockFrontendWindow, saved, expect.any(Function), saved);
    mockTrackWindowState.mock.calls[0][2](saved);
    expect(mockWriteWindowState).toHaveBeenCalledWith(
      jest.requireActual("path").join("D:\\Rewind-test", "window-state.json"),
      saved,
    );
  });

  it("keeps the explicit development override for production builds", () => {
    mockEnvironment.production = true;
    process.env.ELECTRON_IS_DEV = "1";

    require("./index");
    mockAppListeners.get("ready")?.();

    expect(mockFrontendWindow.loadURL).toHaveBeenCalledWith("http://localhost:4200");
  });

  it("removes the native menu instead of hiding an Alt-revealable menu", () => {
    require("./index");
    mockAppListeners.get("ready")?.();

    expect(mockSetApplicationMenu.mock.calls).toEqual([[null]]);
    expect(mockBuildFromTemplate).not.toHaveBeenCalled();
    expect(mockBrowserWindow.mock.calls[0][0]).not.toHaveProperty("autoHideMenuBar");
    expect(mockSetMenu).toHaveBeenCalledWith(null);

    mockWindowListeners.get("ready-to-show")?.();
    mockIpcListeners.get("osuFolderChanged")?.({}, "D:\\osu!");

    expect(mockSetApplicationMenu.mock.calls).toEqual([[null]]);
    expect(mockSetMenuBarVisibility).not.toHaveBeenCalled();
    expect(mockShow).toHaveBeenCalledTimes(1);
  });

  it("preserves application shortcuts without an Electron menu template", () => {
    require("./index");
    mockAppListeners.get("ready")?.();
    mockIpcListeners.get("osuFolderChanged")?.({}, "D:\\osu!");
    const beforeInput = mockWebContentsListeners.get("before-input-event");
    expect(beforeInput).toBeDefined();

    const altEvent = { preventDefault: jest.fn() };
    beforeInput?.(altEvent, input({ alt: true, key: "Alt" }));
    expect(altEvent.preventDefault).not.toHaveBeenCalled();

    const reloadEvent = { preventDefault: jest.fn() };
    beforeInput?.(reloadEvent, input({ control: true, key: "r" }));
    expect(reloadEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockReload).toHaveBeenCalledTimes(1);

    const forceReloadEvent = { preventDefault: jest.fn() };
    beforeInput?.(forceReloadEvent, input({ control: true, shift: true, key: "r" }));
    expect(forceReloadEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockReloadIgnoringCache).toHaveBeenCalledTimes(1);

    const devToolsEvent = { preventDefault: jest.fn() };
    beforeInput?.(devToolsEvent, input({ control: true, shift: true, key: "i" }));
    expect(devToolsEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockToggleDevTools).toHaveBeenCalledTimes(1);

    const closeEvent = { preventDefault: jest.fn() };
    beforeInput?.(closeEvent, input({ control: true, key: "w" }));
    expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);

    const openEvent = { preventDefault: jest.fn() };
    beforeInput?.(openEvent, input({ key: "F2", code: "F2" }));
    expect(openEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockShowOpenDialog).toHaveBeenCalledTimes(1);
  });

  it.each([
    { key: "o", control: true },
    { key: "o", meta: true },
    { key: "F2", control: true },
    { key: "F2", meta: true },
    { key: "F2", shift: true },
    { key: "F2", alt: true },
    { key: "F2", isAutoRepeat: true },
    { key: "F2", type: "keyUp" },
  ])("does not open a replay for %j", (keys) => {
    require("./index");
    mockAppListeners.get("ready")?.();
    mockIpcListeners.get("osuFolderChanged")?.({}, "D:\\osu!");
    const event = { preventDefault: jest.fn() };
    mockWebContentsListeners.get("before-input-event")?.(event, input(keys));
    expect(mockShowOpenDialog).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps F2 disabled until the osu! folder is configured", () => {
    require("./index");
    mockAppListeners.get("ready")?.();
    mockWebContentsListeners.get("before-input-event")?.({ preventDefault: jest.fn() }, input({ key: "F2" }));
    expect(mockShowOpenDialog).not.toHaveBeenCalled();
  });

  it("opens the replay picker from the direct action and sends the selected replay", async () => {
    require("./index");
    mockAppListeners.get("ready")?.();
    mockIpcListeners.get("osuFolderChanged")?.({}, "D:\\osu!");
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["D:\\osu!\\Replays\\example.osr"] });
    const openAction = mockIpcHandlers.get("runAppMenuAction");
    expect(openAction).toBeDefined();

    await openAction?.({}, "openReplay");

    expect(mockShowOpenDialog).toHaveBeenCalledWith({
      defaultPath: jest.requireActual("path").join("D:\\osu!", "Replays"),
      properties: ["openFile"],
      filters: [
        { name: "osu! Replay", extensions: ["osr"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    expect(mockWebContents.send).toHaveBeenCalledWith("onManualReplayOpen", "D:\\osu!\\Replays\\example.osr");
  });

  it.each(["openOsuFolder", "documentation", "close", "toggleDevTools", null])(
    "rejects removed or unknown renderer actions: %s",
    (action) => {
      require("./index");
      mockAppListeners.get("ready")?.();
      const openAction = mockIpcHandlers.get("runAppMenuAction");
      expect(openAction).toBeDefined();

      expect(() => openAction?.({}, action)).toThrow("Unknown application action");
      expect(mockShowOpenDialog).not.toHaveBeenCalled();
      expect(mockClose).not.toHaveBeenCalled();
      expect(mockToggleDevTools).not.toHaveBeenCalled();
    },
  );
});
