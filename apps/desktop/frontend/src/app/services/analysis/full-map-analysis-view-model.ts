import { hitWindowsForOD } from "@osujs/math";
import { stableScoreGrade } from "../../../../../shared/replay-grade";
import { dominantBeatLength, resolveLazerModSettings } from "@osujs/core";
import type { LazerMod, OsuClassicMod, ReplayAnalysisRuleset } from "@osujs/core";
import type { FullMapAnalysisSummary, StableJudgementCounts } from "./full-map-analysis";
import type { FullMapAimScatter } from "./full-map-aim-scatter";

export type FullMapGrade = "SS" | "S" | "A" | "B" | "C" | "D" | "F";
export type ReplayCompletionStatus = "passed" | "failed" | "unknown";

export interface FullMapResultPercentages {
  count300: number | null;
  count100: number | null;
  count50: number | null;
  countMiss: number | null;
}

export interface FullMapSliderMetric {
  label: "SLIDER BREAK" | "SLIDER TICK";
  value: number;
}

/** Replay evidence deliberately kept structural so callers do not need AnalysisApp. */
export interface FullMapReplayEvidence {
  /** An authoritative source value, when the replay container/API supplies one. */
  passed?: boolean | null;
  /** Last decoded replay-frame timestamp in beatmap coordinates. */
  lastFrameTimeMs?: number | null;
  mods?: readonly string[];
  lazerMods?: readonly LazerMod[];
  /** Native ruleset encoded by the replay, independent of the active reconstruction. */
  sourceRuleset?: ReplayAnalysisRuleset;
}

export interface FullMapTimingPointEvidence {
  time: number;
  beatLength: number;
}

export interface FullMapBeatmapDifficultyEvidence {
  drainRate: number;
  circleSize: number;
  overallDifficulty: number;
  approachRate: number;
}

/** Built/effective beatmap values, after difficulty mods have been applied. */
export interface FullMapBeatmapEvidence {
  durationMs?: number | null;
  /** Last non-spinner object's start (slider head), used only as the graph endpoint. */
  chartEndTimeMs?: number | null;
  /** End of the final playable object; preferable to audio duration for completion checks. */
  completionTimeMs?: number | null;
  objectCount?: number | null;
  hitCircleCount?: number | null;
  sliderCount?: number | null;
  timingPoints?: readonly FullMapTimingPointEvidence[];
  difficulty?: FullMapBeatmapDifficultyEvidence | null;
}

export interface FullMapHitWindowReferences {
  available: boolean;
  greatMs: number | null;
  okMs: number | null;
  mehMs: number | null;
  missMs: number | null;
}

export interface FullMapFooterMetadata {
  durationMs: number | null;
  objectCount: number | null;
  hitCircleCount: number | null;
  sliderCount: number | null;
  bpm: number | null;
  cs: number | null;
  ar: number | null;
  od: number | null;
  hp: number | null;
}

export interface FullMapAnalysisContext {
  title?: string;
  artist?: string;
  difficulty?: string;
  player?: string;
}

/** Times (ms) of the events drawn in each chart's marks lane, in the replay timeline's categories. */
export interface FullMapMarks {
  miss: readonly number[];
  sliderBreak: readonly number[];
  ok: readonly number[];
  meh: readonly number[];
}

export interface FullMapAnalysisViewModelInput {
  summary: FullMapAnalysisSummary;
  replay?: FullMapReplayEvidence;
  beatmap?: FullMapBeatmapEvidence;
  context?: FullMapAnalysisContext;
  aim?: FullMapAimScatter;
  marks?: FullMapMarks;
}

export interface FullMapReplayMod {
  readonly mod: OsuClassicMod | "CLASSIC" | "DIFFICULTY_ADJUST";
  readonly acronym: string;
  readonly name: string;
  readonly settingsLabel?: string;
  readonly details?: string;
}

