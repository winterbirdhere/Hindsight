import { Beatmap, ReplayLeadingResetToken, OsuAction, REPLAY_PARSER_VERSION, modsFromBitmask, modsToBitmask, errorCapabilities } from "@osujs/core";
import { OsuReplay, isLazerReplay } from "../../model/OsuReplay";
import type { LibraryNumericalBinding } from "../../../../../shared/library-analysis";

export interface ManualClockInput {
  readonly version: "manualClockInput-v1";
  readonly status: "complete";
  readonly parserVersion: string;
  readonly gameVersion: number;
  readonly modsBitmask: number;
  readonly rawTokenCount: number;
  readonly frameCount: number;
  readonly omittedTokens: readonly ReplayLeadingResetToken[];
}
/** Authority is stored privately, never in this serializable handle. */
export interface ManualClockCapture {
  readonly version: "manualClockInput-v1";
  readonly status: "complete" | "unavailable";
  readonly reason?: string;
}

export type StableClockFamily = "manual" | "relax";
export type StableClockPolicy = Readonly<{
  kind: "comparison"; version: "stable-importer-clock-v1"; mapFormatVersion: number; rawClockOriginMs: 0; mapTimingOffsetMs: 0;
} | {
  kind: "normalized-source"; version: "stable-early-map-clock-v1"; mapFormatVersion: 3; rawClockOriginMs: 24; mapTimingOffsetMs: 24;
} | {
  kind: "normalized-source"; version: "stable-manual-importer-clock-v1"; mapFormatVersion: number; rawClockOriginMs: 0; mapTimingOffsetMs: 0;
}>;
export interface StableClockInput extends Omit<ManualClockInput, "version"> {
  readonly version: "stableClockInput-v1";
  readonly family: StableClockFamily;
  /** Selected source interpretation, not current-stream equivalence or a second map shift.
   * Omitted-token clocks remain the captured parser's original zero-origin values. */
  readonly policy: StableClockPolicy;
}
export interface StableClockCapture {
  readonly version: "stableClockInput-v1";
  readonly family: StableClockFamily;
  readonly status: "complete" | "unavailable";
  readonly reason?: string;
}

export async function captureStableClockInput(raw: string, replay: OsuReplay, modsBitmask: number,
  checkpoint: () => Promise<void>, signal?: AbortSignal): Promise<StableClockCapture> {
  return captureClockInventory(raw, replay, modsBitmask, checkpoint, signal);
}
export function registerPreparedClockInput(replay: OsuReplay, map: Beatmap, binding: LibraryNumericalBinding,
  capture: StableClockCapture | undefined): boolean { return registerClockInput(replay, map, binding, capture); }
export async function getPreparedClockInput(replay: OsuReplay, map: Beatmap, binding: LibraryNumericalBinding,
  checkpoint: () => Promise<void>): Promise<StableClockInput | undefined> { return getClockInput(replay, map, binding, checkpoint); }

