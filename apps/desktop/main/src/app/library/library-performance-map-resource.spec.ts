import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import type { LibraryOpenLocation, LibraryOpenMap } from "./library-store";
import { prepareLibraryPerformanceMap } from "./library-performance-map-resource";
import { buildMapPerformanceRequest } from "./library-map-performance";
import { buildBeatmap, isHitCircle, parseBlueprint } from "@osujs/core";
import * as tempoSummary from "../../../../../../libs/osu/core/src/beatmap/TempoSummary";

let directory:string,map:LibraryOpenMap,location:LibraryOpenLocation;
const text="osu file format v14\n[General]\nMode:0\n[HitObjects]\n64,64,1000,1,0,0:0:0:0:\n";
const md5=createHash("md5").update(text).digest("hex"),sha256=createHash("sha256").update(text).digest("hex");
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),"library-p-map-"));const path=join(directory,"map.osu");await writeFile(path,text);
  map={sourceId:"stable",sourceConfigRevision:0,generation:"map-g",sourceKey:"map",md5,locator:path,kind:"stable",directory,metadata:{}};
  location={replayId:"replay",sourceId:"stable",sourceConfigRevision:0,sourceKey:"a".repeat(64),locationRevision:1,sha256:null,
    locator:join(directory,"missing.osr"),directory,kind:"stable",metadata:{savedScore:{sourceKey:"a".repeat(64),databaseVersion:20250101,header:{beatmapMD5:md5}}}};
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
it("reads exact map bytes for a source-only Stable score without opening its missing replay or any assets",async()=>{
  const result=await prepareLibraryPerformanceMap(location,map);
  expect(result).toMatchObject({map:{text,sha256,md5},mapTicket:map,location});
  expect(result).not.toHaveProperty("replay");expect(result).not.toHaveProperty("assets");
  expect(result.metadata).toEqual({ruleset:0,baseBpm:null,tempoUnavailableReason:"missing-map-timing"});
});
it("reads bounded map mode and exact tempo without simulation",async()=>{
  const write=async(body:string)=>{await writeFile(map.locator,body);map.md5=createHash("md5").update(body).digest("hex");
    location.metadata={savedScore:{sourceKey:location.sourceKey,databaseVersion:20250101,header:{beatmapMD5:map.md5}}};return prepareLibraryPerformanceMap(location,map);};
  expect((await write(text+"\n[TimingPoints]\n0,500,4,1,0,100,1,0\n1000,-100,4,1,0,100,0,0\n")).metadata).toEqual({ruleset:0,baseBpm:120});
  expect((await write(text+"\n[TimingPoints]\n0,500,4,1,0,100,1,0\n1000,400,4,1,0,100,1,0\n")).metadata).toEqual({ruleset:0,baseBpm:120});
  expect((await write("osu file format v14\n[General]\nMode:3\n[TimingPoints]\n0,500\n")).metadata).toEqual({ruleset:3,baseBpm:120});
  await expect(write("osu file format v14\n[General]\nMode:0\nMode:3\n")).rejects.toThrow(/mode/i);
});

async function metadataFor(body:string,checkpoint?:()=>Promise<void>,signal?:AbortSignal){
  await writeFile(map.locator,body);map.md5=createHash("md5").update(body).digest("hex");
  location.metadata={savedScore:{sourceKey:location.sourceKey,databaseVersion:20250101,header:{beatmapMD5:map.md5}}};
  return(await prepareLibraryPerformanceMap(location,map,signal,checkpoint)).metadata;
}
const tempoMap=(objects:string,timings="0,500,4,1,0,100,1,0\n30000,250,4,1,0,100,1,0")=>
  "osu file format v14\n[General]\nMode:0\n[Difficulty]\nSliderMultiplier:1\n[TimingPoints]\n"+timings+"\n[HitObjects]\n"+objects+"\n";
