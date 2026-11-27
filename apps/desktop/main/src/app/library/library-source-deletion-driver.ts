import { join,win32 } from "path";
import { lstat } from "fs/promises";
import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";
import { LibraryDeletionDriver,LibraryDeletionPrepared,LibraryDeletionPreparationContext,LibraryDeletionLease } from "./library-deletion-coordinator";
import { LibraryDeletionIntent,LibraryDeletionPlannedTarget,LibraryDeletionSnapshot,LibraryDeletionHeaderWitness,deletionFingerprint } from "./library-deletion-store";
import { LibraryNativeAdmission,LibraryNativeDrainError } from "./library-native-admission";
import { LibrarySourceDeletionHelper } from "./library-source-deletion-helper";
import { LibraryNativeDeletionPlan,LibraryNativeDeletionSession,inspectNativeDeletion,prepareNativeDeletion,reconcileNativeDeletion } from "./library-source-native-deletion";
import { LibraryFileDeletionPlan,LibraryFileDeletionSelection,LibraryFileDeletionSession,prepareFileDeletion,reconcileFileDeletion,cleanupFileDeletion } from "./library-source-file-deletion";
import type { LibraryStableDeletionInspection,LibraryStableDeletionPreparation } from "./library-stable-deletion-resource";
import type { LibraryStableStageReference } from "./library-stable-deletion-stage";
import { inspectReplayFile } from "./sources/replay-file";
import { matchesSavedScore } from "./sources/stable-scores-source";
import { contentIdentityKey,validatedContentIdentity } from "./library-content-identity";

const samePath=(a:string,b:string)=>win32.resolve(a).toLowerCase()===win32.resolve(b).toLowerCase();
function relative(root:string,path:string){const value=win32.relative(root,path);if(!value||win32.isAbsolute(value)||value.split(/[\\/]/).some(part=>part===".."))throw Error("Known replay path is outside its source root");return value.replace(/\\/g,"/");}
const errorText=(error:unknown)=>(error instanceof Error?error.message:"Source preparation failed").slice(0,2048);
function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function headerRootIdentity(directory:string):Promise<string>{const value=await lstat(directory,{bigint:true});
  if(!value.isDirectory()||value.isSymbolicLink())throw Error("Historical header source root is not a verified directory");
  return deletionFingerprint([String(value.dev),String(value.ino),String(value.birthtimeNs)]);}
interface HistoricalSourceGuard {
  sourceId:string;sourceKind:string;sourceDirectory:string;sourceRevision:number;rootIdentity:string;
  file?:"client.realm"|"scores.db";expectedSha256?:string;expectedRootIdentity?:string;expectedDatabaseIdentity?:string;
  databaseStamp?:{device:string;inode:string};
}
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
export interface LibrarySourceDeletionOptions {
  directory:string;nativeExecutable:string;admission:LibraryNativeAdmission;
  protectedStages():{stageId:string;intentId:string;intentFingerprint:string}[];
}
function blocked(snapshot:LibraryDeletionSnapshot,reason:string):LibraryDeletionPrepared{return{blockers:[reason],targets:snapshot.locations.map(location=>({
  target:{id:location.id,sourceId:location.sourceId,sourceKind:location.kind,action:location.kind==="stable"?"remove-stable-scores":location.kind==="lazer"?"mark-native-score-deleted":"quarantine-replay",
    label:"Known local replay location",path:location.locator},locationIds:[location.id],fingerprint:deletionFingerprint(location),plan:{},state:"pending"}))};}

