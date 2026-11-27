import { Spinner } from "../hitobjects/Spinner";
import { SpinnerState } from "./GameState";

/**
 * Native-lazer Spun Out injects 101% of the required rotation over the spinner.
 * OsuModSpunOut divides elapsed frame time by the clock rate; SpinnerRotationTracker
 * multiplies the injected rotation by that same rate. Map time therefore needs no
 * DT/HT adjustment here. Deriving state directly also makes replay seeking exact.
 *
 * https://github.com/ppy/osu/blob/2026.730.0/osu.Game.Rulesets.Osu/Mods/OsuModSpunOut.cs
 */
export function spunOutSpinnerState(spinner: Spinner, time: number): SpinnerState {
  const elapsed = Math.max(0, Math.min(spinner.duration, time - spinner.startTime));
  const degreesPerMs = spinner.duration > 0 ? (1.01 * spinner.spinsRequired * 360) / spinner.duration : 0;
  const totalSpunAngle = elapsed * degreesPerMs;
  const completedSpins = Math.floor(totalSpunAngle / 360);
  const currentSpinMaxRotation = totalSpunAngle - completedSpins * 360;
  const cleared = time >= spinner.startTime && totalSpunAngle >= spinner.spinsRequired * 360;

  return {
    totalSpunAngle,
    currentAngle: currentSpinMaxRotation > 180 ? currentSpinMaxRotation - 360 : currentSpinMaxRotation,
    totalAccumulatedRotation: totalSpunAngle,
    totalAccumulatedRotationAtLastCompletion: completedSpins * 360,
    currentSpinMaxRotation,
    completedSpins,
    lastSpinCompletionTime: completedSpins > 0 ? spinner.startTime + (completedSpins * 360) / degreesPerMs : undefined,
    // The mod bypasses cursor input entirely, including during replay playback.
    lastCursorAngle: undefined,
    tracking: time >= spinner.startTime && time < spinner.endTime,
    completionTime: cleared
      ? spinner.startTime + (spinner.spinsRequired === 0 ? 0 : spinner.duration / 1.01)
      : undefined,
  };
}
