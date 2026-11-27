import type { SavedScoreSourceResult } from "../../../../../../libs/osu/core/src/replays/SavedScoreTimeline";
import { LibraryIncidentEvidenceBinding, LibraryIncidentEvidenceReceipt, LIBRARY_INCIDENT_EVIDENCE_VALIDATION_VERSION,
  validateLibraryIncidentEvidence } from "../../../../shared/library-incidents";

const digest = (value: unknown, size: number): string => {
  if (typeof value !== "string" || value.length !== size || !/^[a-f0-9]+$/i.test(value)) throw new Error("Invalid loaded incident evidence digest");
  return value.toLowerCase();
};

/** Already-loaded optional evidence only. No filesystem access, rediscovery, row traversal or cause projection. */
export function projectLibraryIncidentEvidence(source: SavedScoreSourceResult | undefined,
  binding: LibraryIncidentEvidenceBinding): LibraryIncidentEvidenceReceipt {
  const base = { version: 1 as const, replaySha256: binding.replaySha256, mapMd5: binding.mapMd5,
    validationVersion: LIBRARY_INCIDENT_EVIDENCE_VALIDATION_VERSION };
  // No lookup has established absence when this optional field was never supplied.
  const state = source === undefined ? "unavailable" : source?.status;
  if (typeof state !== "string" || !["absent", "validated", "rejected", "unavailable"].includes(state)) throw new Error("Invalid loaded incident evidence state");
  if (state !== "validated") {
    if (source?.timeline !== undefined) throw new Error("Conflicting loaded incident evidence state");
    const receipt = { ...base, state };
    validateLibraryIncidentEvidence(receipt, binding); return Object.freeze(receipt);
  }
  const timeline = source?.timeline;
  if (!timeline || timeline.schema !== "stable-saved-score-v1" || !timeline.provenance ||
    digest(timeline.provenance.mapMd5, 32) !== binding.mapMd5) throw new Error("Invalid loaded incident evidence pairing");
  const receipt = { ...base, state, schema: timeline.schema, timelineSha256: digest(timeline.provenance.timelineSha256, 64),
    pairedReplaySha256: digest(timeline.provenance.pairedReplaySha256, 64), sourceVersion: timeline.provenance.version };
  validateLibraryIncidentEvidence(receipt, binding); return Object.freeze(receipt);
}