it("uses duration dominance with duplicate reds and inherited SV excluded from tempo",async()=>{
  expect((await metadataFor(tempoMap("64,64,120000,1,0"))).baseBpm).toBe(240);
  expect((await metadataFor(tempoMap("64,64,60000,1,0","0,500\n10000,500\n20000,-50,4,1,0,100,0,0\n30000,250"))).baseBpm).toBe(120);
});
it("uses the actual final slider and spinner end, including an earlier overlapping object",async()=>{
  expect((await metadataFor(tempoMap("64,64,30000,2,0,L|164:64,1,36000"))).baseBpm).toBe(240);
  expect((await metadataFor(tempoMap("64,64,30000,8,0,120000\n64,64,40000,1,0"))).baseBpm).toBe(240);
  expect((await metadataFor(tempoMap("64,64,30000,2,0,L|164:64|164:64,1,36000"))).baseBpm).toBe(120);
});
it("clips outside-play timings and ignores zero-duration red segments",async()=>{
  expect((await metadataFor(tempoMap("64,64,40000,1,0","-2000,1000\n-1000,500\n0,250\n0,500\n100000,250"))).baseBpm).toBe(240);
});
it.each(["0,0","0,NaN","bad,500","0,500\n100,0,4,1,0,100,1,0","0,500\n100,-50,4,1,0,100,2,0"])
  ("keeps malformed timing %j unavailable rather than filtering it into certainty",async timings=>{
    expect((await metadataFor(tempoMap("64,64,120000,1,0",timings))).baseBpm).toBeNull();
  });

