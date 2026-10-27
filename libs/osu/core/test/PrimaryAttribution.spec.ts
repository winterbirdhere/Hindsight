import { decidePressAttribution } from "../src/gameplay/error-analysis/PrimaryAttribution";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { stableGameplayRadius } from "../src/gameplay/StableHitGeometry";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { hitWindowsForOD } from "@osujs/math";
import { stableHitWindowsForOD } from "../src/gameplay/StableDifficulty";
import { HitCircle } from "../src/hitobjects/HitCircle";

const decide = (
  tapOffsetMs: number,
  entryMs: number,
  exitMs: number,
  bestWindowMs = 25,
  tapFeasible = true,
  aimFeasible = true,
) =>
  decidePressAttribution({
    tapOffsetMs,
    bestWindowMs,
    hitWindowMs: 109,
    originalInside: false,
    tapFeasible,
    aimFeasible,
    passes: [{ entryMs, exitMs }],
  });

describe("attribution against recorded model controls", () => {
  const object = "300,192,1000,1,0";
  const seed = errorFixture(object, [
    { time: 700, position: { x: 0, y: 0 }, actions: [] },
    { time: 1300, position: { x: 0, y: 0 }, actions: [] },
  ]);
  const radius = Math.fround(stableGameplayRadius((seed.map.getHitObject("0") as HitCircle).radius));
  const fixture = (tap: number, entry: number, exit: number, aim = false, neverInside = false) =>
    errorFixture(
      object,
      Array.from({ length: 501 }, (_, k) => {
        const offset = k - 250,
          radial = neverInside ? 3 : Math.max(-3, Math.min(3, (offset - (entry + exit) / 2) / ((exit - entry) / 2)));
        return {
          time: 1000 + offset,
          position: { x: aim && offset === tap ? 300 : 300 + radial * radius, y: 192 },
          actions: offset === tap ? [0] : [],
        };
      }),
    );
  it.each([false, true])("certifies aim only when the entire G misses the passage (mirror=%s)", (mirror) => {
    const tap = mirror ? -100 : 100,
      entry = mirror ? 40 : -70,
      exit = mirror ? 70 : -40;
    const original = fixture(tap, entry, exit);
    expect(original.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(fixture(tap, entry, exit, true).state.hitCircleVerdict["0"].type).toBe("MEH");
    for (const offset of [-25, -12, 0, 12, 25])
      expect(fixture(offset, entry, exit).state.hitCircleVerdict["0"].type).toBe("MISS");
    const evidence = deriveCircleEvidence(original.trace, original.map, "0");
    const pulse = evidence.inputs.find((i) => i.record.freshActions.length)!;
    const compared = comparePrimaryApproaches(evidence, original.map, { pressIds: [pulse.record.id] }, original.trace);
    const exported = JSON.parse(JSON.stringify(compared));
    expect(exported.candidatePool).toBe("ranking.candidates");
    expect(exported.candidates).toBeUndefined();
    expect(exported.ranking.candidates).toEqual(JSON.parse(JSON.stringify(compared.candidates)));
    expect(compared.ranking.selected).toHaveLength(1);
    expect(compared.ranking.selected[0].family).not.toBe("timing");
    expect(compared.ranking.attribution?.presses[0].channel).toBe("cursor");
    expect(compared.ranking.attribution?.presses[0].rule).toBe("only-aim-feasible");
  });
  it("records a compound-only repair without assigning either channel", () => {
    expect(fixture(120, -70, -40, false, true).state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(fixture(120, -70, -40, true, true).state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(fixture(0, -70, -40, false, true).state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(fixture(0, -70, -40, true, true).state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(
      decidePressAttribution({ tapOffsetMs: 120, bestWindowMs: 25, hitWindowMs: 109, originalInside: false, passes: [] })
        .rule,
    ).toBe("joint-failure");
  });
  it("chooses the recorded cursor departure even when only tapping is certified", () => {
    const frames = Array.from({ length: 401 }, (_, k) => ({
      time: 850 + k,
      position: { x: k + 850 >= 1010 && k + 850 <= 1025 ? 300 : 200, y: 192 },
      actions: k + 850 === 1000 ? [0] : [],
    }));
    const f = errorFixture("100,192,898,1,0\n300,192,1000,1,0", frames);
    const evidence = deriveCircleEvidence(f.trace, f.map, "1"),
      press = evidence.inputs.find((i) => i.record.timeMs === 1000)!;
    const r = comparePrimaryApproaches(evidence, f.map, { pressIds: [press.record.id] }, f.trace);
    expect(r.ranking.attribution?.presses[0]).toMatchObject({
      tapOffsetMs: 0,
      tapFeasible: true,
      aimFeasible: true,
      channel: "cursor",
    });
    expect(r.approaches.episodes[0].spatialCandidates.map(c => c.code)).toContain("misaim");
    expect(r.ranking.selected.map((c) => c.code)).toEqual(["misaim"]);
    expect(r.ranking.selected[0].observationOnly).toBe(true);
  });
  it.each(["stable", "lazer"] as const)("uses the evaluator's inclusive 300 boundary (%s)", (profile) => {
    const windows =
      profile === "stable"
        ? stableHitWindowsForOD(seed.map.stableOverallDifficulty)
        : hitWindowsForOD(seed.map.difficulty.overallDifficulty, true);
    for (const side of [-1, 1]) {
      const frames = [
        { time: 700, position: { x: 300, y: 192 }, actions: [] },
        { time: 1000 + side * windows[0], position: { x: 300, y: 192 }, actions: [0] },
        { time: 1300, position: { x: 300, y: 192 }, actions: [] },
      ];
      expect(errorFixture(object, frames, profile).state.hitCircleVerdict["0"].type).toBe("GREAT");
      expect(decide(side * windows[0], -windows[0], windows[0], windows[0]).tapTolerance).toBe(1);
    }
  });
});

describe("feasibility before shared-window attribution", () => {
  it("keeps the counterexample and its mirror on the only feasible channel", () => {
    expect(decide(100, -70, -40, 25, false).channel).toBe("cursor");
    expect(decide(-100, 40, 70, 25, false).channel).toBe("cursor");
    expect(decide(100, -70, -40, 25, false).rule).toBe("only-aim-feasible");
  });
  it("does not label the two-channel counterexample", () => {
    const result = decidePressAttribution({
      tapOffsetMs: 120,
      bestWindowMs: 25,
      hitWindowMs: 109,
      originalInside: false,
      tapFeasible: false,
      aimFeasible: false,
      passes: [],
    });
    expect(result.channel).toBe("unresolved");
    expect(result.rule).toBe("joint-failure");
    expect(result.tapTolerance).toBe(4.8);
  });
  it("rebuilds the three audited near-beat observations without replay identities", () => {
    expect(decide(-2, 97, 100, 23, false).channel).toBe("cursor");
    expect(decide(-2, 1.8, 25.7, 19).channel).toBe("cursor");
    expect(decide(4, -14.8, -0.5, 19).channel).toBe("cursor");
  });
  it("only tapping feasible selects tapping regardless of cursor departure", () => {
    expect(decide(100, -20, 20, 25, true, false).channel).toBe("tapping");
  });
  it("mirrors every decision and both deciding quantities", () => {
    for (let tap = -100; tap <= 100; tap += 5) {
      const forward = decide(tap, -17, 9),
        mirror = decide(-tap, -9, 17);
      expect(forward.channel).toBe(mirror.channel);
      expect(forward.tapTolerance).toBeCloseTo(mirror.tapTolerance);
      expect(forward.cursorTolerance).toBeCloseTo(mirror.cursorTolerance!);
    }
  });
  it("moving a tap farther away cannot move blame away from tapping", () => {
    let tapping = false;
    for (let tap = 10; tap <= 100; tap++) {
      const result = decide(tap, -10, 9);
      if (tapping) expect(result.channel).toBe("tapping");
      tapping ||= result.channel === "tapping";
    }
  });
  it("extending cursor coverage cannot move blame toward cursor", () => {
    let tapping = false;
    for (let exit = -20; exit <= 20; exit++) {
      const result = decide(21, -24, exit);
      if (tapping) expect(result.channel).toBe("tapping");
      tapping ||= result.channel === "tapping";
    }
  });
  it("is invariant to OD scaling and has no CS/distance comparison input", () => {
    for (const window of [19, 25, 43, 79, 19.5, 43.5]) {
      expect(decide(window * 0.4, -window * 0.2, window * 0.1, window).channel).toBe("cursor");
      expect(decide(window * 1.2, -window * 0.2, window * 0.1, window).channel).toBe("tapping");
    }
  });
  it("reports rather than automatically doubles a near tie", () => {
    const result = decide(20, -20, 4);
    expect(result.nearTie).toBe(true);
    expect(result.channel).toBe("cursor");
  });
  it("compares both neighbouring boundaries between passes", () => {
    const result = decidePressAttribution({
      tapOffsetMs: 0,
      bestWindowMs: 25,
      tapFeasible: true,
      aimFeasible: true,
      passes: [
        { entryMs: -20, exitMs: -5 },
        { entryMs: 8, exitMs: 20 },
      ],
    });
    expect(result.cursorTolerance).toBe(1.2);
    expect(result.channel).toBe("cursor");
  });
});
