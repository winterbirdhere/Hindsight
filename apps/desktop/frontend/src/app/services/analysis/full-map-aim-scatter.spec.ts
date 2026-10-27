import {
  Beatmap,
  DEFAULT_BEATMAP_DIFFICULTY,
  HitCircle,
  OsuAction,
  PathType,
  ReplayAnalysisEvent,
  Slider,
  SliderPath,
  Spinner,
} from "@osujs/core";
import type { OsuReplay } from "../../model/OsuReplay";
import { collectFullMapAimScatter } from "./full-map-aim-scatter";

// Scale 0.5 gives a radius of 32 osu! pixels, which keeps the expected numbers round.
function circle(id: string, hitTime: number, x: number, y: number, scale = 0.5): HitCircle {
  const result = new HitCircle();
  result.id = id;
  result.hitTime = hitTime;
  result.scale = scale;
  result.position = { x, y };
  result.unstackedPosition = { x, y };
  return result;
}

// A slider whose body runs 100 pixels to the right of its head.
function slider(id: string, hitTime: number, x: number, y: number): Slider {
  const head = circle(`${id}/HEAD`, hitTime, x, y);
  head.sliderId = id;
  const result = new Slider(head);
  result.id = id;
  result.velocity = 1;
  result.repeatCount = 0;
  result.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }], 100);
  return result;
}

function spinner(id: string, startTime: number): Spinner {
  const result = new Spinner();
  result.id = id;
  result.startTime = startTime;
  result.duration = 500;
  return result;
}

