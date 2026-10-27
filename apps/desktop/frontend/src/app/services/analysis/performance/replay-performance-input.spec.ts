import {
  Beatmap,
  buildBeatmap,
  BucketedGameStateTimeMachine,
  DEFAULT_BEATMAP_DIFFICULTY,
  defaultGameState,
  GameState,
  HitCircle,
  LazerJudgement,
  LazerMod,
  PathType,
  parseBlueprint,
  Slider,
  SliderCheckPoint,
  SliderPath,
  Spinner,
} from "@osujs/core";
import { OsuReplay } from "../../../model/OsuReplay";
import { buildReplayPerformanceInput, buildReplayPerformanceInputAsync, fullComboMaxCombo, fullComboPerformanceState, performanceJudgements } from "./replay-performance-input";

function circle(id: string, hitTime: number): HitCircle {
  return Object.assign(new HitCircle(), { id, hitTime });
}

function slider(id: string, start = 100, end = 500): Slider {
  const head = circle(`${id}/head`, start);
  head.sliderId = id;
  const result = new Slider(head);
  result.id = id;
  result.velocity = 100 / (end - start);
  result.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }], 100);
  return result;
}

function checkpoint(object: Slider, id: string, time: number, type: SliderCheckPoint["type"]): SliderCheckPoint {
  const point = Object.assign(new SliderCheckPoint(object), { id, hitTime: time, type });
  object.checkPoints.push(point);
  return point;
}

function map(objects: Beatmap["hitObjects"], mods: readonly LazerMod[] = []): Beatmap {
  return new Beatmap(
    objects,
    DEFAULT_BEATMAP_DIFFICULTY,
    [],
    Beatmap.EMPTY_BEATMAP.controlPointInfo,
    false,
    [],
    [],
    mods,
  );
}

function replay(end = 1000, native = false): OsuReplay {
  return {
    gameVersion: native ? 30_000_019 : 20_260_904,
    gameMode: 0,
    md5hash: "replay",
    beatmapMd5: "map",
    player: "Player",
    mods: [],
    frames: [{ time: end, position: { x: 0, y: 0 }, actions: [] }],
  };
}

function nativeJudgement(
  state: GameState,
  id: string,
  kind: LazerJudgement["kind"],
  result: LazerJudgement["result"],
  time: number,
): void {
  state.lazerJudgements.push({
    id: `${id}/${kind}`,
    hitObjectId: id,
    kind,
    result,
    objectTime: time,
    judgementTime: time,
  });
}

