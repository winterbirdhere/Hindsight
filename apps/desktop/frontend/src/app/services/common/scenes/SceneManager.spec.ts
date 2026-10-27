import { SceneManager } from "./SceneManager";
import { ViewerLifecycleObserver } from "../ViewerLifecycleObserver";

it("counts failed scene starts and preserves preload failure and destruction ordering", async () => {
  const events: string[] = [], order: string[] = [], failure = new Error("preload failed");
  const manager = new SceneManager();
  Object.assign(manager, { lifecycle: new ViewerLifecycleObserver({ id: () => 1,
    record: kind => events.push(kind), count: () => undefined, invalidate: () => undefined }) });
  let fail = true;
  manager.add({ init() { order.push("init"); }, preload: async () => { order.push("preload"); if (fail) throw failure; },
    create() { order.push("create"); }, destroy() { order.push("destroy"); }, update: () => undefined, stage: {} as never }, "analysis");
  const scene = manager.sceneByKey("analysis"); if (!scene) throw new Error("Missing fixture scene");
  await expect(manager.start(scene, undefined)).rejects.toBe(failure);
  expect(events.filter(kind => kind === "scene-start-attempt")).toHaveLength(1);
  expect(events.filter(kind => kind === "scene-started")).toHaveLength(0);
  fail = false; await manager.start(scene, undefined); manager.stop(scene);
  expect(order).toEqual(["init", "preload", "init", "preload", "create", "destroy"]);
  expect(events.filter(kind => kind === "scene-started")).toHaveLength(1);
  expect(events.filter(kind => kind === "scene-stopped")).toHaveLength(1);
});
