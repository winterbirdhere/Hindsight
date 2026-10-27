import { Beatmap, BucketedGameStateTimeMachine, GameState, LazerGameStateTimeMachine, ReplayAnalysisRuleset, ReplayFrame, ScoringDomain } from "@osujs/core";
import { isLazerReplay, OsuReplay } from "../../../model/OsuReplay";
import { findIndexInReplayAtTime, interpolateReplayPosition } from "../../../utils/replay";
import { performanceJudgements, PerformanceMode } from "../../analysis/performance/replay-performance-input";

function replayHeaderCounts(replay: OsuReplay): number[] | undefined {
  const statistics = replay.statistics;
  if (!statistics || (replay.gameMode ?? 0) !== 0) return undefined;
  const counts = [statistics.count300, statistics.count100, statistics.count50, statistics.countMiss];
  return counts.every((count) => Number.isSafeInteger(count) && count >= 0) ? counts : undefined;
}

function authoritativeSourceCounts(replay: OsuReplay): number[] | undefined {
  if (!isLazerReplay(replay)) return replayHeaderCounts(replay);
  const statistics = replay.lazerScoreMetadata?.statistics;
  if (!statistics) return replayHeaderCounts(replay);
  const counts = [statistics.great ?? 0, statistics.ok ?? 0, statistics.meh ?? 0, statistics.miss ?? 0];
  return counts.every((count) => Number.isSafeInteger(count) && count >= 0) ? counts : replayHeaderCounts(replay);
}

function replayUsesNoFail(replay: OsuReplay): boolean {
  return (
    replay.mods.includes("NO_FAIL") || replay.lazerMods?.some((mod) => mod.acronym.toUpperCase() === "NF") === true
  );
}

function terminalHealthFailureTime(replay: OsuReplay, replayEndTime: number): number | undefined {
  if (replayUsesNoFail(replay)) return undefined;
  const points = [...(replay.lifeBar ?? [])]
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.health) && point.time <= replayEndTime)
    .sort((left, right) => left.time - right.time);
  let lastPositiveIndex = -1;
  for (let index = 0; index < points.length; index++) {
    if (points[index].health > 0) lastPositiveIndex = index;
  }
  for (let index = lastPositiveIndex + 1; index < points.length; index++) {
    if (points[index].health <= 0) return Math.max(0, points[index].time);
  }
  return undefined;
}

function sourcePerformanceMode(beatmap: Beatmap, replay: OsuReplay): PerformanceMode {
  if (!isLazerReplay(replay)) return "stable";
  return beatmap.lazerModSettings.classic ? "lazer-classic" : "lazer";
}

function needsSourceCountFailureInference(beatmap: Beatmap, replay: OsuReplay): boolean {
  if (replayUsesNoFail(replay)) return false;
  const expectedCounts = authoritativeSourceCounts(replay);
  if (!expectedCounts) return false;
  const expectedTotal = expectedCounts.reduce((sum, count) => sum + count, 0);
  return replay.lazerScoreMetadata?.rank?.toUpperCase() === "F" || expectedTotal < beatmap.hitObjects.length;
}

function inferredFailureTimeFromSourceCounts(
  beatmap: Beatmap,
  replay: OsuReplay,
  sourceState: GameState,
  replayEndTime: number,
): number | undefined {
  if (replayUsesNoFail(replay)) return undefined;
  const expectedCounts = authoritativeSourceCounts(replay);
  if (!expectedCounts) return undefined;
  const expectedTotal = expectedCounts.reduce((sum, count) => sum + count, 0);
  if (!needsSourceCountFailureInference(beatmap, replay)) return undefined;

  const basicResults = new Set(["great", "ok", "meh", "miss"]);
  const judgements = performanceJudgements(beatmap, sourceState, sourcePerformanceMode(beatmap, replay))
    .filter((judgement) => judgement.result !== undefined && basicResults.has(judgement.result))
    .sort((left, right) => left.time - right.time || left.objectIndex - right.objectIndex);

  // Counts prove that reconstruction continued past the source score. Stop at
  // the last authoritative top-level judgement. Life-bar data, when present,
  // is preferred because it can also retain legitimate partial-slider events.
  if (judgements.length <= expectedTotal) return undefined;
  if (expectedTotal === 0) return Math.max(0, Math.min(replayEndTime, judgements[0].time - 0.001));
  return Math.max(0, Math.min(replayEndTime, judgements[expectedTotal - 1].time));
}

