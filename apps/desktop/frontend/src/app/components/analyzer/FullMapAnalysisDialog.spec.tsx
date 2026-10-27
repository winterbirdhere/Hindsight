import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { OsuClassicMods, type ReplayAnalysisEvent, type ReplayAnalysisRuleset } from "@osujs/core";
import { FULL_MAP_MOD_ICON_ATTRIBUTION, FULL_MAP_MOD_ICONS } from "../../../assets/full-map-mod-icons";
import { analyzeFullMap } from "../../services/analysis/full-map-analysis";
import {
  buildFullMapAnalysisViewModel,
  buildFullMapReplayMods,
  rankColorForGrade,
  type FullMapAnalysisViewModel,
  type FullMapGrade,
} from "../../services/analysis/full-map-analysis-view-model";
import { FullMapAnalysisDialog } from "./FullMapAnalysisDialog";
import type { ReplaySimulationValidation } from "../../services/common/game/GameSimulator";
import type { FullMapPerformance } from "../../services/analysis/performance/PerformanceTimelineService";
import type { FullMapErrorCauses } from "./full-map-error-causes";
import { FULL_MAP_HEAD_HEIGHT } from "./full-map-styles";

const UR_GRAPH = "Unstable rate over time";
const ERROR_GRAPH = "Timing error over time";
const overTheMap = () => screen.getByRole("region", { name: "Over the map" });
/** An option of the band's switch between its two graphs. */
const graphOption = (name: "Unstable rate · 50 hits" | "Hit error") =>
  within(within(overTheMap()).getByRole("group", { name: "Graph" })).getByRole("button", { name });
/** Shows the hit-error graph in place of the unstable rate's, and returns it. */
function showHitError() {
  fireEvent.click(graphOption("Hit error"));
  return within(overTheMap()).getByRole("img", { name: ERROR_GRAPH });
}

it("switches the one graph between unstable rate and hit error and resets on reopen and on a ruleset change", () => {
  const viewModel = stableViewModel();
  const props = { canSwitchRuleset: true, onSwitchRuleset: jest.fn(), onClose: jest.fn() };
  const { rerender } = render(<FullMapAnalysisDialog {...props} open viewModel={viewModel} />);
  const band = overTheMap();
  const shown = () =>
    within(overTheMap())
      .getAllByRole("img")
      .map((graph) => graph.getAttribute("aria-label"));
  const pressed = () =>
    within(within(overTheMap()).getByRole("group", { name: "Graph" }))
      .getAllByRole("button")
      .map((button) => [button.textContent, button.getAttribute("aria-pressed")]);
  // The head: the band's name, then the switch.
  expectDocumentOrder([
    within(band).getByRole("heading", { name: "OVER THE MAP" }),
    within(band).getByRole("group", { name: "Graph" }),
    within(band).getByRole("img", { name: UR_GRAPH }),
  ]);
  expect(shown()).toEqual([UR_GRAPH]);
  expect(pressed()).toEqual([
    ["Unstable rate · 50 hits", "true"],
    ["Hit error", "false"],
  ]);
  // The rolling series and its peak, not the cumulative one.
  expect(within(band).getByTestId("current-ur-line")).toBeTruthy();
  expect(within(band).getByTestId("peak-current-ur-value").textContent).toBe(
    viewModel.summary.timing.peakUr?.unstableRate.toFixed(1),
  );
  const result = screen.getByRole("region", { name: "Result" });
  const overallBefore = within(result).getByLabelText(/^Overall UR /).textContent;
  expect(overallBefore).toBe(overallUr(viewModel));

  fireEvent.click(graphOption("Hit error"));
  expect(shown()).toEqual([ERROR_GRAPH]);
  expect(pressed()).toEqual([
    ["Unstable rate · 50 hits", "false"],
    ["Hit error", "true"],
  ]);
  expect(within(result).getByLabelText(/^Overall UR /).textContent).toBe(overallBefore);
  // Choosing the shown graph again changes nothing.
  fireEvent.click(graphOption("Hit error"));
  expect(shown()).toEqual([ERROR_GRAPH]);
  fireEvent.click(graphOption("Unstable rate · 50 hits"));
  expect(shown()).toEqual([UR_GRAPH]);

  // Another ruleset starts from the unstable rate again.
  fireEvent.click(graphOption("Hit error"));
  rerender(<FullMapAnalysisDialog {...props} open viewModel={lazerViewModel()} />);
  expect(shown()).toEqual([UR_GRAPH]);

  // And so does opening the page again.
  fireEvent.click(graphOption("Hit error"));
  expect(shown()).toEqual([ERROR_GRAPH]);
  rerender(<FullMapAnalysisDialog {...props} open={false} viewModel={lazerViewModel()} />);
  rerender(<FullMapAnalysisDialog {...props} open viewModel={lazerViewModel()} />);
  expect(shown()).toEqual([UR_GRAPH]);
});

