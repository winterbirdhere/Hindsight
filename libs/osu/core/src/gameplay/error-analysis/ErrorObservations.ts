import { Position } from "@osujs/math";

/** Version two adds rule-owned component evidence; version one exports stay readable. */
export interface SliderTrackingSnapshot {
  timeMs: number;
  position: Position;
  ball: Position;
  radius: number;
  geometryAccepted: boolean;
  holdAccepted: boolean;
  started: boolean;
  actions: number[];
  beforeTracking: boolean;
  tracking: boolean;
  trackingSince?: number;
  latch?: number;
  headAction?: number;
  anyKeyAfter?: number;
  /** Catch-up uses a batch of historical component positions, not normal tracking. */
  positionOverride?: boolean;
  /** Sample provenance; interpolated positions remain model reconstruction. */
  sampleBasis?: "recorded-update" | "reconstructed-update";
}
export interface SpinnerSummary {
  samples: number;
  heldSamples: number;
  firstHeldMs?: number;
  lastHeldMs?: number;
  firstCreditMs?: number;
  lastCreditMs?: number;
  creditedProgress: number;
  requiredProgress: number;
  greatThreshold: number;
  greatStrict: boolean;
  signedTravel: number;
  absoluteTravel: number;
  uncreditedTravel: number;
  reversals: number;
  clampedSamples: number;
  automated: boolean;
  rules: "stable-legacy" | "stable-current" | "native";
  firstMotionMs?: number;
  lastMotionMs?: number;
  /** Observed leading/trailing stationary spans, not quantized turn timestamps. */
  leadingIdleMs?: number;
  trailingIdleMs?: number;
  heldDurationMs?: number;
  observedDurationMs?: number;
  /** Recorded release span followed by another recorded hold, excluding edge gaps. */
  interruptedHoldMs?: number;
  sourceCoverageComplete?: boolean;
  /** Native anti-reversal suppression in credited degrees; never Stable rounding. */
  reversalLostProgress?: number;
  /** Stable body velocity actually slowed against an opposite input target. */
  reversalBrakingSamples?: number;
}
export type ErrorObservation =
  | { kind: "slider-tracking"; componentId: string; tracking: SliderTrackingSnapshot }
  | {
      kind: "slider-checkpoint";
      componentId: string;
      parentId: string;
      component: "slider-tick" | "slider-repeat" | "slider-legacy-tail" | "slider-end";
      deadlineMs: number;
      objectTimeMs: number;
      hit: boolean;
      tracking?: SliderTrackingSnapshot;
      motion?: readonly SliderTrackingSnapshot[];
      lateAcquisition: boolean;
      catchUp?: { headTimeMs: number; batchInRange: boolean; componentInRange: boolean; radius: number };
    }
  | {
      kind: "slider-parent";
      componentId: string;
      result: string;
      scoring: boolean;
      totalParts: number;
      hitParts: number;
      headId: string;
      headResult?: string;
      checkpointIds: string[];
      pendingIds: string[];
      headCap: boolean;
      objectTimeMs: number;
    }
  | {
      kind: "spinner-resolution";
      componentId: string;
      result: string;
      startTimeMs: number;
      objectTimeMs: number;
      summary: SpinnerSummary;
    };

