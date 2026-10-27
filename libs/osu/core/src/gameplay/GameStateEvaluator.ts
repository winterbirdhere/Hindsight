import { float32_mul, hitWindowsForOD, Position, Vec2 } from "@osujs/math";
import { Beatmap } from "../beatmap/Beatmap";
import { defaultGameState, GameState, HitCircleVerdict, NOT_PRESSING, PressingSinceTimings } from "./GameState";
import { isHitCircle, isSlider, isSpinner } from "../hitobjects/Types";
import { Slider } from "../hitobjects/Slider";
import { OsuAction, ReplayFrame } from "../replays/Replay";
import { MainHitObjectVerdict } from "./Verdicts";
import { HitCircle } from "../hitobjects/HitCircle";
import { RELAX_LENIENCY } from "../mods/Mods";
import { StableSliderBallPath } from "./StableSliderBallPath";
import { StableSliderTiming } from "./StableSliderTiming";
import { stableHitWindowsForOD } from "./StableDifficulty";
import { stableGameplayRadius, stableWithinHitRadius, stableWithinTrackingRadius } from "./StableHitGeometry";
import { initialSpinnerState } from "./SpinnerTracking";
import { ReplayTraceObserver } from "./trace/ReplayTraceObserver";
import { TerminalMechanism } from "./trace/ReplayTrace";
import {
  stableSpinnerVerdict,
  updateStableSpinnerRotation,
  usesLegacyStableSpinnerRules,
} from "./StableSpinnerTracking";

/**
 *  Evaluates the next game state based on the current one and the next frame.
 *
 * Stable records ordinary cursor samples at roughly 60 FPS, with extra samples
 * for input and scoring updates. Slider checkpoints resolve from the input and
 * cursor in the first recorded update at or after their integer deadline.
 * Interpolation remains useful for timed activation between recorded samples;
 * it must not invent a successful checkpoint before the observed update.
 */

type Event = {
  time: number;
  hitObjectId: string;
  type:
    | "HIT_CIRCLE_SPAWN"
    | "HIT_CIRCLE_FORCE_KILL"
    | "SLIDER_START"
    | "SLIDER_END"
    | "SPINNER_START"
    | "SPINNER_END"
    | "SLIDER_CHECK_POINT";
};

function generateEvents(beatmap: Beatmap, hitWindows: number[]): Event[] {
  const events: Event[] = [];
  const mehHitWindow = hitWindows[2];

  const pushHitCircleEvents = (h: HitCircle) => {
    events.push({ time: h.hitTime - h.approachDuration, hitObjectId: h.id, type: "HIT_CIRCLE_SPAWN" });
    // Stable expires only once the integer clock is beyond its nominal 50
    // window. Successful windows above already exclude that last millisecond.
    events.push({
      time: h.hitTime + Math.floor(mehHitWindow + 1) + 1,
      hitObjectId: h.id,
      type: "HIT_CIRCLE_FORCE_KILL",
    });
  };

  for (const h of beatmap.hitObjects) {
    if (isHitCircle(h)) {
      pushHitCircleEvents(h);
    } else if (isSlider(h)) {
      const timing = new StableSliderTiming(h);
      pushHitCircleEvents(h.head);
      events.push({ time: h.startTime, hitObjectId: h.id, type: "SLIDER_START" });
      events.push({ time: timing.endTime, hitObjectId: h.id, type: "SLIDER_END" });
      timing.checkPoints.forEach((c) => {
        // Stable stores checkpoint times as integers. Keep the shared beatmap
        // geometry precise: the native Lazer evaluator uses its own event times.
        events.push({ time: timing.checkpointTime(c), hitObjectId: c.id, type: "SLIDER_CHECK_POINT" });
      });
    } else if (isSpinner(h)) {
      events.push({ time: h.startTime, hitObjectId: h.id, type: "SPINNER_START" });
    }
  }

  // TODO: What if 2B maps?
  events.sort((a, b) => a.time - b.time);

  return events;
}

/** Earliest Stable numerical input/event effect, in the prepared map's time coordinate.
 * Spawn alone is not an input effect; MISS input can judge or latch a slider head.
 * This does not attest replay provenance, input capabilities or completion. */
export function stableNumericalInputBoundary(beatmap: Beatmap): number | undefined {
  const windows=stableHitWindowsForOD(beatmap.stableOverallDifficulty);
  if(!windows.every(Number.isFinite))return;
  let boundary=Infinity;
  for(const object of beatmap.hitObjects){
    if((isSlider(object)||isSpinner(object))&&(!Number.isFinite(object.startTime)||!Number.isFinite(object.endTime)||object.endTime<object.startTime))return;
    const head=isHitCircle(object)?object:isSlider(object)?object.head:undefined;
    if(head){
      const spawn=head.hitTime-head.approachDuration,miss=head.hitTime-windows[3];
      if(![spawn,miss,head.hitTime].every(Number.isFinite)||head.approachDuration<0)return;
      boundary=Math.min(boundary,Math.max(spawn,miss));
    }else if(!isSpinner(object))return;
  }
  for(const event of generateEvents(beatmap,windows)){
    if(!Number.isFinite(event.time))return;
    if(event.type!=="HIT_CIRCLE_SPAWN")boundary=Math.min(boundary,event.time);
  }
  return Number.isFinite(boundary)?boundary:undefined;
}

