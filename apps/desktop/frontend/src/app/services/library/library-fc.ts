import { PERFORMANCE_ENGINE_VERSION,PerformanceRequest } from "@rewind/osu-performance/protocol";
import { readAggregatePerformanceResult } from "@rewind/osu-performance/aggregate-result";
import type { ReplayPerformanceInput } from "@rewind/osu-performance/types";
import type { LibraryMetricResult } from "../../../../../shared/replay-library-metrics";
import { LIBRARY_RECONSTRUCTED_FC_VERSION } from "../../../../../shared/library-analysis";
export function libraryFcCalculation(input:ReplayPerformanceInput,numerical:LibraryMetricResult,objectCount:number):PerformanceRequest["calculations"][number]|undefined {
  const completion=numerical.fields.completion,state=input.fullComboState;
  if(numerical.provenance.coverageQualified!==true||completion?.state!=="known"||completion.value!=="passed"||
    !Number.isSafeInteger(objectCount)||objectCount<1||!state||state.passedObjects!==objectCount)return undefined;
  return{mode:input.mode,mods:input.mods,scope:"full-map",states:[state]};
}
export function projectLibraryFc(input:ReplayPerformanceInput,response:unknown,objectCount:number,numerical:LibraryMetricResult):LibraryMetricResult {
  const calculation=libraryFcCalculation(input,numerical,objectCount),completion=numerical.fields.completion;
  const value=calculation?readAggregatePerformanceResult(response,{mode:input.mode,objectCount,time:calculation.states[0].time}):undefined;
  if(calculation&&value?.state!=="known")throw new Error("Invalid library FC performance response");
  return{provenance:{replaySha256:numerical.provenance.replaySha256,mapSha256:numerical.provenance.mapSha256,mapMd5:numerical.provenance.mapMd5,
    ruleset:input.mode,coverageQualified:numerical.provenance.coverageQualified===true,scoreOrigin:"reconstructed",
    projectionVersion:LIBRARY_RECONSTRUCTED_FC_VERSION,engineVersion:PERFORMANCE_ENGINE_VERSION},
    fields:{ppIfFc:value??(numerical.provenance.coverageQualified===true&&completion?.state==="known"&&completion.value==="failed"
      ?{state:"not-applicable",reason:"failed-play"}:{state:"unknown",reason:"fc-completion-unavailable"})}};
}
