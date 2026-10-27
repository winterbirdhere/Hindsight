import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { cloneGameState } from "../src/gameplay/GameState";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const frame = (time: number, x: number, actions: OsuAction[] = []): ReplayFrame => ({
  time,
  position: { x, y: 192 },
  actions,
});

function machine(objects: string, frames: ReplayFrame[]) {
  const map = buildBeatmap(
    parseBlueprint(`osu file format v14
[Difficulty]
CircleSize:4
OverallDifficulty:9
ApproachRate:9
SliderMultiplier:1
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
${objects}
`),
    { addStacking: false },
  );
  return new BucketedGameStateTimeMachine(frames, map, { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" }, 1);
}

describe("Stable geometric target selection precedes ordered policy", () => {
  it.each([0, 1, 3])("permits an off-target earlier circle within %i ms of the selected target", (gap) => {
    const timeline = machine(`100,192,1000,1,0\n300,192,${1000 + gap},1,0`, [
      frame(900, 300),
      frame(1000 + gap, 300, [OsuAction.leftButton]),
    ]);
    const state = timeline.gameStateAt(Infinity);
    expect(state.hitCircleVerdict["0"]).toBeUndefined();
    expect(state.hitCircleVerdict["1"]).toMatchObject({ type: "GREAT", judgementTime: 1000 + gap });
    expect(state.stableNotelockEvidence["1"]).toBeUndefined();
  });

  it("still blocks an off-target earlier circle when the gap exceeds three milliseconds", () => {
    const timeline = machine("100,192,1000,1,0\n300,192,1004,1,0", [
      frame(900, 300),
      frame(1004, 300, [OsuAction.leftButton]),
    ]);
    const state = timeline.gameStateAt(Infinity);
    expect(state.hitCircleVerdict["1"]).toBeUndefined();
    expect(state.stableNotelockEvidence["1"]).toMatchObject({ blockerHitObjectId: "0" });
  });

  it("selects the first circle under the cursor before applying overlap leniency", () => {
    const state = machine("300,192,1000,1,0\n300,192,1000,1,0", [
      frame(900, 300),
      frame(1000, 300, [OsuAction.leftButton]),
    ]).gameStateAt(Infinity);
    expect(state.hitCircleVerdict["0"]).toMatchObject({ type: "GREAT" });
    expect(state.hitCircleVerdict["1"]).toBeUndefined();
  });

  it("does not let two fresh presses clear an already-ineligible blocker before the object update", () => {
    const timeline = machine("300,192,1000,1,0\n300,192,1111,1,0", [
      frame(900, 300),
      frame(1111, 300, [OsuAction.leftButton, OsuAction.rightButton]),
      frame(1300, 300),
    ]);
    const atPress = cloneGameState(timeline.gameStateAt(1111));
    expect(atPress.hitCircleVerdict["0"]).toMatchObject({ type: "MISS", judgementTime: 1111 });
    expect(atPress.hitCircleVerdict["1"]).toBeUndefined();
    expect(atPress.stableNotelockEvidence["1"]).toMatchObject({ blockerHitObjectId: "0", pressTime: 1111 });
    const fork = timeline.fork();
    const final = cloneGameState(timeline.gameStateAt(Infinity));
    timeline.gameStateAt(900);
    expect(timeline.gameStateAt(1111)).toEqual(atPress);
    expect(timeline.gameStateAt(Infinity)).toEqual(final);
    expect(fork.gameStateAt(Infinity)).toEqual(final);
  });

  it("keeps a target eligible exactly at the nominal50 boundary before the second press", () => {
    const state = machine("300,192,1000,1,0\n300,192,1110,1,0", [
      frame(900, 300),
      frame(1110, 300, [OsuAction.leftButton, OsuAction.rightButton]),
    ]).gameStateAt(Infinity);
    expect(state.hitCircleVerdict["0"]).toMatchObject({ type: "MISS", judgementTime: 1110 });
    expect(state.hitCircleVerdict["1"]).toMatchObject({ type: "GREAT", judgementTime: 1110 });
  });

  it("excludes an overdue slider head while its overlapping parent remains alive", () => {
    const state = machine("300,192,1000,2,0,L|340:192,1,40\n300,192,1111,1,0", [
      frame(900, 300),
      frame(1111, 300, [OsuAction.leftButton]),
    ]).gameStateAt(Infinity);
    expect(state.hitCircleVerdict["0/HEAD"]).toMatchObject({ type: "MISS", judgementTime: 1111 });
    expect(state.hitCircleVerdict["1"]).toMatchObject({ type: "GREAT", judgementTime: 1111 });
  });
});
