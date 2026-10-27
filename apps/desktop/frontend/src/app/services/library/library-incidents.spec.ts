import { buildBeatmap, parseBlueprint, parseReplayFramesWithDiagnostics, retrieveEventsAsync } from "@osujs/core";
import { traceMapText } from "../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import type { OsuReplay } from "../../model/OsuReplay";
import type { LibraryNumericalBinding } from "../../../../../shared/library-analysis";
import type { LibraryMetricResult } from "../../../../../shared/replay-library-metrics";
import { groupIncidents } from "../analysis/incidents";
import { summarizeReplayEvents } from "../analysis/replay-events";
import { runMissAnalysis } from "../analysis/miss-explanation/MissAnalysisRunner";
import { LIBRARY_INCIDENT_TRACE_LIMITS } from "./library-incidents-contract";
import type { TraceRunIdentity } from "@osujs/core";
import { runLibraryNumerical } from "./library-numerical";
import * as producer from "./library-incidents";

const binding: LibraryNumericalBinding = { replaySha256: "a".repeat(64), mapSha256: "b".repeat(64), mapMd5: "c".repeat(32), exactMapAndProfile: true };
const checkpoint = async () => undefined;
async function fixture(native = false, hit = false) {
  const map = buildBeatmap(parseBlueprint(traceMapText("100,192,1000,1,0\n100,192,2000,1,0")), { mods: [], addStacking: false });
  const parsed = parseReplayFramesWithDiagnostics(hit ? "0|256|-500|0,0|256|-500|0,0|100|192|0,1000|100|192|5,1|100|192|0,999|100|192|5,200|100|192|0," :
    "0|256|-500|0,0|256|-500|0,0|500|192|0,1500|500|192|0,1000|500|192|0,");
  const replay: OsuReplay = { md5hash: "fixture", beatmapMd5: binding.mapMd5, replayContentSha256: binding.replaySha256,
    player: "fixture", gameVersion: native ? 30000016 : 20200101, mods: [], frames: parsed.frames, parseDiagnostics: parsed.diagnostics };
  return { map, replay, numerical: await runLibraryNumerical(map, replay, binding, checkpoint) };
}
type Run = (map: Awaited<ReturnType<typeof fixture>>["map"], replay: OsuReplay, exact: LibraryNumericalBinding,
  numerical: Awaited<ReturnType<typeof runLibraryNumerical>>, checkpoint: () => Promise<void>) => Promise<LibraryMetricResult>;
const run: Run = (...args) => (producer as unknown as { runLibraryIncidents: Run }).runLibraryIncidents(...args);

it("provides the production incident count entrypoint", () => {
  expect((producer as unknown as Record<string, unknown>).runLibraryIncidents).toEqual(expect.any(Function));
});

it.each([false, true])("publishes completed canonical navigation incident counts, native=%s", async native => {
  const f = await fixture(native), before = JSON.stringify(f.numerical.metrics);
  const result = await run(f.map, f.replay, binding, f.numerical, checkpoint);
  expect(result.fields).toEqual({ incidentCount: { state: "known", value: 2 } });
  expect(result.provenance).toMatchObject({ replaySha256: binding.replaySha256, mapSha256: binding.mapSha256, ruleset: native ? "lazer" : "stable" });
  expect(Object.keys(result)).toEqual(["fields", "provenance"]);
  expect(JSON.stringify(result)).not.toMatch(/"(?:trace|causes|classifications|events|frames|explanations)"/);
  expect(JSON.stringify(f.numerical.metrics)).toBe(before);
});

it("publishes an actual zero only after qualified complete analysis", async () => {
  const f = await fixture(false, true);
  expect((await run(f.map, f.replay, binding, f.numerical, checkpoint)).fields.incidentCount).toEqual({ state: "known", value: 0 });
  expect((await run(f.map, f.replay, { ...binding, exactMapAndProfile: false }, f.numerical, checkpoint)).fields.incidentCount.state).toBe("unknown");
});

it("does not reuse a numerical result from another resource/profile or absent qualified coverage", async () => {
  const f = await fixture();
  for (const provenance of [{ ...f.numerical.metrics.provenance, replaySha256: "d".repeat(64) },
    { ...f.numerical.metrics.provenance, ruleset: "lazer" }, { ...f.numerical.metrics.provenance, coverageQualified: false }]) {
    const numerical = { ...f.numerical, metrics: { ...f.numerical.metrics, provenance } };
    expect((await run(f.map, f.replay, binding, numerical, checkpoint)).fields.incidentCount.state).toBe("unknown");
  }
});

it("rejects contradictory exact content and preserves cancellation identity", async () => {
  const f = await fixture(), cancellation = new Error("owner stopped C");
  await expect(run(f.map, { ...f.replay, replayContentSha256: "d".repeat(64) }, binding, f.numerical, checkpoint)).rejects.toThrow(/binding/);
  await expect(run(f.map, f.replay, binding, f.numerical, async () => { throw cancellation; })).rejects.toBe(cancellation);
});

