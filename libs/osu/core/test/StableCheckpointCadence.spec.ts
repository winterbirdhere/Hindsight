import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { cloneGameState } from "../src/gameplay/GameState";
import { GameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { SliderCheckPoint } from "../src/hitobjects/SliderCheckPoint";
import { PathType } from "../src/hitobjects/slider/PathType";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const options = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;

function fixture(): { slider: Slider; map: Beatmap } {
  const head = new HitCircle();
  Object.assign(head, {
    id: "s/HEAD",
    sliderId: "s",
    hitTime: 1_000,
    approachDuration: 600,
    position: { x: 100, y: 192 },
    unstackedPosition: { x: 100, y: 192 },
  });
  const slider = new Slider(head);
  slider.id = "s";
  slider.velocity = 0.2;
  slider.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }], 100);
  slider.checkPoints = [1_100, 1_200, 1_464].map((time, index) => {
    const checkpoint = new SliderCheckPoint(slider);
    checkpoint.id = `s/${index}`;
    checkpoint.hitTime = time;
    checkpoint.type = index === 2 ? "LAST_LEGACY_TICK" : "TICK";
    checkpoint.offset = { x: (time - 1_000) * 0.2, y: 0 };
    return checkpoint;
  });
  return { slider, map: new Beatmap([slider], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo()) };
}

const frame = (time: number, held = true): ReplayFrame => ({
  time,
  position: { x: 100 + Math.max(0, Math.min(500, time - 1_000)) * 0.2, y: 192 },
  actions: held ? [OsuAction.leftButton] : [],
});

describe("Stable checkpoint update cadence", () => {
  // Slider source 2061–2078 counts due deadlines, but resolves only the next
  // checkpoint per body update. Player 3439/scorer 602 call that method once.
  it("leaves the second overdue checkpoint for the next observed input, including seek and fork", () => {
    const { map } = fixture();
    const machine = new BucketedGameStateTimeMachine(
      [frame(900, false), frame(1_000), frame(1_250), frame(1_251, false), frame(1_464), frame(1_500)],
      map,
      options,
      1,
    );
    const first = cloneGameState(machine.gameStateAt(1_250));
    expect(first.checkPointVerdict).toEqual({ "s/0": { hit: true, judgementTime: 1_250 } });
    const fork = machine.fork();
    const final = cloneGameState(machine.gameStateAt(1_500));
    expect(final.checkPointVerdict).toEqual({
      "s/0": { hit: true, judgementTime: 1_250 },
      "s/1": { hit: false, judgementTime: 1_251 },
      "s/2": { hit: true, judgementTime: 1_464 },
    });
    expect(final.sliderVerdict.s).toBe("OK");
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(final).maxComboSoFar).toBe(2);
    machine.gameStateAt(900);
    expect(machine.gameStateAt(1_250)).toEqual(first);
    expect(machine.gameStateAt(1_500)).toEqual(final);
    expect(fork.gameStateAt(1_500)).toEqual(final);
  });

  it("does not invent combo events for checkpoints left unresolved when the parent expires", () => {
    const { map } = fixture();
    const state = new BucketedGameStateTimeMachine(
      [frame(900, false), frame(1_000), frame(1_500), frame(1_501)],
      map,
      options,
    ).gameStateAt(Infinity);
    expect(state.checkPointVerdict).toEqual({ "s/0": { hit: true, judgementTime: 1_500 } });
    expect(state.judgedObjects).toEqual(["s/HEAD", "s/0", "s"]);
    expect(state.sliderVerdict.s).toBe("OK");
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(state).maxComboSoFar).toBe(2);
  });
});
