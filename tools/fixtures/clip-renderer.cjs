/* Renderer-side half of verify-clip-renderer.cjs. Requires a real DOM/WebGL. */
module.exports = async function verifyClipRenderer(workspace, output) {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const workspaceRequire = require("node:module").createRequire(path.join(workspace, "package.json"));
  workspaceRequire("reflect-metadata");
  const ts = workspaceRequire("typescript");
  const PIXI = workspaceRequire("pixi.js");
  const modules = new Map();
  // Compile only the production compositor, production slider shader/geometry,
  // and their actual math imports. No generated app bundle or mocked GPU is used.
  function sourceModule(filename) {
    filename = path.resolve(filename);
    if (!path.extname(filename))
      filename = fs.existsSync(filename + ".ts") ? filename + ".ts" : path.join(filename, "index.ts");
    if (modules.has(filename)) return modules.get(filename).exports;
    const result = { exports: {} };
    modules.set(filename, result);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true,
        emitDecoratorMetadata: false,
      },
    }).outputText;
    const localRequire = (name) => {
      if (name === "@osujs/math") return sourceModule(path.join(workspace, "libs/osu/math/src/index.ts"));
      if (name === "@osujs/core") return sourceModule(path.join(workspace, "libs/osu/core/src/index.ts"));
      if (name.startsWith(".")) return sourceModule(path.resolve(path.dirname(filename), name));
      return workspaceRequire(name);
    };
    new Function("require", "module", "exports", code)(localRequire, result, result.exports);
    return result.exports;
  }
  const { BasicSliderTextureRenderer, getBoundsFromSliderPath } = sourceModule(
    path.join(workspace, "libs/osu-pixi/classic-components/src/renderers/BasicSliderTextureRenderer.ts"),
  );
  const { ClipExportRenderer } = sourceModule(
    path.join(workspace, "apps/desktop/frontend/src/app/services/manager/ClipExportRenderer.ts"),
  );
  const { GameplayClock } = sourceModule(
    path.join(workspace, "apps/desktop/frontend/src/app/services/common/game/GameplayClock.ts"),
  );
  const { GameLoop } = sourceModule(
    path.join(workspace, "apps/desktop/frontend/src/app/services/common/game/GameLoop.ts"),
  );
  const { AnalysisStage } = sourceModule(
    path.join(workspace, "apps/desktop/frontend/src/app/services/renderers/components/stage/AnalysisStage.ts"),
  );
  const { createClipFramePlan } = sourceModule(
    path.join(workspace, "apps/desktop/frontend/src/app/services/manager/clip-export-types.ts"),
  );
  const liveCanvas = document.createElement("canvas");
  const live = new PIXI.Renderer({
    view: liveCanvas,
    width: 1000,
    height: 700,
    resolution: 1,
    preserveDrawingBuffer: true,
  });
  const stage = new PIXI.Container();
  stage.scale.set(0.55);
  stage.position.set(60, 70);
  const backdropColor = [11, 17, 29, 255];
  stage.addChild(new PIXI.Graphics().beginFill(0x0b111d).drawRect(0, 0, 1500, 900).endFill());
  stage.addChild(new PIXI.Graphics().beginFill(0xff6000).drawRect(30, 30, 100, 80).endFill());
  stage.addChild(new PIXI.Graphics().beginFill(0x00dfff).drawRect(1400, 770, 100, 80).endFill());
  stage.addChild(new PIXI.Graphics().beginFill(0x00ff00, 0.5).drawRect(1000, 100, 100, 80).endFill());
  const sliderPath = [
    { x: 0, y: 0 },
    { x: 220, y: 0 },
    { x: 220, y: 160 },
    { x: 70, y: 240 },
  ];
  const radius = 25;
  const bounds = getBoundsFromSliderPath(sliderPath, radius);
  const sliderRenderer = new BasicSliderTextureRenderer(live);
  const sliderTexture = sliderRenderer.render({
    path: sliderPath,
    radius,
    resolution: 2.25,
    borderColor: [255, 255, 255],
    bodyColor: [220, 40, 110],
  });
  const slider = new PIXI.Sprite(sliderTexture);
  slider.position.set(500 + bounds.minX, 240 + bounds.minY);
  stage.addChild(slider);
  const png = (canvas, name) =>
    fs.writeFileSync(path.join(output, name), Buffer.from(canvas.toDataURL("image/png").split(",")[1], "base64"));
  const canvasPixel = (canvas, x, y) =>
    Array.from(canvas.getContext("2d").getImageData(Math.floor(x), Math.floor(y), 1, 1).data);
  const glPixel = (renderer, x, y) => {
    const pixel = new Uint8Array(4);
    renderer.gl.readPixels(
      Math.floor(x),
      renderer.view.height - 1 - Math.floor(y),
      1,
      1,
      renderer.gl.RGBA,
      renderer.gl.UNSIGNED_BYTE,
      pixel,
    );
    return Array.from(pixel);
  };
  const dimensions = () => [live.width, live.height, liveCanvas.width, liveCanvas.height, live.resolution];
  const world = () => [
    stage.worldTransform.a,
    stage.worldTransform.b,
    stage.worldTransform.c,
    stage.worldTransform.d,
    stage.worldTransform.tx,
    stage.worldTransform.ty,
  ];
  const renderState = () => ({
    current: live.renderTexture.current,
    source: live.renderTexture.sourceFrame.clone(),
    destination: live.renderTexture.destinationFrame.clone(),
    projection: live.projection.transform,
    toScreen: live.renderingToScreen,
    world: world(),
    dimensions: dimensions(),
  });
  const assertRestored = (before) => {
    assert.equal(live.renderTexture.current, before.current, "Restore the live framebuffer target");
    assert.deepEqual(live.renderTexture.sourceFrame, before.source, "Restore source frame");
    assert.deepEqual(live.renderTexture.destinationFrame, before.destination, "Restore destination frame");
    assert.equal(live.projection.transform, before.projection, "Restore projection transform");
    assert.equal(live.renderingToScreen, before.toScreen, "Restore screen rendering state");
    assert.deepEqual(world(), before.world, "Never change the live scene transform");
    assert.deepEqual(dimensions(), before.dimensions, "Never resize the live canvas");
    assert.equal(live.gl.getError(), live.gl.NO_ERROR, "No WebGL error");
  };
  const hud = new PIXI.Container();
  const timing = new PIXI.Text("UR 123.4 | BIAS +2.1 ms", { fill: 0xffffff, fontSize: 24 });
  timing.position.set(16, 200);
  const bar = new PIXI.Graphics().beginFill(0xffcc44).drawRect(700, 880, 200, 8).endFill();
  hud.addChild(timing, bar);
  const keys = new PIXI.Graphics().beginFill(0x9933dd).drawRect(760, 15, 80, 25).endFill();
  const replayCursor = new PIXI.Graphics().beginFill(0xff00ff).drawCircle(1200, 400, 15).endFill();
  const analysisCursor = new PIXI.Graphics().lineStyle(3, 0x00ffff).drawCircle(1250, 400, 20);
  const cursorLayer = new PIXI.Container();
  cursorLayer.addChild(replayCursor, analysisCursor);
  stage.addChild(hud, keys, cursorLayer);
  keys.visible = timing.visible = bar.visible = analysisCursor.visible = false;
  const layerCounts = { hud: 0, playfield: 0, keys: 0 };
  const wrapper = Object.assign(Object.create(AnalysisStage.prototype), {
    stage,
    resizeTo() {},
    playfield: {
      updatePlayfield() {
        layerCounts.playfield++;
      },
      withCaptureCursors(options, draw) {
        const previous = [replayCursor.visible, analysisCursor.visible];
        try {
          replayCursor.visible = options.showReplayCursor ?? true;
          analysisCursor.visible = options.showAnalysisCursor ?? false;
          cursorLayer.updateTransform();
          return draw();
        } finally {
          [replayCursor.visible, analysisCursor.visible] = previous;
          cursorLayer.updateTransform();
        }
      },
    },
    foregroundHUDPreparer: {
      container: hud,
      stats: timing,
      hitErrorBar: { container: bar },
      updateHUD() {
        layerCounts.hud++;
      },
    },
    keyPressOverlayPreparer: {
      container: keys,
      update() {
        layerCounts.keys++;
      },
      keyPressOverlay: { onMouseOut() {} },
    },
    replayDisplaySettingsStore: { settings: { keyOverlapEnabled: false } },
  });
  const simulator = {
    getCurrentScoreStats: () => ({ count100: 1, count50: 2, countMiss: 3, maxComboSoFar: 4, mapMaxCombo: 5 }),
    getRulesetFocus: () => "stable",
  };
  const clock = new GameplayClock();
  clock.setDuration(10_000);
  clock.seekTo(1234);
  const timelineTimes = [];
  const timeline = {
    at: (_ruleset, time) => {
      timelineTimes.push(time);
      return { point: { pp: time / 10, sr: 4.5 } };
    },
  };
  const statsSettings = {
    performancePointsEnabled: true,
    starRatingEnabled: true,
    judgementCountsEnabled: true,
    maxComboEnabled: true,
  };
  const frameBytes = (capture) => {
    const frame = capture.readFrame();
    assert.equal(frame.length, capture.canvas.width * capture.canvas.height * 4);
    const canvas = capture.canvas.getContext("2d").getImageData(0, 0, capture.canvas.width, capture.canvas.height).data;
    const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    assert(
      bytes.equals(Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength)),
      "Native raw RGBA must exactly equal the final preview canvas, including 2D statistics",
    );
    return Buffer.from(bytes);
  };
  const samples = [
    ["head", 500, 240],
    ["first segment", 610, 240],
    ["turn", 720, 240],
    ["second segment", 720, 320],
    ["second turn", 720, 400],
    ["tail", 570, 480],
  ];
  const results = [];
  const scheduledFrames = [];
  const directParity = [];
  let foreign;
  let capture;
  try {
    assert.equal(live.gl.isContextLost(), false);
    live.render(stage);
    png(liveCanvas, "live-before.png");
    const originalLivePixel = glPixel(live, 60 + 610 * 0.55, 70 + 240 * 0.55);
    for (const width of [1920, 2560, 3840]) {
      const outputCanvas = document.createElement("canvas");
      const options = {
        width,
        fps: 240,
        audio: false,
        showKeys: false,
        showTiming: false,
        showStats: width !== 2560,
        startMs: 0,
        endMs: 2000,
        speed: 1,
        preset: "analysis",
      };
      capture = new ClipExportRenderer(outputCanvas, live, wrapper, simulator, clock, timeline, options, statsSettings);
      const before = renderState();
      capture.render();
      const encodedFrame = frameBytes(capture);
      // Compare the preview and direct paths byte-for-byte, with real production
      // layer ownership, fresh root transforms, canvas text and GPU readback.
      const parityOptions = {
        ...options,
        showKeys: true,
        showTiming: true,
        showHitErrorBar: width !== 2560,
        showReplayCursor: width !== 2560,
        showAnalysisCursor: width === 2560,
      };
      const direct = new ClipExportRenderer(
        document.createElement("canvas"),
        live,
        wrapper,
        simulator,
        clock,
        timeline,
        parityOptions,
        statsSettings,
      );
      let directScope;
      const originalStageX = stage.x;
      try {
        direct.render();
        const previewBytes = Buffer.from(direct.readFrame());
        const beforeLayers = [
          keys.visible,
          timing.visible,
          bar.visible,
          timing.y,
          replayCursor.visible,
          analysisCursor.visible,
        ];
        let screenDraws = 0,
          targetDraws = 0,
          resizeReads = 0;
        const beforeCounts = { ...layerCounts };
        const originalRender = live.render;
        live.render = function (scene, renderOptions) {
          if (renderOptions?.renderTexture) targetDraws++;
          else screenDraws++;
          return originalRender.call(this, scene, renderOptions);
        };
        const directLoop = Object.assign(Object.create(GameLoop.prototype), {
          gameClock: clock,
          ticker: new PIXI.Ticker(),
          performanceMonitor: { begin() {}, end() {} },
          sceneManager: {
            update() {
              clock.tick();
              wrapper.updateAnalysisStage();
            },
            createStage: () => stage,
          },
          pixiRendererService: {
            getRenderer: () => live,
            resizeCanvasToDisplaySize() {
              resizeReads++;
            },
          },
        });
        try {
          direct.beginCapture();
          directScope = directLoop.beginOfflineCapture(
            (error) => {
              throw error;
            },
            () => direct.render(),
          );
          // No live render follows this transform mutation. The export path must
          // update it explicitly and still cancel all live letterboxing.
          stage.x += 37;
          directScope.renderFrame(clock.timeElapsedInMs, 0);
          assert(
            previewBytes.equals(Buffer.from(direct.readFrame())),
            "Direct capture must match preview pixels exactly",
          );
          assert.equal(screenDraws, 0);
          assert.equal(targetDraws, 1);
          assert.equal(resizeReads, 1);
          assert.equal(layerCounts.hud - beforeCounts.hud, 1);
          assert.equal(layerCounts.playfield - beforeCounts.playfield, 1);
          direct.endCapture();
          assert.deepEqual(
            [keys.visible, timing.visible, bar.visible, timing.y, replayCursor.visible, analysisCursor.visible],
            beforeLayers,
          );
          directParity.push({
            width,
            identicalBytes: previewBytes.length,
            screenDraws,
            targetDraws,
            hudUpdates: 1,
            layerRestore: true,
          });
        } finally {
          direct.endCapture();
          directScope?.dispose();
          live.render = originalRender;
          directLoop.ticker.destroy();
        }
      } finally {
        stage.x = originalStageX;
        const parent = stage.enableTempParent();
        stage.updateTransform();
        stage.disableTempParent(parent);
        direct.destroy();
      }
      let statsChangedBytes = 0;
      if (options.showStats) {
        const clean = new ClipExportRenderer(
          document.createElement("canvas"),
          live,
          wrapper,
          simulator,
          clock,
          timeline,
          { ...options, showStats: false },
          statsSettings,
        );
        try {
          clean.render();
          const noStats = frameBytes(clean);
          for (let index = 0; index < encodedFrame.length; index++)
            if (encodedFrame[index] !== noStats[index]) statsChangedBytes++;
          assert(statsChangedBytes > 1000, "Enabled 2D statistics must contribute actual encoded pixels");
        } finally {
          clean.destroy();
        }
      }
      png(outputCanvas, `clip-${width}.png`);
      const scale = width / 1600;
      const landmarks = samples.map(([name, x, y]) => ({
        name,
        pixel: canvasPixel(outputCanvas, x * scale, y * scale),
      }));
      fs.writeFileSync(path.join(output, `pixels-${width}.json`), JSON.stringify(landmarks, null, 2) + "\n");
      assert.deepEqual(
        canvasPixel(outputCanvas, 50 * scale, 50 * scale),
        [255, 96, 0, 255],
        "Top marker has correct position and orientation",
      );
      assert.deepEqual(
        canvasPixel(outputCanvas, 1450 * scale, 800 * scale),
        [0, 223, 255, 255],
        "Bottom marker is not vertically flipped",
      );
      assert.deepEqual(
        canvasPixel(outputCanvas, 1000 * scale, 500 * scale),
        backdropColor,
        "Opaque background retains its color",
      );
      assert.deepEqual(
        canvasPixel(outputCanvas, 1570 * scale, 500 * scale),
        [0, 0, 0, 255],
        "An uncovered scene area clears opaque black for video",
      );
      const alphaPixel = canvasPixel(outputCanvas, 1050 * scale, 140 * scale);
      [5.5, 136, 14.5, 255].forEach((expected, index) =>
        assert(Math.abs(alphaPixel[index] - expected) <= 1, "Transparent artwork composites without darkened RGB"),
      );
      for (const landmark of landmarks) {
        assert(
          landmark.pixel[0] > 60 && landmark.pixel[0] > landmark.pixel[1] * 2,
          `Actual slider ${landmark.name} must contain the colored body: ${landmark.pixel}`,
        );
        assert.equal(landmark.pixel[3], 255, "Video output remains opaque");
      }
      assertRestored(before);
      assert.deepEqual(
        glPixel(live, 60 + 610 * 0.55, 70 + 240 * 0.55),
        originalLivePixel,
        "Export must preserve already drawn live pixels",
      );
      // An exception in a scoped layer draw must still restore the shared renderer.
      const draw = wrapper.withCaptureLayers;
      wrapper.withCaptureLayers = (_options, render) => {
        render();
        throw new Error("fixture after render");
      };
      assert.throws(() => capture.render(), /fixture after render/);
      wrapper.withCaptureLayers = draw;
      assertRestored(before);
      // Capture may be called by another render consumer with a bound target.
      // Exercise non-default frames/projection instead of only the screen case.
      const priorTarget = PIXI.RenderTexture.create({ width: 64, height: 64 });
      live.projection.transform = new PIXI.Matrix().translate(3, 4);
      live.renderTexture.bind(priorTarget, new PIXI.Rectangle(4, 5, 16, 18), new PIXI.Rectangle(2, 3, 16, 18));
      live.renderingToScreen = false;
      const offscreenBefore = renderState();
      capture.render();
      assertRestored(offscreenBefore);
      live.projection.transform = before.projection;
      live.renderTexture.bind(before.current, before.source, before.destination);
      live.renderingToScreen = before.toScreen;
      priorTarget.destroy(true);
      capture.destroy();
      capture.destroy();
      capture = undefined;
      live.render(stage);
      assert.deepEqual(
        glPixel(live, 60 + 610 * 0.55, 70 + 240 * 0.55),
        originalLivePixel,
        "Live slider survives export resource disposal",
      );
      results.push({
        width,
        height: (width * 9) / 16,
        landmarks,
        alphaPixel,
        statsEnabled: options.showStats,
        statsChangedBytes,
        rawFrameMatchesFinalCanvas: true,
        restored: true,
        boundTargetRestored: true,
        exceptionRestored: true,
        disposalSafe: true,
      });
    }
    // Exercise actual clock ownership and GameLoop frame production. A synthetic
    // scene maps exact scheduled times to slider motion; the GPU and compositor
    // are the real production implementations, with no ticker or wall-time pacing.
    const initialSliderX = slider.x;
    const { Subject } = workspaceRequire("rxjs");
    const frameEvents = new Subject();
    const deltas = [];
    const loop = Object.assign(Object.create(GameLoop.prototype), {
      gameClock: clock,
      frameRendered$: frameEvents,
      ticker: new PIXI.Ticker(),
      performanceMonitor: { begin() {}, end() {} },
      sceneManager: {
        update(delta) {
          deltas.push(delta);
          clock.tick();
          slider.x = initialSliderX + (clock.timeElapsedInMs - 1000) * 24;
          wrapper.updateAnalysisStage();
        },
        createStage: () => stage,
      },
      pixiRendererService: { getRenderer: () => live, resizeCanvasToDisplaySize() {} },
    });
    const plan = createClipFramePlan(1000, 1250, 1.125, 240);
    const scheduledCanvas = document.createElement("canvas");
    capture = new ClipExportRenderer(
      scheduledCanvas,
      live,
      wrapper,
      simulator,
      clock,
      timeline,
      {
        width: 1920,
        fps: 240,
        startMs: 1000,
        endMs: 1250,
        speed: 0.75,
        preset: "analysis",
        audio: false,
        showStats: true,
        showKeys: false,
        showTiming: false,
      },
      statsSettings,
    );
    const digest = (bytes) => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    let emittedFrames = 0;
    capture.beginCapture();
    const scope = loop.beginOfflineCapture(
      (error) => {
        throw error;
      },
      () => {
        emittedFrames++;
        const before = renderState();
        capture.render();
        const bytes = frameBytes(capture);
        const timeMs = clock.timeElapsedInMs;
        assert.equal(timelineTimes[timelineTimes.length - 1], timeMs, "2D stats sample the current scheduled time");
        const sample = canvasPixel(scheduledCanvas, (610 + (timeMs - 1000) * 24) * 1.2, 240 * 1.2);
        assert(
          sample[0] > 60 && sample[0] > sample[1] * 2,
          "Scheduled slider body follows the current clock transform",
        );
        assertRestored(before);
        scheduledFrames.push({ index: emittedFrames - 1, timeMs, sha256: digest(bytes), sliderBody: sample });
        png(scheduledCanvas, `scheduled-${emittedFrames - 1}.png`);
      },
    );
    try {
      for (let index = 0; index < 3; index++) {
        const time = plan.timeAt(index);
        scope.renderFrame(time, index ? time - plan.timeAt(index - 1) : 0);
        assert.equal(clock.timeElapsedInMs, time);
        assert.equal(emittedFrames, index + 1, "Every requested frame produces exactly one direct target frame");
      }
      assert.equal(
        new Set(scheduledFrames.map((frame) => frame.sha256)).size,
        3,
        "Scheduled encoded frames must contain distinct replay states",
      );
      assert.deepEqual(deltas, [0, (1000 * 1.125) / 240, (1000 * 1.125) / 240]);
    } finally {
      capture.endCapture();
      scope.dispose();
      loop.ticker.destroy();
      capture.destroy();
      assert.throws(() => capture.readFrame(), /disposed/);
      capture = undefined;
      slider.x = initialSliderX;
      live.render(stage);
    }
    // Control: reusing a painted rendertexture in a different WebGL context is
    // exactly the old failure. The same actual body must disappear in renderer B.
    foreign = new PIXI.Renderer({ width: 1600, height: 900, resolution: 1, preserveDrawingBuffer: true });
    foreign.render(stage, { transform: stage.worldTransform.clone().invert(), skipUpdateTransform: true });
    const oldContextPixel = glPixel(foreign, 610, 240);
    assert.deepEqual(
      oldContextPixel,
      backdropColor,
      "Negative control reproduces the missing-slider second-context bug",
    );
    const debug = live.gl.getExtension("WEBGL_debug_renderer_info");
    return {
      webgl: live.gl.getParameter(live.gl.VERSION),
      renderer: live.gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : live.gl.RENDERER),
      sourceTextureResolution: sliderTexture.resolution,
      originalLivePixel,
      oldContextPixel,
      results,
      directParity,
      scheduledFrames,
    };
  } finally {
    capture?.destroy();
    foreign?.destroy();
    stage.destroy({ children: true });
    sliderTexture.destroy(true);
    sliderRenderer.shader.destroy();
    live.destroy();
  }
};
