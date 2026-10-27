import { Beatmap, DEFAULT_BEATMAP_DIFFICULTY, HitCircle, OsuAction } from "@osujs/core";
import type { OsuReplay } from "../../../model/OsuReplay";
import { GameSimulator } from "./GameSimulator";

function fixture(rate = 1.5) {
  const circles = [1000, 2000, 3000].map((hitTime, index) => {
    const circle = new HitCircle();
    circle.id = `timing-${index}`;
    circle.hitTime = hitTime;
    circle.approachDuration = 600;
    circle.position = { x: 256, y: 192 };
    return circle;
  });
  const beatmap = new Beatmap(
    circles,
    DEFAULT_BEATMAP_DIFFICULTY,
    [],
    Beatmap.EMPTY_BEATMAP.controlPointInfo,
    false,
    [],
    [],
    [{ acronym: "DT", settings: { speed_change: rate } }],
  );
  const replay: OsuReplay = {
    md5hash: "timing",
    beatmapMd5: "timing",
    gameMode: 0,
    gameVersion: 30000016,
    player: "Timing",
    mods: [],
    frames: [
      { time: 0, position: circles[0].position, actions: [] },
      ...[985, 2015, 3045].flatMap((time) => [
        { time, position: circles[0].position, actions: [OsuAction.leftButton] },
        { time: time + 1, position: circles[0].position, actions: [] },
      ]),
      { time: 4000, position: circles[0].position, actions: [] },
    ],
  };
  const simulator = new GameSimulator();
  simulator.simulateReplay(beatmap, replay);
  return { simulator, beatmap, replay };
}

describe("GameSimulator current timing stats", () => {
  it("uses the current successful prefix across seeks and Stable/lazer switching", () => {
    const { simulator } = fixture();
    simulator.setRulesetFocus("stable");
    simulator.simulate(3045);
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "244.9", bias: "+10.0 ms" });
    simulator.simulate(984);
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "—", bias: "—" });
    simulator.simulate(985);
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "0.0", bias: "-10.0 ms" });
    simulator.simulate(2015);
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "150.0", bias: "+0.0 ms" });
    simulator.setRulesetFocus("lazer");
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "100.0", bias: "+0.0 ms" });
    simulator.simulate(3045);
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "163.3", bias: "+10.0 ms" });
    simulator.setRulesetFocus("stable");
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "244.9", bias: "+10.0 ms" });
  });

  it("returns dashes without a current replay and excludes misses", () => {
    expect(new GameSimulator().getCurrentTimingStats()).toEqual({ ur: "—", bias: "—" });
    const { simulator } = fixture();
    simulator.simulate(4000);
    simulator.hits = [[1000, 999, false]];
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "—", bias: "—" });
    simulator.hits = [[1000, -0.001, true]];
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "0.0", bias: "+0.0 ms" });
    simulator.clear();
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "—", bias: "—" });
  });

  it("reuses the immutable history across frames and refreshes replacements, lengths and rates", () => {
    const { simulator, beatmap } = fixture();
    simulator.setRulesetFocus("stable");
    let visited = 0;
    const hits: [number, number, boolean][] = [
      [1000, -15, true],
      [2000, 15, true],
    ];
    simulator.hits = new Proxy(hits, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) visited++;
        return Reflect.get(target, key, receiver);
      },
    });
    for (let frame = 0; frame < 60; frame++) {
      simulator.simulate(3000 + frame);
      expect(simulator.getCurrentTimingStats()).toEqual({ ur: "150.0", bias: "+0.0 ms" });
    }
    expect(visited).toBe(2);
    hits.push([3000, 45, true]);
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "244.9", bias: "+10.0 ms" });
    simulator.hits = [
      [1000, 15, true],
      [2000, 45, true],
      [3000, 75, true],
    ];
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "244.9", bias: "+30.0 ms" });
    Object.assign(beatmap, { gameClockRate: 0.75 });
    expect(simulator.getCurrentTimingStats()).toEqual({ ur: "244.9", bias: "+60.0 ms" });
  });
});
