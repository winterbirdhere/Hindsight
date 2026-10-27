import { ChildProcess, spawn, SpawnOptions } from "child_process";
import { open } from "fs/promises";
import { isAbsolute } from "path";

export interface ClipFinalizer {
  /** The caller owns the empty output file and removes it after failure or cancellation. */
  finalize(input: string, output: string, signal: AbortSignal): Promise<void>;
}

type ClipProcessFactory = (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
const MAX_STDERR_CHARACTERS = 16 * 1024;
const FINALIZATION_TIMEOUT_MS = 5 * 60_000;

function cancelled() {
  return new Error("Clip export cancelled.");
}

/** Rebuild a normal indexed MP4 without decoding or changing the captured audio/video. */
export class FFmpegClipFinalizer implements ClipFinalizer {
  constructor(
    private readonly executable: () => string,
    private readonly createProcess: ClipProcessFactory = spawn,
    private readonly timeoutMs = FINALIZATION_TIMEOUT_MS,
  ) {}

  async finalize(input: string, output: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw cancelled();
    const executable = this.executable();
    if (!isAbsolute(executable) || !isAbsolute(input) || !isAbsolute(output))
      throw new Error("Clip finalization requires absolute file paths.");
    let child: ChildProcess;
    try {
      child = this.createProcess(
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
    } catch (error) {
      throw new Error(`The bundled clip finalizer could not start: ${String(error)}`);
    }
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined;
      let stderr = "";
      const onData = (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_CHARACTERS);
      };
      const terminate = (error: Error) => {
        failure ??= error;
        // Wait for close even after kill: output must no longer be in use when
        // the owning session deletes its temporary files.
        try {
          child.kill("SIGKILL");
        } catch (error) {
          failure = new Error(`${failure.message} Could not stop the finalizer: ${String(error)}`);
        }
      };
      const onAbort = () => terminate(cancelled());
      const onError = (error: Error) => {
        failure ??= new Error(`The bundled clip finalizer could not run: ${error.message}`);
      };
      const onClose = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        child.stderr?.removeListener("data", onData);
        child.removeListener("error", onError);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(new Error(`MP4 finalization failed (${exitSignal ?? code ?? "unknown"}). ${stderr.trim()}`));
        else resolve();
      };
      const timeout = setTimeout(
        () => terminate(new Error("MP4 finalization took too long. Try saving to a faster drive.")),
        this.timeoutMs,
      );
      child.stderr?.on("data", onData);
      child.on("error", onError);
      child.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    if (signal.aborted) throw cancelled();
    const file = await open(output, "r+");
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size === 0) throw new Error("MP4 finalization produced no video data.");
      await file.sync();
    } finally {
      await file.close();
    }
    if (signal.aborted) throw cancelled();
  }
}
