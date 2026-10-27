export type PlaybarMarkerPlacement = "above" | "below";

/** The dock's 50 px timeline lane; the rail is the 2 px line at y 25–27 (README §4.1). */
export const PLAYBAR_EVENT_CANVAS_HEIGHT = 50;
export const PLAYBAR_RAIL_TOP = 25;
export const PLAYBAR_RAIL_BOTTOM = 27;
const PLAYBAR_MARKER_GAP = 1;

export interface PlaybarMarkerBounds {
  top: number;
  height: number;
}

export function calculatePlaybarMarkerBounds(
  placement: PlaybarMarkerPlacement,
  requestedHeight: number,
): PlaybarMarkerBounds {
  const upperBandEnd = PLAYBAR_RAIL_TOP - PLAYBAR_MARKER_GAP;
  const lowerBandStart = PLAYBAR_RAIL_BOTTOM + PLAYBAR_MARKER_GAP;
  const availableHeight = placement === "above" ? upperBandEnd : PLAYBAR_EVENT_CANVAS_HEIGHT - lowerBandStart;
  const height = Math.max(0, Math.min(requestedHeight, availableHeight));
  return placement === "above" ? { top: upperBandEnd - height, height } : { top: lowerBandStart, height };
}

/** Marks start at their time (not centred on it) and keep fractional widths; only the lane edge clamps them. */
export function playbarMarkerLeft(timing: number, duration: number, laneWidth: number, markerWidth: number): number {
  return playbarMarkerLeftIn(timing, { startMs: 0, endMs: duration }, laneWidth, markerWidth);
}

/** The same for a lane that shows one stretch of the map, from `startMs` at its left edge to `endMs` at its right. */
export function playbarMarkerLeftIn(
  timing: number,
  view: { startMs: number; endMs: number },
  laneWidth: number,
  markerWidth: number,
): number {
  const position = ((timing - view.startMs) / Math.max(1, view.endMs - view.startMs)) * laneWidth;
  return Math.max(0, Math.min(laneWidth - markerWidth, position));
}
