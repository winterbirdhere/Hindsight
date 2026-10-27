import { EventEmitter } from "events";
import { IncomingMessage } from "http";
import { get } from "https";
import { lookupBeatmap } from "./beatmap-lookup";

jest.mock("https", () => ({ get: jest.fn() }));

const checksum = "8aa246d105c33529e68469852663dc5b";
const foundPayload = { id: 4505197, beatmapset_id: 2140573, checksum };
const foundResult = { status: "FOUND", beatmap: { beatmapId: 4505197, beatmapsetId: 2140573 } };
const mockGet = get as jest.Mock;

describe("main-process beatmap lookup", () => {
  let request: EventEmitter & { destroy: jest.Mock };
  let receiveResponse: (response: IncomingMessage) => void;
  let warn: jest.SpyInstance;

  function respond(statusCode: number) {
    const response = Object.assign(new EventEmitter(), { statusCode, destroy: jest.fn() });
    receiveResponse(response as unknown as IncomingMessage);
    return response;
  }

  function endWith(payload: unknown) {
    const response = respond(200);
    const body = Buffer.from(JSON.stringify(payload));
    response.emit("data", body.subarray(0, 17));
    response.emit("data", body.subarray(17));
    response.emit("end");
    return response;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    request = Object.assign(new EventEmitter(), { destroy: jest.fn() });
    mockGet.mockReset().mockImplementation((_url, _options, callback) => {
      receiveResponse = callback;
      return request;
    });
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    warn.mockRestore();
    jest.useRealTimers();
  });

  it("uses the documented MD5 endpoint, app identity, and matching beatmap IDs", async () => {
    const pending = lookupBeatmap(`  ${checksum.toUpperCase()}  `, "0.2.2");
    expect(mockGet).toHaveBeenCalledWith(
      `https://osu.direct/api/v2/md5/${checksum}`,
      { headers: { "User-Agent": "Hindsight/0.2.2", Accept: "application/json" } },
      expect.any(Function),
    );
    endWith(foundPayload);
    await expect(pending).resolves.toEqual(foundResult);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 1234, "", "not-a-checksum", "a".repeat(31), "g".repeat(32), "a".repeat(33)])(
    "skips networking for invalid checksum %p",
    async (invalidChecksum) => {
      await expect(lookupBeatmap(invalidChecksum, "0.2.2")).resolves.toEqual({ status: "NOT_FOUND" });
      expect(mockGet).not.toHaveBeenCalled();
    },
  );

  it("treats only HTTP 404 as confirmed not found and stops reading its body", async () => {
    const pending = lookupBeatmap(checksum, "0.2.2");
    const response = respond(404);
    await expect(pending).resolves.toEqual({ status: "NOT_FOUND" });
    expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([403, 429, 500, 503, 301])("reports HTTP %s as unavailable without retrying", async (status) => {
    const pending = lookupBeatmap(checksum, "0.2.2");
    respond(status);
    await expect(pending).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(warn).toHaveBeenCalledWith(`Beatmap lookup unavailable: HTTP ${status}`);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [],
    { ...foundPayload, id: 0 },
    { ...foundPayload, id: "4505197" },
    { ...foundPayload, id: 0.5 },
    { ...foundPayload, beatmapset_id: -1 },
    { ...foundPayload, beatmapset_id: Number.MAX_SAFE_INTEGER + 1 },
    { ...foundPayload, checksum: "a".repeat(32) },
    { ...foundPayload, checksum: undefined },
  ])("rejects malformed or unrelated beatmap payload %p", async (payload) => {
    const pending = lookupBeatmap(checksum, "0.2.2");
    endWith(payload);
    await expect(pending).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reports invalid JSON without logging the response body", async () => {
    const pending = lookupBeatmap(checksum, "0.2.2");
    const response = respond(200);
    response.emit("data", Buffer.from(`<html>upstream error: ${checksum}</html>`));
    response.emit("end");
    await expect(pending).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(warn).toHaveBeenCalledWith("Beatmap lookup unavailable: invalid JSON response");
  });

  it("bounds the response size", async () => {
    const pending = lookupBeatmap(checksum, "0.2.2");
    const response = respond(200);
    response.emit("data", Buffer.alloc(256 * 1024 + 1));
    await expect(pending).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Beatmap lookup unavailable: response exceeded size limit");
  });

  it("times out before headers and ignores a response arriving after the deadline", async () => {
    const pending = lookupBeatmap(checksum, "0.2.2");
    jest.advanceTimersByTime(5000);
    await expect(pending).resolves.toEqual({ status: "UNAVAILABLE" });
    const lateResponse = respond(200);
    expect(lateResponse.destroy).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps an absolute deadline while response data trickles in", async () => {
    const pending = lookupBeatmap(checksum, "0.2.2");
    jest.advanceTimersByTime(3000);
    const response = respond(200);
    response.emit("data", Buffer.from("{"));
    jest.advanceTimersByTime(1999);
    expect(request.destroy).not.toHaveBeenCalled();
    response.emit("data", Buffer.from('"id":'));
    jest.advanceTimersByTime(1);
    await expect(pending).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Beatmap lookup unavailable: request timed out after 5 seconds");
  });

  it("handles network failures with a diagnostic code without leaking the URL or hash", async () => {
    const pending = lookupBeatmap(checksum, "0.2.2");
    request.emit("error", Object.assign(new Error(`https://osu.direct/api/v2/md5/${checksum}`), { code: "ENOTFOUND" }));
    await expect(pending).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(warn).toHaveBeenCalledWith("Beatmap lookup unavailable: network error (ENOTFOUND)");
  });

  it.each(["error", "aborted"])("handles response %s without settling twice", async (event) => {
    const pending = lookupBeatmap(checksum, "0.2.2");
    const response = respond(200);
    response.emit(event, Object.assign(new Error("disconnected"), { code: "ECONNRESET" }));
    response.emit("aborted");
    request.emit("error", new Error("connection closed"));
    await expect(pending).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });

  it("handles synchronous request initialization failures", async () => {
    mockGet.mockImplementation(() => {
      throw new Error("request failed");
    });
    await expect(lookupBeatmap(checksum, "0.2.2")).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(warn).toHaveBeenCalledWith("Beatmap lookup unavailable: request could not start");
  });
});
