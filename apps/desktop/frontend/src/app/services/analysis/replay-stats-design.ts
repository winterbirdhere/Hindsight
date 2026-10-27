import { ReplaySliderColors } from "../../utils/constants";

/**
 * The pre-redesign stats look, pinned instead of following `rewindTheme` / `REWIND_COLORS`. The exported clip no
 * longer draws it (its column is `drawSidePanel`); the full-map performance summary still reads the pp and star
 * values and the star path.
 * The old `body1.letterSpacing` was undefined for a non-Roboto family, so canvas received an
 * invalid spacing and kept "0px"; 0 draws identically without the NaN.
 */
export const REPLAY_STATS_DESIGN = {
  fontFamily: '"Segoe UI", Inter, Arial, sans-serif',
  letterSpacingEm: 0,
  width: 176,
  labelWidth: 120,
  valueWidth: 40,
  valueWidthCh: 3,
  columnGap: 3.2,
  countRowGap: 1.6,
  performanceBottomGap: 8,
  sliderTopGap: 10,
  sliderRowGap: 3,
  sliderColors: ReplaySliderColors,
  shadow: { x: 0, y: 1, blur: 4, color: "rgba(0, 0, 0, 0.9)" },
  pp: { fontSize: 34, fontWeight: 850, lineHeight: 1.15, color: "#fff" },
  sr: { fontSize: 23, fontWeight: 800, lineHeight: 1.3, color: "#ffcc66" },
  metricLabel: { fontSize: 20.5, fontWeight: 850, lineHeight: 1.18 },
  metricValue: { fontSize: 20.5, fontWeight: 800, lineHeight: 1.18, color: "rgba(255, 255, 255, 0.96)" },
  starSize: 24,
  starGap: 4,
} as const;

// Material StarRounded, also used by the live stats panel (24×24 viewBox).
export const REPLAY_STATS_STAR_PATH =
  "m12 17.27 4.15 2.51c.76.46 1.69-.22 1.49-1.08l-1.1-4.72 3.67-3.18c.67-.58.31-1.68-.57-1.75l-4.83-.41-1.89-4.46c-.34-.81-1.5-.81-1.84 0L9.19 8.63l-4.83.41c-.88.07-1.24 1.17-.57 1.75l3.67 3.18-1.1 4.72c-.2.86.73 1.54 1.49 1.08z";
