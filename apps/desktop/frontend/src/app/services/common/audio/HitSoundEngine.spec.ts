import {
  Beatmap,
  DEFAULT_BEATMAP_DIFFICULTY,
  HitCircle,
  HitObjectJudgement,
  HitSampleInfo,
  PathType,
  ReplayAnalysisEvent,
  Slider,
  SliderCheckPoint,
  SliderPath,
  Spinner,
  SpinnerState,
} from "@osujs/core";
import { BehaviorSubject, Subject } from "rxjs";
import { buildHitSoundCues, buildStoryboardPlaybackStateResolver } from "./hit-sound-cues";
import { HitSoundEngine, usesBeatmapSampleOverride } from "./HitSoundEngine";
import { GameplayClock } from "../game/GameplayClock";
import { readFileSync } from "fs";
import { resolve } from "path";

const sample = (name: string) => new HitSampleInfo(name, "normal", null, 80);

function circle(id: string, time: number): HitCircle {
  const result = new HitCircle();
  result.id = id;
  result.hitTime = time;
  result.samples = [sample("hitnormal")];
  return result;
}

function slider(id: string, time: number): Slider {
  const head = circle(`${id}/HEAD`, time);
  head.sliderId = id;
  const result = new Slider(head);
  result.id = id;
  result.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }], 100);
  result.velocity = 1;
  result.nodeSamples = [[sample("hitnormal")], [sample("hitclap")]];

  const tick = new SliderCheckPoint(result);
  tick.id = `${id}/tick`;
  tick.type = "TICK";
  tick.hitTime = time + 50;
  tick.samples = [sample("slidertick")];
  const tail = new SliderCheckPoint(result);
  tail.id = `${id}/tail`;
  tail.type = "LAST_LEGACY_TICK";
  tail.hitTime = time + 64;
  tail.samples = [sample("hitclap")];
  result.checkPoints = [tick, tail];
  return result;
}