describe("performance inputs from complete difficulty prefixes", () => {
  it("holds and cancels inside a large slider prefix without losing event order",async()=>{
    const object=slider("long",100,5000),state=defaultGameState();
    state.sliderVerdict[object.id]="GREAT";state.judgedObjects.push(object.id);
    for(let i=0;i<2048;i++){
      const point=checkpoint(object,`tick-${i}`,101+i,"TICK");
      state.checkPointVerdict[point.id]={hit:i!==1024,judgementTime:point.hitTime};state.judgedObjects.push(point.id);
    }
    let completionReads=0;
    Object.defineProperty(state.sliderJudgementTime,object.id,{get:()=>{completionReads++;return 5000;}});
    const input={beatmap:map([object]),state,replay:replay(5000),mode:"stable" as const,stateIsScoringBounded:true};
    const expected=buildReplayPerformanceInput(input);completionReads=0;
    let release:()=>void=()=>undefined,held=false,settled=false;
    const hold=new Promise<void>(resolve=>{release=resolve;});
    let reached:()=>void=()=>undefined;const atPrefix=new Promise<void>(resolve=>{reached=resolve;});
    const pending=buildReplayPerformanceInputAsync(input,async()=>{
      if(completionReads>=2&&!held){held=true;reached();await hold;}
    }).then(value=>{settled=true;return value;});
    await atPrefix;await Promise.resolve();expect(settled).toBe(false);release();
    expect(await pending).toEqual(expected);expect(held).toBe(true);
    completionReads=0;
    await expect(buildReplayPerformanceInputAsync(input,async()=>{
      if(completionReads>=2)throw Error("cancelled inside prefix");
    })).rejects.toThrow("cancelled inside prefix");
    expect(buildReplayPerformanceInput(input)).toEqual(expected);
  });
  it.each(["stable","lazer","lazer-classic"] as const)("cooperative %s construction preserves exact prefixes and can stop at inner checkpoints",async mode=>{
    const objects=Array.from({length:1024},(_,index)=>circle(String(index),1000+index*10)),beatmap=map(objects),state=defaultGameState();
    objects.forEach((object,index)=>{
      state.hitCircleVerdict[object.id]={type:index%9===0?"OK":"GREAT",judgementTime:object.hitTime};state.judgedObjects.push(object.id);
      nativeJudgement(state,object.id,"CIRCLE",index%9===0?"OK":"GREAT",object.hitTime);
    });
    const source=replay(15000,mode!=="stable");if(mode==="lazer-classic")source.lazerMods=[{acronym:"CL"}];
    const input={beatmap,state,replay:source,mode,finalReplayTime:6000,stateIsScoringBounded:true},checkpoint=jest.fn(async()=>undefined);
    expect(await buildReplayPerformanceInputAsync(input,checkpoint)).toEqual(buildReplayPerformanceInput(input));expect(checkpoint.mock.calls.length).toBeGreaterThan(8);
    expect(checkpoint.mock.calls.length).toBeLessThan(100); // Batch ordinary prefixes; do not pay a timer per object.
    let count=0;await expect(buildReplayPerformanceInputAsync(input,async()=>{if(++count===4)throw Error("cancelled");})).rejects.toThrow("cancelled");
  });
  it.each([1124, 1200])("includes a Stable slider only at its observed parent completion %s", (observedEnd) => {
    const beatmap = buildBeatmap(
      parseBlueprint(`osu file format v14
[Difficulty]
CircleSize:4
OverallDifficulty:8.5
SliderMultiplier:2.6
SliderTickRate:1
[TimingPoints]
0,500,4,2,0,100,1,0
0,-66.6666666666667,4,2,0,100,0,0
[HitObjects]
256,192,1000,2,0,L|256:94,1,97.5
`),
      { addStacking: false },
    );
    const frames = [
      { time: 1000, position: { x: 256, y: 192 }, actions: [0] },
      { time: 1088, position: { x: 256, y: 123 }, actions: [0] },
      { time: observedEnd, position: { x: 256, y: 94.5 }, actions: [0] },
    ];
    const state = new BucketedGameStateTimeMachine(frames, beatmap, {
      hitWindowStyle: "OSU_STABLE",
      noteLockStyle: "STABLE",
    }).gameStateAt(Infinity);
    const source = { ...replay(observedEnd), frames };
    const input = buildReplayPerformanceInput({
      beatmap,
      state,
      replay: source,
      mode: "stable",
      stateIsScoringBounded: true,
    });
    expect(input.states).toHaveLength(2);
    expect(input.states[0]).toMatchObject({ time: observedEnd, maxCombo: 2, statistics: { great: 1 } });
    expect(performanceJudgements(beatmap, state, "stable").find((event) => event.sourceId === "0")).toMatchObject({
      time: observedEnd,
    });
    expect(
      buildReplayPerformanceInput({
        beatmap,
        state,
        replay: source,
        mode: "stable",
        finalReplayTime: observedEnd - 1,
        stateIsScoringBounded: true,
      }).states,
    ).toHaveLength(0);
  });

  it("keeps native Lazer completion independent of Stable parent times", () => {
    const object = slider("s", 100, 500);
    const state = Object.assign(defaultGameState(), { sliderJudgementTime: { s: 400 } });
    state.sliderVerdict.s = "GREAT";
    nativeJudgement(state, "s/head", "SLIDER_HEAD", "GREAT", 100);
    nativeJudgement(state, "s", "SLIDER_TAIL", "SLIDER_TAIL_HIT", 400);
    const input = buildReplayPerformanceInput({
      beatmap: map([object]),
      state,
      replay: replay(500, true),
      mode: "lazer",
    });
    expect(input.states[0].time).toBe(500);
  });

  it("uses the resolved Stable checkpoint time for performance progression", () => {
    const object = slider("slider");
    const tick = checkpoint(object, "tick", 200.75, "TICK");
    const state = defaultGameState();
    state.checkPointVerdict[tick.id] = { hit: true, judgementTime: 200 };
    state.judgedObjects.push(tick.id);

    expect(performanceJudgements(map([object]), state, "stable")).toEqual([
      expect.objectContaining({ sourceId: tick.id, time: 200, combo: "increment" }),
    ]);
  });

  it("caps failed source PP to authoritative objects while leaving alternate ruleset analysis independent", () => {
    const objects = [circle("first", 100), circle("second", 200), circle("third", 300)];
    const state = defaultGameState();
    for (const object of objects) {
      state.hitCircleVerdict[object.id] = {
        type: "MISS",
        missReason: "TIME_EXPIRED",
        judgementTime: object.hitTime,
      };
      state.judgedObjects.push(object.id);
      nativeJudgement(state, object.id, "CIRCLE", "MISS", object.hitTime);
    }
    const source = replay(1_000);
    source.statistics = {
      count300: 0,
      count100: 0,
      count50: 0,
      countMiss: 1,
      maxCombo: 0,
      score: 0,
      perfectCombo: false,
    };
    const beatmap = map(objects);

    const stable = buildReplayPerformanceInput({
      beatmap,
      state,
      replay: source,
      mode: "stable",
      finalReplayTime: 450,
    });
    expect(stable.states).toHaveLength(2);
    expect(stable.states[1]).toMatchObject({ time: 450, passedObjects: 1, statistics: { miss: 1 }, isFinal: true });
    expect(stable.finalReplayTime).toBe(450);

    const alternative = buildReplayPerformanceInput({ beatmap, state, replay: source, mode: "lazer" });
    expect(alternative.states[alternative.states.length - 1]).toMatchObject({ passedObjects: 3 });
  });

  it("holds a late judgement until it is resolved, without using viewer or mod speed as map time", () => {
    const object = circle("circle", 1000);
    const state = defaultGameState();
    state.hitCircleVerdict[object.id] = { type: "OK", judgementTime: 1080 };
    state.judgedObjects.push(object.id);
    const source = replay(1200);
    source.lazerMods = [
      { acronym: "DT", settings: { speed_change: 1.2 } },
      { acronym: "DA", settings: { circle_size: 6 } },
    ];
    const result = buildReplayPerformanceInput({ beatmap: map([object]), state, replay: source, mode: "stable" });
    expect(result.states[0]).toMatchObject({ time: 1080, passedObjects: 1, maxCombo: 1, statistics: { ok: 1 } });
    expect(result.mods).toEqual(source.lazerMods);
    expect(result.finalReplayTime).toBe(1200);
    expect(result.states[1]).toMatchObject({ time: 1200, isFinal: true });
  });

  it("projects overlapping object results in original gameplay order, including earlier combo resets", () => {
    const long = slider("long");
    const middle = circle("middle", 200);
    const last = circle("last", 300);
    const tick = checkpoint(long, "long/tick", 250, "TICK");
    const state = defaultGameState();
    state.sliderVerdict[long.id] = "GREAT";
    state.hitCircleVerdict[middle.id] = { type: "MISS", missReason: "TIME_EXPIRED", judgementTime: 200 };
    state.hitCircleVerdict[last.id] = { type: "GREAT", judgementTime: 300 };
    nativeJudgement(state, long.head.id, "SLIDER_HEAD", "GREAT", 100);
    nativeJudgement(state, middle.id, "CIRCLE", "MISS", 200);
    nativeJudgement(state, tick.id, "SLIDER_TICK", "LARGE_TICK_HIT", 250);
    nativeJudgement(state, last.id, "CIRCLE", "GREAT", 300);
    nativeJudgement(state, long.id, "SLIDER_TAIL", "SLIDER_TAIL_HIT", 464);
    const input = buildReplayPerformanceInput({
      beatmap: map([long, middle, last]),
      state,
      replay: replay(600, true),
      mode: "lazer",
    });
    expect(input.states.map((snapshot) => snapshot.time)).toEqual([500, 500, 500, 600]);
    expect(input.states.map((snapshot) => snapshot.maxCombo)).toEqual([3, 2, 3, 3]);
    expect(input.states[2].statistics).toMatchObject({ great: 2, miss: 1, large_tick_hit: 1, slider_tail_hit: 1 });
  });

  it("never adds a later circle or unfinished slider head to a failed replay's complete prefix", () => {
    const first = circle("first", 50);
    const unfinished = slider("unfinished");
    const later = circle("later", 200);
    const state = defaultGameState();
    state.hitCircleVerdict[first.id] = { type: "GREAT", judgementTime: 50 };
    state.hitCircleVerdict[unfinished.head.id] = { type: "GREAT", judgementTime: 100 };
    state.hitCircleVerdict[later.id] = { type: "GREAT", judgementTime: 200 };
    nativeJudgement(state, first.id, "CIRCLE", "GREAT", 50);
    nativeJudgement(state, unfinished.head.id, "SLIDER_HEAD", "GREAT", 100);
    nativeJudgement(state, later.id, "CIRCLE", "GREAT", 200);
    const source = replay(300, true);
    source.lazerScoreMetadata = { statistics: { great: 3 }, rank: "F" };
    const input = buildReplayPerformanceInput({
      beatmap: map([first, unfinished, later]),
      state,
      replay: source,
      mode: "lazer",
    });
    expect(input.states).toHaveLength(2);
    expect(input.states[1]).toMatchObject({ passedObjects: 1, maxCombo: 1, statistics: { great: 1 } });
    expect(input.limitations.some((message) => message.includes("completed prefix"))).toBe(true);
    expect(input.limitations).toContain(
      "The replay ends before every object is complete; PP stops at the completed prefix while SR continues through the beatmap.",
    );
  });

  it("publishes a resolved early miss even when the replay ends before the nominal object time", () => {
    const object = circle("early-miss", 1000);
    const state = defaultGameState();
    state.hitCircleVerdict[object.id] = { type: "MISS", missReason: "HIT_TOO_EARLY", judgementTime: 500 };
    state.judgedObjects.push(object.id);
    const { states } = buildReplayPerformanceInput({
      beatmap: map([object]),
      state,
      replay: replay(600),
      mode: "stable",
    });
    expect(states[0]).toMatchObject({ time: 500, passedObjects: 1, statistics: { miss: 1 }, maxCombo: 0 });
    expect(states[1]).toEqual({ ...states[0], time: 600, isFinal: true });
  });

  it("accumulates Stable parent grades and component combos without counting heads as 300s", () => {
    const object = slider("slider");
    const tick = checkpoint(object, "tick", 200, "TICK");
    const repeat = checkpoint(object, "repeat", 300, "REPEAT");
    const tail = checkpoint(object, "tail", 464, "LAST_LEGACY_TICK");
    const next = circle("next", 600);
    const spinner = Object.assign(new Spinner(), { id: "spinner", startTime: 700, duration: 100 });
    const state = defaultGameState();
    state.hitCircleVerdict[object.head.id] = { type: "MEH", judgementTime: 150 };
    state.checkPointVerdict[tick.id] = { hit: false };
    state.checkPointVerdict[repeat.id] = { hit: true };
    state.checkPointVerdict[tail.id] = { hit: false };
    state.sliderVerdict[object.id] = "OK";
    state.hitCircleVerdict[next.id] = { type: "MEH", judgementTime: 650 };
    state.spinnerVerdict[spinner.id] = { type: "GREAT", judgementTime: 800 };
    state.judgedObjects.push(object.head.id, tick.id, repeat.id, tail.id, object.id, next.id, spinner.id);
    const beatmap = map([object, next, spinner]);
    const input = buildReplayPerformanceInput({ beatmap, state, replay: replay(), mode: "stable" });
    expect(input.states[0]).toMatchObject({ maxCombo: 1, statistics: { great: 0, ok: 1, meh: 0, miss: 0 } });
    expect(input.states[2]).toMatchObject({ maxCombo: 3, statistics: { great: 1, ok: 1, meh: 1 } });
    const scoreInputs = performanceJudgements(beatmap, state, "stable");
    expect(scoreInputs.map((event) => event.baseScore)).toEqual([30, 0, 30, 0, 100, 50, 300]);
    expect(scoreInputs.at(-1)?.unsupportedSpinner).toBe(true);
  });

  it("keeps native tail misses separate from basic misses and combo breaks", () => {
    const object = slider("slider");
    const next = circle("next", 600);
    const state = defaultGameState();
    state.sliderVerdict[object.id] = "GREAT";
    state.hitCircleVerdict[next.id] = { type: "GREAT", judgementTime: 600 };
    nativeJudgement(state, object.head.id, "SLIDER_HEAD", "MEH", 150);
    nativeJudgement(state, object.id, "SLIDER_TAIL", "IGNORE_MISS", 464);
    nativeJudgement(state, next.id, "CIRCLE", "GREAT", 600);
    const input = buildReplayPerformanceInput({
      beatmap: map([object, next]),
      state,
      replay: replay(1000, true),
      mode: "lazer",
    });
    expect(input.states[1]).toMatchObject({
      maxCombo: 2,
      statistics: { great: 1, meh: 1, miss: 0, slider_tail_miss: 1 },
    });
  });

  it.each([
    [[], 2548],
    [["HIDDEN"], 2550],
  ] as const)("retains reconstructed spinner spin points with mods %j", (mods, expectedScore) => {
    const first = circle("first", 100);
    const second = circle("second", 200);
    const spinner = Object.assign(new Spinner(), { id: "spinner", startTime: 700, duration: 100 });
    const state = defaultGameState();
    state.hitCircleVerdict.first = { type: "GREAT", judgementTime: 100 };
    state.hitCircleVerdict.second = { type: "GREAT", judgementTime: 200 };
    state.spinnerState.set(spinner.id, {
      totalSpunAngle: 1980,
      currentAngle: 0,
      stableScoredHalfTurns: 11,
      stableRequiredHalfTurns: 6,
    });
    state.spinnerVerdict[spinner.id] = { type: "GREAT", judgementTime: 800 };
    state.judgedObjects.push(first.id, second.id, spinner.id);
    const source = replay();
    source.mods = [...mods];
    const input = buildReplayPerformanceInput({
      beatmap: map([first, second, spinner]),
      state,
      replay: source,
      mode: "stable",
    });

    // Five ordinary even half-turns earn 500; half-turn 11 earns another
    // 1100. These raw points receive neither the mod nor combo multiplier.
    expect(input.states[2].legacyScoreByDifficultyMultiplier?.[4]).toBe(expectedScore);
    expect(input.states[2]).toMatchObject({ maxCombo: 3, statistics: { great: 3 } });
    expect(input.states[3]).toEqual({ ...input.states[2], time: 1000, isFinal: true });
    expect(input.limitations).toEqual([]);
  });

  it("keeps Spun Out spinner score unavailable while its rotation model is unsupported", () => {
    const spinner = Object.assign(new Spinner(), { id: "spinner", startTime: 700, duration: 100 });
    const beatmap = new Beatmap(
      [spinner],
      DEFAULT_BEATMAP_DIFFICULTY,
      ["SPUN_OUT"],
      Beatmap.EMPTY_BEATMAP.controlPointInfo,
    );
    const state = defaultGameState();
    state.spinnerState.set(spinner.id, {
      totalSpunAngle: 0,
      currentAngle: 0,
      stableScoredHalfTurns: 0,
      stableRequiredHalfTurns: 6,
    });
    state.spinnerVerdict[spinner.id] = { type: "MISS", judgementTime: 800 };
    state.judgedObjects.push(spinner.id);
    const source = replay();
    source.mods = ["SPUN_OUT"];
    const input = buildReplayPerformanceInput({ beatmap, state, replay: source, mode: "stable" });

    expect(performanceJudgements(beatmap, state, "stable")[0]).toMatchObject({ unsupportedSpinner: true });
    expect(input.states[0].legacyScoreByDifficultyMultiplier).toBeUndefined();
    expect(input.limitations.some((message) => message.includes("spinner bonus data is unavailable"))).toBe(true);
  });

  it.each([
    ["head", false, true, true, "OK"],
    ["tick", true, false, true, "OK"],
    ["tail", true, true, false, "OK"],
    ["whole slider", false, false, false, "MISS"],
  ] as const)(
    "retains standard PP statistics for a %s error without injecting penalties",
    (_kind, headHit, tickHit, tailHit, grade) => {
      const object = slider("slider");
      const tick = checkpoint(object, "tick", 200, "TICK");
      const tail = checkpoint(object, "tail", 464, "LAST_LEGACY_TICK");
      const next = circle("next", 600);
      const state = defaultGameState();
      state.hitCircleVerdict[object.head.id] = headHit
        ? { type: "GREAT", judgementTime: 100 }
        : { type: "MISS", missReason: "TIME_EXPIRED", judgementTime: 150 };
      state.checkPointVerdict[tick.id] = { hit: tickHit };
      state.checkPointVerdict[tail.id] = { hit: tailHit };
      state.sliderVerdict[object.id] = grade;
      state.hitCircleVerdict[next.id] = { type: "MISS", missReason: "TIME_EXPIRED", judgementTime: 650 };
      state.judgedObjects.push(object.head.id, tick.id, tail.id, object.id, next.id);
      const input = buildReplayPerformanceInput({
        beatmap: map([object, next]),
        state,
        replay: replay(),
        mode: "stable",
      });

      expect(input.states.every((snapshot) => !("knownComboBreaks" in snapshot))).toBe(true);
      expect(input.states[0].statistics).toMatchObject({ ok: grade === "OK" ? 1 : 0, miss: grade === "MISS" ? 1 : 0 });
    },
  );

  it("accumulates Classic head/tick/tail and parent statistics independently", () => {
    const object = slider("slider");
    const tick = checkpoint(object, "tick", 250, "TICK");
    const state = defaultGameState();
    state.sliderVerdict[object.id] = "MEH";
    nativeJudgement(state, object.head.id, "SLIDER_HEAD", "LARGE_TICK_HIT", 150);
    nativeJudgement(state, tick.id, "SLIDER_TICK", "LARGE_TICK_MISS", 250);
    nativeJudgement(state, object.id, "SLIDER_TAIL", "SMALL_TICK_MISS", 464);
    nativeJudgement(state, object.id, "SLIDER", "MEH", 500);
    const source = replay(1000, true);
    source.lazerMods = [{ acronym: "CL" }];
    const input = buildReplayPerformanceInput({
      beatmap: map([object], source.lazerMods),
      state,
      replay: source,
      mode: "lazer-classic",
    });
    expect(input.states[0]).toMatchObject({
      maxCombo: 1,
      statistics: { meh: 1, large_tick_hit: 1, large_tick_miss: 1, small_tick_miss: 1, slider_tail_miss: 0 },
    });
    expect(input.mods).toEqual([{ acronym: "CL" }]);
    expect(buildReplayPerformanceInput({ beatmap: map([object]), state, replay: source, mode: "stable" }).mods).toEqual(
      [],
    );
  });

  it("retains reconstructed counts and score inputs at the recorded end even when source totals differ", () => {
    const object = circle("circle", 100);
    const state = defaultGameState();
    state.hitCircleVerdict[object.id] = { type: "GREAT", judgementTime: 100 };
    state.judgedObjects.push(object.id);
    nativeJudgement(state, object.id, "CIRCLE", "GREAT", 100);
    const source = replay(1000);
    source.statistics = {
      count300: 0,
      count100: 1,
      count50: 0,
      countMiss: 0,
      maxCombo: 1,
      score: 100,
      perfectCombo: true,
    };
    const beatmap = map([object]);
    const input = buildReplayPerformanceInput({ beatmap, state, replay: source, mode: "stable" });
    expect(input.states[0]).toMatchObject({ time: 100, statistics: { great: 1, ok: 0 } });
    expect(input.states[0].legacyTotalScore).toBeUndefined();
    expect(input.states[1]).toMatchObject({
      time: 1000,
      statistics: { great: 1, ok: 0 },
      isFinal: true,
    });
    expect(input.states[1].legacyTotalScore).toBeUndefined();
    expect(input.states[1]).toEqual({ ...input.states[0], time: 1000, isFinal: true });
    expect(input.states[1].legacyScoreByDifficultyMultiplier).toEqual(
      input.states[0].legacyScoreByDifficultyMultiplier,
    );
    const alternative = buildReplayPerformanceInput({ beatmap, state, replay: source, mode: "lazer" });
    expect(alternative.states[1].statistics.great).toBe(1);
    expect(alternative.states[1].legacyTotalScore).toBeUndefined();
  });

  it("retains reconstructed native nested results when source statistics disagree", () => {
    const object = slider("slider");
    const state = defaultGameState();
    state.sliderVerdict[object.id] = "GREAT";
    nativeJudgement(state, object.head.id, "SLIDER_HEAD", "GREAT", 100);
    nativeJudgement(state, object.id, "SLIDER_TAIL", "SLIDER_TAIL_HIT", 464);
    const source = replay(1000, true);
    source.lazerScoreMetadata = { statistics: { ok: 1 }, maximumStatistics: { great: 1, slider_tail_hit: 1 } };
    const input = buildReplayPerformanceInput({ beatmap: map([object]), state, replay: source, mode: "lazer" });
    expect(input.states[0].statistics).toMatchObject({ great: 1, slider_tail_hit: 1 });
    expect(input.states[1].statistics).toMatchObject({ great: 1, ok: 0, slider_tail_hit: 1, slider_tail_miss: 0 });
  });

  it("never imports future native tail misses or partial-object combo from a failed score header", () => {
    const finished = slider("finished");
    const unfinished = slider("unfinished", 600, 1200);
    const state = defaultGameState();
    state.sliderVerdict[finished.id] = "GREAT";
    nativeJudgement(state, finished.head.id, "SLIDER_HEAD", "LARGE_TICK_HIT", 100);
    nativeJudgement(state, finished.id, "SLIDER_TAIL", "SMALL_TICK_HIT", 464);
    nativeJudgement(state, finished.id, "SLIDER", "GREAT", 500);
    nativeJudgement(state, unfinished.head.id, "SLIDER_HEAD", "LARGE_TICK_HIT", 600);
    const source = replay(700, true);
    source.lazerMods = [{ acronym: "CL" }];
    source.statistics = {
      count300: 1,
      count100: 0,
      count50: 0,
      countMiss: 0,
      maxCombo: 3,
      score: 1000,
      perfectCombo: false,
    };
    source.lazerScoreMetadata = {
      statistics: { great: 1, large_tick_hit: 2, small_tick_hit: 1 },
      maximumStatistics: { great: 10, large_tick_hit: 20, small_tick_hit: 10, slider_tail_hit: 10 },
      rank: "F",
    };
    const input = buildReplayPerformanceInput({
      beatmap: map([finished, unfinished]),
      state,
      replay: source,
      mode: "lazer-classic",
    });
    expect(input.states[input.states.length - 1]).toMatchObject({
      passedObjects: 1,
      maxCombo: 2,
      statistics: { great: 1, large_tick_hit: 1, small_tick_hit: 1, slider_tail_miss: 0 },
    });
  });

  it("normalizes inherited NC/PF bits without removing custom native settings", () => {
    const source = replay();
    source.mods = ["DOUBLE_TIME", "NIGHT_CORE", "SUDDEN_DEATH", "PERFECT"];
    const result = buildReplayPerformanceInput({
      beatmap: map([]),
      state: defaultGameState(),
      replay: source,
      mode: "stable",
    });
    expect(result.mods).toEqual([{ acronym: "NC" }, { acronym: "PF" }]);
  });

  it.each([
    ["RELAX", "RX"],
    ["AUTO_PILOT", "AP"],
    ["AUTO_PLAY", "AT"],
  ] as const)("preserves unranked %s with the replay's other mods for performance calculation", (mod, acronym) => {
    const source = replay();
    source.mods = [mod, "HIDDEN", "DOUBLE_TIME"];
    const result = buildReplayPerformanceInput({
      beatmap: map([]),
      state: defaultGameState(),
      replay: source,
      mode: "stable",
    });

    expect(result.mods).toEqual([{ acronym }, { acronym: "HD" }, { acronym: "DT" }]);
  });

  it.each([
    [[], 960, 1100],
    [["HARD_ROCK"], 963, 1105],
  ] as const)(
    "reconstructs Relax PP score inputs using the remaining mods %j",
    (otherMods, thirdScore, fourthScore) => {
      const objects = [circle("one", 100), circle("two", 200), circle("three", 300), circle("four", 400)];
      const state = defaultGameState();
      objects.forEach((object, index) => {
        state.hitCircleVerdict[object.id] = { type: index === 3 ? "OK" : "GREAT", judgementTime: object.hitTime };
        state.judgedObjects.push(object.id);
      });
      const source = replay();
      source.mods = ["RELAX", ...otherMods];
      const input = buildReplayPerformanceInput({ beatmap: map(objects), state, replay: source, mode: "stable" });

      // At multiplier 5, the third great earns 300 + floor(12 * 5 * mod),
      // and the fourth ok earns 100 + floor(2 * 4 * 5 * mod).
      expect(input.states[2].legacyScoreByDifficultyMultiplier?.[5]).toBe(thirdScore);
      expect(input.states[3].legacyScoreByDifficultyMultiplier?.[5]).toBe(fourthScore);
      expect(input.states[3]).toMatchObject({ maxCombo: 4, statistics: { great: 3, ok: 1 } });
      expect(input.mods).toContainEqual({ acronym: "RX" });
      expect(input.limitations).toEqual([]);
    },
  );

  it.each(["RX", "AP", "AT"])("retains native %s alongside custom rate and difficulty settings", (acronym) => {
    const source = replay(1000, true);
    source.lazerMods = [
      { acronym },
      { acronym: "DT", settings: { speed_change: 1.2 } },
      { acronym: "DA", settings: { approach_rate: 9, circle_size: 6 } },
    ];
    const result = buildReplayPerformanceInput({
      beatmap: map([]),
      state: defaultGameState(),
      replay: source,
      mode: "stable",
    });

    expect(result.mods).toEqual(source.lazerMods);
  });
});

