import { Subject } from "rxjs";
import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_PERFORMANCE_INPUT_VERSION, LIBRARY_RECONSTRUCTED_FC_VERSION,
  LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION, LIBRARY_TIMELINE_PROJECTION_VERSION } from "../../../../../shared/library-analysis";
import type { LibraryCurrentReplayReceipt, LibraryCurrentReplayRequest } from "../../../../../shared/library-current-replay";
import type { CurrentReplayCaptureContext, CurrentReplayPerformanceSnapshot, CurrentReplayProjectedNumericalSnapshot } from "./library-current-replay";
import { LibraryCurrentReplayPublisher, currentReplayBinding } from "./library-current-replay-publisher";

const receipt: LibraryCurrentReplayReceipt = { version: 1, token: "token", replayId: "replay", replaySha256: "a".repeat(64),
  mapSha256: "b".repeat(64), mapMd5: "c".repeat(32), numericalInputKey: "d".repeat(64),
  parserVersion: LIBRARY_REPLAY_PARSER_VERSION, preparationVersion: LIBRARY_RESOURCE_PREPARATION_VERSION,
  numericalVersion: LIBRARY_NUMERIC_PROJECTION_VERSION };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function fixture() {
  const binding = currentReplayBinding(receipt, "stable", 1, 1)!;
  const state = { time: 300, passedObjects: 1, maxCombo: 1, isFinal: true, statistics: { great: 1, ok: 0, meh: 0, miss: 0,
    large_tick_hit: 0, large_tick_miss: 0, small_tick_hit: 0, small_tick_miss: 0, slider_tail_hit: 0, slider_tail_miss: 0 } };
  const context: CurrentReplayCaptureContext = { generation: 1, binding, performanceInput: { mode: "stable", states: [state], mods: [],
    limitations: [], finalReplayTime: 300, fullComboState: { ...state } } };
  const numerical: CurrentReplayProjectedNumericalSnapshot = { status: "complete", projectionVersion: LIBRARY_NUMERIC_PROJECTION_VERSION,
    projected: { provenance: { replaySha256: binding.replaySha256, mapSha256: binding.mapSha256, mapMd5: binding.mapMd5,
      ruleset: "stable", rate: 1, projectionVersion: LIBRARY_NUMERIC_PROJECTION_VERSION, coverageQualified: true,
      completeAccuracyEvidence: true, completeBreakEvidence: true, completionEvidence: "source-domain-coverage-v1" },
    fields: { completion: { state: "known", value: "passed" }, fc: { state: "known", value: true }, misses: { state: "known", value: 0 } } } };
  let performance: CurrentReplayPerformanceSnapshot | undefined;
  const changed$ = new Subject<number>();
  let current = context;
  const simulator = { isLibraryReplayCurrent: jest.fn(value => value === current),
    captureLibraryNumerical: jest.fn(async (_context, checkpoint: () => Promise<void>) => { await checkpoint(); return numerical; }) };
  const timeline = { changed$, captureLibraryPerformance: jest.fn(() => performance) };
  const request = jest.fn(async (input: LibraryCurrentReplayRequest) => input.method === "current-replay-release" ? { state: "released" }
    : { state: "applied", accepted: input.results.map(result => result.slot) });
  const onError = jest.fn(); const checkpoint = jest.fn(async (): Promise<void> => undefined);
  const publisher = new LibraryCurrentReplayPublisher({ simulator, performance: timeline, request, checkpoint, onError });
  function ready(fc = false) {
    performance = { engineVersion: PERFORMANCE_ENGINE_VERSION, inputVersion: LIBRARY_PERFORMANCE_INPUT_VERSION,
      timelineVersion: LIBRARY_TIMELINE_PROJECTION_VERSION, fcVersion: LIBRARY_RECONSTRUCTED_FC_VERSION, input: context.performanceInput,
      timeline: { mode: "stable", objectCount: 1, endpointVerified: true, pointCount: 1, lastPoint: { time: 300, pp: 0, sr: 1 } },
      fullMap: { status: "ready", description: "test", pp: 0, peakPp: 0, sr: 1,
        ...(fc ? { fullComboPp: 0 } : {}) }, ...(fc ? { fcTimeline: { mode: "stable" as const, objectCount: 1, endpointVerified: true,
          pointCount: 1, lastPoint: { time: 300, pp: 0, sr: 1 } } } : {}) };
    changed$.next(1);
  }
  const publications = () => request.mock.calls.map(([value]) => value).filter((value): value is Extract<LibraryCurrentReplayRequest,
    { method: "current-replay-publish" }> => value.method === "current-replay-publish");
  return { publisher, context, simulator, timeline, request, onError, checkpoint, ready, publications,
    replace: () => { current = { ...context, generation: 2 }; } };
}

