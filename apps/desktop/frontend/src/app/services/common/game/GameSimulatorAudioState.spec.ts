import { Beatmap, DEFAULT_BEATMAP_DIFFICULTY, HitCircle, OsuAction, ReplayAnalysisRuleset } from "@osujs/core";
import { GameSimulator } from "./GameSimulator";
import { OsuReplay } from "../../../model/OsuReplay";
import { GameplayClock } from "./GameplayClock";

function fixture() {
  const circle = new HitCircle();
  circle.id = "audio-circle";
  circle.hitTime = 1000;
  circle.approachDuration = 600;
  circle.position = { x: 256, y: 192 };
  const beatmap = new Beatmap([circle], DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
  const replay: OsuReplay = {
    md5hash: "audio-state",
    beatmapMd5: "audio-state-map",
    gameMode: 0,
    gameVersion: 20250401,
    mods: [],
    player: "Audio state",
    frames: [
      { time: 0, position: circle.position, actions: [] },
      { time: 900, position: circle.position, actions: [] },
      { time: 1000, position: circle.position, actions: [OsuAction.leftButton] },
      { time: 1001, position: circle.position, actions: [] },
      { time: 1100, position: circle.position, actions: [] },
      { time: 1500, position: circle.position, actions: [] },
    ],
    lifeBar: [
      { time: 1001, health: 0.5 },
      { time: 1100, health: 0 },
    ],
  };
  return { beatmap, replay };
}

describe("audio state lookups", () => {
  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "rebuilds the same %s statistics after backward seeks without accumulating repeated hits",
    (ruleset) => {
      const { beatmap, replay } = fixture();
      const simulator = new GameSimulator();
      simulator.simulateReplay(beatmap, replay);
      simulator.setRulesetFocus(ruleset);
      const clock = new GameplayClock();
      let time = 900;
      clock.setDuration(2_000);
      clock.setTimeSource(() => time);
      clock.seeked$.subscribe((target) => {
        time = target;
      });
      clock.seekTo(900);
      clock.start();
      simulator.simulate(1_001);
      const info = { ...simulator.getCurrentInfo() };
      const stats = { ...simulator.getCurrentScoreStats() };
      for (let pass = 0; pass < 3; pass++) {
        clock.seekTo(900);
        simulator.simulate(clock.tick());
        expect(simulator.getCurrentState()?.hitCircleVerdict["audio-circle"]).toBeUndefined();
        time = 1_001;
        simulator.simulate(clock.tick());
        expect(simulator.getCurrentInfo()).toEqual(info);
        expect(simulator.getCurrentScoreStats()).toEqual(stats);
      }
    },
  );

  it.each<ReplayAnalysisRuleset>(["stable", "lazer"])(
    "queries future %s audio state without mutating the displayed state, time, or results",
    (ruleset) => {
      const { beatmap, replay } = fixture();
      const simulator = new GameSimulator();
      simulator.simulateReplay(beatmap, replay);
      expect(simulator.setRulesetFocus(ruleset)).toBe(true);
      simulator.simulate(900);
      const visibleState = simulator.getCurrentState();
      const visibleInfo = simulator.getCurrentInfo();
      const visibleStats = simulator.getCurrentScoreStats();
      const audioState = simulator.getStateAt(1001);
      expect(audioState?.hitCircleVerdict["audio-circle"]?.type).toBe("GREAT");
      expect(simulator.getCurrentState()).toBe(visibleState);
      expect(visibleState?.currentTime).toBe(900);
      expect(visibleState?.hitCircleVerdict["audio-circle"]).toBeUndefined();
      expect(simulator.getCurrentInfo()).toEqual(visibleInfo);
      expect(simulator.getCurrentScoreStats()).toEqual(visibleStats);

      expect(simulator.getStateAt(5000)?.currentTime).toBe(1100);
      expect(visibleState?.currentTime).toBe(900);
      simulator.simulate(1001);
      expect(simulator.getCurrentState()?.hitCircleVerdict["audio-circle"]?.type).toBe("GREAT");
      simulator.clear();
      expect(simulator.getStateAt(1001)).toBeUndefined();
    },
  );
});
