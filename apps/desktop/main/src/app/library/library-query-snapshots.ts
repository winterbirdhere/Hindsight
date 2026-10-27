import { randomUUID } from "node:crypto";
import type { LibraryQuery, LibrarySnapshotReference, LibrarySnapshotNeighbors } from "../../../../shared/library-query";
import { assertLibraryQueryResponse, LibraryQueryInvalidatedError, LibraryQueryLimitError, LibraryQueryReader } from "./library-query";

export interface LibrarySnapshotLimits { maxIds?:number; maxBytes?:number; maxSnapshots?:number }
type Snapshot={ids:string[];scopeLabel:string;sortLabel:string;bytes:number};

/** Session-owned frozen order only. It has no source, file, worker or admission capability. */
export class LibraryQuerySnapshots {
  private readonly snapshots=new Map<string,Snapshot>();
  private bytes=0;
  private readonly maxIds:number;
  private readonly maxBytes:number;
  private readonly maxSnapshots:number;
  constructor(private readonly reader:Pick<LibraryQueryReader,"captureOrder">,limits:LibrarySnapshotLimits={}) {
    this.maxIds=limits.maxIds??200000;this.maxBytes=limits.maxBytes??32*1024*1024;this.maxSnapshots=limits.maxSnapshots??4;
    if(!Number.isInteger(this.maxIds)||this.maxIds<1||this.maxIds>200000||!Number.isSafeInteger(this.maxBytes)||this.maxBytes<1024||this.maxBytes>64*1024*1024||!Number.isInteger(this.maxSnapshots)||this.maxSnapshots<1||this.maxSnapshots>16)throw new Error("Invalid library snapshot limits");
  }
  create(query:LibraryQuery,selectedId:string):LibrarySnapshotReference {
    if(typeof selectedId!=="string"||!selectedId.length||selectedId.length>512)throw new Error("Invalid selected replay identity");
    if(this.snapshots.size>=this.maxSnapshots)throw new LibraryQueryLimitError("The navigation snapshot limit is reached. Close an older library navigation result and retry.");
    const captured=this.reader.captureOrder(query,this.maxIds);
    if(captured.ids.length>this.maxIds)throw new LibraryQueryLimitError("This result exceeds the navigation snapshot limit. Narrow the result before opening it.");
    const position=captured.ids.indexOf(selectedId);if(position<0)throw new LibraryQueryInvalidatedError();
    // Include an intentionally conservative per-entry JS/array allowance, not just UTF-8 bytes.
    const bytes=1024+2*(captured.scopeLabel.length+captured.sortLabel.length)+captured.ids.reduce((sum,id)=>sum+96+id.length*2,0);
    if(this.bytes+bytes>this.maxBytes)throw new LibraryQueryLimitError("The navigation snapshot memory budget is full. Close an older result or narrow this result, then retry.");
    const snapshotId=randomUUID();this.snapshots.set(snapshotId,{...captured,ids:[...captured.ids],bytes});this.bytes+=bytes;
    return{snapshotId,total:captured.ids.length,position,scopeLabel:captured.scopeLabel,sortLabel:captured.sortLabel};
  }
  neighbors(snapshotId:string,options:{position:number;before?:number;after?:number}):LibrarySnapshotNeighbors {
    const snapshot=this.snapshots.get(snapshotId);if(!snapshot)throw new Error("Library navigation snapshot is no longer available; return to the library and reopen the replay.");
    const before=options.before??1,after=options.after??1;
    if(!Number.isInteger(options.position)||options.position<0||options.position>=snapshot.ids.length||!Number.isInteger(before)||before<0||before>63||!Number.isInteger(after)||after<0||after>63)throw new Error("Invalid library snapshot neighbor range");
    const start=Math.max(0,options.position-before),end=Math.min(snapshot.ids.length,options.position+after+1);
    const items=snapshot.ids.slice(start,end).map((id,index)=>({id,position:start+index}));
    return assertLibraryQueryResponse({snapshotId,total:snapshot.ids.length,position:options.position,scopeLabel:snapshot.scopeLabel,sortLabel:snapshot.sortLabel,items});
  }
  release(snapshotId:string):void {const snapshot=this.snapshots.get(snapshotId);if(snapshot){this.bytes-=snapshot.bytes;this.snapshots.delete(snapshotId);}}
  clear():void {this.snapshots.clear();this.bytes=0;}
  usage():{snapshots:number;estimatedBytes:number}{return{snapshots:this.snapshots.size,estimatedBytes:this.bytes};}
}
