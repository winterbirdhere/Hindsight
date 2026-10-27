import { deserialize, serialize } from "v8";
import { createHash, webcrypto } from "crypto";
import { TextDecoder, TextEncoder } from "util";
import { buildBeatmap, parseBlueprint, parseReplayFramesWithDiagnostics } from "@osujs/core";
import type { LibraryMetricTicket } from "../../../../../shared/replay-library-metrics";
import { traceMapText } from "../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { runLibraryNumerical } from "./library-numerical";
import { LibraryAnalysisWorkerServer, LibraryAnalysisResponse } from "./library-analysis-worker";
import { PERFORMANCE_ENGINE_VERSION,PerformanceRequest,PerformanceResponse } from "@rewind/osu-performance/protocol";
import { setImmediate as yieldImmediate } from "timers/promises";

Object.assign(globalThis, { TextDecoder, TextEncoder });
Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });

const ticket:LibraryMetricTicket={replayId:"fixture",slot:"numerical",stage:"S",inputKey:"a".repeat(64),producerVersion:"test-v1",generation:1,attempt:"first-attempt"};
function request(requestId=1) {
  const beatmap=buildBeatmap(parseBlueprint(traceMapText("300,192,1000,1,0")),{mods:[],addStacking:false});
  const parsed=parseReplayFramesWithDiagnostics("0|256|-500|0,0|256|-500|0,0|300|192|0,1000|300|192|5,100|300|192|0,");
  return deserialize(serialize({version:1,type:"run",requestId,ticket,input:{beatmap,hitObjectKinds:beatmap.hitObjects.map(o=>o.type),
    replay:{md5hash:"fixture",beatmapMd5:"c".repeat(32),player:"test",gameVersion:20200101,mods:[],frames:parsed.frames,parseDiagnostics:parsed.diagnostics},
    binding:{exactMapAndProfile:true,replaySha256:"b".repeat(64),mapSha256:"d".repeat(64),mapMd5:"c".repeat(32)}}}));
}

it("preserves the hold acknowledgement boundary with an injected asynchronous yield",async()=>{
  const responses:LibraryAnalysisResponse[]=[],runner=jest.fn(runLibraryNumerical);let release!:()=>void,turns=0;
  const yieldTurn=()=>++turns===1?new Promise<void>(resolve=>{release=resolve;}):yieldImmediate();
  const server=new LibraryAnalysisWorkerServer(r=>responses.push(r),runner,undefined,yieldTurn);
  const work=server.receive(request());expect(turns).toBe(1);
  const held=server.receive({version:1,type:"control",sequence:1,viewerDemand:true,userPaused:false});
  await Promise.resolve();expect(responses).toHaveLength(0);expect(runner).not.toHaveBeenCalled();
  release();await held;
  expect(responses).toContainEqual(expect.objectContaining({type:"control",state:"parked"}));expect(runner).not.toHaveBeenCalled();
  await server.receive({version:1,type:"control",sequence:2,viewerDemand:false,userPaused:false});await work;
  expect(turns).toBeGreaterThan(1);expect(runner).toHaveBeenCalledTimes(1);
  expect(responses.at(-1)).toMatchObject({type:"result",status:"complete"});
});

it("observes cancellation after an injected yield before numerical work can begin",async()=>{
  const responses:LibraryAnalysisResponse[]=[],runner=jest.fn(runLibraryNumerical);let release!:()=>void;
  const server=new LibraryAnalysisWorkerServer(r=>responses.push(r),runner,undefined,()=>new Promise<void>(resolve=>{release=resolve;}));
  const work=server.receive(request());await server.receive({version:1,type:"cancel",requestId:1});
  expect(responses).toHaveLength(0);release();await work;
  expect(runner).not.toHaveBeenCalled();expect(responses.at(-1)).toMatchObject({type:"result",status:"cancelled"});
});

