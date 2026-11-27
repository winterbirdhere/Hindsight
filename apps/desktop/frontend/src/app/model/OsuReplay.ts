// TODO: Rename this to replay or something
import {
  FIRST_LAZER_REPLAY_VERSION,
  determineDefaultPlaybackSpeed,
  LazerMod,
  OsuClassicMod,
  ReplayFrame,
  ReplayParseDiagnostics,
  replayButtonEncodingForGameVersion,
  resolveLazerModSettings,
  SavedScoreSourceResult,
} from "@osujs/core";

export { FIRST_LAZER_REPLAY_VERSION };

export type OsuReplay = {
  md5hash: string;
  /** Present only when the loader supplies a digest of the actual loaded .osr bytes. */
  replayContentSha256?: string;
  /** Optional validated saved outcomes and loader diagnostics; never player causes by themselves. */
  savedScoreSource?: SavedScoreSourceResult;
  beatmapMd5: string;
  gameMode?: number;
  gameVersion: number;
  /** Recording date in UTC epoch milliseconds, used by Stable compatibility rules. */
  timestamp?: number;
  /** Saved recording origin; independent of the legacy file's version field. */
  sourceClient?: "stable" | "lazer";
  sourceProvenance?: "user-confirmed" | "native-database";
  mods: OsuClassicMod[];
  /** Native score-info mods; an empty list is authoritative over legacy bits. */
  lazerMods?: readonly LazerMod[];
  /** Native score statistics stored after the legacy replay stream. */
  lazerScoreMetadata?: LazerReplayScoreMetadata;
  player: string; // Could be useful to draw
  frames: ReplayFrame[];
  /** Captured once with frames; absent for legacy or caller-provided frame arrays. */
  parseDiagnostics?: ReplayParseDiagnostics;
  lifeBar?: ReplayLifeBarPoint[];
  /** Stable score-screen values used to validate offline simulation results. */
  statistics?: {
    count300: number;
    count100: number;
    count50: number;
    countMiss: number;
    maxCombo: number;
    score: number;
    perfectCombo: boolean;
  };
};

export interface LazerReplayScoreMetadata {
  statistics?: Readonly<Record<string, number>>;
  maximumStatistics?: Readonly<Record<string, number>>;
  rank?: string;
}

function nativeStatistics(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, count]) => !Number.isSafeInteger(count) || (count as number) < 0)) return undefined;
  return Object.fromEntries(entries) as Record<string, number>;
}

/** Reject invalid dictionaries together so malformed counts never become zeroes. */
export function parseLazerReplayScoreMetadata(value: unknown): LazerReplayScoreMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const score = value as Record<string, unknown>;
  const statistics = nativeStatistics(score.statistics);
  const maximumStatistics = nativeStatistics(score.maximum_statistics);
  const rank = typeof score.rank === "string" ? score.rank : undefined;
  if (!statistics && !maximumStatistics && rank === undefined) return undefined;
  return { statistics, maximumStatistics, rank };
}

export interface ReplayLifeBarPoint {
  time: number;
  health: number;
}

export function parseReplayLifeBar(value: string | undefined): ReplayLifeBarPoint[] {
  if (!value) return [];
  return value
    .split(",")
    .flatMap((entry): ReplayLifeBarPoint[] => {
      const [rawTime, rawHealth] = entry.split("|");
      const time = Number(rawTime);
      const health = Number(rawHealth);
      if (!Number.isFinite(time) || !Number.isFinite(health)) return [];
      return [{ time, health: Math.max(0, Math.min(1, health)) }];
    })
    .sort((left, right) => left.time - right.time);
}

type ReplaySourceIdentity = Pick<OsuReplay, "gameVersion"> &
  Partial<Pick<OsuReplay, "sourceClient" | "sourceProvenance" | "lazerMods" | "lazerScoreMetadata">>;

export function isLazerReplay(replay: ReplaySourceIdentity): boolean {
  // Embedded native format/metadata remains authoritative. A confirmed origin
  // also identifies old Lazer exports which contain only the legacy wrapper.
  return (
    replayButtonEncodingForGameVersion(replay.gameVersion) === "lazer-logical" ||
    replay.lazerMods !== undefined ||
    replay.lazerScoreMetadata !== undefined ||
    (replay.sourceClient === "lazer" && (replay.sourceProvenance === "user-confirmed" || replay.sourceProvenance === "native-database"))
  );
}

/** Confirmed Lazer exports retain logical actions, not physical mouse identity. */
export function replayButtonEncoding(replay: ReplaySourceIdentity) {
  return isLazerReplay(replay) ? "lazer-logical" : "stable-physical";
}

const NATIVE_LEGACY_MODS: Readonly<Record<string, readonly OsuClassicMod[]>> = {
  TD: ["TOUCH_DEVICE"],
  NF: ["NO_FAIL"],
  EZ: ["EASY"],
  HD: ["HIDDEN"],
  HR: ["HARD_ROCK"],
  SD: ["SUDDEN_DEATH"],
  PF: ["SUDDEN_DEATH", "PERFECT"],
  DT: ["DOUBLE_TIME"],
  NC: ["DOUBLE_TIME", "NIGHT_CORE"],
  HT: ["HALF_TIME"],
  DC: ["HALF_TIME"],
  FL: ["FLASH_LIGHT"],
  AT: ["AUTO_PLAY"],
  AP: ["AUTO_PILOT"],
  RX: ["RELAX"],
  SO: ["SPUN_OUT"],
  V2: ["SCORE_V2"],
  SV2: ["SCORE_V2"],
};

/** The native list replaces the legacy mask; unsupported acronyms stay in lazerMods. */
export function legacyModsFromLazerMods(lazerMods: readonly LazerMod[]): OsuClassicMod[] {
  return Array.from(new Set(lazerMods.flatMap((mod) => NATIVE_LEGACY_MODS[mod.acronym.toUpperCase()] ?? [])));
}

export function replayClockRate(replay: Pick<OsuReplay, "mods" | "lazerMods">): number {
  return replay.lazerMods === undefined
    ? determineDefaultPlaybackSpeed(replay.mods)
    : resolveLazerModSettings(replay.lazerMods).clockRate ?? 1;
}
