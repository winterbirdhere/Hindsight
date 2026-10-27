import { Position, Vec2 } from "@osujs/math";
import { Slider } from "../hitobjects/Slider";
import { stableSliderPathGeometry } from "./StableSliderPathGeometry";

type Segment = { start: number; end: number; from: Position; to: Position };

/** Stable tracks the ball against its integer-timed movement segments. */
export class StableSliderBallPath {
  private readonly segments: Segment[] = [];

  constructor(slider: Slider, speed = slider.stableTiming?.speed ?? slider.velocity * 1000) {
    const { points, lengths } = stableSliderPathGeometry(slider);
    const offset = Vec2.sub(slider.startPosition, slider.head.unstackedPosition);
    let time = slider.startTime;
    for (let span = 0; span < slider.spanCount; span++) {
      const reverse = span % 2 === 1;
      for (let j = 1; j < points.length; j++) {
        const i = reverse ? points.length - j : j;
        // The segment length is a float, but the x86 JIT keeps its *1000
        // product extended before accumulating duration as a double.
        const distance = lengths[i - 1];
        const duration = (1000 * distance) / speed;
        this.segments.push({
          start: Math.trunc(time),
          end: Math.trunc(time + duration),
          from: Vec2.add(offset, points[reverse ? i : i - 1]),
          to: Vec2.add(offset, points[reverse ? i - 1 : i]),
        });
        time += duration;
      }
    }
    if (this.segments.length === 0) {
      this.segments.push({
        start: slider.startTime,
        end: slider.startTime,
        from: slider.startPosition,
        to: slider.startPosition,
      });
    }
  }

  positionAt(time: number): Position {
    if (time < this.segments[0].start) return this.segments[0].from;
    let low = 0;
    let high = this.segments.length - 1;
    // At a shared integer endpoint Stable uses the first matching segment.
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.segments[middle].end < time) low = middle + 1;
      else high = middle;
    }
    const segment = this.segments[low];
    if (time >= segment.end || segment.start === segment.end) return segment.to;
    const progress = Math.fround(1 - Math.fround((segment.end - time) / (segment.end - segment.start)));
    return Vec2.interpolate(segment.from, segment.to, progress);
  }
}
