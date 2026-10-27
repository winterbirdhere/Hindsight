import { Container, Matrix, Rectangle, Renderer, RenderTexture, RenderTextureSystem, Shader, Sprite } from "pixi.js";
import { BasicSliderTextureRenderer } from "@rewind/osu-pixi/classic-components";
import { ClipExportRenderer, clipReadoutSettings } from "./ClipExportRenderer";
import { drawSidePanel } from "./clip-side-panel-canvas";
import { DEFAULT_REPLAY_DISPLAY_SETTINGS } from "../analysis/replay-display-settings";
import { DEFAULT_CLIP_EXPORT_SETTINGS, clipAppearanceOptions } from "../analysis/clip-export-settings";
import { DISPLAY_TOGGLES, displaySections } from "../../components/settings/display-rows";
import type { ClipExportOptions, ClipExportWidth } from "./clip-export-types";
import type { LiveReplayStats } from "../analysis/live-replay-stats";
import type { ReplayDisplaySettings } from "../analysis/replay-display-settings";
import type { ReadoutModel, ReadoutSettings } from "../analysis/readout-model";
import { REWIND_REQUIRED_FACES } from "../../styles/fonts";

jest.mock("./clip-side-panel-canvas", () => ({ drawSidePanel: jest.fn() }));
const drawSidePanelMock = drawSidePanel as jest.MockedFunction<typeof drawSidePanel>;

const options: ClipExportOptions = {
  startMs: 1000,
  endMs: 2000,
  width: 1920,
  fps: 60,
  audio: true,
  preset: "replay",
  showKeys: false,
  showTiming: false,
  showStats: false,
  speed: 1,
};