it("preserves numerical results when C is cancelled after capture begins", async () => {
  const f = await fixture(), before = JSON.stringify(f.numerical.metrics), cancellation = new Error("cancel capture"); let calls = 0;
  await expect(run(f.map, f.replay, binding, f.numerical, async () => { if (++calls === 10) throw cancellation; })).rejects.toBe(cancellation);
  expect(calls).toBe(10); expect(JSON.stringify(f.numerical.metrics)).toBe(before);
});

it("keeps accepted blank diagnoses separate from missing analysis", async () => {
  const f = await fixture();
  const events = await retrieveEventsAsync(f.numerical.state, f.map.hitObjects, "stable", checkpoint);
  const errors = summarizeReplayEvents(events, "stable").errors;
  expect(groupIncidents(errors, events, "stable")).toHaveLength(2);
  // The production runner must complete C rather than publishing this provisional simulator count.
  const result = await run(f.map, f.replay, binding, f.numerical, checkpoint);
  expect(result.provenance.countBasis).toBe("completed-classified-navigation");
  expect(result.provenance.analysisStatus).toMatch(/ready|partial/);
});

it("keeps incident availability independent of the optional strip size/state", async () => {
  const f = await fixture();
  const numerical = { ...f.numerical, metrics: { ...f.numerical.metrics,
    errorStrip: { state: "unknown" as const, reason: "strip-size-limit" } } };
  expect((await run(f.map, f.replay, binding, numerical, checkpoint)).fields.incidentCount).toEqual({ state: "known", value: 2 });
});

async function classifiedFixture() {
  const f = await fixture();
  if (!f.replay.parseDiagnostics) throw new Error("Expected parsed fixture");
  const identity: TraceRunIdentity = { schemaVersion: 2, replayContentSha256: binding.replaySha256,
    beatmapContentSha256: binding.mapSha256, beatmapMd5: binding.mapMd5, generationKey: "fixture",
    recordingClient: "stable", analysisProfileId: "stable", analysisProfileFingerprint: "fixture-current-profile",
    parserVersion: f.replay.parseDiagnostics.parserVersion, inputPreparationVersion: "scoring-endpoint-provenance-v2" };
  const events = await retrieveEventsAsync(f.numerical.state, f.map.hitObjects, "stable", checkpoint);
  const session = await runMissAnalysis({ beatmap: f.map, frames: f.numerical.scoring.frames, domain: f.numerical.scoring.domain,
    profile: "stable", identity, limits: LIBRARY_INCIDENT_TRACE_LIMITS, recording: { gameVersion: f.replay.gameVersion },
    additionalLimitations: [] }, checkpoint);
  if ((session.status !== "ready" && session.status !== "partial") || !session.analysis) throw new Error("Expected captured fixture");
  return { ...f, events, session, identity, analysis: session.analysis };
}

it("refuses unavailable, stale, truncated and incomplete classified results without substituting simulator groups", async () => {
  const f = await classifiedFixture(), analysis = f.analysis;
  const cases = [
    { status: "building" as const }, { status: "unsupported" as const, reasons: ["unsupported-profile"] },
    { ...f.session, identity: { ...f.identity, analysisProfileFingerprint: "other" } },
    { ...f.session, trace: { ...f.session.trace, failures: ["record-limit"] } },
    { ...f.session, analysis: { ...analysis, classifications: analysis.classifications.slice(1) } },
    { ...f.session, analysis: { ...analysis, inventory: { ...analysis.inventory, limitations: ["error-atom-limit:10000"] } } },
  ];
  for (const session of cases) expect((await producer.projectLibraryIncidents(f.events, session, f.identity, checkpoint)).fields.incidentCount.state).toBe("unknown");
});

it("accepts completed partial sessions with advisory saved-score disagreement and unresolved individual causes", async () => {
  const f = await classifiedFixture();
  const session = { ...f.session, status: "partial" as const, reasons: ["saved-outcome-model-conflict"],
    analysis: { ...f.analysis, limitations: ["saved-outcome-model-conflict"],
      classifications: f.analysis.classifications.map(entry => ({ ...entry,
        mechanism: { status: "unavailable" as const, codes: [], headline: "", description: "", eventIds: [], limitations: ["no-supported-diagnosis"] } })) } };
  expect((await producer.projectLibraryIncidents(f.events, session, f.identity, checkpoint)).fields.incidentCount).toEqual({ state: "known", value: 2 });
});

it("uses the canonical analysis-only proof link rather than proximity or raw miss count", async () => {
  const f = await classifiedFixture(), analysis = f.analysis, atom = analysis.inventory.atoms[1];
  const session = { ...f.session, analysis: { ...analysis, classifications: analysis.classifications.map(entry => entry.atomId !== atom.id ? entry :
    { ...entry, mechanism: { status: "supported" as const, codes: ["notelock"], headline: "", description: "", eventIds: [], limitations: [],
      diagnostics: { primary: { directRejections: [{ blockerId: analysis.inventory.atoms[0].componentId }] } } } }) } };
  const errors = summarizeReplayEvents(f.events, "stable").errors;
  expect(groupIncidents(errors, f.events, "stable", session)).toHaveLength(1);
  expect((await producer.projectLibraryIncidents(f.events, session, f.identity, checkpoint)).fields.incidentCount).toEqual({ state: "known", value: 1 });
});
