import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { inspectReplayFile } from "./replay-file";
import { scanImportedReplays } from "./imported-source";
import type { FileSourceObservation } from "./replays-folder-source";

let root: string;
let file: string;
const version = Buffer.alloc(5); version.writeInt32LE(20260904, 1);
const data = Buffer.concat([version, Buffer.from([11, 32]), Buffer.from("a".repeat(32)), Buffer.from([0, 0]),
  Buffer.alloc(23), Buffer.from([0]), Buffer.alloc(12), Buffer.alloc(8)]);
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hindsight-owned-scan-")); file = join(root, "owned.osr"); await writeFile(file, data); });
afterEach(async () => { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture root"); await rm(root, { recursive: true, force: true }); });
async function* manifests(record: FileSourceObservation) { yield record; }
async function collect(record: FileSourceObservation) {
  const rows: FileSourceObservation[] = [];
  for await (const row of scanImportedReplays(manifests(record))) rows.push(row);
  return rows;
}
it("scans only journaled owned locations and retains their content keys", async () => {
  const verified = await inspectReplayFile(file);
  const result = await collect({ sourceKey: verified.sha256, locator: file, sha256: verified.sha256, available: true, metadata: {} });
  expect(result).toEqual([expect.objectContaining({ sourceKey: verified.sha256, sha256: verified.sha256, available: true })]);
  expect(await readFile(file)).toEqual(data);
});
it("marks a changed owned copy unavailable instead of adopting new bytes as the imported replay", async () => {
  const verified = await inspectReplayFile(file);
  const replacement = Buffer.from(data); replacement.writeInt32LE(20260905, 1); await writeFile(file, replacement);
  const result = await collect({ sourceKey: verified.sha256, locator: file, sha256: verified.sha256, available: true, metadata: {} });
  expect(result).toEqual([expect.objectContaining({ sha256: null, available: false, metadata: expect.objectContaining({ fileState: "error" }) })]);
  expect(await readFile(file)).toEqual(replacement);
});
