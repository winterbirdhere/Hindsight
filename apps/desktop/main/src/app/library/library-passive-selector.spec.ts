import { createLibraryPassiveSelector } from "./library-passive-selector";
import type { LibraryOperation } from "./library-process-client";
import { LibraryNativeDrainError } from "./library-native-admission";
import type { LazerSourceScore } from "./sources/lazer-source";
import { createHash } from "crypto";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { LibraryArtworkCache } from "./library-artwork-cache";
import { LibraryPassiveResources } from "./library-passive-resources";
const location={replayId:"r",sourceId:"replays",sourceKey:"r",locator:"D:\\Replays\\r.osr",directory:"D:\\Replays",kind:"replays",sha256:"a".repeat(64),
  sourceConfigRevision:0,locationRevision:1,metadata:{header:{beatmapMD5:"c".repeat(32)}}};
const map={sourceId:"stable",sourceKey:"map",sourceConfigRevision:0,generation:"generation",kind:"stable",md5:"c".repeat(32),locator:"D:\\Songs\\map\\map.osu",metadata:{songsRoot:"D:\\Songs"}};
const nativeLocation={...location,kind:"lazer",sourceKey:"12345678-1234-1234-1234-123456789abc",locator:"12345678-1234-1234-1234-123456789abc",directory:"D:\\Native"};
const nativeScore:LazerSourceScore={id:nativeLocation.sourceKey,playedAtTicks:"1",player:null,ruleset:0,clientVersion:null,isLegacyScore:false,maxCombo:0,accuracy:0,rank:0,pp:null,mods:null,statistics:null,maximumStatistics:null,
  replay:{status:"available",path:"D:\\Native\\files\\a\\aa\\"+"a".repeat(64),sha256:location.sha256,bytes:1},beatmap:{status:"missing"},assets:[],assetManifestComplete:true};
