import { Slider } from "../../hitobjects/Slider";
import { ReplayTraceRecord } from "../trace/ReplayTrace";
import { SliderTrackingSnapshot } from "./ErrorObservations";
import { StableSliderBallPath } from "../StableSliderBallPath";
import type { ParentCauseEvidence } from "./ParentCause";
import type { RecordedInputChain } from "./RecordedInputChain";

export interface ComponentMechanism {
  codes: string[];
  headline: string;
  description: string;
  metric?: { value: number; unit: string };
  /** Optional player phrase; presentation mode does not change the diagnosis. */
  briefDetail?: { phrase: string; metric?: { value: number; unit: string } };
  eventIds: string[];
  limitations: string[];
  status: "supported" | "unavailable";
  parentEvidence?: ParentCauseEvidence;
  chain?: RecordedInputChain;
}
type Checkpoint = Extract<ReplayTraceRecord, { kind: "slider-checkpoint" }>;
type Tracking = Extract<ReplayTraceRecord, { kind: "slider-tracking" }>;
type SpinnerResolution = Extract<ReplayTraceRecord, { kind: "spinner-resolution" }>;
const stablePaths = new WeakMap<Slider, StableSliderBallPath>();
type Point = { x: number; y: number };
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const length = (a: Point) => Math.hypot(a.x, a.y);
const labels: Record<string, string> = {
  "off-track": "Off track",
  "no-hold": "No hold",
  "wrong-hold": "Wrong hold",
  "released-early": "Released early",
  "late-pickup": "Late pickup",
  "started-late": "Started late",
  "turned-early": "Turned early",
  "ran-ahead": "Ran ahead",
  "fell-behind": "Fell behind",
  "no-spin": "No spin",
  "slow-spin": "Slow spin",
  "stopped-early": "Stopped early",
  "reversed-spin": "Reversed spin",
  "hold-interrupted": "Hold interrupted",
};
function unavailable(id: string, reason: string): ComponentMechanism {
  return { codes: [], headline: "", description: "", eventIds: [id], limitations: [reason], status: "unavailable" };
}
function headline(codes: string[]): string {
  if (codes.length <= 2) return codes.map((code) => labels[code]).join(" · ");
  // Three independently observed failures still remain named in the short title.
  const short: Record<string, string> = {
    "started-late": "Late",
    "stopped-early": "stopped",
    "reversed-spin": "reversed",
    "off-track": "off-track",
    "no-hold": "unheld",
    "wrong-hold": "wrong-hold",
    "released-early": "released",
    "late-pickup": "late-pickup",
    "hold-interrupted": "released",
  };
  return codes.map((code) => short[code] ?? labels[code]).join(", ");
}
function ballAt(slider: Slider, time: number, profile: "stable" | "lazer"): Point {
  if (profile === "lazer")
    return slider.ballPositionAt(Math.max(0, Math.min(1, (time - slider.startTime) / slider.duration)));
  let path = stablePaths.get(slider);
  if (!path) {
    path = new StableSliderBallPath(slider);
    stablePaths.set(slider, path);
  }
  return path.positionAt(time);
}
/** Use the time-selected phase, never a nearest-point projection on a crossing. */
function directionAt(slider: Slider, time: number, profile: "stable" | "lazer"): Point | undefined {
  const delta = Math.min(2, slider.spanDuration / 10);
  if (!(delta > 0) || time - delta <= slider.startTime || time + delta >= slider.endTime) return;
  const a = ballAt(slider, time - delta, profile),
    b = ballAt(slider, time, profile),
    c = ballAt(slider, time + delta, profile);
  const incoming = sub(b, a),
    outgoing = sub(c, b);
  const before = length(incoming),
    after = length(outgoing);
  if (!(before > 1e-5 && after > 1e-5) || dot(incoming, outgoing) / (before * after) < 0.98) return;
  return { x: incoming.x / before, y: incoming.y / before };
}
function turnedEarly(record: Checkpoint, slider: Slider, profile: "stable" | "lazer"): boolean {
  if (record.component !== "slider-repeat" || !record.tracking || record.tracking.geometryAccepted) return false;
  const points = record.motion?.filter((p) => p.timeMs < record.deadlineMs && p.timeMs >= slider.startTime);
  if (!points || points.length < 3) return false;
  const [a, b, c] = points.slice(-3);
  if (!(a.timeMs < b.timeMs && b.timeMs < c.timeMs) || !a.holdAccepted || !b.holdAccepted || !c.holdAccepted)
    return false;
  const direction = directionAt(slider, b.timeMs, profile);
  if (!direction) return false;
  const first = sub(b.position, a.position),
    second = sub(c.position, b.position);
  const noise = record.tracking.radius * 0.2;
  if (!(dot(first, direction) > noise && dot(second, direction) < -noise)) return false;
  const lateral = (v: Point) => Math.abs(v.x * direction.y - v.y * direction.x);
  if (lateral(first) > record.tracking.radius || lateral(second) > record.tracking.radius) return false;
  // The turn must remain unrecovered and directed away from the repeat up to its loss.
  return !c.geometryAccepted && dot(sub(record.tracking.position, c.position), direction) <= 0;
}
export function classifySliderLoss(
  record: Checkpoint,
  history: readonly Tracking[],
  slider: Slider,
  profile: "stable" | "lazer" = "stable",
  capability: { aim: "manual" | "automated"; tapping: "manual" | "automated" } = { aim: "manual", tapping: "manual" },
): ComponentMechanism {
  if (record.hit) return unavailable(record.id, "component-was-hit");
  if (record.parentId !== slider.id) return unavailable(record.id, "wrong-parent-geometry");
  const tracking = record.tracking;
  if (!tracking) return unavailable(record.id, "missing-rule-owned-tracking");
  if (tracking.timeMs > record.timeMs || !tracking.started) return unavailable(record.id, "invalid-tracking-lifecycle");
  const validHistory = history.filter(
    (item) =>
      item.componentId === record.parentId &&
      item.sequence < record.sequence &&
      item.timeMs <= record.timeMs &&
      item.timeMs >= slider.startTime,
  );
  const codes: string[] = [],
    witnesses = [record.id];
  const catchUpFailed = record.catchUp && record.catchUp.headTimeMs > record.deadlineMs && !record.catchUp.batchInRange;
  if (catchUpFailed) codes.push("started-late");
  const geometryFailed = record.catchUp ? !record.catchUp.componentInRange : !tracking.geometryAccepted;
  if (geometryFailed && capability.aim === "automated") return unavailable(record.id, "automated-aim-loss-conflict");
  if (!tracking.holdAccepted && capability.tapping === "automated")
    return unavailable(record.id, "automated-hold-loss-conflict");
  if (geometryFailed) {
    let code = "off-track";
    if (!record.catchUp && turnedEarly(record, slider, profile)) code = "turned-early";
    else if (!record.catchUp && !tracking.positionOverride) {
      const direction = directionAt(slider, tracking.timeMs, profile);
      if (direction) {
        const separation = sub(tracking.position, tracking.ball),
          along = dot(separation, direction);
        const transverse = Math.abs(separation.x * direction.y - separation.y * direction.x);
        if (transverse <= tracking.radius && Math.abs(along) > tracking.radius)
          code = along > 0 ? "ran-ahead" : "fell-behind";
      }
    }
    codes.push(code);
  }
  if (!tracking.holdAccepted) {
    let code = tracking.actions.length ? "wrong-hold" : "no-hold";
    if (code === "no-hold" && !geometryFailed) {
      // Only the final accepted-to-released transition survives a later recovery.
      let accepted: Tracking | undefined, released: Tracking | undefined;
      // Native/Classic can acquire from an existing hold before the start.
      // The observer need not repeat that unchanged state at the head. Retain
      // it only through an explicit, in-time poststart tracked-to-released
      // transition, never an old prestart release or post-deadline movement.
      const first = validHistory[0];
      if (first?.tracking.started && first.tracking.beforeTracking && first.tracking.geometryAccepted &&
        !first.tracking.holdAccepted && !first.tracking.actions.length && first.timeMs <= record.deadlineMs) {
        const prior = history.filter(item => item.componentId === record.parentId &&
          item.sequence < first.sequence && item.timeMs < slider.startTime).pop();
        if (prior?.tracking.tracking && prior.tracking.geometryAccepted && prior.tracking.holdAccepted) accepted = prior;
      }
      for (const item of validHistory) {
        if (item.tracking.holdAccepted) {
          accepted = item;
          released = undefined;
        } else if (accepted && item.tracking.actions.length === 0 && item.tracking.geometryAccepted) released ??= item;
      }
      if (accepted && (released || tracking.beforeTracking)) {
        code = "released-early";
        witnesses.push(accepted.id);
        if (released) witnesses.push(released.id);
      }
    }
    codes.push(code);
  }
  if (record.lateAcquisition) codes.push("late-pickup");
  if (!codes.length) return unavailable(record.id, "failed-component-with-no-failed-gate");
  const context =
    record.component === "slider-end" || record.component === "slider-legacy-tail"
      ? "The slider end"
      : record.component === "slider-repeat"
      ? "The repeat"
      : "This slider part";
  const concise: Record<string, string> = {
    "started-late": "the head hit too late",
    "off-track": "the cursor outside the ball",
    "ran-ahead": "the cursor ahead of the ball",
    "fell-behind": "the cursor behind the ball",
    "turned-early": "the cursor turning back early",
    "no-hold": "no button held",
    "wrong-hold": "the wrong button held",
    "released-early": "the button released too soon",
    "late-pickup": "tracking picked up too late",
  };
  return {
    codes,
    headline: headline(codes),
    description: `${context} passed with ${codes.map((code) => concise[code]).join(" and ")}.`,
    eventIds: [...new Set(witnesses)],
    limitations: [],
    status: "supported",
  };
}
export function classifySpinnerLoss(
  record: SpinnerResolution,
  capability: { spinner: "manual" | "automated"; tapping?: "manual" | "automated" },
): ComponentMechanism {
  const s = record.summary;
  if (record.result === "GREAT") return unavailable(record.id, "spinner-was-completed");
  if (s.sourceCoverageComplete === false) return unavailable(record.id, "incomplete-spinner-input");
  if (s.automated || capability.spinner === "automated") return unavailable(record.id, "automated-spinner-facet");
  if (!s.samples || !Number.isFinite(s.greatThreshold) || !Number.isFinite(s.creditedProgress))
    return unavailable(record.id, "invalid-spinner-evidence");
  if (s.greatStrict ? s.creditedProgress > s.greatThreshold : s.creditedProgress >= s.greatThreshold)
    return unavailable(record.id, "spinner-result-conflicts-with-progress");
  const codes: string[] = [],
    parts: string[] = [];
  if (s.heldSamples === 0 && capability.tapping !== "automated") {
    codes.push("no-hold");
    parts.push("no button was held while spinning");
  } else if (s.absoluteTravel === 0 && s.creditedProgress === 0) {
    codes.push("no-spin");
    parts.push("the cursor did not spin around the centre");
  } else {
    const substantialIdle = Math.min(50, (record.objectTimeMs - record.startTimeMs) * 0.1);
    if (capability.tapping !== "automated" && (s.interruptedHoldMs ?? 0) > 0) {
      codes.push("hold-interrupted");
      parts.push("the button was released during the spin");
    }
    if ((s.leadingIdleMs ?? 0) > substantialIdle) {
      codes.push("started-late");
      parts.push("spinning started late");
    }
    if ((s.trailingIdleMs ?? 0) > substantialIdle) {
      codes.push("stopped-early");
      parts.push("spinning stopped before the end");
    }
    if (
      (s.rules === "native" && s.reversals > 0 && (s.reversalLostProgress ?? 0) > 0) ||
      (s.rules !== "native" && (s.reversalBrakingSamples ?? 0) > 0)
    ) {
      codes.push("reversed-spin");
      parts.push(
        s.rules === "native" ? "reversing direction held back the spin" : "reversing direction slowed the spin",
      );
    }
    if (!codes.length) {
      codes.push("slow-spin");
      parts.push("spinning did not build up enough speed");
    }
  }
  return {
    codes,
    headline: headline(codes),
    description: `The spinner fell short because ${parts.join(" and ")}.`,
    eventIds: [record.id],
    limitations: [],
    status: "supported",
  };
}
