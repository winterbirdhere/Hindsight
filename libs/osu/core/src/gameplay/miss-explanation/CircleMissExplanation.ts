import { CircleEvidence, PredicateState, assessFreshActionAbsence } from "./CircleEvidence";
import { TraceChannel, TraceRunIdentity } from "../trace/ReplayTrace";

export type MissDescriptorCode =
  | "press-outside"
  | "entry-after-press"
  | "exit-before-press"
  | "overlap-without-fresh-action"
  | "all-fresh-actions-outside"
  | "no-fresh-action"
  | "input-miss"
  | "automatic-expiry"
  | "ordered-force-miss"
  | "dispatch-stopped"
  | "order-blocked";
export type EvidenceBasis = "recorded" | "reconstructed-path" | "model-trace" | "independent-client-observation";
export interface MissFinding {
  id: string;
  code: MissDescriptorCode;
  applicable: boolean;
  state: PredicateState;
  bases: EvidenceBasis[];
  eventIds: string[];
  dependencies: TraceChannel[];
  parameters: Record<string, number>;
  reasons: string[];
}
export interface MissExplanation {
  schemaVersion: 1;
  identity: TraceRunIdentity;
  targetId: string;
  status: CircleEvidence["status"];
  mainFindingId?: string;
  findings: MissFinding[];
  limitations: string[];
}
const MAX_FINDINGS = 512;

