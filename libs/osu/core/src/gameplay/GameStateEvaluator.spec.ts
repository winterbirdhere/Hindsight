import { GameStateEvaluator, newPressingSince, stableNumericalInputBoundary } from "./GameStateEvaluator";
import { cloneGameState, defaultGameState, NOT_PRESSING, GameState } from "./GameState";
import { OsuAction, ReplayFrame } from "../replays/Replay";
import { buildBeatmap } from "../beatmap/BeatmapBuilder";
import { parseBlueprint } from "../blueprint/BlueprintParser";
import { Slider } from "../hitobjects/Slider";
import { BucketedGameStateTimeMachine } from "./GameStateTimeMachine";
import { traceMapText } from "../../test/ReplayTraceFixtures";

it.each([
  {objects:"300,192,1000,1,0",want:601},
  {objects:"100,192,1000,2,0,L|300:192,1,200",want:601},
  {objects:"256,192,400,8,0,1400\n300,192,1000,1,0",want:400},
])("uses the actual Stable MISS/event boundary, not spawn or successful hit windows: $want",({objects,want})=>{
  const map=buildBeatmap(parseBlueprint(traceMapText(objects)),{mods:[],addStacking:false});
  expect(stableNumericalInputBoundary(map)).toBe(want);
});
it.each(["DOUBLE_TIME","HALF_TIME","HARD_ROCK"] as const)("does not apply another clock conversion to the Stable input boundary: %s",mod=>{
  const map=buildBeatmap(parseBlueprint(traceMapText("100,192,1000,1,0")),{mods:[mod],addStacking:false});
  expect(stableNumericalInputBoundary(map)).toBe(601);
});
it.each([Infinity,-1])("refuses unsupported head timing rather than certifying a prefix: %s",approachDuration=>{
  const map=buildBeatmap(parseBlueprint(traceMapText("100,192,1000,1,0")),{mods:[],addStacking:false});
  Object.assign(map.hitObjects[0],{approachDuration});expect(stableNumericalInputBoundary(map)).toBeUndefined();
});
const numericState=(s:GameState)=>({hitCircleVerdict:s.hitCircleVerdict,checkPointVerdict:s.checkPointVerdict,sliderTailVerdict:s.sliderTailVerdict,
  sliderVerdict:s.sliderVerdict,sliderJudgementTime:s.sliderJudgementTime,spinnerVerdict:s.spinnerVerdict,judgedObjects:s.judgedObjects,
  sliderBodyState:s.sliderBodyState,spinnerState:s.spinnerState,stableNotelockEvidence:s.stableNotelockEvidence});
it.each(["300,192,1000,1,0","100,192,1000,2,0,L|300:192,1,200","256,192,1000,8,0,2000"])(
  "released input before the numerical boundary removes unknown holds/history without changing later scoring: %s",objects=>{
    const map=buildBeatmap(parseBlueprint(traceMapText(objects)),{mods:[],addStacking:false});
    const frames:ReplayFrame[]=[{time:100,position:{x:100,y:192},actions:[OsuAction.leftButton],rawButtonMask:5},
      {time:500,position:{x:100,y:192},actions:[],rawButtonMask:0},
      {time:1000,position:{x:100,y:192},actions:[OsuAction.rightButton],rawButtonMask:10},
      {time:1250,position:{x:150,y:192},actions:[OsuAction.rightButton],rawButtonMask:2},
      {time:1500,position:{x:200,y:192},actions:[OsuAction.leftButton,OsuAction.rightButton],rawButtonMask:15},
      {time:1750,position:{x:250,y:192},actions:[OsuAction.leftButton],rawButtonMask:1},
      {time:2100,position:{x:300,y:192},actions:[],rawButtonMask:0}];
    const reference=defaultGameState(),engine=new GameStateEvaluator(map),snapshots:GameState[]=[];
    for(const frame of frames){engine.evaluate(reference,frame);snapshots.push(cloneGameState(reference));}
    expect(snapshots[1].judgedObjects).toEqual([]);expect(snapshots[1].sliderBodyState.size).toBe(0);expect(snapshots[1].spinnerState.size).toBe(0);
    for(let held=0;held<4;held++)for(let previous=0;previous<4;previous++)for(let older=0;older<4;older++){
      const state=defaultGameState(),alternate=new GameStateEvaluator(map);state.pressingSince=[held&1?-500:NOT_PRESSING,held&2?-500:NOT_PRESSING];
      state.stablePreviousButtons=previous;state.stablePreviousPreviousButtons=older;
      frames.forEach((frame,i)=>{alternate.evaluate(state,frame);if(i>=1)expect(numericState(state)).toEqual(numericState(snapshots[i]));});
      expect(state).toEqual(reference);
    }
  });
