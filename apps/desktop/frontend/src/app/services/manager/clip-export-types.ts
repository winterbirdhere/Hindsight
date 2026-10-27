import type { ReplayDisplaySettings } from "../analysis/replay-display-settings";

export const CLIP_EXPORT_WIDTHS = [1920, 2560, 3840] as const;
export const CLIP_EXPORT_FRAME_RATES = [60, 120, 144, 240] as const;
export const MIN_CLIP_DURATION_MS = 250;
export type ClipExportWidth = typeof CLIP_EXPORT_WIDTHS[number];
export type ClipExportFrameRate = typeof CLIP_EXPORT_FRAME_RATES[number];

export interface ClipExportOptions {
  startMs: number;
  endMs: number;
  width: ClipExportWidth;
  fps: ClipExportFrameRate;
  audio: boolean;
  preset: "replay" | "analysis";
  showKeys: boolean;
  showTiming: boolean;
  showStats: boolean;
  showHitErrorBar?: boolean;
  showReplayCursor?: boolean;
  showAnalysisCursor?: boolean;
  showComparisonCursor?: boolean;
  displaySettings?: Partial<ReplayDisplaySettings>;
  /** Viewer multiplier; the replay's original modded rate is applied separately. */
  speed: number;
  /** The folder the save dialog opens in; absent or empty means the system Videos folder. */
  saveFolder?: string;
}

export interface ClipRecorderState {
  status: "idle" | "preparing" | "recording" | "rendering" | "saving" | "done" | "cancelled" | "error";
  progress: number;
  path?: string;
  error?: string;
}

export type ClipExportState = ClipRecorderState;

/** What the running (or last) export is doing, published once its frame plan exists. */
export interface ClipRunSummary {
  startMs: number;
  endMs: number;
  width: ClipExportWidth;
  fps: ClipExportFrameRate;
  audio: boolean;
  /** options.speed */
  speed: number;
  /** plan.frameCount */
  frameCount: number;
  /** plan.durationSeconds */
  durationSeconds: number;
}

/** A fixed video sample grid. Producer speed never changes its times or count. */
export function createClipFramePlan(startMs: number, endMs: number, playbackRate: number, fps: ClipExportFrameRate) {
  if (
    !Number.isFinite(startMs) ||
    startMs < 0 ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    !Number.isFinite(playbackRate) ||
    playbackRate <= 0 ||
    !CLIP_EXPORT_FRAME_RATES.includes(fps)
  )
    throw new Error("Invalid clip frame plan");
  const requestedDurationSeconds = (endMs - startMs) / (1000 * playbackRate);
  // Ignore only floating-point noise at an exact integer frame boundary.
  const frameCount = Math.max(1, Math.ceil(requestedDurationSeconds * fps - 1e-9));
  if (!Number.isSafeInteger(frameCount) || frameCount > 1_000_000) throw new Error("The clip contains too many frames");
  return {
    frameCount,
    requestedDurationSeconds,
    durationSeconds: frameCount / fps,
    timeAt(index: number): number {
      if (!Number.isInteger(index) || index < 0 || index >= frameCount) throw new Error("Invalid clip frame index");
      return startMs + (index * 1000 * playbackRate) / fps;
    },
  };
}

export interface ClipExportFormat {
  mimeType: string;
  extension: "mp4" | "webm";
  label: string;
}

function isValidDisplaySetting(key: string, value: unknown): boolean {
  if (key === "statsStyle") return value === "classic" || value === "compact";
  if (key === "errorCauseDisplay") return value === "concise" || value === "brief";
  if (key === "keyOverlayLength") return value === "short" || value === "medium" || value === "long";
  if (key === "errorOutline") return value === "off" || value === "selected" || value === "all";
  if (key === "hitErrorBarScale") return typeof value === "number" && Number.isFinite(value) && value > 0;
  return typeof value === "boolean";
}

