import { win32 } from "path";
import type { LibraryRequest, LibraryStableInstallation } from "../../../../shared/replay-library";
import { LIBRARY_QUERY_ERROR_CODES } from "../../../../shared/replay-library";
import type { LibraryCurrentReplayRequest } from "../../../../shared/library-current-replay";
import { validateLibraryFilter, validateLibraryQuery } from "../../../../shared/library-query";
import type { LibraryQuery } from "../../../../shared/library-query";
import { LIBRARY_USER_METADATA_OPERATIONS, validateLibraryUserMetadata } from "./library-user-metadata-api";
import type { LibraryMainOwner } from "./library-main-owner";

interface Sender { mainFrame: unknown; isDestroyed(): boolean; getURL(): string }
/** Library privileges belong to the owned renderer document, never another window or subframe. */
export function assertLibrarySender(event: { sender: Sender; senderFrame: unknown }, owner: Sender | undefined | null, expectedUrl: string): void {
  let actual: string | undefined;
  try { const url = new URL(event.sender.getURL()); url.hash = ""; actual = url.href; } catch { /* Reject below. */ }
  if (!owner || event.sender !== owner || owner.isDestroyed() || !event.senderFrame || event.senderFrame !== owner.mainFrame || actual !== expectedUrl)
    throw new Error("Unexpected library sender");
}

