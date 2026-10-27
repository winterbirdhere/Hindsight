import { LibraryScheduler, LibraryScheduledWork, LibrarySchedulerPreparations } from "./library-scheduler";
import type { LibraryAnalysisSettings, LibraryMetricJob, LibraryMetricTicket } from "../../../../shared/replay-library-metrics";
import type { LibraryPreparationRequest, LibraryPreparationTicket } from "./library-preparation-store";
import { LibraryHandoffFinalizationError } from "./library-numerical-preparation";
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
it("admits one P preparation at a time while independent S work can use the next slot",async()=>{
  const pending:LibraryPreparationRequest[]=["p1","p2","s"].map((replayId,index)=>({replayId,stage:index===2?"S":"P",dependencyKey:"a".repeat(64),generation:1,reason:"background",state:"queued"}));
  const finishes=new Map<string,()=>void>(),started:string[]=[];
  const preparations:LibrarySchedulerPreparations={nextQueued:(_limit,_before,includeNative)=>pending.filter(item=>includeNative!==false||item.stage!=="P").slice(0,1),
    claim:request=>{pending.splice(pending.indexOf(request),1);return{...request,attempt:request.replayId};},release:()=>"applied",fail:()=>"stale",
    start:ticket=>{started.push(ticket.replayId);return{control:async()=>"parked",result:new Promise<void>(resolve=>{finishes.set(ticket.replayId,resolve);})};}};
  const scheduler=new LibraryScheduler({settings:()=>({mode:"bg",workers:2,userPaused:false,pauseOnBattery:true}),nextQueued:()=>[],claim:()=>undefined,
    commit:()=>"stale",fail:()=>"stale",release:()=>"stale"},jest.fn(),0,preparations);
  try{
    await scheduler.refresh();await scheduler.setViewerDemand(false);await turn();await scheduler.settleAdmissions();
    expect(started).toEqual(["p1","s"]);finishes.get("p1")?.();await turn();await scheduler.settleAdmissions();expect(started).toEqual(["p1","s","p2"]);
  }finally{const closing=scheduler.close();finishes.forEach(finish=>finish());await closing;}
});
it("counts preparation and metrics together, parks overflow, and drains before releasing preparation",async()=>{
  let settings:LibraryAnalysisSettings={mode:"bg",workers:2,userPaused:false,pauseOnBattery:true};
  const metric:LibraryMetricTicket={replayId:"metric",slot:"numerical",stage:"S",inputKey:"key",producerVersion:"v1",generation:1,attempt:"metric"};
  let metricQueued=true,sequence=0;const controls:jest.Mock[]=[],aborts:AbortSignal[]=[],drains:(()=>void)[]=[],release=jest.fn(async()=>"applied" as const);
  const work=(signal:AbortSignal):LibraryScheduledWork=>{
    const control=jest.fn(async()=>"parked" as const);controls.push(control);aborts.push(signal);
    return{control,result:new Promise((resolve)=>{drains.push(()=>resolve({fields:{fc:{state:"known",value:true}},provenance:{}}));})};
  };
  const preparation:LibraryPreparationRequest={replayId:"prep",stage:"S",dependencyKey:"a".repeat(64),generation:1,reason:"background",state:"queued"};
  const prepare:LibrarySchedulerPreparations={nextQueued:async(_limit,before)=>!before&&sequence<3?[preparation]:[],claim:async()=>({...preparation,attempt:"prep"+(++sequence)}),release,
    fail:jest.fn(async()=>"applied" as const),start:(_ticket,_initial,signal)=>{const task=work(signal);return{...task,result:task.result.then(()=>undefined)};}};
  const scheduler=new LibraryScheduler({settings:()=>settings,nextQueued:()=>metricQueued?[{id:"metric",target:metric,reason:"selection",state:"queued"} as LibraryMetricJob]:[],
    claim:async()=>{metricQueued=false;return metric;},commit:async()=>"applied" as const,fail:async()=>"applied" as const,release:async()=>"applied" as const},
    (_ticket,_initial,signal)=>work(signal),0,prepare);
  try{
    await scheduler.refresh();await scheduler.setViewerDemand(false);await turn();await scheduler.settleAdmissions();
    expect(scheduler.status().active).toHaveLength(2);expect(sequence).toBe(1);
    settings={...settings,workers:1};await scheduler.refresh();expect(controls[1]).toHaveBeenLastCalledWith({viewerDemand:true,userPaused:false});
    expect(aborts.every(signal=>!signal.aborted)).toBe(true);
    const closing=scheduler.close();await turn();expect(release).not.toHaveBeenCalled();expect(aborts.every(signal=>signal.aborted)).toBe(true);
    drains.forEach(resolve=>resolve());await closing;expect(release).toHaveBeenCalledTimes(1);
  }finally{drains.forEach(resolve=>resolve());await scheduler.close();}
});
it("releases a late preparation claim without starting work after Off",async()=>{
  let settings:LibraryAnalysisSettings={mode:"bg",workers:1,userPaused:false,pauseOnBattery:true},claimed!:(ticket:LibraryPreparationTicket)=>void;
  const request:LibraryPreparationRequest={replayId:"prep",stage:"S",dependencyKey:"a".repeat(64),generation:1,reason:"background",state:"queued"};
  const prepare:LibrarySchedulerPreparations={nextQueued:async()=>settings.mode==="off"?[]:[request],claim:()=>new Promise(resolve=>{claimed=resolve;}),
    release:jest.fn(async()=>"stale" as const),fail:jest.fn(async()=>"stale" as const),start:jest.fn()};
  const scheduler=new LibraryScheduler({settings:()=>settings,nextQueued:()=>[],claim:async()=>undefined,
    commit:async()=>"applied" as const,fail:async()=>"applied" as const,release:async()=>"applied" as const},jest.fn(),0,prepare);
  await scheduler.refresh();await scheduler.setViewerDemand(false);await turn();settings={...settings,mode:"off"};await scheduler.refresh();
  claimed({...request,attempt:"late"});await scheduler.settleAdmissions();expect(prepare.start).not.toHaveBeenCalled();expect(prepare.release).toHaveBeenCalledTimes(1);await scheduler.close();
});
it("surfaces handoff finalization failure without swallowing it as a stale preparation failure",async()=>{
  const request:LibraryPreparationRequest={replayId:"prep",stage:"S",dependencyKey:"a".repeat(64),generation:1,reason:"background",state:"queued"};let claimed=false;
  const preparations:LibrarySchedulerPreparations={nextQueued:()=>claimed?[]:[request],claim:()=>{claimed=true;return{...request,attempt:"claimed"};},
    release:async()=>"stale" as const,fail:jest.fn(async()=>"stale" as const),start:()=>({result:Promise.reject(new LibraryHandoffFinalizationError(new Error("SQLite gone"))),control:async()=>"idle"})};
  const scheduler=new LibraryScheduler({settings:()=>({mode:"bg",workers:1,userPaused:false,pauseOnBattery:true}),nextQueued:()=>[],claim:()=>undefined,
    commit:()=>"stale",fail:()=>"stale",release:()=>"stale"},jest.fn(),0,preparations);
  await scheduler.refresh();await scheduler.setViewerDemand(false);await turn();await scheduler.settleAdmissions();await turn();
  expect(scheduler.status().error).toContain("SQLite gone");expect(preparations.fail).not.toHaveBeenCalled();await expect(scheduler.close()).rejects.toThrow("SQLite gone");
});
it("retires an invalid lease once, waits for drainage, then releases instead of failing",async()=>{
  let queued=true,valid=true,finish!:(value:void)=>void,signal:AbortSignal|undefined;
  const request:LibraryPreparationRequest={replayId:"prep",stage:"S",dependencyKey:"a".repeat(64),generation:1,reason:"background",state:"queued"};
  const prepare:LibrarySchedulerPreparations={nextQueued:()=>queued?[request]:[],claim:()=>{queued=false;return{...request,attempt:"owned"};},
    release:jest.fn(async()=>"applied" as const),fail:jest.fn(async()=>"applied" as const),start:(_ticket,_control,owned)=>{
      signal=owned;return{result:new Promise<void>(resolve=>{finish=resolve;}),control:async()=>"parked",eligible:async()=>valid};}};
  const scheduler=new LibraryScheduler({settings:()=>({mode:"bg",workers:1,userPaused:false,pauseOnBattery:true}),nextQueued:()=>[],claim:()=>undefined,
    commit:()=>"stale",fail:()=>"stale",release:()=>"stale"},jest.fn(),0,prepare);
  await scheduler.refresh();await scheduler.setViewerDemand(false);await turn();await scheduler.settleAdmissions();valid=false;
  await scheduler.reconcileEligibility();expect(signal?.aborted).toBe(true);expect(prepare.release).not.toHaveBeenCalled();expect(prepare.fail).not.toHaveBeenCalled();
  finish();await turn();expect(prepare.release).toHaveBeenCalledTimes(1);expect(prepare.fail).not.toHaveBeenCalled();await scheduler.close();
});
it("keeps shutdown pending until an outstanding eligibility read settles",async()=>{
  let queued=true,finish!:()=>void,read!:(value:boolean)=>void;
  const request:LibraryPreparationRequest={replayId:"prep",stage:"S",dependencyKey:"a".repeat(64),generation:1,reason:"background",state:"queued"};
  const prepare:LibrarySchedulerPreparations={nextQueued:()=>queued?[request]:[],claim:()=>{queued=false;return{...request,attempt:"owned"};},
    release:async()=>"applied" as const,fail:async()=>"stale" as const,start:()=>({result:new Promise<void>(resolve=>{finish=resolve;}),control:async()=>"parked",
      eligible:()=>new Promise<boolean>(resolve=>{read=resolve;})})};
  const scheduler=new LibraryScheduler({settings:()=>({mode:"bg",workers:1,userPaused:false,pauseOnBattery:true}),nextQueued:()=>[],claim:()=>undefined,
    commit:()=>"stale",fail:()=>"stale",release:()=>"stale"},jest.fn(),0,prepare);
  await scheduler.refresh();await scheduler.setViewerDemand(false);await turn();await scheduler.settleAdmissions();
  const checking=scheduler.reconcileEligibility();let closed=false;
  const closing=scheduler.close().then(()=>{closed=true;});finish();await turn();
  try{expect(closed).toBe(false);}finally{read(true);await checking;await closing;}
  expect(closed).toBe(true);
});
