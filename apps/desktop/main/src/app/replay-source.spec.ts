import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { read } from "@rewind/osu-local/osr-reader";
import { readReplayWithSource } from "./replay-source";
import { readOptionalSavedScore } from "./saved-score-source";

jest.mock("fs/promises", () => ({ readFile: jest.fn() }));
jest.mock("@rewind/osu-local/osr-reader", () => ({ read: jest.fn() }));
jest.mock("./saved-score-source", () => ({ readOptionalSavedScore: jest.fn() }));

const bytes = Buffer.from("unchanged replay bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const decoded = { gameVersion: 20260711, replayMD5: "legacy-id", number_300s: 2, misses: 7 };

function fixture(store: unknown, content = bytes) {
  (readFile as jest.Mock).mockImplementation((file) => {
    if (file === "origins.json") {
      if (store instanceof Error) return Promise.reject(store);
      return Promise.resolve(typeof store === "string" ? store : JSON.stringify(store));
    }
    return Promise.resolve(content);
  });
  (read as jest.Mock).mockResolvedValue({ ...decoded });
}

beforeEach(() => {
  jest.clearAllMocks();
  (readOptionalSavedScore as jest.Mock).mockResolvedValue(undefined);
});

it("uses the injected original-reader boundary with the same retained source buffer", async () => {
  fixture({ version: 1, entries: {} });
  const isolated = jest.fn().mockResolvedValue({ ...decoded, timestamp: new Date(123) });
  const replay = await readReplayWithSource("replay.osr", "origins.json", "configured", { read: isolated });
  expect(isolated).toHaveBeenCalledWith(bytes); expect(read).not.toHaveBeenCalled();
  expect(bytes.toString()).toBe("unchanged replay bytes");
  expect(replay.timestamp).toEqual(new Date(123)); expect(replay.replayContentSha256).toBe(digest);
  expect(readOptionalSavedScore).toHaveBeenCalledWith("replay.osr", bytes, replay, "configured");
});

it("propagates the original injected decode error without legacy fallback", async () => {
  fixture({}); const failure = new Error("original decode message");
  await expect(readReplayWithSource("replay.osr", "origins.json", undefined, { read: async () => { throw failure; } })).rejects.toBe(failure);
  expect(read).not.toHaveBeenCalled(); expect(readOptionalSavedScore).not.toHaveBeenCalled();
});

it("rejects cancelled decoding and optional evidence instead of publishing stale data", async () => {
  fixture({}); const first = new AbortController(), reason = new Error("document retired");
  await expect(readReplayWithSource("replay.osr", "origins.json", undefined, { signal: first.signal,
    read: async () => { first.abort(reason); return { ...decoded } as never; } })).rejects.toBe(reason);
  const second = new AbortController();
  (readOptionalSavedScore as jest.Mock).mockImplementation(async () => { second.abort(reason); throw new Error("sidecar stopped"); });
  await expect(readReplayWithSource("replay.osr", "origins.json", undefined, { signal: second.signal })).rejects.toBe(reason);
});

it("attaches optional corroboration only after resolving exact-byte source origins", async () => {
  fixture({ version: 1, entries: { [digest]: { client: "lazer", provenance: "user-confirmed" } } });
  const savedScoreSource = { status: "unavailable", reason: "unsupported-profile", attempts: [] };
  (readOptionalSavedScore as jest.Mock).mockResolvedValue(savedScoreSource);
  const result = await readReplayWithSource("renamed.osr", "origins.json", "configured-osu");
  expect(result.savedScoreSource).toEqual(savedScoreSource);
  expect(readOptionalSavedScore).toHaveBeenCalledWith(
    "renamed.osr",
    bytes,
    expect.objectContaining({ sourceClient: "lazer", sourceProvenance: "user-confirmed", replayContentSha256: digest }),
    "configured-osu",
  );
});

it("keeps optional corroboration failures separate from replay load failures", async () => {
  fixture(new Error("Absent origin store"));
  (readOptionalSavedScore as jest.Mock).mockRejectedValue(new Error("Unreadable optional sidecar"));
  await expect(readReplayWithSource("replay.osr", "origins.json")).resolves.toMatchObject({
    replayContentSha256: digest,
    savedScoreSource: { status: "unavailable", reason: "saved-score-read-failed" },
  });
});

it("loads a confirmed origin by exact file content, including renamed copies", async () => {
  fixture({ version: 1, entries: { [digest]: { client: "lazer", provenance: "user-confirmed" } } });
  for (const name of ["first.osr", "renamed.osr"]) {
    const replay = await readReplayWithSource(name, "origins.json");
    expect(replay).toEqual({
      ...decoded,
      replayContentSha256: digest,
      sourceClient: "lazer",
      sourceProvenance: "user-confirmed",
    });
  }
  expect(read).toHaveBeenCalledWith(bytes);
});

it("never transfers provenance to another file with the same header identifier", async () => {
  fixture(
    { version: 1, entries: { [digest]: { client: "lazer", provenance: "user-confirmed" } } },
    Buffer.from("different replay"),
  );
  expect(await readReplayWithSource("first.osr", "origins.json")).toEqual({
    ...decoded,
    replayContentSha256: createHash("sha256").update(Buffer.from("different replay")).digest("hex"),
  });
});

it.each([
  { version: 1, entries: {} },
  { version: 2, entries: { [digest]: { client: "lazer", provenance: "user-confirmed" } } },
  { version: 1, entries: { [digest]: { client: "lazer", provenance: "score-match" } } },
  { version: 1, entries: { [digest]: { client: "unknown", provenance: "user-confirmed" } } },
  "malformed json",
  new Error("Missing or unreadable provenance store"),
])("retains the exact byte digest without a valid optional origin store: %p", async (store) => {
  fixture(store);
  expect(await readReplayWithSource("unknown.osr", "origins.json")).toEqual({
    ...decoded,
    replayContentSha256: digest,
  });
  expect((readFile as jest.Mock).mock.calls.filter(([file]) => file === "unknown.osr")).toHaveLength(1);
  expect(read).toHaveBeenCalledWith(bytes);
});

it("preserves an explicit Stable origin without changing the recorded header", async () => {
  fixture({ version: 1, entries: { [digest]: { client: "stable", provenance: "user-confirmed" } } });
  expect(await readReplayWithSource("stable.osr", "origins.json")).toEqual({
    ...decoded,
    replayContentSha256: digest,
    sourceClient: "stable",
    sourceProvenance: "user-confirmed",
  });
});

it("propagates unreadable replay errors instead of disguising them as missing provenance", async () => {
  (readFile as jest.Mock).mockRejectedValue(new Error("Replay cannot be read"));
  await expect(readReplayWithSource("missing.osr", "origins.json")).rejects.toThrow("Replay cannot be read");
  expect(read).not.toHaveBeenCalled();
});
