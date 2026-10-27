import { hitWindowsForOD, Position, Vec2 } from "@osujs/math";
import { Beatmap } from "../beatmap/Beatmap";
import { HitCircle } from "../hitobjects/HitCircle";
import { Slider } from "../hitobjects/Slider";
import { SliderCheckPoint } from "../hitobjects/SliderCheckPoint";
import { isHitCircle, isSlider, isSpinner } from "../hitobjects/Types";
import { RELAX_LENIENCY } from "../mods/Mods";
import { OsuAction, ReplayFrame } from "../replays/Replay";
import { GameState, HitCircleVerdict, LazerJudgement, NOT_PRESSING, SliderBodyState } from "./GameState";
import { newPressingSince } from "./GameStateEvaluator";
import {
  initialSpinnerState,
  spinnerProgress,
  spinnerVerdictForProgress,
  updateSpinnerRotation,
} from "./SpinnerTracking";
import { MainHitObjectVerdict } from "./Verdicts";
import { legacyRelaxActionsAt } from "./LazerRelaxInput";
import { spunOutSpinnerState } from "./SpunOutSpinner";
import { ReplayTraceObserver } from "./trace/ReplayTraceObserver";
import { nativeWithinHitRadius } from "./StableHitGeometry";
import { TerminalMechanism } from "./trace/ReplayTrace";

export interface LazerReplayInputOptions {
  /** Only legacy RX replays omit the mod's generated button presses. */
  legacyReplay?: boolean;
}

const TAIL_LENIENCY = -36;

type EventType =
  | "SLIDER_ACTIVATE"
  | "HIT_CIRCLE_SPAWN"
  | "SPINNER_ACTIVATE"
  | "HIT_CIRCLE_TIMEOUT"
  | "SLIDER_CHECK_POINT"
  | "SLIDER_TAIL"
  | "SLIDER_END"
  | "SPINNER_END";

type LazerEvent = {
  time: number;
  hitObjectId: string;
  type: EventType;
  sequence: number;
};

const eventPriority: Record<EventType, number> = {
  SLIDER_ACTIVATE: 0,
  HIT_CIRCLE_SPAWN: 1,
  SPINNER_ACTIVATE: 2,
  SLIDER_CHECK_POINT: 10,
  SLIDER_TAIL: 11,
  SLIDER_END: 12,
  HIT_CIRCLE_TIMEOUT: 13,
  SPINNER_END: 14,
};

const isActivationEvent = (event: LazerEvent) => eventPriority[event.type] < 10;

function generateEvents(beatmap: Beatmap, mehWindow: number, reconstructRelax = false): LazerEvent[] {
  const events: LazerEvent[] = [];
  let sequence = 0;
  const push = (event: Omit<LazerEvent, "sequence">) => events.push({ ...event, sequence: sequence++ });
  const pushCircle = (circle: HitCircle) => {
    push({ time: circle.spawnTime, hitObjectId: circle.id, type: "HIT_CIRCLE_SPAWN" });
    const boundary = circle.hitTime + mehWindow;
    // Passive timeout is a strict open boundary. Advance by one representable
    // floating-point step so exact-boundary input remains valid while fractional
    // replay timestamps immediately beyond it cannot hit an expired receptor.
    const strictlyAfterBoundary =
      boundary + Math.max(Number.MIN_VALUE, Number.EPSILON * Math.max(1, Math.abs(boundary)));
    push({
      time: strictlyAfterBoundary,
      hitObjectId: circle.id,
      type: "HIT_CIRCLE_TIMEOUT",
    });
  };

  for (const hitObject of beatmap.hitObjects) {
    if (isHitCircle(hitObject)) {
      pushCircle(hitObject);
      continue;
    }

    if (isSlider(hitObject)) {
      push({ time: hitObject.spawnTime, hitObjectId: hitObject.id, type: "SLIDER_ACTIVATE" });
      pushCircle(hitObject.head);

      const scoringCheckpoints = hitObject.checkPoints.filter((point) => point.type !== "LAST_LEGACY_TICK");
      for (const point of scoringCheckpoints) {
        push({ time: point.hitTime, hitObjectId: point.id, type: "SLIDER_CHECK_POINT" });
      }

      const lastCheckpointTime = scoringCheckpoints[scoringCheckpoints.length - 1]?.hitTime ?? -Infinity;
      push({
        time: Math.max(hitObject.endTime + TAIL_LENIENCY, lastCheckpointTime),
        hitObjectId: hitObject.id,
        type: "SLIDER_TAIL",
      });
      push({ time: hitObject.endTime, hitObjectId: hitObject.id, type: "SLIDER_END" });
      continue;
    }

    if (isSpinner(hitObject)) {
      if (reconstructRelax) {
        // Relax begins holding before the spinner. Keep the actual start event
        // too: it resets the cursor baseline so prestart movement earns no spin.
        push({ time: hitObject.startTime - RELAX_LENIENCY, hitObjectId: hitObject.id, type: "SPINNER_ACTIVATE" });
      }
      push({ time: hitObject.startTime, hitObjectId: hitObject.id, type: "SPINNER_ACTIVATE" });
      push({ time: hitObject.endTime, hitObjectId: hitObject.id, type: "SPINNER_END" });
    }
  }

  events.sort(
    (left, right) =>
      left.time - right.time || eventPriority[left.type] - eventPriority[right.type] || left.sequence - right.sequence,
  );
  return events;
}