/** Findings describe separate supported relationships, never unique intent or blame. */
export function explainCircleMiss(evidence: CircleEvidence): MissExplanation {
  const result: MissExplanation = {
    schemaVersion: 1,
    identity: evidence.identity,
    targetId: evidence.targetId,
    status: evidence.status,
    findings: [],
    limitations: [...evidence.limitations],
  };
  if (evidence.status !== "supported" || !evidence.target) return result;
  let reservedSummarySlots = 3;
  const inputConflict = evidence.dependencies.input.reasons.some((reason) => reason.startsWith("dependency-conflict:"));
  const add = (
    code: MissDescriptorCode,
    eventIds: string[],
    dependencies: TraceChannel[],
    parameters: Record<string, number> = {},
    bases: EvidenceBasis[] = ["model-trace"],
    state: PredicateState = "supported",
    applicable = true,
    reasons: string[] = [],
  ) => {
    if (result.findings.length >= MAX_FINDINGS - reservedSummarySlots) {
      if (!result.limitations.includes("finding-limit:512")) result.limitations.push("finding-limit:512");
      return;
    }
    const ids = Array.from(new Set(eventIds));
    const id = `${evidence.targetId}:${code}:${ids.join(",") || "domain"}`;
    if (result.findings.some((finding) => finding.id === id)) return;
    const dependentReasons =
      state === "indeterminate" ? dependencies.flatMap((channel) => evidence.dependencies[channel].reasons) : [];
    result.findings.push({
      id,
      code,
      applicable,
      state,
      bases,
      eventIds: ids,
      dependencies,
      parameters,
      reasons: Array.from(new Set([...reasons, ...dependentReasons])),
    });
  };
  const terminal = evidence.terminal;
  if (terminal && ["input-miss", "automatic-expiry", "ordered-force-miss"].includes(terminal.mechanism)) {
    const triggerInput = evidence.terminalReferences.find((record) => record.kind === "input");
    const reasons = evidence.dependencies.lifecycle.reasons.filter(
      (reason) => reason.startsWith("dependency-conflict:") || reason === "missing-terminal-reference",
    );
    add(
      terminal.mechanism as MissDescriptorCode,
      [terminal.id, ...evidence.terminalReferences.map((record) => record.id)],
      ["lifecycle"],
      terminal.mechanism === "input-miss" && triggerInput
        ? { offsetMs: triggerInput.timeMs - evidence.target.hitTimeMs }
        : {},
      ["model-trace"],
      reasons.length ? "indeterminate" : "supported",
      true,
      reasons,
    );
  }
  const inputs = new Map(evidence.inputs.map((input) => [input.record.id, input]));
  const attempts = new Map(evidence.attempts.map((attempt) => [attempt.id, attempt]));
  for (const route of evidence.routing) {
    const attempt = attempts.get(route.attemptId),
      input = attempt && inputs.get(attempt.inputId);
    if (!attempt || !input) continue;
    const routeState = evidence.dependencies.routing.reasons.some((reason) => reason.startsWith("dependency-conflict:"))
      ? "indeterminate"
      : "supported";
    if (route.kind === "policy" && route.componentId === evidence.targetId && route.state === "rejected")
      add(
        "order-blocked",
        [input.record.id, attempt.id, route.id],
        ["routing"],
        { offsetMs: route.offsetMs },
        ["model-trace"],
        routeState,
      );
    else if (
      input.inInteraction &&
      (evidence.domains.interaction.start?.sequence === undefined ||
        attempt.sequence > evidence.domains.interaction.start.sequence) &&
      (!terminal || route.sequence < terminal.sequence) &&
      route.kind === "selection" &&
      route.componentId !== null &&
      route.componentId !== evidence.targetId &&
      route.selectionStopped &&
      input.inside
    )
      add(
        "dispatch-stopped",
        [input.record.id, attempt.id, route.id],
        ["input", "routing", "geometry", "lifecycle"],
        { offsetMs: input.record.timeMs - evidence.target.hitTimeMs },
        ["model-trace", "recorded"],
        evidence.dependencies.geometry.status !== "complete" || inputConflict ? "indeterminate" : routeState,
        true,
        ["input", "routing", "geometry", "lifecycle"].flatMap((channel) =>
          evidence.dependencies[channel as TraceChannel].reasons.filter((reason) =>
            reason.startsWith("dependency-conflict:"),
          ),
        ),
      );
  }
  const fresh = evidence.inputs.filter((input) => input.freshActionsKnown && input.record.freshActions.length > 0);
  for (const input of fresh) {
    // Adjacent samples are retained to reconstruct boundary crossings. They
    // are not automatically a relevant press for this target.
    if (
      input.record.timeMs < evidence.target.spawnTimeMs ||
      (input.record.timeMs > evidence.domains.nominalSuccess.end!.timeMs && !input.inInteraction)
    )
      continue;
    if (input.inside) continue;
    const bases: EvidenceBasis[] = ["recorded", "model-trace"];
    const state =
      evidence.dependencies.geometry.status === "complete" && !inputConflict ? "supported" : "indeterminate";
    add(
      "press-outside",
      [input.record.id],
      ["input", "geometry"],
      {
        offsetMs: input.record.timeMs - evidence.target.hitTimeMs,
        postTerminal: input.postTerminal ? 1 : 0,
        inLiveSuccess: input.inLiveSuccess ? 1 : 0,
      },
      bases,
      state,
    );
    const intervals = evidence.insideIntervals.filter(
      (interval) => interval.pathGroup === input.pathGroup && interval.kind === "interval",
    );
    const next = intervals.find((interval) => !interval.leftCensored && interval.startTimeMs > input.record.timeMs);
    const previous = intervals
      .filter((interval) => !interval.rightCensored && interval.endTimeMs < input.record.timeMs)
      .pop();
    if (next)
      add(
        "entry-after-press",
        [input.record.id, ...next.eventIds],
        ["geometry", "input"],
        {
          deltaMs: next.startTimeMs - input.record.timeMs,
          crossingTimeMs: next.startTimeMs,
          approximate: 1,
          postTerminal: next.postTerminal ? 1 : 0,
        },
        [...bases, "reconstructed-path"],
        state,
      );
    if (previous)
      add(
        "exit-before-press",
        [input.record.id, ...previous.eventIds],
        ["geometry", "input"],
        {
          deltaMs: input.record.timeMs - previous.endTimeMs,
          crossingTimeMs: previous.endTimeMs,
          approximate: 1,
          postTerminal: input.postTerminal ? 1 : 0,
        },
        [...bases, "reconstructed-path"],
        state,
      );
  }
  reservedSummarySlots = 0;
  const liveFresh = inputConflict ? [] : fresh.filter((input) => input.inLiveSuccess);
  const count = liveFresh.reduce((sum, input) => sum + input.record.freshActions.length, 0);
  const coverage = evidence.dependencies.input.status === "complete" ? "complete" : "partial";
  const absence = assessFreshActionAbsence({
    domain: evidence.domains.liveSuccess.state,
    actionCoverage: coverage,
    freshActionCount: count,
  });
  const live = evidence.domains.liveSuccess;
  const domainParameters: Record<string, number> =
    live.start && live.end ? { domainStartTimeMs: live.start.timeMs, domainEndTimeMs: live.end.timeMs } : {};
  const domainEvents = [live.start?.eventId, live.end?.eventId].filter((id): id is string => id !== undefined);
  add(
    "no-fresh-action",
    [...domainEvents, ...liveFresh.map((input) => input.record.id)],
    ["input", "lifecycle"],
    { freshActionCount: count, ...domainParameters },
    ["recorded", "model-trace"],
    absence.state,
    absence.applicable,
    absence.reasons,
  );
  const applicable = evidence.domains.liveSuccess.state === "nonempty" && count > 0;
  const allOutside: PredicateState =
    !applicable || evidence.dependencies.geometry.status !== "complete"
      ? "indeterminate"
      : liveFresh.some((input) => input.inside)
      ? "not-supported"
      : coverage === "complete" && evidence.dependencies.geometry.status === "complete"
      ? "supported"
      : "indeterminate";
  add(
    "all-fresh-actions-outside",
    [...domainEvents, ...liveFresh.map((input) => input.record.id)],
    ["input", "geometry", "lifecycle"],
    { freshActionCount: count, ...domainParameters },
    ["recorded", "model-trace"],
    allOutside,
    applicable,
    !applicable ? ["nonempty-action-domain-required"] : [],
  );
  if (live.state === "nonempty" && live.start && live.end) {
    const overlaps = evidence.insideIntervals.filter(
      (interval) =>
        interval.kind === "interval" &&
        Math.min(interval.endTimeMs, live.end!.timeMs) > Math.max(interval.startTimeMs, live.start!.timeMs),
    );
    if (overlaps.length) {
      const insideActions = liveFresh.filter((input) => input.inside);
      add(
        "overlap-without-fresh-action",
        [...overlaps.flatMap((interval) => interval.eventIds), ...insideActions.map((input) => input.record.id)],
        ["input", "geometry", "lifecycle"],
        {
          intervalCount: overlaps.length,
          freshActionCount: insideActions.reduce((n, input) => n + input.record.freshActions.length, 0),
          ...domainParameters,
        },
        ["recorded", "model-trace", "reconstructed-path"],
        evidence.dependencies.geometry.status !== "complete" || inputConflict
          ? "indeterminate"
          : insideActions.length
          ? "not-supported"
          : coverage === "complete"
          ? "supported"
          : "indeterminate",
      );
    }
  }
  // Later context stays inspectable, but cannot headline an earlier resolution.
  result.mainFindingId = result.findings.find(
    (finding) => finding.state === "supported" && finding.parameters.postTerminal !== 1,
  )?.id;
  return result;
}