it("a release cannot erase a MISS/slider-head latch or a started spinner",()=>{
  for(const objects of ["100,192,1000,1,0","100,192,1000,2,0,L|300:192,1,200"]){
    const map=buildBeatmap(parseBlueprint(traceMapText(objects)),{mods:[],addStacking:false}),state=defaultGameState(),engine=new GameStateEvaluator(map);
    engine.evaluate(state,{time:601,position:{x:100,y:192},actions:[0],rawButtonMask:5});
    expect(Object.values(state.hitCircleVerdict)[0]).toMatchObject({type:"MISS",missReason:"HIT_TOO_EARLY"});
    engine.evaluate(state,{time:650,position:{x:100,y:192},actions:[],rawButtonMask:0});
    expect(state.judgedObjects.length).toBeGreaterThan(0);
  }
  const spinner=buildBeatmap(parseBlueprint(traceMapText("256,192,1000,8,0,2000")),{mods:[],addStacking:false}),state=defaultGameState(),engine=new GameStateEvaluator(spinner);
  engine.evaluate(state,{time:1000,position:{x:300,y:192},actions:[0],rawButtonMask:5});
  engine.evaluate(state,{time:1100,position:{x:256,y:250},actions:[],rawButtonMask:0});
  expect(state.spinnerState.size).toBe(1);expect(stableNumericalInputBoundary(spinner)).toBe(1000);
});

