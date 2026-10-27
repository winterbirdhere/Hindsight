import { CircleEvidence, deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { Slider } from "../src/hitobjects/Slider";
import { StableSliderTiming } from "../src/gameplay/StableSliderTiming";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { createReplayTraceCollector } from "../src/gameplay/trace/ReplayTraceCollector";
import { ReplayTrace, ReplayTraceRecord } from "../src/gameplay/trace/ReplayTrace";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame, traceMapText } from "./ReplayTraceFixtures";

type Witness = {
  inputId: string;
  attemptId: string;
  selectionId: string;
  policyId: string;
  blockerId: string;
  timingResult: "GREAT" | "OK" | "MEH";
  offsetMs: number;
  eventIds: string[];
};
type Fixture = ReturnType<typeof errorFixture>;

function witnesses(f: Fixture, target = "1", trace = f.trace): Witness[] {
  const evidence = deriveCircleEvidence(trace, f.map, target) as CircleEvidence & { directRejections?: Witness[] };
  return evidence.directRejections ?? [];
}
function blocked(offset = -40, actions = [0], profile: "stable" | "lazer" = "stable", recover = false) {
  const time = 1080 + offset;
  return errorFixture(
    "100,192,1000,1,0\n300,192,1080,1,0",
    [
      traceFrame(700, 50),
      traceFrame(time - 1, 300),
      traceFrame(time, 300, actions),
      traceFrame(time + 1, 300),
      ...(recover ? [traceFrame(1112, 300), traceFrame(1120, 300, [1]), traceFrame(1121, 300)] : []),
      traceFrame(1400, 400),
    ],
    profile,
  );
}
function chain(trace: ReplayTrace, target = "1") {
  const policy = trace.records.find((r) => r.kind === "policy" && r.componentId === target && r.state === "rejected");
  if (!policy || policy.kind !== "policy") throw Error("Fixture has no actual rejection");
  const attempt = trace.records.find((r) => r.kind === "attempt" && r.id === policy.attemptId);
  if (!attempt || attempt.kind !== "attempt") throw Error("Missing actual attempt");
  const input = trace.records.find((r) => r.kind === "input" && r.id === attempt.inputId);
  const selection = trace.records.find((r) => r.kind === "selection" && r.attemptId === attempt.id);
  const targetTerminal = trace.records.find((r) => r.kind === "resolution" && r.componentId === target);
  const blockerTerminal = trace.records.find((r) => r.kind === "resolution" && r.componentId === policy.blockerId);
  const activation = trace.records.find((r) => r.kind === "lifecycle" && r.componentId === target);
  if (
    !input ||
    input.kind !== "input" ||
    !selection ||
    selection.kind !== "selection" ||
    !targetTerminal ||
    targetTerminal.kind !== "resolution" ||
    !activation ||
    activation.kind !== "lifecycle"
  )
    throw Error("Incomplete real fixture");
  return { policy, attempt, input, selection, targetTerminal, blockerTerminal, activation };
}
const clone = (trace: ReplayTrace) => JSON.parse(JSON.stringify(trace)) as ReplayTrace;
function moved(trace: ReplayTrace, record: ReplayTraceRecord, anchor: ReplayTraceRecord, after: boolean): ReplayTrace {
  const records = trace.records.filter((r) => r.id !== record.id);
  records.splice(records.findIndex((r) => r.id === anchor.id) + (after ? 1 : 0), 0, record);
  return { ...trace, records: records.map((r, sequence) => ({ ...r, sequence })) };
}

