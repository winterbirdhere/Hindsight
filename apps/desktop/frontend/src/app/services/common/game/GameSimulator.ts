import {
  advanceStableSpinnerToTime,
  Beatmap,
  BucketedGameStateTimeMachine,
  defaultGameplayInfo,
  GameplayInfo,
  GameplayInfoEvaluator,
  GameState,
  HitObjectJudgement,
  isHitObjectJudgement,
  isSlider,
  LazerGameplayInfoEvaluator,
  LazerGameStateTimeMachine,
  ReplayAnalysisEvent,
  ReplayAnalysisRuleset,
  ReplayFrame,
  retrieveEvents,
  Spinner,
  normalizedSpinnerAngleDelta,
  modsToBitmask,
  spinnerCursorAngle,
  spinnerProgressForState,
  createReplayTraceCollector,
  ReplayTrace,
  ScoringDomain,
  TraceCapture,
  TraceLimits,
  TraceRunIdentity,
  TRACE_MODEL_SOURCE_REVISION,
  errorCapabilities,
} from "@osujs/core";
import { createHash } from "crypto";
import {
  buildMissExplanationSession,
  MissExplanationSessionState,
} from "../../analysis/miss-explanation/MissExplanationSession";
import { startMissAnalysis } from "../../analysis/miss-explanation/MissAnalysisClient";
import type { MissAnalysisPhase } from "../../analysis/miss-explanation/MissAnalysisRunner";
import { injectable } from "inversify";
import { isLazerReplay, OsuReplay } from "../../../model/OsuReplay";
import { BehaviorSubject } from "rxjs";
import { parser, std_diff } from "ojsama";
import { Queue } from "typescript-collections";
import { max } from "simple-statistics";
import {
  compareReplayParticipants,
  ComparisonParticipantLimitation,
  createReplayComparisonParticipant,
  ReplayComparisonCompatibilityIssue,
  ReplayComparisonParticipant,
  ReplayComparisonResult,
} from "../../analysis/replay-comparison";
import { createAnalyticAutoplayReference } from "../../analysis/autoplay-reference";
import {
  LiveReplayStats,
  liveReplayStatsAt,
  sliderMissResolutionTimes,
  SliderMissResolutionTimes,
  stableSliderBreakResolutionTimes,
} from "../../analysis/live-replay-stats";
import { findIndexInReplayAtTime, interpolateReplayPosition } from "../../../utils/replay";
import { identifyPostFailureMisses, PostFailureMisses, ReplayValidationContext } from "./post-failure-misses";
import { TimingHitIndex } from "../../renderers/components/hud/TimingHitIndex";
import { scoringReplayFrames } from "./ReplayScoringFrames";
import type { PreparedScoringReplay } from "./ReplayScoringFrames";
import { theoreticalMaxCombo, replayTimingHits } from "./ReplayNumericalFacts";
import { projectLibraryNumerical } from "../../library/library-numerical";
import { copyCurrentReplayNumericalProjection, isCurrentReplayReuseBinding } from "../../library/library-current-replay";
import type { CurrentReplayCaptureContext, CurrentReplayProjectedNumericalSnapshot, CurrentReplayReuseBinding } from "../../library/library-current-replay";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../../../shared/library-analysis";
import {
  buildReplayPerformanceInput,
  ReplayPerformanceInput,
} from "../../analysis/performance/replay-performance-input";
export { scoringReplayFrames, scoringReplayFramesAsync } from "./ReplayScoringFrames";

export interface ReplaySimulationValidation {
  verified: boolean;
  /** Whether every source replay judgement total matches the raw reconstruction. */
  judgementTotalsMatch?: boolean;
  /** Kept separate because a miss mismatch is more consequential than another grade mismatch. */
  missCountMatch?: boolean;
  /** Whether the achieved source max combo matches the raw reconstruction. */
  maxComboMatch?: boolean;
  expectedCounts?: number[];
  simulatedCounts: number[];
  expectedMaxCombo?: number;
  simulatedMaxCombo: number;
  warnings: string[];
  /** Saved misses explained by the recorded fail tail; raw totals stay unchanged. */
  postFailureMisses?: PostFailureMisses;
}
function errorAnalysisLimitations(validation: ReplaySimulationValidation): string[] {
  if (validation.judgementTotalsMatch !== false && validation.maxComboMatch !== false) return [];
  if (validation.postFailureMisses) return ["global-totals-mismatch", "saved-fail-tail-excluded"];
  // Saved totals describe historical results. Disagreement, including Miss or
  // combo counts, does not invalidate the reconstructed trace being explained.
  // Keep validation unchanged and apply each cause's concrete evidence guards.
  return ["global-totals-mismatch"];
}

export interface SpinnerVisualState {
  /** Signed rotation from the selected ruleset's spinner physics. */
  rotationDegrees: number;
  /** Ruleset-owned scored completion progress, clamped to 0..1. */
  progress: number;
}

const EMPTY_VALIDATION: ReplaySimulationValidation = {
  verified: false,
  simulatedCounts: [0, 0, 0, 0],
  simulatedMaxCombo: 0,
  warnings: ["Replay header validation is not available"],
};

export type ReplayComparisonState =
  | { status: "EMPTY" }
  | { status: "LOADING"; sourceKind: "replay" | "autoplay-reference" }
  | {
      status: "READY";
      sourceKind: "replay" | "autoplay-reference";
      /** Ruleset which produced this immutable comparison snapshot. */
      ruleset: ReplayAnalysisRuleset;
      primary: ReplayComparisonParticipant;
      secondary: ReplayComparisonParticipant;
      result: ReplayComparisonResult;
      validations: {
        primary: ReplaySimulationValidation;
        /** Analytic references are disclosed by participant limitations instead. */
        secondary?: ReplaySimulationValidation;
      };
    }
  | {
      status: "ERROR";
      sourceKind: "replay" | "autoplay-reference";
      message: string;
      issues?: ReplayComparisonCompatibilityIssue[];
    };

const EMPTY_REPLAY_COMPARISON: ReplayComparisonState = { status: "EMPTY" };

// Unknown native mods may transform geometry or time without a legacy bit.
// Reject those before either reconstruction; a Stable fallback would use the
// same unmodified map and invent misses (for example on Mirror/Random replays).
const SUPPORTED_NATIVE_REPLAY_MODS = new Set([
  "NF",
  "EZ",
  "TD",
  "HD",
  "HR",
  "SD",
  "PF",
  "DT",
  "NC",
  "HT",
  "DC",
  "FL",
  "AT",
  "AP",
  "RX",
  "SO",
  "V2",
  "SV2",
  "CL",
  "DA",
]);

function assertSupportedNativeReplayMods(beatmap: Beatmap, replay: OsuReplay): void {
  const unsupported = Array.from(
    new Set([...beatmap.lazerMods, ...(replay.lazerMods ?? [])].map((mod) => mod.acronym)),
  ).filter((acronym) => !SUPPORTED_NATIVE_REPLAY_MODS.has(acronym));
  if (unsupported.length > 0) {
    throw Error(
      `Replay analysis does not support the native mods: ${unsupported.join(
        ", ",
      )}. This replay cannot be reconstructed accurately.`,
    );
  }
}

