import "reflect-metadata";
import { frontendAPI } from "../../api";
import { OnlineBeatmapLookupService } from "./OnlineBeatmapLookupService";
import type { BeatmapLookupResult } from "../../../../../shared/beatmap-lookup";

jest.mock("../../api", () => ({ frontendAPI: { lookupBeatmap: jest.fn() } }));

const checksum = "8aa246d105c33529e68469852663dc5b";
const beatmap = { beatmapId: 4505197, beatmapsetId: 2140573 };
const found: BeatmapLookupResult = { status: "FOUND", beatmap };
const notFound: BeatmapLookupResult = { status: "NOT_FOUND" };
const unavailable: BeatmapLookupResult = { status: "UNAVAILABLE" };

describe("OnlineBeatmapLookupService", () => {
  const lookup = frontendAPI.lookupBeatmap as jest.MockedFunction<typeof frontendAPI.lookupBeatmap>;
  let service: OnlineBeatmapLookupService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    lookup.mockReset();
    service = new OnlineBeatmapLookupService();
  });

  afterEach(() => jest.useRealTimers());

  it("normalizes the MD5 and requests the main process lookup", async () => {
    lookup.mockResolvedValue(found);

    await expect(service.lookup(`  ${checksum.toUpperCase()}  `)).resolves.toEqual(beatmap);
    expect(lookup).toHaveBeenCalledWith(checksum);
  });

  it.each(["", " ", "not-an-md5", "a".repeat(31), "a".repeat(33), "g".repeat(32)])(
    "skips requests for an invalid MD5: %s",
    async (invalidChecksum) => {
      await expect(service.lookup(invalidChecksum)).resolves.toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it.each([found, notFound, unavailable])("shares concurrent and repeated $status lookups", async (result) => {
    let resolveResponse!: (value: BeatmapLookupResult) => void;
    lookup.mockImplementation(() => new Promise((resolve) => (resolveResponse = resolve)));

    const first = service.lookup(checksum);
    const concurrent = service.lookup(checksum.toUpperCase());
    expect(concurrent).toBe(first);
    expect(lookup).toHaveBeenCalledTimes(1);

    resolveResponse(result);
    await expect(first).resolves.toEqual(result.status === "FOUND" ? beatmap : undefined);
    expect(service.lookup(checksum)).toBe(first);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each([
    { result: found, ttl: 30 * 60_000 },
    { result: notFound, ttl: 5 * 60_000 },
    { result: unavailable, ttl: 30_000 },
  ])("expires $result.status lookups after $ttl ms", async ({ result, ttl }) => {
    lookup.mockResolvedValue(result);
    await service.lookup(checksum);

    jest.advanceTimersByTime(ttl - 1);
    await service.lookup(checksum);
    expect(lookup).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    lookup.mockResolvedValue(found);
    await expect(service.lookup(checksum)).resolves.toEqual(beatmap);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest lookup when the cache exceeds 100 entries", async () => {
    lookup.mockResolvedValue(found);
    const checksums = Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(32, "0"));

    for (const md5 of checksums) await service.lookup(md5);
    expect(lookup).toHaveBeenCalledTimes(101);
    await service.lookup(checksums[100]);
    expect(lookup).toHaveBeenCalledTimes(101);
    await service.lookup(checksums[0]);
    expect(lookup).toHaveBeenCalledTimes(102);
  });

  it("recovers from an IPC failure after a short cooldown instead of caching it as a missing map", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      lookup.mockRejectedValueOnce(new Error("IPC failed"));
      await expect(service.lookup(checksum)).resolves.toBeUndefined();
      await expect(service.lookup(checksum)).resolves.toBeUndefined();
      expect(lookup).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(30_000);
      lookup.mockResolvedValueOnce(found);
      await expect(service.lookup(checksum)).resolves.toEqual(beatmap);
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });

  describe("lookupResult", () => {
    it.each([found, notFound, unavailable])("returns the bridge's $status result", async (result) => {
      lookup.mockResolvedValue(result);

      await expect(service.lookupResult(`  ${checksum.toUpperCase()}  `)).resolves.toEqual(result);
      expect(lookup).toHaveBeenCalledWith(checksum);
    });

    it("reports a rejected bridge as unavailable", async () => {
      const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        lookup.mockRejectedValueOnce(new Error("IPC failed"));
        await expect(service.lookupResult(checksum)).resolves.toEqual(unavailable);
      } finally {
        warning.mockRestore();
      }
    });

    it.each(["", " ", "not-an-md5", "a".repeat(31), "a".repeat(33), "g".repeat(32)])(
      "resolves an invalid MD5 as unavailable without a request: %s",
      async (invalidChecksum) => {
        await expect(service.lookupResult(invalidChecksum)).resolves.toEqual(unavailable);
        expect(lookup).not.toHaveBeenCalled();
      },
    );

    it.each([found, notFound, unavailable])("shares one $status request with lookup", async (result) => {
      lookup.mockResolvedValue(result);

      const detailed = await service.lookupResult(checksum);
      await expect(service.lookup(checksum)).resolves.toEqual(result.status === "FOUND" ? beatmap : undefined);
      await expect(service.lookupResult(checksum)).resolves.toEqual(detailed);
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it("shares a concurrent request started by lookup", async () => {
      let resolveResponse!: (value: BeatmapLookupResult) => void;
      lookup.mockImplementation(() => new Promise((resolve) => (resolveResponse = resolve)));

      const first = service.lookup(checksum);
      const detailed = service.lookupResult(checksum);
      expect(lookup).toHaveBeenCalledTimes(1);

      resolveResponse(found);
      await expect(first).resolves.toEqual(beatmap);
      await expect(detailed).resolves.toEqual(found);
    });
  });
});
