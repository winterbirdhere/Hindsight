import "reflect-metadata";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Subject } from "rxjs";
import { useGameClockControls } from "../../hooks/game-clock";
import { InspectorProvider, useInspector } from "../../providers/InspectorProvider";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { GameplayClock } from "../../services/common/game/GameplayClock";
import { PlayButton, TimeReadout } from "./TimeReadout";

jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));
jest.mock("../../hooks/game-clock", () => ({ useGameClockControls: jest.fn() }));

let inspector: ReturnType<typeof useInspector>;
function InspectorProbe() {
  inspector = useInspector();
  return null;
}

/** The transport reads the clock through the analyzer; the ordinary toggle is `gameClock.toggle`. */
function mountClock(
  isPlaying: boolean,
  { baseRate = 1, timeMs = 0, durationMs = 180_000 }: { baseRate?: number; timeMs?: number; durationMs?: number } = {},
) {
  const toggleClock = jest.fn();
  const gameClock = new GameplayClock();
  jest.spyOn(gameClock, "toggle").mockImplementation(toggleClock);
  gameClock.durationInMs = durationMs;
  gameClock.setBaseRate(baseRate);
  gameClock.seekTo(timeMs);
  const frameRendered$ = new Subject<void>();
  (useGameClockControls as jest.Mock).mockReturnValue({ isPlaying, toggleClock, duration: durationMs, baseRate });
  (useAnalysisApp as jest.Mock).mockReturnValue({ gameClock, frameRendered$, clipRecorder: { isBusy: false } });
  return { toggleClock, gameClock, frameRendered$ };
}

function mount(isPlaying: boolean) {
  const { toggleClock } = mountClock(isPlaying);
  const view = render(<PlayButton />, { wrapper: InspectorProvider });
  return { toggleClock, view };
}

describe("PlayButton", () => {
  it("shows the 3a play triangle while paused, named Play replay", () => {
    const { toggleClock } = mount(false);
    const button = screen.getByRole("button", { name: "Play replay" });
    const svgs = button.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(svgs[0].getAttribute("aria-hidden")).toBe("true");
    expect(svgs[0].getAttribute("viewBox")).toBe("0 0 10 11");
    expect(svgs[0].querySelector("polygon")?.getAttribute("points")).toBe("1.5,0.5 9.5,5.5 1.5,10.5");
    expect(svgs[0].getAttribute("data-testid")).toBeNull();
    fireEvent.click(button);
    expect(toggleClock).toHaveBeenCalledTimes(1);
  });

  it("shows two pause bars in the same box while playing, named Pause replay", () => {
    mount(true);
    const button = screen.getByRole("button", { name: "Pause replay" });
    const svg = button.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("viewBox")).toBe("0 0 10 11");
    expect(svg.querySelectorAll("rect")).toHaveLength(2);
    expect(svg.querySelector("polygon")).toBeNull();
  });
});

