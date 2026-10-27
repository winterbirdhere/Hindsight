import type { LibraryChangedEvent } from "../../../../shared/replay-library";
import { readLibraryResourceChanges } from "../../../../shared/library-resource-changes";
import type { LibraryResourceChanges } from "../../../../shared/library-resource-changes";

/** App-owned revision sequence survives utility replacement. It carries readiness only;
 * queries still validate their own indexed revision before returning data. */
export class LibraryChangeRelay {
  private generation=0;
  private revision=0;
  private ready?:boolean;
  private resourceRevision?:string;
  private send?: (event:LibraryChangedEvent)=>void;
  private closed=false;
  attach(send:(event:LibraryChangedEvent)=>void):void {
    if(this.closed)return;this.send=send;this.snapshot();
  }
  snapshot(statusOnly?:true,resourceChanges?:LibraryResourceChanges):void {if(!this.closed&&this.ready!==undefined)this.send?.({revision:++this.revision,ready:this.ready,...(this.resourceRevision!==undefined?{resourceRevision:this.resourceRevision}:{}),...(resourceChanges?{resourceChanges}:{}),...(statusOnly?{statusOnly}: {})});}
  beginSource():(event:{ready:boolean;resourceRevision?:string;resourceChanges?:LibraryResourceChanges;statusOnly?:true})=>void {
    const generation=++this.generation;this.ready=false;this.resourceRevision=undefined;this.snapshot();
    return event=>{if(this.closed||generation!==this.generation)return;
      const resourceRevision=event.resourceRevision===undefined?undefined:`${generation}:${event.resourceRevision}`;
      const statusOnly=event.statusOnly===true&&this.ready===event.ready&&this.resourceRevision===resourceRevision;
      const raw=event.resourceRevision===undefined?undefined:readLibraryResourceChanges(event.resourceChanges,event.resourceRevision);
      const changes=raw&&this.resourceRevision===`${generation}:${raw.from}`&&resourceRevision!==this.resourceRevision
        ?{...raw,from:`${generation}:${raw.from}`,to:`${generation}:${raw.to}`}:undefined;
      this.ready=event.ready;this.resourceRevision=resourceRevision;this.snapshot(statusOnly?true:undefined,changes);};
  }
  close():void {this.closed=true;this.generation++;this.send=undefined;}
}
