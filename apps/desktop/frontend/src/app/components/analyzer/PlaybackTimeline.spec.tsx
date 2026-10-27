import "reflect-metadata";
import { act, cleanup, fireEvent, render as renderWithoutInspector, screen } from "@testing-library/react";
import { BehaviorSubject, Subject } from "rxjs";
import { Profiler, type ReactElement } from "react";
import { useAnalysisApp, useCommonManagers } from "../../providers/TheaterProvider";
import { InspectorProvider } from "../../providers/InspectorProvider";
import { GameplayClock } from "../../services/common/game/GameplayClock";
import { DEFAULT_PLAY_BAR_SETTINGS } from "../../services/common/playbar";
import { DEFAULT_REPLAY_DISPLAY_SETTINGS } from "../../services/analysis/replay-display-settings";
import { GameTimeSlider } from "./GameTimeSlider";
import { CurrentTime, Duration } from "./TimeReadout";

jest.mock("../../providers/TheaterProvider", () => ({
  useAnalysisApp: jest.fn(),
  useCommonManagers: jest.fn(),
}));
jest.mock("../../api", () => ({ frontendAPI: {} }));
jest.mock("chart.js", () => ({
  Chart: class {
    static register = jest.fn();
    draw = jest.fn();
    destroy = jest.fn();
  },
  registerables: [],
}));

/** GameTimeSlider reads the inspector, so every fixture mounts under its provider. */
function render(ui: ReactElement) {
  return renderWithoutInspector(ui, { wrapper: InspectorProvider });
}

