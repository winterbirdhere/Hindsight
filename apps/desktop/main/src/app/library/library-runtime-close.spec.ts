import { EventEmitter } from "events";
import { app, ipcMain, shell, utilityProcess } from "electron";
import { windows } from "../windows";
import { registerLibraryRuntime } from "./library-runtime";
import { LibraryMainOwner } from "./library-main-owner";
import { LibraryPassiveResourceApi } from "./library-passive-resource-api";
import { LibraryPassiveResources } from "./library-passive-resources";
import { LibraryNativeDrainError } from "./library-native-admission";
import { LibraryPassiveResourceClient } from "../../../../frontend/src/app/services/library/library-passive-resource-client";
import { LIBRARY_PASSIVE_RESOURCE_CHANNEL, LibraryPassiveResourceRequest } from "../../../../shared/library-passive-resources";

// Only the Electron host and external metadata boundary are substituted. Runtime
// routing, sender validation, selector, reader, API and renderer finally are real.
jest.mock("electron", () => ({
  app: { isReady: () => true, getPath: jest.fn(() => "C:/hindsight-test-unused") },
  ipcMain: { handle: jest.fn() }, dialog: {},
  utilityProcess: { fork: jest.fn(() => { throw Error("Unexpected child process"); }) },
  powerMonitor: { removeListener: jest.fn() }, shell: { showItemInFolder: jest.fn() },
}));
jest.mock("../../environments/environment", () => ({ environment: { production: false } }));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const outcome = (work: Promise<unknown>) => work.then(() => undefined, (error: unknown) => error);
type Call = { input: LibraryPassiveResourceRequest; result: Promise<unknown> };

function runtimeHarness() {
  const frame = {}, sender = Object.assign(new EventEmitter(), {
    mainFrame: frame, isDestroyed: (): boolean => false, getURL: (): string => "http://localhost:4200/", send: jest.fn(),
  });
  windows.frontend = { webContents: sender } as unknown as Electron.BrowserWindow;
  const entered = deferred<void>(), finish = deferred<unknown>();
  const metadata = jest.spyOn(LibraryMainOwner.prototype, "request").mockImplementation(async method => {
    if (method !== "prepare-open") throw Error(`Unexpected metadata operation: ${method}`);
    entered.resolve(); return finish.promise;
  });
  const runtime = registerLibraryRuntime(() => "C:/hindsight-test-unused/engine.exe");
  const registered = (ipcMain.handle as jest.Mock).mock.calls.find(([channel]) => channel === LIBRARY_PASSIVE_RESOURCE_CHANNEL);
  if (!registered) throw Error("Passive resource handler not registered");
  const handler = registered[1] as (event: unknown, input: unknown) => Promise<unknown>;
  const event = { sender, senderFrame: frame };
  const invoke = (input: unknown, incoming: unknown = event) => Promise.resolve().then(() => handler(incoming, input));
  const calls: Call[] = [], releases = deferred<void>();
  const client = new LibraryPassiveResourceClient({ resource: input => {
    const result = invoke(input); calls.push({ input, result: outcome(result) });
    if (input.method === "release") releases.resolve();
    return result;
  } }, { create: () => { throw Error("Cancelled artwork must not create a URL"); }, revoke: () => undefined });
  return { runtime, client, invoke, event, sender, entered, finish, metadata, calls, releases };
}

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { jest.restoreAllMocks(); windows.frontend = null; });

