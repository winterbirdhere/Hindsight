import { createHash, randomUUID } from "crypto";
import { win32 } from "path";
import type { LibraryServiceConfiguration, LibraryConfiguredSource } from "./library-service";
import type { LibraryOperation } from "./library-process-client";

export interface LibraryChildOwner {
  onAnalysisDirty?(observer:(flags:number)=>void):()=>void;
  start(): Promise<unknown>;
  request(method: LibraryOperation, args?: Record<string, unknown>, assertCurrent?:()=>void): Promise<unknown>;
  setViewerDemand(active: boolean): Promise<void>;
  close(): Promise<void>;
}
export interface LibraryInstallationConfiguration {
  stable?: { directory: string; songsRoot: string } | null;
  lazerDirectory?: string;
}
interface OwnerPaths { directory: string; appData: string; nativeExecutable: string; sessionId?: string; originFile?: string }

const directory = (value: unknown): string => {
  if (typeof value !== "string" || !value || value.length > 32768 || value.includes(String.fromCharCode(0)) || !win32.isAbsolute(value))
    throw new Error("Invalid library installation configuration");
  const normalized = win32.normalize(value).toLowerCase();
  const root = win32.parse(normalized).root;
  return normalized.length > root.length ? normalized.replace(/\\+$/, "") : normalized;
};
const identity = (kind: string, ...paths: string[]) => kind + ":" + createHash("sha256").update(JSON.stringify(paths.map(path => path.toLowerCase()))).digest("hex");

/** Main-process lifetime, distinct from renderer mounts/reloads. Reconfiguration is serialized;
 * replacement cannot acquire SQLite until the previous owner has observed its process exit. */
export class LibraryMainOwner {
  private child?: LibraryChildOwner;
  private retirement?: Promise<void>;
  private key?: string;
  private configuration?: LibraryServiceConfiguration;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  private demand = false;
  private admitted = 0;
  private readonly sessionId: string;
  constructor(private readonly paths: OwnerPaths, private readonly create: (config: LibraryServiceConfiguration) => LibraryChildOwner) {
    this.sessionId = paths.sessionId ?? randomUUID();
  }
  get active(): boolean { return this.child !== undefined; }
  private build(input: LibraryInstallationConfiguration): LibraryServiceConfiguration {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid library installation configuration");
    const sources: LibraryConfiguredSource[] = [];
    const existingStable = this.configuration?.sources.find(source => source.kind === "stable");
    const stable = input.stable === undefined ? existingStable : input.stable;
    if (stable) {
      const root = directory(stable.directory), songsRoot = directory(stable.songsRoot), replays = win32.join(root, "replays");
      sources.push({ id: identity("stable", root, songsRoot), kind: "stable", directory: root, songsRoot, configuration: "configured" },
        { id: identity("replays", replays), kind: "replays", directory: replays, configuration: "configured" });
    }
    const existingNative = this.configuration?.sources.find(source => source.kind === "lazer");
    const native = directory(input.lazerDirectory ?? existingNative?.directory ?? win32.join(this.paths.appData, "osu"));
    const configuration = input.lazerDirectory !== undefined ? "configured" : existingNative?.configuration ?? "automatic";
    sources.push({ id: identity("lazer", native), kind: "lazer", directory: native, configuration });
    return { directory: directory(this.paths.directory), nativeExecutable: directory(this.paths.nativeExecutable), sessionId: this.sessionId, sources,
      ...(this.paths.originFile ? { originFile: directory(this.paths.originFile) } : {}) };
  }
  async configure(input: LibraryInstallationConfiguration): Promise<void> {
    if (this.closed) throw new Error("Library owner is closed");
    // Validate/copy caller input now; resolve omitted fields only when this serialized turn runs.
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid library installation configuration");
    const stable = input.stable === undefined || input.stable === null ? input.stable
      : { directory: directory(input.stable.directory), songsRoot: directory(input.stable.songsRoot) };
    const lazerDirectory = input.lazerDirectory === undefined ? undefined : directory(input.lazerDirectory);
    return this.enqueue(() => this.build({ stable, lazerDirectory }), false);
  }
  private enqueue(configuration: () => LibraryServiceConfiguration, force: boolean): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Library owner is closed"));
    if (this.admitted >= 16) return Promise.reject(new Error("Library configuration queue is busy"));
    this.admitted++;
    const work = this.tail.then(async () => {
      if (this.closed) throw new Error("Library owner is closed");
      const config = configuration();
      const key = JSON.stringify(config);
      if (!force && key === this.key && this.child) { await this.child.start(); return; }
      const previous = this.child;
      if (previous) {
        this.child = undefined; this.key = undefined;
        this.retirement = previous.close();
        try { await this.retirement; } finally { this.retirement = undefined; }
      }
      if (this.closed) throw new Error("Library owner is closed");
      const child = this.create(config); this.child = child; this.key = key; this.configuration = config;
      await child.setViewerDemand(this.demand);
      if (this.closed) throw new Error("Library owner is closed");
      await child.start();
      if (this.closed) throw new Error("Library owner is closed");
      await child.request("start-updates");
    }).finally(() => { this.admitted--; });
    this.tail = work.catch(() => undefined); return work;
  }
  retry(): Promise<void> {
    return this.enqueue(() => {
      if (!this.configuration) throw new Error("Library is not configured");
      return this.configuration;
    }, true);
  }
  async request(method: LibraryOperation, args: Record<string, unknown> = {}, assertCurrent?:()=>void): Promise<unknown> {
    if (this.closed) throw new Error("Library owner is closed");
    await this.tail;
    if (this.closed || !this.child) throw new Error("Library is not configured");
    assertCurrent?.();
    return assertCurrent?this.child.request(method,args,assertCurrent):this.child.request(method, args);
  }
  async setViewerDemand(active: boolean): Promise<void> {
    if (this.closed) throw new Error("Library owner is closed");
    this.demand = active;
    // Retirement acknowledgement means the former process exited. Never wait for the new
    // child's full initialization: its recovery may be parked by this very demand.
    if (this.retirement) await this.retirement;
    else await this.child?.setViewerDemand(active);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Do not wait for initialization before cancellation: recovery may be parked by viewer demand.
    const stopping = this.child?.close();
    this.closing = (async () => {
      const outcomes = await Promise.allSettled([this.tail, stopping, this.retirement]); this.child = undefined; this.key = undefined;
      const failure = outcomes.find(outcome => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })(); return this.closing;
  }
}