function replayFramesThrough(frames: readonly ReplayFrame[], endTime: number): ReplayFrame[] {
  if (frames.length === 0) return [];
  const endIndex = findIndexInReplayAtTime(frames, endTime);
  const result = frames.slice(0, endIndex + 1);
  if (result[result.length - 1]?.time === endTime) return result;

  const previous = frames[Math.max(0, endIndex)];
  const next = frames[Math.min(frames.length - 1, endIndex + 1)];
  result.push({
    time: endTime,
    position: interpolateReplayPosition(previous, next, endTime),
    actions: [...previous.actions],
    rawButtonMask: previous.rawButtonMask,
  });
  return result;
}

export interface PreparedScoringReplay {
  frames: ReplayFrame[];
  endTime: number;
  domain: ScoringDomain;
}

export interface AsyncPreparedScoringReplay extends PreparedScoringReplay {
  /** Valid only when inference traversed the exact, unchanged scoring frames. */
  reusableSourceState?: { profile: ReplayAnalysisRuleset; state: GameState };
}

function sourceMachine(beatmap: Beatmap, replay: OsuReplay) {
  return isLazerReplay(replay)
    ? new LazerGameStateTimeMachine(replay.frames, beatmap, undefined, { legacyReplay: !isLazerReplay(replay) })
    : new BucketedGameStateTimeMachine(replay.frames, beatmap, {
        hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE",
        replayGameVersion: replay.gameVersion, replayTimestamp: replay.timestamp,
      });
}

function initialEndpoint(replay: OsuReplay) {
  const replayEndTime = replay.frames[replay.frames.length - 1]?.time ?? 0;
  const healthFailureTime = terminalHealthFailureTime(replay, replayEndTime);
  return { replayEndTime, healthFailureTime, endTime: healthFailureTime ?? replayEndTime,
    endpointBasis: (healthFailureTime === undefined ? "recorded-end" : "health-derived") as ScoringDomain["endpointBasis"] };
}

/** Uses one scoring endpoint for primary playback and comparison reconstruction. */
export function scoringReplayFrames(
  beatmap: Beatmap,
  replay: OsuReplay,
): PreparedScoringReplay {
  const { replayEndTime, healthFailureTime, ...endpoint } = initialEndpoint(replay);

  // Source object coverage is a fallback only when failed-play timing is not
  // recorded. It excludes fail-animation frames without replacing any grade.
  if (healthFailureTime === undefined && needsSourceCountFailureInference(beatmap, replay)) {
    try {
      const sourceState = sourceMachine(beatmap, replay).gameStateAt(1e9);
      const inferred = inferredFailureTimeFromSourceCounts(beatmap, replay, sourceState, replayEndTime);
      if (inferred !== undefined) {
        endpoint.endTime = inferred;
        endpoint.endpointBasis = "aggregate-inferred";
      }
    } catch {
      // The normal evaluator owns unsupported-mod reporting. If endpoint
      // inference fails, retain the recorded replay endpoint.
    }
  }

  return finalizeScoringFrames(replay, replayEndTime, endpoint.endTime, endpoint.endpointBasis);
}

