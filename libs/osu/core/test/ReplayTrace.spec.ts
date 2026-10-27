import { createReplayTraceCollector, serializeReplayTrace } from "../src/gameplay/trace/ReplayTraceCollector";
import { TraceRunIdentity, ScoringDomain } from "../src/gameplay/trace/ReplayTrace";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { traceFixtures, traceBeatmap, traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { GameplayInfoEvaluator, LazerGameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { cloneGameState } from "../src/gameplay/GameState";
import { TraceCapture } from "../src/gameplay/trace/ReplayTrace";

const identity: TraceRunIdentity = {
  schemaVersion: 1,
  replayContentSha256: null,
  beatmapContentSha256: null,
  beatmapMd5: null,
  generationKey: "test-run",
  recordingClient: "synthetic",
  analysisProfileId: "stable",
  analysisProfileFingerprint: "synthetic-profile",
  parserVersion: "fixture-v1",
  inputPreparationVersion: "source-v1",
};
const domain: ScoringDomain = {
  endTimeMs: 1200,
  endpointBasis: "recorded-end",
  synthesizedEndpoint: false,
  sourceCoverageLimits: ["synthetic-fixture"],
};
const limits = { maxRecords: 200000, maxExportBytes: 64 * 1024 * 1024 };
const collector = (overrides = {}) => createReplayTraceCollector(identity, domain, { ...limits, ...overrides });
const coverage = (id: string) => ({
  id,
  timeMs: 1000,
  phase: "coverage" as const,
  kind: "coverage" as const,
  channel: "input" as const,
  status: "partial" as const,
  reason: "test",
  startTimeMs: 900,
  endTimeMs: 1000,
});

describe("bounded observational collector", () => {
  it("rejects cycles in terminal causality and forged wrong-kind export references", () => {
    const c = collector(),
      a = c.reserveId(),
      b = c.reserveId();
    c.record({
      id: a,
      timeMs: 1,
      phase: "resolution",
      kind: "resolution",
      componentId: "0",
      component: "circle",
      result: "MISS",
      mechanism: "ordered-force-miss",
      triggerResolutionId: b,
      previousUnresolved: true,
    });
    c.record({
      id: b,
      timeMs: 1,
      phase: "resolution",
      kind: "resolution",
      componentId: "1",
      component: "circle",
      result: "MISS",
      mechanism: "ordered-force-miss",
      triggerResolutionId: a,
      previousUnresolved: true,
    });
    expect(c.seal().failures).toContain("broken-reference");
    const good = collector();
    good.record(coverage(good.reserveId()));
    const trace = good.seal();
    const forged = {
      ...trace,
      records: [
        ...trace.records,
        {
          id: "r1",
          sequence: 1,
          timeMs: 1000,
          phase: "attempt" as const,
          kind: "attempt" as const,
          inputId: "r0",
          attemptOrdinal: 0,
          actionCandidates: [0],
        },
      ],
    };
    expect(() => serializeReplayTrace(forged)).toThrow();
  });
  it("rejects duplicate/reversed parsed source indices at sealing", () => {
    const c = collector();
    for (const parsedFrameIndex of [2, 1])
      c.record({
        id: c.reserveId(),
        timeMs: 1,
        phase: "input",
        kind: "input",
        position: { x: 0, y: 0 },
        previousActions: [],
        actions: [],
        freshActions: [],
        source: { origin: "parsed", parsedFrameIndex },
        groupMemberIndex: 0,
      });
    expect(c.seal().failures).toContain("invalid-source-order");
  });
  it("preserves same-time records, unique IDs and immutable copies", () => {
    const c = collector(),
      a = c.reserveId(),
      b = c.reserveId();
    expect(a).not.toBe(b);
    const observation = coverage(a);
    c.record(observation);
    observation.reason = "mutated";
    c.record(coverage(b));
    const trace = c.seal();
    expect(trace.records.map((r) => r.sequence)).toEqual([0, 1]);
    expect(trace.records.map((r) => r.timeMs)).toEqual([1000, 1000]);
    expect(trace.records[0]).toMatchObject({ reason: "test" });
    expect(Object.isFrozen(trace.records[0])).toBe(true);
    expect(Object.isFrozen(trace.identity)).toBe(true);
    c.record(coverage(c.reserveId()));
    expect(c.seal()).toBe(trace);
  });
  it("accepts reserved forward causal references and rejects missing references at seal", () => {
    const c = collector(),
      trigger = c.reserveId(),
      forced = c.reserveId();
    c.record({
      id: forced,
      timeMs: 1000,
      phase: "resolution",
      kind: "resolution",
      componentId: "0",
      component: "circle",
      result: "MISS",
      mechanism: "ordered-force-miss",
      triggerResolutionId: trigger,
      previousUnresolved: true,
    });
    c.record({
      id: trigger,
      timeMs: 1000,
      phase: "resolution",
      kind: "resolution",
      componentId: "1",
      component: "circle",
      result: "GREAT",
      mechanism: "successful-input",
      previousUnresolved: true,
    });
    expect(c.seal().failures).toEqual([]);
    const broken = collector();
    broken.record({
      id: broken.reserveId(),
      timeMs: 1000,
      phase: "attempt",
      kind: "attempt",
      inputId: "absent",
      attemptOrdinal: 0,
      actionCandidates: [0],
    });
    expect(broken.seal().failures).toContain("broken-reference");
  });
  it.each([{ maxRecords: 1 }, { maxExportBytes: 64 }])("marks truncation and disables later writes at %j", (cap) => {
    const c = collector(cap);
    c.record(coverage(c.reserveId()));
    c.record(coverage(c.reserveId()));
    const trace = c.seal();
    expect(trace.complete).toBe(false);
    expect(trace.failures.some((f) => f.includes("limit"))).toBe(true);
    expect(trace.droppedRecordBoundary).toBeDefined();
    expect(trace.records.length).toBeLessThan(2);
  });
  it("disposal disables recording and marks unfinished capture", () => {
    const c = collector();
    c.record(coverage(c.reserveId()));
    c.dispose();
    c.record(coverage(c.reserveId()));
    expect(c.seal()).toMatchObject({ complete: false, failures: expect.arrayContaining(["disposed"]) });
  });
  it.each([NaN, Infinity, -Infinity])("rejects nonfinite observation %s without throwing", (timeMs) => {
    const c = collector();
    expect(() => c.record({ ...coverage(c.reserveId()), timeMs })).not.toThrow();
    expect(c.seal().failures).toContain("invalid-observation");
  });
  it("rejects unsupported schema and invalid components without claiming coverage", () => {
    const c = createReplayTraceCollector(
      { ...identity, schemaVersion: 3 } as unknown as TraceRunIdentity,
      domain,
      limits,
    );
    expect(c.seal().failures).toContain("invalid-identity-or-domain");
    const invalid = collector();
    invalid.record({
      id: invalid.reserveId(),
      timeMs: 1,
      phase: "resolution",
      kind: "resolution",
      componentId: "0",
      component: "tail" as "circle",
      result: "MISS",
      mechanism: "automatic-expiry",
      previousUnresolved: true,
    });
    expect(invalid.seal().failures).toContain("invalid-observation");
  });
  it("rejects invalid source references and missing required references", () => {
    const c = collector();
    c.record({
      id: c.reserveId(),
      timeMs: 1,
      phase: "input",
      kind: "input",
      position: { x: 0, y: 0 },
      previousActions: [],
      actions: [],
      freshActions: [],
      groupMemberIndex: 0,
      source: { origin: "parsed", parsedFrameIndex: -1 },
    });
    expect(c.seal().failures).toContain("invalid-observation");
    const missing = collector();
    missing.record({
      id: missing.reserveId(),
      timeMs: 1,
      phase: "attempt",
      kind: "attempt",
      attemptOrdinal: 0,
      actionCandidates: [0],
    } as Parameters<TraceCapture["record"]>[0]);
    expect(missing.seal().failures).toContain("invalid-observation");
  });
  it("never upgrades a partial channel after later complete observations", () => {
    const c = collector();
    c.record(coverage(c.reserveId()));
    c.record({ ...coverage(c.reserveId()), status: "complete" });
    expect(c.seal().coverage.input).toBe("partial");
  });
  it("rejects malformed identity and refuses invalid exports", () => {
    const c = createReplayTraceCollector({ ...identity, replayContentSha256: "filename.osr" }, domain, limits);
    expect(c.seal().failures).toContain("invalid-identity-or-domain");
    expect(() => serializeReplayTrace(c.seal())).toThrow();
    const broken = collector();
    broken.record({
      id: broken.reserveId(),
      timeMs: 1,
      phase: "attempt",
      kind: "attempt",
      inputId: "absent",
      attemptOrdinal: 0,
      actionCandidates: [0],
    });
    expect(() => serializeReplayTrace(broken.seal())).toThrow();
    const small = collector({ maxExportBytes: 32 });
    expect(() => serializeReplayTrace(small.seal())).toThrow();
  });
});

type Profile = "stable" | "lazer";
function runFixture(name: string, profile: Profile, cap = limits) {
  const found = traceFixtures.find((f) => f.name === name);
  if (!found) throw new Error(name);
  const f = {
    ...found,
    frames: found.frames.map((frame) => ({ ...frame, position: { ...frame.position }, actions: [...frame.actions] })),
  };
  const map = traceBeatmap(f.objects);
  const c = createReplayTraceCollector(
    { ...identity, analysisProfileId: profile },
    {
      ...domain,
      endTimeMs: f.frames[f.frames.length - 1].time,
      frameSources: f.frames.map((_, parsedFrameIndex) => ({ origin: "parsed", parsedFrameIndex })),
    },
    cap,
  );
  const make = (capture?: TraceCapture): BucketedGameStateTimeMachine | LazerGameStateTimeMachine =>
    profile === "stable"
      ? Reflect.construct(BucketedGameStateTimeMachine, [
          f.frames,
          map,
          { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
          2,
          capture,
        ])
      : Reflect.construct(LazerGameStateTimeMachine, [f.frames, map, 2, {}, capture]);
  return { f, map, c, make };
}
describe("canonical trace fidelity", () => {
  it.each(["stable", "lazer"] as const)("%s does not call an empty selection a consumer stop", (profile) => {
    const { f, make, c } = runFixture("selected-without-result", profile);
    f.frames[1].position.x = 999;
    make(c).gameStateAt(Infinity);
    expect(c.seal().records.find((r) => r.kind === "selection")).toMatchObject({
      componentId: null,
      selectionStopped: false,
    });
  });
  it.each(traceFixtures.flatMap((f) => ["stable", "lazer"].map((p) => [f.name, p] as const)))(
    "%s %s preserves full state, ordered events and scoring",
    (name, profile) => {
      const { f, map, c, make } = runFixture(name, profile as Profile);
      const off = cloneGameState(make().gameStateAt(Infinity));
      const on = cloneGameState(make(c).gameStateAt(Infinity));
      expect(normalizeTraceState(on)).toEqual(normalizeTraceState(off));
      expect(retrieveEvents(on, map.hitObjects, profile as Profile)).toEqual(
        retrieveEvents(off, map.hitObjects, profile as Profile),
      );
      const info = () => (profile === "stable" ? new GameplayInfoEvaluator(map) : new LazerGameplayInfoEvaluator());
      expect(info().evaluateReplayState(on)).toEqual(info().evaluateReplayState(off));
      const trace = c.seal();
      expect(trace.failures).toEqual([]);
      const inputs = trace.records.filter((r) => r.kind === "input");
      expect(inputs).toHaveLength(f.frames.length);
      expect(inputs.map((r) => r.kind === "input" && r.position)).toEqual(f.frames.map((f) => f.position));
      expect(inputs.map((r) => r.kind === "input" && r.source)).toEqual(
        f.frames.map((_, parsedFrameIndex) => ({ origin: "parsed", parsedFrameIndex })),
      );
    },
  );
  it("distinguishes boundary input Miss from expiry without changing TIME_EXPIRED", () => {
    const input = runFixture("boundary-two-sides", "stable");
    const state = input.make(input.c).gameStateAt(Infinity);
    expect(state.hitCircleVerdict["0"]).toMatchObject({ type: "MISS", missReason: "TIME_EXPIRED" });
    expect(state.hitCircleVerdict["1"].type).toBe("GREAT");
    const trace = input.c.seal();
    expect(
      trace.records.filter((r) => r.kind === "resolution").map((r) => r.kind === "resolution" && r.mechanism),
    ).toEqual(["input-miss", "successful-input"]);
    const attempts = trace.records.filter((r) => r.kind === "attempt");
    expect(attempts.map((r) => r.kind === "attempt" && r.attemptOrdinal)).toEqual([0, 1]);
    expect(
      attempts.every((r) => r.kind === "attempt" && r.knownAction === undefined && r.actionCandidates.length === 2),
    ).toBe(true);
    const expiry = runFixture("expiry", "stable");
    expiry.make(expiry.c).gameStateAt(Infinity);
    const terminal = expiry.c.seal().records.find((r) => r.kind === "resolution");
    expect(terminal).toMatchObject({ kind: "resolution", mechanism: "automatic-expiry" });
    expect(terminal?.kind === "resolution" && terminal.triggerAttemptId).toBeUndefined();
  });
  it("retains repeated blocked attempts after summary evidence is cleared by success", () => {
    for (const profile of ["stable", "lazer"] as const) {
      const { make, c } = runFixture("blocked-then-success", profile),
        state = make(c).gameStateAt(Infinity);
      expect(state.hitCircleVerdict["1"].type).toBe("GREAT");
      expect(state[profile === "stable" ? "stableNotelockEvidence" : "lazerNotelockEvidence"]["1"]).toBeUndefined();
      expect(c.seal().records.filter((r) => r.kind === "policy" && r.state === "rejected")).toHaveLength(2);
    }
  });
  it.each(["stable", "lazer"] as const)("%s records a dispatch stop without a judgement", (profile) => {
    const { make, c } = runFixture("selected-without-result", profile);
    make(c).gameStateAt(Infinity);
    expect(c.seal().records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "selection", componentId: "0", selectionStopped: true }),
        expect.objectContaining({ kind: "policy", timingResult: null }),
      ]),
    );
    expect(c.seal().records.filter((r) => r.kind === "resolution")).toHaveLength(0);
  });
  it("links native forced resolution to the actual later resolution, preserving earlier scoring order", () => {
    const { make, c } = runFixture("ordered-force", "lazer"),
      state = make(c).gameStateAt(Infinity);
    expect(state.judgedObjects).toEqual(["0", "1"]);
    const trace = c.seal(),
      forced = trace.records.find((r) => r.kind === "resolution" && r.componentId === "0");
    expect(forced).toMatchObject({ mechanism: "ordered-force-miss" });
    if (forced?.kind !== "resolution") throw Error("missing force");
    expect(trace.records.find((r) => r.id === forced.triggerResolutionId)).toMatchObject({
      kind: "resolution",
      componentId: "1",
      mechanism: "successful-input",
    });
  });
  it.each(["stable", "lazer"] as const)(
    "%s seeks, forks and transient inspections cannot append to canonical capture",
    (profile) => {
      const { make, c } = runFixture("zero-delta", profile),
        machine = make(c);
      const expected = cloneGameState(machine.gameStateAt(Infinity)),
        trace = c.seal(),
        json = JSON.stringify(trace);
      const fork = machine.fork();
      fork.gameStateAt(950);
      fork.gameStateAt(999.5);
      fork.gameStateAt(Infinity);
      machine.gameStateAt(900);
      machine.gameStateAt(999.5);
      expect(machine.gameStateAt(Infinity)).toEqual(expected);
      expect(JSON.stringify(c.seal())).toBe(json);
    },
  );
  it.each(["stable", "lazer"] as const)("%s refuses a partial first traversal as canonical", (profile) => {
    const { make, c } = runFixture("zero-delta", profile),
      machine = make(c);
    machine.gameStateAt(950);
    machine.gameStateAt(Infinity);
    expect(c.seal().failures).toContain("not-canonical-traversal");
    expect(c.seal().records).toHaveLength(0);
  });
  it.each(["stable", "lazer"] as const)("%s cap and injected recorder failure preserve gameplay", (profile) => {
    const { make, c } = runFixture("zero-delta", profile, { ...limits, maxRecords: 2 });
    expect(make(c).gameStateAt(Infinity)).toEqual(make().gameStateAt(Infinity));
    expect(c.seal().failures).toContain("record-limit");
    const faulty = runFixture("zero-delta", profile);
    const throwing = {
      ...faulty.c,
      record: () => {
        throw Error("injected recorder fault");
      },
    };
    expect(faulty.make(throwing).gameStateAt(Infinity)).toEqual(faulty.make().gameStateAt(Infinity));
    expect(faulty.c.seal().failures).toContain("recorder-failure");
  });
  it.each(["stable", "lazer"] as const)("%s recorder receives no mutable gameplay references", (profile) => {
    const { make, c } = runFixture("zero-delta", profile),
      expected = cloneGameState(make().gameStateAt(Infinity));
    const mutating = {
      ...c,
      record: (o: Parameters<TraceCapture["record"]>[0]) => {
        if (o.kind === "input") {
          o.position.x = -999;
          o.actions.length = 0;
          o.freshActions.length = 0;
        }
        c.record(o);
      },
    };
    expect(make(mutating).gameStateAt(Infinity)).toEqual(expected);
  });
  it("rejects a synthesized endpoint disguised as a parsed frame", () => {
    const c = createReplayTraceCollector(
      identity,
      { ...domain, synthesizedEndpoint: true, frameSources: [{ origin: "parsed", parsedFrameIndex: 0 }] },
      limits,
    );
    expect(c.seal().failures).toContain("invalid-identity-or-domain");
  });
  it.each(["stable", "lazer"] as const)(
    "%s preserves unsupported mod playback and explicitly declines coverage",
    (profile) => {
      const { make, c, map } = runFixture("slider-overlap", profile);
      map.appliedMods.push("RELAX");
      if (profile === "lazer")
        map.lazerModSettings.classic = {
          classicNoteLock: true,
          noSliderHeadAccuracy: true,
          alwaysPlayTailSample: true,
          fadeHitCircleEarly: true,
          classicHealth: true,
        };
      expect(make(c).gameStateAt(Infinity)).toEqual(make().gameStateAt(Infinity));
      expect(c.seal().failures).toContain("unsupported-profile");
      expect(c.seal().records).toHaveLength(0);
    },
  );
  it("native causal trigger may itself be an input Miss", () => {
    const map = traceBeatmap("100,192,1000,1,0\n300,192,1200,1,0");
    const frames = [traceFrame(900), traceFrame(1000, 300, [0])];
    const c = createReplayTraceCollector(
      { ...identity, analysisProfileId: "lazer" },
      { ...domain, endTimeMs: 1000 },
      limits,
    );
    const machine = new LazerGameStateTimeMachine(frames, map, 2, {}, c);
    const state = machine.gameStateAt(Infinity);
    expect(state.judgedObjects).toEqual(["0", "1"]);
    const forced = c.seal().records.find((r) => r.kind === "resolution" && r.componentId === "0");
    if (forced?.kind !== "resolution") throw Error("missing force");
    expect(c.seal().records.find((r) => r.id === forced.triggerResolutionId)).toMatchObject({
      kind: "resolution",
      componentId: "1",
      mechanism: "input-miss",
      result: "MISS",
    });
  });
  it.each(["stable", "lazer"] as const)(
    "%s records logical edges separately from raw masks and held input",
    (profile) => {
      const { make, c } = runFixture("physical-held", profile);
      make(c).gameStateAt(Infinity);
      const inputs = c.seal().records.filter((r) => r.kind === "input");
      expect(inputs.map((r) => r.kind === "input" && r.freshActions)).toEqual([[], [0], [], [1]]);
      expect(inputs.map((r) => r.kind === "input" && r.rawButtonMask)).toEqual([undefined, 1, 5, 7]);
      expect(c.seal().records.filter((r) => r.kind === "attempt")).toHaveLength(2);
    },
  );
});
