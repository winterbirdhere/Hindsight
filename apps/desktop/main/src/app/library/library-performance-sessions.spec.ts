import { LibraryResourceSessions } from "./library-resource-sessions";
import { LibraryNativeDrainError } from "./library-native-admission";
import type { LibraryOpenLocation } from "./library-store";
import type { PerformanceRequest,PerformanceResponse } from "@rewind/osu-performance/protocol";
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const ticket={replayId:"r",sourceId:"s",sourceKey:"k",locator:"missing",kind:"stable",directory:"D:\\source",sha256:null,
  locationRevision:1,sourceConfigRevision:0,metadata:{}} as LibraryOpenLocation;
const resource={location:ticket,map:{text:"map",sha256:"a".repeat(64),md5:"b".repeat(32)},metadata:{ruleset:0,baseBpm:null}};
const calculation:PerformanceRequest["calculations"]=[{mode:"stable",scope:"full-map",mods:[],states:[]}];
const dependencies=()=>({prepareReplay:jest.fn(),prepareMap:jest.fn(),preparePerformanceMap:jest.fn(async()=>resource),
  preparePerformanceScore:jest.fn(async()=>({origin:null,nativeRequired:false} as const)),
  calculatePerformance:jest.fn(async(_request:PerformanceRequest,_signal:AbortSignal):Promise<PerformanceResponse>=>({ok:true,timelines:[]}))});
it("owns exact map-only resources and native phases without invoking replay or media preparation",async()=>{
  const deps=dependencies(),sessions=new LibraryResourceSessions(deps,{background:true});await sessions.control({viewerDemand:false,userPaused:false});
  expect(await sessions.beginPerformance("p",ticket)).toMatchObject({md5:resource.map.md5,sha256:resource.map.sha256,bytes:3});
  expect(await sessions.calculatePerformance("p",calculation)).toEqual({ok:true,timelines:[]});
  expect(deps.calculatePerformance).toHaveBeenCalledWith({beatmap:"map",calculations:calculation},expect.any(AbortSignal));
  expect(deps.prepareReplay).not.toHaveBeenCalled();expect(deps.prepareMap).not.toHaveBeenCalled();
  expect(await sessions.readPerformanceScore("p")).toEqual({origin:null,nativeRequired:false});
  expect(await sessions.readPerformanceScore("p")).toEqual({origin:null,nativeRequired:false});
  expect(deps.preparePerformanceScore).toHaveBeenCalledTimes(1);
  expect(deps.preparePerformanceScore).toHaveBeenCalledWith(ticket,expect.any(AbortSignal),expect.any(Function));
  await expect(sessions.openTransfer("p","replay")).rejects.toThrow(/not prepared/);await sessions.close();
});
it("holds the continuation after a completed native result and resumes without recalculation",async()=>{
  const deps=dependencies();let finish!:(value:PerformanceResponse)=>void,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  deps.calculatePerformance.mockImplementation(()=>new Promise(resolve=>{finish=resolve;started();}));
  const sessions=new LibraryResourceSessions(deps,{background:true});await sessions.control({viewerDemand:false,userPaused:false});await sessions.beginPerformance("p",ticket);
  let ended=false;const result=sessions.calculatePerformance("p",calculation).then(value=>{ended=true;return value;});await ready;
  const hold=sessions.control({viewerDemand:true,userPaused:false});finish({ok:true,timelines:[]});expect(await hold).toBe("parked");
  expect(ended).toBe(false);await sessions.control({viewerDemand:false,userPaused:false});await result;
  expect(deps.calculatePerformance).toHaveBeenCalledTimes(1);await sessions.close();
});
it("close waits native operation drainage and propagates uncertain helper exit",async()=>{
  const deps=dependencies();let fail!:(error:Error)=>void,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  deps.calculatePerformance.mockImplementation(()=>new Promise((_,reject)=>{fail=reject;started();}));
  const sessions=new LibraryResourceSessions(deps,{background:true});await sessions.control({viewerDemand:false,userPaused:false});await sessions.beginPerformance("p",ticket);
  const result=sessions.calculatePerformance("p",calculation),failed=expect(result).rejects.toThrow(/uncertain/);await ready;
  let closed=false;const closing=sessions.close().finally(()=>{closed=true;}),closeFailed=expect(closing).rejects.toThrow(/uncertain/);
  await tick();expect(closed).toBe(false);fail(new LibraryNativeDrainError("uncertain helper exit"));await failed;await closeFailed;
});
it("does not expose P work through foreground resources or accept a timeline request",async()=>{
  const deps=dependencies(),foreground=new LibraryResourceSessions(deps);await expect(foreground.beginPerformance("p",ticket)).rejects.toThrow(/background/);
  const sessions=new LibraryResourceSessions(deps,{background:true});await sessions.control({viewerDemand:false,userPaused:false});await sessions.beginPerformance("p",ticket);
  await expect(sessions.calculatePerformance("p",[{mode:"stable",mods:[],states:[]}])).rejects.toThrow(/full-map/);
  expect(deps.calculatePerformance).not.toHaveBeenCalled();await sessions.close();await foreground.close();
});
it("reads an exact imported score candidate independently of a source-only map location",async()=>{
  const deps=dependencies(),sessions=new LibraryResourceSessions(deps,{background:true});await sessions.control({viewerDemand:false,userPaused:false});await sessions.beginPerformance("p",ticket);
  const candidate:LibraryOpenLocation={...ticket,sourceId:"imports",sourceKey:"c".repeat(64),kind:"imported",sha256:"c".repeat(64),
    locator:"D:/fixture/copy.osr",metadata:{header:{beatmapMD5:resource.map.md5}}};
  await sessions.readPerformanceScore("p",candidate);await sessions.readPerformanceScore("p",candidate);
  expect(deps.preparePerformanceScore).toHaveBeenCalledTimes(1);expect(deps.preparePerformanceScore).toHaveBeenCalledWith(candidate,expect.any(AbortSignal),expect.any(Function));
  await expect(sessions.readPerformanceScore("p",{...candidate,replayId:"other"})).rejects.toThrow(/identity/i);
  await expect(sessions.readPerformanceScore("p",{...candidate,metadata:{header:{beatmapMD5:"f".repeat(32)}}})).rejects.toThrow(/identity/i);
  await sessions.close();
});