function pressedActions(state: GameState): OsuAction[] {
  const actions: OsuAction[] = [];
  if (state.pressingSince[OsuAction.leftButton] !== NOT_PRESSING) actions.push(OsuAction.leftButton);
  if (state.pressingSince[OsuAction.rightButton] !== NOT_PRESSING) actions.push(OsuAction.rightButton);
  return actions;
}

function sliderProgressAt(slider: Slider, time: number): number {
  if (slider.duration === 0) return time < slider.startTime ? 0 : 1;
  return Math.max(0, Math.min(1, (time - slider.startTime) / slider.duration));
}

function resultForOffset(hitWindows: number[], offset: number): MainHitObjectVerdict | undefined {
  const absoluteOffset = Math.abs(offset);
  if (absoluteOffset <= hitWindows[0]) return "GREAT";
  if (absoluteOffset <= hitWindows[1]) return "OK";
  if (absoluteOffset <= hitWindows[2]) return "MEH";
  if (absoluteOffset <= hitWindows[3]) return "MISS";
  return undefined;
}

function checkpointPosition(slider: Slider, checkpoint: SliderCheckPoint): Position {
  return checkpoint.position;
}

function tailPosition(slider: Slider): Position {
  return slider.endPosition;
}

export function nativeLazerSpinnerVerdict(progress: number): MainHitObjectVerdict {
  return spinnerVerdictForProgress(progress);
}

/**
 * Independent native-lazer evaluator. Stable continues to use
 * {@link GameStateEvaluator}; this class deliberately does not share Stable's
 * proportional slider parent judgement or note-lock implementation.
 */
export class LazerGameStateEvaluator {
  private trace?: ReplayTraceObserver;
  private readonly hitWindows: number[];
  private readonly events: LazerEvent[];
  private readonly circleInputOrder = new Map<string, number>();
  private readonly policyOrderedCircles: HitCircle[];
  private gameState!: GameState;
  private frame!: ReplayFrame;
  private deferTimeDrivenEventsAtCurrentTime = false;
  private readonly classicSliderBehaviour: boolean;
  private readonly classicNoteLock: boolean;
  private readonly reconstructRelax: boolean;
  private readonly spunOut: boolean;
  private traceCatchUp?: { headTimeMs: number; batchInRange: boolean; componentInRange: boolean; radius: number };

  constructor(private readonly beatmap: Beatmap, options: LazerReplayInputOptions = {}) {
    this.reconstructRelax =
      options.legacyReplay === true &&
      (beatmap.appliedMods.includes("RELAX") || beatmap.lazerMods.some((mod) => mod.acronym === "RX"));
    this.spunOut = beatmap.appliedMods.includes("SPUN_OUT") || beatmap.lazerMods.some((mod) => mod.acronym === "SO");
    this.classicSliderBehaviour = beatmap.lazerModSettings.classic?.noSliderHeadAccuracy ?? false;
    this.classicNoteLock = beatmap.lazerModSettings.classic?.classicNoteLock ?? false;
    this.hitWindows = hitWindowsForOD(beatmap.difficulty.overallDifficulty, true);
    this.events = generateEvents(beatmap, this.hitWindows[2], this.reconstructRelax);
    const blockingCircles: HitCircle[] = [];
    beatmap.hitObjects.forEach((object, index) => {
      const circle = isHitCircle(object) ? object : isSlider(object) ? object.head : undefined;
      if (!circle) return;
      this.circleInputOrder.set(circle.id, index);
      blockingCircles.push(circle);
    });
    this.policyOrderedCircles = blockingCircles.sort(
      (left, right) =>
        left.hitTime - right.hitTime ||
        (this.circleInputOrder.get(left.id) ?? 0) - (this.circleInputOrder.get(right.id) ?? 0),
    );
  }

  private appendJudgement(judgement: LazerJudgement): void {
    this.gameState.lazerJudgements.push(judgement);
  }

  private circleJudgementKind(circle: HitCircle): "CIRCLE" | "SLIDER_HEAD" {
    return circle.sliderId === undefined ? "CIRCLE" : "SLIDER_HEAD";
  }

