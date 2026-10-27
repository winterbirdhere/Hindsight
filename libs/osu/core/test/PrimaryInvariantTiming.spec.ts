import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { comparePrimaryInputHypotheses } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { certifyInvariantMandatoryTiming } from "../src/gameplay/error-analysis/PrimaryInvariantTiming";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import * as association from "../src/gameplay/error-analysis/PrimaryInputEvidence";

function fixture(profile: "stable" | "lazer", early = false, head = false) {
  // Earlier outside motion ends at an excluded edge. A later independent pass
  // is complete before the mandatory late press. No ownership is invented.
  const knots = [
    [700, 100, 360],
    [900, 100, 360],
    [920, 140, 340],
    [940, 190, 320],
    [960, 240, 300],
    [980, 400, 260],
    [1000, 440, 210],
    [1020, 390, 200],
    [1040, 310, 200],
    [1060, 230, 200],
    [1080, 180, 200],
    [1200, 160, 200],
  ];
  const transform = (time: number) => (early ? 2000 - time : time);
  const frames = knots
    .map(([time, x, y]) => ({
      ...traceFrame(transform(time), x, time === 920 || time === 1060 ? [0] : time === 960 ? [1] : []),
      position: { x, y },
    }))
    .sort((a, b) => a.time - b.time);
  const f = errorFixture(head ? "300,192,1000,2,0,L|500:192,1,200" : "300,192,1000,1,0", frames, profile),
    e = JSON.parse(JSON.stringify(deriveCircleEvidence(f.trace, f.map, head ? "0/HEAD" : "0"))) as ReturnType<
      typeof deriveCircleEvidence
    >;
  const id = (time: number) => e.inputs.find((i) => i.record.timeMs === transform(time))!.record.id;
  const mandatory = [id(1060)],
    optional = [id(920), id(960)];
  const compare = () =>
    comparePrimaryInputHypotheses(e, f.map, { pressIds: [...optional, ...mandatory] }, mandatory, optional);
  const observeMandatory = () => comparePrimaryInputHypotheses(e, f.map, { pressIds: mandatory }, mandatory, []);
  return { ...f, e, id, mandatory, optional, compare, observeMandatory };
}

