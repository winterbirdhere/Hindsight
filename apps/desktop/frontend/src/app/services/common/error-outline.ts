import { HitCircle, isHitCircle, type Beatmap, type ReplayAnalysisEvent, type ReplayAnalysisRuleset } from "@osujs/core";
import type { Position } from "@osujs/math";
import { injectable } from "inversify";
import {
  nativeWithinHitRadius,
  stableGameplayRadius,
  stableWithinHitRadius,
} from "../../../../../../../libs/osu/core/src/gameplay/StableHitGeometry";
import type { AttributedTap } from "../analysis/attributed-taps";
import type { Incident } from "../analysis/incidents";
import type { ErrorOutlineMode } from "../analysis/replay-display-settings";
import type { ReplayError } from "../analysis/replay-events";
import { hexToNumber, REWIND_COLORS } from "../../styles/tokens";

/**
 * How long the ring stays after the error was judged: so many times the gap to the nearest object, so that it clears
 * sooner where the map is fast, no longer than the first and no shorter than the second of these. Then how long it
 * takes to fade out. Real time.
 */
export const ERROR_OUTLINE_HOLD_MS = 700;
export const ERROR_OUTLINE_MIN_HOLD_MS = 300;
export const ERROR_OUTLINE_HOLD_GAPS = 4;
export const ERROR_OUTLINE_FADE_MS = 200;
/**
 * When a later error's ring appears, an earlier one's trail and taps make way for it and its ring thins. That takes
 * as long as the two are apart, within these limits: real time.
 */
export const ERROR_OUTLINE_HANDOVER_MIN_MS = 60;
export const ERROR_OUTLINE_HANDOVER_MAX_MS = 150;
/**
 * The miss trail is the movement into the object: it starts at the object before it, no less and no more than this
 * long before the error. The longer limit is also how far back a slow movement may reach to be long enough to read.
 * Real time.
 */
export const MISS_TRAIL_MIN_LEAD_MS = 100;
export const MISS_TRAIL_LEAD_LIMIT_MS = 400;
/** The most an earlier tap may stretch the trail: real time. */
export const MISS_TRAIL_MAX_LEAD_MS = 1000;
/** A trail is this many object diameters long at least, as far as the samples within the limit go. */
export const MISS_TRAIL_MIN_DIAMETERS = 2;
const MISS_TRAIL_MAX_POINTS = 512;
// An error's time and its object's can differ by a rounding; nearer than this, an object is the error's own.
const SAME_OBJECT_MS = 1;

/** One recorded cursor sample of a miss trail. */
export interface TrailPoint extends Position {
  time: number;
}

/** A tap of the error's own object, as the analysis attributes it. */
export interface ErrorOutlineTap {
  position: Position;
  time: number;
  certainty: AttributedTap["certainty"];
  /** Real milliseconds after (+) or before (−) the object's time, as the player experienced them. */
  offsetMs: number;
  /** How far outside the circle the tap landed, in osu! pixels, by the game's own hit test; absent for a tap on it. */
  outsideBy?: number;
  /**
   * What is written beside the tap: the distance for a tap outside the circle, its timing otherwise. An error has
   * one number, so of several taps only the one that came nearest to counting has a label.
   */
  label?: string;
}

/** What the miss trail is built from. The taps of an error come from the analysis, never from their timing. */
export interface MissTrailSource {
  /** The replay's cursor samples, oldest first. */
  frames: readonly { time: number; position: Position }[];
  /** Map milliseconds per real millisecond (1.5 with Double Time). */
  clockRate: number;
  /** Write each tap's offset beside it. */
  labels?: boolean;
  taps(error: ReplayError): readonly AttributedTap[];
  /**
   * What kind of cause the analysis gives the error, if any. The cursor's path is kept for an aim cause and for an
   * error without a cause; for any other cause (a late tap, a notelock) it says nothing and is left out.
   */
  causeKind?(error: ReplayError): "aim" | "other" | undefined;
}

