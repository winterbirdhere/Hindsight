import { RGB } from "@osujs/math";
import { SkinConfig } from "@rewind/osu/skin";

export function toRgb(color: readonly number[]): RGB {
  return [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0];
}

export function resolveSliderBodyColor(colors: SkinConfig["colors"], comboSetIndex: number): RGB {
  if (colors.sliderTrackOverride) return toRgb(colors.sliderTrackOverride);

  const comboColors = colors.comboColors;
  const comboColor = comboColors.length > 0 ? comboColors[comboSetIndex % comboColors.length] : [0, 0, 0];
  return toRgb(comboColor);
}
