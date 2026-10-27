import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ClipExportManager, ClipExportUI } from "./clip-export";
import { setupEventListeners } from "./events";
import { registerLibraryRuntime } from "./library/library-runtime";
import { ReplayReadOwner } from "./replay-read-owner";

jest.mock("electron", () => ({
  app: { once: jest.fn(), on: jest.fn(), quit: jest.fn(), getPath: jest.fn(() => "Videos") },
  BrowserWindow: { fromWebContents: jest.fn() },
  dialog: { showSaveDialog: jest.fn() },
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  shell: { openPath: jest.fn(), showItemInFolder: jest.fn() },
}));
jest.mock("@rewind/osu-local/osr-reader", () => ({ read: jest.fn() }));
jest.mock("./beatmap-lookup", () => ({ lookupBeatmap: jest.fn() }));
jest.mock("./performance-worker");
jest.mock("./clip-export");
jest.mock("./replay-read-owner");
jest.mock("./library/library-runtime", () => ({
  registerLibraryRuntime: jest.fn(() => ({ close: jest.fn().mockResolvedValue(undefined) })),
}));
// The real stat, but a spy: a test can make the folder check hang or reject.
jest.mock("fs/promises", () => {
  const actual = jest.requireActual("fs/promises");
  return { ...actual, stat: jest.fn(actual.stat) };
});

beforeEach(() => jest.clearAllMocks());

function setup() {
  setupEventListeners();
  const constructor = ClipExportManager as jest.MockedClass<typeof ClipExportManager>;
  const manager = constructor.mock.instances[0] as jest.Mocked<ClipExportManager>;
  manager.dispose.mockResolvedValue(undefined);
  const ui = constructor.mock.calls[0][0] as ClipExportUI;
  const handlers = new Map((ipcMain.handle as jest.Mock).mock.calls.map(([name, handler]) => [name, handler]));
  const hooks = (app.on as jest.Mock).mock.calls.filter(([name]) => name === "before-quit");
  const library = jest.mocked(registerLibraryRuntime).mock.results[0].value as { close: jest.Mock };
  const reader = jest.mocked(ReplayReadOwner).mock.instances[0];
  jest.mocked(reader.close).mockResolvedValue(undefined);
  return { manager, ui, handlers, library, reader, quit: hooks[hooks.length - 1][1] };
}

function observeQuit(): Promise<void> {
  return new Promise(resolve => { jest.mocked(app.quit).mockImplementationOnce(resolve); });
}

it("uses the requesting sender as the authority for every clip IPC method", async () => {
  const { manager, handlers } = setup();
  const sender = { id: 41 };
  const input = { fileName: "test.webm", extension: "webm" };
  const bytes = new ArrayBuffer(4);
  await handlers.get("beginClipExport")({ sender }, input);
  expect(manager.begin).toHaveBeenCalledWith(sender, input);
  await handlers.get("appendClipExport")({ sender }, "session", 3, bytes);
  expect(manager.append).toHaveBeenCalledWith(41, "session", 3, bytes);
  await handlers.get("finishClipExport")({ sender }, "session");
  await handlers.get("abortClipExport")({ sender }, "session");
  await handlers.get("openExportedClip")({ sender }, "saved.webm");
  await handlers.get("showExportedClip")({ sender }, "saved.webm");
  expect(manager.finish).toHaveBeenCalledWith(41, "session");
  expect(manager.abort).toHaveBeenCalledWith(41, "session");
  expect(manager.openExported).toHaveBeenCalledWith(41, "saved.webm");
  expect(manager.showExported).toHaveBeenCalledWith(41, "saved.webm");
});

it.each(["mp4", "webm"] as const)(
  "offers the actual recorder %s extension in a parented save dialog",
  async (extension) => {
    const { ui } = setup();
    const parent = {};
    (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue(parent);
    (dialog.showSaveDialog as jest.Mock).mockResolvedValue({ canceled: false, filePath: "selected" });
    expect(await ui.selectDestination({ id: 41 } as never, { fileName: `clip.${extension}`, extension })).toBe(
      "selected",
    );
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      parent,
      expect.objectContaining({
        defaultPath: join("Videos", `clip.${extension}`),
        filters: [{ name: extension === "mp4" ? "MP4 video" : "WebM video", extensions: [extension] }],
        properties: expect.arrayContaining(["showOverwriteConfirmation"]),
      }),
    );
  },
);

