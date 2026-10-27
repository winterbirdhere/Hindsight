import { LibraryExactMapUnavailableError, LibraryReplayOpener } from "./library-replay-opener";
import type { LibraryOpenLocation, LibraryOpenMap } from "./library-store";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION } from "../../../../shared/library-analysis";
import type { LibraryNumericalResourceDescriptor } from "../../../../shared/library-analysis";
import type { LibraryCurrentReplayReceipt } from "../../../../shared/library-current-replay";

const ticket: LibraryOpenLocation = { replayId: "provisional", sourceId: "lazer", sourceKey: "guid", locator: "native:guid",
  sha256: null, locationRevision: 1, sourceConfigRevision: 1, kind: "lazer", directory: "D:\\native", metadata: {} };
const map: LibraryOpenMap = { sourceId: "stable", sourceKey: "map", sourceConfigRevision: 2, generation: "generation",
  kind: "stable", directory: "D:\\stable", locator: "D:\\stable\\Songs\\one.osu", md5: "b".repeat(32), metadata: {} };
function fixture() {
  const metadata = jest.fn(async (method: string, _args?: Record<string, unknown>): Promise<unknown> => {
    if (method === "prepare-open") return { items: [ticket] };
    if (method === "prepare-map") return { items: [map] };
    if (method === "commit-open") return { state: "applied", replayId: "canonical" };
    throw new Error("Unexpected metadata operation");
  });
  const resource = jest.fn(async (method: string, _args?: Record<string, unknown>): Promise<unknown> => {
    if (method === "begin") return { beatmapMd5: map.md5, receipt: { sha256: "a".repeat(64), available: true, metadata: {} }, nativeMap: true };
    if (method === "prepare-map") return { md5: map.md5, sha256: "c".repeat(64), bytes: 30, storyboards: ["story.osb"], assetManifestComplete: true };
    if (method === "transfer") return { id: "transfer", bytes: 3 };
    if (method === "chunk") return { bytes: new Uint8Array([1, 2, 3]), done: true };
    if (method === "release") return null;
    throw new Error("Unexpected resource operation");
  });
  const close = jest.fn(async () => undefined);
  const opener = new LibraryReplayOpener({ metadata, resources: { request: resource, close } });
  return { metadata, resource, close, opener };
}
it("commits verified native identity before exposing a path-free resource handle", async () => {
  const f = fixture();
  const handle = await f.opener.open("request", "provisional", () => undefined);
  expect(handle).toEqual({ requestId: "request", replayId: "canonical", sourceKind: "lazer", replaySha256: "a".repeat(64),
    beatmapMd5: map.md5, mapSha256: "c".repeat(64), storyboards: ["story.osb"], assetManifestComplete: true });
  expect(f.metadata.mock.calls.map(call => call[0])).toEqual(["prepare-open", "commit-open"]);
  expect(await f.opener.transfer("request", "map")).toEqual({ id: "transfer", bytes: 3 });
  expect(await f.opener.chunk("request", "transfer", 0)).toMatchObject({ done: true });
  await f.opener.close(); expect(f.close).toHaveBeenCalledTimes(1);
});
it("tries indexed Stable maps only after native map resolution fails and commits both epochs", async () => {
  const f = fixture();
  f.resource.mockImplementation(async (method, args) => {
    if (method === "begin") return { beatmapMd5: map.md5, receipt: { sha256: "a".repeat(64), available: true, metadata: {} }, nativeMap: true };
    if (method === "prepare-map" && !args?.candidate) throw new Error("Native map unavailable");
    if (method === "prepare-map") return { md5: map.md5, sha256: "c".repeat(64), ticket: map, storyboards: [], assetManifestComplete: true };
    return null;
  });
  await f.opener.open("request", "provisional", () => undefined);
  expect(f.metadata.mock.calls.at(-1)).toEqual(["commit-open", expect.objectContaining({ ticket, map })]);
  await f.opener.close();
});
it.each([1, 2])("reports exact-map absence only after all %i verified replay locations have empty map candidates", async locations => {
  const f = fixture(), original = f.resource.getMockImplementation()!;
  f.resource.mockImplementation((method, args) => method === "begin" ? Promise.resolve({ beatmapMd5: map.md5,
    receipt: { sha256: "a".repeat(64), available: true, metadata: {} }, nativeMap: false }) : original(method, args));
  f.metadata.mockImplementation(async method => method === "prepare-open" ? {
    items: Array.from({ length: locations }, (_, index) => ({ ...ticket, sourceKey: String(index) })) } : { items: [] });
  await expect(f.opener.open("request", "provisional", () => undefined)).rejects.toMatchObject({
    name: "LibraryExactMapUnavailableError", replayId: "provisional", beatmapMd5: map.md5 });
  expect(f.resource.mock.calls.filter(([method]) => method === "release")).toHaveLength(locations);
  expect(f.metadata.mock.calls.some(([method]) => method === "commit-open")).toBe(false);
  await f.opener.close();
});
it("does not hide an earlier generic location failure behind later exact-map absence", async () => {
  const f = fixture(), original = f.resource.getMockImplementation()!, failure = new Error("Exact beatmap is unavailable in enabled sources");
  let begins = 0;
  f.resource.mockImplementation((method, args) => {
    if (method === "begin") return ++begins === 1 ? Promise.reject(failure) : Promise.resolve({ beatmapMd5: map.md5,
      receipt: { sha256: "a".repeat(64), available: true, metadata: {} }, nativeMap: false });
    return original(method, args);
  });
  f.metadata.mockImplementation(async method => method === "prepare-open" ? { items: [ticket, { ...ticket, sourceKey: "second" }] } : { items: [] });
  await expect(f.opener.open("request", "provisional", () => undefined)).rejects.toBe(failure);
  expect(begins).toBe(2); await f.opener.close();
});
it("does not turn a null rejection from an earlier location into typed absence", async () => {
  const f = fixture(), original = f.resource.getMockImplementation()!; let begins = 0;
  f.metadata.mockImplementation(async method => method === "prepare-open" ? { items: [ticket, { ...ticket, sourceKey: "second" }] } : { items: [] });
  f.resource.mockImplementation((method, args) => method === "begin" ? ++begins === 1 ? Promise.reject(null) : Promise.resolve({
    beatmapMd5: map.md5, receipt: { sha256: "a".repeat(64), available: true, metadata: {} }, nativeMap: false }) : original(method, args));
  await expect(f.opener.open("request", "provisional", () => undefined)).rejects.toBeNull(); await f.opener.close();
});
it("does not classify absence after a malformed replay-location continuation", async () => {
  const f = fixture(), original = f.resource.getMockImplementation()!;
  f.metadata.mockImplementation(async method => method === "prepare-open" ? { items: [ticket], next: false } : { items: [] });
  f.resource.mockImplementation((method, args) => method === "begin" ? Promise.resolve({
    beatmapMd5: map.md5, receipt: { sha256: "a".repeat(64), available: true, metadata: {} }, nativeMap: false }) : original(method, args));
  await expect(f.opener.open("request", "provisional", () => undefined)).rejects.toThrow("Invalid selected replay location page"); await f.opener.close();
});
it("accepts a later successful location after an exact-map-unavailable attempt", async () => {
  const f = fixture(), original = f.resource.getMockImplementation()!; let begins = 0;
  f.metadata.mockImplementation(async method => method === "prepare-open" ? { items: [ticket, { ...ticket, sourceKey: "second" }] }
    : method === "prepare-map" ? { items: [] } : { state: "applied", replayId: "canonical" });
  f.resource.mockImplementation((method, args) => method === "begin" ? Promise.resolve({ beatmapMd5: map.md5,
    receipt: { sha256: "a".repeat(64), available: true, metadata: {} }, nativeMap: ++begins > 1 }) : original(method, args));
  expect((await f.opener.open("request", "provisional", () => undefined)).replayId).toBe("canonical");
  expect(begins).toBe(2); await f.opener.close();
});
it.each(["native", "candidate", "metadata", "cleanup", "invalid-receipt", "invalid-page"])("keeps %s errors generic even with absent fallback maps", async stage => {
  const f = fixture(), failure = new Error("Exact beatmap is unavailable in enabled sources"), original = f.resource.getMockImplementation()!;
  f.metadata.mockImplementation(async method => {
    if (method === "prepare-open") return { items: [ticket] };
    if (stage === "metadata") throw failure;
    if (stage === "invalid-page") return { items: [], next: false };
    return { items: stage === "candidate" ? [map] : [] };
  });
  f.resource.mockImplementation((method, args) => {
    if (method === "begin") return Promise.resolve({ beatmapMd5: map.md5,
      receipt: { sha256: "a".repeat(64), available: true, metadata: {} }, nativeMap: stage === "invalid-receipt" ? undefined : stage === "native" });
    if (method === "prepare-map" || method === "release" && stage === "cleanup") return Promise.reject(failure);
    return original(method, args);
  });
  const error = await f.opener.open("request", "provisional", () => undefined).catch(error => error);
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(LibraryExactMapUnavailableError);
  if (!["invalid-receipt", "invalid-page"].includes(stage)) expect(error).toBe(failure);
  await f.opener.close();
});
it("requires all unavailable locations to agree on the verified map identity", async () => {
  const f = fixture(), original = f.resource.getMockImplementation()!; let begins = 0;
  f.metadata.mockImplementation(async method => method === "prepare-open" ? { items: [ticket, { ...ticket, sourceKey: "second" }] } : { items: [] });
  f.resource.mockImplementation((method, args) => method === "begin" ? Promise.resolve({ beatmapMd5: (++begins === 1 ? "b" : "c").repeat(32),
    receipt: { sha256: "a".repeat(64), available: true, metadata: {} }, nativeMap: false }) : original(method, args));
  await expect(f.opener.open("request", "provisional", () => undefined)).rejects.toThrow("disagree"); await f.opener.close();
});
it.each(["stale", "source-disabled", "content-changed"])("never exposes resources after %s publication", async state => {
  const f = fixture();
  f.metadata.mockImplementation(async method => method === "prepare-open" ? { items: [ticket] } : { state, replayId: "other" });
  await expect(f.opener.open("request", "provisional", () => undefined)).rejects.toThrow(/stale|disabled|changed/i);
  await expect(f.opener.transfer("request", "map")).rejects.toThrow(/expired/i);
  expect(f.resource.mock.calls.some(call => call[0] === "release")).toBe(true); await f.opener.close();
});
it("cancels pending preparation and rejects an old document before publication", async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.resource.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.opener.open("request", "provisional", () => undefined);
  while (!finish) await Promise.resolve();
  await f.opener.release("request");
  finish({ beatmapMd5: map.md5, receipt: { sha256: "a".repeat(64), available: true, metadata: {} }, nativeMap: true });
  await expect(pending).rejects.toThrow(/abort|cancel/i);
  expect(f.metadata.mock.calls.some(call => call[0] === "commit-open")).toBe(false);
  await f.opener.close();
});
it("keeps the current session while replacing it and releases every session on document departure", async () => {
  const f = fixture(); await f.opener.open("current", "one", () => undefined); await f.opener.open("next", "two", () => undefined);
  await expect(f.opener.open("third", "three", () => undefined)).rejects.toThrow(/limit/i);
  await f.opener.releaseDocument();
  await expect(f.opener.transfer("current", "map")).rejects.toThrow(/expired/i);
  await expect(f.opener.transfer("next", "map")).rejects.toThrow(/expired/i);
  await f.opener.close();
});

