import { Beatmap, HitCircle, ReplayAnalysisEvent, Slider } from "@osujs/core";
import type { OsuReplay } from "../../model/OsuReplay";
import { positionAt } from "./aim-consistency";

export interface FullMapAimPoint {
  time: number;
  x: number;
  y: number;
  verdict: "GREAT" | "OK" | "MEH";
}

export interface FullMapAimScatter {
  available: boolean;
  unavailableReason?: string;
  /** Offsets from the circle's centre in circle radii, turned so the movement into the object runs along +x. */
  points: FullMapAimPoint[];
  mean: { x: number; y: number } | null;
  /** Successful hits that had a cursor position but no movement direction. Misses are not counted here. */
  omittedCount: number;
  /** Missed circles / slider heads that had no cursor position or no movement direction, so have no ring. */
  omittedMissCount: number;
  /**
   * Every missed circle / slider head: the cursor when the note was due. Same axes and units, true offsets. Empty when
   * the scatter is unavailable: the placed misses are not returned then, only the count of those not placed.
   */
  misses: { time: number; x: number; y: number }[];
}

// Closer than this the two centres are a stack, and "the way in" is not defined.
const MIN_DIRECTION_DISTANCE = 1;

function unavailable(unavailableReason: string): FullMapAimScatter {
  return {
    available: false,
    unavailableReason,
    points: [],
    mean: null,
    omittedCount: 0,
    omittedMissCount: 0,
    misses: [],
  };
}

/**
 * Where the cursor was at each successful circle / slider-head hit, relative to the circle and its approach, and
 * where it was when each missed one was due.
 */
export function collectFullMapAimScatter(
  beatmap: Beatmap,
  replay: OsuReplay,
  events: readonly ReplayAnalysisEvent[],
): FullMapAimScatter {
  if (replay.mods.includes("AUTO_PLAY") || replay.mods.includes("AUTO_PILOT")) {
    return unavailable("Aim is automated by the loaded replay's mods.");
  }
  if (replay.frames.length === 0) return unavailable("The replay contains no cursor frames.");

  // A circle, or a slider and its head, to the object that comes before it in the map.
  const previousById = new Map<string, Beatmap["hitObjects"][number] | undefined>();
  beatmap.hitObjects.forEach((hitObject, index) => {
    const previous = beatmap.hitObjects[index - 1];
    previousById.set(hitObject.id, previous);
    if (hitObject instanceof Slider) previousById.set(hitObject.head.id, previous);
  });

  const points: FullMapAimPoint[] = [];
  // Objects with a hit event; a hit wins over a miss for the same object, whichever event comes first.
  const seen = new Set<string>();
  const misses: FullMapAimScatter["misses"] = [];
  // Each missed object once: its ring, or null when it could not be placed.
  const missOf = new Map<string, FullMapAimScatter["misses"][number] | null>();
  let omittedCount = 0;
  let omittedMissCount = 0;
  for (const event of events) {
    // Lazer judgements are kept: they carry the press's own time in the replay's time base.
    if (event.type !== "HitObjectJudgement" || seen.has(event.hitObjectId)) continue;
    const verdict = event.verdict;
    const missed = verdict === "MISS";
    if (missed && missOf.has(event.hitObjectId)) continue;

    let hitObject: ReturnType<Beatmap["getHitObject"]>;
    try {
      hitObject = beatmap.getHitObject(event.hitObjectId);
    } catch {
      continue;
    }
    if (!(hitObject instanceof HitCircle)) continue;
    if (missed) {
      missOf.set(event.hitObjectId, null);
    } else {
      seen.add(event.hitObjectId);
      // An earlier miss event for this object is withdrawn: it is never both a point and a ring.
      const withdrawn = missOf.get(event.hitObjectId);
      if (withdrawn) misses.splice(misses.indexOf(withdrawn), 1);
      else if (withdrawn === null) omittedMissCount--;
      missOf.delete(event.hitObjectId);
    }

    // A hit is where the press landed; a miss has no press, so the cursor is read when the note was due.
    const time = missed ? hitObject.hitTime : (event.judgementTime ?? event.time);
    const cursor = positionAt(replay, time);
    if (!cursor) {
      if (missed) omittedMissCount++;
      continue;
    }

    const previous = previousById.get(event.hitObjectId);
    const from =
      previous instanceof HitCircle ? previous.position : previous instanceof Slider ? previous.endPosition : undefined;
    const centre = hitObject.position;
    const radius = hitObject.radius;
    const dx = from ? centre.x - from.x : 0;
    const dy = from ? centre.y - from.y : 0;
    const distance = Math.hypot(dx, dy);
    if (!from || !(distance >= MIN_DIRECTION_DISTANCE) || !(radius > 0)) {
      if (missed) omittedMissCount++;
      else omittedCount++;
      continue;
    }

    const directionX = dx / distance;
    const directionY = dy / distance;
    const offsetX = cursor.x - centre.x;
    const offsetY = cursor.y - centre.y;
    const x = (offsetX * directionX + offsetY * directionY) / radius;
    const y = (-offsetX * directionY + offsetY * directionX) / radius;
    if (missed) {
      const miss = { time, x, y };
      misses.push(miss);
      missOf.set(event.hitObjectId, miss);
    } else points.push({ time, x, y, verdict });
  }

  if (points.length === 0) {
    return { ...unavailable("No hit had usable cursor evidence."), omittedCount, omittedMissCount };
  }
  return {
    available: true,
    points,
    mean: {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    },
    omittedCount,
    omittedMissCount,
    misses,
  };
}
