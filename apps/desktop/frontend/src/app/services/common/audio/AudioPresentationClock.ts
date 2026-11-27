export interface AudioPresentationSnapshot {
  /** Decoded media position in beatmap milliseconds, before output buffering. */
  mediaTimeInMs: number;
  /** Web Audio rendering time in seconds. */
  contextTime: number;
  /** performance.now(), in milliseconds. */
  performanceTime: number;
  playbackRate: number;
  isPlaying: boolean;
  isSeeking?: boolean;
  /** No more input is being rendered; already queued audio may still be audible. */
  isInputStopped?: boolean;
  contextState?: AudioContextState;
  outputTimestamp?: AudioTimestamp;
  baseLatency?: number;
  outputLatency?: number;
}

interface MediaPosition {
  contextTime: number;
  mediaTimeInMs: number;
  playbackRate: number;
}

function nonNegativeFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

// Chromium's pitch-preserving stretcher consumes input in bursts around its
// 20ms WSOLA windows. Correct the phase over five windows, rather than making
// the picture follow those consumption bursts. This filters an offset, not
// the advancing playback position, so it does not add 100ms of A/V delay.
// https://chromium.googlesource.com/chromium/src/+/8be8f34246c3ba8cc5d722906c0f21ff22c387d0
const MEDIA_PHASE_CORRECTION_SECONDS = 0.1;

/**
 * Maps the media positions supplied to Web Audio onto the output device's clock.
 *
 * Chromium's MediaElementAudioSource feeds its renderer with zero output delay:
 * https://chromium.googlesource.com/chromium/src/+/102.0.5005.167/third_party/blink/renderer/platform/media/webaudiosourceprovider_impl.cc#208
 * getOutputTimestamp supplies a context/performance pair, not a constant latency:
 * https://www.w3.org/TR/webaudio-1.0/#dom-audiocontext-getoutputtimestamp
 *
 * Keep this separate from the upstream clock used to schedule hitsounds. The
 * short media/context history preserves rate changes and queued end-of-song
 * audio instead of multiplying an entire queue by the newest playback rate.
 */
export class AudioPresentationClock {
  private positions: MediaPosition[] = [];
  private firstPosition = 0;
  private lastPresentationTime?: number;
  private resetTime?: number;
  private phasePosition?: MediaPosition;
  private phaseReference?: MediaPosition;
  private inputWasStopped = false;

  /** Call for each explicit seek, new song, and pause-position restoration. */
  reset(mediaTimeInMs: number): void {
    const time = nonNegativeFinite(mediaTimeInMs) ? mediaTimeInMs : 0;
    this.positions = [];
    this.firstPosition = 0;
    this.resetTime = time;
    this.lastPresentationTime = time;
    this.phasePosition = undefined;
    this.phaseReference = undefined;
    this.inputWasStopped = false;
  }

  read(snapshot: AudioPresentationSnapshot): number {
    const mediaTime = nonNegativeFinite(snapshot.mediaTimeInMs)
      ? snapshot.mediaTimeInMs
      : this.lastPresentationTime ?? 0;
    if (!snapshot.isPlaying || snapshot.isSeeking) {
      this.reset(mediaTime);
      return mediaTime;
    }
    if (snapshot.contextState !== undefined && snapshot.contextState !== "running") {
      return this.lastPresentationTime ?? mediaTime;
    }

    const rate = Number.isFinite(snapshot.playbackRate) && snapshot.playbackRate > 0 ? snapshot.playbackRate : 1;
    const latency = this.reportedLatency(snapshot);
    let presentationTime: number;
    if (nonNegativeFinite(snapshot.contextTime)) {
      this.remember(
        this.smoothMediaPosition(
          { contextTime: snapshot.contextTime, mediaTimeInMs: mediaTime, playbackRate: rate },
          snapshot.isInputStopped === true,
        ),
      );
      const outputContextTime = this.outputContextTime(snapshot, latency);
      presentationTime = this.mediaTimeAt(outputContextTime);
    } else {
      presentationTime = mediaTime - latency * rate * 1000;
    }

    // A changing device estimate may briefly move backwards. Hold the already
    // presented position until output catches up; only reset() permits a seek.
    const result = Math.max(this.lastPresentationTime ?? 0, this.resetTime ?? 0, presentationTime, 0);
    this.lastPresentationTime = result;
    return result;
  }

