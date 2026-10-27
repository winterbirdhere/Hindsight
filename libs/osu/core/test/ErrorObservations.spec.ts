import { createReplayTraceCollector } from "../src/gameplay/trace/ReplayTraceCollector";
import { TraceRunIdentity } from "../src/gameplay/trace/ReplayTrace";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { traceBeatmap, traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";

const identity: TraceRunIdentity = {
  schemaVersion: 2,
  replayContentSha256: null,
  beatmapContentSha256: null,
  beatmapMd5: null,
  generationKey: "mechanisms",
  recordingClient: "stable",
  analysisProfileId: "stable",
  analysisProfileFingerprint: "test",
  parserVersion: "test",
  inputPreparationVersion: "test",
};
export function captureMechanism(
  objects: string,
  frames: ReturnType<typeof traceFrame>[],
  profile: "stable" | "lazer",
  mods: string[] = [],
) {
  const map = traceBeatmap(objects);
  map.appliedMods.push(...(mods as typeof map.appliedMods));
  const collector = createReplayTraceCollector(
    { ...identity, analysisProfileId: profile },
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
  const machine = (capture = false) =>
    profile === "stable"
      ? new BucketedGameStateTimeMachine(
          frames,
          map,
          { noteLockStyle: "STABLE", hitWindowStyle: "OSU_STABLE" },
          undefined,
          capture ? collector : undefined,
        )
      : new LazerGameStateTimeMachine(frames, map, undefined, {}, capture ? collector : undefined);
  const off = machine().gameStateAt(Infinity),
    on = machine(true).gameStateAt(Infinity);
  expect(normalizeTraceState(on)).toEqual(normalizeTraceState(off));
  return { map, state: on, trace: collector.seal() };
}
describe("rule-owned error observations", () => {
  it.each(["stable", "lazer"] as const)(
    "%s records independent geometry and hold gates, including every processed loss",
    (profile) => {
      const { trace, state } = captureMechanism(
        "100,192,1000,2,0,L|300:192,1,200",
        [
          traceFrame(900, 100),
          traceFrame(1000, 100, [0]),
          traceFrame(1500, 500),
          traceFrame(1970, 500),
          traceFrame(2100, 500),
        ],
        profile,
      );
      const records = trace.records as unknown as Array<Record<string, any>>;
      const losses = records.filter((r) => r.kind === "slider-checkpoint" && !r.hit);
      expect(losses.length).toBeGreaterThan(0);
      expect(losses.every((r) => !r.tracking.geometryAccepted && !r.tracking.holdAccepted)).toBe(true);
      expect(losses.every((r) => r.tracking.position.x === 500 && r.deadlineMs <= r.timeMs + 36)).toBe(true);
      expect(records.filter((r) => r.kind === "slider-checkpoint" && r.component !== "slider-end").length).toBe(
        Object.keys(state.checkPointVerdict).length,
      );
      expect(records.filter((r) => r.kind === "slider-parent")).toHaveLength(1);
      expect(trace.failures).toEqual([]);
    },
  );
  it.each(["stable", "lazer"] as const)(
    "%s records compact credited spinner evidence rather than guessing from revolutions",
    (profile) => {
      const { trace } = captureMechanism(
        "256,192,1000,8,0,3000",
        [traceFrame(900), traceFrame(1000), traceFrame(2000), traceFrame(3100)],
        profile,
      );
      expect(trace.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "spinner-resolution",
            result: "MISS",
            summary: expect.objectContaining({ heldSamples: 0, creditedProgress: 0 }),
          }),
        ]),
      );
      expect(trace.failures).toEqual([]);
    },
  );
  it("admits supported visibility mods without changing scoring", () => {
    const { trace } = captureMechanism("300,192,1000,1,0", [traceFrame(900), traceFrame(1200)], "stable", ["HIDDEN"]);
    expect(trace.failures).toEqual([]);
    expect(trace.records.some((r) => r.kind === "resolution")).toBe(true);
  });
});
