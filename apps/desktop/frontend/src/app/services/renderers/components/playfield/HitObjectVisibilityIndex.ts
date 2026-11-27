import { isHitCircle, isSlider, type OsuHitObject } from "@osujs/core";
import { OsuClassicSpinner } from "@rewind/osu-pixi/classic-components";

export const HIT_OBJECT_FADE_OUT_MS = 300;

interface Entry {
  object: OsuHitObject;
  order: number;
  start: number;
  end: number;
}

interface Node {
  entry: Entry;
  firstStart: number;
  lastEnd: number;
  left?: Node;
  right?: Node;
}

/** Immutable beatmap intervals; queries work equally for playback and arbitrary seeks. */
export class HitObjectVisibilityIndex {
  private readonly root?: Node;
  private lastTime = NaN;
  private lastResult: readonly OsuHitObject[] = [];

  constructor(objects: readonly OsuHitObject[]) {
    const entries = objects
      .map((object, order): Entry => {
        if (isHitCircle(object)) {
          return { object, order, start: object.spawnTime, end: object.hitTime + HIT_OBJECT_FADE_OUT_MS };
        }
        if (isSlider(object)) {
          return { object, order, start: object.spawnTime, end: object.endTime + HIT_OBJECT_FADE_OUT_MS };
        }
        return {
          object,
          order,
          start: object.startTime - object.fadeInDuration,
          end: object.endTime + OsuClassicSpinner.FADE_OUT_DURATION,
        };
      })
      .sort((a, b) => a.start - b.start || a.order - b.order);

    const build = (start: number, end: number): Node | undefined => {
      if (start >= end) return undefined;
      const middle = start + Math.floor((end - start) / 2);
      const entry = entries[middle];
      const left = build(start, middle);
      const right = build(middle + 1, end);
      return {
        entry,
        left,
        right,
        firstStart: entries[start].start,
        lastEnd: Math.max(entry.end, left?.lastEnd ?? -Infinity, right?.lastEnd ?? -Infinity),
      };
    };
    this.root = build(0, entries.length);
  }

  at(time: number): readonly OsuHitObject[] {
    if (time === this.lastTime) return this.lastResult;
    const entries: Entry[] = [];
    const visit = (node?: Node) => {
      if (!node || node.firstStart > time || node.lastEnd < time) return;
      if (node.entry.start <= time && time <= node.entry.end) entries.push(node.entry);
      visit(node.left);
      visit(node.right);
    };
    if (Number.isFinite(time)) visit(this.root);
    // Keep the existing reverse beatmap painter order, independent of preempt.
    entries.sort((a, b) => b.order - a.order);
    this.lastTime = time;
    this.lastResult = entries.map((entry) => entry.object);
    return this.lastResult;
  }
}
