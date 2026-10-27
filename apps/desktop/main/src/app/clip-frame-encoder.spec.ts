import { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import * as files from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import { ClipExportVideo, MAX_CLIP_FRAME_CHUNK_BYTES } from "../../../shared/clip-export";
import { FFmpegClipFrameEncoder, validateClipVideo } from "./clip-frame-encoder";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "rewind frame encoder "));
});
afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const settings: ClipExportVideo = { width: 1920, height: 1080, fps: 144, frameCount: 1, audio: false };

function child() {
  const callbacks: Array<(error?: Error | null) => void> = [];
  const stdin = Object.assign(new EventEmitter(), {
    write: jest.fn((_data: Buffer, callback: (error?: Error | null) => void) => {
      callbacks.push(callback);
      return false;
    }),
    end: jest.fn(),
  });
  const process = Object.assign(new EventEmitter(), { stdin, stderr: new PassThrough(), kill: jest.fn(() => true) });
  return { process, callbacks, stdin };
}

function fixture(video = settings, idleTimeout?: number) {
  const controller = new AbortController();
  const children: ReturnType<typeof child>[] = [];
  const spawned = new EventEmitter();
  const spawn = jest.fn(() => {
    const next = child();
    children.push(next);
    spawned.emit("spawn", children.length);
    return next.process as unknown as ChildProcess;
  });
  const videoPath = join(directory, "owned video.mp4"),
    output = join(directory, "owned final.mp4");
  const encoder = new FFmpegClipFrameEncoder(
    video,
    videoPath,
    controller.signal,
    () => join(directory, "ffmpeg.exe"),
    spawn,
    idleTimeout,
  );
  return { encoder, controller, children, spawn, spawned, videoPath, output };
}

async function acknowledge(test: ReturnType<typeof fixture>, frameIndex: number, offset: number, bytes: number) {
  const pending = test.encoder.append(frameIndex, offset, Buffer.alloc(bytes));
  const current = test.children[0];
  acknowledgeWrite(current);
  current.stdin.emit("drain");
  await pending;
}

function acknowledgeWrite(current: ReturnType<typeof child>) {
  const callback = current.callbacks.shift();
  if (!callback) throw new Error("No pending frame write");
  callback();
}

it("does not launch an encoder until the first frame, allowing an arbitrarily long audio pass", async () => {
  const { encoder, spawn } = fixture();
  expect(spawn).not.toHaveBeenCalled();
  await encoder.cancel();
  expect(spawn).not.toHaveBeenCalled();
});