describe("runtime passive cleanup after close begins", () => {
  it("accepts the real renderer finally-release after held artwork acknowledges shutdown cancellation", async () => {
    const h = runtimeHarness(), display = h.client.update({ artworkIds: ["replay"] });
    await h.entered.promise;
    let drained = false;
    const closing = h.runtime.close().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    h.finish.resolve({ items: [] });
    await closing; await display; await h.releases.promise;
    const [acquire, release] = h.calls;
    expect(h.calls.map(call => call.input.method)).toEqual(["artwork", "release"]);
    expect(release.input.requestId).toBe(acquire.input.requestId);
    expect(await acquire.result).toEqual(expect.objectContaining({ message: expect.stringContaining("outcome=acknowledged-cancellation") }));
    const disposal = await outcome(h.client.dispose());
    expect(await release.result).toBeUndefined();
    expect(disposal).toBeUndefined();
    expect(h.metadata).toHaveBeenCalledTimes(1);
    expect(utilityProcess.fork).not.toHaveBeenCalled();
  });

  it("keeps renderer finally-release pending until the already-closing reader has drained", async () => {
    const h = runtimeHarness(), display = h.client.update({ artworkIds: ["replay"] });
    await h.entered.promise;
    const closing = h.runtime.close(), disposal = outcome(h.client.dispose());
    await h.releases.promise;
    let released = false;
    void h.calls[1].result.then(() => { released = true; });
    // Let a rejected dispatch settle, without sleeps or fabricated cancellation.
    await new Promise<void>(resolve => setImmediate(resolve));
    const completedBeforeDrain = released;
    h.finish.resolve({ items: [] });
    await closing; await display;
    const disposed = await disposal;
    expect(completedBeforeDrain).toBe(false);
    expect(await h.calls[1].result).toBeUndefined();
    expect(disposed).toBeUndefined();
  });

  it.each(["artwork", "strip", "chunk", "reveal"] as const)("rejects late %s without starting work or revealing a file", async method => {
    const h = runtimeHarness();
    h.finish.resolve({ items: [] });
    await h.invoke({ method: "artwork", requestId: "initial", replayId: "replay" });
    await h.runtime.close();
    await expect(h.invoke({ method, requestId: "late", ...(method === "chunk" ? { offset: 0 } : { replayId: "replay" }) })).rejects.toThrow();
    expect(h.metadata).toHaveBeenCalledTimes(1);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(utilityProcess.fork).not.toHaveBeenCalled();
    await h.client.dispose();
  });

  it("does not initialize an unused runtime for a post-close request", async () => {
    const h = runtimeHarness(); await h.runtime.close();
    await expect(h.invoke({ method: "artwork", requestId: "late", replayId: "replay" })).rejects.toThrow();
    expect(app.getPath).not.toHaveBeenCalled(); expect(h.metadata).not.toHaveBeenCalled();
    await h.client.dispose();
  });

  it.each(["foreign-sender", "subframe", "replaced-document", "foreign-url", "destroyed"])("still rejects %s cleanup after shutdown", async kind => {
    const h = runtimeHarness(); h.finish.resolve({ items: [] });
    await h.invoke({ method: "artwork", requestId: "initial", replayId: "replay" }); await h.runtime.close();
    const event = { ...h.event };
    if (kind === "foreign-sender") event.sender = { ...h.sender } as typeof h.sender;
    if (kind === "subframe") event.senderFrame = {};
    if (kind === "replaced-document") h.sender.mainFrame = {};
    if (kind === "foreign-url") h.sender.getURL = () => "https://example.invalid/";
    if (kind === "destroyed") h.sender.isDestroyed = () => true;
    await expect(h.invoke({ method: "release", requestId: "initial" }, event)).rejects.toThrow("Unexpected library sender");
    await h.client.dispose();
  });

  it("preserves uncertain drain failure in close and the real renderer cleanup", async () => {
    const h = runtimeHarness(), display = h.client.update({ artworkIds: ["replay"] });
    await h.entered.promise; const closing = outcome(h.runtime.close());
    h.finish.reject(new LibraryNativeDrainError("unconfirmed test helper exit"));
    await display; await h.releases.promise;
    expect(await closing).toEqual(expect.objectContaining({ message: expect.stringContaining("ownership") }));
    expect(await h.calls[0].result).toEqual(expect.objectContaining({ message: expect.stringContaining("outcome=ownership-uncertain") }));
    const disposed = await outcome(h.client.dispose());
    expect(disposed).toEqual(Error("Passive resource cleanup did not complete"));
    expect(await h.calls[1].result).toEqual(Error("Native passive resource ownership is unconfirmed"));
  });
});

describe("passive API close admission", () => {
  const check = () => undefined;
  const emptyReader = () => new LibraryPassiveResources({ select: async () => undefined, isCurrent: async () => true,
    readStrip: async () => undefined, checkpoint: async () => undefined });

  it("accepts repeated valid cleanup after close without reinitializing resources", async () => {
    const api = new LibraryPassiveResourceApi(emptyReader(), () => { throw Error("Unexpected reveal"); });
    await api.close();
    await expect(api.receive({ method: "release", requestId: "retired" }, check)).resolves.toBeUndefined();
    await expect(api.receive({ method: "release", requestId: "retired" }, check)).resolves.toBeUndefined();
  });

  it.each(["artwork", "strip", "chunk", "reveal"] as const)("does not admit %s directly after close", async method => {
    const api = new LibraryPassiveResourceApi(emptyReader(), () => { throw Error("Unexpected reveal"); });
    await api.close();
    await expect(api.receive({ method, requestId: "late", ...(method === "chunk" ? { offset: 0 } : { replayId: "replay" }) }, check)).rejects.toThrow();
  });

  it("validates late cleanup without invoking accessors or trusting stale documents", async () => {
    const api = new LibraryPassiveResourceApi(emptyReader(), () => undefined); await api.close();
    let accessed = false;
    const accessor = Object.defineProperty({ requestId: "retired" }, "method", { enumerable: true, get: () => { accessed = true; return "release"; } });
    for (const invalid of [accessor, { method: "release", requestId: "retired", path: "C:/private" },
      { method: "release", requestId: "" }, Object.assign(Object.create({}), { method: "release", requestId: "retired" })]) {
      await expect(api.receive(invalid, check)).rejects.toThrow();
    }
    expect(accessed).toBe(false);
    await expect(api.receive({ method: "release", requestId: "retired" }, () => { throw Error("Stale document"); })).rejects.toThrow("Stale document");
  });
});
