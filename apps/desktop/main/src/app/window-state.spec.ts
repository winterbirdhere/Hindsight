import { EventEmitter } from "events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { readWindowState, restoreWindowState, trackWindowState, WindowState, writeWindowState } from "./window-state";

jest.mock("fs", () => ({
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  renameSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const normal = { x: 200, y: 100, width: 1200, height: 720 };

describe("window bounds restoration", () => {
  it("defaults to maximized with centered normal bounds on the first launch", () => {
    expect(restoreWindowState(undefined, [primary], primary)).toEqual({
      state: { bounds: { x: 160, y: 70, width: 1600, height: 900 }, maximized: true },
      minWidth: 1024,
      minHeight: 600,
    });
  });

  it.each([true, false])("retains a visible normal rectangle and maximized=%s", (maximized) => {
    const saved = { bounds: normal, maximized };
    expect(restoreWindowState(saved, [primary], primary).state).toEqual(saved);
  });

  it("retains a secondary display's negative logical coordinates", () => {
    const secondary = { x: -1600, y: 100, width: 1600, height: 860 };
    const saved = { bounds: { x: -1500, y: 120, width: 1200, height: 720 }, maximized: false };
    expect(restoreWindowState(saved, [primary, secondary], primary).state).toEqual(saved);
  });

  it("recenters a disconnected display's normal size onto the primary work area", () => {
    const saved = { bounds: { x: 4000, y: -100, width: 1400, height: 800 }, maximized: false };
    expect(restoreWindowState(saved, [primary], primary).state).toEqual({
      bounds: { x: 260, y: 120, width: 1400, height: 800 },
      maximized: false,
    });
  });

  it("fits oversized or partially offscreen bounds after resolution/work-area changes", () => {
    const saved = { bounds: { x: -20, y: -30, width: 2500, height: 1500 }, maximized: true };
    expect(restoreWindowState(saved, [primary], primary).state).toEqual({ bounds: primary, maximized: true });
  });

  it("uses DIP work areas directly and caps minimum sizes for a small display", () => {
    const small = { x: 1920, y: 0, width: 800, height: 560 };
    expect(restoreWindowState(undefined, [small], small)).toEqual({
      state: { bounds: small, maximized: true },
      minWidth: 800,
      minHeight: 560,
    });
  });
});

describe("window state file", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reads only supported, finite window-state data", () => {
    (readFileSync as jest.Mock).mockReturnValue(JSON.stringify({ version: 1, bounds: normal, maximized: false }));
    expect(readWindowState("state.json")).toEqual({ bounds: normal, maximized: false });
  });

  it.each([
    "{broken",
    "null",
    "[]",
    JSON.stringify({ version: 2, bounds: normal, maximized: true }),
    JSON.stringify({ version: 1, bounds: { ...normal, x: null }, maximized: true }),
    JSON.stringify({ version: 1, bounds: { ...normal, width: -1 }, maximized: true }),
    JSON.stringify({ version: 1, bounds: normal, maximized: "yes" }),
  ])("ignores corrupt or unsupported preferences %s", (contents) => {
    (readFileSync as jest.Mock).mockReturnValue(contents);
    expect(readWindowState("state.json")).toBeUndefined();
  });

  it("treats a missing or unreadable file as the first launch", () => {
    (readFileSync as jest.Mock).mockImplementation(() => {
      throw new Error("not readable");
    });
    expect(readWindowState("state.json")).toBeUndefined();
  });

  it("atomically replaces the file after writing normal bounds and the maximized flag", () => {
    const state = { bounds: normal, maximized: true };
    writeWindowState("preferences/window-state.json", state);
    expect(mkdirSync).toHaveBeenCalledWith("preferences", { recursive: true });
    expect(writeFileSync).toHaveBeenCalledWith(
      "preferences/window-state.json.tmp",
      JSON.stringify({ version: 1, ...state }),
      "utf8",
    );
    expect(renameSync).toHaveBeenCalledWith("preferences/window-state.json.tmp", "preferences/window-state.json");
    expect((writeFileSync as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (renameSync as jest.Mock).mock.invocationCallOrder[0],
    );
  });
});

class FakeWindow extends EventEmitter {
  bounds = { ...normal };
  maximized = false;
  minimized = false;
  fullscreen = false;
  destroyed = false;
  getNormalBounds = jest.fn(() => this.bounds);
  isMaximized = () => this.maximized;
  isMinimized = () => this.minimized;
  isFullScreen = () => this.fullscreen;
  isDestroyed = () => this.destroyed;
}

describe("window state persistence lifecycle", () => {
  let window: FakeWindow;
  let persist: jest.Mock;
  let initial: WindowState;

  beforeEach(() => {
    jest.useFakeTimers();
    window = new FakeWindow();
    persist = jest.fn();
    initial = { bounds: { ...normal }, maximized: false };
  });
  afterEach(() => jest.useRealTimers());

  function track(saved?: WindowState) {
    return trackWindowState(window as unknown as Parameters<typeof trackWindowState>[0], initial, persist, saved);
  }

  it("coalesces a resize/move burst into one write of the most recent normal bounds", () => {
    track();
    for (let index = 0; index < 10; index++) {
      window.bounds = { ...window.bounds, x: 200 + index, width: 1200 + index };
      window.emit(index % 2 ? "move" : "resize");
      jest.advanceTimersByTime(100);
    }
    expect(persist).not.toHaveBeenCalled();
    jest.advanceTimersByTime(500);
    expect(persist.mock.calls).toEqual([[{ bounds: window.bounds, maximized: false }]]);
  });

  it("retains normal restore bounds when maximized and the maximized flag while minimized", () => {
    track();
    window.maximized = true;
    window.emit("maximize");
    jest.advanceTimersByTime(500);
    expect(persist).toHaveBeenLastCalledWith({ bounds: normal, maximized: true });
    window.minimized = true;
    window.maximized = false;
    window.bounds = { x: -32000, y: -32000, width: 0, height: 0 };
    window.emit("minimize");
    window.emit("unmaximize");
    window.emit("close");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenLastCalledWith({ bounds: normal, maximized: true });
  });

  it("saves returning to normal mode and skips unchanged later events", () => {
    initial.maximized = true;
    window.maximized = true;
    track(initial);
    window.maximized = false;
    window.emit("unmaximize");
    jest.advanceTimersByTime(500);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ bounds: normal, maximized: false });
    window.emit("move");
    jest.advanceTimersByTime(500);
    window.emit("close");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending change on close and cancels timers/listeners after destruction", () => {
    track();
    window.bounds = { ...normal, width: 1300 };
    window.emit("resize");
    window.emit("close");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ bounds: window.bounds, maximized: false });
    window.destroyed = true;
    window.emit("closed");
    jest.advanceTimersByTime(1000);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(window.listenerCount("resize")).toBe(0);
  });

  it("does not overwrite normal state with fullscreen bounds or save fullscreen mode", () => {
    initial.maximized = true;
    window.maximized = true;
    track();
    window.fullscreen = true;
    window.maximized = false;
    window.bounds = primary;
    window.emit("resize");
    window.emit("close");
    expect(persist).toHaveBeenCalledWith({ bounds: normal, maximized: true });
  });

  it("does not write on an unchanged relaunch", () => {
    track(initial);
    window.emit("resize");
    jest.advanceTimersByTime(500);
    window.emit("close");
    expect(persist).not.toHaveBeenCalled();
  });
});
