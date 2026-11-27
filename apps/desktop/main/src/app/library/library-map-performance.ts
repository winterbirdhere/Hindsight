import { createHash } from "crypto";
import type { LazerMod } from "@osujs/core";
import { PERFORMANCE_ENGINE_VERSION, PerformanceRequest, FullMapValue } from "@rewind/osu-performance/protocol";
import type { PerformanceMode } from "@rewind/osu-performance/types";
import { normalizePerformanceMods } from "@rewind/osu-performance/mods";
import type { LibraryMetricValue } from "../../../../shared/replay-library-metrics";
import { metricInputKey } from "./library-source-metrics";

export const LIBRARY_MAP_PERFORMANCE_VERSION="library-map-performance-v1";
export interface LibraryMapCalculation extends FullMapValue { objectCount:number; stars:number }
type Unknown={state:"unknown";reason:string};
const unknown=(reason:string):Unknown=>({state:"unknown",reason});
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const count=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0&&v<=2147483647;
const finite=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v)&&v>=0;

/** Caller verifies exact bytes. Keys exclude replay/score identities, source paths and completion. */
export function buildMapPerformanceRequest(map:{text:string;sha256:string;ruleset:number},mode:PerformanceMode,source:readonly LazerMod[]|null):
  {state:"ready";request:PerformanceRequest;inputKey:string}|Unknown {
  if(map.ruleset!==0||!map.text||Buffer.byteLength(map.text)>16*1024*1024||
    !/^[a-f0-9]{64}$/.test(map.sha256)||createHash("sha256").update(map.text).digest("hex")!==map.sha256)
    return unknown("exact-standard-map-unavailable");
  const identity=mapPerformanceIdentity(map.sha256,mode,source);
  return identity.state==="ready"?{state:"ready",inputKey:identity.inputKey,
    request:{beatmap:map.text,calculations:[{mode,mods:identity.mods,scope:"full-map",states:[]}]}}:identity;
}

/** The resource owner has verified the descriptor's bytes; main needs only this small identity. */
export function mapPerformanceIdentity(mapSha256:string,mode:PerformanceMode,source:readonly LazerMod[]|null):
  {state:"ready";inputKey:string;mods:LazerMod[]}|Unknown {
  if(typeof mapSha256!=="string"||!/^[a-f0-9]{64}$/.test(mapSha256))return unknown("exact-standard-map-unavailable");
  if(!["stable","lazer","lazer-classic"].includes(mode)||!Array.isArray(source)||source.length>64||source.some(mod=>!record(mod)||
    typeof mod.acronym!=="string"||!/^[A-Z0-9]{1,8}$/.test(mod.acronym)||mod.settings!==undefined&&(!record(mod.settings)||
      Object.values(mod.settings).some(value=>typeof value!=="boolean"&&(typeof value!=="number"||!Number.isFinite(value))))))
    return unknown("native-mod-settings-unavailable");
  const mods=normalizePerformanceMods(source,mode).sort((a,b)=>a.acronym.localeCompare(b.acronym));
  if(new Set(mods.map(mod=>mod.acronym)).size!==mods.length||mode==="lazer"&&mods.some(mod=>mod.acronym==="CL")||
    mode==="lazer-classic"&&!mods.some(mod=>mod.acronym==="CL"))return unknown("profile-mod-conflict");
  try {
    const inputKey=metricInputKey({version:LIBRARY_MAP_PERFORMANCE_VERSION,engine:PERFORMANCE_ENGINE_VERSION,mapSha256,mode,mods});
    return{state:"ready",inputKey,mods};
  }catch{return unknown("map-calculation-input-limit");}
}

/** Accept only a compact map-only response. No absent value is replaced with zero. */
export function readMapPerformanceResult(response:unknown,mode:PerformanceMode):LibraryMetricValue<LibraryMapCalculation> {
  const absent=()=>unknown("map-calculation-unavailable");
  if(!record(response)||response.ok!==true||response.engineVersion!==PERFORMANCE_ENGINE_VERSION||
    !Array.isArray(response.timelines)||response.timelines.length!==1)return absent();
  const value=response.timelines[0];
  if(!record(value)||value.mode!==mode||value.error!=null||!count(value.objectCount)||value.objectCount===0||value.endpointVerified!==false||
    !Array.isArray(value.points)||value.points.length!==0||!Array.isArray(value.difficultyPoints)||value.difficultyPoints.length!==0||
    value.final!=null||!record(value.fullMap)||!record(value.fullDifficulty))return absent();
  const map=value.fullMap,full=value.fullDifficulty;
  if(map.version!==1||![map.maxCombo,map.largeTicks,map.smallTicks,map.sliderTails].every(count)||!finite(map.clockRate)||map.clockRate===0||
    !finite(map.drainTimeMs)||typeof map.endTimeMs!=="number"||!Number.isFinite(map.endTimeMs)||
    ![full.total,full.aim,full.speed,full.reading,full.flashlight,full.sliderFactor].every(finite))return absent();
  return{state:"known",value:{version:1,objectCount:value.objectCount,stars:Number(full.total),maxCombo:Number(map.maxCombo),
    largeTicks:Number(map.largeTicks),smallTicks:Number(map.smallTicks),sliderTails:Number(map.sliderTails),clockRate:map.clockRate,
    drainTimeMs:map.drainTimeMs,endTimeMs:map.endTimeMs}};
}
