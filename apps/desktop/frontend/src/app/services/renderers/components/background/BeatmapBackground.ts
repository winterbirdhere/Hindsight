import { Container, Graphics, Sprite, Texture } from "pixi.js";

import { injectable } from "inversify";
import { BeatmapBackgroundSettings, BeatmapBackgroundSettingsStore } from "../../../common/beatmap-background";

interface Dimensions {
  width: number;
  height: number;
}

export interface BackgroundCoverLayout {
  scale: number;
  positionX: number;
  positionY: number;
}

/**
 * Covers the complete stage without stretching the map background. Beatmap
 * artwork is not always 16:9 (some maps use very wide or 4:3 images), so
 * fitting only the width can leave an uncovered band on the stage.
 */
export function calculateBackgroundCoverLayout(
  stageDimensions: Dimensions,
  textureDimensions: Dimensions,
): BackgroundCoverLayout {
  const textureWidth = Math.max(1, textureDimensions.width);
  const textureHeight = Math.max(1, textureDimensions.height);
  return {
    scale: Math.max(stageDimensions.width / textureWidth, stageDimensions.height / textureHeight),
    positionX: stageDimensions.width / 2,
    positionY: stageDimensions.height / 2,
  };
}

export class BeatmapBackground {
  public readonly container = new Container();
  public sprite: Sprite;
  private readonly stageClip = new Graphics();
  private stageDimensions: Dimensions;

  constructor(stageDimensions: Dimensions) {
    this.stageDimensions = { ...stageDimensions };
    this.sprite = new Sprite(); // No pooling needed
    this.sprite.anchor.set(0.5);
    this.container.addChild(this.sprite, this.stageClip);
    // The mask shares the stage transform, keeping wide and tall artwork inside the frame.
    this.container.mask = this.stageClip;
    this.drawClip();
  }

  resize(stageDimensions: Dimensions) {
    this.stageDimensions = { ...stageDimensions };
    this.drawClip();
    if (this.sprite.texture) this.applyCover(this.sprite.texture);
  }

  onSettingsChange(beatmapBackgroundSettings: Pick<BeatmapBackgroundSettings, "enabled" | "dim">) {
    const { enabled, dim } = beatmapBackgroundSettings;
    this.sprite.alpha = 1.0 - dim;
    this.sprite.renderable = enabled;
  }

  onTextureChange(texture: Texture) {
    this.sprite.texture = texture;
    this.applyCover(texture);
  }

  private drawClip() {
    this.stageClip
      .clear()
      .beginFill(0xffffff)
      .drawRect(0, 0, this.stageDimensions.width, this.stageDimensions.height)
      .endFill();
  }

  private applyCover(texture: Texture) {
    const layout = calculateBackgroundCoverLayout(this.stageDimensions, texture);
    this.sprite.position.set(layout.positionX, layout.positionY);
    this.sprite.scale.set(layout.scale, layout.scale);
  }
}

@injectable()
export class BeatmapBackgroundFactory {
  constructor(private readonly settingsStore: BeatmapBackgroundSettingsStore) {}

  createBeatmapBackground(stageDimensions: Dimensions) {
    const beatmapBackground = new BeatmapBackground(stageDimensions);
    this.settingsStore.settings$.subscribe((s) => beatmapBackground.onSettingsChange(s));
    this.settingsStore.texture$.subscribe((t) => beatmapBackground.onTextureChange(t));
    return beatmapBackground;
  }
}
