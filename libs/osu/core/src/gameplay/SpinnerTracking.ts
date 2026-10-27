import { Position } from "@osujs/math";
import { SpinnerState } from "./GameState";
import { MainHitObjectVerdict } from "./Verdicts";

const SPINNER_CENTRE = { x: 256, y: 192 };

export function spinnerCursorAngle(position: Position): number {
  const deltaX = Math.fround(Math.fround(position.x) - SPINNER_CENTRE.x);
  const deltaY = Math.fround(Math.fround(position.y) - SPINNER_CENTRE.y);
  return Math.fround((-Math.atan2(deltaX, deltaY) * 180) / Math.PI);
}

export function normalizedSpinnerAngleDelta(delta: number): number {
  // SpinnerRotationTracker preserves both exact endpoints; modulo-based
  // normalization would incorrectly turn +180 into -180.
  if (delta > 180) return delta - 360;
  if (delta < -180) return delta + 360;
  return delta;
}

export function initialSpinnerState(position: Position): SpinnerState {
  return {
    totalSpunAngle: 0,
    currentAngle: spinnerCursorAngle(position),
    totalAccumulatedRotation: 0,
    totalAccumulatedRotationAtLastCompletion: 0,
    currentSpinMaxRotation: 0,
    completedSpins: 0,
    lastCursorAngle: undefined,
    tracking: false,
  };
}

/** Applies osu!'s anti-reversal spinner rotation tracker to one cursor sample. */
export function updateSpinnerRotation(
  previous: SpinnerState,
  position: Position,
  tracking: boolean,
  gameClockRate: number,
  spinsRequired: number,
  time: number,
): SpinnerState {
  const currentAngle = spinnerCursorAngle(position);
  let totalAccumulatedRotation = previous.totalAccumulatedRotation ?? 0;
  let totalAccumulatedRotationAtLastCompletion = previous.totalAccumulatedRotationAtLastCompletion ?? 0;
  let currentSpinMaxRotation = previous.currentSpinMaxRotation ?? 0;
  let completedSpins = previous.completedSpins ?? 0;
  let lastSpinCompletionTime = previous.lastSpinCompletionTime;

  if (tracking && previous.lastCursorAngle !== undefined) {
    const angularDelta = Math.fround(normalizedSpinnerAngleDelta(currentAngle - previous.lastCursorAngle));
    totalAccumulatedRotation = Math.fround(
      totalAccumulatedRotation + Math.fround(angularDelta * Math.abs(gameClockRate)),
    );
    let currentSpinRotation = Math.fround(totalAccumulatedRotation - totalAccumulatedRotationAtLastCompletion);
    currentSpinMaxRotation = Math.fround(Math.max(currentSpinMaxRotation, Math.abs(currentSpinRotation)));

    while (currentSpinMaxRotation >= 360) {
      const direction = Math.sign(currentSpinRotation) || 1;
      completedSpins++;
      lastSpinCompletionTime = time;
      totalAccumulatedRotationAtLastCompletion = Math.fround(
        totalAccumulatedRotationAtLastCompletion + direction * 360,
      );
      currentSpinRotation = Math.fround(totalAccumulatedRotation - totalAccumulatedRotationAtLastCompletion);
      currentSpinMaxRotation = Math.fround(Math.abs(currentSpinRotation));
    }
  }

  const totalSpunAngle = Math.fround(completedSpins * 360 + currentSpinMaxRotation);
  const completionTime =
    previous.completionTime ?? (spinsRequired === 0 || totalSpunAngle >= spinsRequired * 360 ? time : undefined);

  return {
    totalSpunAngle,
    currentAngle,
    totalAccumulatedRotation,
    totalAccumulatedRotationAtLastCompletion,
    currentSpinMaxRotation,
    completedSpins,
    lastSpinCompletionTime,
    // Sample cursor angle even while input is not tracking, preventing movement
    // during a release from being counted on a later re-press.
    lastCursorAngle: currentAngle,
    tracking,
    completionTime,
  };
}

export function spinnerProgress(totalSpunAngle: number, spinsRequired: number): number {
  return spinsRequired === 0 ? 1 : Math.fround(Math.fround(totalSpunAngle / 360) / spinsRequired);
}

export function spinnerVerdictForProgress(progress: number): MainHitObjectVerdict {
  return progress >= 1 ? "GREAT" : progress > 0.9 ? "OK" : progress > 0.75 ? "MEH" : "MISS";
}
