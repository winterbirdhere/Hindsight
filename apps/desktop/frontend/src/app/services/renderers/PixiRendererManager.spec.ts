import { PixiRendererManager } from "./PixiRendererManager";

const mockRendererInstances: Array<{
  resolution: number;
  resize: jest.Mock;
  clear: jest.Mock;
  destroy: jest.Mock;
}> = [];

jest.mock("pixi.js", () => ({
  Renderer: jest
    .fn()
    .mockImplementation((options: { view: HTMLCanvasElement; resolution: number; width: number; height: number }) => {
      const renderer = {
        resolution: options.resolution,
        resize: jest.fn((width: number, height: number) => {
          options.view.width = Math.round(width * renderer.resolution);
          options.view.height = Math.round(height * renderer.resolution);
        }),
        clear: jest.fn(),
        destroy: jest.fn(),
      };
      options.view.width = Math.round(options.width * renderer.resolution);
      options.view.height = Math.round(options.height * renderer.resolution);
      mockRendererInstances.push(renderer);
      return renderer;
    }),
}));

function createCanvas(width = 320, height = 180) {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(container, "clientHeight", { configurable: true, value: height });
  const canvas = document.createElement("canvas");
  container.appendChild(canvas);
  return canvas;
}

function setDevicePixelRatio(value: number) {
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value });
}

const originalDevicePixelRatio = window.devicePixelRatio;

describe("PixiRendererManager", () => {
  beforeEach(() => {
    mockRendererInstances.length = 0;
    setDevicePixelRatio(1);
  });

  afterAll(() => setDevicePixelRatio(originalDevicePixelRatio));

  it("destroys an existing renderer before replacing it and clears all references on destroy", () => {
    const manager = new PixiRendererManager();
    const firstCanvas = createCanvas();
    manager.initializeRenderer(firstCanvas);
    const firstRenderer = mockRendererInstances[0];

    manager.initializeRenderer(createCanvas());

    expect(firstRenderer.clear).toHaveBeenCalledTimes(1);
    expect(firstRenderer.destroy).toHaveBeenCalledTimes(1);
    expect(manager.getRenderer()).toBe(mockRendererInstances[1]);

    manager.destroy();
    expect(mockRendererInstances[1].destroy).toHaveBeenCalledTimes(1);
    expect(manager.getRenderer()).toBeUndefined();
    expect((manager as unknown as { canvas?: HTMLCanvasElement }).canvas).toBeUndefined();
  });

  it("resizes the backing store when device pixel ratio changes without a CSS resize", () => {
    const manager = new PixiRendererManager();
    const canvas = createCanvas(320, 180);
    manager.initializeRenderer(canvas);
    const renderer = mockRendererInstances[0];

    setDevicePixelRatio(2);

    expect(manager.resizeCanvasToDisplaySize()).toBe(true);
    expect(renderer.resolution).toBe(2);
    expect(renderer.resize).toHaveBeenLastCalledWith(320, 180);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(canvas.style.width).toBe("100%");
    expect(canvas.style.height).toBe("100%");
  });

  it("observes actual renderer replacement but treats backing-size changes as resize", () => {
    const events: Array<{ kind: string; fields: Record<string, unknown> }> = [];
    const identities = new WeakMap<object, number>();
    let nextId = 0;
    const observer = {
      enabled: true,
      id(owner: object | undefined) {
        if (!owner) return 0;
        if (!identities.has(owner)) identities.set(owner, ++nextId);
        return identities.get(owner) ?? 0;
      },
      record(kind: string, _owner: object, fields: Record<string, unknown> = {}) { events.push({ kind, fields }); },
    };
    const manager = Reflect.construct(PixiRendererManager, [observer]) as PixiRendererManager;
    const canvas = createCanvas();
    manager.initializeRenderer(canvas);
    const first = manager.getRenderer();
    setDevicePixelRatio(2);
    manager.resizeCanvasToDisplaySize();
    expect(manager.getRenderer()).toBe(first);
    expect(events.filter(event => event.kind === "renderer-created")).toHaveLength(1);
    expect(events.filter(event => event.kind === "renderer-released")).toHaveLength(0);
    expect(events.filter(event => event.kind === "renderer-resized")).toHaveLength(1);
    const contextLost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(contextLost);
    expect(contextLost.defaultPrevented).toBe(false);
    expect(events.filter(event => event.kind === "renderer-context-lost")).toHaveLength(1);
    manager.initializeRenderer(createCanvas());
    manager.destroy();
    expect(events.filter(event => event.kind === "renderer-created")).toHaveLength(2);
    expect(events.filter(event => event.kind === "renderer-released")).toHaveLength(2);
    expect(events.filter(event => event.kind === "renderer-created")[0].fields.rendererId)
      .not.toBe(events.filter(event => event.kind === "renderer-created")[1].fields.rendererId);
    canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(events.filter(event => event.kind === "renderer-context-lost")).toHaveLength(1);
  });
});
