import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { cloneGameState } from "../src/gameplay/GameState";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { Slider } from "../src/hitobjects/Slider";

function fixture(endSample: number, tailHit = true) {
  const map = buildBeatmap(
    parseBlueprint(`osu file format v14
[Difficulty]
CircleSize:4
OverallDifficulty:8.5
SliderMultiplier:2.6
SliderTickRate:1
[TimingPoints]
0,500,4,2,0,100,1,0
0,-66.6666666666667,4,2,0,100,0,0
[HitObjects]
256,192,1000,2,0,L|256:94,1,97.5
`),
    { addStacking: false },
  );
  const frames = [
    { time: 1000, position: { x: 256, y: 192 }, actions: [0] },
    { time: 1088, position: { x: 256, y: 123 }, actions: tailHit ? [0] : [] },
    { time: endSample, position: { x: 256, y: 94.5 }, actions: tailHit ? [0] : [] },
  ];
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

describe("observed Stable slider judgement time", () => {
  it.each([1124, 1200])("retains parent completion at sample %s through events and seek/fork", (endSample) => {
    const { map, machine } = fixture(endSample);
    const slider = map.hitObjects[0] as Slider;
    expect(slider.endTime).toBe(1125);
    const partial = cloneGameState(machine.gameStateAt(1088));
    const fork = machine.fork();
    const final = cloneGameState(machine.gameStateAt(Infinity));
    expect(final).toMatchObject({ sliderVerdict: { "0": "GREAT" }, sliderJudgementTime: { "0": endSample } });
    expect(
      retrieveEvents(final, map.hitObjects, "stable").find(
        (event) => event.type === "HitObjectJudgement" && event.hitObjectId === "0",
      ),
    ).toMatchObject({ time: endSample, judgementTime: endSample });
    machine.gameStateAt(900);
    expect(machine.gameStateAt(1088)).toEqual(partial);
    expect(machine.gameStateAt(Infinity)).toEqual(final);
    expect(fork.gameStateAt(Infinity)).toEqual(final);
  });

  it("resolves a missed legacy tail at the observed parent completion for error navigation", () => {
    const { map, machine } = fixture(1200, false);
    const events = retrieveEvents(machine.gameStateAt(Infinity), map.hitObjects, "stable");
    expect(events.find((event) => event.type === "CheckpointJudgement" && event.isLastTick)).toMatchObject({
      hit: false,
      judgementTime: 1088,
      sliderEndTime: 1200,
    });
  });
});