it("has no Cumulative control", () => {
  renderDialog(stableViewModel());
  expect(screen.queryByRole("button", { name: /Cumulative/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /Rolling/i })).toBeNull();
  expect(screen.queryByRole("group", { name: "UR sample scope" })).toBeNull();
  expect(screen.queryByRole("img", { name: "Average unstable rate over time" })).toBeNull();
  // The two old chart panels are gone with it: one band, one graph.
  expect(screen.queryByRole("region", { name: "Timing consistency" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Hit error" })).toBeNull();
  expect(screen.queryByRole("heading", { name: /Timing consistency|Hit error/ })).toBeNull();
  expect(within(overTheMap()).getAllByRole("button")).toHaveLength(2);
});

it("passes a graph click to `onOpenReplayAt`", () => {
  const onOpenReplayAt = jest.fn();
  const viewModel = stableViewModel();
  renderDialog(viewModel, { onOpenReplayAt });
  const hint = within(overTheMap()).getByText("Click the graph to open the replay there");
  expect(window.getComputedStyle(hint).color).toBe("rgb(168, 165, 158)");
  expect(
    within(overTheMap()).getByRole("group", { name: "Graph" }).compareDocumentPosition(hint) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  // The unstable rate's first point is the second timed hit; the hit error's is the first.
  const urGraph = within(overTheMap()).getByRole("img", { name: UR_GRAPH });
  // The plot is what opens the replay, so the plot shows it; a click needs to land on the plot (x 80..1784 of the frame).
  expect(urGraph.style.cursor).toBe("");
  expect(within(urGraph).getByTestId("current-ur-interaction-layer").style.cursor).toBe("pointer");
  fireEvent.click(within(urGraph).getByTestId("current-ur-interaction-layer"), { clientX: 100, clientY: 100 });
  expect(onOpenReplayAt).toHaveBeenCalledTimes(1);
  expect(onOpenReplayAt).toHaveBeenLastCalledWith(viewModel.summary.timing.urOverTime[0].time);

  const errorGraph = showHitError();
  fireEvent.focus(errorGraph);
  fireEvent.keyDown(errorGraph, { key: "End" });
  fireEvent.keyDown(errorGraph, { key: "Enter" });
  expect(onOpenReplayAt).toHaveBeenCalledTimes(2);
  expect(onOpenReplayAt).toHaveBeenLastCalledWith(5_000);
});

it("offers no jump to the replay without `onOpenReplayAt`", () => {
  renderDialog(stableViewModel());
  expect(screen.queryByText("Click the graph to open the replay there")).toBeNull();
  expect(within(overTheMap()).getByRole("img", { name: UR_GRAPH }).style.cursor).toBe("");
  expect(showHitError().style.cursor).toBe("");
});

it("draws the map's marks under whichever graph is shown", () => {
  const viewModel = stableViewModel();
  viewModel.marks = { miss: [4_000], sliderBreak: [5_000], ok: [2_000], meh: [3_000] };
  renderDialog(viewModel);
  const counts = () =>
    ["miss", "sliderBreak", "ok", "meh"].map((kind) =>
      within(overTheMap()).queryByTestId(`map-marks-${kind}`)?.getAttribute("data-count"),
    );
  // The unstable rate's axis starts at its first point, 0:02; the hit error's at the first object.
  expect(counts()).toEqual(["1", "1", "1", "1"]);
  showHitError();
  expect(counts()).toEqual(["1", "1", "1", "1"]);
  expect(within(overTheMap()).getAllByTestId("map-marks-lane")).toHaveLength(1);
});

const position = { x: 256, y: 192 };

function judgement(
  id: string,
  verdict: "GREAT" | "OK" | "MEH" | "MISS",
  time: number,
  ruleset: ReplayAnalysisRuleset,
  notelock = false,
): ReplayAnalysisEvent {
  return {
    type: "HitObjectJudgement",
    eventId: `${ruleset}:hit-object-judgement:${id}`,
    ruleset,
    time,
    objectTime: time,
    judgementTime: time,
    hitObjectId: id,
    verdict,
    notelockCause: notelock
      ? ruleset === "lazer"
        ? {
            kind: "LAZER_BLOCKED_VALID_PRESS",
            targetHitObjectId: id,
            blockerHitObjectId: "blocking-object",
            pressTime: time - 10,
            cursorDistance: 0,
            objectRadius: 64,
            wouldHaveHit: "GREAT",
          }
        : {
            kind: "STABLE_BLOCKED_VALID_PRESS",
            targetHitObjectId: id,
            blockerHitObjectId: "blocking-object",
            pressTime: time - 10,
            cursorDistance: 0,
            objectRadius: 64,
            wouldHaveHit: "GREAT",
          }
      : undefined,
    position,
  };
}

function stableSliderBreak(time: number): ReplayAnalysisEvent {
  return {
    type: "SliderBreak",
    eventId: "stable:slider-break:slider/TICK",
    ruleset: "stable",
    time,
    objectTime: time,
    judgementTime: time,
    sliderId: "slider",
    componentId: "slider/TICK",
    componentType: "TICK",
    position,
  };
}

function stableSliderEndMiss(time: number): ReplayAnalysisEvent {
  return {
    type: "CheckpointJudgement",
    eventId: "stable:checkpoint-judgement:slider/LAST_LEGACY_TICK",
    ruleset: "stable",
    time,
    objectTime: time - 500,
    judgementTime: time,
    sliderEndTime: time,
    sliderId: "slider",
    checkpointId: "slider/LAST_LEGACY_TICK",
    checkpointType: "LAST_LEGACY_TICK",
    position,
    hit: false,
    isLastTick: true,
  };
}

function lazerComponentMiss(componentType: "TICK" | "TAIL", time: number): ReplayAnalysisEvent {
  return {
    type: "SliderComponentMiss",
    eventId: `lazer:slider-component-miss:slider/${componentType}`,
    ruleset: "lazer",
    time,
    objectTime: time,
    judgementTime: time,
    sliderId: "slider",
    componentId: `slider/${componentType}`,
    componentType,
    position,
  };
}

const beatmapEvidence = {
  durationMs: 12_000,
  completionTimeMs: 11_500,
  objectCount: 12,
  hitCircleCount: 7,
  sliderCount: 4,
  timingPoints: [{ time: 0, beatLength: 500 }],
  difficulty: {
    drainRate: 5,
    circleSize: 4,
    overallDifficulty: 8,
    approachRate: 9,
  },
} as const;

function stableViewModel(
  passed: boolean | null = true,
  sourceRuleset: ReplayAnalysisRuleset = "stable",
): FullMapAnalysisViewModel {
  const summary = analyzeFullMap({
    ruleset: "stable",
    events: [
      judgement("great", "GREAT", 1_000, "stable"),
      judgement("ok", "OK", 2_000, "stable"),
      judgement("meh", "MEH", 3_000, "stable"),
      judgement("notelocked", "MISS", 4_000, "stable", true),
      stableSliderBreak(5_000),
      stableSliderEndMiss(6_000),
    ],
    hits: [
      [1_000, -18, true],
      [2_000, -7, true],
      [3_000, 5, true],
      [4_000, 250, false],
      [5_000, 16, true],
    ],
    duration: 12_000,
    baseRate: 1,
    aggregateJudgementCountsInput: [8, 2, 1, 1],
    maxComboObtained: 321,
    mapMaxCombo: 654,
    objectCoverage: { totalObjectCount: 12, excludedSpinnerCount: 0, unsupportedObjectCount: 0 },
  });

  return buildFullMapAnalysisViewModel({
    summary,
    replay: { passed, lastFrameTimeMs: passed === false ? 7_000 : 12_000, mods: [], sourceRuleset },
    beatmap: beatmapEvidence,
  });
}

function lazerViewModel(sourceRuleset: ReplayAnalysisRuleset = "stable"): FullMapAnalysisViewModel {
  const summary = analyzeFullMap({
    ruleset: "lazer",
    events: [
      judgement("great", "GREAT", 1_000, "lazer"),
      judgement("ok", "OK", 2_000, "lazer"),
      judgement("meh", "MEH", 3_000, "lazer"),
      judgement("miss", "MISS", 4_000, "lazer"),
      lazerComponentMiss("TICK", 5_000),
      lazerComponentMiss("TAIL", 6_000),
    ],
    hits: [
      [1_000, -12, true],
      [2_000, 4, true],
      [3_000, 14, true],
    ],
    duration: 12_000,
    baseRate: 1,
    aggregateAccuracyInput: 0.86,
    aggregateJudgementCountsInput: [6, 2, 1, 1],
    maxComboObtained: 280,
    mapMaxCombo: 654,
    objectCoverage: { totalObjectCount: 10, excludedSpinnerCount: 0, unsupportedObjectCount: 0 },
  });

  return buildFullMapAnalysisViewModel({
    summary,
    replay: { passed: true, lastFrameTimeMs: 12_000, mods: [], sourceRuleset },
    beatmap: { ...beatmapEvidence, objectCount: 10 },
  });
}

function missingTimingViewModel(): FullMapAnalysisViewModel {
  const summary = analyzeFullMap({
    ruleset: "stable",
    events: [],
    hits: [],
    duration: 12_000,
    baseRate: 1,
    aggregateJudgementCountsInput: [0, 0, 0, 0],
    objectCoverage: { totalObjectCount: 0 },
  });
  return buildFullMapAnalysisViewModel({
    summary,
    replay: { passed: null, mods: [], sourceRuleset: "stable" },
    beatmap: { ...beatmapEvidence, objectCount: 0 },
  });
}

const readyPerformance: FullMapPerformance = {
  status: "ready",
  pp: 234.567,
  sr: 7.1999,
  breakdown: { total: 7.19, aim: 3.93, speed: 1.99, reading: 1.27, flashlight: 0, sliderAim: 0.07 },
  description: "Stable: final achieved replay PP and full-map difficulty.",
};

/** The rules of one media query that mention one of the element's generated classes. */
function mediaRules(element: Element, query: string): string {
  const classes = Array.from(element.classList).filter((name) => name.startsWith("css-"));
  const rules = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
  return rules
    .filter((rule) => rule.cssText.startsWith(query) && classes.some((name) => rule.cssText.includes("." + name)))
    .map((rule) => rule.cssText)
    .join("\n");
}

/** The rules of each small-window media query that mention one of the element's generated classes. */
function smallWindowRules(element: Element): string[] {
  return ["@media (max-width: 1099px)", "@media (max-height: 699px)"].map((query) => mediaRules(element, query));
}

function expectDocumentOrder(elements: Element[]) {
  for (let index = 1; index < elements.length; index++) {
    expect(
      elements[index - 1].compareDocumentPosition(elements[index]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
}

/** The element under `container` whose whole text is `text`, however it is split into spans. */
function wholeText(container: HTMLElement, text: string): HTMLElement {
  return within(container).getByText((_, element) => element?.textContent === text);
}

const dialogHeader = () => screen.getByRole("heading", { name: "Full-map analysis" }).closest("header") as HTMLElement;
const dialogFooter = () => screen.getByText("Length").closest("footer") as HTMLElement;
const overallUr = (viewModel: FullMapAnalysisViewModel) => (viewModel.summary.timing.unstableRate as number).toFixed(1);
const rulesetGroup = () => within(dialogHeader()).getByRole("group", { name: "Analysis ruleset" });

function renderDialog(
  viewModel: FullMapAnalysisViewModel,
  options: {
    canSwitchRuleset?: boolean;
    onSwitchRuleset?: jest.Mock;
    onClose?: jest.Mock;
    replayValidation?: ReplaySimulationValidation;
    performance?: FullMapPerformance;
    errorCauses?: FullMapErrorCauses;
    onOpenReplayAt?: (timeMs: number) => void;
  } = {},
) {
  const onSwitchRuleset = options.onSwitchRuleset ?? jest.fn();
  const onClose = options.onClose ?? jest.fn();
  const result = render(
    <FullMapAnalysisDialog
      open
      viewModel={viewModel}
      replayValidation={options.replayValidation}
      performance={options.performance}
      errorCauses={options.errorCauses}
      canSwitchRuleset={options.canSwitchRuleset ?? true}
      onSwitchRuleset={onSwitchRuleset}
      onOpenReplayAt={options.onOpenReplayAt}
      onClose={onClose}
    />,
  );
  return { ...result, onSwitchRuleset, onClose };
}

describe("FullMapAnalysisDialog", () => {
  const postFailureValidation = {
    verified: false,
    expectedCounts: [8, 2, 1, 16],
    simulatedCounts: [8, 2, 1, 1],
    expectedMaxCombo: 321,
    simulatedMaxCombo: 321,
    warnings: [],
    postFailureMisses: { count: 15, scoringEndTime: 7000, recordedEndTime: 7300 },
  };

  it("shows no comparison and no note when only confirmed post-failure misses differ", () => {
    renderDialog(stableViewModel(), { replayValidation: postFailureValidation });
    expect(screen.queryByRole("note", { name: "Saved score differs" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Judgements" })).queryByText("Saved")).toBeNull();
    expect(screen.getByRole("region", { name: "MISS: 1" })).toBeTruthy();
  });

  it("retains a real combo difference and explains the unchanged saved miss count", () => {
    renderDialog(stableViewModel(), {
      replayValidation: { ...postFailureValidation, expectedMaxCombo: 400 },
    });
    const misses = screen.getByRole("region", { name: "MISS: saved 16, Hindsight 1" });
    expect(within(misses).getByText("16").getAttribute("title")).toBe("Saved includes 15 misses after failure.");
    expect(screen.getByRole("region", { name: "Max combo: saved 400, Hindsight 321" })).toBeTruthy();
  });

  it("has no Count or Share header in the normal view: the two columns speak for themselves", () => {
    renderDialog(stableViewModel(), {
      replayValidation: {
        verified: true,
        expectedCounts: [8, 2, 1, 1],
        simulatedCounts: [8, 2, 1, 1],
        expectedMaxCombo: 321,
        simulatedMaxCombo: 321,
        warnings: [],
      },
    });
    const results = screen.getByRole("region", { name: "Judgements" });
    expect(within(results).queryByText("Count")).toBeNull();
    expect(within(results).queryByText("Share")).toBeNull();
    expect(within(results).queryByText("Saved")).toBeNull();
    // The values are still there, in the same row as their name.
    expect(within(within(results).getByRole("region", { name: "300: 8" })).getByTestId("result-row-percentage").textContent).toBe(
      "66.67%",
    );
  });
  it("shows unavailable saved counts without inventing zeroes for a combo-only comparison", () => {
    renderDialog(stableViewModel(), {
      replayValidation: {
        verified: false,
        simulatedCounts: [8, 2, 1, 1],
        expectedMaxCombo: 400,
        simulatedMaxCombo: 321,
        warnings: [],
      },
    });
    expect(screen.getByRole("region", { name: "300: saved unavailable, Hindsight 8" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Max combo: saved 400, Hindsight 321" })).toBeTruthy();
  });
  describe("the saved score beside Hindsight's", () => {
    const differing: ReplaySimulationValidation = {
      verified: false,
      expectedCounts: [9, 2, 1, 0],
      simulatedCounts: [8, 2, 1, 1],
      expectedMaxCombo: 400,
      simulatedMaxCombo: 321,
      warnings: [],
    };
    const savedCell = (row: HTMLElement) => within(row).getByTestId("result-row-count").previousElementSibling as HTMLElement;

    it("is shown without a click when the saved score differs, with Share, the colours and the result row's max combo", () => {
      renderDialog(stableViewModel(), { replayValidation: differing });
      const results = screen.getByRole("region", { name: "Judgements" });
      // Only the comparison needs column names: the header row has Saved, Hindsight and Share.
      expect(within(results).getByText("Saved")).toBeTruthy();
      expect(within(results).getByText("Hindsight")).toBeTruthy();
      expect(within(results).getByText("Share")).toBeTruthy();
      expect(within(results).queryByText("Count")).toBeNull();
      expect(within(results).getByRole("region", { name: "300: saved 9, Hindsight 8" })).toBeTruthy();
      expect(within(results).getByRole("region", { name: "MISS: saved 0, Hindsight 1" })).toBeTruthy();
      expect(within(results).getByRole("region", { name: "100: saved 2, Hindsight 2" })).toBeTruthy();
      const combo = within(screen.getByRole("region", { name: "Result" })).getByRole("region", {
        name: "Max combo: saved 400, Hindsight 321",
      });
      expect(combo.textContent).toBe("Saved 400 · Hindsight 321");
      expect(within(results).queryByText(/Max combo/i)).toBeNull();
      expect(within(results).getAllByTestId("result-row-label").slice(0, 4).map((label) => getComputedStyle(label).color)).toEqual([
        "rgb(124, 196, 245)",
        "rgb(143, 232, 175)",
        "rgb(245, 205, 110)",
        "rgb(255, 112, 130)",
      ]);
      expect(within(results).getAllByTestId("result-row-percentage").map((cell) => cell.textContent)).toEqual([
        "66.67%",
        "16.67%",
        "8.33%",
        "8.33%",
      ]);
      expect(results.textContent).not.toMatch(/[+−][0-9]/);
    });

    it("has no button to turn it on or to ask why", () => {
      renderDialog(stableViewModel(), { replayValidation: differing });
      expect(screen.queryByRole("button", { name: /compare saved/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /why results differ/i })).toBeNull();
      expect(within(screen.getByRole("region", { name: "Judgements" })).queryByRole("button")).toBeNull();
      expect(screen.queryByText("Compare saved")).toBeNull();
    });

    it("sets a saved count that equals Hindsight's quiet, and one that differs in white", () => {
      renderDialog(stableViewModel(), { replayValidation: differing });
      const row = (name: string) => screen.getByRole("region", { name });
      const quiet = savedCell(row("100: saved 2, Hindsight 2"));
      expect([quiet.textContent, getComputedStyle(quiet).color, getComputedStyle(quiet).fontWeight]).toEqual(["2", "rgb(168, 165, 158)", "400"]);
      expect(quiet.hasAttribute("data-differs")).toBe(false);
      expect(savedCell(row("50: saved 1, Hindsight 1")).hasAttribute("data-differs")).toBe(false);
      for (const [name, text] of [["300: saved 9, Hindsight 8", "9"], ["MISS: saved 0, Hindsight 1", "0"]]) {
        const cell = savedCell(row(name));
        expect([cell.textContent, getComputedStyle(cell).color, getComputedStyle(cell).fontWeight, cell.getAttribute("data-differs")]).toEqual([
          text,
          "rgb(255, 255, 255)",
          "600",
          "true",
        ]);
      }
      // Hindsight's own counts are as they were.
      const count = within(row("100: saved 2, Hindsight 2")).getByTestId("result-row-count");
      expect(getComputedStyle(count).fontWeight).toBe("500");
    });

    it("shows the pair for the max combo only when the saved one is a number that differs from Hindsight's", () => {
      const same = { ...differing, expectedMaxCombo: 321 };
      const { unmount } = renderDialog(stableViewModel(), { replayValidation: same });
      // The counts still differ, so the columns are there; the combo is plain.
      expect(within(screen.getByRole("region", { name: "Judgements" })).getByText("Saved")).toBeTruthy();
      expect(screen.queryByRole("region", { name: /^Max combo: saved/ })).toBeNull();
      expect(screen.getByLabelText(/^Max combo 321/)).toBeTruthy();
      unmount();

      renderDialog(stableViewModel(), { replayValidation: { ...differing, expectedMaxCombo: undefined } });
      expect(screen.queryByRole("region", { name: /^Max combo: saved/ })).toBeNull();
      expect(screen.getByLabelText(/^Max combo 321/)).toBeTruthy();
    });

    it("is not shown when the saved score matches", () => {
      renderDialog(stableViewModel(), {
        replayValidation: { ...differing, expectedCounts: [8, 2, 1, 1], expectedMaxCombo: 321 },
      });
      expect(within(screen.getByRole("region", { name: "Judgements" })).queryByText("Saved")).toBeNull();
      expect(screen.queryByRole("note", { name: "Saved score differs" })).toBeNull();
      expect(screen.queryByRole("region", { name: /^Max combo: saved/ })).toBeNull();
    });

    it("is not shown for the other ruleset's reconstruction, which is not a disagreement", () => {
      renderDialog(lazerViewModel(), { replayValidation: differing });
      expect(within(screen.getByRole("region", { name: "Judgements" })).queryByText("Saved")).toBeNull();
      expect(screen.queryByRole("note", { name: "Saved score differs" })).toBeNull();
    });

    it("has the note in the head only while the columns are shown, and a card with the three lines on hover", async () => {
      const { unmount } = renderDialog(stableViewModel(), { replayValidation: differing });
      const judgements = screen.getByRole("region", { name: "Judgements" });
      const note = within(judgements).getByRole("note", { name: "Saved score differs" });
      expect(within(judgements).getByRole("heading", { name: "JUDGEMENTS" }).parentElement?.contains(note)).toBe(true);
      fireEvent.mouseOver(note);
      const tooltip = await screen.findByRole("tooltip");
      expect(Array.from(tooltip.querySelectorAll(".MuiTooltip-tooltip > div > div")).map((line) => line.textContent)).toEqual([
        "Cause not confirmed",
        "Possibly a resume keypress read as an early tap.",
        "Analysis uses Hindsight’s counts.",
      ]);
      unmount();

      renderDialog(stableViewModel(), { replayValidation: { ...differing, expectedCounts: [8, 2, 1, 1], expectedMaxCombo: 321 } });
      expect(screen.queryByRole("note", { name: "Saved score differs" })).toBeNull();
    });
  });
  it("drops the comparison for another ruleset and shows it again on coming back", () => {
    const validation: ReplaySimulationValidation = {
      verified: false,
      expectedCounts: [9, 2, 1, 0],
      simulatedCounts: [8, 2, 1, 1],
      simulatedMaxCombo: 321,
      warnings: [],
    };
    const props = {
      open: true,
      replayValidation: validation,
      canSwitchRuleset: true,
      onSwitchRuleset: jest.fn(),
      onClose: jest.fn(),
    };
    const { rerender } = render(<FullMapAnalysisDialog {...props} viewModel={stableViewModel()} />);
    expect(screen.getByRole("note", { name: "Saved score differs" })).toBeTruthy();
    rerender(<FullMapAnalysisDialog {...props} viewModel={lazerViewModel()} />);
    expect(screen.queryByRole("note", { name: "Saved score differs" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Judgements" })).queryByText("Saved")).toBeNull();
    expect(screen.getByText("Lazer reconstruction")).toBeTruthy();
    rerender(<FullMapAnalysisDialog {...props} viewModel={stableViewModel()} />);
    expect(screen.getByRole("note", { name: "Saved score differs" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Judgements" })).getByText("Saved")).toBeTruthy();
  });
  it("keeps long combo comparison compact: the map's maximum gives way to the saved combo", () => {
    const viewModel = stableViewModel();
    viewModel.summary.maxComboObtained = 12345;
    viewModel.summary.mapMaxCombo = 23456;
    renderDialog(viewModel, {
      replayValidation: {
        verified: false,
        simulatedCounts: [8, 2, 1, 1],
        expectedMaxCombo: 12346,
        simulatedMaxCombo: 12345,
        warnings: [],
      },
    });
    const combo = screen.getByRole("region", { name: "Max combo: saved 12346, Hindsight 12345" });
    expect(combo.textContent).toBe("Saved 12346 · Hindsight 12345");
    // The same size as the plain value it replaces.
    expect(getComputedStyle(combo).fontSize).toBe("28px");
    expect(screen.queryByText("/ 23456")).toBeNull();
    expect(screen.getByText("MAX COMBO").getAttribute("title")).toBe("Map maximum: 23456");
  });
  it("renders official Classic and DA artwork without tooltips and keeps a custom rate label", () => {
    renderDialog({
      ...stableViewModel(),
      mods: buildFullMapReplayMods(
        [],
        [
          { acronym: "CL" },
          { acronym: "DA", settings: { circle_size: 6 } },
          { acronym: "HT", settings: { speed_change: 0.65 } },
        ],
      ),
    });
    const list = screen.getByRole("list", { name: "Replay mods" });
    expect(within(list).getByText("0.65×")).toBeTruthy();
    expect(within(list).getByRole("img", { name: "Classic (CL)" }).getAttribute("src")).toBe(
      FULL_MAP_MOD_ICONS.CLASSIC,
    );
    const da = within(list).getByRole("img", { name: "Difficulty Adjust (DA)" });
    expect(da.getAttribute("src")).toBe(FULL_MAP_MOD_ICONS.DIFFICULTY_ADJUST);
    expect(da.hasAttribute("title")).toBe(false);
  });

  it("keeps the ordered source mods in the header while the graph changes", () => {
    renderDialog({
      ...stableViewModel(),
      context: { artist: "xi", title: "ANiMA", difficulty: "Oberum Primus", player: "WinterBird" },
      mods: buildFullMapReplayMods(["FL", "HR", "DT", "HD"]),
    });
    const list = screen.getByRole("list", { name: "Replay mods" });
    const header = dialogHeader();
    expect(within(header).getByRole("list", { name: "Replay mods" })).toBe(list);
    const result = screen.getByRole("region", { name: "Result" });
    expect(within(result).getByLabelText("Rank C")).toBeTruthy();
    expect(within(result).getByLabelText("Accuracy 73.61%")).toBeTruthy();
    expect(result.querySelector("ul")).toBeNull();
    expectDocumentOrder([
      wholeText(header, "xi - ANiMA [Oberum Primus]"),
      within(header).getByText("WinterBird"),
      list,
    ]);
    const expected = [
      ["HIDDEN", "Hidden (HD)"],
      ["DOUBLE_TIME", "Double Time (DT)"],
      ["HARD_ROCK", "Hard Rock (HR)"],
      ["FLASH_LIGHT", "Flashlight (FL)"],
    ] as const;
    const icons = within(list).getAllByRole("img");
    expect(icons).toHaveLength(4);
    expected.forEach(([mod, name], index) => {
      expect(icons[index].getAttribute("alt")).toBe(name);
      expect(icons[index].getAttribute("src")).toBe(FULL_MAP_MOD_ICONS[mod]);
      expect(icons[index].hasAttribute("title")).toBe(false);
    });
    expect(showHitError()).toBeTruthy();
    expect(
      within(list)
        .getAllByRole("img")
        .map((icon) => icon.getAttribute("alt")),
    ).toEqual(expected.map(([, name]) => name));
    expect(within(rulesetGroup()).getByRole("button", { name: "Lazer" })).toBeTruthy();
  });

  it("shows Nightcore and Perfect only once without implied mod images", () => {
    renderDialog({ ...stableViewModel(), mods: buildFullMapReplayMods(["NC", "DT", "NC", "SD", "PF", "PF"]) });
    const list = screen.getByRole("list", { name: "Replay mods" });
    expect(
      within(list)
        .getAllByRole("img")
        .map((icon) => icon.getAttribute("alt")),
    ).toEqual(["Nightcore (NC)", "Perfect (PF)"]);
    expect(within(list).queryByRole("img", { name: "Double Time (DT)" })).toBeNull();
    expect(within(list).queryByRole("img", { name: "Sudden Death (SD)" })).toBeNull();
  });

  it("does not render an empty or No Mod strip", () => {
    renderDialog({ ...stableViewModel(), mods: buildFullMapReplayMods(["NM", "", "unknown"]) });
    expect(screen.queryByRole("list", { name: "Replay mods" })).toBeNull();
    expect(screen.queryByText(/No Mod/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "Full-map analysis" })).toBeTruthy();
    const result = screen.getByRole("region", { name: "Result" });
    expect(within(result).getByLabelText("Accuracy 73.61%").textContent).toBe("73.61%");
    expect(dialogHeader().querySelector("ul")).toBeNull();
  });

  it("provides eighteen unique, self-contained SVG badges containing the original PNG layers", () => {
    expect(Object.keys(FULL_MAP_MOD_ICONS).sort()).toEqual([...OsuClassicMods, "CLASSIC", "DIFFICULTY_ADJUST"].sort());
    expect(new Set(Object.values(FULL_MAP_MOD_ICONS)).size).toBe(18);
    const backgrounds = new Set<string>();
    const symbols = new Set<string>();
    for (const mod of [...OsuClassicMods, "CLASSIC", "DIFFICULTY_ADJUST"] as const) {
      const source = FULL_MAP_MOD_ICONS[mod];
      expect(source).toMatch(/^data:image\/svg\+xml,/);
      const markup = decodeURIComponent(source.slice("data:image/svg+xml,".length));
      const document = new DOMParser().parseFromString(markup, "image/svg+xml");
      expect(document.querySelector("parsererror")).toBeNull();
      const svg = document.documentElement;
      expect(svg.localName).toBe("svg");
      expect(svg.getAttribute("viewBox")).toBe("0 0 135 100");
      expect(svg.getAttribute("width")).toBe("135");
      expect(svg.getAttribute("height")).toBe("100");
      expect(svg.querySelector("desc")?.textContent).toBe(FULL_MAP_MOD_ICON_ATTRIBUTION);
      const images = Array.from(svg.querySelectorAll("image"));
      expect(images).toHaveLength(2);
      const layerGeometries = images.map((image) =>
        ["x", "y", "width", "height"].map((name) => image.getAttribute(name)),
      );
      expect(layerGeometries).toEqual([
        ["0", "0", "135", "100"],
        ["2", "4", "131", "92"],
      ]);
      expect(images[1].getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
      expect(images.map((image) => image.getAttribute("filter"))).toEqual(["url(#badge-color)", "url(#symbol-dark)"]);

      for (const [index, image] of images.entries()) {
        const href = image.getAttribute("href") ?? "";
        expect(href).toMatch(/^data:image\/png;base64,/);
        const bytes = Buffer.from(href.slice("data:image/png;base64,".length), "base64");
        expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(bytes.toString("ascii", 12, 16)).toBe("IHDR");
        expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual(index === 0 ? [135, 100] : [120, 84]);
        (index === 0 ? backgrounds : symbols).add(href);
      }

      // Metadata may cite HTTPS sources; rendered resources must remain embedded.
      const allowedElements = new Set(["svg", "desc", "defs", "filter", "feColorMatrix", "image"]);
      for (const element of [svg, ...Array.from(svg.querySelectorAll("*"))]) {
        expect(allowedElements.has(element.localName)).toBe(true);
        for (const attribute of Array.from(element.attributes)) {
          expect(attribute.name).not.toMatch(/^on|^style$/i);
          if (attribute.localName === "href") expect(attribute.value).toMatch(/^data:image\/png;base64,/);
          if (attribute.value.includes("url(")) expect(attribute.value).toMatch(/^url\(#[a-z-]+\)$/);
        }
      }
      expect(markup).not.toMatch(/<!DOCTYPE|<!ENTITY/i);
    }
    expect(backgrounds.size).toBe(1);
    expect(symbols.size).toBe(18);
  });

  it("uses the website category colours and linear-light dark symbols while preserving alpha and shadows", () => {
    // Rounded foreground reference colours from osu!web's 10% linear-sRGB mix.
    const categories = [
      [
        ["EASY", "NO_FAIL", "HALF_TIME"],
        [178.5, 255, 102],
        [60, 89, 30],
      ],
      [
        ["HIDDEN", "HARD_ROCK", "DOUBLE_TIME", "NIGHT_CORE", "FLASH_LIGHT", "SUDDEN_DEATH", "PERFECT"],
        [255, 102, 102],
        [89, 30, 30],
      ],
      [
        ["AUTO_PILOT", "AUTO_PLAY", "RELAX", "SPUN_OUT"],
        [102, 204, 255],
        [30, 70, 89],
      ],
      [
        ["CLASSIC", "DIFFICULTY_ADJUST"],
        [140.25, 102, 255],
        [45, 30, 89],
      ],
      [["SCORE_V2"], [255, 204, 34], [89, 70, 5]],
    ] as const;
    for (const [mods, background, foreground] of categories) {
      for (const mod of mods) {
        const source = FULL_MAP_MOD_ICONS[mod];
        const document = new DOMParser().parseFromString(
          decodeURIComponent(source.slice("data:image/svg+xml,".length)),
          "image/svg+xml",
        );
        expect(document.querySelectorAll("filter")).toHaveLength(2);
        for (const [id, color] of [
          ["badge-color", background],
          ["symbol-dark", foreground],
        ] as const) {
          const filter = document.getElementById(id) as Element;
          expect(filter).toBeTruthy();
          expect(filter.getAttribute("color-interpolation-filters")).toBe("sRGB");
          expect(filter.getAttribute("filterUnits")).toBe("userSpaceOnUse");
          expect(["x", "y", "width", "height"].map((name) => filter.getAttribute(name))).toEqual([
            "0",
            "0",
            "135",
            "100",
          ]);
          const matrix = filter.querySelector("feColorMatrix") as Element;
          expect(matrix.getAttribute("type")).toBe("matrix");
          const values = matrix.getAttribute("values")!.trim().split(/\s+/).map(Number);
          expect([values[0], values[6], values[12]].map((value) => Math.round(value * 255))).toEqual(
            color.map(Math.round),
          );
          if (id === "badge-color") {
            [0, 6, 12].forEach((index, channel) => expect(values[index]).toBeCloseTo(color[channel] / 255, 12));
          }
          expect(values.map((value, index) => ([0, 6, 12].includes(index) ? 0 : value))).toEqual([
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0,
          ]);
        }
      }
    }
    expect(FULL_MAP_MOD_ICON_ATTRIBUTION).toContain("ppy Pty Ltd");
    expect(FULL_MAP_MOD_ICON_ATTRIBUTION).toContain("https://github.com/ppy/osu-resources/");
    expect(FULL_MAP_MOD_ICON_ATTRIBUTION).toContain("CC BY-NC 4.0");
    expect(FULL_MAP_MOD_ICON_ATTRIBUTION).toContain("osu!website category colours and layout adapted for Rewind");
  });

  it("keeps Early and Late labels consistent with the plotted timing direction", () => {
    renderDialog(stableViewModel());
    const chart = showHitError();
    const distribution = screen.getByRole("region", { name: /Hit-error distribution, Stable, OD 8/ });
    for (const [name, rgb, fill] of [
      ["Early", "rgb(111, 202, 221)", "#6fcadd"],
      ["Late", "rgb(217, 144, 170)", "#d990aa"],
    ]) {
      expect(window.getComputedStyle(within(distribution).getByText(name)).color).toBe(rgb);
      expect(within(chart).getByText(name).getAttribute("fill")).toBe(fill);
      // The shares sit with the distribution, not in the hit-error chart's head.
      expect(within(distribution).getByText(name).textContent).toContain("50.0%");
    }
    expect(within(overTheMap()).queryByText(/50.0%/)).toBeNull();
    expect(screen.getAllByText(/50.0%/)).toHaveLength(2);
    expect(screen.queryByText(/Hit density/i)).toBeNull();
  });

  it.each(["stable", "lazer"] as const)(
    "keeps %s timing at the first object while the UR series starts at its first valid point",
    (ruleset) => {
      const viewModel = ruleset === "stable" ? stableViewModel() : lazerViewModel();
      const timing = viewModel.summary.timing;
      // The cumulative series is still computed, and no longer read: moving it must change nothing on the page.
      const averageUr = timing.averageUr.map((point) => ({ ...point, time: point.time + 2_000 }));
      renderDialog({
        ...viewModel,
        summary: { ...viewModel.summary, startTime: 1_000, timing: { ...timing, averageUr } },
      });

      const currentChart = screen.getByRole("img", { name: UR_GRAPH });
      expect(within(currentChart).getByText("0:02").getAttribute("x")).toBe("80");
      expect(within(currentChart).queryByText("0:01")).toBeNull();
      expect(within(currentChart).getByTestId("current-ur-line").getAttribute("d")).toMatch(/^M80\.00,/);
      fireEvent.focus(currentChart);
      // The name is the graph's own sentence, and the hit error at that time is added to it.
      expect(
        screen.getByRole("tooltip", {
          name: new RegExp(
            `^Unstable rate ${timing.urOverTime[0].unstableRate.toFixed(1)} over the last ${
              timing.urOverTime[0].sampleCount
            } hits at 0:02, hit error `,
          ),
        }),
      ).toBeTruthy();
      fireEvent.blur(currentChart);

      const timingChart = showHitError();
      const timingPath = within(timingChart).getByTestId("timing-sample-line").getAttribute("d");
      expect(within(timingChart).getByText("0:01").getAttribute("x")).toBe("80");

      fireEvent.click(graphOption("Unstable rate · 50 hits"));
      expect(
        within(screen.getByRole("img", { name: UR_GRAPH }))
          .getByText("0:02")
          .getAttribute("x"),
      ).toBe("80");
      const timingChartAgain = showHitError();
      expect(within(timingChartAgain).getByText("0:01").getAttribute("x")).toBe("80");
      expect(within(timingChartAgain).getByTestId("timing-sample-line").getAttribute("d")).toBe(timingPath);
    },
  );

  it.each<[FullMapGrade, string]>([
    ["SS", "rgb(255, 214, 45)"],
    ["S", "rgb(255, 214, 45)"],
    ["A", "rgb(136, 218, 32)"],
    ["B", "rgb(75, 123, 255)"],
    ["C", "rgb(181, 108, 255)"],
    ["D", "rgb(255, 90, 90)"],
    ["F", "rgb(197, 202, 211)"],
  ])("renders rank %s in the requested palette", (grade, color) => {
    renderDialog({
      ...stableViewModel(grade !== "F"),
      grade,
      rankColor: rankColorForGrade(grade),
    });

    const rank = screen.getByLabelText(grade === "F" ? "Rank F, failed replay" : `Rank ${grade}`);
    expect(window.getComputedStyle(within(rank).getByText(grade)).color).toBe(color);
  });

  it.each<[ReplayAnalysisRuleset, "S" | "SS", string[]]>([
    ["stable", "S", ["HD"]],
    ["stable", "SS", ["FLASH_LIGHT"]],
    ["lazer", "S", ["FL"]],
    ["lazer", "SS", ["HIDDEN", "FL"]],
  ])("renders %s %s in silver for source replay mods %p without relabeling the grade", (ruleset, grade, mods) => {
    const analyzed = analyzeFullMap({
      ruleset,
      events: [],
      hits: [],
      duration: 12_000,
      baseRate: 1,
      aggregateJudgementCountsInput: grade === "SS" ? [100, 0, 0, 0] : [95, 5, 0, 0],
      aggregateAccuracyInput: grade === "SS" ? 1 : 0.95,
      objectCoverage: { totalObjectCount: 100 },
    });
    renderDialog(
      buildFullMapAnalysisViewModel({ summary: analyzed, replay: { passed: true, sourceRuleset: ruleset, mods } }),
    );

    const rank = within(screen.getByRole("region", { name: "Result" })).getByLabelText(`Rank ${grade}`);
    expect(window.getComputedStyle(within(rank).getByText(grade)).color).toBe("rgb(217, 225, 232)");
    expect(screen.getByRole("list", { name: "Replay mods" })).toBeTruthy();
    expect(screen.getByRole("region", { name: `300: ${grade === "SS" ? 100 : 95}` })).toBeTruthy();
    expect(screen.getByRole("region", { name: "MISS: 0" })).toBeTruthy();
    expect(screen.queryByLabelText(`Rank ${grade}H`)).toBeNull();
  });

  it("keeps the headline figures in the result row and lays the panels out as aim, timing and judgements", () => {
    const viewModel = stableViewModel();
    renderDialog(viewModel);
    const dialog = screen.getByRole("dialog", { name: "Full-map analysis" });
    expect(screen.queryByRole("region", { name: "Replay summary" })).toBeNull();
    const graphs = overTheMap();
    const judgements = screen.getByRole("region", { name: "Judgements" });
    const result = screen.getByRole("region", { name: "Result" });
    expect(screen.queryByRole("region", { name: "Accuracy and rank" })).toBeNull();
    expect(within(result).getByLabelText("Accuracy 73.61%").textContent).toBe("73.61%");
    expect(within(result).getByLabelText("Rank C")).toBeTruthy();
    const maxCombo = within(result).getByLabelText("Max combo 321 / 654");
    expect(maxCombo.textContent).toBe("321/ 654");
    expect(within(maxCombo).getByText("/ 654")).toBeTruthy();
    expect(within(result).getByLabelText(/^Overall UR /).textContent).toBe(overallUr(viewModel));
    expect(within(result).getByLabelText(/^Mean offset /).textContent).toBe("-1.0ms early");
    // Each of these moved to the result row: none is left behind in its old panel.
    expect(within(judgements).queryByText(/Max combo/i)).toBeNull();
    expect(within(judgements).queryByText(/73\.61/)).toBeNull();
    expect(within(graphs).queryByText(/Overall UR/i)).toBeNull();
    expect(within(graphs).queryByText(/Mean offset/i)).toBeNull();
    // The judgements are a panel of their own, not part of a side column.
    expect(screen.queryByRole("complementary")).toBeNull();
    const resultRows = [
      "300: 8",
      "100: 2",
      "50: 1",
      "MISS: 1",
      "SLIDER BREAK: 1",
      "SLIDER END: 0",
    ].map((name) => within(judgements).getByRole("region", { name }));
    expectDocumentOrder([maxCombo, ...resultRows]);
    expect(within(judgements).getByText("66.67%")).toBeTruthy();
    expect(within(judgements).getByText("16.67%")).toBeTruthy();
    expect(within(judgements).getAllByText("8.33%")).toHaveLength(2);
    // The notelock count is not printed here (the Error causes panel covers it).
    expect(screen.queryByText(/Notelock:/)).toBeNull();
    expect(within(judgements).queryByText(/Effective miss/)).toBeNull();
    expect(dialog.querySelector('[data-testid="notelock-miss-arrow"]')).toBeNull();
    expect(within(graphs).getByRole("img", { name: UR_GRAPH })).toBeTruthy();
    expect(showHitError()).toBeTruthy();
    expect(within(graphs).queryByText(/Overall UR/i)).toBeNull();
    expect(within(graphs).queryByText(/Mean offset/i)).toBeNull();
    const distribution = screen.getByRole("region", { name: /Hit-error distribution, Stable, OD 8/ });
    // The top band, left to right: aim, timing, judgements, in one row of three columns.
    const aim = screen.getByRole("region", { name: "Aim" });
    expectDocumentOrder([aim, distribution, judgements]);
    expect(aim.parentElement).toBe(judgements.parentElement);
    expect(distribution.parentElement).toBe(judgements.parentElement);
    expect(
      within(distribution).getByRole("img", { name: "Hit-error distribution from 4 successful hits" }),
    ).toBeTruthy();
    expect(
      within(distribution)
        .getAllByTestId("ur-distribution-bin")
        .reduce((total, bin) => total + Number(bin.getAttribute("data-count")), 0),
    ).toBe(4);
    const meh = viewModel.hitWindows.mehMs!;
    const great = viewModel.hitWindows.greatMs!;
    const ok = viewModel.hitWindows.okMs!;
    const widths = within(distribution).getByTestId("ur-timing-bar").children;
    const expectedWidths = [
      (meh - ok) / 2 / meh,
      (ok - great) / 2 / meh,
      great / meh,
      (ok - great) / 2 / meh,
      (meh - ok) / 2 / meh,
    ];
    expectedWidths.forEach((width, index) =>
      expect(Number.parseFloat(window.getComputedStyle(widths[index]).flexBasis)).toBeCloseTo(width * 100),
    );
    const zero = within(distribution).getByTestId("ur-zero-offset-marker");
    const mean = within(distribution).getByTestId("ur-average-offset-marker");
    expect(window.getComputedStyle(zero).left).toBe("50%");
    expect(window.getComputedStyle(mean).left).not.toBe(window.getComputedStyle(zero).left);
    expect(within(distribution).getByText("Mean -1.0 ms")).toBeTruthy();
  });

  it("shows the result row in order, each value over its label", () => {
    const viewModel = stableViewModel();
    renderDialog(viewModel, { performance: readyPerformance });
    const result = screen.getByRole("region", { name: "Result" });
    const values = [
      "Rank C",
      "Accuracy 73.61%",
      "Replay PP 234.57",
      "Full-map SR 7.19 stars",
      "Max combo 321 / 654",
      `Overall UR ${overallUr(viewModel)}`,
      "Mean offset -1.0 ms early",
    ].map((name) => within(result).getByLabelText(name));
    expectDocumentOrder(values);
    const labels = ["RANK", "ACCURACY", "PERFORMANCE", "STAR RATING", "MAX COMBO", "UR", "MEAN OFFSET"].map((label) =>
      within(result).getByText(label),
    );
    expectDocumentOrder(labels);
    // A value comes before its own label and after the label of the one before it.
    expectDocumentOrder(values.flatMap((value, index) => [value, labels[index]]));
    // Nothing of the row is shown a second time elsewhere on the page.
    for (const name of [
      /^Rank /,
      /^Accuracy /,
      /^Replay PP /,
      /^Max combo/,
      /^Overall UR /,
      /^Mean offset /,
      /^Full-map SR /,
    ]) {
      expect(screen.getAllByLabelText(name)).toHaveLength(1);
    }
    expect(window.getComputedStyle(within(result).getByLabelText("Full-map SR 7.19 stars")).color).toBe(
      "rgb(245, 210, 122)",
    );
    // The star rating sits beside Performance with the row's own gap: nothing pushes it to the far right.
    expect(result.children).toHaveLength(7);
    for (const child of Array.from(result.children)) {
      expect(window.getComputedStyle(child).marginLeft).not.toBe("auto");
      expect(window.getComputedStyle(child).flexGrow).not.toBe("1");
    }
    expect(result.children[3].contains(within(result).getByLabelText("Full-map SR 7.19 stars"))).toBe(true);
    expect(window.getComputedStyle(result).getPropertyValue("gap")).toBe("52px");
  });

  it("names the side of the mean offset as its unit, and none at zero or without samples", () => {
    const baseViewModel = stableViewModel();
    const withMeanOffset = (meanOffsetMs: number | null): FullMapAnalysisViewModel => ({
      ...baseViewModel,
      summary: { ...baseViewModel.summary, timing: { ...baseViewModel.summary.timing, meanOffsetMs } },
    });
    const meanOffset = () => within(screen.getByRole("region", { name: "Result" })).getByLabelText(/^Mean offset /);
    const props = { open: true, canSwitchRuleset: true, onSwitchRuleset: jest.fn(), onClose: jest.fn() };
    const { rerender } = render(<FullMapAnalysisDialog {...props} viewModel={withMeanOffset(9.52)} />);
    expect(meanOffset().textContent).toBe("+9.5ms late");
    expect(meanOffset().getAttribute("aria-label")).toBe("Mean offset +9.5 ms late");
    rerender(<FullMapAnalysisDialog {...props} viewModel={withMeanOffset(-12.34)} />);
    expect(meanOffset().textContent).toBe("-12.3ms early");
    rerender(<FullMapAnalysisDialog {...props} viewModel={withMeanOffset(0)} />);
    expect(meanOffset().textContent).toBe("0.0ms");
    // A mean that rounds to zero is on neither side.
    rerender(<FullMapAnalysisDialog {...props} viewModel={withMeanOffset(-0.04)} />);
    expect(meanOffset().textContent).toBe("0.0ms");
    rerender(<FullMapAnalysisDialog {...props} viewModel={withMeanOffset(null)} />);
    expect(meanOffset().textContent).toBe("—");
    expect(meanOffset().getAttribute("aria-label")).toBe("Mean offset —");
  });

  it("lists the map's facts in the footer, the timed hits last and the star rating gone", () => {
    renderDialog(stableViewModel(), { performance: readyPerformance });
    const footer = dialogFooter();
    expect(Array.from(footer.querySelectorAll(":scope > span")).map((fact) => fact.textContent)).toEqual([
      "Length 0:12.000",
      "Circles 7",
      "Sliders 4",
      "BPM 120",
      "CS 4",
      "AR 9",
      "OD 8",
      "HP 5",
      "4 timed hits",
    ]);
    expect(footer.textContent).not.toMatch(/:\s|Map length/);
    expect(within(footer).queryByLabelText(/Full-map SR/)).toBeNull();
    expect(within(footer).queryByRole("region", { name: "Map difficulty" })).toBeNull();
  });

  it("leaves the timed hits out of the footer when timing is unavailable", () => {
    renderDialog(missingTimingViewModel());
    const footer = dialogFooter();
    expect(footer.textContent).not.toMatch(/timed hit/);
    expect(within(footer).getByText("Length")).toBeTruthy();
  });

  it("keeps a long header on one line", () => {
    const context = {
      artist: "A very long artist name ".repeat(6).trim(),
      title: "A very long song title ".repeat(8).trim(),
      difficulty: "A very long difficulty name ".repeat(4).trim(),
      player: "WinterBird",
    };
    renderDialog({
      ...stableViewModel(),
      context,
      mods: buildFullMapReplayMods(
        [],
        [
          { acronym: "HD" },
          { acronym: "HR" },
          { acronym: "HT", settings: { speed_change: 0.65 } },
          { acronym: "FL" },
          { acronym: "CL" },
          { acronym: "DA", settings: { circle_size: 6 } },
        ],
      ),
    });
    const header = dialogHeader();
    expect(window.getComputedStyle(header).display).toBe("flex");
    expect(window.getComputedStyle(header).flexWrap).not.toBe("wrap");
    // The name is what gives way: it may shrink to nothing and ends in an ellipsis.
    const map = wholeText(header, `${context.artist} - ${context.title} [${context.difficulty}]`);
    const mapStyle = window.getComputedStyle(map);
    expect(mapStyle.whiteSpace).toBe("nowrap");
    expect(mapStyle.textOverflow).toBe("ellipsis");
    expect(mapStyle.overflow).toBe("hidden");
    expect(Number.parseFloat(mapStyle.minWidth)).toBe(0);
    expect(map.getAttribute("title")).toBe(map.textContent);
    // The mods, the switch and the close control keep their width and stay on the line.
    const mods = within(header).getByRole("list", { name: "Replay mods" });
    expect(within(mods).getAllByRole("img")).toHaveLength(6);
    expect(within(mods).getByText("0.65×")).toBeTruthy();
    expect(window.getComputedStyle(mods).flexWrap).not.toBe("wrap");
    const close = within(header).getByRole("button", { name: "Close full-map analysis" });
    for (const fixed of [mods, rulesetGroup(), close]) {
      expect(window.getComputedStyle(fixed).flexShrink).toBe("0");
    }
    expectDocumentOrder([map, within(header).getByText("WinterBird"), mods, rulesetGroup(), close]);
  });

  it("lists the six judgement rows in order, each name in its colour, over hairlines", () => {
    renderDialog(stableViewModel(), { performance: { ...readyPerformance, effectiveMissCount: 2.375 } });
    const judgements = screen.getByRole("region", { name: "Judgements" });
    const heading = within(judgements).getByRole("heading", { name: "JUDGEMENTS" });
    expect(window.getComputedStyle(heading).fontFamily).toContain("Geist Mono");
    expect(window.getComputedStyle(heading).fontSize).toBe("11px");
    const rows = ["300: 8", "100: 2", "50: 1", "MISS: 1", "SLIDER BREAK: 1", "SLIDER END: 0"].map((name) =>
      within(judgements).getByRole("region", { name }),
    );
    expectDocumentOrder([heading, ...rows]);
    // One list: every row is a child of the same box, so a row can be added between two others.
    expect(new Set(rows.map((row) => row.parentElement)).size).toBe(1);
    // The effective miss is a tooltip of the Miss row, not a row.
    expect(within(judgements).queryByRole("region", { name: /^Effective miss/ })).toBeNull();
    expect(within(judgements).queryByText("Effective miss")).toBeNull();
    const labels = rows.map((row) => within(row).getByTestId("result-row-label"));
    expect(labels.map((label) => label.textContent)).toEqual(["300", "100", "50", "Miss", "SliderBreak", "SliderEnd"]);
    expect(labels.map((label) => window.getComputedStyle(label).color)).toEqual([
      "rgb(124, 196, 245)",
      "rgb(143, 232, 175)",
      "rgb(245, 205, 110)",
      "rgb(255, 112, 130)",
      "rgb(199, 179, 255)",
      "rgb(181, 176, 214)",
    ]);
    // The four judgements are named at 15px, the slider rows at 14px.
    expect(labels.map((label) => window.getComputedStyle(label).fontSize)).toEqual([
      "15px",
      "15px",
      "15px",
      "15px",
      "14px",
      "14px",
    ]);
    for (const [index, row] of rows.entries()) {
      expect(window.getComputedStyle(labels[index]).fontWeight).toBe("600");
      const count = window.getComputedStyle(within(row).getByTestId("result-row-count"));
      expect([count.fontSize, count.fontWeight, count.fontVariantNumeric]).toEqual(["17px", "500", "tabular-nums"]);
      expect(count.fontFamily).not.toContain("Mono");
    }
    // The four judgements have a share in a 76px column; the slider rows have a count and none.
    expect(rows.map((row) => within(row).queryByTestId("result-row-percentage")?.textContent ?? null)).toEqual([
      "66.67%",
      "16.67%",
      "8.33%",
      "8.33%",
      null,
      null,
    ]);
    const share = window.getComputedStyle(within(rows[0]).getByTestId("result-row-percentage"));
    expect([share.fontSize, share.color]).toEqual(["13px", "rgb(168, 165, 158)"]);
    expect(window.getComputedStyle(labels[0].parentElement?.parentElement as HTMLElement).gridTemplateColumns).toMatch(
      / 76px$/,
    );
    // A hairline under every row but the last.
    expect(rows.map((row) => /^inset 0 -1px 0 /.test(window.getComputedStyle(row).boxShadow))).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  describe("judgement rows share the panel's height", () => {
    const rowNames = ["300: 8", "100: 2", "50: 1", "MISS: 1", "SLIDER BREAK: 1", "SLIDER END: 0"];
    const judgementRows = () => {
      const judgements = screen.getByRole("region", { name: "Judgements" });
      return rowNames.map((name) => within(judgements).getByRole("region", { name }));
    };
    const renderRows = () =>
      renderDialog(stableViewModel(), { performance: { ...readyPerformance, effectiveMissCount: 2.375 } });
    const comparable: ReplaySimulationValidation = {
      verified: false,
      expectedCounts: [9, 2, 1, 0],
      simulatedCounts: [8, 2, 1, 1],
      expectedMaxCombo: 400,
      simulatedMaxCombo: 321,
      warnings: [],
    };

    it("makes every row an equal flex child of one scrolling column, 26 to 56px tall, with no padding of its own", () => {
      renderRows();
      const rows = judgementRows();
      const column = rows[0].parentElement as HTMLElement;
      const columnStyle = window.getComputedStyle(column);
      expect([columnStyle.display, columnStyle.flexDirection, columnStyle.overflowY]).toEqual(["flex", "column", "auto"]);
      expect(columnStyle.minHeight).toMatch(/^0(px)?$/);
      // The column is what takes the panel's room, so the rows have it to share.
      expect(column.parentElement).toBe(screen.getByRole("region", { name: "Judgements" }));
      for (const row of rows) {
        const style = window.getComputedStyle(row);
        expect([style.flexGrow, style.flexShrink]).toEqual(["1", "1"]);
        expect(Number.parseFloat(style.flexBasis)).toBe(0);
        expect([style.minHeight, style.maxHeight]).toEqual(["26px", "56px"]);
        expect([style.display, style.alignItems]).toEqual(["flex", "center"]);
        // No padding of its own: its height comes from its share of the panel, not from its content.
        expect(style.paddingTop).toMatch(/^(0(px)?)?$/);
        expect(style.paddingBottom).toMatch(/^(0(px)?)?$/);
      }
    });

    it("keeps the hairline between rows, none under the last", () => {
      renderRows();
      expect(judgementRows().map((row) => window.getComputedStyle(row).boxShadow.startsWith("inset 0 -1px 0 "))).toEqual([
        true,
        true,
        true,
        true,
        true,
        false,
      ]);
    });

    it("gives the share bar 14px under the label and 12px above the first row, and keeps it 6px high", () => {
      renderRows();
      const judgements = screen.getByRole("region", { name: "Judgements" });
      const bar = within(judgements).getByTestId("judgement-share");
      const style = window.getComputedStyle(bar);
      const column = judgementRows()[0].parentElement as HTMLElement;
      // The panel's own 10px between its head and body, and 4px more at the top of the body.
      expect(window.getComputedStyle(judgements).getPropertyValue("gap")).toBe("10px");
      expect(window.getComputedStyle(column).paddingTop).toBe("4px");
      expect([style.marginBottom, style.height]).toEqual(["12px", "6px"]);
      expect(style.marginTop).toMatch(/^(0(px)?)?$/);
      expect(bar.parentElement).toBe(column);
      expect(bar.previousElementSibling).toBeNull();
      expect(bar.nextElementSibling).toBe(judgementRows()[0]);
    });

    it("starts the first row 14px under the head also when the share bar is hidden", () => {
      const viewModel = stableViewModel();
      renderDialog(
        { ...viewModel, resultPercentages: { ...viewModel.resultPercentages, count50: null } },
        { performance: { ...readyPerformance, effectiveMissCount: 2.375 } },
      );
      expect(screen.queryByTestId("judgement-share")).toBeNull();
      const first = judgementRows()[0];
      const column = first.parentElement as HTMLElement;
      expect(column.firstElementChild).toBe(first);
      expect(window.getComputedStyle(column).paddingTop).toBe("4px");
      expect(window.getComputedStyle(screen.getByRole("region", { name: "Judgements" })).getPropertyValue("gap")).toBe("10px");
    });

    it("starts the compare header 14px under the head when the share bar is hidden", () => {
      const viewModel = stableViewModel();
      renderDialog(
        { ...viewModel, resultPercentages: { ...viewModel.resultPercentages, count50: null } },
        { replayValidation: comparable },
      );
      const header = within(screen.getByRole("region", { name: "Judgements" })).getByText("Saved").parentElement as HTMLElement;
      expect(screen.queryByTestId("judgement-share")).toBeNull();
      expect((header.parentElement as HTMLElement).firstElementChild).toBe(header);
      expect(window.getComputedStyle(header.parentElement as HTMLElement).paddingTop).toBe("4px");
    });

    it("keeps the compare header 12px under the bar, with no padding of its own above", () => {
      renderDialog(stableViewModel(), { replayValidation: comparable });
      const judgements = screen.getByRole("region", { name: "Judgements" });
      const header = within(judgements).getByText("Saved").parentElement as HTMLElement;
      expect(header.previousElementSibling).toBe(within(judgements).getByTestId("judgement-share"));
      expect(window.getComputedStyle(header).paddingTop).toMatch(/^(0(px)?)?$/);
      // It does not take a share of the height: only the rows do.
      expect(window.getComputedStyle(header).flexShrink).toBe("0");
    });

    it("does not print the notelock count on the Miss row, whatever it is", () => {
      for (const notelockMissCount of [0, 3, 9_876]) {
        const viewModel = stableViewModel();
        viewModel.summary.errors.notelockMissCount = notelockMissCount;
        const { unmount } = renderDialog(viewModel, { performance: { ...readyPerformance, effectiveMissCount: 2.375 } });
        const miss = screen.getByRole("region", { name: "MISS: 1" });
        expect(screen.queryByText(/Notelock/)).toBeNull();
        expect(screen.queryByTestId("result-row-detail")).toBeNull();
        expect(miss.querySelector("[title]")).toBeNull();
        // The Miss row is the name, the count and the share, in that order.
        const line = within(miss).getByTestId("result-row-label").parentElement as HTMLElement;
        const grid = line.parentElement as HTMLElement;
        expect(Array.from(line.children)).toEqual([within(miss).getByTestId("result-row-label")]);
        expect(Array.from(grid.children)).toEqual([
          line,
          within(miss).getByTestId("result-row-count"),
          within(miss).getByTestId("result-row-percentage"),
        ]);
        unmount();
      }
    });

    it("keeps the Miss row's four cells in the comparison too", () => {
      renderDialog(stableViewModel(), { replayValidation: comparable });
      const miss = screen.getByRole("region", { name: "MISS: saved 0, Hindsight 1" });
      const line = within(miss).getByTestId("result-row-label").parentElement as HTMLElement;
      const grid = line.parentElement as HTMLElement;
      // Name line, Saved, Rewind, Share.
      expect(grid.children).toHaveLength(4);
      expect(grid.children[0]).toBe(line);
      expect(screen.queryByTestId("result-row-detail")).toBeNull();
    });
  });

  describe("effective miss", () => {
    const missRow = (name = "MISS: 1") => screen.getByRole("region", { name });
    const withCount = (effectiveMissCount: number | undefined): FullMapPerformance => ({
      ...readyPerformance,
      effectiveMissCount,
    });
    /** Lets MUI's enter delay pass, to show that no tooltip came. */
    const letTooltipDelayPass = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
      });

    it("is not a row of the list", () => {
      renderDialog(stableViewModel(), { performance: withCount(2.375) });
      expect(screen.queryByRole("region", { name: /^Effective miss/ })).toBeNull();
      expect(screen.queryByText("Effective miss")).toBeNull();
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("is shown by the Miss row on hover as the shared hover card: one row, the name and the value", async () => {
      renderDialog(stableViewModel(), { performance: withCount(2.375) });
      const row = missRow();
      expect(row.getAttribute("tabindex")).toBe("0");
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.mouseOver(row);
      const tooltip = await screen.findByRole("tooltip");
      // One row and no sentence: not "Misses", not an explanation, no bar.
      expect(tooltip.textContent).toBe("Effective miss2.38");
      expect(within(tooltip).queryByTestId("hover-card-bar")).toBeNull();
      const card = tooltip.querySelector(".MuiTooltip-tooltip") as HTMLElement;
      // The same near-black card with 2px corners the PP's and the SR's tooltips are.
      expect(getComputedStyle(card).backgroundColor).toBe("rgb(15, 16, 19)");
      expect(getComputedStyle(card).borderRadius).toBe("2px");
      const [name, value] = [screen.getByText("Effective miss"), screen.getByText("2.38")];
      expect(name.parentElement).toBe(value.parentElement);
      expect(getComputedStyle(name).color).toBe("rgb(226, 223, 217)");
      expect(getComputedStyle(value).fontWeight).toBe("600");
      expect(getComputedStyle(value).color).toBe("rgb(255, 255, 255)");
      fireEvent.mouseLeave(row);
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    });

    describe("where the card points", () => {
      const comparable: ReplaySimulationValidation = {
        verified: false,
        expectedCounts: [9, 2, 1, 0],
        simulatedCounts: [8, 2, 1, 1],
        expectedMaxCombo: 400,
        simulatedMaxCombo: 321,
        warnings: [],
      };
      const box = (left: number, top: number, width: number, height: number) =>
        ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
      const lay = (element: Element, rect: DOMRect) => void (element.getBoundingClientRect = () => rect);
      const sizes = ["clientWidth", "clientHeight"] as const;
      beforeEach(() => {
        // jsdom has no layout: the page is 1280 x 800, so Popper has a window to keep the card in.
        for (const [name, value] of [["clientWidth", 1280], ["clientHeight", 800]] as const) {
          Object.defineProperty(document.documentElement, name, { configurable: true, value });
        }
      });
      afterEach(() => {
        for (const name of sizes) delete (document.documentElement as unknown as Record<string, unknown>)[name];
      });
      /** Where Popper put the card: the translate of its popper element. */
      const placement = (tooltip: HTMLElement) => {
        const [, x, y] = /translate3?d?\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(tooltip.style.transform) ?? [];
        return { x: Number(x), y: Number(y), side: tooltip.getAttribute("data-popper-placement") };
      };

      it.each([
        ["normal", false, "MISS: 1"],
        ["compare", true, "MISS: saved 0, Hindsight 1"],
      ])("%s mode: the card is centred under the Rewind count, not under the row", async (_mode, compare, name) => {
        renderDialog(stableViewModel(), {
          performance: withCount(2.375),
          ...(compare ? { replayValidation: comparable } : {}),
        });
        const row = missRow(name);
        const count = within(row).getByTestId("result-row-count");
        // The row is wide and its middle is empty; the count is at its right, the saved count just before it.
        lay(row, box(40, 300, 400, 40));
        lay(count, box(300, 308, 40, 24));
        if (compare) lay(count.previousElementSibling as Element, box(240, 308, 40, 24));
        fireEvent.mouseOver(row);
        const tooltip = await screen.findByRole("tooltip");
        // Centre of the count (x 320), directly below it (y 332) — the row's centre would be 240 and its bottom 340.
        expect(placement(tooltip)).toEqual({ x: 320, y: 332, side: "bottom" });
      });

      it("opens the same on focus", async () => {
        renderDialog(stableViewModel(), { performance: withCount(2.375) });
        const row = missRow();
        lay(row, box(40, 300, 400, 40));
        lay(within(row).getByTestId("result-row-count"), box(300, 308, 40, 24));
        fireEvent.keyDown(document.body, { key: "Tab" });
        act(() => row.focus());
        expect(placement(await screen.findByRole("tooltip"))).toEqual({ x: 320, y: 332, side: "bottom" });
      });
    });

    it("is shown on keyboard focus, and the row keeps its name and a focus ring", async () => {
      renderDialog(stableViewModel(), { performance: withCount(2.375) });
      const row = missRow();
      // Keyboard focus, as a Tab key press gives it.
      fireEvent.keyDown(document.body, { key: "Tab" });
      act(() => row.focus());
      expect((await screen.findByRole("tooltip")).textContent).toBe("Effective miss2.38");
      expect(row.getAttribute("aria-label")).toBe("MISS: 1");
      expect(document.activeElement).toBe(row);
      const classes = Array.from(row.classList).filter((name) => name.startsWith("css-"));
      const ring = Array.from(document.styleSheets)
        .flatMap((sheet) => Array.from(sheet.cssRules))
        .map((rule) => rule.cssText)
        .filter((text) => text.includes(":focus-visible") && classes.some((name) => text.includes("." + name)));
      expect(ring.join("")).toMatch(/outline/);
    });

    it.each([
      [0, "0"],
      [2, "2"],
      [2.5, "2.5"],
    ])("writes %s as %s", async (count, text) => {
      renderDialog(stableViewModel(), { performance: withCount(count) });
      fireEvent.mouseOver(missRow());
      expect((await screen.findByRole("tooltip")).textContent).toBe(`Effective miss${text}`);
    });

    it.each([
      ["no performance is given", undefined],
      ["the PP is loading", { status: "loading", description: "Calculating replay performance…" } as const],
      ["the PP is unavailable", { status: "unavailable", description: "Unsupported mod" } as const],
      ["the engine sent no count", withCount(undefined)],
      ["the count is negative", withCount(-1)],
      ["the count is not finite", withCount(Number.NaN)],
      // A count with the PP not ready is not shown either.
      ["the PP is loading and a count is present", { ...withCount(2), status: "loading" } as const],
    ])("leaves the Miss row plain while %s", async (_name, performance) => {
      renderDialog(stableViewModel(), { performance });
      const row = missRow();
      expect(row.hasAttribute("tabindex")).toBe(false);
      fireEvent.mouseOver(row);
      await letTooltipDelayPass();
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(screen.queryByText("Effective miss")).toBeNull();
    });

    it("leaves the Miss row plain when there are no misses", async () => {
      const viewModel = stableViewModel();
      viewModel.summary.judgements.countMiss = 0;
      renderDialog(viewModel, { performance: withCount(2.375) });
      const row = missRow("MISS: 0");
      expect(row.hasAttribute("tabindex")).toBe(false);
      fireEvent.mouseOver(row);
      await letTooltipDelayPass();
      expect(screen.queryByRole("tooltip")).toBeNull();
    });

    it("makes no other row a tab stop", () => {
      renderDialog(stableViewModel(), { performance: withCount(2.375) });
      const judgements = screen.getByRole("region", { name: "Judgements" });
      const column = within(judgements).getByTestId("judgement-share").parentElement;
      const rows = Array.from(column?.children ?? []).filter((child) => child.tagName === "SECTION");
      expect(rows).toHaveLength(6);
      expect(rows.filter((row) => row.hasAttribute("tabindex")).map((row) => row.getAttribute("aria-label"))).toEqual([
        "MISS: 1",
      ]);
    });

    it("applies the same rule to the Miss row in the comparison", async () => {
      const comparable: ReplaySimulationValidation = {
        verified: false,
        expectedCounts: [9, 2, 1, 0],
        simulatedCounts: [8, 2, 1, 1],
        expectedMaxCombo: 400,
        simulatedMaxCombo: 321,
        warnings: [],
      };
      const { unmount } = renderDialog(stableViewModel(), {
        performance: withCount(2.375),
        replayValidation: comparable,
      });
      const row = missRow("MISS: saved 0, Hindsight 1");
      expect(row.getAttribute("tabindex")).toBe("0");
      fireEvent.mouseOver(row);
      expect((await screen.findByRole("tooltip")).textContent).toBe("Effective miss2.38");
      unmount();

      renderDialog(stableViewModel(), { replayValidation: comparable });
      expect(missRow("MISS: saved 0, Hindsight 1").hasAttribute("tabindex")).toBe(false);
    });
  });

  it("draws the share bar from the four shares and hides it when a share is unknown", () => {
    const viewModel = stableViewModel();
    const { rerender, onSwitchRuleset, onClose } = renderDialog(viewModel);
    const judgements = screen.getByRole("region", { name: "Judgements" });
    const bar = within(judgements).getByTestId("judgement-share");
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    expect(window.getComputedStyle(bar).height).toBe("6px");
    expect(window.getComputedStyle(bar).borderRadius).toBe("3px");
    expect(bar.children).toHaveLength(4);
    const shares = [8, 2, 1, 1].map((count) => (count / 12) * 100);
    Array.from(bar.children).forEach((segment, index) => {
      expect(Number.parseFloat(window.getComputedStyle(segment).flexBasis)).toBeCloseTo(shares[index], 5);
    });
    expect(Array.from(bar.children).map((segment) => window.getComputedStyle(segment).backgroundColor)).toEqual([
      "rgb(124, 196, 245)",
      "rgb(143, 232, 175)",
      "rgb(245, 205, 110)",
      "rgb(255, 112, 130)",
    ]);
    expectDocumentOrder([
      within(judgements).getByRole("heading", { name: "JUDGEMENTS" }),
      bar,
      within(judgements).getByRole("region", { name: "300: 8" }),
    ]);

    rerender(
      <FullMapAnalysisDialog
        open
        viewModel={{ ...viewModel, resultPercentages: { ...viewModel.resultPercentages, count50: null } }}
        canSwitchRuleset
        onSwitchRuleset={onSwitchRuleset}
        onClose={onClose}
      />,
    );
    expect(screen.queryByTestId("judgement-share")).toBeNull();
    // The rows stay, the unknown share as a dash and never as 0%.
    expect(
      ["300: 8", "100: 2", "50: 1", "MISS: 1"].map(
        (name) => within(screen.getByRole("region", { name })).getByTestId("result-row-percentage").textContent,
      ),
    ).toEqual(["66.67%", "16.67%", "—", "8.33%"]);
  });

  it("keeps the saved-score note in the panel's head as quiet text, not a button", () => {
    renderDialog(stableViewModel(), {
      replayValidation: {
        verified: false,
        expectedCounts: [9, 2, 1, 0],
        simulatedCounts: [8, 2, 1, 1],
        expectedMaxCombo: 400,
        simulatedMaxCombo: 321,
        warnings: [],
      },
    });
    const judgements = screen.getByRole("region", { name: "Judgements" });
    const heading = within(judgements).getByRole("heading", { name: "JUDGEMENTS" });
    const note = within(judgements).getByRole("note", { name: "Saved score differs" });
    expect(heading.parentElement?.contains(note)).toBe(true);
    expectDocumentOrder([heading, note, within(judgements).getByRole("region", { name: "300: saved 9, Hindsight 8" })]);
    // Words, not an icon or a box.
    expect(note.textContent).toBe("Saved score differs");
    expect(note.querySelector("svg")).toBeNull();
    expect(window.getComputedStyle(note).fontSize).toBe("12px");
    expect(window.getComputedStyle(note).fontWeight).toBe("500");
    expect(window.getComputedStyle(note).color).toBe("rgb(201, 198, 192)");
    expect(within(judgements).queryByRole("button")).toBeNull();
  });

  it("stacks and scrolls in a small window", () => {
    const viewModel = stableViewModel();
    viewModel.aim = {
      available: true,
      points: [{ time: 1_000, x: 0.1, y: 0.1, verdict: "GREAT" }],
      mean: { x: 0.1, y: 0.1 },
      omittedCount: 0,
      omittedMissCount: 0,
      misses: [],
    };
    renderDialog(viewModel);
    const paper = screen.getByRole("dialog", { name: "Full-map analysis" });
    // A window of the usual size is one fixed page: the page itself never scrolls.
    expect(window.getComputedStyle(paper).overflow).toBe("hidden");
    expect(window.getComputedStyle(paper).gridTemplateRows).toBe("auto auto minmax(0, 1fr) auto");
    const paperRules = smallWindowRules(paper);
    const resultRules = smallWindowRules(screen.getByRole("region", { name: "Result" }));
    const judgements = screen.getByRole("region", { name: "Judgements" });
    const band = judgements.parentElement as HTMLElement;
    expect(band.contains(screen.getByRole("region", { name: /Hit-error distribution, Stable/ }))).toBe(true);
    const bandRules = smallWindowRules(band);
    // Stacked, the judgements are as tall as their rows and never scroll inside the scrolling page.
    for (const rules of smallWindowRules(judgements)) expect(rules).toMatch(/min-height: 260px/);
    const rowsBox = within(judgements).getByRole("region", { name: "300: 8" }).parentElement as HTMLElement;
    for (const rules of smallWindowRules(rowsBox)) expect(rules).toMatch(/overflow-y: visible/);
    // The page's main area is two rows, the band above and the graph below; the band's panels fill its height.
    const main = band.parentElement as HTMLElement;
    expect(window.getComputedStyle(main).gridTemplateRows).toBe("minmax(200px, 52%) minmax(0, 1fr)");
    expect(window.getComputedStyle(main).getPropertyValue("gap")).toBe("20px");
    // The graph's band is the second row itself: its head, then the graph in all the room left. Nothing in between
    // scrolls on its own.
    const graphs = overTheMap();
    expect(main.children).toHaveLength(2);
    expect(main.children[0]).toBe(band);
    expect(main.children[1]).toBe(graphs);
    expect(window.getComputedStyle(graphs).gridTemplateRows).toBe("auto minmax(0, 1fr)");
    expect(["", "visible"]).toContain(window.getComputedStyle(graphs).overflowY);
    const graphBox = within(graphs).getByRole("img", { name: UR_GRAPH }).parentElement as HTMLElement;
    expect(graphBox.parentElement).toBe(graphs);
    expect(window.getComputedStyle(graphBox).position).toBe("relative");
    expect(window.getComputedStyle(graphBox).minHeight).toMatch(/^0(px)?$/);
    // Stacked, a row is as tall as what is in it, so the graph has a height of its own.
    for (const rules of smallWindowRules(graphs)) expect(rules).toMatch(/min-height: 300px/);
    // Aim, Timing, Judgements and Error causes: the aim square's width, Timing's share, Judgements at a fixed 340px
    // and Error causes with the rest.
    expect(window.getComputedStyle(band).gridTemplateColumns).toBe(
      "auto minmax(0, 1fr) 340px minmax(240px, 0.62fr)",
    );
    expect(window.getComputedStyle(band).getPropertyValue("gap")).toBe("36px");
    // A narrower window makes Judgements 300px and the gap 24px.
    const narrow = mediaRules(band, "@media (max-width: 1180px)");
    expect(narrow).toMatch(/gap: 24px/);
    expect(narrow).toMatch(/grid-template-columns: auto minmax\(0, 1fr\) 300px minmax\(0, 0\.6fr\)/);
    // The aim panel sizes its square from the band's height (`100cqh`), so the band is a size container.
    expect(window.getComputedStyle(band).getPropertyValue("container-type")).toBe("size");
    expect(["", "normal", "stretch"]).toContain(window.getComputedStyle(band).alignItems);
    const mainRules = smallWindowRules(main);
    // Stacked, the aim square has a size of its own.
    const aimPlot = within(screen.getByRole("region", { name: "Aim" })).getByTestId("aim-plot");
    for (const rules of smallWindowRules(aimPlot)) expect(rules).toMatch(/width: 280px/);
    // Under 1100 px wide, and under 700 px high: the same rules in both.
    for (const index of [0, 1]) {
      expect(paperRules[index]).toMatch(/overflow-y: auto/);
      // The panels' row is never shorter than its content, so the footer cannot land on top of it.
      expect(paperRules[index]).toMatch(/grid-template-rows: auto auto minmax\(min-content, 1fr\) auto/);
      expect(resultRules[index]).toMatch(/flex-wrap: wrap/);
      expect(resultRules[index]).toMatch(/row-gap: 20px/);
      expect(bandRules[index]).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
      // Stacked, the band has no height of its own to measure, so it stops being a size container.
      expect(bandRules[index]).toMatch(/container-type: normal/);
      expect(mainRules[index]).toMatch(/grid-template-rows: auto auto/);
    }
    // Under 1181 px wide the mock tightens the result row before it wraps: a narrower gap, and the figures a step down.
    const result = screen.getByRole("region", { name: "Result" });
    expect(mediaRules(result, "@media (max-width: 1180px)")).toMatch(/gap: 32px/);
    expect(mediaRules(within(result).getByLabelText(/^Accuracy/), "@media (max-width: 1180px)")).toMatch(
      /font-size: 34px/,
    );
    expect(mediaRules(within(result).getByLabelText(/^Overall UR/), "@media (max-width: 1180px)")).toMatch(
      /font-size: 24px/,
    );
  });

  it("puts the four panel labels on one line: the same head, the same label height", () => {
    renderDialog(stableViewModel(), {
      errorCauses: {
        status: "ready",
        total: 6,
        families: { aim: { total: 3, miss: 2, slider: 1 }, tapping: { total: 2, miss: 2, slider: 0 }, notelock: { total: 0, miss: 0, slider: 0 } },
        breakdown: { aim: [], tapping: [], notelock: [] },
        none: { total: 1, miss: 1, slider: 0 },
      },
    });
    const labels = [
      within(screen.getByRole("region", { name: "Aim" })).getByRole("heading", { name: "AIM" }),
      within(screen.getByRole("region", { name: /Hit-error distribution, Stable/ })).getByRole("heading", { name: "TIMING" }),
      within(screen.getByRole("region", { name: "Judgements" })).getByRole("heading", { name: "JUDGEMENTS" }),
      within(screen.getByRole("region", { name: "Error causes" })).getByRole("heading", { name: "ERROR CAUSES" }),
    ];
    const headStyle = (label: HTMLElement) => {
      const style = window.getComputedStyle(label.parentElement as HTMLElement);
      return [style.display, style.alignItems, style.justifyContent, style.minHeight, style.paddingTop];
    };
    const labelStyle = (label: HTMLElement) => {
      const style = window.getComputedStyle(label);
      return [style.fontSize, style.lineHeight, style.marginTop, style.marginBottom];
    };
    for (const label of labels) {
      expect(headStyle(label)).toEqual(headStyle(labels[0]));
      expect(labelStyle(label)).toEqual(labelStyle(labels[0]));
      // The label is the head's first child, at its top: nothing above it, and no centring in a taller head.
      expect(label.parentElement?.firstElementChild).toBe(label);
    }
    expect(window.getComputedStyle(labels[0]).lineHeight).toBe("14px");
    expect(window.getComputedStyle(labels[0].parentElement as HTMLElement).alignItems).toBe("baseline");
    // A taller line beside the name (the page's 1.4 would be 17.5px) would make the head taller and move the name.
    for (const label of labels) {
      const textChildren = Array.from(label.parentElement?.children ?? []).filter((child) => child.textContent && !child.querySelector("button"));
      expect(textChildren.length).toBeGreaterThan(0);
      for (const child of textChildren) {
        expect(Number.parseFloat(window.getComputedStyle(child).lineHeight)).toBeLessThanOrEqual(FULL_MAP_HEAD_HEIGHT);
      }
    }
  });

  it("does not let the saved-score note push the label down: its line is the head's own", () => {
    renderDialog(stableViewModel(), {
      replayValidation: {
        verified: false,
        expectedCounts: [9, 2, 1, 0],
        simulatedCounts: [8, 2, 1, 1],
        expectedMaxCombo: 400,
        simulatedMaxCombo: 321,
        warnings: [],
      },
    });
    const judgements = screen.getByRole("region", { name: "Judgements" });
    const note = within(judgements).getByRole("note", { name: "Saved score differs" });
    // A line no taller than the label's head (the page's 1.4 would make the head taller and move the name).
    expect(Number.parseFloat(window.getComputedStyle(note).lineHeight)).toBeLessThanOrEqual(FULL_MAP_HEAD_HEIGHT);
    expect(window.getComputedStyle(within(judgements).getByRole("heading", { name: "JUDGEMENTS" })).alignSelf).toBe(
      "flex-start",
    );
  });

  it("lays the band out as Aim, Timing, Judgements and Error causes, the new panel last", () => {
    renderDialog(stableViewModel());
    const band = screen.getByRole("region", { name: "Judgements" }).parentElement as HTMLElement;
    expect(Array.from(band.children)).toEqual([
      screen.getByRole("region", { name: "Aim" }),
      screen.getByRole("region", { name: /Hit-error distribution, Stable/ }),
      screen.getByRole("region", { name: "Judgements" }),
      screen.getByRole("region", { name: "Error causes" }),
    ]);
  });

  describe("error causes", () => {
    it("says the analysis is unavailable when it is not given any", () => {
      renderDialog(stableViewModel());
      const panel = screen.getByRole("region", { name: "Error causes" });
      expect(within(panel).getByRole("status").textContent).toBe("Error analysis unavailable.");
      expect(within(panel).queryAllByTestId("error-cause-row")).toHaveLength(0);
    });

    it("shows the counts it is given", () => {
      renderDialog(stableViewModel(), {
        errorCauses: {
          status: "ready",
          total: 4,
          families: {
            aim: { total: 3, miss: 2, slider: 1 },
            tapping: { total: 1, miss: 1, slider: 0 },
            notelock: { total: 0, miss: 0, slider: 0 },
          },
          breakdown: { aim: [], tapping: [], notelock: [] },
          none: { total: 0, miss: 0, slider: 0 },
        },
      });
      const panel = screen.getByRole("region", { name: "Error causes" });
      expect(within(panel).getByText("4 errors")).toBeTruthy();
      expect(within(panel).getAllByTestId("error-cause-row").map((row) => row.getAttribute("aria-label"))).toEqual([
        "Aim: 3",
        "Tapping: 1",
        "Notelock: 0",
      ]);
    });

    it("says it is analyzing while the analysis is", () => {
      renderDialog(stableViewModel(), { errorCauses: { status: "analyzing" } });
      expect(within(screen.getByRole("region", { name: "Error causes" })).getByRole("status").textContent).toBe(
        "Analyzing errors…",
      );
    });

    it("names the ruleset the replay was played in when the page shows the other one", () => {
      renderDialog(lazerViewModel("stable"), { errorCauses: { status: "unavailable", reason: "other-ruleset" } });
      expect(within(screen.getByRole("region", { name: "Error causes" })).getByRole("status").textContent).toBe(
        "Causes are available in the Stable view only.",
      );
    });
  });

  it("lets the judgements head wrap, so its note cannot be clipped in a narrow column, and keeps the note whole at the right", () => {
    renderDialog(stableViewModel(), {
      replayValidation: {
        verified: false,
        expectedCounts: [9, 2, 1, 0],
        simulatedCounts: [8, 2, 1, 1],
        expectedMaxCombo: 400,
        simulatedMaxCombo: 321,
        warnings: [],
      },
    });
    const judgements = screen.getByRole("region", { name: "Judgements" });
    const head = within(judgements).getByRole("heading", { name: "JUDGEMENTS" }).parentElement as HTMLElement;
    const note = within(judgements).getByRole("note", { name: "Saved score differs" });
    // The note goes under the label when the column is too narrow for both, and keeps to the right, as beside it.
    expect(window.getComputedStyle(head).flexWrap).toBe("wrap");
    expect(window.getComputedStyle(note.parentElement as HTMLElement).marginLeft).toBe("auto");
    expect(window.getComputedStyle(note).whiteSpace).toBe("nowrap");
  });

  it("does not print a large notelock count, and keeps the miss count and share", () => {
    const viewModel = stableViewModel();
    viewModel.summary.judgements.countMiss = 12_345;
    viewModel.summary.errors.notelockMissCount = 9_876;
    renderDialog(viewModel);
    const row = screen.getByRole("region", { name: "MISS: 12345" });
    expect(within(row).getByTestId("result-row-count").textContent).toBe("12345");
    expect(screen.queryByText(/Notelock/)).toBeNull();
    expect(within(row).queryByTestId("result-row-detail")).toBeNull();
    expect(within(row).getByTestId("result-row-percentage").textContent).toBe("8.33%");
    expect(within(row).queryByTestId("notelock-miss-arrow")).toBeNull();
  });

  it("retains the selected graph when its selected control is clicked again", () => {
    renderDialog(stableViewModel());
    const unstableRate = graphOption("Unstable rate · 50 hits");
    const hitError = graphOption("Hit error");
    fireEvent.click(unstableRate);
    expect(unstableRate.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hitError);
    fireEvent.click(hitError);
    expect(hitError.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("img", { name: ERROR_GRAPH })).toBeTruthy();
  });

  it("shows the unstable-rate and hit-error graphs in the same place under the panels, before the footer", () => {
    renderDialog(stableViewModel());
    // Together now means in one place: whichever is shown is in the band under the panels.
    const ur = screen.getByRole("img", { name: UR_GRAPH });
    const place = ur.parentElement;
    expect(ur.closest("section")).toBe(overTheMap());
    const timing = showHitError();
    expect(timing.parentElement).toBe(place);
    expect(timing.closest("section")).toBe(overTheMap());
    const footer = dialogFooter();
    expect(overTheMap().compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Judgements" }).compareDocumentPosition(overTheMap()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("changes the ruleset-specific slider metric and sends the canonical switch target", () => {
    const onSwitchRuleset = jest.fn();
    const { rerender } = renderDialog(stableViewModel(), { onSwitchRuleset });

    showHitError();
    expect(screen.getByRole("heading", { name: "OVER THE MAP" })).toBeTruthy();
    const stable = within(rulesetGroup()).getByRole("button", { name: "Stable" });
    const lazer = within(rulesetGroup()).getByRole("button", { name: "Lazer" });
    expect(stable.getAttribute("aria-pressed")).toBe("true");
    expect(lazer.getAttribute("aria-pressed")).toBe("false");
    // The shown ruleset is not a switch target.
    fireEvent.click(stable);
    expect(onSwitchRuleset).not.toHaveBeenCalled();
    fireEvent.click(lazer);
    expect(onSwitchRuleset).toHaveBeenCalledTimes(1);
    expect(onSwitchRuleset).toHaveBeenLastCalledWith("lazer");
    const sliderBreakRegion = screen.getByRole("region", { name: "SLIDER BREAK: 1" });
    expect(window.getComputedStyle(within(sliderBreakRegion).getByText("SliderBreak")).color).toBe(
      "rgb(199, 179, 255)",
    );
    const stableSliderEndRegion = screen.getByRole("region", { name: "SLIDER END: 0" });
    expect(window.getComputedStyle(within(stableSliderEndRegion).getByText("SliderEnd")).color).toBe(
      "rgb(181, 176, 214)",
    );
    expect(screen.queryByRole("region", { name: /^SLIDER TICK:/ })).toBeNull();

    rerender(
      <FullMapAnalysisDialog
        open
        viewModel={lazerViewModel()}
        canSwitchRuleset
        onSwitchRuleset={onSwitchRuleset}
        onClose={jest.fn()}
      />,
    );

    expect(within(dialogHeader()).getByText("Lazer reconstruction")).toBeTruthy();
    expect(within(rulesetGroup()).getByRole("button", { name: "Lazer" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(rulesetGroup()).getByRole("button", { name: "Stable" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("heading", { name: "OVER THE MAP" })).toBeTruthy();
    const sliderTickRegion = screen.getByRole("region", { name: "SLIDER TICK: 1" });
    expect(sliderTickRegion).toBeTruthy();
    expect(window.getComputedStyle(within(sliderTickRegion).getByText("SliderTick")).color).toBe("rgb(199, 179, 255)");
    expect(sliderTickRegion.querySelector("img")).toBeNull();
    const sliderEndRegion = screen.getByRole("region", { name: "SLIDER END: 1" });
    expect(window.getComputedStyle(within(sliderEndRegion).getByText("SliderEnd")).color).toBe("rgb(181, 176, 214)");
    expect(screen.queryByRole("region", { name: /^SLIDER BREAK:/ })).toBeNull();
    fireEvent.click(within(rulesetGroup()).getByRole("button", { name: "Stable" }));
    expect(onSwitchRuleset).toHaveBeenCalledTimes(2);
    expect(onSwitchRuleset).toHaveBeenLastCalledWith("stable");
  });

  it("names the map, the player and the shown ruleset in the header", () => {
    renderDialog({
      ...stableViewModel(),
      context: { artist: "xi", title: "ANiMA", difficulty: "Oberum Primus", player: "WinterBird" },
    });
    const header = dialogHeader();
    const map = wholeText(header, "xi - ANiMA [Oberum Primus]");
    // The artist and its dash are quieter than the title.
    expect(window.getComputedStyle(within(map).getByText("xi -")).color).toBe("rgb(201, 198, 192)");
    expect(window.getComputedStyle(within(header).getByText("WinterBird")).color).toBe("rgb(226, 223, 217)");
    expect(header.textContent).not.toMatch(/—|osu!standard|Played by/);
    expect(
      within(rulesetGroup())
        .getAllByRole("button")
        .map((button) => [button.textContent, button.getAttribute("aria-pressed")]),
    ).toEqual([
      ["Stable", "true"],
      ["Lazer", "false"],
    ]);
    expectDocumentOrder([
      within(header).getByRole("heading", { name: "Full-map analysis" }),
      map,
      within(header).getByText("WinterBird"),
      rulesetGroup(),
      within(header).getByRole("button", { name: "Close full-map analysis" }),
    ]);
  });

  it("captions a reconstruction only when the shown ruleset is not the replay's own", () => {
    const props = { open: true, canSwitchRuleset: true, onSwitchRuleset: jest.fn(), onClose: jest.fn() };
    const pressed = (name: string) => within(rulesetGroup()).getByRole("button", { name }).getAttribute("aria-pressed");
    const { rerender } = render(<FullMapAnalysisDialog {...props} viewModel={lazerViewModel("lazer")} />);
    expect(screen.queryByText(/reconstruction/)).toBeNull();
    expect(pressed("Lazer")).toBe("true");

    rerender(<FullMapAnalysisDialog {...props} viewModel={stableViewModel(true, "lazer")} />);
    const caption = within(dialogHeader()).getByText("Stable reconstruction");
    expect(pressed("Stable")).toBe("true");
    expect(caption.compareDocumentPosition(rulesetGroup()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(window.getComputedStyle(caption).color).toBe("rgb(168, 165, 158)");
    expect(window.getComputedStyle(caption).fontSize).toBe("12px");

    rerender(<FullMapAnalysisDialog {...props} viewModel={lazerViewModel("stable")} />);
    expect(within(dialogHeader()).getByText("Lazer reconstruction")).toBeTruthy();
    expect(screen.queryByText("Stable reconstruction")).toBeNull();

    rerender(<FullMapAnalysisDialog {...props} viewModel={stableViewModel(true, "stable")} />);
    expect(screen.queryByText(/reconstruction/)).toBeNull();
  });

  it("disables the other ruleset when the alternate reconstruction is unavailable", () => {
    const { onSwitchRuleset } = renderDialog(stableViewModel(), { canSwitchRuleset: false });

    const lazer = within(rulesetGroup()).getByRole("button", { name: "Lazer" });
    expect((lazer as HTMLButtonElement).disabled).toBe(true);
    expect((within(rulesetGroup()).getByRole("button", { name: "Stable" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(lazer);
    expect(onSwitchRuleset).not.toHaveBeenCalled();
  });

  it("forces failed replay evidence to an F rank with an explicit completion label", () => {
    renderDialog(stableViewModel(false));

    const rank = within(screen.getByRole("region", { name: "Result" })).getByLabelText("Rank F, failed replay");
    expect(within(rank).getByText("F")).toBeTruthy();
    expect(within(rank).getByText("RANK · FAILED")).toBeTruthy();
  });

  it("closes from the target-style close control", () => {
    const onClose = jest.fn();
    renderDialog(stableViewModel(), { onClose });

    fireEvent.click(screen.getByRole("button", { name: "Close full-map analysis" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders unavailable timing data without leaking NaN or Infinity", () => {
    const viewModel = missingTimingViewModel();
    // A play of nothing but misses: there are marks, and no graph to draw them under.
    viewModel.marks = { miss: [1_000, 2_000], sliderBreak: [], ok: [], meh: [] };
    const onOpenReplayAt = jest.fn();
    renderDialog(viewModel, { onOpenReplayAt });

    const urGraph = within(overTheMap()).getByRole("img", { name: UR_GRAPH });
    expect(within(urGraph).getByText("No UR samples")).toBeTruthy();
    expect(within(overTheMap()).queryByTestId("map-marks-lane")).toBeNull();
    // Nothing is plotted, so no time axis is drawn either.
    expect(within(urGraph).queryAllByText(/^\d+:\d\d$/)).toHaveLength(0);
    fireEvent.click(within(urGraph).getByTestId("current-ur-interaction-layer"));
    const errorGraph = showHitError();
    expect(within(errorGraph).getByText("No valid timing samples")).toBeTruthy();
    expect(within(overTheMap()).queryByTestId("map-marks-lane")).toBeNull();
    expect(within(errorGraph).queryAllByText(/^\d+:\d\d$/)).toHaveLength(0);
    expect(within(errorGraph).queryByText("Early")).toBeNull();
    fireEvent.click(within(errorGraph).getByTestId("timing-interaction-layer"));
    expect(onOpenReplayAt).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("region", { name: "Hit-error distribution unavailable" })).getByRole("status")
        .textContent,
    ).toBe("No timing samples");
    expect(screen.queryByText("No timing distribution available")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Full-map analysis" }).textContent).not.toMatch(/NaN|Infinity/);
  });
});

describe("the graphs' hover cards show the other measure", () => {
  const signed = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
  const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  /** The tooltip of the graph after `steps` presses of ArrowRight from the first point. */
  const select = (graph: HTMLElement, steps: number) => {
    fireEvent.focus(graph);
    for (let step = 0; step < steps; step++) fireEvent.keyDown(graph, { key: "ArrowRight" });
    return within(graph).getByRole("tooltip");
  };

  it("adds the hit error nearest in time under the unstable-rate graph", () => {
    const viewModel = stableViewModel();
    const { samples, urOverTime } = viewModel.summary.timing;
    expect(urOverTime.length).toBeGreaterThan(1);
    renderDialog(viewModel);
    const graph = within(overTheMap()).getByRole("img", { name: UR_GRAPH });
    for (const [index, point] of urOverTime.entries()) {
      const tooltip = select(graph, index > 0 ? 1 : 0);
      const nearest = samples.reduce((best, sample) =>
        Math.abs(sample.time - point.time) < Math.abs(best.time - point.time) ? sample : best,
      );
      expect(tooltip.textContent).toBe(
        `${clock(point.time)}${point.unstableRate.toFixed(1)}URHit error${signed(nearest.offsetMs)}ms`,
      );
      expect(tooltip.getAttribute("aria-label")?.endsWith(`, hit error ${signed(nearest.offsetMs)} ms`)).toBe(true);
    }
  });

  it("adds the latest unstable rate at or before the sample under the hit-error graph, and nothing before the first", () => {
    const viewModel = stableViewModel();
    const { samples, urOverTime } = viewModel.summary.timing;
    // The first sample comes before any unstable rate (it needs two hits), and a later one has one.
    expect(urOverTime[0].time).toBeGreaterThan(samples[0].time);
    renderDialog(viewModel);
    const graph = showHitError();
    const first = select(graph, 0);
    expect(first.textContent).not.toMatch(/Unstable rate/);
    expect(first.getAttribute("aria-label")).not.toMatch(/unstable rate/);
    for (let index = 1; index < samples.length; index++) {
      const tooltip = select(graph, 1);
      const latest = urOverTime.filter((point) => point.time <= samples[index].time).pop();
      if (latest) {
        expect(tooltip.textContent).toContain(`Unstable rate${latest.unstableRate.toFixed(1)}UR`);
        expect(tooltip.getAttribute("aria-label")?.endsWith(`, unstable rate ${latest.unstableRate.toFixed(1)}`)).toBe(
          true,
        );
      } else {
        expect(tooltip.textContent).not.toMatch(/Unstable rate/);
      }
    }
  });

  it("names the graph's own value without words about the series", () => {
    renderDialog(stableViewModel());
    const tooltip = select(within(overTheMap()).getByRole("img", { name: UR_GRAPH }), 0);
    expect(tooltip.textContent).not.toMatch(/hits|last|average/);
  });
});
