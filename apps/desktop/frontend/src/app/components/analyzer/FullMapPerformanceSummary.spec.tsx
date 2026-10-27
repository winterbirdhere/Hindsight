import { fireEvent, render, screen, within } from "@testing-library/react";
import { FullMapPerformanceSummary } from "./FullMapPerformanceSummary";
import type { FullMapPerformance } from "../../services/analysis/performance/PerformanceTimelineService";

const performance: FullMapPerformance = {
  status: "ready",
  pp: 234.567,
  sr: 7.1999,
  breakdown: { total: 7.19, aim: 3.93, speed: 1.99, reading: 1.27, flashlight: 0, sliderAim: 0.07 },
  description: "Stable: final achieved replay PP and full-map difficulty.",
};

it("shows the component breakdown only in the total SR tooltip and leaves PP without a tooltip", async () => {
  render(<FullMapPerformanceSummary performance={performance} failed />);
  expect(screen.getByLabelText("Replay PP 234.57").closest("[title]")).toBeNull();
  expect(screen.getByText("Achieved before replay ended")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "SR breakdown" })).toBeNull();
  expect(screen.queryByText("Aim")).toBeNull();
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseOver(screen.getByLabelText("Full-map SR 7.19 stars"));
  const tooltip = await screen.findByRole("tooltip");
  for (const value of ["Aim", "3.93", "Speed", "1.99", "Reading", "1.27"]) {
    expect(within(tooltip).getByText(value)).toBeTruthy();
  }
  expect(within(tooltip).queryByText("Flashlight")).toBeNull();
  expect(screen.queryByRole("button", { name: /Aim/ })).toBeNull();
});

it("refreshes the total SR tooltip for a new ruleset and includes contributing Flashlight", async () => {
  const { rerender } = render(<FullMapPerformanceSummary performance={performance} />);
  fireEvent.mouseOver(screen.getByLabelText("Full-map SR 7.19 stars"));
  await screen.findByRole("tooltip");
  rerender(
    <FullMapPerformanceSummary
      performance={{
        ...performance,
        pp: 300,
        sr: 5.5796,
        breakdown: { total: 5.57, aim: 2.67, speed: 1.78, reading: 0.89, flashlight: 0.23, sliderAim: 0.53 },
      }}
    />,
  );
  expect(screen.getByLabelText("Replay PP 300.00")).toBeTruthy();
  expect(screen.getByLabelText("Full-map SR 5.57 stars")).toBeTruthy();
  const tooltip = screen.getByRole("tooltip");
  for (const value of ["Aim", "2.67", "Speed", "1.78", "Reading", "0.89", "Flashlight", "0.23"]) {
    expect(within(tooltip).getByText(value)).toBeTruthy();
  }
  expect(within(tooltip).queryByText("3.93")).toBeNull();
});

it("distinguishes valid zeros from loading, errors and missing breakdowns", async () => {
  const { rerender } = render(
    <FullMapPerformanceSummary performance={{ status: "loading", description: "Calculating replay performance…" }} />,
  );
  expect(screen.getByRole("status").textContent).toContain("Calculating");
  expect(screen.queryByLabelText(/Replay PP/)).toBeNull();
  rerender(<FullMapPerformanceSummary performance={{ status: "unavailable", description: "Unsupported mod ZZ" }} />);
  expect(screen.getByText("Unsupported mod ZZ")).toBeTruthy();
  rerender(
    <FullMapPerformanceSummary performance={{ status: "ready", pp: 0, sr: 0, description: "Zero difficulty" }} />,
  );
  expect(screen.getByLabelText("Replay PP 0.00")).toBeTruthy();
  fireEvent.mouseOver(screen.getByLabelText("Full-map SR 0.00 stars"));
  expect((await screen.findByRole("tooltip")).textContent).toBe("SR breakdown unavailable");
  rerender(
    <FullMapPerformanceSummary
      performance={{
        ...performance,
        pp: 0,
        sr: 0,
        breakdown: { total: 0, aim: 0, speed: 0, reading: 0, flashlight: 0, sliderAim: 0 },
      }}
    />,
  );
  const tooltip = screen.getByRole("tooltip");
  expect(within(tooltip).getAllByText("0.00")).toHaveLength(3);
  expect(within(tooltip).queryByText("Flashlight")).toBeNull();
});