function fixture(
  width: ClipExportWidth = 1920,
  overrides: Partial<ClipExportOptions> = {},
  maxTextureSize = 8192,
  viewerSettings: Readonly<ReplayDisplaySettings> = DEFAULT_REPLAY_DISPLAY_SETTINGS,
  readout?: (settings: ReadoutSettings) => ReadoutModel | undefined,
  statsShade?: boolean,
  mirrorCanvas?: boolean,
) {
  const contextId = 51;
  const sliderTexture = RenderTexture.create({ width: 2, height: 1 });
  const slider = new Sprite(sliderTexture);
  const stage = new Container();
  stage.addChild(slider);
  stage.worldTransform.set(0.5, 0, 0, 0.5, 180, 30);
  // Like a generated slider texture, these painted pixels exist only on the
  // context that generated them. A second renderer cannot upload a resource.
  const sliderPixelsByContext = new Map([[contextId, new Uint8Array([250, 80, 170, 255, 230, 220, 200, 255])]]);
  const targetPixels = new Map<RenderTexture, Uint8Array>();
  const output = {
    createImageData: jest.fn((w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    })),
    putImageData: jest.fn(),
    save: jest.fn(),
    restore: jest.fn(),
    setTransform: jest.fn(),
    translate: jest.fn(),
    scale: jest.fn(),
    fill: jest.fn(),
    beginPath: jest.fn(),
    roundRect: jest.fn(),
    getImageData: jest.fn(() => ({ data: new Uint8ClampedArray([9, 8, 7, 255]) })),
    fillText: jest.fn(),
    fillRect: jest.fn(),
    createLinearGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
    measureText: jest.fn((text: string) => ({
      width: text.length * 10,
      fontBoundingBoxAscent: 16,
      fontBoundingBoxDescent: 4,
    })),
  };
  const canvas = document.createElement("canvas");
  const getContext = jest.spyOn(canvas, "getContext").mockReturnValue(output as never);
  const liveCanvas = document.createElement("canvas");
  liveCanvas.width = 1900;
  liveCanvas.height = 1100;
  const originalSource = new Rectangle(3, 4, 950, 550);
  const originalDestination = new Rectangle(5, 6, 950, 550);
  const originalProjection = new Matrix(1, 0, 0, 1, 2, 4);
  const renderer = {
    CONTEXT_UID: contextId,
    view: liveCanvas,
    screen: new Rectangle(0, 0, 950, 550),
    resolution: 2,
    renderingToScreen: true,
    projection: { transform: originalProjection as Matrix | null, update: jest.fn() },
    framebuffer: { bind: jest.fn() },
    mask: { setMaskStack: jest.fn() },
    renderTexture: undefined as unknown as RenderTextureSystem,
    render: jest.fn((scene: Container, renderOptions: { renderTexture: RenderTexture; transform: Matrix }) => {
      renderer.renderingToScreen = false;
      renderer.projection.transform = null;
      renderer.renderTexture.bind(renderOptions.renderTexture);
      if (scene === stage) {
        const pixels = sliderPixelsByContext.get(renderer.CONTEXT_UID);
        if (!pixels) throw new Error("The slider framebuffer belongs to another context");
        targetPixels.set(renderOptions.renderTexture, pixels);
      }
    }),
    gl: {
      RGBA: 6408,
      UNSIGNED_BYTE: 5121,
      MAX_TEXTURE_SIZE: 3379,
      getParameter: jest.fn(() => maxTextureSize),
      isContextLost: () => false,
      readPixels: jest.fn(
        (_x: number, _y: number, _w: number, _h: number, _format: number, _type: number, pixels: Uint8Array) => {
          const rendered = targetPixels.get(renderer.renderTexture.current as RenderTexture);
          if (!rendered) throw new Error("Readback did not use the composited target");
          pixels.set(rendered);
        },
      ),
    },
    resize: jest.fn(),
    destroy: jest.fn(),
  };
  // Keep Pixi's actual binding and viewport calculations: a permissive bind mock
  // would accept a destroyed texture and hide the export regression.
  renderer.renderTexture = new RenderTextureSystem(renderer as unknown as Renderer);
  renderer.renderTexture.bind(undefined, originalSource, originalDestination);
  const stats: LiveReplayStats = {
    count100: 12,
    count50: 3,
    countMiss: 2,
    maxComboSoFar: 456,
    mapMaxCombo: 2136,
    sliderBreakCount: 1,
    sliderEndMissCount: 2,
  };
  const simulator = {
    getCurrentScoreStats: () => stats,
    getRulesetFocus: () => "stable",
    getCurrentTimingStats: () => ({ ur: "91.2", bias: "+3.4 ms" }),
  };
  const performance = { at: () => ({ point: { pp: 456.78, sr: 5.679 }, description: "Stable" }) };
  const releaseLayers = jest.fn();
  const beginCaptureLayers = jest.fn(() => ({ dispose: releaseLayers }));
  const clip: ClipExportRenderer = Reflect.construct(ClipExportRenderer, [
    canvas,
    renderer as unknown as Renderer,
    { stage, beginCaptureLayers, withCaptureLayers: (_options: unknown, render: () => void) => render() } as never,
    simulator as never,
    { timeElapsedInMs: 1000 } as never,
    performance as never,
    { ...options, width, ...overrides },
    viewerSettings,
    readout,
    statsShade,
    mirrorCanvas,
  ]);
  return {
    clip,
    renderer,
    output,
    canvas,
    liveCanvas,
    sliderTexture,
    stage,
    originalSource,
    originalDestination,
    originalProjection,
    getContext,
    releaseLayers,
    beginCaptureLayers,
  };
}

