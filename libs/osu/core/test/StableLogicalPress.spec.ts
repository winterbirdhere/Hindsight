import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { cloneGameState } from "../src/gameplay/GameState";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { parseReplayFramesFromRaw } from "../src/replays/ReplayParser";

const options = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;

// Expected hit attempts are hand-derived from Stable standard's two logical
// sides. A keyboard discriminator changing cannot release/re-press that side.
const transitionGroups = [
  { previous: [0], attempts: [0, 1, 1, 2, 1, 1, 2, 2, 1, 2, 1, 2, 2, 2, 2, 2] },
  { previous: [1, 4, 5], attempts: [0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
  { previous: [2, 8, 10], attempts: [0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1] },
  { previous: [3, 6, 7, 9, 11, 12, 13, 14, 15], attempts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
];
const transitions = transitionGroups.flatMap((group) =>
  group.previous.flatMap((previous) => group.attempts.map((attempts, next) => ({ previous, next, attempts }))),
);

function targetMap(): Beatmap {
  const circles = [0, 1, 2].map((index) => {
    const circle = new HitCircle();
    Object.assign(circle, {
      id: String(index),
      hitTime: 1_000 + 10 * index,
      approachDuration: 600,
      position: { x: 100, y: 192 },
      unstackedPosition: { x: 100, y: 192 },
    });
    return circle;
  });
  return new Beatmap(circles, DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
}

describe("Stable standard logical input transitions", () => {
  it.each(transitions)("mask $previous → $next supplies $attempts hit attempts", ({ previous, next, attempts }) => {
    const frames = parseReplayFramesFromRaw(`900|450|350|${previous},100|100|192|${next},1|100|192|${next},`);
    const state = new BucketedGameStateTimeMachine(frames, targetMap(), options).gameStateAt(1_001);

    expect(Object.keys(state.hitCircleVerdict)).toHaveLength(attempts);
    for (const verdict of Object.values(state.hitCircleVerdict))
      expect(verdict).toMatchObject({ type: "GREAT", judgementTime: 1_000 });
  });

  it("keeps one real opposite-side press when a held keyboard side changes to mouse, including seek/fork", () => {
    const frames = parseReplayFramesFromRaw("900|450|350|5,100|100|192|3,1|100|192|3,199|100|192|0,");
    const machine = new BucketedGameStateTimeMachine(frames, targetMap(), options, 1);
    const atPress = cloneGameState(machine.gameStateAt(1_000));
    expect(atPress.hitCircleVerdict).toEqual({ "0": { type: "GREAT", judgementTime: 1_000 } });

    const fork = machine.fork();
    machine.gameStateAt(1_200);
    machine.gameStateAt(900);
    fork.gameStateAt(900);
    expect(machine.gameStateAt(1_000)).toEqual(atPress);
    expect(fork.gameStateAt(1_000)).toEqual(atPress);
  });
});
