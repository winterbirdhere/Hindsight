import "reflect-metadata";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import { frontendAPI } from "../../api";
import { useShortcuts } from "../../hooks/shortcuts";
import { InspectorProvider, useInspector, type InspectorState } from "../../providers/InspectorProvider";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { ClipExportSettingsStore, clipAppearanceOptions } from "../../services/analysis/clip-export-settings";
import { GameplayClock } from "../../services/common/game/GameplayClock";
import {
  createClipFramePlan,
  type ClipExportFormat,
  type ClipExportOptions,
  type ClipRecorderState,
  type ClipRunSummary,
} from "../../services/manager/clip-export-types";
import { formatClipSeconds, parseClipTime, type ClipRange } from "../../services/manager/clip-range";
import { REWIND_COLORS } from "../../styles/tokens";
import { ALLOWED_SPEEDS } from "../../utils/constants";
import { SpeedStepper } from "../analyzer/SpeedStepper";
import { ExportPanel } from "./ExportPanel";

jest.mock("../../providers/TheaterProvider", () => ({
  useAnalysisApp: jest.fn(),
  // The shortcuts read the held speed and the scroll step from the playbar settings.
  useCommonManagers: jest.fn(() => ({ playbarSettingsStore: { settings: { difficultyGraphEnabled: true, scrollStep: "auto", holdSpeed: 0.5 } } })),
}));
// The steps are tested with their own hook. Here a key only has to reach the replay or not: a note step moves the
// clock by the 16 ms it used to.
jest.mock("../../hooks/playback-steps", () => ({
  usePlaybackWheel: jest.fn(),
  usePlaybackSteps: () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { gameClock } = require("../../providers/TheaterProvider").useAnalysisApp();
    return { step: (_kind: string, direction: number) => gameClock.seekTo(gameClock.timeElapsedInMs + direction * 16) };
  },
}));
/** Every range the panel stores goes through this spy, so a test can tell "not applied" from "applied unchanged". */
const mockSetRange = jest.fn();
jest.mock("../../hooks/clip-export", () => {
  const actual = jest.requireActual("../../hooks/clip-export");
  return {
    ...actual,
    useClipExportRange: () => {
      const result = actual.useClipExportRange();
      return {
        ...result,
        setRange: (next: unknown) => {
          mockSetRange(next);
          result.setRange(next);
        },
      };
    },
  };
});
jest.mock("../../api", () => ({
  frontendAPI: {
    openExportedClip: jest.fn().mockResolvedValue(undefined),
    showExportedClip: jest.fn().mockResolvedValue(undefined),
    selectDirectory: jest.fn().mockResolvedValue(null),
  },
}));

const MP4: ClipExportFormat = { mimeType: "video/mp4", extension: "mp4", label: "MP4 (H.264)" };
const BUSY = ["preparing", "recording", "rendering", "saving"];
const RUN: ClipRunSummary = {
  startMs: 62_000,
  endMs: 70_000,
  width: 1920,
  fps: 60,
  audio: true,
  speed: 1,
  frameCount: 480,
  durationSeconds: 8,
};
/** `#ff7082`, which jsdom reports as rgb(). */
const MISS_RGB = "rgb(255, 112, 130)";
const SECONDARY_RGB = "rgb(201, 198, 192)";

let inspector: InspectorState;
function Capture() {
  inspector = useInspector();
  return null;
}
/** The real playback shortcuts, mounted beside the panel as the analyzer shell mounts them. */
function Shortcuts() {
  useShortcuts();
  return null;
}

interface Setup {
  duration?: number;
  baseRate?: number;
  speed?: number;
  /** The range the inspector holds; the whole replay when left out. */
  range?: ClipRange;
  state?: ClipRecorderState;
  run?: ClipRunSummary;
  format?: ClipExportFormat | null;
  shortcuts?: boolean;
  /** The inspector's lock, as the analyzer shell sets it while a replay loads or a clip exports. */
  locked?: boolean;
}

function setup(options: Setup = {}) {
  const gameClock = new GameplayClock();
  gameClock.setDuration(options.duration ?? 10_000);
  gameClock.setBaseRate(options.baseRate ?? 1);
  gameClock.setSpeed(options.speed ?? 1);
  const state$ = new BehaviorSubject<ClipRecorderState>(options.state ?? { status: "idle", progress: 0 });
  const run$ = new BehaviorSubject<ClipRunSummary | undefined>(options.run);
  const format = options.format === undefined ? MP4 : options.format;
  const clipRecorder = {
    state$,
    run$,
    get isBusy() {
      return BUSY.includes(state$.value.status);
    },
    getFormat: jest.fn(() => {
      if (!format) throw new Error("No encoder");
      return format;
    }),
    exportClip: jest.fn().mockResolvedValue(undefined),
    cancel: jest.fn().mockResolvedValue(undefined),
  };
  const clipExportSettingsStore = new ClipExportSettingsStore();
  const modSettingsService = {
    modSettings$: new BehaviorSubject({ flashlight: false, hidden: false }),
    setHidden: jest.fn(),
  };
  const scenarioManager = { loadState$: new BehaviorSubject({ phase: "ready" }) };
  (useAnalysisApp as jest.Mock).mockReturnValue({
    gameClock,
    clipRecorder,
    clipExportSettingsStore,
    modSettingsService,
    scenarioManager,
    gameSimulator: { getPrimaryReplay: () => ({}) },
  });
  const view = render(
    <InspectorProvider initialMode="export" locked={options.locked}>
      <Capture />
      <ExportPanel />
      {options.shortcuts ? <Shortcuts /> : null}
    </InspectorProvider>,
  );
  if (options.range) act(() => inspector.setExportRange(options.range ?? null));
  mockSetRange.mockClear();
  return { gameClock, clipRecorder, clipExportSettingsStore, modSettingsService, state$, run$, view };
}

const field = (name: "Start" | "End" | "Length") => screen.getByRole("textbox", { name }) as HTMLInputElement;
const exportButton = () => screen.getByRole("button", { name: "Export clip" }) as HTMLButtonElement;
const shown = () => ({ start: field("Start").value, end: field("End").value, length: field("Length").value });

/** Focuses a field and types into it, as a user does: the focus stays. */
function type(input: HTMLInputElement, text: string) {
  act(() => input.focus());
  fireEvent.change(input, { target: { value: text } });
}
function leave(input: HTMLInputElement) {
  act(() => input.blur());
}
/** Types a value and leaves the field, which is when it is applied. */
function enter(name: "Start" | "End" | "Length", text: string) {
  const input = field(name);
  type(input, text);
  leave(input);
}
const lastOptions = (clipRecorder: ReturnType<typeof setup>["clipRecorder"]): ClipExportOptions => {
  const call = clipRecorder.exportClip.mock.calls.at(-1);
  if (!call) throw new Error("exportClip was not called");
  return call[0];
};
/** The range the inspector stores once a field has been applied. */
const storedRange = (): ClipRange => {
  if (!inspector.exportRange) throw new Error("no range stored");
  return inspector.exportRange;
};
/** A line of the footer summary: its own element, whose whole text is `text`. */
const summaryLine = (text: string) =>
  screen.getByText((_, element) => element?.tagName === "SPAN" && element.textContent === text);

/** The CSS rules (the at-rules whole) that mention one of the element's generated classes: what the panel declares. */
function declaredRules(element: Element): string[] {
  const classes = Array.from(element.classList).filter((name) => name.startsWith("css-"));
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (classes.some((name) => rule.cssText.includes("." + name))) rules.push(rule.cssText);
    }
  }
  return rules;
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => (useAnalysisApp as jest.Mock).mockReset());

