import { CircleEvidence, CircleInputEvidence, EvidenceBoundary } from "../miss-explanation/CircleEvidence";
import type { PrimaryApproachContext, PrimaryApproachEpisode } from "./PrimaryApproach";

/** A reconstructed arrival, never a live contact, landing or scoring opportunity. */
export interface PrimaryDeadlineArrival {
  basis: "reconstructed-arrival-after-live-deadline";
  entryTimeMs: number;
  entryOffsetMs: number;
  deadline: EvidenceBoundary;
  afterDeadlineMs: number;
  minimumBeforeDeadlineR: number;
  preDeadlineProgressR: number;
  bracketIds: [string, string];
  insideInputId: string;
  approachStartInputId: string;
  eventIds: string[];
}
interface ArrivalPolicy {
  maximumInputs: number;
  minimumApproachR: number;
  noiseR: number;
  minimumTurnRadians: number;
}

function validBoundary(boundary?: EvidenceBoundary): boolean {
  return !boundary || (Number.isFinite(boundary.timeMs) && typeof boundary.inclusive === "boolean" &&
    (boundary.sequence === undefined || (Number.isSafeInteger(boundary.sequence) && boundary.sequence >= 0)));
}
function within(item: CircleInputEvidence, boundary: EvidenceBoundary | undefined, start: boolean): boolean {
  if (!boundary) return true;
  const difference = item.record.timeMs - boundary.timeMs ||
    (boundary.sequence === undefined ? 0 : item.record.sequence - boundary.sequence);
  return start ? difference > 0 || (difference === 0 && boundary.inclusive) :
    difference < 0 || (difference === 0 && boundary.inclusive);
}
const sameActions = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every(action => b.includes(action));
function adjacent(a: CircleInputEvidence, b: CircleInputEvidence): boolean {
  const left = a.record, right = b.record, source = left.source, next = right.source;
  return source.origin === "parsed" && next.origin === "parsed" &&
    Number.isSafeInteger(source.parsedFrameIndex) && next.parsedFrameIndex === source.parsedFrameIndex + 1 &&
    !next.discontinuityBefore?.length && right.sequence > left.sequence && right.timeMs >= left.timeMs &&
    (right.timeMs > left.timeMs || (left.position.x === right.position.x && left.position.y === right.position.y)) &&
    (source.rawTokenIndex === undefined && next.rawTokenIndex === undefined ||
      Number.isSafeInteger(source.rawTokenIndex) && next.rawTokenIndex === source.rawTokenIndex! + 1) &&
    sameActions(right.previousActions, left.actions) &&
    sameActions(right.freshActions, right.actions.filter(action => !left.actions.includes(action)));
}

/**
 * The ordinary episode has already been clipped to its live lifecycle. A single
 * immediate parsed closing sample can establish where the ongoing inward path
 * arrived after that deadline. It cannot change ordinary placement or contacts.
 */
