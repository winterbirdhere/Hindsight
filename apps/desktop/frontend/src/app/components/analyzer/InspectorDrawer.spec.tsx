import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { InspectorDrawer, InspectorToggle } from "./InspectorDrawer";

jest.mock("./Inspector", () => ({ Inspector: () => <section aria-label="Errors" /> }));

function Harness() {
  const [open, setOpen] = useState(false);
  return <InspectorDrawer open={open} onToggle={() => setOpen((value) => !value)} />;
}

it("folds the errors column behind a handle", () => {
  render(<Harness />);
  const handle = screen.getByRole("button", { name: "Show inspector" });
  expect(handle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("region", { name: "Errors" })).toBeNull();
  fireEvent.click(handle);
  expect(screen.getByRole("region", { name: "Errors" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hide inspector" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Hide inspector" }));
  expect(screen.queryByRole("region", { name: "Errors" })).toBeNull();
  expect(screen.getByRole("button", { name: "Show inspector" }).getAttribute("aria-expanded")).toBe("false");
});

it("sizes the overlay to the chosen width and keeps the handle on its left edge", () => {
  render(<InspectorDrawer open width={480} onToggle={() => undefined} />);
  const overlay = screen.getByRole("region", { name: "Errors" }).parentElement as HTMLElement;
  expect(getComputedStyle(overlay).width).toBe("480px");
  expect(getComputedStyle(screen.getByRole("button", { name: "Hide inspector" })).right).toBe("480px");
});

it("defaults the overlay to the 260 px design width", () => {
  render(<InspectorDrawer open onToggle={() => undefined} />);
  expect(getComputedStyle(screen.getByRole("region", { name: "Errors" }).parentElement as HTMLElement).width).toBe("260px");
});

describe("InspectorToggle", () => {
  it("is the same handle on the stage's right edge for the column", () => {
    const onToggle = jest.fn();
    const { rerender } = render(<InspectorToggle open onToggle={onToggle} />);
    const hide = screen.getByRole("button", { name: "Hide inspector" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    expect(getComputedStyle(hide).right).toBe("0px");
    expect(getComputedStyle(hide).width).toBe("16px");
    fireEvent.click(hide);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<InspectorToggle open={false} onToggle={onToggle} />);
    const show = screen.getByRole("button", { name: "Show inspector" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(getComputedStyle(show).right).toBe("0px");
  });

  it("does not take focus on a pointer press, and still takes keyboard focus", () => {
    const onToggle = jest.fn();
    render(<InspectorToggle open onToggle={onToggle} />);
    const toggle = screen.getByRole("button", { name: "Hide inspector" });
    const press = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    fireEvent(toggle, press);
    expect(press.defaultPrevented).toBe(true);
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(toggle);
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
  });

  it("can sit inside an open overlay", () => {
    render(<InspectorToggle open offset={400} onToggle={() => undefined} />);
    expect(getComputedStyle(screen.getByRole("button", { name: "Hide inspector" })).right).toBe("400px");
  });
});
