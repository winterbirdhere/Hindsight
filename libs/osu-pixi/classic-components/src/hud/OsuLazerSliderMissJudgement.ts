import { Sprite, Texture } from "pixi.js";
import { Easing, Position } from "@osujs/math";
import {
  applyPropertiesToDisplayObject,
  DisplayObjectTransformationProcess,
  evaluateTransformationsToProperties,
} from "../utils/Pixi";
import { fadeInT, fadeOutT, scaleToT } from "../utils/Transformations";
import { animationIndex } from "../utils/Animation";

export interface OsuLazerSliderMissJudgementSettings {
  time: number;
  position: Position;
  scale: number;
  textures: Texture[];
  animationFrameRate: number;
}

/**
 * lazer's LegacyJudgementPieceOld animation for LargeTickMiss/IgnoreMiss.
 * This is used for both slidertickmiss and sliderendmiss when replaying with
 * an imported Stable skin; successful slider components have no judgement
 * sprite in lazer.
 */
export class OsuLazerSliderMissJudgement {
  static readonly FADE_IN_DURATION = 120;
  static readonly FADE_OUT_DELAY = 250;
  static readonly FADE_OUT_DURATION = 600;
  static readonly ANIMATION_DURATION =
    OsuLazerSliderMissJudgement.FADE_OUT_DELAY + OsuLazerSliderMissJudgement.FADE_OUT_DURATION;
  static readonly SCALE_DURATION = 100;

  public readonly sprite: Sprite;

  constructor() {
    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5);
  }

  static transformation(scale: number, position: Position): DisplayObjectTransformationProcess {
    return {
      alpha: {
        startValue: 0,
        transformations: [
          {
            time: [0, OsuLazerSliderMissJudgement.FADE_IN_DURATION],
            func: fadeInT(),
          },
          {
            time: [OsuLazerSliderMissJudgement.FADE_OUT_DELAY, OsuLazerSliderMissJudgement.ANIMATION_DURATION],
            func: fadeOutT(),
          },
        ],
      },
      scale: {
        startValue: scale * 1.2,
        transformations: [
          {
            time: [0, OsuLazerSliderMissJudgement.SCALE_DURATION],
            func: scaleToT(scale, Easing.IN),
          },
        ],
      },
      position: { startValue: position },
    };
  }

  prepare(settings: OsuLazerSliderMissJudgementSettings): void {
    const { time, position, scale, textures, animationFrameRate } = settings;

    if (textures.length > 0) {
      const index = Math.min(textures.length - 1, animationIndex(time, animationFrameRate));
      this.sprite.texture = textures[index];
    } else {
      this.sprite.texture = Texture.EMPTY;
    }

    applyPropertiesToDisplayObject(
      evaluateTransformationsToProperties(OsuLazerSliderMissJudgement.transformation(scale, position), time),
      this.sprite,
    );
  }
}
