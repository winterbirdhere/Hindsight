import { TextDecoder, TextEncoder } from "util";
import { LibraryReplayWorkerServer, parseLibraryReplay, configureLibraryReplayWorker } from "./library-replay-worker";

Object.assign(globalThis, { TextDecoder, TextEncoder });
const wire = { gameMode: 0, gameVersion: 20260101, beatmapMD5: "a".repeat(32), replayContentSha256: "b".repeat(64),
  playerName: "Fixture", replayMD5: "hash", number_300s: 1, number_100s: 0, number_50s: 0, misses: 0, max_combo: 1,
  score: 300, perfect_combo: 1, mods: 0, replay_data: "0|256|-500|0,-1|256|-500|0,10|1|2|1,", life_bar: "", timestamp: 1700000000000 };
function workerFixture() {
  const worker = { onmessage: null as null | ((event: { data: unknown }) => void), onerror: null, onmessageerror: null,
    terminate: jest.fn(), postMessage: jest.fn((data: unknown) => { void server.receive(data); }) };
  const server = new LibraryReplayWorkerServer(data => worker.onmessage?.({ data }));
  configureLibraryReplayWorker(() => worker as unknown as Worker); return worker;
}
afterEach(() => configureLibraryReplayWorker(undefined));

it("relays exact bounded chunks through a dedicated parser and drains bounded output before terminating", async () => {
  const worker = workerFixture(), bytes = new Uint8Array(Buffer.from(JSON.stringify(wire)));
  const read = jest.fn(async (offset: number) => ({ bytes: bytes.slice(offset, offset + 64), done: offset + 64 >= bytes.length }));
  const replay = await parseLibraryReplay(bytes.length, read, new AbortController().signal);
  expect(replay.frames).toEqual([{ time: 9, position: { x: 1, y: 2 }, actions: [0], rawButtonMask: 1 }]);
  expect(replay.timestamp).toBe(wire.timestamp); expect(read.mock.calls.map(call => call[0])).toEqual(Array.from({ length: Math.ceil(bytes.length / 64) }, (_, i) => i * 64));
  expect(worker.postMessage.mock.calls.filter(call => (call[0] as { method: string }).method === "append").length).toBe(read.mock.calls.length);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it("cancels a stalled resource read and never falls back to renderer parsing", async () => {
  const worker = workerFixture(), controller = new AbortController();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = parseLibraryReplay(100, async () => { entered(); return new Promise(() => undefined); }, controller.signal);
  await started; controller.abort(); await expect(pending).rejects.toThrow(/abort|cancel/i);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  configureLibraryReplayWorker(undefined);
  await expect(parseLibraryReplay(100, async () => { throw new Error("should not read"); }, new AbortController().signal)).rejects.toThrow(/worker.*unavailable/i);
});
it("rejects a truncated resource stream before parsing", async () => {
  const worker = workerFixture();
  await expect(parseLibraryReplay(100, async () => ({ bytes: new Uint8Array(3), done: true }), new AbortController().signal)).rejects.toThrow(/stream/i);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it("rejects stale response identity and times out a worker that never acknowledges", async () => {
  jest.useFakeTimers();
  try {
    const worker = workerFixture();
    worker.postMessage.mockImplementation(() => { worker.onmessage?.({ data: { version: 1, id: -1, ok: true, data: null } }); });
    const pending = parseLibraryReplay(10, async () => ({ bytes: new Uint8Array(10), done: true }), new AbortController().signal);
    jest.advanceTimersByTime(60000); await expect(pending).rejects.toThrow(/timed out/i);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});
