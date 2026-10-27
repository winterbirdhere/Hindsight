import type { Beatmap } from "@osujs/core";
import { isLazerReplay, OsuReplay } from "../../model/OsuReplay";
import type { PerformanceRequest,PerformanceResponse } from "@rewind/osu-performance/protocol";
import type { LibraryMetricResult, LibraryMetricTicket } from "../../../../../shared/replay-library-metrics";
import { hydratePreparedBeatmapAsync } from "../common/game/PreparedBeatmapWire";
import { LibraryAnalysisGate, LibraryYieldAcknowledgement } from "./library-analysis-gate";
import { LibraryNumericalBinding, runLibraryNumerical } from "./library-numerical";
import { LibraryNumericalResourceInput, prepareLibraryNumericalInput } from "./library-analysis-input";
import type { LibraryResourceChunk } from "../../../../../shared/library-resources";
import { buildReplayPerformanceInputAsync } from "../analysis/performance/replay-performance-input";
import { projectLibraryTimeline } from "./library-timeline";
import { libraryFcCalculation,projectLibraryFc } from "./library-fc";
import type { LibraryAnalysisContinuation,LibraryTimelineOutcome } from "../../../../../shared/library-analysis";

export interface LibraryNumericalWireInput { beatmap:Beatmap; hitObjectKinds:string[]; replay:OsuReplay; binding:LibraryNumericalBinding }
export type LibraryAnalysisResponse = {version:1;type:"control";sequence:number;requestId:number|null;state:LibraryYieldAcknowledgement}
  | {version:1;type:"read";requestId:number;ticket:LibraryMetricTicket;readId:number;kind:"replay"|"map";offset:number}
  | {version:1;type:"numerical";requestId:number;ticket:LibraryMetricTicket;metrics:LibraryMetricResult}
  | {version:1;type:"timeline"|"fc";requestId:number;ticket:LibraryMetricTicket;outcome:LibraryTimelineOutcome}
  | {version:1;type:"result";requestId:number;ticket:LibraryMetricTicket;status:"complete";metrics:LibraryMetricResult}
  | {version:1;type:"result";requestId:number;ticket?:LibraryMetricTicket;status:"error"|"cancelled";error:string};
const record=(v:unknown):v is Record<string,unknown> => !!v&&typeof v==="object"&&!Array.isArray(v);
const token=(v:unknown,max=128):v is string => typeof v==="string"&&v.length>0&&v.length<=max&&/^[a-zA-Z0-9_.:/+-]+$/.test(v);
const positive=(v:unknown):v is number => typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
export function isNumericalTicket(v:unknown):v is LibraryMetricTicket {
  return record(v)&&token(v.replayId)&&(v.slot==="numerical"||v.slot==="timeline-pp"||v.slot==="fc-pp")&&v.stage==="S"&&token(v.inputKey,512)&&token(v.producerVersion)&&positive(v.generation)&&token(v.attempt);
}