// Presentation order follows HD -> DT/NC -> HR -> FL, not replay bit order.
const REPLAY_MOD_DISPLAY_ORDER: readonly FullMapReplayMod[] = [
  { mod: "TOUCH_DEVICE", acronym: "TD", name: "Touch Device" },
  { mod: "NO_FAIL", acronym: "NF", name: "No Fail" },
  { mod: "EASY", acronym: "EZ", name: "Easy" },
  { mod: "HIDDEN", acronym: "HD", name: "Hidden" },
  { mod: "DOUBLE_TIME", acronym: "DT", name: "Double Time" },
  { mod: "NIGHT_CORE", acronym: "NC", name: "Nightcore" },
  { mod: "HALF_TIME", acronym: "HT", name: "Half Time" },
  { mod: "HARD_ROCK", acronym: "HR", name: "Hard Rock" },
  { mod: "SUDDEN_DEATH", acronym: "SD", name: "Sudden Death" },
  { mod: "PERFECT", acronym: "PF", name: "Perfect" },
  { mod: "FLASH_LIGHT", acronym: "FL", name: "Flashlight" },
  { mod: "RELAX", acronym: "RX", name: "Relax" },
  { mod: "AUTO_PILOT", acronym: "AP", name: "Autopilot" },
  { mod: "SPUN_OUT", acronym: "SO", name: "Spun Out" },
  { mod: "AUTO_PLAY", acronym: "AT", name: "Autoplay" },
  { mod: "SCORE_V2", acronym: "V2", name: "Score V2" },
  { mod: "CLASSIC", acronym: "CL", name: "Classic" },
  { mod: "DIFFICULTY_ADJUST", acronym: "DA", name: "Difficulty Adjust" },
];

export function buildFullMapReplayMods(
  mods: readonly string[] = [],
  lazerMods: readonly LazerMod[] = [],
): readonly FullMapReplayMod[] {
  const requested = new Set([...mods, ...lazerMods.map((mod) => mod.acronym)].map((mod) => mod.trim().toUpperCase()));
  const selected = new Set(
    REPLAY_MOD_DISPLAY_ORDER.filter((mod) => requested.has(mod.mod) || requested.has(mod.acronym)).map(
      (mod) => mod.mod,
    ),
  );
  // Legacy replay masks also set the base mod's bit for these variants.
  if (selected.has("NIGHT_CORE")) selected.delete("DOUBLE_TIME");
  if (selected.has("PERFECT")) selected.delete("SUDDEN_DEATH");
  const settings = resolveLazerModSettings(lazerMods);
  return REPLAY_MOD_DISPLAY_ORDER.filter((mod) => selected.has(mod.mod)).map((mod) => {
    if (["DT", "NC", "HT"].includes(mod.acronym) && settings.clockRate !== undefined) {
      const rate = `${settings.clockRate.toFixed(2)}×`;
      return {
        ...mod,
        settingsLabel: rate,
        details: `${rate} speed · Pitch ${settings.adjustPitch ? "changes with speed" : "preserved"}`,
      };
    }
    if (mod.acronym === "DA" && settings.difficultyAdjust) {
      const difficulty = settings.difficultyAdjust;
      const fields = [
        ["CS", difficulty.circleSize],
        ["AR", difficulty.approachRate],
        ["OD", difficulty.overallDifficulty],
        ["HP", difficulty.drainRate],
      ] as const;
      return {
        ...mod,
        details:
          fields
            .filter(([, value]) => value !== undefined)
            .map(([label, value]) => `${label} ${value}`)
            .join(" · ") || "Original map difficulty",
      };
    }
    if (mod.acronym === "CL" && settings.classic) {
      const classic = settings.classic;
      return {
        ...mod,
        details: [
          `Slider head accuracy: ${classic.noSliderHeadAccuracy ? "off" : "on"}`,
          `Classic note lock: ${classic.classicNoteLock ? "on" : "off"}`,
          `Always play tail sample: ${classic.alwaysPlayTailSample ? "on" : "off"}`,
          `Early circle fade: ${classic.fadeHitCircleEarly ? "on" : "off"}`,
          `Classic health: ${classic.classicHealth ? "on" : "off"}`,
        ].join("\n"),
      };
    }
    return mod;
  });
}

export interface FullMapAnalysisViewModel {
  summary: FullMapAnalysisSummary;
  /** Optional source identity for the analysis header; blank fields are omitted. */
  context?: FullMapAnalysisContext;
  /** Display-only endpoint; does not shorten the analysis or replay completion timeline. */
  chartEndTimeMs: number;
  sourceRuleset: ReplayAnalysisRuleset;
  /** Source replay mods, independent of the selected reconstruction or visual toggles. */
  mods: readonly FullMapReplayMod[];
  resultPercentages: FullMapResultPercentages;
  completionStatus: ReplayCompletionStatus;
  grade: FullMapGrade | null;
  rankColor: string | null;
  sliderMetric: FullMapSliderMetric;
  sliderEndMissCount: number;
  hitWindows: FullMapHitWindowReferences;
  footer: FullMapFooterMetadata;
  /** Where the cursor was at each hit; unavailable when the caller had no replay evidence to collect it from. */
  aim: FullMapAimScatter;
  marks: FullMapMarks;
}

