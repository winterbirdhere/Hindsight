import { setImmediate } from "timers/promises";
import { LibraryStore } from "./library-store";
import { LibraryRebuildCoordinator } from "./library-rebuild-coordinator";

let store: LibraryStore;
const row = { sourceKey: "one", locator: "D:\\one.osr", available: true, sha256: "a".repeat(64), metadata: {} };
beforeEach(() => { store = new LibraryStore(":memory:", "session"); store.registerSource({ id: "files", kind: "replays", directory: "D:\\Replays" }); });
afterEach(() => store.close());

it("holds admission before draining, parks for viewer, resumes the same iterator and publishes at EOF", async () => {
  let entered = 0, drained = false, observed = false;
  const rebuild = new LibraryRebuildCoordinator(store, { files: async function* () { entered++; yield row; observed = true; } }, {},
    async () => { drained = true; });
  await rebuild.setViewerDemand(true); rebuild.start(["files"]);
  expect(rebuild.busy).toBe(true); await setImmediate(); expect(drained).toBe(true); expect(entered).toBe(0);
  expect(rebuild.status().state).toBe("waiting-for-viewer");
  await rebuild.setViewerDemand(false); await rebuild.idle();
  expect(entered).toBe(1); expect(observed).toBe(true); expect(store.replayCount()).toBe(1);
  expect(rebuild.status()).toMatchObject({ state: "complete", observations: 1 }); expect(rebuild.busy).toBe(false);
  await rebuild.close();
});

it("Stop discards staging and shutdown drains cancellation without reopening admission", async () => {
  const rebuild = new LibraryRebuildCoordinator(store, { files: async function* (options) {
    yield row; void rebuild.setViewerDemand(true); await options.checkpoint?.(); yield { ...row, sourceKey: "two" };
  } }, {}, async () => undefined);
  rebuild.start(["files"]); while (rebuild.status().state !== "waiting-for-viewer") await setImmediate();
  expect(store.replayCount()).toBe(0); rebuild.stop(); await rebuild.idle();
  expect(rebuild.status().state).toBe("stopped"); expect(store.replayCount()).toBe(0);
  await rebuild.close(); expect(() => rebuild.start(["files"])).toThrow(/closed/i);
  expect(() => store.beginScan("files")).not.toThrow();
});

it("a failed source leaves every live source unchanged and permits only explicit retry", async () => {
  let fail = true;
  const rebuild = new LibraryRebuildCoordinator(store, { files: async function* () { yield row; if (fail) throw new Error("Source changed"); } }, {}, async () => undefined);
  rebuild.start(["files"]); await rebuild.idle(); expect(rebuild.status()).toMatchObject({ state: "error", error: "Source changed" });
  expect(store.replayCount()).toBe(0); fail = false; rebuild.start(["files"]); await rebuild.idle();
  expect(store.replayCount()).toBe(1); await rebuild.close();
});
