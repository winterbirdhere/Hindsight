import * as PIXI from "pixi.js";
import { Container } from "pixi.js";
import { injectable } from "inversify";
import { Playfield, PlayfieldFactory } from "../playfield/PlayfieldFactory";
import { ForegroundHUDPreparer } from "../hud/ForegroundHUDPreparer";
import { PixiRendererManager } from "../../PixiRendererManager";
import { BeatmapBackground, BeatmapBackgroundFactory } from "../background/BeatmapBackground";
import { KeyPressWithNoteSheetPreparer } from "../keypresses/KeyPressOverlay";
import { calculateAnalysisStageLayout, type LocalBounds } from "./AnalysisStageLayout";
import {
  EXPORT_STAGE_FRAME,
  liveStageFrame,
  sameStageFrame,
  STAGE_FRAME_HEIGHT,
  type StageFrame,
} from "./stage-frame";
import {
  type KeyOverlayLength,
  ReplayDisplaySettings,
  ReplayDisplaySettingsStore,
} from "../../../analysis/replay-display-settings";
import type { ClipExportOptions } from "../../../manager/clip-export-types";

type CaptureLayers = Pick<
  ClipExportOptions,
  | "showKeys"
  | "showTiming"
  | "showHitErrorBar"
  | "showReplayCursor"
  | "showAnalysisCursor"
  | "showComparisonCursor"
  | "displaySettings"
>;

/** UR/bias live in the stats overlay now (spec §2.1); the live canvas never draws that text. */
export function liveHudSettings(settings: Readonly<ReplayDisplaySettings>): ReplayDisplaySettings {
  return { ...settings, unstableRateEnabled: false, timingBiasEnabled: false };
}

// This is a custom analysis stage that composes all the things it needs
// Other stages for example do not want a foreground HUD and should therefore compose differently.
@injectable()
export class AnalysisStage {
  private screenWidth = 0;
  private screenHeight = 0;

  public stage: Container;
  private playfield: Playfield;
  private background: BeatmapBackground;
  private overlayBounds: LocalBounds;
  private frame?: StageFrame;
  private liveFrame: StageFrame = liveStageFrame(1600, 900);
  private captureLayers?: { options: CaptureLayers; settings: Readonly<ReplayDisplaySettings> };

  constructor(
    private rendererManager: PixiRendererManager,
    beatmapBackground: BeatmapBackgroundFactory,
    playfieldFactory: PlayfieldFactory,
    private foregroundHUDPreparer: ForegroundHUDPreparer,
    private keyPressOverlayPreparer: KeyPressWithNoteSheetPreparer,
    private replayDisplaySettingsStore: ReplayDisplaySettingsStore,
  ) {
    this.background = beatmapBackground.createBeatmapBackground({ width: EXPORT_STAGE_FRAME.width, height: STAGE_FRAME_HEIGHT });
    this.playfield = playfieldFactory.createPlayfield();
    this.stage = new PIXI.Container();
    this.stage.addChild(
      this.background.container,
      this.playfield.container,
      this.foregroundHUDPreparer.container,
      this.keyPressOverlayPreparer.container,
    );
    this.playfield.container.interactiveChildren = false;
    // The overlay's panel rectangle defines its size, so drawn presses never change the layout.
    const overlay = this.keyPressOverlayPreparer.keyPressOverlay;
    overlay.setLength(this.replayDisplaySettingsStore.settings.keyOverlayLength);
    this.overlayBounds = overlay.bounds;
    this.applyFrame(this.liveFrame);
    this.keyPressOverlayPreparer.container.visible = this.replayDisplaySettingsStore.settings.keyOverlapEnabled;
  }

