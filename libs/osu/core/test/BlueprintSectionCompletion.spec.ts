import { parseBlueprint } from "../src/blueprint/BlueprintParser";

const minimalMap = `osu file format v14
[General]
Mode:0
[Metadata]
Title:Section ordering
Artist:Fixture
[Difficulty]
CircleSize:4
OverallDifficulty:6
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
100,100,1000,1,0,0:0:0:0:
200,100,2000,1,0,0:0:0:0:
`;

describe("beatmap section completion", () => {
  it("keeps reading a valid minimal map without optional Editor, Events or Colours sections", () => {
    const blueprint = parseBlueprint(minimalMap);
    expect(blueprint.hitObjectSettings.map((object) => object.time)).toEqual([1000, 2000]);
    expect(blueprint.defaultDifficulty.overallDifficulty).toBe(6);
    expect(blueprint.blueprintInfo.metadata.title).toBe("Section ordering");
  });

  it("finishes a selected subset only after every requested section has been read", () => {
    const blueprint = parseBlueprint(minimalMap, { sectionsToRead: ["Metadata", "Difficulty"] });
    expect(blueprint.blueprintInfo.metadata.title).toBe("Section ordering");
    expect(blueprint.defaultDifficulty.overallDifficulty).toBe(6);
    expect(blueprint.hitObjectSettings).toEqual([]);
  });

  it("retains ordinary full maps with optional sections in their usual order", () => {
    const raw = minimalMap
      .replace("[Metadata]", "[Editor]\nDistanceSpacing:1\n[Metadata]")
      .replace("[TimingPoints]", "[Events]\n[TimingPoints]")
      .replace("[HitObjects]", "[Colours]\nCombo1:255,128,0\n[HitObjects]");
    expect(parseBlueprint(raw).hitObjectSettings.map((object) => object.time)).toEqual([1000, 2000]);
  });
});
