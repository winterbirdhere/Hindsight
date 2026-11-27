import { inject, injectable, optional } from "inversify";
import { NOOP_VIEWER_LIFECYCLE, VIEWER_LIFECYCLE_OBSERVER, ViewerLifecycleObserver } from "../../../common/ViewerLifecycleObserver";
import { PixiRendererManager } from "../../PixiRendererManager";
import { Position, RGB } from "@osujs/math";
import { BasicSliderTextureRenderer } from "@rewind/osu-pixi/classic-components";
import { Texture } from "pixi.js";

// Sliders use sprites and they need the corresponding textures.
// Usually here is where big optimizations can be made by batching the slider renderings and so on.
// Slider textures use insane amount of (GPU) memory, that's why we need to dispose those which are not needed.
// When there was no memory optimization, my GPU ran out of memory (4GB) after only 100 sliders (full screen
// 1920x1080).

type SliderTextureJob = {
  id: string;
  points: Position[];
  radius: number;
  borderColor: RGB;
  bodyColor: RGB;
  resolution: number;
};

type CachedSliderTextureJob = Omit<SliderTextureJob, "id">;

function colorsEqual(a: RGB, b: RGB) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function cloneColor(color: RGB): RGB {
  return [color[0], color[1], color[2]];
}

function canReuseTexture(cached: CachedSliderTextureJob, current: SliderTextureJob) {
  return (
    cached.points === current.points &&
    cached.radius === current.radius &&
    cached.resolution === current.resolution &&
    colorsEqual(cached.borderColor, current.borderColor) &&
    colorsEqual(cached.bodyColor, current.bodyColor)
  );
}

@injectable()
export class SliderTextureManager {
  textures: Map<string, Texture>;
  private readonly cachedJobs: Map<string, CachedSliderTextureJob>;
  private readonly touched = new Set<string>();
  private readonly lifecycle: ViewerLifecycleObserver;

  constructor(private readonly pixiRendererService: PixiRendererManager,
    @inject(VIEWER_LIFECYCLE_OBSERVER) @optional() lifecycle?: ViewerLifecycleObserver) {
    this.lifecycle = lifecycle === undefined ? NOOP_VIEWER_LIFECYCLE : lifecycle;
    this.textures = new Map<string, Texture>();
    this.cachedJobs = new Map<string, CachedSliderTextureJob>();
    this.pixiRendererService.beforeDestroy$.subscribe(() => this.clear());
    if (this.lifecycle.enabled) this.lifecycle.record("slider-cache-created", this);
  }

  getTexture(settings: SliderTextureJob): Texture {
    const { id, points, radius, borderColor, bodyColor, resolution } = settings;
    this.touched.add(id);
    const texture = this.textures.get(id);
    const cachedJob = this.cachedJobs.get(id);
    if (texture !== undefined && cachedJob !== undefined && canReuseTexture(cachedJob, settings)) {
      return texture;
    }

    const pixiRenderer = this.pixiRendererService.getRenderer();
    if (pixiRenderer === undefined) {
      throw Error("Could not render slider texture without a renderer in place.");
    }
    const sliderTextureRenderer: BasicSliderTextureRenderer = new BasicSliderTextureRenderer(pixiRenderer);
    const renderTexture = sliderTextureRenderer.render({
      // The first point of .calculatedPath will be the head and also have the value (0, 0)
      // The other points are relative positions to the head = (0, 0).
      path: points,
      radius,
      resolution,
      borderColor,
      bodyColor,
    });
    if (this.lifecycle.enabled) this.lifecycle.count("slider-texture-created", this);

    // Slider ids identify geometry inside one beatmap. If its skin colours or
    // geometry context changed, replace the stale texture under the same id.
    // Each job owns the RenderTexture and its framebuffer-backed base texture.
    texture?.destroy(true);
    if (texture && this.lifecycle.enabled) this.lifecycle.count("slider-texture-released", this);
    this.textures.set(id, renderTexture);
    this.cachedJobs.set(id, {
      points,
      radius,
      resolution,
      borderColor: cloneColor(borderColor),
      bodyColor: cloneColor(bodyColor),
    });
    return renderTexture;
    // We shift the sprite so that the pivot of this container correspond to the
    // slider head of the texture.
    // const { minX, minY } = getBoundsFromSliderPath(points, radius);
    // sprite.position.set(minX, minY);
  }

  removeFromCache(id: string) {
    const texture = this.textures.get(id);
    if (texture !== undefined) {
      texture.destroy(true);
      if (this.lifecycle.enabled) this.lifecycle.count("slider-texture-released", this);
      this.textures.delete(id);
    }
    this.cachedJobs.delete(id);
    this.touched.delete(id);
  }

  /** Called once after visible sliders have requested their textures. */
  releaseUntouched() {
    for (const id of this.textures.keys()) {
      if (!this.touched.has(id)) this.removeFromCache(id);
    }
    this.touched.clear();
  }

  clear() {
    if (this.lifecycle.enabled) this.lifecycle.record("slider-cache-clear-attempt", this, { cached: this.textures.size });
    for (const texture of this.textures.values()) {
      texture.destroy(true);
      if (this.lifecycle.enabled) this.lifecycle.count("slider-texture-released", this);
    }
    this.textures.clear();
    this.cachedJobs.clear();
    this.touched.clear();
    if (this.lifecycle.enabled) this.lifecycle.record("slider-cache-cleared", this);
  }
}
