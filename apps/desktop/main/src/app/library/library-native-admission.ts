export type LibraryNativePhase="source-page"|"source-resolve"|"replay-decode"|"map-performance"|"timeline-performance"|"source-mutation";
export class LibraryNativeDrainError extends Error {readonly libraryNativeOwnershipUncertain=true;}
export interface LibraryNativeAdmission {
  run<T>(phase:LibraryNativePhase,work:()=>Promise<T>,signal?:AbortSignal):Promise<T>;
  runMutation?<T>(work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>;
  sourceResource?(operation:LibrarySourceResourceOperation,args:Record<string,unknown>):Promise<unknown>;
}
export type LibrarySourceResourceOperation="inspect-stable-deletion"|"prepare-stable-deletion"|"inspect-stable-stages"|"handoff-stable-stage"|"recover-stable-stages"|"discard-stable-stage"|"retire-stable-stage";
export const librarySourceResourceOperations=["inspect-stable-deletion","prepare-stable-deletion","inspect-stable-stages","handoff-stable-stage","recover-stable-stages","discard-stable-stage","retire-stable-stage"] as const;
export interface LibrarySourceMutationResources {run(operation:LibrarySourceResourceOperation,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>;close?():Promise<void>}
export interface LibrarySourceMutationAdmission {acquire(signal:AbortSignal):Promise<()=>Promise<void>>}
type Request={version:1;event:"native-request";id:number;phase:LibraryNativePhase}|{version:1;event:"native-cancel";id:number}|
  {version:1;event:"native-resource";id:number;resourceId:number;operation:LibrarySourceResourceOperation;args:Record<string,unknown>}|
  {version:1;event:"native-release";id:number;drained:boolean;error?:string};
type Reply={version:1;nativeReply:number;state:"granted"|"cancelled"|"failed"|"revoked"|"resource"|"released";error?:string;ownershipUncertain?:true;resourceId?:number;data?:unknown};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const id=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const phases=new Set(["source-page","source-resolve","replay-decode","map-performance","timeline-performance","source-mutation"]);
const sourcePhase=(phase:LibraryNativePhase)=>phase==="source-page"||phase==="source-resolve";
const message=(error:unknown)=>(error instanceof Error?error.message:"Native admission failed").slice(0,512);
interface Peer {send(value:Reply):void;priority:"analysis"|"artwork";held:boolean;closed:boolean;sequence:number;resourceSequence:number;retired:number;pending?:number;sourceMutation:boolean}
interface Waiting {peer:Peer;id:number;phase:LibraryNativePhase}
interface Mutation {item:Waiting;abort:AbortController;ready:boolean;granted:boolean;finishing:boolean;release?:()=>Promise<void>;resource?:Promise<void>}
export interface LibraryNativeEndpoint {receive(value:unknown):void;setHeld(value:boolean):Promise<void>;disconnected():void}

/** Main-owned helper admission. An uncertain native exit poisons the runtime's shared latch,
 * including replacement metadata owners; utility exit alone cannot establish helper drainage. */
export class LibraryNativeBroker {
  private held=false;private closed=false;private capacity:1|2|4=1;
  private readonly active=new Map<Peer,Waiting>();private readonly queued:Waiting[]=[];
  private readonly waiters:{peer?:Peer;promise:Promise<void>;resolve():void;reject(error:Error):void}[]=[];
  private mutation?:Mutation;
  constructor(private readonly latch:{error?:Error}={},private readonly maximumQueued=8,private readonly mutationAdmission?:LibrarySourceMutationAdmission,private readonly mutationResources?:LibrarySourceMutationResources){}
  status(){return{active:this.active.size,queued:this.queued.length,held:this.held,error:this.latch.error?.message,...(this.mutation?{sourceMutation:true}:{} )};}
  /** Trusted main policy only. Shrinking preserves existing ownership and gates subsequent grants. */
  setCapacity(value:1|2|4):void {
    if(![1,2,4].includes(value))throw new Error("Invalid library native capacity");
    this.capacity=value;this.pump();
  }
  attach(send:(value:Reply)=>void,priority:"analysis"|"artwork"="analysis",sourceMutation=false):LibraryNativeEndpoint {
    if(priority!=="analysis"&&priority!=="artwork")throw new Error("Invalid native peer priority");
    if(typeof sourceMutation!=="boolean"||sourceMutation&&(!this.mutationAdmission||priority!=="analysis"))throw new Error("Source mutation peer requires its main-owned admission policy");
    const peer:Peer={send,priority,held:false,closed:false,sequence:0,resourceSequence:0,retired:0,sourceMutation};
    return{receive:value=>this.receive(peer,value),setHeld:value=>{peer.held=value;if(value&&this.mutation?.item.peer===peer)this.revokeMutation("Metadata source owner is held");this.pump();return value?this.drain(peer):Promise.resolve();},
      disconnected:()=>{if(peer.closed)return;peer.closed=true;
        if(this.active.has(peer)||this.mutation?.item.peer===peer)this.poison(new Error("Native helper exit is unconfirmed after utility disconnected"));
        this.removeQueued(peer);this.pump();}};
  }
  setViewerDemand(value:boolean):Promise<void>{this.held=value;if(value)this.revokeMutation("Viewer requires source access");this.pump();return value?this.drain():Promise.resolve();}
  /** Shutdown waits this span before retiring metadata, preserving its actual helper-exit owner. */
  async drainMutation():Promise<void>{if(this.mutation){this.revokeMutation("Source mutation is closing");await this.drain(this.mutation.item.peer);}if(this.latch.error)throw this.latch.error;}
  private revokeMutation(reason:string):void {
    const mutation=this.mutation;if(!mutation||mutation.abort.signal.aborted)return;
    mutation.abort.abort(new Error(reason));
    if(mutation.granted)this.send(mutation.item.peer,{version:1,nativeReply:mutation.item.id,state:"revoked",error:reason});
    else if(mutation.ready)void this.finishMutation(mutation,new Error(reason));
  }
  private send(peer:Peer,value:Reply){if(peer.closed)return;try{peer.send(value);}catch(error){this.poison(new Error("Native admission transport failed: "+message(error)));}}
  private poison(error:Error){this.latch.error??=error;for(const item of this.queued.splice(0))this.reject(item,this.latch.error);this.acknowledge();}
  private reject(item:Waiting,error:Error){item.peer.pending=undefined;item.peer.retired=item.id;this.send(item.peer,{version:1,nativeReply:item.id,state:"failed",error:message(error),
    ...(this.latch.error?{ownershipUncertain:true as const}:{})});}
  private removeQueued(peer:Peer){for(let index=this.queued.length-1;index>=0;index--)if(this.queued[index].peer===peer){this.queued.splice(index,1);peer.pending=undefined;}}
  private receive(peer:Peer,value:unknown):void {
    if(peer.closed)return;
    if(record(value)&&value.event==="native-resource"){this.resource(peer,value);return;}
    if(!record(value)||value.version!==1||!id(value.id)||!Object.keys(value).every(key=>["version","event","id","phase","drained","error"].includes(key))||
      !["native-request","native-cancel","native-release"].includes(String(value.event))){this.poison(new Error("Invalid native admission event"));return;}
    const request=value as Exclude<Request,{event:"native-resource"}>;
    if(request.event==="native-request"){
      if(!phases.has(request.phase)||request.id!==peer.sequence+1||peer.pending!==undefined){this.poison(new Error("Invalid native acquisition sequence"));return;}
      peer.sequence=request.id;peer.pending=request.id;const item={peer,id:request.id,phase:request.phase};
      if(request.phase==="source-mutation"&&(!peer.sourceMutation||!this.mutationAdmission||this.held||peer.held)){
        this.reject(item,new Error("Source mutation admission is unavailable or viewer-owned"));return;
      }
      if(this.latch.error||this.closed||this.queued.length>=this.maximumQueued){this.reject(item,this.latch.error??new Error(this.closed?"Native admission closed":"Native admission queue is busy"));return;}
      this.queued.push(item);this.pump();return;
    }
    if(request.id===peer.retired)return;
    if(request.id!==peer.pending){this.poison(new Error("Stale native lease transition"));return;}
    const mutation=this.mutation;
    if(mutation?.item.peer===peer&&mutation.item.id===request.id){
      if(request.event==="native-cancel"){
        if(mutation.resource){this.poison(new Error("Source mutation cancelled before resource worker drainage"));return;}
        mutation.abort.abort(new Error("Source mutation acquisition cancelled"));
        if(mutation.ready)void this.finishMutation(mutation,mutation.abort.signal.reason);return;
      }
      if(request.event!=="native-release"||!mutation.granted||typeof request.drained!=="boolean"){
        this.poison(new Error("Invalid source mutation lease release"));return;
      }
      if(!request.drained){this.poison(new Error("Source mutation helper drainage unconfirmed: "+String(request.error??"unknown failure").slice(0,512)));return;}
      if(mutation.resource){this.poison(new Error("Source mutation released before resource worker drainage"));return;}
      void this.finishMutation(mutation);return;
    }
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
  private resource(peer:Peer,value:Record<string,unknown>):void {
    const mutation=this.mutation;
    if(value.version!==1||!id(value.id)||!id(value.resourceId)||!record(value.args)||
      !Object.keys(value).every(key=>["version","event","id","resourceId","operation","args"].includes(key))||Buffer.byteLength(JSON.stringify(value))>256*1024||
      !(librarySourceResourceOperations as readonly string[]).includes(String(value.operation))||!peer.sourceMutation||!this.mutationResources||
      !mutation?.granted||mutation.item.peer!==peer||mutation.item.id!==value.id||mutation.resource||value.resourceId!==peer.resourceSequence+1){
      this.poison(new Error("Invalid source mutation resource request"));return;
    }
    peer.resourceSequence=Number(value.resourceId);
    const respond=(data?:unknown,error?:unknown)=>{
      mutation.resource=undefined;
      const uncertain=error instanceof LibraryNativeDrainError;if(uncertain)this.poison(error);
      this.send(peer,{version:1,nativeReply:mutation.item.id,state:"resource",resourceId:peer.resourceSequence,
        ...(error?{error:message(error),...(uncertain?{ownershipUncertain:true as const}:{})}:{data})});
    };
    mutation.resource=Promise.resolve().then(()=>{
      mutation.abort.signal.throwIfAborted();
      return this.mutationResources?.run(value.operation as LibrarySourceResourceOperation,value.args as Record<string,unknown>,mutation.abort.signal);
    }).then(data=>{if(Buffer.byteLength(JSON.stringify(data)??"null")>1024*1024)throw new Error("Source resource reply exceeds its limit");respond(data);},error=>respond(undefined,error)).catch(error=>respond(undefined,error));
  }
  private pump(){
    if(this.mutation){
      const mutation=this.mutation;
      if(mutation.ready&&!mutation.granted&&!mutation.finishing&&!mutation.abort.signal.aborted&&!mutation.item.peer.held&&!this.closed&&!this.held&&!this.latch.error&&this.active.size===0){
        mutation.granted=true;this.active.set(mutation.item.peer,mutation.item);
        this.send(mutation.item.peer,{version:1,nativeReply:mutation.item.id,state:"granted"});
      }
      return;
    }
    if(!this.closed&&!this.held&&!this.latch.error){
      const index=this.queued.findIndex(item=>item.phase==="source-mutation"&&!item.peer.held&&!item.peer.closed);
      if(index>=0){this.beginMutation(this.queued.splice(index,1)[0]);return;}
    }
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
  private beginMutation(item:Waiting):void {
    const mutation:Mutation={item,abort:new AbortController(),ready:false,granted:false,finishing:false};this.mutation=mutation;
    // Admission's synchronous prefix fences foreground/background starts before any await.
    let acquired:Promise<()=>Promise<void>>;
    try{if(!this.mutationAdmission)throw new Error("Source mutation admission is unavailable");acquired=this.mutationAdmission.acquire(mutation.abort.signal);}catch(error){acquired=Promise.reject(error);}
    void acquired.then(release=>{
      mutation.release=release;
      if(mutation.abort.signal.aborted||this.closed||this.held||this.latch.error||item.peer.closed)
        return this.finishMutation(mutation,mutation.abort.signal.reason??this.latch.error??new Error("Source mutation acquisition retired"));
      mutation.ready=true;this.pump();return undefined;
    }).catch(error=>{if(error instanceof LibraryNativeDrainError)this.poison(error);return this.finishMutation(mutation,error);});
  }
  private async finishMutation(mutation:Mutation,error?:unknown):Promise<void> {
    if(mutation.finishing||this.mutation!==mutation)return;mutation.finishing=true;
    try{await this.mutationResources?.close?.();await mutation.release?.();}
    catch(failure){const error=new LibraryNativeDrainError("Source mutation owner did not release: "+message(failure));this.poison(error);
      this.send(mutation.item.peer,{version:1,nativeReply:mutation.item.id,state:"failed",error:error.message,ownershipUncertain:true});return;}
    const {item}=mutation;this.active.delete(item.peer);item.peer.pending=undefined;item.peer.retired=item.id;this.mutation=undefined;
    if(!mutation.granted)this.send(item.peer,{version:1,nativeReply:item.id,state:mutation.abort.signal.aborted?"cancelled":"failed",error:message(error)});
    else this.send(item.peer,{version:1,nativeReply:item.id,state:"released"});
    this.acknowledge();this.pump();
  }
  private drained(peer?:Peer):boolean {return (peer?!this.active.has(peer):this.active.size===0)&&(!this.mutation||peer!==undefined&&this.mutation.item.peer!==peer);}
  private drain(peer?:Peer):Promise<void>{
    if(this.latch.error)return Promise.reject(this.latch.error);
    if(this.drained(peer))return Promise.resolve();
    const existing=this.waiters.find(waiter=>waiter.peer===peer);if(existing)return existing.promise;
    if(this.waiters.length>=32)return Promise.reject(new Error("Native drain acknowledgements are busy"));
    let resolve!:()=>void,reject!:(error:Error)=>void;
    const promise=new Promise<void>((done,fail)=>{resolve=done;reject=fail;});this.waiters.push({peer,promise,resolve,reject});return promise;
  }
  private acknowledge(){for(let index=this.waiters.length-1;index>=0;index--){const waiter=this.waiters[index];
    if(this.latch.error||this.drained(waiter.peer)){this.waiters.splice(index,1);if(this.latch.error)waiter.reject(this.latch.error);else waiter.resolve();}}}
  close():Promise<void>{this.closed=true;this.revokeMutation("Native admission closed");for(const item of this.queued.splice(0))this.reject(item,new Error("Native admission closed"));return this.drain();}
}

/** Utility-owned serial admission. Only an already held metadata mutation span may request
 * bounded Stable metadata/staging work; main rebinds its source/app authority. No DB/replay bytes. */
export class LibraryNativeBridge implements LibraryNativeAdmission {
  private sequence=0;private closed=false;private pending?:{id:number;resolve():void;reject(error:Error):void;signal?:AbortSignal;cancelled:boolean};
  private running=false;
  private mutation?:{id:number;abort:AbortController};
  private resourceSequence=0;private resourcePending?:{id:number;resolve(value:unknown):void;reject(error:Error):void};
  private releasePending?:{id:number;resolve():void;reject(error:Error):void};
  constructor(private readonly send:(value:Request)=>void){}
  receive(value:unknown):boolean {
    if(!record(value)||!("nativeReply"in value))return false;
    if(value.state==="resource"){
      if(value.version!==1||value.nativeReply!==this.mutation?.id||!id(value.resourceId)||!this.resourcePending||this.resourcePending.id!==value.resourceId||
        !Object.keys(value).every(key=>["version","nativeReply","state","resourceId","data","error","ownershipUncertain"].includes(key))||
        value.error!==undefined&&typeof value.error!=="string"||value.ownershipUncertain!==undefined&&(value.ownershipUncertain!==true||typeof value.error!=="string")||
        Buffer.byteLength(JSON.stringify(value))>1024*1024+2048)throw new Error("Invalid source resource reply");
      const pending=this.resourcePending;this.resourcePending=undefined;
      if(value.error!==undefined)pending.reject(value.ownershipUncertain?new LibraryNativeDrainError(String(value.error)):new Error(String(value.error)));else pending.resolve(value.data);return true;
    }
    if(value.version!==1||!id(value.nativeReply)||!["granted","cancelled","failed","revoked","released"].includes(String(value.state))||
      (value.ownershipUncertain!==undefined&&(value.ownershipUncertain!==true||value.state!=="failed"))||
      !Object.keys(value).every(key=>["version","nativeReply","state","error","ownershipUncertain"].includes(key)))throw new Error("Invalid native admission reply");
    if(value.state==="revoked"){
      if(this.mutation?.id===value.nativeReply)this.mutation.abort.abort(new Error(String(value.error??"Source mutation revoked")));
      else if(Number(value.nativeReply)>this.sequence)throw new Error("Future source mutation revocation");
      return true;
    }
    if(this.releasePending?.id===value.nativeReply){const releasing=this.releasePending;
      if(value.state!=="released"&&value.state!=="failed")throw new Error("Invalid source release acknowledgement");this.releasePending=undefined;
      if(value.state==="released")releasing.resolve();else releasing.reject(new LibraryNativeDrainError(String(value.error??"Source release unconfirmed")));return true;}
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
    if(phase==="source-mutation"&&this.mutation?.id!==this.sequence+1)throw new Error("Use the revocable source mutation span");
    signal?.throwIfAborted();if(this.closed||this.running)throw new Error("Native admission closed or busy");this.running=true;
    const current=++this.sequence;
    const abort=()=>{if(this.pending?.id===current&&!this.pending.cancelled){this.pending.cancelled=true;this.send({version:1,event:"native-cancel",id:current});}};
    try{
      await new Promise<void>((resolve,reject)=>{this.pending={id:current,resolve,reject,signal,cancelled:false};signal?.addEventListener("abort",abort,{once:true});
        this.send({version:1,event:"native-request",id:current,phase});if(signal?.aborted)abort();});
      let uncertain=false;
      try{signal?.throwIfAborted();if(this.closed)throw new Error("Native admission closed");return await work();}
      catch(error){uncertain=error instanceof LibraryNativeDrainError;if(uncertain)this.send({version:1,event:"native-release",id:current,drained:false,error:message(error)});throw error;}
      finally{if(!uncertain){
        if(phase==="source-mutation")await new Promise<void>((resolve,reject)=>{this.releasePending={id:current,resolve,reject};
          try{this.send({version:1,event:"native-release",id:current,drained:true});}catch(error){this.releasePending=undefined;reject(new LibraryNativeDrainError("Source release transport failed: "+message(error)));}});
        else this.send({version:1,event:"native-release",id:current,drained:true});}}
    }finally{signal?.removeEventListener("abort",abort);this.running=false;}
  }
  async runMutation<T>(work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    if(this.closed||this.running||this.mutation)throw new Error("Native mutation admission closed or busy");
    const mutation={id:this.sequence+1,abort:new AbortController()},abort=()=>mutation.abort.abort(signal?.reason);
    this.mutation=mutation;signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
    try{return await this.run("source-mutation",()=>work(mutation.abort.signal),mutation.abort.signal);}
    finally{signal?.removeEventListener("abort",abort);if(this.mutation===mutation)this.mutation=undefined;}
  }
  sourceResource(operation:LibrarySourceResourceOperation,args:Record<string,unknown>):Promise<unknown>{
    if(this.closed||!this.running||!this.mutation||this.pending||this.resourcePending||this.releasePending||!librarySourceResourceOperations.includes(operation))
      return Promise.reject(new Error("Source resources require the held metadata mutation span"));
    const mutation=this.mutation,resourceId=++this.resourceSequence;
    return new Promise((resolve,reject)=>{this.resourcePending={id:resourceId,resolve,reject};
      try{this.send({version:1,event:"native-resource",id:mutation.id,resourceId,operation,args});}catch(error){this.resourcePending=undefined;reject(error);}});
  }
  close():void{this.closed=true;this.mutation?.abort.abort(new Error("Source mutation bridge closed"));
    const releasing=this.releasePending;this.releasePending=undefined;releasing?.reject(new LibraryNativeDrainError("Source release transport disconnected before drainage"));
    const resource=this.resourcePending;this.resourcePending=undefined;resource?.reject(new LibraryNativeDrainError("Source resource transport disconnected before drainage"));
    const pending=this.pending;if(pending){pending.cancelled=true;this.send({version:1,event:"native-cancel",id:pending.id});this.pending=undefined;pending.reject(new Error("Native admission disconnected"));}}
}
