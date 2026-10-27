import { LibraryPassiveResourceApi } from "./library-passive-resource-api";
import { LibraryNativeDrainError } from "./library-native-admission";
import { LibraryPassiveResources } from "./library-passive-resources";
const check = () => undefined;
const failureOf = (work: Promise<unknown>): Promise<Error> => work.then(() => { throw Error("Expected rejection"); }, (error: unknown) => { if (!(error instanceof Error)) throw error; return error; });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
describe("passive resource document boundary", () => {
  const reader = () => ({ artwork: async () => Buffer.from([1, 2, 3]), strip: async () => undefined, revealPath: async () => "D:\\owned\\play.osr" });
  it("transfers bounded binary data without exposing a source path", async () => {
    const api = new LibraryPassiveResourceApi(reader(), () => undefined);
    expect(await api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check)).toEqual({ state: "ready", bytes: 3, mime: "image/png" });
    expect(await api.receive({ method: "chunk", requestId: "a", offset: 0 }, check)).toEqual({ bytes: Buffer.from([1, 2, 3]), done: true });
    await api.receive({ method: "release", requestId: "a" }, check); await api.close();
  });
  it("only invokes Reveal after explicit verified resolution", async () => {
    const paths: string[] = [], api = new LibraryPassiveResourceApi(reader(), path => { paths.push(path); });
    await api.receive({ method: "strip", requestId: "s", replayId: "r" }, check); expect(paths).toEqual([]);
    expect(await api.receive({ method: "reveal", requestId: "r", replayId: "r" }, check)).toEqual({ revealed: true });
    expect(paths).toEqual(["D:\\owned\\play.osr"]); await api.close();
  });
  it("rejects renderer paths, duplicated IDs and nonsequential chunks", async () => {
    const api = new LibraryPassiveResourceApi(reader(), () => undefined);
    await expect(api.receive({ method: "artwork", requestId: "a", replayId: "r", path: "C:\\secret" }, check)).rejects.toThrow();
    await api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check);
    await expect(api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check)).rejects.toThrow();
    await expect(api.receive({ method: "chunk", requestId: "a", offset: 1 }, check)).rejects.toThrow(); await api.close();
  });
  it("aborts and drains pending readers on document replacement before dropping ownership", async () => {
    const gate = deferred<Buffer>(), entered = deferred<AbortSignal>();
    const api = new LibraryPassiveResourceApi({ ...reader(), artwork: async (_id, signal) => { entered.resolve(signal); return gate.promise; } }, () => undefined);
    const request = api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check).catch(() => "cancelled");
    const signal = await entered.promise; let closed = false;
    const closing = api.releaseDocument().then(() => { closed = true; }); await Promise.resolve();
    expect(signal.aborted).toBe(true); expect(closed).toBe(false); gate.resolve(Buffer.from([1]));
    await closing; expect(await request).toBe("cancelled");
    await expect(api.receive({ method: "chunk", requestId: "a", offset: 0 }, check)).rejects.toThrow(); await api.close();
  });
  it("bounds pending I/O and retains cancellation capacity", async () => {
    const gate = deferred<Buffer>(), api = new LibraryPassiveResourceApi({ ...reader(), artwork: () => gate.promise }, () => undefined);
    const one = api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check).catch(() => undefined);
    const two = api.receive({ method: "artwork", requestId: "b", replayId: "r" }, check).catch(() => undefined);
    await expect(api.receive({ method: "artwork", requestId: "c", replayId: "r" }, check)).rejects.toThrow();
    const closing = api.close(); gate.resolve(Buffer.from([1])); await Promise.all([one, two, closing]);
  });
  it("reserves explicit Reveal capacity while the two artwork reads are busy", async () => {
    const gate = deferred<Buffer>(), revealed: string[] = [], api = new LibraryPassiveResourceApi({ ...reader(), artwork: () => gate.promise }, path => { revealed.push(path); });
    const one = api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check).catch(() => undefined);
    const two = api.receive({ method: "artwork", requestId: "b", replayId: "r" }, check).catch(() => undefined);
    expect(await api.receive({ method: "reveal", requestId: "c", replayId: "r" }, check)).toEqual({ revealed: true }); expect(revealed).toHaveLength(1);
    const closing = api.close(); gate.resolve(Buffer.from([1])); await Promise.all([one, two, closing]);
  });
  it("retains uncertain helper ownership after the failed read has left the transfer table", async () => {
    const api = new LibraryPassiveResourceApi({ ...reader(), artwork: async () => { throw new LibraryNativeDrainError("unconfirmed helper exit"); } }, () => undefined);
    await expect(api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check)).rejects.toThrow("could not be verified");
    await expect(api.releaseDocument()).rejects.toThrow("ownership"); await expect(api.close()).rejects.toThrow("ownership");
  });
  it("identifies cancellation acknowledged by the real reader only after it drains", async () => {
    const entered = deferred<void>(), finish = deferred<void>();
    const resources = new LibraryPassiveResources({ select: async () => { entered.resolve(); await finish.promise; return undefined; },
      isCurrent: async () => true, readStrip: async () => undefined, checkpoint: async () => undefined });
    const api = new LibraryPassiveResourceApi(resources, () => undefined);
    const pending = failureOf(api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check));
    await entered.promise; let released = false;
    const release = api.receive({ method: "release", requestId: "a" }, check).then(() => { released = true; });
    await Promise.resolve(); expect(released).toBe(false); finish.resolve();
    const failure = await pending; await release;
    expect(failure.message).toContain("outcome=acknowledged-cancellation abortRequested=true");
    await expect(api.receive({ method: "chunk", requestId: "a", offset: 0 }, check)).rejects.toThrow();
    expect(await api.receive({ method: "artwork", requestId: "b", replayId: "r" }, check)).toEqual({ state: "unavailable" });
    await api.close();
  });
  it("keeps a real stale indexed lease rejection actionable and unclassified", async () => {
    const resources = new LibraryPassiveResources({ select: async () => ({ replayId: "r", revision: "1",
      map: { kind: "stable", songsRoot: "D:/unread", path: "D:/unread/map.osu", md5: "a".repeat(32) } }),
      isCurrent: async () => false, readStrip: async () => undefined, checkpoint: async () => undefined });
    const api = new LibraryPassiveResourceApi(resources, () => undefined);
    await expect(api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check)).rejects.toThrow(
      /Library artwork could not be verified .*outcome=unclassified-failure abortRequested=false/);
    await api.close();
  });
  it.each(["Error", "AbortError"])("does not relabel a true %s rejection when a late abort arrives", async name => {
    const entered = deferred<void>(), finish = deferred<void>(), failure = Error("D:/private/broken.png invalid digest"); failure.name = name;
    const api = new LibraryPassiveResourceApi({ ...reader(), artwork: async () => { entered.resolve(); await finish.promise; throw failure; } }, () => undefined);
    const pending = failureOf(api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check));
    await entered.promise; const release = api.receive({ method: "release", requestId: "a" }, check); finish.resolve();
    const rejected = await pending; await release;
    expect(rejected.message).toContain("could not be verified");
    expect(rejected.message).toContain("outcome=unclassified-failure abortRequested=true");
    expect(rejected.message).not.toContain("private"); expect(rejected.message).not.toContain("acknowledged-cancellation");
    await api.close();
  });
  it("keeps uncertain native drain fatal even after abort was requested", async () => {
    const entered = deferred<void>(), finish = deferred<void>();
    const api = new LibraryPassiveResourceApi({ ...reader(), artwork: async () => { entered.resolve(); await finish.promise;
      throw new LibraryNativeDrainError("D:/private/helper exit unknown"); } }, () => undefined);
    const pending = failureOf(api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check));
    await entered.promise; const release = failureOf(api.receive({ method: "release", requestId: "a" }, check)); finish.resolve();
    const failure = await pending;
    expect(failure.message).toContain("outcome=ownership-uncertain abortRequested=true"); expect(failure.message).not.toContain("private");
    expect(await release).toEqual(Error("Native passive resource ownership is unconfirmed"));
    await expect(api.receive({ method: "artwork", requestId: "b", replayId: "r" }, check)).rejects.toThrow("ownership");
    await expect(api.close()).rejects.toThrow("ownership");
  });
  it("distinguishes expired document delivery from reader acknowledgement of cancellation", async () => {
    const entered = deferred<void>(), finish = deferred<Buffer>();
    const api = new LibraryPassiveResourceApi({ ...reader(), artwork: async () => { entered.resolve(); return finish.promise; } }, () => undefined);
    const pending = failureOf(api.receive({ method: "artwork", requestId: "a", replayId: "r" }, check));
    await entered.promise; const released = api.releaseDocument(); finish.resolve(Buffer.from([1]));
    const failure = await pending; await released;
    expect(failure.message).toContain("outcome=document-expired abortRequested=true"); await api.close();
  });
  it.each(["artwork", "strip", "reveal"] as const)("bounds sanitized %s diagnostics without returning raw identities or error data", async method => {
    const fail = async () => { throw Error("D:/private/background.png raw-content"); };
    const api = new LibraryPassiveResourceApi({ artwork: fail, strip: fail, revealPath: fail }, () => undefined);
    const requestId = "D:/private/" + "a".repeat(115), replayId = "D:/private/" + "b".repeat(115);
    const failure = await failureOf(api.receive({ method, requestId, replayId }, check));
    expect(failure.message).toMatch(new RegExp(`^Library ${method} could not be verified \\[method=${method} request=[a-f0-9]{16} replay=[a-f0-9]{16} outcome=unclassified-failure abortRequested=false\\]$`));
    expect(failure.message.length).toBeLessThan(230); expect(failure.message).not.toMatch(/private|raw-content|D:\//);
    const again = await failureOf(api.receive({ method, requestId, replayId }, check));
    expect(again.message).toBe(failure.message); await api.close();
  });
});