/** Endpoint inference for an independently owned background traversal. No viewer or trace work. */
export async function scoringReplayFramesAsync(
  beatmap: Beatmap,
  replay: OsuReplay,
  checkpoint: () => Promise<void>,
): Promise<AsyncPreparedScoringReplay> {
  await checkpoint();
  const { replayEndTime, healthFailureTime, ...endpoint } = initialEndpoint(replay);
  let sourceState: GameState | undefined;
  if (healthFailureTime === undefined && needsSourceCountFailureInference(beatmap, replay)) {
    let checkpointFailed = false;
    let checkpointFailure: unknown;
    try {
      sourceState = await sourceMachine(beatmap, replay).evaluateReplayAsync(async () => {
        try { await checkpoint(); }
        catch (error) { checkpointFailed = true; checkpointFailure = error; throw error; }
      });
      const inferred = inferredFailureTimeFromSourceCounts(beatmap, replay, sourceState, replayEndTime);
      if (inferred !== undefined) {
        endpoint.endTime = inferred;
        endpoint.endpointBasis = "aggregate-inferred";
      }
    } catch {
      // Preserve the existing optional-inference fallback, but never swallow owner cancellation.
      if (checkpointFailed) throw checkpointFailure;
      sourceState = undefined;
    }
  }
  await checkpoint();
  const prepared = finalizeScoringFrames(replay, replayEndTime, endpoint.endTime, endpoint.endpointBasis);
  await checkpoint();
  return { ...prepared, ...(sourceState && prepared.frames === replay.frames
    ? { reusableSourceState: { profile: isLazerReplay(replay) ? "lazer" as const : "stable" as const, state: sourceState } }
    : {}) };
}

function finalizeScoringFrames(replay: OsuReplay, replayEndTime: number, endTime: number,
  endpointBasis: ScoringDomain["endpointBasis"]): PreparedScoringReplay {
  const frames = endTime === replayEndTime ? replay.frames : replayFramesThrough(replay.frames, endTime);
  const synthesizedEndpoint = frames.length > 0 && frames[frames.length - 1] !== replay.frames[frames.length - 1];
  const diagnostics = replay.parseDiagnostics;
  let endpointInputBracket: ScoringDomain["endpointInputBracket"];
  const previousIndex = frames.length - 2;
  const previous = replay.frames[previousIndex],
    next = replay.frames[previousIndex + 1];
  const previousSource = diagnostics?.frameSources[previousIndex],
    nextSource = diagnostics?.frameSources[previousIndex + 1];
  if (
    synthesizedEndpoint &&
    frames[frames.length - 1] !== replay.frames[frames.length - 1] &&
    previous &&
    next &&
    previous.time < endTime &&
    endTime < next.time &&
    previousSource?.origin === "parsed" &&
    nextSource?.origin === "parsed" &&
    previousSource.rawTokenIndex !== undefined &&
    nextSource.rawTokenIndex === previousSource.rawTokenIndex + 1 &&
    nextSource.parsedFrameIndex === previousSource.parsedFrameIndex + 1 &&
    !nextSource.discontinuityBefore?.length &&
    previous.rawButtonMask !== undefined &&
    next.rawButtonMask !== undefined
  ) {
    endpointInputBracket = {
      previous: {
        timeMs: previous.time,
        source: { ...previousSource, rawTokenIndex: previousSource.rawTokenIndex },
        actions: [...previous.actions],
        rawButtonMask: previous.rawButtonMask,
      },
      next: {
        timeMs: next.time,
        source: { ...nextSource, rawTokenIndex: nextSource.rawTokenIndex },
        actions: [...next.actions],
        rawButtonMask: next.rawButtonMask,
      },
    };
  }
  return {
    endTime,
    frames,
    domain: {
      endTimeMs: endTime,
      endpointBasis,
      synthesizedEndpoint,
      ...(endpointInputBracket ? { endpointInputBracket } : {}),
      initialActionsKnown: diagnostics?.initialActionsKnown ?? false,
      sourceCoverageLimits: diagnostics?.sourceCoverageLimits ?? [
        "source-mapping-unavailable",
        "initial-actions-unknown",
      ],
      frameSources: frames.map((frame, index) =>
        frame === replay.frames[index]
          ? diagnostics?.frameSources[index] ?? { origin: "provided-frame", preparedFrameIndex: index }
          : { origin: "synthetic", reason: "scoring-endpoint-interpolation" },
      ),
    },
  };
}

