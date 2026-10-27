import "reflect-metadata";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import type { ReplayAnalysisEvent } from "@osujs/core";
import { ErrorNavigationProvider } from "../../hooks/error-navigation";
import { InspectorProvider, useInspector, type InspectorState } from "../../providers/InspectorProvider";
import { ClipExportSettingsStore } from "../../services/analysis/clip-export-settings";
import { ReplayDisplaySettingsStore } from "../../services/analysis/replay-display-settings";
import { GameplayClock } from "../../services/common/game/GameplayClock";
import type { ReplayLoadState } from "../../services/manager/replay-load-state";
import { Inspector } from "./Inspector";

// The real Inspector, ErrorNavigationProvider, IncidentBlock, IncidentsList, ExportPanel and InspectorProvider. Replaced:
// the header (its readout needs a whole replay), the cause classifier and the Settings panel (its own spec covers it).
jest.mock("electron", () => ({ ipcRenderer: { invoke: jest.fn(), send: jest.fn() } }));
jest.mock("../../api", () => ({
  frontendAPI: { openExportedClip: jest.fn(), showExportedClip: jest.fn() },
}));
let mockApp: Record<string, unknown>;
jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: () => mockApp }));
jest.mock("./InspectorHeader", () => ({ InspectorHeader: () => <header>Header text</header> }));
jest.mock("../settings/SettingsPanel", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useInspector: useMockInspector } = require("../../providers/InspectorProvider");
  return {
    SettingsPanel: () => {
      const { closeSettings } = useMockInspector();
      return (
        <section aria-label="Settings">
          <button onClick={closeSettings}>Close settings</button>
        </section>
      );
    },
  };
});
jest.mock("./error-cause", () => {
  const base = { status: "supported", description: "", eventIds: [], limitations: [] };
  const late = { ...base, headline: "Late tap", codes: ["late-tap"], metric: { value: 43, unit: "ms late" } };
  const lock = { ...base, headline: "Notelock", codes: ["notelock"] };
  return {
    selectedErrorCauses: (error: { id: string }) =>
      error.id === "miss:c" ? [late] : error.id === "miss:d" ? [lock] : [],
  };
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

/** Three incidents; the third is a miss and the miss it locks. */
const events = [judgement("a", 10_000), judgement("b", 20_000), judgement("c", 30_000), judgement("d", 30_100, "c")];

let loadState: BehaviorSubject<ReplayLoadState>;
let inspector: InspectorState;
function Capture() {
  inspector = useInspector();
  return null;
}

const originalObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe = jest.fn();
    disconnect = jest.fn();
  };
  loadState = new BehaviorSubject<ReplayLoadState>({ phase: "ready" });
  const replay = {};
  const gameClock = new GameplayClock();
  gameClock.setDuration(100_000);
  mockApp = {
    replayDisplaySettingsStore: new ReplayDisplaySettingsStore(),
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
    scenarioManager: { loadState$: loadState },
    gameSimulator: {
      replayEvents$: new BehaviorSubject(events),
      rulesetFocus$: new BehaviorSubject("stable"),
      missExplanations$: new BehaviorSubject({ status: "not-captured", reasons: ["capture-disabled"] }),
      missAnalysisProgress$: new BehaviorSubject(undefined),
      getPrimaryReplay: () => replay,
      hasReplayForMissAnalysis: () => false,
      analyzeMisses: jest.fn(),
    },
  };
});
afterEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalObserver;
});

function mount(initialMode: "incidents" | "settings" | "export" = "incidents") {
  return render(
    <InspectorProvider initialMode={initialMode}>
      <Capture />
      <ErrorNavigationProvider>
        <Inspector />
      </ErrorNavigationProvider>
    </InspectorProvider>,
  );
}

describe("Inspector modes", () => {
  it("shows the incidents by default", () => {
    mount();
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
    expect(screen.getByText("Header text")).toBeTruthy();
    expect(screen.getByText("Incidents")).toBeTruthy();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
  });

  it("shows Settings in place of the header and the incidents", () => {
    mount("settings");
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByText("Header text")).toBeNull();
    expect(screen.queryByText("Incidents")).toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Current incident" })).toBeNull();
  });

  it.each<ReplayLoadState>([
    { phase: "idle" },
    { phase: "loading", step: "simulate" } as ReplayLoadState,
    { phase: "failed", failure: { kind: "other", message: "x" } },
  ])("shows Settings with no replay loaded ($phase)", (state) => {
    loadState.next(state);
    mount("settings");
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByText("Header text")).toBeNull();
    expect(screen.queryByText("The map, player and incidents appear here once a replay is open.")).toBeNull();
    expect(screen.queryByText("Nothing to show until the replay loads.")).toBeNull();
    expect(screen.queryByText("Waiting for simulation")).toBeNull();
  });

  it("returns to the same inspected incident after Settings closes", () => {
    mount();
    fireEvent.click(screen.getAllByRole("listitem")[2].querySelector("button") as HTMLElement);
    expect(screen.getByText("3–4/4")).toBeTruthy();

    act(() => inspector.openSettings());
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByText("3–4/4")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(screen.getByText("3–4/4")).toBeTruthy();
    expect(screen.getByText("Header text")).toBeTruthy();
  });

  it("shows the Export panel in export mode and Settings in settings mode", () => {
    mount("export");
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
    // The panel replaces the header and the incidents, as Settings do.
    expect(screen.getByRole("region", { name: "Export clip" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export clip" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(screen.queryByText("Header text")).toBeNull();
    expect(screen.queryByText("Incidents")).toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);

    act(() => inspector.openSettings());
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Export clip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export clip" })).toBeNull();
    expect(screen.queryByText("Header text")).toBeNull();

    act(() => inspector.closeMode());
    expect(screen.getByText("Header text")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Export clip" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
  });

  it("returns from Clip display settings to the Export panel with the range kept", () => {
    mount("export");
    act(() => inspector.setExportRange({ startMs: 12_500, endMs: 47_250 }));
    const fields = () => ({
      start: (screen.getByRole("textbox", { name: "Start" }) as HTMLInputElement).value,
      end: (screen.getByRole("textbox", { name: "End" }) as HTMLInputElement).value,
      length: (screen.getByRole("textbox", { name: "Length" }) as HTMLInputElement).value,
    });
    const before = fields();
    expect(before.start).not.toBe(before.end);
    expect(inspector.exportRange).toEqual({ startMs: 12_500, endMs: 47_250 });

    fireEvent.click(screen.getByRole("button", { name: "Clip display settings" }));
    expect(inspector.mode).toBe("settings");
    expect(inspector.displayTarget).toBe("clip");
    expect(inspector.exportSession).toBe(true);
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Export clip" })).toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(inspector.mode).toBe("export");
    expect(inspector.displayTarget).toBe("viewer");
    expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("button", { name: "Export clip" })).toBeTruthy();
    expect(fields()).toEqual(before);
    expect(inspector.exportRange).toEqual({ startMs: 12_500, endMs: 47_250 });
  });
});
