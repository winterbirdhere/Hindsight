import { createReplayTraceCollector, serializeReplayTrace } from "../src/gameplay/trace/ReplayTraceCollector";
import { TraceRunIdentity, ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { traceBeatmap, traceFrame } from "./ReplayTraceFixtures";
import { HitCircle } from "../src/hitobjects/HitCircle";

const identity: TraceRunIdentity = {
  schemaVersion: 1,
  replayContentSha256: null,
  beatmapContentSha256: null,
  beatmapMd5: null,
  generationKey: "hardening",
  recordingClient: "synthetic",
  analysisProfileId: "stable",
  analysisProfileFingerprint: "fixture",
  parserVersion: "fixture",
  inputPreparationVersion: "fixture",
};
const domain = {
  endTimeMs: 1200,
  endpointBasis: "recorded-end" as const,
  synthesizedEndpoint: false,
  sourceCoverageLimits: [],
};
const cap = { maxRecords: 200000, maxExportBytes: 64 * 1024 * 1024 };
function record(c: ReturnType<typeof createReplayTraceCollector>) {
  c.record({
    id: c.reserveId(),
    kind: "coverage",
    phase: "coverage",
    timeMs: 1,
    channel: "input",
    status: "partial",
    reason: "test",
    startTimeMs: 0,
    endTimeMs: 1,
  });
}
describe("M1 hardening", () => {
  it("reserves the source envelope before admitting records",()=>{
    const large={...domain,frameSources:Array.from({length:500},(_,parsedFrameIndex)=>({origin:"parsed" as const,parsedFrameIndex}))};
    const c=createReplayTraceCollector(identity,large,{maxRecords:200000,maxExportBytes:40000});
    for(let i=0;i<500;i++)record(c);
    const trace=c.seal();
    expect(trace.failures).toContain("export-byte-limit");
    expect(Buffer.byteLength(serializeReplayTrace(trace))).toBeLessThanOrEqual(40000);
    expect(trace.domain.frameSources).toHaveLength(500);
  });
  it.each(["maxRecords", "maxExportBytes"] as const)("owns %s independently of caller mutation", (key) => {
    const limits = { ...cap, [key]: key === "maxRecords" ? 1 : 1 };
    const c = createReplayTraceCollector(identity, domain, limits);
    limits[key] = cap[key];
    record(c);
    record(c);
    const trace = c.seal();
    expect(trace.records.length).toBeLessThan(2);
    expect(trace.failures).toContain(key === "maxRecords" ? "record-limit" : "export-byte-limit");
  });
  it("rejects forged record caps and upgraded completeness at export", () => {
    const c = createReplayTraceCollector(identity, domain, cap);
    record(c);
    const trace = c.seal();
    expect(() => serializeReplayTrace({ ...trace, limits: { ...cap, maxRecords: 0 } })).toThrow();
    expect(() =>
      serializeReplayTrace({
        ...trace,
        complete: true,
        coverage: { input: "complete", geometry: "complete", routing: "complete", lifecycle: "complete" },
      }),
    ).toThrow();
  });
  it("does not declare synthetic mapped input complete when endpoint flag is false", () => {
    const c = createReplayTraceCollector(
      identity,
      { ...domain, frameSources: [{ origin: "synthetic", reason: "provided-synthetic" }] },
      cap,
    );
    new BucketedGameStateTimeMachine(
      [traceFrame(1200)],
      traceBeatmap("300,192,1000,1,0"),
      { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
      undefined,
      c,
    ).gameStateAt(Infinity);
    expect(c.seal().coverage.input).not.toBe("complete");
  });
  it.each(["stable", "lazer"])("%s records actual activation order at same-time input", (profile) => {
    const map = traceBeatmap("300,192,1000,1,0");
    const circle = map.hitObjects[0] as HitCircle,
      spawn = circle.hitTime - circle.approachDuration;
    const frames = [traceFrame(spawn), traceFrame(spawn, 300, [0]), traceFrame(1200)];
    const c = createReplayTraceCollector(
      { ...identity, analysisProfileId: profile },
      { ...domain, frameSources: frames.map((_, parsedFrameIndex) => ({ origin: "parsed", parsedFrameIndex })) },
      cap,
    );
    (profile === "stable"
      ? new BucketedGameStateTimeMachine(
          frames,
          map,
          { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
          undefined,
          c,
        )
      : new LazerGameStateTimeMachine(frames, map, undefined, {}, c)
    ).gameStateAt(Infinity);
    const trace = c.seal(),
      activation = trace.records.find((r) => (r as { kind: string }).kind === "lifecycle");
    expect(activation).toBeDefined();
    const inputs = trace.records.filter((r) => r.kind === "input");
    expect(activation!.sequence).toBeLessThan(inputs[1].sequence);
    expect(activation!.sequence < inputs[0].sequence).toBe(profile === "lazer");
    expect(trace.failures).toEqual([]);
    expect(() => serializeReplayTrace(trace as ReplayTrace)).not.toThrow();
  });
});
