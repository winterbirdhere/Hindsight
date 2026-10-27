import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { Slider } from "../src/hitobjects/Slider";
import { Spinner } from "../src/hitobjects/Spinner";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { cloneGameState } from "../src/gameplay/GameState";
import { ReplayFrame } from "../src/replays/Replay";
import { parseReplayFramesFromRaw } from "../src/replays/ReplayParser";
import { generateSliderCheckpoints } from "../src/hitobjects/slider/SliderCheckPointGenerator";

const options = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;
const slider = "100,192,1000,2,0,L|400:192,1,300";
function fixture(version = 14, objects = slider, tickRate = "1", multiplier = "1.4") {
  return `osu file format v${version}
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:5
SliderMultiplier:${multiplier}
SliderTickRate:${tickRate}
[TimingPoints]
100,500,4,1,0,100,1,0
100,-50,4,1,0,100,0,0
[HitObjects]
${objects}
`;
}

describe("audited legacy beatmap decoding", () => {
  it.each([
    [7, 2],
    [14, 1],
  ])("keeps format-v%i native slider tick count compatible with official capacities", (version, ticks) => {
    const map = buildBeatmap(parseBlueprint(fixture(version)));
    const object = map.hitObjects[0] as Slider;
    expect(object.checkPoints.filter((point) => point.type === "TICK")).toHaveLength(ticks);
  });

  it.each([
    [4, 1024, 124],
    [14, 1000, 100],
  ])("applies the format-v%i legacy offset to objects and timing", (version, objectTime, timingTime) => {
    const blueprint = parseBlueprint(fixture(version, "256,192,1000,1,0\n256,192,2000,8,0,3000"));
    const map = buildBeatmap(blueprint);
    expect(blueprint.hitObjectSettings[0].time).toBe(objectTime);
    expect(blueprint.hitObjectSettings[1].time).toBe(objectTime + 1000);
    expect(map.controlPointInfo.timingPointAt(500).time).toBe(timingTime);
    expect((map.hitObjects[1] as Spinner).endTime).toBe(objectTime + 2000);
  });

  it.each([
    ["1e12", 8],
    ["0", 0.5],
    ["-5", 0.5],
  ])("bounds tick rate %s to the supported decoder range", (raw, expected) => {
    const blueprint = parseBlueprint(fixture(14, slider, raw));
    expect(blueprint.defaultDifficulty.sliderTickRate).toBe(expected);
    expect((buildBeatmap(blueprint).hitObjects[0] as Slider).checkPoints.length).toBeLessThan(20);
  });

  it.each([
    ["1e-100", 0.4],
    ["1e100", 3.6],
  ])("bounds slider multiplier %s before checkpoint construction", (raw, expected) => {
    expect(parseBlueprint(fixture(14, slider, "1", raw)).defaultDifficulty.sliderMultiplier).toBe(expected);
  });

  it("rejects excessive checkpoint work before materializing it", () => {
    const checkpoints = generateSliderCheckpoints(0, 1000, 0.3, 1e-12, 300, 1);
    const push = Array.prototype.push;
    let generated = 0;
    const spy = jest.spyOn(Array.prototype, "push").mockImplementation(function (...values: unknown[]) {
      if (values.some((value) => value && typeof value === "object" && "spanProgress" in value)) {
        if (++generated > 10000) throw new Error("Test stopped unbounded allocation");
      }
      return push.apply(this, values);
    });
    try {
      expect(() => checkpoints.next()).toThrow(/checkpoint|tick.*limit/i);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Relax catch-up resource limits", () => {
  it("limits a day-long replay gap to object lifetimes without dropping recorded samples", () => {
    const map = buildBeatmap(parseBlueprint(fixture(14, "256,192,1000,1,0")), { mods: ["RELAX"] });
    const frames: ReplayFrame[] = [
      { time: 0, position: { x: 256, y: 192 }, actions: [] },
      { time: 86_400_000, position: { x: 256, y: 192 }, actions: [0] },
      { time: 86_400_000, position: { x: 400, y: 192 }, actions: [] },
    ];
    const state = new LazerGameStateTimeMachine(frames, map, undefined, { legacyReplay: true }).gameStateAt(Infinity);
    expect(state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(state.currentTime).toBe(86_400_000);
    expect(state.cursorPosition).toEqual({ x: 400, y: 192 });
    expect(frames).toHaveLength(3);
  });

  it("rejects catch-up that cannot advance within an extreme object lifetime", () => {
    const map = buildBeatmap(parseBlueprint(fixture(14, "256,192,1e20,8,0,100000000000000100000")), {
      mods: ["RELAX"],
    });
    const frames = parseReplayFramesFromRaw("1e20|256|192|0,100000|256|192|0");
    expect(() => new LazerGameStateTimeMachine(frames, map, undefined, { legacyReplay: true })).toThrow(
      /catch-up work limit/,
    );
  });

  it("rejects several hours of continuous synthetic input before allocating it", () => {
    const map = buildBeatmap(parseBlueprint(fixture(14, "256,192,1000,8,0,86400000")), { mods: ["RELAX"] });
    const frames = parseReplayFramesFromRaw("0|256|192|0,86400000|256|192|0");
    expect(() => new LazerGameStateTimeMachine(frames, map, undefined, { legacyReplay: true })).toThrow(
      /catch-up work limit/,
    );
  });

  it("does not expand extreme finite timestamps outside the beatmap", () => {
    const map = buildBeatmap(parseBlueprint(fixture(14, "256,192,1000,1,0")), { mods: ["RELAX"] });
    const frames = parseReplayFramesFromRaw("1e20|256|192|0,100000|256|192|0");
    // Fail safely on the old unbounded loop rather than exhausting the test worker.
    const push = Array.prototype.push;
    let generated = 0;
    const spy = jest.spyOn(Array.prototype, "push").mockImplementation(function (...values: unknown[]) {
      if (values.some((value) => value && typeof value === "object" && "actions" in value)) {
        if (++generated > 10000) throw new Error("Test stopped unbounded replay frame expansion");
      }
      return push.apply(this, values);
    });
    try {
      expect(() => new LazerGameStateTimeMachine(frames, map, undefined, { legacyReplay: true })).not.toThrow();
      expect(generated).toBeLessThan(100);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Stable notelock prefix work", () => {
  it("does not re-read completed map prefixes on every hit and restores its cursor after seeks", () => {
    const count = 200;
    const map = buildBeatmap(
      parseBlueprint(
        fixture(14, Array.from({ length: count }, (_, index) => `256,192,${1000 + index * 100},1,0`).join("\n")),
      ),
      { addStacking: false },
    );
    let reads = 0;
    for (let index = 0; index < count; index++) {
      const object = map.hitObjects[index];
      Object.defineProperty(map.hitObjects, index, {
        get: () => {
          reads++;
          return object;
        },
        configurable: true,
      });
    }
    const frames: ReplayFrame[] = Array.from({ length: count }, (_, index) => [
      { time: 999 + index * 100, position: { x: 256, y: 192 }, actions: [] },
      { time: 1000 + index * 100, position: { x: 256, y: 192 }, actions: [0] },
    ]).flat();
    const machine = new BucketedGameStateTimeMachine(frames, map, options, 7);
    reads = 0;
    expect(machine.gameStateAt(Infinity).judgedObjects).toHaveLength(count);
    expect(reads).toBeLessThan(count * 8);
    const expected = cloneGameState(machine.gameStateAt(1300));
    const fork = machine.fork();
    machine.gameStateAt(Infinity);
    fork.gameStateAt(1100);
    expect(fork.gameStateAt(1300)).toEqual(expected);
    expect(machine.gameStateAt(1300)).toEqual(expected);
  });
});
