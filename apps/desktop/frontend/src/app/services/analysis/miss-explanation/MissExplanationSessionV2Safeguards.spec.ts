import {
  buildMissExplanationSession,
  buildMissExplanationSessionAsync,
  serializeMissExplanationSession,
  MISS_EXPLANATION_LIMITS,
} from "./MissExplanationSession";
import { errorFixture } from "../../../../../../../../libs/osu/core/test/ErrorAnalysisFixtures";
import { traceFrame } from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { ReplayTrace } from "../../../../../../../../libs/osu/core/src/gameplay/trace/ReplayTrace";
import * as explanations from "../../../../../../../../libs/osu/core/src/gameplay/miss-explanation/CircleMissExplanation";
import { deriveCircleEvidence } from "../../../../../../../../libs/osu/core/src/gameplay/miss-explanation/CircleEvidence";

const success = () => errorFixture("300,192,1000,1,0", [traceFrame(900), traceFrame(1000, 300, [0]), traceFrame(1300)]);
const miss = () => errorFixture("300,192,1000,1,0", [traceFrame(900, 500), traceFrame(1300, 500)]);
afterEach(() => jest.restoreAllMocks());

describe("all-error session resource and coverage safeguards", () => {
  it("keeps legacy aggregate conflict diagnostics advisory in both session entry points", async () => {
    const { trace, map } = errorFixture("300,192,1000,1,0", [traceFrame(0, 300), traceFrame(700, 300), traceFrame(1300, 300)]);
    const reasons = ["unlocalized-saved-outcome-conflict", "reconstruction-outcome-conflict", "saved-outcome-localization-unavailable"];
    const sync = buildMissExplanationSession(trace, map, reasons);
    const async = await buildMissExplanationSessionAsync(trace, map, reasons, async () => undefined);
    expect(sync.status).toBe("partial");
    expect(async.status).toBe("partial");
    if (sync.status !== "partial" || async.status !== "partial") throw Error("Aggregate veto survived");
    expect(sync.analysis?.classifications).toEqual(async.analysis?.classifications);
    expect(sync.analysis?.classifications[0].mechanism.status).toBe("supported");
    expect(sync.reasons).toEqual(expect.arrayContaining(reasons));
  });
  it("reports exhausted trace/analysis budgets as resource limits rather than generic generation failure", () => {
    const { trace, map } = miss();
    const tiny = { ...trace, limits: { ...trace.limits, maxExportBytes: 1 } };
    expect(buildMissExplanationSession(tiny, map)).toEqual({
      status: "error",
      reasons: ["analysis-resource-limit", "Trace export byte limit exceeded"],
    });
    const exact = {
      ...trace,
      limits: { ...trace.limits, maxExportBytes: Buffer.byteLength(JSON.stringify(trace)) + 100 },
    };
    const result = buildMissExplanationSession(exact, map);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected exhausted analysis budget");
    expect(result.reasons).toContain("analysis-resource-limit");
  });
  it("retains source-coverage limitations even when every played object succeeds", () => {
    const { trace, map } = success();
    const limited: ReplayTrace = {
      ...trace,
      domain: { ...trace.domain, sourceCoverageLimits: ["negative-delta-gap"] },
    };
    const state = buildMissExplanationSession(limited, map);
    expect(state.status).toBe("partial");
    if (state.status !== "partial") throw new Error("source gap was concealed");
    expect(state.reasons).toContain("negative-delta-gap");
  });

  it.each(["input", "routing", "lifecycle"] as const)(
    "does not publish ready with partial %s evidence and no errors",
    (channel) => {
      const { trace, map } = success();
      const limited: ReplayTrace = {
        ...trace,
        complete: false,
        coverage: { ...trace.coverage, [channel]: "partial" },
        records: trace.records.map((r) =>
          r.kind === "coverage" && r.channel === channel ? { ...r, status: "partial", reason: "incomplete-source" } : r,
        ),
      };
      const state = buildMissExplanationSession(limited, map);
      expect(state.status).toBe("partial");
      if (state.status !== "partial") throw new Error("partial evidence was concealed");
      expect(state.reasons).toContain(`${channel}-coverage-partial`);
    },
  );

  it("keeps selected-only geometry as a local evidence dependency", () => {
    const { trace, map } = success();
    expect(trace.coverage.geometry).toBe("partial");
    expect(buildMissExplanationSession(trace, map).status).toBe("ready");
  });

  it("checks the per-explanation finding cap before retaining developer diagnostics", () => {
    const { trace, map } = miss();
    const base = explanations.explainCircleMiss(deriveCircleEvidence(trace, map, "0"));
    jest.spyOn(explanations, "explainCircleMiss").mockReturnValue({
      ...base,
      findings: Array(MISS_EXPLANATION_LIMITS.maxFindingsPerExplanation + 1).fill(base.findings[0]),
    });
    const state = buildMissExplanationSession(trace, map);
    expect(state.status).toBe("partial");
    if (state.status !== "partial") throw new Error("expected bounded partial diagnostics");
    expect(state.reasons).toContain("explanation-finding-limit");
    expect(state.explanations.size).toBe(0);
  });

  it("does not publish a captured session whose actual export exceeds the byte limit", () => {
    const { trace, map } = miss();
    const unbounded = buildMissExplanationSession(trace, map);
    if (unbounded.status !== "ready" && unbounded.status !== "partial") throw new Error("fixture was not captured");
    const actualBytes = Buffer.byteLength(serializeMissExplanationSession(unbounded), "utf8");
    const limited = { ...trace, limits: { ...trace.limits, maxExportBytes: actualBytes - 1 } };
    const state = buildMissExplanationSession(limited, map);
    if (state.status === "ready" || state.status === "partial")
      expect(() => serializeMissExplanationSession(state)).not.toThrow();
    else expect(state.status).toBe("error");
  });

  it("enforces the cumulative finding cap across otherwise legal-sized diagnostic records", () => {
    const objects = Array.from({ length: 11 }, (_, i) => `300,192,${1000 + i * 500},1,0`).join("\n");
    const frames = [traceFrame(900, 500), ...Array.from({ length: 11 }, (_, i) => traceFrame(1300 + i * 500, 500))];
    const { trace, map } = errorFixture(objects, frames);
    const original = explanations.explainCircleMiss;
    jest.spyOn(explanations, "explainCircleMiss").mockImplementation((evidence) => {
      const base = original(evidence);
      return {
        ...base,
        mainFindingId: base.mainFindingId === undefined ? undefined : "bounded-0",
        findings: Array.from({ length: 10000 }, (_, i) => ({ ...base.findings[0], id: `bounded-${i}` })),
      };
    });
    const state = buildMissExplanationSession(trace, map);
    expect(state.status).toBe("partial");
    if (state.status !== "partial") throw new Error("expected bounded total finding count");
    expect(state.reasons).toContain("explanation-finding-limit");
    expect([...state.explanations.values()].reduce((sum, value) => sum + value.findings.length, 0)).toBe(100000);
  });

  it("keeps cooperative assembly cancellation outside its generation error handler", async () => {
    const { trace, map } = miss();
    let calls = 0;
    const cancellation = new Error("cancelled");
    await expect(
      buildMissExplanationSessionAsync(trace, map, [], async () => {
        if (++calls === 4) throw cancellation;
      }),
    ).rejects.toBe(cancellation);
  });
});
