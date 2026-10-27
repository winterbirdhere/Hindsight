import { spawn } from "child_process";
import { win32 } from "path";
import { isLosslessLibraryJson } from "../../../../../shared/library-json";
import { LibraryNativeAdmission,LibraryNativeDrainError } from "../library-native-admission";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const TIMEOUT_MS = 15_000;

export interface LazerResource {
  status: "available" | "missing" | "corrupt" | "invalid" | "resource-limit" | "unverified" | "busy" | "inaccessible";
  sha256?: string;
  path?: string;
  bytes?: number;
  md5?: string;
}

export interface LazerSourceScore {
  id: string;
  playedAtTicks: string;
  player: string | null;
  ruleset: number | null;
  clientVersion: string | null;
  isLegacyScore: boolean;
  maxCombo: number;
  accuracy: number;
  rank: number;
  pp: number | null;
  mods: unknown[] | null;
  statistics: Record<string, number> | null;
  maximumStatistics: Record<string, number> | null;
  replay: LazerResource;
  beatmap: LazerResource;
  assets: { name: string; resource: LazerResource }[];
  assetManifestComplete?: boolean;
  artworkLookup?:LibraryArtworkSelection&{complete:true};
  mapMetadata?: LazerMapMetadata | null;
  // Deliberately no Passed: osu.Game's constructor default is not persisted evidence.
}
export interface LibraryArtworkSelection {mapSha256:string;mapMd5:string;name:string}

export interface LazerMapMetadata {
  title: string | null; titleUnicode: string | null; artist: string | null; artistUnicode: string | null;
  mapper: string | null; difficultyName: string | null; onlineId: number; status: number;
  cachedLengthMs: number | null; cachedBpm: number | null; cachedNoModStars: number | null;
}

export type LazerSourceStatus = "ready" | "source-missing" | "source-busy" | "unsupported-schema" |
  "invalid-source" | "resource-limit" | "cancelled" | "timeout" | "helper-failed" | "incompatible-helper" |
  "source-changed" | "invalid-cursor" | "unsupported-filesystem" | "score-missing";

export interface LazerSourceInspection {
  version: 1;
  ok: boolean;
  status: LazerSourceStatus;
  sampleOnly?: boolean;
  schemaFingerprint?: string;
  scores?: LazerSourceScore[];
  cursorToken?: string;
  nextOffset?: number;
  total?: number;
  complete?: boolean;
  errors?: { id: string; status: string }[];
  resolvedScoreId?: string;
}

/** Pass Electron app.getPath('appData'), not an unverified preview or sandbox environment path. */
export function defaultLazerDirectory(appData: string): string {
  return win32.join(appData, "osu");
}

const statuses = new Set<LazerSourceStatus>(["ready", "source-missing", "source-busy", "unsupported-schema",
  "invalid-source", "resource-limit", "cancelled", "timeout", "helper-failed", "incompatible-helper",
  "source-changed", "invalid-cursor", "unsupported-filesystem", "score-missing"]);
