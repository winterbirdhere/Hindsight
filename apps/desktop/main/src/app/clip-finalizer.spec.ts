import { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { mkdtemp, readFile, rm, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import { FFmpegClipFinalizer } from "./clip-finalizer";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "rewind finalizer "));
});
afterEach(async () => {
  jest.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

async function fixture(timeoutMs?: number) {
  const input = join(directory, "recorded input.part");
  const output = join(directory, "owned output.mp4");
  const executable = join(directory, "bundled media", "ffmpeg.exe");
  await writeFile(input, "recorded video and audio");
  await writeFile(output, "");
  const child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    kill: jest.fn(() => true),
  });
  const createProcess = jest.fn(() => child as unknown as ChildProcess);
  const finalizer = new FFmpegClipFinalizer(() => executable, createProcess, timeoutMs);
  const controller = new AbortController();
  return { finalizer, child, createProcess, input, output, executable, controller };
}

it("uses only the bundled executable and preserves both streams with normal faststart MP4", async () => {
  const { finalizer, child, createProcess, input, output, executable, controller } = await fixture();
  const pending = finalizer.finalize(input, output, controller.signal);
  expect(createProcess).toHaveBeenCalledWith(
    executable,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-protocol_whitelist",
      "file",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      output,
    ],
    { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] },
  );
  await writeFile(output, "finalized video and audio");
  child.emit("close", 0, null);
  await pending;
  expect(await readFile(input, "utf8")).toBe("recorded video and audio");
  expect(await readFile(output, "utf8")).toBe("finalized video and audio");
  expect(child.listenerCount("error")).toBe(0);
  expect(child.stderr.listenerCount("data")).toBe(0);
  controller.abort();
  expect(child.kill).not.toHaveBeenCalled();
});

it.each(["input", "output", "executable"])(
  "rejects a relative %s instead of resolving it through PATH",
  async (kind) => {
    const { createProcess, input, output, executable, controller } = await fixture();
    const finalizer = new FFmpegClipFinalizer(() => (kind === "executable" ? "ffmpeg" : executable), createProcess);
    await expect(
      finalizer.finalize(
        kind === "input" ? "recorded.part" : input,
        kind === "output" ? "output.mp4" : output,
        controller.signal,
      ),
    ).rejects.toThrow("absolute file paths");
    expect(createProcess).not.toHaveBeenCalled();
  },
);

it("does not start an already-cancelled finalization", async () => {
  const { finalizer, createProcess, input, output, controller } = await fixture();
  controller.abort();
  await expect(finalizer.finalize(input, output, controller.signal)).rejects.toThrow("cancelled");
  expect(createProcess).not.toHaveBeenCalled();
});

it("kills on cancellation and waits until the process closes before releasing its output", async () => {
  const { finalizer, child, input, output, controller } = await fixture();
  let settled = false;
  const pending = finalizer.finalize(input, output, controller.signal).catch((error: Error) => {
    settled = true;
    return error;
  });
  controller.abort();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  await Promise.resolve();
  expect(settled).toBe(false);
  await writeFile(output, "last process write");
  child.emit("close", null, "SIGKILL");
  expect(await pending).toEqual(expect.objectContaining({ message: expect.stringContaining("cancelled") }));
  expect(await readFile(output, "utf8")).toBe("last process write");
});

it("bounds finalization time and still awaits close after terminating the child", async () => {
  const { finalizer, child, input, output, controller } = await fixture(100);
  jest.useFakeTimers();
  let settled = false;
  const pending = finalizer.finalize(input, output, controller.signal).catch((error: Error) => {
    settled = true;
    return error;
  });
  jest.advanceTimersByTime(100);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", null, "SIGKILL");
  expect(await pending).toEqual(expect.objectContaining({ message: expect.stringContaining("took too long") }));
});

it("reports a synchronous spawn failure without touching the output", async () => {
  const { createProcess, input, output, executable, controller } = await fixture();
  createProcess.mockImplementationOnce(() => {
    throw new Error("ENOENT bundled ffmpeg");
  });
  const finalizer = new FFmpegClipFinalizer(() => executable, createProcess);
  await expect(finalizer.finalize(input, output, controller.signal)).rejects.toThrow("could not start");
  expect(await readFile(output, "utf8")).toBe("");
});

it("reports an asynchronous spawn failure only after close", async () => {
  const { finalizer, child, input, output, controller } = await fixture();
  let settled = false;
  const pending = finalizer.finalize(input, output, controller.signal).catch((error: Error) => {
    settled = true;
    return error;
  });
  child.emit("error", new Error("ENOENT bundled ffmpeg"));
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", -1, null);
  expect(await pending).toEqual(expect.objectContaining({ message: expect.stringContaining("ENOENT bundled ffmpeg") }));
});

it("bounds captured stderr while preserving useful failure details", async () => {
  const { finalizer, child, input, output, controller } = await fixture();
  const pending = finalizer.finalize(input, output, controller.signal).catch((error: Error) => error);
  child.stderr.write("discarded prefix" + "x".repeat(100_000) + " invalid MP4 trailer");
  child.emit("close", 1, null);
  const result = (await pending) as Error;
  expect(result.message).toContain("invalid MP4 trailer");
  expect(result.message).not.toContain("discarded prefix");
  expect(result.message.length).toBeLessThan(16 * 1024 + 100);
});

it.each(["empty", "missing"])("rejects a successful process that leaves %s output", async (kind) => {
  const { finalizer, child, input, output, controller } = await fixture();
  const pending = finalizer.finalize(input, output, controller.signal);
  if (kind === "missing") await unlink(output);
  child.emit("close", 0, null);
  await expect(pending).rejects.toThrow(kind === "empty" ? "no video data" : "ENOENT");
});
