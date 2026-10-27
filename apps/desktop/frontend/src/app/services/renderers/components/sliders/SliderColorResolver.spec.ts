import { generateDefaultSkinConfig } from "@rewind/osu/skin";
import { resolveSliderBodyColor } from "./SliderColorResolver";

describe("resolveSliderBodyColor", () => {
  it("uses SliderTrackOverride ahead of the combo colour and ignores its alpha channel", () => {
    const colors = generateDefaultSkinConfig(true).colors;
    colors.comboColors = [[10, 20, 30]];
    colors.sliderTrackOverride = [70, 80, 90, 40];

    expect(resolveSliderBodyColor(colors, 0)).toEqual([70, 80, 90]);
  });

  it("falls back to the slider head's combo colour with combo wrapping", () => {
    const colors = generateDefaultSkinConfig(true).colors;
    colors.comboColors = [
      [10, 20, 30],
      [40, 50, 60],
    ];
    colors.sliderTrackOverride = undefined;

    expect(resolveSliderBodyColor(colors, 3)).toEqual([40, 50, 60]);
  });
});