/**
 * As short as it can be. A tap outside the circle says how far (`0.5 px out`, `2 px out`): at one or two pixels no
 * marker can show that. A tap on the circle says when (`−43 ms`, `+43 ms`, `0 ms`). An ambiguous tap's ends in
 * `?`, so it never reads as a finding.
 */
function tapLabel(offsetMs: number, outsideBy: number | undefined, certainty: AttributedTap["certainty"]): string {
  const doubt = certainty === "ambiguous" ? " ?" : "";
  if (outsideBy !== undefined) {
    const shown = outsideBy < 9.95 ? Math.max(0.1, Math.round(outsideBy * 10) / 10) : Math.round(outsideBy);
    return `${shown} px out${doubt}`;
  }
  const sign = offsetMs > 0 ? "+" : offsetMs < 0 ? "−" : "";
  return `${sign}${Math.abs(offsetMs)} ms${doubt}`;
}

/** The circle a tap is measured against: where it is, its radius and whose hit test applies. */
interface HitCircleGeometry {
  centre: Position;
  radius: number;
  ruleset: ReplayAnalysisRuleset;
}

/**
 * How far outside the circle a tap landed, measured as the miss analysis measures it: the ruleset's own hit test
 * decides inside or outside (Stable allows 1.00041 of the radius and compares in single precision).
 */
function distanceOutside(tap: Position, circle: HitCircleGeometry): number | undefined {
  const stable = circle.ruleset === "stable";
  const hitRadius = Math.fround(stable ? stableGameplayRadius(circle.radius) : circle.radius);
  if ((stable ? stableWithinHitRadius : nativeWithinHitRadius)(tap, circle.centre, hitRadius)) return undefined;
  const dx = stable ? Math.fround(tap.x) - Math.fround(circle.centre.x) : tap.x - circle.centre.x;
  const dy = stable ? Math.fround(tap.y) - Math.fround(circle.centre.y) : tap.y - circle.centre.y;
  return Math.max(0, Math.hypot(dx, dy) - hitRadius);
}

/** One ring on the playfield, around an error's object, with the miss trail that goes with it. */
export interface ErrorOutlineTarget {
  errorId: string;
  /** Light is for the other errors of the inspected incident; everything else is drawn in full. */
  emphasis: "full" | "light";
  color: number;
  /** Where the error was judged, in osu! pixels: the object, or the point of a slider that broke. */
  position: Position;
  /** The object's radius in osu! pixels. */
  radius: number;
  /**
   * When the ring appears: the error's judgement, which is when the game itself shows the miss. Never the object's
   * own time, while it can still be hit and is still being read.
   */
  appearTime: number;
  /** From when the ring is held: the judgement as well. */
  holdFrom: number;
  /** How long the ring is held, in real milliseconds as the map was played. */
  holdMs: number;
  /**
   * All mode only: the error appeared while the one before it was still held, so it is part of a run that another
   * error started. Only the first error of a run is outlined; a follower is, when it is the one inspected.
   */
  follower?: true;
  /**
   * From when this error makes way for the next outlined one: when that one's ring appears, or when this one's own
   * trail and taps are all there, whichever is later. Absent for the last one.
   */
  supersededAt?: number;
  /** The main hit object whose mark in the key overlay takes the colour. */
  markObjectId: string;
  /** The cursor's recorded path into the error, oldest first; empty while the miss trail is off. */
  trail: readonly TrailPoint[];
  /** The taps the analysis attributes to this object; empty when it names none or the miss trail is off. */
  taps: readonly ErrorOutlineTap[];
}

// The colours of the incident list and the timeline marks.
const MISS_COLOR = hexToNumber(REWIND_COLORS.judgementMiss);
const SLIDER_COLOR = hexToNumber(REWIND_COLORS.sliderBreak);

type Judged = Extract<ReplayAnalysisEvent, { type: "HitObjectJudgement" | "SliderBreak" | "SliderComponentMiss" }>;

