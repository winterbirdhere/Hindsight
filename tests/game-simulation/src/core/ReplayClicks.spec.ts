import { parseReplayFramesFromFS } from "../others";
import { testReplayPath } from "../util";
import {
  calculateReplayButtonIntervals,
  calculateReplayClicks,
  OsuAction,
  parseReplayFramesFromRaw,
  ReplayButtonState,
  ReplayFrame,
} from "@osujs/core";

describe("calculateReplayClicks", function () {
  it("should calculate clicks correctly for replay frames that have a click starting at 0", function () {
    const replay = parseReplayFramesFromFS(
      testReplayPath("kellad - Asriel - Raison D'etre [EXist] (2025-02-16) Osu.osr"),
    );
    const replayClicks = calculateReplayClicks(replay);
    expect(replayClicks.map((r) => r.length)).toEqual([839, 878]);
  });

  it("keeps existing logical click intervals when physical inputs overlap", function () {
    const frames: ReplayFrame[] = [
      {
        time: 0,
        position: { x: 0, y: 0 },
        actions: [OsuAction.leftButton],
        rawButtonMask: ReplayButtonState.Left2,
      },
      {
        time: 10,
        position: { x: 0, y: 0 },
        actions: [OsuAction.leftButton],
        rawButtonMask: ReplayButtonState.Left2 | ReplayButtonState.Left1,
      },
      {
        time: 20,
        position: { x: 0, y: 0 },
        actions: [OsuAction.leftButton, OsuAction.rightButton],
        rawButtonMask: ReplayButtonState.Left1 | ReplayButtonState.Right2,
      },
      {
        time: 30,
        position: { x: 0, y: 0 },
        actions: [OsuAction.rightButton],
        rawButtonMask: ReplayButtonState.Right1,
      },
      { time: 40, position: { x: 0, y: 0 }, actions: [], rawButtonMask: ReplayButtonState.None },
    ];

    expect(calculateReplayClicks(frames)).toEqual([[[0, 30]], [[20, 40]]]);
  });
});

describe("calculateReplayButtonIntervals", function () {
  it("does not interpret Stable keyboard aliases as mouse presses", function () {
    const frames: ReplayFrame[] = [
      {
        time: 0,
        position: { x: 0, y: 0 },
        actions: [OsuAction.leftButton],
        rawButtonMask: ReplayButtonState.Left1 | ReplayButtonState.Left2,
      },
      {
        time: 10,
        position: { x: 0, y: 0 },
        actions: [OsuAction.leftButton, OsuAction.rightButton],
        rawButtonMask:
          ReplayButtonState.Left1 | ReplayButtonState.Left2 | ReplayButtonState.Right1 | ReplayButtonState.Right2,
      },
      {
        time: 20,
        position: { x: 0, y: 0 },
        actions: [OsuAction.rightButton],
        rawButtonMask: ReplayButtonState.Right1 | ReplayButtonState.Right2,
      },
      { time: 30, position: { x: 0, y: 0 }, actions: [], rawButtonMask: ReplayButtonState.None },
    ];

    expect(calculateReplayButtonIntervals(frames)).toEqual({
      K1: [[0, 20]],
      K2: [[10, 30]],
      M1: [],
      M2: [],
    });
  });

  it("keeps mouse-only and cross-side mixed inputs distinct", function () {
    const frames: ReplayFrame[] = [
      {
        time: 0,
        position: { x: 0, y: 0 },
        actions: [OsuAction.leftButton],
        rawButtonMask: ReplayButtonState.Left1,
      },
      {
        time: 10,
        position: { x: 0, y: 0 },
        actions: [OsuAction.leftButton, OsuAction.rightButton],
        rawButtonMask: ReplayButtonState.Left1 | ReplayButtonState.Right1 | ReplayButtonState.Right2,
      },
      {
        time: 20,
        position: { x: 0, y: 0 },
        actions: [OsuAction.rightButton],
        rawButtonMask: ReplayButtonState.Right1 | ReplayButtonState.Right2,
      },
      { time: 30, position: { x: 0, y: 0 }, actions: [], rawButtonMask: ReplayButtonState.None },
    ];

    expect(calculateReplayButtonIntervals(frames)).toEqual({
      K1: [],
      K2: [[10, 30]],
      M1: [[0, 20]],
      M2: [],
    });
  });

  it("preserves and merges raw button masks on same-time replay frames", function () {
    const frames = parseReplayFramesFromRaw("0|0|0|4,10|1|1|1,0|1|1|8,10|2|2|0");

    expect(frames.map((frame) => frame.rawButtonMask)).toEqual([4, 9, 0]);
    expect(frames[1].actions).toEqual([OsuAction.leftButton, OsuAction.rightButton]);
  });
});
