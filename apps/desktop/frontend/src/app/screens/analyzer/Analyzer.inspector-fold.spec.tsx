import "reflect-metadata";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { BehaviorSubject } from "rxjs";
import type { ReplayAnalysisEvent } from "@osujs/core";
import { AnalysisCursorSettingsStore } from "../../services/analysis/analysis-cursor";
import { ClipExportSettingsStore } from "../../services/analysis/clip-export-settings";
import { ReplayDisplaySettingsStore } from "../../services/analysis/replay-display-settings";
import { ErrorOutlineStore } from "../../services/common/error-outline";
import { InspectorLayoutSettingsStore } from "../../services/analysis/inspector-layout-settings";
import { BeatmapBackgroundSettingsStore } from "../../services/common/beatmap-background";
import { GameplayClock } from "../../services/common/game/GameplayClock";
import { PlaybarSettingsStore } from "../../services/common/playbar";
import { ReplayCursorSettingsStore } from "../../services/common/replay-cursor";
import type { ReplayLoadState } from "../../services/manager/replay-load-state";
import { Analyzer } from "./Analyzer";

// The real Analyzer, ErrorNavigationProvider, InspectorProvider, Inspector, SettingsPanel and its tabs, IncidentBlock,
// IncidentsList, DensityBar, InspectorSeparator, InspectorDrawer, ExportPanel, the dock gear and game clock. Replaced: the Pixi
// canvas, the stats overlay, the rest of the dock, the header (its readout needs a whole replay; it is also the place
// where a failure is injected below) and the analysis session that produces causes. The shortcuts are replaced too,
// except in the one test that sets `mockShortcuts.real`.
jest.mock("electron", () => ({ ipcRenderer: { invoke: jest.fn(), send: jest.fn() } }));
const mockShortcuts = { real: false };
jest.mock("../../hooks/shortcuts", () => {
  const actual = jest.requireActual("../../hooks/shortcuts");
  return { useShortcuts: () => (mockShortcuts.real ? actual.useShortcuts() : undefined) };
});
let mockApp: Record<string, unknown>;
let mockCommon: Record<string, unknown>;
jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: () => mockApp, useCommonManagers: () => mockCommon }));
jest.mock("../../components/analyzer/GameCanvas", () => ({ GameCanvas: () => <div data-testid="stage" /> }));
jest.mock("../../components/analyzer/StatsOverlay", () => ({ StatsOverlay: () => <div data-testid="stats">Stats overlay text</div> }));
jest.mock("../../components/analyzer/Dock", () => ({
  Dock: () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SettingsButton } = require("../../components/analyzer/DockIconButtons");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { useInspector } = require("../../providers/InspectorProvider");
    const { exportSession, toggleExport } = useInspector();
    return (
      <div data-testid="dock">
        <button type="button" aria-pressed={exportSession} onClick={toggleExport}>
          Export
        </button>
        <SettingsButton />
      </div>
    );
  },
}));
const mockHeader = { failRender: false, failCleanup: false };
jest.mock("../../components/analyzer/InspectorHeader", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useEffect } = require("react");
  return {
    InspectorHeader: () => {
      useEffect(
        () => () => {
          if (mockHeader.failCleanup) throw new Error("header cleanup failure");
        },
        [],
      );
      if (mockHeader.failRender) throw new Error("header render failure");
      return <header>Header text</header>;
    },
  };
});
// One cause per error: a late tap with a timed hit-window diagram, then the notelock it causes.
jest.mock("../../components/analyzer/error-cause", () => {
  const base = { status: "supported", description: "", eventIds: [], limitations: [] };
  const late = { ...base, headline: "Late tap", codes: ["late-tap"], metric: { value: 43, unit: "ms late" } };
  const lock = { ...base, headline: "Notelock", codes: ["notelock"] };
  return { selectedErrorCauses: (error: { id: string }) => (error.id === "miss:c" ? [late] : error.id === "miss:d" ? [lock] : []) };
});