describe("the save dialog's folder", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rewind-save-folder-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function defaultPathFor(directory: string | undefined) {
    const { ui } = setup();
    (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue({});
    (dialog.showSaveDialog as jest.Mock).mockResolvedValue({ canceled: true });
    await ui.selectDestination({ id: 41 } as never, { fileName: "clip.mp4", extension: "mp4", directory });
    expect(dialog.showSaveDialog).toHaveBeenCalledTimes(1);
    const options = (dialog.showSaveDialog as jest.Mock).mock.calls[0][1];
    return { options, defaultPath: options.defaultPath as string };
  }

  it("opens in the requested folder when it is a directory, with the same file name and options", async () => {
    const { options, defaultPath } = await defaultPathFor(root);
    expect(defaultPath).toBe(join(root, "clip.mp4"));
    expect(options).toMatchObject({
      title: "Export replay clip",
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
  });

  it("opens in the Videos folder when the folder no longer exists, creating nothing", async () => {
    const missing = join(root, "gone");
    expect((await defaultPathFor(missing)).defaultPath).toBe(join("Videos", "clip.mp4"));
    expect(() => rmSync(missing)).toThrow();
  });

  it("opens in the Videos folder when the path is a file", async () => {
    const file = join(root, "not-a-folder.txt");
    writeFileSync(file, "x");
    expect((await defaultPathFor(file)).defaultPath).toBe(join("Videos", "clip.mp4"));
  });

  it("opens in the Videos folder when no folder is requested", async () => {
    expect((await defaultPathFor(undefined)).defaultPath).toBe(join("Videos", "clip.mp4"));
  });

  describe("when the folder check does not answer", () => {
    const CHECK_TIMEOUT_MS = 1500;
    // Never reached: `stat` is replaced in these tests.
    let request: { fileName: string; extension: "mp4"; directory: string };
    beforeEach(() => {
      request = { fileName: "clip.mp4", extension: "mp4", directory: join(root, "share") };
      jest.useFakeTimers();
      (BrowserWindow.fromWebContents as jest.Mock).mockReturnValue({});
      (dialog.showSaveDialog as jest.Mock).mockResolvedValue({ canceled: true });
    });
    afterEach(() => jest.useRealTimers());

    it("falls back to Videos when the folder check does not answer within 1.5 s", async () => {
      jest.mocked(stat).mockImplementationOnce(() => new Promise(() => undefined));
      const { ui } = setup();
      const finished = ui.selectDestination({ id: 41 } as never, request);
      await jest.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS - 1);
      expect(dialog.showSaveDialog).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(dialog.showSaveDialog).toHaveBeenCalledTimes(1);
      expect((dialog.showSaveDialog as jest.Mock).mock.calls[0][1].defaultPath).toBe(join("Videos", "clip.mp4"));
      await expect(finished).resolves.toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    });

    it("does not block: the dialog request is pending, not finished, while the check is outstanding", async () => {
      let answer!: (value: { isDirectory(): boolean }) => void;
      jest.mocked(stat).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve as typeof answer;
          }),
      );
      const { ui } = setup();
      let settled = false;
      const finished = ui.selectDestination({ id: 41 } as never, request).then(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);
      expect(dialog.showSaveDialog).not.toHaveBeenCalled();
      answer({ isDirectory: () => true });
      await finished;
      expect((dialog.showSaveDialog as jest.Mock).mock.calls[0][1].defaultPath).toBe(
        join(request.directory, "clip.mp4"),
      );
      // The answer came first, so the timer is gone.
      expect(jest.getTimerCount()).toBe(0);
    });

    it("a late rejection after the timeout is swallowed", async () => {
      let fail!: (reason: Error) => void;
      jest.mocked(stat).mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      );
      const unhandled = jest.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const { ui } = setup();
        const finished = ui.selectDestination({ id: 41 } as never, request);
        await jest.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
        await finished;
        expect((dialog.showSaveDialog as jest.Mock).mock.calls[0][1].defaultPath).toBe(join("Videos", "clip.mp4"));
        fail(new Error("ETIMEDOUT"));
        jest.useRealTimers();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    it("falls back to Videos when the check rejects at once", async () => {
      jest.mocked(stat).mockRejectedValueOnce(new Error("ENOENT"));
      const { ui } = setup();
      await ui.selectDestination({ id: 41 } as never, request);
      expect((dialog.showSaveDialog as jest.Mock).mock.calls[0][1].defaultPath).toBe(join("Videos", "clip.mp4"));
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

it("waits for unfinished exports to drain before allowing application quit", async () => {
  const { manager, quit } = setup();
  Object.defineProperty(manager, "hasWork", { configurable: true, value: true });
  let drained!: () => void;
  manager.dispose.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        drained = resolve;
      }),
  );
  const event = { preventDefault: jest.fn() };
  const didQuit = observeQuit();
  quit(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(app.quit).not.toHaveBeenCalled();
  drained();
  await didQuit;
  expect(app.quit).toHaveBeenCalledTimes(1);
});

it("drains library ownership even without pending file work, then lets the resumed quit proceed", async () => {
  const { manager, library, quit } = setup();
  Object.defineProperty(manager, "hasWork", { configurable: true, value: false });
  let drained!: () => void;
  library.close.mockImplementationOnce(() => new Promise<void>((resolve) => { drained = resolve; }));
  const event = { preventDefault: jest.fn() };
  const didQuit = observeQuit();
  quit(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(manager.dispose).toHaveBeenCalledTimes(1);
  expect(library.close).toHaveBeenCalledTimes(1);
  expect(app.quit).not.toHaveBeenCalled();
  drained();
  await didQuit;
  expect(app.quit).toHaveBeenCalledTimes(1);
  const resumed = { preventDefault: jest.fn() };
  quit(resumed);
  expect(resumed.preventDefault).not.toHaveBeenCalled();
  expect(manager.dispose).toHaveBeenCalledTimes(1);
  expect(library.close).toHaveBeenCalledTimes(1);
});

it("keeps quit blocked until exports, library and the reader have all actually drained", async () => {
  const { manager, library, reader, quit } = setup();
  function deferredDrain() {
    let release!: () => void;
    const state = { complete: false };
    const promise = new Promise<void>(resolve => { release = resolve; }).then(() => { state.complete = true; });
    return { state, promise, release };
  }
  const exports = deferredDrain(), resources = deferredDrain(), replay = deferredDrain();
  manager.dispose.mockReturnValueOnce(exports.promise);
  library.close.mockReturnValueOnce(resources.promise);
  jest.mocked(reader.close).mockReturnValueOnce(replay.promise);
  const didQuit = new Promise<void>((resolve, reject) => {
    jest.mocked(app.quit).mockImplementationOnce(() => {
      if (![exports, resources, replay].every(drain => drain.state.complete)) reject(new Error("Quit preceded an owned drain"));
      else resolve();
    });
  });
  const completed = expect(didQuit).resolves.toBeUndefined();
  const event = { preventDefault: jest.fn() }; quit(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(manager.dispose).toHaveBeenCalledTimes(1); expect(library.close).toHaveBeenCalledTimes(1); expect(reader.close).toHaveBeenCalledTimes(1);
  expect(app.quit).not.toHaveBeenCalled();
  exports.release(); await exports.promise; expect(app.quit).not.toHaveBeenCalled();
  resources.release(); await resources.promise; expect(app.quit).not.toHaveBeenCalled();
  replay.release(); await completed; expect(app.quit).toHaveBeenCalledTimes(1);
  const resumed = { preventDefault: jest.fn() }; quit(resumed);
  expect(resumed.preventDefault).not.toHaveBeenCalled(); expect(reader.close).toHaveBeenCalledTimes(1);
});
