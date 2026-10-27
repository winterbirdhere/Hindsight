import { readFile, readdir } from "fs/promises";
import { join, resolve } from "path";
import { fileURLToPath, pathToFileURL, URL as NodeURL } from "url";
import { BehaviorSubject, Subject } from "rxjs";
import { createHash } from "crypto";
import { std_diff } from "ojsama";
import { ScenarioManager } from "./ScenarioManager";
import { GameSimulator } from "../common/game/GameSimulator";
import type { BeatmapLookupResult } from "../../../../../shared/beatmap-lookup";
import type { ReplayLoadState } from "./replay-load-state";
import * as audioServiceModule from "../common/audio/AudioService";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION } from "../../../../../shared/library-analysis";
import type { LibraryCurrentReplayReceipt } from "../../../../../shared/library-current-replay";
import type { CurrentReplayCaptureContext } from "../library/library-current-replay";
import { ViewerLifecycleObserver } from "../common/ViewerLifecycleObserver";
import { LibraryCurrentReplayPublisher, currentReplayBinding } from "../library/library-current-replay-publisher";
import type { LibraryCurrentReplayRequest } from "../../../../../shared/library-current-replay";
import type { CurrentReplayProjectedNumericalSnapshot } from "../library/library-current-replay";

it("observes superseded and rejected load attempts before public loading, without changing rejection or cleanup", async () => {
  const f = scenarioFixture(), held = deferred(), rejected = new Error("export owns playback");
  const events: Array<{ kind: string; fields: Readonly<Record<string, unknown>> }> = [];
  const lifecycle = new ViewerLifecycleObserver({ id: () => 1,
    record: (kind, _owner, fields) => events.push({ kind, fields }), count: () => undefined, invalidate: () => undefined });
  Object.assign(f.manager, { lifecycle });
  let calls = 0;
  f.manager.setBeforeReplayChange(() => ++calls === 1 ? held.promise : Promise.reject(rejected));
  const first = f.manager.loadReplay(f.replayId);
  await expect(f.manager.loadReplay(f.replayId)).rejects.toBe(rejected);
  held.resolve(); await first;
  expect(f.manager.loadState$.value.phase).toBe("idle");
  expect(f.audioEngine.destroy).not.toHaveBeenCalled();
  expect(events.filter(event => event.kind === "scenario-load-attempt").map(event => event.fields.sequence)).toEqual([1, 2]);
  expect(events.filter(event => event.kind === "scenario-load-settled")).toHaveLength(2);
  expect(events.some(event => event.kind === "scenario-reset-attempt")).toBe(false);
  expect(JSON.stringify(events)).not.toContain(f.replayId);
});

it("keeps each reset completion paired with its entry sequence across delayed resource retirement", async () => {
  const settle = async (ready: () => boolean) => {
    for (let step = 0; step < 30 && !ready(); step++) await Promise.resolve();
    expect(ready()).toBe(true);
  };
  const f = libraryFixture(), retirement = deferred();
  await f.manager.loadLibraryReplay("canonical");
  f.resource.close.mockImplementation(async () => { await retirement.promise; return undefined; });
  const events: Array<{ kind: string; fields: Readonly<Record<string, unknown>> }> = [];
  Object.assign(f.manager, { lifecycle: new ViewerLifecycleObserver({ id: () => 1,
    record: (kind, _owner, fields) => events.push({ kind, fields }), count: () => undefined, invalidate: () => undefined }) });
  const first = f.manager.loadReplay(f.replayId);
  await settle(() => f.resource.close.mock.calls.length === 1);
  const second = f.manager.loadReplay(f.replayId);
  await settle(() => events.filter(event => event.kind === "scenario-reset-attempt").length === 2);
  retirement.resolve(); await Promise.all([first,second]);
  expect(events.filter(event => event.kind === "scenario-reset-attempt").map(event => event.fields.sequence)).toEqual([2,3]);
  expect(events.filter(event => event.kind === "scenario-reset-completed").map(event => event.fields.sequence)).toEqual([2,3]);
  expect(f.resource.close).toHaveBeenCalledTimes(1);
  expect(f.manager.loadState$.value.phase).toBe("ready");
});

it("passes the digest of the accepted map bytes to optional explanation capture", async () => {
  const fixture = scenarioFixture();
  await fixture.manager.loadReplay(fixture.replayId);
  expect(fixture.simulator.simulateReplay.mock.calls[0][2]).toMatchObject({
    beatmapContentSha256: createHash("sha256").update(Buffer.from(fixture.rawBlueprint)).digest("hex"),
    beatmapMd5: createHash("md5").update(Buffer.from(fixture.rawBlueprint)).digest("hex"),
    preparationIdentity: "BeatmapBuilder:addStacking=true",
  });
});

it("invalidates the explanation sidecar when changing to a map-only view", async () => {
  const fixture = scenarioFixture();
  const invalidate = jest.fn();
  Object.assign(fixture.simulator, { clearMissExplanations: invalidate, clearReplayComparison: jest.fn() });
  await fixture.manager.loadBeatmap("map-only");
  expect(invalidate).toHaveBeenCalledTimes(1);
});

