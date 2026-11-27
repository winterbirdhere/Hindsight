import { Position } from "@osujs/math";
import { Spinner } from "../hitobjects/Spinner";
import { SpinnerState } from "./GameState";
import { spinnerCursorAngle } from "./SpinnerTracking";
import { MainHitObjectVerdict } from "./Verdicts";

const referenceFrameDuration = 1000 / 60;

/** Stable selects its older spinner rules by either recording date or client version. */
export function usesLegacyStableSpinnerRules(gameVersion?: number, timestamp?: number): boolean {
  return (gameVersion ?? Infinity) < 20190510 || (timestamp ?? Infinity) < Date.UTC(2019, 4, 10);
}

/** Stable counts half turns and truncates its float-duration requirement. */
export function stableRequiredSpinnerHalfTurns(spinner: Spinner, overallDifficulty: number): number {
  const halfTurnsPerSecond =
    overallDifficulty > 5 ? 5 + ((overallDifficulty - 5) * 2.5) / 5 : 5 - ((5 - overallDifficulty) * 2) / 5;
  // The x86 Stable JIT retains precision through /1000f before promotion to
  // double. A second float conversion turns 1400ms at OD5 into six, not seven.
  const secondsDuration = Math.fround(spinner.duration) / 1000;
  return Math.trunc(secondsDuration * halfTurnsPerSecond);
}

/**
 * Stable's spinner: fresh input sets target velocity, then the
 * hitobject update accelerates towards it and accumulates capped half turns.
 * Clock rate converts elapsed durations, rather than scaling cursor angles.
 */
