import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";
import { createReplayTraceCollector, serializeReplayTrace } from "../src/gameplay/trace/ReplayTraceCollector";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { ReplayTrace, ReplayTraceObservation } from "../src/gameplay/trace/ReplayTrace";

describe("automatic and Classic attempted-input trace provenance", () => {
  it.each([[], [0]] as number[][])(
    "Stable Relax identifies its callback without borrowing recorded actions %j",
    (...actions) => {
      const frames = [traceFrame(900, 500), traceFrame(1050, 300, actions), traceFrame(1300, 500)];
      const { trace, map, state } = errorFixture("300,192,1000,1,0", frames, "stable", ["RELAX"]);
      const resolution = trace.records.find((r) => r.kind === "resolution" && r.componentId === "0");
      expect(resolution?.kind).toBe("resolution");
      if (resolution?.kind !== "resolution") throw new Error("no resolution");
      expect(resolution.result).toBe("OK");
      const attempt = trace.records.find((r) => r.id === resolution.triggerAttemptId);
      expect(attempt).toMatchObject({ kind: "attempt", automated: true, actionCandidates: [] });
      expect(attempt?.kind === "attempt" && attempt.knownAction).toBeUndefined();
      const off = new BucketedGameStateTimeMachine(frames, map, {
        noteLockStyle: "STABLE",
        hitWindowStyle: "OSU_STABLE",
      }).gameStateAt(Infinity);
      expect(normalizeTraceState(state)).toEqual(normalizeTraceState(off));
      expect(normalizeTraceState(retrieveEvents(state, map.hitObjects, "stable"))).toEqual(
        normalizeTraceState(retrieveEvents(off, map.hitObjects, "stable")),
      );
      expect(trace.failures).toEqual([]);
    },
  );

  it.each([true, false])(
    "Classic actual head input retains timing and causal attempt with head accuracy %s",
    (accuracy) => {
      const frames = [
        traceFrame(900, 100),
        traceFrame(1080, 116, [0]),
        traceFrame(1500, 200, [0]),
        traceFrame(1970, 294, [0]),
        traceFrame(2100, 300, [0]),
      ];
      const { trace, map, state } = errorFixture(
        "100,192,1000,2,0,L|300:192,1,200",
        frames,
        "lazer",
        [],
        [{ acronym: "CL", settings: { no_slider_head_accuracy: !accuracy, classic_note_lock: true } }],
      );
      const terminal = trace.records.find((r) => r.kind === "resolution" && r.component === "slider-head");
      expect(terminal).toMatchObject({ kind: "resolution", result: "MEH", mechanism: "successful-input" });
      if (terminal?.kind !== "resolution") throw new Error("no head terminal");
      const attempt = trace.records.find((r) => r.id === terminal.triggerAttemptId);
      expect(attempt).toMatchObject({ kind: "attempt", knownAction: 0 });
      expect(trace.records).toContainEqual(
        expect.objectContaining({ kind: "selection", componentId: terminal.componentId, attemptId: attempt?.id }),
      );
      expect(trace.records).toContainEqual(
        expect.objectContaining({
          kind: "policy",
          componentId: terminal.componentId,
          attemptId: attempt?.id,
          state: "allowed",
          timingResult: "MEH",
        }),
      );
      const off = new LazerGameStateTimeMachine(frames, map).gameStateAt(Infinity);
      expect(normalizeTraceState(state)).toEqual(normalizeTraceState(off));
      expect(normalizeTraceState(retrieveEvents(state, map.hitObjects, "lazer"))).toEqual(
        normalizeTraceState(retrieveEvents(off, map.hitObjects, "lazer")),
      );
    },
  );

  it("rejects v2 component records under a v1 identity at capture and export", () => {
    const { trace } = errorFixture("100,192,1000,2,0,L|300:192,1,200", [
      traceFrame(900, 500),
      traceFrame(1500, 500),
      traceFrame(2100, 500),
    ]);
    const observation = trace.records.find((r) => r.kind === "slider-checkpoint")!;
    const collector = createReplayTraceCollector({ ...trace.identity, schemaVersion: 1 }, trace.domain, trace.limits);
    collector.record({ ...observation, id: collector.reserveId() } as ReplayTraceObservation);
    expect(collector.seal().failures).toContain("invalid-observation");
    const forged: ReplayTrace = { ...trace, identity: { ...trace.identity, schemaVersion: 1 } };
    expect(() => serializeReplayTrace(forged)).toThrow(/Invalid trace/);
  });

  it("keeps the v1 Relax capture free of newly introduced automatic attempts", () => {
    const frames = [traceFrame(900, 500), traceFrame(1050, 300), traceFrame(1300, 500)];
    const { trace, map } = errorFixture("300,192,1000,1,0", frames, "stable", ["RELAX"]);
    const collector = createReplayTraceCollector({ ...trace.identity, schemaVersion: 1 }, trace.domain, trace.limits);
    new BucketedGameStateTimeMachine(
      frames,
      map,
      { noteLockStyle: "STABLE", hitWindowStyle: "OSU_STABLE" },
      undefined,
      collector,
    ).gameStateAt(Infinity);
    const old = collector.seal();
    expect(old.records.filter((r) => r.kind === "attempt")).toEqual([]);
    // V1's supported-profile admission excluded Relax and must remain unchanged.
    expect(old.records).toEqual([]);
    expect(old.failures).toEqual(["unsupported-profile"]);
  });

  it("rejects automatic attempts that claim a manual key and all automatic fields under v1", () => {
    const { trace } = errorFixture("300,192,1000,1,0", [traceFrame(900), traceFrame(1300)]);
    for (const version of [1, 2] as const) {
      const collector = createReplayTraceCollector(
        { ...trace.identity, schemaVersion: version },
        trace.domain,
        trace.limits,
      );
      const inputId = collector.reserveId();
      collector.record({
        id: inputId,
        kind: "input",
        phase: "input",
        timeMs: 1000,
        position: { x: 300, y: 192 },
        previousActions: [],
        actions: [0],
        freshActions: [0],
        source: { origin: "parsed", parsedFrameIndex: 0 },
        groupMemberIndex: 0,
      });
      collector.record({
        id: collector.reserveId(),
        kind: "attempt",
        phase: "attempt",
        timeMs: 1000,
        inputId,
        attemptOrdinal: 0,
        actionCandidates: version === 1 ? [] : [0],
        knownAction: version === 1 ? undefined : 0,
        automated: true,
      });
      expect(collector.seal().failures).toContain("invalid-observation");
    }
  });

  it("records Classic rejected and empty dispatches without converting them to accepted input", () => {
    const frames = [
      traceFrame(800, 500),
      traceFrame(1020, 300, [0]),
      traceFrame(1050, 500),
      traceFrame(1300, 500, [1]),
    ];
    const { trace } = errorFixture(
      "100,192,1000,1,0\n300,192,1050,1,0",
      frames,
      "lazer",
      [],
      [{ acronym: "CL", settings: { classic_note_lock: true } }],
    );
    expect(trace.records).toContainEqual(
      expect.objectContaining({
        kind: "policy",
        componentId: "1",
        state: "rejected",
        blockerId: "0",
        timingResult: "OK",
      }),
    );
    expect(trace.records).toContainEqual(
      expect.objectContaining({ kind: "selection", componentId: null, eligible: false }),
    );
    const terminal = trace.records.find((r) => r.kind === "resolution" && r.componentId === "1");
    expect(terminal).toMatchObject({ mechanism: "automatic-expiry", result: "MISS" });
    expect(trace.failures).toEqual([]);
  });
});