  private judgeHitCircle(
    circle: HitCircle,
    verdict: HitCircleVerdict,
    applyOrderedPolicy = true,
    mechanism: TerminalMechanism = "other-supported-resolution",
    triggerResolutionId?: string,
  ): void {
    if (this.gameState.hitCircleVerdict[circle.id] !== undefined) return;
    const resolutionId = this.trace?.reserveId();

    this.gameState.hitCircleVerdict[circle.id] = verdict;
    const retainsNotelockEvidence = verdict.type === "MISS" && verdict.missReason === "TIME_EXPIRED";
    if (!retainsNotelockEvidence) delete this.gameState.lazerNotelockEvidence[circle.id];
    this.gameState.aliveHitCircleIds.delete(circle.id);

    // StartTimeOrderedHitPolicy resolves earlier blockers before the selected
    // receptor's result reaches score/combo processing. This ordering matters:
    // a same-frame earlier miss must reset combo before the later hit adds one.
    if (applyOrderedPolicy && !this.classicNoteLock) this.forceMissEarlierBlockingCircles(circle, resolutionId);

    this.trace?.resolution(circle, verdict, mechanism, true, resolutionId, triggerResolutionId);

    this.gameState.judgedObjects.push(circle.id);
    this.appendJudgement({
      id: `lazer:${this.circleJudgementKind(circle).toLowerCase()}:${circle.id}`,
      hitObjectId: circle.id,
      kind: this.circleJudgementKind(circle),
      result:
        circle.sliderId !== undefined && this.classicSliderBehaviour
          ? verdict.type === "MISS"
            ? "LARGE_TICK_MISS"
            : "LARGE_TICK_HIT"
          : verdict.type,
      objectTime: circle.hitTime,
      judgementTime: verdict.judgementTime,
    });

    if (circle.sliderId !== undefined && verdict.type !== "MISS") {
      this.postProcessSuccessfulSliderHead(this.beatmap.getSlider(circle.sliderId));
    }

    if (circle.sliderId !== undefined) {
      const slider = this.beatmap.getSlider(circle.sliderId);
      if (!this.deferTimeDrivenEventsAtCurrentTime) {
        this.processDueSliderComponents(slider);
        this.tryFinishSlider(slider);
      }
    }
  }

  private forceMissEarlierBlockingCircles(resolvedCircle: HitCircle, triggerResolutionId?: string): void {
    const earlier = this.policyOrderedCircles.filter(
      (circle) => circle.hitTime < resolvedCircle.hitTime && this.gameState.aliveHitCircleIds.has(circle.id),
    );

    for (const circle of earlier) {
      this.judgeHitCircle(
        circle,
        {
          type: "MISS",
          missReason: "ORDERED_POLICY_FORCE_MISS",
          judgementTime: this.gameState.currentTime,
        },
        false,
        "ordered-force-miss",
        triggerResolutionId,
      );
    }
  }

  private updateSpinner(spinnerId: string, time: number, position: Position, actions: readonly OsuAction[]): void {
    const spinner = this.beatmap.getSpinner(spinnerId);
    if (this.spunOut) {
      const automatic = spunOutSpinnerState(spinner, time);
      const previous = this.gameState.spinnerState.get(spinnerId);
      this.gameState.spinnerState.set(spinnerId, automatic);
      if (previous) this.trace?.spinnerStep(spinner, time, false, previous, automatic, "lazer", true);
      return;
    }
    const previous = this.gameState.spinnerState.get(spinnerId);
    if (!previous) return;

    const tracking =
      time >= spinner.startTime &&
      time < spinner.endTime &&
      this.gameState.spinnerVerdict[spinnerId] === undefined &&
      (actions.includes(OsuAction.leftButton) || actions.includes(OsuAction.rightButton));
    this.gameState.spinnerState.set(
      spinnerId,
      updateSpinnerRotation(previous, position, tracking, this.beatmap.gameClockRate, spinner.spinsRequired, time),
    );
    this.trace?.spinnerStep(
      spinner,
      time,
      tracking,
      previous,
      this.gameState.spinnerState.get(spinnerId)!,
      "lazer",
      false,
    );
  }

  private validTrackingAction(state: SliderBodyState, actions: readonly OsuAction[], time: number): boolean {
    const headAction = state.headHitAction;
    if (
      headAction !== undefined &&
      (state.timeToAcceptAnyKeyAfter === undefined || time <= state.timeToAcceptAnyKeyAfter)
    ) {
      return actions.includes(headAction);
    }
    return actions.includes(OsuAction.leftButton) || actions.includes(OsuAction.rightButton);
  }

  private updateSliderTracking(
    slider: Slider,
    time: number,
    position: Position,
    actions: readonly OsuAction[],
    validPositionOverride?: boolean,
  ): void {
    const previous = this.gameState.sliderBodyState.get(slider.id);
    if (!previous || this.gameState.sliderVerdict[slider.id] !== undefined) return;

    const headVerdict = this.gameState.hitCircleVerdict[slider.head.id];
    const successfulHeadAction = headVerdict?.type !== "MISS" ? headVerdict?.hitAction : undefined;
    let timeToAcceptAnyKeyAfter = previous.timeToAcceptAnyKeyAfter;

    if (successfulHeadAction === undefined) {
      timeToAcceptAnyKeyAfter = undefined;
    } else if (timeToAcceptAnyKeyAfter === undefined) {
      const otherAction = successfulHeadAction === OsuAction.leftButton ? OsuAction.rightButton : OsuAction.leftButton;
      if (!(previous.lastPressedActions ?? []).includes(otherAction)) timeToAcceptAnyKeyAfter = time;
    }

    const progress = sliderProgressAt(slider, time);
    const ballPosition = slider.ballPositionAt(progress);
    const radius = slider.radius * (previous.isTracking ? 2.4 : 1);
    const validPosition = validPositionOverride ?? Vec2.withinDistance(ballPosition, position, Math.fround(radius));
    const stateForAction: SliderBodyState = {
      ...previous,
      headHitAction: successfulHeadAction,
      timeToAcceptAnyKeyAfter,
    };
    const isTracking = validPosition && this.validTrackingAction(stateForAction, actions, time);

    this.gameState.sliderBodyState.set(slider.id, {
      isTracking,
      headHitAction: successfulHeadAction,
      timeToAcceptAnyKeyAfter,
      lastPressedActions: [...actions],
    });
    if (this.trace?.extended)
      this.trace.tracking(slider.id, {
        timeMs: time,
        sampleBasis: time === this.frame.time ? "recorded-update" : "reconstructed-update",
        position: { ...position },
        ball: { ...ballPosition },
        radius: Math.fround(radius),
        geometryAccepted: validPosition,
        holdAccepted: this.validTrackingAction(stateForAction, actions, time),
        started: time >= slider.startTime,
        actions: [...actions],
        beforeTracking: previous.isTracking,
        tracking: isTracking,
        headAction: successfulHeadAction,
        anyKeyAfter: timeToAcceptAnyKeyAfter,
        positionOverride: validPositionOverride,
      });
  }