/** Source composition admitted only through the trusted main mutation/resource capability. */
export class LibrarySourceDeletionDriver implements LibraryDeletionDriver {
  constructor(private readonly options:LibrarySourceDeletionOptions){if(!options.admission.runMutation||!options.admission.sourceResource)throw Error("Source deletion requires the existing main-owned mutation/resource bridge");}
  private resource<T>(operation:Parameters<NonNullable<LibraryNativeAdmission["sourceResource"]>>[0],args:Record<string,unknown>){return this.options.admission.sourceResource!(operation,args) as Promise<T>;}
  private async stageInventory(){return this.resource<{stages:(LibraryStableStageReference|{stageId:string;state:"unknown"})[];blocked:string[];retiredOwnerIds:string[]}>("inspect-stable-stages",{});}
  private async recoverStages(){const inventory=await this.stageInventory();if(inventory.blocked.length)throw Error("Unverified app staging requires recovery; no source deletion is ready");
    await this.resource("recover-stable-stages",{complete:true,retiredOwnerIds:inventory.retiredOwnerIds,protectedStages:this.options.protectedStages()});}
  async prepare(snapshot:LibraryDeletionSnapshot,context?:LibraryDeletionPreparationContext):Promise<LibraryDeletionPrepared>{
    if(!context)throw Error("Source preparation requires its durable journal owner");
    return this.options.admission.runMutation!(async signal=>{
      const stages:NonNullable<LibraryDeletionPrepared["stages"]>=[];let persisted=false;
      try{
        const multiple=snapshot.contents.length>1,proof=snapshot.contentIdentity;
        if(!snapshot.contents.length||snapshot.contents.length>128||new Set(snapshot.contents).size!==snapshot.contents.length)throw Error("Replay content inventory is incomplete");
        if(multiple&&(!proof||proof.version!==1||!snapshot.contents.includes(proof.preferredSha256)||!Array.isArray(proof.certificates)||
          proof.certificates.length!==snapshot.contents.length||new Set(proof.certificates.map(value=>value.replaySha256)).size!==snapshot.contents.length||
          proof.certificates.some(value=>!snapshot.contents.includes(value.replaySha256)||contentIdentityKey(value)!==proof.identityKey)))
          throw Error("Multiple replay content identities require complete certified group proof before deletion");
        if(snapshot.sources.some(source=>!source.configured))throw Error("A retained source is not configured; its associated local scores cannot be checked");
        if(snapshot.locations.some(location=>!location.sha256||!snapshot.contents.includes(location.sha256)||location.metadata.fileState==="conflict"))throw Error("Conflicting or unavailable known location evidence requires a source check");
        const files:LibraryFileDeletionSelection[]=[],targets:LibraryDeletionPlannedTarget[]=[],evidence:Record<string,unknown>[]=[];
        // Inspect every native source before creating/recovering staged files. Source order
        // must not allow a mixed-source preview to stage Stable work before native admission.
        const nativeDatabases=new Set<string>();
        for(const source of snapshot.sources.filter(value=>value.kind==="lazer")){
          signal.throwIfAborted();const locations=snapshot.locations.filter(location=>location.sourceId===source.id);
          const association=await inspectNativeDeletion(this.options.nativeExecutable,source.directory,snapshot.contents,locations.map(location=>location.sourceKey));
          if(nativeDatabases.has(association.databaseIdentity))throw Error("Multiple configured native roots refer to one database; source alias write coordination is unsupported");
          nativeDatabases.add(association.databaseIdentity);evidence.push(association);
          if(association.knownRecords.some(record=>record.state==="missing"||!record.replaySha256||!snapshot.contents.includes(record.replaySha256)))throw Error("Known native score evidence changed; run Source Check");
          if(association.records.some(record=>!locations.some(location=>location.sourceKey===record.scoreId)))throw Error("An associated native score is not indexed; run Source Check before deletion");
          // Pending indexed rows still require truthful location reconciliation. Do not
          // invent a native deletion target or silently drop its confirmation coverage.
          if(association.knownRecords.some(record=>record.state==="pending"))throw Error("Known native scores are already pending deletion; run Source Check before preparing another deletion.");
          if(!locations.length)continue;
          const plan=await prepareNativeDeletion(this.options.nativeExecutable,source.directory,locations.map(location=>({scoreId:location.sourceKey,expectedReplaySha256:location.sha256!})));
          if(["rootIdentity","databaseIdentity","databaseSha256","schemaFingerprint","schemaVersion"].some(key=>plan[key]!==association[key]))throw Error("Native association epoch changed before confirmation");
          const id=deletionFingerprint(["native",plan.databaseIdentity]);targets.push({target:{id,sourceId:source.id,sourceKind:source.kind,action:"mark-native-score-deleted",label:"Local native scores (shared files retained)",path:join(source.directory,"client.realm"),count:plan.records.length,
            records:plan.records.map(record=>({id:record.scoreId,count:1})),retainedFiles:[...new Set(plan.records.flatMap(record=>record.retainedFiles.map(file=>file.path)))]},locationIds:locations.map(location=>location.id),fingerprint:plan.token,plan:{kind:"native",native:plan},state:"pending"});
        }
        await this.recoverStages();
        const verified=new Map<string,Awaited<ReturnType<typeof inspectReplayFile>>>(),contents=new Map<string,Awaited<ReturnType<typeof inspectReplayFile>>>(),headers=new Map<string,ReplayHeader>();let header:ReplayHeader|undefined;
        const historical=proof?.historical?.headers??[],rootIdentities=new Map<string,string>();
        if(historical.length>128||new Set(historical.map(value=>value.sha256)).size!==historical.length||historical.some(value=>
          !snapshot.contents.includes(value.sha256)||snapshot.locations.some(location=>location.sha256===value.sha256)||!Array.isArray(value.locations)||!value.locations.length||value.locations.length>128))throw Error("Historical header inventory is incomplete");
        if(multiple)for(const source of snapshot.sources){signal.throwIfAborted();rootIdentities.set(source.id,await headerRootIdentity(source.directory));}
        for(const witness of historical)for(const location of witness.locations){
          const source=snapshot.sources.find(value=>value.id===location.sourceId);
          if(!source||source.kind!==location.kind||source.directory!==location.directory||source.revision!==location.sourceConfigRevision||rootIdentities.get(source.id)!==location.rootIdentity)
            throw Error("Historical header source identity changed");
        }
        for(const location of snapshot.locations){signal.throwIfAborted();
          if(location.kind==="lazer")continue;
          const replay=await inspectReplayFile(location.locator,signal);if(replay.sha256!==location.sha256)throw Error("Known replay bytes changed; run a source check");
          if(replay.stamp.bytes>64*1024*1024)throw Error("Known replay exceeds the64MiB file mutation limit");verified.set(location.id,replay);contents.set(replay.sha256,replay);header??=replay.header;
          if(location.kind!=="stable"){
            const id=deletionFingerprint(["file",location.sourceId,location.sourceKey]);files.push({id,sourceId:location.sourceId,relativePath:relative(location.directory,location.locator),expectedSha256:replay.sha256,expectedBytes:replay.stamp.bytes});
            targets.push({target:{id,sourceId:location.sourceId,sourceKind:location.kind,action:"quarantine-replay",label:"Known replay file",path:location.locator,count:1},locationIds:[location.id],fingerprint:deletionFingerprint(replay.stamp),plan:{kind:"file"},state:"pending"});
          }
        }
        if(multiple){
          // Every full hash needs one freshly readable, hash-bound wrapper. A missing native
          // copy may use another known copy; absent/conflicting proof never widens confirmation.
          for(const sha256 of snapshot.contents){
            if(!contents.has(sha256))for(const location of snapshot.locations.filter(value=>value.kind==="lazer"&&value.sha256===sha256&&win32.isAbsolute(value.locator))){
              signal.throwIfAborted();relative(location.directory,location.locator);
              try{const replay=await inspectReplayFile(location.locator,signal);if(replay.sha256!==sha256)throw Error("Certified native replay bytes changed");contents.set(sha256,replay);break;}
              catch(error){if(!["ENOENT","ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code)))throw error;}
            }
            const witness=historical.find(value=>value.sha256===sha256);
            if(!contents.has(sha256)&&witness)for(const location of witness.locations){
              relative(location.directory,location.locator);
              try{const replay=await inspectReplayFile(location.locator,signal);if(replay.sha256!==sha256)throw Error("Historical replay bytes changed");contents.set(sha256,replay);break;}
              catch(error){if(!["ENOENT","ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code)))throw error;}
            }
            const replay=contents.get(sha256),certificate=proof?.certificates.find(value=>value.replaySha256===sha256),boundHeader=replay?.header??witness?.header;
            if(!certificate||!boundHeader||replay&&(!replay.contentIdentity||deletionFingerprint(replay.contentIdentity)!==deletionFingerprint(certificate))||
              !replay&&!validatedContentIdentity({header:boundHeader,contentIdentity:certificate},sha256))throw Error("Certified deletion needs fresh readable proof or a completed read-only header witness for every replay wrapper");
            headers.set(sha256,boundHeader);
            for(const location of snapshot.locations.filter(value=>value.sha256===sha256)){
              if(location.kind==="lazer"&&location.metadata.nativeScore===undefined)throw Error("Certified native score flags require a source check");
              const admitted=validatedContentIdentity({...location.metadata,header:boundHeader,contentIdentity:certificate},sha256);
              if(!admitted||contentIdentityKey(admitted)!==proof?.identityKey)throw Error("Certified replay envelope changed before deletion");
            }
          }
          header=headers.get(snapshot.contents[0]);
        }
        // The header used for Stable association is bound to canonical replay bytes. Native-only
        // snapshots may supply their already indexed blob path, but never a renderer path.
        if(!header&&snapshot.sources.some(source=>source.kind==="stable")){
          const native=snapshot.locations.find(location=>location.kind==="lazer"&&win32.isAbsolute(location.locator));if(!native)throw Error("Stable association needs readable canonical replay bytes");
          const replay=await inspectReplayFile(native.locator,signal);if(replay.sha256!==native.sha256)throw Error("Canonical native replay bytes changed");header=replay.header;
        }
        for(const source of snapshot.sources){signal.throwIfAborted();const locations=snapshot.locations.filter(location=>location.sourceId===source.id);
          if(source.kind==="stable"){
            if(!header)throw Error("Stable association requires a verified replay header");
            const {compressedFrames:_frames,nativeScoreInfo:_native,sourceFormat:_format,...savedHeader}=header;
            const replayHeaders=multiple?snapshot.contents.map(sha256=>{const value=headers.get(sha256);if(!value)throw Error("Certified header inventory changed");const {compressedFrames,nativeScoreInfo,sourceFormat,...saved}=value;void compressedFrames;void nativeScoreInfo;void sourceFormat;return saved;}):undefined;
            const inspection=await this.resource<LibraryStableDeletionInspection>("inspect-stable-deletion",{sourceId:source.id,sourceDirectory:source.directory,knownSourceKeys:locations.map(location=>location.sourceKey),...(multiple?{replayHeaders}:{replayHeader:savedHeader})});
            if(!inspection.complete||inspection.sourceId!==source.id||!samePath(inspection.sourceDirectory,source.directory))throw Error("Stable association inspection was incomplete");
            const selected:typeof inspection.candidates=[];
            for(const candidate of inspection.candidates){const location=locations.find(location=>location.sourceKey===candidate.sourceKey),path=join(source.directory,candidate.cacheRelativePath);
              let replay=location?verified.get(location.id):undefined;
              if(!replay)try{replay=await inspectReplayFile(path,signal);}catch(error){
                if(["ENOENT","ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code)))throw Error("An associated Stable saved record has no readable replay cache; run Source Check before deletion");throw error;
              }
              if(!matchesSavedScore(candidate.score.header,replay.header))throw Error("Stable cache and saved record conflict");
              if(snapshot.contents.includes(replay.sha256)){if(!location)throw Error("An associated Stable score is not indexed; run Source Check before deletion");if(!samePath(location.locator,path))throw Error("Stable saved-score cache path changed");selected.push(candidate);}
              else if(location)throw Error("Known Stable replay association changed");
            }
            evidence.push({sourceId:source.id,basis:"complete-stable-records-and-selected-cache-bytes",databaseSha256:inspection.databaseSha256,stamp:inspection.stamp,rootIdentity:inspection.rootIdentity,selected:selected.map(record=>({sourceKey:record.sourceKey,occurrences:record.occurrences}))});
            if(selected.length!==locations.length)throw Error("Not every known Stable score was verified");if(!selected.length)continue;
            const prepared=await this.resource<LibraryStableDeletionPreparation>("prepare-stable-deletion",{sourceId:source.id,sourceDirectory:source.directory,expected:{sha256:inspection.databaseSha256,stamp:inspection.stamp},selections:selected.map(record=>({sourceKey:record.sourceKey,occurrences:record.occurrences}))});
            stages.push({stageId:prepared.stageId,fingerprint:prepared.stageFingerprint});
            if(prepared.beforeSha256!==inspection.databaseSha256||prepared.staged.sha256!==prepared.afterSha256||JSON.stringify(prepared.rootIdentity)!==JSON.stringify(inspection.rootIdentity))throw Error("Stable preparation changed its pinned source");
            const id=deletionFingerprint(["stable",source.id]);files.push({id,sourceId:source.id,relativePath:"scores.db",expectedSha256:inspection.databaseSha256,expectedBytes:inspection.stamp.bytes,staged:prepared.staged});
            targets.push({target:{id,sourceId:source.id,sourceKind:"stable",action:"remove-stable-scores",label:"Local Stable saved scores",path:join(source.directory,"scores.db"),count:prepared.removedOccurrences,
              records:selected.map(record=>({id:record.sourceKey,count:record.occurrences})),retainedFiles:prepared.cachePaths.filter(cache=>cache.retainedOccurrences>0).map(cache=>join(source.directory,cache.relativePath))},locationIds:locations.map(location=>location.id),fingerprint:inspection.databaseSha256,plan:{kind:"file"},state:"pending"});
            for(const cache of prepared.cachePaths.filter(cache=>cache.retainedOccurrences===0)){
              const aliases=locations.filter(location=>samePath(location.locator,join(source.directory,cache.relativePath)));if(!aliases.length)throw Error("Selected cache lacks an acknowledged location");
              const replay=verified.get(aliases[0].id)!,cacheId=deletionFingerprint(["cache",source.id,cache.relativePath]);files.push({id:cacheId,sourceId:source.id,relativePath:cache.relativePath,expectedSha256:replay.sha256,expectedBytes:replay.stamp.bytes});
              targets.push({target:{id:cacheId,sourceId:source.id,sourceKind:"stable",action:"quarantine-replay",label:"Unshared Stable replay cache file",path:join(source.directory,cache.relativePath),count:1},locationIds:aliases.map(location=>location.id),fingerprint:deletionFingerprint(replay.stamp),plan:{kind:"file"},state:"pending"});
            }
          }
        }
        if(files.length){const ids=new Set(files.map(file=>file.sourceId)),plan=await prepareFileDeletion(this.options.nativeExecutable,{appDirectory:this.options.directory,sources:snapshot.sources.filter(source=>ids.has(source.id)).map(source=>({id:source.id,directory:source.directory}))},files);
          let first=true;for(const target of targets.filter(target=>target.plan.kind==="file")){target.fingerprint=plan.fingerprint;target.plan={kind:"file",filePlanFingerprint:plan.fingerprint,...(first?{file:plan}:{})};first=false;}}
        if(targets.length)targets[0].plan.associations=evidence;
        if(historical.length&&targets.length){
          const guards:HistoricalSourceGuard[]=snapshot.sources.filter(source=>!targets.some(target=>target.target.sourceId===source.id)).map(source=>{
            const base={sourceId:source.id,sourceKind:source.kind,sourceDirectory:source.directory,sourceRevision:source.revision,rootIdentity:rootIdentities.get(source.id) as string};
            if(source.kind==="lazer"){
              const association=evidence.find(value=>typeof value.sourceDirectory==="string"&&samePath(value.sourceDirectory,source.directory));
              if(!association||!hash(association.databaseSha256)||!hash(association.rootIdentity)||!hash(association.databaseIdentity))throw Error("Historical native association proof is incomplete");
              return{...base,file:"client.realm",expectedSha256:association.databaseSha256,expectedRootIdentity:association.rootIdentity,expectedDatabaseIdentity:association.databaseIdentity};
            }
            if(source.kind==="stable"){
              const association=evidence.find(value=>value.sourceId===source.id),stamp=association?.stamp as LibraryStableDeletionInspection["stamp"]|undefined;
              if(!association||!hash(association.databaseSha256)||!stamp)throw Error("Historical Stable association proof is incomplete");
              return{...base,file:"scores.db",expectedSha256:association.databaseSha256,databaseStamp:{device:stamp.device,inode:stamp.inode}};
            }
            return base;
          });
          targets[0].plan.historicalSourceGuards={version:1,identityKey:proof?.identityKey,intentId:proof?.historical?.intentId,guards};
        }
        if(multiple&&targets.length){
          for(const source of snapshot.sources)if(await headerRootIdentity(source.directory)!==rootIdentities.get(source.id))throw Error("Certified header source root changed during preparation");
          const witnesses:LibraryDeletionHeaderWitness[]=snapshot.contents.map(sha256=>{
            const value=headers.get(sha256);if(!value)throw Error("Certified header inventory changed");
            return{sha256,header:value,locations:historical.find(item=>item.sha256===sha256)?.locations??snapshot.locations.filter(location=>location.sha256===sha256).map(location=>({
              sourceId:location.sourceId,kind:location.kind,directory:location.directory,sourceConfigRevision:location.sourceConfigRevision,locator:location.locator,rootIdentity:rootIdentities.get(location.sourceId) as string}))};
          });
          targets[0].plan.contentHeaders={version:1,identityKey:proof?.identityKey,headers:witnesses};
        }
        const prepared={targets,blockers:[],stages};const fingerprint=context.persist(prepared);persisted=true;
        const updated:NonNullable<LibraryDeletionPrepared["stages"]>=[];for(const stage of stages){const handed=await this.resource<LibraryStableStageReference>("handoff-stable-stage",{...stage,intentId:context.intentId,intentFingerprint:fingerprint});updated.push({stageId:stage.stageId,fingerprint:handed.fingerprint});}
        if(stages.length)context.updateStages(updated);return prepared;
      }catch(error){if(persisted)throw error;
        const result={...blocked(snapshot,errorText(error)),...(stages.length?{stages,stageCleanupOnly:true as const}:{})};if(stages.length)context.persist(result);
        if(error instanceof LibraryNativeDrainError)throw error;return result;}
    });
  }

  async acquire(snapshot:LibraryDeletionSnapshot,context?:Parameters<LibraryDeletionDriver["acquire"]>[1]):Promise<LibraryDeletionLease>{
    if(!context)throw Error("A source session requires its durable intent context");
    const filePlans=context.targets.filter(target=>target.plan.file).map(target=>target.plan.file as LibraryFileDeletionPlan);
    if(filePlans.length>1)throw Error("File targets must share one held batch");const filePlan=filePlans[0];
    const nativeTargets=context.targets.filter(target=>target.plan.kind==="native"),nativePlans=nativeTargets.map(target=>target.plan.native as LibraryNativeDeletionPlan);
    if(new Set(nativePlans.map(plan=>plan.databaseIdentity)).size!==nativePlans.length)throw Error("Native database aliases require one transaction");
    if(filePlan&&(!samePath(filePlan.app.directory,this.options.directory)||filePlan.sources.some(source=>!snapshot.sources.some(known=>known.configured&&known.id===source.id&&samePath(known.directory,source.directory)))))throw Error("File plan source authority changed");
    const guardedSources=snapshot.contentIdentity?.historical?.headers.length?snapshot.sources.filter(source=>!context.targets.some(target=>target.target.sourceId===source.id)):[];
    let readGuards:HistoricalSourceGuard[]=[];
    if(guardedSources.length&&(context.mode==="commit"||context.mode==="continue")){
      const proof=context.targets.find(target=>target.plan.historicalSourceGuards)?.plan.historicalSourceGuards as {version?:number;identityKey?:string;intentId?:string;guards?:HistoricalSourceGuard[]}|undefined;
      if(!proof||proof.version!==1||proof.identityKey!==snapshot.contentIdentity?.identityKey||proof.intentId!==snapshot.contentIdentity?.historical?.intentId||!Array.isArray(proof.guards)||proof.guards.length!==guardedSources.length||proof.guards.length>128||new Set(proof.guards.map(value=>value?.sourceId)).size!==guardedSources.length)
        throw Error("Historical source guard inventory is incomplete; prepare a fresh confirmation");
      readGuards=proof.guards;
      for(const guard of readGuards){const source=guardedSources.find(value=>value.id===guard?.sourceId);
        if(!source||!source.configured||source.kind!==guard.sourceKind||source.directory!==guard.sourceDirectory||source.revision!==guard.sourceRevision||!hash(guard.rootIdentity)||
          guard.file!==(source.kind==="lazer"?"client.realm":source.kind==="stable"?"scores.db":undefined)||guard.file&&!hash(guard.expectedSha256)||
          source.kind==="lazer"&&(!hash(guard.expectedRootIdentity)||!hash(guard.expectedDatabaseIdentity))||
          source.kind==="stable"&&(!guard.databaseStamp||typeof guard.databaseStamp.device!=="string"||typeof guard.databaseStamp.inode!=="string"))throw Error("Historical source guard authority changed");
      }
    }
    const ready=deferred<LibraryDeletionLease>(),finish=deferred();let readySent=false;
    const running=this.options.admission.runMutation!(async signal=>{
      const nativeSessions=new Map<string,LibraryNativeDeletionSession>(),unattachedHelpers=new Set<LibrarySourceDeletionHelper>();let file:LibraryFileDeletionSession|undefined,closed=false,closingSources:Promise<void>|undefined;
      const closeSources=()=>{if(closingSources)return closingSources;closed=true;
        closingSources=Promise.allSettled([...nativeSessions.values()].map(session=>session.close()).concat(file?[file.close(true)]:[],[...unattachedHelpers].map(helper=>helper.close()))).then(results=>{
          const uncertain=results.find(result=>result.status==="rejected"&&result.reason instanceof LibraryNativeDrainError),failure=uncertain??results.find(result=>result.status==="rejected");if(failure?.status==="rejected")throw failure.reason;});
        void closingSources.catch(()=>undefined);return closingSources;};
      const guardedHelper=async(flag:"--library-source-deletion"|"--library-file-mutation")=>{
        const helper=new LibrarySourceDeletionHelper(this.options.nativeExecutable,flag);unattachedHelpers.add(helper);
        if(readGuards.length)try{
          const reply=await helper.request({operation:"guard-acquire",readGuards:readGuards.map(({sourceDirectory,file,expectedSha256,expectedRootIdentity,expectedDatabaseIdentity})=>({sourceDirectory,file,expectedSha256,expectedRootIdentity,expectedDatabaseIdentity}))});
          if(!reply.ok||reply.status!=="acquired-guard"||!hash(reply.sessionToken)||!hash(reply.fingerprint))throw Error(reply.status);
          for(const guard of readGuards){
            if(await headerRootIdentity(guard.sourceDirectory)!==guard.rootIdentity)throw Error("Historical header source identity changed");
            if(guard.databaseStamp){const current=await lstat(join(guard.sourceDirectory,"scores.db"),{bigint:true});
              if(!current.isFile()||current.isSymbolicLink()||current.nlink!==BigInt(1)||String(current.dev)!==guard.databaseStamp.device||String(current.ino)!==guard.databaseStamp.inode)throw Error("Historical Stable database identity changed");}
          }
          const verified=await helper.request({operation:"guard-verify",sessionToken:reply.sessionToken});
          if(!verified.ok||verified.status!=="verified-guard"||verified.fingerprint!==reply.fingerprint)throw Error(verified.status);
        }catch(error){throw Error("Historical source guard: "+errorText(error));}
        return helper;
      };
      try{
        if(context.mode==="commit"||context.mode==="continue"){
          if(filePlan?.targets.some(target=>target.staged))await this.recoverStages();
          if(filePlan){const helper=await guardedHelper("--library-file-mutation");file=new LibraryFileDeletionSession(helper,filePlan);unattachedHelpers.delete(helper);
            const selected=context.targets.filter(target=>target.plan.kind==="file");
            await file.acquire(context.intentId,context.mode==="continue"?{committed:selected.filter(target=>target.state==="committed").map(target=>({id:target.target.id,fingerprint:target.receipt!.fingerprint})),
              remainingTargetIds:selected.filter(target=>target.state!=="committed").map(target=>target.target.id)}:undefined);}
          for(let index=0;index<nativePlans.length;index++){signal.throwIfAborted();let plan=nativePlans[index];
            if(context.mode==="continue"&&nativeTargets[index].state==="committed"){
              const guard=await prepareNativeDeletion(this.options.nativeExecutable,plan.sourceDirectory,plan.records.map(record=>({scoreId:record.scoreId,expectedReplaySha256:record.replaySha256})));
              if(["rootIdentity","databaseIdentity","schemaFingerprint","schemaVersion"].some(key=>guard[key]!==plan[key])||guard.records.some(record=>!record.wasDeletePending||record.afterFingerprint!==record.beforeFingerprint||record.beforeFingerprint!==plan.records.find(before=>before.scoreId===record.scoreId)?.afterFingerprint))
                throw Error("A previously committed native target changed before continuation");plan=guard;
            }
            const helper=await guardedHelper("--library-source-deletion"),session=new LibraryNativeDeletionSession(helper,plan);nativeSessions.set(nativeTargets[index].target.id,session);unattachedHelpers.delete(helper);await session.acquire();}
        }
        const lease:LibraryDeletionLease={signal,verify:async target=>{if(closed)throw Error("Source sessions closed");if(target.plan.kind==="native")await nativeSessions.get(target.target.id)!.verify();else if(file)await file.verify(target.target.id);else throw Error("Missing exact file session");},
          commit:async(target,intentId)=>{if(closed||intentId!==context.intentId)throw Error("Source intent/session changed");return target.plan.kind==="native"?nativeSessions.get(target.target.id)!.commit():file!.commit(target.target.id,intentId);},
          reconcile:async(target,intentId)=>target.plan.kind==="native"?reconcileNativeDeletion(this.options.nativeExecutable,target.plan.native as LibraryNativeDeletionPlan):
            filePlan?reconcileFileDeletion(this.options.nativeExecutable,filePlan,target.target.id,intentId):Promise.reject(Error("Missing durable file batch")),
          cleanup:async(intent,write)=>{
            await closeSources();let fingerprint=deletionFingerprint({intentId:intent.id,state:"no-file-resources"});
            if(write&&intent.stages?.length)await this.recoverStages();
            if(filePlan){const result=await cleanupFileDeletion(this.options.nativeExecutable,filePlan,intent,write);if(result.state!=="complete")return result;fingerprint=result.fingerprint;}
            if(intent.stages?.length){const inventory=await this.stageInventory();if(inventory.blocked.length)throw Error("Stage cleanup inventory is unverified");
              for(const stage of intent.stages){const current=inventory.stages.find(item=>item.stageId===stage.stageId);if(!current)continue;if(current.state==="unknown")throw Error("Stage custody is unknown");if(!write)return{state:"required",detail:"App staging custody still requires explicit cleanup."};
                if(current.state==="handed-off")await this.resource("retire-stable-stage",{stageId:stage.stageId,fingerprint:current.fingerprint,intentId:intent.id,intentFingerprint:intent.preparationFingerprint,cleanupFingerprint:fingerprint});
                else if(!filePlan)await this.resource("discard-stable-stage",{stageId:stage.stageId,fingerprint:current.fingerprint});else throw Error("Prepared stage handoff has not been reconciled");
              }}return{state:"complete"};},
          close:async()=>{finish.resolve();await running;}};
        readySent=true;ready.resolve(lease);await finish.promise;
      }finally{await closeSources();}
    });
    void running.catch(error=>{if(!readySent)ready.reject(error);});return ready.promise;
  }
}