interface Dependencies {
  owner: Pick<LibraryMainOwner, "configure" | "request" | "retry" | "setViewerDemand" | "close">;
  readNativeDirectory(): Promise<string | undefined>;
  saveNativeDirectory(directory: string): Promise<void>;
  pickImports(): Promise<string[] | null>;
  pickNative(): Promise<string | null>;
  inspectNative(directory: string, signal: AbortSignal): Promise<{ ok: boolean; status: string }>;
  closeNative?(): Promise<void>;
  receiveCurrentReplay?(input:LibraryCurrentReplayRequest,assertCurrent:()=>void):Promise<unknown>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const path = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 32768 && !value.includes("\0") && win32.isAbsolute(value);
const identity = (value:unknown,max=128):value is string=>typeof value==="string"&&value.length>0&&value.length<=max&&/^[a-zA-Z0-9_.:/+-]+$/.test(value);
const queryKeys:Record<string,string[]>={
  "query-page":["query"],"query-preview":["query","draft"],"query-facets":["query","field","options"],"query-bands":["query","options"],
  "query-reveal":["query","replayId"],"query-detail":["replayId"],"query-same-map":["query","replayId"],
  "query-collections":["options"],"query-memberships":["replayId","options"],"query-snapshot-create":["query","replayId"],
  "query-snapshot-neighbors":["snapshotId","options"],"query-snapshot-release":["snapshotId"],
  "query-player-names":[],
};
const queryOperation=(method:string)=>Object.prototype.hasOwnProperty.call(queryKeys,method);
const allowed=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).every(key=>keys.includes(key));
function filter(value:unknown):void {
  if(!object(value)||["basis","mode","op","preset"].some(key=>value[key]!==undefined&&typeof value[key]!=="string")||
    value.match!==undefined&&value.match!==null&&typeof value.match!=="string")throw new Error("Invalid library filter values");
  validateLibraryFilter(value);
  const keys="values"in value?(value.field==="player"?["field","values","me"]:["field","values"]):value.field==="mods"?["field","mode","match","mods"]:
    value.field==="played"?(value.preset==="custom"?["field","preset","from","to"]:["field","preset"]):
      "op"in value?["field","op","a","b"]:value.field==="stars"?["field","basis","min","max"]:["field","min","max"];
  if(!allowed(value as unknown as Record<string,unknown>,keys))throw new Error("Invalid library filter fields");
}
function queryRequest(input:Record<string,unknown>,method:string):void {
  if(input.query!==undefined){
    const raw=input.query;
    if(!object(raw)||["sort","direction"].some(key=>raw[key]!==undefined&&typeof raw[key]!=="string")||
      raw.scope!==undefined&&(!object(raw.scope)||typeof raw.scope.kind!=="string"))
      throw new Error("Invalid library query values");
    validateLibraryQuery(input.query);const query=input.query as LibraryQuery;
    if(!allowed(query as Record<string,unknown>,["search","filters","scope","sort","direction","limit","cursor"])||query.scope&&
      !allowed(query.scope as unknown as Record<string,unknown>,query.scope.kind==="collection"?["kind","id"]:["kind"]))throw new Error("Invalid library query fields");
    for(const item of query.filters??[])filter(item);
  }
  if(queryKeys[method].includes("replayId")&&!identity(input.replayId,512)||queryKeys[method].includes("snapshotId")&&!identity(input.snapshotId))
    throw new Error("Invalid library query identity");
  if(method==="query-preview"&&input.draft!==undefined)filter(input.draft);
  if(method==="query-facets"&&(typeof input.field!=="string"||!["status","mapper","grade","player","source","collection","review","astate","result","playedon"].includes(input.field)))throw new Error("Invalid library facet");
  if(input.options===undefined){if(method==="query-snapshot-neighbors")throw new Error("Invalid library snapshot options");return;}
  const opts=input.options;
  if(!object(opts))throw new Error("Invalid library query options");
  const keys=method==="query-facets"?["search","limit","after"]:method==="query-bands"?["limit","cursor"]:
    method==="query-collections"?["limit","after","parentId"]:method==="query-memberships"?["limit","after"]:["position","before","after"];
  if(!allowed(opts,keys))throw new Error("Invalid library query options");
  if(method==="query-snapshot-neighbors"){
    if(!Number.isSafeInteger(opts.position)||Number(opts.position)<0||[opts.before,opts.after].some(v=>v!==undefined&&(!Number.isInteger(v)||Number(v)<0||Number(v)>63)))
      throw new Error("Invalid library snapshot range");
    return;
  }
  if(opts.limit!==undefined&&(!Number.isInteger(opts.limit)||Number(opts.limit)<1||Number(opts.limit)>100)||
    opts.search!==undefined&&(typeof opts.search!=="string"||opts.search.length>512)||
    [opts.after,opts.cursor].some(v=>v!==undefined&&(typeof v!=="string"||v.length>131072))||
    opts.parentId!==undefined&&opts.parentId!==null&&!identity(opts.parentId,512))throw new Error("Invalid library query options");
}
/** Shared pure validation for passive renderer and internal utility query transports. */
export function validateLibraryPassiveRequest(method:string,args:unknown):void {
  if(!queryOperation(method)||!object(args)||!allowed(args,queryKeys[method])||
    Buffer.byteLength(JSON.stringify({method,...args}))>256*1024)throw new Error("Invalid passive library request");
  queryRequest(args,method);
}
function request(value: unknown): LibraryRequest {
  if (!object(value) || typeof value.method!=="string" || Buffer.byteLength(JSON.stringify(value)) > (queryOperation(value.method)?256:96) * 1024) throw new Error("Invalid library request");
  const keys: Record<string, string[]> = { configure: ["stable"], status: [], retry: [], "import-replays": [], "locate-lazer": [],
    rebuild: [], "rebuild-stop": [], scan: ["sourceId"], stop: ["sourceId"], "source-enabled": ["sourceId", "enabled"], "update-mode": ["mode"],
    ...queryKeys,"collection-create":["name","parentId","replayId"],"collection-rename":["collectionId","name"],"collection-delete":["collectionId","referencedIds"],
    "replay-review":["replayId","review"],"replay-favourite":["replayId","favourite"],"collection-membership":["replayId","collectionId","included"],
    "player-names-set":["names"],
    "analysis-settings":["settings"],"analysis-request":["replayId","reason"],"analysis-retry":["replayId"],
    "current-replay-publish":["token","results"],"current-replay-release":["token"] };
  const method = value.method;
  if (!Object.prototype.hasOwnProperty.call(keys, method) || Object.keys(value).some(key => key !== "method" && !keys[method].includes(key)))
    throw new Error("Unknown library operation");
  if (keys[method].includes("sourceId") && (typeof value.sourceId !== "string" || !value.sourceId || value.sourceId.length > 128)) throw new Error("Invalid source identity");
  if (method === "source-enabled" && typeof value.enabled !== "boolean") throw new Error("Invalid source state");
  if (method === "update-mode" && (typeof value.mode!=="string"||!["auto", "launch", "manual"].includes(value.mode))) throw new Error("Invalid update mode");
  if (method === "configure" && value.stable !== null && (!object(value.stable) || !path(value.stable.directory) || !path(value.stable.songsRoot) ||
      Object.keys(value.stable).some(key => !["directory", "songsRoot"].includes(key)))) throw new Error("Invalid installation configuration");
  if(queryOperation(method)){const args={...value};delete args.method;validateLibraryPassiveRequest(method,args);}
  if((LIBRARY_USER_METADATA_OPERATIONS as readonly string[]).includes(method)){const args={...value};delete args.method;validateLibraryUserMetadata(method,args);}
  if(method==="analysis-settings"&&value.settings!==undefined){
    const settings=value.settings;
    if(!object(settings)||!allowed(settings,["mode","userPaused","workers","pauseOnBattery","fasterProcessing"])||typeof settings.mode!=="string"||
      !["bg","demand","off"].includes(settings.mode)||typeof settings.userPaused!=="boolean"||typeof settings.pauseOnBattery!=="boolean"||
      ![1,2,4].includes(settings.workers as number)||settings.fasterProcessing!==undefined&&typeof settings.fasterProcessing!=="boolean")throw new Error("Invalid library analysis settings");
  }
  if((method==="analysis-request"||method==="analysis-retry")&&!identity(value.replayId)||
    method==="analysis-request"&&(typeof value.reason!=="string"||!["selection","open"].includes(value.reason)))throw new Error("Invalid library analysis request");
  if((method==="current-replay-publish"||method==="current-replay-release")&&(!identity(value.token)||method==="current-replay-publish"&&
    (!Array.isArray(value.results)||value.results.length<1||value.results.length>3)))throw new Error("Invalid current replay request");
  return value as unknown as LibraryRequest;
}

