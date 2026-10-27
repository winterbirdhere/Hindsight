import { injectable } from "inversify";
import { Container, Graphics, Text } from "pixi.js";
import { GameplayClock } from "../../../common/game/GameplayClock";
import {
  ERROR_OUTLINE_FADE_MS,
  ERROR_OUTLINE_HANDOVER_MAX_MS,
  ERROR_OUTLINE_HANDOVER_MIN_MS,
  errorOutlineAlpha,
  errorOutlineHandover,
  ErrorOutlineStore,
  type ErrorOutlineTarget,
} from "../../../common/error-outline";
import { REWIND_FONTS } from "../../../../styles/tokens";

// osu! pixels. The ring's outer edge lies on the object's own edge, which is where its approach circle ends.
const RING = {
  full: { width: 3, alpha: 1, trailWidth: 1.5 },
  light: { width: 1.5, alpha: 0.55, trailWidth: 1 },
} as const;
const TRAIL_ALPHA = 0.75;
// The trail is fainter the older it is, in steps, so its direction can be read: this much of it at its oldest sample.
const TRAIL_TAIL = 0.15;
const TRAIL_STEPS = 8;
const TAP_RADIUS = 3.5;
const TAP_LINE_WIDTH = 1.5;
// A tap's dot is a darker shade of its error's colour, so on the edge it stands out from the ring.
const TAP_SHADE = 0.6;

function shade(color: number, factor: number): number {
  const channel = (shift: number) => Math.round(((color >> shift) & 0xff) * factor) << shift;
  return channel(16) | channel(8) | channel(0);
}
// The label sits up and to the right of its tap, clear of the marker.
const LABEL_OFFSET = { x: 6, y: -6 };
const LABEL_STYLE = {
  fontFamily: REWIND_FONTS.mono,
  fontSize: 9,
  fontWeight: "500",
  fill: 0xffffff,
  stroke: 0x0b0b0e,
  strokeThickness: 2,
} as const;
// The playfield is drawn larger than its osu! pixels; the text is rasterised finer so it stays sharp.
const LABEL_RESOLUTION = 4;

/**
 * Rings around the objects of the errors in `ErrorOutlineStore`, with each one's miss trail: the cursor's recorded
 * path and the taps the analysis attributes to the object. The newest error has the trail: when a later one's ring
 * appears, an earlier one's trail and taps go and its ring thins, unless it is the error under inspection. In a run
 * of errors only the first is drawn, and the inspected one. Nothing is drawn while playback is paused. Like
 * everything on the playfield it is derived from the clock's time, so it is the same under playback, a pause and a
 * seek.
 */
@injectable()
export class ErrorOutlinePreparer {
  readonly container = new Container();
  private readonly graphics = new Graphics();
  private readonly labels = new Container();

  constructor(private readonly gameClock: GameplayClock, private readonly store: ErrorOutlineStore) {
    this.container.addChild(this.graphics, this.labels);
  }

  update() {
    this.graphics.clear();
    let usedLabels = 0;
    // An exported clip never has the outline; the clock is locked for as long as an export runs. And it is for
    // watching: while playback is paused there is none, so a paused frame shows the replay and nothing over it.
    if (!this.gameClock.controlsLocked && this.gameClock.isPlaying) {
      const time = this.gameClock.timeElapsedInMs;
      const rate = this.gameClock.playbackRate;
      for (const target of this.store.targets) {
        const inspected = target.errorId === this.store.inspectedErrorId;
        // In a run of errors only the first is outlined.
        if (target.follower && !inspected) continue;
        const alpha = errorOutlineAlpha(time, target, target.holdMs * rate, ERROR_OUTLINE_FADE_MS * rate);
        if (alpha <= 0) continue;
        const ring = RING[target.emphasis];
        const strength = alpha * ring.alpha;
        const handover = inspected
          ? 0
          : errorOutlineHandover(time, target, ERROR_OUTLINE_HANDOVER_MIN_MS * rate, ERROR_OUTLINE_HANDOVER_MAX_MS * rate);
        if (handover < 1) this.drawTrail(target, time, ring.trailWidth, strength * (1 - handover) * TRAIL_ALPHA);
        const width = ring.width + (RING.light.width - ring.width) * handover;
        this.graphics
          .lineStyle(width, target.color, alpha * (ring.alpha + (RING.light.alpha - ring.alpha) * handover))
          .drawCircle(target.position.x, target.position.y, target.radius - width / 2);
        if (handover < 1) usedLabels = this.drawTaps(target, time, strength * (1 - handover), usedLabels);
      }
    }
    for (let index = usedLabels; index < this.labels.children.length; index++) this.labels.children[index].visible = false;
  }

  /** The recorded samples up to now, joined: what the cursor did on the way to the error, fainter the older. */
  private drawTrail(target: ErrorOutlineTarget, time: number, width: number, alpha: number) {
    const { trail } = target;
    const points = trail.filter((point) => point.time <= time);
    if (points.length < 2) return;
    const first = trail[0].time;
    const span = trail[trail.length - 1].time - first;
    // The step of the line that ends at a sample; the samples of one step are one line.
    const stepOf = (point: { time: number }) =>
      span > 0 ? Math.min(TRAIL_STEPS, Math.floor(((point.time - first) / span) * TRAIL_STEPS) + 1) : TRAIL_STEPS;
    let step = 0;
    for (let index = 1; index < points.length; index++) {
      const next = stepOf(points[index]);
      if (next !== step) {
        step = next;
        const share = TRAIL_TAIL + ((1 - TRAIL_TAIL) * step) / TRAIL_STEPS;
        this.graphics.lineStyle(width, target.color, alpha * share).moveTo(points[index - 1].x, points[index - 1].y);
      }
      this.graphics.lineTo(points[index].x, points[index].y);
    }
  }

  private drawTaps(target: ErrorOutlineTarget, time: number, alpha: number, usedLabels: number): number {
    for (const tap of target.taps) {
      if (tap.time > time) continue;
      const { x, y } = tap.position;
      // Filled: the analysis attributes the tap to this object. Hollow: it could be a neighbour's.
      const color = shade(target.color, TAP_SHADE);
      this.graphics.lineStyle(TAP_LINE_WIDTH, color, alpha);
      if (tap.certainty === "attributed") this.graphics.beginFill(color, alpha);
      this.graphics.drawCircle(x, y, TAP_RADIUS);
      if (tap.certainty === "attributed") this.graphics.endFill();
      if (tap.label === undefined) continue;
      const label = this.label(usedLabels++);
      label.text = tap.label;
      label.position.set(x + LABEL_OFFSET.x, y + LABEL_OFFSET.y);
      label.alpha = alpha;
      label.visible = true;
    }
    return usedLabels;
  }

  private label(index: number): Text {
    let label = this.labels.children[index] as Text | undefined;
    if (!label) {
      label = new Text("", LABEL_STYLE);
      label.resolution = LABEL_RESOLUTION;
      label.anchor.set(0, 1);
      this.labels.addChild(label);
    }
    return label;
  }
}
