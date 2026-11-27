// The whole game stage will be in the virtual size 1600x900 (16:9) format
export const STAGE_WIDTH = 1600;
export const STAGE_HEIGHT = 900;
export const ANALYSIS_LEFT_HUD_X = 16;
export const ANALYSIS_TIMING_HUD_TOP = 64;
export const ANALYSIS_TIMING_HUD_HEIGHT = 28;

/** Clear the corner action on small displays without reserving canvas space. */
export function calculateTimingHudTop(viewportTop: number, stageScale: number): number {
  // The 36px corner action starts at 8px; leave another 8px above timing text.
  return stageScale > 0 ? Math.max(ANALYSIS_TIMING_HUD_TOP, (52 - viewportTop) / stageScale) : ANALYSIS_TIMING_HUD_TOP;
}
