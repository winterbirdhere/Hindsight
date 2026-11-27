import type { EvidenceBasis, MissDescriptorCode, MissFinding, MissExplanation, ReplayTraceRecord } from "@osujs/core";

const descriptions: Record<MissDescriptorCode, readonly [string, string]> = {
  "input-miss": ["input-triggered Miss", "The model judged a Miss from an input."],
  "automatic-expiry": ["automatic expiry", "The circle expired unresolved in the model."],
  "ordered-force-miss": ["ordered forced Miss", "A later judgement forced this circle to Miss in the model."],
  "dispatch-stopped": ["dispatch to another target", "An in-circle input was routed to another target in the model."],
  "order-blocked": ["object-order rejection", "The model blocked this attempt under its object-order policy."],
  "press-outside": ["outside-circle action", "A fresh logical action occurred outside this circle."],
  "no-fresh-action": [
    "absence of a fresh action",
    "No fresh logical action occurred in the covered live success window.",
  ],
  "all-fresh-actions-outside": [
    "all actions outside the circle",
    "All fresh logical actions in the covered live success window were outside this circle.",
  ],
  "entry-after-press": ["entry after an action", "The reconstructed path enters the circle after this action."],
  "exit-before-press": ["exit before an action", "The reconstructed path leaves the circle before this action."],
  "overlap-without-fresh-action": [
    "overlap without a fresh action",
    "The reconstructed path overlaps the live success window without an in-circle fresh action.",
  ],
};
const provenance: Record<EvidenceBasis, string> = {
  recorded: "Recorded input samples",
  "model-trace": "Model trace",
  "reconstructed-path": "Reconstructed path; motion between samples is approximate",
  "independent-client-observation": "Independent client observation",
};
const parameterLabels: Record<string, string> = {
  offsetMs: "Action offset from object time",
  deltaMs: "Time difference",
  crossingTimeMs: "Crossing time",
  domainStartTimeMs: "Live success window start",
  domainEndTimeMs: "Live success window end",
  freshActionCount: "Fresh logical actions",
  intervalCount: "Reconstructed intervals",
};
export function formatMissFinding(finding: MissFinding) {
  const [label, statement] = descriptions[finding.code];
  const text = !finding.applicable
    ? `Not applicable: ${label}.`
    : finding.state === "supported"
    ? statement
    : finding.state === "not-supported"
    ? `Not supported by this evidence: ${label}.`
    : `Unavailable from this evidence: ${label}.`;
  const measurements = Object.entries(finding.parameters).flatMap(([key, value]) => {
    if (key === "postTerminal") return value === 1 ? ["After the target resolved"] : [];
    if (key === "approximate") return value === 1 ? ["Approximate reconstructed crossing"] : [];
    if (key === "inLiveSuccess")
      return [value === 1 ? "Inside the live success window" : "Outside the live success window"];
    return [`${parameterLabels[key] ?? key}: ${value}${key.endsWith("Ms") ? " ms (beatmap time)" : ""}`];
  });
  return {
    text,
    measurements,
    provenance: finding.bases.map((basis) => provenance[basis]),
    limitations: finding.reasons,
  };
}
export interface MissHeadlineContext {
  /** Existing references plus this target's activation/resolution, never newly derived evidence. */
  records: ReadonlyMap<string, ReplayTraceRecord>;
  lifecycleComplete: boolean;
}

/** Presentation policy only. mainFindingId, finding order and exported evidence stay untouched.
 * Without scope context only supported terminal observations can be summarized. */
