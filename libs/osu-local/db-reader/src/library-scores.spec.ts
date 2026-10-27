import { parseLibraryScores, parseLibraryScoreEvents } from "./library-scores";

const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const i64 = (n: string) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const str = (s: string) => s ? Buffer.concat([Buffer.from([11, Buffer.byteLength(s)]), Buffer.from(s)]) : Buffer.from([0]);
const md5 = "a".repeat(32);
function score(options: { version?: number; mods?: number; empty?: string; sentinel?: number } = {}) {
  const fixed = Buffer.alloc(19); fixed.writeUInt16LE(500, 0); fixed.writeUInt16LE(7, 10); fixed.writeInt32LE(-42, 12); fixed.writeUInt16LE(400, 16);
  const tp = Buffer.alloc(8); tp.writeDoubleLE(1.5);
  return Buffer.concat([Buffer.from([0]), i32(options.version ?? 20260904), str(md5), str("Player"), str("saved-hash"), fixed,
    i32(options.mods ?? 0), str(options.empty ?? ""), i64("638961337234567891"), i32(options.sentinel ?? -1), i64("9007199254740993"),
    options.mods === (1 << 23) ? tp : Buffer.alloc(0)]);
}
function db(rows: Buffer[], version = 20260904) { return Buffer.concat([i32(version), i32(1), str(md5), i32(rows.length), ...rows]); }

it("projects exact saved metadata with signed score/mods and a fixed 64-bit online ID even for old replay versions", () => {
  const rows = [...parseLibraryScores(db([score({ version: 20100101, mods: -2147483648 })]))];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ databaseVersion: 20260904, header: { version: 20100101, beatmapMD5: md5, player: "Player",
    score: -42, counts: { great: 500, miss: 7 }, maxCombo: 400, playedAtTicks: "638961337234567891", modsBitmask: -2147483648 }, onlineId: "9007199254740993", targetPractice: null });
});

it("consumes TP data without shifting the following ordinary score and keys rows independently of position", () => {
  const rows = [...parseLibraryScores(db([score({ mods: 1 << 23 }), score()]))];
  expect(rows.map(row => row.targetPractice)).toEqual([1.5, null]);
  expect(rows[1].sourceKey).toBe([...parseLibraryScores(db([score()]))][0].sourceKey);
});

it.each([score({ empty: "unexpected" }), score({ sentinel: 0 }), score().subarray(0, -1)])("rejects malformed score framing rather than guessing the next record", row => {
  expect(() => [...parseLibraryScores(db([row]))]).toThrow();
});

it("rejects unsupported versions, excessive counts and trailing data", () => {
  expect(() => [...parseLibraryScores(db([], 30000000))]).toThrow(/version/i);
  expect(() => [...parseLibraryScores(Buffer.concat([i32(20260904), i32(0x7fffffff)]))]).toThrow(/count|limit/i);
  expect(() => [...parseLibraryScores(Buffer.concat([db([score()]), Buffer.from([1])]))]).toThrow(/trailing/i);
});

it("provides progress boundaries through empty groups so scans can yield and cancel", () => {
  const empty = Buffer.concat([str(md5), i32(0)]);
  const bytes = Buffer.concat([i32(20260904), i32(1024), ...Array.from({ length: 1024 }, () => empty)]);
  const events = [...parseLibraryScoreEvents(bytes)];
  expect(events.length).toBeGreaterThanOrEqual(4);
  expect(events.every(event => event === null)).toBe(true);
  expect([...parseLibraryScores(bytes)]).toEqual([]);
});
