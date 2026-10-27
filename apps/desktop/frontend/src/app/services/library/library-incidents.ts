import { createHash } from "crypto";
import { Beatmap, errorCapabilities, ReplayAnalysisEvent, retrieveEventsAsync, TraceRunIdentity } from "@osujs/core";
import type { LibraryNumericalBinding } from "../../../../../shared/library-analysis";
import { LIBRARY_RESOURCE_PREPARATION_VERSION } from "../../../../../shared/library-analysis";
import type { LibraryMetricResult } from "../../../../../shared/replay-library-metrics";
import { isLazerReplay, OsuReplay } from "../../model/OsuReplay";
import { createErrorAnalysisLookupsAsync } from "../analysis/error-analysis-lookups";
import { matchErrorAtom } from "../analysis/error-atom-match";
import { groupIncidentsAsync } from "../analysis/incidents";
import { runMissAnalysis } from "../analysis/miss-explanation/MissAnalysisRunner";
import type { MissExplanationSessionState } from "../analysis/miss-explanation/MissExplanationSession";
import { summarizeReplayEventsAsync } from "../analysis/replay-events";
import type { runLibraryNumerical } from "./library-numerical";
import { LIBRARY_INCIDENT_DEPENDENCIES, LIBRARY_INCIDENT_PROJECTION_VERSION, LIBRARY_INCIDENT_TRACE_LIMITS } from "./library-incidents-contract";

type Numerical = Awaited<ReturnType<typeof runLibraryNumerical>>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameIdentity = (actual: TraceRunIdentity, expected: TraceRunIdentity) =>
  Object.keys(expected).every(key => actual[key as keyof TraceRunIdentity] === expected[key as keyof TraceRunIdentity]);
const unknown = (reason: string, identity?: TraceRunIdentity): LibraryMetricResult => ({
  fields: { incidentCount: { state: "unknown", reason } },
  provenance: { projectionVersion: LIBRARY_INCIDENT_PROJECTION_VERSION,
    ...(identity ? { replaySha256: identity.replayContentSha256, mapSha256: identity.beatmapContentSha256,
      mapMd5: identity.beatmapMd5, ruleset: identity.analysisProfileId } : {}) },
});

/** Completed canonical analysis may retain accepted blank diagnoses and advisory limitations.
 * Missing/truncated inventory is different: it cannot supply a final classified incident count. */
export async function projectLibraryIncidents(events: readonly ReplayAnalysisEvent[], session: MissExplanationSessionState,
  identity: TraceRunIdentity, checkpoint: () => Promise<void>): Promise<LibraryMetricResult> {
  await checkpoint();
  if ((identity.analysisProfileId !== "stable" && identity.analysisProfileId !== "lazer") ||
    (session.status !== "ready" && session.status !== "partial")) return unknown("incident-analysis-unavailable", identity);
  const ruleset = identity.analysisProfileId, analysis = session.analysis;
  if (!sameIdentity(session.identity, identity) || !sameIdentity(session.trace.identity, identity))
    return unknown("incident-analysis-identity-mismatch", identity);
  if (!analysis || analysis.policyVersion !== LIBRARY_INCIDENT_DEPENDENCIES.policy ||
    analysis.capabilities.scoring !== "supported" || analysis.capabilities.profile !== ruleset ||
    session.trace.failures.length || session.trace.droppedRecordBoundary !== undefined || analysis.inventory.limitations.length)
    return unknown("incident-analysis-incomplete", identity);
  const context = await createErrorAnalysisLookupsAsync(events, ruleset, session, checkpoint);
  // Every inventory atom must have one completed classification. An unavailable individual cause
  // is an accepted classifier answer, not evidence that its entire ordered pass was skipped.
  if (analysis.classifications.length !== analysis.inventory.atoms.length) return unknown("incident-analysis-incomplete", identity);
  for (let index = 0; index < analysis.inventory.atoms.length; index++) {
    if (index % 256 === 0) await checkpoint(); const atom = analysis.inventory.atoms[index];
    if (!sameIdentity(atom.identity, identity) || context.atomsById.get(atom.id)?.length !== 1 ||
      context.classificationsByAtom.get(atom.id)?.length !== 1) return unknown("incident-analysis-incomplete", identity);
  }
  for (let index = 0; index < events.length; index++) {
    if (index % 256 === 0) await checkpoint(); const event = events[index];
    if (event.ruleset !== ruleset || !Number.isFinite(event.objectTime ?? event.time) ||
      !Number.isFinite(event.judgementTime) || (event.judgementTime as number) > session.trace.domain.endTimeMs)
      return unknown("incident-event-domain-mismatch", identity);
  }
  const { errors } = await summarizeReplayEventsAsync(events, ruleset, checkpoint);
  for (let index = 0; index < errors.length; index++) {
    if (index % 256 === 0) await checkpoint();
    if (!matchErrorAtom(errors[index], events, ruleset, session, context)) return unknown("incident-error-evidence-missing", identity);
  }
  const incidents = await groupIncidentsAsync(errors, events, ruleset, session, checkpoint, context);
  await checkpoint();
  return { fields: { incidentCount: { state: "known", value: incidents.length } }, provenance: {
    replaySha256: identity.replayContentSha256, mapSha256: identity.beatmapContentSha256, mapMd5: identity.beatmapMd5,
    ruleset, projectionVersion: LIBRARY_INCIDENT_PROJECTION_VERSION, modelRevision: LIBRARY_INCIDENT_DEPENDENCIES.model,
    policyVersion: analysis.policyVersion, groupingVersion: LIBRARY_INCIDENT_DEPENDENCIES.grouping,
    countBasis: "completed-classified-navigation", analysisStatus: session.status, scoreOrigin: "reconstructed",
  } };
}

