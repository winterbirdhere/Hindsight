import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { derivePairedCapacityChain, stableCirclePacket } from "../src/gameplay/error-analysis/PairedCapacityChain";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";

const circles = [
    [20, 200],
    [40, 300],
    [60, 400],
    [80, 500],
    [100, 600],
    [125, 700],
    [160, 800],
    [180, 900],
    [200, 1000],
    [240, 1100],
    [270, 1200],
    [300, 1300],
  ],
  objects = circles.map(([x, t]) => `${x},192,${t},1,0`).join("\n");
function frames() {
  const knots = [
      [0, 500, 0],
      [150, 30, 0],
      [200, 30, 3],
      [210, 30, 0],
      [350, 70, 0],
      [400, 70, 3],
      [410, 70, 0],
      [550, 112.5, 0],
      [600, 112.5, 3],
      [610, 112.5, 0],
      [750, 170, 0],
      [800, 170, 3],
      [810, 170, 0],
      [900, 200, 0],
      [1000, 200, 1],
      [1005, 200, 3],
      [1100, 240, 3],
      [1110, 240, 3],
      [1120, 240, 1],
      [1150, 270, 0],
      [1200, 270, 3],
      [1210, 270, 3],
      [1500, 300, 0],
    ],
    times = [...new Set([...Array.from({ length: 61 }, (_, i) => i * 25), ...knots.map((k) => k[0])])].sort(
      (a, b) => a - b,
    );
  return times.map((t) => {
    const i = knots.findIndex((_, j) => j === knots.length - 1 || knots[j + 1][0] > t),
      a = knots[i],
      b = knots[i + 1] ?? a,
      x = a[1] + (b[1] - a[1]) * (b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]));
    return traceFrame(t, x, [...(a[2] & 1 ? [0] : []), ...(a[2] & 2 ? [1] : [])], a[2] === 3 ? 15 : a[2] === 1 ? 5 : 0);
  });
}
describe("paired cadence and unchanged dispatch capacity", () => {
  it("reuses sealed trace integrity and extracts packets without repeated full-trace scans", () => {
    const f = errorFixture(objects, frames());
    const input = f.trace.records.find((r) => r.kind === "input" && r.timeMs === 1200);
    if (!input || input.kind !== "input") throw new Error("Missing paired input");
    const evidence = deriveCircleEvidence(f.trace, f.map, "11");
    const expected = stableCirclePacket(f.trace, input);
    derivePairedCapacityChain(evidence, f.map, f.trace);
    let scans = 0;
    const filter = Array.prototype.filter,
      some = Array.prototype.some;
    const filterSpy = jest
      .spyOn(Array.prototype, "filter")
      .mockImplementation(function (this: unknown[], callback, thisArg) {
        if (this === f.trace.records) scans++;
        return filter.call(this, callback, thisArg);
      });
    const someSpy = jest
      .spyOn(Array.prototype, "some")
      .mockImplementation(function (this: unknown[], callback, thisArg) {
        if (this === f.trace.records) scans++;
        return some.call(this, callback, thisArg);
      });
    try {
      const actual = stableCirclePacket(f.trace, input);
      expect(actual).toEqual(expected);
      derivePairedCapacityChain(evidence, f.map, f.trace);
      expect(scans).toBe(0);
      actual?.[0].eventIds.splice(0);
      expect(stableCirclePacket(f.trace, input)).toEqual(expected);
    } finally {
      filterSpy.mockRestore();
      someSpy.mockRestore();
    }
  });

  it("keeps mutable and shallow-frozen diagnostic packet checks fresh", () => {
    const f = errorFixture(objects, frames());
    const trace = JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    const input = trace.records.find((r) => r.kind === "input" && r.timeMs === 1200);
    if (!input || input.kind !== "input") throw new Error("Missing paired input");
    const expected = stableCirclePacket(trace, input);
    expect(expected).toHaveLength(2);
    Object.freeze(trace);
    const attempt = expected![0].attempt;
    const ordinal = attempt.attemptOrdinal;
    attempt.attemptOrdinal = 4;
    expect(stableCirclePacket(trace, input)).toBeUndefined();
    attempt.attemptOrdinal = ordinal;
    expect(stableCirclePacket(trace, input)).toEqual(expected);
  });
  it("rechecks full sequence integrity on a warmed foreign trace", () => {
    const f = errorFixture(objects, frames()),
      trace = JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    Object.freeze(trace);
    const evidence = deriveCircleEvidence(trace, f.map, "11");
    const expected = derivePairedCapacityChain(evidence, f.map, trace);
    expect(expected).toBeDefined();
    const record = trace.records[0],
      sequence = record.sequence,
      timeMs = record.timeMs;
    record.sequence = -1;
    expect(derivePairedCapacityChain(evidence, f.map, trace)).toBeUndefined();
    record.sequence = sequence;
    record.timeMs = NaN;
    expect(derivePairedCapacityChain(evidence, f.map, trace)).toBeUndefined();
    record.timeMs = timeMs;
    expect(derivePairedCapacityChain(evidence, f.map, trace)).toEqual(expected);
  });
  it("inherits the independently repeated early slot while preserving the successful suffix receiver", () => {
    const original = frames(),
      f = errorFixture(objects, original),
      e = deriveCircleEvidence(f.trace, f.map, "11"),
      fixed = errorFixture(
        objects,
        original.map((q) =>
          q.time >= 1005 && q.time < 1100 ? { ...q, actions: q.actions.filter((a) => a !== 1), rawButtonMask: 5 } : q,
        ),
      ),
      result = classifyCircleLoss(e, f.map, f.trace);
    expect(fixed.state.hitCircleVerdict["11"]).toMatchObject({ type: "MEH", judgementTime: 1200 });
    expect(fixed.state.hitCircleVerdict["9"].type).toBe("GREAT");
    for (const o of circles.map((_, k) => String(k)).filter((id) => id !== "9" && id !== "11"))
      expect(fixed.state.hitCircleVerdict[o]).toEqual(f.state.hitCircleVerdict[o]);
    expect(result.headline).toBe("Early tap");
    const proof = Reflect.get(result.diagnostics?.primary?.initiatingChain ?? {}, "pairedCapacity");
    expect(proof?.actual.map((r: { componentId: string }) => r.componentId)).toEqual(["9", "10"]);
    expect(proof?.hypothetical.map((r: { componentId: string }) => r.componentId)).toEqual(["10", "11"]);
    const selected = result.diagnostics?.primary?.initiatingChain?.rootComparison.ranking.selected[0];
    const correction = selected?.support?.correction;
    expect(correction).toMatchObject(selected!.attribution!.tapCorrection!);
    expect(correction?.timeMs).toBe(1075);
    expect(proof.rootCorrection.result).toBe("MEH");
    expect(f.trace.records.find((r) => r.id === proof.rootCorrection.sampleId)?.timeMs).toBe(1025);
    expect(e.directRejections).toEqual([]);
  });
  it.each([
    "single-capacity",
    "missing-anchor",
    "extra-pulse",
    "later-recovery",
    "duplicate-ordinal",
    "source-gap",
    "bad-mask",
    "irregular-cadence",
    "future-head",
    "excluded",
    "native",
    "classic",
  ])("does not infer the chain with %s", (fault) => {
    let source = frames(),
      text = objects;
    if (fault === "single-capacity")
      source = source.map((q) => (q.time === 1200 ? { ...q, actions: [0], rawButtonMask: 5 } : q));
    if (fault === "missing-anchor")
      source = source.map((q) => (q.time === 400 ? { ...q, actions: [], rawButtonMask: 0 } : q));
    if (fault === "extra-pulse")
      source = source.map((q) => (q.time === 1150 ? { ...q, actions: [1], rawButtonMask: 10 } : q));
    if (fault === "later-recovery")
      source = source.map((q) => (q.time === 1250 ? { ...q, actions: [0], rawButtonMask: 5 } : q));
    if (fault === "irregular-cadence") text = text.replace("80,192,500", "80,192,540");
    if (fault === "future-head") text += "\n270,192,1400,2,0,L|284:192,1,14";
    const f = errorFixture(
        text,
        source,
        fault === "native" || fault === "classic" ? "lazer" : "stable",
        [],
        fault === "classic" ? [{ acronym: "CL" }] : [],
      ),
      trace = JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    for (const r of trace.records) {
      if (fault === "duplicate-ordinal" && r.kind === "attempt" && r.timeMs === 1200) r.attemptOrdinal = 0;
      if (fault === "source-gap" && r.kind === "input" && r.timeMs === 1075 && r.source.origin === "parsed")
        r.source.parsedFrameIndex++;
      if (fault === "bad-mask" && r.kind === "input" && r.timeMs === 1075) r.rawButtonMask = 0;
    }
    expect(
      derivePairedCapacityChain(
        deriveCircleEvidence(trace, f.map, "11"),
        f.map,
        trace,
        fault === "excluded" ? new Set(["9"]) : undefined,
      ),
    ).toBeUndefined();
  });
  it("preserves a genuinely independent failed recovery after the consuming packet", () => {
    const source = frames().map((q) =>
        q.time >= 1250 && q.time < 1500
          ? {
              ...q,
              position: { x: 500, y: 192 },
              actions: q.time === 1250 ? [] : [0],
              rawButtonMask: q.time === 1250 ? 0 : 5,
            }
          : q,
      ),
      f = errorFixture(objects, source),
      e = deriveCircleEvidence(f.trace, f.map, "11");
    expect(e.terminal).toMatchObject({ result: "MISS", mechanism: "automatic-expiry" });
    expect(derivePairedCapacityChain(e, f.map, f.trace)).toBeUndefined();
    expect(classifyCircleLoss(e, f.map, f.trace).headline).toBe("Misaim");
  });
  it("retains direct Notelock priority instead of reconstructing consumption", () => {
    const f = errorFixture(
        objects,
        frames().map((q) => (q.time === 1200 || q.time === 1210 ? { ...q, position: { x: 330, y: 192 } } : q)),
      ),
      e = deriveCircleEvidence(f.trace, f.map, "11");
    expect(e.directRejections.length).toBeGreaterThan(0);
    expect(classifyCircleLoss(e, f.map, f.trace).headline).toBe("Notelock");
    expect(derivePairedCapacityChain(e, f.map, f.trace)).toBeUndefined();
  });
});