jest.mock("fs/promises", () => ({ readFile: jest.fn(), readdir: jest.fn() }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function scenarioFixture({
  folderName = "2458992 Juztan - #WE _3 YURI",
  audioFile = "audio.mp3",
  backgroundFile = "imagejuz.png",
  songsFolder = resolve("path-url-fixture", "Songs"),
} = {}) {
  const folder = join(songsFolder, folderName);
  const osuFile = "Artist - #Title %23 (Mapper) [Difficulty].osu";
  const replayId = join(resolve("path-url-fixture", "Replays"), "Player - #Title %25.osr");
  const rawBlueprint = `osu file format v14

[General]
AudioFilename: ${audioFile}
Mode: 0

[Metadata]
Title: #Title %23
Artist: Artist
Creator: Mapper
Version: Difficulty

[Difficulty]
HPDrainRate: 5
CircleSize: 4
OverallDifficulty: 5
ApproachRate: 5
SliderMultiplier: 1.4
SliderTickRate: 1

[Events]
0,0,"${backgroundFile}",0,0

[TimingPoints]
0,500,4,1,0,100,1,0

[HitObjects]
256,192,1000,1,0,0:0:0:0:
`;
  (readFile as jest.Mock).mockImplementation(async (path: string, encoding?: string) => {
    if (path !== join(folder, osuFile)) throw new Error(`Unexpected filesystem path: ${path}`);
    return encoding ? rawBlueprint : Buffer.from(rawBlueprint);
  });
  (readdir as jest.Mock).mockResolvedValue([]);

  const clock = {
    clear: jest.fn(),
    setDuration: jest.fn(),
    setAnalysisEnd: jest.fn(),
    setBaseRate: jest.fn(),
    setSpeed: jest.fn(),
    seekTo: jest.fn(),
  };
  const gameLoop = { stopTicker: jest.fn(), startTicker: jest.fn() };
  const simulator = {
    clear: jest.fn(),
    calculateDifficulties: jest.fn(),
    simulateReplay: jest.fn(),
    getPerformanceInputs: jest.fn(() => []),
  };
  const performanceTimeline = { clear: jest.fn(), load: jest.fn().mockResolvedValue(undefined) };
  const audio: { duration: number; preservesPitch?: boolean } = { duration: 120, preservesPitch: true };
  const audioService = {
    cancelPendingLoads: jest.fn(),
    loadAudio: jest.fn(async (url: string) => {
      if (fileURLToPath(url) !== join(folder, audioFile)) throw new Error(`Wrong audio URL: ${url}`);
      return audio;
    }),
  };
  const background = {};
  const textureManager = {
    loadTexture: jest.fn(async (url: string) => {
      if (fileURLToPath(url) !== join(folder, backgroundFile)) throw new Error(`Wrong background URL: ${url}`);
      return background;
    }),
  };
  const replay = {
    gameMode: 0,
    beatmapMd5: createHash("md5").update(rawBlueprint).digest("hex"),
    mods: [],
    frames: [],
  };
  const replayService = { retrieveReplay: jest.fn().mockResolvedValue(replay) };
  const backgroundSettings = { texture$: new BehaviorSubject<unknown>(null) };
  const replayManager = { setMainReplay: jest.fn(), setComparisonCursorSource: jest.fn() };
  const sceneManager = { changeToScene: jest.fn().mockResolvedValue(undefined) };
  const audioEngine = { destroy: jest.fn(), setSong: jest.fn() };
  const hitSoundEngine = { clear: jest.fn(), configure: jest.fn().mockResolvedValue(undefined) };
  const blueprintInfo = { folderName, osuFileName: osuFile };
  const blueprintLocator = { getBlueprintByMD5: jest.fn().mockResolvedValue(blueprintInfo) };
  const onlineBeatmapLookup = {
    lookup: jest.fn().mockResolvedValue(undefined),
    lookupResult: jest.fn().mockResolvedValue({ status: "NOT_FOUND" }),
  };
  const sliderTextures = { clear: jest.fn() };
  const manager = new ScenarioManager(
    clock as never,
    { getRenderer: () => undefined } as never,
    gameLoop as never,
    simulator as never,
    { setHidden: jest.fn(), setFlashlight: jest.fn() } as never,
    blueprintLocator as never,
    { songsFolder$: new BehaviorSubject(songsFolder), whenReady: jest.fn().mockResolvedValue(songsFolder) } as never,
    audioService as never,
    textureManager as never,
    replayService as never,
    backgroundSettings as never,
    { setBeatmap: jest.fn() } as never,
    replayManager as never,
    sceneManager as never,
    {} as never,
    audioEngine as never,
    hitSoundEngine as never,
    onlineBeatmapLookup as never,
    performanceTimeline as never,
    sliderTextures as never,
  );
  return {
    manager,
    rawBlueprint,
    replayId,
    folder,
    osuFile,
    audioFile,
    backgroundFile,
    audio,
    background,
    audioService,
    textureManager,
    replayService,
    backgroundSettings,
    clock,
    gameLoop,
    simulator,
    performanceTimeline,
    sliderTextures,
    replayManager,
    sceneManager,
    audioEngine,
    hitSoundEngine,
    blueprintInfo,
    blueprintLocator,
    onlineBeatmapLookup,
    replay,
  };
}

function libraryFixture() {
  const f = scenarioFixture();
  const texture = { destroy: jest.fn() };
  f.textureManager.loadTexture.mockResolvedValue(texture);
  const resource = { handle: { replayId: "canonical", beatmapMd5: f.replay.beatmapMd5, mapSha256: "d".repeat(64), storyboards: ["story.osb"] },
    replay: jest.fn(async () => f.replay), map: jest.fn(async () => f.rawBlueprint),
    asset: jest.fn(async (_name: string) => Uint8Array.from([1])), optionalAsset: jest.fn(async (_name: string) => undefined),
    backgroundUrl: jest.fn(async () => "blob:owned-background"), close: jest.fn(async () => undefined) };
  const audioResource = jest.fn(async (_name: string, read: (signal: AbortSignal) => Promise<Uint8Array>) => { await read(new AbortController().signal); return f.audio; });
  Object.assign(f.audioService, { loadAudioResource: audioResource });
  const configureResources = jest.fn(async () => undefined); Object.assign(f.hitSoundEngine, { configureResources });
  const release = jest.fn(), open = jest.fn(async (_id: string, _signal: AbortSignal) => resource);
  f.manager.setLibraryReplaySource({ open: open as never, acquireForeground: () => release });
  return { ...f, resource, texture, open, release, audioResource, configureResources };
}

describe("ScenarioManager automatic replay replacement", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  async function automaticFixture() {
    const f = libraryFixture();
    await f.manager.loadLibraryReplay("canonical");
    const newReplays$ = new Subject<string>();
    Object.assign(f.manager, { replayWatcher: { newReplays$ } });
    f.manager.initialize();
    const load = jest.spyOn(f.manager, "loadReplay");
    const publisher = { clear: jest.fn(), attach: jest.fn(), discard: jest.fn() };
    f.manager.setCurrentReplayPublisher(publisher);
    const transport = { position: 48161, speed: 1.25 };
    f.clock.clear.mockImplementation(() => { transport.position = 0; });
    f.clock.seekTo.mockImplementation((value: number) => { transport.position = value; });
    f.clock.setSpeed.mockImplementation((value: number) => { transport.speed = value; });
    const ready = f.manager.loadState$.value, scenario = f.manager.scenario$.value;
    const generation = (f.manager as unknown as { loadSequence: number }).loadSequence;
    const destroyed = f.audioEngine.destroy.mock.calls.length;
    const emit = (id: string) => {
      newReplays$.next(id);
      return load.mock.results[load.mock.results.length - 1].value as Promise<boolean>;
    };
    const expectRetained = () => {
      expect(f.manager.loadState$.value).toBe(ready);
      expect(f.manager.scenario$.value).toBe(scenario);
      expect((f.manager as unknown as { loadSequence: number }).loadSequence).toBe(generation);
      expect(transport).toEqual({ position: 48161, speed: 1.25 });
      expect(publisher.clear).not.toHaveBeenCalled();
      expect(f.resource.close).not.toHaveBeenCalled();
      expect(f.audioEngine.destroy).toHaveBeenCalledTimes(destroyed);
    };
    return { ...f, newReplays$, emit, expectRetained, transport, publisher };
  }

  it.each(["missing map", "map read", "replay read", "unsupported mode"] as const)(
    "keeps the ready viewer, playhead, rate and publisher after automatic %s failure", async failure => {
      const f = await automaticFixture();
      if (failure === "missing map") f.blueprintLocator.getBlueprintByMD5.mockResolvedValue(undefined);
      else if (failure === "map read") (readFile as jest.Mock).mockRejectedValueOnce(new Error("Cannot read candidate map"));
      else if (failure === "replay read") f.replayService.retrieveReplay.mockRejectedValueOnce(new Error("Cannot read candidate replay"));
      else f.replayService.retrieveReplay.mockResolvedValueOnce({ ...f.replay, gameMode: 3 });
      await expect(f.emit("restored.osr")).resolves.toBe(false);
      f.expectRetained();
      expect(f.onlineBeatmapLookup.lookupResult).not.toHaveBeenCalled();
    },
  );

  it.each(["explicit file", "library replay", "clear", "new automatic"] as const)(
    "discards held automatic preflight after %s without reviving it", async replacement => {
      const f = await automaticFixture(), reading = deferred(), entered = deferred();
      f.replayService.retrieveReplay.mockImplementationOnce(async () => { entered.resolve(); await reading.promise; return f.replay; });
      const old = f.emit("older.osr"); await entered.promise;
      f.expectRetained();
      if (replacement === "explicit file") await f.manager.loadReplay("manual.osr");
      else if (replacement === "library replay") await f.manager.loadLibraryReplay("canonical");
      else if (replacement === "clear") await f.manager.clearReplay();
      else await f.emit("newer.osr");
      const current = f.manager.loadState$.value, scenario = f.manager.scenario$.value;
      const simulations = f.simulator.simulateReplay.mock.calls.length;
      reading.resolve(); await expect(old).resolves.toBe(false);
      expect(f.manager.loadState$.value).toBe(current);
      expect(f.manager.scenario$.value).toBe(scenario);
      expect(f.simulator.simulateReplay).toHaveBeenCalledTimes(simulations);
    },
  );

  it("keeps successful automatic loading and consumes each verified candidate only once", async () => {
    const f = await automaticFixture();
    const reads = (readFile as jest.Mock).mock.calls.length;
    const simulations = f.simulator.simulateReplay.mock.calls.length;
    await expect(f.emit(f.replayId)).resolves.toBe(true);
    expect(f.replayService.retrieveReplay).toHaveBeenCalledTimes(1);
    expect((readFile as jest.Mock).mock.calls.length - reads).toBe(1);
    expect(f.simulator.simulateReplay).toHaveBeenCalledTimes(simulations + 1);
    expect(f.resource.close).toHaveBeenCalledTimes(1);
    expect(f.manager.loadState$.value.phase).toBe("ready");
    expect(f.transport).toEqual({ position: 0, speed: 1 });
  });

  it("retains the ready viewer if export cancellation rejects after automatic preflight", async () => {
    const f = await automaticFixture();
    f.manager.setBeforeReplayChange(async () => { throw new Error("Export still owns media"); });
    await expect(f.emit(f.replayId)).resolves.toBe(false);
    f.expectRetained();
  });

  it("rechecks automatic ownership after a held export cancellation", async () => {
    const f = await automaticFixture(), cancelling = deferred(), entered = deferred();
    f.manager.setBeforeReplayChange(async () => { entered.resolve(); await cancelling.promise; });
    const old = f.emit(f.replayId); await entered.promise; f.expectRetained();
    f.manager.setBeforeReplayChange(async () => undefined);
    await f.manager.clearReplay(); const idle = f.manager.loadState$.value;
    cancelling.resolve(); await expect(old).resolves.toBe(false);
    expect(f.manager.loadState$.value).toBe(idle);
  });

  it("keeps the ordinary missing-map stage when automatic loading has no ready viewer to preserve", async () => {
    const f = scenarioFixture(), newReplays$ = new Subject<string>();
    Object.assign(f.manager, { replayWatcher: { newReplays$ } }); f.manager.initialize();
    const load = jest.spyOn(f.manager, "loadReplay");
    f.blueprintLocator.getBlueprintByMD5.mockResolvedValue(undefined);
    newReplays$.next(f.replayId); await load.mock.results[0].value;
    expect(f.manager.loadState$.value).toMatchObject({ phase: "failed", failure: { kind: "beatmap-not-found" } });
  });
});

describe("ScenarioManager verified library resources", () => {
  beforeEach(() => jest.clearAllMocks());
  it("rejects a missing-map candidate without retiring the ready viewer or its publisher", async () => {
    const f = libraryFixture();
    await f.manager.loadReplay(f.replayId);
    const publisher = { clear: jest.fn(), attach: jest.fn(), discard: jest.fn() };
    f.manager.setCurrentReplayPublisher(publisher);
    const ready = f.manager.loadState$.value, scenario = f.manager.scenario$.value;
    const sequence = (f.manager as unknown as { loadSequence: number }).loadSequence;
    const clears = f.clock.clear.mock.calls.length, destroyed = f.audioEngine.destroy.mock.calls.length;
    const error = new Error("verified exact map unavailable");
    f.open.mockRejectedValueOnce(error);
    await expect(f.manager.loadLibraryReplay("missing-map")).rejects.toBe(error);
    expect(f.manager.loadState$.value).toBe(ready);
    expect(f.manager.scenario$.value).toBe(scenario);
    expect((f.manager as unknown as { loadSequence: number }).loadSequence).toBe(sequence);
    expect(f.clock.clear).toHaveBeenCalledTimes(clears);
    expect(f.audioEngine.destroy).toHaveBeenCalledTimes(destroyed);
    expect(publisher.clear).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("keeps an installed library owner while a held replacement is superseded and closes only that candidate", async () => {
    const f = libraryFixture();
    await f.manager.loadLibraryReplay("first");
    const ready = f.manager.loadState$.value, held = deferred(), entered = deferred();
    const candidate = { ...f.resource, close: jest.fn(async () => undefined) };
    let signal!: AbortSignal;
    f.open.mockImplementationOnce(async (_id, value) => { signal = value; entered.resolve(); await held.promise; return candidate; });
    const opening = f.manager.loadLibraryReplay("second");
    await entered.promise;
    expect(f.resource.close).not.toHaveBeenCalled();
    expect(f.manager.loadState$.value).toBe(ready);
    const clearing = f.manager.clearReplay();
    expect(signal.aborted).toBe(true);
    held.resolve();
    expect(await opening).toBe(false);
    await clearing;
    expect(candidate.close).toHaveBeenCalledTimes(1);
    expect(f.resource.close).toHaveBeenCalledTimes(1);
    expect(f.manager.loadState$.value.phase).toBe("idle");
  });
  it("awaits failed candidate retirement before acquiring a third resource session", async () => {
    const f = libraryFixture(); await f.manager.loadLibraryReplay("first");
    const held = deferred(), closing = deferred();
    const failed = { ...f.resource, replay: jest.fn(async () => { throw new Error("candidate transfer failed"); }),
      close: jest.fn(async () => { closing.resolve(); await held.promise; return undefined; }) };
    const next = { ...f.resource, close: jest.fn(async () => undefined) };
    f.open.mockResolvedValueOnce(failed).mockResolvedValueOnce(next);
    const failure = f.manager.loadLibraryReplay("second").catch(error => error);
    await closing.promise;
    const replacement = f.manager.loadLibraryReplay("third");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.resource.close).not.toHaveBeenCalled();
    held.resolve();
    expect(await failure).toBeInstanceOf(Error);
    expect(await replacement).toBe(true);
    expect(f.open).toHaveBeenCalledTimes(3);
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(f.resource.close).toHaveBeenCalledTimes(1);
    expect(failed.close.mock.invocationCallOrder[0]).toBeLessThan(f.open.mock.invocationCallOrder[2]);
    await f.manager.clearReplay(); expect(next.close).toHaveBeenCalledTimes(1);
  });
  it("preserves installed resources and generation when candidate export cancellation fails", async () => {
    const f = libraryFixture(); await f.manager.loadLibraryReplay("first");
    const publisher = { clear: jest.fn(), attach: jest.fn(), discard: jest.fn() };
    f.manager.setCurrentReplayPublisher(publisher);
    const ready = f.manager.loadState$.value, clears = f.simulator.clear.mock.calls.length;
    const candidate = { ...f.resource, close: jest.fn(async () => undefined) };
    f.open.mockResolvedValueOnce(candidate);
    f.manager.setBeforeReplayChange(async () => { throw new Error("Export still owns media"); });
    await expect(f.manager.loadLibraryReplay("second")).rejects.toThrow("Export still owns media");
    expect(f.manager.loadState$.value).toBe(ready);
    expect(f.simulator.clear).toHaveBeenCalledTimes(clears);
    expect(publisher.clear).not.toHaveBeenCalled();
    expect(f.resource.close).not.toHaveBeenCalled();
    expect(candidate.close).toHaveBeenCalledTimes(1);
    f.manager.setBeforeReplayChange(async () => undefined); await f.manager.clearReplay();
  });
  it("lets manual F2 supersede preflight without letting its late candidate replace the manual viewer", async () => {
    const f = libraryFixture(); await f.manager.loadLibraryReplay("first");
    const held = deferred(), entered = deferred();
    const candidate = { ...f.resource, close: jest.fn(async () => undefined) };
    let signal!: AbortSignal;
    f.open.mockImplementationOnce(async (_id, value) => { signal = value; entered.resolve(); await held.promise; return candidate; });
    const opening = f.manager.loadLibraryReplay("second"); await entered.promise;
    const manual = f.manager.loadReplay(f.replayId);
    expect(signal.aborted).toBe(true);
    held.resolve(); expect(await opening).toBe(false); expect(await manual).toBe(true);
    expect(f.replayService.retrieveReplay).toHaveBeenCalledWith(f.replayId);
    expect(candidate.close).toHaveBeenCalledTimes(1);
    expect(f.resource.close).toHaveBeenCalledTimes(1);
    expect(f.manager.loadState$.value.phase).toBe("ready");
  });
  it("closes a prepared candidate cancelled while the prior installed resource is retiring", async () => {
    const f = libraryFixture(); await f.manager.loadLibraryReplay("first");
    const held = deferred(), closing = deferred();
    f.resource.close.mockImplementation(async () => { closing.resolve(); await held.promise; });
    const candidate = { ...f.resource, close: jest.fn(async () => undefined) };
    f.open.mockResolvedValueOnce(candidate);
    const replacement = f.manager.loadLibraryReplay("second"); await closing.promise;
    const clearing = f.manager.clearReplay();
    held.resolve();
    expect(await replacement).toBe(false); await clearing;
    expect(candidate.close).toHaveBeenCalledTimes(1);
    expect(f.resource.close).toHaveBeenCalledTimes(1);
    expect(f.manager.loadState$.value.phase).toBe("idle");
  });
  it("uses the existing viewer pipeline with verified native resources and no Stable lookup", async () => {
    const f = libraryFixture(); await f.manager.loadLibraryReplay("native-id");
    expect(f.manager.scenario$.value.status).toBe("DONE");
    expect(f.replayService.retrieveReplay).not.toHaveBeenCalled(); expect(f.blueprintLocator.getBlueprintByMD5).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled(); expect(readdir).not.toHaveBeenCalled();
    expect(f.audioResource).toHaveBeenCalled(); expect(f.resource.asset).toHaveBeenCalledWith(f.audioFile);
    expect(f.configureResources).toHaveBeenCalled(); expect(f.hitSoundEngine.configure).not.toHaveBeenCalled();
    expect(f.simulator.simulateReplay.mock.calls[0][2]).toMatchObject({ beatmapContentSha256: "d".repeat(64), beatmapMd5: f.replay.beatmapMd5 });
    expect(f.release).toHaveBeenCalledTimes(1); expect(f.resource.close).not.toHaveBeenCalled();
    await f.manager.clearReplay(); expect(f.resource.close).toHaveBeenCalledTimes(1); expect(f.texture.destroy).toHaveBeenCalledWith(true);
  });
  it("retains installed resources until export cancellation and consumer detachment, then permits manual replay loading", async () => {
    const f = libraryFixture(); await f.manager.loadLibraryReplay("native-id");
    const barrier = deferred(); f.manager.setBeforeReplayChange(() => barrier.promise);
    const next = f.manager.loadReplay(f.replayId);
    expect(f.resource.close).not.toHaveBeenCalled(); expect(f.texture.destroy).not.toHaveBeenCalled();
    barrier.resolve(); await next;
    expect(f.resource.close).toHaveBeenCalledTimes(1);
    expect(f.audioEngine.destroy.mock.invocationCallOrder[1]).toBeLessThan(f.resource.close.mock.invocationCallOrder[0]);
    expect(f.manager.scenario$.value.status).toBe("DONE"); expect(f.replayService.retrieveReplay).toHaveBeenCalledTimes(1);
  });
  it("cancels a pending library open and ignores its late completion after clear", async () => {
    const f = libraryFixture(), barrier = deferred(), started = deferred(); let signal!: AbortSignal;
    f.open.mockImplementation(async (_id, value) => { signal = value; started.resolve(); await barrier.promise; return f.resource; });
    const loading = f.manager.loadLibraryReplay("native-id"); await started.promise;
    const clearing = f.manager.clearReplay(); await Promise.resolve();
    expect(signal.aborted).toBe(true); barrier.resolve(); await Promise.all([loading, clearing]);
    expect(f.resource.replay).not.toHaveBeenCalled(); expect(f.manager.scenario$.value.status).toBe("INIT");
    expect(f.resource.close).toHaveBeenCalled();
  });
  it("does not release the installed viewer when export cancellation fails", async () => {
    const f = libraryFixture(); await f.manager.loadLibraryReplay("native-id");
    f.manager.setBeforeReplayChange(async () => { throw new Error("Export still owns media"); });
    await expect(f.manager.loadReplay(f.replayId)).rejects.toThrow("Export still owns media");
    expect(f.resource.close).not.toHaveBeenCalled(); expect(f.texture.destroy).not.toHaveBeenCalled();
    expect(f.manager.scenario$.value.status).toBe("DONE");
    f.manager.setBeforeReplayChange(async () => undefined); await f.manager.clearReplay();
  });
  it("releases failed media acquisition and never publishes a ready viewer", async () => {
    const f = libraryFixture(); f.resource.asset.mockRejectedValue(new Error("SHA mismatch"));
    await f.manager.loadLibraryReplay("native-id");
    expect(f.manager.scenario$.value).toMatchObject({ status: "ERROR", errorMessage: "SHA mismatch" });
    expect(f.resource.close).toHaveBeenCalledTimes(1); expect(f.gameLoop.startTicker).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it("destroys a late library texture after clearing without publishing it", async () => {
    const f = libraryFixture(), reading = deferred(), started = deferred();
    f.textureManager.loadTexture.mockImplementation(async () => { started.resolve(); await reading.promise; return f.texture; });
    const loading = f.manager.loadLibraryReplay("native-id"); await started.promise;
    await f.manager.clearReplay(); reading.resolve(); await loading;
    expect(f.texture.destroy).toHaveBeenCalledTimes(1); expect(f.backgroundSettings.texture$.value).not.toBe(f.texture);
    expect(f.audioResource).not.toHaveBeenCalled(); expect(f.manager.scenario$.value.status).toBe("INIT");
  });
  it("reports unconfirmed resource cleanup, blocks library reuse and still allows manual replay loading", async () => {
    const f = libraryFixture(); await f.manager.loadLibraryReplay("native-id");
    f.resource.close.mockRejectedValue(new Error("Release not acknowledged"));
    await f.manager.loadReplay(f.replayId);
    expect(f.manager.scenario$.value.status).toBe("DONE"); expect(f.replayService.retrieveReplay).toHaveBeenCalledTimes(1);
    await expect(f.manager.loadLibraryReplay("another")).rejects.toThrow("Release not acknowledged");
    expect(f.manager.scenario$.value.status).toBe("DONE");
    expect(f.open).toHaveBeenCalledTimes(1);
    await f.manager.clearReplay(); expect(f.manager.scenario$.value.status).toBe("INIT");
  });
});

describe("ScenarioManager detached current replay reuse", () => {
  beforeEach(() => jest.clearAllMocks());
  function captureFixture() {
    const f = libraryFixture();
    const receipt: LibraryCurrentReplayReceipt = { version: 1, token: "verified-token", replayId: "canonical",
      replaySha256: "a".repeat(64), mapSha256: f.resource.handle.mapSha256, mapMd5: f.replay.beatmapMd5,
      numericalInputKey: "b".repeat(64), parserVersion: LIBRARY_REPLAY_PARSER_VERSION,
      preparationVersion: LIBRARY_RESOURCE_PREPARATION_VERSION, numericalVersion: LIBRARY_NUMERIC_PROJECTION_VERSION };
    Object.assign(f.resource.handle, { currentReplay: receipt, replaySha256: receipt.replaySha256 });
    Object.assign(f.replay, { replayContentSha256: receipt.replaySha256 });
    const context = { generation: 1 } as CurrentReplayCaptureContext;
    const getLibraryReplayContext = jest.fn(() => context); Object.assign(f.simulator, { getLibraryReplayContext });
    const publisher = { clear: jest.fn(), attach: jest.fn(), discard: jest.fn() }; f.manager.setCurrentReplayPublisher(publisher);
    return { ...f, receipt, context, publisher, getLibraryReplayContext };
  }
  it("binds exact recording resources and attaches only after interactive readiness without awaiting publication", async () => {
    const f = captureFixture(), pending = deferred(); f.publisher.attach.mockImplementation(() => pending.promise);
    await f.manager.loadLibraryReplay("canonical");
    expect(f.simulator.simulateReplay.mock.calls[0][2]).toMatchObject({ libraryReuseBinding: {
      replaySha256: f.receipt.replaySha256, mapSha256: f.receipt.mapSha256, mapMd5: f.receipt.mapMd5,
      numericalInputKey: f.receipt.numericalInputKey, mode: "stable", clockRate: 1, objectCount: 1,
      parserVersion: LIBRARY_REPLAY_PARSER_VERSION, preparationVersion: LIBRARY_RESOURCE_PREPARATION_VERSION } });
    expect(f.performanceTimeline.load).toHaveBeenCalledWith(f.rawBlueprint, [], f.context);
    expect(f.publisher.attach).toHaveBeenCalledWith(f.receipt, f.context);
    expect(f.gameLoop.startTicker.mock.invocationCallOrder[0]).toBeLessThan(f.publisher.attach.mock.invocationCallOrder[0]);
    expect(f.manager.loadState$.value.phase).toBe("ready"); pending.resolve();
    expect(f.publisher.discard).not.toHaveBeenCalled();
  });
  it("allows the real publisher's held capture to finish after a failed candidate without revoking its installed generation", async () => {
    const f = captureFixture(), held = deferred(), entered = deferred();
    const binding = currentReplayBinding(f.receipt, "stable", 1, 1);
    if (!binding) throw new Error("Expected verified publisher binding");
    const context = { ...f.context, binding };
    f.getLibraryReplayContext.mockReturnValue(context);
    const request = jest.fn(async (input: LibraryCurrentReplayRequest) => input.method === "current-replay-release" ? { state: "released" }
      : { state: "applied", accepted: input.results.map(result => result.slot) });
    const numerical: CurrentReplayProjectedNumericalSnapshot = { status: "complete", projectionVersion: LIBRARY_NUMERIC_PROJECTION_VERSION,
      projected: { provenance: { replaySha256: binding.replaySha256, mapSha256: binding.mapSha256, mapMd5: binding.mapMd5,
        ruleset: "stable", rate: 1, projectionVersion: LIBRARY_NUMERIC_PROJECTION_VERSION, coverageQualified: true,
        completeAccuracyEvidence: true, completeBreakEvidence: true, completionEvidence: "source-domain-coverage-v1" },
        fields: { completion: { state: "known", value: "passed" }, misses: { state: "known", value: 0 } } } };
    const onError = jest.fn();
    const publisher = new LibraryCurrentReplayPublisher({
      simulator: { isLibraryReplayCurrent: value => value === context && (f.manager as unknown as { loadSequence: number }).loadSequence === 1,
        captureLibraryNumerical: async (_context, checkpoint) => { entered.resolve(); await held.promise; await checkpoint(); return numerical; } },
      performance: { changed$: new Subject<number>(), captureLibraryPerformance: () => undefined },
      request, checkpoint: async () => undefined, onError,
    });
    f.manager.setCurrentReplayPublisher(publisher);
    try {
      expect(await f.manager.loadLibraryReplay("canonical")).toBe(true); await entered.promise;
      const clears = f.simulator.clear.mock.calls.length;
      f.open.mockRejectedValueOnce(new Error("candidate absent"));
      await expect(f.manager.loadLibraryReplay("missing")).rejects.toThrow("candidate absent");
      expect(f.simulator.clear).toHaveBeenCalledTimes(clears);
      held.resolve(); for (let i = 0; i < 40; i++) await Promise.resolve();
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "current-replay-publish", token: f.receipt.token }));
      expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ method: "current-replay-release" }));
      expect(onError).not.toHaveBeenCalled();
    } finally { held.resolve(); publisher.dispose(); await f.manager.clearReplay(); }
  });
  it.each(["replaySha256", "mapSha256", "mapMd5", "replayId", "numericalVersion"] as const)("declines a mismatched %s receipt without changing viewer load", async key => {
    const f = captureFixture(); f.receipt[key] = "mismatch";
    await f.manager.loadLibraryReplay("canonical");
    expect(f.manager.scenario$.value.status).toBe("DONE"); expect(f.publisher.attach).not.toHaveBeenCalled();
    expect(f.simulator.simulateReplay.mock.calls[0][2]).not.toHaveProperty("libraryReuseBinding");
    expect(f.performanceTimeline.load).toHaveBeenCalledWith(f.rawBlueprint, []);
  });
  it("does not turn ordinary file/F2 loads without verified index receipt into reuse or admission", async () => {
    const f = captureFixture(); await f.manager.loadReplay(f.replayId);
    expect(f.publisher.attach).not.toHaveBeenCalled(); expect(f.getLibraryReplayContext).not.toHaveBeenCalled();
    expect(f.performanceTimeline.load).toHaveBeenCalledWith(f.rawBlueprint, []);
    expect(f.manager.scenario$.value.status).toBe("DONE");
  });
  it.each(["lazer", "lazer-classic"] as const)("binds the prepared %s recording and custom clock rate", async mode => {
    const f = captureFixture(); Object.assign(f.replay, { gameVersion: 30000019,
      lazerMods: [{ acronym: "DT", settings: { speed_change: 1.25 } }, ...(mode === "lazer-classic" ? [{ acronym: "CL" }] : [])] });
    await f.manager.loadLibraryReplay("canonical");
    expect(f.simulator.simulateReplay.mock.calls[0][2]).toMatchObject({ libraryReuseBinding: { mode, clockRate: 1.25, objectCount: 1 } });
    expect(f.clock.setSpeed).toHaveBeenCalledWith(1); expect(f.publisher.attach).toHaveBeenCalledWith(f.receipt, f.context);
  });
  it("keeps a ready viewer when optional publisher attachment fails", async () => {
    const f = captureFixture(); f.publisher.attach.mockImplementation(() => { throw new Error("Optional capture rejected"); });
    await f.manager.loadLibraryReplay("canonical"); expect(f.manager.scenario$.value.status).toBe("DONE");
    expect(f.publisher.discard).toHaveBeenCalledWith(f.receipt); expect(f.resource.close).not.toHaveBeenCalled();
  });
  it("revokes generation before awaiting export cancellation and suppresses a superseded ready capture", async () => {
    const f = captureFixture(), gate = deferred(), entered = deferred();
    f.sceneManager.changeToScene.mockImplementation(async () => { entered.resolve(); await gate.promise; });
    const loading = f.manager.loadLibraryReplay("canonical"); await entered.promise;
    const exportGate = deferred(); f.manager.setBeforeReplayChange(() => exportGate.promise);
    const previousClears = f.publisher.clear.mock.calls.length; const clearing = f.manager.clearReplay();
    expect(f.publisher.clear).toHaveBeenCalledTimes(previousClears + 1);
    gate.resolve(); await loading; expect(f.publisher.attach).not.toHaveBeenCalled();
    expect(f.publisher.discard).toHaveBeenCalledWith(f.receipt);
    exportGate.resolve(); await clearing;
  });
  it("revokes capture in a map-only view", async () => {
    const f = captureFixture(); Object.assign(f.simulator, { clearMissExplanations: jest.fn(), clearReplayComparison: jest.fn() });
    await f.manager.loadBeatmap("map-only"); expect(f.publisher.clear).toHaveBeenCalledTimes(1);
  });
  it("releases an issued receipt when media preparation fails before capture", async () => {
    const f = captureFixture(); f.resource.asset.mockRejectedValue(new Error("Media unavailable"));
    await f.manager.loadLibraryReplay("canonical"); expect(f.publisher.attach).not.toHaveBeenCalled();
    expect(f.publisher.discard).toHaveBeenCalledWith(f.receipt); expect(f.manager.scenario$.value.status).toBe("ERROR");
  });
});

