import { EventEmitter } from "events";
import { ChildProcess } from "child_process";
import { PassThrough } from "stream";
import * as fileOperations from "fs/promises";
import { renameSync } from "fs";
import { mkdtemp, open, readFile, readdir, rm, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import {
  ClipExportFiles,
  ClipExportManager,
  ClipExportOwner,
  ClipExportUI,
  MAX_CLIP_CHUNK_BYTES,
} from "./clip-export";
import { ClipFinalizer } from "./clip-finalizer";
import { ClipFrameEncoderFactory, FFmpegClipFrameEncoder } from "./clip-frame-encoder";
import { ClipExportVideo } from "../../../shared/clip-export";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function owner(id = 10, backgroundThrottling = true) {
  const state = { destroyed: false, backgroundThrottling };
  const sender = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: jest.fn(() => state.destroyed),
    getBackgroundThrottling: jest.fn(() => state.backgroundThrottling),
    setBackgroundThrottling: jest.fn((value: boolean) => {
      state.backgroundThrottling = value;
    }),
  });
  return { sender: sender as unknown as ClipExportOwner, events: sender, state };
}

function bytes(text: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(text)).buffer;
}

const realFiles: ClipExportFiles = {
  open: (path) => open(path, "wx"),
  commit: renameSync,
  remove: async (path) => {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  },
};

let directory: string;
const managers: ClipExportManager[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "rewind-clip-export-"));
});
afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it.each(["abort", "dispose"])("%s waits for silent-video transfer before cleaning owned files", async action => {
  const entered = deferred<void>(), release = deferred<void>(), realRename = fileOperations.rename;
  jest.spyOn(fileOperations, "rename").mockImplementationOnce(async (from, to) => {
    entered.resolve();
    await release.promise;
    await realRename(from, to);
  });
  const factory: ClipFrameEncoderFactory = (video, videoPath, signal) => new FFmpegClipFrameEncoder(
    video, videoPath, signal, () => join(directory, "fixture-ffmpeg.exe"), () => {
      const child = Object.assign(new EventEmitter(), {
        stderr: new PassThrough(), kill: jest.fn(),
        stdin: Object.assign(new EventEmitter(), {
          write: (_bytes: Buffer, done: () => void) => { done(); return true; },
          end: () => { void writeFile(videoPath, "encoded").then(() => child.emit("close", 0, null)); },
        }),
      });
      return child as unknown as ChildProcess;
    },
  );
  const f = fixture(undefined, undefined, "mp4", factory);
  await writeFile(f.path, "prior output");
  try {
    const video = { ...nativeVideo, frameCount: 1 };
    const session = await beginVideo(f.manager, f.sender, video);
    await f.manager.appendFrame(f.sender.id, session.id, 0, 0, new ArrayBuffer(video.width * video.height * 4));
    const finishing = f.manager.finish(f.sender.id, session.id).catch(error => error);
    await entered.promise;
    let stopped = false;
    const stopping = (action === "abort" ? f.manager.abort(f.sender.id, session.id) : f.manager.dispose())
      .then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    expect(await readFile(f.path, "utf8")).toBe("prior output");
    release.resolve();
    await stopping;
    expect(await finishing).toBeInstanceOf(Error);
    expect(await readFile(f.path, "utf8")).toBe("prior output");
    expect(await readdir(directory)).toEqual(["clip.mp4"]);
    expect(f.manager.hasWork).toBe(false);
  } finally { release.resolve(); }
});

function fixture(
  files?: ClipExportFiles,
  finalizer?: ClipFinalizer,
  extension = "webm",
  encoder?: ClipFrameEncoderFactory,
) {
  const path = join(directory, `clip.${extension}`);
  const ui = {
    selectDestination: jest.fn(async () => path),
    openPath: jest.fn(async () => ""),
    showItemInFolder: jest.fn(),
  };
  const manager = new ClipExportManager(ui as ClipExportUI, files, finalizer, encoder);
  managers.push(manager);
  return { manager, ui, path, ...owner() };
}

async function begin(manager: ClipExportManager, sender: ClipExportOwner, extension = "webm") {
  const session = await manager.begin(sender, { fileName: `Replay.${extension}`, extension });
  if (!session) throw new Error("Unexpected cancelled test export");
  return session;
}

