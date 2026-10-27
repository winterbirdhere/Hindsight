import { derivePrimaryInputEvidence } from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { parseReplayFramesWithDiagnostics } from "../src/replays/ReplayParser";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";

function ownershipFrames(knots: [number, number][], taps: [number, number[]][], end = 1400) {
  const times = [...new Set([
    ...Array.from({ length: (end - 800) / 10 + 1 }, (_, k) => 800 + k * 10),
    ...knots.map(x => x[0]), ...taps.map(x => x[0]), ...taps.map(x => x[0] + 2),
  ])].sort((a, b) => a - b);
  return times.map(t => {
    const k = knots.findIndex(q => q[0] > t), a = knots[k < 0 ? knots.length - 1 : Math.max(0, k - 1)],
      b = knots[k < 0 ? knots.length - 1 : k], f = (t - a[0]) / Math.max(1, b[0] - a[0]);
    return traceFrame(t, a[1] + (b[1] - a[1]) * f, taps.filter(q => t >= q[0] && t < q[0] + 2).flatMap(q => q[1]));
  });
}
const residualKnots: [number, number][] = [[800,100],[990,100],[1010,150],[1050,300],[1120,500],[1400,500]];
function residualFixture(profile: "stable" | "lazer") {
  return errorFixture("100,192,920,1,0\n300,192,1000,1,0", ownershipFrames(residualKnots, [[990,[0,1]]]), profile);
}

