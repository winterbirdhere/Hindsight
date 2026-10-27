import { EventEmitter } from "events";
import { join } from "path";
import { app, ipcMain } from "electron";
import { setupEventListeners } from "./events";
import { PerformanceWorker } from "./performance-worker";
import { ClipExportManager } from "./clip-export";
import { readReplayWithSource, REPLAY_SOURCE_FILE } from "./replay-source";
import { PERFORMANCE_CALCULATE_CHANNEL, PERFORMANCE_CANCEL_CHANNEL } from "@rewind/osu-performance/protocol";
import { Worker } from "worker_threads";

jest.mock("electron", () => ({
  app: { once: jest.fn(), on: jest.fn(), quit: jest.fn(), isPackaged: false, getPath: jest.fn(() => "user-data") },
  dialog: {},
  ipcMain: { handle: jest.fn(), on: jest.fn() },
}));
jest.mock("@rewind/osu-local/osr-reader", () => ({ read: jest.fn() }));
jest.mock("./replay-source", () => ({ readReplayWithSource: jest.fn(), REPLAY_SOURCE_FILE: "replay-origins.json" }));
jest.mock("./beatmap-lookup", () => ({ lookupBeatmap: jest.fn() }));
jest.mock("./performance-worker");
jest.mock("worker_threads", () => ({ Worker: jest.fn() }));

class ReadThread extends EventEmitter {
  sent: { id: number; bytes: Buffer }[] = [];
  postMessage(value: { id: number; bytes: Buffer }) { this.sent.push(value); }
  terminate = jest.fn(() => new Promise<number>(() => undefined));
}
const readThreads: ReadThread[] = [];
const replaySender = (id = 41) => Object.assign(new EventEmitter(), { id, mainFrame: {}, isDestroyed: jest.fn(() => false) });
const replayEvent = (sender: ReturnType<typeof replaySender>) => ({ sender, senderFrame: sender.mainFrame });
const readTick = () => new Promise(resolve => setImmediate(resolve));
beforeEach(() => {
  jest.clearAllMocks(); readThreads.length = 0;
  (readReplayWithSource as jest.Mock).mockReset().mockResolvedValue({ replay_data: "frames" });
  (Worker as unknown as jest.Mock).mockImplementation(() => { const thread = new ReadThread(); readThreads.push(thread); return thread; });
});

it("loads confirmed replay provenance from the application's own data directory", async () => {
  setupEventListeners();
  const handler = (ipcMain.handle as jest.Mock).mock.calls.find(([channel]) => channel === "readOsr")![1];
  const replay = { sourceClient: "lazer" };
  (readReplayWithSource as jest.Mock).mockResolvedValue(replay);
  expect(await handler(replayEvent(replaySender()), "replay.osr")).toBe(replay);
  expect(readReplayWithSource).toHaveBeenCalledWith("replay.osr", join("user-data", REPLAY_SOURCE_FILE), undefined,
    { read: expect.any(Function), signal: expect.any(AbortSignal) });
  expect(app.getPath).toHaveBeenCalledWith("userData");
});

it("forwards the explicitly configured installation for exact optional saved-score lookup", async () => {
  setupEventListeners();
  const handler = (ipcMain.handle as jest.Mock).mock.calls.find(([channel]) => channel === "readOsr")![1];
  await handler(replayEvent(replaySender()), "replay.osr", "D:\\osu!");
  expect(readReplayWithSource).toHaveBeenCalledWith("replay.osr", join("user-data", REPLAY_SOURCE_FILE), "D:\\osu!",
    { read: expect.any(Function), signal: expect.any(AbortSignal) });
});

it("rejects stale replay publication on main-document navigation and destroyed senders", async () => {
  setupEventListeners(); const handler = (ipcMain.handle as jest.Mock).mock.calls.find(([channel]) => channel === "readOsr")![1];
  const sender = replaySender(); let finish!: (value: unknown) => void;
  (readReplayWithSource as jest.Mock).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const loading = handler(replayEvent(sender), "replay.osr"), rejected = expect(loading).rejects.toThrow("cancelled"); await readTick();
  const options = (readReplayWithSource as jest.Mock).mock.calls[0][3];
  sender.emit("did-start-navigation", {}, "frame", false, false); sender.emit("did-start-navigation", {}, "#anchor", true, true);
  expect(options.signal.aborted).toBe(false); sender.emit("did-start-navigation", {}, "reload", false, true);
  expect(options.signal.aborted).toBe(true); finish({ replay_data: "late" }); await rejected;
  sender.isDestroyed.mockReturnValue(true); await expect(handler(replayEvent(sender), "other.osr")).rejects.toThrow("closed");
  expect(readReplayWithSource).toHaveBeenCalledTimes(1); sender.emit("destroyed");
  expect(sender.listenerCount("did-start-navigation")).toBe(0); expect(sender.listenerCount("render-process-gone")).toBe(0);
});

