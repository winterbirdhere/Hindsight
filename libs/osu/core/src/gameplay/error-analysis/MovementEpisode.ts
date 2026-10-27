import { nativeWithinHitRadius, stableWithinHitRadius } from "../StableHitGeometry";

/** Morphology is an observational policy, never a change to the scoring radius. */
export interface MovementPosition {
  x: number;
  y: number;
}
export interface MovementOrder {
  time: number;
  sequence: number;
}
export interface MovementSample extends MovementOrder {
  position: MovementPosition;
  discontinuityBefore?: boolean;
}
export interface MovementFailedPress extends MovementSample {
  id: string;
  /** Established by dispatch/lifecycle evidence before calling this module. */
  association: "terminal" | "target-attempt" | "target-routing";
}
export interface MovementPolicy {
  version: "movement-episodes-v1";
  noiseRadius: number;
  reverseRadius: number;
  settleRadius: number;
  settleDuration: number;
  minimumApproachRadius: number;
  nearAxisRadius: number;
  maximumSamples: number;
  maximumPresses: number;
}
export const MOVEMENT_POLICY: Readonly<MovementPolicy> = Object.freeze({
  version: "movement-episodes-v1",
  noiseRadius: 0.025,
  reverseRadius: 0.2,
  settleRadius: 0.05,
  settleDuration: 20,
  minimumApproachRadius: 0.2,
  nearAxisRadius: 0.2,
  maximumSamples: 4096,
  maximumPresses: 64,
});
export interface MovementEpisodeInput {
  center: MovementPosition;
  radius: number;
  /** Radius must already include the Stable gameplay scale when applicable. */
  geometryProfile?: "stable" | "lazer";
  scope: { start: MovementOrder; end: MovementOrder };
  samples: readonly MovementSample[];
  failedPresses: readonly MovementFailedPress[];
  competingInputs?: readonly MovementOrder[];
  successfulInputs?: readonly MovementOrder[];
  completeness?: { start: boolean; end: boolean };
  policy?: Partial<Omit<MovementPolicy, "version">>;
}
export type MovementLabel = "Overshoot" | "Undershoot" | "Wide aim";
export interface MovementBoundary {
  time: number;
  segmentStartSequence: number;
  segmentEndSequence: number;
  fraction: number;
}
export interface MovementContact {
  entry: MovementBoundary;
  exit: MovementBoundary;
}
export interface MovementWitness {
  label: MovementLabel;
  origin: MovementSample;
  press: MovementFailedPress;
  span: { start: MovementOrder; end: MovementOrder };
  contacts: MovementContact[];
  minimumDistanceRadius: number;
  completion: {
    kind: "reversal" | "settle" | "transverse-passage";
    start: MovementOrder;
    end: MovementOrder;
    excursionRadius?: number;
    duration?: number;
  };
}
export interface MovementOpportunity {
  pressId: string;
  status: "supported" | "unproven";
  labels: MovementLabel[];
  witnesses: MovementWitness[];
  reason?: string;
}
export interface MovementEpisodeResult {
  policy: Readonly<MovementPolicy>;
  opportunities: MovementOpportunity[];
  failureReason?: string;
  omittedPresses?: number;
}

interface Point {
  raw: MovementSample;
  x: number;
  y: number;
}
interface Contact extends MovementContact {
  from: number;
  to: number;
}
const order = (a: MovementOrder, b: MovementOrder) => a.time - b.time || a.sequence - b.sequence;
const distance = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
const dot = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x * b.x + a.y * b.y;
const minus = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: a.x - b.x, y: a.y - b.y });
const morphologyAtLeast = (value: number, threshold: number) => value + 1e-12 >= threshold;
const atOrder = (point: Point): MovementOrder => ({ time: point.raw.time, sequence: point.raw.sequence });

function boundary(points: Point[], parameter: number): MovementBoundary {
  const i = Math.min(Math.floor(parameter), points.length - 1);
  const j = Math.min(i + 1, points.length - 1);
  const fraction = parameter - i;
  return {
    time: points[i].raw.time + (points[j].raw.time - points[i].raw.time) * fraction,
    segmentStartSequence: points[i].raw.sequence,
    segmentEndSequence: points[j].raw.sequence,
    fraction,
  };
}

