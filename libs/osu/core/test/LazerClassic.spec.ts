import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { retrieveEvents, isHitObjectJudgement } from "../src/gameplay/GameplayAnalysisEvent";
import { LazerGameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { SliderCheckPoint } from "../src/hitobjects/SliderCheckPoint";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";
import { PathType } from "../src/hitobjects/slider/PathType";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

function circle(id: string, time: number, x = 100): HitCircle {
  const result = new HitCircle();
  Object.assign(result, { id, hitTime: time, approachDuration: 600, position: { x, y: 192 } });
  return result;
}

function slider(withTick = false): Slider {
  const head = circle("slider/HEAD", 1000);
  head.sliderId = "slider";
  const result = new Slider(head);
  result.id = "slider";
  result.velocity = 0.1;
  result.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }], 100);
  if (withTick) {
    const tick = new SliderCheckPoint(result);
    Object.assign(tick, { id: "slider/TICK", type: "TICK", hitTime: 1500, offset: { x: 50, y: 0 }, spanProgress: 0.5 });
    result.checkPoints = [tick];
  }
  return result;
}

const frame = (time: number, x: number, pressed = false): ReplayFrame => ({
  time,
  position: { x, y: 192 },
  actions: pressed ? [OsuAction.leftButton] : [],
});

function map(objects: Beatmap["hitObjects"], settings: Record<string, unknown> = {}): Beatmap {
  return new Beatmap(
    objects,
    DEFAULT_BEATMAP_DIFFICULTY,
    [],
    new ControlPointInfo(),
    false,
    [],
    [],
    [{ acronym: "CL", settings }],
  );
}

describe("lazer Classic slider scoring", () => {
  it("gives a late head full tick credit and scores the parent proportionally", () => {
    const object = slider();
    const beatmap = map([object]);
    const state = new LazerGameStateTimeMachine(
      [frame(0, 100), frame(1100, 100, true), frame(1964, 196.4, true), frame(2001, 200, true)],
      beatmap,
    ).gameStateAt(2001);
    expect(state.hitCircleVerdict[object.head.id].type).toBe("MEH");
    expect(state.sliderVerdict[object.id]).toBe("GREAT");
    expect(state.lazerJudgements.map((item) => item.result)).toEqual(["LARGE_TICK_HIT", "SMALL_TICK_HIT", "GREAT"]);
    const info = new LazerGameplayInfoEvaluator().evaluateReplayState(state);
    expect(info.verdictCounts).toEqual([1, 0, 0, 0]);
    expect(info.accuracy).toBe(1);
    expect(info.currentCombo).toBe(2);
    const events = retrieveEvents(state, beatmap.hitObjects, "lazer").filter(isHitObjectJudgement);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hitObjectId: object.head.id, affectsAccuracy: false }),
        expect.objectContaining({ hitObjectId: object.id, verdict: "GREAT" }),
      ]),
    );
  });

  it("scores a missed tail at 10 points and awards the final combo through the parent", () => {
    const object = slider();
    const state = new LazerGameStateTimeMachine(
      [frame(1000, 100, true), frame(1100, 100), frame(2001, 100)],
      map([object]),
    ).gameStateAt(2001);
    expect(state.lazerJudgements.map((item) => item.result)).toEqual(["LARGE_TICK_HIT", "SMALL_TICK_MISS", "OK"]);
    const info = new LazerGameplayInfoEvaluator().evaluateReplayState(state);
    expect(info.accuracy).toBeCloseTo(130 / 340);
    expect(info.currentCombo).toBe(2);
    expect(info.verdictCounts).toEqual([0, 1, 0, 0]);
  });

  it("emits one main miss for a fully missed slider and a separate head component miss", () => {
    const object = slider();
    const beatmap = map([object]);
    const state = new LazerGameStateTimeMachine([frame(2001, 500)], beatmap).gameStateAt(2001);
    expect(state.lazerJudgements.map((item) => item.result)).toEqual(["LARGE_TICK_MISS", "SMALL_TICK_MISS", "MISS"]);
    expect(new LazerGameplayInfoEvaluator().evaluateReplayState(state).verdictCounts).toEqual([0, 0, 0, 1]);
    expect(retrieveEvents(state, beatmap.hitObjects, "lazer")).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "SliderComponentMiss", componentType: "HEAD" })]),
    );
  });

  it("uses all nested parts for 50/100 boundaries and resets combo on missed ticks", () => {
    const object = slider(true);
    const state = new LazerGameStateTimeMachine(
      [frame(1000, 100, true), frame(1100, 100), frame(2001, 100)],
      map([object]),
    ).gameStateAt(2001);
    expect(state.sliderVerdict[object.id]).toBe("MEH");
    expect(new LazerGameplayInfoEvaluator().evaluateReplayState(state)).toMatchObject({
      currentCombo: 1,
      maxComboSoFar: 1,
      verdictCounts: [0, 0, 1, 0],
    });
  });

  it("keeps native tail leniency, frame ordering and rewind with Classic", () => {
    const object = slider();
    const machine = new LazerGameStateTimeMachine(
      [frame(1000, 100, true), frame(1100, 100), frame(1980, 198, true), frame(2001, 200, true)],
      map([object]),
      1,
    );
    const end = machine.gameStateAt(2001);
    expect(end.sliderTailVerdict[object.id]).toMatchObject({ hit: true, judgementTime: 1980 });
    expect(machine.gameStateAt(1500).sliderTailVerdict[object.id]).toBeUndefined();
    expect(machine.gameStateAt(2001)).toEqual(end);
  });

  it("allows disabling Classic slider accuracy independently of its note lock", () => {
    const object = slider();
    const state = new LazerGameStateTimeMachine(
      [frame(1100, 100, true), frame(2001, 200, true)],
      map([object], { no_slider_head_accuracy: false }),
    ).gameStateAt(2001);
    expect(state.lazerJudgements.map((item) => item.result)).toEqual(["MEH", "SLIDER_TAIL_HIT"]);
    expect(state.lazerJudgements.some((item) => item.kind === "SLIDER")).toBe(false);
  });
});