const MAX_RAW = 32 * 1024 * 1024, MAX_TOKENS = 1100000, MAX_FRAMES = 1000000, MAX_OMISSIONS = 100000;
const HASH_BLOCK = 512;
const SUPPORTED_MODS = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 | 512 | 1024 | 4096 | 16384 | (1 << 29);
type ClockInventory = Omit<ManualClockInput, "version">;
type ClockCapture = ManualClockCapture | StableClockCapture;
interface CapturedInput {
  input: ClockInventory;
  family: StableClockFamily;
  frameHashes: readonly string[];
  skipHashes: readonly string[];
  lifeBarHashes: readonly string[];
  consumedMetadata: string;
  warnings: string;
}
interface RegisteredInput {
  captured: CapturedInput;
  input: StableClockInput;
  map: Beatmap;
  binding: LibraryNumericalBinding;
  identity: string;
  frames: OsuReplay["frames"];
  diagnostics: OsuReplay["parseDiagnostics"];
}
const captures = new WeakMap<ClockCapture, CapturedInput>();
const registrations = new WeakMap<OsuReplay, RegisteredInput>();
const unavailable = (reason: string): ManualClockCapture => Object.freeze({ version: "manualClockInput-v1", status: "unavailable", reason });
const integer = /^[+-]?\d+$/;
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const int32 = (value: number) => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
const actionsFor = (mask: number): OsuAction[] => [
  ...(mask & 5 ? [OsuAction.leftButton] : []), ...(mask & 10 ? [OsuAction.rightButton] : []),
];
const warningIdentity = (replay: OsuReplay) => JSON.stringify([
  replay.parseDiagnostics?.parserVersion, replay.parseDiagnostics?.initialActionsKnown, replay.parseDiagnostics?.sourceCoverageLimits,
]);
function consumedMetadata(replay: OsuReplay): string {
  const stats = replay.statistics;
  return JSON.stringify([replay.timestamp === undefined ? "absent" : replay.timestamp,
    stats === undefined ? "absent" : [stats.count300, stats.count100, stats.count50, stats.countMiss, stats.maxCombo, stats.score, stats.perfectCombo],
    replay.lifeBar === undefined ? "absent" : replay.lifeBar.length]);
}
function lifeBarBlock(replay: OsuReplay, start: number): unknown[] | undefined {
  const points = replay.lifeBar ?? [], rows: unknown[] = [];
  if (points.length > 100000) return;
  for (let index = start; index < Math.min(start + HASH_BLOCK, points.length); index++) {
    const point = points[index];
    if (!point || !Number.isFinite(point.time) || !Number.isFinite(point.health) || point.health < 0 || point.health > 1) return;
    rows.push([point.time, point.health]);
  }
  return rows;
}
async function hashRows(rows: readonly unknown[]): Promise<string | undefined> {
  // Optional hashing-provider failure does not turn an otherwise readable replay into a load failure.
  // Cancellation/checkpoint errors are deliberately outside this catch and always propagate.
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rows)));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  } catch { return undefined; }
}
function frameTuple(replay: OsuReplay, index: number): unknown[] | undefined {
  const frame = replay.frames[index], source = replay.parseDiagnostics?.frameSources[index];
  if (!frame || !source || frame.sourceFramesAtSameTime !== undefined || !Array.isArray(frame.actions) ||
      frame.actions.length > 2 || ![frame.time, frame.position?.x, frame.position?.y, frame.rawButtonMask].every(Number.isFinite) ||
      source.origin !== "parsed" || source.parsedFrameIndex !== index || !Number.isSafeInteger(source.rawTokenIndex) ||
      source.discontinuityBefore !== undefined && (!Array.isArray(source.discontinuityBefore) ||
        source.discontinuityBefore.length > 2 || source.discontinuityBefore.some(value => typeof value !== "string"))) return;
  return [frame.time, frame.position.x, frame.position.y, frame.rawButtonMask, [...frame.actions],
    source.origin, source.parsedFrameIndex, source.rawTokenIndex, source.discontinuityBefore ? [...source.discontinuityBefore] : null];
}

/** Read the exact already-decoded bytes once more only for a private worker attempt.
 * Keep omitted numeric tokens and bounded digest blocks; never duplicate the retained frame array.
 * Smoke is preserved in raw masks. The action projection is the evaluator's two tap actions,
 * not equality with the importer's complete action enum (which also contains Smoke). */