export interface MissExplanationSimulationOptions {
  beatmapContentSha256?: string;
  beatmapMd5?: string;
  preparationIdentity?: string;
  /** Explicit diagnostic callers can use a content-derived generation key. */
  generationKey?: string;
  traceLimits?: TraceLimits;
  /** Verified library resource binding admitted with this exact viewer preparation. */
  libraryReuseBinding?: CurrentReplayReuseBinding;
}
const NOT_CAPTURED: MissExplanationSessionState = {
  status: "not-captured",
  reasons: ["capture-disabled-or-not-requested"],
};
const DEFAULT_TRACE_LIMITS: TraceLimits = { maxRecords: 200000, maxExportBytes: 64 * 1024 * 1024 };
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let nextMissSessionGeneration = 0;

function replayComparisonLimitations(
  validation: ReplaySimulationValidation,
  label: string,
): ComparisonParticipantLimitation[] {
  const limitations: ComparisonParticipantLimitation[] = [];
  if (!validation.verified) {
    for (const warning of validation.warnings) {
      limitations.push({
        code: "SIMULATION_NOT_VERIFIED",
        message: `${label}: ${warning}`,
      });
    }
  }
  return limitations;
}

function lazerUnpairedTailCount(beatmap: Beatmap): number {
  // Ticks and repeats are already paired by checkpoint id. Only native lazer's
  // actual SliderEnd has no equivalent Stable scoring judgement.
  return beatmap.hitObjects.filter(isSlider).length;
}

function lazerComparisonLimitations(
  beatmap: Beatmap,
  validation: ReplaySimulationValidation,
  label: string,
): ComparisonParticipantLimitation[] {
  const limitations = replayComparisonLimitations(validation, label);
  const unpairedTailCount = lazerUnpairedTailCount(beatmap);
  if (unpairedTailCount > 0) {
    limitations.push({
      code: "LAZER_NESTED_COMPONENT_DIFFERENCES_OMITTED",
      message: `${label}: ${unpairedTailCount} native lazer SliderEnd judgement${
        unpairedTailCount === 1 ? " is" : "s are"
      } included in aggregate accuracy/combo and lazer analysis, but not paired with Stable's non-equivalent legacy tails`,
    });
  }
  return limitations;
}

@injectable()
export class GameSimulator {
  public readonly missExplanations$ = new BehaviorSubject<MissExplanationSessionState>({ status: "empty" });
  public readonly missAnalysisProgress$ = new BehaviorSubject<MissAnalysisPhase | undefined>(undefined);
  private missCaptureEnabled = false;
  private missGeneration = 0;
  private missSessions: Partial<Record<ReplayAnalysisRuleset, MissExplanationSessionState>> = {};
  private missAnalysisInput?: {
    beatmap: Beatmap;
    replay: OsuReplay;
    frames: ReplayFrame[];
    domain: ScoringDomain;
    options: MissExplanationSimulationOptions;
    retentionState?: GameState;
  };
  private missAnalysisJob?: { cancelled: boolean; cancel?: () => void; promise: Promise<MissExplanationSessionState> };

  hasReplayForMissAnalysis(): boolean {
    return this.missAnalysisInput !== undefined;
  }

  /** Explicit sidecar work: never seek or replace either active playback machine. */
  analyzeMisses(): Promise<MissExplanationSessionState> {
    const input = this.missAnalysisInput;
    if (!input) return Promise.resolve({ status: "empty" });
    const profile = this.rulesetFocus$.value;
    const cached = this.missSessions[profile];
    if (cached && (cached.status !== "error" || cached.reasons.includes("analysis-resource-limit")))
      return Promise.resolve(cached);
    if (this.missAnalysisJob) return this.missAnalysisJob.promise;
    // Playback's canonical load ends at 1e9. Never explain judgements beyond
    // that existing boundary by extending the independent trace traversal.
    if (input.domain.endTimeMs > 1e9) {
      const unavailable: MissExplanationSessionState = {
        status: "unsupported",
        reasons: ["source-beyond-canonical-traversal"],
      };
      this.missSessions[profile] = unavailable;
      this.missExplanations$.next(unavailable);
      return Promise.resolve(unavailable);
    }
    if (profile !== (isLazerReplay(input.replay) ? "lazer" : "stable")) {
      const unsupported: MissExplanationSessionState = {
        status: "unsupported",
        reasons: ["cross-rules-profile-not-captured"],
      };
      this.missSessions[profile] = unsupported;
      this.missExplanations$.next(unsupported);
      return Promise.resolve(unsupported);
    }
    const generation = this.missGeneration;
    const cancelled = { status: "not-captured", reasons: ["analysis-cancelled"] } as const;
    const cancellation = new Error("Miss analysis cancelled");
    const job: NonNullable<GameSimulator["missAnalysisJob"]> = {
      cancelled: false,
      promise: undefined as unknown as Promise<MissExplanationSessionState>,
    };
    const isCurrent = () =>
      !job.cancelled &&
      this.missAnalysisJob === job &&
      this.missGeneration === generation &&
      this.missAnalysisInput === input &&
      this.rulesetFocus$.value === profile;
    const guard = () => {
      if (!isCurrent()) throw cancellation;
    };
    const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    job.promise = (async (): Promise<MissExplanationSessionState> => {
      try {
        // Let the action's busy state paint before preparation starts.
        await yieldTurn();
        guard();
        let sliceStart = performance.now();
        const checkpoint = async () => {
          guard();
          if (performance.now() - sliceStart >= 8) {
            await yieldTurn();
            guard();
            sliceStart = performance.now();
          }
        };
        const { beatmap, replay, frames, domain, options } = input;
        const capabilities = errorCapabilities(beatmap, profile);
        if ((replay.gameMode ?? 0) !== 0 || capabilities.scoring !== "supported") {
          const unavailable: MissExplanationSessionState = {
            status: "unsupported",
            reasons: ["incompatible-analysis-profile", ...capabilities.reasons],
          };
          this.missSessions[profile] = unavailable;
          this.missExplanations$.next(unavailable);
          return unavailable;
        }
        const validation = profile === "stable" ? this.stableValidation : this.lazerValidation;
        const execution = startMissAnalysis(
          {
            beatmap,
            frames,
            domain,
            profile,
            identity: this.createMissIdentity(beatmap, replay, options),
            limits: options.traceLimits ?? DEFAULT_TRACE_LIMITS,
            recording: { gameVersion: replay.gameVersion, timestamp: replay.timestamp },
            retentionState: input.retentionState,
            additionalLimitations: errorAnalysisLimitations(validation),
            saved: replay.savedScoreSource?.status === "validated" ? replay.savedScoreSource.timeline : undefined,
          },
          checkpoint,
          (phase) => {
            if (isCurrent()) this.missAnalysisProgress$.next(phase);
          },
        );
        job.cancel = execution.cancel;
        if (!isCurrent()) execution.cancel();
        const session = await execution.promise;
        guard();
        this.missSessions[profile] = session;
        this.missExplanations$.next(session);
        return session;
      } catch (error) {
        if (error === cancellation || !isCurrent()) return cancelled;
        const failure: MissExplanationSessionState = {
          status: "error",
          reasons: ["miss-analysis-failed", String(error)],
        };
        this.missSessions[profile] = failure;
        this.missExplanations$.next(failure);
        return failure;
      } finally {
        if (this.missAnalysisJob === job) {
          this.missAnalysisJob = undefined;
          this.missAnalysisProgress$.next(undefined);
        }
      }
    })();
    this.missAnalysisJob = job;
    this.missExplanations$.next({ status: "building" });
    return job.promise;
  }