export type NoteLockStyle = "NONE" | "STABLE" | "LAZER";
export type HitWindowStyle = "OSU_STABLE" | "OSU_LAZER";

export type GameStateEvaluatorOptions = {
  hitWindowStyle: HitWindowStyle;
  noteLockStyle: NoteLockStyle;
  replayGameVersion?: number;
  /** Source replay date as UTC epoch milliseconds, for Stable version compatibility. */
  replayTimestamp?: number;
};

const defaultOptions: GameStateEvaluatorOptions = {
  noteLockStyle: "STABLE",
  hitWindowStyle: "OSU_STABLE",
};

const HitObjectVerdicts = {
  GREAT: 0,
  OK: 1,
  MEH: 2,
  MISS: 3,
} as const;

function isWithinHitWindow(hitWindow: number[], delta: number, verdict: MainHitObjectVerdict): boolean {
  return Math.abs(delta) <= hitWindow[HitObjectVerdicts[verdict]];
}

const successfulVerdictForDelta = (
  hitWindows: number[],
  delta: number,
): Exclude<MainHitObjectVerdict, "MISS"> | undefined =>
  (["GREAT", "OK", "MEH"] as const).find((verdict) => isWithinHitWindow(hitWindows, delta, verdict));

function pressedActions(pressingSince: PressingSinceTimings): OsuAction[] {
  const actions: OsuAction[] = [];
  if (pressingSince[OsuAction.leftButton] !== NOT_PRESSING) actions.push(OsuAction.leftButton);
  if (pressingSince[OsuAction.rightButton] !== NOT_PRESSING) actions.push(OsuAction.rightButton);
  return actions;
}

function logicalButtons(actions: readonly OsuAction[]): number {
  return (actions.includes(OsuAction.leftButton) ? 1 : 0) | (actions.includes(OsuAction.rightButton) ? 2 : 0);
}

function preferredFreshButton(buttons: number): number {
  return buttons & 1 ? 1 : buttons & 2 ? 2 : 0;
}

function updateSliderButtonLatch(
  latch: number,
  current: number,
  previous: number,
  previousPrevious: number,
  fresh: number,
) {
  // Stable remembers distinct button transitions. Returning from both buttons
  // to an older held side cannot replace a missing latched side.
  const maySwitch = current !== 0 && (previous !== 3 || previousPrevious !== current);
  let latchedHeld = false;
  if (current !== 0) {
    if (latch === 0 || (current !== 3 && maySwitch)) {
      latch = preferredFreshButton(fresh) || current;
      latchedHeld = true;
    } else if ((current & latch) !== 0) latchedHeld = true;
  } else latch = 0;
  return { latch, canTrack: latchedHeld || maySwitch };
}

export class GameStateEvaluator {
  private trace?: ReplayTraceObserver;
  private readonly events: Event[];
  private gameState: GameState = defaultGameState();
  private frame: ReplayFrame = { time: 0, position: { x: 0, y: 0 }, actions: [] };
  private options: GameStateEvaluatorOptions;
  private hitWindows: number[];
  private freshPressCountThisFrame = 0;
  private freshLogicalButtonsThisFrame = 0;
  private previousInputTime = 0;
  private readonly stableSliderBallPaths = new Map<string, StableSliderBallPath>();
  private readonly stableSliderEndTimes = new Map<string, number>();
  private readonly stableCheckpointEvents = new Map<string, Event>();
  private pendingScoringEvents: Event[] = [];
  private readonly scoringObjectOrder = new Map<string, number>();

  constructor(private readonly beatmap: Beatmap, options?: GameStateEvaluatorOptions) {
    this.options = Object.assign({ ...defaultOptions }, options);
    this.hitWindows =
      this.options.hitWindowStyle === "OSU_LAZER"
        ? hitWindowsForOD(beatmap.difficulty.overallDifficulty, true)
        : stableHitWindowsForOD(beatmap.stableOverallDifficulty);
    this.events = generateEvents(beatmap, this.hitWindows);
    for (const event of this.events) {
      if (event.type === "SLIDER_END") this.stableSliderEndTimes.set(event.hitObjectId, event.time);
      if (event.type === "SLIDER_CHECK_POINT") this.stableCheckpointEvents.set(event.hitObjectId, event);
    }
    beatmap.hitObjects.forEach((object, index) => {
      this.scoringObjectOrder.set(object.id, index);
      if (isSlider(object)) {
        this.scoringObjectOrder.set(object.head.id, index);
        (object.stableCheckPoints ?? object.checkPoints).forEach((checkpoint) =>
          this.scoringObjectOrder.set(checkpoint.id, index),
        );
      }
    });
  }