it("publishes numerical values detached, then accepted zero PP and FC independently without recapture", async () => {
  const f = fixture(); expect(f.publisher.attach(receipt, f.context)).toBeUndefined();
  expect(f.request).not.toHaveBeenCalled(); await settle();
  expect(f.publications().map(value => value.results.map(result => result.slot))).toEqual([["numerical"]]);
  expect(f.publications()[0].results[0].metrics.fields.misses).toEqual({ state: "known", value: 0 });
  f.ready(); await settle(); f.ready(true); await settle();
  expect(f.publications().map(value => value.results.map(result => result.slot))).toEqual([["numerical"], ["timeline-pp"], ["fc-pp"]]);
  expect(f.publications()[2].results[0].metrics.fields.ppIfFc).toEqual({ state: "known", value: 0 });
  expect(f.simulator.captureLibraryNumerical).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.publications())).not.toMatch(/statistics|performanceInput|fullComboState/);
  f.publisher.dispose();
});
it("coalesces notifications and repeated attachment while capture is parked", async () => {
  const f = fixture(), gate = deferred(); f.checkpoint.mockImplementation(() => gate.promise);
  f.publisher.attach(receipt, f.context); await settle();
  for (let i = 0; i < 20; i++) { f.ready(true); f.publisher.attach(receipt, f.context); }
  expect(f.simulator.captureLibraryNumerical).toHaveBeenCalledTimes(1); expect(f.request).not.toHaveBeenCalled();
  gate.resolve(); await settle();
  expect(f.publications()).toHaveLength(1); expect(f.publications()[0].results.map(value => value.slot)).toEqual(["numerical", "timeline-pp", "fc-pp"]);
  f.publisher.dispose();
});
it("retains a notification arriving during publication and emits only newly completed FC", async () => {
  const f = fixture(), gate = deferred(); f.ready();
  f.request.mockImplementationOnce(async input => { await gate.promise; return { state: "applied", accepted: input.method === "current-replay-publish" ? input.results.map(value => value.slot) : [] }; });
  f.publisher.attach(receipt, f.context); await settle(); f.ready(true); gate.resolve(); await settle();
  expect(f.publications().map(value => value.results.map(result => result.slot))).toEqual([["numerical", "timeline-pp"], ["fc-pp"]]);
  f.publisher.dispose();
});
it.each(["clear", "replace", "dispose"])("drops parked capture after %s without cancelling viewer services", async action => {
  const f = fixture(), gate = deferred(); f.checkpoint.mockImplementation(() => gate.promise);
  f.publisher.attach(receipt, f.context); await settle();
  if (action === "replace") f.replace(); else f.publisher[action as "clear" | "dispose"]();
  gate.resolve(); await settle(); f.ready(true); await settle();
  expect(f.publications()).toEqual([]); expect(f.onError).not.toHaveBeenCalled(); f.publisher.dispose(); await settle();
  expect(f.request.mock.calls.filter(([request]) => request.method === "current-replay-release")).toHaveLength(1);
});
it("stops on failed publication without an error retry loop, and a new context can publish", async () => {
  const f = fixture(); f.request.mockRejectedValueOnce(new Error("Offline"));
  f.publisher.attach(receipt, f.context); await settle(); f.ready(true); await settle();
  expect(f.publications()).toHaveLength(1); expect(f.onError).toHaveBeenCalledTimes(1);
  f.publisher.attach({ ...receipt, token: "new-token" }, f.context); await settle();
  expect(f.publications()).toHaveLength(2); f.publisher.dispose();
});
it.each(["stale", "unavailable"])("does not retry a %s receipt", async state => {
  const f = fixture(); f.request.mockResolvedValueOnce({ state, accepted: [] });
  f.publisher.attach(receipt, f.context); await settle(); f.ready(true); await settle();
  expect(f.publications()).toHaveLength(1); f.publisher.dispose();
});
it("rejects mismatched identity/profile versions and obsolete receipts before capture", async () => {
  const f = fixture(); f.publisher.attach({ ...receipt, numericalInputKey: "e".repeat(64) }, f.context); await settle();
  expect(f.simulator.captureLibraryNumerical).not.toHaveBeenCalled();
  expect(currentReplayBinding({ ...receipt, numericalVersion: "obsolete" }, "stable", 1, 1)).toBeUndefined();
  expect(currentReplayBinding(receipt, "lazer", 0, 1)).toBeUndefined();
  expect(currentReplayBinding(receipt, "stable", 1, 0)).toBeUndefined(); f.publisher.dispose();
});
it("releases a receipt whose viewer preparation never produced a capture", async () => {
  const f = fixture(); f.publisher.discard(receipt); await settle();
  expect(f.request).toHaveBeenCalledWith({ method: "current-replay-release", token: receipt.token });
  expect(f.simulator.captureLibraryNumerical).not.toHaveBeenCalled(); f.publisher.dispose();
});
