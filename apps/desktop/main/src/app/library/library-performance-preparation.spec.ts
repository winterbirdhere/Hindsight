import { startLibraryPerformancePreparation,LibraryPerformancePreparationDependencies } from "./library-performance-preparation";
import type { LibraryPreparationTicket,LibraryPreparedResult } from "./library-preparation-store";
import type { LibraryOpenLocation } from "./library-store";
const md5="a".repeat(32),sha="b".repeat(64),ticket:LibraryPreparationTicket={replayId:"r",stage:"P",dependencyKey:"c".repeat(64),generation:1,reason:"background",attempt:"a"};
const location:LibraryOpenLocation={replayId:"r",sourceId:"s",sourceKey:"d".repeat(64),locator:"C:/fixture/missing.osr",sha256:null,kind:"stable",directory:"C:/fixture",
  locationRevision:1,sourceConfigRevision:0,metadata:{savedScore:{sourceKey:"d".repeat(64),databaseVersion:20250101,header:{beatmapMD5:md5}}}};
const map={sourceId:"s",sourceKey:"map",sourceConfigRevision:0,generation:"g",md5,locator:"C:/fixture/map.osu",kind:"stable",directory:"C:/fixture",metadata:{}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  let closed=false;const commits:Record<string,unknown>[]=[],methods:string[]=[];
  const deps:LibraryPerformancePreparationDependencies={metadata:async(method,args={})=>{
    methods.push(method);if(method==="performance-context")return{mapMd5:md5,replaySha256:null,evidence:{origin:null,nativeRequired:false},dependencies:{}};
    if(method==="prepare-open")return{items:[location]};if(method==="prepare-map")return{items:[map]};
    if(method==="performance-commit"){expect(closed).toBe(true);commits.push(args);return{state:"applied",replayId:"r"};}
    if(method==="analysis-eligible")return true;return undefined;
  },resources:{request:jest.fn(async(method,args={})=>{
    if(method==="control")return args.viewerDemand?"parked":"released";
    if(method==="begin-performance")return{sessionId:args.sessionId,md5,sha256:sha,bytes:100,ruleset:0,baseBpm:120};return null;
  }),close:jest.fn(async()=>{closed=true;})},produce:jest.fn(async():Promise<LibraryPreparedResult[]>=>[{slot:"calculated-map",stage:"P",producerVersion:"p-v1",inputKey:"e".repeat(64),
    fields:{mapStars:{state:"known",value:0}},provenance:{mapSha256:sha,mapMd5:md5}}])};
  return{deps,commits,methods};
}
it.each(["begin-performance","performance-score"])("exposes the in-flight %s source lease before the resource request completes",async phase=>{
  const f=fixture(),abort=new AbortController(),metadata=f.deps.metadata,request=f.deps.resources.request;
  const candidate={...location,sha256:sha};let finish!:()=>void,ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});
  f.deps.metadata=async(method,args)=>{
    if(method==="performance-context")return{mapMd5:md5,replaySha256:sha,evidence:{origin:null,nativeRequired:true},dependencies:{}};
    if(method==="prepare-open")return{items:[candidate]};
    if(method==="analysis-eligible"){
      const lease=args?.lease as {location?:unknown;score?:unknown};return phase==="begin-performance"?!lease.location:!lease.score;
    }return metadata(method,args);
  };
  f.deps.resources.request=async(method,args)=>{
    if(method===phase){ready();await new Promise<void>(resolve=>{finish=resolve;});}
    if(method==="performance-score")return{origin:null,trailerStatus:"absent"};return request(method,args);
  };
  const work=startLibraryPerformancePreparation(ticket,{viewerDemand:false,userPaused:false},abort.signal,f.deps),done=work.result.catch(error=>error);
  await started;
  try{expect(await work.eligible?.()).toBe(false);}finally{abort.abort();finish();await done;}
  expect(f.commits).toHaveLength(0);expect(f.deps.resources.close).toHaveBeenCalledTimes(1);
});
it("owns one P reservation through source-only preparation, actual utility close and atomic publication",async()=>{
  const f=fixture(),work=startLibraryPerformancePreparation(ticket,{viewerDemand:false,userPaused:false},new AbortController().signal,f.deps);
  await work.result;expect(f.commits).toHaveLength(1);expect(f.commits[0]).toMatchObject({ticket,location,map:{md5,sha256:sha,ticket:map},origin:null});
  expect(f.methods).not.toContain("metric-claim");expect(f.deps.resources.request).not.toHaveBeenCalledWith("begin",expect.anything());
  expect(f.deps.resources.request).not.toHaveBeenCalledWith("performance-score",expect.anything());expect(f.deps.resources.close).toHaveBeenCalledTimes(1);
});
it("does not publish before close acknowledgement and preserves control while owned work is running",async()=>{
  const f=fixture();let finish!:()=>void,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  const close=f.deps.resources.close;f.deps.resources.close=jest.fn(async()=>{started();await new Promise<void>(resolve=>{finish=resolve;});await close();});
  const work=startLibraryPerformancePreparation(ticket,{viewerDemand:false,userPaused:false},new AbortController().signal,f.deps);
  await ready;expect(f.commits).toHaveLength(0);let held=false;const hold=work.control({viewerDemand:true,userPaused:false}).then(()=>{held=true;});
  await tick();expect(held).toBe(false);finish();await hold;await work.result;expect(f.commits).toHaveLength(1);
});
it("uncertain resource drainage or cancellation prevents publication",async()=>{
  const f=fixture();f.deps.resources.close=jest.fn(async()=>{throw Error("uncertain exit");});
  await expect(startLibraryPerformancePreparation(ticket,{viewerDemand:false,userPaused:false},new AbortController().signal,f.deps).result).rejects.toThrow(/uncertain/);
  expect(f.commits).toHaveLength(0);
  const other=fixture(),abort=new AbortController(),produce=other.deps.produce!;
  other.deps.produce=async(...args)=>{const result=await produce(...args);abort.abort();return result;};
  await expect(startLibraryPerformancePreparation(ticket,{viewerDemand:false,userPaused:false},abort.signal,other.deps).result).rejects.toThrow();expect(other.commits).toHaveLength(0);
});
it("releases a still-live stale receipt for fresh evidence without inventing completion",async()=>{
  const f=fixture(),metadata=f.deps.metadata;f.deps.metadata=async(method,args)=>method==="performance-commit"?{state:"stale"}:metadata(method,args);
  await startLibraryPerformancePreparation(ticket,{viewerDemand:false,userPaused:false},new AbortController().signal,f.deps).result;
  expect(f.methods.filter(method=>method==="preparation-release")).toHaveLength(1);
});
it("forwards diagnosed timing availability without discarding the exact resource cause",async()=>{
  const f=fixture(),request=f.deps.resources.request;
  f.deps.resources.request=async(method,args)=>{
    const value=await request(method,args);
    return method==="begin-performance"?{...(value as object),baseBpm:null,tempoUnavailableReason:"tempo-geometry-budget"}:value;
  };
  await startLibraryPerformancePreparation(ticket,{viewerDemand:false,userPaused:false},new AbortController().signal,f.deps).result;
  expect(f.deps.produce).toHaveBeenCalledWith(expect.objectContaining({baseBpm:null,tempoUnavailableReason:"tempo-geometry-budget"}),
    expect.anything(),expect.anything(),expect.anything());
});
it.each([{baseBpm:null,tempoUnavailableReason:"unbounded-or-unrecognized"},{baseBpm:120,tempoUnavailableReason:"tempo-geometry-budget"}])
  ("rejects invalid timing reason transport %j before publication",async descriptor=>{
    const f=fixture(),request=f.deps.resources.request;
    f.deps.resources.request=async(method,args)=>{
      const value=await request(method,args);return method==="begin-performance"?{...(value as object),...descriptor}:value;
    };
    await expect(startLibraryPerformancePreparation(ticket,{viewerDemand:false,userPaused:false},new AbortController().signal,f.deps).result).rejects.toThrow();
    expect(f.deps.produce).not.toHaveBeenCalled();expect(f.commits).toHaveLength(0);
  });