  private advanceTo(
    time: number,
    position: Position,
    spinnerActions: readonly OsuAction[],
    sliderActions: readonly OsuAction[] | null = spinnerActions,
  ): void {
    for (const spinnerId of this.gameState.aliveSpinnerIds) {
      this.updateSpinner(spinnerId, time, position, spinnerActions);
    }

    this.gameState.currentTime = time;
    this.gameState.cursorPosition = position;

    if (sliderActions) {
      for (const sliderId of this.gameState.aliveSliderIds) {
        this.updateSliderTracking(this.beatmap.getSlider(sliderId), time, position, sliderActions);
      }
    }
  }

  private predictedCursorPositionAt(time: number): Position {
    const previousTime = this.gameState.currentTime;
    const nextTime = this.frame.time;
    if (previousTime === nextTime) return this.gameState.cursorPosition;
    const progress = (time - previousTime) / (nextTime - previousTime);
    return Vec2.interpolate(this.gameState.cursorPosition, this.frame.position, progress);
  }

  private judgeCheckpoint(checkpoint: SliderCheckPoint, hit: boolean): void {
    if (this.gameState.checkPointVerdict[checkpoint.id] !== undefined) return;
    this.gameState.checkPointVerdict[checkpoint.id] = { hit, judgementTime: this.gameState.currentTime };
    this.trace?.component(
      {
        kind: "slider-checkpoint",
        componentId: checkpoint.id,
        parentId: checkpoint.slider.id,
        component: checkpoint.type === "REPEAT" ? "slider-repeat" : "slider-tick",
        deadlineMs: checkpoint.hitTime,
        objectTimeMs: checkpoint.hitTime,
        hit,
        lateAcquisition: false,
        catchUp: this.traceCatchUp,
      },
      this.gameState.currentTime,
    );
    this.gameState.judgedObjects.push(checkpoint.id);
    this.appendJudgement({
      id: `lazer:${checkpoint.type.toLowerCase()}:${checkpoint.id}`,
      hitObjectId: checkpoint.id,
      kind: checkpoint.type === "REPEAT" ? "SLIDER_REPEAT" : "SLIDER_TICK",
      result: hit ? "LARGE_TICK_HIT" : "LARGE_TICK_MISS",
      objectTime: checkpoint.hitTime,
      judgementTime: this.gameState.currentTime,
    });
  }

  private judgeTail(slider: Slider, hit: boolean): void {
    if (this.gameState.sliderTailVerdict[slider.id] !== undefined) return;
    this.gameState.sliderTailVerdict[slider.id] = { hit, judgementTime: this.gameState.currentTime };
    this.trace?.component(
      {
        kind: "slider-checkpoint",
        componentId: `${slider.id}/TAIL`,
        parentId: slider.id,
        component: "slider-end",
        deadlineMs: slider.endTime + TAIL_LENIENCY,
        objectTimeMs: slider.endTime,
        hit,
        lateAcquisition: false,
        catchUp: this.traceCatchUp,
      },
      this.gameState.currentTime,
    );
    this.appendJudgement({
      id: `lazer:tail:${slider.id}`,
      hitObjectId: slider.id,
      kind: "SLIDER_TAIL",
      result: this.classicSliderBehaviour
        ? hit
          ? "SMALL_TICK_HIT"
          : "SMALL_TICK_MISS"
        : hit
        ? "SLIDER_TAIL_HIT"
        : "IGNORE_MISS",
      objectTime: slider.endTime,
      judgementTime: this.gameState.currentTime,
    });
  }

  private scoringCheckpoints(slider: Slider): SliderCheckPoint[] {
    return slider.checkPoints.filter((point) => point.type !== "LAST_LEGACY_TICK");
  }

