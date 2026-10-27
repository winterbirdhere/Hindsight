import { render, screen, within } from "@testing-library/react";
import type { FullMapAimPoint, FullMapAimScatter } from "../../services/analysis/full-map-aim-scatter";
import { REWIND_COLORS } from "../../styles/tokens";
import { FullMapAimPanel } from "./FullMapAimPanel";

const TERTIARY = "rgb(168, 165, 158)";

function scatter(overrides: Partial<FullMapAimScatter> = {}): FullMapAimScatter {
  const points: FullMapAimPoint[] = overrides.points ?? [
    { time: 1_000, x: -0.1, y: 0.2, verdict: "GREAT" },
    { time: 2_000, x: 0.3, y: -0.2, verdict: "GREAT" },
    { time: 3_000, x: 0.5, y: 0.1, verdict: "OK" },
    { time: 4_000, x: -0.4, y: 0.6, verdict: "MEH" },
  ];
  return {
    available: true,
    points,
    mean: { x: 0.075, y: 0.175 },
    omittedCount: 0,
    omittedMissCount: 0,
    misses: [],
    ...overrides,
  };
}

const plot = () => screen.getByRole("img", { name: /^Aim:/ });
const dots = (verdict: "GREAT" | "OK" | "MEH") => screen.getByTestId(`aim-dots-${verdict}`);
const rings = () => screen.getByTestId("aim-misses");