const judgement = (id: string, time: number, blocker?: string): ReplayAnalysisEvent =>
  ({
    type: "HitObjectJudgement",
    eventId: `stable:${id}`,
    ruleset: "stable",
    time,
    objectTime: time,
    judgementTime: time,
    hitObjectId: id,
    verdict: "MISS",
    position: { x: 0, y: 0 },
    ...(blocker ? { notelockCause: { blockerHitObjectId: blocker } } : {}),
  } as unknown as ReplayAnalysisEvent);

/** Three incidents; the third is a miss and the miss it locks: "Late tap" with a diagram, then "Notelock". */
const events = [judgement("a", 10_000), judgement("b", 20_000), judgement("c", 30_000), judgement("d", 30_100, "c")];

/** What the app does not have: anything above the analyzer that would keep the window alive. */
class Catcher extends Component<{ children: ReactNode; onError(error: Error, stack: string): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    this.props.onError(error, info.componentStack ?? "");
  }
  render() {
    return this.state.failed ? <div data-testid="blank" /> : this.props.children;
  }
}

function pointer(element: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", init: { pointerId: number; clientX?: number; button?: number }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, button: init.button ?? 0 });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  fireEvent(element, event);
}

const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
function size(width: number, height: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => height });
}

let notifyResize: () => void = () => undefined;
const originalObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockHeader.failRender = false;
  mockHeader.failCleanup = false;
  consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(callback: () => void) {
      notifyResize = callback;
    }
    observe = jest.fn();
    disconnect = jest.fn();
  };
  mockShortcuts.real = false;
  window.localStorage.clear();
  const replay = {};
  const gameClock = new GameplayClock();
  gameClock.setDuration(100_000);
  mockApp = {
    initialize: jest.fn().mockResolvedValue(undefined),
    loadReplay: jest.fn(),
    inspectorLayoutSettingsStore: new InspectorLayoutSettingsStore(),
    replayDisplaySettingsStore: new ReplayDisplaySettingsStore(),
    errorOutlineStore: new ErrorOutlineStore(),
    clipExportSettingsStore: new ClipExportSettingsStore(),
    clipRecorder: {
      state$: new BehaviorSubject({ status: "idle", progress: 0 }),
      run$: new BehaviorSubject(undefined),
      isBusy: false,
      getFormat: () => ({ mimeType: "video/mp4", extension: "mp4", label: "MP4 (H.264)" }),
      exportClip: jest.fn(),
      cancel: jest.fn(),
    },
    modSettingsService: { modSettings$: new BehaviorSubject({ flashlight: false, hidden: false }), setHidden: jest.fn() },
    gameClock,
    getBeatmap: () => ({ gameClockRate: 1, stableOverallDifficulty: 8, difficulty: { overallDifficulty: 8 } }),
    scenarioManager: { loadState$: new BehaviorSubject<ReplayLoadState>({ phase: "ready" }) },
    gameSimulator: {
      replayEvents$: new BehaviorSubject(events),
      rulesetFocus$: new BehaviorSubject("stable"),
      replayComparison$: new BehaviorSubject({ status: "EMPTY" }),
      missExplanations$: new BehaviorSubject({ status: "not-captured", reasons: ["capture-disabled"] }),
      missAnalysisProgress$: new BehaviorSubject(undefined),
      getPrimaryReplay: () => replay,
      getPrimaryBeatmap: () => undefined,
      hasReplayForMissAnalysis: () => false,
      analyzeMisses: jest.fn(),
    },
  };
  mockCommon = {
    replayCursorSettingsStore: new ReplayCursorSettingsStore(),
    analysisCursorSettingsStore: new AnalysisCursorSettingsStore(),
    beatmapBackgroundSettingsStore: new BeatmapBackgroundSettingsStore(),
    playbarSettingsStore: new PlaybarSettingsStore(),
  };
});

