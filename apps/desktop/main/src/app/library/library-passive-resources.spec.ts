import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { createHash } from "crypto";
import { LibraryPassiveResources, LibraryPassiveSelection } from "./library-passive-resources";
import { LibraryPassiveResourceApi } from "./library-passive-resource-api";
import { LibraryPassiveResourceClient } from "../../../../frontend/src/app/services/library/library-passive-resource-client";
import { LibraryNativeDrainError } from "./library-native-admission";
import { LibraryArtworkCache } from "./library-artwork-cache";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0RkAAAAASUVORK5CYII=", "base64");
const hash = (bytes: Buffer, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const signal = () => new AbortController().signal;
describe("passive selected resources", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "rewind-passive-")); });
  afterEach(async () => { if (!root.startsWith(join(tmpdir(), "rewind-passive-"))) throw Error("Unexpected fixture path"); await rm(root, { recursive: true, force: true }); });
  async function stable(name = "bg, image.png") {
    const folder = join(root, "Songs", "map"); await mkdir(folder, { recursive: true });
    const map = Buffer.from(`osu file format v14\n[Events]\n0,0,"${name}",0,0\n[HitObjects]\n`), path = join(folder, "map.osu");
    await writeFile(path, map); await writeFile(join(folder, "bg, image.png"), png);
    return { replayId: "r", revision: "1", map: { kind: "stable" as const, songsRoot: join(root, "Songs"), path, md5: hash(map, "md5") } };
  }
  function resources(selection: LibraryPassiveSelection, current = async () => true) {
    return new LibraryPassiveResources({ select: async () => selection, isCurrent: current, readStrip: async () => undefined, thumbnail: async bytes => bytes });
  }
  it("reads the exact quoted map background without needing a replay or simulation", async () => {
    expect(await resources(await stable()).artwork("r", signal())).toEqual(png);
  });
  it("reuses a verified thumbnail across plays without skipping current source checks", async () => {
    const selected=await stable(),current=jest.fn(async()=>true),thumbnail=jest.fn(async(bytes:Buffer)=>bytes);
    const reader=new LibraryPassiveResources({select:async()=>selected,isCurrent:current,readStrip:async()=>undefined,thumbnail});
    expect(await reader.artwork("r",signal())).toEqual(png);
    expect(await reader.artwork("another-play",signal())).toEqual(png);
    expect(thumbnail).toHaveBeenCalledTimes(1);expect(current.mock.calls.length).toBeGreaterThanOrEqual(6);
    await writeFile(selected.map.path,"changed");await expect(reader.artwork("r",signal())).rejects.toThrow(/digest/);
    expect(thumbnail).toHaveBeenCalledTimes(1);
  });
  it.each([" ","\t","\ufeff \t"])("accepts verified map header whitespace %j without changing the map digest",async prefix=>{
    const selected=await stable(),map=Buffer.from(`${prefix}osu file format v14\n[Events]\n0,0,"bg, image.png",0,0\n`);
    await writeFile(selected.map.path,map);selected.map.md5=hash(map,"md5");
    expect(await resources(selected).artwork("r",signal())).toEqual(png);
  });
  it("shares a transform while cancellation drains only the cancelled consumer",async()=>{
    const selected=await stable(),cache=new LibraryArtworkCache(),controller=new AbortController(),cancelled=Error("consumer cancelled");
    let finish!:(bytes:Buffer)=>void;
    const thumbnail=jest.fn(()=>new Promise<Buffer>(resolve=>{finish=resolve;}));
    const reader=new LibraryPassiveResources({select:async()=>selected,isCurrent:async()=>true,readStrip:async()=>undefined,thumbnail},cache);
    let settled=false;const first=reader.artwork("a",controller.signal).catch(error=>error).then(value=>{settled=true;return value;});
    const second=reader.artwork("b",signal());
    for(let n=0;cache.status().deduplicated===0&&n<1000;n++)await new Promise(resolve=>setImmediate(resolve));
    expect(cache.status().deduplicated).toBe(1);controller.abort(cancelled);await Promise.resolve();expect(settled).toBe(false);
    finish(png);expect(await first).toBe(cancelled);expect(await second).toEqual(png);expect(thumbnail).toHaveBeenCalledTimes(1);expect(cache.status().pending).toBe(0);
  });
  it("uses changed verified image bytes as a new cache identity",async()=>{
    const selected=await stable(),thumbnail=jest.fn(async(bytes:Buffer)=>bytes);
    const reader=new LibraryPassiveResources({select:async()=>selected,isCurrent:async()=>true,readStrip:async()=>undefined,thumbnail});
    await reader.artwork("a",signal());const changed=Buffer.concat([png,Buffer.from("different ancillary bytes")]);
    await writeFile(join(dirname(selected.map.path),"bg, image.png"),changed);
    expect(await reader.artwork("a",signal())).toEqual(changed);expect(thumbnail).toHaveBeenCalledTimes(2);
  });
  it("rejects traversal instead of reading an arbitrary nearby file", async () => {
    await expect(resources(await stable("../../outside.png")).artwork("r", signal())).rejects.toThrow();
  });
  it("does not accept changed map bytes under an indexed MD5", async () => {
    const selected = await stable(); await writeFile(selected.map.path, "changed");
    await expect(resources(selected).artwork("r", signal())).rejects.toThrow();
  });
  it("rejects delivery after the indexed selection changes", async () => {
    await expect(resources(await stable(), async () => false).artwork("r", signal())).rejects.toThrow();
  });
  it("rejects excessive decoded dimensions before invoking an image decoder", async () => {
    const selected = await stable(), enormous = Buffer.from(png); enormous.writeUInt32BE(100000, 16);
    await writeFile(join(dirname(selected.map.path), "bg, image.png"), enormous);
    await expect(resources(selected).artwork("r", signal())).rejects.toThrow();
  });
  it("requires native content-addressed paths as well as matching hashes", async () => {
    const bytes = Buffer.from("osu file format v14\n[Events]\n0,0,\"bg.png\",0,0\n");
    const mapHash = hash(bytes), artHash = hash(png);
    const blob = async (value: Buffer) => { const digest = hash(value), path = join(root, "files", digest[0], digest.slice(0, 2), digest); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); return path; };
    const mapPath = await blob(bytes), artPath = await blob(png);
    const selected: LibraryPassiveSelection = { replayId: "r", revision: "1", map: { kind: "lazer", directory: root, md5: hash(bytes, "md5"), file: { path: mapPath, sha256: mapHash }, assets: [{ name: "BG.PNG", status: "unverified", path: artPath, sha256: artHash }], manifestComplete: true } };
    expect(await resources(selected).artwork("r", signal())).toEqual(png);
    if (selected.map?.kind !== "lazer") throw Error("Fixture");
    await rm(artPath); await expect(resources(selected).artwork("r", signal())).rejects.toThrow(); await writeFile(artPath, png);
    const outside = join(root, "elsewhere.png"); await writeFile(outside, png); selected.map.assets[0].path = outside;
    await expect(resources(selected).artwork("r", signal())).rejects.toThrow();
  });
  it.each(["complete","wrong-name","wrong-map","incomplete","foreign-asset"])("uses only an exact %s single-name absence receipt",async variant=>{
    const bytes=Buffer.from('osu file format v14\n[Events]\n0,0,"bg.png",0,0\n'),sha256=hash(bytes),md5=hash(bytes,"md5"),path=join(root,"files",sha256[0],sha256.slice(0,2),sha256);
    await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);
    const selected:LibraryPassiveSelection={replayId:"r",revision:"1",map:{kind:"lazer",directory:root,md5,file:{path,sha256},assets:[],manifestComplete:false}};
    if(!selected.map)throw Error("Expected native map fixture");Object.assign(selected.map,{artworkLookup:{name:variant==="wrong-name"?"other.png":"bg.png",mapSha256:variant==="wrong-map"?"a".repeat(64):sha256,mapMd5:md5,complete:variant!=="incomplete"}});
    if(variant==="foreign-asset")Object.assign(selected.map,{assets:[{name:"other.png",status:"missing"}]});
    const work=resources(selected).artwork("r",signal());
    if(variant==="complete")await expect(work).resolves.toBeUndefined();else await expect(work).rejects.toThrow();
  });
  it("verifies replay content for Reveal and never returns a changed file", async () => {
    const path = join(root, "play.osr"), bytes = Buffer.from("opaque replay bytes"); await writeFile(path, bytes);
    const reader = resources({ replayId: "r", revision: "1", replay: { root, path, sha256: hash(bytes) } });
    expect(await reader.revealPath("r", signal())).toBe(path);
    await writeFile(path, "replaced"); await expect(reader.revealPath("r", signal())).rejects.toThrow();
  });
  it("honours cancellation before touching resources", async () => {
    const cancelled = new AbortController(); cancelled.abort();
    await expect(resources(await stable()).artwork("r", cancelled.signal)).rejects.toThrow();
  });
  it("distinguishes a missing Stable background from a corrupt present image", async () => {
    const selected = await stable("not-present.png"); expect(await resources(selected).artwork("r", signal())).toBeUndefined();
    await writeFile(join(dirname(selected.map.path), "not-present.png"), "not an image");
    await expect(resources(selected).artwork("r", signal())).rejects.toThrow();
  });
  it("does not call an incomplete native manifest absence", async () => {
    const bytes = Buffer.from('osu file format v14\n[Events]\n0,0,"bg.png",0,0\n'), digest = hash(bytes);
    const path = join(root, "files", digest[0], digest.slice(0, 2), digest); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    const selected: LibraryPassiveSelection = { replayId: "r", revision: "1", map: { kind: "lazer", directory: root, md5: hash(bytes, "md5"), file: { path, sha256: digest }, assets: [], manifestComplete: false } };
    await expect(resources(selected).artwork("r", signal())).rejects.toThrow("unavailable");
    if (selected.map?.kind !== "lazer") throw Error("Fixture"); selected.map.manifestComplete = true;
    expect(await resources(selected).artwork("r", signal())).toBeUndefined();
  });
  it("checks cancellation again after thumbnail work before publication", async () => {
    const selected = await stable(), controller = new AbortController();
    const reader = new LibraryPassiveResources({ select: async () => selected, isCurrent: async () => true, readStrip: async () => undefined,
      thumbnail: async bytes => { controller.abort(); return bytes; } });
    await expect(reader.artwork("r", controller.signal)).rejects.toThrow();
  });
  function displayClient(reader: LibraryPassiveResources) {
    const received: Uint8Array[] = [], failures: unknown[] = [];
    const api = new LibraryPassiveResourceApi(reader, () => { throw Error("Passive art must not Reveal"); });
    const client = new LibraryPassiveResourceClient({ resource: async request => {
      try { return await api.receive(request, () => undefined); }
      catch (error) { failures.push(error); throw error; }
    } }, { create: bytes => { received.push(bytes); return `blob:verified-${received.length}`; }, revoke: () => undefined });
    return { api, client, received, failures };
  }
  it("delivers the verified PNG through the real resource reader, API transfer and display client", async () => {
    const f = displayClient(resources(await stable()));
    try {
      expect(await f.client.update({ artworkIds: ["r"] })).toEqual({ r: { artUrl: "blob:verified-1" } });
      expect(Buffer.from(f.received[0])).toEqual(png); expect(f.failures).toEqual([]);
    } finally { await f.client.dispose(); await f.api.close(); }
  });
  it("keeps unavailable artwork honest and recovers after indexed resources become available", async () => {
    const selection = await stable(); let indexed = false;
    const f = displayClient(new LibraryPassiveResources({ select: async () => indexed ? selection : undefined,
      isCurrent: async () => true, readStrip: async () => undefined, thumbnail: async bytes => bytes }));
    try {
      expect(await f.client.update({ artworkIds: ["r"] })).toEqual({ r: {} });
      indexed = true; f.client.invalidate({ artwork: true, strip: false });
      expect(await f.client.update({ artworkIds: ["r"] })).toEqual({ r: { artUrl: "blob:verified-1" } });
      expect(Buffer.from(f.received[0])).toEqual(png); expect(f.failures).toEqual([]);
    } finally { await f.client.dispose(); await f.api.close(); }
  });
  it.each(["malformed", "stale", "oversize"])("retains %s verification failures at the actual display boundary", async mode => {
    const selection = await stable();
    if (mode === "malformed") await writeFile(join(dirname(selection.map.path), "bg, image.png"), "not an image");
    if (mode === "oversize") {
      const enormous = Buffer.from(png); enormous.writeUInt32BE(100000, 16);
      await writeFile(join(dirname(selection.map.path), "bg, image.png"), enormous);
    }
    const f = displayClient(resources(selection, async () => mode !== "stale"));
    try {
      expect(await f.client.update({ artworkIds: ["r"] })).toEqual({ r: { artworkError: "Artwork could not be verified" } });
      expect(f.received).toEqual([]); expect(f.failures).toHaveLength(1);
      expect(f.failures[0]).toMatchObject({ message: expect.stringMatching(/^Library artwork could not be verified \[method=artwork request=[a-f0-9]{16} replay=[a-f0-9]{16} outcome=unclassified-failure abortRequested=false\]$/) });
    } finally { await f.client.dispose(); await f.api.close(); }
  });
  it("drains a superseded thumbnail and publishes a subsequent valid read without retaining cancellation as artwork failure", async () => {
    const selection = await stable(); let enter!: () => void, finish!: () => void, thumbnails = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; }), drained = new Promise<void>(resolve => { finish = resolve; });
    const f = displayClient(new LibraryPassiveResources({ select: async () => selection, isCurrent: async () => true,
      readStrip: async () => undefined, thumbnail: async bytes => { if (++thumbnails === 1) { enter(); await drained; } return bytes; } }));
    try {
      const old = f.client.update({ artworkIds: ["r"] }); await entered;
      f.client.invalidate({ artwork: true, strip: false });
      const current = f.client.update({ artworkIds: ["r"] }); await Promise.resolve();
      expect(f.received).toEqual([]); finish();
      expect(await old).toEqual({});
      expect(await current).toEqual({ r: { artUrl: "blob:verified-1" } });
      expect(Buffer.from(f.received[0])).toEqual(png);
      // Actual reader cancellation is acknowledged without relabeling verification failures.
      expect(f.failures).toHaveLength(1);
      expect(f.failures[0]).toMatchObject({ message: expect.stringMatching(/^Library artwork request was cancelled \[method=artwork request=[a-f0-9]{16} replay=[a-f0-9]{16} outcome=acknowledged-cancellation abortRequested=true\]$/) });
    } finally { finish(); await f.client.dispose(); await f.api.close(); }
  });
  it("retains a selected replay's slow verified thumbnail through a strip-only refresh without API cancellation errors", async () => {
    const selection = await stable(); let enter!: () => void, finish!: () => void, thumbnails = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; }), drained = new Promise<void>(resolve => { finish = resolve; });
    const f = displayClient(new LibraryPassiveResources({ select: async () => selection, isCurrent: async () => true,
      readStrip: async () => undefined, thumbnail: async bytes => { thumbnails++; enter(); await drained; return bytes; } }));
    const previousController = new AbortController();
    try {
      const previous = f.client.update({ artworkIds: ["r"], stripReplayId: "r" }, previousController.signal); await entered;
      f.client.invalidate({ artwork: false, strip: true }); previousController.abort();
      const current = f.client.update({ artworkIds: ["r"], stripReplayId: "r" }); finish();
      expect(await previous).toEqual({}); expect(await current).toEqual({ r: { artUrl: "blob:verified-1" } });
      expect(thumbnails).toBe(1); expect(Buffer.from(f.received[0])).toEqual(png); expect(f.failures).toEqual([]);
    } finally { finish(); await f.client.dispose(); await f.api.close(); }
  });
  it("keeps uncertain native drainage fatal through API release and client lifetime", async () => {
    const reader = new LibraryPassiveResources({ select: async () => { throw new LibraryNativeDrainError("unconfirmed helper exit"); },
      isCurrent: async () => true, readStrip: async () => undefined });
    const f = displayClient(reader);
    expect(await f.client.update({ artworkIds: ["r"] })).toEqual({ r: { artworkError: "Artwork could not be verified" } });
    expect(f.received).toEqual([]);
    await expect(f.client.update({ artworkIds: ["r"] })).rejects.toThrow("unavailable");
    await expect(f.client.dispose()).rejects.toThrow("cleanup"); await expect(f.api.close()).rejects.toThrow("ownership");
  });
});

