// Manages the scene
import { Container } from "pixi.js";
import { ManagedScene, UserScene } from "./IScene";
import { inject, injectable, optional } from "inversify";
import { NOOP_VIEWER_LIFECYCLE, VIEWER_LIFECYCLE_OBSERVER, ViewerLifecycleObserver } from "../ViewerLifecycleObserver";

@injectable()
export class SceneManager {
  managedScene: ManagedScene[] = [];
  container: Container;
  private readonly lifecycle: ViewerLifecycleObserver;

  constructor(@inject(VIEWER_LIFECYCLE_OBSERVER) @optional() lifecycle?: ViewerLifecycleObserver) {
    this.lifecycle = lifecycle === undefined ? NOOP_VIEWER_LIFECYCLE : lifecycle;
    this.container = new Container();
    if (this.lifecycle.enabled) this.lifecycle.record("scene-manager-created", this, { stageId: this.lifecycle.id(this.container) });
  }

  add(scene: UserScene, key: string) {
    const managedScene = new ManagedScene(scene, key);
    this.managedScene.push(managedScene);
  }

  async start(scene: ManagedScene, data: unknown) {
    if (this.lifecycle.enabled) this.lifecycle.record("scene-start-attempt", this, { sceneId: this.lifecycle.id(scene) });
    console.log(`Starting the scene with the key='${scene.key}'`);
    scene.state = "INITIALIZING";
    scene.init(data);
    await scene.preload();
    scene.create();
    scene.state = "PLAYING";
    if (this.lifecycle.enabled) this.lifecycle.record("scene-started", this, { sceneId: this.lifecycle.id(scene) });
  }

  stop(scene: ManagedScene) {
    if (this.lifecycle.enabled) this.lifecycle.record("scene-stop-attempt", this, { sceneId: this.lifecycle.id(scene) });
    scene.destroy();
    scene.state = "SLEEPING";
    if (this.lifecycle.enabled) this.lifecycle.record("scene-stopped", this, { sceneId: this.lifecycle.id(scene) });
  }

  update(deltaTimeMs: number) {
    this.managedScene.forEach((scene) => scene.update(deltaTimeMs));
  }

  sceneByKey(key: string) {
    return this.managedScene.find((s) => s.key === key);
  }

  createStage() {
    this.container.removeChildren();
    this.managedScene.forEach((scene) => {
      if (scene.state === "PLAYING" || scene.state === "PAUSED") {
        this.container.addChild(scene.stage);
      }
    });
    return this.container;
  }
}
