import { LIBRARY_INCIDENT_SEMANTIC_REVISION } from "./library-incident-semantic-revision";

export const LIBRARY_INCIDENT_PROJECTION_VERSION = "library-incidents-v1";
export interface LibraryIncidentDependencies {
  projection: string; model: string; policy: string; grouping: string; input: string; savedEvidence: string;
}
export const LIBRARY_INCIDENT_DEPENDENCIES: Readonly<LibraryIncidentDependencies> = Object.freeze({
  projection: LIBRARY_INCIDENT_PROJECTION_VERSION, model: LIBRARY_INCIDENT_SEMANTIC_REVISION,
  policy: "all-errors-root-receipt-boundary-v33", grouping: "proof-linked-navigation-v1",
  input: "scoring-endpoint-provenance-v2", savedEvidence: "stable-saved-score-v1",
});
export const LIBRARY_INCIDENT_TRACE_LIMITS = Object.freeze({ maxRecords: 200000, maxExportBytes: 64 * 1024 * 1024 });
export const LIBRARY_INCIDENT_EVIDENCE_VALIDATION_VERSION = "library-saved-evidence-v1";
export interface LibraryIncidentEvidenceBinding { replaySha256: string; mapMd5: string }
interface EvidenceBase extends LibraryIncidentEvidenceBinding { version: 1; validationVersion: string }
export type LibraryIncidentEvidenceReceipt =
  | (EvidenceBase & { state: "absent" | "rejected" | "unavailable" })
  | (EvidenceBase & { state: "validated"; schema: "stable-saved-score-v1"; timelineSha256: string;
      pairedReplaySha256: string; sourceVersion: number });

const digest = (value: unknown, size: number): value is string =>
  typeof value === "string" && value.length === size && /^[a-f0-9]+$/.test(value);
const token = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value);

/** A receipt is small scalar data, never a serialized saved-score graph or file locator. */
export function validateLibraryIncidentEvidence(value: unknown, binding?: LibraryIncidentEvidenceBinding): asserts value is LibraryIncidentEvidenceReceipt {
  const invalid = () => { throw new Error("Invalid incident evidence receipt"); };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length < 5 || keys.length > 9 || keys.some(key => typeof key !== "string")) return invalid();
  const data = value as Record<string, unknown>;
  // Do not invoke accessors/toJSON while validating an IPC/storage envelope.
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property) || !property.enumerable) return invalid();
  }
  const expected = ["version", "state", "replaySha256", "mapMd5", "validationVersion"];
  if (data.state === "validated") expected.push("schema", "timelineSha256", "pairedReplaySha256", "sourceVersion");
  if (keys.length !== expected.length || keys.some(key => !expected.includes(String(key))) || data.version !== 1 ||
    typeof data.state !== "string" || !["absent", "validated", "rejected", "unavailable"].includes(data.state) ||
    !digest(data.replaySha256, 64) || !digest(data.mapMd5, 32) || !token(data.validationVersion)) return invalid();
  if (binding && (!digest(binding.replaySha256, 64) || !digest(binding.mapMd5, 32) ||
    binding.replaySha256 !== data.replaySha256 || binding.mapMd5 !== data.mapMd5)) return invalid();
  if (data.state === "validated" && (data.schema !== "stable-saved-score-v1" || !digest(data.timelineSha256, 64) ||
    data.pairedReplaySha256 !== data.replaySha256 || !Number.isSafeInteger(data.sourceVersion) ||
    Number(data.sourceVersion) < 1 || Number(data.sourceVersion) > 2147483647)) return invalid();
}
