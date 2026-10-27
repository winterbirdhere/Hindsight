import {
  decidePressAttribution,
  rankAttributionCandidates,
  contestedPrimaryPresses,
  certifyPrimaryAttribution,
} from "../src/gameplay/error-analysis/PrimaryAttribution";
import { decidedCandidate } from "./PrimaryAttributionTestFixtures";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import * as opportunity from "../src/gameplay/error-analysis/PrimaryOpportunity";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { traceFrame } from "./ReplayTraceFixtures";
import { recordedAttributionFailure } from "../src/gameplay/error-analysis/RecordedAttributionValidity";

describe("recorded facts before certificate status", () => {
  it("separates a valid ordered press from a path interpolating across its zero-time jump", () => {
    const f = errorFixture("300,192,1000,1,0", [traceFrame(0, 100), traceFrame(990, 200),
      traceFrame(1000, 210), traceFrame(1000, 220, [0]), traceFrame(1200, 200)]);
    const e = deriveCircleEvidence(f.trace, f.map, "0"),
      press = e.inputs.find((i) => i.record.freshActions.length)!,
      previous = e.inputs[e.inputs.indexOf(press) - 1];
    expect(recordedAttributionFailure(e, f.trace, press.record.id, [press.record.id], new Set())).toBeUndefined();
    expect(recordedAttributionFailure(e, f.trace, press.record.id,
      [previous.record.id, press.record.id], new Set())).toBe("recorded-leading-position-discontinuity");
  });
  it.each([1.2, 0.65])("certifies identical scoped/raw sparse native evidence once at rate %s", (rate) => {
    const f = errorFixture(
      "300,192,1000,1,0\n300,192,1500,1,0",
      [traceFrame(0), traceFrame(1040, 323, [0]), traceFrame(1200, 324),
        traceFrame(1500, 324, [0]), traceFrame(1750, 324)],
      "lazer", [], [{ acronym: rate > 1 ? "DT" : "HT", settings: { speed_change: rate } },
        { acronym: "DA", settings: { circle_size: 7, overall_difficulty: 9 } }],
    );
    const calls = jest.spyOn(opportunity, "inspectPrimaryOpportunity");
    try {
      const result = classifyCircleLoss(deriveCircleEvidence(f.trace, f.map, "1"), f.map, f.trace);
      const primary = result.diagnostics!.primary!;
      expect(result.codes).toEqual(["misaim"]);
      expect(primary.ranking?.observationComplete).toBe(false);
      expect(primary.approaches?.episodes[0]).toMatchObject({ placement: "unproven", spatialCandidates: [] });
      expect(primary.ranking?.selected[0].support?.correction).toMatchObject({
        kind: "same-time-aim", timeMs: 1500, prefix: { parentCount: 1, throughComponentId: "0" },
      });
      expect(primary.rawOpportunityComparison).toBeUndefined();
      expect(calls.mock.calls.filter((args) => args[5] === "same-time-aim")).toHaveLength(1);
    } finally {
      calls.mockRestore();
    }
  });
  it("does not invent Off beat for an on-time press already inside the circle", () => {
    expect(
      decidePressAttribution({
        tapOffsetMs: 0,
        bestWindowMs: 25,
        hitWindowMs: 109,
        originalInside: true,
        passes: [{ entryMs: -120, exitMs: 0 }],
      }),
    ).toMatchObject({ channel: "unresolved", rule: "no-observed-departure" });
  });
  it("uses a recorded G overlap even when neither repair has a certificate", () => {
    const facts = {
      tapOffsetMs: -32,
      bestWindowMs: 23,
      hitWindowMs: 107,
      originalInside: false,
      tapFeasible: false,
      aimFeasible: false,
      passes: [{ entryMs: -9, exitMs: 35 }],
    };
    expect(decidePressAttribution(facts)).toMatchObject({
      channel: "tapping",
      rule: "shared-best-window-tolerance",
    });
  });
  it("does not change channel when certificate flags change", () => {
    const facts = {
      tapOffsetMs: 4,
      bestWindowMs: 19,
      hitWindowMs: 99,
      originalInside: false,
      passes: [{ entryMs: -14.8, exitMs: -0.5 }],
    };
    for (const tapFeasible of [false, true])
      for (const aimFeasible of [false, true])
        expect(decidePressAttribution({ ...facts, tapFeasible, aimFeasible }).channel).toBe("cursor");
  });
  it("chooses the nearest available press before considering a later certificate", () => {
    const near = decidedCandidate("early-tap", "near", 10),
      later = decidedCandidate("late-tap", "later", 20);
    Object.assign(near.attribution!, { tapOffsetMs: -23, clearOriginalPrefix: false, observationOnly: true });
    near.observationOnly = true;
    near.support = undefined;
    near.attribution!.tapCorrection = undefined;
    later.attribution!.tapOffsetMs = 82;
    expect(rankAttributionCandidates([later, near]).selected.map((c) => c.inputIds[0])).toEqual(["near"]);
  });
  it("uses source order only when absolute offsets tie", () => {
    const first = decidedCandidate("early-tap", "first", 10),
      later = decidedCandidate("late-tap", "later", 20);
    first.attribution!.clearOriginalPrefix = false;
    expect(rankAttributionCandidates([later, first]).selected.map((c) => c.inputIds[0])).toEqual(["first"]);
  });
  it("marks a shared nearest press without changing either verdict", () => {
    const a = rankAttributionCandidates([decidedCandidate("early-tap", "shared")]);
    const b = rankAttributionCandidates([decidedCandidate("misaim", "shared")]);
    expect(
      contestedPrimaryPresses([
        { targetId: "a", ranking: a },
        { targetId: "b", ranking: b },
      ]),
    ).toEqual([
      { targetId: "a", inputId: "shared", contested: true, nearestForOtherTargetIds: ["b"] },
      { targetId: "b", inputId: "shared", contested: true, nearestForOtherTargetIds: ["a"] },
    ]);
    expect(a.selected[0].code).toBe("early-tap");
    expect(b.selected[0].code).toBe("misaim");
  });
  it("requests only the chosen channel and retains its pending-prefix observation when complete", () => {
    const frames = Array.from({ length: 401 }, (_, k) => ({
      time: 850 + k,
      position: { x: k + 850 >= 1010 && k + 850 <= 1025 ? 300 : 200, y: 192 },
      actions: k + 850 === 1000 ? [0] : [],
    }));
    const f = errorFixture("100,192,898,1,0\n300,192,1000,1,0", frames);
    const e = deriveCircleEvidence(f.trace, f.map, "1"),
      inputId = e.inputs.find((i) => i.record.timeMs === 1000)!.record.id;
    const calls = jest.spyOn(opportunity, "inspectPrimaryOpportunity");
    try {
      const compared = comparePrimaryApproaches(e, f.map, { pressIds: [inputId] }, f.trace);
      expect(calls.mock.calls.map((args) => [args[3], args[5]])).toEqual([[inputId, "same-time-aim"]]);
      expect(compared.approaches.episodes[0].spatialCandidates.map((c) => c.code)).toContain("misaim");
      expect(compared.ranking.selected.map((c) => c.code)).toEqual(["misaim"]);
      expect(compared.ranking.selected[0].observationOnly).toBe(true);
      const chosen = compared.ranking.attribution!.presses[0];
      expect(chosen.pendingPreviousObjectId).toBe("0");
      expect(chosen.certification![0].refusals).toContainEqual({
        stage: "local",
        reason: "unresolved-prefix",
        sampleId: inputId,
        componentIds: ["0"],
      });
      const incomplete = certifyPrimaryAttribution(e, f.map, f.trace, compared.ranking, false);
      expect(incomplete.selected).toEqual([]);
      expect(incomplete.proposed?.map((c) => c.code)).toEqual(["misaim"]);
    } finally {
      calls.mockRestore();
    }
  });
});
