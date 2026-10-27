import { buildErrorAnalysis } from "../src/gameplay/error-analysis/ErrorAnalysis";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

describe("independent all-error incident review", () => {
  it("keeps an input head miss separate from a later body lapse with different failed gates", () => {
    const f = errorFixture("100,192,1000,2,0,L|300:192,2,200", [
      traceFrame(600, 100),
      traceFrame(700, 100, [0]),
      traceFrame(800, 500),
      traceFrame(1100, 500),
      traceFrame(1500, 500),
      traceFrame(2000, 500),
      traceFrame(2500, 500),
      traceFrame(2990, 500),
      traceFrame(3200, 500),
    ]);
    const analysis = buildErrorAnalysis(f.trace, f.map);
    const head = analysis.inventory.atoms.find((a) => a.component === "slider-head")!;
    expect(f.trace.records.find((r) => r.id === head.eventId)).toMatchObject({
      kind: "resolution",
      mechanism: "input-miss",
      timeMs: 700,
    });
    const incident = analysis.incidents.find((i) => i.atomIds.includes(head.id))!;
    expect(incident.mechanism.codes).toEqual(["early-tap"]);
    expect(incident.atomIds.map((id) => analysis.inventory.atoms.find((a) => a.id === id)!.component)).not.toContain(
      "slider-tick",
    );
  });

  it("limits a combined multi-gate lapse headline to four recognizable words", () => {
    const f = errorFixture("100,192,1000,2,0,L|300:192,2,200", [
      traceFrame(800, 100),
      traceFrame(1000, 100, [0]),
      traceFrame(1500, 500),
      traceFrame(1999, 500),
      traceFrame(2000, 500, [0]),
      traceFrame(2500, 50, [0]),
      traceFrame(2990, 50, [0]),
      traceFrame(3200, 50, [0]),
    ]);
    const analysis = buildErrorAnalysis(f.trace, f.map);
    for (const incident of analysis.incidents)
      expect(
        incident.mechanism.headline.split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length,
      ).toBeLessThanOrEqual(4);
  });

  it("records Classic's failed head tick as an accuracy loss even when head timing is ignored", () => {
    const f = errorFixture(
      "100,192,1000,2,0,L|300:192,1,200",
      [traceFrame(900, 500), traceFrame(1200, 500), traceFrame(1500, 500), traceFrame(2100, 500)],
      "lazer",
      [],
      [{ acronym: "CL" }],
    );
    expect(f.state.lazerJudgements).toContainEqual(
      expect.objectContaining({ kind: "SLIDER_HEAD", result: "LARGE_TICK_MISS" }),
    );
    expect(f.inventory.atoms.find((a) => a.component === "slider-head")?.accuracyLoss).toBe(true);
  });

  it("counts an actual Classic parent combo reset after an overlapping circle restores combo", () => {
    const f = errorFixture(
      "100,192,1000,2,0,L|300:192,1,200\n500,192,1990,1,0",
      [
        traceFrame(900, 500),
        traceFrame(1200, 500),
        traceFrame(1500, 500),
        traceFrame(1970, 500),
        traceFrame(1990, 500, [0]),
        traceFrame(2100, 500),
      ],
      "lazer",
      [],
      [{ acronym: "CL", settings: { classic_note_lock: false } }],
    );
    const circle = f.state.lazerJudgements.findIndex((j) => j.kind === "CIRCLE" && j.result === "GREAT");
    const parent = f.state.lazerJudgements.findIndex((j) => j.kind === "SLIDER" && j.result === "MISS");
    expect(circle).toBeGreaterThanOrEqual(0);
    expect(parent).toBeGreaterThan(circle);
    expect(f.inventory.atoms.find((a) => a.component === "slider-parent")?.comboBroken).toBe(true);
    expect(f.inventory.counts.comboBreaks).toBe(1);
  });
});
