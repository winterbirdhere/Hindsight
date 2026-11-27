import { Spinner } from "../hitobjects/Spinner";
import { SpinnerState } from "./GameState";
import { ReplayAnalysisRuleset } from "./GameplayAnalysisEvent";

export interface SpinnerBonusProgress {
  earnedCount: number;
  /** Includes post-cap spins, which still trigger lazer's maximum-bonus sound. */
  soundTriggers: number;
  /** The client-style bonus counter, without ordinary spin points or score multipliers. */
  score: number;
  maximumScore?: number;
}

/**
 * Presentation derived from Rewind's ruleset rotation reconstruction, never the
 * spinner's end judgement. Stable uses its scored half-turn count and native
 * Lazer uses completed full turns with its bonus cap.
 * Lazer's counter uses LargeBonus (50), while Stable displays its extra 1000.
 */
export function spinnerBonusProgress(
  spinner: Spinner,
  state: SpinnerState | undefined,
  ruleset: ReplayAnalysisRuleset,
): SpinnerBonusProgress {
  const completedSpins = Math.max(0, Math.floor(state?.completedSpins ?? (state?.totalSpunAngle ?? 0) / 360));
  const soundTriggers =
    ruleset === "stable" && state?.stableRequiredHalfTurns !== undefined
      ? Math.max(0, Math.floor(((state.stableScoredHalfTurns ?? 0) - state.stableRequiredHalfTurns - 3) / 2))
      : Math.max(0, completedSpins - spinner.spinsRequired - 2);
  const earnedCount = ruleset === "lazer" ? Math.min(soundTriggers, spinner.maximumBonusSpins) : soundTriggers;
  const scorePerBonus = ruleset === "lazer" ? 50 : 1000;
  return {
    earnedCount,
    soundTriggers,
    score: earnedCount * scorePerBonus,
    ...(ruleset === "lazer" ? { maximumScore: spinner.maximumBonusSpins * scorePerBonus } : {}),
  };
}

/** The source client's continuous progress bar, including odd half-turn requirements. */
export function spinnerProgressForState(spinner: Spinner, state: SpinnerState | undefined): number {
  if (state?.stableRequiredHalfTurns !== undefined) {
    return state.stableRequiredHalfTurns === 0
      ? 1
      : Math.fround((state.stableHalfTurns ?? 0) / state.stableRequiredHalfTurns);
  }
  return spinner.spinsRequired === 0
    ? 1
    : Math.fround(Math.fround((state?.totalSpunAngle ?? 0) / 360) / spinner.spinsRequired);
}
