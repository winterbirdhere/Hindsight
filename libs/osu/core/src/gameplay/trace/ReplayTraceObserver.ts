import { ReplayFrame } from "../../replays/Replay";
import { HitCircle } from "../../hitobjects/HitCircle";
import { HitCircleVerdict } from "../GameState";
import { ReplayTraceObservation, TerminalMechanism, TraceCapture, TraceChannel } from "./ReplayTrace";
import { ErrorObservation, SliderTrackingSnapshot, SpinnerSummary } from "../error-analysis/ErrorObservations";
import { SpinnerState } from "../GameState";
import { Spinner } from "../../hitobjects/Spinner";
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type Observation = WithoutId<ReplayTraceObservation>;

/** Only recorder operations run inside this fault boundary, never gameplay. */
export class ReplayTraceObserver {
  private readonly lastTracking = new Map<string, SliderTrackingSnapshot>();
  private readonly trackingMotion = new Map<string, SliderTrackingSnapshot[]>();
  private readonly spinSummaries = new Map<string, SpinnerSummary>();
  private readonly spinDirections = new Map<string, number>();
  private readonly spinSampleTimes = new Map<string, number>();
  private readonly spinPendingRelease = new Map<string, number>();
  private currentInputTime = 0;
  private previousInputHeld = false;
  private currentInputHeld = false;
  private lastInputGap?: { start: number; end: number };
  private inputIndex = 0;
  private inputId = "";
  private attemptId: string | undefined;
  private freshActions: number[] = [];
  private stopped = false;
  private startTime: number | undefined;
  private endTime = 0;
  private unknownSource = false;
  constructor(private readonly capture: TraceCapture) {}
  get extended(): boolean {
    return this.capture.observationVersion === 2;
  }
  /** Rule-owned snapshots are sampled on updates; only transitions and scored components are retained. */
  tracking(componentId: string, snapshot: SliderTrackingSnapshot): void {
    if (!this.extended || this.stopped) return;
    try {
      const previous = this.lastTracking.get(componentId);
      let motion = this.trackingMotion.get(componentId) ?? [];
      const last = motion[motion.length - 1];
      if (
        last &&
        (snapshot.timeMs < last.timeMs ||
          (snapshot.timeMs === last.timeMs &&
            (snapshot.position.x !== last.position.x || snapshot.position.y !== last.position.y)))
      )
        motion = [];
      if (motion.length && motion[motion.length - 1].timeMs === snapshot.timeMs) motion[motion.length - 1] = snapshot;
      else motion.push(snapshot);
      if (motion.length > 4) motion.shift();
      this.trackingMotion.set(componentId, motion);
      this.lastTracking.set(componentId, snapshot);
      if (
        !previous ||
        previous.tracking !== snapshot.tracking ||
        previous.geometryAccepted !== snapshot.geometryAccepted ||
        previous.holdAccepted !== snapshot.holdAccepted ||
        previous.latch !== snapshot.latch ||
        previous.headAction !== snapshot.headAction ||
        previous.anyKeyAfter !== snapshot.anyKeyAfter
      )
        this.component({ kind: "slider-tracking", componentId, tracking: snapshot }, snapshot.timeMs);
    } catch {
      this.fail("recorder-failure");
    }
  }
  component(observation: ErrorObservation, timeMs: number): void {
    if (!this.extended || this.stopped) return;
    try {
      const complete =
        observation.kind === "slider-checkpoint"
          ? {
              ...observation,
              tracking: this.lastTracking.get(observation.parentId),
              motion: (this.trackingMotion.get(observation.parentId) ?? []).filter((s) => s.timeMs < timeMs).slice(-3),
            }
          : observation;
      this.emit({ ...complete, phase: observation.kind === "slider-tracking" ? "lifecycle" : "resolution", timeMs });
      if (observation.kind === "slider-parent") {
        this.lastTracking.delete(observation.componentId);
        this.trackingMotion.delete(observation.componentId);
      }
    } catch {
      this.fail("recorder-failure");
    }
  }
  spinnerStep(
    spinner: Spinner,
    time: number,
    held: boolean,
    before: SpinnerState,
    after: SpinnerState,
    profile: "stable" | "lazer",
    automated: boolean,
  ): void {
    if (!this.extended || this.stopped) return;
    try {
      const stable = profile === "stable";
      const required = stable ? after.stableRequiredHalfTurns ?? 0 : spinner.spinsRequired * 360;
      const progress = stable ? after.stableScoredHalfTurns ?? 0 : after.totalSpunAngle;
      const previousProgress = stable ? before.stableScoredHalfTurns ?? 0 : before.totalSpunAngle;
      const previousTime = this.spinSampleTimes.get(spinner.id);
      const at = Math.max(spinner.startTime, Math.min(spinner.endTime, time));
      const intervalStart = previousTime ?? Math.max(spinner.startTime, this.startTime ?? at);
      const elapsed = Math.max(0, at - intervalStart);
      const switchAt = Math.max(intervalStart, Math.min(at, this.currentInputTime));
      const recordedHold =
        (this.previousInputHeld ? switchAt - intervalStart : 0) + (this.currentInputHeld ? at - switchAt : 0);
      this.spinSampleTimes.set(spinner.id, at);
      const summary =
        this.spinSummaries.get(spinner.id) ??
        ({
          samples: 0,
          heldSamples: 0,
          creditedProgress: 0,
          requiredProgress: required,
          greatThreshold: stable ? required + (after.stableUsesLegacyRules ? 1 : 0) : required,
          greatStrict: stable && required !== 0,
          signedTravel: 0,
          absoluteTravel: 0,
          uncreditedTravel: 0,
          reversals: 0,
          clampedSamples: 0,
          automated,
          leadingIdleMs: 0,
          trailingIdleMs: 0,
          heldDurationMs: 0,
          observedDurationMs: 0,
          interruptedHoldMs: 0,
          sourceCoverageComplete: (this.startTime ?? Infinity) <= spinner.startTime,
          reversalLostProgress: 0,
          reversalBrakingSamples: 0,
          rules: stable ? (after.stableUsesLegacyRules ? "stable-legacy" : "stable-current") : "native",
        } as SpinnerSummary);
      summary.requiredProgress = required;
      if (this.lastInputGap && this.lastInputGap.end >= spinner.startTime && this.lastInputGap.start <= spinner.endTime)
        summary.sourceCoverageComplete = false;
      summary.greatThreshold = stable ? required + (after.stableUsesLegacyRules ? 1 : 0) : required;
      summary.greatStrict = stable && (required !== 0 || !!after.stableUsesLegacyRules);
      summary.creditedProgress = progress;
      if (time >= spinner.startTime && (time <= spinner.endTime || elapsed > 0)) {
        summary.samples++;
        const engagedBefore = summary.firstHeldMs !== undefined;
        if (held) {
          summary.heldSamples++;
          summary.firstHeldMs ??= time;
          summary.lastHeldMs = time;
        }
        const signed = (after.totalAccumulatedRotation ?? 0) - (before.totalAccumulatedRotation ?? 0);
        const credited = Math.max(0, progress - previousProgress) * (stable ? 180 : 1);
        summary.observedDurationMs = (summary.observedDurationMs ?? 0) + elapsed;
        summary.heldDurationMs = (summary.heldDurationMs ?? 0) + recordedHold;
        if (recordedHold > 0) {
          const first = this.previousInputHeld ? intervalStart : switchAt;
          summary.firstHeldMs = Math.min(summary.firstHeldMs ?? first, first);
          summary.lastHeldMs = this.currentInputHeld ? at : switchAt;
        }
        let pending = this.spinPendingRelease.get(spinner.id) ?? 0;
        if (engagedBefore) pending += Math.max(0, elapsed - recordedHold);
        if (held && pending > 0) {
          summary.interruptedHoldMs = (summary.interruptedHoldMs ?? 0) + pending;
          pending = 0;
        }
        this.spinPendingRelease.set(spinner.id, pending);
        if (Math.abs(signed) > 0) {
          summary.firstMotionMs ??= at;
          summary.lastMotionMs = at;
          summary.trailingIdleMs = 0;
        } else if (elapsed > 0) {
          if (summary.firstMotionMs === undefined) summary.leadingIdleMs = (summary.leadingIdleMs ?? 0) + elapsed;
          else summary.trailingIdleMs = (summary.trailingIdleMs ?? 0) + elapsed;
        }
        // Native's high-water rotation tracker withholds actual angular travel
        // while a turn is unwound. Stable's integer half-turn scoring lag must
        // never be reported as this different mechanism.
        if (!stable)
          summary.reversalLostProgress = (summary.reversalLostProgress ?? 0) + Math.max(0, Math.abs(signed) - credited);
        else if (
          (before.stableAngularVelocity ?? 0) * (after.stableTargetVelocity ?? 0) < 0 &&
          Math.abs(after.stableAngularVelocity ?? 0) < Math.abs(before.stableAngularVelocity ?? 0)
        )
          summary.reversalBrakingSamples = (summary.reversalBrakingSamples ?? 0) + 1;
        summary.signedTravel += signed;
        summary.absoluteTravel += Math.abs(signed);
        summary.uncreditedTravel += Math.max(0, Math.abs(signed) - credited);
        const direction = Math.sign(signed),
          previousDirection = this.spinDirections.get(spinner.id);
        if (direction && previousDirection && direction !== previousDirection) summary.reversals++;
        if (direction) this.spinDirections.set(spinner.id, direction);
        if (Math.abs(after.stableAngularVelocity ?? 0) >= 0.05) summary.clampedSamples++;
      }
      if (progress > previousProgress) {
        summary.firstCreditMs ??= time;
        summary.lastCreditMs = time;
      }
      this.spinSummaries.set(spinner.id, summary);
    } catch {
      this.fail("recorder-failure");
    }
  }
  spinnerResolution(
    spinner: Spinner,
    result: string,
    timeMs: number,
    state: SpinnerState,
    profile: "stable" | "lazer",
    automated: boolean,
  ): void {
    if (!this.extended || this.stopped) return;
    this.spinnerStep(spinner, timeMs, false, state, state, profile, automated);
    const summary = this.spinSummaries.get(spinner.id);
    if (summary)
      this.component(
        {
          kind: "spinner-resolution",
          componentId: spinner.id,
          result,
          startTimeMs: spinner.startTime,
          objectTimeMs: spinner.endTime,
          summary,
        },
        timeMs,
      );
    this.spinSummaries.delete(spinner.id);
    this.spinDirections.delete(spinner.id);
    this.spinSampleTimes.delete(spinner.id);
    this.spinPendingRelease.delete(spinner.id);
  }
  fail(reason: string): void {
    this.stopped = true;
    try {
      this.capture.fail(reason);
    } catch {
      /* A faulty external recorder cannot break playback. */
    }
  }
  reserveId(): string | undefined {
    if (this.stopped) return undefined;
    try {
      return this.capture.reserveId() || undefined;
    } catch {
      this.fail("recorder-failure");
      return undefined;
    }
  }
  private emit(observation: Observation, reservedId?: string): string | undefined {
    if (this.stopped) return undefined;
    try {
      const id = reservedId ?? this.capture.reserveId();
      if (!id) {
        this.stopped = true;
        return undefined;
      }
      this.capture.record({ ...observation, id } as ReplayTraceObservation);
      return id;
    } catch {
      this.fail("recorder-failure");
      return undefined;
    }
  }
  input(frame: ReplayFrame, previousActions: number[], freshActions: number[], groupMemberIndex = 0): void {
    if (this.stopped) return;
    try {
      const precedingInputTime = this.currentInputTime;
      this.currentInputTime = frame.time;
      this.previousInputHeld = previousActions.length > 0;
      this.currentInputHeld = frame.actions.length > 0;
      const source = this.capture.domain.frameSources?.[this.inputIndex] ?? {
        origin: "provided-frame" as const,
        preparedFrameIndex: this.inputIndex,
      };
      if (this.extended && (source.origin !== "parsed" || source.discontinuityBefore?.length))
        this.lastInputGap = {
          start: Math.min(precedingInputTime, frame.time),
          end: Math.max(precedingInputTime, frame.time),
        };
      if (this.extended && source.origin === "parsed" && source.discontinuityBefore?.length)
        this.trackingMotion.clear();
      this.unknownSource ||= source.origin !== "parsed";
      this.startTime ??= frame.time;
      this.endTime = frame.time;
      this.inputIndex++;
      this.freshActions = [...freshActions];
      this.inputId =
        this.emit({
          kind: "input",
          phase: "input",
          timeMs: frame.time,
          position: { ...frame.position },
          previousActions: [...previousActions],
          actions: [...frame.actions],
          freshActions: [...freshActions],
          rawButtonMask: frame.rawButtonMask,
          source: { ...source },
          groupMemberIndex,
        }) ?? "";
    } catch {
      this.fail("recorder-failure");
    }
  }
  attempt(timeMs: number, attemptOrdinal: number, knownAction?: number, automated = false): void {
    this.attemptId = this.emit({
      kind: "attempt",
      phase: "attempt",
      timeMs,
      inputId: this.inputId,
      attemptOrdinal,
      actionCandidates: automated ? [] : [...this.freshActions],
      knownAction: automated
        ? undefined
        : knownAction ?? (this.freshActions.length === 1 ? this.freshActions[0] : undefined),
      ...(automated && this.extended ? { automated: true } : {}),
    });
  }
  endAttempt(): void {
    this.attemptId = undefined;
  }
  activated(circle: HitCircle, timeMs: number): void {
    this.emit({
      kind: "lifecycle",
      phase: "lifecycle",
      timeMs,
      componentId: circle.id,
      component: circle.sliderId === undefined ? "circle" : "slider-head",
      transition: "activated",
    });
  }
  selection(timeMs: number, circle?: HitCircle, selectionStopped = true): void {
    if (!this.attemptId) return;
    this.emit({
      kind: "selection",
      phase: "dispatch",
      timeMs,
      attemptId: this.attemptId,
      componentId: circle?.id ?? null,
      component: circle ? (circle.sliderId === undefined ? "circle" : "slider-head") : undefined,
      inside: circle ? true : null,
      eligible: !!circle,
      selectionStopped: !!circle && selectionStopped,
    });
  }
  policy(
    timeMs: number,
    circle: HitCircle,
    rejected: boolean,
    branch: string,
    timingResult: string | undefined,
    blockerId?: string,
  ): void {
    if (!this.attemptId) return;
    this.emit({
      kind: "policy",
      phase: "dispatch",
      timeMs,
      attemptId: this.attemptId,
      componentId: circle.id,
      state: rejected ? "rejected" : "allowed",
      branch,
      blockerId,
      timingResult: timingResult ?? null,
      offsetMs: timeMs - circle.hitTime,
    });
  }
  resolution(
    circle: HitCircle,
    verdict: HitCircleVerdict,
    mechanism: TerminalMechanism,
    previousUnresolved: boolean,
    reservedId?: string,
    triggerResolutionId?: string,
  ): void {
    this.emit(
      {
        kind: "resolution",
        phase: "resolution",
        timeMs: verdict.judgementTime,
        componentId: circle.id,
        component: circle.sliderId === undefined ? "circle" : "slider-head",
        result: verdict.type,
        mechanism,
        previousUnresolved,
        triggerAttemptId: mechanism === "input-miss" || mechanism === "successful-input" ? this.attemptId : undefined,
        triggerResolutionId,
      },
      reservedId,
    );
  }
  finish(): void {
    if (this.stopped) return;
    try {
      if (this.capture.domain.frameSources && this.capture.domain.frameSources.length !== this.inputIndex) {
        this.fail("source-mapping-length");
        return;
      }
      for (const channel of ["input", "geometry", "routing", "lifecycle"] as TraceChannel[]) {
        const partial =
          channel === "geometry" ||
          (channel === "input" &&
            (this.unknownSource ||
              this.capture.domain.sourceCoverageLimits.length > 0 ||
              this.capture.domain.endpointBasis !== "recorded-end" ||
              this.capture.domain.synthesizedEndpoint));
        this.emit({
          kind: "coverage",
          phase: "coverage",
          timeMs: this.endTime,
          channel,
          status: partial ? "partial" : "complete",
          reason:
            channel === "geometry"
              ? "selected-receptors-only"
              : channel === "input"
              ? "provided-source-stream-only"
              : this.extended
              ? "rule-owned circle, slider and spinner observations; no independent-client verification"
              : "ordinary-circle-model-only; slider-head context; no slider-body/spinner explanations or independent-client verification",
          startTimeMs: this.startTime ?? this.endTime,
          endTimeMs: this.endTime,
        });
      }
    } catch {
      this.fail("recorder-failure");
    }
  }
}

/** Consumed once by a fresh time machine, before caching or interpolation. */
export function beginCanonicalTrace(
  capture: TraceCapture | undefined,
  time: number,
  lastFrameTime: number,
  supported: boolean,
): ReplayTraceObserver | undefined {
  if (!capture) return undefined;
  const observer = new ReplayTraceObserver(capture);
  try {
    if (!supported) {
      observer.fail("unsupported-profile");
      return undefined;
    }
    if (time < lastFrameTime || Number.isNaN(time)) {
      observer.fail("not-canonical-traversal");
      return undefined;
    }
    if (capture.domain.endTimeMs !== lastFrameTime) {
      observer.fail("scoring-domain-mismatch");
      return undefined;
    }
    return observer;
  } catch {
    observer.fail("recorder-failure");
    return undefined;
  }
}
