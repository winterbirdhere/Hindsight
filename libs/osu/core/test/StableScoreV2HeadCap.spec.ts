import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { defaultGameState } from "../src/gameplay/GameState";
import { GameStateEvaluator } from "../src/gameplay/GameStateEvaluator";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { MainHitObjectVerdict } from "../src/gameplay/Verdicts";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { SliderCheckPoint } from "../src/hitobjects/SliderCheckPoint";
import { PathType } from "../src/hitobjects/slider/PathType";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";
import { OsuClassicMod } from "../src/mods/Mods";
import { ReplayFrame } from "../src/replays/Replay";

function fixture(mods: OsuClassicMod[]) {
  const head = new HitCircle();
  Object.assign(head, {
    id: "s/HEAD",
    sliderId: "s",
    hitTime: 1000,
    approachDuration: 600,
    position: { x: 100, y: 192 },
    unstackedPosition: { x: 100, y: 192 },
  });
  const slider = new Slider(head);
  Object.assign(slider, { id: "s", velocity: 0.1, repeatCount: 0 });
  slider.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }], 100);
  slider.checkPoints = [1250, 1500, 1750, 1964].map((time, index) => {
    const point = new SliderCheckPoint(slider);
    Object.assign(point, {
      id: `s/${index}`,
      type: index === 3 ? "LAST_LEGACY_TICK" : "TICK",
      hitTime: time,
      spanProgress: (time - 1000) / 1000,
      offset: { x: (time - 1000) * 0.1, y: 0 },
    });
    return point;
  });
  return { slider, map: new Beatmap([slider], DEFAULT_BEATMAP_DIFFICULTY, mods, new ControlPointInfo()) };
}

const options = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;

describe("Stable ScoreV2 slider-head accuracy cap", () => {
  // Independently enumerated legal part counts: head + four checkpoints. V1's
  // 100% / at least 50% / any / none table is further limited by V2 head accuracy.
  const cases: { head: MainHitObjectVerdict; v1: MainHitObjectVerdict[]; v2: MainHitObjectVerdict[] }[] = [
    { head: "GREAT", v1: ["MEH", "MEH", "OK", "OK", "GREAT"], v2: ["MEH", "MEH", "OK", "OK", "GREAT"] },
    { head: "OK", v1: ["MEH", "MEH", "OK", "OK", "GREAT"], v2: ["MEH", "MEH", "OK", "OK", "OK"] },
    { head: "MEH", v1: ["MEH", "MEH", "OK", "OK", "GREAT"], v2: ["MEH", "MEH", "MEH", "MEH", "MEH"] },
    { head: "MISS", v1: ["MISS", "MEH", "MEH", "OK", "OK"], v2: ["MISS", "MEH", "MEH", "MEH", "MEH"] },
  ];
  for (const { head, v1, v2 } of cases)
    for (let hits = 0; hits <= 4; hits++) {
      it(`${head} head and ${hits}/4 checkpoints preserves V1 and grades V2 independently`, () => {
        for (const [mods, expected] of [
          [[], v1[hits]],
          [["SCORE_V2"], v2[hits]],
        ] as [OsuClassicMod[], MainHitObjectVerdict][]) {
          const { map, slider } = fixture(mods);
          const state = defaultGameState();
          const evaluator = new GameStateEvaluator(map, options);
          evaluator.evaluate(state, { time: 0, position: { x: 0, y: 0 }, actions: [] });
          state.hitCircleVerdict[slider.head.id] =
            head === "MISS"
              ? { type: head, judgementTime: 1100, missReason: "TIME_EXPIRED" }
              : { type: head, judgementTime: 1100 };
          slider.checkPoints.forEach((point, index) => {
            state.checkPointVerdict[point.id] = { hit: index < hits, judgementTime: point.hitTime };
          });
          evaluator.handleSliderEnding(2000, slider.id);
          expect(state.sliderVerdict.s).toBe(expected);
          expect(state.hitCircleVerdict[slider.head.id].type).toBe(head);
          expect(state.judgedObjects).toEqual(["s"]);
        }
      });
    }

  it("does not invent a resolved head for a short parent with pending head/checkpoints", () => {
    const { map, slider } = fixture(["SCORE_V2"]);
    slider.velocity = 1.25; // A legal 80 ms slider ends before its head window.
    slider.checkPoints = slider.checkPoints.slice(0, 1);
    Object.assign(slider.checkPoints[0], { hitTime: 1050, spanProgress: 0.625, offset: { x: 62.5, y: 0 } });
    const state = defaultGameState();
    const evaluator = new GameStateEvaluator(map, options);
    evaluator.evaluate(state, { time: 0, position: { x: 0, y: 0 }, actions: [] });
    state.checkPointVerdict["s/0"] = { hit: true, judgementTime: 1050 };
    evaluator.handleSliderEnding(1080, "s");
    expect(state.sliderVerdict.s).toBe("MEH");
    expect(state.hitCircleVerdict["s/HEAD"]).toBeUndefined();
    expect(Object.keys(state.checkPointVerdict)).toEqual(["s/0"]);
  });

  it.each<[OsuClassicMod[], MainHitObjectVerdict]>([
    [[], "GREAT"],
    [["SCORE_V2"], "MEH"],
  ])("reproduces a late 50 head with all body parts collected (%j)", (mods, expected) => {
    const { map } = fixture(mods);
    const frames: ReplayFrame[] = [
      [900, 450],
      [1100, 100],
      [1250, 125],
      [1500, 150],
      [1750, 175],
      [1964, 196.4],
      [2001, 200],
    ].map(([time, x]) => ({ time, position: { x, y: 192 }, actions: time === 900 ? [] : [0] }));
    const state = new BucketedGameStateTimeMachine(frames, map, options).gameStateAt(1e9);
    expect(state.hitCircleVerdict["s/HEAD"].type).toBe("MEH");
    expect(Object.values(state.checkPointVerdict).every((part) => part.hit)).toBe(true);
    expect(state.sliderVerdict.s).toBe(expected);
  });
});
