import { Geometry, Matrix, Mesh, Rectangle, Renderer, RenderTexture, RenderTextureSystem, Shader } from "pixi.js";
import { BasicSliderTextureRenderer, getSliderGeometry } from "./BasicSliderTextureRenderer";

/** Stub only the GPU draw; use Pixi's real render-target binding and viewport math. */
function rendererFixture(draw: (mesh: Mesh, options: { renderTexture: RenderTexture }) => void = () => undefined) {
  const renderer = {
    view: { height: 600 },
    screen: new Rectangle(0, 0, 400, 300),
    resolution: 2,
    renderingToScreen: true,
    projection: { transform: new Matrix(1, 0, 0, 1, 2, 4) as Matrix | null, update: jest.fn() },
    framebuffer: { bind: jest.fn() },
    mask: { setMaskStack: jest.fn() },
    renderTexture: undefined as unknown as RenderTextureSystem,
    render: jest.fn((mesh: Mesh, options: { renderTexture: RenderTexture }) => {
      renderer.renderingToScreen = false;
      renderer.projection.transform = null;
      renderer.renderTexture.bind(options.renderTexture);
      draw(mesh, options);
    }),
  };
  renderer.renderTexture = new RenderTextureSystem(renderer as unknown as Renderer);
  renderer.renderTexture.bind();
  return renderer;
}

describe("slider path geometry boundaries", () => {
  it.each([{ path: [] }, { path: [{ x: 0, y: 0 }] }])(
    "returns a finite render texture for collapsed $path",
    ({ path }) => {
      const sliderRenderer = Object.create(BasicSliderTextureRenderer.prototype) as BasicSliderTextureRenderer;
      sliderRenderer.renderer = rendererFixture() as unknown as Renderer;
      sliderRenderer.shader = { uniforms: {} } as Shader;
      const texture = sliderRenderer.render({ path, radius: 32, resolution: 1 });
      expect(texture.width).toBe(64);
      expect(texture.height).toBe(64);
      texture.destroy(true);
    },
  );
  it.each([{ points: [] }, { points: [{ x: 0, y: 0 }] }])(
    "handles a collapsed path $points without invalid indices",
    ({ points }) => {
      const geometry = getSliderGeometry(points, 32);
      const positions = geometry.getBuffer("position").data;
      const indices = geometry.getIndex().data;
      expect(Array.from(positions).every(Number.isFinite)).toBe(true);
      expect(Array.from(indices).every((index) => index * 3 < positions.length)).toBe(true);
      if (points.length > 0) expect(indices.length).toBeGreaterThan(0);
      geometry.destroy();
    },
  );

  it.each([1_225, 2_449])("keeps every segment when splitting %i path points", (count) => {
    const segments: number[][] = [];
    const sliderRenderer = Object.create(BasicSliderTextureRenderer.prototype) as BasicSliderTextureRenderer;
    sliderRenderer.renderer = rendererFixture((mesh: Mesh) => {
      const data = mesh.geometry.getBuffer("position").data;
      const bounds = Array.from(data).filter((_, index) => index % 3 === 0);
      segments.push([Math.min(...bounds), Math.max(...bounds)]);
    }) as unknown as Renderer;
    sliderRenderer.shader = { uniforms: {} } as Shader;
    const texture = sliderRenderer.render({
      path: Array.from({ length: count }, (_, x) => ({ x: x * 100, y: 0 })),
      radius: 1,
      resolution: 1,
    });
    expect(segments.length).toBeGreaterThan(1);
    for (let index = 1; index < segments.length; index++) {
      // A 100px gap between separate chunks cannot be covered by their 1px caps.
      expect(segments[index][0]).toBeLessThan(segments[index - 1][1]);
    }
    texture.destroy(true);
  });
});

