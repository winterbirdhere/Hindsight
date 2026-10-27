import type { LibraryErrorStrip } from "./library-error-strip";
/** A result's availability is independent of its job's current state and background mode. */
export type LibraryMetricValue<T> = { state: "known"; value: T }
  | { state: "unknown" | "not-applicable" | "error"; reason: string };
export type LibraryMetricStage = "H" | "P" | "S" | "C";
export type LibraryMetricSlot = "source-score" | "source-map" | "calculated-map" | "aggregate-pp"
  | "numerical" | "timeline-pp" | "fc-pp" | "incidents";
export type LibraryAnalysisReason = "selection" | "open" | "background" | "retry";
/** Internal durable improvement of an existing numerical strip; never public preparation intent. */
export type LibraryMetricJobReason = LibraryAnalysisReason | "strip-repair";
export interface LibraryAnalysisSettings {
  mode: "bg" | "demand" | "off";
  userPaused: boolean;
  workers: 1 | 2 | 4;
  pauseOnBattery: boolean;
  /** Opt-in library yielding policy; absent means conservative. Stored separately for legacy readers. */
  fasterProcessing?: boolean;
}
/** Live work reservations and recorded intent, not unique replays or a fixed batch.
 * P/S preparation and metric slots are separate work items. Preparation can create
 * further work, so these counts have no completion denominator. Missing values do
 * not imply queued work; bound preparation is not numerical completion. */
export interface LibraryAnalysisActivity {
  unit: "work-items";
  queued: number;
  /** Queued preparation requests, not evidence that an input file is missing. */
  awaitingInputs: number;
  /** Recorded work waiting on enabled sources or an admitting analysis mode. */
  deferred: number;
  failed: number;
  /** Disjoint current execution reservations; held/retiring are not running. */
  running: number; held: number; retiring: number;
  mode: LibraryAnalysisSettings["mode"];
  userPaused: boolean; viewerHold: boolean; batteryHold: boolean; resumePending: boolean;
  error?: string;
}
export type LibraryCompletion = LibraryMetricValue<"passed" | "failed">;
export interface LibraryMetricTargetInput {
  replayId: string; slot: LibraryMetricSlot; stage: LibraryMetricStage; inputKey: string; producerVersion: string;
}
export interface LibraryMetricTarget extends LibraryMetricTargetInput { generation: number }
export interface LibraryMetricTicket extends LibraryMetricTarget { attempt: string }
export interface LibraryMetricResult {
  /** Numerical publication only; scalar reads deliberately omit this separately stored payload. */
  errorStrip?:LibraryMetricValue<LibraryErrorStrip>;
  /** Small versioned evidence identifiers; no persistent error causes or raw replay frames. */
  provenance: Record<string, string | number | boolean | null>;
  fields: Record<string, LibraryMetricValue<string | number | boolean>>;
}
export interface LibraryMetricPatch {
  errorStrip?:LibraryMetricValue<LibraryErrorStrip>;
  ticket: LibraryMetricTicket; producerVersion: string;
  /** Small versioned evidence identifiers; no persistent error causes or raw replay frames. */
  provenance: Record<string, string | number | boolean | null>;
  fields: Record<string, LibraryMetricValue<string | number | boolean>>;
}
export interface LibraryMetricJob {
  id: string; target: LibraryMetricTarget; reason: LibraryMetricJobReason;
  state: "queued" | "running" | "failed"; error?: string;
}
export interface LibraryMetricEntry {
  target: LibraryMetricTarget; result?: LibraryMetricResult; job?: LibraryMetricJob;
}
export interface LibraryErrorStripEntry {
  target:LibraryMetricTarget;result?:LibraryMetricValue<LibraryErrorStrip>;job?:LibraryMetricJob;
}
