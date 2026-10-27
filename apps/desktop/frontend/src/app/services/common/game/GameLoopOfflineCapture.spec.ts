import { Container } from "pixi.js";
import { Subject } from "rxjs";
import { AnalysisScene } from "../../analysis/scenes/AnalysisScene";
import { SceneManager } from "../scenes/SceneManager";
import { GameplayClock } from "./GameplayClock";
import { GameLoop } from "./GameLoop";

function setup(started = true) {
  const clock = new GameplayClock();
  clock.setDuration(100_000);
  const order: string[] = [];
  const stage = new Container();
  const child = new Container();
  child.position.x = 2;
  stage.addChild(child);
  const simulate = jest.fn((time: number) => order.push(`simulate:${time}`));
  const updateAnalysisStage = jest.fn(() => {
    stage.position.x = clock.timeElapsedInMs;
    order.push("stage");
  });
  const sceneManager = new SceneManager();
  sceneManager.add(
    new AnalysisScene(
      clock,
      { simulate } as never,
      { stage, updateAnalysisStage } as never,
      { update: () => order.push("audio") } as never,
      { cueTime: () => clock.timeElapsedInMs } as never,
    ),
    "analysis",
  );
  sceneManager.managedScene[0].state = "PLAYING";
  const update = jest.spyOn(sceneManager, "update");
  const ticker = {
    started,
    start: jest.fn(() => {
      ticker.started = true;
    }),
    stop: jest.fn(() => {
      ticker.started = false;
    }),
  };
  const render = jest.fn((root: Container) => {
    const parent = root.enableTempParent();
    root.updateTransform();
    root.disableTempParent(parent);
    order.push("render");
  });
  const renderer = { render };
  const getRenderer = jest.fn(() => renderer);
  const monitor = { begin: jest.fn(), end: jest.fn() };
  const resize = jest.fn();
  const loop = Object.assign(Object.create(GameLoop.prototype), {
    gameClock: clock,
    sceneManager,
    ticker,
    frameRendered$: new Subject<void>(),
    pixiRendererService: { getRenderer, resizeCanvasToDisplaySize: resize },
    performanceMonitor: monitor,
  }) as GameLoop;
  const captured = jest.fn(() => {
    order.push("capture");
    return { time: clock.timeElapsedInMs, x: child.worldTransform.tx };
  });
  loop.frameRendered$.subscribe(captured);
  const failure = jest.fn();
  return {
    loop,
    clock,
    ticker,
    getRenderer,
    renderer,
    render,
    simulate,
    update,
    monitor,
    captured,
    failure,
    order,
    resize,
    child,
  };
}

