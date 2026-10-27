module.exports = async function clipAudioPass(workspace, output) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  const workspaceRequire = require("node:module").createRequire(path.join(workspace, "package.json"));
  workspaceRequire("reflect-metadata");
  const ts = workspaceRequire("typescript");
  const PIXI = workspaceRequire("pixi.js");
  const { BehaviorSubject, Subject } = workspaceRequire("rxjs");
  const base = path.join(workspace, "apps/desktop/frontend/src/app");
  const files = new Map();
  const chunks = new Map();
  files.set(path.join(base, "api.ts"), {
    exports: {
      frontendAPI: {
        appendClipExport: async (id, _sequence, data) => chunks.get(id).push(Buffer.from(data)),
      },
    },
  });
  function sourceModule(filename) {
    filename = path.resolve(filename);
    if (!path.extname(filename))
      filename = fs.existsSync(filename + ".ts") ? filename + ".ts" : path.join(filename, "index.ts");
    if (files.has(filename)) return files.get(filename).exports;
    const module = { exports: {} };
    files.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true,
        emitDecoratorMetadata: false,
      },
    }).outputText;
    const localRequire = (name) =>
      name.startsWith(".") ? sourceModule(path.resolve(path.dirname(filename), name)) : workspaceRequire(name);
    new Function("require", "module", "exports", code)(localRequire, module, module.exports);
    return module.exports;
  }
  const { GameplayClock } = sourceModule(path.join(base, "services/common/game/GameplayClock.ts"));
  const { GameLoop } = sourceModule(path.join(base, "services/common/game/GameLoop.ts"));
  const { SceneManager } = sourceModule(path.join(base, "services/common/scenes/SceneManager.ts"));
  const { AnalysisScene } = sourceModule(path.join(base, "services/analysis/scenes/AnalysisScene.ts"));
  const { AudioEngine } = sourceModule(path.join(base, "services/common/audio/AudioEngine.ts"));
  const { AudioService } = sourceModule(path.join(base, "services/common/audio/AudioService.ts"));
  const { ClipRecorder } = sourceModule(path.join(base, "services/manager/ClipRecorder.ts"));
  const recordings = [];
  for (const option of [
    { name: "nm", base: 1, speed: 1 },
    { name: "dt", base: 1.5, speed: 1 },
    { name: "ht", base: 0.75, speed: 1 },
    { name: "dt-custom", base: 1.5, speed: 0.75 },
    { name: "delayed-play", base: 1, speed: 1, injectedDelayMs: 250 },
    { name: "interior-stall", base: 1, speed: 1, injectedStall: { atMs: 900, durationMs: 250 } },
  ]) {
    const context = new AudioContext({ sampleRate: 48_000 });
    const clock = new GameplayClock();
    clock.setDuration(5000);
    clock.setBaseRate(option.base);
    clock.setSpeed(option.speed);
    const settings = { settings$: new BehaviorSubject({ muted: false, volume: { master: 1, music: 1, effects: 1 } }) };
    const engine = new AudioEngine(settings, context, clock);
    engine.postConstruct();
    // Exercise the capture output without sending synthetic pulses to the physical speakers.
    engine.masterGain.disconnect(context.destination);
    const service = new AudioService(context);
    const song = await service.loadAudio(pathToFileURL(path.join(output, "source.wav")).href);
    const events = [];
    const startedAt = performance.now();
    for (const name of ["play", "playing", "waiting", "stalled", "seeked", "pause"]) {
      song.addEventListener(name, () =>
        events.push({ name, atMs: performance.now() - startedAt, mediaTime: song.currentTime }),
      );
    }
    engine.setSong(song);
    const frame = new Subject();
    let frameCount = 0;
    let recordStartContext;
    let recordStartWall;
    const frameSamples = [];
    frame.subscribe(() => {
      frameCount++;
      if (recordStartContext !== undefined)
        frameSamples.push({
          mapMs: clock.timeElapsedInMs,
          mediaMs: song.currentTime * 1000,
          graphSeconds: context.currentTime - recordStartContext,
          wallSeconds: (performance.now() - recordStartWall) / 1000,
        });
    });
    const sceneManager = new SceneManager();
    sceneManager.add(
      new AnalysisScene(
        clock,
        { simulate: () => undefined },
        { stage: new PIXI.Container(), updateAnalysisStage: () => undefined },
        { update: () => undefined },
        engine,
      ),
      "analysis",
    );
    sceneManager.managedScene[0].state = "PLAYING";
    const renderer = { render: () => undefined };
    const loop = Object.assign(Object.create(GameLoop.prototype), {
      gameClock: clock,
      sceneManager,
      ticker: new PIXI.Ticker(),
      frameRendered$: frame,
      performanceMonitor: { begin() {}, end() {} },
      pixiRendererService: { getRenderer: () => renderer, resizeCanvasToDisplaySize() {} },
    });
    loop.initializeTicker();
    loop.startTicker();
    const recorder = Object.assign(Object.create(ClipRecorder.prototype), {
      clock,
      gameLoop: loop,
      state$: new BehaviorSubject({ status: "idle", progress: 0 }),
    });
    const options = { startMs: 1000, endMs: 4000, fps: 60, audio: true, speed: option.speed };
    clock.setPlaybackBoundary(options.endMs);
    clock.seekTo(options.startMs);
    const capture = engine.beginCapture(true);
    clock.seekTo(options.startMs);
    const controller = new AbortController();
    let writer;
    const timers = [];
    try {
      await engine.prepareCapture(controller.signal);
      chunks.set(option.name, []);
      const beforeRecord = performance.now() - startedAt;
      const originalPlay = song.play.bind(song);
      if (option.injectedDelayMs)
        song.play = () =>
          new Promise((resolve) => {
            timers.push(setTimeout(resolve, option.injectedDelayMs));
          }).then(originalPlay);
      if (option.injectedStall)
        timers.push(
          setTimeout(() => {
            song.pause();
            timers.push(
              setTimeout(() => {
                void originalPlay();
              }, option.injectedStall.durationMs),
            );
          }, option.injectedStall.atMs),
        );
      recordStartContext = context.currentTime;
      recordStartWall = performance.now();
      await recorder.recordAudio(
        capture.stream,
        options,
        controller.signal,
        option.name,
        () => undefined,
        (value) => {
          writer = value;
        },
      );
      await writer.flush();
      const file = path.join(output, `${option.name}.webm`);
      fs.writeFileSync(file, Buffer.concat(chunks.get(option.name)));
      recordings.push({
        ...option,
        rate: option.base * option.speed,
        path: file,
        beforeRecordMs: beforeRecord,
        completedMs: performance.now() - startedAt,
        selectedDuration: 3 / (option.base * option.speed),
        finalClockMs: clock.timeElapsedInMs,
        contextSampleRate: context.sampleRate,
        recordStartContext,
        frameSamples,
        events,
      });
    } catch (error) {
      const failure = {
        error: String(error),
        frameCount,
        clock: clock.timeElapsedInMs,
        contextState: context.state,
        contextTime: context.currentTime,
        mediaTime: song.currentTime,
        paused: song.paused,
        readyState: song.readyState,
        events,
      };
      fs.writeFileSync(path.join(output, `${option.name}-failure.json`), JSON.stringify(failure, null, 2));
      if ((option.injectedDelayMs || option.injectedStall) && String(error).includes("Audio playback lost sync")) {
        await writer?.flush();
        const file = path.join(output, `${option.name}-rejected.webm`);
        fs.writeFileSync(file, Buffer.concat(chunks.get(option.name)));
        recordings.push({
          ...option,
          rate: option.base * option.speed,
          path: file,
          rejected: true,
          rejection: failure,
          frameSamples,
          recordStartContext,
        });
      } else throw error;
    } finally {
      timers.forEach(clearTimeout);
      loop.stopTicker();
      loop.ticker.destroy();
      clock.pause();
      capture.dispose();
      engine.destroy();
      await context.close();
    }
  }
  return {
    scope:
      "Actual ClipRecorder.recordAudio, decoded PCM AudioService, AudioEngine, normal GameLoop and AnalysisScene; synthetic music only",
    recordings,
  };
};