it.each([60, 120, 144, 240] as const)(
  "supplies exact %i FPS raw input and software x264 output settings",
  async (fps) => {
    const test = fixture({ ...settings, fps });
    await acknowledge(test, 0, 0, 4);
    const args = (test.spawn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toEqual(
      expect.arrayContaining(["rawvideo", "rgba", "1920x1080", "libx264", "veryfast", "18", "yuv420p", "cfr"]),
    );
    expect(args[args.indexOf("-framerate") + 1]).toBe(String(fps));
    expect(args[args.indexOf("-r") + 1]).toBe(String(fps));
    expect(args).not.toContain("-re");
    const cancelling = test.encoder.cancel();
    test.children[0].process.emit("close", null, "SIGKILL");
    await cancelling;
  },
);

it("waits for both slow stdin write completion and drain before acknowledging the chunk", async () => {
  const test = fixture();
  let done = false;
  const write = test.encoder.append(0, 0, Buffer.alloc(4)).then(() => {
    done = true;
  });
  const first = test.children[0];
  acknowledgeWrite(first);
  await Promise.resolve();
  expect(done).toBe(false);
  await expect(test.encoder.append(0, 4, Buffer.alloc(4))).rejects.toThrow("previous frame chunk");
  first.stdin.emit("drain");
  await write;
  expect(done).toBe(true);
  const second = test.encoder.append(0, 4, Buffer.alloc(4));
  first.stdin.emit("drain");
  acknowledgeWrite(first);
  await second;
  const cancel = test.encoder.cancel();
  first.process.emit("close", null, "SIGKILL");
  await cancel;
});

it.each([
  [1, 0, 4],
  [0, 4, 4],
  [-1, 0, 4],
  [0, -1, 4],
  [0, 0, 0],
  [0, 0, MAX_CLIP_FRAME_CHUNK_BYTES + 1],
])("rejects out-of-order or oversized chunk %j without spawning", async (frameIndex, offset, length) => {
  const test = fixture();
  await expect(test.encoder.append(frameIndex, offset, Buffer.alloc(length))).rejects.toThrow("out of order");
  expect(test.spawn).not.toHaveBeenCalled();
});

it("requires exactly complete frames and rejects a chunk crossing the frame boundary", async () => {
  const test = fixture();
  const frameBytes = settings.width * settings.height * 4;
  await acknowledge(test, 0, 0, frameBytes - 4);
  await expect(test.encoder.append(0, frameBytes - 4, Buffer.alloc(8))).rejects.toThrow("invalid size");
  await expect(test.encoder.finish(undefined, test.output)).rejects.toThrow("exactly 1 complete frames");
  await acknowledge(test, 0, frameBytes - 4, 4);
  await expect(test.encoder.append(1, 0, Buffer.alloc(4))).rejects.toThrow("out of order");
  const cancel = test.encoder.cancel();
  test.children[0].process.emit("close", null, "SIGKILL");
  await cancel;
});

it("finalizes silent video with one faststart encode and transfers the exact bytes into the reserved output", async () => {
  const test = fixture();
  await acknowledge(test, 0, 0, settings.width * settings.height * 4);
  await writeFile(test.videoPath, "encoded frame with faststart");
  await writeFile(test.output, "");
  // A second native process is a regression, not an uncompleted fake process.
  test.spawn.mockImplementationOnce(() => {
    throw new Error("Silent video must not start a mux");
  });
  const finished = test.encoder.finish(undefined, test.output);
  test.children[0].process.emit("close", 0, null);
  await finished;
  const args = (test.spawn.mock.calls[0] as unknown as [string, string[]])[1];
  expect(args).toEqual(expect.arrayContaining(["-movflags", "+faststart"]));
  expect(test.spawn).toHaveBeenCalledTimes(1);
  expect(await readFile(test.output, "utf8")).toBe("encoded frame with faststart");
  await expect(readFile(test.videoPath)).rejects.toMatchObject({ code: "ENOENT" });
  await test.encoder.cancel();
});

it.each([true])(
  "finalizes completed video with audio=%s, preserving video and bounding the audio duration",
  async (audio) => {
    const test = fixture({ ...settings, audio });
    await acknowledge(test, 0, 0, settings.width * settings.height * 4);
    await writeFile(test.videoPath, "encoded frame");
    await writeFile(test.output, "");
    const audioPath = audio ? join(directory, "captured audio.webm") : undefined;
    const finished = test.encoder.finish(audioPath, test.output);
    expect(test.children[0].stdin.end).toHaveBeenCalled();
    const muxStarted = new Promise<void>((resolve) => test.spawned.once("spawn", () => resolve()));
    test.children[0].process.emit("close", 0, null);
    await muxStarted;
    expect(test.children).toHaveLength(2);
    const args = (test.spawn.mock.calls[1] as unknown as [string, string[]])[1];
    expect(args).toEqual(expect.arrayContaining(["-c:v", "copy", "+faststart"]));
    if (audio) {
      expect(args).toEqual(expect.arrayContaining([audioPath, "1:a:0", "aac", "192000"]));
      expect(args[args.indexOf("-af") + 1]).toBe(
        "aresample=48000,asetpts=PTS-STARTPTS,apad,atrim=duration=0.006944444444",
      );
    } else {
      expect(args).toContain("-an");
      expect(args).not.toContain("aac");
    }
    await writeFile(test.output, "final output");
    test.children[1].process.emit("close", 0, null);
    await finished;
    await test.encoder.cancel();
    expect(test.children.every(({ process }) => process.kill.mock.calls.length === 0)).toBe(true);
  },
);

it("rejects a failed silent transfer and retains the encoded source", async () => {
  const test = fixture();
  await acknowledge(test, 0, 0, settings.width * settings.height * 4);
  await writeFile(test.videoPath, "encoded frame");
  const finished = test.encoder.finish(undefined, join(directory, "missing", "output.mp4"));
  test.children[0].process.emit("close", 0, null);
  await expect(finished).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(test.videoPath, "utf8")).toBe("encoded frame");
  expect(test.spawn).toHaveBeenCalledTimes(1);
  await test.encoder.cancel();
});

it("rejects cancellation during the silent transfer instead of publishing success", async () => {
  const test = fixture();
  await acknowledge(test, 0, 0, settings.width * settings.height * 4);
  await writeFile(test.videoPath, "encoded frame");
  await writeFile(test.output, "");
  const rename = files.rename;
  let release!: () => void;
  let entered!: () => void;
  const transferring = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.spyOn(files, "rename").mockImplementationOnce(async (from, to) => {
    entered();
    await blocked;
    await rename(from, to);
  });
  let settled = false;
  const finished = test.encoder.finish(undefined, test.output).then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return error as Error;
    },
  );
  test.children[0].process.emit("close", 0, null);
  await transferring;
  test.controller.abort();
  expect(settled).toBe(false);
  release();
  expect((await finished)?.message).toContain("cancelled");
  expect(test.spawn).toHaveBeenCalledTimes(1);
  await test.encoder.cancel();
});

