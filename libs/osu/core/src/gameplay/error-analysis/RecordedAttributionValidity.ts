import { CircleEvidence } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";

/** Validate the recorded facts used by an observation. Routing access and
 * hypothetical preservation are deliberately left to the later certifier. */
export function recordedAttributionFailure(
  evidence: CircleEvidence,
  trace: ReplayTrace | undefined,
  inputId: string,
  witnessIds: readonly string[],
  excluded: ReadonlySet<string>,
): string | undefined {
  if (
    !evidence.target ||
    !evidence.geometry ||
    !evidence.terminal ||
    evidence.limits.truncated ||
    evidence.status !== "supported"
  )
    return "recorded-target-evidence-unavailable";
  if (excluded.has(evidence.targetId)) return "excluded-target-evidence";
  if (trace && JSON.stringify(trace.identity) !== JSON.stringify(evidence.identity))
    return "recorded-trace-identity-mismatch";
  const press = evidence.inputs.find((i) => i.record.id === inputId);
  if (!press?.freshActionsKnown || press.postTerminal || press.record.freshActions.length !== 1)
    return "recorded-fresh-press-unavailable";
  const ids = new Set([inputId, ...witnessIds]);
  // An ordered point and its fresh action do not interpolate through the
  // preceding cursor jump. Movement witnesses still require continuity.
  const usesMovement = witnessIds.some((id) => id !== inputId);
  const witnesses = evidence.inputs.filter((i) => ids.has(i.record.id));
  const first = Math.min(...witnesses.map((i) => evidence.inputs.indexOf(i)));
  const last = Math.max(...witnesses.map((i) => evidence.inputs.indexOf(i)));
  if (first < 0 || last - first > 4096) return "recorded-witness-span-unavailable";
  const run = evidence.inputs.slice(first, last + 1);
  const same = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && a.every((x) => b.includes(x));
  for (let k = 0; k < run.length; k++) {
    const item = run[k],
      q = item.record,
      previous = run[k - 1]?.record;
    const adjacentBefore = k === 0 ? evidence.inputs[first - 1]?.record : previous;
    if (
      !item.freshActionsKnown ||
      ![q.timeMs, q.position.x, q.position.y].every(Number.isFinite) ||
      q.source.origin !== "parsed" ||
      !Number.isSafeInteger(q.source.parsedFrameIndex) ||
      q.source.parsedFrameIndex < 0 ||
      (q.source.rawTokenIndex !== undefined &&
        (!Number.isSafeInteger(q.source.rawTokenIndex) || q.source.rawTokenIndex < 0)) ||
      q.source.discontinuityBefore?.length ||
      [q.actions, q.previousActions, q.freshActions].some(
        (a) => new Set(a).size !== a.length || a.some((v) => v !== 0 && v !== 1),
      ) ||
      !same(
        q.freshActions,
        q.actions.filter((v) => !q.previousActions.includes(v)),
      ) ||
      (q.rawButtonMask !== undefined &&
        (!Number.isSafeInteger(q.rawButtonMask) ||
          q.rawButtonMask < 0 ||
          q.rawButtonMask > 31 ||
          !same(q.actions, [...(q.rawButtonMask & 5 ? [0] : []), ...(q.rawButtonMask & 10 ? [1] : [])])))
    )
      return "invalid-recorded-source-or-action";
    if (
      adjacentBefore?.source.origin === "parsed" &&
      q.source.origin === "parsed" &&
      q.source.parsedFrameIndex === adjacentBefore.source.parsedFrameIndex + 1 &&
      !same(q.previousActions, adjacentBefore.actions)
    )
      return "recorded-previous-action-mismatch";
    if (
      usesMovement &&
      adjacentBefore &&
      adjacentBefore.timeMs === q.timeMs &&
      (adjacentBefore.position.x !== q.position.x || adjacentBefore.position.y !== q.position.y)
    )
      return "recorded-leading-position-discontinuity";
    if (trace && JSON.stringify(trace.records[q.sequence]) !== JSON.stringify(q))
      return "recorded-input-trace-mismatch";
    if (
      previous &&
      (previous.source.origin !== "parsed" ||
        q.sequence <= previous.sequence ||
        q.timeMs < previous.timeMs ||
        q.source.parsedFrameIndex !== previous.source.parsedFrameIndex + 1 ||
        !same(q.previousActions, previous.actions) ||
        (q.timeMs === previous.timeMs &&
          (q.position.x !== previous.position.x || q.position.y !== previous.position.y)) ||
        ((q.source.rawTokenIndex !== undefined || previous.source.rawTokenIndex !== undefined) &&
          (q.source.rawTokenIndex === undefined ||
            previous.source.rawTokenIndex === undefined ||
            q.source.rawTokenIndex !== previous.source.rawTokenIndex + 1)))
    )
      return "recorded-source-continuity-unavailable";
  }
  if (
    trace &&
    JSON.stringify(trace.records[evidence.terminal.sequence]) !== JSON.stringify(evidence.terminal)
  )
    return "recorded-terminal-trace-mismatch";
  return undefined;
}
