import { createHash } from "crypto";
import { osuStableAccuracy } from "@osujs/core";
import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";
import type { LibrarySavedScore } from "@rewind/osu-local/db-reader/library-scores";
import type { LibraryMapMetadata } from "@rewind/osu-local/db-reader/library-maps";
import type { LibraryMetricResult, LibraryMetricValue } from "../../../../shared/replay-library-metrics";
import { stableScoreGrade } from "../../../../shared/replay-grade";
import type { LazerMapMetadata, LazerSourceScore } from "./sources/lazer-source";

export const LIBRARY_SOURCE_PROJECTION_VERSION = "library-source-v1";
export interface QualifiedSourceProfile { client: "stable" | "lazer" | "unknown"; key: string }
export interface SourceMetricProjection extends LibraryMetricResult {
  slot: "source-score" | "source-map"; stage: "H"; inputKey: string; producerVersion: string;
}
const known = (value: string | number | boolean): LibraryMetricValue<string | number | boolean> => ({ state: "known", value });
const unknown = (reason: string): LibraryMetricValue<string | number | boolean> => ({ state: "unknown", reason });
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v);
const digest = (v: string, size: number) => new RegExp("^[a-f0-9]{" + size + "}$").test(v);

/** Caller passes only consuming inputs. Paths, scan/attempt IDs and timestamps are never implicit keys. */
export function metricInputKey(input: unknown): string {
  let nodes = 0;
  const canonical = (value: unknown, depth: number): unknown => {
    if (++nodes > 8192 || depth > 24) throw new Error("Metric input exceeds structural budget");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.length <= 32768) return value;
    if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
    if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key], depth + 1)]));
    }
    throw new Error("Invalid metric input");
  };
  const json = JSON.stringify(canonical(input, 0));
  if (Buffer.byteLength(json) > 64 * 1024) throw new Error("Metric input exceeds byte budget");
  return createHash("sha256").update("library-input-v1\n").update(json).digest("hex");
}
function projection(slot: SourceMetricProjection["slot"], input: unknown, fields: LibraryMetricResult["fields"],
  provenance: LibraryMetricResult["provenance"]): SourceMetricProjection {
  return { slot, stage: "H", producerVersion: LIBRARY_SOURCE_PROJECTION_VERSION,
    inputKey: metricInputKey({ projection: LIBRARY_SOURCE_PROJECTION_VERSION, slot, input }), fields,
    provenance: { ...provenance, projectionVersion: LIBRARY_SOURCE_PROJECTION_VERSION } };
}
function headerFields(header: LibrarySavedScore["header"], stable: boolean, usableHeader: boolean): LibraryMetricResult["fields"] {
  const basic = [header.counts.great, header.counts.ok, header.counts.meh, header.counts.miss] as const;
  const observed = usableHeader && header.mode === 0 && basic.every(count);
  const supported = stable && observed;
  const accuracy = supported ? osuStableAccuracy([...basic]) : undefined;
  const grade = supported ? stableScoreGrade(basic) : null;
  return { accuracy: accuracy !== undefined && finite(accuracy) ? known(accuracy) : unknown("saved-accuracy-unavailable"),
    maxCombo: observed && count(header.maxCombo) ? known(header.maxCombo) : unknown("saved-combo-unavailable"),
    misses: observed ? known(header.counts.miss) : unknown("saved-misses-unavailable"),
    grade: grade ? known(grade) : unknown("saved-grade-unavailable"),
    completion: unknown("completion-not-established"), sourcePp: unknown("source-pp-unavailable") };
}
export function projectStableHeader(input: { header: ReplayHeader; replaySha256: string; profile: QualifiedSourceProfile }): SourceMetricProjection {
  if (!digest(input.replaySha256, 64)) throw new Error("Invalid metric replay digest");
  const { header, profile } = input;
  const usableHeader = header.sourceFormat === "stable" && !header.nativeScoreInfo && header.version < 30_000_000;
  return projection("source-score", { replaySha256: input.replaySha256, profile }, headerFields(header, profile.client === "stable", usableHeader),
    { replaySha256: input.replaySha256, profileId: profile.key, scoreOrigin: profile.client, sourceOnly: false });
}
export function projectStableScore(input: { score: LibrarySavedScore; profile: QualifiedSourceProfile; replaySha256?: string }): SourceMetricProjection {
  const { score, profile, replaySha256 } = input;
  if (!digest(score.sourceKey, 64) || (replaySha256 !== undefined && !digest(replaySha256, 64))) throw new Error("Invalid metric source digest");
  return projection("source-score", { recordHash: score.sourceKey, databaseVersion: score.databaseVersion, profile, replaySha256: replaySha256 ?? null },
    headerFields(score.header, profile.client === "stable", score.header.version < 30_000_000),
    { sourceEvidenceHash: score.sourceKey, parserVersion: "stable-scores-v1", profileId: profile.key, sourceOnly: replaySha256 === undefined,
      ...(replaySha256 ? { replaySha256 } : {}) });
}
function nativeMisses(stats: LazerSourceScore["statistics"]): LibraryMetricValue<string | number | boolean> {
  // Accept explicit enum-name or EnumMember spelling, never infer omitted counts as zero.
  const values = stats ? [stats.Miss, stats.miss].filter(value => value !== undefined) : [];
  return values.length && values.every(value => count(value) && value === values[0]) ? known(values[0]) : unknown("saved-misses-unavailable");
}
export function projectNativeScore(input: { score: LazerSourceScore; schemaFingerprint: string; replaySha256?: string }): SourceMetricProjection {
  const { score, schemaFingerprint, replaySha256 } = input;
  if (!digest(schemaFingerprint, 64) || (replaySha256 !== undefined && !digest(replaySha256, 64))) throw new Error("Invalid metric source digest");
  const supported = score.ruleset === 0;
  // Pinned osu.Game ScoreRank: F=-1,D=0,C=1,B=2,A=3,S=4,SH=5,X=6,XH=7.
  // F alone is not player-completion evidence; preserve it as unavailable pending qualification.
  const grades = ["D", "C", "B", "A", "S", "S", "SS", "SS"];
  const grade = supported && Number.isInteger(score.rank) ? grades[score.rank] : undefined;
  const fields = { accuracy: supported && finite(score.accuracy) && score.accuracy <= 1 ? known(score.accuracy) : unknown("saved-accuracy-unavailable"),
    maxCombo: supported && count(score.maxCombo) ? known(score.maxCombo) : unknown("saved-combo-unavailable"),
    misses: supported ? nativeMisses(score.statistics) : unknown("unsupported-ruleset"),
    grade: grade ? known(grade) : unknown("saved-grade-unavailable"), completion: unknown("completion-not-established"),
    sourcePp: supported && finite(score.pp) ? known(score.pp) : unknown("source-pp-unavailable") };
  return projection("source-score", { schemaFingerprint, replaySha256: replaySha256 ?? null,
    ruleset: score.ruleset, clientVersion: score.clientVersion, isLegacyScore: score.isLegacyScore, mods: score.mods,
    accuracy: score.accuracy, maxCombo: score.maxCombo, rank: score.rank, pp: score.pp,
    statistics: score.statistics, maximumStatistics: score.maximumStatistics }, fields,
    { schemaHash: schemaFingerprint, parserVersion: "native-source-v1", sourceOnly: replaySha256 === undefined,
      ...(replaySha256 ? { replaySha256 } : {}) });
}
type StableMapInput = { map: Pick<LibraryMapMetadata, "md5" | "databaseVersion" | "rankedStatus" | "drainTimeSeconds" | "mode">;
  cachedNoModStars: number | null; cachedTempo: { min: number; max: number } | null };