  /** Lays out background, playfield, key overlay and HUD anchors for one virtual frame. */
  applyFrame(frame: StageFrame | undefined) {
    // Instances built with Object.create in tests have no frame or layers yet.
    if (!frame) return;
    const overlay = this.keyPressOverlayPreparer?.container;
    if (!this.background || !this.playfield || !overlay || !this.overlayBounds) return;
    if (sameStageFrame(this.frame, frame)) return;
    this.frame = frame;
    this.background.resize({ width: frame.width, height: frame.height });
    const layout = calculateAnalysisStageLayout(this.overlayBounds, frame);
    this.playfield.container.position.set(layout.playfield.left, layout.playfield.top);
    this.playfield.container.scale.set(layout.playfield.scale);
    if (layout.keyPressOverlay) {
      overlay.scale.set(layout.keyPressOverlay.scale);
      overlay.position.set(layout.keyPressOverlay.positionX, layout.keyPressOverlay.positionY);
    }
    this.foregroundHUDPreparer.setHudAnchors?.(layout.hud);
  }

  /** Gives the overlay a length (and a wheel zoom to put back, if any) and has the next frame laid out again. */
  private setKeyOverlayLength(length: KeyOverlayLength, windowDuration?: number) {
    const overlay = this.keyPressOverlayPreparer.keyPressOverlay;
    overlay.setLength(length, windowDuration);
    this.overlayBounds = overlay.bounds;
    // The panel's width changed, not the frame: let `applyFrame` run for the same frame.
    this.frame = undefined;
  }

  /**
   * A capture draws the clip's own length at that length's window. The returned function puts the viewer's length
   * and wheel zoom back; lay the frame out after either.
   */
  private useCaptureKeyOverlayLength(options: CaptureLayers, settings: Readonly<ReplayDisplaySettings>): () => void {
    const { length, windowDuration } = this.keyPressOverlayPreparer.keyPressOverlay;
    this.setKeyOverlayLength(options.displaySettings?.keyOverlayLength ?? settings.keyOverlayLength);
    return () => this.setKeyOverlayLength(length, windowDuration);
  }

  /** The canvas is the analyzer's centre cell: height maps to 900 units, width follows the cell. */
  resizeTo() {
    const screen = this.rendererManager.getRenderer()?.screen;
    if (!screen || screen.width <= 0 || screen.height <= 0) return;
    if (this.screenWidth === screen.width && this.screenHeight === screen.height) return;
    [this.screenWidth, this.screenHeight] = [screen.width, screen.height];
    // `screen` is in CSS px (autoDensity), which is what the stats-overlay reserve is measured in.
    this.liveFrame = liveStageFrame(screen.width, screen.height);
    const scale = screen.height / STAGE_FRAME_HEIGHT;
    this.stage.scale.set(scale, scale);
    this.stage.position.set(0, 0);
    if (!this.captureLayers) this.applyFrame(this.liveFrame);
  }

  updateAnalysisStage() {
    // Maybe resizing should also be push based (with some debouncing)
    if (!this.captureLayers) this.resizeTo();
    this.playfield.updatePlayfield();
    if (this.captureLayers) {
      this.prepareCaptureLayers(this.captureLayers.options, this.captureLayers.settings, true);
      return;
    }
    this.foregroundHUDPreparer.updateHUD(liveHudSettings(this.replayDisplaySettingsStore.settings));
    const { keyOverlayLength } = this.replayDisplaySettingsStore.settings;
    if (this.keyPressOverlayPreparer.keyPressOverlay.length !== keyOverlayLength) {
      this.setKeyOverlayLength(keyOverlayLength);
      this.applyFrame(this.liveFrame);
    }
    const keyPressOverlayVisible = this.replayDisplaySettingsStore.settings.keyOverlapEnabled;
    if (!keyPressOverlayVisible && this.keyPressOverlayPreparer.container.visible) {
      // The overlay listens for wheel input on window. Clear its hover state as
      // it is hidden so it cannot keep seeking or zooming after disappearing.
      this.keyPressOverlayPreparer.keyPressOverlay.onMouseOut();
    }
    this.keyPressOverlayPreparer.container.visible = keyPressOverlayVisible;
    if (keyPressOverlayVisible) this.keyPressOverlayPreparer.update();
  }

  destroy(): void {
    // Do nothing
  }

