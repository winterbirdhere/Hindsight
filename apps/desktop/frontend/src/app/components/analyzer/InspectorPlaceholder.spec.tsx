import { render, screen } from "@testing-library/react";
import { InspectorPlaceholder } from "./InspectorPlaceholder";

describe("InspectorPlaceholder", () => {
  it("says what appears once a replay is open when idle", () => {
    render(<InspectorPlaceholder state={{ phase: "idle" }} />);
    expect(screen.getByText("The map, player and incidents appear here once a replay is open.")).toBeTruthy();
    expect(screen.queryByText("ERRORS")).toBeNull();
  });

  it("outlines the errors and incidents blocks while loading, as one busy region", () => {
    const { container } = render(<InspectorPlaceholder state={{ phase: "loading", step: "find-beatmap" }} />);
    expect(screen.getByText("ERRORS")).toBeTruthy();
    expect(screen.getByText("Incidents")).toBeTruthy();
    expect(screen.getByText("Waiting for simulation")).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    // Decorative bars are hidden from assistive technology and never animate.
    const bars = container.querySelectorAll('[aria-hidden="true"]');
    expect(bars.length).toBeGreaterThanOrEqual(7);
    for (const bar of Array.from(bars)) expect(getComputedStyle(bar).animationName).toBe("");
  });

  it("explains that nothing is shown until the replay loads after a failure", () => {
    const { container } = render(
      <InspectorPlaceholder state={{ phase: "failed", failure: { kind: "other", message: "x" } }} />,
    );
    expect(screen.getByText("ERRORS")).toBeTruthy();
    expect(screen.getByText("Nothing to show until the replay loads.")).toBeTruthy();
    expect(container.querySelector("[aria-busy]")).toBeNull();
  });
});
