import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import * as streams from "../src/gameplay/error-analysis/StreamInputEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function blockedTarget() {
  return errorFixture("100,192,1000,1,0\n300,192,1050,1,0\n500,192,1130,1,0", [
    traceFrame(800, 0),
    traceFrame(1030, 300, [0]),
    traceFrame(1040, 400),
    traceFrame(1100, 500, [1]),
    traceFrame(1110, 500),
    traceFrame(1300, 500),
  ]);
}

describe("direct target rejection survives inferred stream ownership", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ["previous slot with another relevant input", true, false, false],
    ["previous slot with active alternative and another input", true, true, false],
    ["previous slot with inactive alternative and no selected input", false, false, false],
    ["ambiguous ownership with active alternatives", false, true, true],
    ["ambiguous ownership without active alternatives", true, false, true],
  ] as const)("retains otherwise-valid Notelock: %s", (_label, selected, active, ambiguous) => {
    const fixture = blockedTarget();
    const evidence = deriveCircleEvidence(fixture.trace, fixture.map, "1");
    const direct = evidence.inputs.find((i) => i.record.timeMs === 1030)!;
    const inferred = evidence.inputs.find((i) => i.record.timeMs === 1100)!;
    const policy = evidence.routing.find((r) => r.kind === "policy" && r.componentId === "1")!;
    // The expectations start from source-authored coordinates/time and real engine rejection.
    expect(direct).toMatchObject({ inside: true, freshActionsKnown: true, inLiveSuccess: true, postTerminal: false });
    expect(direct.record.freshActions).toEqual([0]);
    expect(policy).toMatchObject({
      kind: "policy",
      state: "rejected",
      timingResult: "GREAT",
      offsetMs: -20,
      blockerId: "0",
    });
    expect(fixture.state.hitCircleVerdict["1"].type).toBe("MISS");
    expect(evidence.terminal?.mechanism).toBe("automatic-expiry");
    const shared = streams.deriveStreamInputEvidence(evidence, fixture.map, fixture.trace);
    const ownership: streams.StreamInputEvidence = {
      ...shared,
      status: ambiguous ? "ambiguous" : "supported",
      relevantInputIds: selected ? [inferred.record.id] : [],
      assignments: [
        {
          inputId: direct.record.id,
          componentId: ambiguous ? undefined : "0",
          relation: ambiguous ? "ambiguous" : "matched",
          confidence: ambiguous ? "ambiguous" : "corroborated",
          eventIds: [direct.record.id],
        },
        {
          inputId: inferred.record.id,
          componentId: "1",
          relation: "matched",
          confidence: "corroborated",
          eventIds: [inferred.record.id],
        },
      ],
      phaseAlternatives: [
        {
          active,
          targetInputIds: [direct.record.id],
          reason: "one-slot-reception-shift",
          phaseMs: -20,
          eventIds: [direct.record.id],
          recentAnchorCount: 0,
        },
      ],
      limitations: ambiguous ? ["unresolved-stream-input"] : [],
    };
    jest.spyOn(streams, "deriveStreamInputEvidence").mockReturnValue(ownership);
    const before = JSON.stringify(ownership);
    const result = classifyCircleLoss(evidence, fixture.map, fixture.trace);
    expect(result.status).toBe("supported");
    expect(result.codes).toEqual(["notelock"]);
    expect(result.headline).toBe("Notelock");
    expect(result.eventIds).toEqual(expect.arrayContaining([direct.record.id, policy.id]));
    expect(result.diagnostics?.primary?.association.stream).toEqual(ownership);
    if (!ambiguous) expect(result.diagnostics?.primary?.association.relevantInputIds).not.toContain(direct.record.id);
    expect(JSON.stringify(ownership)).toBe(before);
  });
});
