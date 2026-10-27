import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { createHash } from "crypto";
import { scanLazerSource } from "./lazer-scan";
import type { LazerSourceScore, LazerSourceInspection } from "./lazer-source";
import type { FileSourceObservation } from "./replays-folder-source";

let root: string;
const token = "b".repeat(64);
const version = Buffer.alloc(5); version.writeInt32LE(30000000, 1);
const timing = Buffer.alloc(12); timing.writeBigInt64LE(BigInt("638961337234560000")); timing.writeInt32LE(0, 8);
const bytes = Buffer.concat([version, Buffer.from([11, 32]), Buffer.from("a".repeat(32)), Buffer.from([0, 0]), Buffer.alloc(23), Buffer.from([0]), timing, Buffer.alloc(8)]);
let score: LazerSourceScore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hindsight-native-scan-")); const path = join(root, "blob"); await writeFile(path, bytes);
  score = { id: "a0000000-0000-4000-8000-000000000001", playedAtTicks: "638961337234560000", player: null, ruleset: 0,
    clientVersion: "2026.730.0", isLegacyScore: false, maxCombo: 123, accuracy: 0.95, rank: 3, pp: null, mods: [], statistics: null,
    maximumStatistics: null, replay: { status: "unverified", path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    beatmap: { status: "unverified", path: join(root, "map"), bytes: 100, sha256: "c".repeat(64), md5: "a".repeat(32) }, assets: [] };
});
afterEach(async () => { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture root"); await rm(root, { recursive: true, force: true }); });
const response = (scores: LazerSourceScore[], nextOffset: number, total: number): LazerSourceInspection => ({
  version: 1, ok: true, status: "ready", sampleOnly: false, schemaFingerprint: "d".repeat(64), cursorToken: token,
  scores, nextOffset, total, complete: nextOffset === total,
});
async function collect(source: { page: jest.Mock }, options = {}) {
  const records: FileSourceObservation[] = [];
  for await (const row of scanLazerSource(source, root, options)) records.push(row);
  return records;
}

it("manual feedback uses native source cursor records rather than double replay observations", async () => {
  const badId = "a0000000-0000-4000-8000-000000000002", progress = jest.fn();
  const source = { page: jest.fn().mockResolvedValueOnce({ ...response([score], 2, 2), errors: [{ id: badId, status: "resource-limit" }] })
    .mockResolvedValueOnce(response([], 2, 2)) };
  const rows = await collect(source, { onProgress: progress });
  expect(rows).toHaveLength(3);
  expect(progress.mock.calls.map(([value]) => value)).toEqual([
    { phase: "checking-replays", completed: 0, total: 2, unit: "source-records" },
    { phase: "checking-replays", completed: 2, total: 2, unit: "source-records" },
  ]);
});

it("manual feedback reaching the native total does not skip final source revalidation", async () => {
  const progress = jest.fn(), source = { page: jest.fn().mockResolvedValueOnce(response([score], 1, 1))
    .mockResolvedValueOnce({ version: 1, ok: false, status: "source-changed" }) };
  await expect(collect(source, { onProgress: progress })).rejects.toThrow(/source-changed/);
  expect(progress).toHaveBeenLastCalledWith({ phase: "checking-replays", completed: 1, total: 1, unit: "source-records" });
});

it("publishes unverified native metadata then byte proof and confirms same-token EOF after hashing", async () => {
  const source = { page: jest.fn().mockResolvedValueOnce(response([score], 1, 1)).mockResolvedValueOnce(response([], 1, 1)) };
  const rows = await collect(source);
  expect(rows.map(r => r.available)).toEqual([false, true]);
  expect(rows[0].sha256).toBeNull();
  expect(rows[1]).toMatchObject({ sha256: score.replay.sha256, metadata: { nativeScore: { maxCombo: 123 }, header: { maxCombo: 0 } } });
  expect(source.page).toHaveBeenLastCalledWith(root, { token, offset: 1 }, undefined);
});

it("does not equate declared hashes with verified content or lose metadata on corrupt/missing blobs", async () => {
  const source = { page: jest.fn().mockResolvedValueOnce(response([{ ...score, replay: { ...score.replay, sha256: "e".repeat(64) } }], 1, 1)).mockResolvedValueOnce(response([], 1, 1)) };
  const rows = await collect(source);
  expect(rows.at(-1)).toMatchObject({ available: false, sha256: null, metadata: { fileState: "error", nativeScore: { accuracy: 0.95 } } });
});

it("refuses completion when the native database changed after the final blob verification", async () => {
  const source = { page: jest.fn().mockResolvedValueOnce(response([score], 1, 1)).mockResolvedValueOnce({ version: 1, ok: false, status: "source-changed" }) };
  await expect(collect(source)).rejects.toThrow(/source-changed/);
});

it.each(["source-missing", "source-busy"] as const)("retains the validated native %s discriminator for status consumers", async status => {
  const source = { page: jest.fn().mockResolvedValue({ version: 1, ok: false, status }) };
  await expect(collect(source)).rejects.toMatchObject({ failureReason: status });
});

it("keeps an unsupported native schema generic instead of diagnosing a missing source", async () => {
  const source = { page: jest.fn().mockResolvedValue({ version: 1, ok: false, status: "unsupported-schema" }) };
  await expect(collect(source)).rejects.toMatchObject({ message: "Native source scan: unsupported-schema" });
  await expect(collect(source)).rejects.not.toHaveProperty("failureReason");
});

it("yields between pages and propagates Stop without making a new native request", async () => {
  const source = { page: jest.fn().mockResolvedValueOnce(response([score], 1, 2)) };
  const abort = new AbortController();
  const iterator = scanLazerSource(source, root, { signal: abort.signal });
  await iterator.next(); abort.abort();
  await expect(iterator.next()).rejects.toThrow(/abort/i);
  expect(source.page).toHaveBeenCalledTimes(1);
});

it("keeps a malformed native row visible and still reaches later rows and EOF", async () => {
  const badId = "a0000000-0000-4000-8000-000000000002";
  const source = { page: jest.fn().mockResolvedValueOnce({ ...response([score], 2, 2), errors: [{ id: badId, status: "resource-limit" }] })
    .mockResolvedValueOnce(response([], 2, 2)) };
  const records = await collect(source);
  expect(records.find(row => row.sourceKey === badId)).toMatchObject({ available: false, sha256: null, metadata: { fileState: "error", reason: "resource-limit" } });
  expect(records.filter(row => row.available)).toHaveLength(1);
});

it("revalidates native map binding before reusing an unchanged cached replay", async () => {
  const first = { page: jest.fn().mockResolvedValueOnce(response([score], 1, 1)).mockResolvedValueOnce(response([], 1, 1)) };
  const cached = (await collect(first)).at(-1);
  const changed = { ...score, beatmap: { ...score.beatmap, md5: "f".repeat(32) } };
  const source = { page: jest.fn().mockResolvedValueOnce(response([changed], 1, 1)).mockResolvedValueOnce(response([], 1, 1)) };
  const rows = await collect(source, { cached: async () => cached });
  expect(rows.at(-1)).toMatchObject({ available: false, sha256: null, metadata: { fileState: "error", reason: expect.stringMatching(/beatmap/) } });
});
