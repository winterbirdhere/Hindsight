import { injectable } from "inversify";
import { BehaviorSubject, Subject } from "rxjs";

const getNowInMs = () => performance.now();

export interface OfflineClockCapture {
  setTime(timeMs: number): void;
  dispose(): void;
}

@injectable()
export class GameplayClock {
  public isPlaying$: BehaviorSubject<boolean>;
  public durationInMs$: BehaviorSubject<number>;
  /** Viewer-selected multiplier. 1x always means the replay's original modded rate. */
  public speed$: BehaviorSubject<number>;
  /** Clock rate supplied by the replay's mods (DT/NC=1.5, HT=0.75, otherwise 1). */
  public baseRate$: BehaviorSubject<number>;
  /** Actual clock/audio playback rate: baseRate * viewer multiplier. */
  public playbackRate$: BehaviorSubject<number>;

  public seeked$: Subject<number>;
  /** Blocks external gesture handlers while the recorder owns transport. */
  public controlsLocked = false;

  // Things that get updated very often should not be Subjects due to performance issues
  public timeElapsedInMs = 0;
  private lastUpdateTimeInMs = 0;
  private timeSource?: () => number;
  private analysisEndInMs = 0;
  private playbackBoundary?: number;
  // The viewer's speed while another one is held with a key; undefined when none is.
  private heldFrom?: number;
  private offlineCapture?: { timeMs: number };

  constructor() {
    this.isPlaying$ = new BehaviorSubject<boolean>(false);
    this.durationInMs$ = new BehaviorSubject<number>(0);
    this.speed$ = new BehaviorSubject<number>(1);
    this.baseRate$ = new BehaviorSubject<number>(1);
    this.playbackRate$ = new BehaviorSubject<number>(1);
    this.seeked$ = new Subject<number>();
  }

  /**
   * Tick should only be used once in each frame and for the rest of the frame one should refer to `timeElapsedInMs`.
   * This is to ensure that every related game object is referring to the same time at the same time.
   */
  tick() {
    if (this.offlineCapture) {
      if (this.isPlaying) throw new Error("Offline capture requires a paused clock");
      return (this.timeElapsedInMs = this.offlineCapture.timeMs);
    }
    this.updateTimeElapsed();
    const boundary = this.playbackBoundary ?? this.durationInMs;
    if (this.playbackBoundary !== undefined && this.timeElapsedInMs >= boundary) {
      this.pause();
      this.timeElapsedInMs = boundary;
    } else if (this.timeElapsedInMs >= this.durationInMs) {
      this.pause();
      this.timeElapsedInMs = this.durationInMs;
    }
    return this.timeElapsedInMs;
  }

  get speed() {
    return this.speed$.getValue();
  }

  set speed(value: number) {
    this.speed$.next(value);
    this.updatePlaybackRate();
  }

  get baseRate() {
    return this.baseRate$.getValue();
  }

  get playbackRate() {
    return this.playbackRate$.getValue();
  }

  get durationInMs() {
    return this.durationInMs$.getValue();
  }

  set durationInMs(value: number) {
    this.durationInMs$.next(Math.max(0, this.analysisEndInMs, Number.isFinite(value) ? value : 0));
  }

  get isPlaying() {
    return this.isPlaying$.getValue();
  }

  set isPlaying(value: boolean) {
    if (value && this.offlineCapture) throw new Error("Offline capture owns the paused clock");
    this.isPlaying$.next(value);
  }

  updateTimeElapsed() {
    if (this.offlineCapture || !this.isPlaying) return;
    const nowInMs = getNowInMs();
    const sourceTime = this.timeSource?.();
    // Use the song's position when attached. A separate wall clock otherwise
    // keeps moving through media startup/seeking delays and can drift from it.
    this.timeElapsedInMs =
      sourceTime !== undefined && Number.isFinite(sourceTime)
        ? sourceTime
        : this.timeElapsedInMs + this.playbackRate * (nowInMs - this.lastUpdateTimeInMs);
    this.lastUpdateTimeInMs = nowInMs;
  }

  /** Song time in beatmap milliseconds; undefined restores standalone playback. */
  setTimeSource(source: (() => number) | undefined) {
    this.updateTimeElapsed();
    this.timeSource = source;
    this.lastUpdateTimeInMs = getNowInMs();
  }

  toggle() {
    if (this.isPlaying) this.pause();
    else this.start();
  }