/** Exact closed-circle/linear-segment intersections. Morphology noise never enters this calculation. */
function contacts(points: Point[]): Contact[] {
  const intervals: { from: number; to: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (distance(a) <= 1) intervals.push({ from: i, to: i });
    if (!b || a.raw.time === b.raw.time) continue;
    const delta = minus(b, a);
    const lengthSquared = dot(delta, delta);
    if (lengthSquared === 0) {
      if (distance(a) <= 1) intervals.push({ from: i, to: i + 1 });
      continue;
    }
    const projection = -dot(a, delta) / lengthSquared;
    const closest = { x: a.x + delta.x * projection, y: a.y + delta.y * projection };
    const remainder = 1 - dot(closest, closest);
    if (remainder < 0) continue;
    const extent = Math.sqrt(remainder / lengthSquared);
    const from = Math.max(0, projection - extent);
    const to = Math.min(1, projection + extent);
    if (from <= to) intervals.push({ from: i + from, to: i + to });
  }
  intervals.sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval.from <= previous.to) previous.to = Math.max(previous.to, interval.to);
    else merged.push({ ...interval });
  }
  return merged.map((interval) => ({
    ...interval,
    entry: boundary(points, interval.from),
    exit: boundary(points, interval.to),
  }));
}

function nearestPoint(points: Point[]) {
  let result = { parameter: 0, point: { x: points[0].x, y: points[0].y }, distance: distance(points[0]) };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const delta = minus(b, a);
    const lengthSquared = dot(delta, delta);
    const fraction =
      a.raw.time === b.raw.time || !lengthSquared ? 0 : Math.max(0, Math.min(1, -dot(a, delta) / lengthSquared));
    const point = { x: a.x + delta.x * fraction, y: a.y + delta.y * fraction };
    const radial = distance(point);
    if (radial < result.distance) result = { parameter: i + fraction, point, distance: radial };
    if (distance(b) < result.distance) result = { parameter: i + 1, point: { x: b.x, y: b.y }, distance: distance(b) };
  }
  return result;
}

function pressParameter(points: Point[], press: MovementFailedPress, normalized: MovementPosition): number | undefined {
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (order(a.raw, press) === 0) return distance(minus(a, normalized)) <= 1e-9 ? i : undefined;
    if (!b || order(a.raw, press) >= 0 || order(b.raw, press) <= 0 || a.raw.time === b.raw.time) continue;
    const fraction = (press.time - a.raw.time) / (b.raw.time - a.raw.time);
    const reconstructed = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
    if (distance(minus(reconstructed, normalized)) <= 1e-9) return i + fraction;
  }
  return undefined;
}

function completion(
  points: Point[],
  from: number,
  axis: MovementPosition,
  policy: MovementPolicy,
): MovementWitness["completion"] | undefined {
  let peakIndex = Math.max(0, Math.ceil(from));
  for (let i = peakIndex + 1; i < points.length; i++) {
    if (dot(points[i], axis) > dot(points[peakIndex], axis)) peakIndex = i;
    const reverse = dot(minus(points[peakIndex], points[i]), axis);
    if (morphologyAtLeast(reverse, policy.reverseRadius)) {
      return { kind: "reversal", start: atOrder(points[peakIndex]), end: atOrder(points[i]), excursionRadius: reverse };
    }
  }
  // Settling is positive observed duration, never the absence of a later sample.
  for (let start = Math.max(0, Math.ceil(from)); start < points.length - 1; start++) {
    if (points[points.length - 1].raw.time - points[start].raw.time < policy.settleDuration) break;
    for (let end = start + 1; end < points.length; end++) {
      if (distance(minus(points[end], points[start])) > policy.settleRadius + 1e-12) break;
      const duration = points[end].raw.time - points[start].raw.time;
      if (duration >= policy.settleDuration) {
        return { kind: "settle", start: atOrder(points[start]), end: atOrder(points[end]), duration };
      }
    }
  }
  return undefined;
}

/**
 * The caller supplies a bounded, already-associated opportunity. This module never
 * assigns arbitrary replay inputs to targets. Multiple contacts remain ambiguous
 * morphology and can instead be described by the event adapter as Between passes.
 */