it("switches yielding only on a valid newer control while preserving Pause and viewer parking",async()=>{
  const responses:LibraryAnalysisResponse[]=[],policies:boolean[]=[],runner=jest.fn(runLibraryNumerical);let release!:()=>void;
  const server=new LibraryAnalysisWorkerServer(r=>responses.push(r),runner,undefined,faster=>{
    policies.push(faster);return policies.length===1?new Promise<void>(resolve=>{release=resolve;}):yieldImmediate();
  });
  await server.receive({version:1,type:"control",sequence:1,viewerDemand:false,userPaused:false,fasterProcessing:true});
  const work=server.receive(request());expect(policies).toEqual([true]);
  const held=server.receive({version:1,type:"control",sequence:2,viewerDemand:true,userPaused:true,fasterProcessing:false});
  release();await held;expect(runner).not.toHaveBeenCalled();
  await server.receive({version:1,type:"control",sequence:1,viewerDemand:false,userPaused:false,fasterProcessing:true});
  await server.receive({version:1,type:"control",sequence:3,viewerDemand:false,userPaused:false,fasterProcessing:"yes"});
  expect(runner).not.toHaveBeenCalled();expect(responses.filter(r=>r.type==="control")).toHaveLength(2);
  await server.receive({version:1,type:"control",sequence:3,viewerDemand:false,userPaused:false,fasterProcessing:false});await work;
  expect(policies.length).toBeGreaterThan(1);expect(policies.slice(1).every(value=>value===false)).toBe(true);
  expect(runner).toHaveBeenCalledTimes(1);expect(responses.at(-1)).toMatchObject({type:"result",status:"complete"});
});

it("cancels the same parked continuation after switching into faster processing",async()=>{
  const responses:LibraryAnalysisResponse[]=[],runner=jest.fn(runLibraryNumerical),server=new LibraryAnalysisWorkerServer(r=>responses.push(r),runner,undefined,()=>yieldImmediate());
  await server.receive({version:1,type:"control",sequence:1,viewerDemand:false,userPaused:true});
  const work=server.receive(request());await server.receive({version:1,type:"control",sequence:2,viewerDemand:false,userPaused:true,fasterProcessing:true});
  expect(runner).not.toHaveBeenCalled();await server.receive({version:1,type:"cancel",requestId:1});await work;
  expect(runner).not.toHaveBeenCalled();expect(responses.at(-1)).toMatchObject({type:"result",status:"cancelled"});
});

it("parks one owned numerical invocation and publishes only compact metrics after resume",async()=>{
  const responses:LibraryAnalysisResponse[]=[],runner=jest.fn(runLibraryNumerical),server=new LibraryAnalysisWorkerServer(r=>responses.push(r),runner);
  await server.receive({version:1,type:"control",sequence:1,viewerDemand:true,userPaused:false});
  const work=server.receive(request());
  await server.receive({version:1,type:"control",sequence:2,viewerDemand:true,userPaused:false});
  expect(responses).toContainEqual(expect.objectContaining({type:"control",sequence:2,state:"parked",requestId:1}));expect(runner).not.toHaveBeenCalled();
  await server.receive({version:1,type:"control",sequence:3,viewerDemand:false,userPaused:false});await work;
  expect(runner).toHaveBeenCalledTimes(1);
  const result=responses.find(r=>r.type==="result");expect(result).toMatchObject({type:"result",requestId:1,ticket,status:"complete",metrics:{fields:{fc:{value:true}}}});
  expect(result).not.toHaveProperty("state");expect(result).not.toHaveProperty("scoring");expect(result).not.toHaveProperty("frames");
});

it("ignores stale controls, rejects overlap, and cancels only the matching owned request",async()=>{
  const responses:LibraryAnalysisResponse[]=[],server=new LibraryAnalysisWorkerServer(r=>responses.push(r));
  await server.receive({version:1,type:"control",sequence:1,viewerDemand:false,userPaused:true});
  const work=server.receive(request());await server.receive({version:1,type:"control",sequence:2,viewerDemand:false,userPaused:true});
  await server.receive({version:1,type:"control",sequence:1,viewerDemand:false,userPaused:false});
  await server.receive(request(2));expect(responses).toContainEqual(expect.objectContaining({requestId:2,type:"result",status:"error"}));
  await server.receive({version:1,type:"cancel",requestId:2});
  expect(responses.filter(r=>r.type==="result"&&r.requestId===1)).toHaveLength(0);
  await server.receive({version:1,type:"cancel",requestId:1});await work;
  expect(responses).toContainEqual(expect.objectContaining({requestId:1,type:"result",status:"cancelled"}));
  await server.receive({version:1,type:"control",sequence:3,viewerDemand:false,userPaused:false});await server.receive(request(3));
  expect(responses).toContainEqual(expect.objectContaining({requestId:3,type:"result",status:"complete"}));
});

it("rejects invalid tickets before hydration or numerical work",async()=>{
  const responses:LibraryAnalysisResponse[]=[],runner=jest.fn(runLibraryNumerical),server=new LibraryAnalysisWorkerServer(r=>responses.push(r),runner);
  const invalid=request();invalid.ticket.generation=0;await server.receive(invalid);
  expect(runner).not.toHaveBeenCalled();expect(responses).toContainEqual(expect.objectContaining({type:"result",status:"error"}));
});

