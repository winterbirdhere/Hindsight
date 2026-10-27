import {
  enterClipPreview,
  followClipRange,
  leaveClipPreview,
  toggleClipPreview,
  type PreviewClock,
} from "./clip-preview-transport";
import type { ClipRange } from "./clip-range";

const RANGE: ClipRange = { startMs: 62_000, endMs: 70_000 };

/** A clock that does what GameplayClock does to its own state and records every call, in order. */
function fakeClock(initial: Partial<{ time: number; playing: boolean; boundary: number; speed: number }> = {}) {
  const calls: string[] = [];
  const clock = {
    timeElapsedInMs: initial.time ?? 0,
    isPlaying: initial.playing ?? false,
    playbackBoundaryInMs: initial.boundary as number | undefined,
    speed: initial.speed ?? 1,
    pause: () => {
      calls.push("pause");
      clock.isPlaying = false;
    },
    start: () => {
      calls.push("start");
      clock.isPlaying = true;
    },
    seekTo: (timeMs: number) => {
      calls.push(`seekTo(${timeMs})`);
      clock.timeElapsedInMs = timeMs;
    },
    setPlaybackBoundary: (endMs: number | undefined) => {
      calls.push(`setPlaybackBoundary(${endMs})`);
      clock.playbackBoundaryInMs = endMs;
    },
    setSpeed: (speed: number) => {
      calls.push(`setSpeed(${speed})`);
      clock.speed = speed;
    },
  };
  // Structural check: the fake must stay assignable to what the transport functions take.
  const asPreviewClock: PreviewClock = clock;
  void asPreviewClock;
  return { clock, calls };
}

describe("enterClipPreview", () => {
  it("pauses, bounds playback at the end and keeps a playhead that is inside the range", () => {
    const { clock, calls } = fakeClock({ time: 65_000, playing: true });
    enterClipPreview(clock, RANGE, 1);
    expect(calls).toEqual(["pause", "setSpeed(1)", "setPlaybackBoundary(70000)"]);
    expect(calls.some((call) => call.startsWith("seekTo"))).toBe(false);
    expect(clock.isPlaying).toBe(false);
    expect(clock.timeElapsedInMs).toBe(65_000);
  });

  it("moves a playhead outside the range to the start", () => {
    for (const time of [10, 90_000]) {
      const { clock, calls } = fakeClock({ time });
      enterClipPreview(clock, RANGE, 1);
      expect(calls).toContain("seekTo(62000)");
      expect(calls.filter((call) => call.startsWith("seekTo"))).toEqual(["seekTo(62000)"]);
      expect(clock.timeElapsedInMs).toBe(62_000);
    }
  });

  it("keeps a playhead that sits exactly on a bound", () => {
    for (const time of [62_000, 70_000]) {
      const { clock, calls } = fakeClock({ time });
      enterClipPreview(clock, RANGE, 1);
      expect(calls.some((call) => call.startsWith("seekTo"))).toBe(false);
    }
  });

  it("returns the transport it found", () => {
    const { clock } = fakeClock({ time: 12_345, playing: true, speed: 0.5 });
    expect(enterClipPreview(clock, RANGE, 1)).toEqual({ time: 12_345, playing: true, boundary: undefined, speed: 0.5 });
    const { clock: bounded } = fakeClock({ time: 5, playing: false, boundary: 40_000, speed: 2 });
    expect(enterClipPreview(bounded, RANGE, 1)).toEqual({ time: 5, playing: false, boundary: 40_000, speed: 2 });
  });

  it("switches to the clip speed on entering and back to the viewer's on leaving", () => {
    const { clock, calls } = fakeClock({ time: 65_000, speed: 0.5 });
    const snapshot = enterClipPreview(clock, RANGE, 1);
    expect(calls).toContain("setSpeed(1)");
    expect(clock.speed).toBe(1);
    leaveClipPreview(clock, snapshot, true);
    expect(calls[calls.length - 1]).not.toBe("setSpeed(0.5)");
    expect(calls).toContain("setSpeed(0.5)");
    expect(clock.speed).toBe(0.5);
  });
});

