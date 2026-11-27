import { LibraryCurrentReplayApi } from "./library-current-replay-api";
import type { LibraryCurrentReplayAuthority,LibraryCurrentReplayBindingResult } from "./library-current-replay-authority";
import type { LibraryCurrentReplayOpenInput } from "./library-replay-opener";
import type { LibraryCurrentReplayPublication,LibraryCurrentReplayReceipt } from "../../../../shared/library-current-replay";
import { LIBRARY_REPLAY_PARSER_VERSION,LIBRARY_RESOURCE_PREPARATION_VERSION } from "../../../../shared/library-analysis";
import type { LibraryOperation } from "./library-process-client";

type Request=(method:LibraryOperation,args:Record<string,unknown>,assertCurrent?:()=>void)=>Promise<unknown>;
/** Composition of two capability boundaries: only main sees the Store authority, while the
 * renderer receives a bounded token for these already-verified resources. */
export class LibraryCurrentReplayBridge {
  private readonly api:LibraryCurrentReplayApi<LibraryCurrentReplayAuthority>;
  constructor(private readonly request:Request){
    this.api=new LibraryCurrentReplayApi({
      publish:(authority,results,assertCurrent)=>this.request("current-replay-store-publish",{authority,results},assertCurrent) as Promise<LibraryCurrentReplayPublication>,
      revoke:async authority=>{await this.request("current-replay-store-release",{authority});},
    });
  }
  async bind(input:LibraryCurrentReplayOpenInput,assertCurrent:()=>void){
    const bound=await this.request("current-replay-bind",input as unknown as Record<string,unknown>,assertCurrent) as LibraryCurrentReplayBindingResult;
    if(bound.state!=="applied")return bound;
    try{
      assertCurrent();const {authority}=bound;
      const currentReplay=this.api.issue({version:1,replayId:bound.replayId,replaySha256:authority.binding.replaySha256,
        mapSha256:authority.binding.mapSha256,mapMd5:authority.binding.mapMd5,numericalInputKey:authority.numericalTarget.inputKey,
        parserVersion:LIBRARY_REPLAY_PARSER_VERSION,preparationVersion:LIBRARY_RESOURCE_PREPARATION_VERSION,numericalVersion:authority.numericalTarget.producerVersion},authority);
      return{state:"applied" as const,replayId:bound.replayId,currentReplay};
    }catch(error){
      await this.request("current-replay-store-release",{authority:bound.authority});
      assertCurrent();
      // A full optional publication-capability cache must not prevent normal replay viewing.
      if(error instanceof Error&&error.message==="Current replay receipt limit reached")return{state:"applied" as const,replayId:bound.replayId};
      throw error;
    }
  }
  receive(value:unknown,assertCurrent:()=>void){return this.api.receive(value,assertCurrent);}
  release(receipt:LibraryCurrentReplayReceipt):Promise<void>{return this.api.release(receipt.token);}
  releaseDocument():Promise<void>{return this.api.releaseDocument();}
  close():Promise<void>{return this.api.close();}
}
