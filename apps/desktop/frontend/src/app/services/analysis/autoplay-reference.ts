import {
  Beatmap,
  HitObjectJudgement,
  isHitCircle,
  isSlider,
  isSpinner,
  MainHitObject,
  ReplayFrame,
  Slider,
} from "@osujs/core";
import type { Position } from "@osujs/math";
import {
  ComparisonParticipantLimitation,
  CursorExcludedTimeRange,
  ReplayComparisonParticipant,
} from "./replay-comparison";

export type AutoplayReferenceSampleKind =
  | "hit-circle-target"
  | "slider-head"
  | "slider-path"
  | "slider-checkpoint"
  | "slider-tail";

export interface AutoplayReferenceSample {
  time: number;
  position: Position;
  kind: AutoplayReferenceSampleKind;
  objectId: string;
  checkpointId?: string;
}

export type AutoplayReferenceLimitationCode =
  | "ANALYTIC_REFERENCE_ONLY"
  | "MAX_COMBO_UNAVAILABLE"
  | "SPINNER_TRAJECTORY_OMITTED"
  | "OVERLAPPING_OBJECTS"
  | "AMBIGUOUS_CURSOR_SAMPLE";

export interface AutoplayReferenceLimitation extends ComparisonParticipantLimitation {
  code: AutoplayReferenceLimitationCode;
}

export interface AnalyticAutoplayReference {
  participant: ReplayComparisonParticipant;
  samples: readonly AutoplayReferenceSample[];
  cursorExcludedRanges: readonly CursorExcludedTimeRange[];
  limitations: readonly AutoplayReferenceLimitation[];
  coverage: {
    perfectMainObjectJudgements: number;
    omittedSpinnerTrajectories: number;
    overlappingObjectPairs: number;
    ambiguousCursorTimes: number;
  };
}

export interface CreateAnalyticAutoplayReferenceOptions {
  beatmap: Beatmap;
  beatmapMd5: string;
  id?: string;
  label?: string;
  cursorSampleIntervalMs?: number;
  /** Supply only when sourced from a trusted difficulty calculation. */
  maxComboInput?: number | null;
}

interface OrderedSample extends AutoplayReferenceSample {
  order: number;
}

interface ObjectRange {
  id: string;
  startTime: number;
  endTime: number;
}

function copyPosition(position: Position): Position {
  return { x: position.x, y: position.y };
}

function objectRange(hitObject: MainHitObject): ObjectRange {
  if (isHitCircle(hitObject)) {
    return { id: hitObject.id, startTime: hitObject.hitTime, endTime: hitObject.hitTime };
  }
  return { id: hitObject.id, startTime: hitObject.startTime, endTime: hitObject.endTime };
}

function findOverlappingObjectPairs(hitObjects: readonly MainHitObject[]): Array<readonly [string, string]> {
  const ranges = hitObjects
    .map(objectRange)
    .filter((range) => Number.isFinite(range.startTime) && Number.isFinite(range.endTime))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  const active: ObjectRange[] = [];
  const overlaps: Array<readonly [string, string]> = [];

  for (const range of ranges) {
    for (let index = active.length - 1; index >= 0; index--) {
      if (active[index].endTime <= range.startTime) active.splice(index, 1);
    }
    for (const previous of active) {
      if (range.startTime < previous.endTime && range.endTime > previous.startTime) {
        overlaps.push([previous.id, range.id]);
      }
    }
    if (range.endTime > range.startTime) active.push(range);
  }
  return overlaps;
}

function perfectJudgement(hitObject: MainHitObject): HitObjectJudgement | undefined {
  if (isHitCircle(hitObject)) {
    return {
      type: "HitObjectJudgement",
      ruleset: "stable",
      eventId: `autoplay-reference:hit-object-judgement:${hitObject.id}`,
      time: hitObject.hitTime,
      objectTime: hitObject.hitTime,
      judgementTime: hitObject.hitTime,
      hitObjectId: hitObject.id,
      position: copyPosition(hitObject.position),
      verdict: "GREAT",
    };
  }
  if (isSlider(hitObject)) {
    return {
      type: "HitObjectJudgement",
      ruleset: "stable",
      eventId: `autoplay-reference:hit-object-judgement:${hitObject.id}`,
      time: hitObject.endTime,
      objectTime: hitObject.endTime,
      judgementTime: hitObject.endTime,
      hitObjectId: hitObject.id,
      position: copyPosition(hitObject.endPosition),
      verdict: "GREAT",
    };
  }
  if (isSpinner(hitObject)) {
    return {
      type: "HitObjectJudgement",
      ruleset: "stable",
      eventId: `autoplay-reference:hit-object-judgement:${hitObject.id}`,
      time: hitObject.endTime,
      objectTime: hitObject.endTime,
      judgementTime: hitObject.endTime,
      hitObjectId: hitObject.id,
      position: { x: 256, y: 192 },
      verdict: "GREAT",
    };
  }
  return undefined;
}

