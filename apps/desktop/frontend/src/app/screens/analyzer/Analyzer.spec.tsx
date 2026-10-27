import "reflect-metadata";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import type { InspectorState } from "../../providers/InspectorProvider";
import { ClipExportSettingsStore } from "../../services/analysis/clip-export-settings";
import { InspectorLayoutSettingsStore } from "../../services/analysis/inspector-layout-settings";
import { GameplayClock } from "../../services/common/game/GameplayClock";
import type { ClipRunSummary } from "../../services/manager/clip-export-types";
import type { ReplayLoadState } from "../../services/manager/replay-load-state";
import { Analyzer } from "./Analyzer";

jest.mock("electron", () => ({ ipcRenderer: { invoke: jest.fn(), send: jest.fn() } }));
jest.mock("../../api", () => ({ frontendAPI: { openExportedClip: jest.fn(), showExportedClip: jest.fn() } }));
jest.mock("../../hooks/shortcuts", () => ({ useShortcuts: jest.fn() }));
// One stable app object per test, like the real singleton. The clock is the real one; its spies prove nothing here
// drives playback, and the export tests read the clock itself.
let playback: {
  seekTo: jest.SpyInstance;
  start: jest.SpyInstance;
  pause: jest.SpyInstance;
  analyzeMisses: jest.Mock;
};
let clock: GameplayClock;
let primaryReplay: object | undefined;
let replayEvents$: BehaviorSubject<unknown[]>;
/** The inspector state as the (always mounted) dock sees it. */
const mockInspector: { current?: InspectorState } = {};
let mockApp: Record<string, unknown>;
jest.mock("../../providers/TheaterProvider", () => ({
  useAnalysisApp: () => mockApp,
  // The stats overlay reads its shade from the beatmap background settings.
  useCommonManagers: () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BehaviorSubject } = require("rxjs");
    const settings = { enabled: true, dim: 0.8, statsShade: true };
    return { beatmapBackgroundSettingsStore: { settings, settings$: new BehaviorSubject(settings) } };
  },
}));
const mockProvider = { mounts: 0, unmounts: 0 };
jest.mock("../../hooks/error-navigation", () => ({
  ErrorNavigationProvider: ({ children }: { children: unknown }) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useEffect } = require("react");
    useEffect(() => {
      mockProvider.mounts += 1;
      return () => {
        mockProvider.unmounts += 1;
      };
    }, []);
    return children;
  },
}));
jest.mock("../../components/analyzer/GameCanvas", () => ({ GameCanvas: () => <div data-testid="stage" /> }));
// The bridge reads the selection, which this file replaces with a pass-through; ErrorOutlineBridge.spec covers it.
jest.mock("../../components/analyzer/ErrorOutlineBridge", () => ({
  ErrorOutlineBridge: () => <div data-testid="error-outline-bridge" />,
}));
// The real overlay (its scrim and text column carry z-indexes the dim layer must paint above), inside a marker.
jest.mock("../../hooks/readout", () => ({
  useReadoutModel: () => ({
    identity: { title: "Map", mods: "NM", ruleset: "Stable" },
    performance: { pp: "195.8" },
    rows: [],
    judgements: [],
  }),
}));
jest.mock("../../components/analyzer/StatsOverlay", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { StatsOverlay: Actual } = jest.requireActual("../../components/analyzer/StatsOverlay");
  return {
    StatsOverlay: () => (
      <div data-testid="stats">
        <Actual />
      </div>
    ),
  };
});
// The inspector reports its mode and shows the real Export panel in Export mode; the dock holds the real gear and a
// stand-in for the Export button (the real one is covered by Dock.spec), so the tests drive the modes as a person does.
jest.mock("../../components/analyzer/Inspector", () => ({
  Inspector: () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useInspector } = require("../../providers/InspectorProvider");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ExportPanel } = require("../../components/export/ExportPanel");
    const { mode } = useInspector();
    return (
      <div data-testid="inspector" data-mode={mode}>
        {mode === "export" ? <ExportPanel /> : null}
      </div>
    );
  },
}));
jest.mock("../../components/analyzer/Dock", () => ({
  Dock: () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SettingsButton } = require("../../components/analyzer/DockIconButtons");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useInspector } = require("../../providers/InspectorProvider");
    const inspector = useInspector();
    mockInspector.current = inspector;
    return (
      <div data-testid="dock">
        <button type="button" aria-pressed={inspector.exportSession} onClick={inspector.toggleExport}>
          Export
        </button>
        <SettingsButton />
      </div>
    );
  },
}));

const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

function size(width: number, height: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => height });
}