export function updateStableSpinnerInput(
  previous: SpinnerState,
  spinner: Spinner,
  position: Position,
  held: boolean,
  gameClockRate: number,
  overallDifficulty: number,
  time: number,
  relax = false,
  legacy = false,
  previousInputTime = previous.stableLastSampleTime,
): SpinnerState {
  // InputManager's preceding fresh frame is global, including frames before
  // this spinner became active. Its initial/nonpositive-time fallback is 60 Hz.
  const elapsed =
    previousInputTime !== undefined && previousInputTime > 0 ? time - previousInputTime : referenceFrameDuration;
  if (elapsed < 0) return previous;
  const rate = Math.abs(gameClockRate);
  const required = stableRequiredSpinnerHalfTurns(spinner, overallDifficulty);
  const angle = Math.atan2(Math.fround(Math.fround(position.y) - 192), Math.fround(Math.fround(position.x) - 256));
  let angleDelta = angle - (previous.stableLastSampleAngle ?? (legacy ? 0 : angle));
  if (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;
  else if (angleDelta > Math.PI) angleDelta -= 2 * Math.PI;

  const decay = Math.pow(0.999, elapsed);
  const averageDuration =
    decay * (previous.stableAverageSampleDuration ?? referenceFrameDuration) + (1 - decay) * elapsed;
  let zeroDeltaSamples = previous.stableZeroDeltaSamples ?? 0;
  let targetVelocity = previous.stableTargetVelocity ?? 0;
  if (angleDelta === 0) {
    targetVelocity = zeroDeltaSamples++ < 1 ? targetVelocity / 3 : 0;
  } else {
    zeroDeltaSamples = 0;
    if (!relax && (!held || time < spinner.startTime || time > spinner.endTime)) angleDelta = 0;
    if (Math.abs(angleDelta) >= Math.PI) targetVelocity = 0;
    else if (averageDuration / rate > 17.333332697550457) {
      targetVelocity = elapsed > 0 ? angleDelta / (elapsed / rate) : 0;
    } else targetVelocity = angleDelta / referenceFrameDuration;
  }

  // Input observes the boundary reached by the preceding hitobject update.
  let scoredHalfTurns = previous.stableScoredHalfTurns ?? 0;
  const halfTurns = previous.stableHalfTurns ?? 0;
  let lastBoundary = previous.stableLastHalfTurnBoundary ?? 0;
  let lastSpinCompletionTime = previous.lastSpinCompletionTime;
  if (Math.trunc(halfTurns) !== lastBoundary) {
    scoredHalfTurns++;
    lastBoundary = Math.trunc(halfTurns);
    const bonusHalfTurns = scoredHalfTurns - required - 3;
    if ((bonusHalfTurns > 0 && bonusHalfTurns % 2 === 0) || (bonusHalfTurns <= 0 && scoredHalfTurns % 2 === 0)) {
      lastSpinCompletionTime = time;
    }
  }

  return {
    ...previous,
    currentAngle: spinnerCursorAngle(position),
    completedSpins: Math.floor(scoredHalfTurns / 2),
    lastSpinCompletionTime,
    completionTime: previous.completionTime ?? (scoredHalfTurns >= required + (legacy ? 1 : 0) ? time : undefined),
    stableLastSampleTime: time,
    stableLastSampleAngle: angle,
    stableAverageSampleDuration: averageDuration,
    stableZeroDeltaSamples: zeroDeltaSamples,
    stableTargetVelocity: targetVelocity,
    stableHalfTurns: halfTurns,
    stableScoredHalfTurns: scoredHalfTurns,
    stableLastHalfTurnBoundary: lastBoundary,
    stableRequiredHalfTurns: required,
    stableUsesLegacyRules: legacy,
  };
}

/** Advance physics without inventing cursor input or scoring a fresh boundary. */
export function advanceStableSpinnerBody(
  previous: SpinnerState,
  spinner: Spinner,
  time: number,
  elapsed: number,
  gameClockRate: number,
  relax = false,
): SpinnerState {
  const rate = Math.abs(gameClockRate);
  const targetVelocity = previous.stableTargetVelocity ?? 0;
  let halfTurns = previous.stableHalfTurns ?? 0;
  let velocity = previous.stableAngularVelocity ?? 0;
  let signedRotation = previous.totalAccumulatedRotation ?? 0;
  const active = time > spinner.startTime && time < spinner.endTime;
  if (active && elapsed > 0) {
    const acceleration = 0.00008 + Math.max(0, (5000 - spinner.duration) / 1000 / 2000);
    let step = (acceleration * elapsed) / rate;
    if (relax && Math.sign(targetVelocity - velocity) !== Math.sign(velocity) && velocity !== 0) step /= 4;
    velocity +=
      targetVelocity > velocity
        ? Math.min(targetVelocity - velocity, step)
        : Math.max(targetVelocity - velocity, -step);
    velocity = Math.max(-0.05, Math.min(velocity, 0.05));
    const rotation = Math.fround(velocity * elapsed);
    halfTurns = Math.fround(halfTurns + Math.min(1, Math.abs(Math.fround(rotation / Math.PI))));
    signedRotation = Math.fround(signedRotation + Math.fround((rotation * 180) / Math.PI));
  }

  return {
    ...previous,
    totalSpunAngle: Math.fround(halfTurns * 180),
    totalAccumulatedRotation: signedRotation,
    stableAngularVelocity: velocity,
    stableHalfTurns: halfTurns,
    stableLastBodyTime: time,
    tracking: active && velocity !== 0,
  };
}

/** Project body physics on the map clock without consuming a replay input. */
export function advanceStableSpinnerToTime(
  previous: SpinnerState,
  spinner: Spinner,
  time: number,
  gameClockRate: number,
  relax = false,
): SpinnerState {
  let bodyTime = previous.stableLastBodyTime ?? previous.stableLastSampleTime ?? time;
  if (time <= bodyTime) return previous;
  let state = previous;
  const through = Math.min(Math.floor(time), Math.ceil(spinner.endTime) - 1);
  for (let tick = Math.floor(Math.max(bodyTime, spinner.startTime)) + 1; tick <= through; tick++) {
    if (!(state.stableTargetVelocity || state.stableAngularVelocity)) {
      state = { ...state, stableLastBodyTime: through };
      bodyTime = through;
      break;
    }
    state = advanceStableSpinnerBody(state, spinner, tick, tick - bodyTime, gameClockRate, relax);
    bodyTime = tick;
  }
  if (time > bodyTime && time > spinner.startTime && time < spinner.endTime) {
    state = advanceStableSpinnerBody(state, spinner, time, time - bodyTime, gameClockRate, relax);
  }
  return state;
}

/**
 * Replay files omit the outer update clock. Reconstruct physics on the integer
 * map-millisecond grid, independently of cursor samples. This deterministic
 * policy approximates playback scheduling; it does not recover historical FPS.
 */
export function updateStableSpinnerRotation(
  previous: SpinnerState,
  spinner: Spinner,
  position: Position,
  held: boolean,
  gameClockRate: number,
  overallDifficulty: number,
  time: number,
  relax = false,
  legacy = false,
  previousInputTime = previous.stableLastSampleTime,
): SpinnerState {
  const last = previous.stableLastBodyTime ?? previousInputTime ?? time;
  if (time < last) return previous;
  const through = Math.min(Math.ceil(time) - 1, Math.ceil(spinner.endTime) - 1);
  let state = advanceStableSpinnerToTime(
    { ...previous, stableLastBodyTime: last },
    spinner,
    through,
    gameClockRate,
    relax,
  );
  const bodyTime = state.stableLastBodyTime ?? last;
  state = updateStableSpinnerInput(
    state,
    spinner,
    position,
    held,
    gameClockRate,
    overallDifficulty,
    time,
    relax,
    legacy,
    previousInputTime,
  );
  return advanceStableSpinnerBody(state, spinner, time, time - bodyTime, gameClockRate, relax);
}

/** Stable's version-specific grading thresholds use scored integer half turns. */
export function stableSpinnerVerdict(state: SpinnerState): MainHitObjectVerdict {
  const required = state.stableRequiredHalfTurns ?? 0;
  const completed = state.stableScoredHalfTurns ?? 0;
  if (state.stableUsesLegacyRules) {
    if (completed < required) return "MISS";
    if (completed > required + 1) return "GREAT";
    return completed > required ? "OK" : "MEH";
  }
  if (required === 0) return "GREAT";
  if (completed < Math.trunc(required / 4)) return "MISS";
  if (completed > required) return "GREAT";
  return completed > required - 2 ? "OK" : "MEH";
}
