import { BLEND_MODES, Container, Sprite, Texture } from "pixi.js";
import {
  applyPropertiesToDisplayObject,
  createCenteredSprite,
  DisplayObjectTransformationProcess,
  evaluateTransformationsToProperties,
} from "../utils/Pixi";
import { fadeInT, fadeOutT, scaleToT } from "../utils/Transformations";
import { OSU_PLAYFIELD_HEIGHT, OSU_PLAYFIELD_WIDTH } from "../utils/constants";
import { OsuClassicConstants } from "./OsuClassicConstants";
import { applyEasing, Easing } from "@osujs/math";
import { OsuClassicNumber } from "../hud/OsuClassicNumber";
import { calculateDigits } from "../utils/numbers";

// Time = 0 is when the spinner ends.
export interface OsuClassicSpinnerSettings {
  approachCircleTexture: Texture;
  backgroundTexture: Texture;
  bottomTexture: Texture;
  circleTexture: Texture;
  glowTexture: Texture;
  middleTexture: Texture;
  middle2Texture: Texture;
  topTexture: Texture;
  backgroundTint: number;
  modHidden: boolean;
  duration: number;
  fadeInDuration: number;
  /** Signed replay rotation in degrees. Positive values rotate clockwise. */
  rotationDegrees: number;
  /** Ruleset-owned completion progress, clamped to the display range 0..1. */
  progress: number;
  bonusScore?: number;
  /** Milliseconds since the last completed replay spin. */
  bonusAge?: number;
  bonusIsMaximum?: boolean;
  scoreTextures?: Texture[];
  scoreOverlap?: number;
  time: number;
}

function approachCircleTransformation(settings: {
  modHidden: boolean;
  duration: number;
}): DisplayObjectTransformationProcess {
  const { modHidden, duration } = settings;
  const hitTime = 0;
  const spawnTime = hitTime - duration;

  if (modHidden) {
    return {
      alpha: {
        startValue: 0,
      },
    };
  }
  return {
    alpha: {
      startValue: 1,
    },
    scale: {
      startValue: 1,
      transformations: [{ time: [spawnTime, hitTime], func: scaleToT(0) }],
    },
  };
}

/** Stable-compatible spinner presentation driven by reconstructed replay rotation. */
export class OsuClassicSpinner {
  static readonly FADE_OUT_DURATION = OsuClassicConstants.LEGACY_FADE_OUT_DURATION;

  readonly container: Container;
  readonly backgroundSprite: Sprite;
  readonly glowSprite: Sprite;
  readonly bottomSprite: Sprite;
  readonly circleSprite: Sprite;
  readonly topSprite: Sprite;
  readonly middle2Sprite: Sprite;
  readonly middleSprite: Sprite;
  readonly approachCircleSprite: Sprite;
  readonly bonusNumber = new OsuClassicNumber();

  constructor() {
    this.container = new Container();
    this.container.position.set(OSU_PLAYFIELD_WIDTH / 2, OSU_PLAYFIELD_HEIGHT / 2);

    // The order accommodates both Stable styles. In old style only background
    // and circle are visible. In new style the documented bottom-to-top order is
    // glow, bottom, top, middle2, middle. The approach circle sits above either.
    this.container.addChild((this.backgroundSprite = createCenteredSprite()));
    this.container.addChild((this.glowSprite = createCenteredSprite()));
    this.container.addChild((this.bottomSprite = createCenteredSprite()));
    this.container.addChild((this.circleSprite = createCenteredSprite()));
    this.container.addChild((this.topSprite = createCenteredSprite()));
    this.container.addChild((this.middle2Sprite = createCenteredSprite()));
    this.container.addChild((this.middleSprite = createCenteredSprite()));
    this.container.addChild((this.approachCircleSprite = createCenteredSprite()));

    this.backgroundSprite.blendMode = BLEND_MODES.MULTIPLY;
    this.glowSprite.blendMode = BLEND_MODES.ADD;
    this.middleSprite.blendMode = BLEND_MODES.MULTIPLY;
  }

  static transformation(settings: { duration: number; fadeInDuration: number }): DisplayObjectTransformationProcess {
    const { duration, fadeInDuration } = settings;
    const startTime = -duration;
    return {
      alpha: {
        startValue: 0,
        transformations: [
          {
            time: [startTime - fadeInDuration, startTime],
            func: fadeInT(),
          },
          {
            time: [0, OsuClassicSpinner.FADE_OUT_DURATION],
            func: fadeOutT(),
          },
        ],
      },
    };
  }