  judgeHitCircle(id: string, verdict: HitCircleVerdict, mechanism: TerminalMechanism = "other-supported-resolution") {
    this.trace?.resolution(
      this.beatmap.getHitCircle(id),
      verdict,
      mechanism,
      this.gameState.hitCircleVerdict[id] === undefined,
    );
    this.gameState.hitCircleVerdict[id] = verdict;
    // A later successful attempt disproves the blocked press as the cause of a
    // miss. Misses retain the evidence for error details.
    if (verdict.type !== "MISS") delete this.gameState.stableNotelockEvidence[id];
    this.gameState.aliveHitCircleIds.delete(id);
    this.gameState.judgedObjects.push(id);
  }

  handleHitCircleSpawn(time: number, hitCircleId: string) {
    this.gameState.aliveHitCircleIds.add(hitCircleId);
  }

  handleHitCircleForceKill(time: number, hitCircleId: string) {
    // Already dead? The shinigami will just leave...
    if (!this.gameState.aliveHitCircleIds.has(hitCircleId)) {
      return;
    }
    // Otherwise we force kill for not being hit by the player ...
    const verdict: HitCircleVerdict = { judgementTime: time, type: "MISS", missReason: "TIME_EXPIRED" };
    this.judgeHitCircle(hitCircleId, verdict, "automatic-expiry");
  }

  handleSliderStart(time: number, sliderId: string) {
    this.gameState.aliveSliderIds.add(sliderId);
    // Tracking can only acquire at an observed update. A start between samples
    // waits for the normal body update; an exact-start sample can acquire now.
    if (time === this.frame.time)
      this.updateSliderBodyTracking(time, this.frame.position, this.gameState.pressingSince);
  }

  handleSliderEnding(time: number, sliderId: string) {
    const slider = this.beatmap.getSlider(sliderId);

    const headVerdict = this.gameState.hitCircleVerdict[slider.head.id];
    // Stable grades a short parent while its unresolved head still awaits the
    // original miss window. Expiring that head here would reset combo early.

    // Now count the hit checkpoints and get the verdict
    const checkPoints = slider.stableCheckPoints ?? slider.checkPoints;
    const totalCheckpoints = checkPoints.length + 1;
    let hitCheckpoints = 0;
    if (!(headVerdict === undefined || headVerdict.type === "MISS")) hitCheckpoints++;
    for (const c of checkPoints) {
      hitCheckpoints += this.gameState.checkPointVerdict[c.id]?.hit ? 1 : 0;
    }
    let verdict = sliderVerdictBasedOnCheckpoints(totalCheckpoints, hitCheckpoints);
    if (this.beatmap.appliedMods.includes("SCORE_V2") && verdict !== "MISS") {
      // V2 limits collected-part credit by head accuracy. A missed/unresolved
      // head still permits 50 from collected body parts; it is not a parent Miss.
      const headCap = headVerdict?.type === "GREAT" || headVerdict?.type === "OK" ? headVerdict.type : "MEH";
      if (HitObjectVerdicts[headCap] > HitObjectVerdicts[verdict]) verdict = headCap;
    }
    this.gameState.sliderVerdict[slider.id] = verdict;
    this.gameState.sliderJudgementTime[slider.id] = this.frame.time;
    this.trace?.component(
      {
        kind: "slider-parent",
        componentId: slider.id,
        result: this.gameState.sliderVerdict[slider.id],
        scoring: true,
        totalParts: totalCheckpoints,
        hitParts: hitCheckpoints,
        headId: slider.head.id,
        headResult: headVerdict?.type,
        checkpointIds: checkPoints.map((c) => c.id),
        pendingIds: checkPoints.filter((c) => this.gameState.checkPointVerdict[c.id] === undefined).map((c) => c.id),
        headCap: this.beatmap.appliedMods.includes("SCORE_V2"),
        objectTimeMs: slider.endTime,
      },
      this.frame.time,
    );
    this.gameState.judgedObjects.push(slider.id);
    // An unresolved head remains scheduled for its independent expiry.
    this.gameState.aliveSliderIds.delete(sliderId);
    this.gameState.sliderBodyState.delete(sliderId);
  }

