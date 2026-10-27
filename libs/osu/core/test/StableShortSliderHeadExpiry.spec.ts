import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { cloneGameState } from "../src/gameplay/GameState";
import { GameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

function fixture(frames: ReplayFrame[]) {
  const map = buildBeatmap(
    parseBlueprint(`osu file format v14
[Difficulty]
CircleSize:4
OverallDifficulty:9
SliderMultiplier:3.6
SliderTickRate:1
[TimingPoints]
0,360,4,1,0,100,1,0
[HitObjects]
100,192,1000,2,0,L|140:192,1,40
300,192,1060,1,0
`),
    { addStacking: false },
  );
  return {
    map,
    machine: new BucketedGameStateTimeMachine(
      frames,
      map,
      {
        hitWindowStyle: "OSU_STABLE",
        noteLockStyle: "STABLE",
      },
      1,
    ),
  };
}

function frame(time: number, x: number, actions: OsuAction[] = [OsuAction.leftButton]): ReplayFrame {
  return { time, position: { x, y: 192 }, actions };
}

describe("Stable short slider head expiry", () => {
  it("judges the parent first, then expires its unhit head at the original window", () => {
    const { map, machine } = fixture([
      frame(900, 450),
      frame(1000, 100),
      frame(1020, 120),
      frame(1040, 140),
      frame(1050, 300, []),
      frame(1060, 300),
      frame(1111, 300),
    ]);
    const ended = cloneGameState(machine.gameStateAt(1040));
    expect(ended.sliderVerdict["0"]).toBe("OK");
    expect(ended.hitCircleVerdict["0/HEAD"]).toBeUndefined();
    expect(ended.aliveHitCircleIds.has("0/HEAD")).toBe(true);
    const fork = machine.fork();
    const final = cloneGameState(machine.gameStateAt(Infinity));
    expect(final.hitCircleVerdict["0/HEAD"]).toEqual({ type: "MISS", judgementTime: 1111, missReason: "TIME_EXPIRED" });
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(final)).toMatchObject({
      verdictCounts: [1, 1, 0, 0],
      maxComboSoFar: 2,
      currentCombo: 0,
    });
    machine.gameStateAt(900);
    expect(machine.gameStateAt(1040)).toEqual(ended);
    expect(machine.gameStateAt(Infinity)).toEqual(final);
    expect(fork.gameStateAt(Infinity)).toEqual(final);
  });

  it("does not accept a head press after its parent has been judged", () => {
    const { machine } = fixture([
      frame(900, 450),
      frame(1000, 100),
      frame(1020, 120),
      frame(1040, 140),
      frame(1041, 100, []),
      frame(1050, 100),
      frame(1111, 100),
    ]);
    expect(machine.gameStateAt(1050).hitCircleVerdict["0/HEAD"]).toBeUndefined();
    expect(machine.gameStateAt(Infinity).hitCircleVerdict["0/HEAD"]).toMatchObject({
      type: "MISS",
      judgementTime: 1111,
    });
    expect(machine.gameStateAt(Infinity).sliderVerdict["0"]).toBe("OK");
  });

  it("still accepts a press at the parent-ending update before the parent judgement", () => {
    const { machine } = fixture([
      frame(900, 450),
      frame(1000, 100),
      frame(1020, 120),
      frame(1040, 100, [OsuAction.leftButton, OsuAction.rightButton]),
      frame(1111, 100),
    ]);
    const state = machine.gameStateAt(Infinity);
    expect(state.hitCircleVerdict["0/HEAD"]).toMatchObject({ type: "OK", judgementTime: 1040 });
    expect(state.sliderVerdict["0"]).toBe("GREAT");
  });
});
