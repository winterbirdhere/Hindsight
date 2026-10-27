import { Beatmap } from "../src/beatmap/Beatmap";
import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const stableOptions = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;

function circle(id: string, time: number, x: number): HitCircle {
  const object = new HitCircle();
  object.id = id;
  object.hitTime = time;
  object.approachDuration = 600;
  object.scale = 0.5;
  object.position = { x, y: 192 };
  object.unstackedPosition = object.position;
  return object;
}

function frame(time: number, x: number, pressed = false): ReplayFrame {
  return {
    time,
    position: { x, y: 192 },
    rawButtonMask: pressed ? 5 : 0,
    actions: pressed ? [OsuAction.leftButton] : [],
  };
}

function machine(relax: boolean): BucketedGameStateTimeMachine {
  return new BucketedGameStateTimeMachine(
    [frame(900, 500), frame(1_103, 300), frame(1_104, 300, !relax), frame(1_105, 500), frame(1_300, 500)],
    new Beatmap(
      [circle("expired", 1_000, 100), circle("target", 1_094, 300)],
      { ...DEFAULT_BEATMAP_DIFFICULTY, overallDifficulty: 9.6 },
      relax ? ["RELAX"] : [],
      new ControlPointInfo(),
    ),
    stableOptions,
    1,
  );
}

