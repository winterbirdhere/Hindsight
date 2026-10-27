import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import type { ClipRecorderState, ClipRunSummary } from "../../services/manager/clip-export-types";
import { ExportProgress } from "./ExportProgress";
import { ExportSprint } from "./ExportSprint";

jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));

const RUN: ClipRunSummary = {
  startMs: 62_000,
  endMs: 70_000,
  width: 1920,
  fps: 60,
  audio: true,
  speed: 1,
  frameCount: 480,
  durationSeconds: 8,
};
const RENDERING: ClipRecorderState = { status: "rendering", progress: 0.25 };

function makeApp(state: ClipRecorderState, run: ClipRunSummary | undefined) {
  const clipRecorder = {
    state$: new BehaviorSubject<ClipRecorderState>(state),
    run$: new BehaviorSubject<ClipRunSummary | undefined>(run),
    getFormat: () => ({ label: "MP4 (H.264)" }),
    cancel: jest.fn().mockResolvedValue(undefined),
  };
  (useAnalysisApp as jest.Mock).mockReturnValue({ clipRecorder });
  return clipRecorder;
}

function steps() {
  return within(screen.getByRole("list")).getAllByRole("listitem");
}

function summaryValue(label: string): string {
  const row = screen.getByText(label).parentElement as HTMLElement;
  return row.textContent?.replace(label, "") ?? "";
}

const originalMatchMedia = window.matchMedia;
const originalRaf = window.requestAnimationFrame;
const originalCaf = window.cancelAnimationFrame;

function setReducedMotion(reduce: boolean) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
}

/** Frame callbacks the component asked for; they only run when a test calls them. */
function mockFrames() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  const raf = jest.fn((callback: FrameRequestCallback) => {
    next += 1;
    callbacks.set(next, callback);
    return next;
  });
  const caf = jest.fn((id: number) => {
    callbacks.delete(id);
  });
  window.requestAnimationFrame = raf as unknown as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = caf as unknown as typeof window.cancelAnimationFrame;
  return {
    raf,
    caf,
    /** Runs the pending callback, if there is one. */
    step: () => {
      const id = Math.max(0, ...callbacks.keys());
      const callback = callbacks.get(id);
      callbacks.delete(id);
      act(() => callback?.(0));
    },
  };
}

beforeEach(() => {
  setReducedMotion(false);
  mockFrames();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  window.requestAnimationFrame = originalRaf;
  window.cancelAnimationFrame = originalCaf;
  jest.restoreAllMocks();
  (useAnalysisApp as jest.Mock).mockReset();
});

