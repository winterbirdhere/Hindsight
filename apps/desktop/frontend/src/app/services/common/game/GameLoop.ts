import * as PIXI from "pixi.js";
import { GameplayClock } from "./GameplayClock";
import { PixiRendererManager } from "../../renderers/PixiRendererManager";
import { injectable, postConstruct } from "inversify";
import { SceneManager } from "../scenes/SceneManager";
import MrDoobStats from "stats.js";
import { Subject } from "rxjs";

function defaultMonitor() {
  const s = new MrDoobStats();
  s.dom.style.position = "absolute";
  s.dom.style.left = "0px";
  s.dom.style.top = "0px";
  s.dom.style.zIndex = "9000";
  // if (props.initialPanel !== undefined) s.showPanel(props.initialPanel);
  return s;
}

export interface OfflineFrameCapture {
  /** Beatmap timestamp and elapsed milliseconds for this frame; the caller excludes its out-point. */
  renderFrame(timeMs: number, deltaMs: number): void;
  dispose(): void;
}

// Game loop does not have to stop if the game clock is paused.
// For example, we could still toggle hidden on/off and need to see the changes on the canvas.
// However, it should be paused, if the view is destroyed or if the window was blurred ...
// Default behavior is to stop the game loop in case of window.blur because usually the player does not want to
// watch the replay in Rewind while playing osu!.
// End game behavior would be to automatically stop the game loop if the user is playing osu!, which we
// could detect through some memory reader.
@injectable()
export class GameLoop {
  /** Runs after simulation and the visible scene have rendered, including while paused. */
  readonly frameRendered$ = new Subject<void>();
  private ticker: PIXI.Ticker;
  private readonly performanceMonitor: MrDoobStats;
  private offlineCapture?: { dispose: () => void; resume: boolean; fail: (error: Error) => void };
  private offlineFrameInProgress = false;

  constructor(
    private gameClock: GameplayClock, // Maybe also inject?
    private sceneManager: SceneManager,
    private pixiRendererService: PixiRendererManager,
  ) {
    this.ticker = new PIXI.Ticker();
    this.performanceMonitor = defaultMonitor();
  }

  stats() {
    return this.performanceMonitor.dom;
  }

  @postConstruct()
  initializeTicker() {
    this.ticker.add(this.tickHandler.bind(this));
  }

  startTicker() {
    // A replay can finish loading after its view has been hidden. In that
    // case there is nothing to render, and starting the ticker would leave a
    // requestAnimationFrame loop running until the view is mounted again.
    if (!this.pixiRendererService.getRenderer()) return;
    if (this.offlineCapture) {
      this.offlineCapture.resume = true;
      return;
    }
    this.ticker.start();
  }

  stopTicker() {
    if (this.offlineCapture) {
      this.offlineCapture.resume = false;
      this.offlineCapture.fail(new Error("The replay view stopped during export"));
    }
    this.ticker.stop();
  }

  /** Render caller-paced frames while keeping the ordinary ticker and audio clock suspended. */
  beginOfflineCapture(onError: (error: Error) => void, drawFrame?: () => void): OfflineFrameCapture {
    if (this.offlineCapture || this.offlineFrameInProgress) {
      throw new Error("A clip render capture is already active");
    }
    const renderer = this.pixiRendererService.getRenderer();
    if (!renderer) throw new Error("The replay renderer is unavailable");
    // Capture geometry is stable for the session. The next live frame handles
    // a window resize; export projection removes this canvas's letterboxing.
    if (drawFrame) this.pixiRendererService.resizeCanvasToDisplaySize();
    const clockCapture = this.gameClock.beginOfflineCapture();
    let disposed = false;
    const capture = {
      resume: this.ticker.started,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        clockCapture.dispose();
        if (this.offlineCapture === capture) this.offlineCapture = undefined;
        if (capture.resume && this.pixiRendererService.getRenderer() === renderer) this.ticker.start();
      },
      fail: (error: Error) => {
        if (disposed) return;
        capture.dispose();
        onError(error);
      },
    };
    this.offlineCapture = capture;
    this.ticker.stop();
    const assertActive = () => {
      if (disposed || this.offlineCapture !== capture) throw new Error("The offline frame capture is no longer active");
      if (this.pixiRendererService.getRenderer() !== renderer) throw new Error("The replay renderer is unavailable");
    };
    return {
      renderFrame: (timeMs, deltaMs) => {
        try {
          assertActive();
          if (this.offlineFrameInProgress) throw new Error("An offline frame is already being rendered");
          if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new Error("Invalid offline frame delta");
          clockCapture.setTime(timeMs);
          this.offlineFrameInProgress = true;
          try {
            this.performanceMonitor.begin();
            this.update(deltaMs);
            if (drawFrame) {
              assertActive();
              const stage = this.sceneManager.createStage();
              const parent = stage.enableTempParent();
              try {
                stage.updateTransform();
              } finally {
                stage.disableTempParent(parent);
              }
              assertActive();
              drawFrame();
              assertActive();
            } else this.render(assertActive);
          } finally {
            this.offlineFrameInProgress = false;
            this.performanceMonitor.end();
          }
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          try {
            capture.fail(failure);
          } catch {
            // Preserve the original frame failure if the owner's error handler also throws.
          }
          throw failure;
        }
      },
      dispose: capture.dispose,
    };
  }

  private update(deltaTimeMs: number) {
    this.sceneManager.update(deltaTimeMs);
  }

  /** Refresh the restored playhead even when the ordinary ticker is stopped. */
  refresh(): void {
    if (!this.pixiRendererService.getRenderer()) return;
    this.tickHandler(0);
  }

  private render(assertValid?: () => void) {
    assertValid?.();
    const renderer = this.pixiRendererService.getRenderer();
    if (renderer) {
      this.pixiRendererService.resizeCanvasToDisplaySize();
      const stage = this.sceneManager.createStage();
      assertValid?.();
      renderer.render(stage);
      assertValid?.();
      this.frameRendered$.next();
      assertValid?.();
    }
  }

  // deltaTimeMs will be given by PixiTicker
  tickHandler(deltaTimeMs: number) {
    if (this.offlineCapture || this.offlineFrameInProgress) return;
    // Maybe we can measure the `.update()` and the `.render()` independently
    // console.debug(`Updating with timeDelta=${deltaTimeMs}ms`);
    this.performanceMonitor.begin();
    this.update(deltaTimeMs);
    this.render();
    this.performanceMonitor.end();
  }
}
