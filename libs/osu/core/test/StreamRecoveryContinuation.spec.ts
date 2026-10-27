import { deriveStreamInputEvidence } from "../src/gameplay/error-analysis/StreamInputEvidence";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";

// Ten 80ms slots. Two successes, three missed taps and a successful recovery
// establish an exact-count bridge. The next tap continues that cadence at +46ms,
// after an on-time circle pass. No recording/object identity enters the policy.
function recovery(
  options: {
    missing?: boolean;
    extra?: boolean;
    double?: boolean;
    native?: boolean;
    postMissing?: boolean;
    postDouble?: boolean;
    phaseReset?: boolean;
    badSecond?: boolean;
  } = {},
) {
  const offsets = [35, 35, 40, 40, 40, 35, 46, 46, 46, 46];
  const scheduled = offsets.map((_, i) => 1000 + 80 * i);
  const centres = offsets.map((_, i) => 40 + 80 * i);
  const knots = [[800, 0, 192]];
  for (let i = 0; i < scheduled.length; i++) {
    knots.push([scheduled[i], centres[i], 192]);
    knots.push([
      scheduled[i] + offsets[i],
      centres[i] + ([0, 1, 5].includes(i) ? 0 : offsets[i]),
      options.native && ![0, 1, 5].includes(i) ? 212 : 192,
    ]);
  }
  knots.push([2000, 900, 192]);
  const taps = scheduled.flatMap((t, i) =>
    (options.missing && i === 3) || (options.postMissing && i === 6)
      ? []
      : [t + ((options.phaseReset && i >= 6) || (options.badSecond && i === 7) ? -25 : offsets[i])],
  );
  if (options.extra) taps.push(1230);
  taps.sort((a, b) => a - b);
  const times = [
    ...new Set([
      ...Array.from({ length: 151 }, (_, i) => 800 + i * 8),
      ...knots.map((p) => p[0]),
      ...taps,
      ...taps.map((t) => t + 20),
    ]),
  ].sort((a, b) => a - b);
  const frames = times.map((time) => {
    const at = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1);
    const a = knots[at],
      b = knots[at + 1] ?? a;
    const f = (time - a[0]) / Math.max(1, b[0] - a[0]);
    const actions = taps.flatMap((t, i) => (time >= t && time < t + 20 ? [i % 2] : []));
    if (options.double && time >= 1280 && time < 1300) actions.push(1 - actions[0]);
    if (options.postDouble && time >= 1526 && time < 1546) actions.push(1 - actions[0]);
    return {
      ...traceFrame(time, a[1] + (b[1] - a[1]) * f, actions),
      position: {
        x: a[1] + (b[1] - a[1]) * f,
        y: a[2] + (b[2] - a[2]) * f,
      },
    };
  });
  return errorFixture(
    scheduled.map((t, i) => `${centres[i]},192,${t},1,0`).join("\n"),
    frames,
    options.native ? "lazer" : "stable",
  );
}
function inspect(f: ReturnType<typeof recovery>, id = "6") {
  const evidence = deriveCircleEvidence(f.trace, f.map, id);
  return { evidence, stream: deriveStreamInputEvidence(evidence, f.map, f.trace) };
}

