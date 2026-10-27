import { createHash } from "crypto";
import type { LazerMod } from "@osujs/core";
import type { PerformanceStatistics, CumulativePerformanceState } from "@rewind/osu-performance/types";
import { PERFORMANCE_ENGINE_VERSION, PerformanceRequest } from "@rewind/osu-performance/protocol";
import { normalizePerformanceMods } from "@rewind/osu-performance/mods";
export { readAggregatePerformanceResult } from "@rewind/osu-performance/aggregate-result";
import { metricInputKey } from "./library-source-metrics";

export const LIBRARY_AGGREGATE_PROJECTION_VERSION = "library-aggregate-v2";
type QualifiedAggregateScore = { mode: "stable"; basic: readonly [number, number, number, number]; legacyScoreV1?: number;
  maxCombo: number; evidenceKey: string } | { mode: "lazer" | "lazer-classic"; statistics: Partial<PerformanceStatistics>;
  /** The caller qualified every component; raw Realm dictionaries cannot set this by default. */
  componentsQualified: boolean; maxCombo: number; evidenceKey: string };
export interface AggregatePerformanceInput {
  map: { text: string; sha256: string; ruleset: number; objectCount: number; aggregateTimeMs: number };
  score: QualifiedAggregateScore; mods: readonly LazerMod[] | null; profileKey: string;
}
type Unknown = { state: "unknown"; reason: string };
const unknown = (reason: string): Unknown => ({ state: "unknown", reason });
const int32 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2147483647;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const statisticKeys: (keyof PerformanceStatistics)[] = ["great", "ok", "meh", "miss", "large_tick_hit", "large_tick_miss",
  "small_tick_hit", "small_tick_miss", "slider_tail_hit", "slider_tail_miss"];

/** P-only input construction. Aggregate placement is not replay endpoint, pass or Peak PP evidence. */
export function buildAggregatePerformanceRequest(input: AggregatePerformanceInput):
  { state: "ready"; request: PerformanceRequest; inputKey: string } | Unknown {
  const {map}=input;
  if(typeof map.text!=="string"||!map.text||Buffer.byteLength(map.text)>24*1024*1024||createHash("sha256").update(map.text).digest("hex")!==map.sha256)
    return unknown("exact-standard-map-unavailable");
  const result=buildAggregatePerformanceCalculation(input);
  return result.state==="ready"?{state:"ready",request:{beatmap:map.text,calculations:[result.calculation]},inputKey:result.inputKey}:result;
}
/** Main uses a verified resource descriptor; the isolated utility retains and submits exact bytes. */
export function buildAggregatePerformanceCalculation(input:Omit<AggregatePerformanceInput,"map">&{map:Omit<AggregatePerformanceInput["map"],"text">}):
  {state:"ready";calculation:PerformanceRequest["calculations"][number];inputKey:string}|Unknown {
  const { map, score } = input;
  if (map.ruleset !== 0 || !int32(map.objectCount) || map.objectCount === 0 || !Number.isFinite(map.aggregateTimeMs) ||
    !/^[a-f0-9]{64}$/.test(map.sha256))
    return unknown("exact-standard-map-unavailable");
  if (!int32(score.maxCombo) || !input.profileKey || !score.evidenceKey) return unknown("aggregate-score-unqualified");
  let statistics: PerformanceStatistics;
  if (score.mode === "stable") {
    if (!Array.isArray(score.basic) || score.basic.length !== 4 || !score.basic.every(int32) ||
      (score.legacyScoreV1 !== undefined && !int32(score.legacyScoreV1))) return unknown("invalid-saved-statistics");
    const [great, ok, meh, miss] = score.basic;
    statistics = { great, ok, meh, miss, large_tick_hit: 0, large_tick_miss: 0, small_tick_hit: 0, small_tick_miss: 0,
      slider_tail_hit: 0, slider_tail_miss: 0 }; // Unused by this Stable calculation, not perfect-slider evidence.
  } else {
    if (!["lazer", "lazer-classic"].includes(score.mode) || !score.componentsQualified || !score.statistics ||
      !statisticKeys.every(key => int32(score.statistics[key]))) return unknown("native-component-evidence-unavailable");
    statistics = Object.fromEntries(statisticKeys.map(key => [key, score.statistics[key]])) as unknown as PerformanceStatistics;
  }
  const total = statistics.great + statistics.ok + statistics.meh + statistics.miss;
  if (total !== map.objectCount) return unknown("aggregate-object-coverage-incomplete");
  if (!Array.isArray(input.mods) || input.mods.length > 64 || input.mods.some(mod => !record(mod) ||
    typeof mod.acronym !== "string" || !/^[A-Z0-9]{1,8}$/.test(mod.acronym) || (mod.settings !== undefined &&
      (!record(mod.settings) || Object.values(mod.settings).some(value => typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value)))))))
    return unknown("native-mod-settings-unavailable");
  const mods = normalizePerformanceMods(input.mods, score.mode);
  if (score.mode === "stable" && score.legacyScoreV1 !== undefined && mods.some(mod => mod.acronym === "V2" || mod.acronym === "SV2"))
    return unknown("score-v1-total-conflicts-with-v2");
  if (new Set(mods.map(mod => mod.acronym)).size !== mods.length ||
    (score.mode === "lazer" && mods.some(mod => mod.acronym === "CL")) ||
    (score.mode === "lazer-classic" && !mods.some(mod => mod.acronym === "CL"))) return unknown("profile-mod-conflict");
  const state: CumulativePerformanceState = { time: map.aggregateTimeMs, passedObjects: total, maxCombo: score.maxCombo, statistics,
    ...(score.mode === "stable" && score.legacyScoreV1 !== undefined ? { legacyTotalScore: score.legacyScoreV1 } : {}) };
  const calculation:PerformanceRequest["calculations"][number]={mode:score.mode,scope:"full-map",mods,states:[state]};
  try {
    const inputKey = metricInputKey({ projection: LIBRARY_AGGREGATE_PROJECTION_VERSION, engine: PERFORMANCE_ENGINE_VERSION,
      mapSha256: map.sha256, requestMapSha256: map.sha256,
      profile: input.profileKey, evidence: score.evidenceKey, calculations:[calculation] });
    return { state: "ready", calculation, inputKey };
  } catch { return unknown("aggregate-input-limit"); }
}