export function classifyMovementEpisodes(input: MovementEpisodeInput): MovementEpisodeResult {
  const policy: MovementPolicy = { ...MOVEMENT_POLICY, ...input.policy };
  const result: MovementEpisodeResult = { policy, opportunities: [] };
  const fail = (press: MovementFailedPress, reason: string): MovementOpportunity => ({
    pressId: press.id,
    status: "unproven",
    labels: [],
    witnesses: [],
    reason,
  });
  const finiteOrder = (p: MovementOrder) => Number.isFinite(p.time) && Number.isFinite(p.sequence);
  const finitePosition = (p: MovementPosition) => Number.isFinite(p.x) && Number.isFinite(p.y);
  let invalid: string | undefined;
  if (
    Object.entries(policy).some(
      ([key, value]) => key !== "version" && (typeof value !== "number" || !Number.isFinite(value) || value <= 0),
    ) ||
    !Number.isInteger(policy.maximumSamples) ||
    !Number.isInteger(policy.maximumPresses)
  )
    invalid = "invalid-policy";
  else if (
    !finitePosition(input.center) ||
    !Number.isFinite(input.radius) ||
    input.radius <= 0 ||
    !finiteOrder(input.scope.start) ||
    !finiteOrder(input.scope.end) ||
    order(input.scope.start, input.scope.end) > 0
  )
    invalid = "invalid-geometry-or-scope";
  else if (input.samples.length > policy.maximumSamples) invalid = "sample-limit";
  else if (input.failedPresses.length > policy.maximumPresses) invalid = "press-limit";
  else if (
    input.samples.some(
      (p, i) => !finiteOrder(p) || !finitePosition(p.position) || (i > 0 && order(input.samples[i - 1], p) >= 0),
    )
  )
    invalid = "invalid-source-order";
  else if ([...(input.competingInputs ?? []), ...(input.successfulInputs ?? [])].some((p) => !finiteOrder(p)))
    invalid = "invalid-boundary";
  if (invalid) {
    const limit = invalid === "invalid-policy" ? MOVEMENT_POLICY.maximumPresses : policy.maximumPresses;
    result.failureReason = invalid;
    result.omittedPresses = Math.max(0, input.failedPresses.length - limit);
    result.opportunities = input.failedPresses.slice(0, limit).map((press) => fail(press, invalid as string));
    return result;
  }
  const storedPosition = (p: MovementPosition) =>
    input.geometryProfile === "stable" ? { x: Math.fround(p.x), y: Math.fround(p.y) } : p;
  const center = storedPosition(input.center);
  const radius = input.geometryProfile ? Math.fround(input.radius) : input.radius;
  const normalize = (position: MovementPosition) => {
    const p = storedPosition(position);
    return { x: (p.x - center.x) / radius, y: (p.y - center.y) / radius };
  };
  const inside = (position: MovementPosition) =>
    input.geometryProfile === "stable"
      ? stableWithinHitRadius(input.center, position, radius)
      : input.geometryProfile === "lazer"
      ? nativeWithinHitRadius(input.center, position, radius)
      : distance(normalize(position)) <= 1;
  const spans: Point[][] = [];
  let current: Point[] = [];
  for (const raw of input.samples) {
    if (order(raw, input.scope.start) < 0 || order(raw, input.scope.end) > 0) continue;
    const prior = current[current.length - 1]?.raw;
    const zeroTimeJump =
      prior && prior.time === raw.time && (prior.position.x !== raw.position.x || prior.position.y !== raw.position.y);
    const competingBoundary =
      prior && input.competingInputs?.some((cut) => order(cut, prior) > 0 && order(cut, raw) <= 0);
    if (raw.discontinuityBefore || zeroTimeJump || competingBoundary) {
      if (current.length) spans.push(current);
      current = [];
    }
    current.push({ raw, ...normalize(raw.position) });
  }
  if (current.length) spans.push(current);
  const spanAnalysis = new Map<Point[], { contact: Contact[]; nearest: ReturnType<typeof nearestPoint> }>();
  for (const press of input.failedPresses) {
    if (!finiteOrder(press) || !finitePosition(press.position)) {
      result.opportunities.push(fail(press, "invalid-press"));
      continue;
    }
    if (!["terminal", "target-attempt", "target-routing"].includes(press.association)) {
      result.opportunities.push(fail(press, "unproven-target-association"));
      continue;
    }
    if (order(press, input.scope.start) < 0 || order(press, input.scope.end) > 0) {
      result.opportunities.push(fail(press, "outside-live-scope"));
      continue;
    }
    const points = spans.find((span) => order(span[0].raw, press) <= 0 && order(span[span.length - 1].raw, press) >= 0);
    if (!points || points.length < 2) {
      result.opportunities.push(fail(press, "incomplete-continuous-span"));
      continue;
    }
    const p = normalize(press.position);
    const parameter = pressParameter(points, press, p);
    if (parameter === undefined) {
      result.opportunities.push(fail(press, "press-path-mismatch"));
      continue;
    }
    if (inside(press.position)) {
      result.opportunities.push(fail(press, "press-inside-hit-area"));
      continue;
    }
    if (
      input.successfulInputs?.some((hit) => order(hit, press) >= 0 && order(hit, points[points.length - 1].raw) <= 0)
    ) {
      result.opportunities.push(fail(press, "successful-correction"));
      continue;
    }
    let analysis = spanAnalysis.get(points);
    if (!analysis) {
      analysis = { contact: contacts(points), nearest: nearestPoint(points) };
      spanAnalysis.set(points, analysis);
    }
    const { contact, nearest } = analysis;
    if (contact.length > 1) {
      result.opportunities.push(fail(press, "multiple-contact-episodes"));
      continue;
    }
    let origin = -1;
    // The most local actual approach sample with measurable radial progress.
    for (let i = Math.min(Math.floor(nearest.parameter), points.length - 1); i >= 0; i--) {
      if (
        distance(points[i]) > 1 &&
        morphologyAtLeast(distance(points[i]) - nearest.distance, policy.minimumApproachRadius)
      ) {
        origin = i;
        break;
      }
      if (i > 0 && distance(points[i - 1]) + policy.noiseRadius < distance(points[i])) break;
    }
    if (origin < 0 || origin >= nearest.parameter || parameter < origin) {
      result.opportunities.push(fail(press, "no-measurable-local-approach"));
      continue;
    }
    const originDistance = distance(points[origin]);
    const axis = { x: -points[origin].x / originDistance, y: -points[origin].y / originDistance };
    const along = dot(p, axis);
    const transverse = Math.abs(p.x * axis.y - p.y * axis.x);
    let label: MovementLabel | undefined;
    let completed: MovementWitness["completion"] | undefined;
    if (contact.length === 1 && parameter > contact[0].to && along > 1) {
      completed = completion(points, Math.max(parameter, contact[0].to), axis, policy);
      if (completed) label = "Overshoot";
    } else if (
      contact.length === 0 &&
      along < -1 &&
      transverse <= policy.nearAxisRadius &&
      Math.abs(nearest.point.x * axis.y - nearest.point.y * axis.x) <= policy.nearAxisRadius
    ) {
      completed = completion(points, Math.min(parameter, nearest.parameter), axis, policy);
      if (completed) label = "Undershoot";
    }
    if (
      !label &&
      contact.length === 0 &&
      nearest.distance > 1 &&
      nearest.parameter > origin &&
      nearest.parameter < points.length - 1
    ) {
      const before = Math.max(origin, Math.ceil(nearest.parameter) - 1);
      const after = Math.min(points.length - 1, Math.floor(nearest.parameter) + 1);
      const vector = minus(points[after], points[before]);
      const length = distance(vector);
      if (length > 0) {
        const direction = { x: vector.x / length, y: vector.y / length };
        const beforeProgress = -dot(minus(points[origin], nearest.point), direction);
        const afterProgress = dot(minus(points[points.length - 1], nearest.point), direction);
        const transverseDistance = Math.abs(nearest.point.x * direction.y - nearest.point.y * direction.x);
        if (
          transverseDistance > 1 &&
          morphologyAtLeast(beforeProgress, policy.minimumApproachRadius) &&
          morphologyAtLeast(afterProgress, policy.minimumApproachRadius)
        ) {
          label = "Wide aim";
          completed = {
            kind: "transverse-passage",
            start: atOrder(points[origin]),
            end: atOrder(points[points.length - 1]),
            excursionRadius: afterProgress,
          };
        }
      }
    }
    if (!label || !completed) {
      result.opportunities.push(fail(press, "morphology-not-established"));
      continue;
    }
    result.opportunities.push({
      pressId: press.id,
      status: "supported",
      labels: [label],
      witnesses: [
        {
          label,
          origin: points[origin].raw,
          press,
          span: { start: atOrder(points[0]), end: atOrder(points[points.length - 1]) },
          contacts: contact.map(({ entry, exit }) => ({ entry, exit })),
          minimumDistanceRadius: nearest.distance,
          completion: completed,
        },
      ],
    });
  }
  return result;
}
