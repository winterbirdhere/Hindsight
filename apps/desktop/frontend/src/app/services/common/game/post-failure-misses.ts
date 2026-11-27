import {
  Beatmap,
  BucketedGameStateTimeMachine,
  GameplayInfoEvaluator,
  LazerGameplayInfoEvaluator,
  LazerGameStateTimeMachine,
  ReplayAnalysisRuleset,
  ReplayFrame,
} from "@osujs/core";
import { isLazerReplay, OsuReplay } from "../../../model/OsuReplay";

export interface PostFailureMisses {
  count: number;
  scoringEndTime: number;
  recordedEndTime: number;
}

export interface ReplayValidationContext {
  beatmap: Beatmap;
  scoringFrames: readonly ReplayFrame[];
  ruleset: ReplayAnalysisRuleset;
}

/** Diagnostic only: never feeds extra frames or judgements into playback or PP. */
export function identifyPostFailureMisses(
  replay: OsuReplay,
  simulatedCounts: readonly number[],
  simulatedMaxCombo: number,
  { beatmap, scoringFrames, ruleset }: ReplayValidationContext,
): PostFailureMisses | undefined {
  if (
    (replay.gameMode ?? 0) !== 0 ||
    ruleset !== (isLazerReplay(replay) ? "lazer" : "stable") ||
    replay.mods.includes("NO_FAIL") ||
    replay.lazerMods?.some((mod) => mod.acronym.toUpperCase() === "NF")
  )
    return undefined;

  const saved = replay.statistics;
  if (!saved) return undefined;
  const expectedCounts = [saved.count300, saved.count100, saved.count50, saved.countMiss];
  if (
    !expectedCounts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
    !expectedCounts.slice(0, 3).every((count, index) => count === simulatedCounts[index]) ||
    saved.countMiss <= simulatedCounts[3] ||
    expectedCounts.reduce((sum, count) => sum + count, 0) > beatmap.hitObjects.length
  )
    return undefined;

  const lastFrame = scoringFrames[scoringFrames.length - 1];
  if (!lastFrame) return undefined;
  const health = [...(replay.lifeBar ?? [])]
    .filter((point) => Number.isFinite(point.time) && point.time >= 0 && Number.isFinite(point.health))
    .sort((left, right) => left.time - right.time);
  const lastHealth = health[health.length - 1];
  // Unlike scoring, the evidence includes health samples AFTER the final input
  // frame: Stable can keep recording zero health throughout its fail animation.
  if (!lastHealth || lastHealth.health > 0) return undefined;
  const recordedEndTime = Math.max(lastHealth.time, replay.frames[replay.frames.length - 1]?.time ?? 0);
  if (recordedEndTime <= lastFrame.time) return undefined;

  const noInputFrame = (time: number): ReplayFrame => ({
    time,
    position: { ...lastFrame.position },
    actions: [],
    rawButtonMask: 0,
  });
  const diagnosticFrames = [
    ...scoringFrames,
    noInputFrame(Math.min(lastFrame.time + 0.001, recordedEndTime)),
    noInputFrame(recordedEndTime),
  ];
  try {
    const info =
      ruleset === "stable"
        ? new GameplayInfoEvaluator(beatmap, {}).evaluateReplayState(
            new BucketedGameStateTimeMachine(diagnosticFrames, beatmap, {
              hitWindowStyle: "OSU_STABLE",
              noteLockStyle: "STABLE",
              replayGameVersion: replay.gameVersion,
              replayTimestamp: replay.timestamp,
            }).gameStateAt(1e9),
          )
        : new LazerGameplayInfoEvaluator().evaluateReplayState(
            new LazerGameStateTimeMachine(diagnosticFrames, beatmap, undefined, { legacyReplay: false }).gameStateAt(
              1e9,
            ),
          );
    // Exact agreement is required. An early ending or a miss-count difference
    // alone does not establish that the saved misses belong to the fail tail.
    if (
      !expectedCounts.every((count, index) => count === info.verdictCounts[index]) ||
      info.maxComboSoFar !== simulatedMaxCombo
    )
      return undefined;
    return { count: saved.countMiss - simulatedCounts[3], scoringEndTime: lastFrame.time, recordedEndTime };
  } catch {
    // An inconclusive diagnostic must leave the discrepancy visible.
    return undefined;
  }
}
