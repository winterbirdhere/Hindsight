import { Texture } from "pixi.js";
import { OsuClassicJudgement } from "../hud/OsuClassicJudgement";
import { evaluateTransformationsToProperties } from "../utils/Pixi";
import { OsuClassicApproachCircle } from "./OsuClassicApproachCircle";
import { OsuClassicSpinner, OsuClassicSpinnerSettings } from "./OsuClassicSpinner";

const spinnerSettings = (overrides: Partial<OsuClassicSpinnerSettings> = {}): OsuClassicSpinnerSettings => ({
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
  duration: 1_000,
  fadeInDuration: 400,
  rotationDegrees: 0,
  progress: 0,
  time: -500,
  ...overrides,
});

describe("Stable gameplay visuals", () => {
  describe("approach circle", () => {
    it("fades to Stable's 90% opacity while shrinking from four times size", () => {
      const approachCircle = new OsuClassicApproachCircle({
        approachDuration: 600,
        hitResult: null,
        modHidden: false,
        position: { x: 256, y: 192 },
        scale: 0.5,
        texture: Texture.EMPTY,
      });

      const transformation = approachCircle.normalTransformation();
      const spawn = evaluateTransformationsToProperties(transformation, -600);
      const halfway = evaluateTransformationsToProperties(transformation, -300);
      const hitTime = evaluateTransformationsToProperties(transformation, 0);

      expect(spawn.alpha).toBe(0);
      expect(spawn.scale).toBe(2);
      expect(halfway.alpha).toBeCloseTo(0.45);
      expect(hitTime.alpha).toBeCloseTo(0.9);
      expect(hitTime.scale).toBeCloseTo(0.5);
    });
  });

  describe("spinner", () => {
    it("centres every skin layer in the playfield and shrinks the approach circle", () => {
      const spinner = new OsuClassicSpinner();
      spinner.prepare(spinnerSettings());

      expect(spinner.container.position.x).toBe(256);
      expect(spinner.container.position.y).toBe(192);
      expect(spinner.container.children).toHaveLength(8);

      for (const layer of spinner.container.children) {
        expect(layer.position.x).toBe(0);
        expect(layer.position.y).toBe(0);
      }

      expect(spinner.approachCircleSprite.anchor.x).toBe(0.5);
      expect(spinner.approachCircleSprite.anchor.y).toBe(0.5);
      expect(spinner.approachCircleSprite.scale.x).toBeCloseTo(0.5);
      expect(spinner.approachCircleSprite.scale.y).toBeCloseTo(0.5);
    });

    it("uses osu!'s pre-start fade-in and Stable 240 ms end fade", () => {
      const spinner = new OsuClassicSpinner();

      spinner.prepare(spinnerSettings({ time: -1_400 }));
      expect(spinner.container.alpha).toBe(0);

      spinner.prepare(spinnerSettings({ time: -1_200 }));
      expect(spinner.container.alpha).toBeCloseTo(0.5);

      spinner.prepare(spinnerSettings({ time: -1_000 }));
      expect(spinner.container.alpha).toBe(1);

      spinner.prepare(spinnerSettings({ time: 0 }));
      expect(spinner.container.alpha).toBe(1);

      spinner.prepare(spinnerSettings({ time: 120 }));
      expect(spinner.container.alpha).toBeGreaterThan(0);
      expect(spinner.container.alpha).toBeLessThan(1);

      spinner.prepare(spinnerSettings({ time: OsuClassicSpinner.FADE_OUT_DURATION }));
      expect(OsuClassicSpinner.FADE_OUT_DURATION).toBe(240);
      expect(spinner.container.alpha).toBe(0);
    });

    it("forces old style when a spinner background is supplied", () => {
      const spinner = new OsuClassicSpinner();
      const backgroundTexture = Texture.EMPTY.clone();
      spinner.prepare(spinnerSettings({ backgroundTexture }));

      expect(spinner.backgroundSprite.visible).toBe(true);
      expect(spinner.circleSprite.visible).toBe(true);
      expect(spinner.glowSprite.visible).toBe(false);
      expect(spinner.bottomSprite.visible).toBe(false);
      expect(spinner.topSprite.visible).toBe(false);
      expect(spinner.middle2Sprite.visible).toBe(false);
      expect(spinner.middleSprite.visible).toBe(false);
    });

    it("rotates only the old-style disc from signed replay rotation", () => {
      const spinner = new OsuClassicSpinner();
      const backgroundTexture = Texture.EMPTY.clone();
      spinner.prepare(spinnerSettings({ backgroundTexture, rotationDegrees: 90, progress: 0.5 }));

      expect(spinner.circleSprite.rotation).toBeCloseTo(Math.PI / 2);
      expect(spinner.backgroundSprite.rotation).toBe(0);
      expect(spinner.approachCircleSprite.rotation).toBe(0);
    });

    it("uses Stable's new-style layer rotation ratios and progress presentation", () => {
      const spinner = new OsuClassicSpinner();
      const middle2Texture = Texture.EMPTY.clone();
      spinner.prepare(spinnerSettings({ middle2Texture, rotationDegrees: 120, progress: 0.5 }));

      expect(spinner.middle2Sprite.rotation).toBeCloseTo((120 * Math.PI) / 180);
      expect(spinner.topSprite.rotation).toBeCloseTo((60 * Math.PI) / 180);
      expect(spinner.bottomSprite.rotation).toBeCloseTo((20 * Math.PI) / 180);
      expect(spinner.middleSprite.rotation).toBe(0);
      expect(spinner.approachCircleSprite.rotation).toBe(0);
      expect(spinner.glowSprite.alpha).toBeCloseTo(0.5);
      expect(spinner.topSprite.scale.x).toBeCloseTo(0.95);
      expect(spinner.topSprite.scale.y).toBeCloseTo(0.95);
    });

    it("rotates spinner-top at full speed when spinner-middle2 is absent", () => {
      const spinner = new OsuClassicSpinner();
      spinner.prepare(spinnerSettings({ rotationDegrees: -90, progress: 1 }));

      expect(spinner.topSprite.rotation).toBeCloseTo(-Math.PI / 2);
      expect(spinner.bottomSprite.rotation).toBeCloseTo(-Math.PI / 6);
      expect(spinner.topSprite.scale.x).toBe(1);
    });

    it("hides only the approach circle under Hidden", () => {
      const spinner = new OsuClassicSpinner();
      spinner.prepare(spinnerSettings({ modHidden: true }));

      expect(spinner.approachCircleSprite.alpha).toBe(0);
      expect(spinner.container.alpha).toBe(1);
      expect(spinner.bottomSprite.visible).toBe(true);
    });
  });

  describe("miss judgement", () => {
    it("falls downward while fading without changing horizontal position", () => {
      const start = { x: 160, y: 120 };
      const transformation = OsuClassicJudgement.missTransformation(0.6, start);
      const halfway = evaluateTransformationsToProperties(
        transformation,
        OsuClassicJudgement.MISS_ANIMATION_DURATION / 2,
      );
      const finished = evaluateTransformationsToProperties(transformation, OsuClassicJudgement.MISS_ANIMATION_DURATION);

      expect(halfway.position?.x).toBe(start.x);
      expect(halfway.position?.y).toBeGreaterThan(start.y);
      expect(halfway.alpha).toBeGreaterThan(0);
      expect(halfway.alpha).toBeLessThan(1);
      expect(finished.position).toEqual({
        x: start.x,
        y: start.y + OsuClassicJudgement.MISS_START_Y_OFFSET + OsuClassicJudgement.MISS_FALL_DISTANCE,
      });
      expect(finished.alpha).toBe(0);
    });

    it("uses the Stable miss fade and contraction timings", () => {
      const transformation = OsuClassicJudgement.missTransformation(0.5, { x: 10, y: 20 });
      const start = evaluateTransformationsToProperties(transformation, 0);
      const fadedIn = evaluateTransformationsToProperties(transformation, OsuClassicJudgement.MISS_FADE_IN_DURATION);
      const fadeOutStart = evaluateTransformationsToProperties(transformation, OsuClassicJudgement.MISS_FADE_OUT_DELAY);
      const contracted = evaluateTransformationsToProperties(transformation, OsuClassicJudgement.MISS_SCALE_DURATION);

      expect(start.alpha).toBe(0);
      expect(start.scale).toBeCloseTo(0.8);
      expect(start.position?.y).toBe(15);
      expect(fadedIn.alpha).toBe(1);
      expect(fadeOutStart.alpha).toBe(1);
      expect(contracted.scale).toBeCloseTo(0.5);
      expect(OsuClassicJudgement.MISS_ANIMATION_DURATION).toBe(1_100);
    });

    it("keeps the normal judgement position fixed", () => {
      const position = { x: 300, y: 220 };
      const transformation = OsuClassicJudgement.normalTransformation(0.6, position);

      expect(evaluateTransformationsToProperties(transformation, 500).position).toEqual(position);
    });

    it("selects the miss path from the verdict flag", () => {
      const judgement = new OsuClassicJudgement();
      judgement.prepare({
        time: OsuClassicJudgement.MISS_ANIMATION_DURATION / 2,
        position: { x: 100, y: 200 },
        scale: 0.6,
        textures: [Texture.EMPTY],
        animationFrameRate: 60,
        isMiss: true,
      });

      expect(judgement.sprite.position.x).toBe(100);
      expect(judgement.sprite.position.y).toBeGreaterThan(200);
    });
  });
});
