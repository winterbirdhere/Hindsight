/** Single source of the analyzer's visual language (3a; docs/design/rewind-3a/README.md §8). */
export const REWIND_COLORS = {
  /** Page base behind the shell; also diagram and field-adjacent wells. */
  bg: "#131418",
  /** Behind the playfield and beatmap art. */
  stage: "#0b0b0d",
  /** Inspector and dock panels. */
  surface: "#1a1b20",
  dock: "#1a1b20",
  /** Raised buttons (with `controlEdge`). */
  control: "#262830",
  controlHover: "#2d2f38",
  controlEdge: "inset 0 0 0 1px rgba(255,255,255,0.12)",
  /** Fields and the recessed track behind segmented controls. */
  inset: "#0f1013",
  /** Selected segment. */
  controlActive: "#30323a",
  /** Inspector-drawer handle; lighter than `control` so it reads over beatmap art. */
  handle: "#2d2f38",
  hairline: "rgba(255,255,255,0.1)",
  hairlineSoft: "rgba(255,255,255,0.07)",
  statDivider: "rgba(255,255,255,0.16)",
  textPrimary: "#f5f4f1",
  /** Player, mods and dock text. */
  textBright: "#e2dfd9",
  /** Quiet list times (the mock's #bdbab3). */
  textSoft: "#bdbab3",
  /** Hover and emphasis text, the cue mark. */
  white: "#ffffff",
  /** Follow-up headline, ms part of a time. */
  textMuted: "#d6d3cd",
  textSecondary: "#c9c6c0",
  /** Section labels and counters. */
  textTertiary: "#a8a59e",
  /** Off toggles. */
  textDim: "#8a877f",
  /** Disabled. */
  textQuaternary: "#5f5d58",
  focus: "#f2f1ee",
  /** Pink: trail end / active dot. */
  accent: "#ff7aa0",
  /** Pink link. */
  accentSoft: "#ff9cbc",
  accentGlow: "#ff5f8f",
  judgement300: "#7cc4f5",
  judgement100: "#8fe8af",
  judgement50: "#f5cd6e",
  judgementMiss: "#ff7082",
  sliderBreak: "#c7b3ff",
  sliderEnd: "#b5b0d6",
  hitWindow300: "#3ba7e3",
  hitWindow100: "#4cc54a",
  hitWindow50: "#d9a93b",
  pressMark: "#ff5468",
  key1: "#f2b45e",
  key2: "#74d9a2",
  star: "#f5d27a",
} as const;

/** Keyboard focus ring for analyzer controls; ripples are disabled globally, so this is the only focus cue. */
export const REWIND_FOCUS_RING = { outline: `2px solid ${REWIND_COLORS.focus}`, outlineOffset: 2 } as const;

export const REWIND_FONTS = {
  ui: '"Geist", "Segoe UI", sans-serif',
  mono: '"Geist Mono", "Cascadia Mono", Consolas, monospace',
} as const;

export const REWIND_LAYOUT = { inspectorWidth: 260, dockHeight: 86, timelineRowHeight: 50, transportRowHeight: 36 } as const;

export function hexToNumber(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}