export function validateClipOptions(options: ClipExportOptions, duration: number): void {
  if (
    !Number.isFinite(options.startMs) ||
    !Number.isFinite(options.endMs) ||
    options.startMs < 0 ||
    options.endMs - options.startMs < MIN_CLIP_DURATION_MS ||
    options.endMs > duration
  ) {
    throw new Error("Choose a clip of at least 0.25 seconds inside the replay");
  }
  if (
    !CLIP_EXPORT_WIDTHS.includes(options.width) ||
    !CLIP_EXPORT_FRAME_RATES.includes(options.fps) ||
    !Number.isFinite(options.speed) ||
    options.speed < 0.1 ||
    options.speed > 4 ||
    !["replay", "analysis"].includes(options.preset) ||
    (options.saveFolder !== undefined && typeof options.saveFolder !== "string")
  ) {
    throw new Error("The clip export settings are invalid");
  }
  const requiredVisibility = [options.audio, options.showKeys, options.showTiming, options.showStats];
  const optionalVisibility = [
    options.showHitErrorBar,
    options.showReplayCursor,
    options.showAnalysisCursor,
    options.showComparisonCursor,
  ];
  const displaySettings = options.displaySettings;
  if (
    requiredVisibility.some((value) => typeof value !== "boolean") ||
    optionalVisibility.some((value) => value !== undefined && typeof value !== "boolean") ||
    (displaySettings !== undefined &&
      (!displaySettings ||
        typeof displaySettings !== "object" ||
        Array.isArray(displaySettings) ||
        Object.entries(displaySettings).some(([key, value]) => !isValidDisplaySetting(key, value))))
  ) {
    throw new Error("The clip display settings are invalid");
  }
}

/** Bounded, ordered writes. A slow disk cannot retain an entire recording in memory. */
export class ClipChunkWriter {
  private queue = Promise.resolve();
  private pendingBytes = 0;
  private ordinaryPendingBytes = 0;
  private oversizedBlobPending = false;
  private pendingChunks = 0;
  private sequence = 0;
  private stopped = false;
  private failure?: Error;

  constructor(
    private readonly append: (sequence: number, data: ArrayBuffer) => Promise<void>,
    private readonly onError: (error: Error) => void,
    private readonly maximumPendingBytes = 32 * 1024 * 1024,
    private readonly maximumBurstBytes = 128 * 1024 * 1024,
  ) {}

  push(blob: Blob): void {
    if (this.stopped || blob.size === 0) return;
    const sizes = `${this.pendingBytes} bytes waiting, ${blob.size} bytes incoming`;
    if (blob.size > this.maximumBurstBytes) {
      this.fail(
        new Error(
          `The video encoder produced a chunk above the ${this.maximumBurstBytes}-byte limit (${sizes}). Try a shorter clip or lower resolution.`,
        ),
      );
      return;
    }
    const oversized = blob.size > this.maximumPendingBytes;
    // Encoders may combine several timeslices into one Blob. Reserve one
    // bounded burst separately from the ordinary queue instead of blaming the
    // disk for a large chunk that has never had a chance to be written.
    // Retained Blob data is capped at 128 MiB + 32 MiB, with at most one extra
    // 8 MiB ArrayBuffer being sent. Tiny chunks also have a finite count limit.
    if (
      this.pendingChunks >= 64 ||
      (oversized ? this.oversizedBlobPending : this.ordinaryPendingBytes + blob.size > this.maximumPendingBytes)
    ) {
      this.fail(
        new Error(
          `Video data is arriving faster than it can be saved (${sizes}; ordinary queue limit ${this.maximumPendingBytes} bytes, one encoder burst up to ${this.maximumBurstBytes} bytes). Try a shorter clip or lower resolution.`,
        ),
      );
      return;
    }
    this.pendingBytes += blob.size;
    this.pendingChunks++;
    if (oversized) this.oversizedBlobPending = true;
    else this.ordinaryPendingBytes += blob.size;
    this.queue = this.queue.then(async () => {
      try {
        // IPC limits each message to 16 MiB. Leave headroom for overhead.
        for (let offset = 0; offset < blob.size && !this.stopped; offset += 8 * 1024 * 1024) {
          const data = await blob.slice(offset, offset + 8 * 1024 * 1024).arrayBuffer();
          if (!this.stopped) await this.append(this.sequence++, data);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.pendingBytes -= blob.size;
        this.pendingChunks--;
        if (oversized) this.oversizedBlobPending = false;
        else this.ordinaryPendingBytes -= blob.size;
      }
    });
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.stopped = true;
    this.onError(error);
  }

  cancel(): void {
    this.stopped = true;
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.failure) throw this.failure;
  }
}
