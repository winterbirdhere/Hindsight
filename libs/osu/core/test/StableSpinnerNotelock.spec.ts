import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { cloneGameState } from "../src/gameplay/GameState";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { NoteLockStyle } from "../src/gameplay/GameStateEvaluator";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const frame = (time: number, held = false): ReplayFrame => ({
  time,
  position: { x: 400, y: 192 },
  actions: held ? [OsuAction.leftButton] : [],
});

function machine(target: string, frames: ReplayFrame[], noteLockStyle: NoteLockStyle = "STABLE", spinnerStart = 1000) {
  const beatmap = buildBeatmap(
    parseBlueprint(`osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:9
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
256,192,${spinnerStart},8,0,1500
${target}
`),
    { addStacking: false },
  );
  return new BucketedGameStateTimeMachine(frames, beatmap, { hitWindowStyle: "OSU_STABLE", noteLockStyle }, 1);
}

describe("Stable spinner notelock", () => {
  it.each([
    ["circle", "400,192,1600,1,0", "1"],
    ["slider head", "400,192,1600,2,0,L|450:192,1,50", "1/HEAD"],
  ])("blocks a premature %s press until the earlier spinner resolves", (_, target, id) => {
    const replay = machine(target, [
      frame(900),
      frame(1000),
      frame(1460, true),
      frame(1501),
      frame(1600, true),
      frame(1900),
    ]);
    expect(replay.gameStateAt(1460).hitCircleVerdict[id]).toBeUndefined();
    const fork = replay.fork();
    const final = cloneGameState(replay.gameStateAt(Infinity));
    expect(final.hitCircleVerdict[id]).toMatchObject({ type: "GREAT", judgementTime: 1600 });
    replay.gameStateAt(900);
    expect(replay.gameStateAt(Infinity)).toEqual(final);
    expect(fork.gameStateAt(Infinity)).toEqual(final);
  });

  it("blocks an earlier spinner before its active spinning interval starts", () => {
    const replay = machine(
      "400,192,1600,1,0",
      [frame(900), frame(1399, true), frame(1501), frame(1600, true)],
      "STABLE",
      1400,
    );
    expect(replay.gameStateAt(1399).hitCircleVerdict["1"]).toBeUndefined();
    expect(replay.gameStateAt(Infinity).hitCircleVerdict["1"]).toMatchObject({ type: "GREAT" });
  });

  it.each([0, 3])("permits overlap/unsnapped leniency when the next note starts %s ms after spinner end", (gap) => {
    const replay = machine(`400,192,${1500 + gap},1,0`, [frame(900), frame(1460, true)]);
    expect(replay.gameStateAt(Infinity).hitCircleVerdict["1"]).toMatchObject({ type: "OK", judgementTime: 1460 });
  });

  it("retains an exact-end spinner blocker through the input phase and reports causal evidence", () => {
    const replay = machine("400,192,1504,1,0", [frame(900), frame(1500, true), frame(1501), frame(1620)]);
    const exactEnd = replay.gameStateAt(1500);
    expect(exactEnd.hitCircleVerdict["1"]).toBeUndefined();
    expect(exactEnd.stableNotelockEvidence["1"]).toMatchObject({
      blockerHitObjectId: "0",
      pressTime: 1500,
      wouldHaveHit: "GREAT",
    });
    expect(replay.gameStateAt(Infinity).hitCircleVerdict["1"]).toMatchObject({
      type: "MISS",
      missReason: "TIME_EXPIRED",
    });
  });

  it("does not add Stable spinner blocking when notelock is disabled", () => {
    const replay = machine("400,192,1600,1,0", [frame(900), frame(1460, true)], "NONE");
    expect(replay.gameStateAt(Infinity).hitCircleVerdict["1"]).toMatchObject({
      type: "MISS",
      missReason: "HIT_TOO_EARLY",
    });
  });
});
