/**
 * Where a step of the playhead lands. Four sizes: a note (the wheel), a nudge (the arrow keys), a frame
 * (with Ctrl) and a bar (with Shift). All of them are map times, so they are the same at every playback speed.
 */

/** What a note step follows: the notes themselves, or a fixed division of the beat as in the osu! editor. */
export const SCROLL_STEPS = ["auto", "1/1", "1/2", "1/3", "1/4", "1/6", "1/8"] as const;
export type ScrollStep = (typeof SCROLL_STEPS)[number];

/** A frame step never moves less than this, however densely the replay was recorded. */
export const MIN_FRAME_STEP_MS = 4;

/** A nudge (an arrow key) moves this far, whatever the notes and the timing are. */
export const NUDGE_STEP_MS = 30;

/** What the steps are measured on: one beatmap and one replay. */
export interface StepMap {
  /** When each note starts and ends, in order. */
  noteTimes: readonly number[];
  /** The map's timing points, in order. */
  timingPoints: readonly { time: number; beatLength: number; beatsPerBar?: number }[];
  /** The times of the replay's recorded frames, in order. */
  frameTimes: readonly number[];
  durationMs: number;
}

export type StepDirection = 1 | -1;
type TimingPoint = StepMap["timingPoints"][number];

// A playhead this near a line or a note is on it: seeking and rounding leave it a fraction of a millisecond off.
const ON_LINE_MS = 0.5;
// Without timing a beat is taken as a second.
const UNTIMED_BEAT_MS = 1_000;

/** The index of the last of the sorted values that is at most `limit`; -1 when there is none. */
function lastAtMost(values: readonly number[], limit: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] <= limit) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/** The index of the first of the sorted values that is at least `limit`; the length when there is none. */
function firstAtLeast(values: readonly number[], limit: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < limit) low = middle + 1;
    else high = middle;
  }
  return low;
}

const clamp = (time: number, map: StepMap) => Math.min(Math.max(time, 0), Math.max(map.durationMs, 0));

/** The timing point in force at a time; the first one before it starts, so its grid reaches back to the map's start. */
function timingAt(points: readonly TimingPoint[], time: number): number {
  return Math.max(
    0,
    lastAtMost(
      points.map((point) => point.time),
      time,
    ),
  );
}

/**
 * The next line of a grid in a direction. Each timing point starts its own grid, `unitOf` milliseconds apart, and the
 * grid of one section ends where the next begins. Undefined without timing points.
 */
function gridLine(time: number, direction: StepDirection, points: readonly TimingPoint[], unitOf: (point: TimingPoint) => number): number | undefined {
  if (points.length === 0) return undefined;
  if (direction > 0) {
    const index = timingAt(points, time + ON_LINE_MS);
    const point = points[index];
    const unit = unitOf(point);
    const line = point.time + (Math.floor((time - point.time + ON_LINE_MS) / unit) + 1) * unit;
    const next = points[index + 1];
    return next && line > next.time - ON_LINE_MS ? next.time : line;
  }
  const index = timingAt(points, time - ON_LINE_MS);
  const point = points[index];
  const unit = unitOf(point);
  return point.time + (Math.ceil((time - point.time - ON_LINE_MS) / unit) - 1) * unit;
}

const divisorOf = (step: Exclude<ScrollStep, "auto">) => Number(step.slice(2));

/**
 * A note step. Auto goes to the next or previous note, so it is right for any rhythm; where that note is more than a
 * beat away it moves to the next beat instead, so a break is not one jump. A fixed step is a division of the beat.
 */
export function noteStep(time: number, direction: StepDirection, step: ScrollStep, map: StepMap): number {
  const { timingPoints, noteTimes } = map;
  if (step !== "auto") {
    const line = gridLine(time, direction, timingPoints, (point) => point.beatLength / divisorOf(step));
    return clamp(line ?? time + direction * UNTIMED_BEAT_MS, map);
  }
  const beatLength = timingPoints.length > 0 ? timingPoints[timingAt(timingPoints, time + ON_LINE_MS)].beatLength : UNTIMED_BEAT_MS;
  const beat = gridLine(time, direction, timingPoints, (point) => point.beatLength) ?? time + direction * UNTIMED_BEAT_MS;
  const note =
    direction > 0
      ? noteTimes[lastAtMost(noteTimes, time + ON_LINE_MS) + 1]
      : noteTimes[lastAtMost(noteTimes, time - ON_LINE_MS)];
  const within = note !== undefined && Math.abs(note - time) <= beatLength + ON_LINE_MS;
  return clamp(within ? note : beat, map);
}

/** A frame step: to the next or previous frame the replay recorded, and never less than 4 ms away. */
export function frameStep(time: number, direction: StepDirection, map: StepMap): number {
  const { frameTimes } = map;
  const least = time + direction * MIN_FRAME_STEP_MS;
  const frame = direction > 0 ? frameTimes[firstAtLeast(frameTimes, least)] : frameTimes[lastAtMost(frameTimes, least)];
  return clamp(frame ?? least, map);
}

/** A nudge: a fixed 30 ms of map time, kept within the map. */
export function nudgeStep(time: number, direction: StepDirection, map: StepMap): number {
  return clamp(time + direction * NUDGE_STEP_MS, map);
}

/** A bar step: four beats, or as many as the timing point's time signature has. */
export function barStep(time: number, direction: StepDirection, map: StepMap): number {
  const line = gridLine(time, direction, map.timingPoints, (point) => point.beatLength * (point.beatsPerBar && point.beatsPerBar > 0 ? point.beatsPerBar : 4));
  return clamp(line ?? time + direction * 2 * UNTIMED_BEAT_MS, map);
}