describe("ClipExportRenderer shared framebuffer capture", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([1920, 2560, 3840] as const)("captures raw %s frames without an unused canvas copy", (width) => {
    const { clip, output, renderer, originalProjection } = fixture(
      width,
      {},
      8192,
      DEFAULT_REPLAY_DISPLAY_SETTINGS,
      undefined,
      true,
      false,
    );
    try {
      clip.render();
      const pixels = clip.readFrame();
      expect(pixels.byteLength).toBe(width * ((width * 9) / 16) * 4);
      expect(Array.from(pixels.subarray(0, 8))).toEqual([250, 80, 170, 255, 230, 220, 200, 255]);
      clip.render();
      expect(clip.readFrame()).toBe(pixels);
      expect(output.putImageData).not.toHaveBeenCalled();
      expect(renderer.projection.transform).toBe(originalProjection);
      expect(renderer.renderingToScreen).toBe(true);
      renderer.gl.readPixels.mockImplementationOnce(() => {
        throw new Error("readback failed");
      });
      expect(() => clip.render()).toThrow("readback failed");
      expect(renderer.renderTexture.current).toBeNull();
      expect(renderer.projection.transform).toBe(originalProjection);
    } finally {
      clip.destroy();
    }
  });

  it("holds capture layers until explicitly ended or destroyed, including target failure", () => {
    const { clip, renderer, releaseLayers, beginCaptureLayers } = fixture();
    clip.beginCapture();
    clip.render();
    clip.render();
    expect(beginCaptureLayers).toHaveBeenCalledTimes(1);
    expect(releaseLayers).not.toHaveBeenCalled();
    renderer.gl.readPixels.mockImplementation(() => {
      throw new Error("target failure");
    });
    expect(() => clip.render()).toThrow("target failure");
    clip.endCapture();
    clip.destroy();
    expect(releaseLayers).toHaveBeenCalledTimes(1);
  });

  it.each([1920, 2560, 3840] as const)("keeps generated slider pixels on their owning context at width %s", (width) => {
    const { clip, renderer, output, canvas, liveCanvas, stage, getContext } = fixture(width);
    const originalTransform = stage.worldTransform.clone();
    clip.render();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    const [sceneCall] = renderer.render.mock.calls;
    expect(sceneCall[0]).toBe(stage);
    expect(sceneCall[1]).toEqual(expect.objectContaining({ skipUpdateTransform: true, clear: true }));
    expect(sceneCall[1].renderTexture.baseTexture.clearColor).toEqual([0, 0, 0, 1]);
    expect(sceneCall[1].renderTexture.width).toBe(width);
    expect(sceneCall[1].renderTexture.height).toBe((width * 9) / 16);
    // Export projection exactly undoes the live panel's scale and letterbox.
    const composed = sceneCall[1].transform.clone().append(originalTransform);
    expect([composed.a, composed.d, composed.tx, composed.ty]).toEqual([width / 1600, width / 1600, 0, 0]);
    const image = output.putImageData.mock.calls[0][0] as ImageData;
    expect(Array.from(image.data.slice(0, 8))).toEqual([250, 80, 170, 255, 230, 220, 200, 255]);
    expect(getContext).toHaveBeenCalledWith("2d", expect.objectContaining({ alpha: false }));
    expect([canvas.width, canvas.height]).toEqual([width, (width * 9) / 16]);
    expect([liveCanvas.width, liveCanvas.height, renderer.resolution]).toEqual([1900, 1100, 2]);
    expect(renderer.resize).not.toHaveBeenCalled();
    expect(stage.worldTransform).toEqual(originalTransform);
    clip.destroy();
  });

  it("restores live framebuffer, projection and viewport after successful and failed renders", () => {
    const { clip, renderer, originalSource, originalDestination, originalProjection } = fixture();
    clip.render();
    expect(renderer.renderTexture.current).toBeNull();
    expect(renderer.renderTexture.sourceFrame).toEqual(originalSource);
    expect(renderer.renderTexture.destinationFrame).toEqual(originalDestination);
    expect(renderer.projection.transform).toBe(originalProjection);
    expect(renderer.renderingToScreen).toBe(true);
    renderer.gl.readPixels.mockImplementation(() => {
      throw new Error("readback failed");
    });
    expect(() => clip.render()).toThrow("readback failed");
    expect(renderer.renderTexture.current).toBeNull();
    expect(renderer.renderTexture.sourceFrame).toEqual(originalSource);
    expect(renderer.renderTexture.destinationFrame).toEqual(originalDestination);
    expect(renderer.projection.transform).toBe(originalProjection);
    expect(renderer.renderingToScreen).toBe(true);
    clip.destroy();
  });

  it.each([false, true])("restores a live offscreen target (readback fails: %s)", (fail) => {
    const { clip, renderer, originalProjection } = fixture();
    const target = RenderTexture.create({ width: 64, height: 32, resolution: 2 });
    const source = new Rectangle(3, 4, 20, 10);
    const destination = new Rectangle(5, 6, 20, 10);
    renderer.renderTexture.bind(target, source, destination);
    renderer.renderingToScreen = false;
    try {
      if (fail) {
        renderer.gl.readPixels.mockImplementationOnce(() => {
          throw new Error("readback failed");
        });
        expect(() => clip.render()).toThrow("readback failed");
      } else clip.render();
      expect(renderer.renderTexture.current).toBe(target);
      expect(renderer.renderTexture.sourceFrame).toEqual(source);
      expect(renderer.renderTexture.destinationFrame).toEqual(destination);
      expect(renderer.renderTexture.viewportFrame).toEqual(new Rectangle(10, 12, 40, 20));
      expect(renderer.projection.transform).toBe(originalProjection);
      expect(renderer.renderingToScreen).toBe(false);
    } finally {
      renderer.renderTexture.bind();
      target.destroy(true);
      clip.destroy();
    }
  });

  it.each(["before render", "during failed readback"])(
    "recovers the screen when the previous target is destroyed %s",
    (when) => {
      const { clip, renderer } = fixture();
      const target = RenderTexture.create({ width: 64, height: 32, resolution: 2 });
      renderer.renderTexture.bind(target, new Rectangle(3, 4, 20, 10), new Rectangle(5, 6, 20, 10));
      renderer.renderingToScreen = false;
      try {
        if (when === "before render") {
          target.destroy(true);
          expect(() => clip.render()).not.toThrow();
        } else {
          renderer.gl.readPixels.mockImplementationOnce(() => {
            target.destroy(true);
            throw new Error("readback failed");
          });
          // Restoration must not replace the real failure with a null-resolution error.
          expect(() => clip.render()).toThrow("readback failed");
        }
        expect(renderer.renderTexture.current).toBeNull();
        expect(renderer.renderTexture.sourceFrame).toEqual(new Rectangle(0, 0, 950, 550));
        expect(renderer.renderTexture.destinationFrame).toEqual(new Rectangle(0, 0, 950, 550));
        expect(renderer.renderTexture.viewportFrame).toEqual(new Rectangle(0, 0, 1900, 1100));
        expect(renderer.projection.transform).toBeNull();
        expect(renderer.renderingToScreen).toBe(true);
        expect(() => clip.render()).not.toThrow();
      } finally {
        renderer.renderTexture.bind();
        if (target.baseTexture) target.destroy(true);
        clip.destroy();
      }
    },
  );

  it("exports the next frame after a generated slider leaves the scene and its texture is released", () => {
    const { clip, renderer, stage } = fixture();
    const sliderRenderer = Object.create(BasicSliderTextureRenderer.prototype) as BasicSliderTextureRenderer;
    sliderRenderer.renderer = renderer as unknown as Renderer;
    sliderRenderer.shader = { uniforms: {} } as Shader;
    const texture = sliderRenderer.render({
      path: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      radius: 2,
      resolution: 1,
    });
    const slider = new Sprite(texture);
    stage.addChild(slider);
    try {
      clip.render();
      stage.removeChild(slider);
      texture.destroy(true);
      expect(() => clip.render()).not.toThrow();
      expect(renderer.renderTexture.current).toBeNull();
      expect(renderer.renderingToScreen).toBe(true);
    } finally {
      renderer.renderTexture.bind();
      if (texture.baseTexture) texture.destroy(true);
      slider.destroy();
      clip.destroy();
    }
  });

  it("reuses the readback buffer and destroys only export-owned resources", () => {
    const { clip, renderer, output, sliderTexture } = fixture();
    clip.render();
    const target = renderer.render.mock.calls[0][1].renderTexture;
    const destroyTarget = jest.spyOn(target, "destroy");
    clip.render();
    expect(output.createImageData).toHaveBeenCalledTimes(1);
    expect(renderer.gl.readPixels.mock.calls[0][6]).toBe(renderer.gl.readPixels.mock.calls[1][6]);
    expect(output.putImageData.mock.calls[0][0]).toBe(output.putImageData.mock.calls[1][0]);
    clip.destroy();
    clip.destroy();
    expect(destroyTarget).toHaveBeenCalledTimes(1);
    expect(destroyTarget).toHaveBeenCalledWith(true);
    expect(renderer.destroy).not.toHaveBeenCalled();
    expect(sliderTexture.baseTexture.destroyed).toBe(false);
    const calls = renderer.render.mock.calls.length;
    clip.render();
    expect(renderer.render).toHaveBeenCalledTimes(calls);
  });

  it("rejects unsupported GPU dimensions before allocating export image or texture buffers", () => {
    const allocate = jest.spyOn(RenderTexture, "create");
    expect(() => fixture(3840, {}, 2048)).toThrow(/2048px texture limit.*lower resolution/);
    // The fixture creates one tiny live slider texture, but no export target.
    expect(allocate.mock.calls.map(([options]) => options?.width)).toEqual([2]);
    expect(() => fixture(1920, {}, 0)).toThrow(/Could not determine.*clip size limit/);
  });
});

