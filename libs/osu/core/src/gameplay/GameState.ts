import { Position, Vec2 } from "@osujs/math";
import { OsuAction } from "../replays/Replay";
import { MainHitObjectVerdict } from "./Verdicts";

export const NOT_PRESSING = +727727727;

export type PressingSinceTimings = number[];

const HitCircleMissReasons = [
  // When the time has expired and the circle got force killed.
  "TIME_EXPIRED",
  // There is no HIT_TOO_LATE because TIME_EXPIRED would occur earlier.
  "HIT_TOO_EARLY",
  // A native-lazer input produced Miss but source evidence is not specific
  // enough to label it early or late.
  "INPUT_WINDOW_MISS",
  // Native lazer's ordered-hit policy force-missed this earlier circle when a later circle resolved first.
  "ORDERED_POLICY_FORCE_MISS",
  // If the user had time to press the hitCircle until time 300, but the slider is so short that it ends at 200,
  // then the user actually has a reduced hit window for hitting it.
  "SLIDER_FINISHED_FASTER",
] as const;

export type HitCircleMissReason = typeof HitCircleMissReasons[number];

export type HitCircleVerdict = {
  // Is the only that has a judgement time not being equal the hit object hitTime/startTime/endTime.
  judgementTime: number;
  /** The logical action which successfully hit this circle/head, when known. */
  hitAction?: OsuAction;
} & ({ type: "GREAT" | "MEH" | "OK" } | { type: "MISS"; missReason: HitCircleMissReason });

export type CheckPointState = {
  hit: boolean;
  /** Actual resolution time: a recorded update in Stable, possibly delayed by a late head in Lazer. */
  judgementTime?: number;
};

export type SliderBodyState = {
  isTracking: boolean;
  /** Stable's logical button latch, including unsuccessful head attempts. */
  stableButtonLatch?: number;
  /** Stable's latest tracking acquisition; overdue checkpoints cannot use a later acquisition. */
  trackingSince?: number;
  /** Native lazer keeps the exact logical action used to hit the head. */
  headHitAction?: OsuAction;
  /** Once set, either logical action may track after this instant. */
  timeToAcceptAnyKeyAfter?: number;
  /** Input state observed during the preceding tracking update. */
  lastPressedActions?: OsuAction[];
};

export type SliderTailState = {
  hit: boolean;
  judgementTime: number;
};

export type SpinnerVerdict = {
  type: MainHitObjectVerdict;
  judgementTime: number;
};

export type SpinnerState = {
  /** Ruleset-specific scoring rotation, in degrees. */
  totalSpunAngle: number;
  /** Current cursor angle around the spinner centre. */
  currentAngle: number;
  /** Signed accumulated rotation before anti-reversal scoring is applied. */
  totalAccumulatedRotation?: number;
  totalAccumulatedRotationAtLastCompletion?: number;
  currentSpinMaxRotation?: number;
  completedSpins?: number;
  /** Replay time of the most recent completed spin, for seek-safe bonus effects. */
  lastSpinCompletionTime?: number;
  lastCursorAngle?: number;
  tracking?: boolean;
  completionTime?: number;
  /** Stable's velocity/half-turn model; all fields travel with seek snapshots. */
  stableLastSampleTime?: number;
  stableLastBodyTime?: number;
  stableLastSampleAngle?: number;
  stableAverageSampleDuration?: number;
  stableZeroDeltaSamples?: number;
  stableTargetVelocity?: number;
  stableAngularVelocity?: number;
  stableHalfTurns?: number;
  stableScoredHalfTurns?: number;
  stableLastHalfTurnBoundary?: number;
  stableRequiredHalfTurns?: number;
  stableUsesLegacyRules?: boolean;
};

/**
 * Stable-rules provenance for a fresh press which would have successfully hit
 * a later circle/head, but was rejected because an earlier object still held
 * notelock. This is evaluator-owned evidence, not a frontend timing guess.
 */
