import { randomUUID } from "crypto";
import type { LibraryAnalysisControl, LibraryYieldAcknowledgement } from "../../../../shared/library-analysis-gate";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LibraryNumericalResourceDescriptor,LibraryAnalysisContinuation,LibraryTimelineOutcome } from "../../../../shared/library-analysis";
import type { LibraryResourceChunk, LibraryResourceTransfer } from "../../../../shared/library-resources";
import type { LibraryOperation } from "./library-process-client";
import type { LibraryResourceOperation } from "./library-resource-server";
import type { LibraryPreparationTicket } from "./library-preparation-store";
import type { LibraryMetricTicket,LibraryMetricResult } from "../../../../shared/replay-library-metrics";
import type { LibraryLocationRefreshResult, LibraryAnalysisLease } from "./library-store";
import { LibraryReplayOpener } from "./library-replay-opener";
import { validateNumericalRecipe } from "./library-numerical-profile";
import type { LibraryMetricHandoff } from "./library-metric-store";
import { libraryTimelineTarget } from "./library-timeline-target";
import { libraryFcTarget } from "./library-fc-target";
import { validateLibraryIncidentEvidence } from "../../../../shared/library-incidents";

interface Dependencies {
  metadata(method:LibraryOperation,args?:Record<string,unknown>):Promise<unknown>;
  /** A new background-configured utility owned only by this task, never the viewer's resource client. */
  resources:{request(method:LibraryResourceOperation,args?:Record<string,unknown>):Promise<unknown>;close():Promise<void>};
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
function descriptor(value:unknown,replaySha256:string,mapSha256:string):LibraryNumericalResourceDescriptor {
  if(!record(value)||!record(value.input)||!record(value.target)||!record(value.input.binding)||JSON.stringify(value).length>8192)
    throw new Error("Invalid numerical resource descriptor");
  const {input,target,origin}=value,binding=input.binding as Record<string,unknown>;
  validateNumericalRecipe(value.recipe);
  if(value.recipe.replaySha256!==replaySha256)throw new Error("Numerical recipe identity mismatch");
  if(value.incidentEvidence!==undefined)validateLibraryIncidentEvidence(value.incidentEvidence,{replaySha256,mapMd5:String(binding.mapMd5)});
  if(input.format!=="resources"||!Number.isSafeInteger(input.replayBytes)||Number(input.replayBytes)<1||Number(input.replayBytes)>64*1024*1024||
    !Number.isSafeInteger(input.mapBytes)||Number(input.mapBytes)<1||Number(input.mapBytes)>16*1024*1024||
    binding.replaySha256!==replaySha256||binding.mapSha256!==mapSha256||typeof binding.mapMd5!=="string"||!/^[a-f0-9]{32}$/.test(binding.mapMd5)||
    typeof binding.exactMapAndProfile!=="boolean"||target.slot!=="numerical"||target.stage!=="S"||typeof target.inputKey!=="string"||
    !/^[a-f0-9]{64}$/.test(target.inputKey)||target.producerVersion!==LIBRARY_NUMERIC_PROJECTION_VERSION||
    origin!==null&&(!record(origin)||!["stable","lazer"].includes(String(origin.client))||origin.provenance!=="user-confirmed"))
    throw new Error("Invalid numerical resource descriptor");
  return JSON.parse(JSON.stringify(value)) as LibraryNumericalResourceDescriptor;
}

/** One prepared S execution owns its utility through the final byte/exit. Main publishes only the
 * verified target; renderer receives no paths or SQLite privileges. */
export class LibraryNumericalResources {
  private readonly opener:LibraryReplayOpener;
  private readonly requestId=randomUUID();
  private preparation?:LibraryPreparationTicket;
  private execution?:LibraryMetricTicket;
  private claimPrepared=false;
  private claimed?:LibraryMetricHandoff;
  private location?:LibraryAnalysisLease["location"];
  private map?:LibraryAnalysisLease["map"];
  /** Remains available after close/error so the execution owner can release the exact claimed job. */
  get handoff():LibraryMetricHandoff|undefined{return this.claimed;}
  get metricTicket():LibraryMetricTicket|undefined{return this.claimed?this.claimed.state==="claimed"?this.claimed.ticket:undefined:this.execution;}
  private publication?:Promise<LibraryAnalysisContinuation>;
  private numericalPublished=false;
  private timelinePublished=false;
  private fcPublished=false;
  private prepared?:LibraryNumericalResourceDescriptor;
  private numericalTarget?:LibraryNumericalResourceDescriptor["target"];
  private opened=false;
  private consumed=false;
  private closed=false;
  private closing?:Promise<void>;
  private detach?:()=>void;
  private transfer?:{kind:"replay"|"map";id:string};
  private readonly offsets={replay:0,map:0};
  private reading=false;
  constructor(private readonly deps:Dependencies) {
    this.opener=new LibraryReplayOpener({analysis:true,metadata:deps.metadata,resources:deps.resources,
      observeLocation:ticket=>{this.location={sourceId:ticket.sourceId,sourceConfigRevision:ticket.sourceConfigRevision};this.map=undefined;},
      observeMap:ticket=>{this.map={sourceId:ticket.sourceId,sourceConfigRevision:ticket.sourceConfigRevision};},publish:async publication=>{
      if((!this.preparation&&!this.execution)||this.closed)throw new Error("Numerical preparation expired");
      const prepared=descriptor(await deps.resources.request("describe-analysis",{sessionId:publication.sessionId}),
        publication.observation.sha256 as string,publication.mapSha256);
      if(this.closed)throw new Error("Numerical preparation expired");
      const expected=this.execution?.slot==="timeline-pp"?libraryTimelineTarget({...prepared.target,replayId:this.execution.replayId}):
        this.execution?.slot==="fc-pp"?libraryFcTarget({...prepared.target,replayId:this.execution.replayId}):prepared.target;
      if(this.execution&&(["slot","stage","inputKey","producerVersion"] as const).some(key=>expected[key]!==this.execution?.[key]))
        throw new Error("Numerical target inputs changed; prepare current inputs before retrying");
      const result=await (this.preparation ? deps.metadata("preparation-commit",{ticket:this.preparation,location:publication.ticket,
        observation:publication.observation,targets:[prepared.target],origin:prepared.origin,recipe:prepared.recipe,
        ...(prepared.incidentEvidence?{incidentEvidence:prepared.incidentEvidence}:{}),
        ...(this.claimPrepared?{handoff:true}:{}),...(publication.map?{map:publication.map}:{})})
        :deps.metadata("analysis-resources-confirm",{ticket:this.execution,location:publication.ticket,observation:publication.observation,
          origin:prepared.origin,recipe:prepared.recipe,...(prepared.incidentEvidence?{incidentEvidence:prepared.incidentEvidence}:{}),
          ...(publication.map?{map:publication.map}:{})})) as LibraryLocationRefreshResult;
      if(result.state==="applied"){
        this.claimed=result.handoff;
        if(this.claimPrepared&&!result.handoff)throw new Error("Missing prepared handoff");
        this.prepared=prepared;
        this.numericalTarget={...prepared.target};
      }return result;
    }});
  }
  async open(ticket:LibraryPreparationTicket,initial:LibraryAnalysisControl,signal:AbortSignal,handoff=false):Promise<LibraryNumericalResourceDescriptor&{replayId:string}> {
    signal.throwIfAborted();if(this.closed||this.opened||ticket.stage!=="S")throw new Error("Invalid numerical preparation ownership");
    this.preparation={...ticket};this.claimPrepared=handoff;return this.openReplay(ticket.replayId,initial,signal);
  }
  async eligible():Promise<boolean> {
    await this.publication;
    if(this.claimed&&this.claimed.state!=="claimed")return true; // Only retirement remains; no next phase was admitted.
    const ticket=this.claimed?.state==="claimed"?this.claimed.ticket:this.execution??this.preparation;
    if(!ticket)return true;
    const lease:LibraryAnalysisLease={...("slot" in ticket?{kind:"metric" as const,ticket}:{kind:"preparation" as const,ticket}),
      ...(this.location?{location:this.location}:{}),...(this.map?{map:this.map}:{})};
    const eligible=await this.deps.metadata("analysis-eligible",{lease});if(typeof eligible!=="boolean")throw new Error("Invalid analysis eligibility response");return eligible;
  }
  async openTarget(ticket:LibraryMetricTicket,initial:LibraryAnalysisControl,signal:AbortSignal):Promise<LibraryNumericalResourceDescriptor&{replayId:string}> {
    signal.throwIfAborted();if(this.closed||this.opened||!(ticket.stage==="S"&&["numerical","timeline-pp","fc-pp"].includes(ticket.slot)))throw new Error("Invalid numerical target ownership");
    this.execution={...ticket};return this.openReplay(ticket.replayId,initial,signal);
  }
  /** Retains the source/map lease while metadata atomically transfers the active metric attempt. */
  publishNumerical(metrics:LibraryMetricResult):Promise<LibraryAnalysisContinuation>{
    if(this.numericalPublished)throw new Error("Numerical publication already started");this.numericalPublished=true;
    const ticket=this.metricTicket;
    if(!ticket||this.closed&&!this.consumed)throw new Error("Numerical publication ownership is unavailable");
    if(ticket.slot==="timeline-pp")return Promise.resolve(true);
    if(ticket.slot==="fc-pp")return Promise.resolve("fc");
    if(ticket.slot!=="numerical")throw new Error("Numerical publication ownership is unavailable");
    this.publication=(async()=>{
      const receipt=await this.deps.metadata("metric-numerical-handoff",{patch:{ticket,producerVersion:ticket.producerVersion,...metrics}}) as LibraryMetricHandoff;
      if(!receipt||!["claimed","cached","blocked","stale"].includes(receipt.state))throw new Error("Invalid numerical handoff receipt");
      if(receipt.state==="claimed"){
        const target=receipt.ticket?.slot==="fc-pp"?libraryFcTarget(ticket):libraryTimelineTarget(ticket);
        if(!receipt.ticket||Object.entries(target).some(([key,value])=>receipt.ticket[key as keyof typeof receipt.ticket]!==value)||
          !Number.isSafeInteger(receipt.ticket.generation)||receipt.ticket.generation<1||typeof receipt.ticket.attempt!=="string"||!receipt.ticket.attempt)
          throw new Error("Invalid timeline handoff ownership");
      }
      this.claimed=receipt;this.execution=undefined;return receipt.state==="claimed"?(receipt.ticket.slot==="fc-pp"?"fc":true):false;
    })();return this.publication;
  }
  publishTimeline(outcome:LibraryTimelineOutcome):Promise<boolean>{
    const ticket=this.metricTicket,numerical=this.numericalTarget;
    if(this.timelinePublished||!this.numericalPublished||!numerical||!ticket||ticket.slot!=="timeline-pp"||this.closed&&!this.consumed)
      throw new Error("Timeline publication ownership is unavailable");
    this.timelinePublished=true;
    const pending=(async()=>{
      const receipt=await this.deps.metadata("metric-timeline-handoff",{ticket,outcome}) as LibraryMetricHandoff;
      if(!receipt||!["claimed","cached","blocked","stale"].includes(receipt.state))throw new Error("Invalid timeline handoff receipt");
      if(receipt.state==="claimed"){
        const target=libraryFcTarget({...numerical,replayId:ticket.replayId});
        if(!receipt.ticket||Object.entries(target).some(([key,value])=>receipt.ticket[key as keyof typeof receipt.ticket]!==value)||
          !Number.isSafeInteger(receipt.ticket.generation)||receipt.ticket.generation<1||typeof receipt.ticket.attempt!=="string"||!receipt.ticket.attempt)
          throw new Error("Invalid FC handoff ownership");
      }
      this.claimed=receipt;this.execution=undefined;return receipt.state==="claimed";
    })();this.publication=pending;return pending;
  }
  publishFc(outcome:LibraryTimelineOutcome):Promise<boolean>{
    const ticket=this.metricTicket,numerical=this.numericalTarget;
    if(this.fcPublished||!this.numericalPublished||!numerical||!ticket||ticket.slot!=="fc-pp"||this.closed&&!this.consumed)
      throw new Error("FC publication ownership is unavailable");
    this.fcPublished=true;
    const pending=(async()=>{
      const receipt=await this.deps.metadata("metric-fc-handoff",{ticket,outcome}) as LibraryMetricHandoff;
      if(!receipt||!["cached","blocked","stale"].includes(receipt.state))throw new Error("Invalid final FC publication receipt");
      this.claimed=receipt;this.execution=undefined;return false;
    })();this.publication=pending;return pending;
  }
  private async openReplay(replayId:string,initial:LibraryAnalysisControl,signal:AbortSignal):Promise<LibraryNumericalResourceDescriptor&{replayId:string}> {
    this.opened=true;
    const abort=()=>{void this.close().catch(()=>undefined);};signal.addEventListener("abort",abort,{once:true});
    this.detach=()=>signal.removeEventListener("abort",abort);
    const check=()=>{signal.throwIfAborted();if(this.closed)throw new Error("Numerical resources closed");};
    try {
      await this.control(initial);check();
      const prepare=async()=>{
        try{return await this.opener.open(this.requestId,replayId,check);}
        catch(error){await this.close();throw error;}
      };
      const handle=await prepare();check();
      if(!this.prepared||this.prepared.input.binding.mapMd5!==handle.beatmapMd5)throw new Error("Numerical descriptor map identity mismatch");
      return {...JSON.parse(JSON.stringify(this.prepared)),replayId:handle.replayId};
    }catch(error){await this.close();throw error;}
  }
  async control(value:LibraryAnalysisControl):Promise<LibraryYieldAcknowledgement> {
    if(this.closing){await this.closing;return"idle";}
    const result=await this.deps.resources.request("control",{...value});
    if(!["idle","parked","superseded","released"].includes(String(result)))throw new Error("Invalid background resource acknowledgement");
    return result as LibraryYieldAcknowledgement;
  }
  async read(kind:"replay"|"map",offset:number,signal:AbortSignal):Promise<LibraryResourceChunk> {
    signal.throwIfAborted();
    if(this.closed||!this.prepared)throw new Error("Numerical resources closed or consumed");
    if(this.reading||!["replay","map"].includes(kind)||!Number.isSafeInteger(offset)||offset!==this.offsets[kind]||
      kind==="map"&&this.offsets.replay!==this.prepared.input.replayBytes)throw new Error("Invalid numerical resource read order");
    this.reading=true;
    const abort=()=>{void this.close().catch(()=>undefined);};signal.addEventListener("abort",abort,{once:true});
    try {
      const size=kind==="replay"?this.prepared.input.replayBytes:this.prepared.input.mapBytes;
      if(!this.transfer){
        const opened:LibraryResourceTransfer=await this.opener.transfer(this.requestId,kind);signal.throwIfAborted();
        if(opened.unavailable||opened.bytes!==size||!opened.id)throw new Error("Numerical transfer size mismatch");
        this.transfer={kind,id:opened.id};
      }
      if(this.transfer.kind!==kind)throw new Error("Overlapping numerical resource transfer");
      const chunk=await this.opener.chunk(this.requestId,this.transfer.id,offset);signal.throwIfAborted();
      if(!(chunk.bytes instanceof Uint8Array)||!chunk.bytes.length||chunk.bytes.length>256*1024||offset+chunk.bytes.length>size||
        chunk.done!==(offset+chunk.bytes.length===size))throw new Error("Invalid numerical resource bytes");
      this.offsets[kind]+=chunk.bytes.length;if(chunk.done)this.transfer=undefined;
      if(kind==="map"&&chunk.done){await this.close();signal.throwIfAborted();this.consumed=true;}
      signal.throwIfAborted();
      return chunk;
    }catch(error){await this.close();throw error;}finally {
      signal.removeEventListener("abort",abort);this.reading=false;
      // A rejected read alone does not prove the utility/native owner has exited.
      if(this.closing)await this.closing;
    }
  }
  close():Promise<void> {
    if(!this.closing){this.closed=true;this.detach?.();this.closing=this.opener.close().finally(()=>{this.prepared=undefined;this.transfer=undefined;});}
    return this.closing;
  }
}
