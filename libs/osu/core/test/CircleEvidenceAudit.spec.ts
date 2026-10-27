import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { explainCircleMiss } from "../src/gameplay/miss-explanation/CircleMissExplanation";
import { createReplayTraceCollector, serializeReplayTrace } from "../src/gameplay/trace/ReplayTraceCollector";
import { ScoringDomain, TraceSource } from "../src/gameplay/trace/ReplayTrace";
import { evidenceTrace } from "./CircleEvidenceFixtures";
import { traceBeatmap, traceFrame } from "./ReplayTraceFixtures";

function capture(
  profile: "stable" | "lazer",
  frames: ReturnType<typeof traceFrame>[],
  sources: TraceSource[],
  domain: Partial<ScoringDomain> = {},
) {
  const map = traceBeatmap("300,192,1000,1,0");
  const collector = createReplayTraceCollector(
    evidenceTrace([], profile).identity,
    {
      endTimeMs: frames[frames.length - 1].time,
      endpointBasis: "recorded-end",
      synthesizedEndpoint: false,
      sourceCoverageLimits: [],
      initialActionsKnown: true,
      frameSources: sources,
      ...domain,
    },
    { maxRecords: 200000, maxExportBytes: 64 * 1024 * 1024 },
  );
  const machine =
    profile === "stable"
      ? new BucketedGameStateTimeMachine(
          frames,
          map,
          { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
          undefined,
          collector,
        )
      : new LazerGameStateTimeMachine(frames, map, undefined, {}, collector);
  machine.gameStateAt(frames[frames.length - 1].time);
  const trace = collector.seal();
  // Reject fixture/schema errors before checking the predicate under audit.
  expect(() => serializeReplayTrace(trace)).not.toThrow();
  expect(Object.isFrozen(trace)).toBe(true);
  expect(trace.failures).toEqual([]);
  const evidence = deriveCircleEvidence(trace, map, "0");
  expect(evidence.terminal).toMatchObject({ result: "MISS", mechanism: "automatic-expiry" });
  return { evidence, explanation: explainCircleMiss(evidence) };
}

const parsed = (parsedFrameIndex: number): TraceSource => ({ origin: "parsed", parsedFrameIndex });

describe.each(["stable", "lazer"] as const)("%s local miss evidence audit", (profile) => {
  it("keeps a fully recorded early action domain usable when only the distant ending is synthesized", () => {
    // Every recorded button state bracketing the 1000ms circle's success window
    // is empty and consecutive. The synthetic endpoint is almost four seconds later.
    const { evidence, explanation } = capture(
      profile,
      [traceFrame(800, 500), traceFrame(1000, 500), traceFrame(1200, 500), traceFrame(5000, 500)],
      [parsed(0), parsed(1), parsed(2), { origin: "synthetic", reason: "inferred-ending" }],
      { endpointBasis: "aggregate-inferred", synthesizedEndpoint: true },
    );
    expect(evidence.domains.liveSuccess.state).toBe("nonempty");
    expect(evidence.inputs.filter((sample) => sample.inLiveSuccess).every((sample) => sample.freshActionsKnown)).toBe(
      true,
    );
    expect(evidence.dependencies.input.status).toBe("complete");
    expect(explanation.findings.find((finding) => finding.code === "no-fresh-action")).toMatchObject({
      applicable: true,
      state: "supported",
      parameters: { freshActionCount: 0 },
    });
  });

  it("keeps absence uncertain when the local end boundary itself depends on synthetic input", () => {
    const { evidence, explanation } = capture(
      profile,
      [traceFrame(800, 500), traceFrame(1200, 500)],
      [parsed(0), { origin: "synthetic", reason: "inferred-ending" }],
      { endpointBasis: "aggregate-inferred", synthesizedEndpoint: true },
    );
    expect(evidence.dependencies.input.status).toBe("partial");
    expect(explanation.findings.find((finding) => finding.code === "no-fresh-action")).toMatchObject({
      applicable: true,
      state: "indeterminate",
    });
  });

  it("keeps absence uncertain when a real source gap crosses the local success window", () => {
    const { evidence, explanation } = capture(
      profile,
      [traceFrame(800, 500), traceFrame(1200, 500)],
      [parsed(0), { origin: "parsed", parsedFrameIndex: 2, discontinuityBefore: ["dropped-token"] }],
      { sourceCoverageLimits: ["parser-malformed-token"] },
    );
    expect(evidence.dependencies.input.status).toBe("partial");
    expect(evidence.dependencies.input.reasons).toContain("source-discontinuity");
    expect(explanation.findings.find((finding) => finding.code === "no-fresh-action")).toMatchObject({
      applicable: true,
      state: "indeterminate",
    });
  });

  it("does not discard complete action coverage when only retained geometric contacts reach their cap", () => {
    // Equal-time cursor samples are isolated contacts, not invented durations.
    // All 2051 input samples remain below the independent 4096-input cap.
    const frames = [
      traceFrame(800, 500),
      ...Array.from({ length: 2049 }, () => traceFrame(1000, 300)),
      traceFrame(1200, 500),
    ];
    const { evidence, explanation } = capture(profile, frames, frames.map((_, index) => parsed(index)));
    expect(evidence.inputs).toHaveLength(frames.length);
    expect(evidence.inputs.every((sample) => sample.freshActionsKnown && sample.record.freshActions.length === 0)).toBe(
      true,
    );
    expect(evidence.limitations).toContain("evidence-interval-limit");
    expect(evidence.insideIntervals.length).toBeLessThanOrEqual(2048);
    expect(evidence.dependencies.input.status).toBe("complete");
    expect(explanation.findings.find((finding) => finding.code === "no-fresh-action")).toMatchObject({
      applicable: true,
      state: "supported",
      parameters: { freshActionCount: 0 },
    });
  });
});
