import { TextDecoder } from "util";
import { LibraryExactMapUnavailableError, LibraryReplayResourceClient, LibraryResourceCleanupError } from "./library-replay-resources";
import type { LibraryResourceRequest } from "../../../../../shared/library-resources";
import type { OsuReplay } from "../../model/OsuReplay";

Object.assign(globalThis, { TextDecoder });
const replay = { frames: [], mods: [], player: "P", md5hash: "hash", beatmapMd5: "b".repeat(32), replayContentSha256: "a".repeat(64), gameVersion: 20260101 } as OsuReplay;
function fixture() {
  let active: string | undefined;
  const resource = jest.fn(async (request: LibraryResourceRequest): Promise<unknown> => {
    if (request.method === "open") return { requestId: request.requestId, replayId: "canonical", sourceKind: "lazer",
      replaySha256: "a".repeat(64), beatmapMd5: "b".repeat(32), mapSha256: "c".repeat(64), storyboards: [], assetManifestComplete: true };
    if (request.method === "release") return null;
    if (request.method === "transfer") { if (active) throw new Error("Overlapping transfer"); active = request.kind; return { id: request.kind, bytes: 3 }; }
    active = undefined; return { bytes: Uint8Array.from([97, 98, 99]), done: true };
  });
  const parser = jest.fn(async (_size: number, read: (offset: number, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal) => {
    await read(0, signal); return replay;
  });
  const client = new LibraryReplayResourceClient({ resource }, parser);
  return { resource, parser, client };
}
it("serializes complete transfers, reuses the one parsed replay and closes only its owned request", async () => {
  const f = fixture(), current = await f.client.open("one", new AbortController().signal);
  const [parsed, map, asset] = await Promise.all([current.replay(), current.map(), current.asset("audio.mp3")]);
  expect(parsed).toBe(replay); expect(map).toBe("abc"); expect(asset).toEqual(Uint8Array.from([97, 98, 99]));
  expect(await current.replay()).toBe(replay); expect(f.parser).toHaveBeenCalledTimes(1);
  expect(current.handle.replayId).toBe("canonical");
  await current.close(); await current.close();
  expect(f.resource.mock.calls.filter(call => call[0].method === "release")).toHaveLength(1);
  await expect(current.map()).rejects.toThrow(/closed|abort/i);
});
it("cancels a stalled open and releases its request even before a resource handle arrived", async () => {
  const f = fixture(), controller = new AbortController();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.resource.mockImplementationOnce(() => { entered(); return new Promise(() => undefined); });
  const pending = f.client.open("one", controller.signal); await started; controller.abort();
  await expect(pending).rejects.toThrow(/abort/i);
  expect(f.resource.mock.calls.some(call => call[0].method === "release")).toBe(true);
});
it("reconstructs only an exact bound unavailable reply after acknowledged request cleanup", async () => {
  const f = fixture();
  f.resource.mockImplementationOnce(async request => ({ state: "unavailable", reason: "exact-map-unavailable",
    requestId: request.requestId, replayId: "one", beatmapMd5: "b".repeat(32) }));
  await expect(f.client.open("one", new AbortController().signal)).rejects.toMatchObject({
    name: "LibraryExactMapUnavailableError", replayId: "one", beatmapMd5: "b".repeat(32) });
  expect(f.resource.mock.calls.filter(([request]) => request.method === "release")).toHaveLength(1);
});
it.each(["request", "replay", "hash", "extra", "reason"])("rejects a malformed unavailable %s reply without classifying absence", async field => {
  const f = fixture();
  f.resource.mockImplementationOnce(async request => Object.assign({ state: "unavailable", reason: "exact-map-unavailable",
    requestId: request.requestId, replayId: "one", beatmapMd5: "b".repeat(32) },
    field === "request" ? { requestId: "other" } : field === "replay" ? { replayId: "other" }
      : field === "hash" ? { beatmapMd5: "invalid" } : field === "extra" ? { locator: "private" } : { reason: "unknown" }));
  const error = await f.client.open("one", new AbortController().signal).catch(error => error);
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(LibraryExactMapUnavailableError);
  expect(f.resource.mock.calls.filter(([request]) => request.method === "release")).toHaveLength(1);
});
it("preserves generic transport errors and lets failed cleanup supersede typed absence", async () => {
  const f = fixture(), generic = new Error("Exact beatmap is unavailable in enabled sources");
  f.resource.mockRejectedValueOnce(generic);
  await expect(f.client.open("one", new AbortController().signal)).rejects.toBe(generic);
  f.resource.mockImplementationOnce(async request => ({ state: "unavailable", reason: "exact-map-unavailable",
    requestId: request.requestId, replayId: "one", beatmapMd5: "b".repeat(32) })).mockRejectedValueOnce(new Error("Release failed"));
  await expect(f.client.open("one", new AbortController().signal)).rejects.toBeInstanceOf(LibraryResourceCleanupError);
});
it.each([false, true])("rechecks cancellation after unavailable cleanup while preserving cleanup failure=%s precedence", async cleanupFails => {
  const f = fixture(), controller = new AbortController(), cancelled = new Error("Candidate superseded");
  let entered!: () => void, finish!: () => void, fail!: (error: Error) => void;
  const releasing = new Promise<void>(resolve => { entered = resolve; });
  f.resource.mockImplementation(async request => {
    if (request.method === "open") return { state: "unavailable", reason: "exact-map-unavailable",
      requestId: request.requestId, replayId: "one", beatmapMd5: "b".repeat(32) };
    if (request.method === "release") return new Promise<void>((resolve, reject) => {
      finish = resolve; fail = reject; entered();
    });
    throw new Error("Unexpected resource operation");
  });
  const pending = f.client.open("one", controller.signal).catch(error => error);
  await releasing; controller.abort(cancelled);
  if (cleanupFails) fail(new Error("Release failed")); else finish();
  const error = await pending;
  if (cleanupFails) expect(error).toBeInstanceOf(LibraryResourceCleanupError);
  else expect(error).toBe(cancelled);
  expect(error).not.toBeInstanceOf(LibraryExactMapUnavailableError);
  expect(f.resource.mock.calls.filter(([request]) => request.method === "release")).toHaveLength(1);
});
it("releases the resource session on parser failure and rejects queued work", async () => {
  const f = fixture(); f.parser.mockRejectedValue(new Error("Bad replay frames"));
  const current = await f.client.open("one", new AbortController().signal);
  const parsing = current.replay(), reading = current.map();
  await expect(parsing).rejects.toThrow(/Bad replay frames/); await expect(reading).rejects.toThrow(/closed|abort/i);
  expect(f.resource.mock.calls.some(call => call[0].method === "release")).toBe(true);
});
it("rejects oversized or truncated media instead of publishing partial bytes", async () => {
  const f = fixture(), current = await f.client.open("one", new AbortController().signal);
  f.resource.mockImplementationOnce(async () => ({ id: "map", bytes: 16 * 1024 * 1024 + 1 }));
  await expect(current.map()).rejects.toThrow(/limit/i);
  await current.close();
});

it("rejects a mismatched parsed replay and retains optional-asset fallback on a missing asset", async () => {
  const f = fixture(), current = await f.client.open("one", new AbortController().signal);
  f.resource.mockRejectedValueOnce(new Error("Native map asset unavailable"));
  await expect(current.asset("missing.wav")).rejects.toThrow(/unavailable/);
  expect(await current.map()).toBe("abc");
  f.parser.mockResolvedValue({ ...replay, replayContentSha256: "d".repeat(64) });
  await expect(current.replay()).rejects.toThrow(/identity/i);
  await current.close();
});

it("treats only an explicit unavailable asset receipt as optional; integrity errors still fail", async () => {
  const f = fixture(), current = await f.client.open("one", new AbortController().signal);
  f.resource.mockResolvedValueOnce({ id: "", bytes: 0, unavailable: true });
  expect(await current.optionalAsset("missing.wav")).toBeUndefined();
  f.resource.mockRejectedValueOnce(new Error("SHA mismatch"));
  await expect(current.optionalAsset("changed.wav")).rejects.toThrow("SHA mismatch");
  expect(await current.map()).toBe("abc"); await current.close();
});
