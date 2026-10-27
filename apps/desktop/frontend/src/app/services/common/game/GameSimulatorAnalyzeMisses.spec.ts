import {
  buildBeatmap,
  parseBlueprint,
  BucketedGameStateTimeMachine,
  parseReplayFramesWithDiagnostics,
} from "@osujs/core";
import { GameSimulator } from "./GameSimulator";
import { OsuReplay } from "../../../model/OsuReplay";
import { traceMapText, normalizeTraceState } from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { configureMissAnalysisWorker, MissAnalysisRequest } from "../../analysis/miss-explanation/MissAnalysisClient";
import { runMissAnalysis } from "../../analysis/miss-explanation/MissAnalysisRunner";
import { decodeMissAnalysisInput, encodeMissAnalysisSession } from "../../analysis/miss-explanation/MissAnalysisWire";

function fixture(native = false, mods: OsuReplay["mods"] = []) {
  const map = buildBeatmap(parseBlueprint(traceMapText("300,192,1000,1,0\n300,192,5000,1,0")), {
    mods,
    addStacking: false,
  });
  const replay: OsuReplay = {
    md5hash: "replay",
    beatmapMd5: "map",
    player: "synthetic",
    mods,
    gameVersion: 20200101,
    gameMode: 0,
    ...(native ? ({ sourceClient: "lazer", sourceProvenance: "user-confirmed" } as const) : {}),
    frames: [
      { time: 0, position: { x: 300, y: 192 }, actions: [] },
      { time: 1200, position: { x: 300, y: 192 }, actions: [] },
    ],
  };
  return { map, replay };
}
describe("user initiated miss analysis", () => {
  it.each(["finish", "replace", "clear", "profile"] as const)(
    "owns worker lifetime and prepared endpoint on %s",
    async (change) => {
      const { map, replay } = fixture(),
        simulator = new GameSimulator();
      replay.frames.push({ time: 1800, position: { x: 0, y: 0 }, actions: [] });
      replay.lifeBar = [
        { time: 0, health: 1 },
        { time: 1300, health: 0 },
      ];
      let posted!: (request: MissAnalysisRequest) => void;
      const requestReady = new Promise<MissAnalysisRequest>((resolve) => {
        posted = resolve;
      });
      const worker = {
        onmessage: null as Worker["onmessage"],
        onerror: null,
        onmessageerror: null,
        postMessage: jest.fn(posted),
        terminate: jest.fn(),
      };
      configureMissAnalysisWorker(() => worker as unknown as Worker);
      try {
        simulator.simulateReplay(map, replay);
        const events = simulator.replayEvents$.value;
        const pending = simulator.analyzeMisses();
        expect(simulator.analyzeMisses()).toBe(pending);
        const request = await requestReady;
        expect(request.input.domain).toMatchObject({
          endTimeMs: 1300,
          endpointBasis: "health-derived",
          synthesizedEndpoint: true,
        });
        expect(request.input.frames.map((frame) => frame.time)).toEqual([0, 1200, 1300]);
        const handler = worker.onmessage!;
        const result = await runMissAnalysis(decodeMissAnalysisInput(request.input), async () => undefined);
        if (change === "replace") simulator.simulateReplay(map, { ...replay });
        if (change === "clear") simulator.clear();
        if (change === "profile") simulator.setRulesetFocus("lazer");
        const current = simulator.missExplanations$.value;
        handler.call(
          worker as unknown as Worker,
          {
            data: {
              version: 1,
              requestId: request.requestId,
              kind: "result",
              session: encodeMissAnalysisSession(result),
            },
          } as MessageEvent,
        );
        const completed = await pending;
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        if (change === "finish") {
          expect(completed.status).toBe(result.status);
          expect(simulator.missExplanations$.value).toBe(completed);
          expect(await simulator.analyzeMisses()).toBe(completed);
          expect(simulator.replayEvents$.value).toBe(events);
          expect(worker.postMessage).toHaveBeenCalledTimes(1);
        } else expect(simulator.missExplanations$.value).toBe(current);
      } finally {
        simulator.clear();
        configureMissAnalysisWorker(undefined);
      }
    },
  );
  it("captures a long automated-input replay within the unchanged record budget", async () => {
    const map = buildBeatmap(parseBlueprint(traceMapText("300,192,1000,1,0\n300,192,60000,1,0")), {
      mods: ["RELAX"],
      addStacking: false,
    });
    const parsed = parseReplayFramesWithDiagnostics(
      "0|256|-500|0,0|256|-500|0," +
        Array.from({ length: 12201 }, (_, i) => `${i ? 5 : 0}|${i * 5 < 50000 ? 300 : 600}|192|0,`).join(""),
    );
    const replay: OsuReplay = {
      md5hash: "planned",
      beatmapMd5: "map",
      player: "fixture",
      mods: ["RELAX"],
      gameVersion: 20200101,
      gameMode: 0,
      frames: parsed.frames,
      parseDiagnostics: parsed.diagnostics,
    };
    const sim = new GameSimulator();
    try {
      sim.simulateReplay(map, replay, { traceLimits: { maxRecords: 5000, maxExportBytes: 64 * 1024 * 1024 } });
      sim.simulate(950);
      const state = sim.getCurrentState(),
        events = sim.replayEvents$.value;
      const result = await sim.analyzeMisses();
      expect(result.status).toBe("partial");
      if (result.status !== "partial") throw Error("Missing scoped analysis");
      expect(result.trace.failures).toEqual([]);
      expect(result.trace.domain.sourceCoverageLimits).toContain("planned-input-retention");
      expect(result.trace.records.length).toBeLessThan(5000);
      const atom = result.analysis?.inventory.atoms.find((a) => a.componentId === "1");
      expect(result.analysis?.classifications.find((c) => c.atomId === atom?.id)?.mechanism.status).toBe("supported");
      expect(await sim.analyzeMisses()).toBe(result);
      expect(sim.getCurrentState()).toBe(state);
      expect(sim.replayEvents$.value).toBe(events);
    } finally {
      sim.clear();
    }
  });
  it("keeps complete model miss evidence available under an explicitly unlocalized accuracy-grade disagreement", async () => {
    const map = buildBeatmap(parseBlueprint(traceMapText("100,192,1000,1,0\n200,192,1500,1,0\n300,192,2000,1,0")), {
      mods: [],
      addStacking: false,
    });
    const parsed = parseReplayFramesWithDiagnostics(
      "0|256|-500|0,0|256|-500|0,700|100|192|0,300|100|192|5,20|100|192|0,480|200|192|0,40|200|192|10,20|200|192|0,340|300|192|0,200|300|192|0,200|300|192|0,",
    );
    const replay: OsuReplay = {
      md5hash: "grade-disagreement",
      beatmapMd5: "map",
      player: "fixture",
      mods: [],
      gameVersion: 20200101,
      gameMode: 0,
      frames: parsed.frames,
      parseDiagnostics: parsed.diagnostics,
      statistics: { count300: 2, count100: 0, count50: 0, countMiss: 1, maxCombo: 2, score: 1, perfectCombo: false },
    };
    const sim = new GameSimulator();
    try {
      sim.simulateReplay(map, replay);
      expect(sim.validation$.value).toMatchObject({
        judgementTotalsMatch: false,
        missCountMatch: true,
        maxComboMatch: true,
        simulatedCounts: [1, 1, 0, 1],
      });
      const events = sim.replayEvents$.value,
        state = sim.getCurrentState(),
        session = await sim.analyzeMisses();
      expect(session.status).toBe("partial");
      if (session.status !== "partial") throw Error("Missing partial model analysis");
      expect(session.reasons).toContain("global-totals-mismatch");
      expect(session.analysis?.outcomeBasis).toBe("model-reconstruction");
      const atom = session.analysis?.inventory.atoms.find((a) => a.componentId === "2");
      expect(session.analysis?.classifications.find((c) => c.atomId === atom?.id)?.mechanism.headline).toBe("No tap");
      expect(await sim.analyzeMisses()).toBe(session);
      expect(sim.replayEvents$.value).toBe(events);
      expect(sim.getCurrentState()).toBe(state);
      sim.simulateReplay(map, { ...replay, statistics: { ...replay.statistics!, maxCombo: 1 } });
      expect((await sim.analyzeMisses()).status).toBe("partial");
    } finally {
      sim.clear();
    }
  });
  it("analyzes reconstructed errors despite unlocalized saved-outcome disagreement", async () => {
    const { map, replay } = fixture(),
      simulator = new GameSimulator();
    replay.statistics = {
      count300: 1,
      count100: 0,
      count50: 0,
      countMiss: 0,
      maxCombo: 1,
      score: 300,
      perfectCombo: true,
    };
    simulator.simulateReplay(map, replay);
    const events = simulator.replayEvents$.value;
    const result = await simulator.analyzeMisses();
    expect(result.status).toBe("partial");
    if (result.status !== "partial") throw Error("Aggregate veto survived");
    expect(result.reasons).toContain("global-totals-mismatch");
    expect(result.analysis?.inventory.counts.misses).toBe(1);
    expect(await simulator.analyzeMisses()).toBe(result);
    expect(simulator.replayEvents$.value).toBe(events);
  });
  it.each([false, true])("publishes the loaded input capability to existing subscribers native=%s", (native) => {
    const { map, replay } = fixture(native);
    const simulator = new GameSimulator();
    const availability: boolean[] = [];
    const subscription = simulator.missExplanations$.subscribe(() =>
      availability.push(simulator.hasReplayForMissAnalysis()),
    );
    try {
      simulator.simulateReplay(map, replay);
      expect(availability[availability.length - 1]).toBe(true);
      simulator.clearMissExplanations();
      expect(availability[availability.length - 1]).toBe(false);
    } finally {
      subscription.unsubscribe();
    }
  });
  it("retains partial/error resource limits without changing playback", async () => {
    const { map, replay } = fixture();
    const simulator = new GameSimulator();
    for (const limits of [
      { maxRecords: 1, maxExportBytes: 100000 },
      { maxRecords: 1000, maxExportBytes: 64 },
    ]) {
      simulator.simulateReplay(map, replay, { traceLimits: limits });
      simulator.simulate(950);
      const before = normalizeTraceState(simulator.getCurrentState());
      const events = simulator.replayEvents$.value;
      const result = await simulator.analyzeMisses();
      expect(["partial", "error"]).toContain(result.status);
      if (result.status === "partial") {
        expect(result.trace.records.length).toBeLessThanOrEqual(limits.maxRecords);
        expect(result.explanations.size).toBe(0);
      }
      expect(normalizeTraceState(simulator.getCurrentState())).toEqual(before);
      expect(simulator.replayEvents$.value).toBe(events);
    }
  });
  it.each([false, true])(
    "keeps a source beyond the existing scoring traversal unavailable native=%s",
    async (native) => {
      const { replay } = fixture(native);
      const map = buildBeatmap(parseBlueprint(traceMapText("300,192,1000001000,1,0")), {
        mods: [],
        addStacking: false,
      });
      replay.frames[1].time = 1000001200;
      const simulator = new GameSimulator();
      simulator.simulateReplay(map, replay);
      const events = simulator.replayEvents$.value;
      expect(events).toHaveLength(0);
      expect(await simulator.analyzeMisses()).toEqual({
        status: "unsupported",
        reasons: ["source-beyond-canonical-traversal"],
      });
      expect(simulator.getMissExplanation("0")).toBeUndefined();
      expect(simulator.replayEvents$.value).toBe(events);
    },
  );
  it.each([false, true])(
    "deduplicates and caches while preserving complete playback/events native=%s",
    async (native) => {
      const { map, replay } = fixture(native),
        simulator = new GameSimulator();
      simulator.simulateReplay(map, replay, {
        beatmapContentSha256: "a".repeat(64),
        beatmapMd5: "b".repeat(32),
        preparationIdentity: "fixture",
      });
      simulator.simulate(950);
      const before = normalizeTraceState(simulator.getCurrentState()),
        events = simulator.replayEvents$.value;
      const run = jest.spyOn(simulator, "simulateReplay");
      const first = simulator.analyzeMisses(),
        duplicate = simulator.analyzeMisses();
      expect(duplicate).toBe(first);
      expect(simulator.missExplanations$.value.status).toBe("building");
      const result = await first;
      expect(["ready", "partial"]).toContain(result.status);
      expect(simulator.getMissExplanation("0")).toBeDefined();
      expect(simulator.getMissExplanation("1")).toBeUndefined();
      if (result.status === "ready" || result.status === "partial")
        expect(result.identity.beatmapContentSha256).toBe("a".repeat(64));
      expect(await simulator.analyzeMisses()).toBe(result);
      expect(run).not.toHaveBeenCalled();
      expect(normalizeTraceState(simulator.getCurrentState())).toEqual(before);
      expect(simulator.replayEvents$.value).toBe(events);
      simulator.simulateReplay(map, replay);
      expect(simulator.missExplanations$.value.status).toBe("not-captured");
    },
  );
  it.each(["replace", "clear", "profile", "map-only"] as const)(
    "does not publish a pending result after %s",
    async (change) => {
      const { map, replay } = fixture(),
        simulator = new GameSimulator();
      simulator.simulateReplay(map, replay);
      const pending = simulator.analyzeMisses();
      if (change === "replace") simulator.simulateReplay(map, { ...replay });
      else if (change === "clear") simulator.clear();
      else if (change === "map-only") simulator.clearMissExplanations();
      else {
        simulator.setRulesetFocus("lazer");
        simulator.setRulesetFocus("stable");
      }
      const current = simulator.missExplanations$.value;
      await pending;
      expect(simulator.missExplanations$.value).toBe(current);
      expect(simulator.getMissExplanation("0")).toBeUndefined();
      if (change === "map-only" || change === "clear") expect((await simulator.analyzeMisses()).status).toBe("empty");
    },
  );
  it("cancels during traversal and releases the pending job before a new request", async () => {
    const { map, replay } = fixture(),
      simulator = new GameSimulator();
    simulator.simulateReplay(map, replay);
    const original = BucketedGameStateTimeMachine.prototype.captureReplayAsync;
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>((r) => (entered = r)),
      gate = new Promise<void>((r) => (release = r));
    const spy = jest
      .spyOn(BucketedGameStateTimeMachine.prototype, "captureReplayAsync")
      .mockImplementationOnce(async function (this: BucketedGameStateTimeMachine, checkpoint) {
        entered();
        await gate;
        return original.call(this, checkpoint);
      });
    try {
      const pending = simulator.analyzeMisses();
      await entering;
      simulator.simulateReplay(map, { ...replay });
      const next = simulator.analyzeMisses();
      expect(next).not.toBe(pending);
      release();
      await pending;
      const result = await next;
      expect(simulator.missExplanations$.value).toBe(result);
      expect(simulator.getMissExplanation("0")).toBeDefined();
    } finally {
      release?.();
      spy.mockRestore();
    }
  });
  it("preserves the health-derived endpoint and does not infer it again", async () => {
    const { map, replay } = fixture(),
      simulator = new GameSimulator();
    replay.frames.push({ time: 1800, position: { x: 0, y: 0 }, actions: [] });
    replay.lifeBar = [
      { time: 0, health: 1 },
      { time: 1300, health: 0 },
    ];
    simulator.simulateReplay(map, replay);
    const result = await simulator.analyzeMisses();
    if (result.status !== "partial" && result.status !== "ready") throw Error(result.status);
    expect(result.trace.domain).toMatchObject({
      endTimeMs: 1300,
      endpointBasis: "health-derived",
      synthesizedEndpoint: true,
    });
    expect(result.trace.records.filter((r) => r.kind === "input").map((r) => r.timeMs)).toEqual([0, 1200, 1300]);
  });
  it("admits supported Hidden while keeping other modes and cross-rules unavailable", async () => {
    const simulator = new GameSimulator(),
      mod = fixture(false, ["HIDDEN"]);
    simulator.simulateReplay(mod.map, mod.replay);
    expect(["partial", "ready"]).toContain((await simulator.analyzeMisses()).status);
    simulator.simulateReplay(mod.map, { ...mod.replay, gameMode: 1 });
    expect((await simulator.analyzeMisses()).status).toBe("unsupported");
    const plain = fixture();
    simulator.simulateReplay(plain.map, plain.replay);
    simulator.setRulesetFocus("lazer");
    expect((await simulator.analyzeMisses()).status).toBe("unsupported");
    simulator.setRulesetFocus("stable");
    expect(["partial", "ready"]).toContain((await simulator.analyzeMisses()).status);
  });
  it("contains analysis failure and permits retry without corrupting playback", async () => {
    const { map, replay } = fixture(),
      simulator = new GameSimulator();
    simulator.simulateReplay(map, replay);
    simulator.simulate(900);
    const before = normalizeTraceState(simulator.getCurrentState()),
      events = simulator.replayEvents$.value;
    const spy = jest
      .spyOn(BucketedGameStateTimeMachine.prototype, "captureReplayAsync")
      .mockRejectedValueOnce(Error("injected"));
    try {
      expect((await simulator.analyzeMisses()).status).toBe("error");
      expect(["ready", "partial"]).toContain((await simulator.analyzeMisses()).status);
    } finally {
      spy.mockRestore();
    }
    expect(normalizeTraceState(simulator.getCurrentState())).toEqual(before);
    expect(simulator.replayEvents$.value).toBe(events);
  });
});
