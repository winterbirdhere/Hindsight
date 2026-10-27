export type LibraryNativePhase="source-page"|"source-resolve"|"replay-decode"|"map-performance"|"timeline-performance";
export class LibraryNativeDrainError extends Error {readonly libraryNativeOwnershipUncertain=true;}
export interface LibraryNativeAdmission {
  run<T>(phase:LibraryNativePhase,work:()=>Promise<T>,signal?:AbortSignal):Promise<T>;
}
type Request={version:1;event:"native-request";id:number;phase:LibraryNativePhase}|{version:1;event:"native-cancel";id:number}|
  {version:1;event:"native-release";id:number;drained:boolean;error?:string};
type Reply={version:1;nativeReply:number;state:"granted"|"cancelled"|"failed";error?:string;ownershipUncertain?:true};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const id=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const phases=new Set(["source-page","source-resolve","replay-decode","map-performance","timeline-performance"]);
const sourcePhase=(phase:LibraryNativePhase)=>phase==="source-page"||phase==="source-resolve";
const message=(error:unknown)=>(error instanceof Error?error.message:"Native admission failed").slice(0,512);
interface Peer {send(value:Reply):void;priority:"analysis"|"artwork";held:boolean;closed:boolean;sequence:number;retired:number;pending?:number}
interface Waiting {peer:Peer;id:number;phase:LibraryNativePhase}
export interface LibraryNativeEndpoint {receive(value:unknown):void;setHeld(value:boolean):Promise<void>;disconnected():void}

/** Main-owned helper admission. An uncertain native exit poisons the runtime's shared latch,
 * including replacement metadata owners; utility exit alone cannot establish helper drainage. */
export class LibraryNativeBroker {
  private held=false;private closed=false;private capacity:1|2|4=1;
  private readonly active=new Map<Peer,Waiting>();private readonly queued:Waiting[]=[];
  private readonly waiters:{peer?:Peer;promise:Promise<void>;resolve():void;reject(error:Error):void}[]=[];
  constructor(private readonly latch:{error?:Error}={},private readonly maximumQueued=8){}
  status(){return{active:this.active.size,queued:this.queued.length,held:this.held,error:this.latch.error?.message};}
  /** Trusted main policy only. Shrinking preserves existing ownership and gates subsequent grants. */
  setCapacity(value:1|2|4):void {
    if(![1,2,4].includes(value))throw new Error("Invalid library native capacity");
    this.capacity=value;this.pump();
  }
  attach(send:(value:Reply)=>void,priority:"analysis"|"artwork"="analysis"):LibraryNativeEndpoint {
    if(priority!=="analysis"&&priority!=="artwork")throw new Error("Invalid native peer priority");
    const peer:Peer={send,priority,held:false,closed:false,sequence:0,retired:0};
    return{receive:value=>this.receive(peer,value),setHeld:value=>{peer.held=value;this.pump();return value?this.drain(peer):Promise.resolve();},
      disconnected:()=>{if(peer.closed)return;peer.closed=true;
        if(this.active.has(peer))this.poison(new Error("Native helper exit is unconfirmed after utility disconnected"));
        this.removeQueued(peer);this.pump();}};
  }
  setViewerDemand(value:boolean):Promise<void>{this.held=value;this.pump();return value?this.drain():Promise.resolve();}
  private send(peer:Peer,value:Reply){if(peer.closed)return;try{peer.send(value);}catch(error){this.poison(new Error("Native admission transport failed: "+message(error)));}}
  private poison(error:Error){this.latch.error??=error;for(const item of this.queued.splice(0))this.reject(item,this.latch.error);this.acknowledge();}
  private reject(item:Waiting,error:Error){item.peer.pending=undefined;item.peer.retired=item.id;this.send(item.peer,{version:1,nativeReply:item.id,state:"failed",error:message(error),
    ...(this.latch.error?{ownershipUncertain:true as const}:{})});}
  private removeQueued(peer:Peer){for(let index=this.queued.length-1;index>=0;index--)if(this.queued[index].peer===peer){this.queued.splice(index,1);peer.pending=undefined;}}
  private receive(peer:Peer,value:unknown):void {
    if(peer.closed)return;
    if(!record(value)||value.version!==1||!id(value.id)||!Object.keys(value).every(key=>["version","event","id","phase","drained","error"].includes(key))||
      !["native-request","native-cancel","native-release"].includes(String(value.event))){this.poison(new Error("Invalid native admission event"));return;}
    const request=value as Request;
    if(request.event==="native-request"){
      if(!phases.has(request.phase)||request.id!==peer.sequence+1||peer.pending!==undefined){this.poison(new Error("Invalid native acquisition sequence"));return;}
      peer.sequence=request.id;peer.pending=request.id;const item={peer,id:request.id,phase:request.phase};
      if(this.latch.error||this.closed||this.queued.length>=this.maximumQueued){this.reject(item,this.latch.error??new Error(this.closed?"Native admission closed":"Native admission queue is busy"));return;}
      this.queued.push(item);this.pump();return;
    }
    if(request.id===peer.retired)return;
    if(request.id!==peer.pending){this.poison(new Error("Stale native lease transition"));return;}
    if(request.event==="native-release"){
      if(this.active.get(peer)?.id!==request.id||typeof request.drained!=="boolean"){
        this.poison(new Error("Invalid native lease release"));return;}
      if(!request.drained){this.poison(new Error("Native helper drainage unconfirmed: "+String(request.error??"unknown failure").slice(0,512)));return;}
    }
    // Cancel is sent only while the utility still awaits its grant. Ordered messages ensure a
    // grant/cancel race cannot start a helper; a late duplicate unused release is harmless.
    this.removeQueued(peer);this.active.delete(peer);peer.pending=undefined;peer.retired=request.id;
    if(request.event==="native-cancel")this.send(peer,{version:1,nativeReply:request.id,state:"cancelled"});
    this.acknowledge();this.pump();
  }
  private pump(){
    while(!this.closed&&!this.held&&!this.latch.error&&this.active.size<this.capacity){
      // Keep source/Realm readers serialized; pipe-only decode/calculation helpers may overlap.
      const sourceActive=[...this.active.values()].some(item=>sourcePhase(item.phase));
      const eligible=(item:Waiting)=>!item.peer.held&&!item.peer.closed&&!(sourceActive&&sourcePhase(item.phase));
      // Main-owned passive peers may use the next free slot; active ownership and
      // all viewer/source/capacity gates remain unchanged. FIFO within each class.
      let index=this.queued.findIndex(item=>eligible(item)&&item.peer.priority==="artwork");
      if(index<0)index=this.queued.findIndex(eligible);if(index<0)return;
      const item=this.queued.splice(index,1)[0];this.active.set(item.peer,item);
      this.send(item.peer,{version:1,nativeReply:item.id,state:"granted"});
    }
  }
  private drain(peer?:Peer):Promise<void>{
    if(this.latch.error)return Promise.reject(this.latch.error);
    if(peer?!this.active.has(peer):this.active.size===0)return Promise.resolve();
    const existing=this.waiters.find(waiter=>waiter.peer===peer);if(existing)return existing.promise;
    if(this.waiters.length>=32)return Promise.reject(new Error("Native drain acknowledgements are busy"));
    let resolve!:()=>void,reject!:(error:Error)=>void;
    const promise=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});this.waiters.push({peer,promise,resolve,reject});return promise;
  }
  private acknowledge(){for(let index=this.waiters.length-1;index>=0;index--){const waiter=this.waiters[index];
    if(this.latch.error||(waiter.peer?!this.active.has(waiter.peer):this.active.size===0)){this.waiters.splice(index,1);if(this.latch.error)waiter.reject(this.latch.error);else waiter.resolve();}}}
  close():Promise<void>{this.closed=true;for(const item of this.queued.splice(0))this.reject(item,new Error("Native admission closed"));return this.drain();}
}

