import type { LibraryDeletionRequest } from "../../../../shared/library-deletion";
import type { LibraryDeletionCoordinator } from "./library-deletion-coordinator";
export const LIBRARY_DELETION_OPERATIONS=["deletion-preview","deletion-commit","deletion-cancel","deletion-status","deletion-recover","deletion-pending","deletion-cleanup","deletion-continue-preview"] as const;
export type LibraryDeletionOperation=typeof LIBRARY_DELETION_OPERATIONS[number];
const identity=(value:unknown)=>typeof value==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function validateLibraryDeletion(method:string,args:unknown):asserts args is Omit<LibraryDeletionRequest,"method"> {
  if(!(LIBRARY_DELETION_OPERATIONS as readonly string[]).includes(method)||!args||typeof args!=="object"||Array.isArray(args)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(args)))throw new Error("Invalid deletion operation");
  const input=args as Record<string,unknown>,confirmation=method==="deletion-commit"||method==="deletion-cancel",status=method==="deletion-status"||method==="deletion-recover"||method==="deletion-cleanup"||method==="deletion-continue-preview";
  if(method==="deletion-pending"){
    if(Object.keys(input).some(key=>key!=="after")||input.after!==undefined&&!identity(input.after))throw new Error("Invalid deletion recovery cursor");return;
  }
  const keys=status?["intentId"]:confirmation?["replayId","token"]:["replayId"];
  if(Object.keys(input).some(key=>!keys.includes(key))||!identity(input[status?"intentId":"replayId"])||
    confirmation&&(typeof input.token!=="string"||!/^[a-f\d]{64}$/.test(input.token)))throw new Error("Invalid deletion confirmation");
}
export class LibraryDeletionApi {
  constructor(private readonly coordinator:LibraryDeletionCoordinator){}
  receive(method:LibraryDeletionOperation,args:Record<string,unknown>){
    validateLibraryDeletion(method,args);const input={method,...args} as LibraryDeletionRequest;
    switch(input.method){
      case "deletion-pending":return this.coordinator.pending(input.after);
      case "deletion-preview":return this.coordinator.preview(input.replayId);
      case "deletion-commit":return this.coordinator.commit(input.replayId,input.token);
      case "deletion-cancel":return this.coordinator.cancel(input.replayId,input.token);
      case "deletion-status":return this.coordinator.status(input.intentId);
      case "deletion-recover":return this.coordinator.recover(input.intentId);
      case "deletion-cleanup":return this.coordinator.cleanup(input.intentId);
      case "deletion-continue-preview":return this.coordinator.continuePreview(input.intentId);
    }
  }
}