describe("native declaration through the real passive byte reader",()=>{
  let root:string;
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0RkAAAAASUVORK5CYII=","base64");
  beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"native-art-declaration-"));});
  afterEach(async()=>{if(!root.startsWith(join(tmpdir(),"native-art-declaration-")))throw Error("Unexpected native fixture");await rm(root,{recursive:true,force:true});});
  async function fixture(status:LazerSourceScore["beatmap"]["status"]="unverified"){
    const blob=async(bytes:Buffer)=>{const sha256=createHash("sha256").update(bytes).digest("hex"),path=join(root,"files",sha256[0],sha256.slice(0,2),sha256);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);return{status:"unverified" as const,sha256,path,bytes:bytes.length};};
    const mapBytes=Buffer.from('osu file format v14\n[Events]\n0,0,"bg.png",0,0\n'),mapBlob=await blob(mapBytes),asset=await blob(png),md5=createHash("md5").update(mapBytes).digest("hex");
    const ticket={...nativeLocation,directory:root,metadata:{header:{beatmapMD5:md5}}};
    const score:LazerSourceScore={...nativeScore,replay:{...nativeScore.replay,status:"unverified"},beatmap:{...mapBlob,status,md5},assets:[{name:"bg.png",resource:asset}]};
    const native={request:jest.fn(async()=>score),close:jest.fn(async()=>undefined)},thumbnail=jest.fn(async(bytes:Buffer)=>bytes);
    const selector=createLibraryPassiveSelector({metadata:async(method)=>method==="prepare-open"?{items:[ticket]}:method==="prepare-map"?{items:[]}:true,createNative:()=>native,thumbnail});
    return{reader:new LibraryPassiveResources(selector),selector,score,native,thumbnail,mapBlob,asset};
  }
  it.each(["unverified","available"] as const)("verifies a producer %s map and asset before delivering exact PNG bytes",async status=>{
    const f=await fixture(status);expect(await f.reader.artwork("r",new AbortController().signal)).toEqual(png);
    expect(f.native.request).toHaveBeenCalledWith("resolve-passive-artwork",{sessionId:expect.any(String),ticket:expect.objectContaining({directory:root})});
    expect(f.native.close).toHaveBeenCalledTimes(1);expect(f.thumbnail).toHaveBeenCalledTimes(1);
  });
  it.each(["missing","corrupt","invalid","resource-limit","busy","inaccessible"] as const)("does not admit a %s native map declaration",async status=>{
    const f=await fixture(status);expect(await f.reader.artwork("r",new AbortController().signal)).toBeUndefined();expect(f.thumbnail).not.toHaveBeenCalled();
  });
  it("does not admit conflicting replay/map MD5 declarations",async()=>{
    const f=await fixture();f.score.beatmap.md5="e".repeat(32);expect(await f.reader.artwork("r",new AbortController().signal)).toBeUndefined();expect(f.thumbnail).not.toHaveBeenCalled();
  });
  it.each(["map-digest","asset-digest","map-path","asset-path"])("rejects changed or unbound %s before publication",async fault=>{
    const f=await fixture();
    if(fault==="map-digest")await writeFile(f.mapBlob.path,"changed map");
    if(fault==="asset-digest")await writeFile(f.asset.path,Buffer.concat([png,Buffer.from("changed")]));
    if(fault.endsWith("path")){const outside=join(root,"elsewhere");await writeFile(outside,png);if(fault==="map-path")f.score.beatmap.path=outside;else f.score.assets[0].resource.path=outside;}
    await expect(f.reader.artwork("r",new AbortController().signal)).rejects.toThrow(fault.endsWith("path")?/managed-file/:/digest/);expect(f.thumbnail).not.toHaveBeenCalled();
  });
});
describe("verified Stable shortcut for native artwork",()=>{
  const decode=async(bytes:Buffer)=>{if(bytes.length<=24)throw Error("Invalid artwork image");return bytes;};
  let root:string;
  beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),"passive-stable-preference-"));});
  afterEach(async()=>{if(!root.startsWith(join(tmpdir(),"passive-stable-preference-")))throw Error("Unexpected selector fixture");await rm(root,{recursive:true,force:true});});
  async function fixture(){
    const songs=join(root,"Songs"),path=join(songs,"map.osu"),bytes=Buffer.from("osu file format v14\n[Events]\n0,0,\"bg.png\",0,0\n");
    await mkdir(songs);await writeFile(path,bytes);
    await writeFile(join(songs,"bg.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0RkAAAAASUVORK5CYII=","base64"));
    const md5=createHash("md5").update(bytes).digest("hex"),ticket={...nativeLocation,metadata:{header:{beatmapMD5:md5}}};
    return{ticket,indexed:{...map,md5,locator:path,metadata:{songsRoot:songs}},bytes};
  }
  it("avoids a native resolver only after exact map bytes and both indexed leases verify",async()=>{
    const {ticket,indexed}=await fixture(),metadata=jest.fn(async(method:LibraryOperation)=>method==="prepare-open"?{items:[ticket]}:method==="prepare-map"?{items:[indexed]}:true);
    const createNative=jest.fn(()=>({request:async()=>nativeScore,close:async()=>undefined}));
    const artworkCache=new LibraryArtworkCache(),thumbnail=jest.fn(decode);
    const selector=createLibraryPassiveSelector({metadata,createNative,artworkCache,thumbnail}),selection=await selector.select("r","artwork",new AbortController().signal);
    expect(selection?.map).toEqual({kind:"stable",songsRoot:indexed.metadata.songsRoot,path:indexed.locator,md5:indexed.md5});
    expect(createNative).not.toHaveBeenCalled();
    expect(metadata.mock.calls.filter(([method])=>method==="resource-current")).toHaveLength(2);
    if(!selection)throw Error("Expected verified Stable selection");expect(await selector.isCurrent(selection)).toBe(true);
    expect(await new LibraryPassiveResources(selector,artworkCache).artwork("r",new AbortController().signal)).toBeInstanceOf(Buffer);
    expect(thumbnail).toHaveBeenCalledTimes(1);expect(createNative).not.toHaveBeenCalled();
  });
  it.each(["digest","lease","lease-after-read","root","identity","missing-image","invalid-image","truncated-png"])("does not prefer an unqualified Stable %s over the native resolver",async(reason)=>{
    const {ticket,indexed}=await fixture();
    if(reason==="digest")await writeFile(indexed.locator,"changed map");
    if(reason==="root")indexed.metadata.songsRoot=join(root,"Other");
    if(reason==="identity")indexed.md5="d".repeat(32);
    if(reason==="missing-image")await rm(join(indexed.metadata.songsRoot,"bg.png"));
    if(reason==="invalid-image")await writeFile(join(indexed.metadata.songsRoot,"bg.png"),"not an image");
    if(reason==="truncated-png")await writeFile(join(indexed.metadata.songsRoot,"bg.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB","base64"));
    const native={request:jest.fn(async()=>({...nativeScore,beatmap:{status:"available",path:"D:\\Native\\files\\b\\bb\\blob",sha256:"b".repeat(64),md5:ticket.metadata.header.beatmapMD5}})),close:jest.fn(async()=>undefined)};
    let currentChecks=0;
    const metadata=jest.fn(async(method:LibraryOperation)=>method==="prepare-open"?{items:[ticket]}:method==="prepare-map"?{items:[indexed]}:reason!=="lease"&&(reason!=="lease-after-read"||++currentChecks===1));
    const thumbnail=jest.fn(decode),selector=createLibraryPassiveSelector({metadata,createNative:()=>native,thumbnail});
    expect((await selector.select("r","artwork",new AbortController().signal))?.map?.kind).toBe("lazer");
    expect(native.request).toHaveBeenCalledTimes(1);expect(native.close).toHaveBeenCalledTimes(1);
    if(reason==="truncated-png")expect(thumbnail).toHaveBeenCalledTimes(1);
  });
  it("drains shortcut decoding before reporting cancellation and never starts native fallback",async()=>{
    const {ticket,indexed}=await fixture(),controller=new AbortController(),cancelled=Error("cancelled shortcut");
    const metadata=async(method:LibraryOperation)=>method==="prepare-open"?{items:[ticket]}:method==="prepare-map"?{items:[indexed]}:true;
    let finish!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    const thumbnail=(bytes:Buffer)=>new Promise<Buffer>(resolve=>{finish=()=>resolve(bytes);entered();}),createNative=jest.fn();
    const selector=createLibraryPassiveSelector({metadata,createNative,thumbnail});let settled=false;
    const work=selector.select("r","artwork",controller.signal).catch(error=>error).then(value=>{settled=true;return value;});
    await started;controller.abort(cancelled);await Promise.resolve();expect(settled).toBe(false);finish();
    expect(await work).toBe(cancelled);expect(createNative).not.toHaveBeenCalled();
  });
});
it("selects indexed Stable artwork and checks exact read-only leases without admitting work",async()=>{
  const metadata=jest.fn(async(method:LibraryOperation)=>method==="prepare-open"?{items:[location]}:method==="prepare-map"?{items:[map]}:method==="resource-current"),
    createNative=jest.fn(),selector=createLibraryPassiveSelector({metadata,createNative});
  const selected=await selector.select("r","artwork",new AbortController().signal);
  expect(selected?.map).toMatchObject({kind:"stable",md5:map.md5,path:map.locator});if(!selected)throw Error("Expected Stable selection");expect(await selector.isCurrent(selected)).toBe(true);
  expect(metadata.mock.calls.map(([method])=>method)).toEqual(["prepare-open","prepare-map","resource-current"]);expect(createNative).not.toHaveBeenCalled();
});
it("can reveal a verified indexed file without map reads or native work",async()=>{
  const metadata=jest.fn(async()=>({items:[location]})),createNative=jest.fn(),selector=createLibraryPassiveSelector({metadata,createNative});
  expect((await selector.select("r","reveal",new AbortController().signal))?.replay).toEqual({root:location.directory,path:location.locator,sha256:location.sha256});
  expect(metadata).toHaveBeenCalledTimes(1);expect(createNative).not.toHaveBeenCalled();
});
it("does not return a native manifest until its actual resource owner closes",async()=>{
  let close!:()=>void;const drained=new Promise<void>(resolve=>{close=resolve;}),native={request:jest.fn(async()=>({id:"r",replay:{sha256:location.sha256},beatmap:{status:"available",path:"D:\\Native\\files\\b\\bb\\blob",sha256:"b".repeat(64),md5:map.md5},assets:[],assetManifestComplete:true})),close:jest.fn(()=>drained)};
  const selector=createLibraryPassiveSelector({metadata:async()=>({items:[{...location,kind:"lazer",directory:"D:\\Native"}]}),createNative:()=>native});
  let settled=false;const selected=selector.select("r","artwork",new AbortController().signal).then(value=>{settled=true;return value;});
  await Promise.resolve();await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);close();expect((await selected)?.map?.kind).toBe("lazer");expect(native.close).toHaveBeenCalledTimes(1);
});
it("resolves a native UUID for Reveal only after the actual owner closes",async()=>{
  let close!:()=>void;const drained=new Promise<void>(resolve=>{close=resolve;});
  const metadata=jest.fn(async()=>({items:[nativeLocation]})),native={request:jest.fn(async()=>nativeScore),close:jest.fn(()=>drained)};
  const selector=createLibraryPassiveSelector({metadata,createNative:()=>native});
  let settled=false;const selected=selector.select("r","reveal",new AbortController().signal).then(value=>{settled=true;return value;});
  await Promise.resolve();await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);
  close();const result=await selected;
  expect(result?.replay).toEqual({root:"D:\\Native",path:"D:\\Native\\files\\a\\aa\\"+"a".repeat(64),sha256:"a".repeat(64)});
  expect(result?.map).toBeUndefined();expect(native.close).toHaveBeenCalledTimes(1);
  expect(native.request).toHaveBeenCalledWith("resolve-passive-native",{sessionId:expect.any(String),ticket:nativeLocation});
  expect(metadata).toHaveBeenCalledTimes(1);
});
it.each(["id","sha256"])("rejects a native Reveal whose %s no longer matches the indexed ticket",async(field)=>{
  const score={...nativeScore,...(field==="id"?{id:"22345678-1234-1234-1234-123456789abc"}:{replay:{...nativeScore.replay,sha256:"b".repeat(64)}})};
  const native={request:async()=>score,close:jest.fn(async()=>undefined)},selector=createLibraryPassiveSelector({metadata:async()=>({items:[nativeLocation]}),createNative:()=>native});
  await expect(selector.select("r","reveal",new AbortController().signal)).rejects.toThrow("Passive native score changed");
  expect(native.close).toHaveBeenCalledTimes(1);
});
it.each(["resolve","cancel"])("marks an unconfirmed native close as uncertain after %s",async(mode)=>{
  const controller=new AbortController(),cancelled=new Error("cancelled");
  const native={request:async()=>{if(mode==="cancel")controller.abort(cancelled);return nativeScore;},close:jest.fn(async()=>{throw Error("unconfirmed helper exit");})};
  const selector=createLibraryPassiveSelector({metadata:async()=>({items:[nativeLocation]}),createNative:()=>native});
  await expect(selector.select("r","artwork",controller.signal)).rejects.toBeInstanceOf(LibraryNativeDrainError);
  expect(native.close).toHaveBeenCalledTimes(1);
});
it("continues to indexed Stable artwork after an ordinarily unavailable native resolver drains",async()=>{
  const native={request:async()=>{throw Error("source unavailable");},close:jest.fn(async()=>undefined)};
  const selector=createLibraryPassiveSelector({metadata:async(method)=>method==="prepare-open"?{items:[nativeLocation]}:{items:[map]},createNative:()=>native});
  expect((await selector.select("r","artwork",new AbortController().signal))?.map).toEqual({kind:"stable",songsRoot:"D:\\Songs",path:map.locator,md5:map.md5});
  expect(native.close).toHaveBeenCalledTimes(1);
});
it("keeps explicit cancellation after a native request drains successfully",async()=>{
  const controller=new AbortController(),cancelled=new Error("cancelled");
  const native={request:async()=>{controller.abort(cancelled);throw Error("source unavailable");},close:jest.fn(async()=>undefined)};
  const selector=createLibraryPassiveSelector({metadata:async()=>({items:[nativeLocation]}),createNative:()=>native});
  await expect(selector.select("r","artwork",controller.signal)).rejects.toBe(cancelled);expect(native.close).toHaveBeenCalledTimes(1);
});
it("does not return a selection cancelled while the actual native owner is closing",async()=>{
  const controller=new AbortController(),cancelled=new Error("cancelled during close");
  let close!:()=>void,closing!:()=>void;const drained=new Promise<void>(resolve=>{close=resolve;}),started=new Promise<void>(resolve=>{closing=resolve;});
  const native={request:async()=>nativeScore,close:()=>{closing();return drained;}};
  const selector=createLibraryPassiveSelector({metadata:async()=>({items:[nativeLocation]}),createNative:()=>native});
  const selected=selector.select("r","reveal",controller.signal);await started;controller.abort(cancelled);close();
  await expect(selected).rejects.toBe(cancelled);
});
it("does not fall back to Stable after native ownership becomes uncertain",async()=>{
  let callsAtNative=0;const uncertain=new LibraryNativeDrainError("unconfirmed helper exit"),native={request:async()=>{callsAtNative=metadata.mock.calls.length;throw uncertain;},close:async()=>undefined};
  const metadata=jest.fn(async(method:LibraryOperation)=>method==="prepare-open"?{items:[nativeLocation]}:{items:[map]});
  const selector=createLibraryPassiveSelector({metadata,createNative:()=>native});
  await expect(selector.select("r","artwork",new AbortController().signal)).rejects.toBe(uncertain);
  expect(callsAtNative).toBeGreaterThan(0);expect(metadata).toHaveBeenCalledTimes(callsAtNative);
});