it.each(["L|164:64,3,1234.56789","L|164:64|164:64,3,1234.56789","L|64:64,1,1234.56789",
  "B|164:64|180:200|300:64,2,1234.56789","P|164:164|264:64,2,0","C|164:164|264:64,2,0",
  "B|164:164|264:64,2,0"])("uses the exact existing built slider horizon when the interval cannot prove %s",async path=>{
  const body=tempoMap(`64,64,30000,2,0,${path}`,"0,500\n15000,250"),built=buildBeatmap(parseBlueprint(body));
  const expected=Math.max(...built.hitObjects.map(object=>isHitCircle(object)?object.hitTime:object.endTime));
  const reduce=jest.spyOn(tempoSummary,"dominantBeatLength");
  try{await metadataFor(body);expect(reduce).toHaveBeenCalled();expect(reduce.mock.calls[0][1]).toBe(expected);}finally{reduce.mockRestore();}
});
it("retains the source decoder's old-format offset and actual slider SV",async()=>{
  const body=tempoMap("64,64,30000,2,0,L|164:64,3,1234.56789","0,500\n15000,250\n30000,-50,4,1,0,100,0,0").replace("v14","v4");
  const built=buildBeatmap(parseBlueprint(body)),object=built.hitObjects[0];
  const reduce=jest.spyOn(tempoSummary,"dominantBeatLength");
  try{await metadataFor(body);expect(reduce.mock.calls[0][1]).toBe(isHitCircle(object)?object.hitTime:object.endTime);}finally{reduce.mockRestore();}
});
it("rejects geometry and timing work beyond explicit budgets, while constant tempo needs neither",async()=>{
  const excessive="B|"+Array.from({length:65},(_,i)=>`${100+i}:64`).join("|");
  expect((await metadataFor(tempoMap(`64,64,30000,2,0,${excessive},1,36000`))).baseBpm).toBeNull();
  expect((await metadataFor(tempoMap(`64,64,30000,2,0,${excessive},1,36000`,"0,500"))).baseBpm).toBe(120);
  expect((await metadataFor(tempoMap("64,64,120000,1,0",Array.from({length:8193},(_,i)=>`${i},${i%2?250:500}`).join("\n")))).baseBpm).toBeNull();
  expect((await metadataFor(tempoMap("64,64,120000,1,0",Array.from({length:8193},(_,i)=>`${i},500`).join("\n")))).baseBpm).toBe(120);
});
it("checks cancellation during metadata work after verified file reading",async()=>{
  const body=tempoMap("64,64,120000,1,0",Array.from({length:400},(_,i)=>`${i*10},${i%2?250:500}`).join("\n"));
  const controller=new AbortController();let checkpoints=0;
  await expect(metadataFor(body,async()=>{if(++checkpoints===10)controller.abort();},controller.signal)).rejects.toThrow(/abort/i);
  expect(checkpoints).toBe(10);
});
it("bounds adaptive Bezier work and nearly-collinear arc output before geometry allocation",async()=>{
  const curve="B|"+Array.from({length:60},(_,i)=>`${i*2000}:${i%2?131072:-131072}`).join("|");
  expect(await metadataFor(tempoMap(`0,0,30000,2,0,${curve},1,1000000`))).toEqual({ruleset:0,baseBpm:null,tempoUnavailableReason:"tempo-geometry-budget"});
  expect(await metadataFor(tempoMap("0,0,30000,2,0,P|131072:0.000001|-131072:0,1,0"))).toEqual({ruleset:0,baseBpm:null,tempoUnavailableReason:"tempo-geometry-budget"});
});
it("does not decode irrelevant slider geometry when its exact expected-length upper bound is already covered",async()=>{
  const curve="B|"+Array.from({length:65},(_,i)=>`${100+i}:64`).join("|");
  expect((await metadataFor(tempoMap(`64,64,10000,2,0,${curve},1,100\n64,64,120000,1,0`))).baseBpm).toBe(240);
});
it("rejects a length lexeme that would make the upper bound disagree with the actual decoder",async()=>{
  const body=tempoMap("64,64,0,2,0,L|100064:64,1,0x64\n64,64,60000,1,0"),built=buildBeatmap(parseBlueprint(body));
  const horizon=Math.max(...built.hitObjects.map(object=>isHitCircle(object)?object.hitTime:object.endTime));
  expect(horizon).toBe(500000);
  expect(tempoSummary.dominantBeatLength(built.controlPointInfo.timingPoints.list,horizon)).toBe(250);
  expect(await metadataFor(body)).toEqual({ruleset:0,baseBpm:null,tempoUnavailableReason:"map-horizon-unavailable"});
});
it.each([
  "64,64,30000,2,0,L|164:64,1e2,36000",
  "64,64,0x7530,2,0,L|164:64,1,36000",
  "64,64,30000,2e1,0,L|164:64,1,36000",
  "64,64,30000,8,0,0x1d4c0",
  "0x40,64,30000,2,0,L|164:64,1,36000",
  "64,64,30000,2,0,L|0xa4:64,1,36000",
])("rejects decoder-inconsistent consumed object numbers: %s",async objects=>{
  expect((await metadataFor(tempoMap(objects))).tempoUnavailableReason).toBe("map-horizon-unavailable");
});
it.each(["0,0x1f4\n30000,250","0x7530,500\n30000,250"])("rejects decoder-inconsistent timing numbers: %s",async timings=>{
  expect((await metadataFor(tempoMap("64,64,120000,1,0",timings))).tempoUnavailableReason).toBe("invalid-map-timing");
});
it("retains decoder-equivalent floating exponent notation and rejects a mismatched multiplier",async()=>{
  expect((await metadataFor(tempoMap("64,64,1.2e5,1,0","0,5e2\n3e4,2.5e2"))).baseBpm).toBe(240);
  expect((await metadataFor(tempoMap("64,64,30000,2,0,L|164:64,1,36000").replace("SliderMultiplier:1","SliderMultiplier:0x1"))).tempoUnavailableReason).toBe("map-horizon-unavailable");
});
it("certifies the tempo of a large final path across every possible end without raising geometry caps",async()=>{
  const path="B|"+Array.from({length:105},(_,i)=>`${100+i}:${i%2?120:64}`).join("|");
  expect((await metadataFor(tempoMap(`64,64,100000,2,0,${path},1,1000`,"0,500\n30000,250\n101000,100"))).baseBpm).toBe(240);
});
it("ignores an irrelevant overlong earlier path using its exact end upper bound",async()=>{
  const path="B|"+Array.from({length:798},(_,i)=>`${100+i}:64`).join("|");
  expect(path.length).toBeGreaterThan(4096);
  expect((await metadataFor(tempoMap(`64,64,30000,2,0,${path},1,100\n64,64,120000,1,0`))).baseBpm).toBe(240);
});
it("keeps required long geometry unavailable when the interval certificate cannot establish a winner",async()=>{
  const path="B|"+Array.from({length:798},(_,i)=>`${100+i}:64`).join("|");
  expect(await metadataFor(tempoMap(`64,64,30000,2,0,${path},1,36000`))).toEqual({ruleset:0,baseBpm:null,tempoUnavailableReason:"tempo-geometry-budget"});
});
it("yields through long envelope token validation without constructing its geometry",async()=>{
  const path="B|"+Array.from({length:20000},(_,i)=>`${100+i%500}:64`).join("|");let checkpoints=0;
  expect((await metadataFor(tempoMap(`64,64,100000,2,0,${path},1,100`),async()=>{checkpoints++;})).baseBpm).toBe(240);
  expect(checkpoints).toBeGreaterThan(70);
});
it("cancels during long envelope validation and keeps missing distance bounds unavailable",async()=>{
  const path="B|"+Array.from({length:20000},(_,i)=>`${100+i%500}:64`).join("|"),controller=new AbortController();let checkpoints=0;
  await expect(metadataFor(tempoMap(`64,64,100000,2,0,${path},1,100`),async()=>{
    if(++checkpoints===20)controller.abort();
  },controller.signal)).rejects.toThrow(/abort/i);expect(checkpoints).toBe(20);
  expect((await metadataFor(tempoMap(`64,64,100000,2,0,${path},1,0`))).tempoUnavailableReason).toBe("tempo-geometry-budget");
});
it("bounds streamed token validation instead of lifting the geometry limits",async()=>{
  const path="B|"+"100:64|".repeat(1_000_000)+"100:64";let checkpoints=0;
  expect(await metadataFor(tempoMap(`64,64,100000,2,0,${path},1,100`),async()=>{checkpoints++;})).toEqual({ruleset:0,baseBpm:null,tempoUnavailableReason:"tempo-geometry-budget"});
  expect(checkpoints).toBeGreaterThan(3900);expect(checkpoints).toBeLessThan(6000);
});
it("retains decoder-consistent numeric guards on long envelopes before the certificate",async()=>{
  const path="B|"+"100:64|".repeat(799)+"100:64";
  expect((await metadataFor(tempoMap(`64,64,100000,2,0,${path},1,0x64`))).tempoUnavailableReason).toBe("map-horizon-unavailable");
});
it("reads native indexed managed map by exact hash even when its replay is missing",async()=>{
  location.kind="lazer";location.sourceKey="native-id";location.metadata={schemaFingerprint:"f".repeat(64),nativeScore:{id:"native-id",ruleset:0,
    replay:{status:"missing"},beatmap:{status:"unverified",path:map.locator,sha256,md5,bytes:Buffer.byteLength(text)}}};
  const result=await prepareLibraryPerformanceMap(location);
  expect(result.map).toEqual({text,sha256,md5});expect(result.mapTicket).toBeUndefined();
});
it.each([false,true])("honors exact explicit fallback when the indexed native map is unavailable or corrupt (%s)",async corrupt=>{
  const broken=join(directory,"native.osu");if(corrupt)await writeFile(broken,"wrong map bytes");
  location.kind="lazer";location.sourceKey="native-id";location.metadata={schemaFingerprint:"f".repeat(64),nativeScore:{id:"native-id",ruleset:0,
    replay:{status:"missing"},beatmap:{status:"unverified",path:broken,sha256,md5,bytes:Buffer.byteLength(text)}}};
  await expect(prepareLibraryPerformanceMap(location)).rejects.toThrow();
  expect(await prepareLibraryPerformanceMap(location,map)).toMatchObject({map:{sha256,md5,text},mapTicket:map});
});
it("uses a verified file header for Replays/imports and rejects disagreeing source map identities",async()=>{
  location.kind="replays";location.sha256="b".repeat(64);location.metadata={header:{beatmapMD5:md5}};
  expect((await prepareLibraryPerformanceMap(location,map)).map.md5).toBe(md5);
  location.kind="stable";location.metadata.savedScore={sourceKey:location.sourceKey,databaseVersion:20250101,header:{beatmapMD5:"c".repeat(32)}};
  await expect(prepareLibraryPerformanceMap(location,map)).rejects.toThrow(/conflict/i);
});
it("rejects wrong map bytes and changed native map identity",async()=>{
  await writeFile(map.locator,text+"changed");await expect(prepareLibraryPerformanceMap(location,map)).rejects.toThrow(/digest/i);
  location.kind="lazer";location.sourceKey="native-id";location.metadata={schemaFingerprint:"f".repeat(64),nativeScore:{id:"native-id",ruleset:0,
    replay:{status:"missing"},beatmap:{status:"unverified",path:map.locator,sha256,md5,bytes:Buffer.byteLength(text)}}};
  await expect(prepareLibraryPerformanceMap(location)).rejects.toThrow(/digest/i);
});
it("retains cancellation and refuses an unrelated fallback map",async()=>{
  await expect(prepareLibraryPerformanceMap(location,{...map,md5:"c".repeat(32)})).rejects.toThrow(/identity/i);
  const controller=new AbortController();await expect(prepareLibraryPerformanceMap(location,map,controller.signal,async()=>controller.abort())).rejects.toThrow(/abort/i);
});
it("preserves a UTF-8 BOM so the verified digest still names the exact calculation bytes",async()=>{
  const encoded="\ufeff"+text,expected=createHash("md5").update(encoded).digest("hex");await writeFile(map.locator,encoded);
  map.md5=expected;location.metadata={savedScore:{sourceKey:location.sourceKey,databaseVersion:20250101,header:{beatmapMD5:expected}}};
  const result=await prepareLibraryPerformanceMap(location,map);
  expect(result.map.text).toBe(encoded);expect(buildMapPerformanceRequest({...result.map,ruleset:0},"stable",[]).state).toBe("ready");
});
it("accepts the Stella-rium leading ASCII space without changing the exact resource bytes or digest",async()=>{
  const encoded=" "+text,expected="419e2455214af117ec0456578d4d9da0";
  expect(createHash("md5").update(encoded).digest("hex")).toBe(expected);
  await writeFile(map.locator,encoded);map.md5=expected;
  location.metadata={savedScore:{sourceKey:location.sourceKey,databaseVersion:20250101,header:{beatmapMD5:expected}}};
  const result=await prepareLibraryPerformanceMap(location,map);
  expect(result.map).toEqual({text:encoded,md5:expected,sha256:createHash("sha256").update(encoded).digest("hex")});
  expect(result.metadata).toEqual({ruleset:0,baseBpm:null,tempoUnavailableReason:"missing-map-timing"});
  const request=buildMapPerformanceRequest({...result.map,ruleset:0},"stable",[]);
  expect(request.state).toBe("ready");if(request.state==="ready")expect(request.request.beatmap).toBe(encoded);
  // The unpadded identity must never admit the padded file, even though both decode as maps.
  map.md5=md5;location.metadata={savedScore:{sourceKey:location.sourceKey,databaseVersion:20250101,header:{beatmapMD5:md5}}};
  await expect(prepareLibraryPerformanceMap(location,map)).rejects.toThrow(/digest/i);
});
it.each(["\t"," \t ","\ufeff ","\ufeff\t"])("accepts decoder-supported horizontal header padding %j while preserving the BOM",async prefix=>{
  const encoded=prefix+text,expected=createHash("md5").update(encoded).digest("hex");
  await writeFile(map.locator,encoded);map.md5=expected;
  location.metadata={savedScore:{sourceKey:location.sourceKey,databaseVersion:20250101,header:{beatmapMD5:expected}}};
  const result=await prepareLibraryPerformanceMap(location,map);
  expect(result.map.text).toBe(encoded);expect(result.map.md5).toBe(expected);expect(result.metadata.ruleset).toBe(0);
});
it.each(["junk\nosu file format v14\n","[General]\nMode:0\nosu file format v14\n","not a map containing osu file format v14\n",
  " osu file format v14junk\n","\tosu file format v\n","\ufeff osu file format v1.4\n"," osu file format v-14\n","\nosu file format v14\n","\vosu file format v14\n"])
  ("rejects embedded, junk and malformed version headers %j instead of trimming arbitrary source data",async encoded=>{
    const expected=createHash("md5").update(encoded).digest("hex");await writeFile(map.locator,encoded);map.md5=expected;
    location.metadata={savedScore:{sourceKey:location.sourceKey,databaseVersion:20250101,header:{beatmapMD5:expected}}};
    await expect(prepareLibraryPerformanceMap(location,map)).rejects.toThrow(/format header/i);
  });
