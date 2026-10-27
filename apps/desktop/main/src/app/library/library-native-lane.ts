interface Waiter {signal:AbortSignal;abort:()=>void;resolve:()=>void;reject:(error:unknown)=>void}
/** One background native phase at a time. Foreground code never acquires this lane. The callback
 * must settle only after its owned helper exits; cancellation cannot free a running permit early. */
export class LibraryNativeLane {
  private active=false;
  private closed=false;
  private readonly queued:Waiter[]=[];
  private closing?:Promise<void>;
  private drained?:()=>void;
  private longestWaitMs=0;
  constructor(private readonly maximumQueued=8){if(!Number.isInteger(maximumQueued)||maximumQueued<1||maximumQueued>16)throw new Error("Invalid native lane capacity");}
  status(){return{active:Number(this.active),queued:this.queued.length,longestWaitMs:this.longestWaitMs};}
  async run<T>(work:()=>Promise<T>,signal:AbortSignal):Promise<T>{
    signal.throwIfAborted();if(this.closed)throw new Error("Library native lane is closed");
    if(this.active){
      if(this.queued.length>=this.maximumQueued)throw new Error("Library native lane is busy");
      const started=performance.now();
      await new Promise<void>((resolve,reject)=>{
        const waiter:Waiter={signal,resolve,reject,abort:()=>{
          const index=this.queued.indexOf(waiter);if(index<0)return;this.queued.splice(index,1);signal.removeEventListener("abort",waiter.abort);reject(signal.reason);
        }};
        this.queued.push(waiter);signal.addEventListener("abort",waiter.abort,{once:true});if(signal.aborted)waiter.abort();
      });
      this.longestWaitMs=Math.max(this.longestWaitMs,performance.now()-started);
    }else this.active=true;
    try{signal.throwIfAborted();if(this.closed)throw new Error("Library native lane is closed");return await work();}
    finally{
      const next=this.queued.shift();
      if(next){next.signal.removeEventListener("abort",next.abort);next.resolve();}
      else{this.active=false;this.drained?.();}
    }
  }
  close():Promise<void>{
    if(this.closing)return this.closing;this.closed=true;
    for(const waiter of this.queued.splice(0)){waiter.signal.removeEventListener("abort",waiter.abort);waiter.reject(new Error("Library native lane is closed"));}
    this.closing=this.active?new Promise(resolve=>{this.drained=resolve;}):Promise.resolve();return this.closing;
  }
}
