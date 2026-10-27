import { replayResultDifferences } from "./replay-result-differences";

const validation = {
  verified: false,
  expectedCounts: [1342, 21, 2, 45],
  simulatedCounts: [1342, 21, 2, 30],
  expectedMaxCombo: 365,
  simulatedMaxCombo: 365,
  warnings: ["Raw counts differ"],
  postFailureMisses: { count: 15, scoringEndTime: 295252, recordedEndTime: 298336 },
};

describe("saved and reconstructed result differences", () => {
  it("interprets confirmed post-failure misses without modifying raw validation", () => {
    const before = JSON.stringify(validation);
    expect(replayResultDifferences(validation)).toEqual({ differences: [], postFailureMissCount: 15 });
    expect(JSON.stringify(validation)).toBe(before);
  });

  it.each([undefined, [], [1342, 21]])("requires all three successful grades to be available: %j", (expectedCounts) => {
    expect(replayResultDifferences({ ...validation, expectedCounts }).postFailureMissCount).toBeUndefined();
  });

  it.each([-15, 0, 14, 15.5, NaN, Infinity])("does not accept invalid or nonmatching attribution %p", (count) => {
    expect(
      replayResultDifferences({ ...validation, postFailureMisses: { ...validation.postFailureMisses, count } })
        .differences,
    ).toEqual([{ label: "Miss", saved: 45, simulated: 30 }]);
  });

  it("does not classify unknown results as a mismatch", () => {
    expect(replayResultDifferences()).toEqual({ differences: [] });
  });
});