async function captureClockInventory(raw: string, replay: OsuReplay, modsBitmask: number,
  checkpoint: () => Promise<void>, signal?: AbortSignal): Promise<StableClockCapture> {
  const family: StableClockFamily = modsBitmask & 128 ? "relax" : "manual";
  const unavailable = (reason: string): StableClockCapture => Object.freeze({ version: "stableClockInput-v1", family, status: "unavailable", reason });
  const check = async () => { signal?.throwIfAborted(); await checkpoint(); signal?.throwIfAborted(); };
  signal?.throwIfAborted();
  const d = replay.parseDiagnostics;
  if (!globalThis.crypto?.subtle) return unavailable("hash-unavailable");
  if (raw.length > MAX_RAW || !d || d.parserVersion !== REPLAY_PARSER_VERSION || replay.frames.length > MAX_FRAMES ||
      d.frameSources.length !== replay.frames.length || d.skippedTokens.length > MAX_OMISSIONS ||
      (replay.lifeBar?.length ?? 0) > 100000) return unavailable("input-bounds");
  const metadata = consumedMetadata(replay), lifeBarHashes: string[] = [];
  const frameHashes: string[] = [], skipHashes: string[] = [], frameBlock: unknown[] = [], skipBlock: unknown[] = [];
  const omittedTokens: ReplayLeadingResetToken[] = [];
  let start = 0, time = 0, frameIndex = 0, skipIndex = 0, rawTokenCount = 0, ended = false;
  const skipped = async (rawTokenIndex: number, reason: string): Promise<boolean> => {
    const actual = d.skippedTokens[skipIndex++];
    if (!actual || actual.rawTokenIndex !== rawTokenIndex || actual.reason !== reason) return false;
    skipBlock.push([rawTokenIndex, reason]);
    if (skipBlock.length === HASH_BLOCK) {
      const hash = await hashRows(skipBlock); if (!hash) { await check(); return false; }
      skipHashes.push(hash); skipBlock.length = 0; await check();
    }
    return true;
  };
  for (let rawIndex = 0; start <= raw.length; rawIndex++) {
    if (rawIndex % 256 === 0) await check();
    if (rawIndex >= MAX_TOKENS) return unavailable("token-limit");
    let end = start;
    while (end < raw.length && raw.charCodeAt(end) !== 44) {
      if (end - start >= 4096) return unavailable("token-length-limit");
      end++;
    }
    const comma = end < raw.length ? end : -1;
    const token = raw.slice(start, end), fields = token.split("|"); start = end + 1; rawTokenCount++;
    if (token === "" && comma < 0) {
      if (!await skipped(rawIndex, "empty-token")) return unavailable("skipped-inventory");
      continue;
    }
    if (ended || fields.length !== 4) return unavailable("unsupported-token-inventory");
    if (fields[0] === "-12345") {
      if (!(comma < 0 || start === raw.length) || !integer.test(fields[3].trim()) || !int32(Number(fields[3])) ||
          !await skipped(rawIndex, "seed")) return unavailable("unsupported-seed-inventory");
      ended = true; continue;
    }
    if (!integer.test(fields[0].trim()) || !integer.test(fields[3].trim()) ||
        !decimal.test(fields[1].trim()) || !decimal.test(fields[2].trim())) return unavailable("unsupported-raw-lexeme");
    const delta = Number(fields[0]), x = Number(fields[1]), y = Number(fields[2]), mask = Number(fields[3]);
    if (!int32(delta) || !Number.isInteger(mask) || mask < 0 || mask > 31 || !Number.isFinite(x) || !Number.isFinite(y) ||
        Math.abs(x) > 131072 || Math.abs(y) > 131072) return unavailable("unsupported-raw-value");
    const timeBefore = time; time += delta;
    if (!Number.isSafeInteger(time)) return unavailable("clock-overflow");
    const sentinel = rawIndex < 2 && x === 256 && y === -500;
    if (sentinel || delta < 0) {
      if (omittedTokens.length >= MAX_OMISSIONS) return unavailable("omission-limit");
      if (!await skipped(rawIndex, sentinel ? "stable-sentinel" : "negative-delta")) return unavailable("skipped-inventory");
      omittedTokens.push(Object.freeze({ rawTokenIndex: rawIndex, delta, x, y, rawButtonMask: mask, timeBefore, timeAfter: time }));
    } else {
      const frame = replay.frames[frameIndex], source = d.frameSources[frameIndex], expectedActions = actionsFor(mask);
      const tuple = frameTuple(replay, frameIndex);
      if (!tuple || frame.time !== time || frame.position.x !== x || frame.position.y !== y || frame.rawButtonMask !== mask ||
          source.rawTokenIndex !== rawIndex || frame.actions.length !== expectedActions.length ||
          frame.actions.some((action, index) => action !== expectedActions[index])) return unavailable("retained-inventory");
      frameBlock.push(tuple); frameIndex++;
      if (frameBlock.length === HASH_BLOCK) {
        const hash = await hashRows(frameBlock); if (!hash) { await check(); return unavailable("hash-unavailable"); }
        frameHashes.push(hash); frameBlock.length = 0; await check();
      }
    }
  }
  if (frameIndex !== replay.frames.length || skipIndex !== d.skippedTokens.length) return unavailable("incomplete-inventory");
  if (frameBlock.length) {
    const hash = await hashRows(frameBlock); if (!hash) { await check(); return unavailable("hash-unavailable"); } frameHashes.push(hash);
  }
  if (skipBlock.length) {
    const hash = await hashRows(skipBlock); if (!hash) { await check(); return unavailable("hash-unavailable"); } skipHashes.push(hash);
  }
  for (let start = 0; start < (replay.lifeBar?.length ?? 0); start += HASH_BLOCK) {
    await check(); const rows = lifeBarBlock(replay, start);
    if (!rows) return unavailable("invalid-life-bar");
    const hash = await hashRows(rows); await check();
    if (!hash) return unavailable("hash-unavailable"); lifeBarHashes.push(hash);
  }
  await check();
  if (metadata !== consumedMetadata(replay)) return unavailable("changed-consumed-metadata");
  const input: ClockInventory = Object.freeze({ status: "complete", parserVersion: REPLAY_PARSER_VERSION,
    gameVersion: replay.gameVersion, modsBitmask, rawTokenCount, frameCount: frameIndex, omittedTokens: Object.freeze(omittedTokens) });
  const handle: StableClockCapture = Object.freeze({ version: "stableClockInput-v1", family, status: "complete" });
  captures.set(handle, { input, family, frameHashes: Object.freeze(frameHashes), skipHashes: Object.freeze(skipHashes),
    lifeBarHashes: Object.freeze(lifeBarHashes), consumedMetadata: metadata, warnings: warningIdentity(replay) });
  return handle;
}

