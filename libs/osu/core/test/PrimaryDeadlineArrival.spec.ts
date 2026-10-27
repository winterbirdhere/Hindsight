import { deriveCircleEvidence, CircleEvidence, EvidenceBoundary } from "../src/gameplay/miss-explanation/CircleEvidence";
import { analyzePrimaryApproaches, PrimaryApproachContext, PrimaryApproachEpisode } from "../src/gameplay/error-analysis/PrimaryApproach";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

// Literal fixtures catch missing arrival evidence without making later containment
// a live hit opportunity or a successful landing. Expectations use the actual
// profile radius and the independent x=centre+radius intersection.
type Arrival = {
  basis: string;
  entryTimeMs: number;
  entryOffsetMs: number;
  deadline: EvidenceBoundary;
  afterDeadlineMs: number;
  minimumBeforeDeadlineR: number;
  preDeadlineProgressR: number;
  bracketIds: string[];
  insideInputId: string;
  eventIds: string[];
};
const arrival = (episode: PrimaryApproachEpisode) =>
  (episode as PrimaryApproachEpisode & { deadlineArrival?: Arrival }).deadlineArrival;
function fixture(profile: "stable" | "lazer", short = false, duplicate = false, instantChange = false) {
  const frames = short ? [traceFrame(800, 380), traceFrame(1030, 360, [0]), traceFrame(1051, 340),
    traceFrame(1057, 334), traceFrame(1120, 334)] : [traceFrame(800, 380), traceFrame(1074, 360, [0]),
    traceFrame(1108, 340), ...(duplicate ? [traceFrame(1108, instantChange ? 338 : 340)] : []), traceFrame(1114, 334)];
  const f = errorFixture(short ? "300,192,1000,2,0,L|310:192,1,10" : "300,192,1000,1,0", frames, profile);
  const evidence: CircleEvidence = JSON.parse(JSON.stringify(deriveCircleEvidence(f.trace, f.map, short ? "0/HEAD" : "0")));
  const press = evidence.inputs.find(i => i.record.freshActions.length)!;
  const context: PrimaryApproachContext = { pressIds: [press.record.id] };
  return { ...f, evidence, context, episode: () => analyzePrimaryApproaches(evidence, context).episodes[0] };
}

