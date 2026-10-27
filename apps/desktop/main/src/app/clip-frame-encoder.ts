import { ChildProcess, spawn, SpawnOptions } from "child_process";
import { open, rename } from "fs/promises";
import { isAbsolute } from "path";
import { ClipExportVideo, MAX_CLIP_FRAME_CHUNK_BYTES, MAX_CLIP_VIDEO_FRAMES } from "../../../shared/clip-export";

export interface ClipFrameEncoder {
  append(frameIndex: number, offset: number, data: Buffer): Promise<void>;
  finish(audio: string | undefined, output: string): Promise<void>;
  cancel(): Promise<void>;
}

export type ClipFrameEncoderFactory = (
  video: ClipExportVideo,
  ownedVideoPath: string,
  signal: AbortSignal,
) => ClipFrameEncoder;

type ProcessFactory = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
const PROCESS_IDLE_TIMEOUT_MS = 120_000;

export function validateClipVideo(value: unknown): ClipExportVideo {
  const video = value as Partial<ClipExportVideo> | null;
  if (
    !video ||
    ![1920, 2560, 3840].includes(video.width ?? 0) ||
    video.height !== ((video.width ?? 0) * 9) / 16 ||
    ![60, 120, 144, 240].includes(video.fps ?? 0) ||
    !Number.isSafeInteger(video.frameCount) ||
    (video.frameCount ?? 0) <= 0 ||
    (video.frameCount ?? 0) > MAX_CLIP_VIDEO_FRAMES ||
    typeof video.audio !== "boolean"
  )
    throw new Error("Invalid native clip video settings.");
  const validated = video as ClipExportVideo;
  return {
    width: validated.width,
    height: validated.height,
    fps: validated.fps,
    frameCount: validated.frameCount,
    audio: validated.audio,
  };
}

async function syncVideo(path: string): Promise<void> {
  const file = await open(path, "r+");
  try {
    if ((await file.stat()).size === 0) throw new Error("The video encoder produced no video data.");
    await file.sync();
  } finally {
    await file.close();
  }
}

