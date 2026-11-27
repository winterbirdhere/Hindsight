import { Sprite, Texture } from "pixi.js";
import {
  createCenteredSprite,
  DisplayObjectTransformationProcess,
  evaluateTransformationsToProperties,
} from "../utils/Pixi";
import { AnimationTimeSetting, PositionSetting, ScaleSetting } from "../DrawableSettings";
import { PrepareSetting } from "../utils/Preparable";
import { fadeInT, fadeOutT, scaleToT, Transformation } from "../utils/Transformations";
import { Easing } from "@osujs/math";

interface OsuClassicSliderRepeatSettings extends PositionSetting, ScaleSetting, AnimationTimeSetting {
  time: number;
  texture: Texture;
  rotationAngle: number;
  // When it should start fading in and "beating"
  approachDuration: number;
  // In Lazer it is Math.min(300, SpanDuration), might also be known as `animDuration`
  fadeInOutDuration: number;
  hit: boolean | null;
}

const defaultSettings: OsuClassicSliderRepeatSettings = {
  time: 0,
  scale: 0.57, // cs4
  position: { x: 0, y: 0 },
  texture: Texture.EMPTY,
  rotationAngle: 0,
  approachDuration: 450,
  fadeInOutDuration: 300,
  hit: null,
};

/**
 * Stable-compatible legacy reverse-arrow animation.
 */
export class OsuClassicSliderRepeat implements PrepareSetting<OsuClassicSliderRepeatSettings> {
  static readonly LEGACY_PULSE_DURATION = 300;
  static readonly LEGACY_FADE_IN_DURATION = 150;

  sprite: Sprite;
  settings: OsuClassicSliderRepeatSettings;

  constructor() {
    this.sprite = createCenteredSprite();
    this.settings = defaultSettings;
  }

  static normalTransformation(settings: {
    hit: boolean | null;
    scale: number;
    approachDuration: number;
    fadeInOutDuration: number;
  }): DisplayObjectTransformationProcess {
    const { hit, scale, approachDuration, fadeInOutDuration } = settings;

    const scalingTransformations: Transformation<number>[] = [];
    const hitTiming = 0;
    const pulseEnd = hit === true ? hitTiming : hitTiming + fadeInOutDuration;

    // Stable's legacy reverse arrow runs a fixed 300 ms loop from the repeat's
    // animation start. It is intentionally not synchronised to map BPM.
    let t = -approachDuration;
    while (t < pulseEnd) {
      const loopEnd = Math.min(t + OsuClassicSliderRepeat.LEGACY_PULSE_DURATION, pulseEnd);
      scalingTransformations.push({ time: [t, loopEnd], func: scaleToT(scale, Easing.OUT) });
      if (loopEnd < pulseEnd) {
        // A zero-duration transform is the explicit reset at the next pulse.
        scalingTransformations.push({ time: [loopEnd, loopEnd], func: scaleToT(1.3 * scale) });
      }
      t = loopEnd;
    }

    if (hit === true) {
      // A successful repeat replaces the pulse with Stable's outward hit pop.
      scalingTransformations.push({
        time: [hitTiming, hitTiming + fadeInOutDuration],
        func: scaleToT(1.4 * scale, Easing.OUT),
      });
    }

    const alphaTransformations: Transformation<number>[] = [
      {
        time: [
          -approachDuration,
          -approachDuration + Math.min(OsuClassicSliderRepeat.LEGACY_FADE_IN_DURATION, approachDuration),
        ],
        func: fadeInT(),
      },
    ];

    if (hit !== null) {
      if (hit) {
        alphaTransformations.push({
          time: [hitTiming, hitTiming + fadeInOutDuration],
          func: fadeOutT(0, Easing.OUT),
        });
      } else {
        alphaTransformations.push({ time: [hitTiming, hitTiming + fadeInOutDuration], func: fadeOutT() });
      }
    }

    return {
      alpha: {
        startValue: 0,
        transformations: alphaTransformations,
      },
      scale: {
        startValue: 1.3 * scale,
        transformations: scalingTransformations,
      },
    };
  }

  prepare(setting: Partial<OsuClassicSliderRepeatSettings>): void {
    this.settings = { ...this.settings, ...setting };
    const { rotationAngle, texture, position, scale, hit, fadeInOutDuration, approachDuration, time } = this.settings;

    this.sprite.anchor.set(0.5);
    this.sprite.texture = texture;
    this.sprite.position.set(position.x, position.y);
    this.sprite.rotation = rotationAngle;

    const props = evaluateTransformationsToProperties(
      OsuClassicSliderRepeat.normalTransformation({
        approachDuration,
        fadeInOutDuration,
        hit,
        scale,
      }),
      time,
    );

    this.sprite.alpha = props.alpha as number;
    this.sprite.scale.set(props.scale as number);
  }
}
