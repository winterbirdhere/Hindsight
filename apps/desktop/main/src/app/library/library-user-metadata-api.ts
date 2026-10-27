import type { LibraryCollectionDeleteResult, LibraryPlayerNames, LibraryUserMetadataRequest } from "../../../../shared/replay-library";
import type { LibraryStore } from "./library-store";

export const LIBRARY_USER_METADATA_OPERATIONS = ["collection-create", "collection-rename", "collection-delete", "replay-review", "replay-favourite", "collection-membership", "player-names-set"] as const;
export type LibraryUserMetadataOperation = typeof LIBRARY_USER_METADATA_OPERATIONS[number];
type Store = Pick<LibraryStore, "createCollection" | "renameCollection" | "deleteCollection" | "setReview" | "setFavourite" | "setMembership" | "setPlayerNames" | "playerNames">;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)&&
  (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const identity=(value:unknown):value is string=>typeof value==="string"&&/^[a-zA-Z0-9_.:/+-]{1,128}$/.test(value);
const name=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0&&value.length<=256&&!value.includes("\0");
const keys:Record<LibraryUserMetadataOperation,string[]>={
  "collection-create":["name","parentId","replayId"],"collection-rename":["collectionId","name"],"collection-delete":["collectionId","referencedIds"],
  "replay-review":["replayId","review"],"replay-favourite":["replayId","favourite"],"collection-membership":["replayId","collectionId","included"],
  "player-names-set":["names"],
};
export function validateLibraryUserMetadata(method:string,args:unknown):asserts args is Omit<LibraryUserMetadataRequest,"method"> {
  if(!Object.prototype.hasOwnProperty.call(keys,method)||!record(args)||Object.keys(args).some(key=>!keys[method as LibraryUserMetadataOperation].includes(key)))
    throw new Error("Invalid library metadata operation");
  if((method!=="collection-create"&&keys[method as LibraryUserMetadataOperation].includes("replayId")||args.replayId!==undefined)&&!identity(args.replayId)||
    keys[method as LibraryUserMetadataOperation].includes("collectionId")&&!identity(args.collectionId)||
    keys[method as LibraryUserMetadataOperation].includes("name")&&!name(args.name)||
    method==="collection-create"&&args.parentId!==undefined&&args.parentId!==null&&!identity(args.parentId)||
    method==="replay-review"&&(typeof args.review!=="string"||!["not-reviewed","reviewed","needs-another-look"].includes(args.review))||
    method==="replay-favourite"&&typeof args.favourite!=="boolean"||method==="collection-membership"&&typeof args.included!=="boolean")
    throw new Error("Invalid library metadata value");
  if(method==="player-names-set"&&(!Array.isArray(args.names)||args.names.length>100||Array.from(args.names).some(value=>!name(value))))
    throw new Error("Invalid player names");
  if(method==="collection-delete"&&args.referencedIds!==undefined&&(!Array.isArray(args.referencedIds)||args.referencedIds.length>101||
    Array.from(args.referencedIds).some(value=>!identity(value))||new Set(args.referencedIds).size!==args.referencedIds.length))
    throw new Error("Invalid referenced collection identities");
}

/** Single user edits only. Store transactions retain identity aliases and never touch replay files. */
export class LibraryUserMetadataApi {
  constructor(private readonly store:Store){}
  receive(method:LibraryUserMetadataOperation,args:Record<string,unknown>):{id:string}|LibraryCollectionDeleteResult|LibraryPlayerNames|null {
    validateLibraryUserMetadata(method,args);
    const input={method,...args} as LibraryUserMetadataRequest;
    switch(input.method){
      case "player-names-set":this.store.setPlayerNames(input.names);return{names:this.store.playerNames()};
      case "collection-create":return{id:this.store.createCollection(input.name,input.parentId??null,input.replayId)};
      case "collection-rename":this.store.renameCollection(input.collectionId,input.name);break;
      case "collection-delete":{
        const referencedIds=input.referencedIds??[],allowed=new Set([input.collectionId,...referencedIds]);
        const deletedReferences=this.store.deleteCollection(input.collectionId,referencedIds);
        if(!Array.isArray(deletedReferences)||deletedReferences.length>102||new Set(deletedReferences).size!==deletedReferences.length||
          Array.from(deletedReferences).some(id=>!identity(id)||!allowed.has(id)))throw new Error("Invalid deleted collection references");
        return{deletedReferences};
      }
      case "replay-review":this.store.setReview(input.replayId,input.review);break;
      case "replay-favourite":this.store.setFavourite(input.replayId,input.favourite);break;
      case "collection-membership":this.store.setMembership(input.replayId,input.collectionId,input.included);break;
    }
    return null;
  }
}
