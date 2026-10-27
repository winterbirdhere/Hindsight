import { inventoryErrors } from "../src/gameplay/error-analysis/ErrorInventory";
import { createReplayTraceCollector } from "../src/gameplay/trace/ReplayTraceCollector";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { traceMapText, traceFrame } from "./ReplayTraceFixtures";
import { OsuClassicMod } from "../src/mods/Mods";
import { LazerMod } from "../src/mods/LazerMods";
export function errorFixture(
  objects: string,
  frames: ReturnType<typeof traceFrame>[],
  profile: "stable" | "lazer" = "stable",
  mods: OsuClassicMod[] = [],
  lazerMods: LazerMod[] = [],
) {
  const map = buildBeatmap(parseBlueprint(traceMapText(objects)), { addStacking: false, mods, lazerMods });
  const capture = createReplayTraceCollector(
    {
      schemaVersion: 2,
      replayContentSha256: null,
      beatmapContentSha256: null,
      beatmapMd5: null,
      generationKey: "inventory-test",
      recordingClient: profile,
      analysisProfileId: profile,
      analysisProfileFingerprint: "profile",
      parserVersion: "test",
      inputPreparationVersion: "test",
    },
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
  const machine =
    profile === "stable"
      ? new BucketedGameStateTimeMachine(
          frames,
          map,
          { noteLockStyle: "STABLE", hitWindowStyle: "OSU_STABLE" },
          undefined,
          capture,
        )
      : new LazerGameStateTimeMachine(frames, map, undefined, {}, capture);
  const state = machine.gameStateAt(Infinity),
    trace = capture.seal();
  return { state, trace, map, inventory: inventoryErrors(trace, map) };
}
