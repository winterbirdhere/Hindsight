import { ReplayTraceObserver } from "../src/gameplay/trace/ReplayTraceObserver";
import { createReplayTraceCollector } from "../src/gameplay/trace/ReplayTraceCollector";
import { SliderTrackingSnapshot } from "../src/gameplay/error-analysis/ErrorObservations";
import { Spinner } from "../src/hitobjects/Spinner";
import { initialSpinnerState, updateSpinnerRotation } from "../src/gameplay/SpinnerTracking";
import { classifySliderLoss, classifySpinnerLoss } from "../src/gameplay/error-analysis/ComponentMechanisms";
import { traceBeatmap, traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { ReplayTraceRecord } from "../src/gameplay/trace/ReplayTrace";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { advanceStableSpinnerBody } from "../src/gameplay/StableSpinnerTracking";

function observer(endTimeMs = 3100, recordedInputs = 0) {
  const collector = createReplayTraceCollector(
    {
      schemaVersion: 2,
      replayContentSha256: null,
      beatmapContentSha256: null,
      beatmapMd5: null,
      generationKey: "component-observations",
      recordingClient: "lazer",
      analysisProfileId: "lazer",
      analysisProfileFingerprint: "test",
      parserVersion: "test",
      inputPreparationVersion: "test",
    },
    {
      endTimeMs,
      endpointBasis: "recorded-end",
      synthesizedEndpoint: false,
      sourceCoverageLimits: [],
      ...(recordedInputs
        ? {
            frameSources: Array.from({ length: recordedInputs }, (_, parsedFrameIndex) => ({
              origin: "parsed" as const,
              parsedFrameIndex,
            })),
          }
        : {}),
    },
    { maxRecords: 1000, maxExportBytes: 1000000 },
  );
  return { collector, observer: new ReplayTraceObserver(collector) };
}
const tracking = (timeMs: number, x: number): SliderTrackingSnapshot => ({
  timeMs,
  position: { x, y: 0 },
  ball: { x: 0, y: 0 },
  radius: 32,
  geometryAccepted: true,
  holdAccepted: true,
  started: true,
  actions: [0],
  beforeTracking: true,
  tracking: true,
});
const checkpoint = {
  kind: "slider-checkpoint",
  componentId: "s/t",
  parentId: "s",
  component: "slider-tick",
  deadlineMs: 1500,
  objectTimeMs: 1500,
  hit: false,
  lateAcquisition: false,
} as const;

describe("compact rule-owned motion evidence", () => {
  it("retains three preceding distinct-time snapshots without exporting each ordinary update", () => {
    const { collector, observer: trace } = observer();
    for (let t = 1000; t <= 1500; t += 10) trace.tracking("s", tracking(t, t / 100));
    trace.component(checkpoint, 1500);
    const result = collector.seal();
    const point = result.records.find((r) => r.kind === "slider-checkpoint");
    expect(point?.kind).toBe("slider-checkpoint");
    if (point?.kind !== "slider-checkpoint") throw new Error("missing checkpoint");
    expect(point.motion?.map((p) => p.timeMs)).toEqual([1470, 1480, 1490]);
    expect(result.records.filter((r) => r.kind === "slider-tracking")).toHaveLength(1);
    expect(result.failures).toEqual([]);
  });
  it("does not bridge an equal-time cursor jump", () => {
    const { collector, observer: trace } = observer();
    trace.tracking("s", tracking(1300, 10));
    trace.tracking("s", tracking(1400, 20));
    trace.tracking("s", tracking(1400, 80));
    trace.tracking("s", tracking(1500, 90));
    trace.component(checkpoint, 1500);
    const point = collector.seal().records.find((r) => r.kind === "slider-checkpoint");
    expect(point?.kind === "slider-checkpoint" && point.motion?.map((p) => p.timeMs)).toEqual([1400]);
  });
  it("records native anti-reversal suppression from actual tracker states and does not confuse rounded turns", () => {
    const { collector, observer: trace } = observer(3100, 4);
    const spinner = new Spinner();
    Object.assign(spinner, { id: "sp", startTime: 1000, duration: 2000, spinsRequired: 2 });
    const position = (degrees: number) => ({
      x: 256 - 100 * Math.sin((degrees * Math.PI) / 180),
      y: 192 + 100 * Math.cos((degrees * Math.PI) / 180),
    });
    let state = initialSpinnerState(position(0));
    for (const [time, angle] of [
      [1000, 0],
      [1100, 90],
      [1200, 45],
      [3000, 45],
    ]) {
      // The observation's classification requires the actual ordered input span,
      // not just calls to a rotation tracker with an asserted held boolean.
      trace.input(
        { ...traceFrame(time, 0, [0]), position: position(angle) },
        time === 1000 ? [] : [0],
        time === 1000 ? [0] : [],
      );
      const next = updateSpinnerRotation(state, position(angle), true, 1, spinner.spinsRequired, time);
      trace.spinnerStep(spinner, time, true, state, next, "lazer", false);
      state = next;
    }
    trace.spinnerResolution(spinner, "MISS", 3000, state, "lazer", false);
    const result = collector.seal().records.find((r) => r.kind === "spinner-resolution");
    if (result?.kind !== "spinner-resolution") throw new Error("missing spinner");
    expect(result.summary.reversalLostProgress).toBeCloseTo(45);
    expect(result.summary.firstMotionMs).toBe(1100);
    expect(result.summary.lastMotionMs).toBe(1200);
    expect(result.summary.trailingIdleMs).toBe(1800);
    expect(result.summary.observedDurationMs).toBe(2000);
    expect(result.summary.sourceCoverageComplete).toBe(true);
    expect(classifySpinnerLoss(result, { spinner: "manual" }).codes).toEqual(["stopped-early", "reversed-spin"]);
  });
  it.each([-0.02, 0])("records actual Stable velocity braking only for an opposite target (%s)", (target) => {
    const { collector, observer: trace } = observer();
    const spinner = new Spinner();
    Object.assign(spinner, { id: "sp", startTime: 1000, duration: 2000, spinsRequired: 5 });
    const before = {
      ...initialSpinnerState({ x: 356, y: 192 }),
      stableAngularVelocity: 0.02,
      stableTargetVelocity: target,
      stableRequiredHalfTurns: 10,
      stableScoredHalfTurns: 1,
      stableHalfTurns: 1,
    };
    const after = advanceStableSpinnerBody(before, spinner, 1100, 10, 1);
    expect(Math.abs(after.stableAngularVelocity!)).toBeLessThan(0.02);
    trace.spinnerStep(spinner, 1100, true, before, after, "stable", false);
    trace.spinnerResolution(spinner, "MISS", 3001, after, "stable", false);
    const result = collector.seal().records.find((r) => r.kind === "spinner-resolution");
    if (result?.kind !== "spinner-resolution") throw new Error("missing spinner");
    expect(result.summary.reversalBrakingSamples).toBe(target < 0 ? 1 : 0);
    expect(result.summary.reversalLostProgress).toBe(0);
  });
});

describe("component classifiers consume actual rule branches", () => {
  for (const profile of ["stable", "lazer"] as const)
    for (const aimed of [false, true])
      for (const held of [false, true]) {
        it(`${profile} legal checkpoint gate vector aimed=${aimed}, held=${held} with complete state/event parity`, () => {
          const map = traceBeatmap("100,192,1000,2,0,L|300:192,1,200");
          const frames = [
            traceFrame(900, 100),
            traceFrame(1000, 100, [0]),
            traceFrame(1400, 180, [0]),
            traceFrame(1500, aimed ? 200 : 500, held ? [0] : []),
            traceFrame(2100, 500),
          ];
          const { collector } = observer(2100);
          const create = (trace = false) =>
            profile === "stable"
              ? new BucketedGameStateTimeMachine(
                  frames,
                  map,
                  { noteLockStyle: "STABLE", hitWindowStyle: "OSU_STABLE" },
                  undefined,
                  trace ? collector : undefined,
                )
              : new LazerGameStateTimeMachine(frames, map, undefined, {}, trace ? collector : undefined);
          const off = create().gameStateAt(2100),
            on = create(true).gameStateAt(2100);
          expect(normalizeTraceState(on)).toEqual(normalizeTraceState(off));
          expect(normalizeTraceState(retrieveEvents(on, map.hitObjects, profile))).toEqual(
            normalizeTraceState(retrieveEvents(off, map.hitObjects, profile)),
          );
          const trace = collector.seal();
          const record = trace.records.find((r) => r.kind === "slider-checkpoint" && r.objectTimeMs === 1500);
          if (record?.kind !== "slider-checkpoint") throw new Error("missing real checkpoint");
          expect(record.hit).toBe(aimed && held);
          const histories = trace.records.filter(
            (r): r is Extract<ReplayTraceRecord, { kind: "slider-tracking" }> => r.kind === "slider-tracking",
          );
          const result = classifySliderLoss(record, histories, map.getSlider("0"), profile);
          if (record.hit) expect(result.status).toBe("unavailable");
          else {
            expect(result.status).toBe("supported");
            expect(result.codes.some((c) => ["off-track", "ran-ahead", "fell-behind"].includes(c))).toBe(!aimed);
            expect(result.codes.some((c) => ["no-hold", "released-early"].includes(c))).toBe(!held);
          }
          expect(trace.failures).toEqual([]);
        });
      }
});
