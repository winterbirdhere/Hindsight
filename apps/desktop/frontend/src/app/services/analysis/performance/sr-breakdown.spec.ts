import { decomposeStarRating } from "./sr-breakdown";

describe("additive SR decomposition", () => {
  it("preserves raw component proportions while matching the visible total", () => {
    const result = decomposeStarRating({
      total: 5.516153063796767,
      aim: 3.2130354968813166,
      speed: 1.762900637610686,
      reading: 0.6595993162105993,
      flashlight: 0,
      sliderFactor: 0.9979680150824415,
    });

    expect(result).toEqual({
      total: 5.51,
      aim: 3.14,
      speed: 1.72,
      reading: 0.65,
      flashlight: 0,
      sliderAim: 0.01,
    });
    expect(sumComponents(result)).toBe(551);
  });

  it("adds Flashlight without changing Aim, Speed, Reading, or Slider Aim", () => {
    const withoutFlashlight = decomposeStarRating({
      total: 5.3410145520830135,
      aim: 3,
      speed: 2,
      reading: 1,
      flashlight: 0,
      sliderFactor: 0.8,
    });
    const withFlashlight = decomposeStarRating({
      total: 5.579606988316402,
      aim: 3,
      speed: 2,
      reading: 1,
      flashlight: 1,
      sliderFactor: 0.8,
    });

    expect(withoutFlashlight).toEqual({
      total: 5.34,
      aim: 2.67,
      speed: 1.78,
      reading: 0.89,
      flashlight: 0,
      sliderAim: 0.53,
    });
    expect(withFlashlight).toEqual({
      total: 5.57,
      aim: 2.67,
      speed: 1.78,
      reading: 0.89,
      flashlight: 0.23,
      sliderAim: 0.53,
    });
    expect(sumComponents(withFlashlight)).toBe(557);
  });

  it("handles zero and Flashlight-only breakdowns", () => {
    expect(
      decomposeStarRating({
        total: 0,
        aim: 0,
        speed: 0,
        reading: 0,
        flashlight: 0,
        sliderFactor: 1,
      }),
    ).toEqual({
      total: 0,
      aim: 0,
      speed: 0,
      reading: 0,
      flashlight: 0,
      sliderAim: 0,
    });

    const flashlightOnly = decomposeStarRating({
      total: 4.999,
      aim: 0,
      speed: 0,
      reading: 0,
      flashlight: 1,
      sliderFactor: 1,
    });

    expect(flashlightOnly).toEqual({
      total: 4.99,
      aim: 0,
      speed: 0,
      reading: 0,
      flashlight: 4.99,
      sliderAim: 0,
    });
    expect(sumComponents(flashlightOnly)).toBe(499);
  });

  it("allocates tied hundredths deterministically and keeps Slider Aim inside Aim", () => {
    const result = decomposeStarRating({
      total: 2.2997195105345853,
      aim: 1,
      speed: 1,
      reading: 1,
      flashlight: 0,
      sliderFactor: 0.5,
    });

    expect(result).toEqual({
      total: 2.29,
      aim: 0.77,
      speed: 0.76,
      reading: 0.76,
      flashlight: 0,
      sliderAim: 0.39,
    });
    expect(result.sliderAim).toBeLessThanOrEqual(result.aim);
    expect(sumComponents(result)).toBe(229);
  });

  it("keeps a dominant component understandable instead of amplifying it", () => {
    const result = decomposeStarRating({
      total: 7.19,
      aim: 4.2,
      speed: 2.13,
      reading: 1.36,
      flashlight: 0,
      sliderFactor: 0.983,
    });

    expect(result).toEqual({
      total: 7.19,
      aim: 3.93,
      speed: 1.99,
      reading: 1.27,
      flashlight: 0,
      sliderAim: 0.07,
    });
    expect(sumComponents(result)).toBe(719);
  });
});

function sumComponents(result: ReturnType<typeof decomposeStarRating>): number {
  return Math.round((result.aim + result.speed + result.reading + result.flashlight) * 100);
}
