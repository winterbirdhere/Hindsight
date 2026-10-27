import "reflect-metadata";
import { act, render } from "@testing-library/react";
import type { ReplayAnalysisEvent } from "@osujs/core";
import { BehaviorSubject } from "rxjs";
import { useAnalysisApp } from "../providers/TheaterProvider";
import { GameplayClock } from "../services/common/game/GameplayClock";
import { ErrorNavigationProvider, type ErrorNavigationState, useErrorNavigation } from "./error-navigation";

jest.mock("../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));

// The incident replay against the real clock and the real transport controls: the order in which the clock stops,
// pins the playhead and reports a seek is what the replay has to get right.
const miss = (id: string, time: number): ReplayAnalysisEvent =>
  ({
    type: "HitObjectJudgement",
    ruleset: "stable",
    hitObjectId: id,
    verdict: "MISS",
    time,
    objectTime: time,
    judgementTime: time,
    position: { x: 0, y: 0 },
  }) as ReplayAnalysisEvent;

let nav: ErrorNavigationState;
function Probe() {
  nav = useErrorNavigation();
  return null;
}

function mount() {
  const clock = new GameplayClock();
  clock.setDuration(100_000);
  (useAnalysisApp as jest.Mock).mockReturnValue({
    gameClock: clock,
    scenarioManager: { loadState$: new BehaviorSubject({ phase: "ready" }) },
    clipRecorder: { isBusy: false },
    replayDisplaySettingsStore: (() => {
      const settings = { errorCauseDisplay: "concise" };
      return { settings, settings$: new BehaviorSubject(settings) };
    })(),
    gameSimulator: {
      replayEvents$: new BehaviorSubject([miss("a", 5_000), miss("b", 40_000)]),
      rulesetFocus$: new BehaviorSubject<"stable" | "lazer">("stable"),
      missExplanations$: new BehaviorSubject({ status: "not-captured" }),
      missAnalysisProgress$: new BehaviorSubject(undefined),
      getPrimaryReplay: () => undefined,
      hasReplayForMissAnalysis: () => false,
      analyzeMisses: jest.fn(),
    },
  });
  const view = render(
    <ErrorNavigationProvider>
      <Probe />
    </ErrorNavigationProvider>,
  );
  return { clock, view };
}
const transport = (clock: GameplayClock) => ({
  time: clock.timeElapsedInMs,
  playing: clock.isPlaying,
  speed: clock.speed,
  boundary: clock.playbackBoundaryInMs,
});
/** Playback arriving at (or past) a time: the clock's own tick decides what happens there. */
function playTo(clock: GameplayClock, timeMs: number) {
  clock.timeElapsedInMs = timeMs;
  act(() => void clock.tick());
  act(() => void jest.advanceTimersByTime(50));
}

describe("incident replay on the real clock", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("plays from 1.5 s before the error at the chosen speed, bounded 1.2 s after it", () => {
    const { clock } = mount();
    act(() => nav.selectError(0));
    act(() => clock.setSpeed(1.5));
    act(() => nav.replaySelection(0.5));
    // 1500 × 0.5 = 750 ms before, 1200 × 0.5 = 600 ms after.
    expect(transport(clock)).toEqual({ time: 4_250, playing: true, speed: 0.5, boundary: 5_600 });
    expect(nav.replayingSpeed).toBe(0.5);
  });

  it("stops by itself at the end, returns to the error paused, and the viewer's speed is what it was", () => {
    const { clock } = mount();
    act(() => nav.selectError(0));
    act(() => clock.setSpeed(1.5));
    act(() => nav.replaySelection(0.25));
    playTo(clock, 5_400);
    expect(transport(clock)).toEqual({ time: 5_000, playing: false, speed: 1.5, boundary: undefined });
    expect(nav.replayingSpeed).toBeUndefined();
    expect(nav.selectedIndex).toBe(0);
    // Ordinary playback afterwards is the viewer's again: no boundary stops it.
    act(() => clock.start());
    playTo(clock, 30_000);
    expect(clock.isPlaying).toBe(true);
    expect(clock.speed).toBe(1.5);
  });

  it("a pause on the way gives the speed back and keeps the playhead where it was paused", () => {
    const { clock } = mount();
    act(() => nav.selectError(0));
    act(() => nav.replaySelection(0.25));
    clock.timeElapsedInMs = 4_900;
    act(() => clock.pause());
    act(() => void jest.advanceTimersByTime(50));
    expect(transport(clock)).toEqual({ time: 4_900, playing: false, speed: 1, boundary: undefined });
    expect(nav.replayingSpeed).toBeUndefined();
  });

  it("a seek on the way ends it and playback goes on at the viewer's speed", () => {
    const { clock } = mount();
    act(() => nav.selectError(0));
    act(() => nav.replaySelection(0.5));
    act(() => clock.seekTo(20_000));
    expect(transport(clock)).toEqual({ time: 20_000, playing: true, speed: 1, boundary: undefined });
    expect(nav.replayingSpeed).toBeUndefined();
  });

  it("selecting another incident during a replay ends it and goes there", () => {
    const { clock } = mount();
    act(() => nav.selectError(0));
    act(() => nav.replaySelection(0.5));
    act(() => nav.selectError(1));
    act(() => void jest.advanceTimersByTime(50));
    expect(transport(clock)).toEqual({ time: 40_000, playing: false, speed: 1, boundary: undefined });
    expect(nav.selectedIndex).toBe(1);
  });

  it("replaying again while one plays restarts it and still ends with the viewer's speed", () => {
    const { clock } = mount();
    act(() => nav.selectError(0));
    act(() => clock.setSpeed(2));
    act(() => nav.replaySelection(0.25));
    act(() => nav.replaySelection(1));
    expect(transport(clock)).toEqual({ time: 3_500, playing: true, speed: 1, boundary: 6_200 });
    playTo(clock, 6_200);
    expect(transport(clock)).toEqual({ time: 5_000, playing: false, speed: 2, boundary: undefined });
  });

  it("gives the transport back when the analyzer goes away mid-replay", () => {
    const { clock, view } = mount();
    act(() => nav.selectError(0));
    act(() => clock.setSpeed(1.5));
    act(() => nav.replaySelection(0.25));
    view.unmount();
    expect(clock.speed).toBe(1.5);
    expect(clock.playbackBoundaryInMs).toBeUndefined();
  });
});
