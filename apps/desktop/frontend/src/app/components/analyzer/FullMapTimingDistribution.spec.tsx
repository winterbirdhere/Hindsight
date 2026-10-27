import { render, screen, within } from "@testing-library/react";
import { analyzeFullMap, type FullMapTimingSummary } from "../../services/analysis/full-map-analysis";
import {
  buildFullMapAnalysisViewModel,
  type FullMapHitWindowReferences,
} from "../../services/analysis/full-map-analysis-view-model";
import { FullMapTimingDistribution } from "./FullMapTimingDistribution";

const EARLY = "rgb(111, 202, 221)";
const LATE = "rgb(217, 144, 170)";
const PRIMARY = "rgb(245, 244, 241)";
const TERTIARY = "rgb(168, 165, 158)";

/** Four timed hits (-18, -7, +5, +16 ms: mean -1.0) on an OD 8 Stable map: windows 31 / 75 / 119 ms. */
function fixture(): { timing: FullMapTimingSummary; hitWindows: FullMapHitWindowReferences } {
  const summary = analyzeFullMap({
    ruleset: "stable",
    events: [],
    hits: [
      [1_000, -18, true],
      [2_000, -7, true],
      [3_000, 5, true],
      [4_000, 250, false],
      [5_000, 16, true],
    ],
    duration: 12_000,
    baseRate: 1,
    aggregateJudgementCountsInput: [4, 0, 0, 1],
    objectCoverage: { totalObjectCount: 5 },
  });
  const viewModel = buildFullMapAnalysisViewModel({
    summary,
    replay: { passed: true, mods: [], sourceRuleset: "stable" },
    beatmap: {
      durationMs: 12_000,
      objectCount: 5,
      hitCircleCount: 5,
      sliderCount: 0,
      timingPoints: [{ time: 0, beatLength: 500 }],
      difficulty: { drainRate: 5, circleSize: 4, overallDifficulty: 8, approachRate: 9 },
    },
  });
  return { timing: viewModel.summary.timing, hitWindows: viewModel.hitWindows };
}

function renderDistribution(
  overrides: { timing?: Partial<FullMapTimingSummary>; hitWindows?: FullMapHitWindowReferences } = {},
) {
  const base = fixture();
  const props = {
    timing: { ...base.timing, ...overrides.timing },
    hitWindows: overrides.hitWindows ?? base.hitWindows,
    rulesetLabel: "Stable",
    od: 8,
  };
  return { ...render(<FullMapTimingDistribution {...props} />), ...props };
}

/** The rules of each small-window media query that mention one of the element's generated classes. */
function smallWindowRules(element: Element): string[] {
  const classes = Array.from(element.classList).filter((name) => name.startsWith("css-"));
  const rules = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
  return ["@media (max-width: 1099px)", "@media (max-height: 699px)"].map((query) =>
    rules
      .filter((rule) => rule.cssText.startsWith(query) && classes.some((name) => rule.cssText.includes("." + name)))
      .map((rule) => rule.cssText)
      .join("\n"),
  );
}

const px = (value: string) => Number.parseFloat(value);

it("names the panel and its distribution as before, under the TIMING label", () => {
  renderDistribution();
  const panel = screen.getByRole("region", {
    name: "Hit-error distribution, Stable, OD 8, 300 ±31.0ms, 100 ±75.0ms, 50 ±119.0ms, 4 successful hits in the distribution",
  });
  const label = within(panel).getByRole("heading", { name: "TIMING" });
  expect(getComputedStyle(label).fontFamily).toContain("Geist Mono");
  expect(getComputedStyle(label).fontSize).toBe("11px");
  expect(getComputedStyle(label).color).toBe(TERTIARY);
  expect(within(panel).getByRole("img", { name: "Hit-error distribution from 4 successful hits" })).toBeTruthy();
  expect(
    within(panel)
      .getAllByTestId("ur-distribution-bin")
      .reduce((total, bin) => total + Number(bin.getAttribute("data-count")), 0),
  ).toBe(4);
  // The old heading and its line of facts are gone: the page's header and footer say them once.
  expect(panel.textContent).not.toMatch(/Hit-error distribution|timed hits|OD 8/);
});

