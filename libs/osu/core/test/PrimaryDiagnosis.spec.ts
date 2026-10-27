import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { createReplayTraceCollector } from "../src/gameplay/trace/ReplayTraceCollector";
import { traceFrame, traceMapText, normalizeTraceState } from "./ReplayTraceFixtures";
import * as approaches from "../src/gameplay/error-analysis/PrimaryApproach";

function diagnosed(frames: ReturnType<typeof traceFrame>[], objects = "300,192,1000,1,0", target = "0") {
  const map = buildBeatmap(
    parseBlueprint(traceMapText(objects).replace("OverallDifficulty:9", "OverallDifficulty:10")),
    {
      addStacking: false,
      mods: [],
    },
  );
  const collector = createReplayTraceCollector(
    {
      schemaVersion: 2,
      replayContentSha256: null,
      beatmapContentSha256: null,
      beatmapMd5: null,
      generationKey: "primary-synthetic",
      recordingClient: "stable",
      analysisProfileId: "stable",
      analysisProfileFingerprint: "primary-synthetic",
      parserVersion: "test",
      inputPreparationVersion: "test",
    },
    {
      endTimeMs: frames[frames.length - 1].time,
      endpointBasis: "recorded-end",
      synthesizedEndpoint: false,
      sourceCoverageLimits: [],
      initialActionsKnown: true,
      frameSources: frames.map((_, parsedFrameIndex) => ({ origin: "parsed", parsedFrameIndex })),
    },
    { maxRecords: 200000, maxExportBytes: 64 * 1024 * 1024 },
  );
  const machine = new BucketedGameStateTimeMachine(
    frames,
    map,
    { noteLockStyle: "STABLE", hitWindowStyle: "OSU_STABLE" },
    undefined,
    collector,
  );
  const state = machine.gameStateAt(Infinity),
    trace = collector.seal(),
    evidence = deriveCircleEvidence(trace, map, target);
  const before = JSON.stringify({ state: normalizeTraceState(state), trace, frames });
  const result = classifyCircleLoss(evidence, map, trace);
  expect(JSON.stringify({ state: normalizeTraceState(state), trace, frames })).toBe(before);
  return { result, evidence, state, trace, map };
}

