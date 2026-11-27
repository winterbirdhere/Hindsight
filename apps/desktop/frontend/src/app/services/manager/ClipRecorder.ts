import { injectable } from "inversify";
import { BehaviorSubject, Subscription } from "rxjs";
import { frontendAPI } from "../../api";
import { PixiRendererManager } from "../renderers/PixiRendererManager";
import { AnalysisStage } from "../renderers/components/stage/AnalysisStage";
import { GameLoop } from "../common/game/GameLoop";
import { AudioCaptureSession, AudioEngine } from "../common/audio/AudioEngine";
import { GameplayClock } from "../common/game/GameplayClock";
import { BeatmapBackgroundSettingsStore } from "../common/beatmap-background";
import { GameSimulator } from "../common/game/GameSimulator";
import { PerformanceTimelineService } from "../analysis/performance/PerformanceTimelineService";
import { ReplayDisplaySettings, ReplayDisplaySettingsStore } from "../analysis/replay-display-settings";
import { ClipExportRenderer } from "./ClipExportRenderer";
import {
  createClipFramePlan,
  ClipChunkWriter,
  ClipExportFormat,
  ClipExportOptions,
  ClipRecorderState,
  ClipRunSummary,
  validateClipOptions,
} from "./clip-export-types";
import type { ReadoutModel, ReadoutSettings } from "../analysis/readout-model";
import { MAX_CLIP_FRAME_CHUNK_BYTES } from "../../../../../shared/clip-export";
import { ClipFrameChunkBuffer } from "./clip-frame-chunks";

export type {
  ClipExportFormat,
  ClipExportOptions,
  ClipRecorderState,
  ClipExportState,
  ClipRunSummary,
} from "./clip-export-types";

interface ExportRun {
  abort: AbortController;
  restorePlayback: boolean;
  done?: Promise<void>;
}

@injectable()
export class ClipRecorder {
  readonly state$ = new BehaviorSubject<ClipRecorderState>({ status: "idle", progress: 0 });
  /** The running or last export's settings and frame plan; cleared when the next export starts. */
  readonly run$ = new BehaviorSubject<ClipRunSummary | undefined>(undefined);
  private active?: ExportRun;
  private readoutSource?: (settings: ReadoutSettings) => ReadoutModel | undefined;

  setReadoutSource(source: (settings: ReadoutSettings) => ReadoutModel | undefined) {
    this.readoutSource = source;
  }

  constructor(
    private readonly renderManager: PixiRendererManager,
    private readonly stage: AnalysisStage,
    private readonly gameLoop: GameLoop,
    private readonly audioEngine: AudioEngine,
    private readonly clock: GameplayClock,
    private readonly simulator: GameSimulator,
    private readonly performanceTimeline: PerformanceTimelineService,
    private readonly displaySettings: ReplayDisplaySettingsStore,
    private readonly background: BeatmapBackgroundSettingsStore,
  ) {}

  get isBusy(): boolean {
    return ["preparing", "recording", "rendering", "saving"].includes(this.state$.value.status);
  }

  getFormat(): ClipExportFormat {
    // Video is encoded by the bundled native encoder, independent of a display
    // or MediaRecorder's real-time video throughput.
    return { mimeType: "video/mp4", extension: "mp4", label: "MP4 (H.264)" };
  }

  exportClip(options: ClipExportOptions): Promise<void> {
    if (this.active) return this.active.done ?? Promise.resolve();
    const run: ExportRun = { abort: new AbortController(), restorePlayback: true };
    this.active = run;
    this.run$.next(undefined);
    this.state$.next({ status: "preparing", progress: 0 });
    run.done = this.runExport(
      {
        ...options,
        ...(options.displaySettings &&
        typeof options.displaySettings === "object" &&
        !Array.isArray(options.displaySettings)
          ? { displaySettings: { ...options.displaySettings } }
          : {}),
      },
      run,
    ).finally(() => {
      if (this.active === run) this.active = undefined;
    });
    return run.done;
  }

  async cancel(options?: { restorePlayback?: boolean }): Promise<void> {
    const run = this.active;
    if (!run) return;
    if (options?.restorePlayback === false) run.restorePlayback = false;
    run.abort.abort();
    await run.done;
  }