const resourceStatuses = new Set(["available", "missing", "corrupt", "invalid", "resource-limit", "unverified", "busy", "inaccessible"]);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function resource(value: unknown): boolean {
  if (!record(value) || !resourceStatuses.has(String(value.status))) return false;
  if (value.sha256 != null && (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))) return false;
  if (value.status === "available" || value.status === "unverified") {
    return typeof value.path === "string" && win32.isAbsolute(value.path) &&
      typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) &&
      typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes >= 0;
  }
  return true;
}
function counts(value: unknown): boolean {
  return value === null || (record(value) && Object.values(value).every((count) => Number.isSafeInteger(count) && Number(count) >= 0));
}
function mapMetadata(value: unknown): boolean {
  return value == null || (record(value) && ["title", "titleUnicode", "artist", "artistUnicode", "mapper", "difficultyName"]
    .every(key => value[key] === null || (typeof value[key] === "string" && (value[key] as string).length <= 4096)) &&
    Number.isSafeInteger(value.onlineId) && Number.isSafeInteger(value.status) &&
    ["cachedLengthMs", "cachedBpm", "cachedNoModStars"].every(key => value[key] === null ||
      (typeof value[key] === "number" && Number.isFinite(value[key]) && Number(value[key]) >= 0)));
}
type SourceOperation = "inspect" | "scan-page" | "resolve-score" | "resolve-provisional-score" | "resolve-artwork";
function safeAssetName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\\") &&
    !value.includes(":") && !Array.from(value).some(character => character.charCodeAt(0) < 32) &&
    value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !/[. ]$/.test(part));
}
export function matchesLibraryArtworkLookup(score:unknown,selection:LibraryArtworkSelection):boolean{
  if(!record(score)||!record(score.beatmap)||!record(score.artworkLookup)||score.assetManifestComplete!==false||
    score.beatmap.sha256!==selection.mapSha256||score.beatmap.md5!==selection.mapMd5||
    !["available","unverified"].includes(String(score.beatmap.status))||
    score.artworkLookup.name!==selection.name||score.artworkLookup.mapSha256!==selection.mapSha256||
    score.artworkLookup.mapMd5!==selection.mapMd5||score.artworkLookup.complete!==true||!Array.isArray(score.assets)||score.assets.length>1)return false;
  return score.assets.every(asset=>record(asset)&&safeAssetName(asset.name)&&asset.name.toLowerCase()===selection.name.toLowerCase()&&resource(asset.resource));
}
function isInspection(value: unknown, operation: SourceOperation, offset = 0, token?: string,
  scoreId?: string, expectedReplaySha256?: string,artwork?:LibraryArtworkSelection): value is LazerSourceInspection {
  if (!record(value) || value.version !== 1 || typeof value.ok !== "boolean" ||
    !statuses.has(value.status as LazerSourceStatus)) return false;
  if (!value.ok) return value.status !== "ready";
  const errors = value.errors ?? [];
  if (!Array.isArray(errors) || errors.length > 32 || errors.some(error => !record(error) ||
      typeof error.id !== "string" || !/^[a-f\d-]{36}$/i.test(error.id) ||
      typeof error.status !== "string" || !statuses.has(error.status as LazerSourceStatus) || error.status === "ready")) return false;
  if (operation === "scan-page" && (value.sampleOnly !== false ||
      typeof value.cursorToken !== "string" || !/^[a-f\d]{64}$/.test(value.cursorToken) || (token && value.cursorToken !== token) ||
      !Number.isSafeInteger(value.nextOffset) || !Number.isSafeInteger(value.total) || Number(value.total) < 0 || Number(value.total) > 1_000_000 ||
      Number(value.nextOffset) < offset || Number(value.nextOffset) > Number(value.total) ||
      value.complete !== (value.nextOffset === value.total) || (!value.complete && value.nextOffset === offset) ||
      !Array.isArray(value.scores) || value.scores.length + errors.length !== Number(value.nextOffset) - offset ||
      value.scores.length + errors.length > 32)) return false;
  if ((operation === "resolve-score" || operation === "resolve-provisional-score" || operation === "resolve-artwork") && (value.sampleOnly !== false || value.resolvedScoreId !== scoreId || errors.length !== 0 ||
      typeof value.cursorToken !== "string" || !/^[a-f\d]{64}$/.test(value.cursorToken) ||
      !Array.isArray(value.scores) || value.scores.length !== 1 || !record(value.scores[0]) || value.scores[0].id !== scoreId ||
      typeof value.scores[0].assetManifestComplete !== "boolean" || !record(value.scores[0].replay) ||
      (operation !== "resolve-provisional-score" && value.scores[0].replay.sha256 !== expectedReplaySha256))) return false;
  if(operation==="resolve-artwork"&&(!artwork||!Array.isArray(value.scores)||!matchesLibraryArtworkLookup(value.scores[0],artwork)))return false;
  return value.status === "ready" && (operation !== "inspect" || value.sampleOnly === true) &&
    typeof value.schemaFingerprint === "string" && /^[a-f0-9]{64}$/.test(value.schemaFingerprint) &&
    Array.isArray(value.scores) && value.scores.length <= (operation === "inspect" ? 8 : 32) && value.scores.every((score: unknown) => {
      if (!record(score)) return false;
      return typeof score.id === "string" && /^[a-f\d-]{36}$/i.test(score.id) &&
        typeof score.playedAtTicks === "string" && /^\d{1,19}$/.test(score.playedAtTicks) &&
        (score.player === null || typeof score.player === "string") &&
        (score.ruleset === null || Number.isSafeInteger(score.ruleset)) &&
        (score.clientVersion === null || typeof score.clientVersion === "string") &&
        typeof score.isLegacyScore === "boolean" && Number.isSafeInteger(score.maxCombo) && Number(score.maxCombo) >= 0 &&
        typeof score.accuracy === "number" && score.accuracy >= 0 && score.accuracy <= 1 &&
        Number.isSafeInteger(score.rank) && (score.pp === null || (typeof score.pp === "number" && Number.isFinite(score.pp) && score.pp >= 0)) &&
        (score.mods === null || (Array.isArray(score.mods) && isLosslessLibraryJson(score.mods))) && counts(score.statistics) && counts(score.maximumStatistics) &&
        resource(score.replay) && resource(score.beatmap) && mapMetadata(score.mapMetadata) && Array.isArray(score.assets) && score.assets.length <= 2048 &&
        score.assets.every((asset: unknown) => record(asset) && safeAssetName(asset.name) && resource(asset.resource)) &&
        new Set(score.assets.map((asset: { name: string }) => asset.name.toLowerCase())).size === score.assets.length;
    });
}