it("maps the canonical hit-error histogram to neutral bins that fill the plot's height, without the legacy pink sigma bracket", () => {
  const histogram = {
    binWidthMs: 10,
    extentMs: 20,
    bins: [
      { centerMs: -10, startMs: -15, endMs: -5, count: 1 },
      { centerMs: 0, startMs: -5, endMs: 5, count: 4 },
      { centerMs: 10, startMs: 5, endMs: 15, count: 0 },
    ],
  };
  const { hitWindows } = renderDistribution({ timing: { histogram } });

  const panel = screen.getByRole("region", { name: /5 successful hits in the distribution/ });
  const distribution = within(panel).getByRole("img", { name: "Hit-error distribution from 5 successful hits" });
  const bins = within(distribution).getAllByTestId("ur-distribution-bin");
  const mehWindow = hitWindows.mehMs as number;

  expect(bins.map((bin) => Number(bin.getAttribute("data-count")))).toEqual([1, 4, 0]);
  expect(bins.map((bin) => getComputedStyle(bin).backgroundColor)).toEqual(Array(3).fill("rgba(245, 244, 241, 0.55)"));
  // Scaled to the tallest bin, as shares of the plot's own height; a bin with hits never rounds away to nothing.
  expect(bins.map((bin) => getComputedStyle(bin).height)).toEqual(["25%", "100%", "0%"]);
  expect(bins.map((bin) => px(getComputedStyle(bin).minHeight))).toEqual([1, 1, 0]);
  expect(bins.map((bin) => px(getComputedStyle(bin).bottom))).toEqual([0, 0, 0]);
  // Square-cornered bars, as before.
  expect(bins.map((bin) => getComputedStyle(bin).borderRadius)).toEqual(["0", "0", "0"]);
  // No box behind the bars.
  expect(["", "transparent", "rgba(0, 0, 0, 0)"]).toContain(getComputedStyle(distribution).backgroundColor);

  for (const [index, bin] of bins.entries()) {
    const startMs = Number(bin.getAttribute("data-start-ms"));
    const endMs = Number(bin.getAttribute("data-end-ms"));
    expect(px(getComputedStyle(bin).left)).toBeCloseTo(50 + (startMs / mehWindow) * 50, 5);
    expect(px(getComputedStyle(bin).width)).toBeCloseTo(((endMs - startMs) / mehWindow) * 50, 5);
    expect(bin.getAttribute("title")).toContain(index === 1 ? "4 hits" : index === 0 ? "1 hit" : "0 hits");
  }
  for (const index of [0, 1]) {
    expect(px(getComputedStyle(bins[index]).left) + px(getComputedStyle(bins[index]).width)).toBeCloseTo(
      px(getComputedStyle(bins[index + 1]).left),
      5,
    );
  }

  expect(distribution.children).toHaveLength(bins.length);
  expect(within(distribution).queryByText(/σ|standard deviation/i)).toBeNull();
  expect(within(panel).queryByTestId("ur-standard-deviation-span")).toBeNull();
  expect(
    Array.from(distribution.querySelectorAll<HTMLElement>("*")).some(
      (element) => getComputedStyle(element).borderTopColor === "rgb(255, 79, 136)",
    ),
  ).toBe(false);
});

