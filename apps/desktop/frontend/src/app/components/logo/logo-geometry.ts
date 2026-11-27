/**
 * Frame maths of the 14b logo animation (card 16a). Pure functions of elapsed time, so the
 * component only has to draw what it is given.
 */
export interface LogoFrame {
  /** Cursor angle in degrees (SVG convention: clockwise positive). */
  headDeg: number;
  /** Trail length in degrees. */
  spanDeg: number;
  discScale: number;
  discOpacity: number;
  labelOpacity: number;
  /** Hit pulse of the label. */
  labelScale: number;
  glowOpacity: number;
  approachRadius: number;
  approachOpacity: number;
}

const TRAIL_RADIUS = 34;
const TRAIL_SPAN_DEG = 290;
const REVOLUTION_MS = 3600;
const INTRO_MS = 1100;
const HIT_AT_MS = 1000;
const HIT_PULSE_MS = 260;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);

export const LOGO_STATIC: LogoFrame = {
  headDeg: -40,
  spanDeg: TRAIL_SPAN_DEG,
  discScale: 1,
  discOpacity: 1,
  labelOpacity: 1,
  labelScale: 1,
  glowOpacity: 1,
  approachRadius: 16,
  approachOpacity: 0,
};

export function logoFrame(elapsedMs: number): LogoFrame {
  const n = Math.max(0, elapsedMs);
  const intro = ease(n / INTRO_MS);
  const hitT = n - HIT_AT_MS;
  const ap = clamp01((n - 300) / 700);
  return {
    spanDeg: Math.max(1, TRAIL_SPAN_DEG * intro),
    headDeg: -40 - 250 * (1 - intro) - (n / REVOLUTION_MS) * 360,
    discScale: 0.94 + 0.06 * ease(n / 700),
    discOpacity: ease(n / 500),
    labelOpacity: ease((n - 250) / 400),
    labelScale: hitT > 0 && hitT < HIT_PULSE_MS ? 1 + 0.08 * Math.sin((hitT / HIT_PULSE_MS) * Math.PI) : 1,
    glowOpacity: 0.4 + 0.6 * intro,
    approachRadius: 16 + 22 * (1 - ap),
    approachOpacity: ap < 1 ? 0.2 + 0.7 * ap : 0,
  };
}

const pointOnTrail = (deg: number): [number, number] => {
  const rad = (deg * Math.PI) / 180;
  return [50 + TRAIL_RADIUS * Math.cos(rad), 50 + TRAIL_RADIUS * Math.sin(rad)];
};

export function trailPath(headDeg: number, spanDeg: number): { d: string; head: [number, number]; tail: [number, number] } {
  const head = pointOnTrail(headDeg);
  const tail = pointOnTrail(headDeg + spanDeg);
  const large = spanDeg > 180 ? 1 : 0;
  const d = `M${tail[0].toFixed(2)} ${tail[1].toFixed(2)} A${TRAIL_RADIUS} ${TRAIL_RADIUS} 0 ${large} 0 ${head[0].toFixed(2)} ${head[1].toFixed(2)}`;
  return { d, head, tail };
}
