import { evaluateTransformationsToProperties } from "../utils/Pixi";
import { OsuLazerSliderMissJudgement } from "./OsuLazerSliderMissJudgement";

describe("lazer legacy slider-component miss judgement", () => {
  const position = { x: 128, y: 96 };

  it("matches the official short missed-tick contraction", () => {
    const transformation = OsuLazerSliderMissJudgement.transformation(0.5, position);
    const started = evaluateTransformationsToProperties(transformation, 0);
    const halfway = evaluateTransformationsToProperties(transformation, 50);
    const contracted = evaluateTransformationsToProperties(transformation, OsuLazerSliderMissJudgement.SCALE_DURATION);

    expect(started.scale).toBeCloseTo(0.6);
    // osu-framework Easing.In is quadratic: only 25% of the contraction has
    // happened halfway through the 100 ms transform.
    expect(halfway.scale).toBeCloseTo(0.575);
    expect(contracted.scale).toBeCloseTo(0.5);
  });

  it("fades in for 120 ms, then fades out from 250 ms through 850 ms", () => {
    const transformation = OsuLazerSliderMissJudgement.transformation(1, position);
    const atStart = evaluateTransformationsToProperties(transformation, 0);
    const fadedIn = evaluateTransformationsToProperties(transformation, OsuLazerSliderMissJudgement.FADE_IN_DURATION);
    const fadeOutStart = evaluateTransformationsToProperties(
      transformation,
      OsuLazerSliderMissJudgement.FADE_OUT_DELAY,
    );
    const finished = evaluateTransformationsToProperties(
      transformation,
      OsuLazerSliderMissJudgement.ANIMATION_DURATION,
    );

    expect(atStart.alpha).toBe(0);
    expect(fadedIn.alpha).toBe(1);
    expect(fadeOutStart.alpha).toBe(1);
    expect(finished.alpha).toBe(0);
    expect(OsuLazerSliderMissJudgement.ANIMATION_DURATION).toBe(850);
  });
});
