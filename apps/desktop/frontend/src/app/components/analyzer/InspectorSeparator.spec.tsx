import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { InspectorSeparator } from "./InspectorSeparator";

/** Parent that owns the width the way Analyzer does: live while dragging, committed at the end. */
function Harness({
  initial = 340,
  min = 240,
  max = 440,
  onCommit = jest.fn(),
  onResize = jest.fn(),
  onKeyDownAbove = jest.fn(),
}: {
  initial?: number;
  min?: number;
  max?: number;
  onCommit?: (width: number) => void;
  onResize?: (width: number) => void;
  onKeyDownAbove?: (event: React.KeyboardEvent) => void;
}) {
  const [width, setWidth] = useState(initial);
  return (
    <div onKeyDown={onKeyDownAbove}>
      <InspectorSeparator
        width={width}
        min={min}
        max={max}
        onResize={(next) => {
          onResize(next);
          setWidth(next);
        }}
        onCommit={(next) => {
          onCommit(next);
          setWidth(next);
        }}
      />
    </div>
  );
}

/** jsdom has no PointerEvent: a MouseEvent of the pointer type carries the pointer id like the real one does. */
function pointer(element: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", init: { pointerId: number; clientX?: number; button?: number }) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, button: init.button ?? 0 });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  fireEvent(element, event);
}

function separator() {
  return screen.getByRole("separator", { name: "Resize inspector" });
}