/** A bounded child lifetime: an idle deadline, cancellable writes, and close before cleanup. */
class EncodingProcess {
  readonly closed: Promise<void>;
  private readonly child: ChildProcess;
  private failure?: Error;
  private ended = false;
  private inputEnded = false;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(
    executable: string,
    args: string[],
    private readonly signal: AbortSignal,
    private readonly writable: boolean,
    createProcess: ProcessFactory,
    private readonly idleTimeoutMs: number,
  ) {
    if (signal.aborted) throw new Error("Clip export cancelled.");
    this.child = createProcess(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: [writable ? "pipe" : "ignore", "ignore", "pipe"],
    });
    this.closed = new Promise<void>((resolve, reject) => {
      let stderr = "";
      const onData = (data: Buffer | string) => {
        stderr = (stderr + data.toString()).slice(-16 * 1024);
      };
      const onError = (error: Error) => {
        this.failure ??= new Error(`Video encoder failed: ${error.message}`);
      };
      const onInputError = (error: Error) => this.stop(new Error(`Video encoder input failed: ${error.message}`));
      const onAbort = () => this.stop(new Error("Clip export cancelled."));
      this.child.stderr?.on("data", onData);
      this.child.stdin?.on("error", onInputError);
      this.child.on("error", onError);
      this.child.once("close", (code, exitSignal) => {
        this.ended = true;
        clearTimeout(this.idleTimer);
        signal.removeEventListener("abort", onAbort);
        this.child.stderr?.removeListener("data", onData);
        this.child.stdin?.removeListener("error", onInputError);
        this.child.removeListener("error", onError);
        if (this.failure) reject(this.failure);
        else if (code !== 0)
          reject(new Error(`Video encoder failed (${exitSignal ?? code ?? "unknown"}). ${stderr.trim()}`));
        else if (writable && !this.inputEnded)
          reject(new Error("The video encoder stopped before all frames were supplied."));
        else resolve();
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      this.touch();
    });
    // The encoder can fail between frontend requests; retain that rejection for
    // the next write/finish without producing an unhandled process rejection.
    void this.closed.catch(() => undefined);
  }

  private touch() {
    clearTimeout(this.idleTimer);
    if (this.ended) return;
    this.idleTimer = setTimeout(
      () => this.stop(new Error("The video encoder stopped making progress.")),
      this.idleTimeoutMs,
    );
  }

  stop(error = new Error("Clip export cancelled.")) {
    if (this.ended) return;
    this.failure ??= error;
    try {
      this.child.kill("SIGKILL");
    } catch (error) {
      this.failure = new Error(`${this.failure.message} ${String(error)}`);
    }
  }

  async write(data: Buffer): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.ended) {
      await this.closed;
      throw new Error("The video encoder is already closed.");
    }
    const input = this.child.stdin;
    if (!input || !this.writable || this.inputEnded) throw new Error("The video encoder input is closed.");
    this.touch();
    await new Promise<void>((resolve, reject) => {
      let returned = false,
        written = false,
        drained = false,
        needsDrain = false,
        settled = false;
      const cleanup = () => {
        input.removeListener("drain", onDrain);
        input.removeListener("error", onError);
        this.child.removeListener("close", onClose);
        this.signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      const complete = () => {
        if (!settled && returned && written && (!needsDrain || drained)) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      const onDrain = () => {
        drained = true;
        complete();
      };
      const onError = (error: Error) => fail(error);
      const onClose = () => fail(this.failure ?? new Error("The video encoder closed while receiving a frame."));
      const onAbort = () => fail(new Error("Clip export cancelled."));
      input.on("drain", onDrain);
      input.on("error", onError);
      this.child.on("close", onClose);
      this.signal.addEventListener("abort", onAbort, { once: true });
      try {
        needsDrain = !input.write(data, (error) => {
          if (error) fail(error);
          else {
            written = true;
            complete();
          }
        });
        returned = true;
        complete();
        if (this.signal.aborted) onAbort();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.touch();
  }

  async finish(): Promise<void> {
    if (this.writable && !this.ended) {
      this.inputEnded = true;
      this.child.stdin?.end();
    }
    await this.closed;
  }
}

/** Every complete RGBA frame becomes one timestamped frame, independent of wall-clock rendering speed. */
export class FFmpegClipFrameEncoder implements ClipFrameEncoder {
  private readonly video: ClipExportVideo;
  private process?: EncodingProcess;
  private mux?: EncodingProcess;
  private frameIndex = 0;
  private offset = 0;
  private writing = false;
  private finishing = false;
  private cancelled = false;

  constructor(
    video: ClipExportVideo,
    private readonly videoPath: string,
    private readonly signal: AbortSignal,
    private readonly executable: () => string,
    private readonly createProcess: ProcessFactory = spawn,
    private readonly idleTimeoutMs = PROCESS_IDLE_TIMEOUT_MS,
  ) {
    this.video = validateClipVideo(video);
  }

  private checkActive() {
    if (this.cancelled || this.signal.aborted) throw new Error("Clip export cancelled.");
  }

  private start(args: string[], writable: boolean): EncodingProcess {
    this.checkActive();
    const executable = this.executable();
    if (!isAbsolute(executable) || !isAbsolute(this.videoPath))
      throw new Error("Video encoding requires absolute file paths.");
    return new EncodingProcess(executable, args, this.signal, writable, this.createProcess, this.idleTimeoutMs);
  }

  async append(frameIndex: number, offset: number, data: Buffer): Promise<void> {
    this.checkActive();
    if (this.finishing || this.writing)
      throw new Error("Wait for the previous frame chunk before supplying more video.");
    const frameBytes = this.video.width * this.video.height * 4;
    if (
      !Number.isSafeInteger(frameIndex) ||
      frameIndex !== this.frameIndex ||
      frameIndex >= this.video.frameCount ||
      !Number.isSafeInteger(offset) ||
      offset !== this.offset ||
      !Buffer.isBuffer(data) ||
      data.length === 0 ||
      data.length > MAX_CLIP_FRAME_CHUNK_BYTES ||
      offset + data.length > frameBytes
    )
      throw new Error("Video frame chunks arrived out of order or with an invalid size.");
    this.writing = true;
    try {
      this.process ??= this.start(
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-f",
          "rawvideo",
          "-pixel_format",
          "rgba",
          "-video_size",
          `${this.video.width}x${this.video.height}`,
          "-framerate",
          String(this.video.fps),
          "-i",
          "pipe:0",
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-r",
          String(this.video.fps),
          "-fps_mode",
          "cfr",
          "-g",
          String(this.video.fps * 2),
          "-video_track_timescale",
          String(this.video.fps * 1000),
          ...(!this.video.audio ? ["-movflags", "+faststart"] : []),
          "-f",
          "mp4",
          this.videoPath,
        ],
        true,
      );
      await this.process.write(data);
      this.checkActive();
      this.offset += data.length;
      if (this.offset === frameBytes) {
        this.frameIndex += 1;
        this.offset = 0;
      }
    } finally {
      this.writing = false;
    }
  }

  async finish(audio: string | undefined, output: string): Promise<void> {
    this.checkActive();
    if (
      this.finishing ||
      this.writing ||
      this.frameIndex !== this.video.frameCount ||
      this.offset !== 0 ||
      !this.process
    )
      throw new Error(`The video needs exactly ${this.video.frameCount} complete frames before saving.`);
    if (
      !isAbsolute(output) ||
      (audio !== undefined && !isAbsolute(audio)) ||
      this.video.audio !== (audio !== undefined)
    )
      throw new Error("The clip audio input does not match the selected export settings.");
    this.finishing = true;
    await this.process.finish();
    this.checkActive();
    await syncVideo(this.videoPath);
    this.checkActive();
    if (!audio) {
      // Both paths belong to this export. The manager reserves output and
      // awaits this entire finalization before cancellation cleanup/publication.
      await rename(this.videoPath, output);
      this.checkActive();
      await syncVideo(output);
      this.checkActive();
      return;
    }
    const duration = (this.video.frameCount / this.video.fps).toFixed(12);
    this.mux = this.start(
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-protocol_whitelist",
        "file",
        "-i",
        this.videoPath,
        ...(audio ? ["-protocol_whitelist", "file", "-i", audio] : []),
        "-map",
        "0:v:0",
        ...(audio
          ? [
              "-map",
              "1:a:0",
              "-c:a",
              "aac",
              "-b:a",
              "192000",
              "-ar",
              "48000",
              "-af",
              `aresample=48000,asetpts=PTS-STARTPTS,apad,atrim=duration=${duration}`,
            ]
          : ["-an"]),
        "-c:v",
        "copy",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        output,
      ],
      false,
    );
    await this.mux.finish();
    this.checkActive();
    await syncVideo(output);
    this.checkActive();
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.process?.stop();
    this.mux?.stop();
    await Promise.allSettled([this.process?.closed, this.mux?.closed]);
  }
}