  private createRenderer(
    canvas: HTMLCanvasElement,
    options: ClipExportOptions,
    settings: Readonly<ReplayDisplaySettings> = this.displaySettings.settings,
  ) {
    const renderer = this.renderManager.getRenderer();
    if (!renderer) throw new Error("The replay renderer is unavailable");
    return new ClipExportRenderer(
      canvas,
      renderer,
      this.stage,
      this.simulator,
      this.clock,
      this.performanceTimeline,
      options,
      {
        ...settings,
      },
      this.readoutSource,
      // The clip's stats have the shade the viewer's have.
      this.background.settings.statsShade === true,
      false,
    );
  }

  private async runExport(options: ClipExportOptions, run: ExportRun): Promise<void> {
    const signal = run.abort.signal;
    let snapshot: { time: number; speed: number; playing: boolean; boundary: number | undefined } | undefined;
    const replay = this.simulator.getPrimaryReplay();
    const ruleset = this.simulator.getRulesetFocus();
    let session: { id: string; path: string } | null = null;
    let renderer: ClipExportRenderer | undefined;
    let audio: AudioCaptureSession | undefined;
    let writer: ClipChunkWriter | undefined;
    let offline: ReturnType<GameLoop["beginOfflineCapture"]> | undefined;
    let offlineError: Error | undefined;
    let committed = false;
    let transportChanged = false;
    let outcome: ClipRecorderState = { status: "cancelled", progress: 0 };
    let abortWrite: Promise<void> | undefined;
    const abortSession = () => {
      writer?.cancel();
      if (session && !committed && !abortWrite) {
        abortWrite = frontendAPI.abortClipExport(session.id).catch((error) => {
          console.warn("Could not discard clip export", error);
        });
      }
    };
    signal.addEventListener("abort", abortSession);
    const checkView = () => {
      if (signal.aborted) throw new Error("Clip export cancelled");
      if (offlineError) throw offlineError;
      if (
        this.simulator.getPrimaryReplay() !== replay ||
        this.simulator.getRulesetFocus() !== ruleset ||
        !this.renderManager.getRenderer()
      )
        throw new Error("The replay view changed during export");
    };
    try {
      validateClipOptions(options, this.clock.durationInMs);
      if (!replay || !this.renderManager.getRenderer()) throw new Error("Load a replay before exporting a clip");
      const plan = createClipFramePlan(
        options.startMs,
        options.endMs,
        this.clock.baseRate * options.speed,
        options.fps,
      );
      this.run$.next({
        startMs: options.startMs,
        endMs: options.endMs,
        width: options.width,
        fps: options.fps,
        audio: options.audio,
        speed: options.speed,
        frameCount: plan.frameCount,
        durationSeconds: plan.durationSeconds,
      });
      const capturedSettings = { ...this.displaySettings.settings, ...options.displaySettings };
      if (options.showStats && (capturedSettings.performancePointsEnabled || capturedSettings.starRatingEnabled)) {
        await this.performanceTimeline.waitForSettled(signal);
        checkView();
      }
      snapshot = {
        time: this.clock.timeElapsedInMs,
        speed: this.clock.speed,
        playing: this.clock.isPlaying,
        boundary: this.clock.playbackBoundaryInMs,
      };
      this.clock.pause();
      transportChanged = true;
      this.clock.setPlaybackBoundary(options.endMs);
      this.clock.setSpeed(options.speed);
      this.clock.seekTo(options.startMs);
      await this.waitForFrame(signal);
      checkView();
      renderer = this.createRenderer(document.createElement("canvas"), options, capturedSettings);
      renderer.render();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      session = await frontendAPI.beginClipExport({
        fileName: `Hindsight ${replay.player} ${stamp}.mp4`,
        extension: "mp4",
        ...(options.saveFolder ? { directory: options.saveFolder } : {}),
        video: {
          width: options.width,
          height: (options.width * 9) / 16,
          fps: options.fps,
          frameCount: plan.frameCount,
          audio: options.audio,
        },
      });
      if (signal.aborted) abortSession();
      checkView();
      if (!session) {
        run.abort.abort();
        checkView();
      }
      const recordingSession = session as { id: string; path: string };
      if (options.audio) {
        audio = this.audioEngine.beginCapture(true);
        this.clock.seekTo(options.startMs);
        await this.audioEngine.prepareCapture(signal);
        checkView();
        if (!audio.stream?.getAudioTracks().length) throw new Error("Clip audio capture is unavailable");
        await this.recordAudio(audio.stream, options, signal, recordingSession.id, checkView, (value) => {
          writer = value;
        });
        await writer?.flush();
        checkView();
        audio.dispose();
        audio = undefined;
      }
      this.clock.pause();
      // One transport seek resets replay/audio state before acquiring the
      // render clock. Individual video frames never seek the media element.
      this.clock.seekTo(options.startMs);
      renderer.beginCapture();
      offline = this.gameLoop.beginOfflineCapture(
        (error) => {
          offlineError = error;
        },
        () => renderer!.render(),
      );
      this.state$.next({ status: "rendering", progress: 0 });
      let lastProgressAt = 0;
      const frameChunks = new ClipFrameChunkBuffer();
      for (let index = 0; index < plan.frameCount; index++) {
        checkView();
        offline.renderFrame(plan.timeAt(index), index === 0 ? 0 : 1000 / options.fps);
        const pixels = renderer.readFrame();
        // One frame and one bounded IPC chunk at a time. Slow rendering or
        // encoder backpressure affects export duration, never the frame grid.
        for (let offset = 0; offset < pixels.byteLength; offset += MAX_CLIP_FRAME_CHUNK_BYTES) {
          checkView();
          const chunk = frameChunks.chunk(pixels, offset);
          await frontendAPI.appendClipExportFrame(recordingSession.id, index, offset, chunk);
        }
        checkView();
        const now = performance.now();
        if (now - lastProgressAt >= 100 || index + 1 === plan.frameCount) {
          lastProgressAt = now;
          this.state$.next({ status: "rendering", progress: (index + 1) / plan.frameCount });
        }
        // Give cancellation, UI input and view teardown a turn even if an
        // unusually fast encoder resolves every write immediately.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      checkView();
      renderer.endCapture();
      offline.dispose();
      offline = undefined;
      this.state$.next({ status: "saving", progress: 1 });
      const result = await frontendAPI.finishClipExport(recordingSession.id);
      committed = true;
      outcome = { status: "done", progress: 1, path: result.path };
    } catch (error) {
      outcome = signal.aborted
        ? { status: "cancelled", progress: 0 }
        : { status: "error", progress: 0, error: error instanceof Error ? error.message : String(error) };
    } finally {
      signal.removeEventListener("abort", abortSession);
      writer?.cancel();
      const cleanup = (action: () => void) => {
        try {
          action();
        } catch (error) {
          console.warn("Could not clean up a clip resource", error);
        }
      };
      cleanup(() => renderer?.endCapture());
      cleanup(() => offline?.dispose());
      if (transportChanged) cleanup(() => this.clock.pause());
      cleanup(() => audio?.dispose());
      cleanup(() => renderer?.destroy());
      if (session && !committed) {
        abortSession();
        try {
          await writer?.flush();
        } catch {
          /* Abort discards incomplete audio too. */
        }
      }
      await abortWrite;
      const restoreSnapshot = snapshot;
      if (transportChanged && restoreSnapshot && this.simulator.getPrimaryReplay() === replay) {
        cleanup(() => this.clock.setPlaybackBoundary(restoreSnapshot.boundary));
        cleanup(() => this.clock.setSpeed(restoreSnapshot.speed));
        cleanup(() => this.clock.seekTo(restoreSnapshot.time));
        if (run.restorePlayback && this.renderManager.getRenderer()) cleanup(() => this.gameLoop.refresh());
        if (restoreSnapshot.playing && run.restorePlayback && this.renderManager.getRenderer())
          cleanup(() => this.clock.start());
      }
      this.state$.next(outcome);
    }
  }

  /** Capture the existing music/hitsound mix without the high-resolution video workload. */
  private recordAudio(
    stream: MediaStream,
    options: ClipExportOptions,
    signal: AbortSignal,
    sessionId: string,
    checkView: () => void,
    setWriter: (writer: ClipChunkWriter) => void,
  ): Promise<void> {
    if (typeof MediaRecorder === "undefined") return Promise.reject(new Error("Audio recording is unavailable"));
    const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) return Promise.reject(new Error("Audio recording is unavailable in this runtime"));
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 192_000 });
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let stopping = false;
      let endpointReached = false;
      let failed: Error | undefined;
      let lastTime = options.startMs;
      let lastAdvanceAt = performance.now();
      let lastProgressAt = 0;
      let recordingStartedAt = 0;
      const recordedPlaybackRate = this.clock.playbackRate;
      let stopTimeout: ReturnType<typeof setTimeout> | undefined;
      const subscription = new Subscription();
      const watchdog = setInterval(() => {
        if (!stopping && performance.now() - lastAdvanceAt > 5_000)
          stop(new Error("Playback stalled while recording audio"));
      }, 500);
      const cleanup = () => {
        clearInterval(watchdog);
        if (stopTimeout) clearTimeout(stopTimeout);
        subscription.unsubscribe();
        signal.removeEventListener("abort", abort);
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!endpointReached) failed ??= new Error("The audio encoder stopped before the clip finished");
        if (failed) reject(failed);
        else resolve();
      };
      const stop = (error?: Error) => {
        failed ??= error;
        if (stopping) return;
        stopping = true;
        this.clock.pause();
        subscription.unsubscribe();
        try {
          if (recorder.state === "inactive") {
            failed ??= new Error("The audio encoder stopped before the clip finished");
            finish();
          } else {
            stopTimeout = setTimeout(() => {
              failed ??= new Error("The audio encoder did not finish");
              finish();
            }, 10_000);
            recorder.stop();
          }
        } catch (error) {
          failed = new Error(String(error));
          finish();
        }
      };
      const abort = () => stop(new Error("Clip export cancelled"));
      const writer = new ClipChunkWriter(
        (sequence, data) => frontendAPI.appendClipExport(sessionId, sequence, data),
        stop,
      );
      setWriter(writer);
      recorder.ondataavailable = (event) => writer.push(event.data);
      recorder.onerror = () => stop(new Error("The audio encoder failed"));
      recorder.onstop = finish;
      signal.addEventListener("abort", abort, { once: true });
      subscription.add(
        this.gameLoop.frameRendered$.subscribe(() => {
          try {
            checkView();
            const time = this.clock.timeElapsedInMs;
            const now = performance.now();
            // Fixed-grid video cannot follow a delayed/stalled media element.
            // Allow the measured ~32 ms pitch-stretch/graph startup variation,
            // but fail a disrupted audio pass instead of publishing shifted sound.
            // Check before accepting B too: a late final tick can hide an overrun.
            const expectedElapsed = (time - options.startMs) / recordedPlaybackRate;
            const driftMs = now - recordingStartedAt - expectedElapsed;
            if (!Number.isFinite(driftMs) || Math.abs(driftMs) > 100) {
              stop(
                new Error(
                  `Audio playback lost sync with the clip (${Math.round(Math.abs(driftMs))} ms). Try exporting again.`,
                ),
              );
              return;
            }
            if (time > lastTime + 0.01) {
              lastTime = time;
              lastAdvanceAt = now;
            }
            if (now - lastProgressAt >= 100) {
              lastProgressAt = now;
              this.state$.next({
                status: "recording",
                progress: Math.min(1, Math.max(0, (time - options.startMs) / (options.endMs - options.startMs))),
              });
            }
            if (time >= options.endMs) {
              endpointReached = true;
              stop();
            } else if (!this.clock.isPlaying) stop(new Error("Playback stopped before the clip finished"));
          } catch (error) {
            stop(error instanceof Error ? error : new Error(String(error)));
          }
        }),
      );
      try {
        checkView();
        recordingStartedAt = performance.now();
        recorder.start(1000);
        this.state$.next({ status: "recording", progress: 0 });
        this.clock.start();
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private waitForFrame(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const subscription = new Subscription();
      const cleanup = () => {
        clearTimeout(timer);
        subscription?.unsubscribe();
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(new Error("Clip export cancelled"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("The replay view is not rendering"));
      }, 5_000);
      subscription.add(
        this.gameLoop.frameRendered$.subscribe(() => {
          cleanup();
          resolve();
        }),
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
