import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { REWIND_COLORS } from "../../styles/tokens";
import { FullMapErrorCauses } from "./FullMapErrorCauses";
import type { ErrorCauseFamily, FullMapErrorCauses as ErrorCauses } from "./full-map-error-causes";
import { FULL_MAP_HEAD_HEIGHT } from "./full-map-styles";

const count = (miss: number, slider = 0) => ({ total: miss + slider, miss, slider });

function ready(overrides: Partial<Extract<ErrorCauses, { status: "ready" }>> = {}): ErrorCauses {
  return {
    status: "ready",
    total: 6,
    families: { aim: count(2, 1), tapping: count(2), notelock: count(0) },
    none: count(1),
    breakdown: { aim: [], tapping: [], notelock: [] },
    ...overrides,
  };
}

/** One row of a family's breakdown. */
const cause = (label: string, miss: number, slider = 0) => ({ label, count: count(miss, slider) });
const withBreakdown = (breakdown: Partial<Record<ErrorCauseFamily, ReturnType<typeof cause>[]>>) =>
  ({ breakdown: { aim: [], tapping: [], notelock: [], ...breakdown } });

const panel = () => screen.getByRole("region", { name: "Error causes" });
const rows = () => within(panel()).getAllByTestId("error-cause-row");
const rowNamed = (name: string) => within(panel()).getByRole("region", { name });
const rgb = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
};

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

