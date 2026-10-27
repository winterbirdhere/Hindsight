import {
  buildMissExplanationSession,
  buildMissExplanationSessionAsync,
  serializeMissExplanationSession,
  MissExplanationSessionState,
} from "./MissExplanationSession";
import { createReplayTraceCollector } from "../../../../../../../../libs/osu/core/src/gameplay/trace/ReplayTraceCollector";
import {
  ReplayTrace,
  ReplayTraceObservation,
  TraceRunIdentity,
} from "../../../../../../../../libs/osu/core/src/gameplay/trace/ReplayTrace";
import { traceBeatmap } from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { execFileSync } from "child_process";
import { resolve } from "path";

const identity: TraceRunIdentity = {
  schemaVersion: 1,
  replayContentSha256: null,
  beatmapContentSha256: null,
  beatmapMd5: null,
  generationKey: "session-fixture",
  recordingClient: "synthetic",
  analysisProfileId: "stable",
  analysisProfileFingerprint: "fixture",
  parserVersion: "fixture",
  inputPreparationVersion: "fixture",
};
function fixture(
  options: { lifecycle?: boolean; profile?: string; maxExportBytes?: number; inputRecords?: number } = {},
) {
  const map = traceBeatmap("300,192,1000,1,0\n100,192,1050,1,0\n300,192,5000,1,0\n300,192,1200,2,0,L|340:192,1,40");
  const collector = createReplayTraceCollector(
    { ...identity, analysisProfileId: options.profile ?? "stable" },
    {
      endTimeMs: 1300,
      endpointBasis: "recorded-end",
      synthesizedEndpoint: false,
      sourceCoverageLimits: [],
      initialActionsKnown: true,
    },
    { maxRecords: 200000, maxExportBytes: options.maxExportBytes ?? 64 * 1024 * 1024 },
  );
  const add = (record: Omit<ReplayTraceObservation, "id"> | object) =>
    collector.record({ ...record, id: collector.reserveId() } as ReplayTraceObservation);
  if (options.lifecycle !== false)
    add({
      kind: "lifecycle",
      phase: "lifecycle",
      timeMs: 400,
      componentId: "0",
      component: "circle",
      transition: "activated",
    });
  const inputRecords = options.inputRecords ?? 1;
  for (let index = 0; index < inputRecords; index++)
    add({
      kind: "input",
      phase: "input",
      timeMs: 880,
      position: { x: 500, y: 192 },
      actions: [],
      previousActions: [],
      freshActions: [],
      source: { origin: "parsed", parsedFrameIndex: index },
      groupMemberIndex: 0,
    });
  add({
    kind: "resolution",
    phase: "resolution",
    timeMs: 1050,
    componentId: "1",
    component: "circle",
    result: "GREAT",
    mechanism: "successful-input",
    previousUnresolved: true,
  });
  add({
    kind: "resolution",
    phase: "resolution",
    timeMs: 1111,
    componentId: "0",
    component: "circle",
    result: "MISS",
    mechanism: "automatic-expiry",
    previousUnresolved: true,
  });
  add({
    kind: "resolution",
    phase: "resolution",
    timeMs: 1200,
    componentId: "3",
    component: "slider-head",
    result: "MISS",
    mechanism: "automatic-expiry",
    previousUnresolved: true,
  });
  add({
    kind: "input",
    phase: "input",
    timeMs: 1300,
    position: { x: 500, y: 192 },
    actions: [],
    previousActions: [],
    freshActions: [],
    source: { origin: "parsed", parsedFrameIndex: inputRecords },
    groupMemberIndex: 0,
  });
  for (const channel of ["input", "geometry", "routing", "lifecycle"] as const)
    add({
      kind: "coverage",
      phase: "coverage",
      timeMs: 1300,
      channel,
      status:
        channel === "geometry" || (channel === "lifecycle" && options.lifecycle === false) ? "partial" : "complete",
      reason: channel === "geometry" ? "selected-geometry-only" : "fixture",
      startTimeMs: 0,
      endTimeMs: 1300,
    });
  return { map, trace: collector.seal() };
}
function session(options: Parameters<typeof fixture>[0] = {}) {
  const { trace, map } = fixture(options);
  const state = buildMissExplanationSession(trace, map);
  if (state.status !== "ready" && state.status !== "partial")
    throw new Error(`Unexpected fixture state: ${state.status}`);
  return state;
}
function forgeExplanation(
  state: ReturnType<typeof session>,
  change: (explanation: any) => void,
): MissExplanationSessionState {
  const explanation = JSON.parse(JSON.stringify(state.explanations.get("0")));
  change(explanation);
  return { ...state, explanations: new Map([["0", explanation]]) };
}

