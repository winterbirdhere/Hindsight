import { FIRST_LAZER_REPLAY_VERSION } from "@osujs/core";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION,
  LibraryNumericalResourceDescriptor, LibraryNumericalInputRecipe } from "../../../../shared/library-analysis";
import type { PreparedLibraryMap, PreparedLibraryReplay } from "./library-selected-resources";
import { metricInputKey } from "./library-source-metrics";
import { parseLazerReplayScoreMetadata } from "../../../../frontend/src/app/model/OsuReplay";
import { numericalModsHash, nativeModEvidence, numericalProfileKey } from "./library-numerical-profile";

/** Resource utility only. Numerical S consumes verified replay bytes, map bytes and recording
 * profile; optional saved cause corroboration does not invalidate numerical results. */
export function describeLibraryNumericalResources(replay:PreparedLibraryReplay,map:PreparedLibraryMap,replayBytes:number):LibraryNumericalResourceDescriptor {
  const data=replay.data;
  if(!/^[a-f0-9]{64}$/.test(data.replayContentSha256)||data.replayContentSha256!==replay.receipt.sha256||!replay.receipt.available||
    !/^[a-f0-9]{64}$/.test(map.map.sha256)||!/^[a-f0-9]{32}$/.test(data.beatmapMD5)||data.beatmapMD5!==map.map.md5)
    throw new Error("Analysis resource identity is invalid or contradictory");
  if(!Number.isSafeInteger(replayBytes)||replayBytes<1||replayBytes>64*1024*1024||map.map.bytes.length<1||map.map.bytes.length>16*1024*1024)
    throw new Error("Analysis resource byte limit exceeded");
  const confirmed=data.sourceProvenance==="user-confirmed"&&(data.sourceClient==="stable"||data.sourceClient==="lazer")?data.sourceClient:null;
  const nativeDatabase=data.nativeSource?.isLegacyScore===false;
  const nativeFormat=data.gameVersion>=FIRST_LAZER_REPLAY_VERSION;
  const embedded=parseLazerReplayScoreMetadata(data.lazerScoreInfo)!==undefined;
  const native= nativeFormat||nativeDatabase||data.lazerMods!==undefined||embedded||confirmed==="lazer";
  if(replay.ticket?.analysisRequiresNative&&!native)throw new Error("Known native recording profile could not be reverified");
  const embeddedModsHash=data.lazerMods===undefined?null:numericalModsHash(data.lazerMods);
  if(embeddedModsHash===undefined)throw new Error("native-embedded-mod-settings-unavailable");
  const recipe:LibraryNumericalInputRecipe={version:1,replaySha256:data.replayContentSha256,
    fixedKey:metricInputKey({producer:LIBRARY_NUMERIC_PROJECTION_VERSION,parser:LIBRARY_REPLAY_PARSER_VERSION,
      preparation:LIBRARY_RESOURCE_PREPARATION_VERSION,replaySha256:data.replayContentSha256,mapSha256:map.map.sha256,mapMd5:map.map.md5,
      mode:data.gameMode,gameVersion:data.gameVersion}),intrinsicNative:nativeFormat||embedded,embeddedModsHash,
    legacyModsHash:metricInputKey(data.mods),modeQualified:data.gameMode===0&&Number.isSafeInteger(data.gameVersion),
    consumedModsSource:embeddedModsHash!==null?"embedded":nativeDatabase?"native-database":"legacy-mask"};
  const profile=numericalProfileKey(recipe,{origin:confirmed,native:nativeModEvidence(nativeDatabase?[data.nativeSource?.mods]:[])});
  if(profile.state!=="known")throw new Error(profile.reason);
  const binding={replaySha256:data.replayContentSha256,mapSha256:map.map.sha256,mapMd5:map.map.md5,
    exactMapAndProfile:profile.qualified};
  return {input:{format:"resources",replayBytes,mapBytes:map.map.bytes.length,binding},
    origin:confirmed?{client:confirmed,provenance:"user-confirmed"}:null,recipe,
    target:{slot:"numerical",stage:"S",inputKey:profile.inputKey,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION}};
}