  predictedCursorPositionAt(time: number): Position {
    const previousTime = this.gameState.currentTime;
    const nextTime = this.frame.time;
    const previousPosition = this.gameState.cursorPosition;
    const nextPosition = this.frame.position;

    if (previousTime === nextTime) return previousPosition;

    const f = (time - previousTime) / (nextTime - previousTime);
    return Vec2.interpolate(previousPosition, nextPosition, f);
  }

  handleSliderCheckPoint(time: number, id: string) {
    const checkPoint = this.beatmap.getSliderCheckPoint(id);
    const judgementTime = this.frame.time;
    this.updateSliderBodyTracking(judgementTime, this.frame.position, this.gameState.pressingSince);
    const sliderId = checkPoint.slider.id;
    const state = this.gameState.sliderBodyState.get(sliderId);
    if (state === undefined) {
      throw Error("Somehow the slider body has no state while there is a checkpoint alive.");
    }
    this.gameState.checkPointVerdict[id] = {
      hit: state.isTracking && state.trackingSince !== undefined && state.trackingSince <= time,
      judgementTime,
    };
    this.trace?.component(
      {
        kind: "slider-checkpoint",
        componentId: id,
        parentId: sliderId,
        component:
          checkPoint.type === "LAST_LEGACY_TICK"
            ? "slider-legacy-tail"
            : checkPoint.type === "REPEAT"
            ? "slider-repeat"
            : "slider-tick",
        deadlineMs: time,
        objectTimeMs: checkPoint.hitTime,
        hit: this.gameState.checkPointVerdict[id].hit,
        lateAcquisition: state.isTracking && state.trackingSince !== undefined && state.trackingSince > time,
      },
      judgementTime,
    );
    this.gameState.judgedObjects.push(id);
  }

  private updateSpinner(id: string, time: number, position: Position, actions: readonly OsuAction[]): void {
    const spinner = this.beatmap.getSpinner(id);
    const previous = this.gameState.spinnerState.get(id);
    if (!previous) return;

    const tracking =
      time >= spinner.startTime &&
      time < spinner.endTime &&
      this.gameState.spinnerVerdict[id] === undefined &&
      // Relax supplies the hold; its replay may contain only cursor movement.
      // Rotation and the clear threshold still come from the recorded spin.
      (this.beatmap.appliedMods.includes("RELAX") ||
        actions.includes(OsuAction.leftButton) ||
        actions.includes(OsuAction.rightButton));
    this.gameState.spinnerState.set(
      id,
      updateStableSpinnerRotation(
        previous,
        spinner,
        position,
        tracking,
        this.beatmap.gameClockRate,
        this.beatmap.stableOverallDifficulty,
        time,
        this.beatmap.appliedMods.includes("RELAX"),
        usesLegacyStableSpinnerRules(this.options.replayGameVersion, this.options.replayTimestamp),
        this.previousInputTime,
      ),
    );
    this.trace?.spinnerStep(
      spinner,
      time,
      tracking,
      previous,
      this.gameState.spinnerState.get(id)!,
      "stable",
      this.beatmap.appliedMods.includes("SPUN_OUT") || this.beatmap.appliedMods.includes("AUTO_PLAY"),
    );
  }

  private updateAliveSpinners(time: number, position: Position, actions: readonly OsuAction[]): void {
    for (const id of this.gameState.aliveSpinnerIds) {
      this.updateSpinner(id, time, position, actions);
      const spinner = this.beatmap.getSpinner(id);
      // Stable expires strictly after the end. Derive this from the cached
      // alive state so an exact-end frame remains reversible and forkable.
      if (spinner.endTime < time)
        this.pendingScoringEvents.push({ type: "SPINNER_END", hitObjectId: id, time: spinner.endTime });
    }
  }

  handleSpinnerStart(time: number, id: string) {
    this.gameState.aliveSpinnerIds.add(id);
    // The first actual replay sample initializes the angle. Injecting a sample
    // at the nominal start invents rotation and duplicates exact-start input.
    this.gameState.spinnerState.set(id, initialSpinnerState(this.frame.position));
  }

  handleSpinnerEnd(time: number, id: string) {
    if (this.gameState.spinnerVerdict[id] !== undefined) return;
    const spinnerState = this.gameState.spinnerState.get(id);
    if (!spinnerState) return;
    // Stable SpunOut completes the judgement independently of recorded cursor
    // motion/holds. Keep existing rotation/bonus state: it is not a reconstructed
    // automatic trajectory, and native's 101%-required curve is a different rule.
    const verdict = this.beatmap.appliedMods.includes("SPUN_OUT") ? "GREAT" : stableSpinnerVerdict(spinnerState);

    this.gameState.spinnerVerdict[id] = { type: verdict, judgementTime: time };
    this.trace?.spinnerResolution(
      this.beatmap.getSpinner(id),
      verdict,
      time,
      spinnerState,
      "stable",
      this.beatmap.appliedMods.includes("SPUN_OUT") || this.beatmap.appliedMods.includes("AUTO_PLAY"),
    );
    this.gameState.aliveSpinnerIds.delete(id);
    this.gameState.judgedObjects.push(id);
  }