/** The name of the plot for a mean, from a scatter that has hits. */
function nameFor(mean: { x: number; y: number } | null): string {
  const { unmount } = render(<FullMapAimPanel aim={scatter({ mean })} />);
  const name = plot().getAttribute("aria-label") as string;
  unmount();
  return name;
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

it("names the panel with an AIM label and draws the plot in a square view box", () => {
  render(<FullMapAimPanel aim={scatter()} />);
  const panel = screen.getByRole("region", { name: "Aim" });
  const label = within(panel).getByRole("heading", { name: "AIM" });
  expect(getComputedStyle(label).fontFamily).toContain("Geist Mono");
  expect(getComputedStyle(label).fontSize).toBe("11px");
  expect(getComputedStyle(label).color).toBe(TERTIARY);
  expect(plot().getAttribute("viewBox")).toBe("-1.35 -1.35 2.7 2.7");
  // The circle's edge is at radius 1, on the inset disc.
  const edge = plot().querySelector("circle") as SVGCircleElement;
  expect(edge.getAttribute("r")).toBe("1");
  expect(edge.getAttribute("fill")).toBe("#0f1013");
  expect(edge.getAttribute("stroke")).toBe("rgba(255,255,255,0.45)");
  expect(edge.getAttribute("stroke-width")).toBe("1.5");
  expect(edge.getAttribute("vector-effect")).toBe("non-scaling-stroke");
});

it("draws one path per verdict, with its colour and its count, and no element per hit", () => {
  render(<FullMapAimPanel aim={scatter()} />);
  expect(dots("GREAT").getAttribute("data-count")).toBe("2");
  expect(dots("OK").getAttribute("data-count")).toBe("1");
  expect(dots("MEH").getAttribute("data-count")).toBe("1");
  expect(dots("GREAT").getAttribute("fill")).toBe("#7cc4f5");
  expect(dots("OK").getAttribute("fill")).toBe("#8fe8af");
  expect(dots("MEH").getAttribute("fill")).toBe("#f5cd6e");
  for (const verdict of ["GREAT", "OK", "MEH"] as const) {
    expect(dots(verdict).getAttribute("fill-opacity")).toBe("0.7");
  }
  // The 300s are first, so the rarer 100s and 50s are drawn over them.
  const order = Array.from(plot().querySelectorAll("[data-testid^='aim-dots-']")).map((path) =>
    path.getAttribute("data-testid"),
  );
  expect(order).toEqual(["aim-dots-GREAT", "aim-dots-OK", "aim-dots-MEH"]);
  // Two discs for the two 300s: a move, and two arcs, each.
  expect((dots("GREAT").getAttribute("d") as string).match(/M/g)).toHaveLength(2);
  expect(dots("GREAT").getAttribute("d")).toContain("M-0.122 0.200");
  expect(dots("GREAT").getAttribute("d")).toContain("M0.278 -0.200");
});

it("draws ten thousand hits as three paths", () => {
  const points: FullMapAimPoint[] = Array.from({ length: 10_000 }, (_, index) => ({
    time: index * 100,
    x: Math.cos(index) * 0.5,
    y: Math.sin(index) * 0.5,
    verdict: index % 10 === 0 ? "OK" : index % 50 === 1 ? "MEH" : "GREAT",
  }));
  render(<FullMapAimPanel aim={scatter({ points, mean: { x: 0, y: 0 } })} />);
  expect(plot().querySelectorAll("path[data-testid^='aim-dots-']")).toHaveLength(3);
  const counts = (["GREAT", "OK", "MEH"] as const).map((verdict) => Number(dots(verdict).getAttribute("data-count")));
  expect(counts.reduce((total, count) => total + count, 0)).toBe(10_000);
  // The plot's own parts, three paths of dots and the mean: nothing grows with the hits.
  expect(plot().querySelectorAll("*").length).toBeLessThan(12);
  expect(plot().getAttribute("aria-label")).toMatch(/^Aim: 10000 hits around/);
});

it("puts the white cross on the mean", () => {
  render(<FullMapAimPanel aim={scatter({ mean: { x: 0.25, y: -0.5 } })} />);
  const mean = screen.getByTestId("aim-mean");
  // Centred on (0.25, -0.5): the arm along x, then the arm along y.
  expect(mean.getAttribute("d")).toBe("M0.190 -0.500h0.12M0.250 -0.560v0.12");
  expect(mean.getAttribute("stroke")).toBe("#f5f4f1");
  expect(mean.getAttribute("stroke-width")).toBe("1.5");
  expect(mean.getAttribute("vector-effect")).toBe("non-scaling-stroke");
});

it("draws no cross when there is no mean, and names the hits without one", () => {
  render(<FullMapAimPanel aim={scatter({ mean: null })} />);
  expect(screen.queryByTestId("aim-mean")).toBeNull();
  expect(plot().getAttribute("aria-label")).toBe("Aim: 4 hits around the circle's centre");
});

describe("accessible name", () => {
  it("reads ahead and left as percentages of a radius, rounded", () => {
    expect(nameFor({ x: 0.04, y: -0.02 })).toBe(
      "Aim: 4 hits around the circle's centre, mean 4% of a radius ahead and 2% left of the path",
    );
  });

  it("reads behind and right", () => {
    expect(nameFor({ x: -0.126, y: 0.074 })).toBe(
      "Aim: 4 hits around the circle's centre, mean 13% of a radius behind and 7% right of the path",
    );
  });

  it("names a single component with its unit", () => {
    expect(nameFor({ x: 0.31, y: 0.004 })).toBe(
      "Aim: 4 hits around the circle's centre, mean 31% of a radius ahead of the path",
    );
    expect(nameFor({ x: -0.003, y: 0.2 })).toBe(
      "Aim: 4 hits around the circle's centre, mean 20% of a radius right of the path",
    );
  });

  it("omits a component under half a percent and keeps one at half", () => {
    expect(nameFor({ x: 0.0049, y: 0.01 })).toContain("mean 1% of a radius right of the path");
    expect(nameFor({ x: 0.005, y: 0 })).toContain("mean 1% of a radius ahead of the path");
  });

  it("says the hits are at the centre when both components are under half a percent", () => {
    expect(nameFor({ x: 0.002, y: -0.004 })).toBe("Aim: 4 hits around the circle's centre, mean at the centre");
    expect(nameFor({ x: 0, y: 0 })).toContain("mean at the centre");
  });

  it("counts a single hit in the singular", () => {
    render(
      <FullMapAimPanel
        aim={scatter({ points: [{ time: 1, x: 0.1, y: 0, verdict: "GREAT" }], mean: { x: 0.1, y: 0 } })}
      />,
    );
    expect(plot().getAttribute("aria-label")).toBe(
      "Aim: 1 hit around the circle's centre, mean 10% of a radius ahead of the path",
    );
  });
});

describe("caption", () => {
  it("says which way the movement runs", () => {
    render(<FullMapAimPanel aim={scatter()} />);
    expect(screen.getByText("Movement runs left to right")).toBeTruthy();
  });

  const MOVEMENT_TITLE = "Offsets are turned so the movement into each note runs left to right.";

  it("keeps the visible line short, with no count, and gives the hits left out in the hover text", () => {
    render(<FullMapAimPanel aim={scatter({ omittedCount: 12 })} />);
    const line = screen.getByText("Movement runs left to right");
    expect(line.textContent).toBe("Movement runs left to right");
    expect(line.getAttribute("title")).toBe(`${MOVEMENT_TITLE} 12 hits without a direction are left out.`);
  });

  it("names a single hit left out in its full sentence", () => {
    render(<FullMapAimPanel aim={scatter({ omittedCount: 1 })} />);
    expect(screen.getByText("Movement runs left to right").getAttribute("title")).toBe(
      `${MOVEMENT_TITLE} 1 hit without a direction is left out.`,
    );
  });

  it("says nothing of hits left out when none were", () => {
    render(<FullMapAimPanel aim={scatter({ omittedCount: 0 })} />);
    expect(screen.queryByText(/left out/)).toBeNull();
    expect(screen.getByText("Movement runs left to right").getAttribute("title")).toBe(MOVEMENT_TITLE);
  });
});

describe("when the aim is unavailable", () => {
  const unavailable: FullMapAimScatter = {
    available: false,
    unavailableReason: "Aim is automated by the loaded replay's mods.",
    points: [],
    mean: null,
    omittedCount: 0,
    omittedMissCount: 0,
    misses: [],
  };

  it("keeps the label, gives the reason as a status line, and draws no plot", () => {
    render(<FullMapAimPanel aim={unavailable} />);
    const panel = screen.getByRole("region", { name: "Aim" });
    expect(within(panel).getByRole("heading", { name: "AIM" })).toBeTruthy();
    expect(within(panel).getByRole("status").textContent).toBe("Aim is automated by the loaded replay's mods.");
    expect(screen.queryByRole("img")).toBeNull();
    expect(panel.querySelector("svg")).toBeNull();
    expect(screen.queryByText(/Movement runs/)).toBeNull();
  });
});

describe("robustness", () => {
  it("writes no NaN or Infinity into any path", () => {
    const points: FullMapAimPoint[] = [
      { time: 1, x: 0.2, y: 0.1, verdict: "GREAT" },
      { time: 2, x: Number.NaN, y: 0.1, verdict: "GREAT" },
      { time: 3, x: 0.1, y: Number.POSITIVE_INFINITY, verdict: "OK" },
      { time: 4, x: -0.3, y: 0.3, verdict: "MEH" },
    ];
    render(<FullMapAimPanel aim={scatter({ points, mean: { x: Number.NaN, y: 0 } })} />);
    for (const path of Array.from(plot().querySelectorAll("path"))) {
      expect(path.getAttribute("d")).not.toMatch(/NaN|Infinity/);
    }
    // The two that are not numbers are not counted, and are not in the name.
    expect(dots("GREAT").getAttribute("data-count")).toBe("1");
    expect(dots("OK").getAttribute("data-count")).toBe("0");
    expect(plot().getAttribute("aria-label")).toBe("Aim: 2 hits around the circle's centre");
    expect(screen.queryByTestId("aim-mean")).toBeNull();
  });

  it("keeps an empty verdict as an empty path", () => {
    render(<FullMapAimPanel aim={scatter({ points: [{ time: 1, x: 0.2, y: 0, verdict: "GREAT" }] })} />);
    expect(dots("OK").getAttribute("data-count")).toBe("0");
    expect(dots("OK").getAttribute("d")).toBe("");
  });

  it("draws misses as one path of rings and adds no element per miss", () => {
    const misses = Array.from({ length: 500 }, (_, index) => ({ time: index, x: Math.cos(index), y: Math.sin(index) }));
    render(<FullMapAimPanel aim={scatter({ misses })} />);
    // The edge and the half-radius ring are the only circles; the paths are the cross-hairs, three verdicts, the
    // rings and the mean.
    expect(plot().querySelectorAll("circle")).toHaveLength(2);
    expect(plot().querySelectorAll("path")).toHaveLength(6);
    expect(rings().getAttribute("data-count")).toBe("500");
  });

  it("draws no ring layer when nothing was missed", () => {
    render(<FullMapAimPanel aim={scatter({ misses: [] })} />);
    expect(screen.queryByTestId("aim-misses")).toBeNull();
    expect(plot().querySelectorAll("path")).toHaveLength(5);
  });

  it("writes no NaN or Infinity into the rings and leaves such a miss out", () => {
    const misses = [
      { time: 1, x: 0.5, y: 0.5 },
      { time: 2, x: Number.NaN, y: 0 },
      { time: 3, x: 0, y: Number.NEGATIVE_INFINITY },
    ];
    render(<FullMapAimPanel aim={scatter({ misses })} />);
    expect(rings().getAttribute("data-count")).toBe("1");
    expect(rings().getAttribute("d")).not.toMatch(/NaN|Infinity/);
    expect(plot().getAttribute("aria-label")).toContain(", 1 miss: 1 with the cursor on the note, 0 off it");
  });

  it("is unavailable, with a sentence, when no hit or miss has a position that is a number", () => {
    const points: FullMapAimPoint[] = [
      { time: 1, x: Number.NaN, y: 0.1, verdict: "GREAT" },
      { time: 2, x: 0.1, y: Number.POSITIVE_INFINITY, verdict: "OK" },
    ];
    const misses = [{ time: 3, x: Number.NaN, y: 0 }];
    render(<FullMapAimPanel aim={scatter({ points, misses, mean: null })} />);
    const panel = screen.getByRole("region", { name: "Aim" });
    expect(within(panel).getByRole("status").textContent).toBe("No hit had usable cursor evidence.");
    expect(screen.queryByRole("img")).toBeNull();
    expect(panel.querySelector("svg")).toBeNull();
    expect(screen.queryByText(/Movement runs/)).toBeNull();
  });

  it("is unavailable when only the misses can be drawn: rings alone are not aim evidence", () => {
    const points: FullMapAimPoint[] = [{ time: 1, x: Number.NaN, y: 0.1, verdict: "GREAT" }];
    render(
      <FullMapAimPanel
        aim={scatter({ points, misses: [{ time: 3, x: 0.5, y: 0 }], omittedMissCount: 2, mean: null })}
      />,
    );
    const panel = screen.getByRole("region", { name: "Aim" });
    expect(within(panel).getByRole("status").textContent).toBe("No hit had usable cursor evidence.");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByTestId("aim-misses")).toBeNull();
    expect(screen.queryByText(/Movement runs|Rings:/)).toBeNull();
  });
});