  private smoothMediaPosition(position: MediaPosition, inputStopped: boolean): MediaPosition {
    const current = this.phasePosition;
    if (
      !current ||
      position.contextTime < current.contextTime ||
      position.playbackRate !== current.playbackRate ||
      inputStopped ||
      this.inputWasStopped
    ) {
      // Transport discontinuities and real input starvation are not WSOLA
      // jitter. Preserve their exact media position and leave output history
      // intact so the destination can finish playing its queue.
      this.phaseReference = undefined;
      this.phasePosition = position;
      this.inputWasStopped = inputStopped;
      return position;
    }

    if (position.contextTime > current.contextTime) this.phaseReference = current;
    const reference = this.phaseReference;
    if (!reference) {
      this.phasePosition = position;
      return position;
    }

    // Repeated reads in the same render quantum use the same reference. This
    // allows a newer media observation without multiplying the correction by
    // the monitor's refresh rate. Rate changes establish a new phase above;
    // previous segments retain their rates in the presentation history.
    const elapsed = position.contextTime - reference.contextTime;
    const predictedMediaTime = reference.mediaTimeInMs + elapsed * position.playbackRate * 1000;
    const correction = -Math.expm1(-elapsed / MEDIA_PHASE_CORRECTION_SECONDS);
    this.phasePosition = {
      ...position,
      mediaTimeInMs: predictedMediaTime + (position.mediaTimeInMs - predictedMediaTime) * correction,
    };
    return this.phasePosition;
  }

  private reportedLatency(snapshot: AudioPresentationSnapshot): number {
    return (
      (nonNegativeFinite(snapshot.baseLatency) ? snapshot.baseLatency : 0) +
      (nonNegativeFinite(snapshot.outputLatency) ? snapshot.outputLatency : 0)
    );
  }

  private outputContextTime(snapshot: AudioPresentationSnapshot, fallbackLatency: number): number {
    const stamp = snapshot.outputTimestamp;
    if (
      stamp &&
      nonNegativeFinite(stamp.contextTime) &&
      nonNegativeFinite(stamp.performanceTime) &&
      nonNegativeFinite(snapshot.performanceTime) &&
      (stamp.contextTime > 0 || stamp.performanceTime > 0) &&
      stamp.contextTime <= snapshot.contextTime &&
      stamp.performanceTime <= snapshot.performanceTime
    ) {
      const elapsed = (snapshot.performanceTime - stamp.performanceTime) / 1000;
      // A stopped/stale output snapshot must not extrapolate indefinitely. This
      // is a freshness check, not a hardcoded device-latency correction.
      if (elapsed <= Math.max(1, fallbackLatency * 2)) {
        return Math.min(snapshot.contextTime, stamp.contextTime + elapsed);
      }
    }
    // The timestamp already includes destination/device delay. Add reported
    // processing + hardware latency only when a usable pair is unavailable.
    return snapshot.contextTime - fallbackLatency;
  }

  private remember(position: MediaPosition): void {
    const last = this.positions[this.positions.length - 1];
    if (last && position.contextTime < last.contextTime) {
      // Context recreation/device recovery changes its origin, not media time.
      this.positions = [];
      this.firstPosition = 0;
    } else if (last && position.contextTime === last.contextTime) {
      // Several animation frames may observe the same Web Audio render block.
      // Its original rate still describes audio before that block, including
      // a short history whose queued output predates the first observation.
      this.positions[this.positions.length - 1] = { ...position, playbackRate: last.playbackRate };
      return;
    }
    this.positions.push(position);
    const earliest = position.contextTime - 10;
    while (
      this.firstPosition + 1 < this.positions.length &&
      (this.positions[this.firstPosition + 1].contextTime < earliest ||
        this.positions.length - this.firstPosition > 8192)
    ) {
      ++this.firstPosition;
    }
    if (this.firstPosition > 128 && this.firstPosition > this.positions.length / 2) {
      this.positions = this.positions.slice(this.firstPosition);
      this.firstPosition = 0;
    }
  }

  private mediaTimeAt(contextTime: number): number {
    const first = this.positions[this.firstPosition];
    const last = this.positions[this.positions.length - 1];
    if (contextTime <= first.contextTime) {
      return first.mediaTimeInMs + (contextTime - first.contextTime) * first.playbackRate * 1000;
    }
    if (contextTime >= last.contextTime) return last.mediaTimeInMs;

    let low = this.firstPosition;
    let high = this.positions.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.positions[middle].contextTime <= contextTime) low = middle;
      else high = middle;
    }
    const before = this.positions[low];
    const after = this.positions[high];
    const progress = (contextTime - before.contextTime) / (after.contextTime - before.contextTime);
    return before.mediaTimeInMs + progress * (after.mediaTimeInMs - before.mediaTimeInMs);
  }
}
