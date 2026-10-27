import { fireEvent, render, screen } from "@testing-library/react";
import { BaseGameTimeSlider } from "./BaseGameTimeSlider";

jest.mock("chart.js", () => ({
  Chart: class {
    static register = jest.fn();
    canvas = document.createElement("canvas");
    destroy = jest.fn();
    draw = jest.fn();
  },
  registerables: [],
}));

// jsdom has no ResizeObserver or matchMedia; the existing events-canvas effect (unrelated to
// this test) still constructs one and observes devicePixelRatio on mount, so minimal stubs keep
// the render from throwing (same stubs PlaybackTimeline.spec.tsx uses for this component).
global.ResizeObserver = class {
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
};
window.matchMedia = jest.fn().mockReturnValue({ addEventListener: jest.fn(), removeEventListener: jest.fn() });

it("renders a flat 50 px lane with no played copy or future shade", () => {
  const { container } = render(
    <BaseGameTimeSlider currentTime={250} duration={1000} onChange={jest.fn()} events={[]} difficulties={[1, 2, 3]} />,
  );
  expect(container.querySelector("[data-testid='timeline-future-shade']")).toBeNull();
  expect(container.querySelector("[data-testid='difficulty-played-clip']")).toBeNull();
  expect(screen.getByRole("slider", { name: "Replay timeline" }).getAttribute("aria-valuenow")).toBe("250");
  expect(getComputedStyle(container.firstElementChild as HTMLElement).height).toBe("50px");
});

it("stacks the playhead above the marks canvas while the canvas ignores the pointer", () => {
  const { container } = render(
    <BaseGameTimeSlider currentTime={250} duration={1000} onChange={jest.fn()} events={[]} difficulties={[1, 2, 3]} />,
  );
  const lane = container.firstElementChild as HTMLElement;
  const canvas = lane.querySelector(":scope > canvas") as HTMLElement;
  const slider = lane.querySelector(".MuiSlider-root") as HTMLElement;
  expect(getComputedStyle(canvas).pointerEvents).toBe("none");
  expect(Number(getComputedStyle(slider).zIndex)).toBeGreaterThan(Number(getComputedStyle(canvas).zIndex));
});