describe("M59 direct target rejection witness guards", () => {
  it.each([
    [-10, "GREAT"],
    [-40, "OK"],
    [-80, "MEH"],
  ] as const)("admits an actual blocked %s ms input with prospective %s timing", (offset, grade) => {
    const f = blocked(offset),
      c = chain(f.trace);
    expect(c.policy.timingResult).toBe(grade);
    expect(c.targetTerminal).toMatchObject({ result: "MISS", mechanism: "automatic-expiry" });
    expect(witnesses(f)).toContainEqual(
      expect.objectContaining({
        inputId: c.input.id,
        attemptId: c.attempt.id,
        selectionId: c.selection.id,
        policyId: c.policy.id,
        blockerId: "0",
        timingResult: grade,
        offsetMs: offset,
      }),
    );
  });

  it("admits both actual Stable attempts from a paired fresh-action frame", () => {
    const f = blocked(-40, [0, 1]);
    const attempts = f.trace.records.filter((r) => r.kind === "attempt");
    expect(attempts).toHaveLength(2);
    expect(
      attempts.every((a) => a.kind === "attempt" && a.knownAction === undefined && a.actionCandidates.length === 2),
    ).toBe(true);
    expect(witnesses(f)).toHaveLength(2);
    expect(new Set(witnesses(f).map((w) => w.attemptId)).size).toBe(2);
    expect(new Set(witnesses(f).map((w) => w.inputId)).size).toBe(1);
  });

  it("admits a native known-action rejection under its own start-time policy", () => {
    const f = blocked(-90, [1], "lazer"),
      c = chain(f.trace);
    expect(c.policy.branch).toBe("native:start-time-ordered");
    expect(c.attempt.knownAction).toBe(1);
    expect(c.policy.timeMs).toBeLessThan(1000);
    expect(witnesses(f)).toContainEqual(
      expect.objectContaining({ inputId: c.input.id, blockerId: "0", timingResult: "MEH" }),
    );
  });

  it.each([false, true])("requires the actual native Classic policy setting (Classic=%s)", (classic) => {
    const f = errorFixture(
      "100,192,1000,1,0\n300,192,1080,1,0",
      [
        traceFrame(700, 50),
        traceFrame(989, 300),
        traceFrame(990, 300, [1]),
        traceFrame(991, 300),
        traceFrame(1400, 400),
      ],
      "lazer",
      [],
      classic ? [{ acronym: "CL" }] : [],
    );
    const trace = clone(f.trace),
      c = chain(trace);
    expect(c.policy.branch).toBe(classic ? "native:classic-note-lock" : "native:start-time-ordered");
    expect(witnesses(f)).toHaveLength(1);
    c.policy.branch = classic ? "native:start-time-ordered" : "native:classic-note-lock";
    expect(witnesses(f, "1", trace)).toEqual([]);
    expect(classifyCircleLoss(deriveCircleEvidence(trace, f.map, "1"), f.map, trace).codes).not.toContain("notelock");
  });

  const invalid: Array<[string, (c: ReturnType<typeof chain>) => void]> = [
    [
      "wrong target selection",
      (c) => {
        c.selection.componentId = "0";
      },
    ],
    [
      "wrong selected component kind",
      (c) => {
        c.selection.component = "slider-head";
      },
    ],
    [
      "missing receptor selection",
      (c) => {
        c.selection.componentId = null;
        c.selection.inside = null;
      },
    ],
    [
      "ineligible selection",
      (c) => {
        c.selection.eligible = false;
      },
    ],
    [
      "non-stopping selection",
      (c) => {
        c.selection.selectionStopped = false;
      },
    ],
    [
      "outside selection",
      (c) => {
        c.selection.inside = false;
      },
    ],
    [
      "outside prepared geometry",
      (c) => {
        c.input.position.x = 500;
      },
    ],
    [
      "unsuccessful timing",
      (c) => {
        c.policy.timingResult = "MISS";
      },
    ],
    [
      "missing timing",
      (c) => {
        c.policy.timingResult = null;
      },
    ],
    [
      "unknown timing grade",
      (c) => {
        c.policy.timingResult = "PERFECT";
      },
    ],
    [
      "incorrect successful grade",
      (c) => {
        c.policy.timingResult = "GREAT";
      },
    ],
    [
      "forged offset",
      (c) => {
        c.policy.offsetMs = 0;
      },
    ],
    [
      "different policy time",
      (c) => {
        c.policy.timeMs += 1;
      },
    ],
    [
      "different selection time",
      (c) => {
        c.selection.timeMs += 1;
      },
    ],
    [
      "different attempt time",
      (c) => {
        c.attempt.timeMs += 1;
      },
    ],
    [
      "held-only callback",
      (c) => {
        c.input.previousActions = [0];
        c.input.freshActions = [];
      },
    ],
    [
      "inconsistent fresh state",
      (c) => {
        c.input.previousActions = [0];
      },
    ],
    [
      "wrong action candidate",
      (c) => {
        c.attempt.actionCandidates = [1];
        c.attempt.knownAction = 1;
      },
    ],
    [
      "out-of-range attempt ordinal",
      (c) => {
        c.attempt.attemptOrdinal = 1;
      },
    ],
    [
      "automated callback",
      (c) => {
        c.attempt.automated = true;
        c.attempt.actionCandidates = [];
        delete c.attempt.knownAction;
      },
    ],
    [
      "missing blocker",
      (c) => {
        delete c.policy.blockerId;
      },
    ],
    [
      "nonexistent blocker",
      (c) => {
        c.policy.blockerId = "missing";
      },
    ],
    [
      "self blocker",
      (c) => {
        c.policy.blockerId = "1";
      },
    ],
    [
      "unknown policy branch",
      (c) => {
        c.policy.branch = "test:unrelated-rejection";
      },
    ],
    [
      "late target activation",
      (c) => {
        c.activation.timeMs = c.policy.timeMs + 1;
      },
    ],
  ];
  it.each(invalid)("does not use %s as a direct rejection witness", (_name, mutate) => {
    const f = blocked(),
      trace = clone(f.trace),
      c = chain(trace);
    expect(c.policy).toMatchObject({ timingResult: "OK", state: "rejected", blockerId: "0" });
    expect(c.input.freshActions).toEqual([0]);
    mutate(c);
    expect(witnesses(f, "1", trace)).toEqual([]);
    const result = classifyCircleLoss(deriveCircleEvidence(trace, f.map, "1"), f.map, trace);
    expect(result.codes).not.toContain("notelock");
  });

  it("rejects a source gap immediately before the recorded edge", () => {
    const f = blocked(),
      trace = clone(f.trace),
      c = chain(trace);
    if (c.input.source.origin !== "parsed") throw Error("fixture source");
    c.input.source.discontinuityBefore = ["test-gap"];
    expect(
      deriveCircleEvidence(trace, f.map, "1").inputs.find((i) => i.record.id === c.input.id)?.freshActionsKnown,
    ).toBe(false);
    expect(witnesses(f, "1", trace)).toEqual([]);
  });

  it("requires previous actions to match the actual adjacent source predecessor", () => {
    const f = blocked(),
      trace = clone(f.trace),
      c = chain(trace);
    const previous = trace.records.filter((r) => r.kind === "input" && r.sequence < c.input.sequence).pop();
    if (!previous || previous.kind !== "input") throw Error("missing predecessor");
    expect(previous.timeMs).toBe(c.input.timeMs - 1);
    previous.actions = [0];
    previous.freshActions = [0];
    expect(c.input.previousActions).toEqual([]);
    expect(witnesses(f, "1", trace)).toEqual([]);
    expect(classifyCircleLoss(deriveCircleEvidence(trace, f.map, "1"), f.map, trace).codes).not.toContain("notelock");
  });

  it("requires the blocker's own recorded activation", () => {
    const f = blocked();
    const trace: ReplayTrace = {
      ...f.trace,
      records: f.trace.records.filter((r) => !(r.kind === "lifecycle" && r.componentId === "0")),
    };
    expect(witnesses(f, "1", trace)).toEqual([]);
  });

  it("rejects a real map object in the wrong blocker direction", () => {
    const f = errorFixture("100,192,1000,1,0\n300,192,1080,1,0\n450,192,1160,1,0", [
      traceFrame(700, 50),
      traceFrame(1039, 300),
      traceFrame(1040, 300, [0]),
      traceFrame(1041, 300),
      traceFrame(1500, 400),
    ]);
    const trace = clone(f.trace),
      c = chain(trace);
    c.policy.blockerId = "2";
    expect(witnesses(f, "1", trace)).toEqual([]);
  });

  it("requires the native branch's actual latest earlier policy circle", () => {
    const f = errorFixture(
      "100,192,1000,1,0\n150,192,1020,1,0\n300,192,1080,1,0",
      [
        traceFrame(700, 50),
        traceFrame(989, 300),
        traceFrame(990, 300, [1]),
        traceFrame(991, 300),
        traceFrame(1500, 400),
      ],
      "lazer",
    );
    const trace = clone(f.trace),
      c = chain(trace, "2");
    expect(c.policy).toMatchObject({ blockerId: "1", branch: "native:start-time-ordered", timingResult: "MEH" });
    c.policy.blockerId = "0";
    expect(witnesses(f, "2", trace)).toEqual([]);
  });

  it.each([false, true])("requires the first live eligible parent blocker (Classic=%s)", (classic) => {
    const f = errorFixture(
      "100,192,1000,1,0\n150,192,1020,1,0\n300,192,1080,1,0",
      [
        traceFrame(700, 50),
        traceFrame(1039, 300),
        traceFrame(1040, 300, [1]),
        traceFrame(1041, 300),
        traceFrame(1500, 400),
      ],
      classic ? "lazer" : "stable",
      [],
      classic ? [{ acronym: "CL" }] : [],
    );
    const trace = clone(f.trace),
      c = chain(trace, "2");
    expect(c.policy.blockerId).toBe("0");
    expect(witnesses(f, "2")).toHaveLength(1);
    const otherTerminal = trace.records.find((r) => r.kind === "resolution" && r.componentId === "1");
    expect(otherTerminal?.sequence).toBeGreaterThan(c.policy.sequence);
    c.policy.blockerId = "1";
    expect(witnesses(f, "2", trace)).toEqual([]);
  });

  it("requires selection before policy even at the same timestamp", () => {
    const f = blocked(),
      trace = clone(f.trace),
      c = chain(trace);
    expect(witnesses(f, "1", moved(trace, c.policy, c.selection, false))).toEqual([]);
  });

  it("does not use a preterminal input whose later same-time attempt/selection is post-terminal", () => {
    const f = blocked(),
      trace = clone(f.trace),
      c = chain(trace);
    c.targetTerminal.timeMs = c.input.timeMs;
    const changed = moved(trace, c.targetTerminal, c.attempt, false);
    const e = deriveCircleEvidence(changed, f.map, "1");
    expect(e.inputs.find((i) => i.record.id === c.input.id)?.postTerminal).toBe(false);
    expect(witnesses(f, "1", changed)).toEqual([]);
  });

  it.each([false, true])("checks blocker resolution sequence at the same timestamp (after=%s)", (after) => {
    const f = blocked(),
      trace = clone(f.trace),
      c = chain(trace);
    if (!c.blockerTerminal || c.blockerTerminal.kind !== "resolution") throw Error("fixture blocker");
    c.blockerTerminal.timeMs = c.policy.timeMs;
    const changed = moved(trace, c.blockerTerminal, c.policy, after);
    expect(witnesses(f, "1", changed).length).toBe(after ? 1 : 0);
  });

  it("does not infer a fresh edge from an unknown initial source state", () => {
    const f = blocked();
    const c = chain(f.trace);
    const trace: ReplayTrace = {
      ...clone(f.trace),
      domain: { ...f.trace.domain, initialActionsKnown: false },
      records: clone(f.trace).records.filter((r) => r.kind !== "input" || r.sequence >= c.input.sequence),
    };
    expect(witnesses(f, "1", trace)).toEqual([]);
  });

  it("does not erase local positive proof because initial source elsewhere is unknown", () => {
    const f = blocked(),
      trace = clone(f.trace);
    trace.domain.initialActionsKnown = false;
    trace.domain.sourceCoverageLimits.push("initial-actions-unknown");
    expect(witnesses(f, "1", trace)).toHaveLength(1);
  });

  it("does not override a lifecycle conflict on the named blocker", () => {
    const f = blocked();
    const trace: ReplayTrace = {
      ...clone(f.trace),
      failures: [...f.trace.failures, "dependency-conflict:lifecycle:0"],
    };
    expect(witnesses(f, "1", trace)).toEqual([]);
    expect(classifyCircleLoss(deriveCircleEvidence(trace, f.map, "1"), f.map, trace).codes).not.toContain("notelock");
  });

  it("uses the Stable slider deadline rather than the native parent trace object time", () => {
    const base = blocked();
    const map = buildBeatmap(
      parseBlueprint(
        traceMapText("100,192,1000,2,0,L|100:94,1,97.5\n300,192,1128,1,0")
          .replace("SliderMultiplier:1", "SliderMultiplier:2.6")
          .replace("0,500,4,1,0,100,1,0", "0,500,4,1,0,100,1,0\n0,-66.6666666666667,4,1,0,100,0,0"),
      ),
      { addStacking: false, mods: [] },
    );
    const frames = [
      traceFrame(800, 100),
      traceFrame(1000, 100, [0]),
      traceFrame(1001, 100),
      traceFrame(1080, 300, [1]),
      traceFrame(1081, 300),
      traceFrame(1400, 400),
    ];
    const capture = createReplayTraceCollector(
      base.trace.identity,
      {
        ...base.trace.domain,
        endTimeMs: 1400,
        frameSources: frames.map((_, parsedFrameIndex) => ({ origin: "parsed", parsedFrameIndex })),
      },
      { maxRecords: 200000, maxExportBytes: 64 * 1024 * 1024 },
    );
    const state = new BucketedGameStateTimeMachine(
      frames,
      map,
      { noteLockStyle: "STABLE", hitWindowStyle: "OSU_STABLE" },
      undefined,
      capture,
    ).gameStateAt(Infinity);
    const f = { ...base, map, state, trace: capture.seal() };
    const slider = map.hitObjects[0] as Slider;
    // Source-shaped float speed yields Stable 1124; the shared/native end is 1125.
    expect(new StableSliderTiming(slider).endTime).toBe(1124);
    expect(slider.endTime + 3).toBeGreaterThanOrEqual(1128);
    const c = chain(f.trace);
    expect(c.policy).toMatchObject({ state: "rejected", blockerId: "0", timingResult: "OK", offsetMs: -48 });
    expect(witnesses(f)).toContainEqual(expect.objectContaining({ blockerId: "0", offsetMs: -48 }));
    expect(classifyCircleLoss(deriveCircleEvidence(f.trace, f.map, "1"), f.map, f.trace).codes).toEqual(["notelock"]);
  });

  it("uses slider-parent lifetime after a successfully resolved head", () => {
    const f = errorFixture("100,192,1000,2,0,L|120:192,1,20\n300,192,1104,1,0", [
      traceFrame(800, 100),
      traceFrame(1000, 100, [0]),
      traceFrame(1001, 100),
      traceFrame(1100, 300, [1]),
      traceFrame(1101, 300),
      traceFrame(1400, 400),
    ]);
    const c = chain(f.trace);
    expect(f.state.hitCircleVerdict["0/HEAD"].type).toBe("GREAT");
    expect(c.policy.blockerId).toBe("0");
    const parent = f.trace.records.find((r) => r.kind === "slider-parent" && r.componentId === "0");
    expect(parent?.sequence).toBeGreaterThan(c.policy.sequence);
    expect(witnesses(f)).toContainEqual(expect.objectContaining({ blockerId: "0", timingResult: "GREAT" }));
  });

  it("uses a spinner parent still unresolved during its exact-end input phase", () => {
    const f = errorFixture("256,192,1000,8,0,1500\n300,192,1504,1,0", [
      traceFrame(800, 300),
      traceFrame(1499, 300),
      traceFrame(1500, 300, [0]),
      traceFrame(1501, 300),
      traceFrame(1750, 400),
    ]);
    const c = chain(f.trace);
    const spinner = f.trace.records.find((r) => r.kind === "spinner-resolution" && r.componentId === "0");
    expect(c.policy.blockerId).toBe("0");
    expect(spinner?.sequence).toBeGreaterThan(c.policy.sequence);
    expect(witnesses(f)).toContainEqual(expect.objectContaining({ blockerId: "0", timingResult: "GREAT" }));
  });

  it("does not convert a later recovery into an expiry-MISS witness", () => {
    const f = blocked(-40, [0], "stable", true),
      c = chain(f.trace);
    expect(c.policy.timingResult).toBe("OK");
    expect(c.targetTerminal.mechanism).toBe("successful-input");
    expect(c.targetTerminal.result).not.toBe("MISS");
    expect(witnesses(f)).toEqual([]);
  });

  it("keeps a direct early-input MISS outside expiry-witness scope", () => {
    const f = errorFixture("300,192,1000,1,0", [
      traceFrame(600, 300),
      traceFrame(700, 300, [0]),
      traceFrame(1300, 300),
    ]);
    expect(deriveCircleEvidence(f.trace, f.map, "0").terminal?.mechanism).toBe("input-miss");
    expect(witnesses(f, "0")).toEqual([]);
  });

  it("keeps native forced MISS outside expiry-witness scope", () => {
    const f = errorFixture(
      "100,192,1000,1,0\n300,192,1080,1,0",
      [traceFrame(800, 50), traceFrame(1080, 300, [0]), traceFrame(1400, 400)],
      "lazer",
    );
    expect(deriveCircleEvidence(f.trace, f.map, "0").terminal?.mechanism).toBe("ordered-force-miss");
    expect(witnesses(f, "0")).toEqual([]);
  });
});
