import {
  Beatmap,
  BucketedGameStateTimeMachine,
  LazerGameStateTimeMachine,
  GameState,
  ReplayFrame,
  ScoringDomain,
  TraceLimits,
  TraceRunIdentity,
  TraceCapture,
  createReplayTraceCollector,
  automatedInputRetention,
  retainPlannedInputs,
} from "@osujs/core";
import type { SavedScoreTimeline } from "../../../../../../../../libs/osu/core/src/replays/SavedScoreTimeline";
import { buildMissExplanationSessionAsync, type MissExplanationSessionState } from "./MissExplanationSession";

export type MissAnalysisPhase = "preparing" | "capturing" | "analysing" | "finalizing";
export interface MissAnalysisInput {
  beatmap: Beatmap;
  frames: ReplayFrame[];
  domain: ScoringDomain;
  profile: "stable" | "lazer";
  identity: TraceRunIdentity;
  limits: TraceLimits;
  recording: { gameVersion?: number; timestamp?: number };
  retentionState?: GameState;
  additionalLimitations: string[];
  saved?: SavedScoreTimeline;
}

/** The complete ordered sidecar; it never touches playback, UI state or transport. */
export async function runMissAnalysis(
  input: MissAnalysisInput,
  checkpoint: () => Promise<void>,
  progress: (phase: MissAnalysisPhase) => void = () => undefined,
): Promise<MissExplanationSessionState> {
  let capture: TraceCapture | undefined;
  try {
    progress("preparing");
    const { beatmap, frames, domain, profile, limits } = input;
    const retention =
      input.retentionState && frames.length >= limits.maxRecords / 2
        ? automatedInputRetention(beatmap, frames, input.retentionState, profile)
        : undefined;
    await checkpoint();
    const captureDomain = retention
      ? { ...domain, sourceCoverageLimits: [...domain.sourceCoverageLimits, "planned-input-retention"] }
      : domain;
    try {
      capture = createReplayTraceCollector(input.identity, captureDomain, limits);
    } catch (error) {
      return { status: "error", reasons: ["capture-setup-failed", String(error)] };
    }
    if (retention) capture = retainPlannedInputs(capture, retention);
    const machine =
      profile === "stable"
        ? new BucketedGameStateTimeMachine(
            frames,
            beatmap,
            {
              hitWindowStyle: "OSU_STABLE",
              noteLockStyle: "STABLE",
              replayGameVersion: input.recording.gameVersion,
              replayTimestamp: input.recording.timestamp,
            },
            undefined,
            capture,
          )
        : new LazerGameStateTimeMachine(frames, beatmap, undefined, { legacyReplay: false }, capture);
    progress("capturing");
    await machine.captureReplayAsync(checkpoint);
    const trace = await capture.sealAsync(checkpoint);
    capture.dispose();
    await checkpoint();
    progress("analysing");
    const session = await buildMissExplanationSessionAsync(
      trace,
      beatmap,
      input.additionalLimitations,
      checkpoint,
      input.saved,
    );
    progress("finalizing");
    return session;
  } finally {
    capture?.dispose();
  }
}
