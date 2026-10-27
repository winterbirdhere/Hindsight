export interface LibraryAnalysisControl { viewerDemand:boolean; userPaused:boolean; fasterProcessing?:boolean }
export type LibraryYieldAcknowledgement = "idle" | "parked" | "superseded" | "released";

/** One worker-owned continuation. Viewer yielding never changes persisted user Pause. */
export class LibraryAnalysisGate {
  private controls:LibraryAnalysisControl={viewerDemand:false,userPaused:false};
  private active=false;
  private parked=false;
  private waitingExternal=false;
  private signal?:AbortSignal;
  private wake?:()=>void;
  private acknowledgements:((state:LibraryYieldAcknowledgement)=>void)[]=[];
  constructor(private readonly yieldTurn:()=>Promise<void>=()=>new Promise(resolve=>setTimeout(resolve,0))) {}
  status() { return {...this.controls,held:this.held(),active:this.active,parked:this.parked||this.waitingExternal&&this.held()}; }
  private held() { return this.controls.viewerDemand||this.controls.userPaused; }
  private acknowledge(state:LibraryYieldAcknowledgement) { for(const resolve of this.acknowledgements.splice(0))resolve(state); }
  control(value:LibraryAnalysisControl):Promise<LibraryYieldAcknowledgement> {
    this.controls={...value};
    if(!this.held()) {this.wake?.();this.acknowledge("superseded");return Promise.resolve(this.active?"released":"idle");}
    if(!this.active)return Promise.resolve("idle");
    if(this.parked||this.waitingExternal)return Promise.resolve("parked");
    if(this.acknowledgements.length>=32)this.acknowledgements.shift()?.("superseded");
    return new Promise(resolve=>this.acknowledgements.push(resolve));
  }
  async checkpoint():Promise<void> {
    this.signal?.throwIfAborted();await this.yieldTurn();this.signal?.throwIfAborted();
    while(this.held()) {
      this.parked=true;this.acknowledge("parked");
      try {
        await new Promise<void>(resolve=>{
          const signal=this.signal;
          const resume=()=>{signal?.removeEventListener("abort",resume);if(this.wake===resume)this.wake=undefined;resolve();};
          this.wake=resume;signal?.addEventListener("abort",resume,{once:true});
          if(signal?.aborted||!this.held())resume();
        });
      } finally {this.parked=false;}
      this.signal?.throwIfAborted();
    }
  }
  /** Parks ONLY this computation while another owner supplies I/O. The composition owner must
   * independently await that resource owner's hold/drain; this is not an I/O-yield acknowledgement. */
  async waitForExternal<T>(work:Promise<T>):Promise<T> {
    if(!this.active||this.waitingExternal)throw new Error("External wait requires one active library owner");
    this.waitingExternal=true;if(this.held())this.acknowledge("parked");
    let result:T;
    try {result=await work;}finally{this.waitingExternal=false;}
    await this.checkpoint();return result;
  }
  async run<T>(work:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
    if(this.active)throw new Error("Library analysis requires a serial worker owner");
    this.active=true;this.signal=signal;
    try {await this.checkpoint();const result=await work();await this.checkpoint();return result;}
    finally {this.active=false;this.signal=undefined;this.acknowledge("idle");}
  }
}
