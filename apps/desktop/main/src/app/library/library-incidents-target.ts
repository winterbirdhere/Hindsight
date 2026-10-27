import { LIBRARY_INCIDENT_DEPENDENCIES, LIBRARY_INCIDENT_TRACE_LIMITS, LibraryIncidentDependencies,
  LibraryIncidentEvidenceReceipt, validateLibraryIncidentEvidence } from "../../../../shared/library-incidents";
import type { LibraryMetricTargetInput } from "../../../../shared/replay-library-metrics";
import { metricInputKey } from "./library-source-metrics";

const token = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:/+-]{1,128}$/.test(value);
/** Compact query witness for the entire C contract, not a replacement for its per-replay key. */
export const libraryIncidentDependencyRevision = (
  dependencies: Readonly<LibraryIncidentDependencies> = LIBRARY_INCIDENT_DEPENDENCIES,
  traceLimits: Readonly<{ maxRecords: number; maxExportBytes: number }> = LIBRARY_INCIDENT_TRACE_LIMITS,
): string => metricInputKey({ dependencies, traceLimits });
export const LIBRARY_INCIDENT_QUERY_REVISION = libraryIncidentDependencyRevision();
/** The numerical key is opaque: resource/store binding must additionally validate the receipt
 * against the exact replay/map digests before attaching it to this numerical target. */
export function libraryIncidentTarget(numerical: LibraryMetricTargetInput, receipt: LibraryIncidentEvidenceReceipt,
  versions: Readonly<LibraryIncidentDependencies> = LIBRARY_INCIDENT_DEPENDENCIES,
  limits: Readonly<{ maxRecords: number; maxExportBytes: number }> = LIBRARY_INCIDENT_TRACE_LIMITS): LibraryMetricTargetInput {
  if (!numerical || numerical.slot !== "numerical" || numerical.stage !== "S" || !token(numerical.replayId) ||
    !token(numerical.producerVersion) || typeof numerical.inputKey !== "string" || !/^[a-f0-9]{64}$/.test(numerical.inputKey))
    throw new Error("Incident target requires an exact numerical target");
  validateLibraryIncidentEvidence(receipt);
  const fields: (keyof LibraryIncidentDependencies)[] = ["projection", "model", "policy", "grouping", "input", "savedEvidence"];
  if (!versions || Object.keys(versions).length !== fields.length || fields.some(field => !token(versions[field])) ||
    !limits || Object.keys(limits).length !== 2 || !Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1 ||
    limits.maxRecords > 1000000 || !Number.isSafeInteger(limits.maxExportBytes) || limits.maxExportBytes < 1 ||
    limits.maxExportBytes > 64 * 1024 * 1024) throw new Error("Invalid incident dependency or trace budget");
  return { replayId: numerical.replayId, slot: "incidents", stage: "C", producerVersion: versions.projection,
    inputKey: metricInputKey({ numerical: numerical.inputKey, numericalVersion: numerical.producerVersion,
      dependencies: versions, traceLimits: limits, evidence: receipt }) };
}
