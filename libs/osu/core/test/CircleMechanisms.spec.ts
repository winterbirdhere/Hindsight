import { Beatmap } from "../src/beatmap/Beatmap";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { activation, evidenceTrace, expiry, input } from "./CircleEvidenceFixtures";
import { traceBeatmap } from "./ReplayTraceFixtures";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { createReplayTraceCollector } from "../src/gameplay/trace/ReplayTraceCollector";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { traceFrame } from "./ReplayTraceFixtures";
import { errorFixture } from "./ErrorAnalysisFixtures";

const map = (objects = "300,192,1000,1,0") => {
  const result = traceBeatmap(objects);
  for (const object of result.hitObjects) if (object instanceof HitCircle) object.scale = 1 / 64;
  return result;
};
function evidence(records: object[], profile = "stable", beatmap = map(), target = "0") {
  const trace = evidenceTrace(records, profile);
  trace.identity.schemaVersion = 2;
  return { evidence: deriveCircleEvidence(trace, beatmap, target), map: beatmap };
}
const classify = (value: ReturnType<typeof evidence>) => classifyCircleLoss(value.evidence, value.map);
describe("automated tapping with ordered same-time cursor samples",()=>{
  it("recognizes a late recorded entry even when the first inside sample triggers its terminal",()=>{
    const f=errorFixture("300,192,1000,1,0",[traceFrame(700,200),traceFrame(1000,200),traceFrame(1020,350),
      traceFrame(1030,337),traceFrame(1030,335),traceFrame(1040,300),traceFrame(1200,300)],"stable",["RELAX"]);
    const e=deriveCircleEvidence(f.trace,f.map,"0");
    expect(e.terminal).toMatchObject({result:"OK",timeMs:1030});
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Aim late");
    const gap={...f.trace,records:f.trace.records.map(r=>r.kind==="input" && r.position.x===335 ? {...r,source:{...r.source,discontinuityBefore:["source-gap"]}} : r)};
    expect(classifyCircleLoss(deriveCircleEvidence(gap,f.map,"0"),f.map,gap).status).toBe("unavailable");
  });
  it("recognizes an early completed pass split internally by same-time updates",()=>{
    const f=errorFixture("300,192,1000,1,0",[traceFrame(700,200),traceFrame(940,300),traceFrame(940,300),
      traceFrame(960,300),traceFrame(960,300),traceFrame(970,400),traceFrame(1000,400),traceFrame(1200,400)],"stable",["RELAX"]);
    const e=deriveCircleEvidence(f.trace,f.map,"0");
    expect(e.terminal?.result).toBe("MISS");
    expect(e.insideIntervals.some(i=>i.rightCensored)).toBe(true);
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Left early");
  });
});
const attempted = (
  options: { selected?: string | null; rejected?: boolean; timing?: string | null; offset?: number } = {},
) => [
  { kind: "attempt", phase: "attempt", timeMs: 1000, inputId: "r2", attemptOrdinal: 0, actionCandidates: [0] },
  {
    kind: "selection",
    phase: "dispatch",
    timeMs: 1000,
    attemptId: "r3",
    componentId: options.selected === undefined ? "0" : options.selected,
    component: "circle",
    inside: options.selected === null ? null : true,
    eligible: options.selected !== null,
    selectionStopped: options.selected !== null,
  },
  ...(options.rejected !== undefined
    ? [
        {
          kind: "policy",
          phase: "dispatch",
          timeMs: 1000,
          attemptId: "r3",
          componentId: "0",
          state: options.rejected ? "rejected" : "allowed",
          branch: "test-order",
          timingResult: options.timing === undefined ? "GREAT" : options.timing,
          offsetMs: options.offset ?? 0,
          blockerId: "1",
        },
      ]
    : []),
];

