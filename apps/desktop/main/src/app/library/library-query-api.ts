import type { LibraryFacetField, LibraryFilter, LibraryQuery } from "../../../../shared/library-query";
import { validateLibraryQuery } from "../../../../shared/library-query";
import { assertLibraryQueryResponse, LibraryQueryReader } from "./library-query";
import { LibraryQuerySnapshots } from "./library-query-snapshots";

export const LIBRARY_QUERY_OPERATIONS=["query-page","query-preview","query-facets","query-bands","query-reveal","query-detail",
  "query-same-map","query-collections","query-memberships","query-snapshot-create","query-snapshot-neighbors","query-snapshot-release","query-player-names"] as const;
export type LibraryQueryOperation=typeof LIBRARY_QUERY_OPERATIONS[number];
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
function options(value:unknown):Record<string,unknown>|undefined {if(value===undefined)return undefined;if(!record(value))throw new Error("Invalid library query options");return value;}

/** Passive main→utility seam. Root must retain this instance for its owned utility session. */
export class LibraryQueryApi {
  private closed=false;
  constructor(private readonly reader:LibraryQueryReader,private readonly snapshots=new LibraryQuerySnapshots(reader)){}
  receive(method:LibraryQueryOperation,args:Record<string,unknown>):unknown {
    if(this.closed)throw new Error("Library query session is closed");
    if(!record(args)||!(LIBRARY_QUERY_OPERATIONS as readonly string[]).includes(method))throw new Error("Invalid library query operation");
    const query=args.query??{};validateLibraryQuery(query);
    const opts=options(args.options);let result:unknown;
    switch(method){
      case "query-page":result=this.reader.page(query);break;
      case "query-preview":result=this.reader.preview(query,args.draft as LibraryFilter|undefined);break;
      case "query-player-names":result={names:this.reader.playerNames()};break;
      case "query-facets":result=this.reader.facets(query,args.field as LibraryFacetField,opts);break;
      case "query-bands":result=this.reader.bands(query,opts);break;
      case "query-reveal":result=this.reader.reveal(query,args.replayId as string);break;
      case "query-detail":result=this.reader.detail(args.replayId as string);break;
      case "query-same-map":result=this.reader.sameMap(args.replayId as string,query);break;
      case "query-collections":result=this.reader.collectionsPage(opts);break;
      case "query-memberships":result=this.reader.membershipsPage(args.replayId as string,opts);break;
      case "query-snapshot-create":result=this.snapshots.create(query as LibraryQuery,args.replayId as string);break;
      case "query-snapshot-neighbors":
        if(typeof args.snapshotId!=="string"||!opts)throw new Error("Invalid library snapshot request");
        result=this.snapshots.neighbors(args.snapshotId,opts as {position:number;before?:number;after?:number});break;
      case "query-snapshot-release":
        if(typeof args.snapshotId!=="string"||args.snapshotId.length>128)throw new Error("Invalid library snapshot identity");
        this.snapshots.release(args.snapshotId);result=null;break;
    }
    return assertLibraryQueryResponse(result);
  }
  close():void {if(this.closed)return;this.closed=true;this.snapshots.clear();}
}