/** C-only continuation. Uses retained S state/domain and never publishes its transient trace or causes. */
export async function runLibraryIncidents(map: Beatmap, replay: OsuReplay, binding: LibraryNumericalBinding,
  numerical: Numerical, checkpoint: () => Promise<void>): Promise<LibraryMetricResult> {
  await checkpoint();
  if (!/^[a-f0-9]{64}$/.test(binding.replaySha256) || !/^[a-f0-9]{64}$/.test(binding.mapSha256) || !/^[a-f0-9]{32}$/.test(binding.mapMd5) ||
    replay.beatmapMd5.toLowerCase() !== binding.mapMd5 ||
    replay.replayContentSha256 !== undefined && replay.replayContentSha256.toLowerCase() !== binding.replaySha256)
    throw new Error("Incident replay/map binding is invalid or contradictory");
  const profile = isLazerReplay(replay) ? "lazer" : "stable", provenance = numerical.metrics.provenance;
  if (!binding.exactMapAndProfile || (replay.gameMode ?? 0) !== 0 || !replay.parseDiagnostics ||
    errorCapabilities(map, profile).scoring !== "supported" || provenance.coverageQualified !== true ||
    provenance.replaySha256 !== binding.replaySha256 || provenance.mapSha256 !== binding.mapSha256 ||
    provenance.mapMd5 !== binding.mapMd5 || provenance.ruleset !== profile ||
    numerical.state.currentTime !== numerical.scoring.endTime)
    return unknown("incident-input-evidence-unavailable");
  const saved = replay.savedScoreSource?.status === "validated" ? replay.savedScoreSource.timeline : undefined;
  if (saved && (profile !== "stable" || saved.provenance.pairedReplaySha256 !== binding.replaySha256 ||
    saved.provenance.mapMd5 !== binding.mapMd5 || !/^[a-f0-9]{64}$/.test(saved.provenance.timelineSha256)))
    return unknown("incident-saved-evidence-mismatch");
  const identity: TraceRunIdentity = {
    schemaVersion: 2, replayContentSha256: binding.replaySha256, beatmapContentSha256: binding.mapSha256, beatmapMd5: binding.mapMd5,
    generationKey: hash({ ...binding, end: numerical.scoring.endTime, dependencies: LIBRARY_INCIDENT_DEPENDENCIES }),
    recordingClient: profile, analysisProfileId: profile,
    analysisProfileFingerprint: hash({ dependencies: LIBRARY_INCIDENT_DEPENDENCIES, profile, mapSha256: binding.mapSha256,
      preparation: LIBRARY_RESOURCE_PREPARATION_VERSION, gameVersion: replay.gameVersion, timestamp: replay.timestamp,
      sourceClient: replay.sourceClient, sourceProvenance: replay.sourceProvenance, mods: replay.mods, lazerMods: replay.lazerMods,
      resolvedMods: map.appliedMods, resolvedNative: map.lazerModSettings, rate: map.gameClockRate, difficulty: map.difficulty,
      stableOverallDifficulty: map.stableOverallDifficulty, savedSha256: saved?.provenance.timelineSha256 ?? null }),
    parserVersion: replay.parseDiagnostics.parserVersion, inputPreparationVersion: LIBRARY_INCIDENT_DEPENDENCIES.input,
  };
  const events = await retrieveEventsAsync(numerical.state, map.hitObjects, profile, checkpoint);
  const session = await runMissAnalysis({ beatmap: map, frames: numerical.scoring.frames, domain: numerical.scoring.domain,
    profile, identity, limits: LIBRARY_INCIDENT_TRACE_LIMITS, recording: { gameVersion: replay.gameVersion, timestamp: replay.timestamp },
    retentionState: numerical.state, additionalLimitations: [], saved }, checkpoint);
  await checkpoint();
  if (session.status === "error") throw new Error(`Incident analysis failed: ${session.reasons.join(", ").slice(0,1024)}`);
  return projectLibraryIncidents(events, session, identity, checkpoint);
}
