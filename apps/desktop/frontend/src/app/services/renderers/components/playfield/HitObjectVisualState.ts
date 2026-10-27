import type { HitCircleVerdict } from "@osujs/core";

export const CLASSIC_NOTELOCK_SHAKE_LEG_DURATION = 30;
export const CLASSIC_NOTELOCK_SHAKE_DISTANCE = 8;
export const CLASSIC_NOTELOCK_SHAKE_TOTAL_DURATION = CLASSIC_NOTELOCK_SHAKE_LEG_DURATION * 4;

function interpolate(from: number, to: number, progress: number, easing: (value: number) => number): number {
  return from + (to - from) * easing(progress);
}

const outSine = (value: number) => Math.sin((value * Math.PI) / 2);
const inOutSine = (value: number) => -(Math.cos(Math.PI * value) - 1) / 2;
const inSine = (value: number) => 1 - Math.cos((value * Math.PI) / 2);

/**
 * Recreates the classic horizontal shake used when a click is rejected by
 * notelock. Its 30 ms legs form a 120 ms sequence. Rendering is seekable, so
 * this must be derived from timestamps rather than an imperative tween.
 */
export function classicNotelockShakeOffset(currentTime: number, shakeTime?: number): number {
  if (shakeTime === undefined) return 0;

  const elapsed = currentTime - shakeTime;
  if (elapsed < 0 || elapsed >= CLASSIC_NOTELOCK_SHAKE_TOTAL_DURATION) return 0;

  const halfDuration = CLASSIC_NOTELOCK_SHAKE_LEG_DURATION / 2;
  if (elapsed < halfDuration) {
    return interpolate(0, CLASSIC_NOTELOCK_SHAKE_DISTANCE, elapsed / halfDuration, outSine);
  }

  const fullLeg = (from: number, to: number, startTime: number) =>
    interpolate(from, to, (elapsed - startTime) / CLASSIC_NOTELOCK_SHAKE_LEG_DURATION, inOutSine);
  if (elapsed < halfDuration + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION) {
    return fullLeg(CLASSIC_NOTELOCK_SHAKE_DISTANCE, -CLASSIC_NOTELOCK_SHAKE_DISTANCE, halfDuration);
  }
  if (elapsed < halfDuration + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION * 2) {
    return fullLeg(
      -CLASSIC_NOTELOCK_SHAKE_DISTANCE,
      CLASSIC_NOTELOCK_SHAKE_DISTANCE,
      halfDuration + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION,
    );
  }
  if (elapsed < halfDuration + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION * 3) {
    return fullLeg(
      CLASSIC_NOTELOCK_SHAKE_DISTANCE,
      -CLASSIC_NOTELOCK_SHAKE_DISTANCE,
      halfDuration + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION * 2,
    );
  }

  return interpolate(
    -CLASSIC_NOTELOCK_SHAKE_DISTANCE,
    0,
    (elapsed - (halfDuration + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION * 3)) / halfDuration,
    inSine,
  );
}

/** A direct early input MISS removes only the clicked circle/head. */
export function directEarlyMissResolved(currentTime: number, hitTime: number, verdict?: HitCircleVerdict): boolean {
  if (
    verdict?.type !== "MISS" ||
    verdict.judgementTime >= hitTime ||
    (verdict.missReason !== "HIT_TOO_EARLY" && verdict.missReason !== "INPUT_WINDOW_MISS")
  ) {
    return false;
  }

  return currentTime >= verdict.judgementTime;
}
