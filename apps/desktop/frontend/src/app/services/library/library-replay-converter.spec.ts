import { parseReplayFramesWithDiagnostics } from "@osujs/core";
import type { LibraryReplayData } from "../../../../../shared/library-replay-data";
import { isLazerReplay, replayClockRate } from "../../model/OsuReplay";
import { replayFromLibrarySource } from "./library-replay-converter";

const input: LibraryReplayData = { gameMode: 0, gameVersion: 20260101, beatmapMD5: "a".repeat(32), playerName: "Fixture",
  replayMD5: "hash", replayContentSha256: "b".repeat(64), number_300s: 1, number_100s: 0, number_50s: 0,
  misses: 0, score: 300, max_combo: 1, perfect_combo: 1, mods: 64, life_bar: "100|1,", timestamp: 1700000000000,
  replay_data: "0|256|-500|0,-1|256|-500|0,1000|10|20|1,0|12|20|0," };
const native = { scoreId: "a0000000-0000-4000-8000-000000000001", schemaFingerprint: "c".repeat(64),
  isLegacyScore: false, mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }] };

it("uses already parsed frames and provenance without parsing again or losing the wire timestamp", () => {
  const data = JSON.parse(JSON.stringify(input)); const parsed = parseReplayFramesWithDiagnostics(data.replay_data);
  const replay = replayFromLibrarySource(data, parsed);
  expect(replay.frames).toBe(parsed.frames); expect(replay.parseDiagnostics).toBe(parsed.diagnostics);
  expect(replay.timestamp).toBe(1700000000000);
  expect(replay.frames.map(frame => frame.time)).toEqual([999, 999]);
});
it("uses native database evidence without inventing user confirmation or changing wrapper version", () => {
  const replay = replayFromLibrarySource({ ...input, nativeSource: native }, parseReplayFramesWithDiagnostics(input.replay_data));
  expect(replay).toMatchObject({ sourceClient: "lazer", sourceProvenance: "native-database", gameVersion: 20260101 });
  expect(isLazerReplay(replay)).toBe(true); expect(replayClockRate(replay)).toBe(1.2);
});
it("preserves authoritative embedded empty mods over legacy bits and database hints", () => {
  const replay = replayFromLibrarySource({ ...input, nativeSource: native, lazerMods: [], lazerScoreInfo: { mods: [], statistics: { great: 1 } } },
    parseReplayFramesWithDiagnostics(input.replay_data));
  expect(replay.lazerMods).toEqual([]); expect(replay.mods).toEqual([]); expect(replayClockRate(replay)).toBe(1);
  expect(replay.lazerScoreMetadata?.statistics).toEqual({ great: 1 });
});
it("does not infer Stable origin from a native legacy-score flag and retains exact-hash confirmed origin", () => {
  const parsed = parseReplayFramesWithDiagnostics(input.replay_data);
  const legacy = replayFromLibrarySource({ ...input, nativeSource: { ...native, isLegacyScore: true } }, parsed);
  expect(legacy.sourceClient).toBeUndefined(); expect(isLazerReplay(legacy)).toBe(false);
  const confirmed = replayFromLibrarySource({ ...input, sourceClient: "lazer", sourceProvenance: "user-confirmed",
    nativeSource: { ...native, isLegacyScore: true } }, parsed);
  expect(confirmed.sourceProvenance).toBe("user-confirmed"); expect(isLazerReplay(confirmed)).toBe(true);
});
it("refuses missing or malformed native mod settings when the replay contains no native metadata", () => {
  for (const mods of [null, [null], [{ acronym: "DT", settings: [] }]]) {
    expect(() => replayFromLibrarySource({ ...input, nativeSource: { ...native, mods } }, parseReplayFramesWithDiagnostics(input.replay_data)))
      .toThrow(/native mod/i);
  }
});
