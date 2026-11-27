import type { LibraryErrorStripEntry } from "../../../../shared/replay-library-metrics";
import { validateLibraryErrorStrip } from "../../../../shared/library-error-strip";
import { LIBRARY_PASSIVE_ART_MAX_BYTES } from "../../../../shared/library-passive-resources";
import { open, realpath } from "fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import { createHash } from "crypto";
import { setImmediate } from "timers/promises";
import { TextDecoder } from "util";
import { readVerifiedLibraryResource } from "./library-resource-reader";
import { assertSourceUnchanged, sameSourceStamp, sourceStamp } from "./sources/source-file";
import { LibraryArtworkCache } from "./library-artwork-cache";
import type { LibraryArtworkSelection } from "./sources/lazer-source";

export interface LibraryPassiveBlob { path: string; sha256: string }
export interface LibraryPassiveSelection {
  replayId: string; revision: string;
  replay?: LibraryPassiveBlob & { root: string };
  map?: { kind: "stable"; songsRoot: string; path: string; md5: string }
    | { kind: "lazer"; directory: string; md5: string; file: LibraryPassiveBlob;
      assets: { name: string; status: string; path?: string; sha256?: string }[]; manifestComplete: boolean;
      artworkLookup?:LibraryArtworkSelection&{complete:true} };
}
export interface LibraryPassiveResourceDependencies {
  select(replayId: string, purpose: "artwork" | "reveal", signal: AbortSignal): Promise<LibraryPassiveSelection | undefined>;
  isCurrent(selection: LibraryPassiveSelection): Promise<boolean>;
  readStrip(replayId: string, signal: AbortSignal): Promise<LibraryErrorStripEntry | undefined>;
  thumbnail?(bytes: Buffer): Promise<Buffer>;
  checkpoint?(): Promise<void>;
}
const sha = (value: string) => /^[a-f0-9]{64}$/.test(value);
function assetName(value: string): string {
  const name = value.replace(/\\/g, "/");
  if (!name || name.length > 512 || /[<>:"|?*]/.test(name) || Array.from(name).some(character => character.charCodeAt(0) < 32) || name.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)))
    throw Error("Invalid passive artwork name");
  return name;
}
async function contained(root: string, path: string): Promise<{ root: string; path: string }> {
  if (!isAbsolute(root) || !isAbsolute(path)) throw Error("Invalid passive source path");
  const actualRoot = await realpath(root), actualPath = await realpath(path), rel = relative(actualRoot, actualPath);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) throw Error("Passive resource escapes its source root");
  return { root: actualRoot, path: actualPath };
}
async function currentPath(root: string, path: string, actual: { root: string; path: string }): Promise<void> {
  const current = await contained(root, path);
  if (current.root !== actual.root || current.path !== actual.path) throw Error("Passive source path changed");
}
async function managed(directory: string, file: LibraryPassiveBlob): Promise<{ root: string; path: string }> {
  if (!sha(file.sha256) || resolve(file.path) !== resolve(directory, "files", file.sha256[0], file.sha256.slice(0, 2), file.sha256))
    throw Error("Invalid native managed-file mapping");
  return contained(directory, file.path);
}
function dimensions(bytes: Buffer): { width: number; height: number } {
  let width = 0, height = 0;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii", 12, 16) === "IHDR") {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw Error("Invalid artwork JPEG");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]; if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) throw Error("Truncated artwork JPEG");
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (length < 8) throw Error("Invalid artwork JPEG dimensions"); height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else throw Error("Unsupported artwork format");
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024) throw Error("Artwork dimensions exceed resource limit");
  return { width, height };
}
async function thumbnail(bytes: Buffer): Promise<Buffer> {
  // Electron's image decoder creates no windows. Input dimensions are checked before decoding.
  const { nativeImage } = await import("electron");
  const image = nativeImage.createFromBuffer(bytes); if (image.isEmpty()) throw Error("Invalid artwork image");
  const { width, height } = image.getSize();
  const resize = (w: number, h: number) => { const ratio = Math.min(1, w / width, h / height); return image.resize({ width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)) }).toPNG(); };
  const first = resize(480, 270); return first.length <= LIBRARY_PASSIVE_ART_MAX_BYTES ? first : resize(320, 180);
}
async function backgroundName(bytes:Buffer,checkpoint:()=>Promise<void>):Promise<string|undefined>{
  const text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);
  if(!/^\ufeff?[ \t]*osu file format v\d+\s*(?:\r?\n|$)/.test(text))throw Error("Invalid passive map format");
  let section="",background:string|undefined,offset=0,lines=0;
  while(offset<text.length){
    const end=text.indexOf("\n",offset),next=end<0?text.length:end;
    if(next-offset>8192)throw Error("Passive map line exceeds resource limit");
    const line=text.slice(offset,next).trim();offset=end<0?text.length:end+1;
    if(line.startsWith("[")&&line.endsWith("]"))section=line;
    else if(section==="[Events]"){
      // Same filename rule as BlueprintParser.handleEvents; the final background wins.
      const match=line.match(/^0\s*,[^,]*,\s*(?:"([^"]*)"|([^,]+?))\s*(?:,([^,]*))?(?:,([^,]*))?\s*$/);
      if(match)background=match[1]??match[2];
    }
    if(++lines%128===0)await checkpoint();
  }
  return background;
}
export async function readVerifiedNativeArtworkName(directory:string,map:{sha256:string;path:string;md5:string},signal:AbortSignal):Promise<LibraryArtworkSelection|undefined>{
  const actual=await managed(directory,map),checkpoint=async()=>{signal.throwIfAborted();await setImmediate();signal.throwIfAborted();};
  const resource=await readVerifiedLibraryResource(actual.path,{sha256:map.sha256,md5:map.md5,maxBytes:16*1024*1024},signal,checkpoint);
  const name=await backgroundName(resource.bytes,checkpoint);await currentPath(directory,map.path,actual);signal.throwIfAborted();
  return name?{mapSha256:resource.sha256,mapMd5:resource.md5,name:assetName(name)}:undefined;
}
/** Qualify a cheaper exact Stable source before skipping a native manifest. A successful bounded
 * transform is shared with delivery, which independently validates its own source snapshot. */
