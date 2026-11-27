import type { PerformanceMode } from "@rewind/osu-performance/types";
import { PERFORMANCE_ENGINE_VERSION,PerformanceRequest } from "@rewind/osu-performance/protocol";
import { fullComboPerformanceState } from "@rewind/osu-performance/states";
import { LibraryMapCalculation,mapPerformanceIdentity,readMapPerformanceResult } from "./library-map-performance";
import { LibraryPerformanceScoreEvidence,resolveLibraryPerformanceProfile,qualifyLibraryAggregateScore } from "./library-performance-score";
import { buildAggregatePerformanceCalculation,readAggregatePerformanceResult } from "./library-aggregate-performance";
import type { LibraryPreparedResult } from "./library-preparation-store";
import type { LibraryMetricValue } from "../../../../shared/replay-library-metrics";
import { metricInputKey } from "./library-source-metrics";
import { LazerMod,resolveLazerModSettings } from "@osujs/core";
import { LibraryTempoUnavailableReason,validLibraryTempoUnavailableReason } from "./library-performance-map-resource";

import { LIBRARY_P_PRODUCER_VERSION,LIBRARY_FC_PERFORMANCE_VERSION } from "./library-performance-versions";
export { LIBRARY_P_PRODUCER_VERSION } from "./library-performance-versions";
export interface LibraryPerformanceMapDescriptor {sha256:string;md5:string;ruleset:number;baseBpm:number|null;tempoUnavailableReason?:LibraryTempoUnavailableReason}
interface Cache<T>{get(key:string,mode:PerformanceMode):Promise<T|undefined>;put(key:string,mode:PerformanceMode,value:T):Promise<void>}
export interface LibraryPerformanceProducerPorts {
  mapCache:Cache<LibraryMapCalculation>;scalarCache:Cache<number>;
  /** The resource owner verifies/retains map bytes and resolves only after actual helper drain. */
  calculate(calculations:PerformanceRequest["calculations"]):Promise<unknown>;
}
const unknown=(reason:string):LibraryMetricValue<never>=>({state:"unknown",reason});
const known=<T>(value:T):LibraryMetricValue<T>=>({state:"known",value});
/** Keep this conservative allowlist aligned with native ModConfiguration. An unknown
 * mod may change time; neither ignoring it nor sampling ApplyToRate(0) proves a clock. */
function uniformRecordingRate(evidence:LibraryPerformanceScoreEvidence,
  profile:ReturnType<typeof resolveLibraryPerformanceProfile>):LibraryMetricValue<number> {
  if(profile.state!=="known")return unknown(profile.reason);
  const native=evidence.native&&!evidence.native.isLegacyScore?evidence.native:undefined;
  const ruleset=evidence.trailer?evidence.trailer.ruleset_id??evidence.header?.mode??native?.ruleset:native?.ruleset??evidence.header?.mode;
  if(ruleset!==0)return unknown("unsupported-ruleset");
  const source=(evidence.trailer?.mods??native?.mods??profile.mods) as readonly LazerMod[];
  const neutral=new Set(["NF","EZ","HD","HR","FL","SO","CL","DA","V2","SV2","SD","PF","TD","RX","AP","AT"]);
  const rates:{acronym:string;value:number}[]=[];
  for(const mod of source){
    if(!mod||typeof mod!=="object"||typeof mod.acronym!=="string")return unknown("native-mod-settings-unavailable");
    const rateMod=["DT","NC","HT","DC"].includes(mod.acronym);
    if(!rateMod&&!neutral.has(mod.acronym))return unknown("unsupported-clock-mod");
    const settings=mod.settings??{};
    for(const [key,value] of Object.entries(settings)){
      const boolean=rateMod?key==="adjust_pitch":mod.acronym==="DA"?key==="extended_limits":mod.acronym==="CL"&&
        ["no_slider_head_accuracy","classic_note_lock","always_play_tail_sample","fade_hit_circle_early","classic_health"].includes(key);
      const numeric=rateMod?key==="speed_change":mod.acronym==="DA"&&["circle_size","approach_rate","overall_difficulty","drain_rate"].includes(key);
      if(boolean?typeof value!=="boolean":numeric?typeof value!=="number"||!Number.isFinite(value):true)
        return unknown("unsupported-clock-settings");
    }
    if(rateMod){
      const faster=mod.acronym==="DT"||mod.acronym==="NC",value=settings.speed_change??(faster?1.5:0.75);
      if(typeof value!=="number"||!Number.isFinite(value)||value<(faster?1.01:0.5)||value>(faster?2:0.99))
        return unknown("invalid-clock-rate");
      // Validate before invoking the shared resolver, which otherwise clamps or
      // substitutes defaults. Preserve its established 0.01 rate precision.
      const resolved=resolveLazerModSettings([mod]).clockRate;
      if(resolved===undefined||!Number.isFinite(resolved)||resolved<=0)return unknown("invalid-clock-rate");
      rates.push({acronym:mod.acronym,value:resolved});
    }
  }
  // Legacy NC includes DT. Native aliases must agree before normalization drops DT.
  if(rates.length>1&&!(rates.length===2&&new Set(rates.map(rate=>rate.acronym)).size===2&&
    rates.every(rate=>rate.acronym==="NC"||rate.acronym==="DT")&&rates[0].value===rates[1].value))return unknown("conflicting-clock-mods");
  return known(rates[0]?.value??1);
}
function one(response:unknown,index:number,length:number):unknown {
  if(!response||typeof response!=="object"||!("timelines" in response)||!Array.isArray(response.timelines)||response.timelines.length!==length)return undefined;
  return{...response,timelines:[response.timelines[index]]};
}

