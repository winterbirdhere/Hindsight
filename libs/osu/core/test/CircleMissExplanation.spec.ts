import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { explainCircleMiss } from "../src/gameplay/miss-explanation/CircleMissExplanation";
import { activation, evidenceMap, evidenceTrace, expiry, input } from "./CircleEvidenceFixtures";
import { createReplayTraceCollector } from "../src/gameplay/trace/ReplayTraceCollector";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { traceBeatmap, traceFrame } from "./ReplayTraceFixtures";

describe("circle miss explanations", () => {
  it.each(["stable", "lazer"])(
    "does not assign a later same-frame attempt to an already terminated %s target",
    (profile) => {
      const map = traceBeatmap("300,192,1000,1,0\n300,192,1050,1,0");
      const frames = [traceFrame(700), traceFrame(800, 300, [0, 1]), traceFrame(1200)];
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
      (profile === "stable"
        ? new BucketedGameStateTimeMachine(
            frames,
            map,
            { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
            undefined,
            c,
          )
        : new LazerGameStateTimeMachine(frames, map, undefined, {}, c)
      ).gameStateAt(1200);
      const e = explainCircleMiss(deriveCircleEvidence(c.seal(), map, "0"));
      expect(e.findings.find((f) => f.code === "input-miss")?.state).toBe("supported");
      expect(e.findings.filter((f) => f.code === "dispatch-stopped" && f.state === "supported")).toEqual([]);
    },
  );
  it("retracts derived interception on an input dependency conflict while retaining independent expiry", () => {
    const trace = evidenceTrace(
      [
        activation(),
        input(1000, 300, [0], [0], 0),
        { kind: "attempt", phase: "attempt", timeMs: 1000, inputId: "r1", attemptOrdinal: 0, actionCandidates: [0] },
        {
          kind: "selection",
          phase: "dispatch",
          timeMs: 1000,
          attemptId: "r2",
          componentId: "1",
          component: "circle",
          inside: true,
          eligible: true,
          selectionStopped: true,
        },
        expiry(),
        input(1200, 300, [], [], 1),
      ],
      "stable",
      { failures: ["dependency-conflict:input:0"] },
    );
    const e = explainCircleMiss(deriveCircleEvidence(trace, evidenceMap(), "0"));
    expect(e.findings.find((f) => f.code === "dispatch-stopped")).toMatchObject({
      state: "indeterminate",
      dependencies: expect.arrayContaining(["input"]),
      reasons: expect.arrayContaining(["dependency-conflict:input:0"]),
    });
    expect(e.findings.find((f) => f.code === "automatic-expiry")?.state).toBe("supported");
  });
  it.each(["stable", "lazer"])("derives intercepted P2 and outside P1 from an actual %s capture", (profile) => {
    const map = traceBeatmap("300,192,1000,1,0\n300,192,1050,1,0");
    const frames = [
      traceFrame(800, 500),
      traceFrame(950, 500, [0]),
      traceFrame(970, 300),
      traceFrame(1000, 300, [1]),
      traceFrame(1200, 500),
    ];
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
    const e = explainCircleMiss(deriveCircleEvidence(c.seal(), map, "1"));
    expect(e.findings.find((f) => f.code === "press-outside")).toMatchObject({
      state: "supported",
      parameters: { offsetMs: -100 },
    });
    expect(e.findings.find((f) => f.code === "dispatch-stopped")).toMatchObject({
      state: "supported",
      parameters: { offsetMs: -50 },
    });
    expect(e.findings.find((f) => f.code === "all-fresh-actions-outside")?.state).toBe("not-supported");
  });
  it("exports the nonempty quantified domain and its event boundaries", () => {
    const e = explainCircleMiss(
      deriveCircleEvidence(
        evidenceTrace([activation(900), input(900, 300), expiry(1050), input(1200, 300, [], [], 1)]),
        evidenceMap(),
        "0",
      ),
    );
    const absence = e.findings.find((f) => f.code === "no-fresh-action");
    expect(absence?.parameters).toMatchObject({ domainStartTimeMs: 900, domainEndTimeMs: 1050 });
    expect(absence?.eventIds).toEqual(expect.arrayContaining(["r0", "r2"]));
  });
  it.each(["input-miss", "ordered-force-miss"])("requires the causal link for a supported %s finding", (mechanism) => {
    const e = explainCircleMiss(
      deriveCircleEvidence(
        evidenceTrace([activation(), input(880, 500), expiry(1000, { mechanism }), input(1200, 500, [], [], 1)]),
        evidenceMap(),
        "0",
      ),
    );
    expect(e.findings.find((f) => f.code === mechanism)?.state).toBe("indeterminate");
    expect(e.findings.find((f) => f.code === mechanism)?.reasons).toContain("missing-terminal-reference");
    expect(e.findings.find((f) => f.code === "no-fresh-action")?.state).toBe("supported");
  });
  it("does not use a wrong-kind terminal reference as a causal input", () => {
    const e = explainCircleMiss(
      deriveCircleEvidence(
        evidenceTrace([
          activation(),
          input(880, 500),
          expiry(1000, { mechanism: "input-miss", triggerAttemptId: "r1" }),
          input(1200, 500, [], [], 1),
        ]),
        evidenceMap(),
        "0",
      ),
    );
    expect(e.findings.find((f) => f.code === "input-miss")?.state).toBe("indeterminate");
    expect(e.findings.find((f) => f.code === "input-miss")?.parameters).not.toHaveProperty("offsetMs");
  });
  it("retracts input-dependent claims for a localized input conflict while retaining terminal facts", () => {
    const trace = evidenceTrace(
      [activation(), input(880, 500), input(1000, 500, [0], [0], 1), expiry(), input(1200, 500, [], [], 2)],
      "stable",
      { failures: ["dependency-conflict:input:0"] },
    );
    const e = explainCircleMiss(deriveCircleEvidence(trace, evidenceMap(), "0"));
    expect(e.findings.find((f) => f.code === "press-outside")?.state).toBe("indeterminate");
    expect(e.findings.find((f) => f.code === "no-fresh-action")?.state).toBe("indeterminate");
    expect(e.findings.find((f) => f.code === "automatic-expiry")?.state).toBe("supported");
  });
  it("does not treat a conflicted inside position as an overlap counterexample", () => {
    const trace = evidenceTrace(
      [activation(), input(880, 300), input(1000, 300, [0], [0], 1), expiry(), input(1200, 300, [], [], 2)],
      "stable",
      { failures: ["dependency-conflict:geometry:0"] },
    );
    const e = explainCircleMiss(deriveCircleEvidence(trace, evidenceMap(), "0"));
    expect(e.findings.find((f) => f.code === "overlap-without-fresh-action")?.state).toBe("indeterminate");
  });
  it("does not headline pre-activation context after retracting the terminal dependency", () => {
    const trace = evidenceTrace(
      [
        input(100, 500),
        input(200, 500, [0], [0], 1),
        activation(),
        input(880, 300, [], [], 2),
        expiry(),
        input(1200, 300, [], [], 3),
      ],
      "stable",
      { failures: ["dependency-conflict:lifecycle:0"] },
    );
    const e = explainCircleMiss(deriveCircleEvidence(trace, evidenceMap(), "0"));
    expect(e.findings.some((f) => f.code === "press-outside" && f.eventIds.includes("r1"))).toBe(false);
    expect(e.mainFindingId).toBeUndefined();
  });
  it("preserves quantified summary findings when the event finding budget is exhausted", () => {
    const records = [
      activation(),
      input(880, 500),
      ...Array.from({ length: 600 }, (_, i) => input(900 + i / 10, 500, [i % 2], [i % 2], i + 1)),
      expiry(),
      input(1200, 500, [], [], 601),
    ];
    const e = explainCircleMiss(deriveCircleEvidence(evidenceTrace(records), evidenceMap(), "0"));
    expect(e.findings.length).toBeLessThanOrEqual(512);
    expect(e.limitations).toContain("finding-limit:512");
    expect(e.findings.find((f) => f.code === "all-fresh-actions-outside")?.state).toBe("supported");
  });
  it("labels entry and exit as reconstructed event relationships without bridging a gap", () => {
    const e = explainCircleMiss(
      deriveCircleEvidence(
        evidenceTrace([
          activation(),
          input(880, 500),
          input(900, 500, [0], [0], 1),
          input(950, 300, [], [], 2),
          input(1000, 500, [1], [1], 3),
          expiry(),
          input(1200, 500, [], [], 4),
        ]),
        evidenceMap(),
        "0",
      ),
    );
    const entry = e.findings.find((f) => f.code === "entry-after-press");
    expect(entry?.state).toBe("supported");
    expect(entry?.bases).toContain("reconstructed-path");
    expect(entry?.eventIds).toEqual(expect.arrayContaining(["r2", "r3"]));
    expect(e.findings.find((f) => f.code === "exit-before-press")?.eventIds).toEqual(
      expect.arrayContaining(["r3", "r4"]),
    );
  });
  it("keeps directly traced policy rejection even when activation is missing", () => {
    const e = explainCircleMiss(
      deriveCircleEvidence(
        evidenceTrace([
          input(880, 300),
          input(950, 300, [0], [0], 1),
          { kind: "attempt", phase: "attempt", timeMs: 950, inputId: "r1", attemptOrdinal: 0, actionCandidates: [0] },
          {
            kind: "policy",
            phase: "dispatch",
            timeMs: 950,
            attemptId: "r2",
            componentId: "0",
            blockerId: "1",
            state: "rejected",
            branch: "stable",
            timingResult: "MEH",
            offsetMs: -50,
          },
          expiry(),
          input(1200, 300, [], [], 2),
        ]),
        evidenceMap(),
        "0",
      ),
    );
    expect(e.findings.find((f) => f.code === "order-blocked")?.state).toBe("supported");
  });
  it("does not claim an all-outside counterexample from known conflicting geometry", () => {
    const trace = evidenceTrace(
      [activation(), input(880, 300), input(1000, 300, [0], [0], 1), expiry(), input(1200, 300, [], [], 2)],
      "stable",
      { failures: ["dependency-conflict:geometry:0"] },
    );
    const e = explainCircleMiss(deriveCircleEvidence(trace, evidenceMap(), "0"));
    expect(e.findings.find((f) => f.code === "all-fresh-actions-outside")?.state).toBe("indeterminate");
  });
  it("preserves outside P1 and inside P2 consumed elsewhere without an all-outside headline", () => {
    const trace = evidenceTrace([
      activation(),
      input(880, 500),
      input(950, 500, [0], [0], 1),
      input(970, 300, [], [], 2),
      input(1000, 300, [1], [1], 3),
      {
        kind: "attempt",
        phase: "attempt",
        timeMs: 1000,
        inputId: "r4",
        attemptOrdinal: 0,
        actionCandidates: [1],
        knownAction: 1,
      },
      {
        kind: "selection",
        phase: "dispatch",
        timeMs: 1000,
        attemptId: "r5",
        componentId: "1",
        component: "circle",
        inside: true,
        eligible: true,
        selectionStopped: true,
      },
      expiry(),
      input(1200, 500, [], [], 4),
    ]);
    const e = explainCircleMiss(deriveCircleEvidence(trace, evidenceMap(), "0"));
    expect(e.findings.find((f) => f.code === "press-outside")?.eventIds).toContain("r2");
    expect(e.findings.find((f) => f.code === "dispatch-stopped")?.eventIds).toEqual(
      expect.arrayContaining(["r4", "r5", "r6"]),
    );
    expect(e.findings.find((f) => f.code === "all-fresh-actions-outside")?.state).toBe("not-supported");
    expect(e.findings[0].code).toBe("automatic-expiry");
    expect(e.mainFindingId).toBe(e.findings[0].id);
  });
  it("supports complete nonempty absence but never vacuous all-outside", () => {
    const e = explainCircleMiss(
      deriveCircleEvidence(
        evidenceTrace([activation(), input(880, 300), expiry(), input(1200, 300, [], [], 1)]),
        evidenceMap(),
        "0",
      ),
    );
    expect(e.findings.find((f) => f.code === "no-fresh-action")).toMatchObject({
      state: "supported",
      applicable: true,
    });
    expect(e.findings.find((f) => f.code === "all-fresh-actions-outside")).toMatchObject({
      state: "indeterminate",
      applicable: false,
    });
    expect(e.findings.find((f) => f.code === "overlap-without-fresh-action")?.state).toBe("supported");
    expect(e.findings[0].parameters).not.toHaveProperty("offsetMs");
  });
  it("early input terminal has its own offset and suppresses empty-domain absence", () => {
    const e = explainCircleMiss(
      deriveCircleEvidence(
        evidenceTrace([
          activation(),
          input(700, 300),
          input(800, 300, [0], [0], 1),
          { kind: "attempt", phase: "attempt", timeMs: 800, inputId: "r2", attemptOrdinal: 0, actionCandidates: [0] },
          expiry(800, { mechanism: "input-miss", triggerAttemptId: "r3" }),
          input(1200, 300, [], [], 2),
        ]),
        evidenceMap(),
        "0",
      ),
    );
    expect(e.findings[0]).toMatchObject({ code: "input-miss", parameters: { offsetMs: -200 } });
    expect(e.findings.find((f) => f.code === "no-fresh-action")).toMatchObject({
      state: "indeterminate",
      applicable: false,
    });
  });
  it("retains forced resolution identity even when the trigger is another miss", () => {
    const e = explainCircleMiss(
      deriveCircleEvidence(
        evidenceTrace(
          [
            activation(),
            input(900, 500),
            expiry(1050, { mechanism: "ordered-force-miss", triggerResolutionId: "r3" }),
            expiry(1050, { componentId: "1", mechanism: "input-miss" }),
            input(1200, 500, [], [], 1),
          ],
          "lazer",
        ),
        evidenceMap(),
        "0",
      ),
    );
    expect(e.findings[0]).toMatchObject({ code: "ordered-force-miss", eventIds: ["r2", "r3"] });
  });
  it("does not reverse blocker direction, or erase geometry for a routing conflict", () => {
    const trace = evidenceTrace(
      [
        activation(),
        input(880, 500),
        input(1000, 500, [0], [0], 1),
        { kind: "attempt", phase: "attempt", timeMs: 1000, inputId: "r2", attemptOrdinal: 0, actionCandidates: [0] },
        {
          kind: "policy",
          phase: "dispatch",
          timeMs: 1000,
          attemptId: "r3",
          componentId: "1",
          blockerId: "0",
          state: "rejected",
          branch: "stable",
          timingResult: "MEH",
          offsetMs: -50,
        },
        expiry(),
        input(1200, 500, [], [], 2),
      ],
      "stable",
      {
        coverage: { input: "complete", geometry: "partial", routing: "partial", lifecycle: "complete" },
        failures: ["global-totals-mismatch"],
      },
    );
    const e = explainCircleMiss(deriveCircleEvidence(trace, evidenceMap(), "0"));
    expect(e.findings.some((f) => f.code === "order-blocked")).toBe(false);
    expect(e.findings.find((f) => f.code === "press-outside")?.state).toBe("supported");
    expect(e.limitations).toContain("global-totals-mismatch");
  });
});