const RANK_COLORS: Readonly<Record<FullMapGrade, string>> = Object.freeze({
  // S/SS use silver instead when the source replay includes HD or FL.
  SS: "#ffd62d",
  S: "#ffd62d",
  A: "#88da20",
  B: "#4b7bff",
  C: "#b56cff",
  D: "#ff5a5a",
  F: "#3f3f3f",
});

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteDifficulty(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function countTotal(counts: StableJudgementCounts): number {
  return counts.count300 + counts.count100 + counts.count50 + counts.countMiss;
}

export function calculateResultPercentages(counts: StableJudgementCounts): FullMapResultPercentages {
  const total = countTotal(counts);
  if (!Number.isFinite(total) || total <= 0) {
    return { count300: null, count100: null, count50: null, countMiss: null };
  }
  return {
    count300: counts.count300 / total,
    count100: counts.count100 / total,
    count50: counts.count50 / total,
    countMiss: counts.countMiss / total,
  };
}

function stableGrade(counts: StableJudgementCounts): FullMapGrade | null {
  return stableScoreGrade([counts.count300, counts.count100, counts.count50, counts.countMiss]);
}

function lazerGrade(accuracy: number | null, missCount: number): FullMapGrade | null {
  if (accuracy === null || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1) return null;

  let grade: FullMapGrade;
  if (accuracy === 1) grade = "SS";
  else if (accuracy >= 0.95) grade = "S";
  else if (accuracy >= 0.9) grade = "A";
  else if (accuracy >= 0.8) grade = "B";
  else if (accuracy >= 0.7) grade = "C";
  else grade = "D";

  // Native osu!standard demotes either top grade to A when a miss is present.
  return missCount > 0 && (grade === "SS" || grade === "S") ? "A" : grade;
}

export function calculateFullMapGrade(
  summary: Pick<FullMapAnalysisSummary, "ruleset" | "accuracy" | "judgements">,
  completionStatus: ReplayCompletionStatus,
): FullMapGrade | null {
  if (completionStatus === "failed") return "F";
  return summary.ruleset === "stable"
    ? stableGrade(summary.judgements)
    : lazerGrade(summary.accuracy, summary.judgements.countMiss);
}

export function rankColorForGrade(grade: FullMapGrade, mods: readonly FullMapReplayMod[] = []): string {
  if ((grade === "SS" || grade === "S") && mods.some(({ mod }) => mod === "HIDDEN" || mod === "FLASH_LIGHT")) {
    return "#d9e1e8";
  }
  return RANK_COLORS[grade];
}

export function resolveReplayCompletionStatus(
  summary: Pick<FullMapAnalysisSummary, "judgements">,
  replay?: FullMapReplayEvidence,
  beatmap?: FullMapBeatmapEvidence,
): ReplayCompletionStatus {
  if (replay?.passed === true) return "passed";
  if (replay?.passed === false) return "failed";

  const objectCount = finiteNonNegative(beatmap?.objectCount);
  if (objectCount !== null && objectCount > 0 && countTotal(summary.judgements) >= objectCount) return "passed";

  const replayEnd = finiteNonNegative(replay?.lastFrameTimeMs);
  const mapEnd = finiteNonNegative(beatmap?.completionTimeMs ?? beatmap?.durationMs);
  if (replayEnd === null || mapEnd === null || mapEnd <= 0) return "unknown";
  if (replayEnd >= mapEnd) return "passed";

  const noFail = replay?.mods?.some((mod) => mod.toUpperCase() === "NO_FAIL") ?? false;
  return noFail ? "unknown" : "failed";
}

export function buildFullMapHitWindowReferences(
  summary: Pick<FullMapAnalysisSummary, "ruleset" | "baseRate">,
  difficulty?: FullMapBeatmapDifficultyEvidence | null,
): FullMapHitWindowReferences {
  const od = finiteDifficulty(difficulty?.overallDifficulty);
  const rate = finiteNonNegative(summary.baseRate);
  if (od === null || rate === null || rate <= 0) {
    return { available: false, greatMs: null, okMs: null, mehMs: null, missMs: null };
  }

  const timingDivisor = summary.ruleset === "lazer" ? rate : 1;
  const [greatMs, okMs, mehMs, missMs] = hitWindowsForOD(od, summary.ruleset === "lazer").map(
    (window) => window / timingDivisor,
  );
  return { available: true, greatMs, okMs, mehMs, missMs };
}


export function buildFullMapFooterMetadata(
  summary: Pick<FullMapAnalysisSummary, "duration" | "baseRate" | "coverage">,
  beatmap?: FullMapBeatmapEvidence,
): FullMapFooterMetadata {
  const suppliedDuration = finiteNonNegative(beatmap?.durationMs);
  const summaryDuration = finiteNonNegative(summary.duration);
  const durationMs = suppliedDuration ?? summaryDuration;
  const suppliedObjectCount = finiteNonNegative(beatmap?.objectCount);
  const coveredObjectCount = finiteNonNegative(summary.coverage.totalObjectCount);
  const objectCount = suppliedObjectCount === null ? coveredObjectCount : Math.trunc(suppliedObjectCount);
  const hitCircleCount = finiteNonNegative(beatmap?.hitCircleCount);
  const sliderCount = finiteNonNegative(beatmap?.sliderCount);
  const baseRate = finiteNonNegative(summary.baseRate);
  const completionTimeMs = finiteNonNegative(beatmap?.completionTimeMs);
  const beatLength = dominantBeatLength(beatmap?.timingPoints, completionTimeMs ?? durationMs);
  const difficulty = beatmap?.difficulty;

  return {
    durationMs,
    objectCount,
    hitCircleCount: hitCircleCount === null ? null : Math.trunc(hitCircleCount),
    sliderCount: sliderCount === null ? null : Math.trunc(sliderCount),
    bpm: beatLength !== null && baseRate !== null && baseRate > 0 ? (60_000 / beatLength) * baseRate : null,
    cs: finiteDifficulty(difficulty?.circleSize),
    ar: finiteDifficulty(difficulty?.approachRate),
    od: finiteDifficulty(difficulty?.overallDifficulty),
    hp: finiteDifficulty(difficulty?.drainRate),
  };
}

export function buildFullMapAnalysisViewModel({
  summary,
  replay,
  beatmap,
  context,
  aim,
  marks,
}: FullMapAnalysisViewModelInput): FullMapAnalysisViewModel {
  const completionStatus = resolveReplayCompletionStatus(summary, replay, beatmap);
  const grade = calculateFullMapGrade(summary, completionStatus);
  const mods = buildFullMapReplayMods(replay?.mods, replay?.lazerMods);
  const identity: FullMapAnalysisContext = {};
  for (const key of ["title", "artist", "difficulty", "player"] as const) {
    const value = context?.[key]?.trim();
    if (value) identity[key] = value;
  }
  return {
    summary,
    ...(Object.keys(identity).length > 0 ? { context: identity } : {}),
    chartEndTimeMs: finiteNonNegative(beatmap?.chartEndTimeMs) ?? finiteNonNegative(summary.duration) ?? 0,
    sourceRuleset: replay?.sourceRuleset ?? summary.ruleset,
    mods,
    resultPercentages: calculateResultPercentages(summary.judgements),
    completionStatus,
    grade,
    rankColor: grade === null ? null : rankColorForGrade(grade, mods),
    sliderMetric:
      summary.ruleset === "stable"
        ? { label: "SLIDER BREAK", value: summary.errors.sliderBreakCount ?? 0 }
        : { label: "SLIDER TICK", value: summary.sliderMisses.sliderTickMissCount ?? 0 },
    sliderEndMissCount: summary.sliderMisses.sliderEndMissCount,
    hitWindows: buildFullMapHitWindowReferences(summary, beatmap?.difficulty),
    footer: buildFullMapFooterMetadata(summary, beatmap),
    aim: aim ?? {
      available: false,
      unavailableReason: "Aim positions are unavailable.",
      points: [],
      mean: null,
      omittedCount: 0,
      omittedMissCount: 0,
      misses: [],
    },
    marks: marks ?? { miss: [], sliderBreak: [], ok: [], meh: [] },
  };
}
