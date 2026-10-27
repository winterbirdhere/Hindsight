import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReplayResultNotice } from "./ReplayResultNotice";
import type { ReplaySimulationValidation } from "../../services/common/game/GameSimulator";
import { REWIND_COLORS } from "../../styles/tokens";

const mismatch: ReplaySimulationValidation = {
  verified: false,
  expectedCounts: [5, 0, 0, 0],
  simulatedCounts: [4, 0, 0, 1],
  expectedMaxCombo: 5,
  simulatedMaxCombo: 3,
  judgementTotalsMatch: false,
  missCountMatch: false,
  maxComboMatch: false,
  warnings: ["Internal diagnostic should not be the user explanation"],
};

const item = () => screen.getByRole("note", { name: "Saved score differs" });
const noItem = () => expect(screen.queryByRole("note", { name: "Saved score differs" })).toBeNull();
/** Lets MUI's enter delay pass, to show that no card came. */
const letTooltipDelayPass = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
const cardLines = (tooltip: HTMLElement) =>
  Array.from(tooltip.querySelectorAll(".MuiTooltip-tooltip > div > div")).map((line) => line.textContent);

describe("the saved-score note", () => {
  const postFailureValidation = {
    ...mismatch,
    expectedCounts: [4, 0, 0, 16],
    simulatedCounts: [4, 0, 0, 1],
    expectedMaxCombo: 3,
    postFailureMisses: { count: 15, scoringEndTime: 7000, recordedEndTime: 7300 },
  };

  it("is not shown for an exactly attributed post-failure miss difference", () => {
    const { container } = render(<ReplayResultNotice validation={postFailureValidation} sourceRuleset="stable" ruleset="stable" />);
    expect(container.textContent).toBe("");
    noItem();
  });

  it("is shown for a combo disagreement even when the misses are attributed", () => {
    render(
      <ReplayResultNotice validation={{ ...postFailureValidation, expectedMaxCombo: 5 }} sourceRuleset="stable" ruleset="stable" />,
    );
    item();
  });

  it.each([
    { expectedCounts: [5, 0, 0, 16] },
    { postFailureMisses: undefined },
    { postFailureMisses: { count: 14, scoringEndTime: 7000, recordedEndTime: 7300 } },
    { postFailureMisses: { count: 0, scoringEndTime: 7000, recordedEndTime: 7300 } },
    { expectedCounts: [4, 0, 0, 0] },
  ])("is shown when the attribution does not exactly explain the difference: %j", (change) => {
    render(<ReplayResultNotice validation={{ ...postFailureValidation, ...change }} sourceRuleset="stable" ruleset="stable" />);
    item();
  });

  it("is one quiet line of text: not a button, no popover, no icon, no box", () => {
    render(<ReplayResultNotice validation={mismatch} sourceRuleset="stable" ruleset="stable" />);
    const note = item();
    expect(note.textContent).toBe("Saved score differs");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(note.querySelector("svg")).toBeNull();
    const style = getComputedStyle(note);
    expect([style.fontSize, style.fontWeight]).toEqual(["12px", "500"]);
    expect(style.color).toBe("rgb(201, 198, 192)");
    expect(REWIND_COLORS.textSecondary).toBe("#c9c6c0");
    expect(style.backgroundColor).toMatch(/^(|transparent|rgba\(0, 0, 0, 0\))$/);
    expect(note.getAttribute("tabindex")).toBe("0");
  });

  it("keeps none of the old popover's colours or 8px radius", () => {
    render(<ReplayResultNotice validation={mismatch} sourceRuleset="stable" ruleset="stable" />);
    fireEvent.mouseOver(item());
    const css = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .map((rule) => rule.cssText)
      .join("\n")
      .toLowerCase();
    for (const old of ["#20252d", "#e9edf2", "#b7bfcc", "rgb(32, 37, 45)", "rgb(233, 237, 242)", "rgb(183, 191, 204)"]) {
      expect([old, css.includes(old)]).toEqual([old, false]);
    }
  });

  it("shows a three-line card on hover, for a Stable replay", async () => {
    render(<ReplayResultNotice validation={mismatch} sourceRuleset="stable" ruleset="stable" />);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseOver(item());
    const tooltip = await screen.findByRole("tooltip");
    expect(cardLines(tooltip)).toEqual([
      "Cause not confirmed",
      "Possibly a resume keypress read as an early tap.",
      "Analysis uses Hindsight’s counts.",
    ]);
    // The card is the item's description, in the page's card style, and nothing else is in it.
    expect(item().getAttribute("aria-describedby")).toBe(tooltip.id);
    const card = tooltip.querySelector(".MuiTooltip-tooltip") as HTMLElement;
    expect(getComputedStyle(card).backgroundColor).toBe("rgb(15, 16, 19)");
    expect(getComputedStyle(card).borderRadius).toBe("2px");
    expect(tooltip.querySelector("table, button, h1, h2, h3")).toBeNull();
    expect(tooltip.querySelector(".MuiTooltip-arrow")).not.toBeNull();
    fireEvent.mouseLeave(item());
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("sets the card's lines: white 600, then Bright 400, then Bright 400 six pixels lower, 12.5px / 1.4 in 250px", async () => {
    render(<ReplayResultNotice validation={mismatch} sourceRuleset="stable" ruleset="stable" />);
    fireEvent.mouseOver(item());
    const tooltip = await screen.findByRole("tooltip");
    const lines = Array.from(tooltip.querySelectorAll(".MuiTooltip-tooltip > div > div")) as HTMLElement[];
    const [title, cause, basis] = lines.map((line) => getComputedStyle(line));
    expect([title.color, title.fontWeight]).toEqual(["rgb(255, 255, 255)", "600"]);
    expect([cause.color, cause.fontWeight]).toEqual(["rgb(226, 223, 217)", "400"]);
    expect([basis.color, basis.fontWeight, basis.marginTop]).toEqual(["rgb(226, 223, 217)", "400", "6px"]);
    const box = getComputedStyle(lines[0].parentElement as HTMLElement);
    expect([box.maxWidth, box.fontSize, box.lineHeight]).toEqual(["250px", "12.5px", "1.4"]);
  });

  it("names a Lazer replay's possible cause without the Stable-specific keypress", async () => {
    render(<ReplayResultNotice validation={mismatch} sourceRuleset="lazer" ruleset="lazer" />);
    fireEvent.mouseOver(item());
    const tooltip = await screen.findByRole("tooltip");
    expect(cardLines(tooltip)).toEqual([
      "Cause not confirmed",
      "Possibly missing replay data or a simulation error.",
      "Analysis uses Hindsight’s counts.",
    ]);
    expect(tooltip.textContent).not.toMatch(/resume keypress/i);
  });

  it("shows the same card on keyboard focus", async () => {
    render(<ReplayResultNotice validation={mismatch} sourceRuleset="stable" ruleset="stable" />);
    fireEvent.keyDown(document.body, { key: "Tab", code: "Tab" });
    act(() => item().focus());
    expect(cardLines(await screen.findByRole("tooltip"))).toHaveLength(3);
  });

  it("is not shown when saved totals are absent, even if validation has warnings", () => {
    const { container } = render(
      <ReplayResultNotice
        validation={{ verified: false, simulatedCounts: [0, 0, 0, 0], simulatedMaxCombo: 0, warnings: ["Unavailable"] }}
        sourceRuleset="stable"
        ruleset="stable"
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("goes away when matching replay results arrive", () => {
    const { rerender } = render(<ReplayResultNotice validation={mismatch} sourceRuleset="stable" ruleset="stable" />);
    item();
    rerender(
      <ReplayResultNotice
        validation={{ ...mismatch, simulatedCounts: [5, 0, 0, 0], simulatedMaxCombo: 5 }}
        sourceRuleset="stable"
        ruleset="stable"
      />,
    );
    noItem();
  });

  it("is shown for a combo-only difference", () => {
    render(<ReplayResultNotice validation={{ ...mismatch, simulatedCounts: [5, 0, 0, 0] }} sourceRuleset="stable" ruleset="stable" />);
    item();
  });

  it.each([
    ["stable", "lazer"],
    ["lazer", "stable"],
  ] as const)(
    "does not report saved-data inconsistency when viewing %s reconstruction of a %s replay",
    async (ruleset, sourceRuleset) => {
      render(<ReplayResultNotice validation={mismatch} sourceRuleset={sourceRuleset} ruleset={ruleset} />);
      noItem();
      expect(screen.queryByText(/Saved score differs/i)).toBeNull();
      await letTooltipDelayPass();
      expect(screen.queryByRole("tooltip")).toBeNull();
    },
  );
});
