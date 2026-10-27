import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { cloneGameState } from "../src/gameplay/GameState";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { GameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { StableSliderBallPath } from "../src/gameplay/StableSliderBallPath";
import { Slider } from "../src/hitobjects/Slider";
import { SliderCheckPoint } from "../src/hitobjects/SliderCheckPoint";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const options = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;
type SourceSlider = Slider & { stableCheckPoints: SliderCheckPoint[] | undefined };
const cases = [
  { name: "fewer", object: "100,192,1000,2,0,L|500:192,1,142.800001", nativeTicks: 1, stableTicks: 0 },
  { name: "more", object: "100,192,1000,2,0,L|500:196,1,142.8", nativeTicks: 0, stableTicks: 1 },
];

function fixture(object: string) {
  const map = buildBeatmap(
    parseBlueprint(`osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:5
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,2,3,70,1,0
[HitObjects]
${object}
`),
    { addStacking: false },
  );
  const slider = map.hitObjects[0] as SourceSlider;
  const ball = new StableSliderBallPath(slider);
  const frames: ReplayFrame[] = [900, 1_000, 1_400, 1_474, 1_500, 1_501, 1_510, 1_511].map((time) => ({
    time,
    position: ball.positionAt(time),
    actions: time < 1_000 ? [] : [OsuAction.leftButton],
  }));
  return { map, slider, frames };
}

describe("Stable checkpoint topology at the ten-millisecond cutoff", () => {
  // Source float segment lengths are 142.79998779296875 and 142.8000030517578.
  // Subtracting the 140 px tick leaves opposite sides of the 2.8 px cutoff.
  it.each(cases)(
    "scores $name source ticks without changing native identities or topology",
    ({ object, nativeTicks, stableTicks }) => {
      const { map, slider, frames } = fixture(object);
      const native = slider.checkPoints.map((point) => ({
        id: point.id,
        time: point.hitTime,
        type: point.type,
        position: point.position,
      }));
      expect(slider.checkPoints.filter((point) => point.type === "TICK")).toHaveLength(nativeTicks);
      expect(slider.stableCheckPoints?.filter((point) => point.type === "TICK")).toHaveLength(stableTicks);
      expect(slider.stableCheckPoints?.find((point) => point.type === "LAST_LEGACY_TICK")?.id).toBe(
        slider.checkPoints.find((point) => point.type === "LAST_LEGACY_TICK")?.id,
      );
      const state = new BucketedGameStateTimeMachine(frames, map, options).gameStateAt(Infinity);
      expect(state.sliderVerdict[slider.id]).toBe("GREAT");
      expect(new GameplayInfoEvaluator(map).evaluateReplayState(state)).toMatchObject({
        verdictCounts: [1, 0, 0, 0],
        maxComboSoFar: stableTicks + 2,
      });
      const checkpointEvents = retrieveEvents(state, map.hitObjects, "stable").filter(
        (event) => event.type === "CheckpointJudgement",
      );
      expect(checkpointEvents).toHaveLength(stableTicks + 1);
      expect(
        slider.checkPoints.map((point) => ({
          id: point.id,
          time: point.hitTime,
          type: point.type,
          position: point.position,
        })),
      ).toEqual(native);
      const lazer = new LazerGameStateTimeMachine(frames, map).gameStateAt(Infinity);
      expect(lazer.lazerJudgements.filter((judgement) => judgement.kind === "SLIDER_TICK")).toHaveLength(nativeTicks);
      const originalNativePoints = slider.checkPoints;
      slider.stableCheckPoints = undefined;
      expect(new LazerGameStateTimeMachine(frames, map).gameStateAt(Infinity)).toEqual(lazer);
      expect(slider.checkPoints).toBe(originalNativePoints);
    },
  );

  it("registers extra source ticks with independent IDs, source positions, and resolved samples", () => {
    const { map, slider } = fixture(cases[1].object);
    const tick = slider.stableCheckPoints?.find((point) => point.type === "TICK");
    expect(tick).toBeDefined();
    if (!tick) throw new Error("Expected the source-only tick");
    expect(slider.checkPoints.some((point) => point.id === tick.id)).toBe(false);
    expect(map.getSliderCheckPoint(tick.id)).toBe(tick);
    expect(tick).toMatchObject({ type: "TICK", hitTime: 1_500, spanIndex: 0 });
    expect(tick.position.x).toBeCloseTo(239.993, 3);
    expect(tick.position.y).toBeCloseTo(193.39993, 4);
    expect(tick.samples).toMatchObject([{ name: "slidertick", bank: "soft", suffix: "3", volume: 70 }]);
  });

  it.each(cases)("preserves $name topology and pending scoring across seek/fork", ({ object }) => {
    const { map, frames } = fixture(object);
    const machine = new BucketedGameStateTimeMachine(frames, map, options, 1);
    const partial = cloneGameState(machine.gameStateAt(1_500));
    const fork = machine.fork();
    const final = cloneGameState(machine.gameStateAt(Infinity));
    machine.gameStateAt(900);
    expect(machine.gameStateAt(1_500)).toEqual(partial);
    expect(machine.gameStateAt(Infinity)).toEqual(final);
    expect(fork.gameStateAt(Infinity)).toEqual(final);
  });

  it("uses an extra source tick in the grade denominator and break events", () => {
    const { map, slider, frames } = fixture(cases[1].object);
    const released = frames.map((frame) => (frame.time >= 1_500 ? { ...frame, actions: [] } : frame));
    const state = new BucketedGameStateTimeMachine(released, map, options).gameStateAt(Infinity);
    expect(state.sliderVerdict[slider.id]).toBe("MEH");
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(state).verdictCounts).toEqual([0, 0, 1, 0]);
    expect(
      retrieveEvents(state, map.hitObjects, "stable").filter((event) => event.type === "SliderBreak"),
    ).toMatchObject([
      { componentId: slider.stableCheckPoints?.find((point) => point.type === "TICK")?.id, componentType: "TICK" },
    ]);
  });

  it("uses pre-v8 base tick spacing and matches native identities by tick position", () => {
    const blueprint = parseBlueprint(`osu file format v7
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:5
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,2,3,70,1,0
1,-50,4,2,3,70,0,0
[HitObjects]
100,192,1000,2,0,L|400:192,1,300
`);
    const legacy = buildBeatmap(blueprint, { addStacking: false }).hitObjects[0] as SourceSlider;
    const nativeTicks = legacy.checkPoints.filter((point) => point.type === "TICK");
    const ticks = legacy.stableCheckPoints?.filter((point) => point.type === "TICK") ?? [];
    expect(ticks).toHaveLength(2);
    // Both decoders preserve the pre-v8 grid; matched source ticks keep the
    // corresponding native identity instead of inventing Stable-only ticks.
    expect(nativeTicks).toHaveLength(2);
    expect(ticks[0]).toBe(nativeTicks[0]);
    expect(ticks[0].hitTime).toBe(1_250);
    expect(ticks[0].position.x).toBeCloseTo(240, 4);
    expect(ticks[0].position.y).toBe(192);
    expect(ticks[1]).toBe(nativeTicks[1]);
    blueprint.blueprintInfo.beatmapVersion = 8;
    const modern = buildBeatmap(blueprint, { addStacking: false }).hitObjects[0] as SourceSlider;
    expect(modern.stableCheckPoints?.filter((point) => point.type === "TICK")).toHaveLength(1);
  });
});