/** Dedicated library worker owner; controls may arrive while its one traversal promise is parked. */
export class LibraryAnalysisWorkerServer {
  private readonly gate:LibraryAnalysisGate;
  private fasterProcessing=false;
  private controlSequence=0;
  private lastRequest=0;
  private owner?:{requestId:number;ticket:LibraryMetricTicket;controller:AbortController};
  private readSequence=0;
  private pendingRead?:{requestId:number;readId:number;finish:(chunk?:LibraryResourceChunk,error?:unknown)=>void};
  private pendingPublication?:{requestId:number;finish:(timeline:LibraryAnalysisContinuation)=>void};
  constructor(private readonly send:(value:LibraryAnalysisResponse)=>void,private readonly numerical=runLibraryNumerical,
    private readonly calculateTimeline?:(request:PerformanceRequest,signal:AbortSignal)=>Promise<PerformanceResponse>,
    yieldTurn?:(fasterProcessing:boolean)=>Promise<void>) {this.gate=new LibraryAnalysisGate(yieldTurn?()=>yieldTurn(this.fasterProcessing):undefined);}
  async receive(value:unknown):Promise<void> {
    if(!record(value)||value.version!==1)return;
    if(value.type==="continue"){
      const pending=this.pendingPublication;
      if(pending&&value.requestId===pending.requestId&&(typeof value.timeline==="boolean"||value.timeline==="fc"))pending.finish(value.timeline);
      return;
    }
    if(value.type==="chunk") {
      const pending=this.pendingRead;
      if(!pending||value.requestId!==pending.requestId||value.readId!==pending.readId)return;
      if(typeof value.error==="string")pending.finish(undefined,new Error(value.error.slice(0,2048)));
      else if(!record(value.chunk)||!(value.chunk.bytes instanceof Uint8Array)||typeof value.chunk.done!=="boolean")
        pending.finish(undefined,new Error("Invalid numerical resource chunk"));
      else pending.finish(value.chunk as unknown as LibraryResourceChunk);
      return;
    }
    if(value.type==="control") {
      if(!positive(value.sequence)||value.sequence<=this.controlSequence||typeof value.viewerDemand!=="boolean"||typeof value.userPaused!=="boolean"||
        value.fasterProcessing!==undefined&&typeof value.fasterProcessing!=="boolean")return;
      const sequence=this.controlSequence=value.sequence,requestId=this.owner?.requestId??null;
      this.fasterProcessing=value.fasterProcessing===true;
      const state=await this.gate.control({viewerDemand:value.viewerDemand,userPaused:value.userPaused});
      this.send({version:1,type:"control",sequence,requestId,state});return;
    }
    if(value.type==="cancel") {
      if(this.owner&&value.requestId===this.owner.requestId)this.owner.controller.abort(new Error("Library analysis cancelled"));
      return;
    }
    if(value.type!=="run"||!positive(value.requestId))return;
    const requestId=value.requestId;
    let admitted:typeof this.owner;
    try {
      if(requestId<=this.lastRequest)throw new Error("Stale library analysis request");
      this.lastRequest=requestId;
      if(this.owner)throw new Error("Library analysis worker already owns a job");
      if(!isNumericalTicket(value.ticket)||!record(value.input))throw new Error("Invalid library numerical request");
      if(value.timeline!==undefined&&typeof value.timeline!=="boolean"||value.timeline===true&&!this.calculateTimeline)
        throw new Error("Library timeline producer is unavailable");
      if(value.fc!==undefined&&typeof value.fc!=="boolean"||value.fc===true&&value.timeline!==true)throw new Error("Invalid FC continuation request");
      if(value.incidents!==undefined)throw new Error("Incident analysis is retired");
      if(value.publishFc!==undefined&&typeof value.publishFc!=="boolean"||value.publishFc===true&&value.fc!==true)throw new Error("Invalid final FC publication request");
      const resourceInput=value.input.format==="resources"?value.input as unknown as LibraryNumericalResourceInput:undefined;
      const input=value.input as unknown as LibraryNumericalWireInput;
      if(!resourceInput&&(!Array.isArray(input.beatmap?.hitObjects)||input.beatmap.hitObjects.length>100000||
        !Array.isArray(input.hitObjectKinds)||input.hitObjectKinds.length!==input.beatmap.hitObjects.length||
        !Array.isArray(input.replay?.frames)||input.replay.frames.length>1000000||!record(input.binding)))throw new Error("Invalid or oversized library numerical input");
      admitted={requestId,ticket:{...value.ticket},controller:new AbortController()};this.owner=admitted;
      const owner=admitted;
      const metrics=await this.gate.run(async()=>{
        const checkpoint=()=>this.gate.checkpoint();
        const prepared=resourceInput?await prepareLibraryNumericalInput(resourceInput,(kind,offset)=>this.gate.waitForExternal(this.read(kind,offset,owner)),checkpoint,owner.controller.signal)
          :{beatmap:await hydratePreparedBeatmapAsync(input.beatmap,input.hitObjectKinds,checkpoint),replay:input.replay,binding:input.binding,mapText:undefined};
        const result=await this.numerical(prepared.beatmap,prepared.replay,prepared.binding,checkpoint);
        let next:LibraryAnalysisContinuation=value.timeline===true?await this.gate.waitForExternal(this.publish({type:"numerical",metrics:result.metrics},owner)):false;
        if(next){
          let performance:ReturnType<typeof buildReplayPerformanceInputAsync>|undefined;
          const performanceInput=()=>performance??=buildReplayPerformanceInputAsync({beatmap:prepared.beatmap,replay:prepared.replay,state:result.state,
            mode:isLazerReplay(prepared.replay)?prepared.beatmap.lazerModSettings.classic?"lazer-classic":"lazer":"stable",
            finalReplayTime:result.scoring.endTime,stateIsScoringBounded:true},checkpoint);
          const calculate=(calculations:PerformanceRequest["calculations"])=>{
            if(prepared.mapText===undefined||!this.calculateTimeline)throw new Error("Verified timeline map bytes are unavailable");
            return this.gate.waitForExternal(this.calculateTimeline({beatmap:prepared.mapText,calculations},owner.controller.signal));
          };
          const ordinaryFailure=(error:unknown):LibraryTimelineOutcome=>{
            owner.controller.signal.throwIfAborted();if(record(error)&&error.libraryNativeOwnershipUncertain===true)throw error;
            return{error:(error instanceof Error?error.message:"Library performance failed").slice(0,2048)};
          };
          if(next===true){
            let outcome:LibraryTimelineOutcome;
            try{
              const timeline=await performanceInput();await checkpoint();
              const response=await calculate([{mode:timeline.mode,mods:timeline.mods,states:timeline.states}]);
              outcome={metrics:await projectLibraryTimeline(timeline,response,prepared.beatmap.hitObjects.length,result.metrics,checkpoint)};
            }catch(error){
              outcome=ordinaryFailure(error);
              if(value.fc!==true)throw error;
            }
            if(value.fc!==true){if("metrics"in outcome)return outcome.metrics;throw new Error(outcome.error);}
            next=await this.gate.waitForExternal(this.publish({type:"timeline",outcome},owner));
            if(!next)return "metrics"in outcome?outcome.metrics:result.metrics;
            if(next!=="fc")throw new Error("Invalid performance phase continuation");
          }
          if(next==="fc"){
            let outcome:LibraryTimelineOutcome;
            try{
              const timeline=await performanceInput();await checkpoint();
              const calculation=libraryFcCalculation(timeline,result.metrics,prepared.beatmap.hitObjects.length);
              const response=calculation?await calculate([calculation]):undefined;
              outcome={metrics:projectLibraryFc(timeline,response,prepared.beatmap.hitObjects.length,result.metrics)};
            }catch(error){outcome=ordinaryFailure(error);if(value.publishFc!==true)throw error;}
            if(value.publishFc!==true){if("metrics"in outcome)return outcome.metrics;throw new Error(outcome.error);}
            next=await this.gate.waitForExternal(this.publish({type:"fc",outcome},owner));
            if(next!==false)throw new Error("Invalid final FC continuation");
            return "metrics"in outcome?outcome.metrics:result.metrics;
          }
          throw new Error("Invalid analysis continuation");
        }
        // Simulation state, map text and per-object performance inputs stay worker-local.
        return result.metrics;
      },admitted.controller.signal);
      admitted.controller.signal.throwIfAborted();
      this.send({version:1,type:"result",requestId,ticket:admitted.ticket,status:"complete",metrics});
    } catch(error) {
      this.send({version:1,type:"result",requestId,ticket:admitted?.ticket,status:admitted?.controller.signal.aborted?"cancelled":"error",
        error:(error instanceof Error?error.message:"Library numerical analysis failed").slice(0,2048)});
    } finally {if(admitted&&this.owner===admitted)this.owner=undefined;}
  }
  private publish(value:{type:"numerical";metrics:LibraryMetricResult}|{type:"timeline"|"fc";outcome:LibraryTimelineOutcome},owner:NonNullable<LibraryAnalysisWorkerServer["owner"]>):Promise<LibraryAnalysisContinuation>{
    const signal=owner.controller.signal;signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const finish=(timeline:LibraryAnalysisContinuation)=>{signal.removeEventListener("abort",abort);this.pendingPublication=undefined;resolve(timeline);};
      const abort=()=>{this.pendingPublication=undefined;signal.removeEventListener("abort",abort);reject(signal.reason);};
      this.pendingPublication={requestId:owner.requestId,finish};signal.addEventListener("abort",abort,{once:true});
      try{this.send({version:1,requestId:owner.requestId,ticket:owner.ticket,...value});}catch(error){signal.removeEventListener("abort",abort);this.pendingPublication=undefined;reject(error);}
    });
  }
  private read(kind:"replay"|"map",offset:number,owner:NonNullable<LibraryAnalysisWorkerServer["owner"]>):Promise<LibraryResourceChunk> {
    const signal=owner.controller.signal;signal.throwIfAborted();
    if(this.pendingRead)throw new Error("Numerical resource reads must be serial");
    const readId=++this.readSequence;
    return new Promise((resolve,reject)=>{
      const finish=(chunk?:LibraryResourceChunk,error?:unknown)=>{
        signal.removeEventListener("abort",abort);
        if(this.pendingRead?.readId===readId)this.pendingRead=undefined;
        if(chunk)resolve(chunk);else reject(error??new Error("Numerical resource read failed"));
      };
      const abort=()=>finish(undefined,signal.reason??new Error("Numerical resource read cancelled"));
      this.pendingRead={requestId:owner.requestId,readId,finish};signal.addEventListener("abort",abort,{once:true});
      try{this.send({version:1,type:"read",requestId:owner.requestId,ticket:owner.ticket,readId,kind,offset});}
      catch(error){finish(undefined,error);}
    });
  }
}
