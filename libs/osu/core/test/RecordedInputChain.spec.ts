import { buildErrorAnalysis } from "../src/gameplay/error-analysis/ErrorAnalysis";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { recordedInputChains } from "../src/gameplay/error-analysis/RecordedInputChain";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";

function taken(receiptTime = 1080, firstTime = 940, firstX = 160) {
  const frames = [
    traceFrame(800, 160),
    traceFrame(900, 160),
    traceFrame(firstTime, firstX, [0]),
    traceFrame(firstTime + 5, 160),
    traceFrame(990, 100),
    traceFrame(1000, 100),
    traceFrame(receiptTime, 100, [1]),
    traceFrame(receiptTime + 5, 100),
    traceFrame(1300, 100),
  ].sort((a, b) => a.time - b.time);
  return errorFixture("100,192,1000,1,0\n100,192,1100,1,0", frames);
}
const mechanism = (f: ReturnType<typeof taken>, id: string) =>
  buildErrorAnalysis(f.trace, f.map).incidents.find((i) => i.componentId === id)?.mechanism;

describe("recorded-input chained misses", () => {
  it("inherits the exact first failed press cause after a late previous-note receipt", () => {
    const f = taken(),
      before = JSON.stringify(f.state),
      result = mechanism(f, "1");
    expect(f.state.hitCircleVerdict["0"]).toMatchObject({ type: "MEH", judgementTime: 1080 });
    expect(f.state.hitCircleVerdict["1"].type).toBe("MISS");
    expect(result).toMatchObject({
      headline: "Early tap",
      chain: {
        chained: true,
        start: { componentId: "0", timeMs: 940 },
        disposition: "inherited",
      },
    });
    expect(JSON.stringify(f.state)).toBe(before);
    expect(result?.chain?.certification).toMatchObject({
      status: "observation",
      reason: "downstream-certification-not-requested",
    });
    expect(result?.chain?.certification.control).toBeUndefined();
    expect(result?.chain?.cause.observationOnly).toBe(false);
  });
  it("includes an actual late input-MISS rather than treating it as an early-miss stop", () => {
    const f = taken(1110);
    expect(f.trace.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "resolution",
          componentId: "0",
          mechanism: "input-miss",
          result: "MISS",
          timeMs: 1110,
        }),
      ]),
    );
    expect(mechanism(f, "1")).toMatchObject({
      headline: "Early tap",
      chain: {
        start: { componentId: "0", timeMs: 940 },
        opportunities: [
          expect.objectContaining({
            kind: "taken",
            receiverId: "0",
            receiverResult: "MISS",
          }),
        ],
      },
    });
  });
  it("does not chain overlapping notes through a normal300 receipt", () => {
    const f = taken(1010);
    expect(f.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(mechanism(f, "1")).not.toHaveProperty("chain");
  });
  it("leaves successful100/50 diagnoses unannotated", () => {
    const f = taken();
    expect(mechanism(f, "0")).toMatchObject({ headline: "Late tap" });
    expect(mechanism(f, "0")).not.toHaveProperty("chain");
  });
  it("does not cross a source gap between otherwise fresh presses", () => {
    const f = taken();
    const trace = {
      ...f.trace,
      records: f.trace.records.map((r) =>
        r.kind === "input" && r.timeMs === 990
          ? { ...r, source: { ...r.source, discontinuityBefore: ["test-gap"] } }
          : r,
      ),
    };
    expect(mechanism({ ...f, trace }, "1")).not.toHaveProperty("chain");
  });
  it("stops when no note was waiting, even without an intervening normal hit", () => {
    const f = errorFixture("100,192,1000,1,0\n100,192,1100,1,0", [
      traceFrame(700, 160),
      traceFrame(800, 160, [0]),
      traceFrame(805, 160),
      traceFrame(990, 100),
      traceFrame(1000, 100),
      traceFrame(1080, 100, [1]),
      traceFrame(1085, 100),
      traceFrame(1300, 100),
    ]);
    expect(mechanism(f, "1")).toMatchObject({
      headline: "Late tap",
      chain: {
        start: { componentId: "0", timeMs: 1080 },
        stop: "nothing-waiting",
      },
    });
  });
  it("leaves even a protected target object untouched when the exact start has no cause", () => {
    const f = errorFixture("100,192,1000,1,0\n100,192,1100,1,0", [
        traceFrame(800, 160),
        traceFrame(900, 160),
        traceFrame(990, 160),
        traceFrame(1000, 160),
        traceFrame(1110, 100, [1]),
        traceFrame(1115, 100),
        traceFrame(1300, 100),
      ]),
      e = deriveCircleEvidence(f.trace, f.map, "1"),
      original = {
        ...classifyCircleLoss(e, f.map, f.trace),
        codes: ["notelock"],
        headline: "Notelock",
      };
    expect(recordedInputChains(f.map, f.trace).apply(e, original)).toBe(original);
  });
  it("requires the direct rejection policy to name this target", () => {
    const f = errorFixture("100,192,1000,1,0\n300,192,1050,1,0\n300,192,1070,1,0", [
      traceFrame(800, 200),
      traceFrame(930, 160, [0]),
      traceFrame(935, 160),
      traceFrame(990, 100),
      traceFrame(995, 300),
      traceFrame(1000, 300, [1]),
      traceFrame(1005, 300),
      traceFrame(1300, 300),
    ]);
    expect(f.trace.records.some((r) => r.kind === "policy" && r.componentId === "1" && r.state === "rejected")).toBe(
      true,
    );
    expect(mechanism(f, "1")).toHaveProperty("chain");
    expect(mechanism(f, "2")).not.toHaveProperty("chain");
    const invalid = {
      ...f.trace,
      records: f.trace.records.map((r) =>
        r.kind === "policy" && r.state === "rejected" ? { ...r, timingResult: "MISS", offsetMs: 999 } : r,
      ),
    };
    expect(deriveCircleEvidence(invalid, f.map, "1").directRejections).toHaveLength(0);
    expect(mechanism({ ...f, trace: invalid }, "1")).not.toHaveProperty("chain");
  });
  it("does not chain receipt by a note two places earlier", () => {
    const f = errorFixture("100,192,1000,1,0\n300,192,1050,1,0\n100,192,1100,1,0", [
      traceFrame(800, 160),
      traceFrame(940, 160, [0]),
      traceFrame(945, 160),
      traceFrame(990, 100),
      traceFrame(1000, 100),
      traceFrame(1080, 100, [1]),
      traceFrame(1085, 100),
      traceFrame(1300, 100),
    ]);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MEH");
    expect(mechanism(f, "2")).not.toHaveProperty("chain");
  });
  it("keeps an early successful receipt as a normal stop", () => {
    const f = taken(1040, 940, 100);
    expect(f.state.hitCircleVerdict["0"]).toMatchObject({ type: "OK", judgementTime: 940 });
    expect(mechanism(f, "1")).not.toHaveProperty("chain");
  });
  it("keeps native Out of order separate from a nonexistent direct rejection", () => {
    const f = errorFixture(
      "100,192,1000,1,0\n300,192,1050,1,0",
      [
        traceFrame(800, 200),
        traceFrame(930, 160, [0]),
        traceFrame(935, 160),
        traceFrame(1050, 300, [1]),
        traceFrame(1300, 300),
      ],
      "lazer",
    );
    expect(mechanism(f, "0")).toMatchObject({ headline: "Out of order" });
    expect(mechanism(f, "0")).not.toHaveProperty("chain");
  });
  it.each(["stable", "classic"])("keeps the prepared %s overlapping-note receipt and exact input link", (profile) => {
    const f = errorFixture(
      "100,192,1000,1,0\n100,192,1100,1,0",
      [
        traceFrame(800, 160),
        traceFrame(900, 160),
        traceFrame(940, 160, [0]),
        traceFrame(945, 160),
        traceFrame(990, 100),
        traceFrame(1000, 100),
        traceFrame(1080, 100, [1]),
        traceFrame(1085, 100),
        traceFrame(1300, 100),
      ],
      profile === "stable" ? "stable" : "lazer",
      [],
      profile === "classic" ? [{ acronym: "CL", settings: { classic_note_lock: true } }] : [],
    );
    const chain = mechanism(f, "1")?.chain;
    expect(chain).toMatchObject({ start: { componentId: "0", timeMs: 940 } });
    expect(f.trace.records.find((r) => r.id === chain!.start.inputId)).toMatchObject({ kind: "input", timeMs: 940 });
    if (profile === "classic") expect(chain!.certification.status).toBe("observation");
  });
  it("preserves an unrelated prefix slider while observing the later chain", () => {
    const f = errorFixture("300,192,700,2,0,L|340:192,1,40\n100,192,1000,1,0\n100,192,1100,1,0", [
        traceFrame(500, 300),
        traceFrame(700, 300, [0]),
        traceFrame(800, 320, [0]),
        traceFrame(900, 340, [0]),
        traceFrame(905, 340),
        traceFrame(920, 160),
        traceFrame(940, 160, [0]),
        traceFrame(945, 160),
        traceFrame(990, 100),
        traceFrame(1000, 100),
        traceFrame(1080, 100, [1]),
        traceFrame(1085, 100),
        traceFrame(1300, 100),
      ]),
      before = JSON.stringify(f.trace.records),
      result = mechanism(f, "2");
    expect(result?.chain).toMatchObject({ start: { componentId: "1", timeMs: 940 } });
    expect(JSON.stringify(f.trace.records)).toBe(before);
    expect(f.state.hitCircleVerdict["0/HEAD"].type).toBe("GREAT");
    expect(result?.chain?.certification).toEqual({
      status: "observation",
      reason: "downstream-certification-not-requested",
    });
  });
  it("walks an actual blocked interaction outside H even when that note later gets300", () => {
    const f = errorFixture("100,192,1000,1,0\n100,192,1100,1,0\n300,192,1350,1,0", [
      traceFrame(800, 160),
      traceFrame(940, 160, [0]),
      traceFrame(945, 160),
      traceFrame(990, 100),
      traceFrame(1000, 300, [1]),
      traceFrame(1005, 300),
      traceFrame(1080, 100, [0]),
      traceFrame(1085, 100),
      traceFrame(1250, 300),
      traceFrame(1350, 300, [1]),
      traceFrame(1360, 300),
      traceFrame(1500, 300),
    ]);
    expect(f.state.hitCircleVerdict["2"].type).toBe("GREAT");
    expect(f.trace.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "policy",
          state: "rejected",
          componentId: "2",
          timingResult: "MISS",
          offsetMs: -350,
        }),
      ]),
    );
    const result = mechanism(f, "1");
    expect(result?.chain).toMatchObject({ start: { timeMs: 940, componentId: "0" } });
    expect(result?.chain?.pressIds).toHaveLength(3);
  });
  it("admits an earlier valid rejection even when the missed target later receives an input-MISS", () => {
    const f = errorFixture("100,192,1000,1,0\n300,192,1050,1,0", [
      traceFrame(800, 200),
      traceFrame(930, 160, [0]),
      traceFrame(935, 160),
      traceFrame(990, 100),
      traceFrame(995, 300),
      traceFrame(1000, 300, [1]),
      traceFrame(1005, 300),
      traceFrame(1110, 300),
      traceFrame(1120, 300),
      traceFrame(1160, 300, [0]),
      traceFrame(1165, 300),
      traceFrame(1400, 300),
    ]);
    expect(f.trace.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "resolution", componentId: "1", mechanism: "input-miss", result: "MISS" }),
      ]),
    );
    expect(mechanism(f, "1")?.chain).toMatchObject({ start: { componentId: "0", timeMs: 930 } });
  });
  it.each([false, true])("propagates the missed head link without changing parent100/50 (held=%s)", (held) => {
    const actions = held ? [1] : [];
    const f = errorFixture("100,192,1000,1,0\n100,192,1100,2,0,L|120:192,1,20", [
        traceFrame(800, 160),
        traceFrame(900, 160),
        traceFrame(940, 160, [0]),
        traceFrame(945, 160),
        traceFrame(990, 100),
        traceFrame(1000, 100),
        traceFrame(1080, 100, [1]),
        traceFrame(1085, 100, actions),
        traceFrame(1120, 100, actions),
        traceFrame(1164, 110, actions),
        traceFrame(1200, 120, actions),
        traceFrame(1300, 100),
      ]),
      analysis = buildErrorAnalysis(f.trace, f.map),
      head = analysis.inventory.atoms.find((a) => a.componentId === "1/HEAD")!,
      parent = analysis.inventory.atoms.find((a) => a.component === "slider-parent")!,
      byAtom = new Map(analysis.classifications.map((c) => [c.atomId, c.mechanism]));
    expect(byAtom.get(head.id)?.chain?.start.timeMs).toBe(940);
    expect(parent.result).toBe(held ? "OK" : "MISS");
    if (held) expect(byAtom.get(parent.id)).toMatchObject({ headline: "", status: "unavailable" });
    else expect(byAtom.get(parent.id)?.chain).toEqual(byAtom.get(head.id)?.chain);
    if (held) expect(byAtom.get(parent.id)).not.toHaveProperty("chain");
  });
});