describe("BasicSliderTextureRenderer resource ownership", () => {
  it("disposes each temporary mesh geometry while keeping the result texture and shared shader", () => {
    const meshes: Mesh[] = [];
    const geometries: Geometry[] = [];
    const disposal: jest.SpyInstance[] = [];
    const render = jest.fn((mesh: Mesh) => {
      meshes.push(mesh);
      geometries.push(mesh.geometry);
      disposal.push(jest.spyOn(mesh.geometry, "dispose"));
      expect(mesh.geometry.getBuffer("position").data.length).toBeGreaterThan(0);
    });
    const sliderRenderer = Object.create(BasicSliderTextureRenderer.prototype) as BasicSliderTextureRenderer;
    sliderRenderer.renderer = rendererFixture(render) as unknown as Renderer;
    sliderRenderer.shader = { uniforms: {}, destroy: jest.fn() } as unknown as Shader;

    const texture = sliderRenderer.render({
      path: Array.from({ length: 1_250 }, (_, x) => ({ x, y: 0 })),
      radius: 10,
      resolution: 1,
    });

    expect(render).toHaveBeenCalledTimes(2);
    expect(meshes.every((mesh) => mesh.destroyed)).toBe(true);
    expect(geometries.every((geometry) => geometry.refCount === 0)).toBe(true);
    disposal.forEach((dispose) => expect(dispose).toHaveBeenCalledTimes(1));
    expect(sliderRenderer.shader.destroy).not.toHaveBeenCalled();
    expect(texture.baseTexture.destroyed).toBe(false);
    texture.destroy(true);
  });

  it("releases temporary geometry and the unreturned texture if rendering fails", () => {
    let mesh: Mesh | undefined;
    let resultTexture: RenderTexture | undefined;
    let resultBaseTexture: RenderTexture["baseTexture"] | undefined;
    const failure = new Error("render failed");
    const sliderRenderer = Object.create(BasicSliderTextureRenderer.prototype) as BasicSliderTextureRenderer;
    sliderRenderer.renderer = rendererFixture((renderedMesh: Mesh, options: { renderTexture: RenderTexture }) => {
      mesh = renderedMesh;
      resultTexture = options.renderTexture;
      resultBaseTexture = resultTexture.baseTexture;
      throw failure;
    }) as unknown as Renderer;
    sliderRenderer.shader = { uniforms: {} } as Shader;

    expect(() =>
      sliderRenderer.render({
        path: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
        radius: 10,
        resolution: 1,
      }),
    ).toThrow(failure);
    expect(mesh?.destroyed).toBe(true);
    expect(resultTexture?.baseTexture).toBeNull();
    expect(resultBaseTexture?.destroyed).toBe(true);
  });
});

describe("BasicSliderTextureRenderer shared renderer state", () => {
  it.each([
    ["screen", false],
    ["screen", true],
    ["texture", false],
    ["texture", true],
  ] as const)("restores the incoming %s target after rendering (fails: %s)", (kind, fail) => {
    const failure = new Error("slider draw failed");
    const renderer = rendererFixture(() => {
      if (fail) throw failure;
    });
    const previousTarget = kind === "texture" ? RenderTexture.create({ width: 100, height: 80, resolution: 2 }) : null;
    const source = new Rectangle(3, 4, 40, 20);
    const destination = new Rectangle(5, 6, 40, 20);
    renderer.renderTexture.bind(previousTarget ?? undefined, source, destination);
    renderer.renderingToScreen = kind === "screen";
    const projection = renderer.projection.transform;
    const sliderRenderer = Object.create(BasicSliderTextureRenderer.prototype) as BasicSliderTextureRenderer;
    sliderRenderer.renderer = renderer as unknown as Renderer;
    sliderRenderer.shader = { uniforms: {} } as Shader;
    let texture: RenderTexture | undefined;
    const render = () => {
      texture = sliderRenderer.render({ path: [{ x: 0, y: 0 }, { x: 20, y: 0 }], radius: 2, resolution: 1 });
    };
    try {
      if (fail) expect(render).toThrow(failure);
      else render();
      expect(renderer.renderTexture.current).toBe(previousTarget);
      expect(renderer.renderTexture.sourceFrame).toEqual(source);
      expect(renderer.renderTexture.destinationFrame).toEqual(destination);
      expect(renderer.renderTexture.viewportFrame).toEqual(new Rectangle(10, kind === "screen" ? 548 : 12, 80, 40));
      expect(renderer.projection.transform).toBe(projection);
      expect(renderer.renderingToScreen).toBe(kind === "screen");
      if (texture) {
        texture.destroy(true);
        texture = undefined;
        // Releasing the generated result cannot leave the shared renderer bound to it.
        expect(() => renderer.renderTexture.bind(renderer.renderTexture.current ?? undefined)).not.toThrow();
      }
    } finally {
      renderer.renderTexture.bind();
      texture?.destroy(true);
      previousTarget?.destroy(true);
    }
  });
});
