export const DEFAULT_HIT_ERROR_BAR_SCALE = 2.0;
/** Storage key of the pre-3a viewer UR bar store; read only by the settings migration. */
export const HIT_ERROR_LEGACY_KEY = "hit-error";
/** The UR bar size as shown to people: a percentage of the default scale. */
export const UR_BAR_PERCENT = { min: 50, max: 200, step: 5 } as const;

const MAX_UR_BAR_SCALE = 8;

export function sanitizeUrBarScale(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_UR_BAR_SCALE
    ? value
    : DEFAULT_HIT_ERROR_BAR_SCALE;
}

export function urBarScaleToPercent(scale: number): number {
  return Math.round((sanitizeUrBarScale(scale) / DEFAULT_HIT_ERROR_BAR_SCALE) * 100);
}

export function urBarPercentToScale(percent: number): number {
  return (percent / 100) * DEFAULT_HIT_ERROR_BAR_SCALE;
}