describe("TimeReadout", () => {
  function mountReadout(options: { baseRate?: number; timeMs?: number; durationMs?: number } = {}) {
    const clock = mountClock(false, options);
    render(
      <InspectorProvider>
        <InspectorProbe />
        <TimeReadout />
      </InspectorProvider>,
    );
    return clock;
  }
  /** Starts an export session on a clip of the given range. */
  function openExport(startMs: number, endMs: number) {
    act(() => {
      inspector.openExport();
      inspector.setExportRange({ startMs, endMs });
    });
  }

  const mapTime = () => screen.getByTitle("Map time under the playhead, as Start and End are typed") as HTMLElement;
  const clipTime = () => screen.getByTitle("Time into the clip, and the clip's length") as HTMLElement;

  it("leads with the map time during an export session, the time Start and End are typed in, then the clip's own", () => {
    const { gameClock, frameRendered$ } = mountReadout({ timeMs: 66_472 });
    openExport(62_000, 70_000);
    const readout = screen.getByLabelText("Clip time");
    // The clip starts at 1:02 of the map: the large time says 1:06.472, not 0:04.472.
    expect(readout.firstElementChild).toBe(mapTime());
    expect(mapTime().textContent).toBe("1:06.472");
    expect(clipTime().textContent).toBe("clip 0:04.472 / 0:08");
    expect(readout.textContent).toBe("1:06.472clip 0:04.472 / 0:08");
    expect(getComputedStyle(mapTime()).fontSize).toBe("16px");
    expect(getComputedStyle(clipTime()).fontSize).toBe("12.5px");
    // The clip readout replaces the replay readout.
    expect(screen.queryByTitle("Elapsed replay time at the modded rate")).toBeNull();
    expect(screen.queryByTitle("Replay duration at the modded rate")).toBeNull();

    // It follows a seek and a rendered frame without the parent re-rendering.
    act(() => gameClock.seekTo(67_000));
    expect(readout.textContent).toBe("1:07.000clip 0:05.000 / 0:08");
    act(() => {
      gameClock.timeElapsedInMs = 67_250;
      frameRendered$.next();
    });
    expect(screen.getByLabelText("Clip time")).toBe(readout);
    expect(readout.textContent).toBe("1:07.250clip 0:05.250 / 0:08");
  });

  it("at the clip's start shows the map time of the start, not zero", () => {
    mountReadout({ timeMs: 62_000 });
    openExport(62_000, 70_000);
    expect(mapTime().textContent).toBe("1:02.000");
    expect(clipTime().textContent).toBe("clip 0:00.000 / 0:08");
  });

  it("writes the map time as the fields have it, and measures the clip at the playback rate", () => {
    mountReadout({ baseRate: 1.5, timeMs: 65_000 });
    openExport(62_000, 70_000);
    // The raw map time, as Start and End are; eight seconds of it are 5.333 s of video at 1.5×.
    expect(mapTime().textContent).toBe("1:05.000");
    expect(clipTime().textContent).toBe("clip 0:02.000 / 0:05.333");
  });

  it("writes a clip longer than a minute in minutes too", () => {
    mountReadout({ timeMs: 100_000 });
    openExport(0, 163_073);
    expect(clipTime().textContent).toBe("clip 1:40.000 / 2:43.073");
  });

  it("keeps both times' widths, so nothing after them moves as they count", () => {
    mountReadout();
    openExport(62_000, 70_000);
    // The replay is three minutes long: "m:ss.mmm" for the map time and for the time into the clip.
    expect(getComputedStyle(mapTime()).minWidth).toBe("8ch");
    expect(getComputedStyle(mapTime()).fontVariantNumeric).toContain("tabular-nums");
    expect(getComputedStyle(clipTime().querySelector("span") as HTMLElement).minWidth).toBe("8ch");
  });

  it("makes room for a second digit of minutes in a replay or a clip of ten minutes or more", () => {
    mountReadout({ durationMs: 720_000 });
    openExport(0, 700_000);
    expect(getComputedStyle(mapTime()).minWidth).toBe("9ch");
    expect(getComputedStyle(clipTime().querySelector("span") as HTMLElement).minWidth).toBe("9ch");
    expect(clipTime().textContent).toBe("clip 0:00.000 / 11:40");
  });

  it("shows the ordinary readout outside an export session", () => {
    mountReadout({ timeMs: 66_472 });
    expect(screen.getByTitle("Elapsed replay time at the modded rate").textContent).toBe("1:06.472");
    expect(screen.getByTitle("Replay duration at the modded rate").textContent).toBe("3:00");
    expect(screen.queryByLabelText("Clip time")).toBeNull();

    // And it comes back after the session ends.
    openExport(62_000, 70_000);
    expect(screen.queryByTitle("Elapsed replay time at the modded rate")).toBeNull();
    act(() => inspector.closeMode());
    expect(screen.getByTitle("Elapsed replay time at the modded rate").textContent).toBe("1:06.472");
    expect(screen.queryByLabelText("Clip time")).toBeNull();
  });
});
