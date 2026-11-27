import { randomBytes,randomUUID } from "crypto";
import type { LibraryDeletionResult } from "../../../../shared/library-deletion";
import { deletionFingerprint,LibraryDeletionStore,LibraryDeletionSnapshot,LibraryDeletionPlannedTarget,LibraryDeletionIntent } from "./library-deletion-store";
import { LibraryNativeDrainError } from "./library-native-admission";

export interface LibraryDeletionPrepared {targets:LibraryDeletionPlannedTarget[];blockers:string[];stages?:{stageId:string;fingerprint:string}[];stageCleanupOnly?:true}
export interface LibraryDeletionPreparationContext {
  intentId:string;
  /** Called inside the admitted span, before handing any staged bytes to durable intent custody. */
  persist(prepared:LibraryDeletionPrepared):string;
  updateStages(stages:{stageId:string;fingerprint:string}[]):void;
  protectedStages():{stageId:string;intentId:string;intentFingerprint:string}[];
}
export interface LibraryDeletionReceipt {state:"committed"|"unchanged"|"conflict";fingerprint:string;detail?:string;evidence?:Record<string,unknown>}
/** Must hold main-owned reader admission AND source-specific Windows locks through close().
 * Before-images/quarantine are bounded to this intent; reconciliation is read-only and never
 * restores over changed paths/databases. A plain process check is not an implementation. */
export interface LibraryDeletionLease {
  /** Revocation is observed between atomic source operations, never by abandoning a dispatched write. */
  signal?:AbortSignal;
  verify(target:LibraryDeletionPlannedTarget):Promise<void>;
  commit(target:LibraryDeletionPlannedTarget,intentId:string):Promise<LibraryDeletionReceipt>;
  reconcile(target:LibraryDeletionPlannedTarget,intentId:string):Promise<LibraryDeletionReceipt>;
  cleanup?(intent:LibraryDeletionIntent,finish:boolean):Promise<{state:"required"|"complete";detail?:string}>;
  close():Promise<void>;
}
export interface LibraryDeletionDriver {
  prepare(snapshot:LibraryDeletionSnapshot,context?:LibraryDeletionPreparationContext):Promise<LibraryDeletionPrepared>;
  acquire(snapshot:LibraryDeletionSnapshot,context?:{mode:"commit"|"continue"|"reconcile"|"cleanup";intentId:string;targets:LibraryDeletionPlannedTarget[]}):Promise<LibraryDeletionLease>;
}
const detail=(error:unknown)=>(error instanceof Error?error.message:"Deletion could not be verified").slice(0,2048);
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f\d]{64}$/.test(value);

