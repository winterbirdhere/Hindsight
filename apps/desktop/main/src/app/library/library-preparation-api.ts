import type { LibraryAnalysisReason } from "../../../../shared/replay-library-metrics";
import { LibraryPreparationStore, LibraryPreparationStage, LibraryPreparationTicket } from "./library-preparation-store";

export const LIBRARY_PREPARATION_OPERATIONS=["preparation-request","preparation-read","preparation-next","preparation-claim",
  "preparation-release","preparation-fail"] as const;
export type LibraryPreparationOperation=typeof LIBRARY_PREPARATION_OPERATIONS[number];
/** Main only: publication with selected-resource CAS is a separate LibraryStore operation. */
export class LibraryPreparationApi {
  constructor(private readonly store:LibraryPreparationStore){}
  receive(method:LibraryPreparationOperation,args:Record<string,unknown>):unknown {
    if(method==="preparation-next")return this.store.nextQueued(args.limit as number|undefined,args.availableStages as LibraryPreparationStage[]|undefined,args.beforeMetric as string|undefined);
    if(method==="preparation-release"||method==="preparation-fail") {
      if(!args.ticket||typeof args.ticket!=="object"||Array.isArray(args.ticket))throw new Error("Invalid preparation ticket");
      return method==="preparation-release"?this.store.release(args.ticket as LibraryPreparationTicket)
        :this.store.fail(args.ticket as LibraryPreparationTicket,args.error as string);
    }
    if(typeof args.replayId!=="string"||args.replayId.length<1||args.replayId.length>128)throw new Error("Invalid preparation identity");
    if(method==="preparation-read")return this.store.read(args.replayId);
    if(method==="preparation-request")return this.store.request(args.replayId,args.stage as LibraryPreparationStage,args.reason as LibraryAnalysisReason);
    if(method==="preparation-claim")return this.store.claim(args.replayId,args.stage as LibraryPreparationStage);
    throw new Error("Unknown preparation operation");
  }
}