  private processDueSliderComponents(slider: Slider): void {
    if (this.gameState.hitCircleVerdict[slider.head.id] === undefined) return;
    const tracking = this.gameState.sliderBodyState.get(slider.id)?.isTracking ?? false;

    for (const checkpoint of this.scoringCheckpoints(slider)) {
      if (
        checkpoint.hitTime > this.gameState.currentTime ||
        (this.deferTimeDrivenEventsAtCurrentTime && checkpoint.hitTime >= this.gameState.currentTime)
      ) {
        break;
      }
      this.judgeCheckpoint(checkpoint, tracking);
    }

    const checkpointsJudged = this.scoringCheckpoints(slider).every(
      (checkpoint) => this.gameState.checkPointVerdict[checkpoint.id] !== undefined,
    );
    if (
      !this.deferTimeDrivenEventsAtCurrentTime &&
      checkpointsJudged &&
      this.gameState.currentTime >= slider.endTime + TAIL_LENIENCY &&
      (tracking || this.gameState.currentTime >= slider.endTime)
    ) {
      this.judgeTail(slider, tracking);
    }
  }

  private postProcessSuccessfulSliderHead(slider: Slider): void {
    const expandedRadius = slider.radius * 2.4;
    const progress = sliderProgressAt(slider, this.gameState.currentTime);
    if (
      !Vec2.withinDistance(slider.ballPositionAt(progress), this.gameState.cursorPosition, Math.fround(expandedRadius))
    ) {
      return;
    }

    const passed: Array<{ time: number; position: Position; checkpoint?: SliderCheckPoint; tail?: true }> = [];
    for (const checkpoint of this.scoringCheckpoints(slider)) {
      if (
        checkpoint.hitTime <= this.gameState.currentTime &&
        this.gameState.checkPointVerdict[checkpoint.id] === undefined
      ) {
        passed.push({ time: checkpoint.hitTime, position: checkpointPosition(slider, checkpoint), checkpoint });
      }
    }
    if (slider.endTime <= this.gameState.currentTime && this.gameState.sliderTailVerdict[slider.id] === undefined) {
      passed.push({ time: slider.endTime, position: tailPosition(slider), tail: true });
    }

    const allPassedInRange = passed.every((component) =>
      Vec2.withinDistance(component.position, this.gameState.cursorPosition, Math.fround(expandedRadius)),
    );
    for (const component of passed) {
      if (this.trace?.extended)
        this.traceCatchUp = {
          headTimeMs: this.gameState.currentTime,
          batchInRange: allPassedInRange,
          componentInRange: Vec2.withinDistance(
            component.position,
            this.gameState.cursorPosition,
            Math.fround(expandedRadius),
          ),
          radius: Math.fround(expandedRadius),
        };
      if (component.checkpoint) this.judgeCheckpoint(component.checkpoint, allPassedInRange);
      else if (component.tail) this.judgeTail(slider, allPassedInRange);
    }
    this.traceCatchUp = undefined;

    const withinBaseRadius = Vec2.withinDistance(
      slider.ballPositionAt(progress),
      this.gameState.cursorPosition,
      Math.fround(slider.radius),
    );
    this.updateSliderTracking(
      slider,
      this.gameState.currentTime,
      this.gameState.cursorPosition,
      pressedActions(this.gameState),
      allPassedInRange || withinBaseRadius,
    );
  }

  private tryFinishSlider(slider: Slider): void {
    if (
      this.gameState.sliderVerdict[slider.id] !== undefined ||
      this.gameState.currentTime < slider.endTime ||
      this.gameState.sliderTailVerdict[slider.id] === undefined
    ) {
      return;
    }

    const headVerdict = this.gameState.hitCircleVerdict[slider.head.id];
    const headHit = headVerdict !== undefined && headVerdict.type !== "MISS";
    const checkpoints = this.scoringCheckpoints(slider);
    const hitCheckpoints = checkpoints.filter(
      (checkpoint) => this.gameState.checkPointVerdict[checkpoint.id]?.hit,
    ).length;
    const tailHit = this.gameState.sliderTailVerdict[slider.id].hit;
    const totalHits = Number(headHit) + hitCheckpoints + Number(tailHit);
    const totalParts = checkpoints.length + 2;
    const result: MainHitObjectVerdict = this.classicSliderBehaviour
      ? totalHits === totalParts
        ? "GREAT"
        : totalHits === 0
        ? "MISS"
        : totalHits * 2 >= totalParts
        ? "OK"
        : "MEH"
      : totalHits > 0
      ? "GREAT"
      : "MISS";
    this.gameState.sliderVerdict[slider.id] = result;
    this.trace?.component(
      {
        kind: "slider-parent",
        componentId: slider.id,
        result,
        scoring: this.classicSliderBehaviour,
        totalParts,
        hitParts: totalHits,
        headId: slider.head.id,
        headResult: headVerdict?.type,
        checkpointIds: [...checkpoints.map((c) => c.id), `${slider.id}/TAIL`],
        pendingIds: checkpoints.filter((c) => this.gameState.checkPointVerdict[c.id] === undefined).map((c) => c.id),
        headCap: false,
        objectTimeMs: slider.endTime,
      },
      this.gameState.currentTime,
    );
    if (this.classicSliderBehaviour) {
      this.appendJudgement({
        id: `lazer:slider:${slider.id}`,
        hitObjectId: slider.id,
        kind: "SLIDER",
        result,
        objectTime: slider.endTime,
        judgementTime: this.gameState.currentTime,
      });
    }
    this.gameState.judgedObjects.push(slider.id);
    this.gameState.aliveSliderIds.delete(slider.id);
    this.gameState.sliderBodyState.delete(slider.id);
  }

