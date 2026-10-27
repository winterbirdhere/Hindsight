import { deriveStreamInputEvidence } from "../src/gameplay/error-analysis/StreamInputEvidence";
import { contestedPrimaryPresses } from "../src/gameplay/error-analysis/PrimaryAttribution";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { derivePrimaryInputEvidence } from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { certifyPrimaryOpportunity } from "../src/gameplay/error-analysis/PrimaryOpportunity";

function boundaryFixture(options: { jitter?: number; nextX?: number; nextTime?: number; independentHold?:boolean; relocate?:boolean } = {}) {
  const nextX = options.nextX ?? 280;
  const nextTime = options.nextTime ?? 1240;
  const pressTime = 1200 + (options.jitter ?? 0);
  const knots = [
    [800, 20],
    [1035, 100],
    [1115, 150],
    [1160, 200],
    [pressTime, 240],
    [nextTime, nextX],
    [nextTime + 35, nextX + 20],
    [nextTime + 115, nextX + 80],
    [nextTime + 195, nextX + 160],
    [nextTime + 410, nextX + 200],
  ];
  const taps = [1035, 1115, pressTime, nextTime + 115, nextTime + 195];
  const times = [
    ...new Set([
      ...Array.from({ length: Math.ceil((nextTime + 410 - 800) / 8) + 1 }, (_, i) => 800 + i * 8),
      ...knots.map((p) => p[0]),
      ...taps.map((t) => t + 20),
    ]),
  ].sort((a, b) => a - b);
  const frames = times.map((time) => {
    const at = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1);
    const a = knots[at],
      b = knots[at + 1] ?? a;
    return traceFrame(
      time,
      a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
      [...new Set(taps.flatMap((t, i) => {
        const start=i===2&&options.relocate?1248:t,end=i===2&&options.relocate?1256:i===1&&options.independentHold?1264:t+20;
        return time>=start&&time<end?[i%2]:[];
      }))],
    );
  });
  const fixture = errorFixture(
    `100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,2,0,L|216:192,1,16\n` +
      `${nextX},192,${nextTime},1,0\n${nextX + 80},192,${nextTime + 80},1,0\n${nextX + 160},192,${nextTime + 160},1,0`,
    frames,
  );
  const press = fixture.trace.records.find(
    (r) => r.kind === "input" && r.timeMs === (options.relocate?1248:pressTime) && r.freshActions.length,
  );
  if (!press || press.kind !== "input") throw Error("Missing boundary press");
  return { ...fixture, press };
}

function inspect(f: ReturnType<typeof boundaryFixture>, id: string) {
  const evidence = deriveCircleEvidence(f.trace, f.map, id);
  return { evidence, stream: deriveStreamInputEvidence(evidence, f.map, f.trace) };
}

function singletonBetweenClaims(withClaims: boolean) {
  const knots = [
    [800, 20],
    [1035, 100],
    [1115, 150],
    [1160, 200],
    [1200, 240],
    [1240, 280],
    [1355, 360],
    [1435, 440],
    [1650, 480],
  ];
  const taps = withClaims ? [1115, 1200, 1355, 1435] : [1200];
  const times = [
    ...new Set([
      ...Array.from({ length: 107 }, (_, i) => 800 + i * 8),
      ...knots.map((p) => p[0]),
      ...taps.map((t) => t + 20),
    ]),
  ].sort((a, b) => a - b);
  const frames = times.map((time) => {
    const at = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1);
    const a = knots[at],
      b = knots[at + 1] ?? a;
    return traceFrame(
      time,
      a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
      taps.flatMap((t, i) => (time >= t && time < t + 20 ? [i % 2] : [])),
    );
  });
  const head = "240,240,1200,2,0,L|256:240,1,16";
  const objects = withClaims
    ? "100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,2,0,L|216:192,1,16\n" +
      head +
      "\n280,192,1240,1,0\n360,192,1320,1,0\n440,192,1400,1,0"
    : head;
  const fixture = errorFixture(objects, frames);
  const press = fixture.trace.records.find((r) => r.kind === "input" && r.timeMs === 1200 && r.freshActions.length);
  if (!press || press.kind !== "input") throw Error("Missing singleton input");
  return { ...fixture, press, targetId: withClaims ? "3/HEAD" : "0/HEAD" };
}

