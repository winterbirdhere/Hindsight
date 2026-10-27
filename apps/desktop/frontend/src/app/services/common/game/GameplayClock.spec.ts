import { GameplayClock } from "./GameplayClock";

describe("GameplayClock deterministic capture ownership", () => {
  afterEach(() => jest.restoreAllMocks());

  it("uses exact fractional timestamps despite wall time, audio position, rates, and playback boundaries", () => {
    let now = 0;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    const clock = new GameplayClock();
    clock.setDuration(20_000);
    clock.setBaseRate(1.5);
    clock.setSpeed(0.5);
    clock.setPlaybackBoundary(3000);
    const audioPosition = jest.fn(() => 19_000);
    clock.setTimeSource(audioPosition);
    const seek = jest.fn();
    clock.seeked$.subscribe(seek);
    const capture = clock.beginOfflineCapture();
    for (const timestamp of [0, 1000 / 3, 1234.56789, 3000, 5555.55555]) {
      capture.setTime(timestamp);
      now += 12_000;
      clock.updateTimeElapsed();
      expect(clock.tick()).toBe(timestamp);
      expect(clock.tick()).toBe(timestamp);
      expect(clock.isPlaying).toBe(false);
    }
    expect(seek).not.toHaveBeenCalled();
    expect(audioPosition).not.toHaveBeenCalled();
    capture.dispose();
  });

  it("requires a paused clock and blocks external playback or seeks until release", () => {
    const clock = new GameplayClock();
    clock.setDuration(20_000);
    clock.start();
    expect(() => clock.beginOfflineCapture()).toThrow("paused");
    clock.pause();
    const capture = clock.beginOfflineCapture();
    capture.setTime(500);
    expect(() => clock.beginOfflineCapture()).toThrow("already active");
    expect(() => clock.start()).toThrow("owns");
    expect(() => (clock.isPlaying = true)).toThrow("owns");
    expect(() => clock.seekTo(1000)).toThrow("owns");
    expect(clock.tick()).toBe(500);
    capture.dispose();
    capture.dispose();
    clock.seekTo(1000);
    clock.start();
    expect(clock.isPlaying).toBe(true);
  });

  it("rejects invalid timestamps and stale owners without changing the current capture", () => {
    const clock = new GameplayClock();
    clock.setDuration(20_000);
    const first = clock.beginOfflineCapture();
    first.setTime(1234);
    for (const timestamp of [NaN, Infinity, -1, 20_001]) {
      expect(() => first.setTime(timestamp)).toThrow("Invalid");
      expect(clock.tick()).toBe(1234);
    }
    clock.clear();
    clock.setDuration(10_000);
    const second = clock.beginOfflineCapture();
    second.setTime(555);
    expect(() => first.setTime(777)).toThrow("no longer active");
    first.dispose();
    expect(() => clock.beginOfflineCapture()).toThrow("already active");
    expect(clock.tick()).toBe(555);
    second.dispose();
  });

  it("resumes the ordinary fallback or attached audio clock without charging time spent exporting", () => {
    let now = 0;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    const clock = new GameplayClock();
    clock.setDuration(20_000);
    const capture = clock.beginOfflineCapture();
    capture.setTime(1000);
    now = 90_000;
    capture.dispose();
    expect(clock.isPlaying).toBe(false);
    clock.start();
    now += 25;
    expect(clock.tick()).toBe(1025);
    clock.pause();
    const audioPosition = jest.fn(() => 8000);
    clock.setTimeSource(audioPosition);
    const next = clock.beginOfflineCapture();
    next.setTime(2000);
    now += 90_000;
    expect(clock.tick()).toBe(2000);
    next.dispose();
    clock.start();
    expect(clock.tick()).toBe(8000);
  });
});

describe("GameplayClock audio synchronization", () => {
  afterEach(() => jest.restoreAllMocks());

  it("includes time spent notifying playback listeners in the fallback clock", () => {
    let now = 0;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    const clock = new GameplayClock();
    clock.setDuration(10_000);
    clock.isPlaying$.subscribe((playing) => {
      if (playing) now += 120;
    });
    clock.start();
    expect(clock.tick()).toBe(120);
  });

  it("follows the audio position through startup delay, drift, seeks, and rate changes", () => {
    let now = 0;
    let audioTime = 0;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    const clock = new GameplayClock();
    clock.setDuration(300_000);
    clock.setTimeSource(() => audioTime);
    clock.start();

    // The media play promise can still be pending while the wall clock moves.
    now = 200;
    expect(clock.tick()).toBe(0);
    audioTime = 1_000;
    now = 1_220;
    expect(clock.tick()).toBe(1_000);
    // Drift cannot accumulate over the four-minute Koi no Stadium replay.
    audioTime = 240_000;
    now = 240_530;
    expect(clock.tick()).toBe(240_000);

    clock.seeked$.subscribe((time) => (audioTime = time));
    clock.seekTo(30_000);
    now += 250;
    expect(clock.tick()).toBe(30_000);
    clock.setBaseRate(1.5);
    clock.setSpeed(0.5);
    audioTime += 750;
    now += 1_000;
    expect(clock.tick()).toBe(30_750);

    clock.pause();
    now += 2_000;
    expect(clock.tick()).toBe(30_750);
    clock.start();
    expect(clock.tick()).toBe(30_750);
    audioTime += 75;
    now += 100;
    expect(clock.tick()).toBe(30_825);
  });

  it("stops at the exact media endpoint and can detach the audio clock", () => {
    let now = 0;
    let audioTime = 0;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    const clock = new GameplayClock();
    clock.setDuration(1_000);
    clock.setTimeSource(() => audioTime);
    clock.start();
    audioTime = 1_000;
    expect(clock.tick()).toBe(1_000);
    expect(clock.isPlaying).toBe(false);

    clock.setTimeSource(undefined);
    clock.seekTo(100);
    clock.start();
    now = 200;
    expect(clock.tick()).toBe(300);
  });
});