/** P-only math. Raw PP is gated by durable completion evidence at publication, not by this producer. */
export async function produceLibraryPerformance(map:LibraryPerformanceMapDescriptor,evidence:LibraryPerformanceScoreEvidence,
  ports:LibraryPerformanceProducerPorts,signal:AbortSignal):Promise<LibraryPreparedResult[]> {
  signal.throwIfAborted();
  if(!/^[a-f0-9]{64}$/.test(map.sha256)||!/^[a-f0-9]{32}$/.test(map.md5)||
    !Number.isInteger(map.ruleset)||map.baseBpm!==null&&(!Number.isFinite(map.baseBpm)||map.baseBpm<=0)||
    map.tempoUnavailableReason!==undefined&&(map.baseBpm!==null||!validLibraryTempoUnavailableReason(map.tempoUnavailableReason)))throw new Error("Invalid P map descriptor");
  const profile=resolveLibraryPerformanceProfile(evidence),rate=uniformRecordingRate(evidence,profile),nm=mapPerformanceIdentity(map.sha256,"stable",[]),
    replay=profile.state==="known"?mapPerformanceIdentity(map.sha256,profile.mode,profile.mods):profile;
  const values=new Map<string,LibraryMapCalculation>(),pending:{key:string;calculation:PerformanceRequest["calculations"][number]}[]=[];
  if(map.ruleset===0)for(const [identity,mode] of [[nm,"stable"],[replay,profile.state==="known"?profile.mode:"stable"]] as const){
    if(identity.state!=="ready"||values.has(identity.inputKey)||pending.some(item=>item.key===identity.inputKey))continue;
    const cached=await ports.mapCache.get(identity.inputKey,mode);signal.throwIfAborted();
    if(cached)values.set(identity.inputKey,cached);
    else pending.push({key:identity.inputKey,calculation:{mode,mods:identity.mods,scope:"full-map",states:[]}});
  }
  if(pending.length){
    const response=await ports.calculate(pending.map(item=>item.calculation));signal.throwIfAborted();
    for(const [index,item] of pending.entries()){
      const result=readMapPerformanceResult(one(response,index,pending.length),item.calculation.mode);
      if(result.state==="known"){
        await ports.mapCache.put(item.key,item.calculation.mode,result.value);signal.throwIfAborted();values.set(item.key,result.value);
      }
    }
  }
  const base=nm.state==="ready"?values.get(nm.inputKey):undefined,current=replay.state==="ready"?values.get(replay.inputKey):undefined;
  const unavailable=unknown(map.ruleset!==0?"unsupported-ruleset":profile.state==="unknown"?profile.reason:"map-calculation-unavailable");
  const provenance={mapSha256:map.sha256,mapMd5:map.md5,engineVersion:PERFORMANCE_ENGINE_VERSION};
  const results:LibraryPreparedResult[]=[{slot:"calculated-map",stage:"P",producerVersion:LIBRARY_P_PRODUCER_VERSION,
    inputKey:metricInputKey({version:LIBRARY_P_PRODUCER_VERSION,map:map.sha256,base:nm.state==="ready"?nm.inputKey:null,
      replay:replay.state==="ready"?replay.inputKey:null,baseBpm:map.baseBpm,bpmClock:rate,...(map.tempoUnavailableReason?{tempoUnavailableReason:map.tempoUnavailableReason}:{})}),provenance,
    fields:{mapStars:base?known(base.stars):unknown("map-calculation-unavailable"),replayStars:current?known(current.stars):unavailable,
      bpm:map.ruleset!==0?unknown("unsupported-ruleset"):map.baseBpm===null?unknown(map.tempoUnavailableReason??"map-tempo-unavailable"):
        rate.state!=="known"?rate:Number.isFinite(map.baseBpm*rate.value)?known(map.baseBpm*rate.value):unknown("invalid-clock-rate"),
      lengthMs:current?known(current.drainTimeMs):unavailable,exactMapMaxCombo:current?known(current.maxCombo):unavailable}}];
  const qualified=current?qualifyLibraryAggregateScore(evidence,current):{state:"unknown" as const,reason:"map-calculation-unavailable"};
  const aggregate=current&&qualified.state==="known"?buildAggregatePerformanceCalculation({map:{sha256:map.sha256,ruleset:map.ruleset,
    objectCount:current.objectCount,aggregateTimeMs:current.endTimeMs},score:qualified.score,mods:qualified.profile.mods,profileKey:qualified.profile.inputKey})
    :{state:"unknown" as const,reason:qualified.state==="unknown"?qualified.reason:"aggregate-score-unqualified"};
  const calculations:{slot:"aggregate-pp"|"fc-pp";field:"pp"|"ppIfFc";key:string;calculation?:PerformanceRequest["calculations"][number];value?:number}[]=[];
  if(aggregate.state==="ready"&&current){
    const fc={...aggregate.calculation,states:[fullComboPerformanceState(aggregate.calculation.states[0],current.maxCombo)]};
    calculations.push({slot:"aggregate-pp",field:"pp",key:aggregate.inputKey,calculation:aggregate.calculation},
      {slot:"fc-pp",field:"ppIfFc",key:metricInputKey({version:LIBRARY_FC_PERFORMANCE_VERSION,engine:PERFORMANCE_ENGINE_VERSION,map:map.sha256,calculation:fc}),calculation:fc});
    for(const item of calculations){item.value=await ports.scalarCache.get(item.key,item.calculation!.mode);signal.throwIfAborted();}
    const missing=calculations.filter(item=>item.value===undefined);
    if(missing.length){
      const response=await ports.calculate(missing.map(item=>item.calculation!));signal.throwIfAborted();
      for(const [index,item] of missing.entries()){
        const value=readAggregatePerformanceResult(one(response,index,missing.length),{mode:item.calculation!.mode,objectCount:current.objectCount,time:current.endTimeMs});
        if(value.state==="known"){
          await ports.scalarCache.put(item.key,item.calculation!.mode,value.value);signal.throwIfAborted();item.value=value.value;
        }
      }
    }
  }else for(const [slot,field] of [["aggregate-pp","pp"],["fc-pp","ppIfFc"]] as const)
    calculations.push({slot,field,key:metricInputKey({version:LIBRARY_P_PRODUCER_VERSION,map:map.sha256,slot,reason:aggregate.state==="unknown"?aggregate.reason:"aggregate-unavailable"})});
  for(const item of calculations)results.push({slot:item.slot,stage:"P",inputKey:item.key,producerVersion:LIBRARY_P_PRODUCER_VERSION,
    provenance:{...provenance,...(profile.state==="known"?{ruleset:profile.mode}:{}),...(item.calculation?{profileHash:profile.state==="known"?profile.inputKey:"0".repeat(64)}:{})},
    fields:{[item.field]:item.value!==undefined?known(item.value):unknown(aggregate.state==="unknown"?aggregate.reason:"aggregate-performance-unavailable")}});
  signal.throwIfAborted();return results;
}
