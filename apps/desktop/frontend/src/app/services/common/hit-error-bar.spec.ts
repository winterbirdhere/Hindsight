import {
  DEFAULT_HIT_ERROR_BAR_SCALE,
  HIT_ERROR_LEGACY_KEY,
  UR_BAR_PERCENT,
  sanitizeUrBarScale,
  urBarPercentToScale,
  urBarScaleToPercent,
} from "./hit-error-bar";

describe("UR bar size helpers", () => {
  it("exposes the stored defaults and the percent range", () => {
    expect(DEFAULT_HIT_ERROR_BAR_SCALE).toBe(2);
    expect(HIT_ERROR_LEGACY_KEY).toBe("hit-error");
    expect(UR_BAR_PERCENT).toEqual({ min: 50, max: 200, step: 5 });
  });

  it.each([
    [2, 100],
    [3, 150],
    [1, 50],
    [4, 200],
    [0.6, 30],
  ])("shows scale %p as %p%%", (scale, percent) => {
    expect(urBarScaleToPercent(scale)).toBe(percent);
    expect(urBarPercentToScale(percent)).toBeCloseTo(scale);
  });

  it.each([0, -1, NaN, Infinity, 1e9, null, "2", undefined])("falls back to 2.0 for %p", (value) => {
    expect(sanitizeUrBarScale(value)).toBe(2);
  });

  it("keeps a usable scale up to 8", () => {
    expect(sanitizeUrBarScale(0.6)).toBe(0.6);
    expect(sanitizeUrBarScale(8)).toBe(8);
  });
});
