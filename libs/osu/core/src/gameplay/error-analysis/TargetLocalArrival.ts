import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { CircleEvidence, CircleInputEvidence, deriveCircleEvidence } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import type { PrimaryInputEvidence } from "./PrimaryInputEvidence";

/** A target movement fact; the earlier consumed presses are never reassigned. */
export interface TargetLocalArrival {
  basis: "recorded-target-passage-after-best-window";
  inputIds: [];
  entryTimeMs: number;
  entryOffsetMs: number;
  bracketIds: [string, string];
  insideInputId: string;
  minimumBestWindowR: number;
  approachProgressR: number;
  consumed: Array<{ inputId: string; componentId: string; resolutionId: string }>;
  eventIds: string[];
}
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));
const receiptCounts = new WeakMap<ReplayTrace, { attempts: Map<string, number>; components: Map<string, number> }>();
function counts(trace: ReplayTrace) {
  let value = receiptCounts.get(trace);
  if (!value) {
    value = { attempts: new Map(), components: new Map() };
    for (const r of trace.records)
      if (r.kind === "resolution") {
        value.components.set(r.componentId, (value.components.get(r.componentId) ?? 0) + 1);
        if (r.triggerAttemptId)
          value.attempts.set(r.triggerAttemptId, (value.attempts.get(r.triggerAttemptId) ?? 0) + 1);
      }
    receiptCounts.set(trace, value);
  }
  return value;
}

/** Positive late entry when the ordinary press-owned path has no target press.
 * Complete raw actions and exact earlier success receipts are prerequisites,
 * not an absence claim. On-time passages, residual attempts and ambiguous
 * ownership still require their own comparison. */
