/** Saved/reconstructed osu!standard grade arithmetic. Completion is a separate qualification. */
export type StandardReplayGrade = "SS" | "S" | "A" | "B" | "C" | "D" | "F";
export function stableScoreGrade(counts: readonly [number, number, number, number]): StandardReplayGrade | null {
  if (counts.some(value => !Number.isSafeInteger(value) || value < 0)) return null;
  const [great, , meh, misses] = counts, total = counts.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  const ratio300 = great / total, ratio50 = meh / total, noMisses = misses === 0;
  if (great === total) return "SS";
  if (ratio300 > 0.9 && ratio50 <= 0.01 && noMisses) return "S";
  if ((ratio300 > 0.8 && noMisses) || ratio300 > 0.9) return "A";
  if ((ratio300 > 0.7 && noMisses) || ratio300 > 0.8) return "B";
  if (ratio300 > 0.6) return "C";
  return "D";
}