describe("playback time on the main timeline", () => {
  let clock: GameplayClock;
  let frameRendered$: Subject<void>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    window.matchMedia = jest.fn().mockReturnValue({ addEventListener: jest.fn(), removeEventListener: jest.fn() });
    global.ResizeObserver = class {
      observe = jest.fn();
      unobserve = jest.fn();
      disconnect = jest.fn();
    };
    clock = new GameplayClock();
    frameRendered$ = new Subject<void>();
    clock.durationInMs = 180_000;
    clock.seekTo(90_000);
    jest.mocked(useAnalysisApp).mockReturnValue({
      gameClock: clock,
      frameRendered$,
      clipRecorder: { isBusy: false },
      gameSimulator: {
        replayEvents$: new BehaviorSubject([]),
        rulesetFocus$: new BehaviorSubject("stable"),
        difficulties$: new BehaviorSubject([]),
      },
      replayDisplaySettingsStore: {
        settings: DEFAULT_REPLAY_DISPLAY_SETTINGS,
        settings$: new BehaviorSubject(DEFAULT_REPLAY_DISPLAY_SETTINGS),
      },
    } as unknown as ReturnType<typeof useAnalysisApp>);
    jest.mocked(useCommonManagers).mockReturnValue({
      playbarSettingsStore: { settings$: new BehaviorSubject(DEFAULT_PLAY_BAR_SETTINGS) },
    } as unknown as ReturnType<typeof useCommonManagers>);
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function refreshTime() {
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
  }

  async function showTimeline(baseRate: number, speed: number) {
    clock.setBaseRate(baseRate);
    clock.setSpeed(speed);
    render(
      <>
        <CurrentTime />
        <GameTimeSlider />
        <Duration />
      </>,
    );
    await refreshTime();
  }

  it.each([
    [1, 1, "1:30", "3:00", 90_000, 180_000],
    [1, 0.25, "1:30", "3:00", 90_000, 180_000],
    [1, 2, "1:30", "3:00", 90_000, 180_000],
    [1.5, 1, "1:00", "2:00", 60_000, 120_000],
    [0.75, 1, "2:00", "4:00", 120_000, 240_000],
    [1.2, 1, "1:15", "2:30", 75_000, 150_000],
    [1.2, 2, "1:15", "2:30", 75_000, 150_000],
    [0.9, 0.5, "1:40", "3:20", 100_000, 200_000],
    [1.5, 0.5, "1:00", "2:00", 60_000, 120_000],
    [0.75, 2, "2:00", "4:00", 120_000, 240_000],
  ])(
    "uses only mod rate for timeline labels at base %s and viewer %s",
    async (base, speed, at, total, atMs, totalMs) => {
      await showTimeline(base as number, speed as number);
      expect(screen.getByTitle("Elapsed replay time at the modded rate").textContent).toBe(`${at}.000`);
      expect(screen.getByTitle("Replay duration at the modded rate").textContent).toBe(total);
      const rail = screen.getByRole("slider", { name: "Replay timeline" });
      expect(rail.getAttribute("aria-valuetext")).toBe(at);
      expect(Number(rail.getAttribute("aria-valuenow"))).toBe(atMs);
      expect(Number(rail.getAttribute("aria-valuemax"))).toBe(totalMs);
      expect(rail.parentElement?.textContent).toBe(at);
      expect((rail as HTMLInputElement).value).toBe("90000");
    },
  );

  it("updates labels for DT while paused but keeps them fixed across every viewer speed", async () => {
    await showTimeline(1, 1);
    act(() => clock.setBaseRate(1.5));
    await refreshTime();
    expect(screen.getByTitle("Elapsed replay time at the modded rate").textContent).toBe("1:00.000");
    expect(screen.getByTitle("Replay duration at the modded rate").textContent).toBe("2:00");
    expect(screen.getByRole("slider", { name: "Replay timeline" }).getAttribute("aria-valuetext")).toBe("1:00");
    const pausedClock = clock;
    for (const [speed, playbackRate] of [
      [0.25, 0.375],
      [0.5, 0.75],
      [0.75, 1.125],
      [1, 1.5],
      [1.25, 1.875],
      [1.5, 2.25],
      [1.75, 2.625],
      [2, 3],
    ]) {
      act(() => pausedClock.setSpeed(speed));
      await refreshTime();
      expect(screen.getByTitle("Elapsed replay time at the modded rate").textContent).toBe("1:00.000");
      expect(screen.getByTitle("Replay duration at the modded rate").textContent).toBe("2:00");
      expect(screen.getByRole("slider", { name: "Replay timeline" }).getAttribute("aria-valuetext")).toBe("1:00");
      expect(pausedClock.playbackRate).toBe(playbackRate);
    }
    expect(clock.timeElapsedInMs).toBe(90_000);
    expect(clock.isPlaying).toBe(false);
  });

  it("seeks the original map position despite DT labels", async () => {
    await showTimeline(1.5, 0.5);
    const seek = jest.fn();
    const subscription = clock.seeked$.subscribe(seek);
    const rail = screen.getByRole("slider", { name: "Replay timeline" });
    fireEvent.change(rail, { target: { value: "120000" } });
    await refreshTime();
    expect(seek).toHaveBeenLastCalledWith(120_000);
    expect(clock.timeElapsedInMs).toBe(120_000);
    expect(rail.getAttribute("aria-valuetext")).toBe("1:20");
    expect(screen.getByTitle("Elapsed replay time at the modded rate").textContent).toBe("1:20.000");

    subscription.unsubscribe();
  });

  it.each([60, 120, 144, 240])(
    "moves the short-replay thumb and track on every rendered frame at %s Hz without updating parent controls",
    async (refreshRate) => {
      clock.durationInMs = 5_000;
      clock.seekTo(0);
      await showTimeline(1.5, 1);
      const parentRenders = jest.mocked(useCommonManagers).mock.calls.length;
      const canvasDraws = jest.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.length;
      const rail = screen.getByRole("slider", { name: "Replay timeline" });
      const slider = rail.closest(".MuiSlider-root");
      const thumb = slider?.querySelector<HTMLElement>(".MuiSlider-thumb");
      const track = slider?.querySelector<HTMLElement>(".MuiSlider-track");
      const advanceClock = jest.spyOn(clock, "updateTimeElapsed");
      const frameClock = clock;
      const renderedFrames = frameRendered$;
      for (let frame = 1; frame <= 12; frame++) {
        const mapTime = (frame * 1000 * 1.5) / refreshRate;
        act(() => {
          frameClock.timeElapsedInMs = mapTime;
          renderedFrames.next();
        });
        // No timer advancement: a completed scene frame must update the slider itself.
        expect(Number((rail as HTMLInputElement).value)).toBeCloseTo(mapTime, 8);
        expect(parseFloat(thumb?.style.left ?? "")).toBeCloseTo((mapTime / 5_000) * 100, 8);
        expect(parseFloat(track?.style.width ?? "")).toBeCloseTo((mapTime / 5_000) * 100, 8);
      }
      expect(jest.mocked(useCommonManagers).mock.calls.length).toBe(parentRenders);
      expect(jest.mocked(HTMLCanvasElement.prototype.getContext).mock.calls.length).toBe(canvasDraws);
      expect(advanceClock).not.toHaveBeenCalled();
    },
  );

  it("seeks immediately while paused and bases shifted keyboard steps on the latest rendered position", async () => {
    await showTimeline(1.5, 1);
    const rail = screen.getByRole("slider", { name: "Replay timeline" });
    act(() => clock.seekTo(12_000));
    expect((rail as HTMLInputElement).value).toBe("12000");
    expect(screen.getByTitle("Elapsed replay time at the modded rate").textContent).toBe("0:08.000");
    act(() => {
      clock.timeElapsedInMs = 24_000;
      frameRendered$.next();
    });
    fireEvent.keyDown(rail, { key: "ArrowRight", shiftKey: true });
    expect(clock.timeElapsedInMs).toBe(24_010);
    fireEvent.change(rail, { target: { value: "48000" } });
    expect(clock.timeElapsedInMs).toBe(48_000);
    expect((rail as HTMLInputElement).value).toBe("48000");
    expect(rail.getAttribute("aria-valuetext")).toBe("0:32");
    expect(clock.isPlaying).toBe(false);
  });

  it("shows backward seeks and the replay endpoint without interpolating across a seek", async () => {
    clock.durationInMs = 5_000;
    clock.seekTo(0);
    await showTimeline(1, 1);
    act(() => {
      clock.start();
      clock.timeElapsedInMs = 2_001;
      clock.tick();
      frameRendered$.next();
      clock.seekTo(1_000);
    });
    expect((screen.getByRole("slider", { name: "Replay timeline" }) as HTMLInputElement).value).toBe("1000");
    act(() => {
      clock.timeElapsedInMs = 5_001;
      clock.tick();
      frameRendered$.next();
    });
    expect((screen.getByRole("slider", { name: "Replay timeline" }) as HTMLInputElement).value).toBe("5000");
    expect(clock.isPlaying).toBe(false);
  });

  it("does no repeated React commits for unchanged paused frames or locked export frames, and unsubscribes", async () => {
    const frameClock = clock;
    const renderedFrames = frameRendered$;
    const committed = jest.fn();
    const view = render(
      <Profiler id="timeline" onRender={committed}>
        <GameTimeSlider />
      </Profiler>,
    );
    await refreshTime();
    const pausedCommits = committed.mock.calls.length;
    for (let frame = 0; frame < 12; frame++) act(() => renderedFrames.next());
    expect(committed.mock.calls.length).toBe(pausedCommits);
    clock.controlsLocked = true;
    for (let frame = 0; frame < 12; frame++) {
      act(() => {
        frameClock.timeElapsedInMs = 1000 + frame * 16;
        renderedFrames.next();
      });
    }
    expect(committed.mock.calls.length).toBe(pausedCommits);
    clock.controlsLocked = false;
    act(() => frameRendered$.next());
    expect((screen.getByRole("slider", { name: "Replay timeline" }) as HTMLInputElement).value).toBe("1176");
    view.unmount();
    expect(frameRendered$.observed).toBe(false);
    expect(clock.seeked$.observed).toBe(false);
  });

  it("resets elapsed time and the seek position when a replay is cleared without another rendered frame", async () => {
    await showTimeline(1.5, 1);
    act(() => clock.clear());
    expect(screen.getByTitle("Elapsed replay time at the modded rate").textContent).toBe("0:00.000");
    expect((screen.getByRole("slider", { name: "Replay timeline" }) as HTMLInputElement).value).toBe("0");
    expect(screen.getByTitle("Replay duration at the modded rate").textContent).toBe("0:00");
  });
});
