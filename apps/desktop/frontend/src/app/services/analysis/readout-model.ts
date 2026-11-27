import type { LazerMod, ReplayAnalysisRuleset } from "@osujs/core";
import type { LiveReplayStats } from "./live-replay-stats";
import type { LivePerformance } from "./performance/PerformanceTimelineService";
import type { ReplayDisplaySettings } from "./replay-display-settings";
import { buildFullMapReplayMods } from "./full-map-analysis-view-model";
import { formatStarRating } from "../../utils/format-star-rating";
import { REWIND_COLORS } from "../../styles/tokens";

/** The simulator's formatted timing readouts at the current time. */
export interface ReplayTimingStats {
  ur: string;
  bias: string;
}
export interface ReadoutIdentity {
  artist?: string;
  title: string;
  difficulty?: string;
  mapper?: string;
  player?: string;
  mods: string;
  ruleset: "Stable" | "Lazer";
}
export interface ReadoutRow {
  key: "ur" | "bias" | "combo";
  label: string;
  value: string;
  suffix?: string;
}
export type ReadoutJudgementKey = "300" | "100" | "50" | "miss" | "sliderBreak" | "sliderTick" | "sliderEnd";
export interface ReadoutJudgement {
  key: ReadoutJudgementKey;
  label: string;
  count: number;
  share?: number;
  color: string;
}
export interface ReadoutModel {
  identity: ReadoutIdentity;
  performance?: { pp?: string; stars?: string };
  rows: ReadoutRow[];
  judgements: ReadoutJudgement[];
}
export type ReadoutSettings = Pick<
  ReplayDisplaySettings,
  | "performancePointsEnabled"
  | "starRatingEnabled"
  | "liveResult100Enabled"
  | "liveResult50Enabled"
  | "liveResultMissEnabled"
  | "liveResultSliderBreakEnabled"
  | "liveResultSliderTickEnabled"
  | "liveResultSliderEndEnabled"
  | "maxComboEnabled"
  | "unstableRateEnabled"
  | "timingBiasEnabled"
>;
export interface ReadoutInput {
  metadata?: { artist?: string; title?: string; difficultyName?: string; creator?: string };
  player?: string;
  mods?: readonly string[];
  lazerMods?: readonly LazerMod[];
  ruleset: ReplayAnalysisRuleset;
  info?: { verdictCounts: readonly number[] };
  stats?: LiveReplayStats;
  performance?: LivePerformance;
  timing?: ReplayTimingStats;
  settings: ReadoutSettings;
}

const clean = (value: string | undefined) => (value && value.trim() ? value.trim() : undefined);
const count = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

/** Pure mapping from live replay state to the stats overlay and the export side panel (spec §4). */
export function buildReadoutModel(input: ReadoutInput): ReadoutModel {
  const { settings, stats, performance, timing } = input;
  const identity: ReadoutIdentity = {
    artist: clean(input.metadata?.artist),
    title: clean(input.metadata?.title) ?? "Unknown beatmap",
    difficulty: clean(input.metadata?.difficultyName),
    mapper: clean(input.metadata?.creator),
    player: clean(input.player),
    mods: buildFullMapReplayMods(input.mods ?? [], input.lazerMods ?? []).map((mod) => mod.acronym).join("") || "NM",
    ruleset: input.ruleset === "lazer" ? "Lazer" : "Stable",
  };
  const point = performance?.point;
  const performanceBlock =
    settings.performancePointsEnabled || settings.starRatingEnabled
      ? {
          ...(settings.performancePointsEnabled ? { pp: point ? point.pp.toFixed(1) : "—" } : {}),
          ...(settings.starRatingEnabled && point ? { stars: formatStarRating(point.sr) } : {}),
        }
      : undefined;
  const rows: ReadoutRow[] = [];
  if (settings.unstableRateEnabled) rows.push({ key: "ur", label: "UR", value: timing?.ur ?? "—" });
  if (settings.timingBiasEnabled) {
    const bias = timing?.bias ?? "—";
    // The simulator formats "+1.5 ms" / "-1.5 ms"; the unit is styled separately and the minus is typographic.
    rows.push(
      bias.endsWith(" ms")
        ? { key: "bias", label: "Bias", value: bias.slice(0, -3).replace(/^-/, "−"), suffix: " ms" }
        : { key: "bias", label: "Bias", value: bias },
    );
  }
  if (settings.maxComboEnabled && stats)
    rows.push({ key: "combo", label: "Max Combo", value: String(count(stats.maxComboSoFar)), suffix: `/${count(stats.mapMaxCombo)}` });

  const judgements: ReadoutJudgement[] = [];
  const counts = [count(input.info?.verdictCounts[0]), count(stats?.count100), count(stats?.count50), count(stats?.countMiss)];
  const total = counts.reduce((sum, value) => sum + value, 0);
  const share = (value: number) => (total > 0 ? value / total : 0);
  // 3a shows no 300 row; the shares still count 300s (and any hidden rows), so each share is a share of every judgement.
  // No surface draws the share bars any more; the field stays on the model.
  if (settings.liveResult100Enabled)
    judgements.push({ key: "100", label: "100", count: counts[1], share: share(counts[1]), color: REWIND_COLORS.judgement100 });
  if (settings.liveResult50Enabled)
    judgements.push({ key: "50", label: "50", count: counts[2], share: share(counts[2]), color: REWIND_COLORS.judgement50 });
  if (settings.liveResultMissEnabled)
    judgements.push({ key: "miss", label: "Miss", count: counts[3], share: share(counts[3]), color: REWIND_COLORS.judgementMiss });
  if (stats) {
    if (settings.liveResultSliderBreakEnabled && stats.sliderBreakCount !== undefined)
      judgements.push({ key: "sliderBreak", label: "Break", count: count(stats.sliderBreakCount), color: REWIND_COLORS.sliderBreak });
    if (settings.liveResultSliderTickEnabled && stats.sliderTickMissCount !== undefined)
      judgements.push({ key: "sliderTick", label: "Tick", count: count(stats.sliderTickMissCount), color: REWIND_COLORS.sliderBreak });
    if (settings.liveResultSliderEndEnabled && stats.sliderEndMissCount !== undefined)
      judgements.push({ key: "sliderEnd", label: "End", count: count(stats.sliderEndMissCount), color: REWIND_COLORS.sliderEnd });
  }
  return { identity, performance: performanceBlock, rows, judgements };
}
