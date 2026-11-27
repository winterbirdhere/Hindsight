import type { GameplayInfo, ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import { summarizeReplayEvents } from "./replay-events";
import { standaloneStableSliderEndMisses } from "./stable-slider-end-misses";

export interface LiveReplayStats {
  count100: number;
  count50: number;
  countMiss: number;
  sliderBreakCount?: number;
  /** Stable tail-only misses, or missed native lazer SliderEnds. */
  sliderEndMissCount?: number;
  /** Missed native lazer ticks and repeats. Undefined in Stable. */
  sliderTickMissCount?: number;
  maxComboSoFar: number;
  mapMaxCombo: number;
}

export interface SliderMissResolutionTimes {
  stableSliderEnd: number[];
  lazerSliderTick: number[];
  lazerSliderEnd: number[];
}

const safeCount = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

/**
 * Keeps only player-facing Stable sliderbreaks, then uses their actual
 * resolution time so the live count cannot appear before the ruleset judged it.
 */
export function stableSliderBreakResolutionTimes(events: readonly ReplayAnalysisEvent[]): number[] {
  const visibleSliderBreakIds = new Set(
    summarizeReplayEvents([...events])
      .errors.filter((error) => error.type === "SLIDER_BREAK")
      .map((error) => error.id),
  );

  return events
    .filter(
      (event): event is Extract<ReplayAnalysisEvent, { type: "SliderBreak" }> =>
        event.type === "SliderBreak" && visibleSliderBreakIds.has(event.eventId),
    )
    .map((event) => event.judgementTime ?? event.time)
    .sort((left, right) => left - right);
}

/** Keeps Stable legacy tails separate from native lazer tick/end judgements. */
export function sliderMissResolutionTimes(events: readonly ReplayAnalysisEvent[]): SliderMissResolutionTimes {
  const result: SliderMissResolutionTimes = {
    stableSliderEnd: standaloneStableSliderEndMisses(events).map((event) => event.sliderEndTime ?? event.judgementTime),
    lazerSliderTick: [],
    lazerSliderEnd: [],
  };
  for (const event of events) {
    if (event.type === "SliderComponentMiss") {
      if (event.componentType === "TAIL") result.lazerSliderEnd.push(event.judgementTime);
      else result.lazerSliderTick.push(event.judgementTime);
    }
  }
  result.stableSliderEnd.sort((left, right) => left - right);
  result.lazerSliderTick.sort((left, right) => left - right);
  result.lazerSliderEnd.sort((left, right) => left - right);
  return result;
}

/** Builds the cumulative player-facing HUD values at the current replay time. */
export function liveReplayStatsAt(
  info: GameplayInfo,
  sliderBreakResolutionTimes: readonly number[],
  currentTime: number,
  ruleset: ReplayAnalysisRuleset,
  mapMaxCombo: number,
  sliderMissTimes: SliderMissResolutionTimes = {
    stableSliderEnd: [],
    lazerSliderTick: [],
    lazerSliderEnd: [],
  },
): LiveReplayStats {
  const effectiveTime = Number.isNaN(currentTime) ? 0 : currentTime;
  return {
    count100: safeCount(info.verdictCounts[1]),
    count50: safeCount(info.verdictCounts[2]),
    countMiss: safeCount(info.verdictCounts[3]),
    sliderBreakCount:
      ruleset === "stable" ? sliderBreakResolutionTimes.filter((time) => time <= effectiveTime).length : undefined,
    sliderEndMissCount: (ruleset === "stable"
      ? sliderMissTimes.stableSliderEnd
      : sliderMissTimes.lazerSliderEnd
    ).filter((time) => time <= effectiveTime).length,
    sliderTickMissCount:
      ruleset === "lazer" ? sliderMissTimes.lazerSliderTick.filter((time) => time <= effectiveTime).length : undefined,
    maxComboSoFar: safeCount(info.maxComboSoFar),
    mapMaxCombo: safeCount(mapMaxCombo),
  };
}
