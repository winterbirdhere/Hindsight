import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { LIBRARY_PERFORMANCE_INPUT_VERSION,LIBRARY_RECONSTRUCTED_FC_VERSION } from "../../../../shared/library-analysis";
import type { LibraryMetricTargetInput } from "../../../../shared/replay-library-metrics";
import { metricInputKey } from "./library-source-metrics";
export const LIBRARY_FC_VERSIONS={engine:PERFORMANCE_ENGINE_VERSION,input:LIBRARY_PERFORMANCE_INPUT_VERSION,projection:LIBRARY_RECONSTRUCTED_FC_VERSION};
export function libraryFcTarget(numerical:LibraryMetricTargetInput,versions=LIBRARY_FC_VERSIONS):LibraryMetricTargetInput {
  if(numerical.slot!=="numerical"||numerical.stage!=="S")throw new Error("FC requires a numerical target");
  return{replayId:numerical.replayId,slot:"fc-pp",stage:"S",producerVersion:versions.projection,
    inputKey:metricInputKey({numerical:numerical.inputKey,numericalVersion:numerical.producerVersion,...versions})};
}
