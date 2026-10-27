import { BeatmapDifficulty } from "../beatmap/BeatmapDifficulty";
import { DifficultyControlPoint } from "../beatmap/ControlPoints/DifficultyControlPoint";
import { TimingControlPoint } from "../beatmap/ControlPoints/TimingControlPoint";
import { Slider } from "../hitobjects/Slider";
import { SliderCheckPoint } from "../hitobjects/SliderCheckPoint";
import { stableSliderPathGeometry } from "./StableSliderPathGeometry";
import { Position, Vec2 } from "@osujs/math";

/** Stable rounds inherited beat length before calculating its source slider speed. */
export function stableSliderTimingParameters(
  difficulty: BeatmapDifficulty,
  timingPoint: TimingControlPoint,
  difficultyPoint: DifficultyControlPoint,
): { speed: number; tickDistance: number; baseTickDistance: number } {
  const inheritedBeatLength = difficultyPoint.sourceBeatLength ?? -100 / difficultyPoint.speedMultiplier;
  // Stable's x86 JIT retains extended precision through the division and
  // float-returning call before promotion to double. The negative beat length
  // is rounded to float; rounding the final ratio again changes real deadlines.
  const multiplier =
    inheritedBeatLength < 0 ? Math.min(1000, Math.max(10, Math.fround(-inheritedBeatLength))) / 100 : 1;
  const tickRate = Math.max(0.5, Math.min(8, difficulty.sliderTickRate));
  const scoringDistance = (100 * Math.max(0.4, Math.min(3.6, difficulty.sliderMultiplier))) / tickRate;
  const effectiveBeatLength = timingPoint.beatLength * multiplier;
  return {
    speed: scoringDistance * tickRate * (effectiveBeatLength > 0 ? 1000 / effectiveBeatLength : 1),
    tickDistance: scoringDistance / multiplier,
    baseTickDistance: scoringDistance,
  };
}

/** Stable source topology and deadlines, separate from the native Lazer checkpoint list. */
export class StableSliderTiming {
  readonly endTime: number;
  readonly checkPoints: SliderCheckPoint[];
  private readonly checkpointTimes = new Map<string, number>();

