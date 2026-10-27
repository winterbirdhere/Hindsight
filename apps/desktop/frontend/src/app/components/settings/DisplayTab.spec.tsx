import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import { InspectorProvider } from "../../providers/InspectorProvider";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { ClipExportSettings, ClipExportSettingsStore } from "../../services/analysis/clip-export-settings";
import {
  ReplayDisplaySettings,
  ReplayDisplaySettingsStore,
  ReplayDisplayToggleKey,
} from "../../services/analysis/replay-display-settings";
import { DisplayTab } from "./DisplayTab";

jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));

type ComparisonStatus = "EMPTY" | "READY";

function mount(options: { comparison?: ComparisonStatus } = {}) {
  window.localStorage.clear();
  const replayDisplaySettingsStore = new ReplayDisplaySettingsStore();
  const clipExportSettingsStore = new ClipExportSettingsStore();
  const replayComparison$ = new BehaviorSubject<{ status: ComparisonStatus }>({
    status: options.comparison ?? "EMPTY",
  });
  (useAnalysisApp as jest.Mock).mockReturnValue({
    replayDisplaySettingsStore,
    clipExportSettingsStore,
    gameSimulator: { replayComparison$ },
  });
  const view = render(
    <InspectorProvider initialMode="settings">
      <DisplayTab />
    </InspectorProvider>,
  );
  return { replayDisplaySettingsStore, clipExportSettingsStore, replayComparison$, view };
}

const group = (name: string) => screen.getByRole("group", { name });
const toggle = (section: string, label: string) => within(group(section)).getByRole("checkbox", { name: label });
const slider = () => screen.getByRole("slider", { name: "UR bar size" }) as HTMLInputElement;
const showClip = () => fireEvent.click(within(group("Settings for")).getByRole("button", { name: "Exported clip" }));
const showViewer = () => fireEvent.click(within(group("Settings for")).getByRole("button", { name: "Viewer" }));

const RESULTS = ["100", "50", "Miss", "Slider break", "Slider tick", "Slider end"];
const SECTION_NAMES = ["Timing", "Performance", "Live results", "Timeline marks", "Gameplay HUD", "Cursors"];

function listRows() {
  const names = screen
    .getAllByRole("group")
    .map((element) => ({ element, name: element.getAttribute("aria-labelledby") }))
    .filter(({ name }) => name !== null)
    .map(({ element, name }) => ({ element, label: document.getElementById(name as string)?.textContent ?? "" }))
    .filter(({ label }) => SECTION_NAMES.includes(label));
  return names.map(({ element, label }) => [
    label,
    within(element as HTMLElement)
      .queryAllByRole("checkbox")
      .map((box) => box.textContent),
  ]);
}

const VIEWER_TOGGLES: Array<[string, string, string, ReplayDisplayToggleKey]> = [
  ["Timing / Key overlay", "Timing", "Key overlay", "keyOverlapEnabled"],
  ["Timing / UR", "Timing", "UR", "unstableRateEnabled"],
  ["Timing / Bias", "Timing", "Bias", "timingBiasEnabled"],
  ["Timing / UR bar", "Timing", "UR bar", "hitErrorBarEnabled"],
  ["Performance / PP", "Performance", "PP", "performancePointsEnabled"],
  ["Performance / Star rating", "Performance", "Star rating", "starRatingEnabled"],
  ["Live results / 100", "Live results", "100", "liveResult100Enabled"],
  ["Live results / 50", "Live results", "50", "liveResult50Enabled"],
  ["Live results / Miss", "Live results", "Miss", "liveResultMissEnabled"],
  ["Live results / Slider break", "Live results", "Slider break", "liveResultSliderBreakEnabled"],
  ["Live results / Slider tick", "Live results", "Slider tick", "liveResultSliderTickEnabled"],
  ["Live results / Slider end", "Live results", "Slider end", "liveResultSliderEndEnabled"],
  ["Timeline marks / 100", "Timeline marks", "100", "timeline100Enabled"],
  ["Timeline marks / 50", "Timeline marks", "50", "timeline50Enabled"],
  ["Timeline marks / Miss", "Timeline marks", "Miss", "timelineMissEnabled"],
  ["Timeline marks / Slider break", "Timeline marks", "Slider break", "timelineSliderBreakEnabled"],
  ["Timeline marks / Slider tick", "Timeline marks", "Slider tick", "timelineSliderTickEnabled"],
  ["Timeline marks / Slider end", "Timeline marks", "Slider end", "timelineSliderEndEnabled"],
  ["Gameplay HUD / Combo", "Gameplay HUD", "Combo", "currentComboEnabled"],
  ["Gameplay HUD / Accuracy", "Gameplay HUD", "Accuracy", "accuracyEnabled"],
];