export function summarizeMissExplanation(explanation: MissExplanation, context?: MissHeadlineContext): string {
  const unavailable = "No supported explanation is available for this circle.";
  if (explanation.status !== "supported") return unavailable;
  const valid = (f: MissFinding) =>
    f.applicable &&
    f.state === "supported" &&
    f.parameters.postTerminal !== 1 &&
    !f.reasons.length &&
    f.dependencies.every(
      (d) => !explanation.limitations.includes(`dependency-conflict:${d}:${explanation.targetId}`),
    ) &&
    (!context || f.eventIds.every((id) => context.records.has(id)));
  const terminalFinding = explanation.findings.find((f) => {
    if (!["input-miss", "ordered-force-miss", "automatic-expiry"].includes(f.code) || !valid(f)) return false;
    if (!context) return true;
    const terminal = context.records.get(f.eventIds[0]);
    if (
      terminal?.kind !== "resolution" ||
      terminal.componentId !== explanation.targetId ||
      terminal.component !== "circle" ||
      terminal.result !== "MISS" ||
      terminal.mechanism !== f.code
    )
      return false;
    if (f.code === "input-miss") {
      const attempt = terminal.triggerAttemptId && context.records.get(terminal.triggerAttemptId);
      const input = attempt && attempt.kind === "attempt" && context.records.get(attempt.inputId);
      return !!(
        attempt &&
        attempt.kind === "attempt" &&
        input &&
        input.kind === "input" &&
        input.freshActions.length &&
        f.eventIds.includes(attempt.id) &&
        f.eventIds.includes(input.id) &&
        input.sequence < attempt.sequence &&
        attempt.sequence < terminal.sequence &&
        input.timeMs === terminal.timeMs &&
        attempt.timeMs === terminal.timeMs
      );
    }
    if (f.code === "ordered-force-miss") {
      const trigger = terminal.triggerResolutionId && context.records.get(terminal.triggerResolutionId);
      // Native force resolutions are emitted before their reserved triggering resolution.
      return !!(
        trigger &&
        trigger.kind === "resolution" &&
        trigger.componentId !== explanation.targetId &&
        trigger.timeMs === terminal.timeMs &&
        f.eventIds.includes(trigger.id)
      );
    }
    return true;
  });
  if (!terminalFinding) return unavailable;
  const fallback = formatMissFinding(terminalFinding).text;
  if (terminalFinding.code !== "automatic-expiry" || !context?.lifecycleComplete) return fallback;
  const terminal = context.records.get(terminalFinding.eventIds[0]);
  const activation = Array.from(context.records.values()).find(
    (r) => r.kind === "lifecycle" && r.componentId === explanation.targetId && r.component === "circle",
  );
  if (!terminal || !activation || activation.sequence >= terminal.sequence || activation.timeMs > terminal.timeMs)
    return fallback;
  const range = (f: MissFinding) => {
    const { domainStartTimeMs: start, domainEndTimeMs: end } = f.parameters;
    return f.applicable &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start <= end &&
      start >= activation.timeMs &&
      end <= terminal.timeMs
      ? [start, end]
      : undefined;
  };
  // Domain parameters are already established by extraction even when action coverage is partial.
  const domains = explanation.findings
    .filter((f) => ["no-fresh-action", "all-fresh-actions-outside"].includes(f.code))
    .map(range)
    .filter((r): r is number[] => !!r);
  if (!domains.length) return fallback;
  const [start, end] = domains[0];
  const conflict = `${fallback} Window evidence conflicts; see the detailed findings.`;
  if (domains.some((r) => r[0] !== start || r[1] !== end)) return conflict;
  const inWindow = (r: ReplayTraceRecord) =>
    r.timeMs >= start && r.timeMs <= end && r.sequence > activation.sequence && r.sequence < terminal.sequence;
  const sameWindow = (f: MissFinding) => {
    const r = range(f);
    return !!r && r[0] === start && r[1] === end;
  };
  const eligible = explanation.findings.filter(valid);
  const routes = eligible.filter((f) => {
    if (f.code !== "dispatch-stopped" && f.code !== "order-blocked") return false;
    const [input, attempt, route] = f.eventIds.map((id) => context.records.get(id));
    if (
      input?.kind !== "input" ||
      attempt?.kind !== "attempt" ||
      !route ||
      !input.freshActions.length ||
      attempt.inputId !== input.id ||
      ![input, attempt, route].every(inWindow) ||
      input.sequence >= attempt.sequence ||
      attempt.sequence >= route.sequence ||
      input.timeMs !== attempt.timeMs ||
      attempt.timeMs !== route.timeMs
    )
      return false;
    return f.code === "dispatch-stopped"
      ? route.kind === "selection" &&
          route.attemptId === attempt.id &&
          route.componentId !== null &&
          route.componentId !== explanation.targetId &&
          route.inside === true &&
          route.eligible &&
          route.selectionStopped
      : route.kind === "policy" &&
          route.attemptId === attempt.id &&
          route.componentId === explanation.targetId &&
          route.state === "rejected";
  });
  const outside = eligible.filter((f) => {
    const input = context.records.get(f.eventIds[0]);
    return (
      f.code === "press-outside" &&
      f.parameters.inLiveSuccess === 1 &&
      input?.kind === "input" &&
      input.freshActions.length > 0 &&
      inWindow(input)
    );
  });
  const whole = eligible.filter((f) => {
    if (
      !["no-fresh-action", "all-fresh-actions-outside", "overlap-without-fresh-action"].includes(f.code) ||
      !sameWindow(f)
    )
      return false;
    const count = f.parameters.freshActionCount;
    if (!Number.isSafeInteger(count) || count < 0) return false;
    const refs = f.eventIds.map((id) => context.records.get(id));
    if (!refs.every((r) => r?.kind === "input" || r === activation || r === terminal)) return false;
    const inputs = Array.from(
      new Set(refs.filter((r): r is Extract<ReplayTraceRecord, { kind: "input" }> => r?.kind === "input")),
    );
    if (f.code === "overlap-without-fresh-action")
      return (
        count === 0 &&
        f.parameters.intervalCount > 0 &&
        f.bases.includes("reconstructed-path") &&
        inputs.some((right, index) => {
          const left = inputs[index - 1];
          // Check witness scope/continuity only; containment and crossings remain the cached predicate's responsibility.
          return (
            left &&
            left.source.origin === "parsed" &&
            right.source.origin === "parsed" &&
            right.source.parsedFrameIndex === left.source.parsedFrameIndex + 1 &&
            !right.source.discontinuityBefore?.length &&
            left.sequence < right.sequence &&
            left.timeMs < right.timeMs &&
            left.sequence < terminal.sequence &&
            right.sequence > activation.sequence &&
            Math.min(right.timeMs, end) > Math.max(left.timeMs, start)
          );
        })
      );
    return (
      inputs.every(inWindow) &&
      inputs.reduce((n, r) => n + r.freshActions.length, 0) === count &&
      (f.code === "no-fresh-action" ? count === 0 : count > 0)
    );
  });
  const has = (code: MissDescriptorCode) => whole.some((f) => f.code === code);
  if (
    (routes.length > 0 && whole.length > 0) ||
    (has("no-fresh-action") && (has("all-fresh-actions-outside") || outside.length > 0)) ||
    whole.some((f) =>
      explanation.findings.some(
        (other) => other.code === f.code && other.applicable && other.state === "not-supported" && sameWindow(other),
      ),
    )
  )
    return conflict;
  const statements: string[] = [];
  if (routes.some((f) => f.code === "dispatch-stopped"))
    statements.push(
      "In the model, at least one in-circle action in the live success window was routed to another object.",
    );
  if (routes.some((f) => f.code === "order-blocked"))
    statements.push("In the model, at least one attempt in the live success window was blocked by object order.");
  if (routes.length && outside.length)
    statements.push("At least one fresh action in that window was outside the circle.");
  if (has("no-fresh-action"))
    statements.push("No fresh logical action was recorded in the model's covered live success window.");
  if (has("all-fresh-actions-outside"))
    statements.push(
      "All recorded fresh logical actions in the model's covered live success window were outside this circle.",
    );
  if (has("overlap-without-fresh-action"))
    statements.push(
      "The approximate reconstructed path overlaps the live success window without an in-circle fresh action.",
    );
  return statements.join(" ") || fallback;
}