it("fences replacement and application quit behind the actual owned worker exit", async () => {
  setupEventListeners(); const handler = (ipcMain.handle as jest.Mock).mock.calls.find(([channel]) => channel === "readOsr")![1];
  (readReplayWithSource as jest.Mock).mockImplementation((file, _origins, _folder, options) => options.read(Buffer.from(file)));
  const sender = replaySender(), first = handler(replayEvent(sender), "one.osr"), firstRejected = expect(first).rejects.toThrow("replaced"); await readTick();
  const second = handler(replayEvent(sender), "two.osr"), secondRejected = expect(second).rejects.toThrow("closed"); await readTick();
  expect(readThreads).toHaveLength(1); expect(readReplayWithSource).toHaveBeenCalledTimes(1); expect(readThreads[0].terminate).toHaveBeenCalledTimes(1);
  readThreads[0].emit("message", { id: readThreads[0].sent[0].id, ok: true, replay: { replay_data: "stale" } });
  readThreads[0].emit("exit", 1); await firstRejected; await readTick(); expect(readThreads).toHaveLength(2);
  expect(sender.listenerCount("did-start-navigation")).toBe(1); expect(sender.listenerCount("destroyed")).toBe(1);
  const quit = (app.on as jest.Mock).mock.calls.find(([event]) => event === "before-quit")![1];
  quit({ preventDefault: jest.fn() }); await readTick(); expect(app.quit).not.toHaveBeenCalled();
  expect(readThreads[1].terminate).toHaveBeenCalledTimes(1); readThreads[1].emit("exit", 1);
  await secondRejected; await readTick(); expect(app.quit).toHaveBeenCalledTimes(1);
});

it("rejects queued stale-frame and subframe requests before replacing valid main-frame work", async () => {
  setupEventListeners(); const handler = (ipcMain.handle as jest.Mock).mock.calls.find(([channel]) => channel === "readOsr")![1];
  const sender = replaySender(), stale = replayEvent(sender); sender.mainFrame = {};
  await expect(handler(stale, "stale.osr")).rejects.toThrow("current main frame");
  expect(readReplayWithSource).not.toHaveBeenCalled();
  let finish!: (value: unknown) => void;
  (readReplayWithSource as jest.Mock).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const valid = handler(replayEvent(sender), "valid.osr"); await readTick();
  const signal = (readReplayWithSource as jest.Mock).mock.calls[0][3].signal;
  await expect(handler({ sender, senderFrame: {} }, "subframe.osr")).rejects.toThrow("current main frame");
  await expect(handler(stale, "late-old.osr")).rejects.toThrow("current main frame");
  expect(signal.aborted).toBe(false); expect(readReplayWithSource).toHaveBeenCalledTimes(1);
  finish({ replay_data: "current" }); await expect(valid).resolves.toEqual({ replay_data: "current" });
});

it("rechecks exact main-frame identity immediately before returning replay publication", async () => {
  setupEventListeners(); const handler = (ipcMain.handle as jest.Mock).mock.calls.find(([channel]) => channel === "readOsr")![1];
  const sender = replaySender(); let finish!: (value: unknown) => void;
  (readReplayWithSource as jest.Mock).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const loading = handler(replayEvent(sender), "replay.osr"), rejected = expect(loading).rejects.toThrow("current main frame");
  await readTick(); sender.mainFrame = {}; finish({ replay_data: "old document" }); await rejected;
});

function setup() {
  setupEventListeners();
  const worker = (PerformanceWorker as jest.MockedClass<typeof PerformanceWorker>).mock.instances[0];
  const calculate = (ipcMain.handle as jest.Mock).mock.calls.find(
    ([channel]) => channel === PERFORMANCE_CALCULATE_CHANNEL,
  )![1];
  return { worker, calculate };
}

it.each([false, true])("resolves bundled skin resources for isPackaged=%s", (isPackaged) => {
  const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  const electronResources = join(process.cwd(), "node_modules", "electron", "dist", "resources");
  Object.defineProperty(process, "resourcesPath", { value: electronResources, configurable: true });
  Object.assign(app, { isPackaged });
  try {
    setup();
    const getPath = (ipcMain.handle as jest.Mock).mock.calls.find(([channel]) => channel === "getPath")?.[1];
    expect(getPath).toBeDefined();
    expect(getPath({}, "appResources")).toBe(isPackaged ? electronResources : join(process.cwd(), "resources"));
  } finally {
    Object.assign(app, { isPackaged: false });
    if (originalResourcesPath) Object.defineProperty(process, "resourcesPath", originalResourcesPath);
    else Reflect.deleteProperty(process, "resourcesPath");
  }
});

it("cancels only the navigating main frame and does not duplicate lifecycle listeners", () => {
  const { worker, calculate } = setup();
  const sender = Object.assign(new EventEmitter(), { id: 10 });
  calculate({ sender }, { beatmap: "first" });
  calculate({ sender }, { beatmap: "second" });
  expect(sender.listenerCount("did-start-navigation")).toBe(1);
  expect(sender.listenerCount("render-process-gone")).toBe(1);
  expect(sender.listenerCount("destroyed")).toBe(1);
  sender.emit("did-start-navigation", {}, "frame", false, false);
  sender.emit("did-start-navigation", {}, "#anchor", true, true);
  expect(worker.cancel).not.toHaveBeenCalled();
  sender.emit("did-start-navigation", {}, "reload", false, true);
  expect(worker.cancel).toHaveBeenCalledTimes(1);
  expect(worker.cancel).toHaveBeenCalledWith(10);
});