/** The simulator event each error was made from (see `summarizeReplayEvents`), by error id, in the ruleset in view. */
function sourceEvents(events: readonly ReplayAnalysisEvent[], ruleset: ReplayAnalysisRuleset): Map<string, Judged> {
  const byErrorId = new Map<string, Judged>();
  // The first event wins, as it does where the errors are made.
  const add = (errorId: string, event: Judged) => void (byErrorId.has(errorId) || byErrorId.set(errorId, event));
  for (const event of events) {
    if (event.ruleset !== undefined && event.ruleset !== ruleset) continue;
    if (event.type === "HitObjectJudgement") {
      const counts = event.affectsAccuracy !== false && !(event.isSliderHead && event.ruleset !== "lazer");
      if (event.verdict === "MISS" && counts) add(`miss:${event.hitObjectId}`, event);
    } else if (event.type === "SliderBreak" || event.type === "SliderComponentMiss") {
      add(event.eventId, event);
    }
  }
  return byErrorId;
}

interface Outlined {
  id: string;
  type: string;
  scale: number;
  sliderId?: string;
}

/** The recorded samples between two times, both included. Nothing is interpolated. */
function recordedSamples(frames: MissTrailSource["frames"], from: number, to: number): TrailPoint[] {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (frames[middle].time < from) low = middle + 1;
    else high = middle;
  }
  const points: TrailPoint[] = [];
  for (let index = low; index < frames.length && frames[index].time <= to; index++) {
    const { time, position } = frames[index];
    points.push({ x: position.x, y: position.y, time });
  }
  return points;
}

/** When every object of the beatmap starts and ends, in order: where a cursor can be coming from. */
function objectTimes(beatmap: Beatmap): number[] {
  const times: number[] = [];
  for (const object of beatmap.hitObjects) {
    if (isHitCircle(object)) times.push(object.hitTime);
    else times.push(object.startTime, object.endTime);
  }
  return times.sort((a, b) => a - b);
}

/** The earliest of the sorted times that is after `time`. */
function firstAfter(times: readonly number[], time: number): number | undefined {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] <= time) low = middle + 1;
    else high = middle;
  }
  return times[low];
}

/** The latest of the sorted times that is before `time`. */
function lastBefore(times: readonly number[], time: number): number | undefined {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle] < time) low = middle + 1;
    else high = middle;
  }
  return low > 0 ? times[low - 1] : undefined;
}

/** What a miss trail is measured against, beside the error itself. */
interface TrailContext {
  /** The end of the error's judgement: where the trail of an error without a tap of its own ends. */
  judgedAt: number;
  /** When the object before the error ended, if there is one. */
  previousTime: number | undefined;
  /** The object's radius in osu! pixels. */
  radius: number;
  circle: HitCircleGeometry | undefined;
}

