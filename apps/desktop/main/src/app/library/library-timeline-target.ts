import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { LIBRARY_PERFORMANCE_INPUT_VERSION, LIBRARY_TIMELINE_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import type { LibraryMetricTargetInput } from "../../../../shared/replay-library-metrics";
import { metricInputKey } from "./library-source-metrics";

export const LIBRARY_TIMELINE_VERSIONS={engine:PERFORMANCE_ENGINE_VERSION,input:LIBRARY_PERFORMANCE_INPUT_VERSION,projection:LIBRARY_TIMELINE_PROJECTION_VERSION};
/** Timeline depends on the same exact replay/map/profile, plus only its own mathematical revisions. */
export function libraryTimelineTarget(numerical:LibraryMetricTargetInput,versions=LIBRARY_TIMELINE_VERSIONS):LibraryMetricTargetInput {
  if(numerical.slot!=="numerical"||numerical.stage!=="S")throw new Error("Timeline requires a numerical target");
  return{replayId:numerical.replayId,slot:"timeline-pp",stage:"S",producerVersion:versions.projection,
    inputKey:metricInputKey({numerical:numerical.inputKey,numericalVersion:numerical.producerVersion,...versions})};
}
