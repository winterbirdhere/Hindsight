import { MIN_CLIP_DURATION_MS } from "./clip-export-types";

export interface ClipRange {
  startMs: number;
  endMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function validDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
}

/**
 * The end held in [minEnd, duration]. It is never rounded: a typed video length must stay
 * exact, or rounding could push the clip over a frame boundary.
 */
function clampEnd(endMs: number, minEndMs: number, durationMs: number): number {
  return Math.min(durationMs, Math.max(minEndMs, endMs));
}

/**
 * null, a non-finite bound or a replay shorter than the minimum gives the whole replay;
 * otherwise the range is clamped into the replay and kept at least the minimum long.
 * A too-short range grows at its end first; only at the replay's end does the start move.
 * The start is always a whole millisecond (which keeps end − start ≥ minimum exact); the end is only clamped.
 */
export function normalizeClipRange(range: ClipRange | null, durationMs: number): ClipRange {
  const duration = validDuration(durationMs);
  const whole = { startMs: 0, endMs: duration };
  if (
    !range ||
    !Number.isFinite(range.startMs) ||
    !Number.isFinite(range.endMs) ||
    duration < MIN_CLIP_DURATION_MS
  ) {
    return whole;
  }
  let startMs = clamp(Math.round(range.startMs), 0, Math.floor(duration));
  let endMs = clamp(range.endMs, 0, duration);
  if (endMs - startMs < MIN_CLIP_DURATION_MS) {
    endMs = startMs + MIN_CLIP_DURATION_MS;
    if (endMs > duration) {
      endMs = duration;
      // Floor so that the difference cannot fall under the minimum.
      startMs = Math.max(0, Math.floor(duration - MIN_CLIP_DURATION_MS));
      while (startMs > 0 && endMs - startMs < MIN_CLIP_DURATION_MS) startMs -= 1;
    }
  }
  return { startMs, endMs };
}

/** The start follows an edit within [0, end − minimum], in whole milliseconds. */
export function withClipStart(range: ClipRange, startMs: number, durationMs: number): ClipRange {
  const current = normalizeClipRange(range, durationMs);
  if (!Number.isFinite(startMs) || current.endMs - current.startMs < MIN_CLIP_DURATION_MS) return current;
  const latest = Math.max(0, Math.floor(current.endMs - MIN_CLIP_DURATION_MS));
  return { startMs: clamp(Math.round(startMs), 0, latest), endMs: current.endMs };
}

/** The end follows an edit within [start + minimum, duration], unrounded. */
export function withClipEnd(range: ClipRange, endMs: number, durationMs: number): ClipRange {
  const current = normalizeClipRange(range, durationMs);
  if (!Number.isFinite(endMs) || current.endMs - current.startMs < MIN_CLIP_DURATION_MS) return current;
  return {
    startMs: current.startMs,
    endMs: clampEnd(endMs, current.startMs + MIN_CLIP_DURATION_MS, validDuration(durationMs)),
  };
}

/** Moves the end so the rendered video lasts `videoSeconds` at the playback rate. */
export function withClipLength(
  range: ClipRange,
  videoSeconds: number,
  playbackRate: number,
  durationMs: number,
): ClipRange {
  if (!Number.isFinite(videoSeconds) || !Number.isFinite(playbackRate) || playbackRate <= 0) return range;
  const current = normalizeClipRange(range, durationMs);
  if (current.endMs - current.startMs < MIN_CLIP_DURATION_MS) return current;
  const lengthMs = Math.max(0, videoSeconds) * 1000 * playbackRate;
  return {
    startMs: current.startMs,
    endMs: clampEnd(current.startMs + lengthMs, current.startMs + MIN_CLIP_DURATION_MS, validDuration(durationMs)),
  };
}

/** Length of the rendered video: (end − start) / (1000 × rate). */
export function clipVideoSeconds(range: ClipRange, playbackRate: number): number {
  if (!Number.isFinite(playbackRate) || playbackRate <= 0) return 0;
  return Math.max(0, range.endMs - range.startMs) / (1000 * playbackRate);
}

/** Seconds of video elapsed at `timeMs`, held at 0 before the range and at its length after it. */
export function clipElapsedSeconds(timeMs: number, range: ClipRange, playbackRate: number): number {
  if (!Number.isFinite(timeMs) || !Number.isFinite(playbackRate) || playbackRate <= 0) return 0;
  const elapsed = (timeMs - range.startMs) / (1000 * playbackRate);
  return clamp(elapsed, 0, clipVideoSeconds(range, playbackRate));
}

/** `m:ss`, with a trimmed millisecond fraction only when there is one. No hours. */
export function formatClipTime(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const fraction = total % 1000;
  const base = `${minutes}:${String(seconds).padStart(2, "0")}`;
  if (fraction === 0) return base;
  return `${base}.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
}

/** At most three decimals, trailing zeros trimmed. */
export function formatClipSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0";
  const rounded = Number(seconds.toFixed(3));
  return String(rounded === 0 ? 0 : rounded);
}

const CLIP_TIME_PATTERN = /^(?:(\d+):([0-5]\d)|(\d+))(?:\.(\d+))?$/;

/** Accepts `s`, `s.f`, `m:ss` and `m:ss.f` only; returns whole milliseconds, or undefined. */
export function parseClipTime(text: string): number | undefined {
  const match = CLIP_TIME_PATTERN.exec(text.trim());
  if (!match) return undefined;
  const [, minutes, colonSeconds, bareSeconds, fraction] = match;
  const wholeSeconds = minutes !== undefined ? Number(minutes) * 60 + Number(colonSeconds) : Number(bareSeconds);
  const ms = Math.round((wholeSeconds + (fraction ? Number(`0.${fraction}`) : 0)) * 1000);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Position of `timeMs` along the lane, 0 … 1. */
export function laneFraction(timeMs: number, durationMs: number): number {
  const duration = validDuration(durationMs);
  if (duration === 0 || !Number.isFinite(timeMs)) return 0;
  return clamp(timeMs / duration, 0, 1);
}

/** Map time under a pointer at `clientX` on a lane starting at `laneLeft`: whole ms, or exactly the duration at the right edge. */
export function laneTime(clientX: number, laneLeft: number, laneWidth: number, durationMs: number): number {
  const duration = validDuration(durationMs);
  if (duration === 0 || !Number.isFinite(clientX) || !Number.isFinite(laneLeft)) return 0;
  if (!Number.isFinite(laneWidth) || laneWidth <= 0) return 0;
  const fraction = clamp((clientX - laneLeft) / laneWidth, 0, 1);
  return fraction >= 1 ? duration : Math.min(duration, Math.round(fraction * duration));
}