describe("ScenarioManager local media URLs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("releases slider textures before loading a replay and when clearing it", async () => {
    const fixture = scenarioFixture();
    await fixture.manager.loadReplay(fixture.replayId);
    expect(fixture.sliderTextures.clear).toHaveBeenCalledTimes(1);
    expect(fixture.sliderTextures.clear.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.simulator.simulateReplay.mock.invocationCallOrder[0],
    );
    await fixture.manager.clearReplay();
    expect(fixture.sliderTextures.clear).toHaveBeenCalledTimes(2);
  });

  it("exposes the loaded map identity and clears it when the replay is closed", async () => {
    const fixture = scenarioFixture();
    const { manager } = fixture;
    expect(manager.getBeatmapMetadata()).toBeUndefined();

    await manager.loadReplay(fixture.replayId);
    expect(manager.getBeatmapMetadata()).toMatchObject({
      title: "#Title %23",
      artist: "Artist",
      difficultyName: "Difficulty",
    });

    await manager.clearReplay();
    expect(manager.getBeatmapMetadata()).toBeUndefined();
  });

  it("clears the previous identity when loading its replacement fails", async () => {
    const fixture = scenarioFixture();
    const { manager } = fixture;
    await manager.loadReplay(fixture.replayId);
    expect(manager.getBeatmapMetadata()).toMatchObject({ title: "#Title %23" });

    fixture.replayService.retrieveReplay.mockRejectedValueOnce(new Error("Replay is unavailable"));
    await manager.loadReplay("replacement.osr");
    expect(manager.scenario$.getValue().status).toBe("ERROR");
    expect(manager.getBeatmapMetadata()).toBeUndefined();
  });

  it("waits for clip cancellation before releasing its audio or loading the next replay", async () => {
    const fixture = scenarioFixture();
    const cancellation = deferred();
    fixture.manager.setBeforeReplayChange(() => cancellation.promise);
    const loading = fixture.manager.loadReplay(fixture.replayId);
    expect(fixture.audioEngine.destroy).not.toHaveBeenCalled();
    expect(fixture.replayService.retrieveReplay).not.toHaveBeenCalled();
    cancellation.resolve();
    await loading;
    expect(fixture.audioEngine.destroy).toHaveBeenCalledTimes(1);
    expect(fixture.manager.scenario$.value.status).toBe("DONE");
  });

  it("keeps only the newest replay request while export cancellation is pending", async () => {
    const fixture = scenarioFixture();
    const cancellation = deferred();
    fixture.manager.setBeforeReplayChange(() => cancellation.promise);
    const first = fixture.manager.loadReplay("first.osr");
    const latest = fixture.manager.loadReplay(fixture.replayId);
    cancellation.resolve();
    await Promise.all([first, latest]);
    expect(fixture.replayService.retrieveReplay).toHaveBeenCalledTimes(1);
    expect(fixture.replayService.retrieveReplay).toHaveBeenCalledWith(fixture.replayId);
  });

  it("cancels an export that began while a comparison replay was still being read", async () => {
    const fixture = scenarioFixture();
    await fixture.manager.loadReplay(fixture.replayId);
    const simulator = Object.assign(fixture.simulator, {
      getRulesetFocus: () => "stable",
      setReplayComparisonLoading: jest.fn(),
      compareReplay: jest.fn(() => ({ status: "ERROR", message: "comparison fixture" })),
    });
    Object.assign(fixture.replayManager, { getMainReplay: () => fixture.replay });
    const reading = deferred();
    const cancellation = deferred();
    const cancellationStarted = deferred();
    fixture.replayService.retrieveReplay.mockImplementation(async () => {
      await reading.promise;
      return fixture.replay;
    });
    const cancel = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(() => {
        cancellationStarted.resolve();
        return cancellation.promise;
      });
    fixture.manager.setBeforeReplayChange(cancel);
    const loading = fixture.manager.loadComparisonReplay("comparison.osr");
    reading.resolve();
    await cancellationStarted.promise;
    expect(simulator.compareReplay).not.toHaveBeenCalled();
    cancellation.resolve();
    await loading;
    expect(simulator.compareReplay).toHaveBeenCalledTimes(1);
  });

  it("preserves later replay frames and judgements when the song is shorter than the map", async () => {
    const fixture = scenarioFixture();
    fixture.audio.duration = 0.5;
    fixture.replay.frames = [{ time: 1500 }] as never;
    await fixture.manager.loadReplay(fixture.replayId);
    expect(fixture.clock.setAnalysisEnd).toHaveBeenCalledWith(1500);
    expect(fixture.clock.setDuration).toHaveBeenCalledWith(1500);
    expect(fixture.manager.scenario$.value.status).toBe("DONE");
  });

  it("plays Stable Nightcore at its original raised pitch", async () => {
    const fixture = scenarioFixture();
    fixture.replay.mods = ["DOUBLE_TIME", "NIGHT_CORE"] as never;
    await fixture.manager.loadReplay(fixture.replayId);
    expect(fixture.audio.preservesPitch).toBe(false);
    expect(fixture.clock.setBaseRate).toHaveBeenCalledWith(1.5);
  });

  it("continues replay simulation and native performance preparation when the optional difficulty graph fails", async () => {
    const fixture = scenarioFixture();
    const graph = new GameSimulator();
    fixture.simulator.calculateDifficulties.mockImplementation(graph.calculateDifficulties.bind(graph));
    const calculate = jest.spyOn(std_diff.prototype, "calc").mockImplementationOnce(() => {
      throw new Error("Legacy difficulty calculation failed");
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await fixture.manager.loadReplay(fixture.replayId);
    calculate.mockRestore();
    warn.mockRestore();

    expect(graph.difficulties$.getValue()).toEqual([]);
    expect(fixture.simulator.simulateReplay).toHaveBeenCalledTimes(1);
    expect(fixture.performanceTimeline.load).toHaveBeenCalledTimes(1);
    expect(fixture.hitSoundEngine.configure).toHaveBeenCalledTimes(1);
    expect(fixture.gameLoop.startTicker).toHaveBeenCalledTimes(1);
    expect(fixture.manager.scenario$.getValue().status).toBe("DONE");
  });

  it("does not start playback when a replay is cleared during essential hitsound preparation", async () => {
    const fixture = scenarioFixture();
    const sounds = deferred();
    fixture.hitSoundEngine.configure.mockReturnValue(sounds.promise);
    let finishCalculation!: () => void;
    fixture.performanceTimeline.load.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCalculation = resolve;
        }),
    );
    const loading = fixture.manager.loadReplay(fixture.replayId);
    for (let i = 0; i < 50 && !fixture.performanceTimeline.load.mock.calls.length; i++) await Promise.resolve();
    expect(fixture.performanceTimeline.load).toHaveBeenCalledTimes(1);
    expect(fixture.hitSoundEngine.configure).toHaveBeenCalledTimes(1);
    expect(fixture.gameLoop.startTicker).not.toHaveBeenCalled();
    await fixture.manager.clearReplay();
    finishCalculation();
    sounds.resolve();
    await loading;
    expect(fixture.gameLoop.startTicker).not.toHaveBeenCalled();
    expect(fixture.manager.scenario$.getValue().status).toBe("INIT");
    expect(fixture.performanceTimeline.clear).toHaveBeenCalledTimes(2);
  });

  it.each(["performance", "hitsounds"] as const)(
    "starts playback once hitsounds finish while counters may remain pending (%s first)",
    async (first) => {
      const fixture = scenarioFixture();
      const calculation = deferred();
      const sounds = deferred();
      const started = deferred();
      fixture.performanceTimeline.load.mockReturnValue(calculation.promise);
      fixture.hitSoundEngine.configure.mockImplementation(() => {
        started.resolve();
        return sounds.promise;
      });
      const loading = fixture.manager.loadReplay(fixture.replayId);
      await started.promise;
      expect(fixture.performanceTimeline.load).toHaveBeenCalledTimes(1);
      expect(fixture.hitSoundEngine.configure).toHaveBeenCalledTimes(1);
      (first === "performance" ? calculation : sounds).resolve();
      try {
        for (let turn = 0; turn < 10; turn++) await Promise.resolve();
        if (first === "performance") {
          expect(fixture.sceneManager.changeToScene).not.toHaveBeenCalled();
          expect(fixture.gameLoop.startTicker).not.toHaveBeenCalled();
          expect(fixture.manager.scenario$.getValue().status).toBe("LOADING");
        } else {
          expect(fixture.sceneManager.changeToScene).toHaveBeenCalledTimes(1);
          expect(fixture.gameLoop.startTicker).toHaveBeenCalledTimes(1);
          expect(fixture.manager.scenario$.getValue().status).toBe("DONE");
        }
      } finally {
        (first === "performance" ? sounds : calculation).resolve();
        await loading;
      }
      expect(fixture.sceneManager.changeToScene).toHaveBeenCalledTimes(1);
      expect(fixture.gameLoop.startTicker).toHaveBeenCalledTimes(1);
      expect(fixture.manager.scenario$.getValue().status).toBe("DONE");
    },
  );

  it("does not publish superseded preparations after a newer replay finishes loading", async () => {
    const fixture = scenarioFixture();
    const calculation = deferred();
    const sounds = deferred();
    const started = deferred();
    fixture.performanceTimeline.load.mockReturnValueOnce(calculation.promise);
    fixture.hitSoundEngine.configure.mockImplementationOnce(() => {
      started.resolve();
      return sounds.promise;
    });
    const oldLoading = fixture.manager.loadReplay(fixture.replayId);
    await started.promise;
    await fixture.manager.loadReplay("new-replay.osr");
    expect(fixture.performanceTimeline.clear).toHaveBeenCalledTimes(2);
    expect(fixture.hitSoundEngine.clear).toHaveBeenCalledTimes(2);
    expect(fixture.gameLoop.startTicker).toHaveBeenCalledTimes(1);
    sounds.resolve();
    calculation.resolve();
    await oldLoading;
    expect(fixture.sceneManager.changeToScene).toHaveBeenCalledTimes(1);
    expect(fixture.gameLoop.startTicker).toHaveBeenCalledTimes(1);
    expect(fixture.manager.scenario$.getValue().status).toBe("DONE");
  });

  it("clears both preparations on a hitsound failure and never starts a late counter result", async () => {
    const fixture = scenarioFixture();
    const calculation = deferred();
    const sounds = deferred();
    const started = deferred();
    fixture.performanceTimeline.load.mockReturnValue(calculation.promise);
    fixture.hitSoundEngine.configure.mockImplementation(() => {
      started.resolve();
      return sounds.promise;
    });
    const loading = fixture.manager.loadReplay(fixture.replayId);
    await started.promise;
    sounds.reject(new Error("Hit sound preparation failed"));
    await loading;
    expect(fixture.manager.scenario$.getValue()).toEqual({
      status: "ERROR",
      errorMessage: "Hit sound preparation failed",
    });
    expect(fixture.performanceTimeline.clear).toHaveBeenCalledTimes(2);
    expect(fixture.hitSoundEngine.clear).toHaveBeenCalledTimes(2);
    calculation.resolve();
    await Promise.resolve();
    expect(fixture.sceneManager.changeToScene).not.toHaveBeenCalled();
    expect(fixture.gameLoop.startTicker).not.toHaveBeenCalled();
  });

  it.each([
    { folderName: "2458992 Juztan - #WE _3 YURI" },
    { folderName: "Title #1", audioFile: "audio #2.mp3", backgroundFile: "background #3.png" },
    { folderName: "100% complete %23 %2F %5C", audioFile: "audio%25.mp3", backgroundFile: "bg%20.png" },
    { folderName: "日本語 測試 café 🎵", audioFile: "音楽 + & song.mp3", backgroundFile: "背景, + image.png" },
  ])("loads raw replay/beatmap paths and escaped media for $folderName", async (options) => {
    const fixture = scenarioFixture(options);
    const statuses: string[] = [];
    const subscription = fixture.manager.scenario$.subscribe(({ status }) => statuses.push(status));

    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.manager.scenario$.getValue()).toEqual({ status: "DONE" });
    expect(fixture.onlineBeatmapLookup.lookupResult).not.toHaveBeenCalled();
    expect(statuses).toEqual(["INIT", "LOADING", "DONE"]);
    expect(fixture.replayService.retrieveReplay).toHaveBeenCalledWith(fixture.replayId);
    expect(readFile).toHaveBeenCalledWith(join(fixture.folder, fixture.osuFile));
    expect(readdir).toHaveBeenCalledWith(fixture.folder);
    for (const [loader, filename] of [
      [fixture.audioService.loadAudio, fixture.audioFile],
      [fixture.textureManager.loadTexture, fixture.backgroundFile],
    ] as const) {
      const url = loader.mock.calls[0][0];
      expect(fileURLToPath(url)).toBe(join(fixture.folder, filename));
      expect(new NodeURL(url).hash).toBe("");
      expect(new NodeURL(url).search).toBe("");
    }
    expect(fixture.backgroundSettings.texture$.getValue()).toBe(fixture.background);
    expect(fixture.audioEngine.setSong).toHaveBeenCalledWith(fixture.audio);
    expect(fixture.clock.setDuration).toHaveBeenCalledWith(120_000);
    expect(fixture.simulator.simulateReplay).toHaveBeenCalledTimes(1);
    expect(fixture.hitSoundEngine.configure).toHaveBeenCalledWith(expect.anything(), fixture.folder);
    expect(fixture.gameLoop.startTicker).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
  });

  (process.platform === "win32" ? it : it.skip)("preserves the server/share in Windows UNC media paths", async () => {
    const fixture = scenarioFixture({ songsFolder: "\\\\server\\osu!\\Songs", folderName: "#Title %23" });
    await fixture.manager.loadReplay(fixture.replayId);
    expect(fixture.manager.scenario$.getValue().status).toBe("DONE");
    expect(new NodeURL(fixture.audioService.loadAudio.mock.calls[0][0]).host).toBe("server");
  });

  it("still exposes genuine audio failures as ERROR", async () => {
    const fixture = scenarioFixture();
    fixture.audioService.loadAudio.mockRejectedValue(new Error("Missing audio file"));
    await fixture.manager.loadReplay(fixture.replayId);
    expect(fixture.manager.scenario$.getValue()).toEqual({ status: "ERROR", errorMessage: "Missing audio file" });
    expect(fixture.onlineBeatmapLookup.lookupResult).not.toHaveBeenCalled();
    expect(fixture.gameLoop.startTicker).not.toHaveBeenCalled();
  });

  it("does not resume a cancelled replay after its audio finishes loading", async () => {
    const dispose = jest.spyOn(audioServiceModule, "disposeLoadedAudio");
    const fixture = scenarioFixture();
    let completeAudio!: (audio: { duration: number }) => void;
    let startedAudio!: () => void;
    const audioStarted = new Promise<void>((resolve) => {
      startedAudio = resolve;
    });
    fixture.audioService.loadAudio.mockImplementation(() => {
      startedAudio();
      return new Promise((resolve) => {
        completeAudio = resolve;
      });
    });
    const loading = fixture.manager.loadReplay(fixture.replayId);
    await audioStarted;
    await fixture.manager.clearReplay();
    completeAudio(fixture.audio);
    await loading;
    expect(fixture.manager.scenario$.getValue().status).toBe("INIT");
    expect(fixture.gameLoop.startTicker).not.toHaveBeenCalled();
    expect(fixture.audioEngine.setSong).not.toHaveBeenCalled();
    expect(fixture.audioService.cancelPendingLoads).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledWith(fixture.audio);
    dispose.mockRestore();
  });
});

