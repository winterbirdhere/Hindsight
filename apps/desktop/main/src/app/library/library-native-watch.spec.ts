import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { LibraryNativeWatch, LibraryWatchChild } from "./library-native-watch";
import type { SourceWatcher } from "./library-source-watch";

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn(() => true)
  });
  const commands: Record<string, unknown>[] = [];
  child.stdin.on("data", chunk => commands.push(JSON.parse(String(chunk))));
  const start = jest.fn(() => child as LibraryWatchChild);
  const owner = new LibraryNativeWatch(() => "D:\\owned\\RewindPerformance.exe", start);
  const event = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
  return { child, commands, start, owner, event };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

it("rejects the existing U+0000–001F path range before spawn and preserves spaces", async () => {
  const f = fixture();
  for (let code = 0; code < 32; code++)
    expect(() => f.owner.factory("D:\\source" + String.fromCharCode(code), true, jest.fn(), "all")).toThrow(/Invalid library watch subscription/);
  expect(f.start).not.toHaveBeenCalled();
  f.owner.factory("D:\\source folder", true, jest.fn(), "all");
  expect(f.start).toHaveBeenCalledTimes(1);
  const closing = f.owner.close(); f.child.emit("close", 0); await closing;
});
it("starts one lazy helper and carries exact native relevance before coalescing", async () => {
  const f = fixture(); expect(f.start).not.toHaveBeenCalled();
  const changed = jest.fn(), watcher = f.owner.factory("D:\\source", false, changed, "lazer-root");
  const failed = jest.fn(); watcher.on("error", failed);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.commands[0]).toMatchObject({ version: 1, kind: "configure", sequence: 1,
    subscriptions: [{ slot: 0, generation: 1, path: "D:\\source", recursive: false, filter: "lazer-root" }] });
  f.event({ version: 1, kind: "configured", sequence: 1 });
  f.event({ version: 1, kind: "dirty", slot: 0, generation: 1, revision: 1 });
  expect(changed).toHaveBeenCalledWith("change", null);
  expect(f.commands.at(-1)).toMatchObject({ kind: "ack", slot: 0, generation: 1, revision: 1 });
  watcher.close(); const closing = f.owner.close(); f.child.emit("close", 0); await closing;
  expect(failed).not.toHaveBeenCalled();
});
it("bounds slots and coalesces configuration while awaiting native acknowledgement", async () => {
  const f = fixture(), watchers: SourceWatcher[] = [];
  for (let i = 0; i < 8; i++) watchers.push(f.owner.factory("D:\\source" + i, true, jest.fn(), "all"));
  expect(() => f.owner.factory("D:\\overflow", true, jest.fn(), "all")).toThrow(/capacity/i);
  expect(f.commands).toHaveLength(1);
  f.event({ version: 1, kind: "configured", sequence: 1 });
  expect(f.commands).toHaveLength(2);
  expect((f.commands[1].subscriptions as unknown[])).toHaveLength(8);
  watchers.forEach(w => w.close()); const closing = f.owner.close(); f.child.emit("close", 0); await closing;
});
it("ignores old generations after detach and slot reuse without dirtying replacement", async () => {
  const f = fixture(), old = jest.fn(), next = jest.fn();
  f.owner.factory("D:\\old", true, old, "replay").close();
  f.owner.factory("D:\\new", true, next, "replay");
  f.event({ version: 1, kind: "configured", sequence: 1 });
  f.event({ version: 1, kind: "dirty", slot: 0, generation: 1, revision: 1 });
  expect(old).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
  f.event({ version: 1, kind: "dirty", slot: 0, generation: 2, revision: 1 });
  expect(next).toHaveBeenCalledTimes(1);
  const closing = f.owner.close(); f.child.emit("close", 0); await closing;
});
it("keeps pipe backpressure bounded and flushes pending acknowledgements on drain", async () => {
  const f = fixture(), changed = jest.fn();
  const write = jest.spyOn(f.child.stdin, "write").mockReturnValue(false);
  f.owner.factory("D:\\a", true, changed, "all");
  for (let i = 1; i < 8; i++) f.owner.factory("D:\\a" + i, true, jest.fn(), "all");
  expect(write).toHaveBeenCalledTimes(1);
  write.mockRestore(); f.child.stdin.emit("drain");
  f.event({ version: 1, kind: "configured", sequence: 1 });
  expect(f.commands).toHaveLength(1);
  const closing = f.owner.close(); f.child.emit("close", 0); await closing;
});
it.each(["oversized", "malformed", "revision-gap"] as const)("fails %s output without restarting", async kind => {
  const f = fixture(), failed = jest.fn();
  f.owner.factory("D:\\a", true, jest.fn(), "all").on("error", failed);
  if (kind === "oversized") f.child.stdout.write("x".repeat(4097));
  else if (kind === "malformed") f.child.stdout.write("{}\n");
  else f.event({ version: 1, kind: "dirty", slot: 0, generation: 1, revision: 2 });
  await flush(); expect(failed).toHaveBeenCalledTimes(1); expect(f.child.kill).toHaveBeenCalledTimes(1);
  expect(() => f.owner.factory("D:\\b", true, jest.fn(), "all")).toThrow();
  const closing = f.owner.close(); f.child.emit("close", 1); await expect(closing).rejects.toThrow();
  expect(f.start).toHaveBeenCalledTimes(1);
});
it("reports native overflow once without dirty/retry and preserves later unaffected source events", async () => {
  const f = fixture(), changed = jest.fn(), failed = jest.fn(), other = jest.fn();
  f.owner.factory("D:\\a", true, changed, "all").on("error", failed);
  f.owner.factory("D:\\b", true, other, "all").on("error", jest.fn());
  f.event({ version: 1, kind: "error", slot: 0, generation: 1, error: "watch-overflow" });
  await flush(); expect(failed).toHaveBeenCalledTimes(1); expect(changed).not.toHaveBeenCalled();
  f.event({ version: 1, kind: "dirty", slot: 1, generation: 1, revision: 1 });
  expect(other).toHaveBeenCalledTimes(1);
  const closing = f.owner.close(); f.child.emit("close", 0); await closing;
});
it("does not equate termination request with actual native drain", async () => {
  jest.useFakeTimers();
  try {
    const f = fixture(); f.owner.factory("D:\\a", true, jest.fn(), "all");
    let settled = false; const closing = f.owner.close().then(() => { settled = true; }, () => { settled = true; });
    jest.advanceTimersByTime(2000); await flush();
    expect(f.child.kill).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
    f.child.emit("close", 0); await closing; expect(settled).toBe(true);
  } finally { jest.useRealTimers(); }
});
it("rejects a missing close after kill and never allows replacement", async () => {
  jest.useFakeTimers();
  try {
    const f = fixture(); f.owner.factory("D:\\a", true, jest.fn(), "all");
    const closing = f.owner.close(); const result = expect(closing).rejects.toThrow(/exit not confirmed/i);
    jest.advanceTimersByTime(4000); await result;
    expect(() => f.owner.factory("D:\\b", true, jest.fn(), "all")).toThrow();
    f.child.emit("close", 0);
  } finally { jest.useRealTimers(); }
});