  private cancelMissAnalysis(): void {
    const job = this.missAnalysisJob;
    if (job) {
      job.cancelled = true;
      job.cancel?.();
    }
    this.missAnalysisJob = undefined;
    this.missAnalysisProgress$.next(undefined);
  }

  setMissExplanationCaptureEnabled(enabled: boolean): void {
    if (enabled === this.missCaptureEnabled) return;
    this.cancelMissAnalysis();
    this.missCaptureEnabled = enabled;
    this.missSessions = {};
    this.missExplanations$.next(this.primaryReplay ? NOT_CAPTURED : { status: "empty" });
  }
  getMissExplanation(targetId: string) {
    const state = this.missExplanations$.value;
    return state.status === "ready" || state.status === "partial" ? state.explanations.get(targetId) : undefined;
  }
  clearMissExplanations(): void {
    this.cancelMissAnalysis();
    this.missAnalysisInput = undefined;
    this.missGeneration = ++nextMissSessionGeneration;
    this.missSessions = {};
    this.missExplanations$.next({ status: "empty" });
  }
  private publishMissSession(): void {
    const sourceFailure =
      this.missSessions.stable?.status === "error"
        ? this.missSessions.stable
        : this.missSessions.lazer?.status === "error"
        ? this.missSessions.lazer
        : undefined;
    this.missExplanations$.next(
      this.missSessions[this.rulesetFocus$.value] ??
        sourceFailure ?? {
          status: "not-captured",
          reasons: [this.missCaptureEnabled ? "cross-rules-profile-not-captured" : "capture-disabled-or-not-requested"],
        },
    );
  }
  private createMissIdentity(
    beatmap: Beatmap,
    replay: OsuReplay,
    options: MissExplanationSimulationOptions,
  ): TraceRunIdentity {
    const profile = isLazerReplay(replay) ? "lazer" : "stable";
    return {
      schemaVersion: 2,
      replayContentSha256: replay.replayContentSha256 ?? null,
      beatmapContentSha256: options.beatmapContentSha256 ?? null,
      beatmapMd5: options.beatmapMd5 ?? null,
      generationKey: options.generationKey ?? `local-${this.missGeneration}`,
      recordingClient: profile,
      analysisProfileId: profile,
      analysisProfileFingerprint: fingerprint({
        model: TRACE_MODEL_SOURCE_REVISION,
        profile,
        gameVersion: replay.gameVersion,
        timestamp: replay.timestamp,
        sourceClient: replay.sourceClient,
        sourceProvenance: replay.sourceProvenance,
        mods: replay.mods,
        lazerMods: replay.lazerMods,
        resolvedMods: beatmap.appliedMods,
        resolvedNative: beatmap.lazerModSettings,
        rate: beatmap.gameClockRate,
        preparation: options.preparationIdentity ?? "caller-prepared-map",
        sourceMode: "source",
        difficulty: beatmap.difficulty,
        stableOverallDifficulty: beatmap.stableOverallDifficulty,
        geometry: beatmap.hitObjects.map((o) => ({
          id: o.id,
          type: o.type,
          position: "position" in o ? o.position : undefined,
          ...("hitTime" in o
            ? { hitTime: o.hitTime, spawnTime: o.spawnTime, radius: o.radius }
            : { startTime: o.startTime, endTime: o.endTime }),
        })),
      }),
      parserVersion: replay.parseDiagnostics?.parserVersion ?? "provided-frames-unverified",
      inputPreparationVersion: "scoring-endpoint-provenance-v2",
    };
  }
  private prepareMissCapture(
    beatmap: Beatmap,
    replay: OsuReplay,
    domain: ScoringDomain,
    options: MissExplanationSimulationOptions,
    requested = false,
  ): TraceCapture | undefined {
    if (!this.missCaptureEnabled && !requested) return undefined;
    const profile = isLazerReplay(replay) ? "lazer" : "stable";
    if ((replay.gameMode ?? 0) !== 0 || errorCapabilities(beatmap, profile).scoring !== "supported") {
      this.missSessions[profile] = {
        status: "unsupported",
        reasons: ["incompatible-analysis-profile", ...errorCapabilities(beatmap, profile).reasons],
      };
      return undefined;
    }
    try {
      this.missExplanations$.next({ status: "building" });
      return createReplayTraceCollector(
        this.createMissIdentity(beatmap, replay, options),
        domain,
        options.traceLimits ?? DEFAULT_TRACE_LIMITS,
      );
    } catch (error) {
      this.missSessions[profile] = { status: "error", reasons: ["capture-setup-failed", String(error)] };
      return undefined;
    }
  }
  private gameplayTimeMachine?: BucketedGameStateTimeMachine;
  private gameplayEvaluator?: GameplayInfoEvaluator;
  private lazerTimeMachine?: LazerGameStateTimeMachine;
  private lazerGameplayEvaluator?: LazerGameplayInfoEvaluator;
  private audioStableTimeMachine?: BucketedGameStateTimeMachine;
  private audioLazerTimeMachine?: LazerGameStateTimeMachine;
  private currentState?: GameState;
  private lastState?: GameState;
  private lazerLastState?: GameState;
  private currentInfo: GameplayInfo = defaultGameplayInfo;
  private currentPlaybackTime = 0;
  private scoringEndTime = 0;
  private primaryBeatmap?: Beatmap;
  private primaryReplay?: OsuReplay;
  private timingStatsCache?: {
    hits: GameSimulator["hits"];
    length: number;
    rate: number;
    ruleset: ReplayAnalysisRuleset;
    index: TimingHitIndex;
  };
  private performanceInputs: readonly ReplayPerformanceInput[] = [];
  private libraryReplayGeneration = 0;
  private libraryReplayCapture?: { context: CurrentReplayCaptureContext; beatmap: Beatmap; replay: OsuReplay;
    scoring: PreparedScoringReplay; state: GameState; completed?: CurrentReplayProjectedNumericalSnapshot };
  private primaryStableEvents: ReplayAnalysisEvent[] = [];
  private primaryLazerEvents: ReplayAnalysisEvent[] = [];
  private stableHits: [number, number, boolean][] = [];
  private lazerHits: [number, number, boolean][] = [];
  private mapMaxCombo: Record<ReplayAnalysisRuleset, number> = { stable: 0, lazer: 0 };
  private stableSliderBreakTimes: number[] = [];
  private sliderMissTimes: SliderMissResolutionTimes = {
    stableSliderEnd: [],
    lazerSliderTick: [],
    lazerSliderEnd: [],
  };
  private stableValidation: ReplaySimulationValidation = EMPTY_VALIDATION;
  private lazerValidation: ReplaySimulationValidation = EMPTY_VALIDATION;
  public replayEvents$: BehaviorSubject<ReplayAnalysisEvent[]>;
  public difficulties$: BehaviorSubject<number[]>;
  public validation$: BehaviorSubject<ReplaySimulationValidation>;
  public lazerAvailable$: BehaviorSubject<boolean>;
  public rulesetFocus$: BehaviorSubject<ReplayAnalysisRuleset>;
  public replayComparison$: BehaviorSubject<ReplayComparisonState>;
  public judgements: HitObjectJudgement[] = [];
  /** Complete sorted snapshot: replace on load, ruleset switch or clear; never mutate published tuples. */
  public hits: readonly (readonly [number, number, boolean])[] = [];

