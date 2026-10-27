import { AnalysisApp } from "./AnalysisApp";
import { GameLoop } from "../common/game/GameLoop";
import { BehaviorSubject } from "rxjs";
import { GameplayClock } from "../common/game/GameplayClock";
import { ViewerLifecycleObserver } from "../common/ViewerLifecycleObserver";

jest.mock("../manager/ScenarioManager", () => ({ ScenarioManager: class ScenarioManager {} }));

function createAnalysisApp(status: "DONE" | "INIT" | "LOADING" | "ERROR") {
  const gameClock = { pause: jest.fn() };
  const gameLoop = { startTicker: jest.fn(), stopTicker: jest.fn() };
  const pixiRenderer = { initializeRenderer: jest.fn(), destroy: jest.fn() };
  const clipRecorder = { cancel: jest.fn().mockResolvedValue(undefined) };
  const scenarioManager = { scenario$: { getValue: () => ({ status }) } };
  const app = Object.assign(Object.create(AnalysisApp.prototype), {
    gameClock,
    gameLoop,
    pixiRenderer,
    scenarioManager,
    clipRecorder,
  }) as AnalysisApp;

  return { app, gameClock, gameLoop, pixiRenderer, clipRecorder };
}

describe("AnalysisApp render lifecycle", () => {
  it("records nonzero paused transport and rejects capture-owned navigation without reconstructing", () => {
    const f = createAnalysisApp("DONE"), clock = new GameplayClock(), renderer = {};
    clock.setDuration(120000); clock.seekTo(30000); clock.setSpeed(1.25);
    const events: Array<{ kind: string; fields: Readonly<Record<string, unknown>> }> = [];
    const lifecycle = new ViewerLifecycleObserver({ id: () => 1,
      record: (kind, _owner, fields) => events.push({ kind, fields }), count: () => undefined, invalidate: () => undefined });
    Object.assign(f.app, { lifecycle, gameClock: clock,
      gameSimulator: { getPrimaryReplay: () => ({ replayContentSha256: "a".repeat(64) }), getRulesetFocus: () => "stable" },
      scenarioManager: { loadState$: new BehaviorSubject({ phase: "ready" }), scenario$: new BehaviorSubject({ status: "DONE" }) },
    });
    Object.assign(f.pixiRenderer, { getRenderer: () => renderer });
    expect(f.app.setViewerVisible(false)).toBe(true);
    expect(f.app.setViewerVisible(true)).toBe(true);
    Object.assign(f.clipRecorder, { isBusy: true });
    expect(f.app.setViewerVisible(false)).toBe(false);
    expect(f.app.isViewerVisible()).toBe(true);
    expect(events.filter(event => event.kind === "viewer-visibility-accepted").map(event => event.fields)).toEqual([
      expect.objectContaining({ elapsedMs: 30000, speed: 1.25, playbackRate: 1.25, playing: false, visible: false }),
      expect.objectContaining({ elapsedMs: 30000, speed: 1.25, playbackRate: 1.25, playing: false, visible: true }),
    ]);
    expect(events.filter(event => event.kind === "viewer-visibility-rejected")).toHaveLength(1);
    expect(f.pixiRenderer.initializeRenderer).not.toHaveBeenCalled();
    expect(f.pixiRenderer.destroy).not.toHaveBeenCalled();
  });
  it("hides a mounted viewer without cancelling exports or destroying resources, then restores its ticker", () => {
    const f=createAnalysisApp("DONE");f.app.setViewerVisible(false);
    expect(f.app.isViewerVisible()).toBe(false);expect(f.gameClock.pause).toHaveBeenCalledTimes(1);expect(f.gameLoop.stopTicker).toHaveBeenCalledTimes(1);
    expect(f.pixiRenderer.destroy).not.toHaveBeenCalled();expect(f.clipRecorder.cancel).not.toHaveBeenCalled();
    f.app.setViewerVisible(true);expect(f.gameLoop.startTicker).toHaveBeenCalledTimes(1);expect(f.pixiRenderer.initializeRenderer).not.toHaveBeenCalled();
  });
  it("initializes one export transport guard across repeated mounts", async () => {
    const state$ = new BehaviorSubject({ status: "idle" });
    const recorder = {
      state$,
      get isBusy() {
        return state$.value.status === "recording";
      },
      cancel: jest.fn().mockResolvedValue(undefined),
      setReadoutSource: jest.fn(),
    };
    const scenario = { initialize: jest.fn(), setBeforeReplayChange: jest.fn() };
    const watcher = { startWatching: jest.fn() };
    const clock = { controlsLocked: false };
    const app = Object.assign(Object.create(AnalysisApp.prototype), {
      clipRecorder: recorder,
      scenarioManager: scenario,
      replayWatcher: watcher,
      gameClock: clock,
    }) as AnalysisApp;
    app.initialize();
    app.initialize();
    expect(scenario.initialize).toHaveBeenCalledTimes(1);
    expect(watcher.startWatching).toHaveBeenCalledTimes(1);
    state$.next({ status: "recording" });
    expect(clock.controlsLocked).toBe(true);
    state$.next({ status: "done" });
    expect(clock.controlsLocked).toBe(false);
    await scenario.setBeforeReplayChange.mock.calls[0][0]();
    expect(recorder.cancel).toHaveBeenCalledTimes(1);
  });

  it("restarts rendering on enter only when a scenario is ready", () => {
    const ready = createAnalysisApp("DONE");
    const loading = createAnalysisApp("LOADING");
    const canvas = document.createElement("canvas");

    ready.app.onEnter(canvas);
    loading.app.onEnter(canvas);

    expect(ready.pixiRenderer.initializeRenderer).toHaveBeenCalledWith(canvas);
    expect(ready.gameLoop.startTicker).toHaveBeenCalledTimes(1);
    expect(loading.pixiRenderer.initializeRenderer).toHaveBeenCalledWith(canvas);
    expect(loading.gameLoop.startTicker).not.toHaveBeenCalled();
  });

  it("stops rendering before releasing a hidden view", () => {
    const { app, gameClock, gameLoop, pixiRenderer, clipRecorder } = createAnalysisApp("DONE");

    app.onHide();

    expect(clipRecorder.cancel).toHaveBeenCalledWith({ restorePlayback: false });
    expect(gameClock.pause).toHaveBeenCalledTimes(1);
    expect(gameLoop.stopTicker).toHaveBeenCalledTimes(1);
    expect(pixiRenderer.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("GameLoop render ownership", () => {
  it("does not start a headless ticker when replay loading finishes after hide", () => {
    const start = jest.fn();
    const loop = Object.assign(Object.create(GameLoop.prototype), {
      ticker: { start },
      pixiRendererService: { getRenderer: () => undefined },
    }) as GameLoop;

    loop.startTicker();

    expect(start).not.toHaveBeenCalled();
  });
});
