import {
  COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE,
  DEFAULT_ANALYSIS_CURSOR_TRAIL_STYLE,
  analysisCursorTrailAlpha,
} from "./AnalysisCursor";

describe("analysis cursor trail styling", () => {
  it("uses a light neutral trail that stays visibly separate from the cyan comparison trace", () => {
    const red = (COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE.color >> 16) & 0xff;
    const green = (COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE.color >> 8) & 0xff;
    const blue = COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE.color & 0xff;

    expect(Math.max(red, green, blue) - Math.min(red, green, blue)).toBeLessThan(16);
    expect(Math.min(red, green, blue)).toBeGreaterThan(220);
    expect(COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE.width).toBeGreaterThanOrEqual(2);
    expect(analysisCursorTrailAlpha(0, COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE)).toBeGreaterThanOrEqual(0.2);
    expect(analysisCursorTrailAlpha(1, COMPARISON_ANALYSIS_CURSOR_TRAIL_STYLE)).toBe(1);
  });

  it("retains the original dark-gray trail as the normal default", () => {
    expect(DEFAULT_ANALYSIS_CURSOR_TRAIL_STYLE).toEqual({ color: 0x5d6463, width: 1, minimumAlpha: 0 });
    expect(analysisCursorTrailAlpha(0)).toBe(0);
  });
});