/** Independent bounded native ownership. An inspection sample is never a completed source scan. */
export class LazerSource {
  private closed = false;
  private cleanupFailure?: Error;
  private readonly owners = new Set<{ cancel: () => void; drained: Promise<void>; outcome: Promise<void> }>();
  constructor(private readonly executable: () => string,private readonly admission?:LibraryNativeAdmission) {}

  async close(): Promise<void> {
    this.closed = true;
    const owners = [...this.owners];
    owners.forEach(owner => owner.cancel());
    await Promise.all(owners.map(owner => owner.outcome));
    if (this.cleanupFailure) throw this.cleanupFailure;
    await Promise.all(owners.map(owner => owner.drained));
  }

  inspect(sourceDirectory: string, signal?: AbortSignal): Promise<LazerSourceInspection> {
    return this.request(sourceDirectory, "inspect", { limit: 8 }, signal);
  }

  page(sourceDirectory: string, cursor?: { token: string; offset: number }, signal?: AbortSignal): Promise<LazerSourceInspection> {
    if (cursor && (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 1_000_000 || !/^[a-f\d]{64}$/.test(cursor.token)))
      return Promise.resolve({ version: 1, ok: false, status: "invalid-cursor" });
    return this.request(sourceDirectory, "scan-page", { limit: 32, ...(cursor ?? { offset: 0 }) }, signal);
  }