it("cancels a crashed renderer independently and removes its lifecycle listeners on destruction", () => {
  const { worker, calculate } = setup();
  const first = Object.assign(new EventEmitter(), { id: 10 });
  const second = Object.assign(new EventEmitter(), { id: 20 });
  calculate({ sender: first }, {});
  calculate({ sender: second }, {});
  first.emit("render-process-gone", {}, { reason: "crashed" });
  expect(worker.cancel).toHaveBeenLastCalledWith(10);
  expect(worker.cancel).toHaveBeenCalledTimes(1);
  first.emit("destroyed");
  expect(worker.cancel).toHaveBeenCalledTimes(2);
  expect(first.listenerCount("did-start-navigation")).toBe(0);
  expect(first.listenerCount("render-process-gone")).toBe(0);
  expect(second.listenerCount("did-start-navigation")).toBe(1);
  second.emit("render-process-gone", {}, { reason: "killed" });
  expect(worker.cancel).toHaveBeenLastCalledWith(20);
});

it("retains explicit per-window cancellation and application shutdown disposal", () => {
  const { worker } = setup();
  const cancel = (ipcMain.on as jest.Mock).mock.calls.find(([channel]) => channel === PERFORMANCE_CANCEL_CHANNEL)![1];
  cancel({ sender: { id: 10 } });
  expect(worker.cancel).toHaveBeenCalledWith(10);
  const quit = (app.on as jest.Mock).mock.calls.find(([event]) => event === "before-quit")![1];
  quit({ preventDefault: jest.fn() });
  expect(worker.dispose).toHaveBeenCalledTimes(1);
});

it("derives native frame ownership from the sender while forwarding frame ordering fields", async () => {
  const append = jest.spyOn(ClipExportManager.prototype, "appendFrame").mockResolvedValue(undefined);
  try {
    setupEventListeners();
    const registered = (ipcMain.handle as jest.Mock).mock.calls.find(
      ([channel]) => channel === "appendClipExportFrame",
    );
    if (!registered) throw new Error("Native frame IPC was not registered");
    const handler = registered[1];
    const data = new ArrayBuffer(4);
    await handler({ sender: { id: 27 } }, "session", 8, 1024, data);
    expect(append).toHaveBeenCalledWith(27, "session", 8, 1024, data);
  } finally {
    append.mockRestore();
  }
});

describe("screenshot capture", () => {
  function captureHandler() {
    setupEventListeners();
    return (ipcMain.handle as jest.Mock).mock.calls.find(([channel]) => channel === "captureScreenshot")![1];
  }

  it("captures the requesting window's entire composited viewport and returns lossless PNG bytes", async () => {
    const capture = captureHandler();
    const png = Buffer.from([137, 80, 78, 71]);
    const image = { isEmpty: jest.fn(() => false), toPNG: jest.fn(() => png) };
    const sender = { isDestroyed: jest.fn(() => false), capturePage: jest.fn().mockResolvedValue(image) };
    const anotherWindow = { capturePage: jest.fn() };
    expect(await capture({ sender }, anotherWindow)).toBe(png);
    expect(sender.capturePage).toHaveBeenCalledWith();
    expect(anotherWindow.capturePage).not.toHaveBeenCalled();
    expect(image.toPNG).toHaveBeenCalledWith();
  });

  it("rejects an empty capture instead of offering a blank download", async () => {
    const capture = captureHandler();
    const image = { isEmpty: () => true, toPNG: jest.fn() };
    const sender = { isDestroyed: () => false, capturePage: jest.fn().mockResolvedValue(image) };
    await expect(capture({ sender })).rejects.toThrow("Could not capture");
    expect(image.toPNG).not.toHaveBeenCalled();
  });

  it("handles a window closed before or during capture", async () => {
    const capture = captureHandler();
    const image = { isEmpty: () => false, toPNG: jest.fn() };
    const sender = { isDestroyed: jest.fn(() => true), capturePage: jest.fn().mockResolvedValue(image) };
    await expect(capture({ sender })).rejects.toThrow("closed");
    expect(sender.capturePage).not.toHaveBeenCalled();
    sender.isDestroyed.mockReturnValueOnce(false);
    await expect(capture({ sender })).rejects.toThrow("Could not capture");
    expect(image.toPNG).not.toHaveBeenCalled();
  });

  it("propagates compositor failure for the renderer to show an error", async () => {
    const capture = captureHandler();
    const sender = { isDestroyed: () => false, capturePage: jest.fn().mockRejectedValue(new Error("Capture failed")) };
    await expect(capture({ sender })).rejects.toThrow("Capture failed");
  });
});