  constructor() {
    this.replayEvents$ = new BehaviorSubject<ReplayAnalysisEvent[]>([]);
    this.difficulties$ = new BehaviorSubject<number[]>([]);
    this.validation$ = new BehaviorSubject<ReplaySimulationValidation>(EMPTY_VALIDATION);
    this.lazerAvailable$ = new BehaviorSubject<boolean>(false);
    this.rulesetFocus$ = new BehaviorSubject<ReplayAnalysisRuleset>("stable");
    this.replayComparison$ = new BehaviorSubject<ReplayComparisonState>(EMPTY_REPLAY_COMPARISON);
  }

  calculateDifficulties(rawBeatmap: string, durationInMs: number, mods: number, beatmap?: Beatmap) {
    this.difficulties$.next([]);
    if (!Number.isFinite(durationInMs) || durationInMs <= 0) return;
    try {
      this.difficulties$.next(this.calculateDifficultyGraph(rawBeatmap, durationInMs, mods, beatmap));
    } catch (error) {
      // This optional legacy graph must not prevent replay simulation or native PP calculation.
      console.warn("Could not calculate the timeline difficulty graph; replay analysis can continue.", error);
    }
  }

  private calculateDifficultyGraph(
    rawBeatmap: string,
    durationInMs: number,
    mods: number,
    beatmap?: Beatmap,
  ): number[] {
    console.log(`Calculating difficulty for beatmap with duration=${durationInMs}ms and mods=${mods}`);
    const p = new parser();
    p.feed(rawBeatmap);
    const map = p.map;
    if (map.objects.length === 0) return [];
    if (map.objects.some((object) => !Number.isFinite(object.time))) {
      throw new Error("Timeline difficulty contains an invalid object time");
    }
    // ojsama accepts only legacy rate/difficulty bits. Supply native lazer's
    // effective CS and real-time intervals, then restore map-time chart bins.
    const originalTimes = beatmap?.lazerMods.length ? map.objects.map((object) => object.time) : undefined;
    if (originalTimes && beatmap) {
      map.cs = beatmap.difficulty.circleSize;
      mods &= ~modsToBitmask(["HARD_ROCK", "EASY", "DOUBLE_TIME", "NIGHT_CORE", "HALF_TIME"]);
      map.objects.forEach((object) => {
        object.time /= beatmap.gameClockRate;
      });
    }
    let d: std_diff;
    try {
      d = new std_diff().calc({ map, mods });
    } finally {
      if (originalTimes)
        map.objects.forEach((object, index) => {
          object.time = originalTimes[index];
        });
    }

    const TIME_STEP = 500;
    const q = new Queue<[number, number]>();
    let i = 0;
    let sum = 0;
    const res: number[] = [];

    // O(n + m)
    for (let t = 0; t < durationInMs; t += TIME_STEP) {
      while (i < map.objects.length) {
        const o = map.objects[i];
        if (t + TIME_STEP < o.time) {
          break;
        }
        const strainTotal = d.objects[i].strains[0] + d.objects[i].strains[1];
        if (!Number.isFinite(strainTotal)) throw new Error("Timeline difficulty contains an invalid strain");
        q.enqueue([o.time, strainTotal]);
        sum += strainTotal;
        i++;
      }
      while (!q.isEmpty()) {
        const [time, totalStrain] = q.peek() as [number, number];
        if (time > t - TIME_STEP) {
          break;
        }
        sum -= totalStrain;
        q.dequeue();
      }
      res.push(q.isEmpty() ? 0 : sum / q.size());
    }
    if (res.some((value) => !Number.isFinite(value))) {
      throw new Error("Timeline difficulty contains an invalid graph value");
    }
    if (res.length > 0) {
      // normalize
      const m = max(res);
      if (m > 0) {
        const normalizedRes = res.map((r) => r / m);
        if (normalizedRes.some((value) => !Number.isFinite(value))) {
          throw new Error("Timeline difficulty could not be normalized");
        }
        return normalizedRes;
      }
    }
    return [];
  }

