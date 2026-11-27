import { MSAA_QUALITY, Renderer, RenderTexture, type Matrix } from "pixi.js";
import { AnalysisStage } from "../renderers/components/stage/AnalysisStage";
import { EXPORT_STAGE_FRAME } from "../renderers/components/stage/stage-frame";
import { GameSimulator } from "../common/game/GameSimulator";
import { GameplayClock } from "../common/game/GameplayClock";
import { PerformanceTimelineService } from "../analysis/performance/PerformanceTimelineService";
import type { ReplayDisplaySettings } from "../analysis/replay-display-settings";
import type { ClipExportOptions } from "./clip-export-types";
import { drawSidePanel } from "./clip-side-panel-canvas";
import type { ReadoutModel, ReadoutSettings } from "../analysis/readout-model";
import { rewindFontsReady } from "../../styles/fonts";

/** What the clip's column shows: the clip's display settings, with stats and timing gated by the options. */
export function clipReadoutSettings(
  options: Pick<ClipExportOptions, "showStats" | "showTiming">,
  settings: Readonly<ReplayDisplaySettings>,
): ReadoutSettings {
  const { showStats, showTiming } = options;
  return {
    performancePointsEnabled: showStats && settings.performancePointsEnabled,
    starRatingEnabled: showStats && settings.starRatingEnabled,
    maxComboEnabled: showStats && settings.maxComboEnabled,
    liveResult100Enabled: showStats && settings.liveResult100Enabled,
    liveResult50Enabled: showStats && settings.liveResult50Enabled,
    liveResultMissEnabled: showStats && settings.liveResultMissEnabled,
    liveResultSliderBreakEnabled: showStats && settings.liveResultSliderBreakEnabled,
    liveResultSliderTickEnabled: showStats && settings.liveResultSliderTickEnabled,
    liveResultSliderEndEnabled: showStats && settings.liveResultSliderEndEnabled,
    unstableRateEnabled: showTiming && settings.unstableRateEnabled,
    timingBiasEnabled: showTiming && settings.timingBiasEnabled,
  };
}

/**
 * Render on the live GPU context so framebuffer-backed slider textures retain
 * their pixels. Only the final composited image crosses into the output canvas.
 */
