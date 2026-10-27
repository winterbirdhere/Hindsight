import type { LibraryMetricResult } from "./replay-library-metrics";
import type { LibraryIncidentEvidenceReceipt } from "./library-incidents";
export type LibraryAnalysisContinuation=boolean|"fc"|"incidents";
export type LibraryTimelineOutcome={metrics:LibraryMetricResult}|{error:string};
export const LIBRARY_NUMERIC_PROJECTION_VERSION = "library-numeric-v6";
export const LIBRARY_REPLAY_PARSER_VERSION = "library-replay-parser-v1";
export const LIBRARY_RESOURCE_PREPARATION_VERSION = "library-resource-v1";
export const LIBRARY_TIMELINE_PROJECTION_VERSION="library-timeline-v1";
export const LIBRARY_PERFORMANCE_INPUT_VERSION="library-performance-input-v1";
export const LIBRARY_RECONSTRUCTED_FC_VERSION="library-reconstructed-fc-v1";

export interface LibraryNumericalBinding {
  replaySha256:string;mapSha256:string;mapMd5:string;
  /** Exact verified resources and complete profile inputs; never inferred from miss counts. */
  exactMapAndProfile:boolean;
  sourceCompletion?:{sourcePassed?:boolean;sourceVerified?:boolean;conflicting?:boolean};
}
export interface LibraryNumericalResourceInput {
  format:"resources";replayBytes:number;mapBytes:number;binding:LibraryNumericalBinding;
}
export type LibraryConsumedOrigin={client:"stable"|"lazer";provenance:"user-confirmed"}|null;
/** Internal utility/main recipe; never included in renderer worker inputs or scalar metrics. */
export interface LibraryNumericalInputRecipe {
  version:1;replaySha256:string;fixedKey:string;intrinsicNative:boolean;
  embeddedModsHash:string|null;legacyModsHash:string;modeQualified:boolean;
  consumedModsSource:"embedded"|"native-database"|"legacy-mask";
}
export interface LibraryNumericalResourceDescriptor {
  input:LibraryNumericalResourceInput;
  target:{slot:"numerical";stage:"S";inputKey:string;producerVersion:string};
  origin:LibraryConsumedOrigin;
  recipe:LibraryNumericalInputRecipe;
  /** Compact C-only receipt. Optional for older fixture/transport callers; production emits it. */
  incidentEvidence?:LibraryIncidentEvidenceReceipt;
}