  simulateReplay(beatmap: Beatmap, replay: OsuReplay, options: MissExplanationSimulationOptions = {}) {
    this.libraryReplayGeneration++;
    this.libraryReplayCapture = undefined;
    this.cancelMissAnalysis();
    this.missAnalysisInput = undefined;
    this.missGeneration = ++nextMissSessionGeneration;
    this.missSessions = {};
    this.missExplanations$.next(NOT_CAPTURED);
    try {
      assertSupportedNativeReplayMods(beatmap, replay);
    } catch (error) {
      this.clear();
      throw error;
    }
    this.lazerAvailable$.next(false);
    this.audioStableTimeMachine = undefined;
    this.audioLazerTimeMachine = undefined;
    this.currentPlaybackTime = 0;
    this.performanceInputs = [];
    this.mapMaxCombo = { stable: theoreticalMaxCombo(beatmap), lazer: theoreticalMaxCombo(beatmap, "lazer") };
    this.rulesetFocus$.next("stable");
    const scoring = scoringReplayFrames(beatmap, replay);
    const { frames: scoringFrames, endTime: scoringEndTime, domain } = scoring;
    this.scoringEndTime = scoringEndTime;
    const sourceProfile = isLazerReplay(replay) ? "lazer" : "stable";
    const capture = this.prepareMissCapture(beatmap, replay, domain, options);
    let sourceTrace: ReplayTrace | undefined;
    const finishCapture = () => {
      if (!capture) return;
      try {
        sourceTrace = capture.seal();
      } catch (error) {
        this.missSessions[sourceProfile] = { status: "error", reasons: ["capture-seal-failed", String(error)] };
      } finally {
        capture.dispose();
      }
    };
    try {
      this.gameplayTimeMachine = new BucketedGameStateTimeMachine(
        scoringFrames,
        beatmap,
        {
          hitWindowStyle: "OSU_STABLE",
          noteLockStyle: "STABLE",
          replayGameVersion: replay.gameVersion,
          replayTimestamp: replay.timestamp,
        },
        undefined,
        sourceProfile === "stable" ? capture : undefined,
      );
      this.gameplayEvaluator = new GameplayInfoEvaluator(beatmap, {});
      // TODO: Move this to async ...
      const rawStableFinalState = this.gameplayTimeMachine.gameStateAt(1e9);
      if (sourceProfile === "stable") finishCapture();
      const rawStableFinalInfo = new GameplayInfoEvaluator(beatmap, {}).evaluateReplayState(rawStableFinalState);
      this.lastState = rawStableFinalState;
      this.currentInfo = defaultGameplayInfo;
      // this.currentState = finalState...
      const stableEvents = retrieveEvents(this.lastState, beatmap.hitObjects, "stable");
      this.stableSliderBreakTimes = stableSliderBreakResolutionTimes(stableEvents);
      this.sliderMissTimes = sliderMissResolutionTimes(stableEvents);
      this.primaryBeatmap = beatmap;
      this.primaryReplay = replay;
      this.primaryStableEvents = stableEvents;
      this.primaryLazerEvents = [];
      this.replayComparison$.next(EMPTY_REPLAY_COMPARISON);
      this.replayEvents$.next(stableEvents);
      this.stableValidation = this.validateSimulation(
        replay,
        rawStableFinalInfo.verdictCounts,
        rawStableFinalInfo.maxComboSoFar,
        { beatmap, scoringFrames, ruleset: "stable" },
      );
      this.lazerValidation = EMPTY_VALIDATION;
      this.validation$.next(this.stableValidation);
      this.judgements = this.replayEvents$
        .getValue()
        .filter(isHitObjectJudgement)
        .filter((event) => event.affectsAccuracy !== false);

      try {
        if (replay.gameMode !== undefined && replay.gameMode !== 0) {
          throw new Error("Native lazer playback is available only for osu!standard replays");
        }
        // Legacy Relax replays omit their generated taps. Modern lazer recordings
        // already contain those actions, so reconstruction must retain provenance.
        this.lazerTimeMachine = new LazerGameStateTimeMachine(
          scoringFrames,
          beatmap,
          undefined,
          {
            legacyReplay: !isLazerReplay(replay),
          },
          sourceProfile === "lazer" ? capture : undefined,
        );
        this.lazerGameplayEvaluator = new LazerGameplayInfoEvaluator();
        this.lazerLastState = this.lazerTimeMachine.gameStateAt(1e9);
        if (sourceProfile === "lazer") finishCapture();
        const lazerInfo = new LazerGameplayInfoEvaluator().evaluateReplayState(this.lazerLastState);
        this.lazerValidation = this.validateSimulation(replay, lazerInfo.verdictCounts, lazerInfo.maxComboSoFar, {
          beatmap,
          scoringFrames,
          ruleset: "lazer",
        });
        const lazerEvents = retrieveEvents(this.lazerLastState, beatmap.hitObjects, "lazer");
        this.primaryLazerEvents = lazerEvents;
        this.sliderMissTimes = sliderMissResolutionTimes([...stableEvents, ...lazerEvents]);
        this.lazerAvailable$.next(true);
      } catch (error) {
        console.warn("Could not build native Stable/lazer playback", error);
        if (capture && sourceProfile === "lazer") {
          sourceTrace = undefined;
          this.missSessions.lazer = { status: "error", reasons: ["canonical-scoring-failed", String(error)] };
        }
        this.lazerTimeMachine = undefined;
        this.lazerGameplayEvaluator = undefined;
        this.lazerLastState = undefined;
        this.primaryLazerEvents = [];
        this.lazerValidation = EMPTY_VALIDATION;
        this.lazerAvailable$.next(false);
      }

      this.stableHits = this.lastState
        ? this.hitsFromState(beatmap, this.lastState, this.getTimingUnreliableHitObjectIds("stable"))
        : [];
      // Lazer's AffectsUnstableRate includes successful Classic slider heads:
      // they have hit windows and a hit result even when head accuracy is off.
      // Scoring eligibility (affectsAccuracy) is separate from timing eligibility.
      // Keep missed Classic heads out of the existing hit-error-bar marker stream.
      this.lazerHits = this.lazerLastState
        ? this.hitsFromState(
            beatmap,
            this.lazerLastState,
            new Set(
              this.primaryLazerEvents
                .filter(
                  (event): event is HitObjectJudgement =>
                    isHitObjectJudgement(event) && event.affectsAccuracy === false && event.verdict === "MISS",
                )
                .map((event) => event.hitObjectId),
            ),
          )
        : [];
      this.hits = [...this.stableHits];
      if (sourceTrace) {
        const validation = sourceProfile === "stable" ? this.stableValidation : this.lazerValidation;
        this.missSessions[sourceProfile] = buildMissExplanationSession(
          sourceTrace,
          beatmap,
          errorAnalysisLimitations(validation),
          replay.savedScoreSource?.status === "validated" ? replay.savedScoreSource.timeline : undefined,
        );
      }

      // Prefer the resolved recording origin after the isolated Lazer evaluator
      // has built. Confirmed legacy-wrapper exports retain their original version;
      // unsupported modes keep the Stable fallback.
      if (isLazerReplay(replay)) this.setRulesetFocus("lazer");

      this.performanceInputs = [
        buildReplayPerformanceInput({
          beatmap,
          replay,
          state: this.lastState,
          mode: "stable",
          finalReplayTime: scoringEndTime,
          stateIsScoringBounded: true,
        }),
        ...(this.lazerLastState
          ? [
              buildReplayPerformanceInput({
                beatmap,
                replay,
                state: this.lazerLastState,
                mode: beatmap.lazerModSettings.classic ? "lazer-classic" : "lazer",
                finalReplayTime: scoringEndTime,
                stateIsScoringBounded: true,
              }),
            ]
          : []),
      ];
      this.missAnalysisInput = {
        beatmap,
        replay,
        frames: scoringFrames,
        domain,
        retentionState: sourceProfile === "lazer" ? this.lazerLastState : rawStableFinalState,
        options: { ...options, traceLimits: options.traceLimits ? { ...options.traceLimits } : undefined },
      };
      const binding = options.libraryReuseBinding;
      const mode = sourceProfile === "stable" ? "stable" : beatmap.lazerModSettings.classic ? "lazer-classic" : "lazer";
      const input = this.performanceInputs.find(candidate => candidate.mode === mode);
      const state = sourceProfile === "stable" ? this.lastState : this.lazerLastState;
      if (binding && isCurrentReplayReuseBinding(binding) && input && state && binding.mode === mode &&
        binding.replaySha256 === replay.replayContentSha256?.toLowerCase() && binding.mapSha256 === options.beatmapContentSha256?.toLowerCase() &&
        binding.mapMd5 === replay.beatmapMd5.toLowerCase() && binding.mapMd5 === options.beatmapMd5?.toLowerCase() &&
        binding.objectCount === beatmap.hitObjects.length && binding.clockRate === beatmap.gameClockRate) {
        const context = Object.freeze({ generation: this.libraryReplayGeneration, binding: Object.freeze({ ...binding }), performanceInput: input });
        this.libraryReplayCapture = { context, beatmap, replay, scoring, state };
      }
      this.publishMissSession();
    } catch (error) {
      if (capture) {
        this.missSessions[sourceProfile] = { status: "error", reasons: ["canonical-scoring-failed", String(error)] };
        this.publishMissSession();
      }
      throw error;
    } finally {
      capture?.dispose();
    }
  }

  private hitsFromState(
    beatmap: Beatmap,
    state: GameState,
    excludedHitObjectIds: ReadonlySet<string> = new Set(),
  ): [number, number, boolean][] {
    return replayTimingHits(beatmap, state, excludedHitObjectIds);
  }

  setRulesetFocus(focus: ReplayAnalysisRuleset): boolean {
    if (focus === "lazer" && (!this.lazerTimeMachine || !this.lazerGameplayEvaluator)) return false;
    if (this.rulesetFocus$.getValue() === focus) return true;

    this.cancelMissAnalysis();
    this.rulesetFocus$.next(focus);
    this.publishMissSession();
    this.validation$.next(focus === "stable" ? this.stableValidation : this.lazerValidation);
    const events = focus === "stable" ? this.primaryStableEvents : this.primaryLazerEvents;
    this.replayEvents$.next(events);
    this.judgements = events.filter(isHitObjectJudgement).filter((event) => event.affectsAccuracy !== false);
    this.hits = [...(focus === "stable" ? this.stableHits : this.lazerHits)];
    this.simulate(this.currentPlaybackTime);
    return true;
  }