let store: InspectorLayoutSettingsStore;
let loadState: BehaviorSubject<ReplayLoadState>;
let clipState: BehaviorSubject<{ status: string; progress: number }>;
beforeEach(() => {
  store = new InspectorLayoutSettingsStore();
  loadState = new BehaviorSubject<ReplayLoadState>({ phase: "ready" });
  clipState = new BehaviorSubject({ status: "idle", progress: 0 });
  mockProvider.mounts = 0;
  mockProvider.unmounts = 0;
  clock = new GameplayClock();
  clock.setDuration(100_000);
  playback = {
    seekTo: jest.spyOn(clock, "seekTo"),
    start: jest.spyOn(clock, "start"),
    pause: jest.spyOn(clock, "pause"),
    analyzeMisses: jest.fn(),
  };
  primaryReplay = { id: "first replay" };
  replayEvents$ = new BehaviorSubject<unknown[]>([]);
  mockInspector.current = undefined;
  mockApp = {
    initialize: jest.fn().mockResolvedValue(undefined),
    loadReplay: jest.fn(),
    inspectorLayoutSettingsStore: store,
    gameClock: clock,
    gameSimulator: { analyzeMisses: playback.analyzeMisses, getPrimaryReplay: () => primaryReplay, replayEvents$ },
    scenarioManager: { loadState$: loadState },
    clipExportSettingsStore: new ClipExportSettingsStore(),
    modSettingsService: { modSettings$: new BehaviorSubject({ flashlight: false, hidden: false }), setHidden: jest.fn() },
    clipRecorder: {
      state$: clipState,
      run$: new BehaviorSubject(undefined),
      get isBusy() {
        return ["preparing", "recording", "rendering", "saving"].includes(clipState.value.status);
      },
      getFormat: () => ({ mimeType: "video/mp4", extension: "mp4", label: "MP4 (H.264)" }),
      exportClip: jest.fn().mockResolvedValue(undefined),
      cancel: jest.fn().mockResolvedValue(undefined),
    },
  };
});

function expectNoPlaybackCalls() {
  Object.values(playback).forEach((spy) => expect(spy).not.toHaveBeenCalled());
}

/** jsdom has no PointerEvent: a MouseEvent of the pointer type carries the pointer id like the real one does. */
function pointer(element: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", init: { pointerId: number; clientX?: number; button?: number }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, button: init.button ?? 0 });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  fireEvent(element, event);
}

function columns(container: HTMLElement) {
  return getComputedStyle(container.firstElementChild as HTMLElement).gridTemplateColumns;
}