  handleEvent(event: Event) {
    const { hitObjectId, time, type } = event;
    switch (type) {
      case "HIT_CIRCLE_SPAWN":
        this.handleHitCircleSpawn(time, hitObjectId);
        this.trace?.activated(this.beatmap.getHitCircle(hitObjectId), time);
        break;
      case "HIT_CIRCLE_FORCE_KILL":
        this.handleHitCircleForceKill(time, hitObjectId);
        break;
      case "SLIDER_START":
        this.handleSliderStart(time, hitObjectId);
        break;
      case "SLIDER_END":
        this.handleSliderEnding(time, hitObjectId);
        break;
      case "SLIDER_CHECK_POINT":
        this.handleSliderCheckPoint(time, hitObjectId);
        break;
      case "SPINNER_START":
        this.handleSpinnerStart(time, hitObjectId);
        break;
      case "SPINNER_END":
        this.handleSpinnerEnd(time, hitObjectId);
        break;
    }
  }

  handleAliveHitCircles() {
    // There is only action if there is also a click in this frame ...
    const hasRelax = this.beatmap.appliedMods.includes("RELAX");
    if (!this.hasFreshClickThisFrame && !hasRelax) {
      return;
    }
    const { noteLockStyle } = this.options;
    const currentTime = this.gameState.currentTime;
    let noteLocked = false;
    let noteLockBlockerId: string | undefined;
    let traceSelected = false;

    // JavaScript `Set` maintains its elements in insertion order so the early ones
    // we iterate on are also the ones that are supposed to be hit first ...
    // We copy because the values into an array because we might delete them ...
    const hitCircleIds = Array.from(this.gameState.aliveHitCircleIds.values());

    for (let i = 0; i < hitCircleIds.length; i++) {
      const id = hitCircleIds[i];
      const hitCircle = this.beatmap.getHitCircle(id);
      // A completed slider is no longer an input target, even when its short
      // duration leaves the head's independent expiry pending.
      if (hitCircle.sliderId && this.gameState.sliderVerdict[hitCircle.sliderId] !== undefined) continue;

      // Stable's geometric selector stops accepting a target beyond its
      // nominal50 window, even when this update has not expired it yet.
      if (currentTime > hitCircle.hitTime + this.hitWindows[2] + 1) continue;

      const hitRadius = stableGameplayRadius(hitCircle.radius);
      const cursorInside = stableWithinHitRadius(hitCircle.position, this.gameState.cursorPosition, hitRadius);

      if (!cursorInside) {
        // It's a bit fairer because this allows us to force miss notes that are in the past.
        if (noteLockStyle === "LAZER" && currentTime <= hitCircle.hitTime) {
          noteLocked = true;
        }
        continue;
      }

      if (noteLockStyle === "STABLE") {
        // Select the first geometrically eligible target, then test every
        // earlier unjudged parent. Ineligible/expired-but-unjudged circles still
        // block input; circles, sliders and spinners share the same 3ms exception.
        const parentId = hitCircle.sliderId ?? id;
        const firstUnjudged = this.gameState.stableNotelockStartIndex ?? 0;
        this.gameState.stableNotelockStartIndex = firstUnjudged;
        for (let earlierIndex = firstUnjudged; earlierIndex < this.beatmap.hitObjects.length; earlierIndex++) {
          const earlier = this.beatmap.hitObjects[earlierIndex];
          if (earlier.id === parentId) break;
          const verdict = isHitCircle(earlier)
            ? this.gameState.hitCircleVerdict[earlier.id]
            : isSlider(earlier)
            ? this.gameState.sliderVerdict[earlier.id]
            : this.gameState.spinnerVerdict[earlier.id];
          if (verdict !== undefined) {
            if (earlierIndex === this.gameState.stableNotelockStartIndex) {
              this.gameState.stableNotelockStartIndex = earlierIndex + 1;
            }
            continue;
          }
          const endTime = isHitCircle(earlier)
            ? earlier.hitTime
            : isSlider(earlier)
            ? this.stableSliderEndTimes.get(earlier.id) ?? Math.trunc(earlier.endTime)
            : earlier.endTime;
          if (endTime + 3 < hitCircle.hitTime) {
            noteLocked = true;
            noteLockBlockerId = earlier.id;
            break;
          }
        }
      }

      const delta = currentTime - hitCircle.hitTime;
      const successfulVerdict = successfulVerdictForDelta(this.hitWindows, delta);
      if (this.trace) {
        traceSelected = true;
        this.trace.selection(currentTime, hitCircle, true);
        this.trace.policy(
          currentTime,
          hitCircle,
          noteLocked,
          `stable:${noteLockStyle}`,
          successfulVerdict ?? (isWithinHitWindow(this.hitWindows, delta, "MISS") ? "MISS" : undefined),
          noteLockBlockerId,
        );
      }

      // If we got note locked, we want to set an animation then ignore the other hit circles
      if (noteLocked) {
        if (noteLockStyle === "STABLE" && !hasRelax && this.hasFreshClickThisFrame) {
          this.gameState.lastNotelockShakeTime[id] = currentTime;
        }

        // Relax reaches this selector only after an eligible parent generated
        // an automatic callback. Its selected target can be a different object.
        const hasHitAttempt = hasRelax || this.hasFreshClickThisFrame;
        if (noteLockStyle === "STABLE" && hasHitAttempt && noteLockBlockerId) {
          if (successfulVerdict) {
            this.gameState.stableNotelockEvidence[id] ??= {
              targetHitObjectId: id,
              blockerHitObjectId: noteLockBlockerId,
              pressTime: currentTime,
              cursorDistance: Vec2.distance(hitCircle.position, this.gameState.cursorPosition),
              objectRadius: hitRadius,
              wouldHaveHit: successfulVerdict,
            };
          }
        }
        break;
      }

      // Stable latches the selected slider head's fresh side before checking
      // its timing, so even a failed head attempt can affect later tracking.
      if (
        hitCircle.sliderId &&
        this.freshLogicalButtonsThisFrame &&
        isWithinHitWindow(this.hitWindows, delta, "MISS")
      ) {
        const body = this.gameState.sliderBodyState.get(hitCircle.sliderId);
        this.gameState.sliderBodyState.set(hitCircle.sliderId, {
          isTracking: false,
          ...body,
          stableButtonLatch: preferredFreshButton(this.freshLogicalButtonsThisFrame),
        });
      }

      let judged = successfulVerdict !== undefined;
      if (successfulVerdict) {
        this.judgeHitCircle(hitCircle.id, { judgementTime: currentTime, type: successfulVerdict }, "successful-input");
      }

      // TODO: Force miss other notes less than i for lazer style
      if (judged) break;

      if (isWithinHitWindow(this.hitWindows, delta, "MISS")) {
        // A late press can reach a circle before this update expires it. The
        // resulting miss consumes that press instead of passing it to a later note.
        this.judgeHitCircle(
          hitCircle.id,
          {
            judgementTime: currentTime,
            type: "MISS",
            missReason: delta < 0 ? "HIT_TOO_EARLY" : "TIME_EXPIRED",
          },
          "input-miss",
        );
        judged = true;
      }

      // Stable chooses one geometrically eligible target before checking its
      // timing. Even outside the miss input window, that attempt goes no further.
      if (judged || noteLockStyle === "STABLE") break;
    }
    if (this.trace && !traceSelected) this.trace.selection(currentTime);
  }

