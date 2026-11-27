import type { DatabaseSync } from "node:sqlite";
import { createHash } from "crypto";
import type { LibrarySourceKind } from "../../../../shared/replay-library";
import type { LibraryDeletionState,LibraryDeletionTarget,LibraryDeletionTargetState } from "../../../../shared/library-deletion";
import type { LibraryDeletionPending,LibraryDeletionPendingPage } from "../../../../shared/library-deletion";
import { contentIdentityKey,LibraryContentIdentityCertificate } from "./library-content-identity";
import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";

export const LIBRARY_DELETION_MAX_LOCATIONS=128;
const MAX_BYTES=1024*1024;
export function deletionFingerprint(value:unknown):string {return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
export interface LibraryDeletionLocation {
  id:string;sourceId:string;sourceKey:string;kind:LibrarySourceKind;directory:string;configured:boolean;enabled:boolean;
  sourceConfigRevision:number;locationRevision:number;locator:string;sha256:string|null;available:boolean;metadata:Record<string,unknown>;
}
export interface LibraryDeletionSource {id:string;kind:LibrarySourceKind;directory:string;configured:boolean;enabled:boolean;revision:number}
export interface LibraryDeletionHeaderWitness {sha256:string;header:ReplayHeader;
  locations:(Pick<LibraryDeletionLocation,"sourceId"|"kind"|"directory"|"sourceConfigRevision"|"locator">&{rootIdentity:string})[]}
export interface LibraryDeletionSnapshot {replayId:string;aliases:string[];contents:string[];locations:LibraryDeletionLocation[];sources:LibraryDeletionSource[];
  contentIdentity?:{version:1;identityKey:string;preferredSha256:string;certificates:LibraryContentIdentityCertificate[];
    historical?:{intentId:string;headers:LibraryDeletionHeaderWitness[]}}}
export interface LibraryDeletionPlannedTarget {
  target:LibraryDeletionTarget;locationIds:string[];
  /** Source adapter's complete before-state fingerprint and bounded durable recovery plan. */
  fingerprint:string;plan:Record<string,unknown>;
  state:LibraryDeletionTargetState;receipt?:{fingerprint:string;detail?:string;evidence?:Record<string,unknown>};detail?:string;
}
export interface LibraryDeletionIntent {
  id:string;revision:number;replayId:string;state:LibraryDeletionState;createdAt:number;expiresAt:number;tokenHash:string|null;
  snapshot:LibraryDeletionSnapshot;snapshotFingerprint:string;targets:LibraryDeletionPlannedTarget[];blockers:string[];
  /** Exact revisions produced by this intent, while the immutable snapshot retains before-images. */
  retiredLocations?:{id:string;revision:number}[];
  reconciledAt?:number;
  metadataCommitted?:true;
  metadataCompletion?:{revision:number;markerSha256:string};
  confirmedAt?:number;
  stages?:{stageId:string;fingerprint:string}[];
  preparationFingerprint?:string;
  /** Failed preparation never issued a source-capable plan; these unhanded stages may be discarded. */
  stageCleanupOnly?:true;
  continuation?:{partitionFingerprint:string};
}

/** App-owned journal only. All source filesystem mutation belongs to an admitted driver. */
export class LibraryDeletionStore {
  static migrate(db:DatabaseSync):void {
    db.exec(`CREATE TABLE deletion_intents(id TEXT PRIMARY KEY,replay_id TEXT NOT NULL REFERENCES replays(id),revision INTEGER NOT NULL,
      state TEXT NOT NULL,token_hash TEXT UNIQUE,expires_at INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX deletion_intents_replay ON deletion_intents(replay_id,state);
      CREATE TABLE deleted_replays(replay_id TEXT PRIMARY KEY REFERENCES replays(id),intent_id TEXT NOT NULL REFERENCES deletion_intents(id));
      CREATE TABLE deleted_locations(source_id TEXT NOT NULL,source_key TEXT NOT NULL,sha256 TEXT,replay_id TEXT NOT NULL REFERENCES replays(id),
        PRIMARY KEY(source_id,source_key)); PRAGMA user_version=28;`);
  }
  constructor(private readonly db:DatabaseSync,private readonly resolve:(id:string)=>string,
    private readonly transaction:<T>(work:()=>T,publish?:boolean)=>T,private readonly finalize:(intent:LibraryDeletionIntent)=>void,
    private readonly analysisChanged:(replayId:string,resume:boolean)=>void=()=>undefined){}
  snapshot(inputId:string):LibraryDeletionSnapshot {
    const replayId=this.resolve(inputId);
    if(this.deleted(replayId))throw new Error("Replay has already been deleted");
    const aliases=this.db.prepare(`WITH RECURSIVE family(id) AS (SELECT ? UNION SELECT r.id FROM replays r JOIN family f ON r.merged_into=f.id)
      SELECT id FROM family ORDER BY id LIMIT 130`).all(replayId).map(row=>String(row.id));
    if(aliases.length>128)throw new Error("Replay has too many identity aliases to confirm safely");
    const rows=this.db.prepare(`SELECT l.*,s.kind,s.directory,s.enabled,s.configured,s.config_revision FROM locations l JOIN sources s ON s.id=l.source_id
      WHERE l.replay_id=? ORDER BY l.source_id,l.source_key LIMIT ?`).all(replayId,LIBRARY_DELETION_MAX_LOCATIONS+1);
    if(!rows.length||rows.length>LIBRARY_DELETION_MAX_LOCATIONS)throw new Error("Replay locations cannot be completely enumerated within the deletion limit");
    const locations:LibraryDeletionLocation[]=rows.map(row=>({id:deletionFingerprint([row.source_id,row.source_key]),sourceId:String(row.source_id),sourceKey:String(row.source_key),
      kind:String(row.kind) as LibrarySourceKind,directory:String(row.directory),configured:row.configured===1,enabled:row.enabled===1,
      sourceConfigRevision:Number(row.config_revision),locationRevision:Number(row.revision),locator:String(row.locator),sha256:row.sha256===null?null:String(row.sha256),
      available:row.available===1,metadata:JSON.parse(String(row.metadata))}));
    const contents=this.db.prepare("SELECT sha256 FROM contents WHERE replay_id=? ORDER BY sha256 LIMIT 130").all(replayId).map(row=>String(row.sha256));
    if(contents.length>128)throw new Error("Replay has too many content identities to confirm safely");
    const sources:LibraryDeletionSource[]=this.db.prepare("SELECT id,kind,directory,configured,enabled,config_revision FROM sources ORDER BY id LIMIT 129").all().map(row=>({
      id:String(row.id),kind:String(row.kind) as LibrarySourceKind,directory:String(row.directory),configured:row.configured===1,enabled:row.enabled===1,revision:Number(row.config_revision)}));
    if(sources.length>128)throw new Error("Configured and retained sources exceed the bounded deletion inspection limit");
    const result:LibraryDeletionSnapshot={replayId,aliases,contents,locations,sources};
    // Single-content snapshots retain their historical serialized shape. Multi-content
    // authority is complete, bounded and part of the immutable confirmation fingerprint.
    if(contents.length>1){
      const group=this.db.prepare("SELECT preferred_sha256 FROM content_identity_groups WHERE replay_id=?").get(replayId);
      const certificates=this.db.prepare(`SELECT i.sha256,i.identity_key,i.payload FROM content_identity_certificates i
        JOIN contents c ON c.sha256=i.sha256 WHERE c.replay_id=? ORDER BY i.sha256 LIMIT 129`).all(replayId);
      if(group&&contents.includes(String(group.preferred_sha256))&&certificates.length===contents.length){
        const values=certificates.map(row=>JSON.parse(String(row.payload)) as LibraryContentIdentityCertificate),key=String(certificates[0].identity_key);
        if(certificates.every((row,index)=>row.sha256===contents[index]&&row.identity_key===key&&values[index]?.replaySha256===row.sha256&&contentIdentityKey(values[index])===key))
          result.contentIdentity={version:1,identityKey:key,preferredSha256:String(group.preferred_sha256),certificates:values};
      }
      const inactive=contents.filter(sha256=>!locations.some(location=>location.sha256===sha256));
      if(result.contentIdentity&&inactive.length){
        const row=this.db.prepare(`SELECT payload FROM deletion_intents WHERE replay_id=? AND state='complete'
          AND json_type(payload,'$.metadataCommitted')='true' ORDER BY rowid DESC LIMIT 1`).get(replayId);
        if(row){
          const previous=JSON.parse(String(row.payload)) as LibraryDeletionIntent;
          const witness=previous.targets.map(target=>target.plan.contentHeaders as {version:number;identityKey:string;headers:LibraryDeletionHeaderWitness[]}|undefined).find(value=>value?.version===1);
          if(witness&&witness.identityKey===result.contentIdentity.identityKey&&Array.isArray(witness.headers)&&witness.headers.length<=128&&
            deletionFingerprint(previous.snapshot)===previous.snapshotFingerprint){
            const headers=witness.headers.filter(value=>inactive.includes(value.sha256));
            if(headers.length===inactive.length&&new Set(headers.map(value=>value.sha256)).size===inactive.length&&headers.every(value=>
              Array.isArray(value.locations)&&value.locations.length>0&&value.locations.length<=128&&value.locations.every(location=>sources.some(source=>source.id===location.sourceId&&
                source.kind===location.kind&&source.directory===location.directory&&source.revision===location.sourceConfigRevision&&source.configured))))
              result.contentIdentity.historical={intentId:previous.id,headers};
          }
        }
      }
    }
    this.encoded(result);return result;
  }
  private encoded(value:unknown):string {const payload=JSON.stringify(value);if(Buffer.byteLength(payload)>MAX_BYTES)throw new Error("Deletion plan exceeds its bounded journal limit");return payload;}
  deleted(replayId:string):boolean {return !!this.db.prepare("SELECT 1 FROM deleted_replays WHERE replay_id=?").get(replayId);}
  analysisBlocked(replayId:string):boolean {
    if(this.deleted(replayId))return true;
    const unresolved=this.unresolved(replayId);if(!unresolved)return false;
    return unresolved.state!=="partial"||unresolved.reconciledAt===undefined||
      !this.db.prepare("SELECT 1 FROM locations l JOIN sources s ON s.id=l.source_id WHERE l.replay_id=? AND l.available=1 AND s.enabled=1 AND s.configured=1 LIMIT 1").get(replayId);
  }
  retireBlockedAnalysis():void {
    this.transaction(()=>{
      const rows=this.db.prepare("SELECT DISTINCT replay_id FROM deletion_intents WHERE state IN ('committing','recovery-required','partial','cleanup-required','complete')").all();
      for(const row of rows)if(this.analysisBlocked(String(row.replay_id)))this.analysisChanged(String(row.replay_id),false);
    });
  }
  suppressed(sourceId:string,sourceKey:string,sha256:string|null):string|undefined {
    const row=this.db.prepare("SELECT replay_id,sha256 FROM deleted_locations WHERE source_id=? AND source_key=?").get(sourceId,sourceKey);
    return row&&(sha256===null||row.sha256===sha256)?String(row.replay_id):undefined;
  }
  revive(replayId:string,sourceId:string,sourceKey:string):void {
    this.db.prepare("DELETE FROM deleted_replays WHERE replay_id=?").run(replayId);
    this.db.prepare("DELETE FROM deleted_locations WHERE source_id=? AND source_key=?").run(sourceId,sourceKey);
  }
  create(intent:LibraryDeletionIntent):void {
    const payload=this.encoded(intent);
    this.transaction(()=>{
      for(const row of this.db.prepare("SELECT payload FROM deletion_intents WHERE state='preview'").all()){
        const previous=JSON.parse(String(row.payload)) as LibraryDeletionIntent;
        if(previous.expiresAt<=intent.createdAt||previous.replayId===intent.replayId)
          this.saveInTransaction({...previous,state:previous.stages?.length?"cleanup-required":previous.expiresAt<=intent.createdAt?"expired":"cancelled",tokenHash:null},previous.revision);
      }
      if(this.db.prepare("SELECT 1 FROM deletion_intents WHERE replay_id=? AND state IN ('committing','recovery-required','partial','cleanup-required')").get(intent.replayId))
        throw new Error("This replay has an unresolved deletion intent");
      if(Number(this.db.prepare("SELECT count(*) AS n FROM deletion_intents WHERE state='preview'").get()?.n)>=16)throw new Error("Too many pending deletion confirmations");
      // Drafts never changed a source and have no recovery authority. Bound their storage;
      // committed/uncertain intents and their evidence are never pruned by this operation.
      this.db.exec(`DELETE FROM deletion_intents WHERE state IN ('blocked','cancelled','expired') AND id NOT IN
        (SELECT id FROM deletion_intents WHERE state IN ('blocked','cancelled','expired') ORDER BY expires_at DESC,id DESC LIMIT 31)`);
      this.db.prepare("INSERT INTO deletion_intents VALUES(?,?,?,?,?,?,?)").run(intent.id,intent.replayId,intent.revision,intent.state,intent.tokenHash,intent.expiresAt,payload);
      if(this.analysisBlocked(intent.replayId))this.analysisChanged(intent.replayId,false);
    });
  }
  read(id:string):LibraryDeletionIntent {
    const row=this.db.prepare("SELECT payload FROM deletion_intents WHERE id=?").get(id);
    if(!row)throw new Error("Unknown deletion intent");return JSON.parse(String(row.payload));
  }
  stagedPreview(inputId:string):LibraryDeletionIntent|undefined{
    const row=this.db.prepare("SELECT payload FROM deletion_intents WHERE replay_id=? AND state='preview' AND json_array_length(payload,'$.stages')>0 LIMIT 1").get(this.resolve(inputId));
    return row?JSON.parse(String(row.payload)):undefined;
  }
  /** A new sole metadata owner cannot recover a lost renderer confirmation token. Keep its
   * staged bytes discoverable for explicit cleanup instead of stranding them behind a row. */
  abandonStagedConfirmations():void{
    this.transaction(()=>{
      const rows=this.db.prepare("SELECT payload FROM deletion_intents WHERE state='preview' AND json_array_length(payload,'$.stages')>0 LIMIT 17").all();
      if(rows.length>16)throw new Error("Staged confirmation inventory exceeds its bound");
      for(const row of rows){const intent=JSON.parse(String(row.payload)) as LibraryDeletionIntent;
        this.saveInTransaction({...intent,state:"cleanup-required",tokenHash:null,blockers:["An unfinished confirmation left prepared app files; finish cleanup before reviewing a new deletion."]},intent.revision);}
    },true);
  }
  protectedStages():{stageId:string;intentId:string;intentFingerprint:string}[]{
    const rows=this.db.prepare(`SELECT payload FROM deletion_intents WHERE state IN ('preview','committing','recovery-required','partial','cleanup-required')
      AND json_array_length(payload,'$.stages')>0 AND json_type(payload,'$.stageCleanupOnly') IS NOT 'true' LIMIT 17`).all();
    if(rows.length>16)throw new Error("Stage journal inventory exceeds its complete ownership bound");
    const stages=rows.flatMap(row=>{const intent=JSON.parse(String(row.payload)) as LibraryDeletionIntent;
      if(!intent.preparationFingerprint)throw new Error("Stage journal binding is incomplete");
      return(intent.stages??[]).map(stage=>({stageId:stage.stageId,intentId:intent.id,intentFingerprint:intent.preparationFingerprint!}));});
    if(stages.length>16||new Set(stages.map(stage=>stage.stageId)).size!==stages.length)throw new Error("Stage journal inventory exceeds its complete ownership bound");return stages;
  }
  unresolved(inputId:string):LibraryDeletionIntent|undefined {
    const row=this.db.prepare("SELECT payload FROM deletion_intents WHERE replay_id=? AND state IN ('committing','recovery-required','partial','cleanup-required') ORDER BY id LIMIT 1").get(this.resolve(inputId));
    return row?JSON.parse(String(row.payload)):undefined;
  }
  pending(after=""):LibraryDeletionPendingPage {
    const rows=this.db.prepare("SELECT payload FROM deletion_intents WHERE state IN ('committing','recovery-required','partial','cleanup-required') AND id>? ORDER BY id LIMIT 33").all(after);
    const items=rows.slice(0,32).map(row=>{const intent=JSON.parse(String(row.payload)) as LibraryDeletionIntent;
      return{intentId:intent.id,replayId:intent.replayId,state:intent.state as LibraryDeletionPending["state"],createdAt:intent.createdAt,
        committedTargets:intent.targets.filter(target=>target.state==="committed").length,totalTargets:intent.targets.length};});
    return{items,...(rows.length>32?{next:items[items.length-1].intentId}:{})};
  }
  byToken(token:string):LibraryDeletionIntent {
    const row=this.db.prepare("SELECT payload FROM deletion_intents WHERE token_hash=?").get(deletionFingerprint(token));
    if(!row)throw new Error("Deletion confirmation is expired or already used");return JSON.parse(String(row.payload));
  }
  /** CAS is durable before a caller may enter the next source mutation boundary. */
  save(intent:LibraryDeletionIntent,expectedRevision:number):LibraryDeletionIntent {
    return this.transaction(()=>this.saveInTransaction(intent,expectedRevision),true);
  }
  private saveInTransaction(intent:LibraryDeletionIntent,expectedRevision:number):LibraryDeletionIntent {
    const wasBlocked=this.analysisBlocked(intent.replayId);
    const next={...intent,revision:expectedRevision+1},payload=this.encoded(next);
    if(!this.db.prepare("UPDATE deletion_intents SET revision=?,state=?,token_hash=?,expires_at=?,payload=? WHERE id=? AND revision=? RETURNING id")
      .get(next.revision,next.state,next.tokenHash,next.expiresAt,payload,next.id,expectedRevision))throw new Error("Deletion intent changed concurrently");
    this.analysisChanged(next.replayId,wasBlocked&&!this.analysisBlocked(next.replayId));
    return next;
  }
  /** Publish only an acknowledged applied target; unknown outcomes retain their existing availability. */
  saveOutcome(intent:LibraryDeletionIntent,index:number):LibraryDeletionIntent {
    const target=intent.targets[index];if(target.state!=="committed")return this.save(intent,intent.revision);
    return this.transaction(()=>{
      const retiredLocations=[...(intent.retiredLocations??[])];
      for(const id of target.locationIds){
        if(retiredLocations.some(item=>item.id===id))continue;
        const location=intent.snapshot.locations.find(item=>item.id===id);if(!location)throw new Error("Deletion receipt has no pinned location");
        const revision=location.locationRevision+1;
        const changed=this.db.prepare("UPDATE locations SET available=0,revision=? WHERE source_id=? AND source_key=? AND replay_id=? AND revision=?")
          .run(revision,location.sourceId,location.sourceKey,intent.replayId,location.locationRevision);
        if(Number(changed.changes)!==1)throw new Error("Deletion location changed before receipt publication");
        this.tombstone(intent,location);retiredLocations.push({id,revision});
      }
      return this.saveInTransaction({...intent,retiredLocations},intent.revision);
    },true);
  }
  private snapshotMatches(intent:LibraryDeletionIntent):boolean {
    const current=this.snapshot(intent.replayId);
    for(const retired of intent.retiredLocations??[]){
      const location=current.locations.find(item=>item.id===retired.id),before=intent.snapshot.locations.find(item=>item.id===retired.id);
      if(!location||!before||location.available||location.locationRevision!==retired.revision)return false;
      location.available=before.available;location.locationRevision=before.locationRevision;
    }
    return deletionFingerprint(current)===intent.snapshotFingerprint;
  }
  assertSnapshot(intent:LibraryDeletionIntent):void{if(!this.snapshotMatches(intent))throw new Error("Deletion preview is stale; review the changed source/index scope");}
  private tombstone(intent:LibraryDeletionIntent,location:LibraryDeletionLocation):void {
    this.db.prepare(`INSERT INTO deleted_locations VALUES(?,?,?,?) ON CONFLICT(source_id,source_key)
      DO UPDATE SET sha256=excluded.sha256,replay_id=excluded.replay_id`).run(location.sourceId,location.sourceKey,location.sha256,intent.replayId);
  }
  complete(intent:LibraryDeletionIntent):LibraryDeletionIntent {
    if(intent.targets.length===0||intent.targets.some(target=>target.state!=="committed"))throw new Error("Deletion source commit is incomplete");
    if(intent.metadataCommitted)return intent;
    return this.transaction(()=>{
      if(!this.snapshotMatches(intent))throw new Error("Library identity changed before deletion finalization");
      this.finalize(intent);
      const revision=intent.revision+1,markerSha256=deletionFingerprint({intentId:intent.id,revision,snapshotFingerprint:intent.snapshotFingerprint,
        targets:intent.targets.map(target=>({id:target.target.id,fingerprint:target.receipt?.fingerprint}))});
      return this.saveInTransaction({...intent,state:"cleanup-required",metadataCommitted:true,metadataCompletion:{revision,markerSha256},tokenHash:null},intent.revision);
    },true);
  }
  finalizeLocations(intent:LibraryDeletionIntent):void {
    this.db.prepare("INSERT INTO deleted_replays VALUES(?,?)").run(intent.replayId,intent.id);
    for(const location of intent.snapshot.locations){
      this.tombstone(intent,location);
      const revision=intent.retiredLocations?.find(item=>item.id===location.id)?.revision??location.locationRevision;
      const removed=this.db.prepare("DELETE FROM locations WHERE source_id=? AND source_key=? AND replay_id=? AND revision=?").run(location.sourceId,location.sourceKey,intent.replayId,revision);
      if(Number(removed.changes)!==1)throw new Error("Deletion location changed before finalization");
    }
    for(const sha of intent.snapshot.contents)this.db.prepare("DELETE FROM import_intents WHERE sha256=?").run(sha);
  }
}
