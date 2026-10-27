import * as collector from "../src/gameplay/trace/ReplayTraceCollector";
import { ReplayTrace, TraceCapture, TraceRunIdentity } from "../src/gameplay/trace/ReplayTrace";

const identity: TraceRunIdentity = {
  schemaVersion: 1,
  replayContentSha256: null,
  beatmapContentSha256: null,
  beatmapMd5: null,
  generationKey: "cooperative-\uD83D\uDE00",
  recordingClient: "synthetic",
  analysisProfileId: "stable",
  analysisProfileFingerprint: "fixture",
  parserVersion: "fixture",
  inputPreparationVersion: "fixture",
};
function capture(count = 800, maxExportBytes = 64000000) {
  const result = collector.createReplayTraceCollector(
    identity,
    {
      endTimeMs: count,
      endpointBasis: "recorded-end",
      synthesizedEndpoint: false,
      sourceCoverageLimits: [],
    },
    { maxRecords: 200000, maxExportBytes },
  );
  for (let i = 0; i < count; i++)
    result.record({
      id: result.reserveId(),
      kind: "coverage",
      phase: "coverage",
      timeMs: i,
      channel: "input",
      status: "partial",
      reason: 'quoted"\\\uD800\uD83D\uDE00',
      startTimeMs: i,
      endTimeMs: i,
    });
  return result;
}
function prepare(trace: ReplayTrace) {
  return collector.prepareReplayTrace(trace);
}
function drain(trace: ReplayTrace) {
  const steps = prepare(trace);
  let next = steps.next(),
    checkpoints = 0;
  while (!next.done) {
    checkpoints++;
    next = steps.next();
  }
  return { ...next.value, checkpoints };
}
function sealAsync(c: TraceCapture, checkpoint: () => Promise<void>) {
  return c.sealAsync(checkpoint);
}
describe("cooperative trace validation and sealing", () => {
  it("offers cancellation points within a long trace before returning an owned validated value", () => {
    const trace = capture().seal(),
      result = drain(trace);
    expect(result.checkpoints).toBeGreaterThan(3);
    expect(result.trace).toBe(trace);
    expect(result.byteLength).toBe(Buffer.byteLength(collector.serializeReplayTrace(trace)));
  });
  it("clones and deep-freezes unowned shallow-frozen input", () => {
    const foreign = JSON.parse(JSON.stringify(capture(2).seal())) as ReplayTrace;
    Object.freeze(foreign);
    const prepared = drain(foreign);
    (foreign.records[0] as { timeMs: number }).timeMs = 999;
    expect(prepared.trace.records[0].timeMs).toBe(0);
    expect(Object.isFrozen(prepared.trace.records[0])).toBe(true);
  });
  it("owns foreign records before yielding so later caller mutation cannot evade validation", () => {
    const foreign = JSON.parse(JSON.stringify(capture().seal())) as ReplayTrace;
    const steps = prepare(foreign);
    expect(steps.next().done).toBe(false);
    (foreign.records[0] as { timeMs: number }).timeMs = Infinity;
    let next = steps.next();
    while (!next.done) next = steps.next();
    expect(next.value.trace.records[0].timeMs).toBe(0);
    expect(() => collector.serializeReplayTrace(next.value.trace)).not.toThrow();
  });
  it("retains nonfinite rejection for foreign enumerable array metadata", () => {
    const foreign = JSON.parse(JSON.stringify(capture(2).seal())) as ReplayTrace;
    Object.assign(foreign.records, { extra: Infinity });
    expect(() => collector.serializeReplayTrace(foreign)).toThrow();
    expect(() => drain(foreign)).toThrow();
  });
  it.each(["record-cap", "duplicate-id", "nonfinite", "bad-coverage", "bad-sequence", "broken-reference"])(
    "retains export rejection for %s",
    (fault) => {
      const trace = JSON.parse(JSON.stringify(capture(2).seal()));
      if (fault === "record-cap") trace.limits.maxRecords = 1;
      if (fault === "duplicate-id") trace.records[1].id = trace.records[0].id;
      if (fault === "nonfinite") trace.records[1].extra = Infinity;
      if (fault === "bad-coverage") trace.coverage.input = "complete";
      if (fault === "bad-sequence") trace.records[1].sequence = 99;
      if (fault === "broken-reference")
        trace.records[1] = {
          id: "r1",
          kind: "attempt",
          phase: "attempt",
          timeMs: 1,
          sequence: 1,
          inputId: "missing",
          attemptOrdinal: 0,
          actionCandidates: [0],
        };
      expect(() => collector.serializeReplayTrace(trace)).toThrow();
      expect(() => drain(trace)).toThrow();
    },
  );
  it("cancels during seal and permits safe disposal without a completed trace", async () => {
    const c = capture(),
      cancellation = new Error("cancelled");
    let points = 0;
    await expect(
      sealAsync(c, async () => {
        if (++points === 2) throw cancellation;
      }),
    ).rejects.toBe(cancellation);
    c.dispose();
    expect(c.seal().failures).toContain("disposed");
  });
  it("seals asynchronously with identical bytes and immutable output", async () => {
    const c = capture();
    let points = 0;
    const trace = await sealAsync(c, async () => {
      points++;
    });
    expect(points).toBeGreaterThan(3);
    expect(collector.serializeReplayTrace(trace)).toBe(collector.serializeReplayTrace(capture().seal()));
    expect(c.seal()).toBe(trace);
    expect(Object.isFrozen(trace.records)).toBe(true);
  });
  it.each(["dispose", "fail"] as const)("honors %s at the final asynchronous checkpoint", async (change) => {
    const c = capture(2);
    let points = 0;
    const trace = await sealAsync(c, async () => {
      if (++points === 2) {
        if (change === "dispose") c.dispose();
        else c.fail("late-failure");
      }
    });
    expect(trace.failures).toContain(change === "dispose" ? "disposed" : "late-failure");
    expect(trace.records).toHaveLength(change === "dispose" ? 0 : 2);
    expect(drain(trace).byteLength).toBe(Buffer.byteLength(collector.serializeReplayTrace(trace)));
  });
  it.each([-1, 0, 1])("keeps exact UTF8 cap boundary %s including envelope and Unicode", (offset) => {
    // Fix the decimal width of the limit before deriving the independent JSON byte boundary.
    let c = capture(2, 999),
      trace = c.seal();
    const size = Buffer.byteLength(JSON.stringify(trace));
    c = capture(2, size + offset);
    trace = c.seal();
    expect(trace.failures.includes("export-byte-limit")).toBe(offset < 0);
    if (offset >= 0) {
      expect(trace.records).toHaveLength(2);
      expect(drain(trace).byteLength).toBe(Buffer.byteLength(JSON.stringify(trace)));
    }
  });
  it("fits a deterministic retained prefix when late failure metadata uses an exact successful cap", () => {
    const size = Buffer.byteLength(JSON.stringify(capture(2, 999).seal()));
    const c = capture(2, size);
    c.fail("late-failure-" + "x".repeat(128));
    const trace = c.seal();
    expect(trace.failures).toContain("export-byte-limit");
    expect(trace.failures).toContain("late-failure-" + "x".repeat(128));
    expect(trace.records.length).toBeLessThan(2);
    expect(trace.records.map(r => r.id)).toEqual(["r0"].slice(0, trace.records.length));
    expect(trace.droppedRecordBoundary).toBe(trace.records.length);
    expect(Buffer.byteLength(collector.serializeReplayTrace(trace))).toBeLessThanOrEqual(size);
  });
  it("keeps a synchronous seal performed during cooperative suffix trimming", async () => {
    let normalPoints = 0;
    const normal = await capture(800, 999999).sealAsync(async () => { normalPoints++; });
    const c = capture(800, Buffer.byteLength(JSON.stringify(normal)));
    c.fail("late-failure-" + "x".repeat(70000));
    let points = 0, nested: ReplayTrace | undefined;
    const trace = await c.sealAsync(async () => {
      if (++points === normalPoints + 1) nested = c.seal();
    });
    expect(nested).toBeDefined();
    expect(trace).toBe(nested);
    expect(c.seal()).toBe(trace);
    expect(Buffer.byteLength(collector.serializeReplayTrace(trace))).toBeLessThanOrEqual(trace.limits.maxExportBytes);
  });
  it("clears unsupported coverage when records are disposed at the final checkpoint", async () => {
    const c = capture(2);
    c.record({
      id: c.reserveId(),
      kind: "coverage",
      phase: "coverage",
      timeMs: 1,
      channel: "input",
      status: "unsupported",
      reason: "unsupported-input",
      startTimeMs: 0,
      endTimeMs: 1,
    });
    let points = 0;
    const trace = await c.sealAsync(async () => {
      if (++points === 2) c.dispose();
    });
    expect(trace.records).toHaveLength(0);
    expect(trace.coverage.input).toBe("partial");
    expect(drain(trace).byteLength).toBe(Buffer.byteLength(collector.serializeReplayTrace(trace)));
  });
});
