import { deriveStreamInputEvidence } from "../src/gameplay/error-analysis/StreamInputEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

// Independent sequence: three successful -30ms taps, an early circle tap,
// then the next scheduled tap while the cursor is still approaching the head.
// At that final press it is >2R away; the uninterrupted approach arrives 30ms later.
function forward(
  options: {
    native?: boolean;
    late?: boolean;
    extra?: boolean;
    turn?: boolean;
    double?: boolean;
    bridge?: boolean;
    contactTap?: boolean;
  } = {},
) {
  const knots = [
    [800, 40, 100],
    [970, 100, 100],
    [1084, 160, 100],
    [1198, 220, 100],
    [1306, 220, 100],
    [1342, 280, 100],
    [1400, 310, 140],
    [1430, 320, 192],
    ...(options.turn ? [[1440, 310, 192]] : []),
    [options.late ? 1540 : 1460, 420, 192],
    ...(options.bridge
      ? [
          [1510, 420, 192],
          [1570, 480, 300],
        ]
      : []),
    [1800, 420, 192],
  ];
  const taps = [
    970,
    1084,
    1198,
    1306,
    1430,
    ...(options.extra ? [1440] : []),
    ...(options.contactTap ? [1450] : []),
    ...(options.bridge ? [1570] : []),
  ];
  const times = [
    ...new Set([
      ...Array.from({ length: 201 }, (_, i) => 800 + i * 5),
      ...knots.map((p) => p[0]),
      ...taps,
      ...taps.map((t) => t + 15),
    ]),
  ].sort((a, b) => a - b);
  const frames = times.map((time) => {
    const at = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1),
      a = knots[at],
      b = knots[at + 1] ?? a;
    const f = (time - a[0]) / Math.max(1, b[0] - a[0]);
    const actions = taps.flatMap((t, i) => (time >= t && time < t + 15 ? [i % 2] : []));
    if (options.double && time >= 1430 && time < 1445) actions.push(1);
    return {
      ...traceFrame(time, a[1] + (b[1] - a[1]) * f, actions),
      position: { x: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f },
    };
  });
  return errorFixture(
    "100,100,1000,1,0\n160,100,1114,1,0\n220,100,1228,1,0\n280,100,1342,1,0\n420,192,1456,2,0,L|500:192,1,80" +
      (options.bridge ? "\n480,300,1570,1,0" : ""),
    frames,
    options.native ? "lazer" : "stable",
  );
}
function inspect(f: ReturnType<typeof forward>, id = "4/HEAD", trace = f.trace) {
  const evidence = deriveCircleEvidence(trace, f.map, id);
  return {
    evidence,
    stream: deriveStreamInputEvidence(evidence, f.map, trace),
    cause: classifyCircleLoss(evidence, f.map, trace),
  };
}
describe("bounded forward approach corroborates a cadence press", () => {
  it.each([false, true])(
    "assigns a far but arriving head press without poisoning the preceding circle (native=%s)",
    (native) => {
      const f = forward({ native }),
        head = inspect(f),
        circle = inspect(f, "3");
      const press = head.evidence.inputs.find((i) => i.record.timeMs === 1430)!.record;
      expect(head.evidence.inputs.find((i) => i.record.id === press.id)).toMatchObject({
        inside: false,
        inLiveSuccess: true,
        freshActionsKnown: true,
      });
      expect(head.stream.assignments.find((a) => a.inputId === press.id)).toMatchObject({
        componentId: "4/HEAD",
        relation: "matched",
        basis: "cadence",
        offsetMs: -26,
      });
      expect(head.stream.relevantInputIds).toEqual([press.id]);
      expect(circle.stream.contextInputIds).toContain(press.id);
      expect(circle.cause).toMatchObject({ status: "supported", headline: "Early tap" });
      expect(circle.cause.diagnostics?.primary?.ranking?.attribution?.presses[0]).toMatchObject({ tapFeasible: true, aimFeasible: true });
      expect(circle.cause.diagnostics?.primary?.ranking?.selected[0].attribution?.tapOffsetMs).toBe(-36);
      expect(circle.cause.diagnostics?.primary?.ranking?.selected[0].observationOnly).toBe(native);
      expect(head.cause.status).toBe("supported");
      expect(head.cause.codes).not.toContain("no-tap");
      const row = head.stream.assignments.find((a) => a.inputId === press.id)!;
      expect(row.geometry!.eventIds.some((id) => f.trace.records.find((r) => r.id === id)!.timeMs > 1430)).toBe(true);
    },
  );
  it.each(["late", "extra", "turn", "double", "contactTap"] as const)(
    "does not borrow future contact with %s",
    (kind) => {
      const f = forward({ [kind]: true }),
        { evidence, stream } = inspect(f);
      const id = evidence.inputs.find((i) => i.record.timeMs === 1430)!.record.id;
      expect(
        stream.assignments.find((a) => a.inputId === id && a.componentId === "4/HEAD" && a.basis === "cadence"),
      ).toBeUndefined();
    },
  );
  it("rejects a discontinuity before contact", () => {
    const f = forward();
    const trace = {
      ...f.trace,
      records: f.trace.records.map((r) =>
        r.kind === "input" && r.timeMs === 1445
          ? { ...r, source: { ...r.source, discontinuityBefore: ["parser-negative-delta" as const] } }
          : r,
      ),
    };
    expect(inspect(f, "4/HEAD", trace).stream.status).toBe("unavailable");
  });
  it("retains identical ownership when neighbours are queried in reverse order", () => {
    const f = forward(),
      expected = inspect(f).stream;
    inspect(f, "3");
    inspect(f, "0");
    expect(inspect(f).stream).toEqual(expected);
  });
  it("preserves every forward-contact witness used to corroborate a two-sided bridge", () => {
    const f = forward({ bridge: true }),
      { stream } = inspect(f, "3");
    const assignment = stream.assignments.find((a) => a.componentId === "3" && a.recoveryContext);
    expect(assignment).toBeDefined();
    const head = stream.assignments.find(
      (a) => a.componentId === "4/HEAD" && (a.geometry?.closestTimeMs ?? -Infinity) > 1430,
    )!;
    expect(head).toBeDefined();
    for (const id of head.geometry!.eventIds) expect(assignment!.eventIds).toContain(id);
  });
  it("does not use contact after a recorded terminal boundary", () => {
    const f = forward(),
      end = f.trace.records.find((r) => r.kind === "resolution" && r.componentId === "4/HEAD")!;
    const at = f.trace.records.find((r) => r.kind === "input" && r.timeMs === 1440)!;
    const trace = {
      ...f.trace,
      records: f.trace.records.map((r) => (r.id === end.id ? { ...r, timeMs: 1440, sequence: at.sequence + 1 } : r)),
    };
    const { stream } = inspect(f, "4/HEAD", trace),
      id = f.trace.records.find((i) => i.kind === "input" && i.timeMs === 1430)!.id;
    expect(
      stream.assignments.find((a) => a.inputId === id && a.componentId === "4/HEAD" && a.basis === "cadence"),
    ).toBeUndefined();
  });
});
