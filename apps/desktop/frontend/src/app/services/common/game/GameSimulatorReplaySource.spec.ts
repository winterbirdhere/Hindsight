import { Beatmap, DEFAULT_BEATMAP_DIFFICULTY, HitCircle, OsuAction } from "@osujs/core";
import type { OsuReplay } from "../../../model/OsuReplay";
import { GameSimulator } from "./GameSimulator";

function fixture() {
  const circle = new HitCircle();
  circle.id = "target";
  circle.hitTime = 1000;
  circle.approachDuration = 600;
  circle.position = { x: 256, y: 192 };
  const map = new Beatmap([circle], DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
  const replay: OsuReplay = {
    md5hash: "legacy-wrapper",
    beatmapMd5: "map",
    gameMode: 0,
    gameVersion: 20_260_711,
    player: "Player",
    mods: [],
    frames: [
      { time: 900, position: circle.position, actions: [], rawButtonMask: 0 },
      { time: 1149.5, position: circle.position, actions: [OsuAction.leftButton], rawButtonMask: 1 },
      { time: 1400, position: circle.position, actions: [], rawButtonMask: 0 },
    ],
    // Deliberately matches Stable, to prove the source is not chosen by totals.
    statistics: { count300: 0, count100: 0, count50: 0, countMiss: 1, maxCombo: 0, score: 0, perfectCombo: false },
  };
  return { map, replay };
}

describe("replay origin selects playback automatically", () => {
  it("loads confirmed legacy-wrapper Lazer with its native HUD despite a Stable-matching header", () => {
    const { map, replay } = fixture();
    const source = Object.assign(replay, { sourceClient: "lazer", sourceProvenance: "user-confirmed" } as const);
    const simulator = new GameSimulator();
    simulator.simulateReplay(map, source);
    expect(simulator.getRulesetFocus()).toBe("lazer");
    simulator.simulate(1400);
    expect(simulator.getCurrentScoreStats()).toMatchObject({ count50: 1, countMiss: 0 });
    expect(simulator.validation$.value).toMatchObject({ verified: false, simulatedCounts: [0, 0, 1, 0] });
    expect(source.gameVersion).toBe(20_260_711);
    expect(source.lazerMods).toBeUndefined();
    simulator.simulate(900);
    simulator.simulate(1400);
    expect(simulator.getCurrentScoreStats()).toMatchObject({ count50: 1, countMiss: 0 });
  });

  it("leaves an unmarked Stable replay on Stable even when its header matches Lazer", () => {
    const { map, replay } = fixture();
    if (!replay.statistics) throw Error("Missing fixture statistics");
    replay.statistics.count50 = 1;
    replay.statistics.countMiss = 0;
    const simulator = new GameSimulator();
    simulator.simulateReplay(map, replay);
    expect(simulator.getRulesetFocus()).toBe("stable");
    simulator.simulate(1400);
    expect(simulator.getCurrentScoreStats()).toMatchObject({ count50: 0, countMiss: 1 });
    expect(simulator.validation$.value.verified).toBe(false);
  });
});