  /** Hold capture appearance while offline frames are prepared; restore once on exit. */
  beginCaptureLayers(
    options: CaptureLayers,
    settings: Readonly<ReplayDisplaySettings> = this.replayDisplaySettingsStore.settings,
  ): { dispose(): void } {
    if (this.captureLayers) throw new Error("Capture layers are already active");
    const keys = this.keyPressOverlayPreparer.container;
    const timing = this.foregroundHUDPreparer.stats;
    const bar = this.foregroundHUDPreparer.hitErrorBar.container;
    const previous = [keys.visible, timing.visible, bar.visible];
    const capture = { options, settings };
    this.captureLayers = capture;
    const restoreKeyOverlayLength = this.useCaptureKeyOverlayLength(options, settings);
    this.applyFrame(EXPORT_STAGE_FRAME);
    return {
      dispose: () => {
        if (this.captureLayers !== capture) return;
        this.captureLayers = undefined;
        restoreKeyOverlayLength();
        try {
          this.applyFrame(this.liveFrame);
          this.foregroundHUDPreparer.updateHUD(liveHudSettings(this.replayDisplaySettingsStore.settings));
        } finally {
          [keys.visible, timing.visible, bar.visible] = previous;
          this.updateCaptureTransforms();
        }
      },
    };
  }

  private updateCaptureTransforms() {
    const timing = this.foregroundHUDPreparer.stats;
    // Export renders with skipUpdateTransform, so refresh every layer a frame change moved.
    for (const child of this.stage?.children ?? []) if (child.parent) child.updateTransform();
    if (this.foregroundHUDPreparer.container.parent) this.foregroundHUDPreparer.container.updateTransform();
    else if (timing.parent) timing.updateTransform();
  }

  private prepareCaptureLayers(options: CaptureLayers, settings: Readonly<ReplayDisplaySettings>, updateKeys = false) {
    const keys = this.keyPressOverlayPreparer.container;
    const timing = this.foregroundHUDPreparer.stats;
    // UR and bias are drawn by the clip's stats column, never as Pixi text.
    const captureSettings = { ...settings, ...options.displaySettings, unstableRateEnabled: false, timingBiasEnabled: false };
    const showHitErrorBar = options.showHitErrorBar ?? options.showTiming;
    if (options.showKeys && (updateKeys || !keys.visible)) this.keyPressOverlayPreparer.update();
    keys.visible = options.showKeys;
    if (keys.parent && keys.visible) keys.updateTransform();
    this.foregroundHUDPreparer.updateHUD(captureSettings, showHitErrorBar);
    timing.visible = false;
    this.foregroundHUDPreparer.hitErrorBar.container.visible = showHitErrorBar;
  }

  private withCaptureCursors<T>(options: CaptureLayers, render: () => T): T {
    const hasCursorOverrides =
      options.showReplayCursor !== undefined ||
      options.showAnalysisCursor !== undefined ||
      options.showComparisonCursor !== undefined;
    return hasCursorOverrides ? this.playfield.withCaptureCursors(options, render) : render();
  }

  /** Capture options are scoped to one GPU render and never persisted as preferences. */
  withCaptureLayers<T>(
    options: CaptureLayers,
    render: () => T,
    settings: Readonly<ReplayDisplaySettings> = this.replayDisplaySettingsStore.settings,
  ): T {
    if (this.captureLayers) return this.withCaptureCursors(options, render);
    const keys = this.keyPressOverlayPreparer.container;
    const timing = this.foregroundHUDPreparer.stats;
    const bar = this.foregroundHUDPreparer.hitErrorBar.container;
    const previous = [keys.visible, timing.visible, bar.visible];
    const restoreKeyOverlayLength = this.useCaptureKeyOverlayLength(options, settings);
    try {
      this.applyFrame(EXPORT_STAGE_FRAME);
      this.prepareCaptureLayers(options, settings);
      // The export frame holds for this render only (the live frame comes back
      // in `finally`). The render skips transform updates, so refresh them here.
      this.updateCaptureTransforms();
      return this.withCaptureCursors(options, render);
    } finally {
      [keys.visible, timing.visible, bar.visible] = previous;
      restoreKeyOverlayLength();
      this.applyFrame(this.liveFrame);
      this.foregroundHUDPreparer.updateHUD(liveHudSettings(this.replayDisplaySettingsStore.settings));
      this.updateCaptureTransforms();
    }
  }
}