  private handleFreshPress(action: OsuAction): void {
    if (this.classicNoteLock) {
      this.handleClassicPress(action);
      return;
    }
    const candidates = Array.from(this.gameState.aliveHitCircleIds)
      .map((id) => this.beatmap.getHitCircle(id))
      .sort(
        (left, right) =>
          left.hitTime - right.hitTime ||
          (this.circleInputOrder.get(right.id) ?? 0) - (this.circleInputOrder.get(left.id) ?? 0),
      );
    const candidate = candidates.find((circle) =>
      nativeWithinHitRadius(circle.position, this.gameState.cursorPosition, circle.radius),
    );
    this.trace?.selection(this.gameState.currentTime, candidate);
    if (!candidate) return;

    // A hovered receptor consumes the press even when ordered processing shakes it.
    const earlierPolicyObjects = this.policyOrderedCircles.filter((circle) => circle.hitTime < candidate.hitTime);
    const latestBlocker = earlierPolicyObjects[earlierPolicyObjects.length - 1];
    // DrawableSliderHead maps every unsuccessful result (including None) to
    // LargeTickMiss in Classic. Without Classic note lock, a very early head
    // press can therefore resolve a miss outside the ordinary miss window.
    const result =
      resultForOffset(this.hitWindows, this.gameState.currentTime - candidate.hitTime) ??
      (this.classicSliderBehaviour && candidate.sliderId !== undefined ? "MISS" : undefined);
    if (
      latestBlocker &&
      this.gameState.hitCircleVerdict[latestBlocker.id] === undefined &&
      this.gameState.currentTime < latestBlocker.hitTime
    ) {
      this.trace?.policy(
        this.gameState.currentTime,
        candidate,
        true,
        "native:start-time-ordered",
        result,
        latestBlocker.id,
      );
      this.gameState.lastNotelockShakeTime[candidate.id] = this.gameState.currentTime;
      if (result !== undefined && result !== "MISS") {
        this.gameState.lazerNotelockEvidence[candidate.id] ??= {
          targetHitObjectId: candidate.id,
          blockerHitObjectId: latestBlocker.id,
          pressTime: this.gameState.currentTime,
          cursorDistance: Vec2.distance(candidate.position, this.gameState.cursorPosition),
          objectRadius: candidate.radius,
          wouldHaveHit: result,
        };
      }
      return;
    }

    this.trace?.policy(this.gameState.currentTime, candidate, false, "native:start-time-ordered", result);
    if (result === undefined) return;

    const verdict: HitCircleVerdict =
      result === "MISS"
        ? {
            type: "MISS",
            missReason: "INPUT_WINDOW_MISS",
            judgementTime: this.gameState.currentTime,
          }
        : { type: result, judgementTime: this.gameState.currentTime, hitAction: action };
    this.judgeHitCircle(candidate, verdict, true, result === "MISS" ? "input-miss" : "successful-input");
  }

  /** osu!lazer LegacyHitPolicy; timing and slider tracking remain native. */
  private handleClassicPress(action: OsuAction): void {
    const time = this.gameState.currentTime;
    const aliveObjects = this.beatmap.hitObjects.filter((object) => {
      if (object.spawnTime > time) return false;
      if (isHitCircle(object)) return this.gameState.hitCircleVerdict[object.id] === undefined;
      if (isSlider(object)) return this.gameState.sliderVerdict[object.id] === undefined;
      return this.gameState.spinnerVerdict[object.id] === undefined;
    });
    const candidates = this.policyOrderedCircles
      .filter(
        (circle) =>
          this.gameState.aliveHitCircleIds.has(circle.id) ||
          (circle.sliderId !== undefined && this.gameState.aliveSliderIds.has(circle.sliderId)),
      )
      .sort(
        (left, right) =>
          left.hitTime - right.hitTime ||
          (this.circleInputOrder.get(right.id) ?? 0) - (this.circleInputOrder.get(left.id) ?? 0),
      );

    for (const circle of candidates) {
      if (!Vec2.withinDistance(circle.position, this.gameState.cursorPosition, Math.fround(circle.radius))) continue;
      if (this.trace?.extended) this.trace.selection(time, circle);
      // Classic keeps a slider head's hit area present until the entire parent
      // has finished, even after the head has already been judged.
      if (this.gameState.hitCircleVerdict[circle.id] !== undefined) {
        if (this.trace?.extended) this.trace.policy(time, circle, true, "native:classic-resolved-head", undefined);
        return;
      }
      const parentId = circle.sliderId ?? circle.id;
      const index = aliveObjects.findIndex((object) => object.id === parentId);
      const previous = aliveObjects[index - 1];
      const previousCircle =
        previous && (isHitCircle(previous) ? previous : isSlider(previous) ? previous.head : undefined);
      // The hovered receptor still consumes a positive stack's ignored press.
      if (previousCircle && previousCircle.stackHeight > 0) {
        if (this.trace?.extended)
          this.trace.policy(time, circle, true, "native:classic-positive-stack", undefined, previous!.id);
        return;
      }

      const result = resultForOffset(this.hitWindows, time - circle.hitTime);
      const blocker = aliveObjects
        .slice(0, index)
        .find((object) => (isHitCircle(object) ? object.hitTime : object.endTime) + 3 < circle.hitTime);
      if (blocker || result === undefined || Math.abs(time - circle.hitTime) >= this.hitWindows[3]) {
        if (this.trace?.extended)
          this.trace.policy(time, circle, true, "native:classic-note-lock", result, blocker?.id);
        this.gameState.lastNotelockShakeTime[circle.id] = time;
        if (blocker && result !== undefined && result !== "MISS") {
          this.gameState.lazerNotelockEvidence[circle.id] ??= {
            targetHitObjectId: circle.id,
            blockerHitObjectId: blocker.id,
            pressTime: time,
            cursorDistance: Vec2.distance(circle.position, this.gameState.cursorPosition),
            objectRadius: circle.radius,
            wouldHaveHit: result,
          };
        }
        return;
      }
      if (this.trace?.extended) this.trace.policy(time, circle, false, "native:classic-note-lock", result);
      this.judgeHitCircle(
        circle,
        result === "MISS"
          ? { type: "MISS", missReason: "INPUT_WINDOW_MISS", judgementTime: time }
          : { type: result, judgementTime: time, hitAction: action },
        true,
        this.trace?.extended ? (result === "MISS" ? "input-miss" : "successful-input") : "other-supported-resolution",
      );
      return;
    }
    if (this.trace?.extended) this.trace.selection(time);
  }