it("cancels a blocked stdin write immediately but waits for native process close", async () => {
  const test = fixture();
  const write = test.encoder.append(0, 0, Buffer.alloc(4)).catch((error) => error);
  test.controller.abort();
  expect(await write).toBeInstanceOf(Error);
  let closed = false;
  const cancel = test.encoder.cancel().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(test.children[0].process.kill).toHaveBeenCalledWith("SIGKILL");
  test.children[0].process.emit("close", null, "SIGKILL");
  await cancel;
});

it("fails a stalled native encoder and does not resolve a blocked frame as written", async () => {
  const test = fixture(settings, 100);
  jest.useFakeTimers();
  const pending = test.encoder.append(0, 0, Buffer.alloc(4)).catch((error) => error);
  jest.advanceTimersByTime(100);
  expect(test.children[0].process.kill).toHaveBeenCalledWith("SIGKILL");
  test.children[0].process.emit("close", null, "SIGKILL");
  expect(((await pending) as Error).message).toContain("stopped making progress");
  await test.encoder.cancel();
});

it("propagates spawn failure and premature process exit", async () => {
  const test = fixture();
  test.spawn.mockImplementationOnce(() => {
    throw new Error("missing bundled encoder");
  });
  await expect(test.encoder.append(0, 0, Buffer.alloc(4))).rejects.toThrow("missing bundled encoder");
  const next = fixture();
  await acknowledge(next, 0, 0, 4);
  next.children[0].process.emit("close", 0, null);
  await expect(next.encoder.append(0, 4, Buffer.alloc(4))).rejects.toThrow("before all frames");
  await next.encoder.cancel();
});

it("kills an encoder whose stdin fails and rejects the frame instead of acknowledging it", async () => {
  const test = fixture();
  const pending = test.encoder.append(0, 0, Buffer.alloc(4)).catch((error) => error);
  test.children[0].stdin.emit("error", new Error("broken pipe after output failure"));
  expect(((await pending) as Error).message).toContain("broken pipe");
  expect(test.children[0].process.kill).toHaveBeenCalledWith("SIGKILL");
  const cancel = test.encoder.cancel();
  test.children[0].process.emit("close", 1, null);
  await cancel;
});

it("cancels during audio mux and awaits its native close before releasing the output", async () => {
  const test = fixture({ ...settings, audio: true });
  await acknowledge(test, 0, 0, settings.width * settings.height * 4);
  await writeFile(test.videoPath, "encoded frame");
  const finished = test.encoder.finish(join(directory, "audio.webm"), test.output).catch((error) => error);
  const muxStarted = new Promise<void>((resolve) => test.spawned.once("spawn", () => resolve()));
  test.children[0].process.emit("close", 0, null);
  await muxStarted;
  test.controller.abort();
  expect(test.children[1].process.kill).toHaveBeenCalledWith("SIGKILL");
  let stopped = false;
  const cancel = test.encoder.cancel().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  test.children[1].process.emit("close", null, "SIGKILL");
  await cancel;
  expect(((await finished) as Error).message).toContain("cancelled");
});

it.each(["encode", "mux"])("rejects empty %s output even when its native process exits successfully", async (phase) => {
  const test = fixture({ ...settings, audio: phase === "mux" });
  await acknowledge(test, 0, 0, settings.width * settings.height * 4);
  await writeFile(test.videoPath, phase === "encode" ? "" : "encoded frame");
  await writeFile(test.output, "");
  const finished = test.encoder
    .finish(phase === "mux" ? join(directory, "audio.webm") : undefined, test.output)
    .catch((error) => error);
  const muxStarted =
    phase === "mux" ? new Promise<void>((resolve) => test.spawned.once("spawn", () => resolve())) : undefined;
  test.children[0].process.emit("close", 0, null);
  if (muxStarted) {
    await muxStarted;
    test.children[1].process.emit("close", 0, null);
  }
  expect(((await finished) as Error).message).toContain("no video data");
  await test.encoder.cancel();
});

it.each([
  { width: 1280 },
  { height: 1079 },
  { fps: 30 },
  { frameCount: 0 },
  { frameCount: 1.5 },
  { frameCount: 1_000_001 },
  { audio: 1 },
])("rejects invalid descriptor %j", (override) => {
  expect(() => validateClipVideo({ ...settings, ...override })).toThrow("Invalid native");
});
