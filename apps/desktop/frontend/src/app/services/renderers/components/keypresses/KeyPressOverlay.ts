import { TemporaryObjectPool } from "../../../../utils/pooling/TemporaryObjectPool";
import { Container, Graphics, Rectangle, Sprite, Text, Texture } from "pixi.js";
import {
  calculateReplayButtonIntervals,
  isHitCircle,
  MainHitObject,
  OsuHitObject,
  PhysicalReplayButton,
  ReplayButtonIntervals,
  TimeInterval,
  TimeIntervals,
} from "@osujs/core";
import { injectable } from "inversify";
import { ReplayManager } from "../../../manager/ReplayManager";
import { GameplayClock } from "../../../common/game/GameplayClock";
import { BeatmapManager } from "../../../manager/BeatmapManager";
import { clamp } from "@osujs/math";
import { replayButtonEncoding } from "../../../../model/OsuReplay";
import { hexToNumber, REWIND_COLORS, REWIND_FONTS } from "../../../../styles/tokens";
import { DEFAULT_REPLAY_DISPLAY_SETTINGS, type KeyOverlayLength } from "../../../analysis/replay-display-settings";
import { ErrorOutlineStore } from "../../../common/error-outline";

/**
 *
 * Questions:
 * 1. Dynamic: depending on beatmap?
 * 2.
 * 3. HitCircles shown or not
 */

// Can efficiently determine which time intervals are visible assuming that they are *static* and non intersecting such
// as key presses.
// More specifically, it finds all time intervals [start, end] that intersect with [time, time + timeWindow]

function timeIntervalIntersection(a: TimeInterval, b: TimeInterval): TimeInterval {
  return [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
}

class NonIntersectingTimeIntervalsTracker {
  constructor(
    public intervals: TimeIntervals,
    public timeWindow: number,
    private readonly intervalsDoNotIntersect = true,
  ) {}

  /**
   * Finds the intervals that intersect with time around the given timeWindow.
   * @returns the indices
   */
  findVisibleIndices(time: number) {
    const w: TimeInterval = createTimeWindow(time, this.timeWindow);
    const res: number[] = [];

    // Beatmap object durations can overlap, unlike button presses. Preserve the
    // general lookup for that secondary use of this tracker.
    if (!this.intervalsDoNotIntersect) {
      for (let i = 0; i < this.intervals.length && this.intervals[i][0] <= w[1]; i++) {
        const intersection = timeIntervalIntersection(this.intervals[i], w);
        if (intersection[0] <= intersection[1]) res.push(i);
      }
      return res;
    }

    // Intervals are ordered and non-intersecting, so find the first one whose
    // end can be visible instead of scanning every press on every rendered frame.
    let low = 0;
    let high = this.intervals.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.intervals[middle][1] < w[0]) low = middle + 1;
      else high = middle;
    }

    for (let i = low; i < this.intervals.length && this.intervals[i][0] <= w[1]; i++) {
      res.push(i);
    }
    return res;
  }
}

// Overlay-local units; AnalysisStageLayout scales the whole overlay into the stage's top margin.
// `width` and `rollWidth` are the short length's; `lengthMetrics` has the longer ones.
export const KEY_OVERLAY_GEOMETRY = {
  width: 510,
  height: 75,
  capX: 5,
  capWidth: 78,
  rollX: 100.5,
  rollWidth: 391.5,
  laneTop: 7.5,
  laneHeight: 25.5,
  laneGap: 9,
  objectMark: { width: 4.5, height: 34.5, y: 20.25 },
} as const;
const G = KEY_OVERLAY_GEOMETRY;
const MOUSE_BAR_INSET = 4.5;
const PANEL_TINT = 0x0a0a0d;
const OBJECT_TINT = 0xececec;
const NO_MARKED_OBJECTS: ReadonlyMap<string, number> = new Map();
const EDGE_FADE_STEPS = 12;

export interface InputBarGeometry {
  y: number;
  height: number;
}

/** Keyboard and mouse share two lanes; a mouse press uses an inset rail so genuine K/M overlap stays readable. */
export function inputBarGeometry(input: PhysicalReplayButton): InputBarGeometry {
  const inset = input === "M1" || input === "M2" ? MOUSE_BAR_INSET : 0;
  return { y: inset, height: G.laneHeight - inset * 2 };
}