const ALL_ROWS: ReplayDisplaySettings = {
  ...DEFAULT_REPLAY_DISPLAY_SETTINGS,
  performancePointsEnabled: true,
  starRatingEnabled: true,
  maxComboEnabled: true,
  liveResult100Enabled: true,
  liveResult50Enabled: true,
  liveResultMissEnabled: true,
  liveResultSliderBreakEnabled: true,
  liveResultSliderTickEnabled: true,
  liveResultSliderEndEnabled: true,
  unstableRateEnabled: true,
  timingBiasEnabled: true,
};
const STATS_KEYS = [
  "performancePointsEnabled",
  "starRatingEnabled",
  "maxComboEnabled",
  "liveResult100Enabled",
  "liveResult50Enabled",
  "liveResultMissEnabled",
  "liveResultSliderBreakEnabled",
  "liveResultSliderTickEnabled",
  "liveResultSliderEndEnabled",
] as const;
const TIMING_KEYS = ["unstableRateEnabled", "timingBiasEnabled"] as const;

describe("clipReadoutSettings", () => {
  it("gates the column's rows by showStats and showTiming", () => {
    const noStats = clipReadoutSettings({ showStats: false, showTiming: true }, ALL_ROWS);
    for (const key of STATS_KEYS) expect(noStats[key]).toBe(false);
    for (const key of TIMING_KEYS) expect(noStats[key]).toBe(true);

    const noTiming = clipReadoutSettings({ showStats: true, showTiming: false }, ALL_ROWS);
    for (const key of TIMING_KEYS) expect(noTiming[key]).toBe(false);
    for (const key of STATS_KEYS) expect(noTiming[key]).toBe(true);

    const neither = clipReadoutSettings({ showStats: false, showTiming: false }, ALL_ROWS);
    for (const key of [...STATS_KEYS, ...TIMING_KEYS]) expect(neither[key]).toBe(false);

    // Open gates leave every row to the clip's own switch.
    const both = clipReadoutSettings({ showStats: true, showTiming: true }, { ...ALL_ROWS, starRatingEnabled: false });
    for (const key of [...STATS_KEYS, ...TIMING_KEYS]) expect(both[key]).toBe(key !== "starRatingEnabled");
  });

  it("lets one live result through alone", () => {
    const quiet: ReplayDisplaySettings = {
      ...ALL_ROWS,
      ...Object.fromEntries([...STATS_KEYS, ...TIMING_KEYS].map((key) => [key, false])),
      liveResultSliderEndEnabled: true,
    };
    const result = clipReadoutSettings({ showStats: true, showTiming: true }, quiet);
    expect(Object.entries(result).filter(([, on]) => on)).toEqual([["liveResultSliderEndEnabled", true]]);
  });

  it("the Combo row has its own toggle and needs only showStats", () => {
    const quiet: ReplayDisplaySettings = {
      ...ALL_ROWS,
      ...Object.fromEntries([...STATS_KEYS, ...TIMING_KEYS].map((key) => [key, false])),
    };
    // Combo alone: the column's Combo row, and nothing else.
    const comboAlone = clipReadoutSettings({ showStats: true, showTiming: false }, { ...quiet, maxComboEnabled: true });
    expect(Object.entries(comboAlone).filter(([, on]) => on)).toEqual([["maxComboEnabled", true]]);
    // UR on with Combo off: UR without Combo.
    const timingGates = { showStats: false, showTiming: true };
    const urOnly = clipReadoutSettings(timingGates, { ...quiet, unstableRateEnabled: true });
    expect(Object.entries(urOnly).filter(([, on]) => on)).toEqual([["unstableRateEnabled", true]]);
    // UR with Combo on, but no stats gate: the Combo row does not depend on the other rows, only on showStats.
    const urWithCombo = clipReadoutSettings(timingGates, {
      ...quiet,
      unstableRateEnabled: true,
      maxComboEnabled: true,
    });
    expect(Object.entries(urWithCombo).filter(([, on]) => on)).toEqual([["unstableRateEnabled", true]]);
    // One live result with Combo off: the result without Combo.
    const statsGates = { showStats: true, showTiming: false };
    const onlyResult = clipReadoutSettings(statsGates, { ...quiet, liveResultMissEnabled: true });
    expect(Object.entries(onlyResult).filter(([, on]) => on)).toEqual([["liveResultMissEnabled", true]]);
  });

  it("does not turn on a row the clip's settings keep off, and does not mutate them", () => {
    const settings = Object.freeze({ ...ALL_ROWS, maxComboEnabled: false });
    const result = clipReadoutSettings({ showStats: true, showTiming: true }, settings);
    expect(result.maxComboEnabled).toBe(false);
    expect(settings.maxComboEnabled).toBe(false);
  });
});

