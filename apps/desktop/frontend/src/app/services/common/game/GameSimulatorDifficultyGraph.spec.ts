import { parser, std_diff } from "ojsama";
import { GameSimulator } from "./GameSimulator";

const rawMap = `osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
100,100,1000,1,0,0:0:0:0:
300,100,1500,1,0,0:0:0:0:
100,200,1800,1,0,0:0:0:0:
`;

describe("optional timeline difficulty graph", () => {
  beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  function loadedGraph() {
    const simulator = new GameSimulator();
    simulator.calculateDifficulties(rawMap, 3000, 0);
    const expected = simulator.difficulties$.getValue();
    expect(expected).toHaveLength(6);
    expect(Math.max(...expected)).toBe(1);
    return { simulator, expected };
  }

  it.each(["parser", "calculator"] as const)("clears a failed %s graph and recovers on the next map", (failure) => {
    const { simulator, expected } = loadedGraph();
    const fail = () => {
      throw new Error("Legacy graph failure");
    };
    if (failure === "parser") jest.spyOn(parser.prototype, "feed").mockImplementationOnce(fail);
    else jest.spyOn(std_diff.prototype, "calc").mockImplementationOnce(fail);

    expect(() => simulator.calculateDifficulties(rawMap, 3000, 0)).not.toThrow();
    expect(simulator.difficulties$.getValue()).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("timeline difficulty graph"), expect.any(Error));

    simulator.calculateDifficulties(rawMap, 3000, 0);
    expect(simulator.difficulties$.getValue()).toEqual(expected);
  });

  it.each([NaN, Infinity])("does not publish a graph containing %s strain", (strain) => {
    const { simulator, expected } = loadedGraph();
    const calculate = std_diff.prototype.calc;
    jest.spyOn(std_diff.prototype, "calc").mockImplementationOnce(function (this: std_diff, options) {
      const result = calculate.call(this, options);
      result.objects[1].strains[0] = strain;
      return result;
    });

    expect(() => simulator.calculateDifficulties(rawMap, 3000, 0)).not.toThrow();
    expect(simulator.difficulties$.getValue()).toEqual([]);
    simulator.calculateDifficulties(rawMap, 3000, 0);
    expect(simulator.difficulties$.getValue()).toEqual(expected);
  });

  it.each([
    ["empty map", rawMap.split("[HitObjects]")[0], 3000],
    ["no positive strain", rawMap, 500],
    ["zero duration", rawMap, 0],
    ["invalid duration", rawMap, NaN],
    ["unbounded duration", rawMap, Infinity],
  ])("clears the previous graph for %s", (_name, map, duration) => {
    const { simulator } = loadedGraph();
    simulator.calculateDifficulties(map as string, duration as number, 0);
    expect(simulator.difficulties$.getValue()).toEqual([]);
  });
});