describe("followClipRange", () => {
  it("follows a moved start to the start and a moved end to the end", () => {
    const moved = fakeClock({ time: 66_000, playing: true });
    followClipRange(moved.clock, RANGE, { startMs: 63_000, endMs: 70_000 });
    expect(moved.calls).toEqual(["pause", "setPlaybackBoundary(70000)", "seekTo(63000)"]);
    expect(moved.clock.playbackBoundaryInMs).toBe(70_000);
    expect(moved.clock.timeElapsedInMs).toBe(63_000);
    expect(moved.clock.isPlaying).toBe(false);

    const shortened = fakeClock({ time: 66_000, playing: true });
    followClipRange(shortened.clock, RANGE, { startMs: 62_000, endMs: 69_000 });
    expect(shortened.calls).toEqual(["pause", "setPlaybackBoundary(69000)", "seekTo(69000)"]);
    expect(shortened.clock.playbackBoundaryInMs).toBe(69_000);
    expect(shortened.clock.timeElapsedInMs).toBe(69_000);
  });

  it("goes to the start when both bounds moved", () => {
    const { clock, calls } = fakeClock({ time: 66_000 });
    followClipRange(clock, RANGE, { startMs: 63_000, endMs: 69_000 });
    expect(calls).toEqual(["pause", "setPlaybackBoundary(69000)", "seekTo(63000)"]);
  });

  it("does not seek when the range did not change", () => {
    const { clock, calls } = fakeClock({ time: 66_000, playing: true });
    followClipRange(clock, RANGE, { ...RANGE });
    expect(calls.some((call) => call.startsWith("seekTo"))).toBe(false);
    expect(clock.timeElapsedInMs).toBe(66_000);
    expect(clock.playbackBoundaryInMs).toBe(70_000);
  });
});

describe("toggleClipPreview", () => {
  it("plays from the start when the playhead is at the end or outside", () => {
    for (const time of [70_000, 10, 90_000]) {
      const { clock, calls } = fakeClock({ time });
      toggleClipPreview(clock, RANGE);
      expect(calls).toEqual(["setPlaybackBoundary(70000)", "seekTo(62000)", "start"]);
      expect(clock.isPlaying).toBe(true);
      expect(clock.timeElapsedInMs).toBe(62_000);
    }
  });

  it("plays from the playhead when it is inside the range", () => {
    for (const time of [62_000, 66_000]) {
      const { clock, calls } = fakeClock({ time });
      toggleClipPreview(clock, RANGE);
      expect(calls).toEqual(["setPlaybackBoundary(70000)", "start"]);
      expect(clock.timeElapsedInMs).toBe(time);
    }
  });

  it("pauses a playing preview", () => {
    const { clock, calls } = fakeClock({ time: 66_000, playing: true });
    toggleClipPreview(clock, RANGE);
    expect(calls).toEqual(["pause"]);
    expect(clock.isPlaying).toBe(false);
    expect(clock.timeElapsedInMs).toBe(66_000);
  });
});

describe("leaveClipPreview", () => {
  const snapshot = { time: 12_345, playing: true, boundary: undefined, speed: 0.5 };

  function inClipPreview() {
    const fake = fakeClock({ time: 66_000, playing: true, boundary: 70_000, speed: 1 });
    fake.calls.length = 0;
    return fake;
  }

  it("restores boundary and time, resumes only when asked, and seeks last", () => {
    const resumed = inClipPreview();
    leaveClipPreview(resumed.clock, snapshot, true);
    expect(resumed.calls).toEqual([
      "pause",
      "setPlaybackBoundary(undefined)",
      "setSpeed(0.5)",
      "start",
      "seekTo(12345)",
    ]);
    expect(resumed.clock.playbackBoundaryInMs).toBeUndefined();
    expect(resumed.clock.speed).toBe(0.5);
    expect(resumed.clock.timeElapsedInMs).toBe(12_345);
    expect(resumed.clock.isPlaying).toBe(true);

    const notResumed = inClipPreview();
    leaveClipPreview(notResumed.clock, snapshot, false);
    expect(notResumed.calls).toEqual(["pause", "setPlaybackBoundary(undefined)", "setSpeed(0.5)", "seekTo(12345)"]);
    expect(notResumed.clock.isPlaying).toBe(false);

    const wasPaused = inClipPreview();
    leaveClipPreview(wasPaused.clock, { ...snapshot, playing: false }, true);
    expect(wasPaused.calls).not.toContain("start");
    expect(wasPaused.calls[wasPaused.calls.length - 1]).toBe("seekTo(12345)");
    expect(wasPaused.clock.isPlaying).toBe(false);
  });

  it("puts back a boundary the viewer already had", () => {
    const { clock } = inClipPreview();
    leaveClipPreview(clock, { ...snapshot, boundary: 40_000 }, false);
    expect(clock.playbackBoundaryInMs).toBe(40_000);
  });
});
