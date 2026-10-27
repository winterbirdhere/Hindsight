import { OsuAction, ReplayButtonState, ReplayFrame } from "./Replay";
import {
  calculateReplayButtonIntervals,
  FIRST_LAZER_REPLAY_VERSION,
  replayButtonEncodingForGameVersion,
} from "./ReplayClicks";

const frame = (time: number, rawButtonMask: ReplayButtonState, actions: OsuAction[]): ReplayFrame => ({
  time,
  position: { x: 0, y: 0 },
  actions,
  rawButtonMask,
});

describe("calculateReplayButtonIntervals", () => {
  it("decodes the 5/10/15 masks emitted for Stable keyboard input without false mouse lanes", () => {
    const intervals = calculateReplayButtonIntervals([
      frame(0, ReplayButtonState.None, []),
      frame(10, ReplayButtonState.Left1 | ReplayButtonState.Left2, [OsuAction.leftButton]),
      frame(
        20,
        ReplayButtonState.Left1 | ReplayButtonState.Left2 | ReplayButtonState.Right1 | ReplayButtonState.Right2,
        [OsuAction.leftButton, OsuAction.rightButton],
      ),
      frame(30, ReplayButtonState.Right1 | ReplayButtonState.Right2, [OsuAction.rightButton]),
      frame(40, ReplayButtonState.None, []),
    ]);

    expect(intervals).toEqual({
      K1: [[10, 30]],
      K2: [[20, 40]],
      M1: [],
      M2: [],
    });
  });

  it("preserves mouse-only input alongside the opposite keyboard lane", () => {
    const intervals = calculateReplayButtonIntervals([
      frame(0, ReplayButtonState.Left1, [OsuAction.leftButton]),
      frame(10, ReplayButtonState.Left1 | ReplayButtonState.Right1 | ReplayButtonState.Right2, [
        OsuAction.leftButton,
        OsuAction.rightButton,
      ]),
      frame(20, ReplayButtonState.Right1 | ReplayButtonState.Right2, [OsuAction.rightButton]),
      frame(30, ReplayButtonState.Right1, [OsuAction.rightButton]),
      frame(40, ReplayButtonState.Right1 | ReplayButtonState.Left1 | ReplayButtonState.Left2, [
        OsuAction.leftButton,
        OsuAction.rightButton,
      ]),
      frame(50, ReplayButtonState.Left1 | ReplayButtonState.Left2, [OsuAction.leftButton]),
      frame(60, ReplayButtonState.None, []),
    ]);

    expect(intervals).toEqual({
      K1: [[40, 60]],
      K2: [[10, 30]],
      M1: [[0, 20]],
      M2: [[30, 50]],
    });
  });

  it("uses logical input as two keyboard lanes when raw masks are unavailable", () => {
    const frames: ReplayFrame[] = [
      { time: 0, position: { x: 0, y: 0 }, actions: [OsuAction.leftButton] },
      { time: 10, position: { x: 0, y: 0 }, actions: [OsuAction.rightButton] },
      { time: 20, position: { x: 0, y: 0 }, actions: [] },
    ];

    expect(calculateReplayButtonIntervals(frames)).toEqual({
      K1: [[0, 10]],
      K2: [[10, 20]],
      M1: [],
      M2: [],
    });
  });

  it("maps Lazer-exported logical masks to keyboard-coloured lanes without inventing mouse input", () => {
    const frames = [
      frame(0, ReplayButtonState.None, []),
      frame(10, ReplayButtonState.Left1, [OsuAction.leftButton]),
      frame(20, ReplayButtonState.Left1 | ReplayButtonState.Right1, [OsuAction.leftButton, OsuAction.rightButton]),
      frame(30, ReplayButtonState.Right1, [OsuAction.rightButton]),
      frame(40, ReplayButtonState.None, []),
    ];

    expect(calculateReplayButtonIntervals(frames, "lazer-logical")).toEqual({
      K1: [[10, 30]],
      K2: [[20, 40]],
      M1: [],
      M2: [],
    });
  });

  it("uses exact zero-delta Lazer frames instead of extending a merged press", () => {
    const mergedRelease = frame(10, ReplayButtonState.Left1, [OsuAction.leftButton]);
    mergedRelease.sourceFramesAtSameTime = [
      frame(10, ReplayButtonState.Left1, [OsuAction.leftButton]),
      frame(10, ReplayButtonState.None, []),
    ];

    const intervals = calculateReplayButtonIntervals(
      [frame(0, ReplayButtonState.Left1, [OsuAction.leftButton]), mergedRelease, frame(20, ReplayButtonState.None, [])],
      "lazer-logical",
    );

    expect(intervals.K1).toEqual([[0, 10]]);
    expect(intervals.M1).toEqual([]);
  });

  it("selects logical-only decoding for the reserved Lazer replay version range", () => {
    expect(replayButtonEncodingForGameVersion(FIRST_LAZER_REPLAY_VERSION - 1)).toBe("stable-physical");
    expect(replayButtonEncodingForGameVersion(FIRST_LAZER_REPLAY_VERSION)).toBe("lazer-logical");
    expect(replayButtonEncodingForGameVersion(30_000_016)).toBe("lazer-logical");
    expect(replayButtonEncodingForGameVersion(Number.NaN)).toBe("stable-physical");
    expect(replayButtonEncodingForGameVersion(Number.POSITIVE_INFINITY)).toBe("stable-physical");
    expect(replayButtonEncodingForGameVersion(undefined)).toBe("stable-physical");
  });
});
