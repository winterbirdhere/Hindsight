import { isAbsolute } from "path";
import { LibraryResourceSessions } from "./library-resource-sessions";
import { LibraryLzmaClient } from "./library-lzma-client";
import { LazerSource,matchesLibraryArtworkLookup } from "./sources/lazer-source";
import { readVerifiedNativeArtworkName } from "./library-passive-resources";
import { sourceMapEvidence } from "./library-source-binding";
import { prepareLibraryReplay, prepareLibraryMap, LibraryOriginLookup } from "./library-selected-resources";
import { readVerifiedLibraryResource } from "./library-resource-reader";
import type { LibraryOpenLocation, LibraryOpenMap } from "./library-store";
import type { LibraryUtilityResponse } from "./library-utility-server";
import { LibraryNativeAdmission, LibraryNativeDrainError } from "./library-native-admission";
import { prepareLibraryPerformanceMap } from "./library-performance-map-resource";
import { prepareLibraryPerformanceScore } from "./library-performance-score-resource";
import { calculateLibraryPerformance } from "./library-performance-native";
import type { PerformanceRequest } from "@rewind/osu-performance/protocol";

export interface LibraryResourceConfiguration { nativeExecutable: string; originFile: string; background?: boolean;nativeAdmission?:boolean }
export type LibraryResourceOperation = "begin" | "prepare-map" | "transfer" | "chunk" | "release" | "control" | "describe-analysis" | "begin-performance" | "calculate-performance" | "performance-score" | "probe-incident-evidence" | "resolve-passive-native" | "resolve-passive-artwork";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 128): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const absolute = (value: unknown): value is string => text(value, 32768) && isAbsolute(value);
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: unknown, size: number) => typeof value === "string" && new RegExp(`^[a-f\\d]{${size}}$`).test(value);
const baseTicket = (value: unknown): value is Record<string, unknown> => record(value) && text(value.sourceId) &&
  text(value.sourceKey, 32768) && text(value.locator, 32768) && revision(value.sourceConfigRevision) && absolute(value.directory) &&
  record(value.metadata) && Buffer.byteLength(JSON.stringify(value.metadata)) <= 65536;
function replayTicket(value: unknown): value is LibraryOpenLocation {
  return baseTicket(value) && text(value.replayId) && revision(value.locationRevision) &&
    ["stable", "replays", "lazer", "imported"].includes(String(value.kind)) && (value.sha256 === null || hash(value.sha256, 64));
}
function mapTicket(value: unknown): value is LibraryOpenMap {
  return baseTicket(value) && value.kind === "stable" && text(value.generation) && hash(value.md5, 32) && absolute(value.locator);
}