describe("circle and head player mechanisms", () => {
  it.each([1000, 1038])("does not call a pre-eligible Relax hit at %s a consumed opportunity", (time) => {
    const fixture = errorFixture(
      "300,192,1000,1,0\n300,192,1050,1,0",
      [
        traceFrame(800, 500),
        traceFrame(time, 300),
        traceFrame(time + 1, 500),
        traceFrame(1100, 500),
        traceFrame(1250, 500),
      ],
      "stable",
      ["RELAX"],
    );
    expect(fixture.state.hitCircleVerdict["0"].type).toBe(time === 1000 ? "GREAT" : "OK");
    expect(fixture.state.hitCircleVerdict["1"].type).toBe("MISS");
    const value = deriveCircleEvidence(fixture.trace, fixture.map, "1");
    expect(value.routing.some((r) => r.kind === "selection" && r.componentId === "0" && r.timeMs === time)).toBe(true);
    expect(value.inputs.filter((i) => i.inside && i.inLiveSuccess).map((i) => i.record.timeMs)).toEqual([time]);
    const before = JSON.stringify(value);
    const result = classifyCircleLoss(value, fixture.map);
    expect(result.codes).toEqual(["left-early"]);
    expect(result.headline).toBe("Left early");
    expect(JSON.stringify(value)).toBe(before);
  });

  it("calls complete raw Autopilot input absence No tap while retaining held-state diagnostics", () => {
    const fixture = errorFixture(
      "300,192,1000,1,0",
      [0, 800, 900, 1000, 1100, 1200].map((t) => traceFrame(t, 300, [0])),
      "stable",
      ["AUTO_PILOT"],
    );
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("MISS");
    const value = deriveCircleEvidence(fixture.trace, fixture.map, "0");
    expect(value.dependencies.input.status).toBe("complete");
    expect(value.inputs.filter((i) => i.inLiveSuccess).every((i) => i.record.freshActions.length === 0)).toBe(true);
    const result = classifyCircleLoss(value, fixture.map);
    expect(result.codes).toEqual(["no-tap"]);
    expect(result.headline).toBe("No tap");
    expect(result.diagnostics).toMatchObject({
      absence: { scope: "complete-live-opportunity", freshInputCount: 0, heldAtContact: true },
    });
  });

  it("keeps eligible Relax consumption as unresolved context instead of a rejected player category", () => {
    const base = map("300,192,1000,1,0\n300,192,1050,1,0");
    const relaxed = new Beatmap(base.hitObjects, base.difficulty, ["RELAX"], base.controlPointInfo);
    const records = attempted({ selected: "1" }).map((record, index) =>
      index === 0 ? { ...record, automated: true, actionCandidates: [] } : record,
    );
    const value = evidence(
      [activation(), input(800, 500), input(1000, 300, [], [], 1), ...records, expiry(), input(1200, 500, [], [], 2)],
      "stable",
      relaxed,
    );
    expect(value.evidence.status).toBe("supported");
    const before = JSON.stringify(value.evidence);
    const result = classify(value);
    expect(result.status).toBe("unavailable");
    expect(result.limitations).toContain("automated-consumed-input-primary-unresolved");
    expect(result.diagnostics?.opportunities.some((p) => p.codes.includes("tap-taken"))).toBe(true);
    expect(JSON.stringify(value.evidence)).toBe(before);
  });

  it("does not claim Autopilot absence when a fresh opposite action was accepted", () => {
    const fixture = errorFixture(
      "300,192,1000,1,0",
      [traceFrame(0, 300, [0]), traceFrame(900, 300, [0]), traceFrame(1000, 300, [1]), traceFrame(1200, 300, [1])],
      "stable",
      ["AUTO_PILOT"],
    );
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("GREAT");
    const result = classifyCircleLoss(deriveCircleEvidence(fixture.trace, fixture.map, "0"), fixture.map);
    expect(result.status).toBe("unavailable");
    expect(result.codes).not.toContain("no-tap");
  });

  it("does not convert partial Autopilot input coverage into absence", () => {
    const fixture = errorFixture(
      "300,192,1000,1,0",
      [0, 800, 900, 1000, 1100, 1200].map((t) => traceFrame(t, 300, [0])),
      "stable",
      ["AUTO_PILOT"],
    );
    const value = deriveCircleEvidence(fixture.trace, fixture.map, "0");
    value.dependencies.input = { status: "partial", reasons: ["source-discontinuity"] };
    const result = classifyCircleLoss(value, fixture.map);
    expect(result.status).toBe("unavailable");
    expect(result.limitations).toContain("incomplete-local-opportunity");
    expect(result.codes).not.toContain("no-tap");
  });

  it("uses actual eligible Relax updates, not an interpolated unsampled pass, for late engagement", () => {
    const fixture = errorFixture(
      "300,192,1000,1,0",
      [
        traceFrame(800, 500),
        traceFrame(970, 250),
        traceFrame(1000, 350),
        traceFrame(1040, 350),
        traceFrame(1050, 300),
        traceFrame(1200, 500),
      ],
      "stable",
      ["RELAX"],
    );
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("OK");
    const value = deriveCircleEvidence(fixture.trace, fixture.map, "0");
    expect(value.insideIntervals.some((interval) => interval.startTimeMs < 1000 && interval.endTimeMs > 990)).toBe(
      true,
    );
    expect(classifyCircleLoss(value, fixture.map).headline).toBe("Aim late");
  });
  it("keeps Stable Relax's strict 12 ms boundary out of earlier eligible contact", () => {
    const fixture = errorFixture(
      "300,192,1000,1,0",
      [
        traceFrame(800, 500),
        traceFrame(988, 300),
        traceFrame(989, 500),
        traceFrame(1040, 500),
        traceFrame(1050, 300),
        traceFrame(1200, 500),
      ],
      "stable",
      ["RELAX"],
    );
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("OK");
    expect(classifyCircleLoss(deriveCircleEvidence(fixture.trace, fixture.map, "0"), fixture.map).headline).toBe(
      "Aim late",
    );
  });
  it("explains a Relax pass that ended before the first eligible update as Left early", () => {
    const fixture = errorFixture(
      "300,192,1000,1,0",
      [traceFrame(800, 500), traceFrame(950, 300), traceFrame(985, 300), traceFrame(1005, 500), traceFrame(1200, 500)],
      "stable",
      ["RELAX"],
    );
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("MISS");
    const result = classifyCircleLoss(deriveCircleEvidence(fixture.trace, fixture.map, "0"), fixture.map);
    expect(result.headline).toBe("Left early");
    expect(result.codes).not.toContain("no-tap");
    expect(result.description).not.toMatch(/tap/i);
  });
  it("retains actual Relax order rejection without inventing a manual press", () => {
    const fixture = errorFixture(
      "100,192,1000,1,0\n300,192,1050,1,0",
      [
        traceFrame(800, 500),
        traceFrame(1000, 300),
        traceFrame(1050, 300),
        traceFrame(1070, 500),
        traceFrame(1250, 500),
      ],
      "stable",
      ["RELAX"],
    );
    expect(fixture.state.hitCircleVerdict["1"].type).toBe("MISS");
    const value = deriveCircleEvidence(fixture.trace, fixture.map, "1");
    expect(value.attempts.some((attempt) => attempt.automated)).toBe(true);
    const result = classifyCircleLoss(value, fixture.map);
    expect(result.headline).toBe("Notelock");
    expect(result.description).not.toMatch(/tap/i);
  });
  it("localizes a documented early source reversal instead of invalidating a later accepted hit", () => {
    const value = evidence([
      input(100, 500),
      input(20, 500, [], [], 1, {
        source: { origin: "parsed", parsedFrameIndex: 1, discontinuityBefore: ["parser-negative-delta"] },
      }),
      activation(),
      input(800, 300, [], [], 2),
      input(1050, 300, [0], [0], 3),
      { kind: "attempt", phase: "attempt", timeMs: 1050, inputId: "r4", attemptOrdinal: 0, actionCandidates: [0] },
      expiry(1050, { result: "OK", mechanism: "successful-input", triggerAttemptId: "r5" }),
      input(1200, 300, [], [], 4),
    ]);
    expect(classify(value).headline).toBe("Late tap");
    expect(value.evidence.limitations).not.toContain("invalid-trace");
  });
  it("keeps a source rewind across the target itself unavailable instead of choosing a convenient pass", () => {
    const value = evidence([
      activation(),
      input(880, 300),
      input(1050, 300),
      input(950, 300, [], [], 2, {
        source: { origin: "parsed", parsedFrameIndex: 2, discontinuityBefore: ["parser-negative-delta"] },
      }),
      expiry(),
      input(1200, 300, [], [], 3),
    ]);
    expect(classify(value).status).toBe("unavailable");
  });
  it("ends a short Stable head's opportunity at actual parent completion", () => {
    const fixture = errorFixture(
      "100,192,1000,2,0,L|110:192,1,10",
      [
        traceFrame(800, 500),
        traceFrame(900, 500),
        traceFrame(1000, 500),
        traceFrame(1050, 100),
        traceFrame(1100, 100, [0]),
        traceFrame(1200, 100),
      ],
      "stable",
    );
    const head = (fixture.map.hitObjects[0] as import("../src/hitobjects/Slider").Slider).head;
    const e = deriveCircleEvidence(fixture.trace, fixture.map, head.id);
    const parent = fixture.trace.records.find((record) => record.kind === "slider-parent");
    expect(e.domains.liveSuccess.end?.eventId).toBe(parent?.id);
    expect(e.inputs.find((item) => item.record.timeMs === 1100)?.inLiveSuccess).toBe(false);
    expect(classifyCircleLoss(e, fixture.map).headline).toBe("No tap");
  });
  it.each(["stable", "lazer"])("admits schema 2 %s circle losses without changing schema 1", (profile) => {
    const records = [activation(), input(880, 300), expiry(), input(1200, 300, [], [], 1)];
    expect(classify(evidence(records, profile)).headline).toBe("No tap");
    const old = evidenceTrace(records, profile);
    expect(deriveCircleEvidence(old, map(), "0").status).toBe("supported");
  });
  it("does not call an unplayed object a No tap error", () => {
    expect(classify(evidence([activation(), input(880, 300)])).status).toBe("unavailable");
  });
  it("proves zero fresh actions independently of holding, retaining held detail internally", () => {
    const result = classify(
      evidence([
        activation(),
        input(880, 300, [0], []),
        input(1000, 300, [0], [], 1),
        expiry(),
        input(1200, 300, [0], [], 2),
      ]),
    );
    expect(result.headline).toBe("No tap");
    expect(result.diagnostics?.primary?.observedMechanism.headline).toBe("No re-tap");
  });
  it("finds held contact between samples without interpolating button edges", () => {
    const result = classify(
      evidence([
        activation(),
        input(880, 297, [0], []),
        input(1109, 303, [0], [], 1),
        expiry(),
        input(1200, 303, [], [], 2),
      ]),
    );
    expect(result.headline).toBe("No tap");
    expect(result.diagnostics?.primary?.observedMechanism.headline).toBe("No re-tap");
  });
  it("a fresh opposite action defeats No re-tap", () => {
    const value = evidence([
      activation(),
      input(880, 300, [0], []),
      input(1000, 300, [0, 1], [1], 1),
      ...attempted({ selected: "1" }),
      expiry(),
      input(1200, 300, [], [], 2),
    ]);
    expect(classify(value).status).toBe("unavailable");
    expect(classify(value).diagnostics?.primary?.observedMechanism.headline).toBe("Tap taken");
  });
  it.each(["stable", "lazer"] as const)(
    "classifies actual %s order rejection independently of consumed input",
    (profile) => {
      const fixture = errorFixture(
        "100,192,1000,1,0\n300,192,1050,1,0",
        [traceFrame(800, 0), traceFrame(980, 300, [0]), traceFrame(990, 300), traceFrame(1300, 400)],
        profile,
      );
      const blocked = { evidence: deriveCircleEvidence(fixture.trace, fixture.map, "1"), map: fixture.map };
      expect(blocked.evidence.directRejections).toHaveLength(1);
      expect(classify(blocked).headline).toBe("Notelock");
      const taken = evidence(
        [
          activation(),
          input(880, 300),
          input(1000, 300, [0], [0], 1),
          ...attempted({ selected: "1" }),
          expiry(),
          input(1200, 300, [], [], 2),
        ],
        profile,
      );
      expect(classify(taken).status).toBe("unavailable");
      expect(classify(taken).diagnostics?.primary?.observedMechanism.headline).toBe("Tap taken");
      expect(classify(taken).description).not.toMatch(/hit|scored|notelock/i);
    },
  );
  it("does not call invalid-time or null-timing rejection Notelock", () => {
    const value = evidence([
      activation(),
      input(880, 300),
      input(1000, 300, [0], [0], 1),
      ...attempted({ rejected: true, timing: null }),
      expiry(),
      input(1200, 300, [], [], 2),
    ]);
    expect(classify(value).codes).not.toContain("notelock");
    expect(classify(value).status).toBe("unavailable");
  });
  it("preserves direct input Miss even when later movement returns inside", () => {
    const value = evidence([
      activation(),
      input(650, 300),
      input(689, 300, [0], [0], 1),
      { kind: "attempt", phase: "attempt", timeMs: 689, inputId: "r2", attemptOrdinal: 0, actionCandidates: [0] },
      expiry(689, { mechanism: "input-miss", triggerAttemptId: "r3" }),
      input(1000, 300, [1], [1], 2),
      input(1200, 300, [], [], 3),
    ]);
    const result = classify(value);
    expect(result.headline).toBe("Early tap");
    expect(result.metric).toEqual({ value: 311, unit: "ms early" });
    expect(result.eventIds).not.toContain("r5");
  });
  it.each([
    ["OK", 50, "Late tap"],
    ["MEH", -100, "Early tap"],
  ])("uses the actual successful %s scoring input", (grade, offset, headline) => {
    const time = 1000 + Number(offset);
    const value = evidence([
      activation(),
      input(880, 300),
      input(time, 300, [0], [0], 1),
      { kind: "attempt", phase: "attempt", timeMs: time, inputId: "r2", attemptOrdinal: 0, actionCandidates: [0] },
      expiry(time, { result: grade, mechanism: "successful-input", triggerAttemptId: "r3" }),
      input(1200, 300, [], [], 2),
    ]);
    expect(classify(value).headline).toBe(headline);
    expect(classify(value).metric?.value).toBe(Math.abs(Number(offset)));
  });
  it("does not fabricate a timing cause for a contradictory 100 at the centre of the great window", () => {
    const value = evidence([
      activation(),
      input(880, 300),
      input(1000, 300, [0], [0], 1),
      ...attempted(),
      expiry(1000, { result: "OK", mechanism: "successful-input", triggerAttemptId: "r3" }),
      input(1200, 300, [], [], 2),
    ]);
    expect(classify(value).status).toBe("unavailable");
  });
  it("calls an ordered forced loss Out of order without inventing a successful trigger", () => {
    const value = evidence(
      [
        activation(),
        input(880, 300),
        expiry(1000, { componentId: "1", mechanism: "automatic-expiry" }),
        expiry(1000, { mechanism: "ordered-force-miss", triggerResolutionId: "r2" }),
        input(1200, 300, [], [], 1),
      ],
      "lazer",
      map("300,192,1000,1,0\n400,192,1050,1,0"),
    );
    const result = classify(value);
    expect(result.headline).toBe("Out of order");
    expect(result.description).toBe("A later note resolved first.");
  });
  it("accepts native's reserved forward causal reference in the actual evaluator", () => {
    const beatmap = traceBeatmap("100,192,1000,1,0\n300,192,1050,1,0");
    const frames = [traceFrame(800, 0), traceFrame(1050, 300, [0]), traceFrame(1200, 300)];
    const identity = { ...evidenceTrace([], "lazer").identity, schemaVersion: 2 as const };
    const collector = createReplayTraceCollector(
      identity,
      {
        endTimeMs: 1200,
        endpointBasis: "recorded-end",
        synthesizedEndpoint: false,
        sourceCoverageLimits: [],
        initialActionsKnown: true,
        frameSources: frames.map((_, parsedFrameIndex) => ({ origin: "parsed" as const, parsedFrameIndex })),
      },
      { maxRecords: 10000, maxExportBytes: 10000000 },
    );
    new LazerGameStateTimeMachine(frames, beatmap, undefined, {}, collector).gameStateAt(1200);
    const source = deriveCircleEvidence(collector.seal(), beatmap, "0");
    expect(source.terminal?.mechanism).toBe("ordered-force-miss");
    const cause = source.terminalReferences.find((record) => record.kind === "resolution");
    if (!cause || !source.terminal) throw new Error("Missing actual ordered-resolution link");
    expect(cause.sequence).toBeGreaterThan(source.terminal.sequence);
    expect(classifyCircleLoss(source, beatmap).headline).toBe("Out of order");
  });
  it("does not label a directly attributed in-window Miss as an early timing mistake", () => {
    const value = evidence([
      activation(),
      input(880, 300),
      input(990, 300, [0], [0], 1),
      { kind: "attempt", phase: "attempt", timeMs: 990, inputId: "r2", attemptOrdinal: 0, actionCandidates: [0] },
      expiry(990, { mechanism: "input-miss", triggerAttemptId: "r3" }),
      input(1200, 300, [], [], 2),
    ]);
    expect(classify(value).status).toBe("unavailable");
  });
  it("rejects a forced-resolution self-reference", () => {
    const value = evidence([
      activation(),
      input(880, 300),
      expiry(1000, { mechanism: "ordered-force-miss", triggerResolutionId: "r2" }),
      input(1200, 300, [], [], 1),
    ]);
    expect(classify(value).status).toBe("unavailable");
  });
  it("rejects a forced reference to an earlier object even when the timestamps agree", () => {
    const value = evidence(
      [
        activation(),
        input(880, 300),
        expiry(1000, { componentId: "1" }),
        expiry(1000, { mechanism: "ordered-force-miss", triggerResolutionId: "r2" }),
        input(1200, 300, [], [], 1),
      ],
      "lazer",
      map("300,192,1000,1,0\n400,192,900,1,0"),
    );
    expect(classify(value).status).toBe("unavailable");
  });
  it("does not infer absence across a source gap", () => {
    const value = evidence([
      activation(),
      input(880, 300),
      input(1000, 300, [], [], 1, {
        source: { origin: "parsed", parsedFrameIndex: 1, discontinuityBefore: ["parser-gap"] },
      }),
      expiry(),
      input(1200, 300, [], [], 2),
    ]);
    expect(classify(value).status).toBe("unavailable");
  });
  it("rejects unknown initial input rather than No tap", () => {
    const value = evidence([activation(), input(1000, 300), expiry()]);
    expect(classify(value).status).toBe("unavailable");
  });
  it("keeps a post-terminal press out of an earlier expiry's cause", () => {
    const result = classify(
      evidence([
        activation(),
        input(880, 300),
        input(1100, 300, [], [], 1),
        expiry(),
        input(1112, 300, [0], [0], 2),
        input(1200, 300, [], [], 3),
      ]),
    );
    expect(result.headline).toBe("No tap");
    expect(result.eventIds).not.toContain("r4");
  });
  it("does not promote a partial capture to a complete-window claim", () => {
    const value = evidence([
      activation(),
      input(880, 303),
      input(1000, 303, [0], [0], 1),
      expiry(),
      input(1200, 303, [], [], 2),
    ]);
    value.evidence.dependencies.input = { status: "partial", reasons: ["record-cap"] };
    expect(classify(value).status).toBe("unavailable");
  });
  it.each(["stable", "lazer"])("admits %s slider heads in schema 2", (profile) => {
    const beatmap = traceBeatmap("300,192,1000,2,0,L|400:192,1,100");
    const value = evidence(
      [activation(400), input(880, 300), expiry(1111), input(1200, 300, [], [], 1)],
      profile,
      beatmap,
      "0/HEAD",
    );
    // Component identity comes from the prepared slider, not a guessed name.
    const head = (beatmap.hitObjects[0] as import("../src/hitobjects/Slider").Slider).head;
    const trace = evidenceTrace(
      [
        { ...activation(), componentId: head.id, component: "slider-head" },
        input(880, 300),
        { ...expiry(), componentId: head.id, component: "slider-head" },
        input(1200, 300, [], [], 1),
      ],
      profile,
    );
    trace.identity.schemaVersion = 2;
    expect(classifyCircleLoss(deriveCircleEvidence(trace, beatmap, head.id), beatmap).headline).toBe("No tap");
    expect(value.map).toBe(beatmap);
  });
  it("admits prepared modifier geometry only in schema 2", () => {
    const base = map();
    const modded = new Beatmap(base.hitObjects, base.difficulty, ["HARD_ROCK"], base.controlPointInfo);
    const records = [activation(), input(880, 300), expiry(), input(1200, 300, [], [], 1)];
    expect(classify(evidence(records, "stable", modded)).headline).toBe("No tap");
    expect(deriveCircleEvidence(evidenceTrace(records), modded, "0").status).toBe("unsupported");
  });
  it("never blames an automated tapping facet for not pressing", () => {
    const base = map();
    const relaxed = new Beatmap(base.hitObjects, base.difficulty, ["RELAX"], base.controlPointInfo);
    expect(
      classify(evidence([activation(), input(880, 300), expiry(), input(1200, 300, [], [], 1)], "stable", relaxed))
        .status,
    ).toBe("unavailable");
  });
  it("explains a Relax miss through its manually controlled aim", () => {
    const fixture = errorFixture(
      "300,192,1000,1,0",
      [traceFrame(800, 500), traceFrame(900, 500), traceFrame(1100, 500), traceFrame(1300, 500)],
      "stable",
      ["RELAX"],
    );
    const result = classifyCircleLoss(deriveCircleEvidence(fixture.trace, fixture.map, "0"), fixture.map);
    expect(result.headline).toBe("Off target");
    expect(result.codes).not.toContain("no-tap");
  });
  it.each([
    ["stable", false, false, false],
    ["stable", true, false, true],
    ["lazer", false, false, true],
    ["lazer", false, true, false],
  ] as const)("keeps head accuracy semantics separate: %s V2=%s Classic=%s", (profile, v2, classic, isLoss) => {
    const fixture = errorFixture(
      "100,192,1000,2,0,L|300:192,1,200",
      [
        traceFrame(900, 100),
        traceFrame(1080, 116, [0]),
        traceFrame(1500, 200, [0]),
        traceFrame(1970, 294, [0]),
        traceFrame(2100, 300, [0]),
      ],
      profile,
      v2 ? ["SCORE_V2"] : [],
      classic ? [{ acronym: "CL" }] : [],
    );
    const head = (fixture.map.hitObjects[0] as import("../src/hitobjects/Slider").Slider).head;
    const result = classifyCircleLoss(deriveCircleEvidence(fixture.trace, fixture.map, head.id), fixture.map);
    expect(result.status).toBe(isLoss ? "supported" : "unavailable");
    if (isLoss) expect(result.headline).toBe("Late tap");
  });
  it.each([true, false])("Classic head accuracy enabled remains a timing loss with notelock %s", (classicNoteLock) => {
    const fixture = errorFixture(
      "100,192,1000,2,0,L|300:192,1,200",
      [
        traceFrame(900, 100),
        traceFrame(1080, 116, [0]),
        traceFrame(1500, 200, [0]),
        traceFrame(1970, 294, [0]),
        traceFrame(2100, 300, [0]),
      ],
      "lazer",
      [],
      [{ acronym: "CL", settings: { no_slider_head_accuracy: false, classic_note_lock: classicNoteLock } }],
    );
    const head = (fixture.map.hitObjects[0] as import("../src/hitobjects/Slider").Slider).head;
    expect(classifyCircleLoss(deriveCircleEvidence(fixture.trace, fixture.map, head.id), fixture.map).headline).toBe(
      "Late tap",
    );
  });
  it("keeps both separately dispatched logical actions from an actual blocked frame", () => {
    const fixture = errorFixture("100,192,1000,1,0\n300,192,1050,1,0", [
      traceFrame(800, 0),
      traceFrame(1030, 300, [0, 1]),
      traceFrame(1040, 300),
      traceFrame(1300, 400),
    ]);
    const value = { evidence: deriveCircleEvidence(fixture.trace, fixture.map, "1"), map: fixture.map };
    expect(value.evidence.directRejections).toHaveLength(2);
    expect(new Set(value.evidence.directRejections.map((w) => w.attemptId)).size).toBe(2);
    expect(classify(value).codes).toEqual(["notelock"]);
    expect(classify(value).headline).toBe("Notelock");
    expect(classify(value).diagnostics?.primary?.observedMechanism.codes).toEqual(["notelock"]);
  });
  it("keeps otherwise-valid Notelock primary while retaining earlier aim context internally", () => {
    const fixture = errorFixture(
      "100,192,1000,1,0\n300,192,1050,1,0",
      [
        traceFrame(800, 200),
        traceFrame(960, 250, [0]),
        traceFrame(970, 275),
        traceFrame(980, 300, [1]),
        traceFrame(990, 330),
        traceFrame(1300, 400),
      ],
      "lazer",
    );
    const value = { evidence: deriveCircleEvidence(fixture.trace, fixture.map, "1"), map: fixture.map };
    const result = classify(value);
    expect(result.headline).toBe("Notelock");
    expect(result.diagnostics?.primary?.observedMechanism.codes).toContain("aim-late");
  });
  it("rejects a stated grade incompatible with the independently known timing bands", () => {
    const value = evidence([
      activation(),
      input(880, 300),
      input(1090, 300, [0], [0], 1),
      { kind: "attempt", phase: "attempt", timeMs: 1090, inputId: "r2", attemptOrdinal: 0, actionCandidates: [0] },
      expiry(1090, { result: "OK", mechanism: "successful-input", triggerAttemptId: "r3" }),
      input(1200, 300, [], [], 2),
    ]);
    // OD9: 90 ms lies outside the 68 ms native OK window, but inside MEH.
    expect(classify(value).status).toBe("unavailable");
  });
  it("classifies a delayed Relax arrival as aim, never a manual late tap", () => {
    const fixture = errorFixture(
      "300,192,1000,1,0",
      [traceFrame(800, 500), traceFrame(900, 500), traceFrame(1000, 500), traceFrame(1080, 300), traceFrame(1200, 300)],
      "stable",
      ["RELAX"],
    );
    const result = classifyCircleLoss(deriveCircleEvidence(fixture.trace, fixture.map, "0"), fixture.map);
    expect(result.headline).toBe("Aim late");
    expect(result.codes).not.toContain("late-tap");
  });
  it("does not let a wrong same-time input sequence retroactively enter the live domain", () => {
    const value = evidence([
      activation(),
      input(880, 300),
      expiry(1000),
      input(1000, 300, [0], [0], 1),
      input(1200, 300, [], [], 2),
    ]);
    expect(classify(value).headline).toBe("No tap");
  });
  it.each(["stable", "lazer"] as const)(
    "checks legal %s accepted-input grade bands through actual scoring",
    (profile) => {
      // Independent OD9 bands: OK ends below 68 ms; MEH ends below 110 ms.
      const cases = [
        { offset: -100, grade: "MEH" },
        { offset: -50, grade: "OK" },
        { offset: 50, grade: "OK" },
        { offset: 100, grade: "MEH" },
      ];
      for (const item of cases) {
        const fixture = errorFixture(
          "300,192,1000,1,0",
          [traceFrame(800, 300), traceFrame(1000 + item.offset, 300, [0]), traceFrame(1200, 300)],
          profile,
        );
        expect(fixture.state.hitCircleVerdict["0"].type).toBe(item.grade);
        const result = classifyCircleLoss(deriveCircleEvidence(fixture.trace, fixture.map, "0"), fixture.map);
        expect(result.headline).toBe(item.offset < 0 ? "Early tap" : "Late tap");
        expect(result.metric?.value).toBe(Math.abs(item.offset));
      }
    },
  );
  it.each(["stable", "lazer"] as const)(
    "covers legal %s fresh/held/position gates without scoring losses on hits",
    (profile) => {
      for (const held of [false, true])
        for (const inside of [false, true])
          for (const fresh of [false, true]) {
            const prior = held ? [0] : [];
            const actions = fresh ? (held ? [0, 1] : [0]) : prior;
            const fixture = errorFixture(
              "300,192,1000,1,0",
              [
                traceFrame(800, 500, prior),
                traceFrame(900, inside ? 300 : 500, prior),
                traceFrame(1000, inside ? 300 : 500, actions),
                traceFrame(1100, inside ? 300 : 500, actions),
                traceFrame(1300, inside ? 300 : 500, actions),
              ],
              profile,
            );
            const actual = fixture.state.hitCircleVerdict["0"];
            const result = classifyCircleLoss(deriveCircleEvidence(fixture.trace, fixture.map, "0"), fixture.map);
            if (fresh && inside) {
              expect(actual.type).toBe("GREAT");
              expect(result.status).toBe("unavailable");
            } else {
              expect(actual.type).toBe("MISS");
              expect(result.headline).toBe(fresh ? "Misaim" : "No tap");
            }
          }
    },
  );
});