describe("FullMapErrorCauses", () => {
  describe("when ready", () => {
    it("names the panel, labels its head and counts the errors", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      expect(within(panel()).getByRole("heading", { name: "ERROR CAUSES" })).toBeTruthy();
      const fact = within(panel()).getByText("6 errors");
      expect(window.getComputedStyle(fact).fontSize).toBe("12.5px");
      expect(window.getComputedStyle(fact).fontWeight).toBe("500");
      expect(window.getComputedStyle(fact).color).toBe(rgb(REWIND_COLORS.textPrimary));
    });

    it("builds its head like the other panels: the label at the top, the count on its baseline at the right", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      const label = within(panel()).getByRole("heading", { name: "ERROR CAUSES" });
      const head = window.getComputedStyle(label.parentElement as HTMLElement);
      // No height or centring of its own, which had put the label lower than the other panels'.
      expect([head.display, head.alignItems, head.justifyContent]).toEqual(["flex", "baseline", "space-between"]);
      expect(head.minHeight).toBe("");
      expect(window.getComputedStyle(label).lineHeight).toBe("14px");
      const fact = within(panel()).getByText("6 errors");
      // The filter sits between the name and the count.
      expect(label.nextElementSibling).toBe(within(panel()).getByRole("group", { name: "Errors shown" }));
      expect(label.parentElement?.lastElementChild).toBe(fact);
      // The page's own line height (1.4) would be a 17.5px line here: a taller head, and the name pushed down.
      expect(window.getComputedStyle(fact).lineHeight).toBe(`${FULL_MAP_HEAD_HEIGHT}px`);
    });

    it("counts one error and no errors in the right number", () => {
      const { rerender } = render(
        <FullMapErrorCauses
          causes={ready({
            total: 1,
            families: { aim: count(1), tapping: count(0), notelock: count(0) },
            none: count(0),
          })}
          sourceRulesetLabel="Stable"
        />,
      );
      expect(within(panel()).getByText("1 error")).toBeTruthy();
      rerender(
        <FullMapErrorCauses
          causes={ready({
            total: 0,
            families: { aim: count(0), tapping: count(0), notelock: count(0) },
            none: count(0),
          })}
          sourceRulesetLabel="Stable"
        />,
      );
      expect(within(panel()).getByText("0 errors")).toBeTruthy();
    });

    it("lists Aim, Tapping, Notelock and then No cause found, each named for its count", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
        "Aim: 3",
        "Tapping: 2",
        "Notelock: 0",
        "No cause found: 1",
      ]);
      for (const row of rows()) expect(row.tagName).toBe("SECTION");
    });

    it("writes the name, the count and the share of the total in each row", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      const text = (name: string) =>
        Array.from(rowNamed(name).children)
          .slice(0, 3)
          .map((cell) => cell.textContent);
      expect(text("Aim: 3")).toEqual(["Aim", "3", "50.0%"]);
      expect(text("Tapping: 2")).toEqual(["Tapping", "2", "33.3%"]);
      expect(text("Notelock: 0")).toEqual(["Notelock", "0", "0.0%"]);
      expect(text("No cause found: 1")).toEqual(["No cause found", "1", "16.7%"]);
    });

    it("sets the row's type: a 13px 600 name, a 16px 500 count, a 12.5px share in a 76px column", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      const line = rowNamed("Aim: 3");
      const [name, countCell, share] = Array.from(line.children) as HTMLElement[];
      expect(window.getComputedStyle(line).gridTemplateColumns).toBe("minmax(0, 1fr) auto 76px");
      expect(window.getComputedStyle(name).fontSize).toBe("13px");
      expect(window.getComputedStyle(name).fontWeight).toBe("600");
      expect(window.getComputedStyle(name).color).toBe(rgb(REWIND_COLORS.textPrimary));
      expect(window.getComputedStyle(countCell).fontSize).toBe("16px");
      expect(window.getComputedStyle(countCell).fontWeight).toBe("500");
      expect(window.getComputedStyle(countCell).fontVariantNumeric).toBe("tabular-nums");
      expect(window.getComputedStyle(share).fontSize).toBe("12.5px");
      expect(window.getComputedStyle(share).textAlign).toBe("right");
      expect(window.getComputedStyle(share).color).toBe(rgb(REWIND_COLORS.textTertiary));
    });

    it("keeps the name and the count of No cause found quiet", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      const [name, countCell] = Array.from(rowNamed("No cause found: 1").children) as HTMLElement[];
      for (const cell of [name, countCell]) {
        expect(window.getComputedStyle(cell).color).toBe(rgb(REWIND_COLORS.textTertiary));
        expect(window.getComputedStyle(cell).fontWeight).toBe("500");
      }
    });

    it("shows No cause found only when an error has none", () => {
      render(<FullMapErrorCauses causes={ready({ total: 5, none: count(0) })} sourceRulesetLabel="Stable" />);
      expect(rows()).toHaveLength(3);
      expect(screen.queryByText("No cause found")).toBeNull();
    });

    it("draws the shares as 6px bars of the miss and slider kinds, each as wide as its share of the total", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      const bar = within(rowNamed("Aim: 3")).getByTestId("error-cause-bar");
      const style = window.getComputedStyle(bar);
      expect(style.height).toBe("6px");
      expect(style.borderRadius).toBe("3px");
      expect(style.backgroundColor).toBe(rgb(REWIND_COLORS.inset));
      expect(style.display).toBe("flex");
      const segments = Array.from(bar.children) as HTMLElement[];
      expect(segments.map((segment) => segment.getAttribute("data-kind"))).toEqual(["miss", "slider"]);
      // Two misses and a slider error of six.
      expect(Number.parseFloat(window.getComputedStyle(segments[0]).flexBasis)).toBeCloseTo(100 / 3);
      expect(Number.parseFloat(window.getComputedStyle(segments[1]).flexBasis)).toBeCloseTo(100 / 6);
      expect(window.getComputedStyle(segments[0]).backgroundColor).toBe(rgb(REWIND_COLORS.judgementMiss));
      expect(window.getComputedStyle(segments[1]).backgroundColor).toBe(rgb(REWIND_COLORS.sliderBreak));
      for (const segment of segments) expect(window.getComputedStyle(segment).flexShrink).toBe("0");
    });

    it("draws one segment of the kind present, and none for a row of none", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      const segmentsOf = (name: string) =>
        Array.from(within(rowNamed(name)).getByTestId("error-cause-bar").children) as HTMLElement[];
      expect(segmentsOf("Tapping: 2").map((segment) => segment.getAttribute("data-kind"))).toEqual(["miss"]);
      expect(Number.parseFloat(window.getComputedStyle(segmentsOf("Tapping: 2")[0]).flexBasis)).toBeCloseTo(100 / 3);
      expect(segmentsOf("Notelock: 0")).toHaveLength(0);
    });

    it("draws the No cause found bar as one dim segment", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      const segments = Array.from(
        within(rowNamed("No cause found: 1")).getByTestId("error-cause-bar").children,
      ) as HTMLElement[];
      expect(segments).toHaveLength(1);
      expect(segments[0].getAttribute("data-kind")).toBe("none");
      expect(window.getComputedStyle(segments[0]).backgroundColor).toBe(rgb(REWIND_COLORS.textDim));
      expect(Number.parseFloat(window.getComputedStyle(segments[0]).flexBasis)).toBeCloseTo(100 / 6);
    });

    it("spaces the rows with the mock's clamp and the name line 7px above its bar", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      const list = rows()[0].parentElement as HTMLElement;
      expect(window.getComputedStyle(list).display).toBe("flex");
      expect(window.getComputedStyle(list).flexDirection).toBe("column");
      expect(window.getComputedStyle(list).getPropertyValue("gap")).toBe("clamp(5px, 1.3vh, 16px)");
      expect(window.getComputedStyle(rows()[0]).getPropertyValue("row-gap")).toBe("7px");
    });

    it("leaves the share blank, never zero or NaN, when there are no errors", () => {
      render(
        <FullMapErrorCauses
          causes={ready({
            total: 0,
            families: { aim: count(0), tapping: count(0), notelock: count(0) },
            none: count(0),
          })}
          sourceRulesetLabel="Stable"
        />,
      );
      expect(rows()).toHaveLength(3);
      for (const row of rows()) {
        const [, countCell, share] = Array.from(row.children);
        expect(countCell.textContent).toBe("0");
        expect(share.textContent).toBe("");
        expect(within(row).getByTestId("error-cause-bar").children).toHaveLength(0);
      }
      expect(panel().textContent).not.toMatch(/NaN|Infinity/);
    });

    it("has no caption, legend or tooltip", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      expect(within(panel()).queryByRole("tooltip")).toBeNull();
      expect(panel().querySelector("[title]")).toBeNull();
      expect(panel().textContent).not.toMatch(/miss(es)?\b.*slider|legend/i);
      expect(panel().textContent).toBe(
        "ERROR CAUSESAllMiss6 errorsAim350.0%Tapping233.3%Notelock00.0%No cause found116.7%",
      );
    });

    it("has no filter when the errors are all misses, all slider errors or none", () => {
      const onlyMisses = ready({
        total: 5,
        families: { aim: count(2), tapping: count(2), notelock: count(0) },
        none: count(1),
      });
      const onlySliders = ready({
        total: 3,
        families: { aim: count(0, 1), tapping: count(0, 2), notelock: count(0) },
        none: count(0),
      });
      const noErrors = ready({
        total: 0,
        families: { aim: count(0), tapping: count(0), notelock: count(0) },
        none: count(0),
      });
      const { rerender } = render(<FullMapErrorCauses causes={onlyMisses} sourceRulesetLabel="Stable" />);
      expect(within(panel()).queryByRole("group", { name: "Errors shown" })).toBeNull();
      expect(within(panel()).getByText("5 errors")).toBeTruthy();
      rerender(<FullMapErrorCauses causes={onlySliders} sourceRulesetLabel="Stable" />);
      expect(within(panel()).queryByRole("group", { name: "Errors shown" })).toBeNull();
      rerender(<FullMapErrorCauses causes={noErrors} sourceRulesetLabel="Stable" />);
      expect(within(panel()).queryByRole("group", { name: "Errors shown" })).toBeNull();
    });

    it("takes a height of its own in a small window", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      for (const rules of smallWindowRules(panel())) expect(rules).toMatch(/min-height: 200px/);
    });
  });

  describe("the All / Miss filter", () => {
    // Five misses (two Aim, two Tapping, one without a cause) and one Aim slider error.
    const filter = () => within(panel()).getByRole("group", { name: "Errors shown" });
    const option = (name: "All" | "Miss") => within(filter()).getByRole("button", { name });
    const shownNames = () => rows().map((row) => row.getAttribute("aria-label"));
    const cells = (name: string) =>
      Array.from(rowNamed(name).children)
        .slice(0, 3)
        .map((cell) => cell.textContent);
    const kinds = (name: string) =>
      Array.from(within(rowNamed(name)).getByTestId("error-cause-bar").children).map((segment) =>
        segment.getAttribute("data-kind"),
      );

    it("offers All and Miss between the name and the count, All pressed", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      expect(Array.from(filter().children).map((button) => button.textContent)).toEqual(["All", "Miss"]);
      expect(option("All").getAttribute("aria-pressed")).toBe("true");
      expect(option("Miss").getAttribute("aria-pressed")).toBe("false");
      expect(within(panel()).getByText("6 errors")).toBeTruthy();
      expect(shownNames()).toEqual(["Aim: 3", "Tapping: 2", "Notelock: 0", "No cause found: 1"]);
    });

    it("is a small segmented control: 20px tall, 11.5px text, 8px beside each option", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      expect(window.getComputedStyle(filter()).height).toBe("20px");
      for (const name of ["All", "Miss"] as const) {
        const style = window.getComputedStyle(option(name));
        expect(style.fontSize).toBe("11.5px");
        expect(style.paddingLeft).toBe("8px");
        expect(style.paddingRight).toBe("8px");
      }
    });

    it("keeps the head the other panels' height by taking the part beyond the name's line out of its margin", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      const style = window.getComputedStyle(filter());
      const margin = (FULL_MAP_HEAD_HEIGHT - 20) / 2;
      expect([style.marginTop, style.marginBottom]).toEqual([`${margin}px`, `${margin}px`]);
      expect(style.alignSelf).toBe("center");
      const head = window.getComputedStyle(filter().parentElement as HTMLElement);
      expect(head.whiteSpace).toBe("nowrap");
      expect(head.flexWrap).not.toBe("wrap");
    });

    it("counts only misses when Miss is chosen, as shares of the misses", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      fireEvent.click(option("Miss"));
      expect(option("Miss").getAttribute("aria-pressed")).toBe("true");
      expect(option("All").getAttribute("aria-pressed")).toBe("false");
      expect(within(panel()).getByText("5 misses")).toBeTruthy();
      expect(within(panel()).queryByText("6 errors")).toBeNull();
      expect(shownNames()).toEqual(["Aim: 2", "Tapping: 2", "Notelock: 0", "No cause found: 1"]);
      expect(cells("Aim: 2")).toEqual(["Aim", "2", "40.0%"]);
      expect(cells("Tapping: 2")).toEqual(["Tapping", "2", "40.0%"]);
      expect(cells("Notelock: 0")).toEqual(["Notelock", "0", "0.0%"]);
      expect(cells("No cause found: 1")).toEqual(["No cause found", "1", "20.0%"]);
    });

    it("draws one miss segment per bar, as wide as the row's share of the misses", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      expect(kinds("Aim: 3")).toEqual(["miss", "slider"]);
      fireEvent.click(option("Miss"));
      expect(kinds("Aim: 2")).toEqual(["miss"]);
      const [segment] = Array.from(within(rowNamed("Aim: 2")).getByTestId("error-cause-bar").children) as HTMLElement[];
      expect(Number.parseFloat(window.getComputedStyle(segment).flexBasis)).toBeCloseTo(40);
      expect(window.getComputedStyle(segment).backgroundColor).toBe(rgb(REWIND_COLORS.judgementMiss));
      expect(kinds("Notelock: 0")).toEqual([]);
    });

    it("shows No cause found in Miss only when one of its errors is a miss", () => {
      const sliderOnlyNone = ready({
        families: { aim: count(2, 1), tapping: count(2), notelock: count(0) },
        none: count(0, 1),
      });
      render(<FullMapErrorCauses causes={sliderOnlyNone} sourceRulesetLabel="Stable" />);
      expect(shownNames()).toEqual(["Aim: 3", "Tapping: 2", "Notelock: 0", "No cause found: 1"]);
      fireEvent.click(option("Miss"));
      expect(shownNames()).toEqual(["Aim: 2", "Tapping: 2", "Notelock: 0"]);
      expect(within(panel()).getByText("4 misses")).toBeTruthy();
    });

    it("restores every count when All is chosen again", () => {
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      fireEvent.click(option("Miss"));
      fireEvent.click(option("All"));
      expect(option("All").getAttribute("aria-pressed")).toBe("true");
      expect(within(panel()).getByText("6 errors")).toBeTruthy();
      expect(shownNames()).toEqual(["Aim: 3", "Tapping: 2", "Notelock: 0", "No cause found: 1"]);
      expect(cells("Aim: 3")).toEqual(["Aim", "3", "50.0%"]);
      expect(kinds("Aim: 3")).toEqual(["miss", "slider"]);
    });

    it("says one miss in the singular", () => {
      const oneMiss = ready({
        total: 2,
        families: { aim: count(1, 1), tapping: count(0), notelock: count(0) },
        none: count(0),
      });
      render(<FullMapErrorCauses causes={oneMiss} sourceRulesetLabel="Stable" />);
      fireEvent.click(option("Miss"));
      expect(within(panel()).getByText("1 miss")).toBeTruthy();
      expect(cells("Aim: 1")).toEqual(["Aim", "1", "100.0%"]);
    });

    it("starts on All again when the panel is mounted again", () => {
      const first = render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      fireEvent.click(option("Miss"));
      first.unmount();
      render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      expect(option("All").getAttribute("aria-pressed")).toBe("true");
    });

    it("shows every error when the replay no longer has both kinds, whatever was chosen", () => {
      const { rerender } = render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
      fireEvent.click(option("Miss"));
      const onlyMisses = ready({
        total: 5,
        families: { aim: count(2), tapping: count(2), notelock: count(0) },
        none: count(1),
      });
      rerender(<FullMapErrorCauses causes={onlyMisses} sourceRulesetLabel="Stable" />);
      expect(within(panel()).queryByRole("group", { name: "Errors shown" })).toBeNull();
      expect(within(panel()).getByText("5 errors")).toBeTruthy();
    });
  });

  describe("when it cannot show counts", () => {
    const sentence = (text: string) => {
      const status = within(panel()).getByRole("status");
      expect(status.textContent).toBe(text);
      expect(window.getComputedStyle(status).color).toBe(rgb(REWIND_COLORS.textTertiary));
      expect(window.getComputedStyle(status).fontSize).toBe("12.5px");
    };
    const noRows = () => {
      expect(within(panel()).queryAllByTestId("error-cause-row")).toHaveLength(0);
      expect(within(panel()).queryByTestId("error-cause-bar")).toBeNull();
      expect(panel().textContent).not.toMatch(/\d|NaN/);
      expect(within(panel()).queryByRole("group", { name: "Errors shown" })).toBeNull();
      // The label stays; the count of errors does not.
      expect(within(panel()).getByRole("heading", { name: "ERROR CAUSES" })).toBeTruthy();
    };

    it("says it is analyzing", () => {
      render(<FullMapErrorCauses causes={{ status: "analyzing" }} sourceRulesetLabel="Stable" />);
      sentence("Analyzing errors…");
      noRows();
    });

    it.each(["Stable", "Lazer"] as const)("says causes are available in the %s view only", (label) => {
      render(
        <FullMapErrorCauses causes={{ status: "unavailable", reason: "other-ruleset" }} sourceRulesetLabel={label} />,
      );
      sentence(`Causes are available in the ${label} view only.`);
      noRows();
    });

    it("says the error analysis is unavailable", () => {
      render(
        <FullMapErrorCauses causes={{ status: "unavailable", reason: "unavailable" }} sourceRulesetLabel="Stable" />,
      );
      sentence("Error analysis unavailable.");
      noRows();
    });
  });
});