afterEach(() => {
  consoleError.mockRestore();
  document.documentElement.style.userSelect = "";
  document.getSelection()?.removeAllRanges();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalObserver;
  if (originalWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", originalWidth);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  if (originalHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalHeight);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

function resize(width: number, height: number) {
  size(width, height);
  act(() => notifyResize());
}

function renderAnalyzer(caught: { error: Error; stack: string }[]) {
  return render(
    <Catcher onError={(error, stack) => caught.push({ error, stack })}>
      <Analyzer />
    </Catcher>,
  );
}

function selectStart() {
  const event = new Event("selectstart", { bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event.defaultPrevented;
}

const inspectorErrors = () => consoleError.mock.calls.filter((call) => call[0] === "The inspector hit an error.");

describe("Analyzer: separator drag, a selected incident and the fold, with the real inspector tree", () => {
  // The black window was reported for this sequence in the app. It does not throw in jsdom (before or after the fix;
  // see crash-report.md), so this pins the whole sequence against any error that does: nothing may reach the top, the
  // stage and the dock stay, and the inspector folds away.
  it.each([
    [{ drag: 1060, focus: true, select: true, pick: 2 }],
    [{ drag: 1060, focus: false, select: true, pick: 2 }],
    [{ drag: 800, focus: true, select: true, pick: 2 }],
    [{ drag: 1100, focus: true, select: true, pick: 0 }],
  ])("drag, select an incident, shrink to the fold %j", ({ drag, focus, select, pick }) => {
    const caught: { error: Error; stack: string }[] = [];
    size(1440, 900);
    renderAnalyzer(caught);
    const separator = screen.getByRole("separator", { name: "Resize inspector" });
    pointer(separator, "pointerdown", { pointerId: 1, button: 0, clientX: 1100 });
    pointer(separator, "pointermove", { pointerId: 1, clientX: drag });
    pointer(separator, "pointerup", { pointerId: 1, clientX: drag });
    if (focus) separator.focus();
    if (select) {
      const range = document.createRange();
      range.setStart(screen.getByTestId("stats").firstChild as Node, 2);
      range.setEnd(screen.getByText("Incidents").firstChild as Node, 3);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
    }
    fireEvent.click(screen.getAllByRole("listitem")[pick].querySelector("button") as HTMLElement);
    if (pick === 2) expect(screen.getByText("3–4/4")).toBeTruthy();
    resize(1280, 720);
    expect(screen.getByRole("separator")).toBeTruthy();
    resize(1024, 768);
    expect(caught).toEqual([]);
    expect(screen.queryByTestId("blank")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByRole("region", { name: "Current incident" })).toBeNull();
    expect(screen.getByTestId("stage")).toBeTruthy();
    expect(screen.getByTestId("dock")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show inspector" })).toBeTruthy();
    expect(inspectorErrors()).toEqual([]);
  });

  it("does not let the drag select page text, and gives the page its selection back afterwards", () => {
    size(1440, 900);
    renderAnalyzer([]);
    const separator = screen.getByRole("separator", { name: "Resize inspector" });
    pointer(separator, "pointerdown", { pointerId: 1, button: 0, clientX: 1100 });
    pointer(separator, "pointermove", { pointerId: 1, clientX: 1060 });
    // Mid-drag the layout re-renders around the strip; the lock must survive that.
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("300");
    expect(document.documentElement.style.userSelect).toBe("none");
    expect(selectStart()).toBe(true);
    pointer(separator, "pointerup", { pointerId: 1, clientX: 1060 });
    expect(document.documentElement.style.userSelect).toBe("");
    expect(selectStart()).toBe(false);
  });

  it("gives the selection back when the window folds the column in the middle of a drag", () => {
    const caught: { error: Error; stack: string }[] = [];
    size(1440, 900);
    renderAnalyzer(caught);
    const separator = screen.getByRole("separator", { name: "Resize inspector" });
    pointer(separator, "pointerdown", { pointerId: 1, button: 0, clientX: 1100 });
    pointer(separator, "pointermove", { pointerId: 1, clientX: 1050 });
    resize(1024, 768);
    expect(screen.queryByRole("separator")).toBeNull();
    expect(document.documentElement.style.userSelect).toBe("");
    expect(selectStart()).toBe(false);
    expect(caught).toEqual([]);
  });
});

describe("Analyzer: an inspector error does not blank the window", () => {
  it("shows one line with a reload button in the column, keeps the stage and the dock, and recovers", () => {
    const caught: { error: Error; stack: string }[] = [];
    size(1440, 900);
    mockHeader.failRender = true;
    renderAnalyzer(caught);
    expect(caught).toEqual([]);
    expect(screen.getByRole("alert").textContent).toBe("The inspector hit an error.Reload inspector");
    expect(screen.getByTestId("stage")).toBeTruthy();
    expect(screen.getByTestId("dock")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide inspector" })).toBeTruthy();
    expect(inspectorErrors()).toHaveLength(1);
    mockHeader.failRender = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload inspector" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Header text")).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
  });

  it("survives an error thrown while the column folds away, and the inspector is back when it unfolds", () => {
    const caught: { error: Error; stack: string }[] = [];
    size(1440, 900);
    renderAnalyzer(caught);
    mockHeader.failCleanup = true;
    resize(1024, 768);
    mockHeader.failCleanup = false;
    expect(caught).toEqual([]);
    expect(screen.queryByTestId("blank")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("stage")).toBeTruthy();
    expect(screen.getByTestId("dock")).toBeTruthy();
    expect(inspectorErrors()).toHaveLength(1);
    resize(1440, 900);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Header text")).toBeTruthy();
  });

  it("shows the message in the drawer and keeps its handle", () => {
    const caught: { error: Error; stack: string }[] = [];
    size(1024, 768);
    renderAnalyzer(caught);
    mockHeader.failRender = true;
    fireEvent.click(screen.getByRole("button", { name: "Show inspector" }));
    expect(caught).toEqual([]);
    expect(screen.getByRole("alert").textContent).toBe("The inspector hit an error.Reload inspector");
    expect(screen.getByRole("button", { name: "Hide inspector" })).toBeTruthy();
    expect(screen.getByTestId("dock")).toBeTruthy();
    mockHeader.failRender = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload inspector" }));
    expect(screen.getByText("Header text")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Header text")).toBeNull();
  });
});

describe("Analyzer: Settings in the real inspector", () => {
  const gear = () => screen.getByRole("button", { name: "Settings" });

  it("shows the panel in the column and brings the same incident back when it is closed", () => {
    size(1440, 900);
    renderAnalyzer([]);
    fireEvent.click(screen.getAllByRole("listitem")[2].querySelector("button") as HTMLElement);
    expect(screen.getByText("3–4/4")).toBeTruthy();

    fireEvent.click(gear());
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Inspector" }).contains(screen.getByRole("region", { name: "Settings" }))).toBe(true);
    expect(screen.queryByText("Header text")).toBeNull();
    expect(screen.queryByText("3–4/4")).toBeNull();
    // The separator belongs to the column, not to either mode.
    expect(screen.getByRole("separator", { name: "Resize inspector" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(screen.getByText("Header text")).toBeTruthy();
    expect(screen.getByText("3–4/4")).toBeTruthy();
  });

  it("with a replay loaded, Space on a focused settings toggle plays or pauses and leaves the toggle alone, and Enter changes the toggle", () => {
    mockShortcuts.real = true;
    size(1440, 900);
    const toggleClock = jest.spyOn(mockApp.gameClock as GameplayClock, "toggle").mockImplementation(() => undefined);
    const cursorStore = mockCommon.replayCursorSettingsStore as ReplayCursorSettingsStore;
    renderAnalyzer([]);
    fireEvent.click(gear());
    const control = screen.getByRole("switch", { name: "Show cursor" });
    const before = cursorStore.settings.enabled;
    act(() => control.focus());

    // Space is taken by the playback shortcut at the window, before the control sees it (press and release).
    expect(fireEvent.keyDown(control, { key: " ", code: "Space" })).toBe(false);
    expect(fireEvent.keyUp(control, { key: " ", code: "Space" })).toBe(false);
    expect(toggleClock).toHaveBeenCalledTimes(1);
    expect(cursorStore.settings.enabled).toBe(before);
    expect(control.getAttribute("aria-checked")).toBe(String(before));

    // Enter still activates the focused toggle, and does not touch playback.
    fireEvent.keyDown(control, { key: "Enter", code: "Enter" });
    fireEvent.keyUp(control, { key: "Enter", code: "Enter" });
    expect(cursorStore.settings.enabled).toBe(!before);
    expect(control.getAttribute("aria-checked")).toBe(String(!before));
    expect(toggleClock).toHaveBeenCalledTimes(1);
  });

  it("changing the Exported clip target leaves the viewer store untouched", () => {
    size(1440, 900);
    const viewerStore = mockApp.replayDisplaySettingsStore as ReplayDisplaySettingsStore;
    const clipStore = mockApp.clipExportSettingsStore as ClipExportSettingsStore;
    renderAnalyzer([]);
    fireEvent.click(gear());
    fireEvent.click(screen.getByRole("tab", { name: "Display" }));
    const viewerBefore = JSON.stringify(viewerStore.settings);
    const clipBefore = JSON.stringify(clipStore.settings);

    fireEvent.click(within(screen.getByRole("group", { name: "Settings for" })).getByRole("button", { name: "Exported clip" }));
    // Picking the target writes nothing; nothing is copied between the stores.
    expect(JSON.stringify(viewerStore.settings)).toBe(viewerBefore);
    expect(JSON.stringify(clipStore.settings)).toBe(clipBefore);

    const unstableRate = within(screen.getByRole("group", { name: "Timing" })).getByRole("checkbox", { name: "UR" });
    const urBefore = clipStore.settings.displaySettings.unstableRateEnabled;
    fireEvent.click(unstableRate);
    expect(clipStore.settings.displaySettings.unstableRateEnabled).toBe(!urBefore);
    expect(JSON.stringify(viewerStore.settings)).toBe(viewerBefore);
  });
});

describe("Analyzer: the stage while the inspector changes mode", () => {
  const gear = () => screen.getByRole("button", { name: "Settings" });
  const exportButton = () => screen.getByRole("button", { name: "Export" });
  /** Everything that decides the stage cell's size: the grid it sits in and the cell's own sizing rules. */
  function stageCell() {
    const cell = screen.getByTestId("stage").parentElement as HTMLElement;
    const grid = cell.parentElement as HTMLElement;
    const own = getComputedStyle(cell);
    const gridStyle = getComputedStyle(grid);
    return {
      columns: gridStyle.gridTemplateColumns,
      rows: gridStyle.gridTemplateRows,
      cell: [own.position, own.overflow, own.minWidth, own.minHeight, own.width, own.height, own.gridColumn, own.gridRow],
      className: cell.className,
      stageChildren: Array.from(cell.children).filter((child) => child.getAttribute("data-testid") === "stage").length,
    };
  }

  it.each([
    ["a visible column", 1440, 900, true],
    ["a hidden column that the modes show", 1440, 900, false],
    ["the drawer", 1024, 768, true],
  ])("never changes the stage cell's size when the mode changes between incidents, Settings and Export (%s)", (_, width, height, visible) => {
    size(width, height);
    (mockApp.inspectorLayoutSettingsStore as InspectorLayoutSettingsStore).changeSettings((draft) => {
      draft.visible = visible;
    });
    renderAnalyzer([]);
    const incidents = stageCell();
    const seen: ReturnType<typeof stageCell>[] = [];

    // incidents -> Settings -> Export -> Settings opened from Export -> Export -> incidents
    fireEvent.click(gear());
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    seen.push(stageCell());
    fireEvent.click(exportButton());
    expect(screen.getByRole("region", { name: "Export clip" })).toBeTruthy();
    seen.push(stageCell());
    fireEvent.click(screen.getByRole("button", { name: "Clip display settings" }));
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    seen.push(stageCell());
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("region", { name: "Export clip" })).toBeTruthy();
    seen.push(stageCell());

    // A column that is already shown, and the drawer that overlays the stage, leave the stage exactly as it was in the
    // incidents. A hidden column is revealed once by the first mode; from then on the stage keeps that one size.
    const reference = visible ? incidents : seen[0];
    seen.forEach((state) => expect(state).toEqual(reference));

    fireEvent.click(exportButton());
    expect(screen.queryByRole("region", { name: "Export clip" })).toBeNull();
    expect(stageCell()).toEqual(incidents);
  });
});