export function validErrorObservation(value: ErrorObservation): boolean {
  const id = (v: unknown) => typeof v === "string" && v.length > 0;
  const count = (v: number) => Number.isSafeInteger(v) && v >= 0;
  const optionalFinite = (v: number | undefined) => v === undefined || Number.isFinite(v);
  const nonnegative = (v: number) => Number.isFinite(v) && v >= 0;
  const tracking = (v: SliderTrackingSnapshot | undefined) =>
    v === undefined ||
    (!!v.position &&
      !!v.ball &&
      Number.isFinite(v.timeMs) &&
      Number.isFinite(v.radius) &&
      v.radius > 0 &&
      [v.position.x, v.position.y, v.ball.x, v.ball.y].every(Number.isFinite) &&
      [v.geometryAccepted, v.holdAccepted, v.started, v.beforeTracking, v.tracking].every(
        (x) => typeof x === "boolean",
      ) &&
      Array.isArray(v.actions) &&
      v.actions.every((x) => x === 0 || x === 1) &&
      [v.trackingSince, v.latch, v.headAction, v.anyKeyAfter].every(optionalFinite) &&
      (v.sampleBasis === undefined || ["recorded-update", "reconstructed-update"].includes(v.sampleBasis)));
  if (!id(value.componentId)) return false;
  switch (value.kind) {
    case "slider-tracking":
      return !!value.tracking && tracking(value.tracking);
    case "slider-checkpoint":
      return (
        id(value.parentId) &&
        typeof value.hit === "boolean" &&
        ["slider-tick", "slider-repeat", "slider-legacy-tail", "slider-end"].includes(value.component) &&
        Number.isFinite(value.deadlineMs) &&
        Number.isFinite(value.objectTimeMs) &&
        tracking(value.tracking) &&
        (value.motion === undefined ||
          (Array.isArray(value.motion) &&
            value.motion.length <= 3 &&
            value.motion.every(
              (v, i) =>
                tracking(v) &&
                !!v &&
                (i === 0 || v.timeMs > value.motion![i - 1].timeMs) &&
                (!value.tracking || v.timeMs < value.tracking.timeMs),
            ))) &&
        typeof value.lateAcquisition === "boolean" &&
        (!value.catchUp ||
          (Number.isFinite(value.catchUp.headTimeMs) &&
            Number.isFinite(value.catchUp.radius) &&
            value.catchUp.radius > 0 &&
            typeof value.catchUp.batchInRange === "boolean" &&
            typeof value.catchUp.componentInRange === "boolean"))
      );
    case "slider-parent":
      return (
        ["GREAT", "OK", "MEH", "MISS"].includes(value.result) &&
        typeof value.scoring === "boolean" &&
        typeof value.headCap === "boolean" &&
        count(value.totalParts) &&
        count(value.hitParts) &&
        value.hitParts <= value.totalParts &&
        id(value.headId) &&
        Array.isArray(value.checkpointIds) &&
        value.checkpointIds.every(id) &&
        Array.isArray(value.pendingIds) &&
        value.pendingIds.every(id) &&
        Number.isFinite(value.objectTimeMs)
      );
    case "spinner-resolution":
      return (
        (value.summary?.sourceCoverageComplete === undefined ||
          typeof value.summary.sourceCoverageComplete === "boolean") &&
        (value.summary?.interruptedHoldMs === undefined || nonnegative(value.summary.interruptedHoldMs)) &&
        ["GREAT", "OK", "MEH", "MISS"].includes(value.result) &&
        Number.isFinite(value.startTimeMs) &&
        Number.isFinite(value.objectTimeMs) &&
        !!value.summary &&
        count(value.summary.samples) &&
        count(value.summary.heldSamples) &&
        value.summary.heldSamples <= value.summary.samples &&
        [
          value.summary.creditedProgress,
          value.summary.requiredProgress,
          value.summary.greatThreshold,
          value.summary.absoluteTravel,
          value.summary.uncreditedTravel,
        ].every(nonnegative) &&
        Number.isFinite(value.summary.signedTravel) &&
        count(value.summary.reversals) &&
        count(value.summary.clampedSamples) &&
        (value.summary.reversalBrakingSamples === undefined || count(value.summary.reversalBrakingSamples)) &&
        typeof value.summary.greatStrict === "boolean" &&
        [
          value.summary.firstHeldMs,
          value.summary.lastHeldMs,
          value.summary.firstCreditMs,
          value.summary.lastCreditMs,
          value.summary.firstMotionMs,
          value.summary.lastMotionMs,
        ].every(optionalFinite) &&
        [
          value.summary.leadingIdleMs,
          value.summary.trailingIdleMs,
          value.summary.heldDurationMs,
          value.summary.observedDurationMs,
          value.summary.reversalLostProgress,
        ].every((v) => v === undefined || nonnegative(v)) &&
        typeof value.summary.automated === "boolean" &&
        ["stable-legacy", "stable-current", "native"].includes(value.summary.rules)
      );
  }
}
