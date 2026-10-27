import type { ReplayPerformanceInput, PerformanceMode } from "./types";

/** Bump with the official engine or timeline semantics; cache entries never cross versions. */
export const PERFORMANCE_ENGINE_VERSION = "2026.730.0-official-pp-v9";
export const PERFORMANCE_CALCULATE_CHANNEL = "calculatePerformanceTimeline";
export const PERFORMANCE_CANCEL_CHANNEL = "cancelPerformanceTimeline";

export interface PerformancePoint {
  /** Beatmap milliseconds, independent of the viewer's playback speed. */
  time: number;
  pp: number;
  sr: number;
}

export interface StarRatingPoint {
  /** Full-map difficulty prefixes published in beatmap milliseconds. */
  time: number;
  sr: number;
}

export interface PerformanceTimeline {
  mode: PerformanceMode;
  /** Exact parsed map count and calculation coverage. Neither establishes that the player passed. */
  objectCount?: number;
  endpointVerified?: boolean;
  /** Achieved replay performance, bounded by the last recorded frame. */
  points: PerformancePoint[];
  /** Map difficulty continues after the recorded replay ends. */
  difficultyPoints: StarRatingPoint[];
  /** Official whole-map display attributes, including the selected mods. */
  fullDifficulty?: FullDifficulty;
  /** Compact library calculation only; capacities are not observed player results. */
  fullMap?: FullMapValue;
  /**
   * The official calculator's own effective miss count for the calculation behind the last point's PP.
   * Absent when no object was completed. Never on `fullDifficulty` or on every point.
   */
  effectiveMissCount?: number;
  error?: string;
  final?: { pp: number; sr: number };
}

export interface FullDifficulty {
  total: number;
  aim: number;
  speed: number;
  reading: number;
  flashlight: number;
  sliderFactor: number;
}

export interface FullMapValue {
  version: 1;
  maxCombo: number;
  largeTicks: number;
  smallTicks: number;
  sliderTails: number;
  clockRate: number;
  /** Excludes breaks and includes resolved constant mod rate. */
  drainTimeMs: number;
  /** Map milliseconds; does not establish replay completion. */
  endTimeMs: number;
}

export interface PerformanceRequest {
  beatmap: string;
  calculations: ReadonlyArray<Pick<ReplayPerformanceInput, "mode" | "mods" | "states"> & { scope?: "full-map" }>;
}

export interface PerformanceResponse {
  ok: boolean;
  engineVersion?: string;
  timelines?: PerformanceTimeline[];
  error?: string;
}

export const EMPTY_PERFORMANCE_POINT: PerformancePoint = Object.freeze({ time: -Infinity, pp: 0, sr: 0 });
export const EMPTY_STAR_RATING_POINT: StarRatingPoint = Object.freeze({ time: -Infinity, sr: 0 });

/** Immutable arrays are produced once at load. Seeking does not mutate a playback cursor. */
function pointAt<T extends { time: number }>(points: readonly T[], time: number, empty: T): T {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? empty : points[low - 1];
}

export function performanceAt(points: readonly PerformancePoint[], time: number): PerformancePoint {
  return pointAt(points, time, EMPTY_PERFORMANCE_POINT);
}

export function starRatingAt(points: readonly StarRatingPoint[], time: number): StarRatingPoint {
  return pointAt(points, time, EMPTY_STAR_RATING_POINT);
}
