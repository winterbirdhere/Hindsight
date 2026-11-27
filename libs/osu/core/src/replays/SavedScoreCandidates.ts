import { Beatmap } from "../beatmap/Beatmap";
import { stableHitWindowsForOD } from "../gameplay/StableDifficulty";
import { StableSliderTiming } from "../gameplay/StableSliderTiming";
import { SavedScoreCandidate, SavedScoreGrade } from "./SavedScoreTimeline";
import { isHitCircle, isSlider } from "../hitobjects/Types";

/**
 * Candidate constraints only: no simulation verdict, judgement order or desired
 * label is available here. Bounds are conservative for source gaps; the caller
 * still owns source/profile admission and the saved timeline's provenance check.
 */
export function stableSavedScoreCandidates(
  beatmap: Beatmap,
  frames: readonly { time: number }[],
): SavedScoreCandidate[] {
  if (!frames.length || frames.some((f, i) => !Number.isFinite(f.time) || (i > 0 && f.time < frames[i - 1].time)))
    return [];
  const nextFrame = (time: number, strict = false) => {
    let low = 0;
    let high = frames.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (strict ? frames[mid].time <= time : frames[mid].time < time) low = mid + 1;
      else high = mid;
    }
    return frames[low]?.time;
  };
  const end = frames[frames.length - 1].time;
  const windows = stableHitWindowsForOD(beatmap.stableOverallDifficulty);
  const candidates: SavedScoreCandidate[] = [];
  for (const object of beatmap.hitObjects) {
    if (isHitCircle(object)) {
      const earliestTime = object.hitTime - Math.max(object.approachDuration, windows[3]);
      const latestTime = nextFrame(object.hitTime + windows[2] + 2) ?? end;
      if (latestTime < earliestTime) continue;
      const gradeTimeRanges: Partial<Record<SavedScoreGrade, readonly [number, number]>> = {};
      (["GREAT", "OK", "MEH"] as const).forEach((grade, i) => {
        gradeTimeRanges[grade] = [object.hitTime - windows[i], object.hitTime + windows[i]];
      });
      candidates.push({
        componentId: object.id,
        kind: "circle",
        earliestTime,
        latestTime,
        gradeTimeRanges,
        gradeTimeExclusions: {
          OK: [object.hitTime - windows[0], object.hitTime + windows[0]],
          MEH: [object.hitTime - windows[1], object.hitTime + windows[1]],
        },
      });
    } else {
      const deadline = isSlider(object) ? new StableSliderTiming(object).endTime : object.endTime;
      const update = nextFrame(deadline, object.type === "SPINNER");
      if (update === undefined) continue;
      candidates.push({
        componentId: object.id,
        kind: object.type === "SLIDER" ? "slider-parent" : "spinner",
        earliestTime: Math.floor(deadline),
        latestTime: Math.max(deadline, update),
      });
    }
  }
  return candidates;
}