// The cases of the old dialog's spec that still describe real behaviour, now on the panel.
describe("export panel", () => {
  it("exports the full replay by default with the options the dialog built, without starting playback", async () => {
    const { clipRecorder, clipExportSettingsStore, gameClock } = setup({ baseRate: 1.5, speed: 1.25 });
    const start = jest.spyOn(gameClock, "start");
    expect(summaryLine("5.333 s · MP4")).toBeTruthy();
    fireEvent.click(exportButton());
    await waitFor(() => expect(clipRecorder.exportClip).toHaveBeenCalledTimes(1));
    expect(lastOptions(clipRecorder)).toEqual({
      startMs: 0,
      endMs: 10_000,
      speed: 1.25,
      audio: true,
      width: 1920,
      fps: 60,
      ...clipAppearanceOptions(clipExportSettingsStore.settings),
    });
    expect(lastOptions(clipRecorder).preset).toBe("analysis");
    expect(start).not.toHaveBeenCalled();
    expect(gameClock.isPlaying).toBe(false);
  });

  it("freezes the set-up while recording and keeps the export cancellable", () => {
    const { clipRecorder, state$ } = setup();
    expect(screen.getByRole("textbox", { name: "End" })).toBeTruthy();
    act(() => state$.next({ status: "recording", progress: 0.5 }));
    // The set-up controls are not on screen while the recorder is busy: the exporting view replaces them.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Export clip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clip display settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    expect(clipRecorder.cancel).toHaveBeenCalledTimes(1);
  });

  it("opens or reveals only the successfully saved result", async () => {
    const { state$ } = setup();
    expect(screen.queryByRole("button", { name: "Open clip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show in folder" })).toBeNull();
    act(() => state$.next({ status: "done", progress: 1, path: "D:\\clips\\review.webm" }));
    fireEvent.click(screen.getByRole("button", { name: "Open clip" }));
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(frontendAPI.openExportedClip).toHaveBeenCalledWith("D:\\clips\\review.webm"));
    expect(frontendAPI.showExportedClip).toHaveBeenCalledWith("D:\\clips\\review.webm");
    // A finished export without a path has nothing to open.
    act(() => state$.next({ status: "done", progress: 1 }));
    expect(screen.queryByRole("button", { name: "Open clip" })).toBeNull();
  });

  it("keeps the exact fractional replay endpoint when its display rounds to milliseconds", async () => {
    const { clipRecorder } = setup({ duration: 10_000.6 });
    expect(field("End").value).toBe("0:10.001");
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(clipRecorder.exportClip).toHaveBeenCalledWith(expect.objectContaining({ endMs: 10_000.6 })),
    );
  });

  it("shows compact start, end and length values after entering a five-second clip", async () => {
    const { clipRecorder } = setup({ baseRate: 1, speed: 1 });
    enter("Start", "0.000000");
    expect(field("Start").value).toBe("0:00");
    type(field("Length"), "5");
    // Still a draft: nothing but the field itself has changed.
    expect(shown()).toEqual({ start: "0:00", end: "0:10", length: "5" });
    leave(field("Length"));
    expect(shown()).toEqual({ start: "0:00", end: "0:05", length: "5" });
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(clipRecorder.exportClip).toHaveBeenCalledWith(expect.objectContaining({ startMs: 0, endMs: 5_000 })),
    );
  });

  it("puts a cleared Start back on the replay's start and a cleared End on its end when the field is left", () => {
    // The replay is ten seconds long.
    setup({ range: { startMs: 2_000, endMs: 8_000 } });
    enter("Start", "");
    expect(field("Start").value).toBe("0:00");
    expect(inspector.exportRange).toEqual({ startMs: 0, endMs: 8_000 });
    enter("End", "");
    expect(field("End").value).toBe("0:10");
    expect(inspector.exportRange).toEqual({ startMs: 0, endMs: 10_000 });
    expect(exportButton().disabled).toBe(false);
  });

  it("restores a cleared Length, which has no place of its own to go back to, and a field left with Escape", () => {
    setup({ range: { startMs: 2_000, endMs: 8_000 } });
    enter("Length", "");
    expect(field("Length").value).toBe("6");
    type(field("Start"), "");
    fireEvent.keyDown(field("Start"), { key: "Escape" });
    expect(field("Start").value).toBe("0:02");
    expect(inspector.exportRange).toEqual({ startMs: 2_000, endMs: 8_000 });
  });

  it("opens Display for the exported clip from Clip display settings", () => {
    setup();
    expect(inspector.mode).toBe("export");
    fireEvent.click(screen.getByRole("button", { name: "Clip display settings" }));
    expect(inspector.mode).toBe("settings");
    expect(inspector.settingsTab).toBe("display");
    expect(inspector.displayTarget).toBe("clip");
    // The old nested dialog is gone.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("exports the clip's displays, including the Analysis Cursor, from the clip store", async () => {
    const { clipRecorder, clipExportSettingsStore } = setup();
    // The clip displays are edited in Settings; the panel snapshots whatever the clip store holds.
    act(() =>
      clipExportSettingsStore.changeSettings((draft) => {
        draft.showAnalysisCursor = true;
        draft.displaySettings.performancePointsEnabled = false;
      }),
    );
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(clipRecorder.exportClip).toHaveBeenCalledWith(
        expect.objectContaining({
          showAnalysisCursor: true,
          displaySettings: expect.objectContaining({ performancePointsEnabled: false }),
        }),
      ),
    );
    expect(clipExportSettingsStore.settings.showAnalysisCursor).toBe(true);
  });

  it.each([
    [1, 1, 6_000],
    [1.5, 1, 8_500],
    [0.75, 1, 4_750],
    [1.5, 0.5, 4_750],
    [0.75, 1.5, 6_625],
  ])("turns five video seconds into the correct map interval at base %s and clip speed %s", async (baseRate, speed, endMs) => {
    const { clipRecorder } = setup({ baseRate, speed });
    enter("Start", "1");
    enter("Length", "5");
    expect(field("Length").value).toBe("5");
    expect(field("End").value).toBe(
      `0:${String(Math.floor(endMs / 1000)).padStart(2, "0")}${endMs % 1000 ? `.${String(endMs % 1000).padStart(3, "0").replace(/0+$/, "")}` : ""}`,
    );
    expect(summaryLine("5 s · MP4")).toBeTruthy();
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(clipRecorder.exportClip).toHaveBeenCalledWith(expect.objectContaining({ startMs: 1_000, endMs })),
    );
  });

  it("preserves the chosen start when editing the total video length", async () => {
    const { clipRecorder } = setup({ baseRate: 1.5, speed: 1 });
    enter("Start", "0.5");
    enter("Length", "5");
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(clipRecorder.exportClip).toHaveBeenCalledWith(expect.objectContaining({ startMs: 500, endMs: 8_000 })),
    );
  });

  it("retains fractional timing and reports whole-frame rounding separately from requested video length", async () => {
    const { clipRecorder } = setup({ baseRate: 1.5, speed: 1.25, duration: 20_000 });
    enter("Start", "1");
    enter("Length", "5.007");
    // 1 s + 5.007 s × 1.875 = 10 388.125 ms, kept exactly.
    expect(field("Length").value).toBe("5.007");
    const plan = createClipFramePlan(1_000, 10_388.125, 1.875, 60);
    expect(plan.frameCount).toBe(301);
    expect(summaryLine(`${formatClipSeconds(plan.durationSeconds)} s · MP4`)).toBeTruthy();
    expect(summaryLine("5.017 s · MP4")).toBeTruthy();
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(clipRecorder.exportClip).toHaveBeenCalledWith(
        expect.objectContaining({ startMs: 1_000, endMs: 10_388.125 }),
      ),
    );
  });

  it("clamps an edited length to a fractional replay end and keeps the minimum selected range", async () => {
    const { clipRecorder } = setup({ baseRate: 0.75, speed: 1, duration: 10_000.6 });
    enter("Start", "1");
    enter("Length", "99");
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(clipRecorder.exportClip).toHaveBeenLastCalledWith(expect.objectContaining({ endMs: 10_000.6 })),
    );
    enter("Length", "0.001");
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(clipRecorder.exportClip).toHaveBeenLastCalledWith(
        expect.objectContaining({ startMs: 1_000, endMs: 1_250 }),
      ),
    );
  });

  it("does not add a frame when a derived endpoint rounds up in the display", async () => {
    const { clipRecorder, clipExportSettingsStore } = setup({ baseRate: 1.5, speed: 1.25, duration: 20_000 });
    enter("Start", "1");
    act(() =>
      clipExportSettingsStore.changeSettings((draft) => {
        draft.fps = 240;
      }),
    );
    const requestedSeconds = 1_201 / 240;
    enter("Length", String(requestedSeconds));
    expect(field("Length").value).toBe("5.004");
    expect(field("End").value).toBe("0:10.383");
    // Leaving the End field untouched must not write its rounded text back.
    act(() => field("End").focus());
    leave(field("End"));
    expect(summaryLine("5.004 s · MP4")).toBeTruthy();
    expect(createClipFramePlan(1_000, storedRange().endMs, 1.875, 240).frameCount).toBe(1_201);
    fireEvent.click(exportButton());
    await waitFor(() => expect(clipRecorder.exportClip).toHaveBeenCalled());
    const options = lastOptions(clipRecorder);
    expect(options).toEqual(expect.objectContaining({ startMs: 1_000, fps: 240 }));
    expect(options.endMs).toBeCloseTo(1_000 + requestedSeconds * 1_875, 9);

    enter("End", "0:10.384");
    expect(field("End").value).toBe("0:10.384");
    expect(summaryLine("5.008 s · MP4")).toBeTruthy();
    fireEvent.click(exportButton());
    await waitFor(() =>
      expect(clipRecorder.exportClip).toHaveBeenLastCalledWith(expect.objectContaining({ endMs: 10_384 })),
    );
    expect(createClipFramePlan(1_000, 10_384, 1.875, 240).frameCount).toBe(1_202);
  });

  it("keeps a typed round length at its frame count when the rate has a fractional millisecond", async () => {
    const { clipRecorder } = setup({ baseRate: 0.75, speed: 1.25, duration: 20_000 });
    // Rate 0.9375: 5 s of video are 4 687.5 ms of map time, which must not be rounded to a whole millisecond.
    enter("Length", "5");
    expect(field("Length").value).toBe("5");
    expect(summaryLine("5 s · MP4")).toBeTruthy();
    fireEvent.click(exportButton());
    await waitFor(() => expect(clipRecorder.exportClip).toHaveBeenCalledTimes(1));
    const { startMs, endMs } = lastOptions(clipRecorder);
    expect(startMs).toBe(0);
    expect(endMs).toBe(4_687.5);
    expect(createClipFramePlan(startMs, endMs, 0.9375, 60).frameCount).toBe(300);
  });
});

