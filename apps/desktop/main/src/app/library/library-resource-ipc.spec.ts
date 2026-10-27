import { LibraryResourceApi } from "./library-resource-ipc";
import { LibraryExactMapUnavailableError } from "./library-replay-opener";

function fixture() {
  const opener = { open: jest.fn(async () => ({ replayId: "one" })), transfer: jest.fn(async () => ({ id: "transfer", bytes: 3 })),
    chunk: jest.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), done: true })), release: jest.fn(async () => undefined),
    releaseDocument: jest.fn(async () => undefined), close: jest.fn(async () => undefined) };
  return { opener, api: new LibraryResourceApi(opener as unknown as ConstructorParameters<typeof LibraryResourceApi>[0]) };
}
it("accepts only bounded identities and relative asset requests, never renderer locations or engine configuration", async () => {
  const f = fixture();
  for (const request of [{ method: "initialize" }, { method: "open", requestId: "one", replayId: "one", locator: "D:\\private" },
    { method: "transfer", requestId: "one", kind: "asset", name: "../outside.wav" }, { method: "chunk", requestId: "one", transferId: "t", offset: -1 }])
    await expect(f.api.receive(request, () => undefined)).rejects.toThrow(/invalid|unknown/i);
  expect(f.opener.open).not.toHaveBeenCalled();
  await f.api.receive({ method: "open", requestId: "request", replayId: "one" }, () => undefined);
  await f.api.receive({ method: "transfer", requestId: "request", kind: "asset", name: "samples/hit.wav" }, () => undefined);
  expect(f.opener.transfer).toHaveBeenCalledWith("request", "asset", "samples/hit.wav"); await f.api.close();
});
it("revokes the previous document while a reply is in flight", async () => {
  const f = fixture(); let finish!: (value: { replayId: string }) => void;
  f.opener.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = f.api.receive({ method: "open", requestId: "request", replayId: "one" }, () => undefined);
  await f.api.releaseDocument(); finish({ replayId: "one" });
  await expect(old).rejects.toThrow(/document/i);
  expect(f.opener.releaseDocument).toHaveBeenCalledTimes(1); await f.api.close();
});
it("transports only the local typed absence as bounded path-free open data", async () => {
  const f = fixture(); f.opener.open.mockRejectedValueOnce(new LibraryExactMapUnavailableError("one", "b".repeat(32)));
  expect(await f.api.receive({ method: "open", requestId: "request", replayId: "one" }, () => undefined)).toEqual({
    state: "unavailable", reason: "exact-map-unavailable", requestId: "request", replayId: "one", beatmapMd5: "b".repeat(32) });
  const generic = Object.assign(new Error("Exact beatmap is unavailable in enabled sources"), { name: "LibraryExactMapUnavailableError" });
  f.opener.open.mockRejectedValueOnce(generic);
  await expect(f.api.receive({ method: "open", requestId: "other", replayId: "one" }, () => undefined)).rejects.toBe(generic);
  await f.api.close();
});
it("does not publish a typed failure from an expired document", async () => {
  const f = fixture(); let fail!: (error: Error) => void;
  f.opener.open.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const pending = f.api.receive({ method: "open", requestId: "request", replayId: "one" }, () => undefined);
  await f.api.releaseDocument(); fail(new LibraryExactMapUnavailableError("one", "b".repeat(32)));
  await expect(pending).rejects.toThrow("document"); await f.api.close();
});
