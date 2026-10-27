import { decidePressAttribution, certifyPrimaryAttribution } from "../src/gameplay/error-analysis/PrimaryAttribution";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import * as opportunity from "../src/gameplay/error-analysis/PrimaryOpportunity";

const facts = (tapOffsetMs: number, bestWindowMs = 25) => ({
  tapOffsetMs, bestWindowMs, hitWindowMs: 109, originalInside: false, passes: [],
  grazes: [{ entryMs: -10, exitMs: 10, minRadialR: .8 }],
});
describe("outside-G tap corrections through a graze", () => {
  it.each([-60, 60])("compares tap %sms against a wholly uncovered G without creating cursor coverage", tap => {
    expect(decidePressAttribution(facts(tap))).toMatchObject({ channel: "tapping", tapFeasible: true,
      aimFeasible: true, cursorTolerance: 2, tapTolerance: 2.4, nearTie: false, grazeTapAvailable: true });
  });
  it.each([[-1, 1], [1, 1], [-1, 2], [1, 2]])("is symmetric and scale independent (sign %s, scale %s)", (sign, scale) => {
    for (const [ratio, channel, nearTie] of [[1.5, "cursor", false], [1.8, "cursor", true],
      [2, "cursor", true], [2.2, "tapping", true], [2.4, "tapping", false]] as const) {
      const f = facts(sign * ratio * 20 * scale, 20 * scale);
      expect(decidePressAttribution(f)).toMatchObject({ channel, nearTie, cursorTolerance: 2 });
    }
  });
  it.each([-25, 0, 25])("leaves on-time tap %sms exactly under the v25 graze rule", tap => {
    expect(decidePressAttribution(facts(tap))).toMatchObject({ channel: "cursor", tapFeasible: false,
      nearTie: false, cursorTolerance: undefined });
  });
  it("does not count a graze outside G or give a censored/unproven deeper contact absent coverage", () => {
    const outside = { ...facts(60), grazes: [{ entryMs: 26, exitMs: 50 }] },
      uncertain = { ...facts(60), deeperContactExists: true };
    expect(decidePressAttribution(outside).tapFeasible).toBe(false);
    expect(decidePressAttribution(uncertain)).toMatchObject({
      tapFeasible: true, cursorTolerance: undefined, channel: "unresolved", rule: "missing-comparable-boundary" });
  });
  it("does not let a valid off-beat graze rescue a corrupt beat-containing graze", () => {
    expect(decidePressAttribution({ ...facts(60), grazes: [
      { entryMs: -10, exitMs: 10, recordedFailure: "invalid-recorded-source-or-action" },
      { entryMs: -20, exitMs: -15 },
    ] })).toMatchObject({ grazeTapAvailable: false, tapFeasible: false, channel: "cursor" });
  });
  it("keeps deeper contacts as the sole cursor-coverage source", () => {
    const decision = decidePressAttribution({ ...facts(60), passes: [{ entryMs: 30, exitMs: 40 }] });
    expect(decision).toMatchObject({ tapFeasible: true, aimFeasible: true, cursorTolerance: 0,
      channel: "tapping", grazeOnlyComparison: false });
  });
  it("retains local correctness and does not invent an aim correction outside H", () => {
    expect(decidePressAttribution({ ...facts(60), originalInside: true }).rule).toBe("no-observed-departure");
    expect(decidePressAttribution(facts(109))).toMatchObject({ aimFeasible: false, channel: "tapping", nearTie: false });
  });
  it("uses both near-tie conditions with their existing inclusive tolerance", () => {
    expect(decidePressAttribution(facts(1.65 * 25)).nearTie).toBe(true);
    expect(decidePressAttribution(facts(1.649 * 25)).nearTie).toBe(false);
    expect(decidePressAttribution(facts(2.35 * 25)).nearTie).toBe(true);
    expect(decidePressAttribution(facts(2.351 * 25)).nearTie).toBe(false);
  });
  it("respects half-millisecond native G and strict H boundaries", () => {
    for (const sign of [-1, 1]) {
      expect(decidePressAttribution({ ...facts(sign * 25.5, 25.5), hitWindowMs: 108.5 }).tapFeasible).toBe(false);
      expect(decidePressAttribution({ ...facts(sign * 51, 25.5), hitWindowMs: 108.5 })).toMatchObject({
        cursorTolerance: 2, tapTolerance: 2, nearTie: true });
      expect(decidePressAttribution({ ...facts(sign * 108.5, 25.5), hitWindowMs: 108.5 }).aimFeasible).toBe(false);
    }
  });
});