describe("export panel", () => {
  it("shows the range without trailing zeros", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    expect(shown()).toEqual({ start: "1:02", end: "1:10", length: "8" });
    // Fractions keep only their significant digits.
    act(() => inspector.setExportRange({ startMs: 62_500, endMs: 70_250 }));
    expect(shown()).toEqual({ start: "1:02.5", end: "1:10.25", length: "7.75" });
  });

  it("changes nothing while the user is still typing", () => {
    const { gameClock } = setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    const seek = jest.spyOn(gameClock, "seekTo");
    const end = field("End");
    type(end, "1:1");
    expect(end.value).toBe("1:1");
    type(end, "9:99");
    // Neither clamped nor reformatted, and neither the range nor the playhead has moved.
    expect(end.value).toBe("9:99");
    expect(document.activeElement).toBe(end);
    expect(inspector.exportRange).toEqual({ startMs: 62_000, endMs: 70_000 });
    expect(field("Start").value).toBe("1:02");
    expect(field("Length").value).toBe("8");
    expect(seek).not.toHaveBeenCalled();
    expect(gameClock.timeElapsedInMs).toBe(0);
  });

  it("does not store a range, or write rounded text back, when untouched fields are left", () => {
    // The whole replay ends at 10 000.4 ms, which its End field shows as 0:10: writing that back would move the end.
    setup({ duration: 10_000.4 });
    expect(field("End").value).toBe("0:10");
    for (const name of ["Start", "End", "Length"] as const) {
      act(() => field(name).focus());
      leave(field(name));
    }
    expect(mockSetRange).not.toHaveBeenCalled();
    expect(inspector.exportRange).toBeNull();
  });

  it("never applies the rounded text of an untouched field", () => {
    // The end does not survive its own display: 0:06.004 and 5.004 s both map back to other values.
    const endMs = 1_000 + (1_201 / 240) * 1_000;
    const { clipExportSettingsStore } = setup({ duration: 20_000, range: { startMs: 1_000, endMs } });
    act(() =>
      clipExportSettingsStore.changeSettings((draft) => {
        draft.fps = 240;
      }),
    );
    expect(shown()).toEqual({ start: "0:01", end: "0:06.004", length: "5.004" });
    expect(parseClipTime(field("End").value)).not.toBe(endMs);
    // Focus and leave each field without typing.
    for (const name of ["Start", "End", "Length"] as const) {
      act(() => field(name).focus());
      expect(document.activeElement).toBe(field(name));
      leave(field(name));
    }
    expect(mockSetRange).not.toHaveBeenCalled();
    // Bit for bit the range that was stored.
    expect(Object.is(storedRange().startMs, 1_000)).toBe(true);
    expect(Object.is(storedRange().endMs, endMs)).toBe(true);
    expect(shown()).toEqual({ start: "0:01", end: "0:06.004", length: "5.004" });
    expect(createClipFramePlan(storedRange().startMs, storedRange().endMs, 1, 240).frameCount).toBe(1_201);
    expect(summaryLine("5.004 s · MP4")).toBeTruthy();
  });

  it("applies a typed start when the field is left, and Enter leaves the field", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    const start = field("Start");
    type(start, "1:03");
    expect(inspector.exportRange).toEqual({ startMs: 62_000, endMs: 70_000 });
    leave(start);
    expect(inspector.exportRange).toEqual({ startMs: 63_000, endMs: 70_000 });
    expect(start.value).toBe("1:03");
    expect(field("Length").value).toBe("7");

    const end = field("End");
    type(end, "1:20");
    expect(document.activeElement).toBe(end);
    expect(inspector.exportRange).toEqual({ startMs: 63_000, endMs: 70_000 });
    fireEvent.keyDown(end, { key: "Enter", code: "Enter" });
    expect(document.activeElement).not.toBe(end);
    expect(inspector.exportRange).toEqual({ startMs: 63_000, endMs: 80_000 });
    expect(end.value).toBe("1:20");
  });

  it("clamps a start typed past the end and an end typed past the replay only once the field is left", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    const start = field("Start");
    type(start, "1:15");
    expect(start.value).toBe("1:15");
    expect(inspector.exportRange).toEqual({ startMs: 62_000, endMs: 70_000 });
    leave(start);
    // The latest start leaves the minimum clip length (250 ms) before the end.
    expect(inspector.exportRange).toEqual({ startMs: 69_750, endMs: 70_000 });
    expect(start.value).toBe("1:09.75");

    const end = field("End");
    type(end, "5:00");
    expect(end.value).toBe("5:00");
    expect(inspector.exportRange).toEqual({ startMs: 69_750, endMs: 70_000 });
    leave(end);
    expect(inspector.exportRange).toEqual({ startMs: 69_750, endMs: 120_000 });
    expect(end.value).toBe("2:00");
  });

  it("a later drag on the timeline replaces a half-typed value", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    const end = field("End");
    type(end, "1:20");
    expect(end.value).toBe("1:20");
    // The dragged edge does not take focus from the field.
    act(() => inspector.setExportRange({ startMs: 62_000, endMs: 90_000 }));
    expect(document.activeElement).toBe(end);
    expect(end.value).toBe("1:30");
    expect(field("Length").value).toBe("28");
    mockSetRange.mockClear();
    leave(end);
    expect(mockSetRange).not.toHaveBeenCalled();
    expect(inspector.exportRange).toEqual({ startMs: 62_000, endMs: 90_000 });
    expect(end.value).toBe("1:30");
  });

  it("a later drag wins over a half-typed value when the pointer presses Export clip", async () => {
    const { clipRecorder } = setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    type(field("End"), "1:20");
    act(() => inspector.setExportRange({ startMs: 62_000, endMs: 90_000 }));
    fireEvent.mouseDown(exportButton());
    fireEvent.click(exportButton());
    await waitFor(() => expect(clipRecorder.exportClip).toHaveBeenCalledTimes(1));
    expect(lastOptions(clipRecorder)).toEqual(expect.objectContaining({ startMs: 62_000, endMs: 90_000 }));
  });

  it("an outside change to the other bound leaves a draft alone", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    const end = field("End");
    type(end, "1:20");
    // The start edge is dragged: End's own bound has not moved.
    act(() => inspector.setExportRange({ startMs: 65_000, endMs: 70_000 }));
    expect(end.value).toBe("1:20");
    expect(field("Start").value).toBe("1:05");
    expect(field("Length").value).toBe("5");
    expect(mockSetRange).not.toHaveBeenCalled();
    leave(end);
    expect(inspector.exportRange).toEqual({ startMs: 65_000, endMs: 80_000 });
  });

  it("a change of the playback rate drops a half-typed length", () => {
    const { gameClock } = setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    const length = field("Length");
    type(length, "4");
    expect(length.value).toBe("4");
    // The speed stepper is pressed with the pointer, so the field keeps focus.
    act(() => gameClock.setSpeed(1.25));
    expect(document.activeElement).toBe(length);
    expect(length.value).toBe("6.4");
    leave(length);
    expect(mockSetRange).not.toHaveBeenCalled();
    expect(inspector.exportRange).toEqual({ startMs: 62_000, endMs: 70_000 });
  });

  it("applying Start drops a half-typed Length", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    const length = field("Length");
    const start = field("Start");
    // Both fields hold text that was typed and not yet applied.
    type(length, "3");
    fireEvent.change(start, { target: { value: "1:03" } });
    expect(length.value).toBe("3");
    expect(start.value).toBe("1:03");
    fireEvent.blur(start);
    // The start moved the length (7 s now), so the 3 typed for the old range is gone.
    expect(inspector.exportRange).toEqual({ startMs: 63_000, endMs: 70_000 });
    expect(length.value).toBe("7");
    fireEvent.blur(length);
    expect(inspector.exportRange).toEqual({ startMs: 63_000, endMs: 70_000 });
    expect(length.value).toBe("7");
  });

  it("does not offer to export or to leave for Display while the inspector is locked", () => {
    const { clipRecorder } = setup({ locked: true });
    expect(exportButton().disabled).toBe(true);
    const link = screen.getByRole("button", { name: "Clip display settings" }) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    fireEvent.click(exportButton());
    fireEvent.click(link);
    expect(clipRecorder.exportClip).not.toHaveBeenCalled();
    expect(inspector.mode).toBe("export");
  });

  it("takes digits, a colon and a point only: letters and anything else never get into a field", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    type(field("Start"), "1a:b0c5 x-");
    expect(field("Start").value).toBe("1:05");
    leave(field("Start"));
    expect(inspector.exportRange).toEqual({ startMs: 65_000, endMs: 70_000 });
    type(field("End"), "one:08");
    expect(field("End").value).toBe(":08");
    type(field("End"), "1:08,5");
    expect(field("End").value).toBe("1:085");
    // The length is plain seconds: no colon either.
    type(field("Length"), "4s:");
    expect(field("Length").value).toBe("4");
    leave(field("Length"));
    expect(inspector.exportRange).toEqual({ startMs: 65_000, endMs: 69_000 });
  });

  it("restores a field whose text is still not a time", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    for (const text of ["1:02.5.5", "9:99", ":", "1:2", "1:085"]) {
      for (const name of ["Start", "End"] as const) {
        const input = field(name);
        type(input, text);
        expect(input.value).toBe(text);
        leave(input);
        expect(input.value).toBe(name === "Start" ? "1:02" : "1:10");
        expect(inspector.exportRange).toEqual({ startMs: 62_000, endMs: 70_000 });
      }
    }
    for (const text of ["1.2.3", "."]) {
      const input = field("Length");
      type(input, text);
      leave(input);
      expect(input.value).toBe("8");
      expect(inspector.exportRange).toEqual({ startMs: 62_000, endMs: 70_000 });
    }
  });

  it("turns a typed length into an end at the playback rate", () => {
    setup({ duration: 120_000, baseRate: 1.5, speed: 1, range: { startMs: 62_000, endMs: 70_000 } });
    // 8 s of map time at 1.5× play for 5.333 s.
    expect(field("Length").value).toBe("5.333");
    enter("Length", "4");
    expect(inspector.exportRange).toEqual({ startMs: 62_000, endMs: 68_000 });
    expect(field("End").value).toBe("1:08");
    expect(field("Length").value).toBe("4");
  });

  it("keeps typing in a range field away from playback shortcuts", () => {
    const { gameClock, modSettingsService } = setup({
      duration: 120_000,
      range: { startMs: 62_000, endMs: 70_000 },
      shortcuts: true,
    });
    const toggle = jest.spyOn(gameClock, "toggle");
    const seek = jest.spyOn(gameClock, "seekTo");
    const setSpeed = jest.spyOn(gameClock, "setSpeed");
    // The shortcuts are live: the same keys act on anything that is not a field.
    for (const [key, code, keyCode] of [
      ["f", "KeyF", 70],
      ["ArrowRight", "ArrowRight", 39],
    ] as const) {
      fireEvent.keyDown(document.body, { key, code, keyCode, which: keyCode });
      fireEvent.keyUp(document.body, { key, code, keyCode, which: keyCode });
    }
    expect(modSettingsService.setHidden).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledTimes(1);
    modSettingsService.setHidden.mockClear();
    seek.mockClear();
    const timeBefore = gameClock.timeElapsedInMs;
    expect(timeBefore).toBe(16);

    const input = field("Start");
    act(() => input.focus());
    const keys: Array<[string, string, number]> = [
      ["f", "KeyF", 70],
      [" ", "Space", 32],
      ["a", "KeyA", 65],
      ["d", "KeyD", 68],
      ["w", "KeyW", 87],
      ["s", "KeyS", 83],
      ["ArrowLeft", "ArrowLeft", 37],
      ["ArrowUp", "ArrowUp", 38],
    ];
    let text = "";
    for (const [key, code, keyCode] of keys) {
      const init = { key, code, keyCode, which: keyCode };
      // Space must not be taken over (and so default-prevented) by the playback toggle.
      expect(fireEvent.keyDown(input, init)).toBe(true);
      if (key.length === 1) {
        text += key;
        fireEvent.change(input, { target: { value: text } });
      }
      fireEvent.keyUp(input, init);
    }
    fireEvent.keyDown(input, { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, ctrlKey: true });

    // The keys are typing, not shortcuts; as letters and a space they do not get into a field of times either.
    expect(input.value).toBe("");
    expect(modSettingsService.setHidden).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    expect(gameClock.isPlaying).toBe(false);
    expect(seek).not.toHaveBeenCalled();
    expect(setSpeed).not.toHaveBeenCalled();
    expect(gameClock.speed).toBe(1);
    expect(gameClock.timeElapsedInMs).toBe(timeBefore);
    expect(inspector.exportRange).toEqual({ startMs: 62_000, endMs: 70_000 });
  });

  it("Escape in a range field restores it and leaves Export open", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    const start = field("Start");
    type(start, "1:05");
    expect(start.value).toBe("1:05");
    // Prevented, so the inspector's own Esc handler keeps Export open.
    expect(fireEvent.keyDown(start, { key: "Escape", code: "Escape" })).toBe(false);
    expect(start.value).toBe("1:02");
    expect(document.activeElement).not.toBe(start);
    expect(inspector.exportRange).toEqual({ startMs: 62_000, endMs: 70_000 });
    expect(inspector.mode).toBe("export");
    // A second press, with no draft to restore, still keeps Export open.
    act(() => start.focus());
    fireEvent.keyDown(start, { key: "Escape", code: "Escape" });
    expect(inspector.mode).toBe("export");
    // The same key elsewhere closes it: the inspector's handler is live.
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(inspector.mode).toBe("incidents");
  });

  it("closes Export from its header", () => {
    setup();
    expect(screen.getByRole("region", { name: "Export clip" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Export clip" })).toBeTruthy();
    expect(screen.getByText("Esc")).toBeTruthy();
    const close = screen.getByRole("button", { name: "Close export" });
    expect(close.getAttribute("title")).toBe("Close (Esc)");
    fireEvent.click(close);
    expect(inspector.mode).toBe("incidents");
  });

  it("opens Display for the exported clip from the link", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Clip display settings" }));
    expect(inspector.mode).toBe("settings");
    expect(inspector.settingsTab).toBe("display");
    expect(inspector.displayTarget).toBe("clip");
  });

  it("stores resolution, frame rate and audio in the clip store", () => {
    const { clipExportSettingsStore } = setup();
    const resolution = within(screen.getByRole("group", { name: "Resolution" }));
    const frameRate = within(screen.getByRole("group", { name: "Frame rate" }));
    expect(resolution.getAllByRole("button").map((button) => button.textContent)).toEqual(["1080p", "1440p", "4K"]);
    expect(frameRate.getAllByRole("button").map((button) => button.textContent)).toEqual(["60", "120", "144", "240"]);
    expect(resolution.getByRole("button", { name: "1080p" }).getAttribute("aria-pressed")).toBe("true");
    expect(frameRate.getByRole("button", { name: "60" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(resolution.getByRole("button", { name: "1440p" }));
    expect(clipExportSettingsStore.settings.width).toBe(2560);
    fireEvent.click(resolution.getByRole("button", { name: "4K" }));
    expect(clipExportSettingsStore.settings.width).toBe(3840);
    fireEvent.click(frameRate.getByRole("button", { name: "144" }));
    expect(clipExportSettingsStore.settings.fps).toBe(144);
    const audio = screen.getByRole("checkbox", { name: "Audio" });
    expect(audio.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(audio);
    expect(clipExportSettingsStore.settings.audio).toBe(false);
    expect(screen.getByRole("checkbox", { name: "Audio" }).getAttribute("aria-checked")).toBe("false");
    expect(resolution.getByRole("button", { name: "4K" }).getAttribute("aria-pressed")).toBe("true");
    expect(frameRate.getByRole("button", { name: "144" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("offers the viewer's speeds for the clip and sets the clock's speed", async () => {
    const { gameClock } = setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    const setSpeed = jest.spyOn(gameClock, "setSpeed");
    expect(field("Length").value).toBe("8");
    const label = screen.getByRole("button", { name: "Clip speed: 1.00×" });
    expect(label.textContent).toBe("1.00×");
    fireEvent.click(screen.getByRole("button", { name: "Increase clip speed" }));
    expect(setSpeed).toHaveBeenCalledWith(1.25);
    expect(screen.getByRole("button", { name: "Clip speed: 1.25×" })).toBeTruthy();
    // The clip is shorter at a higher speed: 8 s of map time play for 6.4 s.
    expect(field("Length").value).toBe("6.4");
    fireEvent.click(screen.getByRole("button", { name: "Decrease clip speed" }));
    expect(setSpeed).toHaveBeenLastCalledWith(1);

    fireEvent.click(screen.getByRole("button", { name: /Clip speed/ }));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(ALLOWED_SPEEDS.map((value) => `${value.toFixed(2)}×`));
    fireEvent.click(screen.getByRole("menuitem", { name: "0.50×" }));
    expect(setSpeed).toHaveBeenLastCalledWith(0.5);
    expect(gameClock.speed).toBe(0.5);
    expect(field("Length").value).toBe("16");
    expect(screen.queryByRole("button", { name: /Viewer playback speed/ })).toBeNull();
  });

  it("summarises length, format, resolution and frame rate", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    expect(summaryLine("8 s · MP4")).toBeTruthy();
    expect(summaryLine("1080p · 60 FPS")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Resolution" })).getByRole("button", { name: "1440p" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Frame rate" })).getByRole("button", { name: "240" }));
    expect(summaryLine("1440p · 240 FPS")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Resolution" })).getByRole("button", { name: "4K" }));
    expect(summaryLine("4K · 240 FPS")).toBeTruthy();
    // The length is in the lighter ink; the format is not.
    const length = screen.getByText("8 s");
    expect(getComputedStyle(length).color).toBe("rgb(232, 230, 225)");
  });

  it("says so when no video encoding is available, and does not export", () => {
    const { clipRecorder } = setup({ format: null });
    expect(exportButton().disabled).toBe(true);
    expect(screen.getByText(/Video encoding unavailable/)).toBeTruthy();
    fireEvent.click(exportButton());
    expect(clipRecorder.exportClip).not.toHaveBeenCalled();
  });

  it("matches the recorder's frame plan at a DT rate and a slowed clip", () => {
    const { clipExportSettingsStore } = setup({
      duration: 120_000,
      baseRate: 1.5,
      speed: 0.5,
      range: { startMs: 62_000, endMs: 70_100 },
    });
    act(() =>
      clipExportSettingsStore.changeSettings((draft) => {
        draft.fps = 144;
      }),
    );
    const plan = createClipFramePlan(62_000, 70_100, 0.75, 144);
    expect(plan.frameCount).toBe(1_556);
    // The summary is the rendered video, rounded up to whole frames; the field is the requested length.
    expect(summaryLine(`${formatClipSeconds(plan.durationSeconds)} s · MP4`)).toBeTruthy();
    expect(summaryLine("10.806 s · MP4")).toBeTruthy();
    expect(field("Length").value).toBe(formatClipSeconds(plan.requestedDurationSeconds));
    expect(field("Length").value).toBe("10.8");
  });

  it("exports with the clock's speed and otherwise the options the dialog built", async () => {
    const { clipRecorder, clipExportSettingsStore } = setup({
      duration: 120_000,
      baseRate: 1.5,
      speed: 0.5,
      range: { startMs: 62_000, endMs: 70_000 },
    });
    act(() =>
      clipExportSettingsStore.changeSettings((draft) => {
        draft.width = 2560;
        draft.fps = 120;
        draft.audio = false;
      }),
    );
    expect(exportButton().disabled).toBe(false);
    fireEvent.click(exportButton());
    await waitFor(() => expect(clipRecorder.exportClip).toHaveBeenCalledTimes(1));
    expect(clipRecorder.exportClip.mock.calls[0][0]).toEqual({
      startMs: 62_000,
      endMs: 70_000,
      width: 2560,
      fps: 120,
      audio: false,
      ...clipAppearanceOptions(clipExportSettingsStore.settings),
      speed: 0.5,
    });
  });

  it("applies a field that is still being edited when the pointer presses Export clip", async () => {
    const { clipRecorder } = setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    type(field("End"), "1:08");
    // The button never takes focus from a pointer press, so the press itself leaves the field.
    fireEvent.mouseDown(exportButton());
    fireEvent.click(exportButton());
    await waitFor(() => expect(clipRecorder.exportClip).toHaveBeenCalledTimes(1));
    expect(lastOptions(clipRecorder)).toEqual(expect.objectContaining({ startMs: 62_000, endMs: 68_000 }));
    expect(document.activeElement).not.toBe(exportButton());
  });

  it("disables the export and says why when the range has too many frames", () => {
    const { clipRecorder, clipExportSettingsStore, gameClock } = setup({ duration: 1_200_000 });
    act(() => gameClock.setSpeed(0.25));
    expect(exportButton().disabled).toBe(false);
    act(() =>
      clipExportSettingsStore.changeSettings((draft) => {
        draft.fps = 240;
      }),
    );
    const warning = screen.getByText("This range has too many frames. Shorten the clip.");
    expect(getComputedStyle(warning).color).toBe(MISS_RGB);
    expect(exportButton().disabled).toBe(true);
    expect(getComputedStyle(exportButton()).color).not.toBe("rgb(255, 255, 255)");
    fireEvent.click(exportButton());
    expect(clipRecorder.exportClip).not.toHaveBeenCalled();
    // A shorter clip brings the export back.
    enter("End", "20:00");
    enter("Length", "100");
    expect(screen.queryByText("This range has too many frames. Shorten the clip.")).toBeNull();
    expect(exportButton().disabled).toBe(false);
  });

  it("shows the exporting view while the recorder is busy", () => {
    const { state$, run$ } = setup();
    expect(screen.queryByRole("heading", { name: "Exporting clip" })).toBeNull();
    act(() => run$.next(RUN));
    act(() => state$.next({ status: "rendering", progress: 0.25 }));
    expect(screen.getByRole("heading", { name: "Exporting clip" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Export clip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export clip" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel export" })).toBeTruthy();
    // The set-up is back when the recorder is free again.
    act(() => state$.next({ status: "cancelled", progress: 0.25 }));
    expect(screen.queryByRole("heading", { name: "Exporting clip" })).toBeNull();
    expect(exportButton()).toBeTruthy();
  });

  it("shows the saved clip with its real length, frame count and path, and keeps the export button", () => {
    const { state$, run$ } = setup();
    const path = "D:\\Videos\\Rewind\\ANiMA 1-02.mp4";
    act(() => run$.next(RUN));
    act(() => state$.next({ status: "done", progress: 1, path }));
    expect(screen.getByText("Clip saved")).toBeTruthy();
    expect(screen.getByText("8 s · 480 frames")).toBeTruthy();
    const pathLine = screen.getByText(path);
    expect(getComputedStyle(pathLine).overflowWrap).toBe("anywhere");
    expect(exportButton().disabled).toBe(false);
    // Saved clip first, then the export button below it, and the whole footer after the set-up.
    const saved = screen.getByText("Clip saved");
    const open = screen.getByRole("button", { name: "Open clip" });
    const folder = screen.getByRole("button", { name: "Show in folder" });
    const summary = summaryLine("10 s · MP4");
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(saved, open)).toBe(true);
    expect(follows(open, folder)).toBe(true);
    expect(follows(folder, summary)).toBe(true);
    expect(follows(summary, exportButton())).toBe(true);
    expect(follows(field("Start"), saved)).toBe(true);
    // Both buttons are secondary: the same face, and neither is the glowing export button.
    expect(getComputedStyle(open).backgroundColor).toBe(getComputedStyle(folder).backgroundColor);
    expect(getComputedStyle(open).backgroundColor).not.toBe(getComputedStyle(exportButton()).backgroundColor);
  });

  it("leaves the saved line's summary out when the recorder has none", () => {
    const { state$ } = setup();
    act(() => state$.next({ status: "done", progress: 1, path: "D:\\clips\\a.mp4" }));
    expect(screen.getByText("Clip saved")).toBeTruthy();
    expect(screen.queryByText(/frames/)).toBeNull();
  });

  it("opens the clip and shows it in its folder", async () => {
    const { state$ } = setup();
    act(() => state$.next({ status: "done", progress: 1, path: "D:\\clips\\review.mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "Open clip" }));
    await waitFor(() => expect(frontendAPI.openExportedClip).toHaveBeenCalledWith("D:\\clips\\review.mp4"));
    expect(frontendAPI.showExportedClip).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(frontendAPI.showExportedClip).toHaveBeenCalledWith("D:\\clips\\review.mp4"));

    // A failure shows its message and leaves the saved clip where it is.
    (frontendAPI.openExportedClip as jest.Mock).mockRejectedValueOnce(new Error("No app opens .mp4 files"));
    fireEvent.click(screen.getByRole("button", { name: "Open clip" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No app opens .mp4 files");
    expect(screen.getByText("Clip saved")).toBeTruthy();
    (frontendAPI.showExportedClip as jest.Mock).mockRejectedValueOnce("denied");
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect((await screen.findByText("Could not open the exported clip.")).getAttribute("role")).toBe("alert");
  });

  it("keeps the saved clip visible while the range and the output options are changed, until the next export starts", async () => {
    const { state$, run$, clipRecorder } = setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    act(() => run$.next(RUN));
    act(() => state$.next({ status: "done", progress: 1, path: "D:\\clips\\review.mp4" }));
    enter("Start", "1:03");
    fireEvent.click(within(screen.getByRole("group", { name: "Resolution" })).getByRole("button", { name: "1440p" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Audio" }));
    act(() => inspector.setExportRange({ startMs: 64_000, endMs: 90_000 }));
    // Nothing is dimmed or disabled, and the saved clip is still there with its numbers.
    expect(screen.getByText("Clip saved")).toBeTruthy();
    expect(screen.getByText("8 s · 480 frames")).toBeTruthy();
    expect(screen.getByText("D:\\clips\\review.mp4")).toBeTruthy();
    for (const name of ["Start", "End", "Length"] as const) expect(field(name).disabled).toBe(false);
    expect(exportButton().disabled).toBe(false);
    expect(screen.getByRole("region", { name: "Export clip" }).querySelector("[inert], [aria-disabled='true']")).toBeNull();

    // The next export replaces it: the recorder reports its start, which swaps the view.
    clipRecorder.exportClip.mockImplementation(async () => {
      state$.next({ status: "preparing", progress: 0 });
    });
    fireEvent.click(exportButton());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Exporting clip" })).toBeTruthy());
    expect(screen.queryByText("Clip saved")).toBeNull();
    act(() => state$.next({ status: "idle", progress: 0 }));
    expect(screen.queryByText("Clip saved")).toBeNull();
  });

  describe("the result is announced", () => {
    const region = () => screen.getByRole("status");
    const idle: ClipRecorderState = { status: "idle", progress: 0 };

    it("keeps one status region mounted through the export, empty while idle and while exporting", () => {
      const { state$ } = setup();
      const node = region();
      expect(node.textContent).toBe("");
      expect(screen.getAllByRole("status")).toHaveLength(1);
      // Hidden from sight with a clip, not removed from the accessibility tree.
      expect(declaredRules(node).join("\n")).toContain("clip-path: inset(50%)");
      for (const status of ["preparing", "recording", "rendering", "saving"] as const) {
        act(() => state$.next({ status, progress: 0.3 }));
        expect(screen.getAllByRole("status")).toHaveLength(1);
        expect(region()).toBe(node);
        expect(node.textContent).toBe("");
      }
    });

    it("announces a saved clip in the region that was already there", () => {
      const { state$, run$ } = setup();
      const node = region();
      act(() => state$.next({ status: "preparing", progress: 0 }));
      act(() => run$.next(RUN));
      act(() => state$.next({ status: "rendering", progress: 0.5 }));
      expect(node.textContent).toBe("");
      act(() => state$.next({ status: "done", progress: 1, path: "D:\\clips\\a.mp4" }));
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(region()).toBe(node);
      expect(node.isConnected).toBe(true);
      expect(node.textContent).toBe("Clip saved. 8 s, 480 frames.");
      // The visible saved block says the same thing without being a second live region.
      expect(screen.getByText("Clip saved").closest("[role=status]")).toBeNull();
      expect(screen.getByText("8 s · 480 frames").closest("[role=status]")).toBeNull();
      // The next export clears it.
      act(() => state$.next({ status: "preparing", progress: 0 }));
      expect(node.textContent).toBe("");
    });

    it("leaves the numbers out of the announcement when there is no run summary", () => {
      const { state$ } = setup();
      act(() => state$.next({ status: "done", progress: 1, path: "D:\\clips\\a.mp4" }));
      expect(region().textContent).toBe("Clip saved.");
      // A finished export without a path has nothing to announce.
      act(() => state$.next({ status: "done", progress: 1 }));
      expect(region().textContent).toBe("");
    });

    it("announces Export cancelled. after a cancel, in the same region, and leaves an error to its alert", () => {
      const { state$ } = setup();
      const node = region();
      act(() => state$.next({ status: "preparing", progress: 0 }));
      act(() => state$.next({ status: "cancelled", progress: 0.4 }));
      expect(region()).toBe(node);
      expect(node.textContent).toBe("Export cancelled.");
      expect(screen.getByText("Export cancelled.", { selector: "p" }).closest("[role=status]")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();

      act(() => state$.next({ status: "error", progress: 0.4, error: "Disk full" }));
      expect(node.textContent).toBe("");
      expect(screen.getByRole("alert").textContent).toBe("Disk full");
      expect(node.contains(screen.getByRole("alert"))).toBe(false);
    });

    it("has exactly one status region in every state", () => {
      const { state$, run$ } = setup();
      act(() => run$.next(RUN));
      const states: ClipRecorderState[] = [
        idle,
        { status: "preparing", progress: 0 },
        { status: "recording", progress: 0.2 },
        { status: "rendering", progress: 0.5 },
        { status: "saving", progress: 1 },
        { status: "done", progress: 1, path: "D:\\clips\\a.mp4" },
        { status: "cancelled", progress: 0.4 },
        { status: "error", progress: 0.4, error: "Disk full" },
      ];
      for (const next of states) {
        act(() => state$.next(next));
        expect(screen.getAllByRole("status")).toHaveLength(1);
      }
    });
  });

  describe("below 330 px of panel width", () => {
    it("puts the range fields on two rows, Start and End first, and keeps today's row from 330 px", () => {
      setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
      const row = field("Start").closest("[data-range-fields]") as HTMLElement;
      const rules = declaredRules(row);
      // Today's row of three, from 330 px up.
      expect(rules.some((rule) => rule.includes("grid-template-columns: repeat(3, minmax(0, 1fr))"))).toBe(true);
      // A container query on the panel, up to 329 px: two equal columns, and Length across both.
      const narrow = rules.find((rule) => rule.startsWith("@container (max-width: 329px)"));
      expect(narrow).toBeTruthy();
      expect(narrow).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
      expect(narrow).toMatch(/>:last-child \{grid-column: 1\/-1;\}/);
      expect(getComputedStyle(row).gap).toBe("8px");
      // The panel is the container the query measures.
      const root = screen.getByRole("region", { name: "Export clip" });
      expect(declaredRules(root).join("\n")).toContain("container-type: inline-size");
      // The last child is Length, and the tab order is still Start, End, Length.
      expect(row.lastElementChild?.contains(field("Length"))).toBe(true);
      const order = [field("Start"), field("End"), field("Length")];
      for (let i = 1; i < order.length; i++) {
        expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      expect(order.every((input) => input.tabIndex === 0)).toBe(true);
    });

    it("stacks the saved clip's buttons and never wraps their text", () => {
      const { state$ } = setup();
      act(() => state$.next({ status: "done", progress: 1, path: "D:\\clips\\review.mp4" }));
      const open = screen.getByRole("button", { name: "Open clip" });
      const folder = screen.getByRole("button", { name: "Show in folder" });
      const buttons = open.parentElement as HTMLElement;
      expect(folder.parentElement).toBe(buttons);
      expect(open.compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Side by side from 330 px up, in one row with an 8 px gap...
      expect(getComputedStyle(buttons).display).toBe("flex");
      expect(getComputedStyle(buttons).gap).toBe("8px");
      expect(declaredRules(buttons).find((rule) => rule.startsWith("@container (max-width: 329px)"))).toContain(
        "flex-direction: column",
      );
      expect(getComputedStyle(buttons).flexDirection).not.toBe("column");
      // ...one above the other below it, each as wide as the footer.
      expect(declaredRules(open).find((rule) => rule.startsWith("@container (max-width: 329px)"))).toContain(
        "flex: none",
      );
      for (const button of [open, folder]) expect(getComputedStyle(button).whiteSpace).toBe("nowrap");
    });
  });

  it("says Export cancelled. after a cancel and shows the recorder's error after a failure", async () => {
    const { state$, clipRecorder } = setup();
    expect(screen.queryByText("Export cancelled.")).toBeNull();
    act(() => state$.next({ status: "cancelled", progress: 0.4 }));
    const cancelled = screen.getByText("Export cancelled.", { selector: "p" });
    expect(getComputedStyle(cancelled).color).toBe(SECONDARY_RGB);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Clip saved")).toBeNull();
    // It stays, like the saved clip, until the next export starts.
    enter("Start", "0:01");
    expect(screen.getByText("Export cancelled.", { selector: "p" })).toBeTruthy();

    act(() => state$.next({ status: "error", progress: 0.4, error: "Disk full" }));
    expect(screen.queryByText("Export cancelled.")).toBeNull();
    const failure = screen.getByRole("alert");
    expect(failure.textContent).toBe("Disk full");
    expect(getComputedStyle(failure).color).toBe(MISS_RGB);

    // A rejected export call is reported the same way.
    act(() => state$.next({ status: "idle", progress: 0 }));
    clipRecorder.exportClip.mockRejectedValueOnce(new Error("Encoder missing"));
    fireEvent.click(exportButton());
    expect((await screen.findByRole("alert")).textContent).toBe("Encoder missing");
    clipRecorder.exportClip.mockRejectedValueOnce("nope");
    fireEvent.click(exportButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Could not export this clip."));
  });

  it("keeps the viewer's names on the dock's speed stepper", async () => {
    setup();
    render(<SpeedStepper />);
    // The panel's own stepper is for the clip; this one, without the prop, is for the viewer.
    expect(screen.getByRole("button", { name: "Decrease viewer speed" })).toBeTruthy();
    const viewer = screen.getByRole("button", { name: "Viewer playback speed: 1.00×" });
    expect(screen.getByRole("button", { name: "Increase viewer speed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clip speed: 1.00×" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decrease clip speed" })).toBeTruthy();
    fireEvent.mouseOver(viewer);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Original replay rate. The selected viewer multiplier is applied on top.",
    );
    fireEvent.mouseLeave(viewer);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    fireEvent.mouseOver(screen.getByRole("button", { name: "Clip speed: 1.00×" }));
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Original replay rate. The selected clip speed is applied on top.",
    );
  });

  it("declares the styles that keep the panel inside 240 px", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 }, state: { status: "idle", progress: 0 } });
    const root = screen.getByRole("region", { name: "Export clip" });
    expect(getComputedStyle(root).height).toBe("100%");
    expect(["0", "0px"]).toContain(getComputedStyle(root).minHeight);
    // The body is the only thing that scrolls, and only vertically.
    const body = field("Start").closest("[data-export-body]") as HTMLElement;
    expect(body).toBeTruthy();
    expect(getComputedStyle(body).overflowY).toBe("auto");
    expect(getComputedStyle(body).overflowX).toBe("hidden");
    expect(getComputedStyle(body).flexShrink).not.toBe("0");
    // The footer stays at the bottom.
    const footer = exportButton().closest("[data-export-footer]") as HTMLElement;
    expect(footer).toBeTruthy();
    expect(getComputedStyle(footer).flexShrink).toBe("0");
    // The three fields share the row and may shrink below their content.
    const row = field("Start").closest("[data-range-fields]") as HTMLElement;
    expect(row.children).toHaveLength(3);
    expect(getComputedStyle(row).display).toBe("grid");
    expect(getComputedStyle(row).gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))");
    expect(getComputedStyle(row).gap).toBe("8px");
    for (const name of ["Start", "End", "Length"] as const) {
      const label = field(name).closest("label") as HTMLElement;
      expect(["0", "0px"]).toContain(getComputedStyle(label).minWidth);
      expect(["0", "0px"]).toContain(getComputedStyle(field(name)).minWidth);
    }
  });

  it("styles the range fields and the export button as designed", () => {
    setup({ duration: 120_000, range: { startMs: 62_000, endMs: 70_000 } });
    const start = field("Start");
    const face = start.closest("[data-range-field]") as HTMLElement;
    expect(getComputedStyle(face).height).toBe("32px");
    expect(getComputedStyle(face).borderRadius).toBe("7px");
    expect(getComputedStyle(face).backgroundColor).toBe("rgb(15, 16, 19)");
    expect(getComputedStyle(face).boxShadow).toBe("inset 0 0 0 1px rgba(255,255,255,0.1)");
    expect(getComputedStyle(start).fontWeight).toBe("500");
    expect(screen.getByText("s", { selector: "span" })).toBeTruthy();
    expect(getComputedStyle(exportButton()).height).toBe("44px");
    expect(getComputedStyle(exportButton()).backgroundColor).toBe("rgb(28, 29, 34)");
    expect(getComputedStyle(screen.getByRole("button", { name: "Clip display settings" })).color).toBe(
      "rgb(255, 156, 188)",
    );
    expect(REWIND_COLORS.judgementMiss).toBe("#ff7082");
  });
});

describe("the Save to row", () => {
  const SAVED = "D:\\Clips\\osu";
  const saveToLabel = () => screen.getByText("Save to", { selector: "span" });
  const changeButton = () => screen.getByRole("button", { name: "Change save folder" }) as HTMLButtonElement;
  /** What assistive technology reads inside `element`: its text without the parts hidden from it. */
  const accessibleText = (element: Element): string =>
    Array.from(element.childNodes)
      .map((node) =>
        node.nodeType === Node.TEXT_NODE
          ? node.textContent ?? ""
          : (node as Element).getAttribute("aria-hidden") === "true"
            ? ""
            : accessibleText(node as Element),
      )
      .join("");
  /** A picker that stays open until the test answers it. */
  const pendingPicker = () => {
    let answer!: (value: string | null) => void;
    let fail!: (reason: Error) => void;
    jest.mocked(frontendAPI.selectDirectory).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          answer = resolve;
          fail = reject;
        }),
    );
    return { answer: (value: string | null) => answer(value), fail: (reason: Error) => fail(reason) };
  };
  const choose = async (result: string | null) => {
    jest.mocked(frontendAPI.selectDirectory).mockResolvedValueOnce(result);
    fireEvent.click(changeButton());
    await waitFor(() => expect(frontendAPI.selectDirectory).toHaveBeenCalledTimes(1));
  };

  it("reads Videos folder when no folder is chosen", () => {
    const { clipExportSettingsStore } = setup();
    expect(clipExportSettingsStore.settings.saveFolder).toBe("");
    expect(saveToLabel()).toBeTruthy();
    const name = screen.getByText("Videos folder");
    expect(name.getAttribute("title")).toBeNull();
  });

  it("shows the chosen folder's own name with the full path as its title", () => {
    const { clipExportSettingsStore } = setup();
    act(() =>
      clipExportSettingsStore.changeSettings((settings) => {
        settings.saveFolder = SAVED;
      }),
    );
    const name = screen.getByText("osu");
    expect(name.getAttribute("title")).toBe(SAVED);
    expect(screen.queryByText("Videos folder")).toBeNull();
    // A long name is cut with an ellipsis instead of widening the panel.
    expect(getComputedStyle(name).overflow).toBe("hidden");
    expect(getComputedStyle(name).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(name).whiteSpace).toBe("nowrap");
  });

  it.each([
    ["a folder with a trailing separator", "D:\\Clips\\osu\\", "osu"],
    ["a drive root", "D:\\", "D:\\"],
    ["a POSIX path", "/home/me/clips", "clips"],
  ])("names %s by its last segment, or the whole path when there is none", (_label, path, shown) => {
    const { clipExportSettingsStore } = setup();
    act(() =>
      clipExportSettingsStore.changeSettings((settings) => {
        settings.saveFolder = path;
      }),
    );
    const name = screen.getByTitle(path);
    expect(name.textContent).toBe(shown);
  });

  it("opens the folder picker at the current folder and stores the chosen one", async () => {
    const { clipExportSettingsStore } = setup();
    await choose(SAVED);
    expect(frontendAPI.selectDirectory).toHaveBeenLastCalledWith("");
    await waitFor(() => expect(clipExportSettingsStore.settings.saveFolder).toBe(SAVED));
    expect(screen.getByText("osu").getAttribute("title")).toBe(SAVED);

    const next = "E:\\Footage";
    jest.mocked(frontendAPI.selectDirectory).mockResolvedValueOnce(next);
    fireEvent.click(changeButton());
    await waitFor(() => expect(clipExportSettingsStore.settings.saveFolder).toBe(next));
    expect(frontendAPI.selectDirectory).toHaveBeenLastCalledWith(SAVED);
  });

  it("stores nothing when the picker is dismissed", async () => {
    const { clipExportSettingsStore } = setup();
    act(() =>
      clipExportSettingsStore.changeSettings((settings) => {
        settings.saveFolder = SAVED;
      }),
    );
    await choose(null);
    await act(async () => undefined);
    expect(clipExportSettingsStore.settings.saveFolder).toBe(SAVED);
    expect(screen.getByText("osu")).toBeTruthy();
  });

  it("changes nothing and shows no error when the picker fails", async () => {
    const { clipExportSettingsStore } = setup();
    jest.mocked(frontendAPI.selectDirectory).mockRejectedValueOnce(new Error("no dialog"));
    fireEvent.click(changeButton());
    await waitFor(() => expect(frontendAPI.selectDirectory).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(clipExportSettingsStore.settings.saveFolder).toBe("");
    expect(screen.getByText("Videos folder")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("passes the saved folder in the export options, and no folder when none is saved", async () => {
    const { clipRecorder, clipExportSettingsStore } = setup();
    fireEvent.click(exportButton());
    await waitFor(() => expect(clipRecorder.exportClip).toHaveBeenCalledTimes(1));
    expect(lastOptions(clipRecorder)).not.toHaveProperty("saveFolder");

    act(() =>
      clipExportSettingsStore.changeSettings((settings) => {
        settings.saveFolder = SAVED;
      }),
    );
    fireEvent.click(exportButton());
    await waitFor(() => expect(clipRecorder.exportClip).toHaveBeenCalledTimes(2));
    expect(lastOptions(clipRecorder)).toMatchObject({ saveFolder: SAVED });
    expect(lastOptions(clipRecorder)).toEqual({
      startMs: 0,
      endMs: 10_000,
      speed: 1,
      audio: true,
      width: 1920,
      fps: 60,
      saveFolder: SAVED,
      ...clipAppearanceOptions(clipExportSettingsStore.settings),
    });
  });

  it("disables Change… while the inspector is locked", () => {
    setup({ locked: true });
    expect(changeButton().disabled).toBe(true);
    fireEvent.click(changeButton());
    expect(frontendAPI.selectDirectory).not.toHaveBeenCalled();
  });

  it("does not keep focus on Change… after a pointer press", () => {
    setup();
    const button = changeButton();
    expect(fireEvent.mouseDown(button)).toBe(false);
    expect(document.activeElement).not.toBe(button);
  });

  it("names the button Change save folder while its text stays Change…", () => {
    setup();
    expect(changeButton().textContent).toBe("Change…");
    expect(screen.queryByRole("button", { name: "Change…" })).toBeNull();
  });

  it("exposes the full path of a saved folder once to assistive technology, and keeps the title", () => {
    const { clipExportSettingsStore } = setup();
    act(() =>
      clipExportSettingsStore.changeSettings((settings) => {
        settings.saveFolder = SAVED;
      }),
    );
    const name = screen.getByText("osu");
    expect(name.getAttribute("aria-hidden")).toBe("true");
    expect(name.getAttribute("title")).toBe(SAVED);
    const element = name.parentElement as HTMLElement;
    expect(accessibleText(element)).toBe(SAVED);
    expect(element.textContent).toBe("osu" + SAVED);
  });

  it("reads Videos folder for everyone when no folder is saved", () => {
    setup();
    const name = screen.getByText("Videos folder");
    expect(name.getAttribute("aria-hidden")).toBeNull();
    expect(accessibleText(name.parentElement as HTMLElement)).toBe("Videos folder");
  });

  it("opens one picker for a second press while the first is open, and is enabled again after a result", async () => {
    const { clipExportSettingsStore } = setup();
    const picker = pendingPicker();
    fireEvent.click(changeButton());
    expect(changeButton().disabled).toBe(true);
    fireEvent.click(changeButton());
    fireEvent.keyDown(changeButton(), { key: "Enter" });
    expect(frontendAPI.selectDirectory).toHaveBeenCalledTimes(1);
    await act(async () => picker.answer(SAVED));
    expect(clipExportSettingsStore.settings.saveFolder).toBe(SAVED);
    expect(changeButton().disabled).toBe(false);
    jest.mocked(frontendAPI.selectDirectory).mockResolvedValueOnce(null);
    fireEvent.click(changeButton());
    await waitFor(() => expect(frontendAPI.selectDirectory).toHaveBeenCalledTimes(2));
  });

  it("enables Change… again after a dismissed picker", async () => {
    setup();
    const picker = pendingPicker();
    fireEvent.click(changeButton());
    expect(changeButton().disabled).toBe(true);
    await act(async () => picker.answer(null));
    expect(changeButton().disabled).toBe(false);
  });

  it("enables Change… again after a picker that fails", async () => {
    setup();
    const picker = pendingPicker();
    fireEvent.click(changeButton());
    expect(changeButton().disabled).toBe(true);
    await act(async () => picker.fail(new Error("no dialog")));
    expect(changeButton().disabled).toBe(false);
  });

  it("still stores a late result after the panel is gone, without touching state or logging", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { clipExportSettingsStore, view } = setup();
      const picker = pendingPicker();
      fireEvent.click(changeButton());
      view.unmount();
      await act(async () => picker.answer(SAVED));
      expect(clipExportSettingsStore.settings.saveFolder).toBe(SAVED);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("is the fourth value row of OUTPUT, between Speed and Audio", () => {
    setup();
    const labels = ["Resolution", "Frame rate", "Speed", "Save to"].map((label) =>
      screen.getByText(label, { selector: "span" }),
    );
    const rows = labels.map((label) => label.parentElement as HTMLElement);
    // One section: the four value rows follow each other, in this order.
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index].previousElementSibling).toBe(rows[index - 1]);
    }
    expect(rows[3].contains(changeButton())).toBe(true);
    const audio = screen.getByRole("checkbox", { name: "Audio" });
    expect(rows[3].nextElementSibling?.contains(audio)).toBe(true);
  });
});
