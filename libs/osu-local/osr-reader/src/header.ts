import { open } from "fs/promises";
import { TextDecoder } from "util";

const MAX_HEADER_BYTES = 256 * 1024;
const MAX_REPLAY_BYTES = 512 * 1024 * 1024;
const MAX_STRING_BYTES = 128 * 1024;
const LAST_DOTNET_TICK = BigInt("3155378975999999999");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface ReplayHeader {
  mode: number;
  version: number;
  beatmapMD5: string;
  player: string;
  replayMD5: string;
  counts: { great: number; ok: number; meh: number; geki: number; katu: number; miss: number };
  score: number;
  maxCombo: number;
  perfectComboFlag: boolean;
  modsBitmask: number;
  playedAtTicks: string;
  compressedFrames: { offset: number; length: number | null };
  sourceFormat: "stable" | "lazer";
  /** Whether this format has native metadata. Legacy header fields are provisional for lazer. */
  nativeScoreInfo: boolean;
}

class HeaderError extends Error {
  constructor(message: string, readonly needsMoreHeader = false) { super(message); }
}

/** Saved header projection only: no frame decoding, trailer parsing, completion or FC inference.
 * Native >=30000000 needs source/trailer metadata before exact statistics/mod settings are usable.
 * `fileSize` allows a bounded prefix; the caller must bind observations to a later content hash.
 */
export function parseReplayHeader(bytes: Buffer, fileSize = bytes.length): ReplayHeader {
  if (!Number.isSafeInteger(fileSize) || fileSize < bytes.length || fileSize > MAX_REPLAY_BYTES)
    throw new HeaderError("Invalid replay size");
  let offset = 0;
  const take = (length: number): number => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > MAX_HEADER_BYTES)
      throw new HeaderError("Replay header exceeds limit");
    if (offset + length > bytes.length) throw new HeaderError("Truncated replay header", true);
    const start = offset;
    offset += length;
    return start;
  };
  const byte = () => bytes[take(1)];
  const uint16 = () => bytes.readUInt16LE(take(2));
  const int32 = () => bytes.readInt32LE(take(4));
  const string = (): string => {
    const marker = byte();
    if (marker === 0) return "";
    if (marker !== 11) throw new HeaderError("Invalid replay string marker");
    let length = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const part = byte();
      length += (part & 127) * 2 ** shift;
      if (length > MAX_STRING_BYTES) throw new HeaderError("Replay string exceeds limit");
      if (part < 128) {
        const start = take(length);
        return utf8.decode(bytes.subarray(start, start + length));
      }
    }
    throw new HeaderError("Invalid replay string length");
  };
  const mode = byte();
  const version = int32();
  if (mode > 3 || version < 0) throw new HeaderError("Invalid replay mode/version");
  const beatmapMD5 = string();
  if (!/^[a-f\d]{32}$/i.test(beatmapMD5)) throw new HeaderError("Invalid beatmap MD5");
  const player = string();
  const replayMD5 = string();
  const counts = { great: uint16(), ok: uint16(), meh: uint16(), geki: uint16(), katu: uint16(), miss: uint16() };
  const score = int32();
  const maxCombo = uint16();
  const perfect = byte();
  if (perfect > 1) throw new HeaderError("Invalid replay perfect-combo flag");
  const modsBitmask = int32();
  string(); // Life-bar samples are not completion proof, and are not retained in the library index.
  const ticks = bytes.readBigInt64LE(take(8));
  if (ticks < BigInt(0) || ticks > LAST_DOTNET_TICK) throw new HeaderError("Invalid replay timestamp");
  const length = int32();
  // The legacy reader accepts any negative as null. Accept only its canonical -1 sentinel.
  if (length < -1) throw new HeaderError("Invalid compressed replay length");
  if (length > fileSize - offset) throw new HeaderError("Truncated compressed replay payload");
  return {
    mode, version, beatmapMD5: beatmapMD5.toLowerCase(), player, replayMD5, counts, score, maxCombo,
    perfectComboFlag: perfect === 1, modsBitmask, playedAtTicks: ticks.toString(),
    compressedFrames: { offset, length: length < 0 ? null : length },
    sourceFormat: version >= 30_000_000 ? "lazer" : "stable", nativeScoreInfo: version >= 30_000_001,
  };
}

/** Reads at most a bounded header, through one handle; never reads/decompresses frame payloads on purpose. */
export async function readReplayHeader(path: string, signal?: AbortSignal): Promise<ReplayHeader> {
  signal?.throwIfAborted();
  const file = await open(path, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_REPLAY_BYTES)) throw new HeaderError("Invalid replay size");
    const size = Number(before.size);
    const prefix = Buffer.alloc(Math.min(size, MAX_HEADER_BYTES));
    let filled = 0;
    let target = Math.min(1024, prefix.length);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(prefix, filled, target - filled, filled);
      filled += bytesRead;
      try {
        const header = parseReplayHeader(prefix.subarray(0, filled), size);
        const after = await file.stat({ bigint: true });
        signal?.throwIfAborted();
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
          throw new HeaderError("Replay changed while reading header");
        return header;
      } catch (error) {
        if (!(error instanceof HeaderError) || !error.needsMoreHeader || filled === prefix.length || bytesRead === 0) throw error;
        target = Math.min(prefix.length, Math.max(target * 2, filled + 1024));
      }
    }
  } finally { await file.close(); }
}