const CLIP_DISPLAY_TOGGLES: Array<[string, string, string, ReplayDisplayToggleKey]> = [
  ...VIEWER_TOGGLES.filter(([, section]) => section !== "Timeline marks"),
  ["Performance / Max combo", "Performance", "Max combo", "maxComboEnabled"],
];
const CURSOR_TOGGLES: Array<[string, string, string, keyof ClipExportSettings]> = [
  ["Cursors / Replay", "Cursors", "Replay", "showReplayCursor"],
  ["Cursors / Analysis", "Cursors", "Analysis", "showAnalysisCursor"],
  ["Cursors / Comparison", "Cursors", "Comparison", "showComparisonCursor"],
];

describe("DisplayTab", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists the viewer rows in the designed order", () => {
    mount();
    expect(listRows()).toEqual([
      ["Timing", ["Key overlay", "UR", "Bias", "UR bar", "Key overlay error marks"]],
      ["Performance", ["PP", "Star rating"]],
      ["Live results", RESULTS],
      ["Timeline marks", RESULTS],
      ["Gameplay HUD", ["Combo", "Accuracy", "Miss trail", "Tap numbers"]],
    ]);
    expect(screen.getByText("Settings for")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "UR bar size" })).toBeTruthy();
    expect(screen.getByText("Breaks apply to Stable, ticks to Lazer, ends to both.")).toBeTruthy();
    expect(within(group("Settings for")).getByRole("button", { name: "Viewer" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("lists the clip rows in the designed order", () => {
    mount();
    showClip();
    expect(listRows()).toEqual([
      ["Timing", ["Key overlay", "UR", "Bias", "UR bar"]],
      ["Performance", ["PP", "Star rating", "Max combo"]],
      ["Live results", RESULTS],
      ["Gameplay HUD", ["Combo", "Accuracy"]],
      ["Cursors", ["Replay", "Analysis", "Comparison"]],
    ]);
  });

  it.each(VIEWER_TOGGLES)("toggling %s changes only that viewer key", (_name, section, label, key) => {
    const { replayDisplaySettingsStore, clipExportSettingsStore } = mount();
    const viewerBefore: ReplayDisplaySettings = { ...replayDisplaySettingsStore.settings };
    const clipBefore = JSON.parse(JSON.stringify(clipExportSettingsStore.settings));
    fireEvent.click(toggle(section, label));
    expect(replayDisplaySettingsStore.settings).toEqual({ ...viewerBefore, [key]: !viewerBefore[key] });
    expect(clipExportSettingsStore.settings).toEqual(clipBefore);
    expect(toggle(section, label).getAttribute("aria-checked")).toBe(String(!viewerBefore[key]));
  });

  it.each(CLIP_DISPLAY_TOGGLES)("toggling %s changes only the clip store", (_name, section, label, key) => {
    const { replayDisplaySettingsStore, clipExportSettingsStore } = mount({ comparison: "READY" });
    showClip();
    const viewerBefore = JSON.parse(JSON.stringify(replayDisplaySettingsStore.settings));
    const clipBefore: ClipExportSettings = JSON.parse(JSON.stringify(clipExportSettingsStore.settings));
    fireEvent.click(toggle(section, label));
    expect(replayDisplaySettingsStore.settings).toEqual(viewerBefore);
    expect(clipExportSettingsStore.settings).toEqual({
      ...clipBefore,
      displaySettings: { ...clipBefore.displaySettings, [key]: !clipBefore.displaySettings[key] },
    });
  });

  it.each(CURSOR_TOGGLES)("toggling %s changes only the clip store", (_name, section, label, key) => {
    const { replayDisplaySettingsStore, clipExportSettingsStore } = mount({ comparison: "READY" });
    showClip();
    const viewerBefore = JSON.parse(JSON.stringify(replayDisplaySettingsStore.settings));
    const clipBefore: ClipExportSettings = JSON.parse(JSON.stringify(clipExportSettingsStore.settings));
    fireEvent.click(toggle(section, label));
    expect(replayDisplaySettingsStore.settings).toEqual(viewerBefore);
    expect(clipExportSettingsStore.settings).toEqual({ ...clipBefore, [key]: !clipBefore[key] });
  });

  it("never writes the legacy keys", () => {
    const { replayDisplaySettingsStore, clipExportSettingsStore } = mount({ comparison: "READY" });
    // The clip's own Max combo toggle writes maxComboEnabled on purpose; for the viewer it stays a legacy key.
    const legacyViewer = (s: ReplayDisplaySettings) =>
      [s.judgementCountsEnabled, s.sliderJudgementsEnabled, s.maxComboEnabled, s.statsStyle].join();
    const legacyClip = (s: ReplayDisplaySettings) => [s.judgementCountsEnabled, s.sliderJudgementsEnabled, s.statsStyle].join();
    const viewerLegacy = legacyViewer(replayDisplaySettingsStore.settings);
    const clipLegacy = legacyClip(clipExportSettingsStore.settings.displaySettings);
    const clipOthers = String(clipExportSettingsStore.settings.showHitErrorBar);
    for (const [, section, label] of VIEWER_TOGGLES) fireEvent.click(toggle(section, label));
    showClip();
    for (const [, section, label] of CLIP_DISPLAY_TOGGLES) fireEvent.click(toggle(section, label));
    expect(legacyViewer(replayDisplaySettingsStore.settings)).toBe(viewerLegacy);
    expect(legacyClip(clipExportSettingsStore.settings.displaySettings)).toBe(clipLegacy);
    expect(String(clipExportSettingsStore.settings.showHitErrorBar)).toBe(clipOthers);
  });

  it("offers Max combo for the exported clip only, and it writes the clip store alone", () => {
    const { replayDisplaySettingsStore, clipExportSettingsStore } = mount();
    // The viewer has no such toggle; its Gameplay HUD Combo is another row and key.
    expect(within(group("Performance")).queryByRole("checkbox", { name: "Max combo" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Max combo" })).toBeNull();
    showClip();
    const viewerBefore = JSON.parse(JSON.stringify(replayDisplaySettingsStore.settings));
    expect(clipExportSettingsStore.settings.displaySettings.maxComboEnabled).toBe(true);
    expect(toggle("Performance", "Max combo").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle("Performance", "Max combo"));
    expect(clipExportSettingsStore.settings.displaySettings.maxComboEnabled).toBe(false);
    expect(clipExportSettingsStore.settings.displaySettings.currentComboEnabled).toBe(true);
    expect(replayDisplaySettingsStore.settings).toEqual(viewerBefore);
    showViewer();
    expect(screen.queryByRole("checkbox", { name: "Max combo" })).toBeNull();
    expect(replayDisplaySettingsStore.settings.maxComboEnabled).toBe(true);
  });

  it("hides Timeline marks and Error cause detail for the exported clip", () => {
    mount();
    expect(screen.getByRole("group", { name: "Error cause detail" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Cursors" })).toBeNull();
    showClip();
    expect(screen.queryByRole("group", { name: "Timeline marks" })).toBeNull();
    expect(screen.queryByText("Breaks apply to Stable, ticks to Lazer, ends to both.")).toBeNull();
    expect(screen.queryByRole("group", { name: "Error cause detail" })).toBeNull();
    expect(screen.queryByText("Error cause detail")).toBeNull();
    expect(screen.getByRole("group", { name: "Cursors" })).toBeTruthy();
  });

  it("shows a saved UR bar scale of 2 as 100% and writes 3 for 150%", () => {
    const { replayDisplaySettingsStore } = mount();
    expect(replayDisplaySettingsStore.settings.hitErrorBarScale).toBe(2);
    expect(screen.getByText("100%")).toBeTruthy();
    expect(slider().value).toBe("100");
    expect(slider().min).toBe("50");
    expect(slider().max).toBe("200");
    fireEvent.change(slider(), { target: { value: "150" } });
    expect(replayDisplaySettingsStore.settings.hitErrorBarScale).toBe(3);
  });

  it("edits the clip's own UR bar scale for the exported clip", () => {
    const { replayDisplaySettingsStore, clipExportSettingsStore } = mount();
    showClip();
    fireEvent.change(slider(), { target: { value: "150" } });
    expect(clipExportSettingsStore.settings.displaySettings.hitErrorBarScale).toBe(3);
    expect(replayDisplaySettingsStore.settings.hitErrorBarScale).toBe(2);
  });

  it("disables the size slider while the UR bar is off", () => {
    mount();
    expect(slider().disabled).toBe(false);
    fireEvent.click(toggle("Timing", "UR bar"));
    expect(slider().disabled).toBe(true);
    fireEvent.click(toggle("Timing", "UR bar"));
    expect(slider().disabled).toBe(false);
  });

  it("shows an out-of-range saved size as it is", () => {
    window.localStorage.clear();
    const replayDisplaySettingsStore = new ReplayDisplaySettingsStore();
    replayDisplaySettingsStore.changeSettings((draft) => {
      draft.hitErrorBarScale = 0.6;
    });
    const clipExportSettingsStore = new ClipExportSettingsStore();
    (useAnalysisApp as jest.Mock).mockReturnValue({
      replayDisplaySettingsStore,
      clipExportSettingsStore,
      gameSimulator: { replayComparison$: new BehaviorSubject({ status: "EMPTY" }) },
    });
    render(
      <InspectorProvider initialMode="settings">
        <DisplayTab />
      </InspectorProvider>,
    );
    expect(screen.getByText("30%")).toBeTruthy();
    expect(slider().value).toBe("50");
    expect(replayDisplaySettingsStore.settings.hitErrorBarScale).toBe(0.6);
  });

  it("switches the error cause detail", () => {
    const { replayDisplaySettingsStore } = mount();
    const detail = within(group("Error cause detail"));
    expect(detail.getByRole("button", { name: "Concise" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(detail.getByRole("button", { name: "Brief" }));
    expect(replayDisplaySettingsStore.settings.errorCauseDisplay).toBe("brief");
    expect(detail.getByRole("button", { name: "Brief" }).getAttribute("aria-pressed")).toBe("true");
  });

  describe("Key overlay length", () => {
    const length = (name: string) =>
      within(group("Key overlay length")).getByRole("button", { name }) as HTMLButtonElement;
    const pressed = () =>
      within(group("Key overlay length"))
        .getAllByRole("button")
        .map((button) => [button.textContent, button.getAttribute("aria-pressed")]);

    it("offers Short, Medium and Long under Timing, above the UR bar size, with Medium chosen", () => {
      mount();
      expect(within(group("Timing")).getByRole("group", { name: "Key overlay length" })).toBeTruthy();
      expect(pressed()).toEqual([
        ["Short", "false"],
        ["Medium", "true"],
        ["Long", "false"],
      ]);
      const follows = group("Key overlay length").compareDocumentPosition(slider());
      expect(follows & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("writes only the viewer's length", () => {
      const { replayDisplaySettingsStore, clipExportSettingsStore } = mount();
      const viewerBefore: ReplayDisplaySettings = { ...replayDisplaySettingsStore.settings };
      const clipBefore = JSON.parse(JSON.stringify(clipExportSettingsStore.settings));
      fireEvent.click(length("Long"));
      expect(replayDisplaySettingsStore.settings).toEqual({ ...viewerBefore, keyOverlayLength: "long" });
      expect(clipExportSettingsStore.settings).toEqual(clipBefore);
      expect(length("Long").getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(length("Short"));
      expect(replayDisplaySettingsStore.settings.keyOverlayLength).toBe("short");
    });

    it("edits the clip's own length for the exported clip", () => {
      const { replayDisplaySettingsStore, clipExportSettingsStore } = mount();
      showClip();
      fireEvent.click(length("Short"));
      expect(clipExportSettingsStore.settings.displaySettings.keyOverlayLength).toBe("short");
      expect(replayDisplaySettingsStore.settings.keyOverlayLength).toBe("medium");
      showViewer();
      expect(length("Medium").getAttribute("aria-pressed")).toBe("true");
    });

    it("cannot be changed while the key overlay is off, and keeps its choice", () => {
      const { replayDisplaySettingsStore } = mount();
      expect(length("Long").disabled).toBe(false);
      fireEvent.click(toggle("Timing", "Key overlay"));
      expect(length("Long").disabled).toBe(true);
      fireEvent.click(length("Long"));
      expect(replayDisplaySettingsStore.settings.keyOverlayLength).toBe("medium");
      expect(length("Medium").getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(toggle("Timing", "Key overlay"));
      expect(length("Long").disabled).toBe(false);
    });
  });

  describe("Key overlay error marks", () => {
    it("is a viewer toggle under Timing, on by default, that writes only the viewer's choice", () => {
      const { replayDisplaySettingsStore, clipExportSettingsStore } = mount();
      const clipBefore = JSON.parse(JSON.stringify(clipExportSettingsStore.settings));
      expect(toggle("Timing", "Key overlay error marks").getAttribute("aria-checked")).toBe("true");
      fireEvent.click(toggle("Timing", "Key overlay error marks"));
      expect(replayDisplaySettingsStore.settings.keyOverlayErrorMarksEnabled).toBe(false);
      // It has nothing to do with the outline on the playfield.
      expect(replayDisplaySettingsStore.settings.errorOutline).toBe("off");
      expect(clipExportSettingsStore.settings).toEqual(clipBefore);
    });

    it("is dimmed while the key overlay itself is off", () => {
      mount();
      expect(toggle("Timing", "Key overlay error marks").getAttribute("aria-disabled")).not.toBe("true");
      fireEvent.click(toggle("Timing", "Key overlay"));
      expect(toggle("Timing", "Key overlay error marks").getAttribute("aria-disabled")).toBe("true");
    });
  });

  describe("Error outline", () => {
    const mode = (name: string) => within(group("Error outline")).getByRole("button", { name });

    it("offers Off, Selected and All under Gameplay HUD, with Off chosen", () => {
      mount();
      expect(within(group("Gameplay HUD")).getByRole("group", { name: "Error outline" })).toBeTruthy();
      expect(
        within(group("Error outline"))
          .getAllByRole("button")
          .map((button) => [button.textContent, button.getAttribute("aria-pressed")]),
      ).toEqual([
        ["Off", "true"],
        ["Selected", "false"],
        ["All", "false"],
      ]);
    });

    it("writes only the viewer's choice", () => {
      const { replayDisplaySettingsStore, clipExportSettingsStore } = mount();
      const viewerBefore: ReplayDisplaySettings = { ...replayDisplaySettingsStore.settings };
      const clipBefore = JSON.parse(JSON.stringify(clipExportSettingsStore.settings));
      fireEvent.click(mode("Selected"));
      expect(replayDisplaySettingsStore.settings).toEqual({ ...viewerBefore, errorOutline: "selected" });
      expect(mode("Selected").getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(mode("Off"));
      expect(replayDisplaySettingsStore.settings.errorOutline).toBe("off");
      expect(clipExportSettingsStore.settings).toEqual(clipBefore);
    });

    it("has a Miss trail toggle (on) and a Tap numbers toggle (off) that write only the viewer's choices", () => {
      const { replayDisplaySettingsStore, clipExportSettingsStore } = mount();
      // The toggles need an outline to go with.
      fireEvent.click(mode("All"));
      const viewerBefore: ReplayDisplaySettings = { ...replayDisplaySettingsStore.settings };
      const clipBefore = JSON.parse(JSON.stringify(clipExportSettingsStore.settings));
      expect(toggle("Gameplay HUD", "Miss trail").getAttribute("aria-checked")).toBe("true");
      expect(toggle("Gameplay HUD", "Tap numbers").getAttribute("aria-checked")).toBe("false");
      fireEvent.click(toggle("Gameplay HUD", "Tap numbers"));
      expect(replayDisplaySettingsStore.settings).toEqual({ ...viewerBefore, tapNumbersEnabled: true });
      fireEvent.click(toggle("Gameplay HUD", "Miss trail"));
      expect(replayDisplaySettingsStore.settings).toEqual({
        ...viewerBefore,
        tapNumbersEnabled: true,
        missTrailEnabled: false,
      });
      expect(clipExportSettingsStore.settings).toEqual(clipBefore);
    });

    it("dims Miss trail while the outline is off, and Tap numbers while there is no trail to label", () => {
      const { replayDisplaySettingsStore } = mount();
      const disabled = (label: string) => toggle("Gameplay HUD", label).getAttribute("aria-disabled") === "true";
      // Off is the default.
      expect([disabled("Miss trail"), disabled("Tap numbers")]).toEqual([true, true]);
      fireEvent.click(mode("All"));
      expect([disabled("Miss trail"), disabled("Tap numbers")]).toEqual([false, false]);
      fireEvent.click(toggle("Gameplay HUD", "Miss trail"));
      expect([disabled("Miss trail"), disabled("Tap numbers")]).toEqual([false, true]);
      fireEvent.click(toggle("Gameplay HUD", "Tap numbers"));
      expect(replayDisplaySettingsStore.settings.tapNumbersEnabled).toBe(false);
      fireEvent.click(toggle("Gameplay HUD", "Miss trail"));
      fireEvent.click(mode("Off"));
      expect([disabled("Miss trail"), disabled("Tap numbers")]).toEqual([true, true]);
      fireEvent.click(toggle("Gameplay HUD", "Miss trail"));
      expect(replayDisplaySettingsStore.settings.missTrailEnabled).toBe(true);
    });

    it("is not offered for the exported clip, which never draws it", () => {
      mount();
      showClip();
      expect(screen.queryByRole("group", { name: "Error outline" })).toBeNull();
      expect(screen.queryByText("Error outline")).toBeNull();
      expect(screen.queryByRole("checkbox", { name: "Miss trail" })).toBeNull();
      expect(screen.queryByRole("checkbox", { name: "Tap numbers" })).toBeNull();
      showViewer();
      expect(screen.getByRole("group", { name: "Error outline" })).toBeTruthy();
    });
  });

  it("disables Comparison until a comparison is ready and keeps its saved value", () => {
    const { clipExportSettingsStore, replayComparison$ } = mount();
    clipExportSettingsStore.changeSettings((draft) => {
      draft.showComparisonCursor = true;
    });
    showClip();
    const comparison = () => toggle("Cursors", "Comparison");
    expect(comparison().getAttribute("aria-disabled")).toBe("true");
    expect(comparison().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(comparison());
    expect(clipExportSettingsStore.settings.showComparisonCursor).toBe(true);
    expect(toggle("Cursors", "Replay").getAttribute("aria-disabled")).not.toBe("true");
    act(() => replayComparison$.next({ status: "READY" }));
    expect(comparison().getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(comparison());
    expect(clipExportSettingsStore.settings.showComparisonCursor).toBe(false);
    act(() => replayComparison$.next({ status: "EMPTY" }));
    expect(comparison().getAttribute("aria-disabled")).toBe("true");
    expect(clipExportSettingsStore.settings.showComparisonCursor).toBe(false);
  });

  it("keeps the two targets independent", () => {
    mount();
    showClip();
    fireEvent.click(toggle("Performance", "PP"));
    expect(toggle("Performance", "PP").getAttribute("aria-checked")).toBe("false");
    showViewer();
    expect(toggle("Performance", "PP").getAttribute("aria-checked")).toBe("true");
    showClip();
    expect(toggle("Performance", "PP").getAttribute("aria-checked")).toBe("false");
  });
});
