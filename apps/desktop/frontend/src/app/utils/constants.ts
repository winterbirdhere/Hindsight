export const ALLOWED_SPEEDS: readonly number[] = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
export const ReplaySliderColors = {
  break: "#a8a8a8",
  tick: "#a8a8a8",
  end: "#7e8289",
} as const;
// Currently, it's a feature that is hard to implement, enable it once ready
export const PlaybarColors = {
  GREAT: "rgb(84, 205, 255)",
  OK: "rgb(108, 229, 121)",
  MEH: "rgb(255, 199, 92)",
  MISS: "rgb(255, 82, 112)",
  SLIDER_BREAK: ReplaySliderColors.break,
  SLIDER_TICK_MISS: ReplaySliderColors.tick,
  SLIDER_END_MISS: ReplaySliderColors.end,
};
export const AnalysisStatsColors = {
  ...PlaybarColors,
  SLIDER_BREAK: "rgb(226, 184, 255)",
  SLIDER_TICK_MISS: "rgb(226, 184, 255)",
  SLIDER_END_MISS: "#B18AFF",
  NOTELOCK: "#FF9BC7",
};
export const AnalysisSliderLabels = {
  SLIDER_BREAK: "SliderBreak",
  SLIDER_TICK_MISS: "SliderTick",
  SLIDER_END_MISS: "SliderEnd",
} as const;
export const SliderMissFeedbackTints = {
  SLIDER_TICK_MISS: 0xe2b8ff,
  SLIDER_END_MISS: 0x8248ff,
};