describe("ScenarioManager missing beatmaps", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not simulate a different map revision at a stale database path", async () => {
    const fixture = scenarioFixture();
    const changed = fixture.rawBlueprint.replace("256,192,1000,", "256,192,2000,");
    (readFile as jest.Mock).mockImplementation(async (_path: string, encoding?: string) =>
      encoding ? changed : Buffer.from(changed),
    );
    fixture.onlineBeatmapLookup.lookupResult.mockResolvedValue({
      status: "FOUND",
      beatmap: { beatmapId: 75, beatmapsetId: 1 },
    });

    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.manager.scenario$.value).toMatchObject({
      status: "ERROR",
      beatmapUrl: "https://osu.ppy.sh/beatmapsets/1#osu/75",
    });
    expect(fixture.simulator.simulateReplay).not.toHaveBeenCalled();
    expect(fixture.audioService.loadAudio).not.toHaveBeenCalled();
    expect(fixture.blueprintLocator.getBlueprintByMD5).toHaveBeenCalledTimes(2);
  });

  it("recovers the exact revision from a fresh lookup after a stale path", async () => {
    const fixture = scenarioFixture();
    const replacement = { ...fixture.blueprintInfo, osuFileName: "original.osu" };
    fixture.blueprintLocator.getBlueprintByMD5
      .mockResolvedValueOnce(fixture.blueprintInfo)
      .mockResolvedValue(replacement);
    (readFile as jest.Mock).mockImplementation(async (file: string, encoding?: string) => {
      const text = file.endsWith("original.osu")
        ? fixture.rawBlueprint
        : fixture.rawBlueprint.replace("256,192,1000,", "256,192,2000,");
      return encoding ? text : Buffer.from(text);
    });

    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.manager.scenario$.value.status).toBe("DONE");
    expect(fixture.simulator.simulateReplay.mock.calls[0][0].hitObjects[0].hitTime).toBe(1000);
    expect(fixture.blueprintLocator.getBlueprintByMD5).toHaveBeenLastCalledWith(fixture.replay.beatmapMd5, true);
    expect(fixture.onlineBeatmapLookup.lookupResult).not.toHaveBeenCalled();
  });

  it("does not revive a cancelled replay while refreshing a stale file mapping", async () => {
    const fixture = scenarioFixture();
    (readFile as jest.Mock).mockResolvedValue(Buffer.from("changed file"));
    let completeRefresh!: (value: typeof fixture.blueprintInfo) => void;
    let startedRefresh!: () => void;
    const refreshStarted = new Promise<void>((done) => {
      startedRefresh = done;
    });
    fixture.blueprintLocator.getBlueprintByMD5.mockImplementation(async (_md5: string, refresh?: boolean) => {
      if (!refresh) return fixture.blueprintInfo;
      startedRefresh();
      return new Promise((done) => {
        completeRefresh = done;
      });
    });
    const loading = fixture.manager.loadReplay(fixture.replayId);
    // Bound this assertion so the pre-fix implementation cannot hang the suite.
    await Promise.race([refreshStarted, loading]);
    expect(completeRefresh).toBeDefined();
    await fixture.manager.clearReplay();
    completeRefresh(fixture.blueprintInfo);
    await loading;
    expect(fixture.manager.scenario$.value.status).toBe("INIT");
    expect(fixture.audioService.loadAudio).not.toHaveBeenCalled();
  });

  it("matches uppercase checksums locally without making an online request", async () => {
    const fixture = scenarioFixture();
    fixture.replayService.retrieveReplay.mockResolvedValue({
      ...fixture.replay,
      beatmapMd5: fixture.replay.beatmapMd5.toUpperCase(),
    });
    fixture.blueprintLocator.getBlueprintByMD5.mockImplementation(async (md5: string) =>
      md5 === fixture.replay.beatmapMd5 ? fixture.blueprintInfo : undefined,
    );

    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.manager.scenario$.getValue()).toEqual({ status: "DONE" });
    expect(fixture.onlineBeatmapLookup.lookupResult).not.toHaveBeenCalled();
  });

  it("resolves a missing beatmap to a friendly message and its exact osu! link", async () => {
    const fixture = scenarioFixture();
    fixture.blueprintLocator.getBlueprintByMD5.mockResolvedValue(undefined);
    fixture.onlineBeatmapLookup.lookupResult.mockResolvedValue({
      status: "FOUND",
      beatmap: { beatmapId: 75, beatmapsetId: 1 },
    });

    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.onlineBeatmapLookup.lookupResult).toHaveBeenCalledTimes(1);
    expect(fixture.onlineBeatmapLookup.lookupResult).toHaveBeenCalledWith(fixture.replay.beatmapMd5);
    expect(fixture.manager.scenario$.getValue()).toEqual({
      status: "ERROR",
      errorMessage: "This beatmap isn't installed. Download and install it from osu!, then open the replay again.",
      beatmapUrl: "https://osu.ppy.sh/beatmapsets/1#osu/75",
    });
    expect(JSON.stringify(fixture.manager.scenario$.getValue())).not.toContain(fixture.replay.beatmapMd5);
    expect(readFile).not.toHaveBeenCalled();
    expect(fixture.audioService.loadAudio).not.toHaveBeenCalled();
    expect(fixture.gameLoop.startTicker).not.toHaveBeenCalled();
  });

  it("shows a simple fallback without a checksum or link when lookup fails", async () => {
    const fixture = scenarioFixture();
    fixture.blueprintLocator.getBlueprintByMD5.mockResolvedValue(undefined);

    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.manager.scenario$.getValue()).toEqual({
      status: "ERROR",
      errorMessage: "Beatmap not found online",
    });
  });

  it("also looks online when osu!.db refers to a removed beatmap file", async () => {
    const fixture = scenarioFixture();
    (readFile as jest.Mock).mockRejectedValue(Object.assign(new Error("File missing"), { code: "ENOENT" }));
    fixture.onlineBeatmapLookup.lookupResult.mockResolvedValue({
      status: "FOUND",
      beatmap: { beatmapId: 75, beatmapsetId: 1 },
    });

    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.onlineBeatmapLookup.lookupResult).toHaveBeenCalledWith(fixture.replay.beatmapMd5);
    expect(fixture.manager.scenario$.getValue().beatmapUrl).toBe("https://osu.ppy.sh/beatmapsets/1#osu/75");
  });

  it("preserves other filesystem errors without requesting an online lookup", async () => {
    const fixture = scenarioFixture();
    (readFile as jest.Mock).mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { code: "EACCES" }));

    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.manager.scenario$.getValue()).toEqual({ status: "ERROR", errorMessage: "Permission denied" });
    expect(fixture.onlineBeatmapLookup.lookupResult).not.toHaveBeenCalled();
  });

  it("loads a newly installed local beatmap without repeating its earlier online lookup", async () => {
    const fixture = scenarioFixture();
    fixture.blueprintLocator.getBlueprintByMD5.mockResolvedValueOnce(undefined);
    fixture.onlineBeatmapLookup.lookupResult.mockResolvedValue({
      status: "FOUND",
      beatmap: { beatmapId: 75, beatmapsetId: 1 },
    });

    await fixture.manager.loadReplay(fixture.replayId);
    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.blueprintLocator.getBlueprintByMD5).toHaveBeenCalledTimes(2);
    expect(fixture.onlineBeatmapLookup.lookupResult).toHaveBeenCalledTimes(1);
    expect(fixture.manager.scenario$.getValue()).toEqual({ status: "DONE" });
  });

  it.each(["close", "another replay"] as const)("ignores a late lookup after %s", async (action) => {
    const fixture = scenarioFixture();
    fixture.blueprintLocator.getBlueprintByMD5.mockResolvedValueOnce(undefined);
    let completeLookup!: (result: BeatmapLookupResult) => void;
    let startedLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      startedLookup = resolve;
    });
    fixture.onlineBeatmapLookup.lookupResult.mockImplementation(() => {
      startedLookup();
      return new Promise((resolve) => {
        completeLookup = resolve;
      });
    });

    const loading = fixture.manager.loadReplay(fixture.replayId);
    await lookupStarted;
    if (action === "close") await fixture.manager.clearReplay();
    else await fixture.manager.loadReplay("another.osr");
    completeLookup({ status: "FOUND", beatmap: { beatmapId: 75, beatmapsetId: 1 } });
    await loading;

    expect(fixture.manager.scenario$.getValue()).toEqual({ status: action === "close" ? "INIT" : "DONE" });
  });
});