it.each([3125,3105,"byte-limit"] as const)("delivers all dense %s cached marks through reader/API/passive client",async count=>{
  const strip={state:"known" as const,value:{version:1 as const,timeBasis:"map-ms" as const,ruleset:"stable" as const,
    mapStartMs:0,mapEndMs:1000,evaluatedThrough:1000,endpointBasis:"recorded-end" as const,synthesizedEndpoint:false,
    ok:[] as number[],meh:[],miss:[],sliderEndMiss:[],sliderBreak:[]}};
  strip.value.ok=Array(count==="byte-limit"?Math.floor((65536-Buffer.byteLength(JSON.stringify(strip))+1)/2):count).fill(0);
  const entry={target:{replayId:"dense",slot:"numerical" as const,stage:"S" as const,inputKey:"key",producerVersion:"v6",generation:1},result:strip};
  expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(72*1024);
  const reader=new LibraryPassiveResources({select:jest.fn(),isCurrent:async()=>true,readStrip:async()=>entry,thumbnail:jest.fn()});
  const api=new LibraryPassiveResourceApi(reader,()=>undefined),client=new LibraryPassiveResourceClient({resource:r=>api.receive(r,()=>undefined)},
    {create:()=>{throw Error("Strip must not allocate artwork");},revoke:()=>undefined});
  try{expect((await client.update({artworkIds:[],stripReplayId:"dense"})).dense.strip).toEqual(strip.value);}
  finally{await client.dispose();await api.close();}
});
