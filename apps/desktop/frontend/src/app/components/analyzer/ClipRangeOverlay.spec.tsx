import { fireEvent, render, screen } from "@testing-library/react";
import { ClipRangeOverlay } from "./ClipRangeOverlay";
import { laneTime, withClipEnd, withClipStart, type ClipRange } from "../../services/manager/clip-range";

const DURATION = 200_000;
const RANGE: ClipRange = { startMs: 50_000, endMs: 100_000 };
const LANE_RECT = { left: 16, width: 1200 };

type PointerType = "pointerdown" | "pointermove" | "pointerup" | "pointercancel";

/** jsdom has no PointerEvent: a MouseEvent of the pointer type carries the pointer id like the real one does. */
function pointer(element: Element, type: PointerType, init: { pointerId?: number; clientX?: number; button?: number } = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 0,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  return { notPrevented: fireEvent(element, event), event };
}

function setup({
  range = RANGE,
  locked = false,
  onChange = jest.fn(),
}: { range?: ClipRange; locked?: boolean; onChange?: jest.Mock } = {}) {
  const onParentKeyDown = jest.fn();
  const onParentPointerDown = jest.fn();
  const view = render(
    // The lane: the relatively positioned box the overlay sits in; it is what a drag measures.
    <div
      data-testid="lane"
      style={{ position: "relative" }}
      onKeyDown={onParentKeyDown}
      onPointerDown={onParentPointerDown}
    >
      <ClipRangeOverlay range={range} durationMs={DURATION} locked={locked} onChange={onChange} />
    </div>,
  );
  const lane = screen.getByTestId("lane");
  lane.getBoundingClientRect = () =>
    ({ left: LANE_RECT.left, width: LANE_RECT.width, right: LANE_RECT.left + LANE_RECT.width, top: 0, bottom: 50, height: 50, x: LANE_RECT.left, y: 0 }) as DOMRect;
  return { ...view, lane, onChange, onParentKeyDown, onParentPointerDown };
}

const startEdge = () => screen.getByRole("slider", { name: "Clip start" });
const endEdge = () => screen.getByRole("slider", { name: "Clip end" });
/** The two parts of an edge that take the pointer: above the rail band and below it. */
const part = (edge: "start" | "end", where: "top" | "bottom") => screen.getByTestId(`clip-edge-${edge}-${where}`);