describe("GameLoop deterministic offline frames", () => {
  afterEach(() => jest.restoreAllMocks());

  it("draws directly with current world transforms without presenting or resizing each output frame", () => {
    const { loop, child, render, captured, resize, update, failure, ticker } = setup();
    const positions: number[] = [];
    const capture = loop.beginOfflineCapture(failure, () => positions.push(child.worldTransform.tx));
    capture.renderFrame(55000, 0);
    capture.renderFrame(55010, 10);
    expect(positions).toEqual([55002, 55012]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(render).not.toHaveBeenCalled();
    expect(captured).not.toHaveBeenCalled();
    expect(resize).toHaveBeenCalledTimes(1);
    capture.dispose();
    expect(ticker.start).toHaveBeenCalledTimes(1);
  });

  it("releases the offline clock and ticker after a direct target draw throws", () => {
    const { loop, clock, render, failure, ticker } = setup();
    const capture = loop.beginOfflineCapture(failure, () => {
      throw new Error("target failure");
    });
    expect(() => capture.renderFrame(55000, 0)).toThrow("target failure");
    expect(failure).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    expect(ticker.start).toHaveBeenCalledTimes(1);
    clock.seekTo(1234);
  });

  it("updates the real analysis scene at the supplied time and transforms it before publishing the frame", () => {
    const { loop, clock, ticker, order, captured, update, failure } = setup();
    const audioTime = jest.fn(() => 90_000);
    clock.setTimeSource(audioTime);
    const seek = jest.fn();
    clock.seeked$.subscribe(seek);
    const capture = loop.beginOfflineCapture(failure);
    expect(ticker.started).toBe(false);
    loop.tickHandler(123);
    expect(update).not.toHaveBeenCalled();
    const time = 55_000 + 1000 / 144;
    capture.renderFrame(time, 1000 / 144);
    expect(update).toHaveBeenCalledWith(1000 / 144);
    expect(order).toEqual([`simulate:${time}`, "audio", "stage", "render", "capture"]);
    expect(captured.mock.results[0].value).toEqual({ time, x: time + 2 });
    expect(audioTime).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
    capture.dispose();
    expect(ticker.start).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
  });

  it.each([30, 60, 120, 144, 240])("renders exact %s FPS timestamps despite arbitrary encoder stalls", (fps) => {
    const { loop, clock, captured, failure } = setup();
    let now = 0;
    jest.spyOn(performance, "now").mockImplementation(() => now);
    clock.setBaseRate(1.5);
    const capture = loop.beginOfflineCapture(failure);
    const inPoint = 55_000;
    const outPoint = 55_500;
    const step = (1000 / fps) * clock.playbackRate;
    const count = Math.ceil((outPoint - inPoint) / step);
    for (let index = 0; index < count; index++) {
      now += index % 2 ? 17 : 987;
      const timestamp = inPoint + index * step;
      capture.renderFrame(timestamp, index === 0 ? 0 : 1000 / fps);
      expect(captured.mock.results[index].value.time).toBe(timestamp);
      expect(timestamp).toBeLessThan(outPoint);
    }
    expect(captured).toHaveBeenCalledTimes(count);
    expect(clock.isPlaying).toBe(false);
    capture.dispose();
    expect(failure).not.toHaveBeenCalled();
  });

  it("restores an originally running ticker once, and preserves a stopped ticker unless explicitly started", () => {
    for (const started of [true, false]) {
      const { loop, ticker, failure } = setup(started);
      const capture = loop.beginOfflineCapture(failure);
      capture.dispose();
      capture.dispose();
      expect(ticker.start).toHaveBeenCalledTimes(started ? 1 : 0);
      loop.tickHandler(1);
      expect(failure).not.toHaveBeenCalled();
    }
    const { loop, ticker, failure } = setup(false);
    const capture = loop.beginOfflineCapture(failure);
    loop.startTicker();
    expect(ticker.start).not.toHaveBeenCalled();
    capture.dispose();
    expect(ticker.start).toHaveBeenCalledTimes(1);
  });

  it("invalidates a stopped view immediately without resuming it or permitting a stale owner to render", () => {
    const { loop, clock, ticker, captured, failure } = setup();
    const capture = loop.beginOfflineCapture(failure);
    loop.stopTicker();
    capture.dispose();
    expect(() => capture.renderFrame(55_000, 0)).toThrow("no longer active");
    expect(captured).not.toHaveBeenCalled();
    expect(ticker.start).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: "The replay view stopped during export" }));
    clock.seekTo(1234);
    const next = loop.beginOfflineCapture(jest.fn());
    capture.dispose();
    expect(() => loop.beginOfflineCapture(jest.fn())).toThrow("already active");
    next.renderFrame(4567, 0);
    next.dispose();
  });

  it.each(["missing", "replaced"])("rejects a %s renderer and does not resume the old view", (state) => {
    const { loop, getRenderer, ticker, render, failure } = setup();
    const capture = loop.beginOfflineCapture(failure);
    getRenderer.mockReturnValue(state === "missing" ? (undefined as never) : { render: jest.fn() });
    expect(() => capture.renderFrame(55_000, 0)).toThrow("unavailable");
    expect(render).not.toHaveBeenCalled();
    expect(ticker.start).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledTimes(1);
    capture.dispose();
  });

  it("reports a failed update once, balances monitoring, releases clock ownership and restores RAF", () => {
    const { loop, clock, update, ticker, monitor, render, failure } = setup();
    update.mockImplementation(() => {
      throw new Error("Scene update failed");
    });
    const capture = loop.beginOfflineCapture(failure);
    expect(() => capture.renderFrame(55_000, 0)).toThrow("Scene update failed");
    expect(() => capture.renderFrame(55_000, 0)).toThrow("no longer active");
    expect(render).not.toHaveBeenCalled();
    expect(monitor.begin).toHaveBeenCalledTimes(1);
    expect(monitor.end).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(ticker.start).toHaveBeenCalledTimes(1);
    clock.seekTo(1234);
  });

  it("does not publish a partially updated frame if the view stops inside the scene update", () => {
    const { loop, update, render, captured, ticker, failure } = setup();
    update.mockImplementation(() => loop.stopTicker());
    const capture = loop.beginOfflineCapture(failure);
    expect(() => capture.renderFrame(55_000, 0)).toThrow("no longer active");
    expect(render).not.toHaveBeenCalled();
    expect(captured).not.toHaveBeenCalled();
    expect(ticker.start).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it("blocks normal ticks and new captures from frame observers, even during disposal", () => {
    const { loop, update, failure } = setup();
    const capture = loop.beginOfflineCapture(failure);
    const observer = loop.frameRendered$.subscribe(() => {
      loop.tickHandler(100);
      capture.dispose();
      loop.tickHandler(100);
      expect(() => loop.beginOfflineCapture(jest.fn())).toThrow("already active");
    });
    expect(() => capture.renderFrame(55_000, 0)).toThrow("no longer active");
    expect(update).toHaveBeenCalledTimes(1);
    observer.unsubscribe();
    loop.tickHandler(1);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("rejects a recursive offline render without changing the timestamp or emitting another frame", () => {
    const { loop, clock, captured, failure } = setup();
    const capture = loop.beginOfflineCapture(failure);
    loop.frameRendered$.subscribe(() => {
      expect(() => capture.renderFrame(60_000, 0)).toThrow("already being rendered");
    });
    expect(() => capture.renderFrame(55_000, 0)).toThrow("no longer active");
    expect(clock.timeElapsedInMs).toBe(55_000);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it.each([
    [NaN, 0],
    [-1, 0],
    [100_001, 0],
    [55_000, -1],
    [55_000, Infinity],
  ])("fails invalid time/delta %s/%s without simulating or capturing", (time, delta) => {
    const { loop, update, captured, failure } = setup();
    const capture = loop.beginOfflineCapture(failure);
    expect(() => capture.renderFrame(time, delta)).toThrow("Invalid");
    expect(update).not.toHaveBeenCalled();
    expect(captured).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledTimes(1);
  });
});
