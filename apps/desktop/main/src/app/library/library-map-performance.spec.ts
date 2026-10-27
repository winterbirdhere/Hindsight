import { createHash } from "crypto";
import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { buildMapPerformanceRequest, mapPerformanceIdentity, readMapPerformanceResult } from "./library-map-performance";
import { produceLibraryPerformance } from "./library-performance-producer";

const text="osu file format v14\n[General]\nMode:0\n",sha256=createHash("sha256").update(text).digest("hex");
const map={text,sha256,ruleset:0};
it("derives shared cache identity from a verified descriptor without transferring map text",()=>{
  const result=mapPerformanceIdentity(sha256,"stable",[{acronym:"NC"},{acronym:"DT"}]);
  const request=buildMapPerformanceRequest(map,"stable",[{acronym:"NC"}]);
  expect(result).toMatchObject({state:"ready",mods:[{acronym:"NC"}]});
  if(result.state!=="ready"||request.state!=="ready")throw new Error("Expected ready identity");
  expect(result.inputKey).toBe(request.inputKey);
  expect(mapPerformanceIdentity("bad","stable",[]).state).toBe("unknown");
});
const response=()=>({ok:true,engineVersion:PERFORMANCE_ENGINE_VERSION,timelines:[{mode:"stable",objectCount:2,endpointVerified:false,
  points:[],difficultyPoints:[],final:null,fullDifficulty:{total:0,aim:0,speed:0,reading:0,flashlight:0,sliderFactor:1},
  fullMap:{version:1,maxCombo:4,largeTicks:1,smallTicks:1,sliderTails:0,clockRate:1.25,drainTimeMs:2400,endTimeMs:4000}}]});

it("requests map-only calculation with semantic keys independent of replay, path and score",()=>{
  const first=buildMapPerformanceRequest(map,"stable",[{acronym:"NC",settings:{speed_change:1.25}},{acronym:"DT"}]);
  if(first.state!=="ready")throw new Error(first.reason);
  expect(first.request.calculations).toEqual([{mode:"stable",scope:"full-map",mods:[{acronym:"NC",settings:{speed_change:1.25}}],states:[]}]);
  expect(buildMapPerformanceRequest({...map},"stable",[{acronym:"NC",settings:{speed_change:1.25}}])).toEqual(first);
  const other=buildMapPerformanceRequest(map,"stable",[{acronym:"NC",settings:{speed_change:1.3}}]);
  if(other.state!=="ready")throw new Error(other.reason);expect(other.inputKey).not.toBe(first.inputKey);
  expect(buildMapPerformanceRequest(map,"lazer",null).state).toBe("unknown");
  expect(buildMapPerformanceRequest(map,"stable",[]).state).toBe("ready"); // NM independent of unavailable replay profile.
});
it("rejects mismatched exact bytes and unsupported or conflicting profile inputs",()=>{
  expect(buildMapPerformanceRequest({...map,sha256:"b".repeat(64)},"stable",[]).state).toBe("unknown");
  expect(buildMapPerformanceRequest({...map,ruleset:3},"stable",[]).state).toBe("unknown");
  expect(buildMapPerformanceRequest(map,"lazer",[{acronym:"CL"}]).state).toBe("unknown");
  expect(buildMapPerformanceRequest(map,"lazer-classic",[]).state).toBe("unknown");
  expect(buildMapPerformanceRequest(map,"lazer",[{acronym:"DT",settings:{speed_change:Infinity}}]).state).toBe("unknown");
});
it("reads exact map capacities and valid zero stars without claiming completion or PP",()=>{
  const value=readMapPerformanceResult(response(),"stable");
  expect(value).toMatchObject({state:"known",value:{objectCount:2,stars:0,maxCombo:4,clockRate:1.25,drainTimeMs:2400}});
  if(value.state!=="known")throw new Error(value.reason);
  expect(value.value).not.toHaveProperty("completion");expect(value.value).not.toHaveProperty("pp");
});
it.each([1.0000076619481455,1.1])("admits official slider ratio %s through the map producer without changing raw difficulty",async sliderFactor=>{
  const raw=response();raw.timelines[0].fullDifficulty.sliderFactor=sliderFactor;
  const put=jest.fn(async()=>undefined);
  const produced=await produceLibraryPerformance({sha256,md5:"b".repeat(32),ruleset:0,baseBpm:120},{origin:null,nativeRequired:true},
    {mapCache:{get:async()=>undefined,put},scalarCache:{get:async()=>undefined,put:async()=>undefined},calculate:async()=>raw},new AbortController().signal);
  expect(produced.find(value=>value.slot==="calculated-map")?.fields.mapStars).toEqual({state:"known",value:0});
  expect(put).toHaveBeenCalledWith(expect.any(String),"stable",expect.objectContaining({stars:0,objectCount:2,maxCombo:4}));
  expect(raw.timelines[0].fullDifficulty.sliderFactor).toBe(sliderFactor);
});
it.each([-1,NaN,Infinity,-Infinity,null,undefined,"1.1",{}])("rejects invalid slider ratio %s in map envelopes",sliderFactor=>{
  const raw=response();(raw.timelines[0].fullDifficulty as Record<string,unknown>).sliderFactor=sliderFactor;
  expect(readMapPerformanceResult(raw,"stable").state).toBe("unknown");
});
it.each([
  (r:ReturnType<typeof response>)=>{r.timelines[0].fullMap.maxCombo=-1;},
  (r:ReturnType<typeof response>)=>{r.timelines[0].fullMap.clockRate=0;},
  (r:ReturnType<typeof response>)=>{r.timelines[0].fullMap.largeTicks=1.5;},
  (r:ReturnType<typeof response>)=>{r.timelines[0].fullMap.version=2;},
  (r:ReturnType<typeof response>)=>{r.timelines[0].fullDifficulty.total=NaN;},
  (r:ReturnType<typeof response>)=>{r.timelines[0].objectCount=0;},
  (r:ReturnType<typeof response>)=>{r.timelines[0].mode="lazer";},
  (r:ReturnType<typeof response>)=>{r.engineVersion="stale";},
])("rejects malformed, incompatible or empty map envelopes",change=>{
  const r=response();change(r);expect(readMapPerformanceResult(r,"stable").state).toBe("unknown");
});
