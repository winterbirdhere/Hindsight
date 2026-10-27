import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import { read as readLegacy, readSync as readLegacySync, Replay } from "node-osr";
import type { LazerMod } from "@osujs/core";
import * as lzma from "lzma";
import { TextDecoder } from "util";
import { parseReplayHeader, ReplayHeader } from "./header";

export { parseReplayHeader, readReplayHeader } from "./header";
export type { ReplayHeader } from "./header";

// node-osr handles the legacy header/frame stream, but stops before lazer's
// additional score data. Preserve its constructor and legacy serialization.
export const OsrReplay = Replay;

export interface LazerReplayScoreInfo {
  mods: readonly LazerMod[];
  [key: string]: unknown;
}

export interface OsrReplay extends Replay {
  lazerMods?: readonly LazerMod[];
  lazerScoreInfo?: LazerReplayScoreInfo;
}

export type ReplayBlockDecoder = (bytes: Buffer, request: {
  role: "frames" | "score-info"; maxOutputBytes: number; signal?: AbortSignal;
}) => Promise<Uint8Array>;

function boundedScoreInfoBlock(buffer:Buffer,header:ReplayHeader):Buffer|undefined {
  const scoreIdOffset=header.compressedFrames.offset+(header.compressedFrames.length??0);
  if(buffer.length-scoreIdOffset<8)throw new Error("Truncated replay score ID");
  if(!header.nativeScoreInfo)return undefined;
  const sizeOffset=scoreIdOffset+8;
  if(buffer.length-sizeOffset<4)throw new Error("Truncated lazer replay score data");
  const size=buffer.readInt32LE(sizeOffset);
  if(size< -1)throw new Error("Invalid lazer replay score data length");
  if(size>1024*1024)throw new Error("Lazer replay metadata exceeds compressed size limit");
  if(size>buffer.length-sizeOffset-4)throw new Error("Truncated lazer replay score data");
  return size>0?buffer.subarray(sizeOffset+4,sizeOffset+4+size):undefined;
}

/** P metadata only. Validate container offsets, then decode only the bounded native trailer.
 * Never parses/decompresses frames or claims that a replay is playable or complete. */
export async function readScoreInfoWithDecompressor(buffer:Buffer,decode:ReplayBlockDecoder,
  options:{signal?:AbortSignal;maxScoreInfoBytes?:number}={}):Promise<LazerReplayScoreInfo|undefined> {
  const {signal}=options,max=options.maxScoreInfoBytes??8*1024*1024;
  if(!Number.isSafeInteger(max)||max<1||max>8*1024*1024)throw new Error("Invalid replay metadata expansion limit");
  signal?.throwIfAborted();const block=boundedScoreInfoBlock(buffer,parseReplayHeader(buffer));
  if(!block)return undefined;
  const decoded=await decode(block,{role:"score-info",maxOutputBytes:max,signal});signal?.throwIfAborted();
  if(!(decoded instanceof Uint8Array)||decoded.byteLength>max)throw new Error("Replay score-info exceeds expanded size limit");
  const result=parseScoreInfo(new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(decoded));signal?.throwIfAborted();return result;
}

/** Opt-in selected-replay path. The decoder must enforce its output limit while
 * streaming and drain cancellation before settling; this seam also checks the
 * returned bytes. Neither legacy reader nor its in-process LZMA decoder changes.
 * The caller owns immutable verified input bytes until this promise settles.
 */
export async function readWithDecompressor(
  buffer: Buffer, decode: ReplayBlockDecoder, options: { signal?: AbortSignal; maxFrameBytes?: number; maxScoreInfoBytes?: number } = {},
): Promise<OsrReplay> {
  const { signal } = options;
  const maxFrameBytes = options.maxFrameBytes ?? 256 * 1024 * 1024;
  const maxScoreInfoBytes = options.maxScoreInfoBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(maxScoreInfoBytes) || maxScoreInfoBytes < 1 || maxScoreInfoBytes > 8 * 1024 * 1024)
    throw new Error("Invalid replay expansion limit");
  signal?.throwIfAborted();
  const header = parseReplayHeader(buffer);
  const { offset, length } = header.compressedFrames;
  if (length === null || length === 0) throw new Error("Replay has no embedded frames");
  if (length > 64 * 1024 * 1024) throw new Error("Replay frames exceed compressed size limit");
  const scoreIdOffset = offset + length;
  const extraData=boundedScoreInfoBlock(buffer,header);

  // Feed only the bounded header and original score ID to the existing parser.
  // A zero frame length bypasses node-osr's synchronous decompressor entirely.
  const headerOnly = Buffer.alloc(offset + 8);
  buffer.copy(headerOnly, 0, 0, offset);
  headerOnly.writeInt32LE(0, offset - 4);
  buffer.copy(headerOnly, offset, scoreIdOffset, scoreIdOffset + 8);
  const replay = readLegacySync(headerOnly);
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const decodeText = async (data: Buffer, role: "frames" | "score-info", maxOutputBytes: number): Promise<string> => {
    signal?.throwIfAborted();
    const decoded = await decode(data, { role, maxOutputBytes, signal });
    signal?.throwIfAborted();
    if (!(decoded instanceof Uint8Array) || decoded.byteLength > maxOutputBytes)
      throw new Error(`Replay ${role} exceeds expanded size limit`);
    return utf8.decode(decoded);
  };
  replay.replay_data = await decodeText(buffer.subarray(offset, scoreIdOffset), "frames", maxFrameBytes);
  signal?.throwIfAborted();
  replay.replay_length = length;
  const scoreText = extraData ? await decodeText(extraData, "score-info", maxScoreInfoBytes) : undefined;
  signal?.throwIfAborted();
  const scoreInfo = scoreText !== undefined ? parseScoreInfo(scoreText) : undefined;
  return attachScoreInfo(replay, scoreInfo);
}