describe("narrow same-press graze-only pair", () => {
  const seed = errorFixture("300,192,1000,1,0", [traceFrame(0), traceFrame(1300)]);
  const radius = deriveCircleEvidence(seed.trace, seed.map, "0").geometry!.radius;
  it("offers only beat-containing graze samples to the selected tapping certificate", () => {
    const frames = Array.from({ length: 401 }, (_, k) => {
      const t = k - 200;
      return { time: 1000 + t, position: { x: 300 + ((t < -5 ? t + 14 : t - 2) / 5) * radius,
        y: 192 + .8 * radius }, actions: t === 60 ? [0] : [] };
    });
    const f = errorFixture("300,192,1000,1,0", frames), e = deriveCircleEvidence(f.trace, f.map, "0"),
      id = e.inputs.find(i => i.record.freshActions.length)!.record.id;
    const spy = jest.spyOn(opportunity, "inspectPrimaryOpportunity");
    try {
      const r = comparePrimaryApproaches(e, f.map, { pressIds: [id] }, f.trace).ranking;
      expect(r.selected.map(c => c.code)).toEqual(["late-tap"]);
      const decision = r.attribution!.presses[0];
      expect(decision.grazes).toHaveLength(2);
      const samples = spy.mock.calls.filter(args => args[5] === "sampled-pass-tap").flatMap(args => args[4]);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every(sample => e.inputs.find(i => i.record.id === sample)!.record.timeMs >= 999)).toBe(true);
      expect(r.selected[0].geometryWitnessEventIds).toEqual(expect.arrayContaining(decision.grazes![1].eventIds));
    } finally { spy.mockRestore(); }
  });
  function crossing(tap: number, depth = .8, centre = 0, pending = false) {
    const frames = Array.from({ length: 401 }, (_, k) => {
      const t = k - 200;
      return { time: 1000 + t, position: { x: 300 + ((t - centre) / 10) * radius,
        y: 192 + depth * radius }, actions: t === tap ? [0] : [] };
    });
    const f = errorFixture((pending ? "100,192,950,1,0\n" : "") + "300,192,1000,1,0", frames),
      e = deriveCircleEvidence(f.trace, f.map, pending ? "1" : "0"),
      id = e.inputs.find(i => i.record.freshActions.length)!.record.id;
    return { f, e, id, r: comparePrimaryApproaches(e, f.map, { pressIds: [id] }, f.trace).ranking };
  }
  it.each([[42, ["misaim", "late-tap"]], [55, ["late-tap", "misaim"]],
    [-42, ["misaim", "early-tap"]], [-55, ["early-tap", "misaim"]]] as const)(
    "shows both channels at %sms, larger first, and requests only their own corrections", (tap, codes) => {
      const { r, id, e } = crossing(tap);
      expect(r.selected.map(c => c.code)).toEqual(codes);
      expect(r.selected.every(c => c.inputIds.length === 1 && c.inputIds[0] === id)).toBe(true);
      expect(r.attribution!.presses[0]).toMatchObject({ passes: [], cursorTolerance: 2,
        grazeOnlyComparison: true, tapFeasible: true, aimFeasible: true });
      expect(r.attribution!.presses[0].certification!.map(c => c.channel)).toEqual(
        codes.map(c => c.includes("tap") ? "tapping" : "cursor"));
      expect(r.selected.every(c => c.briefDetail?.metric)).toBe(true);
      const tapCandidate = r.selected.find(c => c.family === "timing")!;
      expect(tapCandidate.support?.correction?.kind).toBe("sampled-pass-tap");
      expect(Math.abs(tapCandidate.support!.correction!.timeMs - 1000)).toBeLessThanOrEqual(e.geometry!.hitWindows[0]);
    },
  );
  it.each([20, 60])("keeps one label away from the narrow tie band at %sms", tap => {
    expect(crossing(tap).r.selected.map(c => c.code)).toEqual([tap === 20 ? "misaim" : "late-tap"]);
  });
  it("does not widen pairing to deep passes or grazes without G overlap", () => {
    expect(crossing(42, .5).r.selected).toHaveLength(1);
    expect(crossing(-42, .8, 60).r.selected.map(c => c.code)).toEqual(["misaim"]);
  });
  it("keeps both observation-only refusals and blanks incomplete pair evidence", () => {
    const { f, e, r } = crossing(55, .8, 0, true);
    expect(r.selected.map(c => c.code)).toEqual(["late-tap", "misaim"]);
    expect(r.selected.every(c => c.observationOnly)).toBe(true);
    expect(r.attribution!.presses[0].certification!.every(c => c.refusals.length > 0)).toBe(true);
    const incomplete = certifyPrimaryAttribution(e, f.map, f.trace, r, false);
    expect(incomplete.selected).toEqual([]);
    expect(incomplete.reason).toBe("incomplete-primary-observation");
  });
  it("does not restore tap availability from a corrupt graze beside a valid bare timing candidate", () => {
    const frames = Array.from({ length: 401 }, (_, k) => {
      const t = k - 200;
      const deep = t < -25;
      return { time: 1000 + t, position: {
        x: 300 + ((deep ? t + 52 : t) / 10) * radius,
        y: 192 + (deep ? .5 : .8) * radius,
      }, actions: t === 75 ? [0] : [] };
    });
    const f = errorFixture("300,192,1000,1,0", frames);
    const trace = JSON.parse(JSON.stringify(f.trace)) as typeof f.trace;
    for (const record of trace.records) {
      if (record.kind === "input" && record.timeMs >= 975 && record.timeMs <= 1025)
        record.rawButtonMask = 32;
    }
    const e = deriveCircleEvidence(trace, f.map, "0"),
      id = e.inputs.find(i => i.record.freshActions.length)!.record.id,
      r = comparePrimaryApproaches(e, f.map, { pressIds: [id] }, trace).ranking;
    expect(r.attribution!.presses[0].grazeTapAvailable).toBe(false);
    expect(r.attribution!.presses[0].grazes!.some(c => c.recordedFailure ===
      "invalid-recorded-source-or-action")).toBe(true);
    expect(r.selected.map(c => c.code)).not.toContain("late-tap");
  });
  it("does not fill comparison completeness with a new timing descriptor for a locally correct tap", () => {
    const frames = Array.from({ length: 401 }, (_, k) => {
      const t = k - 200;
      return { time: 1000 + t, position: { x: 300 + ((t + 40) / 100) * radius,
        y: 192 + .8 * radius }, actions: t === -40 ? [0] : [] };
    });
    const f = errorFixture("300,192,950,1,0\n300,192,1000,1,0", frames),
      e = deriveCircleEvidence(f.trace, f.map, "1"),
      id = e.inputs.find(i => i.record.freshActions.length)!.record.id,
      r = comparePrimaryApproaches(e, f.map, { pressIds: [id] }, f.trace).ranking;
    expect(r.attribution!.presses[0]).toMatchObject({
      rule: "no-observed-departure", grazeTapAvailable: true, originalInside: true,
    });
    expect(r.selected).toEqual([]);
    expect(r.candidates.filter(c => c.family === "timing")).toEqual([]);
  });
});
