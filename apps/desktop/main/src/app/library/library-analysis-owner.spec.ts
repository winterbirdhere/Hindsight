import { LibraryAnalysisOwner } from "./library-analysis-owner";
import type { LibraryChildOwner } from "./library-main-owner";
import type { LibraryMetricTicket, LibraryMetricResult, LibraryAnalysisSettings } from "../../../../shared/replay-library-metrics";
const ticket:LibraryMetricTicket={replayId:"r",slot:"numerical",stage:"S",inputKey:"a".repeat(64),producerVersion:"v1",generation:1,attempt:"a"};
function fixture(initial?:LibraryAnalysisSettings){
  let queued=true,notify:(flags:number)=>void=()=>undefined;const events:string[]=[],abort=new AbortController();let finish!:(value:LibraryMetricResult)=>void,fail!:(error:Error)=>void;
  let settings:LibraryAnalysisSettings=initial??{mode:"bg",workers:2,userPaused:false,pauseOnBattery:true};
  let failures=0;
  const statusChanged=jest.fn();
  const result=new Promise<LibraryMetricResult>((resolve,reject)=>{finish=resolve;fail=reject;});
  const metadata={start:jest.fn(async()=>({ready:true})),setViewerDemand:jest.fn(async()=>undefined),close:jest.fn(async()=>{events.push("metadata-close");}),
    onAnalysisDirty:jest.fn((listener:(flags:number)=>void)=>{notify=listener;return()=>{notify=()=>undefined;};}),
    request:jest.fn(async(method:string,args?:Record<string,unknown>):Promise<unknown>=>{
      events.push(method);if(method==="metric-settings"){if(args?.settings)settings=args.settings as LibraryAnalysisSettings;return settings;}
      if(method==="status")return{analysis:{unit:"work-items",queued:queued?1:0,awaitingInputs:0,deferred:0,failed:failures,running:0,held:0,retiring:0,...settings,viewerHold:false,batteryHold:false,resumePending:false}};
      if(method==="metric-fail")failures++;
      if(method==="metric-next")return queued?[{id:"job",target:ticket,reason:"background",state:"queued"}]:[];
      if(method==="metric-claim"){queued=false;return ticket;}
      return"applied";
    })};
  const start=jest.fn((_ticket:LibraryMetricTicket,_control:unknown,signal:AbortSignal)=>{
    signal.addEventListener("abort",()=>abort.abort(),{once:true});return{result,control:jest.fn(async()=>"parked" as const)};
  });
  const nativeCapacity=jest.fn();
  const options={statusChanged,nativeCapacity,availableSlots:undefined};
  const owner=new LibraryAnalysisOwner(metadata as LibraryChildOwner,start,0,options);
  return{owner,metadata,start,finish,fail,events,abort,statusChanged,nativeCapacity,notify:(flags:number)=>notify(flags),setQueued:(value:boolean)=>{queued=value;}};
}
const turn=()=>new Promise(resolve=>setTimeout(resolve,5));
it.each([1,2,4] as const)("restores Maximum native capacity %s and applies conservative changes without admitting work",async workers=>{
  const settings:LibraryAnalysisSettings={mode:"bg",workers,userPaused:false,pauseOnBattery:true,fasterProcessing:true};
  const f=fixture(settings);await f.owner.start();expect(f.nativeCapacity).toHaveBeenLastCalledWith(workers);
  await f.owner.request("metric-settings",{settings:{...settings,fasterProcessing:false}});
  expect(f.nativeCapacity).toHaveBeenLastCalledWith(1);expect(f.start).not.toHaveBeenCalled();
  await f.owner.request("metric-settings",{settings:{...settings,userPaused:true}});
  expect(f.nativeCapacity).toHaveBeenLastCalledWith(workers);expect(f.start).not.toHaveBeenCalled();await f.owner.close();
});
it("binds metadata queue and scheduler controls without making status a job trigger",async()=>{
  const f=fixture();await f.owner.start();await turn();expect(f.start).not.toHaveBeenCalled();
  await f.owner.setViewerDemand(false);await turn();await f.owner.settleAdmissions();expect(f.start).toHaveBeenCalledTimes(1);
  const before=f.events.filter(event=>event==="metric-settings").length;await f.owner.request("status");
  expect(f.events.filter(event=>event==="metric-settings")).toHaveLength(before);
  await f.owner.setViewerDemand(true);expect(f.start).toHaveBeenCalledTimes(1);
  f.finish({fields:{fc:{state:"known",value:true}},provenance:{}});await turn();expect(f.events).toContain("metric-commit");await f.owner.close();
});
it("keeps SQLite alive until cancelled analysis drains and releases its ticket",async()=>{
  const f=fixture();await f.owner.setViewerDemand(false);await f.owner.start();await turn();await f.owner.settleAdmissions();
  const closing=f.owner.close();await turn();expect(f.abort.signal.aborted).toBe(true);expect(f.metadata.close).not.toHaveBeenCalled();
  f.finish({fields:{},provenance:{}});await closing;
  expect(f.events.indexOf("metric-release")).toBeLessThan(f.events.indexOf("metadata-close"));
  await expect(f.owner.request("status")).rejects.toThrow(/closed/i);
});
it("wakes on asynchronous ingestion without turning queue events into settings polling",async()=>{
  const f=fixture();f.setQueued(false);await f.owner.setViewerDemand(false);await f.owner.start();await turn();await f.owner.settleAdmissions();
  const settings=f.events.filter(event=>event==="metric-settings").length;f.setQueued(true);f.notify(1);f.notify(1);await turn();await f.owner.settleAdmissions();
  expect(f.start).toHaveBeenCalledTimes(1);expect(f.events.filter(event=>event==="metric-settings")).toHaveLength(settings);
  f.finish({fields:{fc:{state:"known",value:true}},provenance:{}});await turn();await f.owner.close();f.notify(1);
});
it("publishes actual running, viewer/battery holds and completion through passive status",async()=>{
  const f=fixture();await f.owner.start();
  expect(await f.owner.request("status")).toMatchObject({analysis:{queued:1,running:0,viewerHold:true}});
  await f.owner.setViewerDemand(false);await turn();await f.owner.settleAdmissions();
  expect(await f.owner.request("status")).toMatchObject({analysis:{queued:0,running:1,held:0,viewerHold:false}});
  const changes=f.statusChanged.mock.calls.length;
  await f.owner.setViewerDemand(true);
  expect(await f.owner.request("status")).toMatchObject({analysis:{running:0,held:1,viewerHold:true}});
  expect(f.statusChanged.mock.calls.length).toBeGreaterThan(changes);
  await f.owner.setOnBattery(true);await f.owner.setViewerDemand(false);await turn();
  expect(await f.owner.request("status")).toMatchObject({analysis:{running:0,held:1,batteryHold:true}});
  f.finish({fields:{fc:{state:"known",value:true}},provenance:{}});await turn();
  expect(await f.owner.request("status")).toMatchObject({analysis:{running:0,held:0}});
  await f.owner.close();
});
it("reports user pause and Off retirement without presenting drained work as running",async()=>{
  const f=fixture();await f.owner.setViewerDemand(false);await f.owner.start();await turn();await f.owner.settleAdmissions();
  await f.owner.request("metric-settings",{settings:{mode:"bg",workers:2,userPaused:true,pauseOnBattery:true}});
  expect(await f.owner.request("status")).toMatchObject({analysis:{running:0,held:1,userPaused:true}});
  await f.owner.request("metric-settings",{settings:{mode:"off",workers:2,userPaused:false,pauseOnBattery:true}});
  expect(await f.owner.request("status")).toMatchObject({analysis:{mode:"off",running:0,held:0,retiring:1}});
  f.finish({fields:{},provenance:{}});await turn();
  expect(await f.owner.request("status")).toMatchObject({analysis:{retiring:0,running:0}});
  await f.owner.close();
});
it("publishes terminal failure after the owned execution drains",async()=>{
  const f=fixture();await f.owner.setViewerDemand(false);await f.owner.start();await turn();await f.owner.settleAdmissions();
  expect(await f.owner.request("status")).toMatchObject({analysis:{running:1,failed:0}});
  const changes=f.statusChanged.mock.calls.length;
  f.fail(new Error("Exact beatmap unavailable"));await turn();
  expect(await f.owner.request("status")).toMatchObject({analysis:{running:0,failed:1}});
  expect(f.statusChanged.mock.calls.length).toBeGreaterThan(changes);
  await f.owner.close();
});
