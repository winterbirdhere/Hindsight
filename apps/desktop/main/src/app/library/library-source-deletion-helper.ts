import { ChildProcessWithoutNullStreams,spawn } from "child_process";
import { LibraryNativeDrainError } from "./library-native-admission";

export type LibraryDeletionHelperFlag="--library-source-deletion"|"--library-file-mutation"|"--library-process-identity";
export interface LibraryDeletionHelperReply extends Record<string,unknown> {version:1;ok:boolean;status:string}
export type LibraryDeletionHelperSpawn=(executable:string,flag:LibraryDeletionHelperFlag)=>ChildProcessWithoutNullStreams;
const spawnHelper:LibraryDeletionHelperSpawn=(executable,flag)=>spawn(executable,[flag],{windowsHide:true,shell:false,stdio:"pipe"});
const MAX_LINE=512*1024,MAX_REQUEST=128*1024;
const text=(error:unknown)=>error instanceof Error?error.message:"Deletion helper failed";

/** One owned JSONL session. A dispatched write is never cancelled merely because UI demand
 * changes. Its command/whole-process deadlines still bound hung native cleanup; missing exit
 * proof is a LibraryNativeDrainError, retaining the main broker's uncertainty fence. */
export class LibrarySourceDeletionHelper {
  private readonly child:ChildProcessWithoutNullStreams;
  private readonly exit:Promise<void>;private exited=false;private resolveExit!:()=>void;
  private readonly lifetime:ReturnType<typeof setTimeout>;
  private bytes=Buffer.allocUnsafe(MAX_LINE);private length=0;
  private pending?:{resolve(value:LibraryDeletionHelperReply):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>};
  private failure?:Error;private drainFailure?:LibraryNativeDrainError;private stopping?:Promise<void>;private closing?:Promise<void>;
  constructor(executable:string,flag:LibraryDeletionHelperFlag,create:LibraryDeletionHelperSpawn=spawnHelper){
    if(!["--library-source-deletion","--library-file-mutation","--library-process-identity"].includes(flag))throw new Error("Unknown deletion helper");
    this.exit=new Promise(resolve=>{this.resolveExit=resolve;});
    this.child=create(executable,flag);
    this.lifetime=setTimeout(()=>{void this.terminate(new Error("Deletion helper lifetime expired"));},33_000);
    this.child.stdout.on("data",(chunk:Buffer)=>this.receive(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));
    this.child.stdout.on("error",error=>{void this.terminate(error);});
    this.child.stdin.on("error",error=>{void this.terminate(error);});
    this.child.stderr.on("error",error=>{void this.terminate(error);});this.child.stderr.resume();
    this.child.on("error",error=>{
      if(this.child.pid===undefined){this.failure=error;this.finishExit();}
      else void this.terminate(error);
    });
    this.child.on("close",()=>this.finishExit());
  }
  private finishExit():void {
    if(this.exited)return;this.exited=true;clearTimeout(this.lifetime);this.resolveExit();
    const pending=this.pending;this.pending=undefined;
    if(pending){clearTimeout(pending.timer);pending.reject(this.failure??new Error("Deletion helper exited without its receipt; check the recorded outcome"));}
  }
  private receive(chunk:Buffer):void {
    if(this.failure||this.exited)return;
    let start=0;
    while(start<chunk.length){
      const end=chunk.indexOf(10,start),count=(end<0?chunk.length:end)-start;
      if(count>MAX_LINE-this.length){void this.terminate(new Error("Deletion helper response exceeds its limit"));return;}
      chunk.copy(this.bytes,this.length,start,start+count);this.length+=count;
      if(end<0)return;
      const pending=this.pending;
      try{
        if(!pending)throw new Error("Deletion helper sent an unsolicited receipt");
        const value:unknown=JSON.parse(this.bytes.subarray(0,this.length).toString("utf8"));
        if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid deletion helper response");
        const reply=value as LibraryDeletionHelperReply;
        if(reply.version!==1||typeof reply.ok!=="boolean"||typeof reply.status!=="string"||reply.status.length>128)throw new Error("Invalid deletion helper response");
        this.length=0;this.pending=undefined;clearTimeout(pending.timer);pending.resolve(reply);
      }catch(error){void this.terminate(new Error(text(error)));return;}
      start=end+1;
    }
  }
  request(input:Record<string,unknown>):Promise<LibraryDeletionHelperReply>{
    if(this.exited||this.failure||this.closing)return Promise.reject(this.failure??new Error("Deletion helper is closed"));
    if(this.pending)return Promise.reject(new Error("Deletion helper commands must be serial"));
    const line=JSON.stringify({version:1,...input})+"\n";
    if(input.version!==undefined&&input.version!==1||Buffer.byteLength(line)>MAX_REQUEST)return Promise.reject(new Error("Deletion helper request exceeds its protocol limit"));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{void this.terminate(new Error("Deletion helper command timed out; check the recorded outcome"));},8_000);
      this.pending={resolve,reject,timer};
      try{this.child.stdin.write(line);}catch(error){void this.terminate(new Error(text(error)));}
    });
  }
  private terminate(reason:Error):Promise<void>{
    if(this.stopping)return this.stopping;
    this.failure??=reason;clearTimeout(this.lifetime);
    this.stopping=(async()=>{
      if(!this.exited){try{this.child.kill();}catch{/* Actual close is still required below. */}}
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        await Promise.race([this.exit,new Promise<void>((_resolve,reject)=>{timer=setTimeout(()=>reject(new LibraryNativeDrainError("Deletion helper exit is unconfirmed")),2_000);})]);
      }catch(error){
        this.drainFailure=error instanceof LibraryNativeDrainError?error:new LibraryNativeDrainError(text(error));
        const pending=this.pending;this.pending=undefined;if(pending){clearTimeout(pending.timer);pending.reject(this.drainFailure);}
      }finally{clearTimeout(timer);}
    })();
    return this.stopping;
  }
  close():Promise<void>{
    if(this.closing)return this.closing;
    this.closing=(async()=>{
      if(this.stopping){await this.stopping;if(this.drainFailure)throw this.drainFailure;return;}
      if(this.pending)await this.terminate(new Error("Deletion helper closed during a command; check the recorded outcome"));
      else if(!this.exited){
        try{this.child.stdin.end();}catch(error){await this.terminate(new Error(text(error)));}
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([this.exit,new Promise<void>(resolve=>{timer=setTimeout(resolve,1_000);})]);}finally{clearTimeout(timer);}
        if(!this.exited)await this.terminate(new Error("Deletion helper did not exit after close"));
      }
      await this.stopping;if(this.drainFailure)throw this.drainFailure;
    })();return this.closing;
  }
}

export async function deletionHelperOnce(executable:string,flag:LibraryDeletionHelperFlag,input:Record<string,unknown>):Promise<LibraryDeletionHelperReply>{
  const helper=new LibrarySourceDeletionHelper(executable,flag);
  try{return await helper.request(input);}finally{await helper.close();}
}
