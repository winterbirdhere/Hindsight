import {
  BucketedGameStateTimeMachine,
  LazerGameStateTimeMachine,
  createReplayTraceCollector,
  deriveCircleEvidence,
  explainCircleMiss,
  serializeReplayTrace,
  type MissExplanation,
  type MissFinding,
  type MissDescriptorCode,
  type ReplayTraceRecord,
} from "@osujs/core";
import { traceBeatmap, traceFrame } from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { summarizeMissExplanation } from "./miss-explanation-copy";

const expiry = "The circle expired unresolved in the model.";
const dispatch = "In the model, at least one in-circle action in the live success window was routed to another object.";
const blocked = "In the model, at least one attempt in the live success window was blocked by object order.";
const outside = "At least one fresh action in that window was outside the circle.";
const allOutside =
  "All recorded fresh logical actions in the model's covered live success window were outside this circle.";
const noFresh = "No fresh logical action was recorded in the model's covered live success window.";
const overlap =
  "The approximate reconstructed path overlaps the live success window without an in-circle fresh action.";
const conflict = `${expiry} Window evidence conflicts; see the detailed findings.`;
type Context = { records: ReadonlyMap<string, ReplayTraceRecord>; lifecycleComplete: boolean };
// Allow behavioral RED before the readonly presentation context is added.
const summarize = summarizeMissExplanation as (e: MissExplanation, c?: Context) => string;

function fixture(profile: "stable" | "lazer") {
  const identity = {
    schemaVersion: 1 as const,
    replayContentSha256: null,
    beatmapContentSha256: null,
    beatmapMd5: null,
    generationKey: "headline-test",
    recordingClient: "synthetic",
    analysisProfileId: profile,
    analysisProfileFingerprint: "same-source",
    parserVersion: "fixture",
    inputPreparationVersion: "fixture",
  };
  const records = new Map<string, ReplayTraceRecord>();
  const add = (r: ReplayTraceRecord) => records.set(r.id, r);
  add({
    id: "active",
    sequence: 0,
    timeMs: 400,
    kind: "lifecycle",
    phase: "lifecycle",
    componentId: "target",
    component: "circle",
    transition: "activated",
  });
  for (const [id, sequence, timeMs] of [
    ["outside", 1, 950],
    ["input", 2, 1000],
    ["input2", 6, 1050],
  ] as const) {
    add({
      id,
      sequence,
      timeMs,
      kind: "input",
      phase: "input",
      position: { x: 0, y: 0 },
      previousActions: [],
      actions: [0],
      freshActions: [0],
      source: { origin: "parsed", parsedFrameIndex: sequence },
      groupMemberIndex: 0,
    });
  }
  add({
    id: "attempt",
    sequence: 3,
    timeMs: 1000,
    kind: "attempt",
    phase: "attempt",
    inputId: "input",
    attemptOrdinal: 0,
    actionCandidates: [0],
  });
  add({
    id: "selection",
    sequence: 4,
    timeMs: 1000,
    kind: "selection",
    phase: "dispatch",
    attemptId: "attempt",
    componentId: "other",
    inside: true,
    eligible: true,
    selectionStopped: true,
  });
  add({
    id: "attempt2",
    sequence: 7,
    timeMs: 1050,
    kind: "attempt",
    phase: "attempt",
    inputId: "input2",
    attemptOrdinal: 0,
    actionCandidates: [0],
  });
  add({
    id: "policy",
    sequence: 8,
    timeMs: 1050,
    kind: "policy",
    phase: "dispatch",
    attemptId: "attempt2",
    componentId: "target",
    state: "rejected",
    branch: profile,
    offsetMs: 50,
    timingResult: "MEH",
    blockerId: "other",
  });
  add({
    id: "terminal",
    sequence: 10,
    timeMs: 1120,
    kind: "resolution",
    phase: "resolution",
    componentId: "target",
    component: "circle",
    result: "MISS",
    mechanism: "automatic-expiry",
    previousUnresolved: true,
  });
  const findings: MissFinding[] = [];
  function finding(code: MissDescriptorCode, changes: Partial<MissFinding> = {}) {
    const f: MissFinding = {
      id: code,
      code,
      applicable: true,
      state: "supported",
      bases: ["model-trace"],
      dependencies: ["input", "lifecycle"],
      eventIds: [],
      parameters: {},
      reasons: [],
      ...changes,
    };
    findings.push(f);
    return f;
  }
  finding("automatic-expiry", { eventIds: ["terminal"], dependencies: ["lifecycle"] });
  const domain = { domainStartTimeMs: 900, domainEndTimeMs: 1100, freshActionCount: 3 };
  finding("no-fresh-action", {
    state: "not-supported",
    eventIds: ["outside", "input", "input2"],
    parameters: { ...domain },
  });
  finding("all-fresh-actions-outside", {
    state: "not-supported",
    eventIds: ["outside", "input", "input2"],
    parameters: { ...domain },
  });
  const explanation: MissExplanation = {
    schemaVersion: 1,
    identity,
    targetId: "target",
    status: "supported",
    findings,
    mainFindingId: "automatic-expiry",
    limitations: [],
  };
  const context: Context = { records, lifecycleComplete: true };
  const route = (code: "dispatch-stopped" | "order-blocked" = "dispatch-stopped") =>
    finding(code, {
      eventIds: code === "dispatch-stopped" ? ["input", "attempt", "selection"] : ["input2", "attempt2", "policy"],
      parameters: { offsetMs: code === "dispatch-stopped" ? 0 : 50 },
    });
  const press = () =>
    finding("press-outside", {
      eventIds: ["outside"],
      parameters: { offsetMs: -50, postTerminal: 0, inLiveSuccess: 1 },
    });
  const whole = (code: "no-fresh-action" | "all-fresh-actions-outside") => {
    const f = findings.find((f) => f.code === code)!;
    f.state = "supported";
    if (code === "no-fresh-action") {
      f.parameters.freshActionCount = 0;
      f.eventIds = [];
    }
    return f;
  };
  return { explanation, context, records, finding, route, press, whole };
}