/** Presses started by `time` (osu!-style key counter) and whether one is held at `time`. */
export function keyCapState(intervals: TimeIntervals, time: number): { count: number; held: boolean } {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (intervals[middle][0] <= time) low = middle + 1;
    else high = middle;
  }
  const last = low > 0 ? intervals[low - 1] : undefined;
  return { count: low, held: !!last && last[1] >= time };
}

interface InputLane {
  keyboard: { name: "K1" | "K2"; tint: number };
  mouse: { name: "M1" | "M2"; tint: number };
}

const INPUT_LANES: InputLane[] = [
  { keyboard: { name: "K1", tint: hexToNumber(REWIND_COLORS.key1) }, mouse: { name: "M1", tint: 0xe879f9 } },
  { keyboard: { name: "K2", tint: hexToNumber(REWIND_COLORS.key2) }, mouse: { name: "M2", tint: 0x60a5fa } },
];
const INPUT_BUTTONS = INPUT_LANES.flatMap((lane) => [lane.keyboard, lane.mouse]);

function positionInTimeline(currentTime: number, windowDuration: number, x: number, rollWidth: number) {
  return ((x - currentTime + windowDuration) / (2 * windowDuration)) * rollWidth;
}

export class KeyPressOverlayRow {
  spritePool: TemporaryObjectPool<Sprite>;
  tracker: NonIntersectingTimeIntervalsTracker;
  container: Container;
  tint = 0xffffff;
  rollWidth: number = G.rollWidth;

  constructor(timeIntervals: TimeIntervals, hitWindowTime: number, private readonly barGeometry: InputBarGeometry) {
    this.spritePool = new TemporaryObjectPool<Sprite>(() => new Sprite(Texture.WHITE), () => undefined, { initialSize: 10 });
    this.tracker = new NonIntersectingTimeIntervalsTracker(timeIntervals, hitWindowTime);
    this.container = new Container();
  }

  onTintChange(tint: number) {
    this.tint = tint;
  }

  update(time: number) {
    const intervalsIndices = this.tracker.findVisibleIndices(time);
    const window = createTimeWindow(time, this.tracker.timeWindow);
    this.container.removeChildren();
    const msToPx = (x: number) => positionInTimeline(time, this.tracker.timeWindow, x, this.rollWidth);
    for (const i of intervalsIndices) {
      const interval = this.tracker.intervals[i];
      // A press and release can share a millisecond; show it as a tick without inventing a duration.
      const [left, right] =
        interval[0] === interval[1]
          ? [Math.max(0, msToPx(interval[0]) - 1), Math.min(this.rollWidth, msToPx(interval[0]) + 1)]
          : (() => {
              const visible = timeIntervalIntersection(window, interval);
              return [msToPx(visible[0]), msToPx(visible[1])];
            })();
      if (right <= left) continue;
      const [sprite] = this.spritePool.allocate("press" + i);
      sprite.width = right - left;
      sprite.height = this.barGeometry.height;
      sprite.position.set(left, this.barGeometry.y);
      // Past/future dimming is a single wash over the future half (spec §6).
      sprite.alpha = 1;
      sprite.tint = this.tint;
      this.container.addChild(sprite);
    }
    this.spritePool.releaseUntouched();
  }
}

class KeyCap {
  readonly container = new Container();
  private readonly box = new Graphics();
  private readonly label: Text;
  private readonly counter: Text;
  private shown?: string;

  constructor(private readonly name: string, private readonly tint: number) {
    const style = { fontFamily: REWIND_FONTS.mono, fontSize: 15, fontWeight: "500" as const };
    this.label = new Text(name, style);
    this.counter = new Text("0", style);
    this.label.anchor.set(0, 0.5);
    this.counter.anchor.set(1, 0.5);
    this.label.position.set(9, G.laneHeight / 2);
    this.counter.position.set(G.capWidth - 9, G.laneHeight / 2);
    this.container.addChild(this.box, this.label, this.counter);
  }

  update(count: number, held: boolean) {
    const key = `${count}:${held}`;
    if (key === this.shown) return;
    this.shown = key;
    this.box.clear();
    if (held) this.box.beginFill(this.tint).drawRect(0, 0, G.capWidth, G.laneHeight).endFill();
    else this.box.lineStyle(1, 0xffffff, 0.12).drawRect(0.5, 0.5, G.capWidth - 1, G.laneHeight - 1);
    const fill = held ? 0x0b0b0e : hexToNumber(REWIND_COLORS.textTertiary);
    this.label.style.fill = fill;
    this.counter.style.fill = fill;
    this.counter.text = String(count);
  }
}