describe("ExportProgress", () => {
  it("shows the step, the overall percentage and the frame count from the recorder", () => {
    makeApp(RENDERING, RUN);
    render(<ExportProgress />);

    expect(screen.getByRole("heading", { name: "Rendering frames" })).toBeTruthy();
    expect(screen.getByText("39%")).toBeTruthy();
    expect(screen.getByText("120 / 480 frames")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Export progress" }).getAttribute("aria-valuenow")).toBe("39");
    // The title is announced politely as the step changes.
    expect(screen.getByRole("heading", { name: "Rendering frames" }).getAttribute("aria-live")).toBe("polite");
  });

  it("keeps the live step title outside the progress bar", () => {
    makeApp(RENDERING, RUN);
    render(<ExportProgress />);

    const bar = screen.getByRole("progressbar", { name: "Export progress" });
    const title = screen.getByRole("heading", { name: "Rendering frames" });
    expect(title.getAttribute("aria-live")).toBe("polite");
    expect(bar.contains(title)).toBe(false);
    expect(title.closest("[role=progressbar]")).toBeNull();
    expect(bar.getAttribute("aria-valuenow")).toBe("39");
  });

  it.each([
    ["with audio", RUN, ["done", "done", "in progress", "pending"]],
    ["without audio", { ...RUN, audio: false }, ["done", "skipped", "in progress", "pending"]],
  ] as const)("says each step's state in text for assistive technology (%s)", (_name, run, expected) => {
    makeApp(RENDERING, run);
    render(<ExportProgress />);

    const items = steps();
    expect(items).toHaveLength(4);
    items.forEach((item, index) => {
      // The state is a text node of the row, so a screen reader reads it after the label.
      expect(within(item).getAllByText(expected[index], { exact: true })).toHaveLength(1);
    });
    // The marks stay decorative.
    for (const mark of Array.from(screen.getByRole("list").querySelectorAll("svg, li > span:first-child > span"))) {
      expect(mark.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("lists the four steps with their real details", () => {
    makeApp(RENDERING, RUN);
    render(<ExportProgress />);

    const items = steps();
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["done", "done", "active", "pending"]);
    expect(items[0].textContent).toBe("Preparingdone");
    expect(items[1].textContent).toBe("Recording audiodone8.0 s");
    expect(items[2].textContent).toBe("Rendering framesin progress120 / 480");
    expect(items[2].getAttribute("aria-current")).toBe("step");
    expect(items[3].textContent).toBe("Savingpending");
  });

  it("marks audio as skipped for a clip without audio", () => {
    makeApp(RENDERING, { ...RUN, audio: false });
    render(<ExportProgress />);

    const audio = steps()[1];
    expect(audio.getAttribute("data-state")).toBe("skipped");
    expect(audio.textContent).toBe("Recording audioskipped");
  });

  it("summarises the clip from the run summary", () => {
    makeApp(RENDERING, RUN);
    render(<ExportProgress />);

    const clip = screen.getByRole("group", { name: "CLIP" });
    expect(within(clip).getByText("Range").parentElement?.textContent).toBe("Range1:02 – 1:10");
    expect(within(clip).getByText("Output").parentElement?.textContent).toBe("Output1080p · 60 FPS · audio");
    expect(within(clip).getByText("Format").parentElement?.textContent).toBe("FormatMP4 (H.264)");
  });

  it("names the resolutions and the audio part of the output", () => {
    makeApp(RENDERING, { ...RUN, width: 2560, fps: 120, audio: false });
    const { unmount } = render(<ExportProgress />);
    expect(summaryValue("Output")).toBe("1440p · 120 FPS · no audio");
    unmount();

    makeApp(RENDERING, { ...RUN, width: 3840, fps: 144 });
    render(<ExportProgress />);
    expect(summaryValue("Output")).toBe("4K · 144 FPS · audio");
  });

  it("names the clip speed in the summary only when it is not 1×", () => {
    makeApp(RENDERING, { ...RUN, speed: 0.5 });
    const { unmount } = render(<ExportProgress />);
    expect(summaryValue("Output")).toBe("1080p · 60 FPS · 0.5× · audio");
    unmount();

    makeApp(RENDERING, { ...RUN, speed: 1 });
    render(<ExportProgress />);
    expect(summaryValue("Output")).toBe("1080p · 60 FPS · audio");
    expect(screen.queryByText(/×/)).toBeNull();
  });

  it("shows dashes for the range and output until the summary exists", () => {
    makeApp({ status: "preparing", progress: 0 }, undefined);
    render(<ExportProgress />);

    expect(summaryValue("Range")).toBe("—");
    expect(summaryValue("Output")).toBe("—");
    // The format is known without a run.
    expect(summaryValue("Format")).toBe("MP4 (H.264)");
    expect(screen.getByRole("heading", { name: "Preparing" })).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();
  });

  it("shows the right totals after a remount in the middle of an export", () => {
    const recorder = makeApp(RENDERING, RUN);
    const first = render(<ExportProgress />);
    const before = first.container.textContent;
    first.unmount();

    // Unmounted, then mounted again with nothing changed: the same texts.
    const second = render(<ExportProgress />);
    expect(second.container.textContent).toBe(before);
    expect(screen.getByText("120 / 480 frames")).toBeTruthy();
    second.unmount();

    // The recorder moved on while the view was away: the remount shows its totals, not remembered ones.
    recorder.state$.next({ status: "rendering", progress: 0.5 });
    render(<ExportProgress />);
    expect(screen.getByText("240 / 480 frames")).toBeTruthy();
    expect(screen.getByText("57%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Export progress" }).getAttribute("aria-valuenow")).toBe("57");
    expect(steps()[2].textContent).toBe("Rendering framesin progress240 / 480");
    expect(summaryValue("Range")).toBe("1:02 – 1:10");
  });

  it("follows the recorder while mounted", () => {
    const recorder = makeApp({ status: "recording", progress: 0.5 }, RUN);
    render(<ExportProgress />);
    expect(screen.getByRole("heading", { name: "Recording audio" })).toBeTruthy();
    expect(screen.getByText("Mixing music and hit sounds")).toBeTruthy();

    act(() => recorder.state$.next({ status: "rendering", progress: 0.5 }));
    expect(screen.getByRole("heading", { name: "Rendering frames" })).toBeTruthy();
    expect(screen.getByText("240 / 480 frames")).toBeTruthy();

    act(() => recorder.run$.next({ ...RUN, speed: 2 }));
    expect(summaryValue("Output")).toBe("1080p · 60 FPS · 2× · audio");
  });

  it("cancels the export", () => {
    const recorder = makeApp(RENDERING, RUN);
    render(<ExportProgress />);

    expect(recorder.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Playback and the timeline are locked until the export finishes.")).toBeTruthy();
  });

  it("has no close button and says the panel is locked", () => {
    makeApp(RENDERING, RUN);
    render(<ExportProgress />);

    expect(screen.getByRole("heading", { name: "Exporting clip" })).toBeTruthy();
    expect(screen.getByText("locked")).toBeTruthy();
    // Cancel export is the only control.
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel export"]);
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(screen.queryByText("✕")).toBeNull();
  });

  it("stops its animation frame loop on unmount and runs none under reduced motion", () => {
    // Motion allowed: one loop, started once, whatever the recorder reports; cancelled on unmount.
    const frames = mockFrames();
    const recorder = makeApp(RENDERING, RUN);
    const view = render(<ExportProgress />);
    expect(frames.raf).toHaveBeenCalledTimes(1);

    act(() => recorder.state$.next({ status: "rendering", progress: 0.5 }));
    expect(frames.raf).toHaveBeenCalledTimes(1);
    frames.step();
    expect(frames.raf).toHaveBeenCalledTimes(2);
    expect(frames.caf).not.toHaveBeenCalled();

    view.unmount();
    expect(frames.caf).toHaveBeenCalledTimes(1);
    expect(frames.caf).toHaveBeenCalledWith(2);

    // Reduced motion: no loop at all.
    setReducedMotion(true);
    const reduced = mockFrames();
    makeApp(RENDERING, RUN);
    const quiet = render(<ExportProgress />);
    expect(reduced.raf).not.toHaveBeenCalled();
    quiet.unmount();
    expect(reduced.caf).not.toHaveBeenCalled();
  });
});

describe("ExportSprint", () => {
  const record = (container: HTMLElement) => container.querySelector("[data-sprint-record]") as HTMLElement;
  const trail = (container: HTMLElement) => container.querySelector("[data-sprint-trail]") as HTMLElement;
  const streaks = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>("[data-sprint-streak]"));

  it("is decorative: hidden from assistive technology and clipped to its lane", () => {
    const { container } = render(<ExportSprint fraction={0.5} rendering />);
    const lane = container.firstElementChild as HTMLElement;
    expect(lane.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(lane).overflow).toBe("hidden");
    expect(getComputedStyle(lane).height).toBe("62px");
    expect(getComputedStyle(lane).width).toBe("min(300px, 100%)");
  });

  it("moves the record and its trail with the fraction, whatever the motion setting", () => {
    // jsdom has no layout: the lane falls back to its 300 px maximum, so the record travels 260 px.
    for (const reduce of [false, true]) {
      setReducedMotion(reduce);
      const { container, rerender, unmount } = render(<ExportSprint fraction={0} rendering={false} />);
      expect(record(container).style.left).toBe("0px");
      expect(trail(container).style.width).toBe("20px");

      rerender(<ExportSprint fraction={0.5} rendering />);
      expect(record(container).style.left).toBe("130px");
      expect(trail(container).style.width).toBe("150px");

      rerender(<ExportSprint fraction={1} rendering />);
      expect(record(container).style.left).toBe("260px");
      unmount();
    }
  });

  it("turns the record and draws eleven streaks when motion is allowed", () => {
    const frames = mockFrames();
    jest.spyOn(performance, "now").mockReturnValue(0);
    const { container } = render(<ExportSprint fraction={0.5} rendering />);

    expect(streaks(container)).toHaveLength(11);
    expect(streaks(container).filter((streak) => streak.getAttribute("data-pink") === "true")).toHaveLength(3);
    expect(record(container).style.transform).toBe("translateY(0.00px) rotate(0.0deg)");

    // 100 ms later: 0.7° per ms, and the rendering jitter sin(100 / 38) × 0.9.
    jest.spyOn(performance, "now").mockReturnValue(100);
    frames.step();
    expect(record(container).style.transform).toBe(
      `translateY(${(Math.sin(100 / 38) * 0.9).toFixed(2)}px) rotate(70.0deg)`,
    );
  });

  it("dims the streaks, and holds the record still vertically, unless it is rendering", () => {
    const frames = mockFrames();
    jest.spyOn(performance, "now").mockReturnValue(100);
    const { container, rerender } = render(<ExportSprint fraction={0.5} rendering={false} />);
    const opacities = () => streaks(container).map((streak) => Number(streak.style.opacity));

    // Behind the record 1, ahead of it .35, all × 0.4.
    expect(opacities().every((value) => [0.4, 0.14].includes(Number(value.toFixed(2))))).toBe(true);
    expect(record(container).style.transform).toMatch(/^translateY\(0\.00px\) rotate\(/);

    // The loop started at 100 ms; its next frame is 100 ms into the run.
    jest.spyOn(performance, "now").mockReturnValue(200);
    rerender(<ExportSprint fraction={0.5} rendering />);
    frames.step();
    expect(opacities().every((value) => [1, 0.35].includes(Number(value.toFixed(2))))).toBe(true);
    expect(opacities().some((value) => value === 1)).toBe(true);
    expect(opacities().some((value) => Number(value.toFixed(2)) === 0.35)).toBe(true);
    expect(record(container).style.transform).toBe(
      `translateY(${(Math.sin(100 / 38) * 0.9).toFixed(2)}px) rotate(70.0deg)`,
    );
  });

  it("keeps the record still and draws no streaks under reduced motion", () => {
    setReducedMotion(true);
    const frames = mockFrames();
    const { container } = render(<ExportSprint fraction={0.5} rendering />);

    expect(streaks(container)).toHaveLength(0);
    expect(record(container).style.transform).toBe("");
    expect(frames.raf).not.toHaveBeenCalled();
  });
});
