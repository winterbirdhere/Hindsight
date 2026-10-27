import {
  Beatmap,
  DEFAULT_BEATMAP_DIFFICULTY,
  defaultGameState,
  HitCircle,
  PathType,
  Slider,
  SliderPath,
} from "@osujs/core";
import { OsuReplay } from "../../../model/OsuReplay";
import { buildReplayPerformanceInput, PerformanceMode } from "./replay-performance-input";

const circle = (id: string, hitTime: number) => Object.assign(new HitCircle(), { id, hitTime });
const map = (objects: Beatmap["hitObjects"]) =>
  new Beatmap(objects, DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
const replay: OsuReplay = {
  gameVersion: 20260711,
  gameMode: 0,
  md5hash: "timing",
  beatmapMd5: "timing",
  player: "Player",
  mods: [],
  frames: [{ time: 2000, position: { x: 0, y: 0 }, actions: [] }],
};

describe("live performance publication at observed circle judgements", () => {
  it.each(["stable", "lazer"] as PerformanceMode[])(
    "publishes an early %s circle at its actual hit without leaking the next result",
    (mode) => {
      const state = defaultGameState();
      const first = circle("first", 1000);
      const next = circle("next", 1100);
      state.hitCircleVerdict.first = { type: "GREAT", judgementTime: 950 };
      state.hitCircleVerdict.next = { type: "OK", judgementTime: 1150 };
      state.judgedObjects.push("first", "next");
      state.lazerJudgements.push(
        { id: "first/j", hitObjectId: "first", kind: "CIRCLE", result: "GREAT", objectTime: 1000, judgementTime: 950 },
        { id: "next/j", hitObjectId: "next", kind: "CIRCLE", result: "OK", objectTime: 1100, judgementTime: 1150 },
      );
      const input = buildReplayPerformanceInput({ beatmap: map([first, next]), state, replay, mode });
      expect(input.states.filter((s) => s.time <= 949)).toEqual([]);
      expect(input.states.filter((s) => s.time <= 950)).toEqual([
        expect.objectContaining({
          time: 950,
          passedObjects: 1,
          statistics: expect.objectContaining({ great: 1, ok: 0 }),
        }),
      ]);
      expect(input.states[1]).toMatchObject({ time: 1150, passedObjects: 2, statistics: { great: 1, ok: 1 } });
    },
  );

  it("retains a genuinely resolved early circle when the replay ends before its nominal hit time", () => {
    const state = defaultGameState();
    state.hitCircleVerdict.first = { type: "GREAT", judgementTime: 950 };
    state.judgedObjects.push("first");
    const input = buildReplayPerformanceInput({
      beatmap: map([circle("first", 1000)]),
      state,
      replay,
      mode: "stable",
      finalReplayTime: 960,
    });
    expect(input.states[0]).toMatchObject({ time: 950, passedObjects: 1, statistics: { great: 1 } });
    expect(input.states.at(-1)).toMatchObject({ time: 960, isFinal: true, statistics: { great: 1 } });
  });

  it("continues withholding a late circle until its observed judgement", () => {
    const state = defaultGameState();
    state.hitCircleVerdict.late = { type: "OK", judgementTime: 1080 };
    state.judgedObjects.push("late");
    const input = buildReplayPerformanceInput({ beatmap: map([circle("late", 1000)]), state, replay, mode: "stable" });
    expect(input.states.filter((s) => s.time <= 1079)).toEqual([]);
    expect(input.states[0]).toMatchObject({ time: 1080, statistics: { ok: 1 } });
  });

  it("still waits for an earlier overlapping slider before publishing a later circle", () => {
    const head = circle("slider/head", 100);
    head.sliderId = "slider";
    const slider = new Slider(head);
    slider.id = "slider";
    slider.velocity = 100 / 900;
    slider.path = new SliderPath(
      [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }],
      100,
    );
    const state = defaultGameState();
    state.hitCircleVerdict[head.id] = { type: "GREAT", judgementTime: 100 };
    state.hitCircleVerdict.later = { type: "GREAT", judgementTime: 450 };
    state.sliderVerdict.slider = "GREAT";
    state.sliderJudgementTime.slider = 1000;
    state.judgedObjects.push(head.id, "later", slider.id);
    const input = buildReplayPerformanceInput({
      beatmap: map([slider, circle("later", 500)]),
      state,
      replay,
      mode: "stable",
    });
    expect(input.states.filter((s) => s.time < 1000)).toEqual([]);
    expect(input.states[1]).toMatchObject({ time: 1000, passedObjects: 2, statistics: { great: 2 } });
  });
});
