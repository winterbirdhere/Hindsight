import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { join, resolve, sep } from "path";
import { tmpdir } from "os";
import { scanReplayFolder, FileSourceObservation } from "./replays-folder-source";

const version = Buffer.alloc(5); version.writeInt32LE(20260904, 1);
const timing = Buffer.alloc(12); timing.writeBigInt64LE(BigInt("638961337234567891")); timing.writeInt32LE(0, 8);
const bytes = Buffer.concat([version, Buffer.from([11, 32]), Buffer.from("a".repeat(32)), Buffer.from([0, 0]),
  Buffer.alloc(23), Buffer.from([0]), timing, Buffer.alloc(8)]);
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hindsight-folder-")); });
afterEach(async () => {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture root");
  await rm(root, { recursive: true, force: true });
});
async function collect(options = {}): Promise<FileSourceObservation[]> {
  const records: FileSourceObservation[] = [];
  for await (const record of scanReplayFolder(root, options)) records.push(record);
  return records;
}

it("publishes cheap header metadata before hashing, traverses files without copying, and ignores other formats", async () => {
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "one.OSR"), bytes); await writeFile(join(root, "ignore.txt"), "ignored");
  const records = await collect();
  expect(records.map(r => r.metadata.fileState)).toEqual(["indexing", "readable"]);
  expect(records[0]).toMatchObject({ sha256: null, available: false, sourceKey: "nested/one.osr", metadata: { header: { playedAtTicks: "638961337234567891" } } });
  expect(records[1]).toMatchObject({ sha256: expect.stringMatching(/^[a-f\d]{64}$/), available: true });
  expect(await readFile(join(root, "nested", "one.OSR"))).toEqual(bytes);
});

it("reuses an unchanged verified file observation and rehashes changed bytes at the same path", async () => {
  const path = join(root, "one.osr"); await writeFile(path, bytes);
  const first = (await collect())[1];
  expect(await collect({ cached: async () => first })).toEqual([first]);
  const changed = Buffer.from(bytes); changed.writeInt32LE(20260905, 1); await writeFile(path, changed);
  const next = await collect({ cached: async () => first });
  expect(next).toHaveLength(2);
  expect(next[1].sha256).not.toBe(first.sha256);
});

it("keeps malformed replay failures explicit while continuing the other files", async () => {
  await writeFile(join(root, "bad.osr"), "not a replay"); await writeFile(join(root, "good.osr"), bytes);
  const records = await collect();
  expect(records.find(r => r.sourceKey === "bad.osr")).toMatchObject({ sha256: null, available: false, metadata: { fileState: "error", reason: expect.any(String) } });
  expect(records.filter(r => r.available)).toHaveLength(1);
});

it("cancels at a checkpoint instead of pretending enumeration completed", async () => {
  await writeFile(join(root, "one.osr"), bytes);
  const controller = new AbortController();
  await expect(collect({ signal: controller.signal, checkpoint: async () => controller.abort() })).rejects.toThrow(/abort/i);
});

it("rejects a changing directory as incomplete, preserving removal decisions for a later scan", async () => {
  await writeFile(join(root, "one.osr"), bytes);
  const scan = scanReplayFolder(root);
  expect((await scan.next()).value?.metadata.fileState).toBe("indexing");
  await writeFile(join(root, "new.txt"), "directory changed");
  await expect((async () => { for await (const ignored of scan) void ignored; })()).rejects.toThrow(/changed/i);
});

it("acknowledges cancellation after the final verified result instead of returning complete", async () => {
  await writeFile(join(root, "one.osr"), bytes);
  const controller = new AbortController();
  const iterator = scanReplayFolder(root, { signal: controller.signal });
  await iterator.next();
  expect((await iterator.next()).value?.available).toBe(true);
  controller.abort();
  await expect(iterator.next()).rejects.toThrow(/abort/i);
});
