import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import { drainSteps, drainStepsAsync, stableSortSteps } from "@osujs/core";
import { standaloneStableSliderEndMissSteps } from "./stable-slider-end-misses";

export type ReplayErrorType = "MISS" | "SLIDER_BREAK" | "SLIDER_COMPONENT_MISS" | "ANALYSIS_ERROR";

export interface ReplayError {
  id: string;
  time: number;
  type: ReplayErrorType;
  hitObjectId?: string;
  sliderId?: string;
  sliderComponentType?: "HEAD" | "TICK" | "REPEAT" | "TAIL" | "LAST_LEGACY_TICK";
}

export interface ReplayEventTimings {
  great: number[];
  ok: number[];
  meh: number[];
  miss: number[];
  sliderBreak: number[];
  stableSliderEndMiss: number[];
  lazerSliderTickMiss: number[];
  lazerSliderEndMiss: number[];
}

/**
 * Converts low-level simulation events into player-facing timing/statistic
 * groups and navigable errors. Only explicit Stable SliderBreak events become
 * sliderbreak markers. Native lazer tick and repeat misses get component
 * markers; actual-tail misses supply SliderEnd statistics and optional markers.
 */
export function summarizeReplayEvents(
  events: readonly ReplayAnalysisEvent[],
  ruleset?: ReplayAnalysisRuleset,
): {
  timings: ReplayEventTimings;
  errors: ReplayError[];
} {
  return drainSteps(summarizeReplayEventSteps(events,ruleset));
}
export function summarizeReplayEventsAsync(events:readonly ReplayAnalysisEvent[],ruleset:ReplayAnalysisRuleset|undefined,
  checkpoint:()=>Promise<void>) {
  return drainStepsAsync(summarizeReplayEventSteps(events,ruleset),checkpoint);
}
function* summarizeReplayEventSteps(events:readonly ReplayAnalysisEvent[],ruleset?:ReplayAnalysisRuleset):
  Generator<void,{timings:ReplayEventTimings;errors:ReplayError[]},void> {
  let work=0;
  const tails=ruleset==="lazer"?[]:yield* standaloneStableSliderEndMissSteps(events);
  const stableSliderEndMiss:number[]=[];
  for(const event of tails){stableSliderEndMiss.push(event.sliderEndTime??event.objectTime);if(++work%256===0)yield;}
  const timings: ReplayEventTimings = {
    great: [],
    ok: [],
    meh: [],
    miss: [],
    sliderBreak: [],
    // Tail-only misses supply optional markers, not Previous/Next Error targets.
    stableSliderEndMiss,
    lazerSliderTickMiss: [],
    lazerSliderEndMiss: [],
  };
  const errors: ReplayError[] = [];
  const seenErrors = new Set<string>();
  const missedSliderIds = new Set<string>();
  for(const event of events){
    if(++work%256===0)yield;
    if(event.type==="HitObjectJudgement"&&!event.isSliderHead&&event.verdict==="MISS")missedSliderIds.add(event.hitObjectId);
  }

  const pushError = (error: ReplayError) => {
    if (seenErrors.has(error.id)) return;
    seenErrors.add(error.id);
    errors.push(error);
  };

  for(const event of events) {
    if(++work%256===0)yield;
    // Ruleset focus changes and their event streams are separate observable
    // updates. Guard every marker here so a transient/stale Stable stream can
    // never expose an SB while the Lazer view is active (and vice versa).
    if (ruleset !== undefined && event.ruleset !== undefined && event.ruleset !== ruleset) continue;

    if (event.type === "SliderComponentMiss") {
      const time = event.objectTime ?? event.time;
      if (event.componentType === "TAIL") {
        // SliderEnd supplies statistics and optional timeline markers, but
        // remains outside Previous/Next Error navigation.
        timings.lazerSliderEndMiss.push(time);
        continue;
      }
      timings.lazerSliderTickMiss.push(time);
      pushError({
        id: event.eventId,
        time,
        type: "SLIDER_COMPONENT_MISS",
        sliderId: event.sliderId,
        sliderComponentType: event.componentType,
      });
      continue;
    }

    if (event.type === "SliderBreak") {
      // Player-facing SB counts exclude sliders which already resolved as an
      // actual MISS. The miss is the single error shown for that slider.
      if (missedSliderIds.has(event.sliderId)) continue;
      const time = event.objectTime ?? event.time;
      timings.sliderBreak.push(time);
      pushError({
        id: event.eventId,
        time,
        type: "SLIDER_BREAK",
        hitObjectId: event.componentType === "HEAD" ? event.componentId : undefined,
        sliderId: event.sliderId,
      });
      continue;
    }

    if (event.type === "HitObjectJudgement") {
      if (event.affectsAccuracy === false) continue;
      const time = event.objectTime ?? event.time;
      // Stable scores the slider parent and hides its nested head judgement.
      // Native lazer scores the head itself, so its misses must stay visible.
      if (event.isSliderHead && event.ruleset !== "lazer") continue;

      switch (event.verdict) {
        case "GREAT":
          timings.great.push(time);
          break;
        case "OK":
          timings.ok.push(time);
          break;
        case "MEH":
          timings.meh.push(time);
          break;
        case "MISS":
          timings.miss.push(time);
          pushError({
            id: `miss:${event.hitObjectId}`,
            time,
            type: "MISS",
            hitObjectId: event.hitObjectId,
          });
          break;
      }
      continue;
    }
  }

  yield* stableSortSteps(errors,(a,b)=>a.time-b.time||a.id.localeCompare(b.id));
  return { timings, errors };
}

export function findPreviousErrorIndex(errors: ReplayError[], currentTime: number, selectedIndex = -1): number {
  if (selectedIndex > 0 && selectedIndex < errors.length && currentTime <= errors[selectedIndex].time + 1)
    return selectedIndex - 1;
  for (let i = errors.length - 1; i >= 0; i--) {
    if (errors[i].time < currentTime - 1) return i;
  }
  return -1;
}

export function findNextErrorIndex(errors: ReplayError[], currentTime: number, selectedIndex = -1): number {
  if (selectedIndex >= 0 && selectedIndex + 1 < errors.length && currentTime <= errors[selectedIndex].time + 1)
    return selectedIndex + 1;
  for (let i = 0; i < errors.length; i++) {
    if (errors[i].time > currentTime + 1) return i;
  }
  return -1;
}

export function findNearestErrorIndex(errors: ReplayError[], currentTime: number): number {
  if (errors.length === 0) return -1;
  let nearest = 0;
  for (let i = 1; i < errors.length; i++) {
    if (Math.abs(errors[i].time - currentTime) < Math.abs(errors[nearest].time - currentTime)) nearest = i;
  }
  return nearest;
}
