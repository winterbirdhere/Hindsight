import * as PIXI from "pixi.js";
import { inject, injectable, optional } from "inversify";
import { Subject } from "rxjs";
import { NOOP_VIEWER_LIFECYCLE, VIEWER_LIFECYCLE_OBSERVER, ViewerLifecycleObserver } from "../common/ViewerLifecycleObserver";

@injectable()
export class PixiRendererManager {
  /** GPU resource owners release renderer-specific caches before its context is destroyed. */
  readonly beforeDestroy$ = new Subject<void>();
  // RendererPreferenceSettingsService to get preferences
  private renderer?: PIXI.Renderer;
  private canvas?: HTMLCanvasElement;
  private releaseContextObservation?: () => void;
  private readonly lifecycle: ViewerLifecycleObserver;

  constructor(@inject(VIEWER_LIFECYCLE_OBSERVER) @optional() lifecycle?: ViewerLifecycleObserver) {
    this.lifecycle = lifecycle === undefined ? NOOP_VIEWER_LIFECYCLE : lifecycle;
    if (this.lifecycle.enabled) this.lifecycle.record("renderer-manager-created", this);
  }

  initializeRenderer(canvas: HTMLCanvasElement) {
    if (this.lifecycle.enabled) this.lifecycle.record("renderer-initialize-attempt", this, { canvasId: this.lifecycle.id(canvas) });
    this.destroy();
    this.canvas = canvas;
    const { width, height } = this.getDisplaySize(canvas);
    this.renderer = new PIXI.Renderer({
      view: canvas,
      antialias: true,
      autoDensity: true,
      resolution: this.getDevicePixelRatio(),
      width,
      height,
    });
    if (this.lifecycle.enabled) {
      const rendererId = this.lifecycle.id(this.renderer), canvasId = this.lifecycle.id(canvas);
      this.lifecycle.record("renderer-created", this, { rendererId, canvasId });
      const lost = () => this.lifecycle.record("renderer-context-lost", this, { rendererId, canvasId });
      const restored = () => this.lifecycle.record("renderer-context-restored", this, { rendererId, canvasId });
      canvas.addEventListener("webglcontextlost", lost);
      canvas.addEventListener("webglcontextrestored", restored);
      this.releaseContextObservation = () => {
        canvas.removeEventListener("webglcontextlost", lost);
        canvas.removeEventListener("webglcontextrestored", restored);
      };
    }
    this.restoreResponsiveCanvasSize(canvas);
    this.resizeCanvasToDisplaySize();
  }

  // https://webgl2fundamentals.org/webgl/lessons/webgl-anti-patterns.html
  // https://developer.mozilla.org/en-US/docs/Web/API/Element/clientWidth
  resizeCanvasToDisplaySize() {
    const canvas = this.canvas;
    if (!canvas || !this.renderer) {
      return false;
    }
    const { width, height } = this.getDisplaySize(canvas);
    const resolution = this.getDevicePixelRatio();
    const resolutionChanged = this.renderer.resolution !== resolution;
    if (resolutionChanged) {
      this.renderer.resolution = resolution;
    }
    // If its backing-store resolution does not match, change it. Measure the
    // containing panel because Pixi's autoDensity temporarily writes pixel
    // dimensions to the canvas's inline style.
    const expectedWidth = Math.round(width * this.renderer.resolution);
    const expectedHeight = Math.round(height * this.renderer.resolution);
    if (resolutionChanged || canvas.width !== expectedWidth || canvas.height !== expectedHeight) {
      // canvas.width/height will be set by renderer.resize()
      this.renderer.resize(width, height);
      if (this.lifecycle.enabled) this.lifecycle.record("renderer-resized", this, {
        rendererId: this.lifecycle.id(this.renderer), width, height, resolution,
      });
      this.restoreResponsiveCanvasSize(canvas);
      console.log(`Canvas dimensions have been set to ${canvas.width} x ${canvas.height}`);
      return true;
    }
    this.restoreResponsiveCanvasSize(canvas);
    return false;
  }

  private getDisplaySize(canvas: HTMLCanvasElement) {
    const container = canvas.parentElement;
    return {
      width: Math.max(1, container?.clientWidth ?? canvas.clientWidth),
      height: Math.max(1, container?.clientHeight ?? canvas.clientHeight),
    };
  }

  private getDevicePixelRatio() {
    return Math.max(1, window.devicePixelRatio || 1);
  }

  private restoreResponsiveCanvasSize(canvas: HTMLCanvasElement) {
    canvas.style.width = "100%";
    canvas.style.height = "100%";
  }

  destroy() {
    if (this.lifecycle.enabled) this.lifecycle.record("renderer-destroy-attempt", this, { rendererId: this.lifecycle.id(this.renderer) });
    this.beforeDestroy$.next();
    this.renderer?.clear();
    this.renderer?.destroy();
    if (this.renderer && this.lifecycle.enabled) this.lifecycle.record("renderer-released", this, { rendererId: this.lifecycle.id(this.renderer) });
    this.releaseContextObservation?.();
    this.releaseContextObservation = undefined;
    this.renderer = undefined;
    this.canvas = undefined;
  }

  getRenderer(): PIXI.Renderer | undefined {
    return this.renderer;
  }
}
