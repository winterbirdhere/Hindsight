import type { LazerMod } from "@osujs/core";

/** Legacy Stable, native lazer, and native lazer with Classic remain distinct. */
export type PerformanceMode = "stable" | "lazer" | "lazer-classic";

/** Only osu!standard results used by the performance calculator. */
export interface PerformanceStatistics {
  great: number;
  ok: number;
  meh: number;
  miss: number;
  large_tick_hit: number;
  large_tick_miss: number;
  small_tick_hit: number;
  small_tick_miss: number;
  slider_tail_hit: number;
  /** Native SliderEnd IgnoreMiss; not a basic object miss. */
  slider_tail_miss: number;
}

export interface CumulativePerformanceState {
  /** Beatmap milliseconds, independent of mod or viewer playback rate. */
  time: number;
  /** Completed contiguous prefix in the beatmap's original object order. */
  passedObjects: number;
  maxCombo: number;
  statistics: PerformanceStatistics;
  /** Actual ScoreV1 only. Undefined selects the official combo-based fallback. */
  legacyTotalScore?: number;
  /** Exact reconstructed ScoreV1 for base multipliers 0..10; selected by official attributes. */
  legacyScoreByDifficultyMultiplier?: readonly number[];
  /** True only for the terminal snapshot at the recorded replay end. */
  isFinal?: boolean;
}

export interface ReplayPerformanceInput {
  mode: PerformanceMode;
  states: readonly CumulativePerformanceState[];
  finalReplayTime: number;
  limitations: readonly string[];
  /** Native setting values are retained, including DA and custom clock rates. */
  mods: readonly LazerMod[];
  /**
   * A play that never happened: this replay's results with every miss counted as hit, at the combo of the whole map.
   * Present only for a replay that completed every object. It is asked of the engine on its own, for "PP if FC".
   */
  fullComboState?: CumulativePerformanceState;
}