export async function hasVerifiedStableArtwork(map:{songsRoot:string;path:string;md5:string},signal:AbortSignal,
  cache:LibraryArtworkCache,decode:(bytes:Buffer)=>Promise<Buffer>=thumbnail):Promise<boolean>{
  const checkpoint=async()=>{signal.throwIfAborted();await setImmediate();signal.throwIfAborted();};
  const actual=await contained(map.songsRoot,map.path);
  const resource=await readVerifiedLibraryResource(actual.path,{md5:map.md5,maxBytes:16*1024*1024},signal,checkpoint);
  const background=await backgroundName(resource.bytes,checkpoint);if(!background)return false;
  const imageRoot=dirname(actual.path),imagePath=resolve(imageRoot,assetName(background)),imageActual=await contained(imageRoot,imagePath);
  const image=await readVerifiedLibraryResource(imageActual.path,{maxBytes:8*1024*1024},signal,checkpoint);dimensions(image.bytes);
  await verifiedThumbnail(image,cache,decode);signal.throwIfAborted();
  await currentPath(imageRoot,imagePath,imageActual);await currentPath(map.songsRoot,map.path,actual);signal.throwIfAborted();return true;
}
function verifiedThumbnail(image:{bytes:Buffer;sha256:string},cache:LibraryArtworkCache,decode:(bytes:Buffer)=>Promise<Buffer>):Promise<Buffer>{
  const key=createHash("sha256").update("library-artwork-v1:480x270:320x180:png:"+image.sha256).digest("hex");
  return cache.get(key,()=>decode(image.bytes),bytes=>{
    const size=dimensions(bytes);
    if(bytes.length>LIBRARY_PASSIVE_ART_MAX_BYTES||size.width>480||size.height>270||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error("Artwork thumbnail exceeds resource limit");
  });
}
export class LibraryPassiveResources {
  constructor(private readonly dependencies: LibraryPassiveResourceDependencies,private readonly artworkCache=new LibraryArtworkCache()) {}
  private async checkpoint(signal: AbortSignal): Promise<void> { signal.throwIfAborted(); await (this.dependencies.checkpoint ?? (() => setImmediate()))(); signal.throwIfAborted(); }
  private async current(selection: LibraryPassiveSelection, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); if (!await this.dependencies.isCurrent(selection)) throw Error("Passive indexed selection changed"); signal.throwIfAborted();
  }
  async artwork(replayId: string, signal: AbortSignal): Promise<Buffer | undefined> {
    await this.checkpoint(signal); const selection = await this.dependencies.select(replayId, "artwork", signal); signal.throwIfAborted();
    if (!selection?.map) return undefined;
    await this.current(selection, signal); const map = selection.map;
    if (!/^[a-f0-9]{32}$/.test(map.md5)) throw Error("Invalid passive map identity");
    const mapRoot = map.kind === "stable" ? map.songsRoot : map.directory, mapPath = map.kind === "stable" ? map.path : map.file.path;
    const actual = map.kind === "stable" ? await contained(mapRoot, mapPath) : await managed(map.directory, map.file);
    const resource = await readVerifiedLibraryResource(actual.path, { md5: map.md5, ...(map.kind === "lazer" ? { sha256: map.file.sha256 } : {}), maxBytes: 16 * 1024 * 1024 }, signal, () => this.checkpoint(signal));
    const background=await backgroundName(resource.bytes,()=>this.checkpoint(signal));
    await currentPath(mapRoot, mapPath, actual); await this.current(selection, signal);
    if (!background) return undefined; const name = assetName(background);
    let imagePath: string, imageRoot: string, expected: string | undefined;
    if (map.kind === "lazer") {
      const lookup=map.artworkLookup;
      if(lookup&&(lookup.complete!==true||lookup.name!==name||lookup.mapSha256!==map.file.sha256||lookup.mapMd5!==map.md5||map.manifestComplete||map.assets.length>1||
        map.assets.some(item=>assetName(item.name).toLowerCase()!==name.toLowerCase())))throw Error("Native artwork lookup binding changed");
      if (map.assets.length > 8192) throw Error("Native artwork manifest exceeds resource limit");
      const names = new Set<string>(); let asset: typeof map.assets[number] | undefined;
      for (const item of map.assets) { const normalized = assetName(item.name).toLowerCase(); if (names.has(normalized)) throw Error("Ambiguous native artwork manifest"); names.add(normalized); if (normalized === name.toLowerCase()) asset = item; }
      if ((!asset && (map.manifestComplete||lookup?.complete===true)) || asset?.status === "missing") return undefined;
      if (!asset || !["available", "unverified"].includes(asset.status) || !asset.path || !asset.sha256) throw Error("Native artwork manifest is unavailable");
      imageRoot = map.directory; imagePath = asset.path; expected = asset.sha256; await managed(map.directory, { path: imagePath, sha256: expected });
    } else { imageRoot = dirname(actual.path); imagePath = resolve(imageRoot, name); }
    let imageActual: { root: string; path: string };
    try { imageActual = await contained(imageRoot, imagePath); }
    catch (error) { if (map.kind === "stable" && (error as NodeJS.ErrnoException).code === "ENOENT") { await currentPath(mapRoot, mapPath, actual); await this.current(selection, signal); return undefined; } throw error; }
    const image = await readVerifiedLibraryResource(imageActual.path, { ...(expected ? { sha256: expected } : {}), maxBytes: 8 * 1024 * 1024 }, signal, () => this.checkpoint(signal));
    dimensions(image.bytes); await this.checkpoint(signal);
    const result=await verifiedThumbnail(image,this.artworkCache,this.dependencies.thumbnail??thumbnail);signal.throwIfAborted();
    await currentPath(imageRoot, imagePath, imageActual); await currentPath(mapRoot, mapPath, actual); await this.current(selection, signal);
    return result;
  }
  async strip(replayId: string, signal: AbortSignal): Promise<LibraryErrorStripEntry | undefined> {
    signal.throwIfAborted(); const result = await this.dependencies.readStrip(replayId, signal); signal.throwIfAborted();
    if (result?.result) validateLibraryErrorStrip(result.result);
    if (result && (result.target.slot !== "numerical" || result.target.stage !== "S" || Buffer.byteLength(JSON.stringify(result)) > 72 * 1024)) throw Error("Invalid passive error strip");
    return result;
  }
  async revealPath(replayId: string, signal: AbortSignal): Promise<string> {
    await this.checkpoint(signal); const selection = await this.dependencies.select(replayId, "reveal", signal); signal.throwIfAborted();
    if (!selection?.replay || !sha(selection.replay.sha256)) throw Error("Replay file is unavailable");
    await this.current(selection, signal); const replay = selection.replay, actual = await contained(replay.root, replay.path), handle = await open(actual.path, "r");
    try {
      const before = await handle.stat({ bigint: true }); if (!before.isFile() || before.size > BigInt(128 * 1024 * 1024)) throw Error("Replay file exceeds resource limit");
      const stamp = sourceStamp(before), hash = createHash("sha256"), bytes = Buffer.alloc(1024 * 1024); let offset = 0;
      while (offset < stamp.bytes) { await this.checkpoint(signal); const read = await handle.read(bytes, 0, Math.min(bytes.length, stamp.bytes - offset), offset); if (!read.bytesRead) throw Error("Replay file truncated"); hash.update(bytes.subarray(0, read.bytesRead)); offset += read.bytesRead; }
      if (!sameSourceStamp(stamp, sourceStamp(await handle.stat({ bigint: true }))) || hash.digest("hex") !== replay.sha256) throw Error("Replay file changed");
      await assertSourceUnchanged(actual.path, stamp); await currentPath(replay.root, replay.path, actual); await this.current(selection, signal); return actual.path;
    } finally { await handle.close(); }
  }
}
