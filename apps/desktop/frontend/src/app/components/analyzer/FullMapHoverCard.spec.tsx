import { fireEvent, render, screen, within } from "@testing-library/react";
import { Tooltip } from "@mui/material";
import { FullMapHoverCard, fullMapHoverCardSlotProps } from "./FullMapHoverCard";

const rgb = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
};

const rows = [
  { label: "Peak", value: "251.24", unit: "pp", share: 0.8 },
  { label: "If FC", value: "312.50", unit: "pp", share: 1 },
];

describe("FullMapHoverCard", () => {
  it("writes each row as a label and a value with its unit, and nothing else", () => {
    const { container } = render(<FullMapHoverCard rows={rows} />);
    expect(container.textContent).toBe("Peak251.24ppIf FC312.50pp");
    expect(screen.getByText("251.24").textContent).toBe("251.24pp");
    expect(screen.getAllByText("pp", { selector: "span span" })).toHaveLength(2);
  });

  it("is a two-column grid sized by its content: columns 22px apart, rows 5px, on the baseline", () => {
    const { container } = render(<FullMapHoverCard rows={rows} />);
    const grid = container.firstElementChild as HTMLElement;
    const style = getComputedStyle(grid);
    expect([style.display, style.gridTemplateColumns, style.columnGap, style.rowGap, style.alignItems]).toEqual([
      "grid",
      "auto auto",
      "22px",
      "5px",
      "baseline",
    ]);
    // No width of its own: the card is as wide as its widest row.
    expect([style.width, style.minWidth, style.maxWidth]).toEqual(["", "", ""]);
  });

  it("sets the label in Geist 400 12.5px bright, the value in Geist 600 13.5px white, the unit 11.5px after 3px", () => {
    render(<FullMapHoverCard rows={rows} />);
    const label = getComputedStyle(screen.getByText("Peak"));
    expect([label.fontSize, label.fontWeight, label.color, label.whiteSpace]).toEqual([
      "12.5px",
      "400",
      rgb("#e2dfd9"),
      "nowrap",
    ]);
    expect(label.fontFamily).toContain("Geist");
    const value = getComputedStyle(screen.getByText("251.24"));
    expect([value.fontSize, value.fontWeight, value.color, value.whiteSpace, value.textAlign]).toEqual([
      "13.5px",
      "600",
      rgb("#ffffff"),
      "nowrap",
      "right",
    ]);
    expect(value.fontVariantNumeric).toBe("tabular-nums");
    expect(value.fontFamily).toContain("Geist");
    expect(getComputedStyle(screen.getByText("251.24")).justifySelf).toBe("end");
    const unit = getComputedStyle(screen.getAllByText("pp", { selector: "span span" })[0]);
    expect([unit.fontSize, unit.fontWeight, unit.color, unit.marginLeft]).toEqual([
      "11.5px",
      "400",
      rgb("#e2dfd9"),
      "3px",
    ]);
  });

  it("has no unit element for a value without one", () => {
    render(<FullMapHoverCard rows={[{ label: "Aim", value: "3.93" }]} />);
    expect(screen.getByText("3.93").children).toHaveLength(0);
  });

  describe("bars", () => {
    const bars = () => screen.queryAllByTestId("hover-card-bar");
    const fill = (bar: HTMLElement) => bar.firstElementChild as HTMLElement;

    it("draws a 2px bar under each row with a share, once two rows have one", () => {
      render(<FullMapHoverCard rows={rows} />);
      expect(bars()).toHaveLength(2);
      const [first, second] = bars();
      for (const bar of bars()) {
        const style = getComputedStyle(bar);
        expect([style.height, style.backgroundColor, style.gridColumn]).toEqual([
          "2px",
          "rgba(255, 255, 255, 0.14)",
          "1/-1",
        ]);
        expect(style.borderRadius).toBe("");
        expect(getComputedStyle(fill(bar)).backgroundColor).toBe("rgba(245, 244, 241, 0.6)");
        expect(getComputedStyle(fill(bar)).height).toBe("100%");
      }
      // Each under its own row, spanning both columns.
      expect(screen.getByText("251.24").nextElementSibling).toBe(first);
      expect(screen.getByText("312.50").nextElementSibling).toBe(second);
      expect(getComputedStyle(fill(first)).width).toBe("80%");
      expect(getComputedStyle(fill(second)).width).toBe("100%");
      // 5px below it, except after the last.
      expect(getComputedStyle(first).marginBottom).toBe("5px");
      expect(getComputedStyle(second).marginBottom).toMatch(/^(0(px)?)?$/);
    });

    it("never draws a bar in a card of one row", () => {
      render(<FullMapHoverCard rows={[{ label: "Effective miss", value: "2.38", share: 1 }]} />);
      expect(bars()).toHaveLength(0);
    });

    it("never draws a bar when only one row has a share", () => {
      render(
        <FullMapHoverCard
          rows={[
            { label: "Peak", value: "251.24", share: 1 },
            { label: "If FC", value: "312.50" },
          ]}
        />,
      );
      expect(bars()).toHaveLength(0);
    });

    it("leaves out a share that is not a number, and draws the others when there are two", () => {
      render(
        <FullMapHoverCard
          rows={[
            { label: "A", value: "1", share: 0.5 },
            { label: "B", value: "2", share: Number.NaN },
            { label: "C", value: "3", share: 1 },
          ]}
        />,
      );
      expect(bars()).toHaveLength(2);
      expect(screen.getByText("2").nextElementSibling?.getAttribute("data-testid")).not.toBe("hover-card-bar");
    });

    it("keeps a share inside the track", () => {
      render(
        <FullMapHoverCard
          rows={[
            { label: "A", value: "1", share: -1 },
            { label: "B", value: "2", share: 3 },
          ]}
        />,
      );
      expect(bars().map((bar) => getComputedStyle(fill(bar)).width)).toEqual(["0%", "100%"]);
    });
  });
});

