import "reflect-metadata";
import { render } from "@testing-library/react";
import { GameplayClock } from "../services/common/game/GameplayClock";
import { useAnalysisApp, useCommonManagers } from "../providers/TheaterProvider";
import { STEP_RESUME_MS, usePlaybackSteps, usePlaybackWheel, type StepKind } from "./playback-steps";

jest.mock("../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn(), useCommonManagers: jest.fn() }));

// 120 BPM from 1000 ms; circles a quarter and a third of a beat apart, then a slider; frames every 16 ms.
const beatmap = {
  hitObjects: [
    { type: "HIT_CIRCLE", hitTime: 1_000 },
    { type: "HIT_CIRCLE", hitTime: 1_125 },
    { type: "HIT_CIRCLE", hitTime: 1_291.67 },
    { type: "SLIDER", startTime: 1_500, endTime: 1_750 },
  ],
  controlPointInfo: { timingPoints: { list: [{ time: 1_000, beatLength: 500, timeSignature: 4 }] } },
};
const replay = { frames: Array.from({ length: 200 }, (_unused, index) => ({ time: index * 16 })) };

function app(options: { scrollStep?: string; busy?: boolean; time?: number } = {}) {
  const gameClock = { timeElapsedInMs: options.time ?? 1_000, durationInMs: 10_000, seekTo: jest.fn() };
  gameClock.seekTo.mockImplementation((time: number) => void (gameClock.timeElapsedInMs = time));
  const gameSimulator = { getPrimaryBeatmap: jest.fn(() => beatmap), getPrimaryReplay: jest.fn(() => replay) };
  const settings = { scrollStep: options.scrollStep ?? "auto", holdSpeed: 0.5, difficultyGraphEnabled: true };
  jest.mocked(useAnalysisApp).mockReturnValue({ gameClock, gameSimulator, clipRecorder: { isBusy: options.busy ?? false } } as never);
  jest.mocked(useCommonManagers).mockReturnValue({ playbarSettingsStore: { settings } } as never);
  return { gameClock, gameSimulator, settings };
}

describe("usePlaybackSteps", () => {
  let step: ReturnType<typeof usePlaybackSteps>["step"];
  function Probe() {
    step = usePlaybackSteps().step;
    return null;
  }

  it("steps from note to note on Auto, onto a slider's start and its end", () => {
    const { gameClock } = app();
    render(<Probe />);
    const visited = [1, 1, 1, 1].map(() => {
      step("note", 1);
      return gameClock.timeElapsedInMs;
    });
    expect(visited).toEqual([1_125, 1_291.67, 1_500, 1_750]);
    step("note", -1);
    expect(gameClock.timeElapsedInMs).toBe(1_500);
  });

  it("follows the Scroll step setting, read at each step", () => {
    const { gameClock, settings } = app({ scrollStep: "1/2" });
    render(<Probe />);
    step("note", 1);
    expect(gameClock.timeElapsedInMs).toBe(1_250);
    settings.scrollStep = "1/1";
    step("note", 1);
    expect(gameClock.timeElapsedInMs).toBe(1_500);
  });

  it("nudges 30 ms either way, whatever the Scroll step is, and stops at the ends of the map", () => {
    const { gameClock, settings } = app({ scrollStep: "1/1", time: 1_000 });
    render(<Probe />);
    step("nudge", 1);
    expect(gameClock.timeElapsedInMs).toBe(1_030);
    settings.scrollStep = "auto";
    step("nudge", 1);
    expect(gameClock.timeElapsedInMs).toBe(1_060);
    step("nudge", -1);
    step("nudge", -1);
    expect(gameClock.timeElapsedInMs).toBe(1_000);
    gameClock.timeElapsedInMs = 10;
    step("nudge", -1);
    expect(gameClock.timeElapsedInMs).toBe(0);
    gameClock.timeElapsedInMs = 9_990;
    step("nudge", 1);
    expect(gameClock.timeElapsedInMs).toBe(10_000);
  });

  it("steps a recorded frame and a bar", () => {
    const { gameClock } = app();
    render(<Probe />);
    step("frame", 1);
    // 1000 is between the frames at 992 and 1008: the first one at least 4 ms on.
    expect(gameClock.timeElapsedInMs).toBe(1_008);
    step("frame", -1);
    expect(gameClock.timeElapsedInMs).toBe(992);
    // 992 is before the first timing point, whose own time is the first bar line.
    step("bar", 1);
    expect(gameClock.timeElapsedInMs).toBe(1_000);
    step("bar", 1);
    expect(gameClock.timeElapsedInMs).toBe(3_000);
  });

  it("reads the beatmap's notes once, not at every step", () => {
    const { gameSimulator } = app();
    let reads = 0;
    const counted = {
      ...beatmap,
      get hitObjects() {
        reads++;
        return beatmap.hitObjects;
      },
    };
    gameSimulator.getPrimaryBeatmap.mockReturnValue(counted);
    render(<Probe />);
    step("note", 1);
    step("note", 1);
    step("frame", 1);
    expect(gameSimulator.getPrimaryBeatmap).toHaveBeenCalledTimes(3);
    expect(reads).toBe(1);
  });

  it("moves nothing while a clip is exporting, and steps by beats with no beatmap loaded", () => {
    const busy = app({ busy: true });
    const first = render(<Probe />);
    step("note", 1);
    expect(busy.gameClock.seekTo).not.toHaveBeenCalled();
    first.unmount();
    const blank = app();
    blank.gameSimulator.getPrimaryBeatmap.mockReturnValue(undefined as never);
    blank.gameSimulator.getPrimaryReplay.mockReturnValue(undefined as never);
    render(<Probe />);
    step("note", 1);
    expect(blank.gameClock.timeElapsedInMs).toBe(2_000);
  });
});

describe("usePlaybackWheel", () => {
  function mount(loaded = true) {
    const step = jest.fn<void, [StepKind, 1 | -1]>();
    function Probe() {
      usePlaybackWheel(step, () => loaded);
      return (
        <div>
          <div data-playback-wheel data-testid="stage">
            <canvas data-testid="canvas" />
          </div>
          <div data-testid="list" />
        </div>
      );
    }
    const view = render(<Probe />);
    const wheel = (testId: string, init: WheelEventInit) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      view.getByTestId(testId).dispatchEvent(event);
      return event;
    };
    return { step, wheel, view };
  }

  it("steps a note forward for a notch down and back for a notch up, over the stage", () => {
    const { step, wheel } = mount();
    expect(wheel("canvas", { deltaY: 100 }).defaultPrevented).toBe(true);
    wheel("canvas", { deltaY: -100 });
    expect(step.mock.calls).toEqual([
      ["note", 1],
      ["note", -1],
    ]);
  });

  it("leaves the wheel alone over a dialog, even one drawn inside the stage", () => {
    const step = jest.fn<void, [StepKind, 1 | -1]>();
    function Probe() {
      usePlaybackWheel(step, () => true);
      return (
        <div data-playback-wheel>
          <div role="dialog" data-testid="dialog" />
        </div>
      );
    }
    const view = render(<Probe />);
    for (const init of [{ deltaY: 100 }, { deltaY: 100, ctrlKey: true }, { deltaY: 100, shiftKey: true }]) {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      view.getByTestId("dialog").dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(step).not.toHaveBeenCalled();
  });

  it("steps a frame with Ctrl and a bar with Shift, which turns the wheel sideways", () => {
    const { step, wheel } = mount();
    wheel("canvas", { deltaY: 100, ctrlKey: true });
    wheel("canvas", { deltaX: -100, shiftKey: true });
    expect(step.mock.calls).toEqual([
      ["frame", 1],
      ["bar", -1],
    ]);
  });

  it("leaves the wheel alone outside the stage and the timeline, with Alt, and without a loaded replay", () => {
    const { step, wheel, view } = mount();
    expect(wheel("list", { deltaY: 100 }).defaultPrevented).toBe(false);
    expect(wheel("canvas", { deltaY: 100, altKey: true }).defaultPrevented).toBe(false);
    expect(step).not.toHaveBeenCalled();
    view.unmount();
    const unloaded = mount(false);
    unloaded.wheel("canvas", { deltaY: 100 });
    expect(unloaded.step).not.toHaveBeenCalled();
  });

  it("takes one notch as one step whatever size the mouse reports, and several notches at once as several", () => {
    const { step, wheel } = mount();
    for (let notch = 0; notch < 5; notch++) wheel("canvas", { deltaY: 120 });
    expect(step).toHaveBeenCalledTimes(5);
    step.mockClear();
    wheel("canvas", { deltaY: 300 });
    expect(step).toHaveBeenCalledTimes(3);
    step.mockClear();
    wheel("canvas", { deltaY: 5_000 });
    expect(step).toHaveBeenCalledTimes(8);
    step.mockClear();
    // Three lines is one notch on a wheel that reports lines.
    wheel("canvas", { deltaY: 3, deltaMode: 1 });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("adds a touchpad's small movements up to a notch, and starts again when they turn round", () => {
    const { step, wheel } = mount();
    for (let move = 0; move < 9; move++) wheel("canvas", { deltaY: 11 });
    expect(step).not.toHaveBeenCalled();
    wheel("canvas", { deltaY: 11 });
    expect(step.mock.calls).toEqual([["note", 1]]);
    step.mockClear();
    for (let move = 0; move < 8; move++) wheel("canvas", { deltaY: 11 });
    for (let move = 0; move < 8; move++) wheel("canvas", { deltaY: -11 });
    expect(step).not.toHaveBeenCalled();
  });

  it("stops listening when it goes away", () => {
    const { step, wheel, view } = mount();
    const canvas = view.getByTestId("canvas");
    view.unmount();
    document.body.appendChild(canvas);
    canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }));
    expect(step).not.toHaveBeenCalled();
    canvas.remove();
    void wheel;
  });
});

