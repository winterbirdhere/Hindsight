import { modsFromBitmask, parseReplayFramesWithDiagnostics, ParsedReplayFrames } from "@osujs/core";
import type { OsrReplay } from "@rewind/osu-local/osr-reader";
import { legacyModsFromLazerMods, OsuReplay, parseLazerReplayScoreMetadata, parseReplayLifeBar } from "./OsuReplay";

export type DecodedReplaySource = Pick<
  OsrReplay,
  | "gameMode"
  | "gameVersion"
  | "replay_data"
  | "life_bar"
  | "mods"
  | "lazerMods"
  | "lazerScoreInfo"
  | "replayMD5"
  | "beatmapMD5"
  | "playerName"
  | "number_300s"
  | "number_100s"
  | "number_50s"
  | "misses"
  | "max_combo"
  | "score"
  | "perfect_combo"
> & { timestamp?: number } &
  Pick<OsuReplay, "sourceClient" | "sourceProvenance" | "replayContentSha256" | "savedScoreSource">;

/** Shared application/CLI mapping after the canonical byte decoder and provenance loader. */
export function replayFromDecodedSource(res: DecodedReplaySource): OsuReplay {
  return replayFromParsedSource(res, parseReplayFramesWithDiagnostics(res.replay_data));
}

/** Accept the canonical parser result from a foreground worker without repeating work on the UI thread. */
export function replayFromParsedSource(res: DecodedReplaySource, parsed: ParsedReplayFrames): OsuReplay {
  const confirmedSource =
    res.sourceProvenance === "user-confirmed" && (res.sourceClient === "stable" || res.sourceClient === "lazer")
      ? res.sourceClient
      : undefined;
  return {
    gameMode: res.gameMode,
    gameVersion: res.gameVersion,
    timestamp: Number.isFinite(Number(res.timestamp)) ? Number(res.timestamp) : undefined,
    sourceClient: confirmedSource,
    sourceProvenance: confirmedSource ? "user-confirmed" : undefined,
    savedScoreSource: res.savedScoreSource,
    replayContentSha256:
      typeof res.replayContentSha256 === "string" && /^[a-f0-9]{64}$/i.test(res.replayContentSha256)
        ? res.replayContentSha256.toLowerCase()
        : undefined,
    frames: parsed.frames,
    parseDiagnostics: parsed.diagnostics,
    lifeBar: parseReplayLifeBar(res.life_bar),
    mods: res.lazerMods === undefined ? modsFromBitmask(res.mods) : legacyModsFromLazerMods(res.lazerMods),
    lazerMods: res.lazerMods,
    lazerScoreMetadata: parseLazerReplayScoreMetadata(res.lazerScoreInfo),
    md5hash: res.replayMD5,
    beatmapMd5: res.beatmapMD5,
    player: res.playerName,
    statistics: {
      count300: res.number_300s,
      count100: res.number_100s,
      count50: res.number_50s,
      countMiss: res.misses,
      maxCombo: res.max_combo,
      score: res.score,
      perfectCombo: Boolean(res.perfect_combo),
    },
  };
}
