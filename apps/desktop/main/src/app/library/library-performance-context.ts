import { LibraryPerformanceDependencies,LibraryPerformanceObservation,performanceDependencyKeys,nativePerformanceScoreKey } from "./library-performance-dependencies";
import { LibraryPerformanceScoreEvidence,resolveLibraryPerformanceProfile } from "./library-performance-score";
import { projectPerformanceObservation } from "./library-performance-observation";
import { sourceMapEvidence,LibrarySourceOriginLookup } from "./library-source-binding";
import { metricInputKey } from "./library-source-metrics";
export type LibraryPerformanceConsumedOrigin=NonNullable<ReturnType<LibrarySourceOriginLookup>>|null;

export interface LibraryPerformanceContext {
  mapMd5:string|null;replaySha256:string|null;dependencies:LibraryPerformanceDependencies;evidence:LibraryPerformanceScoreEvidence;
}
const ordered=<T>(items:T[]):T[]=>items.map(value=>({value,key:metricInputKey(value)})).sort((a,b)=>a.key.localeCompare(b.key)).map(item=>item.value);
/** All historical locations inform identity/profile constraints; enabled paths are selected separately.
 * Conflicts are independent families, never resolved by source order. */
export function composePerformanceContext(observations:readonly LibraryPerformanceObservation[],origin:LibrarySourceOriginLookup,
  requirements:{nativeRequired:boolean;embeddedRequired:boolean}):LibraryPerformanceContext {
  const dependencies=performanceDependencyKeys(observations,origin,requirements.nativeRequired),maps=new Set<string>(),contents=new Set<string>();
  const headers:NonNullable<LibraryPerformanceScoreEvidence["header"]>[]=[],native:NonNullable<LibraryPerformanceScoreEvidence["native"]>[]=[];
  for(const observation of observations){
    const binding=sourceMapEvidence(observation);if(binding.headerMd5)maps.add(binding.headerMd5);if(binding.sourceMd5)maps.add(binding.sourceMd5);
    if(observation.sha256)contents.add(observation.sha256);
    const evidence=projectPerformanceObservation(observation);
    if(evidence.header)headers.push(evidence.header);if(evidence.native?.isLegacyScore===false)native.push(evidence.native);
  }
  const replaySha256=contents.size===1?[...contents][0]:null;
  const evidence:LibraryPerformanceScoreEvidence={origin:replaySha256?origin(replaySha256)?.client??null:contents.size?"unknown":null,
    nativeRequired:dependencies.nativeRequired,embeddedRequired:requirements.embeddedRequired,trailerStatus:"not-needed"};
  if(headers.length){
    evidence.header=ordered(headers)[0];
    evidence.profileConflict=new Set(headers.map(header=>metricInputKey({mode:header.mode,mask:header.modsBitmask,native:header.version>=30000000}))).size>1;
    evidence.scoreConflict=new Set(headers.map(header=>metricInputKey({counts:header.counts,maxCombo:header.maxCombo,
      score:(header.modsBitmask&(1<<29))===0?header.score:null}))).size>1;
  }
  if(native.length){
    evidence.native=ordered(native)[0];
    const profiles=native.map(value=>resolveLibraryPerformanceProfile({origin:null,nativeRequired:true,native:value}));
    evidence.profileConflict=new Set(profiles.map((value,index)=>value.state==="known"?metricInputKey({profile:value.inputKey,ruleset:native[index].ruleset}):value.reason)).size>1;
    evidence.scoreConflict=new Set(native.map(value=>nativePerformanceScoreKey(value))).size>1;
    const selected=resolveLibraryPerformanceProfile({origin:null,nativeRequired:true,native:evidence.native});
    if(selected.state==="known")evidence.native={...evidence.native,mods:selected.mods};
  }
  const result={mapMd5:maps.size===1?[...maps][0]:null,replaySha256,dependencies,evidence};
  if(Buffer.byteLength(JSON.stringify(result))>128*1024)throw new Error("Performance context byte budget exceeded");
  return result;
}
