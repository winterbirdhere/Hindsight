import { assessFreshActionAbsence, deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { activation, evidenceMap, evidenceTrace, expiry, input } from "./CircleEvidenceFixtures";
import { traceBeatmap } from "./ReplayTraceFixtures";
import { createReplayTraceCollector } from "../src/gameplay/trace/ReplayTraceCollector";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { traceFrame } from "./ReplayTraceFixtures";

describe("circle evidence", () => {
  it("reuses one trace index across different targets", () => {
    const source = evidenceTrace([
      activation(),
      input(880, 500),
      expiry(),
      expiry(1150, { componentId: "1" }),
      input(1200, 500, [], [], 1),
    ]);
    let reads = 0;
    const trace = {
      ...source,
      get records() {
        reads++;
        return source.records;
      },
    };
    expect(deriveCircleEvidence(trace, evidenceMap(), "0").terminal?.componentId).toBe("0");
    expect(deriveCircleEvidence(trace, evidenceMap(), "1").terminal?.componentId).toBe("1");
    expect(reads).toBe(1);
  });
  it("limits isolated contacts without replacing them by invented durations", () => {
    const e = deriveCircleEvidence(
      evidenceTrace([
        activation(),
        ...Array.from({ length: 2100 }, (_, i) => input(1000, 300, [], [], i)),
        expiry(),
        input(1200, 500, [], [], 2100),
      ]),
      evidenceMap(),
      "0",
    );
    expect(e.insideIntervals.length).toBeLessThan(2100);
    expect(e.insideIntervals.every((interval) => interval.kind === "point")).toBe(true);
    expect(e.limitations).toContain("evidence-interval-limit");
  });
  it("bounds related routing records independently of the input count", () => {
    const attempts = Array.from({ length: 33000 }, (_, attemptOrdinal) => ({
      kind: "attempt",
      phase: "attempt",
      timeMs: 1000,
      inputId: "r2",
      attemptOrdinal,
      actionCandidates: [0],
    }));
    const e = deriveCircleEvidence(
      evidenceTrace([
        activation(),
        input(880, 500),
        input(1000, 500, [0], [0], 1),
        ...attempts,
        expiry(),
        input(1200, 500, [], [], 2),
      ]),
      evidenceMap(),
      "0",
    );
    expect(e.attempts.length).toBeLessThan(attempts.length);
    expect(e.limits.truncated).toBe(true);
    expect(e.limitations).toContain("evidence-related-record-limit");
    expect(e.dependencies.routing.status).toBe("partial");
  });
  it.each(["stable", "lazer"])(
    "preserves exact profile containment on and just beyond its effective radius: %s",
    (profile) => {
      const map = evidenceMap();
      map.getHitCircle("0").scale = 0.5;
      const x = profile === "stable" ? 332.01 : 332;
      const e = deriveCircleEvidence(
        evidenceTrace(
          [
            activation(),
            input(880, 500),
            input(950, x, [0], [0], 1),
            input(1000, 332.1, [1], [1], 2),
            expiry(),
            input(1200, 500, [], [], 3),
          ],
          profile,
        ),
        map,
        "0",
      );
      expect(e.inputs.filter((i) => i.record.freshActions.length).map((i) => i.inside)).toEqual([true, false]);
    },
  );
  it("rejects unsupported modifications explicitly", () => {
    const map = evidenceMap();
    map.appliedMods.push("HARD_ROCK");
    const e = deriveCircleEvidence(evidenceTrace([activation(), input(900, 500), expiry()]), map, "0");
    expect(e.status).toBe("unsupported");
    expect(e.limitations).toContain("unsupported-profile");
  });
  it.each(["stable", "lazer"])("uses actual captured lifecycle and local source coverage for %s", (profile) => {
    const map = evidenceMap();
    const frames = [traceFrame(800), traceFrame(1200)];
    const c = createReplayTraceCollector(
      evidenceTrace([], profile).identity,
      {
        endTimeMs: 1200,
        endpointBasis: "recorded-end",
        synthesizedEndpoint: false,
        sourceCoverageLimits: [],
        initialActionsKnown: true,
        frameSources: frames.map((_, parsedFrameIndex) => ({ origin: "parsed", parsedFrameIndex })),
      },
      { maxRecords: 1000, maxExportBytes: 1000000 },
    );
    const machine =
      profile === "stable"
        ? new BucketedGameStateTimeMachine(
            frames,
            map,
            { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
            undefined,
            c,
          )
        : new LazerGameStateTimeMachine(frames, map, undefined, {}, c);
    machine.gameStateAt(1200);
    const trace = c.seal();
    expect(trace.coverage.geometry).toBe("partial");
    expect(trace.complete).toBe(false);
    const e = deriveCircleEvidence(trace, map, "0");
    expect(e.status).toBe("supported");
    expect(e.domains.liveSuccess.state).toBe("nonempty");
    expect(e.dependencies.input.status).toBe("complete");
  });
  it("retains later fully covered action domains despite an unknown beginning or an earlier parser gap", () => {
    const trace = evidenceTrace(
      [
        activation(),
        input(600, 500, [0]),
        input(700, 500, [], [], 4, {
          source: { origin: "parsed", parsedFrameIndex: 4, discontinuityBefore: ["dropped-token"] },
        }),
        input(800, 500, [], [], 5),
        expiry(),
        input(1200, 500, [], [], 6),
      ],
      "stable",
      {
        complete: false,
        coverage: { input: "partial", geometry: "partial", routing: "complete", lifecycle: "complete" },
      },
    );
    trace.domain.initialActionsKnown = false;
    trace.domain.sourceCoverageLimits = ["initial-actions-unknown", "parser-malformed-token"];
    expect(deriveCircleEvidence(trace, evidenceMap(), "0").dependencies.input.status).toBe("complete");
  });
  it("does not claim complete source coverage at an inferred synthetic endpoint", () => {
    const trace = evidenceTrace([
      activation(),
      input(800, 500),
      expiry(),
      input(1200, 500, [], [], 1, { source: { origin: "synthetic", reason: "endpoint" } }),
    ]);
    trace.domain.synthesizedEndpoint = true;
    trace.domain.endpointBasis = "aggregate-inferred";
    expect(deriveCircleEvidence(trace, evidenceMap(), "0").dependencies.input.status).toBe("partial");
  });
  it("bounds per-target evidence and marks truncation explicitly", () => {
    const records = [
      activation(),
      ...Array.from({ length: 4100 }, (_, i) => input(900 + i / 100, 500, [], [], i)),
      expiry(),
      input(1200, 500, [], [], 4100),
    ];
    const e = deriveCircleEvidence(evidenceTrace(records), evidenceMap(), "0");
    expect(e.inputs.length).toBeLessThan(records.length - 2);
    expect(e.limits.truncated).toBe(true);
    expect(e.limitations).toContain("evidence-input-limit");
    expect(e.dependencies.input.status).toBe("partial");
  });
  it.each([
    ["nonempty", "complete", 0, true, "supported"],
    ["nonempty", "complete", 1, true, "not-supported"],
    ["nonempty", "partial", 0, true, "indeterminate"],
    ["nonempty", "partial", 1, true, "not-supported"],
    ["empty", "complete", 0, false, "indeterminate"],
    ["unknown", "complete", 0, false, "indeterminate"],
  ] as const)("absence %s/%s/%i", (domain, actionCoverage, freshActionCount, applicable, state) => {
    expect(assessFreshActionAbsence({ domain, actionCoverage, freshActionCount })).toMatchObject({ applicable, state });
  });
  it.each([-1, 0.5, NaN, Infinity])("rejects invalid action count %s", (freshActionCount) => {
    expect(() =>
      assessFreshActionAbsence({ domain: "nonempty", actionCoverage: "complete", freshActionCount }),
    ).toThrow();
  });
  it("keeps event-bound same-time positions and both sides of an unselected circle", () => {
    const e = deriveCircleEvidence(
      evidenceTrace([
        activation(),
        input(880, 500),
        input(1000, 500, [0], [0], 1),
        input(1000, 300, [], [], 2),
        input(1000, 300, [0, 1], [0, 1], 3),
        expiry(),
        input(1200, 500, [], [], 4),
      ]),
      evidenceMap(),
      "0",
    );
    expect(
      e.inputs
        .filter((i) => i.record.timeMs === 1000)
        .map((i) => [i.record.id, i.inside, i.record.freshActions.length]),
    ).toEqual([
      ["r2", false, 1],
      ["r3", true, 0],
      ["r4", true, 2],
    ]);
    expect(e.domains.liveSuccess).toMatchObject({ state: "nonempty", start: { timeMs: 891 }, end: { timeMs: 1109 } });
  });
  it("clips early terminal before nominal success and preserves contextual later entry", () => {
    const e = deriveCircleEvidence(
      evidenceTrace([
        activation(),
        input(700, 500),
        input(800, 300, [0], [0], 1),
        expiry(800, { mechanism: "input-miss" }),
        input(950, 500, [], [], 2),
        input(1000, 300, [], [], 3),
        input(1200, 500, [], [], 4),
      ]),
      evidenceMap(),
      "0",
    );
    expect(e.domains.liveSuccess.state).toBe("empty");
    expect(e.inputs.find((i) => i.record.timeMs === 1000)?.postTerminal).toBe(true);
  });
  it("uses lifecycle sequence at equal timestamps and terminal sequence", () => {
    const map = evidenceMap();
    map.getHitCircle("0").approachDuration = 0;
    const stable = deriveCircleEvidence(
      evidenceTrace([
        input(900, 500),
        input(1000, 300, [0], [0], 1),
        activation(1000),
        input(1000, 300, [1], [1], 2),
        expiry(1000),
        input(1000, 300, [0], [0], 3),
      ]),
      map,
      "0",
    );
    expect(stable.inputs.filter((i) => i.record.timeMs === 1000).map((i) => i.inLiveSuccess)).toEqual([
      false,
      true,
      false,
    ]);
    const native = deriveCircleEvidence(
      evidenceTrace([input(900, 500), activation(1000), input(1000, 300, [0], [0], 1), expiry(1000)], "lazer"),
      map,
      "0",
    );
    expect(native.inputs.find((i) => i.record.timeMs === 1000)?.inLiveSuccess).toBe(true);
  });
  it("missing lifecycle leaves local geometry available and the live domain unknown", () => {
    const e = deriveCircleEvidence(
      evidenceTrace([input(900, 500), input(1000, 500, [0], [0], 1), expiry()]),
      evidenceMap(),
      "0",
    );
    expect(e.domains.liveSuccess.state).toBe("unknown");
    expect(e.inputs.find((i) => i.record.timeMs === 1000)?.inside).toBe(false);
  });
  it("does not certify the first new action when initial state is unknown", () => {
    const trace = evidenceTrace([activation(), input(1000, 500, [0]), expiry(), input(1200, 500, [], [], 1)]);
    trace.domain.initialActionsKnown = false;
    const e = deriveCircleEvidence(trace, evidenceMap(), "0");
    expect(e.inputs.find((i) => i.record.timeMs === 1000)?.freshActionsKnown).toBe(false);
    expect(e.dependencies.input.status).toBe("partial");
  });
  it("reconstructs multiple crossings and does not bridge gaps, same-time jumps or synthetic endpoints", () => {
    const e = deriveCircleEvidence(
      evidenceTrace([
        activation(),
        input(880, 200),
        input(940, 400, [], [], 1),
        input(1000, 200, [], [], 2),
        input(1000, 400, [], [], 3),
        input(1060, 200, [], [], 4, {
          source: { origin: "parsed", parsedFrameIndex: 4, discontinuityBefore: ["dropped-token"] },
        }),
        expiry(),
        input(1200, 400, [], [], 5, { source: { origin: "synthetic", reason: "endpoint" } }),
      ]),
      evidenceMap(),
      "0",
    );
    expect(e.insideIntervals).toHaveLength(2);
    expect(e.insideIntervals.every((i) => i.approximate && i.kind === "interval")).toBe(true);
    expect(e.insideIntervals.flatMap((i) => i.eventIds)).not.toContain("r6");
    expect(e.dependencies.input.status).toBe("partial");
  });
  it("keeps tangent contact as a point and censors a window starting inside", () => {
    const map = evidenceMap();
    map.getHitCircle("0").scale = 0.5;
    const tangent = deriveCircleEvidence(
      evidenceTrace(
        [
          activation(),
          input(900, 200, [], [], 0, { position: { x: 200, y: 224 } }),
          input(1100, 400, [], [], 1, { position: { x: 400, y: 224 } }),
          expiry(),
          input(1200, 500, [], [], 2),
        ],
        "lazer",
      ),
      map,
      "0",
    );
    expect(tangent.insideIntervals[0]).toMatchObject({ kind: "point", startTimeMs: 1000, endTimeMs: 1000 });
    const censored = deriveCircleEvidence(
      evidenceTrace([activation(), input(900, 300), input(1200, 300, [], [], 1), expiry(1200)], "lazer"),
      map,
      "0",
    );
    expect(censored.insideIntervals[0]).toMatchObject({ leftCensored: true, rightCensored: true });
  });
  it("does not treat missing, noncircle, success or future objects as a missed circle", () => {
    const trace = evidenceTrace([
      activation(),
      input(900, 300),
      expiry(1000, { result: "GREAT", mechanism: "successful-input" }),
    ]);
    expect(deriveCircleEvidence(trace, evidenceMap(), "missing").status).toBe("unsupported");
    expect(deriveCircleEvidence(trace, traceBeatmap("300,192,1000,2,0,L|340:192,1,40"), "0").status).toBe(
      "unsupported",
    );
    expect(deriveCircleEvidence(trace, evidenceMap(), "0").status).toBe("not-missed");
    expect(deriveCircleEvidence(trace, evidenceMap(), "1").status).toBe("unjudged");
  });
});