function missTrail(
  error: ReplayError,
  source: MissTrailSource | undefined,
  context: TrailContext,
): Pick<ErrorOutlineTarget, "trail" | "taps"> {
  if (!source) return { trail: [], taps: [] };
  const { judgedAt, previousTime, radius, circle } = context;
  const rate = source.clockRate > 0 ? source.clockRate : 1;
  const taps = source.taps(error).map((tap): ErrorOutlineTap => {
    const offsetMs = Math.round((tap.timeMs - error.time) / rate);
    const outsideBy = circle ? distanceOutside(tap.position, circle) : undefined;
    return {
      position: { x: tap.position.x, y: tap.position.y },
      time: tap.timeMs,
      certainty: tap.certainty,
      offsetMs,
      ...(outsideBy !== undefined ? { outsideBy } : {}),
    };
  });
  if (source.labels && taps.length > 0) {
    // Two keys pressed for one note would write two numbers on top of each other. The one that says most is the
    // tap that came nearest to counting: one the analysis is sure of, then the least outside the circle, then the
    // nearest to the object's time.
    const rank = (tap: ErrorOutlineTap) => [tap.certainty === "attributed" ? 0 : 1, tap.outsideBy ?? 0, Math.abs(tap.offsetMs)];
    const nearest = taps.reduce((best, tap) => {
      const [a, b] = [rank(tap), rank(best)];
      const differs = a.findIndex((value, index) => value !== b[index]);
      return differs >= 0 && a[differs] < b[differs] ? tap : best;
    });
    nearest.label = tapLabel(nearest.offsetMs, nearest.outsideBy, nearest.certainty);
  }
  if (source.causeKind?.(error) === "other") return { trail: [], taps };
  // The trail ends where the player tapped for this object, so its end is where the cursor was then. Only a tap the
  // analysis attributes ends it; without one it runs to the end of the judgement.
  const attributed = taps.filter((tap) => tap.certainty === "attributed").map((tap) => tap.time);
  const until = attributed.length > 0 ? Math.max(...attributed) : judgedAt;
  // The movement into the object, within its limits; before a tap that came early there is still the shortest lead.
  const head = Math.min(error.time, until);
  const reach = head - MISS_TRAIL_LEAD_LIMIT_MS * rate;
  const lead = Math.min(Math.max(previousTime ?? reach, reach), head - MISS_TRAIL_MIN_LEAD_MS * rate);
  // Long enough to hold an earlier tap, within a limit.
  const wanted = Math.min(lead, ...taps.map((tap) => tap.time));
  const earliest = Math.max(Math.min(reach, wanted), error.time - MISS_TRAIL_MAX_LEAD_MS * rate);
  const samples = recordedSamples(source.frames, earliest, until);
  let start = samples.findIndex((sample) => sample.time >= wanted);
  if (start < 0) start = samples.length;
  // A slow movement covers too little of the playfield to read: reach back until it is long enough.
  const step = (index: number) => Math.hypot(samples[index + 1].x - samples[index].x, samples[index + 1].y - samples[index].y);
  let length = 0;
  for (let index = start; index < samples.length - 1; index++) length += step(index);
  const enough = MISS_TRAIL_MIN_DIAMETERS * 2 * radius;
  while (length < enough && start > 0 && samples[start - 1].time >= reach) {
    start--;
    if (start < samples.length - 1) length += step(start);
  }
  return { trail: samples.slice(start).slice(-MISS_TRAIL_MAX_POINTS), taps };
}

function target(
  error: ReplayError,
  emphasis: ErrorOutlineTarget["emphasis"],
  sources: ReadonlyMap<string, Judged>,
  beatmap: Beatmap,
  ruleset: ReplayAnalysisRuleset,
  trail: MissTrailSource | undefined,
  times: readonly number[],
  rate: number,
): ErrorOutlineTarget | undefined {
  if (error.type === "ANALYSIS_ERROR") return undefined;
  const objectId = error.type === "MISS" ? error.hitObjectId : error.sliderId;
  const object = objectId === undefined ? undefined : (beatmap.getHitObject(objectId) as Outlined | undefined);
  // A spinner has no circle to outline; an unknown object has no place to draw at.
  if (!object || (object.type !== "HIT_CIRCLE" && object.type !== "SLIDER")) return undefined;
  const event = sources.get(error.id);
  if (!event) return undefined;
  const judgedAt = event.time;
  const position = { x: event.position.x, y: event.position.y };
  const radius = HitCircle.OBJECT_RADIUS * object.scale;
  // A tap is measured against a circle or a slider's head; elsewhere on a slider there is no circle to be outside of.
  const judgedOnCircle =
    object.type === "HIT_CIRCLE" || (event.type !== "HitObjectJudgement" && event.componentType === "HEAD");
  const circle = judgedOnCircle ? { centre: position, radius, ruleset } : undefined;
  const previousTime = lastBefore(times, error.time - SAME_OBJECT_MS);
  const nextTime = firstAfter(times, error.time + SAME_OBJECT_MS);
  const gaps = [previousTime === undefined ? undefined : error.time - previousTime, nextTime === undefined ? undefined : nextTime - error.time];
  const nearest = Math.min(...gaps.filter((gap): gap is number => gap !== undefined));
  const holdMs = Math.min(Math.max((ERROR_OUTLINE_HOLD_GAPS * nearest) / rate, ERROR_OUTLINE_MIN_HOLD_MS), ERROR_OUTLINE_HOLD_MS);
  return {
    errorId: error.id,
    emphasis,
    color: error.type === "MISS" ? MISS_COLOR : SLIDER_COLOR,
    position,
    radius,
    appearTime: judgedAt,
    holdFrom: judgedAt,
    holdMs,
    markObjectId: object.sliderId ?? object.id,
    ...missTrail(error, trail, { judgedAt, previousTime, radius, circle }),
  };
}

