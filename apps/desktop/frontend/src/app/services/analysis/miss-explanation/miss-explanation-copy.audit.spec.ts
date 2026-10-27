import { BucketedGameStateTimeMachine } from "../../../../../../../../libs/osu/core/src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../../../../../../../../libs/osu/core/src/gameplay/LazerGameStateTimeMachine";
import { deriveCircleEvidence } from "../../../../../../../../libs/osu/core/src/gameplay/miss-explanation/CircleEvidence";
import { explainCircleMiss } from "../../../../../../../../libs/osu/core/src/gameplay/miss-explanation/CircleMissExplanation";
import {
  createReplayTraceCollector,
  serializeReplayTrace,
} from "../../../../../../../../libs/osu/core/src/gameplay/trace/ReplayTraceCollector";
import { evidenceTrace } from "../../../../../../../../libs/osu/core/test/CircleEvidenceFixtures";
import { traceBeatmap, traceFrame } from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { formatMissFinding, summarizeMissExplanation } from "./miss-explanation-copy";

function capturedExplanation(profile: "stable" | "lazer", conflict: boolean) {
  const map = traceBeatmap("300,192,1000,1,0");
  const frames = [
    traceFrame(700, 300),
    traceFrame(800, 300, [0]),
    traceFrame(850, 500),
    traceFrame(900, 500, [1]),
    traceFrame(1200, 500),
  ];
  const collector = createReplayTraceCollector(
    evidenceTrace([], profile).identity,
    {
      endTimeMs: 1200,
      endpointBasis: "recorded-end",
      synthesizedEndpoint: false,
      // The declared conflict retracts the lifecycle conclusion, not the later
      // recorded position/action. All records and causal references are captured.
      sourceCoverageLimits: conflict ? ["dependency-conflict:lifecycle:0"] : [],
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
        collector,
      )
    : new LazerGameStateTimeMachine(frames, map, undefined, {}, collector)
  ).gameStateAt(1200);
  const trace = collector.seal();
  expect(() => serializeReplayTrace(trace)).not.toThrow();
  expect(trace.failures).toEqual([]);
  const evidence = deriveCircleEvidence(trace, map, "0");
  expect(evidence.terminal).toMatchObject({ timeMs: 800, mechanism: "input-miss", result: "MISS" });
  expect(evidence.terminalReferences.find((record) => record.kind === "input")).toMatchObject({ timeMs: 800 });
  return explainCircleMiss(evidence);
}

describe.each(["stable", "lazer"] as const)("%s captured miss summary audit", (profile) => {
  it("keeps later outside-action context visible without promoting it to the explanation headline", () => {
    const explanation = capturedExplanation(profile, true);
    expect(explanation.findings.find((finding) => finding.code === "input-miss")?.state).toBe("indeterminate");
    const laterAction = explanation.findings.find((finding) => finding.code === "press-outside");
    expect(laterAction).toMatchObject({
      state: "supported",
      parameters: { offsetMs: -100, postTerminal: 1 },
    });
    if (!laterAction) throw new Error("Expected the independently recorded later action to remain available");
    expect(formatMissFinding(laterAction).measurements).toContain("After the target resolved");
    // The 900ms action cannot explain the 800ms resolution. With its lifecycle
    // conclusion retracted, this fixture has context but no supported main cause.
    expect(summarizeMissExplanation(explanation)).toBe("No supported explanation is available for this circle.");
  });

  it("preserves the independently captured 800ms input attribution when lifecycle evidence is sound", () => {
    const explanation = capturedExplanation(profile, false);
    const terminal = explanation.findings.find((finding) => finding.code === "input-miss");
    expect(terminal).toMatchObject({ state: "supported", parameters: { offsetMs: -200 } });
    expect(explanation.mainFindingId).toBe(terminal?.id);
    expect(summarizeMissExplanation(explanation)).toBe("The model judged a Miss from an input.");
  });
});
