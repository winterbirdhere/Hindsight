import { compress, decompress } from "lzma";
import { OsrReplay, readSync, readWithDecompressor, readScoreInfoWithDecompressor, ReplayBlockDecoder } from "./index";
import { parseReplayHeader } from "./header";

const frames = "0|256|192|0,1000|256|192|1,-12345|0|0|42,";
function fixture(version = 30_000_016): Buffer {
  const replay = new OsrReplay();
  Object.assign(replay, {
    gameVersion: version, beatmapMD5: "1234567890abcdef1234567890abcdef",
    playerName: "Player".repeat(30), replayMD5: "abcdef1234567890abcdef1234567890",
    mods: 64, number_300s: 3, max_combo: 3, replay_data: frames, unknown: 123456789,
  });
  return replay.serializeSync();
}
function trailer(value: unknown): Buffer {
  const data = Buffer.from(compress(JSON.stringify(value)));
  const size = Buffer.alloc(4);
  size.writeInt32LE(data.length);
  return Buffer.concat([size, data]);
}
const decode: ReplayBlockDecoder = async (bytes) => {
  const value = decompress(bytes);
  return typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
};

describe("bounded P-only native score metadata",()=>{
  it("skips even corrupt compressed frames and preserves authoritative empty mods and explicit statistics",async()=>{
    const bytes=Buffer.concat([fixture(),trailer({mods:[],statistics:{great:3,miss:0}})]),header=parseReplayHeader(bytes);
    bytes.fill(255,header.compressedFrames.offset,header.compressedFrames.offset+(header.compressedFrames.length??0));
    const roles:string[]=[];const metadata=await readScoreInfoWithDecompressor(bytes,async(data,request)=>{
      roles.push(request.role);expect(request.maxOutputBytes).toBe(1024);return decode(data,request);
    },{maxScoreInfoBytes:1024});
    expect(metadata).toEqual({mods:[],statistics:{great:3,miss:0}});expect(roles).toEqual(["score-info"]);
  });
  it.each([-1,0])("returns absent for absent metadata (%s), without inventing an empty native profile",async size=>{
    const marker=Buffer.alloc(4);marker.writeInt32LE(size);const forbidden=jest.fn();
    expect(await readScoreInfoWithDecompressor(Buffer.concat([fixture(),marker]),forbidden)).toBeUndefined();
    expect(await readScoreInfoWithDecompressor(fixture(20260101),forbidden)).toBeUndefined();expect(forbidden).not.toHaveBeenCalled();
  });
  it("validates trailer bounds before decoder admission",async()=>{
    const bytes=Buffer.concat([fixture(),trailer({mods:[]})]),forbidden=jest.fn();
    await expect(readScoreInfoWithDecompressor(bytes.subarray(0,bytes.length-1),forbidden)).rejects.toThrow(/Truncated/);
    const marker=Buffer.alloc(4);marker.writeInt32LE(1024*1024+1);
    await expect(readScoreInfoWithDecompressor(Buffer.concat([fixture(),marker]),forbidden)).rejects.toThrow(/compressed size/);
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("rejects invalid UTF-8, over-budget output and cancellation before metadata publication",async()=>{
    const bytes=Buffer.concat([fixture(),trailer({mods:[]})]);
    await expect(readScoreInfoWithDecompressor(bytes,async()=>Buffer.from([255]))).rejects.toThrow();
    await expect(readScoreInfoWithDecompressor(bytes,async()=>Buffer.alloc(17),{maxScoreInfoBytes:16})).rejects.toThrow(/expanded size/);
    const abort=new AbortController();await expect(readScoreInfoWithDecompressor(bytes,async(data,request)=>{
      expect(request.signal).toBe(abort.signal);abort.abort(new Error("stop"));return decode(data,request);
    },{signal:abort.signal})).rejects.toThrow("stop");
  });
});

describe("opt-in bounded replay decoder", () => {
  it("enforces a caller's tighter expansion budget before returning decoded data", async () => {
    const bytes = fixture(20_260_904);
    const roles: number[] = [];
    const observed: ReplayBlockDecoder = async (data, request) => { roles.push(request.maxOutputBytes); return decode(data, request); };
    await expect(readWithDecompressor(bytes, observed, { maxFrameBytes: 16 })).rejects.toThrow(/expanded size/i);
    expect(roles).toEqual([16]);
    await expect(readWithDecompressor(bytes, decode, { maxFrameBytes: 0 })).rejects.toThrow(/limit/i);
  });
  it("preserves legacy replay fields, score ID and native settings using the injected decoder", async () => {
    const info = { mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }], statistics: { great: 3 } };
    const bytes = Buffer.concat([fixture(), trailer(info)]);
    const original = Buffer.from(bytes);
    const replay = await readWithDecompressor(bytes, decode);
    expect(replay).toEqual(readSync(bytes));
    expect(replay.replay_data).toBe(frames);
    expect(replay).toHaveProperty("unknown", 123456789);
    expect(replay.lazerScoreInfo).toEqual(info);
    expect(bytes).toEqual(original);
  });

  it.each([20_260_904, 30_000_000])("keeps the legacy format for version %i", async (version) => {
    const bytes = fixture(version);
    expect(await readWithDecompressor(bytes, decode)).toEqual(readSync(bytes));
  });

  it.each([-1, 0])("retains legacy fields for null/empty native metadata (%i)", async (length) => {
    const marker = Buffer.alloc(4);
    marker.writeInt32LE(length);
    const replay = await readWithDecompressor(Buffer.concat([fixture(), marker]), decode);
    expect(replay.replay_data).toBe(frames);
    expect(replay.lazerMods).toBeUndefined();
  });

  it("validates the complete container before admitting expensive decompression", async () => {
    const bytes = Buffer.concat([fixture(), trailer({ mods: [] })]);
    const forbidden: ReplayBlockDecoder = async () => { throw new Error("decoder unexpectedly reached"); };
    await expect(readWithDecompressor(bytes.subarray(0, bytes.length - 1), forbidden)).rejects.toThrow("Truncated");
    await expect(readWithDecompressor(fixture().subarray(0, fixture().length - 1), forbidden)).rejects.toThrow("score ID");
    const invalid = Buffer.alloc(4); invalid.writeInt32LE(-2);
    await expect(readWithDecompressor(Buffer.concat([fixture(), invalid]), forbidden)).rejects.toThrow("length");
  });

  it("does not pretend a replay with absent frames is playable", async () => {
    const bytes = fixture(20_260_904);
    const { offset, length } = parseReplayHeader(bytes).compressedFrames;
    const empty = Buffer.concat([bytes.subarray(0, offset), bytes.subarray(offset + (length ?? 0))]);
    for (const value of [0, -1]) {
      empty.writeInt32LE(value, offset - 4);
      await expect(readWithDecompressor(empty, decode)).rejects.toThrow("no embedded frames");
    }
  });

  it("rejects expanded metadata above its role limit before parsing JSON", async () => {
    const bytes = Buffer.concat([fixture(), trailer({ mods: [] })]);
    const oversized: ReplayBlockDecoder = async (data, request) => request.role === "frames"
      ? decode(data, request) : Buffer.alloc(request.maxOutputBytes + 1, 32);
    await expect(readWithDecompressor(bytes, oversized)).rejects.toThrow("expanded size");
  });

  it("rejects malformed native metadata and invalid UTF-8 rather than silently losing settings", async () => {
    await expect(readWithDecompressor(Buffer.concat([fixture(), trailer({ mods: [null] })]), decode))
      .rejects.toThrow("Invalid lazer replay mod settings");
    await expect(readWithDecompressor(fixture(20_260_904), async () => Buffer.from([0xff])))
      .rejects.toThrow();
  });

  it("propagates cancellation to the decoder and rejects a late result", async () => {
    const controller = new AbortController();
    const late: ReplayBlockDecoder = async (data, request) => {
      expect(request.signal).toBe(controller.signal);
      controller.abort(new Error("selection replaced"));
      return decode(data, request);
    };
    await expect(readWithDecompressor(fixture(20_260_904), late, { signal: controller.signal }))
      .rejects.toThrow("selection replaced");
    await expect(readWithDecompressor(fixture(20_260_904), decode, { signal: controller.signal }))
      .rejects.toThrow("selection replaced");
  });

  it("rejects cancellation between decoded-text completion and replay publication", async () => {
    const controller = new AbortController();
    const boundary: ReplayBlockDecoder = async () => {
      queueMicrotask(() => queueMicrotask(() => controller.abort(new Error("publication cancelled"))));
      return Buffer.from(frames);
    };
    await expect(readWithDecompressor(fixture(20_260_904), boundary, { signal: controller.signal }))
      .rejects.toThrow("publication cancelled");
  });
});
