import {
  rankPrimaryCandidates,
  rankSupportedPrimaryCandidates,
  PRIMARY_DIAGNOSIS_POLICY,
} from "../src/gameplay/error-analysis/PrimaryDiagnosisPolicy";
import { decidePressAttribution } from "../src/gameplay/error-analysis/PrimaryAttribution";
import { decidedCandidate } from "./PrimaryAttributionTestFixtures";

const compare = (tap: number, cursor: number) =>
  decidePressAttribution({
    tapOffsetMs: tap * 25,
    bestWindowMs: 25,
    tapFeasible: true,
    aimFeasible: true,
    passes: [{ entryMs: -100, exitMs: 25 - cursor * 25 }],
  });
describe("correct-play primary ranking", () => {
  it("does not combine mutually exclusive certified causes", () => {
    const a = decidedCandidate("misaim"),
      b = decidedCandidate("late-tap");
    a.support!.hypothesisIds = [0];
    b.support!.hypothesisIds = [1];
    expect(rankSupportedPrimaryCandidates([a, b]).selected).toEqual([]);
    expect(rankSupportedPrimaryCandidates([b, a, a]).selected).toEqual([]);
  });
  it("enforces the candidate cap before filtering positive support", () => {
    const rows = Array.from({ length: 257 }, () => decidedCandidate("misaim"));
    expect(rankSupportedPrimaryCandidates(rows.slice(0, 256)).selected).toHaveLength(1);
    expect(rankSupportedPrimaryCandidates(rows).selected).toEqual([]);
    expect(rankSupportedPrimaryCandidates(rows).reason).toBe("primary-candidate-limit");
  });
  it("declares common-window comparison and bounded near-tie thresholds", () => {
    expect(PRIMARY_DIAGNOSIS_POLICY.normalization.placement).toContain("never compared with timing");
    expect(PRIMARY_DIAGNOSIS_POLICY.normalization.arrival).toBe("uncovered side of the best window/best-window");
    expect(PRIMARY_DIAGNOSIS_POLICY.nearTieRatio).toBe(0.8);
    expect(PRIMARY_DIAGNOSIS_POLICY.nearTieDifference).toBe(0.35);
  });
  it("does not universally prefer cursor or tapping when both repairs are feasible", () => {
    expect(compare(2, 1.1).channel).toBe("tapping");
    expect(compare(1.1, 2).channel).toBe("cursor");
  });
  it("does not infer independence from two near-equal feasible repairs", () => {
    expect(compare(1.32, 1.18).nearTie).toBe(true);
    expect(compare(1.32, 1.18).channel).toBe("tapping");
    expect(compare(1.18, 1.32).channel).toBe("cursor");
  });
  it("requires both ratio and absolute near-tie bounds and preserves diagnostics", () => {
    expect(compare(1.6, 1.18).nearTie).toBe(false);
    expect(compare(10, 8).nearTie).toBe(false);
    const candidate = decidedCandidate("late-tap");
    expect(rankPrimaryCandidates([candidate]).candidates).toEqual([candidate]);
  });
  it("is deterministic under input order and duplicate witness insertion", () => {
    const a = decidedCandidate("misaim"),
      b = { ...a, eventIds: ["another-witness"] };
    expect(rankPrimaryCandidates([a, b]).selected.map((c) => c.code)).toEqual(
      rankPrimaryCandidates([b, a, a]).selected.map((c) => c.code),
    );
  });
  it("never chooses an unprepared nonfinite, negative or zero score as a cause", () => {
    for (const strength of [NaN, -1, 0, 999]) {
      const candidate = { ...decidedCandidate("misaim"), attribution: undefined, strength };
      expect(rankPrimaryCandidates([candidate]).selected).toEqual([]);
    }
  });
  it("retains every same-family runner-up without using its old magnitude", () => {
    const first = decidedCandidate("undershoot", "a", 1),
      later = decidedCandidate("wide-aim", "b", 2);
    later.strength = 10000;
    const result = rankPrimaryCandidates([later, first]);
    expect(result.selected.map((c) => c.code)).toEqual(["undershoot"]);
    expect(result.candidates).toHaveLength(2);
  });
  it("does not let duplicate independence flags manufacture another cause", () => {
    const first = decidedCandidate("misaim"),
      conflict = { ...first, independent: false };
    expect(rankPrimaryCandidates([first, conflict]).selected).toHaveLength(1);
    expect(rankPrimaryCandidates([conflict, first]).selected).toHaveLength(1);
  });
  it("treats the declared inclusive near-tie boundary reproducibly", () => {
    expect(compare(1.75, 1.4).nearTie).toBe(true);
    expect(compare(1.75001, 1.4).nearTie).toBe(false);
  });
  it("settles press role before size and retains all relevant attempts", () => {
    const first = decidedCandidate("misaim", "one", 1),
      second = decidedCandidate("late-tap", "two", 2);
    second.strength = 100000;
    const result = rankPrimaryCandidates([second, first]);
    expect(result.selected.map((c) => c.code)).toEqual(["misaim"]);
    expect(result.comparisonInputIds).toEqual(["one", "two"]);
    expect(result.attribution?.roles.rule).toBe("nearest-recorded-opportunity");
  });
  it("retains independent timing alternatives without picking their press by size", () => {
    const early = decidedCandidate("early-tap", "early", 1),
      late = decidedCandidate("late-tap", "late", 2);
    early.timingPass = { entryTimeMs: 900, exitTimeMs: 930 };
    late.timingPass = { entryTimeMs: 1030, exitTimeMs: 1050 };
    const result = rankPrimaryCandidates([late, early]);
    expect(result.attribution?.roles.chosenInputId).toBe("early");
    expect(result.candidates).toEqual([late, early]);
  });
  it("does not borrow a selected description from a different allocation", () => {
    const raw = decidedCandidate("early-tap");
    raw.support!.hypothesisIds = ["raw-context"];
    const alternative = {
      ...raw,
      support: { ...raw.support!, hypothesisIds: [1] },
      briefDetail: { phrase: "Different allocation" },
      attribution: { ...raw.attribution!, tapTolerance: 100 },
    };
    const result = rankPrimaryCandidates([alternative, raw]);
    expect(result.selected).toEqual([raw]);
    expect(result.scores[0].inputs[0].strength).toBe(2);
  });
  it("does not let a later certificate replace the selected recorded witness", () => {
    const certified = decidedCandidate("early-tap");
    const observed = {
      ...certified,
      observationOnly: true,
      briefDetail: { phrase: "Observed" },
      attribution: { ...certified.attribution!, observationOnly: true },
    };
    expect(rankPrimaryCandidates([observed, certified]).selected).toEqual([observed]);
  });
  it("retains a secondary score's own press and excludes mutually exclusive assignments", () => {
    const first = { ...decidedCandidate("early-tap", "first", 1), timingPass: { entryTimeMs: 900, exitTimeMs: 930 } };
    const second = {
      ...decidedCandidate("late-tap", "second", 2),
      timingPass: { entryTimeMs: 1050, exitTimeMs: 1080 },
    };
    expect(rankPrimaryCandidates([first, second]).scores.map((s) => s.inputs[0].inputId)).toEqual(["first", "second"]);
    first.support!.hypothesisIds = [0];
    second.support!.hypothesisIds = [1];
    expect(rankPrimaryCandidates([first, second]).selected).toEqual([first]);
  });
  it("keeps an independent observed secondary but refuses conflicting channel evidence", () => {
    const first = { ...decidedCandidate("early-tap", "first", 1), timingPass: { entryTimeMs: 900, exitTimeMs: 930 } };
    const second = {
      ...decidedCandidate("late-tap", "second", 2),
      timingPass: { entryTimeMs: 1050, exitTimeMs: 1080 },
    };
    const observed = {
      ...second,
      observationOnly: true,
      briefDetail: { phrase: "Rejected observation" },
      attribution: { ...second.attribution!, observationOnly: true },
    };
    const rejected = {
      ...second,
      briefDetail: { phrase: "Rejected channel" },
      attribution: { ...second.attribution!, channel: "cursor" as const, selectedCodes: [] },
    };
    expect(rankPrimaryCandidates([first, observed, second]).selected).toEqual([first, observed]);
    expect(rankPrimaryCandidates([first, rejected, second]).selected).toEqual([first]);
  });
});
