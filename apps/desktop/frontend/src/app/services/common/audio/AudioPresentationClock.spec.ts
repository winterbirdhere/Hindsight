import { AudioPresentationClock, AudioPresentationSnapshot } from "./AudioPresentationClock";

function at(
  contextTime: number,
  mediaTimeInMs: number,
  overrides: Partial<AudioPresentationSnapshot> = {},
): AudioPresentationSnapshot {
  return {
    contextTime,
    mediaTimeInMs,
    performanceTime: contextTime * 1000,
    playbackRate: 1,
    isPlaying: true,
    contextState: "running",
    baseLatency: 0.01,
    outputLatency: 0.04,
    outputTimestamp: { contextTime: contextTime - 0.05, performanceTime: contextTime * 1000 },
    ...overrides,
  };
}

describe("AudioPresentationClock", () => {
  it.each([0.5, 1.5, 2])("smooths WSOLA phase impulses without adding playback delay at rate %s", (playbackRate) => {
    const clock = new AudioPresentationClock();
    let previous = 0;
    const phaseErrors: number[] = [];
    const stepErrors: number[] = [];
    for (let frame = 0; frame <= 1500; ++frame) {
      const wallTime = 1 + frame * 0.002;
      const block = Math.floor(frame / 5);
      const contextTime = 1 + block * 0.01;
      // A 10ms input-consumption cycle measured through a 500Hz display.
      const impulse = block % 2 === 0 ? 4 : -4;
      const result = clock.read(
        at(contextTime, contextTime * playbackRate * 1000 + impulse, {
          playbackRate,
          performanceTime: wallTime * 1000,
          outputTimestamp: { contextTime: contextTime - 0.05, performanceTime: contextTime * 1000 },
        }),
      );
      if (frame > 500) {
        phaseErrors.push(result - (wallTime - 0.05) * playbackRate * 1000);
        stepErrors.push(Math.abs(result - previous - 2 * playbackRate));
      }
      previous = result;
    }
    expect(Math.max(...stepErrors)).toBeLessThan(0.09);
    expect(Math.abs(phaseErrors.reduce((sum, error) => sum + error, 0) / phaseErrors.length)).toBeLessThan(0.01);
    expect(Math.max(...phaseErrors.map(Math.abs))).toBeLessThan(0.21);
  });

  it("does not apply extra phase correction for repeated reads of one audio quantum", () => {
    const once = new AudioPresentationClock();
    const frequently = new AudioPresentationClock();
    for (let block = 0; block < 200; ++block) {
      const contextTime = 1 + block * 0.01;
      const mediaTime = contextTime * 1500 + (block % 2 === 0 ? 4 : -4);
      const snapshot = at(contextTime, mediaTime, { playbackRate: 1.5 });
      expect(frequently.read(snapshot)).toBeCloseTo(once.read(snapshot), 8);
      for (let extraRead = 1; extraRead <= 4; ++extraRead) {
        frequently.read({ ...snapshot, performanceTime: snapshot.performanceTime + extraRead * 2 });
      }
    }
  });

  it("corrects a sustained media-phase change instead of allowing long-term drift", () => {
    const clock = new AudioPresentationClock();
    for (let step = 0; step <= 300; ++step) {
      const contextTime = 1 + step * 0.01;
      const phase = step >= 100 ? 20 : 0;
      const result = clock.read(at(contextTime, contextTime * 1500 + phase, { playbackRate: 1.5 }));
      if (step >= 200) expect(result).toBeCloseTo((contextTime - 0.05) * 1500 + phase, 2);
    }
  });

  it("does not rewrite an already rendered quantum when speed changes between callbacks", () => {
    const clock = new AudioPresentationClock();
    clock.read(at(1, 1000));
    clock.read(at(1.04, 1040));
    const outputTimestamp = { contextTime: 1.02, performanceTime: 1040 };
    expect(clock.read(at(1.04, 1040, { outputTimestamp }))).toBeCloseTo(1020, 8);
    clock.read(at(1.04, 1040, { outputTimestamp, playbackRate: 0.5 }));
    expect(clock.read(at(1.04, 1040, { outputTimestamp, playbackRate: 0.5, performanceTime: 1050 }))).toBeCloseTo(
      1030,
      8,
    );
  });

  it.each([0.5, 1.5])(
    "retains the queued rate when speed changes to %s with only one observed quantum",
    (playbackRate) => {
      const clock = new AudioPresentationClock();
      expect(clock.read(at(1, 1000))).toBeCloseTo(950, 8);
      expect(clock.read(at(1, 1000, { playbackRate }))).toBeCloseTo(950, 8);
      expect(clock.read(at(1, 1000, { playbackRate, performanceTime: 1020 }))).toBeCloseTo(970, 8);
      expect(clock.read(at(1.02, 1000 + playbackRate * 20, { playbackRate }))).toBeCloseTo(970, 8);
      expect(clock.read(at(1.06, 1000 + playbackRate * 60, { playbackRate }))).toBeCloseTo(1000 + playbackRate * 10, 8);
    },
  );

  it("projects the output timestamp to now without counting the reported delay twice", () => {
    const clock = new AudioPresentationClock();
    expect(
      clock.read(
        at(4, 1000, {
          performanceTime: 2010,
          outputTimestamp: { contextTime: 3.94, performanceTime: 2000 },
        }),
      ),
    ).toBeCloseTo(950, 8);
    // No new render block is available, but the output device keeps consuming
    // already rendered audio between JavaScript animation frames.
    expect(
      clock.read(
        at(4, 1000, {
          performanceTime: 2020,
          outputTimestamp: { contextTime: 3.94, performanceTime: 2000 },
        }),
      ),
    ).toBeCloseTo(960, 8);
  });

  it("holds the start/seek position while the first audio is still queued", () => {
    const clock = new AudioPresentationClock();
    clock.reset(0);
    expect(clock.read(at(10, 0))).toBe(0);
    expect(clock.read(at(10.03, 30))).toBe(0);
    expect(clock.read(at(10.07, 70))).toBeCloseTo(20, 8);
  });

  it("uses the rate of the audio still in the queue across slow and fast rate changes", () => {
    const clock = new AudioPresentationClock();
    expect(clock.read(at(1, 1000))).toBeCloseTo(950, 8);
    expect(clock.read(at(1.04, 1040))).toBeCloseTo(990, 8);
    // Rate changes to 0.5 at context time 1.04. The output at 1.03 still
    // contains audio produced at the previous 1x rate.
    expect(clock.read(at(1.08, 1060, { playbackRate: 0.5 }))).toBeCloseTo(1030, 8);
    // Rate changes to 1.5 at context time 1.08. The output at 1.07 still
    // contains the half-speed segment.
    expect(clock.read(at(1.12, 1120, { playbackRate: 1.5 }))).toBeCloseTo(1055, 8);
    expect(clock.read(at(1.2, 1240, { playbackRate: 1.5 }))).toBeCloseTo(1165, 8);
  });

  it.each([0.5, 1, 1.5])("does not accumulate drift over five minutes at rate %s", (playbackRate) => {
    const clock = new AudioPresentationClock();
    clock.reset(0);
    for (let step = 0; step <= 3000; ++step) {
      const seconds = step / 10;
      const contextTime = seconds + 100;
      const result = clock.read(
        at(contextTime, seconds * playbackRate * 1000, {
          playbackRate,
          outputTimestamp: {
            contextTime: contextTime - 0.058,
            performanceTime: contextTime * 1000 - 8,
          },
        }),
      );
      expect(result).toBeCloseTo(Math.max(0, (seconds - 0.05) * playbackRate * 1000), 6);
    }
  });

  it("flushes old-song and old-seek positions, including a backwards seek", () => {
    const clock = new AudioPresentationClock();
    clock.reset(100000);
    clock.read(at(100, 100000));
    expect(clock.read(at(100.1, 100100))).toBeCloseTo(100050, 8);
    clock.reset(5000);
    expect(clock.read(at(100.2, 5000, { isSeeking: true }))).toBe(5000);
    expect(clock.read(at(100.23, 5030))).toBe(5000);
    expect(clock.read(at(100.27, 5070))).toBeCloseTo(5020, 8);
    clock.reset(0);
    expect(clock.read(at(100.3, 0))).toBe(0);
  });

  it("keeps the exact restored pause position and waits for output on resume", () => {
    const clock = new AudioPresentationClock();
    clock.reset(0);
    clock.read(at(10, 0));
    expect(clock.read(at(10.07, 70))).toBeCloseTo(20, 8);
    // The transport pauses and restores media to the last presented position.
    expect(clock.read(at(10.08, 20, { isPlaying: false }))).toBe(20);
    expect(clock.read(at(10.5, 20, { isPlaying: false }))).toBe(20);
    expect(clock.read(at(10.5, 20))).toBe(20);
    expect(clock.read(at(10.57, 90))).toBeCloseTo(40, 8);
  });

  it("does not rewind past the requested seek while the decoder settles", () => {
    const clock = new AudioPresentationClock();
    clock.reset(5000);
    expect(clock.read(at(1, 5000, { isSeeking: true }))).toBe(5000);
    expect(clock.read(at(1.02, 4980))).toBe(5000);
    expect(clock.read(at(1.1, 5060))).toBeCloseTo(5010, 8);
  });

  it("stops advancing once buffered audio drains during a media stall", () => {
    const clock = new AudioPresentationClock();
    clock.read(at(1, 1000));
    expect(clock.read(at(1.05, 1000, { isInputStopped: true }))).toBeCloseTo(1000, 8);
    expect(clock.read(at(1.3, 1000, { isInputStopped: true }))).toBeCloseTo(1000, 8);
    expect(clock.read(at(1.4, 1100))).toBeCloseTo(1050, 8);
  });

  it("lets already queued audio reach the end while media position has stopped", () => {
    const clock = new AudioPresentationClock();
    clock.reset(900);
    clock.read(at(1, 900));
    expect(clock.read(at(1.1, 1000))).toBeCloseTo(950, 8);
    expect(clock.read(at(1.12, 1000, { isInputStopped: true }))).toBeCloseTo(970, 8);
    expect(clock.read(at(1.15, 1000, { isInputStopped: true }))).toBeCloseTo(1000, 8);
    expect(clock.read(at(1.2, 1000, { isInputStopped: true }))).toBeCloseTo(1000, 8);
  });

  it("waits for a suspended context instead of advancing gameplay", () => {
    const clock = new AudioPresentationClock();
    clock.reset(30000);
    expect(clock.read(at(2, 30020, { contextState: "suspended" }))).toBe(30000);
    expect(clock.read(at(2.01, 30030))).toBe(30000);
  });

  it.each([
    undefined,
    { contextTime: 0, performanceTime: 0 },
    { contextTime: NaN, performanceTime: 1000 },
    { contextTime: 0.9, performanceTime: Infinity },
    { contextTime: 1.1, performanceTime: 1000 },
    { contextTime: 0.9, performanceTime: 1001 },
    { contextTime: 0.9, performanceTime: -1 },
  ])("falls back to reported latency for an unavailable or invalid timestamp: %p", (outputTimestamp) => {
    const clock = new AudioPresentationClock();
    expect(clock.read(at(1, 1000, { outputTimestamp }))).toBeCloseTo(950, 8);
  });

  it("rejects an output timestamp that has stopped updating", () => {
    const clock = new AudioPresentationClock();
    expect(clock.read(at(10, 1000, { outputTimestamp: { contextTime: 0.5, performanceTime: 1000 } }))).toBeCloseTo(
      950,
      8,
    );
  });

  it("uses history for a rate change even when only reported latency is available", () => {
    const clock = new AudioPresentationClock();
    clock.read(at(1, 1000, { outputTimestamp: undefined }));
    clock.read(at(1.04, 1040, { outputTimestamp: undefined }));
    expect(clock.read(at(1.08, 1060, { outputTimestamp: undefined, playbackRate: 0.5 }))).toBeCloseTo(1030, 8);
  });

  it("holds instead of jumping backwards when a device reports more latency", () => {
    const clock = new AudioPresentationClock();
    expect(clock.read(at(1, 1000))).toBeCloseTo(950, 8);
    expect(
      clock.read(at(1.02, 1020, { outputTimestamp: undefined, baseLatency: 0.02, outputLatency: 0.08 })),
    ).toBeCloseTo(950, 8);
    expect(
      clock.read(at(1.12, 1120, { outputTimestamp: undefined, baseLatency: 0.02, outputLatency: 0.08 })),
    ).toBeCloseTo(1020, 8);
  });

  it("reanchors after an AudioContext origin change without rewinding media", () => {
    const clock = new AudioPresentationClock();
    expect(clock.read(at(10, 1000))).toBeCloseTo(950, 8);
    expect(clock.read(at(0.1, 1010))).toBeCloseTo(960, 8);
    expect(clock.read(at(0.2, 1110))).toBeCloseTo(1060, 8);
  });

  it("preserves standalone behavior if the environment has no output-timing API", () => {
    const clock = new AudioPresentationClock();
    expect(
      clock.read(at(1, 1000, { outputTimestamp: undefined, baseLatency: undefined, outputLatency: undefined })),
    ).toBe(1000);
  });

  it("does not allow malformed timing values to poison the playback position", () => {
    const clock = new AudioPresentationClock();
    expect(clock.read(at(NaN, 1000, { playbackRate: NaN }))).toBeCloseTo(950, 8);
    expect(clock.read(at(NaN, NaN, { outputLatency: NaN, baseLatency: Infinity }))).toBeCloseTo(950, 8);
  });
});