it("drains chunks in sequence and atomically replaces only the finished destination", async () => {
  const { manager, path, sender, state, ui } = fixture();
  await writeFile(path, "previous clip");
  const session = await begin(manager, sender);
  expect(state.backgroundThrottling).toBe(false);
  expect(await readdir(directory)).toEqual(expect.arrayContaining(["clip.webm", expect.stringMatching(/\.part$/)]));
  expect(await readFile(path, "utf8")).toBe("previous clip");
  const chunks = [
    manager.append(sender.id, session.id, 0, bytes("header-")),
    manager.append(sender.id, session.id, 1, bytes("frames")),
  ];
  const finished = manager.finish(sender.id, session.id);
  await Promise.all(chunks);
  expect(await finished).toEqual({ path });
  expect(await readFile(path, "utf8")).toBe("header-frames");
  expect(await readdir(directory)).toEqual(["clip.webm"]);
  expect(state.backgroundThrottling).toBe(true);
  expect(manager.hasWork).toBe(false);
  await manager.openExported(sender.id, path);
  manager.showExported(sender.id, path);
  expect(ui.openPath).toHaveBeenCalledWith(path);
  expect(ui.showItemInFolder).toHaveBeenCalledWith(path);
  await expect(manager.openExported(20, path)).rejects.toThrow("has not exported");
  expect(() => manager.showExported(sender.id, join(directory, "arbitrary.exe"))).toThrow("has not exported");
});

it("leaves no partial or changed throttle setting when the save dialog is cancelled", async () => {
  const { manager, sender, ui } = fixture();
  ui.selectDestination.mockResolvedValueOnce(null as unknown as string);
  expect(await manager.begin(sender, { fileName: "Replay", extension: "mp4" })).toBeNull();
  expect(await readdir(directory)).toEqual([]);
  expect(sender.setBackgroundThrottling).not.toHaveBeenCalled();
});

