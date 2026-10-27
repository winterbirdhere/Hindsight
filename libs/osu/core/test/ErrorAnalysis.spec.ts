import { buildErrorAnalysis } from "../src/gameplay/error-analysis/ErrorAnalysis";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import * as circleMechanisms from "../src/gameplay/error-analysis/CircleMechanisms";
import { SavedScoreTimeline } from "../src/replays/SavedScoreTimeline";
describe("all-error analysis and incident grouping", () => {
  it("versions the changed primary diagnosis without changing the atomic schema", () => {
    const f = errorFixture("300,192,1000,1,0", [traceFrame(0), traceFrame(1200)]);
    const analysis = buildErrorAnalysis(f.trace, f.map);
    expect(analysis.schemaVersion).toBe(2);
    expect(analysis.policyVersion).toBe("all-errors-root-receipt-boundary-v33");
    expect(analysis.inventory.counts.misses).toBe(1);
  });
  it.each([1, 2])("keeps %s reconstructed errors available with contradictory optional saved outcomes", (count) => {
    const f = errorFixture(Array(count).fill("300,192,1000,1,0").join("\n"), [
      traceFrame(0, 300),
      traceFrame(700, 300, [0]),
      traceFrame(1000, 300),
      traceFrame(1250, 300),
    ]);
    const trace = {
      ...f.trace,
      identity: { ...f.trace.identity, replayContentSha256: "a".repeat(64), beatmapMd5: "b".repeat(32) },
    };
    const timeline: SavedScoreTimeline = {
      schema: "stable-saved-score-v1",
      provenance: {
        timelineSha256: "c".repeat(64),
        pairedReplaySha256: "a".repeat(64),
        mapMd5: "b".repeat(32),
        version: 20260711,
      },
      rows: [],
      groups: [
        {
          id: "saved:0",
          row: 0,
          time: 1000,
          ordinalStart: 0,
          count,
          grades: { GREAT: 1, OK: 0, MEH: 0, MISS: count - 1 },
          cumulativeCounts: [1, 0, 0, 0, 0, count - 1],
        },
      ],
    };
    const a = buildErrorAnalysis(trace, f.map, timeline);
    const without = buildErrorAnalysis(trace, f.map);
    expect(a.corroboration?.groups[0].consistency).toBe("conflict");
    expect(a.limitations).toContain("saved-outcome-model-conflict");
    expect(a.outcomeBasis).toBe("model-reconstruction");
    expect(a.inventory).toEqual(without.inventory);
    expect(a.classifications).toEqual(without.classifications);
    expect(a.incidents).toEqual(without.incidents);
    expect(a.excludedModelAtomIds).toEqual([]);
    expect(a.admittedCounts).toMatchObject({ primary: count, misses: count });
    expect(a.excludedModelCounts).toMatchObject({ primary: 0, misses: 0 });
  });
  it("keeps a short-slider parent penalty with the head that outlives it", () => {
    const f = errorFixture("100,192,1000,2,0,L|110:192,1,10", [
      traceFrame(100, 500, [0]),
      traceFrame(900, 500, [0]),
      traceFrame(1000, 100, [0]),
      traceFrame(1070, 110, [0]),
      traceFrame(1250, 500, [0]),
    ]);
    const analysis = buildErrorAnalysis(f.trace, f.map);
    expect(analysis.inventory.counts).toMatchObject({ primary: 1, consequences: 1 });
    expect(analysis.incidents).toHaveLength(1);
    expect(analysis.incidents[0].atomIds).toHaveLength(2);
    expect(analysis.limitations).not.toContain("unclassified:0");
  });
  it("keeps a post-parent head press out of the earlier penalty's trigger", () => {
    const f = errorFixture("100,192,1000,2,0,L|110:192,1,10", [
      traceFrame(100, 500, [0]),
      traceFrame(900, 500, [0]),
      traceFrame(1000, 100, [0]),
      traceFrame(1070, 110, [0]),
      traceFrame(1075, 110),
      traceFrame(1080, 110, [0]),
      traceFrame(1250, 500, [0]),
    ]);
    const analysis = buildErrorAnalysis(f.trace, f.map);
    // Stable stops selecting this head once its parent has a grade. The late
    // press does not hit it, even though it is inside the head's spatial radius.
    expect(analysis.inventory.counts).toMatchObject({ primary: 1, consequences: 1 });
    expect(analysis.incidents).toHaveLength(1);
    expect(analysis.incidents[0].atomIds).toHaveLength(2);
    const parent = analysis.inventory.atoms.find((a) => a.component === "slider-parent")!;
    expect(parent.resolutionTimeMs).toBeLessThan(1080);
    const head = analysis.inventory.atoms.find((a) => a.component === "slider-head")!;
    expect(f.trace.records.find((r) => r.id === head.eventId)).toMatchObject({
      result: "MISS",
      mechanism: "automatic-expiry",
    });
  });
  it("bounds retained analysis before classifying every target", () => {
    const times = Array.from({ length: 40 }, (_, i) => 1000 + i * 500);
    const f = errorFixture(times.map((t) => `300,192,${t},1,0`).join("\n"), [
      traceFrame(500),
      ...times.flatMap((t) => [traceFrame(t - 50, 300, [0]), traceFrame(t + 200)]),
    ]);
    const limit = JSON.stringify(f.inventory).length + 3000;
    const spy = jest.spyOn(circleMechanisms, "classifyCircleLoss");
    try {
      expect(() =>
        buildErrorAnalysis({ ...f.trace, limits: { ...f.trace.limits, maxExportBytes: limit } }, f.map),
      ).toThrow("analysis-byte-limit");
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(spy.mock.calls.length).toBeLessThan(40);
    } finally {
      spy.mockRestore();
    }
  });
  it.each(["stable", "lazer"] as const)(
    "%s groups one unrecovered lapse without losing component identities",
    (profile) => {
      const f = errorFixture(
        "100,192,1000,2,0,L|300:192,2,200",
        [
          traceFrame(800, 100),
          traceFrame(1000, 100, [0]),
          traceFrame(1500, 500),
          traceFrame(2000, 500),
          traceFrame(2500, 500),
          traceFrame(2990, 500),
          traceFrame(3200, 500),
        ],
        profile,
      );
      const a = buildErrorAnalysis(f.trace, f.map);
      expect(a.inventory.atoms.length).toBeGreaterThan(1);
      expect(a.incidents).toHaveLength(1);
      expect(new Set(a.incidents.flatMap((i) => i.atomIds)).size).toBe(a.inventory.atoms.length);
      expect(a.incidents[0].mechanism.headline).not.toMatch(/unknown|expiry|mixed/i);
    },
  );
  it("retains distinct timing loss labels and only one useful number", () => {
    const f = errorFixture("300,192,1000,1,0\n300,192,1500,1,0", [
      traceFrame(850),
      traceFrame(950, 300, [0]),
      traceFrame(1200),
      traceFrame(1590, 300, [0]),
      traceFrame(1800),
    ]);
    const a = buildErrorAnalysis(f.trace, f.map);
    expect(a.incidents.map((i) => i.mechanism.headline)).toEqual(["Early tap", "Late tap"]);
    expect(a.incidents.every((i) => i.mechanism.headline.split(/\s+/).length <= 4)).toBe(true);
  });
  it("has deterministic atoms and cached-consumable plain diagnostics", () => {
    const f = errorFixture("300,192,1000,1,0", [traceFrame(800), traceFrame(1200)]);
    const first = buildErrorAnalysis(f.trace, f.map),
      second = buildErrorAnalysis(f.trace, f.map);
    expect(first).toEqual(second);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});