describe("lazer Classic note lock", () => {
  it("blocks throughout the previous circle's full hit window, without force misses", () => {
    const earlier = circle("earlier", 1000);
    const later = circle("later", 1100, 300);
    const state = new LazerGameStateTimeMachine([frame(1050, 300, true)], map([earlier, later])).gameStateAt(1050);
    expect(state.hitCircleVerdict).toEqual({});
    expect(state.lazerNotelockEvidence[later.id]).toMatchObject({ blockerHitObjectId: earlier.id, pressTime: 1050 });
  });

  it("keeps default native force-miss behaviour when Classic note lock is disabled", () => {
    const earlier = circle("earlier", 1000);
    const later = circle("later", 1100, 300);
    const state = new LazerGameStateTimeMachine(
      [frame(1050, 300, true)],
      map([earlier, later], { classic_note_lock: false }),
    ).gameStateAt(1050);
    expect(state.hitCircleVerdict[earlier.id].type).toBe("MISS");
    expect(state.hitCircleVerdict[later.id].type).toBe("OK");
  });

  it("matches Classic's unsuccessful head result mapping when note lock is disabled", () => {
    const object = slider();
    const state = new LazerGameStateTimeMachine(
      [frame(500, 100, true)],
      map([object], { classic_note_lock: false }),
    ).gameStateAt(500);
    expect(state.hitCircleVerdict[object.head.id]).toMatchObject({ type: "MISS", judgementTime: 500 });
    expect(state.lazerJudgements[0].result).toBe("LARGE_TICK_MISS");
  });

  it("allows overlapping top-level slider timing but keeps its head hit area blocking", () => {
    const object = slider();
    const later = circle("later", 1100, 300);
    const frames = [frame(1000, 100, true), frame(1010, 100), frame(1050, 300, true)];
    expect(
      new LazerGameStateTimeMachine(frames, map([object, later])).gameStateAt(1050).hitCircleVerdict[later.id].type,
    ).toBe("OK");
    const beneath = circle("beneath", 1100, 110);
    const blockedFrames = [frame(1000, 100, true), frame(1010, 100), frame(1050, 110, true)];
    expect(
      new LazerGameStateTimeMachine(blockedFrames, map([slider(), beneath])).gameStateAt(1050).hitCircleVerdict[
        beneath.id
      ],
    ).toBeUndefined();
  });

  it("silently ignores positive stacks and respects the strict 400ms miss-input boundary", () => {
    const earlier = circle("earlier", 1000);
    earlier.stackHeight = 1;
    const later = circle("later", 1100, 300);
    const state = new LazerGameStateTimeMachine([frame(1000, 300, true)], map([earlier, later])).gameStateAt(1000);
    expect(state.lastNotelockShakeTime[later.id]).toBeUndefined();
    const alone = circle("alone", 1000);
    const boundary = new LazerGameStateTimeMachine([frame(600, 100, true)], map([alone])).gameStateAt(600);
    expect(boundary.hitCircleVerdict[alone.id]).toBeUndefined();
    expect(boundary.lastNotelockShakeTime[alone.id]).toBe(600);
  });
});
