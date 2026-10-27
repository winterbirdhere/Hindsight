import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { ReplayComparisonParticipantSummary } from "../../services/analysis/replay-comparison";
import { ReplayComparisonDialog, ReplayComparisonValues } from "./ReplayComparisonDialog";

const primary: ReplayComparisonParticipantSummary = {
  counts: { count300: 800, count100: 12, count50: 3, countMiss: 2, total: 817 },
  sliderBreakCount: 4,
  accuracy: 0.98,
  maxComboInput: 456,
  scoreInput: 1_234_567,
};

const secondary: ReplayComparisonParticipantSummary = {
  counts: { count300: 790, count100: 20, count50: 4, countMiss: 3, total: 817 },
  sliderBreakCount: 1,
  accuracy: 0.97,
  maxComboInput: 500,
  scoreInput: 1_200_000,
};

const renderValues = (ruleset: "stable" | "lazer") =>
  render(
    <ReplayComparisonValues
      primaryLabel="Primary player"
      secondaryLabel="Reference player"
      secondaryKind="replay"
      primary={primary}
      secondary={secondary}
      ruleset={ruleset}
    />,
  );

describe("ReplayComparisonValues", () => {
  it("keeps the comparison to the six requested Stable values", () => {
    const { container } = renderValues("stable");
    const table = screen.getByRole("table", { name: "Replay score comparison" });
    const valueRows = within(table).getAllByRole("row").slice(1);

    expect(valueRows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual([
      "Score",
      "300",
      "100",
      "50",
      "Miss / Slider Break",
      "Max Combo",
    ]);
    expect(Array.from(valueRows[4].querySelectorAll("td"), (cell) => cell.textContent)).toEqual(["2 / 4", "3 / 1"]);
    expect(Array.from(valueRows[0].querySelectorAll("td"), (cell) => cell.textContent)).toEqual([
      "1,234,567",
      "1,200,000",
    ]);
    expect(container.textContent).not.toContain("×");
    expect(container.textContent).not.toContain("Accuracy");
  });

  it("removes slider-break values and wording in lazer mode", () => {
    renderValues("lazer");
    const missRow = screen.getByRole("rowheader", { name: "Miss" }).parentElement;

    expect(missRow).toBeTruthy();
    expect(Array.from(missRow?.querySelectorAll("td") ?? [], (cell) => cell.textContent)).toEqual(["2", "3"]);
    expect(screen.queryByText("Slider Break")).toBeNull();
  });

  it("closes without clearing the ready comparison, while Clear performs both actions", () => {
    const state = {
      status: "READY",
      sourceKind: "replay",
      ruleset: "stable",
      primary: { label: "Primary player" },
      secondary: { label: "Reference player", kind: "replay" },
      result: {
        primarySummary: primary,
        secondarySummary: secondary,
        compatibility: { issues: [] },
        participantLimitations: { primary: [], secondary: [] },
      },
      validations: {
        primary: { verified: true, simulatedCounts: [800, 12, 3, 2], simulatedMaxCombo: 456, warnings: [] },
        secondary: { verified: true, simulatedCounts: [790, 20, 4, 3], simulatedMaxCombo: 500, warnings: [] },
      },
    } as unknown as ComponentProps<typeof ReplayComparisonDialog>["state"];
    const onClose = jest.fn();
    const onClear = jest.fn();
    const { unmount } = render(<ReplayComparisonDialog open state={state} onClose={onClose} onClear={onClear} />);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
    unmount();

    render(<ReplayComparisonDialog open state={state} onClose={onClose} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Exit comparison" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("uses the ruleset stored in the ready snapshot", () => {
    const state = {
      status: "READY",
      sourceKind: "replay",
      ruleset: "lazer",
      primary: { label: "Primary player" },
      secondary: { label: "Reference player", kind: "replay" },
      result: {
        primarySummary: primary,
        secondarySummary: secondary,
        compatibility: { issues: [] },
        participantLimitations: { primary: [], secondary: [] },
      },
      validations: {
        primary: { verified: true, simulatedCounts: [800, 12, 3, 2], simulatedMaxCombo: 456, warnings: [] },
        secondary: { verified: true, simulatedCounts: [790, 20, 4, 3], simulatedMaxCombo: 500, warnings: [] },
      },
    } as unknown as ComponentProps<typeof ReplayComparisonDialog>["state"];

    render(<ReplayComparisonDialog open state={state} onClose={jest.fn()} onClear={jest.fn()} />);

    expect(screen.getByRole("heading", { name: "Lazer replay comparison" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Miss" })).toBeTruthy();
    expect(screen.queryByText("Slider Break")).toBeNull();
  });
});