export type StableNotelockEvidence = {
  targetHitObjectId: string;
  blockerHitObjectId: string;
  pressTime: number;
  cursorDistance: number;
  objectRadius: number;
  wouldHaveHit: Exclude<MainHitObjectVerdict, "MISS">;
};

/** Native-lazer provenance for the same causal blocked-valid-press condition. */
export type LazerNotelockEvidence = StableNotelockEvidence;

export type LazerScoringResult =
  | MainHitObjectVerdict
  | "LARGE_TICK_HIT"
  | "LARGE_TICK_MISS"
  | "SMALL_TICK_HIT"
  | "SMALL_TICK_MISS"
  | "SLIDER_TAIL_HIT"
  | "IGNORE_MISS";

export type LazerJudgementKind =
  | "CIRCLE"
  | "SLIDER"
  | "SLIDER_HEAD"
  | "SLIDER_TICK"
  | "SLIDER_REPEAT"
  | "SLIDER_TAIL"
  | "SPINNER";

/** Ordered native-lazer scoring result used by the independent HUD evaluator. */
export type LazerJudgement = {
  id: string;
  hitObjectId: string;
  kind: LazerJudgementKind;
  result: LazerScoringResult;
  objectTime: number;
  judgementTime: number;
};

export interface GameState {
  // currentTime might be not really needed, but serves as an "id"
  currentTime: number;
  cursorPosition: Position;

  // Keeps track of where we are in the events list (as an optimization).
  eventIndex: number;

  // The verdicts are a summary of how well these objects were played
  hitCircleVerdict: Record<string, HitCircleVerdict>;
  checkPointVerdict: Record<string, CheckPointState>;
  sliderTailVerdict: Record<string, SliderTailState>;
  sliderVerdict: Record<string, MainHitObjectVerdict>;
  /** Actual recorded update that resolved each Stable parent slider. */
  sliderJudgementTime: Record<string, number>;
  spinnerVerdict: Record<string, SpinnerVerdict>;

  /** Native lazer scores nested components independently from slider parents. */
  lazerJudgements: LazerJudgement[];

  /** First proven Stable notelock press for each still-missed circle/head. */
  stableNotelockEvidence: Record<string, StableNotelockEvidence>;

  /** First proven native-lazer blocked valid press for each unresolved circle/head. */
  lazerNotelockEvidence: Record<string, LazerNotelockEvidence>;

  /** Most recent rejected notelock press for each circle/head. */
  lastNotelockShakeTime: Record<string, number>;

  spinnerState: Map<string, SpinnerState>;
  sliderBodyState: Map<string, SliderBodyState>;

  // Stores the ids of the objects that have been judged in the order of judgement.
  // This can be used to easily derive the combo,maxCombo,accuracy,number of 300/100/50/misses, score
  // This is only useful for knowing the order
  judgedObjects: Array<string>;

  // Rest are used for optimizations
  latestHitObjectIndex: number;
  /** First parent not known to be judged; stored with snapshots for seek/fork safety. */
  stableNotelockStartIndex?: number;
  aliveHitCircleIds: Set<string>;
  aliveSliderIds: Set<string>;
  aliveSpinnerIds: Set<string>;

  pressingSince: PressingSinceTimings;

  /** Last raw gameplay-button mask observed by the Stable evaluator. */
  stableRawButtonMask: number;
  /** Prior distinct logical button states used by Stable's slider latch. */
  stablePreviousButtons: number;
  stablePreviousPreviousButtons: number;
  /** Legacy Relax input state belongs to snapshots, so seeks cannot retime taps. */
  lazerRelaxLastAction?: OsuAction;
  lazerRelaxLastStateChangeTime?: number;
}

