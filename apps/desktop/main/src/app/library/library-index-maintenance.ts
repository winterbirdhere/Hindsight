import { LibraryActivityGate } from "./library-activity-gate";

export interface LibraryIndexMaintenanceStatus {
  state:"idle"|"running"|"waiting-for-viewer"|"error"|"closing"|"closed";
  error?:string;
}
/** Event-driven metadata maintenance. The sink owns its bounded page/cursor; no timers,
 * analysis admission, replay reads or work queues are introduced by this serial owner. */
export class LibraryIndexMaintenance {
  private readonly gate=new LibraryActivityGate();
  private readonly abort=new AbortController();
  private pending=false;
  private demand=false;
  private work?:Promise<void>;
  private failure?:Error;
  private closing?:Promise<void>;
  private closed=false;
  constructor(private readonly step:()=>boolean){}
  wake():void {
    if(this.closing||this.closed||this.failure)return;
    this.pending=true;if(this.work)return;
    this.work=this.gate.run(async()=>{
      do{
        this.pending=false;
        const more=this.step();if(typeof more!=="boolean")throw new Error("Index maintenance step must return a boolean");
        this.pending||=more;
        if(this.pending)await this.gate.checkpoint(this.abort.signal);
      }while(this.pending);
    },this.abort.signal).catch(error=>{
      if(!this.abort.signal.aborted)this.failure=error instanceof Error?error:new Error("Index maintenance failed");
    }).finally(()=>{
      this.work=undefined;
      // A mutation can wake the owner as its final promise settles. Retain that wake once.
      if(this.pending&&!this.closing&&!this.closed&&!this.failure)this.wake();
    });
  }
  async setViewerDemand(active:boolean):Promise<void> {
    if(typeof active!=="boolean")throw new Error("Invalid index maintenance viewer demand");
    this.demand=active;await this.gate.setDemand(active);
  }
  async drain():Promise<void> {
    while(this.work)await this.work;
    if(this.failure)throw this.failure;
  }
  status():LibraryIndexMaintenanceStatus {
    if(this.failure)return{state:"error",error:this.failure.message.slice(0,2048)};
    if(this.closed)return{state:"closed"};if(this.closing)return{state:"closing"};
    return{state:this.work?(this.demand?"waiting-for-viewer":"running"):"idle"};
  }
  close():Promise<void> {
    if(this.closing)return this.closing;
    this.pending=false;this.abort.abort(new Error("Index maintenance closed"));
    this.closing=(async()=>{try{await this.drain();}finally{this.closed=true;}})();return this.closing;
  }
}
