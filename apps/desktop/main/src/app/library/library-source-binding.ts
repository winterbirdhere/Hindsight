import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";
import type { LibrarySavedScore } from "@rewind/osu-local/db-reader/library-scores";
import type { LibrarySourceRegistration } from "../../../../shared/replay-library";
import { LIBRARY_SOURCE_PROJECTION_VERSION, metricInputKey, projectNativeMap, projectNativeScore, projectStableHeader, projectStableMap, projectStableScore, SourceMetricProjection } from "./library-source-metrics";
import type { LazerMapMetadata, LazerSourceScore } from "./sources/lazer-source";

export type LibraryConfirmedOrigin = { client: "stable" | "lazer"; provenance: "user-confirmed" };
type OriginEvidence = LibraryConfirmedOrigin | { client: "unknown"; provenance: "unavailable" };
export type LibrarySourceOriginLookup = (sha256: string) => OriginEvidence | undefined;
interface SourceEvidence {
  kind: LibrarySourceRegistration["kind"]; sourceKey: string; sha256: string | null; metadata: Record<string, unknown>;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const md5 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const optionalNonnegative = (value: unknown) => value === null || finite(value) && value >= 0;
function header(value: unknown): value is LibrarySavedScore["header"] {
  return record(value) && Number.isInteger(value.mode) && Number.isInteger(value.version) && record(value.counts) &&
    ["great", "ok", "meh", "miss", "geki", "katu"].every(key => finite((value.counts as Record<string, unknown>)[key])) &&
    finite(value.maxCombo);
}
function native(value: unknown): value is LazerSourceScore {
  return record(value) && typeof value.id === "string" && (value.ruleset === null || Number.isInteger(value.ruleset)) &&
    (value.clientVersion === null || typeof value.clientVersion === "string") && typeof value.isLegacyScore === "boolean" &&
    [value.accuracy, value.maxCombo, value.rank].every(finite) && (value.pp === null || finite(value.pp)) &&
    (value.mods === null || Array.isArray(value.mods)) && record(value.replay) &&
    [value.statistics, value.maximumStatistics].every(stats => stats === null || record(stats) && Object.values(stats).every(finite));
}

/** Map qualification deliberately does not require score statistics, mods or origin confirmation. */
export function sourceMapEvidence({ metadata, sha256, kind, sourceKey }: SourceEvidence): {
  headerMd5?: string; sourceMd5?: string; nativeProjection?: SourceMetricProjection;
} {
  const result: ReturnType<typeof sourceMapEvidence> = {};
  if (sha256 && record(metadata.header) && md5(metadata.header.beatmapMD5)) result.headerMd5 = metadata.header.beatmapMD5;
  const saved = metadata.savedScore, score = metadata.nativeScore;
  if (kind === "stable" && record(saved) && saved.sourceKey === sourceKey && hash(sourceKey) && Number.isInteger(saved.databaseVersion) &&
      record(saved.header) && md5(saved.header.beatmapMD5)) result.sourceMd5 = saved.header.beatmapMD5;
  if (kind !== "lazer" || !record(score) || score.id !== sourceKey || !hash(metadata.schemaFingerprint) ||
      !(score.ruleset === null || Number.isInteger(score.ruleset)) || !record(score.replay) ||
      sha256 && score.replay.sha256 !== sha256 || !record(score.beatmap) || !md5(score.beatmap.md5)) return result;
  result.sourceMd5 = score.beatmap.md5;
  const map = score.mapMetadata;
  if (!record(map) || !Number.isSafeInteger(map.status) ||
      ![map.cachedBpm, map.cachedNoModStars].every(optionalNonnegative)) return result;
  const projection = projectNativeMap({ md5: score.beatmap.md5, schemaFingerprint: metadata.schemaFingerprint,
    ruleset: score.ruleset as number | null, map: map as unknown as LazerMapMetadata });
  result.nativeProjection = { ...projection, provenance: { ...projection.provenance, sourceKind: "lazer" } };
  return result;
}

export function projectStableMapEvidence(expectedMd5: string, metadata: Record<string, unknown>): SourceMetricProjection | undefined {
  const map = metadata.map, tempo = metadata.cachedTempo;
  if (!record(map) || map.md5 !== expectedMd5 || !md5(map.md5) || !Number.isInteger(map.databaseVersion) ||
      !Number.isInteger(map.mode) || !Number.isInteger(map.rankedStatus) || !finite(map.drainTimeSeconds) ||
      !optionalNonnegative(metadata.cachedNoModStars) || !(tempo === null || record(tempo) && finite(tempo.min) && finite(tempo.max) && tempo.min >= 0 && tempo.max >= tempo.min)) return undefined;
  const projection = projectStableMap(metadata as unknown as Parameters<typeof projectStableMap>[0]);
  return { ...projection, provenance: { ...projection.provenance, sourceKind: "stable" } };
}

/** Select only evidence actually bound by the source adapter; partial envelopes are not typed headers.
 * Failure here means unavailable source metadata, not a reason to discard a valid replay identity. */
export function projectSourceEvidence(evidence: SourceEvidence, origin?: OriginEvidence): SourceMetricProjection | undefined {
  const { metadata, sha256, kind, sourceKey } = evidence;
  const profile = { client: origin?.client ?? "stable", key: origin?.provenance === "unavailable" ? "origin-unavailable-v1"
    : origin ? "confirmed-" + origin.client + "-v1" : "legacy-wrapper-v1" } as const;
  let result: SourceMetricProjection | undefined;
  const score = metadata.nativeScore, saved = metadata.savedScore, replay = metadata.header;
  const boundNative = kind === "lazer" && native(score) && score.id === sourceKey && hash(metadata.schemaFingerprint) &&
    (!sha256 || score.replay.sha256 === sha256);
  try {
    if (boundNative) {
      try { result = projectNativeScore({ score, schemaFingerprint: metadata.schemaFingerprint as string, ...(sha256 ? { replaySha256: sha256 } : {}) }); }
      catch { /* A bounded projection can still fall back to the same verified header below. */ }
    } else if (kind === "stable" && record(saved) && saved.sourceKey === sourceKey && hash(saved.sourceKey) &&
        Number.isInteger(saved.databaseVersion) && header(saved.header)) {
      result = projectStableScore({ score: saved as unknown as LibrarySavedScore, profile, ...(sha256 ? { replaySha256: sha256 } : {}) });
    }
    if (!result && sha256 && header(replay) && ["stable", "lazer"].includes(String((replay as ReplayHeader).sourceFormat)) &&
        typeof (replay as ReplayHeader).nativeScoreInfo === "boolean") {
      // Nonlegacy native database provenance can qualify a legacy wrapper even when its full score
      // envelope is unavailable. It never turns native wrapper placeholders into saved observations.
      const nativeOrigin = boundNative && !score.isLegacyScore;
      result = projectStableHeader({ header: replay as ReplayHeader, replaySha256: sha256,
        profile: nativeOrigin && !origin ? { client: "lazer", key: "native-database-v1" } : profile });
    }
    if (!result && boundNative) {
      result = { slot: "source-score", stage: "H", producerVersion: LIBRARY_SOURCE_PROJECTION_VERSION,
        inputKey: metricInputKey({ unavailable: "source-metadata-resource-limit", sha256, sourceKey, schema: metadata.schemaFingerprint }),
        fields: Object.fromEntries(["accuracy", "maxCombo", "misses", "grade", "completion", "sourcePp"]
          .map(field => [field, { state: "unknown" as const, reason: "source-metadata-resource-limit" }])),
        provenance: { sourceOnly: !sha256, ...(sha256 ? { replaySha256: sha256 } : {}), schemaHash: metadata.schemaFingerprint as string } };
    }
  } catch { return undefined; } // Structural budgets/unsupported metadata only; persistence errors escape the caller.
  return result && { ...result, provenance: { ...result.provenance, sourceKind: kind } };
}