  prepare(settings: OsuClassicSpinnerSettings): void {
    const {
      approachCircleTexture,
      backgroundTexture,
      bottomTexture,
      circleTexture,
      glowTexture,
      middleTexture,
      middle2Texture,
      topTexture,
      backgroundTint,
      modHidden,
      duration,
      fadeInDuration,
      rotationDegrees,
      progress,
      time,
    } = settings;

    this.approachCircleSprite.texture = approachCircleTexture;
    this.backgroundSprite.texture = backgroundTexture;
    this.bottomSprite.texture = bottomTexture;
    this.circleSprite.texture = circleTexture;
    this.glowSprite.texture = glowTexture;
    this.middleSprite.texture = middleTexture;
    this.middle2Sprite.texture = middle2Texture;
    this.topSprite.texture = topTexture;
    this.backgroundSprite.tint = backgroundTint;

    // Stable forces the old spinner whenever spinner-background is provided.
    const usesOldStyle = backgroundTexture !== Texture.EMPTY;
    this.backgroundSprite.visible = usesOldStyle;
    this.circleSprite.visible = usesOldStyle;
    this.glowSprite.visible = !usesOldStyle;
    this.bottomSprite.visible = !usesOldStyle;
    this.topSprite.visible = !usesOldStyle;
    this.middle2Sprite.visible = !usesOldStyle;
    this.middleSprite.visible = !usesOldStyle;

    const rotation = (rotationDegrees * Math.PI) / 180;
    const clampedProgress = Math.max(0, Math.min(1, progress));

    // Stable old-style spinners rotate only the main disc.
    this.circleSprite.rotation = usesOldStyle ? rotation : 0;

    // Stable new-style spinners rotate the skinned layers at different ratios.
    // spinner-middle stays fixed and the approach circle is never part of the
    // rotating body. If spinner-middle2 is absent, spinner-top uses full speed.
    const topTurnRatio = middle2Texture !== Texture.EMPTY ? 0.5 : 1;
    this.topSprite.rotation = usesOldStyle ? 0 : rotation * topTurnRatio;
    this.middle2Sprite.rotation = usesOldStyle ? 0 : rotation;
    this.bottomSprite.rotation = usesOldStyle ? 0 : this.topSprite.rotation / 3;
    this.middleSprite.rotation = 0;
    this.backgroundSprite.rotation = 0;
    this.glowSprite.rotation = 0;
    this.approachCircleSprite.rotation = 0;

    const bodyScale = usesOldStyle ? 1 : 0.8 + applyEasing(clampedProgress, Easing.OUT) * 0.2;
    for (const layer of [this.glowSprite, this.bottomSprite, this.topSprite, this.middle2Sprite, this.middleSprite]) {
      layer.scale.set(bodyScale);
    }
    this.circleSprite.scale.set(1);
    this.backgroundSprite.scale.set(1);
    this.glowSprite.alpha = usesOldStyle ? 1 : clampedProgress;

    this.prepareBonus(settings);

    applyPropertiesToDisplayObject(
      evaluateTransformationsToProperties(OsuClassicSpinner.transformation({ duration, fadeInDuration }), time),
      this.container,
    );
    applyPropertiesToDisplayObject(
      evaluateTransformationsToProperties(
        approachCircleTransformation({
          modHidden,
          duration,
        }),
        time,
      ),
      this.approachCircleSprite,
    );
  }

  private prepareBonus(settings: OsuClassicSpinnerSettings): void {
    const { bonusScore = 0, bonusAge = -1, bonusIsMaximum = false, scoreTextures, scoreOverlap = 0 } = settings;
    if (bonusScore <= 0 || bonusAge < 0 || !scoreTextures) {
      if (this.bonusNumber.parent) this.container.removeChild(this.bonusNumber);
      return;
    }

    this.bonusNumber.prepare({ digits: calculateDigits(bonusScore), textures: scoreTextures, overlap: scoreOverlap });
    // LegacySpinner places score 80 units below the fixed spinner centre. Keep
    // it separate from the rotating/scaling disc and use the skin's score font.
    this.bonusNumber.position.set(0, 80);
    const fadeDuration = bonusIsMaximum ? 500 : 800;
    const fadeProgress = Math.min(1, bonusAge / fadeDuration);
    this.bonusNumber.alpha = 1 - applyEasing(fadeProgress, Easing.OUT);
    const scaleProgress = Math.min(1, bonusAge / (bonusIsMaximum ? 1000 : 800));
    const easedScale = applyEasing(scaleProgress, Easing.OUT);
    this.bonusNumber.scale.set(bonusIsMaximum ? 1.4 + 0.4 * easedScale : 1.25 - 0.45 * easedScale);
    this.bonusNumber.anchorX = 0.5;
    this.bonusNumber.anchorY = 0.5;
    if (!this.bonusNumber.parent) this.container.addChild(this.bonusNumber);
  }
}