  getRulesetFocus(): ReplayAnalysisRuleset {
    return this.rulesetFocus$.getValue();
  }

  getStableEvents(): readonly ReplayAnalysisEvent[] {
    return this.primaryStableEvents;
  }

  getStableHits(): readonly [number, number, boolean][] {
    return this.stableHits;
  }

  getEventsForRuleset(ruleset: ReplayAnalysisRuleset): readonly ReplayAnalysisEvent[] {
    return ruleset === "stable" ? this.primaryStableEvents : this.primaryLazerEvents;
  }

  getHitsForRuleset(ruleset: ReplayAnalysisRuleset): readonly [number, number, boolean][] {
    return ruleset === "stable" ? this.stableHits : this.lazerHits;
  }

  /** All exposed judgements now come directly from the recorded replay simulation. */
  getTimingUnreliableHitObjectIds(_ruleset: ReplayAnalysisRuleset): ReadonlySet<string> {
    return new Set<string>();
  }

  setReplayComparisonLoading(sourceKind: "replay" | "autoplay-reference") {
    this.replayComparison$.next({ status: "LOADING", sourceKind });
  }

  setReplayComparisonError(
    sourceKind: "replay" | "autoplay-reference",
    message: string,
    issues?: ReplayComparisonCompatibilityIssue[],
  ) {
    const state: ReplayComparisonState = { status: "ERROR", sourceKind, message, issues };
    this.replayComparison$.next(state);
    return state;
  }

  compareReplay(
    beatmap: Beatmap,
    replay: OsuReplay,
    ruleset: ReplayAnalysisRuleset = this.rulesetFocus$.getValue(),
  ): ReplayComparisonState {
    if (!this.primaryBeatmap || !this.primaryReplay || !this.lastState) {
      return this.setReplayComparisonError("replay", "Load a primary replay before adding a comparison replay");
    }

    try {
      if (replay.gameMode !== 0) throw Error("The comparison replay must be an osu!standard replay");
      assertSupportedNativeReplayMods(beatmap, replay);
      const { frames: scoringFrames } = scoringReplayFrames(beatmap, replay);
      let primaryValidation: ReplaySimulationValidation;
      let secondaryValidation: ReplaySimulationValidation;
      let primary: ReplayComparisonParticipant;
      let secondary: ReplayComparisonParticipant;

      if (ruleset === "lazer") {
        if (!this.lazerLastState) throw Error("Native Lazer reconstruction is unavailable for the primary replay");

        const primaryInfo = new LazerGameplayInfoEvaluator().evaluateReplayState(this.lazerLastState);
        primaryValidation = this.lazerValidation;
        const secondaryState = new LazerGameStateTimeMachine(scoringFrames, beatmap, undefined, {
          legacyReplay: !isLazerReplay(replay),
        }).gameStateAt(1e9);
        const secondaryInfo = new LazerGameplayInfoEvaluator().evaluateReplayState(secondaryState);
        const secondaryEvents = retrieveEvents(secondaryState, beatmap.hitObjects, "lazer");
        secondaryValidation = this.validateSimulation(
          replay,
          secondaryInfo.verdictCounts,
          secondaryInfo.maxComboSoFar,
          {
            beatmap,
            scoringFrames,
            ruleset,
          },
        );
        primary = createReplayComparisonParticipant({
          id: "primary-replay",
          replay: this.primaryReplay,
          events: this.primaryLazerEvents,
          verdictCountsInput: primaryInfo.verdictCounts,
          accuracyInput: primaryInfo.accuracy,
          maxComboInput: primaryInfo.maxComboSoFar,
          limitations: lazerComparisonLimitations(this.primaryBeatmap, primaryValidation, "Primary reconstruction"),
        });
        secondary = createReplayComparisonParticipant({
          id: `comparison-replay:${replay.md5hash}`,
          replay,
          events: secondaryEvents,
          verdictCountsInput: secondaryInfo.verdictCounts,
          accuracyInput: secondaryInfo.accuracy,
          maxComboInput: secondaryInfo.maxComboSoFar,
          limitations: lazerComparisonLimitations(beatmap, secondaryValidation, "Comparison reconstruction"),
        });
      } else {
        const timeMachine = new BucketedGameStateTimeMachine(scoringFrames, beatmap, {
          hitWindowStyle: "OSU_STABLE",
          noteLockStyle: "STABLE",
          replayGameVersion: replay.gameVersion,
          replayTimestamp: replay.timestamp,
        });
        const rawFinalState = timeMachine.gameStateAt(1e9);
        const rawFinalInfo = new GameplayInfoEvaluator(beatmap, {}).evaluateReplayState(rawFinalState);
        const events = retrieveEvents(rawFinalState, beatmap.hitObjects, "stable");
        const primaryInfo = new GameplayInfoEvaluator(this.primaryBeatmap, {}).evaluateReplayState(this.lastState);
        primaryValidation = this.stableValidation;
        secondaryValidation = this.validateSimulation(replay, rawFinalInfo.verdictCounts, rawFinalInfo.maxComboSoFar, {
          beatmap,
          scoringFrames,
          ruleset,
        });
        primary = createReplayComparisonParticipant({
          id: "primary-replay",
          replay: this.primaryReplay,
          events: this.primaryStableEvents,
          verdictCountsInput: primaryInfo.verdictCounts,
          accuracyInput: primaryInfo.accuracy,
          maxComboInput: primaryInfo.maxComboSoFar,
          limitations: replayComparisonLimitations(primaryValidation, "Primary reconstruction"),
        });
        secondary = createReplayComparisonParticipant({
          id: `comparison-replay:${replay.md5hash}`,
          replay,
          events,
          verdictCountsInput: rawFinalInfo.verdictCounts,
          accuracyInput: rawFinalInfo.accuracy,
          maxComboInput: rawFinalInfo.maxComboSoFar,
          limitations: replayComparisonLimitations(secondaryValidation, "Comparison reconstruction"),
        });
      }

      const result = compareReplayParticipants(primary, secondary, { ruleset });
      if (!result.compatibility.canCompare) {
        return this.setReplayComparisonError(
          "replay",
          result.compatibility.issues
            .filter((issue) => issue.severity === "error")
            .map((issue) => issue.message)
            .join(" · "),
          result.compatibility.issues,
        );
      }

      const state: ReplayComparisonState = {
        status: "READY",
        sourceKind: "replay",
        ruleset,
        primary,
        secondary,
        result,
        validations: { primary: primaryValidation, secondary: secondaryValidation },
      };
      this.replayComparison$.next(state);
      return state;
    } catch (error) {
      return this.setReplayComparisonError(
        "replay",
        error instanceof Error ? error.message : "Could not simulate the comparison replay",
      );
    }
  }

