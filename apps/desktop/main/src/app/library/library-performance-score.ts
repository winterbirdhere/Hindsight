import { modsFromBitmask,ReplayModBit } from "@osujs/core";
import type { LazerMod,OsuClassicMod } from "@osujs/core";
import type { PerformanceMode,PerformanceStatistics } from "@rewind/osu-performance/types";
import type { AggregatePerformanceInput } from "./library-aggregate-performance";
import type { LibraryMapCalculation } from "./library-map-performance";
import { mapPerformanceIdentity } from "./library-map-performance";
import { metricInputKey } from "./library-source-metrics";

/** Only byte/source-bound observations enter this adapter; paths and saved causes are not inputs. */
export interface LibraryPerformanceScoreEvidence {
  header?:{mode:number;version:number;modsBitmask:number;counts:{great:number;ok:number;meh:number;miss:number};maxCombo:number;score:number};
  native?:{ruleset:number|null;isLegacyScore:boolean;mods:unknown;maxCombo:unknown;statistics:unknown;maximumStatistics?:unknown};
  trailer?:{mods:readonly LazerMod[];[key:string]:unknown};
  origin:"stable"|"lazer"|"unknown"|null;
  nativeRequired:boolean;
  nativeConflict?:boolean;
  profileConflict?:boolean;
  scoreConflict?:boolean;
  /** A persisted recipe can require the embedded settings it previously consumed. */
  embeddedRequired?:boolean;
  trailerStatus?:"not-needed"|"read"|"absent"|"unavailable"|"invalid";
}
type Unknown={state:"unknown";reason:string};
type Profile={state:"known";mode:PerformanceMode;mods:LazerMod[];inputKey:string};
const unknown=(reason:string):Unknown=>({state:"unknown",reason});
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const count=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0&&v<=2147483647;
const acronyms:Record<OsuClassicMod,string>={TOUCH_DEVICE:"TD",EASY:"EZ",HALF_TIME:"HT",NO_FAIL:"NF",HARD_ROCK:"HR",SUDDEN_DEATH:"SD",PERFECT:"PF",
  DOUBLE_TIME:"DT",NIGHT_CORE:"NC",HIDDEN:"HD",FLASH_LIGHT:"FL",AUTO_PLAY:"AT",AUTO_PILOT:"AP",RELAX:"RX",SPUN_OUT:"SO",SCORE_V2:"V2"};
const supportedMask=Object.values(ReplayModBit).reduce((mask,value)=>mask|value,0);

export function resolveLibraryPerformanceProfile(input:LibraryPerformanceScoreEvidence):Profile|Unknown {
  if(input.trailerStatus==="invalid"||input.embeddedRequired&&!input.trailer)return unknown("embedded-native-metadata-unavailable");
  const native=input.native&&!input.native.isLegacyScore?input.native:undefined;
  const intrinsic=input.nativeRequired||!!native||!!input.trailer||(input.header?.version??0)>=30000000;
  let mode:PerformanceMode="stable",mods:readonly LazerMod[]|null=null;
  if(input.trailer)mods=input.trailer.mods;
  else if(input.nativeConflict||input.profileConflict)return unknown("conflicting-score-profile-evidence");
  else if(native)mods=Array.isArray(native.mods)?native.mods:null;
  else if(intrinsic||input.origin==="lazer")return unknown("native-mod-settings-unavailable");
  else if(input.origin==="unknown")return unknown("recording-origin-unavailable");
  else {
    const mask=input.header?.modsBitmask;
    if(!count(mask)||(mask&~supportedMask)!==0)return unknown("unsupported-legacy-mod-mask");
    mods=modsFromBitmask(mask).map(mod=>({acronym:acronyms[mod]}));
  }
  if(intrinsic||input.origin==="lazer")mode=mods?.some(mod=>record(mod)&&mod.acronym==="CL")?"lazer-classic":"lazer";
  const value=mapPerformanceIdentity("0".repeat(64),mode,mods);
  return value.state==="ready"?{state:"known",mode,mods:value.mods,inputKey:metricInputKey({version:"library-score-profile-v1",mode,mods:value.mods})}:value;
}

const aliases={great:["Great","great"],ok:["Ok","ok"],meh:["Meh","meh"],miss:["Miss","miss"],
  large_tick_hit:["LargeTickHit","large_tick_hit"],large_tick_miss:["LargeTickMiss","large_tick_miss"],
  small_tick_hit:["SmallTickHit","small_tick_hit"],small_tick_miss:["SmallTickMiss","small_tick_miss"],
  slider_tail_hit:["SliderTailHit","slider_tail_hit"],slider_tail_miss:["slider_tail_miss"]} as const;
export function validLibraryNativeStatistics(value:unknown):value is Record<string,unknown> {
  return record(value)&&Object.keys(value).length<=64&&Object.values(value).every(count);
}
function dictionary(value:unknown):Record<string,unknown> {
  if(!validLibraryNativeStatistics(value))throw new Error("invalid-native-statistics");return value;
}
function statistic(stats:Record<string,unknown>,key:keyof PerformanceStatistics):number|undefined {
  const values=aliases[key].filter(name=>Object.prototype.hasOwnProperty.call(stats,name)).map(name=>stats[name]);
  if(!values.length)return undefined;
  if(!values.every(value=>count(value)&&value===values[0]))throw new Error("conflicting-native-statistic-aliases");return values[0] as number;
}
/** Compare consumed semantic values, never source-specific spellings. Invalid/conflicting
 * dictionaries remain explicit and cannot collapse into missing or zero evidence. */
