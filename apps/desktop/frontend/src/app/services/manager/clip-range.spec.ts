import { createClipFramePlan, MIN_CLIP_DURATION_MS } from "./clip-export-types";
import {
  type ClipRange,
  clipElapsedSeconds,
  clipVideoSeconds,
  formatClipSeconds,
  formatClipTime,
  laneFraction,
  laneTime,
  normalizeClipRange,
  parseClipTime,
  withClipEnd,
  withClipLength,
  withClipStart,
} from "./clip-range";

describe("clip time formats", () => {
  it.each([[0, "0:00"], [62000, "1:02"], [70000, "1:10"], [62500, "1:02.5"], [66472, "1:06.472"], [66472.4, "1:06.472"], [3599999.6, "60:00"]])(
    "formatClipTime(%p) is %p", (ms, text) => expect(formatClipTime(ms)).toBe(text));
  it.each([[8, "8"], [0.25, "0.25"], [5.33333, "5.333"], [4.4720001, "4.472"], [0, "0"]])(
    "formatClipSeconds(%p) is %p", (s, text) => expect(formatClipSeconds(s)).toBe(text));
  it.each([["1:02", 62000], ["1:02.5", 62500], [" 0:07 ", 7000], ["62", 62000], ["62.5", 62500], ["0", 0]])(
    "parseClipTime(%p) is %p", (text, ms) => expect(parseClipTime(text)).toBe(ms));
  it.each(["", " ", "abc", "-3", "1:75", "1:2:3", "1:02,5", "1e3", "Infinity", ":30"])(
    "parseClipTime(%p) is undefined", (text) => expect(parseClipTime(text)).toBeUndefined());
});