export const defaultGameState = (): GameState => ({
  eventIndex: 0,
  currentTime: 0,
  cursorPosition: Vec2.Zero,
  hitCircleVerdict: {},
  sliderBodyState: new Map<string, SliderBodyState>(),
  checkPointVerdict: {},
  sliderTailVerdict: {},
  spinnerState: new Map<string, SpinnerState>(),
  sliderVerdict: {},
  sliderJudgementTime: {},
  spinnerVerdict: {},
  lazerJudgements: [],
  stableNotelockEvidence: {},
  lazerNotelockEvidence: {},
  lastNotelockShakeTime: {},
  // Rest are used for optimizations
  latestHitObjectIndex: 0 as number,
  aliveHitCircleIds: new Set<string>(),
  aliveSliderIds: new Set<string>(),
  aliveSpinnerIds: new Set<string>(),
  // Also used as an optimization
  judgedObjects: [],
  pressingSince: [NOT_PRESSING, NOT_PRESSING],
  stableRawButtonMask: 0,
  stablePreviousButtons: 0,
  stablePreviousPreviousButtons: 0,
});

function cloneRecordValues<T extends object>(values: Record<string, T>): Record<string, T> {
  return Object.keys(values).reduce<Record<string, T>>((cloned, id) => {
    cloned[id] = { ...values[id] };
    return cloned;
  }, {});
}

export function cloneGameState(replayState: GameState): GameState {
  const {
    aliveHitCircleIds,
    aliveSliderIds,
    aliveSpinnerIds,
    spinnerState,
    sliderBodyState,
    checkPointVerdict,
    sliderTailVerdict,
    hitCircleVerdict,
    sliderVerdict,
    sliderJudgementTime,
    spinnerVerdict,
    lazerJudgements,
    stableNotelockEvidence,
    lazerNotelockEvidence,
    lastNotelockShakeTime,
    eventIndex,
    currentTime,
    cursorPosition,
    latestHitObjectIndex,
    stableNotelockStartIndex,
    pressingSince,
    stableRawButtonMask,
    stablePreviousButtons,
    stablePreviousPreviousButtons,
    lazerRelaxLastAction,
    lazerRelaxLastStateChangeTime,
    judgedObjects,
  } = replayState;
  return {
    eventIndex: eventIndex,
    aliveHitCircleIds: new Set<string>(aliveHitCircleIds),
    aliveSliderIds: new Set<string>(aliveSliderIds),
    aliveSpinnerIds: new Set<string>(aliveSpinnerIds),
    hitCircleVerdict: cloneRecordValues(hitCircleVerdict),
    sliderVerdict: { ...sliderVerdict },
    sliderJudgementTime: { ...sliderJudgementTime },
    checkPointVerdict: cloneRecordValues(checkPointVerdict),
    sliderTailVerdict: cloneRecordValues(sliderTailVerdict),
    spinnerVerdict: cloneRecordValues(spinnerVerdict),
    lazerJudgements: lazerJudgements.map((judgement) => ({ ...judgement })),
    stableNotelockEvidence: Object.keys(stableNotelockEvidence).reduce<Record<string, StableNotelockEvidence>>(
      (evidence, id) => {
        evidence[id] = { ...stableNotelockEvidence[id] };
        return evidence;
      },
      {},
    ),
    lazerNotelockEvidence: cloneRecordValues(lazerNotelockEvidence),
    lastNotelockShakeTime: { ...lastNotelockShakeTime },
    currentTime: currentTime,
    cursorPosition: { ...cursorPosition },
    latestHitObjectIndex: latestHitObjectIndex,
    stableNotelockStartIndex,
    judgedObjects: [...judgedObjects],
    sliderBodyState: new Map(
      Array.from(sliderBodyState, ([id, state]) => [
        id,
        { ...state, lastPressedActions: state.lastPressedActions ? [...state.lastPressedActions] : undefined },
      ]),
    ),
    spinnerState: new Map(Array.from(spinnerState, ([id, state]) => [id, { ...state }])),
    pressingSince: pressingSince.slice(),
    stableRawButtonMask,
    stablePreviousButtons,
    stablePreviousPreviousButtons,
    lazerRelaxLastAction,
    lazerRelaxLastStateChangeTime,
  };
}
