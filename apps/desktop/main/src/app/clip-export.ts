import type { WebContents } from "electron";
import { randomUUID } from "crypto";
import { renameSync } from "fs";
import { open, unlink } from "fs/promises";
import type { FileHandle } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize } from "path";
import {
  ClipExportRequest,
  ClipExportResult,
  ClipExportSession,
  ClipExportVideo,
  MAX_CLIP_FRAME_CHUNK_BYTES,
} from "../../../shared/clip-export";
import type { ClipFinalizer } from "./clip-finalizer";
import { ClipFrameEncoder, ClipFrameEncoderFactory, validateClipVideo } from "./clip-frame-encoder";

export const MAX_CLIP_CHUNK_BYTES = 16 * 1024 * 1024;
export const MAX_CLIP_PENDING_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_CHUNKS = 64;

export type ClipExportOwner = Pick<
  WebContents,
  "id" | "isDestroyed" | "getBackgroundThrottling" | "setBackgroundThrottling" | "on" | "once" | "removeListener"
>;

export interface ClipExportUI {
  selectDestination(owner: ClipExportOwner, request: ClipExportRequest): Promise<string | null>;
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

type ClipFile = Pick<FileHandle, "write" | "sync" | "close">;
export interface ClipExportFiles {
  open(path: string): Promise<ClipFile>;
  commit(temporary: string, destination: string): void;
  remove(path: string): Promise<void>;
}

const defaultFiles: ClipExportFiles = {
  open: (path) => open(path, "wx", 0o600),
  // The atomic final rename is synchronous so cancellation cannot interleave
  // between the last state check and the commit to the selected destination.
  commit: renameSync,
  remove: async (path) => {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  },
};

interface ExportSession extends ClipExportSession {
  owner: ClipExportOwner;
  temporary: string;
  finalizedTemporary?: string;
  finalization?: Promise<string>;
  video?: ClipExportVideo;
  encoderTemporary?: string;
  encoder?: ClipFrameEncoder;
  encoderStart?: Promise<ClipFrameEncoder>;
  frameWrite?: Promise<void>;
  frameWriting?: boolean;
  abort: AbortController;
  file?: ClipFile;
  closing?: Promise<void>;
  tail: Promise<void>;
  nextSequence: number;
  bytesWritten: number;
  state: "recording" | "finishing" | "aborted" | "committed";
  error?: Error;
  cleanup?: Promise<void>;
  finishing?: Promise<ClipExportResult>;
  previousThrottling?: boolean;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function pathKey(path: string): string {
  const value = normalize(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function requestForDialog(request: unknown): ClipExportRequest {
  const value = request as Partial<ClipExportRequest> | null;
  if (
    !value ||
    typeof value.fileName !== "string" ||
    value.fileName.length > 1000 ||
    (value.extension !== "mp4" && value.extension !== "webm")
  )
    throw new Error("Invalid clip export request");
  const stem = basename(value.fileName)
    .replace(/\.(mp4|webm)$/i, "")
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, "_")
    .slice(0, 180)
    .replace(/[. ]+$/, "");
  const video = value.video === undefined ? undefined : validateClipVideo(value.video);
  if (video && value.extension !== "mp4") throw new Error("Native frame export requires MP4 output.");
  // Only a hint for the dialog: anything but a plain absolute path is dropped, never an error.
  const directory =
    typeof value.directory === "string" && value.directory.length <= 1000 && isAbsolute(value.directory)
      ? value.directory
      : undefined;
  return {
    fileName: `${stem || "Hindsight clip"}.${value.extension}`,
    extension: value.extension,
    ...(directory ? { directory } : {}),
    ...(video ? { video } : {}),
  };
}

/** Stream renderer chunks into an owned temporary file; publish only a finished clip. */
export class ClipExportManager {
  private sessions = new Map<string, ExportSession>();
  private destinations = new Map<string, string>();
  private pendingBegins = new Map<number, symbol>();
  private openings = new Set<Promise<ClipExportSession | null>>();
  private cleanups = new Set<Promise<void>>();
  private completed = new Map<number, Map<string, string>>();
  private observed = new Map<number, { detach: () => void }>();
  private pendingBytes = 0;
  private pendingChunks = 0;
  private disposed = false;

  constructor(
    private readonly ui: ClipExportUI,
    private readonly files: ClipExportFiles = defaultFiles,
    private readonly finalizer?: ClipFinalizer,
    private readonly createFrameEncoder?: ClipFrameEncoderFactory,
  ) {}

  get hasWork(): boolean {
    return this.sessions.size > 0 || this.openings.size > 0 || this.cleanups.size > 0;
  }

  async begin(owner: ClipExportOwner, input: unknown): Promise<ClipExportSession | null> {
    const request = requestForDialog(input);
    if (this.disposed || owner.isDestroyed()) throw new Error("The replay window is closed.");
    this.observe(owner);
    if (
      this.pendingBegins.has(owner.id) ||
      [...this.sessions.values()].some((session) => session.owner.id === owner.id)
    )
      throw new Error("A clip export is already in progress.");
    const token = Symbol();
    this.pendingBegins.set(owner.id, token);
    const isCurrent = () => !this.disposed && !owner.isDestroyed() && this.pendingBegins.get(owner.id) === token;
    try {
      const destination = await this.ui.selectDestination(owner, request);
      if (!destination || !isCurrent()) return null;
      if (!isAbsolute(destination) || extname(destination).toLowerCase() !== `.${request.extension}`)
        throw new Error(`Save this clip with the .${request.extension} extension.`);
      const key = pathKey(destination);
      if (this.destinations.has(key)) throw new Error("Another clip is already being saved to that file.");
      const id = randomUUID();
      this.destinations.set(key, id);
      const opening = this.createSession(owner, id, destination, isCurrent, request.video);
      this.openings.add(opening);
      try {
        return await opening;
      } finally {
        this.openings.delete(opening);
        if (!this.sessions.has(id) && this.destinations.get(key) === id) this.destinations.delete(key);
      }
    } finally {
      if (this.pendingBegins.get(owner.id) === token) this.pendingBegins.delete(owner.id);
    }
  }

  private async createSession(
    owner: ClipExportOwner,
    id: string,
    path: string,
    isCurrent: () => boolean,
    video?: ClipExportVideo,
  ): Promise<ClipExportSession | null> {
    const temporary = join(dirname(path), `.rewind-${id}.part`);
    // Only a successful exclusive open gives this session ownership of the temp.
    const file = await this.files.open(temporary);
    const session: ExportSession = {
      id,
      path,
      temporary,
      video,
      abort: new AbortController(),
      owner,
      file,
      tail: Promise.resolve(),
      nextSequence: 0,
      bytesWritten: 0,
      state: "recording",
    };
    this.sessions.set(id, session);
    try {
      if (!isCurrent()) {
        await this.cancelSession(session, new Error("Clip export cancelled."));
        return null;
      }
      session.previousThrottling = owner.getBackgroundThrottling();
      owner.setBackgroundThrottling(false);
      return { id, path };
    } catch (error) {
      await this.cancelSession(session, asError(error));
      throw error;
    }
  }

  async append(owner: number, id: unknown, sequence: unknown, data: unknown): Promise<void> {
    const session = this.requireSession(owner, id);
    if (session.state !== "recording") throw session.error ?? new Error("This clip is no longer recording.");
    let problem: string | undefined;
    if (session.video && !session.video.audio) problem = "This clip was configured without audio.";
    else if (!Number.isSafeInteger(sequence) || sequence !== session.nextSequence)
      problem = "Clip chunks arrived out of order.";
    else if (!(data instanceof ArrayBuffer) || data.byteLength === 0) problem = "Invalid clip chunk.";
    else if (data.byteLength > MAX_CLIP_CHUNK_BYTES) problem = "A clip chunk is too large.";
    else if (this.pendingBytes + data.byteLength > MAX_CLIP_PENDING_BYTES || this.pendingChunks >= MAX_PENDING_CHUNKS)
      problem = "Clip storage cannot keep up with the recording.";
    if (problem) {
      const error = new Error(problem);
      await this.cancelSession(session, error);
      throw error;
    }
    const bytes = Buffer.from(data as ArrayBuffer);
    session.nextSequence += 1;
    this.pendingBytes += bytes.byteLength;
    this.pendingChunks += 1;
    const write = session.tail
      .then(async () => {
        this.assertActive(session);
        const file = session.file;
        if (!file) throw new Error("The clip output file is closed.");
        let offset = 0;
        while (offset < bytes.length) {
          this.assertActive(session);
          const result = await file.write(bytes, offset, bytes.length - offset, null);
          if (result.bytesWritten <= 0) throw new Error("Could not write the clip output file.");
          offset += result.bytesWritten;
          session.bytesWritten += result.bytesWritten;
        }
      })
      .finally(() => {
        this.pendingBytes -= bytes.byteLength;
        this.pendingChunks -= 1;
      });
    // Keep the drain independent of the caller's error cleanup to avoid a cycle.
    session.tail = write.then(
      () => undefined,
      () => undefined,
    );
    try {
      await write;
    } catch (error) {
      await this.cancelSession(session, asError(error));
      throw error;
    }
  }

  async appendFrame(owner: number, id: unknown, frameIndex: unknown, offset: unknown, data: unknown): Promise<void> {
    const session = this.requireSession(owner, id);
    if (session.state !== "recording") throw session.error ?? new Error("This clip is no longer recording.");
    let problem: string | undefined;
    if (!session.video) problem = "This export does not accept native video frames.";
    else if (session.frameWriting) problem = "Wait for the previous frame chunk before supplying more video.";
    else if (
      !Number.isSafeInteger(frameIndex) ||
      !Number.isSafeInteger(offset) ||
      !(data instanceof ArrayBuffer) ||
      data.byteLength === 0 ||
      data.byteLength > MAX_CLIP_FRAME_CHUNK_BYTES
    )
      problem = "Invalid video frame chunk.";
    else if (this.pendingBytes + data.byteLength > MAX_CLIP_PENDING_BYTES || this.pendingChunks >= MAX_PENDING_CHUNKS)
      problem = "Too much clip data is waiting for the video encoder.";
    if (problem) {
      const error = new Error(problem);
      await this.cancelSession(session, error);
      throw error;
    }
    const bytes = Buffer.from(data as ArrayBuffer);
    this.pendingBytes += bytes.length;
    this.pendingChunks += 1;
    session.frameWriting = true;
    const writing = (async () => {
      this.assertActive(session);
      session.encoderStart ??= this.startFrameEncoder(session);
      const encoder = await session.encoderStart;
      this.assertActive(session);
      await encoder.append(frameIndex as number, offset as number, bytes);
      this.assertActive(session);
    })().finally(() => {
      this.pendingBytes -= bytes.length;
      this.pendingChunks -= 1;
      session.frameWriting = false;
    });
    session.frameWrite = writing;
    try {
      await writing;
    } catch (error) {
      await this.cancelSession(session, asError(error));
      throw error;
    }
  }

  private async startFrameEncoder(session: ExportSession): Promise<ClipFrameEncoder> {
    if (!session.video || !this.createFrameEncoder) throw new Error("The native clip encoder is unavailable.");
    const output = join(dirname(session.path), `.rewind-${session.id}.video.mp4`);
    const reserved = await this.files.open(output);
    session.encoderTemporary = output;
    await reserved.close();
    this.assertActive(session);
    session.encoder = this.createFrameEncoder(session.video, output, session.abort.signal);
    return session.encoder;
  }

  finish(owner: number, id: unknown): Promise<ClipExportResult> {
    const session = this.requireSession(owner, id);
    if (session.finishing) return session.finishing;
    if (session.state !== "recording") return Promise.reject(session.error ?? new Error("Clip export cancelled."));
    session.state = "finishing";
    session.finishing = this.commitSession(session);
    return session.finishing;
  }

  private async commitSession(session: ExportSession): Promise<ClipExportResult> {
    try {
      await session.tail;
      await session.frameWrite;
      this.assertActive(session);
      if (session.video) {
        if (!session.encoder) throw new Error("The recording did not produce any video frames.");
        if (session.video.audio && session.bytesWritten === 0)
          throw new Error("The recording did not produce any audio data.");
      } else if (session.bytesWritten === 0) throw new Error("The recording did not produce any video data.");
      await session.file?.sync();
      await this.closeFile(session);
      this.assertActive(session);
      // Track preparation as well as the child process so cancellation cannot
      // remove a reserved output while the finalizer is about to open it.
      session.finalization = this.finalizeOutput(session);
      const completed = await session.finalization;
      this.assertActive(session);
      if (completed !== session.temporary) await this.files.remove(session.temporary);
      if (session.encoderTemporary) await this.files.remove(session.encoderTemporary);
      this.assertActive(session);
      this.files.commit(completed, session.path);
      session.state = "committed";
      let paths = this.completed.get(session.owner.id);
      if (!paths) this.completed.set(session.owner.id, (paths = new Map()));
      paths.set(pathKey(session.path), session.path);
      this.release(session);
      return { path: session.path };
    } catch (error) {
      await this.cancelSession(session, asError(error));
      throw error;
    }
  }

  private async finalizeOutput(session: ExportSession): Promise<string> {
    if (extname(session.path).toLowerCase() !== ".mp4") return session.temporary;
    if (!session.video && !this.finalizer) throw new Error("The MP4 clip finalizer is unavailable.");
    this.assertActive(session);
    const output = join(dirname(session.path), `.rewind-${session.id}.final.mp4`);
    // Exclusive reservation establishes ownership before FFmpeg overwrites the
    // empty file. Never remove an output whose reservation failed.
    const reserved = await this.files.open(output);
    session.finalizedTemporary = output;
    await reserved.close();
    this.assertActive(session);
    if (session.video) {
      if (!session.encoder) throw new Error("The native clip encoder is unavailable.");
      await session.encoder.finish(session.video.audio ? session.temporary : undefined, output);
    } else {
      if (!this.finalizer) throw new Error("The MP4 clip finalizer is unavailable.");
      await this.finalizer.finalize(session.temporary, output, session.abort.signal);
    }
    this.assertActive(session);
    return output;
  }

  async abort(owner: number, id: unknown): Promise<void> {
    if (typeof id !== "string") throw new Error("Invalid clip export session.");
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.owner.id !== owner) throw new Error("This clip belongs to another window.");
    await this.cancelSession(session, new Error("Clip export cancelled."));
  }

  async openExported(owner: number, path: unknown): Promise<void> {
    const result = await this.ui.openPath(this.exportedPath(owner, path));
    if (result) throw new Error(`Could not open the exported clip: ${result}`);
  }

  showExported(owner: number, path: unknown): void {
    this.ui.showItemInFolder(this.exportedPath(owner, path));
  }

  private exportedPath(owner: number, path: unknown): string {
    const exported = typeof path === "string" ? this.completed.get(owner)?.get(pathKey(path)) : undefined;
    if (!exported) throw new Error("This window has not exported that clip.");
    return exported;
  }

  private requireSession(owner: number, id: unknown): ExportSession {
    const session = typeof id === "string" ? this.sessions.get(id) : undefined;
    if (!session) throw new Error("The clip export session is no longer available.");
    if (session.owner.id !== owner) throw new Error("This clip belongs to another window.");
    return session;
  }

  private assertActive(session: ExportSession): void {
    if (session.state === "aborted" || this.disposed || session.owner.isDestroyed())
      throw session.error ?? new Error("Clip export cancelled.");
  }

  private closeFile(session: ExportSession): Promise<void> {
    if (!session.closing) {
      const file = session.file;
      session.file = undefined;
      session.closing = file?.close() ?? Promise.resolve();
    }
    return session.closing;
  }

  private restoreThrottling(session: ExportSession): void {
    if (session.previousThrottling === undefined) return;
    const previous = session.previousThrottling;
    session.previousThrottling = undefined;
    if (!session.owner.isDestroyed()) {
      try {
        session.owner.setBackgroundThrottling(previous);
      } catch (error) {
        console.warn("Could not restore replay window background throttling", error);
      }
    }
  }

  private release(session: ExportSession): void {
    this.restoreThrottling(session);
    this.sessions.delete(session.id);
    if (this.destinations.get(pathKey(session.path)) === session.id) this.destinations.delete(pathKey(session.path));
  }

  private cancelSession(session: ExportSession, error: Error): Promise<void> {
    if (session.state === "committed") return Promise.resolve();
    if (session.cleanup) return session.cleanup;
    session.state = "aborted";
    session.error = error;
    session.abort.abort();
    this.restoreThrottling(session);
    const cleanup = (async () => {
      await session.tail;
      await session.encoderStart?.catch(() => undefined);
      await session.encoder?.cancel();
      await session.frameWrite?.catch(() => undefined);
      await session.finalization?.catch(() => undefined);
      const closed = await Promise.allSettled([this.closeFile(session)]);
      const removed = await Promise.allSettled([
        this.files.remove(session.temporary),
        ...(session.finalizedTemporary ? [this.files.remove(session.finalizedTemporary)] : []),
        ...(session.encoderTemporary ? [this.files.remove(session.encoderTemporary)] : []),
      ]);
      const failed = [...closed, ...removed].find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
      this.release(session);
    })();
    session.cleanup = cleanup;
    this.cleanups.add(cleanup);
    void cleanup.then(
      () => this.cleanups.delete(cleanup),
      () => {
        this.cleanups.delete(cleanup);
        if (session.cleanup === cleanup) session.cleanup = undefined;
      },
    );
    return cleanup;
  }

  async abortOwner(owner: number): Promise<void> {
    this.pendingBegins.delete(owner);
    this.completed.delete(owner);
    const results = await Promise.allSettled(
      [...this.sessions.values()]
        .filter((session) => session.owner.id === owner)
        .map((session) => this.cancelSession(session, new Error("Clip export cancelled."))),
    );
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  private observe(owner: ClipExportOwner): void {
    if (this.observed.has(owner.id)) return;
    const cancel = () => {
      void this.abortOwner(owner.id).catch((error) => console.warn("Could not clean up a cancelled clip", error));
    };
    const navigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame && !isInPlace) cancel();
    };
    const detach = () => {
      owner.removeListener("did-start-navigation", navigation);
      owner.removeListener("render-process-gone", cancel);
      owner.removeListener("destroyed", destroyed);
      this.observed.delete(owner.id);
    };
    const destroyed = () => {
      cancel();
      detach();
    };
    owner.on("did-start-navigation", navigation);
    owner.on("render-process-gone", cancel);
    owner.once("destroyed", destroyed);
    this.observed.set(owner.id, { detach });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.pendingBegins.clear();
    this.completed.clear();
    for (const observation of this.observed.values()) observation.detach();
    const results = await Promise.allSettled([
      ...[...this.sessions.values()].map((session) => this.cancelSession(session, new Error("Clip export cancelled."))),
      ...this.openings,
      ...this.cleanups,
    ]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}
