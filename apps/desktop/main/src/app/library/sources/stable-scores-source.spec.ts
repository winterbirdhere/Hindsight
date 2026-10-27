import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { join, resolve, sep } from "path";
import { tmpdir } from "os";
import { scanStableScores } from "./stable-scores-source";
import type { FileSourceObservation } from "./replays-folder-source";
import * as sourceFile from "./source-file";

const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const i64 = (n: string) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const str = (s: string) => s ? Buffer.concat([Buffer.from([11, Buffer.byteLength(s)]), Buffer.from(s)]) : Buffer.from([0]);
const md5 = "a".repeat(32);
const ticks = "638961337234567891";
const rowPrefix = Buffer.concat([Buffer.from([0]), i32(20260904), str(md5), str("P"), str("hash"), Buffer.alloc(23), str(""), i64(ticks)]);
const score = Buffer.concat([rowPrefix, i32(-1), i64("42")]);
const database = Buffer.concat([i32(20260904), i32(1), str(md5), i32(1), score]);
const replay = Buffer.concat([rowPrefix, i32(0), i64("42")]);
let root: string;
let cache: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hindsight-stable-")); await mkdir(join(root, "Data", "r"), { recursive: true });
  cache = join(root, "Data", "r", md5 + "-134050105234567891.osr");
  await writeFile(join(root, "scores.db"), database);
});
afterEach(async () => {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture root");
  await rm(root, { recursive: true, force: true });
});
async function collect(options = {}) {
  const rows: FileSourceObservation[] = [];
  for await (const row of scanStableScores(root, options)) rows.push(row);
  return rows;
}

it("indexes exact saved metadata then binds only the matching cache bytes without changing the source", async () => {
  await writeFile(cache, replay);
  const rows = await collect();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ sha256: null, available: false, locator: cache, metadata: { savedScore: { header: { playedAtTicks: ticks } } } });
  expect(rows[1]).toMatchObject({ sha256: expect.stringMatching(/^[a-f\d]{64}$/), available: true });
  expect(await readFile(join(root, "scores.db"))).toEqual(database);
  expect(await readFile(cache)).toEqual(replay);
});

it("retains metadata for a missing cache and refuses a different replay at the generated filename", async () => {
  expect((await collect()).at(-1)).toMatchObject({ available: false, metadata: { fileState: "missing" } });
  const wrong = Buffer.from(replay); wrong.writeInt32LE(20260905, 1); await writeFile(cache, wrong);
  expect((await collect()).at(-1)).toMatchObject({ available: false, sha256: null, metadata: { fileState: "conflict" } });
});

it("does not claim source exhaustion after cancellation or a database change", async () => {
  const controller = new AbortController();
  const iterator = scanStableScores(root, { signal: controller.signal });
  await iterator.next(); controller.abort();
  await expect(iterator.next()).rejects.toThrow(/abort/i);
  const changed = scanStableScores(root); await changed.next();
  await writeFile(join(root, "scores.db"), Buffer.concat([database, Buffer.from([1])]));
  await expect((async () => { for await (const ignored of changed) void ignored; })()).rejects.toThrow(/changed/i);
});

it("does not report completion when cancelled during its final database check", async () => {
  const controller = new AbortController();
  const original = sourceFile.assertSourceUnchanged;
  const check = jest.spyOn(sourceFile, "assertSourceUnchanged").mockImplementationOnce(async (...args) => {
    await original(...args); controller.abort();
  });
  try { await expect(collect({ signal: controller.signal })).rejects.toThrow(/abort/i); }
  finally { check.mockRestore(); }
});