  private get hasFreshClickThisFrame(): boolean {
    return this.freshPressCountThisFrame > 0;
  }

  private updateSliderBodyTracking(time: number, cursorPosition: Position, pressingSince: PressingSinceTimings): void {
    for (const id of this.gameState.aliveSliderIds) {
      const slider = this.beatmap.getSlider(id);

      const previous = this.gameState.sliderBodyState.get(id);
      const wasTracking: boolean = previous?.isTracking ?? false;
      const hasRelax = this.beatmap.appliedMods.includes("RELAX");
      const input = updateSliderButtonLatch(
        previous?.stableButtonLatch ?? 0,
        logicalButtons(pressedActions(pressingSince)),
        this.gameState.stablePreviousButtons,
        this.gameState.stablePreviousPreviousButtons,
        this.freshLogicalButtonsThisFrame,
      );
      let ballPath = this.stableSliderBallPaths.get(id);
      if (!ballPath) {
        ballPath = new StableSliderBallPath(slider);
        this.stableSliderBallPaths.set(id, ballPath);
      }
      const isTracking = determineTracking(
        wasTracking,
        slider,
        ballPath.positionAt(time),
        cursorPosition,
        time,
        input.canTrack,
        hasRelax,
      );
      this.gameState.sliderBodyState.set(id, {
        isTracking,
        stableButtonLatch: input.latch,
        trackingSince: isTracking ? (wasTracking ? previous?.trackingSince ?? time : time) : undefined,
      });
      if (this.trace?.extended) {
        const ball = ballPath.positionAt(time),
          radius = float32_mul(stableGameplayRadius(slider.radius), wasTracking ? 2.4 : 1);
        this.trace.tracking(id, {
          timeMs: time,
          sampleBasis: "recorded-update",
          position: { ...cursorPosition },
          ball: { ...ball },
          radius,
          geometryAccepted: stableWithinTrackingRadius(ball, cursorPosition, radius),
          holdAccepted: input.canTrack || hasRelax,
          started: time >= slider.startTime,
          actions: pressedActions(pressingSince),
          beforeTracking: wasTracking,
          tracking: isTracking,
          trackingSince: this.gameState.sliderBodyState.get(id)?.trackingSince,
          latch: input.latch,
        });
      }
    }
  }

