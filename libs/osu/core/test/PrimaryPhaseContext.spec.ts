import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { analyzePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproach";
import * as ownership from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function frame(time: number, x: number, y: number, actions: number[] = []) {
  return { ...traceFrame(time, x, actions), position: { x, y } };
}
function inputId(f: ReturnType<typeof errorFixture>, time: number) {
  const input = f.trace.records.find((r) => r.kind === "input" && r.timeMs === time);
  if (!input || input.kind !== "input" || !input.freshActions.length) throw new Error("missing source edge");
  return input.id;
}

/** Scope-contract test: cadence inference has its own tests. Supply two declared
 * hypotheses; actual source samples and geometric contacts remain unmocked. */
function compare(
  f: ReturnType<typeof errorFixture>,
  commonTime: number,
  alternativeTime: number,
  relevantTime: number,
) {
  const common = inputId(f, commonTime),
    alternative = inputId(f, alternativeTime),
    relevant = inputId(f, relevantTime);
  const association: ownership.PrimaryInputEvidence = {
    policyVersion: "primary-input-v4",
    relevantInputIds: [relevant],
    // The alternative was context under the current reception assignment. It
    // cannot remain a context boundary when that very input is being compared.
    contextInputIds: [common, alternative],
    associations: [
      { inputId: common, role: "context", reasons: ["prior-shared-episode"], eventIds: [common] },
      { inputId: alternative, role: "context", reasons: ["reception-assignment"], eventIds: [alternative] },
      { inputId: relevant, role: "relevant", reasons: ["current-assignment"], eventIds: [relevant] },
    ],
    limitations: [],
    stream: {
      policyVersion: "stream-input-v1",
      status: "ambiguous",
      relevantInputIds: [relevant],
      contextInputIds: [common, alternative],
      rawFreshInputIds: [alternative, relevant],
      rawFreshActionCount: 2,
      assignments: [],
      missingTargetTap: false,
      phaseAlternatives: [
        {
          phaseMs: alternativeTime - 1000,
          targetInputIds: [alternative],
          eventIds: [alternative],
          reason: "one-slot-reception-shift",
          active: true,
          recentAnchorCount: 1,
        },
      ],
      limitations: ["stream-phase-slip-alternative"],
    },
  };
  const value = deriveCircleEvidence(f.trace, f.map, "1");
  const before = JSON.stringify({ value, trace: f.trace, association });
  const spy = jest.spyOn(ownership, "derivePrimaryInputEvidence").mockReturnValue(association);
  try {
    const result = classifyCircleLoss(value, f.map, f.trace);
    expect(JSON.stringify({ value, trace: f.trace, association })).toBe(before);
    return { value, result, common, alternative, relevant };
  } finally {
    spy.mockRestore();
  }
}

describe("primary comparison shares only common source episode context", () => {
  it("does not import the previous receptor's slow footprint into a competing arrival", () => {
    // The path slows inside the previous receptor around915–966, then speeds up
    // toward the target. The target's first contact is after its beat. These are
    // authored scalar coordinates, not expected production descriptors.
    const points = [
      [800, 170, 130],
      [866, 192, 166],
      [883, 204, 178],
      [899, 215, 189],
      [907, 221, 193],
      [915, 226, 196],
      [933, 235, 198],
      [941, 237, 199],
      [949, 240, 199],
      [961, 243, 199],
      [966, 245, 199],
      [982, 253, 200],
      [988, 258, 200],
      [998, 266, 200],
      [1016, 283, 200],
      [1032, 299, 202],
      [1035, 302, 202],
      [1049, 318, 202],
      [1059, 329, 198],
      [1075, 342, 190],
      [1120, 390, 170],
      [1250, 400, 170],
    ];
    const frames = points.map(([time, x, y]) =>
      frame(time, x, y, time >= 907 && time <= 915 ? [0] : time >= 988 && time <= 998 ? [1] : time === 1059 ? [0] : []),
    );
    const f = errorFixture("232,206,922,1,0\n301,225,1000,1,0\n364,191,1078,1,0", frames);
    expect(f.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(f.state.hitCircleVerdict["1"].type).toBe("MISS");
    const e = deriveCircleEvidence(f.trace, f.map, "1");
    if (!e.geometry) throw new Error("missing prepared geometry");
    const radius = e.geometry.radius;
    expect(Math.hypot(226 - 232, 196 - 206) / radius).toBeLessThan(0.33);
    expect(Math.hypot(226 - 301, 196 - 225) / radius).toBeGreaterThan(2);
    const expectedEntry = 998 + ((301 - Math.sqrt(radius * radius - 25 * 25) - 266) / 17) * 18;
    expect(expectedEntry).toBeGreaterThan(1006);
    expect(expectedEntry).toBeLessThan(1008);
    expect(e.insideIntervals[0].startTimeMs).toBeCloseTo(expectedEntry, 8);
    const common = inputId(f, 907),
      alternative = inputId(f, 988);
    const scoped = analyzePrimaryApproaches(e, { pressIds: [alternative], contextBoundaryInputIds: [common] });
    expect(scoped.episodes[0].spatialCandidates).toEqual([]);
    expect(scoped.episodes[0].properPass?.entryTimeMs).toBeCloseTo(expectedEntry, 8);
    expect(scoped.episodes[0].relation).toBe("before-pass");

    const compared = compare(f, 907, 988, 1059);
    const episode = compared.result.diagnostics?.primary?.phaseComparison?.approaches.episodes.find(
      (item) => item.inputId === compared.alternative,
    );
    expect(episode).toBeDefined();
    expect(episode?.spatialCandidates).toEqual([]);
    expect(episode?.properPass?.entryTimeMs).toBeCloseTo(expectedEntry, 8);
    // Both phase hypotheses remain. A usable later timing correction can win
    // without claiming their labels agree or importing the previous footprint.
    expect(compared.result.status).toBe("supported");expect(compared.result.codes).toEqual(["aim-late"]);
    expect(compared.result.diagnostics?.primary?.phaseComparison?.reason).toBe("positive-correction-among-competing-phases");
    expect(compared.result.diagnostics?.primary?.phaseComparison?.approaches.episodes.every(e=>!e.spatialCandidates.length)).toBe(true);
    expect(compared.result.eventIds).toEqual(expect.arrayContaining([compared.alternative,compared.relevant]));
    const fixed=errorFixture("232,206,922,1,0\n301,225,1000,1,0\n364,191,1078,1,0",
      frames.map(q=>q.time>=1016&&q.time<1059?{...q,actions:[...q.actions,0]}:q));
    expect(fixed.state.hitCircleVerdict["1"]).toMatchObject({type:"GREAT",judgementTime:1016});
    for(const id of ["0","2"])expect(fixed.state.hitCircleVerdict[id]).toEqual(f.state.hitCircleVerdict[id]);
  });

  it("never makes a competing input a boundary that erases another candidate's valid pass", () => {
    const f = errorFixture("180,192,900,1,0\n300,192,1000,1,0", [
      traceFrame(800, 100),
      traceFrame(900, 180, [0]),
      traceFrame(920, 190),
      traceFrame(970, 210),
      traceFrame(990, 270),
      traceFrame(1000, 300),
      traceFrame(1010, 330),
      traceFrame(1020, 360),
      traceFrame(1030, 390, [1]),
      traceFrame(1035, 405),
      traceFrame(1040, 420, [0]),
      traceFrame(1050, 450),
      traceFrame(1200, 900),
    ]);
    expect(f.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(f.state.hitCircleVerdict["1"].type).toBe("MISS");
    const compared = compare(f, 900, 1030, 1040);
    const episodes = compared.result.diagnostics?.primary?.phaseComparison?.approaches.episodes;
    expect(episodes).toHaveLength(2);
    for (const episode of episodes ?? []) {
      expect(episode.properPass?.closestOffsetMs).toBeCloseTo(0, 8);
      expect(episode.relation).toBe("after-pass");
    }
    expect(compared.result.headline).toBe("Late tap");
    expect(compared.result.limitations).toContain("stream-ownership-alternatives-compared");
  });
});
