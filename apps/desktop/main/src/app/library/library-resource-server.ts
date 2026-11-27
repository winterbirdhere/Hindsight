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
import { LibraryPerformanceSessionWorker } from "./library-performance-session-worker";
import type { PerformanceRequest } from "@rewind/osu-performance/protocol";
import { inspectLibraryStableDeletion, prepareLibraryStableDeletion, LibraryStableDeletionCleanupError } from "./library-stable-deletion-resource";
import type { LibraryStableDeletionInspectionRequest, LibraryStableDeletionPreparationRequest } from "./library-stable-deletion-resource";
import { LibraryStableStageRegistry,isLibraryStableStageOwnerProcess } from "./library-stable-deletion-stage";
import type { LibraryStableStageRecovery,LibraryStableStageOwnerProcess } from "./library-stable-deletion-stage";

export interface LibraryResourceConfiguration { nativeExecutable: string; originFile: string; background?: boolean;nativeAdmission?:boolean;deletionAppDirectory?:string;deletionStageOwnerId?:string;deletionRetiredStageOwnerIds?:string[];deletionStageOwnerProcess?:LibraryStableStageOwnerProcess }
export type LibraryResourceOperation = "begin" | "prepare-map" | "transfer" | "chunk" | "release" | "control" | "describe-analysis" | "begin-performance" | "calculate-performance" | "performance-score" | "probe-incident-evidence" | "resolve-passive-native" | "resolve-passive-artwork" | "inspect-stable-deletion" | "prepare-stable-deletion" | "inspect-stable-stages" | "handoff-stable-stage" | "discard-stable-stage" | "recover-stable-stages" | "retire-stable-stage";
const stageIdentity=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
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
  const selectedAdmission: LibraryNativeAdmission | undefined = broker && config.background
    ? { run: (phase, work, signal) => broker.run(phase, () => sessions.withSelectedSourceGrant(signal, work), signal) }
    : admission;
  const native = new LazerSource(() => config.nativeExecutable, selectedAdmission);
  const decoder = new LibraryLzmaClient(() => config.nativeExecutable,undefined,admission);
  const selectedNative: Pick<LazerSource, "resolveScore" | "resolveProvisionalScore"> = broker && config.background ? {
    resolveScore: (directory, scoreId, sha256, signal, options) =>
      sessions.resolveSelectedSource(signal, attempt => native.resolveScore(directory, scoreId, sha256, attempt, options)),
    resolveProvisionalScore: (directory, scoreId, signal, options) =>
      sessions.waitForNative(native.resolveProvisionalScore(directory, scoreId, signal, options)),
  } : native;
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
  const sessions: LibraryResourceSessions = new LibraryResourceSessions({
    prepareReplay: (ticket, signal, checkpoint) => prepareLibraryReplay(ticket, selectedNative, decoder.decode, signal, origin, checkpoint,
      {savedCauseEvidence:!config.background,includeAssets:!config.background}),
    prepareMap: prepareLibraryMap,
    ...(config.background&&broker?{
      preparePerformanceMap:prepareLibraryPerformanceMap,
      preparePerformanceScore:(ticket:LibraryOpenLocation,signal:AbortSignal,checkpoint:()=>Promise<void>)=>prepareLibraryPerformanceScore(ticket,decoder.decode,signal,origin,checkpoint),
      createPerformanceWorker:(beatmap:string,signal:AbortSignal)=>new LibraryPerformanceSessionWorker(()=>config.nativeExecutable,broker,beatmap,signal),
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
  private readonly stablePending = new Map<string, { controller: AbortController; work: Promise<unknown> }>();
  private stages?:LibraryStableStageRegistry;
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
      if(args.deletionAppDirectory!==undefined&&(!absolute(args.deletionAppDirectory)||args.background!==true))throw Error("Invalid Stable deletion resource configuration");
      if(args.deletionAppDirectory!==undefined&&(!stageIdentity(args.deletionStageOwnerId)||!isLibraryStableStageOwnerProcess(args.deletionStageOwnerProcess)||args.deletionStageOwnerProcess.pid!==process.pid)||args.deletionAppDirectory===undefined&&(args.deletionStageOwnerId!==undefined||args.deletionRetiredStageOwnerIds!==undefined||args.deletionStageOwnerProcess!==undefined)||
        args.deletionRetiredStageOwnerIds!==undefined&&(!Array.isArray(args.deletionRetiredStageOwnerIds)||args.deletionRetiredStageOwnerIds.length>16||args.deletionRetiredStageOwnerIds.some(id=>!stageIdentity(id))||new Set(args.deletionRetiredStageOwnerIds).size!==args.deletionRetiredStageOwnerIds.length))throw Error("Invalid Stable stage owner authority");
      const configuration = { nativeExecutable: args.nativeExecutable, originFile: args.originFile,
        ...(args.background !== undefined ? {background:args.background as boolean} : {}), ...(args.nativeAdmission ? { nativeAdmission: true } : {}),
        ...(args.deletionAppDirectory!==undefined?{deletionAppDirectory:args.deletionAppDirectory as string,deletionStageOwnerId:args.deletionStageOwnerId as string,deletionStageOwnerProcess:args.deletionStageOwnerProcess as unknown as LibraryStableStageOwnerProcess,
          ...(args.deletionRetiredStageOwnerIds!==undefined?{deletionRetiredStageOwnerIds:args.deletionRetiredStageOwnerIds as string[]}:{})}:{}) };
      this.sessions = this.create(configuration,args.nativeAdmission?this.nativeAdmission:undefined); this.configuration = configuration; return null;
    }
    if (!this.sessions) throw new Error("Resource utility is not initialized");
    if (method === "control") {
      if (typeof args.viewerDemand !== "boolean" || typeof args.userPaused !== "boolean" ||
          args.viewerActive !== undefined && typeof args.viewerActive !== "boolean" || args.viewerActive === true && !args.viewerDemand)
        throw new Error("Invalid background resource control");
      return this.sessions.control({viewerDemand:args.viewerDemand,userPaused:args.userPaused,
        ...(args.viewerActive === true ? {viewerActive:true} : {})});
    }
    if (!text(args.sessionId)) throw new Error("Invalid resource session identity");
    if(["inspect-stable-stages","handoff-stable-stage","discard-stable-stage","recover-stable-stages","retire-stable-stage"].includes(method)){
      if(!this.configuration?.deletionAppDirectory||!this.configuration.deletionStageOwnerId||!this.configuration.background)throw Error("Stable stage custody requires trusted initialization");
      if(this.stablePending.size||this.passivePending.size)throw Error("Stable resource custody is busy");
      const registry=this.stages??=new LibraryStableStageRegistry(this.configuration.deletionAppDirectory,this.configuration.deletionStageOwnerId,this.configuration.deletionRetiredStageOwnerIds,this.configuration.deletionStageOwnerProcess);
      const {sessionId,...request}=args,controller=new AbortController(),pending={controller,work:Promise.resolve<unknown>(undefined)};
      const allowed=method==="inspect-stable-stages"?[]:method==="recover-stable-stages"?["complete","retiredOwnerIds","protectedStages"]:
        ["stageId","fingerprint",...(method==="handoff-stable-stage"||method==="retire-stable-stage"?["intentId","intentFingerprint"]:[]),...(method==="retire-stable-stage"?["cleanupFingerprint"]:[])];
      if(Object.keys(request).some(key=>!allowed.includes(key))||!["inspect-stable-stages","recover-stable-stages"].includes(method)&&(!stageIdentity(request.stageId)||!hash(request.fingerprint,64))||
        ["handoff-stable-stage","retire-stable-stage"].includes(method)&&(!stageIdentity(request.intentId)||!hash(request.intentFingerprint,64))||method==="retire-stable-stage"&&!hash(request.cleanupFingerprint,64))throw Error("Invalid trusted stage custody request");
      this.stablePending.set(sessionId,pending);
      pending.work=Promise.resolve().then<unknown>(()=>{
        controller.signal.throwIfAborted();
        if(method==="inspect-stable-stages")return registry.inventory();
        if(method==="recover-stable-stages")return registry.recover(request as unknown as LibraryStableStageRecovery);
        if(method==="handoff-stable-stage")return registry.handoff(String(request.stageId),String(request.fingerprint),{intentId:String(request.intentId),intentFingerprint:String(request.intentFingerprint)});
        if(method==="discard-stable-stage")return registry.discard(String(request.stageId),String(request.fingerprint));
        return registry.retire(String(request.stageId),String(request.fingerprint),{intentId:String(request.intentId),intentFingerprint:String(request.intentFingerprint),cleanupFingerprint:String(request.cleanupFingerprint)});
      });
      try{return await pending.work;}finally{if(this.stablePending.get(sessionId)===pending)this.stablePending.delete(sessionId);}
    }
    if(method==="inspect-stable-deletion"||method==="prepare-stable-deletion"){
      if(!this.configuration?.deletionAppDirectory||!this.configuration.deletionStageOwnerId||!this.configuration.background)throw Error("Stable deletion resources require trusted staging configuration");
      if(this.stablePending.size||this.passivePending.size)throw Error("Stable deletion resource is busy");
      const appDirectory=this.configuration.deletionAppDirectory;
      const registry=this.stages??=new LibraryStableStageRegistry(appDirectory,this.configuration.deletionStageOwnerId,this.configuration.deletionRetiredStageOwnerIds,this.configuration.deletionStageOwnerProcess);
      const lifecycle={ownerId:this.configuration.deletionStageOwnerId,retiredOwnerIds:this.configuration.deletionRetiredStageOwnerIds,ownerProcess:this.configuration.deletionStageOwnerProcess,registry};
      const {sessionId,...request}=args,controller=new AbortController(),pending={controller,work:Promise.resolve<unknown>(undefined)};
      this.stablePending.set(sessionId,pending);
      pending.work=Promise.resolve().then<unknown>(()=>method==="inspect-stable-deletion"
        ?inspectLibraryStableDeletion(request as unknown as LibraryStableDeletionInspectionRequest,controller.signal)
        :prepareLibraryStableDeletion(appDirectory,request as unknown as LibraryStableDeletionPreparationRequest,controller.signal,undefined,lifecycle));
      try{return await pending.work;}finally{if(this.stablePending.get(sessionId)===pending)this.stablePending.delete(sessionId);}
    }
    if(this.stablePending.size&&method!=="release")throw Error("Stable deletion resource is busy");
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
      const stable=this.stablePending.get(args.sessionId);stable?.controller.abort();
      if(stable)await stable.work.catch(error=>{if(error instanceof LibraryStableDeletionCleanupError)throw error;});
      const passive = this.passivePending.get(args.sessionId); passive?.controller.abort();
      if (passive) await passive.work.catch(error => { if (error instanceof LibraryNativeDrainError) throw error; });
      await this.sessions.release(args.sessionId); return null;
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
      for(const pending of this.stablePending.values())pending.controller.abort();
      this.closing = (async () => {
        const results = await Promise.allSettled([this.sessions?.close(), this.passiveNative?.close(),
          ...[...this.passivePending.values()].map(pending => pending.work.catch(error => { if (error instanceof LibraryNativeDrainError) throw error; })),
          ...[...this.stablePending.values()].map(pending=>pending.work.catch(error=>{if(error instanceof LibraryStableDeletionCleanupError)throw error;}))]);
        const failure = results.find(result => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
      })();
    }
    return this.closing;
  }
}
