import { act, cleanup, render, screen } from "@testing-library/react";
import { RewindLogo } from "./RewindLogo";
import { LOGO_STATIC, trailPath } from "./logo-geometry";

const STATIC_PATH = trailPath(LOGO_STATIC.headDeg, LOGO_STATIC.spanDeg).d;

const mockReducedMotion = (reduce: boolean) => {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
};

describe("RewindLogo", () => {
  let rafSpy: jest.SpyInstance;
  let cancelSpy: jest.SpyInstance;
  let callbacks: Map<number, FrameRequestCallback>;
  let nextId: number;

  beforeEach(() => {
    mockReducedMotion(false);
    callbacks = new Map();
    nextId = 1;
    rafSpy = jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    });
    cancelSpy = jest.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      callbacks.delete(id);
    });
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it("renders the static mark as a named image", () => {
    const { container } = render(<RewindLogo />);
    const svg = screen.getByRole("img", { name: "Hindsight" });
    expect(svg.getAttribute("width")).toBe("92");
    expect(svg.getAttribute("height")).toBe("92");
    expect(svg.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(container.querySelector(`path[d="${STATIC_PATH}"]`)).not.toBeNull();
    expect(STATIC_PATH).toBe("M38.37 18.05 A34 34 0 1 0 76.05 28.15");
    expect(container.querySelectorAll("[data-logo-cursor]")).toHaveLength(1);
    expect(container.querySelector("[data-logo-miss]")).toBeNull();
    expect(container.querySelectorAll("polygon")).toHaveLength(2);
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("sizes the mark from the size prop", () => {
    render(<RewindLogo size={220} />);
    const svg = screen.getByRole("img", { name: "Hindsight" });
    expect(svg.getAttribute("width")).toBe("220");
    expect(svg.getAttribute("height")).toBe("220");
    expect(svg.style.filter).toContain("0 10px 22px");
  });

  it("uses the smaller shadow below 200 px", () => {
    render(<RewindLogo size={92} />);
    expect(screen.getByRole("img", { name: "Hindsight" }).style.filter).toContain("0 6px 14px");
  });

  it("draws the broken mark with a miss marker and no cursor, and never animates", () => {
    const { container } = render(<RewindLogo variant="broken" size={104} />);
    expect(container.querySelector("[data-logo-miss]")).not.toBeNull();
    expect(container.querySelector("[data-logo-cursor]")).toBeNull();
    expect(container.querySelector("[data-logo-miss] path")?.getAttribute("d")).toBe("M-7 -7 L7 7 M7 -7 L-7 7");
    expect(screen.getByRole("img", { name: "Hindsight" }).style.filter).toContain("0 8px 18px");
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("gives two logos on one page different gradient ids", () => {
    const { container } = render(
      <>
        <RewindLogo />
        <RewindLogo variant="broken" />
      </>,
    );
    const ids = Array.from(container.querySelectorAll("radialGradient, linearGradient, filter")).map((el) => el.id);
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^[A-Za-z0-9_-]+$/));
  });

  it("starts an animated logo faded, then advances with each frame", () => {
    jest.spyOn(performance, "now").mockReturnValue(1000);
    const { container } = render(<RewindLogo variant="animated" size={220} />);
    expect(rafSpy).toHaveBeenCalledTimes(1);
    const initialPath = container.querySelector("path[stroke^='url(']")?.getAttribute("d");
    expect(initialPath).not.toBe(STATIC_PATH);

    jest.spyOn(performance, "now").mockReturnValue(1000 + 1100);
    const [id, cb] = Array.from(callbacks.entries())[0];
    act(() => {
      callbacks.delete(id);
      cb(0);
    });
    expect(rafSpy).toHaveBeenCalledTimes(2);
    expect(container.querySelector("path[stroke^='url(']")?.getAttribute("d")).not.toBe(initialPath);
  });

  it("requests no frame under reduced motion", () => {
    mockReducedMotion(true);
    const { container } = render(<RewindLogo variant="animated" />);
    expect(rafSpy).not.toHaveBeenCalled();
    expect(container.querySelector(`path[d="${STATIC_PATH}"]`)).not.toBeNull();
    expect(container.querySelector("circle[stroke='#fff'][fill='none']")).toBeNull();
  });

  it("still animates when matchMedia is unavailable", () => {
    (window as { matchMedia?: unknown }).matchMedia = undefined;
    render(<RewindLogo variant="animated" />);
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it("cancels its frame on unmount", () => {
    const { unmount } = render(<RewindLogo variant="animated" />);
    expect(rafSpy).toHaveBeenCalledTimes(1);
    const pendingId = rafSpy.mock.results[0].value as number;
    const pendingCallback = callbacks.get(pendingId) as FrameRequestCallback;
    unmount();
    expect(cancelSpy).toHaveBeenCalledWith(pendingId);

    // A callback that was already dispatched must neither draw nor schedule another frame.
    act(() => {
      pendingCallback(0);
    });
    expect(rafSpy).toHaveBeenCalledTimes(1);
  });
});
