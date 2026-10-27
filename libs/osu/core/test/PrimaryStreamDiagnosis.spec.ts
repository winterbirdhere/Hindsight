import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";

// Independently specified cadence: six notes 80ms apart; actions are 35ms late.
// Aim passes note 3 at1215 and reaches note4 at1275. Successful earlier actions
// establish cadence; the engine receives note3's late tap on note4 instead.
function flowingStream(
  options: { missing?: boolean; held?: boolean; normalAim?: boolean; blockedNext?: boolean; extra?: boolean } = {},
) {
  const points = options.normalAim
    ? [
        [800, 0],
        [1000, 100],
        [1080, 150],
        [1160, 200],
        [1240, 250],
        [1320, 300],
        [1400, 350],
        [1600, 450],
      ]
    : [
        [800, 0],
        [1000, 100],
        [1080, 150],
        [1160, 200],
        [1215, 250],
        [1275, 300],
        [1355, options.blockedNext ? 300 : 350],
        [1435, 400],
        [1600, 450],
      ];
  const taps = [
    1035,
    1115,
    1195,
    ...(options.missing ? [] : [1275]),
    options.blockedNext ? 1335 : 1355,
    1435,
    ...(options.extra ? [1210] : []),
  ].sort((a, b) => a - b);
  const times = [
    ...new Set([...Array.from({ length: 101 }, (_, i) => 800 + i * 8), ...taps, ...taps.map((t) => t + 25)]),
  ].sort((a, b) => a - b);
  const frames = times.map((time) => {
    const at = Math.max(0, points.findIndex((p) => p[0] >= time) - 1),
      a = points[at],
      b = points[at + 1] ?? a;
    const x = a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]);
    // Holding key0 never suppresses a fresh key1 action. Alternate normally otherwise.
    const actions = options.held
      ? [...(time >= 1035 ? [0] : []), ...(taps.slice(1).some((t) => time >= t && time < t + 25) ? [1] : [])]
      : taps.flatMap((tap, index) => (time >= tap && time < tap + 25 ? [index % 2] : []));
    return traceFrame(time, options.extra && time === 1210 ? 0 : x, actions);
  });
  return errorFixture(
    "100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,1,0\n250,192,1240,1,0\n300,192,1320,1,0\n350,192,1400,1,0",
    frames,
  );
}
function classify(f: ReturnType<typeof errorFixture>, target: string) {
  const evidence = deriveCircleEvidence(f.trace, f.map, target);
  const before = JSON.stringify(normalizeTraceState({ state: f.state, trace: f.trace }));
  const result = classifyCircleLoss(evidence, f.map, f.trace);
  expect(JSON.stringify(normalizeTraceState({ state: f.state, trace: f.trace }))).toBe(before);
  return { evidence, result };
}

function shiftedReception(shift = 0, brakes = false, blockedHead = false, repair=false, repairTime?:number) {
  const taps = [970, 1050, 1130, 1210, 1290, 1370, 1450].map((t) => t + shift);
  const points = [
    [800, 50],
    [970, 100],
    [1050, 150],
    [1130, 200],
    [1210, 200],
    [1290, 250],
    [1370, 300],
    [1450, 400],
    [1650, brakes ? 450 : 650],
  ].map(([t, x]) => [t + shift, x]);
  const times = [
    ...new Set([800, ...Array.from({ length: 100 }, (_, i) => 900 + i * 8), ...taps, ...taps.map((t) => t + 25), 1750]),
  ].sort((a, b) => a - b);
  const frames = times.map((time) => {
    const at = Math.max(0, points.findIndex((p) => p[0] >= time) - 1),
      a = points[at],
      b = points[at + 1] ?? a;
    return traceFrame(
      time,
      repair&&time===1450+shift?350:a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
      taps.flatMap((tap, i) => (time >= (i===6?repairTime??tap:tap) && time < tap + 25 ? [i % 2] : [])),
    );
  });
  return errorFixture(
    "100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,1,0\n250,192,1240,1,0\n300,192,1320,1,0\n350,192,1400,1,0" +
      (blockedHead ? "\n400,192,1480,2,0,L|450:192,1,100" : ""),
    frames,
  );
}