it("accepts the durable store's full bounded input-key contract",async()=>{
  const responses:LibraryAnalysisResponse[]=[],server=new LibraryAnalysisWorkerServer(r=>responses.push(r));
  const valid=request();valid.ticket.inputKey="x".repeat(512);await server.receive(valid);
  expect(responses).toContainEqual(expect.objectContaining({type:"result",status:"complete"}));
});

function streamRequest() {
  const bytes = {
    map: new Uint8Array(Buffer.from(traceMapText("300,192,1000,1,0"))),
    replay: new Uint8Array(Buffer.from(JSON.stringify({ gameMode:0,gameVersion:20200101,beatmapMD5:"c".repeat(32),replayContentSha256:"b".repeat(64),
      replayMD5:"fixture",playerName:"Fixture",number_300s:1,number_100s:0,number_50s:0,misses:0,score:300,max_combo:1,perfect_combo:1,mods:0,life_bar:"",
      replay_data:"0|256|-500|0,0|256|-500|0,0|300|192|0,1000|300|192|5,100|300|192|0," }))),
  };
  return {bytes,request:{version:1,type:"run",requestId:1,ticket,input:{format:"resources",replayBytes:bytes.replay.length,mapBytes:bytes.map.length,
    binding:{replaySha256:"b".repeat(64),mapMd5:"c".repeat(32),mapSha256:createHash("sha256").update(bytes.map).digest("hex"),exactMapAndProfile:true}}}};
}
it("publishes numerical first, parks the retained state, then builds one timeline without resimulation",async()=>{
  const f=streamRequest(),responses:LibraryAnalysisResponse[]=[],runner=jest.fn(runLibraryNumerical);
  let published!:()=>void;const publication=new Promise<void>(resolve=>{published=resolve;});
  const calculate=jest.fn(async(request:PerformanceRequest):Promise<PerformanceResponse>=>({ok:true,engineVersion:PERFORMANCE_ENGINE_VERSION,
    timelines:[{mode:request.calculations[0].mode,objectCount:1,endpointVerified:true,difficultyPoints:[],
      points:request.calculations[0].states.map(state=>({time:state.time,pp:10,sr:1})),final:{pp:10,sr:1}}]}));
  const server=new LibraryAnalysisWorkerServer(response=>{
    responses.push(response);
    if(response.type==="read"){const all=f.bytes[response.kind];void server.receive({version:1,type:"chunk",requestId:1,readId:response.readId,chunk:{bytes:all,done:true}});}
    if(response.type==="numerical")published();
  },runner,calculate);
  const work=server.receive({...f.request,timeline:true});await publication;expect(calculate).not.toHaveBeenCalled();
  await server.receive({version:1,type:"control",sequence:1,viewerDemand:true,userPaused:false});
  await server.receive({version:1,type:"continue",requestId:1,timeline:true});await Promise.resolve();expect(calculate).not.toHaveBeenCalled();
  await server.receive({version:1,type:"control",sequence:2,viewerDemand:false,userPaused:false});await work;
  expect(runner).toHaveBeenCalledTimes(1);expect(calculate).toHaveBeenCalledTimes(1);
  expect(responses.at(-1)).toMatchObject({type:"result",status:"complete",metrics:{fields:{peakPp:{state:"known",value:10}}}});
  expect(calculate.mock.calls[0][0].beatmap).toBe(Buffer.from(f.bytes.map).toString("utf8"));
  expect(JSON.stringify(responses.filter(r=>r.type!=="read"))).not.toMatch(/"frames"|"states"|"beatmap"/);
});
it("cancels native work with its owner signal and waits for that operation's drain",async()=>{
  const f=streamRequest(),responses:LibraryAnalysisResponse[]=[];let began!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;});let sawAbort=false;
  const calculate=jest.fn((_request:PerformanceRequest,signal:AbortSignal)=>new Promise<PerformanceResponse>((_resolve,reject)=>{
    signal.addEventListener("abort",()=>{sawAbort=true;release=()=>reject(signal.reason);},{once:true});began();
  }));
  const server=new LibraryAnalysisWorkerServer(response=>{
    responses.push(response);
    if(response.type==="read"){const all=f.bytes[response.kind];void server.receive({version:1,type:"chunk",requestId:1,readId:response.readId,chunk:{bytes:all,done:true}});}
    if(response.type==="numerical")void server.receive({version:1,type:"continue",requestId:1,timeline:true});
  },runLibraryNumerical,calculate);
  const work=server.receive({...f.request,timeline:true});await started;await server.receive({version:1,type:"cancel",requestId:1});
  expect(sawAbort).toBe(true);expect(responses.some(r=>r.type==="result")).toBe(false);release();await work;
  expect(responses.at(-1)).toMatchObject({type:"result",status:"cancelled"});
});
it.each([false,true])("retains one simulation across timeline and compact FC, timelineFailed=%s",async failed=>{
  const f=streamRequest(),responses:LibraryAnalysisResponse[]=[],runner=jest.fn(runLibraryNumerical);
  const calculate=jest.fn(async(request:PerformanceRequest):Promise<PerformanceResponse>=>{
    const calculation=request.calculations[0];if(failed&&calculation.scope!=="full-map")throw Error("timeline too large");
    return{ok:true,engineVersion:PERFORMANCE_ENGINE_VERSION,timelines:[{mode:calculation.mode,objectCount:1,endpointVerified:true,
      difficultyPoints:[],points:calculation.states.map(state=>({time:state.time,pp:10,sr:1})),final:{pp:10,sr:1}}]};
  });
  const server=new LibraryAnalysisWorkerServer(response=>{
    responses.push(response);
    if(response.type==="read"){const bytes=f.bytes[response.kind];void server.receive({version:1,type:"chunk",requestId:1,readId:response.readId,chunk:{bytes,done:true}});}
    if(response.type==="numerical")void server.receive({version:1,type:"continue",requestId:1,timeline:true});
    if(response.type==="timeline")void server.receive({version:1,type:"continue",requestId:1,timeline:"fc"});
  },runner,calculate);
  await server.receive({...f.request,timeline:true,fc:true});expect(runner).toHaveBeenCalledTimes(1);expect(calculate).toHaveBeenCalledTimes(2);
  expect(calculate.mock.calls[1][0].calculations[0]).toMatchObject({scope:"full-map",states:[{passedObjects:1}]});
  expect(responses.find(r=>r.type==="timeline")).toMatchObject({outcome:failed?{error:"timeline too large"}:{metrics:{fields:{peakPp:{value:10}}}}});
  expect(responses.at(-1)).toMatchObject({type:"result",status:"complete",metrics:{fields:{ppIfFc:{state:"known",value:10}}}});
});
it("stops the continuation on uncertain native ownership",async()=>{
  const f=streamRequest(),responses:LibraryAnalysisResponse[]=[],calculate=jest.fn(async()=>{throw Object.assign(Error("unconfirmed helper exit"),{libraryNativeOwnershipUncertain:true});});
  const server=new LibraryAnalysisWorkerServer(response=>{
    responses.push(response);if(response.type==="read"){const bytes=f.bytes[response.kind];void server.receive({version:1,type:"chunk",requestId:1,readId:response.readId,chunk:{bytes,done:true}});}
    if(response.type==="numerical")void server.receive({version:1,type:"continue",requestId:1,timeline:true});
  },runLibraryNumerical,calculate);
  await server.receive({...f.request,timeline:true,fc:true});expect(calculate).toHaveBeenCalledTimes(1);
  expect(responses.some(r=>r.type==="timeline")).toBe(false);expect(responses.at(-1)).toMatchObject({status:"error",error:"unconfirmed helper exit"});
});
it("skips a cached timeline and calculates only compact FC from the retained simulation",async()=>{
  const f=streamRequest(),responses:LibraryAnalysisResponse[]=[],runner=jest.fn(runLibraryNumerical);
  const calculate=jest.fn(async(request:PerformanceRequest):Promise<PerformanceResponse>=>{
    const calculation=request.calculations[0];return{ok:true,engineVersion:PERFORMANCE_ENGINE_VERSION,timelines:[{mode:calculation.mode,
      objectCount:1,endpointVerified:true,difficultyPoints:[],points:[{time:calculation.states[0].time,pp:0,sr:1}],final:{pp:0,sr:1}}]};
  });
  const server=new LibraryAnalysisWorkerServer(response=>{
    responses.push(response);if(response.type==="read"){const bytes=f.bytes[response.kind];void server.receive({version:1,type:"chunk",requestId:1,readId:response.readId,chunk:{bytes,done:true}});}
    if(response.type==="numerical")void server.receive({version:1,type:"continue",requestId:1,timeline:"fc"});
  },runner,calculate);
  await server.receive({...f.request,timeline:true,fc:true});expect(runner).toHaveBeenCalledTimes(1);expect(calculate).toHaveBeenCalledTimes(1);
  expect(calculate.mock.calls[0][0].calculations[0]).toMatchObject({scope:"full-map",states:[{passedObjects:1}]});
  expect(responses.some(r=>r.type==="timeline")).toBe(false);
  expect(responses.at(-1)).toMatchObject({status:"complete",metrics:{fields:{ppIfFc:{state:"known",value:0}}}});
});
it("publishes terminal FC failure after ordinary native failures without repeating simulation",async()=>{
  const f=streamRequest(),responses:LibraryAnalysisResponse[]=[],runner=jest.fn(runLibraryNumerical);
  const calculate=jest.fn(async()=>{throw Error("native calculation unavailable");});
  const server=new LibraryAnalysisWorkerServer(response=>{
    responses.push(response);if(response.type==="read"){const bytes=f.bytes[response.kind];void server.receive({version:1,type:"chunk",requestId:1,readId:response.readId,chunk:{bytes,done:true}});}
    if(response.type==="numerical")void server.receive({version:1,type:"continue",requestId:1,timeline:true});
    if(response.type==="timeline")void server.receive({version:1,type:"continue",requestId:1,timeline:"fc"});
    if(response.type==="fc")void server.receive({version:1,type:"continue",requestId:1,timeline:false});
  },runner,calculate);
  await server.receive({...f.request,timeline:true,fc:true,publishFc:true});
  expect(runner).toHaveBeenCalledTimes(1);expect(calculate).toHaveBeenCalledTimes(2);
  expect(responses).toContainEqual(expect.objectContaining({type:"fc",outcome:{error:"native calculation unavailable"}}));
  expect(responses.at(-1)).toMatchObject({status:"complete",metrics:(await runner.mock.results[0].value).metrics});
});

