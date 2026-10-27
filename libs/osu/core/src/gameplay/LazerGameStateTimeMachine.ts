import { Vec2 } from "@osujs/math";
import { Beatmap } from "../beatmap/Beatmap";
import { ReplayFrame } from "../replays/Replay";
import { cloneGameState, defaultGameState, GameState } from "./GameState";
import { GameStateTimeMachine } from "./GameStateTimeMachine";
import { LazerGameStateEvaluator, LazerReplayInputOptions } from "./LazerGameStateEvaluator";
import { isHitCircle } from "../hitobjects/Types";
import { TraceCapture } from "./trace/ReplayTrace";
import { beginCanonicalTrace } from "./trace/ReplayTraceObserver";
import { errorCapabilities } from "./error-analysis/ErrorCapabilities";

function copyFrame(frame: ReplayFrame): ReplayFrame {
  return {
    time: frame.time,
    position: { ...frame.position },
    actions: [...frame.actions],
    rawButtonMask: frame.rawButtonMask,
  };
}

function prepareLazerReplayFrames(frames: readonly ReplayFrame[]): ReplayFrame[] {
  const prepared: ReplayFrame[] = [];
  for (const frame of expandLazerReplayFrames(frames)) {
    const previous = prepared[prepared.length - 1];
    if (!previous || previous.time !== frame.time) {
      prepared.push(frame);
      continue;
    }
    // Native lazer evaluates every input change, then resolves time-driven
    // events using the final state at this timestamp. Keep grouping local to
    // that evaluator; Stable and the displayed evidence use the source frames.
    const sources = previous.sourceFramesAtSameTime ?? [previous];
    sources.push(frame);
    prepared[prepared.length - 1] = { ...copyFrame(frame), sourceFramesAtSameTime: sources };
  }
  return prepared;
}

/** Restores the original ordering of zero-delta replay frames for native lazer input. */
export function expandLazerReplayFrames(frames: readonly ReplayFrame[]): ReplayFrame[] {
  const expanded: ReplayFrame[] = [];
  for (const frame of frames) {
    if (frame.sourceFramesAtSameTime?.length) {
      expanded.push(...frame.sourceFramesAtSameTime.map(copyFrame));
    } else {
      expanded.push(copyFrame(frame));
    }
  }
  return expanded;
}

/** Bound legacy Relax catch-up gaps like lazer's frame stability updates.
 * Store these samples once; arbitrary seek/render times must not generate taps.
 */
function withRelaxCatchUpFrames(frames: ReplayFrame[], beatmap: Beatmap): ReplayFrame[] {
  // Relax cannot target an object outside its lifetime. Avoid synthesising
  // hours of empty lead-in/break/outro input while retaining the original
  // 60Hz grid in every interval that can affect gameplay.
  const ranges: { start: number; end: number }[] = [];
  const lifetimes = beatmap.hitObjects
    .map((object) => ({
      start: object.spawnTime,
      end: (isHitCircle(object) ? object.hitTime : object.endTime) + 400,
    }))
    .sort((left, right) => left.start - right.start);
  for (const lifetime of lifetimes) {
    const previous = ranges[ranges.length - 1];
    if (previous && lifetime.start <= previous.end) previous.end = Math.max(previous.end, lifetime.end);
    else ranges.push(lifetime);
  }
  const expanded: ReplayFrame[] = [];
  const step = 1000 / 60;
  let rangeIndex = 0;
  let generated = 0;
  for (const next of frames) {
    const previous = expanded[expanded.length - 1];
    if (previous && next.time - previous.time > 20) {
      const previousTime = previous.time;
      while (rangeIndex < ranges.length && ranges[rangeIndex].end < previousTime) rangeIndex++;
      let time = previousTime + step;
      for (let index = rangeIndex; index < ranges.length && ranges[index].start < next.time; index++) {
        const range = ranges[index];
        if (time < range.start) time += Math.ceil((range.start - time) / step) * step;
        const end = Math.min(range.end, next.time);
        // Explicit resource/progress guards for pathological map/replay times.
        // The budget allows over four hours of continuous 60Hz catch-up.
        if (
          time <= range.end &&
          time < next.time &&
          (!(time > previousTime) || time + step === time || generated + Math.ceil((end - time) / step) + 1 > 1_000_000)
        ) {
          throw new Error("Relax replay catch-up work limit exceeded");
        }
        for (; time <= range.end && next.time - time > 0; time += step) {
          expanded.push({
            time,
            position: Vec2.interpolate(
              previous.position,
              next.position,
              (time - previousTime) / (next.time - previousTime),
            ),
            actions: [],
          });
          generated++;
          if (next.time - time <= 20) break;
        }
        if (next.time - time <= 20) break;
      }
    }
    expanded.push(next);
  }
  return expanded;
}

/**
 * Seekable native-lazer simulation. Stable deliberately keeps using
 * {@link BucketedGameStateTimeMachine}; neither evaluator shares mutable state.
 */
export class LazerGameStateTimeMachine implements GameStateTimeMachine {
  private currentIndex = 0;
  private replayTraversalStarted = false;
  private currentGameState: GameState;
  private storedGameState: GameState[] = [];
  private readonly bucketSize: number;
  private frames: ReplayFrame[];
  private readonly evaluator: LazerGameStateEvaluator;

