import { LibraryResourceServer } from "./library-resource-server";
import { LibraryResourceSessions } from "./library-resource-sessions";
import type { LibraryOpenLocation } from "./library-store";
import type { LibraryIncidentEvidenceProbe } from "./library-incidents-probe";
import type { LazerSourceInspection } from "./sources/lazer-source";
import * as selectedResources from "./library-selected-resources";
import { mkdtemp,mkdir,writeFile,rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname,join } from "path";
import { createHash } from "crypto";

const ticket: LibraryOpenLocation = { replayId: "one", sourceId: "imports", sourceKey: "a".repeat(64), locator: "D:\\owned\\one.osr",
  sha256: "a".repeat(64), locationRevision: 1, sourceConfigRevision: 1, kind: "imported", directory: "D:\\owned", metadata: {} };
const resource = { bytes: Buffer.from("map"), md5: "b".repeat(32), sha256: "c".repeat(64),
  stamp: { bytes: 3, device: "1", inode: "2", modifiedNs: "3", changedNs: "4" } };
function fixture() {
  const messages: { id: string; ok: boolean; data?: unknown; error?: string }[] = [];
  const prepareReplay = jest.fn(async () => ({ ticket, data: { gameMode: 0, gameVersion: 20260101, beatmapMD5: "b".repeat(32),
    replayContentSha256: ticket.sha256!, playerName: "P", replayMD5: "hash", number_300s: 0, number_100s: 0, number_50s: 0,
    misses: 0, score: 0, max_combo: 0, perfect_combo: 0, mods: 0, replay_data: "0|1|2|0,", life_bar: "" },
    receipt: { sha256: ticket.sha256, available: true, metadata: {} } }));
  const close = jest.fn(async () => undefined);
  const probeIncidentEvidence = jest.fn(async (): Promise<LibraryIncidentEvidenceProbe> => ({
    evidence: { version: 1, state: "absent", replaySha256: ticket.sha256!, mapMd5: "b".repeat(32), validationVersion: "library-saved-evidence-v1" },
    scope: "stable-sidecar", observation: { sha256: ticket.sha256, available: true, metadata: {} }, origin: null }));
  const factory = jest.fn((config?: {background?:boolean}) => new LibraryResourceSessions({ prepareReplay, prepareMap: async () => ({ map: resource,
    storyboards: [], assetManifestComplete: true, readAsset: async () => resource }), close, probeIncidentEvidence },{background:config?.background}));
  const server = new LibraryResourceServer(value => messages.push(value), factory);
  const request = async (id: string, method: string, args = {}) => { await server.receive({ version: 1, id, method, args }); return messages.at(-1)!; };
  return { messages, factory, server, request, prepareReplay, probeIncidentEvidence, close };
}
it.each([false,true])("keeps saved cause discovery and media manifests exclusive to foreground resources, background=%s",async background=>{
  const prepared=await fixture().prepareReplay();
  const prepare=jest.spyOn(selectedResources,"prepareLibraryReplay").mockResolvedValue(prepared as selectedResources.PreparedLibraryReplay);
  const messages:{ok:boolean;error?:string}[]=[],server=new LibraryResourceServer(value=>messages.push(value));
  try{
    await server.receive({version:1,id:"init",method:"initialize",args:{nativeExecutable:"D:\\unused-engine.exe",originFile:"D:\\unused-origins.json",background}});
    if(background)await server.receive({version:1,id:"resume",method:"control",args:{viewerDemand:false,userPaused:false}});
    await server.receive({version:1,id:"begin",method:"begin",args:{sessionId:"one",ticket}});
    expect(messages.at(-1)).toMatchObject({ok:true});expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][6]).toEqual({savedCauseEvidence:!background,includeAssets:!background});
  }finally{await server.close();prepare.mockRestore();}
});
it("initializes lazily and serves only ticketed resources over bounded binary replies", async () => {
  const f = fixture(); expect(f.factory).not.toHaveBeenCalled();
  expect(await f.request("before", "begin", { sessionId: "one", ticket })).toMatchObject({ ok: false });
  expect(await f.request("init", "initialize", { nativeExecutable: "D:\\engine.exe", originFile: "D:\\owned\\replay-origins.json" })).toMatchObject({ ok: true });
  expect(await f.request("begin", "begin", { sessionId: "one", ticket })).toMatchObject({ ok: true, data: { sessionId: "one" } });
  expect(await f.request("map", "prepare-map", { sessionId: "one" })).toMatchObject({ ok: true });
  const opened = await f.request("transfer", "transfer", { sessionId: "one", kind: "map" });
  const id = (opened.data as { id: string }).id;
  const chunk = await f.request("chunk", "chunk", { sessionId: "one", transferId: id, offset: 0 });
  expect(chunk).toMatchObject({ ok: true, data: { bytes: Uint8Array.from(resource.bytes), done: true } });
  expect(await f.request("wrong", "read-file", { path: "D:\\anything" })).toMatchObject({ ok: false });
  await f.server.close(); expect(f.close).toHaveBeenCalledTimes(1);
});
it("rejects malformed tickets and extra-large messages before resource work", async () => {
  const f = fixture(); await f.request("init", "initialize", { nativeExecutable: "D:\\engine.exe", originFile: "D:\\origins.json" });
  for (const [index, patch] of [{ sourceConfigRevision: -1 }, { sha256: "bad" }, { kind: "files" }, { metadata: { large: "x".repeat(65537) } }].entries())
    expect(await f.request("bad" + index, "begin", { sessionId: "one", ticket: { ...ticket, ...patch } })).toMatchObject({ ok: false });
  expect(f.prepareReplay).not.toHaveBeenCalled(); await f.server.close();
});
it("lets release and shutdown overtake blocked resource preparation", async () => {
  const f = fixture(); let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.prepareReplay.mockImplementationOnce(async (_ticket?: unknown, signal?: AbortSignal) => {
    entered(); await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled"))));
    throw new Error("unreachable");
  });
  await f.request("init", "initialize", { nativeExecutable: "D:\\engine.exe", originFile: "D:\\origins.json" });
  const preparing = f.request("begin", "begin", { sessionId: "one", ticket }); await started;
  await f.request("release", "release", { sessionId: "one" }); await preparing;
  expect(f.messages.find(item => item.id === "begin")).toMatchObject({ ok: false, error: "cancelled" });
  await f.server.close();
});

