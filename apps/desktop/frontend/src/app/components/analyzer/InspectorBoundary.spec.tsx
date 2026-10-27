import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { REWIND_COLORS } from "../../styles/tokens";
import { InspectorBoundary } from "./InspectorBoundary";

const control = { fail: true, failOnCleanup: false };

function Child() {
  if (control.fail) throw new Error("render failure");
  return <p>inspector content</p>;
}

function CleanupFails() {
  useEffect(
    () => () => {
      if (control.failOnCleanup) throw new Error("cleanup failure");
    },
    [],
  );
  return <p>inspector content</p>;
}

let consoleError: jest.SpyInstance;
beforeEach(() => {
  control.fail = true;
  control.failOnCleanup = false;
  consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => consoleError.mockRestore());

describe("InspectorBoundary", () => {
  it("renders its children untouched while nothing fails", () => {
    control.fail = false;
    render(
      <InspectorBoundary>
        <Child />
      </InspectorBoundary>,
    );
    expect(screen.getByText("inspector content")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says one neutral line with a text button, and logs the error with its component stack", () => {
    render(
      <div>
        <p>stage and dock</p>
        <InspectorBoundary>
          <Child />
        </InspectorBoundary>
      </div>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("The inspector hit an error.Reload inspector");
    expect(screen.getByText("The inspector hit an error.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload inspector" })).toBeTruthy();
    // The rest of the page is still there.
    expect(screen.getByText("stage and dock")).toBeTruthy();
    const logged = consoleError.mock.calls.find((call) => call[0] === "The inspector hit an error.");
    expect(logged).toBeTruthy();
    expect((logged?.[1] as Error).message).toBe("render failure");
    expect(String(logged?.[2])).toMatch(/Child/);
  });

  it("uses the 3a surface and text tokens", () => {
    render(
      <InspectorBoundary frameSx={{ width: 300 }}>
        <Child />
      </InspectorBoundary>,
    );
    const style = getComputedStyle(screen.getByRole("alert"));
    expect(style.backgroundColor).toBe("rgb(26, 27, 32)"); // REWIND_COLORS.surface #1a1b20
    expect(REWIND_COLORS.surface).toBe("#1a1b20");
    expect(style.fontSize).toBe("13px");
    expect(style.width).toBe("300px");
  });

  it("tries again on Reload inspector, and keeps the message while the error persists", () => {
    render(
      <InspectorBoundary>
        <Child />
      </InspectorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload inspector" }));
    // Still failing: the message returns.
    expect(screen.getByRole("alert")).toBeTruthy();
    control.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload inspector" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("inspector content")).toBeTruthy();
  });

  it("catches an error thrown while the inspector is being removed, because the boundary stays mounted", () => {
    const view = (shown: boolean) => (
      <div>
        <p>stage and dock</p>
        <InspectorBoundary active={shown}>{shown && <CleanupFails />}</InspectorBoundary>
      </div>
    );
    const { rerender } = render(view(true));
    control.failOnCleanup = true;
    rerender(view(false));
    // The fold: no message in a place the inspector no longer has, and the page stays.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("stage and dock")).toBeTruthy();
    expect(consoleError.mock.calls.some((call) => call[0] === "The inspector hit an error.")).toBe(true);
    // Shown again: a fresh start.
    control.failOnCleanup = false;
    rerender(view(true));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("inspector content")).toBeTruthy();
  });

  it("forgets an error when the inspector is hidden and shown again", () => {
    const view = (shown: boolean) => (
      <InspectorBoundary active={shown}>{shown && <Child />}</InspectorBoundary>
    );
    const { rerender } = render(view(true));
    expect(screen.getByRole("alert")).toBeTruthy();
    rerender(view(false));
    expect(screen.queryByRole("alert")).toBeNull();
    control.fail = false;
    rerender(view(true));
    expect(screen.getByText("inspector content")).toBeTruthy();
  });
});
