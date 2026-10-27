import type { CheckpointJudgement, ReplayAnalysisEvent } from "@osujs/core";
import { drainSteps } from "@osujs/core";

/**
 * Stable SliderEnd statistics describe tail-only misses. A missed legacy tail
 * on an already broken slider is covered by SliderBreak, even if its break
 * resolves after the legacy checkpoint or appears later in the event stream.
 * This filters presentation only; the original scoring judgements stay intact.
 */
export function standaloneStableSliderEndMisses(events: readonly ReplayAnalysisEvent[]): CheckpointJudgement[] {
  return drainSteps(standaloneStableSliderEndMissSteps(events));
}
export function* standaloneStableSliderEndMissSteps(events:readonly ReplayAnalysisEvent[]):Generator<void,CheckpointJudgement[],void> {
  const brokenSliderIds = new Set<string>();let work=0;
  for(const event of events){
    if(++work%256===0)yield;
    if(event.type==="SliderBreak"&&event.ruleset==="stable")brokenSliderIds.add(event.sliderId);
  }
  const misses = new Map<string, CheckpointJudgement>();

  for (const event of events) {
    if(++work%256===0)yield;
    if (
      event.type === "CheckpointJudgement" &&
      event.ruleset === "stable" &&
      event.checkpointType === "LAST_LEGACY_TICK" &&
      !event.hit &&
      !brokenSliderIds.has(event.sliderId) &&
      !misses.has(event.eventId)
    ) {
      misses.set(event.eventId, event);
    }
  }

  const result:CheckpointJudgement[]=[];
  for(const event of misses.values()){result.push(event);if(++work%256===0)yield;}
  return result;
}
