import { Subject } from "rxjs";
import { GameLoop } from "./GameLoop";

describe("GameLoop capture frame hook", () => {
  it("emits once after scene update and GPU render, and never when no renderer exists", () => {
    const order: string[] = [];
    const loop = Object.create(GameLoop.prototype) as GameLoop;
    const getRenderer = jest.fn(() => ({ render: () => order.push("render") }));
    Object.assign(loop, {
      frameRendered$: new Subject<void>(),
      sceneManager: { update: () => order.push("update"), createStage: () => ({}) },
      pixiRendererService: { getRenderer, resizeCanvasToDisplaySize: () => undefined },
      performanceMonitor: { begin: () => undefined, end: () => undefined },
    });
    loop.frameRendered$.subscribe(() => order.push("capture"));
    loop.tickHandler(16);
    expect(order).toEqual(["update", "render", "capture"]);
    getRenderer.mockReturnValue(undefined as never);
    loop.tickHandler(16);
    expect(order).toEqual(["update", "render", "capture", "update"]);
  });
});