/** The short length's half-window. */
export const SHORT_KEY_OVERLAY_WINDOW_MS = 210;
// A longer roll shows more time at the short roll's scale, so a press is drawn the same size in every length.
const LENGTH_FACTORS: Record<KeyOverlayLength, number> = { short: 1, medium: 1.5, long: 2 };
// The roll ends fade over 8 % of the short roll, whatever the length.
const EDGE_FADE_WIDTH = G.rollWidth * 0.08;
const MIN_WINDOW_DURATION = 100;
const MAX_WINDOW_DURATION = 2000;
const OVERLAY_BACKGROUND_ALPHA = 0.72;

function lengthMetrics(length: KeyOverlayLength) {
  const rollWidth = G.rollWidth * LENGTH_FACTORS[length];
  return {
    width: G.width - G.rollWidth + rollWidth,
    rollWidth,
    windowDuration: SHORT_KEY_OVERLAY_WINDOW_MS * LENGTH_FACTORS[length],
  };
}

function createTimeWindow(time: number, duration: number): TimeInterval {
  return [time - duration, time + duration];
}

function hitObjectWindow(hitObject: MainHitObject): TimeInterval {
  if (isHitCircle(hitObject)) return [hitObject.hitTime, hitObject.hitTime];
  return [hitObject.startTime, hitObject.startTime + hitObject.duration];
}

export class KeyPressOverlay {
  public container: Container;
  private rows = new Map<PhysicalReplayButton, KeyPressOverlayRow>();
  private caps: KeyCap[] = [];
  private buttonIntervals: ReplayButtonIntervals = { K1: [], K2: [], M1: [], M2: [] };
  private hitObjectContainer: Container;
  private spritePool: TemporaryObjectPool<Sprite>;
  private hitObjects: OsuHitObject[] = [];
  /** Read by the stage; set through `setLength` or `onWindowDurationChange`. */
  public length: KeyOverlayLength = DEFAULT_REPLAY_DISPLAY_SETTINGS.keyOverlayLength;
  public windowDuration: number = SHORT_KEY_OVERLAY_WINDOW_MS;
  private width: number = G.width;
  private rollWidth: number = G.rollWidth;
  private hitObjectTracker = new NonIntersectingTimeIntervalsTracker([], 0, false);
  private timeIntervals: TimeInterval[] = [];
  private markedObjects = NO_MARKED_OBJECTS;
  private background = new Graphics();
  private border = new Graphics();
  private laneBackgrounds = new Graphics();
  private futureWash = new Sprite(Texture.WHITE);
  private rightFades: Sprite[] = [];
  private now = new Sprite(Texture.WHITE);
  private hovered = false;

  constructor(private readonly gameplayClock: GameplayClock) {
    this.container = new Container();
    // Square panel (spec §6). No backdrop blur: blurring the live stage behind it would re-render the scene.
    // Whatever depends on the length is drawn and placed in `setLength`.
    this.background.alpha = OVERLAY_BACKGROUND_ALPHA;
    this.container.addChild(this.background, this.border);

    INPUT_LANES.forEach((lane, index) => {
      const y = G.laneTop + index * (G.laneHeight + G.laneGap);
      for (const input of [lane.keyboard, lane.mouse]) {
        const row = new KeyPressOverlayRow([], this.windowDuration, inputBarGeometry(input.name));
        row.onTintChange(input.tint);
        row.container.position.set(G.rollX, y);
        this.rows.set(input.name, row);
      }
      const cap = new KeyCap(lane.keyboard.name, lane.keyboard.tint);
      cap.container.position.set(G.capX, y);
      this.caps.push(cap);
    });
    this.container.addChild(this.laneBackgrounds);
    for (const input of INPUT_BUTTONS) this.container.addChild(this.rows.get(input.name)!.container);

    this.hitObjectContainer = new Container();
    this.hitObjectContainer.position.set(G.rollX, 0);
    this.container.addChild(this.hitObjectContainer);

    this.futureWash.tint = PANEL_TINT;
    this.futureWash.alpha = 0.55;
    this.futureWash.height = G.height;
    this.container.addChild(this.futureWash);

    const stepWidth = EDGE_FADE_WIDTH / EDGE_FADE_STEPS;
    for (let step = 0; step < EDGE_FADE_STEPS; step++) {
      for (const side of ["left", "right"] as const) {
        const fade = new Sprite(Texture.WHITE);
        fade.tint = PANEL_TINT;
        fade.alpha = 1 - step / EDGE_FADE_STEPS;
        fade.position.set(G.rollX + step * stepWidth, 0);
        fade.width = stepWidth + 0.5;
        fade.height = G.height;
        this.container.addChild(fade);
        if (side === "right") this.rightFades.push(fade);
      }
    }

    this.now.width = 1.5;
    this.now.height = G.height;
    this.now.alpha = 0.8;
    this.container.addChild(this.now);
    for (const cap of this.caps) this.container.addChild(cap.container);

    this.spritePool = new TemporaryObjectPool<Sprite>(() => new Sprite(Texture.WHITE), () => undefined, { initialSize: 50 });
    this.container.interactive = true;
    this.container.on("mouseover", this.onMouseOver.bind(this));
    this.container.on("mouseout", this.onMouseOut.bind(this));
    this.setLength(this.length);
    window.addEventListener("wheel", this.onWheelEvent.bind(this));
  }