it("pulls bounded raw chunks and keeps parsed frames/map construction inside the numerical worker",async()=>{
  const f=streamRequest(),responses:LibraryAnalysisResponse[]=[];
  const server=new LibraryAnalysisWorkerServer(response=>{
    responses.push(response);
    if(response.type==="read") {
      const all=f.bytes[response.kind],bytes=all.slice(response.offset,response.offset+97);
      void server.receive({version:1,type:"chunk",requestId:1,readId:response.readId,chunk:{bytes,done:response.offset+bytes.length===all.length}});
    }
  });
  await server.receive(f.request);
  expect(responses.filter(response=>response.type==="read").length).toBeGreaterThan(2);
  expect(responses.at(-1)).toMatchObject({type:"result",status:"complete",ticket,metrics:{fields:{fc:{state:"known",value:true}}}});
  expect(JSON.stringify(responses)).not.toMatch(/"frames"|"beatmap"/);
});

it("cancels a pending chunk read and ignores its late reply",async()=>{
  const f=streamRequest(),responses:LibraryAnalysisResponse[]=[];
  let read!:()=>void;const requested=new Promise<void>(resolve=>{read=resolve;});
  const server=new LibraryAnalysisWorkerServer(response=>{responses.push(response);if(response.type==="read")read();});
  const work=server.receive(f.request);await requested;
  await server.receive({version:1,type:"cancel",requestId:1});await work;
  expect(responses.at(-1)).toMatchObject({type:"result",status:"cancelled"});
  await server.receive({version:1,type:"chunk",requestId:1,readId:1,chunk:{bytes:f.bytes.replay,done:true}});
  expect(responses.filter(response=>response.type==="result")).toHaveLength(1);
});

it.each(["ticket","continuation"])("rejects retired incident %s before simulation",async kind=>{
  const responses:LibraryAnalysisResponse[]=[],runner=jest.fn(runLibraryNumerical),calculate=jest.fn();
  const server=new LibraryAnalysisWorkerServer(response=>responses.push(response),runner,calculate);
  await server.receive({version:1,type:"control",sequence:1,viewerDemand:false,userPaused:false});
  const value=request();await server.receive(kind==="ticket"?{...value,ticket:{...ticket,slot:"incidents",stage:"C"}}:{...value,timeline:true,fc:true,incidents:true});
  expect(runner).not.toHaveBeenCalled();expect(calculate).not.toHaveBeenCalled();expect(responses.at(-1)).toMatchObject({type:"result",status:"error"});
});