  compareAutoplayReference(): ReplayComparisonState {
    if (!this.primaryBeatmap || !this.primaryReplay || !this.lastState) {
      return this.setReplayComparisonError(
        "autoplay-reference",
        "Load a primary replay before creating an Autoplay reference",
      );
    }

    try {
      const primaryValidation = this.stableValidation;
      const primaryInfo = new GameplayInfoEvaluator(this.primaryBeatmap, {}).evaluateReplayState(this.lastState);
      const primary = createReplayComparisonParticipant({
        id: "primary-replay",
        replay: this.primaryReplay,
        events: this.primaryStableEvents,
        verdictCountsInput: primaryInfo.verdictCounts,
        accuracyInput: primaryInfo.accuracy,
        maxComboInput: primaryInfo.maxComboSoFar,
        limitations: replayComparisonLimitations(primaryValidation, "Primary reconstruction"),
      });
      const reference = createAnalyticAutoplayReference({
        beatmap: this.primaryBeatmap,
        beatmapMd5: this.primaryReplay.beatmapMd5,
        maxComboInput: theoreticalMaxCombo(this.primaryBeatmap),
      });
      const result = compareReplayParticipants(primary, reference.participant, { ruleset: "stable" });
      if (!result.compatibility.canCompare) {
        return this.setReplayComparisonError(
          "autoplay-reference",
          result.compatibility.issues
            .filter((issue) => issue.severity === "error")
            .map((issue) => issue.message)
            .join(" · "),
          result.compatibility.issues,
        );
      }
      const state: ReplayComparisonState = {
        status: "READY",
        sourceKind: "autoplay-reference",
        ruleset: "stable",
        primary,
        secondary: reference.participant,
        result,
        validations: { primary: primaryValidation },
      };
      this.replayComparison$.next(state);
      return state;
    } catch (error) {
      return this.setReplayComparisonError(
        "autoplay-reference",
        error instanceof Error ? error.message : "Could not create the Autoplay reference",
      );
    }
  }

  clearReplayComparison() {
    this.replayComparison$.next(EMPTY_REPLAY_COMPARISON);
  }

  // Simulates the game to be at the given time
  // If a whole game simulation has happened, then this should be really fast
  simulate(gameTimeInMs: number) {
    this.currentPlaybackTime = gameTimeInMs;
    const scoringTime = Math.min(gameTimeInMs, this.scoringEndTime);
    if (this.rulesetFocus$.getValue() === "lazer" && this.lazerTimeMachine && this.lazerGameplayEvaluator) {
      const currentState = this.lazerTimeMachine.gameStateAt(scoringTime);
      this.currentState = currentState;
      this.currentInfo = this.lazerGameplayEvaluator.evaluateReplayState(currentState);
    } else if (this.gameplayTimeMachine && this.gameplayEvaluator) {
      const currentState = this.gameplayTimeMachine.gameStateAt(scoringTime);
      this.currentState = currentState;
      this.currentInfo = this.gameplayEvaluator.evaluateReplayState(currentState);
    }
  }

  getCurrentState() {
    return this.currentState;
  }

  /** Display-ready timing from the same immutable prefixes used by the classic HUD. */
  getCurrentTimingStats(): { ur: string; bias: string } {
    if (!this.primaryBeatmap || !this.currentState) return { ur: "—", bias: "—" };
    const hits = this.hits;
    const rate = this.primaryBeatmap.gameClockRate;
    const ruleset = this.getRulesetFocus();
    let cache = this.timingStatsCache;
    if (
      !cache ||
      cache.hits !== hits ||
      cache.length !== hits.length ||
      cache.rate !== rate ||
      cache.ruleset !== ruleset
    ) {
      cache = this.timingStatsCache = {
        hits,
        length: hits.length,
        rate,
        ruleset,
        index: new TimingHitIndex(hits, rate, ruleset === "lazer" ? 1 : rate),
      };
    }
    const count = cache.index.sampleCount(cache.index.prefixEnd(this.currentPlaybackTime));
    if (count === 0) return { ur: "—", bias: "—" };
    const bias = cache.index.mean(count);
    return {
      ur: cache.index.unstableRate(count),
      bias: Math.abs(bias) < 0.05 ? "+0.0 ms" : `${bias < 0 ? "-" : "+"}${Math.abs(bias).toFixed(1)} ms`,
    };
  }

  /** Audio lookups must not advance the mutable state used by the visible frame. */
  getStateAt(gameTimeInMs: number): GameState | undefined {
    const scoringTime = Math.min(gameTimeInMs, this.scoringEndTime);
    if (this.rulesetFocus$.getValue() === "lazer" && this.lazerTimeMachine && this.lazerGameplayEvaluator) {
      this.audioLazerTimeMachine ??= this.lazerTimeMachine.fork();
      return this.audioLazerTimeMachine.gameStateAt(scoringTime);
    }
    if (!this.gameplayTimeMachine || !this.gameplayEvaluator) return undefined;
    this.audioStableTimeMachine ??= this.gameplayTimeMachine.fork();
    return this.audioStableTimeMachine.gameStateAt(scoringTime);
  }

  getCurrentSpinnerVisualState(spinner: Spinner): SpinnerVisualState {
    const spinnerState = this.currentState?.spinnerState.get(spinner.id);
    const gameClockRate = Math.abs(this.primaryBeatmap?.gameClockRate ?? 1) || 1;
    let rotationDegrees = (spinnerState?.totalAccumulatedRotation ?? 0) / gameClockRate;

    // Add a presentation-only fraction between recorded samples. Stable's body
    // follows its smoothed angular velocity; native Lazer follows the cursor.
    // Neither branch changes the scored state or its completion progress.
    const stateTime = this.currentState?.currentTime;
    const frames = this.primaryReplay?.frames;
    const visualTime = Math.min(this.currentPlaybackTime, this.scoringEndTime, spinner.endTime);
    if (
      spinnerState?.stableAngularVelocity !== undefined &&
      stateTime !== undefined &&
      visualTime > stateTime &&
      stateTime >= spinner.startTime &&
      stateTime < spinner.endTime
    ) {
      const projected = advanceStableSpinnerToTime(
        { ...spinnerState, stableLastBodyTime: spinnerState.stableLastBodyTime ?? stateTime },
        spinner,
        visualTime,
        gameClockRate,
        this.primaryBeatmap?.appliedMods.includes("RELAX"),
      );
      rotationDegrees = (projected.totalAccumulatedRotation ?? 0) / gameClockRate;
    } else if (
      spinnerState?.tracking &&
      spinnerState.lastCursorAngle !== undefined &&
      stateTime !== undefined &&
      visualTime > stateTime &&
      frames &&
      frames.length > 1
    ) {
      const previousFrameIndex = findIndexInReplayAtTime(frames, visualTime);
      if (previousFrameIndex >= 0 && previousFrameIndex + 1 < frames.length) {
        const interpolatedPosition = interpolateReplayPosition(
          frames[previousFrameIndex],
          frames[previousFrameIndex + 1],
          visualTime,
        );
        rotationDegrees += normalizedSpinnerAngleDelta(
          spinnerCursorAngle(interpolatedPosition) - spinnerState.lastCursorAngle,
        );
      }
    }
    const progress = spinnerProgressForState(spinner, spinnerState);

    return {
      rotationDegrees,
      progress: Math.max(0, Math.min(1, progress)),
    };
  }

  getCurrentInfo() {
    return this.currentInfo;
  }

