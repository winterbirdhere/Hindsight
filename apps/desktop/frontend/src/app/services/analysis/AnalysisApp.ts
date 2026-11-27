import { ReplayService } from "../common/local/ReplayService";
import { GameplayClock } from "../common/game/GameplayClock";
import { BeatmapManager } from "../manager/BeatmapManager";
import { GameSimulator } from "../common/game/GameSimulator";
import { inject, injectable, optional } from "inversify";
import { NOOP_VIEWER_LIFECYCLE, VIEWER_LIFECYCLE_OBSERVER, ViewerLifecycleObserver } from "../common/ViewerLifecycleObserver";
import { PixiRendererManager } from "../renderers/PixiRendererManager";
import { AnalysisSceneManager } from "../manager/AnalysisSceneManager";
import { GameLoop } from "../common/game/GameLoop";
import { ScenarioManager } from "../manager/ScenarioManager";
import { ReplayFileWatcher } from "../common/local/ReplayFileWatcher";
import { OsuFolderService } from "../common/local/OsuFolderService";
import { ClipRecorder } from "../manager/ClipRecorder";
import { ModSettingsService } from "./mod-settings";
import { ScreenshotTaker } from "./screenshot";
import { PerformanceTimelineService } from "./performance/PerformanceTimelineService";
import { ReplayDisplaySettingsStore } from "./replay-display-settings";
import { ClipExportSettingsStore } from "./clip-export-settings";
import { InspectorLayoutSettingsStore } from "./inspector-layout-settings";
import { readoutAt } from "./readout-source";
import { ErrorOutlineStore } from "../common/error-outline";
import type { Observable } from "rxjs";

@injectable()
export class AnalysisApp {
  private initialized = false;
  private viewerVisible = true;
  private readonly lifecycle: ViewerLifecycleObserver;
  constructor(
    public readonly gameClock: GameplayClock,
    public readonly gameSimulator: GameSimulator,
    public readonly scenarioManager: ScenarioManager,
    public readonly modSettingsService: ModSettingsService,
    public readonly replayWatcher: ReplayFileWatcher,
    public readonly screenshotTaker: ScreenshotTaker,
    public readonly clipRecorder: ClipRecorder,
    public readonly osuFolderService: OsuFolderService,
    private readonly replayService: ReplayService,
    private readonly gameLoop: GameLoop,
    private readonly beatmapManager: BeatmapManager,
    private readonly sceneManager: AnalysisSceneManager,
    private readonly pixiRenderer: PixiRendererManager,
    public readonly performanceTimeline: PerformanceTimelineService,
    public readonly replayDisplaySettingsStore: ReplayDisplaySettingsStore,
    public readonly clipExportSettingsStore: ClipExportSettingsStore,
    public readonly inspectorLayoutSettingsStore: InspectorLayoutSettingsStore,
    public readonly errorOutlineStore: ErrorOutlineStore,
    @inject(VIEWER_LIFECYCLE_OBSERVER) @optional() lifecycle?: ViewerLifecycleObserver,
  ) {
    this.lifecycle = lifecycle === undefined ? NOOP_VIEWER_LIFECYCLE : lifecycle;
    if (this.lifecycle.enabled) this.lifecycle.record("analyzer-created", this);
  }

  get frameRendered$(): Observable<void> {
    return this.gameLoop.frameRendered$;
  }

  stats() {
    return this.gameLoop.stats();
  }

  initialize() {
    if (this.initialized) return;
    this.initialized = true;
    console.log("AnalysisApp: Initialize");
    this.clipRecorder.state$.subscribe(() => {
      this.gameClock.controlsLocked = this.clipRecorder.isBusy;
    });
    this.scenarioManager.setBeforeReplayChange(() => this.clipRecorder.cancel());
    this.scenarioManager.loadState$?.subscribe(state => {
      // A source load can finish after Library navigation; keep that loaded scenario,
      // but retire the ticker that ScenarioManager starts at readiness.
      if (state.phase === "ready" && !this.isViewerVisible()) {
        this.gameClock.pause();this.gameLoop.stopTicker();
      }
    });
    this.clipRecorder.setReadoutSource((settings) => readoutAt(this, settings));
    this.replayWatcher.startWatching();
    this.scenarioManager.initialize();
  }