describe("GameplayClock playback rate", () => {
  it("keeps the viewer multiplier separate from the replay mod rate", () => {
    const clock = new GameplayClock();

    clock.setBaseRate(1.5);
    expect(clock.baseRate).toBe(1.5);
    expect(clock.speed).toBe(1);
    expect(clock.playbackRate).toBe(1.5);

    clock.setSpeed(0.5);
    expect(clock.speed).toBe(0.5);
    expect(clock.playbackRate).toBe(0.75);
  });

  it("resets both rates when a replay is cleared", () => {
    const clock = new GameplayClock();
    clock.setBaseRate(0.75);
    clock.setSpeed(1.75);

    clock.clear();

    expect(clock.baseRate).toBe(1);
    expect(clock.speed).toBe(1);
    expect(clock.playbackRate).toBe(1);
  });
});

describe("GameplayClock held speed", () => {
  it("plays at the held speed and gives the viewer's speed back on release", () => {
    const clock = new GameplayClock();
    clock.setBaseRate(1.5);
    clock.setSpeed(1.25);
    expect(clock.viewerSpeed).toBe(1.25);
    clock.holdSpeed(0.5);
    expect([clock.speed, clock.viewerSpeed, clock.playbackRate]).toEqual([0.5, 1.25, 0.75]);
    // The key repeats, or a second key is held: nothing changes.
    clock.holdSpeed(0.25);
    expect([clock.speed, clock.viewerSpeed]).toEqual([0.5, 1.25]);
    clock.releaseSpeed();
    expect([clock.speed, clock.viewerSpeed, clock.playbackRate]).toEqual([1.25, 1.25, 1.875]);
    clock.releaseSpeed();
    expect(clock.speed).toBe(1.25);
  });

  it("lets a speed that is set during the hold stay: the release gives nothing back", () => {
    const clock = new GameplayClock();
    clock.holdSpeed(0.5);
    clock.setSpeed(0.25);
    expect([clock.speed, clock.viewerSpeed]).toEqual([0.25, 0.25]);
    clock.releaseSpeed();
    expect(clock.speed).toBe(0.25);
  });

  it("keeps the playhead where it is when the speed changes, and ignores a speed that is not one", () => {
    let now = 0;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    const clock = new GameplayClock();
    clock.setDuration(10_000);
    clock.start();
    now = 1_000;
    clock.holdSpeed(0.5);
    now = 2_000;
    clock.releaseSpeed();
    now = 3_000;
    // One second at 1×, one at 0.5×, one at 1×.
    expect(clock.tick()).toBe(2_500);
    clock.holdSpeed(0);
    clock.holdSpeed(Number.NaN);
    expect(clock.speed).toBe(1);
    jest.restoreAllMocks();
  });

  it("forgets a held speed when the replay is cleared", () => {
    const clock = new GameplayClock();
    clock.setSpeed(1.5);
    clock.holdSpeed(0.5);
    clock.clear();
    clock.releaseSpeed();
    expect([clock.speed, clock.viewerSpeed]).toEqual([1, 1]);
  });
});

describe("GameplayClock one-pass capture", () => {
  afterEach(() => jest.restoreAllMocks());

  function fixture() {
    let audioTime = 0;
    const clock = new GameplayClock();
    clock.setDuration(20_000);
    clock.setTimeSource(() => audioTime);
    const seek = jest.fn((time: number) => {
      audioTime = time;
    });
    clock.seeked$.subscribe(seek);
    return {
      clock,
      seek,
      advanceAudio: (time: number) => {
        audioTime = time;
      },
    };
  }

  it("pauses exactly at a clip endpoint and can resume after releasing the boundary", () => {
    const { clock, advanceAudio } = fixture();
    clock.seekTo(3_000);
    clock.setPlaybackBoundary(5_000);
    clock.start();
    advanceAudio(5_020);
    expect(clock.tick()).toBe(5_000);
    expect(clock.isPlaying).toBe(false);
    expect(clock.playbackBoundaryInMs).toBe(5_000);
    clock.setPlaybackBoundary(undefined);
    clock.start();
    expect(clock.timeElapsedInMs).toBe(5_000);
    advanceAudio(5_500);
    expect(clock.tick()).toBe(5_500);
    expect(clock.isPlaying).toBe(true);
  });

  it("clears the capture boundary for the next replay and protects later analysis from media metadata", () => {
    const { clock } = fixture();
    clock.setAnalysisEnd(20_000);
    clock.setDuration(10_000);
    expect(clock.durationInMs).toBe(20_000);
    clock.setPlaybackBoundary(19_000);
    clock.clear();
    expect(clock.playbackBoundaryInMs).toBeUndefined();
    clock.setDuration(1_000);
    expect(clock.durationInMs).toBe(1_000);
  });
});