  private deferScoringEvent(event: Event): boolean {
    if (
      event.type !== "HIT_CIRCLE_FORCE_KILL" &&
      event.type !== "SLIDER_CHECK_POINT" &&
      event.type !== "SLIDER_END" &&
      event.type !== "SPINNER_END"
    )
      return false;
    this.pendingScoringEvents.push(event);
    return true;
  }

  private handlePendingScoringEvents(): void {
    const events = this.pendingScoringEvents.filter((event) => event.type !== "SLIDER_CHECK_POINT");
    this.pendingScoringEvents = [];
    // Stable resolves only the next due checkpoint in each slider body update.
    // Derive the backlog from cached verdicts so it survives seeks and forks;
    // the parent may expire before every overdue checkpoint gets an update.
    for (const id of this.gameState.aliveSliderIds) {
      const slider = this.beatmap.getSlider(id);
      const checkpoint = (slider.stableCheckPoints ?? slider.checkPoints).find(
        (c) => this.gameState.checkPointVerdict[c.id] === undefined,
      );
      if (!checkpoint) continue;
      const event = this.stableCheckpointEvents.get(checkpoint.id);
      if (event && event.time <= this.frame.time) events.push(event);
    }
    // Stable updates each parent in beatmap order. Within a slider, its body
    // resolves checkpoints before the manager expires its head or judges it.
    const priority = (event: Event) =>
      event.type === "SLIDER_CHECK_POINT" ? 0 : event.type === "HIT_CIRCLE_FORCE_KILL" ? 1 : 2;
    events.sort(
      (left, right) =>
        (this.scoringObjectOrder.get(left.hitObjectId) ?? 0) - (this.scoringObjectOrder.get(right.hitObjectId) ?? 0) ||
        priority(left) - priority(right) ||
        left.time - right.time,
    );
    for (const event of events) {
      // Checkpoints retain their scheduled deadline for the acquisition guard;
      // all resulting judgements belong to this actual recorded update.
      this.handleEvent(event.type === "SLIDER_CHECK_POINT" ? event : { ...event, time: this.frame.time });
    }
  }

  // Process the events until event[i].time <= maxTimeInclusive is no longer valid.
  handleEventsUntilTime(maxTimeInclusive: number) {
    const { gameState, events } = this;
    while (gameState.eventIndex < events.length) {
      const event = events[gameState.eventIndex];
      if (event.time > maxTimeInclusive) {
        break;
      }
      gameState.eventIndex += 1;
      if (this.deferScoringEvent(event)) continue;
      this.handleEvent(event);
    }
  }

  // Activate timed objects before input, then resolve due scoring events from
  // this frame's input. Exact-time events are processed after input as well.
  handleEventsBeforeTime(maxTimeExclusive: number) {
    const { gameState, events } = this;
    while (gameState.eventIndex < events.length) {
      const event = events[gameState.eventIndex];
      if (event.time >= maxTimeExclusive) {
        break;
      }
      gameState.eventIndex += 1;
      if (this.deferScoringEvent(event)) continue;
      this.handleEvent(event);
    }
  }

