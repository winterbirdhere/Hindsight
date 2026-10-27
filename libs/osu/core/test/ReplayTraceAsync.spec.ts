import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { createReplayTraceCollector, serializeReplayTrace } from "../src/gameplay/trace/ReplayTraceCollector";
import { traceFixtures, traceBeatmap, traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";

describe("cooperative canonical source capture", () => {
  for (const profile of ["stable", "lazer"] as const) {
    const setup = (fixture = traceFixtures[0]) => {
      const map = traceBeatmap(fixture.objects);
      const capture = createReplayTraceCollector(
        {
          schemaVersion: 1,
          replayContentSha256: null,
          beatmapContentSha256: null,
          beatmapMd5: null,
          generationKey: "async-fixture",
          recordingClient: profile,
          analysisProfileId: profile,
          analysisProfileFingerprint: "fixture",
          parserVersion: "fixture",
          inputPreparationVersion: "fixture",
        },
        {
          endTimeMs: fixture.frames[fixture.frames.length - 1].time,
          endpointBasis: "recorded-end",
          synthesizedEndpoint: false,
          sourceCoverageLimits: ["synthetic"],
        },
        { maxRecords: 200000, maxExportBytes: 67108864 },
      );
      const machine =
        profile === "stable"
          ? new BucketedGameStateTimeMachine(
              fixture.frames,
              map,
              { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
              undefined,
              capture,
            )
          : new LazerGameStateTimeMachine(fixture.frames, map, undefined, {}, capture);
      return { map, capture, machine };
    };
    it.each(traceFixtures)(
      `${profile} preserves full state, ordered events and exact trace for $name`,
      async (fixture) => {
        const sync = setup(fixture),
          async = setup(fixture);
        const expected = sync.machine.gameStateAt(Infinity);
        const checkpoint = jest.fn(async () => undefined);
        const actual = await async.machine.captureReplayAsync(checkpoint);
        expect(normalizeTraceState(actual)).toEqual(normalizeTraceState(expected));
        expect(retrieveEvents(actual, async.map.hitObjects, profile)).toEqual(
          retrieveEvents(expected, sync.map.hitObjects, profile),
        );
        expect(serializeReplayTrace(async.capture.seal())).toBe(serializeReplayTrace(sync.capture.seal()));
        expect(checkpoint).toHaveBeenCalled();
        expect(async.machine.gameStateAt(Infinity)).toBe(actual);
        await expect(async.machine.captureReplayAsync(checkpoint)).rejects.toThrow("fresh canonical");
      },
    );
    it(`${profile} stops on cancellation between bounded groups without sealing success`, async () => {
      const fixture = { ...traceFixtures[0], frames: Array.from({ length: 1200 }, (_, i) => traceFrame(i * 2)) };
      const { machine, capture } = setup(fixture);
      let calls = 0;
      await expect(
        machine.captureReplayAsync(async () => {
          if (++calls === 3) throw Error("cancelled");
        }),
      ).rejects.toThrow("cancelled");
      expect(calls).toBe(3);
      const trace = capture.seal();
      expect(trace.records.filter((r) => r.kind === "input").length).toBeLessThan(1200);
      expect(trace.complete).toBe(false);
      capture.dispose();
    });
    it(`${profile} never seals success when the final checkpoint is cancelled`, async () => {
      const fixture = { ...traceFixtures[0], frames: Array.from({ length: 1200 }, (_, i) => traceFrame(i * 2)) };
      const { machine, capture } = setup(fixture);
      let calls = 0;
      await expect(machine.captureReplayAsync(async () => { if (++calls === 6) throw Error("cancelled at end"); })).rejects.toThrow("cancelled at end");
      expect(calls).toBe(6); expect(capture.seal().complete).toBe(false); capture.dispose();
    });
  }
});
