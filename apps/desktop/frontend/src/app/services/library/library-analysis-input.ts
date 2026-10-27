import { buildBeatmap, parseBlueprint } from "@osujs/core";
import type { LibraryResourceChunk } from "../../../../../shared/library-resources";
import { LibraryReplayAssembler, LibraryReplayParser } from "./library-replay-parser";
import type { LibraryNumericalResourceInput } from "../../../../../shared/library-analysis";
export type { LibraryNumericalResourceInput } from "../../../../../shared/library-analysis";
/** Settlement confirms the read has drained, including when cancellation is requested. */
export type LibraryAnalysisChunkReader = (kind: "replay" | "map", offset: number, signal: AbortSignal) => Promise<LibraryResourceChunk>;
const MiB = 1024 * 1024;

/** Runs only inside the library worker. Transport delivers bounded bytes, never parsed frames to UI.
 * JSON/map parsing and map construction remain synchronous spans requiring measured yield QA. */
export async function prepareLibraryNumericalInput(input: LibraryNumericalResourceInput, read: LibraryAnalysisChunkReader,
  checkpoint: () => Promise<void>, signal: AbortSignal) {
  if (!input || input.format !== "resources" || !Number.isSafeInteger(input.replayBytes) || input.replayBytes < 1 || input.replayBytes > 64 * MiB ||
    !Number.isSafeInteger(input.mapBytes) || input.mapBytes < 1 || input.mapBytes > 16 * MiB) throw new Error("Library numerical input byte limit exceeded");
  if (!input.binding || typeof input.binding.exactMapAndProfile !== "boolean" || !/^[a-f0-9]{64}$/.test(input.binding.replaySha256) ||
    !/^[a-f0-9]{64}$/.test(input.binding.mapSha256) || !/^[a-f0-9]{32}$/.test(input.binding.mapMd5)) throw new Error("Invalid numerical input binding");
  const binding = { ...input.binding, ...(input.binding.sourceCompletion ? { sourceCompletion: { ...input.binding.sourceCompletion } } : {}) };
  const replayBytes = input.replayBytes, mapBytes = input.mapBytes;
  const check = async () => { signal.throwIfAborted(); await checkpoint(); signal.throwIfAborted(); };
  const chunks = async (kind: "replay" | "map", size: number, append: (offset: number, bytes: Uint8Array) => void) => {
    let offset = 0;
    while (offset < size) {
      await check(); const chunk = await read(kind, offset, signal); signal.throwIfAborted();
      if (!chunk || !(chunk.bytes instanceof Uint8Array) || !chunk.bytes.length || chunk.bytes.length > 256 * 1024 ||
        offset + chunk.bytes.length > size || chunk.done !== (offset + chunk.bytes.length === size)) throw new Error("Invalid numerical resource chunk");
      append(offset, chunk.bytes); offset += chunk.bytes.length;
    }
    await check();
  };
  const parser = new LibraryReplayParser(replayBytes);
  let replay;
  try {
    await chunks("replay", replayBytes, (offset, bytes) => parser.append(offset, bytes));
    const assembler = new LibraryReplayAssembler(await parser.finish(signal, check));
    for (;;) { await check(); const batch = parser.takeBatch(); if (!batch) break; assembler.append(batch); }
    replay = assembler.finish();
  } finally { parser.release(); }
  if (replay.replayContentSha256 !== binding.replaySha256 || replay.beatmapMd5.toLowerCase() !== binding.mapMd5)
    throw new Error("Numerical replay identity disagrees with verified resources");
  const bytes = new Uint8Array(mapBytes);
  await chunks("map", mapBytes, (offset, chunk) => bytes.set(chunk, offset));
  if (!globalThis.crypto?.subtle) throw new Error("Library map identity verification is unavailable");
  const hash = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  await check(); if (hash !== binding.mapSha256) throw new Error("Numerical map identity disagrees with verified resources");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM:true }).decode(bytes);
  let general = false, lineNumber = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line.startsWith("[")) general = line === "[General]";
    if (general && /^Mode\s*:/.test(line) && !/^Mode\s*:\s*0\s*$/.test(line)) throw new Error("Unsupported numerical beatmap mode");
    if (++lineNumber % 2048 === 0) await check();
  }
  await check(); const blueprint = parseBlueprint(text);
  if (blueprint.hitObjectSettings.length > 100000) throw new Error("Library map object limit exceeded");
  await check();
  const beatmap = buildBeatmap(blueprint, { addStacking: true, mods: replay.mods, lazerMods: replay.lazerMods });
  await check(); return { beatmap, replay, binding, mapText:text };
}
