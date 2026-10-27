import { Beatmap, HitCircle, HitSampleInfo, isSlider, ReplayAnalysisEvent, Spinner } from "@osujs/core";
import type { ReplayLifeBarPoint } from "../../../model/OsuReplay";

export interface HitSoundCue {
  id: string;
  time: number;
  samples: readonly HitSampleInfo[];
}

export type StoryboardPlaybackState = "pass" | "fail";
export type StoryboardPlaybackStateSource = StoryboardPlaybackState | ((time: number) => StoryboardPlaybackState);

function mainJudgementFor(
  hitObject: Beatmap["hitObjects"][number],
  eventsByObjectId: ReadonlyMap<string, Extract<ReplayAnalysisEvent, { type: "HitObjectJudgement" }>>,
) {
  if (isSlider(hitObject)) return eventsByObjectId.get(hitObject.id) ?? eventsByObjectId.get(hitObject.head.id);
  return eventsByObjectId.get(hitObject.id);
}

function comboSetKey(beatmap: Beatmap, index: number): number {
  const hitObject = beatmap.hitObjects[index];
  if (hitObject instanceof HitCircle) return hitObject.comboSetIndex;
  if (isSlider(hitObject)) return hitObject.head.comboSetIndex;
  for (let next = index + 1; next < beatmap.hitObjects.length; next++) {
    const nextObject = beatmap.hitObjects[next];
    if (nextObject instanceof HitCircle) return nextObject.comboSetIndex;
    if (isSlider(nextObject)) return nextObject.head.comboSetIndex;
  }
  for (let previous = index - 1; previous >= 0; previous--) {
    const previousObject = beatmap.hitObjects[previous];
    if (previousObject instanceof HitCircle) return previousObject.comboSetIndex + 1;
    if (isSlider(previousObject)) return previousObject.head.comboSetIndex + 1;
  }
  return 0;
}

function healthAtBreak(lifeBar: readonly ReplayLifeBarPoint[], breakStartTime: number): number | null {
  let closest: ReplayLifeBarPoint | undefined;
  for (const point of lifeBar) {
    if (!closest || Math.abs(point.time - breakStartTime) < Math.abs(closest.time - breakStartTime)) closest = point;
  }
  return closest?.health ?? null;
}

/**
 * Reconstructs Stable storyboard Pass/Fail audio state. During gameplay the
 * previous completed combo set is Pass only when it earned a Geki (all 300s);
 * during breaks the replay's recorded HP decides the state.
 */
export function buildStoryboardPlaybackStateResolver(
  beatmap: Beatmap,
  events: readonly ReplayAnalysisEvent[],
  lifeBar: readonly ReplayLifeBarPoint[] = [],
): (time: number) => StoryboardPlaybackState {
  const eventsByObjectId = new Map<string, Extract<ReplayAnalysisEvent, { type: "HitObjectJudgement" }>>();
  for (const event of events) {
    if (event.type === "HitObjectJudgement") eventsByObjectId.set(event.hitObjectId, event);
  }

  const comboSets = new Map<number, { complete: boolean; latestTime: number; allGreat: boolean }>();
  beatmap.hitObjects.forEach((hitObject, index) => {
    const key = comboSetKey(beatmap, index);
    const group = comboSets.get(key) ?? { complete: true, latestTime: -Infinity, allGreat: true };
    const judgement = mainJudgementFor(hitObject, eventsByObjectId);
    group.complete &&= judgement !== undefined;
    if (judgement) {
      group.latestTime = Math.max(group.latestTime, judgement.judgementTime ?? judgement.time);
      group.allGreat &&= judgement.verdict === "GREAT";
    }
    comboSets.set(key, group);
  });
  const transitions = Array.from(comboSets.values())
    .filter((group) => group.complete && Number.isFinite(group.latestTime))
    .map((group) => ({ time: group.latestTime, state: group.allGreat ? ("pass" as const) : ("fail" as const) }))
    .sort((left, right) => left.time - right.time);

  return (time: number) => {
    let state: StoryboardPlaybackState = "pass";
    for (const transition of transitions) {
      if (transition.time > time) break;
      state = transition.state;
    }
    const activeBreak = beatmap.breakPeriods.find((period) => period.startTime <= time && time <= period.endTime);
    if (!activeBreak) return state;
    const health = healthAtBreak(lifeBar, activeBreak.startTime);
    return health === null ? state : health > 0.5 ? "pass" : "fail";
  };
}

const isSuccessfulVerdict = (event: ReplayAnalysisEvent) =>
  event.type === "HitObjectJudgement" && event.verdict !== "MISS";

/** Builds replay hitsounds, including Classic's unconditional tail sample when enabled. */
export function buildHitSoundCues(
  beatmap: Beatmap,
  events: readonly ReplayAnalysisEvent[],
  storyboardState: StoryboardPlaybackStateSource = "pass",
): HitSoundCue[] {
  const cues: HitSoundCue[] = [];
  beatmap.storyboardSamples.forEach((sample, index) => {
    const state = typeof storyboardState === "function" ? storyboardState(sample.time) : storyboardState;
    if (sample.layer === 1 && state !== "fail") return;
    if (sample.layer === 2 && state !== "pass") return;
    cues.push({
      id: `storyboard-sample:${index}:${sample.time}:${sample.filename}`,
      time: sample.time,
      samples: [new HitSampleInfo("storyboard", null, null, sample.volume, sample.filename)],
    });
  });
  for (const event of events) {
    if (event.type === "HitObjectJudgement" && isSuccessfulVerdict(event)) {
      const hitObject = beatmap.getHitObject(event.hitObjectId);
      if (hitObject instanceof HitCircle) {
        if (hitObject.samples.length > 0) {
          cues.push({
            id: `hit-object:${event.eventId ?? event.hitObjectId}`,
            time: event.judgementTime ?? event.time,
            samples: hitObject.samples,
          });
        }
      } else if (hitObject instanceof Spinner && hitObject.samples.length > 0) {
        cues.push({
          id: `spinner:${event.eventId ?? event.hitObjectId}`,
          time: event.judgementTime ?? event.time,
          samples: hitObject.samples,
        });
      }
      // Stable also emits a parent slider result at the end. Edge sounds are
      // driven by the head/checkpoint evidence below, so the parent is silent.
      continue;
    }

    if (event.type === "SliderEndJudgement") {
      const alwaysPlay = beatmap.lazerModSettings.classic?.alwaysPlayTailSample === true;
      if (!event.hit && !alwaysPlay) continue;
      const slider = beatmap.getSlider(event.sliderId);
      const samples = slider.nodeSamples[slider.spanCount] ?? [];
      if (samples.length > 0) {
        cues.push({
          id: `lazer-slider-tail:${event.eventId}`,
          time: alwaysPlay ? slider.endTime : event.judgementTime,
          samples,
        });
      }
      continue;
    }

    if (event.type !== "CheckpointJudgement" || !event.hit) continue;
    const slider = beatmap.getSlider(event.sliderId);
    const checkpoint = beatmap.getSliderCheckPoint(event.checkpointId);
    if (event.checkpointType === "LAST_LEGACY_TICK") {
      const tailSamples = slider.nodeSamples[slider.spanCount] ?? checkpoint.samples;
      if (tailSamples.length > 0) {
        cues.push({ id: `slider-tail:${event.eventId}`, time: slider.endTime, samples: tailSamples });
      }
    } else if (checkpoint.samples.length > 0) {
      cues.push({
        id: `slider-component:${event.eventId}`,
        time: event.judgementTime,
        samples: checkpoint.samples,
      });
    }
  }

  return cues.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}