  start() {
    if (this.offlineCapture) throw new Error("Offline capture owns the paused clock");
    if (this.isPlaying) return;

    if (this.timeElapsedInMs >= this.durationInMs) {
      this.seekTo(0);
    }
    this.lastUpdateTimeInMs = getNowInMs();
    this.isPlaying = true;
  }

  pause() {
    if (!this.isPlaying) return;
    this.updateTimeElapsed();
    this.isPlaying = false;
  }

  setSpeed(speed: number) {
    if (!Number.isFinite(speed) || speed <= 0) return;
    this.updateTimeElapsed();
    // A speed that is set outright stays: it ends a hold, and the key's release gives nothing back.
    this.heldFrom = undefined;
    this.speed = speed;
  }

  /** The viewer's own speed: what a held speed gives back on release, the speed itself otherwise. */
  get viewerSpeed() {
    return this.heldFrom ?? this.speed;
  }

  /** Plays at `speed` until `releaseSpeed`, for a key that is held down. A second hold changes nothing. */
  holdSpeed(speed: number) {
    if (!Number.isFinite(speed) || speed <= 0 || this.heldFrom !== undefined) return;
    const viewerSpeed = this.speed;
    this.setSpeed(speed);
    this.heldFrom = viewerSpeed;
  }

  /** Gives the viewer's speed back after `holdSpeed`. Does nothing when no speed is held any more. */
  releaseSpeed() {
    if (this.heldFrom !== undefined) this.setSpeed(this.heldFrom);
  }

  setBaseRate(baseRate: number) {
    if (!Number.isFinite(baseRate) || baseRate <= 0) return;
    this.updateTimeElapsed();
    this.baseRate$.next(baseRate);
    this.updatePlaybackRate();
  }

  setDuration(durationInMs: number) {
    console.debug(`GameClock duration has been set to ${durationInMs}ms`);
    this.durationInMs = durationInMs;
  }

  /** Media metadata must never hide later objects, judgements, or replay frames. */
  setAnalysisEnd(timeInMs: number) {
    this.analysisEndInMs = Number.isFinite(timeInMs) ? Math.max(0, timeInMs) : 0;
    this.durationInMs = Math.max(this.durationInMs, this.analysisEndInMs);
  }

  seekTo(timeInMs: number) {
    if (this.offlineCapture) throw new Error("Offline capture owns the paused clock");
    if (!Number.isFinite(timeInMs)) return;
    timeInMs = Math.min(this.durationInMs, Math.max(0, timeInMs));
    this.timeElapsedInMs = timeInMs;
    this.lastUpdateTimeInMs = getNowInMs();
    this.seeked$.next(timeInMs);
  }

  /** Set exact export timestamps without seeking audio or advancing with wall time. */
  beginOfflineCapture(): OfflineClockCapture {
    if (this.offlineCapture) throw new Error("An offline clock capture is already active");
    if (this.isPlaying) throw new Error("Offline capture requires a paused clock");
    const capture = { timeMs: this.timeElapsedInMs };
    this.offlineCapture = capture;
    return {
      setTime: (timeMs) => {
        if (this.offlineCapture !== capture) throw new Error("The offline clock capture is no longer active");
        if (this.isPlaying) throw new Error("Offline capture requires a paused clock");
        if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > this.durationInMs) {
          throw new Error("Invalid offline capture timestamp");
        }
        capture.timeMs = timeMs;
        this.timeElapsedInMs = timeMs;
      },
      dispose: () => {
        if (this.offlineCapture !== capture) return;
        this.offlineCapture = undefined;
        this.lastUpdateTimeInMs = getNowInMs();
      },
    };
  }

  get playbackBoundaryInMs() {
    return this.playbackBoundary;
  }

  /** A temporary one-pass endpoint, used by the clip recorder. */
  setPlaybackBoundary(endMs: number | undefined) {
    this.playbackBoundary =
      endMs !== undefined && Number.isFinite(endMs) ? Math.min(this.durationInMs, Math.max(0, endMs)) : undefined;
  }

  clear() {
    // Invalidates a stale export owner when a replay is torn down.
    this.offlineCapture = undefined;
    this.pause();
    // Publish the reset position with the following transport notifications,
    // even when the replay renderer stops before it can emit another frame.
    this.timeElapsedInMs = 0;
    this.playbackBoundary = undefined;
    this.analysisEndInMs = 0;
    this.heldFrom = undefined;
    this.speed = 1.0;
    this.baseRate$.next(1.0);
    this.updatePlaybackRate();
    // This is just ahot fix
    this.durationInMs$.next(1);
  }

  private updatePlaybackRate() {
    this.playbackRate$.next(this.baseRate * this.speed);
  }
}