export function deriveTargetLocalArrival(
  e: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace,
  association: PrimaryInputEvidence,
  excluded?: ReadonlySet<string>,
): TargetLocalArrival | undefined {
  const {
    target,
    geometry: g,
    terminal,
    domains: { liveSuccess: live },
  } = e;
  if (
    !target ||
    !g ||
    !terminal ||
    terminal.result !== "MISS" ||
    terminal.mechanism !== "automatic-expiry" ||
    !terminal.previousUnresolved ||
    e.status !== "supported" ||
    e.limits.truncated ||
    e.inputs.length > 4096 ||
    e.directRejections.length ||
    Object.values(e.dependencies).some((d) => d.status !== "complete") ||
    live.state !== "nonempty" ||
    !live.start ||
    !live.end ||
    association.relevantInputIds.length ||
    association.associations.some((a) => a.role !== "context") ||
    association.missingAction ||
    association.stream?.missingTargetTap
  )
    return;
  const conflicts = [...trace.failures, ...trace.domain.sourceCoverageLimits];
  const conflicted = (id: string) =>
    excluded?.has(id) || conflicts.some((r) => r.startsWith("dependency-conflict:") && r.endsWith(":" + id));
  const object = map.getHitObject(e.targetId);
  if (!(object instanceof HitCircle) || conflicted(object.id) || (object.sliderId && conflicted(object.sliderId)))
    return;
  const receiptCount = counts(trace);
  if (receiptCount.components.get(e.targetId) !== 1) return;
  const best = g.hitWindows[0],
    bestStart = target.hitTimeMs - best,
    bestEnd = target.hitTimeMs + best;
  if (
    !(best > 0) ||
    !Number.isFinite(g.radius) ||
    !(g.radius > 0) ||
    live.start.timeMs > bestStart ||
    live.end.timeMs < bestEnd
  )
    return;
  const fresh = e.inputs.filter((i) => i.inLiveSuccess && !i.postTerminal && i.record.freshActions.length);
  if (!fresh.length || fresh.length > 128 || fresh.some((i) => i.inside || i.record.timeMs > bestEnd)) return;
  const first = e.inputs.findIndex((i) => i.record.timeMs >= live.start!.timeMs),
    finish = e.inputs.findIndex((i) => i.record.timeMs >= live.end!.timeMs);
  if (first < 1 || finish < first) return;
  const bridge = e.inputs.slice(first - 1, finish + 1),
    eventIds: string[] = [],
    consumed: TargetLocalArrival["consumed"] = [];
  if (bridge[0].record.timeMs > live.start.timeMs || bridge[bridge.length - 1].record.timeMs < live.end.timeMs) return;
  for (let k = 0; k < bridge.length; k++) {
    const i = bridge[k],
      r = i.record,
      p = bridge[k - 1]?.record,
      s = r.source;
    if (
      !i.freshActionsKnown ||
      s.origin !== "parsed" ||
      s.discontinuityBefore?.length ||
      !Number.isSafeInteger(s.parsedFrameIndex) ||
      s.parsedFrameIndex < 0 ||
      !Number.isFinite(r.timeMs) ||
      !Number.isFinite(r.position.x) ||
      !Number.isFinite(r.position.y) ||
      !Number.isSafeInteger(r.sequence) ||
      r.sequence < 0 ||
      [r.actions, r.previousActions, r.freshActions].some(
        (a) => a.some((x) => x !== 0 && x !== 1) || new Set(a).size !== a.length,
      ) ||
      !same(
        r.freshActions,
        r.actions.filter((a) => !r.previousActions.includes(a)),
      ) ||
      (r.rawButtonMask !== undefined &&
        (!Number.isSafeInteger(r.rawButtonMask) ||
          r.rawButtonMask < 0 ||
          !!(r.rawButtonMask & 5) !== r.actions.includes(0) ||
          !!(r.rawButtonMask & 10) !== r.actions.includes(1)))
    )
      return;
    if (
      p &&
      (p.source.origin !== "parsed" ||
        s.parsedFrameIndex !== p.source.parsedFrameIndex + 1 ||
        r.sequence <= p.sequence ||
        r.timeMs < p.timeMs ||
        !same(r.previousActions, p.actions) ||
        (r.timeMs === p.timeMs && (r.position.x !== p.position.x || r.position.y !== p.position.y)) ||
        ((s.rawTokenIndex !== undefined || p.source.rawTokenIndex !== undefined) &&
          (!Number.isSafeInteger(p.source.rawTokenIndex) || s.rawTokenIndex !== p.source.rawTokenIndex! + 1)))
    )
      return;
    eventIds.push(r.id);
  }
  for (const i of fresh) {
    const r = i.record,
      attempts = e.attempts.filter((a) => a.inputId === r.id),
      attempt = attempts[0];
    if (
      r.freshActions.length !== 1 ||
      attempts.length !== 1 ||
      !attempt ||
      attempt.automated ||
      attempt.attemptOrdinal !== 0 ||
      attempt.knownAction !== r.freshActions[0] ||
      !same(attempt.actionCandidates, r.freshActions)
    )
      return;
    const routes = e.routing.filter((q) => q.attemptId === attempt.id),
      selection = routes.find((q) => q.kind === "selection"),
      policy = routes.find((q) => q.kind === "policy");
    if (
      routes.length !== 2 ||
      selection?.kind !== "selection" ||
      policy?.kind !== "policy" ||
      !selection.componentId ||
      !selection.inside ||
      !selection.eligible ||
      !selection.selectionStopped ||
      policy.state !== "allowed" ||
      policy.componentId !== selection.componentId
    )
      return;
    const other = map.getHitObject(selection.componentId);
    if (
      !(other instanceof HitCircle) ||
      other.hitTime >= target.hitTimeMs ||
      conflicted(other.id) ||
      (other.sliderId && conflicted(other.sliderId))
    )
      return;
    const c = deriveCircleEvidence(trace, map, other.id),
      receipt = c.terminal,
      ci = c.inputs.find((x) => x.record.id === r.id),
      nextInput = bridge[bridge.findIndex((x) => x.record.id === r.id) + 1]?.record,
      offset = r.timeMs - other.hitTime,
      w = c.geometry?.hitWindows;
    const grade =
      w &&
      (Math.abs(offset) <= w[0]
        ? "GREAT"
        : Math.abs(offset) <= w[1]
        ? "OK"
        : Math.abs(offset) <= w[2]
        ? "MEH"
        : undefined);
    if (
      c.limits.truncated ||
      Object.values(c.dependencies).some((d) => d.status !== "complete") ||
      !receipt ||
      !nextInput ||
      receipt.sequence >= nextInput.sequence ||
      receiptCount.components.get(other.id) !== 1 ||
      receiptCount.attempts.get(attempt.id) !== 1 ||
      !ci?.inside ||
      !ci.inLiveSuccess ||
      ci.postTerminal ||
      !ci.freshActionsKnown ||
      !grade ||
      receipt.result !== grade ||
      receipt.mechanism !== "successful-input" ||
      !receipt.previousUnresolved ||
      receipt.triggerAttemptId !== attempt.id ||
      policy.timingResult !== grade ||
      policy.offsetMs !== offset ||
      selection.component !== (other.sliderId ? "slider-head" : "circle") ||
      receipt.component !== selection.component ||
      !(
        r.sequence < attempt.sequence &&
        attempt.sequence < selection.sequence &&
        selection.sequence < policy.sequence &&
        policy.sequence < receipt.sequence &&
        receipt.sequence < terminal.sequence
      ) ||
      [attempt, selection, policy, receipt].some((q) => q.timeMs !== r.timeMs)
    )
      return;
    consumed.push({ inputId: r.id, componentId: other.id, resolutionId: receipt.id });
    eventIds.push(attempt.id, selection.id, policy.id, receipt.id);
  }
  const round = g.profile === "stable" ? Math.fround : (n: number) => n;
  const point = (i: CircleInputEvidence) => ({
    x: (round(i.record.position.x) - round(g.position.x)) / g.radius,
    y: (round(i.record.position.y) - round(g.position.y)) / g.radius,
  });
  const radial = (i: CircleInputEvidence) => {
    const p = point(i);
    return Math.hypot(p.x, p.y);
  };
  const closing = bridge.findIndex(
    (i) =>
      i.inLiveSuccess &&
      !i.postTerminal &&
      i.inside &&
      i.record.timeMs > bestEnd &&
      i.record.sequence < terminal.sequence,
  );
  if (closing < 1) return;
  const a = bridge[closing - 1],
    b = bridge[closing],
    A = point(a),
    B = point(b),
    dx = B.x - A.x,
    dy = B.y - A.y,
    d2 = dx * dx + dy * dy;
  if (
    !(radial(a) > 1) ||
    radial(b) > 1 ||
    b.record.timeMs <= a.record.timeMs ||
    b.record.timeMs - a.record.timeMs > 2 * best ||
    fresh.some((i) => i.record.sequence >= a.record.sequence)
  )
    return;
  const dot = A.x * dx + A.y * dy,
    disc = dot * dot - d2 * (A.x * A.x + A.y * A.y - 1);
  if (!(d2 > 0) || disc < 0) return;
  const fraction = (-dot - Math.sqrt(disc)) / d2,
    entry = a.record.timeMs + fraction * (b.record.timeMs - a.record.timeMs);
  if (fraction < 0 || fraction > 1 || !(entry > bestEnd) || entry >= live.end.timeMs) return;
  let minimumBestWindowR = Infinity;
  // Independently inspect every segment of the complete best window; sampled
  // outside points alone cannot rule out an earlier crossing between samples.
  for (let k = 1; k <= closing; k++) {
    const left = bridge[k - 1],
      right = bridge[k],
      P = point(left),
      Q = point(right),
      dt = right.record.timeMs - left.record.timeMs;
    const low = dt ? Math.max(0, (live.start.timeMs - left.record.timeMs) / dt) : 0,
      high = dt ? Math.min(1, (a.record.timeMs - left.record.timeMs) / dt) : 1;
    if (low > high) continue;
    const vx = Q.x - P.x,
      vy = Q.y - P.y,
      len = vx * vx + vy * vy,
      u = len ? Math.max(low, Math.min(high, -(P.x * vx + P.y * vy) / len)) : low;
    if (Math.hypot(P.x + u * vx, P.y + u * vy) <= 1) return;
    const lo = dt ? Math.max(0, (bestStart - left.record.timeMs) / dt) : 0,
      hi = dt ? Math.min(1, (bestEnd - left.record.timeMs) / dt) : 1;
    if (lo <= hi) {
      const t = len ? Math.max(lo, Math.min(hi, -(P.x * vx + P.y * vy) / len)) : lo;
      minimumBestWindowR = Math.min(minimumBestWindowR, Math.hypot(P.x + t * vx, P.y + t * vy));
    }
  }
  if (!(minimumBestWindowR > 1) || !Number.isFinite(minimumBestWindowR)) return;
  // A material inward suffix witnesses this target's arrival. It needs no
  // landing/deceleration on the next note and cannot cross another fresh edge.
  let start = closing - 1;
  while (
    start > 0 &&
    bridge[start - 1].record.timeMs >= bestStart &&
    bridge[start - 1].record.sequence > fresh[fresh.length - 1].record.sequence &&
    radial(bridge[start - 1]) + 1e-6 >= radial(bridge[start]) &&
    bridge[start].record.timeMs - bridge[start - 1].record.timeMs <= 2 * best
  )
    start--;
  const approachProgressR = radial(bridge[start]) - 1;
  if (approachProgressR < 0.5) return;
  return {
    basis: "recorded-target-passage-after-best-window",
    inputIds: [],
    entryTimeMs: entry,
    entryOffsetMs: entry - target.hitTimeMs,
    bracketIds: [a.record.id, b.record.id],
    insideInputId: b.record.id,
    minimumBestWindowR,
    approachProgressR,
    consumed,
    eventIds: [...new Set([...eventIds, terminal.id, ...(live.end.eventId ? [live.end.eventId] : [])])],
  };
}