export function derivePrimaryDeadlineArrival(
  evidence: CircleEvidence,
  context: PrimaryApproachContext,
  episode: PrimaryApproachEpisode,
  policy: ArrivalPolicy,
): PrimaryDeadlineArrival | undefined {
  if (evidence.status !== "supported" || evidence.limits.truncated || evidence.inputs.length > policy.maximumInputs ||
    !evidence.target || !evidence.geometry || evidence.terminal?.mechanism !== "automatic-expiry" ||
    Object.values(evidence.dependencies).some(dependency => dependency.status !== "complete") ||
    episode.status !== "supported" || episode.placement !== "unproven" || episode.contacts.length ||
    episode.landing || episode.spatialCandidates.length) return;

  const live = evidence.domains.liveSuccess, geometry = evidence.geometry, best = geometry.hitWindows[0];
  if (live.state !== "nonempty" || !live.start || !live.end || !Number.isFinite(best) || !(best > 0) ||
    !Number.isFinite(geometry.radius) || !(geometry.radius > 0)) return;
  const deadline = live.end.timeMs, scope = context.inputScopes?.[episode.inputId];
  if (![live.start, live.end, context.start, context.end, scope?.start, scope?.end, scope?.placementEnd].every(validBoundary)) return;
  const owned = (item: CircleInputEvidence) => within(item, context.start, true) && within(item, context.end, false) &&
    within(item, scope?.start, true) && within(item, scope?.end, false) && within(item, scope?.placementEnd, false);
  const finite = (item: CircleInputEvidence) => item.record.source.origin === "parsed" &&
    Number.isFinite(item.record.timeMs) && Number.isSafeInteger(item.record.sequence) && item.record.sequence >= 0 &&
    Number.isFinite(item.record.position.x) && Number.isFinite(item.record.position.y);
  const round = geometry.profile === "stable" ? Math.fround : (value: number) => value;
  const point = (item: CircleInputEvidence) => ({
    x: (round(item.record.position.x) - round(geometry.position.x)) / geometry.radius,
    y: (round(item.record.position.y) - round(geometry.position.y)) / geometry.radius,
  });
  const radial = (item: CircleInputEvidence) => { const p = point(item); return Math.hypot(p.x, p.y); };
  const inputs = evidence.inputs, press = inputs.findIndex(item => item.record.id === episode.inputId);
  if (press < 0 || !inputs[press].freshActionsKnown || !inputs[press].record.freshActions.length ||
    !inputs[press].inLiveSuccess || !owned(inputs[press])) return;

  // Cover the complete live path, including clipped source brackets. A later
  // sampled entry is not proof that an earlier opportunity was absent.
  const first = Math.max(0, inputs.findIndex(item => item.record.timeMs >= live.start!.timeMs) - 1);
  const finish = inputs.findIndex(item => item.record.timeMs >= deadline);
  if (finish < 0) return;
  const whole = inputs.slice(first, finish + 1);
  if (!whole.length || whole[0].record.timeMs > live.start.timeMs || whole[whole.length - 1].record.timeMs < deadline ||
    whole.some((item, index) => !finite(item) || !item.freshActionsKnown || (index > 0 && !adjacent(whole[index - 1], item)))) return;
  let minimumBeforeDeadlineR = Infinity;
  for (let index = 1; index < whole.length; index++) {
    const a = whole[index - 1], b = whole[index], A = point(a), B = point(b);
    const dt = b.record.timeMs - a.record.timeMs, dx = B.x - A.x, dy = B.y - A.y, lengthSquared = dx * dx + dy * dy;
    const low = dt ? Math.max(0, (live.start.timeMs - a.record.timeMs) / dt) : 0;
    const high = dt ? Math.min(1, (deadline - a.record.timeMs) / dt) : 1;
    if (low > high) continue;
    const fraction = lengthSquared ? Math.max(low, Math.min(high, -(A.x * dx + A.y * dy) / lengthSquared)) : low;
    minimumBeforeDeadlineR = Math.min(minimumBeforeDeadlineR, Math.hypot(A.x + fraction * dx, A.y + fraction * dy));
  }
  if (!(minimumBeforeDeadlineR > 1)) return;

  const closingIndex = inputs.findIndex((item, index) => index > press && item.record.timeMs > deadline && radial(item) <= 1);
  if (closingIndex < 0) return;
  const a = inputs[closingIndex - 1], b = inputs[closingIndex];
  if (radial(a) <= 1 || b.record.timeMs - deadline > 2 * best || b.record.timeMs <= a.record.timeMs) return;

  let run = press;
  while (run > 0 && inputs[run - 1].record.timeMs >= episode.pressTimeMs - 4 * best &&
    !inputs[run - 1].record.freshActions.length && !context.contextBoundaryInputIds?.includes(inputs[run - 1].record.id) &&
    owned(inputs[run - 1])) run--;
  const chain = inputs.slice(run, closingIndex + 1);
  if (chain.some((item, index) => !finite(item) || !item.freshActionsKnown || !owned(item) ||
    (index > 0 && !adjacent(chain[index - 1], item)) ||
    (item.record.sequence > inputs[press].record.sequence && (item.record.freshActions.length ||
      context.contextBoundaryInputIds?.includes(item.record.id))))) return;
  const phase = live.end.eventId ? live.end : {
    timeMs: evidence.terminal.timeMs, sequence: evidence.terminal.sequence, inclusive: false,
  };
  if (chain.some(item => item !== b && !within(item, phase, false))) return;

  // A completed stop before this tap can end an older movement episode. A new
  // material inward segment observed by the tap starts this approach; preserve
  // the prefix's source/geometry witnesses, rather than borrowing its motion.
  let motionStart = 0, parked = chain[0];
  for (let index = 1; index < chain.length && chain[index].record.sequence <= inputs[press].record.sequence; index++) {
    const item = chain[index], anchor = point(parked), current = point(item);
    if (Math.hypot(current.x - anchor.x, current.y - anchor.y) > policy.noiseR) {
      if (chain[index - 1].record.timeMs - parked.record.timeMs >= best) motionStart = index - 1;
      parked = item;
    }
  }
  const motionChain = chain.slice(motionStart);
  // A key-only update or many tiny updates cannot erase a stop within this
  // approach. Use one fixed anchor until material total movement resets it.
  let stationary = motionChain[0];
  for (const item of motionChain) {
    const anchor = point(stationary), current = point(item);
    if (Math.hypot(current.x - anchor.x, current.y - anchor.y) > policy.noiseR) stationary = item;
    else if (item.record.timeMs - stationary.record.timeMs >= best) return;
  }

  let preDeadlineProgressR = 0, lastMotionTime = -Infinity;
  let incoming = false, prior: { dx: number; dy: number; length: number } | undefined;
  const cosine = Math.cos(policy.minimumTurnRadians);
  for (let index = 1; index < motionChain.length; index++) {
    const left = motionChain[index - 1], right = motionChain[index], P = point(left), Q = point(right);
    const dt = right.record.timeMs - left.record.timeMs, dx = Q.x - P.x, dy = Q.y - P.y, length = Math.hypot(dx, dy);
    if (dt > 2 * best) return;
    if (!length) continue; // Duplicates carry source identity, never extra direction or progress.
    if (dt === 0 || Math.hypot(Q.x, Q.y) > Math.hypot(P.x, P.y) + 1e-6) return;
    if (length <= policy.noiseR) continue;
    if (prior && (prior.dx * dx + prior.dy * dy) / (prior.length * length) < cosine) return;
    prior = { dx, dy, length };
    if (left.record.timeMs < deadline) {
      const fraction = Math.min(1, (deadline - left.record.timeMs) / dt);
      preDeadlineProgressR += Math.hypot(P.x, P.y) - Math.hypot(P.x + fraction * dx, P.y + fraction * dy);
      if (index < motionChain.length - 1) { incoming = true; lastMotionTime = right.record.timeMs; }
    }
  }
  if (!incoming || preDeadlineProgressR < policy.minimumApproachR || b.record.timeMs - lastMotionTime > 2 * best) return;

  const A = point(a), B = point(b), dx = B.x - A.x, dy = B.y - A.y, lengthSquared = dx * dx + dy * dy;
  const q = 2 * (A.x * dx + A.y * dy), discriminant = q * q - 4 * lengthSquared * (A.x * A.x + A.y * A.y - 1);
  if (!(lengthSquared > 0) || discriminant < 0) return;
  const fraction = (-q - Math.sqrt(discriminant)) / (2 * lengthSquared);
  const entryTimeMs = a.record.timeMs + fraction * (b.record.timeMs - a.record.timeMs);
  if (!(fraction >= 0 && fraction <= 1 && entryTimeMs > deadline)) return;
  return {
    basis: "reconstructed-arrival-after-live-deadline", entryTimeMs,
    entryOffsetMs: entryTimeMs - evidence.target.hitTimeMs, deadline: { ...live.end }, afterDeadlineMs: entryTimeMs - deadline,
    minimumBeforeDeadlineR, preDeadlineProgressR, bracketIds: [a.record.id, b.record.id], insideInputId: b.record.id,
    approachStartInputId: motionChain[0].record.id,
    eventIds: [...new Set([...whole.map(item => item.record.id), ...chain.map(item => item.record.id),
      evidence.terminal.id, ...(live.end.eventId ? [live.end.eventId] : []), ...(scope?.eventIds ?? [])])],
  };
}