it("preserves an existing output and its original false throttle setting on cancellation", async () => {
  const { manager, path } = fixture();
  const { sender, state } = owner(10, false);
  await writeFile(path, "keep me");
  const session = await begin(manager, sender);
  await manager.append(sender.id, session.id, 0, bytes("partial"));
  await manager.abort(sender.id, session.id);
  expect(await readFile(path, "utf8")).toBe("keep me");
  expect(await readdir(directory)).toEqual(["clip.webm"]);
  expect(state.backgroundThrottling).toBe(false);
  expect(sender.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
  await manager.abort(sender.id, session.id);
  await expect(manager.openExported(sender.id, path)).rejects.toThrow("has not exported");
});

it("rejects another owner's writes, finish and cancellation without damaging the authorized export", async () => {
  const { manager, sender, path } = fixture();
  const session = await begin(manager, sender);
  await expect(manager.append(20, session.id, 0, bytes("intruder"))).rejects.toThrow("another window");
  expect(() => manager.finish(20, session.id)).toThrow("another window");
  await expect(manager.abort(20, session.id)).rejects.toThrow("another window");
  await manager.append(sender.id, session.id, 0, bytes("authorized"));
  await manager.finish(sender.id, session.id);
  expect(await readFile(path, "utf8")).toBe("authorized");
});

it.each(["sequence", "oversized", "empty"])("cancels %s input without replacing a previous output", async (kind) => {
  const { manager, sender, path, state } = fixture();
  await writeFile(path, "previous");
  const session = await begin(manager, sender);
  const data =
    kind === "oversized"
      ? new ArrayBuffer(MAX_CLIP_CHUNK_BYTES + 1)
      : kind === "empty"
      ? new ArrayBuffer(0)
      : bytes("data");
  await expect(manager.append(sender.id, session.id, kind === "sequence" ? 1 : 0, data)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("previous");
  expect(await readdir(directory)).toEqual(["clip.webm"]);
  expect(state.backgroundThrottling).toBe(true);
});

it("rejects empty recordings and removes their temporary file", async () => {
  const { manager, sender } = fixture();
  const session = await begin(manager, sender);
  await expect(manager.finish(sender.id, session.id)).rejects.toThrow("any video data");
  expect(await readdir(directory)).toEqual([]);
});

it("cleans up a real file-write failure and preserves the old destination", async () => {
  const { manager, path, sender, state } = fixture({
    ...realFiles,
    open: async (path) => {
      const handle = await open(path, "wx");
      await handle.close();
      return handle;
    },
  });
  await writeFile(path, "old");
  const session = await begin(manager, sender);
  await expect(manager.append(sender.id, session.id, 0, bytes("new"))).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("old");
  expect(await readdir(directory)).toEqual(["clip.webm"]);
  expect(state.backgroundThrottling).toBe(true);
});

it("removes the temporary file when the atomic destination replacement fails", async () => {
  const { manager, path, sender } = fixture({
    ...realFiles,
    commit: () => {
      throw new Error("destination locked");
    },
  });
  await writeFile(path, "old");
  const session = await begin(manager, sender);
  await manager.append(sender.id, session.id, 0, bytes("new"));
  await expect(manager.finish(sender.id, session.id)).rejects.toThrow("destination locked");
  expect(await readFile(path, "utf8")).toBe("old");
  expect(await readdir(directory)).toEqual(["clip.webm"]);
});

it("cancellation during final flushing cannot commit over the prior clip", async () => {
  const flushing = deferred<void>();
  const entered = deferred<void>();
  const { manager, path, sender, state } = fixture({
    ...realFiles,
    open: async (path) => {
      const handle = await open(path, "wx");
      jest.spyOn(handle, "sync").mockImplementation(async () => {
        entered.resolve();
        await flushing.promise;
      });
      return handle;
    },
  });
  await writeFile(path, "prior clip");
  const session = await begin(manager, sender);
  await manager.append(sender.id, session.id, 0, bytes("replacement"));
  const finished = manager.finish(sender.id, session.id).catch((error) => error);
  await entered.promise;
  const cancelled = manager.abort(sender.id, session.id);
  expect(state.backgroundThrottling).toBe(true);
  flushing.resolve();
  await cancelled;
  expect(await finished).toBeInstanceOf(Error);
  expect(await readFile(path, "utf8")).toBe("prior clip");
  expect(await readdir(directory)).toEqual(["clip.webm"]);
});

it("bounds pending bytes across owners and keeps the other owner's export usable", async () => {
  const draining = deferred<void>();
  const files: ClipExportFiles = {
    ...realFiles,
    open: async (path) => {
      const handle = await open(path, "wx");
      return new Proxy(handle, {
        get(target, property) {
          if (property === "write")
            return async (...args: unknown[]) => {
              await draining.promise;
              return Reflect.apply(target.write, target, args);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const { manager, sender, ui } = fixture(files);
  const first = await begin(manager, sender);
  const secondOwner = owner(20).sender;
  ui.selectDestination.mockResolvedValueOnce(join(directory, "second.webm"));
  const second = await begin(manager, secondOwner);
  const chunk = new ArrayBuffer(MAX_CLIP_CHUNK_BYTES);
  const pending = [
    manager.append(10, first.id, 0, chunk),
    manager.append(20, second.id, 0, chunk),
    manager.append(10, first.id, 1, chunk),
    manager.append(20, second.id, 1, chunk),
  ].map((promise) => promise.catch((error) => error));
  const rejected = manager.append(10, first.id, 2, bytes("over budget")).catch((error) => error);
  draining.resolve();
  expect(await rejected).toEqual(expect.objectContaining({ message: expect.stringContaining("cannot keep up") }));
  await Promise.all(pending);
  await manager.finish(20, second.id);
  expect(await readdir(directory)).toEqual(["second.webm"]);
});

it.each(["navigation", "crash", "destroyed"])("cleans up on owner %s", async (event) => {
  const { manager, sender, events, path, state } = fixture();
  await writeFile(path, "old");
  const session = await begin(manager, sender);
  await manager.append(sender.id, session.id, 0, bytes("unfinished"));
  if (event === "navigation") events.emit("did-start-navigation", {}, "reload", false, true);
  else events.emit(event === "crash" ? "render-process-gone" : "destroyed");
  await manager.abortOwner(sender.id);
  expect(await readFile(path, "utf8")).toBe("old");
  expect(await readdir(directory)).toEqual(["clip.webm"]);
  expect(state.backgroundThrottling).toBe(true);
  if (event === "destroyed") expect(events.listenerCount("did-start-navigation")).toBe(0);
});

it("does not cancel on subframe navigation or an in-page change", async () => {
  const { manager, sender, events } = fixture();
  const session = await begin(manager, sender);
  events.emit("did-start-navigation", {}, "frame", false, false);
  events.emit("did-start-navigation", {}, "#anchor", true, true);
  await manager.append(sender.id, session.id, 0, bytes("complete"));
  await manager.finish(sender.id, session.id);
});

it("invalidates exported-file privileges on main-frame navigation", async () => {
  const { manager, sender, events, path } = fixture();
  const session = await begin(manager, sender);
  await manager.append(sender.id, session.id, 0, bytes("complete"));
  await manager.finish(sender.id, session.id);
  events.emit("did-start-navigation", {}, "new-page", false, true);
  await expect(manager.openExported(sender.id, path)).rejects.toThrow("has not exported");
});

it("does not create a temp file if the owner navigated while the save dialog was open", async () => {
  const { manager, sender, events, ui, path } = fixture();
  const destination = deferred<string>();
  ui.selectDestination.mockReturnValueOnce(destination.promise);
  const pending = begin(manager, sender).catch((error) => error);
  events.emit("did-start-navigation", {}, "reload", false, true);
  destination.resolve(path);
  expect(await pending).toEqual(expect.objectContaining({ message: "Unexpected cancelled test export" }));
  expect(await readdir(directory)).toEqual([]);
  expect(sender.setBackgroundThrottling).not.toHaveBeenCalled();
});

it("disposes active files and does not wait on a still-open save dialog during quit", async () => {
  const { manager, sender, ui, path, state } = fixture();
  const session = await begin(manager, sender);
  await manager.append(sender.id, session.id, 0, bytes("partial"));
  const second = owner(20);
  const destination = deferred<string>();
  ui.selectDestination.mockReturnValueOnce(destination.promise);
  const pending = manager.begin(second.sender, { fileName: "second.webm", extension: "webm" });
  await manager.dispose();
  expect(manager.hasWork).toBe(false);
  expect(state.backgroundThrottling).toBe(true);
  expect(await readdir(directory)).toEqual([]);
  destination.resolve(path);
  expect(await pending).toBeNull();
});

it("enforces recorder extension without silently changing a selected output path", async () => {
  const { manager, sender, ui, path } = fixture();
  await writeFile(path, "keep webm");
  await expect(manager.begin(sender, { fileName: "recording.webm", extension: "mp4" })).rejects.toThrow(
    ".mp4 extension",
  );
  expect(ui.selectDestination).toHaveBeenCalledWith(sender, { fileName: "recording.mp4", extension: "mp4" });
  expect(await readFile(path, "utf8")).toBe("keep webm");
  expect(await readdir(directory)).toEqual(["clip.webm"]);
});

it("publishes the finalized MP4 only after the remux has finished", async () => {
  const finalizer = {
    finalize: jest.fn(async (input: string, output: string) => {
      expect(await readFile(input, "utf8")).toBe("fragmented recording");
      expect(await readFile(output, "utf8")).toBe("");
      expect(await readFile(path, "utf8")).toBe("prior clip");
      await writeFile(output, "indexed recording");
    }),
  };
  const { manager, path, sender } = fixture(undefined, finalizer, "mp4");
  await writeFile(path, "prior clip");
  const session = await begin(manager, sender, "mp4");
  await manager.append(sender.id, session.id, 0, bytes("fragmented recording"));
  expect(await manager.finish(sender.id, session.id)).toEqual({ path });
  expect(finalizer.finalize).toHaveBeenCalledTimes(1);
  expect(await readFile(path, "utf8")).toBe("indexed recording");
  expect(await readdir(directory)).toEqual(["clip.mp4"]);
  expect(manager.hasWork).toBe(false);
});

it("keeps WebM byte-for-byte and does not invoke MP4 finalization", async () => {
  const finalizer = { finalize: jest.fn(async () => undefined) };
  const { manager, path, sender } = fixture(undefined, finalizer);
  const session = await begin(manager, sender);
  await manager.append(sender.id, session.id, 0, bytes("original webm"));
  await manager.finish(sender.id, session.id);
  expect(finalizer.finalize).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe("original webm");
});

it.each(["abort", "dispose"])("%s waits for a running finalizer before removing both owned files", async (action) => {
  const entered = deferred<{ input: string; output: string; signal: AbortSignal }>();
  const closed = deferred<void>();
  const finalizer = {
    finalize: jest.fn(async (input: string, output: string, signal: AbortSignal) => {
      entered.resolve({ input, output, signal });
      await closed.promise;
      expect(await readFile(input, "utf8")).toBe("raw clip");
      await writeFile(output, "late process write");
      if (signal.aborted) throw new Error("cancelled finalizer");
    }),
  };
  const { manager, path, sender } = fixture(undefined, finalizer, "mp4");
  await writeFile(path, "keep prior clip");
  const session = await begin(manager, sender, "mp4");
  await manager.append(sender.id, session.id, 0, bytes("raw clip"));
  const finishing = manager.finish(sender.id, session.id).catch((error) => error);
  const running = await entered.promise;
  let stopped = false;
  const stopping = (action === "abort" ? manager.abort(sender.id, session.id) : manager.dispose()).then(() => {
    stopped = true;
  });
  expect(running.signal.aborted).toBe(true);
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect((await readdir(directory)).length).toBe(3);
  closed.resolve();
  await stopping;
  expect(await finishing).toBeInstanceOf(Error);
  expect(await readFile(path, "utf8")).toBe("keep prior clip");
  expect(await readdir(directory)).toEqual(["clip.mp4"]);
  expect(manager.hasWork).toBe(false);
});

it("cancellation during output reservation prevents the finalizer from starting", async () => {
  const reserving = deferred<void>();
  const reserved = deferred<void>();
  const finalizer = { finalize: jest.fn(async () => undefined) };
  const { manager, sender } = fixture(
    {
      ...realFiles,
      open: async (path) => {
        const file = await realFiles.open(path);
        if (path.endsWith(".final.mp4")) {
          reserved.resolve();
          await reserving.promise;
        }
        return file;
      },
    },
    finalizer,
    "mp4",
  );
  const session = await begin(manager, sender, "mp4");
  await manager.append(sender.id, session.id, 0, bytes("raw clip"));
  const finishing = manager.finish(sender.id, session.id).catch((error) => error);
  await reserved.promise;
  const stopping = manager.abort(sender.id, session.id);
  reserving.resolve();
  await stopping;
  expect(await finishing).toBeInstanceOf(Error);
  expect(finalizer.finalize).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

it("does not delete an unrelated file when exclusive final-output reservation fails", async () => {
  const finalizer = { finalize: jest.fn(async () => undefined) };
  const { manager, sender } = fixture(undefined, finalizer, "mp4");
  const session = await begin(manager, sender, "mp4");
  const collision = join(directory, `.rewind-${session.id}.final.mp4`);
  await writeFile(collision, "unrelated file");
  await manager.append(sender.id, session.id, 0, bytes("raw clip"));
  await expect(manager.finish(sender.id, session.id)).rejects.toThrow("EEXIST");
  expect(await readFile(collision, "utf8")).toBe("unrelated file");
  expect(await readdir(directory)).toEqual([`.rewind-${session.id}.final.mp4`]);
  expect(finalizer.finalize).not.toHaveBeenCalled();
});

it.each(["unavailable", "failed", "commit"])("preserves the old MP4 when finalization is %s", async (failure) => {
  const finalizer =
    failure === "unavailable"
      ? undefined
      : {
          finalize: async (_input: string, output: string) => {
            await writeFile(output, "remux output");
            if (failure === "failed") throw new Error("remux failed");
          },
        };
  const { manager, sender, path } = fixture(
    {
      ...realFiles,
      commit: (temporary, destination) => {
        if (failure === "commit") throw new Error("destination locked");
        realFiles.commit(temporary, destination);
      },
    },
    finalizer,
    "mp4",
  );
  await writeFile(path, "previous MP4");
  const session = await begin(manager, sender, "mp4");
  await manager.append(sender.id, session.id, 0, bytes("raw MP4"));
  await expect(manager.finish(sender.id, session.id)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("previous MP4");
  expect(await readdir(directory)).toEqual(["clip.mp4"]);
  expect(manager.hasWork).toBe(false);
});

const nativeVideo: ClipExportVideo = { width: 1920, height: 1080, fps: 240, frameCount: 1, audio: false };
async function beginVideo(manager: ClipExportManager, sender: ClipExportOwner, video = nativeVideo) {
  const result = await manager.begin(sender, { fileName: "native.mp4", extension: "mp4", video });
  if (!result) throw new Error("Unexpected cancelled native export");
  return result;
}

it.each([false, true])("saves native frames with audio=%s and removes every staging file", async (audio) => {
  let encodedPath = "";
  const encoder = {
    append: jest.fn(async () => {
      await writeFile(encodedPath, "encoded frames");
    }),
    finish: jest.fn(async (audioPath: string | undefined, output: string) => {
      if (audio) {
        if (!audioPath) throw new Error("Expected captured audio path");
        expect(await readFile(audioPath, "utf8")).toBe("opus audio chunks");
      } else expect(audioPath).toBeUndefined();
      expect(await readFile(encodedPath, "utf8")).toBe("encoded frames");
      await writeFile(output, "finished native clip");
    }),
    cancel: jest.fn(async () => undefined),
  };
  const createEncoder = jest.fn((_video: ClipExportVideo, path: string) => {
    encodedPath = path;
    return encoder;
  });
  const legacy = { finalize: jest.fn(async () => undefined) };
  const { manager, sender, path } = fixture(undefined, legacy, "mp4", createEncoder);
  const session = await beginVideo(manager, sender, { ...nativeVideo, audio });
  expect(createEncoder).not.toHaveBeenCalled();
  if (audio) await manager.append(sender.id, session.id, 0, bytes("opus audio chunks"));
  expect(createEncoder).not.toHaveBeenCalled();
  await manager.appendFrame(sender.id, session.id, 0, 0, bytes("RGBA"));
  expect(encoder.append).toHaveBeenCalledWith(0, 0, Buffer.from("RGBA"));
  await manager.finish(sender.id, session.id);
  expect(await readFile(path, "utf8")).toBe("finished native clip");
  expect(await readdir(directory)).toEqual(["clip.mp4"]);
  expect(legacy.finalize).not.toHaveBeenCalled();
  expect(encoder.cancel).not.toHaveBeenCalled();
  expect(manager.hasWork).toBe(false);
});

it("rejects invalid native settings before showing a save dialog", async () => {
  const { manager, sender, ui } = fixture(undefined, undefined, "mp4");
  await expect(
    manager.begin(sender, { fileName: "clip.mp4", extension: "mp4", video: { ...nativeVideo, fps: 83 } }),
  ).rejects.toThrow("Invalid native");
  await expect(manager.begin(sender, { fileName: "clip.webm", extension: "webm", video: nativeVideo })).rejects.toThrow(
    "requires MP4",
  );
  expect(ui.selectDestination).not.toHaveBeenCalled();
});

it("rejects audio on a silent native export and requires audio when requested", async () => {
  const encoder = {
    append: async () => undefined,
    finish: jest.fn(async () => undefined),
    cancel: async () => undefined,
  };
  const { manager, sender } = fixture(undefined, undefined, "mp4", () => encoder);
  const silent = await beginVideo(manager, sender);
  await expect(manager.append(sender.id, silent.id, 0, bytes("unexpected audio"))).rejects.toThrow("without audio");
  const audio = await beginVideo(manager, sender, { ...nativeVideo, audio: true });
  await manager.appendFrame(sender.id, audio.id, 0, 0, bytes("RGBA"));
  await expect(manager.finish(sender.id, audio.id)).rejects.toThrow("any audio data");
  expect(encoder.finish).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

it.each(["abort", "dispose", "overlapping write"])(
  "%s stops a blocked frame stream before deleting staging files",
  async (reason) => {
    let rejectWrite!: (error: Error) => void;
    const entered = deferred<void>();
    const closed = deferred<void>();
    const encoder = {
      append: () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
          entered.resolve();
        }),
      finish: async () => undefined,
      cancel: jest.fn(async () => {
        rejectWrite(new Error("frame aborted"));
        await closed.promise;
      }),
    };
    const { manager, sender, path } = fixture(undefined, undefined, "mp4", () => encoder);
    await writeFile(path, "prior output");
    const session = await beginVideo(manager, sender);
    const first = manager.appendFrame(sender.id, session.id, 0, 0, bytes("RGBA")).catch((error) => error);
    await entered.promise;
    const stopping =
      reason === "abort"
        ? manager.abort(sender.id, session.id)
        : reason === "dispose"
        ? manager.dispose()
        : manager.appendFrame(sender.id, session.id, 0, 4, bytes("RGBA")).catch((error) => error);
    for (let count = 0; encoder.cancel.mock.calls.length === 0 && count < 10; count++) await Promise.resolve();
    expect(encoder.cancel).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toHaveLength(3);
    closed.resolve();
    await stopping;
    expect(await first).toBeInstanceOf(Error);
    expect(await readFile(path, "utf8")).toBe("prior output");
    expect(await readdir(directory)).toEqual(["clip.mp4"]);
    expect(manager.hasWork).toBe(false);
  },
);

it("does not create an encoder after cancellation during video-file reservation", async () => {
  const reserving = deferred<void>(),
    entered = deferred<void>();
  const createEncoder = jest.fn(() => ({
    append: async () => undefined,
    finish: async () => undefined,
    cancel: async () => undefined,
  }));
  const { manager, sender } = fixture(
    {
      ...realFiles,
      open: async (path) => {
        const file = await realFiles.open(path);
        if (path.endsWith(".video.mp4")) {
          entered.resolve();
          await reserving.promise;
        }
        return file;
      },
    },
    undefined,
    "mp4",
    createEncoder,
  );
  const session = await beginVideo(manager, sender);
  const write = manager.appendFrame(sender.id, session.id, 0, 0, bytes("RGBA")).catch((error) => error);
  await entered.promise;
  const abort = manager.abort(sender.id, session.id);
  reserving.resolve();
  await abort;
  expect(await write).toBeInstanceOf(Error);
  expect(createEncoder).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

it("preserves the prior output if a partial frame set cannot be finalized", async () => {
  const encoder = {
    append: async () => undefined,
    finish: async () => {
      throw new Error("exactly 240 complete frames required");
    },
    cancel: jest.fn(async () => undefined),
  };
  const { manager, sender, path } = fixture(undefined, undefined, "mp4", () => encoder);
  await writeFile(path, "previous clip");
  const session = await beginVideo(manager, sender, { ...nativeVideo, frameCount: 240 });
  await manager.appendFrame(sender.id, session.id, 0, 0, bytes("RGBA"));
  await expect(manager.finish(sender.id, session.id)).rejects.toThrow("exactly 240");
  expect(encoder.cancel).toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe("previous clip");
  expect(await readdir(directory)).toEqual(["clip.mp4"]);
});

it("rejects another window's frame input without cancelling the authorized export", async () => {
  const encoder = {
    append: jest.fn(async () => undefined),
    finish: async () => undefined,
    cancel: jest.fn(async () => undefined),
  };
  const { manager, sender } = fixture(undefined, undefined, "mp4", () => encoder);
  const session = await beginVideo(manager, sender);
  await expect(manager.appendFrame(20, session.id, 0, 0, bytes("RGBA"))).rejects.toThrow("another window");
  await manager.appendFrame(sender.id, session.id, 0, 0, bytes("RGBA"));
  expect(encoder.append).toHaveBeenCalledTimes(1);
  expect(encoder.cancel).not.toHaveBeenCalled();
});

describe("the save dialog's folder", () => {
  /** What the manager hands the save dialog for a request, whatever `directory` holds. */
  async function dialogRequest(directoryValue: unknown) {
    const { manager, sender, ui } = fixture();
    ui.selectDestination.mockResolvedValueOnce(null as unknown as string);
    await expect(
      manager.begin(sender, { fileName: "Replay", extension: "mp4", directory: directoryValue }),
    ).resolves.toBeNull();
    return (ui.selectDestination.mock.calls as unknown as [ClipExportOwner, Record<string, unknown>][])[0][1];
  }

  it("keeps an absolute directory in the request given to the save dialog", async () => {
    const absolute = join(directory, "Clips");
    expect(isAbsolute(absolute)).toBe(true);
    expect(await dialogRequest(absolute)).toEqual({ fileName: "Replay.mp4", extension: "mp4", directory: absolute });
  });

  it.each([
    ["a relative path", join("Clips", "osu")],
    ["an empty string", ""],
    ["a number", 42],
    ["an object", { path: join(tmpdir(), "Clips") }],
    ["null", null],
    ["a path longer than 1000 characters", join(tmpdir(), "x".repeat(1000))],
  ])("drops %s without throwing and still opens the dialog", async (_name, value) => {
    const request = await dialogRequest(value);
    expect(request).toEqual({ fileName: "Replay.mp4", extension: "mp4" });
    expect(request).not.toHaveProperty("directory");
  });

  it("keeps a directory of exactly 1000 characters", async () => {
    const root = join(directory, "x");
    const limit = join(root, "y".repeat(1000 - root.length - 1));
    expect(limit).toHaveLength(1000);
    expect(await dialogRequest(limit)).toHaveProperty("directory", limit);
  });
});