it("retains fatal UTF-8 decoding and the exact resource byte limit with a padded header",async()=>{
  const encoded=Buffer.concat([Buffer.from(" "+text),Buffer.from([0xc3,0x28])]),expected=createHash("md5").update(encoded).digest("hex");
  await writeFile(map.locator,encoded);map.md5=expected;
  location.metadata={savedScore:{sourceKey:location.sourceKey,databaseVersion:20250101,header:{beatmapMD5:expected}}};
  await expect(prepareLibraryPerformanceMap(location,map)).rejects.toThrow(/encoded data|encoding/i);
  await writeFile(map.locator,Buffer.alloc(16*1024*1024+1,32));
  await expect(prepareLibraryPerformanceMap(location,map)).rejects.toThrow(/size limit/i);
});
it("bounds comma-heavy timing lines and yields before returning unavailable tempo",async()=>{
  const encoded=text+"\n[TimingPoints]\n0,500,4,1,0,100,1,"+",".repeat(2*1024*1024),expected=createHash("md5").update(encoded).digest("hex");
  await writeFile(map.locator,encoded);map.md5=expected;location.metadata={savedScore:{sourceKey:location.sourceKey,databaseVersion:20250101,header:{beatmapMD5:expected}}};
  let checkpoints=0;const result=await prepareLibraryPerformanceMap(location,map,undefined,async()=>{checkpoints++;});
  expect(result.metadata.baseBpm).toBeNull();expect(checkpoints).toBeGreaterThan(3);
  const controller=new AbortController();await expect(prepareLibraryPerformanceMap(location,map,controller.signal,async()=>controller.abort())).rejects.toThrow(/abort/i);
});
