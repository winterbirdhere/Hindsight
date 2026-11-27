import type { GameplayClock } from "../common/game/GameplayClock";
import type { ClipRange } from "./clip-range";

/** The part of the clock the clip preview drives. */
export type PreviewClock = Pick<
  GameplayClock,
  | "timeElapsedInMs"
  | "isPlaying"
  | "playbackBoundaryInMs"
  | "speed"
  | "pause"
  | "start"
  | "seekTo"
  | "setPlaybackBoundary"
  | "setSpeed"
>;

/** What the viewer had before the clip preview took the transport. */
export interface TransportSnapshot {
  time: number;
  playing: boolean;
  boundary: number | undefined;
  speed: number;
}

/**
 * Starts previewing the clip: the transport is paused, runs at the clip's own speed and is bounded at the range's end.
 * A playhead inside the range stays where it is; one outside it goes to the start. Returns what the viewer had, to be
 * given back to `leaveClipPreview`.
 */
export function enterClipPreview(clock: PreviewClock, range: ClipRange, clipSpeed: number): TransportSnapshot {
  const snapshot: TransportSnapshot = {
    time: clock.timeElapsedInMs,
    playing: clock.isPlaying,
    boundary: clock.playbackBoundaryInMs,
    speed: clock.speed,
  };
  clock.pause();
  clock.setSpeed(clipSpeed);
  clock.setPlaybackBoundary(range.endMs);
  if (clock.timeElapsedInMs < range.startMs || clock.timeElapsedInMs > range.endMs) clock.seekTo(range.startMs);
  return snapshot;
}

/** The range was edited while previewing: stop, move the bound, and show the bound that moved. */
export function followClipRange(clock: PreviewClock, previous: ClipRange, next: ClipRange): void {
  clock.pause();
  clock.setPlaybackBoundary(next.endMs);
  if (next.startMs !== previous.startMs) clock.seekTo(next.startMs);
  else if (next.endMs !== previous.endMs) clock.seekTo(next.endMs);
}

/** The preview's play/pause: a preview that is over, or whose playhead left the range, starts again from the start. */
export function toggleClipPreview(clock: PreviewClock, range: ClipRange): void {
  if (clock.isPlaying) {
    clock.pause();
    return;
  }
  clock.setPlaybackBoundary(range.endMs);
  if (clock.timeElapsedInMs < range.startMs || clock.timeElapsedInMs >= range.endMs) clock.seekTo(range.startMs);
  clock.start();
}

/**
 * Gives the viewer's transport back. `resume` is false when the view is being torn down: position and settings come
 * back, but playback must not restart.
 */
export function leaveClipPreview(clock: PreviewClock, snapshot: TransportSnapshot, resume: boolean): void {
  clock.pause();
  clock.setPlaybackBoundary(snapshot.boundary);
  clock.setSpeed(snapshot.speed);
  if (resume && snapshot.playing) clock.start();
  // start() can rewind at the replay's end; the saved playhead remains authoritative.
  clock.seekTo(snapshot.time);
}