afterEach(() => {
  // Restore the jsdom getters so other suites in the same worker are unaffected.
  if (originalWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalWidth);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  if (originalHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalHeight);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

describe("Analyzer shell", () => {
  it("lays out stage, inspector column and dock at the design size", () => {
    size(1440, 782);
    const { container } = render(<Analyzer />);
    const grid = container.firstElementChild as HTMLElement;
    expect(getComputedStyle(grid).gridTemplateColumns).toBe("minmax(0, 1fr) 260px");
    expect(getComputedStyle(grid).gridTemplateRows).toBe("minmax(0, 1fr) 86px");
    expect(screen.getByTestId("inspector")).toBeTruthy();
    expect(screen.getByTestId("stats")).toBeTruthy();
    expect(screen.getByTestId("dock")).toBeTruthy();
    // The handle now exists in the column too: it hides the inspector.
    expect(screen.getByRole("button", { name: "Hide inspector" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the error-outline bridge mounted in every layout, so the renderer always knows the selection", () => {
    size(1440, 782);
    const wide = render(<Analyzer />);
    expect(screen.getAllByTestId("error-outline-bridge")).toHaveLength(1);
    wide.unmount();
    size(900, 700);
    render(<Analyzer />);
    expect(screen.getAllByTestId("error-outline-bridge")).toHaveLength(1);
  });

  it("folds the inspector into a closed drawer on a narrow window", () => {
    size(1024, 768);
    const { container } = render(<Analyzer />);
    expect(getComputedStyle(container.firstElementChild as HTMLElement).gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy();
    expect(screen.getByTestId("stats")).toBeTruthy();
  });

  it("hides the stats overlay only when the stage is too narrow to reserve its strip", () => {
    // 440 × 800: the inspector folds away, the 440 px stage minus the 140 px reserve is under 320 px.
    size(440, 800);
    const narrow = render(<Analyzer />);
    expect(screen.queryByTestId("stats")).toBeNull();
    narrow.unmount();
    // 1280 × 800 used to hide it; the stage now makes room instead.
    size(1280, 800);
    render(<Analyzer />);
    expect(screen.getByTestId("stats")).toBeTruthy();
    expect(screen.getByTestId("inspector")).toBeTruthy();
  });

  it("shows the stats overlay only once the replay is ready, never over the loading screen", () => {
    size(1440, 782);
    store.changeSettings((draft) => Object.assign(draft, { visible: false }));
    loadState.next({ phase: "loading", step: "simulate" } as ReplayLoadState);
    render(<Analyzer />);
    expect(screen.queryByTestId("stats")).toBeNull();
    act(() => loadState.next({ phase: "ready" }));
    expect(screen.getByTestId("stats")).toBeTruthy();
  });
});

describe("Analyzer inspector visibility", () => {
  it("hides the column and gives the stage the full width, with the stats overlay shown throughout", () => {
    size(1280, 800);
    const { container } = render(<Analyzer />);
    expect(columns(container)).toBe("minmax(0, 1fr) 260px");
    expect(screen.getByTestId("stats")).toBeTruthy(); // was absent while the column was shown
    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByTestId("stats")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show inspector" }).getAttribute("aria-expanded")).toBe("false");
    expect(store.settings.visible).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(columns(container)).toBe("minmax(0, 1fr) 260px");
    expect(screen.getByTestId("inspector")).toBeTruthy();
    expect(screen.getByTestId("stats")).toBeTruthy(); // was absent
    expect(store.settings.visible).toBe(true);
    expectNoPlaybackCalls();
  });

  it("starts hidden when that was the saved choice", () => {
    size(1440, 782);
    store.changeSettings((draft) => Object.assign(draft, { visible: false }));
    const { container } = render(<Analyzer />);
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy();
  });

  it("keeps the error-navigation state mounted through hide and show", () => {
    size(1440, 782);
    render(<Analyzer />);
    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(mockProvider).toEqual({ mounts: 1, unmounts: 0 });
  });

  it("persists the choice and restores it in the next session", () => {
    jest.useFakeTimers();
    window.localStorage.removeItem("inspector-layout");
    const first = new InspectorLayoutSettingsStore();
    first.init();
    mockApp.inspectorLayoutSettingsStore = first;
    size(1440, 782);
    let second: InspectorLayoutSettingsStore | undefined;
    try {
      const view = render(<Analyzer />);
      fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(JSON.parse(window.localStorage.getItem("inspector-layout") ?? "null")).toEqual({ visible: false, width: 260 });
      view.unmount();
      second = new InspectorLayoutSettingsStore();
      second.init();
      mockApp.inspectorLayoutSettingsStore = second;
      const next = render(<Analyzer />);
      expect(columns(next.container)).toBe("minmax(0, 1fr)");
      expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy();
    } finally {
      first.settings$.complete();
      second?.settings$.complete();
      jest.useRealTimers();
      window.localStorage.removeItem("inspector-layout");
    }
  });

  it("opens the drawer overlay with the same toggle, closed by default, with no separator", () => {
    size(1024, 768);
    store.changeSettings((draft) => Object.assign(draft, { width: 400, visible: false }));
    render(<Analyzer />);
    // The stored column visibility does not apply to the overlay; it starts closed.
    expect(screen.queryByTestId("inspector")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    const overlay = screen.getByTestId("inspector").parentElement as HTMLElement;
    expect(getComputedStyle(overlay).width).toBe("400px");
    expect(screen.queryByRole("separator")).toBeNull();
    expect(store.settings.visible).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
    expect(screen.queryByTestId("inspector")).toBeNull();
    expectNoPlaybackCalls();
  });
});

describe("Analyzer inspector width", () => {
  it.each([
    [400, "minmax(0, 1fr) 400px"],
    [440, "minmax(0, 1fr) 440px"],
    [520, "minmax(0, 1fr) 440px"],
    [240, "minmax(0, 1fr) 240px"],
    [280, "minmax(0, 1fr) 280px"],
    [5, "minmax(0, 1fr) 240px"],
    [5000, "minmax(0, 1fr) 440px"],
    ["x", "minmax(0, 1fr) 260px"],
    [null, "minmax(0, 1fr) 260px"],
  ])("uses a saved width of %j as %s", (saved, expected) => {
    size(1600, 782);
    store.settings$.next({ visible: true, width: saved as number });
    const { container } = render(<Analyzer />);
    expect(columns(container)).toBe(expected);
  });

  it("shows a separator at the column's left edge with the range of this window", () => {
    size(1440, 782);
    render(<Analyzer />);
    const separator = screen.getByRole("separator", { name: "Resize inspector" });
    expect(separator.getAttribute("aria-valuenow")).toBe("260");
    expect(separator.getAttribute("aria-valuemin")).toBe("240");
    // The range ends at 440 (the fold would allow 635 at this height).
    expect(separator.getAttribute("aria-valuemax")).toBe("440");
    // It lives with the inspector so it does not take clicks from the stage or the content.
    expect(screen.getByTestId("inspector").parentElement?.contains(separator)).toBe(true);
  });

  it("changes width from the keyboard and saves each step", () => {
    size(1440, 782);
    const { container } = render(<Analyzer />);
    const separator = screen.getByRole("separator", { name: "Resize inspector" });
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(columns(container)).toBe("minmax(0, 1fr) 276px");
    expect(store.settings.width).toBe(276);
    fireEvent.keyDown(separator, { key: "ArrowLeft", shiftKey: true });
    expect(columns(container)).toBe("minmax(0, 1fr) 340px");
    expect(store.settings.width).toBe(340);
    fireEvent.keyDown(separator, { key: "End" });
    expect(columns(container)).toBe("minmax(0, 1fr) 240px");
    expect(store.settings.width).toBe(240);
    fireEvent.keyDown(separator, { key: "Home" });
    expect(columns(container)).toBe("minmax(0, 1fr) 440px");
    expect(store.settings.width).toBe(440);
    fireEvent.doubleClick(separator);
    expect(columns(container)).toBe("minmax(0, 1fr) 260px");
    expect(store.settings.width).toBe(260);
    expectNoPlaybackCalls();
  });

  it("follows the pointer live and saves only on release", () => {
    size(1440, 782);
    const { container } = render(<Analyzer />);
    const separator = screen.getByRole("separator", { name: "Resize inspector" });
    pointer(separator, "pointerdown", { pointerId: 1, button: 0, clientX: 1100 });
    pointer(separator, "pointermove", { pointerId: 1, clientX: 1060 });
    expect(columns(container)).toBe("minmax(0, 1fr) 300px");
    pointer(separator, "pointermove", { pointerId: 1, clientX: 1020 });
    expect(columns(container)).toBe("minmax(0, 1fr) 340px");
    expect(store.settings.width).toBe(260);
    // Past the maximum the width stays at 440.
    pointer(separator, "pointermove", { pointerId: 1, clientX: 900 });
    expect(columns(container)).toBe("minmax(0, 1fr) 440px");
    pointer(separator, "pointerup", { pointerId: 1, clientX: 900 });
    expect(columns(container)).toBe("minmax(0, 1fr) 440px");
    expect(store.settings.width).toBe(440);
    expectNoPlaybackCalls();
  });

  it("re-clamps to a smaller window without overwriting the saved width, and returns when it grows", () => {
    let notify: () => void = () => undefined;
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(callback: () => void) {
        notify = callback;
      }
      observe = jest.fn();
      disconnect = jest.fn();
    };
    try {
      size(1600, 400);
      store.changeSettings((draft) => Object.assign(draft, { width: 440 }));
      const { container } = render(<Analyzer />);
      expect(columns(container)).toBe("minmax(0, 1fr) 440px");
      size(1000, 400);
      act(() => notify());
      // 1000 − 480 = 520 still allows 440; 900 allows 420.
      expect(columns(container)).toBe("minmax(0, 1fr) 440px");
      size(900, 400);
      act(() => notify());
      expect(columns(container)).toBe("minmax(0, 1fr) 420px");
      expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("420");
      expect(screen.getByRole("separator").getAttribute("aria-valuemax")).toBe("420");
      expect(store.settings.width).toBe(440);
      size(1600, 400);
      act(() => notify());
      expect(columns(container)).toBe("minmax(0, 1fr) 440px");
      expect(store.settings.width).toBe(440);
      expectNoPlaybackCalls();
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    }
  });

  it("shrinks the column to the widest width that keeps the playfield before folding, without overwriting the saved width", () => {
    // 1440 × 900: a saved 440 would leave a 612 px playfield for 663 px wanted; 394 px is the widest that keeps it.
    size(1440, 900);
    store.changeSettings((draft) => Object.assign(draft, { width: 440 }));
    const { container } = render(<Analyzer />);
    expect(columns(container)).toBe("minmax(0, 1fr) 394px");
    expect(screen.getByTestId("inspector")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show inspector" })).toBeNull();
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("394");
    expect(screen.getByRole("separator").getAttribute("aria-valuemax")).toBe("394");
    expect(store.settings.width).toBe(440);
  });

  it("folds into the drawer only when even the 240 px minimum does not keep the playfield, and keeps the saved width", () => {
    size(1200, 900);
    store.changeSettings((draft) => Object.assign(draft, { width: 440 }));
    const { container } = render(<Analyzer />);
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy();
    expect(store.settings.width).toBe(440);
  });

  it("never calls the clock, the simulator or the analysis while hiding, resizing and showing", () => {
    size(1440, 782);
    render(<Analyzer />);
    const separator = screen.getByRole("separator", { name: "Resize inspector" });
    pointer(separator, "pointerdown", { pointerId: 1, button: 0, clientX: 1100 });
    pointer(separator, "pointermove", { pointerId: 1, clientX: 1000 });
    pointer(separator, "pointerup", { pointerId: 1, clientX: 1000 });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expectNoPlaybackCalls();
    expect(mockApp.initialize).toHaveBeenCalledTimes(1);
  });
});

describe("Analyzer settings mode", () => {
  const gear = () => screen.getByRole("button", { name: "Settings" });
  const inspectorMode = () => screen.getByTestId("inspector").getAttribute("data-mode");

  it("the gear shows a hidden inspector without changing the saved visibility, and closing Settings hides it again", () => {
    size(1440, 782);
    store.changeSettings((draft) => Object.assign(draft, { visible: false }));
    const write = jest.spyOn(store, "changeSettings");
    const { container } = render(<Analyzer />);
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(gear().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(gear());
    expect(columns(container)).toBe("minmax(0, 1fr) 260px");
    expect(inspectorMode()).toBe("settings");
    expect(gear().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Hide inspector" }).getAttribute("aria-expanded")).toBe("true");
    expect(store.settings.visible).toBe(false);

    fireEvent.click(gear());
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.getByRole("button", { name: "Show inspector" }).getAttribute("aria-expanded")).toBe("false");
    expect(store.settings.visible).toBe(false);
    // Opening and closing Settings never touches the saved layout.
    expect(write).not.toHaveBeenCalled();
    expectNoPlaybackCalls();
  });

  it("keeps a visible inspector in place and on its saved width while Settings opens and closes", () => {
    size(1440, 782);
    store.changeSettings((draft) => Object.assign(draft, { visible: true, width: 400 }));
    const write = jest.spyOn(store, "changeSettings");
    const { container } = render(<Analyzer />);
    expect(inspectorMode()).toBe("incidents");
    fireEvent.click(gear());
    expect(columns(container)).toBe("minmax(0, 1fr) 400px");
    expect(inspectorMode()).toBe("settings");
    fireEvent.click(gear());
    expect(columns(container)).toBe("minmax(0, 1fr) 400px");
    expect(inspectorMode()).toBe("incidents");
    expect(write).not.toHaveBeenCalled();
  });

  it("the gear opens the drawer on a narrow window and closing Settings closes it", () => {
    size(1024, 768);
    const write = jest.spyOn(store, "changeSettings");
    const { container } = render(<Analyzer />);
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();

    fireEvent.click(gear());
    expect(inspectorMode()).toBe("settings");
    expect(screen.getByRole("button", { name: "Hide inspector" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("separator")).toBeNull();

    fireEvent.click(gear());
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
  });

  it("leaves a drawer that was opened by hand open when Settings closes", () => {
    size(1024, 768);
    render(<Analyzer />);
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(inspectorMode()).toBe("incidents");
    fireEvent.click(gear());
    expect(inspectorMode()).toBe("settings");
    fireEvent.click(gear());
    expect(inspectorMode()).toBe("incidents");
    expect(screen.getByRole("button", { name: "Hide inspector" })).toBeTruthy();
  });

  it("the edge handle closes Settings and hides the inspector", () => {
    size(1440, 782);
    const { container } = render(<Analyzer />);
    fireEvent.click(gear());
    expect(inspectorMode()).toBe("settings");
    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(gear().getAttribute("aria-pressed")).toBe("false");
    expect(store.settings.visible).toBe(false);
    // Showing it again brings back the incidents, not Settings.
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(inspectorMode()).toBe("incidents");
    expect(store.settings.visible).toBe(true);
    expectNoPlaybackCalls();
  });

  it("the edge handle closes Settings and the drawer on a narrow window", () => {
    size(1024, 768);
    render(<Analyzer />);
    fireEvent.click(gear());
    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(gear().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(inspectorMode()).toBe("incidents");
  });

  it("the edge handle also hides an inspector that Settings forced open over a hidden column", () => {
    size(1440, 782);
    store.changeSettings((draft) => Object.assign(draft, { visible: false }));
    const { container } = render(<Analyzer />);
    fireEvent.click(gear());
    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(gear().getAttribute("aria-pressed")).toBe("false");
    expect(store.settings.visible).toBe(false);
  });

  it("Escape closes Settings and leaves playback alone", () => {
    size(1440, 782);
    render(<Analyzer />);
    fireEvent.click(gear());
    expect(inspectorMode()).toBe("settings");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(inspectorMode()).toBe("incidents");
    expect(gear().getAttribute("aria-pressed")).toBe("false");
    expectNoPlaybackCalls();
  });

  it("Escape hides an inspector that Settings had shown over a hidden column", () => {
    size(1440, 782);
    store.changeSettings((draft) => Object.assign(draft, { visible: false }));
    const { container } = render(<Analyzer />);
    fireEvent.click(gear());
    expect(columns(container)).toBe("minmax(0, 1fr) 260px");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(store.settings.visible).toBe(false);
  });

  it("ignores the gear while a clip is exporting, and works again afterwards", () => {
    size(1440, 782);
    render(<Analyzer />);
    act(() => clipState.next({ status: "rendering", progress: 0.4 }));
    expect((gear() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(gear());
    expect(inspectorMode()).toBe("incidents");
    act(() => clipState.next({ status: "idle", progress: 0 }));
    expect((gear() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(gear());
    expect(inspectorMode()).toBe("settings");
  });

  it("keeps the error-navigation state mounted through a visit to Settings", () => {
    size(1440, 782);
    render(<Analyzer />);
    fireEvent.click(gear());
    fireEvent.click(gear());
    expect(mockProvider).toEqual({ mounts: 1, unmounts: 0 });
  });
});

describe("Analyzer export mode", () => {
  const exportButton = () => screen.getByRole("button", { name: "Export" });
  const gear = () => screen.getByRole("button", { name: "Settings" });
  const inspectorMode = () => screen.getByTestId("inspector").getAttribute("data-mode");
  const status = (next: string, progress = 0.4) => act(() => clipState.next({ status: next, progress }));
  const field = (name: "Start" | "End" | "Length") => screen.getByRole("textbox", { name }) as HTMLInputElement;
  const fields = () => ({ start: field("Start").value, end: field("End").value, length: field("Length").value });
  const setRange = (startMs: number, endMs: number) =>
    act(() => mockInspector.current?.setExportRange({ startMs, endMs }));
  /** A ResizeObserver whose callbacks (the shell's, and any a panel adds) the test calls after changing the window's size. */
  function observeResizes() {
    const callbacks = new Set<() => void>();
    const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.add(callback);
      }
      observe = jest.fn();
      disconnect = jest.fn();
    };
    return {
      resize(width: number, height: number) {
        size(width, height);
        act(() => callbacks.forEach((notify) => notify()));
      },
      restore() {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
      },
    };
  }

  it("shows a hidden inspector while Export is open and hides it again when Export closes", () => {
    size(1440, 782);
    store.changeSettings((draft) => Object.assign(draft, { visible: false }));
    const write = jest.spyOn(store, "changeSettings");
    const { container } = render(<Analyzer />);
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(exportButton().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(exportButton());
    expect(columns(container)).toBe("minmax(0, 1fr) 260px");
    expect(inspectorMode()).toBe("export");
    expect(screen.getByRole("button", { name: "Export clip" })).toBeTruthy();
    expect(exportButton().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Hide inspector" }).getAttribute("aria-expanded")).toBe("true");
    expect(store.settings.visible).toBe(false);

    fireEvent.click(exportButton());
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(exportButton().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Show inspector" }).getAttribute("aria-expanded")).toBe("false");
    expect(store.settings.visible).toBe(false);
    // Opening and closing Export never touches the saved layout.
    expect(write).not.toHaveBeenCalled();
  });

  it("opens the drawer for Export in a narrow window", () => {
    size(1024, 768);
    const write = jest.spyOn(store, "changeSettings");
    const { container } = render(<Analyzer />);
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();

    fireEvent.click(exportButton());
    expect(inspectorMode()).toBe("export");
    expect(screen.getByRole("button", { name: "Export clip" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide inspector" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("separator")).toBeNull();
    // The drawer overlays the stage; the grid keeps its single column.
    expect(columns(container)).toBe("minmax(0, 1fr)");

    fireEvent.click(exportButton());
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
  });

  it("the edge handle closes Export and hides the inspector", () => {
    size(1440, 782);
    const { container } = render(<Analyzer />);
    fireEvent.click(exportButton());
    expect(inspectorMode()).toBe("export");
    // The clock follows the session: playback is bounded at the end of the (whole-replay) clip.
    expect(clock.playbackBoundaryInMs).toBe(100_000);

    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(exportButton().getAttribute("aria-pressed")).toBe("false");
    expect(store.settings.visible).toBe(false);
    expect(clock.playbackBoundaryInMs).toBeUndefined();
    // Showing it again brings back the incidents, not Export.
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(inspectorMode()).toBe("incidents");
    expect(store.settings.visible).toBe(true);
  });

  it("the edge handle, used in Settings opened from Export, ends the session and hides the inspector", () => {
    size(1440, 782);
    const { container } = render(<Analyzer />);
    // The viewer's speed; the clip previews at its own while the session lasts.
    act(() => clock.setSpeed(1.5));
    fireEvent.click(exportButton());
    expect(clock.speed).toBe(1);
    expect(clock.playbackBoundaryInMs).toBe(100_000);
    fireEvent.click(screen.getByRole("button", { name: "Clip display settings" }));
    expect(inspectorMode()).toBe("settings");
    // Still the export session: the dock's button reads as pressed and the preview still runs.
    expect(exportButton().getAttribute("aria-pressed")).toBe("true");
    expect(mockInspector.current?.exportSession).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
    expect(columns(container)).toBe("minmax(0, 1fr)");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(mockInspector.current?.mode).toBe("incidents");
    // The session really ended: the dock's own flag is off (it shows the speed stepper again only then; Dock.spec covers
    // the stepper) and the viewer's transport is back on the clock.
    expect(mockInspector.current?.exportSession).toBe(false);
    expect(exportButton().getAttribute("aria-pressed")).toBe("false");
    expect(clock.speed).toBe(1.5);
    expect(clock.playbackBoundaryInMs).toBeUndefined();
    expect(store.settings.visible).toBe(false);
    // Showing it again brings back the incidents.
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(inspectorMode()).toBe("incidents");
  });

  it("dims the stage only while a clip is exporting", () => {
    size(1440, 782);
    render(<Analyzer />);
    const dim = () => screen.queryByTestId("export-dim");
    expect(dim()).toBeNull();
    fireEvent.click(exportButton());
    // Open for set-up is not exporting.
    expect(dim()).toBeNull();

    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    for (const busy of ["preparing", "recording", "rendering", "saving"]) {
      status(busy);
      const layer = dim() as HTMLElement;
      expect([busy, layer !== null]).toEqual([busy, true]);
      expect(layer.getAttribute("aria-hidden")).toBe("true");
      expect(getComputedStyle(layer).pointerEvents).toBe("none");
      expect(getComputedStyle(layer).position).toBe("absolute");
      expect(getComputedStyle(layer).backgroundColor).toBe("rgba(11, 11, 13, 0.45)");
      // In the stage cell, above the canvas and the stats overlay and below the inspector toggle.
      expect(layer.parentElement).toBe(screen.getByTestId("stage").parentElement);
      expect(follows(screen.getByTestId("stage"), layer)).toBe(true);
      expect(follows(screen.getByTestId("stats"), layer)).toBe(true);
      expect(follows(layer, screen.getByRole("button", { name: "Hide inspector" }))).toBe(true);
    }
    for (const over of ["done", "cancelled", "error", "idle"]) {
      status(over);
      expect([over, dim()]).toEqual([over, null]);
    }
  });

  it("paints the dim above the stats overlay and below the inspector toggle and the drawer", () => {
    const zIndexOf = (element: Element) => getComputedStyle(element).zIndex;
    const z = (element: Element) => Number(zIndexOf(element));
    /** The nearest ancestor that sets a z-index of its own: the drawer's frame. */
    const stackingAncestor = (element: Element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (!Number.isNaN(z(node)) && zIndexOf(node) !== "") return node;
      }
      throw new Error("no ancestor sets a z-index");
    };
    size(1440, 782);
    const column = render(<Analyzer />);
    fireEvent.click(exportButton());
    status("rendering");
    const layer = screen.getByTestId("export-dim");
    const scrim = screen.getByTestId("stats-scrim");
    const readout = screen.getByRole("complementary", { name: "Replay stats" });
    const toggle = screen.getByRole("button", { name: "Hide inspector" });
    // The overlay and the toggle really carry z-indexes here, so the comparisons below are not against nothing.
    expect(z(scrim)).toBeGreaterThan(0);
    expect(z(readout)).toBeGreaterThan(z(scrim));
    expect(z(toggle)).toBeGreaterThan(z(readout));
    expect(z(layer)).toBeGreaterThan(z(readout));
    expect(z(layer)).toBeGreaterThan(z(scrim));
    expect(z(layer)).toBeLessThan(z(toggle));
    column.unmount();
    status("idle", 0);

    // The drawer in a narrow window.
    size(1024, 768);
    render(<Analyzer />);
    fireEvent.click(exportButton());
    status("rendering");
    const drawer = stackingAncestor(screen.getByTestId("inspector"));
    const narrowLayer = screen.getByTestId("export-dim");
    expect(z(drawer)).toBeGreaterThan(z(screen.getByRole("complementary", { name: "Replay stats" })));
    expect(z(narrowLayer)).toBeGreaterThan(z(screen.getByRole("complementary", { name: "Replay stats" })));
    expect(z(narrowLayer)).toBeLessThan(z(drawer));
    expect(z(narrowLayer)).toBeLessThan(z(screen.getByRole("button", { name: "Hide inspector" })));
  });

  it("keeps the Export panel and the lock when the inspector moves between column and drawer during an export", () => {
    const window$ = observeResizes();
    try {
      size(1440, 782);
      const { container } = render(<Analyzer />);
      fireEvent.click(exportButton());
      setRange(20_000, 50_000);
      expect(clock.playbackBoundaryInMs).toBe(50_000);
      const run: ClipRunSummary = {
        startMs: 20_000,
        endMs: 50_000,
        width: 1920,
        fps: 60,
        audio: true,
        speed: 1,
        frameCount: 480,
        durationSeconds: 8,
      };
      (mockApp.clipRecorder as { run$: BehaviorSubject<ClipRunSummary | undefined> }).run$.next(run);
      status("rendering", 0.25);
      /** What the exporting view says, from the recorder alone: it is drawn again after every remount. */
      const exportingView = () => {
        expect(screen.getByRole("button", { name: "Cancel export" })).toBeTruthy();
        expect(screen.getByText("120 / 480 frames")).toBeTruthy();
        expect(screen.getByText("39%")).toBeTruthy();
        expect(screen.getByRole("progressbar", { name: "Export progress" }).getAttribute("aria-valuenow")).toBe("39");
      };
      exportingView();
      expect(columns(container)).toBe("minmax(0, 1fr) 260px");
      const transport = [playback.seekTo, playback.start, playback.pause];
      transport.forEach((spy) => spy.mockClear());
      const setBoundary = jest.spyOn(clock, "setPlaybackBoundary");
      const setSpeed = jest.spyOn(clock, "setSpeed");

      // Column -> drawer: Export is still the mode, the exporting view is still there, and every control stays locked.
      window$.resize(1024, 768);
      expect(columns(container)).toBe("minmax(0, 1fr)");
      expect(screen.queryByRole("separator")).toBeNull();
      expect(inspectorMode()).toBe("export");
      exportingView();
      expect(screen.getByRole("button", { name: "Hide inspector" }).getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByTestId("export-dim")).toBeTruthy();
      fireEvent.click(exportButton());
      fireEvent.click(gear());
      fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
      expect(inspectorMode()).toBe("export");
      exportingView();
      expect(exportButton().getAttribute("aria-pressed")).toBe("true");

      // Drawer -> column: the same.
      window$.resize(1440, 782);
      expect(columns(container)).toBe("minmax(0, 1fr) 260px");
      expect(inspectorMode()).toBe("export");
      exportingView();
      fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
      fireEvent.click(exportButton());
      expect(inspectorMode()).toBe("export");
      expect(columns(container)).toBe("minmax(0, 1fr) 260px");

      // Moving the inspector never touched the clock, and the saved layout is as it was.
      transport.forEach((spy) => expect(spy).not.toHaveBeenCalled());
      expect(setBoundary).not.toHaveBeenCalled();
      expect(setSpeed).not.toHaveBeenCalled();
      expect(clock.playbackBoundaryInMs).toBe(50_000);
      expect(store.settings.visible).toBe(true);
      expect(mockInspector.current?.exportRange).toEqual({ startMs: 20_000, endMs: 50_000 });

      // The lock lifts with the recorder, not with the layout.
      status("idle", 0);
      fireEvent.click(exportButton());
      expect(mockInspector.current?.mode).toBe("incidents");
    } finally {
      window$.restore();
    }
  });

  it("closes Export when another replay is loaded", async () => {
    size(1440, 782);
    render(<Analyzer />);
    fireEvent.click(exportButton());
    setRange(20_000, 50_000);
    expect(inspectorMode()).toBe("export");
    expect(clock.playbackBoundaryInMs).toBe(50_000);
    [playback.seekTo, playback.start, playback.pause].forEach((spy) => spy.mockClear());

    // The simulator announces the new replay before it drops the old one; the session still ends.
    primaryReplay = { id: "second replay" };
    await act(async () => {
      replayEvents$.next([]);
    });
    expect(inspectorMode()).toBe("incidents");
    expect(mockInspector.current?.exportRange).toBeNull();
    expect(exportButton().getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: "Export clip" })).toBeNull();
    // The new replay's clock is given nothing of the old clip: no seek, play or pause.
    [playback.seekTo, playback.start, playback.pause].forEach((spy) => expect(spy).not.toHaveBeenCalled());

    // And the next session is a fresh one on the whole new replay.
    fireEvent.click(exportButton());
    expect(mockInspector.current?.exportRange).toBeNull();
    expect(clock.playbackBoundaryInMs).toBe(100_000);
  });

  it("returns to set-up with the range kept after a cancelled export", async () => {
    size(1440, 782);
    const recorder = mockApp.clipRecorder as { exportClip: jest.Mock; cancel: jest.Mock };
    render(<Analyzer />);
    fireEvent.click(exportButton());
    setRange(20_000, 50_000);
    const setUp = fields();
    expect(clock.playbackBoundaryInMs).toBe(50_000);

    fireEvent.click(screen.getByRole("button", { name: "Export clip" }));
    expect(recorder.exportClip).toHaveBeenCalledTimes(1);
    status("preparing", 0);
    status("recording", 0.3);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("export-dim")).toBeTruthy();
    fireEvent.click(gear());
    expect(inspectorMode()).toBe("export");

    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    status("cancelled", 0.3);

    // Back to set-up, on the same range, still in the Export session.
    expect(inspectorMode()).toBe("export");
    expect(screen.getByText("Export cancelled.", { selector: "p" })).toBeTruthy();
    expect(screen.queryByTestId("export-dim")).toBeNull();
    expect(fields()).toEqual(setUp);
    expect(mockInspector.current?.exportRange).toEqual({ startMs: 20_000, endMs: 50_000 });
    expect(clock.playbackBoundaryInMs).toBe(50_000);
    expect(exportButton().getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Export clip" }) as HTMLButtonElement).disabled).toBe(false);

    // The lock is gone: Settings opens and returns to the same set-up.
    fireEvent.click(gear());
    expect(inspectorMode()).toBe("settings");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(inspectorMode()).toBe("export");
    expect(fields()).toEqual(setUp);
    await act(async () => undefined);
  });
});
