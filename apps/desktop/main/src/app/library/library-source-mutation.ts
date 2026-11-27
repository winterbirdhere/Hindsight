import { LibraryNativeDrainError,LibrarySourceMutationAdmission } from "./library-native-admission";

/** Runtime-owned source fence. Current replay publication and in-memory sessions do not pass here. */
export class LibrarySourceMutationFence implements LibrarySourceMutationAdmission {
  private active=false;private readers=0;
  constructor(private readonly policy:{busy():boolean;drain():Promise<void>;release():Promise<void>}){}
  get held():boolean{return this.active;}
  async read<T>(work:()=>Promise<T>):Promise<T>{
    if(this.active)throw new Error("Source deletion is active");this.readers++;
    try{return await work();}finally{this.readers--;}
  }
  assertReadable():void {if(this.active)throw new Error("Source deletion is active");}
  async acquire(signal:AbortSignal):Promise<()=>Promise<void>>{
    signal.throwIfAborted();
    if(this.active||this.readers||this.policy.busy())throw new Error("Viewer or source configuration is busy");
    this.active=true;
    try{await this.policy.drain();}
    catch(error){throw new LibraryNativeDrainError(error instanceof Error?error.message:"Source reader drainage failed");}
    const release=async()=>{await this.policy.release();this.active=false;};
    if(signal.aborted){await release();signal.throwIfAborted();}
    return release;
  }
}
