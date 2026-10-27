import { hexToNumber, REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS, REWIND_LAYOUT } from "./tokens";
import { rewindTheme } from "./theme";

describe("design tokens", () => {
  it("matches the approved palette and layout", () => {
    expect(REWIND_COLORS).toMatchObject({
      bg: "#131418",
      stage: "#0b0b0d",
      surface: "#1a1b20",
      dock: "#1a1b20",
      control: "#262830",
      inset: "#0f1013",
      controlActive: "#30323a",
      hairline: "rgba(255,255,255,0.1)",
      textPrimary: "#f5f4f1",
      textSecondary: "#c9c6c0",
      textTertiary: "#a8a59e",
      textQuaternary: "#5f5d58",
      focus: "#f2f1ee",
      accent: "#ff7aa0",
      accentSoft: "#ff9cbc",
      judgement300: "#7cc4f5",
      judgement100: "#8fe8af",
      judgement50: "#f5cd6e",
      judgementMiss: "#ff7082",
      sliderBreak: "#c7b3ff",
      sliderEnd: "#b5b0d6",
      star: "#f5d27a",
      hitWindow300: "#3ba7e3",
      hitWindow100: "#4cc54a",
      hitWindow50: "#d9a93b",
      pressMark: "#ff5468",
      key1: "#f2b45e",
      key2: "#74d9a2",
    });
    expect(REWIND_FOCUS_RING).toEqual({ outline: "2px solid #f2f1ee", outlineOffset: 2 });
    expect(REWIND_LAYOUT).toEqual({ inspectorWidth: 260, dockHeight: 86, timelineRowHeight: 50, transportRowHeight: 36 });
    expect(REWIND_FONTS.ui.startsWith('"Geist"')).toBe(true);
    expect(REWIND_FONTS.mono.startsWith('"Geist Mono"')).toBe(true);
  });

  it("converts hex colours for Pixi tints", () => {
    expect(hexToNumber("#f2b45e")).toBe(0xf2b45e);
    expect(hexToNumber("74d9a2")).toBe(0x74d9a2);
  });

  it("drives the MUI theme from the tokens", () => {
    expect(rewindTheme.palette.primary.main).toBe(REWIND_COLORS.accent);
    expect(rewindTheme.palette.background.default).toBe(REWIND_COLORS.bg);
    expect(rewindTheme.palette.background.paper).toBe(REWIND_COLORS.surface);
    expect(rewindTheme.typography.fontFamily).toBe(REWIND_FONTS.ui);
  });
});