// LegacyScoreEncoder/LegacyScoreDecoder at osu! revision
// e0279920b64c738021b05f501941c8aa65e6b589: >= 30000001 stores an int32-length
// LZMA JSON byte array immediately after the legacy score ID (int64).
const FIRST_LAZER_SCORE_INFO_VERSION = 30_000_001;

function scoreInfoData(buffer: Buffer): Buffer | undefined {
  if (buffer.length < 5 || buffer.readInt32LE(1) < FIRST_LAZER_SCORE_INFO_VERSION) return undefined;
  let offset = 5;

  function skip(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - offset) {
      throw new Error("Truncated lazer replay score data");
    }
    offset += length;
  }

  function byte(): number {
    skip(1);
    return buffer[offset - 1];
  }

  function int32(): number {
    skip(4);
    return buffer.readInt32LE(offset - 4);
  }

  function skipString(): void {
    const marker = byte();
    if (marker === 0) return;
    if (marker !== 0x0b) throw new Error("Invalid string in lazer replay header");
    let length = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const value = byte();
      length += (value & 0x7f) * 2 ** shift;
      if ((value & 0x80) === 0) {
        skip(length);
        return;
      }
    }
    throw new Error("Invalid string length in lazer replay header");
  }

  skipString(); // beatmap MD5
  skipString(); // player
  skipString(); // replay MD5
  skip(12 + 4 + 2 + 1 + 4); // judgement counts, score, combo, perfect, mods
  skipString(); // life bar
  skip(8); // timestamp
  skip(int32()); // compressed legacy replay frames
  skip(8); // legacy score ID
  const length = int32();
  // SerializationWriter uses -1 for null; the official decoder also accepts
  // an empty byte array and retains the legacy fields in either case.
  if (length === -1 || length === 0) return undefined;
  const start = offset;
  skip(length);
  return buffer.subarray(start, offset);
}

function parseScoreInfo(decoded: string | Uint8Array | number[]): LazerReplayScoreInfo {
  const value: unknown = JSON.parse(typeof decoded === "string" ? decoded : Buffer.from(decoded).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid lazer replay score data");
  }
  const mods = (value as Record<string, unknown>).mods;
  if (
    !Array.isArray(mods) ||
    mods.some(
      (mod) =>
        !mod ||
        typeof mod !== "object" ||
        typeof mod.acronym !== "string" ||
        !mod.acronym.trim() ||
        (mod.settings !== undefined &&
          (mod.settings === null || typeof mod.settings !== "object" || Array.isArray(mod.settings))),
    )
  ) {
    throw new Error("Invalid lazer replay mod settings");
  }
  return value as LazerReplayScoreInfo;
}

function attachScoreInfo(replay: Replay, scoreInfo?: LazerReplayScoreInfo): OsrReplay {
  if (!scoreInfo) return replay;
  return Object.assign(replay, { lazerMods: scoreInfo.mods, lazerScoreInfo: scoreInfo });
}

export function readSync(input: string | Buffer): OsrReplay {
  const buffer = Buffer.isBuffer(input) ? input : readFileSync(input);
  const extraData = scoreInfoData(buffer);
  const scoreInfo = extraData ? parseScoreInfo(lzma.decompress(extraData)) : undefined;
  return attachScoreInfo(readLegacySync(buffer), scoreInfo);
}

async function readReplay(input: string | Buffer): Promise<OsrReplay> {
  const buffer = Buffer.isBuffer(input) ? input : await readFile(input);
  const extraData = scoreInfoData(buffer);
  const scoreInfo = extraData
    ? parseScoreInfo(
        await new Promise<string | Uint8Array>((resolve, reject) => {
          lzma.decompress(extraData, (result, error) => {
            if (error) reject(error);
            else resolve(result);
          });
        }),
      )
    : undefined;
  return attachScoreInfo(await readLegacy(buffer), scoreInfo);
}

export function read(input: string | Buffer): Promise<OsrReplay>;
export function read(input: string | Buffer, callback: (error: Error | null, replay?: OsrReplay) => unknown): void;
export function read(
  input: string | Buffer,
  callback?: (error: Error | null, replay?: OsrReplay) => unknown,
): Promise<OsrReplay> | void {
  const result = readReplay(input);
  if (!callback) return result;
  void result.then(
    (replay) => callback(null, replay),
    (error: Error) => callback(error),
  );
}
