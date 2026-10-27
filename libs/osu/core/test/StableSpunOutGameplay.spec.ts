import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { GameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { Spinner } from "../src/hitobjects/Spinner";
import { OsuClassicMod } from "../src/mods/Mods";
import { ReplayFrame } from "../src/replays/Replay";

function fixture(mods: OsuClassicMod[], duration = 2000, gameVersion = 20260711) {
  const spinner = new Spinner();
  Object.assign(spinner, { id: "spinner", startTime: 1000, duration, approachDuration: 600 });
  spinner.applyLazerDefaults(5);
  const map = new Beatmap([spinner], DEFAULT_BEATMAP_DIFFICULTY, mods, new ControlPointInfo());
  const options = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE", replayGameVersion: gameVersion } as const;
  return { map, spinner, options };
}
const idle = (time: number): ReplayFrame => ({ time, position: { x: 0, y: 0 }, actions: [] });

describe("Stable SpunOut automatic completion", () => {
  for (const version of [20180101, 20260711])
    for (const rate of [[], ["DOUBLE_TIME"], ["HALF_TIME"]] as OsuClassicMod[][]) {
      it(`automatically clears stationary/no-hold input, version ${version}, rate ${rate}`, () => {
        const { map, spinner, options } = fixture(["SPUN_OUT", ...rate], 2000, version);
        const machine = new BucketedGameStateTimeMachine([999, 1000, 2000, 3000, 3001].map(idle), map, options);
        expect(machine.gameStateAt(3000).spinnerVerdict.spinner).toBeUndefined();
        const state = machine.gameStateAt(3001);
        expect(state.spinnerVerdict.spinner).toEqual({ type: "GREAT", judgementTime: 3001 });
        expect(state.judgedObjects).toEqual(["spinner"]);
        expect(new GameplayInfoEvaluator(map).evaluateReplayState(state).verdictCounts).toEqual([1, 0, 0, 0]);
        expect(retrieveEvents(state, map.hitObjects, "stable")).toEqual([
          expect.objectContaining({
            type: "HitObjectJudgement",
            hitObjectId: spinner.id,
            verdict: "GREAT",
            judgementTime: 3001,
          }),
        ]);
      });
    }

  it("does not complete an unplayed remainder after replay input ends", () => {
    const { map, options } = fixture(["SPUN_OUT"]);
    const state = new BucketedGameStateTimeMachine([999, 1000, 2000].map(idle), map, options).gameStateAt(1e9);
    expect(state.currentTime).toBe(2000);
    expect(state.spinnerVerdict.spinner).toBeUndefined();
    expect(state.judgedObjects).toEqual([]);
  });

  it("remains reversible and independently forkable", () => {
    const { map, options } = fixture(["SPUN_OUT"]);
    const machine = new BucketedGameStateTimeMachine([999, 1000, 1500, 2000, 2500, 3001].map(idle), map, options, 2);
    machine.gameStateAt(2000);
    const fork = machine.fork();
    const expected = { ...machine.gameStateAt(3001).spinnerVerdict.spinner };
    expect(expected.type).toBe("GREAT");
    expect(machine.gameStateAt(1500).spinnerVerdict.spinner).toBeUndefined();
    expect(machine.gameStateAt(3001).spinnerVerdict.spinner).toEqual(expected);
    expect(fork.gameStateAt(3001).spinnerVerdict.spinner).toEqual(expected);
  });

  it.each<OsuClassicMod[]>([[], ["RELAX"], ["AUTO_PILOT"]])("does not automate rotation for %j", (...mods) => {
    const { map, options } = fixture(mods);
    const state = new BucketedGameStateTimeMachine([999, 1000, 2000, 3001].map(idle), map, options).gameStateAt(1e9);
    expect(state.spinnerVerdict.spinner.type).toBe("MISS");
  });

  it("clears a zero-required short spinner without extra player input", () => {
    const { map, options } = fixture(["SPUN_OUT"], 100);
    const state = new BucketedGameStateTimeMachine([999, 1000, 1101].map(idle), map, options).gameStateAt(1e9);
    expect(state.spinnerVerdict.spinner.type).toBe("GREAT");
  });
});