function sliderSamples(slider: Slider, sampleIntervalMs: number, add: (sample: Omit<OrderedSample, "order">) => void) {
  add({
    time: slider.startTime,
    position: copyPosition(slider.startPosition),
    kind: "slider-head",
    objectId: slider.id,
  });

  if (slider.duration > 0 && Number.isFinite(slider.duration)) {
    for (let time = slider.startTime; time <= slider.endTime; time += sampleIntervalMs) {
      add({
        time,
        position: copyPosition(slider.ballPositionAt((time - slider.startTime) / slider.duration)),
        kind: "slider-path",
        objectId: slider.id,
      });
    }
  }

  for (const checkpoint of slider.stableCheckPoints ?? slider.checkPoints) {
    add({
      time: checkpoint.hitTime,
      position: copyPosition(checkpoint.position),
      kind: "slider-checkpoint",
      objectId: slider.id,
      checkpointId: checkpoint.id,
    });
  }

  add({
    time: slider.endTime,
    position: copyPosition(slider.endPosition),
    kind: "slider-tail",
    objectId: slider.id,
  });
}

const samplePriority: Record<AutoplayReferenceSampleKind, number> = {
  "slider-checkpoint": 5,
  "hit-circle-target": 4,
  "slider-head": 4,
  "slider-tail": 3,
  "slider-path": 1,
};

function samePosition(a: Position, b: Position): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < 0.01;
}

function cursorFramesFromSamples(samples: readonly OrderedSample[]): {
  frames: ReplayFrame[];
  ambiguousTimes: Array<{ time: number; objectIds: string[] }>;
} {
  const groups = new Map<number, OrderedSample[]>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.time) || !Number.isFinite(sample.position.x) || !Number.isFinite(sample.position.y)) {
      continue;
    }
    const group = groups.get(sample.time);
    if (group) group.push(sample);
    else groups.set(sample.time, [sample]);
  }

  const frames: ReplayFrame[] = [];
  const ambiguousTimes: Array<{ time: number; objectIds: string[] }> = [];
  for (const time of Array.from(groups.keys()).sort((a, b) => a - b)) {
    const group = groups.get(time) as OrderedSample[];
    group.sort(
      (a, b) =>
        samplePriority[b.kind] - samplePriority[a.kind] || a.order - b.order || a.objectId.localeCompare(b.objectId),
    );
    const selected = group[0];
    if (group.some((sample) => !samePosition(sample.position, selected.position))) {
      ambiguousTimes.push({ time, objectIds: Array.from(new Set(group.map((sample) => sample.objectId))) });
    }
    frames.push({
      time,
      position: copyPosition(selected.position),
      actions: [],
    });
  }
  return { frames, ambiguousTimes };
}

/**
 * Builds an analytic, reference-only participant. It is intentionally not an
 * osu! Autoplay implementation: circles and slider paths are sampled from the
 * built beatmap, while spinner and overlapping-target uncertainty is exposed.
 */