it("closes the resource owner without racing queued release requests against shutdown", async () => {
  const f = fixture(); const original = f.resource.getMockImplementation()!; let closed = false;
  f.resource.mockImplementation(async (method, args) => { await Promise.resolve(); if (closed) throw new Error("Resource process closed"); return original(method, args); });
  f.close.mockImplementation(async () => { closed = true; });
  await f.opener.open("current", "one", () => undefined);
  await expect(f.opener.close()).resolves.toBeUndefined();
});

it("allows an analysis owner to atomically publish its verified receipt before exposing resources",async()=>{
  const f=fixture(),publish=jest.fn(async()=>({state:"applied" as const,replayId:"analysis-canonical"}));
  const opener=new LibraryReplayOpener({metadata:f.metadata,resources:{request:f.resource,close:f.close},publish});
  expect((await opener.open("analysis","provisional",()=>undefined)).replayId).toBe("analysis-canonical");
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ticket,observation:expect.objectContaining({available:true}),sessionId:expect.any(String),mapSha256:"c".repeat(64)}));
  expect(f.metadata.mock.calls.some(([method])=>method==="commit-open")).toBe(false);await opener.close();
});

function descriptor(): LibraryNumericalResourceDescriptor {
  return { input: { format: "resources", replayBytes: 100, mapBytes: 30, binding: { replaySha256: "a".repeat(64),
    mapSha256: "c".repeat(64), mapMd5: map.md5, exactMapAndProfile: true } }, origin: null,
    target: { slot: "numerical", stage: "S", inputKey: "d".repeat(64), producerVersion: LIBRARY_NUMERIC_PROJECTION_VERSION },
    recipe: { version: 1, replaySha256: "a".repeat(64), fixedKey: "e".repeat(64), intrinsicNative: false,
      embeddedModsHash: null, legacyModsHash: "f".repeat(64), modeQualified: true, consumedModsSource: "legacy-mask" } };
}
function receipt(): LibraryCurrentReplayReceipt {
  return { version: 1, token: "receipt", replayId: "canonical", replaySha256: "a".repeat(64), mapSha256: "c".repeat(64),
    mapMd5: map.md5, numericalInputKey: "d".repeat(64), parserVersion: LIBRARY_REPLAY_PARSER_VERSION,
    preparationVersion: LIBRARY_RESOURCE_PREPARATION_VERSION, numericalVersion: LIBRARY_NUMERIC_PROJECTION_VERSION };
}
function reuseFixture() {
  const f = fixture(), original = f.resource.getMockImplementation()!;
  f.resource.mockImplementation((method, args) => method === "describe-analysis" ? Promise.resolve(descriptor()) : original(method, args));
  const bind = jest.fn(async (_input: unknown, assertCurrent: () => void) => {
    assertCurrent(); return { state: "applied" as const, replayId: "canonical", currentReplay: receipt() };
  }), release = jest.fn(async (_receipt: LibraryCurrentReplayReceipt) => undefined);
  const opener = new LibraryReplayOpener({ metadata: f.metadata, resources: { request: f.resource, close: f.close }, currentReplay: { bind, release } });
  return { ...f, opener, bind, release };
}
it("binds a verified current-replay descriptor before exposure and transfers receipt ownership beyond resource close", async () => {
  const f = reuseFixture(), handle = await f.opener.open("current", "provisional", () => undefined);
  expect(handle.currentReplay).toEqual(receipt());
  expect(f.bind).toHaveBeenCalledWith({ location: ticket, observation: { sha256: "a".repeat(64), available: true, metadata: {} }, descriptor: descriptor() }, expect.any(Function));
  expect(f.metadata.mock.calls.some(([method]) => method === "commit-open")).toBe(false);
  await f.opener.release("current"); await f.opener.close(); expect(f.release).not.toHaveBeenCalled();
});
it.each(["unsupported", "unqualified", "mismatched-hash"])("preserves ordinary viewer loading when descriptor is %s", async reason => {
  const f = reuseFixture(), original = f.resource.getMockImplementation()!;
  f.resource.mockImplementation((method, args) => {
    if (method !== "describe-analysis") return original(method, args);
    if (reason === "unsupported") return Promise.reject(new Error("Unsupported profile"));
    const value = descriptor();
    if (reason === "unqualified") value.input.binding.exactMapAndProfile = false;
    else value.input.binding.mapSha256 = "9".repeat(64);
    return Promise.resolve(value);
  });
  expect((await f.opener.open("current", "provisional", () => undefined)).currentReplay).toBeUndefined();
  expect(f.bind).not.toHaveBeenCalled(); expect(f.metadata.mock.calls.at(-1)?.[0]).toBe("commit-open"); await f.opener.close();
});
it("does not bypass a stale qualified binding with an ordinary commit", async () => {
  const f = reuseFixture(); f.bind.mockResolvedValue({ state: "stale" } as never);
  await expect(f.opener.open("current", "provisional", () => undefined)).rejects.toThrow(/stale/i);
  expect(f.metadata.mock.calls.some(([method]) => method === "commit-open")).toBe(false); await f.opener.close();
});
it("rechecks the document after descriptor retrieval before invoking any publication", async () => {
  const f = reuseFixture(), original = f.resource.getMockImplementation()!; let current = true;
  f.resource.mockImplementation((method, args) => {
    if (method === "describe-analysis") { current = false; return Promise.resolve(descriptor()); }
    return original(method, args);
  });
  await expect(f.opener.open("current", "provisional", () => { if (!current) throw new Error("Old document"); })).rejects.toThrow(/document/i);
  expect(f.bind).not.toHaveBeenCalled(); expect(f.metadata.mock.calls.some(([method]) => method === "commit-open")).toBe(false); await f.opener.close();
});
it("revokes a newly issued receipt when cancellation wins before its handle is returned", async () => {
  const f = reuseFixture(); let finish!: (value: Awaited<ReturnType<typeof f.bind>>) => void;
  f.bind.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.opener.open("current", "provisional", () => undefined);
  while (!finish) await Promise.resolve();
  await f.opener.release("current"); finish({ state: "applied", replayId: "canonical", currentReplay: receipt() });
  await expect(pending).rejects.toThrow(/abort/i); expect(f.release).toHaveBeenCalledWith(receipt()); await f.opener.close();
});
it("leaves the independent background publication callback authoritative", async () => {
  const f = reuseFixture(), publish = jest.fn(async () => ({ state: "applied" as const, replayId: "background" }));
  const opener = new LibraryReplayOpener({ metadata: f.metadata, resources: { request: f.resource, close: f.close }, publish,
    currentReplay: { bind: f.bind, release: f.release } });
  expect((await opener.open("background", "provisional", () => undefined)).replayId).toBe("background");
  expect(f.bind).not.toHaveBeenCalled(); expect(f.resource.mock.calls.some(([method]) => method === "describe-analysis")).toBe(false); await opener.close();
});
it("revokes a returned receipt that does not match the current producer versions", async () => {
  const f = reuseFixture(), obsolete = { ...receipt(), numericalVersion: "old" };
  f.bind.mockResolvedValue({ state: "applied", replayId: "canonical", currentReplay: obsolete });
  await expect(f.opener.open("current", "provisional", () => undefined)).rejects.toThrow(/receipt/i);
  expect(f.release).toHaveBeenCalledWith(obsolete); await f.opener.close();
});
