import { rankPrimaryHypotheses } from "../src/gameplay/error-analysis/PrimaryDiagnosisPolicy";
import { decidedCandidate } from "./PrimaryAttributionTestFixtures";
describe("assignment-independent primary comparison", () => {
  it("retains conditional evidence without requiring the same code in every allocation", () => {
    const candidates = [decidedCandidate("undershoot", "a", 1), decidedCandidate("late-tap", "b", 2)];
    const result = rankPrimaryHypotheses(candidates, [], ["a", "b"]);
    expect(result.selected.map(c => c.code)).toEqual(["undershoot"]);
    expect(result.candidates).toEqual(candidates);
    expect(result.hypotheses.map(h => h.inputIds)).toEqual([["a"], ["b"]]);
  });
  it("does not convert opposite conditional timing causes into a shared catch-all", () => {
    const candidates = [decidedCandidate("early-tap", "a", 1), decidedCandidate("late-tap", "b", 2)];
    for (const c of candidates) c.attribution!.clearOriginalPrefix = false;
    const selected=rankPrimaryHypotheses(candidates, [], ["a", "b"]).selected;
    expect(selected.map(c=>c.code)).toEqual(["early-tap"]);
    expect(selected[0].inputIds).toEqual(["a"]);
  });
  it("retains competing certified channels for one uncertain press without inventing independence", () => {
    const rows = [decidedCandidate("misaim", "a"), decidedCandidate("early-tap", "a")];
    const result = rankPrimaryHypotheses(rows, [], ["a"]);
    expect(result.selected).toEqual([]);
    expect(result.candidates).toHaveLength(2);
  });
  it("keeps mandatory attempts in every hypothesis and is insensitive to enumeration order", () => {
    const candidates = [decidedCandidate("misaim", "fixed", 1), decidedCandidate("misaim", "a", 2), decidedCandidate("late-tap", "b", 3)];
    const forward = rankPrimaryHypotheses(candidates, ["fixed"], ["a", "b"]);
    expect(forward.selected.map(c => c.code)).toEqual(["misaim"]);
    expect(forward.hypotheses.every(h => h.inputIds.includes("fixed"))).toBe(true);
    expect(rankPrimaryHypotheses([...candidates].reverse(), ["fixed"], ["b", "a"]).selected).toEqual(forward.selected);
    expect(forward.comparisonInputIds).toEqual(["a", "b", "fixed"]);
  });
});
