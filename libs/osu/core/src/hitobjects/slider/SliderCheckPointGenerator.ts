import { clamp } from "@osujs/math";
import { SliderCheckPointDescriptor } from "./SliderCheckPointDescriptor";

function* generateTicks(
  spanIndex: number,
  spanStartTime: number,
  spanDuration: number,
  reversed: boolean,
  length: number,
  tickDistance: number,
  minDistanceFromEnd: number,
): IterableIterator<SliderCheckPointDescriptor> {
  for (let d = tickDistance; d <= length; d += tickDistance) {
    if (d >= length - minDistanceFromEnd) {
      break;
    }
    const spanProgress = d / length;
    const timeProgress = reversed ? 1.0 - spanProgress : spanProgress;
    yield {
      type: "TICK",
      spanIndex,
      spanStartTime,
      time: spanStartTime + timeProgress * spanDuration,
      spanProgress,
    };
  }
}

export function* generateSliderCheckpoints(
  startTime: number,
  spanDuration: number,
  velocity: number,
  tickDistance: number,
  totalDistance: number,
  spanCount: number,
  legacyLastTickOffset = 36,
): IterableIterator<SliderCheckPointDescriptor> {
  const length = Math.min(100000.0, totalDistance);
  tickDistance = clamp(tickDistance, 0.0, length);
  const minDistanceFromEnd = velocity * 10;

  // A work budget, not a gameplay limit: reject pathological imported data
  // before allocating its checkpoint array. One million components per slider
  // comfortably covers the decoder's 9,000-span allowance for ordinary paths.
  const estimatedTicks = tickDistance > 0 ? Math.ceil(length / tickDistance) : 0;
  if (!Number.isFinite(spanCount) || (estimatedTicks + 1) * spanCount > 1_000_000) {
    throw new Error("Slider checkpoint work limit exceeded");
  }

  // Generating ticks
  // Using `floatEqual` was my suggestion, but osu!lazer uses tickDistance != 0
  for (let span = 0; span < spanCount; span++) {
    const spanStartTime = startTime + span * spanDuration;
    const reversed: boolean = span % 2 === 1;

    if (tickDistance !== 0) {
      const it = generateTicks(span, spanStartTime, spanDuration, reversed, length, tickDistance, minDistanceFromEnd);

      // Don't flame me for this
      const ticks: SliderCheckPointDescriptor[] = [];
      for (const t of it) ticks.push(t);
      if (reversed) ticks.reverse();
      for (const t of ticks) yield t;
    }

    // Repeats are independent of tick generation in the official event generator.
    if (span < spanCount - 1) {
      yield {
        type: "REPEAT",
        spanIndex: span,
        spanStartTime,
        time: spanStartTime + spanDuration,
        spanProgress: (span + 1) % 2,
      };
    }
  }

  const totalDuration = spanCount * spanDuration;
  const finalSpanIndex = spanCount - 1;
  const finalSpanStartTime = startTime + finalSpanIndex * spanDuration;
  const finalSpanEndTime = Math.max(
    startTime + totalDuration / 2.0,
    finalSpanStartTime + spanDuration - legacyLastTickOffset,
  );
  let finalProgress = (finalSpanEndTime - finalSpanStartTime) / spanDuration;
  if (spanCount % 2 === 0) finalProgress = 1.0 - finalProgress;
  yield {
    type: "LAST_LEGACY_TICK",
    spanIndex: finalSpanIndex,
    spanStartTime: finalSpanStartTime,
    time: finalSpanEndTime,
    spanProgress: finalProgress,
  };

  // The actual native-lazer tail is not part of this Stable-compatible
  // checkpoint list. LazerGameStateEvaluator models it separately with its
  // 150-point accuracy weight and combo semantics.

  // yield {
  //   type: SliderCheckPointType.TAIL,
  //   spanIndex: finalSpanIndex,
  //   spanStartTime: startTime + (spanCount - 1) * spanDuration,
  //   time: startTime + totalDuration,
  //   pathProgress: spanCount % 2
  // };
}