describe("ScenarioManager load state", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const settle = async (done: () => boolean) => {
    for (let turn = 0; turn < 100 && !done(); turn += 1) await Promise.resolve();
    expect(done()).toBe(true);
  };
  const playerName = "Tester";

  function recordedFixture(options?: Parameters<typeof scenarioFixture>[0]) {
    const fixture = scenarioFixture(options);
    Object.assign(fixture.replay, { player: playerName });
    const states: ReplayLoadState[] = [];
    fixture.manager.loadState$.subscribe((state) => states.push(state));
    return { ...fixture, states };
  }

  it("starts idle", () => {
    expect(scenarioFixture().manager.loadState$.getValue()).toEqual({ phase: "idle" });
  });

  it("does not let a consumer change the shared idle state", () => {
    expect(Object.isFrozen(scenarioFixture().manager.loadState$.getValue())).toBe(true);
  });

  it("publishes the replay header before the beatmap is looked up", async () => {
    const fixture = recordedFixture();
    fixture.replay.mods = ["HIDDEN", "DOUBLE_TIME"] as never;
    let release!: (info: typeof fixture.blueprintInfo) => void;
    fixture.blueprintLocator.getBlueprintByMD5.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const loading = fixture.manager.loadReplay(fixture.replayId);
    await settle(() => fixture.blueprintLocator.getBlueprintByMD5.mock.calls.length > 0);

    const state = fixture.manager.loadState$.getValue();
    expect(state).toEqual({
      phase: "loading",
      step: "find-beatmap",
      fileName: "Player - #Title %25.osr",
      player: playerName,
      mods: "HDDT",
      ruleset: "Stable",
    });
    expect(state).not.toHaveProperty("map");
    release(fixture.blueprintInfo);
    await loading;
  });

  it("names the Lazer ruleset for a Lazer replay", async () => {
    const fixture = recordedFixture();
    Object.assign(fixture.replay, { lazerMods: [{ acronym: "HD" }] });
    fixture.blueprintLocator.getBlueprintByMD5.mockResolvedValue(undefined);

    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.states.find((state) => state.step === "find-beatmap")).toMatchObject({
      ruleset: "Lazer",
      mods: "HD",
    });
  });

  it("publishes the map and its background once found", async () => {
    const fixture = recordedFixture();
    const audio = deferred();
    fixture.audioService.loadAudio.mockImplementationOnce(async () => {
      await audio.promise;
      return fixture.audio;
    });

    const loading = fixture.manager.loadReplay(fixture.replayId);
    await settle(() => fixture.audioService.loadAudio.mock.calls.length > 0);

    expect(fixture.manager.loadState$.getValue()).toEqual({
      phase: "loading",
      step: "simulate",
      fileName: "Player - #Title %25.osr",
      player: playerName,
      mods: "NM",
      ruleset: "Stable",
      map: { artist: "Artist", title: "#Title %23", difficulty: "Difficulty", mapper: "Mapper" },
      backgroundUrl: pathToFileURL(join(fixture.folder, fixture.backgroundFile)).href,
    });
    audio.resolve();
    await loading;
  });

  it("ends ready", async () => {
    const fixture = recordedFixture();
    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.manager.loadState$.getValue()).toEqual({ phase: "ready" });
    expect(fixture.manager.scenario$.getValue()).toEqual({ status: "DONE" });
    expect(fixture.states.map((state) => [state.phase, state.step])).toEqual([
      ["idle", undefined],
      ["loading", "read-replay"],
      ["loading", "find-beatmap"],
      ["loading", "simulate"],
      ["ready", undefined],
    ]);
    expect(fixture.states[1]).toEqual({ phase: "loading", step: "read-replay", fileName: "Player - #Title %25.osr" });
  });

  it.each([
    { name: "found", result: { status: "FOUND", beatmap: { beatmapId: 75, beatmapsetId: 1 } }, lookup: "found" },
    { name: "not found", result: { status: "NOT_FOUND" }, lookup: "not-found" },
    { name: "unavailable", result: { status: "UNAVAILABLE" }, lookup: "unavailable" },
  ] as const)("reports a missing beatmap whose lookup was $name", async ({ result, lookup }) => {
    const fixture = recordedFixture();
    fixture.blueprintLocator.getBlueprintByMD5.mockResolvedValue(undefined);
    fixture.onlineBeatmapLookup.lookupResult.mockResolvedValue(result as BeatmapLookupResult);

    await fixture.manager.loadReplay(fixture.replayId);

    const state = fixture.manager.loadState$.getValue();
    expect(state).toEqual({
      phase: "failed",
      fileName: "Player - #Title %25.osr",
      player: playerName,
      mods: "NM",
      ruleset: "Stable",
      failure:
        lookup === "found"
          ? { kind: "beatmap-not-found", lookup, beatmapUrl: "https://osu.ppy.sh/beatmapsets/1#osu/75" }
          : { kind: "beatmap-not-found", lookup },
    });
    expect(state).not.toHaveProperty("step");
    if (lookup !== "found") expect(state.failure).not.toHaveProperty("beatmapUrl");
    expect(fixture.manager.scenario$.getValue().status).toBe("ERROR");
  });

  it("keeps the map when a later step fails", async () => {
    const fixture = recordedFixture();
    fixture.audioService.loadAudio.mockRejectedValue(new Error("Missing audio file"));

    await fixture.manager.loadReplay(fixture.replayId);

    const state = fixture.manager.loadState$.getValue();
    expect(state).toMatchObject({
      phase: "failed",
      fileName: "Player - #Title %25.osr",
      player: playerName,
      map: { title: "#Title %23", artist: "Artist", difficulty: "Difficulty", mapper: "Mapper" },
      backgroundUrl: pathToFileURL(join(fixture.folder, fixture.backgroundFile)).href,
      failure: { kind: "other", message: "Missing audio file" },
    });
    expect(state).not.toHaveProperty("step");
    expect(fixture.manager.scenario$.getValue()).toEqual({ status: "ERROR", errorMessage: "Missing audio file" });
  });

  it("fails with only the file name when the replay cannot be read", async () => {
    const fixture = recordedFixture();
    fixture.replayService.retrieveReplay.mockRejectedValueOnce(new Error("Replay is unavailable"));

    await fixture.manager.loadReplay(fixture.replayId);

    expect(fixture.manager.loadState$.getValue()).toEqual({
      phase: "failed",
      fileName: "Player - #Title %25.osr",
      failure: { kind: "other", message: "Replay is unavailable" },
    });
  });

  it("omits the background when the map has none", async () => {
    const fixture = recordedFixture({ backgroundFile: "" });
    const audio = deferred();
    fixture.audioService.loadAudio.mockImplementationOnce(async () => {
      await audio.promise;
      return fixture.audio;
    });

    const loading = fixture.manager.loadReplay(fixture.replayId);
    await settle(() => fixture.audioService.loadAudio.mock.calls.length > 0);

    const state = fixture.manager.loadState$.getValue();
    expect(state).toMatchObject({ phase: "loading", step: "simulate", map: { title: "#Title %23" } });
    expect(state).not.toHaveProperty("backgroundUrl");
    // The texture request itself is unchanged.
    expect(fixture.textureManager.loadTexture).toHaveBeenCalledTimes(1);
    audio.resolve();
    await loading;
    expect(fixture.manager.loadState$.getValue()).toEqual({ phase: "ready" });
  });

  describe("a superseded load", () => {
    const markersOfA = ['"fileName":"Player - #Title %25.osr"', '"player":"PlayerA"', '"mods":"DT"', "#Title %23"];

    /** Replay A and replay B differ in file name, player, mods and map, so a leaked value is recognisable. */
    function supersededFixture() {
      const fixture = recordedFixture();
      const replayA = { ...fixture.replay, player: "PlayerA", mods: ["DOUBLE_TIME"] };
      const rawB = fixture.rawBlueprint.replace("Title: #Title %23", "Title: Other Title");
      const replayB = {
        ...fixture.replay,
        player: "PlayerB",
        mods: ["HIDDEN"],
        beatmapMd5: createHash("md5").update(rawB).digest("hex"),
      };
      const scenarioStatuses: string[] = [];
      fixture.manager.scenario$.subscribe(({ status }) => scenarioStatuses.push(status));
      /** Runs replay B to completion while A is held and returns where B's emissions begin. */
      const runB = async () => {
        fixture.replayService.retrieveReplay.mockResolvedValueOnce(replayB);
        (readFile as jest.Mock).mockImplementationOnce(async (_path: string, encoding?: string) =>
          encoding ? rawB : Buffer.from(rawB),
        );
        const from = fixture.states.length;
        await fixture.manager.loadReplay(join(resolve("path-url-fixture", "Replays"), "B.osr"));
        return from;
      };
      const expectOnlyB = (from: number) => {
        const emitted = fixture.states.slice(from);
        expect(emitted[0]).toStrictEqual({ phase: "loading", step: "read-replay", fileName: "B.osr" });
        for (const state of emitted) {
          const text = JSON.stringify(state);
          for (const marker of markersOfA) expect(text).not.toContain(marker);
          if (state.phase !== "ready") expect(state.fileName).toBe("B.osr");
          if (state.player !== undefined) expect(state.player).toBe("PlayerB");
          if (state.mods !== undefined) expect(state.mods).toBe("HD");
          if (state.map !== undefined) expect(state.map.title).toBe("Other Title");
        }
        expect(emitted[emitted.length - 1]).toStrictEqual({ phase: "ready" });
        expect(fixture.manager.loadState$.getValue()).toStrictEqual({ phase: "ready" });
      };
      return { ...fixture, replayA, runB, expectOnlyB, scenarioStatuses };
    }

    it("never shows its file name, player, mods, map or steps once the newer replay started", async () => {
      const fixture = supersededFixture();
      const heldAudio = deferred();
      fixture.replayService.retrieveReplay.mockResolvedValueOnce(fixture.replayA);
      fixture.audioService.loadAudio.mockImplementationOnce(async () => {
        await heldAudio.promise;
        return fixture.audio;
      });
      const first = fixture.manager.loadReplay(fixture.replayId);
      await settle(() => fixture.audioService.loadAudio.mock.calls.length > 0);
      expect(fixture.manager.loadState$.getValue()).toMatchObject({ player: "PlayerA", mods: "DT" });

      const from = await fixture.runB();
      const settled = fixture.states.length;
      const scenarioCount = fixture.scenarioStatuses.length;
      heldAudio.resolve();
      await first;

      fixture.expectOnlyB(from);
      expect(fixture.states).toHaveLength(settled);
      expect(fixture.scenarioStatuses).toHaveLength(scenarioCount);
    });

    it("publishes no failure when it rejects after the newer replay finished", async () => {
      const fixture = supersededFixture();
      const heldAudio = deferred();
      fixture.replayService.retrieveReplay.mockResolvedValueOnce(fixture.replayA);
      fixture.audioService.loadAudio.mockImplementationOnce(async () => {
        await heldAudio.promise;
        return fixture.audio;
      });
      const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
      const first = fixture.manager.loadReplay(fixture.replayId);
      await settle(() => fixture.audioService.loadAudio.mock.calls.length > 0);

      const from = await fixture.runB();
      const settled = fixture.states.length;
      heldAudio.reject(new Error("Late audio failure"));
      await first;
      error.mockRestore();

      fixture.expectOnlyB(from);
      expect(fixture.states).toHaveLength(settled);
      expect(fixture.states.some((state) => state.phase === "failed")).toBe(false);
      expect(fixture.scenarioStatuses).not.toContain("ERROR");
      expect(fixture.manager.scenario$.getValue()).toEqual({ status: "DONE" });
    });

    it("publishes nothing when its online lookup resolves late", async () => {
      const fixture = supersededFixture();
      let completeLookup!: (result: BeatmapLookupResult) => void;
      fixture.replayService.retrieveReplay.mockResolvedValueOnce(fixture.replayA);
      fixture.blueprintLocator.getBlueprintByMD5.mockResolvedValueOnce(undefined);
      fixture.onlineBeatmapLookup.lookupResult.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeLookup = resolve;
          }),
      );
      const first = fixture.manager.loadReplay(fixture.replayId);
      await settle(() => fixture.onlineBeatmapLookup.lookupResult.mock.calls.length > 0);
      expect(fixture.manager.loadState$.getValue()).toMatchObject({ step: "find-beatmap", player: "PlayerA" });

      const from = await fixture.runB();
      const settled = fixture.states.length;
      const scenarioCount = fixture.scenarioStatuses.length;
      completeLookup({ status: "FOUND", beatmap: { beatmapId: 75, beatmapsetId: 1 } });
      await first;

      fixture.expectOnlyB(from);
      expect(fixture.states).toHaveLength(settled);
      expect(fixture.states.some((state) => state.phase === "failed")).toBe(false);
      expect(fixture.scenarioStatuses).toHaveLength(scenarioCount);
      expect(fixture.manager.scenario$.getValue()).toEqual({ status: "DONE" });
    });

    it("never shows its header when it was superseded while its replay file was being read", async () => {
      const fixture = supersededFixture();
      let releaseA!: (replay: typeof fixture.replayA) => void;
      fixture.replayService.retrieveReplay.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseA = resolve;
          }),
      );
      const first = fixture.manager.loadReplay(fixture.replayId);
      await settle(() => fixture.replayService.retrieveReplay.mock.calls.length > 0);
      expect(fixture.manager.loadState$.getValue()).toStrictEqual({
        phase: "loading",
        step: "read-replay",
        fileName: "Player - #Title %25.osr",
      });

      const from = await fixture.runB();
      const settled = fixture.states.length;
      const scenarioCount = fixture.scenarioStatuses.length;
      releaseA(fixture.replayA);
      await first;

      fixture.expectOnlyB(from);
      expect(fixture.states).toHaveLength(settled);
      expect(fixture.scenarioStatuses).toHaveLength(scenarioCount);
    });
  });

  it("returns to idle when the replay is cleared", async () => {
    const fixture = recordedFixture();
    await fixture.manager.loadReplay(fixture.replayId);

    await fixture.manager.clearReplay();

    expect(fixture.manager.loadState$.getValue()).toEqual({ phase: "idle" });
    expect(fixture.manager.scenario$.getValue()).toEqual({ status: "INIT" });
  });

  it("returns to idle when the replay is cleared during loading", async () => {
    const fixture = recordedFixture();
    const heldAudio = deferred();
    fixture.audioService.loadAudio.mockImplementationOnce(async () => {
      await heldAudio.promise;
      return fixture.audio;
    });
    const loading = fixture.manager.loadReplay(fixture.replayId);
    await settle(() => fixture.audioService.loadAudio.mock.calls.length > 0);

    await fixture.manager.clearReplay();
    heldAudio.resolve();
    await loading;

    expect(fixture.manager.loadState$.getValue()).toEqual({ phase: "idle" });
  });
});