export function nativeStatisticsIdentity(value:unknown,maximum=false):unknown {
  if(value==null)return{state:"missing"};
  if(!validLibraryNativeStatistics(value))return{state:"invalid"};
  const keys:readonly (keyof PerformanceStatistics)[]=maximum?["slider_tail_hit"]:Object.keys(aliases) as (keyof PerformanceStatistics)[];
  return{state:"valid",values:Object.fromEntries(keys.map(key=>{
    try{return[key,statistic(value,key)??null];}catch{return[key,{state:"conflict"}];}
  }))};
}

/** Coverage here qualifies aggregate arithmetic only, never completion, FC or replay simulation. */
export function qualifyLibraryAggregateScore(input:LibraryPerformanceScoreEvidence,map:LibraryMapCalculation):
  {state:"known";score:AggregatePerformanceInput["score"];profile:Profile}|Unknown {
  const profile=resolveLibraryPerformanceProfile(input);if(profile.state!=="known")return profile;
  const native=!input.nativeConflict&&!input.scoreConflict&&input.native&&!input.native.isLegacyScore?input.native:undefined;
  if((input.trailer?input.trailer.ruleset_id??input.header?.mode??native?.ruleset:native?.ruleset??input.header?.mode)!==0)
    return unknown("unsupported-ruleset");
  try {
    if(profile.mode==="stable"){
      if(input.scoreConflict)return unknown("conflicting-saved-score-evidence");
      const header=input.header;
      if(!header||header.version>=30000000||!record(header.counts)||!count(header.maxCombo)||header.maxCombo>map.maxCombo)
        return unknown("saved-score-unavailable");
      const basic=[header.counts.great,header.counts.ok,header.counts.meh,header.counts.miss] as const;
      if(!basic.every(count)||basic.reduce((a,b)=>a+b,0)!==map.objectCount)return unknown("aggregate-object-coverage-incomplete");
      const scoreV1=!profile.mods.some(mod=>mod.acronym==="V2"||mod.acronym==="SV2");
      if(scoreV1&&!count(header.score))return unknown("saved-score-v1-unavailable");
      const values={mode:"stable" as const,basic,maxCombo:header.maxCombo,...(scoreV1?{legacyScoreV1:header.score}:{})};
      return{state:"known",profile,score:{...values,evidenceKey:metricInputKey(values)}};
    }
    if(input.nativeConflict&&!input.trailer)return unknown("conflicting-native-score-evidence");
    // A present malformed trailer field cannot be replaced by a source default.
    const raw=input.trailer&&Object.prototype.hasOwnProperty.call(input.trailer,"statistics")?input.trailer.statistics:native?.statistics;
    const maximum=input.trailer&&Object.prototype.hasOwnProperty.call(input.trailer,"maximum_statistics")?input.trailer.maximum_statistics:native?.maximumStatistics;
    const maxCombo=input.trailer&&Object.prototype.hasOwnProperty.call(input.trailer,"max_combo")?input.trailer.max_combo:native?.maxCombo;
    if(!count(maxCombo)||maxCombo>map.maxCombo)return unknown("native-max-combo-unavailable");
    const stats=dictionary(raw),max=maximum==null?undefined:dictionary(maximum);
    // Native ScoreInfo dictionaries are sparse: pinned LegacyReplaySoloScoreInfo.FromScore
    // removes zero entries. Only a validated, present score dictionary gets this default;
    // maximum-statistics evidence and its conflict checks remain separate below.
    const basics=["great","ok","meh","miss"] as const;
    const basic=basics.map(key=>statistic(stats,key)??0);
    if(!basic.every(count)||basic.reduce((sum,value)=>sum+value,0)!==map.objectCount)return unknown("aggregate-object-coverage-incomplete");
    const result=Object.fromEntries(basics.map((key,index)=>[key,basic[index]])) as unknown as PerformanceStatistics;
    for(const [hit,miss,capacity] of [["large_tick_hit","large_tick_miss",map.largeTicks],["small_tick_hit","small_tick_miss",map.smallTicks]] as const){
      const hits=statistic(stats,hit)??0,misses=statistic(stats,miss)??0;
      if(!count(hits)||!count(misses)||hits+misses!==capacity)return unknown("native-component-evidence-unavailable");result[hit]=hits;result[miss]=misses;
    }
    const capacity=map.sliderTails,explicitMaximum=max?statistic(max,"slider_tail_hit"):undefined;
    if(explicitMaximum!==undefined&&explicitMaximum!==capacity)return unknown("native-tail-capacity-conflict");
    const hits=statistic(stats,"slider_tail_hit")??0,explicitMisses=statistic(stats,"slider_tail_miss");
    if(!count(hits)||hits>capacity||explicitMisses!==undefined&&explicitMisses!==capacity-hits)return unknown("native-tail-evidence-unavailable");
    result.slider_tail_hit=hits;result.slider_tail_miss=capacity-hits;
    const values={mode:profile.mode,statistics:result,maxCombo,componentsQualified:true};
    return{state:"known",profile,score:{...values,evidenceKey:metricInputKey(values)}};
  }catch(error){return unknown(error instanceof Error?error.message:"native-score-unavailable");}
}
