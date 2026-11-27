import { randomUUID } from "crypto";
import type { LibraryOpenLocation, LibraryOpenMap } from "./library-store";
import type { PreparedLibraryReplay, PreparedLibraryMap } from "./library-selected-resources";
import { LibraryAssetUnavailableError } from "./library-resource-errors";
import { LibraryAnalysisGate, LibraryYieldAcknowledgement } from "../../../../shared/library-analysis-gate";
import { setImmediate } from "timers/promises";
import { describeLibraryNumericalResources } from "./library-analysis-binding";
import type { LibraryPerformanceMapResource } from "./library-performance-map-resource";
import type { PerformanceRequest,PerformanceResponse } from "@rewind/osu-performance/protocol";
import { LibraryNativeDrainError } from "./library-native-admission";
import type { LibraryPerformanceScoreEvidence } from "./library-performance-score";
import { performanceMapMd5 } from "./library-performance-map-resource";
import type { LibraryIncidentEvidenceProbe } from "./library-incidents-probe";
import type { LibraryPerformanceSessionWorker } from "./library-performance-session-worker";
import type { LibrarySchedulerControl } from "./library-scheduler";
import type { LazerSourceInspection } from "./sources/lazer-source";

type PerformanceWorker = Pick<LibraryPerformanceSessionWorker, "calculate" | "setHeld" | "close">;
const viewerInterruption = new Error("Selected source lookup yielded to the viewer");
const deferredGrant = new Error("Selected source lookup grant arrived during a hold");
interface SelectedSourceAttempt {
  controller: AbortController;
  preemptible: boolean;
  granted: boolean;
  result?: Promise<LazerSourceInspection>;
}
interface ResourceDependencies {
  prepareReplay(ticket: LibraryOpenLocation, signal: AbortSignal, checkpoint: () => Promise<void>): Promise<PreparedLibraryReplay>;
  prepareMap(replay: PreparedLibraryReplay, map: LibraryOpenMap | undefined, signal: AbortSignal, checkpoint: () => Promise<void>): Promise<PreparedLibraryMap>;
  preparePerformanceMap?(ticket:LibraryOpenLocation,map:LibraryOpenMap|undefined,signal:AbortSignal,checkpoint:()=>Promise<void>):Promise<LibraryPerformanceMapResource>;
  preparePerformanceScore?(ticket:LibraryOpenLocation,signal:AbortSignal,checkpoint:()=>Promise<void>):Promise<LibraryPerformanceScoreEvidence>;
  createPerformanceWorker?(beatmap: string, signal: AbortSignal): PerformanceWorker;
  probeIncidentEvidence?(ticket:LibraryOpenLocation,signal:AbortSignal,checkpoint:()=>Promise<void>):Promise<LibraryIncidentEvidenceProbe>;
  /** Close the owned native resolver and decoder; reject when actual exit cannot be confirmed. */
  close?(): Promise<void>;
}
interface Session {
  controller: AbortController;
  replay?: PreparedLibraryReplay;
  map?: PreparedLibraryMap;
  performance?:LibraryPerformanceMapResource;
  performanceWorker?: PerformanceWorker;
  performanceScore?:LibraryPerformanceScoreEvidence;
  performanceScoreKey?:string;
  replayBytes?: Buffer;
  transfer?: { id: string; kind: "replay" | "map" | "asset"; bytes: Buffer; offset: number };
}

/** Foreground resource ownership, separate from SQLite/indexing and current performance workers.
 * Two sessions retain the current replay while preparing its replacement. Consumers serialize
 * complete transfers per session; chunks own exact-size buffers rather than a view of a large backing store. */
