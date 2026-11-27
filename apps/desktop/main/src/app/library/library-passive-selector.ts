import { randomUUID } from "crypto";
import { isAbsolute } from "path";
import type { LibraryOperation } from "./library-process-client";
import type { LibraryResourceOperation } from "./library-resource-server";
import type { LibraryOpenLocation,LibraryOpenMap,LibraryLocationCursor } from "./library-store";
import type { LibraryPassiveSelection,LibraryPassiveResourceDependencies } from "./library-passive-resources";
import { hasVerifiedStableArtwork } from "./library-passive-resources";
import type { LazerSourceScore } from "./sources/lazer-source";
import type { LibraryErrorStripEntry } from "../../../../shared/replay-library-metrics";
import { sourceMapEvidence } from "./library-source-binding";
import { LibraryNativeDrainError } from "./library-native-admission";
import { LibraryArtworkCache } from "./library-artwork-cache";

interface Dependencies {
  metadata(method:LibraryOperation,args:Record<string,unknown>):Promise<unknown>;
  createNative():{request(method:LibraryResourceOperation,args?:Record<string,unknown>):Promise<unknown>;close():Promise<void>};
  artworkCache?:LibraryArtworkCache;
  thumbnail?(bytes:Buffer):Promise<Buffer>;
}
/** Main-only selection of existing indexed paths. No observation, job or file import is published. */
export function createLibraryPassiveSelector(dependencies:Dependencies):LibraryPassiveResourceDependencies {
  const artworkCache=dependencies.artworkCache??new LibraryArtworkCache();
  const leases=new WeakMap<LibraryPassiveSelection,{location:LibraryOpenLocation;map?:LibraryOpenMap}>();
  const remember=(location:LibraryOpenLocation,map:LibraryOpenMap|undefined,selection:LibraryPassiveSelection)=>{
    leases.set(selection,{location,...(map?{map}:{})});return selection;
  };
  const native=async(ticket:LibraryOpenLocation,signal:AbortSignal,artwork:boolean)=>{
    const owner=dependencies.createNative(),sessionId=randomUUID();let abortClose:Promise<void>|undefined;
    const close=async()=>{try{await owner.close();}catch(error){throw error instanceof LibraryNativeDrainError?error:
      new LibraryNativeDrainError("Passive native cleanup failed: "+(error instanceof Error?error.message:"exit not confirmed").slice(0,512));}};
    const cancel=()=>{abortClose??=close();void abortClose.catch(()=>undefined);};
    signal.addEventListener("abort",cancel,{once:true});
    try{
      signal.throwIfAborted();
      const score=await owner.request(artwork?"resolve-passive-artwork":"resolve-passive-native",{sessionId,ticket}) as LazerSourceScore;
      signal.throwIfAborted();return score;
    }finally{signal.removeEventListener("abort",cancel);await (abortClose??close());}
  };
  return{
    ...(dependencies.thumbnail?{thumbnail:dependencies.thumbnail}:{}),
    async select(replayId,purpose,signal){
      let after:LibraryLocationCursor|undefined,attempts=0;
      do{
        signal.throwIfAborted();const page=await dependencies.metadata("prepare-open",{replayId,...(after?{after}:{})}) as {items:LibraryOpenLocation[];next?:LibraryLocationCursor};
        if(!Array.isArray(page.items)||page.items.length>8||page.next&&JSON.stringify(page.next)===JSON.stringify(after))throw Error("Invalid passive location page");
        for(const location of page.items){
          signal.throwIfAborted();if(++attempts>64)throw Error("Passive location budget exceeded");
          const selection:LibraryPassiveSelection={replayId:location.replayId,revision:randomUUID(),
            ...(location.sha256&&isAbsolute(location.locator)?{replay:{root:location.directory,path:location.locator,sha256:location.sha256}}:{})};
          if(purpose==="reveal"&&selection.replay)return remember(location,undefined,selection);
          const evidence=sourceMapEvidence(location),md5=evidence.headerMd5??evidence.sourceMd5;
          if(purpose==="artwork"&&evidence.headerMd5&&evidence.sourceMd5&&evidence.headerMd5!==evidence.sourceMd5)continue;
          let indexedMaps:LibraryOpenMap[]|undefined;
          const stableMap=async()=>{
            if(!indexedMaps){const maps=await dependencies.metadata("prepare-map",{md5}) as {items:LibraryOpenMap[]};signal.throwIfAborted();
              if(!Array.isArray(maps.items)||maps.items.length>8)throw Error("Invalid passive map page");indexedMaps=maps.items;}
            return indexedMaps.find(candidate=>candidate.kind==="stable"&&candidate.md5===md5&&typeof candidate.metadata.songsRoot==="string"&&isAbsolute(candidate.metadata.songsRoot));
          };
          if(location.kind==="lazer"&&location.sha256){
            // Avoid a native manifest only for an exact, currently readable indexed map.
            // The resource reader still validates its own map/asset snapshot before publication.
            if(purpose==="artwork"&&md5){
              const map=await stableMap();
              if(map){try{
                const lease={location,map};
                if(await dependencies.metadata("resource-current",lease)===true){
                  signal.throwIfAborted();const usable=await hasVerifiedStableArtwork({songsRoot:map.metadata.songsRoot as string,path:map.locator,md5},signal,artworkCache,dependencies.thumbnail);
                  const current=await dependencies.metadata("resource-current",lease);signal.throwIfAborted();
                  if(usable&&current===true){selection.map={kind:"stable",songsRoot:map.metadata.songsRoot as string,path:map.locator,md5};return remember(location,map,selection);}
                }
              }catch{signal.throwIfAborted();}}
            }
            let score:LazerSourceScore|undefined;
            try{score=await native(location,signal,purpose==="artwork");signal.throwIfAborted();}catch(error){
              if(error instanceof LibraryNativeDrainError||error&&typeof error==="object"&&"libraryNativeOwnershipUncertain"in error&&error.libraryNativeOwnershipUncertain===true)throw error;
              signal.throwIfAborted();
            }
            if(score){
              if(score.id!==location.sourceKey||score.replay.sha256!==location.sha256)throw Error("Passive native score changed");
              if(purpose==="reveal"){
                if(["available","unverified"].includes(score.replay.status)&&score.replay.path&&isAbsolute(score.replay.path)){
                  selection.replay={root:location.directory,path:score.replay.path,sha256:location.sha256};return remember(location,undefined,selection);
                }
              }else{
                const map=score.beatmap;
                if(["available","unverified"].includes(map.status)&&map.path&&map.sha256&&map.md5&&(!md5||map.md5===md5)){
                  selection.map={kind:"lazer",directory:location.directory,md5:map.md5,file:{path:map.path,sha256:map.sha256},
                    assets:score.assets.map(asset=>({name:asset.name,...asset.resource})),manifestComplete:score.assetManifestComplete===true,
                    ...(score.artworkLookup?{artworkLookup:score.artworkLookup}:{})};
                  return remember(location,undefined,selection);
                }
              }
            }
          }
          if(purpose==="reveal")continue;
          if(!md5)continue;
          const map=await stableMap();
          if(map){selection.map={kind:"stable",songsRoot:map.metadata.songsRoot as string,path:map.locator,md5};return remember(location,map,selection);}
        }
        if(page.next&&!page.items.length)throw Error("Passive location page did not advance");after=page.next;
      }while(after);
      return undefined;
    },
    async isCurrent(selection){const lease=leases.get(selection);return !!lease&&await dependencies.metadata("resource-current",lease)===true;},
    async readStrip(replayId,signal){signal.throwIfAborted();const result=await dependencies.metadata("metric-strip-read",{replayId}) as LibraryErrorStripEntry|undefined;signal.throwIfAborted();return result;},
  };
}