export function createAnalyticAutoplayReference(
  options: CreateAnalyticAutoplayReferenceOptions,
): AnalyticAutoplayReference {
  const { beatmap } = options;
  const sampleIntervalMs = Math.max(1, options.cursorSampleIntervalMs ?? 16);
  const limitations: AutoplayReferenceLimitation[] = [
    {
      code: "ANALYTIC_REFERENCE_ONLY",
      message: "Autoplay is an analytic target trajectory, not a ruleset-authentic or uniquely correct human aim path",
    },
  ];
  if (options.maxComboInput === undefined || options.maxComboInput === null) {
    limitations.push({
      code: "MAX_COMBO_UNAVAILABLE",
      message: "Autoplay max combo is unavailable without a trusted difficulty-combo input",
    });
  }

  let order = 0;
  let omittedSpinnerTrajectories = 0;
  const events: HitObjectJudgement[] = [];
  const samples: OrderedSample[] = [];
  const cursorExcludedRanges: CursorExcludedTimeRange[] = [];
  const addSample = (sample: Omit<OrderedSample, "order">) => samples.push({ ...sample, order: order++ });

  for (const hitObject of beatmap.hitObjects) {
    const judgement = perfectJudgement(hitObject);
    if (judgement) events.push(judgement);

    if (isHitCircle(hitObject)) {
      addSample({
        time: hitObject.hitTime,
        position: copyPosition(hitObject.position),
        kind: "hit-circle-target",
        objectId: hitObject.id,
      });
    } else if (isSlider(hitObject)) {
      sliderSamples(hitObject, sampleIntervalMs, addSample);
    } else if (isSpinner(hitObject)) {
      omittedSpinnerTrajectories++;
      if (Number.isFinite(hitObject.startTime) && Number.isFinite(hitObject.endTime)) {
        cursorExcludedRanges.push({
          startTime: Math.min(hitObject.startTime, hitObject.endTime),
          endTime: Math.max(hitObject.startTime, hitObject.endTime),
          reason: "Analytic Autoplay does not claim a spinner cursor trajectory",
          objectId: hitObject.id,
        });
      }
    }
  }

  if (omittedSpinnerTrajectories > 0) {
    limitations.push({
      code: "SPINNER_TRAJECTORY_OMITTED",
      message: `${omittedSpinnerTrajectories} spinner${
        omittedSpinnerTrajectories === 1 ? " has" : "s have"
      } a perfect aggregate judgement, but no manufactured cursor trajectory`,
      objectIds: beatmap.hitObjects.filter(isSpinner).map((spinner) => spinner.id),
    });
  }

  const overlaps = findOverlappingObjectPairs(beatmap.hitObjects);
  if (overlaps.length > 0) {
    limitations.push({
      code: "OVERLAPPING_OBJECTS",
      message: `${overlaps.length} overlapping object pair${
        overlaps.length === 1 ? "" : "s"
      } cannot be represented as one uniquely ideal cursor path`,
      objectIds: Array.from(new Set(overlaps.slice(0, 50).flatMap((pair) => [...pair]))),
    });
  }

  events.sort(
    (a, b) => (a.objectTime ?? a.time) - (b.objectTime ?? b.time) || a.hitObjectId.localeCompare(b.hitObjectId),
  );
  samples.sort((a, b) => a.time - b.time || a.order - b.order);
  const { frames, ambiguousTimes } = cursorFramesFromSamples(samples);
  if (ambiguousTimes.length > 0) {
    limitations.push({
      code: "AMBIGUOUS_CURSOR_SAMPLE",
      message: `${ambiguousTimes.length} map time${
        ambiguousTimes.length === 1 ? " has" : "s have"
      } multiple target positions; one deterministic sample is retained and the trajectory is uncertain there`,
      objectIds: Array.from(new Set(ambiguousTimes.slice(0, 50).flatMap((sample) => sample.objectIds))),
      time: ambiguousTimes[0].time,
    });
  }

  const participant: ReplayComparisonParticipant = {
    id: options.id ?? "autoplay-reference",
    label: options.label ?? "Autoplay reference",
    kind: "autoplay-reference",
    beatmapMd5: options.beatmapMd5,
    gameMode: 0,
    mods: [...beatmap.appliedMods],
    baseRate: beatmap.gameClockRate,
    cursorFrames: frames,
    cursorExcludedRanges,
    // Deliberately absent: the analytic trajectory does not claim physical inputs.
    inputFrames: undefined,
    events,
    maxComboInput: options.maxComboInput ?? null,
    scoreInput: null,
    limitations,
  };

  return {
    participant,
    samples: samples.map(({ order: _order, ...sample }) => sample),
    cursorExcludedRanges,
    limitations,
    coverage: {
      perfectMainObjectJudgements: events.length,
      omittedSpinnerTrajectories,
      overlappingObjectPairs: overlaps.length,
      ambiguousCursorTimes: ambiguousTimes.length,
    },
  };
}
