import { BaseTexture, Container, Texture } from "pixi.js";
import { BeatmapBackground, calculateBackgroundCoverLayout } from "./BeatmapBackground";

describe("BeatmapBackground settings", () => {
  beforeEach(() => {
    // Keep this geometry test independent of a GPU or canvas renderer.
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    jest
      .spyOn(Texture, "WHITE", "get")
      .mockReturnValue(new Texture(new BaseTexture(undefined, { width: 1, height: 1 })));
  });
  afterEach(() => jest.restoreAllMocks());

  it("renders without blur while retaining dim and visibility, including legacy saved settings", () => {
    const background = new BeatmapBackground({ width: 1600, height: 900 });
    const legacySettings = { enabled: true, dim: 0.5, blur: 0.4 };
    background.onSettingsChange(legacySettings);
    expect(background.sprite.filters ?? []).toHaveLength(0);
    expect(background.sprite.alpha).toBe(0.5);

    background.onSettingsChange({ ...legacySettings, enabled: false, dim: 0.8 });

    expect(background.sprite.filters ?? []).toHaveLength(0);
    expect(background.sprite.alpha).toBeCloseTo(0.2);
    expect(background.sprite.renderable).toBe(false);
  });

  it.each([
    [2048, 1002], // Reality Check Through The Skull: wide artwork.
    [1024, 768], // Taller artwork must be clipped vertically instead.
    [1920, 1080],
  ])("keeps %ix%i artwork within the stage through texture changes and resizing", (width, height) => {
    const background = new BeatmapBackground({ width: 1600, height: 900 });
    const stage = new Container();
    stage.addChild(background.container);
    background.onSettingsChange({ enabled: true, dim: 0.5 });

    // Replacing an existing texture must keep the same center crop and clip.
    background.onTextureChange(new Texture(new BaseTexture(undefined, { width: 64, height: 64 })));
    background.onTextureChange(new Texture(new BaseTexture(undefined, { width, height })));
    expect(background.sprite.scale.x).toBe(background.sprite.scale.y);
    expect(background.sprite.width).toBeGreaterThanOrEqual(1600 - 1e-6);
    expect(background.sprite.height).toBeGreaterThanOrEqual(900 - 1e-6);

    for (const scale of [0.5, 1.5]) {
      stage.position.set(75, 30);
      stage.scale.set(scale);
      const bounds = stage.getBounds();
      expect(bounds.x).toBeCloseTo(75);
      expect(bounds.y).toBeCloseTo(30);
      expect(bounds.width).toBeCloseTo(1600 * scale);
      expect(bounds.height).toBeCloseTo(900 * scale);
    }
  });

  it("re-covers and re-clips a resized live stage", () => {
    const background = new BeatmapBackground({ width: 1600, height: 900 });
    const stage = new Container();
    stage.addChild(background.container);
    background.onSettingsChange({ enabled: true, dim: 0.5 });
    background.onTextureChange(new Texture(new BaseTexture(undefined, { width: 1920, height: 1080 })));
    background.resize({ width: 1175, height: 900 });
    expect(background.sprite.position.x).toBeCloseTo(587.5);
    expect(background.sprite.height).toBeGreaterThanOrEqual(900 - 1e-6);
    expect(background.sprite.width).toBeGreaterThanOrEqual(1175 - 1e-6);
    expect(stage.getBounds().width).toBeCloseTo(1175);
  });
});

describe("calculateBackgroundCoverLayout", () => {
  it("covers a 16:9 stage with an ultrawide beatmap background", () => {
    const layout = calculateBackgroundCoverLayout({ width: 1600, height: 900 }, { width: 2352, height: 976 });

    expect(layout.scale).toBeCloseTo(900 / 976);
    expect(2352 * layout.scale).toBeGreaterThan(1600);
    expect(976 * layout.scale).toBeCloseTo(900);
    expect(layout.positionX).toBe(800);
    expect(layout.positionY).toBe(450);
  });

  it("covers the width for a taller background without stretching", () => {
    const layout = calculateBackgroundCoverLayout({ width: 1600, height: 900 }, { width: 1024, height: 768 });

    expect(layout.scale).toBeCloseTo(1600 / 1024);
    expect(1024 * layout.scale).toBeCloseTo(1600);
    expect(768 * layout.scale).toBeGreaterThan(900);
  });
});