describe("fullMapHoverCardSlotProps", () => {
  it("makes a tooltip exactly this card: near black, 2px corners, an edge, opaque, no width cap", async () => {
    render(
      <Tooltip arrow slotProps={fullMapHoverCardSlotProps} title={<FullMapHoverCard rows={rows} />}>
        <button type="button">trigger</button>
      </Tooltip>,
    );
    fireEvent.mouseOver(screen.getByText("trigger"));
    const tooltip = await screen.findByRole("tooltip");
    const surface = tooltip.querySelector(".MuiTooltip-tooltip") as HTMLElement;
    const style = getComputedStyle(surface);
    expect(style.backgroundColor).toBe(rgb("#0f1013"));
    expect(style.borderRadius).toBe("2px");
    expect(style.padding).toBe("8px 11px 9px");
    expect(style.maxWidth).toBe("none");
    expect(style.boxShadow.replace(/ /g, "")).toBe("inset0001pxrgba(255,255,255,0.22),06px18pxrgba(0,0,0,0.6)");
    expect(style.opacity === "" || style.opacity === "1").toBe(true);
    expect(within(surface).getByText("Peak")).toBeTruthy();
  });

  it("gives the arrow the card's own fill and light edge, not the default grey", async () => {
    render(
      <Tooltip arrow slotProps={fullMapHoverCardSlotProps} title={<FullMapHoverCard rows={rows} />}>
        <button type="button">trigger</button>
      </Tooltip>,
    );
    fireEvent.mouseOver(screen.getByText("trigger"));
    const arrow = (await screen.findByRole("tooltip")).querySelector(".MuiTooltip-arrow") as HTMLElement;
    expect(arrow).not.toBeNull();
    // The fill is the arrow's colour (its pseudo-element paints with currentColor).
    expect(getComputedStyle(arrow).color).toBe(rgb("#0f1013"));
    // The edge is drawn on the pseudo-element, so it is read from the style rules.
    const classes = Array.from(arrow.classList).filter((name) => name.startsWith("css-"));
    const rules = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText)
      .filter((text) => text.includes("::before") && classes.some((name) => text.includes("." + name)));
    expect(rules.join("").replace(/ /g, "")).toContain("box-shadow:inset0001pxrgba(255,255,255,0.22)");
    // It reaches 1px into the card, so the card's own edge does not run along the arrow's base: down under the
    // card, up when the card is above its anchor.
    const shifts = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText.replace(/ /g, ""))
      .filter((text) => classes.some((name) => text.includes("." + name)) && text.includes("translate:"));
    expect(shifts.some((text) => text.includes("translate:01px") && !text.includes("popper"))).toBe(true);
    expect(shifts.some((text) => text.includes('data-popper-placement*="top"') && text.includes("translate:0-1px"))).toBe(true);
  });
});