/**
 * Marks the followers of each run: an error that appears while the error before it is still held. A run goes on from
 * one error to the next, so a long chain of errors has one ring, where it started. `rate` is map milliseconds per
 * real millisecond.
 */
function withRuns(targets: ErrorOutlineTarget[], rate: number): ErrorOutlineTarget[] {
  const order = targets.map((_entry, index) => index).sort((a, b) => targets[a].appearTime - targets[b].appearTime || a - b);
  const followers = new Set<number>();
  let heldUntil = -Infinity;
  for (const index of order) {
    const entry = targets[index];
    if (entry.appearTime <= heldUntil) followers.add(index);
    heldUntil = entry.holdFrom + entry.holdMs * rate;
  }
  return targets.map((entry, index) => (followers.has(index) ? { ...entry, follower: true as const } : entry));
}

/**
 * Tells each target from when it makes way for the next one that is outlined. Targets that appear together stand
 * together, and none makes way before its own trail and taps have been shown.
 */
function withHandover(targets: ErrorOutlineTarget[]): ErrorOutlineTarget[] {
  const outlined = targets.filter((entry) => !entry.follower);
  const appearTimes = [...new Set(outlined.map((entry) => entry.appearTime))].sort((a, b) => a - b);
  const next = new Map(appearTimes.slice(0, -1).map((time, index) => [time, appearTimes[index + 1]]));
  return targets.map((entry) => {
    const nextAppears = entry.follower ? undefined : next.get(entry.appearTime);
    if (nextAppears === undefined) return entry;
    const trailEnd = entry.trail.length > 0 ? entry.trail[entry.trail.length - 1].time : nextAppears;
    return { ...entry, supersededAt: Math.max(nextAppears, trailEnd, ...entry.taps.map((tap) => tap.time)) };
  });
}

/**
 * The rings to draw. Selected: the inspected error, then the other errors of its incident, lighter. All: every
 * error, whatever is inspected, with the followers of each run marked as such. An error whose object or judgement
 * cannot be found gets no ring.
 */
export function errorOutlineTargets(input: {
  mode: ErrorOutlineMode;
  errors: readonly ReplayError[];
  incidents: readonly Incident[];
  selectedIndex: number;
  events: readonly ReplayAnalysisEvent[];
  ruleset: ReplayAnalysisRuleset;
  beatmap: Beatmap | undefined;
  /** Map milliseconds per real millisecond (1.5 with Double Time); 1 when absent. */
  clockRate?: number;
  /** Absent while the miss trail is off. */
  trail?: MissTrailSource;
}): ErrorOutlineTarget[] {
  const { mode, errors, incidents, selectedIndex, events, ruleset, beatmap, trail } = input;
  const rate = input.clockRate !== undefined && input.clockRate > 0 ? input.clockRate : 1;
  if (mode === "off" || !beatmap) return [];
  const present = (entry: ErrorOutlineTarget | undefined): entry is ErrorOutlineTarget => entry !== undefined;
  const sources = sourceEvents(events, ruleset);
  const times = objectTimes(beatmap);
  const outline = (error: ReplayError, emphasis: ErrorOutlineTarget["emphasis"]) =>
    target(error, emphasis, sources, beatmap, ruleset, trail, times, rate);
  if (mode === "all") return withHandover(withRuns(errors.map((error) => outline(error, "full")).filter(present), rate));
  const selected = errors[selectedIndex];
  if (!selected) return [];
  const members = incidents.find((incident) => incident.errorIndices.includes(selectedIndex))?.errorIndices ?? [];
  const targets: Array<ErrorOutlineTarget | undefined> = [outline(selected, "full")];
  for (const index of members) {
    const member = errors[index];
    if (index !== selectedIndex && member) targets.push(outline(member, "light"));
  }
  return withHandover(targets.filter(present));
}