describe("bounded cadence after a verified recovery", () => {
  it.each([false, true])("retains the next real press after recovery (native=%s)", (native) => {
    const f = recovery({ native });
    const { evidence, stream } = inspect(f);
    expect(deriveCircleEvidence(f.trace, f.map, "5").terminal).toMatchObject({ mechanism: "successful-input" });
    const press = evidence.inputs.find((i) => i.record.timeMs === 1526)!.record.id;
    expect(evidence.inputs.find((i) => i.record.id === press)).toMatchObject({ inside: false, inLiveSuccess: true });
    expect(stream.assignments.find((a) => a.inputId === press)).toMatchObject({
      componentId: "6",
      relation: "matched",
      basis: "cadence",
      offsetMs: 46,
    });
    expect(stream.relevantInputIds).toEqual([press]);
  });
  it("shows Late tap after an on-time pass; the following rejection stays Notelock", () => {
    const f = recovery();
    const before = JSON.stringify(normalizeTraceState({ state: f.state, trace: f.trace }));
    const { evidence } = inspect(f);
    expect(evidence.directRejections).toEqual([]);
    expect(classifyCircleLoss(evidence, f.map, f.trace)).toMatchObject({
      status: "supported",
      headline: "Late tap",
      metric: { value: 46, unit: "ms late" },
    });
    const following = deriveCircleEvidence(f.trace, f.map, "7");
    expect(following.directRejections.length).toBeGreaterThan(0);
    expect(classifyCircleLoss(following, f.map, f.trace).headline).toBe("Notelock");
    expect(JSON.stringify(normalizeTraceState({ state: f.state, trace: f.trace }))).toBe(before);
  });
  it.each(["missing", "extra", "double"] as const)(
    "does not seed continuation from a bridge with %s actions",
    (kind) => {
      const f = recovery({ [kind]: true });
      const { evidence, stream } = inspect(f);
      const press = evidence.inputs.find((i) => i.record.timeMs === 1526)!.record.id;
      expect(
        stream.assignments.find((a) => a.inputId === press && a.componentId === "6" && a.basis === "cadence"),
      ).toBeUndefined();
    },
  );
  it("does not propagate a recovery phase beyond the existing three-slot bound", () => {
    const f = recovery();
    const { evidence, stream } = inspect(f, "9");
    const press = evidence.inputs.find((i) => i.record.timeMs === 1766)!.record.id;
    expect(stream.assignments.find((a) => a.inputId === press && a.basis === "cadence")).toBeUndefined();
  });
  it.each(["postMissing", "postDouble", "phaseReset"] as const)("does not force a next-slot cause after %s", (kind) => {
    const f = recovery({ [kind]: true });
    const { evidence, stream } = inspect(f);
    expect(stream.assignments.some((a) => a.componentId === "6" && a.basis === "cadence")).toBe(false);
    expect(classifyCircleLoss(evidence, f.map, f.trace).headline).not.toBe("Late tap");
  });
  it("does not use a recovery across an explicit source discontinuity", () => {
    const f = recovery();
    const trace = {
      ...f.trace,
      records: f.trace.records.map((r) =>
        r.kind === "input" && r.timeMs === 1320
          ? { ...r, source: { ...r.source, discontinuityBefore: ["parser-negative-delta" as const] } }
          : r,
      ),
    };
    const evidence = deriveCircleEvidence(trace, f.map, "6");
    const stream = deriveStreamInputEvidence(evidence, f.map, trace);
    expect(stream.status).toBe("unavailable");
    expect(stream.assignments).toEqual([]);
  });
  it("records every intervening edge needed by a later continuation", () => {
    const f = recovery();
    const { stream } = inspect(f, "8");
    const assignment = stream.assignments.find((a) => a.componentId === "8" && a.basis === "cadence")!;
    expect(assignment).toBeDefined();
    for (const time of [1526, 1606, 1686]) {
      const input = f.trace.records.find((r) => r.kind === "input" && r.timeMs === time)!;
      expect(assignment.eventIds).toContain(input.id);
    }
  });
  it("does not skip a bad second edge to resume on the third", () => {
    const f = recovery({ badSecond: true });
    const { stream } = inspect(f, "8");
    expect(stream.assignments.some((a) => a.componentId === "6" && a.basis === "cadence")).toBe(true);
    expect(stream.assignments.some((a) => a.componentId === "8" && a.basis === "cadence")).toBe(false);
  });
  it("is independent of target query order", () => {
    const f = recovery();
    const expected = inspect(f).stream;
    inspect(f, "9");
    inspect(f, "2");
    expect(inspect(f).stream).toEqual(expected);
  });
});
