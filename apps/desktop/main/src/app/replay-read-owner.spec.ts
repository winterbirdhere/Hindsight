import { EventEmitter } from "events";
import { ReplayReadOwner } from "./replay-read-owner";

class Thread extends EventEmitter {
  sent: unknown[] = [];
  postMessage(value: unknown) { this.sent.push(value); }
  terminate = jest.fn(() => new Promise<number>(() => undefined));
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const threads: Thread[] = [];
  const owner = new ReplayReadOwner(() => { const thread = new Thread(); threads.push(thread); return thread as never; });
  return { owner, threads };
}
function complete(thread: Thread, replay = { replay_data: "frames", timestamp: new Date(12) }) {
  const request = thread.sent[0] as { id: number };
  thread.emit("message", { id: request.id, ok: true, replay });
}
it("retains the original Buffer and publishes only after worker exit", async () => {
  const { owner, threads } = harness(), bytes = Buffer.from("original");
  let settled = false;
  const result = owner.read(1, decode => decode(bytes)); void result.then(() => { settled = true; });
  await tick(); expect(threads).toHaveLength(1); expect((threads[0].sent[0] as { bytes: Buffer }).bytes).toBe(bytes);
  complete(threads[0]); await tick(); expect(settled).toBe(false); expect(bytes.toString()).toBe("original");
  threads[0].emit("exit", 0); expect(await result).toEqual({ replay_data: "frames", timestamp: new Date(12) }); await owner.close();
});
it("keeps only latest pending work and fences it behind actual exit", async () => {
  const { owner, threads } = harness(), work = () => Buffer.from("bytes");
  const first = owner.read(1, decode => decode(work())); const firstFailure = expect(first).rejects.toThrow("replaced"); await tick();
  const supersededWork = jest.fn(); const second = owner.read(1, supersededWork); const secondFailure = expect(second).rejects.toThrow("replaced");
  const latestWork = jest.fn(decode => decode(work())); const third = owner.read(1, latestWork);
  await tick(); expect(supersededWork).not.toHaveBeenCalled(); expect(latestWork).not.toHaveBeenCalled(); expect(threads[0].terminate).toHaveBeenCalledTimes(1);
  complete(threads[0]); threads[0].emit("exit", 1); await firstFailure; await secondFailure; await tick();
  expect(threads).toHaveLength(2); complete(threads[1]); threads[1].emit("exit", 0); await third; await owner.close();
});
it("preserves decoder error message and closes against actual exit", async () => {
  const { owner, threads } = harness(); const result = owner.read(2, decode => decode(Buffer.alloc(0))); const rejected = expect(result).rejects.toThrow("original malformed replay");
  await tick(); const id = (threads[0].sent[0] as { id: number }).id;
  threads[0].emit("message", { id, ok: false, error: new Error("original malformed replay") }); threads[0].emit("exit", 0); await rejected;
  const pending = owner.read(2, decode => decode(Buffer.alloc(0))); const cancelled = expect(pending).rejects.toThrow("closed"); await tick();
  let closed = false; const closing = owner.close().then(() => { closed = true; }); await tick(); expect(closed).toBe(false);
  threads[1].emit("exit", 1); await cancelled; await closing; await expect(owner.read(2, jest.fn())).rejects.toThrow("closed");
});
it("rejects stale publication after non-decoder work and poisons uncertain cleanup", async () => {
  const { owner } = harness(); let release!: () => void;
  const result = owner.read(3, async () => { await new Promise<void>(r => { release = r; }); return {} as never; }); const rejected = expect(result).rejects.toThrow("cancelled");
  await tick(); owner.cancel(3); release(); await rejected; await owner.close();
  jest.useFakeTimers(); try {
    const h = harness(); const pending = h.owner.read(1, decode => decode(Buffer.alloc(0))); const failed = expect(pending).rejects.toThrow("exit not confirmed");
    await Promise.resolve(); await Promise.resolve(); h.owner.cancel(1); jest.advanceTimersByTime(2000); await failed;
    await expect(h.owner.read(1, jest.fn())).rejects.toThrow("exit not confirmed"); await expect(h.owner.close()).rejects.toThrow("exit not confirmed");
  } finally { jest.useRealTimers(); }
});
