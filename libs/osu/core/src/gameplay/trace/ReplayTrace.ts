import { ErrorObservation } from "../error-analysis/ErrorObservations";
/** Observations of this model, never original-client or player-intent claims. */
export interface TraceRunIdentity {
  schemaVersion: 1 | 2;
  replayContentSha256: string | null;
  beatmapContentSha256: string | null;
  beatmapMd5: string | null;
  generationKey: string;
  recordingClient: string;
  analysisProfileId: string;
  analysisProfileFingerprint: string;
  parserVersion: string;
  inputPreparationVersion: string;
}
export type TraceSource =
  | { origin: "parsed"; parsedFrameIndex: number; rawTokenIndex?: number; discontinuityBefore?: string[] }
  | { origin: "synthetic"; reason: string }
  | { origin: "provided-frame"; preparedFrameIndex: number };
export interface ScoringDomain {
  endTimeMs: number;
  endpointBasis: "recorded-end" | "health-derived" | "aggregate-inferred";
  synthesizedEndpoint: boolean;
  sourceCoverageLimits: string[];
  /** In expanded input order, before native same-time grouping. No inferred raw indices. */
  frameSources?: TraceSource[];
  /** Only true when the caller can establish the state preceding the first input. */
  initialActionsKnown?: boolean;
  /** Adjacent raw action records bracket an interpolated cutoff. The successor
   * is provenance only: no position, evaluator input or post-cutoff opportunity. */
  endpointInputBracket?: {
    previous: EndpointActionSource;
    next: EndpointActionSource;
  };
}
export interface EndpointActionSource {
  timeMs: number;
  source: Extract<TraceSource,{origin:"parsed"}> & {rawTokenIndex:number};
  actions: number[];
  rawButtonMask: number;
}
export interface TraceLimits {
  maxRecords: number;
  maxExportBytes: number;
}
export type TraceChannel = "input" | "geometry" | "routing" | "lifecycle";
export type TerminalMechanism =
  | "input-miss"
  | "successful-input"
  | "automatic-expiry"
  | "ordered-force-miss"
  | "other-supported-resolution";
type Base = {
  id: string;
  timeMs: number;
  phase: "input" | "attempt" | "dispatch" | "resolution" | "coverage" | "lifecycle";
};
export type ReplayTraceObservation = Base &
  (
    | ErrorObservation
    | { kind: "lifecycle"; componentId: string; component: "circle" | "slider-head"; transition: "activated" }
    | {
        kind: "input";
        position: { x: number; y: number };
        previousActions: number[];
        actions: number[];
        freshActions: number[];
        rawButtonMask?: number;
        source: TraceSource;
        groupMemberIndex: number;
      }
    | {
        kind: "attempt";
        inputId: string;
        attemptOrdinal: number;
        actionCandidates: number[];
        knownAction?: number;
        /** V2 only: a ruleset-generated callback, never a physical action claim. */
        automated?: boolean;
      }
    | {
        kind: "selection";
        attemptId: string;
        componentId: string | null;
        component?: "circle" | "slider-head";
        inside: boolean | null;
        eligible: boolean;
        selectionStopped: boolean;
      }
    | {
        kind: "policy";
        attemptId: string;
        componentId: string;
        state: "allowed" | "rejected" | "not-queried";
        branch: string;
        blockerId?: string;
        timingResult: string | null;
        offsetMs: number;
      }
    | {
        kind: "resolution";
        componentId: string;
        component: "circle" | "slider-head";
        result: string;
        mechanism: TerminalMechanism;
        triggerAttemptId?: string;
        triggerResolutionId?: string;
        previousUnresolved: boolean;
      }
    | {
        kind: "coverage";
        channel: TraceChannel;
        status: "complete" | "partial" | "unsupported";
        reason: string;
        startTimeMs: number;
        endTimeMs: number;
      }
  );
export type ReplayTraceRecord = ReplayTraceObservation & { sequence: number };
export interface ReplayTrace {
  readonly identity: TraceRunIdentity;
  readonly domain: ScoringDomain;
  readonly records: readonly ReplayTraceRecord[];
  readonly coverage: Readonly<Record<TraceChannel, "complete" | "partial" | "unsupported">>;
  readonly complete: boolean;
  readonly failures: readonly string[];
  readonly droppedRecordBoundary?: number;
  readonly limits: TraceLimits;
}
export interface TraceCapture {
  readonly limits?: TraceLimits;
  readonly observationVersion?: 1 | 2;
  readonly domain: ScoringDomain;
  reserveId(): string;
  record(observation: ReplayTraceObservation): void;
  seal(): ReplayTrace;
  sealAsync(checkpoint: () => Promise<void>): Promise<ReplayTrace>;
  dispose(): void;
  /** Recording faults only; gameplay exceptions must propagate normally. */
  fail(reason: string): void;
}