describe("source-backed residual attempt capacity", () => {
  it.each(["stable","lazer"] as const)("keeps an independent %s local proof after a prior source gap",profile=>{
    const f=errorFixture("100,192,920,1,0\n300,192,1000,1,0",[traceFrame(700,100),...ownershipFrames(residualKnots,[[990,[0,1]]])],profile);
    const trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    trace.records.forEach(r=>{if(r.kind==="input"&&r.source.origin==="parsed"){
      r.source.rawTokenIndex=r.source.parsedFrameIndex+(r.timeMs>=800?1:0);
      if(r.timeMs===800)r.source.discontinuityBefore=["source-gap"];
    }});
    const e=deriveCircleEvidence(trace,f.map,"1");expect(Object.values(e.dependencies).every(d=>d.status==="complete")).toBe(true);
    expect(derivePrimaryInputEvidence(e,f.map,trace).associations.some(a=>a.residualAttempts)).toBe(true);
    expect(classifyCircleLoss(e,f.map,trace).headline).toBe("");
  });
  it("withholds a residual slider-head receipt excluded through its parent",()=>{
    const f=errorFixture("100,192,920,2,0,L|100:212,1,20\n300,192,1000,1,0",ownershipFrames(residualKnots,[[990,[0,1]]]));
    const e=deriveCircleEvidence(f.trace,f.map,"1");
    for(const id of ["0","0/HEAD"])expect(derivePrimaryInputEvidence(e,f.map,f.trace,new Set([id])).associations.some(a=>a.residualAttempts)).toBe(false);
  });
  it.each(["receipt-kind","native-action-order"])("rejects %s inconsistent residual provenance",fault=>{
    const f=fault==="receipt-kind"?errorFixture("100,192,920,2,0,L|100:212,1,20\n300,192,1000,1,0",ownershipFrames(residualKnots,[[990,[0,1]]])):residualFixture("lazer");
    const trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    if(fault==="receipt-kind"){const r=trace.records.find(r=>r.kind==="resolution"&&r.componentId==="0/HEAD");if(r?.kind==="resolution")r.component="circle";}
    else trace.records.forEach(r=>{if(r.kind==="attempt"&&r.timeMs===990)r.knownAction=1-r.attemptOrdinal;});
    expect(derivePrimaryInputEvidence(deriveCircleEvidence(trace,f.map,"1"),f.map,trace).associations.some(a=>a.residualAttempts)).toBe(false);
  });
  it.each(["stable", "lazer"] as const)("does not discard the unconsumed second %s attempt", profile => {
    const f = residualFixture(profile), e = deriveCircleEvidence(f.trace, f.map, "1");
    expect(f.state.hitCircleVerdict["0"].type).toBe("MEH");
    expect(e.terminal?.result).toBe("MISS");
    expect(Object.values(e.dependencies).every(d => d.status === "complete")).toBe(true);
    const input = e.inputs.find(i => i.record.timeMs === 990)!;
    const attempts = f.trace.records.filter(r => r.kind === "attempt" && r.inputId === input.record.id);
    expect(attempts.map(a => a.kind === "attempt" && a.attemptOrdinal)).toEqual([0,1]);
    expect(f.trace.records.filter(r => r.kind === "resolution" && r.timeMs === 990)).toHaveLength(1);
    const before = JSON.stringify(f.trace), association = derivePrimaryInputEvidence(e, f.map, f.trace);
    expect(association.relevantInputIds).toEqual([input.record.id]);
    expect(association.associations.find(a => a.inputId === input.record.id)).toMatchObject({
      reasons: ["unconsumed-neighbour-frame-attempt"],
      residualAttempts: { attemptIds: [attempts[1].id], consumedAttemptIds: [attempts[0].id] },
    });
    const diagnosis = classifyCircleLoss(e, f.map, f.trace);
    expect(diagnosis.headline).toBe("");
    const edited = ownershipFrames(residualKnots, [[990,[0,1]]]).map(frame => frame.time === 990 ? traceFrame(990,300,[0,1]) : frame);
    const control = errorFixture("100,192,920,1,0\n300,192,1000,1,0",edited,profile);
    expect(control.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(control.state.hitCircleVerdict["1"].type).toBe(profile === "stable" ? "MISS" : "GREAT");
    expect(JSON.stringify(f.trace)).toBe(before);
  });
  it.each(["stable", "lazer"] as const)("keeps both consumed %s double attempts as context", profile => {
    const f = errorFixture("300,192,1000,1,0\n300,192,1000,1,0\n300,192,1080,1,0",
      ownershipFrames([[800,300],[1400,300]], [[1000,[0,1]]]), profile);
    expect([f.state.hitCircleVerdict["0"].type, f.state.hitCircleVerdict["1"].type, f.state.hitCircleVerdict["2"].type]).toEqual(["GREAT","GREAT","MISS"]);
    const e = deriveCircleEvidence(f.trace, f.map, "2"), a = derivePrimaryInputEvidence(e, f.map, f.trace);
    expect(a.relevantInputIds).toEqual([]);
    expect(a.associations[0].reasons).toEqual(["successful-neighbour-input"]);
    expect(a.associations[0]).not.toHaveProperty("residualAttempts");
  });
  it.each(["missing-ordinal", "duplicate-ordinal", "wrong-candidates", "wrong-known-action", "missing-selection", "invented-policy", "changed-history", "source-gap", "raw-mask"])(
    "does not prove residual capacity with %s", fault => {
      const f = residualFixture("stable"); let trace = JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
      const input = trace.records.find(r => r.kind === "input" && r.timeMs === 990)!;
      if (input.kind !== "input" || input.source.origin !== "parsed") throw Error("source fixture");
      const attempts = trace.records.filter(r => r.kind === "attempt" && r.inputId === input.id);
      const second = attempts[1]; if (second.kind !== "attempt") throw Error("attempt fixture");
      if (fault === "missing-ordinal") trace = { ...trace, records: trace.records.filter(r => r.id !== second.id) };
      if (fault === "duplicate-ordinal") second.attemptOrdinal = 0;
      if (fault === "wrong-candidates") second.actionCandidates = [0];
      if (fault === "wrong-known-action") { second.knownAction = 1; if (attempts[0].kind === "attempt") attempts[0].knownAction = 1; }
      if (fault === "missing-selection") trace = { ...trace, records: trace.records.filter(r => !(r.kind === "selection" && r.attemptId === second.id)) };
      if (fault === "invented-policy") {
        const route = trace.records.find(r => r.kind === "policy" && r.timeMs === 990)!;
        if (route.kind === "policy") route.attemptId = second.id;
      }
      if (fault === "changed-history") input.previousActions = [1];
      if (fault === "source-gap") input.source.discontinuityBefore = ["source-gap"];
      if (fault === "raw-mask") input.rawButtonMask = 5;
      const e = deriveCircleEvidence(trace, f.map, "1"), a = derivePrimaryInputEvidence(e, f.map, trace);
      expect(a.associations.some(a => a.residualAttempts)).toBe(false);
    },
  );
  it.each(["stable", "lazer"] as const)("preserves %s recovery and genuine surplus terminal paths", profile => {
    const recovered = errorFixture("100,192,920,1,0\n300,192,1000,1,0", ownershipFrames(residualKnots, [[990,[0,1]],[1050,[1]]]), profile);
    expect(recovered.state.hitCircleVerdict["1"].type).toBe("OK");
    expect(classifyCircleLoss(deriveCircleEvidence(recovered.trace, recovered.map,"1"), recovered.map, recovered.trace).headline).toBe("Late tap");
    const extra = errorFixture("300,192,1000,1,0\n300,192,1300,1,0",
      ownershipFrames([[800,300],[1400,300]], [[1000,[0]],[1002,[1]],[1280,[0]]]), profile);
    expect(classifyCircleLoss(deriveCircleEvidence(extra.trace,extra.map,"1"),extra.map,extra.trace).headline).toBe("Extra tap");
  });
  it.each(["consumed-input", "consumed-geometry", "consumed-routing", "consumed-lifecycle", "missing-activation", "wrong-offset", "wrong-component", "wrong-position", "previous-mask", "hidden-raw-gap"])(
    "does not borrow a consumed receipt with %s", fault => {
      const f=residualFixture("stable"); let trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
      const input=trace.records.find(r=>r.kind==="input"&&r.timeMs===990)!;
      if(input.kind!=="input"||input.source.origin!=="parsed")throw Error("fixture");
      if(fault.startsWith("consumed-"))trace={...trace,failures:[...trace.failures,"dependency-conflict:"+fault.slice(9)+":0"]};
      if(fault==="missing-activation")trace={...trace,records:trace.records.filter(r=>!(r.kind==="lifecycle"&&r.componentId==="0"))};
      if(fault==="wrong-offset"){const r=trace.records.find(r=>r.kind==="policy"&&r.timeMs===990);if(r?.kind==="policy")r.offsetMs=0;}
      if(fault==="wrong-component"){const r=trace.records.find(r=>r.kind==="selection"&&r.componentId==="0");if(r?.kind==="selection")r.component="slider-head";}
      if(fault==="wrong-position")input.position.x=200;
      if(fault==="previous-mask"){const r=trace.records.find(r=>r.kind==="input"&&r.timeMs===980);if(r?.kind==="input")r.rawButtonMask=15;}
      if(fault==="hidden-raw-gap"){
        trace.records.forEach(r=>{if(r.kind==="input"&&r.source.origin==="parsed"){r.source.rawTokenIndex=r.source.parsedFrameIndex;if(r.timeMs===980)delete r.source.rawTokenIndex;}});
        input.source.rawTokenIndex!++;
      }
      const e=deriveCircleEvidence(trace,f.map,"1");
      expect(derivePrimaryInputEvidence(e,f.map,trace).associations.some(a=>a.residualAttempts)).toBe(false);
    },
  );
});

const pressAt = (trace: ReplayTrace, time: number) => {
  const input = trace.records.find((r) => r.kind === "input" && r.timeMs === time && r.freshActions.length);
  if (!input) throw Error(`Missing source press ${time}`);
  return input.id;
};
function surplus(options: { replacement?: boolean; prior?: boolean; delay?: number; duplicated?: boolean } = {}) {
  return errorFixture("300,192,1000,1,0\n300,192,1300,1,0", [
    traceFrame(800),
    traceFrame(1000, 300, options.prior === false ? [] : [1], 10),
    traceFrame(1000 + (options.delay ?? 2), 300, options.duplicated ? [1] : [0, 1], 15),
    traceFrame(1050),
    traceFrame(1280, 300, options.replacement === false ? [] : [1], 10),
    traceFrame(1500),
  ]);
}
function inspect(fixture: ReturnType<typeof errorFixture>, target = "1", trace = fixture.trace) {
  const evidence = deriveCircleEvidence(trace, fixture.map, target);
  return { evidence, result: derivePrimaryInputEvidence(evidence, fixture.map, trace) };
}
function completedNeighbour(options: { x?: number; delay?: number; reversal?: boolean; targetX?: number } = {}) {
  const frames = [traceFrame(700, 0), traceFrame(910, 100), traceFrame(933, 130, [0])];
  if (options.reversal) frames.push(traceFrame(937, 135, [0]));
  frames.push(
    traceFrame(933 + (options.delay ?? 9), options.x ?? 150, [0, 1]),
    traceFrame(980, 220),
    traceFrame(1005, 330),
    traceFrame(1028, options.targetX ?? 400),
    traceFrame(1060, 450, [1]),
    traceFrame(1300, 500),
  );
  return errorFixture(`100,192,900,1,0\n${options.targetX ?? 400},192,1028,1,0`, frames);
}

describe("primary input association and positive harmful surplus", () => {
  it.each([
    [132, "completed-neighbour-footprint"],
    [150, "completed-neighbour-departure"],
  ])("keeps a continuous completed neighbour episode at x%s as context", (x, reason) => {
    const fixture = completedNeighbour({ x: x as number });
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("OK");
    expect(fixture.state.hitCircleVerdict["1"].type).toBe("MISS");
    const { result } = inspect(fixture);
    const prior = fixture.trace.records.find((r) => r.kind === "resolution" && r.componentId === "0");
    const early = pressAt(fixture.trace, 942);
    expect(result.relevantInputIds).toEqual([pressAt(fixture.trace, 1060)]);
    expect(result.associations.find((a) => a.inputId === early)).toMatchObject({
      role: "context",
      reasons: [reason],
      neighbour: { componentId: "0", provenance: "sampled" },
    });
    expect(result.associations.find((a) => a.inputId === early)?.eventIds).toEqual(
      expect.arrayContaining([pressAt(fixture.trace, 933), prior?.id, early]),
    );
    expect(result.harmfulSurplus).toBeUndefined();
    const priorEvidence = deriveCircleEvidence(fixture.trace, fixture.map, "0");
    expect(priorEvidence.inputs.find((i) => i.record.id === early)).toMatchObject({
      postTerminal: true,
      inLiveSuccess: false,
    });
  });

  it.each([
    [24, true],
    [25, true],
    [26, false],
  ])("bounds completed-neighbour departure by the OD9 best window at %sms", (delay, contextual) => {
    // The independent OD9 GREAT half-width is 25ms; this is not an unlimited prior-note association.
    const fixture = completedNeighbour({ delay: delay as number });
    const input = pressAt(fixture.trace, 933 + (delay as number));
    expect(inspect(fixture).result.contextInputIds.includes(input)).toBe(contextual);
  });

  it.each([
    [36, true],
    [37, false],
  ])("bounds accumulated departure distance at %spx (CS4 radius≈36.495px)", (distance, contextual) => {
    const fixture = completedNeighbour({ x: 130 + (distance as number) });
    expect(inspect(fixture).result.contextInputIds.includes(pressAt(fixture.trace, 942))).toBe(contextual);
  });

  it("retains a return/correction after successful contact", () => {
    const fixture = completedNeighbour({ x: 132, reversal: true });
    expect(inspect(fixture).result.relevantInputIds).toContain(pressAt(fixture.trace, 942));
  });

  it("retains overlap and a rapid actual current-target action", () => {
    const overlap = completedNeighbour({ x: 50, targetX: 150 });
    expect(inspect(overlap).result.relevantInputIds).toContain(pressAt(overlap.trace, 942));
    const current = completedNeighbour({ x: 400 });
    expect(current.state.hitCircleVerdict["1"].type).toBe("MEH");
    expect(inspect(current).result.relevantInputIds).toContain(pressAt(current.trace, 942));
  });

  it("does not establish completed-neighbour continuity through a source gap", () => {
    const fixture = completedNeighbour();
    const changed = JSON.parse(JSON.stringify(fixture.trace)) as ReplayTrace;
    const input = changed.records.find((r) => r.kind === "input" && r.timeMs === 942);
    if (input?.kind !== "input" || input.source.origin !== "parsed") throw Error("fixture source");
    input.source.discontinuityBefore = ["test-gap"];
    expect(inspect(fixture, "1", changed).result.contextInputIds).not.toContain(input.id);
  });

  it("recognizes a missed previous note's sampled local pass using geometry and phase together", () => {
    const fixture = errorFixture("100,192,900,1,0\n300,192,1010,1,0", [
      traceFrame(700, 0),
      traceFrame(850, 50),
      traceFrame(880, 100),
      traceFrame(910, 150, [0]),
      traceFrame(950, 220),
      traceFrame(990, 280),
      traceFrame(1010, 300),
      traceFrame(1040, 350, [1]),
      traceFrame(1250, 400),
    ]);
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(fixture.state.hitCircleVerdict["1"].type).toBe("MISS");
    const { result } = inspect(fixture);
    expect(result.relevantInputIds).toEqual([pressAt(fixture.trace, 1040)]);
    expect(result.associations.find((a) => a.inputId === pressAt(fixture.trace, 910))).toMatchObject({
      role: "context",
      reasons: ["neighbour-local-approach"],
      neighbour: { componentId: "0", direction: "earlier" },
    });
  });

  it("recognizes a missed downstream note's source approach without requiring a receptor selection", () => {
    const fixture = errorFixture("100,192,900,1,0\n300,192,1010,1,0", [
      traceFrame(700, 0),
      traceFrame(880, 50, [0]),
      traceFrame(890, 80),
      traceFrame(900, 100),
      traceFrame(940, 180),
      traceFrame(980, 230),
      traceFrame(990, 250, [1]),
      traceFrame(1000, 300),
      traceFrame(1300, 500),
    ]);
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(fixture.state.hitCircleVerdict["1"].type).toBe("MISS");
    const { result } = inspect(fixture, "0");
    expect(result.relevantInputIds).toEqual([pressAt(fixture.trace, 880)]);
    expect(result.associations.find((a) => a.inputId === pressAt(fixture.trace, 990))).toMatchObject({
      role: "context",
      reasons: ["neighbour-local-approach"],
      neighbour: { componentId: "1", direction: "later" },
    });
  });

  it("keeps genuine early and late attempts around the same isolated target pass", () => {
    const fixture = errorFixture("300,192,1000,1,0", [
      traceFrame(800, 100),
      traceFrame(930, 230),
      traceFrame(950, 250, [0]),
      traceFrame(970, 270),
      traceFrame(1000, 300),
      traceFrame(1040, 340, [1]),
      traceFrame(1200, 500),
    ]);
    expect(inspect(fixture, "0").result.relevantInputIds).toEqual([
      pressAt(fixture.trace, 950),
      pressAt(fixture.trace, 1040),
    ]);
  });

  it("does not use beat phase alone to disambiguate overlapping target approaches", () => {
    const fixture = errorFixture("100,192,900,1,0\n120,192,1010,1,0", [
      traceFrame(700, 0),
      traceFrame(850, 80),
      traceFrame(880, 100),
      traceFrame(910, 50, [0]),
      traceFrame(950, 80),
      traceFrame(990, 100),
      traceFrame(1010, 120),
      traceFrame(1040, 170, [1]),
      traceFrame(1250, 220),
    ]);
    expect(inspect(fixture).result.relevantInputIds).toEqual([
      pressAt(fixture.trace, 910),
      pressAt(fixture.trace, 1040),
    ]);
  });

  it("does not discard a spatially better target attempt just because its neighbour is closer in time", () => {
    const fixture = errorFixture("100,192,940,1,0\n300,192,1000,1,0", [
      traceFrame(700, 0),
      traceFrame(900, 100),
      traceFrame(930, 200),
      traceFrame(950, 250, [0]),
      traceFrame(970, 270),
      traceFrame(1000, 300),
      traceFrame(1250, 400),
    ]);
    expect(inspect(fixture).result.relevantInputIds).toContain(pressAt(fixture.trace, 950));
  });

  it("does not discard a better-timed target attempt just because its neighbour is spatially closer", () => {
    const fixture = errorFixture("100,192,900,1,0\n300,192,1010,1,0", [
      traceFrame(700, 0),
      traceFrame(880, 100),
      traceFrame(970, 150),
      traceFrame(1000, 150, [0]),
      traceFrame(1010, 300),
      traceFrame(1250, 400),
    ]);
    expect(inspect(fixture).result.relevantInputIds).toContain(pressAt(fixture.trace, 1000));
  });

  it("requires the neighbouring component's own geometry/lifecycle evidence to be conflict-free", () => {
    const fixture = errorFixture("100,192,900,1,0\n300,192,1010,1,0", [
      traceFrame(700, 0),
      traceFrame(850, 50),
      traceFrame(880, 100),
      traceFrame(910, 150, [0]),
      traceFrame(950, 220),
      traceFrame(990, 280),
      traceFrame(1010, 300),
      traceFrame(1040, 350, [1]),
      traceFrame(1250, 400),
    ]);
    const trace = {
      ...fixture.trace,
      domain: {
        ...fixture.trace.domain,
        sourceCoverageLimits: [...fixture.trace.domain.sourceCoverageLimits, "dependency-conflict:geometry:0"],
      },
    };
    expect(inspect(fixture, "1", trace).result.relevantInputIds).toEqual([pressAt(trace, 910), pressAt(trace, 1040)]);
  });

  it("separates successful previous and downstream blocked inputs from the target's misplaced press", () => {
    const fixture = errorFixture("100,192,900,1,0\n300,192,1000,1,0\n500,192,1100,1,0", [
      traceFrame(800, 100),
      traceFrame(900, 100, [0]),
      traceFrame(950, 240),
      traceFrame(1000, 250, [1]),
      traceFrame(1001, 250),
      traceFrame(1100, 500, [0]),
      traceFrame(1300, 500),
    ]);
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(fixture.state.hitCircleVerdict["1"].type).toBe("MISS");
    const { result } = inspect(fixture);
    expect(result.relevantInputIds).toEqual([pressAt(fixture.trace, 1000)]);
    expect(result.contextInputIds).toEqual([pressAt(fixture.trace, 900), pressAt(fixture.trace, 1100)]);
    expect(result.associations.map((a) => a.reasons)).toContainEqual(["successful-neighbour-input"]);
    expect(result.associations.map((a) => a.reasons)).toContainEqual(["neighbour-local-approach"]);
    expect(result.associations.find((a) => a.inputId === pressAt(fixture.trace, 1100))?.neighbour).toBeDefined();
  });

  it("keeps directly valid rejected input relevant while the target blocks later attempts only as context", () => {
    const fixture = errorFixture("100,192,1000,1,0\n300,192,1050,1,0", [
      traceFrame(900, 100),
      traceFrame(1030, 300, [0]),
      traceFrame(1300, 300),
    ]);
    const { result } = inspect(fixture);
    expect(result.relevantInputIds).toEqual([pressAt(fixture.trace, 1030)]);
    expect(result.associations[0].reasons).toEqual(["otherwise-valid-target-policy"]);
    expect(result.harmfulSurplus).toBeUndefined();
  });

  it("does not borrow a successful neighbour input solely because the circles overlap", () => {
    const fixture = errorFixture("300,192,1000,1,0\n300,192,1050,1,0", [
      traceFrame(900),
      traceFrame(1050, 300, [0]),
      traceFrame(1300),
    ]);
    const { result } = inspect(fixture);
    expect(result.relevantInputIds).toEqual([]);
    expect(result.contextInputIds).toEqual([pressAt(fixture.trace, 1050)]);
    expect(result.associations[0].reasons).toEqual(["successful-neighbour-input"]);
  });

  it("keeps a valid earlier-neighbour attempt as context even when that neighbour was itself blocked", () => {
    const fixture = errorFixture("100,192,950,1,0\n300,192,1000,1,0\n500,192,1050,1,0", [
      traceFrame(800, 100),
      traceFrame(1000, 300, [0]),
      traceFrame(1020, 500),
      traceFrame(1050, 500, [1]),
      traceFrame(1300, 500),
    ]);
    const { result } = inspect(fixture, "2");
    expect(result.relevantInputIds).toEqual([pressAt(fixture.trace, 1050)]);
    expect(result.associations.find((a) => a.inputId === pressAt(fixture.trace, 1000))).toMatchObject({
      role: "context",
      reasons: ["neighbour-local-approach"],
    });
  });

  it("proves a surplus edge requires an earlier successful neighbour and a separate valid replacement", () => {
    const fixture = surplus(),
      before = normalizeTraceState({ state: fixture.state, trace: fixture.trace, inventory: fixture.inventory });
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(fixture.state.hitCircleVerdict["1"].type).toBe("MISS");
    const { result, evidence } = inspect(fixture);
    expect(result.harmfulSurplus).toMatchObject({
      inputId: pressAt(fixture.trace, 1002),
      precedingSuccessInputId: pressAt(fixture.trace, 1000),
      replacementInputId: pressAt(fixture.trace, 1280),
      replacementScope: "post-terminal-counterfactual",
    });
    expect(result.relevantInputIds).toEqual([pressAt(fixture.trace, 1002)]);
    expect(result.contextInputIds).toContain(pressAt(fixture.trace, 1280));
    expect(evidence.inputs.find((i) => i.record.id === result.harmfulSurplus?.replacementInputId)).toMatchObject({
      postTerminal: true,
      inLiveSuccess: false,
    });
    expect(normalizeTraceState({ state: fixture.state, trace: fixture.trace, inventory: fixture.inventory })).toEqual(
      before,
    );
    // Diagnostic intervention is a separate fixture, never a classifier mutation.
    const repaired = errorFixture("300,192,1000,1,0\n300,192,1300,1,0", [
      traceFrame(800),
      traceFrame(1000, 300, [1]),
      traceFrame(1002, 300, [1]),
      traceFrame(1050),
      traceFrame(1280, 300, [1]),
      traceFrame(1500),
    ]);
    expect(repaired.state.hitCircleVerdict["0"]).toEqual(fixture.state.hitCircleVerdict["0"]);
    expect(repaired.state.hitCircleVerdict["1"].type).toBe("GREAT");
  });

  it("recognizes adjacent fresh edges across a release while the surplus key is still held", () => {
    const frames = [traceFrame(800), traceFrame(1000, 300, [1]), traceFrame(1006),
      traceFrame(1011, 300, [0]), traceFrame(1050, 300, [0]), traceFrame(1280, 300, [0, 1]), traceFrame(1500)];
    const fixture = errorFixture("300,192,1000,1,0\n300,192,1300,1,0", frames);
    const { result, evidence } = inspect(fixture);
    expect(result.harmfulSurplus).toMatchObject({
      precedingSuccessInputId: pressAt(fixture.trace, 1000),
      inputId: pressAt(fixture.trace, 1011), replacementInputId: pressAt(fixture.trace, 1280),
    });
    expect(classifyCircleLoss(evidence, fixture.map, fixture.trace).headline).toBe("Extra tap");
    const repaired = errorFixture("300,192,1000,1,0\n300,192,1300,1,0",
      frames.map(f => f.time >= 1011 && f.time < 1500 ? { ...f, actions: f.actions.filter(a => a !== 0) } : f));
    expect(repaired.state.hitCircleVerdict["0"]).toEqual(fixture.state.hitCircleVerdict["0"]);
    expect(repaired.state.hitCircleVerdict["1"].type).toBe("GREAT");
  });

  it("does not bridge a source gap in the release separating a surplus cluster", () => {
    const fixture = errorFixture("300,192,1000,1,0\n300,192,1300,1,0", [
      traceFrame(800), traceFrame(1000, 300, [1]), traceFrame(1006), traceFrame(1011, 300, [0]),
      traceFrame(1050, 300, [0]), traceFrame(1280, 300, [0, 1]), traceFrame(1500),
    ]);
    const trace = JSON.parse(JSON.stringify(fixture.trace)) as ReplayTrace;
    const release = trace.records.find(r => r.kind === "input" && r.timeMs === 1006);
    if (release?.kind !== "input" || release.source.origin !== "parsed") throw Error("release source");
    release.source.discontinuityBefore = ["source-gap"];
    expect(inspect(fixture, "1", trace).result.harmfulSurplus).toBeUndefined();
  });

  it("does not skip an intervening air press to manufacture a surplus cluster", () => {
    const fixture = errorFixture("300,192,1000,1,0\n300,192,1300,1,0", [
      traceFrame(800), traceFrame(1000, 300, [1]), traceFrame(1003), traceFrame(1004, 0, [0]),
      traceFrame(1006, 0), traceFrame(1011, 300, [0]), traceFrame(1280, 300, [0, 1]), traceFrame(1500),
    ]);
    expect(inspect(fixture).result.harmfulSurplus).toBeUndefined();
  });

  it.each(["prior-gap", "prior-history", "prior-mask", "release-history", "raw-gap"])(
    "requires source-valid edges across the whole surplus cluster: %s", fault => {
      const fixture=errorFixture("300,192,1000,1,0\n300,192,1300,1,0",[
        traceFrame(800),traceFrame(1000,300,[1]),traceFrame(1006),traceFrame(1011,300,[0]),
        traceFrame(1050,300,[0]),traceFrame(1280,300,[0,1]),traceFrame(1500)]);
      const trace=JSON.parse(JSON.stringify(fixture.trace)) as ReplayTrace;
      const prior=trace.records.find(r=>r.kind==="input"&&r.timeMs===1000),
        release=trace.records.find(r=>r.kind==="input"&&r.timeMs===1006);
      if(prior?.kind!=="input"||release?.kind!=="input"||prior.source.origin!=="parsed"||release.source.origin!=="parsed")throw Error("source");
      if(fault==="prior-gap")prior.source.discontinuityBefore=["test-gap"];
      if(fault==="prior-history")prior.previousActions=[1];
      if(fault==="prior-mask")prior.rawButtonMask=0;
      if(fault==="release-history")release.previousActions=[];
      if(fault==="raw-gap")release.source.rawTokenIndex=100;
      expect(inspect(fixture,"1",trace).result.harmfulSurplus).toBeUndefined();
    });

  it("does not take a replacement already consumed by the following note", () => {
    const fixture = errorFixture("300,192,1000,1,0\n300,192,1300,1,0\n300,192,1400,1,0", [
      traceFrame(800), traceFrame(1000, 300, [1]), traceFrame(1006), traceFrame(1011, 300, [0]),
      traceFrame(1050, 300, [0]), traceFrame(1380, 300, [0, 1]), traceFrame(1600),
    ]);
    expect(fixture.state.hitCircleVerdict["2"].type).toBe("GREAT");
    expect(inspect(fixture).result.harmfulSurplus).toBeUndefined();
  });

  it.each([
    ["without later replacement", { replacement: false }],
    ["without successful neighbouring action", { prior: false }],
    ["ordinary separately timed premature action", { delay: 50 }],
    ["same-time input grouping", { delay: 0 }],
    ["logical-mask duplication without a fresh edge", { duplicated: true }],
  ])("does not label Extra tap %s", (_name, options) => {
    expect(inspect(surplus(options as Parameters<typeof surplus>[0])).result.harmfulSurplus).toBeUndefined();
  });

  it.each([
    [12, true],
    [13, false],
  ])("applies the declared OD9 half-best-window cluster bound at %sms", (delay, supported) => {
    // Stable OD9 GREAT half-width is 25 map ms; the cluster admits at most12.5.
    // The 300ms inter-note interval gives a looser37.5ms eighth-rhythm bound.
    expect(Boolean(inspect(surplus({ delay: delay as number })).result.harmfulSurplus)).toBe(supported);
  });

  it.each([
    [
      "rapid valid notes",
      "300,192,1000,1,0\n300,192,1002,1,0",
      [traceFrame(800), traceFrame(1000, 300, [1]), traceFrame(1002, 300, [0, 1]), traceFrame(1300)],
    ],
    [
      "legitimate simultaneous notes",
      "300,192,1000,1,0\n300,192,1000,1,0",
      [traceFrame(800), traceFrame(1000, 300, [0, 1]), traceFrame(1300)],
    ],
  ])("does not call %s surplus", (_name, objects, frames) => {
    const fixture = errorFixture(objects as string, frames as ReturnType<typeof traceFrame>[]);
    expect(fixture.state.hitCircleVerdict["1"].type).toBe("GREAT");
    expect(inspect(fixture).result.harmfulSurplus).toBeUndefined();
  });

  it("does not promote post-terminal replacement to a live missed opportunity", () => {
    const fixture = surplus(),
      { result } = inspect(fixture);
    expect(result.associations.find((a) => a.inputId === pressAt(fixture.trace, 1280))).toMatchObject({
      role: "context",
      reasons: ["post-terminal-input"],
    });
  });

  it("uses decoded logical edges rather than counting physical mask changes as extra taps", () => {
    const parsed = parseReplayFramesWithDiagnostics(
      "800|300|192|0,200|300|192|1,2|300|192|5,48|300|192|0,230|300|192|10,220|300|192|0,",
    );
    expect(parsed.frames[1].actions).toEqual(parsed.frames[2].actions);
    const fixture = errorFixture("300,192,1000,1,0\n300,192,1300,1,0", parsed.frames);
    const duplicate = fixture.trace.records.find((r) => r.kind === "input" && r.timeMs === 1002);
    expect(duplicate).toMatchObject({ freshActions: [], rawButtonMask: 5 });
    expect(fixture.state.hitCircleVerdict["1"].type).toBe("GREAT");
    expect(inspect(fixture).result.harmfulSurplus).toBeUndefined();
  });

  it("retains limitations and refuses surplus on a capture beyond its declared bound", () => {
    const fixture = surplus(),
      evidence = deriveCircleEvidence(fixture.trace, fixture.map, "1");
    const bounded = { ...fixture.trace, limits: { ...fixture.trace.limits, maxRecords: 1 } };
    const result = derivePrimaryInputEvidence(evidence, fixture.map, bounded);
    expect(result.harmfulSurplus).toBeUndefined();
    expect(result.limitations).toEqual(expect.arrayContaining([...evidence.limitations, "invalid-trace-index"]));
  });

  it("requires source continuity through the replacement and matching full-trace identity", () => {
    const fixture = surplus();
    const changed = JSON.parse(JSON.stringify(fixture.trace)) as ReplayTrace;
    const input = changed.records.find((r) => r.kind === "input" && r.timeMs === 1050);
    if (input?.kind !== "input" || input.source.origin !== "parsed") throw Error("fixture source");
    input.source.discontinuityBefore = ["test-gap"];
    expect(inspect(fixture, "1", changed).result.harmfulSurplus).toBeUndefined();
    const evidence = deriveCircleEvidence(fixture.trace, fixture.map, "1");
    const mismatched = { ...fixture.trace, identity: { ...fixture.trace.identity, generationKey: "different-source" } };
    expect(derivePrimaryInputEvidence(evidence, fixture.map, mismatched).limitations).toContain(
      "trace-identity-mismatch",
    );
    expect(derivePrimaryInputEvidence(evidence, fixture.map).harmfulSurplus).toBeUndefined();
  });
});
