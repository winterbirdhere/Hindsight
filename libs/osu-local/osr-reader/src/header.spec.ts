import { mkdtemp, writeFile, rm, rmdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parseReplayHeader, readReplayHeader } from "./header";

function text(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length: number[] = [];
  let size = bytes.length;
  do { const next = size % 128; size = Math.floor(size / 128); length.push(next | (size ? 128 : 0)); } while (size);
  return Buffer.concat([Buffer.from([0x0b, ...length]), bytes]);
}

function fixture(version = 20260904, frames = Buffer.from("deliberately not an LZMA stream"), player = "玩家".repeat(80), mapHash = "a".repeat(32)) {
  const prefix = Buffer.alloc(5); prefix.writeInt32LE(version, 1);
  const score = Buffer.alloc(23);
  [600, 12, 4, 0, 0, 2].forEach((value, index) => score.writeUInt16LE(value, index * 2));
  score.writeInt32LE(123456789, 12); score.writeUInt16LE(701, 16); score[18] = 0; score.writeUInt32LE(64, 19);
  const timing = Buffer.alloc(12);
  timing.writeBigInt64LE(BigInt("638961337234567891")); timing.writeInt32LE(frames.length, 8);
  const header = Buffer.concat([prefix, text(mapHash), text(player), text("b".repeat(32)), score, text("0|1,1000|1,"), timing]);
  return { header, bytes: Buffer.concat([header, frames, Buffer.alloc(8)]) };
}

it("reads only saved fields with exact ticks and UTF-8 byte lengths; does not decode frames", () => {
  const { bytes, header } = fixture();
  expect(parseReplayHeader(bytes)).toEqual({
    mode: 0, version: 20260904, beatmapMD5: "a".repeat(32), player: "玩家".repeat(80), replayMD5: "b".repeat(32),
    counts: { great: 600, ok: 12, meh: 4, geki: 0, katu: 0, miss: 2 }, score: 123456789, maxCombo: 701,
    perfectComboFlag: false, modsBitmask: 64, playedAtTicks: "638961337234567891",
    compressedFrames: { offset: header.length, length: bytes.length - header.length - 8 }, sourceFormat: "stable", nativeScoreInfo: false,
  });
});

it("preserves encoded leading U+FEFF in names and rejects it in an MD5", () => {
  expect(parseReplayHeader(fixture(20260904, Buffer.alloc(0), "\ufeffPlayer").bytes).player).toBe("\ufeffPlayer");
  expect(() => parseReplayHeader(fixture(20260904, Buffer.alloc(0), "P", "\ufeff" + "a".repeat(32)).bytes)).toThrow(/MD5/);
});

it("allows a bounded header prefix with known file size, without requiring frame bytes in memory", () => {
  const { header, bytes } = fixture();
  expect(parseReplayHeader(header, bytes.length).compressedFrames.offset).toBe(header.length);
  expect(() => parseReplayHeader(header)).toThrow(/truncated/i);
});

it("does not mistake native header mod bits for authoritative native mod settings", () => {
  expect(parseReplayHeader(fixture(30000016).bytes).nativeScoreInfo).toBe(true);
  expect(parseReplayHeader(fixture(30000016).bytes)).not.toHaveProperty("lazerMods");
});

it.each([[29999999, "stable", false], [30000000, "lazer", false], [30000001, "lazer", true]])(
  "separates source format from native metadata presence (%s)", (version, sourceFormat, nativeScoreInfo) => {
    expect(parseReplayHeader(fixture(Number(version)).bytes)).toMatchObject({ sourceFormat, nativeScoreInfo });
  },
);

it("rejects every truncated header prefix", () => {
  const { header, bytes } = fixture();
  for (let length = 0; length < header.length; length++)
    expect(() => parseReplayHeader(header.subarray(0, length), bytes.length)).toThrow();
});

it("rejects invalid modes, string markers, lengths and boolean evidence", () => {
  const { bytes, header } = fixture();
  for (const [offset, value] of [[0, 4], [5, 1], [header.length - 12 - text("0|1,1000|1,").length - 5, 2]]) {
    const changed = Buffer.from(bytes); changed[offset] = value;
    expect(() => parseReplayHeader(changed)).toThrow();
  }
  const overflow = Buffer.concat([bytes.subarray(0, 5), Buffer.from([11, 255, 255, 255, 255, 255, 1])]);
  expect(() => parseReplayHeader(overflow)).toThrow();
  const negative = Buffer.from(bytes); negative.writeInt32LE(-2, header.length - 4);
  expect(() => parseReplayHeader(negative)).toThrow();
});

it("reads an actual file through the bounded file API and retains the original bytes", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hindsight-header-test-"));
  const file = join(folder, "source.osr");
  const { bytes } = fixture();
  try {
    await writeFile(file, bytes);
    expect(await readReplayHeader(file)).toEqual(parseReplayHeader(bytes));
    const cancelled = new AbortController(); cancelled.abort();
    await expect(readReplayHeader(file, cancelled.signal)).rejects.toThrow(/abort/i);
  } finally { await rm(file); await rmdir(folder); }
});

it("preserves canonical null/empty frame blocks and signed fields without claiming completion", () => {
  const { bytes, header } = fixture();
  const changed = Buffer.from(bytes);
  changed.writeInt32LE(-1, header.length - 4);
  expect(parseReplayHeader(changed).compressedFrames.length).toBeNull();
  changed.writeInt32LE(0, header.length - 4);
  expect(parseReplayHeader(changed).compressedFrames.length).toBe(0);
  const fixed = 5 + text("a".repeat(32)).length + text("玩家".repeat(80)).length + text("b".repeat(32)).length;
  changed.writeUInt16LE(65535, fixed); changed.writeUInt16LE(65535, fixed + 16);
  changed.writeInt32LE(-2147483648, fixed + 12); changed.writeInt32LE(-2147483648, fixed + 19);
  expect(parseReplayHeader(changed)).toMatchObject({ counts: { great: 65535 }, maxCombo: 65535, score: -2147483648, modsBitmask: -2147483648 });
  expect(parseReplayHeader(changed)).not.toHaveProperty("completed");
  expect(parseReplayHeader(changed)).not.toHaveProperty("fc");
});

it("preserves tick differences below one millisecond and rejects out-of-range timestamps", () => {
  const { bytes, header } = fixture();
  const changed = Buffer.from(bytes);
  changed.writeBigInt64LE(BigInt("638961337234567892"), header.length - 12);
  expect(parseReplayHeader(changed).playedAtTicks).toBe("638961337234567892");
  for (const ticks of [BigInt(-1), BigInt("3155378976000000000")]) {
    changed.writeBigInt64LE(ticks, header.length - 12);
    expect(() => parseReplayHeader(changed)).toThrow(/timestamp/);
  }
});
