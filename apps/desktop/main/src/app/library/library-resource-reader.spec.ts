import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { createHash } from "crypto";
import { readVerifiedLibraryResource } from "./library-resource-reader";

let root: string, file: string;
const bytes = Buffer.from("osu file format v14\n[Metadata]\nTitle:Fixture\n");
const sha256 = createHash("sha256").update(bytes).digest("hex"), md5 = createHash("md5").update(bytes).digest("hex");
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hindsight-resource-")); file = join(root, "map.osu"); await writeFile(file, bytes); });
afterEach(async () => { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Fixture escaped temp directory"); await rm(root, { recursive: true, force: true }); });

it("returns the exact buffer verified against both source SHA and replay map MD5", async () => {
  const resource = await readVerifiedLibraryResource(file, { sha256, md5, maxBytes: 1024 });
  expect(resource.bytes).toEqual(bytes); expect(resource).toMatchObject({ sha256, md5, stamp: { bytes: bytes.length } });
});
it.each([{ sha256: "f".repeat(64) }, { md5: "f".repeat(32) }])("rejects conflicting digest evidence %j", async expected => {
  await expect(readVerifiedLibraryResource(file, { ...expected, maxBytes: 1024 })).rejects.toThrow(/digest/i);
});
it("enforces a hard size limit before consuming resource bytes", async () => {
  await expect(readVerifiedLibraryResource(file, { maxBytes: 4 })).rejects.toThrow(/size/i);
  await expect(readVerifiedLibraryResource(file, { maxBytes: Infinity })).rejects.toThrow(/limit/i);
});
it("closes and rejects if cancelled between chunks", async () => {
  const controller = new AbortController();
  await expect(readVerifiedLibraryResource(file, { maxBytes: 1024 }, controller.signal, async () => controller.abort())).rejects.toThrow(/abort/i);
  await writeFile(file, bytes); // A later read is independent and the cancelled handle is closed.
  expect((await readVerifiedLibraryResource(file, { sha256, maxBytes: 1024 })).sha256).toBe(sha256);
});
it("rejects source changes during consumption without returning a buffer", async () => {
  let changed = false;
  await expect(readVerifiedLibraryResource(file, { sha256, maxBytes: 1024 }, undefined, async () => {
    if (!changed) { changed = true; await writeFile(file, Buffer.from("replacement")); }
  })).rejects.toThrow(/changed|truncated|digest/i);
});