/** Single utility owner. An absent driver deliberately exposes a blocked exact-location preview. */
export class LibraryDeletionCoordinator {
  private active?:Promise<void>;
  private closed=false;
  constructor(private readonly journal:LibraryDeletionStore,private readonly driver?:LibraryDeletionDriver,
    private readonly admission?:{acquire():Promise<()=>void>},private readonly now=Date.now){
    if(driver&&!admission)throw new Error("Deletion driver requires a mutation admission owner");
    journal.abandonStagedConfirmations();
  }
  private async serial(work:()=>Promise<LibraryDeletionResult>):Promise<LibraryDeletionResult> {
    if(this.closed)throw new Error("Deletion coordinator is closed");
    if(this.active)throw new Error("A deletion operation is already active");
    let finish!:()=>void;
    this.active=new Promise<void>(resolve=>{finish=resolve;});
    try{return await work();}
    finally{this.active=undefined;finish();}
  }
  private result(intent:LibraryDeletionIntent,token?:string):LibraryDeletionResult {
    return{intentId:intent.id,replayId:intent.replayId,state:intent.state,expiresAt:intent.expiresAt,...(token?{token}:{}),
      targets:intent.targets.map(item=>({...item.target,state:item.state,...(item.detail?{detail:item.detail}:{})})),blockers:[...intent.blockers],onlineScoresUnchanged:true,
      ...(intent.metadataCommitted?{sourceDeletionComplete:true as const}:{}),...(token&&intent.continuation?{continuation:true as const}:{})};
  }
  private validatePrepared(snapshot:LibraryDeletionSnapshot,prepared:LibraryDeletionPrepared):void {
    if(prepared.targets.length<1||prepared.targets.length>128||prepared.blockers.length>128||prepared.blockers.some(item=>typeof item!=="string"||!item||item.length>2048))
      throw new Error("Deletion adapter returned an invalid bounded plan");
    if(prepared.stages&&(prepared.stages.length>16||new Set(prepared.stages.map(stage=>stage.stageId)).size!==prepared.stages.length||prepared.stages.some(stage=>
      !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(stage.stageId)||!hash(stage.fingerprint))))throw new Error("Invalid prepared stage custody");
    if(prepared.stageCleanupOnly&&(!prepared.stages?.length||!prepared.blockers.length))throw new Error("Only abandoned preparation may release unhanded stage custody");
    const locations=new Set(snapshot.locations.map(item=>item.id)),covered=new Set<string>(),ids=new Set<string>();
    for(const item of prepared.targets){
      if(!item.target.id||ids.has(item.target.id)||item.target.id.length>128||!hash(item.fingerprint)||item.state!=="pending"||!item.plan||
        !["remove-stable-scores","quarantine-replay","mark-native-score-deleted"].includes(item.target.action)||
        !snapshot.locations.some(location=>location.sourceId===item.target.sourceId&&location.kind===item.target.sourceKind)||
        typeof item.target.label!=="string"||!item.target.label||item.target.label.length>2048||typeof item.target.path!=="string"||!item.target.path||item.target.path.length>32768||
        item.target.count!==undefined&&(!Number.isSafeInteger(item.target.count)||item.target.count<1)||
        item.target.records!==undefined&&(!Array.isArray(item.target.records)||item.target.records.length>128||item.target.records.some(record=>
          typeof record.id!=="string"||!record.id||record.id.length>128||!Number.isSafeInteger(record.count)||record.count<1))||
        item.target.retainedFiles!==undefined&&(!Array.isArray(item.target.retainedFiles)||item.target.retainedFiles.length>1024||item.target.retainedFiles.some(path=>typeof path!=="string"||!path||path.length>32768))||
        !item.locationIds.length||item.locationIds.length>128)throw new Error("Deletion adapter returned an invalid target");
      ids.add(item.target.id);for(const id of item.locationIds){
        if(!locations.has(id)||!snapshot.locations.some(location=>location.id===id&&location.sourceId===item.target.sourceId&&location.kind===item.target.sourceKind))
          throw new Error("Deletion adapter invented a location or source association");covered.add(id);
      }
    }
    if(covered.size!==locations.size)throw new Error("Deletion adapter did not cover every associated location");
  }
  preview(replayId:string):Promise<LibraryDeletionResult> {return this.serial(async()=>{
    const unresolved=this.journal.unresolved(replayId);if(unresolved)return this.result(unresolved);
    const staged=this.journal.stagedPreview(replayId);if(staged)return this.result(this.journal.save({...staged,state:"cleanup-required",tokenHash:null,
      blockers:["The previous prepared preview must release its owned temporary files before another preview."]},staged.revision));
    const intentId=randomUUID();let intent:LibraryDeletionIntent|undefined,token:string|undefined,uncertain=false;
    const release=this.driver?await this.admission!.acquire():undefined;
    try{
    const snapshot=this.journal.snapshot(replayId),snapshotFingerprint=deletionFingerprint(snapshot);
    const context:LibraryDeletionPreparationContext={intentId,protectedStages:()=>this.journal.protectedStages(),persist:prepared=>{
      if(intent)throw new Error("Deletion preparation was already journaled");this.validatePrepared(snapshot,prepared);
      if(deletionFingerprint(this.journal.snapshot(replayId))!==snapshotFingerprint)throw new Error("Replay locations changed while preparing deletion");
      token=prepared.blockers.length?undefined:randomBytes(32).toString("hex");const now=this.now();
      const preparationFingerprint=deletionFingerprint({intentId,snapshotFingerprint,targets:prepared.targets,blockers:prepared.blockers});
      intent={id:intentId,revision:0,replayId:snapshot.replayId,state:token?"preview":prepared.stages?.length?"cleanup-required":"blocked",createdAt:now,expiresAt:now+5*60*1000,
        tokenHash:token?deletionFingerprint(token):null,snapshot,snapshotFingerprint,targets:prepared.targets,blockers:prepared.blockers,
        ...(prepared.stages?.length?{stages:prepared.stages,preparationFingerprint,...(prepared.stageCleanupOnly?{stageCleanupOnly:true as const}:{})}:{})};
      this.journal.create(intent);return preparationFingerprint;
    },updateStages:stages=>{
      if(!intent||stages.length!==intent.stages?.length||new Set(stages.map(stage=>stage.stageId)).size!==stages.length||stages.some(stage=>!hash(stage.fingerprint)||!intent?.stages?.some(previous=>previous.stageId===stage.stageId)))
        throw new Error("Stage handoff changed its durable selection");
      intent=this.journal.save({...intent,stages},intent.revision);
    }};
    const prepared=this.driver?await this.driver.prepare(snapshot,context):{
      targets:snapshot.locations.map(location=>({target:{id:location.id,sourceId:location.sourceId,sourceKind:location.kind,
        action:location.kind==="stable"?"remove-stable-scores" as const:location.kind==="lazer"?"mark-native-score-deleted" as const:"quarantine-replay" as const,
        label:location.kind==="lazer"?"Local native score "+location.sourceKey:location.kind==="stable"?"Associated local Stable score records":"Replay file",
        path:location.locator},locationIds:[location.id],fingerprint:deletionFingerprint(location),plan:{},state:"pending" as const})),
      blockers:["Source deletion is unavailable until source write, reader admission, locking and recovery checks pass."]};
    if(!intent)context.persist(prepared);
    else if(intent.preparationFingerprint&&intent.preparationFingerprint!==deletionFingerprint({intentId,snapshotFingerprint,targets:prepared.targets,blockers:prepared.blockers}))
      throw new Error("Prepared deletion changed after its durable handoff");
    return this.result(intent!,token);
    }catch(error){uncertain=error instanceof LibraryNativeDrainError;
      if(intent?.stages?.length){intent=this.attention(intent.id,error);if(!uncertain)return this.result(intent);}throw error;
    }finally{if(!uncertain)release?.();}
  });}
  status(intentId:string):LibraryDeletionResult {return this.result(this.journal.read(intentId));}
  pending(after?:string){return this.journal.pending(after);}
  private confirmation(replayId:string,token:string):LibraryDeletionIntent {
    let intent=this.journal.byToken(token);
    if(intent.replayId!==replayId||intent.state!=="preview"&&!(intent.state==="partial"&&intent.continuation))throw new Error("Deletion confirmation does not match this replay");
    if(this.now()>=intent.expiresAt){intent=this.journal.save({...intent,state:intent.continuation?"partial":intent.stages?.length?"cleanup-required":"expired",tokenHash:null,continuation:undefined},intent.revision);throw new Error("Deletion confirmation expired; review a fresh preview");}
    return intent;
  }
  cancel(replayId:string,token:string):Promise<LibraryDeletionResult> {return this.serial(async()=>{
    const intent=this.confirmation(replayId,token);
    if(intent.continuation)return this.result(this.journal.save({...intent,state:"partial",tokenHash:null,continuation:undefined},intent.revision));
    if(intent.stages?.length)return this.finishOwnedCleanup(this.journal.save({...intent,state:"cleanup-required",tokenHash:null},intent.revision),true);
    return this.result(this.journal.save({...intent,state:"cancelled",tokenHash:null},intent.revision));
  });}
  commit(replayId:string,token:string):Promise<LibraryDeletionResult> {return this.serial(async()=>{
    let intent=this.confirmation(replayId,token);
    if(!this.driver||!this.admission||intent.blockers.length)throw new Error("Source deletion is not available");
    const continuing=!!intent.continuation;
    if(continuing&&(intent.continuation!.partitionFingerprint!==this.partition(intent)||intent.targets.some(target=>!["committed","unchanged"].includes(target.state))))throw new Error("Continuation outcome partition changed; check and review it again");
    const release=await this.admission.acquire();let lease:LibraryDeletionLease|undefined,uncertain=false;
    try {
      if(this.now()>=intent.expiresAt)throw new Error("Deletion preview is stale; review a fresh preview");this.journal.assertSnapshot(intent);
      // Acquisition may create owned source-volume staging before returning its session token.
      // Consume confirmation durably first; each actual source write has a later target marker.
      intent=this.journal.save({...intent,state:"committing",tokenHash:null,confirmedAt:intent.confirmedAt??this.now(),continuation:undefined,reconciledAt:undefined},intent.revision);
      lease=await this.driver.acquire(intent.snapshot,{mode:continuing?"continue":"commit",intentId:intent.id,targets:intent.targets});
      for(const target of intent.targets){lease.signal?.throwIfAborted();await lease.verify(target);}
      lease.signal?.throwIfAborted();
      if(this.now()>=intent.expiresAt)throw new Error("Deletion preview is stale; review a fresh preview");this.journal.assertSnapshot(intent);
      for(let index=0;index<intent.targets.length;index++){
        if(intent.targets[index].state==="committed")continue;
        if(lease.signal?.aborted){intent.blockers=["Source ownership changed; deletion stopped at a recorded source boundary."];break;}
        const target=intent.targets[index];target.state="committing";intent=this.journal.save(intent,intent.revision);
        try {
          const receipt=await lease.commit(target,intent.id);this.validateReceipt(receipt);
          intent.targets[index]={...target,state:receipt.state,receipt,detail:receipt.detail};
          intent=this.journal.saveOutcome(intent,index);
          if(receipt.state!=="committed")break;
        }catch(error){intent.targets[index].detail=detail(error);intent.state="recovery-required";intent=this.journal.save(intent,intent.revision);if(error instanceof LibraryNativeDrainError)throw error;break;}
      }
      if(intent.targets.every(target=>target.state==="committed")){
        try{intent=this.journal.complete(intent);}catch(error){intent=this.journal.save({...intent,state:"recovery-required",blockers:[detail(error)]},intent.revision);}
        if(intent.metadataCommitted)intent=await this.settleCleanup(intent,lease,true);
      }else if(intent.state!=="recovery-required"){
        if(this.noSourceCommit(intent))intent=await this.settleCleanup(intent,lease,false);
        else intent=this.journal.save({...intent,state:"partial"},intent.revision);
      }
      return this.result(intent);
    }catch(error){uncertain=error instanceof LibraryNativeDrainError;
      if(intent.confirmedAt!==undefined){intent=this.attention(intent.id,error);if(!uncertain)return this.result(intent);}throw error;}
    finally {await this.closeLease(lease,release,uncertain,intent.id);}
  });}
  private validateReceipt(receipt:LibraryDeletionReceipt):void {
    if(!receipt||!["committed","unchanged","conflict"].includes(receipt.state)||!hash(receipt.fingerprint)||
      receipt.detail!==undefined&&(typeof receipt.detail!=="string"||receipt.detail.length>2048)||
      receipt.evidence!==undefined&&(!receipt.evidence||Array.isArray(receipt.evidence)||typeof receipt.evidence!=="object"||Buffer.byteLength(JSON.stringify(receipt.evidence))>128*1024))
      throw new Error("Source deletion receipt could not be verified");
  }
  /** Read-only source reconciliation, including a crash after a write but before its receipt.
   * Unchanged or conflicting resources remain visible; no automatic mutation replay/rollback. */
  recover(intentId:string):Promise<LibraryDeletionResult> {return this.serial(()=>this.recoverIntent(intentId));}
  private async recoverIntent(intentId:string,includePending=false):Promise<LibraryDeletionResult>{
    let intent=this.journal.read(intentId);
    if(intent.metadataCommitted||intent.state==="cleanup-required")return this.finishOwnedCleanup(intent,false);
    if(!["committing","partial","recovery-required"].includes(intent.state))return this.result(intent);
    if(!this.driver||!this.admission)throw new Error("Deletion recovery requires its admitted source driver");
    const release=await this.admission.acquire();let lease:LibraryDeletionLease|undefined,uncertain=false;
    try {
      lease=await this.driver.acquire(intent.snapshot,{mode:"reconcile",intentId:intent.id,targets:intent.targets});
      intent=this.journal.save({...intent,reconciledAt:undefined,tokenHash:null,continuation:undefined},intent.revision);
      for(let index=0;index<intent.targets.length;index++){
        if(lease.signal?.aborted)break;
        const target=intent.targets[index];
        if(target.state==="pending"&&!includePending)continue;
        try{const receipt=await lease.reconcile(target,intent.id);this.validateReceipt(receipt);intent.targets[index]={...target,state:receipt.state,receipt,detail:receipt.detail};}
        catch(error){intent.targets[index]={...target,state:"conflict",detail:detail(error)};
          if(error instanceof LibraryNativeDrainError){intent=this.journal.save({...intent,state:"recovery-required"},intent.revision);throw error;}}
        intent=this.journal.saveOutcome(intent,index);
      }
      if(lease.signal?.aborted)intent=this.journal.save({...intent,state:"recovery-required",blockers:["Outcome check stopped before all targets were reconciled."]},intent.revision);
      else if(intent.targets.every(target=>target.state==="committed")){
        try{intent=this.journal.complete(intent);}catch(error){intent=this.journal.save({...intent,state:"recovery-required",blockers:[detail(error)]},intent.revision);}
        if(intent.metadataCommitted)intent=await this.settleCleanup(intent,lease,false);
      }else if(this.noSourceCommit(intent))intent=await this.settleCleanup(intent,lease,false);
      else intent=this.journal.save({...intent,state:"partial",reconciledAt:intent.targets.every(target=>!["committing","conflict"].includes(target.state))?this.now():undefined},intent.revision);
      return this.result(intent);
    }catch(error){uncertain=error instanceof LibraryNativeDrainError;throw error;}
    finally {await this.closeLease(lease,release,uncertain,intent.id);}
  }
  private partition(intent:LibraryDeletionIntent):string{return deletionFingerprint(intent.targets.map(target=>({id:target.target.id,state:target.state,fingerprint:target.receipt?.fingerprint})));}
  continuePreview(intentId:string):Promise<LibraryDeletionResult>{return this.serial(async()=>{
    await this.recoverIntent(intentId,true);let intent=this.journal.read(intentId);
    if(intent.state!=="partial")return this.result(intent);
    if(intent.reconciledAt===undefined||intent.targets.some(target=>!["committed","unchanged"].includes(target.state)))
      return this.result(this.journal.save({...intent,tokenHash:null,continuation:undefined,blockers:["Every acknowledged target must have a verified committed or unchanged outcome before continuation."]},intent.revision));
    try{this.journal.assertSnapshot(intent);}catch(error){return this.result(this.journal.save({...intent,tokenHash:null,continuation:undefined,blockers:[detail(error)]},intent.revision));}
    const token=randomBytes(32).toString("hex");intent=this.journal.save({...intent,tokenHash:deletionFingerprint(token),expiresAt:this.now()+5*60*1000,
      continuation:{partitionFingerprint:this.partition(intent)},blockers:[]},intent.revision);return this.result(intent,token);
  });}
  private noSourceCommit(intent:LibraryDeletionIntent):boolean{return !intent.retiredLocations?.length&&intent.targets.every(target=>target.state==="pending"||target.state==="unchanged");}
  private attention(intentId:string,error:unknown):LibraryDeletionIntent{
    const intent=this.journal.read(intentId);return this.journal.save({...intent,state:intent.metadataCommitted||this.noSourceCommit(intent)?"cleanup-required":"recovery-required",tokenHash:null,blockers:[detail(error)]},intent.revision);
  }
  private async settleCleanup(intent:LibraryDeletionIntent,lease:LibraryDeletionLease,finish:boolean):Promise<LibraryDeletionIntent>{
    if(!intent.metadataCommitted&&!this.noSourceCommit(intent))throw new Error("Unresolved source changes cannot be discarded as temporary cleanup");
    try{
      const result=finish&&lease.signal?.aborted?{state:"required" as const,detail:"Source ownership changed; exact temporary cleanup remains."}:
        lease.cleanup?await lease.cleanup(intent,finish):intent.targets.some(target=>target.plan.kind==="file")?
          {state:"required" as const,detail:"Exact file cleanup is unavailable."}:{state:"complete" as const};
      if(!["required","complete"].includes(result.state)||result.detail!==undefined&&(typeof result.detail!=="string"||result.detail.length>2048))throw new Error("Invalid deletion cleanup receipt");
      return this.journal.save({...intent,state:result.state==="complete"?(intent.metadataCommitted?"complete":"cancelled"):"cleanup-required",
        ...(result.state==="complete"?{stages:undefined}:{}),blockers:result.detail?[result.detail]:[]},intent.revision);
    }catch(error){
      const next=this.journal.save({...intent,state:"cleanup-required",blockers:[detail(error)]},intent.revision);
      if(error instanceof LibraryNativeDrainError)throw error;return next;
    }
  }
  private async closeLease(lease:LibraryDeletionLease|undefined,release:()=>void,uncertain:boolean,intentId:string):Promise<void>{
    try{await lease?.close();}catch(error){if(error instanceof LibraryNativeDrainError)uncertain=true;this.attention(intentId,error);throw error;}
    finally{if(!uncertain)release();}
  }
  private async finishOwnedCleanup(intent:LibraryDeletionIntent,finish:boolean):Promise<LibraryDeletionResult>{
    if(!intent.metadataCommitted&&((intent.confirmedAt===undefined&&!intent.stages?.length)||!this.noSourceCommit(intent)))throw new Error("Cleanup requires recorded ownership with verified source outcomes");
    if(intent.state==="complete")return this.result(intent);
    if(!this.driver||!this.admission)throw new Error("Deletion cleanup requires its admitted source driver");
    const release=await this.admission.acquire();let lease:LibraryDeletionLease|undefined,uncertain=false;
    try{lease=await this.driver.acquire(intent.snapshot,{mode:"cleanup",intentId:intent.id,targets:intent.targets});return this.result(await this.settleCleanup(intent,lease,finish));}
    catch(error){uncertain=error instanceof LibraryNativeDrainError;throw error;}
    finally{await this.closeLease(lease,release,uncertain,intent.id);}
  }
  cleanup(intentId:string):Promise<LibraryDeletionResult>{return this.serial(()=>this.finishOwnedCleanup(this.journal.read(intentId),true));}
  async close():Promise<void> {this.closed=true;await this.active;}
}