it("sets each value in the result row's type, with its name beneath", () => {
  const { rerender } = render(<FullMapPerformanceSummary performance={performance} />);
  const pp = screen.getByLabelText("Replay PP 234.57");
  const sr = screen.getByLabelText("Full-map SR 7.19 stars");
  expect(getComputedStyle(pp).fontSize).toBe("42px");
  expect(getComputedStyle(sr).fontSize).toBe("28px");
  for (const value of [pp, sr]) {
    expect(getComputedStyle(value).fontWeight).toBe("300");
    expect(getComputedStyle(value).fontVariantNumeric).toBe("tabular-nums");
    expect(getComputedStyle(value).fontFamily).toContain("Geist");
    expect(getComputedStyle(value).fontFamily).not.toContain("Mono");
  }
  expect(getComputedStyle(pp).color).toBe("rgb(245, 244, 241)");
  expect(getComputedStyle(sr).color).toBe("rgb(245, 210, 122)");
  expect(pp.textContent).toBe("234.57pp");
  expect(sr.textContent).toBe("7.19");
  for (const [value, label] of [
    [pp, "PERFORMANCE"],
    [sr, "STAR RATING"],
  ] as const) {
    const name = screen.getByText(label);
    expect(value.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getComputedStyle(name).fontFamily).toContain("Geist Mono");
    expect(getComputedStyle(name).textTransform).toBe("uppercase");
  }
  // A sentence in a value's place wraps instead of widening the row, and has no value's name under it.
  rerender(
    <FullMapPerformanceSummary
      metric="pp"
      performance={{ status: "unavailable", description: "Unsupported mod ZZ" }}
    />,
  );
  expect(getComputedStyle(screen.getByRole("status")).maxWidth).toBe("240px");
  expect(screen.queryByText("PERFORMANCE")).toBeNull();
});

describe("a status in a value's place", () => {
  const TYPE = ["fontSize", "fontWeight", "lineHeight", "fontFamily"] as const;

  it.each([
    ["pp", "loading", "Replay PP 234.57", "Calculating replay performance…", "PP"],
    ["pp", "unavailable", "Replay PP 234.57", "Unsupported mod ZZ", "PP unavailable"],
    ["sr", "loading", "Full-map SR 7.19 stars", "Calculating replay performance…", "SR"],
    ["sr", "unavailable", "Full-map SR 7.19 stars", "Unsupported mod ZZ", "SR unavailable"],
  ] as const)(
    "is as tall as a ready %s stat while it is %s: a dash for the value, and the sentence on the label's line",
    (metric, status, valueName, description, heading) => {
      const { rerender } = render(<FullMapPerformanceSummary metric={metric} performance={performance} />);
      const readyStat = screen.getByLabelText(valueName).parentElement as HTMLElement;
      const [readyValue, readyLabel] = Array.from(readyStat.children) as HTMLElement[];
      rerender(<FullMapPerformanceSummary metric={metric} performance={{ status, description }} />);

      const block = screen.getByRole("status");
      // The same two lines, one over the other, with the same gap, so the row does not change height when PP arrives.
      expect(block.children).toHaveLength(2);
      const [value, label] = Array.from(block.children) as HTMLElement[];
      expect(getComputedStyle(block).display).toBe("flex");
      expect(getComputedStyle(block).flexDirection).toBe("column");
      expect(getComputedStyle(block).gap).toBe(getComputedStyle(readyStat).gap);
      expect(value.textContent).toBe("—");
      for (const property of [...TYPE, "letterSpacing", "fontVariantNumeric"] as const) {
        expect(getComputedStyle(value)[property]).toBe(getComputedStyle(readyValue)[property]);
      }
      // The label line's own type, so its height is the label's; the sentence is not capitalised into capitals.
      for (const property of TYPE) {
        expect(getComputedStyle(label)[property]).toBe(getComputedStyle(readyLabel)[property]);
      }
      expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(label).overflow).toBe("hidden");
      expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
      expect(getComputedStyle(block).maxWidth).toBe("240px");
      // The exact status text is still there, and the whole of it is on hover when the line cuts it short.
      expect(screen.getByText(heading)).toBeTruthy();
      expect(screen.getByText(description)).toBeTruthy();
      expect(label.getAttribute("title")).toBe(`${heading} · ${description}`);
      expect(screen.queryByLabelText(/Replay PP|Full-map SR/)).toBeNull();
    },
  );
});