describe("the stats column in the exported frame", () => {
  const loadedInterfaceFonts = {
    check: () => true,
    forEach: (callback: (face: Pick<FontFace, "family" | "weight" | "status">) => void) =>
      REWIND_REQUIRED_FACES.forEach(({ family, weight }) => callback({ family, weight, status: "loaded" })),
  };
  const model: ReadoutModel = {
    identity: { title: "ANiMA", mods: "NM", ruleset: "Stable" },
    performance: { pp: "456.8" },
    rows: [],
    judgements: [],
  };

  beforeEach(() => {
    Object.defineProperty(document, "fonts", { configurable: true, value: loadedInterfaceFonts });
    drawSidePanelMock.mockReset();
    drawSidePanelMock.mockReturnValue(false);
  });
  afterEach(() => jest.restoreAllMocks());

  it("draws the column without its shade when the viewer has switched the shade off", () => {
    drawSidePanelMock.mockReturnValue(true);
    const { clip, output } = fixture(
      1920,
      { showStats: true, showTiming: false },
      8192,
      DEFAULT_REPLAY_DISPLAY_SETTINGS,
      () => model,
      false,
    );
    clip.render();
    expect(drawSidePanelMock).toHaveBeenCalledWith(output, model, { width: 1920, height: 1080 }, { shade: false });
    clip.destroy();
  });

  it.each([
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
  ] as const)("draws the column from the clip's settings at the frame's size (%i x %i)", (width, height) => {
    const readout = jest.fn((_settings: ReadoutSettings) => model);
    drawSidePanelMock.mockReturnValue(true);
    const clipSettings = { ...ALL_ROWS, unstableRateEnabled: true, performancePointsEnabled: false };
    // The viewer's own settings differ from the clip's: the clip's decide the rows.
    const viewer = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, performancePointsEnabled: true, maxComboEnabled: false };
    const { clip, output } = fixture(
      width,
      { showStats: true, showTiming: false, displaySettings: clipSettings },
      8192,
      viewer,
      readout,
    );
    clip.render();
    expect(readout).toHaveBeenCalledTimes(1);
    const asked = readout.mock.calls[0][0];
    expect(asked).toEqual(clipReadoutSettings({ showStats: true, showTiming: false }, { ...viewer, ...clipSettings }));
    expect(asked).toMatchObject({ performancePointsEnabled: false, maxComboEnabled: true, unstableRateEnabled: false });
    expect(drawSidePanelMock).toHaveBeenCalledTimes(1);
    expect(drawSidePanelMock).toHaveBeenCalledWith(output, model, { width, height }, { shade: true });
    // The column is composed after the GPU pixels reach the canvas.
    expect(drawSidePanelMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      output.putImageData.mock.invocationCallOrder[0],
    );
    clip.destroy();
  });

  it("composes the real column onto the frame at the frame's size", () => {
    drawSidePanelMock.mockImplementation(
      jest.requireActual<typeof import("./clip-side-panel-canvas")>("./clip-side-panel-canvas").drawSidePanel,
    );
    const { clip, output } = fixture(1920, { showStats: true }, 8192, undefined, () => model);
    clip.render();
    // The scrim runs the full frame height; the text is the pp readout.
    expect(output.fillRect.mock.calls[0]).toEqual([0, 0, expect.closeTo(150 * (1080 / 696), 6), 1080]);
    expect(output.fillText.mock.calls.map(([text]) => text)).toEqual(["456.8", "pp"]);
    clip.destroy();
  });

  it("returns the canvas pixels when the column was drawn and the GPU buffer when it was not", () => {
    const { clip, output } = fixture(1920, { showStats: true }, 8192, undefined, () => model, true, false);
    drawSidePanelMock.mockReturnValueOnce(true);
    clip.render();
    expect(Array.from(clip.readFrame())).toEqual([9, 8, 7, 255]);
    expect(output.putImageData).toHaveBeenCalledTimes(1);
    expect(output.getImageData).toHaveBeenCalledWith(0, 0, 1920, 1080);

    // The next render draws nothing: the frame is the GPU readback, with no canvas read.
    output.getImageData.mockClear();
    drawSidePanelMock.mockReturnValueOnce(false);
    clip.render();
    expect(Array.from(clip.readFrame().slice(0, 8))).toEqual([250, 80, 170, 255, 230, 220, 200, 255]);
    expect(output.getImageData).not.toHaveBeenCalled();
    clip.destroy();
  });

  it("reads the GPU buffer when the readout has nothing to show", () => {
    const { clip, output } = fixture(1920, { showStats: true }, 8192, undefined, () => undefined);
    clip.render();
    expect(drawSidePanelMock).not.toHaveBeenCalled();
    expect(Array.from(clip.readFrame().slice(0, 4))).toEqual([250, 80, 170, 255]);
    expect(output.getImageData).not.toHaveBeenCalled();
    clip.destroy();
  });

  it("draws nothing and asks for no readout when both gates are off", () => {
    const readout = jest.fn(() => model);
    const { clip } = fixture(1920, { showStats: false, showTiming: false }, 8192, undefined, readout);
    clip.render();
    expect(readout).not.toHaveBeenCalled();
    expect(drawSidePanelMock).not.toHaveBeenCalled();
    clip.destroy();
  });

  it("a clip with every Display toggle off has no stats column", () => {
    const display = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS };
    for (const section of displaySections("clip")) {
      if (section === "cursors") continue;
      for (const { key } of DISPLAY_TOGGLES[section]) display[key] = false;
    }
    const settings = {
      ...DEFAULT_CLIP_EXPORT_SETTINGS,
      displaySettings: display,
      showReplayCursor: false,
      showAnalysisCursor: false,
      showComparisonCursor: false,
    };
    // The clip's Max combo toggle is in the derived list, so it is off too.
    expect(display.maxComboEnabled).toBe(false);
    const appearance = clipAppearanceOptions(settings);
    expect(appearance).toMatchObject({ showStats: false, showTiming: false });
    const readout = jest.fn(() => model);
    const { clip } = fixture(1920, appearance, 8192, undefined, readout);
    clip.render();
    expect(readout).not.toHaveBeenCalled();
    expect(drawSidePanelMock).not.toHaveBeenCalled();
    // No column: the frame is the reused GPU buffer.
    expect(Array.from(clip.readFrame().slice(0, 8))).toEqual([250, 80, 170, 255, 230, 220, 200, 255]);
    clip.destroy();
  });

  it("needs the fonts and the readout only when the column shows something", () => {
    // Nothing selected: neither the fonts nor a readout is required.
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { check: () => false, forEach: () => undefined },
    });
    expect(() => fixture(1920, { showStats: false, showTiming: false })).not.toThrow();
    // Either gate brings the fonts check.
    const fontsMessage = "Hindsight's interface fonts are not loaded, so the stats column cannot be exported.";
    expect(() => fixture(1920, { showStats: true }, 8192, undefined, () => model)).toThrow(fontsMessage);
    expect(() => fixture(1920, { showTiming: true }, 8192, undefined, () => model)).toThrow(fontsMessage);
    // With the fonts loaded the readout is the next requirement.
    Object.defineProperty(document, "fonts", { configurable: true, value: loadedInterfaceFonts });
    const readoutMessage = "The stats column needs the replay readout, which is unavailable.";
    expect(() => fixture(1920, { showStats: true })).toThrow(readoutMessage);
    expect(() => fixture(1920, { showTiming: true })).toThrow(readoutMessage);
    expect(() => fixture(1920, { showStats: true }, 8192, undefined, () => model)).not.toThrow();
    expect(() => fixture(1920, { showTiming: true }, 8192, undefined, () => model)).not.toThrow();
  });
});
