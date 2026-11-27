import { parentPort } from "worker_threads";
import { read, OsrReplay } from "@rewind/osu-local/osr-reader";

type Request = { id: number; bytes: Uint8Array };
type Reply = { id: number; ok: true; replay: OsrReplay } | { id: number; ok: false; error: unknown };

/** Same parser, on an owned thread. Structured clone retains Date and native score fields. */
export async function handleReplayRead(value: Request, reader: (bytes: Buffer) => Promise<OsrReplay> = read): Promise<Reply> {
  try {
    if (!Number.isSafeInteger(value?.id) || !(value.bytes instanceof Uint8Array)) throw new Error("Invalid replay worker request");
    return { id: value.id, ok: true, replay: await reader(Buffer.from(value.bytes)) };
  } catch (error) { return { id: value?.id, ok: false, error }; }
}

if (parentPort) {
  const port = parentPort;
  port.once("message", (value: Request) => {
    void handleReplayRead(value).then(result => { port.postMessage(result); port.close(); });
  });
}
