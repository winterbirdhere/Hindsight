import { Beatmap, HitCircle, ReplayAnalysisEvent } from "@osujs/core";
import type { OsuReplay } from "../../model/OsuReplay";
import { findIndexInReplayAtTime, interpolateReplayPosition } from "../../utils/replay";

export interface AimDistanceSample {
  hitObjectId: string;
  time: number;
  distance: number;
  objectRadius: number;
}

export interface ReplayAimEvidence {
  samples: AimDistanceSample[];
  eligibleEventCount: number;
  unavailableReason?: string;
}

export function positionAt(replay: OsuReplay, time: number) {
  const index = findIndexInReplayAtTime(replay.frames, time);
  if (index < 0) return undefined;
  const finalFrame = replay.frames[index];
  if (finalFrame.time === time) {
    // Judgements identify a timestamp, not the exact source sample. A later
    // same-time cursor movement cannot be attributed to the assigned press.
    for (let previous = index - 1; previous >= 0 && replay.frames[previous].time === time; previous--) {
      const position = replay.frames[previous].position;
      if (position.x !== finalFrame.position.x || position.y !== finalFrame.position.y) return undefined;
    }
  }
  if (index + 1 >= replay.frames.length) {
    return finalFrame.time === time ? finalFrame.position : undefined;
  }
  return interpolateReplayPosition(replay.frames[index], replay.frames[index + 1], time);
}

/**
 * Collects press-to-centre distances only for successful circle/head judgements
 * that the Stable evaluator explicitly assigned. Misses and whole-slider
 * outcomes are excluded because their nearest input is ambiguous.
 */
export function collectReplayAimEvidence(
  beatmap: Beatmap,
  replay: OsuReplay,
  events: readonly ReplayAnalysisEvent[],
  excludedHitObjectIds: ReadonlySet<string> = new Set(),
): ReplayAimEvidence {
  if (replay.mods.includes("AUTO_PLAY") || replay.mods.includes("AUTO_PILOT")) {
    return {
      samples: [],
      eligibleEventCount: 0,
      unavailableReason: "Aim is automated by the loaded replay's mods.",
    };
  }
  if (replay.frames.length === 0) {
    return { samples: [], eligibleEventCount: 0, unavailableReason: "The replay contains no cursor frames." };
  }

  const samples: AimDistanceSample[] = [];
  const seen = new Set<string>();
  let eligibleEventCount = 0;
  for (const event of events) {
    if (
      event.type !== "HitObjectJudgement" ||
      event.verdict === "MISS" ||
      event.ruleset === "lazer" ||
      excludedHitObjectIds.has(event.hitObjectId) ||
      seen.has(event.hitObjectId)
    ) {
      continue;
    }

    let hitObject: ReturnType<Beatmap["getHitObject"]>;
    try {
      hitObject = beatmap.getHitObject(event.hitObjectId);
    } catch {
      continue;
    }
    if (!(hitObject instanceof HitCircle)) continue;
    seen.add(event.hitObjectId);
    eligibleEventCount++;
    const time = event.judgementTime ?? event.time;
    const cursor = positionAt(replay, time);
    if (!cursor) continue;
    samples.push({
      hitObjectId: event.hitObjectId,
      time,
      distance: Math.hypot(cursor.x - hitObject.position.x, cursor.y - hitObject.position.y),
      objectRadius: hitObject.radius,
    });
  }

  return {
    samples,
    eligibleEventCount,
    unavailableReason:
      samples.length === 0 ? "No successful assigned circle/head inputs had usable cursor evidence." : undefined,
  };
}