  constructor(private readonly slider: Slider) {
    const speed = slider.stableTiming?.speed ?? slider.velocity * 1000;
    const { points, lengths } = stableSliderPathGeometry(slider);
    const distance = lengths.reduce((sum, length) => sum + length, 0);
    const sourceTickDistance =
      slider.stableGeometryVersion < 8
        ? slider.stableTiming?.baseTickDistance ?? slider.tickDistance
        : slider.stableTiming?.tickDistance ?? slider.tickDistance;
    const tickDistance = Math.min(sourceTickDistance, slider.path.distance);
    const timeForDistance = (distance: number) => Math.trunc(slider.startTime + (Math.fround(distance) / speed) * 1000);
    const ticksBySpan: { time: number; offset: Position; spanProgress: number }[][] = [];
    const spanEnds: number[] = [];
    const spanStarts: number[] = [];
    let time = slider.startTime;
    let checkpointDistance = 0;
    let distanceSinceTick = 0;
    for (let span = 0; span < slider.spanCount; span++) {
      const ticks: { time: number; offset: Position; spanProgress: number }[] = [];
      spanStarts.push(Math.trunc(time));
      let remaining = distance;
      let tickTooCloseToEnd = false;
      let travelled = 0;
      const reversed = span % 2 === 1;
      for (let step = 0; step < lengths.length; step++) {
        const index = reversed ? lengths.length - step - 1 : step;
        const length = lengths[index];
        // Stable's x86 JIT retains the product until its promotion to double.
        time += (1000 * length) / speed;
        distanceSinceTick += length;
        travelled += length;
        while (tickDistance > 0 && distanceSinceTick >= tickDistance && !tickTooCloseToEnd) {
          checkpointDistance += tickDistance;
          distanceSinceTick -= tickDistance;
          remaining -= tickDistance;
          tickTooCloseToEnd = remaining <= 0.01 * speed;
          if (!tickTooCloseToEnd) {
            const from = points[reversed ? index + 1 : index];
            const to = points[reversed ? index : index + 1];
            const segmentDistance = Math.fround(Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2));
            const progress =
              segmentDistance > 0 ? Math.fround(1 - Math.fround(distanceSinceTick / segmentDistance)) : 1;
            const position = Vec2.interpolate(from, to, progress);
            const spanProgress = distance > 0 ? (travelled - distanceSinceTick) / distance : 0;
            ticks.push({
              time: timeForDistance(checkpointDistance),
              offset: Vec2.sub(position, slider.head.unstackedPosition),
              spanProgress: reversed ? 1 - spanProgress : spanProgress,
            });
          }
        }
      }
      checkpointDistance += distanceSinceTick;
      spanEnds.push(timeForDistance(checkpointDistance));
      ticksBySpan.push(ticks);
      // Stable carries the residual tick distance through each reversal.
      // Replacing these operations with a product changes boundary rounding.
      if (tickTooCloseToEnd) distanceSinceTick = 0;
      else {
        checkpointDistance -= tickDistance - distanceSinceTick;
        distanceSinceTick = tickDistance - distanceSinceTick;
      }
    }
    this.endTime = slider.stableTiming ? Math.trunc(time) : Math.trunc(slider.endTime);
    if (!slider.stableTiming) {
      this.checkPoints = slider.checkPoints;
      return;
    }
    this.checkPoints = [];
    const matchedNativePoints = new Set<SliderCheckPoint>();
    // Float geometry can add or remove ticks at the ten-millisecond cutoff.
    // Match by component meaning, never by the flattened checkpoint index.
    const append = (
      type: SliderCheckPoint["type"],
      span: number,
      ordinal: number,
      deadline: number,
      offset: Position,
      spanProgress: number,
    ) => {
      const candidates = slider.checkPoints.filter(
        (point) => point.type === type && point.spanIndex === span && !matchedNativePoints.has(point),
      );
      // The old format may use a different tick grid, so the first source tick
      // need not be the first native tick. Match the path fraction, allowing
      // float construction drift only for identity; scoring uses source data.
      const matching =
        type === "TICK"
          ? candidates.find((point) => Math.abs(point.spanProgress - spanProgress) <= 0.00001)
          : candidates[0];
      if (matching) matchedNativePoints.add(matching);
      const checkpoint = matching ?? new SliderCheckPoint(slider);
      if (!matching) {
        checkpoint.id = `${slider.id}/STABLE/${type}/${span}/${ordinal}`;
        checkpoint.type = type;
        checkpoint.hitTime = deadline;
        checkpoint.spanIndex = span;
        checkpoint.spanStartTime = spanStarts[span];
        checkpoint.spanProgress = spanProgress;
        checkpoint.offset = offset;
      }
      this.checkPoints.push(checkpoint);
      this.checkpointTimes.set(checkpoint.id, deadline);
    };
    for (let span = 0; span < slider.spanCount; span++) {
      ticksBySpan[span].forEach((tick, index) =>
        append("TICK", span, index, tick.time, tick.offset, tick.spanProgress),
      );
      if (span < slider.spanCount - 1) {
        const progress = span % 2 === 0 ? 1 : 0;
        const position = points[progress ? points.length - 1 : 0] ?? slider.head.unstackedPosition;
        append("REPEAT", span, 0, spanEnds[span], Vec2.sub(position, slider.head.unstackedPosition), progress);
      }
    }
    const finalSpan = slider.spanCount - 1;
    const tailTime = Math.max(
      slider.startTime + Math.trunc((this.endTime - slider.startTime) / 2),
      spanEnds[finalSpan] - 36,
    );
    const tailProgress = slider.spanCount % 2 === 0 ? 0 : 1;
    const tailPosition = points[tailProgress ? points.length - 1 : 0] ?? slider.head.unstackedPosition;
    append(
      "LAST_LEGACY_TICK",
      finalSpan,
      0,
      tailTime,
      Vec2.sub(tailPosition, slider.head.unstackedPosition),
      tailProgress,
    );
  }

  checkpointTime(checkpoint: SliderCheckPoint): number {
    const { slider } = this;
    if (!slider.stableTiming) return Math.trunc(checkpoint.hitTime);
    const time = this.checkpointTimes.get(checkpoint.id);
    if (time === undefined) throw new Error(`Unknown Stable slider checkpoint ${checkpoint.id}`);
    return time;
  }
}