describe("a stretch of the map on the lane", () => {
  const section = { startMs: 40_000, endMs: 60_000 };
  function mount(props: Partial<Parameters<typeof BaseGameTimeSlider>[0]> = {}) {
    const handlers = { onSectionAt: jest.fn(), onSectionDrag: jest.fn(), onSectionZoom: jest.fn(), onSectionExit: jest.fn() };
    const view = render(
      <BaseGameTimeSlider currentTime={45_000} duration={100_000} onChange={jest.fn()} events={[]} difficulties={[1, 2, 3, 4]} {...handlers} {...props} />,
    );
    const lane = view.container.firstElementChild as HTMLElement;
    // The lane is 1000 px wide and starts 100 px from the left of the window.
    jest.spyOn(lane, "getBoundingClientRect").mockReturnValue({ left: 100, width: 1000, top: 0, height: 50, right: 1100, bottom: 50, x: 100, y: 0, toJSON: () => ({}) });
    return { ...handlers, view, lane };
  }
  const slider = () => screen.getByRole("slider", { name: "Replay timeline" });

  it("spans the whole map and shows nothing extra without a section", () => {
    mount();
    expect([slider().getAttribute("aria-valuemin"), slider().getAttribute("aria-valuemax")]).toEqual(["0", "100000"]);
    expect(screen.queryByRole("button", { name: "Full map" })).toBeNull();
    expect(screen.queryByTestId("timeline-coverage")).toBeNull();
  });

  it("spans the section, names its ends, and shows where it lies in the whole map", () => {
    const { view } = mount({ section });
    expect([slider().getAttribute("aria-valuemin"), slider().getAttribute("aria-valuemax"), slider().getAttribute("aria-valuenow")]).toEqual(["40000", "60000", "45000"]);
    expect(screen.getByTestId("timeline-section-start").textContent).toBe("0:40");
    expect(screen.getByTestId("timeline-section-end").textContent).toBe("1:00");
    const lit = screen.getByTestId("timeline-coverage-section");
    expect([lit.style.left, lit.style.width]).toEqual(["40%", "20%"]);
    // Still one 50 px lane.
    expect(getComputedStyle(view.container.firstElementChild as HTMLElement).height).toBe("50px");
  });

  it("goes back to the whole map from its own button", () => {
    const { onSectionExit } = mount({ section });
    fireEvent.click(screen.getByRole("button", { name: "Full map" }));
    expect(onSectionExit).toHaveBeenCalledTimes(1);
  });

  it("a right-click asks for the section around the time under the pointer, and opens no menu", () => {
    const { lane, onSectionAt, onSectionDrag } = mount();
    expect(fireEvent.contextMenu(lane)).toBe(false);
    fireEvent.mouseDown(lane, { button: 2, clientX: 600 });
    fireEvent.mouseUp(window, { button: 2, clientX: 602 });
    // Half way across a 100 s map; 8 px of it are 800 ms.
    expect(onSectionAt).toHaveBeenCalledWith(50_000, 800);
    expect(onSectionDrag).not.toHaveBeenCalled();
  });

  it("a right-drag marks the stretch as it goes and asks for it when it ends", () => {
    const { lane, onSectionAt, onSectionDrag } = mount();
    fireEvent.mouseDown(lane, { button: 2, clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 550 });
    const pick = screen.getByTestId("timeline-section-pick");
    expect([pick.style.left, pick.style.width]).toEqual(["200px", "250px"]);
    fireEvent.mouseMove(window, { clientX: 5_000 });
    expect(screen.getByTestId("timeline-section-pick").style.width).toBe("800px");
    fireEvent.mouseMove(window, { clientX: 550 });
    fireEvent.mouseUp(window, { button: 2, clientX: 700 });
    expect(onSectionDrag).toHaveBeenCalledWith(20_000, 60_000);
    expect(onSectionAt).not.toHaveBeenCalled();
    expect(screen.queryByTestId("timeline-section-pick")).toBeNull();
    // The drag is over: the mouse does nothing more.
    fireEvent.mouseUp(window, { button: 2, clientX: 900 });
    expect(onSectionDrag).toHaveBeenCalledTimes(1);
  });

  it("stops the band at the longest stretch a drag may choose, in either direction", () => {
    // Thirty seconds of a 100 s map are 300 px of the 1000 px lane.
    const { lane } = mount({ sectionDragLimitMs: 30_000 });
    const band = () => {
      const pick = screen.getByTestId("timeline-section-pick");
      return [pick.style.left, pick.style.width];
    };
    fireEvent.mouseDown(lane, { button: 2, clientX: 300 });
    fireEvent.mouseMove(window, { clientX: 450 });
    expect(band()).toEqual(["200px", "150px"]);
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(band()).toEqual(["200px", "300px"]);
    fireEvent.mouseUp(window, { button: 2, clientX: 900 });

    fireEvent.mouseDown(lane, { button: 2, clientX: 900 });
    fireEvent.mouseMove(window, { clientX: 200 });
    expect(band()).toEqual(["500px", "300px"]);
    fireEvent.mouseUp(window, { button: 2, clientX: 200 });
  });

  it("measures the pointer across the section once one is shown", () => {
    const { lane, onSectionAt } = mount({ section });
    fireEvent.mouseDown(lane, { button: 2, clientX: 600 });
    fireEvent.mouseUp(window, { button: 2, clientX: 600 });
    expect(onSectionAt).toHaveBeenCalledWith(50_000, 160);
  });

  it("makes the stretch longer or shorter with Alt and the wheel, and leaves the wheel alone otherwise", () => {
    const { lane, onSectionZoom } = mount({ section });
    const wheel = (init: WheelEventInit) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 350, ...init });
      lane.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(wheel({ deltaY: 100 })).toBe(false);
    expect(onSectionZoom).not.toHaveBeenCalled();
    expect(wheel({ deltaY: 100, altKey: true })).toBe(true);
    expect(wheel({ deltaY: -100, altKey: true })).toBe(true);
    expect(onSectionZoom.mock.calls).toEqual([
      [1.25, 45_000],
      [0.8, 45_000],
    ]);
  });

  it("takes no gesture with the left button, while disabled, or when nothing asked for sections", () => {
    const enabled = mount();
    fireEvent.mouseDown(enabled.lane, { button: 0, clientX: 600 });
    fireEvent.mouseUp(window, { button: 0, clientX: 600 });
    expect(enabled.onSectionAt).not.toHaveBeenCalled();
    enabled.view.unmount();

    const disabled = mount({ disabled: true });
    fireEvent.mouseDown(disabled.lane, { button: 2, clientX: 600 });
    fireEvent.mouseUp(window, { button: 2, clientX: 600 });
    disabled.lane.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100, altKey: true }));
    expect(disabled.onSectionAt).not.toHaveBeenCalled();
    expect(disabled.onSectionZoom).not.toHaveBeenCalled();
    disabled.view.unmount();

    const plain = mount({ onSectionAt: undefined, onSectionDrag: undefined, onSectionZoom: undefined, onSectionExit: undefined });
    expect(fireEvent.contextMenu(plain.lane)).toBe(true);
  });
});