  private isCompletedSource(): boolean {
    if (!this.primaryReplay) return false;
    const sourceRuleset = isLazerReplay(this.primaryReplay) ? "lazer" : "stable";
    return this.rulesetFocus$.getValue() === sourceRuleset && this.currentPlaybackTime >= this.scoringEndTime;
  }

  getFinalInfoForRuleset(ruleset: ReplayAnalysisRuleset): GameplayInfo | undefined {
    if (ruleset === "lazer") {
      if (!this.lazerLastState) return undefined;
      return new LazerGameplayInfoEvaluator().evaluateReplayState(this.lazerLastState);
    }
    if (!this.primaryBeatmap || !this.primaryReplay || !this.lastState) return undefined;
    return new GameplayInfoEvaluator(this.primaryBeatmap, {}).evaluateReplayState(this.lastState);
  }

  getFinalScoreStatsForRuleset(ruleset: ReplayAnalysisRuleset): LiveReplayStats | undefined {
    const info = this.getFinalInfoForRuleset(ruleset);
    if (!info) return undefined;
    return liveReplayStatsAt(
      info,
      this.stableSliderBreakTimes,
      Number.POSITIVE_INFINITY,
      ruleset,
      this.mapMaxCombo[ruleset],
      this.sliderMissTimes,
    );
  }

  getCurrentScoreStats(): LiveReplayStats {
    const ruleset = this.rulesetFocus$.getValue();
    const sourceRuleset = this.primaryReplay && isLazerReplay(this.primaryReplay) ? "lazer" : "stable";
    const currentTime = Math.min(this.currentPlaybackTime, this.scoringEndTime);
    const isCompletedSource = ruleset === sourceRuleset && this.isCompletedSource();
    const info = isCompletedSource ? this.getCurrentInfo() : this.currentInfo;
    return liveReplayStatsAt(
      info,
      this.stableSliderBreakTimes,
      isCompletedSource ? Number.POSITIVE_INFINITY : currentTime,
      ruleset,
      this.mapMaxCombo[ruleset],
      this.sliderMissTimes,
    );
  }

  getPrimaryReplay() {
    return this.primaryReplay;
  }

  /** Immutable cumulative inputs built once when the primary replay is loaded. */
  getPerformanceInputs(): readonly ReplayPerformanceInput[] {
    return this.performanceInputs;
  }

  getLibraryReplayContext(): CurrentReplayCaptureContext | undefined {
    return this.libraryReplayCapture?.context;
  }

  isLibraryReplayCurrent(context: CurrentReplayCaptureContext): boolean {
    return this.libraryReplayCapture?.context === context;
  }

  /** Qualify the retained recording-profile state cooperatively. No replay simulation, cause
   * analysis, native request or library job is started; the foreground never awaits this path. */
  async captureLibraryNumerical(context: CurrentReplayCaptureContext, checkpoint: () => Promise<void>): Promise<CurrentReplayProjectedNumericalSnapshot> {
    const capture = this.libraryReplayCapture;
    const current = () => {
      if (!capture || this.libraryReplayCapture !== capture || capture.context !== context) throw new Error("Current replay changed during library capture");
    };
    const check = async () => { current(); await checkpoint(); current(); };
    await check();
    if (!capture) throw new Error("Current replay is unavailable");
    if (!capture.completed) {
      const projected = await projectLibraryNumerical(capture.beatmap, capture.replay, capture.scoring, capture.state,
        { ...context.binding, exactMapAndProfile: true }, check);
      await check();
      capture.completed = { status: "complete", projectionVersion: LIBRARY_NUMERIC_PROJECTION_VERSION, projected };
    }
    const projected = copyCurrentReplayNumericalProjection(context.binding, capture.completed.projected);
    if (!projected) throw new Error("Current replay numerical projection is incompatible");
    return { status: "complete", projectionVersion: LIBRARY_NUMERIC_PROJECTION_VERSION, projected };
  }

  getPrimaryBeatmap() {
    return this.primaryBeatmap;
  }

  clear() {
    this.libraryReplayGeneration++;
    this.libraryReplayCapture = undefined;
    this.clearMissExplanations();
    this.audioStableTimeMachine = undefined;
    this.audioLazerTimeMachine = undefined;
    this.gameplayTimeMachine = undefined;
    this.gameplayEvaluator = undefined;
    this.lazerTimeMachine = undefined;
    this.lazerGameplayEvaluator = undefined;
    this.currentState = undefined;
    this.lastState = undefined;
    this.lazerLastState = undefined;
    this.currentInfo = defaultGameplayInfo;
    this.judgements = [];
    this.hits = [];
    this.timingStatsCache = undefined;
    this.replayEvents$.next([]);
    this.mapMaxCombo = { stable: 0, lazer: 0 };
    this.stableSliderBreakTimes = [];
    this.sliderMissTimes = {
      stableSliderEnd: [],
      lazerSliderTick: [],
      lazerSliderEnd: [],
    };
    this.difficulties$.next([]);
    this.validation$.next(EMPTY_VALIDATION);
    this.stableValidation = EMPTY_VALIDATION;
    this.lazerValidation = EMPTY_VALIDATION;
    this.lazerAvailable$.next(false);
    this.rulesetFocus$.next("stable");
    this.replayComparison$.next(EMPTY_REPLAY_COMPARISON);
    this.primaryBeatmap = undefined;
    this.primaryReplay = undefined;
    this.performanceInputs = [];
    this.primaryStableEvents = [];
    this.primaryLazerEvents = [];
    this.stableHits = [];
    this.lazerHits = [];
    this.currentPlaybackTime = 0;
    this.scoringEndTime = 0;
  }

  private validateSimulation(
    replay: OsuReplay,
    simulatedCounts: number[],
    simulatedMaxCombo: number,
    context: ReplayValidationContext,
  ): ReplaySimulationValidation {
    const expected = replay.statistics;
    if (!expected) return { ...EMPTY_VALIDATION, simulatedCounts, simulatedMaxCombo };

    const expectedCounts = [expected.count300, expected.count100, expected.count50, expected.countMiss];
    const judgementTotalsMatch = expectedCounts.every((count, index) => count === simulatedCounts[index]);
    const missCountMatch = expected.countMiss === simulatedCounts[3];
    const maxComboMatch = expected.maxCombo === simulatedMaxCombo;
    const warnings: string[] = [];
    if (!judgementTotalsMatch) {
      warnings.push(
        `Judgement totals differ (source replay ${expectedCounts.join("/")}, raw reconstruction ${simulatedCounts.join(
          "/",
        )})`,
      );
    }
    if (!maxComboMatch) {
      warnings.push(`Max combo differs (source replay ${expected.maxCombo}, raw reconstruction ${simulatedMaxCombo})`);
    }
    if (replay.gameMode !== undefined && replay.gameMode !== 0) {
      warnings.push("Only osu!standard replay validation is supported");
    }
    return {
      verified: warnings.length === 0,
      judgementTotalsMatch,
      missCountMatch,
      maxComboMatch,
      expectedCounts,
      simulatedCounts,
      expectedMaxCombo: expected.maxCombo,
      simulatedMaxCombo,
      warnings,
      postFailureMisses: identifyPostFailureMisses(replay, simulatedCounts, simulatedMaxCombo, context),
    };
  }
}
