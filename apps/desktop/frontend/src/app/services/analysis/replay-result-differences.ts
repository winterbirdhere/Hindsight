import type { ReplaySimulationValidation } from "../common/game/GameSimulator";

export interface ReplayResultDifference {
  label: string;
  saved: number;
  simulated: number;
}

/** Comparison-only interpretation; saved and reconstructed statistics stay untouched. */
export function replayResultDifferences(validation?: ReplaySimulationValidation): {
  differences: ReplayResultDifference[];
  postFailureMissCount?: number;
} {
  if (!validation) return { differences: [] };
  const { expectedCounts, simulatedCounts, postFailureMisses } = validation;
  const count = postFailureMisses?.count;
  const successesMatch = [0, 1, 2].every((index) => {
    const saved = expectedCounts?.[index];
    return saved !== undefined && Number.isSafeInteger(saved) && saved >= 0 && saved === simulatedCounts[index];
  });
  const savedMisses = expectedCounts?.[3];
  const simulatedMisses = simulatedCounts[3];
  const postFailureMissCount =
    count !== undefined &&
    Number.isSafeInteger(count) &&
    count > 0 &&
    successesMatch &&
    savedMisses !== undefined &&
    Number.isSafeInteger(savedMisses) &&
    Number.isSafeInteger(simulatedMisses) &&
    simulatedMisses >= 0 &&
    savedMisses - simulatedMisses === count
      ? count
      : undefined;
  const differences = ["300", "100", "50", "Miss"].flatMap((label, index) => {
    const saved = expectedCounts?.[index];
    const simulated = simulatedCounts[index];
    return saved !== undefined &&
      simulated !== undefined &&
      saved !== simulated &&
      !(index === 3 && postFailureMissCount !== undefined)
      ? [{ label, saved, simulated }]
      : [];
  });
  if (
    typeof validation.expectedMaxCombo === "number" &&
    Number.isFinite(validation.expectedMaxCombo) &&
    validation.expectedMaxCombo !== validation.simulatedMaxCombo
  ) {
    differences.push({
      label: "Max combo",
      saved: validation.expectedMaxCombo,
      simulated: validation.simulatedMaxCombo,
    });
  }
  return { differences, postFailureMissCount };
}