describe("clip range", () => {
  const D = 200_000;
  it("uses the whole replay for no range, a broken range and a replay under the minimum", () => {
    expect(normalizeClipRange(null, D)).toEqual({ startMs: 0, endMs: D });
    expect(normalizeClipRange({ startMs: NaN, endMs: 5 }, D)).toEqual({ startMs: 0, endMs: D });
    expect(normalizeClipRange({ startMs: 10, endMs: 20 }, 100)).toEqual({ startMs: 0, endMs: 100 });
  });
  it("keeps at least the minimum, moving the end first and the start only at the replay's end", () => {
    expect(normalizeClipRange({ startMs: 5000, endMs: 5100 }, D)).toEqual({ startMs: 5000, endMs: 5250 });
    expect(normalizeClipRange({ startMs: D - 100, endMs: D + 900 }, D)).toEqual({ startMs: D - 250, endMs: D });
  });
  it("clamps an edited bound against the other one", () => {
    expect(withClipStart({ startMs: 0, endMs: 10_000 }, 9_900, D)).toEqual({ startMs: 9_750, endMs: 10_000 });
    expect(withClipStart({ startMs: 500, endMs: 10_000 }, -40, D)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(withClipEnd({ startMs: 5_000, endMs: 10_000 }, 100, D)).toEqual({ startMs: 5_000, endMs: 5_250 });
    expect(withClipEnd({ startMs: 5_000, endMs: 10_000 }, D + 1, D)).toEqual({ startMs: 5_000, endMs: D });
  });
  it("turns a video length into map time at the playback rate", () => {
    expect(withClipLength({ startMs: 62_000, endMs: 70_000 }, 4, 1.5, D)).toEqual({ startMs: 62_000, endMs: 68_000 });
    expect(withClipLength({ startMs: 62_000, endMs: 70_000 }, 0, 1, D)).toEqual({ startMs: 62_000, endMs: 62_250 });
    expect(clipVideoSeconds({ startMs: 62_000, endMs: 70_000 }, 1.5)).toBeCloseTo(5.3333, 4);
  });
  it("measures elapsed clip time inside the range only", () => {
    const range = { startMs: 62_000, endMs: 70_000 };
    expect(clipElapsedSeconds(66_472, range, 1)).toBeCloseTo(4.472, 6);
    expect(clipElapsedSeconds(10, range, 1)).toBe(0);
    expect(clipElapsedSeconds(90_000, range, 2)).toBe(4);
  });
  it("keeps the minimum for fractional bounds and durations (review I1)", () => {
    const duration = 108876.64092147478;
    const range = normalizeClipRange({ startMs: 65407.810151336664, endMs: 54079.537619090006 }, duration);
    expect(range.startMs).toBeGreaterThanOrEqual(0);
    expect(range.endMs).toBeLessThanOrEqual(duration);
    expect(range.endMs - range.startMs).toBeGreaterThanOrEqual(MIN_CLIP_DURATION_MS);
    expect(Number.isInteger(range.startMs)).toBe(true);
  });
  const seededRandom = (start: number): (() => number) => {
    let seed = start;
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  it("returns a valid range with a whole-millisecond start for fractional inputs (seeded fuzz)", () => {
    const random = seededRandom(20261005);
    const check = (result: ClipRange, duration: number): void => {
      if (duration < MIN_CLIP_DURATION_MS) return;
      const ok =
        Number.isInteger(result.startMs) &&
        result.startMs >= 0 &&
        result.endMs <= duration &&
        result.endMs - result.startMs >= MIN_CLIP_DURATION_MS;
      if (!ok) throw new Error(`invalid ${JSON.stringify(result)} for duration ${duration}`);
    };
    for (let i = 0; i < 2000; i += 1) {
      const duration = random() < 0.15 ? random() * 250 : 250 + random() * 1_000_000;
      const point = (): number => (random() * 1.3 - 0.15) * duration;
      const range = { startMs: point(), endMs: point() };
      const rate = 0.1 + random() * 3.9;
      expect(normalizeClipRange(null, duration)).toEqual({ startMs: 0, endMs: duration });
      check(normalizeClipRange(range, duration), duration);
      check(withClipStart(range, point(), duration), duration);
      check(withClipEnd(range, point(), duration), duration);
      check(withClipLength(range, random() * (duration / 1000) * 1.5, rate, duration), duration);
      check(withClipLength(range, random() * 0.5, rate, duration), duration);
    }
  });
  it("keeps a typed length exact at a rate that is not round", () => {
    const range = withClipLength({ startMs: 1000, endMs: 9000 }, 5, 0.9375, D);
    expect(range.endMs).toBe(5687.5);
    expect(clipVideoSeconds(range, 0.9375)).toBe(5);
  });
  it("does not add a frame to a typed length", () => {
    for (const rate of [0.9375, 1.125, 0.75, 1.5]) {
      for (const fps of [60, 120, 144, 240] as const) {
        for (const length of [5, 2.5, 1201 / 240]) {
          const range = normalizeClipRange(withClipLength({ startMs: 1000, endMs: 9000 }, length, rate, D), D);
          const plan = createClipFramePlan(range.startMs, range.endMs, rate, fps);
          expect(plan.frameCount).toBe(Math.ceil(length * fps - 1e-9));
        }
      }
    }
  });
  it("normalizing twice changes nothing (seeded fuzz)", () => {
    const random = seededRandom(7);
    for (let i = 0; i < 2000; i += 1) {
      const duration = random() < 0.15 ? random() * 250 : 250 + random() * 1_000_000;
      const point = (): number => (random() * 1.3 - 0.15) * duration;
      const once = normalizeClipRange({ startMs: point(), endMs: point() }, duration);
      expect(normalizeClipRange(once, duration)).toEqual(once);
    }
  });
  it("leaves the range alone for a non-finite video length or a bad playback rate", () => {
    const range = { startMs: 62_000, endMs: 70_000 };
    for (const seconds of [NaN, Infinity, -Infinity]) {
      expect(withClipLength(range, seconds, 1, D)).toBe(range);
    }
    for (const rate of [0, -1, NaN]) {
      expect(withClipLength(range, 4, rate, D)).toBe(range);
    }
  });
  it("maps the lane to time and back", () => {
    expect(laneFraction(50_000, D)).toBe(0.25);
    expect(laneFraction(5, 0)).toBe(0);
    expect(laneTime(316, 16, 1200, D)).toBe(50_000);
    expect(laneTime(0, 16, 1200, D)).toBe(0);
    expect(laneTime(5000, 16, 1200, D)).toBe(D);
    expect(laneTime(300, 16, 0, D)).toBe(0);
  });
  it("gives whole milliseconds along the lane, and exactly the duration at the right edge", () => {
    expect(Number.isInteger(laneTime(316.4, 16, 1200, D))).toBe(true);
    expect(laneTime(5000, 16, 1200, 108876.64)).toBe(108876.64);
  });
});