  evaluate(gameState: GameState, frame: ReplayFrame, trace?: ReplayTraceObserver) {
    this.trace = trace;
    this.gameState = gameState;
    this.frame = frame;
    this.previousInputTime = gameState.currentTime;

    // 1. Deal with hit objects that are only affected with movement (sliders, spinners)
    // Tbh in my first version I have this.handleEventsUntilTime(frame.time) right now, which makes more sense.

    this.handleEventsBeforeTime(frame.time);

    // 2. Now consider things that get affected by releasing / clicking at this particular time.
    this.gameState.cursorPosition = frame.position;
    this.gameState.currentTime = frame.time;
    const freshLogicalButtonCount = [OsuAction.leftButton, OsuAction.rightButton].filter(
      (action) => frame.actions.includes(action) && this.gameState.pressingSince[action] === NOT_PRESSING,
    ).length;
    const previousButtons = logicalButtons(pressedActions(this.gameState.pressingSince));
    const currentButtons = logicalButtons(frame.actions);
    this.freshLogicalButtonsThisFrame = currentButtons & ~previousButtons;
    if (trace)
      trace.input(
        frame,
        pressedActions(this.gameState.pressingSince),
        [OsuAction.leftButton, OsuAction.rightButton].filter(
          (action) => (this.freshLogicalButtonsThisFrame & (1 << action)) !== 0,
        ),
      );
    if (currentButtons !== previousButtons) {
      this.gameState.stablePreviousPreviousButtons = this.gameState.stablePreviousButtons;
      this.gameState.stablePreviousButtons = previousButtons;
    }
    // Stable standard dispatches one callback per newly pressed logical side.
    // Switching keyboard/mouse on a side that remains held is not another hit
    // attempt. Raw physical input is retained separately for replay displays.
    this.freshPressCountThisFrame = freshLogicalButtonCount;
    if (frame.rawButtonMask !== undefined) this.gameState.stableRawButtonMask = frame.rawButtonMask;
    this.gameState.pressingSince = newPressingSince(this.gameState.pressingSince, frame.actions, frame.time);

    // Stable can receive both keys in one replay frame. Each press gets one
    // ordered attempt, including misses and notelocked/off-target attempts;
    // none carry into another frame. Relax's automatic attempts happen after
    // the hitobject update, when expired objects no longer block the cursor.
    const hasRelax = this.beatmap.appliedMods.includes("RELAX");
    const hitAttempts = hasRelax ? 0 : this.freshPressCountThisFrame;
    for (let attempt = 0; attempt < hitAttempts; attempt++) {
      trace?.attempt(frame.time, attempt);
      this.handleAliveHitCircles();
      trace?.endAttempt();
    }
    // Exact-time activations happen after input, but their scoring events must
    // join overdue events before the parent-ordered hitobject update.
    this.handleEventsUntilTime(frame.time);
    this.updateSliderBodyTracking(frame.time, frame.position, this.gameState.pressingSince);
    this.updateAliveSpinners(frame.time, frame.position, frame.actions);
    this.handlePendingScoringEvents();
    if (hasRelax) this.handleRelaxHitAttempts();
    this.trace = undefined;
  }

  private handleRelaxHitAttempts(): void {
    // Stable's Relax loop visits active parents in beatmap order. Each parent
    // still needing a circle/head judgement and strictly less than 12ms early
    // dispatches the normal input selector. Recheck eligibility after each
    // callback because it can judge a different parent from the one visited.
    const candidates = [...this.gameState.aliveHitCircleIds].sort(
      (left, right) =>
        (this.scoringObjectOrder.get(left) ?? Infinity) - (this.scoringObjectOrder.get(right) ?? Infinity),
    );
    let automaticAttempt = 0;
    for (const id of candidates) {
      if (!this.gameState.aliveHitCircleIds.has(id)) continue;
      const circle = this.beatmap.getHitCircle(id);
      if (circle.hitTime - this.frame.time >= RELAX_LENIENCY) continue;
      if (this.trace?.extended) this.trace.attempt(this.frame.time, automaticAttempt++, undefined, true);
      this.handleAliveHitCircles();
      if (this.trace?.extended) this.trace.endAttempt();
    }
  }
}

/** Stable tracking combines its button latch with the current slider-ball radius. */
function determineTracking(
  previouslyTracking: boolean,
  slider: Slider,
  ballPosition: Position,
  cursorPosition: Position,
  time: number,
  keyCanTrack: boolean,
  hasRelax?: boolean,
): boolean {
  if (!keyCanTrack && !hasRelax) return false;

  // First condition
  // A due tail can resolve at the first recorded update after the nominal end.
  // The parent-ending event removes the slider after that scoring update.
  if (time < slider.startTime) return false;

  // Second condition
  const followCircleRadius = float32_mul(stableGameplayRadius(slider.radius), previouslyTracking ? 2.4 : 1.0);
  if (!stableWithinTrackingRadius(ballPosition, cursorPosition, followCircleRadius)) return false;

  return true;
}

function sliderVerdictBasedOnCheckpoints(totalCheckpoints: number, hitCheckpoints: number): MainHitObjectVerdict {
  if (hitCheckpoints === totalCheckpoints) return "GREAT";
  if (hitCheckpoints === 0) return "MISS";
  if (hitCheckpoints * 2 >= totalCheckpoints) return "OK";
  return "MEH";
}

// Maybe hitObjects should be flattened out (nested pulled out)
// The mods should be applied to those them ...
const actionsToBooleans = (osuActions: OsuAction[]) => [
  osuActions.includes(OsuAction.leftButton),
  osuActions.includes(OsuAction.rightButton),
];

export const newPressingSince = (pressingSince: PressingSinceTimings, osuActions: OsuAction[], time: number) => {
  const pressed = actionsToBooleans(osuActions);
  const newPressingSince = [...pressingSince];
  for (let i = 0; i < newPressingSince.length; i++) {
    if (pressed[i]) {
      newPressingSince[i] = Math.min(newPressingSince[i], time);
    } else {
      newPressingSince[i] = NOT_PRESSING;
    }
  }
  return newPressingSince;
};