  private handleSpinnerEnd(spinnerId: string): void {
    if (this.gameState.spinnerVerdict[spinnerId] !== undefined) return;
    const spinner = this.beatmap.getSpinner(spinnerId);
    const state = this.gameState.spinnerState.get(spinnerId);
    const progress = spinnerProgress(state?.totalSpunAngle ?? 0, spinner.spinsRequired);
    const verdict = nativeLazerSpinnerVerdict(progress);

    this.gameState.spinnerVerdict[spinnerId] = { type: verdict, judgementTime: this.gameState.currentTime };
    if (state)
      this.trace?.spinnerResolution(spinner, verdict, this.gameState.currentTime, state, "lazer", this.spunOut);
    this.gameState.aliveSpinnerIds.delete(spinnerId);
    this.gameState.judgedObjects.push(spinnerId);
    this.appendJudgement({
      id: `lazer:spinner:${spinnerId}`,
      hitObjectId: spinnerId,
      kind: "SPINNER",
      result: verdict,
      objectTime: spinner.endTime,
      judgementTime: this.gameState.currentTime,
    });
  }

  private handleEvent(event: LazerEvent): void {
    switch (event.type) {
      case "SLIDER_ACTIVATE": {
        const slider = this.beatmap.getSlider(event.hitObjectId);
        this.gameState.aliveSliderIds.add(slider.id);
        this.gameState.sliderBodyState.set(slider.id, {
          isTracking: false,
          lastPressedActions: [...pressedActions(this.gameState)],
        });
        if (!this.deferTimeDrivenEventsAtCurrentTime) {
          this.updateSliderTracking(
            slider,
            this.gameState.currentTime,
            this.gameState.cursorPosition,
            pressedActions(this.gameState),
          );
        }
        break;
      }
      case "HIT_CIRCLE_SPAWN":
        this.gameState.aliveHitCircleIds.add(event.hitObjectId);
        this.trace?.activated(this.beatmap.getHitCircle(event.hitObjectId), event.time);
        break;
      case "SPINNER_ACTIVATE": {
        this.gameState.aliveSpinnerIds.add(event.hitObjectId);
        this.gameState.spinnerState.set(event.hitObjectId, initialSpinnerState(this.gameState.cursorPosition));
        if (!this.deferTimeDrivenEventsAtCurrentTime) {
          this.updateSpinner(
            event.hitObjectId,
            this.gameState.currentTime,
            this.gameState.cursorPosition,
            pressedActions(this.gameState),
          );
        }
        break;
      }
      case "HIT_CIRCLE_TIMEOUT": {
        if (!this.gameState.aliveHitCircleIds.has(event.hitObjectId)) break;
        const circle = this.beatmap.getHitCircle(event.hitObjectId);
        this.judgeHitCircle(
          circle,
          {
            type: "MISS",
            missReason: "TIME_EXPIRED",
            judgementTime: this.gameState.currentTime,
          },
          true,
          "automatic-expiry",
        );
        break;
      }
      case "SLIDER_CHECK_POINT": {
        const checkpoint = this.beatmap.getSliderCheckPoint(event.hitObjectId);
        this.processDueSliderComponents(checkpoint.slider);
        this.tryFinishSlider(checkpoint.slider);
        break;
      }
      case "SLIDER_TAIL": {
        const slider = this.beatmap.getSlider(event.hitObjectId);
        this.processDueSliderComponents(slider);
        this.tryFinishSlider(slider);
        break;
      }
      case "SLIDER_END": {
        const slider = this.beatmap.getSlider(event.hitObjectId);
        this.processDueSliderComponents(slider);
        this.tryFinishSlider(slider);
        break;
      }
      case "SPINNER_END":
        this.handleSpinnerEnd(event.hitObjectId);
        break;
    }
  }

