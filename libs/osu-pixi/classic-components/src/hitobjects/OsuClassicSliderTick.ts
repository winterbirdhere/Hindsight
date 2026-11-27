import {
  applyPropertiesToDisplayObject,
  createCenteredSprite,
  DisplayObjectTransformationProcess,
  evaluateTransformationsToProperties,
} from "../utils/Pixi";
import { Sprite, Texture } from "pixi.js";
import { applyEasing, Easing, Position } from "@osujs/math";
import { fadeInT, fadeOutT, scaleToT, Transformation } from "../utils/Transformations";

// Lazer/DrawableSliderTick.cs

interface SliderTickSettings {
  time: number;
  position: Position;
  scale: number;
  texture: Texture;
  approachDuration: number; // Has complicated logic
  hit: boolean | null;
}

const ANIM_DURATION = 150;

export class OsuClassicSliderTick {
  public readonly sprite: Sprite;

  constructor() {
    this.sprite = createCenteredSprite();
  }

  static normalTransformation(settings: {
    approachDuration: number;
    hit: boolean | null;
    scale: number;
  }): DisplayObjectTransformationProcess {
    const { approachDuration, hit, scale } = settings;
    const hitTime = 0;
    const alphaTransformations: Transformation<number>[] = [
      { time: [-approachDuration, -approachDuration + ANIM_DURATION], func: fadeInT() },
    ];
    if (hit !== null) {
      alphaTransformations.push({ time: [hitTime, hitTime + ANIM_DURATION], func: fadeOutT(0, Easing.OUT_QUINT) });
    }

    const growStart = -approachDuration;
    const growEnd = Math.min(growStart + ANIM_DURATION * 4, hitTime);
    const scaleTransformations: Transformation<number>[] = [
      {
        time: [growStart, growEnd],
        // Preserve osu!'s 600 ms easing progress even when the tick is judged
        // before the grow animation would otherwise complete.
        func: (startValue) => (time) => {
          const progress = Math.min(1, Math.max(0, (time - growStart) / (ANIM_DURATION * 4)));
          const easedProgress = applyEasing(progress, Easing.OUT_ELASTIC_HALF);
          return startValue + (scale - startValue) * easedProgress;
        },
      },
    ];
    if (hit === true) {
      scaleTransformations.push({
        time: [hitTime, hitTime + ANIM_DURATION],
        func: scaleToT(scale * 1.5, Easing.OUT),
      });
    }

    return {
      alpha: {
        startValue: 0,
        transformations: alphaTransformations,
      },
      scale: {
        startValue: scale * 0.5,
        transformations: scaleTransformations,
      },
    };
  }

  prepare(settings: SliderTickSettings): void {
    const { time, position, scale, texture, approachDuration, hit } = settings;

    this.sprite.texture = texture;
    this.sprite.position.set(position.x, position.y);
    const t = OsuClassicSliderTick.normalTransformation({ approachDuration, hit, scale });
    const p = evaluateTransformationsToProperties(t, time);
    applyPropertiesToDisplayObject(p, this.sprite);
  }
}