describe("InspectorSeparator", () => {
  it("is a focusable vertical separator exposing its range", () => {
    render(<Harness initial={400} min={240} max={440} />);
    const element = separator();
    expect(element.getAttribute("aria-orientation")).toBe("vertical");
    expect(element.getAttribute("aria-valuemin")).toBe("240");
    expect(element.getAttribute("aria-valuemax")).toBe("440");
    expect(element.getAttribute("aria-valuenow")).toBe("400");
    expect(element.tabIndex).toBe(0);
  });

  it("is a 6 px col-resize strip that straddles the column's left edge", () => {
    render(<Harness />);
    const style = getComputedStyle(separator());
    expect(style.width).toBe("6px");
    expect(style.cursor).toBe("col-resize");
    expect(style.position).toBe("absolute");
    expect(style.left).toBe("-3px");
    expect(style.top).toBe("0px");
    expect(style.bottom).toBe("0px");
  });

  it("widens as the pointer moves left, live, and commits once on release", () => {
    const onResize = jest.fn();
    const onCommit = jest.fn();
    render(<Harness onResize={onResize} onCommit={onCommit} />);
    const element = separator();
    pointer(element, "pointerdown", { pointerId: 1, button: 0, clientX: 1000 });
    pointer(element, "pointermove", { pointerId: 1, clientX: 950 });
    expect(onResize).toHaveBeenLastCalledWith(390);
    expect(element.getAttribute("aria-valuenow")).toBe("390");
    pointer(element, "pointermove", { pointerId: 1, clientX: 1040 });
    expect(onResize).toHaveBeenLastCalledWith(300);
    pointer(element, "pointermove", { pointerId: 1, clientX: 900 });
    expect(onResize).toHaveBeenLastCalledWith(440);
    expect(onCommit).not.toHaveBeenCalled();
    pointer(element, "pointerup", { pointerId: 1, clientX: 900 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(440);
    // After release, further movement does nothing.
    pointer(element, "pointermove", { pointerId: 1, clientX: 100 });
    expect(onResize).toHaveBeenLastCalledWith(440);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("limits the drag to the range", () => {
    const onCommit = jest.fn();
    render(<Harness min={240} max={440} onCommit={onCommit} />);
    const element = separator();
    pointer(element, "pointerdown", { pointerId: 1, button: 0, clientX: 1000 });
    pointer(element, "pointermove", { pointerId: 1, clientX: 0 });
    expect(element.getAttribute("aria-valuenow")).toBe("440");
    pointer(element, "pointermove", { pointerId: 1, clientX: 5000 });
    expect(element.getAttribute("aria-valuenow")).toBe("240");
    pointer(element, "pointerup", { pointerId: 1, clientX: 5000 });
    expect(onCommit).toHaveBeenCalledWith(240);
  });

  it("uses pointer capture where it exists and works without it", () => {
    const set = jest.fn();
    const release = jest.fn();
    render(<Harness />);
    const element = separator();
    // jsdom has no pointer-capture API: the drag above worked without it. Add it and check the pairing.
    Object.assign(element, { setPointerCapture: set, releasePointerCapture: release, hasPointerCapture: () => true });
    pointer(element, "pointerdown", { pointerId: 7, button: 0, clientX: 500 });
    expect(set).toHaveBeenCalledWith(7);
    pointer(element, "pointermove", { pointerId: 7, clientX: 480 });
    pointer(element, "pointerup", { pointerId: 7, clientX: 480 });
    expect(release).toHaveBeenCalledWith(7);
  });

  it("ignores moves from a drag it did not start and non-primary buttons", () => {
    const onResize = jest.fn();
    render(<Harness onResize={onResize} />);
    const element = separator();
    pointer(element, "pointermove", { pointerId: 1, clientX: 100 });
    pointer(element, "pointerdown", { pointerId: 1, button: 2, clientX: 500 });
    pointer(element, "pointermove", { pointerId: 1, clientX: 100 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("does not write a value for a click without movement", () => {
    const onCommit = jest.fn();
    render(<Harness onCommit={onCommit} />);
    pointer(separator(), "pointerdown", { pointerId: 1, button: 0, clientX: 500 });
    pointer(separator(), "pointerup", { pointerId: 1, clientX: 500 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits the width reached when the drag is cancelled", () => {
    const onCommit = jest.fn();
    render(<Harness onCommit={onCommit} />);
    const element = separator();
    pointer(element, "pointerdown", { pointerId: 1, button: 0, clientX: 500 });
    pointer(element, "pointermove", { pointerId: 1, clientX: 460 });
    pointer(element, "pointercancel", { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledWith(380);
  });

  it("commits the live width if it is removed in the middle of a drag", () => {
    const onCommit = jest.fn();
    const { unmount } = render(<Harness onCommit={onCommit} />);
    const element = separator();
    pointer(element, "pointerdown", { pointerId: 1, button: 0, clientX: 500 });
    pointer(element, "pointermove", { pointerId: 1, clientX: 450 });
    unmount();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(390);
  });

  it.each([
    ["ArrowLeft", {}, 356],
    ["ArrowRight", {}, 324],
    ["ArrowLeft", { shiftKey: true }, 404],
    ["ArrowRight", { shiftKey: true }, 276], // 340 − 64
    ["Home", {}, 440],
    ["End", {}, 240],
  ])("%s %j commits %i", (key, init, expected) => {
    const onCommit = jest.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.keyDown(separator(), { key, ...init });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(expected);
    expect(separator().getAttribute("aria-valuenow")).toBe(String(expected));
  });

  it("stops at the limits and keeps stepping from where it is", () => {
    const onCommit = jest.fn();
    render(<Harness initial={430} onCommit={onCommit} />);
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    expect(onCommit.mock.calls).toEqual([[440], [440]]);
    fireEvent.keyDown(separator(), { key: "ArrowRight" });
    expect(onCommit).toHaveBeenLastCalledWith(424);
  });

  it("limits a step to the minimum", () => {
    const onCommit = jest.fn();
    render(<Harness initial={250} onCommit={onCommit} />);
    fireEvent.keyDown(separator(), { key: "ArrowRight", shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(240);
  });

  it("keeps handled keys from reaching the global shortcuts and leaves other keys alone", () => {
    const above = jest.fn();
    render(<Harness onKeyDownAbove={above} />);
    const element = separator();
    const left = fireEvent.keyDown(element, { key: "ArrowLeft" });
    expect(left).toBe(false); // default prevented
    fireEvent.keyDown(element, { key: "Home" });
    fireEvent.keyDown(element, { key: "End" });
    expect(above).not.toHaveBeenCalled();
    fireEvent.keyDown(element, { key: "a" });
    expect(above).toHaveBeenCalledTimes(1);
  });

  it("resets to 260 px on double-click", () => {
    const onCommit = jest.fn();
    render(<Harness initial={500} onCommit={onCommit} />);
    fireEvent.doubleClick(separator());
    expect(onCommit).toHaveBeenCalledWith(260);
    expect(separator().getAttribute("aria-valuenow")).toBe("260");
  });

  it("can take keyboard focus", () => {
    render(<Harness />);
    separator().focus();
    expect(document.activeElement).toBe(separator());
  });

  it("does not keep focus after a pointer drag, so the arrow keys still step the replay", () => {
    const onCommit = jest.fn();
    const onKeyDownAbove = jest.fn();
    render(<Harness onCommit={onCommit} onKeyDownAbove={onKeyDownAbove} />);
    const element = separator();
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 1000, button: 0 });
    Object.defineProperty(down, "pointerId", { value: 1 });
    fireEvent(element, down);
    // Still no text selection, and so no focus from the press either.
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(element);
    pointer(element, "pointermove", { pointerId: 1, clientX: 960 });
    pointer(element, "pointerup", { pointerId: 1, clientX: 960 });
    expect(onCommit).toHaveBeenCalledWith(380);
    expect(document.activeElement).not.toBe(element);
    expect(document.activeElement).toBe(document.body);
    // An arrow key now goes to the page, not to the separator: the width stays.
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(element.getAttribute("aria-valuenow")).toBe("380");
  });
});

describe("InspectorSeparator text selection during a drag", () => {
  const selectStart = () => {
    const event = new Event("selectstart", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  };

  afterEach(() => {
    document.documentElement.style.userSelect = "";
  });

  it("stops the page from selecting text for the length of a pointer drag, then restores it", () => {
    document.documentElement.style.userSelect = "auto";
    render(<Harness />);
    const element = separator();
    expect(selectStart()).toBe(false);
    pointer(element, "pointerdown", { pointerId: 1, button: 0, clientX: 1000 });
    expect(document.documentElement.style.userSelect).toBe("none");
    expect(selectStart()).toBe(true);
    pointer(element, "pointermove", { pointerId: 1, clientX: 960 });
    expect(document.documentElement.style.userSelect).toBe("none");
    pointer(element, "pointerup", { pointerId: 1, clientX: 960 });
    expect(document.documentElement.style.userSelect).toBe("auto");
    expect(selectStart()).toBe(false);
  });

  it("does nothing to the page for a press that is not a primary-button drag", () => {
    render(<Harness />);
    pointer(separator(), "pointerdown", { pointerId: 1, button: 2, clientX: 1000 });
    expect(document.documentElement.style.userSelect).toBe("");
    expect(selectStart()).toBe(false);
  });

  it("restores it when the drag is cancelled", () => {
    render(<Harness />);
    const element = separator();
    pointer(element, "pointerdown", { pointerId: 1, button: 0, clientX: 1000 });
    pointer(element, "pointercancel", { pointerId: 1 });
    expect(document.documentElement.style.userSelect).toBe("");
    expect(selectStart()).toBe(false);
  });

  it("restores it when the separator is removed in the middle of a drag", () => {
    const { unmount } = render(<Harness />);
    pointer(separator(), "pointerdown", { pointerId: 1, button: 0, clientX: 1000 });
    expect(selectStart()).toBe(true);
    unmount();
    expect(document.documentElement.style.userSelect).toBe("");
    expect(selectStart()).toBe(false);
  });

  it("ends the drag, and restores selection, when the release arrives somewhere else", () => {
    // Capture can fail or be lost (the window lost the mouse); the release then goes to whatever is under the pointer.
    const onCommit = jest.fn();
    render(<Harness onCommit={onCommit} />);
    const element = separator();
    pointer(element, "pointerdown", { pointerId: 1, button: 0, clientX: 1000 });
    pointer(element, "pointermove", { pointerId: 1, clientX: 960 });
    pointer(document.body, "pointerup", { pointerId: 1, clientX: 960 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(380);
    expect(document.documentElement.style.userSelect).toBe("");
    // Further movement is not a drag any more.
    pointer(element, "pointermove", { pointerId: 1, clientX: 100 });
    expect(element.getAttribute("aria-valuenow")).toBe("380");
  });

  it("ends the drag when the capture is lost or the window loses the pointer", () => {
    const onCommit = jest.fn();
    render(<Harness onCommit={onCommit} />);
    const element = separator();
    pointer(element, "pointerdown", { pointerId: 1, button: 0, clientX: 1000 });
    pointer(element, "pointermove", { pointerId: 1, clientX: 970 });
    fireEvent.blur(window);
    expect(onCommit).toHaveBeenCalledWith(370);
    expect(document.documentElement.style.userSelect).toBe("");
  });

  it("keeps the browser from starting a selection or taking focus on a primary press (mousedown), also when the pointer press is not cancelled", () => {
    render(<Harness />);
    const press = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    fireEvent(separator(), press);
    expect(press.defaultPrevented).toBe(true);
    const secondary = new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true });
    fireEvent(separator(), secondary);
    expect(secondary.defaultPrevented).toBe(false);
  });

  it("gives up a focus that a press put on the strip (Chromium focuses it despite the cancelled pointerdown)", () => {
    render(<Harness />);
    const element = separator();
    pointer(element, "pointerdown", { pointerId: 1, button: 0, clientX: 1000 });
    element.focus(); // what the browser's default press handling does after the event
    expect(document.activeElement).toBe(element);
    pointer(element, "pointermove", { pointerId: 1, clientX: 990 });
    pointer(element, "pointerup", { pointerId: 1, clientX: 990 });
    expect(document.activeElement).not.toBe(element);
  });

  it("keeps keyboard focus on the strip when it is only focused with Tab", () => {
    render(<Harness />);
    separator().focus();
    expect(document.activeElement).toBe(separator());
  });

  it("survives pointer-capture calls that throw, as a real browser does for an inactive pointer or a detached node", () => {
    const onCommit = jest.fn();
    render(<Harness onCommit={onCommit} />);
    const element = separator();
    const notFound = () => {
      throw new DOMException("No active pointer with the given id is found.", "NotFoundError");
    };
    Object.assign(element, { setPointerCapture: notFound, releasePointerCapture: notFound });
    pointer(element, "pointerdown", { pointerId: 9, button: 0, clientX: 1000 });
    pointer(element, "pointermove", { pointerId: 9, clientX: 960 });
    expect(() => pointer(element, "pointerup", { pointerId: 9, clientX: 960 })).not.toThrow();
    expect(onCommit).toHaveBeenCalledWith(380);
  });
});