describe.each(["stable", "lazer"] as const)("%s expiry headline presentation", (profile) => {
  it("presents competing actions from an actual sealed profile capture without changing it", () => {
    const map = traceBeatmap("300,192,1000,1,0\n300,192,1050,1,0");
    const frames = [
      traceFrame(800, 500),
      traceFrame(950, 500, [0]),
      traceFrame(970, 300),
      traceFrame(1000, 300, [1]),
      traceFrame(1200, 500),
    ];
    const collector = createReplayTraceCollector(
      fixture(profile).explanation.identity,
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
          collector,
        )
      : new LazerGameStateTimeMachine(frames, map, undefined, {}, collector)
    ).gameStateAt(1200);
    const trace = collector.seal(),
      explanation = explainCircleMiss(deriveCircleEvidence(trace, map, "1"));
    const before = serializeReplayTrace(trace) + JSON.stringify(explanation);
    expect(
      summarize(explanation, {
        records: new Map(trace.records.map((r) => [r.id, r])),
        lifecycleComplete: trace.coverage.lifecycle === "complete",
      }),
    ).toBe(`${dispatch} ${outside}`);
    expect(serializeReplayTrace(trace) + JSON.stringify(explanation)).toBe(before);
  });
  it("uses the scoped dispatch category rather than the nominated main or one outside press", () => {
    const f = fixture(profile);
    f.press();
    f.route();
    f.explanation.mainFindingId = "press-outside";
    expect(summarize(f.explanation, f.context)).toBe(`${dispatch} ${outside}`);
  });
  it("distinguishes object-order blocking", () => {
    const f = fixture(profile);
    f.route("order-blocked");
    expect(summarize(f.explanation, f.context)).toBe(blocked);
  });
  it("retains both routing categories independent of finding order, without changing evidence", () => {
    const f = fixture(profile);
    f.route();
    f.route("order-blocked");
    f.press();
    const before = JSON.stringify(f.explanation);
    Object.freeze(f.explanation.findings);
    Object.freeze(f.explanation);
    expect(summarize(f.explanation, f.context)).toBe(`${dispatch} ${blocked} ${outside}`);
    expect(JSON.stringify(f.explanation)).toBe(before);
    expect(summarize({ ...f.explanation, findings: [...f.explanation.findings].reverse() }, f.context)).toBe(
      `${dispatch} ${blocked} ${outside}`,
    );
  });
  it("promotes complete-window facts with reconstructed-path qualification", () => {
    const f = fixture(profile);
    f.press();
    f.whole("all-fresh-actions-outside");
    f.finding("overlap-without-fresh-action", {
      bases: ["recorded", "model-trace", "reconstructed-path"],
      eventIds: ["outside", "input"],
      parameters: { domainStartTimeMs: 900, domainEndTimeMs: 1100, freshActionCount: 0, intervalCount: 1 },
    });
    expect(summarize(f.explanation, f.context)).toBe(`${allOutside} ${overlap}`);
  });
  it("can report a supported empty action set without invented event references", () => {
    const f = fixture(profile);
    f.whole("no-fresh-action");
    // No positive action claim remains for this domain.
    f.explanation.findings = f.explanation.findings.filter((x) => x.code !== "all-fresh-actions-outside");
    expect(summarize(f.explanation, f.context)).toBe(noFresh);
  });
  it.each([
    "indeterminate",
    "not-supported",
    "inapplicable",
    "reason",
    "post-terminal",
    "missing-reference",
    "wrong-attempt",
    "wrong-target",
    "before-activation",
    "after-resolution",
    "after-window",
    "no-activation",
    "partial-lifecycle",
    "conflict",
  ] as const)("refuses %s routing promotion", (issue) => {
    const f = fixture(profile),
      r = f.route("order-blocked");
    if (issue === "indeterminate" || issue === "not-supported") r.state = issue;
    if (issue === "inapplicable") r.applicable = false;
    if (issue === "reason") r.reasons = ["unavailable-context"];
    if (issue === "post-terminal") r.parameters.postTerminal = 1;
    if (issue === "missing-reference") f.records.delete("attempt2");
    if (issue === "wrong-attempt") Object.assign(f.records.get("policy")!, { attemptId: "attempt" });
    if (issue === "wrong-target") Object.assign(f.records.get("policy")!, { componentId: "other" });
    if (issue === "before-activation") Object.assign(f.records.get("active")!, { timeMs: 1050, sequence: 9 });
    if (issue === "after-resolution") Object.assign(f.records.get("terminal")!, { timeMs: 1050, sequence: 5 });
    if (issue === "after-window")
      for (const id of ["input2", "attempt2", "policy"]) Object.assign(f.records.get(id)!, { timeMs: 1110 });
    if (issue === "no-activation") f.records.delete("active");
    if (issue === "partial-lifecycle") f.context.lifecycleComplete = false;
    if (issue === "conflict") f.explanation.limitations = ["dependency-conflict:lifecycle:target"];
    expect(summarize(f.explanation, f.context)).toBe(
      issue === "conflict" ? "No supported explanation is available for this circle." : expiry,
    );
  });
  it("keeps a valid same-millisecond route before resolution", () => {
    const f = fixture(profile);
    f.route("order-blocked");
    Object.assign(f.records.get("terminal")!, { timeMs: 1050, sequence: 10 });
    f.explanation.findings
      .filter((x) => x.parameters.domainEndTimeMs)
      .forEach((x) => {
        x.parameters.domainEndTimeMs = 1050;
      });
    expect(summarize(f.explanation, f.context)).toBe(blocked);
  });
  it.each([
    "indeterminate",
    "inapplicable",
    "post-terminal",
    "empty-domain",
    "missing-domain",
    "missing-reference",
  ] as const)("refuses %s complete-window promotion", (issue) => {
    const f = fixture(profile),
      w = f.whole("all-fresh-actions-outside");
    if (issue === "indeterminate") w.state = "indeterminate";
    if (issue === "inapplicable") w.applicable = false;
    if (issue === "post-terminal") w.parameters.postTerminal = 1;
    if (issue === "empty-domain") w.parameters.domainStartTimeMs = 1200;
    if (issue === "missing-domain") delete w.parameters.domainStartTimeMs;
    if (issue === "missing-reference") f.records.delete("outside");
    expect(summarize(f.explanation, f.context)).toBe(expiry);
  });
  it("does not suppress valid local facts for distant or unrelated run limitations", () => {
    const f = fixture(profile);
    f.whole("all-fresh-actions-outside");
    f.explanation.limitations = ["initial-actions-unknown", "inferred-or-synthetic-endpoint", "global-totals-mismatch"];
    expect(summarize(f.explanation, f.context)).toBe(allOutside);
  });
  it("falls back honestly if only single-press/path context is available", () => {
    const f = fixture(profile);
    f.press();
    f.explanation.mainFindingId = "press-outside";
    f.finding("entry-after-press", { eventIds: ["outside", "input"], parameters: { approximate: 1, deltaMs: 50 } });
    expect(summarize(f.explanation, f.context)).toBe(expiry);
  });
  it("does not hide contradictory whole-window and inside-routing evidence", () => {
    const f = fixture(profile);
    f.route();
    f.whole("all-fresh-actions-outside");
    expect(summarize(f.explanation, f.context)).toBe(conflict);
  });
  it("does not choose between opposing assessments of the same window", () => {
    const f = fixture(profile);
    const w = f.whole("all-fresh-actions-outside");
    f.finding("all-fresh-actions-outside", { ...w, id: "opposing", state: "not-supported" });
    expect(summarize(f.explanation, f.context)).toBe(conflict);
  });
  it("does not promote a reconstructed overlap whose witnesses are all after resolution", () => {
    const f = fixture(profile);
    for (const id of ["outside", "input"]) Object.assign(f.records.get(id)!, { timeMs: 1200, sequence: 20 });
    f.finding("overlap-without-fresh-action", {
      bases: ["reconstructed-path", "model-trace"],
      eventIds: ["outside", "input"],
      parameters: { domainStartTimeMs: 900, domainEndTimeMs: 1100, freshActionCount: 0, intervalCount: 1 },
    });
    expect(summarize(f.explanation, f.context)).toBe(expiry);
  });
  it("does not promote a whole-window action claim with no input witnesses", () => {
    const f = fixture(profile),
      w = f.whole("all-fresh-actions-outside");
    w.eventIds = ["active"];
    expect(summarize(f.explanation, f.context)).toBe(expiry);
  });
  it.each(["equal-time", "disconnected", "synthetic"] as const)(
    "does not promote %s reconstructed path witnesses",
    (issue) => {
      const f = fixture(profile);
      if (issue === "equal-time") Object.assign(f.records.get("outside")!, { timeMs: 1000 });
      if (issue === "disconnected")
        Object.assign(f.records.get("input")!, { source: { origin: "parsed", parsedFrameIndex: 9 } });
      if (issue === "synthetic")
        Object.assign(f.records.get("input")!, { source: { origin: "synthetic", reason: "inferred-ending" } });
      f.finding("overlap-without-fresh-action", {
        bases: ["reconstructed-path", "model-trace"],
        eventIds: ["outside", "input"],
        parameters: { domainStartTimeMs: 900, domainEndTimeMs: 1100, freshActionCount: 0, intervalCount: 1 },
      });
      expect(summarize(f.explanation, f.context)).toBe(expiry);
    },
  );
  it.each(["input-miss", "ordered-force-miss"] as const)(
    "preserves supported %s despite competing findings",
    (code) => {
      const f = fixture(profile);
      f.route();
      f.whole("all-fresh-actions-outside");
      const terminal = f.records.get("terminal")!;
      Object.assign(terminal, {
        mechanism: code,
        timeMs: 1000,
        ...(code === "input-miss" ? { triggerAttemptId: "attempt" } : { triggerResolutionId: "later" }),
      });
      f.records.set("later", {
        ...terminal,
        id: "later",
        sequence: 11,
        componentId: "other",
        mechanism: "successful-input",
        result: "GREAT",
      } as ReplayTraceRecord);
      f.explanation.findings[0] = {
        ...f.explanation.findings[0],
        code,
        eventIds: code === "input-miss" ? ["terminal", "attempt", "input"] : ["terminal", "later"],
      };
      expect(summarize(f.explanation, f.context)).toBe(
        code === "input-miss"
          ? "The model judged a Miss from an input."
          : "A later judgement forced this circle to Miss in the model.",
      );
    },
  );
});
