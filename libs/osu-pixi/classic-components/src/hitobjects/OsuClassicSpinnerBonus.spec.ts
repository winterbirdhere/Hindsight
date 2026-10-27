import { BaseTexture, Sprite, Texture } from "pixi.js";
import { OsuClassicSpinner, OsuClassicSpinnerSettings } from "./OsuClassicSpinner";

const textures = Array.from({ length: 10 }, () => new Texture(new BaseTexture(undefined, { width: 24, height: 32 })));
const settings = (overrides: Partial<OsuClassicSpinnerSettings> = {}): OsuClassicSpinnerSettings => ({
  approachCircleTexture: Texture.EMPTY,
  backgroundTexture: Texture.EMPTY,
  bottomTexture: Texture.EMPTY,
  circleTexture: Texture.EMPTY,
  glowTexture: Texture.EMPTY,
  middleTexture: Texture.EMPTY,
  middle2Texture: Texture.EMPTY,
  topTexture: Texture.EMPTY,
  backgroundTint: 0xffffff,
  modHidden: false,
  duration: 5000,
  fadeInDuration: 400,
  rotationDegrees: 0,
  progress: 1,
  time: -1000,
  bonusScore: 1000,
  bonusAge: 0,
  scoreTextures: textures,
  scoreOverlap: 2,
  ...overrides,
});

describe("spinner bonus score", () => {
  it("shows the cumulative bonus in the skin score font below the spinner centre", () => {
    const spinner = new OsuClassicSpinner();
    spinner.prepare(settings());
    expect(spinner.bonusNumber.parent).toBe(spinner.container);
    expect(spinner.bonusNumber.position.x).toBe(0);
    expect(spinner.bonusNumber.position.y).toBe(80);
    expect(spinner.bonusNumber.anchorX).toBe(0.5);
    expect(spinner.bonusNumber.anchorY).toBe(0.5);
    expect((spinner.bonusNumber.children as Sprite[]).map((digit) => textures.indexOf(digit.texture))).toEqual([
      1, 0, 0, 0,
    ]);
    expect(spinner.bonusNumber.children[1].x).toBe(22);
  });

  it("pulses then fades using replay time and reconstructs the same appearance after rewinding", () => {
    const spinner = new OsuClassicSpinner();
    spinner.prepare(settings({ bonusAge: 0 }));
    const startScale = spinner.bonusNumber.scale.x;
    spinner.prepare(settings({ bonusAge: 400 }));
    const halfway = { alpha: spinner.bonusNumber.alpha, scale: spinner.bonusNumber.scale.x };
    expect(halfway.alpha).toBeGreaterThan(0);
    expect(halfway.alpha).toBeLessThan(1);
    expect(halfway.scale).toBeLessThan(startScale);
    spinner.prepare(settings({ bonusAge: 800 }));
    expect(spinner.bonusNumber.alpha).toBe(0);
    spinner.prepare(settings({ bonusAge: 400 }));
    expect({ alpha: spinner.bonusNumber.alpha, scale: spinner.bonusNumber.scale.x }).toEqual(halfway);
  });

  it("removes the bonus before the first award and for the next spinner", () => {
    const spinner = new OsuClassicSpinner();
    spinner.prepare(settings());
    spinner.prepare(settings({ bonusScore: 0, progress: 0 }));
    expect(spinner.bonusNumber.parent).toBeNull();
    spinner.prepare(settings({ bonusAge: -1 }));
    expect(spinner.bonusNumber.parent).toBeNull();
  });

  it("keeps the score visible under Hidden and fades it with the spinner ending", () => {
    const spinner = new OsuClassicSpinner();
    spinner.prepare(settings({ modHidden: true, time: 120, bonusAge: 120 }));
    expect(spinner.bonusNumber.parent).toBe(spinner.container);
    expect(spinner.approachCircleSprite.alpha).toBe(0);
    expect(spinner.container.alpha).toBeGreaterThan(0);
    expect(spinner.container.alpha).toBeLessThan(1);
    spinner.prepare(settings({ time: 240, bonusAge: 240 }));
    expect(spinner.container.alpha).toBe(0);
  });

  it("uses lazer's shorter maximum-bonus celebration without touching shared score textures", () => {
    const spinner = new OsuClassicSpinner();
    spinner.prepare(settings({ bonusIsMaximum: true, bonusScore: 100, bonusAge: 0 }));
    const scale = spinner.bonusNumber.scale.x;
    spinner.prepare(settings({ bonusIsMaximum: true, bonusScore: 100, bonusAge: 500 }));
    expect(spinner.bonusNumber.alpha).toBe(0);
    expect(spinner.bonusNumber.scale.x).toBeGreaterThan(scale);
    spinner.container.destroy({ children: true });
    expect(textures[0].baseTexture.destroyed).toBe(false);
  });
});