  private processEventsBefore(time: number, actions: readonly OsuAction[]): void {
    while (this.gameState.eventIndex < this.events.length) {
      const event = this.events[this.gameState.eventIndex];
      if (event.time >= time) break;
      const position = this.predictedCursorPositionAt(event.time);
      this.advanceTo(event.time, position, actions);
      this.gameState.eventIndex++;
      this.handleEvent(event);
    }
  }

  private processExactActivationEvents(time: number): void {
    while (this.gameState.eventIndex < this.events.length) {
      const event = this.events[this.gameState.eventIndex];
      if (event.time !== time || !isActivationEvent(event)) break;
      this.gameState.eventIndex++;
      this.handleEvent(event);
    }
  }

  private processEventsThrough(time: number): void {
    while (this.gameState.eventIndex < this.events.length) {
      const event = this.events[this.gameState.eventIndex];
      if (event.time > time) break;
      this.gameState.eventIndex++;
      this.handleEvent(event);
    }
  }

  private evaluateFrame(
    gameState: GameState,
    frame: ReplayFrame,
    deferTimeDrivenEventsAtCurrentTime: boolean,
    finalSourceInZeroDeltaBatch = false,
    transient = false,
    groupMemberIndex = 0,
  ): void {
    this.gameState = gameState;
    this.frame = frame;
    this.deferTimeDrivenEventsAtCurrentTime = deferTimeDrivenEventsAtCurrentTime;
    const previousActions = pressedActions(gameState);
    if (this.reconstructRelax) {
      // Ignore absent legacy buttons while advancing continuous state. Actual
      // generated transitions are applied below through the ordinary hit policy.
      frame = { ...frame, actions: previousActions };
      this.frame = frame;
    }

    this.processEventsBefore(frame.time, previousActions);
    if (deferTimeDrivenEventsAtCurrentTime) {
      // Input-triggered receptors and continuous spinner rotation observe every
      // ordered source frame. Time-driven slider judgements remain deferred until
      // the batch's final state.
      this.advanceTo(frame.time, frame.position, frame.actions, null);
    } else {
      // Frame-accurate lazer exposes the endpoint's new action state before
      // continuous drawable input updates. This prevents a release endpoint from
      // contributing spinner rotation and allows a press endpoint to contribute.
      this.advanceTo(frame.time, frame.position, frame.actions, finalSourceInZeroDeltaBatch ? null : previousActions);
    }
    this.processExactActivationEvents(frame.time);

    if (this.reconstructRelax && !transient) {
      frame = {
        ...frame,
        actions: legacyRelaxActionsAt(this.beatmap, gameState, frame.position, frame.time, this.hitWindows[2]),
      };
      this.frame = frame;
    }

    const freshActions = frame.actions.filter((action) => !previousActions.includes(action));
    this.trace?.input(frame, previousActions, freshActions, groupMemberIndex);
    this.gameState.pressingSince = newPressingSince(this.gameState.pressingSince, frame.actions, frame.time);

    // Input-triggered judgements can resolve slider heads, including by force
    // missing them through ordered processing. Defer generic nested slider
    // judgements until tracking has observed this endpoint's new action state.
    const wasDeferringTimeDrivenEvents = this.deferTimeDrivenEventsAtCurrentTime;
    this.deferTimeDrivenEventsAtCurrentTime = true;
    try {
      let attempt = 0;
      for (const action of freshActions) {
        this.trace?.attempt(frame.time, attempt, action);
        this.handleFreshPress(action);
        this.trace?.endAttempt();
        attempt++;
      }
    } finally {
      this.deferTimeDrivenEventsAtCurrentTime = wasDeferringTimeDrivenEvents;
    }

    if (deferTimeDrivenEventsAtCurrentTime) return;

    // Input is now applied. Update continuous managers once more at the same
    // position so exact-time nested judgements see the new action state.
    this.advanceTo(frame.time, frame.position, frame.actions);
    this.processEventsThrough(frame.time);

    for (const sliderId of Array.from(this.gameState.aliveSliderIds)) {
      const slider = this.beatmap.getSlider(sliderId);
      this.processDueSliderComponents(slider);
      this.tryFinishSlider(slider);
    }
  }

  evaluate(gameState: GameState, frame: ReplayFrame, transient = false, trace?: ReplayTraceObserver): void {
    this.trace = transient ? undefined : trace;
    if (frame.sourceFramesAtSameTime?.length) {
      const sources = frame.sourceFramesAtSameTime;
      for (let index = 0; index < sources.length; index++) {
        this.evaluateFrame(
          gameState,
          sources[index],
          index < sources.length - 1,
          index === sources.length - 1,
          false,
          index,
        );
      }
      this.trace = undefined;
      return;
    }
    this.evaluateFrame(gameState, frame, false, false, transient);
    this.trace = undefined;
  }
}