it("draws only the bins that have finite edges, and counts only what is drawn", () => {
  const histogram = {
    binWidthMs: 10,
    extentMs: 30,
    bins: [
      { centerMs: -10, startMs: -15, endMs: -5, count: 2 },
      { centerMs: 0, startMs: Number.NaN, endMs: 5, count: 50 },
      { centerMs: 10, startMs: 5, endMs: Number.POSITIVE_INFINITY, count: 40 },
      { centerMs: 20, startMs: 5, endMs: 15, count: 3 },
    ],
  };
  renderDistribution({ timing: { histogram } });
  const distribution = screen.getByRole("img", { name: "Hit-error distribution from 5 successful hits" });
  const bins = within(distribution).getAllByTestId("ur-distribution-bin");
  expect(bins.map((bin) => Number(bin.getAttribute("data-count")))).toEqual([2, 3]);
  // The tallest bin is the tallest one drawn: 3 hits fill the plot, 2 are two thirds of it.
  expect(bins.map((bin) => bin.style.height)).toEqual([`${(2 / 3) * 100}%`, "100%"]);
  for (const bin of bins) expect(bin.getAttribute("style")).not.toMatch(/NaN|Infinity/);
  expect(distribution.textContent).not.toMatch(/NaN|Infinity/);
});

it("clamps bins to the widest window and drops the ones outside it", () => {
  const histogram = {
    binWidthMs: 100,
    extentMs: 300,
    bins: [
      { centerMs: -250, startMs: -300, endMs: -200, count: 2 },
      { centerMs: -100, startMs: -150, endMs: -50, count: 3 },
      { centerMs: 0, startMs: -50, endMs: 50, count: 6 },
    ],
  };
  renderDistribution({ timing: { histogram } });
  const bins = screen.getAllByTestId("ur-distribution-bin");
  // -300..-200 lies wholly outside ±119 ms; -150..-50 is cut at the edge.
  expect(bins.map((bin) => Number(bin.getAttribute("data-count")))).toEqual([3, 6]);
  expect(getComputedStyle(bins[0]).left).toBe("0%");
  expect(px(getComputedStyle(bins[0]).width)).toBeCloseTo(((119 - 50) / 119) * 50, 5);
  expect(screen.getByRole("img", { name: "Hit-error distribution from 9 successful hits" })).toBeTruthy();
});

