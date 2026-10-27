import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { stableSliderPathGeometry } from "../src/gameplay/StableSliderPathGeometry";
import { StableSliderTiming } from "../src/gameplay/StableSliderTiming";
import { Slider } from "../src/hitobjects/Slider";

function slider(object: string, speed: number): Slider {
  const map = buildBeatmap(
    parseBlueprint(`osu file format v14
[Difficulty]
SliderMultiplier:1
SliderTickRate:1
[TimingPoints]
0,500,4,2,0,100,1,0
[HitObjects]
${object}
`),
    { addStacking: false, mods: [] },
  );
  const result = map.hitObjects[0] as Slider;
  result.stableTiming = { speed, tickDistance: 100 };
  return result;
}

describe("Stable circular path scalar precision", () => {
  // Literal expectations from a source-shaped .NET Framework x86 calculation;
  // the parent deadlines were also captured from the pinned Stable client.
  it.each([
    ["366,351,6103,2,0,P|430:338|471:229,1,187.000005706787", 779.1666904449471, 6342],
    ["512,287,10543,2,0,P|449:299|390:287,1,118.999996368408", 495.8333182017014, 10782],
    ["450,264,23983,2,0,P|488:253|529:244,1,68", 566.6666666666667, 24103],
  ])("retains scalar precision through the circular path deadline for %s", (object, speed, end) => {
    expect(new StableSliderTiming(slider(String(object), Number(speed))).endTime).toBe(end);
  });

  it("preserves the sampled and trimmed vertices of an independent synthetic arc", () => {
    const object = slider("493,335,1000,2,0,P|463:35|462:448,1,100", 1000);
    const { points } = stableSliderPathGeometry(object);
    expect(points).toHaveLength(14);
    expect(points[2]).toEqual({ x: 495.4227294921875, y: 319.1539306640625 });
    expect(points[13]).toEqual({ x: 500.83648681640625, y: Number("235.43435668945312") });
  });
});