describe("all local movement opportunities", () => {
  function path(points: [number, number, number?, boolean?][], profile = "lazer", beatmap = map()) {
    const records: object[] = [activation(), input(880, 297)];
    points.forEach(([time, x, y = 0, pressed = false], index) => {
      const inputId = `r${records.length}`;
      records.push(
        input(time, 300 + x, pressed ? [0] : [], pressed ? [0] : [], index + 1, {
          position: { x: 300 + x, y: 192 + y },
        }),
      );
      if (pressed) {
        const attemptId = `r${records.length}`;
        records.push({
          kind: "attempt",
          phase: "attempt",
          timeMs: time,
          inputId,
          attemptOrdinal: 0,
          actionCandidates: [0],
        });
        records.push({
          kind: "selection",
          phase: "dispatch",
          timeMs: time,
          attemptId,
          componentId: null,
          inside: null,
          eligible: false,
          selectionStopped: false,
        });
      }
    });
    const last = points[points.length - 1];
    records.push(
      expiry(),
      input(1200, 300 + last[1], [], [], points.length + 1, {
        position: { x: 300 + last[1], y: 192 + (last[2] ?? 0) },
      }),
    );
    // These hand-built paths use real edge history, including the release
    // following each pulse; geometry tests must not rely on malformed actions.
    let previousActions: number[] = [];
    for(const record of records) {
      const row=record as {kind?:string;actions?:number[];previousActions?:number[]};
      if(row.kind!=="input")continue;
      row.previousActions=[...previousActions];
      previousActions=[...(row.actions??[])];
    }
    return evidence(records, profile, beatmap);
  }
  it("promotes directional landings and positive lateral Misaim with independently constructed paths", () => {
    expect(
      classify(
        path([
          [900, -3],
          [920, 0],
          [940, 1.5],
          [960, 1.8, 0, true],
          [980, 1.4],
        ]),
      ).headline,
    ).toBe("Overshoot");
    expect(
      classify(
        path([
          [900, -3],
          [920, -2],
          [940, -1.3],
          [960, -1.25, 0, true],
          [980, -1.6],
        ]),
      ).headline,
    ).toBe("Undershoot");
    expect(
      classify(
        path([
          [900, -3, 1.2],
          [920, -1, 1.2],
          [940, 0, 1.2, true],
          [960, 1, 1.2],
          [980, 3, 1.2],
        ]),
      ).headline,
    ).toBe("Misaim");
  });
  it("keeps observed arrival when the entire pass misses the correct-tap window", () => {
    expect(
      classify(
        path([
          [900, -3],
          [940, -1.5, 0, true],
          [960, 0],
          [980, 3],
        ]),
      ).headline,
    ).toBe("Late entry");
  });
  it("uses Early exit for normal departure instead of fabricated Overshoot", () => {
    expect(
      classify(
        path([
          [900, -3],
          [940, 0],
          [960, 1.5, 0, true],
          [980, 3],
        ]),
      ).headline,
    ).toBe("Early exit");
  });
  it("describes the selected gap cursor error as Misaim when neither passage overlaps G", () => {
    expect(
      classify(
        path([
          [900, -3],
          [920, 0],
          [940, 3, 0, true],
          [960, 0],
          [980, -3],
        ]),
      ).headline,
    ).toBe("Misaim");
  });
  it("retains both premature taps around a flow pass in the primary comparison", () => {
    const result = classify(
      path([
        [900, -3],
        [920, -1.5, 0, true],
        [940, 0],
        [960, 1.5, 0, true],
        [980, 3],
      ]),
    );
    expect(result.headline).toBe("Early exit");
    expect(result.diagnostics?.primary?.ranking?.attribution?.roles.rule).toBe("nearest-recorded-opportunity");
    expect(result.diagnostics?.primary?.observedMechanism.codes).toEqual(
      expect.arrayContaining(["aim-late", "left-early"]),
    );
    expect(result.diagnostics?.primary?.ranking?.comparisonInputIds).toHaveLength(2);
    expect(result.diagnostics?.primary?.ranking?.attribution?.presses.every(p=>p.observationOnly&&!p.tapFeasible)).toBe(true);
    expect(result.metric).toBeDefined();
  });
  it("compares all three relevant attempts and retains competing morphology as diagnostics", () => {
    const result = classify(
      path([
        [900, -3],
        [920, -1.5, 0, true],
        [940, 0],
        [960, 1.8, 0, true],
        [980, 1.4],
        [1000, 3],
        [1020, 4, 0, true],
        [1040, 6],
      ]),
    );
    expect(result.diagnostics?.primary?.observedMechanism.codes).toEqual(
      expect.arrayContaining(["aim-late", "overshoot", "left-early"]),
    );
    // Two premature taps (-80/-40ms), then +20ms. The declared complete-input
    // comparison includes the later action and the observed early passage.
    expect(result.headline).toBe("Early exit");
    expect(result.diagnostics?.primary?.ranking?.attribution?.roles.rule).toBe("nearest-recorded-opportunity");
    expect(result.diagnostics?.primary?.ranking?.comparisonInputIds).toHaveLength(3);
    expect(result.diagnostics?.primary?.ranking?.attribution?.presses).toHaveLength(3);
    expect(result.metric).toBeDefined();
    expect(result.diagnostics?.primary?.ranking?.selected[0].attribution?.tapOffsetMs).toBe(20);
    expect(result.diagnostics?.opportunities).toHaveLength(3);
  });
  it("does not confuse overlapping timing windows with overlapping local geometry", () => {
    const beatmap = map("300,192,1000,1,0\n400,192,1010,1,0");
    const result = classify(
      path(
        [
          [900, -3],
          [920, 0],
          [940, 1.5],
          [960, 1.8, 0, true],
          [980, 1.4],
        ],
        "lazer",
        beatmap,
      ),
    );
    // The second receptor is 100 radii away; the sampled first-target crossing
    // and far-side turn are still positive local evidence, without inferred intent.
    expect(result.headline).toBe("Overshoot");
    expect(result.codes).toContain("overshoot");
  });
  it("uses an exact small boundary margin without rounding it into a hit", () => {
    expect(
      classify(
        path([
          [900, -1.01],
          [940, -1.01, 0, true],
          [980, -1.01],
        ]),
      ).headline,
    ).toBe("Misaim");
  });
  it("uses positive stationary misplaced placement, without inventing an approach direction", () => {
    expect(
      classify(
        path([
          [900, -3],
          [940, -3, 0, true],
          [980, -3],
        ]),
      ).headline,
    ).toBe("Misaim");
  });
});
