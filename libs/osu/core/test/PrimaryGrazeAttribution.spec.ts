import { decidePressAttribution, rankAttributionCandidates } from "../src/gameplay/error-analysis/PrimaryAttribution";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { decidedCandidate } from "./PrimaryAttributionTestFixtures";
import { isPrimaryCursorPass } from "../src/gameplay/error-analysis/PrimaryApproach";

describe("graze contacts and inside-circle missed-target attribution", () => {
  it.each([[0.749999, true], [0.75, false], [0.750001, false], [NaN, false], [-1, false]])(
    "requires contact minimum %s to be strictly below the graze threshold", (minRadialR, pass) => {
      expect(isPrimaryCursorPass({ minRadialR: minRadialR as number })).toBe(pass);
    },
  );
  const seed = errorFixture("300,192,1000,1,0", [traceFrame(0), traceFrame(1300)]);
  const radius = deriveCircleEvidence(seed.trace, seed.map, "0").geometry!.radius;
  const crossing = (depth: number, halfWidth: number, tap = 70) => {
    const frames = Array.from({ length: 401 }, (_, k) => {
      const t = k - 200;
      return { time: 1000 + t, position: { x: 300 + (t / halfWidth) * radius, y: 192 + depth * radius }, actions: t === tap ? [0] : [] };
    });
    const f = errorFixture("300,192,1000,1,0", frames);
    const e = deriveCircleEvidence(f.trace, f.map, "0"), id = e.inputs.find(i => i.record.freshActions.length)!.record.id;
    return { f, e, id, comparison: comparePrimaryApproaches(e, f.map, { pressIds: [id] }, f.trace) };
  };
  it.each([1, 70])("restores tapping without shallow cursor coverage, irrespective of duration (%sms)", halfWidth => {
    const { comparison } = crossing(0.8, halfWidth, 90);
    expect(comparison.approaches.episodes[0].contacts[0].minRadialR).toBeCloseTo(0.8);
    expect(comparison.ranking.selected.map(c => c.code)).toEqual(["late-tap"]);
    expect(comparison.ranking.attribution!.presses[0]).toMatchObject({ channel: "tapping", tapFeasible: true, cursorTolerance: 2 });
    expect(comparison.ranking.attribution!.presses[0]).toHaveProperty("grazes.0.minRadialR");
    expect(comparison.ranking.attribution!.presses[0].passes).toEqual([]);
  });
  it.each([[0.749, "late-tap"], [0.751, "late-tap"]])("uses measured contact depth %s without a duration cutoff", (depth, label) => {
    const { comparison } = crossing(depth as number, 10);
    expect(comparison.ranking.selected.map(c => c.code)).toEqual([label]);
    expect(comparison.ranking.attribution!.presses[0].passes).toHaveLength((depth as number) < .75 ? 1 : 0);
  });
  it.each([-80, -20, 20, 80])("finds no local departure for an inside-circle press at %sms within H", tapOffsetMs => {
    expect(decidePressAttribution({ tapOffsetMs, bestWindowMs: 25, hitWindowMs: 109, originalInside: true,
      passes: [{ entryMs: -100, exitMs: 100 }] })).toMatchObject({ channel: "unresolved", rule: "no-observed-departure" });
  });
  it("does not select a farther miss-causing press when nearest is already inside H", () => {
    const near = decidedCandidate("late-tap", "inside", 10), far = decidedCandidate("early-tap", "outside", 20);
    Object.assign(near.attribution!, { tapOffsetMs: 10, originalInside: true, tapFeasible: false, aimFeasible: false,
      channel: "unresolved", rule: "no-observed-departure", selectedCodes: [] });
    const ranked = rankAttributionCandidates([far, near]);
    expect(ranked.attribution!.roles.chosenInputId).toBe("inside");
    expect(ranked.selected).toEqual([]);
    expect(ranked.reason).toBe("no-observed-departure");
  });
  it("blanks a missed note whose valid press was consumed while preserving the receiver accuracy error", () => {
    const f = errorFixture("300,192,980,1,0\n300,192,1000,1,0", [traceFrame(0, 300), traceFrame(1000, 300),
      traceFrame(1050, 300, [0]), traceFrame(1300, 300)]);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MEH");
    expect(f.state.hitCircleVerdict["1"].type).toBe("MISS");
    const receiver = classifyCircleLoss(deriveCircleEvidence(f.trace, f.map, "0"), f.map, f.trace);
    const missed = classifyCircleLoss(deriveCircleEvidence(f.trace, f.map, "1"), f.map, f.trace);
    expect(receiver.codes).toEqual(["late-tap"]);
    expect(missed.codes).toEqual([]);
    const p = missed.diagnostics!.primary!;
    const ranking = p.rawOpportunityComparison?.ranking ?? p.unconsumedContextComparison?.ranking ?? p.ranking!;
    expect(ranking.reason).toBe("no-observed-departure");
    expect(ranking.attribution!.presses.find(p => p.inputId === ranking.attribution!.roles.chosenInputId))
      .toMatchObject({ routingObservation: { outcomes: [{ status: "consumed", receiverId: "0" }] } });
  });
  it("uses an intact inside press point even when its preceding movement cannot be interpolated", () => {
    const f = errorFixture("300,192,980,1,0\n300,192,1000,1,0", [traceFrame(700, 500), traceFrame(1030, 500),
      traceFrame(1049, 300 + .99 * radius), traceFrame(1050, 400), traceFrame(1050, 300 + .99 * radius, [0]),
      traceFrame(1051, 400), traceFrame(1060, 400), traceFrame(1075, 400, [1]), traceFrame(1090, 400), traceFrame(1300, 400)]);
    const e = deriveCircleEvidence(f.trace, f.map, "1"), presses = e.inputs.filter(i => i.record.freshActions.length);
    const r = comparePrimaryApproaches(e, f.map, { pressIds: presses.map(i => i.record.id) }, f.trace);
    expect(r.ranking.attribution!.roles.chosenInputId).toBe(presses[0].record.id);
    expect(r.ranking.reason).toBe("no-observed-departure");
    expect(r.ranking.selected).toEqual([]);
    expect(r.ranking.attribution!.presses[0].certification).toBeUndefined();
  });
  it("records a consumed input-miss separately from a successful receiver hit", () => {
    const f = errorFixture("300,192,950,1,0\n300,192,1000,1,0", [traceFrame(700, 300),
      traceFrame(1000, 300), traceFrame(1060, 300, [0]), traceFrame(1300, 300)]);
    const receipt = f.trace.records.find(r => r.kind === "resolution" && r.componentId === "0" && r.mechanism === "input-miss");
    expect(receipt).toBeDefined();
    const e = deriveCircleEvidence(f.trace, f.map, "1"), press = e.inputs.find(i => i.record.freshActions.length)!;
    const r = comparePrimaryApproaches(e, f.map, { pressIds: [press.record.id] }, f.trace);
    expect(r.ranking.reason).toBe("no-observed-departure");
    expect(r.ranking.selected).toEqual([]);
    expect(r.ranking.attribution!.presses[0].routingObservation).toMatchObject({
      provenance: "model-reconstructed", outcomes: [{ status: "consumed-miss", receiverId: "0", eventIds: expect.arrayContaining([receipt!.id]) }],
    });
  });
  it("compares the deeper re-entry without borrowing coverage from an earlier graze", () => {
    const knots = [[-100, -3, .9], [-20, -1.5, .9], [-2, 0, .9], [15, 1.5, .9],
      [21, 1.5, .9], [27, 0, 0], [60, -3, 0], [150, -3, 0]];
    const f = errorFixture("300,192,1000,1,0", knots.map(([dt, x, y]) => ({ time: 1000 + dt,
      position: { x: 300 + x * radius, y: 192 + y * radius }, actions: dt === 21 ? [0] : [] })));
    const e = deriveCircleEvidence(f.trace, f.map, "0"), press = e.inputs.find(i => i.record.freshActions.length)!;
    const r = comparePrimaryApproaches(e, f.map, { pressIds: [press.record.id] }, f.trace), d = r.ranking.attribution!.presses[0];
    expect(d).toMatchObject({ channel: "cursor", tapFeasible: true, aimFeasible: true });
    expect(d.passes).toHaveLength(1);
    expect(d.passes[0].entryMs).toBeGreaterThan(21);
    expect(d.bestOverlapMs).toBeGreaterThan(0);
    expect(d.bestOverlapMs).toBeLessThan(2);
    expect(d.grazes).toHaveLength(1);
    expect(d.grazes![0].minRadialR).toBeCloseTo(.9);
    expect(r.ranking.selected).toHaveLength(1);
    expect(r.ranking.selected[0].family).not.toBe("timing");
  });
  it("records an explicit receiver rejection and blocker without changing direct Notelock priority", () => {
    const f = errorFixture("100,192,950,1,0\n300,192,1000,1,0", [traceFrame(700, 300),
      traceFrame(990, 300), traceFrame(1000, 300, [0]), traceFrame(1300, 300)]);
    const e = deriveCircleEvidence(f.trace, f.map, "1"), press = e.inputs.find(i => i.record.freshActions.length)!;
    const r = comparePrimaryApproaches(e, f.map, { pressIds: [press.record.id] }, f.trace);
    expect(r.ranking.selected).toEqual([]);
    expect(r.ranking.attribution!.presses[0].routingObservation).toMatchObject({
      provenance: "model-reconstructed", outcomes: [{ status: "blocked", receiverId: "1", blockerId: "0" }],
    });
    expect(classifyCircleLoss(e, f.map, f.trace).headline).toBe("Notelock");
  });
  it.each([-109, 109])("does not extend the inside-press exemption beyond strict H at %s", tapOffsetMs => {
    expect(decidePressAttribution({ tapOffsetMs, bestWindowMs: 25, hitWindowMs: 109, originalInside: true,
      passes: [{ entryMs: -25, exitMs: 25 }] }).rule).not.toBe("no-observed-departure");
  });
});
