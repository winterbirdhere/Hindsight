import type { LibraryChildOwner } from "./library-main-owner";
import type { LibraryOperation } from "./library-process-client";
import { LibraryScheduler, LibraryScheduledWork, LibrarySchedulerControl, LibrarySchedulerPreparations } from "./library-scheduler";
import type { LibraryPreparationRequest, LibraryPreparationTicket, LibraryPreparationStage } from "./library-preparation-store";
import type { LibraryAnalysisSettings, LibraryMetricJob, LibraryMetricTicket, LibraryMetricSlot } from "../../../../shared/replay-library-metrics";
import type { LibraryStatus } from "../../../../shared/replay-library";

/** Main-owned composition. SQLite remains alive until every execution drains and its ticket is
 * released/published. Metadata startup and foreground demand never wait for background completion. */
export class LibraryAnalysisOwner implements LibraryChildOwner {
  private readonly scheduler:LibraryScheduler;
  private initialization?:Promise<unknown>;
  private metadataReady=false;
  private closed=false;
  private closing?:Promise<void>;
  private dirtyFlags=0;
  private dirtyWork?:Promise<void>;
  private statusPending=false;
  private unsubscribe?:()=>void;
  constructor(private readonly metadata:LibraryChildOwner,
    start:(ticket:LibraryMetricTicket,initial:LibrarySchedulerControl,signal:AbortSignal)=>LibraryScheduledWork,resumeDelayMs=150,
    private readonly options:{availableSlots?:readonly LibraryMetricSlot[];closeOwned?:()=>Promise<void>;
      statusChanged?:()=>void;
      nativeDemand?:(active:boolean)=>Promise<void>;
      nativeCapacity?:(capacity:1|2|4)=>void;
      preparation?:{stages:readonly LibraryPreparationStage[];start:LibrarySchedulerPreparations["start"]}}={}){
    this.scheduler=new LibraryScheduler({
      settings:()=>metadata.request("metric-settings") as Promise<LibraryAnalysisSettings>,
      nextQueued:(limit,includeNative)=>metadata.request("metric-next",{limit,includeNative,...(options.availableSlots?{availableSlots:options.availableSlots}:{})}) as Promise<LibraryMetricJob[]>,
      claim:jobId=>metadata.request("metric-claim",{jobId}) as Promise<LibraryMetricTicket|undefined>,
      commit:patch=>metadata.request("metric-commit",{patch}) as Promise<"applied"|"stale">,
      fail:(ticket,error)=>metadata.request("metric-fail",{ticket,error}) as Promise<"applied"|"stale">,
      release:ticket=>metadata.request("metric-release",{ticket}) as Promise<"applied"|"stale">,
    },start,resumeDelayMs,options.preparation?{
      nextQueued:(limit,beforeMetric,includeNative)=>{
        const availableStages=options.preparation?.stages.filter(stage=>includeNative!==false||stage!=="P")??[];
        return availableStages.length?metadata.request("preparation-next",{limit,availableStages,...(beforeMetric?{beforeMetric}:{})}) as Promise<LibraryPreparationRequest[]>:[];
      },
      claim:request=>metadata.request("preparation-claim",{replayId:request.replayId,stage:request.stage}) as Promise<LibraryPreparationTicket|undefined>,
      release:ticket=>metadata.request("preparation-release",{ticket}) as Promise<"applied"|"stale">,
      fail:(ticket,error)=>metadata.request("preparation-fail",{ticket,error}) as Promise<"applied"|"stale">,
      start:options.preparation.start,
    }:undefined,()=>this.publishStatus(),settings=>options.nativeCapacity?.(settings.fasterProcessing?settings.workers:1));
    this.unsubscribe=metadata.onAnalysisDirty?.(flags=>{this.dirtyFlags|=flags;this.flushDirty();});
  }
  private publishStatus():void {
    if(this.closed||this.statusPending||!this.options.statusChanged)return;
    this.statusPending=true;
    void Promise.resolve().then(()=>{this.statusPending=false;if(!this.closed)this.options.statusChanged?.();});
  }
  private flushDirty():void {
    if(!this.metadataReady||this.closed||this.dirtyWork||!this.dirtyFlags)return;
    this.dirtyWork=Promise.resolve().then(async()=>{
      while(this.dirtyFlags&&!this.closed){const flags=this.dirtyFlags;this.dirtyFlags=0;
        if(flags&2)await this.scheduler.refresh();
        if(flags&4)await this.scheduler.reconcileEligibility();
        this.scheduler.wake();
      }
    }).catch(error=>{if(!this.closed)this.scheduler.reportFault(error);}).finally(()=>{this.dirtyWork=undefined;if(this.dirtyFlags&&!this.closed)this.flushDirty();});
  }
  start():Promise<unknown>{
    if(this.closed)return Promise.reject(new Error("Library analysis owner is closed"));
    this.initialization??=(async()=>{
      const result=await this.metadata.start();this.metadataReady=true;
      if(this.closed)throw new Error("Library analysis owner is closed");
      await this.scheduler.refresh();this.flushDirty();return result;
    })();return this.initialization;
  }
  async request(method:LibraryOperation,args:Record<string,unknown>={},assertCurrent?:()=>void):Promise<unknown>{
    await this.start();if(this.closed)throw new Error("Library analysis owner is closed");
    assertCurrent?.();
    const result=await (assertCurrent?this.metadata.request(method,args,assertCurrent):this.metadata.request(method,args));
    if(method==="status"&&result&&typeof result==="object"){
      const status=result as LibraryStatus,activity=status.analysis;
      if(activity){
        const runtime=this.scheduler.status();
        let running=0,held=0,retiring=0;
        for(const item of runtime.active){
          if(item.retiring)retiring++;
          else if(item.viewerDemand||item.userPaused)held++;
          else running++;
        }
        return{...status,analysis:{...activity,running,held,retiring,mode:runtime.mode??activity.mode,
          userPaused:runtime.userPaused,viewerHold:runtime.viewerDemand,batteryHold:runtime.batteryHold,
          resumePending:runtime.resumePending,...(runtime.error?{error:runtime.error}:{})}};
      }
    }
    if(method==="source-enabled")await this.scheduler.reconcileEligibility();
    // Passive reads never admit work. Mutation callers own queue/settings refresh explicitly.
    if((method==="metric-settings"&&args.settings!==undefined)||["metric-request","preparation-request","preparation-commit","source-enabled"].includes(method))
      await this.scheduler.refresh();
    return result;
  }
  async setViewerDemand(active:boolean):Promise<void>{
    if(this.closed)throw new Error("Library analysis owner is closed");
    // Both admissions close synchronously, before either potentially delayed acknowledgement.
    await Promise.all([this.options.nativeDemand?.(active),this.scheduler.setViewerDemand(active),this.metadata.setViewerDemand(active)]);
  }
  setOnBattery(active:boolean):Promise<void>{return this.scheduler.setOnBattery(active);}
  status(){return this.scheduler.status();}
  settleAdmissions():Promise<void>{return this.scheduler.settleAdmissions();}
  close():Promise<void>{
    if(this.closing)return this.closing;this.closed=true;this.unsubscribe?.();this.dirtyFlags=0;
    const scheduling=this.scheduler.close();
    // Initial metadata acquisition must be interruptible; no jobs can have started before it resolves.
    const early=this.metadataReady?Promise.resolve():this.metadata.close();
    this.closing=(async()=>{
      const outcomes=await Promise.allSettled([scheduling,early,this.initialization,this.dirtyWork]);
      const metadata=await Promise.allSettled([this.metadata.close(),this.options.closeOwned?.()]);
      const failed=[...outcomes.slice(0,2),...metadata].find(item=>item.status==="rejected");
      if(failed?.status==="rejected")throw failed.reason;
    })();return this.closing;
  }
}