describe("M58 stream ownership at a slider/run boundary", () => {
  it.each([false,true])("checks slider-body support separately from circle receipts (independent hold: %s)",independentHold=>{
    const f=boundaryFixture({independentHold}),fixed=boundaryFixture({independentHold,relocate:true}),
      e=deriveCircleEvidence(f.trace,f.map,"3"),sample=e.inputs.find(i=>i.record.timeMs===1248)!;
    expect(f.state.checkPointVerdict["2/0"].hit).toBe(true);
    expect(fixed.state.hitCircleVerdict["3"].type).toBe("GREAT");
    expect(fixed.state.checkPointVerdict["2/0"].hit).toBe(independentHold);
    expect(fixed.state.sliderVerdict["2"]).toBe(independentHold?"OK":"MISS");
    const proof=certifyPrimaryOpportunity(e,f.map,f.trace,f.press.id,[sample.record.id],"sampled-pass-tap",[f.press.id]);
    if(independentHold)expect(proof).toBeDefined();else expect(proof).toBeUndefined();
  });
  it("does not promote explicit competing claims through a singleton nonstream fallback", () => {
    const f = singletonBetweenClaims(true);
    const { evidence, stream } = inspect(f, f.targetId);
    expect(evidence.terminal).toMatchObject({ result: "MISS", mechanism: "automatic-expiry" });
    expect(evidence.inputs.find((i) => i.record.id === f.press.id)).toMatchObject({
      inLiveSuccess: true,
      postTerminal: false,
      freshActionsKnown: true,
      inside: false,
    });
    expect(
      evidence.routing.some(
        (r) =>
          r.kind === "policy" && r.componentId === f.targetId && r.timingResult !== null && r.timingResult !== "MISS",
      ),
    ).toBe(false);
    expect(stream.status).toBe("not-stream");
    const claim = stream.assignments.find((a) => a.inputId === f.press.id);
    expect(claim).toMatchObject({ relation: "ambiguous", confidence: "ambiguous" });
    expect(claim?.competingClaims?.map((c) => c.componentId)).toEqual(expect.arrayContaining(["2/HEAD", "4"]));
    const association = derivePrimaryInputEvidence(evidence, f.map, f.trace);
    expect(association.associations.find((a) => a.inputId === f.press.id)?.role).toBe("ambiguous");
    const diagnosis = classifyCircleLoss(evidence, f.map, f.trace);
    expect(diagnosis.status).toBe("supported");
    expect(diagnosis.headline).toBe("Misaim");
    const primary=diagnosis.diagnostics!.primary!;
    expect((primary.rawOpportunityComparison?.ranking??primary.unconsumedContextComparison?.ranking??primary.ranking)?.selected[0].observationOnly).toBe(true);
  });

  it("retains positive ordinary short-head aim evidence when there are no shared claims", () => {
    const f = singletonBetweenClaims(false);
    const { evidence, stream } = inspect(f, f.targetId);
    expect(stream.status).toBe("not-stream");
    expect(stream.assignments).toEqual([]);
    expect(evidence.inputs.find((i) => i.record.id === f.press.id)).toMatchObject({
      inLiveSuccess: true,
      postTerminal: false,
      freshActionsKnown: true,
      inside: false,
    });
    const association = derivePrimaryInputEvidence(evidence, f.map, f.trace);
    expect(association.associations.find((a) => a.inputId === f.press.id)?.role).toBe("relevant");
    const diagnosis = classifyCircleLoss(evidence, f.map, f.trace);
    expect(diagnosis.status).toBe("supported");
    expect(diagnosis.headline).toBe("Misaim");
  });

  it.each([
    { order: ["2/HEAD", "3"], jitter: 0 },
    { order: ["3", "2/HEAD"], jitter: 0 },
    { order: ["2/HEAD", "3"], jitter: 1 },
    { order: ["3", "2/HEAD"], jitter: 1 },
  ])("does not assign one unconsumed action to two missed receptors (%j)", ({ order, jitter }) => {
    const f = boundaryFixture({ jitter });
    const rows = order.map((id) => inspect(f, id));
    expect(f.press.freshActions).toHaveLength(1);
    expect(rows[0].stream.segmentId).not.toBe(rows[1].stream.segmentId);
    for (const row of rows) {
      expect(row.evidence.terminal).toMatchObject({ result: "MISS", mechanism: "automatic-expiry" });
      expect(Object.values(row.evidence.dependencies).every((d) => d.status === "complete")).toBe(true);
      expect(row.evidence.inputs.find((i) => i.record.id === f.press.id)).toMatchObject({
        inLiveSuccess: true,
        postTerminal: false,
        freshActionsKnown: true,
        inside: false,
      });
    }
    // The slider lasts 80ms and ends exactly when the next circle is scheduled.
    // This is legal overlapping head/circle liveness, not duplicate map objects.
    expect(inspect(f, "2/HEAD").evidence.domains.liveSuccess.end?.timeMs).toBe(1240);
    const owners = new Set(
      rows.flatMap((row) =>
        row.stream.assignments
          .filter((a) => a.inputId === f.press.id && a.relation === "matched")
          .map((a) => a.componentId),
      ),
    );
    expect(owners.size).toBeLessThanOrEqual(1);
    const diagnoses = rows.map((row) => classifyCircleLoss(row.evidence, f.map, f.trace));
    expect(diagnoses.map(d=>d.headline).sort()).toEqual(["Early tap","Late tap"]);
    const entries=diagnoses.map((d,k)=>({targetId:order[k],ranking:(d.diagnostics!.primary!.ranking??d.diagnostics!.primary!.unconsumedContextComparison!.ranking)!}));
    for(const row of entries){expect(row.ranking.selected[0].inputIds).toEqual([f.press.id]);
      expect(row.ranking.selected[0].observationOnly).toBe(row.targetId==="3");}
    expect(contestedPrimaryPresses(entries).every(c=>c.contested&&c.nearestForOtherTargetIds.length===1)).toBe(true);
    // Querying another run must not mutate an already returned assignment table.
    rows.forEach((row, i) => expect(inspect(f, order[i]).stream.assignments).toEqual(row.stream.assignments));
  });

  it.each([
    { nextX: 350, nextTime: 1240 },
    { nextX: 280, nextTime: 1440 },
  ])("keeps unique prior-head ownership when the next run cannot claim the input (%j)", (options) => {
    const f = boundaryFixture(options);
    const next = inspect(f, "3"),
      previous = inspect(f, "2/HEAD");
    expect(previous.evidence.terminal?.result).toBe("MISS");
    expect(previous.stream.relevantInputIds).toContain(f.press.id);
    expect(previous.stream.assignments).toContainEqual(
      expect.objectContaining({
        inputId: f.press.id,
        componentId: "2/HEAD",
        relation: "matched",
        confidence: "corroborated",
      }),
    );
    expect(next.stream.relevantInputIds).not.toContain(f.press.id);
    const owners = new Set(
      [previous, next].flatMap((row) =>
        row.stream.assignments
          .filter((a) => a.inputId === f.press.id && a.relation === "matched")
          .map((a) => a.componentId),
      ),
    );
    expect([...owners]).toEqual(["2/HEAD"]);
  });
});