describe("miss explanation sidecar session", () => {
  it("only publishes ordinary-circle misses, leaving success, future objects and slider heads alone", () => {
    const state = session();
    expect([...state.explanations.keys()]).toEqual(["0"]);
    expect(state.explanations.get("0")?.findings[0].code).toBe("automatic-expiry");
    expect(state.status).toBe("ready");
  });
  it("marks missing lifecycle evidence partial even when a terminal finding remains available", () => {
    const state = session({ lifecycle: false });
    expect(state.status).toBe("partial");
    if (state.status === "partial") expect(state.reasons.length).toBeGreaterThan(0);
    expect(state.explanations.get("0")?.findings[0].code).toBe("automatic-expiry");
  });
  it("preserves the trace and labels global totals mismatch without fabricating a local cause", () => {
    const { trace, map } = fixture();
    const state = buildMissExplanationSession(trace, map, ["global-totals-mismatch"]);
    expect(state.status).toBe("partial");
    if (state.status !== "partial") throw new Error("Expected partial session");
    expect(state.trace).toBe(trace);
    expect(trace.failures).toEqual([]);
    expect(state.explanations.get("0")?.limitations).toContain("global-totals-mismatch");
    expect(state.explanations.get("0")?.findings[0].code).toBe("automatic-expiry");
  });
  it("exposes a deeply immutable map facade, including the forEach callback map", () => {
    const state = session();
    expect(Object.isFrozen(state)).toBe(true);
    expect((state.explanations as any).set).toBeUndefined();
    expect(() => Map.prototype.set.call(state.explanations, "forged", {})).toThrow();
    state.explanations.forEach((value, key, map) => {
      expect(key).toBe("0");
      expect(map).toBe(state.explanations);
      expect(Object.isFrozen(value.findings)).toBe(true);
      expect(() => (value.limitations as string[]).push("forged")).toThrow();
    });
  });
  it("reports unsupported profiles separately from incomplete evidence", () => {
    const { trace, map } = fixture({ profile: "classic" });
    expect(buildMissExplanationSession(trace, map)).toMatchObject({
      status: "unsupported",
      reasons: expect.any(Array),
    });
  });
  it("rejects unsupported mods even when the trace contains no circle misses", () => {
    const { trace, map } = fixture();
    map.appliedMods.push("HIDDEN");
    const records = trace.records
      .filter((record) => record.kind !== "resolution")
      .map((record, sequence) => ({ ...record, sequence }));
    expect(buildMissExplanationSession({ ...trace, records }, map)).toMatchObject({ status: "unsupported" });
  });
  it("isolates evidence derivation errors without throwing to gameplay callers", () => {
    const { trace, map } = fixture();
    map.getHitObject = () => {
      throw new Error("map unavailable");
    };
    expect(buildMissExplanationSession(trace, map)).toMatchObject({ status: "error", reasons: expect.any(Array) });
  });
  it("bounds miss count and marks truncation partial", () => {
    const { trace } = fixture();
    const records = trace.records.filter((r) => r.kind === "coverage");
    const many: ReplayTrace = {
      ...trace,
      records: [
        ...Array.from({ length: 10001 }, (_, index) => ({
          id: `m${index}`,
          sequence: index,
          kind: "resolution" as const,
          phase: "resolution" as const,
          timeMs: 1111,
          componentId: String(index),
          component: "circle" as const,
          result: "MISS",
          mechanism: "automatic-expiry" as const,
          previousUnresolved: true,
        })),
        ...records.map((r, index) => ({ ...r, id: `c${index}`, sequence: 10001 + index })),
      ],
    };
    const map = traceBeatmap(Array.from({ length: 10001 }, () => "300,192,1000,1,0").join("\n"));
    const state = buildMissExplanationSession(many, map);
    expect(state.status).toBe("partial");
    if (state.status !== "partial") throw new Error("Expected bounded session");
    expect(state.explanations.size).toBeLessThanOrEqual(10000);
    expect(state.reasons).toContain("explanation-count-limit");
  });
});