function sliderTrackingFixture(relax = false) {
  const beatmap = buildBeatmap(
    parseBlueprint(
      [
        "osu file format v14",
        "[Difficulty]",
        "CircleSize:4",
        "OverallDifficulty:5",
        "ApproachRate:5",
        "SliderMultiplier:1",
        "SliderTickRate:1",
        "[TimingPoints]",
        "0,250,4,1,0,100,1,0",
        "[HitObjects]",
        "100,192,1000,2,0,L|500:192,1,400",
      ].join("\n"),
    ),
    { addStacking: false, mods: relax ? ["RELAX"] : [] },
  );
  const slider = beatmap.hitObjects[0] as Slider;
  const frame = (time: number, actions: OsuAction[], radiusOffset = 0): ReplayFrame => {
    const ball = slider.ballPositionAt((time - slider.startTime) / slider.duration);
    return { time, position: { x: ball.x, y: ball.y + slider.radius * radiusOffset }, actions };
  };
  const machine = (frames: ReplayFrame[]) =>
    new BucketedGameStateTimeMachine(frames, beatmap, { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" });
  return { slider, frame, machine };
}

describe.each([
  ["left", OsuAction.leftButton, OsuAction.rightButton],
  ["right", OsuAction.rightButton, OsuAction.leftButton],
] as const)("Stable slider tracking with the %s button held before the head", (_label, oldButton, headButton) => {
  it("drops tracking when the head button is released while the earlier hold remains", () => {
    const { slider, frame, machine } = sliderTrackingFixture();
    const replay = machine([
      frame(800, [oldButton], 4),
      frame(1_000, [oldButton, headButton]),
      frame(1_050, [oldButton]),
    ]);

    const headState = replay.gameStateAt(1_000);
    expect(headState.hitCircleVerdict[slider.head.id]).toMatchObject({ type: "GREAT", judgementTime: 1_000 });
    expect(headState.sliderBodyState.get(slider.id)?.isTracking).toBe(true);
    expect(replay.gameStateAt(1_050).sliderBodyState.get(slider.id)?.isTracking).toBe(false);
  });

  it("requires returning inside one radius to recapture after releasing the head button", () => {
    const { slider, frame, machine } = sliderTrackingFixture();
    const [firstTick, secondTick] = slider.checkPoints;
    const replay = machine([
      frame(800, [oldButton], 4),
      frame(1_000, [oldButton, headButton]),
      frame(1_050, [oldButton]),
      frame(1_100, [oldButton], 1.5),
      frame(1_150, [oldButton, headButton], 1.5),
      frame(firstTick.hitTime, [oldButton, headButton], 1.5),
      frame(1_300, [oldButton, headButton], 0.5),
      frame(secondTick.hitTime, [oldButton, headButton], 1.5),
    ]);

    // A fresh press in the expanded follow area cannot restore lost tracking.
    expect(replay.gameStateAt(firstTick.hitTime).checkPointVerdict[firstTick.id]).toMatchObject({ hit: false });
    expect(replay.gameStateAt(1_300).sliderBodyState.get(slider.id)?.isTracking).toBe(true);
    expect(replay.gameStateAt(secondTick.hitTime).checkPointVerdict[secondTick.id]).toMatchObject({ hit: true });
    // Seeking back must preserve the failed checkpoint, even after recapture.
    expect(replay.gameStateAt(firstTick.hitTime).checkPointVerdict[firstTick.id]).toMatchObject({ hit: false });
  });

  it("keeps tracking with the held head button after releasing the earlier hold", () => {
    const { slider, frame, machine } = sliderTrackingFixture();
    const firstTick = slider.checkPoints[0];
    const replay = machine([
      frame(800, [oldButton], 4),
      frame(1_000, [oldButton, headButton]),
      frame(1_050, [headButton], 1.5),
      frame(firstTick.hitTime, [headButton], 1.5),
    ]);

    expect(replay.gameStateAt(1_050).sliderBodyState.get(slider.id)?.isTracking).toBe(true);
    expect(replay.gameStateAt(firstTick.hitTime).checkPointVerdict[firstTick.id]).toMatchObject({ hit: true });
  });

  it("accepts a replacement button pressed after the head and still held", () => {
    const { slider, frame, machine } = sliderTrackingFixture();
    const firstTick = slider.checkPoints[0];
    const replay = machine([
      frame(800, [oldButton], 4),
      frame(1_000, [oldButton, headButton]),
      frame(1_010, [headButton]),
      frame(1_020, [oldButton, headButton]),
      frame(1_050, [oldButton], 1.5),
      frame(firstTick.hitTime, [oldButton], 1.5),
    ]);

    expect(replay.gameStateAt(1_050).sliderBodyState.get(slider.id)?.isTracking).toBe(true);
    expect(replay.gameStateAt(firstTick.hitTime).checkPointVerdict[firstTick.id]).toMatchObject({ hit: true });
  });
});

describe("Stable Relax slider tracking", () => {
  it("tracks an automatically hit head and expanded follow area without held buttons", () => {
    const { slider, frame, machine } = sliderTrackingFixture(true);
    const firstTick = slider.checkPoints[0];
    const replay = machine([
      frame(800, [], 4),
      frame(1_000, []),
      frame(1_050, [], 1.5),
      frame(firstTick.hitTime, [], 1.5),
    ]);

    expect(replay.gameStateAt(1_000).hitCircleVerdict[slider.head.id]).toMatchObject({
      type: "GREAT",
      judgementTime: 1_000,
    });
    expect(replay.gameStateAt(1_050).sliderBodyState.get(slider.id)?.isTracking).toBe(true);
    expect(replay.gameStateAt(firstTick.hitTime).checkPointVerdict[firstTick.id]).toMatchObject({ hit: true });
  });
});

describe("newPressingSince", function () {
  it("initial with new value at new click", function () {
    expect(newPressingSince([NOT_PRESSING, NOT_PRESSING], [OsuAction.leftButton], 10)).toEqual([10, NOT_PRESSING]);
  });
  it("keep the old value if still pressing", function () {
    expect(newPressingSince([30, NOT_PRESSING], [OsuAction.leftButton], 42)).toEqual([30, NOT_PRESSING]);
  });
  it("stay [NOT_PRESSING, NOT_PRESSING] when no action given", function () {
    expect(newPressingSince([NOT_PRESSING, NOT_PRESSING], [], -420)).toEqual([NOT_PRESSING, NOT_PRESSING]);
  });
  it("return to [NOT_PRESSING, NOT_PRESSING] when no action given", function () {
    expect(newPressingSince([320, 500], [], 600)).toEqual([NOT_PRESSING, NOT_PRESSING]);
  });
});
