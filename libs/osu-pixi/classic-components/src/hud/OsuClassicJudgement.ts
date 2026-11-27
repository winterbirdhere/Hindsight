import { Sprite, Texture } from "pixi.js";
import { AnimationTimeSetting, PositionSetting, ScaleSetting } from "../DrawableSettings";
import { Easing, Position } from "@osujs/math";
import { PrepareSetting } from "../utils/Preparable";
import {
  applyPropertiesToDisplayObject,
  DisplayObjectTransformationProcess,
  evaluateTransformationsToProperties,
} from "../utils/Pixi";
import { clampedInterpolationFunction, fadeInT, fadeOutT, scaleToT } from "../utils/Transformations";
import { animationIndex } from "../utils/Animation";

export interface OsuClassicJudgementsSettings extends AnimationTimeSetting, PositionSetting, ScaleSetting {
  time: number;
  position: Position;
  scale: number;

  // Example: 60fps (16.6667ms each frame) and two textures given
  // At time=0ms texture[0], at 17ms texture[1] will be used at 34ms texture[1] will still be used since it's the last
  // one. In case there is no animation just provide a list of one texture.
  textures: Texture[];
  animationFrameRate: number;
  isMiss: boolean;
}

const defaultSettings: OsuClassicJudgementsSettings = {
  time: 0,
  position: { x: 0, y: 0 },
  scale: 0.57, // cs4
  textures: [Texture.EMPTY],
  animationFrameRate: 60,
  isMiss: false,
};

const judgementPositionTo =
  (endPosition: Position, easing = Easing.LINEAR) =>
  (startPosition: Position, fromTime: number, toTime: number) => {
    const interpolateX = clampedInterpolationFunction(fromTime, toTime, startPosition.x, endPosition.x, easing);
    const interpolateY = clampedInterpolationFunction(fromTime, toTime, startPosition.y, endPosition.y, easing);

    return (time: number): Position => ({ x: interpolateX(time), y: interpolateY(time) });
  };

//
/**
 * The judgements are sprites that represent Miss, 50, 100, 300, 100-genki, 300-genki.
 *
 * Animation starts at time=0 and should be included at the time when the has hit the circle or missed.
 */
export class OsuClassicJudgement implements PrepareSetting<OsuClassicJudgementsSettings> {
  static readonly MISS_FADE_IN_DURATION = 120;
  static readonly MISS_FADE_OUT_DELAY = 500;
  static readonly MISS_FADE_OUT_DURATION = 600;
  static readonly MISS_ANIMATION_DURATION =
    OsuClassicJudgement.MISS_FADE_OUT_DELAY + OsuClassicJudgement.MISS_FADE_OUT_DURATION;
  static readonly MISS_SCALE_DURATION = 100;
  static readonly MISS_START_Y_OFFSET = -5;
  static readonly MISS_FALL_DISTANCE = 80;

  sprite: Sprite;
  settings: OsuClassicJudgementsSettings;

  constructor() {
    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5, 0.5);
    this.settings = defaultSettings;
  }

  static normalTransformation(scale: number, position: Position): DisplayObjectTransformationProcess {
    return {
      alpha: {
        startValue: 1,
        transformations: [{ time: [0, 1000], func: fadeOutT() }],
      },
      scale: {
        startValue: scale * 0.9,
        transformations: [{ time: [0, 500], func: scaleToT(scale * 1.0, Easing.OUT_ELASTIC) }],
      },
      position: {
        startValue: position,
      },
    };
  }

  static missTransformation(scale: number, position: Position): DisplayObjectTransformationProcess {
    const startPosition = {
      x: position.x,
      y: position.y + OsuClassicJudgement.MISS_START_Y_OFFSET,
    };
    const endPosition = {
      x: startPosition.x,
      y: startPosition.y + OsuClassicJudgement.MISS_FALL_DISTANCE,
    };

    return {
      alpha: {
        startValue: 0,
        transformations: [
          {
            time: [0, OsuClassicJudgement.MISS_FADE_IN_DURATION],
            func: fadeInT(),
          },
          {
            time: [OsuClassicJudgement.MISS_FADE_OUT_DELAY, OsuClassicJudgement.MISS_ANIMATION_DURATION],
            func: fadeOutT(),
          },
        ],
      },
      scale: {
        startValue: scale * 1.6,
        transformations: [
          {
            time: [0, OsuClassicJudgement.MISS_SCALE_DURATION],
            func: scaleToT(scale, Easing.IN_CUBIC),
          },
        ],
      },
      position: {
        startValue: startPosition,
        transformations: [
          {
            time: [0, OsuClassicJudgement.MISS_ANIMATION_DURATION],
            func: judgementPositionTo(endPosition, Easing.IN_CUBIC),
          },
        ],
      },
    };
  }

  prepare(setting: Partial<OsuClassicJudgementsSettings>) {
    this.settings = { ...this.settings, ...setting };

    const { position, scale, textures, time, animationFrameRate, isMiss } = this.settings;

    // Last one will be taken in case there are none left...
    if (textures.length > 0) {
      const idx = Math.min(textures.length - 1, animationIndex(time, animationFrameRate));
      this.sprite.texture = textures[idx];
    } else {
      this.sprite.texture = Texture.EMPTY;
    }

    const transformation = isMiss
      ? OsuClassicJudgement.missTransformation(scale, position)
      : OsuClassicJudgement.normalTransformation(scale, position);
    const props = evaluateTransformationsToProperties(transformation, time);
    applyPropertiesToDisplayObject(props, this.sprite);
  }
}
