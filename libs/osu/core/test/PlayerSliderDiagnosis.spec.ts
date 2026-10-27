import { buildErrorAnalysis } from "../src/gameplay/error-analysis/ErrorAnalysis";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { GameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { classifyParentCause } from "../src/gameplay/error-analysis/ParentCause";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

const profiles = [
  { name: "Stable", profile: "stable", mods: [], lazerMods: [] },
  { name: "ScoreV2", profile: "stable", mods: ["SCORE_V2"], lazerMods: [] },
  {
    name: "Classic",
    profile: "lazer",
    mods: [],
    lazerMods: [{ acronym: "CL", settings: { classic_note_lock: true, no_slider_head_accuracy: true } }],
  },
] as const;
type Mode = "carried" | "head-tap" | "head-held" | "pickup" | "geometry-pickup";
function fixture(length: number, mode: Mode, p: typeof profiles[number] = profiles[0]) {
  const release = length === 16 ? 1030 : 1300,
    end = 1000 + length * 5;
  const frames = Array.from({ length: (end + 200 - 300) / 10 + 1 }, (_, i) => {
    const t = 300 + i * 10;
    let actions = t >= 500 && t < release ? [1] : [];
    if ((mode === "head-tap" && t === 1000) || (mode === "head-held" && t >= 1000 && t < release))
      actions = [...actions, 0];
    if (mode === "pickup") actions = t >= 500 && t < 1010 ? [1] : t >= 1200 && t < release ? [0] : [];
    return traceFrame(
      t,
      mode === "geometry-pickup" && t >= 1050 && t < 1200
        ? 500
        : t < 960
        ? 100
        : t < 1000
        ? 120
        : 120 + Math.min(length, (t - 1000) / 5),
      actions,
    );
  });
  return errorFixture(
    `100,192,500,1,0\n120,192,1000,2,0,L|${120 + length}:192,1,${length}`,
    frames,
    p.profile,
    [...p.mods],
    p.lazerMods.map((m) => ({ ...m, settings: { ...m.settings } })),
  );
}
function diagnosis(f: ReturnType<typeof fixture>) {
  const analysis = buildErrorAnalysis(f.trace, f.map),
    parent = analysis.inventory.atoms.find((a) => a.component === "slider-parent")!;
  return { analysis, parent, cause: analysis.classifications.find((c) => c.atomId === parent.id)!.mechanism };
}

describe("player action, rather than failed-part count, explains a slider", () => {
  it("does not promote an unacquired body after an early failed initiating tap", () => {
    const f = errorFixture("100,192,1000,2,0,L|300:192,1,200", [
      traceFrame(300, 100),
      traceFrame(700, 100),
      traceFrame(820, 100, [0]),
      traceFrame(900, 500, [0]),
      traceFrame(1000, 500, [0]),
      traceFrame(1100, 500, [0]),
      traceFrame(1500, 500, [0]),
      traceFrame(1964, 500, [0]),
      traceFrame(2100, 500, [0]),
    ]);
    expect(f.state.hitCircleVerdict["0/HEAD"]).toMatchObject({ type: "MISS", judgementTime: 820 });
    const { cause } = diagnosis(f);
    expect(cause.codes).toEqual(["early-tap"]);
    expect(cause.parentEvidence?.groups.some((g) => g.code === "ran-ahead")).toBe(true);
  });
  it("uses a source-separated initiating episode, rather than counts, in a longer chain", () => {
    const f = errorFixture("100,192,1000,2,0,L|500:192,1,400", [
      traceFrame(800, 100),
      traceFrame(1000, 100, [0]),
      traceFrame(1100, 500, [0]),
      traceFrame(1500, 500, [0]),
      traceFrame(1600, 220, [0]),
      traceFrame(1900, 0, [0]),
      traceFrame(2000, 0, [0]),
      traceFrame(2100, 320, [0]),
      traceFrame(2200, 340),
      traceFrame(2500, 400),
      traceFrame(2964, 493),
      traceFrame(3100, 500),
    ]);
    const { cause } = diagnosis(f);
    expect(cause.parentEvidence?.groups.map((g) => g.code)).toEqual(["ran-ahead", "fell-behind", "released-early"]);
    expect(cause.status).toBe("supported");
    expect(cause.codes).toEqual(["ran-ahead"]);
  });
  it("does not invent a winner when initial independent failures overlap", () => {
    const f = errorFixture("100,192,1000,2,0,L|500:192,1,400", [
      traceFrame(800, 100),
      traceFrame(1000, 100, [0]),
      traceFrame(1100, 500),
      traceFrame(1500, 500),
      traceFrame(1600, 220, [0]),
      traceFrame(1900, 0, [0]),
      traceFrame(2000, 0, [0]),
      traceFrame(2100, 0, [0]),
      traceFrame(2500, 0, [0]),
      traceFrame(2964, 0, [0]),
      traceFrame(3100, 0, [0]),
    ]);
    const { cause } = diagnosis(f);
    expect(new Set(cause.parentEvidence?.groups.map((g) => g.code))).toEqual(
      new Set(["ran-ahead", "no-hold", "fell-behind"]),
    );
    expect(cause.status).toBe("unavailable");
    expect(cause.limitations).toContain("independent-parent-actions-unranked");
    expect(cause.parentEvidence?.comparison.every((c) => !c.selected)).toBe(true);
  });
  it("bounds omission by its whole live opportunity, not the scheduled head time", () => {
    const f = errorFixture("100,192,500,1,0\n100,192,1000,2,0,L|500:192,1,400", [
      traceFrame(300, 100),
      traceFrame(500, 100, [0]),
      traceFrame(800, 100, [0]),
      traceFrame(1000, 100, [0]),
      traceFrame(1100, 500, [0]),
      traceFrame(1120, 500, [0]),
      traceFrame(1500, 500, [0]),
      traceFrame(1600, 220, [0]),
      traceFrame(1900, 0, [0]),
      traceFrame(2000, 0, [0]),
      traceFrame(2500, 0, [0]),
      traceFrame(2964, 0, [0]),
      traceFrame(3100, 0, [0]),
    ]);
    const { cause } = diagnosis(f);
    expect(cause.parentEvidence?.groups.map((g) => g.code)).toEqual(["no-tap", "ran-ahead", "fell-behind"]);
    const omission = cause.parentEvidence!.comparison.find((c) => c.groupId === "head:no-tap")!;
    expect(omission.onset!.earliestMs).toBeLessThan(1000);
    expect(omission.onset!.latestMs).toBeGreaterThan(1100);
    expect(cause.status).toBe("unavailable");
  });
  it.each(["gap", "reconstructed"])("does not select an initiating episode using a %s bound", (fault) => {
    const f = errorFixture("100,192,1000,2,0,L|500:192,1,400", [
      traceFrame(800, 100),
      traceFrame(1000, 100, [0]),
      traceFrame(1100, 500, [0]),
      traceFrame(1500, 500, [0]),
      traceFrame(1600, 220, [0]),
      traceFrame(1900, 0, [0]),
      traceFrame(2000, 0, [0]),
      traceFrame(2100, 320, [0]),
      traceFrame(2200, 340),
      traceFrame(2500, 400),
      traceFrame(2964, 493),
      traceFrame(3100, 500),
    ]);
    const { analysis, parent } = diagnosis(f),
      trace = JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    for (const r of trace.records) {
      if (fault === "gap" && r.kind === "input" && r.timeMs === 1100 && r.source.origin === "parsed")
        r.source.discontinuityBefore = ["gap"];
      if (fault === "reconstructed" && r.kind === "slider-tracking" && r.timeMs === 1000)
        r.tracking.sampleBasis = "reconstructed-update";
    }
    const cause = classifyParentCause(
      parent,
      new Map(analysis.inventory.atoms.map((a) => [a.id, a])),
      new Map(analysis.classifications.map((c) => [c.atomId, c.mechanism])),
      trace,
      f.map,
      new Map(trace.records.map((r) => [r.id, r])),
      trace.records.filter((r): r is Extract<typeof r, { kind: "slider-tracking" }> => r.kind === "slider-tracking"),
      new Set(),
    );
    expect(cause.status).toBe("unavailable");
    expect(cause.limitations).toContain("independent-parent-actions-unranked");
  });
  it.each(profiles.flatMap((p) => [16, 200].map((length) => ({ p, length }))))(
    "keeps a carried-hold consequence internal: $p.name length $length",
    ({ p, length }) => {
      const f = fixture(length, "carried", p),
        { analysis, parent, cause } = diagnosis(f);
      expect(f.state.hitCircleVerdict["0"].type).toBe("GREAT");
      expect(f.state.hitCircleVerdict["1/HEAD"].type).toBe("MISS");
      expect(parent.result).toBe("MISS");
      const parts = parent.relatedAtomIds.map((id) => analysis.classifications.find((c) => c.atomId === id)!.mechanism);
      expect(parts.flatMap((m) => m.codes)).toEqual(expect.arrayContaining(["no-tap", "released-early"]));
      expect(cause.status).toBe("supported");
      expect(cause.codes).toEqual(["no-tap"]);
      expect(cause.headline).toBe("No tap");
      expect(cause.parentEvidence?.contributions).toHaveLength(parent.relatedAtomIds.length);
      expect(cause.eventIds).toEqual(expect.arrayContaining(parts.flatMap((m) => m.eventIds)));
    },
  );
  it.each(profiles.flatMap((p) => [16, 200].map((length) => ({ p, length }))))(
    "preserves a valid head followed by release: $p.name length $length",
    ({ p, length }) => {
      const f = fixture(length, "head-held", p),
        { analysis, parent, cause } = diagnosis(f);
      expect(f.state.hitCircleVerdict["1/HEAD"].type).toBe("GREAT");
      expect(cause.codes).toEqual(["released-early"]);
      expect(
        parent.relatedAtomIds
          .map((id) => analysis.classifications.find((c) => c.atomId === id)!.mechanism.codes)
          .flat(),
      ).toContain("released-early");
      const events = retrieveEvents(f.state, f.map.hitObjects, p.profile);
      if (p.profile === "stable")
        expect(events.some((e) => e.type === "SliderBreak" && e.sliderId === "1")).toBe(length === 200);
    },
  );
  it.each(["pickup", "geometry-pickup"] as const)(
    "keeps a later %s and release independent of an omitted head",
    (mode) => {
      const { cause } = diagnosis(fixture(200, mode));
      expect(cause.codes).toEqual(["no-tap", "released-early"]);
      expect(cause.parentEvidence?.comparison.every((c) => c.scope !== "carried-hold-consequence")).toBe(true);
    },
  );
  it.each([
    "source-gap",
    "raw-skip",
    "fractional-index",
    "negative-index",
    "mask",
    "previous",
    "fresh",
    "reconstructed",
  ])("does not certify carried-action dependency across %s", (fault) => {
    const f = fixture(200, "carried"),
      { analysis, parent } = diagnosis(f),
      trace = JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    for (const r of trace.records) {
      if (r.kind === "input" && r.source.origin === "parsed") {
        r.source.rawTokenIndex = r.source.parsedFrameIndex + (fault === "raw-skip" && r.timeMs >= 1210 ? 3 : 2);
        if (r.timeMs === 1210) {
          if (fault === "source-gap") r.source.discontinuityBefore = ["gap"];
          if (fault === "fractional-index") r.source.parsedFrameIndex += 0.5;
          if (fault === "negative-index") r.source.parsedFrameIndex = -1;
          if (fault === "mask") r.rawButtonMask = 0;
          if (fault === "previous") r.previousActions = [];
          if (fault === "fresh") r.freshActions = [1];
        }
      }
      if (r.kind === "slider-tracking" && r.componentId === "1" && r.timeMs <= 1000 && fault === "reconstructed")
        r.tracking.sampleBasis = "reconstructed-update";
    }
    const cause = classifyParentCause(
      parent,
      new Map(analysis.inventory.atoms.map((a) => [a.id, a])),
      new Map(analysis.classifications.map((c) => [c.atomId, c.mechanism])),
      trace,
      f.map,
      new Map(trace.records.map((r) => [r.id, r])),
      trace.records.filter((r): r is Extract<typeof r, { kind: "slider-tracking" }> => r.kind === "slider-tracking"),
      new Set(),
    );
    expect(cause.codes).toEqual(["no-tap", "released-early"]);
    expect(cause.parentEvidence?.comparison.every((c) => c.scope !== "carried-hold-consequence")).toBe(true);
  });
  it("does not use lost-part counts or linked enumeration to rank two independent attempts", () => {
    for (const length of [200, 400]) {
      const f = fixture(length, "pickup"),
        { analysis, parent, cause } = diagnosis(f);
      expect(cause.codes).toEqual(["no-tap", "released-early"]);
      const reordered = classifyParentCause(
        { ...parent, relatedAtomIds: [...parent.relatedAtomIds].reverse() },
        new Map([...analysis.inventory.atoms].reverse().map((a) => [a.id, a])),
        new Map(analysis.classifications.map((c) => [c.atomId, c.mechanism])),
        f.trace,
        f.map,
        new Map(f.trace.records.map((r) => [r.id, r])),
        f.trace.records.filter(
          (r): r is Extract<typeof r, { kind: "slider-tracking" }> => r.kind === "slider-tracking",
        ),
        new Set(),
      );
      expect(reordered.codes).toEqual(cause.codes);
      const body = cause.parentEvidence!.comparison.find(
        (c) => c.scope === "navigation" && c.groupId.startsWith("holding:"),
      )!;
      expect(body.selected).toBe(true);
      expect(body.contributionCount).toBeGreaterThan(1);
    }
  });
  it("a short repeat still breaks after a pulse repair; carried and newly initiated attempts differ", () => {
    const run = (fresh: boolean) =>
      errorFixture(
        "100,192,500,1,0\n120,192,1000,2,0,L|128:192,2,8",
        Array.from({ length: 101 }, (_, i) => {
          const t = 300 + i * 10;
          return traceFrame(t, t < 960 ? 100 : 124, t < 500 || t >= 1030 ? [] : fresh && t === 1000 ? [1, 0] : [1]);
        }),
      );
    const original = run(false),
      repaired = run(true);
    expect(diagnosis(original).cause.codes).toEqual(["no-tap"]);
    expect(repaired.state.hitCircleVerdict["1/HEAD"].type).toBe("GREAT");
    expect(repaired.state.sliderVerdict["1"]).toBe("MEH");
    expect(retrieveEvents(repaired.state, repaired.map.hitObjects, "stable")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "SliderBreak", componentType: "REPEAT", componentId: "1/0" }),
      ]),
    );
    // A tap-only repair is sufficient for the tail-only navigation case below,
    // not for every slider: the remaining repeat break stays fully diagnosed.
    expect(diagnosis(repaired).analysis.classifications.some((c) => c.mechanism.codes.includes("released-early"))).toBe(
      true,
    );
  });
  it("a brief alternate-key head tap repairs navigation without requiring a perfect tail", () => {
    const f = fixture(16, "head-tap"),
      { analysis, parent } = diagnosis(f);
    expect(f.state.hitCircleVerdict["1/HEAD"].type).toBe("GREAT");
    expect(f.state.sliderVerdict["1"]).toBe("OK");
    expect(parent.relatedAtomIds.map((id) => analysis.inventory.atoms.find((a) => a.id === id)!.component)).toEqual([
      "slider-legacy-tail",
    ]);
    const events = retrieveEvents(f.state, f.map.hitObjects, "stable");
    expect(events.some((e) => e.type === "SliderBreak")).toBe(false);
    expect(events.some((e) => e.type === "HitObjectJudgement" && e.verdict === "MISS")).toBe(false);
    expect(new GameplayInfoEvaluator(f.map).evaluateReplayState(f.state).currentCombo).toBe(2);
    // It latches the freshly tapped left side. The still-held right side is
    // not a substitute for keeping that new action down.
    expect(f.trace.records.filter((r) => r.kind === "slider-tracking" && r.componentId === "1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ timeMs: 1000, tracking: expect.objectContaining({ latch: 1, holdAccepted: true }) }),
        expect.objectContaining({
          timeMs: 1010,
          tracking: expect.objectContaining({ latch: 1, actions: [1], holdAccepted: false }),
        }),
      ]),
    );
  });
});
