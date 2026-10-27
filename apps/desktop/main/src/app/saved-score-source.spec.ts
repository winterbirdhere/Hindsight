import { createHash } from "crypto";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { OsrReplay } from "@rewind/osu-local/osr-reader";
import { readOptionalSavedScore, savedScoreFileIdentity } from "./saved-score-source";

const md5 = "1".repeat(32);
const ticks = "639255087055389781";
const filetime = "134343855055389781";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function source() {
  const str = (value: string) => Buffer.concat([Buffer.from([11, value.length]), Buffer.from(value)]);
  const prefix = Buffer.alloc(5);
  prefix.writeInt32LE(20260711, 1);
  const end = Buffer.alloc(8);
  end.writeBigUInt64LE(BigInt(ticks));
  const bytes = Buffer.concat([prefix, str(md5), str("Player"), str(md5), Buffer.alloc(23), Buffer.from([0]), end]);
  const replay = {
    gameMode: 0,
    gameVersion: 20260711,
    beatmapMD5: md5,
    replayContentSha256: digest(bytes),
    number_300s: 1,
    number_100s: 0,
    number_50s: 0,
    gekis: 1,
    katus: 0,
    misses: 0,
    score: 300,
    max_combo: 1,
  } as OsrReplay & { replayContentSha256: string };
  const osg = Buffer.alloc(37);
  osg.writeInt32LE(20260711);
  osg.writeInt32LE(1, 4);
  osg.writeInt32LE(1000, 8);
  osg.writeUInt16LE(1, 13);
  osg.writeUInt16LE(1, 19);
  osg.writeInt32LE(300, 25);
  osg.writeUInt16LE(1, 29);
  osg.writeUInt16LE(1, 31);
  return { bytes, replay, osg };
}
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "rewind-osg-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("extracts exact original ticks without rounding through a Date or number", () => {
  expect(savedScoreFileIdentity(source().bytes)).toEqual({ mapMd5: md5, fileTime: filetime });
  expect(savedScoreFileIdentity(source().bytes.subarray(0, 8))).toBeUndefined();
  const corrupt = source().bytes;
  corrupt[5] = 255;
  expect(savedScoreFileIdentity(corrupt)).toBeUndefined();
});

it("loads a validated adjacent sidecar without an installation path", async () => {
  const f = source(),
    replayPath = join(directory, "renamed.osr");
  await writeFile(replayPath.replace(/\.osr$/, ".osg"), f.osg);
  const result = await readOptionalSavedScore(replayPath, f.bytes, f.replay);
  expect(result).toMatchObject({
    status: "validated",
    timeline: { provenance: { pairedReplaySha256: f.replay.replayContentSha256 }, groups: [{ count: 1, time: 1000 }] },
  });
});

it("cancels optional selected-source reads instead of reporting cancellation as absent or unavailable", async () => {
  const f = source(), replayPath = join(directory, "cancel.osr");
  await writeFile(join(directory, "cancel.osg"), f.osg);
  const controller = new AbortController(); controller.abort();
  await expect(readOptionalSavedScore(replayPath, f.bytes, f.replay, undefined, { signal: controller.signal })).rejects.toThrow(/abort/i);
  const during = new AbortController(); let checkpoints = 0;
  await expect(readOptionalSavedScore(replayPath, f.bytes, f.replay, undefined, {
    signal: during.signal, checkpoint: async () => { checkpoints++; during.abort(); },
  })).rejects.toThrow(/abort/i);
  expect(checkpoints).toBe(1);
  expect(await readOptionalSavedScore(replayPath, f.bytes, f.replay)).toMatchObject({ status: "validated" });
});

it("looks up only the exact configured Data/r file identity and requires byte-identical pairing", async () => {
  const f = source(),
    data = join(directory, "Data", "r");
  await mkdir(data, { recursive: true });
  const base = join(data, `${md5}-${filetime}`);
  await writeFile(base + ".osr", f.bytes);
  await writeFile(base + ".osg", f.osg);
  const result = await readOptionalSavedScore(join(directory, "export.osr"), f.bytes, f.replay, directory);
  expect(result).toMatchObject({
    status: "validated",
    attempts: [{ pairedReplayPath: base + ".osr", timelinePath: base + ".osg", status: "validated" }],
  });
  await writeFile(base + ".osr", Buffer.concat([f.bytes, Buffer.from([99])]));
  expect(await readOptionalSavedScore(join(directory, "export.osr"), f.bytes, f.replay, directory)).toMatchObject({
    status: "rejected",
    reason: "paired-replay-bytes-changed",
  });
});

it("keeps absent, malformed, and inconsistent sidecars optional", async () => {
  const f = source(),
    replayPath = join(directory, "play.osr"),
    sidecar = join(directory, "play.osg");
  expect(await readOptionalSavedScore(replayPath, f.bytes, f.replay)).toMatchObject({ status: "absent" });
  await writeFile(sidecar, Buffer.from([1, 2]));
  expect(await readOptionalSavedScore(replayPath, f.bytes, f.replay)).toMatchObject({
    status: "rejected",
    reason: "unsupported-layout",
  });
  f.osg.writeUInt16LE(5, 29);
  await writeFile(sidecar, f.osg);
  expect(await readOptionalSavedScore(replayPath, f.bytes, f.replay)).toMatchObject({
    status: "rejected",
    reason: "terminal-mismatch",
  });
});

it("does not accept a legacy-looking confirmed native replay as Stable", async () => {
  const f = source(),
    replayPath = join(directory, "native.osr");
  await writeFile(join(directory, "native.osg"), f.osg);
  expect(
    await readOptionalSavedScore(replayPath, f.bytes, {
      ...f.replay,
      sourceClient: "lazer",
      sourceProvenance: "user-confirmed",
    }),
  ).toMatchObject({ status: "unavailable", reason: "unsupported-profile", attempts: [] });
});

it("rejects changed source bytes and invalid identities without guessing a pair by timestamp", async () => {
  const f = source();
  expect(
    await readOptionalSavedScore(join(directory, "play.osr"), Buffer.from([9]), f.replay, directory),
  ).toMatchObject({ status: "rejected", reason: "replay-bytes-changed" });
  expect(
    await readOptionalSavedScore(join(directory, "play.osr"), f.bytes, { ...f.replay, beatmapMD5: "bad" }, directory),
  ).toMatchObject({ status: "unavailable", reason: "invalid-provenance" });
});