function map(objects: Beatmap["hitObjects"]): Beatmap {
  return new Beatmap(objects, { ...DEFAULT_BEATMAP_DIFFICULTY }, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
}

describe("buildHitSoundCues", () => {
  it("uses successful Stable object/checkpoint evidence and moves the legacy tail sound to slider end", () => {
    const hitCircle = circle("circle", 100);
    const slide = slider("slider", 200);
    const spinner = new Spinner();
    spinner.id = "spinner";
    spinner.startTime = 400;
    spinner.duration = 100;
    spinner.samples = [sample("hitfinish")];
    const events: ReplayAnalysisEvent[] = [
      {
        type: "HitObjectJudgement",
        eventId: "stable:circle",
        ruleset: "stable",
        time: 103,
        judgementTime: 103,
        objectTime: 100,
        position: { x: 0, y: 0 },
        hitObjectId: "circle",
        verdict: "GREAT",
      },
      {
        type: "HitObjectJudgement",
        eventId: "stable:head",
        ruleset: "stable",
        time: 201,
        judgementTime: 201,
        objectTime: 200,
        position: { x: 0, y: 0 },
        hitObjectId: "slider/HEAD",
        verdict: "OK",
        isSliderHead: true,
      },
      {
        type: "CheckpointJudgement",
        eventId: "stable:tick",
        ruleset: "stable",
        time: 250,
        objectTime: 250,
        judgementTime: 250,
        position: { x: 50, y: 0 },
        checkpointId: "slider/tick",
        sliderId: "slider",
        checkpointType: "TICK",
        hit: true,
      },
      {
        type: "CheckpointJudgement",
        eventId: "stable:tail",
        ruleset: "stable",
        time: 264,
        objectTime: 264,
        judgementTime: 264,
        position: { x: 100, y: 0 },
        checkpointId: "slider/tail",
        sliderId: "slider",
        checkpointType: "LAST_LEGACY_TICK",
        hit: true,
      },
      {
        type: "HitObjectJudgement",
        eventId: "stable:spinner",
        ruleset: "stable",
        time: 500,
        judgementTime: 500,
        objectTime: 500,
        position: { x: 256, y: 192 },
        hitObjectId: "spinner",
        verdict: "GREAT",
      },
    ];

    expect(
      buildHitSoundCues(map([hitCircle, slide, spinner]), events).map((cue) => [cue.time, cue.samples[0].name]),
    ).toEqual([
      [103, "hitnormal"],
      [201, "hitnormal"],
      [250, "slidertick"],
      [300, "hitclap"],
      [500, "hitfinish"],
    ]);
  });

  it("keeps misses silent and emits a lazer tail only from a successful native SliderEnd judgement", () => {
    const slide = slider("slider", 200);
    const events: ReplayAnalysisEvent[] = [
      {
        type: "HitObjectJudgement",
        eventId: "lazer:head",
        ruleset: "lazer",
        time: 200,
        judgementTime: 200,
        objectTime: 200,
        position: { x: 0, y: 0 },
        hitObjectId: "slider/HEAD",
        verdict: "GREAT",
        isSliderHead: true,
      },
      {
        type: "SliderEndJudgement",
        eventId: "lazer:tail",
        ruleset: "lazer",
        time: 300,
        objectTime: 300,
        judgementTime: 300,
        position: { x: 100, y: 0 },
        sliderId: "slider",
        componentId: "slider/TAIL",
        hit: true,
      },
    ];
    expect(buildHitSoundCues(map([slide]), events).map((cue) => cue.id)).toEqual([
      "hit-object:lazer:head",
      "lazer-slider-tail:lazer:tail",
    ]);

    const missedTail: ReplayAnalysisEvent = {
      type: "SliderComponentMiss",
      eventId: "lazer:tail-miss",
      ruleset: "lazer",
      time: 300,
      objectTime: 300,
      judgementTime: 300,
      position: { x: 100, y: 0 },
      sliderId: "slider",
      componentId: "slider/TAIL",
      componentType: "TAIL",
    };
    expect(buildHitSoundCues(map([slide]), [events[0], missedTail]).map((cue) => cue.id)).toEqual([
      "hit-object:lazer:head",
    ]);
  });

  it("plays a recovered lazer tail even when the slider head missed", () => {
    const slide = slider("slider", 200);
    const events: ReplayAnalysisEvent[] = [
      {
        type: "HitObjectJudgement",
        eventId: "lazer:head-miss",
        ruleset: "lazer",
        time: 200,
        judgementTime: 200,
        objectTime: 200,
        position: { x: 0, y: 0 },
        hitObjectId: "slider/HEAD",
        verdict: "MISS",
        missReason: "TIME_EXPIRED",
        isSliderHead: true,
      },
      {
        type: "SliderEndJudgement",
        eventId: "lazer:recovered-tail",
        ruleset: "lazer",
        time: 300,
        objectTime: 300,
        judgementTime: 300,
        position: { x: 100, y: 0 },
        sliderId: "slider",
        componentId: "slider/TAIL",
        hit: true,
      },
    ];

    expect(buildHitSoundCues(map([slide]), events).map((cue) => cue.id)).toEqual([
      "lazer-slider-tail:lazer:recovered-tail",
    ]);
  });
});

describe("sample source selection", () => {
  it("uses beatmap files only for custom sample indexes", () => {
    expect(usesBeatmapSampleOverride(new HitSampleInfo("hitnormal", "normal", null, 80, null, 0))).toBe(false);
    expect(usesBeatmapSampleOverride(new HitSampleInfo("hitnormal", "normal", null, 80, null, 1))).toBe(true);
    expect(usesBeatmapSampleOverride(new HitSampleInfo("hitnormal", "normal", "4", 80, null, 4))).toBe(true);
  });
});

describe("ruleset cue refresh", () => {
  it("plays a hit at the seek target once after paused and playing seeks", async () => {
    const object = circle("seek-target", 1_000);
    const events: HitObjectJudgement[] = [
      {
        type: "HitObjectJudgement",
        eventId: object.id,
        ruleset: "stable",
        time: 1_000,
        judgementTime: 1_000,
        objectTime: 1_000,
        position: object.position,
        hitObjectId: object.id,
        verdict: "GREAT",
      },
    ];
    const clock = new GameplayClock();
    let audioTime = 0;
    clock.setDuration(3_000);
    clock.setTimeSource(() => audioTime);
    clock.seeked$.subscribe((at) => {
      audioTime = at;
    });
    const simulator = {
      getStateAt: () => ({ sliderBodyState: new Map(), spinnerState: new Map() }),
      getPrimaryReplay: () => undefined,
      replayEvents$: new BehaviorSubject(events),
    };
    const audio = { playSample: jest.fn(), stopSamples: jest.fn(), cueTime: () => audioTime };
    const engine = new HitSoundEngine(simulator as never, clock, audio as never, {} as never, {} as never, {} as never);
    const internal = engine as unknown as { loadSample(): Promise<{ buffer: AudioBuffer; volume: number }> };
    jest.spyOn(internal, "loadSample").mockResolvedValue({ buffer: {} as AudioBuffer, volume: 1 });
    engine.initialize();
    await engine.configure(map([object]), ".");
    clock.seekTo(1_000);
    engine.update(audioTime);
    expect(audio.playSample).not.toHaveBeenCalled();
    clock.start();
    engine.update(audioTime);
    engine.update(audioTime + 16);
    expect(audio.playSample).toHaveBeenCalledTimes(1);
    audioTime = 1_500;
    clock.tick();
    clock.seekTo(1_000);
    engine.update(audioTime);
    engine.update(audioTime + 16);
    expect(audio.playSample).toHaveBeenCalledTimes(2);
  });

  it("refreshes at the audio position without replaying cues behind the delayed picture or skipping pending cues", async () => {
    const circles = [circle("first", 200), circle("during-refresh", 220), circle("next", 260)];
    const beatmap = map(circles);
    const events: HitObjectJudgement[] = circles.map((object) => ({
      type: "HitObjectJudgement",
      eventId: object.id,
      ruleset: "stable",
      time: object.hitTime,
      judgementTime: object.hitTime,
      objectTime: object.hitTime,
      position: object.position,
      hitObjectId: object.id,
      verdict: "GREAT",
    }));
    const state = { sliderBodyState: new Map(), spinnerState: new Map() };
    const gameSimulator = {
      getStateAt: jest.fn(() => state),
      getCurrentState: jest.fn(() => state),
      getPrimaryReplay: () => undefined,
      replayEvents$: new BehaviorSubject(events),
    };
    const gameClock = { isPlaying: false, playbackRate: 1, timeElapsedInMs: 0, seeked$: new Subject<number>() };
    let cueTime = 0;
    const audioEngine = {
      cueTime: () => cueTime,
      playLoopingSample: jest.fn(),
      stopLoopingSample: jest.fn(),
      setLoopingSamplePlaybackRate: jest.fn(),
      playSample: jest.fn(),
      stopSamples: jest.fn(),
    };
    const engine = new HitSoundEngine(
      gameSimulator as never,
      gameClock as never,
      audioEngine as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const internal = engine as unknown as {
      loadSample(): Promise<{ buffer: AudioBuffer; volume: number }>;
      prepare(events: readonly ReplayAnalysisEvent[], preserve: boolean): Promise<void>;
    };
    jest.spyOn(internal, "loadSample").mockResolvedValue({ buffer: {} as AudioBuffer, volume: 1 });
    await engine.configure(beatmap, ".");
    gameClock.isPlaying = true;
    gameClock.timeElapsedInMs = 150;
    cueTime = 210;
    engine.update(cueTime);
    expect(audioEngine.playSample).toHaveBeenCalledTimes(1);

    const refreshing = internal.prepare(
      events.map((event) => ({ ...event, ruleset: "lazer" })),
      true,
    );
    cueTime = 230;
    await refreshing;
    expect(audioEngine.playSample).toHaveBeenCalledTimes(2);
    engine.update(270);
    expect(audioEngine.playSample).toHaveBeenCalledTimes(3);
    expect(gameSimulator.getCurrentState).not.toHaveBeenCalled();
    expect(gameSimulator.getStateAt).toHaveBeenCalledWith(230);
  });

  it("keeps currently playing hitsounds and loops alive when ruleset events change", async () => {
    const gameSimulator = {
      getStateAt: () => ({ sliderBodyState: new Map(), spinnerState: new Map() }),
      getPrimaryReplay: () => undefined,
      replayEvents$: new BehaviorSubject<ReplayAnalysisEvent[]>([]),
    };
    const gameClock = {
      isPlaying: true,
      playbackRate: 1,
      timeElapsedInMs: 250,
      seeked$: new Subject<number>(),
    };
    const audioEngine = {
      cueTime: () => gameClock.timeElapsedInMs,
      playLoopingSample: jest.fn(),
      stopLoopingSample: jest.fn(),
      setLoopingSamplePlaybackRate: jest.fn(),
      playSample: jest.fn(),
      stopSamples: jest.fn(),
    };
    const engine = new HitSoundEngine(
      gameSimulator as never,
      gameClock as never,
      audioEngine as never,
      {} as never,
      {} as never,
      {} as never,
    );
    (engine as unknown as { beatmap: Beatmap }).beatmap = map([]);

    await (
      engine as unknown as {
        prepare(events: readonly ReplayAnalysisEvent[], preservePlayback: boolean): Promise<void>;
      }
    ).prepare([], true);

    expect(audioEngine.stopSamples).not.toHaveBeenCalled();
    expect(audioEngine.stopLoopingSample).not.toHaveBeenCalled();
  });

  it("still performs a full audio reset when a map is initially prepared", async () => {
    const gameSimulator = {
      getStateAt: () => ({ sliderBodyState: new Map(), spinnerState: new Map() }),
      getPrimaryReplay: () => undefined,
      replayEvents$: new BehaviorSubject<ReplayAnalysisEvent[]>([]),
    };
    const gameClock = {
      isPlaying: true,
      playbackRate: 1,
      timeElapsedInMs: 0,
      seeked$: new Subject<number>(),
    };
    const audioEngine = {
      cueTime: () => gameClock.timeElapsedInMs,
      playLoopingSample: jest.fn(),
      stopLoopingSample: jest.fn(),
      setLoopingSamplePlaybackRate: jest.fn(),
      playSample: jest.fn(),
      stopSamples: jest.fn(),
    };
    const engine = new HitSoundEngine(
      gameSimulator as never,
      gameClock as never,
      audioEngine as never,
      {} as never,
      {} as never,
      {} as never,
    );
    (engine as unknown as { beatmap: Beatmap }).beatmap = map([]);

    await (
      engine as unknown as {
        prepare(events: readonly ReplayAnalysisEvent[], preservePlayback: boolean): Promise<void>;
      }
    ).prepare([], false);

    expect(audioEngine.stopSamples).toHaveBeenCalledTimes(1);
  });
});

describe("slider tracking loops", () => {
  it("starts mapped loops once while tracking and stops them when tracking ends", () => {
    let currentState = { sliderBodyState: new Map([["slider", { isTracking: true }]]) };
    const gameSimulator = {
      getStateAt: () => currentState,
      getCurrentState: jest.fn(() => ({ sliderBodyState: new Map([["slider", { isTracking: false }]]) })),
      replayEvents$: new BehaviorSubject<ReplayAnalysisEvent[]>([]),
    };
    const gameClock = {
      isPlaying: true,
      playbackRate: 1,
      timeElapsedInMs: 0,
      seeked$: new Subject<number>(),
    };
    const audioEngine = {
      cueTime: () => gameClock.timeElapsedInMs,
      playLoopingSample: jest.fn(),
      stopLoopingSample: jest.fn(),
      setLoopingSamplePlaybackRate: jest.fn(),
      playSample: jest.fn(),
      stopSamples: jest.fn(),
    };
    const engine = new HitSoundEngine(
      gameSimulator as never,
      gameClock as never,
      audioEngine as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const prepared = { buffer: {} as AudioBuffer, volume: 0.65 };
    (engine as unknown as { sliderLoops: Map<string, unknown[]> }).sliderLoops.set("slider", [prepared]);

    engine.update(10);
    engine.update(20);
    expect(audioEngine.playLoopingSample).toHaveBeenCalledTimes(1);
    expect(audioEngine.playLoopingSample).toHaveBeenCalledWith("slider-loop:slider:0", prepared.buffer, 0.65, 1);

    currentState = { sliderBodyState: new Map([["slider", { isTracking: false }]]) };
    engine.update(30);
    expect(audioEngine.stopLoopingSample).toHaveBeenCalledWith("slider-loop:slider:0");
    expect(gameSimulator.getCurrentState).not.toHaveBeenCalled();
  });

  it("schedules the replay-appropriate storyboard layers with mapped files and volume", () => {
    const beatmap = new Beatmap(
      [],
      { ...DEFAULT_BEATMAP_DIFFICULTY },
      [],
      Beatmap.EMPTY_BEATMAP.controlPointInfo,
      false,
      [
        { time: 100, layer: 0, filename: "background.wav", volume: 70 },
        { time: 110, layer: 1, filename: "fail.wav", volume: 80 },
        { time: 120, layer: 2, filename: "pass.wav", volume: 90 },
        { time: 130, layer: 3, filename: "foreground.ogg", volume: 100 },
      ],
    );

    const pass = buildHitSoundCues(beatmap, [], "pass").map((cue) => cue.samples[0]);
    expect(pass.map((sample) => sample.customFilename)).toEqual(["background.wav", "pass.wav", "foreground.ogg"]);
    expect(pass.map((sample) => sample.volume)).toEqual([70, 90, 100]);

    const fail = buildHitSoundCues(beatmap, [], "fail").map((cue) => cue.samples[0].customFilename);
    expect(fail).toEqual(["background.wav", "fail.wav", "foreground.ogg"]);
  });

  it("switches conditional storyboard samples after each completed combo set", () => {
    const perfect = circle("perfect", 100);
    perfect.comboSetIndex = 0;
    const imperfect = circle("imperfect", 200);
    imperfect.comboSetIndex = 1;
    const beatmap = new Beatmap(
      [perfect, imperfect],
      { ...DEFAULT_BEATMAP_DIFFICULTY },
      [],
      Beatmap.EMPTY_BEATMAP.controlPointInfo,
      false,
      [
        { time: 150, layer: 1, filename: "first-fail.wav", volume: 100 },
        { time: 150, layer: 2, filename: "first-pass.wav", volume: 100 },
        { time: 250, layer: 1, filename: "second-fail.wav", volume: 100 },
        { time: 250, layer: 2, filename: "second-pass.wav", volume: 100 },
      ],
    );
    const events: ReplayAnalysisEvent[] = [
      {
        type: "HitObjectJudgement",
        eventId: "perfect",
        ruleset: "stable",
        time: 100,
        judgementTime: 100,
        objectTime: 100,
        position: perfect.position,
        hitObjectId: perfect.id,
        verdict: "GREAT",
      },
      {
        type: "HitObjectJudgement",
        eventId: "imperfect",
        ruleset: "stable",
        time: 200,
        judgementTime: 200,
        objectTime: 200,
        position: imperfect.position,
        hitObjectId: imperfect.id,
        verdict: "OK",
      },
    ];
    const stateAt = buildStoryboardPlaybackStateResolver(beatmap, events);

    expect(stateAt(150)).toBe("pass");
    expect(stateAt(250)).toBe("fail");
    expect(buildHitSoundCues(beatmap, events, stateAt).map((cue) => cue.samples[0].customFilename)).toEqual([
      null,
      "first-pass.wav",
      null,
      "second-fail.wav",
    ]);
  });

  it("uses recorded replay health for conditional samples during breaks", () => {
    const beatmap = new Beatmap(
      [],
      { ...DEFAULT_BEATMAP_DIFFICULTY },
      [],
      Beatmap.EMPTY_BEATMAP.controlPointInfo,
      false,
      [
        { time: 250, layer: 1, filename: "break-fail.wav", volume: 100 },
        { time: 250, layer: 2, filename: "break-pass.wav", volume: 100 },
      ],
      [{ startTime: 200, endTime: 300 }],
    );
    const stateAt = buildStoryboardPlaybackStateResolver(beatmap, [], [{ time: 190, health: 0.4 }]);

    expect(stateAt(250)).toBe("fail");
    expect(buildHitSoundCues(beatmap, [], stateAt).map((cue) => cue.samples[0].customFilename)).toEqual([
      "break-fail.wav",
    ]);
  });
});

describe("spinner tracking loop", () => {
  function setup(ruleset: "stable" | "lazer" = "stable", spinnerFrequencyModulate = true) {
    const spinner = new Spinner();
    spinner.id = "spinner";
    spinner.startTime = 0;
    spinner.duration = 1000;
    spinner.spinsRequired = 1;
    const beatmap = map([spinner]);
    let currentState: { sliderBodyState: Map<string, unknown>; spinnerState: Map<string, SpinnerState> } = {
      sliderBodyState: new Map(),
      spinnerState: new Map([["spinner", { tracking: true, currentAngle: 0, totalSpunAngle: 0, completedSpins: 0 }]]),
    };
    const gameSimulator = {
      getStateAt: () => currentState,
      getRulesetFocus: () => ruleset,
      replayEvents$: new BehaviorSubject<ReplayAnalysisEvent[]>([]),
    };
    const gameClock = {
      isPlaying: true,
      playbackRate: 2,
      timeElapsedInMs: 0,
      seeked$: new Subject<number>(),
    };
    const audioEngine = {
      cueTime: () => gameClock.timeElapsedInMs,
      playLoopingSample: jest.fn(),
      stopLoopingSample: jest.fn(),
      setLoopingSamplePlaybackRate: jest.fn(),
      playSample: jest.fn(),
      stopSamples: jest.fn(),
    };
    const engine = new HitSoundEngine(
      gameSimulator as never,
      gameClock as never,
      audioEngine as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const prepared = { buffer: {} as AudioBuffer, volume: 0.8 };
    const bonus = { buffer: {} as AudioBuffer, volume: 0.7 };
    Object.assign(engine, {
      skinHolder: { getSkin: () => ({ config: { general: { spinnerFrequencyModulate } } }) },
    });
    engine.initialize();
    (engine as unknown as { beatmap: Beatmap }).beatmap = beatmap;
    (engine as unknown as { spinnerLoops: Map<string, unknown> }).spinnerLoops.set("spinner", prepared);
    (engine as unknown as { spinnerBonusSamples: Map<string, unknown> }).spinnerBonusSamples.set("spinner", bonus);

    return {
      engine,
      audioEngine,
      gameClock,
      prepared,
      bonus,
      setRuleset: (next: "stable" | "lazer") => {
        ruleset = next;
      },
      rotate: (angle: number, stableHalfTurns?: number, stableRequiredHalfTurns?: number) => {
        currentState = {
          sliderBodyState: new Map(),
          spinnerState: new Map([
            [
              "spinner",
              {
                tracking: true,
                currentAngle: 0,
                totalSpunAngle: angle,
                completedSpins: Math.floor(angle / 360),
                stableHalfTurns,
                stableRequiredHalfTurns,
              },
            ],
          ]),
        };
      },
    };
  }

  it("starts only after observed rotation and follows osu!'s progress-based frequency curve", () => {
    const { engine, audioEngine, prepared, rotate } = setup();

    engine.update(10);
    expect(audioEngine.playLoopingSample).not.toHaveBeenCalled();

    rotate(90);
    engine.update(20);
    const expectedFrequency = 20_000 / 44_100 + 0.25 * (40_000 / 44_100);
    expect(audioEngine.playLoopingSample).toHaveBeenCalledWith(
      "spinner-loop:spinner",
      prepared.buffer,
      0.8,
      expectedFrequency,
      300,
    );

    engine.update(300);
    expect(audioEngine.stopLoopingSample).toHaveBeenCalledWith("spinner-loop:spinner", 240);
  });

  it("uses Stable's half-turn requirement for spinner pitch", () => {
    const { engine, audioEngine, prepared, rotate } = setup();
    engine.update(10);
    rotate(360, 2, 5);
    engine.update(20);
    expect(audioEngine.playLoopingSample).toHaveBeenCalledWith(
      "spinner-loop:spinner",
      prepared.buffer,
      0.8,
      expect.any(Number),
      300,
    );
    expect(audioEngine.playLoopingSample.mock.calls[0][3]).toBeCloseTo(20_000 / 44_100 + 0.4 * (40_000 / 44_100));
  });

  it("respects skins that disable spinner frequency modulation", () => {
    const { engine, audioEngine, prepared, rotate } = setup("stable", false);
    engine.update(10);
    rotate(90);
    engine.update(20);
    expect(audioEngine.playLoopingSample).toHaveBeenCalledWith("spinner-loop:spinner", prepared.buffer, 0.8, 1, 300);
    rotate(180);
    engine.update(30);
    expect(audioEngine.setLoopingSamplePlaybackRate).toHaveBeenCalledWith("spinner-loop:spinner", 1);
  });

  it.each(["stable", "lazer"] as const)(
    "plays %s bonus sounds on earned spins, including after the score cap",
    (ruleset) => {
      const { engine, audioEngine, bonus, rotate } = setup(ruleset);
      engine.update(10);
      rotate(1080);
      engine.update(20);
      expect(audioEngine.playSample).not.toHaveBeenCalled();

      rotate(1440);
      engine.update(30);
      expect(audioEngine.playSample).toHaveBeenCalledTimes(1);
      expect(audioEngine.playSample).toHaveBeenCalledWith(bonus.buffer, 0.7, 1);

      engine.update(40);
      expect(audioEngine.playSample).toHaveBeenCalledTimes(1);

      rotate(2160);
      engine.update(50);
      expect(audioEngine.playSample).toHaveBeenCalledTimes(3);
    },
  );

  it("does not replay past bonuses when the ruleset changes at the same playback time", () => {
    const { engine, audioEngine, rotate, setRuleset } = setup();
    engine.update(10);
    rotate(1440);
    engine.update(20);
    expect(audioEngine.playSample).toHaveBeenCalledTimes(1);
    audioEngine.playSample.mockClear();

    setRuleset("lazer");
    rotate(1800);
    engine.update(20);
    expect(audioEngine.playSample).not.toHaveBeenCalled();

    rotate(2160);
    engine.update(30);
    expect(audioEngine.playSample).toHaveBeenCalledTimes(1);
  });

  it("stops on pause and does not replay earlier bonuses after seeking", () => {
    const { engine, audioEngine, gameClock, rotate } = setup();
    engine.update(10);
    rotate(90);
    engine.update(20);
    gameClock.isPlaying = false;
    gameClock.timeElapsedInMs = 20;
    engine.update(20);
    expect(audioEngine.stopLoopingSample).toHaveBeenCalledWith("spinner-loop:spinner");

    gameClock.seeked$.next(500);
    rotate(1440);
    gameClock.isPlaying = true;
    engine.update(500);
    expect(audioEngine.playSample).not.toHaveBeenCalled();
    rotate(1800);
    engine.update(510);
    expect(audioEngine.playSample).toHaveBeenCalledTimes(1);
  });

  it("fades the loop out at the spinner end while keeping its final bonus sound", () => {
    const { engine, audioEngine, rotate, gameClock } = setup();
    gameClock.seeked$.next(980);
    rotate(1080);
    engine.update(980);
    rotate(1200);
    engine.update(990);
    expect(audioEngine.playLoopingSample).toHaveBeenCalledTimes(1);

    rotate(1440);
    engine.update(1000);
    expect(audioEngine.stopLoopingSample).toHaveBeenCalledWith("spinner-loop:spinner", 240);
    expect(audioEngine.playSample).toHaveBeenCalledTimes(1);
  });

  it("bundles audible spinner samples for Rewind's default skin", () => {
    for (const name of ["spinnerspin", "spinnerbonus"]) {
      const bytes = readFileSync(
        resolve(__dirname, "../../../../../../../../resources/Skins/RewindDefaultSkin", `${name}.wav`),
      );
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
      expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
      let data = Buffer.alloc(0);
      for (let offset = 12; offset + 8 <= bytes.length; ) {
        const size = bytes.readUInt32LE(offset + 4);
        if (bytes.toString("ascii", offset, offset + 4) === "data") {
          data = bytes.subarray(offset + 8, offset + 8 + size);
          break;
        }
        offset += 8 + size + (size % 2);
      }
      expect(data.length).toBeGreaterThan(0);
      expect(data.some((byte) => byte !== 0)).toBe(true);
    }
  });
});