  /** The panel's rectangle in overlay-local units: what the stage lays out, whatever is drawn inside it. */
  get bounds() {
    return { x: 0, y: 0, width: this.width, height: G.height };
  }

  /**
   * Draws the panel at a length and shows that length's window, which drops a wheel zoom. Pass `windowDuration` to
   * put a zoom back instead.
   */
  setLength(length: KeyOverlayLength, windowDuration?: number) {
    const metrics = lengthMetrics(length);
    this.length = length;
    this.width = metrics.width;
    this.rollWidth = metrics.rollWidth;
    for (const row of this.rows.values()) row.rollWidth = metrics.rollWidth;

    this.background.clear().beginFill(PANEL_TINT, 1).drawRect(0, 0, this.width, G.height).endFill();
    this.border.clear().lineStyle(1, 0xffffff, 0.08).drawRect(0.5, 0.5, this.width - 1, G.height - 1);
    this.laneBackgrounds.clear();
    INPUT_LANES.forEach((_lane, index) => {
      const y = G.laneTop + index * (G.laneHeight + G.laneGap);
      this.laneBackgrounds.beginFill(0xffffff, 0.04).drawRect(G.rollX, y, this.rollWidth, G.laneHeight).endFill();
    });
    this.futureWash.position.set(G.rollX + this.rollWidth / 2, 0);
    this.futureWash.width = this.rollWidth / 2;
    const stepWidth = EDGE_FADE_WIDTH / EDGE_FADE_STEPS;
    this.rightFades.forEach((fade, step) => fade.position.set(G.rollX + this.rollWidth - (step + 1) * stepWidth, 0));
    this.now.position.set(G.rollX + this.rollWidth / 2 - 0.75, 0);
    this.container.hitArea = new Rectangle(0, 0, this.width, G.height);

    this.onWindowDurationChange(windowDuration ?? metrics.windowDuration);
  }

  /** Alt and the wheel zoom the overlay's window. The wheel alone steps the playhead here as on the rest of the stage. */
  onWheelEvent(ev: WheelEvent) {
    if (!this.hovered || this.gameplayClock.controlsLocked || !ev.altKey) return;
    // A dialog is in front of the overlay, which may not have heard the pointer leave it.
    if (ev.target instanceof Element && ev.target.closest('[role="dialog"], .MuiModal-root')) return;
    this.onWindowDurationChange(clamp(ev.deltaY * 0.5 + this.windowDuration, MIN_WINDOW_DURATION, MAX_WINDOW_DURATION));
  }

  onMouseOver() {
    this.hovered = true;
    this.background.alpha = 0.9;
  }

  onMouseOut() {
    this.hovered = false;
    this.background.alpha = OVERLAY_BACKGROUND_ALPHA;
  }

  onWindowDurationChange(windowDuration: number) {
    this.windowDuration = windowDuration;
    for (const row of this.rows.values()) row.tracker.timeWindow = windowDuration;
    this.hitObjectTracker.timeWindow = windowDuration;
  }

  onKeyPressesChange(timeIntervals: ReplayButtonIntervals) {
    this.buttonIntervals = timeIntervals;
    for (const input of INPUT_BUTTONS) this.rows.get(input.name)!.tracker.intervals = timeIntervals[input.name];
  }

  /** Objects whose mark is drawn in a colour of its own (an outlined error's), by hit object id. */
  onMarkedObjectsChange(markedObjects: ReadonlyMap<string, number>) {
    this.markedObjects = markedObjects;
  }

