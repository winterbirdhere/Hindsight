import { BehaviorSubject, Subject } from "rxjs";
import { AudioEngine } from "./AudioEngine";
import { DEFAULT_AUDIO_SETTINGS } from "./settings";
import { GameplayClock } from "../game/GameplayClock";
import { ViewerLifecycleObserver } from "../ViewerLifecycleObserver";

function fakeGain() {
  return {
    gain: {
      value: 1,
      cancelScheduledValues: jest.fn(),
      setValueAtTime: jest.fn(function (this: { value: number }, value: number) {
        this.value = value;
      }),
      linearRampToValueAtTime: jest.fn(function (this: { value: number }, value: number) {
        this.value = value;
      }),
      setValueCurveAtTime: jest.fn(function (this: { value: number }, values: Float32Array) {
        this.value = values[values.length - 1];
      }),
    },
    connect: jest.fn(),
    disconnect: jest.fn(),
  };
}

function fakeSource() {
  return {
    buffer: null,
    loop: false,
    playbackRate: { value: 1 },
    connect: jest.fn(),
    disconnect: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    onended: null,
  };
}

describe("AudioEngine song transport", () => {
  afterEach(() => jest.restoreAllMocks());

  function createTransport() {
    let now = 0;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    const sources: { mediaElement: HTMLAudioElement; connect: jest.Mock; disconnect: jest.Mock }[] = [];
    const context = {
      destination: {},
      currentTime: 0,
      baseLatency: 0,
      outputLatency: 0,
      getOutputTimestamp: undefined as (() => AudioTimestamp) | undefined,
      createGain: fakeGain,
      createMediaStreamDestination: jest.fn(() => ({
        stream: { getTracks: () => [{ stop: jest.fn() }] },
      })),
      createMediaElementSource: (mediaElement: HTMLAudioElement) => {
        const source = { mediaElement, connect: jest.fn(), disconnect: jest.fn() };
        sources.push(source);
        return source;
      },
      resume: jest.fn(),
    };
    const clock = new GameplayClock();
    clock.setDuration(300000);
    const settings$ = new BehaviorSubject(DEFAULT_AUDIO_SETTINGS);
    const engine = new AudioEngine({ settings$ } as never, context as never, clock);
    engine.postConstruct();
    return { clock, engine, sources, context, settings$, advanceWallClock: (ms: number) => (now += ms) };
  }

  function createSong() {
    const events = new EventTarget();
    const song = {
      currentTime: 0,
      duration: 300,
      playbackRate: 1,
      paused: true,
      ended: false,
      readyState: 4,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      play: jest.fn(() => {
        song.paused = false;
        return Promise.resolve();
      }),
      pause: jest.fn(() => {
        song.paused = true;
      }),
    };
    return song;
  }

  it("journals actual song source replacement and distinguishes empty destroy", () => {
    const { engine, sources } = createTransport(), events: string[] = [];
    Object.assign(engine, { lifecycle: new ViewerLifecycleObserver({ id: () => 1,
      record: kind => events.push(kind), count: () => undefined, invalidate: () => undefined }) });
    engine.destroy();
    const first = createSong(), second = createSong();
    engine.setSong(first as never);
    engine.setSong(second as never);
    expect(sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(engine.song?.mediaElement).toBe(second);
    engine.destroy(); engine.destroy();
    expect(events.filter(kind => kind === "audio-source-created")).toHaveLength(2);
    expect(events.filter(kind => kind === "audio-source-released")).toHaveLength(2);
    expect(events.filter(kind => kind === "audio-destroy-attempt")).toHaveLength(5);
  });

  it("presents emitted music while keeping cues upstream and resumes from the frozen display position", () => {
    const { clock, engine, context, advanceWallClock } = createTransport();
    const song = createSong();
    context.baseLatency = 0.02;
    context.outputLatency = 0.04;
    let outputStamp = { contextTime: 0, performanceTime: 0 };
    context.getOutputTimestamp = () => outputStamp;
    engine.setSong(song as unknown as HTMLAudioElement);
    clock.start();
    expect(clock.tick()).toBe(0);

    context.currentTime = 1;
    song.currentTime = 1;
    advanceWallClock(1000);
    outputStamp = { contextTime: 0.94, performanceTime: 1000 };
    expect(clock.tick()).toBeCloseTo(940, 6);
    expect(engine.cueTime()).toBe(1000);

    const seeks: number[] = [];
    clock.seeked$.subscribe((time) => seeks.push(time));
    clock.pause();
    expect(song.paused).toBe(true);
    expect(song.currentTime).toBeCloseTo(0.94, 6);
    expect(seeks).toEqual([940]);
    expect(engine.cueTime()).toBe(940);

    clock.start();
    expect(clock.tick()).toBe(940);
    context.currentTime = 1.1;
    song.currentTime = 1.04;
    advanceWallClock(100);
    outputStamp = { contextTime: 1.04, performanceTime: 1100 };
    expect(clock.tick()).toBeCloseTo(980, 6);
    expect(engine.cueTime()).toBe(1040);

    clock.seekTo(200000);
    expect(clock.tick()).toBe(200000);
    expect(engine.cueTime()).toBe(200000);
  });

  it("records the existing mix against graph time and restores physical output latency afterward", () => {
    const { clock, engine, context, advanceWallClock } = createTransport();
    const song = createSong();
    context.baseLatency = 0.02;
    context.outputLatency = 0.04;
    engine.setSong(song as unknown as HTMLAudioElement);
    const capture = engine.beginCapture(true);
    const destination = context.createMediaStreamDestination.mock.results[0].value;
    expect(engine.masterGain.connect).toHaveBeenCalledWith(destination);
    expect(capture.stream).toBe(destination.stream);
    clock.start();
    clock.tick();
    context.currentTime = 1;
    song.currentTime = 1;
    advanceWallClock(1000);
    expect(clock.tick()).toBeCloseTo(1000, 6);
    clock.pause();
    capture.dispose();
    capture.dispose();
    expect(engine.masterGain.disconnect).toHaveBeenCalledTimes(1);
    expect(engine.masterGain.disconnect).toHaveBeenCalledWith(destination);
    clock.start();
    clock.tick();
    context.currentTime = 2;
    song.currentTime = 2;
    advanceWallClock(1000);
    expect(clock.tick()).toBeCloseTo(1940, 6);
  });

  it("freezes the selected mix during capture and applies later settings only after release", () => {
    const { engine, settings$ } = createTransport();
    const capture = engine.beginCapture(false);
    settings$.next({ muted: true, volume: { master: 0.8, music: 0.2, effects: 0.7 } });
    expect(engine.masterGain.gain.value).toBe(DEFAULT_AUDIO_SETTINGS.volume.master);
    expect(engine.musicGain.gain.value).toBe(DEFAULT_AUDIO_SETTINGS.volume.music);
    expect(engine.samplesGain.gain.value).toBe(DEFAULT_AUDIO_SETTINGS.volume.effects);
    capture.dispose();
    expect(engine.masterGain.gain.value).toBe(0);
    expect(engine.musicGain.gain.value).toBe(0.2);
    expect(engine.samplesGain.gain.value).toBe(0.7);
  });

  it("waits for seek completion before capture and cancels a pending seek", async () => {
    const { engine, context } = createTransport();
    const song = { ...createSong(), seeking: true };
    engine.setSong(song as unknown as HTMLAudioElement);
    const controller = new AbortController();
    let ready = false;
    const preparing = engine.prepareCapture(controller.signal).then(() => {
      ready = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.resume).toHaveBeenCalled();
    expect(ready).toBe(false);
    song.seeking = false;
    song.dispatchEvent(new Event("seeked"));
    await preparing;
    expect(ready).toBe(true);
    song.seeking = true;
    const cancelled = engine.prepareCapture(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
  });

  it("cancels preparation even when the audio device never finishes resuming", async () => {
    const { engine, context } = createTransport();
    context.resume.mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const preparing = engine.prepareCapture(controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(preparing).rejects.toThrow("cancelled");
  });

  it("lets the final output samples drain before completing playback", () => {
    const { clock, engine, context, advanceWallClock } = createTransport();
    const song = createSong();
    song.duration = 1;
    clock.setDuration(1000);
    context.baseLatency = 0.02;
    context.outputLatency = 0.04;
    engine.setSong(song as unknown as HTMLAudioElement);
    clock.start();
    clock.tick();
    context.currentTime = 1;
    song.currentTime = 1;
    advanceWallClock(1000);
    song.ended = true;
    song.dispatchEvent(new Event("ended"));
    expect(clock.isPlaying).toBe(true);
    expect(clock.tick()).toBeCloseTo(940, 6);
    context.currentTime = 1.1;
    advanceWallClock(100);
    expect(clock.tick()).toBe(1000);
    expect(clock.isPlaying).toBe(false);
    expect(song.currentTime).toBe(1);
  });

  it("drains queued output during buffering and resumes without extrapolating through the stall", () => {
    const { clock, engine, context, advanceWallClock } = createTransport();
    const song = createSong();
    context.baseLatency = 0.02;
    context.outputLatency = 0.04;
    engine.setSong(song as unknown as HTMLAudioElement);
    clock.start();
    clock.tick();
    context.currentTime = 1;
    song.currentTime = 1;
    advanceWallClock(1000);
    expect(clock.tick()).toBeCloseTo(940, 6);

    song.readyState = 2;
    context.currentTime = 1.02;
    advanceWallClock(20);
    expect(clock.tick()).toBeCloseTo(960, 6);
    context.currentTime = 1.2;
    advanceWallClock(180);
    expect(clock.tick()).toBe(1000);
    expect(clock.isPlaying).toBe(true);

    song.readyState = 4;
    song.currentTime = 1.1;
    context.currentTime = 1.3;
    advanceWallClock(100);
    expect(clock.tick()).toBeCloseTo(1040, 6);
  });

  it("keeps gameplay on the song through startup, delayed frames, seeks, speed changes and pauses", () => {
    const { clock, engine, advanceWallClock } = createTransport();
    const song = createSong();
    engine.setSong(song as unknown as HTMLAudioElement);
    clock.isPlaying$.subscribe((playing) => {
      if (playing) advanceWallClock(120);
    });

    clock.start();
    expect(song.play).toHaveBeenCalledTimes(1);
    // The media play request has not advanced the song yet.
    expect(clock.tick()).toBe(0);
    song.currentTime = 0.5;
    advanceWallClock(600);
    expect(clock.tick()).toBe(500);
    song.currentTime = 200;
    advanceWallClock(200000);
    expect(clock.tick()).toBe(200000);

    clock.seekTo(30000);
    expect(song.currentTime).toBe(30);
    advanceWallClock(250);
    expect(clock.tick()).toBe(30000);
    song.currentTime = 30.1;
    expect(clock.tick()).toBe(30100);

    clock.setBaseRate(1.5);
    clock.setSpeed(0.5);
    expect(song.playbackRate).toBe(0.75);
    song.currentTime = 30.85;
    advanceWallClock(1000);
    expect(clock.tick()).toBe(30850);
    clock.pause();
    expect(song.paused).toBe(true);
    advanceWallClock(2000);
    expect(clock.tick()).toBe(30850);

    clock.seekTo(60000);
    expect(song.currentTime).toBe(60);
    clock.start();
    expect(song.play).toHaveBeenCalledTimes(2);
    expect(clock.tick()).toBe(60000);
    song.currentTime = 60.075;
    advanceWallClock(100);
    expect(clock.tick()).toBe(60075);
  });

  it("preserves position and rate when replacing a song and restores standalone timing on destroy", () => {
    const { clock, engine, sources, advanceWallClock } = createTransport();
    const first = createSong();
    engine.setSong(first as unknown as HTMLAudioElement);
    clock.setBaseRate(1.5);
    clock.start();
    first.currentTime = 12.5;
    const second = createSong();
    engine.setSong(second as unknown as HTMLAudioElement);

    expect(first.paused).toBe(true);
    expect(sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(second.currentTime).toBe(12.5);
    expect(second.playbackRate).toBe(1.5);
    expect(second.play).toHaveBeenCalledTimes(1);
    first.dispatchEvent(new Event("ended"));
    first.duration = 1;
    first.dispatchEvent(new Event("durationchange"));
    expect(clock.isPlaying).toBe(true);
    expect(clock.durationInMs).toBe(300000);
    second.currentTime = 13;
    expect(clock.tick()).toBe(13000);
    second.currentTime = 14;
    engine.destroy();
    expect(second.paused).toBe(true);
    expect(sources[1].disconnect).toHaveBeenCalledTimes(1);
    advanceWallClock(100);
    expect(clock.tick()).toBe(14150);
  });

  it("stops at the media endpoint and seeks the song back to zero on replay", () => {
    const { clock, engine } = createTransport();
    const song = createSong();
    engine.setSong(song as unknown as HTMLAudioElement);
    clock.start();
    song.currentTime = song.duration;
    expect(clock.tick()).toBe(300000);
    expect(clock.isPlaying).toBe(false);
    expect(song.paused).toBe(true);
    clock.start();
    expect(song.currentTime).toBe(0);
    expect(clock.tick()).toBe(0);
  });

  it("tracks revised media duration and stops if playback ends before the stored duration", () => {
    const { clock, engine } = createTransport();
    const song = createSong();
    engine.setSong(song as unknown as HTMLAudioElement);
    song.duration = 10;
    song.dispatchEvent(new Event("durationchange"));
    expect(clock.durationInMs).toBe(10000);
    clock.start();
    song.currentTime = 9.8;
    song.dispatchEvent(new Event("ended"));
    expect(clock.isPlaying).toBe(false);
    expect(clock.tick()).toBe(9800);
    song.duration = 9.8;
    song.dispatchEvent(new Event("durationchange"));
    expect(clock.durationInMs).toBe(9800);
  });

  it("continues through silence after the final music samples without shortening the analysis", () => {
    const { clock, engine, context, advanceWallClock } = createTransport();
    const song = createSong();
    song.duration = 1;
    clock.setAnalysisEnd(2000);
    clock.setDuration(1000);
    context.baseLatency = 0.02;
    context.outputLatency = 0.04;
    engine.setSong(song as unknown as HTMLAudioElement);
    clock.start();
    clock.tick();
    context.currentTime = 1;
    song.currentTime = 1;
    advanceWallClock(1000);
    song.ended = true;
    song.dispatchEvent(new Event("ended"));
    song.dispatchEvent(new Event("durationchange"));
    expect(clock.durationInMs).toBe(2000);
    expect(clock.tick()).toBeCloseTo(940, 6);
    context.currentTime = 1.1;
    advanceWallClock(100);
    expect(clock.tick()).toBeCloseTo(1040, 6);
    expect(engine.cueTime()).toBeCloseTo(1100, 6);
    expect(clock.isPlaying).toBe(true);
    context.currentTime = 2.1;
    advanceWallClock(1000);
    expect(clock.tick()).toBe(2000);
    expect(clock.isPlaying).toBe(false);
  });

  it("can pause, resume, change speed, and seek back from a silent tail", () => {
    const { clock, engine, context } = createTransport();
    const song = createSong();
    song.duration = 1;
    clock.setAnalysisEnd(5000);
    clock.setDuration(1000);
    engine.setSong(song as unknown as HTMLAudioElement);
    clock.seekTo(2000);
    clock.start();
    expect(song.play).not.toHaveBeenCalled();
    expect(clock.tick()).toBe(2000);
    context.currentTime = 0.5;
    expect(clock.tick()).toBe(2500);
    clock.setSpeed(0.5);
    context.currentTime = 1;
    expect(clock.tick()).toBe(2750);
    clock.pause();
    context.currentTime = 3;
    expect(clock.tick()).toBe(2750);
    clock.start();
    expect(clock.tick()).toBe(2750);
    context.currentTime = 3.5;
    expect(clock.tick()).toBe(3000);
    clock.seekTo(500);
    expect(song.currentTime).toBe(0.5);
    expect(song.play).toHaveBeenCalledTimes(1);
    expect(clock.tick()).toBe(500);
  });
});

describe("AudioEngine samples", () => {
  it("deduplicates named loops, updates their requested rate, and stops cleanly", () => {
    const sources: ReturnType<typeof fakeSource>[] = [];
    const gains: ReturnType<typeof fakeGain>[] = [];
    const settings$ = new BehaviorSubject(DEFAULT_AUDIO_SETTINGS);
    const playbackRate$ = new BehaviorSubject(1);
    const context = {
      destination: {},
      currentTime: 5,
      createGain: jest.fn(() => {
        const gain = fakeGain();
        gains.push(gain);
        return gain;
      }),
      createBufferSource: jest.fn(() => {
        const source = fakeSource();
        sources.push(source);
        return source;
      }),
      createMediaElementSource: jest.fn(),
      decodeAudioData: jest.fn(),
      resume: jest.fn(),
    };
    const gameClock = {
      seeked$: new Subject<number>(),
      isPlaying$: new Subject<boolean>(),
      playbackRate$,
    };
    const engine = new AudioEngine({ settings$ } as never, context as never, gameClock as never);
    engine.postConstruct();

    const buffer = {} as AudioBuffer;
    engine.playLoopingSample("slider:1", buffer, 0.65, 1);
    engine.playLoopingSample("slider:1", buffer, 0.65, 1);

    expect(sources).toHaveLength(1);
    expect(sources[0].loop).toBe(true);
    expect(sources[0].start).toHaveBeenCalledTimes(1);
    expect(gains[gains.length - 1].gain.value).toBe(0.65);

    playbackRate$.next(1.5);
    expect(sources[0].playbackRate.value).toBe(1);
    engine.setLoopingSamplePlaybackRate("slider:1", 1.5);
    expect(sources[0].playbackRate.value).toBe(1.5);

    engine.stopLoopingSample("slider:1");
    expect(sources[0].stop).toHaveBeenCalledTimes(1);
    expect(sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(gains[gains.length - 1].disconnect).toHaveBeenCalledTimes(1);
  });

  it("fades named loops in and schedules a clean fade-out", () => {
    const sources: ReturnType<typeof fakeSource>[] = [];
    const gains: ReturnType<typeof fakeGain>[] = [];
    const context = {
      destination: {},
      currentTime: 10,
      createGain: jest.fn(() => {
        const gain = fakeGain();
        gains.push(gain);
        return gain;
      }),
      createBufferSource: jest.fn(() => {
        const source = fakeSource();
        sources.push(source);
        return source;
      }),
      createMediaElementSource: jest.fn(),
      decodeAudioData: jest.fn(),
      resume: jest.fn(),
    };
    const gameClock = {
      seeked$: new Subject<number>(),
      isPlaying$: new Subject<boolean>(),
      playbackRate$: new BehaviorSubject(1),
    };
    const engine = new AudioEngine(
      { settings$: new BehaviorSubject(DEFAULT_AUDIO_SETTINGS) } as never,
      context as never,
      gameClock as never,
    );

    engine.playLoopingSample("spinner:1", {} as AudioBuffer, 0.8, 1.25, 300);

    const sampleGain = gains[gains.length - 1].gain;
    expect(sampleGain.setValueAtTime).toHaveBeenCalledWith(0, 10);
    expect(sampleGain.setValueCurveAtTime).toHaveBeenCalledWith(expect.any(Float32Array), 10, 0.3);
    expect(sampleGain.value).toBeCloseTo(0.8);

    engine.stopLoopingSample("spinner:1", 240);
    expect(sampleGain.cancelScheduledValues).toHaveBeenCalledWith(10);
    expect(sampleGain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 10.24);
    expect(sources[0].stop).toHaveBeenCalledWith(10.24);

    // The fading source no longer blocks a newly-started spinner loop.
    engine.playLoopingSample("spinner:1", {} as AudioBuffer, 0.8, 1.25, 300);
    expect(sources).toHaveLength(2);
  });
});
