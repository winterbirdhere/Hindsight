import type { LibraryAnalysisReason, LibraryAnalysisSettings, LibraryMetricPatch, LibraryMetricTarget, LibraryMetricSlot,
  LibraryMetricTargetInput, LibraryMetricTicket } from "../../../../shared/replay-library-metrics";
import { LibraryMetricStore,LibraryTimelineOutcome } from "./library-metric-store";

export const LIBRARY_METRIC_OPERATIONS = ["metric-settings", "metric-read", "metric-strip-read", "metric-target", "metric-request", "metric-next",
  "metric-claim", "metric-commit", "metric-numerical-handoff", "metric-timeline-handoff", "metric-fc-handoff", "metric-fail", "metric-release"] as const;
export type LibraryMetricOperation = typeof LIBRARY_METRIC_OPERATIONS[number];
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Main→utility only. All target/result validation and atomic ownership checks stay in the store. */
export class LibraryMetricApi {
  constructor(private readonly store: LibraryMetricStore) {}
  receive(method: LibraryMetricOperation, args: Record<string, unknown>): unknown {
    if (method === "metric-settings") {
      if (args.settings !== undefined) this.store.setAnalysisSettings(args.settings as LibraryAnalysisSettings);
      return this.store.analysisSettings();
    }
    if (method === "metric-read"||method==="metric-strip-read") {
      if (!text(args.replayId)) throw new Error("Invalid metric replay identity");
      return method==="metric-read"?this.store.read(args.replayId):this.store.readErrorStrip(args.replayId);
    }
    if (method === "metric-next") return this.store.nextQueued(args.limit as number | undefined, args.includeNative as boolean | undefined,args.availableSlots as LibraryMetricSlot[]|undefined);
    if (method === "metric-target" || method === "metric-request") {
      if (!object(args.target) || args.target.stage === "H") throw new Error("Invalid analysis target");
      return method === "metric-target" ? this.store.setTarget(args.target as unknown as LibraryMetricTargetInput)
        : this.store.request(args.target as unknown as LibraryMetricTarget, args.reason as LibraryAnalysisReason);
    }
    if (method === "metric-claim") {
      if (!text(args.jobId)) throw new Error("Invalid metric job identity"); return this.store.claim(args.jobId);
    }
    if (method === "metric-commit"||method==="metric-numerical-handoff") {
      if (!object(args.patch) || !object(args.patch.ticket)) throw new Error("Invalid metric patch");
      return method==="metric-numerical-handoff"?this.store.commitAndClaimTimeline(args.patch as unknown as LibraryMetricPatch):this.store.commit(args.patch as unknown as LibraryMetricPatch);
    }
    if (!object(args.ticket)) throw new Error("Invalid metric ticket");
    if(method==="metric-timeline-handoff")return this.store.finishTimelineAndClaimFc(args.ticket as unknown as LibraryMetricTicket,args.outcome as LibraryTimelineOutcome);
    if(method==="metric-fc-handoff")return this.store.finishFcAndClaimIncidents(args.ticket as unknown as LibraryMetricTicket,args.outcome as LibraryTimelineOutcome);
    if (method === "metric-release") return this.store.release(args.ticket as unknown as LibraryMetricTicket);
    if (method === "metric-fail") return this.store.fail(args.ticket as unknown as LibraryMetricTicket, args.error as string);
    throw new Error("Unknown metric operation");
  }
}
