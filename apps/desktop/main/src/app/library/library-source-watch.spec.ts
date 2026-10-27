import { EventEmitter } from "events";
import { join } from "path";
import { watchLibrarySource, WatchFilter } from "./library-source-watch";

function fixture(kind: "stable" | "replays" | "lazer" | "imported") {
  const calls: { path: string; recursive: boolean; filter?: WatchFilter; notify: (event: string, path: string | null) => void; watcher: EventEmitter & { close: jest.Mock } }[] = [];
  const changed = jest.fn(), failed = jest.fn(), evidence = jest.fn();
  const close = watchLibrarySource({ id: "s", kind, directory: "D:\\source" }, changed, failed, (path, recursive, notify, filter) => {
    const watcher = Object.assign(new EventEmitter(), { close: jest.fn() }); calls.push({ path, recursive, filter, notify, watcher }); return watcher;
  }, evidence);
  return { calls, changed, failed, evidence, close };
}
it("uses a fixed number of native subscriptions and filters Stable database/cache changes", () => {
  const f = fixture("stable"); expect(f.calls.map(call => [call.path, call.recursive])).toEqual([["D:\\source", false], [join("D:\\source", "Data", "r"), true]]);
  f.calls[0].notify("change", "scores.db"); f.calls[0].notify("rename", "osu!.db"); f.calls[0].notify("change", "unrelated.log");
  f.calls[1].notify("rename", "nested\\one.osr"); f.calls[1].notify("rename", "nested"); f.calls[1].notify("change", "other.txt");
  expect(f.changed).toHaveBeenCalledTimes(4); f.close(); expect(f.calls.every(call => call.watcher.close.mock.calls.length === 1)).toBe(true);
  f.calls[0].notify("rename", null); expect(f.changed).toHaveBeenCalledTimes(4);
});
it.each([
  ["stable", ["stable-root", "replay"]], ["lazer", ["lazer-root", "all"]], ["replays", ["replay"]], ["imported", ["replay"]]
] as const)("provides native pre-coalescing filters for %s", (kind, filters) => {
  const f = fixture(kind); expect(f.calls.map(call => call.filter)).toEqual(filters); f.close();
});
it("watches native database replacement and hash blobs but ignores Realm lock churn", () => {
  const f = fixture("lazer"); expect(f.calls).toHaveLength(2); expect(f.calls[1].recursive).toBe(true);
  f.calls[0].notify("change", "client.realm.lock"); f.calls[0].notify("rename", "client.realm"); f.calls[1].notify("change", "ab\\abcdef");
  expect(f.changed).toHaveBeenCalledTimes(2); f.close();
});
it("treats ambiguous names as dirty and reports failure without recreating watchers", () => {
  const f = fixture("replays"); expect(f.calls).toHaveLength(1); expect(f.calls[0].recursive).toBe(true);
  f.calls[0].notify("rename", null); f.calls[0].watcher.emit("error", new Error("Overflow"));
  expect(f.changed).toHaveBeenCalledTimes(1); expect(f.failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Overflow" }));
  expect(f.calls).toHaveLength(1); f.close();
});
it("owned-import events only invalidate the registered-location scanner and never enumerate files", () => {
  const f = fixture("imported"); expect(f.calls).toHaveLength(1); expect(f.calls[0].recursive).toBe(false);
  f.calls[0].notify("change", "anything.osr"); f.calls[0].notify("change", "temporary.part");
  expect(f.changed).toHaveBeenCalledTimes(1); f.close();
});

it("invalidates when a populated dotted directory is moved into or out of Replays", () => {
  const f = fixture("replays");
  // Windows may report only the directory rename, not notifications for its contained .osr files.
  f.calls[0].notify("rename", "pack.v2");
  expect(f.changed).toHaveBeenCalledTimes(1);
  f.calls[0].notify("rename", "pack.v2");
  expect(f.changed).toHaveBeenCalledTimes(2); f.close();
});

it.each(["stable", "replays", "imported"] as const)("ignores retired .osg evidence notifications for %s", kind => {
  const f = fixture(kind), index = kind === "stable" ? 1 : 0;
  f.calls[index].notify("change", "nested\\one.OSG"); f.calls[index].notify("rename", "two.osg");
  expect(f.changed).not.toHaveBeenCalled();
  expect(f.evidence).not.toHaveBeenCalled();
  f.close(); f.calls[index].notify("change", "two.osg"); expect(f.evidence).not.toHaveBeenCalled();
});
it("marks ambiguous, directory and failed notifications coarse without trusting event paths", () => {
  const f = fixture("replays");
  f.calls[0].notify("rename", "nested"); f.calls[0].notify("rename", null);
  f.calls[0].notify("change", "..\\outside.osg"); f.calls[0].notify("change", "D:\\outside.osg");
  f.calls[0].watcher.emit("error", new Error("Overflow"));
  expect(f.evidence).not.toHaveBeenCalled();
  expect(f.changed).toHaveBeenCalledTimes(2); expect(f.failed).toHaveBeenCalledTimes(1); f.close();
});