/**
 * The ring's opacity at a map time: there at once when it appears, held, then faded out. `holdMs` and `fadeMs` are
 * in map time: the real-time constants above times the playback rate, so the ring lasts as long on screen at any
 * speed.
 */
export function errorOutlineAlpha(time: number, target: ErrorOutlineTarget, holdMs: number, fadeMs: number): number {
  const end = target.holdFrom + holdMs;
  if (time < target.appearTime || time >= end + fadeMs) return 0;
  if (time <= end || fadeMs <= 0) return 1;
  return 1 - (time - end) / fadeMs;
}

/**
 * How far an earlier error has made way for the next one at a map time: 0 until it starts to, 1 once it has. It
 * takes as long as the earlier error had been shown by then, within `minMs` and `maxMs`: map time, like `holdMs`
 * above.
 */
export function errorOutlineHandover(time: number, target: ErrorOutlineTarget, minMs: number, maxMs: number): number {
  const { supersededAt } = target;
  if (supersededAt === undefined || time <= supersededAt) return 0;
  const duration = Math.min(Math.max(supersededAt - target.appearTime, minMs), maxMs);
  return duration > 0 ? Math.min(1, (time - supersededAt) / duration) : 1;
}

/**
 * The colour the key overlay gives each error's object mark, by main hit object id: every error of the replay,
 * whatever the outline on the playfield is set to. A slider is marked for an error anywhere on it; where an object
 * has a miss and a slider break, it is the miss's colour. Spinners and unknown objects have no mark.
 */
export function errorMarks(errors: readonly ReplayError[], beatmap: Beatmap | undefined): Map<string, number> {
  const marks = new Map<string, number>();
  if (!beatmap) return marks;
  for (const error of errors) {
    if (error.type === "ANALYSIS_ERROR") continue;
    const objectId = error.type === "MISS" ? error.hitObjectId : error.sliderId;
    const object = objectId === undefined ? undefined : (beatmap.getHitObject(objectId) as Outlined | undefined);
    if (!object || (object.type !== "HIT_CIRCLE" && object.type !== "SLIDER")) continue;
    const markObjectId = object.sliderId ?? object.id;
    if (error.type === "MISS" || !marks.has(markObjectId)) marks.set(markObjectId, error.type === "MISS" ? MISS_COLOR : SLIDER_COLOR);
  }
  return marks;
}

/** What the renderers draw from: the playfield's rings, and the key overlay's marks. */
@injectable()
export class ErrorOutlineStore {
  targets: readonly ErrorOutlineTarget[] = [];
  /** The colour of each outlined object's key overlay mark, by main hit object id. */
  marks: ReadonlyMap<string, number> = new Map();
  /** The error under inspection, if any: it keeps its trail and taps when a later error appears. */
  inspectedErrorId: string | undefined = undefined;

  setTargets(targets: readonly ErrorOutlineTarget[]) {
    this.targets = targets;
  }

  /** The key overlay's marks have a setting of their own and do not follow the rings. */
  setMarks(marks: ReadonlyMap<string, number>) {
    this.marks = marks;
  }

  setInspected(errorId: string | undefined) {
    this.inspectedErrorId = errorId;
  }
}