export class ClipExportRenderer {
  private readonly target: RenderTexture;
  private readonly output: CanvasRenderingContext2D;
  private readonly imageData: ImageData;
  private readonly pixels: Uint8Array;
  private readonly settings: Readonly<ReplayDisplaySettings>;
  private readonly showsColumn: boolean;
  /** Whether the last render composed the stats column onto the canvas. */
  private columnDrawn = false;
  private disposed = false;
  private captureLayers?: { dispose(): void };

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly renderer: Renderer,
    private readonly stage: AnalysisStage,
    private readonly simulator: GameSimulator,
    private readonly clock: GameplayClock,
    private readonly performanceTimeline: PerformanceTimelineService,
    private readonly options: ClipExportOptions,
    settings: Readonly<ReplayDisplaySettings>,
    private readonly readout?: (settings: ReadoutSettings) => ReadoutModel | undefined,
    /** Whether the stats column has its shade, as the viewer does (`Shade behind stats`). */
    private readonly statsShade = true,
    /** Native capture consumes readFrame directly; other consumers may need canvas pixels. */
    private readonly mirrorCanvas = true,
  ) {
    this.showsColumn = options.showStats || options.showTiming;
    if (this.showsColumn) {
      if (!rewindFontsReady())
        throw new Error("Hindsight's interface fonts are not loaded, so the stats column cannot be exported.");
      if (!readout) throw new Error("The stats column needs the replay readout, which is unavailable.");
    }
    this.settings = { ...settings, ...options.displaySettings };
    if (renderer.gl.isContextLost()) throw new Error("The clip renderer lost its graphics context");
    const maxTextureSize = Number(renderer.gl.getParameter(renderer.gl.MAX_TEXTURE_SIZE));
    if (!Number.isFinite(maxTextureSize) || maxTextureSize <= 0)
      throw new Error("Could not determine the graphics device's clip size limit");
    if (options.width > maxTextureSize || (options.width * 9) / 16 > maxTextureSize)
      throw new Error(
        `The selected clip resolution exceeds this graphics device's ${maxTextureSize}px texture limit. Choose a lower resolution.`,
      );
    canvas.width = options.width;
    canvas.height = (options.width * 9) / 16;
    // Statistics are drawn here and read for every encoded frame. Keep this
    // composition buffer on the CPU instead of repeatedly downloading it.
    const output = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!output) throw new Error("The clip output canvas is unavailable");
    this.output = output;
    this.imageData = output.createImageData(canvas.width, canvas.height);
    // Read directly into a reusable ImageData buffer. No new multi-megabyte
    // array/canvas allocation or per-pixel alpha conversion is needed per frame.
    this.pixels = new Uint8Array(this.imageData.data.buffer);
    this.target = RenderTexture.create({
      width: options.width,
      height: (options.width * 9) / 16,
      resolution: 1,
      multisample: MSAA_QUALITY.NONE,
    });
    // An opaque clear gives an ordinary video frame, including map backgrounds
    // with transparency, and makes premultiplied RGB identical to straight RGB.
    this.target.baseTexture.clearColor = [0, 0, 0, 1];
  }

  /** Reuse prepared capture layers throughout an offline frame sequence. */
  beginCapture(): void {
    if (this.disposed) throw new Error("The clip renderer has been disposed");
    if (this.captureLayers) throw new Error("The clip renderer is already capturing");
    this.captureLayers = this.stage.beginCaptureLayers(this.options, this.settings);
  }

  endCapture(): void {
    const capture = this.captureLayers;
    this.captureLayers = undefined;
    capture?.dispose();
  }

  render(): void {
    if (this.disposed) return;
    if (this.renderer.gl.isContextLost()) throw new Error("The clip renderer lost its graphics context");
    const stage = this.stage.stage;
    const world = stage.worldTransform;
    if (!Number.isFinite(world.a) || Math.abs(world.a * world.d - world.b * world.c) < 1e-10) {
      throw new Error("The replay scene is not ready to render");
    }
    // Cancel the live renderer's letterboxing without resizing its canvas,
    // changing scene transforms, or running simulation twice in one frame.
    const projection = world.clone().invert();
    const scale = this.options.width / EXPORT_STAGE_FRAME.width;
    projection.scale(scale, scale);
    const previousTarget = this.renderer.renderTexture.current;
    const previousSource = this.renderer.renderTexture.sourceFrame.clone();
    const previousDestination = this.renderer.renderTexture.destinationFrame.clone();
    // Pixi 6 uses null for the screen transform despite declaring this as Matrix.
    const rendererProjection: { transform: Matrix | null } = this.renderer.projection;
    const previousProjection = rendererProjection.transform;
    const previousRenderingToScreen = this.renderer.renderingToScreen;
    try {
      this.stage.withCaptureLayers(
        this.options,
        () =>
          this.renderer.render(stage, {
            renderTexture: this.target,
            transform: projection,
            skipUpdateTransform: true,
            clear: true,
          }),
        this.settings,
      );
      // Pixi's render-texture projection maps logical top to framebuffer y=0
      // (unlike its screen projection), so these rows already match ImageData.
      this.renderer.gl.readPixels(
        0,
        0,
        this.canvas.width,
        this.canvas.height,
        this.renderer.gl.RGBA,
        this.renderer.gl.UNSIGNED_BYTE,
        this.pixels,
      );
      if (this.mirrorCanvas || this.showsColumn) this.output.putImageData(this.imageData, 0, 0);
      this.columnDrawn = false;
      this.columnDrawn = this.drawStats();
    } finally {
      if (previousTarget && (!previousTarget.baseTexture || previousTarget.baseTexture.destroyed)) {
        // A slider can be evicted between offline frames. Its old texture frame
        // and projection cannot be used for the screen fallback either.
        rendererProjection.transform = null;
        this.renderer.renderTexture.bind();
        this.renderer.renderingToScreen = true;
      } else {
        rendererProjection.transform = previousProjection;
        this.renderer.renderTexture.bind(previousTarget ?? undefined, previousSource, previousDestination);
        this.renderer.renderingToScreen = previousRenderingToScreen;
      }
    }
  }

  /** Draws the stats column over the composed frame. Returns whether it drew anything. */
  private drawStats(): boolean {
    if (!this.showsColumn) return false;
    const model = this.readout?.(clipReadoutSettings(this.options, this.settings));
    if (!model) return false;
    return drawSidePanel(
      this.output,
      model,
      { width: this.canvas.width, height: this.canvas.height },
      { shade: this.statsShade },
    );
  }

  /** Top-left RGBA rows, including the stats column when the last render drew it. */
  readFrame(): Uint8ClampedArray {
    if (this.disposed) throw new Error("The clip renderer has been disposed");
    // The column is composed after the GPU readback. Read it too, rather than
    // submitting the reusable GPU buffer with the statistics missing.
    return this.columnDrawn
      ? this.output.getImageData(0, 0, this.canvas.width, this.canvas.height).data
      : this.imageData.data;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.endCapture();
    } finally {
      this.target.destroy(true);
    }
  }
}
