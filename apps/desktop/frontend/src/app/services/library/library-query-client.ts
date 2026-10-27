import type { LibraryCollectionPage, LibraryFacetField, LibraryFacetPage, LibraryFilter, LibraryMembershipPage,
  LibraryQuery, LibraryQueryBandPage, LibraryQueryDetail, LibraryQueryPage, LibraryQueryPreview, LibraryQueryReveal,
  LibrarySnapshotNeighbors, LibrarySnapshotReference } from "../../../../../shared/library-query";
import { validateLibraryFilter, validateLibraryQuery } from "../../../../../shared/library-query";
import type { LibraryPassiveRequest } from "../../../../../shared/replay-library";
export type { LibraryPassiveRequest } from "../../../../../shared/replay-library";

export interface LibraryQueryTransport {request(input:LibraryPassiveRequest):Promise<unknown>}
type Preview={query:LibraryQuery;draft?:LibraryFilter;sequence:number;settled:boolean;resolve:(result:LibraryQueryPreview|undefined)=>void;reject:(error:unknown)=>void};
export function libraryQueryErrorCode(error:unknown):string|undefined {
  if(error&&typeof error==="object"&&"code" in error&&typeof error.code==="string")return error.code;
  return undefined;
}

/** Renderer reads only. A superseded request resolves undefined, never old data or an old error. */
export class LibraryQueryClient {
  private closed=false;
  private readonly sequences=new Map<string,number>();
  private readonly snapshots=new Set<string>();
  private previewPending?:Preview;
  private previewRunning=false;
  private previewTimer?:ReturnType<typeof setTimeout>;
  private readonly previewDelayMs:number;
  constructor(private readonly transport:LibraryQueryTransport,options:{previewDelayMs?:number}={}) {
    this.previewDelayMs=options.previewDelayMs??120;
    if(!Number.isFinite(this.previewDelayMs)||this.previewDelayMs<0||this.previewDelayMs>1000)throw new Error("Invalid preview settle delay");
  }
  private next(lane:string):number {const sequence=(this.sequences.get(lane)??0)+1;this.sequences.set(lane,sequence);return sequence;}
  private current(lane:string,sequence:number):boolean{return !this.closed&&this.sequences.get(lane)===sequence;}
  private async read<T>(lane:string,input:LibraryPassiveRequest):Promise<T|undefined> {
    if(this.closed)return undefined;const sequence=this.next(lane);
    try{const result=await this.transport.request(input);return this.current(lane,sequence)?result as T:undefined;}
    catch(error){if(this.current(lane,sequence))throw error;return undefined;}
  }
  page(query:LibraryQuery):Promise<LibraryQueryPage|undefined>{validateLibraryQuery(query);return this.read("page",{method:"query-page",query});}
  bands(query:LibraryQuery,options?:{limit?:number;cursor?:string}):Promise<LibraryQueryBandPage|undefined>{validateLibraryQuery(query);return this.read("bands",{method:"query-bands",query,options});}
  facets(query:LibraryQuery,field:LibraryFacetField,options?:{search?:string;limit?:number;after?:string}):Promise<LibraryFacetPage|undefined>{validateLibraryQuery(query);return this.read(`facets:${field}`,{method:"query-facets",query,field,options});}
  reveal(query:LibraryQuery,replayId:string):Promise<LibraryQueryReveal|undefined>{validateLibraryQuery(query);return this.read("reveal",{method:"query-reveal",query,replayId});}
  detail(replayId:string):Promise<LibraryQueryDetail|null|undefined>{return this.read("detail",{method:"query-detail",replayId});}
  sameMap(replayId:string,query:LibraryQuery={}):Promise<LibraryQueryPage|undefined>{validateLibraryQuery(query);return this.read("same-map",{method:"query-same-map",query,replayId});}
  collections(options?:{limit?:number;after?:string;parentId?:string|null}):Promise<LibraryCollectionPage|undefined>{return this.read("collections",{method:"query-collections",options});}
  memberships(replayId:string,options?:{limit?:number;after?:string}):Promise<LibraryMembershipPage|undefined>{return this.read("memberships",{method:"query-memberships",replayId,options});}
  preview(query:LibraryQuery,draft?:LibraryFilter):Promise<LibraryQueryPreview|undefined> {
    validateLibraryQuery(query);if(draft)validateLibraryFilter(draft);if(this.closed)return Promise.resolve(undefined);
    const sequence=this.next("preview");this.previewPending?.resolve(undefined);if(this.previewTimer!==undefined)clearTimeout(this.previewTimer);
    return new Promise((resolve,reject)=>{
      this.previewPending={query,draft,sequence,settled:false,resolve,reject};
      this.previewTimer=setTimeout(()=>{this.previewTimer=undefined;if(this.previewPending?.sequence===sequence)this.previewPending.settled=true;this.flushPreview();},this.previewDelayMs);
    });
  }
  private flushPreview():void {
    const pending=this.previewPending;if(this.closed||this.previewRunning||!pending?.settled)return;
    this.previewPending=undefined;this.previewRunning=true;
    const input:LibraryPassiveRequest={method:"query-preview",query:pending.query,draft:pending.draft};
    let request:Promise<unknown>;
    try{request=this.transport.request(input);}catch(error){request=Promise.reject(error);}
    void request.then(result=>{
      if(!this.current("preview",pending.sequence)){pending.resolve(undefined);return;}
      pending.resolve(result as LibraryQueryPreview);
    },error=>{if(this.current("preview",pending.sequence))pending.reject(error);else pending.resolve(undefined);})
      .finally(()=>{this.previewRunning=false;this.flushPreview();});
  }
  async createSnapshot(query:LibraryQuery,replayId:string):Promise<LibrarySnapshotReference|undefined> {
    validateLibraryQuery(query);if(this.closed)return undefined;const sequence=this.next("snapshot-create");
    try{
      const result=await this.transport.request({method:"query-snapshot-create",query,replayId}) as LibrarySnapshotReference;
      if(!this.current("snapshot-create",sequence)){await this.releaseSnapshot(result.snapshotId).catch(()=>undefined);return undefined;}
      this.snapshots.add(result.snapshotId);return result;
    }catch(error){if(this.current("snapshot-create",sequence))throw error;return undefined;}
  }
  neighbors(snapshotId:string,options:{position:number;before?:number;after?:number}):Promise<LibrarySnapshotNeighbors|undefined>{return this.read("snapshot-neighbors",{method:"query-snapshot-neighbors",snapshotId,options});}
  async releaseSnapshot(snapshotId:string):Promise<void>{this.snapshots.delete(snapshotId);await this.transport.request({method:"query-snapshot-release",snapshotId});}
  invalidate():void {
    for(const lane of this.sequences.keys())this.next(lane);
    if(this.previewTimer!==undefined)clearTimeout(this.previewTimer);this.previewTimer=undefined;this.previewPending?.resolve(undefined);this.previewPending=undefined;
  }
  dispose():void {
    if(this.closed)return;this.closed=true;this.invalidate();
    for(const snapshotId of this.snapshots)void this.releaseSnapshot(snapshotId).catch(()=>undefined);
  }
}
