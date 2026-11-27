import type { Position } from "@osujs/math";
import type { ReplayAnalysisEvent } from "@osujs/core";

export type LazerSliderMissKind = "HEAD" | "TICK" | "REPEAT" | "SLIDER_END";

export interface LazerSliderMissFeedback {
  id: string;
  time: number;
  position: Position;
  kind: LazerSliderMissKind;
}

/**
 * Collects only native lazer slider-component misses. lazer does not show a
 * separate judgement sprite for successful ticks, repeats, or slider ends.
 * Stable checkpoints are intentionally excluded rather than translated into
 * lazer-only slidertickmiss/sliderendmiss feedback.
 */
export function collectLazerSliderMissFeedback(events: readonly ReplayAnalysisEvent[]): LazerSliderMissFeedback[] {
  const feedback: LazerSliderMissFeedback[] = [];

  for (const event of events) {
    if (event.ruleset !== "lazer") continue;

    if (event.type === "SliderComponentMiss" && event.componentType === "HEAD") {
      feedback.push({ id: event.eventId, time: event.judgementTime, position: event.position, kind: "HEAD" });
    } else if (event.type === "CheckpointJudgement" && event.checkpointType !== "LAST_LEGACY_TICK" && !event.hit) {
      feedback.push({
        id: event.eventId,
        time: event.judgementTime,
        position: event.position,
        kind: event.checkpointType,
      });
    } else if (event.type === "SliderEndJudgement" && !event.hit) {
      feedback.push({
        id: event.eventId,
        time: event.judgementTime,
        position: event.position,
        kind: "SLIDER_END",
      });
    }
  }

  return feedback.sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
}