it("keeps background controls independent and rejects foreground or malformed control requests",async()=>{
  const background=fixture(),foreground=fixture();
  await background.request("init","initialize",{nativeExecutable:"D:\\engine.exe",originFile:"D:\\origins.json",background:true});
  await foreground.request("init","initialize",{nativeExecutable:"D:\\engine.exe",originFile:"D:\\origins.json"});
  const pending=background.request("begin","begin",{sessionId:"one",ticket});
  try {
    await new Promise(resolve=>setTimeout(resolve,5));expect(background.prepareReplay).not.toHaveBeenCalled();
    expect(await foreground.request("control","control",{viewerDemand:true,userPaused:false})).toMatchObject({ok:false,error:expect.stringMatching(/Foreground/)});
    expect(await foreground.request("begin","begin",{sessionId:"current",ticket})).toMatchObject({ok:true});
    expect(await background.request("bad","control",{viewerDemand:"false",userPaused:false})).toMatchObject({ok:false});
    expect(await background.request("resume","control",{viewerDemand:false,userPaused:false})).toMatchObject({ok:true});
    expect(await pending).toMatchObject({ok:true});
  }finally{await background.server.close();await foreground.server.close();await pending;}
});

it("rejects retired incident probes before opening resources", async () => {
  const f = fixture(); await f.request("init", "initialize", { nativeExecutable: "D:\\engine.exe", originFile: "D:\\origins.json", background: true });
  await f.request("resume", "control", { viewerDemand: false, userPaused: false });
  try {
    for (let index = 0; index < 2; index++) expect(await f.request("probe" + index, "probe-incident-evidence", { sessionId: "probe", ticket }))
      .toMatchObject({ ok: false });
    expect(f.probeIncidentEvidence).not.toHaveBeenCalled(); expect(f.prepareReplay).not.toHaveBeenCalled();
    expect(await f.request("bad", "probe-incident-evidence", { sessionId: "probe", ticket: { ...ticket, sha256: null } })).toMatchObject({ ok: false });
    expect(f.probeIncidentEvidence).not.toHaveBeenCalled();
  } finally { await f.server.close(); }
});