describe("primary cause separates musical tapping from local arrival", () => {
  it("50 ms early inside is an accuracy loss, not a miss or Late entry", () => {
    const f = diagnosed([traceFrame(0), traceFrame(900), traceFrame(950, 300, [0]), traceFrame(1200)]);
    expect(f.state.hitCircleVerdict["0"].type).toBe("OK");
    expect(f.result.headline).toBe("Early tap");
  });
  it("50 ms early outside with a proper on-time arrival is Early tap on expiry", () => {
    const f = diagnosed([
      traceFrame(0, 220),
      traceFrame(940, 240),
      traceFrame(950, 245, [0]),
      traceFrame(980, 245),
      traceFrame(1000),
      traceFrame(1200),
    ]);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(f.evidence.terminal?.mechanism).toBe("automatic-expiry");
    expect(f.result.headline).toBe("Early tap");
    expect(f.result.metric).toEqual({ value: 50, unit: "ms early" });
  });
  it("near-on-time tap during an appropriate but late incoming approach is Late entry", () => {
    const f = diagnosed([
      traceFrame(0, 240),
      traceFrame(990, 250),
      traceFrame(1001, 260, [0]),
      traceFrame(1010, 280),
      traceFrame(1020),
      traceFrame(1200),
    ]);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(f.result.headline).toBe("Late entry");
    expect(f.result.codes).not.toContain("early-tap");
  });
  it("a smooth on-time flow passage followed by a late tap is Late tap, not Early exit", () => {
    const f = diagnosed([
      traceFrame(800, 120),
      traceFrame(970, 250),
      traceFrame(990, 280),
      traceFrame(1000),
      traceFrame(1010, 330),
      traceFrame(1030, 365, [0]),
      traceFrame(1200, 420),
    ]);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(f.evidence.inputs.some((item) => item.inside && item.record.timeMs === 1000)).toBe(true);
    expect(f.result.headline).toBe("Late tap");
  });
  it("a genuinely early flow passage followed by an on-time tap retains Early exit", () => {
    const f = diagnosed([
      traceFrame(800, 100),
      traceFrame(930, 250),
      traceFrame(940),
      traceFrame(950, 350),
      traceFrame(1000, 600, [0]),
      traceFrame(1200, 1600),
    ]);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(f.result.headline).toBe("Early exit");
    expect(f.result.codes).not.toContain("late-tap");
  });
  it("distinguishes actual braking beyond the circle from constant-speed flow", () => {
    const f = diagnosed([
      traceFrame(800, 100),
      traceFrame(930, 250),
      traceFrame(940),
      traceFrame(950, 350),
      traceFrame(1000, 400, [0]),
      traceFrame(1200, 450),
    ]);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(f.result.headline).toBe("Overshoot");
  });
  it.each([true, false])("does not infer missing input from filtered neighbour ownership: held=%s", (held) => {
    const actions = held ? [0] : [];
    const f = diagnosed(
      [
        traceFrame(800, 100),
        traceFrame(920, 100, [0]),
        traceFrame(925, 100, actions),
        traceFrame(950, 300, actions),
        traceFrame(1000, 300, actions),
        traceFrame(1200, 300, actions),
      ],
      "100,192,920,1,0\n300,192,1000,1,0",
      "1",
    );
    expect(f.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(f.result.status).toBe("supported");
    expect(f.result.headline).toBe("Early tap");
    expect(f.result.diagnostics?.primary?.unconsumedContextComparison?.ranking.selected[0].observationOnly).toBe(true);
    expect(f.result.codes).not.toContain("no-tap");
  });
  it("otherwise-valid blocked input wins over an unrelated earlier off-target observation", () => {
    const f = diagnosed(
      [
        traceFrame(800, 80),
        traceFrame(960, 100, [0]),
        traceFrame(970, 130),
        traceFrame(1030, 260),
        traceFrame(1050, 300, [1]),
        traceFrame(1300, 400),
      ],
      "100,192,1000,1,0\n300,192,1050,1,0",
      "1",
    );
    // The first object was hit here, so no order block exists: it must not invent one.
    expect(f.state.hitCircleVerdict["0"].type).not.toBe("MISS");
    expect(f.state.hitCircleVerdict["1"].type).toBe("GREAT");
    expect(f.result.codes).not.toContain("notelock");
  });
  it("an actual order block stands alone despite earlier outside context", () => {
    const f = diagnosed(
      [
        traceFrame(800, 50),
        traceFrame(960, 50, [0]),
        traceFrame(970, 130),
        traceFrame(1030, 260),
        traceFrame(1050, 300, [1]),
        traceFrame(1300, 400),
      ],
      "100,192,1000,1,0\n300,192,1050,1,0",
      "1",
    );
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(
      f.evidence.routing.some(
        (route) => route.kind === "policy" && route.componentId === "1" && route.state === "rejected",
      ),
    ).toBe(true);
    expect(f.result.headline).toBe("Notelock");
  });
  it("refuses a supplied trace from a different analysis identity", () => {
    const f = diagnosed([
      traceFrame(0, 240),
      traceFrame(990, 250),
      traceFrame(1001, 260, [0]),
      traceFrame(1020),
      traceFrame(1200),
    ]);
    const other = { ...f.trace, identity: { ...f.trace.identity, generationKey: "other-replay" } };
    const result = classifyCircleLoss(f.evidence, f.map, other);
    expect(result.status).toBe("unavailable");
    expect(result.limitations).toContain("trace-identity-mismatch");
    expect(result.codes).toEqual([]);
  });
  it.each(["unavailable", "supported"] as const)(
    "retains a usable timing correction despite an unclassified secondary approach (%s descriptor status)",
    (status) => {
      const f = diagnosed([
        traceFrame(800, 120),
        traceFrame(970, 250),
        traceFrame(990, 280),
        traceFrame(1000),
        traceFrame(1010, 330),
        traceFrame(1030, 365, [0]),
        traceFrame(1040, 380),
        traceFrame(1050, 400, [1]),
        traceFrame(1200, 420),
      ]);
      const real = approaches.analyzePrimaryApproaches;
      const spy = jest.spyOn(approaches, "analyzePrimaryApproaches").mockImplementation((e, c) => {
        const value = real(e, c);
        expect(value.episodes.length).toBe(2);
        return {
          ...value,
          episodes: value.episodes.map((episode, index) =>
            index === 1
              ? {
                  ...episode,
                  status,
                  properPass: undefined,
                  spatialCandidates: [],
                  timingIndependent: false,
                  limitations: ["unresolved-competing-approach"],
                }
              : episode,
          ),
        };
      });
      try {
        const result = classifyCircleLoss(f.evidence, f.map, f.trace);
        expect(result.status).toBe("supported");
        expect(result.limitations).toContain("unresolved-competing-approach");
        expect(result.diagnostics?.primary?.approaches?.episodes).toHaveLength(2);
        // Uncertainty in the secondary coaching descriptor is not a broken
        // source witness for the first tap's independently usable passage.
        expect(result.codes).toEqual(["late-tap"]);
        const ranked=result.diagnostics?.primary?.rawOpportunityComparison?.ranking??result.diagnostics?.primary?.ranking;
        expect(ranked?.selected[0].support?.correction?.kind).toBe("sampled-pass-tap");
      } finally {
        spy.mockRestore();
      }
    },
  );
  it("derives common timing departure from complete opposing attempts around one on-time passage", () => {
    const f = diagnosed([
      traceFrame(800, 100),
      traceFrame(930, 230),
      traceFrame(950, 250, [0]),
      traceFrame(970, 270),
      traceFrame(1000),
      traceFrame(1045, 345, [1]),
      traceFrame(1200, 500),
    ]);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(f.result.headline).toBe("Late tap");
    expect(f.result.diagnostics?.primary?.ranking?.reason).toBe("shared-best-window-tolerance");
    expect(f.result.diagnostics?.primary?.association.relevantInputIds).toHaveLength(2);
    expect(f.result.metric).toEqual({ value: 45, unit: "ms late" });
  });
});