describe("FullMapErrorCauses cause breakdown card", () => {
  /** Lets MUI's enter delay pass, to show that no card came. */
  const letTooltipDelayPass = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
  const hover = (name: string) => fireEvent.mouseOver(rowNamed(name));
  const cardRows = (tooltip: HTMLElement) =>
    Array.from(tooltip.querySelectorAll(".MuiTooltip-tooltip > div > span")).map((cell) => cell.textContent);
  /** The widths of the bars of a card, in percent. */
  const barWidths = (tooltip: HTMLElement) =>
    within(tooltip)
      .queryAllByTestId("hover-card-bar")
      .map((bar) => Number.parseFloat(getComputedStyle(bar.firstElementChild as HTMLElement).width));

  it("shows the family's causes and counts when its row is hovered", async () => {
    render(
      <FullMapErrorCauses
        causes={ready(withBreakdown({ aim: [cause("Overaim", 2), cause("Off track", 0, 1)] }))}
        sourceRulesetLabel="Stable"
      />,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    hover("Aim: 3");
    const tooltip = await screen.findByRole("tooltip");
    expect(cardRows(tooltip)).toEqual(["Overaim", "2", "Off track", "1"]);
    // Two rows with a share: the shared card draws their bars, 2 of 3 and 1 of 3.
    const [first, second] = barWidths(tooltip);
    expect(first).toBeCloseTo(66.67, 1);
    expect(second).toBeCloseTo(33.33, 1);
    // The card belongs to the row and is its description.
    expect(rowNamed("Aim: 3").getAttribute("aria-describedby")).toBe(tooltip.id);
  });

  describe("where the card points", () => {
    const box = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const lay = (element: Element, rect: DOMRect) => void (element.getBoundingClientRect = () => rect);
    beforeEach(() => {
      // jsdom has no layout: the page is 1280 x 800, so Popper has a window to keep the card in.
      for (const [name, value] of [["clientWidth", 1280], ["clientHeight", 800]] as const) {
        Object.defineProperty(document.documentElement, name, { configurable: true, value });
      }
    });
    afterEach(() => {
      for (const name of ["clientWidth", "clientHeight"]) delete (document.documentElement as unknown as Record<string, unknown>)[name];
    });
    /** Where Popper put the card: the translate of its popper element. */
    const placement = (tooltip: HTMLElement) => {
      const [, x, y] = /translate3?d?\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(tooltip.style.transform) ?? [];
      return { x: Number(x), y: Number(y), side: tooltip.getAttribute("data-popper-placement") };
    };
    const mount = () =>
      render(
        <FullMapErrorCauses
          causes={ready(withBreakdown({ aim: [cause("Overaim", 2), cause("Off track", 0, 1)] }))}
          sourceRulesetLabel="Stable"
        />,
      );

    it("is centred under the row's count, not beside the row", async () => {
      mount();
      const row = rowNamed("Aim: 3");
      // The row is wide and its middle is empty; the count is at its right.
      lay(row, box(40, 300, 300, 30));
      lay(within(row).getByTestId("error-cause-count"), box(220, 304, 24, 22));
      fireEvent.mouseOver(row);
      const tooltip = await screen.findByRole("tooltip");
      // Centre of the count (x 232), directly below it (y 326) — the row's centre would be 190 and its bottom 330.
      expect(placement(tooltip)).toEqual({ x: 232, y: 326, side: "bottom" });
    });

    it("opens the same on keyboard focus", async () => {
      mount();
      const row = rowNamed("Aim: 3");
      lay(row, box(40, 300, 300, 30));
      lay(within(row).getByTestId("error-cause-count"), box(220, 304, 24, 22));
      fireEvent.keyDown(document.body, { key: "Tab", code: "Tab" });
      act(() => row.focus());
      expect(placement(await screen.findByRole("tooltip"))).toEqual({ x: 232, y: 326, side: "bottom" });
    });
  });

  it("is a card for each family row, with that family's causes only", async () => {
    render(
      <FullMapErrorCauses
        causes={ready(
          withBreakdown({
            aim: [cause("Overaim", 2), cause("Off track", 0, 1)],
            tapping: [cause("Early tap", 1), cause("Late tap", 1)],
          }),
        )}
        sourceRulesetLabel="Stable"
      />,
    );
    hover("Tapping: 2");
    expect(cardRows(await screen.findByRole("tooltip"))).toEqual(["Early tap", "1", "Late tap", "1"]);
  });

  it("follows the Miss switch: it counts misses, leaves out the rows that become 0, and shares the family's misses", async () => {
    render(
      <FullMapErrorCauses
        causes={ready({
          total: 5,
          families: { aim: count(3, 1), tapping: count(0), notelock: count(0) },
          none: count(1),
          ...withBreakdown({ aim: [cause("Overaim", 2), cause("Misaim", 1), cause("Off track", 0, 1)] }),
        })}
        sourceRulesetLabel="Stable"
      />,
    );
    fireEvent.click(within(panel()).getByRole("button", { name: "Miss" }));
    hover("Aim: 3");
    const tooltip = await screen.findByRole("tooltip");
    expect(cardRows(tooltip)).toEqual(["Overaim", "2", "Misaim", "1"]);
    const [first, second] = barWidths(tooltip);
    expect(first).toBeCloseTo(66.67, 1);
    expect(second).toBeCloseTo(33.33, 1);
  });

  it("keeps the card's rows in the order of the counts shown", async () => {
    render(
      <FullMapErrorCauses
        causes={ready({
          total: 6,
          families: { aim: count(2, 3), tapping: count(0), notelock: count(0) },
          none: count(1),
          // Most errors first, but the most of them are slider errors, which the Miss switch does not count.
          ...withBreakdown({ aim: [cause("Off track", 0, 3), cause("Misaim", 1), cause("Overaim", 1)] }),
        })}
        sourceRulesetLabel="Stable"
      />,
    );
    fireEvent.click(within(panel()).getByRole("button", { name: "Miss" }));
    hover("Aim: 2");
    expect(cardRows(await screen.findByRole("tooltip"))).toEqual(["Misaim", "1", "Overaim", "1"]);
  });

  it("has no card for a family with no errors as shown, nor for No cause found", async () => {
    render(
      <FullMapErrorCauses
        causes={ready(withBreakdown({ aim: [cause("Overaim", 2), cause("Off track", 0, 1)] }))}
        sourceRulesetLabel="Stable"
      />,
    );
    for (const name of ["Notelock: 0", "No cause found: 1"]) {
      hover(name);
      await letTooltipDelayPass();
      expect([name, screen.queryByRole("tooltip")]).toEqual([name, null]);
      expect([name, rowNamed(name).getAttribute("tabindex")]).toEqual([name, null]);
    }
  });

  it("has no card for a family whose errors are all slider errors while Miss is on", async () => {
    render(
      <FullMapErrorCauses
        causes={ready({
          total: 3,
          families: { aim: count(1), tapping: count(0, 2), notelock: count(0) },
          none: count(0),
          ...withBreakdown({ aim: [cause("Overaim", 1)], tapping: [cause("Early release", 0, 2)] }),
        })}
        sourceRulesetLabel="Stable"
      />,
    );
    fireEvent.click(within(panel()).getByRole("button", { name: "Miss" }));
    hover("Tapping: 0");
    await letTooltipDelayPass();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it.each([
    ["Notelock", "notelock", "Notelock: 2"],
    ["Aim", "aim", "Aim: 3"],
  ] as const)("has no card when %s has one cause and it is named like the row", async (label, family, rowName) => {
    const only = family === "notelock" ? [cause(label, 2)] : [cause(label.toUpperCase(), 2, 1)];
    render(
      <FullMapErrorCauses
        causes={ready({
          total: 5,
          families: { aim: count(2, 1), tapping: count(2), notelock: count(family === "notelock" ? 2 : 0) },
          ...withBreakdown({ [family]: only }),
        })}
        sourceRulesetLabel="Stable"
      />,
    );
    hover(rowName);
    await letTooltipDelayPass();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(rowNamed(rowName).getAttribute("tabindex")).toBeNull();
  });

  it("shows a one-row card when the one cause is not named like the row", async () => {
    render(
      <FullMapErrorCauses
        causes={ready({
          total: 6,
          families: { aim: count(2, 1), tapping: count(2), notelock: count(1) },
          ...withBreakdown({ notelock: [cause("Out of order", 1)] }),
        })}
        sourceRulesetLabel="Stable"
      />,
    );
    hover("Notelock: 1");
    const tooltip = await screen.findByRole("tooltip");
    expect(cardRows(tooltip)).toEqual(["Out of order", "1"]);
    // A lone share compares nothing: no bar.
    expect(barWidths(tooltip)).toEqual([]);
  });

  const causesOf = (n: number) => Array.from({ length: n }, (_, index) => cause(`Cause ${n - index}`, n - index));
  const sumTo = (n: number) => (n * (n + 1)) / 2;
  const withCauses = (n: number) => (
    <FullMapErrorCauses
      causes={ready({
        families: { aim: count(sumTo(n)), tapping: count(0), notelock: count(0) },
        ...withBreakdown({ aim: causesOf(n) }),
      })}
      sourceRulesetLabel="Stable"
    />
  );

  it("shows eight causes as they are", async () => {
    render(withCauses(8));
    hover(`Aim: ${sumTo(8)}`);
    const cells = cardRows(await screen.findByRole("tooltip"));
    expect(cells.filter((_, index) => index % 2 === 0)).toEqual(
      ["Cause 8", "Cause 7", "Cause 6", "Cause 5", "Cause 4", "Cause 3", "Cause 2", "Cause 1"],
    );
  });

  it("folds more than eight causes into Other after the first seven", async () => {
    render(withCauses(9));
    hover(`Aim: ${sumTo(9)}`);
    const cells = cardRows(await screen.findByRole("tooltip"));
    expect(cells).toHaveLength(16);
    expect(cells.filter((_, index) => index % 2 === 0)).toEqual(
      ["Cause 9", "Cause 8", "Cause 7", "Cause 6", "Cause 5", "Cause 4", "Cause 3", "Other"],
    );
    // Other is the sum of the two that were left out, 2 + 1.
    expect(cells.slice(-2)).toEqual(["Other", "3"]);
  });

  it("adds nothing to the row that is visible: the same cells, the same text, no icon", () => {
    const plain = render(<FullMapErrorCauses causes={ready()} sourceRulesetLabel="Stable" />);
    const shape = (row: HTMLElement) => ({
      cells: Array.from(row.children).map((child) => child.tagName + child.textContent),
      label: row.getAttribute("aria-label"),
      icons: row.querySelectorAll("svg, img, [title]").length,
    });
    const before = shape(rowNamed("Aim: 3"));
    plain.unmount();
    render(
      <FullMapErrorCauses
        causes={ready(withBreakdown({ aim: [cause("Overaim", 2), cause("Off track", 0, 1)] }))}
        sourceRulesetLabel="Stable"
      />,
    );
    expect(shape(rowNamed("Aim: 3"))).toEqual(before);
    expect(before.icons).toBe(0);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("can take the keyboard focus only when it has a card, and shows the card then", async () => {
    render(
      <FullMapErrorCauses
        causes={ready(withBreakdown({ aim: [cause("Overaim", 2), cause("Off track", 0, 1)] }))}
        sourceRulesetLabel="Stable"
      />,
    );
    expect(rowNamed("Aim: 3").getAttribute("tabindex")).toBe("0");
    for (const name of ["Tapping: 2", "Notelock: 0", "No cause found: 1"]) expect(rowNamed(name).getAttribute("tabindex")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Tab", code: "Tab" });
    act(() => rowNamed("Aim: 3").focus());
    expect(cardRows(await screen.findByRole("tooltip"))).toEqual(["Overaim", "2", "Off track", "1"]);
  });
});