describe("independent timing evidence invariant under unresolved optional allocation", () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(["stable", "lazer"] as const)(
    "retains %s mandatory timing without declaring unknown optional motion complete",
    (profile) => {
      const f = fixture(profile),
        r = f.compare();
      const mandatoryEpisodes = r.approachVariants.filter((e) => e.inputId === f.mandatory[0]);
      expect(
        mandatoryEpisodes.every(
          (e) => e.placement === "proper-pass" && e.relation === "after-pass" && e.timingIndependent,
        ),
      ).toBe(true);
      expect(r.approachVariants.some((e) => e.inputId === f.optional[0] && e.placement === "unproven")).toBe(true);
      expect(r.complete).toBe(false);
      expect(r.ranking.selected).toEqual([]);
      expect(r.ranking.reason).toBe("incomplete-primary-observation");
      expect(r.hypotheses).toHaveLength(3);
      expect(r.hypotheses.some((h) => !h.complete)).toBe(true);
      expect(r.invariantMandatoryTiming).toBeUndefined();
      const observed = f.observeMandatory().ranking;
      expect(observed.selected.map((c) => c.code)).toEqual(["left-early"]);
      expect(observed.selected[0].observationOnly).toBe(true);
      expect(observed.attribution?.presses[0]).toMatchObject({
        tapFeasible: false,
        aimFeasible: true,
        observationOnly: true,
      });
      expect(observed.attribution?.presses[0].tapCorrection).toBeUndefined();
      expect(observed.attribution?.presses[0].aimCorrection).toBeUndefined();
      // This test fixes attribution only to exercise the integration. Geometry,
      // events, source continuity and the allocation comparison remain real.
      jest.spyOn(association, "derivePrimaryInputEvidence").mockReturnValue({
        policyVersion: "test",
        relevantInputIds: f.mandatory,
        contextInputIds: [],
        limitations: [],
        associations: [
          ...f.mandatory.map((inputId) => ({ inputId, role: "relevant" as const, reasons: [], eventIds: [inputId] })),
          ...f.optional.map((inputId) => ({ inputId, role: "ambiguous" as const, reasons: [], eventIds: [inputId] })),
        ],
      });
      const primary = classifyCircleLoss(f.e, f.map);
      expect(primary.headline).toBe("");
      expect(primary.codes).toEqual([]);
      expect(primary.diagnostics!.primary!.allocationComparison!.complete).toBe(false);
      expect(primary.diagnostics?.primary?.ranking?.reason).toBe("incomplete-primary-observation");
    },
  );
  it("does not treat candidate-free mandatory input as an optional unknown", () => {
    const f = fixture("stable"),
      r = comparePrimaryInputHypotheses(
        f.e,
        f.map,
        { pressIds: [...f.optional, ...f.mandatory] },
        [f.optional[0], ...f.mandatory],
        [f.optional[1]],
      );
    expect(r.complete).toBe(false);
    expect(r.ranking.selected).toEqual([]);
  });
  it.each(["stable", "lazer"] as const)("uses the same policy for independently early %s tapping", (profile) => {
    const f = fixture(profile, true),
      r = f.compare();
    expect(r.complete).toBe(false);
    expect(r.ranking.selected).toEqual([]);
    expect(r.invariantMandatoryTiming).toBeUndefined();
    expect(f.observeMandatory().ranking.selected.map((c) => c.code)).toEqual(["aim-late"]);
  });
  it.each(["stable", "lazer"] as const)("applies to a %s head without substituting slider body evidence", (profile) => {
    const f = fixture(profile, false, true),
      r = f.compare();
    expect(f.e.terminal).toMatchObject({ componentId: "0/HEAD", result: "MISS" });
    expect(r.ranking.selected).toEqual([]);
    expect(f.observeMandatory().ranking.selected.map((c) => c.code)).toEqual(["left-early"]);
  });
  it.each(["input", "geometry", "routing", "lifecycle"] as const)("uses concrete facts rather than an unexplained partial %s flag", (channel) => {
    const f = fixture("stable");
    expect(f.observeMandatory().ranking.selected.map((c) => c.code)).toEqual(["left-early"]);
    f.e.dependencies[channel] = { status: "partial", reasons: ["incomplete-local-test"] };
    expect(f.compare().ranking.selected).toEqual([]);
    const observed = f.observeMandatory().ranking;
    {
      expect(observed.selected.map((c) => c.code)).toEqual(["left-early"]);
      expect(observed.selected[0].observationOnly).toBe(true);
      expect(observed.attribution?.presses[0].aimCorrection).toBeUndefined();
      expect(observed.attribution?.presses[0].clearOriginalPrefix).toBe(false);
    }
  });
  it.each([
    "raw-gap",
    "parsed-gap",
    "unknown-action",
    "actions",
    "mask",
    "source",
    "order",
    "instant-move",
    "resource",
  ])("refuses %s in the optional bridge without borrowing the intact mandatory passage", (fault) => {
    const f = fixture("stable"),
      item = f.e.inputs.find((i) => i.record.timeMs === 940)!;
    if (fault === "raw-gap")
      for (const i of f.e.inputs)
        if (i.record.source.origin === "parsed")
          i.record.source.rawTokenIndex = i.record.source.parsedFrameIndex + (i === item ? 1 : 0);
    if (fault === "parsed-gap" && item.record.source.origin === "parsed") item.record.source.parsedFrameIndex++;
    if (fault === "unknown-action") item.freshActionsKnown = false;
    if (fault === "actions") item.record.previousActions = [];
    if (fault === "mask") item.record.rawButtonMask = 15;
    if (fault === "source") item.record.source = { origin: "synthetic", reason: "test" };
    if (fault === "order") item.record.sequence = 0;
    if (fault === "instant-move") item.record.timeMs = 920;
    if (fault === "resource") f.e.limits.truncated = true;
    expect(f.compare().ranking.selected).toEqual([]);
  });
  it("keeps parser warnings outside complete local evidence from suppressing positive facts", () => {
    const f = fixture("stable");
    f.e.limitations.push("parser-negative-delta", "initial-actions-unknown");
    expect(f.observeMandatory().ranking.selected.map((c) => c.code)).toEqual(["left-early"]);
  });
  it("keeps logical alternate-key edges valid while an older action stays held", () => {
    const f = fixture("stable");
    for (const i of f.e.inputs) {
      const r = i.record;
      if (r.timeMs >= 960 && r.timeMs < 1080) {
        r.actions = [...new Set([...r.actions, 1])];
        if (r.timeMs > 960) r.previousActions = [...new Set([...r.previousActions, 1])];
        r.freshActions = r.actions.filter((a) => !r.previousActions.includes(a));
      }
    }
    f.e.inputs.find((i) => i.record.timeMs === 1080)!.record.previousActions = [0, 1];
    expect(f.observeMandatory().ranking.selected.map((c) => c.code)).toEqual(["left-early"]);
  });
  it("retains all optional diagnostics and is independent of caller input order", () => {
    const f = fixture("stable"),
      before = JSON.stringify(f.e),
      a = f.compare(),
      b = comparePrimaryInputHypotheses(
        f.e,
        f.map,
        { pressIds: [...f.mandatory, ...f.optional].reverse() },
        f.mandatory,
        [...f.optional].reverse(),
      );
    expect(b.ranking.selected).toEqual(a.ranking.selected);
    expect(b.ranking.attribution?.presses).toEqual(a.ranking.attribution?.presses);
    expect(a.hypotheses.flatMap((h) => h.limitations)).toContain("no-positive-local-placement");
    expect(a.candidates.some((c) => c.family === "placement")).toBe(true);
    expect(JSON.stringify(f.e)).toBe(before);
  });
  it.each(["unknown-freshness", "bad-mask", "wrong-previous", "two-actions"])(
    "does not select an observation from %s",
    (fault) => {
      const f = fixture("stable");
      expect(f.observeMandatory().ranking.selected.map((c) => c.code)).toEqual(["left-early"]);
      const p = f.e.inputs.find((i) => i.record.id === f.mandatory[0])!;
      if (fault === "unknown-freshness") p.freshActionsKnown = false;
      if (fault === "bad-mask") p.record.rawButtonMask = 0;
      if (fault === "wrong-previous") p.record.previousActions = [1];
      if (fault === "two-actions") {
        p.record.actions = [0, 1];
        p.record.freshActions = [0, 1];
      }
      expect(f.observeMandatory().ranking.selected).toEqual([]);
    },
  );
  it("requires a mandatory anchor, not optional-only selected evidence", () => {
    const f = fixture("stable"),
      all = [...f.optional, ...f.mandatory];
    expect(
      comparePrimaryInputHypotheses(f.e, f.map, { pressIds: all }, [], all).invariantMandatoryTiming,
    ).toBeUndefined();
  });
  it.each([
    "changed-pass",
    "changed-proof",
    "censored-pass",
    "unproven-pass",
    "short-optional",
    "unproven-optional-contact",
    "positive-mandatory-only",
    "missing-branch",
  ])("rejects %s even if the aggregate timing score survives", (fault) => {
    const f = fixture("stable"),
      r = f.compare();
    expect(r.invariantMandatoryTiming).toBeUndefined();
    // Legacy geometry-consistency diagnostic only; never production fault admission.
    const legacyTimingObservation = r.candidates.find(
      (c) => c.code === "late-tap" && c.inputIds.length === 1 && c.inputIds[0] === f.mandatory[0],
    )!;
    const checkLegacyObservation = () =>
      certifyInvariantMandatoryTiming(f.e, f.mandatory, f.optional, r.hypotheses, r.approachVariants, r.candidates, [
        legacyTimingObservation,
      ]);
    expect(checkLegacyObservation()).toBeDefined();
    // Deliberately corrupt one independent branch's proof without changing its
    // timing candidate. Identical press offsets alone cannot certify geometry.
    const h = r.hypotheses[r.hypotheses.length - 1],
      at = h.approachVariantIds.findIndex((k) => r.approachVariants[k].inputId === f.mandatory[0]);
    const ep = JSON.parse(
      JSON.stringify(r.approachVariants[h.approachVariantIds[at]]),
    ) as typeof r.approachVariants[number];
    h.approachVariantIds[at] = r.approachVariants.push(ep) - 1;
    if (fault === "changed-pass") ep.properPass!.entryTimeMs++;
    if (fault === "changed-proof") ep.properPass!.eventIds.pop();
    if (fault === "censored-pass") ep.properPass!.leftCensored = true;
    if (fault === "unproven-pass") ep.properPass!.placementSupport = "unproven";
    const optional = r.approachVariants.find((e) => e.inputId === f.optional[0])!;
    if (fault === "short-optional") optional.limitations.push("short-local-trajectory");
    if (fault === "unproven-optional-contact")
      optional.contacts.push({ ...ep.properPass!, placementSupport: "unproven" });
    if (fault === "positive-mandatory-only") r.hypotheses[0].complete = false;
    if (fault === "missing-branch") r.hypotheses.pop();
    expect(
      certifyInvariantMandatoryTiming(f.e, f.mandatory, f.optional, r.hypotheses, r.approachVariants, r.candidates, [
        legacyTimingObservation,
      ]),
    ).toBeUndefined();
  });
});