/** The compatibility entry point never grants RX or normalized-source authority. */
export async function captureManualClockInput(raw: string, replay: OsuReplay, modsBitmask: number,
  checkpoint: () => Promise<void>, signal?: AbortSignal): Promise<ManualClockCapture> {
  signal?.throwIfAborted();
  if (modsBitmask & 128) return unavailable("not-manual-input");
  const generic = await captureStableClockInput(raw, replay, modsBitmask, checkpoint, signal), captured = captures.get(generic);
  if (!captured) return unavailable(generic.reason ?? "input-unavailable");
  const handle: ManualClockCapture = Object.freeze({ version: "manualClockInput-v1", status: "complete" });
  captures.delete(generic); captures.set(handle, captured); return handle;
}

function policyFor(format: number | undefined, requested: LibraryNumericalBinding["clockNormalizationVersion"],
  family: StableClockFamily): StableClockPolicy | undefined {
  const zeroOffset = typeof format === "number" && Number.isSafeInteger(format) && format >= 5 && format <= 14;
  // A request selects a distinct identity, not authority. Registration still requires
  // complete private raw inventory and independently verified resources/profile.
  if (requested === "stable-manual-importer-clock-v1") return zeroOffset && family === "manual"
    ? Object.freeze({ kind: "normalized-source", version: requested, mapFormatVersion: format, rawClockOriginMs: 0, mapTimingOffsetMs: 0 }) : undefined;
  if (requested !== undefined && (requested !== "stable-early-map-clock-v1" || format !== 3)) return undefined;
  if (format === 3) return Object.freeze({ kind: "normalized-source", version: "stable-early-map-clock-v1",
    mapFormatVersion: 3, rawClockOriginMs: 24, mapTimingOffsetMs: 24 });
  if (zeroOffset)
    return Object.freeze({ kind: "comparison", version: "stable-importer-clock-v1", mapFormatVersion: format, rawClockOriginMs: 0, mapTimingOffsetMs: 0 });
  return undefined;
}

function profileQualified(replay: OsuReplay, map: Beatmap, binding: LibraryNumericalBinding, input: ClockInventory): boolean {
  const mask = input.modsBitmask, format = binding.verifiedMapFormatVersion, capability = errorCapabilities(map, "stable");
  return binding.exactMapAndProfile && /^[a-f0-9]{64}$/.test(binding.replaySha256) && /^[a-f0-9]{64}$/.test(binding.mapSha256) &&
    /^[a-f0-9]{32}$/.test(binding.mapMd5) && replay.replayContentSha256 === binding.replaySha256 &&
    replay.beatmapMd5.toLowerCase() === binding.mapMd5 && !isLazerReplay(replay) && (replay.gameMode ?? 0) === 0 &&
    Number.isSafeInteger(replay.gameVersion) && replay.gameVersion > 0 && replay.gameVersion < 30000000 && input.gameVersion === replay.gameVersion &&
    policyFor(format, binding.clockNormalizationVersion, mask & 128 ? "relax" : "manual") !== undefined &&
    Number.isInteger(mask) && mask >= 0 && (mask & ~SUPPORTED_MODS) === 0 &&
    !((mask & 256) && (mask & (64 | 512))) && !((mask & 2) && (mask & 16)) &&
    modsToBitmask(replay.mods) === mask && replay.mods.length === new Set(replay.mods).size &&
    replay.mods.length === modsFromBitmask(mask).length && map.appliedMods.length === replay.mods.length &&
    map.appliedMods.every(mod => replay.mods.includes(mod)) && !map.lazerMods.length && !replay.lazerMods?.length &&
    map.gameClockRate === ((mask & (64 | 512)) ? 1.5 : (mask & 256) ? 0.75 : 1) &&
    capability.scoring === "supported" && capability.geometry === "supported" && capability.tracking === "supported" && capability.aim === "manual";
}
function identity(replay: OsuReplay, map: Beatmap, binding: LibraryNumericalBinding): string {
  return JSON.stringify([replay.replayContentSha256, replay.beatmapMd5, replay.gameMode, replay.gameVersion, replay.sourceClient,
    replay.sourceProvenance, replay.mods, replay.lazerMods, map.appliedMods, map.lazerMods, map.gameClockRate,
    binding.replaySha256, binding.mapSha256, binding.mapMd5, binding.exactMapAndProfile, binding.verifiedMapFormatVersion, binding.clockNormalizationVersion,
    consumedMetadata(replay), binding.sourceCompletion ? [binding.sourceCompletion.sourcePassed,
      binding.sourceCompletion.sourceVerified, binding.sourceCompletion.conflicting] : null]);
}

