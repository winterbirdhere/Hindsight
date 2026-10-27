import { parseReplayFramesWithDiagnosticsAsync } from "@osujs/core";
import type { LibraryReplayData } from "../../../../../shared/library-replay-data";
import { isLosslessLibraryJson } from "../../../../../shared/library-json";
import type { OsuReplay } from "../../model/OsuReplay";
import { replayFromLibrarySource } from "./library-replay-converter";

const MiB = 1024 * 1024;
const kinds = ["frames", "frameSources", "skippedTokens", "lifeBar", "savedRows", "savedGroups"] as const;
type BatchKind = typeof kinds[number];
const limits: Record<BatchKind, number> = { frames: 1000000, frameSources: 1000000, skippedTokens: 100000,
  lifeBar: 100000, savedRows: 250000, savedGroups: 250000 };
export interface LibraryReplayHead { replay: OsuReplay; counts: Record<BatchKind, number> }
export interface LibraryReplayBatch { kind: BatchKind; offset: number; items: unknown[] }
const checkpoint = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function arrays(replay: OsuReplay): Record<BatchKind, readonly unknown[]> {
  return { frames: replay.frames, frameSources: replay.parseDiagnostics?.frameSources ?? [],
    skippedTokens: replay.parseDiagnostics?.skippedTokens ?? [], lifeBar: replay.lifeBar ?? [],
    savedRows: replay.savedScoreSource?.timeline?.rows ?? [], savedGroups: replay.savedScoreSource?.timeline?.groups ?? [] };
}

function emptyArrays(replay: OsuReplay): OsuReplay {
  return { ...replay, frames: [], lifeBar: [],
    parseDiagnostics: replay.parseDiagnostics && { ...replay.parseDiagnostics, frameSources: [], skippedTokens: [] },
    savedScoreSource: replay.savedScoreSource && { ...replay.savedScoreSource,
      timeline: replay.savedScoreSource.timeline && { ...replay.savedScoreSource.timeline, rows: [], groups: [] } } };
}

function wireData(value: unknown): LibraryReplayData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid replay wire data");
  const data = value as LibraryReplayData;
  if (![data.lazerMods, data.lazerScoreInfo, data.nativeSource?.mods].every(isLosslessLibraryJson))
    throw new Error("Invalid replay wire metadata");
  if (data.gameMode !== 0 || !Number.isSafeInteger(data.gameVersion) ||
      typeof data.replay_data !== "string" || data.replay_data.length > 32 * MiB ||
      typeof data.beatmapMD5 !== "string" || !/^[a-f0-9]{32}$/i.test(data.beatmapMD5) ||
      typeof data.replayContentSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(data.replayContentSha256) ||
      typeof data.replayMD5 !== "string" || data.replayMD5.length > 256 ||
      typeof data.playerName !== "string" || data.playerName.length > 65536 ||
      (data.life_bar !== undefined && (typeof data.life_bar !== "string" || data.life_bar.length > MiB)) ||
      (data.timestamp !== undefined && (typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp))) ||
      ![data.number_300s, data.number_100s, data.number_50s, data.misses, data.max_combo]
        .every(item => Number.isSafeInteger(item) && item >= 0) ||
      ![data.score, data.mods].every(item => Number.isInteger(item) && item >= -2147483648 && item <= 2147483647) ||
      ![0, 1].includes(data.perfect_combo)) throw new Error("Invalid replay wire data");
  if (data.lazerMods !== undefined && (!Array.isArray(data.lazerMods) || data.lazerMods.some(mod =>
      !mod || typeof mod.acronym !== "string" || !mod.acronym.trim() ||
      (mod.settings !== undefined && (!mod.settings || typeof mod.settings !== "object" || Array.isArray(mod.settings))))))
    throw new Error("Invalid replay wire mods");
  if (data.nativeSource && (typeof data.nativeSource.isLegacyScore !== "boolean" ||
      typeof data.nativeSource.scoreId !== "string" || data.nativeSource.scoreId.length > 128 ||
      typeof data.nativeSource.schemaFingerprint !== "string" || data.nativeSource.schemaFingerprint.length > 256))
    throw new Error("Invalid replay wire native source");
  const timeline = data.savedScoreSource?.timeline;
  if (timeline && (!Array.isArray(timeline.rows) || !Array.isArray(timeline.groups) ||
      timeline.rows.length > limits.savedRows || timeline.groups.length > limits.savedGroups))
    throw new Error("Invalid replay wire saved timeline");
  return data;
}