describe("misses", () => {
  // A ring of radius 0.05 is drawn from its left point: a move and two arcs.
  const ringAt = (x: number, y: number) =>
    `M${(x - 0.05).toFixed(3)} ${y.toFixed(3)}a0.05 0.05 0 1 0 0.1 0a0.05 0.05 0 1 0 -0.1 0`;

  it("draws the rings in the miss colour: a thin outline, no fill, above the dots and under the mean", () => {
    render(<FullMapAimPanel aim={scatter({ misses: [{ time: 5_000, x: 0.5, y: -0.25 }] })} />);
    const path = rings();
    expect(path.getAttribute("data-count")).toBe("1");
    expect(path.getAttribute("d")).toBe(ringAt(0.5, -0.25));
    expect(path.getAttribute("fill")).toBe("none");
    expect(path.getAttribute("stroke")).toBe("#ff7082");
    expect(path.getAttribute("stroke-width")).toBe("1.5");
    expect(path.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    const order = Array.from(plot().querySelectorAll("path[data-testid]")).map((element) =>
      element.getAttribute("data-testid"),
    );
    expect(order).toEqual(["aim-dots-GREAT", "aim-dots-OK", "aim-dots-MEH", "aim-misses", "aim-mean"]);
  });

  it("draws a ring beyond 1.3 radii at 1.3 along its own direction, and a nearer one where it is", () => {
    const misses = [
      { time: 1, x: 5, y: 0 },
      { time: 2, x: -2, y: 2 },
      { time: 3, x: 1.2, y: 0 },
    ];
    render(<FullMapAimPanel aim={scatter({ misses })} />);
    const d = rings().getAttribute("d") as string;
    const edge = 1.3 / Math.SQRT2;
    expect(d).toContain(ringAt(1.3, 0));
    expect(d).toContain(ringAt(-edge, edge));
    expect(d).toContain(ringAt(1.2, 0));
    expect(rings().getAttribute("data-count")).toBe("3");
  });

  it("keeps a ring that is exactly at 1.3 where it is", () => {
    render(<FullMapAimPanel aim={scatter({ misses: [{ time: 1, x: 0, y: -1.3 }] })} />);
    expect(rings().getAttribute("d")).toBe(ringAt(0, -1.3));
  });

  describe("accessible name", () => {
    const missesAt = (...offsets: [number, number][]) => offsets.map(([x, y], index) => ({ time: index, x, y }));

    it("counts the misses on the note and off it, on being a radius or less from the centre", () => {
      render(
        <FullMapAimPanel aim={scatter({ mean: null, misses: missesAt([0.5, 0], [0, -1], [1.0001, 0], [3, 4]) })} />,
      );
      expect(plot().getAttribute("aria-label")).toBe(
        "Aim: 4 hits around the circle's centre, 4 misses: 2 with the cursor on the note, 2 off it",
      );
    });

    it("measures the distance before the ring is clamped", () => {
      render(<FullMapAimPanel aim={scatter({ mean: null, misses: missesAt([1.31, 0], [9, 0]) })} />);
      expect(plot().getAttribute("aria-label")).toContain(", 2 misses: 0 with the cursor on the note, 2 off it");
    });

    it("says one miss in the singular", () => {
      render(<FullMapAimPanel aim={scatter({ mean: null, misses: missesAt([0.2, 0.2]) })} />);
      expect(plot().getAttribute("aria-label")).toBe(
        "Aim: 4 hits around the circle's centre, 1 miss: 1 with the cursor on the note, 0 off it",
      );
    });

    it("follows the mean's clause", () => {
      render(<FullMapAimPanel aim={scatter({ mean: { x: 0.31, y: 0.004 }, misses: missesAt([2, 0]) })} />);
      expect(plot().getAttribute("aria-label")).toBe(
        "Aim: 4 hits around the circle's centre, mean 31% of a radius ahead of the path, 1 miss: 0 with the cursor on the note, 1 off it",
      );
    });

    it("has no clause when nothing was missed", () => {
      render(<FullMapAimPanel aim={scatter({ mean: null, misses: [] })} />);
      expect(plot().getAttribute("aria-label")).toBe("Aim: 4 hits around the circle's centre");
    });
  });

  describe("caption", () => {
    const RINGS = "Rings: cursor at each miss";
    const RINGS_FULL = "Rings show where the cursor was when each missed note was due.";
    const missesOf = (count: number) => Array.from({ length: count }, (_, index) => ({ time: index, x: 0.1, y: 0 }));

    it("explains the rings on a line of its own, above the movement line, with the full sentence on hover", () => {
      render(<FullMapAimPanel aim={scatter({ misses: missesOf(2) })} />);
      const movement = screen.getByText("Movement runs left to right");
      const line = screen.getByText(RINGS);
      expect(line).not.toBe(movement);
      expect(line.parentElement).toBe(movement.parentElement);
      // The movement caption is always the bottom line, level with the Timing panel's foot.
      expect(Array.from(movement.parentElement?.children ?? [])).toEqual([line, movement]);
      expect(line.getAttribute("title")).toBe(RINGS_FULL);
    });

    it("gives how many misses were not placed in the hover text only", () => {
      render(<FullMapAimPanel aim={scatter({ misses: missesOf(2), omittedMissCount: 3 })} />);
      const line = screen.getByText(RINGS);
      expect(line.textContent).toBe(RINGS);
      expect(line.getAttribute("title")).toBe(`${RINGS_FULL} 3 misses could not be placed.`);
    });

    it("says one miss that could not be placed in the singular", () => {
      render(<FullMapAimPanel aim={scatter({ misses: missesOf(1), omittedMissCount: 1 })} />);
      expect(screen.getByText(RINGS).getAttribute("title")).toBe(`${RINGS_FULL} 1 miss could not be placed.`);
    });

    it("is shown when every miss was left out, and says so in the hover text", () => {
      render(<FullMapAimPanel aim={scatter({ misses: [], omittedMissCount: 4 })} />);
      expect(screen.getByText(RINGS).getAttribute("title")).toBe(`${RINGS_FULL} 4 misses could not be placed.`);
      expect(screen.queryByTestId("aim-misses")).toBeNull();
    });

    it("never carries a count in its visible text", () => {
      render(<FullMapAimPanel aim={scatter({ misses: missesOf(2), omittedCount: 7, omittedMissCount: 5 })} />);
      const foot = screen.getByText("Movement runs left to right").parentElement as HTMLElement;
      expect(foot.textContent).toBe(`${RINGS}Movement runs left to right`);
      expect(foot.textContent).not.toMatch(/\d/);
    });

    it("is not shown when nothing was missed", () => {
      render(<FullMapAimPanel aim={scatter({ misses: [], omittedMissCount: 0 })} />);
      expect(screen.queryByText(/Rings:/)).toBeNull();
    });

    it("keeps the omitted hit count for hits only", () => {
      render(<FullMapAimPanel aim={scatter({ misses: missesOf(1), omittedCount: 2, omittedMissCount: 5 })} />);
      expect(screen.getByText("Movement runs left to right").getAttribute("title")).toMatch(/ 2 hits without a direction/);
      expect(screen.getByText(RINGS).getAttribute("title")).toMatch(/ 5 misses could not be placed\.$/);
    });
  });
});

describe("size", () => {
  const sideOf = () => {
    const style = getComputedStyle(screen.getByTestId("aim-plot"));
    return { width: style.width, height: style.height };
  };

  it("is the same with and without misses, with room kept for both caption lines", () => {
    const { unmount } = render(<FullMapAimPanel aim={scatter({ misses: [] })} />);
    const without = sideOf();
    unmount();
    render(<FullMapAimPanel aim={scatter({ misses: [{ time: 1, x: 0.3, y: 0 }], omittedMissCount: 1 })} />);
    const withMisses = sideOf();
    expect(withMisses).toEqual(without);
    // The band's height less the head (14), two caption lines (17 each) and the two gaps (10 each).
    for (const side of [without.width, without.height]) {
      expect(side).toContain("100cqh");
      expect(side).toContain("68px");
    }
  });

  it("keeps the ring line's height, above the movement line, when there is nothing to say", () => {
    render(<FullMapAimPanel aim={scatter({ misses: [] })} />);
    const movement = screen.getByText("Movement runs left to right");
    const foot = movement.parentElement as HTMLElement;
    expect(foot.children).toHaveLength(2);
    const blank = foot.children[0] as HTMLElement;
    expect(foot.children[1]).toBe(movement);
    expect(blank.textContent).toBe("");
    expect(getComputedStyle(blank).height).toBe("17px");
    expect(getComputedStyle(movement).height).toBe("17px");
  });
});

describe("colours", () => {
  it("draws the half-radius ring and the cross-hairs in the hairline token", () => {
    render(<FullMapAimPanel aim={scatter()} />);
    const half = plot().querySelectorAll("circle")[1];
    const cross = plot().querySelector("path[d='M-1 0H1M0 -1V1']") as SVGPathElement;
    expect(REWIND_COLORS.hairline).toBe("rgba(255,255,255,0.1)");
    expect(half.getAttribute("stroke")).toBe(REWIND_COLORS.hairline);
    expect(cross.getAttribute("stroke")).toBe(REWIND_COLORS.hairline);
  });
});

it("gives the plot a real size where the band stacks", () => {
  render(<FullMapAimPanel aim={scatter()} />);
  const rules = smallWindowRules(screen.getByTestId("aim-plot"));
  for (const rule of rules) {
    expect(rule).toMatch(/width: 280px/);
    expect(rule).toMatch(/height: 280px/);
  }
});
