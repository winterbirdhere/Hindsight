import { RenderTexture, Texture } from "pixi.js";
import { PixiRendererManager } from "../../PixiRendererManager";
import { SliderTextureManager } from "./SliderTextureManager";
import { Subject } from "rxjs";
import { ViewerLifecycleObserver } from "../../../common/ViewerLifecycleObserver";

const mockRender = jest.fn();

jest.mock("@rewind/osu-pixi/classic-components", () => ({
  BasicSliderTextureRenderer: jest.fn().mockImplementation(() => ({ render: mockRender })),
}));

function fakeTexture() {
  return { destroy: jest.fn() } as unknown as Texture;
}

function rendererFixture() {
  const beforeDestroy$ = new Subject<void>();
  return { getRenderer: () => ({}), beforeDestroy$ } as unknown as PixiRendererManager;
}

describe("SliderTextureManager", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ];
  const baseJob = {
    id: "slider-1",
    points,
    radius: 36,
    borderColor: [255, 255, 255] as [number, number, number],
    bodyColor: [20, 40, 60] as [number, number, number],
    resolution: 2.25,
  };

  beforeEach(() => {
    mockRender.mockReset();
  });

  it("journals explicit cache clear while aggregating actual texture creation and release", () => {
    const events: string[] = [], counts: Record<string, number> = {};
    const manager = new SliderTextureManager(rendererFixture());
    Object.assign(manager, { lifecycle: new ViewerLifecycleObserver({ id: () => 1,
      record: kind => events.push(kind), count: (kind, _owner, amount) => { counts[kind] = (counts[kind] ?? 0) + amount; }, invalidate: () => undefined }) });
    const texture = RenderTexture.create({ width: 16, height: 16 }), baseTexture = texture.baseTexture;
    mockRender.mockReturnValueOnce(texture);
    manager.getTexture(baseJob); manager.getTexture(baseJob);
    manager.clear(); manager.clear();
    expect(baseTexture.destroyed).toBe(true);
    expect(counts).toEqual({ "slider-texture-created": 1, "slider-texture-released": 1 });
    expect(events.filter(kind => kind === "slider-cache-clear-attempt")).toHaveLength(2);
    expect(events.filter(kind => kind === "slider-cache-cleared")).toHaveLength(2);
  });

  it("passes body and border colours to the existing renderer and reuses an identical job", () => {
    const texture = fakeTexture();
    mockRender.mockReturnValue(texture);
    const rendererManager = rendererFixture();
    const manager = new SliderTextureManager(rendererManager);

    expect(manager.getTexture(baseJob)).toBe(texture);
    expect(manager.getTexture({ ...baseJob })).toBe(texture);
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockRender).toHaveBeenCalledWith(
      expect.objectContaining({ borderColor: [255, 255, 255], bodyColor: [20, 40, 60] }),
    );
  });

  it("replaces a cached texture when the resolved body colour changes", () => {
    const original = fakeTexture();
    const replacement = fakeTexture();
    mockRender.mockReturnValueOnce(original).mockReturnValueOnce(replacement);
    const rendererManager = rendererFixture();
    const manager = new SliderTextureManager(rendererManager);

    manager.getTexture(baseJob);
    expect(manager.getTexture({ ...baseJob, bodyColor: [70, 80, 90] })).toBe(replacement);
    expect(original.destroy).toHaveBeenCalledTimes(1);
    expect(original.destroy).toHaveBeenCalledWith(true);
    expect(mockRender).toHaveBeenCalledTimes(2);
  });

  it.each(["replacement", "eviction"])("releases the owned base texture and framebuffer on %s", (operation) => {
    const original = RenderTexture.create({ width: 16, height: 16 });
    const baseTexture = original.baseTexture;
    const disposeFramebuffer = jest.spyOn(original.framebuffer, "dispose");
    const replacement = fakeTexture();
    mockRender.mockReturnValueOnce(original).mockReturnValueOnce(replacement);
    const rendererManager = rendererFixture();
    const manager = new SliderTextureManager(rendererManager);

    manager.getTexture(baseJob);
    if (operation === "replacement") {
      expect(manager.getTexture({ ...baseJob, bodyColor: [70, 80, 90] })).toBe(replacement);
    } else {
      manager.removeFromCache(baseJob.id);
      manager.removeFromCache(baseJob.id);
      expect(manager.getTexture(baseJob)).toBe(replacement);
    }

    expect(baseTexture.destroyed).toBe(true);
    expect(baseTexture.framebuffer).toBeNull();
    expect(disposeFramebuffer).toHaveBeenCalledTimes(1);
    expect(replacement.destroy).not.toHaveBeenCalled();
  });

  it.each(["clear", "renderer teardown"])(
    "releases all owned framebuffers on %s and regenerates on reuse",
    (operation) => {
      const rendererManager = rendererFixture();
      const manager = new SliderTextureManager(rendererManager);
      const first = RenderTexture.create({ width: 16, height: 16 });
      const second = RenderTexture.create({ width: 16, height: 16 });
      const baseTextures = [first.baseTexture, second.baseTexture];
      mockRender.mockReturnValueOnce(first).mockReturnValueOnce(second);
      manager.getTexture(baseJob);
      manager.getTexture({ ...baseJob, id: "slider-2" });

      if (operation === "clear") Reflect.get(manager, "clear").call(manager);
      else (Reflect.get(rendererManager, "beforeDestroy$") as Subject<void>).next();

      expect(baseTextures.every((texture) => texture.destroyed)).toBe(true);
      expect(manager.textures.size).toBe(0);
      const replacement = RenderTexture.create({ width: 16, height: 16 });
      mockRender.mockReturnValueOnce(replacement);
      expect(manager.getTexture(baseJob)).toBe(replacement);
      replacement.destroy(true);
    },
  );

  it("evicts no-longer-visible textures without revisiting their slider factories", () => {
    const manager = new SliderTextureManager(rendererFixture());
    const first = RenderTexture.create({ width: 16, height: 16 });
    const second = RenderTexture.create({ width: 16, height: 16 });
    const firstBase = first.baseTexture;
    mockRender.mockReturnValueOnce(first).mockReturnValueOnce(second);
    manager.getTexture(baseJob);
    Reflect.get(manager, "releaseUntouched").call(manager);
    manager.getTexture({ ...baseJob, id: "slider-2" });
    Reflect.get(manager, "releaseUntouched").call(manager);
    expect(firstBase.destroyed).toBe(true);
    expect(manager.textures.size).toBe(1);
    expect(second.baseTexture.destroyed).toBe(false);
    Reflect.get(manager, "releaseUntouched").call(manager);
    expect(manager.textures.size).toBe(0);
  });
});