describe("passive native metadata resolution", () => {
  const nativeTicket: LibraryOpenLocation = { ...ticket, kind: "lazer", directory: "D:\\lazer", sourceKey: "12345678-1234-1234-1234-123456789abc", locator: "12345678-1234-1234-1234-123456789abc" };
  function passiveFixture() {
    const messages: { id: string; ok: boolean; data?: unknown; error?: string }[] = [];
    const resolveScore = jest.fn(async (): Promise<LazerSourceInspection> => ({ version: 1, ok: true, status: "ready", scores: [{ id: nativeTicket.sourceKey,
      replay: { sha256: nativeTicket.sha256 }, assets: [{ name: "background.jpg", resource: { status: "unverified", sha256: "d".repeat(64), path: "D:\\lazer\\art" } }],
      assetManifestComplete: true } as never] }));
    const nativeClose = jest.fn(async () => undefined), createNative = jest.fn(() => ({ resolveScore, resolveArtwork:resolveScore, close: nativeClose }));
    const admission = { run: async <T>(_phase: unknown, work: () => Promise<T>) => work() };
    const resources = fixture();
    const server = new LibraryResourceServer(value => messages.push(value), resources.factory, admission, createNative);
    const request = async (id: string, method: string, args = {}) => { await server.receive({ version: 1, id, method, args }); const result = messages.find(value => value.id === id); if (!result) throw Error("Missing fixture reply"); return result; };
    return { server, request, createNative, resolveScore, nativeClose, resources };
  }
  it("requires broker admission and a known native identity, returns one metadata score without replay preparation", async () => {
    const f = passiveFixture(); await f.request("init", "initialize", { nativeExecutable: "D:\\engine.exe", originFile: "D:\\origins.json", background: true, nativeAdmission: true });
    try {
      for (const [i, patch] of [{ kind: "stable" }, { sha256: null }, { sourceKey: "not-an-id" }].entries())
        expect(await f.request("bad" + i, "resolve-passive-native", { sessionId: "art", ticket: { ...nativeTicket, ...patch } })).toMatchObject({ ok: false });
      expect(f.resolveScore).not.toHaveBeenCalled();
      expect(await f.request("resolve", "resolve-passive-native", { sessionId: "art", ticket: nativeTicket })).toMatchObject({ ok: true,
        data: { id: nativeTicket.sourceKey, assetManifestComplete: true, assets: [{ name: "background.jpg" }] } });
      expect(f.resolveScore).toHaveBeenCalledWith(nativeTicket.directory, nativeTicket.sourceKey, nativeTicket.sha256, expect.any(AbortSignal));
      expect(f.resources.prepareReplay).not.toHaveBeenCalled();
    } finally { await f.server.close(); }
    expect(f.nativeClose).toHaveBeenCalledTimes(1);
    const unbrokered = passiveFixture(); await unbrokered.request("init", "initialize", { nativeExecutable: "D:\\engine.exe", originFile: "D:\\origins.json" });
    expect(await unbrokered.request("resolve", "resolve-passive-native", { sessionId: "art", ticket: nativeTicket })).toMatchObject({ ok: false });
    expect(unbrokered.createNative).not.toHaveBeenCalled(); await unbrokered.server.close();
  });
  it("release waits for the native operation to settle after cancellation", async () => {
    const f = passiveFixture(); let entered!: () => void, finish!: () => void; const started = new Promise<void>(done => { entered = done; });
    const drained = new Promise<void>(done => { finish = done; }); let aborted = false;
    f.resolveScore.mockImplementationOnce(async (_directory?: unknown, _id?: unknown, _sha?: unknown, signal?: AbortSignal) => {
      signal?.addEventListener("abort", () => { aborted = true; }); entered(); await drained; throw Error("cancelled");
    });
    await f.request("init", "initialize", { nativeExecutable: "D:\\engine.exe", originFile: "D:\\origins.json", background: true, nativeAdmission: true });
    const pending = f.request("resolve", "resolve-passive-native", { sessionId: "art", ticket: nativeTicket }); await started;
    let released = false; const release = f.request("release", "release", { sessionId: "art" }).then(value => { released = true; return value; });
    await Promise.resolve(); expect(aborted).toBe(true); expect(released).toBe(false);
    expect(await f.request("busy", "resolve-passive-native", { sessionId: "other", ticket: nativeTicket })).toMatchObject({ ok: false });
    finish(); expect(await pending).toMatchObject({ ok: false }); expect(await release).toMatchObject({ ok: true }); await f.server.close();
  });
  it("rejects changed replay identity and propagates uncertain native close", async () => {
    const f = passiveFixture(); await f.request("init", "initialize", { nativeExecutable: "D:\\engine.exe", originFile: "D:\\origins.json", background: true, nativeAdmission: true });
    f.resolveScore.mockResolvedValueOnce({ version: 1, ok: false, status: "source-changed" });
    expect(await f.request("resolve", "resolve-passive-native", { sessionId: "art", ticket: nativeTicket })).toMatchObject({ ok: false });
    f.nativeClose.mockRejectedValueOnce(Error("Native helper exit is unconfirmed"));
    await expect(f.server.close()).rejects.toThrow("unconfirmed");
  });
});
describe("targeted passive artwork operation",()=>{
  let directory:string;
  beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),"targeted-artwork-"));});
  afterEach(async()=>{if(!directory.startsWith(join(tmpdir(),"targeted-artwork-")))throw Error("Unexpected fixture");await rm(directory,{recursive:true,force:true});});
  async function setup(background=true){
    const bytes=Buffer.from(`osu file format v14\n[Events]\n${background?'0,0,"BG.png",0,0\n':''}`),sha256=createHash("sha256").update(bytes).digest("hex"),md5=createHash("md5").update(bytes).digest("hex"),path=join(directory,"files",sha256[0],sha256.slice(0,2),sha256);
    await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);
    const nativeTicket={...ticket,directory,kind:"lazer" as const,sourceKey:"12345678-1234-1234-1234-123456789abc",metadata:{header:{beatmapMD5:md5}}};
    const score={id:nativeTicket.sourceKey,replay:{status:"unverified",sha256:ticket.sha256},beatmap:{status:"unverified",sha256,md5,path},assets:[],assetManifestComplete:false};
    const resolveScore=jest.fn(async()=>({version:1,ok:true,status:"ready",scores:[score]} as unknown as LazerSourceInspection));
    const lookup={name:"BG.png",mapSha256:sha256,mapMd5:md5,complete:true};
    const resolveArtwork=jest.fn(async()=>({version:1,ok:true,status:"ready",scores:[{...score,artworkLookup:lookup}]} as unknown as LazerSourceInspection)),close=jest.fn(async()=>undefined);
    const messages:{id:string;ok:boolean;data?:unknown;error?:string}[]=[],resources=fixture();
    const server=new LibraryResourceServer(value=>messages.push(value),resources.factory,{run:async<T>(_phase:unknown,work:()=>Promise<T>)=>work()},()=>({resolveScore,resolveArtwork,close}));
    const request=async(id:string,method:string,args={})=>{await server.receive({version:1,id,method,args});return messages.find(value=>value.id===id);};
    await request("init","initialize",{nativeExecutable:"D:\\engine.exe",originFile:"D:\\origins.json",background:true,nativeAdmission:true});
    return{server,request,nativeTicket,score,path,lookup,resolveScore,resolveArtwork,resources};
  }
  it("verifies only the declared map and requests its exact background without a full manifest",async()=>{
    const f=await setup();try{
      expect(await f.request("art","resolve-passive-artwork",{sessionId:"art",ticket:f.nativeTicket})).toMatchObject({ok:true,data:{assets:[],assetManifestComplete:false,artworkLookup:f.lookup}});
      expect(f.resolveScore).toHaveBeenCalledWith(directory,f.nativeTicket.sourceKey,ticket.sha256,expect.any(AbortSignal),{includeAssets:false});
      expect(f.resolveArtwork).toHaveBeenCalledWith(directory,f.nativeTicket.sourceKey,ticket.sha256,{mapSha256:f.score.beatmap.sha256,mapMd5:f.score.beatmap.md5,name:"BG.png"},expect.any(AbortSignal));
      expect(f.resources.prepareReplay).not.toHaveBeenCalled();
    }finally{await f.server.close();}
  });
  it("does not look up assets when the verified map has no background",async()=>{const f=await setup(false);try{expect(await f.request("art","resolve-passive-artwork",{sessionId:"art",ticket:f.nativeTicket})).toMatchObject({ok:true,data:{assets:[],assetManifestComplete:false}});expect(f.resolveArtwork).not.toHaveBeenCalled();}finally{await f.server.close();}});
  it("rejects changed map bytes before requesting an asset",async()=>{const f=await setup();try{await writeFile(f.path,"changed");expect(await f.request("art","resolve-passive-artwork",{sessionId:"art",ticket:f.nativeTicket})).toMatchObject({ok:false});expect(f.resolveArtwork).not.toHaveBeenCalled();}finally{await f.server.close();}});
  it.each(["name","mapSha256","mapMd5","complete"])("rejects a mismatched targeted %s receipt",async field=>{const f=await setup();try{Object.assign(f.lookup,{[field]:field==="complete"?false:"wrong"});expect(await f.request("art","resolve-passive-artwork",{sessionId:"art",ticket:f.nativeTicket})).toMatchObject({ok:false});}finally{await f.server.close();}});
  it("release waits for the active second-phase helper to drain",async()=>{
    const f=await setup();let enter!:()=>void,finish!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),drained=new Promise<void>(r=>{finish=r;});let aborted=false;
    f.resolveArtwork.mockImplementationOnce(async(...args:unknown[])=>{const signal=args[4] as AbortSignal;signal.addEventListener("abort",()=>{aborted=true;});enter();await drained;throw signal.reason;});
    const work=f.request("art","resolve-passive-artwork",{sessionId:"art",ticket:f.nativeTicket});await entered;
    let released=false;const release=f.request("release","release",{sessionId:"art"}).then(()=>{released=true;});await Promise.resolve();expect(aborted).toBe(true);expect(released).toBe(false);
    finish();expect(await work).toMatchObject({ok:false});await release;await f.server.close();
  });
  it("applies one 15-second deadline across phases and still waits for confirmed drain",async()=>{
    const f=await setup();jest.useFakeTimers({doNotFake:["setImmediate","nextTick"]});
    let enter!:()=>void,finish!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),drained=new Promise<void>(r=>{finish=r;});let aborted=false;
    f.resolveArtwork.mockImplementationOnce(async(...args:unknown[])=>{const signal=args[4] as AbortSignal;signal.addEventListener("abort",()=>{aborted=true;});enter();await drained;throw signal.reason;});
    let settled=false;const work=f.request("art","resolve-passive-artwork",{sessionId:"art",ticket:f.nativeTicket}).then(value=>{settled=true;return value;});
    try{await entered;jest.advanceTimersByTime(14_999);expect(aborted).toBe(false);jest.advanceTimersByTime(1);expect(aborted).toBe(true);await Promise.resolve();expect(settled).toBe(false);
      finish();expect(await work).toMatchObject({ok:false,error:expect.stringMatching(/timed out/)});
    }finally{finish?.();await work;await f.server.close();jest.useRealTimers();}
  });
});
