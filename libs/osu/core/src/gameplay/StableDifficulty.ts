import { hitWindowsForOD } from "@osujs/math";
import { OsuClassicMod } from "../mods/Mods";

/** Stable parses base OD as float, then promotes it before applying mods. */
export function stableOverallDifficultyFor(baseOD: number, mods: readonly OsuClassicMod[] = []): number {
  let difficulty = Math.max(0, Math.min(10, Math.fround(baseOD)));
  if (mods.includes("EASY")) difficulty = Math.max(0, difficulty / 2);
  if (mods.includes("HARD_ROCK")) difficulty = Math.min(10, difficulty * 1.4);
  return difficulty;
}

/** Nominal windows are integer-truncated; successful input is strictly inside. */
export function stableHitWindowsForOD(effectiveOD: number): ReturnType<typeof hitWindowsForOD> {
  return hitWindowsForOD(effectiveOD).map((window) => Math.trunc(window + 1) - 1);
}