export function projectStableMap(input: StableMapInput): SourceMetricProjection {
  const { map, cachedNoModStars, cachedTempo } = input;
  if (!digest(map.md5, 32)) throw new Error("Invalid metric map digest");
  const status: Record<number, string> = { 4: "ranked", 5: "approved", 6: "qualified", 7: "loved" };
  const bpm = cachedTempo && finite(cachedTempo.min) && cachedTempo.min > 0 && cachedTempo.min === cachedTempo.max;
  const fields = { sourceMapStars: map.mode === 0 && finite(cachedNoModStars) ? known(cachedNoModStars) : unknown("source-stars-unavailable"),
    cachedBpm: bpm && cachedTempo ? known(cachedTempo.min) : unknown(cachedTempo ? "variable-cached-tempo" : "source-tempo-unavailable"),
    drainLengthMs: finite(map.drainTimeSeconds) && Number.isFinite(map.drainTimeSeconds * 1000) ? known(map.drainTimeSeconds * 1000) : unknown("source-drain-unavailable"),
    mapStatus: status[map.rankedStatus] ? known(status[map.rankedStatus]) : unknown("ambiguous-source-status") };
  return projection("source-map", { md5: map.md5, databaseVersion: map.databaseVersion, mode: map.mode, fields }, fields,
    { mapMd5: map.md5, parserVersion: "stable-maps-v1", sourceOnly: true });
}
export function projectNativeMap(input: { md5: string; schemaFingerprint: string; map: LazerMapMetadata; ruleset: number | null }): SourceMetricProjection {
  const { md5, schemaFingerprint, map, ruleset } = input;
  if (!digest(md5, 32) || !digest(schemaFingerprint, 64)) throw new Error("Invalid metric map digest");
  const statuses: Record<number, string> = { [-2]: "graveyard", [-1]: "wip", 0: "pending", 1: "ranked", 2: "approved", 3: "qualified", 4: "loved" };
  const fields = { sourceMapStars: ruleset === 0 && finite(map.cachedNoModStars) ? known(map.cachedNoModStars) : unknown("source-stars-unavailable"),
    cachedBpm: finite(map.cachedBpm) && map.cachedBpm > 0 ? known(map.cachedBpm) : unknown("source-tempo-unavailable"),
    // Native Length is a source cache, not a verified drain-duration calculation.
    drainLengthMs: unknown("source-drain-unavailable"), mapStatus: statuses[map.status] ? known(statuses[map.status]) : unknown("ambiguous-source-status") };
  return projection("source-map", { md5, schemaFingerprint, ruleset, fields }, fields,
    { mapMd5: md5, schemaHash: schemaFingerprint, parserVersion: "native-maps-v1", sourceOnly: true });
}