  resolveScore(sourceDirectory: string, scoreId: string, expectedReplaySha256: string, signal?: AbortSignal,
    options?: { includeAssets?: boolean }): Promise<LazerSourceInspection> {
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(scoreId) || !/^[a-f\d]{64}$/.test(expectedReplaySha256) ||
        (options?.includeAssets !== undefined && typeof options.includeAssets !== "boolean"))
      return Promise.resolve({ version: 1, ok: false, status: "invalid-source" });
    return this.request(sourceDirectory, "resolve-score", { limit: 1, scoreId, expectedReplaySha256,
      ...(options?.includeAssets === undefined ? {} : { includeAssets: options.includeAssets }) }, signal);
  }
  resolveArtwork(sourceDirectory:string,scoreId:string,expectedReplaySha256:string,selection:LibraryArtworkSelection,signal?:AbortSignal):Promise<LazerSourceInspection>{
    if(!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(scoreId)||!/^[a-f\d]{64}$/.test(expectedReplaySha256)||
      !selection||!/^[a-f\d]{64}$/.test(selection.mapSha256)||!/^[a-f\d]{32}$/.test(selection.mapMd5)||!safeAssetName(selection.name)||/[<>"|?*]/.test(selection.name))
      return Promise.resolve({version:1,ok:false,status:"invalid-source"});
    return this.request(sourceDirectory,"resolve-artwork",{limit:1,scoreId,expectedReplaySha256,expectedMapSha256:selection.mapSha256,expectedMapMd5:selection.mapMd5,assetName:selection.name},signal);
  }

  /** Only for an identity with no established replay digest; never a fallback after a known-hash mismatch. */
  resolveProvisionalScore(sourceDirectory: string, scoreId: string, signal?: AbortSignal,
    options?: { includeAssets?: boolean }): Promise<LazerSourceInspection> {
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(scoreId) ||
        (options?.includeAssets !== undefined && typeof options.includeAssets !== "boolean"))
      return Promise.resolve({ version: 1, ok: false, status: "invalid-source" });
    return this.request(sourceDirectory, "resolve-provisional-score", { limit: 1, scoreId,
      ...(options?.includeAssets === undefined ? {} : { includeAssets: options.includeAssets }) }, signal);
  }

  private request(sourceDirectory: string, operation: SourceOperation,
    parameters: { limit: number; offset?: number; token?: string; scoreId?: string; expectedReplaySha256?: string; includeAssets?: boolean;expectedMapSha256?:string;expectedMapMd5?:string;assetName?:string }, signal?: AbortSignal): Promise<LazerSourceInspection> {
    return this.admission?this.admission.run(operation==="scan-page"||operation==="inspect"?"source-page":"source-resolve",
      ()=>this.execute(sourceDirectory,operation,parameters,signal),signal):this.execute(sourceDirectory,operation,parameters,signal);
  }
  private execute(sourceDirectory: string, operation: SourceOperation,
    parameters: { limit: number; offset?: number; token?: string; scoreId?: string; expectedReplaySha256?: string; includeAssets?: boolean;expectedMapSha256?:string;expectedMapMd5?:string;assetName?:string }, signal?: AbortSignal): Promise<LazerSourceInspection> {
    const failure = (status: LazerSourceStatus): LazerSourceInspection => ({ version: 1, ok: false, status });
    if (this.closed) return Promise.reject(new Error("Native source closed"));
    if (this.cleanupFailure) return Promise.reject(this.cleanupFailure);
    if (this.owners.size >= 4) return Promise.resolve(failure("source-busy"));
    if (signal?.aborted) return Promise.resolve(failure("cancelled"));
    const input = JSON.stringify({ version: 1, operation, sourceDirectory, ...parameters }) + "\n";
    if (!win32.isAbsolute(sourceDirectory) || Buffer.byteLength(input) > MAX_REQUEST_BYTES)
      return Promise.resolve(failure("invalid-source"));
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.executable(), ["--library-source"], { windowsHide: true, shell: false, stdio: "pipe" });
      } catch {
        resolve(failure("helper-failed"));
        return;
      }
      let settled = false;
      let size = 0;
      let terminating: LazerSourceInspection | undefined;
      let teardown: ReturnType<typeof setTimeout> | undefined;
      // A single bounded buffer avoids object growth from arbitrarily small pipe chunks.
      let bytes: Buffer | undefined = Buffer.allocUnsafe(MAX_RESPONSE_BYTES);
      let release: () => void = () => undefined, reportOutcome: () => void = () => undefined;
      const drained = new Promise<void>(done => { release = done; });
      const outcome = new Promise<void>(done => { reportOutcome = done; });
      const releaseOwnership = () => { this.owners.delete(owner); release(); };
      const finish = (result: LazerSourceInspection, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(teardown);
        signal?.removeEventListener("abort", abort);
        bytes = undefined;
        if (error) reject(error); else resolve(result);
        reportOutcome();
      };
      const terminate = (status: LazerSourceStatus) => {
        if (settled || terminating) return;
        terminating = failure(status);
        clearTimeout(timeout);
        bytes = undefined;
        // kill() merely requests termination. A cancelled result must acknowledge actual exit
        // because this process may still own the immutable source's deny-write lease.
        teardown = setTimeout(() => {
          this.cleanupFailure = new LibraryNativeDrainError("Native source cleanup failed: exit not confirmed");
          finish(failure("helper-failed"), this.cleanupFailure);
        }, 2_000);
        try { if (!child.kill()) terminating = failure("helper-failed"); }
        catch { terminating = failure("helper-failed"); }
      };
      const abort = () => terminate("cancelled");
      const timeout = setTimeout(() => terminate("timeout"), TIMEOUT_MS);
      const owner = { cancel: () => terminate("cancelled"), drained, outcome };
      this.owners.add(owner);
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", () => {
        if (child.pid === undefined) { finish(failure("helper-failed")); releaseOwnership(); }
        else terminate("helper-failed");
      });
      child.stdin?.on("error", () => terminate("helper-failed"));
      child.stdout?.on("error", () => terminate("helper-failed"));
      child.stderr?.on("error", () => terminate("helper-failed"));
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled || terminating) return;
        if (chunk.length > MAX_RESPONSE_BYTES - size) terminate("resource-limit");
        else { chunk.copy(bytes as Buffer, size); size += chunk.length; }
      });
      // Drain diagnostics without retaining unbounded or source-sensitive text.
      child.stderr?.resume();
      child.on("close", (exitCode) => {
        releaseOwnership();
        if (settled) return;
        if (terminating) { finish(terminating); return; }
        if (exitCode !== 0) { finish(failure("helper-failed")); return; }
        try {
          const result: unknown = JSON.parse(bytes?.subarray(0, size).toString("utf8") ?? "");
          const artwork=parameters.expectedMapSha256&&parameters.expectedMapMd5&&parameters.assetName?{mapSha256:parameters.expectedMapSha256,mapMd5:parameters.expectedMapMd5,name:parameters.assetName}:undefined;
          finish(isInspection(result, operation, parameters.offset, parameters.token, parameters.scoreId, parameters.expectedReplaySha256,artwork) ? result : failure("incompatible-helper"));
        } catch { finish(failure("incompatible-helper")); }
      });
      if (signal?.aborted) abort();
      else {
        try { child.stdin?.end(input); } catch { terminate("helper-failed"); }
      }
    });
  }
}