  onHitObjectsChange(hitObjects: OsuHitObject[]) {
    this.hitObjects = hitObjects;
    this.timeIntervals = this.hitObjects.map(hitObjectWindow);
    this.hitObjectTracker = new NonIntersectingTimeIntervalsTracker(this.timeIntervals, this.windowDuration, false);
  }

  update(currentTime: number) {
    for (const row of this.rows.values()) row.update(currentTime);
    INPUT_LANES.forEach((lane, index) => {
      const keyboard = keyCapState(this.buttonIntervals[lane.keyboard.name], currentTime);
      const mouse = keyCapState(this.buttonIntervals[lane.mouse.name], currentTime);
      this.caps[index].update(keyboard.count + mouse.count, keyboard.held || mouse.held);
    });

    const window = createTimeWindow(currentTime, this.windowDuration);
    const indices = this.hitObjectTracker.findVisibleIndices(currentTime);
    this.hitObjectContainer.removeChildren();
    for (let i = indices.length - 1; i >= 0; i--) {
      const hitObject = this.hitObjects[indices[i]];
      const marked = this.markedObjects.get(hitObject.id);
      if (!isHitCircle(hitObject)) {
        const visible = timeIntervalIntersection(this.timeIntervals[indices[i]], window);
        const [band] = this.spritePool.allocate("sliderBand" + indices[i]);
        band.width = ((visible[1] - visible[0]) / (2 * this.windowDuration)) * this.rollWidth;
        band.height = G.objectMark.height;
        band.position.set(
          positionInTimeline(currentTime, this.windowDuration, visible[0], this.rollWidth),
          G.objectMark.y,
        );
        band.tint = marked ?? OBJECT_TINT;
        band.alpha = marked === undefined ? 0.3 : 0.45;
        this.hitObjectContainer.addChild(band);
      }
      const start = isHitCircle(hitObject) ? hitObject.hitTime : hitObject.startTime;
      if (start < window[0] || start > window[1]) continue;
      const [mark] = this.spritePool.allocate("objectMark" + indices[i]);
      mark.width = G.objectMark.width;
      mark.height = G.objectMark.height;
      mark.position.set(
        positionInTimeline(currentTime, this.windowDuration, start, this.rollWidth) - G.objectMark.width / 2,
        G.objectMark.y,
      );
      mark.tint = marked ?? OBJECT_TINT;
      mark.alpha = marked === undefined ? 0.62 : 1;
      this.hitObjectContainer.addChild(mark);
    }
    this.spritePool.releaseUntouched();
  }
}

@injectable()
export class KeyPressWithNoteSheetPreparer {
  keyPressOverlay: KeyPressOverlay;

  constructor(
    private readonly gameplayClock: GameplayClock,
    private readonly replayManager: ReplayManager,
    private readonly beatmapManager: BeatmapManager,
    private readonly errorOutlineStore: ErrorOutlineStore,
  ) {
    this.keyPressOverlay = new KeyPressOverlay(gameplayClock);

    this.replayManager.mainReplay$.subscribe((replay) => {
      if (replay === null) {
        console.debug("Key presses have been reset");
        this.keyPressOverlay.onKeyPressesChange({ K1: [], K2: [], M1: [], M2: [] });
      } else {
        const encoding = replayButtonEncoding(replay);
        const clicks = calculateReplayButtonIntervals(replay.frames, encoding);
        console.debug(
          `KeyPressOverlay: Calculated ${encoding} clicks: [${INPUT_BUTTONS.map(
            (input) => `${input.name}=${clicks[input.name].length}`,
          ).join(", ")}]`,
        );
        this.keyPressOverlay.onKeyPressesChange(clicks);
      }
    });
    this.beatmapManager.beatmap$.subscribe((beatmap) => {
      this.keyPressOverlay.onHitObjectsChange(beatmap.hitObjects);
    });
  }

  get container() {
    return this.keyPressOverlay.container;
  }

  update() {
    const time = this.gameplayClock.timeElapsedInMs;
    // An exported clip never carries the outline's colours; the clock is locked for as long as an export runs.
    this.keyPressOverlay.onMarkedObjectsChange(
      this.gameplayClock.controlsLocked ? NO_MARKED_OBJECTS : this.errorOutlineStore.marks,
    );
    this.keyPressOverlay.update(time);
  }
}