/** No renderer-supplied file arrays, utility initialization, SQL or execution paths cross this boundary. */
export class LibraryMainApi {
  private nativePreference?: Promise<string | undefined>;
  private preferenceFailed = false;
  private intendedStable?: LibraryStableInstallation | null;
  private configured = false;
  private closed = false;
  private closing?: Promise<void>;
  private picker = false;
  private pending = 0;
  private readonly abort = new AbortController();
  private readonly inspections = new Set<Promise<unknown>>();
  private readonly saves = new Set<Promise<void>>();
  constructor(private readonly deps: Dependencies) {}
  private checkOpen(): void { if (this.closed) throw new Error("Library API is closed"); }
  private async configure(stable: LibraryStableInstallation | null, assertCurrent: () => void): Promise<void> {
    this.nativePreference ??= this.deps.readNativeDirectory().catch(error => { this.preferenceFailed = true; throw error; });
    const native = await this.nativePreference; this.checkOpen(); assertCurrent();
    const config = { stable, ...(!this.configured && native ? { lazerDirectory: native } : {}) };
    this.configured = true; await this.deps.owner.configure(config);
  }
  async receive(value: unknown, assertCurrent: () => void): Promise<unknown> {
    assertCurrent(); this.checkOpen(); const input = request(value);
    if (this.pending >= 64 || (this.pending >= 32 && !["stop","rebuild-stop","analysis-settings","query-snapshot-release","current-replay-release"].includes(input.method))) throw new Error("Library request queue is busy");
    this.pending++;
    try {
      if(input.method==="current-replay-publish"||input.method==="current-replay-release"){
        if(!this.deps.receiveCurrentReplay)throw new Error("Current replay publication is unavailable");
        return await this.deps.receiveCurrentReplay(input,assertCurrent);
      }
      if (input.method === "configure") {
        this.intendedStable = input.stable;
        await this.configure(input.stable, assertCurrent); return null;
      }
      if (input.method === "retry") {
        if (this.preferenceFailed && this.intendedStable !== undefined) {
          this.nativePreference = undefined; this.preferenceFailed = false;
          await this.configure(this.intendedStable, assertCurrent);
        } else await this.deps.owner.retry();
        return null;
      }
      if (input.method === "import-replays" || input.method === "locate-lazer") {
        if (this.picker) throw new Error("A library file dialog is already open");
        this.picker = true;
        try {
          if (input.method === "import-replays") {
            const paths = await this.deps.pickImports(); this.checkOpen(); assertCurrent();
            if (!paths) return null;
            if (paths.length > 1000 || !paths.every(item => path(item) && /\.osr$/i.test(item))) throw new Error("Select up to 1000 .osr replays");
            return await this.deps.owner.request("import", { paths });
          }
          const directory = await this.deps.pickNative(); this.checkOpen(); assertCurrent();
          if (!directory) return null;
          if (!path(directory)) throw new Error("Invalid native installation directory");
          const inspection = this.deps.inspectNative(directory, this.abort.signal); this.inspections.add(inspection);
          let result: Awaited<typeof inspection>;
          try { result = await inspection; } finally { this.inspections.delete(inspection); }
          this.checkOpen(); assertCurrent();
          if (!result.ok) throw new Error("Native lazer source: " + result.status);
          const saving = this.deps.saveNativeDirectory(directory); this.saves.add(saving);
          try {
            await saving;
            // The authorized preference belongs to the app, even if its response document left.
            this.nativePreference = Promise.resolve(directory); this.preferenceFailed = false; this.configured = true;
            if (!this.closed) await this.deps.owner.configure({ lazerDirectory: directory });
          } finally { this.saves.delete(saving); }
          this.checkOpen(); assertCurrent(); return directory;
        } finally { this.picker = false; }
      }
      const { method, ...args } = input; return await this.deps.owner.request(method, args);
    } catch(error) {
      if(queryOperation(input.method)&&error instanceof Error&&"code"in error&&typeof error.code==="string"&&
        (LIBRARY_QUERY_ERROR_CODES as readonly string[]).includes(error.code))return{libraryQueryError:{code:error.code,message:error.message.slice(0,2048)}};
      throw error;
    } finally { this.pending--; }
  }
  async demand(active: unknown): Promise<void> {
    this.checkOpen(); if (typeof active !== "boolean") throw new Error("Invalid viewer demand");
    await this.deps.owner.setViewerDemand(active);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.abort.abort();
    this.closing = (async () => {
      const results = await Promise.allSettled([this.deps.owner.close(), this.deps.closeNative?.(), ...this.inspections, ...this.saves]);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })(); return this.closing;
  }
}
