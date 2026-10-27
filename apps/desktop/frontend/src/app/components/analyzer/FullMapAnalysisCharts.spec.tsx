import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { FullMapMarks } from "../../services/analysis/full-map-analysis-view-model";
import { REWIND_COLORS } from "../../styles/tokens";
import { AverageUrOverTimeChart, FULL_MAP_TIMING_COLORS, TimingOverTimeChart } from "./FullMapAnalysisCharts";
import { TIMELINE_MARKS } from "./timeline-markers";

function useViewBoxPointerCoordinates(element: Element, width: number, height: number) {
  jest.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    toJSON: () => ({}),
  });
}

function firePointerEvent(
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerleave",
  clientX: number,
  pointerType: "mouse" | "touch" = "mouse",
  clientY = 0,
) {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(element, event);
}

describe("Full-map analysis charts", () => {
  it("renders long timing and UR series without expanding them into function arguments", () => {
    const samples = Array.from({ length: 150_000 }, (_, index) => ({ time: index * 10, offsetMs: (index % 11) - 5 }));
    const points = samples.map(({ time }) => ({ time, unstableRate: 80, sampleCount: 50 }));
    const { container } = render(
      <>
        <TimingOverTimeChart samples={samples} duration={1_500_000} hitWindows={[]} />
        <AverageUrOverTimeChart points={points} duration={1_500_000} overallUr={80} />
      </>,
    );
    expect(screen.getByTestId("timing-sample-line").getAttribute("d")).toContain("L");
    expect(screen.getByTestId("average-ur-line").getAttribute("d")).toContain("L");
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("reuses timing series work while moving selection, and recomputes when data changes", () => {
    let reads = 0;
    const samples = Array.from({ length: 300 }, (_, index) => ({
      time: index * 10,
      get offsetMs() {
        reads++;
        return index % 7;
      },
    }));
    const windows: [] = [];
    const { rerender } = render(<TimingOverTimeChart samples={samples} duration={3_000} hitWindows={windows} />);
    const chart = screen.getByRole("img", { name: "Timing error over time" });
    reads = 0;
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(reads).toBeLessThan(50);
    rerender(<TimingOverTimeChart samples={[{ time: 20, offsetMs: -19 }]} duration={3_000} hitWindows={windows} />);
    fireEvent.blur(chart);
    fireEvent.focus(chart);
    expect(screen.getByRole("tooltip", { name: "Timing error -19.0ms at 0:00" })).toBeTruthy();
  });

  it("reuses UR series work while moving selection", () => {
    let reads = 0;
    const points = Array.from({ length: 300 }, (_, index) => ({
      time: index * 10,
      sampleCount: 50,
      get unstableRate() {
        reads++;
        return 80;
      },
    }));
    render(<AverageUrOverTimeChart points={points} duration={3_000} overallUr={80} />);
    const chart = screen.getByRole("img", { name: "Average unstable rate over time" });
    reads = 0;
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(reads).toBeLessThan(50);
  });

  it.each([
    [-120, 120],
    [110, 120],
    [-120, -110],
  ])("keeps timing extrema %p / %p outside the line and inside the SVG", (early, late) => {
    render(
      <TimingOverTimeChart
        samples={[
          { time: 41, offsetMs: early },
          { time: 1_000, offsetMs: late },
        ]}
        duration={1_000}
        hitWindows={[]}
      />,
    );
    const earlyLabel = screen.getByLabelText(/^Earliest hit/).querySelector("text") as SVGTextElement;
    const lateLabel = screen.getByLabelText(/^Latest hit/).querySelector("text") as SVGTextElement;
    const path = screen.getByTestId("timing-sample-line").getAttribute("d") ?? "";
    const curveYs = Array.from(path.matchAll(/[ML][\d.]+,([\d.]+)/g), (match) => Number(match[1]));
    const earlyY = Number(earlyLabel.getAttribute("y"));
    const lateY = Number(lateLabel.getAttribute("y"));
    expect(earlyY + 5).toBeLessThan(Math.min(...curveYs));
    const annotationFont = Number(earlyLabel.getAttribute("font-size"));
    expect(annotationFont).toBe(14);
    expect(lateY - annotationFont).toBeGreaterThan(Math.max(...curveYs));
    expect(earlyY - annotationFont).toBeGreaterThanOrEqual(0);
    // Inside the plot, 8px above its bottom edge (212): nothing is drawn under the time labels.
    expect(lateY).toBe(212 - 8);
    const earlyWidth = (earlyLabel.textContent?.length ?? 0) * Number(earlyLabel.getAttribute("font-size")) * 0.65;
    const earlyLeft =
      Number(earlyLabel.getAttribute("x")) - (earlyLabel.getAttribute("text-anchor") === "middle" ? earlyWidth / 2 : 0);
    expect(earlyLeft).toBeGreaterThanOrEqual(80 + 60);
  });

  it.each(["current", "average"] as const)(
    "keeps %s UR peak labels above the curve with a solid leader to the actual label, including both edges",
    (mode) => {
      const points = [0, 1_000, 2_000].map((time) => ({ time, unstableRate: 198.2, sampleCount: 3 }));
      for (const peak of points) {
        const { container, unmount } = render(
          <AverageUrOverTimeChart points={points} duration={2_000} overallUr={198.2} mode={mode} peak={peak} />,
        );
        const label = screen.getByTestId(`peak-${mode === "current" ? "current" : "average"}-ur-value`);
        const marker = label.parentElement?.querySelector("circle");
        const leader = label.parentElement?.querySelector("line");
        const labelY = Number(label.getAttribute("y"));
        const labelX = Number(label.getAttribute("x"));
        const fontSize = Number(label.getAttribute("font-size"));
        const labelHalfWidth = ((label.textContent?.length ?? 0) * fontSize * 0.65) / 2;
        const curve = container.querySelector(`[data-testid="${mode === "current" ? "current" : "average"}-ur-line"]`);
        const curveYValues = Array.from((curve?.getAttribute("d") ?? "").matchAll(/[ML][\d.]+,([\d.]+)/g), (match) =>
          Number(match[1]),
        );

        expect(labelY - fontSize).toBeGreaterThanOrEqual(0);
        expect(labelY + 5).toBeLessThanOrEqual(Math.min(...curveYValues) - 10);
        expect(labelY).toBeLessThan(Number(marker?.getAttribute("cy")) - 10);
        expect(labelX - labelHalfWidth).toBeGreaterThanOrEqual(80);
        expect(labelX + labelHalfWidth).toBeLessThanOrEqual(1784);
        expect(Number(leader?.getAttribute("x1"))).toBe(Number(marker?.getAttribute("cx")));
        expect(Number(leader?.getAttribute("y1"))).toBe(Number(marker?.getAttribute("cy")));
        expect(Number(leader?.getAttribute("x2"))).toBe(labelX);
        expect(Number(leader?.getAttribute("y2"))).toBe(labelY + 6);
        expect(leader?.getAttribute("stroke-dasharray")).toBeNull();
        expect(leader?.getAttribute("stroke-opacity")).toBe("0.4");
        if (peak.time === 0 || peak.time === 2_000) {
          expect(Number(leader?.getAttribute("x2"))).not.toBe(Number(leader?.getAttribute("x1")));
        }
        unmount();
      }
    },
  );

  it.each(["current", "average"] as const)(
    "starts %s UR at its first valid sample while retaining the timing object's start and raw timestamps",
    (mode) => {
      render(
        <>
          <TimingOverTimeChart
            samples={[
              { time: 4_970, offsetMs: -30 },
              { time: 10_000, offsetMs: 20 },
              { time: 15_030, offsetMs: 30 },
            ]}
            startTime={5_000}
            duration={15_000}
            hitWindows={[]}
          />
          <AverageUrOverTimeChart
            mode={mode}
            points={[
              { time: 7_000, unstableRate: 80, sampleCount: 2 },
              { time: 15_030, unstableRate: 90, sampleCount: 3 },
            ]}
            startTime={5_000}
            duration={15_000}
            overallUr={90}
          />
        </>,
      );
      const timingChart = screen.getByRole("img", { name: "Timing error over time" });
      const urChart = screen.getByRole("img", {
        name: mode === "average" ? "Average unstable rate over time" : "Unstable rate over time",
      });
      expect(within(timingChart).getByText("0:05").getAttribute("x")).toBe("80");
      expect(within(urChart).getByText("0:07").getAttribute("x")).toBe("80");
      expect(within(urChart).queryByText("0:05")).toBeNull();
      for (const chart of [timingChart, urChart]) {
        expect(within(chart).getByText("0:15")).toBeTruthy();
        expect(within(chart).queryByText("0:00")).toBeNull();
      }
      expect(within(timingChart).getByTestId("timing-sample-line").getAttribute("d")).toMatch(
        /^M80\.00,[\d.]+ L932\.00,[\d.]+ L1784\.00,/,
      );
      expect(within(urChart).getByTestId(`${mode}-ur-line`).getAttribute("d")).toMatch(
        /^M80\.00,[\d.]+ L1784\.00,[\d.]+$/,
      );
      expect(within(urChart).queryByTestId(`${mode}-ur-point`)).toBeNull();

      fireEvent.focus(timingChart);
      expect(screen.getByRole("tooltip", { name: "Timing error -30.0ms at 0:04" })).toBeTruthy();
      fireEvent.blur(timingChart);
      fireEvent.focus(urChart);
      expect(
        screen.getByRole("tooltip", {
          name:
            mode === "average"
              ? "Average unstable rate 80.0 through 2 hits at 0:07"
              : "Unstable rate 80.0 over the last 2 hits at 0:07",
        }),
      ).toBeTruthy();
    },
  );

  it.each(["current", "average"] as const)(
    "selects the earliest sorted valid %s UR point without inventing observations",
    (mode) => {
      const points = [
        { time: 12_000, unstableRate: 80, sampleCount: 4 },
        { time: 1_000, unstableRate: 60, sampleCount: 1 },
        { time: 2_000, unstableRate: Number.NaN, sampleCount: 2 },
        { time: 3_000, unstableRate: -10, sampleCount: 2 },
        { time: 4_000, unstableRate: Number.POSITIVE_INFINITY, sampleCount: 2 },
        { time: 5_000, unstableRate: 60, sampleCount: Number.NaN },
        { time: Number.NaN, unstableRate: 60, sampleCount: 2 },
        { time: Number.POSITIVE_INFINITY, unstableRate: 60, sampleCount: 2 },
        { time: -100, unstableRate: 60, sampleCount: 2 },
        { time: 10_000, unstableRate: 40, sampleCount: 3 },
        { time: 7_500, unstableRate: 0, sampleCount: 2 },
      ];
      const originalPoints = points.map((point) => ({ ...point }));
      const { container } = render(
        <AverageUrOverTimeChart mode={mode} points={points} startTime={1_000} duration={15_000} overallUr={80} />,
      );
      const chart = screen.getByRole("img", {
        name: mode === "average" ? "Average unstable rate over time" : "Unstable rate over time",
      });
      expect(within(chart).getByText("0:07").getAttribute("x")).toBe("80");
      expect(within(chart).queryByText("0:01")).toBeNull();
      expect(within(chart).getByTestId(`${mode}-ur-line`).getAttribute("d")).toBe(
        "M80.00,212.00 L648.00,141.60 L1102.40,71.20",
      );
      fireEvent.focus(chart);
      expect(
        screen.getByRole("tooltip", {
          name:
            mode === "average"
              ? "Average unstable rate 0.0 through 2 hits at 0:07"
              : "Unstable rate 0.0 over the last 2 hits at 0:07",
        }),
      ).toBeTruthy();
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      expect(
        screen.getByRole("tooltip", {
          name:
            mode === "average"
              ? "Average unstable rate 40.0 through 3 hits at 0:10"
              : "Unstable rate 40.0 over the last 3 hits at 0:10",
        }),
      ).toBeTruthy();
      expect(points).toEqual(originalPoints);
      expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    },
  );

  it.each(["current", "average"] as const)(
    "keeps single and empty %s UR data finite, and draws no time axis when no valid point exists",
    (mode) => {
      const { container, rerender } = render(
        <AverageUrOverTimeChart
          mode={mode}
          points={[{ time: 5_000, unstableRate: 80, sampleCount: 2 }]}
          startTime={1_000}
          duration={5_000}
          overallUr={80}
        />,
      );
      const getChart = () =>
        screen.getByRole("img", {
          name: mode === "average" ? "Average unstable rate over time" : "Unstable rate over time",
        });
      let chart = getChart();
      expect(within(chart).getByText("0:05").getAttribute("x")).toBe("80");
      expect(within(chart).getByTestId(`${mode}-ur-line`).getAttribute("d")).toBe("M80.00,71.20");
      expect(within(chart).queryByText("0:01")).toBeNull();
      expect(container.innerHTML).not.toMatch(/NaN|Infinity/);

      for (const points of [[], [{ time: 0, unstableRate: 40, sampleCount: 1 }]]) {
        rerender(
          <AverageUrOverTimeChart mode={mode} points={points} startTime={1_000} duration={5_000} overallUr={null} />,
        );
        chart = getChart();
        // Nothing is plotted, so no scale is drawn, whatever start the object gave.
        expect(within(chart).queryByText("0:01")).toBeNull();
        expect(chart.querySelectorAll("text")).toHaveLength(1);
        expect(within(chart).queryByTestId(`${mode}-ur-line`)).toBeNull();
        expect(within(chart).getByText(mode === "average" ? "No average UR samples" : "No UR samples")).toBeTruthy();
        expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
      }
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 2_000, 1_000])(
    "keeps an invalid or zero-span start %p finite",
    (startTime) => {
      const { container } = render(
        <>
          <TimingOverTimeChart
            samples={[{ time: 1_000, offsetMs: 10 }]}
            startTime={startTime}
            duration={1_000}
            hitWindows={[]}
          />
          <AverageUrOverTimeChart
            points={[{ time: 1_000, unstableRate: 80, sampleCount: 2 }]}
            startTime={startTime}
            duration={1_000}
            overallUr={80}
          />
        </>,
      );
      expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
      if (Number.isFinite(startTime) && startTime >= 1_000) {
        for (const name of ["Timing error over time", "Average unstable rate over time"]) {
          const chart = screen.getByRole("img", { name });
          expect(within(chart).getAllByText("0:01")).toHaveLength(1);
          expect(within(chart).queryByText("0:00")).toBeNull();
        }
      }
    },
  );

  it("plots real timing samples with Early above, Late below, full-height windows, and no density chart", () => {
    const { container } = render(
      <TimingOverTimeChart
        samples={[
          { time: 1_000, offsetMs: -30 },
          { time: 2_000, offsetMs: Number.NaN },
          { time: 3_000, offsetMs: 45 },
        ]}
        duration={4_000}
        hitWindows={[
          { radiusMs: 35, label: "300" },
          { radiusMs: 60, label: "100" },
          { radiusMs: 80, label: "50" },
        ]}
      />,
    );

    const chart = screen.getByRole("img", { name: "Timing error over time" });
    expect(chart).toBeTruthy();
    expect(chart.getAttribute("viewBox")).toBe("0 0 1840 230");
    expect(chart.style.height).toBe("230px");
    expect(chart.style.minHeight).toBe("180px");
    expect(screen.getByText("Early")).toBeTruthy();
    expect(screen.getByText("Late")).toBeTruthy();
    expect(screen.getByText("Early").getAttribute("fill")).toBe(FULL_MAP_TIMING_COLORS.EARLY);
    expect(screen.getByText("Late").getAttribute("fill")).toBe(FULL_MAP_TIMING_COLORS.LATE);
    expect(screen.queryByText("Perfect")).toBeNull();
    expect(screen.getByText("-30ms")).toBeTruthy();
    expect(screen.getByText("+45ms")).toBeTruthy();
    expect(screen.queryByText("LOW")).toBeNull();
    expect(screen.queryByText("MEDIUM")).toBeNull();
    expect(screen.queryByText("HIGH")).toBeNull();
    expect(container.querySelector('[data-testid="timing-sample-line"]')).toBeTruthy();
    const windowBands = Array.from(container.querySelectorAll('[data-testid="timing-window-band"]'));
    expect(windowBands).toHaveLength(5);
    expect(windowBands.map((band) => band.getAttribute("data-window-label"))).toEqual([
      "300",
      "100",
      "100",
      "50",
      "50",
    ]);
    expect(windowBands.every((band) => Number(band.getAttribute("fill-opacity")) <= 0.1)).toBe(true);
    // The windows are the Timing panel's strip colours.
    expect(windowBands.map((band) => band.getAttribute("fill"))).toEqual([
      REWIND_COLORS.hitWindow300,
      REWIND_COLORS.hitWindow100,
      REWIND_COLORS.hitWindow100,
      REWIND_COLORS.hitWindow50,
      REWIND_COLORS.hitWindow50,
    ]);
    const windowLabels = Array.from(container.querySelectorAll('[data-testid="timing-window-label"]'));
    expect(windowLabels.map((label) => label.textContent)).toEqual(["300", "100", "100", "50", "50"]);
    const greatLabel = within(chart).getByText("300");
    expect(greatLabel.getAttribute("y")).toBe("124");
    expect(greatLabel.getAttribute("dominant-baseline")).toBe("middle");
    expect(new Set(windowLabels.map((label) => label.getAttribute("font-size")))).toEqual(new Set(["14"]));
    const plotArea = container.querySelector('[data-testid="timing-plot-area"]') as SVGRectElement;
    const plotEdge = Number(plotArea.getAttribute("x")) + Number(plotArea.getAttribute("width"));
    expect(windowLabels.every((label) => Number(label.getAttribute("x")) > plotEdge)).toBe(true);
    expect(new Set(windowLabels.map((label) => label.getAttribute("text-anchor")))).toEqual(new Set(["start"]));
    expect(chart.querySelectorAll("line[stroke-dasharray]")).toHaveLength(0);

    expect(plotArea.getAttribute("y")).toBe("36");
    expect(plotArea.getAttribute("height")).toBe("176");
    expect(screen.queryByText(/Hit density/i)).toBeNull();
    expect(screen.queryByTestId("hit-density-bin")).toBeNull();
    expect((container.querySelector('[data-testid="timing-interaction-layer"]') as SVGElement).style.touchAction).toBe(
      "pan-y",
    );

    useViewBoxPointerCoordinates(chart, 1_600, 390);
    firePointerEvent(chart, "pointermove", 1_200, "mouse", 120);
    expect(screen.getByRole("tooltip", { name: "Timing error +45.0ms at 0:03" })).toBeTruthy();
    expect(chart.querySelectorAll("line[stroke-dasharray]")).toHaveLength(0);

    firePointerEvent(chart, "pointermove", 620, "mouse", 340);
    expect(screen.getByRole("tooltip", { name: "Timing error -30.0ms at 0:01" })).toBeTruthy();
    expect(screen.queryByRole("tooltip", { name: /Hit density/i })).toBeNull();
    fireEvent.pointerOut(chart, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(chart);
    expect(screen.getByRole("tooltip", { name: "Timing error -30.0ms at 0:01" })).toBeTruthy();
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByRole("tooltip", { name: "Timing error +45.0ms at 0:03" })).toBeTruthy();
    fireEvent.keyDown(chart, { key: "ArrowDown" });
    expect(screen.getByRole("tooltip", { name: "Timing error +45.0ms at 0:03" })).toBeTruthy();
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByRole("tooltip", { name: "Timing error -30.0ms at 0:01" })).toBeTruthy();
    fireEvent.keyDown(chart, { key: "ArrowUp" });
    expect(screen.getByRole("tooltip", { name: "Timing error -30.0ms at 0:01" })).toBeTruthy();

    firePointerEvent(chart, "pointerdown", 430, "touch", 120);
    expect(screen.getByRole("tooltip", { name: "Timing error -30.0ms at 0:01" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("keeps edge extrema labels clear of their markers", () => {
    render(
      <TimingOverTimeChart
        samples={[
          { time: 0, offsetMs: -80 },
          { time: 4_000, offsetMs: 99 },
        ]}
        duration={4_000}
        hitWindows={[]}
      />,
    );

    const earlyAnnotation = screen.getByLabelText("Earliest hit -80ms");
    const lateAnnotation = screen.getByLabelText("Latest hit +99ms");
    const earlyMarker = earlyAnnotation.querySelector("circle");
    const earlyLabel = earlyAnnotation.querySelector("text");
    const lateMarker = lateAnnotation.querySelector("circle");
    const lateLabel = lateAnnotation.querySelector("text");

    expect(Number(earlyLabel?.getAttribute("x"))).toBeGreaterThanOrEqual(Number(earlyMarker?.getAttribute("cx")) + 8);
    expect(earlyLabel?.getAttribute("text-anchor")).toBe("start");
    expect(Number(lateLabel?.getAttribute("x"))).toBeLessThanOrEqual(Number(lateMarker?.getAttribute("cx")) - 8);
    // Inside the plot, 8px above its bottom edge, and beside the marker: the marker is at the bottom of the plot.
    expect(Number(lateLabel?.getAttribute("y"))).toBe(212 - 8);
    expect(lateLabel?.getAttribute("text-anchor")).toBe("end");
  });

  it.each([99, 100, 99.5, 119.25])(
    "fills the whole timing plot with the exact ±%p ms 50 window without extra vertical range",
    (radiusMs) => {
      render(
        <TimingOverTimeChart
          samples={[
            { time: 0, offsetMs: -radiusMs },
            { time: 1_000, offsetMs: radiusMs },
          ]}
          duration={1_000}
          hitWindows={[
            { radiusMs: radiusMs * 0.2, label: "300" },
            { radiusMs: radiusMs * 0.6, label: "100" },
            { radiusMs, label: "50" },
          ]}
        />,
      );

      const chart = screen.getByRole("img", { name: "Timing error over time" });
      const bands = screen.getAllByTestId("timing-window-band");
      expect(Math.min(...bands.map((band) => Number(band.getAttribute("y"))))).toBe(36);
      expect(
        Math.max(...bands.map((band) => Number(band.getAttribute("y")) + Number(band.getAttribute("height")))),
      ).toBe(212);
      expect(bands.reduce((sum, band) => sum + Number(band.getAttribute("height")), 0)).toBeCloseTo(176);
      expect(screen.getByTestId("timing-sample-line").getAttribute("d")).toBe("M80.00,36.00 L1784.00,212.00");
      expect(within(chart).getByText(`-${radiusMs}`).getAttribute("y")).toBe("40");
      expect(within(chart).getByText(`+${radiusMs}`).getAttribute("y")).toBe("216");

      const earlyLabel = screen.getByLabelText(/^Earliest hit/).querySelector("text") as SVGTextElement;
      const lateLabel = screen.getByLabelText(/^Latest hit/).querySelector("text") as SVGTextElement;
      const timeTick = within(chart).getByText("0:01");
      expect(Number(earlyLabel.getAttribute("y")) - 14).toBeGreaterThanOrEqual(0);
      expect(Number(earlyLabel.getAttribute("y")) + 5).toBeLessThan(36);
      // The latest hit's label is inside the plot, 8px above its bottom edge; the time labels hang from the plot.
      expect(lateLabel.getAttribute("y")).toBe("204");
      expect(timeTick.getAttribute("y")).toBe("226.5");
      expect(Number(lateLabel.getAttribute("y"))).toBeLessThan(Number(timeTick.getAttribute("y")) - 14);

      const labels = screen.getAllByTestId("timing-window-label");
      const sortedY = labels.map((label) => Number(label.getAttribute("y"))).sort((left, right) => left - right);
      expect(sortedY.slice(1).every((y, index) => y - sortedY[index] > 12)).toBe(true);
    },
  );

  it("clips outlier geometry at the real 50 window but preserves its raw value and timestamp for inspection", () => {
    render(
      <TimingOverTimeChart
        samples={[
          { time: 4_875, offsetMs: -125 },
          { time: 5_500, offsetMs: 0 },
          { time: 6_125, offsetMs: 125 },
        ]}
        startTime={5_000}
        duration={6_000}
        hitWindows={[
          { radiusMs: 20, label: "300" },
          { radiusMs: 60, label: "100" },
          { radiusMs: 100, label: "50" },
        ]}
      />,
    );

    const chart = screen.getByRole("img", { name: "Timing error over time" });
    const line = screen.getByTestId("timing-sample-line");
    expect(line.getAttribute("d")).toBe("M80.00,14.00 L932.00,124.00 L1784.00,234.00");
    const clippedSeries = screen.getByTestId("timing-clipped-series");
    expect(line.parentElement).toBe(clippedSeries);
    const clipId = clippedSeries.getAttribute("clip-path")?.match(/^url\(#(.+)\)$/)?.[1];
    expect(clipId).toBeTruthy();
    const clip = document.getElementById(clipId as string)?.querySelector("rect");
    expect(clip?.getAttribute("y")).toBe("36");
    expect(clip?.getAttribute("height")).toBe("176");
    expect(screen.queryByLabelText("Earliest hit -125ms")).toBeNull();
    expect(screen.queryByLabelText("Latest hit +125ms")).toBeNull();

    fireEvent.focus(chart);
    expect(
      screen.getByRole("tooltip", { name: "Timing error -125.0ms at 0:04, outside displayed hit window" }),
    ).toBeTruthy();
    fireEvent.keyDown(chart, { key: "End" });
    expect(
      screen.getByRole("tooltip", { name: "Timing error +125.0ms at 0:06, outside displayed hit window" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Hit density/i)).toBeNull();
  });

  it("uses a finite sample-derived range when no valid hit window is available", () => {
    const { container } = render(
      <TimingOverTimeChart
        samples={[
          { time: 0, offsetMs: -250 },
          { time: 1_000, offsetMs: 250 },
        ]}
        duration={1_000}
        hitWindows={[
          { radiusMs: Number.NaN, label: "300" },
          { radiusMs: Number.POSITIVE_INFINITY, label: "100" },
          { radiusMs: 0, label: "50" },
        ]}
      />,
    );
    expect(screen.getByTestId("timing-sample-line").getAttribute("d")).toBe("M80.00,36.00 L1784.00,212.00");
    expect(screen.getByText("-250")).toBeTruthy();
    expect(screen.getByText("+250")).toBeTruthy();
    expect(screen.queryByTestId("timing-window-band")).toBeNull();
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("reserves enough left margin for fractional timing-axis labels without cutting off their sign", () => {
    render(
      <TimingOverTimeChart
        samples={[{ time: 1_000, offsetMs: 0 }]}
        duration={1_000}
        hitWindows={[{ radiusMs: 133.333333, label: "50" }]}
      />,
    );
    const chart = screen.getByRole("img", { name: "Timing error over time" });
    for (const value of ["-133.33", "-66.67", "0", "+66.67", "+133.33"]) {
      const label = within(chart).getByText(value);
      const rightEdge = Number(label.getAttribute("x"));
      const estimatedWidth = value.length * Number(label.getAttribute("font-size")) * 0.65;
      expect(label.getAttribute("text-anchor")).toBe("end");
      expect(rightEdge - estimatedWidth).toBeGreaterThanOrEqual(0);
      expect(rightEdge).toBeLessThan(80);
    }
  });

  it("keeps interior extrema labels outside the entire clipped plot when an outlier crosses behind them", () => {
    render(
      <TimingOverTimeChart
        samples={[
          { time: 0, offsetMs: 0 },
          { time: 1_000, offsetMs: -150 },
          { time: 2_000, offsetMs: 50 },
        ]}
        duration={2_000}
        hitWindows={[{ radiusMs: 99, label: "50" }]}
      />,
    );
    const earlyAnnotation = screen.getByLabelText("Earliest hit 0ms");
    const lateAnnotation = screen.getByLabelText("Latest hit +50ms");
    const earlyLabel = earlyAnnotation.querySelector("text") as SVGTextElement;
    const lateLabel = lateAnnotation.querySelector("text") as SVGTextElement;
    expect(Number(earlyAnnotation.querySelector("circle")?.getAttribute("cy"))).toBe(124);
    expect(Number(lateAnnotation.querySelector("circle")?.getAttribute("cy"))).toBeGreaterThan(124);
    expect(earlyLabel.getAttribute("y")).toBe("22");
    // The latest hit's label is inside the plot (8px above its bottom edge); the earliest hit's stays above it.
    expect(lateLabel.getAttribute("y")).toBe("204");
    expect(Number(earlyLabel.getAttribute("y")) + 5).toBeLessThan(36);
    const clippedSeries = screen.getByTestId("timing-clipped-series");
    expect(clippedSeries.contains(earlyAnnotation)).toBe(false);
    expect(clippedSeries.contains(lateAnnotation)).toBe(false);
    expect(screen.getByTestId("timing-sample-line").getAttribute("d")).toBe(
      "M80.00,124.00 L932.00,-9.33 L1784.00,168.44",
    );
  });

  it.each(["timing", "ur"] as const)(
    "keeps %s axes and tooltips readable in CSS pixels after resizing while preserving pointer selection",
    (kind) => {
      const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
      const observe = jest.fn();
      const disconnect = jest.fn();
      let notifyResize: (() => void) | undefined;
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        writable: true,
        value: jest.fn().mockImplementation((callback: () => void) => {
          notifyResize = callback;
          return { observe, disconnect, unobserve: jest.fn() };
        }),
      });
      let bounds = { x: 25, y: 50, top: 50, right: 1865, bottom: 440, left: 25, width: 1840, height: 390 };
      const boundingRect = jest.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
        ...bounds,
        toJSON: () => ({}),
      }));
      try {
        const { unmount } = render(
          kind === "timing" ? (
            <TimingOverTimeChart
              style={{ height: "100%" }}
              samples={[
                { time: 1_000, offsetMs: -10 },
                { time: 2_000, offsetMs: 20 },
                { time: 3_000, offsetMs: 30 },
              ]}
              startTime={1_000}
              duration={3_000}
              hitWindows={[{ radiusMs: 100, label: "50" }]}
            />
          ) : (
            <AverageUrOverTimeChart
              style={{ height: "100%" }}
              points={[
                { time: 1_000, unstableRate: 50, sampleCount: 2 },
                { time: 2_000, unstableRate: 70, sampleCount: 3 },
                { time: 3_000, unstableRate: 90, sampleCount: 4 },
              ]}
              startTime={1_000}
              duration={3_000}
              overallUr={90}
            />
          ),
        );
        const chart = screen.getByRole("img", {
          name: kind === "timing" ? "Timing error over time" : "Average unstable rate over time",
        });
        expect(observe).toHaveBeenCalledWith(chart);
        expect(chart.style.height).toBe("100%");
        expect(chart.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
        const triggerResize = () => notifyResize?.();

        for (const [width, height] of [
          [1440, 230],
          [1024, 180],
          [480, 230],
        ]) {
          bounds = { ...bounds, width, height, right: bounds.left + width, bottom: bounds.top + height };
          act(triggerResize);
          const viewBox = chart.getAttribute("viewBox")?.split(" ").map(Number) as number[];
          expect(viewBox[2]).toBe(width);
          expect(viewBox[3]).toBe(height);
          expect(viewBox[2] / viewBox[3]).toBeCloseTo(width / height);
          const layer = screen.getByTestId(
            kind === "timing" ? "timing-interaction-layer" : "average-ur-interaction-layer",
          );
          expect(Number(layer.getAttribute("x"))).toBe(80);
          expect(Number(layer.getAttribute("width"))).toBe(width - 136);
          const lastTick = within(chart).getByText("0:03");
          expect(Number(lastTick.getAttribute("x"))).toBe(width - 56);
          const renderedAxisFont = (Number(lastTick.getAttribute("font-size")) * height) / viewBox[3];
          expect(renderedAxisFont).toBe(12);

          const lastHitClientX = bounds.left + width - 56;
          firePointerEvent(chart, "pointermove", lastHitClientX, "mouse", bounds.top + height / 2);
          expect(
            screen.getByRole("tooltip", {
              name:
                kind === "timing"
                  ? "Timing error +30.0ms at 0:03"
                  : "Average unstable rate 90.0 through 4 hits at 0:03",
            }),
          ).toBeTruthy();
          const tooltip = screen.getByRole("tooltip");
          // The time, in 12px mono, is the first text; a card of one line is 34px tall.
          expect(Number(tooltip.querySelector("text")?.getAttribute("font-size"))).toBe(12);
          const tooltipBox = tooltip.querySelector("rect") as SVGRectElement;
          expect(Number(tooltipBox.getAttribute("height"))).toBe(34);
          expect(Number(tooltipBox.getAttribute("x"))).toBeGreaterThanOrEqual(80);
          expect(Number(tooltipBox.getAttribute("x")) + Number(tooltipBox.getAttribute("width"))).toBeLessThanOrEqual(
            width - 56,
          );
          fireEvent.pointerOut(chart, { pointerType: "mouse" });
        }
        unmount();
        expect(disconnect).toHaveBeenCalledTimes(1);
      } finally {
        boundingRect.mockRestore();
        if (previousObserver) Object.defineProperty(globalThis, "ResizeObserver", previousObserver);
        else Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    },
  );

  it("renders cumulative average UR points with hit sample counts and an accessible numeric peak", () => {
    const { container } = render(
      <AverageUrOverTimeChart
        points={[
          { time: 1_000, unstableRate: 55, sampleCount: 2 },
          { time: 2_000, unstableRate: 81.6, sampleCount: 3 },
          { time: 3_000, unstableRate: 95.2, sampleCount: 4 },
          { time: 4_000, unstableRate: Number.POSITIVE_INFINITY, sampleCount: 5 },
        ]}
        duration={4_000}
        overallUr={95.2}
        peak={{ time: 3_000, unstableRate: 95.2, sampleCount: 4 }}
      />,
    );

    const chart = screen.getByRole("img", { name: "Average unstable rate over time" });
    expect(chart).toBeTruthy();
    expect(chart.getAttribute("viewBox")).toBe("0 0 1840 230");
    expect(screen.queryByText("AVERAGE UR")).toBeNull();
    expect(within(chart).getAllByText("0:01")[0].getAttribute("font-size")).toBe("12");
    expect(within(chart).queryByText("0:00")).toBeNull();
    // The peak's callout, and the overall value beside the rule (the same number here).
    expect(screen.getByTestId("peak-average-ur-value").textContent).toBe("95.2");
    expect(screen.getByTestId("overall-ur-value").textContent).toBe("95.2");
    expect(screen.getAllByText("95.2")).toHaveLength(2);
    expect(screen.queryByText(/Peak UR/i)).toBeNull();
    expect(screen.getByLabelText("Highest average unstable rate 95.2 at 0:03")).toBeTruthy();
    const averageLine = container.querySelector('[data-testid="average-ur-line"]');
    expect(averageLine?.getAttribute("stroke")).toBe(REWIND_COLORS.textPrimary);
    expect(averageLine?.getAttribute("filter")).toBeNull();
    expect(chart.querySelector("linearGradient")).toBeNull();
    expect(
      (container.querySelector('[data-testid="average-ur-interaction-layer"]') as SVGElement).style.touchAction,
    ).toBe("pan-y");

    useViewBoxPointerCoordinates(chart, 1_600, 390);
    firePointerEvent(chart, "pointermove", 1_200);
    expect(screen.getByRole("tooltip", { name: "Average unstable rate 95.2 through 4 hits at 0:03" })).toBeTruthy();
    // The time at the left, the value and its unit at the right: no words about the series.
    expect(screen.getByRole("tooltip").textContent).toBe("0:0395.2UR");
    fireEvent.pointerOut(chart, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(chart);
    expect(screen.getByRole("tooltip", { name: "Average unstable rate 55.0 through 2 hits at 0:01" })).toBeTruthy();
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByRole("tooltip", { name: "Average unstable rate 81.6 through 3 hits at 0:02" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
  });

  it("renders rolling UR with local-window wording and mode-specific interaction hooks", () => {
    const { container } = render(
      <AverageUrOverTimeChart
        mode="current"
        points={[
          { time: 1_000, unstableRate: 55, sampleCount: 2 },
          { time: 2_000, unstableRate: 81.6, sampleCount: 50 },
        ]}
        duration={2_000}
        overallUr={72.4}
        peak={{ time: 2_000, unstableRate: 81.6, sampleCount: 50 }}
      />,
    );

    const chart = screen.getByRole("img", { name: "Unstable rate over time" });
    expect(screen.queryByText("OVERALL UR")).toBeNull();
    expect(screen.getByLabelText("Highest rolling unstable rate 81.6 at 0:02")).toBeTruthy();
    expect(container.querySelector('[data-testid="current-ur-line"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="average-ur-line"]')).toBeNull();
    expect(
      (container.querySelector('[data-testid="current-ur-interaction-layer"]') as SVGElement).style.touchAction,
    ).toBe("pan-y");

    fireEvent.focus(chart);
    expect(screen.getByRole("tooltip", { name: "Unstable rate 55.0 over the last 2 hits at 0:01" })).toBeTruthy();
    expect(screen.getByRole("tooltip").textContent).toBe("0:0155.0UR");
  });

  it.each([
    ["current", 8_000],
    ["average", 8_000],
    ["current", 7_990],
    ["average", 7_990],
  ] as const)("ends timing and %s UR at the last head time %p while retaining late observations", (mode, headTime) => {
    const lateHitTime = 8_020;
    const lateOffset = lateHitTime - headTime;
    const samples = Object.freeze([
      { time: 1_000, offsetMs: -20 },
      { time: 4_000, offsetMs: 0 },
      { time: lateHitTime, offsetMs: lateOffset },
    ]);
    const points = Object.freeze([
      { time: 4_000, unstableRate: 80, sampleCount: 2 },
      { time: lateHitTime, unstableRate: 90, sampleCount: 3 },
    ]);
    const { container } = render(
      <>
        <TimingOverTimeChart samples={samples} startTime={1_000} duration={headTime} hitWindows={[]} />
        <AverageUrOverTimeChart
          mode={mode}
          points={points}
          startTime={1_000}
          duration={headTime}
          overallUr={90}
          peak={points[1]}
        />
      </>,
    );

    const timingChart = screen.getByRole("img", { name: "Timing error over time" });
    const urChart = screen.getByRole("img", {
      name: mode === "average" ? "Average unstable rate over time" : "Unstable rate over time",
    });
    expect(within(timingChart).getByText("0:01").getAttribute("x")).toBe("80");
    expect(
      within(urChart)
        .getAllByText("0:04")
        .find((label) => label.getAttribute("text-anchor") === "start")
        ?.getAttribute("x"),
    ).toBe("80");
    const endLabel = headTime === 8_000 ? "0:08" : "0:07";
    for (const chart of [timingChart, urChart]) {
      expect(within(chart).getByText(endLabel).getAttribute("x")).toBe("1784");
      if (headTime < 8_000) expect(within(chart).queryByText("0:08")).toBeNull();
    }
    for (const line of [
      within(timingChart).getByTestId("timing-sample-line"),
      within(urChart).getByTestId(`${mode}-ur-line`),
    ]) {
      const xs = Array.from((line.getAttribute("d") ?? "").matchAll(/[ML]([\d.]+),/g), (match) => Number(match[1]));
      expect(xs[0]).toBe(80);
      expect(xs[xs.length - 1]).toBe(1784);
      expect(xs.every((x) => x >= 80 && x <= 1784)).toBe(true);
    }
    const peak = screen.getByLabelText(
      `Highest ${mode === "average" ? "average" : "rolling"} unstable rate 90.0 at 0:08`,
    );
    expect(peak.querySelector("circle")?.getAttribute("cx")).toBe("1784");

    fireEvent.focus(timingChart);
    fireEvent.keyDown(timingChart, { key: "End" });
    expect(screen.getByRole("tooltip", { name: `Timing error +${lateOffset.toFixed(1)}ms at 0:08` })).toBeTruthy();
    fireEvent.blur(timingChart);
    fireEvent.focus(urChart);
    fireEvent.keyDown(urChart, { key: "End" });
    expect(
      screen.getByRole("tooltip", {
        name:
          mode === "average"
            ? "Average unstable rate 90.0 through 3 hits at 0:08"
            : "Unstable rate 90.0 over the last 3 hits at 0:08",
      }),
    ).toBeTruthy();
    expect(samples[2]).toEqual({ time: 8_020, offsetMs: lateOffset });
    expect(points[1]).toEqual({ time: 8_020, unstableRate: 90, sampleCount: 3 });
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it.each([
    ["current", 0],
    ["average", 0],
    ["current", 5_000],
    ["average", 5_000],
  ] as const)(
    "honors an explicit degenerate endpoint %s / %p without expanding to later hit or UR times",
    (mode, headTime) => {
      const points = [
        { time: headTime + 20, unstableRate: 80, sampleCount: 2 },
        { time: headTime + 40, unstableRate: 90, sampleCount: 3 },
      ];
      const { container } = render(
        <>
          <TimingOverTimeChart
            samples={[
              { time: headTime + 20, offsetMs: 20 },
              { time: headTime + 40, offsetMs: 40 },
            ]}
            startTime={headTime}
            duration={headTime}
            hitWindows={[{ radiusMs: 100, label: "50" }]}
          />
          <AverageUrOverTimeChart
            mode={mode}
            points={points}
            startTime={headTime}
            duration={headTime}
            overallUr={90}
            peak={points[1]}
          />
        </>,
      );
      const timingChart = screen.getByRole("img", { name: "Timing error over time" });
      const urChart = screen.getByRole("img", {
        name: mode === "average" ? "Average unstable rate over time" : "Unstable rate over time",
      });
      const endpointLabel = headTime === 0 ? "0:00" : "0:05";
      for (const chart of [timingChart, urChart]) {
        const ticks = within(chart).getAllByText(endpointLabel);
        expect(ticks).toHaveLength(1);
        expect(ticks[0].getAttribute("x")).toBe("80");
      }
      expect(within(timingChart).getByTestId("timing-sample-line").getAttribute("d")).toBe(
        "M80.00,141.60 L80.00,159.20",
      );
      expect(within(urChart).getByTestId(`${mode}-ur-line`).getAttribute("d")).toBe("M80.00,71.20 L80.00,53.60");
      const peak = screen.getByLabelText(
        `Highest ${mode === "average" ? "average" : "rolling"} unstable rate 90.0 at ${endpointLabel}`,
      );
      expect(peak.querySelector("circle")?.getAttribute("cx")).toBe("80");

      fireEvent.focus(timingChart);
      fireEvent.keyDown(timingChart, { key: "End" });
      expect(screen.getByRole("tooltip", { name: `Timing error +40.0ms at ${endpointLabel}` })).toBeTruthy();
      fireEvent.blur(timingChart);
      fireEvent.focus(urChart);
      fireEvent.keyDown(urChart, { key: "End" });
      expect(
        screen.getByRole("tooltip", {
          name:
            mode === "average"
              ? `Average unstable rate 90.0 through 3 hits at ${endpointLabel}`
              : `Unstable rate 90.0 over the last 3 hits at ${endpointLabel}`,
        }),
      ).toBeTruthy();
      expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    },
  );

  it("renders explicit empty states without old timing-distribution content", () => {
    render(
      <>
        <TimingOverTimeChart samples={[]} duration={0} hitWindows={[]} />
        <AverageUrOverTimeChart points={[]} duration={0} overallUr={null} peak={null} />
      </>,
    );

    expect(screen.getByText("No valid timing samples")).toBeTruthy();
    expect(screen.getByText("No average UR samples")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Timing distribution" })).toBeNull();
    expect(screen.queryByText("Perfect")).toBeNull();
  });
});

type TimeChartKind = "timing" | "ur";
type TimeChartExtras = {
  marks?: FullMapMarks;
  onActivate?: (timeMs: number) => void;
  companion?: (timeMs: number) => { label: string; value: string; unit?: string } | undefined;
  empty?: boolean;
};

/** The same three moments in either chart, 1:00 to 5:00 of a map; the last hit lands after the chart's end. */
function timeChart(kind: TimeChartKind, { empty, ...extras }: TimeChartExtras = {}) {
  return kind === "timing" ? (
    <TimingOverTimeChart
      samples={
        empty
          ? []
          : [
              { time: 60_000, offsetMs: -10 },
              { time: 121_017, offsetMs: 20 },
              { time: 300_030, offsetMs: 30 },
            ]
      }
      startTime={60_000}
      duration={300_000}
      hitWindows={[{ radiusMs: 100, label: "50" }]}
      {...extras}
    />
  ) : (
    <AverageUrOverTimeChart
      mode="current"
      points={
        empty
          ? []
          : [
              { time: 60_000, unstableRate: 50, sampleCount: 2 },
              { time: 121_017, unstableRate: 70, sampleCount: 3 },
              { time: 300_030, unstableRate: 90, sampleCount: 4 },
            ]
      }
      startTime={60_000}
      duration={300_000}
      overallUr={72.4}
      {...extras}
    />
  );
}

const chartOf = (kind: TimeChartKind) =>
  screen.getByRole("img", { name: kind === "timing" ? "Timing error over time" : "Unstable rate over time" });
const plotAreaOf = (kind: TimeChartKind) =>
  screen.getByTestId(kind === "timing" ? "timing-plot-area" : "current-ur-plot-area");
const interactionLayerOf = (kind: TimeChartKind) =>
  screen.getByTestId(kind === "timing" ? "timing-interaction-layer" : "current-ur-interaction-layer");
const plotBottomOf = (kind: TimeChartKind) =>
  Number(plotAreaOf(kind).getAttribute("y")) + Number(plotAreaOf(kind).getAttribute("height"));

/** The marks of one kind, read back from its path: one closed box per mark. */
function markBoxes(path: Element) {
  return Array.from(
    (path.getAttribute("d") ?? "").matchAll(/M(-?[\d.]+),([\d.]+)h([\d.]+)v([\d.]+)h-[\d.]+z/g),
    (box) => ({
      x: Number(box[1]),
      y: Number(box[2]),
      width: Number(box[3]),
      height: Number(box[4]),
    }),
  );
}

/** The frame of `timeChart` at 1840 x 230: the plot is x 80..1784 and y 36..(212 - lane), the lane is 35 px tall. */
const LANE_HEIGHT = 35;
const LANE_BOTTOM = 212;

/** Where a map time falls in that frame: on its whole pixel, the mark centred on it. */
const markX = (time: number, width: number) => Math.round(80 + ((time - 60_000) / 240_000) * 1704) - width / 2;

describe("Full-map UR chart's overall value", () => {
  const urChart = (overallUr: number, unstableRates: number[] = [50, 70, 90]) => (
    <AverageUrOverTimeChart
      mode="current"
      points={unstableRates.map((unstableRate, index) => ({
        time: 60_000 + index * 120_000,
        unstableRate,
        sampleCount: 3,
      }))}
      startTime={60_000}
      duration={300_000}
      overallUr={overallUr}
    />
  );
  const overallLabel = () => screen.getByTestId("overall-ur-value");

  it("sits in the right margin at the rule's height, not on the graph", () => {
    render(urChart(72.4));
    const chart = chartOf("ur");
    const rule = chart.querySelector("line[stroke-dasharray]") as SVGLineElement;
    const overall = overallLabel();
    // The value only, 6px right of the plot's edge, centred on the rule.
    expect(overall.textContent).toBe("72.4");
    expect(within(chart).queryByText(/overall/i)).toBeNull();
    expect(overall.getAttribute("x")).toBe("1790");
    expect(overall.getAttribute("text-anchor")).toBe("start");
    expect(overall.getAttribute("y")).toBe(rule.getAttribute("y1"));
    expect(overall.getAttribute("dominant-baseline")).toBe("central");
    expect(overall.getAttribute("font-size")).toBe("12");
    expect(overall.getAttribute("fill")).toBe(REWIND_COLORS.textSecondary);
    // The rule itself ends at the plot, so nothing of the label is on it.
    expect(rule.getAttribute("x1")).toBe("80");
    expect(rule.getAttribute("x2")).toBe("1784");
    expect(rule.getAttribute("stroke-dasharray")).toBe("3 4");
    // Still named for assistive technology.
    expect(overall.getAttribute("aria-label")).toBe("Overall unstable rate 72.4");
    expect(within(chart).getByLabelText("Overall unstable rate 72.4")).toBe(overall);
  });

  it("fits inside the SVG with five and six characters, in the margin both charts share", () => {
    const { rerender } = render(urChart(184.1, [100, 184.1, 210]));
    const extent = () =>
      Number(overallLabel().getAttribute("x")) + (overallLabel().textContent?.length ?? 0) * 12 * 0.65;
    expect(overallLabel().textContent).toBe("184.1");
    expect(extent()).toBeLessThanOrEqual(1840);
    rerender(urChart(1234.5, [900, 1234.5, 1300]));
    expect(overallLabel().textContent).toBe("1234.5");
    expect(extent()).toBeLessThanOrEqual(1840);
  });

  it("keeps clear of the peak callout, even when the peak is the overall value at the plot edge", () => {
    const points = [0, 1_000, 2_000].map((time) => ({ time, unstableRate: 198.2, sampleCount: 3 }));
    render(
      <AverageUrOverTimeChart points={points} duration={2_000} overallUr={198.2} mode="current" peak={points[2]} />,
    );
    const peak = screen.getByTestId("peak-current-ur-value");
    const peakLabel = peak.textContent?.length ?? 0;
    // The callout is clamped inside the plot; the value starts 6px outside it.
    expect(Number(peak.getAttribute("x")) + (peakLabel * 14 * 0.65) / 2).toBeLessThanOrEqual(1784);
    expect(Number(overallLabel().getAttribute("x"))).toBeGreaterThanOrEqual(1784 + 6);
    expect(overallLabel().textContent).toBe("198.2");
  });

  it("stays clear of the peak callout when the overall value is at the very top of the plot", () => {
    const points = [0, 1_000, 2_000].map((time) => ({ time, unstableRate: 200, sampleCount: 3 }));
    render(
      <AverageUrOverTimeChart points={points} duration={2_000} overallUr={200} mode="current" peak={points[0]} />,
    );
    const peak = screen.getByTestId("peak-current-ur-value");
    // The rule runs along the top edge (y 36); the value is centred on it, in the margin, below the callout's line.
    expect(overallLabel().getAttribute("y")).toBe("36");
    expect(Number(overallLabel().getAttribute("y")) - 12 / 2).toBeGreaterThan(Number(peak.getAttribute("y")));
    expect(Number(overallLabel().getAttribute("x"))).toBeGreaterThan(Number(peak.getAttribute("x")));
  });

  it("is not drawn without a graph or without an overall value", () => {
    const { rerender } = render(<AverageUrOverTimeChart points={[]} duration={0} overallUr={80} />);
    expect(screen.queryByTestId("overall-ur-value")).toBeNull();
    rerender(urChart(Number.NaN));
    expect(screen.queryByTestId("overall-ur-value")).toBeNull();
  });
});

describe("Full-map hit-error chart's latest hit", () => {
  const chartWith = (offsetMs: number) => (
    <TimingOverTimeChart
      samples={[
        { time: 0, offsetMs: -10 },
        { time: 1_000, offsetMs },
        { time: 2_000, offsetMs: 0 },
      ]}
      duration={2_000}
      hitWindows={[{ radiusMs: 100, label: "50" }]}
    />
  );
  const annotation = () => screen.getByLabelText(/^Latest hit/);

  it("is centred under its point, with a leader down to it, when the point is well above the label", () => {
    render(chartWith(20));
    const marker = annotation().querySelector("circle") as SVGCircleElement;
    const label = annotation().querySelector("text") as SVGTextElement;
    const leader = annotation().querySelector("line") as SVGLineElement;
    expect(label.getAttribute("text-anchor")).toBe("middle");
    expect(label.getAttribute("x")).toBe(marker.getAttribute("cx"));
    expect(label.getAttribute("y")).toBe("204");
    // From the point down to the text's top, inside the plot.
    expect(Number(leader.getAttribute("y1"))).toBe(Number(marker.getAttribute("cy")));
    expect(Number(leader.getAttribute("y2"))).toBeGreaterThan(Number(leader.getAttribute("y1")));
    expect(Number(leader.getAttribute("y2"))).toBeLessThan(204 - 10);
  });

  it("moves beside its point when the point is at the label's height, so the text never sits on the marker", () => {
    // 99 ms of a 100 ms range: the point is 1px from the bottom of the plot, where the label stands.
    render(chartWith(99));
    const marker = annotation().querySelector("circle") as SVGCircleElement;
    const label = annotation().querySelector("text") as SVGTextElement;
    const leader = annotation().querySelector("line") as SVGLineElement;
    const x = Number(marker.getAttribute("cx"));
    expect(label.getAttribute("y")).toBe("204");
    expect(label.getAttribute("text-anchor")).not.toBe("middle");
    const anchor = label.getAttribute("text-anchor");
    expect(Number(label.getAttribute("x"))).toBe(anchor === "start" ? x + 10 : x - 10);
    // The leader stays in the plot and does not run through the text.
    expect(Number(leader.getAttribute("y2"))).toBeLessThanOrEqual(212);
    expect(Number(leader.getAttribute("y2"))).toBeLessThanOrEqual(204);
    expect(Number(leader.getAttribute("y2"))).toBeGreaterThanOrEqual(204 - 14);
  });
});

describe("Full-map time charts' shared frame", () => {
  it("gives both charts the same plot edges, with and without a lane", () => {
    const marks = { miss: [120_000], sliderBreak: [], ok: [], meh: [] };
    const edges = (kind: TimeChartKind) => {
      const area = plotAreaOf(kind);
      return ["x", "y", "width", "height"].map((name) => area.getAttribute(name));
    };
    const { rerender } = render(
      <>
        {timeChart("timing")}
        {timeChart("ur")}
      </>,
    );
    expect(edges("timing")).toEqual(["80", "36", "1704", "176"]);
    expect(edges("ur")).toEqual(edges("timing"));
    rerender(
      <>
        {timeChart("timing", { marks })}
        {timeChart("ur", { marks })}
      </>,
    );
    expect(edges("timing")).toEqual(["80", "36", "1704", "141"]);
    expect(edges("ur")).toEqual(edges("timing"));
  });
});

describe.each(["timing", "ur"] as const)("Full-map %s chart over the map", (kind) => {
  it("draws the map's marks in a lane under the plot, in the replay timeline's design", () => {
    const marks = { miss: [120_000], sliderBreak: [180_000], ok: [90_000, 150_000], meh: [210_000] };
    render(timeChart(kind, { marks }));
    const chart = chartOf(kind);
    const plotBottom = plotBottomOf(kind);
    // The lane is taken from the plot, and ends where the plot would have: 2px of air, the errors' 15, the 2px rail,
    // the 100s' and 50s' 14 and 2px of air.
    expect(plotAreaOf(kind).getAttribute("y")).toBe("36");
    expect(plotBottom).toBe(LANE_BOTTOM - LANE_HEIGHT);

    const lane = within(chart).getByTestId("map-marks-lane");
    expect(lane.getAttribute("aria-hidden")).toBe("true");
    const rail = within(lane).getByTestId("map-marks-rail");
    const railTop = Number(rail.getAttribute("y"));
    expect(rail.getAttribute("height")).toBe("2");
    // The replay timeline's rail: 2px of 13 % white.
    expect(rail.getAttribute("fill")).toBe("rgba(255, 255, 255, 0.13)");
    expect(railTop).toBe(plotBottom + 2 + TIMELINE_MARKS.miss.height);
    expect(railTop + 2 + TIMELINE_MARKS.meh.height + 2).toBe(LANE_BOTTOM);
    expect(rail.getAttribute("x")).toBe("80");
    expect(rail.getAttribute("width")).toBe("1704");

    for (const [name, color, above] of [
      ["miss", REWIND_COLORS.judgementMiss, true],
      ["sliderBreak", REWIND_COLORS.sliderBreak, true],
      ["meh", REWIND_COLORS.judgement50, false],
      ["ok", REWIND_COLORS.judgement100, false],
    ] as const) {
      const path = within(lane).getByTestId(`map-marks-${name}`);
      const boxes = markBoxes(path);
      const { width, height } = TIMELINE_MARKS[name];
      expect(path.getAttribute("fill")).toBe(color);
      expect(path.getAttribute("data-count")).toBe(String(marks[name].length));
      expect(boxes.map((box) => box.x)).toEqual(marks[name].map((time) => markX(time, width)));
      for (const box of boxes) {
        // The replay timeline's sizes. Errors end at the rail's top edge, 100s and 50s start at its bottom edge.
        expect([box.width, box.height]).toEqual([width, height]);
        expect(above ? box.y + box.height : box.y).toBe(above ? railTop : railTop + 2);
        expect(box.y).toBeGreaterThanOrEqual(plotBottom);
        expect(box.y + box.height).toBeLessThanOrEqual(LANE_BOTTOM);
      }
    }
    // Taller type first, shorter drawn on top: a miss never hides a slider break, a 50 never hides a 100.
    expect(Array.from(lane.querySelectorAll("path"), (path) => path.getAttribute("data-testid"))).toEqual([
      "map-marks-miss",
      "map-marks-sliderBreak",
      "map-marks-meh",
      "map-marks-ok",
    ]);
    // Full opacity, as on the replay page.
    for (const path of Array.from(lane.querySelectorAll("path"))) expect(path.getAttribute("fill-opacity")).toBeNull();
  });

  it("hangs the time labels from the bottom of the lane, or of the plot, each on a short tick", () => {
    const marks = { miss: [120_000], sliderBreak: [], ok: [], meh: [] };
    const { rerender } = render(timeChart(kind, { marks }));
    const chart = chartOf(kind);
    const names = ["1:00", "2:00", "3:00", "4:00", "5:00"];
    const xs = [80, 506, 932, 1358, 1784];
    for (const withMarks of [true, false]) {
      rerender(timeChart(kind, withMarks ? { marks } : {}));
      // The lane ends where the plot would have, so the labels do not move when a lane is added.
      expect(plotBottomOf(kind) + (withMarks ? LANE_HEIGHT : 0)).toBe(LANE_BOTTOM);
      const labels = names.map((name) => within(chart).getByText(name));
      for (const [index, label] of labels.entries()) {
        // The text's top is 6px under the edge: the baseline is a 12px figure's height (8.5px) lower.
        expect(label.getAttribute("y")).toBe(String(LANE_BOTTOM + 14.5));
        expect(label.getAttribute("x")).toBe(String(xs[index]));
        expect(label.getAttribute("font-size")).toBe("12");
        expect(label.getAttribute("fill")).toBe(REWIND_COLORS.textTertiary);
        expect(label.getAttribute("text-anchor")).toBe(index === 0 ? "start" : index === 4 ? "end" : "middle");
      }
      const ticks = within(chart).getAllByTestId("time-axis-tick");
      expect(ticks.map((tick) => Number(tick.getAttribute("x1")))).toEqual(xs);
      for (const tick of ticks) {
        expect(tick.getAttribute("x2")).toBe(tick.getAttribute("x1"));
        expect([tick.getAttribute("y1"), tick.getAttribute("y2")]).toEqual([
          String(LANE_BOTTOM),
          String(LANE_BOTTOM + 4),
        ]);
        expect(tick.getAttribute("stroke")).toBe(REWIND_COLORS.hairline);
        // The label starts below the tick.
        expect(Number(tick.getAttribute("y2"))).toBeLessThan(LANE_BOTTOM + 14.5 - 8.5);
      }
      // Inside the SVG, inside its edges, and clear of each other (the estimate the other label tests use).
      const extents = labels.map((label) => {
        const half = (label.textContent?.length ?? 0) * 12 * 0.65;
        const x = Number(label.getAttribute("x"));
        const anchor = label.getAttribute("text-anchor");
        return anchor === "start" ? [x, x + half] : anchor === "end" ? [x - half, x] : [x - half / 2, x + half / 2];
      });
      expect(extents[0][0]).toBeGreaterThanOrEqual(0);
      expect(extents[4][1]).toBeLessThanOrEqual(1840);
      for (let index = 1; index < extents.length; index++) {
        expect(extents[index][0]).toBeGreaterThan(extents[index - 1][1]);
      }
      expect(LANE_BOTTOM + 14.5 + 2).toBeLessThanOrEqual(230);
    }
  });

  it("makes the axis values 12px and tertiary, like the time labels", () => {
    render(timeChart(kind));
    const chart = chartOf(kind);
    const values = kind === "timing" ? ["-100", "-50", "0", "+50", "+100"] : ["0", "25", "50", "75", "100"];
    for (const value of values) {
      const label = within(chart).getByText(value);
      expect([label.getAttribute("font-size"), label.getAttribute("fill"), label.getAttribute("text-anchor")]).toEqual([
        "12",
        REWIND_COLORS.textTertiary,
        "end",
      ]);
      expect(Number(label.getAttribute("x"))).toBeLessThan(80);
    }
  });

  it("leaves the plot and labels where they were without marks", () => {
    const { rerender } = render(timeChart(kind));
    const chart = chartOf(kind);
    expect(within(chart).queryByTestId("map-marks-lane")).toBeNull();
    expect(plotAreaOf(kind).getAttribute("y")).toBe("36");
    expect(plotBottomOf(kind)).toBe(LANE_BOTTOM);
    const labelY = (text: string) => within(chart).getByText(text).getAttribute("y");
    const before = ["1:00", "5:00", ...(kind === "timing" ? ["Early"] : [])].map(labelY);
    const lateBefore = kind === "timing" ? Number(labelY("Late")) : 0;

    rerender(timeChart(kind, { marks: { miss: [], sliderBreak: [], ok: [], meh: [] } }));
    // An empty lane is still the lane: the page keeps one layout whatever the play was.
    expect(within(chart).getByTestId("map-marks-rail")).toBeTruthy();
    expect(plotBottomOf(kind)).toBe(LANE_BOTTOM - LANE_HEIGHT);
    // The time labels hang from the same line and Early keeps its place; Late rises with the plot's bottom edge.
    expect(["1:00", "5:00", ...(kind === "timing" ? ["Early"] : [])].map(labelY)).toEqual(before);
    if (kind === "timing") expect(Number(labelY("Late"))).toBe(lateBefore - LANE_HEIGHT);
  });

  it("pins marks outside the time range to the nearest edge and skips only times that are not numbers", () => {
    render(
      timeChart(kind, {
        marks: {
          miss: [59_999, 60_000, 300_000, 300_001, Number.NaN, Number.POSITIVE_INFINITY],
          sliderBreak: [],
          ok: [0, 900_000],
          meh: [],
        },
      }),
    );
    const miss = screen.getByTestId("map-marks-miss");
    // Every finite time counts: a miss on the opening notes is still a miss, even before the first plotted point.
    expect(miss.getAttribute("data-count")).toBe("4");
    expect(markBoxes(miss).map((box) => box.x)).toEqual([79, 1783]);
    const ok = screen.getByTestId("map-marks-ok");
    expect(ok.getAttribute("data-count")).toBe("2");
    expect(markBoxes(ok).map((box) => box.x)).toEqual([79.5, 1783.5]);
    for (const name of ["sliderBreak", "meh"]) expect(screen.queryByTestId(`map-marks-${name}`)).toBeNull();
    expect(chartOf(kind).innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("draws a long run of marks without expanding it into function arguments", () => {
    const ok = Array.from({ length: 150_000 }, (_, index) => 60_000 + index);
    render(timeChart(kind, { marks: { miss: [], sliderBreak: [], ok, meh: [] } }));
    const path = screen.getByTestId("map-marks-ok");
    expect(path.getAttribute("data-count")).toBe("150000");
    // Marks that share a pixel are one box, so the path is never longer than the plot is wide.
    const boxes = markBoxes(path);
    expect(boxes.length).toBeLessThanOrEqual(1705);
    expect(boxes[0].x).toBe(79.5);
    expect(boxes[boxes.length - 1].x).toBe(markX(209_999, 1));
  });

  it("opens the replay at the clicked point", () => {
    const onActivate = jest.fn();
    render(timeChart(kind, { onActivate }));
    const chart = chartOf(kind);
    // The plot is what opens the replay, so it is the plot that shows it: not the margins around it.
    expect(chart.style.cursor).toBe("");
    expect(interactionLayerOf(kind).style.cursor).toBe("pointer");
    useViewBoxPointerCoordinates(chart, 1840, 230);
    // The point nearest the pointer, with its own time: not the pixel's, and not clamped to the axis.
    fireEvent.click(interactionLayerOf(kind), { clientX: 520, clientY: 100 });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenLastCalledWith(121_017);
    firePointerEvent(chart, "pointerdown", 1_780, "mouse", 100);
    fireEvent.click(interactionLayerOf(kind), { clientX: 1_782, clientY: 101 });
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(onActivate).toHaveBeenLastCalledWith(300_030);
  });

  it("does not open the replay at the end of a drag, from a tap or from another button", () => {
    const onActivate = jest.fn();
    render(timeChart(kind, { onActivate }));
    const chart = chartOf(kind);
    useViewBoxPointerCoordinates(chart, 1840, 230);
    firePointerEvent(chart, "pointerdown", 500, "mouse", 100);
    fireEvent.click(chart, { clientX: 504, clientY: 100 });
    firePointerEvent(chart, "pointerdown", 500, "touch", 100);
    fireEvent.click(chart, { clientX: 500, clientY: 100 });
    // The tap still selects, as it did.
    expect(screen.getByRole("tooltip").getAttribute("aria-label")).toMatch(/at 2:01$/);
    fireEvent.click(chart, { clientX: 500, clientY: 100, button: 2 });
    expect(onActivate).not.toHaveBeenCalled();
    firePointerEvent(chart, "pointerdown", 500, "mouse", 100);
    fireEvent.click(chart, { clientX: 503, clientY: 100 });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("opens the replay only from the plot and its marks lane, not from the margins around them", () => {
    const onActivate = jest.fn();
    const marks = { miss: [120_000], sliderBreak: [], ok: [], meh: [] };
    const { rerender } = render(timeChart(kind, { onActivate, marks }));
    const chart = chartOf(kind);
    useViewBoxPointerCoordinates(chart, 1840, 230);
    // The plot is x 80..1784, y 36..177 and the lane is y 177..212 under it; the time labels start under y 218.
    for (const [clientX, clientY] of [
      [40, 100], // the value labels' gutter
      [1820, 100], // the right margin
      [520, 215], // a time label, under the lane
      [520, 20], // above the plot
    ]) {
      fireEvent.click(chart, { clientX, clientY });
    }
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.click(chart, { clientX: 520, clientY: 100 });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenLastCalledWith(121_017);
    fireEvent.click(chart, { clientX: 520, clientY: 180 });
    expect(onActivate).toHaveBeenCalledTimes(2);
    // The lane's rail answers with the plot's cursor, as the plot does.
    expect(within(chart).getByTestId("map-marks-hit-area").style.cursor).toBe("pointer");

    // Without a lane the plot runs down to y 212, and nothing below it opens the replay.
    onActivate.mockClear();
    rerender(timeChart(kind, { onActivate }));
    expect(within(chart).queryByTestId("map-marks-hit-area")).toBeNull();
    fireEvent.click(chart, { clientX: 520, clientY: 216 });
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.click(chart, { clientX: 520, clientY: 205 });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("opens the replay at the keyboard-selected point on Enter", () => {
    const onActivate = jest.fn();
    render(timeChart(kind, { onActivate }));
    const chart = chartOf(kind);
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenLastCalledWith(121_017);
    // Enter with nothing selected opens nothing.
    fireEvent.keyDown(chart, { key: "Escape" });
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("does nothing on click without `onActivate`", () => {
    render(timeChart(kind));
    const chart = chartOf(kind);
    expect(chart.style.cursor).toBe("");
    useViewBoxPointerCoordinates(chart, 1840, 230);
    firePointerEvent(chart, "pointermove", 520, "mouse", 100);
    const tooltip = screen.getByRole("tooltip").getAttribute("aria-label");
    fireEvent.click(interactionLayerOf(kind), { clientX: 520, clientY: 100 });
    fireEvent.keyDown(chart, { key: "Enter" });
    // Reading a value is all the chart does on its own.
    expect(screen.getByRole("tooltip").getAttribute("aria-label")).toBe(tooltip);
  });

  it("shows the empty state and no lane when there are no samples", () => {
    const onActivate = jest.fn();
    render(
      timeChart(kind, { empty: true, onActivate, marks: { miss: [120_000], sliderBreak: [], ok: [90_000], meh: [] } }),
    );
    const chart = chartOf(kind);
    expect(within(chart).getByText(kind === "timing" ? "No valid timing samples" : "No UR samples")).toBeTruthy();
    expect(within(chart).queryByTestId("map-marks-lane")).toBeNull();
    expect(within(chart).queryByTestId("map-marks-miss")).toBeNull();
    // With nothing drawn the plot keeps its full height.
    expect(plotBottomOf(kind)).toBe(LANE_BOTTOM);
    fireEvent.click(interactionLayerOf(kind), { clientX: 520, clientY: 100 });
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(onActivate).not.toHaveBeenCalled();
    expect(chart.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it("draws no axes, grid, window labels or Early / Late when there is nothing to plot", () => {
    render(timeChart(kind, { empty: true }));
    const chart = chartOf(kind);
    // The plot well and its one sentence: nothing that reads like a scale for data that is not there.
    expect(Array.from(chart.querySelectorAll("text"), (text) => text.textContent)).toEqual([
      kind === "timing" ? "No valid timing samples" : "No UR samples",
    ]);
    expect(chart.querySelectorAll("line")).toHaveLength(0);
    expect(within(chart).queryByTestId("timing-window-band")).toBeNull();
    expect(within(chart).getByTestId(kind === "timing" ? "timing-plot-area" : "current-ur-plot-area")).toBeTruthy();
    expect(chart.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it.each([true, false])(
    "draws the latest hit's label and leader inside the plot, 8px above its bottom edge (marks %p)",
    (withMarks) => {
      if (kind === "ur") return;
      render(timeChart(kind, withMarks ? { marks: { miss: [120_000], sliderBreak: [], ok: [], meh: [] } } : {}));
      const chart = chartOf(kind);
      const leader = chart.querySelector('g[aria-label^="Latest hit"] line') as SVGLineElement;
      const label = within(chart).getByText("+30ms");
      const bottom = plotBottomOf(kind);
      // Nothing of it is under the plot: not in the lane, between the lane and the time labels, or below them.
      expect(Number(leader.getAttribute("y2"))).toBeLessThanOrEqual(bottom);
      expect(Number(leader.getAttribute("y1"))).toBeLessThanOrEqual(bottom);
      expect(label.getAttribute("y")).toBe(String(bottom - 8));
      expect(Number(label.getAttribute("y")) - 14).toBeGreaterThanOrEqual(36);
    },
  );

  it("puts Early and Late inside the plot's left corners, whether or not there is a lane", () => {
    if (kind === "ur") return;
    const { rerender } = render(timeChart(kind));
    const chart = chartOf(kind);
    const top = 36;
    const early = () => within(chart).getByText("Early");
    const late = () => within(chart).getByText("Late");
    expect([early().getAttribute("x"), early().getAttribute("y")]).toEqual(["88", String(top + 16)]);
    expect([late().getAttribute("x"), late().getAttribute("y")]).toEqual(["88", String(plotBottomOf(kind) - 8)]);
    for (const label of [early(), late()]) expect(label.getAttribute("text-anchor")).toBe("start");
    rerender(timeChart(kind, { marks: { miss: [120_000], sliderBreak: [], ok: [], meh: [] } }));
    expect(late().getAttribute("y")).toBe(String(plotBottomOf(kind) - 8));
    expect(plotBottomOf(kind)).toBe(LANE_BOTTOM - LANE_HEIGHT);
    // Both are inside the plot, on top of its bands and its line.
    const line = chart.querySelector('[data-testid="timing-clipped-series"]') as Element;
    expect(line.compareDocumentPosition(early()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(late()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws nothing under the lane but the time labels and their ticks", () => {
    for (const marks of [undefined, { miss: [120_000], sliderBreak: [], ok: [], meh: [] }]) {
      const { unmount } = render(timeChart(kind, marks ? { marks } : {}));
      const chart = chartOf(kind);
      const below = Array.from(chart.querySelectorAll("text, line, circle, path")).filter((element) => {
        const y = Number(element.getAttribute("y") ?? element.getAttribute("y1") ?? element.getAttribute("cy"));
        // The axis values in the left margin may be as low as the plot's bottom edge.
        return y > LANE_BOTTOM && Number(element.getAttribute("x") ?? element.getAttribute("x1")) >= 80;
      });
      const names = below.map((element) => element.getAttribute("data-testid") ?? element.textContent);
      expect(names.sort()).toEqual(["1:00", "2:00", "3:00", "4:00", "5:00"].sort());
      unmount();
    }
  });

  it("is drawn in the page's type and colours, on an inset plot", () => {
    render(timeChart(kind));
    const chart = chartOf(kind);
    expect(chart.style.fontFamily).toContain("Geist");
    expect(chart.style.fontVariantNumeric).toBe("tabular-nums");
    expect(plotAreaOf(kind).getAttribute("fill")).toBe(REWIND_COLORS.inset);
    expect(plotAreaOf(kind).getAttribute("rx")).toBe("6");
    expect(within(chart).getByText("1:00").getAttribute("fill")).toBe(REWIND_COLORS.textTertiary);
    if (kind === "timing") return;
    const line = within(chart).getByTestId("current-ur-line");
    expect(line.getAttribute("stroke")).toBe(REWIND_COLORS.textPrimary);
    expect(line.getAttribute("stroke-width")).toBe("1.5");
    // The whole play's unstable rate: a dashed rule, its value beside the rule's right end.
    const rule = chart.querySelector("line[stroke-dasharray]") as SVGLineElement;
    const overall = within(chart).getByTestId("overall-ur-value");
    expect(rule.getAttribute("y1")).toBe(rule.getAttribute("y2"));
    expect(overall.textContent).toBe("72.4");
    expect(overall.getAttribute("fill")).toBe(REWIND_COLORS.textSecondary);
  });
});

describe("Full-map charts carry no native tooltip", () => {
  it.each([
    ["timing", "Timing error over time"],
    ["ur", "Unstable rate over time"],
  ] as const)("names the %s chart by aria-label and has no title element or attribute for the browser to show", (kind, name) => {
    const { container } = render(timeChart(kind, { marks: { miss: [120_000], sliderBreak: [], ok: [], meh: [] } }));
    const chart = screen.getByRole("img", { name });
    expect(chart.getAttribute("aria-label")).toBe(name);
    expect(container.querySelector("title")).toBeNull();
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    // The selected point's tooltip keeps its own name, and still no title anywhere.
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByRole("tooltip").getAttribute("aria-label")).toBeTruthy();
    expect(container.querySelector("title")).toBeNull();
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
  });

  it.each(["current", "average"] as const)("does the same for the %s unstable-rate series, empty or not", (mode) => {
    const { container, rerender } = render(
      <AverageUrOverTimeChart mode={mode} points={[]} duration={0} overallUr={null} />,
    );
    expect(container.querySelector("title")).toBeNull();
    rerender(
      <AverageUrOverTimeChart
        mode={mode}
        points={[{ time: 1_000, unstableRate: 80, sampleCount: 2 }]}
        duration={2_000}
        overallUr={80}
      />,
    );
    expect(container.querySelector("title")).toBeNull();
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
  });
});

describe("Full-map chart hover card", () => {
  const BRIGHT = "#e2dfd9";
  const textsOf = (tooltip: HTMLElement) => Array.from(tooltip.children).filter((child) => child.tagName === "text");
  const select = (kind: TimeChartKind) => {
    fireEvent.focus(chartOf(kind));
    fireEvent.keyDown(chartOf(kind), { key: "ArrowRight" });
    return screen.getByRole("tooltip");
  };

  it.each([
    ["ur", "2:01", "70.0", "UR"],
    ["timing", "2:01", "+20.0", "ms"],
  ] as const)("shows the %s value as the shared card: the time at the left, the value and unit at the right", (kind, time, value, unit) => {
    render(timeChart(kind));
    const tooltip = select(kind);
    // The shared card's look: near black, a 1px edge, 2px corners.
    const box = tooltip.querySelector("rect") as SVGRectElement;
    expect(box.getAttribute("fill")).toBe(REWIND_COLORS.inset);
    expect(box.getAttribute("stroke")).toBe("rgba(255,255,255,0.22)");
    expect(box.getAttribute("rx")).toBe("2");
    expect(box.getAttribute("height")).toBe("34");
    const [left, right] = textsOf(tooltip);
    expect(left.textContent).toBe(time);
    expect(left.getAttribute("font-family")).toContain("Geist Mono");
    expect([left.getAttribute("font-size"), left.getAttribute("font-weight"), left.getAttribute("fill")]).toEqual([
      "12",
      "500",
      BRIGHT,
    ]);
    const [number, small] = Array.from(right.querySelectorAll("tspan"));
    expect([number.textContent, number.getAttribute("font-size"), number.getAttribute("font-weight")]).toEqual([
      value,
      "13.5",
      "600",
    ]);
    expect(number.getAttribute("fill")).toBe("#ffffff");
    expect([small.textContent, small.getAttribute("font-size"), small.getAttribute("font-weight")]).toEqual([
      unit,
      "11.5",
      "400",
    ]);
    expect(small.getAttribute("fill")).toBe(BRIGHT);
    expect(right.getAttribute("text-anchor")).toBe("end");
    // Nothing but the time and the value.
    expect(tooltip.textContent).toBe(`${time}${value}${unit}`);
    expect(tooltip.textContent).not.toMatch(/hits|average|last/);
  });

  it("is as wide as its content, inside the plot", () => {
    const widthOf = (unstableRate: number) => {
      const { unmount } = render(
        <AverageUrOverTimeChart
          mode="current"
          points={[
            { time: 0, unstableRate, sampleCount: 5 },
            { time: 1_000, unstableRate, sampleCount: 5 },
          ]}
          duration={1_000}
          overallUr={unstableRate}
        />,
      );
      fireEvent.focus(screen.getByRole("img"));
      const width = Number((screen.getByRole("tooltip").querySelector("rect") as SVGRectElement).getAttribute("width"));
      unmount();
      return width;
    };
    const short = widthOf(9);
    const long = widthOf(1234.5);
    // Padding, the time, a 22px gap and the value with its unit, from a per-character estimate.
    expect(short).toBeGreaterThan(70);
    expect(short).toBeLessThan(130);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThanOrEqual(1704);
  });

  describe("with a companion measure", () => {
    const companion = jest.fn((_timeMs: number) => ({ label: "Hit error", value: "+31.0", unit: "ms" }));
    beforeEach(() => companion.mockClear());

    it("adds a second line: its label at the left, its value and unit at the right", () => {
      render(timeChart("ur", { companion }));
      expect(companion).not.toHaveBeenCalled();
      const tooltip = select("ur");
      expect(companion).toHaveBeenLastCalledWith(121_017);
      const box = tooltip.querySelector("rect") as SVGRectElement;
      expect(box.getAttribute("height")).toBe("56");
      const [, , label, right] = textsOf(tooltip);
      expect(label.textContent).toBe("Hit error");
      expect([label.getAttribute("font-size"), label.getAttribute("font-weight"), label.getAttribute("fill")]).toEqual([
        "12.5",
        "400",
        BRIGHT,
      ]);
      expect(label.getAttribute("font-family")).not.toContain("Mono");
      const [number, small] = Array.from(right.querySelectorAll("tspan"));
      expect([number.textContent, number.getAttribute("font-size"), number.getAttribute("fill")]).toEqual([
        "+31.0",
        "13.5",
        "#ffffff",
      ]);
      expect(small.textContent).toBe("ms");
      expect(tooltip.textContent).toBe("2:0170.0URHit error+31.0ms");
      // Both lines sit inside the card.
      const top = Number(box.getAttribute("y"));
      for (const text of textsOf(tooltip)) {
        expect(Number(text.getAttribute("y"))).toBeGreaterThan(top);
        expect(Number(text.getAttribute("y"))).toBeLessThan(top + 56);
      }
    });

    it("keeps the accessible name and appends the companion to it", () => {
      const { rerender } = render(timeChart("ur"));
      expect(select("ur").getAttribute("aria-label")).toBe("Unstable rate 70.0 over the last 3 hits at 2:01");
      fireEvent.blur(chartOf("ur"));
      rerender(timeChart("ur", { companion }));
      expect(select("ur").getAttribute("aria-label")).toBe(
        "Unstable rate 70.0 over the last 3 hits at 2:01, hit error +31.0 ms",
      );
    });

    it("names an unstable-rate companion under the hit-error graph", () => {
      render(
        timeChart("timing", { companion: () => ({ label: "Unstable rate", value: "152.2", unit: "UR" }) }),
      );
      const tooltip = select("timing");
      expect(tooltip.getAttribute("aria-label")).toBe("Timing error +20.0ms at 2:01, unstable rate 152.2");
      expect(tooltip.textContent).toBe("2:01+20.0msUnstable rate152.2UR");
    });

    it("draws one line when there is nothing to add at that point", () => {
      render(timeChart("timing", { companion: () => undefined }));
      const tooltip = select("timing");
      expect((tooltip.querySelector("rect") as SVGRectElement).getAttribute("height")).toBe("34");
      expect(tooltip.getAttribute("aria-label")).toBe("Timing error +20.0ms at 2:01");
    });

    it("calls it for the selected point only, and does not recompute the series when it changes", () => {
      let reads = 0;
      const points = Array.from({ length: 300 }, (_, index) => ({
        time: index * 10,
        sampleCount: 50,
        get unstableRate() {
          reads++;
          return 80;
        },
      }));
      const first = jest.fn(() => undefined);
      const { rerender } = render(
        <AverageUrOverTimeChart points={points} duration={3_000} overallUr={80} companion={first} />,
      );
      expect(first).not.toHaveBeenCalled();
      const chart = screen.getByRole("img", { name: "Average unstable rate over time" });
      fireEvent.focus(chart);
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      expect(first).toHaveBeenLastCalledWith(10);
      reads = 0;
      // A new function every render, as an inline arrow would be.
      rerender(<AverageUrOverTimeChart points={points} duration={3_000} overallUr={80} companion={() => undefined} />);
      rerender(<AverageUrOverTimeChart points={points} duration={3_000} overallUr={80} companion={() => undefined} />);
      expect(reads).toBeLessThan(50);
    });

    it("does the same under the hit-error graph", () => {
      let reads = 0;
      const samples = Array.from({ length: 300 }, (_, index) => ({
        time: index * 10,
        get offsetMs() {
          reads++;
          return index % 7;
        },
      }));
      const windows: [] = [];
      const { rerender } = render(
        <TimingOverTimeChart samples={samples} duration={3_000} hitWindows={windows} companion={jest.fn(() => undefined)} />,
      );
      const chart = screen.getByRole("img", { name: "Timing error over time" });
      fireEvent.focus(chart);
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      reads = 0;
      rerender(<TimingOverTimeChart samples={samples} duration={3_000} hitWindows={windows} companion={() => undefined} />);
      expect(reads).toBeLessThan(50);
    });
  });
});