describe("Stable Relax update ordering", () => {
  it.each([300, 100])(
    "keeps a short completed slider's unresolved head as a callback trigger, but not an input target (cursor x=%s)",
    (cursorX) => {
      const map = buildBeatmap(
        parseBlueprint(`osu file format v14
[Difficulty]
CircleSize:4
OverallDifficulty:9
SliderMultiplier:3.6
SliderTickRate:1
[TimingPoints]
0,360,4,1,0,100,1,0
[HitObjects]
100,192,1000,2,0,L|140:192,1,40
300,192,1100,1,0
`),
        { addStacking: false, mods: ["RELAX"] },
      );
      const timeline = new BucketedGameStateTimeMachine(
        [
          frame(900, 500),
          frame(1_000, 500),
          frame(1_040, 500),
          frame(1_041, cursorX),
          frame(1_042, 500),
          frame(1_300, 500),
        ],
        map,
        stableOptions,
        1,
      );
      expect(timeline.gameStateAt(1_040).sliderVerdict["0"]).toBe("MISS");
      const fork = timeline.fork();
      const resolved = timeline.gameStateAt(1_041);
      expect(resolved.hitCircleVerdict["0/HEAD"]).toBeUndefined();
      expect(resolved.aliveHitCircleIds.has("0/HEAD")).toBe(true);
      expect(resolved.hitCircleVerdict["1"]).toEqual(
        cursorX === 300 ? { type: "OK", judgementTime: 1_041 } : undefined,
      );
      const final = timeline.gameStateAt(1_300);
      expect(final.hitCircleVerdict["0/HEAD"]).toMatchObject({ type: "MISS" });
      timeline.gameStateAt(900);
      expect(timeline.gameStateAt(1_300).hitCircleVerdict).toEqual(final.hitCircleVerdict);
      expect(fork.gameStateAt(1_300).hitCircleVerdict).toEqual(final.hitCircleVerdict);
    },
  );

  it("does not auto-hit a circle at exactly 12ms early", () => {
    const target = circle("target", 1_000, 300);
    const timeline = new BucketedGameStateTimeMachine(
      [frame(900, 500), frame(988, 300), frame(989, 500), frame(1_300, 500)],
      new Beatmap([target], DEFAULT_BEATMAP_DIFFICULTY, ["RELAX"], new ControlPointInfo()),
      stableOptions,
    );
    expect(timeline.gameStateAt(988).hitCircleVerdict.target).toBeUndefined();
    expect(timeline.gameStateAt(1_300).hitCircleVerdict.target).toMatchObject({ type: "MISS" });
  });

  it("auto-hits at the first recorded sample strictly inside the 12ms boundary", () => {
    const target = circle("target", 1_000, 300);
    const timeline = new BucketedGameStateTimeMachine(
      [frame(900, 500), frame(989, 300)],
      new Beatmap([target], DEFAULT_BEATMAP_DIFFICULTY, ["RELAX"], new ControlPointInfo()),
      stableOptions,
    );
    expect(timeline.gameStateAt(989).hitCircleVerdict.target).toEqual({ type: "GREAT", judgementTime: 989 });
  });

  it("gives each still-unjudged overlapping circle an automatic attempt in the same sample", () => {
    const timeline = new BucketedGameStateTimeMachine(
      [frame(900, 500), frame(1_000, 300), frame(1_001, 500), frame(1_300, 500)],
      new Beatmap(
        [circle("first", 1_000, 300), circle("second", 1_000, 300)],
        DEFAULT_BEATMAP_DIFFICULTY,
        ["RELAX"],
        new ControlPointInfo(),
      ),
      stableOptions,
      1,
    );
    timeline.gameStateAt(900);
    const fork = timeline.fork();
    const resolved = timeline.gameStateAt(1_000);
    expect(resolved.hitCircleVerdict.first).toEqual({ type: "GREAT", judgementTime: 1_000 });
    expect(resolved.hitCircleVerdict.second).toEqual({ type: "GREAT", judgementTime: 1_000 });
    const final = timeline.gameStateAt(1_300);
    timeline.gameStateAt(900);
    expect(timeline.gameStateAt(1_300).hitCircleVerdict).toEqual(final.hitCircleVerdict);
    expect(fork.gameStateAt(1_300).hitCircleVerdict).toEqual(final.hitCircleVerdict);
  });

  it("does not reuse an automatic attempt from a parent already judged by an earlier callback", () => {
    const timeline = new BucketedGameStateTimeMachine(
      [frame(900, 500), frame(1_000, 300)],
      new Beatmap(
        [circle("trigger", 1_000, 100), circle("selected", 1_000, 300), circle("later", 1_100, 300)],
        DEFAULT_BEATMAP_DIFFICULTY,
        ["RELAX"],
        new ControlPointInfo(),
      ),
      { ...stableOptions, noteLockStyle: "NONE" },
    );
    const resolved = timeline.gameStateAt(1_000);
    expect(resolved.hitCircleVerdict.selected).toEqual({ type: "GREAT", judgementTime: 1_000 });
    expect(resolved.hitCircleVerdict.later).toBeUndefined();
  });

  it("attempts automatic hits after the same sample expires an earlier circle", () => {
    const timeline = machine(true);
    expect(timeline.gameStateAt(1_103).hitCircleVerdict.target).toBeUndefined();
    const fork = timeline.fork();
    const resolved = timeline.gameStateAt(1_104);
    expect(resolved.hitCircleVerdict.expired).toMatchObject({ type: "MISS", judgementTime: 1_104 });
    expect(resolved.hitCircleVerdict.target).toEqual({ type: "GREAT", judgementTime: 1_104 });
    const final = timeline.gameStateAt(1_300);
    timeline.gameStateAt(1_103);
    expect(timeline.gameStateAt(1_300).hitCircleVerdict).toEqual(final.hitCircleVerdict);
    expect(fork.gameStateAt(1_300).hitCircleVerdict).toEqual(final.hitCircleVerdict);
  });

  it("keeps a physical press before expiry, so the earlier circle still blocks that press", () => {
    const timeline = machine(false);
    const resolved = timeline.gameStateAt(1_104);
    expect(resolved.hitCircleVerdict.expired).toMatchObject({ type: "MISS", judgementTime: 1_104 });
    expect(resolved.hitCircleVerdict.target).toBeUndefined();
    expect(resolved.stableNotelockEvidence.target).toMatchObject({ blockerHitObjectId: "expired", pressTime: 1_104 });
    expect(timeline.gameStateAt(1_300).hitCircleVerdict.target).toMatchObject({ type: "MISS" });
  });
});