describe("ClipRangeOverlay", () => {
  it("places the outline and the two dim layers by the range", () => {
    setup(); // 50-100 s of 200 s
    const outline = screen.getByTestId("clip-outline");
    expect(outline.style.left).toBe("25%");
    expect(outline.style.width).toBe("25%");
    expect(outline.style.pointerEvents).toBe("");
    expect(getComputedStyle(outline).pointerEvents).toBe("none");
    // The outline's sides use the soft accent, thick left and right.
    expect(outline.style.boxShadow).toContain("inset 3px 0 0 #ff9cbc");
    expect(outline.style.boxShadow).toContain("inset -3px 0 0 #ff9cbc");

    const before = screen.getByTestId("clip-dim-before");
    const after = screen.getByTestId("clip-dim-after");
    expect(before.style.left).toBe("0px");
    expect(before.style.width).toBe("25%");
    expect(after.style.left).toBe("50%");
    expect(after.style.right).toBe("0px");
    // Neither dim layer takes the pointer, so the seek slider below keeps working inside and outside the range.
    expect(getComputedStyle(before).pointerEvents).toBe("none");
    expect(getComputedStyle(after).pointerEvents).toBe("none");
    // The 10 px edges are centred on the outline's sides.
    expect(startEdge().style.left).toBe("calc(25% - 5px)");
    expect(endEdge().style.left).toBe("calc(50% - 5px)");
  });

  it("names both edges and reports their time", () => {
    setup();
    const start = startEdge();
    expect(start.getAttribute("aria-orientation")).toBe("horizontal");
    expect(start.getAttribute("aria-valuetext")).toBe("0:50");
    expect(start.getAttribute("aria-valuenow")).toBe("50000");
    expect(start.getAttribute("aria-valuemin")).toBe("0");
    expect(start.getAttribute("aria-valuemax")).toBe("99750");
    const end = endEdge();
    expect(end.getAttribute("aria-orientation")).toBe("horizontal");
    expect(end.getAttribute("aria-valuetext")).toBe("1:40");
    expect(end.getAttribute("aria-valuenow")).toBe("100000");
    expect(end.getAttribute("aria-valuemin")).toBe("50250");
    expect(end.getAttribute("aria-valuemax")).toBe("200000");
    expect(start.tabIndex).toBe(0);
    for (const where of ["top", "bottom"] as const) expect(part("start", where).style.cursor).toBe("ew-resize");
  });

  it("drags the start edge to the pointer", () => {
    const onChange = jest.fn();
    setup({ onChange });
    const setCapture = jest.fn();
    const releaseCapture = jest.fn();
    Object.assign(part("start", "top"), { setPointerCapture: setCapture, releasePointerCapture: releaseCapture });

    pointer(part("start", "top"), "pointerdown", { pointerId: 4, clientX: 316 });
    expect(setCapture).toHaveBeenCalledWith(4);
    // (316 - 16) / 1200 of 200 s
    pointer(part("start", "top"), "pointermove", { pointerId: 4, clientX: 316 });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_000, endMs: 100_000 });
    // (166 - 16) / 1200 of 200 s
    pointer(part("start", "top"), "pointermove", { pointerId: 4, clientX: 166 });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 25_000, endMs: 100_000 });
    // The lane is measured at the time of the move: past its left side the start is the replay's start.
    pointer(part("start", "top"), "pointermove", { pointerId: 4, clientX: -300 });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 0, endMs: 100_000 });

    pointer(part("start", "top"), "pointerup", { pointerId: 4, clientX: -300 });
    expect(releaseCapture).toHaveBeenCalledWith(4);
    // After the release a move changes nothing.
    onChange.mockClear();
    pointer(part("start", "top"), "pointermove", { pointerId: 4, clientX: 600 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("drags the end edge to the pointer, and a move without a press does nothing", () => {
    const onChange = jest.fn();
    setup({ onChange });
    pointer(part("end", "top"), "pointermove", { clientX: 700 });
    expect(onChange).not.toHaveBeenCalled();

    pointer(part("end", "top"), "pointerdown", { clientX: 616 });
    // (916 - 16) / 1200 of 200 s
    pointer(part("end", "top"), "pointermove", { clientX: 916 });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_000, endMs: 150_000 });
    pointer(part("end", "top"), "pointercancel");
    onChange.mockClear();
    pointer(part("end", "top"), "pointermove", { clientX: 1000 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cannot drag the start past the end, or the end before the start", () => {
    const onChange = jest.fn();
    setup({ onChange });

    // The start dragged far to the right stops 0.25 s before the end.
    pointer(part("start", "top"), "pointerdown", { clientX: 316 });
    pointer(part("start", "top"), "pointermove", { clientX: LANE_RECT.left + LANE_RECT.width });
    const startResult = onChange.mock.calls.at(-1)?.[0];
    expect(startResult).toEqual(withClipStart(RANGE, laneTime(1216, 16, 1200, DURATION), DURATION));
    expect(startResult).toEqual({ startMs: 99_750, endMs: 100_000 });
    pointer(part("start", "top"), "pointerup");

    // The end dragged far to the left stops 0.25 s after the start.
    pointer(part("end", "top"), "pointerdown", { clientX: 616 });
    pointer(part("end", "top"), "pointermove", { clientX: -500 });
    const endResult = onChange.mock.calls.at(-1)?.[0];
    expect(endResult).toEqual(withClipEnd(RANGE, laneTime(-500, 16, 1200, DURATION), DURATION));
    expect(endResult).toEqual({ startMs: 50_000, endMs: 50_250 });
  });

  it("moves an edge with the arrow keys, and by a second with Shift", () => {
    const onChange = jest.fn();
    setup({ onChange });

    fireEvent.keyDown(startEdge(), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_100, endMs: 100_000 });
    fireEvent.keyDown(startEdge(), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 49_900, endMs: 100_000 });
    fireEvent.keyDown(startEdge(), { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 51_000, endMs: 100_000 });
    fireEvent.keyDown(startEdge(), { key: "ArrowLeft", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 49_000, endMs: 100_000 });

    fireEvent.keyDown(endEdge(), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_000, endMs: 100_100 });
    fireEvent.keyDown(endEdge(), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_000, endMs: 99_900 });
    fireEvent.keyDown(endEdge(), { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_000, endMs: 101_000 });
    fireEvent.keyDown(endEdge(), { key: "ArrowLeft", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_000, endMs: 99_000 });
  });

  it("holds the keys to the same clamps as a drag, and ignores other keys", () => {
    const onChange = jest.fn();
    setup({ range: { startMs: 50_000, endMs: 50_500 }, onChange });
    // The end stops 0.25 s after the start; the start at 0.25 s before the end.
    fireEvent.keyDown(endEdge(), { key: "ArrowLeft", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_000, endMs: 50_250 });
    fireEvent.keyDown(startEdge(), { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_250, endMs: 50_500 });
    onChange.mockClear();
    fireEvent.keyDown(startEdge(), { key: "a" });
    fireEvent.keyDown(startEdge(), { key: "Home" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not let an edge key or press reach the timeline", () => {
    const { onChange, onParentKeyDown, onParentPointerDown } = setup();

    fireEvent.keyDown(startEdge(), { key: "ArrowLeft" });
    fireEvent.keyDown(endEdge(), { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onParentKeyDown).not.toHaveBeenCalled();

    // The press is stopped and prevented, so it neither seeks nor takes focus.
    const down = pointer(part("start", "top"), "pointerdown", { clientX: 316 });
    expect(down.notPrevented).toBe(false);
    expect(onParentPointerDown).not.toHaveBeenCalled();
    expect(fireEvent.mouseDown(part("end", "bottom"))).toBe(false);
    expect(document.activeElement).not.toBe(startEdge());
    expect(document.activeElement).not.toBe(endEdge());
    // The keyboard path does focus the slider.
    startEdge().focus();
    expect(document.activeElement).toBe(startEdge());
  });

  it("leaves the rail band to the seek slider", () => {
    setup();
    const LANE_HEIGHT = 50;
    const OUTLINE_TOP = 4;
    const OUTLINE_BOTTOM = 2;
    for (const edge of ["start", "end"] as const) {
      const slider = edge === "start" ? startEdge() : endEdge();
      // The slider itself takes no pointer: only its two parts do.
      expect(getComputedStyle(slider).pointerEvents).toBe("none");
      for (const where of ["top", "bottom"] as const) {
        const element = part(edge, where);
        expect(getComputedStyle(element).pointerEvents).toBe("auto");
        // Place the part in lane coordinates from its top/height or bottom/height, inside the slider (outline top 4, bottom 2).
        const height = parseFloat(element.style.height);
        const laneTop =
          element.style.top !== ""
            ? OUTLINE_TOP + parseFloat(element.style.top)
            : LANE_HEIGHT - OUTLINE_BOTTOM - parseFloat(element.style.bottom) - height;
        const laneBottom = laneTop + height;
        expect(height).toBeGreaterThan(0);
        // Entirely above y 18 or entirely below y 34, and within the outline's height.
        expect(laneBottom <= 18 || laneTop >= 34).toBe(true);
        expect(laneTop).toBeGreaterThanOrEqual(OUTLINE_TOP);
        expect(laneBottom).toBeLessThanOrEqual(LANE_HEIGHT - OUTLINE_BOTTOM);
        expect(element.style.cursor).toBe("ew-resize");
      }
      // One above the band and one below it.
      expect(part(edge, "top").style.top).toBe("0px");
      expect(part(edge, "bottom").style.bottom).toBe("0px");
    }
  });

  it("still drags from the part of an edge above the rail and from the part below it", () => {
    const onChange = jest.fn();
    setup({ onChange });
    for (const where of ["top", "bottom"] as const) {
      onChange.mockClear();
      pointer(part("start", where), "pointerdown", { clientX: 316 });
      pointer(part("start", where), "pointermove", { clientX: 166 });
      expect(onChange).toHaveBeenLastCalledWith({ startMs: 25_000, endMs: 100_000 });
      pointer(part("start", where), "pointerup", { clientX: 166 });
      onChange.mockClear();
      pointer(part("start", where), "pointermove", { clientX: 600 });
      expect(onChange).not.toHaveBeenCalled();

      pointer(part("end", where), "pointerdown", { clientX: 616 });
      pointer(part("end", where), "pointermove", { clientX: 916 });
      expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_000, endMs: 150_000 });
      pointer(part("end", where), "pointerup", { clientX: 916 });
    }
  });

  it("keeps one focusable slider per edge", () => {
    const onChange = jest.fn();
    const { lane } = setup({ onChange });
    const sliders = screen.getAllByRole("slider");
    expect(sliders.map((element) => element.getAttribute("aria-label"))).toEqual(["Clip start", "Clip end"]);
    // Tab order: exactly the two sliders (jsdom has no Tab key, so read the order a browser would use).
    const tabbable = Array.from(lane.querySelectorAll<HTMLElement>("[tabindex]")).filter((element) => element.tabIndex >= 0);
    expect(tabbable).toEqual(sliders);
    for (const element of [part("start", "top"), part("start", "bottom"), part("end", "top"), part("end", "bottom")]) {
      expect(element.tabIndex).toBe(-1);
      expect(element.getAttribute("role")).toBeNull();
    }
    // Each is reachable, takes focus and moves with the arrows.
    sliders[0].focus();
    expect(document.activeElement).toBe(sliders[0]);
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_100, endMs: 100_000 });
    sliders[1].focus();
    expect(document.activeElement).toBe(sliders[1]);
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ startMs: 50_000, endMs: 99_000 });
  });

  it("is inert and dimmer while locked", () => {
    const onChange = jest.fn();
    const { onParentKeyDown } = setup({ onChange, locked: true });
    const start = startEdge();
    const end = endEdge();
    for (const edge of [start, end]) {
      expect(edge.getAttribute("aria-disabled")).toBe("true");
      expect(edge.tabIndex).toBe(-1);
    }
    for (const element of [part("start", "top"), part("start", "bottom"), part("end", "top"), part("end", "bottom")]) {
      expect(element.style.cursor).toBe("default");
    }
    const setCapture = jest.fn();
    for (const element of [part("start", "top"), part("start", "bottom"), part("end", "top"), part("end", "bottom")]) {
      Object.assign(element, { setPointerCapture: setCapture });
    }

    const down = pointer(part("start", "top"), "pointerdown", { clientX: 316 });
    pointer(part("start", "top"), "pointermove", { clientX: 600 });
    pointer(part("end", "bottom"), "pointerdown", { clientX: 616 });
    pointer(part("end", "bottom"), "pointermove", { clientX: 900 });
    fireEvent.keyDown(start, { key: "ArrowRight" });
    fireEvent.keyDown(end, { key: "ArrowLeft", shiftKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(setCapture).not.toHaveBeenCalled();
    expect(down.notPrevented).toBe(true);
    // The key is no longer claimed, so it is not ours to stop.
    expect(onParentKeyDown).toHaveBeenCalled();

    const boxShadow = screen.getByTestId("clip-outline").style.boxShadow;
    expect(boxShadow).toContain("inset 3px 0 0 rgba(255, 156, 188, 0.5)");
    expect(boxShadow).toContain("inset -3px 0 0 rgba(255, 156, 188, 0.5)");
    expect(boxShadow).not.toContain("#ff9cbc");
    // The outline and the dimmed outside are still drawn.
    expect(screen.getByTestId("clip-outline").style.width).toBe("25%");
  });
});
