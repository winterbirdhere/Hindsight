import { createHash } from "crypto";

/** Evidence from the same guarded file stream, never inferred from display statistics. */
export interface LibraryContentIdentityCertificate {
  version:"stable-play-v1";replaySha256:string;compressedSha256:string;compressedBytes:number;onlineScoreId:string;
  mode:0;replayVersion:number;beatmapMD5:string;player:string;modsBitmask:number;score:number;maxCombo:number;
  perfectComboFlag:boolean;counts:{great:number;ok:number;meh:number;miss:number};
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const hash=(value:unknown,length=64):value is string=>typeof value==="string"&&new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const integer=(value:unknown,max:number)=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=max;
const countKeys=["great","ok","meh","miss"] as const;
const fields=["beatmapMD5","player","modsBitmask","score","maxCombo","perfectComboFlag"] as const;

export function contentIdentityNativeMatches(metadata:Record<string,unknown>,value:LibraryContentIdentityCertificate):boolean {
  if(metadata.nativeScore===undefined)return true;
  const native=metadata.nativeScore;
  // Native legacy NoMod is explicitly qualified; unrecognised native settings stay separate.
  if(!record(native)||native.isLegacyScore!==true||native.ruleset!==0||native.player!==value.player||native.maxCombo!==value.maxCombo||
    !record(native.replay)||native.replay.sha256!==value.replaySha256||!record(native.beatmap)||native.beatmap.md5!==value.beatmapMD5||
    value.modsBitmask!==0||!Array.isArray(native.mods)||native.mods.some(mod=>!record(mod)||mod.acronym!=="CL"||
      mod.settings!==undefined&&(!record(mod.settings)||Object.keys(mod.settings).length>0))||native.mods.length>1||!record(native.statistics))return false;
  const statistics=native.statistics;
  return countKeys.every(key=>{
    const title=key[0].toUpperCase()+key.slice(1),a=statistics[key],b=statistics[title];
    if(a!==undefined&&b!==undefined&&a!==b)return false;
    const count=a??b??0;return integer(count,65535)&&count===value.counts[key];
  });
}

/** Undefined is deliberately not evidence of a different play, or permission to merge. */
export function validatedContentIdentity(metadata:Record<string,unknown>,sha256:string):LibraryContentIdentityCertificate|undefined {
  const value=metadata.contentIdentity,header=metadata.header;
  if(!record(value)||!record(header)||value.version!=="stable-play-v1"||value.replaySha256!==sha256||!hash(sha256)||
    !hash(value.compressedSha256)||!integer(value.compressedBytes,512*1024*1024)||Number(value.compressedBytes)<13||
    typeof value.onlineScoreId!=="string"||!/^[1-9][0-9]{0,18}$/.test(value.onlineScoreId)||BigInt(value.onlineScoreId)>BigInt("9223372036854775807")||
    value.mode!==0||header.mode!==0||header.sourceFormat!=="stable"||header.nativeScoreInfo!==false||
    !integer(value.replayVersion,29999999)||Number(value.replayVersion)<20140721||header.version!==value.replayVersion||
    !hash(value.beatmapMD5,32)||typeof value.player!=="string"||!value.player||value.player.length>1024||
    !integer(value.modsBitmask,0x1fffffff)||!integer(value.score,0x7fffffff)||!integer(value.maxCombo,65535)||
    typeof value.perfectComboFlag!=="boolean"||!record(value.counts)||!record(header.counts)||
    Object.keys(value.counts).some(key=>!countKeys.includes(key as typeof countKeys[number]))||
    countKeys.some(key=>!integer((value.counts as Record<string,unknown>)[key],65535)||
      (value.counts as Record<string,unknown>)[key]!==(header.counts as Record<string,unknown>)[key])||
    fields.some(key=>value[key]!==header[key])||
    !record(header.compressedFrames)||header.compressedFrames.length!==value.compressedBytes)return;
  const certificate:LibraryContentIdentityCertificate={version:"stable-play-v1",replaySha256:sha256,compressedSha256:value.compressedSha256,compressedBytes:Number(value.compressedBytes),
    onlineScoreId:value.onlineScoreId,mode:0,replayVersion:Number(value.replayVersion),beatmapMD5:value.beatmapMD5,player:value.player,
    modsBitmask:Number(value.modsBitmask),score:Number(value.score),maxCombo:Number(value.maxCombo),perfectComboFlag:value.perfectComboFlag,
    counts:{great:Number(value.counts.great),ok:Number(value.counts.ok),meh:Number(value.counts.meh),miss:Number(value.counts.miss)}};
  return contentIdentityNativeMatches(metadata,certificate)?certificate:undefined;
}

export function contentIdentityKey(value:LibraryContentIdentityCertificate):string {
  const {replaySha256,...identity}=value;
  void replaySha256;
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
