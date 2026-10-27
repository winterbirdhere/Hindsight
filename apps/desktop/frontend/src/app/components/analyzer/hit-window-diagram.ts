export interface HitWindowDiagramModel {
  segments: { kind: "50" | "100" | "300"; flex: number }[];
  /** Press-mark centre, as a percentage of the diagram's width. */
  markPercent: number;
  label: string;
}

/** Fraction of the diagram's width from the centre line to the edge of the 50 window (band at 14 %–86 %). */
const HALF_BAND_PERCENT = 36;

/**
 * `offsetMs` is press − hit time in playback ms (+ late). `hitWindows` are [300, 100, 50] in map ms;
 * dividing by the clock rate puts them in the same playback time as the offset.
 */
export function buildHitWindowDiagram(
  offsetMs: number,
  hitWindows: readonly number[],
  clockRate: number,
): HitWindowDiagramModel | undefined {
  const [w300, w100, w50] = hitWindows;
  if (!Number.isFinite(offsetMs) || !(clockRate > 0) || !(w300 > 0) || !(w100 > w300) || !(w50 > w100)) return undefined;
  const rounded = Math.round(offsetMs);
  return {
    segments: [
      { kind: "50", flex: w50 - w100 },
      { kind: "100", flex: w100 - w300 },
      { kind: "300", flex: 2 * w300 },
      { kind: "100", flex: w100 - w300 },
      { kind: "50", flex: w50 - w100 },
    ],
    markPercent: Math.max(2, Math.min(98, 50 + (offsetMs / (w50 / clockRate)) * HALF_BAND_PERCENT)),
    label: `${rounded < 0 ? "−" : "+"}${Math.abs(rounded)} ms`,
  };
}