describe("the PP's own tooltip", () => {
  const withPeak: FullMapPerformance = { ...performance, peakPp: 251.239, fullComboPp: 312.5 };

  it("shows the peak PP and the PP of a full combo on hover and on focus", async () => {
    render(<FullMapPerformanceSummary performance={withPeak} metric="pp" />);
    const pp = screen.getByLabelText("Replay PP 234.57");
    expect(pp.getAttribute("tabindex")).toBe("0");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseOver(pp);
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Peak")).toBeTruthy();
    expect(within(tooltip).getByText("251.24")).toBeTruthy();
    expect(within(tooltip).getByText("If FC")).toBeTruthy();
    expect(within(tooltip).getByText("312.50")).toBeTruthy();
    // Two decimals with a pp unit after each value, and no sentence of explanation.
    expect(within(tooltip).getAllByText("pp")).toHaveLength(2);
    expect(tooltip.textContent).toBe("Peak251.24ppIf FC312.50pp");
    expect(within(tooltip).queryByText(/counts every miss/)).toBeNull();
    expect(within(tooltip).queryByText("This play")).toBeNull();
  });

  it("draws each value as a bar against the larger of the two", async () => {
    render(<FullMapPerformanceSummary performance={withPeak} metric="pp" />);
    fireEvent.mouseOver(screen.getByLabelText("Replay PP 234.57"));
    const tooltip = await screen.findByRole("tooltip");
    const widths = within(tooltip)
      .getAllByTestId("hover-card-bar")
      .map((bar) => Number.parseFloat(getComputedStyle(bar.firstElementChild as Element).width));
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeCloseTo((251.239 / 312.5) * 100, 3);
    expect(widths[1]).toBeCloseTo(100, 3);
  });

  it("shows only what it has", async () => {
    render(<FullMapPerformanceSummary performance={{ ...performance, peakPp: 251.239 }} metric="pp" />);
    fireEvent.mouseOver(screen.getByLabelText("Replay PP 234.57"));
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("251.24")).toBeTruthy();
    expect(within(tooltip).queryByText("If FC")).toBeNull();
    expect(within(tooltip).queryByText(/counts every miss/)).toBeNull();
    // One row compares nothing: no bar.
    expect(within(tooltip).queryByTestId("hover-card-bar")).toBeNull();
  });

  it("has no tooltip when there is neither", () => {
    render(<FullMapPerformanceSummary performance={performance} metric="pp" />);
    const pp = screen.getByLabelText("Replay PP 234.57");
    expect(pp.getAttribute("tabindex")).toBeNull();
    fireEvent.mouseOver(pp);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("how the tooltips look", () => {
  const card = (tooltip: HTMLElement) => tooltip.querySelector(".MuiTooltip-tooltip") as HTMLElement;

  it("puts the PP's extras on the shared hover card: near black, opaque, 2px corners, content width, an arrow in its colour", async () => {
    render(<FullMapPerformanceSummary performance={{ ...performance, peakPp: 251.239, fullComboPp: 312.5 }} metric="pp" />);
    fireEvent.mouseOver(screen.getByLabelText("Replay PP 234.57"));
    const tooltip = await screen.findByRole("tooltip");
    const style = getComputedStyle(card(tooltip));
    expect(style.backgroundColor).toBe("rgb(15, 16, 19)");
    expect(style.opacity === "" || style.opacity === "1").toBe(true);
    expect(style.borderRadius).toBe("2px");
    expect(style.padding).toBe("8px 11px 9px");
    expect(style.maxWidth).toBe("none");
    // An arrow of the card's own fill, not the default grey.
    const arrow = tooltip.querySelector(".MuiTooltip-arrow") as HTMLElement;
    expect(arrow).not.toBeNull();
    expect(getComputedStyle(arrow).color).toBe("rgb(15, 16, 19)");
    // Bright labels, white bold values, a bright unit.
    expect(getComputedStyle(within(tooltip).getByText("Peak")).color).toBe("rgb(226, 223, 217)");
    expect(getComputedStyle(within(tooltip).getByText("251.24")).color).toBe("rgb(255, 255, 255)");
    expect(getComputedStyle(within(tooltip).getByText("251.24")).fontWeight).toBe("600");
    expect(getComputedStyle(within(tooltip).getAllByText("pp")[0]).color).toBe("rgb(226, 223, 217)");
  });

  it("gives the SR breakdown the same card, with its parts as bars against the largest", async () => {
    render(<FullMapPerformanceSummary performance={performance} />);
    fireEvent.mouseOver(screen.getByLabelText("Full-map SR 7.19 stars"));
    const tooltip = await screen.findByRole("tooltip");
    expect(getComputedStyle(card(tooltip)).backgroundColor).toBe("rgb(15, 16, 19)");
    expect(getComputedStyle(tooltip.querySelector(".MuiTooltip-arrow") as HTMLElement).color).toBe("rgb(15, 16, 19)");
    expect(getComputedStyle(within(tooltip).getByText("Aim")).color).toBe("rgb(226, 223, 217)");
    // Two decimals, no unit, no star, no sentence.
    expect(tooltip.textContent).toBe("Aim3.93Speed1.99Reading1.27");
    expect(tooltip.querySelector("svg")).toBeNull();
    const widths = within(tooltip)
      .getAllByTestId("hover-card-bar")
      .map((bar) => Number.parseFloat(getComputedStyle(bar.firstElementChild as Element).width));
    expect(widths[0]).toBeCloseTo(100, 3);
    expect(widths[1]).toBeCloseTo((1.99 / 3.93) * 100, 3);
    expect(widths[2]).toBeCloseTo((1.27 / 3.93) * 100, 3);
  });

  it("adds Flashlight to the SR card only when it is above zero", async () => {
    render(
      <FullMapPerformanceSummary
        performance={{
          ...performance,
          breakdown: { total: 5.57, aim: 2.67, speed: 1.78, reading: 0.89, flashlight: 0.23, sliderAim: 0.53 },
        }}
      />,
    );
    fireEvent.mouseOver(screen.getByLabelText("Full-map SR 5.57 stars"));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe("Aim2.67Speed1.78Reading0.89Flashlight0.23");
    const widths = within(tooltip)
      .getAllByTestId("hover-card-bar")
      .map((bar) => Number.parseFloat(getComputedStyle(bar.firstElementChild as Element).width));
    expect(widths).toHaveLength(4);
    expect(widths[3]).toBeCloseTo((0.23 / 2.67) * 100, 3);
  });

  it("draws no bar when every part is zero", async () => {
    render(
      <FullMapPerformanceSummary
        performance={{
          ...performance,
          sr: 0,
          breakdown: { total: 0, aim: 0, speed: 0, reading: 0, flashlight: 0, sliderAim: 0 },
        }}
      />,
    );
    fireEvent.mouseOver(screen.getByLabelText("Full-map SR 0.00 stars"));
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).queryByTestId("hover-card-bar")).toBeNull();
    expect(tooltip.textContent).toBe("Aim0.00Speed0.00Reading0.00");
  });

  it("sets the unavailable breakdown on the same surface", async () => {
    render(<FullMapPerformanceSummary performance={{ status: "ready", pp: 0, sr: 0, description: "Zero" }} />);
    fireEvent.mouseOver(screen.getByLabelText("Full-map SR 0.00 stars"));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toBe("SR breakdown unavailable");
    expect(getComputedStyle(card(tooltip)).backgroundColor).toBe("rgb(15, 16, 19)");
  });
});
