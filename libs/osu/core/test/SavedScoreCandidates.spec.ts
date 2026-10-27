import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { stableSavedScoreCandidates } from "../src/replays/SavedScoreCandidates";

const map = () =>
  buildBeatmap(
    parseBlueprint(`osu file format v14
[Difficulty]
OverallDifficulty:5
CircleSize:4
ApproachRate:5
SliderMultiplier:1
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
100,100,1000,1,0
100,100,2000,2,0,L|200:100,1,100
256,192,3000,8,0,4000
`),
    { addStacking: false },
  );

it("derives independent successful windows and component deadlines from exact profile geometry", () => {
  const candidates = stableSavedScoreCandidates(
    map(),
    [0, 1000, 1155, 2503, 4000, 4007].map((time) => ({ time })),
  );
  expect(candidates[0]).toMatchObject({
    componentId: "0",
    kind: "circle",
    latestTime: 1155,
    gradeTimeRanges: { GREAT: [951, 1049], OK: [901, 1099], MEH: [851, 1149] },
  });
  expect(candidates[1]).toEqual({ componentId: "1", kind: "slider-parent", earliestTime: 2500, latestTime: 2503 });
  expect(candidates[2]).toEqual({ componentId: "2", kind: "spinner", earliestTime: 4000, latestTime: 4007 });
});

it("does not invent a source update beyond the recording or accept backwards/non-finite input", () => {
  expect(stableSavedScoreCandidates(map(), [{ time: 0 }, { time: 1100 }]).map((c) => c.componentId)).toEqual(["0"]);
  expect(stableSavedScoreCandidates(map(), [{ time: 10 }, { time: 9 }])).toEqual([]);
  expect(stableSavedScoreCandidates(map(), [{ time: NaN }])).toEqual([]);
  expect(stableSavedScoreCandidates(map(), [])).toEqual([]);
});