  onEnter(canvas: HTMLCanvasElement) {
    if (this.lifecycle?.enabled) this.lifecycle.record("viewer-enter", this, { canvasId: this.lifecycle.id(canvas) });
    this.pixiRenderer.initializeRenderer(canvas);
    if (this.isViewerVisible() && this.scenarioManager.scenario$.getValue().status === "DONE") {
      this.gameLoop.startTicker();
    }
  }

  isViewerVisible(): boolean { return this.viewerVisible !== false; }

  /** Library navigation retains the scenario, comparison, canvas and resources. */
  setViewerVisible(visible: boolean): boolean {
    this.observeVisibility("viewer-visibility-request", visible);
    if (visible === this.isViewerVisible()) { this.observeVisibility("viewer-visibility-accepted", visible); return true; }
    // Navigation must not interfere with the recorder's owned transport/capture.
    if (!visible && this.clipRecorder.isBusy) { this.observeVisibility("viewer-visibility-rejected", visible); return false; }
    this.viewerVisible = visible;
    if (!visible) { this.gameClock.pause();this.gameClock.releaseSpeed?.();this.gameLoop.stopTicker(); }
    else if (this.scenarioManager.scenario$.getValue().status === "DONE") this.gameLoop.startTicker();
    this.observeVisibility("viewer-visibility-accepted", visible);
    return true;
  }

  private observeVisibility(kind: string, requestedVisible: boolean): void {
    if (!this.lifecycle?.enabled) return;
    const replay = this.gameSimulator.getPrimaryReplay();
    this.lifecycle.record(kind, this, {
      requestedVisible, visible: this.isViewerVisible(), scenarioId: this.lifecycle.id(this.scenarioManager),
      clockId: this.lifecycle.id(this.gameClock), simulatorId: this.lifecycle.id(this.gameSimulator),
      rendererId: this.lifecycle.id(this.pixiRenderer.getRenderer()),
      phase: this.scenarioManager.loadState$.value.phase, scenario: this.scenarioManager.scenario$.value.status,
      elapsedMs: this.gameClock.timeElapsedInMs, durationMs: this.gameClock.durationInMs,
      playing: this.gameClock.isPlaying, speed: this.gameClock.viewerSpeed,
      baseRate: this.gameClock.baseRate, playbackRate: this.gameClock.playbackRate,
      replaySha256: replay?.replayContentSha256 ?? null, ruleset: this.gameSimulator.getRulesetFocus(),
    });
  }

  onHide() {
    if (this.lifecycle?.enabled) this.lifecycle.record("viewer-hide", this);
    void this.clipRecorder.cancel({ restorePlayback: false });
    this.gameClock.pause();
    this.gameLoop.stopTicker();
    this.pixiRenderer.destroy();
  }

  /**
   * Loads the replay and the corresponding beatmap and makes the application ready to visualize the replay.
   *
   * Note: This procedure can be optimized in the future, but for now it's ok.
   *
   * @param replayId the id of the replay to load
   */
  async loadReplay(replayId: string) {
    return this.scenarioManager.loadReplay(replayId);
  }

  async loadComparisonReplay(replayId: string) {
    return this.scenarioManager.loadComparisonReplay(replayId);
  }

  compareWithAutoplayReference() {
    return this.scenarioManager.compareWithAutoplayReference();
  }

  clearReplayComparison() {
    this.scenarioManager.clearReplayComparison();
  }

  getBeatmap() {
    return this.beatmapManager.getBeatmap();
  }
}
