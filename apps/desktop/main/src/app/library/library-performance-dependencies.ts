import type { LibrarySourceRegistration } from "../../../../shared/replay-library";
import { sourceMapEvidence,LibrarySourceOriginLookup } from "./library-source-binding";
import { metricInputKey } from "./library-source-metrics";
import { mapPerformanceIdentity,LIBRARY_MAP_PERFORMANCE_VERSION } from "./library-map-performance";
import { nativeStatisticsIdentity } from "./library-performance-score";
import { LIBRARY_AGGREGATE_PROJECTION_VERSION } from "./library-aggregate-performance";
import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { LIBRARY_P_PRODUCER_VERSION,LIBRARY_FC_PERFORMANCE_VERSION } from "./library-performance-versions";
import type { LazerMod } from "@osujs/core";

export interface LibraryPerformanceDependencies {version:1;mapKey:string;profileKey:string;scoreKey:string;nativeRequired:boolean}
export interface LibraryPerformanceObservation {kind:LibrarySourceRegistration["kind"];sourceKey:string;sha256:string|null;metadata:Record<string,unknown>}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const hash=(value:unknown)=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const pick=(value:Record<string,unknown>,keys:readonly string[])=>Object.fromEntries(keys.map(key=>[key,value[key]??null]));
const digestSet=(values:Iterable<string>)=>[...new Set(values)].sort();
export function nativePerformanceScoreKey(score:{maxCombo?:unknown;statistics?:unknown;maximumStatistics?:unknown}):string {
  return metricInputKey({maxCombo:score.maxCombo??null,statistics:nativeStatisticsIdentity(score.statistics),
    maximumStatistics:nativeStatisticsIdentity(score.maximumStatistics,true)});
}
export const PERFORMANCE_DEPENDENCY_VERSIONS={engine:PERFORMANCE_ENGINE_VERSION,map:LIBRARY_MAP_PERFORMANCE_VERSION,
  aggregate:LIBRARY_AGGREGATE_PROJECTION_VERSION,fc:LIBRARY_FC_PERFORMANCE_VERSION,producer:LIBRARY_P_PRODUCER_VERSION};

/** Semantic input families only. Availability belongs to admission/retry, not completed values.
 * Missing and conflicting evidence remain in the set; no location-order winner is chosen. */
export function performanceDependencyKeys(observations:readonly LibraryPerformanceObservation[],origin:LibrarySourceOriginLookup,retainedNative:boolean,
  versions=PERFORMANCE_DEPENDENCY_VERSIONS):LibraryPerformanceDependencies {
  if(observations.length>256)throw new Error("Performance evidence location budget exceeded");
  const maps:string[]=[],profiles:string[]=[],scores:string[]=[],headers:Record<string,unknown>[]=[],nativeScores:Record<string,unknown>[]=[],contents:string[]=[];
  let nativeRequired=retainedNative;
  for(const observation of observations){
    const {metadata,kind,sha256,sourceKey}=observation,evidence=sourceMapEvidence(observation);
    if(evidence.headerMd5)maps.push(metricInputKey({md5:evidence.headerMd5}));
    if(evidence.sourceMd5)maps.push(metricInputKey({md5:evidence.sourceMd5}));
    const saved=metadata.savedScore;
    const header=sha256&&record(metadata.header)?metadata.header:kind==="stable"&&record(saved)&&saved.sourceKey===sourceKey&&hash(sourceKey)&&
      Number.isInteger(saved.databaseVersion)&&record(saved.header)?saved.header:undefined;
    if(header){headers.push(header);nativeRequired||=typeof header.version==="number"&&header.version>=30000000;}
    if(sha256)contents.push(sha256);
    const score=metadata.nativeScore;
    if(kind==="lazer"&&record(score)&&record(score.replay)&&(!sha256||score.replay.sha256===sha256)){
      // Exact nonlegacy provenance remains a constraint even if optional metadata loses validity.
      if(sha256&&score.isLegacyScore===false)nativeRequired=true;
      if(score.id===sourceKey&&hash(metadata.schemaFingerprint)&&evidence.sourceMd5){
        if(record(score.beatmap)&&hash(score.beatmap.sha256))maps.push(metricInputKey({md5:evidence.sourceMd5,sha256:score.beatmap.sha256}));
        if(score.isLegacyScore===false){nativeRequired=true;nativeScores.push(score);}
      }
    }
  }
  for(const header of headers){
    profiles.push(metricInputKey({header:pick(header,["mode","modsBitmask"]),native:typeof header.version==="number"&&header.version>=30000000}));
    if(!nativeRequired)scores.push(metricInputKey({maxCombo:header.maxCombo??null,score:(Number(header.modsBitmask)&(1<<29))===0?header.score??null:null,
      counts:record(header.counts)?pick(header.counts,["great","ok","meh","miss"]):null}));
  }
  for(const score of nativeScores){
    const mods=Array.isArray(score.mods)?score.mods as LazerMod[]:null;
    const mode=mods?.some(mod=>record(mod)&&mod.acronym==="CL")?"lazer-classic":"lazer";
    const profile=mapPerformanceIdentity("0".repeat(64),mode,mods);
    profiles.push(metricInputKey({ruleset:score.ruleset??null,mods:profile.state==="ready"?profile.inputKey:profile.reason}));
    scores.push(nativePerformanceScoreKey(score));
  }
  const bytes=digestSet(contents),origins=bytes.map(sha=>[sha,origin(sha)?.client??null]);
  return{version:1,nativeRequired,mapKey:metricInputKey({map:digestSet(maps),engine:versions.engine,projection:versions.map,producer:versions.producer}),
    profileKey:metricInputKey({nativeRequired,profiles:digestSet(profiles),contents:bytes,origins:nativeRequired?null:origins}),
    scoreKey:metricInputKey({nativeRequired,scores:digestSet(scores),contents:bytes,aggregate:versions.aggregate,fc:versions.fc})};
}
