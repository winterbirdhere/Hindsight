import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { GameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { SliderCheckPoint } from "../src/hitobjects/SliderCheckPoint";
import { PathType } from "../src/hitobjects/slider/PathType";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const stableOptions = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;
const position = { x: 0, y: 0 };

function circle(id: string, time = 1_000): HitCircle {
  const result = new HitCircle();
  result.id = id;
  result.hitTime = time;
  result.approachDuration = 600;
  result.scale = 0.5;
  result.position = position;
  result.unstackedPosition = position;
  return result;
}

function beatmap(objects: Beatmap["hitObjects"]): Beatmap {
  return new Beatmap(objects, DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
}

function frame(time: number, x: number, pressed = true): ReplayFrame {
  return { time, position: { x, y: 0 }, actions: pressed ? [OsuAction.leftButton] : [] };
}

describe("Stable gameplay radius", () => {
  it.each([
    [32.003, "GREAT"],
    [32.02, "MISS"],
  ] as const)("judges a circle at distance %f using Stable's adjusted radius", (distance, verdict) => {
    const target = circle("target");
    const map = beatmap([target]);
    const state = new BucketedGameStateTimeMachine(
      [frame(900, 100, false), frame(1_000, distance), frame(1_200, 100, false)],
      map,
      stableOptions,
    ).gameStateAt(1_200);

    expect(state.hitCircleVerdict[target.id].type).toBe(verdict);
    // Gameplay compatibility must not resize shared rendered/native geometry.
    expect(target.radius).toBe(32);
    expect(target.position).toEqual(position);
  });

  it("keeps the radius adjustment out of native Lazer evaluation", () => {
    const target = circle("target");
    const state = new LazerGameStateTimeMachine(
      [frame(900, 100, false), frame(1_000, 32.003), frame(1_200, 100, false)],
      beatmap([target]),
    ).gameStateAt(1_200);

    expect(state.hitCircleVerdict[target.id].type).toBe("MISS");
    expect(target.radius).toBe(32);
  });

  it("reports the same gameplay radius used to accept a notelocked edge press", () => {
    const blocker = circle("blocker");
    blocker.position = { x: 200, y: 200 };
    const target = circle("target", 1_010);
    const state = new BucketedGameStateTimeMachine(
      [frame(900, 100, false), frame(1_000, 32.003), frame(1_200, 100, false)],
      beatmap([blocker, target]),
      stableOptions,
    ).gameStateAt(1_200);

    expect(state.stableNotelockEvidence[target.id]).toMatchObject({
      blockerHitObjectId: blocker.id,
      objectRadius: 32.013118743896484,
      wouldHaveHit: "GREAT",
    });
  });

  it("awards a tail-only 100 when an unhit head begins tracking inside the adjusted radius", () => {
    const head = circle("slider/HEAD");
    head.sliderId = "slider";
    const slider = new Slider(head);
    slider.id = "slider";
    slider.velocity = 1;
    slider.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 75, y: 0 } }], 75);
    const tail = new SliderCheckPoint(slider);
    tail.id = "slider/0";
    tail.type = "LAST_LEGACY_TICK";
    tail.hitTime = 1_039;
    tail.offset = { x: 39, y: 0 };
    slider.checkPoints = [tail];
    const map = beatmap([slider]);
    const state = new BucketedGameStateTimeMachine(
      [
        frame(980, -40, false),
        frame(990, -32.5), // The head press itself is outside either radius.
        frame(1_000, -32.003),
        frame(1_010, -30), // 40 px from the moving ball, inside only the follow area.
        frame(1_039, -1),
        frame(1_075, 75),
      ],
      map,
      stableOptions,
    ).gameStateAt(1_075);

    // The short parent is already graded while the unhit head awaits expiry.
    expect(state.hitCircleVerdict[head.id]).toBeUndefined();
    expect(state.checkPointVerdict[tail.id].hit).toBe(true);
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(state)).toMatchObject({
      verdictCounts: [0, 1, 0, 0],
      maxComboSoFar: 1,
    });
    expect(slider.radius).toBe(32);
  });
});
