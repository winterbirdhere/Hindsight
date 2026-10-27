import { createHash } from "crypto";
import { mkdtemp, writeFile, readFile, rm, rmdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { inspectReplayFile } from "./replay-file";

function fixture(payloadBytes = 100) {
  const version = Buffer.alloc(5); version.writeInt32LE(20260904, 1);
  const timing = Buffer.alloc(12); timing.writeBigInt64LE(BigInt("638961337234567891")); timing.writeInt32LE(payloadBytes, 8);
  return Buffer.concat([version, Buffer.from([11, 32]), Buffer.from("a".repeat(32)), Buffer.from([11, 1, 80, 0]),
    Buffer.alloc(23), Buffer.from([0]), timing, Buffer.alloc(payloadBytes, 42), Buffer.alloc(8)]);
}

let folder: string;
let path: string;
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), "hindsight-byte-binding-")); path = join(folder, "replay.osr"); });
afterEach(async () => { await rm(path, { force: true }); await rmdir(folder); });

it("binds the header to the exact hashed bytes without decoding an invalid compressed payload", async () => {
  const bytes = fixture(); await writeFile(path, bytes);
  const replay = await inspectReplayFile(path);
  expect(replay.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(replay.header.playedAtTicks).toBe("638961337234567891");
  expect(replay.header.player).toBe("P");
  expect(replay.stamp.bytes).toBe(bytes.length);
  expect(await readFile(path)).toEqual(bytes);
});

it("yields between bounded chunks and checks cancellation without returning partial identity", async () => {
  await writeFile(path, fixture(3 * 1024 * 1024));
  const abort = new AbortController();
  let chunks = 0;
  await expect(inspectReplayFile(path, abort.signal, async () => { if (++chunks === 2) abort.abort(); })).rejects.toThrow(/abort/i);
  expect(chunks).toBe(2);
  const checkpoint = jest.fn().mockResolvedValue(undefined);
  expect((await inspectReplayFile(path, undefined, checkpoint)).sha256).toHaveLength(64);
  expect(checkpoint.mock.calls.length).toBeGreaterThan(2);
});

it("rejects a file changed during hashing and closes its handle", async () => {
  const bytes = fixture(2 * 1024 * 1024); await writeFile(path, bytes);
  let changed = false;
  await expect(inspectReplayFile(path, undefined, async () => {
    if (!changed) { changed = true; await writeFile(path, fixture(20)); }
  })).rejects.toThrow(/changed|truncated/i);
  // A fresh independent request can read the replacement after the failed request disposes.
  expect((await inspectReplayFile(path)).stamp.bytes).toBe(fixture(20).length);
});

it("does not return an identity for malformed headers", async () => {
  await writeFile(path, Buffer.from("not a replay"));
  await expect(inspectReplayFile(path)).rejects.toThrow();
});
