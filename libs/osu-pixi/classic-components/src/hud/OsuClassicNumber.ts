import { Container, Sprite, Texture } from "pixi.js";

export type OsuClassicNumberSettings = {
  digits: number[];
  textures: Texture[];
  overlap: number;
};

export const DEFAULT_NUMBER_TEXTURES: Texture[] = Array(10).fill(Texture.EMPTY);

const DEFAULT_NUMBER_SETTINGS: OsuClassicNumberSettings = {
  digits: [0],
  textures: DEFAULT_NUMBER_TEXTURES,
  overlap: 0,
};

/**
 * This number can be used for hitCircleCombo, currentCombo and score
 * TODO: Do not extend from Container
 */
export class OsuClassicNumber extends Container {
  private settings: OsuClassicNumberSettings;

  constructor() {
    super();
    this.settings = DEFAULT_NUMBER_SETTINGS;
  }

  // Trick
  // https://github.com/pixijs/pixijs/issues/3272#issuecomment-349359529
  _anchorX = 0;
  _anchorY = 0;

  set anchorX(value) {
    this._anchorX = value;
    this.pivot.x = (value * this.width) / this.scale.x;
  }

  get anchorX() {
    return this._anchorX;
  }

  set anchorY(value) {
    this._anchorY = value;
    this.pivot.y = (value * this.height) / this.scale.y;
  }

  get anchorY() {
    return this._anchorY;
  }

  prepare(settings: OsuClassicNumberSettings): void {
    this.settings = Object.freeze({ ...this.settings, ...settings });

    const { digits, overlap, textures } = this.settings;

    // Skin textures are shared by all numbers; only dispose surplus sprites.
    while (this.children.length > digits.length) {
      this.removeChildAt(this.children.length - 1).destroy({ children: true });
    }

    let totalWidth = 0;

    for (let i = 0; i < digits.length; i++) {
      const digit = digits[i];
      const texture = textures[digit];
      const sprite = (this.children[i] as Sprite | undefined) ?? this.addChild(new Sprite(texture));
      sprite.texture = texture;
      const addOverlap = i > 0 ? -overlap : 0; //
      sprite.anchor.set(0, 0);
      sprite.position.set(totalWidth + addOverlap, 0);
      totalWidth += texture.width + addOverlap;
    }
  }
}