describe("cooperative miss explanation assembly", () => {
  it("can cancel long trace preparation before deriving any target evidence", async () => {
    const { trace, map } = fixture({ inputRecords: 8192 });
    const visit = jest.spyOn(map, "getHitObject");
    const cancellation = new Error("cancel during preparation");
    let checkpoints = 0;
    const pending = buildMissExplanationSessionAsync(trace, map, [], async () => {
      if (++checkpoints === 3) throw cancellation;
    });
    await expect(pending).rejects.toBe(cancellation);
    expect(checkpoints).toBe(3);
    expect(visit).not.toHaveBeenCalled();
  });

  it.each(["collector-owned", "unowned"] as const)(
    "yields during long %s trace setup and preserves the complete synchronous export",
    async (ownership) => {
      const original = fixture({ inputRecords: 8192 });
      const trace: ReplayTrace =
        ownership === "collector-owned" ? original.trace : JSON.parse(JSON.stringify(original.trace));
      const visit = jest.spyOn(original.map, "getHitObject");
      let preparationCheckpoints = 0;
      const asynchronous = await buildMissExplanationSessionAsync(trace, original.map, [], async () => {
        if (!visit.mock.calls.length) preparationCheckpoints++;
      });
      expect(preparationCheckpoints).toBeGreaterThan(2);
      const synchronous = buildMissExplanationSession(trace, original.map);
      expect(serializeMissExplanationSession(asynchronous)).toBe(serializeMissExplanationSession(synchronous));
    },
  );

  it("owns nested evidence even when an unowned trace is only shallowly frozen", async () => {
    const { trace, map } = fixture();
    const mutable: ReplayTrace = JSON.parse(JSON.stringify(trace));
    const input = mutable.records.find((record) => record.kind === "input")!;
    if (input.kind !== "input") throw new Error("Expected input record");
    const state = await buildMissExplanationSessionAsync(Object.freeze(mutable), map, [], async () => undefined);
    if (state.status !== "ready" && state.status !== "partial") throw new Error("Expected captured session");
    const exported = serializeMissExplanationSession(state);
    input.position.x = 42;
    mutable.domain.sourceCoverageLimits.push("later mutation");
    expect(state.trace).not.toBe(mutable);
    expect(serializeMissExplanationSession(state)).toBe(exported);
    const ownedInput = state.trace.records.find((record) => record.kind === "input")!;
    if (ownedInput.kind !== "input") throw new Error("Expected input record");
    expect(Object.isFrozen(ownedInput.position)).toBe(true);
    expect(() => state.trace.domain.sourceCoverageLimits.push("forged")).toThrow();
    const explanation = state.explanations.get("0")!;
    expect(Object.isFrozen(explanation.findings[0].parameters)).toBe(true);
    expect(() => (explanation.findings[0].eventIds as string[]).push("forged")).toThrow();
  });

  it("counts exact UTF-8 envelope bytes at and one byte below the explanation cap", async () => {
    const original = fixture();
    const limitations = ['coverage-測試🙂"\\'];
    let byteLimit = original.trace.limits.maxExportBytes;
    const limitedTrace = (): ReplayTrace => ({
      ...original.trace,
      identity: { ...original.trace.identity, generationKey: 'session-測試🙂"\\' },
      limits: { ...original.trace.limits, maxExportBytes: byteLimit },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = buildMissExplanationSession(limitedTrace(), original.map, limitations);
      byteLimit = Buffer.byteLength(serializeMissExplanationSession(state), "utf8");
    }
    const exact = await buildMissExplanationSessionAsync(
      limitedTrace(),
      original.map,
      limitations,
      async () => undefined,
    );
    expect(Buffer.byteLength(serializeMissExplanationSession(exact), "utf8")).toBe(byteLimit);
    if (exact.status !== "partial") throw new Error("Expected limitations to remain visible");
    expect(exact.explanations.size).toBe(1);
    byteLimit--;
    const bounded = await buildMissExplanationSessionAsync(
      limitedTrace(),
      original.map,
      limitations,
      async () => undefined,
    );
    expect(bounded.status).toBe("partial");
    if (bounded.status !== "partial") throw new Error("Expected byte cap to remain visible");
    expect(bounded.reasons).toContain("explanation-export-byte-limit");
    expect(bounded.explanations.size).toBe(0);
    expect(bounded.trace.records).toHaveLength(original.trace.records.length);
  });

  it.each([true, false])("preserves synchronous export with lifecycle present=%s", async (lifecycle) => {
    const { trace, map } = fixture({ lifecycle });
    const limitations = ["global-totals-mismatch"];
    const synchronous = buildMissExplanationSession(trace, map, limitations);
    const asynchronous = await buildMissExplanationSessionAsync(trace, map, limitations, async () => undefined);
    expect(serializeMissExplanationSession(asynchronous)).toBe(serializeMissExplanationSession(synchronous));
    expect(Object.isFrozen(asynchronous)).toBe(true);
    if (asynchronous.status !== "ready" && asynchronous.status !== "partial")
      throw new Error("Expected captured session");
    expect((asynchronous.explanations as any).set).toBeUndefined();
  });

  it("waits before setup, between targets and before publishing the final session", async () => {
    const original = fixture();
    const trace: ReplayTrace = {
      ...original.trace,
      records: original.trace.records.map((record) =>
        record.kind === "resolution" && record.componentId === "1"
          ? { ...record, result: "MISS", mechanism: "automatic-expiry" }
          : record,
      ),
    };
    let setupReads = 0;
    const observedTrace = { ...trace };
    Object.defineProperty(observedTrace, "identity", {
      enumerable: true,
      get() {
        setupReads++;
        return trace.identity;
      },
    });
    const visited: string[] = [];
    const getHitObject = original.map.getHitObject.bind(original.map);
    original.map.getHitObject = (targetId) => {
      // Evidence can consult the same geometry more than once (including a
      // direct rejection proof). Observe first access, not lookup call counts.
      if (!visited.includes(targetId)) visited.push(targetId);
      return getHitObject(targetId);
    };
    const gates: Array<() => void> = [];
    const checkpoints: string[][] = [];
    let published = false;
    const pending = buildMissExplanationSessionAsync(observedTrace, original.map, [], () => {
      checkpoints.push([...visited]);
      return new Promise<void>((resolve) => gates.push(resolve));
    }).then((result) => {
      published = true;
      return result;
    });
    expect(setupReads).toBe(0);
    expect(checkpoints).toEqual([[]]);
    gates.shift()!();
    await Promise.resolve();
    expect(setupReads).toBeGreaterThan(0);
    // Preparation may expose additional checkpoints before the first target.
    while (gates.length) {
      expect(published).toBe(false);
      gates.shift()!();
      await Promise.resolve();
    }
    const result = await pending;
    expect(checkpoints).toContainEqual(["1"]);
    expect(checkpoints.at(-1)).toEqual(["1", "0"]);
    expect(checkpoints.filter((targets) => targets.length === 2).length).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("partial");
    expect(published).toBe(true);
  });

  it.each([0, 1, 2])("propagates cancellation from checkpoint %s", async (rejectAt) => {
    const { trace, map } = fixture();
    const cancellation = new Error("generation cancelled");
    let checkpointIndex = 0;
    const pending = buildMissExplanationSessionAsync(trace, map, [], async () => {
      if (checkpointIndex++ === rejectAt) throw cancellation;
    });
    await expect(pending).rejects.toBe(cancellation);
  });

  it.each(["unsupported", "error", "byte-limit"] as const)("preserves synchronous %s state", async (outcome) => {
    const original = fixture({ profile: outcome === "unsupported" ? "classic" : "stable" });
    if (outcome === "error")
      original.map.getHitObject = () => {
        throw new Error("map unavailable");
      };
    const trace =
      outcome === "byte-limit"
        ? {
            ...original.trace,
            limits: {
              ...original.trace.limits,
              maxExportBytes: Buffer.byteLength(JSON.stringify(original.trace), "utf8") + 500,
            },
          }
        : original.trace;
    const synchronous = buildMissExplanationSession(trace, original.map);
    const asynchronous = await buildMissExplanationSessionAsync(trace, original.map, [], async () => undefined);
    expect(asynchronous).toEqual(
      synchronous.status === "partial" ? { ...synchronous, explanations: expect.any(Object) } : synchronous,
    );
    if (asynchronous.status === "partial" && synchronous.status === "partial")
      expect(Array.from(asynchronous.explanations)).toEqual(Array.from(synchronous.explanations));
  });
});

describe("headless miss explanation export", () => {
  it("exports a deterministic versioned envelope with model references", () => {
    const state = session();
    const first = serializeMissExplanationSession(state);
    expect(serializeMissExplanationSession(session())).toBe(first);
    const result = JSON.parse(first);
    expect(Object.keys(result)).toEqual(["schemaVersion", "identity", "trace", "explanations", "limitations"]);
    expect(result.schemaVersion).toBe(1);
    expect(result.explanations[0].targetId).toBe("0");
    expect(result.explanations[0].findings[0].eventIds).toEqual(["r3"]);
  });
  it.each(["empty", "not-captured", "building", "unsupported", "error"] as const)(
    "does not export %s sessions",
    (status) => {
      expect(() => serializeMissExplanationSession({ status, reasons: [] } as MissExplanationSessionState)).toThrow();
    },
  );
  it.each([
    [
      "event reference",
      (e: any) => {
        e.findings[0].eventIds = ["missing"];
      },
    ],
    [
      "main finding reference",
      (e: any) => {
        e.mainFindingId = "missing";
      },
    ],
    [
      "terminal reference",
      (e: any) => {
        e.findings[0].eventIds = ["r1"];
      },
    ],
    [
      "schema version",
      (e: any) => {
        e.schemaVersion = 2;
      },
    ],
    [
      "run identity",
      (e: any) => {
        e.identity.generationKey = "another-run";
      },
    ],
    [
      "nonfinite parameter",
      (e: any) => {
        e.findings[0].parameters.offsetMs = Infinity;
      },
    ],
    [
      "invalid basis",
      (e: any) => {
        e.findings[0].bases = ["guess"];
      },
    ],
    [
      "invalid predicate",
      (e: any) => {
        e.findings[0].state = "definitely";
      },
    ],
    [
      "descriptor code",
      (e: any) => {
        e.findings[0].code = "player-intent";
      },
    ],
    [
      "dependency channel",
      (e: any) => {
        e.findings[0].dependencies = ["guessed"];
      },
    ],
    [
      "nonnumeric parameter",
      (e: any) => {
        e.findings[0].parameters.offsetMs = "early";
      },
    ],
    [
      "finding reasons",
      (e: any) => {
        e.findings[0].reasons = [7];
      },
    ],
    [
      "inapplicable supported finding",
      (e: any) => {
        e.findings[0].applicable = false;
      },
    ],
    [
      "unsupported main finding",
      (e: any) => {
        e.findings[0].state = "indeterminate";
      },
    ],
    [
      "sparse event reference list",
      (e: any) => {
        e.findings[1].eventIds = Array(1);
      },
    ],
    [
      "sparse dependency list",
      (e: any) => {
        e.findings[0].dependencies = Array(1);
      },
    ],
  ] as const)("rejects a forged %s", (_name, mutate) => {
    expect(() => serializeMissExplanationSession(forgeExplanation(session(), mutate))).toThrow();
  });
  it("rejects the finding limit even if the trace and all individual references are valid", () => {
    const forged = forgeExplanation(session(), (explanation) => {
      const finding = explanation.findings[0];
      explanation.findings = Array.from({ length: 10001 }, (_, index) => ({ ...finding, id: `finding-${index}` }));
      explanation.mainFindingId = "finding-0";
    });
    expect(() => serializeMissExplanationSession(forged)).toThrow(/limit/i);
  });
  it("rejects a session identity from another replay even when its trace is valid", () => {
    const state = session();
    expect(() =>
      serializeMissExplanationSession({ ...state, identity: { ...state.identity, generationKey: "other" } }),
    ).toThrow();
  });
  it("rejects an explanation for an object without an ordinary-circle miss resolution", () => {
    const state = session();
    const explanation = { ...state.explanations.get("0")!, targetId: "2", findings: [], mainFindingId: undefined };
    expect(() => serializeMissExplanationSession({ ...state, explanations: new Map([["2", explanation]]) })).toThrow();
  });
  it("preserves partial reasons with the actual diagnostic tools ES5 runner", () => {
    const { trace } = fixture();
    const script = `
      const { buildMissExplanationSession, serializeMissExplanationSession } = require('./apps/desktop/frontend/src/app/services/analysis/miss-explanation/MissExplanationSession');
      const { traceBeatmap } = require('./libs/osu/core/test/ReplayTraceFixtures');
      const trace = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      const state = buildMissExplanationSession(trace, traceBeatmap('300,192,1000,1,0'), ['global-totals-mismatch']);
      process.stdout.write(serializeMissExplanationSession(state));
    `;
    const result = execFileSync(
      process.execPath,
      ["-r", "ts-node/register/transpile-only", "-r", "tsconfig-paths/register", "-e", script],
      {
        cwd: resolve(__dirname, "../../../../../../../.."),
        env: { ...process.env, TS_NODE_PROJECT: "tools/tsconfig.tools.json" },
        input: JSON.stringify(trace),
        encoding: "utf8",
        timeout: 15000,
      },
    );
    expect(JSON.parse(result).limitations).toContain("global-totals-mismatch");
  });
  it("applies the byte cap to explanations and envelope overhead as well as trace", () => {
    const state = session();
    const size = Buffer.byteLength(JSON.stringify(state.trace), "utf8") + 500;
    const trace = { ...state.trace, limits: { ...state.trace.limits, maxExportBytes: size } };
    expect(() => serializeMissExplanationSession({ ...state, trace })).toThrow(/limit/i);
  });
  it("marks explanation byte exhaustion partial without dropping gameplay trace records", () => {
    const original = fixture();
    const size = Buffer.byteLength(JSON.stringify(original.trace), "utf8") + 500;
    const trace = { ...original.trace, limits: { ...original.trace.limits, maxExportBytes: size } };
    const state = buildMissExplanationSession(trace, original.map);
    expect(state.status).toBe("partial");
    if (state.status !== "partial") throw new Error("Expected partial session");
    expect(state.reasons).toContain("explanation-export-byte-limit");
    expect(state.trace.records).toHaveLength(original.trace.records.length);
  });
});