describe("stepping while the replay plays", () => {
  let step: ReturnType<typeof usePlaybackSteps>["step"];
  function Probe() {
    step = usePlaybackSteps().step;
    return null;
  }
  function playing() {
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    const gameClock = new GameplayClock();
    gameClock.setDuration(10_000);
    gameClock.seekTo(1_000);
    const gameSimulator = { getPrimaryBeatmap: () => beatmap, getPrimaryReplay: () => replay };
    jest.mocked(useAnalysisApp).mockReturnValue({ gameClock, gameSimulator, clipRecorder: { isBusy: false } } as never);
    jest.mocked(useCommonManagers).mockReturnValue({ playbarSettingsStore: { settings: { scrollStep: "auto", holdSpeed: 0.5 } } } as never);
    const view = render(<Probe />);
    gameClock.start();
    return { gameClock, view };
  }
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("holds playback for as long as the steps keep coming, and plays on half a second after the last", () => {
    expect(STEP_RESUME_MS).toBe(500);
    const { gameClock } = playing();
    step("note", 1);
    expect(gameClock.isPlaying).toBe(false);
    // Each step lands on its note, from a still frame.
    expect(gameClock.timeElapsedInMs).toBe(1_125);
    jest.advanceTimersByTime(400);
    step("note", 1);
    expect(gameClock.timeElapsedInMs).toBe(1_291.67);
    jest.advanceTimersByTime(499);
    expect(gameClock.isPlaying).toBe(false);
    jest.advanceTimersByTime(1);
    expect(gameClock.isPlaying).toBe(true);
    gameClock.pause();
  });

  it("holds and resumes playback for held-down nudges just as for any other step", () => {
    const { gameClock } = playing();
    // A held arrow key repeats: each press is 30 ms on from a still frame, and playback goes on after the last.
    step("nudge", 1);
    expect(gameClock.isPlaying).toBe(false);
    expect(gameClock.timeElapsedInMs).toBe(1_030);
    for (const expected of [1_060, 1_090, 1_120]) {
      jest.advanceTimersByTime(33);
      step("nudge", 1);
      expect(gameClock.timeElapsedInMs).toBe(expected);
    }
    jest.advanceTimersByTime(499);
    expect(gameClock.isPlaying).toBe(false);
    jest.advanceTimersByTime(1);
    expect(gameClock.isPlaying).toBe(true);
    gameClock.pause();
  });

  it("stays paused after a step when the replay was paused already", () => {
    const { gameClock } = playing();
    gameClock.pause();
    step("note", 1);
    jest.advanceTimersByTime(2_000);
    expect(gameClock.isPlaying).toBe(false);
  });

  it("leaves it to the viewer once they play, pause or seek themselves during the hold", () => {
    const { gameClock } = playing();
    step("note", 1);
    // Space: play, then pause again. The pause stands.
    gameClock.start();
    gameClock.pause();
    jest.advanceTimersByTime(2_000);
    expect(gameClock.isPlaying).toBe(false);

    gameClock.start();
    step("note", 1);
    // An incident is selected: its own seek, and it stays paused there.
    gameClock.seekTo(5_000);
    jest.advanceTimersByTime(2_000);
    expect(gameClock.isPlaying).toBe(false);
    expect(gameClock.timeElapsedInMs).toBe(5_000);
  });

  it("does not play on after stepping out of an incident replay or a clip preview", () => {
    const { gameClock } = playing();
    gameClock.setPlaybackBoundary(3_000);
    step("note", 1);
    expect(gameClock.isPlaying).toBe(false);
    jest.advanceTimersByTime(2_000);
    expect(gameClock.isPlaying).toBe(false);
  });

  it("does not play on once the shortcuts are gone", () => {
    const { gameClock, view } = playing();
    step("note", 1);
    view.unmount();
    jest.advanceTimersByTime(2_000);
    expect(gameClock.isPlaying).toBe(false);
  });
});