it("draws the hit windows as a 4px strip under the bars, in the windows' colours", () => {
  const { hitWindows } = renderDistribution();
  const strip = screen.getByTestId("ur-timing-bar");
  expect(getComputedStyle(strip).height).toBe("4px");
  const great = hitWindows.greatMs as number;
  const ok = hitWindows.okMs as number;
  const meh = hitWindows.mehMs as number;
  const expected = [
    [(meh - ok) / 2 / meh, "rgb(217, 169, 59)"],
    [(ok - great) / 2 / meh, "rgb(76, 197, 74)"],
    [great / meh, "rgb(59, 167, 227)"],
    [(ok - great) / 2 / meh, "rgb(76, 197, 74)"],
    [(meh - ok) / 2 / meh, "rgb(217, 169, 59)"],
  ] as const;
  expect(strip.children).toHaveLength(5);
  expected.forEach(([width, color], index) => {
    const segment = strip.children[index];
    expect(px(getComputedStyle(segment).flexBasis)).toBeCloseTo(width * 100, 5);
    expect(getComputedStyle(segment).backgroundColor).toBe(color);
  });
  const distribution = screen.getByTestId("ur-hit-distribution");
  expect(distribution.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("labels both edges of every window and the centre", () => {
  renderDistribution({ hitWindows: { available: true, greatMs: 22.6, okMs: 63.8, mehMs: 105, missMs: null } });
  const labels = Array.from(screen.getByTestId("ur-window-edges").children) as HTMLElement[];
  // One decimal, none for a whole number of milliseconds, and a true minus sign.
  expect(labels.map((label) => label.textContent)).toEqual(["−105", "−63.8", "−22.6", "0", "+22.6", "+63.8", "+105"]);
  const expectedLeft = [-105, -63.8, -22.6, 0, 22.6, 63.8, 105].map((ms) => 50 + (ms / 105) * 50);
  labels.forEach((label, index) => {
    const style = getComputedStyle(label);
    expect(px(style.left)).toBeCloseTo(expectedLeft[index], 5);
    expect(style.fontSize).toBe("11px");
    expect(style.fontVariantNumeric).toBe("tabular-nums");
    expect(style.fontFamily).toContain("Geist");
    expect(style.fontFamily).not.toContain("Mono");
    expect(style.color).toBe(index === 3 ? PRIMARY : TERTIARY);
    expect(style.fontWeight).toBe(index === 3 ? "600" : "400");
  });
  // The outermost two stay inside the plot; the rest are centred on their edge.
  expect(labels.map((label) => getComputedStyle(label).transform)).toEqual([
    "none",
    "translateX(-50%)",
    "translateX(-50%)",
    "translateX(-50%)",
    "translateX(-50%)",
    "translateX(-50%)",
    "translateX(-100%)",
  ]);
  // The region's name already says the windows.
  expect(screen.getByTestId("ur-window-edges").getAttribute("aria-hidden")).toBe("true");
});

it("prints a window edge with floating-point noise as the number it is", () => {
  // Rate mods scale the windows, and 75 ms can arrive as 75.00000000001.
  renderDistribution({
    hitWindows: { available: true, greatMs: 31.000000000004, okMs: 75.00000000001, mehMs: 119.5, missMs: null },
  });
  const labels = Array.from(screen.getByTestId("ur-window-edges").children) as HTMLElement[];
  expect(labels.map((label) => label.textContent)).toEqual(["−119.5", "−75", "−31", "0", "+31", "+75", "+119.5"]);
});

it("draws the zero line taller and brighter than the mean line", () => {
  renderDistribution({ timing: { meanOffsetMs: 9.5 } });
  const zero = getComputedStyle(screen.getByTestId("ur-zero-offset-marker"));
  const mean = getComputedStyle(screen.getByTestId("ur-average-offset-marker"));
  expect(screen.getByRole("img", { name: "Perfect timing at 0 ms" })).toBe(screen.getByTestId("ur-zero-offset-marker"));
  expect(zero.left).toBe("50%");
  expect(zero.width).toBe("2px");
  expect(zero.backgroundColor).toBe(PRIMARY);
  expect(mean.width).toBe("1px");
  expect(mean.backgroundColor).toBe(LATE);
  expect(px(mean.left)).toBeCloseTo(50 + (9.5 / 119) * 50, 5);
  // The zero line starts above the mean line and runs on through the strip; the mean line stops at the bars' floor.
  expect(px(zero.top)).toBeLessThan(px(mean.top));
  expect(px(zero.bottom)).toBeLessThan(px(mean.bottom));
});

it("colours the mean by its side", () => {
  const base = fixture();
  const props = { hitWindows: base.hitWindows, rulesetLabel: "Stable", od: 8 };
  const { rerender } = render(<FullMapTimingDistribution {...props} timing={{ ...base.timing, meanOffsetMs: 9.5 }} />);
  expect(getComputedStyle(screen.getByText("Mean +9.5 ms")).color).toBe(LATE);
  expect(getComputedStyle(screen.getByTestId("ur-average-offset-marker")).backgroundColor).toBe(LATE);
  expect(getComputedStyle(screen.getByTestId("ur-average-offset-pointer")).borderTopColor).toBe(LATE);

  rerender(<FullMapTimingDistribution {...props} timing={{ ...base.timing, meanOffsetMs: -9.5 }} />);
  expect(getComputedStyle(screen.getByText("Mean -9.5 ms")).color).toBe(EARLY);
  expect(getComputedStyle(screen.getByTestId("ur-average-offset-marker")).backgroundColor).toBe(EARLY);
  expect(getComputedStyle(screen.getByTestId("ur-average-offset-pointer")).borderTopColor).toBe(EARLY);
});

it("keeps the average-offset callout inside the plot at either timing-window edge", () => {
  const base = fixture();
  const mehWindow = base.hitWindows.mehMs as number;
  const props = { hitWindows: base.hitWindows, rulesetLabel: "Stable", od: 8 };
  const { rerender } = render(
    <FullMapTimingDistribution {...props} timing={{ ...base.timing, meanOffsetMs: -mehWindow }} />,
  );

  const earlyCallout = screen.getByTestId("ur-average-offset-callout");
  expect(getComputedStyle(earlyCallout).left).toBe("0%");
  expect(getComputedStyle(earlyCallout).transform).toBe("none");
  expect(getComputedStyle(earlyCallout).alignItems).toBe("flex-start");

  rerender(<FullMapTimingDistribution {...props} timing={{ ...base.timing, meanOffsetMs: mehWindow }} />);
  const lateCallout = screen.getByTestId("ur-average-offset-callout");
  expect(getComputedStyle(lateCallout).left).toBe("100%");
  expect(getComputedStyle(lateCallout).transform).toBe("translateX(-100%)");
  expect(getComputedStyle(lateCallout).alignItems).toBe("flex-end");

  // A mean beyond the widest window is still called out, at the edge.
  rerender(<FullMapTimingDistribution {...props} timing={{ ...base.timing, meanOffsetMs: mehWindow * 3 }} />);
  expect(getComputedStyle(screen.getByTestId("ur-average-offset-callout")).left).toBe("100%");
  expect(getComputedStyle(screen.getByTestId("ur-average-offset-marker")).left).toBe("100%");
});

it.each([0.04, -0.04, -0.0000001])("reads a mean of %p, which rounds to 0.0, as 0.0 ms without a sign", (meanOffsetMs) => {
  renderDistribution({ timing: { meanOffsetMs } });

  const callout = screen.getByTestId("ur-average-offset-callout");
  expect(callout.textContent).toBe("Mean 0.0 ms");
  expect(getComputedStyle(callout).color).toBe(PRIMARY);
});

it("collapses the average marker into the single zero line when the average offset is centered", () => {
  renderDistribution({ timing: { meanOffsetMs: 0 } });

  const visual = screen.getByTestId("ur-bar-visual");
  expect(within(visual).getAllByTestId("ur-zero-offset-marker")).toHaveLength(1);
  expect(within(visual).queryByTestId("ur-average-offset-marker")).toBeNull();
  expect(within(visual).getByText("Mean 0.0 ms")).toBeTruthy();
  expect(getComputedStyle(within(visual).getByTestId("ur-average-offset-callout")).color).toBe(PRIMARY);
});

it("gives the early and late shares and the windows' key in the footer", () => {
  renderDistribution({ timing: { earlyPercentage: 0.248, latePercentage: 0.752 } });
  const panel = screen.getByRole("region", { name: /Hit-error distribution, Stable/ });
  const early = within(panel).getByText("Early");
  const late = within(panel).getByText("Late");
  expect(early.textContent).toBe("Early 24.8%");
  expect(late.textContent).toBe("75.2% Late");
  expect(getComputedStyle(early).color).toBe(EARLY);
  expect(getComputedStyle(late).color).toBe(LATE);
  expect(getComputedStyle(within(early).getByText("24.8%")).color).toBe(PRIMARY);
  expect(getComputedStyle(within(late).getByText("75.2%")).color).toBe(PRIMARY);
  const key = within(panel).getByText("hit windows, ms").parentElement as HTMLElement;
  expect(key.textContent).toBe("300 100 50 hit windows, ms");
  expect(["300", "100", "50"].map((name) => getComputedStyle(within(key).getByText(name)).color)).toEqual([
    "rgb(59, 167, 227)",
    "rgb(76, 197, 74)",
    "rgb(217, 169, 59)",
  ]);
  expect(early.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(key.compareDocumentPosition(late) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The windows' sizes are on the plot's edges now, not in a second row of text.
  expect(panel.textContent).not.toMatch(/±/);
});

it("shows a dash for a share it does not have", () => {
  renderDistribution({ timing: { earlyPercentage: null, latePercentage: null } });
  expect(screen.getByText("Early").textContent).toBe("Early —");
  expect(screen.getByText("Late").textContent).toBe("— Late");
});

describe("with nothing to plot", () => {
  const expectNothingDrawn = (panel: HTMLElement) => {
    for (const id of [
      "ur-bar-visual",
      "ur-hit-distribution",
      "ur-distribution-bin",
      "ur-timing-bar",
      "ur-window-edges",
      "ur-zero-offset-marker",
      "ur-average-offset-marker",
      "ur-average-offset-callout",
    ]) {
      expect(within(panel).queryByTestId(id)).toBeNull();
    }
    expect(within(panel).queryByRole("img")).toBeNull();
    expect(within(panel).queryByText(/Early|Late|hit windows/)).toBeNull();
    expect(within(panel).getByRole("heading", { name: "TIMING" })).toBeTruthy();
    const css = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText)
      .join("\n");
    expect(`${panel.outerHTML}\n${css}`).not.toMatch(/NaN|Infinity|undefined/);
  };

  it.each<[string, FullMapHitWindowReferences]>([
    ["marked unavailable", { available: false, greatMs: null, okMs: null, mehMs: null, missMs: null }],
    ["not numbers", { available: true, greatMs: Number.NaN, okMs: 75.5, mehMs: 119.5, missMs: null }],
    ["out of order", { available: true, greatMs: 80, okMs: 75.5, mehMs: 119.5, missMs: null }],
    ["of no width", { available: true, greatMs: 0, okMs: 0, mehMs: 0, missMs: null }],
  ])("shows `Timing windows unavailable` and no bars, strip or labels when the windows are %s", (_, hitWindows) => {
    renderDistribution({ hitWindows });
    const panel = screen.getByRole("region", { name: "Hit-error distribution unavailable" });
    expect(within(panel).getByRole("status").textContent).toBe("Timing windows unavailable");
    expectNothingDrawn(panel);
  });

  it("says there are no timing samples, and draws no bars, strip or labels, when no hit was timed", () => {
    const summary = analyzeFullMap({
      ruleset: "stable",
      events: [],
      hits: [],
      duration: 12_000,
      baseRate: 1,
      aggregateJudgementCountsInput: [0, 0, 0, 3],
      objectCoverage: { totalObjectCount: 3 },
    });
    expect(summary.timing.available).toBe(false);
    renderDistribution({ timing: summary.timing });
    const panel = screen.getByRole("region", { name: "Hit-error distribution unavailable" });
    expect(within(panel).getByRole("status").textContent).toBe("No timing samples");
    expectNothingDrawn(panel);
  });

  it("does not plot a mean that is not a number", () => {
    renderDistribution({ timing: { meanOffsetMs: Number.NaN } });
    const panel = screen.getByRole("region", { name: /Hit-error distribution, Stable/ });
    expect(within(panel).queryByTestId("ur-average-offset-callout")).toBeNull();
    expect(within(panel).queryByTestId("ur-average-offset-marker")).toBeNull();
    expect(within(panel).getByTestId("ur-zero-offset-marker")).toBeTruthy();
    expect(panel.outerHTML).not.toMatch(/NaN/);
  });
});

it("is a panel of head, plot and foot that keeps a real height when the page stacks", () => {
  renderDistribution();
  const panel = screen.getByRole("region", { name: /Hit-error distribution, Stable/ });
  const style = getComputedStyle(panel);
  expect(style.display).toBe("grid");
  expect(style.gridTemplateRows).toBe("auto minmax(0, 1fr) auto");
  expect(Array.from(panel.children).map((child) => child.tagName)).toHaveLength(3);
  for (const rules of smallWindowRules(panel)) expect(rules).toMatch(/min-height: 260px/);
});
