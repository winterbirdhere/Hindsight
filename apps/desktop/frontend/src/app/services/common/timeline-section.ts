/**
 * The timeline lane can show one stretch of the map instead of all of it: a section. These are the rules for making
 * one (a right-click's default, a right-drag's own), for making it longer or shorter, and for turning its pages as
 * the playhead moves on. Undefined always means the whole map.
 */

export interface TimelineSection {
  startMs: number;
  endMs: number;
}

/** A section is never shorter than this. */
export const MIN_SECTION_MS = 2_000;
/** A right-drag chooses this much at most: past it a stretch is no longer a close look. Alt and the wheel can go on. */
export const MAX_DRAG_SECTION_MS = 30_000;
/** A right-click shows this many bars around the point. */
export const DEFAULT_SECTION_BARS = 8;
// Without timing a bar is taken as two seconds.
const UNTIMED_BAR_MS = 2_000;

export interface SectionContext {
  /** The map's timing points, in order. */
  timingPoints: readonly { time: number; beatLength: number; beatsPerBar?: number }[];
  /** The times of the errors on the timeline, in order. */
  errorTimes: readonly number[];
  durationMs: number;
  /** How near the point an error has to be to count as pointed at: a few pixels of the lane, in milliseconds. */
  nearMs: number;
}

/** Moves a stretch inside the map without changing its length; undefined when it covers the whole map. */
function fit(startMs: number, endMs: number, durationMs: number): TimelineSection | undefined {
  const length = endMs - startMs;
  if (!(durationMs > 0) || length >= durationMs) return undefined;
  const start = Math.min(Math.max(startMs, 0), durationMs - length);
  return { startMs: start, endMs: start + length };
}

/**
 * What a right-click shows: eight bars around the point, starting on a bar line, so it follows the map's tempo. On
 * a run of errors (each within a bar of the next) it is wide enough to hold the whole run with a bar to spare.
 */
export function defaultSection(time: number, context: SectionContext): TimelineSection | undefined {
  const { timingPoints, errorTimes, durationMs, nearMs } = context;
  let point: SectionContext["timingPoints"][number] | undefined;
  for (const candidate of timingPoints) {
    if (candidate.time > time && point) break;
    point = candidate;
  }
  const bar = point ? point.beatLength * (point.beatsPerBar && point.beatsPerBar > 0 ? point.beatsPerBar : 4) : UNTIMED_BAR_MS;
  const length = DEFAULT_SECTION_BARS * bar;
  let from = time - length / 2;
  // Where the section has to reach at least, beyond its eight bars.
  let reach = -Infinity;

  let nearest = -1;
  errorTimes.forEach((error, index) => {
    if (Math.abs(error - time) <= nearMs && (nearest < 0 || Math.abs(error - time) < Math.abs(errorTimes[nearest] - time))) nearest = index;
  });
  if (nearest >= 0) {
    let first = nearest;
    let last = nearest;
    while (first > 0 && errorTimes[first] - errorTimes[first - 1] <= bar) first--;
    while (last < errorTimes.length - 1 && errorTimes[last + 1] - errorTimes[last] <= bar) last++;
    from = Math.min(from, errorTimes[first] - bar);
    reach = errorTimes[last] + bar;
  }
  // Start on the bar line at or before.
  if (point) from = point.time + Math.floor((from - point.time) / bar) * bar;
  return fit(from, Math.max(from + length, reach), durationMs);
}

/**
 * What a right-drag shows: the stretch that was dragged over, from two to thirty seconds of it. A longer drag keeps
 * the thirty seconds from where it began, in the direction it went.
 */
export function dragSection(aMs: number, bMs: number, durationMs: number): TimelineSection | undefined {
  const reach = Math.sign(bMs - aMs) * Math.min(Math.abs(bMs - aMs), MAX_DRAG_SECTION_MS);
  let from = Math.max(0, Math.min(aMs, aMs + reach));
  let to = Math.min(durationMs, Math.max(aMs, aMs + reach));
  if (to - from < MIN_SECTION_MS) {
    const middle = (from + to) / 2;
    from = middle - MIN_SECTION_MS / 2;
    to = middle + MIN_SECTION_MS / 2;
  }
  return fit(from, to, durationMs);
}

/**
 * Makes the section `factor` times as long, keeping the time under the pointer where it is on the lane. With no
 * section it starts from the whole map. It stops at two seconds, and is the whole map again once it is that long.
 */
export function zoomSection(section: TimelineSection | undefined, factor: number, anchorMs: number, durationMs: number): TimelineSection | undefined {
  const current = section ?? { startMs: 0, endMs: durationMs };
  const length = current.endMs - current.startMs;
  if (!(length > 0) || !(factor > 0)) return section;
  const next = Math.max(MIN_SECTION_MS, length * factor);
  const at = Math.min(Math.max((anchorMs - current.startMs) / length, 0), 1);
  const from = anchorMs - at * next;
  return fit(from, from + next, durationMs);
}

/** The section that holds the playhead: this one, or the page of the same length that does. */
export function pageSection(section: TimelineSection, time: number, durationMs: number): TimelineSection {
  if (time >= section.startMs && time <= section.endMs) return section;
  const length = section.endMs - section.startMs;
  const pages = Math.floor((time - section.startMs) / length);
  return fit(section.startMs + pages * length, section.endMs + pages * length, durationMs) ?? section;
}

/** Where a time is across the section: 0 at its start, 1 at its end. */
export const sectionFraction = (time: number, section: TimelineSection) => (time - section.startMs) / (section.endMs - section.startMs);