/** Utility-owned serial bridge. No paths, bytes or arbitrary executable arguments cross it. */
export class LibraryNativeBridge implements LibraryNativeAdmission {
  private sequence=0;private closed=false;private pending?:{id:number;resolve():void;reject(error:Error):void;signal?:AbortSignal;cancelled:boolean};
  private running=false;
  constructor(private readonly send:(value:Request)=>void){}
  receive(value:unknown):boolean {
    if(!record(value)||!("nativeReply"in value))return false;
    if(value.version!==1||!id(value.nativeReply)||!["granted","cancelled","failed"].includes(String(value.state))||
      (value.ownershipUncertain!==undefined&&(value.ownershipUncertain!==true||value.state!=="failed"))||
      !Object.keys(value).every(key=>["version","nativeReply","state","error","ownershipUncertain"].includes(key)))throw new Error("Invalid native admission reply");
    const pending=this.pending;if(!pending||pending.id!==value.nativeReply){if(Number(value.nativeReply)<=this.sequence)return true;throw new Error("Future native admission reply");}
    this.pending=undefined;
    if(value.state==="granted"&&!pending.cancelled&&!this.closed&&!pending.signal?.aborted)pending.resolve();
    else{
      if(value.state==="granted")this.send({version:1,event:"native-release",id:pending.id,drained:true});
      const reason=String(value.error??"Native admission disconnected or cancelled");
      pending.reject(pending.signal?.reason instanceof Error?pending.signal.reason:
        value.ownershipUncertain?new LibraryNativeDrainError(reason):new Error(reason));
    }return true;
  }
  async run<T>(phase:LibraryNativePhase,work:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    signal?.throwIfAborted();if(this.closed||this.running)throw new Error("Native admission closed or busy");this.running=true;
    const current=++this.sequence;
    const abort=()=>{if(this.pending?.id===current&&!this.pending.cancelled){this.pending.cancelled=true;this.send({version:1,event:"native-cancel",id:current});}};
    try{
      await new Promise<void>((resolve,reject)=>{this.pending={id:current,resolve,reject,signal,cancelled:false};signal?.addEventListener("abort",abort,{once:true});
        this.send({version:1,event:"native-request",id:current,phase});if(signal?.aborted)abort();});
      let uncertain=false;
      try{signal?.throwIfAborted();if(this.closed)throw new Error("Native admission closed");return await work();}
      catch(error){uncertain=error instanceof LibraryNativeDrainError;if(uncertain)this.send({version:1,event:"native-release",id:current,drained:false,error:message(error)});throw error;}
      finally{if(!uncertain)this.send({version:1,event:"native-release",id:current,drained:true});}
    }finally{signal?.removeEventListener("abort",abort);this.running=false;}
  }
  close():void{this.closed=true;const pending=this.pending;if(pending){pending.cancelled=true;this.send({version:1,event:"native-cancel",id:pending.id});this.pending=undefined;pending.reject(new Error("Native admission disconnected"));}}
}
