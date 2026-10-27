import { TextDecoder, TextEncoder } from "util";
import { LibraryReplayParser, LibraryReplayAssembler } from "./library-replay-parser";
import type { LibraryReplayData } from "../../../../../shared/library-replay-data";

Object.assign(globalThis, { TextDecoder, TextEncoder });
const input: LibraryReplayData = { gameMode: 0, gameVersion: 20260101, beatmapMD5: "a".repeat(32), playerName: "Fixture",
  replayMD5: "hash", replayContentSha256: "b".repeat(64), number_300s: 1, number_100s: 0, number_50s: 0,
  misses: 0, score: 300, max_combo: 1, perfect_combo: 1, mods: 0, life_bar: "100|1,", timestamp: 1700000000000,
  replay_data: "0|256|-500|0,-1|256|-500|0," + "1|10|20|1,0|12|20|0,".repeat(1200) };
const encoded = () => new Uint8Array(Buffer.from(JSON.stringify(input)));

it("assembles input and publishes bounded result batches with exact frame/diagnostic order", async () => {
  const bytes = encoded(), parser = new LibraryReplayParser(bytes.length);
  for (let offset = 0; offset < bytes.length; offset += 256) parser.append(offset, bytes.slice(offset, offset + 256));
  const head = await parser.finish(new AbortController().signal, async () => undefined);
  expect(head.replay.frames).toEqual([]); expect(head.counts.frames).toBe(2400);
  const assembler = new LibraryReplayAssembler(head);
  let count = 0;
  for (;;) {
    const batch = parser.takeBatch(); if (!batch) break;
    expect(batch.items.length).toBeLessThanOrEqual(512); assembler.append(batch); count++;
  }
  const replay = assembler.finish();
  expect(count).toBeGreaterThan(8); expect(replay.frames).toHaveLength(2400);
  expect(replay.frames[0]).toMatchObject({ time: 0, position: { x: 10, y: 20 } });
  expect(replay.frames[1]).toMatchObject({ time: 0, position: { x: 12, y: 20 }, actions: [] });
  expect(replay.parseDiagnostics?.frameSources[2399].rawTokenIndex).toBe(2401);
  expect(replay.lifeBar).toEqual([{ time: 100, health: 1 }]);
  expect(replay.timestamp).toBe(1700000000000);
});

it("rejects oversized, out-of-order and incomplete input without producing a replay", async () => {
  expect(() => new LibraryReplayParser(64 * 1024 * 1024 + 1)).toThrow(/limit/i);
  const parser = new LibraryReplayParser(10);
  expect(() => parser.append(1, new Uint8Array([1]))).toThrow(/offset/i);
  expect(() => parser.append(0, new Uint8Array(256 * 1024 + 1))).toThrow(/chunk/i);
  parser.append(0, new Uint8Array([1]));
  await expect(parser.finish(new AbortController().signal, async () => undefined)).rejects.toThrow(/incomplete/i);
});

it("does not publish after cancellation or accept malformed wire data", async () => {
  const controller = new AbortController(), bytes = encoded(), parser = new LibraryReplayParser(bytes.length);
  parser.append(0, bytes);
  await expect(parser.finish(controller.signal, async () => { controller.abort(); })).rejects.toThrow(/abort/i);
  expect(() => parser.takeBatch()).toThrow(/ready|released/i);
  const invalid = new Uint8Array(Buffer.from(JSON.stringify({ ...input, timestamp: "2023-11-14" })));
  const bad = new LibraryReplayParser(invalid.length); bad.append(0, invalid);
  await expect(bad.finish(new AbortController().signal)).rejects.toThrow(/wire/i);
});

it("refuses duplicate or missing result batches", async () => {
  const bytes = encoded(), parser = new LibraryReplayParser(bytes.length); parser.append(0, bytes);
  const head = await parser.finish(new AbortController().signal, async () => undefined);
  const assembler = new LibraryReplayAssembler(head), batch = parser.takeBatch()!;
  expect(() => assembler.finish()).toThrow(/incomplete/i);
  assembler.append(batch); expect(() => assembler.append(batch)).toThrow(/offset/i);
});

it("preserves signed Int32 score and legacy mod bitfields from the canonical container reader", async () => {
  const bytes = new Uint8Array(Buffer.from(JSON.stringify({ ...input, score: -2147483648, mods: -2147483648 })));
  const parser = new LibraryReplayParser(bytes.length); parser.append(0, bytes);
  const head = await parser.finish(new AbortController().signal, async () => undefined);
  expect(head.replay.statistics?.score).toBe(-2147483648);
});

it("rejects overflowing native numbers rather than converting them to null or default settings", async () => {
  const raw = JSON.stringify({ ...input, lazerMods: [{ acronym: "DT", settings: { speed_change: 123456789 } }] }).replace("123456789", "1e999");
  const bytes = new Uint8Array(Buffer.from(raw)), parser = new LibraryReplayParser(bytes.length); parser.append(0, bytes);
  await expect(parser.finish(new AbortController().signal, async () => undefined)).rejects.toThrow(/metadata/i);
});

it("retains optional saved timelines within the existing 250k-row loader limit", async () => {
  const row = { time: 0, playerByte: 0, counts: [0, 0, 0, 0, 0, 0], score: 0, maximumCombo: 0, combo: 0, trailingBytes: [0, 0, 0] };
  const savedScoreSource = { status: "validated", attempts: [], timeline: { schema: "stable-saved-score-v1",
    provenance: { timelineSha256: "c".repeat(64), pairedReplaySha256: "b".repeat(64), mapMd5: "a".repeat(32), version: 1 },
    rows: Array.from({ length: 100001 }, (_, index) => ({ ...row, time: index })), groups: [] } };
  const bytes = new Uint8Array(Buffer.from(JSON.stringify({ ...input, savedScoreSource })));
  const parser = new LibraryReplayParser(bytes.length);
  for (let offset = 0; offset < bytes.length; offset += 256 * 1024) parser.append(offset, bytes.slice(offset, offset + 256 * 1024));
  const assembler = new LibraryReplayAssembler(await parser.finish(new AbortController().signal, async () => undefined));
  for (;;) { const batch = parser.takeBatch(); if (!batch) break; assembler.append(batch); }
  const saved = assembler.finish().savedScoreSource;
  expect(saved?.timeline?.rows).toHaveLength(100001); expect(saved?.timeline?.rows.at(-1)?.time).toBe(100000);
  expect(saved?.timeline?.provenance).toEqual(savedScoreSource.timeline.provenance);
});