function createSessions(config: LibraryResourceConfiguration,broker?:LibraryNativeAdmission): LibraryResourceSessions {
  const admission:LibraryNativeAdmission|undefined=broker?{run:(phase,work,signal)=>sessions.waitForNative(broker.run(phase,work,signal))}:undefined;
  const native = new LazerSource(() => config.nativeExecutable,admission), decoder = new LibraryLzmaClient(() => config.nativeExecutable,undefined,admission);
  const origin: LibraryOriginLookup = async (sha256,signal,checkpoint) => {
    let bytes: Buffer;
    try { bytes = (await readVerifiedLibraryResource(config.originFile, { maxBytes: 8 * 1024 * 1024 },signal,checkpoint)).bytes; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const store = JSON.parse(bytes.toString("utf8"));
      const entry = store?.version === 1 && record(store.entries) ? store.entries[sha256] : undefined;
      if (record(entry) && entry.provenance === "user-confirmed" && (entry.client === "stable" || entry.client === "lazer"))
        return { client: entry.client, provenance: "user-confirmed" };
    } catch { /* Match the existing loader: malformed optional origin entries convey no evidence. */ }
    return undefined;
  };
  const sessions=new LibraryResourceSessions({
    prepareReplay: (ticket, signal, checkpoint) => prepareLibraryReplay(ticket, native, decoder.decode, signal, origin, checkpoint,
      {savedCauseEvidence:!config.background,includeAssets:!config.background}),
    prepareMap: prepareLibraryMap,
    ...(config.background&&admission?{
      preparePerformanceMap:prepareLibraryPerformanceMap,
      preparePerformanceScore:(ticket:LibraryOpenLocation,signal:AbortSignal,checkpoint:()=>Promise<void>)=>prepareLibraryPerformanceScore(ticket,decoder.decode,signal,origin,checkpoint),
      calculatePerformance:(request:PerformanceRequest,signal:AbortSignal)=>calculateLibraryPerformance(()=>config.nativeExecutable,admission,request,signal),
    }:{}),
    close: async () => {
      const results = await Promise.allSettled([native.close(), decoder.close()]);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  },{background:config.background});return sessions;
}

/** Internal main-to-foreground-utility protocol. Never accepts renderer paths or starts indexing. */
export class LibraryResourceServer {
  private sessions?: LibraryResourceSessions;
  private configuration?: LibraryResourceConfiguration;
  private passiveNative?: Pick<LazerSource, "resolveScore" | "resolveArtwork" | "close">;
  private readonly passivePending = new Map<string, { controller: AbortController; work: Promise<unknown> }>();
  private readonly pending = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly send: (response: LibraryUtilityResponse) => void,
    private readonly create: (config: LibraryResourceConfiguration,admission?:LibraryNativeAdmission) => LibraryResourceSessions = createSessions,
    private readonly nativeAdmission?:LibraryNativeAdmission,
    private readonly createPassiveNative: (config: LibraryResourceConfiguration, admission: LibraryNativeAdmission) => Pick<LazerSource, "resolveScore" | "resolveArtwork" | "close"> =
      (config, admission) => new LazerSource(() => config.nativeExecutable, admission)) {}
  async receive(value: unknown): Promise<void> {
    if (!record(value) || !text(value.id)) return;
    const id = value.id; let admitted = false, response: LibraryUtilityResponse;
    try {
      if (value.version !== 1 || !text(value.method) || !record(value.args) || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
        throw new Error("Invalid resource request");
      if (this.pending.has(id) || this.pending.size >= 64 || (this.pending.size >= 32 && !["release", "close", "control"].includes(value.method)))
        throw new Error("Resource request queue is busy");
      this.pending.add(id); admitted = true;
      const data = await this.dispatch(value.method, value.args);
      response = { version: 1, id, ok: true, data };
      // The only binary reply is an exact-size, already bounded chunk. Never JSON-stringify it.
      if (value.method !== "chunk" && Buffer.byteLength(JSON.stringify(response)) > 2 * 1024 * 1024)
        throw new Error("Resource response exceeds limit");
    } catch (error) { response = { version: 1, id, ok: false, error: (error instanceof Error ? error.message : "Resource request failed").slice(0, 2048) }; }
    finally { if (admitted) this.pending.delete(id); }
    this.send(response);
  }
  private async dispatch(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (method === "close") { await this.close(); return null; }
    if (this.closed) throw new Error("Resource utility is closed");
    if (method === "initialize") {
      if (this.sessions) throw new Error("Resource utility is already initialized");
      if(args.nativeAdmission!==undefined&&typeof args.nativeAdmission!=="boolean"||args.nativeAdmission&&(!this.nativeAdmission||args.background!==true))throw new Error("Invalid native admission configuration");
      if (!absolute(args.nativeExecutable) || !absolute(args.originFile) || (args.background !== undefined && typeof args.background !== "boolean")) throw new Error("Invalid resource initialization");
      const configuration = { nativeExecutable: args.nativeExecutable, originFile: args.originFile,
        ...(args.background !== undefined ? {background:args.background as boolean} : {}), ...(args.nativeAdmission ? { nativeAdmission: true } : {}) };
      this.sessions = this.create(configuration,args.nativeAdmission?this.nativeAdmission:undefined); this.configuration = configuration; return null;
    }
    if (!this.sessions) throw new Error("Resource utility is not initialized");
    if (method === "control") {
      if (typeof args.viewerDemand !== "boolean" || typeof args.userPaused !== "boolean") throw new Error("Invalid background resource control");
      return this.sessions.control({viewerDemand:args.viewerDemand,userPaused:args.userPaused});
    }
    if (!text(args.sessionId)) throw new Error("Invalid resource session identity");
    if (method === "resolve-passive-native" || method === "resolve-passive-artwork") {
      if (!this.configuration?.background || !this.configuration.nativeAdmission || !this.nativeAdmission) throw Error("Passive native resources require broker admission");
      if (!replayTicket(args.ticket) || args.ticket.kind !== "lazer" || args.ticket.sha256 === null || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(args.ticket.sourceKey)) throw Error("Invalid passive native replay ticket");
      if (this.passivePending.size) throw Error("Passive native resolver is busy");
      const ticket = args.ticket, sessionId = args.sessionId, expectedReplaySha256 = args.ticket.sha256;
      const native = this.passiveNative ??= this.createPassiveNative(this.configuration, this.nativeAdmission);
      const controller = new AbortController(), pending = { controller, work: Promise.resolve<unknown>(undefined) };
      const artwork=method==="resolve-passive-artwork",timer=artwork?setTimeout(()=>controller.abort(Error("Passive artwork resolution timed out")),15_000):undefined;
      this.passivePending.set(sessionId, pending);
      pending.work = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const result = await native.resolveScore(ticket.directory, ticket.sourceKey, expectedReplaySha256, controller.signal,...(artwork?[{includeAssets:false}]:[]));
        controller.signal.throwIfAborted();
        if (!result.ok || result.status !== "ready" || result.scores?.length !== 1 || result.scores[0].id !== ticket.sourceKey || result.scores[0].replay.sha256 !== ticket.sha256) throw Error("Passive native source changed or is unavailable");
        const score=result.scores[0];if(!artwork)return score;
        const map=score.beatmap,evidence=sourceMapEvidence(ticket);
        if(!map||!["available","unverified"].includes(map.status)||typeof map.path!=="string"||typeof map.sha256!=="string"||typeof map.md5!=="string"||
          !hash(map.sha256,64)||!hash(map.md5,32)||score.assetManifestComplete!==false||!Array.isArray(score.assets)||score.assets.length!==0||
          evidence.headerMd5&&evidence.headerMd5!==map.md5||evidence.sourceMd5&&evidence.sourceMd5!==map.md5)throw Error("Passive artwork map declaration changed");
        const selection=await readVerifiedNativeArtworkName(ticket.directory,{path:map.path,sha256:map.sha256,md5:map.md5},controller.signal);
        if(!selection)return score;
        const targeted=await native.resolveArtwork(ticket.directory,ticket.sourceKey,expectedReplaySha256,selection,controller.signal);
        controller.signal.throwIfAborted();
        if(!targeted.ok||targeted.status!=="ready"||targeted.scores?.length!==1||targeted.scores[0].id!==ticket.sourceKey||targeted.scores[0].replay.sha256!==expectedReplaySha256||
          !matchesLibraryArtworkLookup(targeted.scores[0],selection))throw Error("Passive artwork lookup changed or is incomplete");
        return targeted.scores[0];
      });
      try { return await pending.work; } finally { clearTimeout(timer);if (this.passivePending.get(sessionId) === pending) this.passivePending.delete(sessionId); }
    }
    if (this.passivePending.has(args.sessionId) && method !== "release") throw Error("Passive native session is already in use");
    if (method === "describe-analysis") return this.sessions.describeAnalysis(args.sessionId);
    if(method==="performance-score"){
      if(args.candidate!==undefined&&!replayTicket(args.candidate))throw new Error("Invalid P score candidate");
      return this.sessions.readPerformanceScore(args.sessionId,args.candidate as LibraryOpenLocation|undefined);
    }
    if(method==="begin-performance"){
      if(!replayTicket(args.ticket)||args.candidate!==undefined&&!mapTicket(args.candidate))throw new Error("Invalid P resource ticket");
      return this.sessions.beginPerformance(args.sessionId,args.ticket,args.candidate as LibraryOpenMap|undefined);
    }
    if(method==="calculate-performance"){
      if(!Array.isArray(args.calculations)||args.calculations.length<1||args.calculations.length>3||
        Buffer.byteLength(JSON.stringify(args.calculations))>65536)throw new Error("Invalid compact P request");
      return this.sessions.calculatePerformance(args.sessionId,args.calculations as PerformanceRequest["calculations"]);
    }
    if (method === "release") {
      const passive = this.passivePending.get(args.sessionId); passive?.controller.abort();
      if (passive) await passive.work.catch(error => { if (error instanceof LibraryNativeDrainError) throw error; });
      this.sessions.release(args.sessionId); return null;
    }
    if (method === "begin") {
      if (!replayTicket(args.ticket)) throw new Error("Invalid replay resource ticket");
      return this.sessions.begin(args.sessionId, args.ticket);
    }
    if (method === "prepare-map") {
      if (args.candidate !== undefined && !mapTicket(args.candidate)) throw new Error("Invalid map resource ticket");
      return this.sessions.prepareMap(args.sessionId, args.candidate as LibraryOpenMap | undefined);
    }
    if (method === "transfer") {
      if (!["replay", "map", "asset"].includes(String(args.kind)) || (args.kind === "asset" && !text(args.name, 512)))
        throw new Error("Invalid resource transfer");
      return this.sessions.openTransfer(args.sessionId, args.kind as "replay" | "map" | "asset", args.name as string | undefined);
    }
    if (method === "chunk") {
      if (!text(args.transferId) || !revision(args.offset)) throw new Error("Invalid resource chunk request");
      return this.sessions.readChunkAsync(args.sessionId, args.transferId, Number(args.offset));
    }
    throw new Error("Unknown resource operation");
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true; for (const pending of this.passivePending.values()) pending.controller.abort();
      this.closing = (async () => {
        const results = await Promise.allSettled([this.sessions?.close(), this.passiveNative?.close(),
          ...[...this.passivePending.values()].map(pending => pending.work.catch(error => { if (error instanceof LibraryNativeDrainError) throw error; }))]);
        const failure = results.find(result => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
      })();
    }
    return this.closing;
  }
}