describe("stream primary selection follows source cadence, not receptor or held state", () => {
  it.each([false, true])("keeps the initiating late press when another action remains held: %s", (held) => {
    const f = flowingStream({ held }),
      { evidence, result } = classify(f, "3");
    expect(f.state.hitCircleVerdict["3"].type).toBe("MISS");
    expect(
      evidence.inputs
        .filter((i) => i.inLiveSuccess && !i.postTerminal && i.record.freshActions.length)
        .map((i) => i.record.timeMs),
    ).toEqual([1195, 1275]);
    expect(result.headline).toBe("Late tap");
    expect(result.metric).toEqual({ value: 35, unit: "ms late" });
    const relevant = result.diagnostics?.primary?.association.relevantInputIds;
    expect(evidence.inputs.filter((i) => relevant?.includes(i.record.id)).map((i) => i.record.timeMs)).toEqual([1275]);
    expect(result.diagnostics?.primary?.observedMechanism).toBeDefined();
  });
  it("does not transfer the initiating error to the following otherwise-valid blocked note", () => {
    const f = flowingStream({ blockedNext: true }),
      { evidence, result } = classify(f, "4");
    expect(f.state.hitCircleVerdict["4"].type).toBe("MISS");
    expect(evidence.inputs.find((i) => i.record.timeMs === 1335)?.inside).toBe(true);
    expect(result.headline).toBe("Notelock");
    expect(result.codes).not.toContain("tap-taken");
  });
  it("requires a positive gap between bracketing successful taps to identify a skipped slot", () => {
    const f = flowingStream({ missing: true, normalAim: true }),
      { evidence, result } = classify(f, "3");
    expect(f.state.hitCircleVerdict["2"].type).toBe("OK");
    expect(f.state.hitCircleVerdict["4"].type).toBe("OK");
    expect(evidence.inputs.some((i) => i.inLiveSuccess && i.record.freshActions.length)).toBe(true);
    expect(result.headline).toBe("No tap");
    expect(result.diagnostics?.primary?.association).toMatchObject({ stream: { missingTargetTap: true } });
  });
  it("does not claim absence merely because the only live action belongs to a completed neighbour", () => {
    const f = errorFixture("100,192,920,1,0\n300,192,1000,1,0", [
      traceFrame(800, 100),
      traceFrame(920, 100, [0]),
      traceFrame(925, 100, [0]),
      traceFrame(950, 300, [0]),
      traceFrame(1000, 300, [0]),
      traceFrame(1200, 300, [0]),
    ]);
    const { result } = classify(f, "1");
    expect(result.headline).not.toMatch(/No re-tap|No tap|Tap taken/);
    expect(result.limitations).toContain("inferred-neighbour-claim-not-successful-receipt");
    expect(result.headline).toBe("Early tap");
    expect(result.diagnostics?.primary?.unconsumedContextComparison?.ranking.selected[0].observationOnly).toBe(true);
  });
  it("compares both plausible phases and chooses the nearest recorded press", () => {
    const f = shiftedReception(),
      { evidence, result } = classify(f, "5");
    expect(f.state.hitCircleVerdict["4"].type).toBe("OK");
    expect(f.state.hitCircleVerdict["5"].type).toBe("MISS");
    expect(result.diagnostics?.primary?.association.stream?.status).toBe("ambiguous");
    expect(evidence.inputs.filter((i) => [1370, 1450].includes(i.record.timeMs)).every((i) => !i.inside)).toBe(true);
    expect(result.headline).toBe("Early tap");
    expect(result.diagnostics?.primary?.ranking?.selected[0].observationOnly).toBe(true);
    expect(result.metric).toEqual({value:30,unit:"ms early"});
    expect(result.eventIds).toEqual(
      expect.arrayContaining(
        evidence.inputs.filter((i) => [1370, 1450].includes(i.record.timeMs)).map((i) => i.record.id),
      ),
    );
    expect(result.codes).not.toEqual(expect.arrayContaining(["early-tap", "late-tap"]));
  });
  it("does not hide a phase alternative whose timing is inside the best window", () => {
    const f = shiftedReception(10),
      { result } = classify(f, "5");
    expect(f.state.hitCircleVerdict["5"].type).toBe("MISS");
    expect(result.status).toBe("supported");expect(result.codes).toEqual(["early-tap"]);
    expect(result.metric).toEqual({value:20,unit:"ms early"});
    expect(result.diagnostics?.primary?.phaseComparison?.reason).toBe("positive-correction-among-competing-phases");
    expect(result.diagnostics?.primary?.association.stream?.phaseAlternatives?.some(a=>a.active)).toBe(true);
    expect(result.diagnostics?.primary?.phaseComparison?.approaches.episodes.map(e=>e.pressOffsetMs).sort((a,b)=>a-b)).toEqual([-20,60]);
    const fixed=shiftedReception(10,false,false,false,1396);
    expect(fixed.state.hitCircleVerdict["5"]).toMatchObject({type:"GREAT",judgementTime:1396});
    for(let id=0;id<5;id++)expect(fixed.state.hitCircleVerdict[String(id)]).toEqual(f.state.hitCircleVerdict[String(id)]);
  });
  it("does not discard genuine braking when a phase alternative has an independent aim defect", () => {
    const f = shiftedReception(0, true),
      { result } = classify(f, "5");
    expect(result.status).toBe("supported");
    expect(result.headline).toBe("Early tap");
    expect(result.diagnostics?.primary?.ranking?.selected[0].observationOnly).toBe(true);
    expect(
      result.diagnostics?.primary?.phaseComparison?.approaches.episodes.some((e) => e.spatialCandidates.length),
    ).toBe(true);
    expect(result.diagnostics?.primary?.phaseComparison?.reason).toBe("positive-correction-among-competing-phases");
    const repaired=shiftedReception(0,true,false,true);
    expect(repaired.state.hitCircleVerdict["5"].type).toBe("OK");
    for(let id=0;id<5;id++)expect(repaired.state.hitCircleVerdict[String(id)]).toEqual(f.state.hitCircleVerdict[String(id)]);
  });
  it("preserves shared ownership and compares the extra press without inventing an overshoot", () => {
    const f = flowingStream({ extra: true }),
      a = classify(f, "3"),
      b = classify(f, "4");
    const at = (time: number) => a.evidence.inputs.find((i) => i.record.timeMs === time)?.record.id;
    expect(a.result.diagnostics?.primary?.association.relevantInputIds).toEqual([at(1275)]);
    expect(a.result.diagnostics?.primary?.association.associations).toContainEqual(
      expect.objectContaining({ inputId: at(1210), role: "ambiguous" }),
    );
    expect(b.result.diagnostics?.primary?.association.contextInputIds).toContain(at(1275));
    // The shared cadence fixes1275 as the target attempt: +35ms, after
    // sampled exit1258.793947. The disputed1210 edge is -30ms between
    // two passes. Late tap has positive support with or without that edge;
    // Early tap remains conditional, and neither path proves a landing.
    expect(a.result.status).toBe("supported");
    expect(a.result.headline).toBe("Late tap");
    expect(a.result.diagnostics?.primary?.ranking?.candidates.map(c=>c.code)).toEqual(expect.arrayContaining(["late-tap","early-tap","between-passes"]));
    expect(a.result.diagnostics?.primary?.approaches?.episodes.every(e=>!e.spatialCandidates.length)).toBe(true);
    expect(a.result.eventIds).toEqual(expect.arrayContaining([at(1210),at(1275)]));
    expect(a.result.limitations).toContain("unresolved-stream-input");
  });
  it("retains a subsequent otherwise-valid Notelock without assigning that press twice", () => {
    const f = shiftedReception(0, false, true),
      { evidence, result } = classify(f, "6/HEAD");
    expect(evidence.inputs.find((i) => i.record.timeMs === 1450)).toMatchObject({ inside: true, inLiveSuccess: true });
    expect(evidence.routing).toContainEqual(
      expect.objectContaining({ kind: "policy", componentId: "6/HEAD", state: "rejected", timingResult: "OK" }),
    );
    expect(result.diagnostics?.primary?.association.stream?.phaseAlternatives?.some((a) => a.active)).toBe(true);
    expect(result.headline).toBe("Notelock");
    expect(result.diagnostics?.primary?.association.relevantInputIds).toEqual([]);
  });
  it("does not let unknown actions before the live window veto a fully covered local comparison", () => {
    const f = flowingStream();
    f.trace = JSON.parse(JSON.stringify(f.trace));
    f.trace.domain.initialActionsKnown = false;
    f.trace.domain.sourceCoverageLimits.push("initial-actions-unknown");
    const first = f.trace.records.find((r) => r.kind === "input");
    if (first?.kind !== "input") throw Error("fixture source");
    first.actions = [0];
    first.freshActions = [0];
    const { evidence, result } = classify(f, "3");
    expect(Object.values(evidence.dependencies).every((d) => d.status === "complete")).toBe(true);
    expect(result.headline).toBe("Late tap");
    expect(result.diagnostics?.primary?.ranking?.selected[0].support?.correction).toBeDefined();
  });
});