function beatmapOf(hitObjects: Beatmap["hitObjects"]): Beatmap {
  return new Beatmap(hitObjects, { ...DEFAULT_BEATMAP_DIFFICULTY }, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
}

// One still cursor per entry, held either side of the press so the lookup lands exactly on it.
function replayAt(...cursors: { time: number; x: number; y: number }[]): OsuReplay {
  return {
    md5hash: "replay",
    beatmapMd5: "map",
    gameMode: 0,
    gameVersion: 1,
    mods: [],
    player: "Player",
    frames: cursors.flatMap(({ time, x, y }) => [
      { time: time - 10, position: { x, y }, actions: [] },
      { time: time + 10, position: { x, y }, actions: [OsuAction.leftButton] },
    ]),
  };
}

function hit(
  hitObjectId: string,
  time: number,
  verdict: "GREAT" | "OK" | "MEH" | "MISS" = "GREAT",
  extra: Record<string, unknown> = {},
): ReplayAnalysisEvent {
  return {
    type: "HitObjectJudgement",
    eventId: `stable:hit-object-judgement:${hitObjectId}`,
    ruleset: "stable",
    hitObjectId,
    verdict,
    time,
    objectTime: time,
    judgementTime: time,
    position: { x: 0, y: 0 },
    ...extra,
  } as ReplayAnalysisEvent;
}

// The previous circle sits left of the target, so the movement into it runs along +x already.
function movingRight(cursor: { x: number; y: number }) {
  const beatmap = beatmapOf([circle("a", 500, 100, 100), circle("b", 1_000, 200, 100)]);
  const replay = replayAt({ time: 1_000, ...cursor });
  return collectFullMapAimScatter(beatmap, replay, [hit("b", 1_000)]);
}

describe("collectFullMapAimScatter", () => {
  it("turns the offset so the movement runs along +x", () => {
    const scatter = movingRight({ x: 232, y: 100 });

    expect(scatter.available).toBe(true);
    expect(scatter.points).toHaveLength(1);
    expect(scatter.points[0]).toMatchObject({ time: 1_000, x: 1, y: 0, verdict: "GREAT" });
  });

  it("keeps the side of the path", () => {
    const scatter = movingRight({ x: 200, y: 132 });

    expect(scatter.points[0]).toMatchObject({ x: 0, y: 1 });
  });

  it("follows a downward movement", () => {
    const beatmap = beatmapOf([circle("a", 500, 200, 0), circle("b", 1_000, 200, 100)]);
    const replay = replayAt({ time: 1_000, x: 200, y: 116 });

    const scatter = collectFullMapAimScatter(beatmap, replay, [hit("b", 1_000)]);

    expect(scatter.points[0]).toMatchObject({ x: 0.5, y: 0 });
  });

  it("measures a slider head from the object before the slider, and the next circle from the slider's end", () => {
    // Head (200,100) comes from a circle straight above it; the slider ends at (300,100), so the circle
    // below that end is approached downward. Measured from the head instead the direction would be diagonal.
    const beatmap = beatmapOf([circle("a", 500, 200, 0), slider("s", 1_000, 200, 100), circle("c", 1_500, 300, 200)]);
    const replay = replayAt({ time: 1_000, x: 216, y: 100 }, { time: 1_500, x: 300, y: 216 });

    const scatter = collectFullMapAimScatter(beatmap, replay, [
      hit("s/HEAD", 1_000, "GREAT", { isSliderHead: true }),
      hit("c", 1_500),
    ]);

    expect(scatter.points).toHaveLength(2);
    expect(scatter.points[0]).toMatchObject({ time: 1_000, x: 0, y: -0.5 });
    expect(scatter.points[1]).toMatchObject({ time: 1_500, x: 0.5, y: 0 });
    expect(scatter.omittedCount).toBe(0);
  });

  it("leaves out the first object, a hit after a spinner and a stacked hit, and counts them", () => {
    const beatmap = beatmapOf([
      circle("first", 500, 100, 100), // no object before it
      circle("b", 1_000, 200, 100),
      spinner("spin", 1_200),
      circle("afterSpinner", 2_000, 300, 100), // a spinner has no end point to move from
      circle("d", 2_500, 400, 100),
      circle("stacked", 3_000, 400, 100), // same place as the one before: no direction
      circle("missed", 3_500, 50, 50),
    ]);
    const replay = replayAt(
      { time: 500, x: 100, y: 100 },
      { time: 1_000, x: 216, y: 100 },
      { time: 2_000, x: 300, y: 100 },
      { time: 2_500, x: 416, y: 100 },
      { time: 3_000, x: 400, y: 100 },
    );

    const scatter = collectFullMapAimScatter(beatmap, replay, [
      hit("first", 500),
      hit("b", 1_000),
      hit("afterSpinner", 2_000),
      hit("d", 2_500, "OK"),
      hit("stacked", 3_000),
      hit("missed", 3_500, "MISS"),
    ]);

    expect(scatter.omittedCount).toBe(3);
    expect(scatter.points.map((point) => point.time)).toEqual([1_000, 2_500]);
    expect(scatter.points[1].verdict).toBe("OK");
    // The miss is not a hit: it is not counted in omittedCount. The cursor has no sample at 3_500, so it is
    // counted as a miss that could not be placed.
    expect(scatter.misses).toEqual([]);
    expect(scatter.omittedMissCount).toBe(1);
  });

  it("gives the mean of the plotted points and null when there are none", () => {
    const beatmap = beatmapOf([circle("a", 500, 100, 100), circle("b", 1_000, 200, 100), circle("c", 1_500, 300, 100)]);
    // b is hit 1 radius ahead on the path, c one radius to the side.
    const replay = replayAt({ time: 1_000, x: 232, y: 100 }, { time: 1_500, x: 300, y: 132 });

    const scatter = collectFullMapAimScatter(beatmap, replay, [hit("b", 1_000), hit("c", 1_500, "MEH")]);

    expect(scatter.points).toHaveLength(2);
    expect(scatter.mean).toEqual({ x: 0.5, y: 0.5 });

    const empty = collectFullMapAimScatter(beatmap, replay, []);
    expect(empty.points).toEqual([]);
    expect(empty.mean).toBeNull();
  });

  it("plots Lazer judgements exactly as Stable ones, at the judged press's time", () => {
    const beatmap = beatmapOf([circle("a", 500, 100, 100), circle("b", 1_000, 200, 100), slider("s", 2_000, 300, 100)]);
    // Between the 990 and 1010 samples the cursor moves 20 pixels: it is at (220,100) at 1000 and (230,100) at 1005.
    const replay: OsuReplay = {
      ...replayAt({ time: 2_000, x: 332, y: 100 }),
      frames: [
        { time: 990, position: { x: 200, y: 100 }, actions: [] },
        { time: 1_010, position: { x: 240, y: 100 }, actions: [OsuAction.leftButton] },
        { time: 1_990, position: { x: 332, y: 100 }, actions: [] },
        { time: 2_010, position: { x: 332, y: 100 }, actions: [OsuAction.leftButton] },
      ],
    };
    const lazer = { ruleset: "lazer" as const, eventId: "lazer:hit-object-judgement" };

    const scatter = collectFullMapAimScatter(beatmap, replay, [
      hit("b", 1_000, "GREAT", { ...lazer, judgementTime: 1_005 }),
      // A Classic slider head does not affect accuracy but is still a judged hit at a cursor position.
      hit("s/HEAD", 2_000, "OK", { ...lazer, isSliderHead: true, affectsAccuracy: false }),
    ]);

    expect(scatter.points).toHaveLength(2);
    expect(scatter.points[0]).toMatchObject({ time: 1_005, x: 0.9375, y: 0, verdict: "GREAT" });
    expect(scatter.points[1]).toMatchObject({ time: 2_000, x: 1, y: 0, verdict: "OK" });
  });

  it("is unavailable under autoplay, autopilot and an empty replay, each with its reason", () => {
    const beatmap = beatmapOf([circle("a", 500, 100, 100), circle("b", 1_000, 200, 100)]);
    const events = [hit("b", 1_000)];
    const base = replayAt({ time: 1_000, x: 232, y: 100 });

    for (const mod of ["AUTO_PLAY", "AUTO_PILOT"] as const) {
      expect(collectFullMapAimScatter(beatmap, { ...base, mods: [mod] }, events)).toEqual({
        available: false,
        unavailableReason: "Aim is automated by the loaded replay's mods.",
        points: [],
        mean: null,
        omittedCount: 0,
        omittedMissCount: 0,
        misses: [],
      });
    }
    expect(collectFullMapAimScatter(beatmap, { ...base, frames: [] }, events)).toEqual({
      available: false,
      unavailableReason: "The replay contains no cursor frames.",
      points: [],
      mean: null,
      omittedCount: 0,
      omittedMissCount: 0,
      misses: [],
    });
  });

  it("is unavailable, with the usable-evidence reason, when no hit has a cursor position or a direction", () => {
    const beatmap = beatmapOf([circle("only", 1_000, 200, 100)]);

    // The only object has no object before it, so the one hit is left out and counted.
    const scatter = collectFullMapAimScatter(beatmap, replayAt({ time: 1_000, x: 200, y: 100 }), [hit("only", 1_000)]);

    expect(scatter).toMatchObject({
      available: false,
      unavailableReason: "No hit had usable cursor evidence.",
      points: [],
      mean: null,
      omittedCount: 1,
    });
  });

  it("never returns NaN for a zero radius or a same-timestamp frame the cursor lookup refuses", () => {
    const beatmap = beatmapOf([
      circle("a", 500, 100, 100),
      circle("flat", 1_000, 200, 100, 0),
      circle("ambiguous", 1_500, 300, 100),
      circle("fine", 2_000, 400, 100),
    ]);
    const replay: OsuReplay = {
      ...replayAt({ time: 1_000, x: 200, y: 100 }),
      frames: [
        { time: 990, position: { x: 200, y: 100 }, actions: [] },
        { time: 1_010, position: { x: 200, y: 100 }, actions: [OsuAction.leftButton] },
        // Two samples share 1_500 and disagree: the press cannot be placed.
        { time: 1_499, position: { x: 300, y: 100 }, actions: [] },
        { time: 1_500, position: { x: 300, y: 100 }, actions: [OsuAction.leftButton] },
        { time: 1_500, position: { x: 340, y: 100 }, actions: [] },
        { time: 1_600, position: { x: 340, y: 100 }, actions: [] },
        { time: 1_990, position: { x: 416, y: 100 }, actions: [] },
        { time: 2_010, position: { x: 416, y: 100 }, actions: [OsuAction.leftButton] },
      ],
    };

    const scatter = collectFullMapAimScatter(beatmap, replay, [
      hit("flat", 1_000),
      hit("ambiguous", 1_500),
      hit("fine", 2_000),
    ]);

    expect(scatter.points).toHaveLength(1);
    expect(scatter.points[0]).toMatchObject({ time: 2_000, x: 0.5, y: 0 });
    // The zero-radius hit had a cursor but cannot be scaled, so it is counted; the ambiguous press had no cursor.
    expect(scatter.omittedCount).toBe(1);
    expect(scatter.mean).toEqual({ x: 0.5, y: 0 });
    for (const value of [...scatter.points.flatMap((p) => [p.x, p.y]), scatter.mean?.x, scatter.mean?.y]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("counts one object once when it is judged twice", () => {
    const beatmap = beatmapOf([circle("a", 500, 100, 100), circle("b", 1_000, 200, 100)]);
    const replay = replayAt({ time: 1_000, x: 232, y: 100 });

    const scatter = collectFullMapAimScatter(beatmap, replay, [hit("b", 1_000), hit("b", 1_000)]);

    expect(scatter.points).toHaveLength(1);
  });
});

describe("collectFullMapAimScatter misses", () => {
  // Two hits give the scatter its evidence; the missed circle follows. The movement into "m" runs along +x.
  const mapWithMiss = () =>
    beatmapOf([circle("a", 500, 100, 100), circle("b", 1_000, 200, 100), circle("m", 2_000, 300, 100)]);
  const hits = [hit("b", 1_000)];
  const base = (...missCursors: { time: number; x: number; y: number }[]) =>
    replayAt({ time: 1_000, x: 232, y: 100 }, ...missCursors);

  it("puts a miss with the cursor on the note inside radius 1, at the rotated offset", () => {
    const replay = base({ time: 2_000, x: 316, y: 116 });

    const scatter = collectFullMapAimScatter(mapWithMiss(), replay, [...hits, hit("m", 2_000, "MISS")]);

    expect(scatter.misses).toHaveLength(1);
    expect(scatter.misses[0]).toMatchObject({ time: 2_000, x: 0.5, y: 0.5 });
    expect(Math.hypot(scatter.misses[0].x, scatter.misses[0].y)).toBeLessThanOrEqual(1);
    expect(scatter.omittedMissCount).toBe(0);
    // The hit list is not touched by the miss.
    expect(scatter.points).toHaveLength(1);
  });

  it("turns a miss the same way as a hit when the movement is not along +x", () => {
    // The movement into "m" runs downward, so the cursor left of the note is a full radius to the side.
    const beatmap = beatmapOf([circle("a", 500, 200, 0), circle("b", 1_000, 200, 100), circle("m", 2_000, 200, 200)]);
    const replay = replayAt({ time: 1_000, x: 216, y: 100 }, { time: 2_000, x: 168, y: 200 });

    const scatter = collectFullMapAimScatter(beatmap, replay, [hit("b", 1_000), hit("m", 2_000, "MISS")]);

    expect(scatter.misses[0].x).toBeCloseTo(0, 10);
    expect(scatter.misses[0].y).toBeCloseTo(1, 10);
  });

  it("keeps the true offset of a miss with the cursor away from the note", () => {
    const replay = base({ time: 2_000, x: 400, y: 100 });

    const scatter = collectFullMapAimScatter(mapWithMiss(), replay, [...hits, hit("m", 2_000, "MISS")]);

    expect(scatter.misses[0]).toMatchObject({ time: 2_000, x: 3.125, y: 0 });
  });

  it("places the cursor at the object's hit time, not at the time the miss was judged", () => {
    const replay = base({ time: 2_000, x: 300, y: 100 }, { time: 2_200, x: 500, y: 100 });

    const scatter = collectFullMapAimScatter(mapWithMiss(), replay, [
      ...hits,
      hit("m", 2_000, "MISS", { judgementTime: 2_200, time: 2_200 }),
    ]);

    expect(scatter.misses).toHaveLength(1);
    expect(scatter.misses[0]).toMatchObject({ time: 2_000, x: 0, y: 0 });
  });

  it("counts a missed slider head, and nothing for the slider's own judgement, its breaks or its end", () => {
    const beatmap = beatmapOf([circle("a", 500, 100, 100), slider("s", 1_000, 200, 100), circle("c", 2_000, 300, 200)]);
    const replay = replayAt({ time: 1_000, x: 216, y: 100 }, { time: 2_000, x: 300, y: 216 });
    const sliderEvent = (type: string, extra: Record<string, unknown>) =>
      ({
        type,
        eventId: `stable:${type}`,
        ruleset: "stable",
        time: 1_200,
        objectTime: 1_000,
        judgementTime: 1_200,
        position: { x: 0, y: 0 },
        ...extra,
      }) as unknown as ReplayAnalysisEvent;

    const scatter = collectFullMapAimScatter(beatmap, replay, [
      // The whole slider's verdict carries the slider's own id: it is not a circle.
      hit("s", 1_000, "MISS"),
      sliderEvent("SliderBreak", { sliderId: "s", componentId: "s/0", componentType: "REPEAT" }),
      sliderEvent("SliderEndJudgement", { sliderId: "s", hitObjectId: "s", verdict: "MISS" }),
      sliderEvent("SliderComponentMiss", { sliderId: "s", componentId: "s/END", componentType: "TAIL" }),
      hit("c", 2_000),
    ]);
    expect(scatter.misses).toEqual([]);
    expect(scatter.omittedMissCount).toBe(0);

    const headMissed = collectFullMapAimScatter(beatmap, replay, [
      hit("s/HEAD", 1_000, "MISS", { isSliderHead: true }),
      hit("c", 2_000),
    ]);
    expect(headMissed.misses).toHaveLength(1);
    expect(headMissed.misses[0]).toMatchObject({ time: 1_000, x: 0.5, y: 0 });
  });

  it("keeps Lazer misses the same as Stable ones", () => {
    const replay = base({ time: 2_000, x: 316, y: 100 });
    const lazer = { ruleset: "lazer" as const, eventId: "lazer:hit-object-judgement" };

    const scatter = collectFullMapAimScatter(mapWithMiss(), replay, [...hits, hit("m", 2_000, "MISS", lazer)]);

    expect(scatter.misses).toHaveLength(1);
    expect(scatter.misses[0]).toMatchObject({ x: 0.5, y: 0 });
  });

  it("counts a missed first object, with no direction, as a miss not placed and leaves omittedCount alone", () => {
    const beatmap = beatmapOf([circle("first", 500, 100, 100), circle("b", 1_000, 200, 100)]);
    const replay = replayAt({ time: 500, x: 100, y: 100 }, { time: 1_000, x: 232, y: 100 });

    const scatter = collectFullMapAimScatter(beatmap, replay, [hit("first", 500, "MISS"), hit("b", 1_000)]);

    expect(scatter.misses).toEqual([]);
    expect(scatter.omittedMissCount).toBe(1);
    expect(scatter.omittedCount).toBe(0);
    expect(scatter.points).toHaveLength(1);
  });

  it("counts a miss with no cursor position as not placed", () => {
    const replay = base(); // no sample near 2_000

    const scatter = collectFullMapAimScatter(mapWithMiss(), replay, [...hits, hit("m", 2_000, "MISS")]);

    expect(scatter.misses).toEqual([]);
    expect(scatter.omittedMissCount).toBe(1);
    expect(scatter.omittedCount).toBe(0);
  });

  it("takes a missed object once", () => {
    const replay = base({ time: 2_000, x: 316, y: 100 });

    const scatter = collectFullMapAimScatter(mapWithMiss(), replay, [
      ...hits,
      hit("m", 2_000, "MISS"),
      hit("m", 2_000, "MISS"),
    ]);

    expect(scatter.misses).toHaveLength(1);
  });

  describe("an object with both a miss and a hit event", () => {
    const replay = () => base({ time: 2_000, x: 316, y: 100 });

    it("is a point and not a ring when the miss comes first", () => {
      const scatter = collectFullMapAimScatter(mapWithMiss(), replay(), [
        ...hits,
        hit("m", 2_000, "MISS"),
        hit("m", 2_000, "GREAT"),
      ]);

      expect(scatter.points.map((point) => point.time)).toEqual([1_000, 2_000]);
      expect(scatter.misses).toEqual([]);
      expect(scatter.omittedMissCount).toBe(0);
      expect(scatter.mean?.x).toBeCloseTo((1 + 0.5) / 2, 10);
    });

    it("is a point and not a ring when the hit comes first", () => {
      const scatter = collectFullMapAimScatter(mapWithMiss(), replay(), [
        ...hits,
        hit("m", 2_000, "GREAT"),
        hit("m", 2_000, "MISS"),
      ]);

      expect(scatter.points.map((point) => point.time)).toEqual([1_000, 2_000]);
      expect(scatter.misses).toEqual([]);
      expect(scatter.omittedMissCount).toBe(0);
    });

    it("does not leave a miss that could not be placed counted when a hit wins", () => {
      // No cursor sample near 2_000: the miss alone would be counted as not placed; the hit has none either.
      const noCursor = base();
      const scatter = collectFullMapAimScatter(mapWithMiss(), noCursor, [
        ...hits,
        hit("m", 2_000, "MISS"),
        hit("m", 2_000, "GREAT"),
      ]);

      expect(scatter.misses).toEqual([]);
      expect(scatter.omittedMissCount).toBe(0);
    });

    it("keeps the other misses when one miss is withdrawn", () => {
      const beatmap = beatmapOf([
        circle("a", 500, 100, 100),
        circle("b", 1_000, 200, 100),
        circle("m", 2_000, 300, 100),
        circle("n", 3_000, 400, 100),
      ]);
      const cursors = replayAt(
        { time: 1_000, x: 232, y: 100 },
        { time: 2_000, x: 316, y: 100 },
        { time: 3_000, x: 400, y: 100 },
      );

      const scatter = collectFullMapAimScatter(beatmap, cursors, [
        hit("b", 1_000),
        hit("m", 2_000, "MISS"),
        hit("n", 3_000, "MISS"),
        hit("m", 2_000, "GREAT"),
      ]);

      expect(scatter.misses).toHaveLength(1);
      expect(scatter.misses[0]).toMatchObject({ time: 3_000, x: 0, y: 0 });
      expect(scatter.points).toHaveLength(2);
    });
  });

  it("reports no misses, and none not placed, when nothing was missed", () => {
    const scatter = collectFullMapAimScatter(mapWithMiss(), base(), hits);

    expect(scatter.misses).toEqual([]);
    expect(scatter.omittedMissCount).toBe(0);
  });
});
