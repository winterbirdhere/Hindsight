import { evaluateTransformationsToProperties } from "../utils/Pixi";
import { OsuClassicSliderBody } from "./OsuClassicSliderBody";
import { OsuClassicSliderRepeat } from "./OsuClassicSliderRepeat";
import { OsuClassicSliderTick } from "./OsuClassicSliderTick";

describe("Stable slider visuals", () => {
  it("fades a completed slider body over the legacy 240 ms window", () => {
    const transformation = OsuClassicSliderBody.transformation({
      approachDuration: 600,
      duration: 1_000,
      modHidden: false,
      position: { x: 100, y: 200 },
    });

    expect(evaluateTransformationsToProperties(transformation, 1_000).alpha).toBe(1);
    expect(evaluateTransformationsToProperties(transformation, 1_120).alpha).toBeGreaterThan(0);
    expect(evaluateTransformationsToProperties(transformation, 1_120).alpha).toBeLessThan(1);
    expect(evaluateTransformationsToProperties(transformation, 1_240).alpha).toBe(0);
  });

  it("keeps an unresolved tick neutral instead of assuming a future hit or miss", () => {
    const unresolved = OsuClassicSliderTick.normalTransformation({ approachDuration: 400, hit: null, scale: 0.5 });
    const missed = OsuClassicSliderTick.normalTransformation({ approachDuration: 400, hit: false, scale: 0.5 });

    expect(evaluateTransformationsToProperties(unresolved, 100).alpha).toBe(1);
    expect(evaluateTransformationsToProperties(missed, 100).alpha).toBeLessThan(1);
  });

  it("grows ticks from half size and pops successful ticks outward", () => {
    const base = { approachDuration: 800, scale: 0.5 };
    const unresolved = OsuClassicSliderTick.normalTransformation({ ...base, hit: null });
    const hit = OsuClassicSliderTick.normalTransformation({ ...base, hit: true });
    const miss = OsuClassicSliderTick.normalTransformation({ ...base, hit: false });

    expect(evaluateTransformationsToProperties(unresolved, -800).scale).toBeCloseTo(0.25);
    expect(evaluateTransformationsToProperties(unresolved, -200).scale).toBeCloseTo(0.5);
    expect(evaluateTransformationsToProperties(hit, 75).scale).toBeGreaterThan(
      evaluateTransformationsToProperties(miss, 75).scale as number,
    );
    expect(evaluateTransformationsToProperties(hit, 150).scale).toBeCloseTo(0.75);
  });

  it("uses Stable's fixed 300 ms reverse-arrow pulse and 150 ms fade-in", () => {
    const transformation = OsuClassicSliderRepeat.normalTransformation({
      approachDuration: 600,
      fadeInOutDuration: 300,
      hit: null,
      scale: 0.5,
    });

    expect(OsuClassicSliderRepeat.LEGACY_PULSE_DURATION).toBe(300);
    expect(OsuClassicSliderRepeat.LEGACY_FADE_IN_DURATION).toBe(150);
    expect(evaluateTransformationsToProperties(transformation, -600).scale).toBeCloseTo(0.65);
    expect(evaluateTransformationsToProperties(transformation, -450).alpha).toBe(1);
    expect(evaluateTransformationsToProperties(transformation, -450).scale).toBeCloseTo(
      evaluateTransformationsToProperties(transformation, -150).scale as number,
    );
    expect(evaluateTransformationsToProperties(transformation, -300).scale).toBeCloseTo(0.5);
  });

  it("pops a successful repeat outward while a missed repeat keeps pulsing", () => {
    const base = { approachDuration: 600, fadeInOutDuration: 300, scale: 0.5 };
    const hit = OsuClassicSliderRepeat.normalTransformation({ ...base, hit: true });
    const miss = OsuClassicSliderRepeat.normalTransformation({ ...base, hit: false });
    const hitHalfway = evaluateTransformationsToProperties(hit, 150);
    const missHalfway = evaluateTransformationsToProperties(miss, 150);

    expect(hitHalfway.alpha).toBeGreaterThan(0);
    expect(hitHalfway.alpha).toBeLessThan(1);
    expect(missHalfway.alpha).toBeCloseTo(0.5);
    expect(hitHalfway.scale).toBeGreaterThan(missHalfway.scale as number);
    expect(evaluateTransformationsToProperties(hit, 300).scale).toBeCloseTo(0.7);
    expect(evaluateTransformationsToProperties(hit, 300).alpha).toBe(0);
  });
});