export class LibraryResourceSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly operations = new Set<Promise<unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  private nativeFailure?:LibraryNativeDrainError;
  private performanceSession?: Session;
  private performanceDrain?: { id: string; done: Promise<void> };
  private selectedSourceAttempt?: SelectedSourceAttempt;
  private controlRevision = 0;
  private readonly gate?: LibraryAnalysisGate;
  constructor(private readonly dependencies: ResourceDependencies, options: { background?: boolean } = {}) {
    if (options.background) { this.gate = new LibraryAnalysisGate(() => setImmediate()); void this.gate.control({viewerDemand:true,userPaused:false}); }
  }
  control(value: LibrarySchedulerControl): Promise<LibraryYieldAcknowledgement> {
    if (!this.gate) return Promise.reject(new Error("Foreground resources do not accept background controls"));
    if (this.closing) return this.closing.then(() => "idle");
    const revision = ++this.controlRevision;
    const computation = this.gate.control(value);
    const held = value.viewerDemand || value.userPaused;
    const worker = this.performanceSession?.performanceWorker;
    const source = held && this.selectedSourceAttempt?.granted ? this.selectedSourceAttempt : undefined;
    if (value.viewerActive && source?.preemptible) source.controller.abort(viewerInterruption);
    if (!worker && !this.performanceDrain && !source && !this.nativeFailure) return computation;
    // The computation may park while the helper still owns its native permit.
    return Promise.all([computation, worker?.setHeld(held), held ? this.performanceDrain?.done : undefined, source?.result]).then(([state]) => {
      if (this.nativeFailure) throw this.nativeFailure;
      return revision === this.controlRevision ? state : "superseded";
    }, error => { this.noteNativeFailure(error); throw error; });
  }
  private checkpoint = (): Promise<void> => this.gate?.checkpoint() ?? setImmediate();
  /** Park on the individual result. A retained lease must drain independently of this gate. */
  waitForNative<T>(work:Promise<T>):Promise<T>{return this.gate?this.gate.waitForExternal(work):work;}
  private noteNativeFailure(error: unknown): void {
    if (error instanceof LibraryNativeDrainError) this.nativeFailure ??= error;
  }

  async resolveSelectedSource(signal: AbortSignal | undefined,
    resolve: (signal: AbortSignal) => Promise<LazerSourceInspection>): Promise<LazerSourceInspection> {
    if (!signal || !this.gate || this.selectedSourceAttempt) throw new Error("Selected source lookup requires one background resource owner");
    let preemptible = true;
    for (;;) {
      signal.throwIfAborted();
      const controller = new AbortController();
      const attempt: SelectedSourceAttempt = this.selectedSourceAttempt = { controller, preemptible, granted: false };
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await this.waitForNative(attempt.result = resolve(controller.signal));
        signal.throwIfAborted();
        if (controller.signal.reason !== viewerInterruption || result.status !== "cancelled") return result;
        preemptible = false;
      } catch (error) {
        if (error !== deferredGrant) throw error;
        await this.checkpoint();
      } finally {
        signal.removeEventListener("abort", abort);
        this.selectedSourceAttempt = undefined;
      }
    }
  }

  async withSelectedSourceGrant<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const attempt = this.selectedSourceAttempt;
    if (!attempt || attempt.controller.signal !== signal) return work();
    // A queued lookup can race with a hold between grant and execution. Yield the
    // unused permit before parking and keep the allowance for a real helper.
    if (this.gate?.status().held) throw deferredGrant;
    attempt.granted = true;
    try { return await work(); }
    finally { attempt.granted = false; }
  }

  /** Every call owns a fresh, disposable session. No decoded replay or evidence graph is retained. */
  async probeIncidentEvidence(id:string,ticket:LibraryOpenLocation):Promise<LibraryIncidentEvidenceProbe> {
    if(!this.gate||!this.dependencies.probeIncidentEvidence)throw new Error("Incident evidence probes require background resources");
    if(this.closed)throw new Error("Resource sessions closed");
    if(!id||id.length>128||this.sessions.has(id)||this.sessions.size>=2||this.performanceSession||this.performanceDrain)throw new Error("Invalid incident evidence session");
    const session:Session={controller:new AbortController()};this.sessions.set(id,session);
    try{return await this.run(id,signal=>this.dependencies.probeIncidentEvidence!(ticket,signal,this.checkpoint));}
    finally{if(this.sessions.get(id)===session)await this.release(id);}
  }

  async beginPerformance(id:string,ticket:LibraryOpenLocation,candidate?:LibraryOpenMap) {
    if(!this.gate||!this.dependencies.preparePerformanceMap||!this.dependencies.createPerformanceWorker)throw new Error("P resources require background native ownership");
    if(this.closed)throw new Error("Resource sessions closed");
    if(this.nativeFailure)throw this.nativeFailure;
    // A P utility peer can own only one native lease. Other resource methods keep their existing two-session limit.
    if(!id||id.length>128||this.sessions.size||this.performanceDrain)throw new Error("Invalid performance resource session");
    const session:Session={controller:new AbortController()};this.sessions.set(id,session);this.performanceSession=session;
    try{return await this.run(id,async signal=>{
      const resource=await this.dependencies.preparePerformanceMap!(ticket,candidate,signal,this.checkpoint);signal.throwIfAborted();
      session.performance=resource;
      return{sessionId:id,md5:resource.map.md5,sha256:resource.map.sha256,bytes:Buffer.byteLength(resource.map.text),mapTicket:resource.mapTicket,...resource.metadata};
    });}catch(error){if(this.sessions.get(id)===session)await this.release(id);throw error;}
  }
  calculatePerformance(id:string,calculations:PerformanceRequest["calculations"]):Promise<PerformanceResponse> {
    return this.run(id,async signal=>{
      const session=this.session(id);
      if(!this.gate||!session.performance||!this.dependencies.createPerformanceWorker)throw new Error("P background map resources are unavailable");
      if(!Array.isArray(calculations)||calculations.length<1||calculations.length>3||calculations.some(item=>
        !item||item.scope!=="full-map"||!Array.isArray(item.states)||item.states.length>1))throw new Error("P requires bounded full-map calculations");
      const beatmap = session.performance.map.text;
      const worker = session.performanceWorker ??= this.dependencies.createPerformanceWorker(beatmap, signal);
      return this.waitForNative(worker.calculate({ beatmap, calculations }));
    });
  }
  readPerformanceScore(id:string,candidate?:LibraryOpenLocation):Promise<LibraryPerformanceScoreEvidence> {
    return this.run(id,async signal=>{
      const session=this.session(id);
      if(!this.gate||!session.performance||!this.dependencies.preparePerformanceScore)throw new Error("P background score resources are unavailable");
      const location=candidate??session.performance.location;
      if(candidate&&(candidate.replayId!==session.performance.location.replayId||performanceMapMd5(candidate)!==session.performance.map.md5||
        session.performance.location.sha256&&candidate.sha256!==session.performance.location.sha256))throw new Error("P score candidate identity mismatch");
      const key=JSON.stringify([location.sourceId,location.sourceKey,location.locationRevision,location.sourceConfigRevision,location.sha256]);
      if(!session.performanceScore||session.performanceScoreKey!==key){
        // Score preparation may need the same broker peer for native decoding.
        if (session.performanceWorker) {
          await this.waitForNative(session.performanceWorker.close());
          session.performanceWorker = undefined;
        }
        session.performanceScore=await this.dependencies.preparePerformanceScore(location,signal,this.checkpoint);session.performanceScoreKey=key;
      }
      signal.throwIfAborted();return session.performanceScore;
    });
  }

  async begin(id: string, ticket: LibraryOpenLocation) {
    if (this.closed) throw new Error("Resource sessions closed");
    if (this.performanceSession || this.performanceDrain) throw new Error("Performance resource session owns this peer");
    if (!id || id.length > 128 || this.sessions.has(id)) throw new Error("Invalid resource session identity");
    if (this.sessions.size >= 2) throw new Error("Resource session limit reached");
    const session: Session = { controller: new AbortController() };
    this.sessions.set(id, session);
    try {
      return await this.run(id, async signal => {
        const replay = await this.dependencies.prepareReplay(ticket, signal, this.checkpoint); signal.throwIfAborted();
        await this.checkpoint();
        const json = JSON.stringify(replay.data);
        if (Buffer.byteLength(json) > 64 * 1024 * 1024) throw new Error("Selected replay envelope exceeds resource limit");
        const replayBytes = Buffer.from(json);
        signal.throwIfAborted();
        // The frame string now lives only in the transfer buffer. Map/media preparation uses header identity.
        session.replay = { ...replay, data: { ...replay.data, replay_data: "" } };
        session.replayBytes = replayBytes;
        return { sessionId: id, beatmapMd5: replay.data.beatmapMD5, receipt: replay.receipt,
          nativeMap: !!replay.nativeScore?.beatmap.path && ["available", "unverified"].includes(replay.nativeScore.beatmap.status) };
      });
    } catch (error) { if (this.sessions.get(id) === session) await this.release(id); throw error; }
  }

  prepareMap(id: string, candidate?: LibraryOpenMap) {
    return this.run(id, async signal => {
      const session = this.session(id);
      if (!session.replay) throw new Error("Replay preparation is incomplete");
      if (session.map) throw new Error("Selected map is already prepared");
      const map = await this.dependencies.prepareMap(session.replay, candidate, signal, this.checkpoint); signal.throwIfAborted();
      session.map = map;
      return { md5: map.map.md5, sha256: map.map.sha256, bytes: map.map.bytes.length, ticket: map.ticket,
        storyboards: map.storyboards, assetManifestComplete: map.assetManifestComplete };
    });
  }

  openTransfer(id: string, kind: "replay" | "map" | "asset", name?: string) {
    return this.run(id, async signal => {
      const session = this.session(id);
      if (session.transfer) throw new Error("Resource transfer is busy");
      if (!session.map) throw new Error("Selected map is not prepared");
      let bytes: Buffer;
      if (kind === "replay") {
        if (!session.replayBytes) throw new Error("Replay transfer has been consumed");
        bytes = session.replayBytes;
      } else if (kind === "map") bytes = session.map.map.bytes;
      else if (kind === "asset" && typeof name === "string") {
        try { bytes = (await session.map.readAsset(name, signal)).bytes; }
        catch (error) {
          signal.throwIfAborted();
          if (error instanceof LibraryAssetUnavailableError) return { id: "", bytes: 0, unavailable: true as const };
          throw error;
        }
      }
      else throw new Error("Invalid resource transfer");
      signal.throwIfAborted();
      if (bytes.byteLength > 128 * 1024 * 1024) throw new Error("Resource transfer exceeds byte limit");
      const transfer = { id: randomUUID(), kind, bytes, offset: 0 };
      session.transfer = bytes.length ? transfer : undefined;
      return { id: transfer.id, bytes: bytes.byteLength };
    });
  }
  describeAnalysis(id: string) {
    // Reads only the already verified, retained resources. Foreground reuse does not
    // acquire background admission, run a simulation or request another native result.
    return this.run(id, async () => {
      const session=this.session(id);
      if (!session.replay || !session.map || !session.replayBytes) throw new Error("Analysis resources are incomplete or consumed");
      return describeLibraryNumericalResources(session.replay,session.map,session.replayBytes.length,this.gate!==undefined);
    });
  }

  readChunk(id: string, transferId: string, offset: number): { bytes: Uint8Array; done: boolean } {
    if (this.gate) throw new Error("Background resource chunks require asynchronous admission");
    return this.takeChunk(id,transferId,offset);
  }
  private takeChunk(id: string, transferId: string, offset: number): { bytes: Uint8Array; done: boolean } {
    const session = this.session(id), transfer = session.transfer;
    if (!transfer || transfer.id !== transferId) throw new Error("Resource transfer expired");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset !== transfer.offset) throw new Error("Invalid resource transfer offset");
    const bytes = Uint8Array.from(transfer.bytes.subarray(offset, offset + 256 * 1024));
    transfer.offset += bytes.length;
    const done = transfer.offset === transfer.bytes.length;
    if (done) {
      if (transfer.kind === "replay") session.replayBytes = undefined;
      session.transfer = undefined;
    }
    return { bytes, done };
  }

  readChunkAsync(id: string, transferId: string, offset: number): Promise<{bytes: Uint8Array;done:boolean}> {
    return this.gate ? this.run(id, async () => this.takeChunk(id,transferId,offset)) : Promise.resolve(this.readChunk(id,transferId,offset));
  }

  /** Cancellation is immediate; a retained P helper must drain before its peer can be reused. */
  release(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return this.performanceDrain?.id === id ? this.performanceDrain.done : Promise.resolve();
    session.controller.abort();
    session.transfer = undefined; session.map = undefined; session.replay = undefined; session.replayBytes = undefined;session.performance=undefined;session.performanceScore=undefined;
    this.sessions.delete(id);
    if (this.performanceSession === session) this.performanceSession = undefined;
    const worker = session.performanceWorker;
    if (!worker) return Promise.resolve();
    session.performanceWorker = undefined;
    const drain = { id, done: worker.close() };
    this.performanceDrain = drain;
    // Preserve a failed drain so a repeated release cannot acknowledge an unconfirmed exit.
    void drain.done.then(() => { this.performanceDrain = undefined; }, error => this.noteNativeFailure(error));
    return drain.done;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      for (const id of this.sessions.keys()) void this.release(id);
      this.closing = (async () => {
        const results = await Promise.allSettled([Promise.allSettled([...this.operations]), this.dependencies.close?.(), this.performanceDrain?.done]);
        if(this.nativeFailure)throw this.nativeFailure;
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
    }
    return this.closing;
  }

  private session(id: string): Session {
    if (this.closed) throw new Error("Resource sessions closed");
    const session = this.sessions.get(id);
    if (!session) throw new Error("Resource session expired");
    session.controller.signal.throwIfAborted(); return session;
  }
  private run<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      const session = this.session(id);
      if (this.operations.size >= 16) throw new Error("Resource operation queue limit reached");
      const operation = this.tail.then(async () => {
        session.controller.signal.throwIfAborted();
        // Foreground retains its existing wall deadline. Background may stay parked indefinitely;
        // native lookup/decoder keep their own active-operation bounds, with checkpoints between them.
        const deadline = this.gate ? undefined : setTimeout(() => session.controller.abort(new Error("Resource preparation timed out")), 60000);
        try {
          const result = this.gate ? await this.gate.run(() => work(session.controller.signal),session.controller.signal) : await work(session.controller.signal);
          session.controller.signal.throwIfAborted(); return result;
        } catch(error){this.noteNativeFailure(error);throw error;}
        finally { if (deadline) clearTimeout(deadline); }
      });
      this.operations.add(operation);
      this.tail = operation.then(() => undefined, () => undefined);
      void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
      return operation;
    } catch (error) { return Promise.reject(error); }
  }
}
