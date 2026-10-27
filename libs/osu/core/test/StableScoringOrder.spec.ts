import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { GameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

function fixture(hitObjects: string, frames: ReplayFrame[]) {
  const map = buildBeatmap(
    parseBlueprint(`osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:9
ApproachRate:9
SliderMultiplier:3.6
SliderTickRate:1
[TimingPoints]
0,360,4,1,0,100,1,0
[HitObjects]
${hitObjects}
`),
    { addStacking: false },
  );
  const machine = new BucketedGameStateTimeMachine(
    frames,
    map,
    { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
    1,
  );
  return { map, machine };
}

function frame(time: number, x: number, held = true): ReplayFrame {
  return { time, position: { x, y: 192 }, actions: held ? [OsuAction.leftButton] : [] };
}

describe("Stable scoring within one recorded update", () => {
  it("keeps an exact-end spinner alive until a later clock, after a same-frame circle expiry", () => {
    const { map, machine } = fixture("256,192,1000,8,0,1111\n300,100,1000,1,0", [
      frame(900, 256, false),
      frame(1111, 256, false),
      frame(1111.5, 256, false),
    ]);
    const exactEnd = machine.gameStateAt(1111);
    expect(exactEnd.spinnerVerdict["0"]).toBeUndefined();
    expect(exactEnd.judgedObjects).toEqual(["1"]);
    const later = machine.gameStateAt(1111.5);
    expect(later.spinnerVerdict["0"]).toEqual({ type: "GREAT", judgementTime: 1111.5 });
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(later).currentCombo).toBe(1);
    // The pending end is reconstructed from the cached alive state on a seek/fork.
    machine.gameStateAt(1111);
    expect(machine.fork().gameStateAt(1111.5).judgedObjects).toEqual(["1", "0"]);
  });

  it("finishes an earlier slider before a later circle expires in the same sparse update", () => {
    const { map, machine } = fixture("64,192,1000,2,0,L|164:192,1,100\n300,192,1120,1,0", [
      frame(900, 64, false),
      frame(1000, 64),
      frame(1050, 114),
      frame(1240, 164),
    ]);
    const final = machine.gameStateAt(1240);
    expect(final.judgedObjects).toEqual(["0/HEAD", "0/0", "0", "1"]);
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(final)).toMatchObject({
      verdictCounts: [1, 0, 0, 1],
      maxComboSoFar: 2,
      currentCombo: 0,
    });
    const fork = machine.fork();
    machine.gameStateAt(1000);
    expect(machine.gameStateAt(1240).judgedObjects).toEqual(final.judgedObjects);
    fork.gameStateAt(1050);
    expect(fork.gameStateAt(1240).judgedObjects).toEqual(final.judgedObjects);
  });

  it("includes exact-time checkpoints in the same parent-ordered update as overdue circle expiry", () => {
    const { map, machine } = fixture("64,192,1000,2,0,L|264:192,1,200\n300,100,1050,1,0", [
      frame(900, 64, false),
      frame(1000, 64),
      frame(1150, 214),
      frame(1164, 228),
    ]);
    const state = machine.gameStateAt(1164);
    expect(state.judgedObjects).toEqual(["0/HEAD", "0/0", "1"]);
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(state)).toMatchObject({
      maxComboSoFar: 2,
      currentCombo: 0,
    });
  });

  it("scores a later spinner after an earlier circle expires in the same update", () => {
    const { map, machine } = fixture("300,100,900,1,0\n256,192,1000,8,0,1100", [
      frame(850, 256, false),
      frame(1000, 256, false),
      frame(1120, 256, false),
    ]);
    const state = machine.gameStateAt(1120);
    expect(state.judgedObjects).toEqual(["0", "1"]);
    expect(state.spinnerVerdict["1"]).toEqual({ type: "GREAT", judgementTime: 1120 });
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(state)).toMatchObject({
      verdictCounts: [1, 0, 0, 1],
      currentCombo: 1,
    });
  });
});