describe("the state of a full combo", () => {
  const statistics = { great: 90, ok: 8, meh: 1, miss: 3, large_tick_hit: 40, large_tick_miss: 2, small_tick_hit: 5, small_tick_miss: 1, slider_tail_hit: 30, slider_tail_miss: 4 };
  const final = { time: 90_000, passedObjects: 102, maxCombo: 77, statistics, isFinal: true, legacyTotalScore: 1_234_567, legacyScoreByDifficultyMultiplier: [1, 2, 3] };

  it("counts every miss as hit and keeps the 100s and 50s, at the combo of the whole map", () => {
    expect(fullComboPerformanceState(final, 180)).toEqual({
      time: 90_000,
      passedObjects: 102,
      maxCombo: 180,
      isFinal: true,
      statistics: { great: 93, ok: 8, meh: 1, miss: 0, large_tick_hit: 42, large_tick_miss: 0, small_tick_hit: 6, small_tick_miss: 0, slider_tail_hit: 34, slider_tail_miss: 0 },
    });
  });

  it("carries no score of the real play: a full combo would have another one", () => {
    const state = fullComboPerformanceState(final, 180);
    expect("legacyTotalScore" in state).toBe(false);
    expect("legacyScoreByDifficultyMultiplier" in state).toBe(false);
  });

  it("counts the combo of a perfect play from the judgements: what adds to it, and what would have if hit", () => {
    const event = (combo: "increment" | "reset" | "none", result?: string) => ({ sourceId: "x", objectIndex: 0, time: 0, combo, ...(result ? { result } : {}) }) as never;
    // Stable: circles and slider parts count; a slider's own result does not; a missed last tick would have.
    const stable = [event("increment", "great"), event("reset", "miss"), event("increment"), event("reset"), event("none"), event("none", "ok")];
    expect(fullComboMaxCombo(stable, "stable")).toBe(5);
    // Lazer: small ticks never count; a missed slider tail would have.
    const lazer = [event("increment", "great"), event("reset", "large_tick_miss"), event("none", "small_tick_hit"), event("none", "small_tick_miss"), event("none", "slider_tail_miss"), event("increment", "slider_tail_hit")];
    expect(fullComboMaxCombo(lazer, "lazer")).toBe(4);
  });
});