export function registerPreparedManualClockInput(replay: OsuReplay, map: Beatmap, binding: LibraryNumericalBinding,
  capture: ManualClockCapture | undefined): boolean {
  if (!capture || captures.get(capture)?.family !== "manual" ||
    policyFor(binding.verifiedMapFormatVersion, binding.clockNormalizationVersion, "manual")?.kind !== "comparison") return false;
  return registerClockInput(replay, map, binding, capture);
}

function registerClockInput(replay: OsuReplay, map: Beatmap, binding: LibraryNumericalBinding,
  capture: ClockCapture | undefined): boolean {
  if (!capture) return false;
  const captured = captures.get(capture);
  if (!captured) return false;
  const policy = policyFor(binding.verifiedMapFormatVersion, binding.clockNormalizationVersion, captured.family);
  if (!policy || capture.version === "manualClockInput-v1" && policy.kind !== "comparison" ||
    captured.consumedMetadata !== consumedMetadata(replay) || !profileQualified(replay, map, binding, captured.input)) return false;
  captures.delete(capture);
  const input: StableClockInput = Object.freeze({ ...captured.input, version: "stableClockInput-v1", family: captured.family, policy });
  registrations.set(replay, { captured, input, map, binding, identity: identity(replay, map, binding), frames: replay.frames, diagnostics: replay.parseDiagnostics });
  return true;
}

export async function getPreparedManualClockInput(replay: OsuReplay, map: Beatmap, binding: LibraryNumericalBinding,
  checkpoint: () => Promise<void>): Promise<ManualClockInput | undefined> {
  const registered = registrations.get(replay);
  if (registered?.input.family !== "manual" || registered.input.policy.kind !== "comparison") return;
  const input = await getClockInput(replay, map, binding, checkpoint); if (!input) return;
  const { family, policy, version, ...inventory } = input;
  void family; void policy; void version;
  return Object.freeze({ ...inventory, version: "manualClockInput-v1" });
}

async function getClockInput(replay: OsuReplay, map: Beatmap, binding: LibraryNumericalBinding,
  checkpoint: () => Promise<void>): Promise<StableClockInput | undefined> {
  const registered = registrations.get(replay), d = replay.parseDiagnostics;
  if (!registered || registered.map !== map || registered.binding !== binding || registered.frames !== replay.frames || registered.diagnostics !== d ||
      !d || registered.identity !== identity(replay, map, binding) || !profileQualified(replay, map, binding, registered.captured.input) ||
      replay.frames.length !== registered.captured.input.frameCount || d.frameSources.length !== replay.frames.length ||
      d.skippedTokens.length > MAX_OMISSIONS || warningIdentity(replay) !== registered.captured.warnings ||
      consumedMetadata(replay) !== registered.captured.consumedMetadata) return;
  const { captured } = registered;
  for (let start = 0, block = 0; start < replay.frames.length; start += HASH_BLOCK, block++) {
    await checkpoint(); const rows: unknown[] = [];
    for (let index = start; index < Math.min(start + HASH_BLOCK, replay.frames.length); index++) {
      const tuple = frameTuple(replay, index); if (!tuple) return; rows.push(tuple);
    }
    const hash = await hashRows(rows); await checkpoint();
    if (hash !== captured.frameHashes[block]) return;
  }
  if (Math.ceil(d.skippedTokens.length / HASH_BLOCK) !== captured.skipHashes.length) return;
  for (let start = 0, block = 0; start < d.skippedTokens.length; start += HASH_BLOCK, block++) {
    await checkpoint();
    const rows = d.skippedTokens.slice(start, start + HASH_BLOCK).map(item => [item.rawTokenIndex, item.reason]);
    const hash = await hashRows(rows); await checkpoint();
    if (hash !== captured.skipHashes[block]) return;
  }
  if (Math.ceil((replay.lifeBar?.length ?? 0) / HASH_BLOCK) !== captured.lifeBarHashes.length) return;
  for (let start = 0, block = 0; start < (replay.lifeBar?.length ?? 0); start += HASH_BLOCK, block++) {
    await checkpoint(); const rows = lifeBarBlock(replay, start); if (!rows) return;
    const hash = await hashRows(rows); await checkpoint();
    if (hash !== captured.lifeBarHashes[block]) return;
  }
  await checkpoint();
  if (registered.identity !== identity(replay, map, binding) || warningIdentity(replay) !== captured.warnings) return;
  return registered.input;
}
