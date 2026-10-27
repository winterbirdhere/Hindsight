import { Position, Vec2 } from "@osujs/math";
import { Slider } from "../hitobjects/Slider";
import { PathType } from "../hitobjects/slider/PathType";

const f = Math.fround;
const multiply = (a: number, b: number) => f(f(a) * f(b));
const squaredLength = (p: Position) => f(multiply(p.x, p.x) + multiply(p.y, p.y));

/** XNA Distance keeps scalar arithmetic extended before storing the float radius. */
export function stablePathDistance(a: Position, b: Position): number {
  const x = f(a.x) - f(b.x),
    y = f(a.y) - f(b.y);
  return f(Math.sqrt(x * x + y * y));
}

/**
 * Absolute unstacked gameplay vertices for Stable's three-point circular path.
 * Stable samples roughly eight-pixel chords before trimming and timing them;
 * Lazer's curvature-tolerance vertices produce different integer ball motion.
 */
export function stablePerfectCurvePoints(slider: Slider): Position[] | undefined {
  const controlPoints = slider.path.controlPoints;
  if (controlPoints.length !== 3 || controlPoints[0].type !== PathType.PerfectCurve) return undefined;
  const origin = slider.head.unstackedPosition;
  const [a, b, c] = controlPoints.map((point) => Vec2.add(origin, point.offset));
  const determinant = f(multiply(f(b.x - a.x), f(c.y - a.y)) - multiply(f(c.x - a.x), f(b.y - a.y)));
  if (determinant === 0) return undefined;
  const denominator = multiply(
    2,
    f(f(multiply(a.x, f(b.y - c.y)) + multiply(b.x, f(c.y - a.y))) + multiply(c.x, f(a.y - b.y))),
  );
  if (denominator === 0) return undefined;
  const aa = squaredLength(a),
    bb = squaredLength(b),
    cc = squaredLength(c);
  const center = {
    // The x86 scalar numerator stays extended until the Vector2 field write.
    x: f((aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / denominator),
    y: f((aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / denominator),
  };
  const radius = stablePathDistance(center, a);
  // Atan2 receives scalar differences without an intervening Vector2 write.
  const angle = (p: Position) => Math.atan2(p.y - center.y, p.x - center.x);
  const first = angle(a);
  let middle = angle(b),
    last = angle(c);
  // This is Stable's float32 constant promoted to double, not Math.PI * 2.
  const fullTurn = 6.2831854820251465;
  while (middle < first) middle += fullTurn;
  while (last < first) last += fullTurn;
  if (middle > last) last -= fullTurn;
  const count = Math.trunc(Math.abs((last - first) * radius) * 0.125);
  const points: Position[] = [a];
  for (let index = 1; index < count; index++) {
    const fraction = index / count;
    const theta = last * fraction + first * (1 - fraction);
    points.push(Vec2.add({ x: f(Math.cos(theta) * radius), y: f(Math.sin(theta) * radius) }, center));
  }
  points.push(c);

  return trimStablePath(points, slider.path.distance);
}

/** A segment's subtraction writes a Vector2 before XNA takes its length. */
function stableSegmentLength(a: Position, b: Position): number {
  const delta = Vec2.sub(b, a);
  return f(Math.sqrt(delta.x * delta.x + delta.y * delta.y));
}

function scaleExtended(point: Position, scale: number): Position {
  // The x86 CLR keeps the scalar expression extended until the vector write.
  return { x: f(point.x * scale), y: f(point.y * scale) };
}

function subdivideBezier(points: Position[]): [Position[], Position[]] {
  const work = [...points],
    left: Position[] = [],
    right: Position[] = [];
  for (let index = 0; index < points.length; index++) {
    left[index] = work[0];
    right[points.length - index - 1] = work[points.length - index - 1];
    for (let next = 0; next < points.length - index - 1; next++) {
      work[next] = Vec2.scale(Vec2.add(work[next], work[next + 1]), 0.5);
    }
  }
  return [left, right];
}

function approximateStableBezier(points: Position[]): Position[] {
  if (points.length < 3) return [...points];
  const pending = [points],
    output: Position[] = [];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    const flat = parent.slice(1, -1).every((_, index) => {
      const delta = Vec2.add(Vec2.sub(parent[index], Vec2.scale(parent[index + 1], 2)), parent[index + 2]);
      return delta.x * delta.x + delta.y * delta.y <= 0.25;
    });
    const [left, right] = subdivideBezier(parent);
    if (flat) {
      const joined = left.concat(right.slice(1));
      output.push(parent[0]);
      for (let index = 1; index < parent.length - 1; index++) {
        const middle = 2 * index;
        output.push(
          Vec2.scale(Vec2.add(Vec2.add(joined[middle - 1], Vec2.scale(joined[middle], 2)), joined[middle + 1]), 0.25),
        );
      }
    } else {
      pending.push(right, left);
    }
  }
  output.push(points[points.length - 1]);
  return output;
}

function trimStablePath(points: Position[], expectedDistance: number): Position[] {
  let total = 0;
  for (let index = 1; index < points.length; index++) total += stableSegmentLength(points[index - 1], points[index]);
  let excess = total - expectedDistance;
  while (points.length > 1) {
    const from = points[points.length - 2],
      to = points[points.length - 1];
    // Unlike the segment length above, Distance's subtraction remains scalar.
    const distance = f(Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2));
    if (distance > excess + 0.0001) {
      if (distance > 0) {
        const length = stableSegmentLength(from, to);
        const unit = scaleExtended(Vec2.sub(to, from), 1 / length);
        // The normalization reciprocal stays extended inside its method. The
        // separate multiplication operator receives a stored float argument.
        points[points.length - 1] = Vec2.add(from, Vec2.scale(unit, f(length - f(excess))));
      }
      break;
    }
    points.pop();
    excess -= distance;
  }
  return points;
}

/** Shared geometry keeps ball motion and checkpoint clocks on the same segments. */
export function stableSliderPathGeometry(slider: Slider): { points: Position[]; lengths: number[] } {
  let points = stablePerfectCurvePoints(slider);
  if (!points) {
    const controls = slider.path.controlPoints;
    // Historical v9 Bezier sampling and Catmull construction retain the existing
    // approximation until their separate compatibility rules are ported.
    if (
      slider.stableGeometryVersion === 9 ||
      slider.stableGeometryVersion <= 6 ||
      controls[0]?.type === PathType.Catmull
    ) {
      points = slider.path.calculatedPath.map((point) => Vec2.add(slider.head.unstackedPosition, point));
    } else {
      const absolute = controls.map((point) => Vec2.add(slider.head.unstackedPosition, point.offset));
      points = [];
      let start = 0;
      for (let index = 0; index < controls.length; index++) {
        if (controls[index].type === undefined && index < controls.length - 1) continue;
        const type = controls[start].type ?? PathType.Linear;
        const controlsForSegment = absolute.slice(start, index + 1);
        const segment =
          type === PathType.Linear || (type === PathType.PerfectCurve && controls.length <= 3)
            ? controlsForSegment
            : approximateStableBezier(controlsForSegment);
        for (const point of segment) {
          if (points.length === 0 || !Vec2.equal(points[points.length - 1], point)) points.push(point);
        }
        start = index;
      }
      points = trimStablePath(points, slider.path.distance);
    }
  }
  return { points, lengths: points.slice(1).map((point, index) => stableSegmentLength(points![index], point)) };
}
