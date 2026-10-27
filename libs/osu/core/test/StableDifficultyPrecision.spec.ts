import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { OsuClassicMod } from "../src/mods/Mods";
import { parseReplayFramesFromRaw } from "../src/replays/ReplayParser";

const options = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;

function mapAtOD(od: number, mods: OsuClassicMod[] = [], objects = "100,192,1000,1,0") {
  return buildBeatmap(
    parseBlueprint(`osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:${od}
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
${objects}
`),
    { addStacking: false, mods },
  );
}

describe("Stable difficulty precision", () => {
  it.each<{ od: number; mods: OsuClassicMod[]; lastMeh: number }>([
    { od: 9.6, mods: [], lastMeh: 102 },
    { od: 9.8, mods: [], lastMeh: 100 },
    { od: 9.3, mods: [], lastMeh: 105 },
    { od: 9.2, mods: [], lastMeh: 107 },
    // Mods operate in double precision after reading the base OD as a float.
    // Rounding the final HR OD9.1 to float instead would incorrectly give107.
    { od: 6.5, mods: ["HARD_ROCK"], lastMeh: 108 },
    { od: 9.6, mods: ["EASY"], lastMeh: 150 },
  ])("uses Stable's last successful 50 boundary at OD$od with $mods", ({ od, mods, lastMeh }) => {
    const map = mapAtOD(od, mods);
    for (const [delta, type] of [
      [lastMeh, "MEH"],
      [lastMeh + 1, "MISS"],
    ] as const) {
      const frames = parseReplayFramesFromRaw(`900|450|350|0,${100 + delta}|100|192|5,`);
      const state = new BucketedGameStateTimeMachine(frames, map, options).gameStateAt(Infinity);
      expect(state.hitCircleVerdict["0"]).toMatchObject({ type, judgementTime: 1_000 + delta });
    }
  });

  it("expires an OD9.6 circle at its recorded 104ms update before the next input", () => {
    const map = mapAtOD(9.6, [], "100,192,1000,1,0\n300,192,1110,1,0");
    const frames = parseReplayFramesFromRaw("900|450|350|0,204|300|192|0,6|300|192|5,");
    const state = new BucketedGameStateTimeMachine(frames, map, options).gameStateAt(Infinity);

    expect(state.hitCircleVerdict).toEqual({
      "0": { type: "MISS", missReason: "TIME_EXPIRED", judgementTime: 1_104 },
      "1": { type: "GREAT", judgementTime: 1_110 },
    });
    expect(state.stableNotelockEvidence).toEqual({});
  });

  it("retains native Lazer's independent OD9.6 window and the shared display difficulty", () => {
    const map = mapAtOD(9.6);
    const frames = parseReplayFramesFromRaw("900|450|350|0,203|100|192|5,");
    const state = new LazerGameStateTimeMachine(frames, map).gameStateAt(1_103);

    expect(state.hitCircleVerdict["0"]).toMatchObject({ type: "MEH", judgementTime: 1_103 });
    expect(map.difficulty.overallDifficulty).toBe(9.6);
  });
});