/** Lives in the foreground parser worker. Neither JSON assembly nor frame parsing runs in the renderer. */
export class LibraryReplayParser {
  private input?: Uint8Array;
  private offset = 0;
  private state: "receiving" | "parsing" | "ready" | "released" = "receiving";
  private output?: Record<BatchKind, unknown[]>;
  private kindIndex = 0;
  private batchOffset = 0;
  constructor(totalBytes: number) {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > 64 * MiB)
      throw new Error("Replay envelope byte limit exceeded");
    this.input = new Uint8Array(totalBytes);
  }
  append(offset: number, bytes: Uint8Array): void {
    if (this.state !== "receiving" || !this.input) throw new Error("Replay parser is not receiving");
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 256 * 1024) throw new Error("Invalid replay chunk");
    if (offset !== this.offset || offset + bytes.length > this.input.length) throw new Error("Invalid replay offset");
    this.input.set(bytes, offset); this.offset += bytes.length;
  }
  async finish(signal: AbortSignal, yieldControl = checkpoint): Promise<LibraryReplayHead> {
    if (this.state !== "receiving" || !this.input || this.offset !== this.input.length)
      throw new Error("Replay input is incomplete or released");
    this.state = "parsing";
    try {
      signal.throwIfAborted();
      const data = wireData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.input)));
      this.input = undefined;
      await yieldControl(); signal.throwIfAborted();
      const parsed = await parseReplayFramesWithDiagnosticsAsync(data.replay_data, { signal, maxRawLength: 32 * MiB,
        maxTokenLength: 4096, maxTokens: 1100000, maxFrames: limits.frames, maxSkippedTokens: limits.skippedTokens }, yieldControl);
      const replay = replayFromLibrarySource(data, parsed), output = arrays(replay);
      const counts = Object.fromEntries(kinds.map(kind => [kind, output[kind].length])) as Record<BatchKind, number>;
      for (const kind of kinds) if (counts[kind] > limits[kind]) throw new Error("Replay result limit exceeded");
      const head = { replay: emptyArrays(replay), counts };
      if (new TextEncoder().encode(JSON.stringify(head)).length > 2 * MiB) throw new Error("Replay metadata limit exceeded");
      await yieldControl(); signal.throwIfAborted();
      this.output = output as Record<BatchKind, unknown[]>; this.state = "ready";
      return head;
    } catch (error) { this.release(); throw error; }
    finally { this.input = undefined; }
  }
  takeBatch(): LibraryReplayBatch | null {
    if (this.state !== "ready" || !this.output) throw new Error("Replay parser is not ready or released");
    while (this.kindIndex < kinds.length) {
      const kind = kinds[this.kindIndex], entries = this.output[kind];
      if (this.batchOffset === entries.length) { this.output[kind] = []; this.kindIndex++; this.batchOffset = 0; continue; }
      const offset = this.batchOffset, items = entries.slice(offset, offset + 512);
      entries.fill(undefined, offset, offset + items.length); this.batchOffset += items.length;
      return { kind, offset, items };
    }
    return null;
  }
  release(): void { this.input = undefined; this.output = undefined; this.state = "released"; }
}

/** Receives one bounded result at a time; never reparses, regroups or rounds replay frames. */
export class LibraryReplayAssembler {
  private readonly replay: OsuReplay;
  private readonly output: Record<BatchKind, unknown[]>;
  private readonly counts: Record<BatchKind, number>;
  private kindIndex = 0;
  private finished = false;
  constructor(head: LibraryReplayHead) {
    this.counts = { ...head.counts };
    for (const kind of kinds) if (!Number.isSafeInteger(this.counts[kind]) || this.counts[kind] < 0 || this.counts[kind] > limits[kind])
      throw new Error("Invalid replay batch count");
    if (this.counts.frames !== this.counts.frameSources) throw new Error("Invalid frame source count");
    this.replay = emptyArrays(head.replay); this.output = arrays(this.replay) as Record<BatchKind, unknown[]>;
    if ((this.counts.savedRows || this.counts.savedGroups) && !this.replay.savedScoreSource?.timeline)
      throw new Error("Missing replay saved timeline");
  }
  append(batch: LibraryReplayBatch): void {
    if (this.finished) throw new Error("Replay assembler released");
    while (this.kindIndex < kinds.length && this.output[kinds[this.kindIndex]].length === this.counts[kinds[this.kindIndex]]) this.kindIndex++;
    if (batch.kind !== kinds[this.kindIndex] || batch.offset !== this.output[batch.kind]?.length)
      throw new Error("Invalid replay batch offset or kind");
    if (!Array.isArray(batch.items) || !batch.items.length || batch.items.length > 512 ||
        batch.offset + batch.items.length > this.counts[batch.kind]) throw new Error("Invalid replay batch size");
    this.output[batch.kind].push(...batch.items);
  }
  finish(): OsuReplay {
    if (this.finished) throw new Error("Replay assembler released");
    if (kinds.some(kind => this.output[kind].length !== this.counts[kind])) throw new Error("Replay result is incomplete");
    this.finished = true; return this.replay;
  }
}