describe("arrival after the actual live deadline", () => {
  it.each([
    ["stable", 1109, 1111.5050468445], ["lazer", 1109.5, 1111.5200004578],
  ] as const)("retains arrival-only evidence in %s without importing live contact", (profile, cutoff, entry) => {
    const f = fixture(profile), before = JSON.stringify({ evidence: f.evidence, context: f.context });
    const e = f.episode(), proof = arrival(e);
    expect(proof).toBeDefined();
    expect(proof!.entryTimeMs).toBeCloseTo(entry, 8);
    expect(proof!.entryOffsetMs).toBeCloseTo(entry - 1000, 8);
    expect(proof!.deadline.timeMs).toBe(cutoff);
    expect(proof!.afterDeadlineMs).toBeCloseTo(entry - cutoff, 8);
    expect(proof!.minimumBeforeDeadlineR).toBeGreaterThan(1);
    expect(proof!.preDeadlineProgressR).toBeGreaterThan(.5);
    expect(proof!.eventIds).toEqual(expect.arrayContaining([f.evidence.terminal!.id]));
    expect(e).toMatchObject({ placement: "unproven", relation: "no-proper-pass", contacts: [], spatialCandidates: [], timingIndependent: false });
    expect(e.properPass).toBeUndefined(); expect(e.landing).toBeUndefined();
    expect(JSON.stringify({ evidence: f.evidence, context: f.context })).toBe(before);
    const comparison = comparePrimaryApproaches(f.evidence, f.map, f.context);
    expect(comparison.complete).toBe(true);
    expect(comparison.candidates.map(c => c.headline)).toEqual(["Late entry"]);
    expect(comparison.candidates[0]).toMatchObject({ family: "arrival", independent: false, inputIds: f.context.pressIds });
  });
  it.each(["stable", "lazer"] as const)("keeps exact-position duplicates as source, not additional movement, in %s", profile => {
    const e = fixture(profile, false, true).episode();
    expect(arrival(e)).toBeDefined();
    expect(e.contacts).toEqual([]);
    expect(arrival(fixture(profile, false, true, true).episode())).toBeUndefined();
  });
  it("uses Stable's short-parent cutoff, not the nominal head expiry", () => {
    const f = fixture("stable", true), p = arrival(f.episode());
    expect(p).toBeDefined();
    expect(p!.entryTimeMs).toBeCloseTo(1054.5050468445, 8);
    expect(p!.deadline).toMatchObject({ timeMs: 1051, sequence: 9, eventId: "r9" });
    expect(p!.eventIds).toContain("r9");
    expect(p!.entryTimeMs).toBeLessThan(f.evidence.domains.nominalSuccess.end!.timeMs);
    expect(arrival(fixture("lazer", true).episode())).toBeUndefined();
  });
  it("does not let one supported arrival erase another relevant unresolved attempt", () => {
    const f = fixture("stable");
    f.context.pressIds = [...f.context.pressIds, f.evidence.inputs[0].record.id];
    const c = comparePrimaryApproaches(f.evidence, f.map, f.context);
    expect(c.candidates.some(x => x.headline === "Late entry")).toBe(true);
    expect(c.complete).toBe(false);
  });

  it.each([
    ["long stationary run", [[1108, 340], [1137, 340], [1143, 334]], false],
    ["short exact repeat", [[1108, 340], [1128, 340], [1134, 334]], true],
    ["ongoing slow motion", [[1108, 340], [1137, 337], [1143, 334]], true],
    ["cumulative stationary updates", [[1100, 340], [1105, 340], [1108, 340], [1130, 340], [1136, 334]], false],
    ["cumulative motion within one noise footprint", [[1100, 340], [1105, 339.8], [1108, 339.6], [1130, 339.4], [1136, 334]], false],
    ["ongoing accumulated subnoise progress", [[1090, 340], [1095, 339.7], [1100, 339.4], [1105, 339.1], [1108, 338.8], [1114, 338.5], [1120, 334]], true],
    ["stationary run exactly one best window", [[1108, 340], [1133, 340], [1139, 334]], false],
  ] as [string, [number, number][], boolean][])("keeps whole-run stationarity for %s", (_name, positions, supported) => {
    const f = errorFixture("300,192,1000,1,0", [traceFrame(800, 380), traceFrame(1074, 360, [0]),
      ...positions.map(([time, x]) => traceFrame(time, x))], "stable");
    const e = deriveCircleEvidence(f.trace, f.map, "0"), input = e.inputs.find(i => i.record.freshActions.length)!;
    expect(e.geometry!.hitWindows[0]).toBe(25);
    const comparison = comparePrimaryApproaches(e, f.map, { pressIds: [input.record.id] });
    expect(!!arrival(comparison.approaches.episodes[0])).toBe(supported);
    expect(comparison.candidates.some(c => c.code === "aim-late")).toBe(supported);
    expect(comparison.approaches.episodes[0].contacts).toEqual([]);
  });

  type Control = (e: CircleEvidence, c: PrimaryApproachContext) => void;

  it.each(["stable", "lazer"] as const)("starts a new observed inward approach after a pre-tap stop in %s", profile => {
    for (const pressDuringStop of [false, true]) {
      const f = errorFixture("300,192,1000,1,0", [traceFrame(800, 380), traceFrame(1010, 360), traceFrame(1020, 360),
        traceFrame(1040, 360, pressDuringStop ? [0] : []), traceFrame(1066, 360),
        traceFrame(1074, 356, pressDuringStop ? [] : [0]), traceFrame(1108, 340), traceFrame(1114, 334)], profile);
      const e = deriveCircleEvidence(f.trace, f.map, "0"), p = e.inputs.find(i => i.record.freshActions.length)!;
      const comparison = comparePrimaryApproaches(e, f.map, { pressIds: [p.record.id] });
      expect(!!arrival(comparison.approaches.episodes[0])).toBe(!pressDuringStop);
      expect(comparison.candidates.some(c => c.code === "aim-late")).toBe(!pressDuringStop);
      if (!pressDuringStop) {
        expect(arrival(comparison.approaches.episodes[0])!.entryTimeMs).toBeCloseTo(profile === "stable" ? 1111.5050468445 : 1111.5200004578, 8);
        expect(arrival(comparison.approaches.episodes[0])!.eventIds).toContain(e.inputs.find(i => i.record.timeMs === 1040)!.record.id);
      }
    }
  });
  const controls: [string, Control][] = [
    ["fresh closing action", e => { e.inputs.at(-1)!.record.freshActions = [1]; }],
    ["closing context boundary", (e, c) => { c.contextBoundaryInputIds = [e.inputs.at(-1)!.record.id]; }],
    ["other relevant fresh action", (e, c) => { e.inputs.at(-1)!.record.freshActions = [1]; c.pressIds = [...c.pressIds, e.inputs.at(-1)!.record.id]; }],
    ["contradictory held action", e => { e.inputs.at(-1)!.record.actions = [1]; }],
    ["raw source gap", e => { e.inputs.forEach((i, k) => { if (i.record.source.origin === "parsed") i.record.source.rawTokenIndex = k; }); const s = e.inputs.at(-1)!.record.source; if (s.origin === "parsed") s.rawTokenIndex!++; }],
    ["invalid scope", (_e, c) => { c.end = { timeMs: 1114, inclusive: "yes" } as unknown as EvidenceBoundary; }],
    ["partial input coverage", e => { e.dependencies.input.status = "partial"; }],
    ["partial lifecycle", e => { e.dependencies.lifecycle.status = "partial"; }],
    ["unknown closing actions", e => { e.inputs.at(-1)!.freshActionsKnown = false; }],
    ["synthetic cursor endpoint", e => { e.inputs.at(-1)!.record.source = { origin: "synthetic", reason: "scoring-endpoint-interpolation" }; }],
    ["source discontinuity", e => { const s = e.inputs.at(-1)!.record.source; if (s.origin === "parsed") s.discontinuityBefore = ["parser-negative-delta"]; }],
    ["missing parsed frame", e => { const s = e.inputs.at(-1)!.record.source; if (s.origin === "parsed") s.parsedFrameIndex++; }],
    ["invalid source sequence", e => { e.inputs.at(-1)!.record.sequence = e.inputs.at(-2)!.record.sequence; }],
    ["nonfinite closing position", e => { e.inputs.at(-1)!.record.position.x = NaN; }],
    ["unrelated later movement", e => { e.inputs.at(-1)!.record.timeMs = 1200; }],
    ["no recorded containment", e => { e.inputs.at(-1)!.record.position.x = 340; }],
    ["already contained at the tap", e => { e.inputs.find(i => i.record.freshActions.length)!.record.position.x = 330; }],
    ["entry actually before cutoff", e => { e.inputs.at(-1)!.record.position.x = 310; }],
    ["outward correction", e => { e.inputs.at(-2)!.record.position.x = 365; }],
    ["opposed closing heading", e => { e.inputs.at(-1)!.record.position = { x: 336, y: 197 }; }],
    ["no established incoming progress", e => { e.inputs.find(i => i.record.freshActions.length)!.record.position.x = 340; }],
    ["placement fence", (_e, c) => { c.inputScopes = { [c.pressIds[0]]: { placementEnd: { timeMs: 1108, inclusive: true } } }; }],
    ["input end fence", (_e, c) => { c.inputScopes = { [c.pressIds[0]]: { end: { timeMs: 1108, inclusive: true } } }; }],
    ["exclusive same-time sequence fence", (e, c) => { c.end = { timeMs: 1114, sequence: e.inputs.at(-1)!.record.sequence, inclusive: false }; }],
    ["input start after press", (_e, c) => { c.inputScopes = { [c.pressIds[0]]: { start: { timeMs: 1100, inclusive: true } } }; }],
    ["input-triggered terminal", e => { e.terminal!.mechanism = "input-miss"; }],
    ["truncated trace", e => { e.limits.truncated = true; }],
    ["post-terminal intermediate sample", e => { e.inputs.at(-2)!.record.timeMs = e.terminal!.timeMs + 1; e.inputs.at(-2)!.record.sequence = e.terminal!.sequence + 1; e.inputs.at(-1)!.record.timeMs = e.terminal!.timeMs + 2; e.inputs.at(-1)!.record.sequence = e.terminal!.sequence + 2; }],
  ];
  describe.each(["stable", "lazer"] as const)("%s scope counterexamples", profile => {
    it.each(controls)("withholds arrival for %s", (_name, change) => {
      const f = fixture(profile); change(f.evidence, f.context);
      expect(arrival(f.episode())).toBeUndefined();
    });
  });
});