  constructor(
    initialKnownFrames: readonly ReplayFrame[],
    private readonly beatmap: Beatmap,
    bucketSize?: number,
    private readonly inputOptions: LazerReplayInputOptions = {},
    private capture?: TraceCapture,
  ) {
    let replayFrames = prepareLazerReplayFrames(initialKnownFrames);
    if (
      inputOptions.legacyReplay &&
      (beatmap.appliedMods.includes("RELAX") || beatmap.lazerMods.some((mod) => mod.acronym === "RX"))
    ) {
      replayFrames = withRelaxCatchUpFrames(replayFrames, beatmap);
    }

    // Do not continue simulation beyond the recorded replay. A failed replay
    // ends at its final source frame, and Stable consequently leaves later map
    // objects unjudged rather than fabricating misses for them.
    this.frames = [{ time: -727_727, position: Vec2.Zero, actions: [] }, ...replayFrames];
    this.bucketSize = bucketSize ?? Math.max(1, Math.ceil(Math.sqrt(this.frames.length)));
    this.storedGameState[0] = defaultGameState();
    this.currentGameState = cloneGameState(this.storedGameState[0]);
    this.evaluator = new LazerGameStateEvaluator(beatmap, inputOptions);
  }

  /** Independent traversal cursor over the same frames and immutable bucket snapshots. */
  fork(): LazerGameStateTimeMachine {
    const fork = new LazerGameStateTimeMachine([], this.beatmap, this.bucketSize, this.inputOptions);
    fork.frames = this.frames;
    fork.storedGameState = this.storedGameState.slice();
    fork.currentIndex = this.currentIndex;
    fork.currentGameState = cloneGameState(this.currentGameState);
    return fork;
  }

  private highestCachedIndexAtOrBefore(time: number): number {
    let result = 0;
    for (let index = 0; index < this.frames.length && this.frames[index].time <= time; index += this.bucketSize) {
      if (this.storedGameState[index]) result = index;
    }
    return result;
  }

  /** Uses the same prepared same-time groups/evaluator as the synchronous source pass. */
  async captureReplayAsync(checkpoint: () => Promise<void>): Promise<GameState> {
    if (!this.capture || this.currentIndex !== 0 || this.replayTraversalStarted) throw new Error("Requires a fresh canonical capture");
    return this.evaluateReplayAsync(checkpoint);
  }

  /** Keeps recorded endpoints and prepared groups; no trace work is needed for numerical metrics. */
  async evaluateReplayAsync(checkpoint: () => Promise<void>): Promise<GameState> {
    if (this.currentIndex !== 0 || this.replayTraversalStarted) throw new Error("Requires a fresh source traversal");
    this.replayTraversalStarted = true;
    const capture = this.capture; this.capture = undefined;
    const trace = capture ? beginCanonicalTrace(
      capture,
      Infinity,
      this.frames[this.frames.length - 1].time,
      capture.observationVersion === 2
        ? errorCapabilities(this.beatmap, "lazer").scoring === "supported"
        : this.beatmap.appliedMods.length === 0 &&
            this.beatmap.lazerMods.length === 0 &&
            !this.beatmap.lazerModSettings.classic,
    ) : undefined;
    await checkpoint();
    while (this.currentIndex + 1 < this.frames.length) {
      this.evaluator.evaluate(this.currentGameState, this.frames[this.currentIndex + 1], false, trace);
      this.currentIndex++;
      if (this.currentIndex % 256 === 0) await checkpoint();
    }
    await checkpoint();
    trace?.finish();
    return this.currentGameState;
  }

  private interpolatedFrameAt(time: number): ReplayFrame {
    const previous = this.frames[this.currentIndex];
    const next = this.frames[Math.min(this.currentIndex + 1, this.frames.length - 1)];
    if (previous.time === next.time) {
      return { time, position: { ...previous.position }, actions: [...previous.actions] };
    }
    const progress = Math.max(0, Math.min(1, (time - previous.time) / (next.time - previous.time)));
    return {
      time,
      position: Vec2.interpolate(previous.position, next.position, progress),
      actions: [...previous.actions],
      rawButtonMask: previous.rawButtonMask,
    };
  }

  gameStateAt(time: number): GameState {
    const trace = this.capture
      ? beginCanonicalTrace(
          this.capture,
          time,
          this.frames[this.frames.length - 1].time,
          this.capture?.observationVersion === 2
            ? errorCapabilities(this.beatmap, "lazer").scoring === "supported"
            : this.beatmap.appliedMods.length === 0 &&
                this.beatmap.lazerMods.length === 0 &&
                !this.beatmap.lazerModSettings.classic,
        )
      : undefined;
    this.capture = undefined;
    const highestCachedIndex = this.highestCachedIndexAtOrBefore(time);
    if (time < this.frames[this.currentIndex].time || this.currentIndex < highestCachedIndex) {
      this.currentIndex = highestCachedIndex;
      this.currentGameState = cloneGameState(this.storedGameState[this.currentIndex]);
    }

    while (this.currentIndex + 1 < this.frames.length) {
      const nextFrame = this.frames[this.currentIndex + 1];
      if (nextFrame.time > time) break;
      this.evaluator.evaluate(this.currentGameState, nextFrame, false, trace);
      this.currentIndex++;
      if (this.currentIndex % this.bucketSize === 0) {
        this.storedGameState[this.currentIndex] = cloneGameState(this.currentGameState);
      }
    }

    trace?.finish();
    if (time > this.currentGameState.currentTime && this.currentIndex + 1 < this.frames.length) {
      const transientState = cloneGameState(this.currentGameState);
      this.evaluator.evaluate(transientState, this.interpolatedFrameAt(time), true);
      return transientState;
    }

    return this.currentGameState;
  }
}
